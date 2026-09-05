#!/usr/bin/env python3
# Version: 1.4.0
#
# 1.4.0 (2026-09-05) — `/jobs/claim` gains an optional `roles` filter (comma-separated), applied as
# `json_extract(payload,'$.role') IN (...)` — prep for `coder2`'s `hermes-model-wake-worker.py`
# instance on spark-2, which polls the same central `type=wake` queue as spark's own instance but
# can only ever serve `coder2`. Without this, a cross-node worker racing for the same queue could
# claim a job meant for a role it doesn't recognize, report a real failure, and burn a MAX_ATTEMPTS
# slot plus a full poll cycle of latency for the role that actually needed to wake -- not a
# guaranteed break (`_result()` already requeues on non-zero-exit-no-artifact rather than
# dead-lettering immediately) but a real, avoidable tax on unrelated wake latency. Backward
# compatible: absent/empty `roles` claims exactly as before, so the existing spark worker needs no
# code change to keep working, though it should also pass its own `WAKE_TARGETS` keys once updated.
#
# 1.3.0 (2026-08-30) — new GET /jobs/{id}/artifact route, streaming a completed job's raw
# artifact bytes. Added for hermes-media.py's own generate->evaluate->regenerate loop (target
# §9.2): that agent runs on spark-2, this broker (and its LUKS-mounted ARTIFACT_DIR) runs on
# spark, and no route existed to move artifact bytes between them at all — confirmed by reading
# every existing GET route (/jobs, /jobs/claim, /jobs/{id}, /jobs/{id}/result), none of which
# serve raw bytes, only JSON metadata. Bearer-authed like every other route; re-validates the
# stored artifact path resolves inside ARTIFACT_DIR before serving, defense in depth on top of
# 1.1.0's write-side path-traversal fix even though `artifact` should never contain a path
# outside it already. 404s (not an error) for a job with no artifact or one still in flight.
#
# 1.2.1 — real bug found 2026-08-21 while adding a second artifact-less job type (remediate,
# alongside the existing wake): `_result()`'s state-transition only ever set `done` when
# `exit_code == 0 AND artifact_path` -- but `artifact_path` stays `None` for any job whose worker
# never uploads a blob (an empty `data=b""` report, which is exactly how wake jobs and now
# remediate jobs report success). A genuinely successful artifact-less job fell through to the
# same `queued`/`dead` branches a real failure would, meaning it could never reach `done` at all
# — only get silently re-run until MAX_ATTEMPTS was exhausted and it was marked `dead` despite
# having actually worked. Fixed to treat an empty body as that job's own signal that no artifact
# was ever expected, not evidence of failure — `artifact_path or not blob` instead of just
# `artifact_path`. Render/video/embed jobs are unaffected: they always exit 0 with a real blob on
# success, never with an empty one, so this only changes behavior for the artifact-less case.
#
# 1.2.0 — Phase 30c: new BROKER_QUIET_TYPES (default "embed") skips Matrix
# delivery/notice for that job type's results. Every prior job type (image,
# video) existed specifically to produce something worth putting in front of
# a human in FleetOps; an embed job's "artifact" is a raw JSON vector blob,
# and there are thousands of them during a podcast-archive backfill — would
# have flooded FleetOps with meaningless file messages. The job is still
# recorded in jobs.db exactly like any other (state, attempts, artifact path)
# — only the Matrix side is skipped, and only for types explicitly listed.
#
# 1.1.0 — five fixes from a security review:
# (1) Path traversal: neither the caller-supplied job `id` (POST /jobs) nor
#     the worker-supplied `X-Filename` header were validated. A crafted id
#     containing `..` (accepted at creation, then referenced again in
#     POST /jobs/<id>/result) or a crafted filename could write outside
#     ARTIFACT_DIR — as far as the broker's own database file, or a script
#     later executed as pmoney. Fixed with a strict id allowlist (checked at
#     creation and again in _result(), so a future insertion path can't
#     silently reopen it) and filename sanitization that survives a bare
#     ".."  surviving os.path.basename() unchanged.
# (2) Race condition: _result() read-then-wrote job state with no lock and
#     no check that the job was still 'running' — unlike _claim(), which
#     already does this correctly. A job whose lease expired (reaped back to
#     'queued') could still have its stale result accepted, potentially
#     resurrecting an already dead-lettered job or double-delivering to
#     Matrix. Fixed with the same _db_lock + BEGIN IMMEDIATE pattern
#     _claim() uses, the transition conditioned on WHERE state='running',
#     and a 409 response if the row already moved on.
# (3) Bearer token comparison used Python's `==`, which short-circuits on
#     the first mismatched byte — a timing side channel an attacker on the
#     same network segment could use to recover BROKER_TOKEN. Fixed with
#     hmac.compare_digest().
# (4) A malformed or negative Content-Length bypassed the MAX_BODY cap
#     entirely (`-1 > MAX_BODY` is False), allowing an unbounded read.
#     Fixed to reject any non-numeric or negative value.
# (Lease timeout for video jobs — BROKER_LEASE_SECONDS' 900s default was
# shorter than a real 121-frame job's ~1415s measured runtime, so
# reap_expired_leases() could requeue a video job while its worker was still
# legitimately mid-render. The lease applies fleet-wide to every job type —
# there is no per-type override in this design — so the fix is raising the
# single global default in infra/hermes-broker/hermes-broker.service's own
# environment, not here: zero broker code changes needed. Trade-off accepted
# deliberately: a genuinely crashed image-job worker now takes longer to be
# noticed and reaped, in exchange for the lease meaning what it claims to
# mean for every job type, not just the fast ones.)
#
# hermes-broker — the fleet's execution plane (IMPLEMENTATION_PLAN.md §4c, Stage 1).
#
# A durable job queue that carries work between nodes, so that no LLM's
# conversational turn is ever load-bearing for a mechanical action. See
# LESSONS_LEARNED.md §2 for the four incidents that produced this design.
#
# Deliberately boring: Python stdlib only (http.server + sqlite3), one file,
# one database, no new dependencies on either node.
#
# Four properties that carry the reliability requirement:
#   1. Workers PULL. A node that is down is not a failure — jobs queue and drain
#      when it returns. HomeD13 needs a console passphrase on every boot and will
#      not come back on its own, so push would be a hard failure at request time.
#   2. Results are recorded from real process output — exit code, artifact bytes,
#      sha256 — written by the worker, never by a model (§5 constraint 6).
#   3. The broker delivers artifacts to Matrix itself, as @fleetops:spark. An LLM
#      cannot claim work happened, because an LLM is not the thing reporting.
#   4. Claims are leased. A worker that dies mid-job does not strand the job.
#
# Config, all from the environment (injected by hermes-broker-wrapper.sh, which
# fetches secrets from Vaultwarden and execs this — secrets never touch disk):
#   BROKER_TOKEN            required — bearer token clients and workers must present
#   BROKER_DB               default /mnt/hermes-data/broker/jobs.db
#   BROKER_ARTIFACTS        default /mnt/hermes-data/broker/artifacts
#   BROKER_BIND             default 0.0.0.0
#   BROKER_PORT             default 8100
#   BROKER_LEASE_SECONDS    default 900   — a claim older than this returns to queued
#   BROKER_MAX_ATTEMPTS     default 3     — then dead-letter
#   MATRIX_HOMESERVER       default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN   optional — if unset, delivery is skipped with a warning
#                                      and jobs still complete normally
#   FLEETOPS_ROOM           optional — room to deliver into
#   BROKER_QUIET_TYPES      default "embed" — comma-separated job types whose
#                                      results never go to Matrix. Added for
#                                      Phase 30c: an embed job's "artifact" is
#                                      a raw JSON vector blob, not something
#                                      meant for a human to see land in
#                                      FleetOps as a file message, unlike
#                                      every render/video job so far. Still
#                                      recorded in jobs.db exactly like any
#                                      other job — only the Matrix side is
#                                      skipped.
#
# The database lives inside the LUKS container, so this service will not start
# until `hermes-unlock.sh` has run after a reboot — the same behaviour
# llama-sintra-core already has, and intended, not a defect.

