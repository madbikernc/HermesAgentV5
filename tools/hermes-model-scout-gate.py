#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-model-scout-gate — S20c's human decision gate. Modeled directly on
# hermes-self-repair-promote-gate.py, which already proved this shape for "never do the
# privileged thing without an explicit human reply." Same three rules, kept deliberately:
#
#   1. Strict, whole-message command grammar, parsed by regex. Approval is a plain-text command,
#      never something inferred from free-form chat. This gate's own replies are multi-line and
#      can therefore never re-match as a new command.
#   2. ALWAYS re-fetch the task from hermes-memory and re-check its real state before acting. A
#      task id in a chat message is an address, not evidence that it is awaiting a decision.
#   3. Holds no privileged credential and makes no model call. It reads/posts Matrix messages and
#      writes hermes-memory task state. That is all it can do.
#
# ── IT DOES NOT RUN BENCHMARKS, AND THIS IS NOT AN OVERSIGHT ──
# skills/model-benchmark/SKILL.md's own Rules section states that benchmarking is a foreground,
# human-attended operation and not something to kick off on one's own initiative. S20 does not get
# to override that by being a different caller. On `benchmark <id>` this gate sets the task to
# `approved` and replies with the exact hermes-benchmark-model.sh invocation for a human to run by
# hand — including the exact --model-id label, which is load-bearing: hermes-model-scout.py's
# reconcile_done() matches the benchmark history on that prescribed label, so prescribing it here
# is what makes "done" deterministic instead of a fuzzy guess. If unattended execution is ever
# wanted, that is a separate, explicit decision.
#
# ── Verbs, and why they are disjoint from self-repair's ──
# Two independent gates now watch the same FleetOps room. Self-repair owns `promote`/`skip`; this
# one owns `benchmark`/`defer`/`reject`/`override`. No verb is shared, so a message can only ever
# match one gate's grammar. Each gate logs every command it handles, which is what makes a future
# third gate's collisions findable (S20 risk 3).
#
#   benchmark <id>  proposed|deferred            -> approved   (replies with the manual command)
#   defer <id>      proposed                     -> deferred   (stays out of daily noise, stays
#                                                               visible to --backlog)
#   reject <id>     proposed|deferred            -> rejected   (PERMANENT — hermes-model-scout.py
#                                                               never re-proposes a rejected id)
#   override <id>   rejected                     -> proposed   (the only way back from rejected,
#                                                               and only from an explicit reply —
#                                                               never an agent's own judgment that
#                                                               "this time is different")
#
# Any other current state gets a plain refusal reply naming the real state, never a silent ignore
# and never a guess. A task owned by a different agent is refused too — this gate only ever acts on
# agent="model-scout" tasks, checked against the record rather than inferred from the id's prefix.
#
# Config, all from the environment (injected by hermes-model-scout-gate-wrapper.sh):
#   MATRIX_HOMESERVER      default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN  required — the same matrix-fleetops credential every other escalation
#                          path in this fleet uses
#   FLEETOPS_ROOM          required
#   MEMORY_URL             default http://10.129.1.15:8102 (LAN bind, not loopback)
#   MEMORY_TOKEN           required
#   POLL_SECONDS           default 20
#   MSG_FETCH_PAGE_LIMIT   default 50
#   MSG_FETCH_MAX_PAGES    default 5
#   STATE_DIR              default ~/.hermes/state/model-scout-gate — a last-seen cursor only
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

STATE_DIR = Path(os.environ.get("STATE_DIR", str(Path.home() / ".hermes" / "state" / "model-scout-gate")))
STATE_FILE = STATE_DIR / "state.json"

AGENT = "model-scout"
GATE_AGENT = "model-scout-gate"

COMMAND_RE = re.compile(r"^\s*(benchmark|defer|reject|override)\s+(\S+)\s*$", re.IGNORECASE)

