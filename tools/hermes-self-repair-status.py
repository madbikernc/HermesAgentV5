#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-self-repair-status — Step 7's tracing/comparison, made concrete. Adds NO new observability
# infrastructure — every phase this renders was already being recorded (each pipeline component's
# own log_round()-shaped turn); this is purely a human-readable view over data that already exists,
# same "the trace is free once every step logs its own turn" property this whole pipeline was
# designed around from Step 2 onward.
#
# Two modes:
#   <task_id>     Full phase-by-phase timeline for one task (draft, each review round, revisions,
#                 static-scan, both security reviews and their cross-checks, the diff, the applied
#                 commit, the pre-promotion verification, the eventual promoted commit — whichever
#                 of these actually exist for this task) plus its current hermes-memory state.
#   --repo-diff   What's on NAS2 that hasn't been promoted to GitHub yet. Literally
#                 `git log origin/master..nas2-selfrepair/master` — the exact "compare separately"
#                 capability the original NAS2 proposal asked for. No hermes-memory call at all;
#                 touches only SELF_REPAIR_REPO_DIR's own git history.
#
# Config:
#   MEMORY_URL/MEMORY_TOKEN   required for the <task_id> mode
#   SELF_REPAIR_REPO_DIR      default ~/HermesAgentV5-selfrepair, used only by --repo-diff

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

# The pipeline's own real phase sequence, not alphabetical or arrival order — so the timeline reads
# top-to-bottom the way the pipeline actually runs even if turns land slightly out of order.
PHASE_ORDER = [
    "draft", "review", "revise", "third-party-review", "static-scan", "security-review",
    "security-meta-review", "diff", "applied-commit", "pre-promotion-verify", "promoted-commit",
]


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def fetch_task(task_id):
    return _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN)


def fetch_turns(task_id):
    return _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=500", MEMORY_TOKEN).get("turns", [])


def _phase_rank(phase):
    try:
        return PHASE_ORDER.index(phase)
    except ValueError:
        return len(PHASE_ORDER)  # unknown phases sort last, still shown, never dropped


def _parse_turn(t):
    try:
        return json.loads(t.get("raw") or "{}")
    except (ValueError, json.JSONDecodeError):
        return None


def render_turn(t):
    payload = _parse_turn(t)
    if payload is None:
        return f"[unparseable turn, id={t.get('id')}]: {(t.get('raw') or '')[:200]}"

    phase = payload.get("phase", "?")
    round_num = payload.get("round")
    actor = payload.get("actor", payload.get("agent", "?"))
    header = f"--- {phase}" + (f" round {round_num}" if round_num else "") + f" ({actor}) ---"

    if phase == "diff":
        return f"{header}\n{payload.get('content', '')}"
    if phase in ("applied-commit", "promoted-commit"):
        return (f"{header}\nsha: {payload.get('sha')}  remote: {payload.get('remote')}  "
                f"branch: {payload.get('branch')}")
    if phase == "pre-promotion-verify":
        return f"{header}\nok: {payload.get('ok')}\n{payload.get('report', '')}"
    return f"{header}\n{payload.get('content', '')}"


def sort_key(t):
    payload = _parse_turn(t) or {}
    # (real pipeline order, round number, turn's own insertion order) -- never re-sorts within a
    # tie arbitrarily.
    return (_phase_rank(payload.get("phase", "")), payload.get("round") or 0, t.get("id", 0))


def show_task(task_id):
    if not MEMORY_TOKEN:
        sys.exit("MEMORY_TOKEN is required")
    try:
        task = fetch_task(task_id)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            sys.exit(f"no such task {task_id!r}")
        sys.exit(f"task lookup failed: {exc}")

    print(f"Task {task_id}")
    print(f"State: {task.get('state')}")
    print(f"Topic: {task.get('topic')}")
    print()

    for t in sorted(fetch_turns(task_id), key=sort_key):
        print(render_turn(t))
        print()


def show_repo_diff():
    if not SELF_REPAIR_REPO_DIR.is_dir():
        sys.exit(f"SELF_REPAIR_REPO_DIR not found: {SELF_REPAIR_REPO_DIR}")
    subprocess.run(["git", "fetch", "origin"], cwd=str(SELF_REPAIR_REPO_DIR), check=False)
    subprocess.run(["git", "fetch", "nas2-selfrepair"], cwd=str(SELF_REPAIR_REPO_DIR), check=False)
    result = subprocess.run(
        ["git", "log", "origin/master..nas2-selfrepair/master", "--oneline"],
        cwd=str(SELF_REPAIR_REPO_DIR), capture_output=True, text=True)
    if not result.stdout.strip():
        print("Nothing on nas2-selfrepair/master that isn't already on origin/master.")
        return
    print("Commits on nas2-selfrepair/master not yet promoted to origin/master:\n")
    print(result.stdout)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: hermes-self-repair-status.py <task_id> | --repo-diff")
    if sys.argv[1] == "--repo-diff":
        show_repo_diff()
    else:
        show_task(sys.argv[1])


if __name__ == "__main__":
    main()
