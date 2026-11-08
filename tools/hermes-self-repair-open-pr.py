#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-self-repair-open-pr — FLEET_SELFREPAIR_DESIGN.md §4.6's registered-PR mechanism. Takes one
# `verified` self-repair task and opens it as a real **draft** GitHub PR: a branch carrying only
# that task's one commit, cherry-picked off `nas2-selfrepair` onto a fresh branch off
# `origin/master`, pushed, then `gh pr create --draft`. This is NOT promotion — the PR is a review
# surface, nothing more. The task's own state is untouched by this script (still `verified`
# afterwards); the actual promotion decision stays exactly what it is today — a human (or, through
# the FleetOps `/selfrepair` tab, §4.8) setting `promotion-approved`, then
# `hermes-self-repair-promote.py` run by hand. Whether merging this PR later REPLACES that
# cherry-pick script is §6's own open question, deliberately not decided here.
#
# RUN BY HAND or by the scheduled Claude Code review routine (§4.7, skills/fleet-selfrepair-review/
# SKILL.md) — never by fleet infrastructure. Confirmed by `hermes-self-repair-promote.py`'s own
# live verification (FLEET_SELFREPAIR_DESIGN.md §9, Phase 1): spark's own `origin` deploy key is
# READ-ONLY by design (`ERROR: The key you are authenticating with has been marked as read only`),
# so this script cannot run there either, for the same reason `-promote.py` can't — opening a PR
# pushes a new branch to `origin`, which needs real GitHub push rights no fleet node holds, by
# deliberate design (§2/§5). This script fetches no credential from anywhere itself: whatever
# `git push` and `gh pr create` can already do in whatever checkout/session this runs from is
# exactly what it uses — nothing minted, nothing provisioned, the same posture `-promote.py`'s own
# header describes for itself.
#
# What it does, in order, refusing loudly rather than guessing at any step (mirrors
# `hermes-self-repair-promote.py`'s own shape almost exactly — same fetch/branch/cherry-pick
# mechanics, different destination):
#   1. Fetch the task from hermes-memory — refuses unless state == "verified".
#   2. Refuse if a `pr-opened` turn already exists for this task (idempotent re-run: prints the
#      existing PR URL instead of opening a second one).
#   3. Fetch the task's own original spec turn (the first turn hermes-self-repair-submit.py wrote,
#      `{"path", "problem"}`) and the phase="applied-commit" turn for the exact sha to cherry-pick —
#      never re-derives either by guessing.
#   4. Look up the task's domain via tools/hermes-self-repair-domains.py's `domain_for_path()`, by
#      the spec's own `path` — None is a legal answer (no domain registered claims this path), and
#      the branch name says so rather than guessing a name.
#   5. `git fetch` both ORIGIN_REMOTE and GIT_REMOTE, create a disposable branch
#      (`selfrepair/<domain-or-unregistered>/<task_id>`) off ORIGIN_REMOTE/ORIGIN_BRANCH, and
#      cherry-pick ONLY that one commit onto it.
#   6. On ANY cherry-pick conflict or empty-cherry-pick: abort cleanly, delete the disposable
#      branch, refuse and report — never force, never auto-resolve, same diagnosis split
#      `-promote.py` already makes between a real conflict and "this fix is already there".
#   7. On a clean cherry-pick: push the branch to ORIGIN_REMOTE (a new branch name every time, so
#      never a force-push), then `gh pr create --draft` against ORIGIN_BRANCH.
#   8. On success: records state UNCHANGED (still `verified`) plus a phase="pr-opened" turn with the
#      PR url/number, the branch, and the domain — so a second run, and the FleetOps UI (§4.8) and
#      the daily review routine (§4.7) alike, can tell this task already has an open PR.
#
# Config:
#   MEMORY_URL/MEMORY_TOKEN   required, same as every other self-repair component
#   SELF_REPAIR_REPO_DIR      default ~/HermesAgentV5-selfrepair
#   GIT_REMOTE                default nas2-selfrepair — where the applied commit currently lives
#   ORIGIN_REMOTE             default origin — must already be a real GitHub remote this checkout
#                             can push a new branch to; this script does nothing to provision,
#                             verify, or widen that access
#   ORIGIN_BRANCH             default master — the PR's base branch

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import hermes_self_repair_domains as domains_mod  # noqa: E402

