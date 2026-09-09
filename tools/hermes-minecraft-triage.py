#!/usr/bin/env python3
# Version: 1.3.0
#
# 1.3.0 (2026-09-08) — MC_BOT_UNITS default extended for the new fifth bot, Mayor (direct
# request: "add another bot, Mayor, whose personality is to be a leader"), same real gap
# 1.2.0 already fixed once for Mark/Luke: a bot unit missing from this list is invisible to
# triage entirely.
#
# 1.2.0 (2026-09-07) — direct request: "leave the heap dump in place for now, and instrument
# The Firmament to prioritize capturing those for later analysis." Two changes:
# (1) MC_BOT_UNITS default extended to all four bots (mark/luke were added to the fleet
#     tonight -- real gap found while making this change: their crashes were invisible to this
#     service entirely, since it only ever watched babs/amy).
# (2) The "oom" category now looks up and attaches the real heap snapshot that
#     --heapsnapshot-near-heap-limit (services/minecraft-bots/run-bot.sh 1.6.0) writes
#     automatically right before a real OOM crash, instead of only publishing coder/coder2's
#     guesses -- which, on every single OOM incident logged tonight, never once got past "likely
#     a memory leak, increase --max-old-space-size." A real snapshot (confirmed live tonight:
#     tracing one down to its actual root cause -- astar.js's synchronous search loop starving
#     Node's event loop -- needed the snapshot itself, not another LLM guess from one log line)
#     is the actually useful artifact here; this makes sure every future one is captured,
#     attributed to the right bot, and surfaced prominently rather than left to sit undiscovered
#     in /mnt/hermes-data/minecraft-memory/heapdumps/. Attribution needed switching journalctl
#     to -o json (confirmed live: the FATAL ERROR line's own _SYSTEMD_UNIT field correctly names
#     the originating bot unit -- a plain multi-unit `-f` follow has no reliable way to tell
#     which bot's line is which otherwise, since all four run the identical run-bot.sh).
#
# 1.1.0 (2026-09-07) — new "suspicious-done" pattern, matching index.js 2.14.1's own DONE-
# validation flag (fifth of the same "what other logic enhancements are available" pass this
# triage service itself came from) — a goal reporting complete with no real successful step ever
# logged behind it now gets triaged like any other incident, not just left for a human to notice
# by reading the bot's own log directly.
#
# 1.0.3 (2026-09-07) — direct, immediate consequence of 1.0.2's own fix: raising coder2's token
# budget to 900 also raised how long it can legitimately take to generate a full response (~11
# tokens/sec observed, so up to ~85s for 900 tokens) -- past the still-60s HTTP timeout, so the
# very next real incident after deploying 1.0.2 failed with an honest "timed out" instead of an
# empty response (itself a sign the exception handling works correctly; this was a new,
# different failure, not the same bug recurring). call_role's timeout raised to 150s and the
# join() timeout that wraps both parallel calls to 170s to match.
#
# 1.0.2 (2026-09-07) — 500 tokens (1.0.1's fix) still wasn't enough: EVERY real incident after
# that deploy still showed an empty coder2 result. Direct evidence (a manual curl replicating
# the actual triage prompt) confirmed why -- coder2/Muse-Glimmer used 460 of that 500-token
# budget on reasoning_content alone before writing its ~40-token final answer, so it was
# genuinely on the edge, not comfortably fixed; the real prompt (slightly longer than the test
# that "passed" at 500) consistently tipped it over. 900 tokens gives real margin instead of
# another guess at a number just barely bigger than the last one.
#
# 1.0.1 (2026-09-07) — real gap found live on this service's very first real incident: coder2
# (backed by Muse-Glimmer-30B, per hermes-router.py's own history -- the originally-planned model
# failed to load) emits extended "reasoning_content" before its final answer, and the original
# 150-token budget let that consume the whole allowance, leaving an empty CAUSE/NEXT and a
# spurious coder-vs-coder2 "disagreement" that was really just coder2 never finishing. Bumped to
# 500 tokens -- the same truncation shape already found and fixed for the bots' own goal planner
# hours earlier tonight, no per-call cost pressure on local compute either.
#
# hermes-minecraft-triage.py — direct request (2026-09-07): "I want the Firmament to do this
# monitoring, and engage coder/coder2 loop to do initial triage." Built after a long live
# debugging session (this same night) where a human operator manually tailed both Minecraft
# bots' journals for hours, recognizing real bugs (a crash, silent goal-loop failures, planner
# truncation, item-name confusion, a missing-fuel gap, a spawn-protection misconfiguration) one
# at a time from raw log lines. This service is that same watch-and-diagnose loop, running
# permanently as fleet infrastructure instead of a human's terminal session.
#
# Deliberately NOT autonomous repair: "triage" means diagnose and prioritize, not fix. Every
# real fix that night required either a code change (reviewed, committed, deployed) or a server
# config change (server.properties, ops.json) — decisions with real blast radius that stay a
# human/Claude-Code job. This service's only output is a written assessment, published where a
# human or another tool can see it and decide what to do.
#
# Design, per the two decisions the operator made when this was commissioned:
#   1. coder and coder2 (hermes-router.py's own two coding-tier roles) triage every incident
#      INDEPENDENTLY and in PARALLEL, not as a draft/review pipeline. If they substantially
#      disagree on severity, that disagreement is itself surfaced as a signal (an ambiguous or
#      hard-to-classify incident deserves a closer look, not a coin-flip average).
#   2. Every triage result goes to three places at once:
#        - Buzz topic `minecraft-ops` (hermes-buzz.py 2.0.17) as agent `minecraft-triage` --
#          deliberately NOT the existing `minecraft` topic, which both bots relay into in-game
#          chat (design doc §9); a triage verdict has no business being read aloud in-game.
#        - Matrix, for free: hermes-buzz.py's own matrix_mirror() already mirrors every Buzz
#          message into the FleetOps room in real time (confirmed live, same mechanism
#          hermes-broker.py's job delivery already relies on) -- publishing to Buzz IS publishing
#          to Matrix here, no separate Matrix client needed in this tool.
#        - A local log file (LOG_PATH below). The existing hermes-rag "ops" corpus was
#          considered and deliberately NOT used: real recon (reading
#          hermes-rag-ingest-ops.py's own header) found it's narrowly scoped to
#          hermes-node-health.py's structured snapshots specifically, not a general
#          incident dropbox -- writing triage notes into it would be the same scope-creep
#          mistake that header explicitly warns against for every other fleet tool.
#
# What counts as "triage-worthy" (TRIAGE_PATTERNS below): real crashes/errors (TypeError,
# ReferenceError, OOM, unhandled rejections), a repeated "stuck" pathfinding loop, a goal being
# abandoned, and hermes-router call failures -- a deliberately wider net than a human would
# manually narrate line-by-line, since severity judgment is now coder/coder2's job, not a
# pre-filter here. Per-category cooldown (TRIAGE_COOLDOWN_S) stops one ongoing incident (e.g. a
# "stuck" loop printing every few seconds for a minute) from being triaged dozens of times.
#
# Deliberately boring: stdlib only, same as every other worker/report in this fleet.
#
# Config, all from the environment:
#   HERMES_ROUTER_URL   default http://127.0.0.1:8080/v1/chat/completions
#   BUZZ_URL            default http://10.129.1.15:8101
#   TRIAGE_LOG_PATH     default /mnt/hermes-data/minecraft-memory/triage.log
#   TRIAGE_COOLDOWN_S   default 300 (5 minutes per incident category)
#   MC_BOT_UNITS        default minecraft-bot-babs.service,minecraft-bot-amy.service,
#                               minecraft-bot-mark.service,minecraft-bot-luke.service,
#                               minecraft-bot-mayor.service
#   MC_HEAPDUMP_ROOT    default /mnt/hermes-data/minecraft-memory/heapdumps (must match
#                               run-bot.sh's own --diagnostic-dir, one subfolder per bot)
#
# Usage: python3 hermes-minecraft-triage.py  (run under systemd, see
# infra/minecraft-bots-triage/hermes-minecraft-triage.service)

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_GET = str(REPO_DIR / "tools" / "vault-get-secret.sh")

