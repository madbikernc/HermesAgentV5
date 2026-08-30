#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes_usage_log.py — Shared SQLite usage-log store for hermes-router.py and
hermes-usage-report.py.

Every model call on the fleet (nano/super/coder/muse/omni) already passes through
hermes-router.py regardless of caller, so that's the one place a per-request
log can be written without touching any backend, persona, or caller script.
This module is that log: one append-only row per proxied request, read back
later by hermes-usage-report.py to produce the weekly usage digest.

SQLite, stdlib-only — same "deliberately boring" rule hermes-router.py itself
documents (no new dependency for what is fundamentally a counter with a
timestamp). WAL mode is enabled so the router's writer and the report's reader
never block each other.

Named with underscores, breaking this project's usual hyphenated tools/
filename convention — deliberately, same reason hermes_pfsense_common.py is:
this file is `import`ed, not invoked directly, and Python cannot import a
module whose filename contains a hyphen.

Carried over unchanged from HermesAgentRedo's tools/hermes_usage_log.py
(Category A, IMPLEMENTATION_PLAN.md §7) — only this docstring's role-name
example was updated to match V4's topology.
"""
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("HERMES_USAGE_DB", str(Path.home() / ".hermes" / "state" / "usage.db")))

SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    role              TEXT NOT NULL,
    status            TEXT NOT NULL,
    latency_ms        INTEGER NOT NULL,
    ttfb_ms           INTEGER,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    prompt_chars      INTEGER,
    response_chars    INTEGER,
    error_message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_log_ts ON usage_log(ts);
CREATE INDEX IF NOT EXISTS idx_usage_log_role ON usage_log(role);
"""


def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = _connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def log_request(*, role, status, latency_ms, ttfb_ms=None, prompt_tokens=None,
                 completion_tokens=None, total_tokens=None, prompt_chars=None,
                 response_chars=None, error_message=None):
    """Best-effort — never raises. A logging failure must never affect the
    actual proxied request, same rule hermes-router.py's own matrix_notice()
    follows."""
    try:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO usage_log (ts, role, status, latency_ms, ttfb_ms, prompt_tokens, "
                "completion_tokens, total_tokens, prompt_chars, response_chars, error_message) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat(), role, status, latency_ms, ttfb_ms,
                 prompt_tokens, completion_tokens, total_tokens, prompt_chars, response_chars,
                 error_message),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        print(f"[hermes_usage_log] write failed: {exc}", file=sys.stderr)


def fetch_range(start_iso, end_iso):
    """All rows with start_iso <= ts < end_iso, oldest first."""
    conn = _connect()
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM usage_log WHERE ts >= ? AND ts < ? ORDER BY ts",
            (start_iso, end_iso),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
