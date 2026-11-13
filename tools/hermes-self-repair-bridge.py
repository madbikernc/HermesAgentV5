#!/usr/bin/env python3
# Version: 2.5.0
#
# 2.5.0 (2026-11-13) — direct operator request (self-repair fidelity pass). What the bridge
# submits, and how, was the source of most of the pipeline's misses:
#   * The test task is written AFTER the fix, from its diff. Before, both were submitted at the
#     same moment and the test task got one line of text, never the fix -- and when it died the
#     fix waited forever. Now the fix goes alone with a `test-plan` turn naming the test file;
#     sweep_pending_tests() submits the test task once that fix has passed verification and is
#     parked in awaiting-completeness, its problem carrying the applied diff, and links the two.
#   * The fix target is where the log line comes from. locate_emitter() searches the domain's
#     source for the line's literal text (read tool `grep`) and takes the file that emits it;
#     the model is asked only when nothing matches. An emitter over MAX_FILE_CHARS (index.js,
#     actions.js) is skipped and logged, not handed to the model to pick a smaller file instead
#     (goals.js was picked three times for index.js's "giving up on goal").
#   * The fix problem carries the emitting code (EMITTER_CONTEXT_LINES either side) and the bot's
#     recent log lines before the incident (hermes-minecraft-triage.py 1.8.0's `recent log`).
#   * One failure, one signature: a bot crash (process-exit, either systemd line, any bot) is one
#     signature, and a crash within OOM_GROUP_SECONDS of the same bot's OOM is that OOM, not its
#     own incident -- process-exit findings wait PROCESS_EXIT_DEFER_SECONDS for the OOM to arrive.
#     "giving up on goal" is one signature, not one per goal text.
#   * "incomplete" and "verify-failed" are retryable, like "error" (hermes-self-repair-apply.py
#     2.0.0 now produces both for a real failure).
#   * Every finding, submission and skip reason is recorded to hermes_self_repair_outcomes.py.
#
# 2.4.1 (2026-11-13) — a record written before 2.4.0 has no `attempts`; retry_reason() already
# counts it as 1, but record_signature_submission() counted it as 0, so its first retry was
# recorded as attempt 1 and the signature got one submission past SIGNATURE_MAX_ATTEMPTS. Both
# now read a missing count as 1.
#
# 2.4.0 (2026-11-12) — direct operator request: a signature whose task died on a pipeline error
# was never tried again. should_submit() skipped any recorded signature for good, so when the
# generator's router calls started failing (HTTP 400/502, 2026-11-12), `[goal-abandoned]`'s fix
# task 26b36ed9 went to `error` and the bridge has logged "already submitted" for it ever since.
# A recorded signature is now resubmitted when its fix or test task ended in `error` and nothing
# has reached a human decision (`verified`/`promotion-approved`/`promoted`/`promotion-declined`),
# at most SIGNATURE_MAX_ATTEMPTS times in all and no sooner than SIGNATURE_RETRY_SECONDS after the
# last submission -- an error that repeats every time (a file over MAX_FILE_CHARS) is retried
# twice more, not every poll. The states are only looked up once that interval has passed, so the
# per-minute skips stay free. `unresolved` (the models never agreed) and `blocked` (intake
# screening) are not retried: neither is a transient failure.
#
# 2.3.0 (2026-11-10) — the linked test task no longer targets services/minecraft-bots/tests/
# unit.test.mjs: at 363k chars it was always refused by the generator's MAX_FILE_CHARS (every
# test task from 2.2.0's first live run went to `error`, so no fix could leave
# awaiting-completeness). The unit checks are now split into per-area files under
# tests/unit/, each under that limit, and the test task targets one of them, picked by the same
# validated model call as the fix path (ask_model_for_path(), now given the fix path and the
# test-file candidates only). No valid test file -> the incident is skipped and not recorded,
# so its next occurrence tries again.
#
# 2.2.0 (2026-11-10) — direct operator request ("repeat failures that have never been submitted
# should get submitted"): should_submit() gated minecraft-bots findings on triage's own occurrence
# counter being exactly 1. Triage had been counting since long before this bridge was installed
# (2026-11-08), and the bridge seeds its cursor at the topic's tip, so every failure already
# repeating by then -- `[stuck-path]` at 4000-6000+ occurrences, `[goal-abandoned]` -- could
# never be submitted, while the skip log claimed "a task was already considered". The bridge now
# keeps its own record (state key `"submitted_signatures"`, keyed by finding_signature():
# category + normalized source line, bot tag dropped, so one failure across nine bots is one
# task): a signature at or above MIN_SEVERITY is submitted the first time it arrives with no
# record, and never again once recorded. The triage count no longer gates anything.
#
# 2.1.0 (2026-11-08) — real gap found while preparing to flip egress-guard's switch on (direct
# operator request to fix before going live, not live traffic yet): unlike minecraft-bots, whose
# triage source does its own occurrence-counting dedup, tools/hermes_egress_guard.py's own
# `_record_denial()` writes a fresh turn on EVERY denial, unconditionally — no rate-limiting
# anywhere upstream. A caller stuck in a retry loop against a denied destination would have had a
# new self-repair task submitted for it every poll cycle, bounded only by the per-cycle submission
# budget (shared with minecraft-bots). Added a per-caller cooldown (`egress_cooldown_active()`,
# `record_egress_submission()`, state key `"egress_cooldown"`): a new submission is skipped while
# BOTH (a) the prior task submitted for this same caller is still actively progressing
# (`task_is_active()` — drafting/review/security/verify/awaiting a promotion decision) AND (b)
# fewer than EGRESS_COOLDOWN_SECONDS (default 3600) have passed since it was submitted. Either
# condition alone ends the cooldown: a concluded task releases it immediately (no reason to keep
# waiting once a human has already decided or the pipeline has already given up), and the time
# window is a backstop independent of being able to read the task's state at all (e.g. if
# hermes-memory is briefly unreachable — fetch_task_state_or_none() then returns a sentinel
# `task_is_active()` treats as still-active, the conservative direction, with the time window as
# the only way out). All handlers now take `state` as a fourth argument (HANDLERS' own call
# signature, both source pollers updated) so a handler can read/write bridge-wide cursor state for
# exactly this kind of per-domain bookkeeping — minecraft-bots' own handler does not yet use it.
#
# 2.0.0 (2026-11-08) — FLEET_SELFREPAIR_DESIGN.md §8.4's genericity acceptance check (Phase 4):
# renamed from hermes-self-repair-minecraft-bridge.py. Registering a real second domain
# (egress-guard) surfaced a real genericity leak Phase 3 left behind: this file's own poll_once()
# only knew how to extract a Buzz topic from a detection_source string
# (`if not source.startswith("buzz:"): continue`) — a domain whose detection source is shaped
# differently (egress-guard's denials are hermes-memory `turns` rows, not Buzz messages) was
# registered in HANDLERS correctly but then silently skipped by the orchestration loop itself.
# §4.4's own original text already called for exactly one generic bridge ("not one bridge per
# domain"); this restructuring is what actually delivers that, rather than assuming the first
# domain's own shape was the general case. poll_once() now dispatches by a source's SCHEME (the
# part before the first `:`) to SOURCE_POLLERS, not just "buzz"; HANDLERS stays keyed by the full
# detection_source string exactly as before — no change to any domain's own registration or to any
# existing handler's own logic. Added `poll_domain_memory_turns_source()` (egress-guard's own
# shape: a durable, autoincrement-id cursor over hermes-memory's own sqlite `turns` table, read
# the same `ro_sqlite()`-style direct-sqlite way `hermes-fleetops-ui.py`'s own
# `read_egress_blocks()` already does, since there's no cheap live route for "give me only the
# turns after id N" otherwise) and `handle_egress_guard_denial()` (no model path-resolution call
# needed at all — `caller` already names the real offending script's basename; resolved against
# the real repo via the read tool's own `read` op across every allowlisted prefix, never guessed).
# Same bootstrap/budget protections as 1.1.0, generalized: `seek_to_end_memory_turns()` mirrors
# `seek_to_end()`'s own "seed at the current tip, never replay history" contract for this source
# shape, and the existing BudgetExhausted/MAX_SUBMISSIONS_PER_POLL mechanism is shared by every
# source poller, not reimplemented per scheme.
#
# hermes-self-repair-bridge — FLEET_SELFREPAIR_DESIGN.md §4.4's detection -> self-repair submission
# bridge, generic across every registered domain. The orchestration loop (poll_once()/main())
# iterates every domain whose switch is on (hermes_self_repair_domains.domain_switch_on()), looks
# up a poller by that domain's own detection_source SCHEME (SOURCE_POLLERS, keyed by the text
# before the first `:` — "buzz", "memory-turns"), and that poller looks up a handler by the domain's
# full detection_source string (HANDLERS). Two concrete instances exist today:
#
#   - "buzz:minecraft-ops" (domain #1, minecraft-bots): triage's own coder/coder2 calls are asked
#     for severity/cause/next-step prose about a log line, never a file path
#     (tools/hermes-minecraft-triage.py's own call_role() prompt has no path-naming instruction at
#     all) — handle_minecraft_bots_buzz() is what actually names one, via a model call (reusing
#     ROUTER_URL, `X-Hermes-Screening: analysis` set the same reason triage's own call already sets
#     it) whose answer is NEVER trusted directly: it must exactly match a real file from
#     hermes-self-repair-read.py's `list` operation, or the finding is skipped rather than guessed
#     through. Per the domain's completeness rule ("test-artifact"), every finding submits TWO
#     linked tasks (fix + test, hermes-self-repair-link.py's own logic) — both go through Steps 2-4
#     completely unmodified, same as any other self-repair task.
#   - "memory-turns:egress-block" (domain #2, egress-guard): tools/hermes_egress_guard.py's own
#     `_record_denial()` already writes a structured (caller/attempted/reason) turn per denial —
#     handle_egress_guard_denial() needs no model guess at all, since `caller` already names the
#     real offending script's basename. Resolved to a real repo path by trying the read tool's own
#     `read` operation across every allowlisted prefix; a caller that resolves to nothing real, or
#     to tools/hermes_egress_guard.py itself (this mechanism must never generate a task asking to
#     change the security control that reported the denial), is refused, not guessed at. This
#     domain registers no completeness rule (§4.3's own "a domain with no rule beyond Step 4's
#     baseline simply registers none") — one task, no link, per finding.
#
# A future third domain with a still-differently-shaped detection source registers its own entry in
# SOURCE_POLLERS (if the shape is new) and HANDLERS (always) — this file's own poll_once() does not
# change for that either. If a third domain's own shape ever again breaks that, FLEET_SELFREPAIR_
# DESIGN.md §8.4's check has done its job a second time.
#
# **This bridge is the only thing that can feed self-repair automatically, for any domain** --
# chat and hermes-dispatch.py still cannot (Step 8's own boundary, preserved). It is gated
# per-domain by that domain's own self_managed switch (domains.json).
#
# Usage: a long-running poll loop (python3 hermes-self-repair-bridge.py), same shape as
# hermes-self-repair-apply.py/-generate.py -- meant to run as a systemd service
# (hermes-self-repair-bridge.service, alongside this file).
#
# Config:
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN   required, same as every other self-repair piece
#   MEMORY_DB                   default /mnt/hermes-data/memory/memory.db -- direct read-only
#                               sqlite access for the memory-turns source poller (same reason
#                               hermes-fleetops-ui.py's own read_egress_blocks() uses it: no cheap
#                               live route for "turns after id N" otherwise)
#   ROUTER_URL                 default http://127.0.0.1:8080 -- for minecraft-bots' path-resolution
#                               call only; egress-guard's own handler never calls a model
#   SELF_REPAIR_READ_TOOL       default ~/HermesAgentV5/tools/hermes-self-repair-read.py -- used
#                               (as a subprocess, never imported) for its `list`/`read` operations,
#                               to validate a path before ever trusting it
#   POLL_SECONDS                default 20 -- how often each on-switch domain's source is polled
#   MIN_SEVERITY                default "medium" -- minecraft-bots only; "low"/"unknown" triage
#                               findings are never acted on
#   MAX_SUBMISSIONS_PER_POLL    default 3 -- a per-cycle safety valve shared by every source, not
#                               §6's own still-open "daily action cap" question
#   EGRESS_COOLDOWN_SECONDS     default 3600 -- egress-guard only; a caller with an actively-
#                               progressing task already submitted for it is never given a second
#                               one, and even once it concludes, a new one waits out the rest of
#                               this window (1.1.0/2.1.0's bootstrap/budget protections cover the
#                               cross-domain burst case; this covers one caller looping on its own)
#   SIGNATURE_RETRY_SECONDS     default 3600 -- minecraft-bots only; a recorded signature whose
#                               task ended in `error` is resubmitted no sooner than this (2.4.0)
#   SIGNATURE_MAX_ATTEMPTS      default 3 -- submissions per signature in all, retries included
#   MAX_FILE_CHARS              default 40000 -- same as the generator's; an emitter over it is
#                               skipped rather than substituted (2.5.0)
#   SWEEP_SECONDS               default 300 -- how often sweep_pending_tests() looks for fixes
#                               waiting on a test task to be written
#   OOM_GROUP_SECONDS           default 600 -- a bot crash this soon after its OOM is that OOM
#   PROCESS_EXIT_DEFER_SECONDS  default 120 -- how long a crash waits for its OOM to arrive
#   BRIDGE_STATE_DIR            default ~/.hermes/state/selfrepair-bridge -- durable cursor per
#                               source so a restart never re-processes old findings, and a source
#                               with no cursor yet is seeded at its current tip, never replayed
#                               from the beginning of its history

