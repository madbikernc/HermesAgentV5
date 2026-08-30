---
name: model-finetuning
description: "LoRA/QLoRA fine-tune a local model on raw documents (fiction, transcripts, regulatory material, or any other prose) for local deployment. Use when there's real training material ready and a specific model/purpose in mind — not for exploratory model search."
version: 2.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [fine-tuning, lora, qlora, peft, trl, GGUF, model-surgery]
prerequisites:
  commands: [systemctl, sudo]
---

# Model Fine-Tuning

**Version:** 2.0.0

Produces a LoRA adapter from a base open-weight model, trained on local documents, via
`tools/hermes-finetune-train.py` (`transformers`/`peft`/`trl`/`bitsandbytes` — see
`infra/model-finetuning/README.md` for what it is and the one-time install). This is weight surgery
on disk, not a runtime toggle — the adapter has to be merged, converted to GGUF, and deployed like any
other model afterward, same as `model-abliteration`'s own output.

## When to use

- Real training material exists (raw documents — `.txt`/`.md`/`.pdf`/`.docx`/`.epub`) and there's a
  specific base model and purpose in mind, not an open-ended "what should we fine-tune."
- The goal is style/content absorption from prose (this trains on raw text directly, not
  instruction/response pairs — see `infra/model-finetuning/README.md` for why, and its limits).

Don't use this for exploratory model comparison or benchmarking — that's a separate, much cheaper
question than committing GPU-hours to a real training run.

## How to use it

```bash
~/HermesAgentV5/tools/hermes-finetune-model.sh <hf-repo-id> <data-dir> <output-dir>
```

This stops `llama-coder.service`/`llama-muse.service` on `spark-2` (neither exists on `spark`, so
nothing is stopped there unless `--free-omni` is passed, which stops `llama-amy-vision.service`
instead) for the duration of the run — **never** either persona's own fast-core service, and never
`spark`'s backbone (`nano`, the on-demand `super`, broker, router, Continuwuity) — runs the training
script in the foreground, and restarts whatever it stopped when training finishes, on success,
failure, or interrupt alike.

`<data-dir>` is scanned recursively for `.txt`/`.md`/`.pdf`/`.docx`/`.epub` files — extracted the same
way `hermes-rag-ingest-kb.py` already extracts documents for the `personal-kb` RAG corpus, then
paragraph-chunked into training-length windows. Every skipped file (unhandled type, or a document that
extracts to nothing — most often a scanned/image-only PDF) is named explicitly in the run's own
output, not silently dropped.

Extra training args (LoRA rank, learning rate, epochs, etc.) pass through after `--`:

```bash
~/HermesAgentV5/tools/hermes-finetune-model.sh Qwen/Qwen3.6-35B-A3B \
  ~/finetune-data/regulatory-docs /mnt/hermes-data/adapters/regs-v1 \
  --free-omni -- --epochs 2 --lora-r 32 --learning-rate 1e-4
```

## After training: merge, convert to GGUF, sanity-check

Not part of this script — a separate, deliberate step once the result has been checked. See
`infra/model-finetuning/README.md` for the merge/`convert_hf_to_gguf.py`/`llama-quantize` sequence and
the template for wiring a result in as a new backend if it's worth promoting.

**Always chat-test the result before treating it as done.** A clean training-loss curve doesn't mean
the output is actually good — memorization without generalization is a real, common failure mode a
loss number alone won't catch.

## Rules

- **Never stop either persona's own fast-core service.** `llama-sintra-core.service`/`llama-nano.service`
  on `spark`, `llama-amy-core.service` on `spark-2` — whichever persona is running this, their own
  reasoning backend stays up. If freeing enough memory would require stopping it, use the other node
  instead of working around it here.
- **Report the real outcome, don't narrate a hoped-for one.** Same rule as every tool in this fleet
  (`LESSONS_LEARNED.md` §2b/§2g) — if training fails, produces NaN/invalid losses, or the sanity-check
  chat test comes back bad, say so plainly.
- This is a foreground, human-attended operation — not something to invoke from a timer or an
  unattended job.
- Raw-text training only, no instruction/response pair synthesis. If the actual goal turns out to need
  instruction-following behavior specifically (not just style/content absorption from prose), that's a
  separate, not-yet-built document-to-instruction-pairs pass — say so rather than assuming this
  script already covers it.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 2.0.0 | 2026-08-21 | Ported from `HermesAgentRedo` 1.0.0, retargeted from spark's Weaver/Muse to spark-2's Coder/Muse (`IMPLEMENTATION_PLAN.md` §4d) — found in the same honest-delegation sweep that caught `hermes-fabrication-guard.sh`'s stale role names, not by the original migration audit. `--free-vision` renamed `--free-omni`. |
