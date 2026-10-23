#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase A (FLEET_BENCHMARK_DESIGN.md S7, after S39a's sign-off 2026-10-22):
# the shared-history adapters added to hermes-rag-eval.py, hermes-bakeoff-typesafe.py, and
# hermes-guard-eval.py, plus hermes_benchmark_common.py's ALL_SUITES/TIER0_SUITES split. No
# network, no live backends, no fleet node -- every adapter writes to a temp history file, and
# each tool's own real-service dependency (hermes_rag_common's sqlite-vec connection, the guard
# service, the TypeSafe/dispatch/rerank backends) is never exercised, only the pure
# result-list -> history-entry logic each adapter adds around it.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * ALL_SUITES vs. TIER0_SUITES: the real validation-gap found while extending ALL_SUITES for
#     the shared schema -- hermes-benchmark-model.py's dispatch is a hardcoded per-suite branch
#     sequence, not a generic lookup, so validating --suites against the newly-widened ALL_SUITES
#     would have let a fleet_* suite name pass validation and then silently do nothing
#   * each adapter writes the right suite key(s) with the right accuracy, under the right
#     role_or_endpoint, and never when the task(s) it depends on didn't run
#   * hermes-guard-eval.py's opt-in discipline specifically: silent no-op (with a log line) if the
#     COMPOSITE gate isn't present, and refuses --record-history with --no-layer2 at the CLI level
#
# Run: python3 infra/model-benchmark/tests/test_schema_unification.py
import importlib.util
import os
import sys
import tempfile
import types
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


def load(name, filename, stub_siblings=None):
    """Loads a hyphenated tool by path, same idiom test_model_scout.py already uses. Optionally
    pre-registers stub sibling modules in sys.modules first, so a tool that imports something
    needing a venv this test doesn't have (sqlite-vec) can still be loaded and exercised for its
    own pure logic."""
    if stub_siblings:
        for mod_name, attrs in stub_siblings.items():
            stub = types.ModuleType(mod_name)
            for k, v in attrs.items():
                setattr(stub, k, v)
            sys.modules[mod_name] = stub
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def redirect_history(mod, tmp):
    """Points this already-loaded tool's own hermes_benchmark_common reference at a temp-only
    history file, so no check below can ever touch a real NAS2 mount or local state file."""
    mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
    mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
    return mod.bc.LOCAL_HISTORY_PATH


def read_entries(path):
    if not path.exists() or not path.read_text().strip():
        return []
    import json
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def check_all_suites_split(bc):
    print("\n[ALL_SUITES vs. TIER0_SUITES -- the real validation gap]")
    check("TIER0_SUITES is exactly the original five",
          bc.TIER0_SUITES == ["mmlu_pro", "gpqa_diamond", "ifeval", "bfcl", "swebench"],
          str(bc.TIER0_SUITES))
    check("ALL_SUITES is a strict superset of TIER0_SUITES",
          set(bc.TIER0_SUITES) <= set(bc.ALL_SUITES))
    for name in ("fleet_dispatch_routing", "fleet_mc_intent", "fleet_rag_recall", "fleet_guard",
                 "fleet_coder_fix", "fleet_coder_build"):
        check(f"{name!r} is in ALL_SUITES but not TIER0_SUITES",
              name in bc.ALL_SUITES and name not in bc.TIER0_SUITES)

    hbm = load("hermes_benchmark_model_svalidate", "hermes-benchmark-model.py")
    # Exercise the real validation line directly rather than re-deriving the logic here.
    sys.argv = ["hermes-benchmark-model.py", "--model-id", "x", "--role", "dispatch",
                "--suites", "fleet_coder_fix"]
    try:
        hbm.main()
        check("a fleet_* suite is rejected by hermes-benchmark-model.py's own --suites validation",
              False, "-- main() did not raise/exit")
    except SystemExit as exc:
        check("a fleet_* suite is rejected by hermes-benchmark-model.py's own --suites validation",
              exc.code != 0, f"exit code {exc.code}")


