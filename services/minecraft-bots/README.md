# Minecraft Bots Orchestrator

**Version:** 2.9.0

Mineflayer-based bot runtime for the Firmament's interactive Minecraft bots. See
`../../MINECRAFT_BOTS_DESIGN.md` for the full design. This is the fleet's first Node.js
service -- everything else in HermesAgentV5 is Python stdlib; mineflayer has no comparable
Python equivalent, which is why this is a deliberate runtime deviation, not an oversight.

## Status

First real decision loop wired: chat perception -> cheap relevance classification
(`dispatch` role) -> in-character reply (`muse` role, voiced by the bot's own
`agents/minecraft-<persona>/PROMPT.md`) -> the bot chats back in-game. `router.js` talks to
`hermes-router.py` at `http://127.0.0.1:8080/v1/chat/completions` -- only works when run on
the same fleet node as a router instance (spark), and every call already gets the router's
own two-layer injection-guard screening for free, so untrusted player chat text never needs
a separate guard step here.

Two bots: **Babs** (`agents/minecraft-babs/PROMPT.md`, flirty/playful/capable) and **Amy**
(`agents/minecraft-amy/PROMPT.md`, sweet/playful, Babs' sister, deferential to The Boss). Each
runs as its own process -- there's no multi-bot-per-process multiplexing yet (a later
efficiency pass the design doc's §5 anticipates, not needed to prove multiple bots work).

Persistent per-bot conversation memory is wired via `hermes-memory.py`: every line and reply
is recorded as a turn (`agent=mc-<persona>`, `conv_id=mc-<persona>:<speaker>`), and recent
history for that speaker is read back before each reply -- conversations survive a restart.

Long-term memory is wired via a new `minecraft` corpus in `hermes-rag` (`longterm.js` +
`tools/hermes-rag-ingest-minecraft.py`/`hermes-rag-search-minecraft.py`, since
`hermes_rag_common.py` has no HTTP API, unlike hermes-router/hermes-memory -- these scripts
are the bridge). Before each reply, relevant past notes are recalled; after each reply
(never blocking it), a cheap `dispatch` call decides whether anything is worth remembering as
a `world/` (shared) or `bots/<persona>/` (personal) note under
`/mnt/hermes-data/minecraft-memory/`.

Run via `run-bot.sh`, not `node index.js` directly, so `MEMORY_TOKEN` gets fetched from
Vaultwarden first (`memory-token` item) -- running `index.js` directly still works, just
without short-term conversation memory, per `memory.js`'s own best-effort fallback on a
hermes-memory outage (long-term recall/writing degrades independently the same way, per
`longterm.js`'s own fallback).

Bot-to-bot coordination is wired via `hermes-buzz.py` (`buzz.js`): a WORLD-scoped long-term
memory (see above) is also published to the shared `minecraft` Buzz topic (added to
`KNOWN_AGENTS`/`KNOWN_TOPICS` there as `mc-babs`/`mc-amy`/`minecraft`, hermes-buzz.py 2.0.16),
and each bot subscribes and relays what it hears from the other into in-game chat -- a
directly observable trace, not just a background write. **Every bot is also just another
player to mineflayer** -- `MC_BOT_USERNAMES` (comma-separated, default `Babs,Amy`) excludes
known bot identities from the normal human-reply pipeline entirely, or a bot relaying a Buzz
message would trigger the other bot's own chat listener and loop forever.

Matrix is wired via `matrix.js` -- a single shared room (`!2rXcMwykUS2yVNTLGw:spark`, named
"Minecraft"), operator + both bots as members, per the operator's own decision (not one room
per bot like the retired Sintra/Amy pattern). Talks directly to Continuwuity's Client-Server
API, not the fleet's old "hermes gateway" tool. New Matrix accounts (`mc-babs`, `mc-amy`) were
registered via the standard enable-registration/create/re-lock recipe in
`infra/continuwuity/README.md`; credentials live in `~/.hermes/minecraft-matrix.env` on spark
(root-owned, `600`) rather than Vaultwarden -- writing a new Vaultwarden item was blocked by
this session's own permission classifier while building this, so it fell back to the same
local-env-file shape the fleet's actual Matrix gateway already reads from `~/.hermes/.env`.
Revisit moving it to Vaultwarden later if wanted. All the design doc's originally-scoped
pieces are now built: personalities, per-bot + shared-world memory, Buzz coordination, and
Matrix.

**Real in-world actions are wired** (`actions.js`): navigate (goto/follow/stop), gather
(mine), and fight (attack) -- closing the gap between what both personas' Core Directives
always claimed and what the code could do. `classifyIntent()` (one `dispatch` call, replacing
the old plain-relevance check) detects an action request alongside ordinary relevance, so this
didn't cost a second round-trip. Actions run via two more PrismarineJS plugins
(`mineflayer-collectblock`, `mineflayer-pvp`) in the *background*, outside the `busy` window
that guards the classify/reply step -- a mine/follow/attack can run up to a minute
(`ACTION_TIMEOUT_MS`), and blocking chat for that whole span would make the bot go silent
while she works. Building/structure placement is explicitly out of scope -- a much bigger
feature (planning, materials, layout) left for its own future pass.

**Equipment management is wired** (`equipment.js`): a new `loot` action opens the nearest
chest and takes any armor/weapon/tool it finds. Gear is rechecked automatically after
mine/attack/loot and once at spawn (inventory persists across restarts -- it's tied to the
player's UUID in the world save, not the bot process) -- the best armor available is worn per
slot, and the best weapon is held by default. Mining now correctly switches to a
task-specific tool via `mineflayer-tool`'s `bot.tool.equipForBlock()` (real dig-time math, not
a guess) -- a real gap found live: `mineflayer-collectblock` already calls this internally,
but the plugin was never loaded, so it silently had nothing to call. Crafting and building are
still explicitly out of scope -- this covers "use or loot what already exists," not "make what
doesn't."

**Autonomy is wired** (`goals.js` + index.js's goal loop): a standing goal -- something worked on
over many steps/ticks, not one atomic request -- can come from a player ("Babs, your goal is to
get full iron armor," via the same one-call `classifyIntent`, new `ACTION GOAL <description>`
verb) or, per the operator's own choice between the two designs offered, from the bot herself:
once she's had no active goal and heard from no one for `MC_IDLE_SELF_GOAL_MS` (10 min default),
she proposes one in character (`muse`, grounded in her real gear via `equipment.js`'s new
`describeGear()` -- never invented) and starts working it. Either way, a goal persists as a small
JSON file (survives restart, same as inventory) and gets worked one step at a time on its own
`MC_GOAL_TICK_MS` timer (45s default) through the exact same `performAction()` pipeline a direct
chat command already uses -- never a separate, less-tested way of moving/mining/fighting/
crafting/looting. The tick only ever fires when nothing else has the bot's attention (`busy`/new
`acting` flag), so a live player command always wins immediately and the goal loop simply resumes
on its own next tick once that command finishes -- no separate interrupt/resume logic, it falls
out of the existing mutex. `ACTION STOP` now also abandons any active goal. This needed
`performAction()` to return a real `{ ok, text }` signal (`actions.js` 1.8.0) instead of a bare
string -- English-parsing "did that work?" from result text would have been fragile. `MC_AUTONOMY_ENABLED=false`
disables the whole goal loop (both player-assigned and self-proposed); `MC_SELF_PROPOSE_GOALS=false`
keeps player-assigned goals but turns off self-proposing.

## Requirements

Node.js 22 LTS (installed on `spark` 2026-09-06 via NodeSource). Run `npm install` in this
directory once to pull `mineflayer`, `mineflayer-pathfinder`, `mineflayer-collectblock`, and
`mineflayer-pvp` (`package-lock.json` is committed, so this reproduces the exact versions
this was built and tested against).

## Running

```bash
cd services/minecraft-bots
npm install
MC_HOST=192.168.1.221 MC_PORT=25580 MC_BOT_USERNAME=Babs ./run-bot.sh
MC_HOST=192.168.1.221 MC_PORT=25580 MC_BOT_USERNAME=Amy ./run-bot.sh    # second bot, own process
```

Defaults to `192.168.1.221:25580` (the offline-mode bot instance on muncraft) and username
`Babs` if the env vars are omitted. `MC_BOT_PERSONA` defaults to the lowercased username
(so `MC_BOT_USERNAME=Babs` loads `agents/minecraft-babs/PROMPT.md` automatically) -- set it
explicitly if a bot's display name and persona directory ever need to differ.
`MC_BOSS_USERNAMES` (comma-separated, default `CanisLupisM`) registers which real accounts a
persona's "Boss" behavioral modifiers apply to.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.9.0 | 2026-09-07 | Autonomy (`goals.js`): standing goals, player-assigned or self-proposed while idle, worked step-by-step via the existing `performAction()` pipeline on their own timer. `actions.js` 1.8.0's `performAction()` now returns `{ ok, text }` instead of a bare string so goal progress can be judged structurally, not by parsing English. |
| 2.8.0 | 2026-09-06 | Equipment management (`equipment.js`): new `loot` action, auto-equip best armor/weapon after mine/attack/loot and at spawn. Fixed a real gap: `mineflayer-tool` was never loaded, so `collectBlock`'s own internal task-specific tool selection had nothing to call. |
| 2.7.0 | 2026-09-06 | Real in-world actions (`actions.js`): navigate/gather/fight via `mineflayer-collectblock`/`mineflayer-pvp`, detected by the same `dispatch` call that already classified relevance. Building explicitly out of scope. |
| 2.6.0 | 2026-09-06 | Matrix wired (`matrix.js`) -- single shared room, operator + both bots. New accounts `mc-babs`/`mc-amy`; credentials in a local env file (Vaultwarden write was blocked by the session's permission classifier). |
| 2.5.0 | 2026-09-06 | Bot-to-bot coordination over hermes-buzz.py (`buzz.js`) -- shared `minecraft` topic, relayed into in-game chat. `MC_BOT_USERNAMES` guard added to prevent a bot-relay feedback loop. |
| 2.4.0 | 2026-09-06 | Long-term memory via a new `minecraft` hermes-rag corpus (`longterm.js` + two new `tools/hermes-rag-*-minecraft.py` scripts). Second bot (Amy) added. `run-babs.sh` renamed `run-bot.sh` (bot-agnostic). |
| 2.3.0 | 2026-09-06 | Persistent per-bot conversation memory via hermes-memory.py -- survives restarts. Added `memory.js`, `run-babs.sh`. |
| 2.2.0 | 2026-09-06 | Boss registration (`MC_BOSS_USERNAMES`) -- personas reference "The Boss" as a role, orchestrator resolves it to a real username. |
| 2.1.0 | 2026-09-06 | Whisper handling (`/msg`, `/tell`, `/w`) -- separate mineflayer event from public chat, confirmed live. |
| 2.0.0 | 2026-09-06 | Decision loop wired: relevance classification (dispatch) -> in-character reply (muse) -> in-game chat. First persona (Babs) added. |
| 1.0.0 | 2026-09-06 | Initial scaffolding -- single-bot connectivity proof, no decision logic yet. |
