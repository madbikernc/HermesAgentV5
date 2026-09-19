#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-09-19) — real distinction found live during this script's own Step 5 verification:
# cherry-picking a commit whose change is already fully present on the target produces a non-zero
# exit with "The previous cherry-pick is now empty" -- NOT a content conflict, previously lumped in
# under one generic "conflicted" message. Now diagnosed separately (see promote()'s own comment at
# the cherry-pick check) so a human reading the failure isn't sent looking for a code clash that
# was never there. Still a hard refusal either way -- never auto-skip and mark promoted without a
# human confirming what actually happened.
#
# hermes-self-repair-promote — Step 5's actual promotion action. RUN BY HAND, by a human, from a
# machine/checkout that already has real GitHub push rights of its own. This script fetches NO new
# credential from anywhere — no Vaultwarden call, nothing GitHub-shaped in its own config. It is
# never invoked by hermes-self-repair-promote-gate.py, hermes-self-repair-apply.py, or any daemon —
# it exists to be run directly:
#
#   python3 tools/hermes-self-repair-promote.py <task_id>
#
# This is the one deliberate exception to every other self-repair component's "no GitHub
# credential anywhere in this process" rule — and it's an exception by ABSENCE of automation, not
# by adding a credential to an automated process. Whatever `git push` can already do in whatever
# checkout this is run from (the operator's own SSH key / credential manager / PAT) is exactly what
# this script uses — nothing more, nothing provisioned.
#
# Why a separate, manually-run script instead of doing this from
# hermes-self-repair-promote-gate.py's own poll loop the moment "promote <id>" is seen: approval
# (the chat command) can happen from anywhere, at any time, without anyone needing to be at a
# trusted machine. Execution (this script) requires a human to deliberately be at a machine that
# already has real GitHub push rights — a second, physical gate the chat command alone can't
# satisfy, matching the stepped plan's own "ideally a human running git push by hand" preference.
#
# What it does, in order, refusing loudly rather than guessing at any step:
#   1. Fetch the task from hermes-memory — refuses unless state == "promotion-approved" (set only
#      by a human replying "promote <task_id>" in FleetOps, via hermes-self-repair-promote-gate.py).
#   2. Fetch the task's own phase="applied-commit" turn for the EXACT sha to promote — never
#      re-derives this by guessing (e.g. "whatever HEAD currently is" in SELF_REPAIR_REPO_DIR) —
#      other self-repair tasks may have committed there since this one applied.
#   3. `git fetch` both ORIGIN_REMOTE and GIT_REMOTE, so the sha is reachable regardless of which
#      remote's refs this checkout currently has it under.
#   4. Create a disposable branch off ORIGIN_REMOTE/ORIGIN_BRANCH and cherry-pick ONLY that one
#      commit onto it — never a merge, never every self-repair commit sitting on GIT_REMOTE, just
#      the single commit this task produced.
#   5. On ANY cherry-pick conflict: `git cherry-pick --abort`, clean up the disposable branch,
#      refuse and report the conflict — never force, never auto-resolve.
#   6. On a clean cherry-pick: a normal, NON-FORCE `git push`. If ORIGIN_BRANCH moved since step 3's
#      fetch, this fails on git's own safety, exactly as it would for a human pushing by hand — and
#      is reported as a real failure, never retried or forced automatically.
#   7. On success: records state = "promoted" in hermes-memory plus a phase="promoted-commit" turn
#      with the new commit's real sha on ORIGIN_REMOTE, and deletes the disposable local branch.
#
# Config:
#   MEMORY_URL/MEMORY_TOKEN   required, same as every other self-repair component
#   SELF_REPAIR_REPO_DIR      default ~/HermesAgentV5-selfrepair
#   GIT_REMOTE                default nas2-selfrepair — where the commit currently lives
#   ORIGIN_REMOTE             default origin — must already be a real GitHub remote this checkout
#                             can push to; this script does nothing to provision, verify, or widen
#                             that access, it is exactly whatever `git push origin` already does
#   ORIGIN_BRANCH             default master

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

MEMORY_URL = os.environ.get("MEMORY_URL", "http://10.129.1.15:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
SELF_REPAIR_REPO_DIR = Path(os.environ.get(
    "SELF_REPAIR_REPO_DIR", str(Path.home() / "HermesAgentV5-selfrepair"))).resolve()
GIT_REMOTE = os.environ.get("GIT_REMOTE", "nas2-selfrepair")
ORIGIN_REMOTE = os.environ.get("ORIGIN_REMOTE", "origin")
ORIGIN_BRANCH = os.environ.get("ORIGIN_BRANCH", "master")


def log(msg):
    print(f"[hermes-self-repair-promote] {msg}", flush=True)


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


def fetch_applied_sha(task_id):
    turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=200", MEMORY_TOKEN).get("turns", [])
    for t in turns:
        try:
            payload = json.loads(t.get("raw") or "{}")
        except (ValueError, json.JSONDecodeError):
            continue
        if payload.get("phase") == "applied-commit":
            return payload.get("sha")
    return None


def set_task_state(task_id, state):
    _post(f"{MEMORY_URL}/tasks", {"id": task_id, "agent": "selfrepair-promote", "state": state}, MEMORY_TOKEN)


def log_promoted_commit(task_id, sha):
    _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "selfrepair-promote", "role": "assistant",
        "raw": json.dumps({"phase": "promoted-commit", "sha": sha, "remote": ORIGIN_REMOTE, "branch": ORIGIN_BRANCH}),
    }, MEMORY_TOKEN)


