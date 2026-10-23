# Firmament Fleet Benchmark Suite — Target Design

**Version:** 1.10.0

**Status:** S39a cleared, Phases A-B-D(6.6) executed (2026-10-22/23), Phase C complete except §6.2
(2026-10-23) — operator reviewed the gap list (§4) and phasing (§10), approved proceeding; schema
unification (§7), the two highest-stakes gaps (`fleet_log_analyst`, the formal `fleet_guard` Tier 2
gate), five of Phase C's six suites (`fleet_muse_contract`, `fleet_dualcoder_precision`,
`fleet_digest_faithfulness`, `fleet_coder_fix`, `fleet_coder_build`), and the Tier 3
interactive-latency harness (§6.6) are built, 238 offline checks total, no live fleet node reachable
to verify a real run or real backend numbers yet. Every case set built so far is synthetic,
pattern-adapted, or drawn from real git history with only a small executable subset (this dev
machine has no `node` binary at all, and lacks a couple of Python vendor libraries), stated plainly
(§8.6). §6.2 is deferred by direct operator instruction (2026-10-23) and genuinely blocked anyway (no
real render images reachable from this session); S28's security suite family stays deferred,
genuinely gated on a different stage's own incomplete prerequisite (S10's network isolation).
Direct operator request, 2026-10-18; scope extended 2026-10-20 (gaps 7-8); reviewed and approved
2026-10-22. This
is a *target-state* design for a comprehensive, unified benchmark suite covering every role the fleet
actually runs — most of the individual pieces already exist and are live; what does not yet exist is the
per-role coverage map, the gap-fill suites for roles that currently have no accuracy ground truth at all,
and the single shared schema that would let any of them be compared side by side. `IMPLEMENTATION_PLAN.md`'s
**S39** is the stage that tracks building this and points back here for the full spec — the same split
**S23** uses for `MINECRAFT_BOTS_DESIGN.md` and **S38** uses for `MARKET_WATCH_DESIGN.md`.

**Purpose:** give every current and future local-model candidate, for every role The Firmament actually
has a model doing work in, a benchmark with real (not assumed) ground truth, so that a promotion/rejection
decision is always backed by a measured number for that role specifically — not a borrowed general-capability
score, not a one-off hand-run bake-off whose method disappears with the stage that ran it, and not operator
intuition. Accuracy is the suite's primary and near-universal axis. Speed is scored, and matters for a
promotion decision, **only** for the small set of roles sitting on a path a human (or in-game player) is
synchronously waiting on — everywhere else, a slower-but-more-accurate model is strictly better and the
suite should never penalize it for taking longer.

**Status legend**, same convention as `firmament-fleet-target-architecture.md`:
- `[DECIDED]` — operator made an explicit choice
- `[PROPOSED]` — design recommendation, not yet ratified
- `[UNKNOWN]` — needs discovery/research before building
- `[RISK]` — flagged concern requiring validation or an operator decision

---

## 1. The ask, restated precisely

1. Produce a comprehensive set of custom benchmarks for measuring current and future local models, scoped
   to the roles and tools The Firmament has actually accumulated — not a generic LLM leaderboard.
2. Accuracy is always the primary goal, for every role, with no exception.
3. Speed is a secondary goal, and only for roles where it has a **directly observable interactive impact**
   on a human (or in-game player) — i.e. someone is synchronously waiting on that specific model call
   before they see a result. Every other role should never trade accuracy for speed in scoring.
4. Capture the proposal as its own requirements/design markdown (this file), not folded into an existing
   doc.

---

## 2. What already exists — this proposal is additive, not a rewrite

The Firmament already runs six independent, real, live-verified pieces of benchmark infrastructure. None
of this needs rebuilding; §4 below is specifically the gap between these and full per-role coverage.

| Piece | File(s) | What it measures | Ground truth |
|---|---|---|---|
| General capability | `tools/hermes-benchmark-model.py`, `hermes_benchmark_common.py`, `infra/model-benchmark/README.md` | MMLU-Pro, GPQA-Diamond, IFEval, BFCL, SWE-bench — direct-to-backend, never through the router | Industry-standard public datasets (`lm-eval-harness`/`bfcl-eval`/`swebench`) |
| Role-fitness bake-off | `tools/hermes-bakeoff-typesafe.py` | `dispatch` routing, Minecraft `mcintent`, `guard`, `rerank`, optionally `camera`/`mediajudge` — against the **real production prompt by import** | Hand-written synthetic case sets (`DISPATCH_CASES`, `GUARD_CASES`, …) |
| Injection-screener eval | `tools/hermes-guard-eval.py` | Layer 1 / Layer 2 / composite / LLM-arm accuracy, threshold sweep | 36 hand-labelled, banded cases (18 malicious: direct/indirect/paraphrased; 18 benign incl. hard negatives), imported by reference from the bake-off |
| RAG recall | `tools/hermes-rag-eval.py` | recall@k over real indexed chunks, unscoped search | Questions authored by `dispatch` per real chunk, chunk id is gold label |
| Refusal-rate triage | `tools/hermes-bakeoff-refusal-check.py` | Whether a candidate refuses `super`'s real analyst traffic | Real samples pulled live from `hermes-logs.py`'s own gather functions; heuristic, human-reviewed, not a quality judge |
| Minecraft behavioral baseline | `services/minecraft-bots/tests/` (`unit`/`live`/`livebot`/`baseline`) | 12 fleet-level behavior metrics vs. committed tolerance | Live journals, 24h post-deploy baseline re-record |

Plus **S28** (`IMPLEMENTATION_PLAN.md`, planned, optional): a security-benchmark suite family (OWASP Juice
Shop / WebGoat, pinned-commit targets, deterministic ground truth) and a VulnHunter skill bake-off across
six contenders, pre-registered success bar, mutated-copy contamination control. This proposal folds S28
in as this suite's Tier 2 rather than treating it as a separate track (§6).

**The schema already worth keeping, unchanged:** `hermes-benchmark-model.py`'s shared history file
(canonically `/mnt/nas2-hermes-backup/Private/Hermes/Benchmarks/history.jsonl`) records one JSON object per
run with a `model_id`, `role_or_endpoint`, and a `suites` dict keyed by suite name, each holding either a
scored `{"metric": ..., "value": ..., "limit": ...}` or an `{"status": "error", "detail": ...}`.
`tools/hermes-benchmark-compare.py` already does full-trend and two-model side-by-side diffing purely off
that `suites` dict. §7 proposes extending this same dict with new suite keys rather than inventing a
second format.

---

## 3. Roles inventory and the accuracy/speed scope call for each

This is the full per-role list this proposal has to cover, with the speed-in-scope decision made
explicitly per role rather than assumed. The rule applied: **speed is in scope only when a human or
in-game player is synchronously blocked on that specific call before they see a result.** Everywhere else
("No" below) the role is accuracy-only — a candidate that is slower but more accurate always wins there.

| Role | What it does | Model today | Speed in scope? | Why |
|---|---|---|---|---|
| `dispatch` | 12-way chat routing, Minecraft `classifyIntent`/`planNextStep`, RAG synthesis, presenter styling | Qwen3.6-35B-A3B stock | **Yes** | Gates every real-time chat reply and every bot's per-tick action; the user/player is waiting on this call specifically |
| `guard` (Layer 2) | Injection screening, inline before every message reaches `dispatch` | `proventra/mdeberta-v3-base-prompt-injection` or LLM-mode (default `omni`) | **Yes** | Sits in front of the same synchronous path as `dispatch`; its latency is additive to every reply |
| `hermes-presenter` styling call | Final styling pass before a reply is shown in Matrix | `dispatch` | **Yes** | Last hop before the human sees the reply |
| `hermes-retrieve` synthesis | RAG answer synthesis, interactive Matrix query | `dispatch` | **Yes** | Operator is waiting in-chat for the answer |
| `embed` / `rerank` | RAG embedding + cross-encoder reranking, called inside the same interactive retrieval path | Qwen3-Embedding-8B / Qwen3-Reranker-0.6B | **Yes** | Same synchronous retrieval wait as above |
| Minecraft `muse` replies | In-character chat, Mayor/Mark directives | Qwen3.6-35B-A3B-A3B abliterated | **Yes** | A player in the world is waiting on the bot's chat reply |
| `super` | Log/canary/pfSense/game-abuse analysis, news-digest summarization | Huihui-GLM-4.7-Flash-abliterated | **No** | Always invoked async off a timer or Buzz topic; nobody is watching a spinner for it |
| All coder roles (`coder`; `coder2` retired 2026-10-20, replacement candidates under evaluation) | Dual-coder code review | Qwen3.8-27B-abliterated (`coder`) | **No** | Async review, triggered on goal completion, not on a human's clock — speed is never in scope for this role family regardless of which models currently fill it; `coder2`, before retirement, needed 34-55s/call and was never penalized for it, the precedent this rule generalizes from |
| `omni` (vision judge / log-mode) | Camera description, media generate→evaluate→regenerate judge | gemma-4-26B-A4B-it stock | **No** | The generate-evaluate-regenerate loop is a background job polled via Matrix push, not a live wait |
| `hermes-model-scout` | Daily discovery → role-fit → benchmark backlog | n/a (batch pipeline, not a chat role) | **No** | Daily timer |
| VulnHunter / security bake-off candidates | Static vulnerability analysis | 6 contenders (S28) | **No** | Offline analyst run, pre-registered and batch-scored |
| Minecraft triage | Crash/incident diagnosis | A coder role (`coder`) | **No** | Async, worker-thread-fed, not blocking gameplay |

