#!/usr/bin/env python3
# Version: 1.3.1
#
# hermes-guard-report — daily account of what the screening layers blocked, grouped by caller.
#
# WHY THIS EXISTS: on 2026-10-09, S22d replaced Layer 2 with a classifier that actually detects
# injections, and it began blocking the fleet's own analysis prompts. **351 calls were blocked over
# six and a half hours — 189 of the Minecraft bots' planning calls and 162 of
# hermes-minecraft-triage's — and nothing alerted.** The operator noticed. Every component involved
# degraded quietly: a blocked call is an HTTP 400 that each caller logs and swallows, and S27f
# deliberately suppresses real-time alerts on *allowed* analysis calls so the digest alone would not
# fire six notices a day. The result was a hole with no floor: screening could silently stop the
# bot fleet, the log analyst and the news digest, indefinitely, and the only signal was a human
# reading journals. This closes that.
#
# ── Attribution without new plumbing ──
#
# The verdict log records node, layer, severity, label, score and text — but NOT which process
# made the call, because hermes-router has no way to know. Rather than thread a caller id through
# every component (real work, and wrong to rush into a security path), this groups by a
# **fingerprint of the screened text's opening** — which is what actually identified the two broken
# callers on 2026-10-09 within a minute: every blocked planning call began "Goal:" and every
# blocked triage call began "You are triaging one incident". Fleet-generated prompts have stable
# openings; that is precisely what makes them identifiable.
#
# ── What it alerts on, and why that rule ──
#
# A single block is not news. Layer 2 blocking a player who typed an injection into Minecraft chat
# is the system working, and it will happen. What is news is the SAME SHAPE of call being blocked
# repeatedly, because a human attacker does not send the identical opening twenty times while a
# broken component sends nothing else. So: report every count, and alert when one fingerprint
# reaches ALERT_THRESHOLD blocks in the window. On the 2026-10-09 data that rule fires on both
# real regressions and on neither of the one-off blocks.
#
# Config (environment):
#   MEMORY_URL / MEMORY_TOKEN       required — reads the `guard-log` task's turns
#   FLEETOPS_MATRIX_TOKEN / FLEETOPS_ROOM   optional; without them the report only prints
#   MATRIX_HOMESERVER               default http://127.0.0.1:6167
#   GUARD_REPORT_HOURS              default 26 — a day plus timer jitter
#   GUARD_REPORT_ALERT_THRESHOLD    default 5 — blocks of one fingerprint before it is an alert
#   GUARD_REPORT_SCAN_LIMIT         default 1000 — turns fetched
#
# Usage:
#   hermes-guard-report.py                 # report, and notify FleetOps if anything tripped
#   hermes-guard-report.py --hours 6       # narrower window
#   hermes-guard-report.py --quiet-ok      # say nothing to Matrix on a clean day (default posts)
#   hermes-guard-report.py --no-notify     # print only
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict, namedtuple
from pathlib import Path

TOOLS = Path(__file__).resolve().parent

MEMORY_URL = os.environ.get("MEMORY_URL", "http://10.129.1.15:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167").rstrip("/")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")

WINDOW_HOURS = int(os.environ.get("GUARD_REPORT_HOURS", "26"))
ALERT_THRESHOLD = int(os.environ.get("GUARD_REPORT_ALERT_THRESHOLD", "5"))
SCAN_LIMIT = int(os.environ.get("GUARD_REPORT_SCAN_LIMIT", "1000"))
# How recently a caller must have been blocked for the report to hint that it is still
# happening. 15 minutes, not an hour: the planner and the triage watcher each call several
# times a minute, so an hour of silence from them means repaired, and the 2026-10-09 run
# labelled two already-fixed callers ONGOING on the strength of blocks 31 minutes old.
ACTIVE_WINDOW_S = int(os.environ.get("GUARD_REPORT_ACTIVE_WINDOW_S", "900"))

FINGERPRINT_CHARS = 48
_WS = re.compile(r"\s+")

# Known fleet prompts, matched against the opening of the screened text and checked in order; the
# first hit names the caller. A pattern starting "^" must match at the very start, which is how the
# short, generic ones avoid claiming a player's message that happens to contain the same words.
#
# WHY A TABLE AND NOT A KEY LENGTH: a component's prompt is a template -- a stable skeleton with a
# tail that changes every call -- and the stable part is not a fixed number of characters or words.
# The planner opens "Goal: gathering wood" / "Goal: gather some iron ore": ONE component, diverging
# at word two, which a 48-char key split into 20 "callers" on the 2026-10-09 incident and a 3-word
# key still splits into six. Shortening the key to one word instead merges things that must stay
# apart, since most fleet prompts open "You are ...". The news digest is worse again: its prompts
# open "Topic: <varies>" and only become identifiable further in. No generic rule separates these,
# because the text carries no structural signal distinguishing "same template, different tail" from
# "different template, shared opening". So name the templates.
#
# This table is additive and incomplete by design -- narrateAction sends the bot's own free-form
# action text, and the chat paths send conversation history, neither of which has a stable opening.
# An opening the table does not know keeps its own 48-char fingerprint and is counted on its own,
# which is the right default for traffic we cannot attribute: a player's injection, or a component
# nobody has added here yet, stays individually visible instead of folded into someone else's row.
MATCH_WINDOW = 240
KNOWN_CALLERS = (
    ('minecraft bot planner ("Goal: ...")', "^Goal:"),
    ("minecraft bot goal arbitration", "^This bot's proposed goal:"),
    ("""minecraft bot self-prompt ("What's your goal?")""", "^What's your goal?"),
    ("minecraft bot-to-bot directive", "^What do you tell "),
    ('hermes-minecraft-triage ("You are triaging ...")', "^You are triaging one incident"),
    ("hermes-canary-report", "^You are a network security analyst"),
    ("hermes-model-scan", "deterministic list of new open-weight model releases"),
    ("hermes-news-digest (topic matches)", "are numbered matched passages"),
    ("hermes-news-digest (topic summary)", "this topic's daily digest entries"),
    ("hermes-rag-source-discovery", "numbered passages from indexed fleet content"),
)


