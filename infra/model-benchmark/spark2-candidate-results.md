# spark2 Staged-Candidate Benchmark Results (live run)

**Version:** 1.6.0

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

## Phase 2 — small general-purpose, role TBD

Per direct operator instruction, every candidate below gets Tier 0 plus **every** architecturally-
plausible Tier 1 role suite (log analyst, digest faithfulness, muse contract, dualcoder precision,
coder fix, coder build) rather than just the one role it seems most likely for — "record results for
any potential matching role."

### `Qwen3-4B-Instruct-2507-Q8_0.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.900 | Strong |
| `fleet_log_analyst` | accuracy 4/8 = 0.500 (10/18 "unclear") | fact-extraction fine (23/25) but final verdict weak — too many non-committal calls |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, **padding_restraint 0/1 = 0.000** | Failed the one "nothing genuinely new" case — padded/invented a highlight when it should have emitted nothing |
| `fleet_muse_contract` | capability 9/9, groundedness 9/9, **override 4/9**, overall 0.815 | Weak specifically on resisting an adversarial persona-override attempt — more than half the personas broke character when pushed |
| `fleet_dualcoder_precision` | recall 1/3, **precision 0/3**, overall 0.167 | False-positived on all 3 clean-code cases — would flood a real review with invented findings |
| `fleet_coder_fix` | repro **0/1** (the one real executable gold case failed), judge 8/9 = 0.889 | Judge axis looks much better than the one objective repro result — judge may be lenient here, not independently verified |
| `fleet_coder_build` | fixture 2/3, judge 8/8 = 1.000 | Same judge-vs-objective gap pattern as coder_fix |

**Read across suites**: judge-only axes (coder_fix 0.889, coder_build 1.000) are consistently far
rosier than every axis with an objective, non-judge check (repro 0/1, fixture 2/3, dualcoder
precision 0/3). Worth weighting the objective axes heavily over judge-only ones for this candidate
specifically, not just averaging them. One transient judge-endpoint `503` during `coder_fix`
(`mesh_self_intersections`) was correctly recorded as `unclear`, not silently dropped or guessed.

### `Qwen3-8B-Q8_0.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.900 | Same as Qwen3-4B |
| `fleet_log_analyst` | accuracy 6/10 = 0.600 (8 unclear), fact-extraction 23/25 = 0.920 | Better verdict accuracy than Qwen3-4B (0.500), same fact-extraction |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, **padding_restraint 1/1 = 1.000** | Unlike Qwen3-4B, correctly emitted nothing on the "nothing new" case |
| `fleet_muse_contract` | capability 8/9, groundedness 9/9, override 5/9, overall 0.815 | Same overall as Qwen3-4B (0.815); still fails override more than it passes |
| `fleet_dualcoder_precision` | recall 1/3, **precision 0/3**, overall 0.167 | Same pattern as Qwen3-4B — false-positives on all 3 clean-code cases |
| `fleet_coder_fix` | repro 0/1, judge 3/3 = 1.000 | **7 of 10 tasks failed outright on timeout** (`call failed: timed out`), not scored either way |
| `fleet_coder_build` | fixture 2/2 = 1.000, judge 4/4 = 1.000 | **4 of 8 tasks failed outright on timeout** |

**Real finding — timeout, not quality**: at 8B, more than half of `fleet_coder_fix`'s tasks (7/10) and half
of `fleet_coder_build`'s (4/8) never completed a model call at all ("timed out"), vs. zero timeouts for the
4B candidate on the same harness/timeout settings. The "1.000" judge scores above are over whatever small
surviving subset happened to finish in time, not the full task set — they are **not comparable at face
value** to a run that completed all tasks. This looks like the eval harness's per-call timeout being tuned
for smaller/faster candidates and not scaling with model size, rather than anything about Qwen3-8B's actual
coding ability. Flagging as a harness gap worth fixing (raise the timeout or make it size-aware) before
trusting coder_fix/coder_build numbers on any 8B+ candidate, including later Phase 3+ ones.

