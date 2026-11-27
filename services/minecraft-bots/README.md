# Minecraft Bots Orchestrator

**Version:** 1.0.0
**Status:** Mid-restart. `index.js`/`actions.js` currently reference modules that moved to the
archive (see `ARCHIVE_INDEX.md`) and will not run until `MINECRAFT_BOTS_RESTART_PLAN.md`'s Phase 4/5
land. All nine bot units are stopped on purpose — do not start them before then.

See `MINECRAFT_BOTS_RESTART_PLAN.md` (repo root) for the full restart plan and current phase status.
`ARCHIVE_INDEX.md` in this folder is a terse map of what moved out and why.

## What's still here (kept, not archived)

| File | Job |
|---|---|
| `index.js` | The bot entrypoint — being rewritten in Phase 5 to call the new skill/task/instruction layer instead of the archived goal engine |
| `pathfinding.js`, `swim-movements.js` | Movement/physics: the climb, jump-impulse and swim-sprint fixes from the 2026-11 pathfinding debugging session |
| `arbiter.js` | Tiered control arbitration — who may hold the bot's body right now (routine work, player command, emergency) |
| `router.js` | Thin client to `hermes-router.py`'s role dispatch (`callRole`) |
| `equipment.js` | Armor/weapon/tool selection from real game state |
| `buzz.js` | Bot-to-bot coordination client (`hermes-buzz.py`) |
| `matrix.js` | Shared operator+bots chat room client (Continuwuity Matrix CS API) |
| `roles.js` | The `<Name>_<Role>` persona/role roster and naming convention |
| `run-bot.sh` | Process wrapper: fetches tokens from Vaultwarden, sets the heap cap |

**Requirements:** Node.js 22 LTS (on `dgx-spark` and `dgx-spark2`).

## Running

Not functional right now — see Status above. Once Phase 5 lands:

```bash
cd services/minecraft-bots
npm install
MC_BOT_USERNAME=Babs ./run-bot.sh
```

In production each bot is a systemd unit — see `infra/minecraft-bots/`.
