#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase C's fleet_dualcoder_precision suite (FLEET_BENCHMARK_DESIGN.md
# S6.5, closes gap 5, after S39a's sign-off 2026-10-22). No network, no live coder backend:
# every check below calls the pure case-building/scoring functions directly, confirms the real
# scanner (hermes-code-security-scan.py) actually agrees with each case's expected has_findings
# on THIS machine (not assumed), or monkeypatches call_backend() so main()'s own end-to-end path
# runs with zero real HTTP calls.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * load_security_system_prompt() actually finds the real constant in hermes-dualcoder.py,
#     not a stale/renamed one
#   * build_cases() returns all 6 cases, and the REAL scan_code() confirms each one's
#     expected has_findings on this machine's own (degraded, no codesec venv) environment --
#     the two pure-regex heuristic categories are enough for all 6, confirmed live, not assumed
#   * confirms_findings()/invents_new_vuln() catch the right language and don't false-positive
#     on an ordinary unhedged review
#   * main()'s end-to-end path: a perfect model scores 1.0/1.0, a model that's wrong on
#     everything scores 0.0/0.0, and a failed call for one case doesn't block scoring the rest
#
# Run: python3 infra/model-benchmark/tests/test_dualcoder_precision.py
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
    spec = importlib.util.spec_from_file_location("hermes_dualcoder_precision_eval",
                                                    TOOLS / "hermes-dualcoder-precision-eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()

    print("\n[load_security_system_prompt(): the real constant, not a stale copy]")
    prompt = mod.load_security_system_prompt()
    check("prompt is non-trivially long", len(prompt) > 100, str(len(prompt)))
    check("prompt mentions a security review", "security" in prompt.lower())

    print("\n[build_cases(): all 6 cases, and the REAL scanner agrees on THIS machine]")
    codesec = mod.load_codesec()
    cases = mod.build_cases()
    check("6 cases total", len(cases) == 6, str(len(cases)))
    check("3 case ids expect findings, 3 expect clean",
          sum(1 for _c, _code, exp in cases if exp) == 3
          and sum(1 for _c, _code, exp in cases if not exp) == 3)
    for case_id, code, expected_has_findings in cases:
        findings = codesec.scan_code(code)
        real_count = sum(len(v) for k, v in findings.items() if k != "tool_errors")
        check(f"[{case_id}] real scan_code() has_findings matches expectation on this machine",
              (real_count > 0) == expected_has_findings, str(findings))

    print("\n[confirms_findings() / invents_new_vuln(): the right language, no false positives]")
    check("an unhedged agreement confirms findings",
          mod.confirms_findings("I confirm the os.system call here is a real risk."))
    check("'false positive' dismisses findings (does NOT confirm)",
          not mod.confirms_findings("This is a false positive, the input is fully trusted."))
    check("'not a real issue' dismisses findings too",
          not mod.confirms_findings("Not a real issue in this context."))
    check("a clean, unhedged review does not invent a new vuln",
          not mod.invents_new_vuln("This function is simple and safe, no concerns."))
    check("claiming a 'vulnerability' on a clean case IS inventing one",
          mod.invents_new_vuln("This has a potential vulnerability in how it handles input."))
    check("claiming an 'injection' risk IS inventing one",
          mod.invents_new_vuln("Looks like a possible injection vector here."))

    print("\n[main(): end-to-end, a perfect model scores 1.0/1.0]")
    def perfect_backend(endpoint, model, system_prompt, user_content, max_tokens=2000, timeout=180):
        if "os.system" in user_content or "shutil.rmtree" in user_content or "logging.info" in user_content:
            return "I confirm this finding is a real issue and should be fixed."
        return "This function is simple and safe, no concerns."

    mod.call_backend = perfect_backend
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-dualcoder-precision-eval.py", "--endpoint", "http://fake-coder:1/v1",
                    "--model-id", "test-coder"]
        rc = mod.main()
        check("main() returns 0", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        check("exactly one history entry written", len(entries) == 1, str(entries))
        suites = entries[0]["suites"]
        check("recall is 1.0 for a perfect model",
              suites.get("fleet_dualcoder_precision_recall", {}).get("value") == 1.0, str(suites))
        check("precision is 1.0 for a perfect model",
              suites.get("fleet_dualcoder_precision_precision", {}).get("value") == 1.0, str(suites))
        check("the bare fleet_dualcoder_precision overall key (ALL_SUITES' own name) is also 1.0",
              suites.get("fleet_dualcoder_precision", {}).get("value") == 1.0, str(suites))
        check("role_or_endpoint is recorded as 'coder'", entries[0]["role_or_endpoint"] == "coder")

    print("\n[main(): end-to-end, a model that's wrong on everything scores 0.0/0.0]")
    def wrong_backend(endpoint, model, system_prompt, user_content, max_tokens=2000, timeout=180):
        if "os.system" in user_content or "shutil.rmtree" in user_content or "logging.info" in user_content:
            return "This is a false positive, ignore it."
        return "This looks like a potential vulnerability, be careful."

    mod.call_backend = wrong_backend
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-dualcoder-precision-eval.py", "--endpoint", "http://fake-coder:1/v1"]
        rc = mod.main()
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        suites = entries[0]["suites"]
        check("recall is 0.0 for a model wrong on every finding",
              suites.get("fleet_dualcoder_precision_recall", {}).get("value") == 0.0, str(suites))
        check("precision is 0.0 for a model that invents a vuln on every clean case",
              suites.get("fleet_dualcoder_precision_precision", {}).get("value") == 0.0, str(suites))
        check("the bare overall key is also 0.0",
              suites.get("fleet_dualcoder_precision", {}).get("value") == 0.0, str(suites))

    print("\n[main(): a failed call on one case doesn't block scoring the rest]")
    calls = {"n": 0}
    def flaky_backend(endpoint, model, system_prompt, user_content, max_tokens=2000, timeout=180):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection refused")
        return "I confirm this is a real issue." if (
            "os.system" in user_content or "shutil.rmtree" in user_content
            or "logging.info" in user_content) else "Safe, no concerns."

    mod.call_backend = flaky_backend
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-dualcoder-precision-eval.py", "--endpoint", "http://fake-coder:1/v1"]
        rc = mod.main()
        check("main() still returns 0 despite one failed call", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        suites = entries[0]["suites"]
        check("the 5 surviving cases still score (recall out of 2, precision out of 3)",
              suites.get("fleet_dualcoder_precision_recall", {}).get("limit") == 2
              and suites.get("fleet_dualcoder_precision_precision", {}).get("limit") == 3,
              str(suites))

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
