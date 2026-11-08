#!/usr/bin/env python3
# Version: 2.0.0
#
# 2.0.0 (2026-11-08) — renamed from test_minecraft_bridge.py alongside the bridge's own
# generalization (hermes-self-repair-bridge.py 2.0.0, Phase 4/§8.4): poll_domain_buzz_topic()
# became poll_domain_buzz_source() (state keyed "buzz:<topic>", not "<topic>", since a second
# scheme now shares the same state dict) and seek_to_end() became seek_to_end_buzz(). Added checks
# for the new "memory-turns" source poller and the egress-guard handler domain #2 actually uses.
#
# Offline checks for tools/hermes-self-repair-bridge.py's PURE logic (parsing, severity/dedup
# gating, problem-text templating, path validation) -- the parts the module's own header says are
# offline-testable. Network/sqlite-touching glue (Buzz polling, direct sqlite reads, the
# path-resolution model call, task submission) is deliberately NOT exercised here; it was
# proven-shape-compatible by reusing hermes-self-repair-submit.py's own
# {"path","problem"}/pointer-envelope conventions instead, the same way every other self-repair
# component already does.
#
# Fixture bodies below are built to match tools/hermes-minecraft-triage.py's own
# triage_incident()/diagnosis_worker() output EXACTLY (including the blank line + occurrences
# suffix diagnosis_worker() appends) -- not an idealized guess at the format.
#
# Run: python3 infra/hermes-self-repair/tests/test_bridge.py

import importlib.util
import sys
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


