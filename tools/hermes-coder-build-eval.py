#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-11-16) — split into this thin CLI wrapper plus tools/hermes_coder_build_common.py
# (the task corpus, prompt construction, and scoring), so the GEPA skill-optimization harness
# (HermesAgentV6 IMPLEMENTATION_PLAN.md GLM-5.3-Flash Paradigm A, Phase 1) can import the same
# logic rather than duplicating it. Pure extraction -- this file's own CLI behavior is unchanged;
# see hermes_coder_build_common.py's own changelog for the two additive changes made during the
# move (build_prompt()'s system_prompt= kwarg, call_backend()'s extra_body= kwarg), neither of
# which this file's own call sites use, so output is byte-identical to 1.0.0.
#
# 1.0.0 (2026-10-23) — S39 Phase C (FLEET_BENCHMARK_DESIGN.md S6.8), after S39a's
# sign-off, continuing directly after S6.7 (`fleet_coder_fix`). 8 real-commit build tasks (one in
# the sibling HermesAgentRedo repo), two scoring tiers never blended (S8.6): 3 of 8 tasks have a
# real executable fixture test (pure, dependency-free functions, verified against the REAL
# commit's own implementation before being written here); the other 5 are judge-only, one of them
# (`doc_to_markdown_build`) moved out of this design's own "fixture-testable" framing because this
# dev machine has neither `python-docx` nor `pymupdf4llm` installed, stated plainly below. 25
# offline checks (infra/model-benchmark/tests/test_coder_build.py).
"""
hermes-coder-build-eval.py — S39 Phase C's fleet_coder_build suite, closing
FLEET_BENCHMARK_DESIGN.md gap 8 (S6.8), after S39a's sign-off (2026-10-22). Given a plain
statement of a real requirement this fleet actually had (the operator's own stated "why," never
the "how"), can a coder-role candidate build it?

GROUND TRUTH (S8.6): all 8 real "build from scratch" commits S6.8's own table names. 7 are
reachable directly in this repo; the 8th (`botnet_intel_build`, Phase 25's
`tools/hermes_botnet_intel.py`) is in the sibling `HermesAgentRedo` repo, confirmed reachable by
ordinary cross-repo `git show` before writing anything, same precedent S6.7's own corpus already
established. Requirement text for every task is written from the real commit's own stated
motivation, never from its diff.

PROMPT CONSTRUCTION, different in kind from S6.7's fix prompts: there is no pre-existing file to
excerpt, since the whole point of a build task is that the capability didn't exist yet. The model
is shown only the requirement. For the 3 fixture-tier tasks, the requirement additionally specifies
an exact function signature to implement (taken directly from the real function's own signature,
never more) — a real interface contract, the same kind any actual requirement would come with, not
an implementation hint.

TWO SCORING TIERS, NEVER BLENDED (S8.6, same rule S6.7's own suite already applies):
  * `fixture` — the model's returned function is executed for real against a hand-built but
    REAL-FORMAT input (a real Spamhaus DROP-list excerpt, a real RSS 2.0 item, etc.) and its
    output is compared to the REAL function's own verified behavior on that exact input (every
    fixture in this file was run against the real git history version before being written down
    here, not hand-computed). Only 3 of 8 tasks have one: `botnet_intel_build`,
    `feed_reader_build`, `minecraft_admin_build` — each because the specific function tested is
    pure and dependency-free (no network, no DB, no vendor library). `doc_to_markdown_build` is
    explicitly NOT among them despite S6.8's own text calling it fixture-testable: the real
    substance of that build (`pdf_to_markdown`/`docx_to_markdown`) needs `pymupdf4llm`/
    `python-docx`, and neither is installed on this dev machine (checked, not assumed) — scored
    judge-only instead, a real environment constraint, not a design reversal.
  * `judge` — an independent judge model (never the role under test, S8.7) compares the model's
    response against the requirement and a real reference excerpt, explicitly instructed NOT to
    penalize a textual or design difference from the real implementation — "there is more than
    one reasonable way to build a feed reader" is S6.8's own stated reason, and partial credit is
    expected, not collapsed to a binary. Runs for all 8 tasks when `--judge-endpoint` is given;
    falls back to `"unjudged"` otherwise, never guessed.

`[RISK]`, named plainly, same one S6.7/S6.8 both already name: if this repo (or HermesAgentRedo)
is public, a candidate could have memorized these builds from training data. Unverified as of this
writing.

Always direct-to-backend (S8.1) for both the role under test and the judge.

Usage:
  hermes-coder-build-eval.py --endpoint http://127.0.0.1:8094/v1 \\
      [--judge-endpoint URL] [--judge-model judge] [--model-id "coder (live)"] \\
      [--task TASK_ID] [--json out.json]
"""
import argparse
import json
import sys
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import hermes_benchmark_common as bc  # noqa: E402
from hermes_coder_build_common import (  # noqa: E402
    TASKS, REPO_PATHS, strip_code_fence, load_code, real_reference, judge_prompt,
    parse_judge_verdict, call_backend, build_prompt,
)


