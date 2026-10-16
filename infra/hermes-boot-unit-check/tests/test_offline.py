#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-10-16) - S32 item (a): offline checks for hermes-boot-unit-check.py's parsing and
# alert-dedup logic. No real systemctl needed -- `run()` is monkeypatched to canned
# `systemctl list-unit-files`/`show` output, and hermes_alert_common is stubbed to capture calls
# instead of touching SMTP/Matrix, same stubbing approach test_relevance_gate.py and
# test_error_vs_quiet.py already use for their own tools.
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


# unit -> (Type, ActiveState). Empty Type means "show" didn't report one (timers don't have it).
FAKE_SHOW = {
    "hermes-memory.service": ("simple", "inactive"),    # stranded -- must be flagged
    "hermes-buzz.service": ("simple", "active"),        # healthy -- must not be flagged
    "backup-job.service": ("oneshot", "inactive"),       # normal post-run state -- must NOT be flagged
    "hermes-fleet-health.timer": ("", "active"),         # healthy timer
}

FAKE_UNIT_FILES = {
    "service": "hermes-memory.service enabled        \n"
               "hermes-buzz.service enabled           \n"
               "backup-job.service enabled             \n"
               "foo@.service enabled                   \n",  # template -- must be skipped
    "timer": "hermes-fleet-health.timer enabled        \n",
}


def fake_run(cmd, timeout=15):
    if cmd[:2] == ["systemctl", "list-unit-files"]:
        utype = next(a.split("=", 1)[1] for a in cmd if a.startswith("--type="))
        return FAKE_UNIT_FILES.get(utype, ""), 0
    if cmd[:2] == ["systemctl", "show"]:
        unit = cmd[2]
        utype, state = FAKE_SHOW.get(unit, ("", "active"))
        lines = ([f"Type={utype}"] if utype else []) + [f"ActiveState={state}"]
        return "\n".join(lines), 0
    return "", 1


class CapturedAlerts(types.ModuleType):
    def __init__(self):
        super().__init__("hermes_alert_common")
        self.emails = []
        self.notices = []

    def send_email(self, subject, body, log=print):
        self.emails.append((subject, body))

    def matrix_notice(self, text, log=print):
        self.notices.append(text)


def load_tool():
    alerts = CapturedAlerts()
    sys.modules["hermes_alert_common"] = alerts
    spec = importlib.util.spec_from_file_location("boot_unit_check", TOOLS / "hermes-boot-unit-check.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["boot_unit_check"] = mod
    spec.loader.exec_module(mod)
    mod.run = fake_run
    return mod, alerts


def main():
    print("\n[find_not_active: oneshot and templates excluded, real failures flagged]")
    d, alerts = load_tool()
    d.STATE_PATH = Path(tempfile.mkdtemp()) / "state.json"

    problems = d.find_not_active()
    check("the stranded service is flagged", problems.get("hermes-memory.service") == "inactive",
          problems)
    check("the healthy service is not flagged", "hermes-buzz.service" not in problems, problems)
    check("the oneshot service is never flagged, even though it's 'inactive'",
          "backup-job.service" not in problems, problems)
    check("the template unit is skipped entirely", "foo@.service" not in problems, problems)
    check("the healthy timer is not flagged", "hermes-fleet-health.timer" not in problems, problems)
    check("exactly one real problem found", len(problems) == 1, problems)

    print("\n[main(): first run alerts once on the new failure]")
    rc1 = d.main()
    check("exit code reflects the failure", rc1 == 1, f"rc={rc1}")
    check("exactly one email sent", len(alerts.emails) == 1, alerts.emails)
    check("the email names the stranded unit", "hermes-memory.service" in alerts.emails[0][1],
          alerts.emails)
    check("exactly one matrix notice sent", len(alerts.notices) == 1, alerts.notices)
    check("state file now records the failing unit",
          "hermes-memory.service" in json.loads(d.STATE_PATH.read_text())["failing"])

    print("\n[main(): second run, same failure, does NOT re-alert]")
    rc2 = d.main()
    check("exit code still reflects the ongoing failure", rc2 == 1, f"rc={rc2}")
    check("no additional email sent", len(alerts.emails) == 1, alerts.emails)
    check("no additional matrix notice sent", len(alerts.notices) == 1, alerts.notices)

    print("\n[main(): third run, the unit recovers -- exactly one recovery alert]")
    FAKE_SHOW["hermes-memory.service"] = ("simple", "active")
    rc3 = d.main()
    check("exit code is clean once nothing is failing", rc3 == 0, f"rc={rc3}")
    check("exactly one recovery email sent", len(alerts.emails) == 2, alerts.emails)
    check("the recovery email names the unit", "hermes-memory.service" in alerts.emails[1][1],
          alerts.emails)
    check("exactly one recovery matrix notice sent", len(alerts.notices) == 2, alerts.notices)
    check("state file is now empty", json.loads(d.STATE_PATH.read_text())["failing"] == [])

    print("\n[main(): fourth run, still clean -- no further alerts]")
    rc4 = d.main()
    check("exit code stays clean", rc4 == 0, f"rc={rc4}")
    check("no further alerts of either kind",
          len(alerts.emails) == 2 and len(alerts.notices) == 2,
          (alerts.emails, alerts.notices))

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
