#!/usr/bin/env python3
# Version: 1.4.0
"""
hermes_injection_guard.py — Heuristic (pattern-layer) prompt/command/SQL-injection
scanner for hermes-router.py, plus a small persistent event log so the daily
fleet-health report can summarize block/flag counts without needing SSH into
each node (hermes-router.py exposes them over its own `/guard/stats` GET
endpoint — see that file's 2.4.0 changelog entry).

1.4.0 (2026-09-11): real false positive, found live and traced to a specific file: a "check
reolink cameras" request blocked with cmd_injection on the newest tool message (a read of
tools/hermes-reolink.py) even after hermes-router.py 2.11.0's newest-message-only fix -- the
Layer 1 catalog itself had a real bug, not a scoping one. _DANGEROUS's component tokens
(rm/curl/wget/nc/netcat/bash/chmod/chown/dd/mkfs/eval) had no \\b word boundaries, so they matched
as bare substrings anywhere a dangerous token's letters happened to appear, not just as whole
command names. The actual trigger: hermes-reolink.py's own docstring contains the backtick-wrapped
markdown reference `` `async def` `` (async Python code, documented as such) -- "async " contains
the literal substring "nc " (...asy-NC-space...), which matched the unguarded `nc\\s` token.
Probed for siblings before shipping the fix (the same discipline 1.3.0 should have applied to this
component specifically): `curl` also matched inside "curly", `bash` inside "bashful", `dd if=`
inside "add if=", `chown` inside "chowning". All four are exactly the kind of ordinary
English/code substring a command name can hide inside, and none of them are remotely rare in real
prose or code comments. Fixed by wrapping every literal command-name token in `_DANGEROUS` with
`\\b` (a real command name is a whole token, never embedded inside another word) -- verified 12
false-positive probes across all four collisions now clean, and all 14 original true-positive
probes (rm -rf, curl <url>, nc -e, dd if=, etc.) still match unchanged. No other pattern in this
catalog uses `_DANGEROUS` without also requiring a preceding shell metacharacter (the
chained-execution pattern) or being scoped to a single already-\\b-bounded literal (the standalone
nc -e / base64 patterns), so this was the only unguarded surface.

Same incident, second bug: re-ran 1.3.0's own "measure before shipping" corpus check (this time
including tools/*.py, the actual attack surface a file-read tool result represents, which the
1.3.0 measurement never included) and it caught two more real false positives, both in
hermes-router.py itself: SQL_INJECTION's `(sleep|benchmark)\\s*\\(\\s*\\d+` pattern matched ordinary
`time.sleep(2)`/`asyncio.sleep(5)` calls (routine polling code throughout this fleet) and the
English word "benchmark" followed by this project's own changelog convention of a parenthetical
date citation, e.g. "benchmark (2026-08-26 -- ...)". Fixed with two real differentiators instead
of a blanket word match: `sleep` now excludes a preceding `.` (a negative lookbehind), since every
legitimate call site is a namespaced method call (`time.sleep(`, `asyncio.sleep(`) while a real
SQLi payload's SLEEP() is bare; `benchmark` now requires a trailing comma before its next argument,
since MySQL's BENCHMARK(count, expr) always takes exactly two comma-separated arguments and no
English usage of the word "benchmark" followed by a parenthetical naturally produces that shape.

Same incident, third bug, same corpus check: `_DANGEROUS`'s bare `curl`/`wget` tokens were the
single largest false-positive source measured (24 of ~50 blocked chunks across this repo's own
markdown+tools/*.py) -- any backtick-wrapped mention of curl/wget at all counted as "dangerous",
including completely benign ops documentation like `` `curl http://host:port/health` ``, which
this fleet's own docs use constantly for verification snippets. Removed both from `_DANGEROUS`
entirely rather than trying to further qualify them: they were redundant there in the first place,
since the real curl/wget threats (piped to a shell, or chained after a `;`/`&`/`|`) are already
caught unconditionally by CMD_INJECTION's own dedicated curl/wget-pipe-to-shell pattern and the
chained-execution pattern, neither of which depends on `_DANGEROUS` or backtick-wrapping at all --
verified live that `` `curl ... | bash` ``, bare `curl ... | sh`, and `; curl ...` all still block
exactly as before, while a bare backtick-wrapped `curl <url>` health-check example is now clean.
Also tightened `eval` in the same pass: `\\beval\\s` matched the bare word "eval" as AI/ML jargon
shorthand for "evaluation" (this repo's own IMPLEMENTATION_PLAN.md: "eval set", "eval harness",
"eval results" -- 22 matches checked, all 22 false positives, zero real `eval(...)` calls) any time
it was followed by whitespace. Now requires an actual invocation shape after it -- `\\beval\\s*[("'$]`
-- matching `eval(`, `eval (`, `eval "..."`, and the `eval $(...)` shell idiom, while "eval harness"
and "a duplicate eval for..." no longer match.

1.3.0 (2026-09-09): false-positive correction. 1.2.0 widened this catalog
without ever measuring it against the content it actually runs on, and the
result was a guard that blocked almost everything: 96.3% of this repo's own
markdown, and 1,530 of the 79,878 chunks in the live RAG index, were being
hard-blocked at role="tool". A live rag_search returned 5/5 results redacted.
The mistake was categorical, not a bad regex: this catalog was written to
scan chat messages arriving at a router, where shell syntax in a message is
anomalous, and was then applied unchanged to retrieved document chunks, where
technical documentation is *supposed* to contain code. The rule this version
applies throughout: match the dangerous CONSTRUCT, never the syntax that could
carry one.

  - cmd_injection: a bare `$(...)` or backtick span is no longer a hit. Both
    now require a dangerous payload inside (see _DANGEROUS) and may not span
    newlines. The bare-backtick pattern alone was responsible for 779 of the
    791 blocked doc chunks -- it matched every markdown inline code span in
    existence. The chained-execution pattern now requires a real argument per
    alternative (`| bash |` is a markdown table cell, not a pipeline), and its
    trailing \\b -- which silently prevented `rm -rf` from ever matching -- is
    gone. `/etc/passwd` dropped as a standalone signal (ordinary in docs);
    `/etc/shadow` kept. Added the `/dev/tcp` reverse-shell form.
  - unicode_smuggling: presence of an invisible character is not concealment.
    Measured on all 79,878 live chunks: 118,176 zero-width occurrences, every
    single one isolated, max run length 2, zero runs of 3+ -- they come from
    PDF/HTML text extraction, not attacks. ZWSP/word-joiner now require a run
    of 3+, which clears all 1,393 false positives at no detection cost, since
    encoding a payload in zero-width characters takes dozens in a row. ZWJ and
    ZWNJ removed entirely: ZWJ joins emoji sequences (any family/profession
    emoji was a hard block) and both are required for correct Persian, Arabic
    and Indic rendering. A leading BOM is now file encoding, not a hit.
  - role_spoof split. It keeps only chat-template control tokens, which are
    genuinely never legitimate in message content and stay always-block. The
    plain-text turn marker moved to a new role_tag_text category that is
    tool-role-blocked rather than always-blocked: 1.2.0's version hard-blocked
    `user: root` in any compose file and any quoted `Human:`/`Assistant:`
    transcript, in every role. It is now column-0 and capitalized, which is
    the completions-API turn format and not an indented lowercase YAML key.
  - instruction_override: `you are now \\w+` fired on "You are now ready to
    deploy" and is narrowed to explicit persona-switch framing. Open-ended
    persona manipulation is Layer 2's job -- it can read intent; a regex
    cannot.
  - severity() now treats `function` and `ipython` as tool-like alongside
    `tool`. Matching the literal string "tool" let a client relabel a message
    with either real-world tool-result role name and get flag-only treatment
    for content that would otherwise block.

  Net, measured: live index 1,530 -> 29 blocked (1.92% -> 0.04%); this repo's
  markdown 779 -> 42 of 809 chunks; 20/20 attack samples still detected.
  Known and accepted limitation: text *quoting* an attack ("attackers type:
  ignore previous instructions") still matches. That is inherent to pattern
  matching -- the quote and the attack are the same string -- and Layer 2 has
  the same property. Security documentation is expected to trip this.

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
    content (a chat-template control token or a bidi override has no honest
    reason to appear inside a message's `content` string) -> always "block".
    Note this is the narrow set: a plain-text `Human:` turn marker is
    role_tag_text, not role_spoof, and is NOT always-blocked -- quoting a
    transcript is ordinary document content. See the 1.3.0 changelog.
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
    / role_tag_text hits in a `user` message: expected and often legitimate
    (debugging help, quoting a transcript, or someone just asking what the
    model's instructions are) -> "flag" only, never a hard block on this
    signal alone.

"Tool-originated" means any role in _TOOL_LIKE_ROLES (`tool`, `function`,
`ipython`), not the literal string "tool" -- see the 1.3.0 changelog.

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
# A shell metacharacter is NOT by itself a signal here -- see the 1.3.0
# changelog. Every pattern below requires an actual dangerous construct, not
# just the syntax that could carry one. `_DANGEROUS` is the payload half,
# reused by the substitution patterns so a bare `$(date)` or an inline
# markdown code span doesn't fire.
_DANGEROUS = r'(?:\brm\s+-[a-z]*[rf]\b|\bnc\b|\bnetcat\b|\bbash\b|/bin/sh\b|\bchmod\s+[0-7]{3,4}\b|\bchown\b|\bdd\s+if=|\bmkfs\b|\beval\s*[("\'$]|/etc/(?:passwd|shadow))'

CMD_INJECTION = [
    # Command substitution, but only when it carries something dangerous --
    # `$(date)` and a markdown span like `ls -la` are not injection. Newlines
    # excluded on purpose: a real substitution is one line, while allowing
    # them made a ```bash fenced code block match its own language tag.
    rf'(?i)\$\([^)\n]*{_DANGEROUS}[^)\n]*\)',
    rf'(?i)`[^`\n]*{_DANGEROUS}[^`\n]*`',
    # Chained/backgrounded execution of a destructive or fetching command.
    # Each alternative requires a real argument rather than ending at a word
    # boundary: `| bash |` in a markdown table row is a table cell, not a
    # pipeline, and a trailing \b here also silently failed to match `rm -rf`
    # (the boundary after `-r` falls mid-word). See the 1.3.0 changelog.
    r'(?i)[;&|]{1,2}\s*(rm\s+-[a-z]*[rf]|curl\s+[^\s|]|wget\s+[^\s|]|nc\s+-|bash\s+[-/]'
    r'|/bin/sh\b|chmod\s+[0-7]{3,4}|chown\s+\S|dd\s+if=|mkfs\b|sudo\s+rm\b)',
    r'(?i)\b(curl|wget)\s+\S+(?:\s+\S+){0,4}\s*\|\s*(sh|bash)\b',  # curl|sh / wget|sh, flags tolerated
    r'(?i)\bnc\s+-e\b',                                     # netcat reverse shell
    r'(?i)\b(bash|sh)\s+-i\s+>&\s*/dev/tcp/',               # bash /dev/tcp reverse shell
    r'(?i)/etc/shadow\b',                                   # /etc/passwd alone is too common in docs
    r'(?i)\bbase64\s+(-d|--decode)\b.{0,20}\|\s*(sh|bash)',
]

SQL_INJECTION = [
    r"(?i)\bunion\b.{0,40}\bselect\b",
    r"(?i)['\"]\s*or\s+['\"]?\d+['\"]?\s*=\s*['\"]?\d+['\"]?",   # ' OR '1'='1
    r"(?i);\s*drop\s+table\b",
    r"(?i)\bxp_cmdshell\b",
    r"(?i)(?<!\.)\bsleep\s*\(\s*\d+",              # excludes time.sleep(/asyncio.sleep( method calls
    r"(?i)\bbenchmark\s*\(\s*\d+\s*,",             # MySQL BENCHMARK(count, expr) always takes 2 args --
                                                    # excludes the English word "benchmark" followed by
                                                    # a parenthetical, e.g. this project's own changelog
                                                    # convention "benchmark (2026-08-26 -- ...)"
    r"(?i)\bwaitfor\s+delay\b",
]

# Structural spoofing — chat-template control tokens. Never legitimate in a
# message's content string regardless of role: these are tokenizer-level
# delimiters, not something prose or documentation contains.
ROLE_SPOOF = [
    r"<\|im_start\|>|<\|im_end\|>",
    r"<\|(system|user|assistant)\|>",                       # ChatML-adjacent role tags
    r"<<SYS>>|<</SYS>>",                                    # Llama-2 system delimiters
    r"\[INST\]|\[/INST\]",
    r"</?think>",
]

# A plain-text turn marker (`\n\nHuman:`) is a weaker signal than a control
# token -- it is also just how transcripts, chat logs and YAML are written.
# Deliberately NOT in _ALWAYS_BLOCK; see the 1.3.0 changelog. Column-0 and
# capitalized on purpose: that is the completions-API turn format, and it is
# what separates an injected turn marker from an indented lowercase
# `  user: root` in a compose file.
ROLE_TAG_TEXT = [
    r"(?m)^(Human|Assistant|System)\s*:\s",
    r"(?i)###\s*(system|instruction)\b",
]

UNICODE_SMUGGLING = [
    r"[\u202A-\u202E\u2066-\u2069]",     # bidi override/isolate: Trojan-Source style spoofing
    # A single invisible character is encoding noise, not an attack -- PDF and
    # HTML extraction emit ZWSP constantly (118k occurrences across this
    # fleet's own podcast corpus, every one of them isolated). Concealment
    # needs a RUN: encoding a payload in zero-width characters takes dozens of
    # them in a row. Measured on 79,878 live chunks: max legitimate run = 2,
    # zero runs of 3+. So {3,} costs no real detection and clears every one of
    # those false positives. ZWJ (200D) and ZWNJ (200C) are excluded entirely --
    # ZWJ joins emoji sequences, and both are required for correct
    # Persian/Arabic/Indic rendering. See the 1.3.0 changelog.
    r"[\u200B\u2060]{3,}",
    r"(?<!\A)\uFEFF",                    # BOM mid-text is anomalous; a leading BOM is just file encoding
    r"[\U000E0000-\U000E007F]",          # Unicode tag block (ASCII smuggling) -- never legitimate, no threshold
]

# Semantic-but-still-pattern-matchable phrasing — catches the unsophisticated
# attacker before Layer 2 (Prompt Guard 2) would ever need to run.
INSTRUCTION_OVERRIDE = [
    r"(?i)\bignore\s+(all\s+)?(previous|above|prior)\s+instructions\b",
    r"(?i)\bignore\s+(everything|all)\s+(above|before\s+this)\b",
    r"(?i)\bdisregard\s+(the\s+)?(system\s+)?prompt\b",
    r"(?i)\bforget\s+(your|all|previous)\s+instructions\b",
    r"(?i)\bnew\s+instructions\s*:",
    # Persona-switch framing. Narrowed from a bare `you are now \w+`, which
    # fired on ordinary tutorial prose ("You are now ready to deploy") -- the
    # open-ended version of this belongs to Layer 2, which can read intent.
    r"(?i)\byou\s+are\s+now\s+(a\s+|an\s+|in\s+)?(dan\b|jailbroken|unrestricted|uncensored|developer\s+mode|god\s+mode|do\s+anything)",
    r"(?i)\b(pretend|act)\s+(you\s+(are|have)|as\s+if)\b.{0,40}\b(no\s+(restrictions|rules|filter)|unrestricted|jailbroken)",
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
    "role_tag_text": ROLE_TAG_TEXT,
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
# about their own conversation. role_tag_text is here rather than in
# _ALWAYS_BLOCK because a quoted transcript is ordinary document content.
_TOOL_ROLE_BLOCK = {"cmd_injection", "sql_injection", "instruction_override",
                    "prompt_exfiltration", "role_tag_text"}

# Roles whose content the model is *reading* rather than a human typing it.
# Matching only the literal string "tool" let a client relabel a message
# `function`/`ipython` (both real tool-result role names in the wild) and get
# flag-only treatment for content that would otherwise block -- see 1.3.0.
_TOOL_LIKE_ROLES = {"tool", "function", "ipython"}


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
    if role in _TOOL_LIKE_ROLES and (_TOOL_ROLE_BLOCK & hits.keys()):
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