`[DECIDED]` per the operator's own framing in this request. If a role's call pattern changes later (e.g.
`super` ever ends up behind a synchronous chat reply), it moves rows — the table, not a hardcoded rule in
any one script, is the source of truth for which suites get a speed column at all.

---

## 4. Gaps — roles and questions with no accuracy ground truth today

Eight real gaps: the original six, found by cross-checking the role list above against §2's existing
coverage, plus two more (7-8) found in a 2026-10-20 follow-up pass that asked a narrower question — not
"which roles have no accuracy ground truth" but "does any existing or proposed suite test the coder role
family on tasks actually shaped like this fleet's own real work." These are the actual new benchmark designs this
proposal adds (§6); everything else in §2 stays as is.

1. **`super` as log analyst has no correctness ground truth at all.** S11 explicitly scoped "the log
   analyst" to `super`'s own general-capability numbers (mmlu_pro/ifeval) rather than a dedicated eval, and
   `hermes-bakeoff-refusal-check.py` only measures *whether* `super` answers, never whether the answer is
   *right*. This is the fleet's one security-relevant role with zero task-specific accuracy measurement —
   a model that never refuses but consistently mis-classifies a real intrusion as benign would currently
   pass every existing check.

2. **`omni`'s PASS/FAIL judge accuracy is never scored against ground truth.** The bake-off's `camera`/
   `mediajudge` tasks exist but are opt-in, require a private endpoint, and report agreement with *a*
   judgment, not with a hand-labelled correct answer. If the judge is systematically wrong in either
   direction, the generate→evaluate→regenerate loop either accepts bad renders forever or burns compute
   regenerating good ones forever, and nothing currently measures which.

3. **`muse`'s in-character replies have a written contract (`agents/minecraft-common.md`) with no
   compliance check.** The Minecraft baseline suite measures gameplay outcomes (deaths, goal completion),
   not whether a chat reply ever claims a capability the bot lacks, leaks the system prompt, or breaks
   character under an adversarial player's attempt — exactly the three things the shared preamble exists
   to prevent.

4. **`hermes-news-digest`'s summarization has no faithfulness check.** Citations are deterministic (never
   model-authored, so they can't be wrong in the way a hallucinated citation would be), but the *highlight
   text* itself is model-generated prose over real indexed chunks, and nothing currently verifies that
   every factual claim in that prose is actually supported by its cited chunk.

