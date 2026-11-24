#!/usr/bin/env python3
# Version: 1.0.0
#
# Fetches the Minecraft bots page's on-demand "last 500 actions" requests. Same split as
# hermes-minecraft-bots-control.py (sibling, same REMOTES/SSH shape, same re-validate-against-
# its-own-roster discipline): hermes-fleetops-ui.py's sandbox has no subprocess or SSH, so it only
# ever validates a bot name and writes a pending request to MC_HISTORY_PATH; this unsandboxed
# process reads it, re-discovers which host actually has the bot's unit, runs journalctl itself
# (locally or over SSH) for up to HISTORY_LIMIT OUTCOME lines -- not the 20
# hermes-minecraft-bots-status.py's own one-minute snapshot keeps -- and writes the parsed
# actions back onto the same record.
#
# Unlike control-requests.json (one audit-trail entry per click, kept for MC_CONTROL_MAX_KEPT
# clicks -- a real record of who stopped/started what, worth keeping), history-requests.json is
# keyed by bot name, one record per bot: a stale cached action list from an earlier click has no
# value once a newer click exists for the same bot, so a new request simply replaces the old
# record rather than piling up beside it.
#
# Usage:
#   hermes-minecraft-bots-history.py   # processes every pending request once, then exits
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HISTORY_PATH = Path(os.environ.get(
    "MC_HISTORY_PATH", str(Path.home() / ".hermes" / "state" / "minecraft-bots" / "history-requests.json")))
REMOTES = [h for h in os.environ.get("MC_HISTORY_REMOTES", "spark2").split() if h]
UNIT_PREFIX = "minecraft-bot-"
HISTORY_LIMIT = 500
RUN_TIMEOUT = 30
DETAIL_MAX = 500  # a line or two of journalctl/ssh stderr is plenty; never store a stack trace


def run(cmd, timeout=RUN_TIMEOUT):
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return result.stdout, result.stderr, result.returncode


def unit_names(out):
    return {line.split()[0][len(UNIT_PREFIX):-len(".service")]
            for line in out.splitlines() if line.split() and line.split()[0].endswith(".service")}


def local_units():
    out, _, _ = run(["systemctl", "list-unit-files", "--no-legend", f"{UNIT_PREFIX}*.service"])
    return unit_names(out)


def remote_units(host):
    try:
        out, _, rc = run(["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", host,
                           "systemctl", "list-unit-files", "--no-legend", f"{UNIT_PREFIX}*.service"])
        return unit_names(out) if rc == 0 else set()
    except (OSError, subprocess.TimeoutExpired):
        return set()


def locate(bot, remotes=REMOTES):
    """"" (this host) or a remote host string -- never guessed, always asked for directly, the
    same discovery hermes-minecraft-bots-control.py's own locate() and
    hermes-minecraft-bots-status.py's collect_local()/collect_remote() already use. None if no
    host currently has a unit by this name at all."""
    if bot in local_units():
        return ""
    for host in remotes:
        if bot in remote_units(host):
            return host
    return None


def strip_name(msg):
    """'[Dale] OUTCOME {...}' -> 'OUTCOME {...}', the same convention
    hermes-minecraft-bots-status.py's own strip_name() applies."""
    return re.sub(r"^\[[^\]]+\] ", "", msg, count=1)


def parse_outcome(at, msg):
    if not msg.startswith("OUTCOME "):
        return None
    try:
        o = json.loads(msg[len("OUTCOME "):])
    except ValueError:
        return None
    if o.get("ok"):
        result = "ok"
    elif o.get("cancelled"):
        result = "cancelled"
    elif o.get("refused"):
        result = "refused"
    else:
        result = "failed"
    return {"at": at, "type": o.get("type", "?"), "result": result, "ms": o.get("ms"),
            "why": o.get("why", "")}


def fetch_actions(bot, host, limit=HISTORY_LIMIT):
    """Up to `limit` OUTCOME lines for this bot's unit, newest first. No --since window, unlike
    the one-minute snapshot's own 7-day cap (chosen there to stay cheap on every single run): a
    request a human is waiting on asks for the last N actions, not the last N within some
    arbitrary recent window. Returns (actions, None) or (None, error-detail)."""
    unit = f"{UNIT_PREFIX}{bot}.service"
    cmd = ["journalctl", f"_SYSTEMD_UNIT={unit}", "--no-pager", "-o", "json",
           "--output-fields=MESSAGE", "-g", r"\] OUTCOME \{", "-n", str(limit)]
    if host:
        cmd = ["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", host, *cmd]
    out, err, rc = run(cmd)
    if rc != 0:
        return None, (err.strip() or f"journalctl exit {rc}")
    rows = []
    for line in out.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        msg = entry.get("MESSAGE")
        if isinstance(msg, list):  # journald stores non-UTF-8 messages as a byte array
            msg = bytes(msg).decode("utf-8", "replace")
        if not isinstance(msg, str):
            continue
        parsed = parse_outcome(int(entry.get("__REALTIME_TIMESTAMP", 0)) / 1e6, strip_name(msg))
        if parsed:
            rows.append(parsed)
    return list(reversed(rows)), None  # newest first, same convention as recent_actions()


def process(requests):
    """Mutates `requests` (the {bot: record} dict) in place; returns whether anything was
    actually touched, so main() can skip the write-back entirely when nothing is pending (the
    common case, most ticks)."""
    changed = False
    for bot, rec in requests.items():
        if rec.get("status") != "pending":
            continue
        changed = True
        if not isinstance(bot, str) or not bot or not bot.isalnum():
            rec.update(status="done", result="error", actions=None,
                       detail="invalid bot", completed_at=time.time())
            continue
        host = locate(bot)
        if host is None:
            rec.update(status="done", result="error", actions=None,
                       detail="no such bot unit on any known host", completed_at=time.time())
            continue
        try:
            actions, err = fetch_actions(bot, host)
        except (OSError, subprocess.TimeoutExpired) as exc:
            actions, err = None, f"{type(exc).__name__}: {exc}"
        if err:
            rec.update(status="done", result="error", actions=None,
                       detail=err[:DETAIL_MAX], completed_at=time.time())
        else:
            rec.update(status="done", result="ok", actions=actions, detail=None,
                       completed_at=time.time())
    return changed


def write_requests(requests, path):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(requests))
    os.replace(tmp, path)  # the UI never reads a half-written file


def main(argv):
    try:
        requests = json.loads(HISTORY_PATH.read_text())
    except (OSError, ValueError):
        return 0  # nothing requested yet (or a transient read race with the UI's own replace) -- not an error
    if not isinstance(requests, dict):
        return 0
    if process(requests):
        write_requests(requests, HISTORY_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