def log(msg):
    print(f"[hermes-coder-build-eval] {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="S39 fleet_coder_build: score a coder role's "
                                              "from-scratch build against a real requirement")
    ap.add_argument("--endpoint", required=True,
                     help="the coder role's own backend URL directly, bypassing the router (S8.1)")
    ap.add_argument("--judge-endpoint", default=None,
                     help="an independent judge model's backend URL (never the role under test, "
                          "S8.7) -- without it, the judge axis is reported as unjudged")
    ap.add_argument("--judge-model", default="judge")
    ap.add_argument("--model", default="coder")
    ap.add_argument("--model-id", default="coder (live)")
    ap.add_argument("--task", default=None, help="score only this task id")
    ap.add_argument("--json", help="write per-task rows here")
    args = ap.parse_args()

    tasks = [t for t in TASKS if t["id"] == args.task] if args.task else TASKS
    log(f"{len(tasks)} task(s) against {args.endpoint}"
        + (f", judge at {args.judge_endpoint}" if args.judge_endpoint else " (no judge: judge axis unjudged)"))

    rows = []
    for task in tasks:
        has_fixture = task["fixture"] is not None
        try:
            raw = call_backend(args.endpoint, args.model,
                                build_prompt(task["path"], task["requirement"], has_fixture))
            response_text = strip_code_fence(raw)
        except (urllib.error.URLError, OSError, KeyError, IndexError) as exc:
            log(f"[{task['id']}] call failed: {exc}")
            rows.append({"task": task["id"], "status": "error", "detail": str(exc)})
            continue

        row = {"task": task["id"], "has_fixture": has_fixture, "response": response_text}

        if has_fixture:
            try:
                mod = load_code(response_text, module_name=f"_build_{task['id']}")
                task["fixture"](mod)
                row["fixture"] = {"status": "pass"}
            except AssertionError as exc:
                row["fixture"] = {"status": "fail", "detail": str(exc)}
            except Exception as exc:
                row["fixture"] = {"status": "fail", "detail": f"{type(exc).__name__}: {exc}"}

        if args.judge_endpoint:
            try:
                real_excerpt = real_reference(task)
                judge_reply = call_backend(args.judge_endpoint, args.judge_model,
                                            judge_prompt(task["requirement"], response_text, real_excerpt))
                row["judge"] = parse_judge_verdict(judge_reply)
            except (urllib.error.URLError, OSError, KeyError, IndexError, RuntimeError) as exc:
                log(f"  [{task['id']}] judge call failed: {exc}")
                row["judge"] = "unclear"
        else:
            row["judge"] = "unjudged"

        log(f"[{task['id']:<24}] fixture={row.get('fixture', {}).get('status', '-'):<8} judge={row['judge']}")
        rows.append(row)

    fixture_rows = [r for r in rows if r.get("fixture", {}).get("status") in ("pass", "fail")]
    fixture_rate = (sum(1 for r in fixture_rows if r["fixture"]["status"] == "pass") / len(fixture_rows)
                     ) if fixture_rows else None
    judge_rows = [r for r in rows if r.get("judge") in ("pass", "fail")]
    judge_rate = (sum(1 for r in judge_rows if r["judge"] == "pass") / len(judge_rows)
                   ) if judge_rows else None

    print("\n=== fleet_coder_build ===")
    if fixture_rate is not None:
        print(f"  fixture: {sum(1 for r in fixture_rows if r['fixture']['status']=='pass')}/{len(fixture_rows)} = {fixture_rate:.3f}")
    if judge_rate is not None:
        print(f"  judge:   {sum(1 for r in judge_rows if r['judge']=='pass')}/{len(judge_rows)} = {judge_rate:.3f}")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        log(f"per-task rows written to {args.json}")

    # S8.6: the two tiers are never blended into one number -- same rule, same shape as
    # fleet_coder_fix's own suites. No bare fleet_coder_build key for that reason.
    suites = {}
    if fixture_rate is not None:
        suites["fleet_coder_build_fixture"] = {"metric": "pass_rate", "value": fixture_rate,
                                                "limit": len(fixture_rows)}
    if judge_rate is not None:
        suites["fleet_coder_build_judge"] = {"metric": "pass_rate", "value": judge_rate,
                                              "limit": len(judge_rows)}
    if suites:
        try:
            bc.append_entry({
                "date": datetime.now(timezone.utc).isoformat(),
                "lm_eval_version": None, "bfcl_version": None, "swebench_version": None,
                "model_id": args.model_id, "role_or_endpoint": args.model, "endpoint": args.endpoint,
                "bfcl_model_name": None, "notes": "",
                "suites": suites,
            })
        except Exception as exc:
            log(f"shared history write failed (the report above is unaffected): {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
