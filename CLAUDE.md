# HermesAgentV5 — Project Instructions

**Version:** 1.1.0

These instructions extend the global Claude Code instructions for work specifically within this project.
This project is the successor to `../HermesAgentV4`, which is itself the successor to `../HermesAgentRedo`.
Both predecessors are kept on disk **in full, permanently**, as reference and salvage sources — not deleted,
not depended on.

## Versioning — enforced on every file, including markdown

Inherited unchanged from `HermesAgentV4`/`HermesAgentRedo`. Every file in this project carries its own
semantic version (`MAJOR.MINOR.PATCH`), independent of every other file's version.

**Where the version lives:** a `**Version:** X.Y.Z` line immediately below the file's H1 title.

**Bump on every edit to a file, as part of the same change — never deferred:**
- **Patch**: wording/typo/formatting fixes, small clarifications that don't change meaning.
- **Minor**: new section, new phase, new guidance or factual detail added, without invalidating prior content.
- **Major**: a restructuring, a reversal/replacement of prior guidance, or any rewrite that changes a
  document's meaning or scope.

**Record every bump** in a `## Minecraft bots — every behavior fix ships with a test

`services/minecraft-bots/tests/` is the bots' test system (see its `README.md`): offline unit checks, live
scenarios run on the Spark nodes against the bot-sandbox server, and a per-host behavior baseline
measured from the bots' own journals. Any change that fixes or adds bot behavior must, in the same change:
add a `unit.test.mjs` check that fails on the old code; add a `live.test.mjs` scenario when the behavior is
observable in-world; add or adjust a `baseline.mjs` metric when it should move a fleet-level number. After
it has run live for about a day, re-record `tests/baselines/<host>.json` with `tests/run.sh baseline --update`
and commit it. Run `tests/run.sh all` on spark before calling a bot change done.

## Revision History` table at the bottom of the file
(`| Version | Date | Change |`) — append a row, never rewrite prior rows. Dates are absolute (`YYYY-MM-DD`).

**Exception: any file loaded into a live agent's context on every request carries a `**Version:**` line and
no Revision History table.** In V5 that means `agents/*/PROMPT.md` (the successor to V4's
`DesignFiles/*/SOUL.md`). A narrated changelog costs context budget on every single request and has zero
operational value to the agent reading it live — it belongs in `IMPLEMENTATION_PLAN.md` or `git log`.

**Baseline:** every file's content as of 2026-08-29 is versioned `1.0.0` — the point this project started.

## Inherited non-negotiables

`../HermesAgentRedo/LESSONS_LEARNED.md` is **forked into this repo** at `LESSONS_LEARNED.md` rather than
referenced across two sibling checkouts (V4 left this unresolved as its §9 risk 5; a three-hop reference
chain settles it). Its standing rules (§6), platform gotchas (§7), and security findings (§9–§10) apply here
in full and are not re-derived.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-29 | Initial versioned baseline — versioning convention inherited from `HermesAgentV4`. |
| 1.1.0 | 2026-09-24 | Added the Minecraft-bots rule: every behavior fix ships with unit/live/baseline tests. |
