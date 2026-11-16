#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for hermes-gepa-coder-fix.py (HermesAgentV6 IMPLEMENTATION_PLAN.md GLM-5.3-Flash
# Paradigm A, Phase 1). No network, no live backend: monkeypatches call_backend() (imported into
# the adapter module's own namespace, same pattern test_coder_fix.py already uses) so
# FixGEPAAdapter.evaluate()/make_reflective_dataset() run with zero real HTTP calls.
#
# REQUIRES the isolated gepa venv (archive/IMPLEMENTATION_PLAN_GLM53_V5_GROUNDED.md Phase 2,
# /opt/gepa-venv on dgx-spark) -- hermes-gepa-coder-fix.py imports `gepa` at module level, which
# is deliberately NOT installed anywhere else on this fleet. Run with:
#   /opt/gepa-venv/bin/python3 infra/model-benchmark/tests/test_gepa_coder_fix.py
# not the plain `python3` every other offline test in this directory uses.
#
# What it covers: the adapter's own scoring/reshaping logic, not GEPA's search itself (that's
# verified live against a real backend, see the Phase 1 commit's own testing notes, not re-run
# offline here) --
#   * evaluate() scores a repro-capable task via the real executable repro (not the judge),
#     and a judge-only task via the judge, exactly like the CLI suite's own two-tier split (S8.6)
#   * evaluate(capture_traces=True) populates one trajectory per task, aligned 1:1 with
#     outputs/scores (GEPAAdapter's own correctness constraint)
#   * evaluate() never raises on a single example's call failure -- a fallback 0.0 score and an
#     "error" trajectory field, per GEPAAdapter's own error-handling contract
#   * make_reflective_dataset() returns exactly one record per trajectory, under the "fix_skill"
#     component key, each with Inputs/Generated Outputs/Feedback (GEPA's own recommended schema)
#
# Run: /opt/gepa-venv/bin/python3 infra/model-benchmark/tests/test_gepa_coder_fix.py
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
    spec = importlib.util.spec_from_file_location("hermes_gepa_coder_fix",
                                                    TOOLS / "hermes-gepa-coder-fix.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    try:
        mod = load()
    except ImportError as exc:
        print(f"SKIPPED: {exc} -- this test requires /opt/gepa-venv's python3, not the system one")
        return 0

    repro_task = next(t for t in mod.TASKS if t["id"] == "reolink_ai_state")
    judge_task = next(t for t in mod.TASKS if t["id"] == "mesh_stl_gaps")
    candidate = {mod.COMPONENT: mod.DEFAULT_FIX_SYSTEM_PROMPT}

    print("\n[evaluate(): repro-capable task scored via the real executable repro, not the judge]")

    def perfect_coder(endpoint, model, messages, max_tokens=4000, timeout=180):
        user = messages[1]["content"]
        for task in mod.TASKS:
            if task["path"] in user and task["symptom"][:40] in user:
                real_post = mod.file_at(task["hash"], task["path"], pre_fix=False)
                real_excerpt, _ = mod.extract_regions(real_post, task["regions"])
                return "\n".join(real_excerpt.splitlines()[1:])
        return "UNMATCHED"

    def perfect_judge(endpoint, model, messages, max_tokens=4000, timeout=180):
        return "PASS\nAddresses the real root cause."

    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        perfect_coder(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-executor:1/v1"
        else perfect_judge(endpoint, model, messages, max_tokens, timeout))

    adapter = mod.FixGEPAAdapter("http://fake-executor:1/v1", "coder",
                                  "http://fake-judge:1/v1", "judge")
    batch = [repro_task, judge_task]
    result = adapter.evaluate(batch, candidate, capture_traces=True)

    check("outputs/scores/trajectories all align 1:1 with the batch",
          len(result.outputs) == len(batch) and len(result.scores) == len(batch)
          and len(result.trajectories) == len(batch))
    check("repro task scored via repro (perfect patch -> 1.0)", result.scores[0] == 1.0,
          str(result.scores))
    check("repro task's trajectory carries the repro result, not a judge verdict",
          "repro" in result.trajectories[0] and "judge_verdict" not in result.trajectories[0],
          str(result.trajectories[0]))
    check("judge-tier task scored via the judge (PASS -> 1.0)", result.scores[1] == 1.0,
          str(result.scores))
    check("judge-tier task's trajectory carries the judge verdict, not a repro result",
          "judge_verdict" in result.trajectories[1] and "repro" not in result.trajectories[1],
          str(result.trajectories[1]))

    print("\n[evaluate(): a wrong patch fails both axes]")

    def noop_coder(endpoint, model, messages, max_tokens=4000, timeout=180):
        user = messages[1]["content"]
        idx = user.index("Current content:\n") + len("Current content:\n")
        return "\n".join(user[idx:].splitlines()[1:])

    def failing_judge(endpoint, model, messages, max_tokens=4000, timeout=180):
        return "FAIL\nDoes not address the root cause."

    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        noop_coder(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-executor:1/v1"
        else failing_judge(endpoint, model, messages, max_tokens, timeout))

    result = adapter.evaluate(batch, candidate, capture_traces=True)
    check("a no-op patch fails the repro (score 0.0)", result.scores[0] == 0.0, str(result.scores))
    check("a no-op patch fails the judge (score 0.0)", result.scores[1] == 0.0, str(result.scores))

    print("\n[evaluate(): a single example's call failure never raises, scores 0.0, records the error]")
    calls = {"n": 0}

    def flaky(endpoint, model, messages, max_tokens=4000, timeout=180):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection refused")
        return noop_coder(endpoint, model, messages, max_tokens, timeout)
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
    check("the second example still gets a real score (the failure didn't abort the batch)",
          result.scores[1] in (0.0, 1.0), str(result.scores))

    print("\n[evaluate(capture_traces=False): trajectories is None, not an empty list]")
    result = adapter.evaluate(batch, candidate, capture_traces=False)
    check("trajectories is None when capture_traces=False", result.trajectories is None,
          str(result.trajectories))

    print("\n[make_reflective_dataset(): one record per trajectory, under the fix_skill key]")
    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        perfect_coder(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-executor:1/v1"
        else failing_judge(endpoint, model, messages, max_tokens, timeout))
    eval_batch = adapter.evaluate(batch, candidate, capture_traces=True)
    reflective = adapter.make_reflective_dataset(candidate, eval_batch, [mod.COMPONENT])
    check("the component key is exactly fix_skill", list(reflective.keys()) == [mod.COMPONENT],
          str(list(reflective.keys())))
    records = reflective[mod.COMPONENT]
    check("one reflective record per trajectory", len(records) == len(batch), str(len(records)))
    check("every record has Inputs/Generated Outputs/Feedback (GEPA's recommended schema)",
          all({"Inputs", "Generated Outputs", "Feedback"} <= set(r) for r in records), str(records))

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
