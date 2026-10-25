#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for hermes_benchmark_common.is_promising() (new in bc 1.4.0, 2026-10-25): the
# deterministic "is this model-scout candidate worth a benchmark run" heuristic shared by
# hermes-model-scout.py (stamps it onto a candidate's turn at proposal time) and
# hermes-fleetops-ui.py (falls back to computing it live, by this exact function, for a
# candidate proposed before that field existed). No network, no state -- every check calls the
# function directly against a synthetic candidate dict.
#
# Run: python3 infra/model-benchmark/tests/test_is_promising.py
import sys
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


COMFORTABLE = "~9GB Q4 (dense) — fits alongside current backends"
TIGHT = "~30GB Q4 (dense) — fits only if a non-Core backend is freed first"
TOO_LARGE = "~90GB Q4 (dense) — too large for Spark's ~60GB usable ceiling"
UNKNOWN = "size unknown (no safetensors metadata) — check manually"
BAD_ARCH = COMFORTABLE + " — WARNING: architecture 'qwen4exp' is one this fleet's llama.cpp has failed to load before"


def main():
    import hermes_benchmark_common as bc

    print("\n[is_promising(): the disqualifying facts, checked before anything else]")
    promising, reason = bc.is_promising({"category": "architecture", "fit": "n/a"})
    check("an architecture/loader finding is never promising, regardless of fit",
          promising is False, reason)

    promising, reason = bc.is_promising(
        {"category": "coding", "fit": TOO_LARGE, "gguf_repo": "x",
         "publisher_claim": {"model_index_present": True}})
    check("'too large' in the fit string disqualifies even with a GGUF build and a claim",
          promising is False, reason)

    promising, reason = bc.is_promising(
        {"category": "coding", "fit": BAD_ARCH, "gguf_repo": "x",
         "publisher_claim": {"model_index_present": True}})
    check("a known-unloadable-architecture warning disqualifies too",
          promising is False, reason)

    promising, reason = bc.is_promising(
        {"category": "coding", "fit": COMFORTABLE, "gguf_repo": None})
    check("no GGUF build at all disqualifies a comfortable fit",
          promising is False, reason)
    check("and says why", "GGUF" in reason, reason)

    print("\n[is_promising(): the positive cases]")
    promising, reason = bc.is_promising(
        {"category": "coding", "fit": COMFORTABLE, "gguf_repo": "x",
         "publisher_claim": {"model_index_present": True}})
    check("comfortable fit + GGUF + a publisher claim is promising",
          promising is True, reason)

    promising, reason = bc.is_promising(
        {"category": "coding", "fit": COMFORTABLE, "gguf_repo": "x",
         "publisher_claim": {"model_index_present": False}})
    check("comfortable fit + GGUF alone is still promising, with no claim needed",
          promising is True, reason)

    promising, reason = bc.is_promising(
        {"category": "coding", "fit": TIGHT, "gguf_repo": "x",
         "publisher_claim": {"model_index_present": True}})
    check("a tight fit is still promising if the publisher published formal eval numbers",
          promising is True, reason)

    print("\n[is_promising(): the negative-but-not-disqualified case]")
    promising, reason = bc.is_promising(
        {"category": "coding", "fit": TIGHT, "gguf_repo": "x",
         "publisher_claim": {"model_index_present": False}})
    check("a tight/uncertain fit with no publisher claim is not promising, but not disqualified",
          promising is False, reason)

    promising, reason = bc.is_promising(
        {"category": "coding", "fit": UNKNOWN, "gguf_repo": "x",
         "publisher_claim": {"model_index_present": False}})
    check("an unknown size with no publisher claim is not promising either",
          promising is False, reason)

    print("\n[is_promising(): missing keys degrade honestly rather than raising]")
    promising, reason = bc.is_promising({})
    check("an empty dict is not promising (no GGUF, no fit) and does not raise",
          promising is False, bool(reason))

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
