#!/usr/bin/env python3
# Version: 1.3.0
#
# 1.3.0 (2026-09-04) — Direct operator request: a "model report" source -- which checkpoint backs
# each role, where it physically lives, whether it's abliterated. Built from one local GET against
# this node's own router (`ROUTER_URL`, default 127.0.0.1:8080) rather than a second hardcoded copy
# of `hermes-router.py`'s `ROLES` table: `/v1/models` (router 2.9.0) already lists every role
# regardless of which node hosts it, so asking spark's own router also answers for muse/omni on
# spark-2. Router-reported `backend_url` values that read `127.0.0.1` (a role physically resident
# on THIS node, per router.py's own loopback-for-local-roles convention) are rewritten to
# `SPARK_LAN_IP` for display -- this file always runs on spark (see hermes-status.service's
# `After=... hermes-buzz.service hermes-memory.service`, both spark-only), so that substitution is
# safe and gives a real routable address instead of a loopback meaningless to the person reading
# the report. `embed` isn't a router role (never proxied by hermes-router.py) and has no `/v1/
# models` entry -- `EMBED_INFO` hardcodes its one fixed endpoint, documented here rather than
# silently missing from the report, same "note the gap, don't hide it" precedent `canary`'s own
# 1.2.0 entry set for this file.
#
# 1.2.1 (2026-09-01) — real root cause found for wyze, correcting the 1.1.3 diagnosis: this was
# never a hang. An instrumented, step-by-step re-run of hermes-wyze.py's own call chain showed the
# cached access token had simply expired (a clean, fast SDK error), and the actual delay was
# entirely inside its re-login path's five sequential vault_get() calls, each paying a full
# separate `bw` login/unlock/sync/logout cycle -- measured live at ~15s/field, ~77s total, before
# Wyze's own login call (0.8s) even ran. 30s was never going to be enough for a cold re-auth; first
# raised to 150s, then to 240s after a real full end-to-end test measured 149.9s against that
# first number -- essentially a coin flip, not real margin. See the inline comment on this source
# for the full measurement.
#
# 1.2.0 (2026-09-01) — direct operator request after a real, repeated gap surfaced live twice:
# "Canary status"/"Canary health" had no home anywhere in this file. Canary only ever had
# log/event *review* via hermes-logs.py's own `canary` source (judgment-based, runs `super`); no
# quick deterministic status check the way pfsense/generac/wyze/etc. all have. New `canary` source
# reuses tools/hermes-canary-report.py's own pull_logs()/group_by_src()/build_summary_text()/
# build_botnet_section() directly, deliberately skipping its ask_llm() call -- same "no LLM pass
# on the output" rule this file already commits to for every other source. Own independent 24h
# lookback window, never touches hermes-canary-report.py's own scheduled-run state file.
#
# 1.1.3 (2026-08-31) — same class of bug as 1.1.2, two more instances found live: gameservers
# (real run ~31s, SSH + vault-fetch overhead) and vivint (real run needing re-authentication
# ~103s) both timed out at their original 30s. Raised to 60s/150s respectively, based on real
# measured runs, not guesses. Also confirmed (not fixed) that wyze genuinely hangs, independent of
# timeout length -- see the inline comment on that source; a separate investigation into
# hermes-wyze.py itself is needed, out of scope for this file.
#
# 1.1.2 (2026-08-31) — real bug found live: moenflo's 30s timeout was too short. A real,
# successful run of tools/hermes-moen-flo.py --detail (confirmed live, real data returned) took
# ~58s — cloud API auth overhead this source's timeout didn't account for. Raised to 90s, matching
# generac's own already-generous budget for the same class of cloud-auth overhead.
#
# 1.1.1 (2026-08-31) — real usability gap found live: a bare "Moen" didn't match the moenflo
# keyword tuple (required the full phrase "moen flo"). Added the bare brand name; also added
# "gameserver" (no space) alongside "game server" for the same reason. Every other source's
# keyword set was already a single distinctive word (pfsense, generac, wyze, vivint) and didn't
# need this.
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_injection_guard  # noqa: E402
import importlib

_fleet_health = importlib.import_module("hermes-fleet-health")
_canary_report = importlib.import_module("hermes-canary-report")

