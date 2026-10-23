#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase B's formal Tier 2 promotion gate (FLEET_BENCHMARK_DESIGN.md S9
# rule 4, after S39a's sign-off 2026-10-22): hermes_benchmark_common.check_tier2_gate() and
# hermes-benchmark-compare.py's --gate CLI mode. No network, no live backends -- every check
# writes synthetic history entries to a temp file and reads them back.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * pass/fail/no-data verdicts, including the "no tolerance band" rule (any regression at all
#     fails, even a tiny one) and that missing data is its own verdict, never a silent pass
#   * check_tier2_gate() is generic over suite name, not hardcoded to fleet_guard
#   * print_gate()'s exit codes (0/1/2), since a promotion script would branch on those directly
#   * --gate without --against is a clear CLI error, not a crash
#
# Run: python3 infra/model-benchmark/tests/test_promotion_gate.py
import importlib.util
import sys
import tempfile
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


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def seed(bc, tmp, entries):
    bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
    bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
    for e in entries:
        bc.append_entry(e)
    return bc.load_history()


def entry(model_id, suite, value, date):
    return {"date": date, "lm_eval_version": None, "bfcl_version": None, "swebench_version": None,
            "model_id": model_id, "role_or_endpoint": "guard", "endpoint": None,
            "bfcl_model_name": None, "notes": "",
            "suites": {suite: {"metric": "composite_accuracy", "value": value, "limit": None}}}


def main():
    import hermes_benchmark_common as bc

    print("\n[check_tier2_gate(): pass/fail/no-data, no tolerance band]")
    with tempfile.TemporaryDirectory() as tmp:
        hist = seed(bc, tmp, [
            entry("incumbent", "fleet_guard", 0.900, "2026-10-01T00:00:00+00:00"),
            entry("candidate-better", "fleet_guard", 0.950, "2026-10-02T00:00:00+00:00"),
            entry("candidate-equal", "fleet_guard", 0.900, "2026-10-02T00:00:00+00:00"),
            entry("candidate-worse", "fleet_guard", 0.899, "2026-10-02T00:00:00+00:00"),
        ])
        check("strictly better than incumbent passes",
              bc.check_tier2_gate(hist, "candidate-better", "incumbent")["verdict"] == "pass")
        check("exactly equal to incumbent passes (>=, not >)",
              bc.check_tier2_gate(hist, "candidate-equal", "incumbent")["verdict"] == "pass")
        check("even a tiny regression (0.001) fails -- no tolerance band",
              bc.check_tier2_gate(hist, "candidate-worse", "incumbent")["verdict"] == "fail")
        check("a candidate with no recorded run at all is 'no-data', never a silent pass",
              bc.check_tier2_gate(hist, "never-measured", "incumbent")["verdict"] == "no-data")
        check("an incumbent with no recorded run is also 'no-data'",
              bc.check_tier2_gate(hist, "candidate-better", "never-measured")["verdict"] == "no-data")

        result = bc.check_tier2_gate(hist, "candidate-worse", "incumbent")
        check("the result carries both real values for a human to read, not just the verdict",
              result["candidate_value"] == 0.899 and result["incumbent_value"] == 0.900, str(result))

    print("\n[check_tier2_gate() is generic over suite name]")
    with tempfile.TemporaryDirectory() as tmp:
        hist = seed(bc, tmp, [
            entry("incumbent", "vulnhunter", 0.70, "2026-10-01T00:00:00+00:00"),
            entry("candidate", "vulnhunter", 0.60, "2026-10-02T00:00:00+00:00"),
        ])
        check("a non-fleet_guard Tier 2 suite (e.g. S28's vulnhunter) works the same way",
              bc.check_tier2_gate(hist, "candidate", "incumbent", suite="vulnhunter")["verdict"] == "fail")

    print("\n[hermes-benchmark-compare.py: --gate exit codes]")
    cmp_mod = load("hermes_benchmark_compare_test", "hermes-benchmark-compare.py")
    with tempfile.TemporaryDirectory() as tmp:
        hist = seed(cmp_mod.bc, tmp, [
            entry("incumbent", "fleet_guard", 0.900, "2026-10-01T00:00:00+00:00"),
            entry("candidate-better", "fleet_guard", 0.950, "2026-10-02T00:00:00+00:00"),
            entry("candidate-worse", "fleet_guard", 0.800, "2026-10-02T00:00:00+00:00"),
        ])
        check("print_gate() exits 0 on pass",
              cmp_mod.print_gate(hist, "candidate-better", "incumbent", "fleet_guard") == 0)
        check("print_gate() exits 1 on fail",
              cmp_mod.print_gate(hist, "candidate-worse", "incumbent", "fleet_guard") == 1)
        check("print_gate() exits 2 on no-data",
              cmp_mod.print_gate(hist, "never-measured", "incumbent", "fleet_guard") == 2)

    print("\n[hermes-benchmark-compare.py: --gate requires --against]")
    sys.argv = ["hermes-benchmark-compare.py", "--model-id", "x", "--gate", "fleet_guard"]
    try:
        cmp_mod.main()
        check("--gate without --against is a CLI error, not a silent no-op", False,
              "-- main() did not raise/exit")
    except SystemExit as exc:
        check("--gate without --against is a CLI error, not a silent no-op", exc.code != 0)

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
