---
name: model-delegation
description: "Get a raw completion from Super (deep reasoning/planning escalation), Coder (coding), or Muse (creative writing and persona voice) — the fleet's other resident backends. Use this for a real task that specifically benefits from a different model, not for general conversation."
version: 2.0.2
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

**Version:** 2.0.2

You already house a Core, a Muse, and a Weaver — this skill is what makes that literally true
rather than a personality description (`IMPLEMENTATION_PLAN.md` §2c, §4). These are real,
separate, resident backends reachable through your own node's `hermes-router` on
`127.0.0.1:8080` — some run on this node, some on the other Spark; the router hides which.

**This is a single completion call, not a sub-agent.** No session, no persona, no Matrix message,
no tool access for the called model — it gets your prompt, returns text, and that's it. Do not
confuse this with `delegate_task` (that spawns a full child agent session; wrong tool for this).

## When to use which

- **`super`** (Huihui-GLM-4.7-Flash-abliterated, `spark`) — a genuinely hard planning or reasoning
  problem where your own default model's speed/depth trade-off isn't enough. The router lists it
  as on-demand, but in practice it stays resident; if it has been stopped, the first call can take
  up to ~150 seconds while it wakes, on top of normal generation time. Don't reach for it for
  anything you could already answer directly; it exists for the cases that actually need it.
- **`coder`** (Huihui-Qwen3.8-27B-abliterated, `spark-2`) — a real coding question: writing or
  reviewing a nontrivial function, debugging a stack trace, explaining unfamiliar code. Not for one-liners you can
  already answer directly.
- **`muse`** (NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning, stock, `spark-2`) — creative writing:
  fiction, worldbuilding, dialogue, persona voice. It was chosen in S44 for persona adherence and
  override resistance. **It is no longer an abliterated model**: before 2026-10-27 `muse` was
  Huihui-Qwen3.6-35B-A3B-abliterated, picked so creative requests weren't pre-censored. The stock
  model can refuse or hedge where the old one didn't. If it refuses, report that rather than
  rephrasing to get around it.

`omni` (the vision judge), `dispatch`, `coder2` and `log-analyst` are not called through this
skill: they serve fixed pipelines, not ad-hoc delegation. `nano` is retired.

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
| 2.0.2 | 2026-11-04 | Role → model names corrected to the live fleet: `super` is Huihui-GLM-4.7-Flash-abliterated (resident in practice), `coder` is Huihui-Qwen3.8-27B-abliterated, `muse` is now stock Nemotron-3-Nano-Omni (no longer abliterated — refusals possible). `nano` marked retired. Also aligned the body version line with the frontmatter. |
