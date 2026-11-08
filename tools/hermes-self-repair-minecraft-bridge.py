#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-11-08) — two real gaps found while actually preparing to flip minecraft-bots' switch
# on for the first time, not live traffic (this file had never run): (1) with no persisted cursor,
# `since` defaulted to 0, meaning a freshly-enabled bridge would have polled minecraft-ops from the
# very beginning of that topic's history — weeks of past triage incidents since 2026-09-07 — and
# tried to submit real tasks for all of them in one burst. Fixed with seek_to_end(): the first time
# a topic has no cursor yet, this bridge pages to its current tip WITHOUT processing anything, so a
# newly-enabled bridge only ever reacts to incidents from the moment it actually started. (2) no
# cap existed anywhere on how many tasks one poll cycle could submit — a burst of distinct
# first-occurrence high-severity incidents arriving close together could submit an unbounded
# number of real task pairs in one cycle. Added MAX_SUBMISSIONS_PER_POLL (default 3) and
# BudgetExhausted: a message that would exceed it is left UNADVANCED (retried next cycle, not
# dropped), while every message already handled this cycle keeps its cursor progress. This is a
# narrow, per-cycle safety valve, not an attempt to answer FLEET_SELFREPAIR_DESIGN.md §6's own
# still-open "daily action cap" question (which is about PR-opening/daily-review, a separate,
# still-undecided policy question).
#
# hermes-self-repair-minecraft-bridge — FLEET_SELFREPAIR_DESIGN.md §4.4's detection -> self-repair
# submission bridge, domain #1's instance (minecraft-bots). Generic in spirit, not in name: the
# orchestration loop (poll_once()/main()) iterates every REGISTERED domain whose switch is on
# (hermes_self_repair_domains.domain_switch_on()) and dispatches to a handler looked up by that
# domain's own `detection_source` string, via HANDLERS below -- today that table has exactly one
# entry ("buzz:minecraft-ops"), because exactly one domain exists. A future second domain with a
# differently-shaped detection source registers its own handler in HANDLERS the same way, without
# this file's own poll loop changing -- the same "generic orchestration, pluggable per-domain
# logic" shape tools/hermes_self_repair_completeness.py already uses for completeness rules. If
# that ever stops being true (say, two domains both needing a Buzz-topic handler end up
# duplicating real logic rather than just registering two dict entries), that is itself the
# signal FLEET_SELFREPAIR_DESIGN.md §8.4's genericity check exists to catch.
#
# Minecraft-bots' own detection source (infra/minecraft-bots-triage/) publishes free-text
# diagnoses to Buzz topic `minecraft-ops` -- NOT a {"path", "problem"} task spec; triage's own
# coder/coder2 calls are asked for severity/cause/next-step prose about a log line, never a file
# path (tools/hermes-minecraft-triage.py's own call_role() prompt has no path-naming instruction
# at all). This bridge is what actually names a path: for each new, sufficiently-severe,
# first-occurrence incident, it asks a model (reusing ROUTER_URL the same way every other
# self-repair component already does, `X-Hermes-Screening: analysis` set the same reason
# tools/hermes-minecraft-triage.py's own call_role() already sets it -- this is bot-generated log
# content, not a player request) which file under services/minecraft-bots/ or
# agents/minecraft-*/PROMPT.md is most likely responsible, given the real file listing from
# hermes-self-repair-read.py's new `list` operation (1.1.0). The model's answer is NEVER trusted
# directly -- it must exactly match one entry from that real listing, or the finding is skipped
# (logged, not guessed at) rather than submitted against a path that doesn't exist or isn't
# allowlisted. A wrong-but-real path still only ever reaches a human via the existing
# allowlist/dualcoder-review/promote-gate chain this whole pipeline already has; this bridge adds
# no new privilege, only a new (fallible, fail-closed) source of task specs.
#
# Per the domain's own completeness rule ("test-artifact", §4.3/§6): every finding this bridge
# acts on submits TWO tasks, not one -- a fix task (the behavior bug) and a test task (a new/
# updated services/minecraft-bots/tests/unit.test.mjs check), linked exactly the way
# hermes-self-repair-link.py links any two tasks by hand. Both go through Steps 2-4 completely
# unmodified, same as any other self-repair task.
#
# **This bridge is the only thing that can feed self-repair automatically, for any domain** --
# chat and hermes-dispatch.py still cannot (Step 8's own boundary, preserved). It is gated
# per-domain by that domain's own self_managed switch (domains.json); minecraft-bots' own switch
# starts OFF (§3's table) -- this file existing and even running does nothing until an operator
# deliberately flips it, a separate decision from building or deploying this file.
#
# Usage: a long-running poll loop (python3 hermes-self-repair-minecraft-bridge.py), same shape as
# hermes-self-repair-apply.py/-generate.py -- meant to run as a systemd service
# (hermes-self-repair-minecraft-bridge.service, alongside this file) once an operator deploys it.
#
# Config:
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN   required, same as every other self-repair piece
#   ROUTER_URL                 default http://127.0.0.1:8080 -- for the path-resolution call
#   SELF_REPAIR_READ_TOOL       default ~/HermesAgentV5/tools/hermes-self-repair-read.py -- used
#                               (as a subprocess, never imported) ONLY for its `list` operation, to
#                               get a real file listing to validate the model's path guess against
#   POLL_SECONDS                default 20 -- how often each on-switch domain's topic is polled
#   MIN_SEVERITY                default "medium" -- "low"/"unknown" triage findings are never
#                               acted on; only "medium"/"high" from either coder or coder2
#   MAX_SUBMISSIONS_PER_POLL    default 3 -- a per-cycle safety valve (1.1.0), not §6's own
#                               still-open "daily action cap" question
#   BRIDGE_STATE_DIR            default ~/.hermes/state/selfrepair-minecraft-bridge -- durable
#                               since-cursor so a restart never re-processes old Buzz messages, and
#                               a topic with no cursor yet is seeded at its current tip (1.1.0),
#                               never replayed from the beginning of its history

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_self_repair_domains as domains_mod  # noqa: E402

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")
SELF_REPAIR_READ_TOOL = os.environ.get(
    "SELF_REPAIR_READ_TOOL", str(Path.home() / "HermesAgentV5" / "tools" / "hermes-self-repair-read.py"))
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "20"))
SEVERITY_RANK = {"low": 0, "unknown": 0, "medium": 1, "high": 2}
MIN_SEVERITY_RANK = SEVERITY_RANK[os.environ.get("MIN_SEVERITY", "medium")]
MAX_SUBMISSIONS_PER_POLL = int(os.environ.get("MAX_SUBMISSIONS_PER_POLL", "3"))


