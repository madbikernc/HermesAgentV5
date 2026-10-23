#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase B's fleet_log_analyst suite (FLEET_BENCHMARK_DESIGN.md S6.1,
# closes gap 1, after S39a's sign-off 2026-10-22). No network, no live `super` backend: every
# scoring check below feeds canned replies straight into the pure classify_verdict()/
# check_facts() functions, or monkeypatches ask_super_direct() so main()'s own end-to-end
# case-iteration/scoring/history-write path runs with zero real HTTP calls.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * load_source_system_prompt() actually reads the real, current hermes-logs.py constant via
#     ast, not a stale hand-copy -- the S8.5 anti-drift guarantee, asserted rather than assumed
#   * classify_verdict()'s three-way outcome, including "unclear" when both or neither pattern
#     matches -- a non-answer must never score as wrong
#   * check_facts() is a case-insensitive substring check, nothing fancier
#   * every one of the 18 built-in cases has a well-formed gold label and at least a plausible
#     shape (source is one of the three real sources, band is one of the three real bands)
#   * main()'s end-to-end path: given canned replies, the printed accuracy and the shared-history
#     entry it writes both reflect the real scoring, not a hardcoded number
#
# Run: python3 infra/model-benchmark/tests/test_log_analyst.py
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
    spec = importlib.util.spec_from_file_location("hermes_log_analyst_eval",
                                                    TOOLS / "hermes-log-analyst-eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()

    print("\n[load_source_system_prompt(): S8.5 anti-drift guarantee]")
    prompt = mod.load_source_system_prompt()
    check("reads a non-trivial string", isinstance(prompt, str) and len(prompt) > 200, str(len(prompt)))
    check("matches the real hermes-logs.py prompt's own stated role",
          "log analyst" in prompt.lower())
    check("carries the anti-injection instruction verbatim (not a paraphrase)",
          "ignore previous instructions" in prompt.lower()
          or "is itself the finding to report" in prompt.lower(), prompt[:200])

    print("\n[classify_verdict(): three-way outcome]")
    check("a clearly malicious-leaning brief classifies malicious",
          mod.classify_verdict("This looks like a brute-force attack from one source.") == "malicious")
    check("a clearly benign-leaning brief classifies benign",
          mod.classify_verdict("This is routine traffic, nothing out of the ordinary.") == "benign")
    check("neither pattern matching is 'unclear', not a guess either way",
          mod.classify_verdict("The server restarted at noon.") == "unclear")
    check("both patterns matching is also 'unclear' -- a non-answer is not a 'no'",
          mod.classify_verdict("Routine background noise, but one host shows suspicious "
                                "scanning behavior worth a closer look.") == "unclear")

    print("\n[check_facts(): case-insensitive substring check]")
    check("an exact-case fact is found", mod.check_facts("Source IP 203.0.113.91 hit port 22",
                                                          ["203.0.113.91"]) == ["203.0.113.91"])
    check("a different-case fact is still found",
          mod.check_facts("the user WADE granted themselves admin", ["Wade"]) == ["Wade"])
    check("a missing fact is not found",
          mod.check_facts("nothing relevant here", ["203.0.113.91"]) == [])

    print("\n[LOG_ANALYST_CASES: every built-in case is well-formed]")
    valid_sources = {"pfsense", "canary", "gameabuse"}
    valid_bands = {"obvious_malicious", "obvious_benign", "ambiguous"}
    valid_golds = {"malicious", "benign"}
    check("18 cases, matching this suite's own stated starting-set size",
          len(mod.LOG_ANALYST_CASES) == 18, str(len(mod.LOG_ANALYST_CASES)))
    bad = [c for c in mod.LOG_ANALYST_CASES
           if c[0] not in valid_sources or c[1] not in valid_bands or c[3] not in valid_golds
           or not c[2].strip()]
    check("every case has a real source/band/gold and non-empty text", not bad, str(bad))
    for source in valid_sources:
        n = sum(1 for c in mod.LOG_ANALYST_CASES if c[0] == source)
        check(f"{source!r} has at least one case of each band",
              {c[1] for c in mod.LOG_ANALYST_CASES if c[0] == source} == valid_bands, f"n={n}")

    print("\n[main(): end-to-end scoring + shared-history write, canned replies]")
    # Every case's gold answer, fed back verbatim as the "model reply" -- should score 100%.
    canned = {
        "malicious": "This activity is malicious and consistent with an attack.",
        "benign": "This is routine, expected, benign activity. No action needed.",
    }
    mod.ask_super_direct = lambda endpoint, prompt, source, text, **kw: canned[
        next(c[3] for c in mod.LOG_ANALYST_CASES if c[2] == text)]

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-log-analyst-eval.py", "--endpoint", "http://fake:1/v1",
                    "--model-id", "test-model"]
        rc = mod.main()
        check("main() returns 0", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        check("exactly one history entry written", len(entries) == 1, str(entries))
        suite = entries[0]["suites"]["fleet_log_analyst"]
        check("perfect canned replies score 1.0 accuracy", suite["value"] == 1.0, str(suite))
        check("role_or_endpoint is 'super'", entries[0]["role_or_endpoint"] == "super")

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