MEMORY_URL = os.environ.get("MEMORY_URL", "http://10.129.1.15:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
SELF_REPAIR_REPO_DIR = Path(os.environ.get(
    "SELF_REPAIR_REPO_DIR", str(Path.home() / "HermesAgentV5-selfrepair"))).resolve()
GIT_REMOTE = os.environ.get("GIT_REMOTE", "nas2-selfrepair")
ORIGIN_REMOTE = os.environ.get("ORIGIN_REMOTE", "origin")
ORIGIN_BRANCH = os.environ.get("ORIGIN_BRANCH", "master")


def log(msg):
    print(f"[hermes-self-repair-open-pr] {msg}", flush=True)


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def fetch_task(task_id):
    return _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN)


def fetch_turns(task_id):
    return _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=500", MEMORY_TOKEN).get("turns", [])


def fetch_task_spec(turns):
    """The task's own original {"path", "problem"} — the first turn (lowest id) that parses as a
    JSON object carrying "path", which is what hermes-self-repair-submit.py writes before anything
    else exists for this task. Unlike hermes-self-repair-generate.py's own fetch_raw_text(), this
    cannot rely on "the last turn so far" (true only at claim time, long before `verified`), so it
    scans from the oldest turn forward instead of guessing a position."""
    for t in sorted(turns, key=lambda t: t.get("id", 0)):
        try:
            payload = json.loads(t.get("raw") or "{}")
        except (ValueError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and payload.get("path"):
            return payload
    return {}


def fetch_applied_sha(turns):
    for t in turns:
        try:
            payload = json.loads(t.get("raw") or "{}")
        except (ValueError, json.JSONDecodeError):
            continue
        if payload.get("phase") == "applied-commit":
            return payload.get("sha")
    return None


def fetch_existing_pr(turns):
    for t in turns:
        try:
            payload = json.loads(t.get("raw") or "{}")
        except (ValueError, json.JSONDecodeError):
            continue
        if payload.get("phase") == "pr-opened":
            return payload
    return None


def log_pr_opened(task_id, pr_url, pr_number, branch, domain_name):
    _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "selfrepair-open-pr", "role": "assistant",
        "raw": json.dumps({
            "phase": "pr-opened", "pr_url": pr_url, "pr_number": pr_number,
            "branch": branch, "domain": domain_name,
        }),
    }, MEMORY_TOKEN)


def run_git(args):
    return subprocess.run(["git", *args], cwd=str(SELF_REPAIR_REPO_DIR), capture_output=True, text=True)