class BudgetExhausted(Exception):
    """Raised by a handler when MAX_SUBMISSIONS_PER_POLL is already spent this cycle -- the
    message that triggered it is left unprocessed (cursor not advanced past it), so it's retried
    next cycle rather than lost."""
STATE_DIR = Path(os.environ.get(
    "BRIDGE_STATE_DIR", str(Path.home() / ".hermes" / "state" / "selfrepair-minecraft-bridge")))
BRIDGE_AGENT = "selfrepair-bridge"
# "selfrepair" (not "selfrepair-bridge") deliberately -- the identity Buzz's own KNOWN_AGENTS
# allowlist already has registered (hermes-self-repair-generate.py's publish_result() already
# posts as this identity live), so this bridge needs zero live hermes-buzz.py config change to
# work. hermes-memory's own "agent" field (BRIDGE_AGENT above) is unconstrained free text, so that
# one IS its own honest, distinct identity.
BUZZ_FROM = "selfrepair"


def log(msg):
    print(f"[hermes-self-repair-minecraft-bridge] {msg}", flush=True)


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


# --- State (since-cursor per topic, durable across restarts) ------------------------------------

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


# --- Pure parsing/decision logic (offline-testable, no network) ---------------------------------

_HEADER_RE = re.compile(r"^\[(?P<category>[^\]]+)\]\s*(?P<label>.*)$")
_ROLE_RE = re.compile(r"^\s*(?P<role>coder2?):\s*severity=(?P<sev>\w+)\s+cause=(?P<cause>.*?)\s+next=(?P<next>.*)$")
_SOURCE_LINE_RE = re.compile(r"^\s*source line:\s*(?P<line>.*)$")
_OCCURRENCES_RE = re.compile(r"occurrences for this bot\+signature:\s*(?P<count>\d+)")


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
        "roles": {}, "disagreement": False, "source_line": None, "occurrences": 1,
    }
    for line in lines[1:]:
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


def should_submit(parsed):
    """Returns (ok: bool, reason: str). Conservative gate, not a §6 operator decision -- an
    implementation default: only a first-ever occurrence of a signature (triage's own dedup
    counter, re-used rather than re-invented) at or above MIN_SEVERITY, from either role."""
    if parsed is None:
        return False, "unparseable triage body"
    if parsed["occurrences"] != 1:
        return False, f"not a first occurrence (seen {parsed['occurrences']} times already) — a task was already considered for this signature"
    if max_severity_rank(parsed) < MIN_SEVERITY_RANK:
        return False, f"below MIN_SEVERITY (roles: {parsed['roles']})"
    return True, "first occurrence, severity threshold met"


