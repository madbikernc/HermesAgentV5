#!/usr/bin/env python3
# Version: 1.2.0
#
# 1.2.0 (2026-11-13) — direct operator request: "skip" also declines a task parked in
# "awaiting-completeness". Found live: the operator skipped five staged fixes that do nothing
# (helpers nobody calls, comment-only edits) and the gate refused all five, because each was
# waiting on a linked test task that never finished -- so they could neither be declined nor
# ever reach "verified". A decline needs no completeness: nothing is promoted, the commit stays on
# NAS2. hermes-self-repair-apply.py's unblock_linked_peer() only ever moves a peer still in
# "awaiting-completeness" to "verified", so a declined task stays declined; and
# hermes-self-repair-bridge.py 2.4.0 never retries a signature once a task is
# "promotion-declined". "promote" is unchanged: still "verified" only.
#
# 1.1.0 (2026-11-08) — FLEET_SELFREPAIR_DESIGN.md §4.8's FleetOps `/selfrepair` tab needs to import
# this gate's transition table rather than reimplement it, the exact house rule
# `infra/hermes-fleetops-ui/README.md:54-68` already established for the model-scout backlog's
# decide buttons. Adds TRANSITIONS (a lookup table over the same two states/actions
# handle_command() already enforced inline, so this is a refactor, not a behavior change: a
# constructed test confirms `state != "verified"` and `state not in TRANSITIONS[action][0]` agree
# for every state) and write_turn() (model-scout-gate.py's own shape, new here — this gate never
# wrote a turn for its own transitions before, only hermes-memory's task-state column and the
# Matrix reply). handle_command() now reads both from the table and calls write_turn() after a
# successful transition, so a future UI route's own `decided_by: "fleetops-ui"` has a turn to add
# it to, the same way the scout gate's write_turn() already lets the model-scout backlog page
# distinguish a browser decision from a chat one. Also fixes a real latent gap found while wiring
# the UI route to it: set_task_state() never returned anything, so EVERY caller -- including this
# file's own handle_command(), not just the new UI path -- had no way to tell a successful write
# from a failed one except by reading the log line. Now returns True/False like
# hermes-model-scout-gate.py's own set_task_state() already does; handle_command()'s behavior is
# unchanged since it still never checked the (previously always-None, now True) return value.
#
# hermes-self-repair-promote-gate — Step 5's human confirmation gate. Holds NO GitHub credential
# and runs NO model call — it only watches the FleetOps room for a deterministic
# "promote <task_id>" / "skip <task_id>" reply and updates hermes-memory task state accordingly.
# Same "no LLM turn is load-bearing for a privileged decision" principle this whole pipeline
# already follows, applied to the human-approval step itself: approval is a plain-text command this
# script parses with a regex, never something inferred from free-form chat.
#
# Why this is a separate long-running poll loop, not folded into hermes-self-repair-apply.py: that
# process is a broker-job worker (claim -> do mechanical work -> report -> repeat) and must never
# block waiting on a human reply that could take hours or days. hermes-self-repair-apply.py posts a
# one-shot offer (post_promotion_offer(), its own 1.2.0) the moment a task becomes verified; THIS
# process is what actually watches for and parses the reply, on its own poll cadence, independent
# of any single task's lifecycle.
#
# Message fetching pages backward with the same bounded-paging shape
# tools/hermes-fabrication-guard.sh's own fetch_messages_since() already uses — a single
# fixed-size page can silently miss a command under enough room traffic in one poll interval.
#
# Command grammar is deliberately strict: the ENTIRE message body must be exactly "promote <id>" or
# "skip <id>" (case-insensitive, one id, no extra text) — this script's own longer reply messages
# (multi-line, with a code block) can never accidentally re-match as a new command.
#
# handle_command() ALWAYS re-fetches the task from hermes-memory and re-checks its real state
# before acting — never trusts that a task named in a chat message is actually awaiting a decision.
# Only a task in state == "verified" can be promoted; "skip" is also legal from
# "awaiting-completeness" (1.2.0). Anything else (already decided,
# still generating, failed verification, or a typo'd id) gets a plain refusal reply, not a silent
# ignore and not a guess.
#
# On "promote <id>": looks up the task's own phase="applied-commit" turn (logged by
# hermes-self-repair-apply.py) for the exact sha, sets state = "promotion-approved", and replies
# with the exact command a human should run BY HAND, on a machine with real GitHub push rights, to
# actually complete the promotion — tools/hermes-self-repair-promote.py. This script never runs
# that itself and never will; see that file's own header and infra/hermes-self-repair/README.md for
# why the two-step split (chat approval here, separate manual execution there) is intentional.
#
# On "skip <id>": sets state = "promotion-declined". The commit stays on GIT_REMOTE (NAS2) either
# way — nothing is ever deleted or reverted by a skip, only marked as not going further.
#
# Config, all from the environment (injected by hermes-self-repair-promote-gate-wrapper.sh):
#   MATRIX_HOMESERVER      default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN  required — same matrix-fleetops credential every other escalation/notice
#                          path in this fleet already uses (hermes-remediate-worker.py,
#                          hermes-fabrication-guard.sh, hermes-repo-sync.sh)
#   FLEETOPS_ROOM          required
#   MEMORY_URL/MEMORY_TOKEN   required
#   POLL_SECONDS           default 20 — FleetOps traffic is low-volume; no need for a tight loop
#   MSG_FETCH_PAGE_LIMIT   default 50
#   MSG_FETCH_MAX_PAGES    default 5
#   STATE_DIR              default ~/.hermes/state/selfrepair-promote-gate — holds only a
#                          last-seen-timestamp cursor, nothing sensitive

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167").rstrip("/")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")

