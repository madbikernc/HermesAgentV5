#!/usr/bin/env python3
# Version: 1.0.1
#
# 1.0.1 (2026-11-17) - same bug fix as hermes-gepa-coder-fix.py 1.0.1: make_reflection_lm() now
# passes extra_body={"reasoning_effort": "low"} -- found before Phase 3's first real campaign,
# would otherwise have reproduced S31's truncation failure the first time reflector was used as a
# real reflection_lm.
#
# Initial version (2026-11-16) — HermesAgentV6 IMPLEMENTATION_PLAN.md GLM-5.3-Flash Paradigm A,
# Phase 1: a GEPA adapter wrapping the existing fleet_coder_build suite
# (tools/hermes_coder_build_common.py), the build-task sibling of hermes-gepa-coder-fix.py. See
# that file's own header for the shared design rationale (component naming, reflection_lm
# protocol, error-handling contract) -- not repeated here.
#
# Component name: "build_skill" (single component -- the system-prompt text build_prompt() hands
# the executor model; the fixture_note suffix stays hardcoded/appended regardless, same as the
# CLI suite -- it's a scoring-mechanism instruction, not part of the skill being optimized).
"""
hermes-gepa-coder-build.py — GEPA skill optimization over fleet_coder_build's seed system prompt.

Usage:
  /opt/gepa-venv/bin/python3 hermes-gepa-coder-build.py \\
      --executor-endpoint http://127.0.0.1:8094/v1 --executor-model coder \\
      --judge-endpoint http://127.0.0.1:8095/v1 --judge-model super \\
      --reflection-endpoint http://127.0.0.1:8094/v1 --reflection-model coder \\
      --max-metric-calls 30 [--held-out ID,ID]
"""
import argparse
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from hermes_coder_build_common import (  # noqa: E402
    TASKS, DEFAULT_BUILD_SYSTEM_PROMPT, strip_code_fence, load_code, real_reference,
    call_backend, build_prompt, judge_prompt, parse_judge_verdict,
)

import gepa  # noqa: E402 -- only present in /opt/gepa-venv, by design

COMPONENT = "build_skill"


def log(msg):
    print(f"[hermes-gepa-coder-build] {msg}", flush=True)


class BuildGEPAAdapter(gepa.GEPAAdapter):
    def __init__(self, executor_endpoint, executor_model, judge_endpoint, judge_model):
        self.executor_endpoint = executor_endpoint
        self.executor_model = executor_model
        self.judge_endpoint = judge_endpoint
        self.judge_model = judge_model

    def evaluate(self, batch, candidate, capture_traces=False):
        outputs, scores, trajectories = [], [], [] if capture_traces else None
        skill_text = candidate[COMPONENT]
        for task in batch:
            has_fixture = task["fixture"] is not None
            trace = {"task": task["id"], "requirement": task["requirement"]}
            try:
                raw = call_backend(self.executor_endpoint, self.executor_model,
                                    build_prompt(task["path"], task["requirement"], has_fixture,
                                                system_prompt=skill_text))
                response_text = strip_code_fence(raw)
            except Exception as exc:
                log(f"[{task['id']}] call failed: {exc}")
                outputs.append(None)
                scores.append(0.0)
                if capture_traces:
                    trace["error"] = str(exc)
                    trajectories.append(trace)
                continue

            trace["response"] = response_text
            score = None

            if has_fixture:
                try:
                    mod = load_code(response_text, module_name=f"_gepa_build_{task['id']}")
                    task["fixture"](mod)
                    trace["fixture"] = {"status": "pass"}
                    score = 1.0
                except AssertionError as exc:
                    trace["fixture"] = {"status": "fail", "detail": str(exc)}
                    score = 0.0
                except Exception as exc:
                    trace["fixture"] = {"status": "fail", "detail": f"{type(exc).__name__}: {exc}"}
                    score = 0.0

            if score is None and self.judge_endpoint:
                try:
                    real_excerpt = real_reference(task)
                    judge_reply = call_backend(self.judge_endpoint, self.judge_model,
                                                judge_prompt(task["requirement"], response_text,
                                                            real_excerpt))
                    verdict = parse_judge_verdict(judge_reply)
                    trace["judge_verdict"] = verdict
                    trace["judge_rationale"] = judge_reply
                    score = 1.0 if verdict == "pass" else 0.0
                except Exception as exc:
                    log(f"[{task['id']}] judge call failed: {exc}")
                    trace["judge_error"] = str(exc)
                    score = 0.0

            if score is None:
                score = 0.0
                trace["note"] = "no fixture and no judge endpoint -- scored 0.0, not guessed"

            outputs.append(response_text)
            scores.append(score)
            if capture_traces:
                trajectories.append(trace)

        return gepa.EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories)

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        records = []
        for trace in (eval_batch.trajectories or []):
            if "error" in trace:
                feedback = f"The call itself failed before scoring: {trace['error']}"
                generated = ""
            elif "fixture" in trace:
                fixture = trace["fixture"]
                feedback = ("PASS: the real fixture test passed against this implementation."
                            if fixture["status"] == "pass"
                            else f"FAIL: the real fixture test failed -- {fixture.get('detail', '')}")
                generated = trace["response"]
            elif "judge_verdict" in trace:
                feedback = f"{trace['judge_verdict'].upper()}: {trace['judge_rationale']}"
                generated = trace["response"]
            else:
                feedback = trace.get("judge_error") or trace.get("note") or "unscored"
                generated = trace.get("response", "")
            records.append({
                "Inputs": {"requirement": trace["requirement"]},
                "Generated Outputs": generated,
                "Feedback": feedback,
            })
        return {COMPONENT: records}