import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_self_repair_domains as domains_mod
import hermes_self_repair_outcomes as outcomes  # noqa: E402

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
MEMORY_DB = os.environ.get("MEMORY_DB", "/mnt/hermes-data/memory/memory.db")
ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")
SELF_REPAIR_READ_TOOL = os.environ.get(
    "SELF_REPAIR_READ_TOOL", str(Path.home() / "HermesAgentV5" / "tools" / "hermes-self-repair-read.py"))
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "20"))
SEVERITY_RANK = {"low": 0, "unknown": 0, "medium": 1, "high": 2}
MIN_SEVERITY_RANK = SEVERITY_RANK[os.environ.get("MIN_SEVERITY", "medium")]
MAX_SUBMISSIONS_PER_POLL = int(os.environ.get("MAX_SUBMISSIONS_PER_POLL", "3"))
EGRESS_COOLDOWN_SECONDS = int(os.environ.get("EGRESS_COOLDOWN_SECONDS", "3600"))
SIGNATURE_RETRY_SECONDS = int(os.environ.get("SIGNATURE_RETRY_SECONDS", "3600"))
SIGNATURE_MAX_ATTEMPTS = int(os.environ.get("SIGNATURE_MAX_ATTEMPTS", "3"))
MAX_FILE_CHARS = int(os.environ.get("MAX_FILE_CHARS", "40000"))  # hermes-self-repair-generate.py's own
SWEEP_SECONDS = int(os.environ.get("SWEEP_SECONDS", "300"))
OOM_GROUP_SECONDS = int(os.environ.get("OOM_GROUP_SECONDS", "600"))
PROCESS_EXIT_DEFER_SECONDS = int(os.environ.get("PROCESS_EXIT_DEFER_SECONDS", "120"))
EMITTER_CONTEXT_LINES = 20
MAX_TEST_DIFF_CHARS = 8000
RETRYABLE_TASK_STATES = {"error", "incomplete", "verify-failed"}
now_fn = time.time  # the offline tests replace this
STATE_DIR = Path(os.environ.get(
    "BRIDGE_STATE_DIR", str(Path.home() / ".hermes" / "state" / "selfrepair-bridge")))