# action -> (states it is legal from, resulting state)
TRANSITIONS = {
    "benchmark": ({"proposed", "deferred"}, "approved"),
    "defer": ({"proposed"}, "deferred"),
    "reject": ({"proposed", "deferred"}, "rejected"),
    "override": ({"rejected"}, "proposed"),
}


def log(msg):
    print(f"[hermes-model-scout-gate] {msg}", flush=True)


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        return json.loads(body) if body else {}


def fetch_task(task_id):
    # hermes-memory resolves this route as parsed.path.split("/")[2] and NEVER unquotes it, so a
    # percent-encoded colon is a different id to the server. urllib's quote() escapes ":" by
    # default, which made every lookup 404 and (worse) made dedup silently fail — a task that
    # already existed read as absent, so it would have been re-proposed and re-announced every
    # day. Caught by the live gate probe, 2026-10-08. TASK_ID_RE's charset is already
    # path-safe, so the colon is the only character that needs declaring here.
    return _get(f"{MEMORY_URL}/tasks/{urllib.parse.quote(task_id, safe=':')}", MEMORY_TOKEN)


def set_task_state(task_id, state, topic=None):
    try:
        _post(f"{MEMORY_URL}/tasks",
              {"id": task_id, "agent": AGENT, "state": state, "topic": topic}, MEMORY_TOKEN)
        return True
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")
        return False


def write_turn(task_id, payload):
    """The decision's own record. Non-fatal: POST /turns embeds its `raw`, so an embedder outage
    must not cost the state transition the human just asked for."""
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": task_id, "agent": GATE_AGENT, "role": "gate",
            "raw": json.dumps(payload, sort_keys=True),
            "presented": payload.get("summary"),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"turn write failed for {task_id}, state change still applied: {exc}")


def task_turns(task_id, limit=200):
    try:
        turns = _get(f"{MEMORY_URL}/turns?task_id={urllib.parse.quote(task_id)}&limit={limit}",
                     MEMORY_TOKEN).get("turns", [])
    except Exception as exc:
        log(f"turn read failed for {task_id}: {exc}")
        return []
    out = []
    for t in turns:
        try:
            out.append(json.loads(t.get("raw") or "{}"))
        except (ValueError, json.JSONDecodeError):
            continue
    return out


def candidate_facts(task_id):
    """The newest `candidate` turn hermes-model-scout.py wrote, which carries the real model id and
    the prescribed benchmark label. Returns {} if there is none — handled by the caller rather than
    assumed present, since a task with no candidate turn means the embedder was down when it was
    proposed and the reply must say so instead of inventing a command."""
    facts = {}
    for payload in task_turns(task_id):
        if payload.get("phase") == "candidate":
            facts = payload
    return facts


def send_room_message(text):
    try:
        txn = f"model-scout-gate-{int(time.time() * 1000)}"
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
    """Bounded backward paging, same shape hermes-self-repair-promote-gate.py and
    hermes-fabrication-guard.sh use — one fixed page can miss a command under room traffic."""
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