def load():
    spec = importlib.util.spec_from_file_location("bridge_test_target", TOOLS / "hermes-self-repair-bridge.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["bridge_test_target"] = mod
    spec.loader.exec_module(mod)
    return mod


FIRST_OCCURRENCE_HIGH = (
    "[crash] Bot Babs: TypeError in pathfinding goal handler\n"
    "  coder:  severity=high cause=null reference when the target block was already mined "
    "next=add a null check before dereferencing the target block\n"
    "  coder2: severity=high cause=race between goal cancellation and the block-break callback "
    "next=guard the callback with a cancellation flag\n"
    "  source line: TypeError: Cannot read properties of null (reading 'position')\n"
    "\n"
    "(occurrences for this bot+signature: 1, first 2026-11-08T10:00:00, last 2026-11-08T10:00:00)"
)

REPEAT_OCCURRENCE = FIRST_OCCURRENCE_HIGH.replace(
    "occurrences for this bot+signature: 1,", "occurrences for this bot+signature: 7,")

LOW_SEVERITY_FIRST = (
    "[stuck] Bot Amy: brief pathfinding stall\n"
    "  coder:  severity=low cause=momentary obstacle, bot re-routed itself "
    "next=none -- self-resolves\n"
    "\n"
    "(occurrences for this bot+signature: 1, first 2026-11-08T10:00:00, last 2026-11-08T10:00:00)"
)

DISAGREEMENT_BODY = (
    "[oom] Bot Mark: heap pressure warning\n"
    "  \U0001F534 HEAP SNAPSHOT CAPTURED (prioritized for later analysis -- do not delete without "
    "reviewing): /tmp/heap.heapsnapshot (812 MB)\n"
    "  coder:  severity=medium cause=large inventory cache never evicted "
    "next=add an eviction policy to the inventory cache\n"
    "  coder2: severity=high cause=a goal queue leak retains completed goals forever "
    "next=clear completed goals from the queue\n"
    "  ⚠ DISAGREEMENT: coder says medium, coder2 says high -- ambiguous incident, worth a closer look\n"
    "  source line: <--- Last few GCs --->\n"
    "\n"
    "(occurrences for this bot+signature: 1, first 2026-11-08T10:00:00, last 2026-11-08T10:00:00)"
)

UNPARSEABLE_BODY = "this is not a triage message at all"


def main():
    mod = load()

    print("\n[parse_triage_body: matches tools/hermes-minecraft-triage.py's real output shape]")
    parsed = mod.parse_triage_body(FIRST_OCCURRENCE_HIGH)
    check("category parsed", parsed["category"] == "crash", parsed)
    check("label parsed", parsed["label"] == "Bot Babs: TypeError in pathfinding goal handler", parsed)
    check("both roles parsed", set(parsed["roles"]) == {"coder", "coder2"}, parsed)
    check("coder's cause/next parsed without swallowing the next role line",
          parsed["roles"]["coder"]["cause"] == "null reference when the target block was already mined",
          parsed["roles"]["coder"])
    check("source line parsed", "TypeError: Cannot read" in parsed["source_line"], parsed)
    check("occurrence count parsed", parsed["occurrences"] == 1, parsed)
    check("no disagreement flagged when none is present", parsed["disagreement"] is False)

    disagreement = mod.parse_triage_body(DISAGREEMENT_BODY)
    check("a heapdump note line doesn't break role parsing",
          set(disagreement["roles"]) == {"coder", "coder2"}, disagreement)
    check("disagreement is flagged", disagreement["disagreement"] is True)
    check("severity ranks differ as expected (medium vs high)",
          disagreement["roles"]["coder"]["severity"] == "medium" and
          disagreement["roles"]["coder2"]["severity"] == "high", disagreement)

    check("unparseable body returns None, not a guess", mod.parse_triage_body(UNPARSEABLE_BODY) is None)
    check("an empty body returns None", mod.parse_triage_body("") is None)

    print("\n[should_submit: first-occurrence + severity gating]")
    ok, reason = mod.should_submit(parsed)
    check("first occurrence + high severity -> submit", ok is True, reason)

    repeat = mod.parse_triage_body(REPEAT_OCCURRENCE)
    ok, reason = mod.should_submit(repeat)
    check("a 7th occurrence of the same signature -> skipped (dedup)", ok is False, reason)
    check("skip reason names the repeat", "7 times" in reason, reason)

    low = mod.parse_triage_body(LOW_SEVERITY_FIRST)
    ok, reason = mod.should_submit(low)
    check("first occurrence but low severity -> skipped", ok is False, reason)

    ok, reason = mod.should_submit(None)
    check("an unparseable body -> skipped, not a crash", ok is False, reason)

    print("\n[build_fix_problem / build_test_problem: deterministic templating]")
    fix_problem = mod.build_fix_problem(parsed)
    check("fix problem names the category/label", "crash" in fix_problem and "TypeError in pathfinding" in fix_problem, fix_problem)
    check("fix problem carries both roles' own cause/next, not a model-authored summary of them",
          "null reference when the target block was already mined" in fix_problem and
          "race between goal cancellation" in fix_problem, fix_problem)

    disagreement_problem = mod.build_fix_problem(disagreement)
    check("disagreement is called out in the fix problem text",
          "disagreed" in disagreement_problem.lower(), disagreement_problem)

    test_problem = mod.build_test_problem(parsed, "services/minecraft-bots/goals.js")
    check("test problem names the exact fix path", "services/minecraft-bots/goals.js" in test_problem, test_problem)
    check("test problem points at the real unit test file", "unit.test.mjs" in test_problem, test_problem)

    print("\n[resolve_target_path: never trusts the model's answer directly]")
    candidates = ["services/minecraft-bots/goals.js", "services/minecraft-bots/actions.js"]
    check("an exact-match answer resolves",
          mod.resolve_target_path("services/minecraft-bots/goals.js", candidates) == "services/minecraft-bots/goals.js")
    check("a path NOT in the real listing is refused, not guessed through",
          mod.resolve_target_path("services/minecraft-bots/nonexistent.js", candidates) is None)
    check("a near-miss (extra whitespace) still resolves (stripped, not fuzzy-matched)",
          mod.resolve_target_path("  services/minecraft-bots/goals.js  ", candidates) == "services/minecraft-bots/goals.js")
    check("the model saying NONE resolves to None", mod.resolve_target_path("NONE", candidates) is None)
    check("an empty answer resolves to None", mod.resolve_target_path("", candidates) is None)

    print("\n[poll_once: dispatches by detection_source SCHEME, not a hardcoded 'buzz:' check]")
    # SOURCE_POLLERS is looked up by poll_once() as a dict (SOURCE_POLLERS.get(scheme)) built once
    # at module load with direct references to the real pollers -- reassigning
    # mod.poll_domain_buzz_source itself would NOT reach poll_once() at all, since the dict already
    # holds the original function object. Mutating the dict's own entries in place is what actually
    # intercepts the dispatch, the same reason mod.HANDLERS[...] is mutated in place elsewhere in
    # this file rather than reassigning mod.HANDLERS.
    real_source_pollers = dict(mod.SOURCE_POLLERS)  # restored below
    calls = []
    mod.domains_mod.load_domains = lambda: [
        {"name": "minecraft-bots", "detection_source": "buzz:minecraft-ops", "self_managed": False},
    ]
    mod.SOURCE_POLLERS["buzz"] = lambda domain, rest, state, budget: calls.append(("buzz", domain["name"], rest))
    mod.SOURCE_POLLERS["memory-turns"] = lambda domain, rest, state, budget: calls.append(("memory-turns", domain["name"], rest))
    mod.poll_once({})
    check("a switched-OFF domain is never polled", calls == [], calls)

    mod.domains_mod.load_domains = lambda: [
        {"name": "minecraft-bots", "detection_source": "buzz:minecraft-ops", "self_managed": True},
    ]
    mod.poll_once({})
    check("a switched-ON buzz-scheme domain IS dispatched to the buzz poller",
          calls == [("buzz", "minecraft-bots", "minecraft-ops")], calls)

    calls.clear()
    mod.domains_mod.load_domains = lambda: [
        {"name": "egress-guard", "detection_source": "memory-turns:egress-block", "self_managed": True},
    ]
    mod.poll_once({})
    check("a switched-ON memory-turns-scheme domain IS dispatched to the memory-turns poller — "
          "the real genericity test this phase exists for",
          calls == [("memory-turns", "egress-guard", "egress-block")], calls)

    calls.clear()
    mod.domains_mod.load_domains = lambda: [
        {"name": "other-domain", "detection_source": "something-unhandled", "self_managed": True},
    ]
    mod.poll_once({})
    check("a switched-ON domain with an unhandled detection_source is skipped, not guessed at",
          calls == [], calls)

    calls.clear()
    mod.HANDLERS["scheme-only:x"] = lambda *a, **k: None
    mod.domains_mod.load_domains = lambda: [
        {"name": "weird-domain", "detection_source": "scheme-only:x", "self_managed": True},
    ]
    mod.poll_once({})
    check("a handled detection_source whose scheme has no registered poller is skipped, not guessed at",
          calls == [], calls)
    del mod.HANDLERS["scheme-only:x"]

    mod.SOURCE_POLLERS.clear()
    mod.SOURCE_POLLERS.update(real_source_pollers)

    print("\n[seek_to_end_buzz: a fresh topic is seeded at its tip, never replayed from the start]")
    mod.save_state = lambda state: None  # no real disk I/O in this test

    pages = {0: [{"seq": i} for i in range(1, 201)], 200: [{"seq": i} for i in range(201, 251)]}
    mod._get = lambda url, token=None, timeout=15: {
        "messages": pages.get(int(url.split("since=")[1].split("&")[0]), [])
    }
    check("seek_to_end_buzz pages through a full first batch to find the real tip",
          mod.seek_to_end_buzz("minecraft-ops") == 250)

    mod._get = lambda url, token=None, timeout=15: {"messages": []}
    check("seek_to_end_buzz on a topic with no messages at all returns 0",
          mod.seek_to_end_buzz("minecraft-ops") == 0)

    domain = {"name": "minecraft-bots", "detection_source": "buzz:minecraft-ops", "self_managed": True}
    state = {}
    mod._get = lambda url, token=None, timeout=15: {"messages": [{"seq": i} for i in range(1, 51)]}
    mod.poll_domain_buzz_source(domain, "minecraft-ops", state, {"remaining": 3})
    check("a topic with no cursor yet is seeded (keyed 'buzz:<topic>'), not processed, on this "
          "first call", state.get("buzz:minecraft-ops") == 50, state)

    print("\n[poll_domain_buzz_source: budget exhaustion leaves the cursor short, not lost]")
    handled = []

    def fake_handler(message, domain, budget, state):
        if budget["remaining"] <= 0:
            raise mod.BudgetExhausted()
        budget["remaining"] -= 1
        handled.append(message["seq"])

    mod.HANDLERS["buzz:minecraft-ops"] = fake_handler
    state2 = {"buzz:minecraft-ops": 100}
    mod._get = lambda url, token=None, timeout=15: {
        "messages": [{"seq": s} for s in (101, 102, 103, 104, 105)]
    }
    mod.poll_domain_buzz_source(domain, "minecraft-ops", state2, {"remaining": 2})
    check("only as many messages as the budget allows are actually handled",
          handled == [101, 102], handled)
    check("the cursor stops short of the budget-exhausted message, not at the batch's end",
          state2["buzz:minecraft-ops"] == 102, state2)

    handled.clear()
    state2 = {"buzz:minecraft-ops": 102}
    mod._get = lambda url, token=None, timeout=15: {
        "messages": [{"seq": s} for s in (103, 104, 105)]
    }
    mod.poll_domain_buzz_source(domain, "minecraft-ops", state2, {"remaining": 3})
    check("the next poll cycle picks up exactly where the budget left off, retried not lost",
          handled == [103, 104, 105], handled)

    print("\n[egress-guard: no model call needed, caller already names the real path]")
    candidates_fs = {
        "tools/hermes-websearch.py", "services/some-service.js", "skills/foo/SKILL.md",
    }

    def fake_read_proc(cmd, **kwargs):
        class Proc:
            pass
        p = Proc()
        candidate = cmd[3] if len(cmd) > 3 else None
        p.returncode = 0 if candidate in candidates_fs else 1
        return p

    mod.subprocess.run = fake_read_proc
    check("a caller that resolves under tools/ is found there",
          mod.resolve_caller_path("hermes-websearch.py") == "tools/hermes-websearch.py")
    check("a caller with no match anywhere resolves to None, never guessed",
          mod.resolve_caller_path("totally-unknown-script.py") is None)
    check("a caller containing a path separator is refused outright (never trusted as a bare name)",
          mod.resolve_caller_path("../tools/hermes-websearch.py") is None)
    check("the egress guard's own module can never be named as the fix target",
          mod.resolve_caller_path("hermes_egress_guard.py") is None)
    check("an empty/missing caller resolves to None", mod.resolve_caller_path(None) is None
          and mod.resolve_caller_path("") is None)

    problem = mod.build_egress_problem({"caller": "hermes-websearch.py", "attempted": "evil.example.com",
                                         "reason": "not fleet-internal and not on the caller's whitelist"})
    check("the problem text names the real caller/destination",
          "hermes-websearch.py" in problem and "evil.example.com" in problem, problem)
    check("the problem text explicitly forbids weakening the egress guard itself",
          "NEVER weaken, bypass, or special-case" in problem, problem)

    print("\n[egress-guard cooldown: skip only while a caller's prior task is both recent AND active]")
    check("no record at all for this caller -> never a cooldown",
          mod.egress_cooldown_active("new-caller.py", {}, now=1000.0) is False)

    fresh_state = {"egress_cooldown": {"loopy.py": {"task_id": "t1", "submitted_at": 1000.0}}}
    mod.fetch_task_state_or_none = lambda task_id: "drafting"
    check("recent AND still-active prior task -> cooldown active",
          mod.egress_cooldown_active("loopy.py", fresh_state, now=1010.0) is True)

    mod.fetch_task_state_or_none = lambda task_id: "promotion-declined"
    check("recent BUT already-concluded prior task -> cooldown released immediately",
          mod.egress_cooldown_active("loopy.py", fresh_state, now=1010.0) is False)

    mod.fetch_task_state_or_none = lambda task_id: "drafting"
    old_state = {"egress_cooldown": {"loopy.py": {"task_id": "t1", "submitted_at": 1000.0}}}
    check("still-active prior task BUT the time window has elapsed -> cooldown released anyway",
          mod.egress_cooldown_active("loopy.py", old_state, now=1000.0 + mod.EGRESS_COOLDOWN_SECONDS + 1) is False)

    check("a task-state lookup failure (fetch_task_state_or_none's own UNKNOWN_TASK_STATE "
          "sentinel) is treated as active, the conservative direction -- only the time window "
          "can release a cooldown when the task's real state can't be read at all",
          mod.task_is_active(mod.UNKNOWN_TASK_STATE) is True)

    check("every review-round-N state counts as active",
          mod.task_is_active("review-round-3") is True)
    check("'blocked'/'dead'/'error' etc. are not in the active set", mod.task_is_active("dead") is False)

    print("\n[handle_egress_guard_denial: cooldown blocks a looping caller, budget/record wiring]")
    submitted = []
    mod.resolve_caller_path = lambda caller: f"tools/{caller}"
    mod.submit_task = lambda path, problem: submitted.append(path) or f"task-{len(submitted)}"
    mod.fetch_task_state_or_none = lambda task_id: "drafting"  # still in flight

    cooldown_state = {}
    finding1 = {"payload": {"caller": "loopy.py", "attempted": "evil.example.com", "reason": "x"}}
    mod.handle_egress_guard_denial(finding1, {"name": "egress-guard"}, {"remaining": 3}, cooldown_state)
    check("first denial from a caller submits normally", submitted == ["tools/loopy.py"], submitted)
    check("the submission is recorded for cooldown purposes",
          "loopy.py" in cooldown_state.get("egress_cooldown", {}), cooldown_state)

    mod.handle_egress_guard_denial(finding1, {"name": "egress-guard"}, {"remaining": 3}, cooldown_state)
    check("an immediate repeat denial from the SAME looping caller is skipped, not resubmitted",
          submitted == ["tools/loopy.py"], submitted)

    finding2 = {"payload": {"caller": "other.py", "attempted": "evil.example.com", "reason": "x"}}
    mod.handle_egress_guard_denial(finding2, {"name": "egress-guard"}, {"remaining": 3}, cooldown_state)
    check("a DIFFERENT caller's denial is never blocked by another caller's own cooldown",
          submitted == ["tools/loopy.py", "tools/other.py"], submitted)

    print("\n[seek_to_end_memory_turns / fetch_memory_turns: direct-sqlite cursor, same contract]")

    class FakeCursorConn:
        def __init__(self, rows, max_id):
            self._rows, self._max_id = rows, max_id

        def execute(self, sql, params=()):
            class Result:
                def __init__(self, data):
                    self._data = data

                def fetchall(self):
                    return self._data

                def fetchone(self):
                    return self._data[0] if self._data else None
            if sql.startswith("SELECT max(id)"):
                return Result([(self._max_id,)])
            after_id = params[1]
            return Result([(rid, raw) for rid, raw in self._rows if rid > after_id])

        def close(self):
            pass

    mod.ro_sqlite = lambda path: FakeCursorConn(
        [(101, '{"caller": "x.py"}'), (102, '{"caller": "y.py"}')], max_id=102)
    check("seek_to_end_memory_turns returns the real current max id",
          mod.seek_to_end_memory_turns("egress-block") == 102)
    found = mod.fetch_memory_turns("egress-block", 100, 50)
    check("fetch_memory_turns returns rows after the cursor, parsed from JSON",
          [f["id"] for f in found] == [101, 102] and found[0]["payload"]["caller"] == "x.py", found)

    mod.ro_sqlite = lambda path: FakeCursorConn([], max_id=None)
    check("seek_to_end_memory_turns on an empty table returns 0", mod.seek_to_end_memory_turns("egress-block") == 0)

    print("\n[poll_domain_memory_turns_source: first-run seeding, mirroring the buzz poller's own contract]")
    mod.save_state = lambda state: None
    mod.ro_sqlite = lambda path: FakeCursorConn([], max_id=250)
    egress_domain = {"name": "egress-guard", "detection_source": "memory-turns:egress-block", "self_managed": True}
    state3 = {}
    mod.poll_domain_memory_turns_source(egress_domain, "egress-block", state3, {"remaining": 3})
    check("a memory-turns source with no cursor yet is seeded (keyed 'memory-turns:<task_id>'), "
          "not processed, on this first call", state3.get("memory-turns:egress-block") == 250, state3)

    total = CHECKS[0]
    failed = len(FAILURES)
    print(f"\n{total - failed}/{total} checks passed")
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
