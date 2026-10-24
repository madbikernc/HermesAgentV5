# spark2 Staged-Candidate Benchmark Sequencing Runbook

**Version:** 1.0.0

Sequencing plan for running S39's Tier 0/1/2/3 suites against the model files already staged in
`/opt/hermes-models/` on `dgx-spark2` — a separate directory from `/mnt/hermes-data/models/`, which
is where the four currently-live backends (`coder`, `coder2`, `muse`, `omni`) actually serve from.
Every fact below (file names, sizes, live process list, memory headroom, the `known_arch_gap` list)
was read directly off the fleet 2026-10-24 via read-only `ssh`/`du`/`free`/`nvidia-smi`/`systemctl`
commands — nothing here is assumed or carried over from an older doc. No benchmarking command below
has been executed yet; this is the plan, for a session with operator sign-off to run.

## 0. Pre-flight — three things to resolve before running anything

1. **`llama-coder2.service` is active despite being retired.** `tools/hermes-router.py`'s 2.18.0
   changelog says `coder2` (Muse-Glimmer-30B) was unloaded and unregistered 2026-10-20. Live check
   2026-10-24 (`systemctl is-active llama-coder2` → `active`; `curl 127.0.0.1:8099/v1/models`
   confirms it's still serving Muse-Glimmer-30B) shows it never actually stopped — holding ~16GB
   spark2 doesn't need to be spending if the retirement was real. **Also matters mechanically**:
   `hermes-benchmark-model.sh`'s candidate-mode stop-list only knows `llama-coder`/`llama-muse`
   (+`llama-omni`-class service with `--free-omni`) — same gap `qwen4-coder-bakeoff-runbook.md` §4
   already documented for `spark`'s stop-list not knowing about `coder2` there either. It will
   **not** stop `llama-coder2` on spark2 by itself. Get an explicit operator decision — stop it for
   real and free the memory, or confirm it's intentionally still live — before relying on any memory
   math below that assumes it's gone.
2. **`llama-omni.service`'s own description says "Nemotron 3 Nano Omni 30B-A3B (vision + audio
   backend)", but the process actually running on :8091 is `gemma-4-26B-A4B-it`.** The staged
   `NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf` (Phase 4 below) may be exactly what
   that unit was meant to run. Confirm with the operator whether this is a deliberate swap or drift
   before treating that file as "just another candidate" — it may instead be "restore the omni role
   to what its own service unit says it should be."
3. **Confirm which staged candidate owns `mmproj-F16.gguf`** (1.5GB, generically named, no
   model-specific sidecar file matches it the way the other three VL candidates each have one). Don't
   guess a pairing in a live `llama-server --mmproj` invocation without checking the model card or
   testing load first — a wrong mmproj pairing fails to load, or worse, loads and produces silently
   wrong vision output.

## 1. Roster, real sizes, role classification

