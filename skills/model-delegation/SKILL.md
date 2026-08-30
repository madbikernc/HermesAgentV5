---
name: model-delegation
description: "Get a raw completion from Super (deep reasoning/planning escalation), Coder (coding), or Muse (uncensored creative writing) — the fleet's other resident backends. Use this for a real task that specifically benefits from a different model, not for general conversation."
version: 2.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [llama.cpp, router, coding, creative-writing, reasoning, delegation]
prerequisites:
  commands: [curl, jq]
---

# Model Delegation

**Version:** 2.0.0

You already house a Core, a Muse, and a Weaver — this skill is what makes that literally true
rather than a personality description (`IMPLEMENTATION_PLAN.md` §2c, §4). These are real,
separate, resident backends reachable through your own node's `hermes-router` on
`127.0.0.1:8080` — some run on this node, some on the other Spark; the router hides which.

**This is a single completion call, not a sub-agent.** No session, no persona, no Matrix message,
no tool access for the called model — it gets your prompt, returns text, and that's it. Do not
confuse this with `delegate_task` (that spawns a full child agent session; wrong tool for this).

## When to use which

- **`super`** (Nemotron 3 Super) — a genuinely hard planning or reasoning problem where your own
  default model's speed/depth trade-off isn't enough. **This one loads on demand** — the first
  call after it's been idle can take up to ~150 seconds while it wakes, on top of normal
  generation time. Don't reach for it for anything you could already answer directly; it exists
  for the cases that actually need it.
- **`coder`** (Qwen3-Coder-Next) — a real coding question: writing or reviewing a nontrivial
  function, debugging a stack trace, explaining unfamiliar code. Not for one-liners you can
  already answer directly.
- **`muse`** (Qwen3.6-35B-A3B, abliterated) — creative writing that needs to stay uncensored:
  fiction, worldbuilding, dialogue, anything where a safety-tuned model would hedge or refuse. It
  exists specifically so a creative request doesn't get pre-censored before it reaches the
  diffusion model for an image, or before it reaches The Boss as prose.

`nano`/`omni` (each persona's own default core) are not called through this skill — they're
whichever model answers you by default, not a delegation target.

## How to use it

```bash
~/HermesAgentV5/tools/hermes-model-call.sh <role> "<prompt>" ["<system prompt>"]
```

`<role>` is `super`, `coder`, or `muse`. The optional third argument sets a system prompt for
that one call only — it does not touch your own.

On success, prints only the completion text to stdout. On failure, prints the real error to
stderr and exits non-zero — there is no result to relay if it doesn't print one.

## Rules

- **If the call fails or times out, report the failure and stop — never write a replacement
  script or fabricate what the other model "would have said."** Same rule as every other tool in
  this fleet (`LESSONS_LEARNED.md` §2b): a missing or failing tool is something to report, not
  something to fake.
- Pass the called model everything it needs in the prompt itself — it has no memory of this
  conversation and never will.
- A slow `super` response is expected (see above), not a hang — don't retry or route around it
  just because it's taking longer than `coder`/`muse` do.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
