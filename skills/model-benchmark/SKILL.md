---
name: model-benchmark
description: "Score a live fleet backend or an unpromoted candidate model (a fresh heretic/fine-tune output, a bake-off contender) against five industry-standard suites — MMLU-Pro, GPQA Diamond, IFEval, BFCL, SWE-bench Verified — and compare the result against that model's own prior runs. Use before promoting a candidate to a real resident backend, or to check whether a fleet role's current backend is still the right choice."
version: 3.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [lm-eval-harness, mmlu-pro, gpqa, ifeval, bfcl, swe-bench, benchmark, model-surgery]
prerequisites:
  commands: [systemctl, sudo, curl]
---

# Model Benchmark

**Version:** 3.0.0

Runs `lm-eval-harness` (MMLU-Pro, GPQA Diamond, IFEval), BFCL, and SWE-bench Verified against a
backend, records the result to shared history, and prints how it compares to that same model's most
recent prior run — see `infra/model-benchmark/README.md` for the one-time venv install. All five are
live-verified end-to-end, 2026-08-24. **SWE-bench needs `x86_64` — blocked on `spark`/`spark-2`
(aarch64, no Docker emulation), runs natively on `HomeD13`** (README §4); the other four run from
`spark`/`spark-2` as usual.

## When to use

- **Before promoting a `model-abliteration` or `model-finetuning` output** — both of those skills'
  own rules already say "always chat-test or benchmark the result before treating it as done." This
  is the benchmark half of that; chat-testing alone catches obvious breakage, not a quantified
  regression.
- **Evaluating a bake-off candidate** before it replaces a fleet role's current backend — the same
  kind of decision the `muse` bake-off (`IMPLEMENTATION_PLAN.md` §9) and the Nemotron 3 Nano Omni
  evaluation (`IMPLEMENTATION_PLAN.md` §6 Stage 7) already made informally; this makes it a
  repeatable, comparable measurement instead of a one-off judgment call.
- **Periodically re-checking a fleet role's current backend** — model releases move fast; a role
  that was the right pick when it was chosen isn't guaranteed to stay the best available option.

Don't use this for a quick sanity check that a model didn't break entirely — a plain chat-test via
`hermes-model-call.sh` is cheaper and faster for that. This is for a real, comparable score.

## How to use it

**Benchmarking a live fleet backend** (`nano`/`super`/`coder`/`muse`/`omni`) — read-only against
`hermes-router`, no service disruption, safe to run any time:

```bash
~/HermesAgentV5/tools/hermes-benchmark-model.sh --role coder \
  --model-id unsloth/Qwen3-Coder-Next-GGUF
```

**Benchmarking an unpromoted candidate** (a `.gguf` not currently wired into any role) — spins up a
temporary `llama-server` on spark-2's freed `coder` slot, same free/restore discipline
`hermes-abliterate-model.sh`/`hermes-finetune-model.sh` already use:

```bash
~/HermesAgentV5/tools/hermes-benchmark-model.sh --candidate /opt/heretic-venv/output/model-Q4_K_M.gguf \
  --model-id org/some-30b-heretic-output --free-omni
```

`--model-id` is **always required and never auto-detected** — `hermes-router` has no
weight-introspection endpoint, so the real identity (an HF repo ID, or an equally specific label for
something not on the Hub) has to come from the operator. This is the same "identity is a human
judgment call" discipline `hermes-model-archive.py` 1.2.0 established after finding its own
destination folders keyed by invented status labels instead of real model identity.

By default the four suites that run on `spark`/`spark-2` (MMLU-Pro, GPQA Diamond, IFEval, BFCL) are
selected — `swebench` is left out of the default set since it needs different hardware (below), not
because it's broken; pass it explicitly (`--suites ...,swebench`) once you're running from `HomeD13`.
Narrow the default set for a faster check, or add `--limit N` (applies to MMLU-Pro/GPQA-Diamond/
IFEval/SWE-bench) for a quick smoke test before committing to a full run:

```bash
~/HermesAgentV5/tools/hermes-benchmark-model.sh --role muse \
  --model-id huihui-ai/Qwen3.6-35B-A3B-abliterated --suites mmlu_pro,ifeval --limit 25
```

**BFCL needs two extra flags, always** — it can't go through `hermes-router` (see README §3 for
why), so it needs the role's own `llama-server` port directly, plus a registry-matched model name:

```bash
~/HermesAgentV5/tools/hermes-benchmark-model.sh --role coder --model-id unsloth/Qwen3-Coder-Next-GGUF \
  --suites bfcl --bfcl-endpoint http://127.0.0.1:8093/v1 \
  --bfcl-model-name Qwen/Qwen3-30B-A3B-Instruct-2507-FC --bfcl-test-category simple_python
```

No exact BFCL registry entry exists for any of this fleet's actual checkpoints — pick the closest
architectural match and read the resulting score as an approximation shaped by that mismatch, not a
clean number (README §3 has the full reasoning and a real example: `nano` scored 0.00% against a
Qwen prompt template it was never trained on).

