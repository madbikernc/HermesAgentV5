#!/usr/bin/env python3
# Version: 1.2.0
#
# 1.2.0 — HermesAgentV5 S9: new `model_registry` table + `/models` API. Keyed on (node, path) —
# one row per physical file, multiple rows share a `role` for multi-file backends (omni's GGUF +
# mmproj). The index this stage's plan text calls for over `hermes-model-archive.py` (NAS2
# archival, byte-verified sha256) and `hermes-model-scan.py` (release watching) — not a new
# system, the missing queryable layer over what those two already track.
#
# 1.1.1 — two real bugs found live during S7's own verification, hours apart, the first
# masquerading as the second's cause:
# (1) `turns.id` was a plain `INTEGER PRIMARY KEY` (bare ROWID alias, free to reuse a deleted
#     row's id) even though `vec_turns.turn_id` implicitly assumes that id is never reused. A
#     row deleted during earlier-stage test cleanup, followed by a fresh insert that happened to
#     get the same reused id, collided with an orphaned `vec_turns` entry and raised `UNIQUE
#     constraint failed`. Fixed to real `AUTOINCREMENT`, migrated in place (existing rows'
#     ids preserved).
# (2) That exception was uncaught, so the request died with zero bytes written to the socket —
#     from the *caller's* side (hermes-presenter.py's Matrix sync loop, nowhere near the actual
#     bug) this looked exactly like "Remote end closed connection," sending a real investigation
#     down the wrong path for a while before the traceback was read directly from this service's
#     own journal. `do_GET`/`do_POST` now wrap every route in a handler that always sends *some*
#     HTTP response, even a 500, so a bug here is visible as an error from this service, not a
#     silent dead connection blamed on whoever happened to be calling it.
#
# 1.1.0 — HermesAgentV5 S7: added `GET /state/<agent>` (no key) to list every key an agent
# holds. `hermes-presenter.py` needs to enumerate its own outstanding tasks (which Matrix
# room/event to reply into once a task completes) across a restart — an in-memory index alone
# would silently lose that mapping the moment the process restarted.
#
# hermes-memory — the fleet's shared memory service (HermesAgentV5/IMPLEMENTATION_PLAN.md S2).
#
# V5's answer to target §7 (Memory Continuity), built in the shape of hermes-broker.py rather
# than the target's proposed Postgres+pgvector, per V5 IMPLEMENTATION_PLAN.md §3.1: the fleet
# already solves cross-node shared state with a single-writer SQLite file behind an authenticated
# HTTP service (broker's jobs.db, RAG's vectors.db), and that pattern already has auth,
# observability, and graceful degradation solved. This is that pattern applied to memory.
#
# Replaces hermes-session-cap-guard.sh's wipe-and-summarise behaviour, which existed only because
# there was no memory (V4 S11). Do not retire that guard until recall against this service is
# verified per the bar below — V4 S11 already found `nano` fabricating successful memory writes
# with zero backing evidence, twice, so "an agent says recall works" is not evidence it does.
#
# Deliberately boring, same four words as the broker's own header: Python stdlib only
# (http.server + sqlite3) plus sqlite-vec for the one thing stdlib can't do — vector search —
# loaded as a SQLite extension, not a service of its own. One file, one database.
#
# Four tables, mirroring the target's actual requirements rather than the target's assumed
# substrate:
#   - turns        Dual-channel conversational memory (target §7.4): raw and presented content
#                   stored separately, linked by task_id. The dispatcher-to-be (S6) reads raw;
#                   Matrix always saw presented. Every turn's raw text is embedded into vec_turns
#                   at write time for semantic recall.
#   - tasks         Handoff records for the pointer-not-payload invariant (target §7.3): a Buzz
#                   envelope carries {task_id, memory_ref}, never inline context. Schema exists
#                   from S2 on; nothing populates it for real until S3 (Buzz 2.0) and S6
#                   (hermes-dispatch) exist to generate real dispatcher task IDs. Until then,
#                   task_id in `turns` is just an opaque grouping key any caller may supply
#                   (e.g. a session id) — turns are not FK-constrained against a `tasks` row.
#   - agent_state   Small persistent key/value per agent, same shape as
#                   hermes_rag_common.py's get_state()/set_state() (no fifth new store).
#   - vec_turns     sqlite-vec virtual table over turns.raw, same vec0 pattern as
#                   hermes_rag_common.py's vec_chunks — embeddings via the already-running
#                   `embed` backend (127.0.0.1:8092), never re-implemented per caller.
#
# Config, all from the environment (injected by hermes-memory-wrapper.sh, which fetches
# MEMORY_TOKEN from Vaultwarden and execs this — same pattern as every other secret in this
# fleet, never touches disk):
#   MEMORY_TOKEN       required — bearer token clients must present
#   MEMORY_DB          default /mnt/hermes-data/memory/memory.db
#   MEMORY_BIND        default 0.0.0.0 (the systemd unit binds this explicitly to spark's LAN
#                      IP, same plane-discipline precedent as hermes-broker.service)
#   MEMORY_PORT        default 8102
#   MEMORY_EMBED_URL   default http://127.0.0.1:8092/v1/embeddings — same resident backend and
#                      port hermes_rag_common.py already calls, deliberately not routed through
#                      hermes-router.py (this is infrastructure calling a fixed local capability,
#                      not a persona's conversational turn)
#   MEMORY_EMBED_DIMS  default 1024 — must match the resident embed backend's actual output size
#
# The database lives inside the LUKS container, so this service will not start until
# hermes-unlock.sh has run after a reboot — same intended behaviour as the broker and RAG.

