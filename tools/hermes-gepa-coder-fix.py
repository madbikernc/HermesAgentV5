#!/usr/bin/env python3
# Version: 1.0.0
#
# Initial version (2026-11-16) — HermesAgentV6 IMPLEMENTATION_PLAN.md GLM-5.3-Flash Paradigm A,
# Phase 1: a GEPA (gepa-ai/gepa, pip-installed into an isolated /opt/gepa-venv -- see
# archive/IMPLEMENTATION_PLAN_GLM53_V5_GROUNDED.md Phase 2) adapter wrapping the existing
# fleet_coder_fix suite (tools/hermes_coder_fix_common.py) so its system-prompt text
# (DEFAULT_FIX_SYSTEM_PROMPT) can be optimized as a GEPA "skill" against real execution/judge
# feedback, rather than reimplementing task corpus or scoring logic here. Reuses
# hermes_coder_fix_common's file_at/extract_regions/substitute_region/run_python_repro/
# call_backend/fix_prompt/judge_prompt/parse_judge_verdict exactly as hermes-coder-fix-eval.py
# already does -- this script is a GEPA-shaped consumer of the same logic, not a parallel one.
#
# Component name: "fix_skill" (single component -- this campaign optimizes exactly one piece of
# text, the system prompt fix_prompt() hands the executor model).
#
# reflection_lm: GEPA accepts a plain callable matching LanguageModel's protocol
# (prompt: str | list[dict]) -> str, confirmed live against gepa 0.1.4's own source
# (gepa.proposer.reflective_mutation.base.LanguageModel) -- no litellm model-string resolution
# needed, matching this project's own "direct-to-backend" convention (S8.1) rather than adding a
# second way to reach a model.
"""
hermes-gepa-coder-fix.py — GEPA skill optimization over fleet_coder_fix's seed system prompt.

Usage:
  /opt/gepa-venv/bin/python3 hermes-gepa-coder-fix.py \\
      --executor-endpoint http://127.0.0.1:8094/v1 --executor-model coder \\
      --judge-endpoint http://127.0.0.1:8095/v1 --judge-model super \\
      --reflection-endpoint http://127.0.0.1:8094/v1 --reflection-model coder \\
      --max-metric-calls 30 [--held-out ID,ID,ID]

Phase 1 dry run: point --reflection-endpoint at an already-live role (coder/coder2) to prove the
harness mechanics work end to end, cheaply, before Phase 2 wires in the new `reflector` role.
"""
import argparse
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from hermes_coder_fix_common import (  # noqa: E402
    TASKS, DEFAULT_FIX_SYSTEM_PROMPT, file_at, extract_regions, strip_code_fence,
    substitute_region, run_python_repro, call_backend, fix_prompt, judge_prompt,
    parse_judge_verdict,
)

import gepa  # noqa: E402 -- only present in /opt/gepa-venv, by design (see this file's own header)

COMPONENT = "fix_skill"


def log(msg):
    print(f"[hermes-gepa-coder-fix] {msg}", flush=True)


