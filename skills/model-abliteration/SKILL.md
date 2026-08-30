---
name: model-abliteration
description: "Remove refusal behavior from a stock open-weight model using heretic, without disturbing either persona's own fast-core service. Use when a newly-scanned model (see hermes-model-scan) has no acceptable pre-abliterated build available."
version: 2.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [heretic, abliteration, refusal-removal, uncensoring, GGUF, model-surgery]
prerequisites:
  commands: [systemctl, sudo]
---

# Model Abliteration

**Version:** 2.0.0

Produces a new, permanently uncensored set of weights from a stock open-weight model via `heretic`
(directional ablation with an automated layer/weight search — see
`infra/model-abliteration/README.md` for what it is and the one-time install). This is weight surgery
on disk, not a runtime toggle — the output has to be converted to GGUF and deployed like any other
model afterward.

## When to use

- `hermes-model-scan`'s weekly report (`tools/hermes-model-scan.py`) flags a candidate with no
  existing abliterated/heretic build, and it's worth The Boss's time.
- A pre-abliterated community build exists but is over-ablated or low quality.

Don't use this when an acceptable pre-abliterated build already exists — downloading is cheaper than
the compute time (~20-30 min on comparable hardware for a small model, longer for anything Muse-sized).

## How to use it

```bash
~/HermesAgentV5/tools/hermes-abliterate-model.sh <hf-repo-id>
```

**Runs on `spark-2` only** (`IMPLEMENTATION_PLAN.md` §4d) — it stops `llama-coder.service`/
`llama-muse.service`, spark-2's two swappable capability endpoints, for the duration. Add
`--free-omni` to also stop `llama-amy-vision.service` if the target model needs more headroom than
what's already free (check `free -h`'s own output, which the script prints before and after stopping
anything). **Never** stops either persona's own fast-core service (`llama-sintra-core.service`/
`llama-nano.service` on `spark`, `llama-amy-core.service` on `spark-2`) under any circumstance, and
never touches `spark`'s backbone (`nano`, the on-demand `super`, the broker, the router, Continuwuity)
at all — that's the point of retargeting this to spark-2 specifically. Runs `heretic` in the
foreground, and restarts whatever it stopped when `heretic` exits, on success, failure, or interrupt
alike.

`heretic` ends with its own interactive menu — save locally, push to the Hub, chat-test, or run
standard benchmarks. **Always use the chat-test or benchmark option before treating the result as
done** — an over-ablated model that answers everything but reasons worse is a worse outcome than not
bothering, and heretic's search reduces but doesn't eliminate that risk.

## After heretic: GGUF conversion and deployment

Not part of this script — a separate, deliberate step once the result has been sanity-checked. See
`infra/model-abliteration/README.md` for the `convert_hf_to_gguf.py` / `llama-quantize` sequence and
the template for wiring a result in as a new backend if it's worth promoting.

## Rules

- **Never stop either persona's own fast-core service.** `llama-sintra-core.service`/`llama-nano.service`
  on `spark`, `llama-amy-core.service` on `spark-2` — whichever persona is running this, their own
  reasoning backend stays up. If freeing enough memory would require stopping it, this isn't the right
  time for that model; report that rather than working around it.
- **Report the real outcome, don't narrate a hoped-for one.** Same rule as every tool in this fleet
  (`LESSONS_LEARNED.md` §2b/§2g) — if `heretic` fails, times out, or produces something that fails the
  sanity check, say so plainly rather than describing what a successful run would have looked like.
- This is a foreground, human-attended operation — not something to invoke from a timer or an
  unattended job. `hermes-model-scan` only ever *flags* candidates; it never triggers this script.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 2.0.0 | 2026-08-21 | Ported from `HermesAgentRedo` 1.1.0, retargeted from spark's Weaver/Muse to spark-2's Coder/Muse (`IMPLEMENTATION_PLAN.md` §4d) — found in the same honest-delegation sweep that caught `hermes-fabrication-guard.sh`'s stale role names, not by the original migration audit. `--free-vision` renamed `--free-omni`. |