BRIDGE_AGENT = "selfrepair-bridge"
# "selfrepair" (not "selfrepair-bridge") deliberately -- the identity Buzz's own KNOWN_AGENTS
# allowlist already has registered (hermes-self-repair-generate.py's publish_result() already
# posts as this identity live), so this bridge needs zero live hermes-buzz.py config change to
# work. hermes-memory's own "agent" field (BRIDGE_AGENT above) is unconstrained free text, so that
# one IS its own honest, distinct identity.
BUZZ_FROM = "selfrepair"
EGRESS_GUARD_OWN_MODULE = "hermes_egress_guard.py"


class BudgetExhausted(Exception):
    """Raised by a handler when MAX_SUBMISSIONS_PER_POLL is already spent this cycle -- the
    finding that triggered it is left unprocessed (cursor not advanced past it), so it's retried
    next cycle rather than lost. Shared by every source poller, not reimplemented per scheme."""


def log(msg):
    print(f"[hermes-self-repair-bridge] {msg}", flush=True)


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _post(url, payload, token=None, timeout=15, extra_headers=None):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", **(extra_headers or {})},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def ro_sqlite(path):
    """Same read-only, no-lock-risk connection every other direct-sqlite reader in this fleet
    already uses (hermes-fleetops-ui.py, hermes-self-repair-list.py)."""
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


# --- State (a cursor per source, durable across restarts) ---------------------------------------

def load_state():
    f = STATE_DIR / "state.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text())
    except Exception:
        return {}


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "state.json").write_text(json.dumps(state))


# --- Pure parsing/decision logic for minecraft-bots (offline-testable, no network) --------------

_HEADER_RE = re.compile(r"^\[(?P<category>[^\]]+)\]\s*(?P<label>.*)$")
_ROLE_RE = re.compile(r"^\s*(?P<role>coder2?):\s*severity=(?P<sev>\w+)\s+cause=(?P<cause>.*?)\s+next=(?P<next>.*)$")
_SOURCE_LINE_RE = re.compile(r"^\s*source line:\s*(?P<line>.*)$")
_OCCURRENCES_RE = re.compile(r"occurrences for this bot\+signature:\s*(?P<count>\d+)")
_CONTEXT_HEADER_RE = re.compile(r"^\s*recent log\b")


def parse_triage_body(body):
    """Returns a dict ({"category", "label", "roles": {role: {severity, cause, next}},
    "disagreement", "source_line", "occurrences"}) or None if the body doesn't even have a
    parseable [category] label header -- tools/hermes-minecraft-triage.py's own
    triage_incident()/diagnosis_worker() is the only producer of this shape, but a malformed or
    unexpected body is an honest "can't parse this, skip it", never a guess."""
    lines = body.splitlines()
    if not lines:
        return None
    header = _HEADER_RE.match(lines[0])
    if not header:
        return None
    parsed = {
        "category": header.group("category"), "label": header.group("label").strip(),
        "roles": {}, "disagreement": False, "source_line": None, "occurrences": 1, "context": [],
    }
    in_context = False
    for line in lines[1:]:
        if in_context and line.startswith("    "):
            parsed["context"].append(line.strip())
            continue
        in_context = False
        if _CONTEXT_HEADER_RE.match(line):
            in_context = True
            continue
        role_match = _ROLE_RE.match(line)
        if role_match:
            parsed["roles"][role_match.group("role")] = {
                "severity": role_match.group("sev").lower(),
                "cause": role_match.group("cause").strip(),
                "next": role_match.group("next").strip(),
            }
            continue
        if "DISAGREEMENT" in line:
            parsed["disagreement"] = True
            continue
        source_match = _SOURCE_LINE_RE.match(line)
        if source_match:
            parsed["source_line"] = source_match.group("line").strip()
            continue
        occ_match = _OCCURRENCES_RE.search(line)
        if occ_match:
            parsed["occurrences"] = int(occ_match.group("count"))
    return parsed