import hashlib
import hmac
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("BROKER_DB", "/mnt/hermes-data/broker/jobs.db")
ARTIFACT_DIR = os.environ.get("BROKER_ARTIFACTS", "/mnt/hermes-data/broker/artifacts")
BIND = os.environ.get("BROKER_BIND", "0.0.0.0")
PORT = int(os.environ.get("BROKER_PORT", "8100"))
LEASE_SECONDS = int(os.environ.get("BROKER_LEASE_SECONDS", "900"))
MAX_ATTEMPTS = int(os.environ.get("BROKER_MAX_ATTEMPTS", "3"))
TOKEN = os.environ.get("BROKER_TOKEN", "")

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")
QUIET_TYPES = {t.strip() for t in os.environ.get("BROKER_QUIET_TYPES", "embed").split(",") if t.strip()}

MAX_BODY = 256 * 1024 * 1024  # 256MB — generous for a video artifact, bounded

# Job ids are either server-generated (uuid4 hex) or caller-supplied for
# dedup — either way, restricted to a safe charset before ever reaching a
# filesystem path (ARTIFACT_DIR/<id>/...) or a SQL parameter.
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Worker-supplied artifact filenames, sanitized to a safe charset. Applied
# after os.path.basename() (which alone is not sufficient -- a bare ".."
# survives basename() unchanged and still resolves to ARTIFACT_DIR's parent).
_UNSAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._-]")


