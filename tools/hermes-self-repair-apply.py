#!/usr/bin/env python3
# Version: 1.3.0
#
# 1.3.0 (2026-09-19) — security-relevant fix found during a hardening self-review, not live traffic:
# parse_diff_path() used re.search(), which returns only the FIRST '+++ b/<path>' match. A diff
# with more than one such header (a multi-file diff -- never produced by the legitimate pipeline,
# which only ever diffs a single file, but exactly the kind of tampered/stale turn record this
# file's own allowlist re-check already treats as a real threat elsewhere) would have had only its
# first path allowlist-checked while `git apply` still applied every hunk in the diff, including to
# files never checked at all -- a real allowlist bypass. Fixed to findall() and refuse anything but
# exactly one match. Verified with a constructed two-file diff (one allowed path, one pointed at
# infra/vaultwarden/.env) confirming it is now refused outright (exit_code=2), not silently
# narrowed to just the allowed-looking first file.
#
# 1.2.0 (2026-09-18) — Step 5 hand-off: apply_diff() now returns the applied commit's sha (None on
# any failure), which do_apply() logs as its own phase="applied-commit" turn (log_applied_commit())
# — the source of truth tools/hermes-self-repair-promote.py later cherry-picks by. On a passing
# verification, do_apply() also posts a one-shot FleetOps notice (post_promotion_offer(), reusing
# this file's own matrix_notice()) naming the task and inviting a "promote <id>"/"skip <id>" reply.
# This process never waits for that reply — it is a broker-job worker, not a Matrix-sync loop, and
# must not stall claiming new jobs on a human response that could take hours.
# tools/hermes-self-repair-promote-gate.py's own poll loop is what actually watches for and parses
# the reply; this file still holds no GitHub credential and still applies/verifies only.
#
# 1.1.0 (2026-09-18) — Step 4's pre-promotion gate wired in: after a successful apply+commit+push,
# do_apply() now runs tools/hermes-self-repair-verify.py's verify() against the file as it actually
# landed on disk (not the candidate string from hermes-memory — proof about what was really
# committed) and records the outcome as its own hermes-memory task state: "verified" on a pass,
# "verify-failed" on a fail (with a FleetOps+email escalation, same escalate() already used for a
# repeated apply failure). The applied commit is NOT reverted on a verify failure — it stays on
# NAS2, visible and inspectable, simply not eligible for Step 5's future promotion offer, which
# will check for state == "verified" before ever proposing anything to GitHub. The broker job
# itself still reports success (exit 0) once the mechanical apply succeeds — verification result is
# tracked via hermes-memory task state, a separate concern from "did the git operation work."
#
# hermes-self-repair-apply — Step 3 of the self-repair stepped plan: the non-LLM apply worker.
#
# Same "no LLM turn, and no general-purpose process, is ever load-bearing for a mechanical/
# privileged action" split hermes-remediate-worker.py already established for service restarts —
# applied here to a new surface (applying a self-repair fix), not a new rule. This worker makes NO
# model calls. It claims a broker job, re-derives everything it needs from hermes-memory (never
# trusts the job payload's own claims about state or content), applies a diff mechanically, commits
# it, and pushes ONLY to the NAS2 git server. It never touches GitHub — no fetch, no push, no
# credential capable of either exists in this worker's environment. That boundary is enforced by
# absence, not by policy: don't add a GITHUB_TOKEN/origin-push anywhere in this file. See
# infra/hermes-self-repair/README.md for why (Step 5 is the only gate meant to reach GitHub, and
# only via an explicit human confirmation, never this worker).
#
# Job type: selfrepair-apply. Payload: {"task_id": "<id>"} — deliberately minimal. Everything else
# (the target path, the diff itself, whether the task actually converged) is looked up fresh from
# hermes-memory by task_id:
#   1. GET /tasks/{task_id} — refuses (job failure, no retry-worthy reason) unless state == "done".
#      A task in any other state (unresolved/error/blocked/still in progress) was never fully
#      converged and security-reviewed by hermes-self-repair-generate.py — applying it would defeat
#      the entire point of that review pipeline.
#   2. GET /turns?task_id=... — finds the turn hermes-self-repair-generate.py logs with
#      phase="diff" (log_round(task_id, "diff", 0, "selfrepair", diff_text)) and reads its exact
#      diff text from there. Never re-derives or re-computes a diff itself.
#   3. The diff's own `+++ b/<path>` header line is the source of truth for the target path — not
#      re-trusted from the job payload. That path is checked AGAIN against
#      infra/hermes-self-repair/allowlist.json (imported from tools/hermes-self-repair-read.py, the
#      same allow/deny logic Step 1 and Step 2 already use) before anything is written — defense in
#      depth against a stale or tampered turn record, even though Step 2 already required a
#      successful read through the same gate to have produced this diff in the first place.
#
# An empty diff (the "converged candidate is byte-identical to the original" case
# hermes-self-repair-generate.py's own build_converged_bundle() already documents) is a clean
# no-op success, not an error — there is nothing to apply, and that's a valid outcome.
#
# `git apply --check` runs before the real `git apply`, so a conflict (e.g. something else changed
# the target file in SELF_REPAIR_REPO_DIR since the diff was computed) is caught cleanly rather than
# leaving a half-applied working tree. On success: `git add <path>`, `git commit`, then
# `git push <GIT_REMOTE> <GIT_BRANCH>` — GIT_REMOTE defaults to nas2-selfrepair, never origin.
#
# Attempt counting / circuit breaker / escalation is hermes-remediate-worker.py's own shape,
# reused verbatim (keyed by task_id here instead of (action, target)): MAX_ATTEMPTS failures and
# this stops retrying and escalates via FleetOps + email instead, same reasoning — a stuck apply
# needs a human, not an unbounded retry loop.
#
# Config, all from the environment (mirrors hermes-remediate-worker.py's own):
#   BROKER_URL            default http://10.129.1.15:8100
#   BROKER_TOKEN          required
#   WORKER_NAME           default <hostname>
#   POLL_SECONDS          default 5
#   MAX_ATTEMPTS          default 3
#   MEMORY_URL/MEMORY_TOKEN   required — same as every other specialist
#   SELF_REPAIR_REPO_DIR  default ~/HermesAgentV5-selfrepair — the checkout this worker commits to
#   ALLOWLIST_PATH        default ~/HermesAgentV5/infra/hermes-self-repair/allowlist.json
#   SELF_REPAIR_READ_TOOL default ~/HermesAgentV5/tools/hermes-self-repair-read.py — imported (not
#                         subprocessed) here, for its allow/deny-check functions only
#   GIT_REMOTE            default nas2-selfrepair — NEVER point this at origin/GitHub
#   GIT_BRANCH            default master
#   GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL   default "hermes-self-repair" / "hermes-self-repair@local"
#   REMEDIATE_STATE_DIR   default ~/.hermes/state/selfrepair-apply
#   FLEETOPS_MATRIX_TOKEN / FLEETOPS_ROOM / MATRIX_HOMESERVER   for escalation notices
#   NOTIFY_EMAIL / EMAIL_FROM / EMAIL_PASSWORD                  for escalation email
#
# Deliberately boring: stdlib only, same as every other worker in this fleet.

