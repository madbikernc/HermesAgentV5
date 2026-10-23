#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-22) — S39 Phase B: new --gate SUITE (with --model-id as candidate, --against as
# incumbent) formalizes FLEET_BENCHMARK_DESIGN.md S9 rule 4's Tier 2 promotion gate -- prints
# PASS/FAIL/NO DATA and exits 0/1/2 so it's usable directly in a promotion script's own decision,
# not just read by a human. Reuses hermes_benchmark_common.check_tier2_gate(), generic over any
# Tier 2 suite.
"""
hermes-benchmark-compare.py — Ad hoc queries against the benchmark history
tools/hermes-benchmark-model.py writes to (tools/hermes_benchmark_common.py has the schema).
hermes-benchmark-model.py already prints a same-model trend comparison automatically after every
run; this is for the other two shapes of question: "how has this model changed across every run
it's had" and "how do these two different models compare on their latest runs" — e.g. deciding
whether a bake-off candidate is worth promoting over what a role is currently running.

Usage:
  hermes-benchmark-compare.py --model-id <label> [--n 10]
      # every recorded run for one model_id, oldest first

  hermes-benchmark-compare.py --model-id <label-a> --against <label-b>
      # each model's latest run, side by side
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_benchmark_common as bc  # noqa: E402


def print_trend(history: list, model_id: str, n: int):
    runs = [e for e in history if e.get("model_id") == model_id][-n:]
    if not runs:
        print(f"No recorded runs for model_id={model_id!r}")
        return
    print(f"=== {model_id} — last {len(runs)} run(s) ===")
    for run in runs:
        print(f"\n{run.get('date')}  role={run.get('role_or_endpoint')}  "
              f"lm_eval={run.get('lm_eval_version')}")
        if run.get("notes"):
            print(f"  notes: {run['notes']}")
        for suite in bc.ALL_SUITES:
            r = run.get("suites", {}).get(suite, {})
            if "value" in r and r["value"] is not None:
                print(f"  {suite:14s} {r.get('metric', '?')}={r['value']}")
            elif r.get("status") == "error":
                print(f"  {suite:14s} ERROR")


def print_gate(history: list, candidate_id: str, incumbent_id: str, suite: str) -> int:
    """S39 Phase B: FLEET_BENCHMARK_DESIGN.md S9 rule 4's Tier 2 gate, formalized -- "a candidate
    that clears Tier 1 but regresses Tier 2 does not get promoted on Tier 1's strength alone."
    Returns a process exit code (0 pass, 1 fail, 2 no-data) so this is usable in a script's own
    promotion decision, not just read by a human."""
    result = bc.check_tier2_gate(history, candidate_id, incumbent_id, suite)
    print(f"=== Tier 2 gate: {suite} ===")
    print(f"  candidate ({candidate_id}): {result['candidate_value']!r}")
    print(f"  incumbent ({incumbent_id}): {result['incumbent_value']!r}")
    if result["verdict"] == "no-data":
        print("  VERDICT: NO DATA -- at least one model has no recorded run for this suite yet. "
              "This is not a pass: the gate has not actually been checked.")
        return 2
    if result["verdict"] == "fail":
        print("  VERDICT: FAIL -- candidate regresses this Tier 2 suite. Per S9 rule 4, this "
              "blocks promotion regardless of any Tier 1 result, and is never averaged away.")
        return 1
    print("  VERDICT: PASS -- candidate does not regress this Tier 2 suite.")
    return 0


def print_side_by_side(history: list, model_a: str, model_b: str):
    # "9999" sorts after any real ISO-8601 date, so this is just "the latest recorded run" —
    # most_recent_prior() already does the model_id filter + take-last-by-date we need here.
    latest_a = bc.most_recent_prior(history, model_a, before_date="9999")
    latest_b = bc.most_recent_prior(history, model_b, before_date="9999")
    if latest_a is None:
        print(f"No recorded runs for model_id={model_a!r}")
        return
    if latest_b is None:
        print(f"No recorded runs for model_id={model_b!r}")
        return
    print(f"=== {model_a} ({latest_a['date']}) vs. {model_b} ({latest_b['date']}) ===")
    for suite in bc.ALL_SUITES:
        va = latest_a.get("suites", {}).get(suite, {}).get("value")
        vb = latest_b.get("suites", {}).get(suite, {}).get("value")
        if va is None or vb is None:
            print(f"  {suite:14s} {model_a}={va!r:>10}  {model_b}={vb!r:>10}")
            continue
        delta = va - vb
        arrow = "▲" if delta > 0 else ("▼" if delta < 0 else "=")
        print(f"  {suite:14s} {model_a}={va:.4f}  {model_b}={vb:.4f}  delta={delta:+.4f} {arrow}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Query recorded benchmark history")
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--against", default=None, help="a second model_id to compare the "
                                                          "first one's latest run against")
    parser.add_argument("--n", type=int, default=10, help="how many recent runs to show "
                                                            "(trend mode only, default 10)")
    parser.add_argument("--gate", default=None, metavar="SUITE",
                         help="S39 Phase B: check whether --model-id (the candidate) regresses "
                              "--against (the incumbent) on this Tier 2 suite (e.g. fleet_guard). "
                              "Prints PASS/FAIL/NO DATA and exits 0/1/2 accordingly, per "
                              "FLEET_BENCHMARK_DESIGN.md S9 rule 4 -- a Tier 2 regression blocks "
                              "promotion regardless of any Tier 1 result.")
    args = parser.parse_args()

    history = bc.load_history()
    if args.gate:
        if not args.against:
            parser.error("--gate needs --against <incumbent model_id>")
        return print_gate(history, args.model_id, args.against, args.gate)
    if args.against:
        print_side_by_side(history, args.model_id, args.against)
    else:
        print_trend(history, args.model_id, args.n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