def run_git(args):
    return subprocess.run(["git", *args], cwd=str(SELF_REPAIR_REPO_DIR), capture_output=True, text=True)


def promote(task_id):
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
    if state != "promotion-approved":
        sys.exit(f"task {task_id!r} is in state {state!r}, not 'promotion-approved' — refusing.\n"
                 f"A human must first reply \"promote {task_id}\" in FleetOps "
                 f"(tools/hermes-self-repair-promote-gate.py) before this script will act.")

    sha = fetch_applied_sha(task_id)
    if not sha:
        sys.exit(f"task {task_id!r} has no recorded applied-commit sha — cannot promote")

    log(f"promoting task {task_id!r}, commit {sha[:12]}, onto {ORIGIN_REMOTE}/{ORIGIN_BRANCH}")

    for remote in (ORIGIN_REMOTE, GIT_REMOTE):
        fetch = run_git(["fetch", remote])
        if fetch.returncode != 0:
            sys.exit(f"git fetch {remote} failed: {fetch.stderr.strip()}")

    branch = f"self-repair-promote-{task_id}"
    run_git(["branch", "-D", branch])  # best-effort cleanup of a stale branch from a prior failed attempt
    create = run_git(["checkout", "-b", branch, f"{ORIGIN_REMOTE}/{ORIGIN_BRANCH}"])
    if create.returncode != 0:
        sys.exit(f"could not create {branch} off {ORIGIN_REMOTE}/{ORIGIN_BRANCH}: {create.stderr.strip()}")

    cherry = run_git(["cherry-pick", sha])
    if cherry.returncode != 0:
        cherry_output = f"{cherry.stdout}\n{cherry.stderr}"
        run_git(["cherry-pick", "--abort"])
        run_git(["checkout", ORIGIN_BRANCH])
        run_git(["branch", "-D", branch])
        # Real distinction found live during this script's own Step 5 verification (2026-09-18):
        # cherry-picking a commit whose change is ALREADY fully present on the target produces a
        # non-zero exit with "The previous cherry-pick is now empty" -- NOT a content conflict, a
        # completely different situation this code originally lumped in with a real conflict under
        # one generic "conflicted" message. Telling those apart matters: a real conflict means the
        # target changed in a way that clashes with this fix; an empty cherry-pick means the fix
        # already exists there by some other path (a human applied it by hand, a duplicate
        # promotion attempt, etc.) -- reading "conflicted" for the second case would send a human
        # looking for a code clash that was never there. Still a hard refusal either way (never
        # auto-skip and mark promoted without a human confirming what actually happened) -- only
        # the diagnosis in the message changes.
        if "is now empty" in cherry_output or "nothing to commit" in cherry_output:
            sys.exit(
                f"cherry-pick of {sha[:12]} onto {ORIGIN_REMOTE}/{ORIGIN_BRANCH} produced no "
                f"changes — this fix appears to ALREADY be present there (not a content conflict). "
                f"Nothing was pushed. If someone already applied this fix by another path, confirm "
                f"that by hand and mark the task 'promoted' directly in hermes-memory (this script "
                f"never does so automatically); if that's unexpected, investigate before assuming "
                f"it's safe:\n{cherry_output.strip()}"
            )
        sys.exit(f"cherry-pick of {sha[:12]} onto {ORIGIN_REMOTE}/{ORIGIN_BRANCH} conflicted — "
                 f"aborted cleanly, NOTHING was pushed:\n{cherry_output.strip()}")

    push = run_git(["push", ORIGIN_REMOTE, f"{branch}:{ORIGIN_BRANCH}"])
    if push.returncode != 0:
        run_git(["checkout", ORIGIN_BRANCH])
        run_git(["branch", "-D", branch])
        sys.exit(f"push to {ORIGIN_REMOTE}/{ORIGIN_BRANCH} failed — NOT force-pushed, nothing "
                 f"lost; if {ORIGIN_BRANCH} moved since this ran, fetch and retry:\n"
                 f"{push.stderr.strip()}")

    new_sha = run_git(["rev-parse", "HEAD"]).stdout.strip()
    run_git(["checkout", ORIGIN_BRANCH])
    run_git(["branch", "-D", branch])

    set_task_state(task_id, "promoted")
    log_promoted_commit(task_id, new_sha)
    log(f"task {task_id!r}: PROMOTED as {new_sha[:12]} on {ORIGIN_REMOTE}/{ORIGIN_BRANCH}")


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: hermes-self-repair-promote.py <task_id>")
    promote(sys.argv[1])


if __name__ == "__main__":
    main()
