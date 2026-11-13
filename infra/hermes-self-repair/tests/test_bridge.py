#!/usr/bin/env python3
# Version: 2.4.0
#
# 2.4.0 (2026-11-13) — bridge 2.5.0: the fix is submitted alone with a test plan and the test task
# follows from the applied diff (sweep_pending_tests()); the emitting file is found by searching
# the source (literal_fragments()/best_emitter()/locate_emitter()) and an over-limit emitter is
# skipped; the triage `recent log` block and the emitting code reach the fix problem; one
# signature per bot crash and per "giving up on goal"; a crash near the same bot's OOM is
# grouped into it; "incomplete"/"verify-failed" are retryable. Every network and file write the
# bridge makes is stubbed here, and outcomes go to a temp file (the 2.5.0 handler test first ran
# unstubbed and reached the real hermes-memory, which refused it).
#
# 2.3.1 (2026-11-13) — a retry of a pre-2.4.0 record (no `attempts`) is recorded as attempt 2
# (bridge 2.4.1).
#
# 2.3.0 (2026-11-12) — a recorded signature whose task ended in `error` is retried after
# SIGNATURE_RETRY_SECONDS, up to SIGNATURE_MAX_ATTEMPTS, never after a human decision, and never
# for `unresolved` (bridge 2.4.0).
#
# 2.2.0 (2026-11-10) — the test task targets a per-area tests/unit/*.test.mjs file chosen from
# the test candidates only (bridge 2.3.0), never the 363k-char unit.test.mjs; an invalid
# test-file answer skips the incident without recording it.
#
# 2.1.0 (2026-11-10) — should_submit() now takes the bridge's state and gates on its own
# `submitted_signatures` record, not triage's occurrence count (bridge 2.2.0): a repeat that was
# never submitted is submitted, a recorded signature is skipped, one failure across bots is one
# signature, and the handler records what it submitted.
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
import os
import sys
import tempfile
from pathlib import Path

