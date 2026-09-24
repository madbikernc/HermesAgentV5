# Minecraft Bots Orchestrator

**Version:** 4.0.0

Mineflayer bot runtime for the Firmament's nine Minecraft bots. **What the bots do and why lives
in `../../MINECRAFT_BOTS_DESIGN.md`** — this file covers only how to run and configure the
process. Change history: `../../docs/minecraft-bots-history.md`.

The fleet's only Node.js service. Everything else in HermesAgentV5 is Python stdlib; mineflayer
has no comparable Python equivalent, which makes this a deliberate runtime deviation rather than
an oversight.

## Running

One process per bot, `run-bot.sh` rather than `node index.js` — the wrapper fetches
`MEMORY_TOKEN`/`BUZZ_TOKEN` from Vaultwarden, reads the bot's Matrix token out of
`~/.hermes/minecraft-matrix.env`, and sets the heap cap. Running `index.js` directly works but
loses short-term memory, long-term recall, Buzz, and Matrix, each degrading independently rather
than failing the bot.

```bash
cd services/minecraft-bots
npm install                                  # once; package-lock.json pins tested versions
MC_BOT_USERNAME=Babs ./run-bot.sh
```

In production each bot is a systemd unit instead — see `infra/minecraft-bots/`.

**Requirements:** Node.js 22 LTS (on `spark` and `spark2`).

**Heap:** `--max-old-space-size=1536`, with a heap snapshot written to
`/mnt/hermes-data/minecraft-memory/heapdumps/<bot>/` if the limit is hit. This is defense in
depth, not a fix — `astar.js`'s synchronous `compute()` starves pending continuations on every
search, leaking promises slowly. `Restart=always` covers the rest.

## Environment

Everything has a working default; a unit file only sets what it overrides.

| Variable | Default | Purpose |
|---|---|---|
| `MC_HOST` / `MC_PORT` | `192.168.1.221` / `25580` | Game server |
| `MC_BOT_USERNAME` | `Babs` | This bot's in-world name |
| `MC_BOT_PERSONA` | lowercased username | Which `agents/minecraft-<x>/` to load |
| `MC_BOT_USERNAMES` | all nine | Identities excluded from the human-reply path, or bots relaying each other's chat loop forever |
| `MC_BOSS_USERNAMES` | `CanisLupisM,@phone1:spark` | Real accounts the "Boss" persona modifiers apply to |
| `MC_MAYOR_USERNAME` | `Mayor` | Who issues directives |
| `MC_SQUAD_RESPONDER` | derived from Soldier role | Override to put a non-Soldier on squad duty |
| `MC_FALLBACK_COORDINATOR` | unset | Coordinates when Mayor goes quiet (set on Mark) |
| `MC_AUTONOMY_ENABLED` / `MC_SELF_PROPOSE_GOALS` | `true` | Kill switches for the goal loop |
| `MC_SELF_DEFENSE_RANGE` | `12` | Threat detection radius (20 on Mark/Luke) |
| `MC_MINE_SEARCH_RADIUS` / `MC_EXPLORE_SEARCH_RADIUS` | `32` | Local block scan (40 on Babs/Wade). Keep under 48 — `pathfinder.searchRadius`'s OOM ceiling |
| `MC_EXTENDED_SEARCH_DISTANCE` | `150` | Wander beacon scan (260 on Wade); hop-capped, so safe to raise |
| `MC_GOAL_TICK_MS` / `MC_IDLE_SELF_GOAL_MS` | `45000` / `600000` | Goal step cadence; idle before self-proposing |
| `MC_MAYOR_DIRECTIVE_MS` | `300000` | Mayor's assignment cadence |
| `MC_*_CHECK_MS` | see `index.js` | Per-check intervals: sleep, dusk, hunger, inventory, give, sapling, lighting, home lighting, terrain repair, stuck, self-defense, sleeping-threat |
| `MC_MAX_STUCK_NUDGES` / `MC_RESTART_STUCK_*` | `2` / `3`, `2` | Stuck detection before teleport self-rescue |
| `MEMORY_URL` / `BUZZ_URL` / `MATRIX_*` | spark | Service endpoints; tokens come from `run-bot.sh` |
| `HERMES_ROUTER_URL` | `127.0.0.1:8080` | Localhost only — the router proxies to whichever node serves a role |

## Files

| File | Job |
|---|---|
| `index.js` | The bot: connection, chat pipeline, goal loop, idle-tick checks, role priority functions, Mayor curriculum |
| `actions.js` | Every physical verb (`performAction`), chest/furnace/gear helpers |
| `arbiter.js` | Urgency tiers — who may hold the body |
| `roles.js` | Role taxonomy and per-bot assignment |
| `goals.js` | Persistent goal state, `actionsTaken`, failure counters |
| `skills.js` | Skill library: author, validate, retrieve, replay |
| `longterm.js` | Per-bot RAG memory and shared world-memory notes |
| `equipment.js` | `hasWeapon()`, best armor/weapon selection, gear tiers |
| `swim-movements.js` | `Movements` subclass: water handling, `MAX_DIG_LABOR_COST` cap |
| `persona.js` | Prepends `agents/minecraft-common.md` to the bot's own `PROMPT.md` |
| `memory.js`, `buzz.js`, `matrix.js`, `router.js` | Thin service clients |

## Things that will bite you

- **Adding an action verb means three places**: the `actions.js` switch, `classifyIntent`'s
  vocabulary, and `planNextStep`/`parseGoalStep`'s vocabulary — plus `SKILL_ACTION_VERBS` unless
  its arguments can't be replayed.
- **Any mineflayer plugin holding its own `Movements`** (`collectBlock`, `pvp`) must be pointed at
  the shared instance at spawn, or every cost tuning is silently undone for that plugin's calls.
- **Persona text reaches eight prompt sites**, not just chat — changing `PROMPT.md` or
  `minecraft-common.md` affects self-proposal and directive generation too.
- **A bot is just another player to mineflayer.** Bot identities are filtered out of the
  human-reply path; Mayor's directives are the one deliberate exception.