def check_rag_eval_adapter():
    print("\n[hermes-rag-eval.py: record_shared_history()]")
    stub_rc = {"sanitize_llm_input": lambda *a, **k: "", "router_chat": lambda *a, **k: "",
               "connect": lambda *a, **k: None, "search": lambda *a, **k: []}
    mod = load("hermes_rag_eval_test", "hermes-rag-eval.py",
               stub_siblings={"hermes_rag_common": stub_rc})
    with tempfile.TemporaryDirectory() as tmp:
        hist = redirect_history(mod, tmp)
        mod.record_shared_history("rag (test)", 5, 0.812)
        entries = read_entries(hist)
        check("exactly one entry written", len(entries) == 1, str(entries))
        e = entries[0]
        check("role_or_endpoint is 'rag'", e.get("role_or_endpoint") == "rag")
        check("model_id is carried through", e.get("model_id") == "rag (test)")
        check("fleet_rag_recall carries the right metric/value/limit",
              e["suites"].get("fleet_rag_recall") == {"metric": "recall@5", "value": 0.812, "limit": 5},
              str(e["suites"]))


def check_bakeoff_adapter():
    print("\n[hermes-bakeoff-typesafe.py: record_shared_history()]")
    mod = load("hermes_bakeoff_typesafe_test", "hermes-bakeoff-typesafe.py")
    with tempfile.TemporaryDirectory() as tmp:
        hist = redirect_history(mod, tmp)
        results = [
            {"task": "dispatch", "input": "a", "gold": "x", "local": "x"},
            {"task": "dispatch", "input": "b", "gold": "y", "local": "y"},
            {"task": "dispatch", "input": "c", "gold": "z", "local": "q"},
            {"task": "mcintent", "input": "d", "gold": "GOTO", "local": "GOTO"},
        ]
        mod.record_shared_history(results, "dispatch (test)")
        entries = read_entries(hist)
        check("exactly one entry written for a mixed dispatch+mcintent run",
              len(entries) == 1, str(entries))
        suites = entries[0]["suites"]
        check("fleet_dispatch_routing accuracy is 2/3",
              abs(suites["fleet_dispatch_routing"]["value"] - (2 / 3)) < 1e-9, str(suites))
        check("fleet_mc_intent accuracy is 1/1",
              suites["fleet_mc_intent"]["value"] == 1.0, str(suites))

        hist.write_text("")
        mod.record_shared_history([{"task": "camera", "input": "x", "gold": 1}], "should-not-appear")
        check("a run with neither dispatch nor mcintent writes nothing at all",
              read_entries(hist) == [])


def check_guard_eval_adapter():
    print("\n[hermes-guard-eval.py: record_shared_history() and its CLI gate]")
    mod = load("hermes_guard_eval_test", "hermes-guard-eval.py")
    with tempfile.TemporaryDirectory() as tmp:
        hist = redirect_history(mod, tmp)
        golds = [1, 1, 0, 0]
        gates = [
            ("Layer 1 alone (role=user, block)", [True, False, False, False]),
            ("COMPOSITE (L1 tool block OR L2)", [True, True, False, False]),
        ]
        mod.record_shared_history(gates, golds, "guard (test)")
        entries = read_entries(hist)
        check("exactly one entry written", len(entries) == 1, str(entries))
        e = entries[0]
        check("role_or_endpoint is 'guard'", e.get("role_or_endpoint") == "guard")
        check("fleet_guard composite accuracy is 1.0 (4/4 correct in this fixture)",
              e["suites"].get("fleet_guard", {}).get("value") == 1.0, str(e["suites"]))

        hist.write_text("")
        mod.record_shared_history([("Layer 1 alone", [True, False, False, False])], golds, "x")
        check("a missing COMPOSITE gate writes nothing, rather than guessing a different gate",
              read_entries(hist) == [])

    import subprocess
    proc = subprocess.run(
        [sys.executable, str(TOOLS / "hermes-guard-eval.py"), "--no-layer2", "--record-history"],
        capture_output=True, text=True, timeout=30)
    check("--record-history with --no-layer2 is refused at the CLI level, not left to crash later",
          proc.returncode != 0 and "--record-history needs Layer 2" in proc.stderr,
          f"rc={proc.returncode} stderr={proc.stderr[-300:]!r}")


def main():
    import hermes_benchmark_common as bc
    check_all_suites_split(bc)
    check_rag_eval_adapter()
    check_bakeoff_adapter()
    check_guard_eval_adapter()

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
