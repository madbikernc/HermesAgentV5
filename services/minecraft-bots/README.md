# Minecraft Bots Orchestrator

**Version:** 2.0.0
**Status:** Restarted on the Mindcraft-ported baseline (`MINECRAFT_BOTS_RESTART_PLAN.md` Phase
5). Babs and Amy relaunched 2026-11-27; the other seven personas stay stopped until requested.

See `MINECRAFT_BOTS_RESTART_PLAN.md` (repo root) for the full restart plan and current phase
status. `ARCHIVE_INDEX.md` in this folder is a terse map of what moved to
`../minecraft-bots-archive-11-2026/` and why.

## Files

| File | Job |
|---|---|
| `index.js` | The bot entrypoint: identity/env config, persona-profile loading, the decision loop, chat/whisper/Matrix handling, lifecycle |
| `skills.js`, `world.js`, `mcdata.js` | Ported from [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft) (MIT) — the action/skill library (craft, mine, build, fight, navigate, trade, ...) and its read-only world-query/Minecraft-data helpers |
| `commands.js` | Ported from Mindcraft — the `!commandName(args)` registry/parser the LLM's replies are expressed in, and the command-docs text fed into each persona's system prompt |
| `modes.js` | Ported from Mindcraft — reactive behavior checked every tick (self-preservation, self-defense/cowardice, hunting, item collecting, torch placing), gated through `arbiter.js`'s control tiers |
| `pathfinding.js`, `swim-movements.js` | Movement/physics: the climb, jump-impulse and swim-sprint fixes from the 2026-11 pathfinding debugging session (unaffected by the restart — not Mindcraft code) |
| `arbiter.js` | Tiered control arbitration — who may hold the bot's body right now (routine work, player/LLM command, emergency) |
| `router.js` | Thin client to `hermes-router.py`'s role dispatch (`callRole("muse", ...)`) |
| `equipment.js` | Armor/weapon/tool selection from real game state |
| `shelter.js`, `action-vocab.js` | Safety/vocabulary infra `pathfinding.js`/`swim-movements.js` depend on directly (living-space wall/access detection; protected-block-name matching, hostile mob lists, gear tiers) — briefly archived, restored once that dependency surfaced during Phase 4 |
| `faults.js` | `guardedInterval`/`installFatalHandlers` — periodic-check error containment and crash logging, feeds `hermes-minecraft-triage.py`'s crash pattern |
| `buzz.js` | Bot-to-bot coordination client (`hermes-buzz.py`) — present, not wired into the new decision loop yet (see the restart plan's known-gaps note) |
| `matrix.js` | Shared operator+bots chat room client (Continuwuity Matrix CS API) |
| `roles.js` | The `<Name>_<Role>` persona/role roster and naming convention |
| `run-bot.sh` | Process wrapper: fetches tokens from Vaultwarden, sets the heap cap |

Personas live in `../../agents/minecraft-<name>/profile.json` (Mindcraft's profile schema) plus
the shared `../../agents/minecraft-common.json` preamble, loaded by `index.js` at startup —
replacing the archived `persona.js`'s `PROMPT.md` prepend step.

**Known gaps from this restart, not oversights** — see `MINECRAFT_BOTS_RESTART_PLAN.md` and
`index.js`'s own header: no cross-restart wedge/teleport-home rescue, no Buzz goal/death
broadcasting, no long-term/RAG memory (a bounded in-process rolling history stands in for now).

**Requirements:** Node.js 22 LTS (on `dgx-spark` and `dgx-spark2`).

## Running

```bash
cd services/minecraft-bots
npm install
MC_BOT_USERNAME=Babs_Miner MC_BOT_PERSONA=babs ./run-bot.sh
```

In production each bot is a systemd unit — see `infra/minecraft-bots/`.