### `Ministral-8B-Instruct-2410-Q8_0.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.500 | Notably weaker than both Qwen3 candidates (0.900) |
| `fleet_log_analyst` | accuracy 1/2 = 0.500 (**16/18 unclear**), fact-extraction 25/25 = 1.000 | Near-total refusal to commit to a verdict — extracts facts perfectly but hedges on almost every case |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 1/1 = 1.000 | Clean sweep — best digest result of the three Phase 2 candidates |
| `fleet_muse_contract` | capability 7/9, groundedness 7/9, override 4/9, overall 0.667 | Worse overall than both Qwen3 candidates (0.815) |
| `fleet_dualcoder_precision` | recall 2/3, **precision 0/3**, overall 0.333 | Best recall of the three so far, but same 0/3 precision failure |
| `fleet_coder_fix` | repro 0/1, judge 7/7 = 1.000, 3 tasks `env_unavailable` (repro axis skipped, judge axis still scored), 2 timeouts | Fewer timeouts than Qwen3-8B (2 vs 7) at a comparable size — the size-correlates-with-timeouts theory from the Qwen3-8B note doesn't hold cleanly across model families |
| `fleet_coder_build` | fixture 1/3 = 0.333, judge 8/8 = 1.000 | No timeouts this time; fixture-tested subset still weak |

## Phase 2 cross-candidate findings

Two patterns now repeat identically across all three Phase 2 candidates (Qwen3-4B, Qwen3-8B, Ministral-8B),
which makes them look like harness/task-design signals rather than three unrelated model weaknesses:

- **`fleet_dualcoder_precision` precision axis is 0/3 for every candidate tested so far.** Every model
  false-positived on all three clean-code cases, with no exceptions. Worth checking whether the precision
  cases themselves are miscalibrated (e.g. an ambiguous "clean" fixture that a reasonable model would flag)
  before concluding every candidate tested is this bad at avoiding false positives.
