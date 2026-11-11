#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for tools/hermes-minecraft-bots-status.py: systemctl and journalctl are replaced
# by canned output (the real shapes, captured from spark-2 on 2026-11-11), the memory directory
# by a temp dir, and ssh by a stub, so nothing here touches a bot, a journal or a host.
#
#   python3 infra/hermes-minecraft-bots-status/tests/test_status.py
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
NL = chr(10)
FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def load(memory_dir):
    os.environ["MC_MEMORY_ROOT"] = str(memory_dir)
    spec = importlib.util.spec_from_file_location("mbs", REPO / "tools" / "hermes-minecraft-bots-status.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def jline(at_s, msg):
    return json.dumps({"__REALTIME_TIMESTAMP": str(int(at_s * 1e6)), "MESSAGE": msg})


UNIT_FILES = ("minecraft-bot-bob.service  enabled enabled" + NL +
              "minecraft-bot-wade.service enabled enabled" + NL)
SHOW = {
    "minecraft-bot-bob.service": "ActiveState=active" + NL + "SubState=running" + NL +
        "ActiveEnterTimestamp=@1794404484" + NL + "InactiveEnterTimestamp=@1794404400" + NL + "NRestarts=2",
    "minecraft-bot-wade.service": "ActiveState=inactive" + NL + "SubState=dead" + NL +
        "ActiveEnterTimestamp=@1794400000" + NL + "InactiveEnterTimestamp=@1794404210" + NL + "NRestarts=0",
}
OUTCOMES = [
    jline(100, '[Bob] OUTCOME {"type":"mine","ok":false,"cancelled":true,"refused":false,"ms":1364}'),
    jline(101, '[Bob] OUTCOME {"type":"loot","ok":false,"cancelled":false,"refused":false,"ms":8922,'
               '"why":"checked nearby chests, no food in any of them."}'),
    jline(102, '[Bob] OUTCOME {"type":"flee","ok":true,"cancelled":false,"refused":false,"ms":15}'),
    jline(103, '[Bob] OUTCOME {"type":"place","ok":false,"cancelled":false,"refused":true,"ms":0}'),
    jline(104, "[Bob] OUTCOME not json at all"),
]
TAIL = [
    jline(200, "[Bob] bed goal: no sheep nearby to get wool from, even after looking around. (ok=false)"),
    jline(201, "[Bob] path_update status=success nodes=1 visited=2 cost=41.0 time=0ms"),
    jline(202, "[Bob] self-defense: threat detected (skeleton) -- force-cancelling current action"),
    jline(203, "[Bob] mem rss=196.8MB heap=80.1/90.0MB"),
    jline(204, '[Bob] OUTCOME {"type":"flee","ok":true}'),
    jline(205, "[Bob] self-defense result: made it to safety. (ok=true)"),
    jline(206, "[Bob] path_reset: goal_updated"),
]
GOAL_EVENTS = [
    jline(150, "[Bob] self-proposed goal: make myself a bed and place it at home"),
    jline(160, "[Bob] path_reset: goal_updated"),
]


def fake_run(calls):
    def run(cmd, timeout=20):
        calls.append(cmd)
        if cmd[:2] == ["systemctl", "list-unit-files"]:
            return UNIT_FILES, 0
        if cmd[:2] == ["systemctl", "show"]:
            return SHOW[cmd[-1]], 0
        if cmd[0] == "journalctl":
            unit = cmd[1].split("=", 1)[1]
            if unit != "minecraft-bot-bob.service":
                return "", 0
            if "OUTCOME" in " ".join(cmd):
                return NL.join(OUTCOMES), 0
            if "-g" in cmd:
                return NL.join(GOAL_EVENTS), 0
            return NL.join(TAIL), 0
        raise AssertionError(f"unexpected command {cmd}")
    return run


def main():
    with tempfile.TemporaryDirectory() as td:
        mem = Path(td)
        (mem / "bots" / "bob").mkdir(parents=True)
        (mem / "bots" / "bob" / "goal.json").write_text(json.dumps({
            "description": "make myself a bed and place it at home", "source": "self", "setBy": None,
            "createdAt": 1794405107871, "updatedAt": 1794405107871, "steps": 8,
            "consecutiveFailures": 8, "sawSuccess": False, "log": ["x"] * 50, "farmTask": "bed"}))
        mbs = load(mem)
        calls = []
        mbs.run = fake_run(calls)

        print(NL + "[outcome lines]")
        o = mbs.parse_outcome(5, 'OUTCOME {"type":"loot","ok":false,"cancelled":false,"refused":false,'
                                 '"ms":8922,"why":"no food"}')
        check("a failed action is 'failed' with its reason", o == {"at": 5, "type": "loot", "result": "failed",
              "ms": 8922, "why": "no food"}, str(o))
        check("cancelled wins over failed", mbs.parse_outcome(0, 'OUTCOME {"type":"mine","ok":false,'
              '"cancelled":true}')["result"] == "cancelled")
        check("a refusal is 'refused'", mbs.parse_outcome(0, 'OUTCOME {"type":"x","ok":false,'
              '"refused":true}')["result"] == "refused")
        check("ok is 'ok'", mbs.parse_outcome(0, 'OUTCOME {"type":"x","ok":true}')["result"] == "ok")
        check("a malformed OUTCOME is skipped, not raised", mbs.parse_outcome(0, "OUTCOME {nope") is None)
        check("a non-OUTCOME line is not an action", mbs.parse_outcome(0, "goal: x") is None)
        check("the [Name] prefix is stripped", mbs.strip_name("[Dale] OUTCOME {}") == "OUTCOME {}")

        print(NL + "[one host's collection]")
        snap = mbs.collect_local()
        bots = {b["name"]: b for b in snap["bots"]}
        check("every unit file is a bot, stopped ones included", sorted(bots) == ["bob", "wade"], str(sorted(bots)))
        bob, wade = bots["bob"], bots["wade"]
        check("a running bot's since is when it started", bob["active_state"] == "active"
              and bob["since"] == 1794404484.0, str(bob["since"]))
        check("a stopped bot's since is when it stopped", wade["active_state"] == "inactive"
              and wade["since"] == 1794404210.0, str(wade["since"]))
        check("restarts are carried", bob["restarts"] == 2)
        check("the goal comes from goal.json, without its step log",
              bob["goal"]["description"].startswith("make myself a bed") and "log" not in bob["goal"]
              and bob["goal"]["consecutiveFailures"] == 8, str(bob["goal"]))
        check("no goal.json means no goal", wade["goal"] is None)
        check("actions are newest first, malformed lines dropped",
              [a["type"] for a in bob["actions"]] == ["place", "flee", "loot", "mine"], str(bob["actions"]))
        check("each action carries its result", [a["result"] for a in bob["actions"]]
              == ["refused", "ok", "failed", "cancelled"])
        check("latest skips pathfinder, memory and OUTCOME noise: the three newest meaningful lines",
              [l["at"] for l in bob["latest"]] == [205, 202, 200], str([l["at"] for l in bob["latest"]]))
        check("the last goal event ignores the pathfinder's goal_updated",
              bob["last_goal_event"]["text"].startswith("self-proposed goal"), str(bob["last_goal_event"]))
        journal_calls = [c for c in calls if c[0] == "journalctl"]
        check("the journal is read by _SYSTEMD_UNIT, so systemd's own lines stay out",
              all(c[1].startswith("_SYSTEMD_UNIT=") for c in journal_calls) and "-u" not in sum(journal_calls, []))
        check("actions ask the journal for only the last 20",
              any("20" in c and "OUTCOME" in " ".join(c) for c in journal_calls))

        print(NL + "[roles from the real roles.js]")
        roles = mbs.read_roles()
        check("Bob is the Farmer and Dale the Herder", roles.get("bob") == "Farmer" and roles.get("dale") == "Herder",
              str(roles))
        check("all nine bots have a role", len(roles) == 9, str(roles))
        check("a missing roles.js gives no roles rather than raising", mbs.read_roles(mem / "nope.js") == {})

        print(NL + "[the whole snapshot, with spark-2 down]")
        def ssh_fails(cmd, timeout=20):
            if cmd[0] == "ssh":
                return "", 255
            return fake_run([])(cmd, timeout)
        mbs.run = ssh_fails
        mbs.REMOTES = ["spark2"]
        full = mbs.build_snapshot()
        check("the local host and the remote are both present", [h["host"] for h in full["hosts"]][1:] == ["spark2"])
        check("an unreachable remote is recorded with its error, not dropped",
              full["hosts"][1]["error"] and full["hosts"][1]["bots"] == [], str(full["hosts"][1]))
        check("roles are attached to every bot", all("role" in b for b in full["hosts"][0]["bots"]))
        remote_json = json.dumps({"host": "spark-2", "collected_at": "x", "error": None,
                                  "bots": [{"name": "dale", "active_state": "active"}]})
        mbs.run = lambda cmd, timeout=20: (remote_json, 0) if cmd[0] == "ssh" else fake_run([])(cmd, timeout)
        full = mbs.build_snapshot()
        check("a reachable remote's bots are merged in, with roles",
              full["hosts"][1]["bots"][0].get("role") == "Herder", str(full["hosts"][1]))

        print(NL + "[the snapshot file]")
        path = mem / "state" / "status.json"
        mbs.write_snapshot(full, path)
        check("it is written where the page reads it, as JSON", json.loads(path.read_text())["hosts"])
        check("and no temp file is left behind", not path.with_suffix(".tmp").exists())

    print(f"{NL}{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