REPO_DIR = Path(__file__).resolve().parent.parent

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")
# `embed` is a standalone llama-server instance, never registered in hermes-router.py's `ROLES` --
# see this file's 1.3.0 changelog entry above. Fixed values, not derived from anywhere live.
EMBED_INFO = ("Qwen3-Embedding-0.6B-Q8_0", f"{SPARK_IP}:8092",
              f"http://{SPARK_IP}:8092/v1/embeddings", False)
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
        ("moen", "moen flo", "moen-flo", "water shutoff", "leak detector", "flo valve"),
        ["/opt/hermes/venvs/moen-flo/bin/python3", str(REPO_DIR / "tools" / "hermes-moen-flo.py"), "--detail"],
        90,  # confirmed live: a real run took ~58s (cloud API auth overhead); 30s timed out every time
    ),
    "wyze": (
        ("wyze",),
        ["/opt/hermes/venvs/wyze/bin/python3", str(REPO_DIR / "tools" / "hermes-wyze.py"), "list"],
        # RESOLVED 2026-09-01 (was flagged as a KNOWN ISSUE / suspected hang on 2026-08-31 --
        # that was wrong, not just incomplete). Root-caused with an instrumented step-by-step
        # re-run of hermes-wyze.py's own call chain: the cached access token had expired, which
        # is itself a clean, fast error (confirmed directly against the SDK) -- the real delay is
        # entirely inside fresh_login()'s five SEQUENTIAL vault_get() calls (username, password,
        # api_key, key_id, totp_key), each paying a full separate `bw` login/unlock/sync/logout
        # cycle (~15s/field, ~77s total for credentials alone), then Wyze's own login call (0.8s)
        # plus a real devices_list() pull (53 real devices on this account). Not a
        # TLS/connectivity/hang bug at all -- just a real cold re-auth cost the original 30s
        # timeout never accounted for. First fix (150s) was cut it far too close: a real full
        # end-to-end cold-reauth run measured 149.9s against it -- essentially a coin flip on the
        # next run, not real margin. 240s gives genuine headroom above the actual measured
        # worst case. A cached, still-valid token skips fresh_login() entirely and returns in a
        # few seconds, same as every other source here.
        240,
    ),
    "gameservers": (
        ("game server", "gameserver", "minecraft", "zomboid"),
        [PY, str(REPO_DIR / "tools" / "hermes-game-server-monitor.py"), "--dry-run"],
        60,  # confirmed live: a real run took ~31s (SSH round trip + vault fetch); 30s timed out
    ),
    "vivint": (
        ("vivint", "security system", "alarm status", "home security"),
        [PY, str(REPO_DIR / "tools" / "hermes-vivint.py"), "status"],
        150,  # confirmed live: a real run needing re-authentication took ~103s; 30s timed out
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

# Real gap found live 2026-09-01: "Canary status"/"Canary health" had no home anywhere in this
# file -- canary only had log/event *review* via hermes-logs.py's own CANARY_KEYWORDS, no quick
# deterministic status check the way pfsense/generac/etc. all have. This closes that gap.
CANARY_KEYWORDS = ("canary", "honeypot")
CANARY_LOOKBACK_HOURS = 24

MODEL_REPORT_KEYWORDS = (
    "model report", "models report", "model status", "which models", "what models",
    "llama endpoints", "llama.cpp endpoints", "backend models",
)

KNOWN_SOURCE_NAMES = ", ".join(
    sorted(STATUS_SOURCES) + ["fleethealth", "canary", "modelreport", "botnet-intel (needs an IP address)"]
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
    if any(kw in lowered for kw in CANARY_KEYWORDS):
        return "canary", None
    if any(kw in lowered for kw in MODEL_REPORT_KEYWORDS):
        return "modelreport", None
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


def run_canary_status():
    """Deterministic status check, not the judgment-based review hermes-logs.py's own `canary`
    source already does -- reuses tools/hermes-canary-report.py's own pull_logs()/group_by_src()/
    build_summary_text()/build_botnet_section() directly (same "wrap what already works"
    reasoning fleethealth already established in this file), but deliberately skips its
    ask_llm() call entirely, same "no LLM pass on the output" rule this file's own header commits
    to for every source. Own fixed 24h lookback window -- independent of
    hermes-canary-report.py's own scheduled-run state file (_load_since()/_save_since()), which
    this never touches, so an ad hoc chat check can never desync the real scheduled report's own
    "since" marker."""
    since = datetime.now(timezone.utc) - timedelta(hours=CANARY_LOOKBACK_HOURS)
    try:
        events = _canary_report.pull_logs(since)
    except Exception as exc:
        return None, f"could not reach the canary sensor: {exc}"
    if not events:
        return f"No honeypot connections detected in the last {CANARY_LOOKBACK_HOURS}h (since {since.strftime('%Y-%m-%d %H:%M')} UTC).", None
    by_src = _canary_report.group_by_src(events)
    summary = _canary_report.build_summary_text(by_src, since)
    botnet_text, _ = _canary_report.build_botnet_section(by_src)
    return summary + "\n\n" + botnet_text, None


_ROLE_ORDER = {"dispatch": 0, "super": 1, "coder": 2, "embed": 3, "muse": 4, "omni": 5}


def run_model_report():
    """Live Role/Model/IP/Port/API-URL/Abliterated report -- see this file's 1.3.0 changelog for
    why one local GET against this node's own router is enough to cover every role, and why
    `embed` is hardcoded (EMBED_INFO) instead."""
    try:
        resp = _get(f"{ROUTER_URL}/v1/models", timeout=10)
    except Exception as exc:
        return None, f"could not reach the local router at {ROUTER_URL}: {exc}"

    rows = []
    for entry in resp.get("data", []):
        # Roles physically resident on THIS node come back as 127.0.0.1 (router.py's own
        # loopback-for-local-roles convention) -- rewritten to this node's real LAN IP since this
        # file only ever runs on spark (see the changelog entry above).
        backend_url = entry["backend_url"].replace("127.0.0.1", SPARK_IP)
        rows.append((
            entry["id"], entry["checkpoint"], backend_url.replace("http://", ""),
            f"{backend_url}/v1/chat/completions", entry["abliterated"],
        ))
    rows.append(("embed",) + EMBED_INFO)
    rows.sort(key=lambda r: _ROLE_ORDER.get(r[0], 99))

    lines = ["Model report (live via this node's router; embed is a fixed, non-routed endpoint):"]
    for role, model, ip_port, api_url, abliterated in rows:
        flag = "ABLITERATED" if abliterated else "stock"
        lines.append(f"  {role:<9} {model:<46} {ip_port:<20} {flag}")
        lines.append(f"            {api_url}")
    lines.append("")
    lines.append("dispatch/muse/omni/embed run always-on; super/coder wake on demand via the broker.")
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
    elif source == "canary":
        result, err = run_canary_status()
    elif source == "modelreport":
        result, err = run_model_report()
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
        f"sources={sorted(STATUS_SOURCES) + ['fleethealth', 'canary', 'modelreport', 'botnet-intel']}")
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
