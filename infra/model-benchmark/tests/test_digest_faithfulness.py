#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase C's fleet_digest_faithfulness suite (FLEET_BENCHMARK_DESIGN.md
# S6.4, closes gap 4, after S39a's sign-off 2026-10-22). No network, no live RAG store, no live
# coder/judge backend: every check below either calls the pure deterministic
# helpers (`is_grounded()`/`parse_judge_verdict()`) directly, or monkeypatches
# `digest.rag.router_chat` (confirming the REAL, unmodified `summarize_highlights()` runs) and
# `call_backend()` so main()'s own end-to-end path runs with zero real HTTP calls.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * load_digest_module() loads the real hermes-news-digest.py safely, with the real
#     summarize_highlights() callable and the real MAX_HIGHLIGHTS constant intact
#   * build_cases() covers all 5 scenarios with sane expected-highlight-count bounds
#   * is_grounded() catches zero-overlap (a floor signal) without false-positiving on an
#     ordinary paraphrase that shares real vocabulary with its source
#   * parse_judge_verdict() is pass/fail/unclear, same "a non-answer is not a 'no'" discipline
#   * monkeypatching digest.rag.router_chat actually reaches the REAL summarize_highlights() body
#     (passage numbering, the <DATA> wrapper, the "nothing new" short-circuit, the HIGHLIGHT_RE
#     citation parse) -- not a reimplementation of it
#   * main()'s end-to-end path: a well-behaved model scores clean on all three axes; a model that
#     pads the "nothing new" case and a judge that fails a fabricated claim both get caught; a
#     failed call for one case doesn't block scoring the rest
#
# Run: python3 infra/model-benchmark/tests/test_digest_faithfulness.py
import importlib.util
import json
import sys
import tempfile
import urllib.error
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
    spec = importlib.util.spec_from_file_location("hermes_digest_faithfulness_eval",
                                                    TOOLS / "hermes-digest-faithfulness-eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()

    print("\n[load_digest_module(): the real module, real function, real constant]")
    digest = mod.load_digest_module()
    check("MAX_HIGHLIGHTS loaded from the real module", digest.MAX_HIGHLIGHTS == 50,
          str(digest.MAX_HIGHLIGHTS))
    check("summarize_highlights is the real callable", callable(digest.summarize_highlights))

    print("\n[build_cases(): all 5 scenarios, sane expected bounds]")
    cases = mod.build_cases()
    check("5 cases total", len(cases) == 5, str(len(cases)))
    check("exactly one case expects zero highlights (nothing_new)",
          sum(1 for _c, _t, _m, e in cases if e["expect_max_highlights"] == 0) == 1)
    for case_id, topic, matches, expect in cases:
        check(f"[{case_id}] every match has text+citation",
              all("text" in m and "citation" in m for m in matches))

    print("\n[is_grounded(): zero-overlap floor signal]")
    check("a faithful paraphrase sharing real vocabulary is grounded",
          mod.is_grounded("Acme patches a VPN gateway flaw",
                           "Acme Networks shipped a patch for a VPN gateway firmware flaw."))
    check("a wholly unrelated highlight is NOT grounded",
          not mod.is_grounded("The weather in Tokyo was sunny today",
                               "Acme Networks shipped a patch for a VPN gateway firmware flaw."))

    print("\n[parse_judge_verdict(): pass/fail/unclear]")
    check("'PASS\\n...' parses to pass", mod.parse_judge_verdict("PASS\nSupported.") == "pass")
    check("'FAIL\\n...' parses to fail", mod.parse_judge_verdict("FAIL\nNot supported.") == "fail")
    check("ambiguous text is unclear, never a guessed pass/fail",
          mod.parse_judge_verdict("Hard to tell.") == "unclear")
    check("empty judge reply is unclear, not a crash", mod.parse_judge_verdict("") == "unclear")

    print("\n[monkeypatching reaches the REAL summarize_highlights() body]")
    def fake_router_chat_duplicate(messages, model="super", timeout=120, retries=3):
        return "[0] Vendor X releases Glimmer-9, a 9B open-weight coding model"
    digest.rag.router_chat = fake_router_chat_duplicate
    dup_case = [c for c in cases if c[0] == "duplicate_collapse"][0]
    out = digest.summarize_highlights(dup_case[1], dup_case[2])
    check("real function collapses the model's single line to one highlight, citing a real match",
          len(out) == 1 and out[0][1] == dup_case[2][0]["citation"], str(out))

    def fake_router_chat_nothing_new(messages, model="super", timeout=120, retries=3):
        return "nothing new"
    digest.rag.router_chat = fake_router_chat_nothing_new
    nn_case = [c for c in cases if c[0] == "nothing_new"][0]
    out = digest.summarize_highlights(nn_case[1], nn_case[2])
    check("real function's own 'nothing new' short-circuit returns an empty list",
          out == [], str(out))

    def fake_router_chat_bad_index(messages, model="super", timeout=120, retries=3):
        return "[7] A claim citing an index that was never offered"
    digest.rag.router_chat = fake_router_chat_bad_index
    out = digest.summarize_highlights(nn_case[1], nn_case[2])
    check("real function's own HIGHLIGHT_RE range-check drops an out-of-range cited index",
          out == [], str(out))

    print("\n[main(): end-to-end, a well-behaved model + judge scores clean on all 3 axes]")
    def good_digest(endpoint, model, messages, max_tokens=2000, timeout=120):
        user = messages[1]["content"]
        if "Glimmer-9" in user:
            return "[0] Vendor X releases Glimmer-9, a 9B open-weight coding model"
        if "retailer" in user.lower():
            return "[0] A retailer discloses a data breach affecting an undisclosed number of accounts"
        if "recapped last month" in user:
            return "nothing new"
        if "lunar lander" in user and "fast radio burst" in user:
            return ("[0] A commercial lunar lander completes a powered descent test\n"
                    "[1] Astronomers detect a new repeating fast radio burst")
        if "CVE-2026-41122" in user:
            return "[0] Acme Networks patches an actively exploited VPN gateway RCE flaw"
        return "nothing new"

    def good_judge(endpoint, model, messages, max_tokens=300, timeout=120):
        return "PASS\nSupported."

    def dispatch_good(endpoint, model, messages, max_tokens=300, timeout=120):
        if endpoint == "http://fake-digest:1/v1":
            return good_digest(endpoint, model, messages, max_tokens, timeout)
        return good_judge(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = dispatch_good

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-digest-faithfulness-eval.py", "--endpoint", "http://fake-digest:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1", "--model-id", "test-super"]
        rc = mod.main()
        check("main() returns 0", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        check("exactly one history entry written", len(entries) == 1, str(entries))
        suites = entries[0]["suites"]
        check("grounded is 1.0 for a well-behaved model",
              suites.get("fleet_digest_faithfulness_grounded", {}).get("value") == 1.0, str(suites))
        check("faithful (judged, the bare overall key) is 1.0",
              suites.get("fleet_digest_faithfulness", {}).get("value") == 1.0, str(suites))
        check("padding_restraint is 1.0 (nothing_new case correctly emitted zero highlights)",
              suites.get("fleet_digest_faithfulness_padding_restraint", {}).get("value") == 1.0,
              str(suites))
        check("role_or_endpoint defaults to 'super', the real role summarize_highlights() calls",
              entries[0]["role_or_endpoint"] == "super")

    print("\n[main(): a model that pads 'nothing new' and a judge that fails a claim both get caught]")
    def bad_digest(endpoint, model, messages, max_tokens=2000, timeout=120):
        user = messages[1]["content"]
        if "recapped last month" in user:
            return "[0] Benchmarks shift dramatically as new frontier models debut overnight"
        return "nothing new"

    def failing_judge(endpoint, model, messages, max_tokens=300, timeout=120):
        return "FAIL\nNot supported by the passage."

    def dispatch_bad(endpoint, model, messages, max_tokens=300, timeout=120):
        if endpoint == "http://fake-digest:1/v1":
            return bad_digest(endpoint, model, messages, max_tokens, timeout)
        return failing_judge(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = dispatch_bad

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-digest-faithfulness-eval.py", "--endpoint", "http://fake-digest:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1"]
        rc = mod.main()
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        suites = entries[0]["suites"]
        check("padding_restraint is 0.0 -- the padded 'nothing new' case is caught",
              suites.get("fleet_digest_faithfulness_padding_restraint", {}).get("value") == 0.0,
              str(suites))
        check("faithful is 0.0 -- the judge's FAIL verdict on the fabricated claim is honored",
              suites.get("fleet_digest_faithfulness", {}).get("value") == 0.0, str(suites))

    print("\n[main(): no --judge-endpoint -> faithful axis is absent, not guessed]")
    mod.call_backend = lambda endpoint, model, messages, max_tokens=300, timeout=120: good_digest(
        endpoint, model, messages, max_tokens, timeout)
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-digest-faithfulness-eval.py", "--endpoint", "http://fake-digest:1/v1"]
        rc = mod.main()
        check("main() still returns 0 with no judge endpoint", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        suites = entries[0]["suites"] if entries else {}
        check("fleet_digest_faithfulness (judged) is absent without a judge, not falsely scored",
              "fleet_digest_faithfulness" not in suites, str(suites))
        check("the deterministic axes (grounded/padding_restraint) are still recorded",
              "fleet_digest_faithfulness_grounded" in suites
              and "fleet_digest_faithfulness_padding_restraint" in suites, str(suites))

    print("\n[main(): a failed call on one case doesn't block scoring the rest]")
    calls = {"n": 0}
    def flaky_digest(endpoint, model, messages, max_tokens=2000, timeout=120):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection refused")
        return good_digest(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = lambda endpoint, model, messages, max_tokens=300, timeout=120: flaky_digest(
        endpoint, model, messages, max_tokens, timeout)
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-digest-faithfulness-eval.py", "--endpoint", "http://fake-digest:1/v1"]
        rc = mod.main()
        check("main() still returns 0 despite one failed case", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        check("a history entry is still written from the 4 surviving cases", len(entries) == 1,
              str(entries))

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