def make_reflection_lm(endpoint, model):
    def _call(prompt):
        messages = prompt if isinstance(prompt, list) else [{"role": "user", "content": prompt}]
        return call_backend(endpoint, model, messages, max_tokens=8000, timeout=300,
                             extra_body={"reasoning_effort": "low"})
    return _call


def main():
    ap = argparse.ArgumentParser(description="GEPA skill optimization over fleet_coder_build")
    ap.add_argument("--executor-endpoint", required=True)
    ap.add_argument("--executor-model", default="coder")
    ap.add_argument("--judge-endpoint", default=None)
    ap.add_argument("--judge-model", default="judge")
    ap.add_argument("--reflection-endpoint", required=True)
    ap.add_argument("--reflection-model", required=True)
    ap.add_argument("--max-metric-calls", type=int, default=30)
    ap.add_argument("--held-out", default="")
    ap.add_argument("--run-dir", default=None)
    args = ap.parse_args()

    held_out_ids = {t for t in args.held_out.split(",") if t}
    trainset = [t for t in TASKS if t["id"] not in held_out_ids]
    valset = [t for t in TASKS if t["id"] in held_out_ids] or None
    log(f"{len(trainset)} training task(s), {len(valset or [])} held-out task(s)")

    adapter = BuildGEPAAdapter(args.executor_endpoint, args.executor_model,
                               args.judge_endpoint, args.judge_model)
    reflection_lm = make_reflection_lm(args.reflection_endpoint, args.reflection_model)

    result = gepa.optimize(
        seed_candidate={COMPONENT: DEFAULT_BUILD_SYSTEM_PROMPT},
        trainset=trainset,
        valset=valset,
        adapter=adapter,
        reflection_lm=reflection_lm,
        max_metric_calls=args.max_metric_calls,
        run_dir=args.run_dir,
    )

    best_score = result.val_aggregate_scores[result.best_idx]
    log(f"best candidate (idx {result.best_idx}) val score: {best_score}, "
        f"{result.num_candidates} candidate(s) explored, "
        f"{result.total_metric_calls} metric call(s)")
    print("\n=== GEPA build_skill result ===")
    print(json.dumps({"best_score": best_score, "best_candidate": result.best_candidate},
                      indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
