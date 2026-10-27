#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for hermes_benchmark_common.same_core_identity()/extract_quant_code()/
# quant_compatible()/find_similar_known() (new in bc 1.6.0, 2026-10-27, S46): "is this new
# model-scout candidate confidently the same underlying model, at a compatible quantization, as
# something already decided or already benchmarked" — the check hermes-model-scout.py's propose()
# uses to default a confident match straight to `deferred` instead of `proposed`. No network, no
# state — every check calls the functions directly against real identity strings pulled from this
# fleet's own data (infra/model-watch/alert-state.json's seeded GLM-5.3-Flash list; the
# "NousResearch Hermes-4.3-36B-Q4_K_M" benchmark-history label shape).
#
# Run: python3 infra/model-benchmark/tests/test_similar_known.py
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


def main():
    import hermes_benchmark_common as bc

    print("\n[same_core_identity(): real re-hosted/re-quantized conversions of one checkpoint]")
    base = "zai-org/GLM-5.3-Flash"
    for variant in (
        "unsloth/GLM-5.3-Flash-GGUF",
        "AtomicChat/GLM-5.3-Flash-GGUF",
        "avar6/GLM-5.3-Flash-BF16-gguf",
        "LibertAIDAI/GLM-5.3-Flash-NVFP4",
    ):
        check(f"{variant!r} matches the base checkpoint",
              bc.same_core_identity(base, variant), variant)

    print("\n[same_core_identity(): the two cases that must NOT collapse]")
    check("a model missing '-Flash' is a different model, not a quant variant",
          not bc.same_core_identity(base, "unsloth/GLM-5.3-GGUF"))
    check("an unstripped behavior-changing tag (DERISKED) breaks the match",
          not bc.same_core_identity(base, "Blackfrost-AI/GLM-5.3-Flash-DERISKED-GGUF"))
    check("abliterated is never treated as packaging noise",
          not bc.same_core_identity("org/Model-Name", "org2/Model-Name-abliterated"))

    print("\n[same_core_identity(): a free-text benchmark-history label naming its source org]")
    check("an org-prefixed label (no slash) still matches scout's own org/repo id",
          bc.same_core_identity("NousResearch/Hermes-4.3-36B",
                                 "NousResearch Hermes-4.3-36B-Q4_K_M"))
    check("a bare history label with no org at all still matches on core name alone",
          bc.same_core_identity("zai-org/GLM-4.7-Flash", "GLM-4.7-Flash-Q4_K_M"))

    print("\n[same_core_identity(): degrades honestly rather than raising]")
    check("an empty string on either side is never a match",
          not bc.same_core_identity("", "org/Model") and not bc.same_core_identity("org/Model", ""))
    check("two unrelated models don't match", not bc.same_core_identity(
        "org/Model-A", "other-org/Totally-Different-Model"))

    print("\n[extract_quant_code() / quant_compatible()]")
    check("Q4_K_M is extracted as one code, not fragmented",
          bc.extract_quant_code("Model-Q4_K_M.gguf") == "Q4_K_M")
    check("Q8_0 likewise", bc.extract_quant_code("org/Model-Q8_0-GGUF") == "Q8_0")
    check("BF16 is recognized", bc.extract_quant_code("org/Model-BF16-gguf") == "BF16")
    check("a string with no quant code names none", bc.extract_quant_code("org/Model") is None)
    check("neither side naming a quant code is compatible (the common case)",
          bc.quant_compatible("org/Model", "org2/Model-GGUF"))
    check("the identical explicit code is compatible",
          bc.quant_compatible("org/Model-Q4_K_M", "org2/Model-Q4_K_M-GGUF"))
    check("two DIFFERENT explicit codes are not compatible — left for a real benchmark run",
          not bc.quant_compatible("org/Model-Q4_K_M", "org2/Model-Q8_0-GGUF"))

    print("\n[find_similar_known(): tiering, against a candidate dict shaped like propose() builds]")
    known_rejected = [{"task_id": "scout:coder:x", "state": "rejected",
                        "model_id": "zai-org/GLM-5.3-Flash", "gguf_repo": None, "base_model": None}]
    rec = {"model_id": "unsloth/GLM-5.3-Flash-GGUF", "gguf_repo": "unsloth/GLM-5.3-Flash-GGUF",
           "publisher_claim": {"base_model": "zai-org/GLM-5.3-Flash"}}
    matched, reason, similar_to = bc.find_similar_known(rec, known_rejected, [])
    check("a publisher-declared base_model match fires (tier 1)", matched is True, reason)
    check("the reason names the matched state", "already-rejected" in reason, reason)
    check("similar_to names the real matched identity", similar_to == "zai-org/GLM-5.3-Flash")

    print("\n[find_similar_known(): a multi-base merge checks every declared base]")
    rec_merge = {"model_id": "org/Frankenmerge",
                 "publisher_claim": {"base_model": "org/Unrelated-A, zai-org/GLM-5.3-Flash"}}
    matched, reason, _ = bc.find_similar_known(rec_merge, known_rejected, [])
    check("a match on the SECOND declared base model still fires", matched is True, reason)

    print("\n[find_similar_known(): core-name match with no base_model on either side (tier 3)]")
    known_no_base = [{"task_id": "scout:coder:y", "state": "deferred",
                       "model_id": "AtomicChat/GLM-5.3-Flash-GGUF", "gguf_repo": None,
                       "base_model": None}]
    rec_bare = {"model_id": "avar6/GLM-5.3-Flash-BF16-gguf", "gguf_repo": None,
                "publisher_claim": {}}
    matched, reason, similar_to = bc.find_similar_known(rec_bare, known_no_base, [])
    check("a bare core-name match fires without any base_model signal", matched is True, reason)
    check("and names the core-name-match tier", "core-name match" in reason, reason)

    print("\n[find_similar_known(): against benchmark history, not just the backlog]")
    history = [{"model_id": "GLM-4.7-Flash-Q4_K_M",
                "date": "2026-10-20T00:00:00+00:00"}]
    rec_hist = {"model_id": "someorg/GLM-4.7-Flash-GGUF", "gguf_repo": None,
                "publisher_claim": {}}
    matched, reason, similar_to = bc.find_similar_known(rec_hist, [], history)
    check("a match against a prior benchmark result fires", matched is True, reason)
    check("and says it was a prior benchmark result, not a backlog decision",
          "prior benchmark result" in reason, reason)
    check("similar_to names the history label", similar_to == "GLM-4.7-Flash-Q4_K_M")

    print("\n[find_similar_known(): no confident match -> leave it alone, never a guess]")
    matched, reason, similar_to = bc.find_similar_known(
        {"model_id": "org/Genuinely-New-Model", "gguf_repo": None, "publisher_claim": {}},
        known_rejected, history)
    check("nothing confident found returns a clean negative, not a weak guess",
          matched is False and reason == "" and similar_to is None,
          (matched, reason, similar_to))
    check("an empty known/history list never raises", bc.find_similar_known(
        {"model_id": "org/X", "gguf_repo": None, "publisher_claim": {}}, [], [])[0] is False)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
