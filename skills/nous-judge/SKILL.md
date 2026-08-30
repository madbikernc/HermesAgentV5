---
name: nous-judge
description: "Get a neutral outside opinion on code from Nous Research Portal — either to grade/compare candidates from Super, Coder, or Muse without the self-grading bias a sibling model would have, or as a failsafe when Super/Coder/Muse are unreachable. Free-tier models only by default, hard-capped at $22/mo. Use when asked for a second opinion between candidates that all pass their own checks, or when a fleet backend is down and a real answer beats no answer."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [nous-portal, external-judge, failsafe, code-review, budget-capped]
prerequisites:
  commands: [python3]
---

# Nous Judge

**Version:** 1.0.0

See `IMPLEMENTATION_PLAN.md` Stage 18 for the full design account and live-verification history —
this file is usage guidance only, per constraint 7 (§5).

## When to use

- **A second, neutral opinion on code** — when Super, Coder, or Muse have each produced a candidate
  and they genuinely disagree, or all pass whatever check exists but you're not sure which approach
  is better. This exists specifically because asking one fleet model to grade another has the same
  self-grading-bias problem grading its own output would — a truly outside model doesn't.
- **A failsafe when Super, Coder, and Muse are all unreachable** — so a request gets a real answer
  instead of a dead error.

## When NOT to use

- **If the task has a real test/execution path — run the code, don't ask an opinion.** This fleet's
  own hard-won lesson (`coder`'s own bake-off, `hermes-router.py`'s changelog) is that another
  model's opinion is not evidence the way a real execution result is. This is for what execution
  can't settle — several candidates that all genuinely pass, no test harness available, a real style/
  approach call — never a replacement for actually running the code.
- **Don't reach for this on your own initiative.** Same discipline `skills/model-benchmark/SKILL.md`
  already holds to: this spends real money (capped, but real) against a shared $22/mo budget and can
  trigger a real notification to The Boss if that cap is hit. Use it when asked for a second opinion,
  or when a real outage genuinely leaves no other backend to answer with — not as a routine step in
  every task.

## How to use it

```bash
~/HermesAgentV5/tools/hermes-nous-judge.py --path judge \
  --prompt "Candidate A: ...\n\nCandidate B: ...\n\nWhich is more correct/idiomatic, and why?" \
  --max-tokens 1024
```

```bash
~/HermesAgentV5/tools/hermes-nous-judge.py --path failsafe --prompt "..." --max-tokens 1024
```

`--path` is logged for cost attribution only — both share the same budget ledger and circuit
breaker. Prefer `--dry-run` first if you're unsure whether the budget is already exhausted this
cycle — it prints the current cycle's spend and which model would be picked, without spending
anything.

## What happens at the cap

If the current billing cycle (resets on day 26, `IMPLEMENTATION_PLAN.md` Stage 18) has already hit
$22.00, the call refuses outright — including on the failsafe path. That's deliberate: this never
silently escalates to some other paid provider once the free/cheap Nous budget is gone. The Boss
gets emailed and Matrix-notified the first time a cycle crosses the cap, not on every subsequent
blocked call.

## Rules

- **Not a substitute for real execution-based verification anywhere that exists** — see "When NOT to
  use" above.
- **Don't invoke this on your own initiative** — use it when asked for a second opinion, or when a
  real fleet-backend outage leaves no other option to answer with.
- **A refusal at the budget cap is not a bug to work around** — don't retry with different wording
  hoping to sneak under the cap, and don't fall back to describing what an answer might have looked
  like. Report the refusal plainly, the same "don't narrate a hoped-for outcome" rule
  `skills/model-benchmark/SKILL.md` already holds to.
- Model selection prefers $0/token models automatically — this is not something to override per call.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-26 | Initial version, alongside `tools/hermes-nous-judge.py` 1.2.0 — wired in after full live verification on `spark` (real `/v1/models` call, real `/v1/chat/completions` call, real ledger write, two real bugs found and fixed; see `IMPLEMENTATION_PLAN.md` Stage 18). |
