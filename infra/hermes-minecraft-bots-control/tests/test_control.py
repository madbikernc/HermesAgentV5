#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for tools/hermes-minecraft-bots-control.py: systemctl and ssh are replaced by a
# stub that records every command and answers from a small fixed roster, so nothing here touches
# a real bot or host.
#
#   python3 infra/hermes-minecraft-bots-control/tests/test_control.py
import importlib.util
import json
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def load():
    spec = importlib.util.spec_from_file_location(
        "mbc", REPO / "tools" / "hermes-minecraft-bots-control.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


LOCAL_UNITS = "minecraft-bot-amy.service  enabled enabled\n"
REMOTE_UNITS = {"spark2": "minecraft-bot-dale.service enabled enabled\n"}


def main():
    mod = load()

    def fake_run(calls, action_rc=0, action_err=""):
        def run(cmd, timeout=20):
            calls.append(cmd)
            if cmd[:2] == ["systemctl", "list-unit-files"]:
                return LOCAL_UNITS, "", 0
            if cmd[0] == "ssh" and "list-unit-files" in cmd:
                host = cmd[5]  # ssh -o ... -o ... <host> systemctl list-unit-files ...
                return REMOTE_UNITS.get(host, ""), "", (0 if host in REMOTE_UNITS else 1)
            if cmd[:2] == ["sudo", "systemctl"] or (cmd[0] == "ssh" and "sudo" in cmd):
                return "", action_err, action_rc
            raise AssertionError(f"unexpected command {cmd}")
        return run

    print("\n[locate(): asks each host directly, never guesses]")
    calls = []
    mod.run = fake_run(calls)
    check("a bot with a local unit resolves to this host (empty string)",
          mod.locate("amy") == "")
    check("only the local discovery call was made for it",
          calls == [["systemctl", "list-unit-files", "--no-legend", "minecraft-bot-*.service"]],
          calls)

    calls.clear()
    check("a bot with only a remote unit resolves to that host", mod.locate("dale") == "spark2")
    check("local was tried first, then the remote", len(calls) == 2 and calls[0][:2]
          == ["systemctl", "list-unit-files"] and calls[1][0] == "ssh", calls)

    calls.clear()
    check("a bot on no known host resolves to None", mod.locate("nobody") is None)

    print("\n[apply_action(): local runs systemctl directly, remote wraps it in ssh]")
    calls.clear()
    mod.run = fake_run(calls, action_rc=0)
    rc, detail = mod.apply_action("amy", "restart", "")
    check("a local action runs sudo systemctl directly",
          calls[-1] == ["sudo", "systemctl", "restart", "minecraft-bot-amy.service"], calls)
    check("rc 0 with no stderr", rc == 0 and detail == "", (rc, detail))

    calls.clear()
    mod.run = fake_run(calls, action_rc=0)
    mod.apply_action("dale", "stop", "spark2")
    check("a remote action is wrapped in ssh to the right host",
          calls[-1][-4:] == ["sudo", "systemctl", "stop", "minecraft-bot-dale.service"]
          and calls[-1][0] == "ssh" and "spark2" in calls[-1], calls)

    print("\n[process(): never trusts the request file -- re-validates against its own roster]")
    mod.run = fake_run([])
    pending = {"id": "1", "bot": "amy", "action": "restart", "requested_at": 0,
               "requested_by": "x", "status": "pending", "result": None, "detail": None,
               "completed_at": None}
    reqs = [dict(pending)]
    changed = mod.process(reqs)
    check("a legal local request succeeds", changed and reqs[0]["status"] == "done"
          and reqs[0]["result"] == "ok" and reqs[0]["completed_at"] is not None, reqs[0])

    reqs = [dict(pending, bot="dale", action="stop")]
    mod.run = fake_run([])
    mod.process(reqs)
    check("a legal remote request succeeds too", reqs[0]["result"] == "ok", reqs[0])

    calls = []
    mod.run = fake_run(calls)
    reqs = [dict(pending, bot="nobody")]
    mod.process(reqs)
    check("an unknown bot fails cleanly, named, without ever attempting systemctl",
          reqs[0]["result"] == "error" and "no such bot" in reqs[0]["detail"]
          and not any(c[:2] == ["sudo", "systemctl"] for c in calls), reqs[0])

    calls = []
    mod.run = fake_run(calls)
    reqs = [dict(pending, action="yeet")]
    mod.process(reqs)
    check("a bad action is refused before even asking a host where the bot lives",
          reqs[0]["result"] == "error" and "invalid" in reqs[0]["detail"] and calls == [], reqs[0])

    mod.run = fake_run([], action_rc=1, action_err="Unit minecraft-bot-amy.service not found.")
    reqs = [dict(pending)]
    mod.process(reqs)
    check("a non-zero systemctl exit is a named failure, not reported as success",
          reqs[0]["result"] == "error" and reqs[0]["detail"] == "Unit minecraft-bot-amy.service not found.",
          reqs[0])

    mod.run = fake_run([])
    done = {"id": "2", "bot": "amy", "action": "stop", "requested_at": 0, "requested_by": "",
            "status": "done", "result": "ok", "detail": None, "completed_at": 1}
    reqs = [dict(done)]
    changed = mod.process(reqs)
    check("an already-done request is left alone, and process() says nothing changed",
          reqs[0] == done and changed is False, reqs[0])

    calls = []
    mod.run = fake_run(calls)
    huge = "x" * (mod.DETAIL_MAX + 200)
    mod.run = fake_run([], action_rc=1, action_err=huge)
    reqs = [dict(pending)]
    mod.process(reqs)
    check("an oversized stderr is truncated, never stored whole",
          len(reqs[0]["detail"]) == mod.DETAIL_MAX, len(reqs[0]["detail"]))

    print("\n[main(): reads, processes, writes back -- and a missing file is not an error]")
    mod.run = fake_run([])
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "control-requests.json"
        mod.CONTROL_PATH = path
        check("a missing request file is a clean no-op", mod.main([]) == 0)

        path.write_text(json.dumps([dict(pending)]))
        check("main() exits 0 on a real pending request", mod.main([]) == 0)
        on_disk = json.loads(path.read_text())
        check("the file is rewritten with the real outcome",
              on_disk[0]["status"] == "done" and on_disk[0]["result"] == "ok", on_disk)

        path.write_text(json.dumps([dict(done)]))
        before = path.stat().st_mtime_ns
        mod.main([])
        check("nothing pending means no rewrite at all", path.stat().st_mtime_ns == before)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        raise SystemExit(f"{len(FAILURES)} check(s) failed: {FAILURES}")


if __name__ == "__main__":
    main()
