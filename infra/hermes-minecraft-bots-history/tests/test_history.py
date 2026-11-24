#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for tools/hermes-minecraft-bots-history.py: systemctl, ssh and journalctl are
# replaced by a stub that records every command and answers from a small fixed roster/journal, so
# nothing here touches a real bot or host.
#
#   python3 infra/hermes-minecraft-bots-history/tests/test_history.py
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
        "mbh", REPO / "tools" / "hermes-minecraft-bots-history.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


LOCAL_UNITS = "minecraft-bot-amy.service  enabled enabled\n"
REMOTE_UNITS = {"spark2": "minecraft-bot-dale.service enabled enabled\n"}


def journal_line(at, msg):
    return json.dumps({"MESSAGE": msg, "__REALTIME_TIMESTAMP": str(int(at * 1e6))})


def main():
    mod = load()

    def fake_run(calls, journal_out="", journal_rc=0, journal_err=""):
        def run(cmd, timeout=20):
            calls.append(cmd)
            if cmd[:2] == ["systemctl", "list-unit-files"]:
                return LOCAL_UNITS, "", 0
            if cmd[0] == "ssh" and "list-unit-files" in cmd:
                host = cmd[5]  # ssh -o ... -o ... <host> systemctl list-unit-files ...
                return REMOTE_UNITS.get(host, ""), "", (0 if host in REMOTE_UNITS else 1)
            if "journalctl" in cmd:
                return journal_out, journal_err, journal_rc
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

    print("\n[fetch_actions(): local runs journalctl directly, remote wraps it in ssh, parsed "
          "newest-first]")
    # journalctl's own output is oldest-first; fetch_actions() reverses it to newest-first.
    journal_out = "\n".join([
        journal_line(90, "[Amy] OUTCOME {\"type\": \"flee\", \"ok\": false, \"cancelled\": false, "
                         "\"refused\": false, \"why\": \"no path\"}"),
        journal_line(100, "[Amy] OUTCOME {\"type\": \"mine\", \"ok\": true, \"ms\": 500}"),
    ])
    calls = []
    mod.run = fake_run(calls, journal_out=journal_out)
    actions, err = mod.fetch_actions("amy", "")
    check("a local fetch runs journalctl directly",
          calls[-1][0] == "journalctl" and calls[-1][1] == "_SYSTEMD_UNIT=minecraft-bot-amy.service",
          calls)
    check("no --since window is ever passed", not any("--since" in c for c in calls[-1]), calls)
    check("results come back newest first, parsed and stripped of the bot name prefix",
          err is None and len(actions) == 2 and actions[0]["type"] == "mine"
          and actions[0]["result"] == "ok" and actions[1]["type"] == "flee"
          and actions[1]["result"] == "failed" and actions[1]["why"] == "no path", (actions, err))

    calls = []
    mod.run = fake_run(calls, journal_out=journal_out)
    mod.fetch_actions("dale", "spark2")
    check("a remote fetch is wrapped in ssh to the right host",
          calls[-1][0] == "ssh" and "spark2" in calls[-1] and "journalctl" in calls[-1], calls)

    calls = []
    mod.run = fake_run(calls, journal_rc=1, journal_err="Failed to add match.")
    actions, err = mod.fetch_actions("amy", "")
    check("a non-zero journalctl exit is a named failure, not an empty success",
          actions is None and err == "Failed to add match.", (actions, err))

    print("\n[process(): a dict keyed by bot, never trusts the request file -- re-validates "
          "against its own roster]")
    mod.run = fake_run([], journal_out=journal_out)
    pending = {"status": "pending", "requested_at": 0, "requested_by": "x",
               "actions": None, "detail": None, "completed_at": None}
    reqs = {"amy": dict(pending)}
    changed = mod.process(reqs)
    check("a legal local request succeeds", changed and reqs["amy"]["status"] == "done"
          and reqs["amy"]["result"] == "ok" and len(reqs["amy"]["actions"]) == 2
          and reqs["amy"]["completed_at"] is not None, reqs["amy"])

    mod.run = fake_run([], journal_out=journal_out)
    reqs = {"dale": dict(pending)}
    mod.process(reqs)
    check("a legal remote request succeeds too", reqs["dale"]["result"] == "ok", reqs["dale"])

    calls = []
    mod.run = fake_run(calls, journal_out=journal_out)
    reqs = {"nobody": dict(pending)}
    mod.process(reqs)
    check("an unknown bot fails cleanly, named, without ever attempting journalctl",
          reqs["nobody"]["result"] == "error" and "no such bot" in reqs["nobody"]["detail"]
          and not any("journalctl" in c for c in calls), reqs["nobody"])

    mod.run = fake_run([], journal_rc=1, journal_err="Unit minecraft-bot-amy.service not found.")
    reqs = {"amy": dict(pending)}
    mod.process(reqs)
    check("a non-zero journalctl exit is a named failure, not reported as success",
          reqs["amy"]["result"] == "error"
          and reqs["amy"]["detail"] == "Unit minecraft-bot-amy.service not found."
          and reqs["amy"]["actions"] is None, reqs["amy"])

    mod.run = fake_run([], journal_out=journal_out)
    done = {"status": "done", "requested_at": 0, "requested_by": "", "actions": [],
            "detail": None, "completed_at": 1}
    reqs = {"amy": dict(done)}
    changed = mod.process(reqs)
    check("an already-done request is left alone, and process() says nothing changed",
          reqs["amy"] == done and changed is False, reqs["amy"])

    huge = "x" * (mod.DETAIL_MAX + 200)
    mod.run = fake_run([], journal_rc=1, journal_err=huge)
    reqs = {"amy": dict(pending)}
    mod.process(reqs)
    check("an oversized stderr is truncated, never stored whole",
          len(reqs["amy"]["detail"]) == mod.DETAIL_MAX, len(reqs["amy"]["detail"]))

    print("\n[main(): reads, processes, writes back -- and a missing file is not an error]")
    mod.run = fake_run([], journal_out=journal_out)
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "history-requests.json"
        mod.HISTORY_PATH = path
        check("a missing request file is a clean no-op", mod.main([]) == 0)

        path.write_text(json.dumps({"amy": dict(pending)}))
        check("main() exits 0 on a real pending request", mod.main([]) == 0)
        on_disk = json.loads(path.read_text())
        check("the file is rewritten with the real outcome",
              on_disk["amy"]["status"] == "done" and on_disk["amy"]["result"] == "ok"
              and len(on_disk["amy"]["actions"]) == 2, on_disk)

        path.write_text(json.dumps({"amy": dict(done)}))
        before = path.stat().st_mtime_ns
        mod.main([])
        check("nothing pending means no rewrite at all", path.stat().st_mtime_ns == before)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        raise SystemExit(f"{len(FAILURES)} check(s) failed: {FAILURES}")


if __name__ == "__main__":
    main()