def open_pr(task_id):
    if not MEMORY_TOKEN:
        sys.exit("MEMORY_TOKEN is required")
    if not SELF_REPAIR_REPO_DIR.is_dir():
        sys.exit(f"SELF_REPAIR_REPO_DIR not found: {SELF_REPAIR_REPO_DIR}")

    try:
        task = fetch_task(task_id)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            sys.exit(f"no such task {task_id!r} in hermes-memory")
        sys.exit(f"task lookup failed: {exc}")
    except Exception as exc:
        sys.exit(f"task lookup failed: {exc}")

    state = task.get("state")
    if state != "verified":
        sys.exit(f"task {task_id!r} is in state {state!r}, not 'verified' — refusing. Only a task "
                 f"that has just reached `verified` (Step 4) is eligible to be opened as a PR.")

    turns = fetch_turns(task_id)

    existing = fetch_existing_pr(turns)
    if existing:
        log(f"task {task_id!r} already has an open PR: {existing.get('pr_url')} — not opening a "
            f"second one. Delete that pr-opened turn by hand first if it's genuinely stale.")
        return existing.get("pr_url")

    spec = fetch_task_spec(turns)
    path = spec.get("path") or "(unknown path)"
    problem = spec.get("problem") or "(no problem description on file)"

    sha = fetch_applied_sha(turns)
    if not sha:
        sys.exit(f"task {task_id!r} has no recorded applied-commit sha — cannot open a PR")

    domain = domains_mod.domain_for_path(path) if path != "(unknown path)" else None
    domain_name = domain.get("name") if domain else "unregistered"

    log(f"opening a draft PR for task {task_id!r}, commit {sha[:12]}, domain={domain_name!r}")

    for remote in (ORIGIN_REMOTE, GIT_REMOTE):
        fetch = run_git(["fetch", remote])
        if fetch.returncode != 0:
            sys.exit(f"git fetch {remote} failed: {fetch.stderr.strip()}")

    branch = f"selfrepair/{domain_name}/{task_id}"
    run_git(["branch", "-D", branch])  # best-effort cleanup of a stale branch from a prior attempt
    create = run_git(["checkout", "-b", branch, f"{ORIGIN_REMOTE}/{ORIGIN_BRANCH}"])
    if create.returncode != 0:
        sys.exit(f"could not create {branch} off {ORIGIN_REMOTE}/{ORIGIN_BRANCH}: "
                 f"{create.stderr.strip()}")

    cherry = run_git(["cherry-pick", sha])
    if cherry.returncode != 0:
        cherry_output = f"{cherry.stdout}\n{cherry.stderr}"
        run_git(["cherry-pick", "--abort"])
        run_git(["checkout", ORIGIN_BRANCH])
        run_git(["branch", "-D", branch])
        # Same diagnosis split hermes-self-repair-promote.py's own 1.1.0 made, found live during
        # ITS verification: "already fully present on the target" is not a content conflict and
        # should not be read as one.
        if "is now empty" in cherry_output or "nothing to commit" in cherry_output:
            sys.exit(
                f"cherry-pick of {sha[:12]} onto {ORIGIN_REMOTE}/{ORIGIN_BRANCH} produced no "
                f"changes — this fix appears to ALREADY be present there. Not opening a PR. If it "
                f"was promoted by another path, mark this task's state accordingly by hand; if "
                f"that's unexpected, investigate before assuming it's safe:\n{cherry_output.strip()}"
            )
        sys.exit(f"cherry-pick of {sha[:12]} onto {ORIGIN_REMOTE}/{ORIGIN_BRANCH} conflicted — "
                 f"aborted cleanly, nothing was pushed:\n{cherry_output.strip()}")

    push = run_git(["push", ORIGIN_REMOTE, branch])
    if push.returncode != 0:
        run_git(["checkout", ORIGIN_BRANCH])
        run_git(["branch", "-D", branch])
        sys.exit(f"push of {branch} to {ORIGIN_REMOTE} failed — nothing lost, the branch was never "
                 f"published:\n{push.stderr.strip()}")

    title = f"self-repair: {path}"
    body = (
        f"Opened by `tools/hermes-self-repair-open-pr.py` for self-repair task `{task_id}`.\n\n"
        f"**Domain:** {domain_name}\n\n"
        f"**Problem:**\n{problem}\n\n"
        f"This is a review surface, not a promotion — merging this PR does not currently make this "
        f"fix live. Track the task with `python3 tools/hermes-self-repair-status.py {task_id}`."
    )
    gh = subprocess.run(
        ["gh", "pr", "create", "--draft", "--base", ORIGIN_BRANCH, "--head", branch,
         "--title", title, "--body", body],
        cwd=str(SELF_REPAIR_REPO_DIR), capture_output=True, text=True,
    )
    run_git(["checkout", ORIGIN_BRANCH])
    run_git(["branch", "-D", branch])
    if gh.returncode != 0:
        sys.exit(f"branch {branch} was pushed to {ORIGIN_REMOTE}, but `gh pr create` failed — the "
                 f"branch is NOT lost, open the PR by hand or retry:\n{gh.stderr.strip()}")

    pr_url = gh.stdout.strip().splitlines()[-1] if gh.stdout.strip() else ""
    pr_number = pr_url.rstrip("/").rsplit("/", 1)[-1] if pr_url else ""
    log_pr_opened(task_id, pr_url, pr_number, branch, domain_name)
    log(f"task {task_id!r}: opened {pr_url}")
    return pr_url


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: hermes-self-repair-open-pr.py <task_id>")
    open_pr(sys.argv[1])


if __name__ == "__main__":
    main()