def safe_artifact_filename(name):
    base = os.path.basename(name or "")
    base = _UNSAFE_FILENAME_CHARS.sub("_", base)
    if base in ("", ".", ".."):
        return "artifact.bin"
    return base


_db_lock = threading.Lock()


def log(msg):
    print(f"[hermes-broker] {msg}", flush=True)


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    with connect() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                 id           TEXT PRIMARY KEY,
                 type         TEXT NOT NULL,
                 payload      TEXT NOT NULL,
                 state        TEXT NOT NULL,
                 attempts     INTEGER NOT NULL DEFAULT 0,
                 worker       TEXT,
                 created_at   REAL NOT NULL,
                 claimed_at   REAL,
                 finished_at  REAL,
                 exit_code    INTEGER,
                 artifact     TEXT,
                 sha256       TEXT,
                 error        TEXT,
                 delivered    INTEGER NOT NULL DEFAULT 0
               )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_state_type ON jobs(state, type)")
    log(f"database ready at {DB_PATH}")


def reap_expired_leases():
    """A worker that died mid-job must not strand the job. Runs on every claim."""
    cutoff = time.time() - LEASE_SECONDS
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, attempts FROM jobs WHERE state='running' AND claimed_at < ?", (cutoff,)
        ).fetchall()
        for row in rows:
            if row["attempts"] >= MAX_ATTEMPTS:
                conn.execute(
                    "UPDATE jobs SET state='dead', finished_at=?, error=? WHERE id=?",
                    (time.time(), f"lease expired after {row['attempts']} attempts", row["id"]),
                )
                log(f"job {row['id']} dead-lettered — lease expired, attempts exhausted")
            else:
                conn.execute(
                    "UPDATE jobs SET state='queued', claimed_at=NULL, worker=NULL WHERE id=?",
                    (row["id"],),
                )
                log(f"job {row['id']} requeued — lease expired (attempt {row['attempts']})")


def matrix_deliver(job_id, artifact_path, caption):
    """Deliver an artifact into Matrix as @fleetops:spark.

    This is the point of the whole design: the broker reports, from a real file
    on disk with a real checksum. No model is in this path, so no model can
    claim work happened that did not.
    """
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        log(f"job {job_id}: Matrix delivery skipped — @fleetops account not configured yet")
        return False
    try:
        filename = os.path.basename(artifact_path)
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        with open(artifact_path, "rb") as fh:
            blob = fh.read()

        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/media/v3/upload?filename={urllib.parse.quote(filename)}",
            data=blob,
            method="POST",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}", "Content-Type": mime},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            mxc = json.load(resp).get("content_uri")
        if not mxc:
            log(f"job {job_id}: Matrix upload returned no content_uri")
            return False

        msgtype = "m.image" if mime.startswith("image/") else (
            "m.video" if mime.startswith("video/") else "m.file")
        body = {
            "msgtype": msgtype,
            "body": caption,
            "url": mxc,
            "info": {"mimetype": mime, "size": len(blob)},
        }
        txn = f"broker-{job_id}-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps(body).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
        log(f"job {job_id}: delivered to {FLEETOPS_ROOM}")
        return True
    except Exception as exc:  # delivery must never fail the job itself
        log(f"job {job_id}: Matrix delivery failed: {exc}")
        return False


