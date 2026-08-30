#!/usr/bin/env python3
# Version: 1.0.0
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
    args = parser.parse_args()

    history = bc.load_history()
    if args.against:
        print_side_by_side(history, args.model_id, args.against)
    else:
        print_trend(history, args.model_id, args.n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