import hashlib
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
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DB_PATH = Path(os.environ.get("MEMORY_DB", "/mnt/hermes-data/memory/memory.db"))
BIND = os.environ.get("MEMORY_BIND", "0.0.0.0")
PORT = int(os.environ.get("MEMORY_PORT", "8102"))
TOKEN = os.environ.get("MEMORY_TOKEN", "")

EMBED_URL = os.environ.get("MEMORY_EMBED_URL", "http://127.0.0.1:8092/v1/embeddings")
EMBED_DIMS = int(os.environ.get("MEMORY_EMBED_DIMS", "1024"))
EMBED_TIMEOUT = 30

MAX_BODY = 8 * 1024 * 1024  # 8MB — generous for a turn's text, bounded

TASK_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    agent       TEXT NOT NULL,
    topic       TEXT,
    state       TEXT NOT NULL DEFAULT 'open',
    memory_ref  TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    agent       TEXT NOT NULL,
    role        TEXT NOT NULL,
    raw         TEXT NOT NULL,
    presented   TEXT,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_agent ON turns(agent, created_at);

CREATE TABLE IF NOT EXISTS agent_state (
    agent       TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  REAL NOT NULL,
    PRIMARY KEY (agent, key)
);

CREATE TABLE IF NOT EXISTS model_registry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    role          TEXT,
    hf_id         TEXT NOT NULL,
    revision      TEXT,
    node          TEXT NOT NULL,
    path          TEXT NOT NULL,
    size_bytes    INTEGER,
    sha256        TEXT,
    abliterated   INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active',
    archived_nas2 INTEGER NOT NULL DEFAULT 0,
    eval_ref      TEXT,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL,
    UNIQUE(node, path)
);
CREATE INDEX IF NOT EXISTS idx_registry_role ON model_registry(role);
"""

VEC_TABLE_SQL = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS vec_turns "
    "USING vec0(turn_id INTEGER PRIMARY KEY, embedding float[{dims}])"
)

_db_lock = threading.Lock()


def log(msg):
    print(f"[hermes-memory] {msg}", flush=True)


def _migrate_turns_autoincrement(conn):
    """`turns.id` shipped as plain `INTEGER PRIMARY KEY` (1.0.0), which SQLite treats as a bare
    ROWID alias — free to reuse a deleted row's id for the next insert. `vec_turns.turn_id`
    implicitly assumes a stable 1:1 relationship with `turns.id` that never happens twice, so a
    reused id collides with an old, orphaned `vec_turns` row from an earlier delete and crashes
    the request with a `UNIQUE constraint failed` — found live during S7's own verification,
    manifesting as a mysteriously dead connection on the *caller* (hermes-presenter.py's Matrix
    sync loop), nowhere near where the actual bug was. Real `AUTOINCREMENT` (1.1.0+) fixes this
    at the schema level: SQLite tracks the historical max id in `sqlite_sequence` and never
    reuses it, matching what `vec_turns` was already implicitly assuming."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'"
    ).fetchone()
    if row is None or "AUTOINCREMENT" in row[0]:
        return  # fresh DB (SCHEMA below creates it right) or already migrated
    conn.execute("ALTER TABLE turns RENAME TO turns_old")
    conn.execute(
        """CREATE TABLE turns (
             id          INTEGER PRIMARY KEY AUTOINCREMENT,
             task_id     TEXT NOT NULL,
             agent       TEXT NOT NULL,
             role        TEXT NOT NULL,
             raw         TEXT NOT NULL,
             presented   TEXT,
             created_at  REAL NOT NULL
           )"""
    )
    conn.execute(
        "INSERT INTO turns (id, task_id, agent, role, raw, presented, created_at) "
        "SELECT id, task_id, agent, role, raw, presented, created_at FROM turns_old"
    )
    conn.execute("DROP TABLE turns_old")
    log("migrated turns.id to real AUTOINCREMENT")


