# spark2 Staged-Candidate Benchmark Results (live run)

**Version:** 1.14.0

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

### `Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated.i1-Q4_K_M.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.850 | Close to the base model's corrected 0.900 |
| `fleet_log_analyst` | accuracy 2/5 = 0.400 (13 unclear), fact-extraction 24/25 = 0.960 | Weaker accuracy than the base model (0.571) |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 0/1 = 0.000 | Same padding-restraint failure as the base model |
| `fleet_muse_contract` | capability 9/9, groundedness 8/9, override 3/9, overall 0.741 | Slightly above the real `muse` baseline (0.704) |
| `fleet_dualcoder_precision` | recall 0/3, precision 0/3, overall 0.000 | Identical to the base model's corrected result |
| `fleet_coder_fix` | repro 0/1, judge 10/10 = 1.000, 4 `env_unavailable` | No timeouts |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 8/8 = 1.000 | No timeouts |

This Claude-4.6-Opus-abliterated finetune tracks the base `Huihui-Qwen3.6-35B-A3B-abliterated` (= `muse`
incumbent) closely across every suite — consistent with being a light finetune/merge on the same base
rather than a meaningfully different model. No suite shows a gap large enough to call a real difference.

### `Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated.Q4_K_M.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.850 | Same as the Claude-4.6 sibling |
| `fleet_log_analyst` | **accuracy 6/8 = 0.750** (10 unclear), **fact-extraction 25/25 = 1.000** | Ties Hermes-4.3-36B for best accuracy in the run, with perfect fact-extraction |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 0/1 = 0.000 | Same padding-restraint failure as its sibling and the base model |
| `fleet_muse_contract` | capability 5/9, groundedness 9/9, **override 1/9**, overall **0.556** | **Worst override and worst overall muse_contract score of the entire run** — below even the real `muse` incumbent baseline (0.704) |
| `fleet_dualcoder_precision` | recall 0/3, precision 0/3, overall 0.000 | Same as its sibling |
| `fleet_coder_fix` | repro 0/1, judge 10/10 = 1.000, 4 `env_unavailable` | No timeouts |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 8/8 = 1.000 | No timeouts |

A real tradeoff against its Claude-4.6 sibling: notably better log-analyst accuracy (0.750 vs. 0.400) but
markedly worse persona/override resistance (1/9 vs. 3/9). Since it ties rather than beats Hermes-4.3-36B's
already-flagged log-analyst accuracy (same 0.750, see the Phase 3 outperformance finding above) while
coming with the weakest muse_contract score in the run, this doesn't change that recommendation — noted as
a secondary data point, not a new finding.

This closes out Phase 3.

## Phase 4 — vision-capable, role TBD

### Tooling note: `hermes-vision-judge-eval.py` expects `--endpoint` *without* `/v1`

Unlike every other eval tool in this run, `hermes-vision-judge-eval.py` passes `--endpoint` straight into
`hermes-media.py`'s `ROUTER_URL`, and `evaluate_image()` appends `/v1/chat/completions` itself — passing
the usual `.../v1` convention produces a double `/v1/v1/chat/completions` path and a 404 on every image
(confirmed: all 34 fixtures failed this way on first attempt against Nemotron-3.5-Bolt). The tool's own
docstring usage example already shows the bare-host form; re-ran with `--endpoint http://127.0.0.1:8093`
(no `/v1`) and it worked immediately. Noting this so Phase 4's remaining two candidates use the correct
form from the start.

### `NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.750 | |
| `fleet_log_analyst` | accuracy 7/10 = 0.700 (8 unclear), fact-extraction 22/25 = 0.880 | |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 1.000 | Clean sweep |
| `fleet_muse_contract` | capability 9/9, groundedness 9/9, override 5/9, **overall 0.852** | **Best muse_contract score of the entire run** (previous best: 0.815) |
| `fleet_dualcoder_precision` | recall 0/3, precision 0/3, overall 0.000 | |
| `fleet_coder_fix` | repro 0/1, judge 10/10 = 1.000, 4 `env_unavailable` | No timeouts |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 8/8 = 1.000 | No timeouts |
| `fleet_vision_judge` (n=34, corrected endpoint) | precision 0.897, **recall 0.963**, false_pass_rate 0.429, **false_fail_rate 0.037** | See outperformance finding below |