def approval_reply(task_id, facts):
    """hermes-benchmark-model.sh has two modes and neither one takes an HF repo id to fetch:
    `--role` benchmarks a backend this fleet already serves, and `--candidate` benchmarks a GGUF
    that already exists on disk. A scouted candidate is by definition neither yet, so this reply
    is deliberately a two-step with the download named as the human's step — printing a
    single-line command that silently assumed a local path would be the kind of
    almost-right instruction that wastes a foreground session."""
    model_id = facts.get("model_id")
    label = facts.get("prescribed_benchmark_label")
    gguf = facts.get("gguf_repo")
    if not (model_id and label):
        return (f"[model-scout] {task_id} is approved, but its candidate record is missing "
                f"(no model id on file) — run `python3 tools/hermes-model-scout.py --backlog` and "
                f"check hermes-memory before benchmarking. Not printing a command that might be wrong.")
    if not gguf:
        step1 = ("  1. No GGUF build was found for this repo, so there is nothing llama.cpp can "
                 "load yet. Converting it is its own job (infra/model-abliteration/README.md §3 "
                 "covers the build side) — that is the real first step, not a download.")
    else:
        step1 = (f"  1. Fetch a GGUF onto the node that will run the benchmark. The build found "
                 f"for this candidate was:\n       {gguf}\n"
                 f"     (found by string match, which is not proof llama.cpp can load it — a real "
                 f"load test is still what decides.)")
    return (
        f"[model-scout] {task_id} approved for benchmarking.\n"
        f"Benchmarking is a foreground, human-attended operation and nothing in this pipeline runs "
        f"it for you (skills/model-benchmark/SKILL.md's own rule).\n\n"
        f"{step1}\n"
        f"  2. Then, BY HAND, in candidate mode against that local file:\n\n"
        f"       bash tools/hermes-benchmark-model.sh --candidate /path/to/model.gguf \\\n"
        f"           --model-id {label}\n\n"
        f"Use that exact --model-id. hermes-model-scout.py's next run reads the benchmark history "
        f"for it and is the only thing that can mark this task done — a different label means it "
        f"will keep reporting as approved, not done.\n"
        f"Afterwards, compare it against whatever the role runs today:\n"
        f"  python3 tools/hermes-benchmark-compare.py --model-id {label} --against <incumbent-label>"
    )


def handle_command(action, task_id):
    try:
        task = fetch_task(task_id)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            send_room_message(f"[model-scout] No such task {task_id!r} — ignoring \"{action} {task_id}\".")
            return
        log(f"task lookup failed for {task_id!r}: {exc}")
        return
    except Exception as exc:
        log(f"task lookup failed for {task_id!r}: {exc}")
        return

    owner = task.get("agent")
    if owner != AGENT:
        send_room_message(
            f"[model-scout] Task {task_id} belongs to agent {owner!r}, not {AGENT!r} — refusing "
            f"\"{action} {task_id}\". This gate only acts on model-scout tasks.")
        return

    state = task.get("state")
    legal_from, new_state = TRANSITIONS[action]
    if state not in legal_from:
        send_room_message(
            f"[model-scout] Task {task_id} is in state {state!r}; \"{action}\" is only valid from "
            f"{sorted(legal_from)} — ignoring. Current backlog: "
            f"`python3 tools/hermes-model-scout.py --backlog`.")
        return

    facts = candidate_facts(task_id) if action == "benchmark" else {}
    if not set_task_state(task_id, new_state, topic=task.get("topic")):
        send_room_message(
            f"[model-scout] Could not write state for {task_id} — hermes-memory rejected the "
            f"update. Nothing changed; try again or check the service.")
        return

    write_turn(task_id, {
        "phase": "transition", "action": action, "from": state, "to": new_state,
        "decided_by": "fleetops-reply", "at": time.time(),
        "summary": f"{task_id}: {state} -> {new_state} by \"{action}\"",
    })
    log(f"{task_id}: {state} -> {new_state} ({action})")

    if action == "benchmark":
        send_room_message(approval_reply(task_id, facts))
    elif action == "defer":
        send_room_message(
            f"[model-scout] {task_id} deferred — it stays out of the daily candidate notices and "
            f"stays visible in `--backlog`. Reply \"benchmark {task_id}\" or \"reject {task_id}\" "
            f"whenever you want to move it.")
    elif action == "reject":
        send_room_message(
            f"[model-scout] {task_id} rejected, permanently — it will never be re-proposed. The "
            f"only way back is \"override {task_id}\".")
    elif action == "override":
        send_room_message(
            f"[model-scout] {task_id} un-rejected and back to proposed, on an explicit reply. "
            f"It will appear in the backlog again and can be benchmarked or rejected as normal.")


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
    log("watching FleetOps for \"benchmark|defer|reject|override <task_id>\", "
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
