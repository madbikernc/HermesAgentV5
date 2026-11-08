#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for tools/hermes-self-repair-minecraft-bridge.py's PURE logic (parsing,
# severity/dedup gating, problem-text templating, path validation) -- the parts the module's own
# header says are offline-testable. Network-touching glue (Buzz polling, the path-resolution model
# call, task submission) is deliberately NOT exercised here; it was proven-shape-compatible by
# reusing hermes-self-repair-submit.py's own {"path","problem"}/pointer-envelope conventions
# instead, the same way every other self-repair component already does.
#
# Fixture bodies below are built to match tools/hermes-minecraft-triage.py's own
# triage_incident()/diagnosis_worker() output EXACTLY (including the blank line + occurrences
# suffix diagnosis_worker() appends) -- not an idealized guess at the format.
#
# Run: python3 infra/hermes-self-repair/tests/test_minecraft_bridge.py

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
    spec = importlib.util.spec_from_file_location("bridge_test_target", TOOLS / "hermes-self-repair-minecraft-bridge.py")
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

    print("\n[poll_once: only dispatches to a registered, switched-on domain]")
    real_poll_domain_buzz_topic = mod.poll_domain_buzz_topic  # restored below -- the next few
    # checks replace it with a dispatch-only spy, and leaving that in place would silently break
    # every later check that calls the real poll_domain_buzz_topic directly.
    calls = []
    mod.domains_mod.load_domains = lambda: [
        {"name": "minecraft-bots", "detection_source": "buzz:minecraft-ops", "self_managed": False},
    ]
    mod.poll_domain_buzz_topic = lambda domain, topic, state, budget: calls.append((domain["name"], topic))
    mod.poll_once({})
    check("a switched-OFF domain is never polled", calls == [], calls)

    mod.domains_mod.load_domains = lambda: [
        {"name": "minecraft-bots", "detection_source": "buzz:minecraft-ops", "self_managed": True},
    ]
    mod.poll_once({})
    check("a switched-ON domain with a known detection_source IS polled",
          calls == [("minecraft-bots", "minecraft-ops")], calls)

    calls.clear()
    mod.domains_mod.load_domains = lambda: [
        {"name": "other-domain", "detection_source": "something-unhandled", "self_managed": True},
    ]
    mod.poll_once({})
    check("a switched-ON domain with an unhandled detection_source is skipped, not guessed at",
          calls == [], calls)
    mod.poll_domain_buzz_topic = real_poll_domain_buzz_topic

    print("\n[seek_to_end: a fresh topic is seeded at its tip, never replayed from the start]")
    mod.save_state = lambda state: None  # no real disk I/O in this test

    pages = {0: [{"seq": i} for i in range(1, 201)], 200: [{"seq": i} for i in range(201, 251)]}
    mod._get = lambda url, token=None, timeout=15: {
        "messages": pages.get(int(url.split("since=")[1].split("&")[0]), [])
    }
    check("seek_to_end pages through a full first batch to find the real tip",
          mod.seek_to_end("minecraft-ops") == 250)

    mod._get = lambda url, token=None, timeout=15: {"messages": []}
    check("seek_to_end on a topic with no messages at all returns 0",
          mod.seek_to_end("minecraft-ops") == 0)

    domain = {"name": "minecraft-bots", "detection_source": "buzz:minecraft-ops", "self_managed": True}
    state = {}
    mod._get = lambda url, token=None, timeout=15: {"messages": [{"seq": i} for i in range(1, 51)]}
    mod.poll_domain_buzz_topic(domain, "minecraft-ops", state, {"remaining": 3})
    check("a topic with no cursor yet is seeded, not processed, on this first call",
          state.get("minecraft-ops") == 50, state)

    print("\n[poll_domain_buzz_topic: budget exhaustion leaves the cursor short, not lost]")
    handled = []

    def fake_handler(message, domain, budget):
        if budget["remaining"] <= 0:
            raise mod.BudgetExhausted()
        budget["remaining"] -= 1
        handled.append(message["seq"])

    mod.HANDLERS["buzz:minecraft-ops"] = fake_handler
    state2 = {"minecraft-ops": 100}
    mod._get = lambda url, token=None, timeout=15: {
        "messages": [{"seq": s} for s in (101, 102, 103, 104, 105)]
    }
    mod.poll_domain_buzz_topic(domain, "minecraft-ops", state2, {"remaining": 2})
    check("only as many messages as the budget allows are actually handled",
          handled == [101, 102], handled)
    check("the cursor stops short of the budget-exhausted message, not at the batch's end",
          state2["minecraft-ops"] == 102, state2)

    handled.clear()
    state2 = {"minecraft-ops": 102}
    mod._get = lambda url, token=None, timeout=15: {
        "messages": [{"seq": s} for s in (103, 104, 105)]
    }
    mod.poll_domain_buzz_topic(domain, "minecraft-ops", state2, {"remaining": 3})
    check("the next poll cycle picks up exactly where the budget left off, retried not lost",
          handled == [103, 104, 105], handled)

    total = CHECKS[0]
    failed = len(FAILURES)
    print(f"\n{total - failed}/{total} checks passed")
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
