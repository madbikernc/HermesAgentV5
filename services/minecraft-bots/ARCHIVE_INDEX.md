# Archive index

**Version:** 1.2.0

Everything below moved to `../minecraft-bots-archive-11-2026/` on 2026-11-27 as part of
`MINECRAFT_BOTS_RESTART_PLAN.md` — kept permanently as reference/salvage, not deleted, not
depended on by the restarted bots. Full rationale and the kept/archived split live in that plan
doc; this is just a map of where things landed.

| Archive path | What it was |
|---|---|
| `MINECRAFT_BOTS_DESIGN.md`, `PRIORITIES.md`, `PRIORITIES_PROPOSAL.md`, `README.md` | The old behavioral design doc, priority audit/proposal docs, and the old (now-stale) service README |
| `goal-proposal.js`, `goal-runners.js`, `goal-tick.js`, `goals.js`, `priorities.js`, `gear-goals.js`, `fleet-coordination.js` | The hand-built goal/priority engine |
| `mayor.js`, `night-survival.js`, `self-defense.js`, `shelter-goals.js`, `shelter-memory.js`, `home-scan.js`, `upkeep-home.js`, `upkeep-inventory.js`, `upkeep-world.js`, `tunneling.js`, `persona.js`, `incoming.js`, `planning.js` | Role-specific hand-built behavior |
| `chat.js` | Intent classification + direct-command parsing |
| `memory.js`, `longterm.js`, `rag-backend.js` | Hand-built memory modules (old `skills.js`, the hand-built skill-authoring library, also archived here under its original name — superseded by the new, Mindcraft-ported `skills.js` now live in `services/minecraft-bots/`) |
| `action-chests.js`, `action-claims.js`, `action-crafting.js`, `action-movement.js`, `action-search.js`, `action-shelter.js`, `action-world.js`, `actions.js`, `actions/*.js` (41 files) | The hand-built action library and its dispatcher |
| `agents/minecraft-<name>/PROMPT.md` (all 9 personas + `minecraft-mbprobe`), `agents/minecraft-common.md` | The old per-persona system prompts and their shared preamble |

**Correction, found during Phase 4 integration:** `shelter.js`, `action-vocab.js`, and `faults.js`
were briefly archived too, then pulled back out — all three turned out to be safety/vocabulary/
crash-handling infra that `pathfinding.js`/`swim-movements.js`/`index.js` (kept) actually import
(`isLivingSpaceWall`/`wouldBlockAccess`, `isProtectedBlockName`, `guardedInterval`/
`installFatalHandlers`), not goal content. Each was confirmed self-contained (no import tying it
to the archived goal engine) before restoring.

**Not archived — stays live, see `README.md` for why:** `index.js`, `pathfinding.js`,
`swim-movements.js`, `arbiter.js`, `router.js`, `equipment.js`, `shelter.js`, `action-vocab.js`,
`faults.js`, `buzz.js`, `matrix.js`, `roles.js`, `run-bot.sh`, plus the new `skills.js`, `world.js`,
`mcdata.js`, `commands.js`, `modes.js` ported from Mindcraft, and `agents/minecraft-common.json` +
`agents/minecraft-<name>/profile.json` (new persona format, replacing the archived `PROMPT.md`s).