ROUTER_URL = os.environ.get("HERMES_ROUTER_URL", "http://127.0.0.1:8080/v1/chat/completions")
BUZZ_URL = os.environ.get("BUZZ_URL", "http://10.129.1.15:8101")
LOG_PATH = Path(os.environ.get("TRIAGE_LOG_PATH", "/mnt/hermes-data/minecraft-memory/triage.log"))
COOLDOWN_S = int(os.environ.get("TRIAGE_COOLDOWN_S", "300"))
BOT_UNITS = os.environ.get(
    "MC_BOT_UNITS",
    "minecraft-bot-babs.service,minecraft-bot-amy.service,"
    "minecraft-bot-mark.service,minecraft-bot-luke.service,"
    "minecraft-bot-mayor.service",
).split(",")
HEAPDUMP_ROOT = Path(os.environ.get("MC_HEAPDUMP_ROOT", "/mnt/hermes-data/minecraft-memory/heapdumps"))

AGENT_ID = "minecraft-triage"
TOPIC = "minecraft-ops"

# (category, regex, human label) -- category drives the cooldown key, so two different lines
# matching the same category within COOLDOWN_S of each other only triage once. Ordered roughly
# by how the same live debugging session encountered each of these tonight.
TRIAGE_PATTERNS = [
    ("crash", re.compile(r"TypeError|ReferenceError|is not a function|is not iterable|"
                          r"Cannot read propert|undefined is not|UnhandledPromiseRejection"),
     "JS runtime error"),
    ("oom", re.compile(r"JavaScript heap out of memory|FATAL ERROR|Ineffective mark-compacts"),
     "out-of-memory crash"),
    ("process-exit", re.compile(r"core-dump|Main process exited"), "bot process died"),
    ("stuck-path", re.compile(r"path_reset: stuck"), "pathfinder repeatedly stuck"),
    ("goal-abandoned", re.compile(r"giving up on goal"), "a standing goal was abandoned"),
    ("router-failure", re.compile(r"hermes-router \w+ call failed"), "model backend call failed"),
    ("action-failed", re.compile(r"action '.*' failed:"), "a direct action failed"),
    # index.js 2.14.1's own DONE-validation flag: a goal reported complete with no real
    # successful step ever logged behind it -- fifth of the same "what other logic enhancements
    # are available" pass this triage service itself came from.
    ("suspicious-done", re.compile(r"SUSPICIOUS DONE"), "a goal claimed complete with no real success behind it"),
]


