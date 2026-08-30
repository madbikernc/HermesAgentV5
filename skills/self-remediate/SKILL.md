---
name: self-remediate
description: "What you may fix yourself when you or the other identity notices something broken during the hourly status exchange, what needs The Boss's approval first, and exactly how each path works. Use this whenever hermes-status-exchange-trigger.sh's own prompt points you here, or any time you independently notice a real problem."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [remediation, buzz, broker, self-repair, fleet-health]
prerequisites:
  commands: [curl, jq]
---

# Self-Remediation

**Version:** 1.0.0

Built after a real near-miss (IMPLEMENTATION_PLAN.md Stage 10): a Buzz message once sat
apparently-unanswered long enough to look stuck before a watcher's own next cycle caught it. You and
the other identity check on each other hourly (`hermes-status-exchange-trigger.sh`) so routine
problems get handled without waking The Boss for every one — but there are exactly three tiers here,
and mixing them up is the one way to get this wrong.

## Tier 1 — fix it yourself, right now, no approval needed

A real, allowlisted service or daemon that's down or misbehaving:

```bash
~/HermesAgentV5/tools/hermes-remediate.sh restart-service <exact-unit-name>
```

or, if the other identity looks unreachable and a nudge might help:

```bash
~/HermesAgentV5/tools/hermes-remediate.sh send-nudge <sintra|amy> ["message"]
```

**You do not have sudo or systemctl access, and this tool doesn't give you any** — it submits a real
job to the broker; an already-privileged worker checks it against
`infra/hermes-remediate/allowlist.json` and only acts if your exact target is on your own list. If a
target isn't allowed, the tool refuses and tells you why — that's it working correctly, not a bug to
route around. **Never try to restart something yourself via any other path** (no `systemctl`, no
`sudo`, no editing a unit file) — you don't have the access for a reason, and this tool is the only
sanctioned way to affect a service's running state.

The tool itself is throttled (three attempts per target, then it escalates to The Boss automatically
via email and FleetOps) — you don't need to count attempts yourself or decide when to stop; just call
it, and if it keeps refusing because it's already exhausted, that means it's already been escalated,
not that you should find another way to force it through.

## Tier 2 — root-cause it, then ask before touching anything

A real bug in a **script or skill** — not a service being down, but wrong logic, a crash in a tool,
a skill doc describing something that no longer works. Investigate using tools you already have
(read the file, check logs, reproduce if you can) and form a real diagnosis with a concrete proposed
fix. **Then stop. Do not edit the file yet.**

Notify The Boss with the diagnosis and your proposed fix, in **both** places:
- Post it into FleetOps, as yourself.
- Send an email to `notifications@canislupisnc.net` (your gateway's own Email platform connection —
  no new tool needed).

Wait. A clear, on-topic reply from The Boss — in FleetOps or by email, referencing what you raised —
that says to go ahead is your approval. If he says no, or asks a question, or doesn't reply: no fix
happens. Don't infer approval from silence, and don't re-raise the same finding repeatedly if he's
already answered it once.

## After approval — peer review, then apply, then log it

Once approved, **before you write anything**, send the exact fix (the real diff or the new file
content, not a summary of it) to the other identity over Buzz and ask her to sanity-check it. This is
a real second set of eyes, not a formality — if she raises a real concern, take it seriously and
either revise or go back to The Boss, don't just proceed anyway.

Once she's given a real okay, apply the fix in your own `~/HermesAgentV5` checkout. This is a **local
edit only** — do not attempt to `git commit`/`git push`; you don't have write access to the remote,
and this is intentional (IMPLEMENTATION_PLAN.md Stage 10): every self-repair still needs a human's
independent sanity check before it's trusted enough to go upstream, which is exactly what the daily
reminder below is for.

Then log it — append an entry to `~/.hermes/self-repair-index.md` (create it if it doesn't exist):

```markdown
## YYYY-MM-DD HH:MM — <file changed>
**Problem:** <one line>
**Fix:** <one line, or a short diff>
**Peer-reviewed by:** <the other identity>
**Boss-approved:** <how/when they said yes>
```

A daily reminder already goes to The Boss automatically for anything logged here (§9 of this fleet's
implementation plan) — you don't need to separately ask him to check it again.

## What NOT to do, ever

- **Never fabricate a status, a remediation result, or a repair** — if `hermes-remediate.sh` fails or
  times out, report the real error, same as every other tool in this fleet
  (`LESSONS_LEARNED.md` §2b).
- **Never skip Tier 2's approval step because a fix seems obvious or small.** The tier is about the
  *kind* of change (script/skill logic), not how confident you are in it.
- **Never skip the peer-review step**, even if you're certain The Boss's approval covers it — the
  review is a separate, independent check, not a redundant formality.
- **Never expand your own remediation authority.** If you think a new action type or target should be
  allowed, tell The Boss — `infra/hermes-remediate/allowlist.json` is edited by a human, not by you,
  and a new *action type* (beyond restart-service/send-nudge) needs real code, not a config change.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-21 | Initial version, written alongside `hermes-remediate.sh`/`hermes-remediate-worker.py` and the hourly status exchange (IMPLEMENTATION_PLAN.md Stage 10, direct request following a real near-miss). |