MEMORY_URL = os.environ.get("MEMORY_URL", "http://10.129.1.15:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")

POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "20"))
MSG_FETCH_PAGE_LIMIT = int(os.environ.get("MSG_FETCH_PAGE_LIMIT", "50"))
MSG_FETCH_MAX_PAGES = int(os.environ.get("MSG_FETCH_MAX_PAGES", "5"))

STATE_DIR = Path(os.environ.get("STATE_DIR", str(Path.home() / ".hermes" / "state" / "selfrepair-promote-gate")))
STATE_FILE = STATE_DIR / "state.json"

# Strict, whole-message match only — see module header for why this can never self-trigger on this
# script's own (much longer) reply text.
COMMAND_RE = re.compile(r"^\s*(promote|skip)\s+(\S+)\s*$", re.IGNORECASE)

GATE_AGENT = "selfrepair-promote-gate"

# action -> (states it is legal from, resulting state). The table handle_command() actually reads
# from (1.1.0) — self-repair tasks have no single stable "owner" agent the way model-scout's do
# (see tools/hermes-self-repair-list.py's own header), so there is no AGENT constant/ownership
# check here to match model-scout-gate.py's shape; a task's eligibility is its state alone.
TRANSITIONS = {
    "promote": ({"verified"}, "promotion-approved"),
    "skip": ({"verified", "awaiting-completeness"}, "promotion-declined"),
}


def log(msg):
    print(f"[hermes-self-repair-promote-gate] {msg}", flush=True)


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


def set_task_state(task_id, state):
    try:
        _post(f"{MEMORY_URL}/tasks", {"id": task_id, "agent": "selfrepair-promote-gate", "state": state}, MEMORY_TOKEN)
        return True
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")
        return False


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


def write_turn(task_id, payload):
    """The decision's own record (1.1.0) — model-scout-gate.py's own shape. Non-fatal: a turn-write
    failure must not undo a state transition the human already asked for and which is already
    written."""
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": task_id, "agent": GATE_AGENT, "role": "gate",
            "raw": json.dumps(payload, sort_keys=True),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"turn write failed for {task_id}, state change still applied: {exc}")


def send_room_message(text):
    try:
        txn = f"selfrepair-promote-gate-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/{urllib.parse.quote(FLEETOPS_ROOM)}"
            f"/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(), method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"send_room_message failed: {exc}")