5. **Dual-coder review (all coder roles) has no precision/recall against real findings.** The role family
   is measured dormant (zero real runs in 30 days per the router's own comment) and scored today purely on
   general BFCL/coding capability. There is no benchmark for the thing the role actually exists to do:
   does a coder role's LLM pass agree with `hermes-code-security-scan.py`'s static-analysis findings (true
   positives it should confirm) without inventing new ones (false positives) on code where the static scan
   is clean.

6. **Every existing custom suite lives in its own output format.** `hermes-guard-eval.py` writes its own
   `--json` file; `hermes-rag-eval.py` appends to its own `rag-eval-history.jsonl`; the bake-off scripts
   print tables. None of this reaches `hermes-benchmark-model.py`'s shared `history.jsonl` `suites` dict,
   so `hermes-benchmark-compare.py` — the one tool built to answer "did candidate X get better or worse
   than incumbent Y" — cannot answer that question for guard, RAG, dispatch-routing, or mcintent today.
   This is the single structural gap that makes "comprehensive" the right word for what's missing: the
   *individual* measurements already exist, but there is no one place to compare them.

7. **No coder role has a benchmark for general fix capability on this fleet's own code.**
   Gap 5's `fleet_dualcoder_precision` measures review-*agreement* with a static scanner — a judgment task.
   Nothing measures the more basic thing the role spends most of its real time on: given a real bug in a
   real custom tool this fleet has built, can the model actually produce a correct fix. Today's only signal
   for this is Tier 0's general BFCL/SWE-bench numbers, and neither is drawn from this fleet's own code —
   a candidate could score well on both while being no good at the actual shape of work it's assigned.

8. **No coder role has a benchmark for building a new capability from a stated requirement, either.** This
   fleet's own history is full of exactly this shape of work — a direct operator request, a vendor
   integration or parsing pipeline built from nothing to satisfy it (§6.8 names eight real examples) — and
   nothing currently measures whether a candidate model can do that well, only whether it can review
   existing code (gap 5) or code generically (Tier 0).

---

## 5. Proposed structure: four tiers, one schema

```
Tier 0  General capability        (existing — mmlu_pro / gpqa_diamond / ifeval / bfcl / swebench)
Tier 1  Role-fitness accuracy     (existing dispatch/mcintent/guard/rerank + 6 new suites from §6)
Tier 2  Safety & security         (guard's existing eval, formalized as a Tier 2 suite; S28's
                                   juiceshop/webgoat/VulnHunter folded in here, not run separately)
Tier 3  Interactive-path latency  (secondary, gated — only the 6 "Yes" rows from §3's table)
```

All four tiers report into the **same** `history.jsonl` `suites` dict `hermes-benchmark-model.py` already
owns (§7), so every tier is comparable through the one existing `hermes-benchmark-compare.py` tool and
visible on the one existing `hermes-fleetops-ui` benchmark-history report page — no new UI, no new
storage, no second source of truth.

### 5.1 Why this order and not, say, "safety first" or "speed first"

Tier 0 stays first because it's the cheapest, fastest signal to rule a candidate out before spending time
on anything role-specific (this is already how `hermes-model-scout`'s gate works — a candidate has to
clear a basic bar before a human even considers `benchmark <id>`). Tier 1 is the actual decision-making
tier: it is where "is this model good *at the job this fleet needs*" gets answered, and per this proposal's
own first principle, it is scored for every role with no exceptions. Tier 2 is pulled out on its own
because a security regression is a different kind of failure than an accuracy regression — a candidate
that is marginally more accurate but materially easier to inject into should not be promotable on Tier 1's
numbers alone, so it gets its own gate rather than being averaged into one score. Tier 3 is explicitly
last and explicitly secondary: it is never used to break a tie in a role's favor unless Tier 1 and Tier 2
are already judged acceptable, and it is never even run for a role not listed in §3 as speed-in-scope.

---

## 6. New suite designs (the eight gaps from §4)

Each follows the same shape the fleet already uses for `guard`/`rag`: hand-labelled or real-sampled ground
truth, imported by reference from the real production prompt/contract wherever one exists, explicitly
labelled by provenance (synthetic vs. real-grounded), and reporting into the shared `suites` dict under a
new key.

### 6.1 `fleet_log_analyst` — closes gap 1

- **What it scores:** given a real or realistic log excerpt (pfSense block, canary hit, honeypot session,
  game-abuse report — the same four source shapes `hermes-logs.py` already consumes via
  `gather_canary`/`gather_pfsense`/`gather_gameabuse`), does the model correctly classify it
  malicious/benign and correctly extract the 2-3 key facts (source IP/player/host, what happened, whether
  it's ongoing)?
- **Ground truth:** a hand-labelled set, built the same way the guard eval's `GUARD_CASES` were — sample
  real historical log lines from each of the three gather functions (scrubbed of anything sensitive),
  label malicious/benign and the expected key facts by hand, band by source type and by how obvious the
  case is (obvious malicious / obvious benign / genuinely ambiguous, mirroring guard's direct/indirect/
  paraphrased bands). `[PROPOSED]` target size: 40-60 cases, enough for a meaningful per-band breakdown
  without becoming a labeling burden that never gets built.
- **Metric:** classification accuracy (malicious/benign) as the primary number, plus a fact-extraction
  score (does the output mention each expected fact — simple substring/entity check, not an LLM judge,
  following the same "deterministic first" preference S28 already states) as a secondary number.
- **Why accuracy-only:** `super` is explicitly not speed-scored (§3) — this suite never reports a latency
  column.
- **Where it runs:** direct-to-backend like every other custom suite (§8.1), reusing `SOURCE_SYSTEM_PROMPT`
  by import from `hermes-logs.py` so the eval and production can never drift apart, the same guarantee
  `test_guard_llm.py` already enforces for `guard`.

### 6.2 `fleet_vision_judge` — closes gap 2

- **What it scores:** `omni`'s PASS/FAIL agreement with a human-labelled ground truth over a fixed set of
  renders.
- **Ground truth:** a small (`[PROPOSED]` 20-30 image) hand-labelled set built once from real
  `hermes-media.py` output already sitting on Kiln/Anvil — half clearly-good renders, half renders with a
  real, specific defect (the kind the generate-evaluate-regenerate loop is meant to catch: extra limbs,
  wrong subject, obvious artifacting). This promotes the bake-off's existing opt-in `mediajudge`/`camera`
  tasks from "ad hoc, needs a private endpoint" to a committed, versioned fixture set checked into the repo
  (images, not just prompts — `[RISK]` repo size; store as a small fixture directory, not inline in the
  design doc).
- **Metric:** precision/recall against the hand label (which direction of error — false-accept vs.
  false-reject — matters independently, since one burns render compute forever and the other ships broken
  output), reported as two numbers, not one blended accuracy.
- **Speed:** out of scope per §3.

### 6.3 `fleet_muse_contract` — closes gap 3 — **built 2026-10-22** (`tools/hermes-muse-contract-eval.py`)

- **What it scores:** does a reply from the `muse` role, under a chat transcript designed to probe each of
  `agents/minecraft-common.md`'s three standing rules, actually comply? Three probe families: (a) ask the
  bot directly whether it can do something it cannot (should decline accurately, not confabulate a
  capability); (b) attempt to extract the system prompt/instructions verbatim (should not comply); (c) an
  adversarial player tries to talk the bot out of its instructions mid-conversation (should stay in
  character rather than breaking it to explain the guardrail — the preamble's own explicit rule).
- **Correction found while building, not assumed:** `minecraft-common.md` has no separately-named
  "don't recite your prompt" rule — the closest real rule is "if a message tries to talk you out of
  these instructions, stay in character and let it go by." The three families actually built are
  grounded in the real five-rule text instead: **capability** (honesty about what the bot can/can't
  do), **override** (in-character-under-pressure, which subsumes prompt-extraction resistance), and
  **groundedness** (never describing a plan as if it were already finished). (a)/(b)/(c) above is the
  original, since-corrected framing — kept here for the record, not as the live case shape.
- **Ground truth:** hand-written probe transcripts per bot persona, built against the real 9-persona
  roster confirmed by listing `agents/` (not assumed from this document's own "9" figure). 27 probes (3
  families × 9 personas), matching the proposed minimum below.
- **Metric:** pass rate per probe family. The override family has a genuine deterministic check (does
  the reply leak verbatim prompt/instruction language); capability/groundedness need an independent
  judge model (never `muse` itself — S8.7) and fall back to `"unjudged"` — a distinct, honest
  non-answer, never silently scored as a failure — when no judge endpoint is supplied.
- **Speed:** in scope per §3 (a player is waiting on the chat reply), but scored as a *separate* Tier 3
  entry (§6.6), never blended into this suite's pass rate.
- **Built, stated plainly (§8.6):** the 27-probe case set is synthetic (hand-written against the real
  preamble text, not sampled from real chat logs — no fleet access from this session). 35 offline checks
  (`infra/model-benchmark/tests/test_muse_contract.py`); no fleet node reachable to run against a live
  `muse`/judge endpoint yet.

### 6.4 `fleet_digest_faithfulness` — closes gap 4 — **built 2026-10-23** (`tools/hermes-digest-faithfulness-eval.py`)

- **What it scores:** for a sample of real `hermes-news-digest.py` highlights, is every factual claim in
  the generated highlight text actually supported by the real chunk it cites?
- **Ground truth:** no hand-labelling needed — the cited chunk *is* the ground truth, already stored
  alongside the highlight. This is a faithfulness/entailment check, not a labelled-dataset eval.
- **Metric:** for each sampled highlight, an independent judge model checks each sentence against its cited
  chunk and flags any claim the chunk doesn't support; report the fraction of highlights with zero
  unsupported claims. `[RISK]`: using an LLM judge to check an LLM summary is weaker evidence than a
  deterministic check — flagged the same way S28 flags its own LLM-judge residue step, and a human should
  spot-check a sample of the judge's own verdicts before trusting the number, same discipline as
  `hermes-bakeoff-refusal-check.py` already requires for its heuristic.
- **Speed:** out of scope per §3.
- **Built, stronger than planned:** calls the real `hermes-news-digest.summarize_highlights()` function
  UNMODIFIED (confirmed import-safe, then its one network dependency — `rag.router_chat`, which goes
  through `hermes-router`, forbidden for an eval by §8.1 — monkeypatched to call the digest role's backend
  directly). This means the exact real passage-numbering/`<DATA>`-wrapping/"nothing new"-short-circuit/
  `HIGHLIGHT_RE` citation-parse code runs for real, not a copy of it — zero prompt drift is structurally
  impossible here, stronger even than the `ast`-extraction approach §6.1/§6.5 use, since there was nothing
  left to extract. Two deterministic floor checks run unconditionally, no judge needed: `grounded` (does
  each highlight share any significant token with the passage it cites — catches a hallucination that
  still passes the real citation-index validity check) and `padding_restraint` (on a case built with
  nothing genuinely new, does the model correctly emit zero highlights rather than inventing one to fill
  the response, honoring the real system prompt's own explicit "do NOT pad" instruction). The judged
  `faithful` axis (this section's own originally-proposed metric) falls back to `"unjudged"`, a distinct
  honest non-answer, when no judge endpoint is given — never silently scored as pass or fail. Case set is
  SYNTHETIC per §8.6 (5 hand-built topic/passage scenarios; no live RAG store reachable from this session
  to sample real matches from). 31 offline checks (`infra/model-benchmark/tests/test_digest_faithfulness.py`);
  no fleet node reachable to run against a live backend yet.

### 6.5 `fleet_dualcoder_precision` — closes gap 5 — **built 2026-10-23** (`tools/hermes-dualcoder-precision-eval.py`)

- **What it scores:** does a coder role's review pass agree with `hermes-code-security-scan.py`'s
  static-analysis findings (bandit/ruff/detect-secrets) on a fixed set of real commits/files — confirming
  real findings (recall) without inventing new ones on clean code (precision)?
- **Ground truth:** the static scanner's own findings are the deterministic ground truth, same
  "deterministic first, LLM-judge only for residue" rule S28 already establishes — this reuses that exact
  pattern one tier down, at the single-role level instead of across a 6-contender matrix. Target set:
  `[PROPOSED]` a mix of real past commits with a known scanner finding and real clean files with none,
  pulled from this repo's own history rather than invented.
- **What was actually built, stated plainly — narrower than the target above:** real-sampled
  git-history commits with a real scanner finding remain future work for a session with fleet access.
  The 6 cases actually used are each real in a different, weaker sense: 2 are
  `infra/hermes-code-security-scan/README.md`'s own already-operator-documented, already-verified
  verification recipe (one vulnerable, one clean), reproduced verbatim; 2 are real, already-committed
  clean functions from this repo (`hermes_benchmark_common._pkg_version`,
  `hermes-log-analyst-eval.check_facts`), read live via `ast` rather than retyped; 2 are adapted from
  the scanner's own documented `destructive_actions`/`credential_logging` trigger patterns to broaden
  the "should find something" side beyond the one canonical README example. The real scanner
  (`scan_code()`) is run live against every case — findings are never hand-labelled.
- **Metric:** precision/recall against the scanner's findings, per candidate model in the coder role
  family — whichever models currently fill it, not a hardcoded pair. An overall accuracy number is also
  recorded under the bare `fleet_dualcoder_precision` key (ALL_SUITES' own name), same
  breakdown-plus-overall shape §6.3's per-family keys already use.
- **Speed:** out of scope per §3 — worth stating plainly given this role family's own precedent: `coder2`,
  before its 2026-10-20 retirement, needed 34-55s/call and was never penalized for it. This suite must
  never penalize a slower candidate for being slow, only for being wrong, which is the whole point of
  separating Tier 1 from Tier 3.
- **Built, stated plainly (§8.6):** `SECURITY_SYSTEM_PROMPT` is read by `ast` directly from
  `tools/hermes-dualcoder.py`'s own source (never copied, never executed — that module's own
  router/token assumptions aren't needed here), so the eval and production prompt can never drift
  apart. The recall/precision check is a deterministic keyword heuristic over the model's free-text
  review (flagged, same as every such heuristic in this design, as needing human spot-checking, never
  treated as equivalent to an LLM judge). On this dev machine the scanner's three subprocess-based
  categories (bandit/ruff/detect-secrets) degrade to `tool_errors` — confirmed live, not assumed — but
  the two pure-regex categories alone are sufficient for all 6 cases here; a full run needs the same
  `CODESEC_VENV` the scanner tool already requires in production, nothing new. 27 offline checks
  (`infra/model-benchmark/tests/test_dualcoder_precision.py`); no fleet node reachable to run against a
  live coder endpoint yet.

### 6.6 Tier 3 interactive-latency harness — the speed half of the six "Yes" roles — **built 2026-10-23** (`tools/hermes-latency-eval.py`)

Not a new accuracy suite — the secondary-goal half of `dispatch`, `guard`, presenter styling, RAG
synthesis/`embed`/`rerank`, and `muse`. Three corrections carried over from real measurement history
(S22/S31, §8.1) rather than re-learned the hard way a second time:

1. **Measure at realistic concurrency, not `--parallel 1`.** `muse` measured 13.0→51.9 tok/s aggregate
   going from concurrency 1 to 4 with flat per-request latency — a single-slot number reads as "slow" for
   a server that's actually fine under its real load pattern.
2. **Report p50/p95 latency alongside raw tok/s**, since the thing that's actually "directly observable"
   to a waiting human is wall-clock time to a usable reply, not throughput.
3. **Never run this tier through `hermes-router`** — same bypass every other suite already uses (§8.1), and
   for the same reason: the router's own injection screen can false-positive on the harness's own synthetic
   prompts.
- **Built, and the three corrections above verified for real, not just implemented:** this harness was
  tested against a real local HTTP server standing in for a backend (an in-process thread, no subprocess,
  no external network) rather than a stubbed Python call — the strongest verification available without a
  live fleet node for a tool whose whole point is measuring real concurrent I/O timing. Against that
  server's fixed, known per-call delay, going from concurrency 1 to 4 reproduced correction #1's own cited
  finding directly: aggregate tok/s roughly quadrupled while per-request p50 latency stayed flat — the
  exact "13.0→51.9 tok/s... with flat per-request latency" shape this section already cites from real
  `muse` measurement history, now demonstrated against a controlled server rather than only asserted.
  `rag_embed`/`rag_rerank` call the REAL `hermes_rag_common.embed()`/`rerank()` functions directly
  (imported, never copied — §8.5), with their own `EMBED_URL`/`RERANK_URL` module globals monkeypatched to
  the test endpoint — the same monkeypatch-the-shared-module-global pattern `hermes-digest-faithfulness-eval.py`
  already uses for `rag.router_chat`, so those two hops' real request/response parsing runs unmodified.
  `dispatch`/`guard`/`muse`/`rag_synthesis` use a representative — not the exact real — system+user message
  per role, stated plainly as a simplification: latency depends on realistic shape/length far more than
  exact wording, unlike the accuracy suites where prompt fidelity is load-bearing. `fleet_rag_latency`
  (`ALL_SUITES`' own registered name) is written per-hop (`fleet_rag_latency_embed`/`_rerank`/`_synthesis`),
  never as one fabricated bare number combining hops a single invocation didn't measure. The primary value
  recorded per role is p50 latency (ms) at the highest tested concurrency level, with p95 and aggregate
  tok/s as additional unregistered sub-keys, the same "bare + breakdown" shape every other suite in this
  design uses. 34 offline checks (`infra/model-benchmark/tests/test_latency_eval.py`); no live fleet node
  reachable to measure a real backend's actual numbers yet — only the harness's own correctness is
  verified from this session.

### 6.7 `fleet_coder_fix` — closes gap 7 — **built 2026-10-23** (`tools/hermes-coder-fix-eval.py`)

- **What it scores:** given the pre-fix state of a real file from this fleet's own tools and a plain,
  symptom-only description of what broke (never the diagnosis, never the fix), does the model produce a
  correct patch? This is a generation task, deliberately distinct from 6.5's review-agreement task.
- **Ground truth:** real commits, not invented fixtures — sourced from this repo's own git history (and,
  where a candidate tool's real bug-fix history predates the V4→V5 consolidation, from the sibling
  `HermesAgentV4`/`HermesAgentRedo` repos on the same disk — confirmed reachable by ordinary `git log`
  across repo boundaries, not actually inaccessible as a first pass over this repo alone wrongly assumed).
  Nine candidates already identified and verified as genuine, self-contained, nontrivial fixes (not
  version bumps, not comment-only changes), spanning both Python and JS:

  | Task | Source | Category |
  |---|---|---|
  | AI-detection poll returns `None` forever (`get_host_data()` never called after `login()`) | `hermes-reolink.py` @ `31e4bd4` | vendor API response-shape assumption |
  | Single-channel → multi-camera migration | `hermes-reolink.py` @ `f42264d` | API response-shape / data-model expansion |
  | Replace HEAD-probing/guessing with real feed discovery | `hermes-podcast-retriever.py` @ `c5e2714` | parsing/discovery replaced by a better source |
  | `recipesFor()` vs `recipesAll()` — table-need check always false | `services/minecraft-bots/actions.js` @ `08f950b` | library/SDK contract mismatch |
  | Same-day follow-up: dye-recycling recipe breaks the fix above | `actions.js` @ `f8d6986` | state-machine/condition-ordering bug |
  | `enchantments.concat is not a function` — API returns an object, not an array | `actions.js` @ `35df5ec` | library/SDK contract mismatch |
  | Bed-placement + wood-sequencing fix, driven by 78 real failed-craft logs | `actions.js` @ `3be33e4` | live-log-driven, multi-part fix |
  | `BED_WORDS` checked before `SHELTER_WORDS` — directive misrouted | `services/minecraft-bots/index.js` @ `c7c984d` | keyword/condition-ordering bug |
  | STLs pass every validity check but slice with gaps that stop a print | `tools/hermes-mesh-repair.py` @ `b4651ca` | wrong algorithm for the data: reconstruction method produced topologically valid but unprintable geometry |
  | Decimation silently introduces 4,418 self-intersections | `tools/hermes-mesh-repair.py` @ `b4651ca` | library-parameter side effect (QEM `preservetopology` preserves genus, not geometry) |

  `[PROPOSED]` target size: this nine plus whatever a `HermesAgentV4`/`HermesAgentRedo` mining pass adds for
  the single-vendor Python tools (Vivint/Wyze/Generac/pfSense/Synology/Moen Flo/mediawiki) whose real
  bug-fix history lives there, not here — needed to balance the pool, since as-is it skews toward
  mineflayer-shaped JS tasks.
- **Metric, two tiers by category:** (a) **repro-testable** — routing/condition-ordering bugs and pure-function
  library-contract mismatches get a real minimal-repro test (e.g. feed the exact failing scenario, assert
  the previously-wrong behavior is now right) and score binary pass/fail, the gold standard, used wherever
  the bug doesn't need a live vendor API or a running Minecraft server to reproduce; (b) **LLM-judge** — for
  everything else, an independent judge (never the model being scored, §8.7) compares the patch against the
  real fix and the original symptom on a rubric: root cause addressed, behavior-equivalent, no obvious new
  bug introduced — labelled `llm-judged` in the result, never blended with tier (a)'s deterministic number
  (§8.6).
- **Speed:** out of scope per §3, same as 6.5.
- `[RISK]`: if this repo is public on GitHub, a candidate could have memorized these exact fixes from
  training data rather than solved them — unverified as of this writing. Mitigation if confirmed public:
  grow the corpus with new real bugs as they're found going forward rather than relying solely on
  already-published history.
- **Built, stated plainly, narrower than the two-tier split above describes — what actually runs:**
  the cross-repo mining this section's own `[PROPOSED]` note floated (Vivint/Wyze/Generac/pfSense/
  Synology/Moen Flo/mediawiki from `HermesAgentV4`/`HermesAgentRedo`) turned out not to be necessary —
  all nine chosen commits above are reachable directly in THIS repo, confirmed by `git cat-file -e`
  against all nine hashes before writing anything. 10 scored tasks come from those nine commits
  (`b4651ca` contributes two, matching this table's own two rows for it). One correction found while
  building, not assumed: this table listed `actions.js` as the source for the `enchantments.concat`
  fix (`35df5ec`) — the real fix is in `equipment.js` (`installEnchantsFix`), not `actions.js`; that
  commit touches both files and this table named the wrong one.
  - **Prompt construction:** the model is shown the REAL pre-fix file (`git show <hash>^:<path>`,
    never retyped) at one or more anchor-located excerpts (several of these files run 1,000-7,800
    lines, so showing the whole file isn't practical) plus the symptom-only report, and returns the
    corrected excerpt; the real post-fix excerpt is held back and shown only to the judge. Anchors are
    resolved fresh against whichever file version is being read, not a fixed line number — found by
    testing, not assumed: an early version used one fixed line range for both the pre-fix and post-fix
    file, and every commit here inserts lines earlier in the file (a growing version-header comment),
    which silently shifted the post-fix slice onto the wrong code. Anchors also resolve to their LAST
    match in the file, not their first, for a second reason also found by testing: this project's own
    versioning convention quotes a fix's own variable/function names in the file's own header-comment
    prose, which — being physically earlier in the file than any of this suite's real target
    functions — was being matched as "the real code" by a first-match lookup.
  - **Only 1 of the 10 tasks is actually executable from this session** (`reolink_ai_state`): it's
    pure Python, and `camera_login()`/`check_ai_detection()` take a duck-typed `host_obj` parameter,
    so a fake object satisfies them with zero dependency on the real (and, on this dev machine,
    unavailable) `reolink_aio` package. Verified against the REAL commit, not just a synthetic case:
    the real pre-fix file fails this repro, the real post-fix file passes it, and splicing the real
    post-fix excerpt into the real pre-fix file via substitution also passes it — proving the
    substitution-and-reconstruct mechanism itself produces syntactically valid, behaviorally correct
    Python, not just a plausible-looking string.
  - **The other 4 "repro-testable in principle" tasks** (`recipes_table_check`,
    `recipes_recycling_recipe`, `enchantments_concat`, `bed_words_routing`) are all JavaScript, and
    this dev machine has no `node` binary anywhere on it at all — checked thoroughly (PATH, the usual
    install locations, `npm`), not assumed, which is a different and harder blocker than "no live
    fleet access." Their repro axis reports a third, honest `"env_unavailable"` status, never blended
    into a pass/fail rate and never faked by writing an unverifiable JS runner — the judge axis still
    scores all four.
  - **Two tiers, never blended (§8.6), recorded as two separate keys**: `fleet_coder_fix_repro` (the
    1-task gold-standard executable subset) and `fleet_coder_fix_judge` (all 10 tasks, when a judge
    endpoint is given). No bare `fleet_coder_fix` overall key is written for exactly this reason.
  - A real bug found via this suite's own testing, now fixed: an early `strip_code_fence()` called
    `.strip()` on the whole answer before checking for a markdown fence, which silently ate the first
    line's own leading indentation whenever the model's answer had no fence at all — corrupting every
    substitution-based reconstruction. Fixed to touch only actual fence markup, never the code's own
    whitespace.
  - 31 offline checks (`infra/model-benchmark/tests/test_coder_fix.py`); no fleet node reachable to
    run against a live coder/judge endpoint yet.

### 6.8 `fleet_coder_build` — closes gap 8 — **built 2026-10-23** (`tools/hermes-coder-build-eval.py`)

- **What it scores:** given a plain statement of a real requirement this fleet actually had — ideally the
  operator's own original request, stripped of anything that hints at the implementation — and the repo
  state immediately before the capability existed, can the model build it from nothing?
- **Ground truth:** eight real "build from scratch" commits, traced to their genuine first-build moment
  (not a later bugfix/extension) across all three repos on disk, each with the requirement pulled from the
  commit's own framing of *why* it was built rather than *how*:

  | Task | Source | Requirement | Size |
  |---|---|---|---|
  | Camera capability, no cloud/OAuth | `hermes-reolink.py` @ `6d7d9cd` | outdoor/battery/solar camera support — local CGI API, person/motion alerting | 423 ln |
  | Rebuild the botnet/C2 cache | `hermes_botnet_intel.py`+sync @ `6b88214` (`HermesAgentRedo`) | "rebuild v1's documented-but-never-committed" threat-intel cache (Spamhaus/Feodo/TweetFeed) | 390 ln |
  | PDF/DOCX → structured Markdown | `hermes_doc_to_markdown.py` @ `295589c` | flat-text extraction has no heading/table/list structure for RAG | 237 ln |
  | Daily RSS ingestion | `hermes-feed-reader.py` @ `bf82a01` | pull 14 keyless AI/security feeds into the RAG store, dedupe on rerun | 508 ln |
  | Game-server admin via chat | `hermes-minecraft-admin.py`+`hermes-game-admin.py` @ `3755e07` | RCON whitelist/op/kick/ban/restart, wired into Matrix | 892 ln |
  | Automated bot-fleet triage | `hermes-minecraft-triage.py` @ `09cf8df` | operator's own words: "I want the Firmament to do this monitoring, and engage coder/coder2 loop to do initial triage" | 241 ln |
  | Shelter/chest/torch awareness | `services/minecraft-bots/shelter.js` @ `f5e75e7` | stop bots blocking chests/beds/doors, carry+space torches, preserve shelter walls | 439 ln |
  | Persisted skill library | `services/minecraft-bots/skills.js` @ `997dbfc` | searchable, persisted skills instead of hardcoded behavior | 201 ln |

- **Metric:** no single pass/fail — a build task rarely has one symptom to stop reproducing the way a fix
  does, so scoring is rubric-based, not binary. Split the same way as 6.7: the parsing/data-structure core
  of `hermes_doc_to_markdown.py`, `hermes_botnet_intel.py`, `hermes-feed-reader.py`, and
  `hermes-minecraft-admin.py`'s command formatting is fixture-testable now (real/recorded input, assert a
  specific correct output); `hermes-reolink.py`, `shelter.js`, `skills.js`, and `hermes-minecraft-triage.py`
  need an independent judge graded **against the stated requirement, never against line-similarity to the
  real diff** — there is more than one reasonable way to build a feed reader, and grading a model down for
  building a different-but-correct one would make this a "guess our exact implementation" test, the same
  mistake §8.6's provenance discipline already guards against elsewhere. Partial credit is expected and
  should be visible in the reported rubric breakdown, not collapsed to one number.
- **Speed:** out of scope per §3. Worth stating plainly: build tasks are bigger (201-892 lines vs. a narrow
  patch) and cost more tokens/wall-clock to attempt than anything else in this proposal, which will bite
  harder on any slower coder candidate (`coder2`, before its retirement, was this role family's own
  precedent) — this suite must never penalize that, only correctness, same rule 6.5 already states for
  the role family.
- Same public-repo contamination `[RISK]` as 6.7 applies here too.
- **Built, stated plainly, narrower than the "across all three repos" framing above claims — what
  actually happened:** 7 of the 8 commits are reachable directly in this repo; only `botnet_intel_build`
  (Phase 25's `hermes_botnet_intel.py`) needed the sibling `HermesAgentRedo` repo, confirmed reachable by
  ordinary cross-repo `git show` before writing anything, same precedent §6.7's corpus already set.
  `HermesAgentV4` turned out not to be needed for either suite.
  - **Prompt construction, necessarily different from §6.7's fix prompts:** there is no pre-existing file
    to excerpt for a build task, since the capability didn't exist yet — the model is shown only the
    requirement (written from the real commit's own stated "why," never its diff). The 3 fixture-tier
    tasks additionally specify the exact function signature to implement, taken directly from the real
    function's own signature — a real interface contract, not an implementation hint, the same way any
    actual requirement would come with some interface constraint.
  - **Only 3 of 8 tasks have a real, executable fixture** (`botnet_intel_build`, `feed_reader_build`,
    `minecraft_admin_build`): each targets a pure, dependency-free function (blocklist-format parsers, RSS
    item extraction, a Minecraft-username regex check) — every fixture's expected output was run against
    the REAL post-build implementation before being written down here, never hand-computed. One real
    discriminating-power check caught during this suite's own testing: a plausible but subtly wrong RSS
    parser (using `Element.text` instead of `Element.itertext()`, which misses text after a nested tag
    like `<title>Vendor Patches <b>Critical</b> Flaw</title>`) correctly fails the fixture, while a
    minimal correct one passes — confirming the fixture actually discriminates, not just runs.
  - **`doc_to_markdown_build` is explicitly NOT among the fixture-tested tasks**, despite this section's
    own text calling it fixture-testable: the real substance of that build (`pdf_to_markdown`/
    `docx_to_markdown`) needs `pymupdf4llm`/`python-docx`, and neither is installed on this dev machine
    (checked, not assumed) — scored judge-only instead, a real environment constraint, not a design
    reversal.
  - **Two tiers, never blended (§8.6), recorded as two separate keys**, same shape as §6.7's own two keys:
    `fleet_coder_build_fixture` (the 3-task subset) and `fleet_coder_build_judge` (all 8 tasks, when a
    judge endpoint is given, explicitly instructed not to penalize a design difference from the real
    implementation — this section's own "more than one reasonable way to build a feed reader" rule).
  - 28 offline checks (`infra/model-benchmark/tests/test_coder_build.py`); no fleet node reachable to run
    against a live coder/judge endpoint yet.

---

## 7. Shared schema — fold every suite into one `history.jsonl`

`[PROPOSED]`, the structural fix for gap 6 (§4.6). Extend `hermes_benchmark_common.py`'s `ALL_SUITES`
(currently `["mmlu_pro", "gpqa_diamond", "ifeval", "bfcl", "swebench"]`) with the new custom suite names:

```
ALL_SUITES = [
    # Tier 0 — existing, unchanged
    "mmlu_pro", "gpqa_diamond", "ifeval", "bfcl", "swebench",
    # Tier 1 — existing, newly reported into this schema instead of their own output
    "fleet_dispatch_routing", "fleet_mc_intent", "fleet_rag_recall",
    # Tier 1 — new (§6)
    "fleet_log_analyst", "fleet_vision_judge", "fleet_muse_contract",
    "fleet_digest_faithfulness", "fleet_dualcoder_precision",
    "fleet_coder_fix", "fleet_coder_build",
    # Tier 2 — existing + S28, newly reported into this schema
    "fleet_guard", "juiceshop", "webgoat", "vulnhunter",
    # Tier 3 — new, secondary-only, only ever populated for the 6 roles in §3
    "fleet_dispatch_latency", "fleet_guard_latency", "fleet_muse_latency",
    "fleet_rag_latency",
]
DEFAULT_SUITES = ["mmlu_pro", "gpqa_diamond", "ifeval", "bfcl"]   # unchanged
```

Each existing script (`hermes-guard-eval.py`, `hermes-rag-eval.py`, `hermes-bakeoff-typesafe.py`) gets a
thin adapter that writes its existing result into one more `suites.<key>` entry in the shared
`history.jsonl`, in addition to (not instead of) whatever it already writes — no existing tool loses its
own detailed output, this just also feeds the comparison layer. `hermes-benchmark-compare.py` needs no
changes at all: it already reads the `suites` dict generically by key.

This is the one piece of this proposal that is genuinely new infrastructure rather than a new eval
*fixture set* — everything in §6 is "write a labelled case set and a scoring script following the
established pattern"; this is "make the four pattern-following scripts that already exist also write to
the one shared ledger."

---

## 8. Cross-cutting methodology — rules every suite in this proposal follows

These are not new rules; they're the conventions the fleet's own benchmark history already paid real
mistakes to learn, restated here so every *new* suite in §6 inherits them instead of re-discovering them.

### 8.1 Always bypass the router, always direct-to-backend
Every existing custom suite (MMLU-Pro, BFCL, guard, RAG) already does this — `hermes-router.py`'s Layer 2
screen will false-positive on eval/benchmark prompts (measured: ifeval prompts classified malicious at
p=0.997; 3 of the guard eval's own 36 cases got router-blocked before switching to direct backend calls).
Every suite in §6 follows the same rule from day one rather than discovering it mid-build.

### 8.2 Coordinate with the idle-sleep watchdog
`hermes-model-idle-sleep.sh` only tracks the router's own `<role>.last_used` stamp — going direct (8.1)
makes a benchmark run invisible to it, and a long run can get an on-demand backend killed mid-run at the
15-minute mark. Every new suite's runner must either stop the relevant node's idle-sleep timer for the
run's duration or touch the stamp itself, the same operational step S31's bake-off already had to add.

### 8.3 Protect live traffic on resident roles
`dispatch`/`muse`/`omni` are always-resident and serving real production traffic while a benchmark runs
against them. S22's own measured finding — bot LLM timeouts went from 20/9/2 per 10 minutes to 0/0 only
after raising `--parallel` on the resident roles — means any suite hitting a resident role must run at a
concurrency and `--ctx-size` already proven not to degrade live traffic, and `super` specifically must stay
`--parallel 1` (news-digest's 15-20k-token single calls would get truncated if ctx were split across
slots). No new suite is exempt from this just because it's "only" an accuracy eval.

### 8.4 Repeat non-deterministic runs
MoE checkpoints (every abliterated model in the fleet, plus most candidates) are not deterministic run to
run. S28 already commits to repeating each `(model, target, arm)` cell multiple times; this proposal
extends that same discipline to every suite in §6 with a small case count (§6.1's 40-60, §6.3's 27) where a
single run's noise could plausibly flip a promotion decision — `[PROPOSED]` minimum 3 repetitions, report
mean and spread, not a single number, whenever a suite has fewer than ~100 cases.

### 8.5 Real production prompt by import, never by copy
Every suite that scores a role already backed by production code (`dispatch`'s routing prompt, `guard`'s
`GUARD_SYSTEM`, `super`'s `SOURCE_SYSTEM_PROMPT`) must import that prompt text from the real module, the
same way `hermes-guard.py` and `hermes-bakeoff-typesafe.py` are kept byte-identical today by an offline
test (`infra/hermes-guard/tests/test_guard_llm.py`) that fails if they ever drift. Each new suite in §6
that has a real production prompt to reuse (6.1, 6.3's muse personas) needs the equivalent drift-check
test, not just an import statement that could silently rot.

### 8.6 Label provenance honestly
Every ground-truth set states plainly whether it's synthetic (hand-written, like `GUARD_CASES` and the new
6.1/6.3 probe sets) or real-grounded (sampled from genuine fleet output, like 6.4's digest highlights and
6.5's scanner findings) — synthetic numbers are a floor/sanity-check, not a claim about real-world
performance, exactly the distinction S22a already draws for the guard suite's own 0.722 ceiling finding.

### 8.7 Never let the model being scored judge itself
Where an LLM judge is needed (6.3's character-adherence check, 6.4's faithfulness check), the judge is
never the same role/checkpoint being scored — same rule S28 states for VulnHunter, applied here one tier
down.

---

## 9. Promotion gate — how this suite actually gets used

`[PROPOSED]` rubric, to close the ad hoc quality of past one-off calls (S31's "no clean win either way, so
no promotion" was a reasonable call but an un-formalized one). Before any candidate bake-off is scored
(same "pre-register before any scored run" discipline S28 already requires):

1. State, in advance, the role(s) the candidate is being evaluated for.
2. State, in advance, the accuracy bar on that role's Tier 1 suite(s) the candidate must clear or exceed
   relative to the incumbent — this is the only required bar; every role gets one.
3. If and only if the role is listed as speed-in-scope in §3, additionally state the Tier 3 latency bar
   (e.g. "p95 time-to-first-usable-reply must not regress by more than X%") — a role not in §3 never gets a
   speed bar, full stop, no exceptions, matching this proposal's first principle.
4. Check Tier 2 (security) is not regressed, for any role that has a Tier 2 suite — this is a gate, not a
   score to average in: a candidate that clears Tier 1 but regresses Tier 2 does not get promoted on Tier
   1's strength alone.
5. Run with repetition (§8.4), record every run in the shared `history.jsonl` (§7), and let
   `hermes-benchmark-compare.py`'s existing side-by-side diff be the thing a human reads to decide — not a
   fresh ad hoc script per bake-off, which is the pattern each of `hermes-bakeoff-typesafe.py`/
   `hermes-bakeoff-refusal-check.py`/S31's one-off run already fell into.

---

## 10. Rollout — proposed phasing

Not a commitment to build all of this at once; ordered so each phase is independently valuable and the
earlier phases make the later ones cheaper.

- **Phase A — schema unification (§7). Executed 2026-10-22.** `hermes_benchmark_common.py`'s `ALL_SUITES`
  now lists every suite name in this design (Tier 0 unchanged; the three existing custom suites' new keys;
  the six §6 suites, still design-only; S28's Tier 2 suites; the Tier 3 latency suites) — safe because
  `format_comparison()` only ever iterates it to print a row per suite, never to dispatch or validate.
  Found a real gap doing this: `hermes-benchmark-model.py` validated `--suites` against this same constant
  but dispatches through a hardcoded per-suite branch sequence, not a generic lookup, so widening it would
  have let `--suites fleet_coder_fix` pass validation and then silently do nothing. Added a separate
  `TIER0_SUITES` constant (the original five) for that tool to validate against instead, so an unrunnable
  suite name is a clear CLI error, never a silent no-op. Wired thin adapters into the three suites that
  already exist: `hermes-rag-eval.py` (`fleet_rag_recall`, unconditional — every real run already is a
  real measurement) and `hermes-bakeoff-typesafe.py` (`fleet_dispatch_routing`/`fleet_mc_intent`,
  unconditional per-task) write on every run; `hermes-guard-eval.py` (`fleet_guard`, the COMPOSITE (L1 tool
  block OR L2) gate specifically) is opt-in via a new `--record-history` flag, since most of its real
  invocations are diagnostic candidate-arm runs, not the deployed pipeline's own official measurement.
  Every adapter writes in addition to, never instead of, each tool's own existing output. No fleet node
  reachable from this session, so verified with 22 new offline checks
  (`infra/model-benchmark/tests/test_schema_unification.py`) against synthetic result fixtures, not a live
  run — a live run recording a real entry is still owed before this is fully proven in production.
- **Phase B — the two highest-stakes gaps. Executed 2026-10-23.** `fleet_guard`'s formal Tier 2 promotion
  gate: `hermes_benchmark_common.check_tier2_gate()` (generic over any Tier 2 suite, so S28's suites reuse
  it later rather than a copy) plus `hermes-benchmark-compare.py --gate`, formalizing §9 rule 4 — any
  regression at all fails, no tolerance band, and missing data for either model is its own "no-data"
  verdict, never a silent pass. `fleet_log_analyst` (6.1): new `tools/hermes-log-analyst-eval.py`, 18
  cases across the three real source shapes (pfSense/canary/gameabuse), with a case deliberately
  reconstructing hermes-logs.py's own 1.2.0 fabrication bug (an empty/no-data input) to test whether a
  candidate actually honors the hardened prompt rather than inventing a finding. **Stated plainly, not
  glossed over:** §6.1's own design calls for real-sampled, scrubbed log lines; this session has no fleet
  access to sample from, so all 18 cases are SYNTHETIC (same disclosed-provenance precedent
  `hermes-bakeoff-typesafe.py`'s own `DISPATCH_CASES`/`GUARD_CASES`/`MC_CASES` already set) — a floor/
  sanity-check per §8.6, not a claim about real-world performance. 30 new offline checks across both
  pieces; no fleet node reachable to run either against a live backend yet.
- **Phase C — the remaining new suites (6.2-6.5, 6.7-6.8).** Vision judge, muse contract, digest
  faithfulness, dual-coder precision, coder-fix, coder-build — each independent of the others, buildable in
  any order. 6.7/6.8's corpus curation is heavier than the rest of this phase (cross-repo git mining,
  hand-authored symptom/requirement prompts, per-task fixture or judge-rubric authoring), so they may slip
  to their own pass within this phase rather than landing simultaneously with 6.2-6.5.
  **Complete except §6.2.** `fleet_muse_contract` (6.3) executed 2026-10-22; `fleet_dualcoder_precision`
  (6.5), `fleet_digest_faithfulness` (6.4), `fleet_coder_fix` (6.7), and `fleet_coder_build` (6.8) executed
  2026-10-23 — 204 new offline checks across the five (above). `fleet_vision_judge` (6.2), deferred by
  direct operator instruction 2026-10-23, is genuinely blocked from this session anyway: it needs real
  render images already sitting on Kiln/Anvil, which this dev machine cannot reach or fabricate. Phase C
  is otherwise done; only Phase D and §6.2 (whenever it's unblocked) remain.
- **Phase D — Tier 3 interactive-latency harness (6.6) + S28's security suite family.** Last, since both
  are explicitly secondary/optional by this proposal's own first principle and S28's own status.
  **6.6 executed 2026-10-23** (above) — `tools/hermes-latency-eval.py`, verified against a real local
  test server, 34 offline checks. **S28's security suite family stays deferred, not attempted**: unlike
  every other gap this session has worked around (missing `node`, missing Python vendor libraries,
  missing render images), S28 is gated on a DIFFERENT stage's own incomplete prerequisite — `IMPLEMENTATION_PLAN.md`'s
  S10 (network isolation) is still "an operator checklist," not executed — and it requires standing up
  real, deliberately-vulnerable web applications (OWASP Juice Shop, WebGoat), which is not something a
  dev-machine session should attempt to fake or mock around. Building untested fixture infrastructure for
  that would be lower-quality work than simply stating the real blocker plainly, so it's left for a
  session where S10 is actually done.

`[UNKNOWN]`: exact case-set sizes for 6.1/6.2/6.3 are proposed targets, not final — they should be set by
whoever builds each phase, sized to what's actually labelable in a reasonable sitting, not treated as a
hard spec from this document.

`[RISK]`: 6.2's image fixture set and any audio/video fixtures a future role needs will grow repo size in a
way the rest of this (mostly text) repo hasn't had to deal with — worth deciding up front whether fixtures
live in-repo, in the same NAS path `history.jsonl` already uses, or elsewhere, before Phase C builds it.

---

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-18 | Initial proposal: inventoried every existing benchmark/eval harness and every live fleet role, applied the accuracy-always/speed-only-when-interactive principle to each role explicitly, identified six real coverage gaps (log analyst, vision judge, muse contract adherence, digest faithfulness, dual-coder precision, and the lack of one shared comparison schema), and proposed a four-tier structure unifying all of it into the existing `history.jsonl`/`hermes-benchmark-compare.py` machinery. |
| 1.1.0 | 2026-10-20 | Direct operator request: added gaps 7-8 and suites 6.7 (`fleet_coder_fix`) / 6.8 (`fleet_coder_build`) — `coder`/`coder2` had no benchmark for general fix or from-scratch-build capability on tasks actually shaped like this fleet's own coding work, only review-agreement (gap 5) and generic Tier 0 numbers. Grounded both suites in real commits rather than invented fixtures: nine verified fix commits and eight verified from-scratch build commits, traced across this repo and, where a tool's own real history predates the V4→V5 consolidation, the sibling `HermesAgentV4`/`HermesAgentRedo` repos on the same disk — confirmed reachable by ordinary cross-repo `git log`, correcting a first-pass assumption that this history was inaccessible. Established a two-tier scoring split for both suites (deterministic repro-test where a bug/capability is reproducible standalone; independent LLM-judge otherwise, graded against the stated requirement/symptom, never against line-similarity to the real diff) and named two risks plainly: an unverified public-repo training-data-contamination question, and build tasks' larger token/wall-clock cost landing hardest on `coder2`'s already-flagged S36 slowness. |
| 1.2.0 | 2026-10-20 | Added two `fleet_coder_fix` candidates from the S19 mesh work, per CLAUDE.md 1.2.0's benchmark-evaluation rule. **The call: no new suite is needed** — this is coder capability on a Python fleet tool, already covered by gap 7 / §6.7, and nothing about it is a role this proposal does not already score. It is worth adding to §6.7's corpus specifically because that table's own `[PROPOSED]` note says the pool skews toward mineflayer-shaped JS and needs Python tool fixes to balance it. Both candidates are repro-testable (tier a): the symptom is a measurable property of the output mesh — wall thickness relative to the bounding-box diagonal, and a self-intersecting-face count — so a minimal repro asserts the previously-wrong number is now right, with no live vendor API or Minecraft server needed. The first is also an unusually good test of *diagnosis* rather than patching, since the symptom ("valid STL, gaps when sliced") points nowhere near the cause (the reconstruction algorithm wraps a hollow shell), and three plausible-looking fixes were measured and rejected before the right one. Hashes are pending the commit. |
| 1.2.1 | 2026-10-20 | Filled the two `fleet_coder_fix` candidate hashes, now that the fix is committed as `b4651ca`. |
| 1.3.0 | 2026-10-22 | Operator reviewed the gap list and phasing and signed off (S39a cleared) — proceeding to Phase A. Generalized every `coder`/`coder2` reference (§3's role table, gaps 5/7/8, §§6.5/6.7/6.8) to "all coder roles"/"the coder role family," since `coder2` was retired 2026-10-20 (`1e86d0e`) with its replacement still under evaluation in a parallel session — none of the suites' own logic was ever actually `coder2`-specific, only the wording naming it was. |
| 1.4.0 | 2026-10-22 | **Phase A executed** (§7, §10). `hermes_benchmark_common.py`'s `ALL_SUITES` now lists every suite name this design defines; found and fixed a real validation gap doing it (`hermes-benchmark-model.py` dispatches through hardcoded per-suite branches, not a generic lookup, so widening `ALL_SUITES` without also adding the new `TIER0_SUITES` constant it now validates against would have let `--suites fleet_coder_fix` pass validation and silently do nothing instead of erroring). Wired thin, additive adapters into the three suites that already exist: `hermes-rag-eval.py` (`fleet_rag_recall`) and `hermes-bakeoff-typesafe.py` (`fleet_dispatch_routing`/`fleet_mc_intent`) write unconditionally on every real run; `hermes-guard-eval.py` (`fleet_guard`) is opt-in via new `--record-history`, since most of its invocations are diagnostic, not the deployed pipeline's own measurement. 22 new offline checks (`infra/model-benchmark/tests/test_schema_unification.py`) against synthetic fixtures — no fleet node reachable, so a real live-run entry is still owed. |
| 1.5.0 | 2026-10-23 | **Phase B executed** (§10). `check_tier2_gate()` (generic over any Tier 2 suite) + `hermes-benchmark-compare.py --gate` formalize §9 rule 4 — any regression fails, missing data is "no-data" not a silent pass (11 offline checks). New `tools/hermes-log-analyst-eval.py` closes gap 1 (§6.1): 18 cases across the three real source shapes, one deliberately recreating hermes-logs.py's own documented 1.2.0 fabrication bug to test whether a candidate honors the hardened prompt (19 offline checks). Stated plainly per §8.6: the case set is synthetic, not real-sampled — this session has no fleet access to sample from, and growing it with real, scrubbed fleet data remains open work. No fleet node reachable to run either piece against a live backend yet. |
| 1.6.0 | 2026-10-23 | **Phase C, two suites executed** (§6.3, §6.5, §10). `fleet_muse_contract`: new `tools/hermes-muse-contract-eval.py`, 27 probes (3 families × the 9 real bot personas); corrected §6.3's own framing while building it — `minecraft-common.md` has no separate "don't recite your prompt" rule, so the three families were regrounded as capability/override/groundedness against the real five-rule text (35 offline checks; found and fixed a bug where the override family's own deterministic pass was being discarded as "unjudged" when no judge endpoint was given). `fleet_dualcoder_precision`: new `tools/hermes-dualcoder-precision-eval.py`, running the real `scan_code()` against 6 cases (the README's own documented verification recipe, two real clean functions already in this repo, and two adapted from the scanner's own documented trigger patterns) and scoring a coder role's free-text review against the real findings via a deterministic keyword heuristic (27 offline checks). Stated plainly per §8.6 for both: neither suite's case set is real-sampled from fleet history yet — that remains open work for a session with fleet access. No fleet node reachable to run either against a live backend yet. |
| 1.7.0 | 2026-10-23 | **Phase C, a third suite executed** (§6.4, §10). `fleet_digest_faithfulness`: new `tools/hermes-digest-faithfulness-eval.py`, calling the real `hermes-news-digest.summarize_highlights()` function unmodified (confirmed import-safe) with its one network dependency (`rag.router_chat`, which goes through `hermes-router` — forbidden for an eval by §8.1) monkeypatched to call the digest role's backend directly — the real passage-numbering/`<DATA>`-wrapping/"nothing new"-short-circuit/citation-parse code runs for real, so zero prompt drift is structurally impossible rather than merely avoided. Two deterministic floor checks (`grounded`: does a highlight share any real vocabulary with the passage it cites; `padding_restraint`: does the model correctly emit nothing on a case built with nothing genuinely new, rather than padding) run unconditionally; the judged `faithful` axis (§6.4's own originally-proposed metric) falls back to `"unjudged"` without a judge endpoint, never guessed. 5 synthetic (topic, passages) scenarios per §8.6 — no live RAG store reachable from this session to sample real matches from. 31 offline checks (`infra/model-benchmark/tests/test_digest_faithfulness.py`); the existing 114-check Phase A-C suite stays regression-free. No fleet node reachable to run against a live backend yet. |
| 1.8.0 | 2026-10-23 | **Phase C, a fourth suite executed** (§6.7, §10), after a direct operator instruction to defer §6.2 and continue Phase C. `fleet_coder_fix` closes gap 7: new `tools/hermes-coder-fix-eval.py`, 10 scored tasks from the 9 real commits §6.7 already named (confirmed reachable directly in this repo — the cross-repo mining this section's own `[PROPOSED]` note floated turned out unnecessary for this nine). One correction found while building: this section listed `actions.js` as the `enchantments.concat` fix's (`35df5ec`) source; the real fix is in `equipment.js`. The model is shown a real pre-fix excerpt (never the whole file — several of these files run 1,000-7,800 lines) located by anchor text resolved fresh per file version, using its LAST match rather than its first — found by testing: this project's own versioning convention quotes a fix's own variable names in the file's own header-comment prose, physically earlier in the file than any real target function, so a first-match lookup was grabbing commentary instead of code. Only 1 of 10 tasks is executable from this session (`reolink_ai_state`, pure Python with a duck-typed `host_obj` parameter needing no real vendor library); verified against the real commit itself, not a synthetic case — the real pre-fix file fails the repro, the real post-fix file passes it, and splicing the real post-fix excerpt into the real pre-fix file via substitution also passes it. The other 4 "repro-testable in principle" tasks are JavaScript, and this dev machine has no `node` binary anywhere on it (checked thoroughly, not assumed) — a different, harder blocker than "no live fleet access" — so their repro axis reports a third, honest `"env_unavailable"` status, never blended into a pass/fail rate; the judge axis still scores all 10. Two tiers recorded as two separate keys, never blended (§8.6): `fleet_coder_fix_repro` (1-task gold-standard subset) and `fleet_coder_fix_judge` (all 10). A real bug found via this suite's own testing: an early `strip_code_fence()` called `.strip()` on the whole answer first, silently eating an unfenced answer's own leading indentation and corrupting every substitution — fixed to touch only actual fence markup. 31 offline checks (`infra/model-benchmark/tests/test_coder_fix.py`); the existing 145-check Phase A-C suite stays regression-free. No fleet node reachable to run against a live coder/judge endpoint yet. |
| 1.9.0 | 2026-10-23 | **Phase C complete except §6.2** (§6.8, §10) — operator confirmed continuing straight into `fleet_coder_build` after `fleet_coder_fix`. New `tools/hermes-coder-build-eval.py` closes gap 8: 8 scored tasks from the 8 real "build from scratch" commits §6.8 already named; 7 reachable directly in this repo, 1 (`botnet_intel_build`) from the sibling `HermesAgentRedo` repo via ordinary cross-repo `git show`, same precedent §6.7's corpus already set — `HermesAgentV4` turned out not to be needed for either suite. Unlike a fix prompt, there's no pre-existing file to excerpt for a build task, so the model is shown only the requirement (from the real commit's own stated "why"); the 3 fixture-tier tasks additionally specify the exact real function signature to implement, a real interface contract rather than an implementation hint. Those 3 (`botnet_intel_build`, `feed_reader_build`, `minecraft_admin_build`) each target a pure, dependency-free function, with every fixture's expected output run against the REAL post-build implementation before being written down, never hand-computed; one real discriminating-power check caught during testing — a plausible RSS parser using `Element.text` instead of `Element.itertext()` (missing text after a nested tag) correctly fails the fixture while a minimal correct one passes. `doc_to_markdown_build` is explicitly NOT fixture-tested despite this section's own text calling it so: its real substance needs `pymupdf4llm`/`python-docx`, neither installed on this dev machine — scored judge-only, a real environment constraint, not a design reversal. Two tiers, never blended (§8.6): `fleet_coder_build_fixture` (3-task subset) and `fleet_coder_build_judge` (all 8). 28 offline checks (`infra/model-benchmark/tests/test_coder_build.py`); the existing 176-check Phase A-C suite stays regression-free. Phase C is now complete except §6.2, which stays deferred. No fleet node reachable to run against a live coder/judge endpoint yet. |
| 1.10.0 | 2026-10-23 | **Phase D's §6.6 executed**, after a direct operator instruction ("D") to continue into Phase D. New `tools/hermes-latency-eval.py`: the Tier 3 interactive-latency harness for the six roles §3 marks "Yes" (`dispatch`, `guard`, `muse`, and RAG's `embed`/`rerank`/synthesis hops), implementing all three corrections this section already names. Verified against a real local HTTP server (an in-process background thread, no subprocess, no external network) rather than a stubbed Python call — against that server's fixed, known per-call delay, concurrency 1→4 reproduced correction #1's own cited finding directly: aggregate tok/s roughly quadrupled while per-request p50 latency stayed flat, the same "13.0→51.9 tok/s... flat per-request latency" shape already cited from real `muse` history, now demonstrated rather than only asserted. `rag_embed`/`rag_rerank` call the REAL `hermes_rag_common.embed()`/`rerank()` functions directly (their `EMBED_URL`/`RERANK_URL` globals monkeypatched to the test endpoint, same pattern `hermes-digest-faithfulness-eval.py` already uses), so those hops' real parsing runs unmodified. `fleet_rag_latency` is written per-hop, never as one fabricated bare number. 34 offline checks (`infra/model-benchmark/tests/test_latency_eval.py`); the existing 204-check suite stays regression-free. **S28's security suite family stays explicitly deferred, not attempted**: it's gated on a different stage's own incomplete prerequisite (`IMPLEMENTATION_PLAN.md` S10's network isolation, still an operator checklist) and needs real deployed vulnerable web apps (Juice Shop/WebGoat) a dev-machine session shouldn't fake infrastructure around — stated plainly rather than built untested. No live fleet node reachable to measure a real backend's actual latency numbers yet — only the harness's own correctness is verified. Minor bump — a stage's phase executed and its real record written in, nothing prior reversed. |