def max_severity_rank(parsed):
    ranks = [SEVERITY_RANK.get(r.get("severity", "unknown"), 0) for r in parsed["roles"].values()]
    return max(ranks) if ranks else 0


def finding_signature(parsed):
    """Fleet-wide key for one kind of incident: the category plus the source line with its
    leading "[Bot]" tag dropped and numbers collapsed (same collapsing as triage's own
    normalize_signature()), so the same failure on nine bots is one signature, not nine."""
    line = re.sub(r"^\[[^\]]*\]\s*", "", (parsed.get("source_line") or "").strip())
    category = parsed["category"]
    if category == "process-exit":
        # Two systemd lines per crash ("Main process exited, code=dumped" and "Failed with result
        # 'core-dump'"), one unit per bot: one signature for a bot crash, whichever bot (2.5.0).
        line = ("minecraft-bot-X.service: crashed (core dump)" if "dump" in line
                else re.sub(r"minecraft-bot-[\w-]+", "minecraft-bot-X", line))
    elif category == "goal-abandoned":
        line = re.sub(r"(giving up on goal after \S+ failures).*", r"\1", line)
    line = re.sub(r"\s+", " ", re.sub(r"\d+(\.\d+)?", "N", line))[:160]
    return f"{category}|{line}"


def finding_bot(parsed):
    """The bot a finding is about, lowercased, from its "[Name]" tag or its minecraft-bot-<name>
    unit -- or None."""
    line = parsed.get("source_line") or ""
    m = re.match(r"^\[([A-Za-z]+)\]", line.strip()) or re.search(r"minecraft-bot-([a-z]+)\.service", line)
    return m.group(1).lower() if m else None


HUMAN_DECIDED_TASK_STATES = {"verified", "promotion-approved", "promoted", "promotion-declined"}


def retry_reason(record, now):
    """A reason string if this recorded signature's tasks died on a pipeline error and it may be
    submitted again (2.4.0), else None."""
    attempts = record.get("attempts", 1)
    if attempts >= SIGNATURE_MAX_ATTEMPTS:
        return None
    if now - record.get("submitted_at", 0) < SIGNATURE_RETRY_SECONDS:
        return None
    states = [fetch_task_state_or_none(record[k]) for k in ("fix", "test") if record.get(k)]
    if not any(st in RETRYABLE_TASK_STATES for st in states) or any(st in HUMAN_DECIDED_TASK_STATES for st in states):
        return None
    failed = next(st for st in states if st in RETRYABLE_TASK_STATES)
    return (f"retrying: task {record.get('fix')} ended {failed} "
            f"(attempt {attempts + 1} of {SIGNATURE_MAX_ATTEMPTS})")


def should_submit(parsed, state, now=None):
    """Returns (ok: bool, reason: str). A signature at or above MIN_SEVERITY, from either role,
    is submitted once, the first time the bridge sees it with no task recorded for it in its own
    state (`submitted_signatures`) -- whatever triage's occurrence count says. Triage counted
    occurrences long before this bridge existed, so gating on that count == 1 meant a failure
    that was already repeating when the bridge started could never be submitted at all."""
    if parsed is None:
        return False, "unparseable triage body"
    if max_severity_rank(parsed) < MIN_SEVERITY_RANK:
        return False, f"below MIN_SEVERITY (roles: {parsed['roles']})"
    record = (state.get("submitted_signatures") or {}).get(finding_signature(parsed))
    if record:
        retry = retry_reason(record, time.time() if now is None else now)
        if retry:
            return True, retry
        return False, f"already submitted for this signature (fix task {record.get('fix')})"
    return True, "never submitted for this signature, severity threshold met"


def record_signature_submission(state, parsed, fix_task_id, test_task_id, now, test_path=None,
                                fix_path=None):
    signatures = state.setdefault("submitted_signatures", {})
    previous = signatures.get(finding_signature(parsed)) or {}
    signatures[finding_signature(parsed)] = {
        "fix": fix_task_id, "test": test_task_id, "submitted_at": now,
        "attempts": (previous.get("attempts", 1) + 1) if previous else 1,
        "test_path": test_path, "fix_path": fix_path,
        "category": parsed.get("category"), "label": parsed.get("label")}
    save_state(state)


def build_fix_problem(parsed, emitter=None):
    role_lines = [f"{role} assessed severity={info['severity']}, cause: {info['cause']}, suggested next step: {info['next']}"
                  for role, info in sorted(parsed["roles"].items())]
    lines = [
        f"Live Minecraft-bots incident, category={parsed['category']}: {parsed['label']}",
        *role_lines,
    ]
    if parsed["disagreement"]:
        lines.append("coder and coder2 disagreed on severity for this incident — treat with extra care.")
    if parsed["source_line"]:
        lines.append(f"Source log line: {parsed['source_line']}")
    if emitter:
        lines.append(f"\nThis log line is emitted at {emitter['path']}:{emitter['line']} -- the code there:\n"
                     f"{emitter['snippet']}")
    if parsed.get("context"):
        lines.append("\nThe bot's log lines just before the incident:\n" + "\n".join(parsed["context"]))
    return "\n".join(lines)


UNIT_TEST_DIR = "services/minecraft-bots/tests/unit/"


def test_candidates(candidates):
    """The per-area unit test files a test task may target -- never the shared _harness.mjs."""
    return [c for c in candidates if c.startswith(UNIT_TEST_DIR) and c.endswith(".test.mjs")]