def matrix_notice(text):
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        return
    try:
        txn = f"broker-note-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except Exception as exc:
        log(f"notice delivery failed: {exc}")


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-broker/1.0.0"

    def log_message(self, fmt, *args):
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, code, obj):
        blob = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _send_file(self, artifact_path):
        """Streams a stored artifact's raw bytes — added for hermes-media.py's own
        generate->evaluate->regenerate loop (target §9.2), which runs on spark-2 and has no
        filesystem access to this node's LUKS-mounted ARTIFACT_DIR. Defense in depth on top of
        the write-side path-traversal fix (1.1.0): re-resolves the stored path and refuses to
        serve anything outside ARTIFACT_DIR, even though `artifact` should never contain such a
        path already."""
        resolved = os.path.realpath(artifact_path)
        artifact_root = os.path.realpath(ARTIFACT_DIR)
        if not (resolved == artifact_root or resolved.startswith(artifact_root + os.sep)):
            log(f"refusing to serve artifact outside ARTIFACT_DIR: {artifact_path!r}")
            self._send(404, {"error": "no such job"})
            return
        if not os.path.isfile(resolved):
            self._send(404, {"error": "artifact file missing on disk"})
            return
        content_type, _ = mimetypes.guess_type(resolved)
        size = os.path.getsize(resolved)
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(resolved, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

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

    # ---- routes -----------------------------------------------------------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"ok": True, "version": self.server_version})
            return
        if not self._authed():
            return

        if parsed.path == "/jobs/claim":
            qs = urllib.parse.parse_qs(parsed.query)
            jtype = (qs.get("type") or [""])[0]
            worker = (qs.get("worker") or ["unknown"])[0]
            roles = (qs.get("roles") or [""])[0]
            if not jtype:
                self._send(400, {"error": "type is required"})
                return
            self._send(200, self._claim(jtype, worker, roles))
            return

        if parsed.path == "/jobs":
            with connect() as conn:
                rows = conn.execute(
                    "SELECT id,type,state,attempts,created_at,finished_at,exit_code,error "
                    "FROM jobs ORDER BY created_at DESC LIMIT 100"
                ).fetchall()
            self._send(200, {"jobs": [dict(r) for r in rows]})
            return

        if parsed.path.startswith("/jobs/") and parsed.path.endswith("/artifact"):
            job_id = parsed.path.split("/")[2]
            if not JOB_ID_RE.match(job_id):
                self._send(400, {"error": "invalid job id"})
                return
            with connect() as conn:
                row = conn.execute("SELECT artifact,state FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                self._send(404, {"error": "no such job"})
                return
            if row["state"] != "done" or not row["artifact"]:
                self._send(404, {"error": "job has no artifact"})
                return
            self._send_file(row["artifact"])
            return

        if parsed.path.startswith("/jobs/"):
            job_id = parsed.path.split("/")[2]
            with connect() as conn:
                row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                self._send(404, {"error": "no such job"})
                return
            self._send(200, dict(row))
            return

        self._send(404, {"error": "no such route"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._authed():
            return

        if parsed.path == "/jobs":
            try:
                payload = json.loads(self._body() or b"{}")
            except (ValueError, json.JSONDecodeError) as exc:
                self._send(400, {"error": f"bad body: {exc}"})
                return
            jtype = payload.get("type")
            if not jtype:
                self._send(400, {"error": "type is required"})
                return
            # Dedup by caller-supplied id, so a retried submit is not a second job.
            job_id = payload.get("id") or uuid.uuid4().hex[:12]
            if not JOB_ID_RE.match(job_id):
                self._send(400, {"error": "invalid id (must match ^[A-Za-z0-9_-]{1,64}$)"})
                return
            with _db_lock, connect() as conn:
                existing = conn.execute("SELECT id FROM jobs WHERE id=?", (job_id,)).fetchone()
                if existing:
                    self._send(200, {"id": job_id, "duplicate": True})
                    return
                conn.execute(
                    "INSERT INTO jobs (id,type,payload,state,created_at) VALUES (?,?,?,'queued',?)",
                    (job_id, jtype, json.dumps(payload.get("payload", {})), time.time()),
                )
            log(f"job {job_id} queued ({jtype})")
            self._send(201, {"id": job_id, "state": "queued"})
            return

        if parsed.path.startswith("/jobs/") and parsed.path.endswith("/result"):
            self._result(parsed.path.split("/")[2])
            return

        self._send(404, {"error": "no such route"})

    # ---- operations -------------------------------------------------------

    def _claim(self, jtype, worker, roles=""):
        """`roles` (optional, comma-separated) restricts the claim to jobs whose
        `payload.role` is one of these -- added so a second `hermes-model-wake-worker.py`
        instance on another node, polling the same `type='wake'` queue, only ever claims wake
        jobs it can actually serve locally. Without this, a worker that claims a job for a role
        it doesn't recognize reports a real failure (non-zero exit, no artifact), which
        `_result()` already requeues rather than dead-lettering outright -- but every such
        mis-claim still burns one of the job's `MAX_ATTEMPTS` and a full poll cycle of latency
        for whichever role actually needed to wake. Backward compatible: an absent/empty `roles`
        claims exactly as before (every existing caller, unchanged)."""
        reap_expired_leases()
        role_list = [r for r in roles.split(",") if r]
        with _db_lock, connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if role_list:
                placeholders = ",".join("?" * len(role_list))
                row = conn.execute(
                    "SELECT id,type,payload,attempts FROM jobs "
                    "WHERE state='queued' AND type=? "
                    f"AND json_extract(payload,'$.role') IN ({placeholders}) "
                    "ORDER BY created_at LIMIT 1",
                    (jtype, *role_list),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT id,type,payload,attempts FROM jobs "
                    "WHERE state='queued' AND type=? ORDER BY created_at LIMIT 1",
                    (jtype,),
                ).fetchone()
            if not row:
                conn.execute("COMMIT")
                return {"job": None}
            conn.execute(
                "UPDATE jobs SET state='running', claimed_at=?, worker=?, attempts=attempts+1 "
                "WHERE id=? AND state='queued'",
                (time.time(), worker, row["id"]),
            )
            conn.execute("COMMIT")
        log(f"job {row['id']} claimed by {worker} (attempt {row['attempts'] + 1})")
        return {"job": {"id": row["id"], "type": row["type"],
                        "payload": json.loads(row["payload"]),
                        "attempt": row["attempts"] + 1}}

    def _result(self, job_id):
        """Worker reports real process output. Artifact bytes arrive raw in the body;
        metadata comes in headers so no multipart parsing is needed."""
        if not JOB_ID_RE.match(job_id):
            self._send(400, {"error": "invalid job id"})
            return

        with connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            self._send(404, {"error": "no such job"})
            return

        try:
            blob = self._body()
        except ValueError as exc:
            self._send(413, {"error": str(exc)})
            return

        # Cheap early exit for the common case: the job already moved on since
        # the SELECT above (reaped by an expired lease, or a racing duplicate
        # report already landed). The locked, conditional UPDATE below is the
        # actual authoritative check -- this just avoids wasted work (an
        # artifact write, a Matrix delivery) for the common stale case.
        if row["state"] != "running":
            self._send(409, {"error": f"job is '{row['state']}', not 'running' — result discarded"})
            return

        exit_code = int(self.headers.get("X-Exit-Code", "1"))
        claimed_sha = self.headers.get("X-Sha256", "")
        filename = safe_artifact_filename(self.headers.get("X-Filename", ""))
        error = self.headers.get("X-Error", "")
        caption = self.headers.get("X-Caption", "") or f"job {job_id}"

        artifact_path = None
        if blob:
            actual_sha = hashlib.sha256(blob).hexdigest()
            # The worker's claimed checksum must match the bytes actually received.
            # A mismatch means a truncated or corrupted transfer, not a done job.
            if claimed_sha and claimed_sha != actual_sha:
                msg = f"sha256 mismatch: worker said {claimed_sha}, received {actual_sha}"
                log(f"job {job_id}: {msg}")
                with _db_lock, connect() as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    conn.execute(
                        "UPDATE jobs SET state='queued', claimed_at=NULL, worker=NULL, error=? "
                        "WHERE id=? AND state='running'", (msg, job_id))
                    conn.execute("COMMIT")
                self._send(400, {"error": msg})
                return
            job_dir = os.path.join(ARTIFACT_DIR, job_id)
            os.makedirs(job_dir, exist_ok=True)
            artifact_path = os.path.join(job_dir, filename)
            with open(artifact_path, "wb") as fh:
                fh.write(blob)
            claimed_sha = actual_sha

        if exit_code == 0 and (artifact_path or not blob):
            # A real artifact is what "done" means for render/video/embed jobs, which never
            # exit 0 without one. But an artifact-less job type (wake, remediate) legitimately
            # succeeds with an empty body -- `blob` being falsy is that job's own signal that no
            # artifact was ever expected, not evidence the job failed. Before this fix, a
            # genuinely successful artifact-less job fell through to the `queued`/`dead` branches
            # below exactly like a real failure would, since `artifact_path` stays None whenever
            # no blob is uploaded regardless of exit_code -- meaning a successful wake job could
            # never actually reach `done`, only get silently re-run until attempts ran out and it
            # was marked `dead` despite having worked. Found 2026-08-21 while adding a second
            # artifact-less job type (remediate) and reasoning through this path for the first
            # time since wake shipped.
            state = "done"
        elif row["attempts"] >= MAX_ATTEMPTS:
            state = "dead"
        else:
            state = "queued"

        # Authoritative, locked transition: only applies if the job is still
        # in 'running' state -- i.e. still the same claim this report is for.
        # If a lease reap or a racing duplicate report already moved it,
        # rowcount is 0 and this report is discarded instead of silently
        # overwriting whatever the job's real current state already is (which
        # could otherwise resurrect an already-dead-lettered job, or deliver
        # the same artifact to Matrix twice).
        with _db_lock, connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if state == "queued":
                cur = conn.execute(
                    "UPDATE jobs SET state='queued', claimed_at=NULL, worker=NULL, "
                    "exit_code=?, error=? WHERE id=? AND state='running'",
                    (exit_code, error, job_id))
            else:
                cur = conn.execute(
                    "UPDATE jobs SET state=?, finished_at=?, exit_code=?, artifact=?, "
                    "sha256=?, error=? WHERE id=? AND state='running'",
                    (state, time.time(), exit_code, artifact_path, claimed_sha, error, job_id))
            applied = cur.rowcount > 0
            conn.execute("COMMIT")

        if not applied:
            log(f"job {job_id}: result discarded — job state changed since claim (race)")
            self._send(409, {"error": "job state changed since claim — result discarded"})
            return

        log(f"job {job_id} -> {state} (exit {exit_code})")

        if row["type"] in QUIET_TYPES:
            log(f"job {job_id}: type '{row['type']}' is quiet — Matrix delivery/notice skipped")
        elif state == "done":
            delivered = matrix_deliver(job_id, artifact_path, caption)
            if delivered:
                with connect() as conn:
                    conn.execute("UPDATE jobs SET delivered=1 WHERE id=?", (job_id,))
        elif state == "dead":
            matrix_notice(f"job {job_id} FAILED after {row['attempts']} attempts "
                          f"(exit {exit_code}): {error[:400]}")
        else:
            log(f"job {job_id} requeued for retry (attempt {row['attempts']} of {MAX_ATTEMPTS})")

        self._send(200, {"id": job_id, "state": state})


def main():
    if not TOKEN:
        sys.exit("BROKER_TOKEN is required — this service must not run unauthenticated")
    init_db()
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        log("WARNING: @fleetops Matrix account not configured — jobs will complete "
            "and artifacts will be stored, but nothing will be delivered to Matrix")
    log(f"listening on {BIND}:{PORT}, artifacts in {ARTIFACT_DIR}")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
