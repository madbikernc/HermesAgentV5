#!/usr/bin/env python3
# Version: 2.0.10
#
# 2.0.10 (2026-08-31) — added `probe` to `KNOWN_AGENTS`/`KNOWN_TOPICS`, proactively, ahead of the
# new async node-probe agent's own first publish — same recurring bug class every entry below this
# one documents. `probe` IS a normal hermes-dispatch.py routing target (unlike `websearch`) — see
# tools/hermes-probe.py.
#
# 2.0.9 (2026-08-31) — added `status` to `KNOWN_AGENTS`/`KNOWN_TOPICS`, proactively, ahead of the
# new curated read-only skill-status agent's own first publish — same recurring bug class every
# entry below this one documents. Unlike `websearch`, `status` IS a normal
# `hermes-dispatch.py` routing target (VALID_TARGETS) — see hermes-status.py.
#
# 2.0.8 (2026-08-30) — added `websearch` to `KNOWN_AGENTS`/`KNOWN_TOPICS`, proactively, ahead of
# the new internet-search fallback agent's own first publish — same recurring bug class every
# entry below this one documents. `websearch` is presenter-dispatched only (a RAG-fallback offer
# the user explicitly confirms), never a `hermes-dispatch.py` routing target — see
# hermes-presenter.py 1.4.0 and the new tools/hermes-websearch.py.
#
# 2.0.7 (2026-08-30) — added `retrieve`, `code`, `screen` to `KNOWN_AGENTS`, proactively this
# time, ahead of the three new specialist agents' own first `results` publish — same recurring
# bug class every entry below this one documents.
#
# 2.0.6 — HermesAgentV5 S15: added `logs` to `KNOWN_AGENTS`. Same bug class S6 hit with
# `dispatch`, not caught proactively this time despite 2.0.4/2.0.5's own precedent: found live
# when `hermes-logs.py`'s first real end-to-end test got a 400 on its own `results` publish, task
# state already correctly "done" from the two calls before it in the same sequence.
#
# 2.0.5 — HermesAgentV5 S10: added `media` to `KNOWN_AGENTS` ahead of `hermes-media.py`
# publishing as itself, done proactively this time.
#
# 2.0.4 — HermesAgentV5 S7: added `presenter` to `KNOWN_AGENTS` ahead of `hermes-presenter.py`
# publishing as itself, done proactively this time — S6 found the hard way that forgetting this
# for a new sender identity crashes its caller.
#
# 2.0.3 — real bug found live minutes after 2.0.2 shipped: `KNOWN_AGENTS` (who may publish) was
# never extended when `hermes-dispatch.py` was built to publish onward as `from="dispatch"` —
# only `KNOWN_TOPICS` (what may be published *to*) had `dispatch` added, back in 2.0.0. Every
# outbound publish from the dispatcher failed with 400 until this was caught, which in turn
# crashed the dispatcher itself (a separate bug, fixed in `hermes-dispatch.py` 1.0.1 — the daemon
# should never have died on one bad response regardless of the root cause here).
#
# 2.0.2 — real gap found live during S6's own verification: `POST /messages` required a
# non-empty `body` unconditionally, making a pure pointer envelope (`task_id`+`memory_ref`,
# target §7.3's actual invariant, and the whole reason 2.0.0 added those columns) impossible to
# publish — the exact thing S6's `hermes-dispatch.py` needed to do first. Fixed: `body` is only
# required when the envelope doesn't carry both `task_id` and `memory_ref`.
#
# 2.0.1 — real bug found live during S3's own verification, same deployment cycle as 2.0.0:
# `_claim_next()`'s exclusion query only checked for an *unacked* claim (`c.acked_at IS
# NULL`), so a message whose claim had already been acked — i.e. successfully handled — read
# as claimable again, the moment reap_expired_claims() ran (which only deletes expired
# *unacked* rows, leaving the acked one in place, whose acked_at IS NULL is simply false and
# therefore excluded no one). A second `/claims/next` call on an already-completed message
# handed out a fresh claim instead of `{"claim": null}`. Fixed to exclude on "any claim row
# exists at all" — correct given reap already ran: every remaining row is either acked
# (terminal) or unacked-and-still-within-lease (in progress), and both cases mean "not
# claimable," not just the unacked one.
#
# 2.0.0 — Buzz 2.0 (HermesAgentV5/IMPLEMENTATION_PLAN.md S3): topic-based pub/sub with
# claim-based handoff, replacing targeted `to: sintra|amy` addressing, per target
# architecture §10.1. Four changes, one migration, zero breakage for live callers:
#
# 1. `messages.to_agent` -> `messages.topic` (renamed in place, existing rows preserved).
#    Sintra and Amy keep working unchanged through this release: each persona's own name is
#    still a valid topic (KNOWN_TOPICS), so "send to the other identity" is now just "publish
#    to a topic that happens to be named after her" — same UX, different primitive underneath.
#    New topics (dispatch/retrieve/screen/logs/code/vision/media/train/results) are allowed
#    from this version on, ahead of anything actually publishing to them — same
#    build-the-schema-ahead-of-the-consumer precedent S2 set for `hermes-memory`'s `tasks`
#    table. `results` needs no special code: it is just a topic every specialist eventually
#    publishes completion to, per target §10.1's "results path back through the dispatcher."
# 2. Two new nullable columns, `task_id` and `memory_ref` — the pointer envelope target §7.3
#    requires ("task ID + memory reference, never inline context"). Optional because nothing
#    generates real values yet (S6's dispatcher does); existing callers that don't send them
#    get NULL, which is correct, not a gap.
# 3. New `claims` table + `/claims/next` and `/claims/<id>/ack` — claim-based handoff (target
#    §10.1): the agent watching a topic picks up and acks, exactly one active claim per
#    message at a time, expired claims (no ack within the lease) are reclaimable — same
#    lease-and-reap shape hermes-broker.py's jobs table already established, applied to
#    messages instead of jobs. Nothing calls this yet either (a claim only matters once a
#    topic can have more than one subscriber, which is S6+), but the primitive needs to exist
#    now so S6 isn't retrofitting it onto live traffic.
# 4. **Backward-compatible response shape, deliberately, not an oversight:** every message row
#    in every response still carries `to_agent` (aliased to `topic`'s value) alongside the new
#    `topic` field, and `POST /messages` still accepts a `to` key as an alias for `topic`. This
#    is what let `hermes-buzz-watch.sh`, `hermes-buzz-lockup-check.sh`, and `hermes-buzz.sh`
#    ship with **zero code changes** across this migration — they read `.to_agent`/`.from_agent`
#    today and will keep doing so until someone deliberately moves them to `.topic`, at zero
#    urgency since both fields always agree. Sintra and Amy's hourly status exchange traffic
#    was live and unattended when this shipped; breaking it was not an acceptable cost of this
#    migration.
#
# hermes-buzz — the fleet's topic-based inter-agent channel (HermesAgentV5 S3; HermesAgentV4
# §7 Phase 32 for the 1.x targeted-addressing predecessor this replaces).
#
# The Boss observes traffic via a BuzzLog Matrix room this service mirrors every message into
# as @fleetops — the same bot-posted-room pattern hermes-broker.py already uses for job
# delivery — without being a participant in the conversation itself.
#
# Deliberately boring, same shape as hermes-broker.py: Python stdlib only (http.server +
# sqlite3), one file, one database, no new dependencies. Pull-based, not pushed: agents poll
# for messages on topics they watch rather than this service calling into any gateway, so a
# down/busy identity is not a failure — messages queue and are read whenever that watcher next
# polls.
#
# Config, all from the environment (injected by hermes-buzz-wrapper.sh, which fetches secrets
# from Vaultwarden and execs this — secrets never touch disk):
#   BUZZ_TOKEN           required — bearer token every publisher/subscriber presents
#   BUZZ_DB              default /mnt/hermes-data/buzz/messages.db
#   BUZZ_BIND            default 0.0.0.0
#   BUZZ_PORT            default 8101
#   BUZZ_CLAIM_LEASE_SECONDS  default 300 — an unacked claim older than this is reclaimable
#   MATRIX_HOMESERVER    default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN  optional — if unset, BuzzLog mirroring is skipped and messages
#                                     still send/poll normally
#   BUZZLOG_ROOM           optional — room to mirror traffic into
#
# The database lives inside the LUKS container, so this service will not start until
# hermes-unlock.sh has run after a reboot — same intended behaviour as hermes-broker.py and
# llama-sintra-core.service, not a defect.

