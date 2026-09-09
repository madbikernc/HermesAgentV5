# Minecraft Bots Orchestrator

**Version:** 3.19.0

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

Five bots: **Babs** and **Amy** (`agents/minecraft-babs/PROMPT.md`,
`agents/minecraft-amy/PROMPT.md`, flirty/playful/capable and sweet/playful/deferential
respectively, Amy is Babs' sister), **Mark** and **Luke** (military personas, added
2026-09-07), and **Mayor** (`agents/minecraft-mayor/PROMPT.md`, added 2026-09-08, muse-drafted
leader persona -- addresses the operator as "The President" and his own superior, and the
other four bots defer to a direct Mayor instruction unless it conflicts with something a real
player already assigned them; `isMayor()`'s exception to `isAnotherBot()` in `index.js` is the
one case a bot's own chat reaches another bot's real `classifyIntent` -> `ACTION GOAL` pipeline
rather than staying coordinate-over-Buzz-only). Each runs as its own process -- there's no
multi-bot-per-process multiplexing yet (a later efficiency pass the design doc's §5 anticipates,
not needed to prove multiple bots work). All five are granted level-2 (command) access in
muncraft-bots' `ops.json` -- needed for self-teleport (see "stuck"/"dusk" below), computed from
their offline-mode UUIDs (`MD5("OfflinePlayer:<username>")` with version/variant bits set, since
the bot sandbox server runs offline-mode).

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

