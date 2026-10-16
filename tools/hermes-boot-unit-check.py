#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-16) - real bug found on spark's first live run: a blanket scan flagged 14
# stock-Ubuntu units as "not active" (NetworkManager-dispatcher, rsyslog, anacron, dmesg,
# mdcheck_*, open-vm-tools, ubuntu-advantage, vgauth, ...) -- all `enabled` but legitimately,
# permanently `inactive` on this hardware, with no reliable systemd-exposed signal to tell that
# apart from a real dependency-stranding (see UNIT_PREFIXES' comment below for why). Scoped
# list_enabled_units() to this fleet's own `hermes-` units, where Type=oneshot is accurate
# because we declare it ourselves.
#
# 1.0.0 (2026-10-16) - S32 item (a): the generic check the stage calls for -- "a boot-time check
# that every enabled, non-oneshot unit actually reached active, which is the generic check that
# would have caught all seven and the three stragglers" of the 2026-10-11 outage. A
# dependency-failed start job is never retried by Restart=always, so a unit left stranded that
# way sits silently `inactive (dead)` until something notices by hand -- this is that something.
#
# Deliberately a periodic timer (OnBootSec=5min OnUnitActiveSec=15min), not a one-shot boot
# check: the fleet's LUKS data container is unlocked manually (see
# infra/spark2-disk-encryption/README.md), at an unknown time after boot, so a pure boot-time
# check would false-alarm on every reboot before anyone's had a chance to unlock it. Periodic
# strictly dominates one-shot here -- it still satisfies the exit gate's intent, and it also
# catches a unit that dies for any other reason later, not just at boot.
#
# Alerts once per unit per state change (newly failing, or recovered), via a small state file --
# this runs as a fresh process each tick, so it can't use hermes-router.py's in-process
# _guard_down-style flag (see S32 item b). tools/hermes_alert_common.py is reused rather than
# copied, same reason item (b) extracted it in the first place.
import json
import os
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_alert_common  # noqa: E402

HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
STATE_PATH = HERMES_HOME / "state" / "boot-unit-check" / "state.json"

NODE = os.environ.get("HERMES_NODE") or socket.gethostname()


def log(msg):
    print(f"[hermes-boot-unit-check:{NODE}] {msg}", flush=True)


def send_email(subject, body):
    hermes_alert_common.send_email(subject, body, log=log)


def matrix_notice(text):
    hermes_alert_common.matrix_notice(text, log=log)


def run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip(), r.returncode
    except Exception as e:
        return "", -1 if isinstance(e, subprocess.TimeoutExpired) else 1


# S32 item (a), found on spark's first live run (2026-10-16): a blanket scan of every enabled
# unit on the box flagged 14 false positives -- stock Ubuntu units (NetworkManager-dispatcher,
# rsyslog, anacron, dmesg, mdcheck_*, open-vm-tools, ubuntu-advantage, vgauth, ...) that are
# `enabled` but legitimately, permanently `inactive` on this hardware: `ConditionResult=no` for
# some, and for others (anacron, dmesg) `ActiveState=inactive`/`Result=success` with
# `ConditionResult=yes` -- i.e. they ran to completion and exited, exactly like a oneshot, but
# their declared Type (dbus/notify/simple/idle) isn't "oneshot". systemd's own exposed state
# cannot distinguish "ran once by design" from "never started because a dependency failed" for
# these -- Result=success either way, which is also why `systemctl --failed` never caught the
# 2026-10-11 stranding (ActiveState went to inactive, not failed). Scoping to this fleet's own
# `hermes-` units sidesteps the ambiguity entirely: every hermes-*.service that's meant to run
# once declares Type=oneshot accurately (we control it, unlike the distro), so the Type filter
# below is actually reliable within this namespace. `llama-*` backends are deliberately NOT
# included -- several are on-demand and correctly stopped between uses by their own idle-sleep
# timers, which an ActiveState check can't tell apart from a real failure; hermes-node-health.py's
# content-aware model_endpoints probe already covers that ground without this ambiguity.
UNIT_PREFIXES = ("hermes-",)