import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("BUZZ_DB", "/mnt/hermes-data/buzz/messages.db")
BIND = os.environ.get("BUZZ_BIND", "0.0.0.0")
PORT = int(os.environ.get("BUZZ_PORT", "8101"))
TOKEN = os.environ.get("BUZZ_TOKEN", "")
CLAIM_LEASE_SECONDS = int(os.environ.get("BUZZ_CLAIM_LEASE_SECONDS", "300"))

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
BUZZLOG_ROOM = os.environ.get("BUZZLOG_ROOM", "")

MAX_BODY = 64 * 1024  # generous for a chat-shaped message, bounded

# Structural allowlists, not a prompt instruction — matches this project's standing
# preference (constraint 5) for enforcing things in code where practical.
#
# KNOWN_AGENTS: who may publish. `dispatch` added S6, `presenter` S7, `media` S10 — each
# publishes pointer envelopes/results as itself. Added proactively this time: S6 found the hard
# way that forgetting a new sender identity here crashes its caller.
KNOWN_AGENTS = {"sintra", "amy", "dispatch", "presenter", "media", "logs", "retrieve", "code", "screen", "websearch", "status", "probe"}
# KNOWN_TOPICS: what may be published to. The two persona names (so today's 1:1 traffic keeps
# working unchanged) plus target §4.4's internal topic set plus `results` (§10.1). Most of
# these have no subscriber yet — same ahead-of-the-consumer posture as hermes-memory's `tasks`
# table.
KNOWN_TOPICS = KNOWN_AGENTS | {
    "dispatch", "retrieve", "screen", "logs", "code", "vision", "media", "train", "results",
    "websearch", "status", "probe",
}

