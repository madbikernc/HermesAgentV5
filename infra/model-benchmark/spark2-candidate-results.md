# spark2 Staged-Candidate Benchmark Results (live run)

**Version:** 1.0.0

Real results from actually executing `spark2-candidate-sequencing-runbook.md`, in progress. Every
number below came from a live run against the fleet on 2026-10-24/25 — none of this is estimated or
synthetic. Updated as each candidate completes; see that runbook for methodology and the open
pre-flight items (§0) this run is proceeding under.

## Phase 1 — tiny specialists

### `prompt-injection-jailbreak-sentinel-v2.Q8_0.gguf` (guard-shaped)

- Tier 0 (`ifeval`, `--limit 20`): `prompt_level_strict_acc = 0.25`. Low, but IFEval is general
  instruction-following and this is a narrow guard-classifier-shaped model — a low score here is
  not strong evidence against it for the role it's actually meant for. No prior run to compare
  against (first time this model_id has been benchmarked).
- Tier 2 (`hermes-guard-eval.py` LLM-mode accuracy): **not measurable as built.** `--llm-roles`
  only resolves role names through the live router's `/v1/models`, with no generic `--endpoint`
  override — an unregistered candidate can't be pointed at without either a tooling change or a
  temporary router registration. Flagged, not worked around.
- Tier 3 (`fleet_guard_latency`): real concurrency sweep, direct-to-candidate, no router.
  | Concurrency | p50 | p95 | tok/s | errors |
  |---|---|---|---|---|
  | 1 | 811ms | 878ms | 238.5 | 0.0 |
  | 4 | 1118ms | 1257ms | 603.3 | 0.0 |
  | 8 | 1809ms | 2586ms | 494.1 | 0.0 |

  Real finding: throughput **peaks at concurrency 4 and regresses at 8** (603→494 tok/s) — this
  model/hardware pairing saturates somewhere between 4 and 8 concurrent requests, unlike the flat
  linear scaling the design doc's own muse history cites. Worth re-checking if this candidate is
  seriously considered, since guard sits on every interactive reply's critical path.

### `Qwen3-Reranker-0.6B-Q8_0.gguf` (staged, rerank-shaped) — **excluded**

SHA256-identical to the file already live as the production `rerank` incumbent
(`/mnt/hermes-data/models/Qwen3-Reranker-0.6B-Q8_0.gguf` on `spark`, `hermes-rerank.service`).
Confirmed byte-for-byte via `sha256sum` on both nodes before running anything — this is not a new
candidate, it's a duplicate of the thing already in production. No suite run.

### `bge-m3-Q8_0.gguf` (embed candidate)

**Methodology correction made mid-run**: the real `embed`/`rerank` incumbents live on `spark`
(`hermes-embed.service`/`hermes-rerank.service`), not `spark2` — the runbook's Phase 1 placement
assumption was wrong. Also found live: the production embed model was swapped
`Qwen3-Embedding-0.6B → Qwen3-Embedding-8B` on 2026-09-04 (`start-embed.sh`'s own header), but
`hermes-embed.service`'s systemd `Description=` field was never updated and still says
"Qwen3-Embedding-0.6B" — stale metadata, same class of staleness as the `llama-omni.service`
description mismatch the runbook's §0.2 already flags, now a second confirmed instance of the same
pattern on this fleet.

- **Recall@k: not measurable.** `hermes-rag-eval.py`'s default mode queries the real, already-
  indexed production vector store (4096-dim, matching the live `Qwen3-Embedding-8B`). bge-m3
  outputs 1024-dim — a real dimension mismatch against the stored corpus, not just "a worse
  score." A fair quality comparison needs a parallel re-index of the whole corpus with bge-m3,
  which is a production data-migration operation, correctly out of scope for a benchmark run.
  Skipped rather than faked.
- **Found and fixed a real tooling gap getting even latency-only numbers**: the real `embed()`
  also hard-checks output dimension against `EMBED_DIMS` and raises before any latency is
  measurable. Added `--embed-dims` to `hermes-latency-eval.py` (now 1.1.0) as an explicit,
  visible override for exactly this case — not a silent bypass of the real check.
- Tier 3 (`fleet_rag_latency_embed`), bge-m3 (1024-dim, candidate) vs. the live incumbent
  (4096-dim, measured directly against the already-running production service, read-only, no
  disruption):

  | Concurrency | bge-m3 p50 | bge-m3 errors | Incumbent (Qwen3-Embedding-8B) p50 | Incumbent errors |
  |---|---|---|---|---|
  | 1 | 5.9ms | 0.0 | 38.3ms | 0.0 |
  | 4 | 16.0ms | 0.0 | 83.9ms | 0.0 |
  | 8 | 16.5ms | 0.0 | 98.6ms | 0.0 |

  bge-m3 is roughly **6x faster at every concurrency level** — expected given it's a much smaller
  model (0.6GB vs 8GB) at a quarter of the output dimension. **Not a recommendation**: per
  `FLEET_BENCHMARK_DESIGN.md`'s own first principle, accuracy is always primary and speed only
  secondary even for a "Yes" role like embed — and bge-m3's accuracy/recall is entirely unmeasured
  here. This is a real speed delta worth having on file, not evidence it should replace the
  incumbent.

## Phase 2+ — in progress

(continues below as each candidate completes)

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-24 | Initial version — real Phase 1 results from the first live execution of the sequencing runbook: guard candidate's full Tier 0/3 numbers (Tier 2 blocked by a tooling gap, stated plainly), the rerank candidate excluded as a confirmed byte-identical duplicate of the live incumbent, and the embed candidate's real latency delta against a live, read-only-measured incumbent baseline (accuracy unmeasured, correctly not attempted). |
