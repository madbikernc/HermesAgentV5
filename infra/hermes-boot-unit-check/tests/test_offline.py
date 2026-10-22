#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-21, S32 fix): two new scenarios for hermes-boot-unit-check.py 1.2.0's auto-
# recovery -- mount_is_up() is monkeypatched directly (never the real os.path.ismount, and never
# the real hermes-unlock.sh, which fake_run_with_recovery intercepts the same way fake_run
# already intercepts systemctl) so this stays a real offline check with no live mount or
# systemctl needed.
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
    "hermes-memory.service": ("simple", "inactive"),       # stranded -- must be flagged
    "hermes-buzz.service": ("simple", "active"),           # healthy -- must not be flagged
    "hermes-backup-job.service": ("oneshot", "inactive"),   # normal post-run state -- must NOT be flagged
    "hermes-fleet-health.timer": ("", "active"),           # healthy timer
    # Real false positives found live on spark 2026-10-16: enabled, permanently `inactive` by
    # design, Type isn't "oneshot" but behaves like one -- never reached because UNIT_PREFIXES
    # excludes them before the Type check even runs. If this ever showed up flagged, it means
    # the prefix filter regressed, not that systemd's own state changed.
    "rsyslog.service": ("notify", "inactive"),
}

FAKE_UNIT_FILES = {
    "service": "hermes-memory.service enabled          \n"
               "hermes-buzz.service enabled             \n"
               "hermes-backup-job.service enabled       \n"
               "foo@.service enabled                    \n"  # template -- must be skipped
               "rsyslog.service enabled                 \n",  # non-fleet unit -- must be skipped
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
          "hermes-backup-job.service" not in problems, problems)
    check("the template unit is skipped entirely", "foo@.service" not in problems, problems)
    check("the healthy timer is not flagged", "hermes-fleet-health.timer" not in problems, problems)
    check("a non-fleet unit is skipped by the prefix filter, even though it's 'inactive'",
          "rsyslog.service" not in problems, problems)
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

    print("\n[S32: auto-recovery is never attempted while the mount itself is down]")
    FAKE_SHOW["hermes-memory.service"] = ("simple", "inactive")  # stranded again, fresh scenario
    d2, alerts2 = load_tool()
    d2.STATE_PATH = Path(tempfile.mkdtemp()) / "state.json"
    d2.mount_is_up = lambda: False
    rc5 = d2.main()
    check("still exits 1 when the mount itself is down", rc5 == 1, f"rc={rc5}")
    check("no auto-recovery email when the mount is down",
          not any("auto-recovered" in subj for subj, _ in alerts2.emails), alerts2.emails)
    check("real hermes-unlock.sh is never invoked while the mount is down",
          d2.attempt_auto_recovery(d2.find_not_active()) is None)

    print("\n[S32: mount is up -- hermes-unlock.sh runs automatically and clears the strand]")
    d3, alerts3 = load_tool()
    d3.STATE_PATH = Path(tempfile.mkdtemp()) / "state.json"
    d3.mount_is_up = lambda: True
    d3.UNLOCK_SCRIPT = TOOLS / "hermes-unlock.sh"  # must exist for the .exists() gate; never really run

    recovery_calls = []

    def fake_run_with_recovery(cmd, timeout=15):
        if cmd[:1] == ["bash"]:
            recovery_calls.append(cmd)
            FAKE_SHOW["hermes-memory.service"] = ("simple", "active")  # simulate the real restart
            return "Restarting hermes-memory.service (found inactive/failed...)", 0
        return fake_run(cmd, timeout)

    d3.run = fake_run_with_recovery
    rc6 = d3.main()
    check("hermes-unlock.sh was actually invoked", len(recovery_calls) == 1, recovery_calls)
    check("exit code is clean -- the restart fixed it within this same run", rc6 == 0, f"rc={rc6}")
    check("exactly one auto-recovery email, no separate newly-failing or recovered email",
          len(alerts3.emails) == 1 and "auto-recovered" in alerts3.emails[0][0], alerts3.emails)
    check("the auto-recovery email names the unit",
          "hermes-memory.service" in alerts3.emails[0][1], alerts3.emails)
    check("exactly one auto-recovery matrix notice", len(alerts3.notices) == 1, alerts3.notices)
    check("state file records no failing units -- the strand never outlived this run",
          json.loads(d3.STATE_PATH.read_text())["failing"] == [])

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
