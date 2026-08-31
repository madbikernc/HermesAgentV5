#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-08-31) — real routing collision found live: a "fleet health"-shaped question can
# plausibly route to either `logs` (hermes-logs.py 1.2.0's own fleethealth source, added the same
# day) or `status` (this file) -- dispatch's classifier isn't deterministic about which, and
# picked differently between two near-identical live test messages. Rather than trying to make
# routing itself deterministic (a bigger, riskier change to hermes-dispatch.py's routing prompt),
# this file now also recognizes the same FLEETHEALTH_KEYWORDS and answers with the exact same real
# report hermes-logs.py's gather_fleethealth() produces (same build_report()/render_text() call) —
# so either routing outcome gives the same correct answer instead of one being a dead end.
#
# hermes-status — chat access to a curated, read-only subset of the fleet's own skills/ status
# monitors. Owns the new Buzz `status` topic. Direct operator request, scoped explicitly in two
# rounds of scoping questions: (1) a curated allowlist, not the general skills/ tree Sintra/Amy
# use, and (2) v1 is READ-ONLY ONLY -- every source wired up here is a status check its own
# SKILL.md already documents as unable to change/control anything. No side-effecting skill
# (Vivint locks/garage, Zomboid admin actions, model-abliteration, etc.) is reachable from chat at
# all yet; per the operator's own answer, adding one later requires an explicit confirm-first
# flow, reusing the offer/confirm pattern hermes-presenter.py 1.4.0 already built for the
# internet-search fallback -- not silently wiring it up the way the read-only sources below are.
#
# Not a general tool-calling loop -- deliberately, matching hermes-code.py's own precedent and the
# two real incidents its header cites (an agent using a shared, unscoped-sudo account to install
# an unauthorized system service; a delegated agent destroying 27GB of data while self-reporting
# success). Each source below is ONE hardcoded call to that skill's own already-vetted script or
# function -- a subprocess with the exact interpreter/flags its SKILL.md documents for every
# venv-dependent skill, or (fleethealth only, 1.1.0) a direct in-process call to
# tools/hermes-fleet-health.py's own build_report()/render_text(), same reasoning
# hermes-logs.py's identical fleethealth source already documents. Never an LLM deciding what
# command to run or improvising arguments, either way.
#
# Source selection is deterministic keyword matching (parse_source()), same "doesn't need to be
# smart, needs to be right" contract hermes-logs.py's own parse_source() already established --
# not an LLM classification, so a wrong guess here can't silently run the wrong tool.
#
# No LLM pass on the output, on purpose, same reasoning hermes-logs.py 1.2.0's new `fleethealth`
# source just established: every tool wired up here already produces a complete, precise,
# human-readable report via its own --detail/status flag. Routing it through a model would only
# add paraphrase-drift risk for zero benefit -- publish the tool's real stdout directly.
#
# Each backing tool needs its own venv (Playwright for Generac, aioflo for Moen Flo, wyze-sdk for
# Wyze) -- exactly the reason every invocation below is a subprocess call using that tool's own
# documented interpreter path, not an in-process import (which would pull mutually incompatible
# dependencies into one Python process). Same subprocess-per-tool shape
# tools/hermes-fleet-health.py's own collect_local_identity()/collect_remote_ssh() already use for
# cross-context work.
#
# Config, all from the environment (injected by hermes-status-wrapper.sh):
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN, GUARD_URL/GUARD_TOKEN — same as every other
#   specialist
#   POLL_SECONDS     default 5
#   CLAIMANT         default "hermes-status"

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
import hermes_injection_guard  # noqa: E402
import importlib

_fleet_health = importlib.import_module("hermes-fleet-health")