def build_test_problem(parsed, fix_path, test_path, fix_diff=None):
    text = (
        f"Add or update a unit test in {test_path} (shared stubs and helpers are imported from "
        f"./_harness.mjs; import any more you need from there) that fails "
        f"against the current code and passes once {fix_path} is fixed for this incident "
        f"(category={parsed['category']}): {parsed['label']}"
    )
    if fix_diff is None:
        return text
    if len(fix_diff) > MAX_TEST_DIFF_CHARS:
        fix_diff = fix_diff[:MAX_TEST_DIFF_CHARS] + "\n... (diff truncated)"
    return (
        f"Add or update a unit test in {test_path} (shared stubs and helpers are imported from "
        f"./_harness.mjs; import any more you need from there) for the fix below, already applied "
        f"to {fix_path} for this incident (category={parsed['category']}): {parsed['label']}. "
        f"The test must PASS with this fix and FAIL with {fix_path} as it was before the diff -- "
        f"it is run both ways, and a test that passes either way is rejected. Exercise the "
        f"behavior the diff changes, through the code path the diff touches.\n\n"
        f"The fix (unified diff):\n{fix_diff}"
    )


def resolve_target_path(model_answer, candidates):
    """The model's raw answer is NEVER trusted directly -- must be an exact match (after a strip)
    against the real file listing, or this returns None. `candidates` is the exact line-list
    `hermes-self-repair-read.py list ...` printed."""
    if not model_answer:
        return None
    answer = model_answer.strip()
    if answer.upper() == "NONE":
        return None
    return answer if answer in candidates else None


def build_egress_problem(payload):
    caller = payload.get("caller") or "(unknown caller)"
    attempted = payload.get("attempted") or "(unknown destination)"
    reason = payload.get("reason") or "(no reason recorded)"
    return (
        f"hermes-egress-guard denied an outbound call from {caller} to {attempted} "
        f"(reason: {reason}). Fix {caller}'s OWN behavior so it no longer needs this destination, "
        f"or (only if the destination is genuinely required for this script's real job) register "
        f"it correctly in the egress guard's tool registry via the normal registry process -- "
        f"NEVER weaken, bypass, or special-case tools/hermes_egress_guard.py itself to stop "
        f"denying this. This incident is a security control doing its job; the fix belongs in the "
        f"caller, not the gate."
    )


# --- Network-touching glue (not offline-tested; see this file's own header) ---------------------

