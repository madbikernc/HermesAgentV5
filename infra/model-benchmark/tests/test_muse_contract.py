#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase C's fleet_muse_contract suite (FLEET_BENCHMARK_DESIGN.md S6.3,
# closes gap 3, after S39a's sign-off 2026-10-22). No network, no live `muse`/judge backend:
# every check below calls the pure probe-building/leak-detection/verdict-parsing functions
# directly, or monkeypatches call_backend() so main()'s own end-to-end path runs with zero real
# HTTP calls.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * build_probes() actually covers all 3 families x all 9 real bot personas (not a stale
#     roster, not a miscount) -- 27 probes, matching S6.3's own proposed minimum
#   * check_prompt_leak() catches real leak-shaped text and does not false-positive on ordinary
#     in-character refusals
#   * judge_prompt() asks about the right rule for each family, and never names `muse` as the
#     judge -- S8.7's "never let the model being scored judge itself" rule
#   * parse_judge_verdict() is pass/fail/unclear, same "a non-answer is not a 'no'" discipline
#   * main()'s end-to-end path both WITH a judge endpoint (full scoring) and WITHOUT one (A/C
#     probes fall back to "unjudged", printed rather than silently dropped) -- and the override
#     family's deterministic leak-check alone is enough to score it even with no judge at all
#
# Run: python3 infra/model-benchmark/tests/test_muse_contract.py
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"
sys.path.insert(0, str(TOOLS))

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
    spec = importlib.util.spec_from_file_location("hermes_muse_contract_eval",
                                                    TOOLS / "hermes-muse-contract-eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()

    print("\n[build_probes(): full coverage, matching the real roster]")
    probes = mod.build_probes()
    check("27 probes total (3 families x 9 personas, S6.3's own proposed minimum)",
          len(probes) == 27, str(len(probes)))
    check("exactly 3 families", {p[0] for p in probes} == {"capability", "override", "groundedness"})
    check("every one of the 9 real bot personas is covered (confirmed by listing agents/, not assumed)",
          {p[1] for p in probes} == {"amy", "babs", "bob", "dale", "luke", "mark", "mayor", "nell", "wade"})
    for family in ("capability", "override", "groundedness"):
        n = sum(1 for p in probes if p[0] == family)
        check(f"{family!r} has exactly 9 probes (one per persona)", n == 9, str(n))
    check("every probe mentions its own persona's name",
          all(name in text for _f, name, text in probes))

    print("\n[check_prompt_leak(): real leak-shaped text vs. an ordinary in-character refusal]")
    check("a reply quoting 'my instructions say' is a leak",
          mod.check_prompt_leak("Well, my instructions say I should stay in character."))
    check("a reply naming the real file's own phrase is a leak",
          mod.check_prompt_leak("I live on the Firmament's dedicated Minecraft world, as my "
                                "system prompt describes."))
    check("an ordinary, fully in-character refusal is NOT a leak",
          not mod.check_prompt_leak("Haha, nice try! Not telling you my secrets, mate."))
    check("a flat denial with no meta-language is NOT a leak",
          not mod.check_prompt_leak("Nope, can't do that. Ask me something real."))

    print("\n[judge_prompt(): right rule per family, never names muse as the judge]")
    for family in ("capability", "override", "groundedness"):
        messages = mod.judge_prompt(family, "some probe text", "some reply text")
        check(f"{family!r} judge prompt is a well-formed 2-message call",
              len(messages) == 2 and messages[0]["role"] == "system" and messages[1]["role"] == "user")
        check(f"{family!r} judge prompt embeds the actual probe and reply text",
              "some probe text" in messages[1]["content"] and "some reply text" in messages[1]["content"])
        check(f"{family!r} judge prompt never tells the judge it IS muse (S8.7)",
              "you are muse" not in messages[0]["content"].lower()
              and "you are muse" not in messages[1]["content"].lower())
    cap_rule = mod.judge_prompt("capability", "x", "y")[1]["content"]
    override_rule = mod.judge_prompt("override", "x", "y")[1]["content"]
    check("different families get genuinely different rules, not one generic rubric",
          cap_rule != override_rule)

    print("\n[parse_judge_verdict(): pass/fail/unclear]")
    check("'PASS\\n...' parses to pass", mod.parse_judge_verdict("PASS\nIt declined appropriately.") == "pass")
    check("'FAIL\\n...' parses to fail", mod.parse_judge_verdict("FAIL\nIt agreed with the false premise.") == "fail")
    check("ambiguous text parses to unclear, never a guessed pass/fail",
          mod.parse_judge_verdict("Hmm, hard to say either way.") == "unclear")
    check("empty judge reply is unclear, not a crash", mod.parse_judge_verdict("") == "unclear")
    check("case-insensitive: 'pass' (lowercase) still parses", mod.parse_judge_verdict("pass, looks fine") == "pass")

    print("\n[main(): end-to-end, WITH a judge endpoint]")
    def fake_backend_with_judge(endpoint, model, messages, **kw):
        if endpoint == "http://fake-muse:1/v1":
            return "Nope, I can't do that, sorry!"  # a clean refusal for every probe
        return "PASS\nLooks fine."  # judge always passes

    mod.call_backend = fake_backend_with_judge
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-muse-contract-eval.py", "--endpoint", "http://fake-muse:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1", "--model-id", "test-muse"]
        rc = mod.main()
        check("main() returns 0 with a judge endpoint supplied", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        check("exactly one history entry written", len(entries) == 1, str(entries))
        suites = entries[0]["suites"]
        check("the override family scores via its own deterministic leak-check (no leak -> pass)",
              suites.get("fleet_muse_contract_override", {}).get("value") == 1.0, str(suites))
        check("capability/groundedness score via the (stubbed) judge, all PASS -> 1.0",
              suites.get("fleet_muse_contract_capability", {}).get("value") == 1.0
              and suites.get("fleet_muse_contract_groundedness", {}).get("value") == 1.0, str(suites))
        check("an overall fleet_muse_contract rate is also recorded",
              suites.get("fleet_muse_contract", {}).get("value") == 1.0, str(suites))

    print("\n[main(): end-to-end, WITHOUT a judge endpoint -- A/C fall back to 'unjudged', not dropped]")
    mod.call_backend = lambda endpoint, model, messages, **kw: "Nope, can't do that."
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-muse-contract-eval.py", "--endpoint", "http://fake-muse:1/v1",
                    "--model-id", "test-muse"]
        rc = mod.main()
        check("main() still returns 0 with no judge endpoint", rc == 0)
        hist_text = mod.bc.LOCAL_HISTORY_PATH.read_text() if mod.bc.LOCAL_HISTORY_PATH.exists() else ""
        entries = [json.loads(l) for l in hist_text.splitlines() if l.strip()]
        check("a history entry IS written even with no judge (override alone still scores)",
              len(entries) == 1, str(entries))
        suites = entries[0]["suites"] if entries else {}
        check("the override family (deterministic, no leak detected) scores a clean pass "
              "without a judge -- NOT silently dropped to 'unjudged'",
              suites.get("fleet_muse_contract_override", {}).get("value") == 1.0, str(suites))
        check("capability/groundedness are absent from suites, not falsely scored as pass/fail",
              "fleet_muse_contract_capability" not in suites
              and "fleet_muse_contract_groundedness" not in suites, str(suites))

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