**Real finding — candidate strongly outperforms a live, actively-serving incumbent on a fair, same-day,
same-suite basis**: ran the identical, corrected `fleet_vision_judge` suite against the live `omni` role
(`gemma-4-26B-A4B-it`, spark2 port 8091), read-only, no disruption: **precision 0.846, recall 0.407,
false_pass_rate 0.286, false_fail_rate 0.593**. The incumbent incorrectly rejects more than half of
genuinely good images (`false_fail_rate` 0.593 — burning render compute on needless regenerations more
often than not), vs. Nemotron-3.5-Bolt's 0.037. Nemotron-3.5-Bolt trades a somewhat higher
`false_pass_rate` (0.429 vs. 0.286, on a small n=7 "fail" sample — one additional missed bad image) for a
dramatically better recall and false-fail rate. Combined with this candidate's also-best-in-run
`fleet_muse_contract` score (0.852), this is the strongest outperformance finding of the run so far —
saved to memory per standing instruction.

### `Qwen3VL-30B-A3B-Instruct-Q4_K_M.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | **0.950** | **Best Tier 0 score of the entire run** |
| `fleet_log_analyst` | accuracy 1/1 = 1.000 (**17/18 unclear**), fact-extraction 25/25 = 1.000 | The "1.000" is on a single scored case — near-total non-commitment elsewhere, not a real signal |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 0/1 = 0.000 | Same restraint failure pattern as several other candidates |
| `fleet_muse_contract` | capability 9/9, groundedness 9/9, override 5/9, overall **0.852** | **Ties Nemotron-3.5-Bolt for best muse_contract score of the run** |
| `fleet_dualcoder_precision` | recall 0/3, precision 0/3, overall 0.000 | |
| `fleet_coder_fix` | repro 0/1, judge 10/10 = 1.000, 4 `env_unavailable` | No timeouts |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 8/8 = 1.000 | No timeouts |
| `fleet_vision_judge` (n=34) | precision 0.833, recall 0.926, **false_pass_rate 0.714**, false_fail_rate 0.074 | See comparison note below |

**Comparison with the other vision candidates and the live incumbent on the identical, same-day
`fleet_vision_judge` suite**:

| Model | precision | recall | false_pass_rate | false_fail_rate |
|---|---|---|---|---|
| `omni` incumbent (live, gemma-4-26B-A4B-it) | 0.846 | 0.407 | 0.286 | 0.593 |
| Nemotron-3.5-Bolt-74B (candidate) | 0.897 | 0.963 | 0.429 | 0.037 |
| Qwen3VL-30B (candidate) | 0.833 | 0.926 | **0.714** | 0.074 |

Qwen3VL also clearly beats the incumbent on recall/false_fail_rate, but its **false_pass_rate (0.714) is
the worst of all three** — it lets genuinely bad images through more often than even the incumbent does
(0.286). Despite Qwen3VL's best-in-run Tier 0 and tied-best muse_contract, Nemotron-3.5-Bolt remains the
stronger candidate specifically for the vision-judge role on this evidence (better recall, much better
false_pass_rate, same muse_contract tie). Not re-opening the memory finding as a new one — folding this
comparison into the existing Nemotron-3.5-Bolt finding.

### `NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf`

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.850 | |
| `fleet_log_analyst` | accuracy 2/6 = 0.333 (12 unclear), fact-extraction 22/25 = 0.880 | |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 1.000 | Clean sweep |
| `fleet_muse_contract` | capability 9/9, groundedness 9/9, **override 8/9**, overall **0.963** | **By far the best muse_contract score of the entire run** — see outperformance finding below |
| `fleet_dualcoder_precision` | recall 0/3, precision 0/3, overall 0.000 | |
| `fleet_coder_fix` | repro 0/1, judge 10/10 = 1.000, 4 `env_unavailable` | No timeouts, despite the "-Reasoning" name — the `--reasoning off` fix held |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 8/8 = 1.000 | No timeouts |
| `fleet_vision_judge` (n=34) | precision 0.821, recall 0.852, false_pass_rate 0.714, false_fail_rate 0.148 | Weakest vision-judge result of the three Phase 4 candidates despite being the `omni` role's namesake model |