def build_fix_problem(parsed):
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
    return "\n".join(lines)


def build_test_problem(parsed, fix_path):
    return (
        f"Add or update a unit test in services/minecraft-bots/tests/unit.test.mjs that fails "
        f"against the current code and passes once {fix_path} is fixed for this incident "
        f"(category={parsed['category']}): {parsed['label']}"
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


def ask_model_for_path(parsed, candidates):
    listing = "\n".join(candidates)
    prompt = (
        "A Minecraft bot fleet's own log triage flagged an incident. Given the diagnosis below and "
        "the real list of files that exist in this codebase, name the ONE file most likely "
        "responsible for this behavior. Respond with EXACTLY one file path from the list below, "
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


def handle_minecraft_bots_buzz(message, domain, budget):
    body = message.get("body", "")
    parsed = parse_triage_body(body)
    ok, reason = should_submit(parsed)
    if not ok:
        log(f"skipping incident ({reason}): {body[:120]!r}")
        return

    if budget["remaining"] <= 0:
        raise BudgetExhausted()

    candidates = list(list_candidate_paths())
    if not candidates:
        log("skipping incident: could not list any candidate files (read tool unavailable?)")
        return

    try:
        model_answer = ask_model_for_path(parsed, candidates)
    except Exception as exc:
        log(f"skipping incident: path-resolution call failed: {exc}")
        return

    fix_path = resolve_target_path(model_answer, candidates)
    if not fix_path:
        log(f"skipping incident: model named no real/allowlisted path (answered {model_answer!r})")
        return

    fix_problem = build_fix_problem(parsed)
    test_problem = build_test_problem(parsed, fix_path)
    try:
        fix_task_id = submit_task(fix_path, fix_problem)
        test_task_id = submit_task("services/minecraft-bots/tests/unit.test.mjs", test_problem)
        write_link_turn(fix_task_id, "fix", test_task_id)
        write_link_turn(test_task_id, "test", fix_task_id)
    except Exception as exc:
        log(f"submission failed partway through: {exc} — a human should check for an orphaned task")
        return
    budget["remaining"] -= 1
    log(f"submitted linked tasks fix={fix_task_id} ({fix_path}) test={test_task_id} for domain "
        f"{domain.get('name')!r} ({budget['remaining']} submission(s) left this poll cycle)")


HANDLERS = {
    "buzz:minecraft-ops": handle_minecraft_bots_buzz,
}


def seek_to_end(topic):
    """Advances to the current tip of `topic` without processing anything -- called once, the
    first time this topic is ever polled (no persisted cursor yet), so a freshly-enabled bridge
    reacts only to incidents from the moment it actually started, never replays weeks of triage
    history as a flood of real model calls and real task submissions on first boot."""
    since = 0
    while True:
        resp = _get(f"{BUZZ_URL}/messages/poll?topic={topic}&since={since}&limit=200", BUZZ_TOKEN)
        messages = resp.get("messages", [])
        if not messages:
            return since
        since = max(m.get("seq", 0) for m in messages)
        if len(messages) < 200:
            return since


def poll_domain_buzz_topic(domain, topic, state, budget):
    if topic not in state:
        try:
            seeded_at = seek_to_end(topic)
        except Exception as exc:
            log(f"seek_to_end failed for topic {topic!r}: {exc} — will retry next poll")
            return
        state[topic] = seeded_at
        save_state(state)
        log(f"first run for topic {topic!r} — seeded cursor at seq={seeded_at}, will not replay "
            f"its history")
        return  # nothing to process this cycle -- only genuinely new messages arrive from here

    since = state[topic]
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
            handler(message, domain, budget)
        except BudgetExhausted:
            log(f"MAX_SUBMISSIONS_PER_POLL reached — leaving message seq={message.get('seq')} and "
                f"any later ones in topic {topic!r} for the next poll cycle")
            break
        except Exception as exc:
            log(f"handler failed on message seq={message.get('seq')}: {exc}")
        state[topic] = max(state.get(topic, 0), message.get("seq", 0))
    save_state(state)


def poll_once(state):
    budget = {"remaining": MAX_SUBMISSIONS_PER_POLL}
    for domain in domains_mod.load_domains():
        if not domains_mod.domain_switch_on(domain):
            continue
        source = domain.get("detection_source", "")
        if source not in HANDLERS:
            log(f"domain {domain.get('name')!r} is switched on but names an unhandled "
                f"detection_source {source!r} — skipping, not guessing")
            continue
        if not source.startswith("buzz:"):
            continue
        topic = source.split(":", 1)[1]
        poll_domain_buzz_topic(domain, topic, state, budget)


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