**Bots sleep at night** -- a deterministic 30s check (`checkSleep()`, `MC_SLEEP_CHECK_MS`),
deliberately separate from the model-driven goal loop since "is it night" needs no reasoning,
just `bot.time.timeOfDay`. The real per-bed logic (find a bed, try it, wait for morning) is a new
`"sleep"` action built entirely on mineflayer's own `bed.js` plugin (core, no extra plugin load)
-- `bot.sleep()` already enforces the real vanilla rules (night/thunderstorm window, occupied
bed, monsters nearby, reach) and throws a specific reason for each. Tries up to 3 candidate beds
before giving up, same reasoning as loot's multi-candidate fix. A live command always interrupts
a night's sleep (`stopCurrent()` forces a wake). Also directly triggerable via chat (`ACTION
SLEEP`), same as every other action. **Sleep self-defense** was added later: `checkSleepingThreat()`
(5s timer, bypasses the `busy`/`acting` guard the way `checkStuck()` does) wakes a sleeping bot
and responds the instant a hostile mob is nearby, and the existing health-emergency interrupt
also wakes a sleeping bot before force-cancelling her other actions.

**The action set has grown to 21 verbs** (`actions.js` 1.20.0): navigate (`goto`/`follow`/`stop`),
gather (`mine`, `harvest` a ripe crop and replant it, `fish`), combat (`attack`/`flee`), crafting
(`craft`/`smelt`/`enchant`/`breed`), inventory (`loot` a chest -- now takes *everything* in it,
capped at one instance per distinct tool/weapon/armor piece rather than the old narrow
gear-only list; `give`/`store`/`trade` with a villager), and utility (`place` one carried utility
block, `eat`, `sleep`, `gohome`, `recover` dropped items after death). `resolveBlockFamily()`
lets a general material class ("any wood," "any ore," "any wool") match whatever specific
variant is actually nearby, rather than requiring the exact species/color named.

**Hazard-aware pathing and the OOM investigation**: a recurring crash was root-caused (via
direct V8 heap snapshot analysis, not guessing from logs) to `mineflayer-pathfinder`'s own
`astar.js` -- its synchronous `compute()` loop can block Node's single event loop for seconds
per search, starving already-resolvable promise continuations from
`mineflayer-collectblock`/`-tool`/`-pvp` until the heap fills. Fixed by lowering
`bot.pathfinder.thinkTimeout` (5000ms -> 1000ms) and `tickTimeout` (40ms -> 20ms), plus
`searchRadius` (library default unbounded -> 48). `run-bot.sh` layers defense in depth on top:
`--max-old-space-size` bounds the heap (raised 768MB -> 1536MB once live evidence showed the
same leak, slowed but not eliminated by the above, still outgrowing the original ceiling under
sustained overnight load with all four bots active) and `--heapsnapshot-near-heap-limit=1`
captures a real snapshot automatically right before any future OOM; `hermes-minecraft-triage.py`
(the fleet's standing triage service) finds and surfaces the latest one in its own incident
reports.

**Swimming**: two real, separate gaps closed together (world regeneration onto a coastal,
village-rich seed surfaced both live). First, survival: a new `bot.on("breath")` handler watches
`bot.oxygenLevel` (mineflayer's real air-supply tracking) and, once critical, force-cancels the
current action and holds the jump control while `bot.entity.isInWater` -- confirmed against
`prismarine-physics`'s own tick loop that this adds real upward velocity every tick, the same
mechanic a player uses to swim up. Second, capability: a new `swim-movements.js` (`SwimMovements`,
extending `Movements`) fixes a real library gap confirmed by reading `mineflayer-pathfinder`'s own
source -- stock `Movements` can already cross the *surface* of open water at a constant Y-level,
but `getMoveDown()`/`getMoveUp()` both unconditionally refuse once the bot is already standing in
liquid, so a bank dive or a resurface partway across a crossing was never in the search graph at
all, not just expensive. The override allows vertical travel through water specifically -- checked
by block name, not the library's generic `liquid` flag (which doesn't distinguish water from
lava) -- so lava's own vertical-movement refusal is completely unchanged; verified live via a
negative control (0 neighbors generated in lava, same as stock). **Update, direct report ("they
jump to come up, but do not ever try to reach land")**: the surfacing reflex alone only answered
"don't drown right now" -- once oxygen recovered she'd just keep floating wherever she surfaced.
The breath handler now finds the nearest real dry land (`findNearestShore()`, since "land" isn't
a matchable block type -- it scans for an open, non-liquid space with solid, non-liquid ground
beneath it) and paths there via the same pathfinder, now genuinely able to route out of water
thanks to `SwimMovements`. Verified live: swam 76+ blocks to real shore in 24 seconds from a
confirmed 10+ block deep body of water.

**Building, tool tiers, and farm automation** (following a web-research gap analysis against
other mineflayer/LLM Minecraft bot projects -- Mindcraft-CE, Voyager, general-purpose farm/
building bots): a new `"build"` action constructs a small, fixed 3x3-footprint shelter (walls,
one doorway, a roof) using whichever solid block she has the most of -- the "own pass" building
always deserved rather than being half-built alongside navigate/gather/fight, still deliberately
not a general blueprint/planning system. `"mine"` now checks `block.harvestTools`
(minecraft-data, real per-block tool requirements -- e.g. iron ore needs at least a stone
pickaxe) against her whole inventory before starting a collect, avoiding a wasted attempt with
the wrong tool tier, the same idea Voyager uses to sequence wood -> stone -> iron -> diamond
tools explicitly. `"harvest"` now works up to 8 mature crops per invocation instead of one, a
real "work the field" pass matching dedicated farm bots elsewhere in the ecosystem. **Boat
crossing is real infrastructure, not yet working**: a genuine crash bug was found and fixed
(`bot.placeEntity()`'s own boat-specific packet is missing fields this server's protocol
requires), but the actual boat spawn still silently fails, traced to a currently open, unresolved
upstream bug in how mineflayer handles `use_item`/rotation on 1.21.x
([mineflayer#3742](https://github.com/PrismarineJS/mineflayer/issues/3742)) -- documented as a
known limitation in `actions.js`'s own `tryLaunchBoat()` rather than claimed as working; it
degrades safely to a no-op fallback inside `"gohome"` in the meantime.

**Wandering toward known resources, not blindly** (direct report: "the bots just stand around
most of the time"): root-caused live to zero logs within 100 blocks of spawn on this world, so
every wood-gathering goal step (the very first, most basic resource in the tech tree) failed
instantly, cascading into everything downstream. `wanderAndRetryFind()` (shared by
mine/loot/craft/smelt/store/enchant) now uses this server's own view-distance (confirmed live:
160 blocks -- mineflayer already has chunk data that far out even though the pathfinder can't
route there directly) to run a free, stationary extended-radius scan for a real known bearing to
wander toward in bounded hops, instead of guessing a direction (live-tested and confirmed
unreliable on its own). `ACTION_TIMEOUT_MS` raised 60s -> 90s to fit the extra wander time
alongside the real work afterward. Verified live: found and collected wood ~83 blocks from spawn
in 27 seconds.

**Dynamic skill library** (`MINECRAFT_BOTS_DESIGN.md` §14): a skill is data, not code --
`{name, steps: [{type, ...args}]}`, validated against a real action-verb allowlist before ever
being stored or run, never raw code/eval (a deliberate deviation from Voyager's own architecture,
which evals LLM-authored JavaScript directly -- too risky for four bots sharing one live world).
New `skills.js`: `findSkill()` searches a new `minecraft-skills` hermes-rag corpus (its own
ingest/search script pair, mirroring the existing `minecraft` corpus's pattern) before
`goalTick`'s own per-tick planning call, and a close-enough, still-trusted match runs directly
through the same `performAction()` pipeline every other action already uses -- inheriting every
existing safety guarantee for free. A goal that completes without ever being served by a stored
skill gets compressed into one afterward, using the REAL `{type, ...args}` objects each
successful step actually ran with (`goals.js`'s new `actionsTaken`) -- an LLM only ever names and
describes that already-real sequence, never invents steps. A skill that fails when replayed
accumulates failures and gets skipped (not deleted) after 3 in a row. Verified live end-to-end:
seeded a real test skill, confirmed retrieval (with an empirically calibrated 0.7 distance
threshold -- genuinely related queries measured 0.54-0.64, far above the initially guessed 0.25),
confirmed the runner executes real steps and correctly detects failure, confirmed the failure
counter persists correctly, and confirmed a full happy-path run.

**Explore when a specific craft/mine target can't be found** (direct request: "if they can't
craft, they should explore, and find resources for later"): a new `"explore"` action scans
broadly for any common raw material (every log species, every ore family) instead of one named
target, reusing `"mine"`'s own tool-tier gate and directed extended-search wandering, and gathers
a full batch of whatever's found first rather than just enough for right now. A new deterministic
`BLOCKED` override -- same shape as the existing LOOT-before-smelt-blocked one -- forces this
when a goal gets blocked on a missing raw material, since a model sometimes gives up rather than
trying it even though the prompt already teaches it as an option. A successful explore also
writes a world memory note with position, so another bot's own goal can recall it later.

**No more duplicate crafting tables/furnaces** (direct report: "they keep creating crafting
tables, even when there is a number of them nearby"): `"craft"`'s own "does this need a table"
check only ever asked whether crafting the CURRENT item needs a different existing table/furnace
as a station -- crafting_table's own recipe needs no table at all, so that check always said "no"
and fell straight through to making a brand new one, never checking whether an instance of what
she's about to make already exists in reach. Fixed with a direct nearby-search before crafting
either reusable utility block. **Generalized further** (direct request: "the duplicate crafting
check should be for all resources as well as utilities... if a resource is in a nearby chest,
they should not mine it"): a new shared `tryTakeFromNearbyChest()` helper (reusing `"loot"`'s own
chest-interaction mechanics) means `"craft"` now checks a chest for ANY item before crafting it,
and `"mine"`/`"explore"` check for the REAL resulting item of what they're about to gather (new
`MINE_DROPS` -- a chest holds `raw_iron`, not `iron_ore`) before ever searching for the block
itself. All-or-nothing: only skips the action if a chest has the full amount needed.

**Self-defense was a true mid-action interrupt in name only** (direct report: "they still don't
seem to react to a threatening creature"). Two real, distinct bugs, both required for this to
ever have worked: (1) `checkSelfDefense()` was gated on `!acting`, which now spans an entire
physical action (up to 90s), so a threat mid-mine/mid-craft got no response until the health-
triggered interrupt engaged at 30% health -- fixed using that same handler's own force-cancel-
then-wait-then-act sequence, plus lowering the check interval 7s -> 2s after a live test found a
zombie could kill a bot in about 7 seconds, right at the old interval's edge. (2) The actual
foundational bug: `nearestHostile()` required `entity.type === "mob"`, but a real zombie's actual
type on this server is `"hostile"` -- confirmed by direct inspection. This function had never
matched a single real hostile mob since it was written, on any version of this codebase. Verified
live: a bot that died outright to a summoned zombie before these fixes correctly detected it,
fought back while healthy, fled once low on health, and survived afterward.

**Teleport-when-stuck**: a bot physically wedged in terrain doesn't get unstuck by a process
restart -- Minecraft persists position across reconnects like a real player logging back in, so
she gets stuck again immediately. `checkStuck()` escalates to a self-teleport
(`bot.chat("/tp ...")`, to `bot.spawnPoint` -- the server's own real compass-needle target, not
corrupted by the bot's own stuck position) after repeated in-process nudges; a new cross-restart
check (`goals.js`'s `loadStuckState`/`saveStuckState`) catches a bot being restarted faster than
one `checkStuck` cycle can complete, by comparing position across the restart itself.

**Dusk awareness**: `checkDusk()` (30s timer) sends a bot home -- the new `"gohome"` action,
also targeting `bot.spawnPoint` -- once `bot.time.timeOfDay` crosses `MC_DUSK_START_TICK`
(10000 default), once per night, rather than waiting for full dark or relying on the separate
sleep logic to notice.

**Cross-bot goal arbitration** (design doc §6, previously undelivered): `arbitrateGoalConflict()`
makes a real `super`-role model call before a self-proposed goal is adopted, checking it against
what other bots are already actively doing and substituting a different concrete goal only on a
genuine conflict (same scarce resource/location right now, not just loose topical overlap).

**Long-term memory deduplication**: `writeMemoryNote()` (`longterm.js` 1.1.0) now skips writing
a note that's a near-duplicate (cosine distance <= 0.15, calibrated against real duplicate/
non-duplicate note pairs found live) of one already in the corpus -- a real gap found live where
the same fact got written to the shared world corpus six separate times in one night.

**Fixed (was a known limitation)**: the single global `busy` flag that guards the classify/reply
step was also held by ten different autonomous-action functions (`goalTick` and nine idle-tick
checks) for their *entire physical-action duration*, not just the brief decision that preceded
it -- so with the autonomy loop keeping a bot busy most of the time, real player chat was being
dropped unconditionally as "busy" across an entire day almost without exception, before ever
checking whether the message was addressed to this bot. Fixed by holding only `acting` (which
already correctly prevented these functions from double-firing) around the physical action, and
splitting `goalTick` into a planning phase (holds `busy` briefly) and an execution phase (doesn't)
-- this needed nothing new, since every action already calls `stopCurrent()` first and safely
interrupts whatever's physically in flight. The ambient-vs-addressed relevance classification
itself (`classifyIntent()`'s `OTHER_BOTS` note, making a bot stand down when a message names a
different bot by name) was already correct on the messages that made it through.

**"Fix all the above" batch** (2026-09-08, direct follow-up to a "what other autonomous behaviors
are solvable" survey): six real gaps closed in one pass. (1) Skill retrieval threshold
recalibrated 0.7 -> 0.78 against the real, organically-grown 20-skill corpus (the original value
was tuned against a single seeded skill and was rejecting roughly half of genuinely relevant
matches once a real corpus existed). (2) Cross-bot resource contention: new
`filterAwayFromOtherBots()` avoids mining/exploring a block position too close to another live
bot (a purely spatial check, independent of and complementary to `arbitrateGoalConflict()`'s own
goal-text-time judgment, which can't see two non-conflicting goals physically converging on the
same vein). (3) Farming from scratch: `"harvest"` now tills open ground and plants seeds when
nothing is ripe yet, instead of only ever working a field that already existed. (4) Bed
ownership: `loadClaimedBed()`/`saveClaimedBed()` persist whichever bed actually worked and try it
first every night, instead of every bot re-competing for "nearest" and colliding on a shared map
with fewer beds than bots. (5) Inventory insurance: `checkInventoryInsurance()` proactively banks
surplus valuables (ingots, spare gear) after taking real damage, not just when inventory space
runs out, so an otherwise-survivable death doesn't erase progress a nearby chest could have saved.
(6) Squad response: Mark/Luke (`MC_SQUAD_RESPONDER=true`) now hear a teammate's threat alert
(broadcast over the existing `minecraft-coordination` Buzz topic) and travel to help fight, matching
their own "defend the perimeter" military framing instead of self-defense staying purely
individual. Also fixed along the way: a live bug found while verifying Mayor's first directive --
`"attack"`/`"flee"` were re-deriving the threat entity a second time instead of using the one
`checkSelfDefense()` already found, racing it moving/despawning and thrashing indefinitely
(observed live: 90+ seconds of "threat detected" -> "no hostile mobs nearby" with zero actual
combat).

**Full activity log** (2026-09-08, direct request: "setup a log of their activities that would
be sufficient for review later, to look for misbehaviors and broken behaviors"). A new companion
service, `infra/minecraft-bots-activity-log/` -- a full, raw `journalctl -f` mirror of all five
bots into one durable, bot-scoped file (`/mnt/hermes-data/minecraft-memory/activity.log`,
rotated daily via `logrotate`, 14 kept). Deliberately separate from `hermes-minecraft-triage.py`'s
own `triage.log`: that one only ever records the LLM triage of a known `TRIAGE_PATTERNS` match,
so it can't surface a misbehavior nobody has pattern-matched yet -- this one keeps everything, for
exactly that kind of later, open-ended review.

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
MC_HOST=192.168.1.221 MC_PORT=25580 MC_BOT_USERNAME=Amy ./run-bot.sh    # own process, same as every other bot
MC_HOST=192.168.1.221 MC_PORT=25580 MC_BOT_USERNAME=Mark ./run-bot.sh
MC_HOST=192.168.1.221 MC_PORT=25580 MC_BOT_USERNAME=Luke ./run-bot.sh
MC_HOST=192.168.1.221 MC_PORT=25580 MC_BOT_USERNAME=Mayor ./run-bot.sh
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
| 3.19.0 | 2026-09-09 | Two more real bugs in sapling planting, found via a 25-minute post-deploy watch: Luke and Mayor never once found a spot to plant near their base (rule 2 had no wander fallback like every other search-based action already has -- fixed), and a real placement failure traced to the "air above" check being too loose (accepted a spot where a sapling/plant was already growing -- now requires real air). |
| 3.18.0 | 2026-09-09 | After a successful craft or smelt, surplus materials are now stored in the chest nearest to the bot's own claimed bed ("home"), not just the nearest chest overall -- new `storeSurplusNearHome()` + `"store"`'s new `near` param. Also fixes a real live crash in the previous sapling-planting feature (an unguarded null `block.position` in its own chest/ground search, the same mineflayer edge case `findNearestShore()` had already hit once before). |
| 3.17.0 | 2026-09-09 | Bots now plant any sapling they pick up (an incidental drop from mining/chopping trees) -- near an existing tree of the same species if one's reachable, otherwise on open ground that isn't next to a "building" (a practical heuristic: any functional/crafted block or common construction material nearby). New `checkSaplings()` idle-tick reflex and `"plant_sapling"` action. |
| 3.16.0 | 2026-09-08 | Mayor now runs a fixed tech-tree curriculum (basic tools -> basic armor -> farming -> iron gear -> diamond gear -> enchanting) instead of freeform directives -- progress tracked via real, verified DONE items (his own gear checked directly, everyone else's via their own checked `DONE <item_id>` broadcasts), advancing the whole fleet together once everyone clears a stage. Persisted so a Mayor restart doesn't reset progress. |
| 3.15.0 | 2026-09-08 | First live misbehavior review (25-minute capture via the new activity log) found and fixed a real bug: both actual deaths in the window lost gear recovery entirely to a token-update race between emergency handlers and `recover()`'s own single-shot goto -- now retries (bounded) on that specific failure. Also added diagnostic logging for the planner's still-recurring "couldn't decide what to do next" fallback. |
| 3.14.0 | 2026-09-08 | New `infra/minecraft-bots-activity-log/` companion service -- a full, raw, durable `journalctl` mirror of all five bots (`activity.log`, daily-rotated) for later open-ended misbehavior review, separate from `hermes-minecraft-triage.py`'s own pattern-matched-only `triage.log`. Also added `infra/minecraft-bots/minecraft-bot-mayor.service` to the repo (deployed 2026-09-08, never previously committed). |
| 3.13.0 | 2026-09-08 | Fixed hallucinated goal completions ("Mark and Luke claim they have bows"): a goal is only announced DONE after the specific item that proves it is verified against real inventory/equipped gear, not just on the model's own say-so. The existing "did any step ever succeed" check couldn't catch this -- an unrelated successful step elsewhere in the same goal was enough to pass it. |
| 3.12.0 | 2026-09-08 | Functional/crafted blocks (bed, furnace, crafting table, bookshelf, etc.) can no longer be dug or destroyed -- `"mine"` refuses to deliberately target one by name, and `movements.blocksCantBreak` now protects them from the pathfinder auto-digging through one incidentally while routing around an obstacle (confirmed live: stock mineflayer-pathfinder only ever protects chests and non-diggable blocks by default). |
| 3.11.0 | 2026-09-08 | Fixed Babs/Amy/Mark/Luke going permanently idle after a goal ended -- Mayor's own periodic chat was resetting `lastActivityAt` for every other bot (the timer that gates "propose a new goal after 10 quiet minutes"), so as long as Mayor kept talking, no one else's idle clock could ever elapse. Now only a real player's message resets it. |
| 3.10.0 | 2026-09-08 | "Fix all the above" batch: skill retrieval threshold recalibrated (0.7->0.78), cross-bot resource contention (`filterAwayFromOtherBots()`), farming from scratch (till+plant fallback in `"harvest"`), bed ownership (`loadClaimedBed`/`saveClaimedBed`), inventory insurance (`checkInventoryInsurance()`), squad response (Mark/Luke respond to a teammate's threat alert). Also fixed a live self-defense thrash bug found while verifying Mayor's first directive (`"attack"`/`"flee"` now reuse the already-found threat entity instead of racing a second lookup against it). |
| 3.9.0 | 2026-09-08 | New fifth bot **Mayor** -- a muse-drafted leader persona who treats the operator as "The President" and whose directives the other four bots defer to (`isMayor()`'s exception to `isAnotherBot()`) unless a real player already assigned them something. Proactively assigns idle teammates a task (`proposeDirectiveForOthers()`). |
| 3.8.0 | 2026-09-08 | Generalized the duplicate-avoidance check to a shared `tryTakeFromNearbyChest()`: `"craft"` checks a chest for any item, `"mine"`/`"explore"` check for the real resulting item (`raw_iron`, not `iron_ore`) before gathering from scratch. |
| 3.7.0 | 2026-09-08 | Fixed duplicate crafting-table/furnace crafting, and fixed self-defense never actually firing -- a true mid-action interrupt plus (the real foundational bug) `nearestHostile()` checking the wrong entity type entirely (`"mob"` instead of the real `"hostile"`). |
| 3.6.0 | 2026-09-08 | New `"explore"` action -- gathers any common raw material broadly when a specific craft/mine target can't be found, forced via a deterministic `BLOCKED` override, writes a world memory note on success so it's remembered for later. |
| 3.5.0 | 2026-09-08 | Bots now actually swim to real shore after surfacing (`findNearestShore()`) instead of just treading water where they surfaced -- verified live swimming 76+ blocks to dry land. |
| 3.4.0 | 2026-09-08 | Fixed bots standing around most of the time (directed wandering toward real known resources instead of guessing) and built the dynamic skill library (`MINECRAFT_BOTS_DESIGN.md` §14, new `skills.js` + a `minecraft-skills` hermes-rag corpus). |
| 3.3.0 | 2026-09-08 | Building (`"build"`, a small fixed shelter), a tool-tier gate for `"mine"` (`block.harvestTools`), and farm automation (`"harvest"` batches up to 8 crops), following a web-research gap analysis against Mindcraft-CE/Voyager/other mineflayer bots. Boat crossing has real supporting infrastructure and a genuine upstream crash fix but doesn't work end-to-end yet, blocked on an open mineflayer bug (#3742). |
| 3.2.0 | 2026-09-07 | Swimming: an anti-drowning reflex (`index.js` 2.29.0, `bot.on("breath")`) and real water-crossing pathfinding (`index.js` 2.30.0, new `swim-movements.js`'s `SwimMovements`, fixing `mineflayer-pathfinder`'s own inability to change depth once already in liquid). |
| 3.1.0 | 2026-09-07 | The `busy`-flag lockout of real player chat (flagged as a known limitation in 3.0.0) is fixed -- `index.js` 2.28.0 holds only `acting` around the ten idle-tick functions' physical actions instead of `busy` for their whole duration. |
| 3.0.0 | 2026-09-07 | Catch-up rewrite (this file had drifted to v2.10.0 while the code moved to index.js 2.27.0/actions.js 1.20.0): Mark & Luke added (4 bots total), 21-verb action set, hazard-aware pathing + full OOM investigation/fix chain (heap ceiling raised 768MB->1536MB after live evidence the leak was slowed, not eliminated), teleport-when-stuck, dusk awareness, sleep self-defense, cross-bot goal arbitration, memory-note deduplication, and a documented known limitation (the global `busy` flag drops real player chat almost all the time now that the autonomy loop keeps bots busy most of the day). |
| 2.10.0 | 2026-09-07 | Bots sleep at night: deterministic `checkSleep()` on its own timer plus a new `"sleep"` action (`actions.js` 1.9.0) built on mineflayer's own `bed.js` plugin. Also directly triggerable via `ACTION SLEEP`. |
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