| Candidate | Size | Role (confidence) | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|---|---|---|
| `bge-m3-Q8_0.gguf` | 0.6GB | embed (certain — embedding-only arch) | no | existing RAG recall eval | — | `fleet_rag_latency_embed` |
| `Qwen3-Reranker-0.6B-Q8_0.gguf` | 0.6GB | rerank (certain) | no | existing RAG recall eval | — | `fleet_rag_latency_rerank` |
| `prompt-injection-jailbreak-sentinel-v2.Q8_0.gguf` | 0.6GB | guard (certain, by name) | maybe (low value) | — | `hermes-guard-eval.py` | `fleet_guard_latency` |
| `Qwen3-4B-Instruct-2507-Q8_0.gguf` | 4.0GB | unassigned (nano/dispatch-lite candidate) | yes | TBD — pending role assignment | — | TBD |
| `Qwen3-8B-Q8_0.gguf` | 8.1GB | unassigned | yes | TBD | — | TBD |
| `Ministral-8B-Instruct-2410-Q8_0.gguf` | 8.0GB | unassigned | yes | TBD | — | TBD |
| `phi-4-Q8_0.gguf` | 14.5GB | unassigned | yes | TBD | — | — |
| `GLM-4.7-Flash-Q4_K_M.gguf` | 17.2GB | **likely `super`** (stock base of the live `super` model, Huihui-GLM-4.7-Flash-abliterated — inference, not confirmed) | yes | `fleet_log_analyst`, `fleet_digest_faithfulness` | — | — |
| `NousResearch_Hermes-4.3-36B-Q4_K_M.gguf` | 20.3GB | unassigned | yes | TBD | — | — |
| `Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated.i1-Q4_K_M.gguf` | 19.7GB | muse variant | yes | `fleet_muse_contract` | — | `fleet_muse_latency` |
| `Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated.Q4_K_M.gguf` | 19.7GB | muse variant | yes | `fleet_muse_contract` | — | `fleet_muse_latency` |
| `NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf` + mmproj | 20.5GB+1.7GB | omni (vision-capable, name says it fits a 24GB budget) | yes | `fleet_vision_judge` | — | — |
| `Qwen3VL-30B-A3B-Instruct-Q4_K_M.gguf` + mmproj | 17.3GB+1.1GB | omni | yes | `fleet_vision_judge` | — | — |
| `NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf` | 22.2GB | omni (see §0.2) | yes | `fleet_vision_judge` | — | — |
| `Qwen3-Coder-Next-UD-Q4_K_M.gguf` | 45.9GB | coder | yes | `fleet_dualcoder_precision`, `fleet_coder_fix`, `fleet_coder_build` | — | — |
| `NVIDIA-Nemotron-3.5-Super-VL-120B-A12B` (3-shard) + mmproj | ~80.9GB+1.7GB | omni | yes (subset only — see §4 Phase 6) | `fleet_vision_judge` | — | — |

**Excluded, not in any phase below:**

- `qwen3.8-flash-next` (3-shard, 87GB) — **architecturally blocked**. `LLM_ARCH_QWEN4EXP` is in
  spark's own `model_scout_state.json` `known_arch_gap` list (last refreshed today). This is the
  same `qwen4exp` crash `qwen4-coder-bakeoff-runbook.md` was written to re-attempt once support
  shipped — check that runbook's §0 before assuming this is still blocked; if `qwen4exp` support has
  landed since, this candidate moves into Phase 5 alongside `Qwen3-Coder-Next`.
- `Huihui-Qwen3.6-35B-A3B-abliterated.Q4_K_M.gguf` — byte-identical name to the model currently live
  as `muse`; already has real history entries. Re-running it would re-measure, not newly measure,
  something. Skip unless the goal is specifically a regression check against drift.

## 2. Methodology constraints, confirmed live rather than assumed

- **One candidate loads at a time.** spark2 is at 107/121GB unified memory used right now, before
  touching anything in this plan. `hermes-benchmark-model.sh --candidate` stops the swappable
  backends it knows about, loads the candidate on a temporary `llama-server` at `:8093`
  (`BENCHMARK_CANDIDATE_PORT`), restores on exit via a trap — but see §0.1, it does not know about
  `coder2`.
- **Bypass the router — point every S39 harness straight at the candidate port.** All of
  `tools/hermes-{coder-fix,coder-build,dualcoder-precision,digest-faithfulness,vision-judge,latency}-eval.py`
  already take `--endpoint`, so `http://127.0.0.1:8093/v1` needs no code changes.