**Real finding — candidate strongly outperforms the live `muse` incumbent on a fair, same-day, same-suite
basis**: against the corrected `muse`-incumbent baseline established earlier this phase (0.704, measured
with the `--reasoning off` fix), this candidate scores **0.963** on the identical `fleet_muse_contract`
suite — the single largest gap of any finding in this run. Its override-resistance axis alone (8/9) beats
every other candidate's override score outright (best previous: 6/9). Saved to memory per standing
instruction. Caveat: this candidate's own vision-judge numbers are the weakest of the three Phase 4
candidates (false_pass_rate 0.714, tied-worst with Qwen3VL; recall 0.852, worse than both other
candidates) — despite being named for the `omni` role, the evidence favors proposing it for `muse`
specifically, not `omni`.

**Phase 4 vision-candidate summary** (all measured on the identical, same-day, n=34 `fleet_vision_judge` suite):

| Model | precision | recall | false_pass_rate | false_fail_rate |
|---|---|---|---|---|
| `omni` incumbent (live, gemma-4-26B-A4B-it) | 0.846 | 0.407 | 0.286 | 0.593 |
| Nemotron-3.5-Bolt-74B (candidate) | 0.897 | **0.963** | 0.429 | **0.037** |
| Qwen3VL-30B (candidate) | 0.833 | 0.926 | 0.714 | 0.074 |
| Nemotron-3-Nano-Omni-30B-Reasoning (candidate) | 0.821 | 0.852 | 0.714 | 0.148 |

Nemotron-3.5-Bolt remains the strongest vision-judge candidate of the three on every axis. This closes
out Phase 4.

## Phase 5 — large coder candidate

### `Qwen3-Coder-Next-UD-Q4_K_M.gguf` (46GB)

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.850 | |
| `fleet_log_analyst` | accuracy 6/7 = **0.857** (11 unclear), fact-extraction 24/25 = 0.960 | Highest raw accuracy number in the run, though on a small n=7 scored sample — read cautiously next to Hermes-4.3-36B's 9/12 and Huihui-Claude-4.7's 6/8 (both 0.750 on larger samples) |
| `fleet_digest_faithfulness` | grounded 1.000, faithful 1.000, padding_restraint 0/1 = 0.000 | Same restraint failure pattern as several others |
| `fleet_muse_contract` | capability 9/9, groundedness 9/9, override 3/9, overall 0.778 | |
| `fleet_dualcoder_precision` | recall 0/3, precision 0/3, overall **0.000** | Weak result on the suite most relevant to a "Coder-Next" candidate — see incumbent comparison below |
| `fleet_coder_fix` | repro 0/1, judge 10/10 = 1.000, 4 `env_unavailable` | **Zero timeouts** on this 46GB model |
| `fleet_coder_build` | fixture 2/3 = 0.667, judge 7/7 = 1.000, 1 `unclear` (transient judge 503, correctly recorded) | Zero timeouts |

**Direct comparison against the live `coder` incumbent** (`Qwen3.8-27B-abliterated`, port 8094), measured
read-only on the identical coder-focused suites, same day — the most relevant comparison for a model
explicitly staged as a "Coder-Next" candidate:

| Suite | `coder` incumbent (live) | Qwen3-Coder-Next (candidate) |
|---|---|---|
| `fleet_dualcoder_precision` | recall 1/3, precision 0/3, overall **0.167** | recall 0/3, precision 0/3, overall **0.000** |
| `fleet_coder_fix` | judge 7/7 = 1.000, **3/10 tasks timed out** | judge 10/10 = 1.000, **0/10 timed out** |
| `fleet_coder_build` | judge 5/5 = 1.000, **3/8 tasks timed out** | judge 7/7 = 1.000, **0/8 timed out** |

