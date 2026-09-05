#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-baseline-authorize-watch.py — long-running watcher that turns "authorize REC-..." /
"reject REC-..." replies in FleetOps into routed action, and audits the result. Second half of
S17 (see tools/hermes-node-baseline-scan.py's own header for the first half: the daily
scan/diff/recommendation-write side of this pipeline).

Why this is a separate, async watcher rather than a reuse of tools/hermes-confirm-gate.sh:
that script blocks synchronously on a single-use random code for one immediate action —
exactly right for "confirm this one thing right now," wrong for "authorize this specific,
already-durable recommendation, possibly hours or days later." This watcher polls forward
instead of blocking, and matches on the recommendation's own REC id instead of a one-shot code,
so a reply days after the original notice still resolves correctly.

Security boundary is identical to hermes-confirm-gate.sh's proven one: only a message from
BOSS_USER_ID's real Matrix session counts. Authorization is Matrix-only, deliberately — email is
notify-only in this pipeline (see IMPLEMENTATION_PLAN.md S17), since a real Matrix session is
this fleet's one actually-verified "this is really The Boss" signal.

Routing (by the recommendation's `suggested_remediation.kind`, written by the scanner):
  service-restart   -- only when `target` + `identity` (sintra|amy) are both present in the
                        finding, i.e. it maps onto tools/hermes-remediate-worker.py's existing
                        allowlist. Submits a real broker job (same POST /jobs shape as
                        tools/hermes-remediate.sh) and does NOT block waiting for it to finish --
                        this poll loop has other REC ids to keep checking. No scan tool emits
                        this kind yet; the branch exists for a future finding type that does.
  config-patch,
  package-upgrade   -- routed to tools/hermes-dualcoder.py as a pointer-envelope Buzz message
                        (task_id=REC id, memory_ref=the turn just written describing the fix).
                        IMPORTANT, stated plainly rather than implied: dualcoder drafts and
                        adversarially reviews a SCRIPT/PATCH implementing the fix and publishes
                        it back to this same REC's history -- it does not execute anything
                        (hermes-code-security-scan.py's own header: "static only, never executes
                        the candidate code" -- dualcoder inherits that posture). A human still
                        runs the reviewed result. This pipeline gets you a reviewed fix on
                        record, not unattended auto-patching.
  anything else     -- state -> manual-required, FleetOps notice. Never a new privileged path.

Idempotency: a REC only routes once. Any authorize/reject reply after its task has left
`pending` (routed-remediate / routed-dualcoder / rejected / manual-required / resolved) gets a
"already <state>, ignoring" reply instead of re-running the routing.

Env:
  MATRIX_HOMESERVER      default http://127.0.0.1:6167
  FLEETOPS_MATRIX_TOKEN  required -- must be able to read AND post in FLEETOPS_ROOM
  FLEETOPS_ROOM          required
  BOSS_USER_ID           default @phone1:spark -- same default as hermes-confirm-gate.sh
  MEMORY_URL / MEMORY_TOKEN
  BUZZ_URL / BUZZ_TOKEN        for the dualcoder routing branch
  BROKER_URL / BROKER_TOKEN    for the service-restart routing branch (optional; that branch
                                logs and falls back to manual-required if unset)
  POLL_SECONDS           default 10
"""
import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
STATE_DIR = HERMES_HOME / "state" / "node-baseline"
LAST_TS_PATH = STATE_DIR / "authorize-watch-last-ts.json"
LOG_PATH = HERMES_HOME / "logs" / "baseline-authorize-watch.log"

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")
BOSS_USER_ID = os.environ.get("BOSS_USER_ID", "@phone1:spark")

MEMORY_URL = os.environ.get("MEMORY_URL", "http://10.129.1.15:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
BUZZ_URL = os.environ.get("BUZZ_URL", "http://10.129.1.15:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
BROKER_URL = os.environ.get("BROKER_URL", "http://10.129.1.15:8100").rstrip("/")
BROKER_TOKEN = os.environ.get("BROKER_TOKEN", "")

POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "10"))
AGENT_NAME = "node-baseline"

COMMAND_RE = re.compile(r"^\s*(authorize|reject)\s+(REC-\S+)\s*$", re.I)
MSG_FETCH_PAGE_LIMIT = 50
MSG_FETCH_MAX_PAGES = 5

TERMINAL_STATES = {"routed-remediate", "routed-dualcoder", "rejected", "manual-required", "resolved"}


def log(msg):
    line = f"[hermes-baseline-authorize-watch] {msg}"
    print(line, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')}  {msg}\n")
    except Exception:
        pass


# ── Matrix ───────────────────────────────────────────────────────────────────

def _matrix_get(path, timeout=15):
    req = urllib.request.Request(f"{MATRIX_HOMESERVER}{path}",
                                  headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def fetch_messages_since(room, since_ts_ms):
    """Paginated backward fetch, same shape/rationale as hermes-confirm-gate.sh's own copy of
    this logic: keep paging while the oldest event fetched so far is still newer than
    since_ts_ms, bounded by MSG_FETCH_MAX_PAGES so a very quiet room can't spin forever."""
    room_enc = urllib.parse.quote(room, safe="")
    all_events, from_tok, page = [], None, 0
    while page < MSG_FETCH_MAX_PAGES:
        path = (f"/_matrix/client/v3/rooms/{room_enc}/messages"
                f"?dir=b&limit={MSG_FETCH_PAGE_LIMIT}")
        if from_tok:
            path += f"&from={urllib.parse.quote(from_tok)}"
        try:
            resp = _matrix_get(path)
        except Exception as exc:
            log(f"Matrix fetch failed: {exc}")
            break
        chunk = resp.get("chunk", [])
        all_events.extend(chunk)
        msg_ts = [e["origin_server_ts"] for e in chunk if e.get("type") == "m.room.message"]
        oldest_ts = min(msg_ts) if msg_ts else 0
        from_tok = resp.get("end")
        page += 1
        if not from_tok or len(chunk) < MSG_FETCH_PAGE_LIMIT or (oldest_ts and oldest_ts <= since_ts_ms):
            break
    return all_events


def post_reply(text):
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        log(f"no FleetOps credentials — cannot post: {text}")
        return
    try:
        txn = f"baseline-authorize-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM, safe='')}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"reply post failed: {exc}")


# ── hermes-memory ────────────────────────────────────────────────────────────

def _mem_get(path, timeout=15):
    req = urllib.request.Request(f"{MEMORY_URL}{path}",
                                  headers={"Authorization": f"Bearer {MEMORY_TOKEN}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _mem_post(path, payload, timeout=15):
    req = urllib.request.Request(
        f"{MEMORY_URL}{path}", data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {MEMORY_TOKEN}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def get_task(rec_id):
    try:
        return _mem_get(f"/tasks/{urllib.parse.quote(rec_id, safe='')}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        log(f"get_task({rec_id!r}) failed: {exc}")
        return None
    except Exception as exc:
        log(f"get_task({rec_id!r}) failed: {exc}")
        return None


def set_task_state(rec_id, state):
    try:
        _mem_post("/tasks", {"id": rec_id, "agent": AGENT_NAME, "topic": "node-baseline", "state": state})
        return True
    except Exception as exc:
        log(f"set_task_state({rec_id!r}, {state!r}) failed: {exc}")
        return False


def write_audit_turn(rec_id, event):
    try:
        _mem_post("/turns", {"task_id": rec_id, "agent": AGENT_NAME, "role": "system",
                              "raw": json.dumps(event)})
    except Exception as exc:
        log(f"write_audit_turn({rec_id!r}) failed: {exc}")


def fetch_finding(rec_id):
    """The scanner writes exactly one turn with a 'suggested_remediation' key -- the original
    finding detail (resolve/authorize audit turns never carry that key). Scans newest-first."""
    try:
        turns = _mem_get(f"/turns?task_id={urllib.parse.quote(rec_id, safe='')}&limit=50").get("turns", [])
    except Exception as exc:
        log(f"fetch_finding({rec_id!r}): could not list turns: {exc}")
        return None
    for t in sorted(turns, key=lambda t: t.get("created_at", 0), reverse=True):
        try:
            data = json.loads(t["raw"])
        except (KeyError, ValueError, TypeError):
            continue
        if isinstance(data, dict) and "suggested_remediation" in data:
            return data
    return None


# ── hermes-buzz (dualcoder routing) ─────────────────────────────────────────

def submit_to_dualcoder(rec_id, node, finding):
    task_spec = (
        f"Write and, if needed, revise a script or configuration patch that remediates the "
        f"following {finding['tool']} finding on node {node}. This came from an automated "
        f"security-baseline scan and was explicitly authorized by the fleet operator.\n\n"
        f"Finding: {finding['description']}\n"
        f"Severity: {finding['severity']}\n"
        f"Suggested approach: {finding.get('suggested_remediation', {}).get('detail', '(none given)')}\n\n"
        f"The script must be idempotent (safe to run more than once) and must not execute "
        f"itself or make any network/system change beyond what is explicitly needed for this "
        f"one fix. A human will review your output and run it manually."
    )
    try:
        turn = _mem_post("/turns", {"task_id": rec_id, "agent": AGENT_NAME, "role": "user", "raw": task_spec})
        turn_id = turn.get("id")
        if turn_id is None:
            raise RuntimeError(f"hermes-memory did not return a turn id: {turn}")
        req = urllib.request.Request(
            f"{BUZZ_URL}/messages",
            data=json.dumps({"from": AGENT_NAME, "topic": "dualcoder",
                              "task_id": rec_id, "memory_ref": f"turn:{turn_id}"}).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {BUZZ_TOKEN}"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return True, None
    except Exception as exc:
        return False, str(exc)


# ── hermes-broker (service-restart routing) ─────────────────────────────────

def submit_service_restart(identity, target):
    if not BROKER_TOKEN:
        return False, None, "BROKER_TOKEN not configured"
    try:
        req = urllib.request.Request(
            f"{BROKER_URL}/jobs",
            data=json.dumps({"type": f"remediate-{identity}",
                              "payload": {"identity": identity, "action": "restart-service",
                                          "target": target}}).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {BROKER_TOKEN}"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        job_id = data.get("id")
        if not job_id:
            return False, None, f"broker rejected submission: {data}"
        return True, job_id, None
    except Exception as exc:
        return False, None, str(exc)


# ── routing ──────────────────────────────────────────────────────────────────

def route(rec_id, node, finding):
    remediation = finding.get("suggested_remediation", {})
    kind = remediation.get("kind")

    if kind == "service-restart" and remediation.get("target") and remediation.get("identity") in ("sintra", "amy"):
        ok, job_id, err = submit_service_restart(remediation["identity"], remediation["target"])
        if ok:
            set_task_state(rec_id, "routed-remediate")
            write_audit_turn(rec_id, {"status": "routed-remediate", "broker_job_id": job_id})
            post_reply(f"✅ {rec_id}: submitted restart of {remediation['target']!r} "
                       f"(broker job {job_id}). Not waiting for it to finish here — "
                       f"check status with the broker if needed.")
        else:
            set_task_state(rec_id, "manual-required")
            write_audit_turn(rec_id, {"status": "manual-required", "reason": f"broker submit failed: {err}"})
            post_reply(f"⚠️ {rec_id}: could not submit the restart ({err}) — marked manual-required.")
        return

    if kind in ("config-patch", "package-upgrade"):
        ok, err = submit_to_dualcoder(rec_id, node, finding)
        if ok:
            set_task_state(rec_id, "routed-dualcoder")
            write_audit_turn(rec_id, {"status": "routed-dualcoder"})
            post_reply(f"✅ {rec_id}: sent to the coder/coder2 review loop. It will draft and "
                       f"adversarially review a fix, but will NOT run anything — the reviewed "
                       f"result lands in this REC's own history for you to apply by hand. "
                       f"Check with: GET {MEMORY_URL}/turns?task_id={rec_id}")
        else:
            set_task_state(rec_id, "manual-required")
            write_audit_turn(rec_id, {"status": "manual-required", "reason": f"dualcoder submit failed: {err}"})
            post_reply(f"⚠️ {rec_id}: could not submit to dualcoder ({err}) — marked manual-required.")
        return

    set_task_state(rec_id, "manual-required")
    write_audit_turn(rec_id, {"status": "manual-required", "reason": f"no automatic path for kind={kind!r}"})
    post_reply(f"ℹ️ {rec_id}: no automatic remediation path for this finding "
               f"(kind={kind!r}) — marked manual-required. It's on you.")


# ── command handling ─────────────────────────────────────────────────────────

def handle_command(cmd, rec_id):
    task = get_task(rec_id)
    if task is None:
        post_reply(f"❓ {rec_id}: no such recommendation on record.")
        return

    state = task.get("state")
    if state in TERMINAL_STATES:
        post_reply(f"↩️ {rec_id} is already '{state}' — ignoring (reply is a no-op once a "
                   f"recommendation has left 'pending').")
        return

    if cmd == "reject":
        set_task_state(rec_id, "rejected")
        write_audit_turn(rec_id, {"status": "rejected"})
        post_reply(f"🚫 {rec_id}: rejected, no action taken.")
        return

    finding = fetch_finding(rec_id)
    if finding is None:
        post_reply(f"⚠️ {rec_id}: could not retrieve the original finding detail — "
                   f"not routing. Left as '{state}'; try again once hermes-memory is reachable.")
        return

    node = finding.get("node", "?")  # the scanner writes "node" alongside the finding fields
                                       # in the same turn -- see write_recommendation()
    route(rec_id, node, finding)


def poll_once(last_ts_ms):
    events = fetch_messages_since(FLEETOPS_ROOM, last_ts_ms)
    newest_ts = last_ts_ms
    matches = []
    for e in events:
        ts = e.get("origin_server_ts", 0)
        if e.get("type") != "m.room.message" or e.get("sender") != BOSS_USER_ID or ts <= last_ts_ms:
            continue
        body = (e.get("content", {}) or {}).get("body", "")
        m = COMMAND_RE.match(body)
        if m:
            matches.append((ts, m.group(1).lower(), m.group(2)))
        newest_ts = max(newest_ts, ts)

    for ts, cmd, rec_id in sorted(matches):  # process in chronological order
        log(f"{cmd} {rec_id} (from {BOSS_USER_ID} at {ts})")
        try:
            handle_command(cmd, rec_id)
        except Exception as exc:
            log(f"handle_command({cmd!r}, {rec_id!r}) raised: {exc}")
    return newest_ts


def load_last_ts():
    try:
        return json.loads(LAST_TS_PATH.read_text()).get("last_ts_ms", 0)
    except Exception:
        return int(time.time() * 1000)  # first run: don't replay all of room history


def save_last_ts(ts):
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        LAST_TS_PATH.write_text(json.dumps({"last_ts_ms": ts}))
    except Exception as exc:
        log(f"could not persist last_ts: {exc}")


def main():
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        raise SystemExit("FLEETOPS_MATRIX_TOKEN and FLEETOPS_ROOM are required")
    if not MEMORY_TOKEN:
        raise SystemExit("MEMORY_TOKEN is required")
    last_ts = load_last_ts()
    log(f"watching {FLEETOPS_ROOM} for authorize/reject from {BOSS_USER_ID}, "
        f"polling every {POLL_SECONDS}s (host {socket.gethostname()})")
    while True:
        try:
            last_ts = poll_once(last_ts)
            save_last_ts(last_ts)
        except Exception as exc:
            log(f"unhandled error this cycle, continuing: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
