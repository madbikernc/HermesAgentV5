#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes_nous_usage_log.py — Shared SQLite ledger for tools/hermes-nous-judge.py
(IMPLEMENTATION_PLAN.md Stage 18).

Same shape as tools/hermes_usage_log.py (the internal hermes-router.py ledger), separate table
and separate DB by default — Nous spend is real money against a $22/mo hard cap, not just an
internal latency/token metric, so it gets its own store rather than sharing rows with the
zero-cost internal router log.

Cost is logged as the real `usage.cost` dollar figure Nous's own response returns (confirmed live,
Stage 18 §6 gate 2) — never estimated from a rate card. `cycle_total_usd()` sums everything since
the most recent billing-anchor day, so hermes-nous-judge.py's pre-flight check is a single query,
not something each caller has to compute itself.

Named with underscores, breaking this project's usual hyphenated tools/ filename convention —
same reason hermes_usage_log.py and hermes_pfsense_common.py are: this file is `import`ed, not
invoked directly, and Python cannot import a module whose filename contains a hyphen.
"""
import calendar
import os
import sqlite3
import sys
from datetime import date, datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("HERMES_NOUS_USAGE_DB", str(Path.home() / ".hermes" / "state" / "nous_usage.db")))

SCHEMA = """
CREATE TABLE IF NOT EXISTS nous_usage_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    path              TEXT NOT NULL,
    model             TEXT NOT NULL,
    status            TEXT NOT NULL,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    cost_usd          REAL,
    error_message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_nous_usage_log_ts ON nous_usage_log(ts);
CREATE INDEX IF NOT EXISTS idx_nous_usage_log_path ON nous_usage_log(path);
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


def log_request(*, path, model, status, prompt_tokens=None, completion_tokens=None,
                 total_tokens=None, cost_usd=None, error_message=None):
    """Best-effort — never raises. A logging failure must never block a caller that already got
    (or failed to get) its real Nous response, same rule hermes_usage_log.py's log_request()
    follows for the internal router."""
    try:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO nous_usage_log (ts, path, model, status, prompt_tokens, "
                "completion_tokens, total_tokens, cost_usd, error_message) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat(), path, model, status, prompt_tokens,
                 completion_tokens, total_tokens, cost_usd, error_message),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        print(f"[hermes_nous_usage_log] write failed: {exc}", file=sys.stderr)


def current_cycle_start(anchor_day: int, today: date | None = None) -> date:
    """The most recent calendar date whose day-of-month is `anchor_day` (clamped to the last real
    day of a short month, e.g. anchor_day=31 in February lands on the 28th/29th) that is on or
    before `today`. This is the fleet's own approximation of the Portal's real billing-cycle
    start — Stage 18 §6 gate 4 flags that the *real* renewal date is still unconfirmed against
    the actual subscription, so treat this as best-effort until that's checked."""
    today = today or datetime.now(timezone.utc).date()

    def _clamped(year, month, day):
        last_day = calendar.monthrange(year, month)[1]
        return date(year, month, min(day, last_day))

    this_month_anchor = _clamped(today.year, today.month, anchor_day)
    if this_month_anchor <= today:
        return this_month_anchor
    prev_month = today.month - 1 or 12
    prev_year = today.year - 1 if today.month == 1 else today.year
    return _clamped(prev_year, prev_month, anchor_day)


def cycle_total_usd(anchor_day: int) -> float:
    """Sum of real `cost_usd` for every logged call since the current billing cycle started.
    NULL costs (a call that errored before Nous returned a `usage` object) contribute 0, not NULL —
    SQLite's SUM already does this, called out here because a logging gap silently under-counting
    real spend would be worse than mildly over-cautious."""
    cycle_start_iso = current_cycle_start(anchor_day).isoformat()
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT COALESCE(SUM(cost_usd), 0.0) FROM nous_usage_log WHERE ts >= ?",
            (cycle_start_iso,),
        ).fetchone()
        return float(row[0])
    finally:
        conn.close()


def fetch_cycle(anchor_day: int):
    """All rows in the current billing cycle, oldest first — for a human-readable dump/report."""
    cycle_start_iso = current_cycle_start(anchor_day).isoformat()
    conn = _connect()
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM nous_usage_log WHERE ts >= ? ORDER BY ts",
            (cycle_start_iso,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
