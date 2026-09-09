#!/usr/bin/env python3
# Version: 1.2.0
"""
hermes_injection_guard.py — Heuristic (pattern-layer) prompt/command/SQL-injection
scanner for hermes-router.py, plus a small persistent event log so the daily
fleet-health report can summarize block/flag counts without needing SSH into
each node (hermes-router.py exposes them over its own `/guard/stats` GET
endpoint — see that file's 2.4.0 changelog entry).

1.2.0 (2026-09-09): pattern-catalog hardening pass, no change to severity()/
scan_messages()/the log schema -- catalog-level only:
  - CMD_INJECTION patterns are now case-insensitive. Previously only
    SQL_INJECTION and INSTRUCTION_OVERRIDE carried (?i); CMD_INJECTION didn't,
    an inconsistency (not a deliberate choice) that let case variation alone
    slip text past the cmd-injection category.
  - curl/wget-pipe-to-shell now tolerates multiple flag tokens before the
    pipe. The old pattern only matched a single token between the command and
    `|` (`curl <url> | bash`), missing the far more common
    `curl -fsSL <url> | bash` form (flags + URL = two tokens).
  - New PROMPT_EXFILTRATION category: "repeat/print/reveal the text above",
    "what are your instructions", etc. Distinct from INSTRUCTION_OVERRIDE
    (which is about overriding behavior, not extracting the prompt) and was
    previously not covered by any category. Tool-role-blocked, same as
    cmd_injection/sql_injection/instruction_override.
  - ROLE_SPOOF now also catches a bare `Human:` turn marker (the classic
    Anthropic completions-style injection format -- the role-tag alternation
    previously only covered system/user/assistant/tool), plus `<<SYS>>`/
    `<</SYS>>` (Llama-2 system delimiters) and `<|system|>`/`<|user|>`/
    `<|assistant|>` (ChatML variants beyond `<|im_start|>`).
  - UNICODE_SMUGGLING's bidi character class extended to the isolate
    characters (U+2066-U+2069: LRI/RLI/FSI/PDI), not just the older
    override/embed set (U+202A-U+202E) -- isolates are the ones increasingly
    seen in current ASCII-smuggling writeups. Also added the word joiner
    (U+2060) to the zero-width set. Switched the bidi/zero-width classes from
    literal embedded control characters to explicit \\u escapes so they
    survive editing without corruption.
  - INSTRUCTION_OVERRIDE broadened: "ignore everything/all above" (no
    trailing "instructions" required) and "forget your/all/previous
    instructions" phrasing.

1.1.0 (2026-08-28): added log_event()/recent_counts(), a WAL-mode SQLite
store, same shape as hermes_usage_log.py's (own DB file, not a shared table —
this is a distinct concern: usage_log is per-request outcome/latency,
this is per-guard-verdict). Written alongside hermes-router.py 2.4.0's
wiring; not yet exercised against live traffic — see that file's own
changelog for what "wired" does and doesn't mean here.

1.0.0 (2026-08-28): initial scanner (scan/severity/scan_messages/
overall_severity). Wired into hermes-router.py 2.3.0. Still true as of
1.1.0: this file makes no network calls in the scanning path, and the
DB write added here is wrapped best-effort, same rule hermes_usage_log.py
already follows — a logging failure must never affect the actual proxied
request.

Layer 1 of a two-layer design (see chat record, not yet written into
IMPLEMENTATION_PLAN.md): this module is the cheap, deterministic pass — regex
over literal attack syntax, no model call, sub-millisecond. Layer 2 (a Prompt
Guard 2 classifier run as its own resident `guard` role, same pattern as
`nano`) catches paraphrased/semantic manipulation this layer can't enumerate.
That second layer does not exist yet — no model server, no ROLES entry, no
systemd unit. This file only does Layer 1.

Why two layers instead of one: an attacker manipulating the model doesn't
need semantically convincing text — they often just need literal attack
syntax (a shell metacharacter, a SQL tautology) to survive verbatim through
a turn and land in whatever executes downstream (hermes-remediate-worker,
hermes-broker's SQLite store). That's a pattern-matching problem, not a
language-understanding problem, and catching it here means never spending a
model call on an obviously-malicious payload.

Severity is keyed off the OpenAI-style message `role`, not content alone —
scanning role-blind would false-positive-block `coder`'s actual job (people
legitimately paste shell scripts and SQL for review). The asymmetry:

  - role_spoof / unicode_smuggling hits: never legitimate in ANY role text
    content (a real user role tag or bidi override has no honest reason to
    appear inside a message's `content` string) -> always "block".
  - cmd_injection / sql_injection hits in a `tool` message: this is content
    the persona is *reading* (RAG chunk, fetched page, broker/tool result),
    not content a human typed on purpose. Nobody expects a webpage's body
    text to contain a reverse-shell one-liner -> "block". This is the
    concrete case the role-confusion paper calls "adversarial webpages in
    tool-tagged data retrieved by agents." instruction_override and
    prompt_exfiltration hits in a `tool` message get the same treatment --
    retrieved content telling the model to ignore its instructions or to
    repeat its system prompt has no legitimate reading either.
  - cmd_injection / sql_injection / instruction_override / prompt_exfiltration
    hits in a `user` message: expected and often legitimate (debugging help,
    or someone just asking what the model's instructions are) -> "flag"
    only, never a hard block on this signal alone.

This module makes no network calls itself. log_event() below does local
disk I/O (SQLite) but no network I/O, and is wrapped best-effort — same
"deliberately boring" rule hermes-router.py and hermes_usage_log.py both
already hold to.
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# --- Pattern catalog -------------------------------------------------------
# Literal downstream-execution payloads. Legitimate almost nowhere in
# retrieved/tool content; legitimate often in a user's own coding questions,
# which is why severity() treats this category differently by role.
CMD_INJECTION = [
    r'(?i)\$\([^)]+\)',                                    # $(...) command substitution
    r'(?i)`[^`]+`',                                         # backtick substitution
    r'(?i)[;&|]{1,2}\s*(rm|curl|wget|nc|bash|sh|python[23]?|chmod|chown|sudo|dd|mkfs)\b',
    r'(?i)\b(curl|wget)\s+\S+(?:\s+\S+){0,4}\s*\|\s*(sh|bash)\b',  # curl|sh / wget|sh, flags tolerated
    r'(?i)\bnc\s+-e\b',                                     # netcat reverse shell
    r'(?i)/etc/(passwd|shadow)\b',
    r'(?i)\bbase64\s+-d\b.{0,20}\|\s*(sh|bash)',
]

SQL_INJECTION = [
    r"(?i)\bunion\b.{0,40}\bselect\b",
    r"(?i)['\"]\s*or\s+['\"]?\d+['\"]?\s*=\s*['\"]?\d+['\"]?",   # ' OR '1'='1
    r"(?i);\s*drop\s+table\b",
    r"(?i)\bxp_cmdshell\b",
    r"(?i)\b(sleep|benchmark)\s*\(\s*\d+",
    r"(?i)\bwaitfor\s+delay\b",
]

# Structural spoofing — never legitimate in a message's content string,
# regardless of what role sent it.
ROLE_SPOOF = [
    r"(?im)^\s*(system|user|assistant|tool|human)\s*:\s",  # fake role tag at line start
                                                             # ("human" catches the classic
                                                             # Anthropic completions-style
                                                             # `\n\nHuman:` injection format)
    r"<\|im_start\|>|<\|im_end\|>",
    r"<\|(system|user|assistant)\|>",                       # ChatML-adjacent role tags
    r"<<SYS>>|<</SYS>>",                                    # Llama-2 system delimiters
    r"\[INST\]|\[/INST\]",
    r"</?think>",
    r"(?i)###\s*(system|instruction)\b",
]

UNICODE_SMUGGLING = [
    r"[\u202A-\u202E\u2066-\u2069]",     # bidi override (202A-202E) + isolate (2066-2069) chars
    r"[\u200B-\u200D\u2060\uFEFF]",       # zero-width chars: ZWSP/ZWNJ/ZWJ/word-joiner/BOM
    r"[\U000E0000-\U000E007F]",          # Unicode tag block (ASCII smuggling)
]

# Semantic-but-still-pattern-matchable phrasing — catches the unsophisticated
# attacker before Layer 2 (Prompt Guard 2) would ever need to run.
INSTRUCTION_OVERRIDE = [
    r"(?i)\bignore\s+(all\s+)?(previous|above|prior)\s+instructions\b",
    r"(?i)\bignore\s+(everything|all)\s+(above|before\s+this)\b",
    r"(?i)\bdisregard\s+(the\s+)?(system\s+)?prompt\b",
    r"(?i)\bforget\s+(your|all|previous)\s+instructions\b",
    r"(?i)\bnew\s+instructions\s*:",
    r"(?i)\byou\s+are\s+now\s+\w+",
]

# System-prompt / instruction exfiltration attempts. Distinct from
# INSTRUCTION_OVERRIDE: that category is about getting the model to behave
# differently going forward; this one is about extracting the prompt/
# instructions verbatim. No legitimate reading in tool-originated content
# (a retrieved document has no reason to ask the model to repeat its own
# system prompt), same rationale as instruction_override.
PROMPT_EXFILTRATION = [
    r"(?i)\b(repeat|print|output|show|reveal)\s+(the\s+)?(text|words|instructions|prompt|everything)\s+above\b",
    r"(?i)\bwhat\s+(are|were)\s+your\s+(system\s+)?instructions\b",
    r"(?i)\breveal\s+(your\s+)?(system\s+)?prompt\b",
    r"(?i)\brepeat\s+(everything|all)\s+(above|before\s+this)\b",
]

_CATEGORIES = {
    "cmd_injection": CMD_INJECTION,
    "sql_injection": SQL_INJECTION,
    "role_spoof": ROLE_SPOOF,
    "unicode_smuggling": UNICODE_SMUGGLING,
    "instruction_override": INSTRUCTION_OVERRIDE,
    "prompt_exfiltration": PROMPT_EXFILTRATION,
}
_COMPILED = {name: [re.compile(p) for p in pats] for name, pats in _CATEGORIES.items()}

# Categories that are never legitimate regardless of message role.
_ALWAYS_BLOCK = {"role_spoof", "unicode_smuggling"}
# Categories treated as adversarial-content signal only when the message
# claims to be tool-originated (retrieved/tool-result text, not human-typed).
# instruction_override and prompt_exfiltration belong here too: retrieved
# content telling the model to "ignore previous instructions" or to repeat
# its system prompt has no legitimate reading, unlike a user saying either
# about their own conversation.
_TOOL_ROLE_BLOCK = {"cmd_injection", "sql_injection", "instruction_override", "prompt_exfiltration"}


def scan(text):
    """Returns {category: [matched snippets]} for every category with at least
    one hit. Pure function, no I/O — safe to call on arbitrary untrusted text."""
    if not text:
        return {}
    hits = {}
    for category, patterns in _COMPILED.items():
        found = [m.group(0) for p in patterns if (m := p.search(text))]
        if found:
            hits[category] = found
    return hits


def severity(role, hits):
    """"block" | "flag" | "clean". See module docstring for the role-keyed
    rationale — this is deliberately NOT role-blind."""
    if not hits:
        return "clean"
    if _ALWAYS_BLOCK & hits.keys():
        return "block"
    if role == "tool" and (_TOOL_ROLE_BLOCK & hits.keys()):
        return "block"
    return "flag"


def scan_messages(messages):
    """Scans an OpenAI-style `messages` list. Returns a list of
    {"index", "role", "hits", "severity"} for every message with a non-clean
    result — empty list means nothing to report. Never raises on malformed
    input (a missing/non-string `content` is treated as empty text), because
    a scanner bug must never be the thing that breaks the actual proxied
    request downstream of it."""
    results = []
    for i, msg in enumerate(messages or []):
        role = msg.get("role", "") if isinstance(msg, dict) else ""
        content = msg.get("content", "") if isinstance(msg, dict) else ""
        if not isinstance(content, str):
            content = str(content)
        hits = scan(content)
        sev = severity(role, hits)
        if sev != "clean":
            results.append({"index": i, "role": role, "hits": hits, "severity": sev})
    return results


def overall_severity(scan_results):
    """Collapses scan_messages()'s per-message results into one verdict for
    the whole request: "block" if any message blocked, else "flag" if any
    message flagged, else "clean"."""
    sevs = {r["severity"] for r in scan_results}
    if "block" in sevs:
        return "block"
    if "flag" in sevs:
        return "flag"
    return "clean"


# --- Persistent event log ---------------------------------------------------
# Own DB file, not a table added to hermes_usage_log.py's usage.db — that
# store is per-proxied-request outcome/latency; this is per-guard-verdict,
# a distinct concern with a distinct reader (hermes-router.py's own
# `/guard/stats` endpoint, not hermes-usage-report.py).
DB_PATH = Path(os.environ.get("HERMES_GUARD_DB", str(Path.home() / ".hermes" / "state" / "injection_guard.db")))

SCHEMA = """
CREATE TABLE IF NOT EXISTS guard_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    node       TEXT NOT NULL,
    severity   TEXT NOT NULL,
    roles      TEXT NOT NULL,
    categories TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guard_log_ts ON guard_log(ts);
