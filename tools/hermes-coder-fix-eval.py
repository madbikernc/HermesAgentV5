#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-11-16) — split into this thin CLI wrapper plus tools/hermes_coder_fix_common.py
# (the task corpus, prompt construction, and scoring), so the GEPA skill-optimization harness
# (HermesAgentV6 IMPLEMENTATION_PLAN.md GLM-5.3-Flash Paradigm A, Phase 1) can import the same
# logic rather than duplicating it. Pure extraction -- this file's own CLI behavior is unchanged;
# see hermes_coder_fix_common.py's own changelog for the two additive changes made during the
# move (fix_prompt()'s system_prompt= kwarg, call_backend()'s extra_body= kwarg), neither of which
# this file's own call sites use, so output is byte-identical to 1.0.0.
#
# 1.0.0 (2026-10-23) — S39 Phase C (FLEET_BENCHMARK_DESIGN.md S6.7), after S39a's
# sign-off. New tool. 10 real-commit tasks (9 commits — one, b4651ca, contributes two distinct
# symptom-tasks, matching the design table's own 10-row listing), two scoring tiers never blended
# (S8.6), 1 of 10 tasks has a real executable repro test from this session; the other 9 are
# scored judge-only, 4 of them because this dev machine has no `node` binary at all (not just no
# live fleet access) to execute a JS repro, stated plainly below. 31 offline checks
# (infra/model-benchmark/tests/test_coder_fix.py).
"""
hermes-coder-fix-eval.py — S39 Phase C's fleet_coder_fix suite, closing FLEET_BENCHMARK_DESIGN.md
gap 7 (S6.7), after S39a's sign-off (2026-10-22). Given the REAL pre-fix state of a real file from
this fleet's own history and a symptom-only description of what broke (never the diagnosis, never
the fix), does a coder-role candidate produce a patch that actually addresses it?

GROUND TRUTH (S8.6): all 9 real commits S6.7's own table names, confirmed reachable by ordinary
`git log` directly in THIS repo — the cross-repo HermesAgentV4/HermesAgentRedo mining S6.7 flagged
as possibly necessary turned out not to be needed for this particular nine; every commit here is
local. b4651ca contributes two distinct symptom-tasks (the table itself lists it twice, for its two
independent root causes), giving 10 scored tasks from 9 commits. One correction found while
building this, not assumed: S6.7's own table lists `services/minecraft-bots/actions.js` as the
source for the `enchantments.concat` fix (35df5ec) — the real fix is in `equipment.js`
(`installEnchantsFix`), not `actions.js`; that commit touches both files, and the table named the
wrong one.

PROMPT CONSTRUCTION: the model is shown the REAL pre-fix file content (`git show <hash>^:<path>`,
never retyped) at one or more fixed line-range excerpts (hand-picked per task from this commit's
own real diff hunks, since several of these files run 1,000-7,800 lines and showing the whole file
isn't practical) plus the symptom-only report, and asked to return the corrected version of just
that excerpt. The real post-fix excerpt (`git show <hash>:<path>`) is held back from the model and
shown only to the judge.

TWO SCORING TIERS, NEVER BLENDED (S8.6, S6.7's own rule) — recorded as two separate suite keys,
never combined into one number:
  * `repro` — a real, executable behavioral test: the model's returned excerpt is substituted
    into the real pre-fix file, the reconstructed file is imported, and a repro scenario built
    from the real bug's own description is run against it. Only ONE of the 10 tasks
    (`reolink_ai_state`) is actually executable from this session: it is pure Python, and the
    functions involved (`camera_login`/`check_ai_detection`) take a duck-typed `host_obj`
    parameter, so a fake object satisfies them with zero dependency on the real (and unavailable)
    `reolink_aio` package. The other 4 tasks this design calls "repro-testable in principle"
    (`recipes_table_check`, `recipes_recycling_recipe`, `enchantments_concat`, `bed_words_routing`)
    are all JavaScript, and this dev machine has no `node` binary anywhere on it — confirmed by
    checking, not assumed — so their repro axis reports `"env_unavailable"`, a distinct, honest
    status never blended into a pass/fail rate, rather than silently skipped or faked.
  * `judge` — an independent judge model (never the role under test, S8.7) compares the model's
    returned excerpt against the real post-fix excerpt and the symptom, on the exact rubric S6.7
    states: root cause addressed, behavior-equivalent, no obvious new bug introduced — explicitly
    told NOT to penalize a textual difference from the real fix, since there is more than one
    correct patch. Runs for all 10 tasks when `--judge-endpoint` is given; falls back to
    `"unjudged"` otherwise, never guessed.

`[RISK]`, named plainly, not glossed over, same one S6.7 itself names: if this repo is public,
a candidate could have memorized these exact fixes from training data. Unverified as of this
writing.

Always direct-to-backend (S8.1) for both the role under test and the judge.

Usage:
  hermes-coder-fix-eval.py --endpoint http://127.0.0.1:8094/v1 \\
      [--judge-endpoint URL] [--judge-model judge] [--model-id "coder (live)"] \\
      [--task TASK_ID] [--json out.json]
"""
import argparse
import json
import shutil
import sys
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import hermes_benchmark_common as bc  # noqa: E402
from hermes_coder_fix_common import (  # noqa: E402
    TASKS, file_at, find_anchor_line, extract_regions, strip_code_fence, substitute_region,
    run_python_repro, judge_prompt, parse_judge_verdict, call_backend, fix_prompt,
)