class FixGEPAAdapter(gepa.GEPAAdapter):
    """batch items are hermes_coder_fix_common.TASKS entries, unchanged. candidate is
    {"fix_skill": "<system prompt text>"}. Scores are 1.0/0.0 -- GEPA sums for minibatch
    acceptance and averages for the full valset, which is exactly what a pass-rate is."""

    def __init__(self, executor_endpoint, executor_model, judge_endpoint, judge_model):
        self.executor_endpoint = executor_endpoint
        self.executor_model = executor_model
        self.judge_endpoint = judge_endpoint
        self.judge_model = judge_model

    def evaluate(self, batch, candidate, capture_traces=False):
        outputs, scores, trajectories = [], [], [] if capture_traces else None
        skill_text = candidate[COMPONENT]
        for task in batch:
            trace = {"task": task["id"], "symptom": task["symptom"]}
            try:
                pre_fix_full = file_at(task["hash"], task["path"], pre_fix=True)
                excerpt, regions = extract_regions(pre_fix_full, task["regions"])
                raw = call_backend(self.executor_endpoint, self.executor_model,
                                    fix_prompt(task["path"], task["symptom"], excerpt,
                                               system_prompt=skill_text))
                patch_text = strip_code_fence(raw)
            except Exception as exc:
                # Per GEPAAdapter's own contract: never raise for a single example -- a
                # fallback score, with the error recorded in the trajectory, not a crash.
                log(f"[{task['id']}] call/setup failed: {exc}")
                outputs.append(None)
                scores.append(0.0)
                if capture_traces:
                    trace["error"] = str(exc)
                    trajectories.append(trace)
                continue

            trace["patch"] = patch_text
            score = None

            if task["tier"] == "repro" and task["lang"] == "python":
                full_candidate = substitute_region(pre_fix_full, regions[0], patch_text)
                repro = run_python_repro(full_candidate, task["repro"])
                trace["repro"] = repro
                score = 1.0 if repro["status"] == "pass" else 0.0

            if score is None and self.judge_endpoint:
                try:
                    real_fix_full = file_at(task["hash"], task["path"], pre_fix=False)
                    real_excerpt, _ = extract_regions(real_fix_full, task["regions"])
                    judge_reply = call_backend(self.judge_endpoint, self.judge_model,
                                                judge_prompt(task["symptom"], patch_text, real_excerpt))
                    verdict = parse_judge_verdict(judge_reply)
                    trace["judge_verdict"] = verdict
                    trace["judge_rationale"] = judge_reply
                    score = 1.0 if verdict == "pass" else 0.0
                except Exception as exc:
                    log(f"[{task['id']}] judge call failed: {exc}")
                    trace["judge_error"] = str(exc)
                    score = 0.0

            if score is None:  # repro tier, non-python, no judge endpoint given
                score = 0.0
                trace["note"] = "no repro runner and no judge endpoint -- scored 0.0, not guessed"

            outputs.append(patch_text)
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
            elif "repro" in trace:
                repro = trace["repro"]
                feedback = ("PASS: the real executable repro scenario passed against this patch."
                            if repro["status"] == "pass"
                            else f"FAIL: the real executable repro scenario failed -- {repro.get('detail', '')}")
                generated = trace["patch"]
            elif "judge_verdict" in trace:
                feedback = f"{trace['judge_verdict'].upper()}: {trace['judge_rationale']}"
                generated = trace["patch"]
            else:
                feedback = trace.get("judge_error") or trace.get("note") or "unscored"
                generated = trace.get("patch", "")
            records.append({
                "Inputs": {"symptom": trace["symptom"]},
                "Generated Outputs": generated,
                "Feedback": feedback,
            })
        return {COMPONENT: records}


def make_reflection_lm(endpoint, model):
    """Matches gepa's LanguageModel protocol exactly: (prompt: str | list[dict]) -> str."""
    def _call(prompt):
        messages = prompt if isinstance(prompt, list) else [{"role": "user", "content": prompt}]
        return call_backend(endpoint, model, messages, max_tokens=8000, timeout=300)
    return _call


def main():
    ap = argparse.ArgumentParser(description="GEPA skill optimization over fleet_coder_fix")
    ap.add_argument("--executor-endpoint", required=True)
    ap.add_argument("--executor-model", default="coder")
    ap.add_argument("--judge-endpoint", default=None)
    ap.add_argument("--judge-model", default="judge")
    ap.add_argument("--reflection-endpoint", required=True)
    ap.add_argument("--reflection-model", required=True)
    ap.add_argument("--max-metric-calls", type=int, default=30,
                     help="hard cap on evaluate() calls across the whole search -- keeps a dry "
                          "run (or a real campaign against a slow reflection model) bounded")
    ap.add_argument("--held-out", default="",
                     help="comma-separated task ids excluded from the training set, scored "
                          "separately at the end for a held-out comparison")
    ap.add_argument("--run-dir", default=None, help="passed to gepa.optimize() for checkpointing")
    args = ap.parse_args()

    held_out_ids = {t for t in args.held_out.split(",") if t}
    trainset = [t for t in TASKS if t["id"] not in held_out_ids]
    valset = [t for t in TASKS if t["id"] in held_out_ids] or None
    log(f"{len(trainset)} training task(s), {len(valset or [])} held-out task(s)")

    adapter = FixGEPAAdapter(args.executor_endpoint, args.executor_model,
                              args.judge_endpoint, args.judge_model)
    reflection_lm = make_reflection_lm(args.reflection_endpoint, args.reflection_model)

    result = gepa.optimize(
        seed_candidate={COMPONENT: DEFAULT_FIX_SYSTEM_PROMPT},
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
    print("\n=== GEPA fix_skill result ===")
    print(json.dumps({"best_score": best_score, "best_candidate": result.best_candidate},
                      indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