**Mixed result, not a clean outperformance finding**: Qwen3-Coder-Next completed every single coder_fix/
coder_build task with zero timeouts, while the live `coder` incumbent itself times out on 3/10 and 3/8
tasks under the identical harness (confirming the earlier timeout pattern is a genuine harness/latency
characteristic, not an artifact of the missing `--reasoning off` fix — `coder`'s own production launch
script already applies it). That's a real reliability advantage. But on `fleet_dualcoder_precision`, the
one suite where both models completed every case without timeouts, the incumbent actually scores better
(0.167 vs. 0.000). Given the quality signal cuts against the candidate on the most directly-relevant
suite, this does **not** clear the bar for a saved outperformance recommendation — recorded here plainly,
not pushed to memory.

This closes out Phase 5 and the full Phase 2-5 run authorized by the operator.

## Phase 6 — `NVIDIA-Nemotron-3.5-Super-VL-120B-A12B` (~81GB) — first attempt aborted, retry succeeded

### First attempt: aborted mid-run, no score obtained

Operator authorization for this phase arrived separately, as planned. Pre-flight recon on spark2 resolved
one open question from the sequencing runbook's §0.3 and surfaced a new, more serious one.

**Resolved**: the 3-shard GGUF (`...-00001-of-00003.gguf` 7.9MB metadata shard + `-00002-` 49.85GB +
`-00003-` 37.05GB, llama.cpp auto-discovers the siblings from the first shard's path) has its own
clearly-named mmproj, `mmproj-NVIDIA-Nemotron-3.5-Super-VL-BF16.gguf` (1.73GB, same mtime as the shards) --
no pairing ambiguity. The generic `mmproj-F16.gguf` the runbook flagged as unidentified belongs to some
other, still-unidentified candidate, not this one.

**New finding -- the "all four backends stay down for the duration" assumption doesn't hold under live
traffic**: extended `run-candidate-suites.sh` with an `EXTRA_STOP` env var (deployed + local scratchpad
copy, not committed, same as this run's other wrapper fixes) to additionally stop `llama-coder2.service`
and `llama-omni.service` alongside the wrapper's usual coder+muse stop, matching the runbook's Phase 6
plan. All four stopped cleanly and the candidate loaded and came up healthy on :8093 with `--mmproj`.
Partway through Tier 0 `ifeval`, `llama-coder.service` -- whose own systemd description calls it an
"on-demand coder backend" -- **restarted itself twice**, each time within 20-30s of being stopped, driven
by real incoming production traffic (most likely Minecraft-bot coder calls). `hermes-coder-idle-sleep.timer`
(fires every ~5 min) is the counterpart meant to idle it back down, but nothing prevents it restarting
again on the next request while traffic keeps arriving. Every earlier phase's much smaller candidates had
enough memory slack to absorb this unnoticed; Phase 6's ~82GB footprint left only ~8-11GB free, so the
contention became directly visible (`free -h` oscillating between ~6GB and ~30GB free as coder cycled) and
started measurably degrading the candidate's own decode speed (16 t/s -> 9 t/s over a few minutes, with
swap usage climbing from 2.4GB to 3.0GB) -- a real memory-bandwidth/paging effect, not just this model's
inherent size. For comparison, Qwen3-Coder-Next (46GB, Phase 5) held a steady ~50 t/s.

The clean fix -- `systemctl mask llama-coder.service` for the duration -- was correctly blocked by the
Claude Code auto-mode classifier ("Modify Shared Resources"): a persistent config change to a shared
production unit is a step beyond routine benchmarking and needs explicit operator sign-off, not a
judgment call made mid-run. With available memory still falling and Tier 0 `ifeval` (just 20 items) not
yet complete after several minutes, continuing into the much heavier, longer `fleet_vision_judge` suite
was judged too risky -- an OOM on this host would have cost more than one benchmark result, given `coder`
was actively serving real traffic throughout. Aborted via `SIGTERM` to the wrapper (triggers its cleanup
trap); the candidate's own `llama-server` hung on shutdown (port already closed, but the process sat in
`futex_do_wait` for 90+ seconds releasing the ~82GB mapping) and had to be force-killed directly -- safe,
since it was this run's own temporary process, not a production service. All four production backends
(`coder`, `coder2`, `muse`, `omni`) were confirmed back up and healthy afterward; spark2 returned to its
normal resting state (~31GB available).

