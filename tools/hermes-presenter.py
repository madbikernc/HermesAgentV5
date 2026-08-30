#!/usr/bin/env python3
# Version: 1.0.1
#
# 1.0.1 — real bug found live during this stage's own verification: `join_room()` called the
# join-by-room-ID endpoint with PUT, which is wrong — that verb is for the txn-keyed
# send-message endpoint (`send_room_message()`, correctly PUT). Joining is POST. Every invite
# was silently un-actioned (405 Method Not Allowed, caught and logged, never crashed) until this
# was caught on the very first test invite.
#
# hermes-presenter — the fleet's one interactive voice, thin (HermesAgentV5/IMPLEMENTATION_PLAN.md
# S7; target architecture §6). Owns the Matrix connection so hermes-dispatch.py doesn't have to —
# target §6.1's whole argument: keep the latency-critical router/dispatcher out of response
# formatting, make personality a config file instead of baked into N agents' prompts.
#
# **This stage builds the seam, not the voice** (V5 IMPLEMENTATION_PLAN.md §4.4, operator
# direction). No styling model call exists here at all — every reply is passthrough, which
# trivially satisfies target §6.3's "passthrough by default" and defers the actual interactive
# persona as a separate decision. Add a styling pass later without touching the insulation
# contract below; do not backfill one in here casually.
#
# The insulation contract (target §6.2), enforced in code, not a prompt this process doesn't
# even have one of:
#   1. Inbound normalization — inbound text goes to hermes-memory and Buzz byte-for-byte. No
#      paraphrase, no trimming beyond what Matrix itself already did.
#   2. Conversation history — not this process's concern; hermes-dispatch.py reads raw from
#      hermes-memory directly, this process never re-derives or forwards "what was said."
#   3. Clarifying questions — out of scope for this stage (no styling pass exists to frame one).
#   4. Fidelity drift — cannot happen without a styling pass; passthrough is exact by
#      construction. A future styling stage must re-read this contract before adding one.
#   Failures escalate verbatim: a screened-out, errored, or timed-out task gets a plain, honest
#   status message, never silence and never invented certainty.
#
# Holds real local state (a Matrix sync cursor — normal for any Matrix client, unrelated to
# hermes-dispatch.py's routing-state non-negotiable) but no in-memory index of outstanding tasks:
# every pending task's reply-destination lives in hermes-memory's `agent_state` (`GET
# /state/presenter` lists them all), so a restart mid-conversation loses nothing but a few
# seconds of latency on the next poll.
#
# Config, all from the environment (injected by hermes-presenter-wrapper.sh):
#   MATRIX_HOMESERVER   default from the `matrix-presenter` vault item's `homeserver` field
#   MATRIX_USER_ID      required — from `matrix-presenter` vault item
#   MATRIX_ACCESS_TOKEN required — from `matrix-presenter` vault item
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN — required, same as hermes-dispatch.py
#   SYNC_STATE_FILE     default ~/.hermes/presenter/sync-token
#   POLL_SECONDS        default 5 — how often outstanding tasks are checked for completion
#   TASK_TIMEOUT_SECONDS default 300 — how long before an undelivered task gets a plain timeout
#                        notice instead of silence
#   DEBUG_ATTRIBUTION   default "0" — set "1" to prefix replies with "[dispatch→<topic>] "

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", f"http://{SPARK_IP}:6167").rstrip("/")
MATRIX_USER_ID = os.environ.get("MATRIX_USER_ID", "")
MATRIX_ACCESS_TOKEN = os.environ.get("MATRIX_ACCESS_TOKEN", "")

BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")

SYNC_STATE_FILE = Path(os.environ.get("SYNC_STATE_FILE", str(Path.home() / ".hermes" / "presenter" / "sync-token")))
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
TASK_TIMEOUT_SECONDS = int(os.environ.get("TASK_TIMEOUT_SECONDS", "300"))
DEBUG_ATTRIBUTION = os.environ.get("DEBUG_ATTRIBUTION", "0") == "1"


def log(msg):
    print(f"[hermes-presenter] {msg}", flush=True)