def connect(readonly=False):
    """Open the memory store with the sqlite-vec extension loaded. Raises if sqlite_vec isn't
    importable — callers must run under an interpreter that has it (this service's systemd unit
    invokes /opt/hermes/venvs/rag/bin/python3, the same interpreter path hermes-rag's own
    ingestion services already use — its bin/python3 is a symlink to the system interpreter, but
    invoking it via that path is what makes Python discover the venv's pyvenv.cfg and site-packages;
    invoking /usr/bin/python3 directly does not see sqlite_vec)."""
    import sqlite_vec  # deferred import: gives a clear error if run under the wrong interpreter

    if readonly:
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=30)
    else:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA busy_timeout=30000")
    if not readonly:
        conn.execute("PRAGMA journal_mode=WAL")
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    if not readonly:
        conn.executescript(SCHEMA)
        _migrate_turns_autoincrement(conn)
        conn.execute(VEC_TABLE_SQL.format(dims=EMBED_DIMS))
        conn.commit()
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with connect():
        pass
    log(f"database ready at {DB_PATH}")


def embed(text: str) -> list:
    """Call the resident query-time embedding backend. Raises on any failure rather than
    returning a zero vector — a silently-wrong embedding is worse than a loud failure, same
    principle hermes_rag_common.py's own embed() already established."""
    payload = json.dumps({"input": text}).encode("utf-8")
    req = urllib.request.Request(
        EMBED_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=EMBED_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise RuntimeError(f"embedding backend at {EMBED_URL} unreachable: {e}") from e
    vec = body["data"][0]["embedding"]
    if len(vec) != EMBED_DIMS:
        raise RuntimeError(f"embedding backend returned {len(vec)} dims, expected {EMBED_DIMS}")
    return vec


def pack_vec(vec: list) -> bytes:
    import sqlite_vec

    return sqlite_vec.serialize_float32(vec)


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-memory/1.2.0"

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
        self._dispatch(self._route_GET)

    def do_POST(self):
        self._dispatch(self._route_POST)

    def _dispatch(self, route):
        """Every route method below can raise on a genuine bug (a DB constraint violation, a
        malformed row) — without this wrapper, an uncaught exception mid-request leaves the
        socket open with zero bytes written, which the *caller* sees as a dead connection with
        no error at all ("Empty reply from server" / "Remote end closed connection"), nothing
        indicating this service is even where the problem is. Real bug found live during S7's
        own verification: a `UNIQUE constraint failed` in `_create_turn()` did exactly this,
        and every symptom pointed at the *caller's* Matrix connection until the traceback was
        read directly from this service's own journal. Same principle as this file's own
        best-effort logging calls: a failure here must be visible, not silent — just as an HTTP
        response, not just a log line."""
        try:
            route()
        except Exception as exc:
            log(f"unhandled error in {self.command} {self.path}: {exc}")
            try:
                self._send(500, {"error": f"internal error: {exc}"})
            except Exception:
                pass  # response may already be partially written; nothing more to do

    def _route_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"ok": True, "version": self.server_version})
            return
        if not self._authed():
            return

        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/turns":
            self._list_turns(qs)
            return

        if parsed.path == "/turns/search":
            self._search_turns(qs)
            return

        if parsed.path.startswith("/tasks/"):
            self._get_task(parsed.path.split("/")[2])
            return

        if parsed.path.startswith("/state/"):
            parts = parsed.path.split("/")
            if len(parts) == 4:
                self._get_state(parts[2], parts[3])
                return
            if len(parts) == 3:
                self._list_state(parts[2])
                return

        if parsed.path == "/models":
            self._list_models(qs)
            return

        if parsed.path.startswith("/models/"):
            self._get_model(parsed.path.split("/")[2])
            return

        self._send(404, {"error": "no such route"})

    def _route_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._authed():
            return

        if parsed.path == "/turns":
            self._create_turn()
            return

        if parsed.path == "/tasks":
            self._upsert_task()
            return

        if parsed.path == "/state":
            self._set_state()
            return

        if parsed.path == "/models":
            self._upsert_model()
            return

        self._send(404, {"error": "no such route"})

    # ---- operations -----------------------------------------------------

    def _create_turn(self):
        try:
            payload = self._json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": f"bad body: {exc}"})
            return

        task_id = payload.get("task_id")
        agent = payload.get("agent")
        role = payload.get("role")
        raw = payload.get("raw")
        presented = payload.get("presented")

        if not (task_id and agent and role and raw):
            self._send(400, {"error": "task_id, agent, role, and raw are required"})
            return
        if not TASK_ID_RE.match(task_id):
            self._send(400, {"error": "invalid task_id (must match ^[A-Za-z0-9_.:-]{1,128}$)"})
            return

        try:
            vec = embed(raw)
        except RuntimeError as exc:
            self._send(502, {"error": str(exc)})
            return

        now = time.time()
        with _db_lock, connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                "INSERT INTO turns (task_id, agent, role, raw, presented, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (task_id, agent, role, raw, presented, now),
            )
            turn_id = cur.lastrowid
            conn.execute(
                "INSERT INTO vec_turns (turn_id, embedding) VALUES (?, ?)",
                (turn_id, pack_vec(vec)),
            )
            conn.execute("COMMIT")

        log(f"turn {turn_id} recorded (task {task_id}, agent {agent}, role {role})")
        self._send(201, {"id": turn_id, "task_id": task_id})

    def _list_turns(self, qs):
        task_id = (qs.get("task_id") or [None])[0]
        agent = (qs.get("agent") or [None])[0]
        try:
            limit = min(int((qs.get("limit") or ["50"])[0]), 500)
        except ValueError:
            self._send(400, {"error": "invalid limit"})
            return
        if not task_id and not agent:
            self._send(400, {"error": "task_id or agent is required"})
            return

        clauses, params = [], []
        if task_id:
            clauses.append("task_id = ?")
            params.append(task_id)
        if agent:
            clauses.append("agent = ?")
            params.append(agent)
        where = " AND ".join(clauses)
        params.append(limit)

        with connect(readonly=True) as conn:
            rows = conn.execute(
                f"SELECT id, task_id, agent, role, raw, presented, created_at FROM turns "
                f"WHERE {where} ORDER BY created_at DESC LIMIT ?",
                params,
            ).fetchall()
        self._send(200, {"turns": [dict(r) for r in reversed(rows)]})

    def _search_turns(self, qs):
        q = (qs.get("q") or [None])[0]
        if not q:
            self._send(400, {"error": "q is required"})
            return
        agent = (qs.get("agent") or [None])[0]
        task_id = (qs.get("task_id") or [None])[0]
        try:
            top_k = min(int((qs.get("top_k") or ["5"])[0]), 50)
        except ValueError:
            self._send(400, {"error": "invalid top_k"})
            return

        try:
            vec = embed(q)
        except RuntimeError as exc:
            self._send(502, {"error": str(exc)})
            return
        packed = pack_vec(vec)

        widen = 1
        if agent:
            widen *= 4
        if task_id:
            widen *= 4

        with connect(readonly=True) as conn:
            rows = conn.execute(
                "SELECT t.id, t.task_id, t.agent, t.role, t.raw, t.presented, t.created_at, "
                "v.distance FROM vec_turns v JOIN turns t ON t.id = v.turn_id "
                "WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance",
                [packed, top_k * widen],
            ).fetchall()

        if agent:
            rows = [r for r in rows if r["agent"] == agent]
        if task_id:
            rows = [r for r in rows if r["task_id"] == task_id]
        rows = rows[:top_k]

        self._send(200, {"turns": [dict(r) for r in rows]})

    def _upsert_task(self):
        try:
            payload = self._json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": f"bad body: {exc}"})
            return

        agent = payload.get("agent")
        if not agent:
            self._send(400, {"error": "agent is required"})
            return
        task_id = payload.get("id") or uuid.uuid4().hex[:12]
        if not TASK_ID_RE.match(task_id):
            self._send(400, {"error": "invalid id (must match ^[A-Za-z0-9_.:-]{1,128}$)"})
            return
        topic = payload.get("topic")
        state = payload.get("state", "open")
        memory_ref = payload.get("memory_ref")
        now = time.time()

        with _db_lock, connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
            if existing:
                conn.execute(
                    "UPDATE tasks SET agent=?, topic=?, state=?, memory_ref=?, updated_at=? "
                    "WHERE id=?",
                    (agent, topic, state, memory_ref, now, task_id),
                )
            else:
                conn.execute(
                    "INSERT INTO tasks (id, agent, topic, state, memory_ref, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (task_id, agent, topic, state, memory_ref, now, now),
                )
            conn.execute("COMMIT")

        log(f"task {task_id} -> {state} (agent {agent})")
        self._send(200, {"id": task_id, "state": state})

    def _get_task(self, task_id):
        with connect(readonly=True) as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            self._send(404, {"error": "no such task"})
            return
        self._send(200, dict(row))

    def _set_state(self):
        try:
            payload = self._json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": f"bad body: {exc}"})
            return

        agent, key, value = payload.get("agent"), payload.get("key"), payload.get("value")
        if not (agent and key) or value is None:
            self._send(400, {"error": "agent, key, and value are required"})
            return

        with _db_lock, connect() as conn:
            conn.execute(
                "INSERT INTO agent_state (agent, key, value, updated_at) VALUES (?,?,?,?) "
                "ON CONFLICT(agent, key) DO UPDATE SET value=excluded.value, "
                "updated_at=excluded.updated_at",
                (agent, key, json.dumps(value), time.time()),
            )
        self._send(200, {"agent": agent, "key": key})

    def _get_state(self, agent, key):
        with connect(readonly=True) as conn:
            row = conn.execute(
                "SELECT value, updated_at FROM agent_state WHERE agent=? AND key=?", (agent, key)
            ).fetchone()
        if not row:
            self._send(404, {"error": "no such key"})
            return
        self._send(200, {"agent": agent, "key": key, "value": json.loads(row["value"]),
                          "updated_at": row["updated_at"]})

    def _list_state(self, agent):
        """List every key an agent holds — added S7 so a caller (hermes-presenter.py tracking
        its own outstanding tasks) can enumerate its state across a restart instead of needing
        an in-memory index that a restart would silently lose."""
        with connect(readonly=True) as conn:
            rows = conn.execute(
                "SELECT key, value, updated_at FROM agent_state WHERE agent=? ORDER BY updated_at",
                (agent,),
            ).fetchall()
        self._send(200, {"agent": agent, "state": [
            {"key": r["key"], "value": json.loads(r["value"]), "updated_at": r["updated_at"]}
            for r in rows
        ]})

    # ---- model registry (S9) -------------------------------------------

    def _upsert_model(self):
        """Keyed on (node, path) — the natural identity of one physical file on one node. A
        role backed by multiple files (e.g. omni's GGUF + its mmproj) gets one row per file,
        same `role` value on each. Re-posting the same (node, path) updates in place rather than
        duplicating — this is how a re-run of a registry sync script stays idempotent."""
        try:
            payload = self._json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": f"bad body: {exc}"})
            return

        hf_id, node, path = payload.get("hf_id"), payload.get("node"), payload.get("path")
        if not (hf_id and node and path):
            self._send(400, {"error": "hf_id, node, and path are required"})
            return

        now = time.time()
        fields = {
            "role": payload.get("role"),
            "hf_id": hf_id,
            "revision": payload.get("revision"),
            "node": node,
            "path": path,
            "size_bytes": payload.get("size_bytes"),
            "sha256": payload.get("sha256"),
            "abliterated": int(bool(payload.get("abliterated", False))),
            "status": payload.get("status", "active"),
            "archived_nas2": int(bool(payload.get("archived_nas2", False))),
            "eval_ref": payload.get("eval_ref"),
        }

        with _db_lock, connect() as conn:
            existing = conn.execute(
                "SELECT id FROM model_registry WHERE node=? AND path=?", (node, path)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE model_registry SET role=?, hf_id=?, revision=?, size_bytes=?, "
                    "sha256=?, abliterated=?, status=?, archived_nas2=?, eval_ref=?, updated_at=? "
                    "WHERE id=?",
                    (fields["role"], fields["hf_id"], fields["revision"], fields["size_bytes"],
                     fields["sha256"], fields["abliterated"], fields["status"],
                     fields["archived_nas2"], fields["eval_ref"], now, existing["id"]),
                )
                model_id = existing["id"]
            else:
                cur = conn.execute(
                    "INSERT INTO model_registry (role, hf_id, revision, node, path, size_bytes, "
                    "sha256, abliterated, status, archived_nas2, eval_ref, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (fields["role"], fields["hf_id"], fields["revision"], node, path,
                     fields["size_bytes"], fields["sha256"], fields["abliterated"],
                     fields["status"], fields["archived_nas2"], fields["eval_ref"], now, now),
                )
                model_id = cur.lastrowid
        self._send(200, {"id": model_id, "node": node, "path": path})

    def _list_models(self, qs):
        clauses, params = [], []
        for field in ("role", "node", "status"):
            val = (qs.get(field) or [None])[0]
            if val:
                clauses.append(f"{field}=?")
                params.append(val)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with connect(readonly=True) as conn:
            rows = conn.execute(
                f"SELECT * FROM model_registry {where} ORDER BY role, node", params
            ).fetchall()
        self._send(200, {"models": [dict(r) for r in rows]})

    def _get_model(self, model_id):
        with connect(readonly=True) as conn:
            row = conn.execute("SELECT * FROM model_registry WHERE id=?", (model_id,)).fetchone()
        if not row:
            self._send(404, {"error": "no such model"})
            return
        self._send(200, dict(row))


def main():
    if not TOKEN:
        sys.exit("MEMORY_TOKEN is required — this service must not run unauthenticated")
    init_db()
    log(f"listening on {BIND}:{PORT}, db at {DB_PATH}, embeddings via {EMBED_URL}")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