def log(msg):
    print(f"[hermes-coder-fix-eval] {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="S39 fleet_coder_fix: score a coder role's patch "
                                              "against a real reported bug's real fix")
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
    node_available = shutil.which("node") is not None
    log(f"{len(tasks)} task(s) against {args.endpoint}"
        + (f", judge at {args.judge_endpoint}" if args.judge_endpoint else " (no judge: judge axis unjudged)")
        + (", node available" if node_available else ", NO node binary found on this machine"))

    rows = []
    for task in tasks:
        try:
            pre_fix_full = file_at(task["hash"], task["path"], pre_fix=True)
        except RuntimeError as exc:
            log(f"[{task['id']}] could not read pre-fix file: {exc}")
            rows.append({"task": task["id"], "status": "error", "detail": str(exc)})
            continue
        excerpt, regions = extract_regions(pre_fix_full, task["regions"])

        try:
            raw = call_backend(args.endpoint, args.model, fix_prompt(task["path"], task["symptom"], excerpt))
            patch_text = strip_code_fence(raw)
        except (urllib.error.URLError, OSError, KeyError, IndexError) as exc:
            log(f"[{task['id']}] call failed: {exc}")
            rows.append({"task": task["id"], "status": "error", "detail": str(exc)})
            continue

        row = {"task": task["id"], "tier": task["tier"], "lang": task["lang"],
               "patch": patch_text}

        # repro axis -- only ever attempted for tier=="repro" tasks
        if task["tier"] == "repro":
            if task["lang"] == "python":
                full_candidate = substitute_region(pre_fix_full, regions[0], patch_text)
                row["repro"] = run_python_repro(full_candidate, task["repro"])
            elif task["lang"] == "js":
                # No JS repro runner exists yet, regardless of node's presence: writing one that
                # this session cannot execute and verify would risk shipping it subtly broken
                # while looking done. node_available is recorded anyway so a future session knows
                # whether writing+verifying one is unblocked or still needs a different machine.
                row["repro"] = {"status": "env_unavailable",
                                "detail": f"no JS repro runner is wired up yet (node "
                                          f"{'is' if node_available else 'is NOT'} available on "
                                          f"this machine)"}

        # judge axis -- universal, every task, when a judge endpoint is given
        if args.judge_endpoint:
            try:
                real_fix_full = file_at(task["hash"], task["path"], pre_fix=False)
                real_excerpt, _ = extract_regions(real_fix_full, task["regions"])
                judge_reply = call_backend(args.judge_endpoint, args.judge_model,
                                            judge_prompt(task["symptom"], patch_text, real_excerpt))
                row["judge"] = parse_judge_verdict(judge_reply)
            except (urllib.error.URLError, OSError, KeyError, IndexError, RuntimeError) as exc:
                log(f"  [{task['id']}] judge call failed: {exc}")
                row["judge"] = "unclear"
        else:
            row["judge"] = "unjudged"

        log(f"[{task['id']:<24}] tier={task['tier']:<6} repro={row.get('repro', {}).get('status', '-'):<15} judge={row['judge']}")
        rows.append(row)

    repro_rows = [r for r in rows if r.get("repro", {}).get("status") in ("pass", "fail")]
    repro_rate = (sum(1 for r in repro_rows if r["repro"]["status"] == "pass") / len(repro_rows)
                   ) if repro_rows else None
    judge_rows = [r for r in rows if r.get("judge") in ("pass", "fail")]
    judge_rate = (sum(1 for r in judge_rows if r["judge"] == "pass") / len(judge_rows)
                   ) if judge_rows else None
    env_unavailable_n = sum(1 for r in rows if r.get("repro", {}).get("status") == "env_unavailable")

    print("\n=== fleet_coder_fix ===")
    if repro_rate is not None:
        print(f"  repro (executable): {sum(1 for r in repro_rows if r['repro']['status']=='pass')}/{len(repro_rows)} = {repro_rate:.3f}")
    if judge_rate is not None:
        print(f"  judge:               {sum(1 for r in judge_rows if r['judge']=='pass')}/{len(judge_rows)} = {judge_rate:.3f}")
    if env_unavailable_n:
        print(f"  env_unavailable:     {env_unavailable_n} task(s) -- repro axis not attempted, judge axis still scored above")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        log(f"per-task rows written to {args.json}")

    # S8.6: the two tiers are never blended into one number. No bare fleet_coder_fix key is
    # written here for that reason -- fleet_coder_fix_judge is the closest thing to "overall"
    # (it covers every task), fleet_coder_fix_repro is the smaller gold-standard subset.
    suites = {}
    if repro_rate is not None:
        suites["fleet_coder_fix_repro"] = {"metric": "pass_rate", "value": repro_rate,
                                            "limit": len(repro_rows)}
    if judge_rate is not None:
        suites["fleet_coder_fix_judge"] = {"metric": "pass_rate", "value": judge_rate,
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
