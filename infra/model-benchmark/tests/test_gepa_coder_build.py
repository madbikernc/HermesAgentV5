#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for hermes-gepa-coder-build.py (HermesAgentV6 IMPLEMENTATION_PLAN.md GLM-5.3-Flash
# Paradigm A, Phase 1). See test_gepa_coder_fix.py's own header for the shared rationale
# (monkeypatched call_backend, the gepa-venv requirement) -- not repeated here.
#
# REQUIRES the isolated gepa venv (/opt/gepa-venv on dgx-spark). Run with:
#   /opt/gepa-venv/bin/python3 infra/model-benchmark/tests/test_gepa_coder_build.py
#
# What it covers: BuildGEPAAdapter's own scoring/reshaping logic --
#   * evaluate() scores a fixture-tier task via the real fixture (botnet_intel_build), not the
#     judge, and a judge-only task via the judge, exactly like the CLI suite's own two-tier split
#   * evaluate(capture_traces=True) populates one trajectory per task, aligned 1:1
#   * evaluate() never raises on a single example's call failure
#   * make_reflective_dataset() returns exactly one record per trajectory, under the
#     "build_skill" component key
#
# Run: /opt/gepa-venv/bin/python3 infra/model-benchmark/tests/test_gepa_coder_build.py
import importlib.util
import sys
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
    spec = importlib.util.spec_from_file_location("hermes_gepa_coder_build",
                                                    TOOLS / "hermes-gepa-coder-build.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# The real, correct implementation for botnet_intel_build's three parsers -- same shape as the
# fixture itself expects, used here as the "perfect response" the fake executor returns.
_BOTNET_INTEL_PERFECT = '''
import re, json

def _parse_spamhaus(text):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        cidr, _, tag = line.partition(";")
        out.append((cidr.strip(), tag.strip()))
    return out

def _parse_feodo(text):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append((line, "active C2"))
    return out

def _parse_tweetfeed(raw_json):
    try:
        data = json.loads(raw_json)
    except Exception:
        return []
    out = []
    for item in data:
        if item.get("type") != "ip":
            continue
        tags = item.get("tags") or []
        out.append((item["value"], ",".join(tags) if tags else "unlabeled"))
    return out
'''


def main():
    try:
        mod = load()
    except ImportError as exc:
        print(f"SKIPPED: {exc} -- this test requires /opt/gepa-venv's python3, not the system one")
        return 0

    fixture_task = next(t for t in mod.TASKS if t["id"] == "botnet_intel_build")
    judge_task = next(t for t in mod.TASKS if t["id"] == "shelter_awareness_build")
    candidate = {mod.COMPONENT: mod.DEFAULT_BUILD_SYSTEM_PROMPT}
    batch = [fixture_task, judge_task]

    print("\n[evaluate(): fixture-tier task scored via the real fixture, not the judge]")

    def perfect_executor(endpoint, model, messages, max_tokens=4000, timeout=180):
        return _BOTNET_INTEL_PERFECT

    def perfect_judge(endpoint, model, messages, max_tokens=4000, timeout=180):
        return "PASS\nA competent, workable attempt."

    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        perfect_executor(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-executor:1/v1"
        else perfect_judge(endpoint, model, messages, max_tokens, timeout))

    adapter = mod.BuildGEPAAdapter("http://fake-executor:1/v1", "coder",
                                   "http://fake-judge:1/v1", "judge")
    result = adapter.evaluate(batch, candidate, capture_traces=True)

    check("outputs/scores/trajectories all align 1:1 with the batch",
          len(result.outputs) == len(batch) and len(result.scores) == len(batch)
          and len(result.trajectories) == len(batch))
    check("fixture task scored via the fixture (correct code -> 1.0)", result.scores[0] == 1.0,
          str(result.scores))
    check("fixture task's trajectory carries the fixture result, not a judge verdict",
          "fixture" in result.trajectories[0] and "judge_verdict" not in result.trajectories[0],
          str(result.trajectories[0]))
    check("judge-only task scored via the judge (PASS -> 1.0)", result.scores[1] == 1.0,
          str(result.scores))
    check("judge-only task's trajectory carries the judge verdict, not a fixture result",
          "judge_verdict" in result.trajectories[1] and "fixture" not in result.trajectories[1],
          str(result.trajectories[1]))

    print("\n[evaluate(): a wrong implementation fails both axes]")

    def wrong_executor(endpoint, model, messages, max_tokens=4000, timeout=180):
        return "def _parse_spamhaus(t): return []\ndef _parse_feodo(t): return []\n" \
               "def _parse_tweetfeed(t): return []\n"

    def failing_judge(endpoint, model, messages, max_tokens=4000, timeout=180):
        return "FAIL\nDoes not plausibly address the requirement."

    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        wrong_executor(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-executor:1/v1"
        else failing_judge(endpoint, model, messages, max_tokens, timeout))
    result = adapter.evaluate(batch, candidate, capture_traces=True)
    check("a wrong implementation fails the fixture (score 0.0)", result.scores[0] == 0.0,
          str(result.scores))
    check("a wrong implementation fails the judge (score 0.0)", result.scores[1] == 0.0,
          str(result.scores))

    print("\n[evaluate(): a single example's call failure never raises, scores 0.0]")
    calls = {"n": 0}

    def flaky(endpoint, model, messages, max_tokens=4000, timeout=180):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection refused")
        return wrong_executor(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        flaky(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-executor:1/v1"
        else failing_judge(endpoint, model, messages, max_tokens, timeout))

    try:
        result = adapter.evaluate(batch, candidate, capture_traces=True)
        raised = False
    except Exception:
        raised = True
    check("evaluate() does not raise even when one example's call fails", not raised)
    check("the failed example scores 0.0", result.scores[0] == 0.0, str(result.scores))
    check("the failed example's trajectory records the error", "error" in result.trajectories[0],
          str(result.trajectories[0]))

    print("\n[make_reflective_dataset(): one record per trajectory, under the build_skill key]")
    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        perfect_executor(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-executor:1/v1"
        else failing_judge(endpoint, model, messages, max_tokens, timeout))
    eval_batch = adapter.evaluate(batch, candidate, capture_traces=True)
    reflective = adapter.make_reflective_dataset(candidate, eval_batch, [mod.COMPONENT])
    check("the component key is exactly build_skill", list(reflective.keys()) == [mod.COMPONENT],
          str(list(reflective.keys())))
    records = reflective[mod.COMPONENT]
    check("one reflective record per trajectory", len(records) == len(batch), str(len(records)))
    check("every record has Inputs/Generated Outputs/Feedback",
          all({"Inputs", "Generated Outputs", "Feedback"} <= set(r) for r in records), str(records))

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
