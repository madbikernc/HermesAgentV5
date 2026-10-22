#!/usr/bin/env python3
# Version: 1.2.0
#
# 1.2.0 (2026-10-21, direct request "S32 fix" - IMPLEMENTATION_PLAN.md S32): closes the real gap
# left after S32's investigation -- RequiresMountsFor=/mnt/hermes-data on all seven dependent
# units and hermes-unlock.sh's restart_stranded_units() both already existed, but nothing ever
# triggered the latter automatically. hermes-unlock.sh stayed a manual, SSH-in-and-run-it script,
# which is exactly why three straggler units were still down 51 hours into the real 2026-10-11
# outage. This timer already runs every 15 minutes and already knows which hermes- units are
# down; attempt_auto_recovery() now shells out to hermes-unlock.sh whenever any are, but ONLY
# after confirming /mnt/hermes-data is actually mounted (os.path.ismount(), checked here in
# Python before the script is even invoked -- never left to the script's own internal branching
# alone). hermes-unlock.sh's "already mounted" branch is all this ever reaches: it never attempts
# to unlock the LUKS container itself, which stays a deliberate human-only step
# (infra/spark2-disk-encryption/README.md) -- this does not change that boundary, it only closes
# the gap between "the mount is already back" and "a human remembered to say so."
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

MOUNT_POINT = os.environ.get("HERMES_DATA_MOUNT", "/mnt/hermes-data")
UNLOCK_SCRIPT = Path(__file__).resolve().parent / "hermes-unlock.sh"

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


def mount_is_up():
    return os.path.ismount(MOUNT_POINT)


def attempt_auto_recovery(problems):
    """S32: a unit down because it was stranded by a dependency failure (Restart=always never
    retries that, only a crash) needs a restart, not a wait for it to crash again on its own.
    hermes-unlock.sh already has exactly that restart logic (restart_stranded_units(), the real
    unit list, idempotent). This only ever calls it when /mnt/hermes-data is already confirmed
    mounted -- checked here in Python, before the script runs at all -- so this can never reach
    hermes-unlock.sh's own LUKS-unlock branch, which stays a deliberate human-only step. Returns
    the script's combined output on a real attempt, or None if no attempt was made."""
    if not problems:
        return None
    if not mount_is_up():
        log(f"{len(problems)} unit(s) not active, but {MOUNT_POINT} is not mounted -- "
            "nothing to auto-recover; this needs a human to unlock it")
        return None
    if not UNLOCK_SCRIPT.exists():
        log(f"WARNING: {UNLOCK_SCRIPT} not found, cannot auto-recover")
        return None
    out, rc = run(["bash", str(UNLOCK_SCRIPT)], timeout=60)
    log(f"ran {UNLOCK_SCRIPT.name} ({MOUNT_POINT} is mounted, {len(problems)} unit(s) were not "
        f"active): rc={rc}\n{out}")
    return out


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
    pre_recovery = set(problems)
    if attempt_auto_recovery(problems) is not None:
        problems = find_not_active()  # re-check for real after the recovery attempt, never assumed
    recovered_automatically = sorted(pre_recovery - set(problems))

    current = set(problems)
    prev = load_prev_failing()

    newly_failing = current - prev
    recovered = prev - current

    if recovered_automatically:
        # Deliberately its own notice, not folded into `recovered` below: that comparison is
        # against the *previous run's* saved state, so a unit stranded and auto-fixed within one
        # 15-minute cycle would otherwise never appear in newly_failing OR recovered and this
        # would go completely silent -- exactly the kind of self-healing that should still be
        # visible, since repeated auto-recoveries are themselves a signal something upstream
        # keeps stranding these units.
        log(f"auto-recovered via {UNLOCK_SCRIPT.name}: {recovered_automatically}")
        matrix_notice(f"[boot-unit-check:{NODE}] auto-recovered {len(recovered_automatically)} "
                       f"unit(s) once {MOUNT_POINT} was confirmed mounted: {recovered_automatically}")
        send_email(
            f"[Hermes] {NODE}: {len(recovered_automatically)} unit(s) auto-recovered",
            f"Node: {NODE}\n\nThe following unit(s) were found stranded (a dependency failure "
            f"that Restart=always never retries) and were automatically restarted because "
            f"{MOUNT_POINT} is confirmed mounted:\n\n" +
            "\n".join(f"  {u}" for u in recovered_automatically) +
            f"\n\nThis is {UNLOCK_SCRIPT.name} running automatically from this timer (S32), "
            "closing the gap where it previously needed a human to notice and run it by hand -- "
            "the real 2026-10-11 incident left three units down for 51 hours this way.",
        )

    if newly_failing:
        lines = [f"  {u}: {problems[u]}" for u in sorted(newly_failing)]
        log(f"newly not active: {sorted(newly_failing)}")
        matrix_notice(f"[boot-unit-check:{NODE}] {len(newly_failing)} enabled unit(s) not "
                       f"active: {sorted(newly_failing)}")
        send_email(
            f"[Hermes] {len(newly_failing)} enabled unit(s) not active on {NODE}",
            f"Node: {NODE}\n\nThe following enabled unit(s) are not active:\n\n" +
            "\n".join(lines) +
            "\n\nThis is the generic boot/periodic unit check (IMPLEMENTATION_PLAN.md S32). "
            f"{UNLOCK_SCRIPT.name}'s automatic restart already ran against this (S32 fix) and "
            "did not clear it, so this is not the common stranded-by-the-mount-dependency race "
            f"on its own -- either {MOUNT_POINT} itself is still not mounted (needs a human to "
            "unlock it), the unit isn't in hermes-unlock.sh's own DEPENDENT_UNITS list, or the "
            "restart itself failed for an unrelated reason. Run `systemctl status <unit>` and "
            "its journal next.",
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