def log(msg):
    print(f"[hermes-guard-report] {msg}", flush=True)


def fingerprint(text):
    """A caller's identity, approximated by the opening of what it sent. Whitespace is collapsed so
    a reflowed prompt does not read as a different caller, and the result is truncated hard: the
    point is to group, not to reproduce the payload in an alert."""
    if not text:
        return "(no text recorded)"
    return _WS.sub(" ", text).strip()[:FINGERPRINT_CHARS]


def coarse_key(text):
    """The caller: a named fleet component when its prompt template is recognised, otherwise the
    48-char opening. This is what the alert counts, so one broken component cannot look like
    twenty -- and an unrecognised caller cannot be hidden inside a recognised one."""
    if not text:
        return "(no text recorded)"
    head = _WS.sub(" ", text).strip()[:MATCH_WINDOW]
    for label, pattern in KNOWN_CALLERS:
        if pattern.startswith("^"):
            if head.startswith(pattern[1:]):
                return label
        elif pattern in head:
            return label
    return fingerprint(text)


def fetch_turns():
    url = f"{MEMORY_URL}/turns?task_id=guard-log&limit={SCAN_LIMIT}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {MEMORY_TOKEN}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode()).get("turns", [])


def stamp(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def clock(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%H:%M")


def age(now, ts):
    """How long ago, in the coarsest useful unit. Printed for every caller rather than reduced to a
    yes/no: whether a caller is *still* being blocked depends on how often it calls at all, which
    this reporter cannot know, so the honest output is the elapsed time and a reader who can judge
    it. ONGOING below is a hint, not a verdict."""
    secs = max(0, int(now - ts))
    if secs < 3600:
        return f"{secs // 60}m ago"
    return f"{secs // 3600}h {secs % 3600 // 60}m ago"


# Everything the report needs, reduced from the raw turns in one pass. A named tuple rather than a
# widening positional one: this grew from four fields to seven inside a day, and a caller that
# unpacks the wrong arity silently mis-assigns columns.
Collected = namedtuple("Collected", "verdicts by_fp scores span examples last_block nodes")


def collect(turns, since_ts):
    """Reduces the window's verdict turns to a Collected. A turn whose `raw` will not parse is
    skipped rather than fatal — this report must never be the thing that breaks."""
    verdicts = Counter()
    by_fp = defaultdict(Counter)
    scores = defaultdict(list)
    nodes = defaultdict(Counter)
    last_block = {}
    examples = {}
    seen_ts = []
    for t in turns:
        ts = t.get("created_at") or 0
        if ts < since_ts:
            continue
        try:
            p = json.loads(t.get("raw") or "{}")
        except (ValueError, json.JSONDecodeError):
            continue
        layer = p.get("layer") or "?"
        sev = p.get("severity") or "?"
        node = p.get("node") or "?"
        verdicts[(node, layer, sev)] += 1
        seen_ts.append(ts)
        key = coarse_key(p.get("text"))
        by_fp[key][(layer, sev)] += 1
        examples.setdefault(key, set()).add(fingerprint(p.get("text")))
        if sev == "block":
            nodes[key][node] += 1
            last_block[key] = max(last_block.get(key, 0), ts)
        if p.get("score") is not None:
            try:
                scores[key].append(float(p["score"]))
            except (TypeError, ValueError):
                pass
    span = (min(seen_ts), max(seen_ts)) if seen_ts else None
    return Collected(verdicts, by_fp, scores, span, examples, last_block, nodes)


def blocked_counts(by_fp):
    """Blocks per fingerprint, across both layers. `analysis-allowed` is deliberately excluded:
    those calls succeeded, and counting them as problems would make the alert meaningless."""
    out = Counter()
    for fp, counts in by_fp.items():
        n = sum(v for (layer, sev), v in counts.items() if sev == "block")
        if n:
            out[fp] = n
    return out


def still_blocked(c, key, now):
    """Whether this caller was blocked recently enough to count as a live problem.

    This is the single most useful fact in the report, and the window alone cannot supply it: a 26h
    report straddles any fix made during the day, so a regression repaired at 08:45 otherwise reads
    exactly like one happening right now. Measured on 2026-10-09 — after the S27f restarts landed
    mid-window, the two repaired callers still showed 30 and 5 blocks, every one of them from before
    the restart, and the report called both REPEATED with no way to tell."""
    last = c.last_block.get(key, 0)
    return bool(last) and (now - last) <= ACTIVE_WINDOW_S


def build_report(c, hours, now=None):
    now = time.time() if now is None else now
    blocks = blocked_counts(c.by_fp)
    repeated = {fp: n for fp, n in blocks.items() if n >= ALERT_THRESHOLD}
    total_blocks = sum(blocks.values())
    allowed = sum(v for (node, layer, sev), v in c.verdicts.items() if sev == "analysis-allowed")

    lines = [f"[guard-report] last {hours}h: {total_blocks} block(s), {allowed} analysis-allowed"]
    if c.span:
        lines.append(f"  span {stamp(c.span[0])} → {stamp(c.span[1])}")
    if not c.verdicts:
        lines.append("  no guard verdicts recorded at all in this window")
        return lines, repeated

    lines.append("  by node / layer / severity:")
    for (node, layer, sev), n in sorted(c.verdicts.items(), key=lambda kv: -kv[1]):
        lines.append(f"    {n:>5}  {node:<8} {layer:<3} {sev}")

    if blocks:
        lines.append("  blocked callers, grouped by the shape of what they sent:")
        for key, n in blocks.most_common(12):
            s = c.scores.get(key) or []
            srange = f"  score {min(s):.3f}-{max(s):.3f}" if s else ""
            last = c.last_block.get(key, 0)
            seen = f"last {clock(last)}, {age(now, last)}" if last else "never"
            if n >= ALERT_THRESHOLD:
                live = "ONGOING, " if still_blocked(c, key, now) else ""
                mark = f"  <-- REPEATED, {live}{seen}"
            else:
                mark = f"  ({seen})" if last else ""
            lines.append(f"    {n:>5}x {key!r}{srange}{mark}")
            on = c.nodes.get(key)
            if on and len(on) > 1:
                lines.append("            on " +
                             ", ".join(f"{nd} x{v}" for nd, v in on.most_common()))
            for ex in sorted(c.examples.get(key, ()))[:2]:
                if ex != key:
                    lines.append(f"            e.g. {ex!r}")

    if repeated:
        live = [k for k in repeated if still_blocked(c, k, now)]
        lines.append("")
        lines.append(f"  {len(repeated)} caller(s) blocked {ALERT_THRESHOLD}+ times, {len(live)} of "
                     f"them within the last {ACTIVE_WINDOW_S // 60}m. A human attacker does not")
        lines.append("  resend one opening that often; a broken component sends nothing else. Check")
        lines.append("  whether each should be declaring `X-Hermes-Screening: analysis`")
        lines.append("  (IMPLEMENTATION_PLAN.md S27f) — and whether it is a path that")
        lines.append("  must stay screened, in which case the block is correct. A caller whose last")
        lines.append("  block is hours old was repaired inside the window: listed so the day is")
        lines.append("  complete, not because it needs action now.")
    return lines, repeated


def matrix_notice(text):
    if not (FLEETOPS_TOKEN and FLEETOPS_ROOM):
        log("(no FleetOps credential; report not posted)")
        return False
    try:
        txn = f"guard-report-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/{urllib.parse.quote(FLEETOPS_ROOM)}"
            f"/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(), method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}",
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        log(f"posted to FleetOps room {FLEETOPS_ROOM}")
        return True
    except Exception as exc:
        log(f"FleetOps notice failed: {exc}")
        return False


def exit_code(repeated):
    """1 when a caller is being blocked repeatedly, so the regression shows up in
    `systemctl list-timers` and the journal as well as in chat.

    Deliberately independent of --no-notify and --quiet-ok: those choose where the report goes,
    never whether a regression is reported. The first cut returned 0 early on --no-notify, which
    meant the one invocation a human runs by hand was the one that reported success while three
    callers were being blocked."""
    return 1 if repeated else 0


def main():
    ap = argparse.ArgumentParser(description="Daily account of what the screening layers blocked")
    ap.add_argument("--hours", type=int, default=WINDOW_HOURS)
    ap.add_argument("--no-notify", action="store_true", help="print only")
    ap.add_argument("--quiet-ok", action="store_true",
                    help="post nothing when there is nothing repeated (default posts the summary)")
    args = ap.parse_args()

    if not MEMORY_TOKEN:
        sys.exit("MEMORY_TOKEN is required")
    try:
        turns = fetch_turns()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        sys.exit(f"cannot read the guard log from hermes-memory: {exc}")

    since = time.time() - args.hours * 3600
    collected = collect(turns, since)
    lines, repeated = build_report(collected, args.hours)
    report = "\n".join(lines)
    print(report)

    if args.no_notify:
        log("--no-notify given; not posting")
    elif repeated or not args.quiet_ok:
        matrix_notice(report)
    else:
        log("nothing repeated and --quiet-ok given; not posting")
    return exit_code(repeated)


if __name__ == "__main__":
    sys.exit(main())
