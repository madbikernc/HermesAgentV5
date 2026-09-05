---
name: dual-coder-review
description: "Get a bounded, cross-reviewed function from two independent coding models (coder and coder2) instead of one -- they draft/review/revise until they agree it's bug-free, then each writes and cross-checks a security review. Use for a task that genuinely benefits from two-model rigor, not everyday coding questions."
version: 1.2.0
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [dual-coder, code-review, security-review, buzz, async]
prerequisites:
  commands: [curl, jq]
---

# Dual-Coder Review

**Version:** 1.2.0

Two independent coding models, `coder` (Qwen3.8-27B-abliterated) and `coder2` (Meta's Muse Glimmer
30B), draft and cross-review a function until they agree it's bug-free, then each writes an
independent security review and cross-checks the other's review. Built after a real bake-off found
the two models genuinely asymmetric — `coder` wins general knowledge/instruction-following,
`coder2` wins function-calling reliability decisively — so cross-review catches more than either
model alone would.

**This is an async, multi-step Buzz workflow, not a single completion call** — unlike
`skills/model-delegation`'s "one raw completion" shape, this can run many router calls across
cold-wake latencies and multiple review rounds. Do not expect (or wait synchronously for) an
immediate reply.

## When to use it

A task worth two-model rigor: something where a subtle bug or security issue actually matters and
is worth the time cost. **Not** for everyday coding questions, one-liners, or anything
`skills/model-delegation`'s plain `coder` call already answers well — that's faster and cheaper.

## How to use it

Publish the task as a pointer envelope to the `dualcoder` Buzz topic (task_id + memory_ref, never
inline content — same pattern every other specialist here uses):

```bash
curl -s -X POST "$MEMORY_URL/turns" -H "Authorization: Bearer $MEMORY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"task_id\":\"$TASK_ID\",\"agent\":\"you\",\"role\":\"user\",\"raw\":\"<the coding task>\"}"

curl -s -X POST "$BUZZ_URL/messages" -H "Authorization: Bearer $BUZZ_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"from\":\"you\",\"topic\":\"dualcoder\",\"task_id\":\"$TASK_ID\"}"
```

## What to expect

- **Realistic latency: potentially over an hour.** Confirmed live 2026-09-05: `coder2` (Muse
  Glimmer) reasons heavily even on real tasks, and a single review/revise/security call can burn
  8,000-10,000 tokens at its observed ~11.6 tok/s — 10-15 minutes for *one* call, before counting
  cold-wake time. A 5-round loop plus the fixed security/meta-review tail can reasonably take over
  an hour end to end. This is the real cost of using a heavy-reasoning model as a reviewer, not a
  bug — budget your expectations accordingly, and don't assume a quiet task is stuck.
- **Check progress via `tasks.state`** (`GET $MEMORY_URL/tasks/<task_id>`): `drafting` →
  `review-round-N` → (on a stuck disagreement) `third-party-review` → `security-review` →
  `security-meta-review` → a terminal state.
- **A stuck disagreement gets one tie-breaking opinion from the fleet's shared $22/mo Nous Research
  budget** (`tools/hermes-nous-judge.py`) before anything reaches a human — this is a small,
  bounded arbitration step, not a second negotiation loop, and it shares the same budget every
  other Nous-judge caller draws from.
- **Terminal states**: `done` (converged, full bundle — code, both security reviews, both
  meta-reviews — published to FleetOps), `unresolved` (the round cap was hit and the judge either
  agreed or was unavailable — **a human decides, nothing was auto-approved**), `error` (a real
  failure, reported honestly), `blocked` (the original task failed screening).
- **Security reviews are grounded in real static-analysis findings**, not free-form LLM guessing —
  a `static-scan` phase (`infra/hermes-code-security-scan/`: bandit, ruff unused-variable checks,
  detect-secrets, plus heuristics for unauthenticated destructive actions and credential-shaped
  variables passed to logging) runs once before either model's review and feeds its real findings
  into both prompts. This is what makes reviews consistent run-to-run instead of purely
  sampling-dependent.
- If a task sits `unresolved` for 24+ hours, `tools/hermes-attention-reminder.py`'s daily check will
  flag it by email — see `infra/hermes-attention-reminder/README.md`.

## Rules

- **Never treat an `unresolved` result as a soft failure to route around** — it means two real
  models and a neutral third opinion could not agree the code is correct. Read the disagreement
  transcript before deciding anything, same as any other real escalation in this fleet.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.2.0 | 2026-09-05 | Security reviews now grounded in a real static-analysis pass (`infra/hermes-code-security-scan/`) instead of purely free-form LLM output — see `tools/hermes-dualcoder.py` 1.1.0's own changelog. |
| 1.1.0 | 2026-09-05 | Latency guidance corrected after the first real end-to-end run: coder2's real reasoning overhead on an actual task made the original ~30-40 min estimate a significant understatement — now "potentially over an hour," with the real numbers behind it. |
| 1.0.0 | 2026-09-05 | Initial version. |