def list_candidate_paths():
    for root in ("services/minecraft-bots", "agents"):
        proc = subprocess.run(
            [sys.executable, SELF_REPAIR_READ_TOOL, "list", root],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode == 0:
            for line in proc.stdout.splitlines():
                line = line.strip()
                if line.endswith("PROMPT.md") and "/minecraft-" not in line:
                    continue  # not this domain's own agents, never offered as a candidate
                yield line


def ask_model_for_path(parsed, candidates, fix_path=None):
    listing = "\n".join(candidates)
    task = ("name the ONE file most likely responsible for this behavior" if fix_path is None else
            f"the fix goes in {fix_path}; name the ONE unit test file, by its area, where a test "
            f"for this fix belongs")
    prompt = (
        "A Minecraft bot fleet's own log triage flagged an incident. Given the diagnosis below and "
        f"the real list of files that exist in this codebase, {task}. "
        "Respond with EXACTLY one file path from the list below, "
        "character-for-character, and nothing else -- or respond with exactly NONE if you cannot "
        "tell.\n\n"
        f"Diagnosis:\n{build_fix_problem(parsed)}\n\n"
        f"Files:\n{listing}"
    )
    body = json.dumps({
        "model": "coder", "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 200, "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        f"{ROUTER_URL}/v1/chat/completions", data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Hermes-Screening": "analysis"})
    with urllib.request.urlopen(req, timeout=150) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"].strip()


def literal_fragments(source_line):
    """Literal stretches of a log line likely to appear verbatim in the source that emits it:
    split at numbers, quoted or parenthesised values and ": " (where a message's dynamic tail
    starts), stripped, 12+ chars, longest first, at most four."""
    line = re.sub(r"^\[[^\]]*\]\s*", "", (source_line or "").strip())
    parts = re.split(r"\d+(?:\.\d+)?|\([^)]*\)|'[^']*'|\"[^\"]*\"|`[^`]*`|:\s", line)
    frags = sorted({p.strip(" .,-") for p in parts if len(p.strip(" .,-")) >= 12}, key=len, reverse=True)
    return frags[:4]


def best_emitter(matches_by_fragment):
    """{fragment: [(path, line_no)]} -> (path, line_no) of the one file matching the most fragments,
    or None if nothing matched or two files tie. Test files never count as emitters."""
    score = {}
    first_line = {}
    for fragment, hits in matches_by_fragment.items():
        for path, line_no in hits:
            if "/tests/" in path or not path.endswith((".js", ".mjs", ".cjs")):
                continue
            if (fragment, path) in first_line:
                continue
            first_line[(fragment, path)] = line_no
            score[path] = score.get(path, 0) + 1
    if not score:
        return None
    ranked = sorted(score.items(), key=lambda kv: kv[1], reverse=True)
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        return None
    path = ranked[0][0]
    line_no = min(n for (f, p), n in first_line.items() if p == path)
    return path, line_no


def read_tool(*args):
    proc = subprocess.run([sys.executable, SELF_REPAIR_READ_TOOL, *args],
                          capture_output=True, text=True, timeout=60)
    return proc.returncode, proc.stdout


_EMITTER_CACHE = {}


def locate_emitter(parsed, root="services/minecraft-bots"):
    """{"path", "line", "size", "snippet"} for the file that emits this finding's log line, or None
    (2.5.0). Cached per signature for an hour -- the same failure repeats every minute."""
    sig = finding_signature(parsed)
    cached = _EMITTER_CACHE.get(sig)
    if cached and now_fn() - cached[0] < 3600:
        return cached[1]
    matches = {}
    for fragment in literal_fragments(parsed.get("source_line")):
        rc, out = read_tool("grep", re.escape(fragment), root)
        hits = []
        for row in out.splitlines() if rc == 0 else []:
            path, _, rest = row.partition(":")
            line_no, _, _ = rest.partition(":")
            if line_no.isdigit():
                hits.append((path, int(line_no)))
        matches[fragment] = hits
    found = best_emitter(matches)
    emitter = None
    if found:
        path, line_no = found
        rc, text = read_tool("read", path)
        if rc == 0:
            lines = text.splitlines()
            lo, hi = max(0, line_no - 1 - EMITTER_CONTEXT_LINES), min(len(lines), line_no + EMITTER_CONTEXT_LINES)
            snippet = "\n".join(f"{n + 1}: {lines[n]}" for n in range(lo, hi))
            emitter = {"path": path, "line": line_no, "size": len(text), "snippet": snippet}
    _EMITTER_CACHE[sig] = (now_fn(), emitter)
    return emitter


def write_test_plan_turn(task_id, test_path):
    _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": BRIDGE_AGENT, "role": "assistant",
        "raw": json.dumps({"phase": "test-plan", "test_path": test_path}),
    }, MEMORY_TOKEN)


def fetch_fix_diff(task_id):
    """The applied fix's diff (the generator's phase="diff" turn), or None."""
    try:
        turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=200", MEMORY_TOKEN).get("turns", [])
    except Exception as exc:
        log(f"fetch_fix_diff failed (task {task_id!r}): {exc}")
        return None
    for t in turns:
        try:
            payload = json.loads(t.get("raw") or "{}")
        except (ValueError, TypeError):
            continue
        if isinstance(payload, dict) and payload.get("phase") == "diff":
            return payload.get("content")
    return None


def sweep_pending_tests(state, budget):
    """Submits the test task for every recorded fix that passed verification and now waits on one
    (state awaiting-completeness, no test submitted yet), with the applied diff in its problem,
    and links the two (2.5.0). Returns how many it submitted."""
    submitted = 0
    for sig, rec in (state.get("submitted_signatures") or {}).items():
        if rec.get("test") or not rec.get("test_path") or not rec.get("fix"):
            continue
        if fetch_task_state_or_none(rec["fix"]) != "awaiting-completeness":
            continue
        if budget["remaining"] <= 0:
            break
        diff = fetch_fix_diff(rec["fix"])
        if not diff:
            continue
        parsed = {"category": rec.get("category") or sig.split("|", 1)[0], "label": rec.get("label") or ""}
        problem = build_test_problem(parsed, rec.get("fix_path") or "(the fix's file)", rec["test_path"], diff)
        try:
            test_id = submit_task(rec["test_path"], problem)
            write_link_turn(rec["fix"], "fix", test_id)
            write_link_turn(test_id, "test", rec["fix"])
        except Exception as exc:
            log(f"test submission for fix {rec['fix']} failed: {exc}")
            continue
        rec["test"] = test_id
        budget["remaining"] -= 1
        submitted += 1
        save_state(state)
        outcomes.record("submitted", task_id=test_id, role="test", path=rec["test_path"], signature=sig,
                        fix=rec["fix"])
        log(f"submitted test task {test_id} ({rec['test_path']}) for verified fix {rec['fix']}")
    return submitted


def process_deferred(state, budget):
    """Handles process-exit findings whose OOM window has passed (2.5.0)."""
    pending = state.get("deferred") or []
    keep = []
    for i, item in enumerate(pending):
        if now_fn() - item.get("at", 0) < PROCESS_EXIT_DEFER_SECONDS:
            keep.append(item)
            continue
        domain = next((d for d in domains_mod.load_domains() if d.get("name") == item.get("domain")),
                      {"name": item.get("domain")})
        try:
            handle_minecraft_bots_buzz({**item["finding"], "_deferred_at": item["at"]}, domain, budget, state)
        except BudgetExhausted:
            keep.extend(pending[i:])
            break
        except Exception as exc:
            log(f"deferred finding failed: {exc}")
    state["deferred"] = keep
    save_state(state)


def resolve_caller_path(caller):
    """No model call -- `caller` already names the real offending script's own basename
    (tools/hermes_egress_guard.py's own check_destination() docstring). Tried against every
    allowlisted top-level prefix via the read tool's own `read` operation, the same
    exists-and-is-allowlisted check every other self-repair path already goes through; the first
    prefix where that succeeds wins. Returns None (never a guess) if none do, or if the only match
    is the egress guard's own module -- this mechanism must never generate a task asking to change
    the security control that reported the denial."""
    if not caller or "/" in caller or caller in ("", ".", ".."):
        return None
    if caller == EGRESS_GUARD_OWN_MODULE or caller == EGRESS_GUARD_OWN_MODULE.replace("_", "-"):
        return None
    for prefix in ("tools", "services", "skills", "agents"):
        candidate = f"{prefix}/{caller}"
        proc = subprocess.run(
            [sys.executable, SELF_REPAIR_READ_TOOL, "read", candidate],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode == 0:
            return candidate
    return None


def task_exists(task_id):
    try:
        _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN)
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def submit_task(path, problem):
    """Same {"path", "problem"} spec shape and Buzz pointer-envelope
    hermes-self-repair-submit.py's own build_task()/submit() already use, with an honest
    "selfrepair-bridge" hermes-memory agent (instead of submit.py's "operator") and the already-
    KNOWN_AGENTS-registered "selfrepair" Buzz identity (see BUZZ_FROM's own comment above)."""
    import uuid
    task_id = uuid.uuid4().hex[:16]
    spec = json.dumps({"path": path, "problem": problem})
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": BRIDGE_AGENT, "role": "user", "raw": spec,
    }, MEMORY_TOKEN)
    _post(f"{BUZZ_URL}/messages", {
        "from": BUZZ_FROM, "topic": "selfrepair", "task_id": task_id, "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)
    return task_id


def write_link_turn(task_id, role, linked_task_id):
    _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": BRIDGE_AGENT, "role": "assistant",
        "raw": json.dumps({"phase": "completeness-link", "role": role, "linked_task_id": linked_task_id}),
    }, MEMORY_TOKEN)


ACTIVE_TASK_STATES = {
    "drafting", "third-party-review", "static-scan", "security-review",
    "security-meta-review", "done", "verified", "awaiting-completeness",
    "promotion-approved",
}
UNKNOWN_TASK_STATE = "__unknown__"  # lookup failed -- treated as active, the conservative direction


def task_is_active(state):
    """True if a task in this state is still actively progressing toward a human decision (or
    its state couldn't be determined at all -- fetch_task_state_or_none()'s own sentinel, treated
    as active so a transient hermes-memory outage doesn't cause a flood of duplicate submissions;
    EGRESS_COOLDOWN_SECONDS is the backstop for that case, not this function). False for every
    concluded state (blocked/error/unresolved/dead/verify-failed/promotion-declined/promoted/
    anything else not recognized as active) -- a concluded task releases the cooldown immediately,
    no reason to keep waiting once a human has decided or the pipeline has already given up."""
    if state is None:
        return False
    if state == UNKNOWN_TASK_STATE:
        return True
    if state in ACTIVE_TASK_STATES:
        return True
    return state.startswith("review-round-")