_db_lock = threading.Lock()


def log(msg):
    print(f"[hermes-buzz] {msg}", flush=True)


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with connect() as conn:
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(messages)")}
        if not existing:
            conn.execute(
                """CREATE TABLE messages (
                     seq          INTEGER PRIMARY KEY AUTOINCREMENT,
                     from_agent   TEXT NOT NULL,
                     topic        TEXT NOT NULL,
                     body         TEXT NOT NULL,
                     task_id      TEXT,
                     memory_ref   TEXT,
                     created_at   REAL NOT NULL
                   )"""
            )
            log("created messages table (topic schema)")
        else:
            # Migrating a live 1.x database in place — real Sintra/Amy conversation history,
            # never dropped or rebuilt. `ALTER TABLE ... RENAME COLUMN` requires SQLite
            # >=3.25; every node in this fleet is well past that.
            if "topic" not in existing and "to_agent" in existing:
                conn.execute("ALTER TABLE messages RENAME COLUMN to_agent TO topic")
                log("migrated messages.to_agent -> messages.topic")
            if "task_id" not in existing:
                conn.execute("ALTER TABLE messages ADD COLUMN task_id TEXT")
                log("added messages.task_id")
            if "memory_ref" not in existing:
                conn.execute("ALTER TABLE messages ADD COLUMN memory_ref TEXT")
                log("added messages.memory_ref")

        conn.execute("CREATE INDEX IF NOT EXISTS idx_topic_seq ON messages(topic, seq)")

        conn.execute(
            """CREATE TABLE IF NOT EXISTS claims (
                 id           INTEGER PRIMARY KEY AUTOINCREMENT,
                 seq          INTEGER NOT NULL,
                 topic        TEXT NOT NULL,
                 claimed_by   TEXT NOT NULL,
                 claimed_at   REAL NOT NULL,
                 acked_at     REAL,
                 expires_at   REAL NOT NULL
               )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_claims_seq ON claims(seq)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_claims_topic ON claims(topic, expires_at)")
    log(f"database ready at {DB_PATH}")


def row_to_message(row):
    d = dict(row)
    # Backward-compat alias — see 2.0.0 changelog above. Always equal to `topic`; never a
    # separate value. Keep until every caller has moved to `topic` and this can be dropped.
    d["to_agent"] = d["topic"]
    return d


def matrix_mirror(msg_row):
    """Mirror every Buzz message into BuzzLog as @fleetops, real-time Boss observability
    without the Boss being a participant — same bot-posted-room pattern hermes-broker.py
    already uses for job delivery."""
    if not FLEETOPS_TOKEN or not BUZZLOG_ROOM:
        return
    try:
        body = f"{msg_row['from_agent']} -> {msg_row['topic']}: {msg_row['body']}"
        txn = f"buzz-{msg_row['seq']}-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(BUZZLOG_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": body}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except Exception as exc:  # mirroring must never fail the send itself
        log(f"message {msg_row['seq']}: BuzzLog mirror failed: {exc}")


def reap_expired_claims(conn):
    """An unacked claim past its lease is not a stall — the claimant may be dead. Reclaimable
    immediately after, same lease-and-reap shape hermes-broker.py's jobs table already uses."""
    now = time.time()
    conn.execute("DELETE FROM claims WHERE acked_at IS NULL AND expires_at < ?", (now,))


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-buzz/2.0.6"

    def log_message(self, fmt, *args):
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, code, obj):
        blob = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _authed(self):
        presented = self.headers.get("Authorization", "")
        if hmac.compare_digest(presented, f"Bearer {TOKEN}"):
            return True
        self._send(401, {"error": "unauthorized"})
        return False

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("invalid Content-Length header")
        if length < 0 or length > MAX_BODY:
            raise ValueError(f"invalid or too-large body ({length} bytes)")
        return self.rfile.read(length)

    def _json_body(self):
        return json.loads(self._body() or b"{}")

    # ---- routes -------------------------------------------------------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"ok": True, "version": self.server_version})
            return
        if not self._authed():
            return

        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/messages/poll":
            self._poll(qs)
            return

        if parsed.path == "/messages":
            limit = min(int((qs.get("limit") or ["100"])[0]), 500)
            with connect() as conn:
                rows = conn.execute(
                    "SELECT seq,from_agent,topic,body,task_id,memory_ref,created_at FROM messages "
                    "ORDER BY seq DESC LIMIT ?", (limit,)
                ).fetchall()
            self._send(200, {"messages": [row_to_message(r) for r in rows]})
            return

        if parsed.path == "/claims":
            self._list_claims(qs)
            return

        self._send(404, {"error": "no such route"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._authed():
            return

        if parsed.path == "/messages":
            self._create_message()
            return

        if parsed.path == "/claims/next":
            self._claim_next()
            return

        if parsed.path.startswith("/claims/") and parsed.path.endswith("/ack"):
            self._ack_claim(parsed.path.split("/")[2])
            return

        self._send(404, {"error": "no such route"})

    # ---- operations -----------------------------------------------------

    def _poll(self, qs):
        # `topic` is the real parameter name; `agent` is accepted as an alias so
        # hermes-buzz.sh/hermes-buzz-watch.sh's existing `?agent=$ME` calls need no changes.
        topic = (qs.get("topic") or qs.get("agent") or [""])[0].strip().lower()
        if topic not in KNOWN_TOPICS:
            self._send(400, {"error": f"topic must be one of {sorted(KNOWN_TOPICS)}"})
            return
        try:
            since = int((qs.get("since") or ["0"])[0])
        except ValueError:
            self._send(400, {"error": "since must be an integer seq"})
            return
        limit = min(int((qs.get("limit") or ["50"])[0]), 200)
        with connect() as conn:
            rows = conn.execute(
                "SELECT seq,from_agent,topic,body,task_id,memory_ref,created_at FROM messages "
                "WHERE topic=? AND seq>? ORDER BY seq LIMIT ?",
                (topic, since, limit),
            ).fetchall()
        self._send(200, {"messages": [row_to_message(r) for r in rows]})

    def _create_message(self):
        try:
            payload = self._json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": f"bad body: {exc}"})
            return

        from_agent = str(payload.get("from", "")).strip().lower()
        # `topic` is the real field; `to` accepted as an alias — see 2.0.0 changelog.
        topic = str(payload.get("topic") or payload.get("to") or "").strip().lower()
        body = str(payload.get("body", "")).strip()
        task_id = payload.get("task_id")
        memory_ref = payload.get("memory_ref")

        if from_agent not in KNOWN_AGENTS:
            self._send(400, {"error": f"from must be one of {sorted(KNOWN_AGENTS)}"})
            return
        if topic not in KNOWN_TOPICS:
            self._send(400, {"error": f"topic/to must be one of {sorted(KNOWN_TOPICS)}"})
            return
        if not body and not (task_id and memory_ref):
            # A pure pointer envelope (task_id + memory_ref, target §7.3) carries no inline
            # content by design -- body is only required when there's no pointer to hydrate
            # from instead. Real gap found live during S6 verification: this check originally
            # required body unconditionally, which made a pointer-only publish impossible.
            self._send(400, {"error": "body is required unless both task_id and memory_ref are set"})
            return
        if len(body) > MAX_BODY:
            self._send(413, {"error": "body too large"})
            return

        created_at = time.time()
        with _db_lock, connect() as conn:
            cur = conn.execute(
                "INSERT INTO messages (from_agent,topic,body,task_id,memory_ref,created_at) "
                "VALUES (?,?,?,?,?,?)",
                (from_agent, topic, body, task_id, memory_ref, created_at),
            )
            seq = cur.lastrowid
        log(f"message {seq}: {from_agent} -> {topic} ({len(body)} chars)")
        matrix_mirror({"seq": seq, "from_agent": from_agent, "topic": topic, "body": body})
        self._send(201, {"seq": seq, "created_at": created_at})

    def _claim_next(self):
        try:
            payload = self._json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": f"bad body: {exc}"})
            return

        topic = str(payload.get("topic", "")).strip().lower()
        claimant = str(payload.get("claimant", "")).strip()
        if topic not in KNOWN_TOPICS:
            self._send(400, {"error": f"topic must be one of {sorted(KNOWN_TOPICS)}"})
            return
        if not claimant:
            self._send(400, {"error": "claimant is required"})
            return

        now = time.time()
        with _db_lock, connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            reap_expired_claims(conn)
            # reap_expired_claims() just deleted every unacked-and-expired claim row, so
            # whatever claim rows remain for a seq are either acked (done — terminal, never
            # reclaimable) or unacked-and-still-within-lease (in progress — not reclaimable
            # either). Either way, "any claim row still exists" is the correct exclusion —
            # NOT "any *unacked* claim row exists", which would make an acked (successfully
            # handled) message look claimable again the moment its claim carried acked_at set.
            # Real bug, caught live during S3 verification: a second claim on an already-acked
            # message returned a fresh claim instead of nothing.
            row = conn.execute(
                "SELECT m.seq, m.from_agent, m.topic, m.body, m.task_id, m.memory_ref, m.created_at "
                "FROM messages m WHERE m.topic=? AND NOT EXISTS ("
                "  SELECT 1 FROM claims c WHERE c.seq=m.seq"
                ") ORDER BY m.seq LIMIT 1",
                (topic,),
            ).fetchone()
            if not row:
                conn.execute("COMMIT")
                self._send(200, {"claim": None})
                return
            cur = conn.execute(
                "INSERT INTO claims (seq,topic,claimed_by,claimed_at,expires_at) VALUES (?,?,?,?,?)",
                (row["seq"], topic, claimant, now, now + CLAIM_LEASE_SECONDS),
            )
            claim_id = cur.lastrowid
            conn.execute("COMMIT")

        log(f"claim {claim_id}: message {row['seq']} (topic {topic}) claimed by {claimant}")
        self._send(200, {"claim": {"id": claim_id, "message": row_to_message(row),
                                    "expires_at": now + CLAIM_LEASE_SECONDS}})

    def _ack_claim(self, claim_id):
        try:
            claim_id = int(claim_id)
        except ValueError:
            self._send(400, {"error": "invalid claim id"})
            return
        try:
            payload = self._json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": f"bad body: {exc}"})
            return
        claimant = str(payload.get("claimant", "")).strip()

        with _db_lock, connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
            if not row:
                conn.execute("COMMIT")
                self._send(404, {"error": "no such claim"})
                return
            if row["claimed_by"] != claimant:
                conn.execute("COMMIT")
                self._send(403, {"error": "claim belongs to a different claimant"})
                return
            if row["acked_at"] is not None:
                conn.execute("COMMIT")
                self._send(200, {"id": claim_id, "already_acked": True})
                return
            if row["expires_at"] < time.time():
                conn.execute("COMMIT")
                self._send(409, {"error": "claim already expired and may have been reclaimed"})
                return
            conn.execute("UPDATE claims SET acked_at=? WHERE id=?", (time.time(), claim_id))
            conn.execute("COMMIT")
        log(f"claim {claim_id}: acked by {claimant}")
        self._send(200, {"id": claim_id, "acked": True})

    def _list_claims(self, qs):
        topic = (qs.get("topic") or [None])[0]
        with connect() as conn:
            if topic:
                rows = conn.execute(
                    "SELECT * FROM claims WHERE topic=? ORDER BY claimed_at DESC LIMIT 100",
                    (topic,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM claims ORDER BY claimed_at DESC LIMIT 100"
                ).fetchall()
        self._send(200, {"claims": [dict(r) for r in rows]})


def main():
    if not TOKEN:
        sys.exit("BUZZ_TOKEN is required — this service must not run unauthenticated")
    init_db()
    if not FLEETOPS_TOKEN or not BUZZLOG_ROOM:
        log("WARNING: @fleetops Matrix account not configured — messages will send "
            "and poll normally, but nothing will be mirrored to BuzzLog")
    log(f"listening on {BIND}:{PORT}, db at {DB_PATH}")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