import importlib.util
import json
import os
import re
import smtplib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from email.mime.text import MIMEText
from pathlib import Path

BROKER_URL = os.environ.get("BROKER_URL", "http://10.129.1.15:8100").rstrip("/")
BROKER_TOKEN = os.environ.get("BROKER_TOKEN", "")
WORKER = os.environ.get("WORKER_NAME", socket.gethostname())
POLL = int(os.environ.get("POLL_SECONDS", "5"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
JOB_TYPE = "selfrepair-apply"

MEMORY_URL = os.environ.get("MEMORY_URL", "http://10.129.1.15:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")

SELF_REPAIR_REPO_DIR = Path(os.environ.get(
    "SELF_REPAIR_REPO_DIR", str(Path.home() / "HermesAgentV5-selfrepair"))).resolve()
SELF_REPAIR_READ_TOOL = os.environ.get(
    "SELF_REPAIR_READ_TOOL", str(Path.home() / "HermesAgentV5" / "tools" / "hermes-self-repair-read.py"))
SELF_REPAIR_VERIFY_TOOL = os.environ.get(
    "SELF_REPAIR_VERIFY_TOOL", str(Path.home() / "HermesAgentV5" / "tools" / "hermes-self-repair-verify.py"))
GIT_REMOTE = os.environ.get("GIT_REMOTE", "nas2-selfrepair")
GIT_BRANCH = os.environ.get("GIT_BRANCH", "master")
GIT_AUTHOR_NAME = os.environ.get("GIT_AUTHOR_NAME", "hermes-self-repair")
GIT_AUTHOR_EMAIL = os.environ.get("GIT_AUTHOR_EMAIL", "hermes-self-repair@local")

if GIT_REMOTE == "origin":
    sys.exit("GIT_REMOTE must never be 'origin' — this worker must not be able to reach GitHub")

STATE_DIR = Path(os.environ.get("REMEDIATE_STATE_DIR", str(Path.home() / ".hermes" / "state" / "selfrepair-apply")))

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")
NOTIFY_EMAIL = os.environ.get("NOTIFY_EMAIL", "notifications@canislupisnc.net")
EMAIL_FROM = os.environ.get("EMAIL_FROM", "mercury@canislupisnc.net")
EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")


def log(msg):
    print(f"[hermes-self-repair-apply] {msg}", flush=True)


# --- Reuse Step 1's exact allow/deny logic rather than re-implementing it -----------------------
_spec = importlib.util.spec_from_file_location("hermes_self_repair_read", SELF_REPAIR_READ_TOOL)
_read_tool = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_read_tool)

# --- Reuse Step 4's verification gate the same way ------------------------------------------
_verify_spec = importlib.util.spec_from_file_location("hermes_self_repair_verify", SELF_REPAIR_VERIFY_TOOL)
_verify_tool = importlib.util.module_from_spec(_verify_spec)
_verify_spec.loader.exec_module(_verify_tool)


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


def set_task_state(task_id, state):
    try:
        _post(f"{MEMORY_URL}/tasks", {"id": task_id, "agent": "selfrepair-apply", "state": state}, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_verify_turn(task_id, ok, report):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": task_id, "agent": "selfrepair-apply", "role": "assistant",
            "raw": json.dumps({"phase": "pre-promotion-verify", "ok": ok, "report": report}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"log_verify_turn failed (task {task_id!r}): {exc}")


def log_applied_commit(task_id, sha):
    """Records the exact commit this task's fix landed as on GIT_REMOTE — the source of truth
    tools/hermes-self-repair-promote.py later cherry-picks by. Never re-derived by guessing
    (e.g. "HEAD at the time") once other tasks may have committed since."""
    if not sha:
        return
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": task_id, "agent": "selfrepair-apply", "role": "assistant",
            "raw": json.dumps({"phase": "applied-commit", "sha": sha, "remote": GIT_REMOTE, "branch": GIT_BRANCH}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"log_applied_commit failed (task {task_id!r}): {exc}")


def post_promotion_offer(task_id, path, sha):
    """One-shot FleetOps notice, same matrix_notice() this file already uses for escalations —
    NOT a wait-for-reply flow (this process is a broker-job worker, must never block on a human).
    tools/hermes-self-repair-promote-gate.py's own poll loop is what watches for and parses the
    reply. Best-effort: a failure here is logged, never fatal — the task is already 'verified' in
    hermes-memory regardless, so a human can still discover and promote it by other means (reading
    hermes-memory directly, or a future gate-watcher restart re-scanning) even if this one notice
    is lost."""
    text = (
        f"[self-repair] Task {task_id} ({path}) passed pre-promotion verification and is staged "
        f"on {GIT_REMOTE} (commit {sha[:12]}). Reply \"promote {task_id}\" to approve pushing it "
        f"to GitHub, or \"skip {task_id}\" to leave it staged on NAS2 only."
    )
    matrix_notice(text)


def broker_request(method, path, data=None, headers=None):
    req = urllib.request.Request(
        f"{BROKER_URL}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {BROKER_TOKEN}", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def claim():
    try:
        return broker_request("GET", f"/jobs/claim?type={JOB_TYPE}&worker={WORKER}").get("job")
    except urllib.error.URLError as exc:
        log(f"broker unreachable ({exc}) — retrying in {POLL}s")
        return None
    except Exception as exc:
        log(f"claim failed: {exc}")
        return None


def state_file(task_id):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    safe = task_id.replace("/", "_")
    return STATE_DIR / f"{safe}.json"


def load_attempts(task_id):
    f = state_file(task_id)
    if not f.exists():
        return 0
    try:
        return json.loads(f.read_text()).get("attempts", 0)
    except Exception:
        return 0


def save_attempts(task_id, attempts):
    state_file(task_id).write_text(json.dumps({"attempts": attempts, "at": time.time()}))


def clear_attempts(task_id):
    f = state_file(task_id)
    if f.exists():
        f.unlink()


def matrix_notice(text):
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        log(f"no FleetOps credentials — cannot post notice: {text}")
        return
    try:
        txn = f"selfrepair-apply-note-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"FleetOps notice failed: {exc}")


def send_email(subject, body):
    if not EMAIL_PASSWORD:
        log("no EMAIL_PASSWORD — cannot send escalation email")
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = NOTIFY_EMAIL
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, EMAIL_PASSWORD)
            server.send_message(msg)
    except Exception as exc:
        log(f"escalation email failed: {exc}")


def escalate(task_id, detail):
    text = (f"[hermes-self-repair-apply] task {task_id}: still failing to apply after "
            f"{MAX_ATTEMPTS} attempts — giving up automatically, needs a human. {detail}")
    matrix_notice(text)
    send_email(f"[Hermes Self-Repair] apply for task {task_id} needs attention", text)
    log(f"ESCALATED: {text}")


# --- hermes-memory lookups (never trust the job payload for any of this) ------------------------

def fetch_task(task_id):
    return _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN)


def fetch_diff_text(task_id):
    """Finds the turn hermes-self-repair-generate.py logs with phase == "diff" and returns its
    exact content. Returns None if no such turn exists (should not happen for a task genuinely in
    state 'done', but this worker never assumes that without checking)."""
    turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=200", MEMORY_TOKEN).get("turns", [])
    for t in turns:
        try:
            payload = json.loads(t.get("raw") or "{}")
        except (ValueError, json.JSONDecodeError):
            continue
        if payload.get("phase") == "diff":
            return payload.get("content", "")
    return None


_DIFF_TARGET_RE = re.compile(r"^\+\+\+ b/(.+)$", re.MULTILINE)


def parse_diff_path(diff_text):
    """The diff's own `+++ b/<path>` header line is the source of truth for the target path —
    never re-trusted from the job payload. Returns None if the diff doesn't parse to EXACTLY one
    target (should always be exactly one for a diff hermes-self-repair-generate.py's own
    compute_diff() produced, since it only ever diffs a single file).

    Real gap found during this file's own hardening review: an earlier version used .search(),
    which only returns the FIRST match. A diff with more than one `+++ b/<path>` header (a
    multi-file diff — never produced by the legitimate pipeline, but exactly the kind of tampered
    or stale turn record this file's own allowlist re-check elsewhere already treats as a real
    threat, not a hypothetical one) would have had only its first path allowlist-checked while
    `git apply` still wrote every hunk in the diff, including to files never checked at all. Using
    findall() and refusing anything but exactly one match closes that — a multi-file diff is
    refused outright, the same conservative "refuse rather than guess" posture every other check
    in this pipeline already uses."""
    matches = _DIFF_TARGET_RE.findall(diff_text)
    return matches[0] if len(matches) == 1 else None


# --- Mechanical git operations, no model involved anywhere below this line ----------------------

def run_git(args, check=True):
    return subprocess.run(
        ["git", *args], cwd=str(SELF_REPAIR_REPO_DIR), capture_output=True, text=True, check=check)


def apply_diff(task_id, path, diff_text):
    """Returns (ok, detail, sha) — sha is None on any failure, the real commit hash on success.
    Writes the diff to a temp file, `git apply --check`s it before applying for real so a conflict
    is caught cleanly rather than leaving a half-applied tree, then commits and pushes to
    GIT_REMOTE only. The returned sha is what Step 5's promotion tooling later cherry-picks by —
    see tools/hermes-self-repair-promote.py."""
    with tempfile.NamedTemporaryFile("w", suffix=".patch", delete=False) as f:
        f.write(diff_text)
        patch_path = f.name

    try:
        check = run_git(["apply", "--check", patch_path], check=False)
        if check.returncode != 0:
            return False, f"git apply --check failed (conflict likely): {check.stderr.strip()[:500]}", None

        applied = run_git(["apply", patch_path], check=False)
        if applied.returncode != 0:
            return False, f"git apply failed after a clean --check (unexpected): {applied.stderr.strip()[:500]}", None

        run_git(["add", "--", path])

        commit_msg = (
            f"self-repair: {path}\n\n"
            f"task_id: {task_id}\n"
            f"Applied by hermes-self-repair-apply after coder/coder2 convergence + independent "
            f"security review. Full transcript: hermes-memory turns for this task_id.\n"
            f"Not promoted to GitHub — staged on {GIT_REMOTE} pending the Step 5 human gate."
        )
        env = dict(os.environ, GIT_AUTHOR_NAME=GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL=GIT_AUTHOR_EMAIL,
                   GIT_COMMITTER_NAME=GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL=GIT_AUTHOR_EMAIL)
        commit = subprocess.run(
            ["git", "commit", "-m", commit_msg], cwd=str(SELF_REPAIR_REPO_DIR),
            capture_output=True, text=True, env=env)
        if commit.returncode != 0:
            return False, f"git commit failed: {commit.stderr.strip()[:500]}", None

        push = run_git(["push", GIT_REMOTE, GIT_BRANCH], check=False)
        if push.returncode != 0:
            return False, f"applied and committed locally, but push to {GIT_REMOTE} failed " \
                          f"(commit is NOT lost, just unpushed): {push.stderr.strip()[:500]}", None

        sha = run_git(["rev-parse", "HEAD"]).stdout.strip()
        return True, f"committed {sha[:12]} and pushed to {GIT_REMOTE}/{GIT_BRANCH}", sha
    finally:
        try:
            os.unlink(patch_path)
        except OSError:
            pass


def do_apply(task_id):
    """Returns (exit_code, error) matching every other worker's run_job() convention: 0 success,
    1 operational failure (retryable via the attempt counter), 2 refused (not retryable — a
    fundamentally wrong request, not a transient failure)."""
    try:
        task = fetch_task(task_id)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return 2, f"no such task {task_id!r} in hermes-memory"
        return 1, f"task lookup failed: {exc}"
    except Exception as exc:
        return 1, f"task lookup failed: {exc}"

    state = task.get("state")
    if state != "done":
        return 2, f"task {task_id!r} is in state {state!r}, not 'done' — refusing to apply " \
                  f"anything not fully converged and security-reviewed"

    diff_text = fetch_diff_text(task_id)
    if diff_text is None:
        return 2, f"task {task_id!r} has no logged diff turn — cannot apply"

    if not diff_text.strip():
        log(f"task {task_id!r}: empty diff (converged candidate was byte-identical) — nothing to apply, success")
        set_task_state(task_id, "verified")
        log_verify_turn(task_id, True, "No diff was applied (converged candidate was byte-identical "
                                        "to the original) — trivially verified, nothing changed.")
        return 0, ""

    path = parse_diff_path(diff_text)
    if not path:
        return 2, f"task {task_id!r}'s diff has no parseable '+++ b/<path>' header, or targets " \
                  f"more than one file (refused — see parse_diff_path()'s own docstring)"

    allowed_prefixes, deny_patterns = _read_tool.load_allowlist()
    real_path = _read_tool.resolve_in_repo(path)
    if real_path is None:
        return 2, f"diff target {path!r} resolves outside the self-repair repo root"
    ok, reason = _read_tool.is_allowed(real_path, allowed_prefixes, deny_patterns)
    if not ok:
        return 2, f"diff target {path!r} refused by allowlist ({reason}) — a stale or tampered " \
                  f"turn record, since hermes-self-repair-generate.py could not have produced " \
                  f"this diff without first reading {path!r} through the same gate"

    ok, detail, sha = apply_diff(task_id, path, diff_text)
    if not ok:
        return 1, detail
    log(f"task {task_id!r}: {detail}")
    log_applied_commit(task_id, sha)

    # Step 4's pre-promotion gate: verify the file as it actually landed on disk, not the
    # candidate string from hermes-memory. This runs regardless of whether it passes or fails —
    # the applied commit already exists on GIT_REMOTE either way (never reverted here; see this
    # file's own header for why). The broker job still reports success below: the mechanical apply
    # genuinely succeeded, and verification outcome is tracked separately via task state, which
    # Step 5 will check before ever offering promotion.
    verify_ok, verify_report = _verify_tool.verify(real_path)
    log_verify_turn(task_id, verify_ok, verify_report)
    if verify_ok:
        set_task_state(task_id, "verified")
        log(f"task {task_id!r}: pre-promotion verification PASSED")
        # Step 5 hand-off: a one-shot notice, never a blocking wait — this process is a broker-job
        # worker, not a Matrix-sync loop, and must not stall claiming new jobs waiting on a human
        # reply that could take hours. tools/hermes-self-repair-promote-gate.py's own poll loop is
        # what actually watches for and parses the "promote"/"skip" reply.
        post_promotion_offer(task_id, path, sha)
    else:
        set_task_state(task_id, "verify-failed")
        log(f"task {task_id!r}: pre-promotion verification FAILED — commit stays on {GIT_REMOTE}, "
            f"not eligible for promotion until resolved")
        escalate(task_id, f"applied successfully but failed pre-promotion verification:\n{verify_report[:800]}")
    return 0, ""


def run_job(job):
    payload = job.get("payload") or {}
    task_id = payload.get("task_id", "")
    if not task_id:
        return 2, "job payload missing task_id"

    attempts = load_attempts(task_id)
    if attempts >= MAX_ATTEMPTS:
        escalate(task_id, "refusing further attempts until reset")
        return 1, f"already at {attempts} attempts for task {task_id}, escalated instead of retrying"

    exit_code, error = do_apply(task_id)

    if exit_code == 0:
        clear_attempts(task_id)
    elif exit_code == 1:
        attempts += 1
        save_attempts(task_id, attempts)
        if attempts >= MAX_ATTEMPTS:
            escalate(task_id, error)
    # exit_code == 2 (refused, not retryable) intentionally does NOT touch the attempt counter —
    # a fundamentally wrong request (bad state, unparseable diff, denied path) will never succeed
    # on retry, so counting it toward MAX_ATTEMPTS and escalating would be noise, not signal.

    return exit_code, error


def report(job_id, exit_code, error):
    headers = {
        "Content-Type": "application/octet-stream",
        "X-Exit-Code": str(exit_code),
        "X-Sha256": "",
        "X-Filename": "",
        "X-Error": (error or "").replace("\n", " ")[:900].encode("ascii", "replace").decode("ascii"),
        "X-Caption": "",
    }
    result = broker_request("POST", f"/jobs/{job_id}/result", data=b"", headers=headers)
    log(f"job {job_id}: reported exit={exit_code} -> {result.get('state')}")


def main():
    if not BROKER_TOKEN:
        sys.exit("BROKER_TOKEN is required")
    if not MEMORY_TOKEN:
        sys.exit("MEMORY_TOKEN is required")
    if not SELF_REPAIR_REPO_DIR.is_dir():
        sys.exit(f"SELF_REPAIR_REPO_DIR not found: {SELF_REPAIR_REPO_DIR}")
    log(f"polling {BROKER_URL} every {POLL}s as '{WORKER}' for type='{JOB_TYPE}' jobs "
        f"(repo={SELF_REPAIR_REPO_DIR}, remote={GIT_REMOTE}, branch={GIT_BRANCH}, "
        f"max_attempts={MAX_ATTEMPTS})")
    while True:
        job = claim()
        if not job:
            time.sleep(POLL)
            continue
        try:
            exit_code, error = run_job(job)
            report(job["id"], exit_code, error)
        except Exception as exc:
            log(f"job {job['id']}: worker error: {exc}")
            try:
                report(job["id"], 1, f"worker exception: {exc}")
            except Exception as inner:
                log(f"job {job['id']}: could not report failure either: {inner}")


if __name__ == "__main__":
    main()