def fetch_task_state_or_none(task_id):
    try:
        return _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN).get("state")
    except Exception:
        return UNKNOWN_TASK_STATE


def egress_cooldown_active(caller, state, now):
    """Returns True if a new egress-guard submission for `caller` should be SKIPPED -- only when
    BOTH the prior task submitted for this caller is still actively progressing AND fewer than
    EGRESS_COOLDOWN_SECONDS have passed since it was submitted. Either condition alone ends the
    cooldown (see task_is_active()'s own docstring for why)."""
    record = (state.get("egress_cooldown") or {}).get(caller)
    if not record:
        return False
    if now - record.get("submitted_at", 0) >= EGRESS_COOLDOWN_SECONDS:
        return False
    return task_is_active(fetch_task_state_or_none(record.get("task_id")))


def record_egress_submission(state, caller, task_id, now):
    state.setdefault("egress_cooldown", {})[caller] = {"task_id": task_id, "submitted_at": now}
    save_state(state)


def handle_minecraft_bots_buzz(finding, domain, budget, state):
    body = finding.get("body", "")
    parsed = parse_triage_body(body)
    now = now_fn()
    sig = finding_signature(parsed) if parsed else None
    category = parsed["category"] if parsed else None

    def skip(reason):
        log(f"skipping incident ({reason}): {body[:120]!r}")
        outcomes.record("seen", signature=sig, category=category, submitted=False, reason=reason)

    bot = finding_bot(parsed) if parsed else None
    if category == "oom" and bot:
        state.setdefault("recent_oom", {})[bot] = now
    if category == "process-exit" and bot:
        happened_at = finding.get("_deferred_at", now)
        oom_at = (state.get("recent_oom") or {}).get(bot)
        if oom_at is not None and abs(happened_at - oom_at) <= OOM_GROUP_SECONDS:
            return skip(f"{bot} crashed {int(happened_at - oom_at)}s from its OOM -- the OOM's incident, not its own")
        if "_deferred_at" not in finding:
            state.setdefault("deferred", []).append({"finding": finding, "at": now, "domain": domain.get("name")})
            save_state(state)
            log(f"holding {bot}'s crash {PROCESS_EXIT_DEFER_SECONDS}s for an OOM it may follow")
            return

    ok, reason = should_submit(parsed, state)
    if not ok:
        return skip(reason)

    if budget["remaining"] <= 0:
        raise BudgetExhausted()

    candidates = list(list_candidate_paths())
    if not candidates:
        return skip("could not list any candidate files (read tool unavailable?)")

    emitter = locate_emitter(parsed)
    if emitter and emitter["size"] > MAX_FILE_CHARS:
        return skip(f"emitted by {emitter['path']}:{emitter['line']}, {emitter['size']} chars -- over "
                    f"MAX_FILE_CHARS={MAX_FILE_CHARS}, not a whole-file self-repair target")
    if emitter and emitter["path"] in candidates:
        fix_path = emitter["path"]
    else:
        emitter = None
        try:
            model_answer = ask_model_for_path(parsed, candidates)
        except Exception as exc:
            return skip(f"path-resolution call failed: {exc}")
        fix_path = resolve_target_path(model_answer, candidates)
        if not fix_path:
            return skip(f"model named no real/allowlisted path (answered {model_answer!r})")

    tests = test_candidates(candidates)
    try:
        test_answer = ask_model_for_path(parsed, tests, fix_path=fix_path)
    except Exception as exc:
        log(f"skipping incident: test-path resolution call failed: {exc}")
        return
    test_path = resolve_target_path(test_answer, tests)
    if not test_path:
        return skip(f"model named no real unit test file (answered {test_answer!r})")

    fix_problem = build_fix_problem(parsed, emitter)
    try:
        fix_task_id = submit_task(fix_path, fix_problem)
        write_test_plan_turn(fix_task_id, test_path)
    except Exception as exc:
        log(f"submission failed partway through: {exc} — a human should check for an orphaned task")
        return
    budget["remaining"] -= 1
    record_signature_submission(state, parsed, fix_task_id, None, now, test_path=test_path, fix_path=fix_path)
    attempt = state["submitted_signatures"][sig]["attempts"]
    outcomes.record("seen", signature=sig, category=category, submitted=True, reason=reason)
    outcomes.record("submitted", task_id=fix_task_id, role="fix", path=fix_path, signature=sig,
                    attempt=attempt, located="emitter" if emitter else "model")
    log(f"submitted fix={fix_task_id} ({fix_path}, {'emitter' if emitter else 'model-chosen'}); its "
        f"test task ({test_path}) follows once the fix verifies -- domain {domain.get('name')!r} "
        f"({budget['remaining']} submission(s) left this poll cycle)")


def handle_egress_guard_denial(finding, domain, budget, state):
    payload = finding.get("payload", {})
    caller = payload.get("caller")
    if not caller:
        log("skipping egress denial: no caller in payload")
        return

    now = time.time()
    if egress_cooldown_active(caller, state, now):
        log(f"skipping egress denial from {caller!r}: a task for this caller is already active "
            f"or was submitted too recently (EGRESS_COOLDOWN_SECONDS={EGRESS_COOLDOWN_SECONDS})")
        return

    if budget["remaining"] <= 0:
        raise BudgetExhausted()

    fix_path = resolve_caller_path(caller)
    if not fix_path:
        log(f"skipping egress denial: caller {caller!r} did not resolve to a real, allowlisted, "
            f"non-egress-guard path")
        return

    problem = build_egress_problem(payload)
    try:
        fix_task_id = submit_task(fix_path, problem)
    except Exception as exc:
        log(f"submission failed: {exc}")
        return
    budget["remaining"] -= 1
    record_egress_submission(state, caller, fix_task_id, now)
    log(f"submitted task {fix_task_id} ({fix_path}) for domain {domain.get('name')!r} "
        f"({budget['remaining']} submission(s) left this poll cycle)")


HANDLERS = {
    "buzz:minecraft-ops": handle_minecraft_bots_buzz,
    "memory-turns:egress-block": handle_egress_guard_denial,
}


# --- "buzz" source poller (Buzz topic, seq-ordered) ----------------------------------------------