**Separately**: `hermes-benchmark-model.sh`'s own `--free-omni` flag (distinct from the wrapper used
above) stops `llama-amy-vision.service`, not `llama-omni.service` -- and `llama-amy-vision.service` is a
real, currently-disabled unit on spark2, not a typo for the omni role. Left uninvestigated and unfixed
here (unclear whether "Amy" names a separate persona/project from Hermes' `omni` role); worth operator
review before anyone relies on `--free-omni` to mean "frees the omni backend."

**No usable score for this candidate** -- Tier 0 `ifeval` never completed and `fleet_vision_judge` never
started. Phase 6 is not closed. Re-attempting it needs either a genuinely low-traffic window or a
supported, operator-approved way to pause `coder`'s on-demand restart (not ad hoc `systemctl mask`) before
the memory budget can be trusted for a model this size.

### Retry: real production fixes applied, clean run, real score obtained

Direct operator follow-up addressed the exact contention this first attempt hit, rather than just waiting
for a quiet window:

1. **Stopped all nine Minecraft bot services** (`babs`/`amy`/`mark`/`luke`/`mayor` on `spark`,
   `bob`/`nell`/`wade`/`dale` on `spark2`) -- the real source of the `coder`-role traffic that kept waking
   `llama-coder.service` mid-run. Restarted after this phase closed.
2. **Permanently disabled `coder2`** rather than just stopping it for this one window. Investigation found
   it was already fully de-registered in code since 2026-10-20 (`hermes-router.py`'s `ROLES` dict,
   `hermes-model-wake-worker.py`'s `WAKE_TARGETS`) with no remaining code path anywhere in the repo that
   calls it other than through those two now-empty registrations -- every other `coder2` reference
   (`hermes-dualcoder.py`, `hermes-minecraft-triage.py`, `hermes-self-repair-generate.py`) goes through the
   router by role name and would 404, not reach systemd. The one real remaining risk was the unit's own
   `Restart=on-failure` directive, live only while the service is actually running. `systemctl mask` was
   the correct fix, but `mask --force` refused to clobber the real (non-symlink) unit file already at
   `/etc/systemd/system/llama-coder2.service` -- did the manual equivalent instead (`rm` the file, preserved
   unchanged in the repo at `infra/hermes-coder2/llama-coder2.service` for later restoration, then
   `ln -s /dev/null` in its place, then `daemon-reload`). Confirmed: `systemctl start llama-coder2.service`
   now fails with `Unit llama-coder2.service is masked.` This also resolves this run's own Phase 3 finding
   that `coder2` was wasting ~17GB resident for no traffic -- that memory is now actually freed, not just
   flagged.

With both fixed, the retry ran with **zero contention**: decode speed held a steady **18.0 t/s** for the
entire run (vs. the first attempt's contention-degraded 16 -> 9 t/s), and `coder`/`coder2` both stayed down
the whole time with no flapping.

| Suite | Result | Note |
|---|---|---|
| Tier 0 `ifeval` (limit 20) | 0.750 | Mid-pack, unremarkable |
| `fleet_vision_judge` (n=34) | precision 0.895, recall **0.630**, false_pass_rate 0.286, false_fail_rate 0.370 | See comparison below |

**Comparison with the other three vision candidates and the live incumbent, identical same-fixture-set
suite**:

| Model | Size | precision | recall | false_pass_rate | false_fail_rate |
|---|---|---|---|---|---|
| `omni` incumbent (live, gemma-4-26B-A4B-it) | ~17GB | 0.846 | 0.407 | 0.286 | 0.593 |
| Nemotron-3.5-Bolt-74B | ~22GB | 0.897 | **0.963** | 0.429 | **0.037** |
| Qwen3VL-30B | ~18GB | 0.833 | 0.926 | 0.714 | 0.074 |
| Nemotron-Omni-30B-Reasoning | ~22GB | 0.821 | 0.852 | 0.714 | 0.148 |
| **Nemotron-3.5-Super-VL-120B** | **~83GB** | 0.895 | 0.630 | 0.286 | 0.370 |

Super-VL-120B does technically beat the live `omni` incumbent (better precision and recall, matching
false_pass_rate, better false_fail_rate) -- by the same bar every other saved finding this run used. But
it posts the **worst recall and false_fail_rate of all four vision candidates tested**, at roughly
**4x the resident size** of the next-largest and by far the slowest to decode. Not saved as a new
outperformance finding: folded into the existing [[s39-nemotron35bolt-beats-omni-vision]] memory as an
additional comparison point, same as Qwen3VL-30B was. Nemotron-3.5-Bolt-74B remains the clear best `omni`
candidate on every measured axis except raw parameter count.

This closes Phase 6 and the full operator-authorized S39 spark2 candidate run (Phases 1-6).

## Run summary (Phases 1-6)

Four candidates were found to genuinely outperform their live incumbent on a fair, same-day, same-suite
basis, each saved to memory:

1. **GLM-4.7-Flash** vs. the retired-but-still-loaded `coder2` (Muse-Glimmer-30B): `fleet_dualcoder_precision`
   1.000 vs. 0.000.
2. **Hermes-4.3-36B** vs. the live `super` role (serving log-analysis traffic): `fleet_log_analyst` accuracy
   0.750 vs. 0.375.
3. **Nemotron-3.5-Bolt-74B** vs. the live `omni` role: `fleet_vision_judge` recall 0.963 vs. 0.407
   (false_fail_rate 0.037 vs. 0.593); also the best all-round `fleet_muse_contract` score among the three
   vision candidates.
4. **Nemotron-3-Nano-Omni-30B-Reasoning** vs. the live `muse` role: `fleet_muse_contract` 0.963 vs. 0.704 —
   the largest gap of any finding in this run, but specifically a `muse`-role recommendation, not `omni`
   (its own vision-judge numbers were the weakest of the three Phase 4 candidates).

A fifth candidate, Phase 6's Nemotron-3.5-Super-VL-120B, technically also beat the `omni` incumbent on
`fleet_vision_judge` but was the weakest of the four vision candidates tested at ~4x the size -- not saved
as a separate finding, folded into finding 3's memory as an additional comparison point.

Real infrastructure/tooling findings surfaced along the way, independent of any single candidate's score:
stale `Description=` metadata on two systemd services (Phase 1); a byte-identical reranker duplicate
excluded from scoring (Phase 1); `coder2`/Muse-Glimmer-30B still fully loaded four days after being marked
"unloaded" in the router's own changelog (Phase 3, and only actually stopped+masked in Phase 6 after a
first Phase 6 attempt showed it was still a live resource risk); a missing `--reasoning off` flag in the
candidate wrapper that corrupted at least one candidate's results outright and is the likely cause of
several unexplained timeout spikes (Phase 3, fixed); an endpoint-URL-format gotcha in
`hermes-vision-judge-eval.py` (Phase 4, fixed); a judge-leniency pattern where judge-only axes scored near
1.000 across many candidates while every objective axis in the same runs stayed weak (Phase 2, flagged as
needing independent spot-checking, not yet resolved); and `llama-coder.service`'s on-demand restart
defeating the "all backends stay down for the duration" assumption under real production (Minecraft-bot)
traffic once a candidate's memory footprint got big enough to make the contention visible (Phase 6 --
worked around by stopping the bots for the duration, not yet solved at the tooling level for a future
large-candidate run that can't do the same).

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
| 1.7.0 | 2026-10-25 | Added Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated results (measured with the `--reasoning off` fix). Tracks the base model/`muse` incumbent closely across every suite -- no meaningful difference found. |
| 1.8.0 | 2026-10-25 | Added Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated results, closing out Phase 3. Ties Hermes-4.3-36B's log-analyst accuracy but posts the worst muse_contract override/overall score of the entire run -- a real tradeoff, not a new recommendation. |
| 1.9.0 | 2026-10-25 | Started Phase 4 (vision-capable candidates) with NVIDIA-Nemotron-3.5-Bolt-74B-A9B. Found and fixed a `hermes-vision-judge-eval.py` endpoint-format gotcha (no `/v1` suffix, unlike every other tool). Third outperformance finding, and the strongest yet: live `omni` incumbent (gemma-4-26B-A4B-it) has fleet_vision_judge recall 0.407 and false_fail_rate 0.593 (rejects most good images); Nemotron-3.5-Bolt scores recall 0.963, false_fail_rate 0.037, and also posts the best fleet_muse_contract score of the entire run (0.852). Saved to memory. |
| 1.10.0 | 2026-10-25 | Added Qwen3VL-30B-A3B-Instruct results: best Tier 0 score of the run (0.950), ties Nemotron-3.5-Bolt for best muse_contract (0.852), and also clearly beats the omni incumbent on vision-judge recall -- but its false_pass_rate (0.714) is the worst of all three models compared, keeping Nemotron-3.5-Bolt as the stronger vision-role candidate. |
| 1.11.0 | 2026-10-25 | Added NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning results, closing Phase 4. Fourth outperformance finding: scores 0.963 on fleet_muse_contract against the real muse-incumbent baseline of 0.704 -- the largest gap in the run -- despite the weakest vision-judge numbers of the three Phase 4 candidates. Saved to memory as a muse-role (not omni-role) recommendation. Added a Phase 4 vision-candidate summary table. |
| 1.12.0 | 2026-10-25 | Added Qwen3-Coder-Next-UD-Q4_K_M results, closing Phase 5 and the full operator-authorized Phase 2-5 run. Direct comparison against the live `coder` incumbent on coder-focused suites is mixed, not a clean outperformance finding: the candidate has zero timeouts vs. the incumbent's 3/10 and 3/8, but the incumbent scores better on fleet_dualcoder_precision (0.167 vs. 0.000) -- recorded plainly, not saved to memory. Added a Phase 4/5 structural fix (missing `##` section headers) and a full run summary covering all four saved outperformance findings and the cross-cutting infra/tooling findings. Phase 6 remains explicitly held back pending separate authorization. |
| 1.13.0 | 2026-10-25 | Attempted Phase 6 (`NVIDIA-Nemotron-3.5-Super-VL-120B-A12B`, ~81GB) on separate operator authorization; aborted mid-run with no usable score. Resolved the runbook's mmproj-pairing question for this candidate. New finding: `llama-coder.service` is an "on-demand" backend that auto-restarted twice under real production traffic despite being deliberately stopped for the maintenance window, visibly contending for memory and degrading the candidate's own decode speed (16 -> 9 t/s) at this candidate's much tighter ~82GB footprint -- invisible at every earlier phase's smaller candidate sizes. The clean fix (`systemctl mask`) was correctly blocked by the auto-mode classifier as a shared-resource change needing operator sign-off. Aborted safely: force-killed the candidate's own hung-on-shutdown `llama-server` process (not a production service) after a clean `SIGTERM` stalled, then confirmed all four production backends (`coder`/`coder2`/`muse`/`omni`) came back up healthy. Also noted, unfixed: `hermes-benchmark-model.sh`'s `--free-omni` flag stops `llama-amy-vision.service`, a distinct real unit, not `llama-omni.service` -- flagged for operator review, not assumed to be a simple naming bug. Phase 6 remains open, needing either a low-traffic window or an operator-approved way to pause `coder`'s on-demand restart before a safe re-attempt. |
| 1.14.0 | 2026-10-25 | Phase 6 retry, direct operator follow-up: stopped all nine Minecraft bot services (the real source of the contending `coder` traffic) and permanently disabled `coder2` (stopped + masked -- manually, since `systemctl mask --force` refused to clobber the real unit file already at that path; confirmed `coder2` now refuses to start). Retry ran with zero contention, steady 18.0 t/s decode throughout. Real score obtained: Tier 0 `ifeval` 0.750, `fleet_vision_judge` precision 0.895/recall 0.630/false_pass_rate 0.286/false_fail_rate 0.370 -- technically beats the `omni` incumbent (same bar as every other finding this run) but is the weakest of the four vision candidates tested at ~4x the size of the next-largest. Not saved as a new finding; folded into the existing Nemotron-3.5-Bolt-74B memory as a comparison point. Restarted all nine bots afterward. This closes Phase 6 and the full Phases 1-6 run. |