def list_enabled_units(unit_type):
    """Concrete (non-template) units systemd will start on its own, restricted to UNIT_PREFIXES.
    `--state=enabled` already excludes disabled/static/masked; template units (name@.service) are
    skipped here too -- systemd never activates the template itself, only instances of it, and an
    instance that's actually in use shows up under its own instance name regardless."""
    out, rc = run(["systemctl", "list-unit-files", f"--type={unit_type}", "--state=enabled", "--no-legend"])
    if rc != 0:
        return []
    units = []
    for line in out.splitlines():
        parts = line.split()
        if parts and "@" not in parts[0] and parts[0].startswith(UNIT_PREFIXES):
            units.append(parts[0])
    return units


def unit_type_and_state(unit):
    out, rc = run(["systemctl", "show", unit, "--property=Type", "--property=ActiveState", "--no-pager"])
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    return props.get("Type", ""), props.get("ActiveState", "")


def find_not_active():
    """Returns {unit: active_state} for every enabled unit systemd should be keeping active and
    isn't. A oneshot service is deliberately excluded: it goes `inactive` after every successful
    run (that's correct, not stranded), which is exactly why the plan's own wording is
    "non-oneshot" -- a blanket check would misreport every timer-triggered oneshot as down."""
    problems = {}
    for unit in list_enabled_units("service"):
        utype, state = unit_type_and_state(unit)
        if utype == "oneshot":
            continue
        if state != "active":
            problems[unit] = state
    for unit in list_enabled_units("timer"):
        _, state = unit_type_and_state(unit)
        if state != "active":
            problems[unit] = state
    return problems


def load_prev_failing():
    try:
        return set(json.loads(STATE_PATH.read_text()).get("failing", []))
    except Exception:
        return set()


def save_state(failing):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps({
        "failing": sorted(failing),
        "updated": datetime.now(timezone.utc).isoformat(),
    }, indent=2))


def main():
    problems = find_not_active()
    current = set(problems)
    prev = load_prev_failing()

    newly_failing = current - prev
    recovered = prev - current

    if newly_failing:
        lines = [f"  {u}: {problems[u]}" for u in sorted(newly_failing)]
        log(f"newly not active: {sorted(newly_failing)}")
        matrix_notice(f"[boot-unit-check:{NODE}] {len(newly_failing)} enabled unit(s) not "
                       f"active: {sorted(newly_failing)}")
        send_email(
            f"[Hermes] {len(newly_failing)} enabled unit(s) not active on {NODE}",
            f"Node: {NODE}\n\nThe following enabled unit(s) are not active:\n\n" +
            "\n".join(lines) +
            "\n\nThis is the generic boot/periodic unit check (IMPLEMENTATION_PLAN.md S32 item "
            "a). The common cause is a unit left stranded by a dependency failure at boot -- "
            "Restart=always never retries a start job that failed because a dependency (e.g. "
            "/mnt/hermes-data) wasn't ready yet. Run `systemctl status <unit>` and its journal "
            "next; `hermes-unlock.sh` restarts the units it knows about after a mount recovers.",
        )
    if recovered:
        log(f"recovered: {sorted(recovered)}")
        matrix_notice(f"[boot-unit-check:{NODE}] recovered: {sorted(recovered)}")
        send_email(
            f"[Hermes] recovered on {NODE}: {len(recovered)} unit(s) active again",
            f"Node: {NODE}\n\nThe following previously-flagged unit(s) are active again:\n\n" +
            "\n".join(f"  {u}" for u in sorted(recovered)),
        )
    if current and not newly_failing and not recovered:
        log(f"still not active (already alerted, no new state change): {sorted(current)}")

    save_state(current)
    print(f"{len(current)} enabled unit(s) not active" + (f": {sorted(current)}" if current else ""))
    return 1 if current else 0


if __name__ == "__main__":
    sys.exit(main())