CREATE INDEX IF NOT EXISTS idx_guard_log_severity ON guard_log(severity);
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


def log_event(node, severity_value, scan_results):
    """Best-effort — never raises. A logging failure must never affect the
    actual proxied request, same rule hermes_usage_log.log_request() and
    hermes-router.py's own matrix_notice() both already follow. Only called
    for "block"/"flag" verdicts — "clean" requests are not logged here (that
    volume belongs in hermes_usage_log.py's existing per-request row, not
    duplicated into this table)."""
    try:
        roles = sorted({r["role"] for r in scan_results})
        categories = sorted({cat for r in scan_results for cat in r["hits"]})
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO guard_log (ts, node, severity, roles, categories) VALUES (?, ?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat(), node, severity_value,
                 json.dumps(roles), json.dumps(categories)),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        print(f"[hermes_injection_guard] write failed: {exc}", file=sys.stderr)


def recent_counts(window_seconds=86400):
    """Counts + examples for the last `window_seconds`, for hermes-router.py's
    `/guard/stats` endpoint and hermes-fleet-health.py's daily digest.
    Returns {"block": N, "flag": M, "categories": {cat: count, ...},
    "recent_blocks": [{"ts", "roles", "categories"}, ...]} (blocks only,
    newest-first, capped at 10 — enough for a digest, not a full audit log;
    query the DB directly for that)."""
    cutoff = datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() - window_seconds, tz=timezone.utc
    ).isoformat()
    conn = _connect()
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM guard_log WHERE ts >= ? ORDER BY ts DESC", (cutoff,)
        ).fetchall()
    finally:
        conn.close()

    counts = {"block": 0, "flag": 0}
    categories = {}
    recent_blocks = []
    for row in rows:
        counts[row["severity"]] = counts.get(row["severity"], 0) + 1
        for cat in json.loads(row["categories"]):
            categories[cat] = categories.get(cat, 0) + 1
        if row["severity"] == "block" and len(recent_blocks) < 10:
            recent_blocks.append({
                "ts": row["ts"], "node": row["node"],
                "roles": json.loads(row["roles"]), "categories": json.loads(row["categories"]),
            })
    return {"block": counts["block"], "flag": counts["flag"],
            "categories": categories, "recent_blocks": recent_blocks}
