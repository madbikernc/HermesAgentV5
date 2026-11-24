#!/usr/bin/env python3
# Version: 1.0.0
#
# Executes the Minecraft bots page's Stop/Start/Restart requests. hermes-fleetops-ui.py's sandbox
# has no subprocess or SSH (check_write_surface()/check_unit_sandbox(), and its own "SCOPE"
# comment through 2.25.1) -- that was a deliberate, documented house rule ("services stay an SSH +
# systemctl operator action"), and this file is a direct, operator-approved override of it, for
# exactly this one case (2026-11-24). The UI only ever validates and appends a pending request to
# MC_CONTROL_PATH; this is the separate, privileged process -- sibling to
# hermes-minecraft-bots-status.py, same REMOTES/SSH shape -- that actually reads a pending
# request, re-validates it against this run's OWN freshly-discovered roster (never trusts what
# the less-privileged UI process wrote), runs the real `sudo systemctl <action>
# minecraft-bot-<name>.service` -- locally if the unit is this host's own, over SSH if it belongs
# to a remote host -- and writes the result back to the same file. Runs on spark from a
# 15-second timer (short, since a human is watching for it, unlike the status snapshot's minute).
#
# Usage:
#   hermes-minecraft-bots-control.py   # processes every pending request once, then exits
import json
import os
import subprocess
import sys
import time
from pathlib import Path

CONTROL_PATH = Path(os.environ.get(
    "MC_CONTROL_PATH", str(Path.home() / ".hermes" / "state" / "minecraft-bots" / "control-requests.json")))
REMOTES = [h for h in os.environ.get("MC_CONTROL_REMOTES", "spark2").split() if h]
UNIT_PREFIX = "minecraft-bot-"
ACTIONS = ("stop", "start", "restart")
RUN_TIMEOUT = 30
DETAIL_MAX = 500  # a line or two of systemctl/ssh stderr is plenty; never store a stack trace


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
    same roster-discovery hermes-minecraft-bots-status.py itself uses. None if no host currently
    has a unit by this name at all."""
    if bot in local_units():
        return ""
    for host in remotes:
        if bot in remote_units(host):
            return host
    return None


def apply_action(bot, action, host):
    unit = f"{UNIT_PREFIX}{bot}.service"
    cmd = ["sudo", "systemctl", action, unit]
    if host:
        cmd = ["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", host, *cmd]
    _, err, rc = run(cmd)
    return rc, err.strip()


def process(requests):
    """Mutates `requests` in place; returns whether anything was actually touched, so main() can
    skip the write-back entirely when there was nothing pending (the common case, most ticks)."""
    changed = False
    for req in requests:
        if req.get("status") != "pending":
            continue
        changed = True
        bot, action = req.get("bot"), req.get("action")
        if action not in ACTIONS or not isinstance(bot, str) or not bot or not bot.isalnum():
            req.update(status="done", result="error", detail="invalid bot or action",
                       completed_at=time.time())
            continue
        host = locate(bot)
        if host is None:
            req.update(status="done", result="error",
                       detail="no such bot unit on any known host", completed_at=time.time())
            continue
        try:
            rc, detail = apply_action(bot, action, host)
        except (OSError, subprocess.TimeoutExpired) as exc:
            rc, detail = 1, f"{type(exc).__name__}: {exc}"
        req.update(status="done", result="ok" if rc == 0 else "error",
                   detail=detail[:DETAIL_MAX] or None, completed_at=time.time())
    return changed


def write_requests(requests, path):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(requests))
    os.replace(tmp, path)  # the UI never reads a half-written file


def main(argv):
    try:
        requests = json.loads(CONTROL_PATH.read_text())
    except (OSError, ValueError):
        return 0  # nothing requested yet (or a transient read race with the UI's own replace) -- not an error
    if process(requests):
        write_requests(requests, CONTROL_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