def unit_to_persona(unit):
    """"minecraft-bot-mark.service" -> "mark" -- matches run-bot.sh's own lowercasing of
    MC_BOT_USERNAME into MC_HEAPDUMP_ROOT/<persona>/."""
    m = re.match(r"minecraft-bot-([\w-]+)\.service$", unit or "")
    return m.group(1) if m else None


def find_latest_heapdump(persona, min_mtime):
    """The freshest *.heapsnapshot for this bot at/after min_mtime, or None. A real crash's own
    snapshot (--heapsnapshot-near-heap-limit=1) is written to disk BEFORE the FATAL ERROR line
    this function is called in response to, so it should already exist -- min_mtime (a few
    seconds of grace before "now") is a safety margin against clock/flush skew, not a race this
    function is expected to win by polling."""
    if not persona:
        return None
    d = HEAPDUMP_ROOT / persona
    if not d.is_dir():
        return None
    candidates = sorted(d.glob("*.heapsnapshot"), key=lambda p: p.stat().st_mtime, reverse=True)
    for p in candidates:
        if p.stat().st_mtime >= min_mtime:
            return p
    return None


def log(msg):
    print(f"[hermes-minecraft-triage] {msg}", flush=True)


def vault_get(item, field):
    try:
        r = subprocess.run([VAULT_GET, item, field], capture_output=True, text=True, timeout=15)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def call_role(role, log_line, timeout=150):
    """One triage call. Returns (severity, cause, next_step) or None on failure -- a failed
    triage call is itself just logged, never allowed to crash the watch loop."""
    prompt = (
        "You are triaging one incident from a Minecraft bot's live log (Firmament fleet, "
        "mineflayer-based bots with autonomous goals). Given the log line(s) below, assess it "
        "in EXACTLY this format, three lines, nothing else:\n"
        "SEVERITY: low|medium|high\n"
        "CAUSE: <one sentence, your best real diagnosis -- say if you're not sure>\n"
        "NEXT: <one sentence, concrete suggested next step, or \"none -- self-resolves\">\n\n"
        f"Log line(s):\n{log_line}"
    )
    # max_tokens is deliberately generous, not a tight 150 -- real evidence found live minutes
    # after this shipped: coder2 is backed by Muse-Glimmer-30B (hermes-router.py's own history:
    # the originally-planned model failed to load on this build), which emits extended
    # "reasoning_content" before its final answer. A tight budget let the reasoning consume the
    # whole allowance and leave nothing for the actual SEVERITY/CAUSE/NEXT answer -- the exact
    # same truncation shape found and fixed for the bots' own goal planner hours earlier tonight.
    # No per-call cost pressure on local compute, so there's no reason to economize here either.
    body = json.dumps({
        "model": role,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 900,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(ROUTER_URL, data=body, method="POST",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
        text = data["choices"][0]["message"]["content"].strip()
        sev = re.search(r"SEVERITY:\s*(\w+)", text, re.I)
        cause = re.search(r"CAUSE:\s*(.+)", text, re.I)
        nxt = re.search(r"NEXT:\s*(.+)", text, re.I)
        return {
            "severity": (sev.group(1).lower() if sev else "unknown"),
            "cause": (cause.group(1).strip() if cause else text[:200]),
            "next": (nxt.group(1).strip() if nxt else ""),
        }
    except Exception as exc:
        log(f"triage call to '{role}' failed: {exc}")
        return None


def triage_incident(category, label, line, unit=None):
    """Fires coder and coder2 in parallel (real concurrency, not sequential-then-compare --
    per the operator's own explicit choice: independent verdicts, not a draft/review pipeline),
    then compares them. Disagreement on severity is surfaced as its own signal rather than
    silently averaged or picked.

    For "oom" specifically, a real heap snapshot is now the actually useful artifact here --
    every OOM this service ever triaged still got coder/coder2's guess (kept below, it's cheap
    and occasionally still worth having), but real analysis tonight needed the snapshot itself,
    not another guess from one log line. Looked up and attached FIRST, so it's never lost even
    if the coder/coder2 calls below both fail."""
    heapdump_note = None
    if category == "oom":
        persona = unit_to_persona(unit)
        snap = find_latest_heapdump(persona, time.time() - 30)
        if snap:
            size_mb = snap.stat().st_size / 1024 / 1024
            heapdump_note = (
                f"  \U0001F534 HEAP SNAPSHOT CAPTURED (prioritized for later analysis -- do not "
                f"delete without reviewing): {snap} ({size_mb:.0f} MB)"
            )
        elif persona:
            heapdump_note = (
                f"  (no heap snapshot found yet for '{persona}' under {HEAPDUMP_ROOT} -- "
                f"--heapsnapshot-near-heap-limit writes it before this line fires, so check "
                f"again shortly if this is unexpected)"
            )

    results = {}

    def run(role):
        results[role] = call_role(role, line)

    threads = [threading.Thread(target=run, args=(role,)) for role in ("coder", "coder2")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=170)  # comfortably above call_role's own 150s HTTP timeout

    coder, coder2 = results.get("coder"), results.get("coder2")
    if not coder and not coder2 and not heapdump_note:
        return None  # nothing at all to report

    lines = [f"[{category}] {label}"]
    if heapdump_note:
        lines.append(heapdump_note)
    if coder:
        lines.append(f"  coder:  severity={coder['severity']} cause={coder['cause']} next={coder['next']}")
    if coder2:
        lines.append(f"  coder2: severity={coder2['severity']} cause={coder2['cause']} next={coder2['next']}")
    if coder and coder2 and coder["severity"] != coder2["severity"]:
        lines.append(f"  ⚠ DISAGREEMENT: coder says {coder['severity']}, coder2 says {coder2['severity']} "
                     f"-- ambiguous incident, worth a closer look")
    lines.append(f"  source line: {line.strip()[:300]}")
    return "\n".join(lines)


def publish_buzz(body, buzz_token):
    payload = json.dumps({"from": AGENT_ID, "topic": TOPIC, "body": body}).encode()
    req = urllib.request.Request(f"{BUZZ_URL}/messages", data=payload, method="POST", headers={
        "Content-Type": "application/json",
        **({"Authorization": f"Bearer {buzz_token}"} if buzz_token else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return True
    except Exception as exc:
        log(f"Buzz publish failed: {exc}")
        return False


def append_log(text):
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n{text}\n")
    except Exception as exc:
        log(f"local log write failed: {exc}")


def watch_loop(buzz_token):
    # -o json + --output-fields, not the plain default format: real evidence (2026-09-07) --
    # journalctl's own _SYSTEMD_UNIT field correctly names the originating bot unit on every
    # line that actually matters here (confirmed live against a real FATAL ERROR line), which a
    # plain multi-unit `-f` follow has no way to recover, since all four bots run the identical
    # run-bot.sh and none of their own log lines say which bot they came from.
    cmd = ["journalctl"]
    for unit in BOT_UNITS:
        cmd += ["-u", unit.strip()]
    cmd += ["-f", "-n0", "-o", "json", "--output-fields=_SYSTEMD_UNIT,MESSAGE"]

    log(f"watching: {' '.join(cmd)}")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             bufsize=1)

    last_triaged = {}  # category -> monotonic timestamp of last triage, for cooldown
    for raw_json in proc.stdout:
        try:
            entry = json.loads(raw_json)
        except (json.JSONDecodeError, ValueError):
            continue  # a stderr line from journalctl itself, or a malformed entry -- skip it
        message = entry.get("MESSAGE", "")
        if isinstance(message, list):
            # journald encodes non-UTF8 fields as a raw byte array instead of a string.
            try:
                message = bytes(message).decode("utf-8", "replace")
            except (TypeError, ValueError):
                message = str(message)
        unit = entry.get("_SYSTEMD_UNIT")

        for category, pattern, label in TRIAGE_PATTERNS:
            if not pattern.search(message):
                continue
            now = time.monotonic()
            if now - last_triaged.get(category, 0) < COOLDOWN_S:
                break  # same incident category still in cooldown -- don't re-triage every line
            last_triaged[category] = now
            log(f"triage-worthy: [{category}] {message.strip()[:150]}")
            result = triage_incident(category, label, message, unit)
            if result:
                append_log(result)
                publish_buzz(result, buzz_token)
            break  # one category match per line is enough


def main():
    buzz_token = vault_get("buzz-token", "password")
    if not buzz_token:
        log("WARNING: no Buzz token -- triage results will only go to the local log file")
    while True:
        try:
            watch_loop(buzz_token)
        except Exception as exc:
            log(f"watch loop crashed, restarting in 10s: {exc}")
        time.sleep(10)


if __name__ == "__main__":
    main()