- **`fleet_coder_fix`/`fleet_coder_build`/`fleet_digest_faithfulness` need a judge model that is
  never the candidate being scored (§8.7).** `super` is resident on `spark` (`10.129.1.15:8095`,
  never touched by spark2's candidate-mode stop list) and is already a routed destination from
  spark2 in production, so the path is already open — no new firewall rule needed. Use
  `--judge-endpoint http://10.129.1.15:8095/v1 --judge-model super` on every call that supports it.
- **Multi-shard GGUFs** (`Super-VL-120B`, and `qwen3.8-flash-next` if it becomes runnable) — pass
  `--candidate` the first shard's path (`...-00001-of-00003.gguf`); llama.cpp finds the siblings
  itself from the `-of-` naming in the same directory.
- **VL candidates need `--mmproj`** passed through to the temporary `llama-server` — confirm
  `hermes-benchmark-model.sh` actually threads an mmproj flag through for candidate mode before
  Phase 4; if it doesn't yet, that's a small addition to make before Phase 4 runs, not a reason to
  skip vision candidates.
- **S28's security-suite family is out of scope for every candidate here**, independent of role —
  still gated on S10's unexecuted network-isolation half, a separate standing constraint.

## 3. Sequencing — cheapest and lowest-risk first, biggest disruption last

The order below is designed to prove the candidate-mode-to-S39-harness pipeline works end to end on
the smallest, cheapest swaps before spending any time on the two largest, most disruptive models —
and to batch by role so a role's Tier 1 suites run back to back against the same loaded candidate.

### Phase 1 — Tiny specialists (lowest risk, validates the pipeline)

`bge-m3`, `Qwen3-Reranker-0.6B`, `prompt-injection-jailbreak-sentinel-v2`. Smallest swap (sub-1GB
each), proves `--endpoint` plumbing and the judge-endpoint path before anything expensive depends on
it.

```bash
# On spark2 — guard-shaped candidate, Tier 2 + Tier 3:
~/HermesAgentV5/tools/hermes-benchmark-model.sh --candidate /opt/hermes-models/prompt-injection-jailbreak-sentinel-v2.Q8_0.gguf \
  --model-id <org>/prompt-injection-jailbreak-sentinel-v2 --suites ifeval --limit 20
python3 tools/hermes-guard-eval.py --endpoint http://127.0.0.1:8093/v1
python3 tools/hermes-latency-eval.py --endpoint http://127.0.0.1:8093/v1 --role guard

# embed/rerank: no Tier 0 (not generative) — run the existing RAG recall eval and fleet_rag_latency
# directly against each temporary server in turn.
```

### Phase 2 — Small general-purpose, role TBD

`Qwen3-4B-Instruct-2507`, `Qwen3-8B`, `Ministral-8B-Instruct-2410`. Tier 0 only until the operator
assigns an intended role — running a Tier 1 suite against an unassigned model measures nothing
specific. Flag each result back to the operator with "what role is this for" before Phase 3-5 work
builds on it.

### Phase 3 — Mid general chat and muse variants

`GLM-4.7-Flash`, `NousResearch_Hermes-4.3-36B`, `phi-4` (Tier 0, + `fleet_log_analyst`/
`fleet_digest_faithfulness` for `GLM-4.7-Flash` specifically, on the lineage inference in §1 — confirm
with the operator first); `Huihui-…-Claude-4.6-Opus-abliterated`, `Huihui-…-Claude-4.7-Opus-abliterated`
(Tier 0 + `fleet_muse_contract` + `fleet_muse_latency`, both muse variants, run back to back since they
share a judge/comparison baseline).

```bash
~/HermesAgentV5/tools/hermes-benchmark-model.sh --candidate /opt/hermes-models/Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated.i1-Q4_K_M.gguf \
  --model-id huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated --suites mmlu_pro,ifeval --limit 100
python3 tools/hermes-muse-contract-eval.py --endpoint http://127.0.0.1:8093/v1
python3 tools/hermes-latency-eval.py --endpoint http://127.0.0.1:8093/v1 --role muse
```

### Phase 4 — Vision/omni candidates

`NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB`, `Qwen3VL-30B-A3B-Instruct`, `NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning`
(pending §0.2/§0.3 resolution). Tier 0 + `fleet_vision_judge` each; no Tier 3 (omni is never
speed-in-scope per §3 of `FLEET_BENCHMARK_DESIGN.md`).

```bash
~/HermesAgentV5/tools/hermes-benchmark-model.sh --candidate /opt/hermes-models/Qwen3VL-30B-A3B-Instruct-Q4_K_M.gguf \
  --model-id Qwen/Qwen3VL-30B-A3B-Instruct --suites mmlu_pro,ifeval --limit 100 \
  -- --mmproj /opt/hermes-models/mmproj-Qwen3VL-30B-A3B-Instruct-F16.gguf
python3 tools/hermes-vision-judge-eval.py --endpoint http://127.0.0.1:8093/v1 --model-id "Qwen3VL-30B-A3B-Instruct (candidate)"
```

### Phase 5 — `Qwen3-Coder-Next` (46GB)

Tier 0 + all three coder Tier 1 suites, run back to back against the one loaded candidate, judged by
`super`:

```bash
~/HermesAgentV5/tools/hermes-benchmark-model.sh --candidate /opt/hermes-models/Qwen3-Coder-Next-UD-Q4_K_M.gguf \
  --model-id Qwen/Qwen3-Coder-Next --suites mmlu_pro,gpqa_diamond,ifeval,bfcl --limit 100
python3 tools/hermes-dualcoder-precision-eval.py --endpoint http://127.0.0.1:8093/v1
python3 tools/hermes-coder-fix-eval.py --endpoint http://127.0.0.1:8093/v1 \
  --judge-endpoint http://10.129.1.15:8095/v1 --judge-model super
python3 tools/hermes-coder-build-eval.py --endpoint http://127.0.0.1:8093/v1 \
  --judge-endpoint http://10.129.1.15:8095/v1 --judge-model super
```

### Phase 6 — `NVIDIA-Nemotron-3.5-Super-VL-120B-A12B` (~81GB) — dedicated maintenance window

The one candidate that needs `--free-omni` plus a manual stop of `llama-coder2` (§0.1) to have any
realistic chance of fitting in 121GB unified memory alongside OS/buffer overhead. Schedule this on
its own, separately from Phases 1-5, with operator awareness that `coder`/`coder2`/`muse`/`omni` are
all down on spark2 for the duration. Tier 0 at a tight `--limit` (this is the slowest-decoding
candidate in the roster) + `fleet_vision_judge` only — skip BFCL/GPQA-Diamond/SWE-bench here unless
the Tier 0 subset result looks promising enough to justify the extra hours.

## 4. Time budget (grounded in this fleet's own real numbers, not invented)

- Model swap (stop services, load, restore): ~2 min for Phase 1-2 candidates, up to ~10-15 min for
  Phase 5-6's 46-81GB multi-shard loads.
- Decode speed anchor: `hermes-router.py`'s own changelog logs `coder2` (a 30B-class model) at
  **34-55s/call** — the real throughput baseline for this hardware, not a guess.
- Tier 0 has **never completed unlimited** in 53 historical `history.jsonl` entries — every real run
  to date used `--limit`. Budget ~20-40 min/candidate with a `--limit` subset; treat unlimited,
  especially `swebench` (zero historical completions), as open-ended.
- Each Tier 1 `fleet_*` suite: 6-34 cases, ~10-30 min per suite per candidate at this hardware's real
  speed.
- Tier 3 sweep (3 concurrency levels × 8 requests): ~10-20 min, Phase 1/3 roles only.

Rough total, Phases 1-5 run sequentially: **~16-20 hours of model-time**, realistically spread over
several days around operator-scheduled disruption windows. Phase 6 is its own ~4-6 hour dedicated
block, separate from that total.

## 5. After each phase

```bash
~/HermesAgentV5/tools/hermes-benchmark-compare.py --model-id <candidate-id> --against <current-role-incumbent>
```

Same caveats every other runbook in this directory already states: treat BFCL as an approximation
without an exact registry match, SWE-bench as provisional, and a Tier 1 result as advisory until a
human has spot-checked a sample of the judge's verdicts — none of these suites carry a hardcoded
promotion threshold on their own (§5.1 of `FLEET_BENCHMARK_DESIGN.md`: Tier 0 triages, Tier 1 decides,
Tier 2 gates, Tier 3 never breaks a tie by itself).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-24 | Initial version — sequencing plan for the 18 real candidate GGUFs found staged in `/opt/hermes-models/` on spark2, written after live read-only recon (process list, memory, `known_arch_gap`, `history.jsonl`) surfaced the `coder2`-retirement anomaly, the `omni`/`gemma` model mismatch, and `qwen3.8-flash-next`'s architecture block. No command in this runbook has been executed yet. |