def _matrix_get(path, timeout=35):
    req = urllib.request.Request(f"{MATRIX_HOMESERVER}{path}")
    req.add_header("Authorization", f"Bearer {MATRIX_ACCESS_TOKEN}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _matrix_put(path, payload, timeout=15):
    req = urllib.request.Request(
        f"{MATRIX_HOMESERVER}{path}", data=json.dumps(payload).encode(), method="PUT",
        headers={"Content-Type": "application/json"},
    )
    req.add_header("Authorization", f"Bearer {MATRIX_ACCESS_TOKEN}")
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


def _matrix_post(path, payload, timeout=15):
    req = urllib.request.Request(
        f"{MATRIX_HOMESERVER}{path}", data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    req.add_header("Authorization", f"Bearer {MATRIX_ACCESS_TOKEN}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def send_room_message(room_id, body):
    txn = f"presenter-{int(time.time() * 1000)}"
    _matrix_put(f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id)}/send/m.room.message/{txn}",
                {"msgtype": "m.text", "body": body})


def join_room(room_id):
    # Matrix's join-by-room-ID endpoint is POST, not PUT (PUT is for the txn-keyed send-message
    # endpoint, a different route) -- real bug found live during S7's own verification: the
    # presenter never actually joined its first invited room, 405 Method Not Allowed on every
    # attempt.
    try:
        _matrix_post(f"/_matrix/client/v3/join/{urllib.parse.quote(room_id)}", {})
        log(f"joined {room_id}")
    except Exception as exc:
        log(f"failed to join {room_id}: {exc}")


def load_sync_token():
    try:
        return SYNC_STATE_FILE.read_text().strip() or None
    except FileNotFoundError:
        return None


def save_sync_token(token):
    SYNC_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    SYNC_STATE_FILE.write_text(token)


def handle_invite(room_id, invite_state):
    join_room(room_id)


def handle_message(room_id, event):
    content = event.get("content", {})
    if content.get("msgtype") != "m.text":
        return
    body = content.get("body", "")
    if not body:
        return

    task_id = uuid.uuid4().hex[:16]

    # Byte-for-byte, no normalization, no paraphrase (insulation contract §1).
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "presenter", "role": "user", "raw": body,
    }, MEMORY_TOKEN)

    _post(f"{MEMORY_URL}/state", {
        "agent": "presenter", "key": f"pending:{task_id}",
        "value": {"room_id": room_id, "requested_at": time.time(), "delivered": False},
    }, MEMORY_TOKEN)

    _post(f"{BUZZ_URL}/messages", {
        "from": "presenter", "topic": "dispatch",
        "task_id": task_id, "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)

    log(f"task {task_id}: inbound from {room_id}, dispatched")


def sync_once(since):
    params = {"timeout": "30000"}
    if since:
        params["since"] = since
    result = _matrix_get(f"/_matrix/client/v3/sync?{urllib.parse.urlencode(params)}")

    for room_id, room in result.get("rooms", {}).get("invite", {}).items():
        handle_invite(room_id, room.get("invite_state", {}))

    for room_id, room in result.get("rooms", {}).get("join", {}).items():
        for event in room.get("timeline", {}).get("events", []):
            if event.get("type") != "m.room.message":
                continue
            if event.get("sender") == MATRIX_USER_ID:
                continue  # never react to our own messages
            handle_message(room_id, event)

    return result.get("next_batch", since)


def format_reply(topic, text):
    if DEBUG_ATTRIBUTION and topic:
        return f"[dispatch→{topic}] {text}"
    return text


def check_outstanding():
    """No styling pass — passthrough only (see module docstring). Failures escalate verbatim:
    blocked/errored/timed-out tasks get a plain, honest status message, never silence."""
    try:
        pending = _get(f"{MEMORY_URL}/state/presenter", MEMORY_TOKEN).get("state", [])
    except Exception as exc:
        log(f"could not list outstanding tasks: {exc}")
        return

    now = time.time()
    for entry in pending:
        key, value = entry["key"], entry["value"]
        if not key.startswith("pending:") or value.get("delivered"):
            continue
        task_id = key[len("pending:"):]
        room_id = value["room_id"]

        try:
            task = _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                continue  # dispatch hasn't written a task record yet — not an error, just early
            log(f"task {task_id}: state lookup failed: {exc}")
            continue

        state = task.get("state")
        if state == "done":
            turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=50", MEMORY_TOKEN).get("turns", [])
            reply = next((t for t in reversed(turns) if t["agent"] != "presenter"), None)
            text = (reply.get("presented") or reply.get("raw")) if reply else "(task completed with no reply content)"
            send_room_message(room_id, format_reply(task.get("topic"), text))
            _mark_delivered(task_id, value)
            log(f"task {task_id}: delivered to {room_id}")
        elif state == "blocked":
            send_room_message(room_id, "This request was rejected by the fleet's screening layer and was not processed.")
            _mark_delivered(task_id, value)
        elif state == "error-no-content":
            send_room_message(room_id, "Something went wrong recording this request — it was never actually dispatched.")
            _mark_delivered(task_id, value)
        elif now - value.get("requested_at", now) > TASK_TIMEOUT_SECONDS:
            send_room_message(room_id, "No specialist has completed this request yet — it may still be in flight, "
                                        "or nothing is currently watching the topic it was routed to.")
            _mark_delivered(task_id, value)


def _mark_delivered(task_id, value):
    value = dict(value, delivered=True)
    _post(f"{MEMORY_URL}/state", {"agent": "presenter", "key": f"pending:{task_id}", "value": value}, MEMORY_TOKEN)


def main():
    if not (MATRIX_USER_ID and MATRIX_ACCESS_TOKEN):
        sys.exit("MATRIX_USER_ID and MATRIX_ACCESS_TOKEN are required")
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")

    since = load_sync_token()
    log(f"starting as {MATRIX_USER_ID} against {MATRIX_HOMESERVER}, "
        f"debug attribution: {'on' if DEBUG_ATTRIBUTION else 'off'}")

    last_check = 0
    while True:
        try:
            since = sync_once(since)
            save_sync_token(since)
        except Exception as exc:
            log(f"sync error, retrying: {exc}")
            time.sleep(POLL_SECONDS)

        if time.time() - last_check >= POLL_SECONDS:
            try:
                check_outstanding()
            except Exception as exc:
                log(f"check_outstanding error, continuing: {exc}")
            last_check = time.time()


if __name__ == "__main__":
    main()