os.environ["SELFREPAIR_OUTCOMES"] = str(Path(tempfile.mkdtemp(prefix="bridge-test-")) / "outcomes.jsonl")
os.environ["MEMORY_URL"] = "http://127.0.0.1:9"  # nothing listens: an unstubbed call fails fast
os.environ["BUZZ_URL"] = "http://127.0.0.1:9"

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

    print("\n[should_submit: never-submitted signature + severity gating]")
    ok, reason = mod.should_submit(parsed, {})
    check("first occurrence + high severity -> submit", ok is True, reason)

    repeat = mod.parse_triage_body(REPEAT_OCCURRENCE)
    ok, reason = mod.should_submit(repeat, {})
    check("a 7th occurrence that was never submitted -> submitted (triage counted it before the "
          "bridge existed)", ok is True, reason)

    real_save_state = mod.save_state
    real_fetch = mod.fetch_task_state_or_none
    mod.save_state = lambda state: None
    mod.fetch_task_state_or_none = lambda task_id: "drafting"
    seen_state = {}
    mod.record_signature_submission(seen_state, repeat, "fix-1", "test-1", now=1000.0)
    ok, reason = mod.should_submit(repeat, seen_state)
    check("once submitted, the same signature is skipped", ok is False, reason)
    check("skip reason names the task already submitted", "fix-1" in reason, reason)
    other_bot = mod.parse_triage_body(FIRST_OCCURRENCE_HIGH.replace(
        "source line: TypeError", "source line: [Mark] TypeError"))
    seen_state = {}
    mod.record_signature_submission(seen_state, mod.parse_triage_body(FIRST_OCCURRENCE_HIGH.replace(
        "source line: TypeError", "source line: [Amy] TypeError")), "fix-2", "test-2", now=1000.0)
    ok, reason = mod.should_submit(other_bot, seen_state)
    check("the same failure on another bot is the same signature, not a second task", ok is False, reason)

    print("\n[should_submit: a signature whose task died on an error is retried, within limits]")
    seen_state = {}
    mod.record_signature_submission(seen_state, repeat, "fix-1", "test-1", now=1000.0)
    states = {"fix-1": "error", "test-1": "error"}
    mod.fetch_task_state_or_none = lambda task_id: states.get(task_id, "drafting")
    later = 1000.0 + mod.SIGNATURE_RETRY_SECONDS
    ok, reason = mod.should_submit(repeat, seen_state, now=1000.0 + 60)
    check("an errored task is not retried inside the retry interval", ok is False, reason)
    ok, reason = mod.should_submit(repeat, seen_state, now=later)
    check("an errored task is retried once the interval has passed (the 26b36ed9 case)", ok is True, reason)
    check("the retry reason names the task and the attempt", "fix-1" in reason and "attempt 2" in reason, reason)
    states = {"fix-1": "awaiting-completeness", "test-1": "error"}
    ok, reason = mod.should_submit(repeat, seen_state, now=later)
    check("a test task that errored retries the pair (the fix can never leave awaiting-completeness)",
          ok is True, reason)
    for decided in ("verified", "promotion-declined", "promoted"):
        states = {"fix-1": decided, "test-1": "error"}
        ok, reason = mod.should_submit(repeat, seen_state, now=later)
        check(f"no retry once a human decision exists ({decided})", ok is False, reason)
    for concluded in ("unresolved", "blocked", "drafting", mod.UNKNOWN_TASK_STATE):
        states = {"fix-1": concluded, "test-1": concluded}
        ok, reason = mod.should_submit(repeat, seen_state, now=later)
        check(f"no retry when nothing errored ({concluded})", ok is False, reason)
    states = {}
    mod.fetch_task_state_or_none = lambda task_id: "error"
    mod.record_signature_submission(seen_state, repeat, "fix-1b", "test-1b", now=later)
    mod.record_signature_submission(seen_state, repeat, "fix-1c", "test-1c", now=later)
    record = seen_state["submitted_signatures"][mod.finding_signature(repeat)]
    check("each submission counts an attempt", record.get("attempts") == 3, record)
    ok, reason = mod.should_submit(repeat, seen_state, now=later + 10 * mod.SIGNATURE_RETRY_SECONDS)
    check("no retry past SIGNATURE_MAX_ATTEMPTS", ok is False, reason)
    calls = []
    mod.fetch_task_state_or_none = lambda task_id: calls.append(task_id) or "error"
    mod.should_submit(repeat, {"submitted_signatures": {mod.finding_signature(repeat): {
        "fix": "f", "test": "t", "submitted_at": later, "attempts": 1}}}, now=later + 1)
    check("inside the interval, no task-state lookup is made at all", calls == [], calls)
    legacy = {"submitted_signatures": {mod.finding_signature(repeat): {
        "fix": "old-fix", "test": "old-test", "submitted_at": 1000.0}}}
    mod.record_signature_submission(legacy, repeat, "new-fix", "new-test", now=later)
    check("a retry of a record from before attempts were counted is attempt 2, not 1",
          legacy["submitted_signatures"][mod.finding_signature(repeat)]["attempts"] == 2,
          legacy["submitted_signatures"])
    mod.fetch_task_state_or_none = real_fetch
    mod.save_state = real_save_state

    stuck = {"category": "stuck-path", "source_line": "[Bob] path_reset: stuck at 12.5 64 -3"}
    check("signature drops the bot tag and collapses numbers",
          mod.finding_signature(stuck) == "stuck-path|path_reset: stuck at N N -N", mod.finding_signature(stuck))

    low = mod.parse_triage_body(LOW_SEVERITY_FIRST)
    ok, reason = mod.should_submit(low, {})
    check("first occurrence but low severity -> skipped", ok is False, reason)

    ok, reason = mod.should_submit(None, {})
    check("an unparseable body -> skipped, not a crash", ok is False, reason)

    print("\n[handle_minecraft_bots_buzz: the fix goes alone, with a test plan]")
    stubbed = ("list_candidate_paths", "ask_model_for_path", "submit_task", "write_link_turn", "save_state",
               "write_test_plan_turn", "locate_emitter", "fetch_task_state_or_none", "fetch_fix_diff", "now_fn")
    real = {k: getattr(mod, k) for k in stubbed}
    sent, plans, links = [], [], []
    unit_dir = "services/minecraft-bots/tests/unit/"
    mod.list_candidate_paths = lambda: ["services/minecraft-bots/swim-movements.js",
                                        "services/minecraft-bots/goals.js",
                                        "services/minecraft-bots/tests/unit.test.mjs",
                                        unit_dir + "_harness.mjs", unit_dir + "pathfinding.test.mjs",
                                        unit_dir + "chests-1.test.mjs"]
    offered = []

    def fake_ask(parsed, candidates, fix_path=None):
        offered.append(list(candidates))
        return "services/minecraft-bots/swim-movements.js" if fix_path is None else unit_dir + "pathfinding.test.mjs"
    mod.ask_model_for_path = fake_ask
    ids = [0]

    def fake_submit(path, problem):
        sent.append((path, problem))
        ids[0] += 1
        return f"task-{ids[0]}"
    mod.submit_task = fake_submit
    mod.write_link_turn = lambda task_id, role, other: links.append((task_id, role, other))
    mod.write_test_plan_turn = lambda task_id, test_path: plans.append((task_id, test_path))
    mod.save_state = lambda state: None
    mod.locate_emitter = lambda parsed, root="services/minecraft-bots": None
    clock = [10_000.0]
    mod.now_fn = lambda: clock[0]
    handler_state = {}
    mc_domain = {"name": "minecraft-bots"}
    mod.handle_minecraft_bots_buzz({"body": REPEAT_OCCURRENCE}, mc_domain, {"remaining": 3}, handler_state)
    check("a never-submitted finding submits the fix alone",
          [p for p, _ in sent] == ["services/minecraft-bots/swim-movements.js"], sent)
    check("with a test plan naming the per-area test file", plans == [("task-1", unit_dir + "pathfinding.test.mjs")], plans)
    check("the test file is chosen from the per-area unit files only -- never the whole "
          "unit.test.mjs or the shared harness",
          offered[1] == [unit_dir + "pathfinding.test.mjs", unit_dir + "chests-1.test.mjs"], offered)
    rec = next(iter(handler_state["submitted_signatures"].values()))
    check("the record holds no test task yet, and the plan", rec["test"] is None and
          rec["test_path"] == unit_dir + "pathfinding.test.mjs" and rec["fix_path"].endswith("swim-movements.js"), rec)
    mod.handle_minecraft_bots_buzz({"body": REPEAT_OCCURRENCE}, mc_domain, {"remaining": 3}, handler_state)
    check("the next repeat of it submits nothing more", len(sent) == 1, sent)
    sent.clear()
    mod.ask_model_for_path = lambda parsed, candidates, fix_path=None: (
        "services/minecraft-bots/swim-movements.js" if fix_path is None else "services/minecraft-bots/tests/unit.test.mjs")
    skip_state = {}
    mod.handle_minecraft_bots_buzz({"body": REPEAT_OCCURRENCE}, mc_domain, {"remaining": 3}, skip_state)
    check("a test-file answer outside the per-area files submits nothing and records nothing",
          sent == [] and not skip_state.get("submitted_signatures"), (sent, skip_state))
    mod.ask_model_for_path = fake_ask

    print("\n[sweep_pending_tests: the test task follows the verified fix, from its diff]")
    fix_states = {"task-1": "awaiting-completeness"}
    mod.fetch_task_state_or_none = lambda task_id: fix_states.get(task_id, "drafting")
    mod.fetch_fix_diff = lambda task_id: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new_behavior()\n"
    sent.clear()
    n = mod.sweep_pending_tests(handler_state, {"remaining": 3})
    check("a fix waiting on its test gets one", n == 1 and sent and sent[0][0] == unit_dir + "pathfinding.test.mjs", sent)
    check("the test problem carries the applied diff and the both-ways rule",
          "new_behavior()" in sent[0][1] and "FAIL with" in sent[0][1], sent[0][1][:300])
    check("the two are linked both ways", ("task-1", "fix", "task-2") in links and ("task-2", "test", "task-1") in links, links)
    check("and the record now names the test", rec["test"] == "task-2", rec)
    n = mod.sweep_pending_tests(handler_state, {"remaining": 3})
    check("a second sweep submits nothing more", n == 0, sent)
    other = {"submitted_signatures": {"s": {"fix": "f9", "test": None, "test_path": unit_dir + "x.test.mjs"}}}
    fix_states["f9"] = "drafting"
    check("a fix still generating gets no test yet", mod.sweep_pending_tests(other, {"remaining": 3}) == 0)
    fix_states["f9"] = "awaiting-completeness"
    check("nor once the budget is spent", mod.sweep_pending_tests(other, {"remaining": 0}) == 0)

    print("\n[locate_emitter: the fix target is where the log line comes from]")
    frags = mod.literal_fragments("[Dale] giving up on goal after 20 failures: get basic tools for herding")
    check("fragments split at numbers and ': ', longest first",
          "giving up on goal after" in frags and "get basic tools for herding" in frags, frags)
    check("short fragments are dropped", all(len(f) >= 12 for f in frags), frags)
    check("the file matching the most fragments wins",
          mod.best_emitter({"a": [("services/minecraft-bots/index.js", 40), ("services/minecraft-bots/goals.js", 3)],
                            "b": [("services/minecraft-bots/index.js", 41)]}) == ("services/minecraft-bots/index.js", 40))
    check("a tie is no answer, not a guess",
          mod.best_emitter({"a": [("services/minecraft-bots/a.js", 1)], "b": [("services/minecraft-bots/b.js", 1)]}) is None)
    check("a test file never counts as the emitter",
          mod.best_emitter({"a": [("services/minecraft-bots/tests/unit/x.test.mjs", 1)]}) is None)
    real_read_tool = mod.read_tool
    src = "\n".join(f"line {i}" for i in range(1, 60)) + "\nlog(`giving up on goal after ${n} failures: ${d}`);\n"
    def fake_read_tool(op, *args):
        if op == "grep":
            return (0, "services/minecraft-bots/goal-runner.js:60:log(`giving up on goal after ${n}...`)\n"
                    if "giving" in args[0] else "")
        return 0, src
    mod.read_tool = fake_read_tool
    mod.locate_emitter = real["locate_emitter"]
    mod._EMITTER_CACHE.clear()
    em = mod.locate_emitter({"category": "goal-abandoned", "source_line": "[Dale] giving up on goal after 20 failures: herd"})
    check("locate_emitter names the emitting file and line", em and em["path"] == "services/minecraft-bots/goal-runner.js"
          and em["line"] == 60, em)
    check("with the code around it", em and "giving up on goal" in em["snippet"] and "40: line 40" in em["snippet"], em)
    check("and the file's size", em and em["size"] == len(src), em)
    mod.read_tool = real_read_tool

    sent.clear()
    asked = []
    mod.ask_model_for_path = lambda parsed, candidates, fix_path=None: (asked.append(fix_path) or
        (unit_dir + "pathfinding.test.mjs" if fix_path else "services/minecraft-bots/swim-movements.js"))
    mod.locate_emitter = lambda parsed, root="services/minecraft-bots": {
        "path": "services/minecraft-bots/goals.js", "line": 12, "size": 900, "snippet": "12: emit()"}
    mod.handle_minecraft_bots_buzz({"body": REPEAT_OCCURRENCE}, mc_domain, {"remaining": 3}, {})
    check("an emitter found is the fix target; the model is not asked for the fix file",
          sent and sent[0][0] == "services/minecraft-bots/goals.js" and None not in asked, (sent, asked))
    check("the fix problem carries the emitting code", sent and "goals.js:12" in sent[0][1] and "12: emit()" in sent[0][1],
          sent[0][1][-200:] if sent else sent)
    sent.clear()
    mod.locate_emitter = lambda parsed, root="services/minecraft-bots": {
        "path": "services/minecraft-bots/index.js", "line": 9000, "size": 436470, "snippet": ""}
    big_state = {}
    mod.handle_minecraft_bots_buzz({"body": REPEAT_OCCURRENCE}, mc_domain, {"remaining": 3}, big_state)
    check("an emitter over MAX_FILE_CHARS is skipped, not swapped for a smaller file",
          sent == [] and not big_state.get("submitted_signatures"), (sent, big_state))
    mod.locate_emitter = lambda parsed, root="services/minecraft-bots": None

    print("\n[signatures: one failure, one signature]")
    exit_a = {"category": "process-exit", "source_line": "minecraft-bot-dale.service: Main process exited, code=dumped, status=6/ABRT"}
    exit_b = {"category": "process-exit", "source_line": "minecraft-bot-nell.service: Failed with result 'core-dump'."}
    check("both systemd crash lines, on any bot, are one signature",
          mod.finding_signature(exit_a) == mod.finding_signature(exit_b), (mod.finding_signature(exit_a), mod.finding_signature(exit_b)))
    goal_a = {"category": "goal-abandoned", "source_line": "[Dale] giving up on goal after 20 failures: get basic tools"}
    goal_b = {"category": "goal-abandoned", "source_line": "[Amy] giving up on goal after 3 failures: armor"}
    check("'giving up on goal' is one signature whatever the goal",
          mod.finding_signature(goal_a) == mod.finding_signature(goal_b), mod.finding_signature(goal_a))
    check("the bot is read from its tag or its unit",
          mod.finding_bot(goal_a) == "dale" and mod.finding_bot(exit_b) == "nell")

    print("\n[a crash right after the same bot's OOM is that OOM]")
    def triage(category, line):
        return (f"[{category}] something\n  coder:  severity=high cause=c next=n\n"
                f"  coder2: severity=high cause=c next=n\n  source line: {line}")
    oom_body = triage("oom", "[Dale] FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory")
    exit_body = triage("process-exit", "minecraft-bot-dale.service: Main process exited, code=dumped, status=6/ABRT")
    sent.clear()
    st = {}
    clock[0] = 20_000.0
    mod.handle_minecraft_bots_buzz({"body": oom_body}, mc_domain, {"remaining": 3}, st)
    clock[0] += 5
    mod.handle_minecraft_bots_buzz({"body": exit_body}, mc_domain, {"remaining": 3}, st)
    check("the OOM is submitted, the crash 5s later is not", len(sent) == 1, [p for p, _ in sent])
    sent.clear()
    st = {}
    clock[0] = 30_000.0
    mod.handle_minecraft_bots_buzz({"body": exit_body}, mc_domain, {"remaining": 3}, st)
    check("a crash with no OOM yet is held, not submitted", sent == [] and len(st.get("deferred", [])) == 1, st)
    clock[0] += 30
    mod.handle_minecraft_bots_buzz({"body": oom_body}, mc_domain, {"remaining": 3}, st)
    clock[0] += mod.PROCESS_EXIT_DEFER_SECONDS
    mod.process_deferred(st, {"remaining": 3})
    check("when its OOM arrives while it is held, the crash is dropped",
          len(sent) == 1 and not st.get("deferred"), ([p for p, _ in sent], st.get("deferred")))
    sent.clear()
    st = {}
    clock[0] = 40_000.0
    mod.handle_minecraft_bots_buzz({"body": exit_body}, mc_domain, {"remaining": 3}, st)
    clock[0] += mod.PROCESS_EXIT_DEFER_SECONDS
    mod.process_deferred(st, {"remaining": 3})
    check("a crash with no OOM is submitted once the hold is over", len(sent) == 1 and not st.get("deferred"),
          ([p for p, _ in sent], st.get("deferred")))

    print("\n[context: the bot's recent log lines reach the fix problem]")
    with_context = (REPEAT_OCCURRENCE.split("\n\n")[0] +
                    "\n  recent log (3 lines before):\n    [Babs] goal: mine iron\n    [Babs] path_update noPath\n    [Babs] tick\n")
    parsed_ctx = mod.parse_triage_body(with_context)
    check("the recent log block is parsed", parsed_ctx["context"] == ["[Babs] goal: mine iron", "[Babs] path_update noPath", "[Babs] tick"],
          parsed_ctx["context"])
    check("and goes into the fix problem", "[Babs] path_update noPath" in mod.build_fix_problem(parsed_ctx))
    check("a body without one parses as before", mod.parse_triage_body(REPEAT_OCCURRENCE)["context"] == [])

    print("\n[retry: incomplete and verify-failed are retryable now]")
    for failed in ("incomplete", "verify-failed"):
        mod.fetch_task_state_or_none = lambda task_id, f=failed: f
        rec_state = {"submitted_signatures": {mod.finding_signature(repeat): {
            "fix": "fx", "test": None, "submitted_at": 0.0, "attempts": 1}}}
        ok, reason = mod.should_submit(repeat, rec_state, now=mod.SIGNATURE_RETRY_SECONDS + 1)
        check(f"a fix that ended {failed} is retried", ok is True and failed in reason, reason)
    for k, v in real.items():
        setattr(mod, k, v)

    print("\n[build_fix_problem / build_test_problem: deterministic templating]")
    fix_problem = mod.build_fix_problem(parsed)
    check("fix problem names the category/label", "crash" in fix_problem and "TypeError in pathfinding" in fix_problem, fix_problem)
    check("fix problem carries both roles' own cause/next, not a model-authored summary of them",
          "null reference when the target block was already mined" in fix_problem and
          "race between goal cancellation" in fix_problem, fix_problem)

    disagreement_problem = mod.build_fix_problem(disagreement)
    check("disagreement is called out in the fix problem text",
          "disagreed" in disagreement_problem.lower(), disagreement_problem)

    test_problem = mod.build_test_problem(parsed, "services/minecraft-bots/goals.js",
                                          "services/minecraft-bots/tests/unit/control.test.mjs")
    check("test problem names the exact fix path", "services/minecraft-bots/goals.js" in test_problem, test_problem)
    check("test problem points at the chosen per-area test file",
          "tests/unit/control.test.mjs" in test_problem and "_harness.mjs" in test_problem, test_problem)

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