REPO_DIR = Path(__file__).resolve().parent.parent

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
GUARD_URL = os.environ.get("GUARD_URL", f"http://{SPARK_IP}:8096").rstrip("/")
GUARD_TOKEN = os.environ.get("GUARD_TOKEN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
CLAIMANT = os.environ.get("CLAIMANT", "hermes-status")

PY = "/usr/bin/python3"

# name -> (keywords, cmd, timeout_seconds). Every cmd below is exactly what that skill's own
# SKILL.md documents as its read-only status invocation -- see this file's own header.
STATUS_SOURCES = {
    "pfsense": (
        ("pfsense", "firewall status", "gateway status"),
        [PY, str(REPO_DIR / "tools" / "hermes-pfsense.py"), "--leases"],
        30,
    ),
    "generac": (
        ("generac", "generator"),
        ["/opt/hermes/venvs/generac/bin/python3", str(REPO_DIR / "tools" / "hermes-generac.py"), "--detail"],
        90,  # drives a real headless-browser OAuth login, per its own SKILL.md
    ),
    "moenflo": (
        ("moen flo", "moen-flo", "water shutoff", "leak detector", "flo valve"),
        ["/opt/hermes/venvs/moen-flo/bin/python3", str(REPO_DIR / "tools" / "hermes-moen-flo.py"), "--detail"],
        30,
    ),
    "wyze": (
        ("wyze",),
        ["/opt/hermes/venvs/wyze/bin/python3", str(REPO_DIR / "tools" / "hermes-wyze.py"), "list"],
        30,
    ),
    "gameservers": (
        ("game server", "minecraft", "zomboid"),
        [PY, str(REPO_DIR / "tools" / "hermes-game-server-monitor.py"), "--dry-run"],
        30,
    ),
    "vivint": (
        ("vivint", "security system", "alarm status", "home security"),
        [PY, str(REPO_DIR / "tools" / "hermes-vivint.py"), "status"],
        30,
    ),
}

BOTNET_KEYWORDS = ("botnet", "c2 ", "threat intel", "threat-intel", "malicious ip", "known bad ip")
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# Same list hermes-logs.py's own FLEETHEALTH_KEYWORDS uses — kept in sync deliberately (see the
# 1.1.0 changelog above), not imported from there to avoid a cross-specialist import dependency
# for six words.
FLEETHEALTH_KEYWORDS = (
    "fleet health", "fleet status", "health of the fleet", "status of the fleet", "fleet report",
)

KNOWN_SOURCE_NAMES = ", ".join(
    sorted(STATUS_SOURCES) + ["fleethealth", "botnet-intel (needs an IP address)"]
)


def log(msg):
    print(f"[hermes-status] {msg}", flush=True)


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def claim_next(topic):
    try:
        return _post(f"{BUZZ_URL}/claims/next", {"topic": topic, "claimant": CLAIMANT}, BUZZ_TOKEN).get("claim")
    except Exception as exc:
        log(f"claim_next({topic!r}) failed: {exc}")
        return None


def ack_claim(claim_id):
    try:
        _post(f"{BUZZ_URL}/claims/{claim_id}/ack", {"claimant": CLAIMANT}, BUZZ_TOKEN)
    except Exception as exc:
        log(f"ack_claim({claim_id}) failed: {exc}")


def fetch_raw_text(task_id, memory_ref):
    turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=50", MEMORY_TOKEN).get("turns", [])
    if not turns:
        return None
    if memory_ref:
        for t in turns:
            if str(t["id"]) == str(memory_ref) or memory_ref == f"turn:{t['id']}":
                return t["raw"]
    return turns[-1]["raw"]


def set_task_state(task_id, state, topic=None):
    try:
        payload = {"id": task_id, "agent": "status", "state": state}
        if topic:
            payload["topic"] = topic
        _post(f"{MEMORY_URL}/tasks", payload, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_guard_verdict(layer, severity_value, detail):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": "guard-log", "agent": "guard", "role": "system",
            "raw": json.dumps({"node": "status", "layer": layer, "severity": severity_value, **detail}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"guard verdict logging failed: {exc}")


def screen(text):
    hits = hermes_injection_guard.scan_messages([{"role": "user", "content": text}])
    severity = hermes_injection_guard.overall_severity(hits)
    if severity == "block":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log(f"Layer 1 BLOCKED status request: categories={categories}")
        log_guard_verdict("L1", "block", {"categories": categories})
        return False
    if severity == "flag":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log_guard_verdict("L1", "flag", {"categories": categories})

    if GUARD_TOKEN:
        try:
            verdict = _post(f"{GUARD_URL}/classify", {"text": text}, GUARD_TOKEN, timeout=10)
            if verdict.get("hit"):
                log(f"Layer 2 BLOCKED status request: score={verdict['score']:.3f}")
                log_guard_verdict("L2", "block", {"label": verdict["label"], "score": verdict["score"]})
                return False
        except Exception as exc:
            log(f"Layer 2 unreachable, proceeding on Layer 1 alone: {exc}")
    return True


def parse_source(text):
    """Deterministic keyword matching only -- see this file's own header for why. Returns
    (source_name, arg) where arg is only meaningful for botnet-intel (the IP to look up, or None
    if the request didn't contain one); every other source ignores it and runs its fixed command.
    Returns (None, None) when nothing matches -- an honest "I don't know what you're asking about"
    beats guessing which tool to run."""
    lowered = text.strip().lower()
    if any(kw in lowered for kw in BOTNET_KEYWORDS):
        m = IP_RE.search(text)
        return "botnet-intel", (m.group(0) if m else None)
    if any(kw in lowered for kw in FLEETHEALTH_KEYWORDS):
        return "fleethealth", None
    for name, (keywords, _cmd, _timeout) in STATUS_SOURCES.items():
        if any(kw in lowered for kw in keywords):
            return name, None
    return None, None


def run_botnet_lookup(ip):
    script = (
        "import sys; sys.path.insert(0, %r)\n"
        "from hermes_botnet_intel import lookup_ip\n"
        "import json\n"
        "print(json.dumps(lookup_ip(%r)))\n"
    ) % (str(REPO_DIR / "tools"), ip)
    result = subprocess.run([PY, "-c", script], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None, (result.stderr.strip() or f"exit {result.returncode}")
    try:
        matches = json.loads(result.stdout.strip())
    except (ValueError, json.JSONDecodeError) as exc:
        return None, f"unparseable output: {exc}"
    if not matches:
        return f"{ip}: no match in the local threat-intel cache (Spamhaus/Feodo/TweetFeed).", None
    # Confidence tier matters (skill doc: weigh "high" far more than "community"-sourced) — kept
    # explicit per match rather than collapsed into a single verdict.
    lines = [f"{ip}: {len(matches)} match(es) in the local threat-intel cache:"]
    for m in matches:
        lines.append(f"  - {m.get('label', m.get('source'))}: {m.get('tag')} (confidence: {m.get('confidence')})")
    return "\n".join(lines), None


def run_source(name):
    keywords, cmd, timeout = STATUS_SOURCES[name]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"{name} check timed out after {timeout}s"
    except Exception as exc:
        return None, f"{name} check failed to start: {exc}"
    output = result.stdout.strip()
    if result.returncode != 0 and not output:
        return None, result.stderr.strip() or f"exit {result.returncode}"
    return output or "(empty output)", None


def publish_result(task_id, memory_ref, ok, message):
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "status", "role": "assistant",
        "raw": message, "presented": message,
    }, MEMORY_TOKEN)
    set_task_state(task_id, "done" if ok else "error")
    _post(f"{BUZZ_URL}/messages", {
        "from": "status", "topic": "results", "task_id": task_id,
        "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)


def process_one():
    claim = claim_next("status")
    if not claim:
        return False

    claim_id = claim["id"]
    msg = claim["message"]
    task_id, memory_ref = msg.get("task_id"), msg.get("memory_ref")

    if not task_id:
        log(f"claim {claim_id}: message has no task_id — acking and dropping")
        ack_claim(claim_id)
        return True

    request_text = fetch_raw_text(task_id, memory_ref)
    if not request_text:
        log(f"claim {claim_id}: task {task_id!r} has no raw text — acking and dropping")
        ack_claim(claim_id)
        set_task_state(task_id, "error-no-content")
        return True

    if not screen(request_text):
        set_task_state(task_id, "blocked")
        ack_claim(claim_id)
        publish_result(task_id, memory_ref, False,
                        "This request was rejected by the fleet's screening layer.")
        return True

    source, arg = parse_source(request_text)
    ack_claim(claim_id)  # ack once screened and understood — some of these checks (Generac's
                          # headless-browser login) can legitimately take up to 90s
    set_task_state(task_id, "checking", topic="status")
    log(f"claim {claim_id}: task {task_id!r} -> source {source!r}")

    if source is None:
        publish_result(task_id, memory_ref, False,
                        f"I couldn't tell which system you're asking about. I can check: {KNOWN_SOURCE_NAMES}.")
        return True

    if source == "botnet-intel":
        if not arg:
            publish_result(task_id, memory_ref, False,
                            "I didn't find an IP address in your request. Which IP would you like me to check?")
            return True
        result, err = run_botnet_lookup(arg)
    elif source == "fleethealth":
        try:
            fleet = _fleet_health.build_report()
            result, err = _fleet_health.render_text(fleet), None
        except Exception as exc:
            result, err = None, f"fleet-health pull failed: {exc}"
    else:
        result, err = run_source(source)

    if err:
        log(f"task {task_id!r}: {source} check failed: {err}")
        publish_result(task_id, memory_ref, False, f"Could not complete the {source} check: {err}")
        return True

    publish_result(task_id, memory_ref, True, result)
    log(f"task {task_id!r}: {source} result published ({len(result)} chars)")
    return True


def main():
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")
    if not GUARD_TOKEN:
        log("WARNING: GUARD_TOKEN not set — this agent's own Layer 2 screening is skipped")
    log(f"watching Buzz topic 'status', polling every {POLL_SECONDS}s, "
        f"sources={sorted(STATUS_SOURCES) + ['fleethealth', 'botnet-intel']}")
    while True:
        try:
            did_work = process_one()
        except Exception as exc:
            log(f"unhandled error this cycle, continuing: {exc}")
            did_work = False
        if not did_work:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
