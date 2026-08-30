# HermesAgentV5

**Version:** 1.1.0

The Firmament's V5 rebuild: moving from a **two-persona, node-pinned agent fleet** to the
**dispatcher/presenter fleet** specified in
[`firmament-fleet-target-architecture.md`](firmament-fleet-target-architecture.md).

**Status: live and authoritative.** As of 2026-08-30, `tools/`, `skills/`, and `infra/` are consolidated
here (~230 files, carried over from `HermesAgentV4` with every `REPO_DIR`/`ExecStart`/identity string
repointed at this repo — nothing here shells out to or imports from `../HermesAgentV4`), and all three
nodes (`spark`, `spark-2`, `HomeD13`) are cut over: every live systemd unit's `ExecStart` resolves to
`../HermesAgentV5`, and `hermes-repo-autopull.timer` keeps each node's checkout current from
[this repo's GitHub remote](https://github.com/madbikernc/HermesAgentV5). See
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the staged migration this repo's own code/content
went through, and its own status section for what's still ahead architecturally (the dispatcher/presenter
work below is largely built; this repo becoming the deployed checkout was a separate, later step).

**Predecessors, both kept on disk in full, permanently:** `../HermesAgentV4` (superseded 2026-08-30),
`../HermesAgentRedo` (retired 2026-08-23). Neither is deleted; neither is depended on.

## What's changing, and why

1. **A dispatcher/presenter split replaces the persona gateways.** Today each of Sintra and Amy is one
   Hermes Agent process that owns a Matrix connection, a personality, a tool loop, *and* the routing
   decision — all in one LLM turn, on an abliterated model. V5 separates them: a stock-weight dispatcher
   that only routes, and a thin presenter that only speaks.
2. **Real memory continuity.** There is none today — `hermes-session-cap-guard.sh` writes one paragraph at
   the context cap and wipes the session. V5 adds `hermes-memory`, storing raw and presented output as
   separate channels linked by task ID, so handoffs survive a restart.
3. **Buzz becomes topic-based with claim handoff.** It is targeted two-party messaging today, hardcoded to
   `{sintra, amy}`.
4. **The control plane goes back to stock weights.** Both control-plane models are abliterated builds today.
   V4's own logs contain three separate incidents that read as exactly the capability tax this predicts.
5. **Sintra and Amy are retired.** One fleet voice, per-room context separation. The interactive persona
   that eventually speaks through the presenter is a later, separate decision.

## What isn't changing

The capability layer. V4's ~120 model-agnostic tools, skills, and infra dirs carry forward largely as-is —
the same result the Redo→V4 migration got, for the same reason (`IMPLEMENTATION_PLAN.md` §6). Credential
policy stays Vaultwarden-exclusive. The conversation/execution plane split, the confirmation gate for
destructive actions, per-identity credential scoping, and the "verify from raw output, never self-report"
rule all carry forward unchanged.

Hostnames stay `spark` / `spark-2` / `HomeD13`. Watch, Forge, and Kiln are role labels, not renames
(§3.2).

## Contents

- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — discovery against the live fleet, the gap analysis,
  four ratified deviations from the target document, the twelve-stage migration, and the carry-forward audit.
- [`firmament-fleet-target-architecture.md`](firmament-fleet-target-architecture.md) — the target-state
  design input, vendored unmodified.
- [`LESSONS_LEARNED.md`](LESSONS_LEARNED.md) — forked from `HermesAgentRedo`. Incidents, hardware
  measurements, platform gotchas, and security findings that remain fully valid.
- [`CLAUDE.md`](CLAUDE.md) — this project's versioning convention.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-29 | Initial migration-plan overview. |
| 1.1.0 | 2026-08-30 | Status updated from "planning only" to "live and authoritative": `tools/`/`skills/`/`infra/` consolidated from `HermesAgentV4` into this repo, and all three fleet nodes cut over to it. `HermesAgentV4` marked superseded to match. |