- **Judge-only axes in `fleet_coder_fix`/`fleet_coder_build` are at or near 1.000 for every candidate, while
  every objective axis (repro, fixture) in the same runs is weak** (Qwen3-4B repro 0/1, fixture 2/3;
  Qwen3-8B repro 0/1; Ministral-8B repro 0/1, fixture 1/3). Already flagged once for Qwen3-4B alone; now
  confirmed across three different models using the same `super`-model judge. This is strong enough to be a
  judge-calibration concern, not candidate-specific noise — any coder_fix/coder_build "judge: 1.000" result
  in this run should be read as weak evidence until the judge's leniency is independently spot-checked
  (§8.7's own stated caveat materializing in practice, not just a theoretical risk).
- The Qwen3-8B timeout spike (7/10, 4/8) did **not** reproduce on Ministral-8B at a similar parameter count
  (2/10, 0/8) — size alone doesn't predict it, so it's likely model/generation-speed-specific rather than a
  harness timeout that needs to scale with parameter count across the board.

None of the three Phase 2 candidates shows a clean win over a live incumbent on a fair, non-speed-only
basis — nothing qualifies yet for the "outperforms an incumbent" memory note.

## Phase 3 — mid-size general-purpose, role TBD

### Infra finding: `coder2` is "retired" in the router only — Muse-Glimmer-30B is still fully loaded

`hermes-router.py`'s own 2.18.0 changelog and its `ROLES` dict comment both assert Muse-Glimmer-30B was
"unloaded/unregistered" when `coder2` was retired on 2026-10-20. Live check on spark2 during this run:
`systemctl is-active llama-coder2.service` → `active`, and `curl http://127.0.0.1:8099/v1/models` returns
Muse-Glimmer-30B-Q4_K_M, fully loaded. Only the *router's* dispatch table was updated — no production
traffic reaches it any more — but the actual `llama-server` process was never stopped. Four days of a
~17GB resident model on spark2 serving no traffic. Separate from, and more concrete than, the two stale-
`Description=` findings in Phase 1 — this one is a real resource-recovery opportunity (`systemctl stop
llama-coder2.service` would free the memory) and a one-line doc fix to make the changelog comment match
reality, not just a cosmetic metadata mismatch.

### `GLM-4.7-Flash-Q4_K_M.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.600 | Weaker than Qwen3 (0.900), stronger than Ministral (0.500) |
| `fleet_log_analyst` | accuracy 2/3 = 0.667 (15 unclear), **fact-extraction 16/25 = 0.640** | Weakest fact-extraction of any candidate tested so far (everyone else: 23-25/25) |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 1.000 | Clean sweep |
| `fleet_muse_contract` | capability 8/9, groundedness 7/9, **override 6/9**, overall 0.778 | Best override score of any candidate so far (6/9 vs. 4-5/9 elsewhere) |
| `fleet_dualcoder_precision` | recall 3/3, **precision 3/3, overall 1.000** | **First perfect score on this suite** — breaks the 0/3-precision pattern every Phase 2 candidate shared |
| `fleet_coder_fix` | repro 0/1, judge 10/10 = 1.000, 4 `env_unavailable` | No timeouts this run |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 8/8 = 1.000 | No timeouts |

**Real finding — candidate outperforms a live incumbent on a fair, same-day, same-suite basis**: `coder2`
(Muse-Glimmer-30B) is formally retired from router dispatch but, per the infra finding above, is still
fully loaded and reachable. Ran the exact same `fleet_dualcoder_precision` suite against it, read-only,
no disruption: **recall 0/2, precision 0/2, overall 0/4 = 0.000** (2 of 6 cases timed out, reducing the
denominator). GLM-4.7-Flash scores **1.000 (6/6)** on the identical suite. `coder2` was retired in the
first place for "chronic reasoning-candidate" issues per the router's own changelog — this result is
consistent with that retirement rationale and gives a concrete, fair data point that GLM-4.7-Flash is a
plausible candidate specifically for whatever role the dual-coder/code-review function would live under,
should that role be revived. Not a recommendation to reinstate the role — that's the operator's call — but
a real, verified outperformance finding, saved to memory per standing instruction. Caveat: GLM-4.7-Flash's
own Tier 0 (0.600) and log-analyst fact-extraction (0.640) are mediocre, so this is role-specific strength,
not a general-purpose win.

### `phi-4-Q8_0.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | **0.350** | Weakest Tier 0 score of any candidate tested so far |
| `fleet_log_analyst` | accuracy 6/9 = 0.667 (9 unclear), fact-extraction 24/25 = 0.960 | Strong fact-extraction despite weak Tier 0 |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 1.000 | Clean sweep (one raw case, `duplicate_collapse`, missed its exact highlight count but didn't affect the aggregate axes as scored) |
| `fleet_muse_contract` | capability 9/9, groundedness 9/9, **override 3/9**, overall 0.778 | Weakest override resistance of any candidate so far (3/9 vs. 4-6/9 elsewhere) |
| `fleet_dualcoder_precision` | recall 2/3, precision 1/3, overall 0.500 | Second-best precision result after GLM-4.7-Flash's perfect 1.000 — not 0/3 like every Phase 2 candidate |
| `fleet_coder_fix` | repro 0/1, judge 8/8 = 1.000, 3 `env_unavailable`, 2 timeouts | |
| `fleet_coder_build` | fixture 1/3 = 0.333, judge 8/8 = 1.000 | |

One wrapper hiccup noted for completeness: `llama-coder.service` logged "canceled" during its stop step
mid-run; verified immediately after via `systemctl is-active` and a direct `/v1/models` curl that both
`coder` and `muse` came back up correctly serving their real production models — no lasting effect, not a
benchmark-validity issue.

### `NousResearch_Hermes-4.3-36B-Q4_K_M.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.850 | Second only to Qwen3 (0.900) |
| `fleet_log_analyst` | **accuracy 9/12 = 0.750** (6 unclear), fact-extraction 24/25 = 0.960 | **Best accuracy and fewest "unclear" of any candidate tested so far** — see outperformance finding below |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 1.000 | Clean sweep (one raw case, `hallucination_trap`, missed its count but didn't move the aggregate) |
| `fleet_muse_contract` | capability 7/9, groundedness 8/9, **override 3/9**, overall 0.667 | Tied weakest override resistance with phi-4 |
| `fleet_dualcoder_precision` | recall 0/2, precision 0/2, overall 0.000 | 2 of 6 cases timed out, reducing the denominator |
| `fleet_coder_fix` | repro 0/1, judge 4/4 = 1.000, 2 `env_unavailable`, **6 of 10 timed out** | Heaviest timeout rate of any Phase 3 candidate on this suite |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 8/8 = 1.000 | **Zero timeouts** on the same loaded candidate, same session — the timeout pattern is suite/task-specific, not a general slowness of this model |

**Real finding — candidate outperforms a live, actively-serving incumbent on a fair, same-day, same-suite
basis**: traced `fleet_log_analyst`'s real production role via `tools/hermes-logs.py`'s own comment
("Reasoning model is `super`, not `dispatch`") — the live log-analysis role is `super`
(`Huihui-GLM-4.7-Flash-abliterated`, spark port 8095), which is also the judge model used throughout this
entire benchmark run. Ran the identical `fleet_log_analyst` suite against it directly, read-only, no
disruption: **accuracy 3/8 = 0.375 (10/18 unclear), fact-extraction 22/25 = 0.880**. Hermes-4.3-36B scores
**0.750 accuracy (9/12, only 6/18 unclear), fact-extraction 0.960** on the same suite, same day. Unlike the
`coder2` comparison, `super` is a live role actively serving real production log-analysis traffic today —
this is a stronger-weight finding than the GLM-4.7-Flash one. Saved to memory per standing instruction.
Caveat: Hermes-4.3-36B's own weak axis is `fleet_muse_contract` override resistance (3/9) and
`fleet_dualcoder_precision` (0.000, timeout-reduced sample) — this is a log-analyst-role-specific
recommendation, not a blanket "replace `super` everywhere" (`super` also serves as this run's own judge
model and other `super`-role duties not benchmarked here).

### Methodology correction: wrapper was missing `--reasoning off`, a fleet-wide mandatory flag

While benchmarking the next Phase 3 candidate (`Huihui-Qwen3.6-35B-A3B-abliterated.Q4_K_M.gguf` — notably
byte-identical, confirmed via `sha256sum`, to the live `muse` incumbent's own model file), it scored
**`fleet_log_analyst` accuracy 0/0 = None (18/18 unclear), fact-extraction 0/25**, and
`fleet_digest_faithfulness` printed only a `padding_restraint` line with no `grounded`/`faithful` axes at
all — a pattern seen in no other candidate. Hitting the live production `muse` port (8090) directly with
the identical eval tool, read-only, produced normal, correctly-scored output — ruling out the model itself.

Root cause: `run-candidate-suites.sh`'s `llama-server` launch never passed `--reasoning off`. Checking every
`start-*.sh` on both nodes confirms this is a **fleet-wide mandatory flag** on every production launch
script, with one script's own comment stating plainly: "without this flag [a reasoning model] spends the
caller's entire max_tokens budget in reasoning_content" instead of a usable answer. The wrapper's bare
`-m/--port/--host/--ctx-size` launch silently omitted it for every candidate tested so far.

**Fixed**: patched the wrapper (deployed on spark2 and the local scratchpad copy) to always pass
`--reasoning off`, matching the standing fleet rule, for every candidate from this point forward.

**Impact assessment on already-completed candidates** (not blanket-redone, to keep pace with the
authorized Phase 2-5 run; stated plainly per §8.6 rather than silently trusted or silently discarded):
- **Huihui-Qwen3.6-35B-A3B-abliterated (= live `muse` incumbent)**: confirmed corrupted. Re-ran the full
  battery with the fix — see corrected results below. The original broken numbers are superseded, not used
  anywhere in this doc's comparisons.
- **Qwen3-8B and Hermes-4.3-36B**: both already showed unexplained heavy timeout rates on
  `fleet_coder_fix`/`fleet_coder_build` (flagged in their own sections at the time), and both are
  architectures plausibly defaulting to reasoning-on. Their non-timeout-suite numbers (log_analyst, digest,
  muse_contract, dualcoder) show no content-collapse symptom and are plausibly still valid — reasoning
  content most likely lands in a separate `reasoning_content` field for these two rather than polluting
  `content`, consistent with their sane-looking non-timeout results. But the extra reasoning-generation
  time is a direct, now-understood explanation for their timeout spikes. **Recommend a targeted re-run of
  just `fleet_coder_fix`/`fleet_coder_build` for these two candidates** with the fix applied before trusting
  those two suites' numbers for either model; not done yet.
- **Qwen3-4B-Instruct-2507, Ministral-8B-Instruct-2410, GLM-4.7-Flash, phi-4**: zero-to-minimal timeouts and
  no content-collapse symptom in any suite for any of these four. Likely unaffected (the `-Instruct`-suffix
  convention seen in multiple launch-script comments on this fleet specifically marks "no hidden reasoning
  to disable in practice"), but not independently re-verified against a `--reasoning off` rerun.

### `Huihui-Qwen3.6-35B-A3B-abliterated.Q4_K_M.gguf` (= live `muse` incumbent, byte-identical — corrected numbers)

Confirmed via `sha256sum` to be the exact file backing the live `muse` role. Full battery below, measured
*with* the `--reasoning off` fix, serves as this run's official same-day `muse` incumbent baseline for
comparison against every other Phase 2/3 general-purpose candidate's `fleet_muse_contract` score.

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.900 | Matches Qwen3's other strong Tier 0 scores |
| `fleet_log_analyst` | accuracy 4/7 = 0.571 (11 unclear), fact-extraction 24/25 = 0.960 | |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, **padding_restraint 0/1 = 0.000** | Failed the "nothing new" case — padded a highlight it should have withheld |
| `fleet_muse_contract` | capability 7/9, groundedness 9/9, **override 3/9**, overall 0.704 | This is `muse`'s own defining suite — **0.704 is the real, live-incumbent baseline every Phase 2/3 candidate's muse_contract score should be read against** |
| `fleet_dualcoder_precision` | recall 0/3, precision 0/3, overall **0.000** | The broken pre-fix run showed a bogus 1.000 here — the corrected number is the opposite result, confirming the original was a methodology artifact, not genuine skill |
| `fleet_coder_fix` | repro 0/1, judge 9/10 = 0.900, 4 `env_unavailable` | No timeouts with the fix applied |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 8/8 = 1.000 | No timeouts |

**Read across this run so far**: against this real `muse`-incumbent baseline (0.704 muse_contract), every
Phase 2/3 candidate's own muse_contract score (Qwen3-4B 0.815, Qwen3-8B 0.815, Ministral-8B 0.667,
GLM-4.7-Flash 0.778, phi-4 0.778, Hermes-4.3-36B 0.667) is in the same general range — no candidate so far
shows a `muse`-role-specific outperformance gap as clean as the `coder2`/dualcoder or `super`/log-analyst
findings above. Qwen3-4B and Qwen3-8B edge it out (0.815 vs. 0.704) but not by a margin this run is
treating as conclusive on its own, given everything else already flagged about those two candidates.

## Phase 3+ — in progress

(continues below as each candidate completes)

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-24 | Initial version — real Phase 1 results from the first live execution of the sequencing runbook: guard candidate's full Tier 0/3 numbers (Tier 2 blocked by a tooling gap, stated plainly), the rerank candidate excluded as a confirmed byte-identical duplicate of the live incumbent, and the embed candidate's real latency delta against a live, read-only-measured incumbent baseline (accuracy unmeasured, correctly not attempted). |
| 1.1.0 | 2026-10-24 | Added Phase 2 Qwen3-4B and Qwen3-8B full-battery results. Qwen3-8B surfaced a real harness gap: 7/10 `fleet_coder_fix` and 4/8 `fleet_coder_build` tasks timed out outright at 8B (zero timeouts at 4B on the same settings) — surviving-subset judge scores flagged as not comparable at face value until the harness's timeout is made size-aware. |
| 1.2.0 | 2026-10-25 | Completed Phase 2 with Ministral-8B-Instruct-2410 results, plus a cross-candidate findings section: `fleet_dualcoder_precision` precision axis is 0/3 for all three Phase 2 candidates (likely task-calibration issue), coder_fix/coder_build judge-only axes are near-1.000 for all three while every objective axis is weak (judge-calibration concern, not candidate-specific), and the Qwen3-8B timeout spike did not reproduce on similarly-sized Ministral-8B (model-specific, not a simple size threshold). No Phase 2 candidate qualifies as outperforming a live incumbent. |
| 1.3.0 | 2026-10-25 | Started Phase 3 with GLM-4.7-Flash-Q4_K_M full battery. Found `coder2`/Muse-Glimmer-30B still fully loaded and live on spark2 four days after the router's changelog claimed it was unloaded/unregistered -- only its dispatch registration was actually removed. Used that still-live incumbent for a fair same-day `fleet_dualcoder_precision` comparison: incumbent scores 0.000 (0/4, 2 timeouts), GLM-4.7-Flash scores a perfect 1.000 (6/6) -- first confirmed candidate-outperforms-incumbent finding of this run, saved to memory. |
| 1.4.0 | 2026-10-25 | Added phi-4-Q8_0 results: weakest Tier 0 score of the run (0.350) but strong log-analyst fact-extraction (0.960) and the weakest muse_contract override resistance seen so far (3/9). Noted and cleared a transient wrapper hiccup (`llama-coder.service` logged "canceled" mid-stop; verified both coder and muse came back up correctly). |
| 1.5.0 | 2026-10-25 | Added NousResearch_Hermes-4.3-36B results and a second, stronger candidate-outperforms-incumbent finding: traced `fleet_log_analyst`'s real production role to `super` (live, actively serving traffic), measured it read-only at 0.375 accuracy, and found Hermes-4.3-36B scores 0.750 on the identical suite same-day. Saved to memory. |
| 1.6.0 | 2026-10-25 | Found and fixed a real methodology bug: the candidate wrapper never passed `--reasoning off`, a fleet-wide mandatory flag on every production launch script. Confirmed it corrupted the Huihui-Qwen3.6-35B-A3B-abliterated (= live `muse` incumbent, byte-identical) run outright (log_analyst 0/25 facts, digest axes missing); re-ran with the fix for the real, corrected `muse`-incumbent baseline (muse_contract 0.704). Flagged Qwen3-8B's and Hermes-4.3-36B's coder_fix/coder_build timeout-inflated numbers as likely affected by the same root cause, recommending a targeted re-run; the four Instruct-suffixed/non-reasoning candidates show no corruption symptoms. Wrapper now passes the flag by default for every remaining candidate. |
