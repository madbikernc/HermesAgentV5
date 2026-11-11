#!/usr/bin/env python3
# Version: 1.0.0
#
# Snapshot of the Minecraft bots for hermes-fleetops-ui's /minecraft tab: which bot units are
# running, what each one's current goal is, its latest log lines, and its last 20 actions with
# their outcome. The UI's sandbox rules out reaching any of this itself (no subprocess, no SSH --
# hermes-fleetops-ui.py's check_write_surface/check_unit_sandbox), so this runs on spark from a
# one-minute timer and writes one JSON file the page reads, the same shape /status already uses
# for hermes-fleet-health.py's snapshot.
#
# The bots live on two hosts. This host's are read directly; every host in MC_STATUS_REMOTES
# (default `spark2`, pmoney's own SSH alias, as hermes-fleet-health.py uses) runs this same file
# with --local and prints its half as JSON. A host that can't be reached is recorded with its
# error rather than dropped, so the page can say which half is missing.
#
# Sources, all read-only:
#   - `systemctl list-unit-files minecraft-bot-*.service` -- the roster, discovered, never listed
#     here (stopped units included, so a bot that was running recently still shows).
#   - /mnt/hermes-data/minecraft-memory/bots/<name>/goal.json -- the current goal. goals.js
#     deletes it when a goal ends, so no file means no goal.
#   - the unit's journal: `OUTCOME {...}` lines (actions.js logOutcome(), one per action, the same
#     lines triage and tests/baseline.mjs count), and the latest lines that aren't pathfinder noise.
#   - services/minecraft-bots/roles.js -- each bot's primary role.
#
# Usage:
#   hermes-minecraft-bots-status.py           # collect every host, write MC_STATUS_PATH
#   hermes-minecraft-bots-status.py --local   # this host only, JSON to stdout
import datetime
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROLES_JS = REPO / "services" / "minecraft-bots" / "roles.js"
MEMORY_DIR = Path(os.environ.get("MC_MEMORY_ROOT", "/mnt/hermes-data/minecraft-memory"))
STATUS_PATH = Path(os.environ.get(
    "MC_STATUS_PATH", str(Path.home() / ".hermes" / "state" / "minecraft-bots" / "status.json")))
REMOTES = [h for h in os.environ.get("MC_STATUS_REMOTES", "spark2").split() if h]
REMOTE_SCRIPT = "HermesAgentV5/tools/hermes-minecraft-bots-status.py"  # relative to the remote home

UNIT_PREFIX = "minecraft-bot-"
ACTIONS_SHOWN = 20
LATEST_SHOWN = 3
JOURNAL_SINCE = "-7 days"
# Lines that say nothing about what she's doing: the pathfinder's own chatter, memory stats, and
# the OUTCOME lines, which have their own table.
NOISE = re.compile(r"^(path_|goal_reached|goal_updated|mem rss|dig_error|pathfinder|OUTCOME |"
                   r"ROUTINE_SKIPS|heard mc-)")
GOAL_EVENT = re.compile(r"[Gg]oal[ :]")


def run(cmd, timeout=20):
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return result.stdout, result.returncode


def list_units():
    out, _ = run(["systemctl", "list-unit-files", "--no-legend", f"{UNIT_PREFIX}*.service"])
    return sorted(line.split()[0] for line in out.splitlines()
                  if line.split() and line.split()[0].endswith(".service"))


def unit_state(unit):
    out, _ = run(["systemctl", "show", "--timestamp=unix", "-p",
                  "ActiveState,SubState,ActiveEnterTimestamp,InactiveEnterTimestamp,NRestarts", unit])
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    active = props.get("ActiveState", "unknown")
    since = props.get("ActiveEnterTimestamp" if active == "active" else "InactiveEnterTimestamp", "")
    return {"active_state": active, "sub_state": props.get("SubState", ""),
            "since": float(since[1:]) if since.startswith("@") else None,
            "restarts": int(props["NRestarts"]) if props.get("NRestarts", "").isdigit() else None}


