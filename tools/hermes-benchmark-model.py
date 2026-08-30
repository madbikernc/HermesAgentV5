#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 — real fixes from a live verification pass on spark, 2026-08-24 (venv actually installed,
# every suite actually invoked against real backends, not just read). BFCL: replaced a wrong guess
# (a plain --base-url flag that doesn't exist) with the verified real mechanism — see
# hermes_benchmark_common.py's run_bfcl() docstring — which needs two new parameters below since
# BFCL can't go through hermes-router at all (confirmed: router lacks /v1/completions, which BFCL's
# OSS handler requires, and rejects BFCL's outgoing "model" field, which isn't one of the router's
# five role names). SWE-bench: confirmed x86_64 Docker images don't run on this hardware out of the
# box (no binfmt_misc emulation) — now fails fast with a clear reason via a pre-flight check,
# instead of grinding through predictions generation first. Also found and fixed a real bfcl-eval
# packaging gap: its CLI unconditionally imports a Qwen handler needing `soundfile`, an undeclared
# dependency — added to infra/model-benchmark/README.md's install line.
"""
hermes-benchmark-model.py — Runs MMLU-Pro, GPQA Diamond, IFEval, BFCL, and SWE-bench Verified
against real fleet backends (a live role via hermes-router for the first three, or a role's own
llama-server port directly for BFCL — see below) or a temporary llama-server for an unpromoted
candidate (tools/hermes-benchmark-model.sh), records the result to shared history, and prints a
comparison against this model_id's most recent prior run. See infra/model-benchmark/README.md for
the one-time venv install; MMLU-Pro/GPQA-Diamond/IFEval/BFCL are now verified live, SWE-bench is
confirmed blocked on this hardware without extra Docker emulation setup (§4).

Not invoked directly by a persona — tools/hermes-benchmark-model.sh is the operator-facing entry
point (skills/model-benchmark/SKILL.md), same layering as hermes-abliterate-model.sh /
hermes-finetune-model.sh over their own underlying scripts.

Usage:
  hermes-benchmark-model.py --model-id <label> --role <role-or-endpoint-alias> \\
      --endpoint http://127.0.0.1:8080/v1 [--suites mmlu_pro,gpqa_diamond,ifeval,bfcl,swebench] \\
      [--limit N] [--notes "..."] [-- <extra lm_eval args>]

  --model-id      Required. The thing being scored, as a real identity — an HF repo ID for a
                  fleet role's current backend, or the candidate model's own HF/local identity.
                  Not auto-detected: hermes-router has no weight-introspection endpoint, so this
                  must be supplied by the operator (same "identity is a human judgment call, not
                  inferred" discipline hermes-model-archive.py 1.2.0 established for its own
                  hf_id/role rename).
  --role          Required. The "model" field value sent in each request — a fleet role name
                  (nano/super/coder/muse/omni) when benchmarking a live backend, or any label when
                  benchmarking a temporary candidate server (the server only ever hosts one model,
                  so the value is cosmetic there).
  --bfcl-model-name   Required if "bfcl" is in --suites. A name from `bfcl models` (e.g.
                  "Qwen/Qwen3-4B-Instruct-2507-FC") closest to the real backend's architecture —
                  drives BFCL's prompt-formatting/tool-schema choice, not just a label. No exact
                  match exists for this fleet's actual checkpoints; treat the score as an
                  approximation, not a clean number (hermes_benchmark_common.py's run_bfcl()).
  --bfcl-endpoint     The role's own llama-server URL directly (e.g. http://127.0.0.1:8088/v1 for
                  nano on spark) — required in role mode when "bfcl" is in --suites, since BFCL
                  can't go through hermes-router (see run_bfcl()'s docstring for why). Defaults to
                  --endpoint, which is correct as-is in candidate mode (already a direct URL).
  --bfcl-test-category   Passed to both `bfcl generate`/`evaluate`. Default "all" runs BFCL's full
                  suite including multi-turn categories — expect this to take a while; narrow it
                  (e.g. "simple_python") for a smoke test.
"""
import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_benchmark_common as bc  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Run MMLU-Pro/GPQA-Diamond/IFEval/BFCL/SWE-bench "
                                                   "against a fleet backend or candidate endpoint")
    parser.add_argument("--model-id", required=True, help="real model identity for the history record "
                                                            "(HF repo ID or similarly specific label)")
    parser.add_argument("--role", required=True, help="'model' field value sent to the endpoint")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8080/v1",
                         help="OpenAI-compatible base URL, no trailing /chat/completions "
                              "(default: this node's hermes-router)")
    parser.add_argument("--suites", default=",".join(bc.DEFAULT_SUITES),
                         help=f"comma-separated subset of {bc.ALL_SUITES} (default excludes "
                              "swebench — confirmed blocked on this hardware, README §4)")
    parser.add_argument("--limit", type=int, default=None,
                         help="sample limit per suite — use a small number for a smoke test "
                              "before committing to a full run")
    parser.add_argument("--notes", default="", help="free-text note stored with this run")
    parser.add_argument("--bfcl-model-name", default=None,
                         help="a name from `bfcl models` closest to the real backend's "
                              "architecture — required if 'bfcl' is in --suites")
    parser.add_argument("--bfcl-endpoint", default=None,
                         help="the role's own llama-server URL directly, not hermes-router "
                              "(defaults to --endpoint, which is only correct in candidate mode)")
    parser.add_argument("--bfcl-test-category", default="all",
                         help="passed to bfcl generate/evaluate (default: all)")
    parser.add_argument("extra_args", nargs=argparse.REMAINDER,
                         help="passed through to lm_eval after '--'")
    args = parser.parse_args()

    suites = [s.strip() for s in args.suites.split(",") if s.strip()]
    unknown = set(suites) - set(bc.ALL_SUITES)
    if unknown:
        parser.error(f"unknown suite(s): {sorted(unknown)} — expected a subset of {bc.ALL_SUITES}")
    if "bfcl" in suites and not args.bfcl_model_name:
        parser.error("--bfcl-model-name is required when 'bfcl' is in --suites — see `bfcl models` "
                     "for the registry, and this script's own docstring for why it can't be inferred")

    extra_args = args.extra_args[1:] if args.extra_args[:1] == ["--"] else args.extra_args
    chat_url = args.endpoint.rstrip("/") + "/chat/completions"
    bfcl_endpoint = (args.bfcl_endpoint or args.endpoint).rstrip("/")

    results = {}
    if "mmlu_pro" in suites:
        results["mmlu_pro"] = bc.run_lm_eval_task(bc.MMLU_PRO_TASK, args.role, chat_url, args.limit, extra_args)
    if "gpqa_diamond" in suites:
        results["gpqa_diamond"] = bc.run_lm_eval_task(bc.GPQA_DIAMOND_TASK, args.role, chat_url, args.limit, extra_args)
    if "ifeval" in suites:
        results["ifeval"] = bc.run_lm_eval_task(bc.IFEVAL_TASK, args.role, chat_url, args.limit, extra_args)
    if "bfcl" in suites:
        results["bfcl"] = bc.run_bfcl(args.bfcl_model_name, bfcl_endpoint, args.bfcl_test_category, extra_args)
    if "swebench" in suites:
        results["swebench"] = bc.run_swebench(args.role, chat_url, args.limit, extra_args)

    entry = {
        "date": datetime.now(timezone.utc).isoformat(),
        "lm_eval_version": bc.lm_eval_version(),
        "bfcl_version": bc.bfcl_version() if "bfcl" in suites else None,
        "swebench_version": bc.swebench_version() if "swebench" in suites else None,
        "model_id": args.model_id,
        "role_or_endpoint": args.role,
        "endpoint": args.endpoint,
        "bfcl_model_name": args.bfcl_model_name,
        "notes": args.notes,
        "suites": results,
    }

    print("\n=== Results ===")
    for suite, r in results.items():
        if "value" in r and r["value"] is not None:
            print(f"  {suite:14s} {r.get('metric', '?')}={r['value']}")
        elif r.get("status") == "error":
            print(f"  {suite:14s} ERROR: {r.get('detail', '(no detail)')[:300]}")
        else:
            print(f"  {suite:14s} {r}")

    history = bc.load_history()
    prior = bc.most_recent_prior(history, args.model_id, before_date=entry["date"])
    written_to = bc.append_entry(entry)

    print(f"\nRecorded to {written_to}")
    print("\n=== Comparison vs. prior run ===")
    print(bc.format_comparison(entry, prior))

    any_error = any(r.get("status") == "error" for r in results.values())
    return 1 if any_error else 0


if __name__ == "__main__":
    sys.exit(main())