def fetch_messages_since(since_ts):
    all_events = []
    from_token = None
    for _ in range(MSG_FETCH_MAX_PAGES):
        url = (f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/{urllib.parse.quote(FLEETOPS_ROOM)}"
               f"/messages?dir=b&limit={MSG_FETCH_PAGE_LIMIT}")
        if from_token:
            url += f"&from={urllib.parse.quote(from_token)}"
        resp = _get(url, FLEETOPS_TOKEN)
        chunk = resp.get("chunk", [])
        all_events.extend(chunk)
        oldest_ts = min((e.get("origin_server_ts", 0) for e in chunk), default=0)
        from_token = resp.get("end")
        if not from_token or len(chunk) < MSG_FETCH_PAGE_LIMIT or (oldest_ts and oldest_ts <= since_ts):
            break
    return all_events


def load_state():
    if not STATE_FILE.exists():
        return {"last_ts": 0}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"last_ts": 0}


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state))


def handle_command(action, task_id):
    try:
        task = fetch_task(task_id)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            send_room_message(f"[self-repair] No such task {task_id!r} — ignoring \"{action} {task_id}\".")
            return
        log(f"task lookup failed for {task_id!r}: {exc}")
        return
    except Exception as exc:
        log(f"task lookup failed for {task_id!r}: {exc}")
        return

    state = task.get("state")
    legal_from, new_state = TRANSITIONS[action]
    if state not in legal_from:
        send_room_message(
            f"[self-repair] Task {task_id} is not awaiting a promotion decision "
            f"(current state: {state!r}) — ignoring \"{action} {task_id}\"."
        )
        return

    if action == "promote":
        sha = fetch_applied_sha(task_id)
        if not sha:
            send_room_message(
                f"[self-repair] Task {task_id} has no recorded applied commit — cannot approve "
                f"promotion, something is wrong. Not changing its state."
            )
            return
        set_task_state(task_id, new_state)
        write_turn(task_id, {
            "phase": "transition", "action": action, "from": state, "to": new_state,
            "decided_by": "fleetops-reply", "at": time.time(),
            "summary": f"{task_id}: {state} -> {new_state} by \"{action}\"",
        })
        send_room_message(
            f"[self-repair] Task {task_id} approved for promotion (commit {sha[:12]}). To complete "
            f"it, run this BY HAND on a machine with real GitHub push access:\n\n"
            f"  python3 tools/hermes-self-repair-promote.py {task_id}\n\n"
            f"That script cherry-picks only this task's commit onto a fresh branch off "
            f"origin/master and pushes if clean — never force, never touches anything else staged "
            f"on NAS2."
        )
    elif action == "skip":
        set_task_state(task_id, new_state)
        write_turn(task_id, {
            "phase": "transition", "action": action, "from": state, "to": new_state,
            "decided_by": "fleetops-reply", "at": time.time(),
            "summary": f"{task_id}: {state} -> {new_state} by \"{action}\"",
        })
        send_room_message(f"[self-repair] Task {task_id} marked declined — staying staged on NAS2 only.")


def poll_once(state):
    events = fetch_messages_since(state["last_ts"])
    new_events = sorted(
        (e for e in events if e.get("type") == "m.room.message"
         and e.get("origin_server_ts", 0) > state["last_ts"]
         and e.get("content", {}).get("msgtype") == "m.text"),
        key=lambda e: e["origin_server_ts"],
    )
    for event in new_events:
        body = event.get("content", {}).get("body", "")
        m = COMMAND_RE.match(body)
        if m:
            action, task_id = m.group(1).lower(), m.group(2)
            log(f"parsed command: {action} {task_id!r}")
            handle_command(action, task_id)
        state["last_ts"] = event["origin_server_ts"]
    save_state(state)


def main():
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        sys.exit("FLEETOPS_MATRIX_TOKEN and FLEETOPS_ROOM are required")
    if not MEMORY_TOKEN:
        sys.exit("MEMORY_TOKEN is required")
    log(f"watching FleetOps room for \"promote <task_id>\"/\"skip <task_id>\" replies, "
        f"polling every {POLL_SECONDS}s")
    state = load_state()
    while True:
        try:
            poll_once(state)
        except Exception as exc:
            log(f"poll error, continuing: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
