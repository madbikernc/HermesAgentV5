#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-self-repair-verify-live — Step 4's POST-PROMOTION verification gate: deterministic, no
# model call. NOT YET WIRED to anything — Step 5 (the human promotion gate to GitHub) doesn't
# exist yet, so nothing calls this today. Built now so Step 5 has a ready-made gate to call rather
# than inventing one under pressure once promotion exists.
#
# Same poll shape as hermes-remediate-worker.py's own do_restart_service(): repeatedly checks
# `systemctl is-active` for a named unit, up to a timeout, pass/fail. Deliberately narrow — this
# confirms a service is active after a real promoted change reaches a live node via
# hermes-repo-autopull.timer + hermes-repo-sync.sh's own restart step; it says nothing about
# whether the FIX itself behaves correctly at runtime, which would need a task-specific test. The
# current self-repair task spec (path + problem, tools/hermes-self-repair-generate.py) has no field
# naming an associated service — this stays a standalone, generic check until/unless a future step
# adds one and wires it up.
#
# UNTESTABLE FROM THIS DEVELOPMENT MACHINE: `systemctl` only exists on a real systemd Linux host.
# The argument parsing and poll/timeout loop below were written carefully and modeled directly on
# hermes-remediate-worker.py's own already-proven do_restart_service() shape, but the actual
# `systemctl is-active` behavior this depends on has not been run once, here or on the fleet.
# Confirm live on a real node before trusting this for anything real.
#
# Usage: python3 hermes-self-repair-verify-live.py check-service <unit-name> [--timeout 30]

import argparse
import subprocess
import sys
import time


def check_service(unit, timeout_seconds):
    """Returns (ok: bool, note: str). Polls every 2s up to timeout_seconds — same cadence
    hermes-remediate-worker.py's own do_restart_service() already uses for this exact check."""
    deadline = time.monotonic() + timeout_seconds
    last_status = "unknown"
    while time.monotonic() < deadline:
        proc = subprocess.run(["systemctl", "is-active", "--quiet", unit])
        if proc.returncode == 0:
            return True, f"{unit} is active"
        status = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True)
        last_status = (status.stdout or "").strip() or "unknown"
        time.sleep(2)
    return False, f"{unit} did not report active within {timeout_seconds}s (last status: {last_status!r})"


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="op", required=True)
    p = sub.add_parser("check-service")
    p.add_argument("unit")
    p.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()

    if args.op == "check-service":
        ok, note = check_service(args.unit, args.timeout)
        print(note)
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
