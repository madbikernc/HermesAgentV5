# Archive index

**Version:** 1.0.0

Everything below moved to `../minecraft-bots-archive-11-2026/` on 2026-11-27 as part of
`MINECRAFT_BOTS_RESTART_PLAN.md` — kept permanently as reference/salvage, not deleted, not
depended on by the restarted bots. Full rationale and the kept/archived split live in that plan
doc; this is just a map of where things landed.

| Archive path | What it was |
|---|---|
| `MINECRAFT_BOTS_DESIGN.md`, `PRIORITIES.md`, `PRIORITIES_PROPOSAL.md`, `README.md` | The old behavioral design doc, priority audit/proposal docs, and the old (now-stale) service README |
| `goal-proposal.js`, `goal-runners.js`, `goal-tick.js`, `goals.js`, `priorities.js`, `gear-goals.js`, `fleet-coordination.js` | The hand-built goal/priority engine |
| `mayor.js`, `night-survival.js`, `self-defense.js`, `shelter.js`, `shelter-goals.js`, `shelter-memory.js`, `home-scan.js`, `upkeep-home.js`, `upkeep-inventory.js`, `upkeep-world.js`, `tunneling.js`, `faults.js`, `persona.js`, `incoming.js`, `planning.js` | Role-specific hand-built behavior |
| `chat.js` | Intent classification + direct-command parsing |
| `memory.js`, `longterm.js`, `skills.js`, `rag-backend.js` | Hand-built memory/skill-library modules |
| `action-chests.js`, `action-claims.js`, `action-crafting.js`, `action-movement.js`, `action-search.js`, `action-shelter.js`, `action-vocab.js`, `action-world.js`, `actions.js`, `actions/*.js` (41 files) | The hand-built action library and its dispatcher |
| `agents/minecraft-<name>/PROMPT.md` (all 9 personas + `minecraft-mbprobe`), `agents/minecraft-common.md` | The old per-persona system prompts and their shared preamble |

**Not archived — stays live, see `README.md` for why:** `index.js`, `pathfinding.js`,
`swim-movements.js`, `arbiter.js`, `router.js`, `equipment.js`, `buzz.js`, `matrix.js`, `roles.js`,
`run-bot.sh`.