def seek_to_end_buzz(topic):
    """Advances to the current tip of `topic` without processing anything -- called once, the
    first time this topic is ever polled (no persisted cursor yet), so a freshly-enabled bridge
    reacts only to incidents from the moment it actually started, never replays weeks of history
    as a flood of real model calls and real task submissions on first boot."""
    since = 0
    while True:
        resp = _get(f"{BUZZ_URL}/messages/poll?topic={topic}&since={since}&limit=200", BUZZ_TOKEN)
        messages = resp.get("messages", [])
        if not messages:
            return since
        since = max(m.get("seq", 0) for m in messages)
        if len(messages) < 200:
            return since


def poll_domain_buzz_source(domain, source_rest, state, budget):
    topic = source_rest
    cursor_key = f"buzz:{topic}"
    if cursor_key not in state:
        try:
            seeded_at = seek_to_end_buzz(topic)
        except Exception as exc:
            log(f"seek_to_end_buzz failed for topic {topic!r}: {exc} — will retry next poll")
            return
        state[cursor_key] = seeded_at
        save_state(state)
        log(f"first run for topic {topic!r} — seeded cursor at seq={seeded_at}, will not replay "
            f"its history")
        return  # nothing to process this cycle -- only genuinely new messages arrive from here

    since = state[cursor_key]
    try:
        resp = _get(f"{BUZZ_URL}/messages/poll?topic={topic}&since={since}&limit=50", BUZZ_TOKEN)
    except Exception as exc:
        log(f"poll failed for topic {topic!r}: {exc}")
        return
    messages = resp.get("messages", [])
    if not messages:
        return
    handler = HANDLERS[domain["detection_source"]]
    for message in messages:
        try:
            handler(message, domain, budget, state)
        except BudgetExhausted:
            log(f"MAX_SUBMISSIONS_PER_POLL reached — leaving message seq={message.get('seq')} and "
                f"any later ones in topic {topic!r} for the next poll cycle")
            break
        except Exception as exc:
            log(f"handler failed on message seq={message.get('seq')}: {exc}")
        state[cursor_key] = max(state.get(cursor_key, 0), message.get("seq", 0))
    save_state(state)


# --- "memory-turns" source poller (hermes-memory sqlite `turns`, id-ordered) ---------------------

def fetch_memory_turns(task_id, after_id, limit):
    """Direct read-only sqlite, the same `read_egress_blocks()`-style reason every other reader of
    a sentinel-task_id turns stream in this fleet already has: no cheap live HTTP route exists for
    "turns for this task_id with id > N", only a 500-row-capped, non-id-filterable one."""
    conn = ro_sqlite(MEMORY_DB)
    try:
        rows = conn.execute(
            "SELECT id, raw FROM turns WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
            (task_id, after_id, limit),
        ).fetchall()
    finally:
        conn.close()
    out = []
    for row_id, raw in rows:
        try:
            payload = json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        out.append({"id": row_id, "payload": payload})
    return out


def seek_to_end_memory_turns(task_id):
    """Same contract as seek_to_end_buzz(): the current max `id` for this task_id, found without
    ever handing a single row to a handler."""
    conn = ro_sqlite(MEMORY_DB)
    try:
        row = conn.execute("SELECT max(id) FROM turns WHERE task_id = ?", (task_id,)).fetchone()
    finally:
        conn.close()
    return row[0] if row and row[0] is not None else 0


def poll_domain_memory_turns_source(domain, source_rest, state, budget):
    task_id = source_rest
    cursor_key = f"memory-turns:{task_id}"
    if cursor_key not in state:
        try:
            seeded_at = seek_to_end_memory_turns(task_id)
        except Exception as exc:
            log(f"seek_to_end_memory_turns failed for task_id {task_id!r}: {exc} — will retry next poll")
            return
        state[cursor_key] = seeded_at
        save_state(state)
        log(f"first run for memory-turns task_id {task_id!r} — seeded cursor at id={seeded_at}, "
            f"will not replay its history")
        return

    since = state[cursor_key]
    try:
        findings = fetch_memory_turns(task_id, since, 50)
    except Exception as exc:
        log(f"poll failed for memory-turns task_id {task_id!r}: {exc}")
        return
    if not findings:
        return
    handler = HANDLERS[domain["detection_source"]]
    for finding in findings:
        try:
            handler(finding, domain, budget, state)
        except BudgetExhausted:
            log(f"MAX_SUBMISSIONS_PER_POLL reached — leaving turn id={finding['id']} and any later "
                f"ones for task_id {task_id!r} for the next poll cycle")
            break
        except Exception as exc:
            log(f"handler failed on turn id={finding['id']}: {exc}")
        state[cursor_key] = max(state.get(cursor_key, 0), finding["id"])
    save_state(state)


SOURCE_POLLERS = {
    "buzz": poll_domain_buzz_source,
    "memory-turns": poll_domain_memory_turns_source,
}


def poll_once(state):
    budget = {"remaining": MAX_SUBMISSIONS_PER_POLL}
    if state.get("deferred"):
        process_deferred(state, budget)
    if now_fn() - state.get("last_sweep", 0) >= SWEEP_SECONDS:
        state["last_sweep"] = now_fn()
        try:
            sweep_pending_tests(state, budget)
        except Exception as exc:
            log(f"sweep_pending_tests failed: {exc}")
    for domain in domains_mod.load_domains():
        if not domains_mod.domain_switch_on(domain):
            continue
        source = domain.get("detection_source", "")
        if source not in HANDLERS:
            log(f"domain {domain.get('name')!r} is switched on but names an unhandled "
                f"detection_source {source!r} — skipping, not guessing")
            continue
        if ":" not in source:
            log(f"domain {domain.get('name')!r} names a detection_source {source!r} with no "
                f"'<scheme>:...' shape — skipping, not guessing")
            continue
        scheme, _, rest = source.partition(":")
        poller = SOURCE_POLLERS.get(scheme)
        if poller is None:
            log(f"domain {domain.get('name')!r} names an unhandled detection_source scheme "
                f"{scheme!r} — skipping, not guessing")
            continue
        poller(domain, rest, state, budget)


def main():
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")
    log(f"starting, poll every {POLL_SECONDS}s, MIN_SEVERITY_RANK={MIN_SEVERITY_RANK}, "
        f"MAX_SUBMISSIONS_PER_POLL={MAX_SUBMISSIONS_PER_POLL}")
    state = load_state()
    while True:
        try:
            poll_once(state)
        except Exception as exc:
            log(f"poll_once failed: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