**SWE-bench must run from `HomeD13`, not `spark`/`spark-2`** — it needs `x86_64` Docker, which only
`HomeD13` has (README §4). This means shell access to `HomeD13` specifically, which isn't assumed to
be available from wherever this skill is being invoked — verify SSH/local access to `HomeD13` before
committing to this, rather than assuming it works the same way `spark`/`spark-2` access does.
`--endpoint` points at the target role's own `llama-server` port directly (same reason as BFCL above
— not through `hermes-router`, which is `127.0.0.1`-only), using the *other* node's real LAN IP
since you're calling in from `HomeD13`:

```bash
# From HomeD13:
~/HermesAgentV5/tools/hermes-benchmark-model.sh --role nano --model-id <label> \
  --endpoint http://10.129.1.15:8088/v1 --suites swebench --limit 5
```

Only `nano`/`super` (on `spark`, ports 8088/8095) are currently firewalled to allow `HomeD13`
through — `coder`/`muse`/`omni` (on `spark-2`) aren't yet, and would need the same treatment
(`infra/model-benchmark/README.md` §4) before this works for them too.

## Comparing against history

Every run prints a comparison against that `model_id`'s own most recent prior run automatically.
For anything else — a full trend across every run a model has had, or comparing two *different*
models' latest runs against each other (e.g. deciding whether a bake-off candidate actually beats
what a role is currently running):

```bash
~/HermesAgentV5/tools/hermes-benchmark-compare.py --model-id org/some-model                    # trend
~/HermesAgentV5/tools/hermes-benchmark-compare.py --model-id org/candidate --against org/current  # side by side
```

History is shared fleet-wide (the existing NAS2 mount, `infra/model-benchmark/README.md` §5) — a run
recorded from either node's own `hermes-benchmark-model.sh` shows up in either node's comparison.

## Rules

- **Never stop either persona's own fast-core service.** Same rule as `model-abliteration`/
  `model-finetuning` — `llama-sintra-core.service`/`llama-nano.service` on `spark`,
  `llama-amy-core.service` on `spark-2` are never touched, in either mode of this skill.
- **Report the real outcome, don't narrate a hoped-for one.** SWE-bench will error out every time on
  `spark`/`spark-2` — confirmed blocked there, not a maybe — and BFCL's score is only as meaningful
  as how close its registry model matched the real backend. Say so plainly rather than describing
  what a clean run would have looked like. The tooling itself already records a `"status": "error"`
  entry rather than fabricating a score; don't paper over that when reporting a result.
- **Treat a BFCL score as shaped by its registry-model mismatch, not a clean number** — no exact
  match exists for any of this fleet's checkpoints (`infra/model-benchmark/README.md` §3). Report
  which registry name was used alongside the score, not the score alone.
- **Treat a SWE-bench score as provisional, not leaderboard-comparable** — single-turn patch
  generation under-measures real coding ability relative to a full agent scaffold
  (`infra/model-benchmark/README.md` §4).
- **Don't ask for SWE-bench on `spark`/`spark-2` without checking `infra/model-benchmark/README.md`
  §4 first** — confirmed blocked there (no x86_64 Docker emulation), not merely untested; it only
  works from `HomeD13`.
- This is a foreground, human-attended operation — not something to invoke from a timer or an
  unattended job, and not something to kick off on your own initiative. Run it when asked, or when
  a `model-abliteration`/`model-finetuning` run's own rules call for a benchmark before promotion.

## Revision History

| Version | Date | Change |
|---|---|---|
| 3.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-24 | Initial version, written alongside `tools/hermes-benchmark-model.sh`, `tools/hermes-benchmark-model.py`, `tools/hermes-benchmark-compare.py`, and `tools/hermes_benchmark_common.py` — direct request for a repeatable, comparable way to score fleet backends and bake-off candidates against five industry-standard suites. |
| 2.0.0 | 2026-08-24 | Live verification pass on `spark`: MMLU-Pro/GPQA-Diamond/IFEval/BFCL all confirmed working end-to-end against real backends. BFCL's usage section rewritten around the real mechanism (direct `llama-server` port, `--bfcl-endpoint`/`--bfcl-model-name`/`--bfcl-test-category`, no exact registry match for this fleet's checkpoints) — replaces a guessed invocation that didn't exist. `swebench` removed from the default `--suites` set and Rules updated — confirmed blocked on this hardware (no x86_64 Docker emulation), not merely untested. Major bump — the BFCL usage section is a reversal of prior guidance, not just an addition. |
| 3.0.0 | 2026-08-24 | Added a SWE-bench-on-`HomeD13` usage section, direct request — `HomeD13` is `x86_64`, so it doesn't hit the aarch64 Docker-emulation blocker at all. Real end-to-end run verified: firewall rule opened (`spark` → `HomeD13` for `nano`/`super`'s ports), a real `nano` bind gap fixed (was `127.0.0.1`-only), two real code bugs found and fixed (wrong HF dataset org, too-short generation timeout). Rules updated to reflect SWE-bench works from `HomeD13` specifically, not that it's universally blocked. Major bump — reverses the prior "confirmed blocked" framing into a real working path. |