def journal(unit, *args):
    """The unit's journal as (epoch seconds, message) pairs, oldest first. JSON output, so a
    message containing anything at all can't be mis-split. _SYSTEMD_UNIT rather than -u: only the
    bot's own output, not systemd's "Stopped ..." lines about the unit, which would otherwise be
    a stopped bot's whole "latest"."""
    out, _ = run(["journalctl", f"_SYSTEMD_UNIT={unit}", "--no-pager", "-o", "json",
                  "--output-fields=MESSAGE", *args])
    entries = []
    for line in out.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        msg = entry.get("MESSAGE")
        if isinstance(msg, list):  # journald stores non-UTF-8 messages as a byte array
            msg = bytes(msg).decode("utf-8", "replace")
        if isinstance(msg, str):
            entries.append((int(entry.get("__REALTIME_TIMESTAMP", 0)) / 1e6, strip_name(msg)))
    return entries


def strip_name(msg):
    """'[Dale] OUTCOME {...}' -> 'OUTCOME {...}'."""
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


def recent_actions(unit):
    rows = [parse_outcome(at, msg) for at, msg in
            journal(unit, "--since", JOURNAL_SINCE, "-g", r"\] OUTCOME \{", "-n", str(ACTIONS_SHOWN))]
    return [r for r in reversed(rows) if r]  # newest first


def latest_lines(unit):
    lines = [{"at": at, "text": msg} for at, msg in journal(unit, "-n", "300")
             if not NOISE.match(msg)]
    return list(reversed(lines[-LATEST_SHOWN:]))


def last_goal_event(unit):
    hits = [{"at": at, "text": msg} for at, msg in
            journal(unit, "--since", JOURNAL_SINCE, "-g", GOAL_EVENT.pattern, "-n", "5")
            if not NOISE.match(msg)]
    return hits[-1] if hits else None


def read_goal(name):
    path = MEMORY_DIR / "bots" / name / "goal.json"
    try:
        goal = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return {k: goal.get(k) for k in ("description", "source", "setBy", "createdAt", "updatedAt",
                                     "steps", "consecutiveFailures", "sawSuccess")}


def read_roles(path=ROLES_JS):
    """{'bob': 'Farmer', ...} from roles.js's BOT_ROLES table and the ROLES names it points at."""
    try:
        src = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    names = dict(re.findall(r"^\s*([A-Z_]+):\s*Object\.freeze\(\{\s*name:\s*\"([^\"]+)\"", src, re.M))
    return {bot: names.get(const, const.title())
            for bot, const in re.findall(r"^\s*(\w+):\s*\{\s*primary:\s*ROLES\.(\w+)", src, re.M)}


def collect_local():
    bots = []
    for unit in list_units():
        name = unit[len(UNIT_PREFIX):-len(".service")]
        bot = {"name": name, "unit": unit, **unit_state(unit), "goal": read_goal(name),
               "latest": latest_lines(unit), "last_goal_event": last_goal_event(unit),
               "actions": recent_actions(unit)}
        bots.append(bot)
    return {"host": socket.gethostname(), "collected_at": now_iso(), "error": None, "bots": bots}


def collect_remote(host):
    try:
        out, rc = run(["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", host,
                       "python3", REMOTE_SCRIPT, "--local"], timeout=60)
        if rc != 0:
            raise RuntimeError(f"exit {rc}")
        return json.loads(out)
    except (OSError, subprocess.TimeoutExpired, RuntimeError, ValueError) as exc:
        return {"host": host, "collected_at": now_iso(), "error": f"{type(exc).__name__}: {exc}",
                "bots": []}


def build_snapshot():
    try:
        hosts = [collect_local()]
    except (OSError, subprocess.TimeoutExpired) as exc:
        hosts = [{"host": socket.gethostname(), "collected_at": now_iso(),
                  "error": f"{type(exc).__name__}: {exc}", "bots": []}]
    hosts += [collect_remote(h) for h in REMOTES]
    roles = read_roles()
    for h in hosts:
        for bot in h.get("bots", []):
            bot["role"] = roles.get(bot["name"], "")
    return {"generated_at": now_iso(), "hosts": hosts}


def write_snapshot(snapshot, path=STATUS_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(snapshot))
    os.replace(tmp, path)  # the page never reads a half-written file


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def main(argv):
    if "--local" in argv:
        print(json.dumps(collect_local()))
        return 0
    write_snapshot(build_snapshot())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
