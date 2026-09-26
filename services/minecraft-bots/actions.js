// Version: 1.74.0
//
// 1.74.0 (2026-09-25) -- first live hour: harvest says which ripe crop it couldn't reach or break,
// and only walks over drops after it actually harvested something.
//
// 1.73.0 (2026-09-25) -- farming and ranching, from a day of logs (0 farm/ranch steps, 4,203 failed
// "eat"s). loot takes groups ("food", "seeds"); harvest builds a real plot (next to water, clears
// plants on top, checks each block turned to farmland and each seed took), can harvest only ripe
// crops, and reports what it did; build_pen takes a site; breed can stay at the pen and checks a
// baby actually appeared; herd_to_pen waits for the animal and holds the gate only while leading; pens
// are 7x7. Verified achievements (harvested:/penned:/bred:) are recorded per bot for
// the Mayor's curriculum. A failed OUTCOME line now says why.
//
// 1.72.0 (2026-09-25) -- herd_to_pen holds doors open (swim-movements.js holdDoorsOpen) so the door
// closer doesn't shut the pen gate on the animal being led in.
//
// 1.71.0 (2026-09-25) -- bed claims are shared between hosts through hermes-memory agent_state
// ("minecraft-beds"); BEDS_DIR is the per-host fallback, and a host's existing claim is published
// on its first read. MC_BED_CLAIMS_SHARED=false keeps claims per host.
//
// 1.70.0 (2026-09-25) -- beds: a destroyed claimed bed is replaced with the nearest unclaimed bed
// (new exported checkClaimedBed, also settling two bots on one bed by name order). Sleep tries one
// candidate per bed (not per half), unclaimed before other bots' beds, and never claims another's.
//
// 1.69.0 (2026-09-25) -- HOSTILE_MOBS exported for index.js's fight-or-flee policy.
//
// 1.68.0 (2026-09-25) -- test isolation: beds/pen/known-chests paths honor MC_MEMORY_ROOT.
//
// 1.67.0 (2026-09-24) -- review follow-up, closing the remaining gaps. MB-02: flee runs on
// its own Movements copy and restores the shared one only if its copy is still active. MB-08: new
// "place_home" action (gohome, then place, one token). MB-18: performAction logs one structured
// OUTCOME line per action. Redundancy: an empty chest search isn't repeated from the same spot
// within 60s, and refreshGear skips when no gear-relevant state changed.
//
// 1.66.0 (2026-09-24) -- review remediation, tier 4 (docs/reviews/2026-09-24-minecraft-bots-review.md).
// MB-15: raw fish/meat are edible (ranked after cooked food; golden apples last) and SMELT_RECIPES
// can cook them, closing the fishing-for-food loop. MB-16: EXPLORE no longer "succeeds" by
// withdrawing chest stock; EXPLORE <feature> scouts for SCOUT_FEATURE_BLOCKS and succeeds only when
// the feature is actually found. MB-17: chest withdrawal spans mixed item types (oak + birch logs)
// instead of asking one type for the family total, and always closes the window.
//
// 1.65.0 (2026-09-24) -- review remediation (docs/reviews/2026-09-24-minecraft-bots-review.md).
// MB-01: "attack" actually starts combat again -- 1.42.0's polling rewrite dropped the
// bot.pvp.attack() call itself, so every fight since 2026-09-10 only waited out its timer; a kill
// is now claimed only on this target's entityDead. MB-02: performAction() takes the caller's
// arbiter handle and refuses a handle that lost control (or a handle-less call while someone else
// owns the body) instead of borrowing the current owner's token; finally-block cleanup
// (setGoal(null), refreshGear) only runs while the caller still owns control. MB-04: any result
// produced after cancellation is reported { ok: false, cancelled: true } rather than ok(...).
// MB-08: "gohome" joins SKILL_ACTION_VERBS.
//
// 1.64.0 (2026-09-21) -- direct request: "re-evaluate the entire defense scheme," root-caused
// from a live mass-death incident (5 bots died within ~90 seconds). "attack" now accepts an
// optional `action.maxDurationMs` (falls back to ACTION_TIMEOUT_MS unchanged for every existing
// caller) so EMERGENCY-tier combat (index.js) can give a critically-hurt bot a short, bounded shot
// instead of committing to the full 90s timeout with no way to reconsider -- confirmed live that a
// single stuck emergency attack held the arbiter's HEALTH_CRITICAL tier for over 20 straight
// seconds with nothing able to preempt it. See MINECRAFT_BOTS_DESIGN.md §52.
//
// 1.63.0 (2026-09-21) -- direct request: "I want real confirmation they can use the crafting
// table and furnace." Investigating turned up a real, severe, already-live bug rather than just
// confirming one: a 24h fleet-wide log sweep found ZERO successful smelts anywhere, every single
// attempt failing "found furnaces nearby, but couldn't use any of them." Root cause confirmed via
// this file's own per-furnace slot diagnostic logging (2026-09-07): the fleet's two real furnaces
// were jammed with 63-64 coal_block already sitting in their fuel slots (the hard per-slot cap)
// plus 16 iron_ingot stranded in one's output, uncollected -- "smelt" called putFuel()
// UNCONDITIONALLY every attempt regardless of existing fuel, so once a slot maxed out, every
// future call threw "destination full" and aborted the whole smelt before ever reaching putInput,
// even though the furnace already had more than enough fuel to work with. Fixed: collects any
// existing output first (recovers whatever was stranded), and treats a failed putFuel() as
// "already has fuel" rather than fatal -- falls through to putInput using what's already there.
// See MINECRAFT_BOTS_DESIGN.md §45.
//
// 1.62.0 (2026-09-21) -- direct live observation: "none of them fight back including the
// soldiers... if the bots are inside a building with a zombie, they seem to act as if they are
// trapped." Root-caused live during a 24h fleet review (~4,271 deaths, one bot a 408-death streak
// in one spot): "flee" shares the same canDig-enabled Movements every other action uses; in an
// enclosed room, the only path that increases distance from a threat can require digging through
// a wall, and when that dig fails, pathfinder recomputes the IDENTICAL best-cost path and fails
// again immediately -- confirmed live via path_reset: dig_error firing dozens of times a SECOND
// with an unchanged nodes/cost signature, holding SELF_DEFENSE/EMERGENCY control the whole time
// while she's still taking hits and (EMERGENCY-tier flee never attacks) never fighting back
// either. Disabling digging for just this one pathfind now forces a real walkable escape or a
// clean, fast failure instead of an infinite stuck loop. See MINECRAFT_BOTS_DESIGN.md §42.
//
// 1.61.0 (2026-09-19) -- direct follow-up: "the downgrade rejection must also reject if the
// mayor's instructions would cause the quality of their equipment to be reduced." §40's own "give"
// check only ever caught going from "has one" to "has none" -- giving away a diamond sword while a
// wooden one stays behind is a downgrade too, even though she'd technically still have "a sword."
// New GEAR_TIER_RANK (a single common-sense material ranking, not a precise armor-point/mining-
// level simulation -- good enough to answer "worse than before") lets the same check also compare
// the tier of what's being given against the best tier she'd be left holding in that category.
// See MINECRAFT_BOTS_DESIGN.md §40 (updated).
//
// 1.60.0 (2026-09-19) -- direct request: "Mayor/Leader missions, if they would effectively
// DOWNGRADE a bot's equipment or status, should be rejected by the bot." "give" (the concrete
// gear-loss vector -- both a direct chat command and the autonomous checkPendingGiveRequests
// fulfillment path route through this same case) never checked whether complying would leave the
// giver without a weapon/armor/tool she still needs, whoever asked -- the exact mechanism behind
// Mark being gifted a sword twice by teammates yet ending up swordless anyway (§34: he died
// between the gifts, a separate cause, but this closes the OTHER real way that keeps happening --
// a bot handing away her own last one on request). Now refuses (a clear fail(), not a silent
// no-op) when giving would take the item's whole category from "has one" to "has none": sword/axe
// treated as one interchangeable weapon category (matching equipment.js's own hasWeapon()),
// armor/tool suffixes each their own. A genuine spare is always still fine to give. See
// MINECRAFT_BOTS_DESIGN.md §40.
//
// 1.59.0 (2026-09-19) -- direct request: "expand their search capabilities further, especially the
// miner and explorer roles." New env-tunable MINE_SEARCH_RADIUS/EXPLORE_SEARCH_RADIUS/
// EXTENDED_SEARCH_DISTANCE (same per-bot-tuning pattern as MC_SELF_DEFENSE_RANGE, §21) replace
// "mine"/"explore"'s own hardcoded 32-block scan radius -- Babs (Miner) and Wade (Explorer) now
// search meaningfully farther via their own systemd units without touching the shared default for
// everyone else. MINE/EXPLORE_SEARCH_RADIUS kept well under bot.pathfinder.searchRadius's own
// documented 48-block OOM ceiling (this file's own established caution) since a found block gets
// one unhopped collectBlock pathfind straight to it; EXTENDED_SEARCH_DISTANCE raised more freely
// since wanderAndRetryFind's own walk there is already hop-capped regardless of beacon distance.
// See MINECRAFT_BOTS_DESIGN.md §39.
//
// 1.58.0 (2026-09-18) -- direct request: "have the threatened bot run towards safety, run towards
// golems, or soldiers." New nearestFriendlyGolem() (alongside nearestHostile()) and "flee" now
// heads directly to an action.rallyPoint when index.js supplies one (via its own new
// nearestRallyPoint() -- golem > nearby Soldier teammate > home) instead of only ever maximizing
// distance from the threat with no destination in mind. See MINECRAFT_BOTS_DESIGN.md §37.
//
// 1.57.0 (2026-09-18) -- direct live report: "Luke is getting shot, not reacting. there is no mass
// mob." Root-caused: Luke's self-defense held SELF_DEFENSE-tier control on an unproductive
// "attack" against an enderman for over a minute (teleport-evasion defeats bot.pvp's chase-and-
// melee the same way flight defeats it for phantom/ghast), silently blocking any response to a
// SEPARATE skeleton sniping him the whole time. Confirmed not a one-off: Mark/Luke logged
// 2,800/1,770 enderman self-defense triggers in 24h, far above every other bot. FLEE_ONLY_MOBS
// now includes "enderman" -- see its own updated header below for the full reasoning.
//
// 1.56.0 (2026-09-18) -- direct request: "if the bot is in need of a piece of equipment (sword,
// armor, pickaxe, etc), and finds one already crafted in a chest, it should pick up ONE of those
// pieces of that equipment and abandon the quest to craft it." The existing craft/loot
// chest-substitution checks (2026-09-08/2026-09-17) already stopped a bot from crafting
// something already sitting in a chest -- but only ever matched the EXACT item id the model
// happened to name. A chest holding an iron_pickaxe was invisible to a "craft wooden_pickaxe"
// check, so she'd craft (or keep looking for) the specific tier she'd guessed instead of
// recognizing any real pickaxe as already satisfying the need. New gearCategoryNames() broadens
// the search to every real tier sharing the same GEAR_SUFFIXES suffix, wired into both "craft"'s
// own chest-check and "loot"'s local + remembered-chest matching -- raw materials are untouched
// (an iron_ingot really is the one specific thing a recipe needs, no "any tier" concept applies).
// "Abandon the quest" itself needed no new mechanism: the substituted item is now honestly
// reported in the step result and her own gear/inventory snapshot on the next planNextStep tick,
// so the existing DONE-recognition already closes the goal on its own -- the same real-world-
// state-driven completion check this whole hallucination-detection system already relies on.
//
// 1.55.0 (2026-09-17) -- direct request: "if they craft armor or weapons or tools, they should
// equip them." refreshGear()'s own comment ("a freshly-crafted tool/weapon/armor piece should get
// equipped") turned out to only be half true -- equipBestArmor/equipBestWeapon cover armor and
// sword/axe-class weapons, but pickaxe/shovel/hoe were never weapon-classed, so a freshly-crafted
// mining/digging/farming tool just sat unequipped in inventory. The "craft" case now equips the
// SPECIFIC item just crafted when it's one of those three, not a tier comparison against whatever
// was already held -- she made it on purpose. This surfaced a real, independent gap in "attack":
// nothing there ever re-equipped a weapon before engaging, only refreshGear() in the finally block
// AFTER a fight ends -- meaning a bot could walk into combat holding whatever a prior action left
// in hand (now more likely to be a tool). equipBestWeapon() now runs at the top of "attack" too,
// so combat always starts weapon-in-hand regardless of what was held a moment before.
//
// 1.54.0 (2026-09-17) -- direct request: "when a bot opens a chest, they loot EVERYTHING instead
// of what they need. They need to: take only the mats they need for their current objective; put
// any leftovers... in a chest; all chest contents goes into world memory." The "loot" case used
// to sweep every stack in a chest (capped at one per distinct tool, otherwise a full stack)
// regardless of whether any of it was wanted -- a deliberate 2026-09-07 design choice ("this is a
// curated sandbox server, not a real-survival dungeon") the operator is now explicitly reversing.
// action.item (optional, matching MINE/CRAFT/SMELT's own <item_id> <count> shape -- see index.js's
// own vocabulary/parser changes) makes it genuinely need-based: naming an item withdraws up to
// <count> of exactly that one via tryTakeFromThisChest, the SAME helper "mine"/"craft"'s own
// chest-first fallback already uses, so there's one implementation of "take up to N of X from a
// chest," not two independently-drifting ones. Omitting the item (still valid, e.g. a bare
// "ACTION LOOT" or a direct "check that chest" with nothing specific named) is now a pure
// inspection -- opens the chest, snapshots its real contents into known_chests.json for the whole
// fleet (§19/§27's chest registry was already correct and fleet-wide; this just stops the ONE
// caller that used to also sweep it clean), takes nothing. "Put leftovers in a chest" needed no
// new mechanism -- storeSurplusNearHome()/checkInventoryFull()/checkInventoryInsurance()
// (index.js) already cover it generically; index.js's own post-craft cleanup trigger now also
// fires after a targeted loot that actually withdrew something, for the same reason it already
// fires after craft/smelt.
//
// 1.53.0 (2026-09-13) -- direct request: "rebalance the bots so they each have exactly one
// role... create [more] so every role has at least one bot." OTHER_BOT_USERNAMES (this file's own
// independent duplicate of index.js's BOT_USERNAMES roster, kept in sync rather than a shared
// import per this file's own "index.js does the mutating" header) extended with the three new
// bots (Nell, Wade, Dale) so their positions get the same proximity-avoidance treatment every
// other bot's already gets. See MINECRAFT_BOTS_DESIGN.md §22.
//
// 1.52.0 (2026-09-13) -- direct request: "extend resource sharing memory and scouting to *any*
// resource or crafted object. remember what is in chests when someone opens it. if someone takes
// the item out of a chest, redact it from global memory. They need to OPEN doors not destroy
// them as well." Four real changes:
// (1) Doors/trapdoors/fence gates added to isProtectedBlockName() -- the list that actually
// feeds movements.blocksCantBreak (index.js). canOpenDoors was already enabled (2026-09-07) but
// nothing stopped pathfinder from falling back to digging through a door if that logic didn't
// apply to a given move -- the same "diggable by the library's own definition" gap this list
// already closed for furnaces/beds/chests, just never extended to the one block class the
// operator specifically named.
// (2) getResourceBlockNames(bot) replaces the old hand-picked EXPLORE_TARGET_NAMES (oak_log/
// coal_ore/iron_ore/copper_ore) -- derived programmatically from this server's own real block
// registry (every "_ore"/"_log"/"_stem" name, plus ancient_debris) so gold/diamond/redstone/
// lapis/every other log species get the same shared-memory benefit those four always had.
// (3) New known_chests.json registry (loadKnownChests/saveKnownChests/recordChestSnapshot/
// findKnownChestWithItem): a structured, mutable, position-keyed store -- deliberately NOT the
// fuzzy RAG-based world-memory notes used for resource locations elsewhere in this file, since a
// chest's contents change every time anyone opens it and need real point-in-time overwrites, not
// a growing pile of similar notes. Every real chest interaction (tryTakeFromNearbyChest, "loot,"
// "store") now snapshots the chest's CURRENT contents right before closing it -- "remembering"
// and "redacting" are the same operation (always writing the current truth) rather than two
// separate features to keep in sync. tryTakeFromNearbyChest's own local-search loop was
// refactored into a shared tryTakeFromThisChest() helper so a new remembered-chest fallback
// (consulted when local search comes up empty, same "local first, remembered second" pattern
// "mine" already uses) doesn't duplicate the open/withdraw/snapshot logic.
// (4) "craft"'s own crafting-table search gained the same local-then-remembered fallback via
// findRememberedLocation("crafting_table") -- a table someone else placed, or one this bot saw
// earlier and wandered away from, is exactly as worth remembering as an iron vein.
//
// 1.51.0 (2026-09-12) -- direct report "a chest with sticks already made is ignored when they
// need sticks," confirmed live: tryTakeFromNearbyChest() used to require ONE slot to
// independently hold >= wantCount. A real, common deposit pattern (multiple bots each banking a
// few via "inventory insurance," 2.39.0) easily splits the same item across several slots (e.g.
// 3+3+2 sticks from three separate deposits) -- .find() against a single-slot threshold matched
// none of them even with plenty combined. Now sums every matching slot before deciding and takes
// whatever's actually available (never more than wantCount, honestly reports less otherwise) --
// chest.withdraw() itself already draws from multiple slots of the same item/metadata
// automatically, so summing first was the only change needed.
//
// 1.50.0 (2026-09-11) -- direct request "fix ... the pen herding [and] the dynamic skill
// library". (1) New "herd_to_pen" case: build_pen (1.49.0) only ever placed the fence structure,
// never moved an animal into it -- a real, separate gap this file's own design doc flagged the
// day it shipped. Reuses vanilla's own TemptGoal follow-behavior (the same food/BREEDING_FOOD
// relationship "breed" already leans on) rather than inventing a new mechanic, walked in short
// bounded hops so the animal's own AI can keep pace, with a real per-step distance check (not
// assumed) for whether she's still following. New loadPenLocation()/savePenLocation() (build_pen
// now persists its own gate+center on success, only once the gate specifically went in) so
// herd_to_pen can find a pen built in an earlier goal/session. BREEDING_FOOD hoisted from
// "breed"'s own case block to module scope so both verbs share one definition. (2)
// SKILL_ACTION_VERBS gained harvest_hive/shear/milk/build_pen/herd_to_pen -- every verb built
// this session had been left out of the skill-library's own allowlist entirely, meaning none of
// them could ever be compressed into a reusable skill despite being self-contained the same way
// breed/harvest already are. repair_terrain deliberately still excluded, same reasoning as
// gohome/recover's own existing exclusion (see that comment) -- its position is a live-discovered
// pit a stored skill has no way to reconstruct.
//
// 1.49.0 (2026-09-11) -- direct follow-up ("what's next" -> "2", closing §15.11's remaining
// Herder/pen gaps rather than deploying yet). New "shear" (sheep -> wool) and "milk" (cow ->
// milk_bucket) cases -- both bot.activateEntity() while holding the right tool, the same
// generic right-click primitive "breed" already uses to feed an animal, no dedicated API for
// either. Neither pre-checks "already sheared"/cooldown state (mineflayer's own entity-metadata
// index for that isn't confirmed stable across versions) -- just tries, same discipline "breed"
// already applies to a cooldown it also doesn't pre-check. New "build_pen" case: one fixed 5x5
// fence-perimeter-plus-gate shape, same "small fixed shape, not a general planner" philosophy as
// "build"'s own shelter -- closes the design doc's own pen/fence `[UNKNOWN]`, resolved in favor
// of a dedicated verb (not folded into "build"'s existing vocabulary) since a pen's shape
// (fence blocks, open top, a gate) doesn't share geometry with a shelter's (solid walls, a roof).
//
// 1.48.0 (2026-09-11) -- direct follow-up ("nest" again -> "honeycomb via shears too"):
// "harvest_hive" (1.47.0) now takes action.tool -- "bottle" (default, honey, never angers the
// bees at full honey_level) or "shears" (honeycomb, always angers them, but the only real path
// to enough honeycomb to ever craft a NEW beehive -- "craft"/"place" were both already fully
// generic against bot.registry/bot.recipesFor and needed zero changes to handle a beehive once
// the ingredient exists). The tradeoff is exposed explicitly, not hidden behind a single
// "best" choice -- a caller who specifically needs honeycomb accepts the risk on purpose.
//
// 1.47.0 (2026-09-11) -- direct follow-up ("nest" -> "bee nests/hives"): new "harvest_hive" case,
// closing part of §15.11's Herder capability gap (pen/fence containment for other animals is
// still open -- this is scoped to bees). Collects honey via bot.activateBlock() while holding a
// glass bottle against a full (honey_level >= 5) beehive/bee_nest -- deliberately never shears
// (honeycomb), since a bottle harvest at full level doesn't anger the bees the way shearing
// always does. Also added "bee" to the existing "breed" case's own BREEDING_FOOD map (any common
// flower item, matching real vanilla bee-breeding mechanics) -- bees were breedable with zero new
// code before this, just an unlisted species.
//
// 1.46.0 (2026-09-11) -- direct request: "start building" the rest of MINECRAFT_BOTS_DESIGN.md
// §15.10 (Builder/Artist terrain repair -- "pits should be filled to level ground with the most
// appropriate material, mostly determined by matching the nearby ground blocks, but also guided
// by function -- plants cannot be placed in stone"). New "repair_terrain" case: fills ONE column
// (bottom-up, same "each new block references an already-placed block below it" ordering "build"
// above already established, for the same reason) at a position index.js's new
// checkTerrainDamage() supplies -- this file does the FILLING, not the scanning/detection, same
// division of labor as "light_area" (index.js finds dark spots, this file lights them). Material:
// an explicit action.material override (checkTerrainDamage sets this to "dirt" specifically when
// plantable ground -- grass_block/dirt -- is found among the pit's own rim neighbors, the
// function-over-appearance case from the design doc) takes precedence over sampling the
// neighborhood's most common solid block, the "match nearby ground" default case.
//
// 1.45.0 (2026-09-11) -- direct request: "if one bot is looking for a specific resource, it
// should look near itself (current understanding added to global world memory), ask the other
// bots to look near themselves (they add/update world memory too), then use global world memory
// to gather a resource if it's not in its own immediate vicinity." This file's own half: "mine"
// now tries a remembered position (new findRememberedLocation(), parsing the existing
// "near (x, y, z)" note format explore's own success note already used) between its local
// findBlocks() and the existing blind wanderAndRetryFind() fallback -- cheap (one RAG query, no
// movement) and, on a hit, a direct trip instead of a directionless search; a stale/wrong note
// just falls through to the unchanged wander fallback. EXPLORE_TARGET_NAMES hoisted to module
// scope and exported so index.js's new noteNearbyResources() (the "look near itself"/"ask the
// fleet" half, and the new "scout" Buzz payload) scans the exact same curated resource list
// "explore" already does, not a second independently-drifting one.
//
// 1.44.0 (2026-09-10) -- direct live follow-up to 1.43.0's own detection fix, same report
// ("they don't seem to be able to fight, or run from, phantoms"): fixing detection alone wasn't
// enough. Confirmed live, unambiguously: once self-defense could finally SEE a phantom, its
// "attack" choice held SELF_DEFENSE-tier arbiter control for the full 90s ACTION_TIMEOUT_MS
// ceiling every single time, because a ground-bound bot's pathfinder can never actually close to
// melee range against something flying overhead -- during that entire 90s span, every other
// self-defense re-trigger, squad response, and recovery attempt correctly reported "yielded to
// something more urgent (SELF_DEFENSE)," repeating every time the doomed chase re-triggered.
// That's exactly what "can't fight or run" looks like live. New FLEE_ONLY_MOBS (phantom, ghast --
// both flyers) always flees, never melee-attacks, regardless of health; fleeing doesn't need to
// reach the target and was already confirmed live to genuinely create real distance every cycle.
//
// 1.43.0 (2026-09-10) -- direct live report: "they don't seem to be able to fight, or run
// from, phantoms." Real bug, confirmed against minecraft-data's own entity registry directly:
// nearestHostile()'s "hostile" type requirement (added in 1.42.0's own predecessor fix) is wrong
// for phantom, ghast, slime, and shulker -- all four carry entity.type "mob", not "hostile",
// despite minecraft-data's own separate "category" field correctly listing all four as "Hostile
// mobs." Self-defense/checkSleepingThreat/"attack"/"flee" targeting never even saw a nearby
// phantom as a threat at all -- a silent detection failure, not a combat or targeting bug. The
// "hostile" type check added no real safety on top of the already-curated HOSTILE_MOBS name
// allowlist (nothing outside that deliberate list was ever going to match by name); it only
// excluded entries whose real type field happens to disagree with minecraft-data's own category
// field. HOSTILE_MOBS.has(e.name) alone is now the sole condition.
//
// 1.42.0 (2026-09-10) -- direct live report: "they're still not fighting back or running."
// Real bug, confirmed by reading the actually-installed mineflayer-pvp 1.3.2 source directly
// (lib/PVP.js): "attack"'s own long-standing comment claiming bot.pvp.attack() "resolves its own
// promise once the target is dead or lost" was simply wrong for this version -- it only sets up
// the chase (this.target + a fresh pathfinder GoalFollow) and returns almost immediately; combat
// itself runs forever off the library's own internal physicTick listener, independent of that
// promise. Every checkSelfDefense cycle (2s) was therefore reporting "took care of it" the
// instant the chase was merely STARTED, and since arbiter.js's cancelPhysical() unconditionally
// calls bot.pvp.stop() at the top of every requestControl() acquisition (even a same-owner,
// same-target reacquisition), the next 2s tick kept restarting the same chase from scratch before
// it ever had time to close distance or land a hit -- confirmed live: Mark and Luke both reported
// "took care of it" against the same still-alive zombie_villager every single tick for 20+
// seconds with zero health change on either side, visually indistinguishable from not responding
// at all.
//
// A first fix attempt (waiting on the library's own 'stoppedAttacking' event instead) was ALSO
// wrong, confirmed live a second time against Luke fighting a creeper: that event fires for ANY
// stop() call, including cancelPhysical()'s own fire-and-forget bot.pvp.stop() -- called at the
// top of the VERY SAME requestControl() acquisition that's about to start this fight. That call's
// own cleanup was still asynchronously in flight (it awaits the pathfinder's own internal
// 'path_stop' event before it finishes) when this fight's fresh listener attached moments later,
// so its stale, unrelated emission was mistaken for "the fight just ended" -- reproducing the
// exact same instant-"took care of it" symptom via a different mechanism.
//
// The actual fix: poll the target's own real, unambiguous state (is it still a tracked entity at
// all, i.e. bot.entities[target.id]) instead of inferring anything from a shared/ambiguous event
// -- the same "check the real thing directly" approach every OTHER cancellable action in this
// file already uses (token.cancelled checked against real pathfinder/collectBlock rejection,
// never guessed at from an event). Also aborts promptly on a genuine higher-priority preemption
// (token.cancelled) rather than only on the full ACTION_TIMEOUT_MS ceiling. This also
// structurally fixes the restart-loop as a side effect: checkSelfDefense's own performAction()
// call (and its selfDefenseInFlight guard) now correctly blocks for the fight's real duration
// instead of returning after ~0ms.
//
// 1.41.0 (2026-09-10) -- Phase 2 follow-up, real bug caught live while migrating the first
// reflex handler (checkSelfDefense, index.js 2.50.0): performAction()'s own stopCurrent() call
// was unconditionally cancelling-and-rotating on EVERY call, which would immediately stomp a
// caller's own just-acquired arbiter.requestControl() handle (marking its token cancelled,
// rotating `current` out from under it) the instant that caller went on to call performAction()
// itself. stopCurrent() now reuses the already-current token when one exists (arbiter.isBusy())
// instead of rotating a new one; performAction() itself now releases that token in a finally
// block, but ONLY when IT was the one that acquired it (tracked via `alreadyHeld`, checked before
// stopCurrent() runs) -- a caller that already held a handle before calling in still owns release
// via its own handle.release(), untouched by this. Without this, arbiter.isBusy() would report
// true forever after the very first action any bot ever ran (nothing releasing on behalf of the
// many not-yet-migrated callers), permanently disabling stopCurrent()'s own
// cancel-before-every-new-action behavior for every action after that one.
//
// 1.40.0 (2026-09-10) -- Phase 1 of the approved per-bot coherence arbiter plan (see
// arbiter.js's own header for the full account). stopCurrent()'s real body moved to arbiter.js's
// cancelAndRotate() -- this function is now a one-line delegate. Zero behavior change in this
// phase: nothing yet calls arbiter.requestControl() ahead of a performAction() call, so every
// action still unconditionally cancels-and-rotates exactly as before.
//
// 1.39.0 (2026-09-10) -- direct request: "fix the lighting logic," following a confirmed live
// incident (1260+ deaths in ~26h, root-caused live: the shared base sat pitch dark at ground
// level with an uncapped nightly mob buildup -- dozens of hostiles counted within 80 blocks at
// once, well beyond what a single bot's one-threat-at-a-time self-defense could ever survive).
// New "light_area" action -- a real area sweep (bounded batch, LIGHT_AREA_RADIUS=10,
// LIGHT_AREA_BATCH_LIMIT=6) around a real anchor point (action.near), not the existing "place a
// torch wherever I happen to be standing" reflex (index.js's checkLighting, unchanged). Finds
// dark (light < DARK_LIGHT_LEVEL, now exported here rather than duplicated in index.js),
// mob-spawn-capable spots (solid ground below, non-functional-block below per
// isProtectedBlockName -- never torch on top of someone's chest/furnace/bed) via the same live
// findBlocks() function-matcher pattern plant_sapling/findNearestShore already use, paths to
// each, places a torch. Re-checks each spot's light level immediately before placing (another
// bot, or an earlier step in this same sweep, may have already lit it) so the whole fleet
// converges on "fully lit" without needing explicit coordination.
//
// 1.38.0 (2026-09-09) -- follow-up to 1.37.0's own deposit-failure logging: watched it live and
// the one real failure that occurred ("found chests nearby, but couldn't store anything in any
// of them") showed NO deposit-failure log line at all -- meaning every candidate was actually
// being skipped at chestObstructed() or the pathfinder-unreachable catch instead, both exactly as
// silent as the deposit failure was before 1.37.0. Same fix applied to both.
//
// 1.37.0 (2026-09-09) -- real live gap found watching the new post-craft cleanup
// (storeSurplusNearHome, index.js 2.47.0) fire: it failed twice, live, both times with
// "found chests nearby, but couldn't store anything in any of them" and zero visibility into
// why -- "store"'s own per-candidate deposit failure was silently swallowed (`catch { continue }`,
// no log), the exact same gap "sleep" already found and fixed once before (2026-09-07) for its
// own multi-candidate loop, never applied here. Now logged per candidate.
//
// 1.36.0 (2026-09-09) -- direct request: "'near a building' is defined as 6 blocks."
// nearBuilding()'s own radius (a guess of 3 until now) is now exactly 6.
//
// 1.35.0 (2026-09-09) -- follow-up live findings on "plant_sapling" (1.33.0/1.34.0), both from
// the SAME 25-minute post-deploy watch: (1) Luke and Mayor failed to find ANY spot to plant,
// every single retry, for the entire window -- rule 2 only ever checked within a fixed 32 blocks
// of wherever the bot currently stood, with no fallback (unlike "mine"/"store"/harvest's own
// till-from-scratch fallback, all of which already reach for wanderAndRetryFind() when a local
// search comes up empty). Near a base this is a real, expected failure mode: most nearby open
// ground legitimately IS "near a building" by design, since that's the whole point of a base --
// this needed the same directed-wander capability every other search-based action already has to
// reach open ground beyond the immediate settled area. Now wired in. (2) A real placement
// failure ("Server refused to place dark_oak_sapling ... the block is still dark_oak_sapling")
// traced to the "air above" check being too loose -- `boundingBox !== "block"` also accepts a
// spot where a sapling/tall-grass/flower is ALREADY growing (none of those are "block" either),
// so a target could get picked that wasn't actually plantable. Both findPlantableSpotNear() and
// rule 2's own matcher now require real `name === "air"` instead.
//
// 1.34.0 (2026-09-09) -- two changes shipped together. (1) Fixed a real live crash in
// "plant_sapling" (1.33.0), found minutes after it first deployed: rule 2's own findBlocks()
// matcher read block.position without guarding it first, and a matcher candidate can have a null
// .position despite the block itself being non-null -- the exact same mineflayer edge case
// findNearestShore() (index.js) already found and guarded against once before. Repeated on every
// SAPLING_CHECK_MS tick for any bot carrying a sapling ("sapling check failed: Cannot read
// properties of null (reading 'offset')") until fixed. (2) Direct request: "after any crafting
// activity, surplus materials should be stored in a chest as close to their sleeping home as
// possible." "store" now accepts an optional action.near ({x,y,z}) -- when given, searches for a
// chest FROM that point instead of the bot's own current position (confirmed against mineflayer's
// own findBlocks() source: `point` is the real reference every result is sorted by distance to).
// loadClaimedBed() exported so index.js's new storeSurplusNearHome() can pass the bot's own real
// claimed bed position as `near`, reusing "sleep"'s own notion of home rather than inventing a
// second one. Every existing "store" caller (checkInventoryFull/Insurance) omits `near` and keeps
// the original "nearest to wherever I am right now" behavior, which is what those actually want.
//
// 1.33.0 (2026-09-09) -- direct request: "when they find saplings, they should plant them (1)
// near other trees of the same variety if they can (2) in any free soil not directly adjacent
// to a building if they can't." New "plant_sapling" action (index.js's new checkSaplings() idle-
// tick check is the one caller -- a reflex, not something a player/planner asks for). Rule 1
// searches for an existing tree of the SAME species (action.item's own "_sapling" -> "_log"
// mapping) and plants near it (findPlantableSpotNear(), a small ground-surface scan skipping the
// trunk itself); rule 2 falls back to any grass/dirt with clear air above that isn't near a
// "building" -- no real in-game flag for that, so looksLikeBuilding()/nearBuilding() use a
// practical heuristic (any functional/crafted block via the existing isProtectedBlockName(), or
// a common hand-placed construction material) rather than an exact detector. Bounded batch
// (SAPLING_PLANT_BATCH_LIMIT=4) so a bot carrying a big stack of saplings doesn't turn one
// action call into an unbounded planting spree.
//
// 1.32.0 (2026-09-08) -- direct request: "before they dig or destroy a block, they should make
// sure it is not a functional block like a bed or a furnace, a book[shelf], a table, or any
// other form of crafted item or block." New PROTECTED_BLOCK_NAMES/isProtectedBlockName()
// (exported for index.js's pathfinder Movements setup to reuse): "mine" now refuses to
// deliberately target one (resolveBlockFamily()'s own raw single-name fallback would otherwise
// happily resolve "furnace" or "crafting_table" like any other real block name). The other,
// bigger half of this -- a bot's pathfinder auto-digging through one incidentally while routing
// around an obstacle -- is closed in index.js instead, since that's mineflayer-pathfinder's own
// Movements config, not an actions.js concern.
//
// 1.31.0 (2026-09-08) -- item #4 of "fix all the above" (bed ownership). "sleep" re-ran the same
// "nearest 3 beds" search every night with no memory of what worked before -- on a shared map
// with fewer beds than bots, several bots would converge on the same nearest bed the same night
// (bot.sleep()'s own real "occupied" rejection already caught that safely, just wasting a
// travel-then-fail cycle for whoever lost). New loadClaimedBed()/saveClaimedBed() (a small
// per-bot file under BEDS_DIR, same hermes-data-mount pattern skills.js's SKILLS_DIR already
// uses) persist whichever bed actually worked last time and try it FIRST, ahead of the normal
// broad search -- a bot with a working bed stops competing for "nearest" every night and just
// goes home, falling back to the broad candidate list only if her own bed is gone, occupied, or
// unreachable.
//
// 1.30.0 (2026-09-08) -- item #3 of "fix all the above" (farming from scratch). "harvest" could
// only ever work a field that already existed (pick what's ripe, replant it) -- with nothing
// planted anywhere nearby it just failed outright, no path to ever bootstrap a farm at all. New
// fallback when no mature crop is found: till nearby dirt/grass_block (air above, real vanilla
// tilling has no dedicated mineflayer API -- bot.activateBlock() with a hoe equipped is the same
// "simulate a real client interaction" primitive already the right tool for this) and plant
// whatever seed she's carrying, bounded to HARVEST_BATCH_LIMIT tiles same as the existing harvest
// loop. index.js's own HARVEST description (classifyIntent and the goal-step planner, both) is
// updated to mention this so the planner knows "harvest" now covers starting a farm too, not just
// working an existing one -- one verb, not a second one to teach the planner from scratch.
//
// 1.29.0 (2026-09-08) -- item #2 of "fix all the above" (cross-bot resource contention). New
// filterAwayFromOtherBots(), applied in "mine" and "explore": other known bots are ordinary
// named players from this bot's own point of view, so their live position needs no Buzz message
// to check -- filters out candidate block positions within BOT_PROXIMITY_AVOID_DISTANCE (6) of
// another bot before mining, falling back to the unfiltered list only if every candidate is
// contested (mining something beats mining nothing). Complements, doesn't replace,
// arbitrateGoalConflict()'s own goal-text-time check -- that one catches two bots both WANTING
// the same thing before either commits to a goal; this one catches two non-conflicting goals
// that still happen to converge on the same physical vein, which no amount of text-level
// judgment could ever see coming.
//
// 1.28.0 (2026-09-08) -- live bug found while verifying an unrelated change (Mayor's first
// autonomous directive): Mark was spamming "threat detected (spider)" -> "no hostile mobs
// nearby" every ~2s for 90+ seconds straight, doing nothing else the entire time. Root cause:
// index.js's checkSelfDefense()/emergency-health/checkSleepingThreat handlers each already find
// a real, specific entity via nearestHostile(bot, SELF_DEFENSE_RANGE), but "attack"/"flee" below
// threw that away and re-ran nearestHostile(bot) (default range 16) a second time -- racing the
// same entity moving out of range or despawning in the gap (checkSelfDefense's own force-cancel-
// then-wait sequence can take up to 3s). "attack"/"flee" now accept an optional action.target and
// use it directly when a caller already has the real entity in hand; goal-directed callers with
// no known entity still fall back to a fresh nearestHostile(bot) search exactly as before.
//
// 1.27.0 (2026-09-08) -- direct request: "the duplicate crafting check should be for all
// resources as well as utilities like crafting tables. if a resource is in a nearby chest, they
// should not mine it." Generalizes the crafting_table/furnace nearby-block check (1.25.0) with
// a new shared tryTakeFromNearbyChest() helper, reusing "loot"'s own real chest-interaction
// mechanics: "craft" now checks a nearby chest for ANY item before crafting it (not just the two
// utility blocks), and "mine"/"explore" now check for the REAL resulting item of what they're
// about to gather (new MINE_DROPS/itemNamesForMinedBlocks -- a chest holds raw_iron, not
// iron_ore, real vanilla drop behavior, not the block's own name) before ever searching for the
// block itself. All-or-nothing: only skips mining/crafting if a chest has the FULL amount
// needed, never a partial one.
//
// 1.26.0 (2026-09-08) -- direct report: "they still don't seem to react to a threatening
// creature." Found the real, foundational cause while live-testing index.js's own self-defense
// interrupt fix (2.35.0): nearestHostile() required entity.type === "mob", but a real, freshly
// summoned zombie's actual type on this server is "hostile" -- confirmed by direct inspection,
// not assumed. This function has never matched a single real hostile mob since the day it was
// written; every caller (checkSelfDefense, checkSleepingThreat, "attack"/"flee" targeting) was
// working from a function that always silently returned undefined. Not a timing bug, a data
// bug -- see the function's own updated comment for the real confirmed entity-type taxonomy on
// this version.
//
// 1.25.0 (2026-09-08) -- direct report: "they keep creating crafting tables, even when there is
// a number of them nearby." Real gap: "craft"'s own "does this need a table" check only ever
// asks whether crafting THIS item needs a DIFFERENT existing table/furnace as a station --
// crafting_table's own recipe needs no table at all (4 planks, fits the personal grid), so that
// check always said "no" for it and fell straight through to making a brand new one, never
// checking whether an instance of what she's ABOUT TO MAKE already exists in reach. New
// REUSABLE_UTILITY_BLOCKS check (crafting_table, furnace -- same real gap applies to furnace,
// also craftable without a table) short-circuits to success if one's already within the same
// 32-block radius every other nearby-search in this file already uses.
//
// 1.24.0 (2026-09-08) -- direct request: "if they can't craft, they should explore, and find
// resources for later." New "explore" action: scans broadly for ANY common raw material (every
// log species, every ore family) instead of one named target, for when a craft/mine step fails
// with nothing specific left to try. Reuses wanderAndRetryFind()'s own directed extended-search
// wandering and "mine"'s own tool-tier gate rather than duplicating either. Gathers a full batch
// (up to 8) of whatever's found first, not just enough for the immediate need -- added to
// SKILL_ACTION_VERBS too, so a stored skill can include an exploration step.
//
// 1.23.0 (2026-09-08) -- direct request "start on #6" (MINECRAFT_BOTS_DESIGN.md §14, the
// Voyager-style dynamic skill library plan). New export SKILL_ACTION_VERBS: the real allowlist
// services/minecraft-bots/skills.js checks a model-authored skill's steps against before ever
// storing one, so a skill can only ever reference verbs performAction() actually implements.
//
// 1.22.0 (2026-09-08) -- direct report: "the bots just stand around most of the time." Real,
// confirmed root cause, not guessed: a live on-server check found ZERO logs within 100 blocks
// of spawn (the nearest real tree cluster was ~83 blocks away in one specific direction), so
// every wood-gathering goal step failed instantly, cascading into everything downstream (no
// planks -> no sticks -> no tools -> can't progress) -- which is what "standing around" actually
// looked like in the logs: goal after goal giving up within 1-2 ticks. wanderAndRetryFind()
// rewritten from a single blind hop (its original 2026-09-07 form) to use this server's own
// view-distance (confirmed live: 160 blocks) -- mineflayer already has chunk data that far out
// whether or not she can path there directly, so an extended stationary bot.findBlocks() call
// (free, no movement) can find a REAL known bearing to wander toward in bounded hops, instead of
// guessing a random direction (live-tested and confirmed unreliable: missed the real tree
// cluster entirely, twice, before this fix). ACTION_TIMEOUT_MS raised 60s -> 90s to fit the
// extra wander time alongside the real work that still needs to happen afterward. Verified live:
// a bot with nothing within 100 blocks found and collected oak_log from ~83 blocks away in 27s.
//
// 1.21.0 (2026-09-07) -- direct request "do 1,2,4,5" on a web-research gap analysis against
// other mineflayer/LLM Minecraft bot projects (Mindcraft-CE, Voyager, general-purpose farm/
// building bots):
// (1) Boat crossing: new ensureBoat()/tryLaunchBoat()/attemptBoatCrossing(), wired as a fallback
//     inside "gohome" when the normal walking route fails. Real crash bug found and fixed along
//     the way: bot.placeEntity()'s own boat-specific packet write is missing fields this exact
//     server's protocol actually requires. mount()/moveVehicle()/dismount() (entities.js) supply
//     steering once mounted, bot.lookAt() the yaw/pitch to aim, both confirmed real APIs. NOT yet
//     working end-to-end, though: extensive live testing traced the remaining failure (no boat
//     ever spawns, no crash) to a currently open, unresolved upstream mineflayer bug affecting
//     use_item/rotation handling on 1.21.x (PrismarineJS/mineflayer#3742) -- see
//     tryLaunchBoat()'s own header comment for the full investigation. Left in place rather than
//     reverted since the crash fix, crafting logic, and launch-site/steering code are all real
//     and correct, and the whole thing degrades safely to a no-op fallback in the meantime.
// (2) Building: new "build" action -- a small, fixed 3x3-footprint shelter (walls, one doorway,
//     a roof) using whichever solid block she has the most of. This is the "own pass" this
//     file's own 1.0.0-era header comment always said building deserved rather than being half-
//     built alongside navigate/gather/fight -- not a general blueprint/planning system, which
//     stays out of scope for the same reason it always has (even Voyager needs human feedback
//     for its own house-building). Placement order is ground-up per wall column and outward
//     from an already-placed edge for the roof, so no cell ever needs a reference that doesn't
//     exist yet, and the doorway column is never in the placement list at all -- no self-
//     entombment risk regardless of what order individual placements actually succeed in.
// (4) Tool-tier gate: "mine" now checks block.harvestTools (minecraft-data, confirmed live
//     against this exact server's registry) against her whole inventory before ever starting a
//     collect -- real data, not a hand-typed tier table that could drift from this server's
//     actual version (this future version's own copper_pickaxe tier, confirmed live, would have
//     been missed by anything hand-typed from memory). Following external research on how
//     Voyager avoids wasted attempts by sequencing tool tiers explicitly -- this is the
//     deterministic guard half of that idea; the goal loop's own already-evidenced ability to
//     reason "I need a pickaxe, I need planks, I need logs" from an informative failure message
//     is the re-planning half, not a second thing to build.
// (5) Farm automation: "harvest" now processes up to HARVEST_BATCH_LIMIT (8) mature crops per
//     invocation instead of one -- a real "work the field" pass, matching how dedicated farm
//     bots elsewhere in the mineflayer ecosystem work a whole field per pass rather than one
//     plant per goal step.
//
// 1.20.0 (2026-09-07) -- direct request: "bots should pay attention to the time of day, and try
// to return 'home' before full dark." New "gohome" action, a plain goto to bot.spawnPoint -- the
// same real "home" reference the teleport-when-stuck mechanism already uses. index.js's own new
// checkDusk() decides WHEN to call it (bot.time.timeOfDay), this just handles the walk.
//
// 1.19.1 (2026-09-07) -- direct request: "when a bot is looting a chest, it should only take
// one instance of any tool, but can take resources up to one full stack at a time." "loot" used
// to filter to the narrow isEssentialItem set (gear/fuel/food) and withdraw every matching stack
// uncapped -- a chest with three duplicate diamond pickaxes (three separate slots, since tools
// don't stack) got all three. Now takes everything found (a curated sandbox server, not a real-
// survival dungeon with true junk loot), capped at ONE instance per distinct tool/weapon/armor
// piece (GEAR_SUFFIXES) but a full stack (one inventory slot's worth) of anything else.
//
// 1.19.0 (2026-09-07) -- direct request: "check the Firmament coder logs for flagged Minecraft
// behavior that are not yet resolved" -> "yes" (to digging into the #1 finding). The triage
// log (637 entries, all day) was dominated by recurring heap-OOM crashes every 5-15 minutes,
// coder/coder2 both only ever guessing "likely a memory leak, increase --max-old-space-size"
// without ever pinpointing a cause. Traced two live instances back to their actual logs: not a
// slow leak, a violent spike (one went 197MB -> a fatal 750MB+ heap in ~8 seconds), both
// immediately following a MINE step on an ore block, both preceded by a burst of rapid
// "path_reset: block_updated" events. One instance ran on code from before tonight's own
// changes, one from after -- ruling out anything shipped earlier tonight as the cause.
//
// Root cause, confirmed by reading source, not guessed: mineflayer-collectblock's mineBlock()
// calls the CORE bot.dig() directly, entirely outside pathfinder's control -- but
// bot.collectBlock.cancelTask() (CollectBlock.js) only ever calls bot.pathfinder.stop(). It does
// nothing to an in-flight dig. mineflayer's own dig.js registers a per-block
// `blockUpdate:${position}` listener that's only ever removed by that exact dig completing
// naturally or by bot.stopDigging() -- neither happens when cancelTask() is the only thing
// called. stopCurrent() runs before EVERY new action (including the frequent self-defense/
// emergency interrupts) and already called cancelTask() for exactly this reason, but never
// stopDigging() -- so any action that interrupted an active dig (extremely common during ore
// mining in cave terrain, where nearby block changes trigger frequent interruptions) orphaned
// that listener and its pending promise permanently. This is the same root lesson already
// learned once this session for a different call site (withTimeout's own header comment: "a
// stuck mining action... ran unbounded for ~11 minutes... Promise.race abandons the loser, it
// does not cancel it") -- cancelTask() turned out to be exactly that kind of incomplete
// cancellation for the digging half specifically, not just the pathing half already covered.
//
// Fixed three places: stopCurrent() (the one function every single action already routes
// through) now also calls bot.stopDigging() alongside cancelTask() -- confirmed safe to call
// unconditionally, since dig.js's own stopDigging is a self-guarding no-op when
// bot.targetDigBlock is unset. "mine"'s own ACTION_TIMEOUT_MS handler gets the same addition
// (a distinct trigger from stopCurrent -- a timeout INSIDE the same still-running action, not a
// new one starting). "harvest"'s bare `await bot.dig(cropBlock)` had no timeout protection at
// all -- wrapped in the same withTimeout/stopDigging pattern "mine" already used, closing the
// identical unbounded-hang risk there too.
//
// Not claimed as definitively the ONLY contributor to every OOM instance in the log without a
// live heap snapshot to confirm against -- but a real, confirmed, previously-undiscovered gap in
// how this codebase's own cancellation model handles digging specifically, on the exact action
// (mining) most implicated by the live evidence. Worth watching crash frequency after this
// deploy to see how much of the pattern it actually accounts for.
//
// 1.18.1 (2026-09-07) -- real gap found live minutes after standing up Mark/Luke (see index.js
// 2.21.0's own changelog): the goal planner reasoned its way to "mine raw_iron" -- raw_iron is
// the ITEM a player gets, never a real block id, so "mine" failed outright on exactly the first
// real step of the "arm up" priority these two bots exist for. GENERIC_BLOCK_ALIASES now also
// covers every raw_* ore item plus a few other common drop-vs-block mixups (coal, diamond,
// emerald, lapis_lazuli, redstone), aliasing each to the block that actually drops it.
//
// 1.18.0 (2026-09-07) -- direct request: "the build attempts are too narrow. they should
// understand classes of things. wood can be any form of wood, not just oak or spruce."
// Real gap: "mine" looked up exactly one block id, so "mine oak_log" failed outright wherever
// the only trees nearby were spruce or birch, even though any log serves the identical purpose.
// New resolveBlockFamily() expands a single requested block to every id that serves the same
// real purpose: any log/stem regardless of species, any planks, any wool/carpet/concrete/
// terracotta/stained-glass color, and ore that generates as either a stone-layer or
// deepslate-layer block (SMELT_RECIPES already treated ore pairs this way -- "mine" was the one
// place still checking a single exact id). GENERIC_BLOCK_ALIASES additionally lets a bare class
// word ("log", "wool", "ore") stand in for a real example, in case the model names the category
// directly. craft/smelt already handled this correctly (bot.recipesFor() resolves real vanilla
// tag-based recipes like #minecraft:planks on its own; SMELT_RECIPES already listed ore-pair
// alternatives) -- this closes the one remaining narrow spot, not a systemic rewrite.
//
// 1.17.0 (2026-09-07) -- direct request "next set of autonomy" -> "do all four" (goal-planner
// vocabulary gap was purely an index.js change, see its own 2.19.0 changelog):
// (1) shield use in combat: "attack" now equips a shield to off-hand (if she's carrying one)
//     before bot.pvp.attack(). Real gap found by reading mineflayer-pvp's own source (PVP.js):
//     it ALREADY fully automates shield blocking (a creeper's explosion) and an active-block-
//     then-attack cadence on every swing, entirely conditional on hasShield() -- a shield already
//     sitting in the off-hand slot. Nothing in this codebase ever put one there; equipping one is
//     the entire fix, everything downstream was already built.
// (2) XP-aware enchanting: "enchant" now picks the first AFFORDABLE option (checked against
//     bot.experience.level) instead of always the cheapest/first slot. Real gap found by reading
//     enchantment_table.js's own source: .level IS the real XP-level cost the server charges, and
//     enchant() has no affordability check of its own -- it just sends the packet and awaits an
//     inventory update that may never arrive if the server silently rejects an unaffordable
//     choice, which would have hung the action rather than failing it cleanly.
//
// 1.16.0 (2026-09-07) -- direct request "do 1-3" then "and 4" on the next round of autonomy
// ideas, itself prompted by tonight's live drowning-loop incident (see index.js's own 2.17.1/
// 2.17.2 changelog for the reactive half of that fix):
// (1) bed safety: new bedNearHazard() scans a box around a candidate bed for water/lava before
//     she ever commits to sleeping in it -- addresses the actual root cause (a bed bonded next to
//     open water) rather than just recovering better after the fact. Reuses "sleep"'s existing
//     multi-candidate loop (same pattern as loot) so one bad bed just falls through to the next.
// (2) general hazard-aware pathing: liquidCost bumped in index.js's Movements setup (see its own
//     changelog) -- actions.js needed no changes for this half.
// (3) torch placement: no actions.js changes needed -- index.js's new checkLighting() reuses the
//     existing "place" action (already generic over any held block) rather than a new case.
// (4) fishing: new "fish" action, built on mineflayer's own core fish() (confirmed against
//     fishing.js source -- casts via activateItem(), resolves on a real bobber-splash particle
//     event, reels in itself). fish() has no built-in timeout, so it's wrapped in withTimeout
//     like every other open-ended wait here; onTimeout calls activateItem() a second time to
//     reel in and cancel cleanly rather than leaving a cast hanging.
//
// 1.15.0 (2026-09-07) -- direct request "do the first 3" (of four further autonomy ideas):
// (1) farming: new "harvest" action -- picks a ripe crop and replants, simpler than farming from
//     scratch since it needs no bare-dirt placement logic. Ages/replant items confirmed against
//     minecraft-data's own block-state definitions. Deliberately searches broadly by block TYPE
//     first (the proven-reliable pattern) and checks maturity via direct bot.blockAt() calls
//     afterward, rather than trusting findBlocks' own function-matcher path to populate real
//     block-state properties during the search itself -- never confirmed, not worth the risk.
// (2) animal breeding: new "breed" action, built on mineflayer's own activateEntity() (core --
//     the real feed-to-breed mechanic, no dedicated breeding API needed).
// (3) enchanting: new "enchant" action, built on mineflayer's own openEnchantmentTable() (core).
//     Picks the cheapest/first of the 3 offered options rather than real XP-affordability logic.
// Stuck-detection (the third of the original four ideas) needed no actions.js changes -- it's
// pure index.js logic (bot.setControlState(), no performAction case required).
//
// 1.14.0 (2026-09-07) -- direct request "do all" on a further four autonomy ideas:
// (1) base/chest storage: new "store" action (bot.craft-adjacent inverse of "loot" -- deposit
//     instead of withdraw). New exported isEssentialItem(), factored out of loot's own filter so
//     index.js's new checkInventoryFull() can decide what's safe to store using the identical
//     definition of "essential" loot already uses, not a second copy.
// (2) villager trading: new "trade" action, built on mineflayer's own openVillager()/trade()
//     (core) -- a whole real mechanic (trade UI, emeralds) untouched until now. <item> is the
//     OUTPUT she wants; finds a matching, affordable, not-disabled trade herself rather than
//     needing a trade index. Deliberately direct-command only, not in the goal planner's own
//     vocabulary -- villager availability is too unpredictable to risk another hallucination
//     surface there.
// (3) death/respawn handling: new "recover" action -- paths back to a stored death position
//     (index.js's job to capture and pass in) so auto-pickup has a chance to recover dropped
//     items before vanilla's 5-minute despawn timer. Internal-use only, not a real ACTION verb.
// (4) true mid-action self-defense interrupt: no actions.js changes needed -- the existing
//     stopCurrent()/cancelToken design (built for "a new command interrupts an old one") turned
//     out to already support being invoked from index.js's own real-time 'health' listener
//     without requiring changes here.
// Also extracted chestObstructed() from "loot" (used by "store" too, one definition instead of
// a second copy of the exact same double-chest-obstruction check).
//
// 1.13.0 (2026-09-07) -- direct follow-up to "look for more ways to improve their autonomy":
// (1) hunger: new "eat" action (bot.consume(), core, requires the food held first) and new
//     exported FOOD_NAMES -- minecraft-data's own item registry carries no food/nutrition field
//     at all (checked live: bread/apple both have no foodPoints), so this is a small curated
//     list, same pragmatic approach as FUEL_PREFERENCE/SMELT_RECIPES. Loot now also recognizes
//     food as worth taking.
// (2) bot-to-bot help: new "give" action (bot.toss(), core -- drops at her own feet, so she
//     paths next to the recipient first, same pattern as every other action here). General
//     enough for a human to ask directly ("give me some bread") or for the autonomous cross-bot
//     request flow (index.js) to use by naming the other bot's real username.
//
// 1.12.0 (2026-09-07) -- fourth of five scoped enhancements: self-defense. New "flee" action
// (GoalInvert wrapping a GoalFollow, confirmed against mineflayer-pathfinder's own goals.js --
// negates the heuristic so pathfinder maximizes distance from the threat instead of closing it,
// self-terminating once genuinely outside the wrapped radius rather than a guessed duration).
// New exported nearestHostile() so HOSTILE_MOBS has one definition, shared with index.js's new
// checkSelfDefense() rather than copied. Deliberately the idle-tick version scoped up front, not
// true mid-action interrupt -- that would need a real exception to the `acting` flag that
// currently exists specifically to prevent interruptions, a bigger design decision than this
// pass's scope.
//
// 1.11.0 (2026-09-07) -- direct follow-up to "what other logic enhancements are available,"
// first two of five scoped and built in order:
// (1) explore/wander: the single biggest recurring blocker across a whole night's live testing
//     was "couldn't find X nearby" purely because nothing existed within the normal maxDistance
//     of wherever the bot happened to be standing. New wanderAndRetryFind() -- ONE bounded
//     wander-then-retry per failed search (mine/loot/smelt), not open-ended exploration, since
//     long-distance pathfinding is exactly what's been linked to tonight's OOM crashes.
// (2) place: bots could craft a furnace/crafting table but had no way to actually use one they
//     made themselves, only ones already in the world -- a real dead end hit live tonight. New
//     "place" action, built on mineflayer's own placeBlock() (core). Deliberately narrow: one
//     utility block next to herself, not a general building capability, which stays explicitly
//     out of scope (see this file's own header, unchanged).
//
// 1.10.3 (2026-09-07) -- diagnostic: the same 3 furnaces failed "destination full" across
// several separate goal attempts tonight -- logging each slot's actual contents on open so a
// repeat is diagnosable (someone else's items already there? a stuck previous attempt of our
// own?) instead of just "full" with no further evidence.
//
// 1.10.2 (2026-09-07) -- real gap found live: once furnace smelting existed, "no fuel" became
// the single most common reason a goal gave up, and loot -- the natural fallback -- had no idea
// coal/charcoal were worth taking, only armor/tools (GEAR_SUFFIXES). Unlike a looted furnace or
// crafting table (useless without a placement capability this system doesn't have), fuel is
// directly usable the moment it's in inventory. New FUEL_NAMES, checked alongside GEAR_SUFFIXES.
//
// 1.10.1 (2026-09-07) -- real gap found live minutes after smelting shipped: the prompt says
// ACTION SMELT's <item_id> is the OUTPUT (e.g. "copper_ingot"), but the planner named the INPUT
// raw material instead ("raw_copper") and got "don't know how to smelt" for a perfectly sensible
// request. Now accepts either -- if the named item isn't a known output, checks whether it's a
// known input for one and uses that recipe instead. Cheap and always-safe to normalize in code
// rather than keep tightening prompt wording for something this easy to just accept.
//
// 1.10.0 (2026-09-07) -- direct request: "they can't seem to find the furnaces." A huge fraction
// of tonight's goal-loop failures were bots correctly reasoning they needed an ingot (iron/
// copper/gold) and having no way to get one beyond hoping a chest happened to have it -- craft
// (crafting-table only) and mine (raw ore, not the smelted product) alone were never enough.
// New "smelt" action, built on mineflayer's own openFurnace() (core, no extra plugin) -- finds a
// furnace (up to 3 candidates, same pattern as loot/sleep), puts in fuel + raw material, and
// waits for real output via furnace.js's own 'update' event rather than guessing a duration.
// minecraft-data has no dedicated smelting-recipe data (checked: no equivalent of recipes.json
// for furnace input->output), so SMELT_RECIPES is a small, deliberately hand-picked map covering
// what actually matters for gearing up, not an attempt at full smelting-recipe coverage.
//
// 1.9.1 (2026-09-07) -- real gap found live on the very first real sleep attempt: every
// per-candidate bed failure was silently swallowed (`continue` with no logging), so when all 3
// candidates failed the only visible result was "couldn't use any of them" -- no way to tell
// whether it was an occupied bed, monsters nearby, unreachable, or something else. Logging each
// candidate's actual rejection reason now (bot.sleep()'s own specific error messages) -- the
// same lesson already learned once today for the goal loop's own transitions.
//
// 1.9.0 (2026-09-07) -- direct request: "the bots need to know to go to sleep at night." New
// "sleep" action, built entirely on mineflayer's own bed.js plugin (core, always loaded) --
// bot.sleep()/bot.wake()/bot.isSleeping/bot.isABed() already implement the real vanilla rules
// (the exact night-or-thunderstorm timeOfDay window, occupied-bed/monsters-nearby/reach checks,
// each with its own thrown reason), so this only needed to find a bed and try it, same multi-
// candidate pattern loot already uses. stopCurrent() now also forces a wake if a new action
// comes in mid-sleep (a direct command, or the goal loop wanting to act) -- sleep should never
// block anything else from happening once something else needs her attention. index.js's
// checkSleep() decides WHEN to call this (a deterministic time-of-day check, not a model call --
// unlike the goal loop, "is it night" needs no reasoning).
//
// 1.8.2 (2026-09-07) -- real gap found live repeatedly during autonomy goal loop testing: the
// loot action fetched only the single NEAREST chest (findBlocks count:1). Once that one chest
// turned out to be permanently obstructed or unopenable, every subsequent loot attempt
// deterministically re-found the exact same bad chest and failed the same way -- both bots
// racked up 6+ identical "couldn't open"/"obstructed" failures across many separate goals,
// never trying anywhere else even though other chests existed within range. Now tries up to 3
// candidates in distance order, skipping to the next on any per-chest failure instead of giving
// up after the first.
//
// 1.8.1 (2026-09-07) -- real crash found live within minutes of the autonomy goal loop
// shipping: both bots' very first self-proposed crafting step (copper_ingot, furnace) crashed
// with "recipe.ingredients is not iterable" -- craftItem()'s shortfall-resolution loop assumed
// every candidate from recipesAll() has a real ingredients array, which isn't true for an item
// that's smelting-only (this action has no furnace support at all, only bot.craft()'s crafting-
// table/grid). Now skips any candidate without one, so an unsupported item fails cleanly instead
// of crashing the step. Found from goal.json's own persisted log, not a guess -- see index.js
// 2.11.1's new goal-loop console logging, added for exactly this kind of diagnosis.
//
// 1.8.0 (2026-09-07) -- autonomy (standing goals, direct request "give her more autonomy to
// work towards longer goals"): performAction() now returns { ok, text } instead of a bare
// string. The goal loop (index.js/goals.js) needs to know whether a step actually made progress
// to decide when to keep trying vs. give up -- English-parsing the old free-text result
// ("couldn't...", "had trouble...") for that would be fragile and silently break the moment a
// message wording changes. `ok` is the real, structural signal; `text` is unchanged and still
// exactly what gets narrated/chatted, so every existing call site only needed `result` ->
// `result.text`.
//
// 1.7.0 (2026-09-06) -- direct request: "pre-teach the most common recipes." minecraft-data
// already knows every vanilla recipe correctly (Recipe.ingredients/requiresTable, confirmed
// against prismarine-recipe's own types) -- there's no external recipe data to teach it. New
// "craft" action (craftItem()) uses bot.recipesFor()/bot.recipesAll() (confirmed against
// mineflayer's own craft.js source: recipesFor already filters to what's affordable *right
// now*) and auto-resolves the two most common shallow shortfalls (no planks but has logs, no
// sticks but has planks) before giving up -- covers the overwhelming majority of real
// "craft X" requests starting from raw gathered resources, without attempting a general
// recursive planner.
//
// 1.6.2 (2026-09-06) -- actual root cause of the "(empty)" chest, after 1.6.1's timing-delay
// guess was ruled out by direct testing: Window.items() returns the PLAYER'S OWN inventory
// slots within the combined chest+inventory window, not the container's -- confirmed against
// prismarine-windows' own source. containerItems() is the real container-only view. A chest
// confirmed (by a human, in-game) to hold two netherite pickaxes was correctly reporting empty
// every time because Babs' own inventory was empty, not the chest.
//
// 1.6.1 (2026-09-06) -- real bug found live: the contents-logging added in 1.6.0 immediately
// showed the real problem -- a chest confirmed (by a human, in-game) to hold two netherite
// pickaxes logged as "(empty)" twice in a row. Guessed this was a packet-timing race and added
// a 200ms delay before reading -- ruled out by direct testing (still empty); see 1.6.2 for the
// actual cause.
//
// 1.6.0 (2026-09-06) -- root cause of the 20s open-chest hang confirmed and fixed: minecraft-
// data had no real protocol data for 26.1.2 (silently aliased to 26.1's), a version-support
// gap in the mineflayer ecosystem, not a bug here -- fixed by moving the whole server to
// 1.21.11, a mature version with genuine native support (confirmed via minecraft-data
// resolving it exactly, no aliasing). Removed the now-unneeded position/lookAt diagnostics
// (1.4.1) and replaced with a simple log of full chest contents -- a live test on the new
// version opened a chest successfully but reported "nothing worth taking" despite it holding
// real tools, a GEAR_SUFFIXES matching bug, not a protocol issue; this log is to find it.
//
// 1.5.0 (2026-09-06) -- real evidence from the 1.4.1 diagnostic: the chest that kept hanging
// is one half of a double chest (getProperties() -> {type: "right", facing: "east"}). The
// obstruction check only ever looked above the single block findBlocks returned -- never the
// paired half, whose own obstruction blocks the whole double chest from opening in vanilla.
// Now scans cardinal neighbors for the matching paired half and checks both. Diagnostic
// logging (1.4.1) left in for now until this is confirmed live.
//
// 1.4.1 (2026-09-06) -- TEMPORARY: added console diagnostics right before the loot action's
// open attempt (bot/chest position, distance, live block state, look angles) -- the
// obstruction check (1.3.0) and lookAt (1.4.0) fixes both failed to resolve the same 20s hang,
// and the server's own log shows nothing, so this stops guessing a third blind fix in favor of
// real data. Remove once root-caused.
//
// 1.4.0 (2026-09-06) -- second real error found live on "loot," after ruling out the 1.3.0
// obstruction check (confirmed no block above the chest, still hung the full 20s):
// pathfinder's goto() only gets the bot's position near a target, it never turns the bot to
// face it. openChest() defaults its interaction direction to (0,1,0), which doesn't reflect
// an actual look-at-the-chest vector if the bot arrived from the side -- the server's own
// reach/look-direction validation on the interaction then silently never answers. Explicitly
// calling bot.lookAt() at the chest before opening it is the fix.
//
// 1.3.0 (2026-09-06) -- real error found live: "loot" waited openChest()'s own internal 20s
// timeout ("Event windowOpen did not fire") against a chest that vanilla Minecraft will never
// open -- any solid block directly above a chest blocks its lid, a real, common world-state
// issue, not a bug. Checking the block above before attempting to open turns that cryptic 20s
// hang into an immediate, specific answer.
//
// 1.2.0 (2026-09-06) -- direct request: bots should look in chests for equipment, wear the
// best armor they find, and hold the best weapon unless a task needs a specific tool. New
// "loot" action opens the nearest chest and takes any armor/weapon/tool it finds (equipment.js
// decides what's actually worth wearing once it's in inventory). mineflayer-tool's plugin is
// now loaded (equipment.js's loadEquipmentPlugins) -- real gap found while investigating a
// mining timeout: mineflayer-collectblock already calls bot.tool.equipForBlock() internally
// for task-specific tool selection, but that silently had nothing to call since the plugin
// was never loaded. Every action that can change inventory (mine, attack, loot) now re-runs
// equipBestArmor/equipBestWeapon afterward so gear stays current without a separate request.
// Crafting and building are still explicitly out of scope -- this covers "use what you already
// have or can loot," not "make what you don't have yet."
//
// 1.1.0 (2026-09-06) -- withTimeout() now takes a required onTimeout callback that actually
// cancels the underlying pathfinder/collectBlock/pvp operation -- see its own updated comment
// for the real incident this fixes (a stuck mine action ran unbounded for ~11 minutes and
// crashed the process via OOM, which is what actually disconnected the bot, not a network drop).
//
// Real in-world actions -- the piece the design doc's personas always claimed ("mining,
// building, fighting, gathering, navigating" -- see agents/minecraft-*/PROMPT.md's Core
// Directives) but nothing implemented until now. Building/placing structures is deliberately
// NOT in scope here: navigate, gather, and fight are the three tractable, high-value verbs
// that make a bot feel like a real player; a structure planner is a much bigger feature that
// deserves its own pass, not something to half-build alongside everything else this file does.
//
// Uses two more PrismarineJS plugins beyond pathfinder (already loaded): mineflayer-collectblock
// (pathing + digging + pickup for a real "go gather N of this block" loop) and mineflayer-pvp
// (pathing + attack-timing for real combat, rather than hand-rolling swing intervals).

import pathfinderPkg from "mineflayer-pathfinder";
import collectBlockPkg from "mineflayer-collectblock";
import pvpPkg from "mineflayer-pvp";
import { Vec3 } from "vec3";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { loadEquipmentPlugins, equipBestArmor, equipBestWeapon } from "./equipment.js";
import { cancelAndRotate, isBusy, holdsControl, releaseControl } from "./arbiter.js";
import { searchMemory } from "./longterm.js";
import { listState, setState } from "./memory.js";
import { holdDoorsOpen } from "./swim-movements.js";

const { goals } = pathfinderPkg;

// 2026-09-08 ("the bots just stand around most of the time"): raised 60s -> 90s. Real evidence:
// wanderAndRetryFind() now takes up to 3 wander hops (its own 2026-09-08 fix, see its header
// comment) to actually reach resources that turned out to be 150+ blocks from spawn -- a
// worst-case 45s of wandering alone left too little of the old 60s ceiling for the real work
// (walking to and digging/interacting with whatever was actually found) that needs to happen
// afterward, inside the very same withTimeout() call. Every action here already has its own
// real cancellation via withTimeout's required onTimeout callback, so a larger ceiling doesn't
// add a new risk class -- it just means a genuinely stuck action takes a bit longer to be
// force-cancelled.
const ACTION_TIMEOUT_MS = 90_000;
// A real Minecraft night (or the wait for it to naturally pass while sleeping) runs several
// real-world minutes even at normal speed -- ACTION_TIMEOUT_MS (60s) would abort a perfectly
// normal night's sleep as a "failure." This is a safety backstop for something going genuinely
// wrong (a stuck day/night cycle, a disabled gamerule), not the expected case.
const SLEEP_TIMEOUT_MS = 15 * 60_000;
// Vanilla's bite timer is randomized per cast (roughly 5-30s unenchanted, longer is possible) --
// generous headroom over the realistic range rather than a tight bound, same reasoning as
// SLEEP_TIMEOUT_MS above. A cast that genuinely never bites (bad water, e.g. too shallow/enclosed)
// should time out and get reported as a real failure, not hang the action loop indefinitely.
const FISH_TIMEOUT_MS = 90_000;
// Vanilla smelts one item per 10 real-world seconds with normal fuel/speed -- generous headroom
// per item rather than a tight bound, consistent with this being local compute with no per-call
// cost to economize on.
const SMELT_TIMEOUT_MS = 3 * 60_000;

// Exported (2026-09-10) so "light_area" (its own real bug fix -- see that case's own header) and
// index.js's checkLighting()/checkHomeLighting() share exactly one definition instead of two
// copies drifting apart. block.light (confirmed against prismarine-block source) is the real
// per-position light value, 0-15; under 8 is the common threshold below which hostile mobs can
// spawn, the same heuristic most mineflayer bots use since there's no simpler "is this dark"
// signal exposed directly.
export const DARK_LIGHT_LEVEL = 8;

export const HOSTILE_MOBS = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "spider", "cave_spider",
  "creeper", "enderman", "witch", "phantom", "slime", "magma_cube", "silverfish", "blaze",
  "ghast", "guardian", "elder_guardian", "shulker", "vex", "vindicator", "evoker", "pillager",
  "ravager", "hoglin", "zoglin", "piglin_brute", "warden",
]);

// Shared between the "attack"/"flee" actions here and index.js's checkSelfDefense()/
// checkSleepingThreat() (fourth of five scoped enhancements, direct follow-up to "what other
// logic enhancements are available") so HOSTILE_MOBS has exactly one definition instead of two
// copies drifting apart.
//
// Real, foundational bug found live 2026-09-08 (direct report: "they still don't seem to react
// to a threatening creature"): confirmed by directly inspecting a real, freshly summoned zombie
// entity on this exact server that its own entity.type is "hostile", not "mob" -- this check had
// been requiring "mob" the entire time, meaning this function has NEVER matched a single real
// hostile mob (zombie, skeleton, creeper, or anything else in HOSTILE_MOBS below), on any
// version of this codebase, since the day it was written. Not a timing/gating bug -- every
// caller (checkSelfDefense, checkSleepingThreat, "attack"/"flee" targeting) was working from a
// function that always returned undefined.
//
// Second real bug found live 2026-09-10 (direct report: "they don't seem to be able to fight,
// or run from, phantoms"): the "hostile" requirement added above is ITSELF wrong for a real
// subset of HOSTILE_MOBS -- confirmed directly against minecraft-data's own entity registry
// (mineflayer's entity.type is populated straight from this same field, lib/plugins/entities.js):
// phantom, ghast, slime, and shulker all carry type "mob", not "hostile", despite minecraft-data's
// own SEPARATE "category" field correctly listing all four as "Hostile mobs" -- an inconsistency
// within minecraft-data itself between its coarse `type` and its more specific `category`. Adding
// the "hostile" type check on top of the already-curated HOSTILE_MOBS name allowlist didn't add
// real safety (nothing outside this deliberate list was ever going to match by name), it just
// silently excluded every entry whose real `type` field happens not to be "hostile" -- self-
// defense/flee never even saw a nearby phantom as a threat, not a targeting or combat failure,
// a detection failure with no error to show for it. HOSTILE_MOBS.has(e.name) alone is the correct,
// sufficient condition: it's already the deliberate, curated "treat this as a threat" list this
// function exists to check against.
export function nearestHostile(bot, maxDistance = 16) {
  return bot.nearestEntity((e) => HOSTILE_MOBS.has(e.name) &&
    e.position.distanceTo(bot.entity.position) <= maxDistance);
}

// Direct request, 2026-09-18 ("have the threatened bot run towards safety, run towards golems, or
// soldiers"), direct follow-up to the SQUAD_ASSIST_RANGE finding (a fleeing bot beyond 48 blocks
// of both Soldiers gets no help at all). Same shape as nearestHostile -- an iron golem fights
// nearby hostiles on its own vanilla AI once a bot leads a threat near one, real backup a bot can
// reach on foot even when no teammate is close enough to come to her.
export function nearestFriendlyGolem(bot, maxDistance = 32) {
  return bot.nearestEntity((e) => e.name === "iron_golem" &&
    e.position.distanceTo(bot.entity.position) <= maxDistance);
}

// Real bug found live 2026-09-10 (direct report: "they don't seem to be able to fight, or run
// from, phantoms"), AFTER both the detection gap above (1.43.0) and the combat-resolution bug
// (1.42.0) were already fixed: a ground-bound bot's "attack" (bot.pvp.attack() -> a pathfinder
// GoalFollow within 2 blocks) can never actually close to melee range against a mob that flies
// well above pathfinding reach. Confirmed live via a direct, unambiguous read: Luke's own
// checkSelfDefense "attack" against a phantom held SELF_DEFENSE-tier arbiter control
// CONTINUOUSLY for the full 90s ACTION_TIMEOUT_MS ceiling -- during which every other
// self-defense re-trigger, squad response, and recovery attempt correctly reported "yielded to
// something more urgent (SELF_DEFENSE)" for the entire span, repeating every time the doomed
// chase re-triggered. That's exactly what "can't fight or run" looks like live, even though both
// prior fixes are individually correct and working. Fleeing, unlike attacking, never needs to
// reach the target -- already confirmed live to genuinely create real distance every cycle. Mobs
// in this set are always fled from, never melee-attacked, regardless of health -- ghast included
// on the same reasoning (also a flyer, also effectively unreachable on foot).
//
// Direct report, 2026-09-18 ("Luke is getting shot, not reacting. there is no mass mob"): enderman
// added on the same underlying reasoning, confirmed live -- Luke's own self-defense held
// SELF_DEFENSE-tier control on an "attack (threat=enderman)" for over a minute straight (silently
// re-returning on every 2s checkSelfDefense tick the whole time, since selfDefenseInFlight was
// still true) while a skeleton he had no ability to respond to sniped him from range, only broken
// by the separate EMERGENCY health-critical flee once he'd already dropped to ~6 HP -- then
// immediately re-engaged the SAME enderman and repeated. Endermen aren't flightless-unreachable
// like phantom/ghast, but teleporting away whenever hit makes bot.pvp's chase-and-melee approach
// close to it in practice: confirmed fleet-wide, Mark and Luke (the two bots actually willing to
// melee-attack rather than flee at their own tuned health thresholds) logged 2,800 and 1,770
// enderman self-defense triggers respectively in 24h -- far above every other bot -- consistent
// with the same doomed-retry shape, not an occasional unlucky fight.
export const FLEE_ONLY_MOBS = new Set(["phantom", "ghast", "enderman"]);

// Direct request, 2026-09-07 ("look for more ways to improve their autonomy" -> hunger). Checked
// live: minecraft-data's own item registry carries no food/nutrition field at all (bread/apple
// both come back with no foodPoints), unlike blocks/recipes -- there's no real data to defer to
// here, so this is a small, deliberately curated list of common foods, the same pragmatic
// approach already used for FUEL_PREFERENCE/SMELT_RECIPES rather than an attempt at exhaustive
// coverage. Exported so "loot" can also recognize food as worth taking, same reasoning as fuel.
export const FOOD_NAMES = [
  "bread", "apple", "golden_apple", "enchanted_golden_apple", "cooked_beef", "cooked_porkchop",
  "cooked_chicken", "cooked_mutton", "cooked_rabbit", "cooked_cod", "cooked_salmon",
  "baked_potato", "potato", "carrot", "golden_carrot", "melon_slice", "sweet_berries",
  "glow_berries", "cookie", "pumpkin_pie", "mushroom_stew", "rabbit_stew", "beetroot",
  "beetroot_soup", "dried_kelp",
  // Review MB-15, 2026-09-24: raw catches/drops safe to eat uncooked, listed LAST so "eat" prefers
  // anything cooked. Fishing is checkHunger's fallback, and raw cod/salmon used to be inedible
  // here with no cooking recipe either -- the food loop never closed. (Raw chicken omitted: poison.)
  "cod", "salmon", "beef", "porkchop", "mutton", "rabbit",
];

// Suffix-matched, same convention as equipment.js -- what's worth pulling out of a chest.
// Food/blocks/misc items are left behind; this is specifically about gearing up.
const GEAR_SUFFIXES = [
  "_helmet", "_chestplate", "_leggings", "_boots", "_sword", "_axe", "_pickaxe", "_shovel", "_hoe",
];

// Direct request, 2026-09-19 ("the downgrade rejection must also reject if the mayor's
// instructions would cause the quality of their equipment to be reduced") -- direct follow-up to
// "give"'s own §40 fix below, which only ever caught going from "has one" to "has none." Giving
// away a diamond sword while a wooden one stays behind is just as much a downgrade as giving away
// her only sword outright. A single common-sense material ranking, not a precise simulation of
// real armor-point/mining-level math (gold in particular is inconsistent in actual vanilla rules
// between tools and armor) -- good enough to answer "would she end up worse than before," which
// is all this check needs.
const GEAR_TIER_RANK = {
  wood: 0, wooden: 0, leather: 0,
  golden: 1, gold: 1,
  stone: 2, chainmail: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

// Returns -1 for an unrecognized material (e.g. a modded item) rather than guessing -- callers
// treat that as "no tier data, don't block on quality" and fall back to the has-one/has-none check.
function gearTierRank(itemName, suffix) {
  const material = itemName.slice(0, itemName.length - suffix.length);
  return material in GEAR_TIER_RANK ? GEAR_TIER_RANK[material] : -1;
}

// Direct request, 2026-09-18 ("if the bot is in need of a piece of equipment... and finds one
// already crafted in a chest, it should pick up ONE of those pieces... and abandon the quest to
// craft it"): the existing chest-substitution checks (craft/loot, below) only ever matched the
// EXACT item id the model happened to name (e.g. "stone_pickaxe") -- a chest holding a BETTER or
// just DIFFERENT-tier instance of the same equipment (an iron_pickaxe, say) was invisible to an
// exact match, so she'd craft or keep looking for the specific tier she'd guessed instead of
// recognizing ANY real pickaxe as already satisfying the need. Deliberately only broadens for
// gear (GEAR_SUFFIXES) -- raw materials have no equivalent "any tier will do" concept, an
// iron_ingot really is the one specific thing a recipe needs, so this is a no-op for anything
// that isn't armor/a weapon/a tool. Doesn't prefer the best tier if a chest happens to hold more
// than one -- tryTakeFromThisChest() takes whichever matches first, same as it always has; gear
// is near-universally requested one at a time, so "any real instance" is enough to satisfy this.
function gearCategoryNames(bot, itemName) {
  const suffix = GEAR_SUFFIXES.find((s) => itemName.endsWith(s));
  if (!suffix) return [itemName];
  return Object.keys(bot.registry.itemsByName).filter((name) => name.endsWith(suffix));
}

// Real gap found live (2026-09-07): once furnace smelting existed, "no fuel" became the single
// most common reason a goal gave up, and loot -- the natural fallback -- had no idea coal/
// charcoal were worth taking, only armor/tools. Unlike a looted furnace or crafting table
// (useless without a placement capability this system doesn't have), fuel gets consumed directly
// inside an existing furnace, so it's genuinely actionable the moment it's in inventory.
const FUEL_NAMES = ["coal", "charcoal"];

// Exported for index.js's checkInventoryFull() (2026-09-07, "do all" -> base/chest storage) --
// "essential" mirrors exactly what "loot" already considers worth taking (gear/fuel/food);
// everything else is fair game to store away when space is tight, one definition shared instead
// of two copies drifting apart.
export function isEssentialItem(itemName) {
  return GEAR_SUFFIXES.some((s) => itemName.endsWith(s)) || FUEL_NAMES.includes(itemName) ||
    FOOD_NAMES.includes(itemName);
}

// Exported for skills.js (MINECRAFT_BOTS_DESIGN.md §14, 2026-09-08): the real, authoritative set
// of verbs performAction() actually implements, checked against before a model-authored skill is
// ever stored -- "validate against real data, don't trust the model" (already the tool-tier
// gate's own reasoning). Deliberately excludes "gohome" and "recover": both are invoked directly
// by index.js's own timers/handlers with context a stored skill has no way to reconstruct
// (bot.spawnPoint, a captured death position) -- they never appear in a goal's own step log a
// skill would be compressed from, so leaving them out costs nothing real.
//
// Real gap found live 2026-09-11 (direct request "fix ... the dynamic skill library"): every verb
// added THIS session (repair_terrain, harvest_hive, shear, milk, build_pen, herd_to_pen) had been
// left out of this set entirely -- not a deliberate exclusion, just never wired through, meaning
// none of them could ever be captured into a reusable skill even though five of the six are
// perfectly self-contained the same way breed/harvest already are. harvest_hive/shear/milk/
// build_pen/herd_to_pen added now. repair_terrain deliberately still excluded, same reasoning as
// gohome/recover above: action.position is a specific pit location index.js's own
// checkTerrainDamage() discovers fresh each time via a live world scan -- a stored skill has no
// way to reconstruct which pit that was.
export const SKILL_ACTION_VERBS = new Set([
  "stop", "goto", "follow", "mine", "craft", "loot", "attack", "flee", "eat", "fish", "give",
  "sleep", "smelt", "place", "build", "store", "trade", "harvest", "breed", "enchant", "explore",
  "plant_sapling", "light_area", "harvest_hive", "shear", "milk", "build_pen", "herd_to_pen", "gohome",
]);

// minecraft-data has no dedicated smelting-recipe file (confirmed: no equivalent of recipes.json
// for furnace input->output) -- unlike bot.craft()'s crafting-table recipes, there's no real data
// to defer to here, so this is a small, deliberately hand-picked map of the smelting outcomes
// that actually matter for gearing up (direct request, 2026-09-07: "they can't seem to find the
// furnaces" -- most of a night's worth of goal failures were bots correctly identifying they
// needed an ingot and having no way to get one beyond hoping a chest had it). Keyed by the
// item the bot names (the OUTPUT, same convention as ACTION CRAFT), each mapping to the raw
// materials that smelt into it, checked against her inventory in order.
const SMELT_RECIPES = {
  iron_ingot: ["raw_iron", "iron_ore", "deepslate_iron_ore"],
  copper_ingot: ["raw_copper", "copper_ore", "deepslate_copper_ore"],
  gold_ingot: ["raw_gold", "gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
  glass: ["sand", "red_sand"],
  stone: ["cobblestone"],
  // Review MB-15: cooking, so raw food can be upgraded at a furnace.
  cooked_cod: ["cod"], cooked_salmon: ["salmon"], cooked_beef: ["beef"],
  cooked_porkchop: ["porkchop"], cooked_mutton: ["mutton"], cooked_chicken: ["chicken"],
  cooked_rabbit: ["rabbit"], baked_potato: ["potato"],
};

// Preferred fuels in order; coal/charcoal burn far longer per item than planks/logs (which are
// still valid fuel and a reasonable fallback since they're often what's actually on hand).
const FUEL_PREFERENCE = ["coal", "charcoal", "coal_block", "lava_bucket", "blaze_rod"];

function pickFuel(bot) {
  for (const name of FUEL_PREFERENCE) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (item) return item;
  }
  return bot.inventory.items().find((i) => i.name.endsWith("_planks") || i.name.endsWith("_log"));
}

// Direct request, 2026-09-07 ("the build attempts are too narrow -- they should understand
// classes of things. wood can be any form of wood, not just oak or spruce"). Real gap: "mine"
// used to look up exactly one block id, so a goal step of "mine oak_log" failed outright
// wherever the only trees nearby were spruce or birch -- even though any log serves the
// identical purpose. Minecraft has several of these "any member of the family is equally
// usable" groups (any log/stem regardless of species, any planks, any wool/carpet/concrete/
// terracotta/stained-glass color, and ore that generates as either a stone-layer or
// deepslate-layer block depending on depth -- SMELT_RECIPES above already treats those ore
// pairs as one thing for exactly this reason). resolveBlockFamily expands a single requested
// name to every id that serves the same real purpose, so a specific example is only ever a
// hint at WHICH family to gather, never a hard requirement to find that exact one.
// GENERIC_BLOCK_ALIASES additionally lets a bare class word ("log", "wool") stand in for a real
// example of that class, in case the model names the category directly rather than a species.
const ORE_FAMILIES = [
  ["iron_ore", "deepslate_iron_ore"],
  ["copper_ore", "deepslate_copper_ore"],
  ["gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
  ["diamond_ore", "deepslate_diamond_ore"],
  ["emerald_ore", "deepslate_emerald_ore"],
  ["lapis_ore", "deepslate_lapis_ore"],
  ["coal_ore", "deepslate_coal_ore"],
  ["redstone_ore", "deepslate_redstone_ore"],
];
// A plain "_stem" suffix was tried and rejected here (verified against the real 1.21.11 block
// registry, not assumed): it also sweeps up pumpkin_stem/melon_stem/attached_*_stem (crop
// blocks) and mushroom_stem/big_dripleaf_stem (unrelated plant blocks) -- none of them wood.
// The only real wood stems are these four Nether ones, listed explicitly instead.
const NETHER_STEM_NAMES = ["crimson_stem", "warped_stem", "stripped_crimson_stem", "stripped_warped_stem"];
// Each group's `match` suffix(es) are checked with plain String.endsWith, which is why
// "_terracotta" needs its own `exclude`: "orange_glazed_terracotta" also, trivially, ends with
// the substring "_terracotta" (also verified against the real registry, not assumed) even though
// it's a visually and functionally distinct crafted block, not interchangeable with plain
// terracotta. concrete/concrete_powder and stained_glass/stained_glass_pane don't have this
// problem -- their extra suffix text comes AFTER the shared root, not as a prefix word before it.
// Order matters: resolveBlockFamily picks the FIRST group the requested name matches, so the
// more specific suffix must be listed first -- a real bug caught in testing had a request for
// "orange_glazed_terracotta" itself match the broader "_terracotta" group before ever reaching
// its own, since .find() stops at the first hit regardless of specificity.
const BLOCK_FAMILY_GROUPS = [
  { match: ["_planks"] }, { match: ["_wool"] },
  { match: ["_concrete_powder"] }, { match: ["_concrete"] },
  { match: ["_glazed_terracotta"] }, { match: ["_terracotta"], exclude: ["_glazed_terracotta"] },
  { match: ["_stained_glass_pane"] }, { match: ["_stained_glass"] },
  { match: ["_carpet"] },
];
// Real gap found live, 2026-09-07, standing up Mark/Luke (military bots whose whole standing
// goal is "arm up"): the goal planner reasoned its way to "mine raw_iron" -- raw_iron is the
// ITEM a player gets, never a real block id, so this failed outright ("I don't recognize the
// block") on exactly the step this build exists to make reliable. Same shape as the smelt
// action's existing input/output normalization (accept either name); here every raw_* ore item
// and a few other common drop-vs-block mixups alias to the block that actually drops them.
const GENERIC_BLOCK_ALIASES = {
  log: "oak_log", logs: "oak_log", wood: "oak_log", planks: "oak_planks", plank: "oak_planks",
  wool: "white_wool", carpet: "white_carpet", concrete: "white_concrete", ore: "iron_ore",
  raw_iron: "iron_ore", raw_copper: "copper_ore", raw_gold: "gold_ore",
  coal: "coal_ore", diamond: "diamond_ore", emerald: "emerald_ore",
  lapis_lazuli: "lapis_ore", redstone: "redstone_ore",
};

function resolveBlockFamily(bot, requestedName) {
  const name = GENERIC_BLOCK_ALIASES[requestedName] || requestedName;

  const oreFamily = ORE_FAMILIES.find((family) => family.includes(name));
  if (oreFamily) {
    return oreFamily.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  }

  if (name.endsWith("_log") || NETHER_STEM_NAMES.includes(name)) {
    const names = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith("_log"))
      .concat(NETHER_STEM_NAMES);
    return names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  }

  const group = BLOCK_FAMILY_GROUPS.find((g) => g.match.some((s) => name.endsWith(s)));
  if (group) {
    return Object.keys(bot.registry.blocksByName)
      .filter((n) => group.match.some((s) => n.endsWith(s)) &&
        !(group.exclude ?? []).some((s) => n.endsWith(s)))
      .map((n) => bot.registry.blocksByName[n].id);
  }

  const single = bot.registry.blocksByName[name];
  return single ? [single.id] : [];
}

// Direct request, 2026-09-08 ("before they dig or destroy a block, they should make sure it is
// not a functional block like a bed or a furnace, a book[shelf], a table, or any other form of
// crafted item or block"). Two real, separate places this matters, both closed by this one
// shared list (exported so index.js's pathfinder Movements setup can reuse the exact same
// definition, "one definition shared instead of two copies drifting apart" per isEssentialItem's
// own precedent): (1) resolveBlockFamily()'s own raw single-name fallback (just above) will
// happily resolve ANY real block name at all, including "furnace" or "crafting_table" -- nothing
// before now stopped "mine"/"explore" from being pointed at one on purpose. (2) mineflayer-
// pathfinder's own Movements defaults (confirmed against its real movements.js source) only ever
// protects chests and non-diggable blocks (bedrock etc.) from auto-digging while pathing around
// an obstacle -- a furnace, bed, or bookshelf sitting in a bot's way is "diggable" by that
// library's own definition and gets bulldozed through exactly like stone would. Bed and shulker
// box colors are matched by suffix since minecraft-data registers each of the 16 as its own
// block name (`red_bed`, `lime_shulker_box`, etc.), not one shared id.
const PROTECTED_BLOCK_NAMES = [
  "furnace", "blast_furnace", "smoker", "crafting_table", "smithing_table", "cartography_table",
  "fletching_table", "loom", "stonecutter", "grindstone", "anvil", "chipped_anvil", "damaged_anvil",
  "enchanting_table", "brewing_stand", "cauldron", "beacon", "jukebox", "note_block", "lectern",
  "composter", "lodestone", "respawn_anchor", "chest", "trapped_chest", "ender_chest", "barrel",
  "bookshelf", "chiseled_bookshelf",
];

// Real bug found live 2026-09-13 (direct request "they need to OPEN doors not destroy them").
// Doors/trapdoors/fence gates were only ever categorized as BUILDING_MATERIAL_SUFFIXES (a
// looksLikeBuilding() detection heuristic below) -- never added here, which is the list that
// actually feeds movements.blocksCantBreak (index.js's own pathfinder setup). canOpenDoors was
// already enabled (2026-09-07) so pathfinder SHOULD open a door in its way instead of digging it,
// but nothing ever stopped it from falling back to digging through one if that logic didn't apply
// to a given move type -- the same "diggable by the library's own definition" gap this list
// already closes for furnaces/beds/chests, just never extended to the one block class the
// operator specifically named. Matches mineflayer-pathfinder's own `blockC.openable` concept
// (the exact set canOpenDoors' own check cares about) -- fence gates included since build_pen/
// herd_to_pen already open/close them deliberately via activateBlock, a different operation from
// digging, so protecting them from auto-dig doesn't conflict with that.
export function isProtectedBlockName(name) {
  return PROTECTED_BLOCK_NAMES.includes(name) || (name?.endsWith("_bed") ?? false) ||
    (name?.endsWith("_shulker_box") ?? false) || (name?.endsWith("_door") ?? false) ||
    (name?.endsWith("_trapdoor") ?? false) || (name?.endsWith("_fence_gate") ?? false);
}

// Direct request, 2026-09-07 ("what other logic enhancements are available" -> "explore/
// wander"): the single biggest recurring blocker across a whole night's live testing was
// "couldn't find X nearby" (wood, ore, chests) purely because nothing existed within the normal
// maxDistance of wherever the bot happened to be standing -- with no way to deliberately look
// further. Deliberately bounded, not open-ended exploration: a wander-then-retry per failed
// search, a fixed modest distance, not a search loop. This runs the same kind of long-distance
// pathfinding linked to tonight's cave-pathfinding OOM crashes, so it stays conservative
// (EXPLORE_DISTANCE well under a chunk-loading concern, a real timeout on the wander itself)
// rather than searching further and further outward.
//
// 2026-09-08 ("the bots just stand around most of the time"): real, confirmed root cause of a
// live report, not guessed -- direct on-server check found ZERO logs within 100 blocks of
// spawn, so the original single-hop version of this function (and this fix's own first two live-
// tested attempts: one long hop in a random direction, then several random-direction hops) had
// no reliable way to reach wood at all -- confirmed live that pure random-direction wandering
// missed a real tree cluster sitting ~83 blocks away in one specific direction, repeatedly,
// since nothing steered it that way. Every wood-gathering goal step failing instantly, over and
// over, is what "standing around" actually looked like in the logs: goal after goal giving up
// within 1-2 ticks because the very first, most basic resource was never reachable.
//
// The actual fix: this server's own view-distance (confirmed live: view-distance=10, 160
// blocks) means mineflayer already has chunk data for anything within ~160 blocks, whether or
// not she could path there directly -- bot.findBlocks() with a large maxDistance is a real,
// free, stationary lookup (no movement, no pathfinder search at all), it was only ever "mine"'s
// own SEARCH radius (32) that was narrow, not what the client could actually see. So rather than
// guessing a wander direction, EXTENDED_SEARCH_DISTANCE first checks if anything exists further
// out than the normal search, and if so, wanders TOWARD ITS REAL KNOWN BEARING in bounded hops
// (each still EXPLORE_DISTANCE, safely under bot.pathfinder.searchRadius's own 48-block OOM-
// safety cap from tonight's investigation) instead of a blind guess -- re-checking the ORIGINAL
// (narrow, cheap) findOptions after every hop, since the real goal is always "close enough for
// the normal search radius to find it now," not the extended one.
const EXPLORE_DISTANCE = 40;
const EXPLORE_TIMEOUT_MS = 15_000;
// Direct request, 2026-09-19 ("expand their search capabilities further, especially the miner and
// explorer roles"): env-tunable per-bot, same pattern as MC_SELF_DEFENSE_RANGE (§21) -- lets
// Babs/Wade's own systemd units search farther than the shared 32-block default without touching
// every other bot. EXTENDED_SEARCH_DISTANCE (the wanderAndRetryFind "beacon" scan) is safe to raise
// freely -- the actual walk there is already hop-capped at EXPLORE_DISTANCE regardless of how far
// the beacon itself is (see wanderAndRetryFind's own step = Math.min(EXPLORE_DISTANCE, dist)
// below). MINE_SEARCH_RADIUS/EXPLORE_SEARCH_RADIUS are a different risk: a found block up to that
// many blocks away gets ONE unhopped bot.collectBlock.collect() pathfind straight to it, not a
// hop-capped walk -- kept well under bot.pathfinder.searchRadius's own 48-block OOM ceiling (this
// file's own established caution, see EXPLORE_DISTANCE's header above) even when raised.
const MINE_SEARCH_RADIUS = parseInt(process.env.MC_MINE_SEARCH_RADIUS || "32", 10);
const EXPLORE_SEARCH_RADIUS = parseInt(process.env.MC_EXPLORE_SEARCH_RADIUS || "32", 10);
// Review MB-16: blocks that only (or overwhelmingly) occur at a given feature -- what EXPLORE
// <feature> scouts for. Keys are the feature words the planner/classifier may pass.
export const SCOUT_FEATURE_BLOCKS = {
  village: ["bell", "composter", "lectern", "fletching_table", "cartography_table", "smithing_table"],
  bee_nest: ["bee_nest"],
  mineshaft: ["rail", "cobweb"],
  stronghold: ["end_portal_frame", "infested_stone_bricks", "cracked_stone_bricks"],
};
const EXTENDED_SEARCH_DISTANCE = parseInt(process.env.MC_EXTENDED_SEARCH_DISTANCE || "150", 10);
const MAX_DIRECTED_HOPS = 4;

// Hoisted to module scope (was a local const inside "explore" alone) and exported, 2026-09-11
// (direct request: "ask the other bots to look near themselves... they add/update their
// knowledge of nearby resources into global world memory") -- index.js's new noteNearbyResources()
// scans this SAME curated "common raw materials" list so a scout request and an ordinary explore
// success note stay in exactly one vocabulary; one bot's "mine" query can match another bot's
// incidental discovery either way, not two independently-drifting lists.
//
// Real gap found live 2026-09-13 (direct request: "extend resource sharing memory and scouting
// to *any* resource or crafted object"). A hand-maintained 4-item list meant gold/diamond/
// redstone/lapis/every other log species/every other ore got ZERO benefit from any of this --
// rediscovered from scratch by every bot, every time. Derived programmatically from this
// server's own real block registry instead of hand-maintained: every block whose name ends in
// "_ore" or "_log"/"_stem" (every wood species this server actually has, not a guessed list),
// plus ancient_debris (the one real valuable resource that matches neither suffix). Memoized --
// the registry is fixed once a bot has spawned, no reason to recompute this every call.
let resourceBlockNamesCache = null;
export function getResourceBlockNames(bot) {
  if (resourceBlockNamesCache) return resourceBlockNamesCache;
  resourceBlockNamesCache = bot.registry.blocksArray
    .map((b) => b.name)
    .filter((name) => name.endsWith("_ore") || name.endsWith("_log") || name.endsWith("_stem") ||
      name === "ancient_debris");
  return resourceBlockNamesCache;
}

// Direct request, 2026-09-11 ("if one bot is looking for a specific resource... each bot uses the
// global world memory to gather a resource it needs, if it's not in their immediate vicinity").
// Memory notes have no structured position field (longterm.js's own writeMemoryNote just stores
// free text) -- every existing position-bearing note already uses the one real format,
// "near (x, y, z)" (explore's own success note, index.js's goalTick), so parsing that back out
// reuses an existing convention rather than inventing a new structured schema.
const MEMORY_POSITION_PATTERN = /near \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/;

async function findRememberedLocation(resourceName) {
  const hits = await searchMemory(`${resourceName} location nearby`, { topK: 5 });
  for (const hit of hits) {
    // searchMemory is semantic/fuzzy -- a hit about an unrelated resource can still score close
    // enough to come back, so a real substring check on the resource name is worth keeping on
    // top of whatever ranking the search itself already did.
    if (!hit.text || !hit.text.toLowerCase().includes(resourceName.toLowerCase())) continue;
    const match = hit.text.match(MEMORY_POSITION_PATTERN);
    if (match) return new Vec3(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  return null;
}

// One bounded hop toward a remembered position, same shape as wanderAndRetryFind's own per-hop
// goto (EXPLORE_TIMEOUT_MS, cancel-on-token, best-effort if she can't fully reach it) -- worth
// checking from wherever she actually ends up even on a partial path, same reasoning as that
// function's own catch block.
async function gotoRememberedSpot(bot, token, pos) {
  if (token.cancelled) return;
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4)),
      EXPLORE_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch {
    // Couldn't fully reach it (stale note, terrain changed, whatever) -- still worth a local
    // findBlocks from wherever she ended up rather than giving up on the memory hit entirely.
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
}

async function wanderAndRetryFind(bot, token, findOptions) {
  if (token.cancelled) return [];
  // Callers only reach here after their own initial findBlocks(findOptions) already came up
  // empty -- no need to repeat that exact same scan.
  let positions;
  const farPositions = bot.findBlocks({ ...findOptions, maxDistance: EXTENDED_SEARCH_DISTANCE, count: 1 });
  if (!farPositions.length) return []; // genuinely nothing visible at all, not just unreachable yet

  const beacon = farPositions[0];
  for (let hop = 0; hop < MAX_DIRECTED_HOPS; hop++) {
    if (token.cancelled) return [];
    const pos = bot.entity.position;
    const dx = beacon.x - pos.x, dz = beacon.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1) break; // already there
    const step = Math.min(EXPLORE_DISTANCE, dist);
    const target = pos.offset((dx / dist) * step, 0, (dz / dist) * step);
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 4)),
        EXPLORE_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      // Couldn't fully reach this hop's point (cliff, water, whatever's out there) -- still worth
      // checking from wherever she actually ended up rather than giving up on the whole approach.
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return [];
    positions = bot.findBlocks(findOptions);
    if (positions.length) return positions;
  }
  return [];
}

// Direct request, 2026-09-07 ("build the water crossing mechanic" -> boat/vehicle use, following
// the swim-crossing work). A boat is the real, standard way a player crosses open water --
// faster and with zero drowning risk, unlike swimming (index.js's own anti-drowning reflex is a
// safety net for when she's already in the water, not a substitute for a real crossing plan).
// mineflayer core already has everything needed for this, confirmed by reading its own source:
// bot.placeEntity() (place_entity.js) is a first-class API for spawning a rideable boat -- not a
// repurposed placeBlock() call, it sends the extra packet vanilla boats specifically need after
// the initial place -- and bot.mount()/bot.moveVehicle()/bot.dismount() (entities.js) are the
// real steering primitives a mounted vehicle uses, distinct from the normal walking controls
// (setControlState). bot.lookAt() (physics.js) computes the yaw/pitch to face a point directly,
// avoiding a hand-rolled (and easy to get backwards) yaw formula for steering.
const BOAT_STEER_INTERVAL_MS = 200;
const BOAT_CROSSING_TIMEOUT_MS = 60_000;
const BOAT_ARRIVAL_RADIUS = 4;

function findBoatItem(bot) {
  return bot.inventory.items().find((i) => i.name.endsWith("_boat"));
}

// Vanilla's boat recipe is real data bot.recipesFor() already knows -- checked live against
// this exact server's registry, not assumed: it's a 3-wide shape (5 planks of one species),
// which DOES need a crafting table (the personal grid is only 2x2), confirmed after an initial
// version of this wrongly assumed otherwise and failed live. Same tableBlock-lookup pattern the
// "craft" action already uses.
async function ensureBoat(bot) {
  const existing = findBoatItem(bot);
  if (existing) return existing;
  const planks = bot.inventory.items().find((i) => i.name.endsWith("_planks") && i.count >= 5);
  if (!planks) return null;
  const boatName = planks.name.replace("_planks", "_boat");
  const itemDef = bot.registry.itemsByName[boatName];
  if (!itemDef) return null;

  const tableType = bot.registry.blocksByName.crafting_table;
  const positions = tableType ? bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }) : [];
  if (!positions.length) return null; // no table nearby -- can't craft a boat, nothing more to try
  const tableBlock = bot.blockAt(positions[0]);

  try {
    await craftItem(bot, boatName, 1, tableBlock);
  } catch (err) {
    console.error("ensureBoat: craft failed:", err.message);
    return null;
  }
  return findBoatItem(bot);
}

// Best-effort: false covers every "can't do this right now" case (no boat/materials, no
// reachable water, launch failed, never got close enough before the timeout) uniformly, so
// callers can fall back to reporting their own original failure rather than a boat-specific one.
// Extracted so attemptBoatCrossing can retry against several candidate water/shore pairs --
// real testing found the first candidate found is often a bad launch spot (a shallow puddle, or
// a "ground neighbor" that pathfinder actually approaches from the far side, landing her at the
// water's edge rather than clearly on dry land), same "don't give up on the first failure"
// reasoning as every other multi-candidate loop in this file (loot/sleep/harvest).
//
// KNOWN LIMITATION, not yet resolved (2026-09-07): the actual boat spawn does not currently
// succeed live on this server, and extensive live testing narrowed down why without fully
// fixing it. One real, confirmed bug IS fixed here: bot.placeEntity() (mineflayer core,
// place_entity.js) sent boats' own supplementary "use_item" packet with only a `hand` field --
// this exact server's protocol.json (1.21.11) requires `hand`, `sequence`, AND `rotation`, and
// the missing fields crashed serialization outright the first time this was tried
// ("SizeOf error... reading 'x'"). Switching to bot.activateItem() (which builds that packet
// correctly -- the same call this file's "fish" action already uses successfully, confirmed
// live here too by directly testing it) stopped the crash, but no boat entity has been observed
// to actually spawn afterward despite: correct packet shape (confirmed via direct packet-write
// logging), correct entity-name matching for this version's per-species boat entities
// (oak_boat/spruce_boat/... replacing the old generic "Boat"), a non-forced bot.lookAt() (so the
// orientation update is confirmed sent before activating, not just applied locally), and precise
// /tp-based positioning that ruled out pathfinding drift as the cause. This matches a real,
// currently open, unresolved upstream report (PrismarineJS/mineflayer#3742, "use_item packet /
// activateItem not working on Minecraft 1.21.8") describing the exact same rotation/use_item
// breakage on 1.21.x -- closed "not planned" upstream with no fix or workaround published.
// Left in place rather than removed: the crash fix, crafting/table logic, multi-candidate
// launch-site selection, and steering-once-mounted code are all real and correct, and
// attemptBoatCrossing degrades safely to `return false` (its caller, "gohome", just falls
// through to its normal failure message) -- if a future mineflayer release fixes the underlying
// use_item/rotation handling, this should start working with no further changes needed here.
async function tryLaunchBoat(bot, token, boatItem, launch) {
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(launch.ground.position.x,
      launch.ground.position.y, launch.ground.position.z, 0)), ACTION_TIMEOUT_MS,
      () => bot.pathfinder.setGoal(null));
  } catch {
    return null;
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return null;
  // Real gap found live: GoalNear(..., 1) let pathfinder settle anywhere within 1 block of the
  // "ground" reference, including the water's own far edge -- confirmed live by ending up
  // standing on the FAR side of the water, looking almost straight down at her own feet instead
  // of across at it. GoalNear(..., 0) plus this direct check make sure she's actually somewhere
  // sane before ever trying to launch from here.
  if (bot.entity.isInWater) return null;
  if (bot.entity.position.distanceTo(launch.water.position) > 2.5) return null;

  try {
    await bot.equip(boatItem, "hand");
    const spawnPromise = new Promise((resolve, reject) => {
      const onSpawn = (entity) => {
        // Real gap found live (2026-09-07): this server's version gives each wood species its
        // own distinct boat entity (oak_boat, spruce_boat, ...), not a single generic
        // "Boat"/"boat" entity like older versions -- confirmed against this exact server's own
        // entitiesArray data. The spawned entity's name matches the item name directly.
        if (entity.name !== boatItem.name) return;
        if (entity.position.distanceTo(launch.water.position) > 3) return;
        bot.off("entitySpawn", onSpawn);
        resolve(entity);
      };
      bot.on("entitySpawn", onSpawn);
      setTimeout(() => { bot.off("entitySpawn", onSpawn); reject(new Error("boat never spawned")); }, 3000);
    });
    // Non-forced (awaited) lookAt -- confirmed the orientation update actually reaches the
    // server before activating, not just applied to local state (see this function's own header
    // comment on why that distinction mattered here). Aiming at the water's real surface height
    // (~0.88, not its lower raw block-center) keeps the look angle from being steeper than
    // necessary.
    await bot.lookAt(launch.water.position.offset(0.5, 0.88, 0.5), false);
    bot.activateItem();
    const boatEntity = await spawnPromise;
    await bot.mount(boatEntity);
    return boatEntity;
  } catch (err) {
    console.error("tryLaunchBoat: launch failed:", err.message);
    return null;
  }
}

async function attemptBoatCrossing(bot, token, target) {
  const boatItem = await ensureBoat(bot);
  if (!boatItem) return false;

  const waterId = bot.registry.blocksByName.water?.id;
  if (waterId === undefined) return false;
  // Any water within a short walk with dry ground on one side to launch from -- doesn't need to
  // be exactly on the route, just somewhere she can actually get a boat into the water near
  // wherever she already got stuck trying to walk.
  const waterPositions = bot.findBlocks({ matching: waterId, maxDistance: 24, count: 20 });
  const candidates = [];
  for (const pos of waterPositions) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ground = bot.blockAt(pos.offset(dx, 0, dz));
      if (ground?.boundingBox === "block") {
        candidates.push({ water: bot.blockAt(pos), ground });
        break;
      }
    }
    if (candidates.length >= 5) break; // enough real attempts without walking her all over the map
  }
  if (!candidates.length) return false;

  let boatEntity = null;
  for (const launch of candidates) {
    if (token.cancelled) return false;
    boatEntity = await tryLaunchBoat(bot, token, boatItem, launch);
    if (boatEntity) break;
  }
  if (!boatEntity) return false;

  const deadline = Date.now() + BOAT_CROSSING_TIMEOUT_MS;
  let arrived = false;
  try {
    while (Date.now() < deadline && !token.cancelled && bot.vehicle) {
      const pos = bot.entity.position;
      const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
      if (dist <= BOAT_ARRIVAL_RADIUS) {
        arrived = true;
        break;
      }
      await bot.lookAt(new Vec3(target.x, pos.y, target.z), true);
      bot.moveVehicle(0, 1);
      await new Promise((resolve) => setTimeout(resolve, BOAT_STEER_INTERVAL_MS));
    }
  } finally {
    bot.moveVehicle(0, 0);
    if (bot.vehicle) bot.dismount();
  }
  return arrived;
}

export function loadActionPlugins(bot) {
  bot.loadPlugin(collectBlockPkg.plugin);
  bot.loadPlugin(pvpPkg.plugin);
  loadEquipmentPlugins(bot);
}

// Best-effort, deliberately swallows its own errors: called after any action that might have
// changed the inventory (mine, attack, loot) so gear stays current without a separate request
// -- a failure here should never turn a successful action into a reported failure.
// Redundancy note (review, 2026-09-24): refreshGear runs after almost every action. When nothing
// gear-relevant changed since the last refresh (same armor/weapon candidates and durability, same
// worn pieces, same held item) there is nothing to re-equip, so it returns without touching the
// inventory.
const lastGearSignature = new WeakMap();
const GEAR_NAME = /_(helmet|chestplate|leggings|boots|sword|axe)$/;
function gearSignature(bot) {
  const carried = bot.inventory.items().filter((i) => GEAR_NAME.test(i.name))
    .map((i) => `${i.name}:${i.durabilityUsed ?? 0}`).sort();
  const worn = [5, 6, 7, 8].map((slot) => bot.inventory.slots[slot]?.name ?? "-");
  return JSON.stringify([carried, worn, bot.heldItem?.name ?? "-"]);
}

async function refreshGear(bot) {
  const signature = gearSignature(bot);
  if (lastGearSignature.get(bot) === signature) return;
  try {
    await equipBestArmor(bot);
    await equipBestWeapon(bot);
    lastGearSignature.set(bot, gearSignature(bot));
  } catch (err) {
    console.error("refreshGear failed:", err.message);
  }
}

// Rejects after `ms` rather than letting a bad path/target hang an action forever -- a real
// risk with pathfinder/collectBlock/pvp promises that have no built-in timeout of their own.
//
// Real bug found live (2026-09-06): the first version of this only raced the promise --
// Promise.race abandons the *loser*, it does not cancel it. A bot sent to mine terracotta
// (which generates naturally in badlands biomes, often behind cliffs/lava -- a genuinely
// hard-to-path target, not a bad block name) hit this: withTimeout gave up and reported
// failure after 120s, but the real bot.collectBlock.collect() call kept running underneath,
// unbounded, for another ~11 minutes until the process hit V8's heap limit and crashed --
// which is what actually disconnected the bot from the game, not a network drop. `onTimeout`
// is required now specifically so every call site cancels the real underlying work (pathfinder
// goal, collectBlock task, or pvp target) the moment the timeout fires, not just how this
// function's own caller interprets the result.
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error("timed out"));
    }, ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

// Common shallow crafting chains: the overwhelming majority of "craft X" requests that start
// from raw gathered resources bottleneck on one of these two conversions. Deliberately narrow
// and hard-coded, not a general recursive planner (see this file's own header on why building
// stays out of scope) -- covers "pre-teach the most common recipes" as a real capability
// without attempting to solve arbitrary multi-tier crafting trees.
function simpleSourceFor(bot, itemName) {
  if (itemName === "stick" || itemName === "crafting_table") {
    return bot.inventory.items().find((i) => i.name.endsWith("_planks"));
  }
  if (itemName.endsWith("_planks")) {
    return bot.inventory.items().find((i) => i.name.endsWith("_log") || i.name.endsWith("_stem"));
  }
  return null;
}

// minecraft-data already knows every vanilla recipe correctly (Recipe.ingredients,
// Recipe.requiresTable, etc., confirmed against prismarine-recipe's own types) -- there is no
// external recipe data to "teach" it. What's actually missing is this: given a target item and
// current inventory, find a recipe that's affordable *right now* (bot.recipesFor() already
// filters to exactly that -- confirmed against mineflayer's own craft.js source), and if none
// is, check whether the shortfall is one of the common intermediates above and, if so, craft
// that first before retrying. depth guards against a pathological cycle; the known chains above
// are acyclic in practice (stick/table <- planks <- log) so this rarely recurses past 1.
async function craftItem(bot, itemName, count, tableBlock, depth = 0) {
  const itemDef = bot.registry.itemsByName[itemName];
  if (!itemDef) throw new Error(`unknown item "${itemName}"`);

  let recipes = bot.recipesFor(itemDef.id, null, count, tableBlock ?? null);
  if (!recipes.length && depth < 3) {
    // `true` (not a real Block) is enough to satisfy recipesAll()'s own requiresTable check --
    // confirmed against mineflayer's craft.js source -- this is only inspecting what a recipe
    // *would* need, not actually crafting with it.
    const candidateRecipes = bot.recipesAll(itemDef.id, null, tableBlock ?? true);
    for (const recipe of candidateRecipes) {
      // Real crash found live (2026-09-07, autonomy goal loop): recipesAll() for items that are
      // ONLY ever obtained by smelting (e.g. copper_ingot from raw_copper, furnace itself was a
      // red herring -- the actual candidate recipe minecraft-data returned here had no usable
      // ingredients list) returned at least one recipe object without a real, iterable
      // `ingredients` array -- `for...of` over it threw "is not iterable" and crashed the whole
      // craft attempt instead of just skipping that one unusable candidate. Smelting isn't
      // supported by this action at all (bot.craft() is crafting-table/grid only, a furnace is a
      // separate mineflayer API this doesn't implement) -- skipping non-array ingredients here
      // means an unsupported smelting-only item now fails cleanly ("don't have the ingredients")
      // instead of crashing the bot's whole craft/goal step.
      if (!Array.isArray(recipe.ingredients)) continue;
      for (const ing of recipe.ingredients) {
        const ingName = bot.registry.items[ing.id]?.name;
        if (!ingName) continue;
        const have = bot.inventory.count(ingName, null);
        if (have >= ing.count) continue;
        if (simpleSourceFor(bot, ingName)) {
          await craftItem(bot, ingName, ing.count - have, tableBlock, depth + 1);
        }
      }
    }
    recipes = bot.recipesFor(itemDef.id, null, count, tableBlock ?? null);
  }
  if (!recipes.length) {
    throw new Error(`don't have the ingredients${tableBlock ? "" : " (might need a crafting table)"}`);
  }
  await bot.craft(recipes[0], count, tableBlock ?? undefined);
}

// Extracted from "loot" (2026-09-06's own real find, see 1.5.0's history) so "store" (2026-09-07,
// "do all" -> base/chest storage) can reuse the exact same check instead of a second copy
// drifting out of sync. Any solid block directly above EITHER half of a double chest blocks the
// whole thing in vanilla -- scanning cardinal neighbors for the matching paired half (rather than
// trusting a memorized left/right-to-offset convention) is more robust than computing it from
// facing+type directly.
function chestObstructed(bot, chestBlock) {
  const halves = [chestBlock];
  if (chestBlock.getProperties?.().type !== undefined) {
    const facing = chestBlock.getProperties().facing;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = bot.blockAt(chestBlock.position.offset(dx, 0, dz));
      if (neighbor?.name === chestBlock.name && neighbor.getProperties?.().facing === facing) {
        halves.push(neighbor);
        break;
      }
    }
  }
  return halves.some((half) => bot.blockAt(half.position.offset(0, 1, 0))?.boundingBox === "block");
}

// Direct request, 2026-09-08 ("the duplicate crafting check should be for all resources as well
// as utilities like crafting tables. if a resource is in a nearby chest, they should not mine
// it"). Generalizes the crafting_table/furnace nearby-block check ("craft"'s own
// REUSABLE_UTILITY_BLOCKS) to ANY resource in a nearby CHEST, not just a placed utility block --
// before spending time mining or consuming raw materials to craft something, check whether it's
// already sitting in a container within reach. Reuses "loot"'s own real chest-interaction
// mechanics (chestObstructed, multi-candidate search, openChest/containerItems/withdraw) rather
// than a second, drifting copy. Deliberately an all-or-nothing check: takes exactly `wantCount`
// only if a chest has AT LEAST that much of one matching item, never a partial amount -- taking
// some and still needing to mine/craft the rest would need the caller to juggle a reduced
// target count, real complexity for a check that's meant to catch the common, high-value case
// (a chest already has enough), not optimize every partial one.
const CHEST_CHECK_MAX_CANDIDATES = 3;

// Redundancy note (review, 2026-09-24): MINE/CRAFT/EXPLORE all check chests first, often right
// after a LOOT or another action already searched the same chests for the same items. A search
// that came up empty is remembered for CHEST_MISS_TTL_MS, and repeating it from roughly the same
// spot is skipped.
const CHEST_MISS_TTL_MS = 60_000;
const CHEST_MISS_RADIUS = 16;
const chestMisses = new Map(); // sorted item names -> { at, pos }

async function tryTakeFromNearbyChest(bot, token, itemNames, wantCount) {
  const missKey = [...itemNames].sort().join(",");
  const miss = chestMisses.get(missKey);
  if (miss && Date.now() - miss.at < CHEST_MISS_TTL_MS && bot.entity?.position.distanceTo(miss.pos) <= CHEST_MISS_RADIUS) {
    return null;
  }
  const found = await searchChestsFor(bot, token, itemNames, wantCount);
  if (found) chestMisses.delete(missKey);
  else if (!token.cancelled && bot.entity) chestMisses.set(missKey, { at: Date.now(), pos: bot.entity.position.clone() });
  return found;
}

async function searchChestsFor(bot, token, itemNames, wantCount) {
  const chestType = bot.registry.blocksByName.chest;
  const trappedType = bot.registry.blocksByName.trapped_chest;
  const matchIds = [chestType?.id, trappedType?.id].filter((id) => id !== undefined);
  if (!matchIds.length) return null;
  const positions = bot.findBlocks({ matching: matchIds, maxDistance: 32, count: CHEST_CHECK_MAX_CANDIDATES });

  for (const pos of positions) {
    if (token.cancelled) return null;
    const chestBlock = bot.blockAt(pos);
    if (!chestBlock || chestObstructed(bot, chestBlock)) continue;
    const result = await tryTakeFromThisChest(bot, token, chestBlock, itemNames, wantCount);
    if (result === "cancelled") return null;
    if (result) return result;
    // else: reachable and openable, just didn't have enough -- try the next local candidate
  }

  // Direct request, 2026-09-13 ("extend resource sharing memory... to chests"): local search
  // (above) came up with nothing usable within 32 blocks -- consult the shared known-chests
  // registry (recordChestSnapshot's own write side, populated by every real open/withdraw/
  // deposit fleet-wide) for a specific chest anywhere that's recently been seen holding this
  // item, same "local search first, remembered location second" pattern "mine" already uses via
  // findRememberedLocation(). A stale entry (emptied since, or never really had it) just falls
  // through to the normal fail() a caller already handles -- no worse off than not trying.
  for (const itemName of itemNames) {
    const known = await findKnownChestWithItem(bot, itemName, wantCount);
    if (!known) continue;
    if (token.cancelled) return null;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(known.position.x, known.position.y, known.position.z, 3)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      continue; // couldn't reach the remembered spot -- try the next remembered item name, if any
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return null;
    const chestBlock = bot.blockAt(known.position);
    if (!chestBlock || chestObstructed(bot, chestBlock)) continue;
    const result = await tryTakeFromThisChest(bot, token, chestBlock, itemNames, wantCount);
    if (result === "cancelled") return null;
    if (result) return result;
  }
  return null;
}

// Extracted from tryTakeFromNearbyChest's own loop body so both the local-search pass and the
// remembered-chest fallback share exactly one open/withdraw/snapshot implementation rather than
// two independently-drifting copies. Returns the withdrawal result object, "cancelled" (caller
// should stop entirely), or null (this specific chest didn't have enough -- try another).
async function tryTakeFromThisChest(bot, token, chestBlock, itemNames, wantCount) {
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
      chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
      () => bot.pathfinder.setGoal(null));
  } catch {
    return null; // couldn't reach this one -- try the next candidate
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return "cancelled";

  let chest = null;
  try {
    chest = await bot.openChest(chestBlock);
    const contents = chest.containerItems();
    // Real bug found live 2026-09-12 (direct report: "a chest with sticks already made is
    // ignored when they need sticks"). This used to require ONE slot to independently hold
    // >= wantCount -- but a real, common deposit pattern (multiple bots each banking a few via
    // "inventory insurance," 2.39.0, or a partial withdrawal by an earlier visit) easily splits
    // the same item across several slots (e.g. 3+3+2 sticks from three separate deposits), and
    // .find() against a single-slot threshold matched none of them even though the chest
    // genuinely had enough combined. Now sums every matching slot before deciding, and takes
    // whatever's actually there (never more than wantCount, honestly reports less if that's all
    // that's available -- matching this codebase's own "don't oversell a result" discipline).
    // chest.withdraw() itself already draws from multiple slots of the same item/metadata
    // automatically (confirmed against mineflayer's own Window/Chest source) -- summing first
    // was the only change actually needed.
    const matches = contents.filter((i) => itemNames.includes(i.name));
    const totalAvailable = matches.reduce((sum, i) => sum + i.count, 0);
    if (!totalAvailable) {
      // Real, current truth either way -- an empty/wrong-contents chest is worth recording too,
      // so a stale known-chests entry gets corrected rather than kept forever.
      await recordChestSnapshot(chestBlock.position, contents);
      return null;
    }
    // Review MB-17, 2026-09-24: `matches` can span several concrete item types (oak + birch logs
    // for a "logs" request), but withdraw() takes ONE type -- asking for the family total of
    // matches[0].type threw whenever that one type alone fell short. Withdraw per type, each
    // capped at what that type actually has.
    const perType = new Map();
    for (const item of matches) {
      const entry = perType.get(item.type) ?? { name: item.name, count: 0 };
      entry.count += item.count;
      perType.set(item.type, entry);
    }
    let taken = 0;
    let firstName = null;
    for (const [type, { name, count }] of perType) {
      if (taken >= wantCount || token.cancelled) break;
      const take = Math.min(wantCount - taken, count);
      await chest.withdraw(type, null, take);
      taken += take;
      firstName ??= name;
    }
    // Direct request, 2026-09-13 ("remember what is in chests when someone opens it, if someone
    // takes the item out redact it from global memory"): a fresh post-withdraw snapshot IS the
    // redaction -- whatever was just taken is naturally absent from this real, current-truth
    // read, no separate delete-this-item step to get subtly out of sync with reality.
    await recordChestSnapshot(chestBlock.position, chest.containerItems());
    return taken ? { name: firstName, count: taken } : null;
  } catch {
    return null; // couldn't open this one -- try the next candidate
  } finally {
    try { await chest?.close(); } catch { /* already closed */ }
  }
}

// Direct follow-up to "what other autonomous behaviors are solvable" -> "fix all the above":
// cross-bot resource contention. arbitrateGoalConflict() (index.js) already judges conflict at
// GOAL-SELECTION time from goal *text* -- real, but blind to the case that actually matters here:
// two bots with differently-worded, individually-non-conflicting goals ("get some iron" /
// "smelt myself a chestplate") converging on the exact same ore vein simply because that's where
// the ore happens to be, discovered only once both are already standing on top of each other. No
// amount of language-level judgment catches that -- it's a physical fact about the world, not a
// disagreement about intent. This is purely spatial and runs at mining time, not goal time:
// other known bots are ordinary named players from this bot's own point of view (bot.players),
// so their live position is already free, real data -- no Buzz coordination message needed for
// something this bot can just see. Independent small env-derived roster, same pattern
// index.js's own BOT_USERNAMES already uses -- actions.js stays a leaf module with no import from
// index.js (this file's own header: "index.js does the mutating," never the reverse).
// "Bob" added 2026-09-11, "Nell,Wade,Dale" added 2026-09-13 (§22 rebalance) -- both times kept in
// sync with index.js's own BOT_USERNAMES default since this really is an independent duplicate
// of that same roster, not a second source of truth.
const OTHER_BOT_USERNAMES = new Set(
  (process.env.MC_BOT_USERNAMES || "Babs,Amy,Mark,Luke,Mayor,Bob,Nell,Wade,Dale").split(",").map((s) => s.trim()).filter(Boolean),
);
const BOT_PROXIMITY_AVOID_DISTANCE = 6;
// How many extra candidates to fetch beyond what's actually needed, so filtering out ones too
// close to another bot still leaves enough real candidates -- findBlocks' own `count` caps
// results BEFORE this filter can run, so asking for only the bare minimum up front would silently
// defeat this the moment the nearest few happen to be the contested ones.
const CONTENTION_SEARCH_OVERFETCH = 3;

function filterAwayFromOtherBots(bot, positions) {
  const otherPositions = [...OTHER_BOT_USERNAMES]
    .filter((name) => name !== bot.username)
    .map((name) => bot.players[name]?.entity?.position)
    .filter(Boolean);
  if (!otherPositions.length) return positions; // no other bot even visible -- nothing to avoid
  const clear = positions.filter((pos) =>
    otherPositions.every((otherPos) => pos.distanceTo(otherPos) > BOT_PROXIMITY_AVOID_DISTANCE));
  // Avoiding crowding is a courtesy, not a hard requirement -- if EVERY candidate is contested
  // (e.g. a single small vein with a bot already parked on it), mining the contested one still
  // beats finding nothing at all.
  return clear.length ? clear : positions;
}

// What item actually lands in her inventory when she MINES this block, for the unenchanted
// (non-Silk-Touch) case this codebase always uses -- real vanilla drop behavior, not the
// block's own name. Most ores drop a raw/processed item, not a copy of themselves (confirmed
// against real game rules: coal_ore drops "coal", iron/copper/gold ore drop "raw_x", diamond/
// emerald/redstone/lapis ore drop the gem/dust item directly). Logs are the one common case
// that genuinely doesn't need an entry -- an oak_log block drops an oak_log item, same name.
// Small and deliberately curated, same pragmatic scope as SMELT_RECIPES/FUEL_PREFERENCE above,
// not an attempt at exhaustive coverage of every block in the game.
const MINE_DROPS = {
  coal_ore: "coal", deepslate_coal_ore: "coal",
  iron_ore: "raw_iron", deepslate_iron_ore: "raw_iron",
  copper_ore: "raw_copper", deepslate_copper_ore: "raw_copper",
  gold_ore: "raw_gold", deepslate_gold_ore: "raw_gold", nether_gold_ore: "gold_nugget",
  diamond_ore: "diamond", deepslate_diamond_ore: "diamond",
  emerald_ore: "emerald", deepslate_emerald_ore: "emerald",
  redstone_ore: "redstone", deepslate_redstone_ore: "redstone",
  lapis_ore: "lapis_lazuli", deepslate_lapis_ore: "lapis_lazuli",
};

// Maps a resolved family of block ids (resolveBlockFamily's own output -- e.g. every log
// species, or both the stone- and deepslate-layer variant of one ore) to the real item name(s)
// that would already satisfy the same need if sitting in a chest, deduplicated since a whole ore
// family usually collapses to one drop item.
function itemNamesForMinedBlocks(bot, blockIds) {
  const names = blockIds.map((id) => {
    const blockName = bot.registry.blocks[id]?.name;
    return blockName ? (MINE_DROPS[blockName] || blockName) : null;
  }).filter(Boolean);
  return [...new Set(names)];
}

// Real incident found live (2026-09-07): Amy's bed sat right at the edge of open water, so every
// death near it turned "recover" into a repeated drowning loop -- the bed itself was never the
// bug, but sleeping in one next to a hazard is what put her in harm's way in the first place.
// Vanilla doesn't stop a player from using a bed next to water/lava, so this is a check nothing
// upstream enforces. Scans a generous box around the bed rather than just the block it's on,
// since the actual sleeping/wake-up position can land a block or two off the bed block itself.
function bedNearHazard(bot, bedPos) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const block = bot.blockAt(bedPos.offset(dx, dy, dz));
        if (block?.name === "water" || block?.name === "lava") return true;
      }
    }
  }
  return false;
}

// Direct request, 2026-09-09 ("when they find saplings, they should plant them... in any free
// soil not directly adjacent to a building if they can't [find same-variety trees]"). "A
// building" has no real in-game flag to check -- this is a practical heuristic, not an exact
// detector: any functional/crafted block (isProtectedBlockName() -- a chest, furnace, bed, etc.
// sitting there is a very strong building signal) or a common hand-placed construction material
// (planks/cobblestone/stone-family/glass/doors -- exactly the kind of block "build"'s own
// material selection would have used) nearby counts as "a building." A false positive here just
// means one more otherwise-fine spot gets skipped in favor of another -- cheap, since real
// forests rarely run short of open ground.
const BUILDING_MATERIAL_NAMES = ["cobblestone", "mossy_cobblestone", "stone", "smooth_stone",
  "stone_bricks", "mossy_stone_bricks", "cracked_stone_bricks", "bricks", "glass", "glass_pane"];
const BUILDING_MATERIAL_SUFFIXES = ["_planks", "_door", "_trapdoor", "_stairs", "_slab", "_fence",
  "_fence_gate", "_stained_glass", "_stained_glass_pane"];

function looksLikeBuilding(block) {
  if (!block) return false;
  if (isProtectedBlockName(block.name)) return true;
  if (BUILDING_MATERIAL_NAMES.includes(block.name)) return true;
  return BUILDING_MATERIAL_SUFFIXES.some((suffix) => block.name.endsWith(suffix));
}

// radius=6, direct request 2026-09-09 ("'near a building' is defined as 6 blocks") -- was 3
// (a guess) until specified exactly.
function nearBuilding(bot, pos, radius = 6) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (looksLikeBuilding(bot.blockAt(pos.offset(dx, dy, dz)))) return true;
      }
    }
  }
  return false;
}

// Rule 1 of sapling planting: near other trees of the same variety, if any are reachable.
// `center` is some log block belonging to that tree (findBlocks' own match, not necessarily the
// trunk's base) -- real trunks are several blocks tall, so this scans a small vertical band
// around center's own Y, not just center's exact level, to find the actual ground surface.
// Skips the immediate trunk area (radius < 2) so the sapling doesn't get crammed right against
// the tree it's supposed to be planted "near," not "inside."
function findPlantableSpotNear(bot, center, radius) {
  const groundIds = [bot.registry.blocksByName.grass_block?.id, bot.registry.blocksByName.dirt?.id]
    .filter((id) => id !== undefined);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
      for (let dy = 2; dy >= -2; dy--) {
        const pos = center.offset(dx, dy, dz);
        const ground = bot.blockAt(pos);
        if (!ground || !groundIds.includes(ground.type)) continue;
        // Real "air", not just non-solid -- a pre-existing sapling/tall-grass/flower isn't
        // "block" either, and planting into one is a real placement failure (found live,
        // 2026-09-09: "Server refused to place dark_oak_sapling ... the block is still
        // dark_oak_sapling").
        if (bot.blockAt(pos.offset(0, 1, 0))?.name !== "air") continue;
        return pos;
      }
    }
  }
  return null;
}

// Item #4 of "fix all the above" (bed ownership) -- see "sleep"'s own changelog note below for
// why. One small file per bot, same hermes-data-mount-backed pattern skills.js's SKILLS_DIR
// already uses for exactly this "small, durable, per-process state that must survive a restart"
// need.
const BEDS_DIR = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/beds`; // MC_MEMORY_ROOT: test isolation

// Hoisted to module scope 2026-09-11 (direct request "fix the pen herding") so both "breed" and
// the new "herd_to_pen" case below can share one definition -- it used to live only inside
// "breed"'s own case block, which meant the herding verb would otherwise need a second,
// independently-drifting copy of which food tempts which species.
const BREEDING_FOOD = {
  cow: ["wheat"], sheep: ["wheat"], pig: ["carrot", "potato", "beetroot"],
  chicken: ["wheat_seeds", "pumpkin_seeds", "melon_seeds", "beetroot_seeds"],
  // Added 2026-09-11 ("bee nests/hives") -- real vanilla bees breed on any flower, not one
  // specific item, so this lists every common flower id rather than picking a single canonical
  // one the way cow/sheep/pig/chicken each have.
  bee: ["poppy", "dandelion", "blue_orchid", "allium", "azure_bluet", "red_tulip",
        "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy", "cornflower",
        "lily_of_the_valley", "sunflower", "lilac", "rose_bush", "peony"],
};

// Direct request, 2026-09-11 ("fix the pen herding"): a pen built by "build_pen" needs to be
// FOUND again later by "herd_to_pen" -- one small shared file, same durable-mount pattern
// loadClaimedBed/saveClaimedBed just below already uses. Deliberately ONE shared pen, not
// per-bot: unlike a bed (personal, claimed), a pen is fleet infrastructure -- the same "shared,
// not per-bot" reasoning MINECRAFT_BOTS_DESIGN.md §15.6 already gives for the crafting
// table/furnace/chest.
const PEN_FILE = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/pen.json`;

async function loadPenLocation() {
  try {
    const data = JSON.parse(await readFile(PEN_FILE, "utf8"));
    return { center: new Vec3(data.center.x, data.center.y, data.center.z), gate: new Vec3(data.gate.x, data.gate.y, data.gate.z) };
  } catch {
    return null; // no pen built yet, or the file's gone/corrupt
  }
}

async function savePenLocation(center, gate) {
  try {
    await mkdir(path.dirname(PEN_FILE), { recursive: true });
    await writeFile(PEN_FILE, JSON.stringify({
      center: { x: center.x, y: center.y, z: center.z },
      gate: { x: gate.x, y: gate.y, z: gate.z },
    }), "utf8");
  } catch (err) {
    console.error("build_pen: failed to persist pen location:", err.message);
  }
}

// 2026-09-25 farming/ranching. loot's item can name a group: "food" (a hungry bot with nothing to eat
// fetches some -- index.js checkHunger) or "seeds" (anything harvest can plant).
export const SEED_NAMES = ["wheat_seeds", "carrot", "potato", "beetroot_seeds"];
const LOOT_GROUPS = { food: FOOD_NAMES, seeds: SEED_NAMES };

// Verified achievements -- recorded by the action that actually did the thing (harvest picked a ripe
// crop, herd_to_pen got an animal into the pen, breed saw a baby appear), never by a planner's claim.
// Mayor's curriculum counts these instead of "holding a crop", which looting satisfied. One small
// per-bot file so a restart keeps them; bot.emit("achievement") lets index.js report a new one.
const ACHIEVEMENTS_DIR = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/achievements`;
const achievementsByBot = new Map();

export async function loadAchievements(bot) {
  if (!achievementsByBot.has(bot.username)) {
    let names = [];
    try {
      names = JSON.parse(await readFile(path.join(ACHIEVEMENTS_DIR, `${bot.username}.json`), "utf8"));
    } catch {}
    if (!achievementsByBot.has(bot.username)) achievementsByBot.set(bot.username, new Set(Array.isArray(names) ? names : []));
  }
  return achievementsByBot.get(bot.username);
}

export function getAchievements(bot) {
  return achievementsByBot.get(bot.username) ?? new Set();
}

export async function recordAchievement(bot, name) {
  const set = await loadAchievements(bot);
  if (set.has(name)) return false;
  set.add(name);
  try {
    await mkdir(ACHIEVEMENTS_DIR, { recursive: true });
    await writeFile(path.join(ACHIEVEMENTS_DIR, `${bot.username}.json`), JSON.stringify([...set]), "utf8");
  } catch (err) {
    console.error("achievements: failed to persist:", err.message);
  }
  console.log(`[${bot.username}] achievement: ${name}`);
  bot.emit("achievement", name);
  return true;
}

export { loadPenLocation, BREEDING_FOOD };

export const LIVESTOCK = ["cow", "sheep", "pig", "chicken"];

// Animals of one kind standing inside the pen (its 5x5 interior).
export function countInPen(bot, pen, species) {
  return Object.values(bot.entities).filter((e) => e.name === species &&
    Math.abs(e.position.x - (pen.center.x + 0.5)) < 2.6 && Math.abs(e.position.z - (pen.center.z + 0.5)) < 2.6 &&
    Math.abs(e.position.y - pen.center.y) < 2).length;
}

// A flat, open 7x7 spot 8-20 blocks from home for build_pen (which builds around its site): same
// floor height across all 49 columns, two blocks of air above each. Building around the bot where
// she stood at home would fence the fleet into its own shelter.
export function findPenSite(bot, home) {
  const hx = Math.floor(home.x), hy = Math.floor(home.y), hz = Math.floor(home.z);
  const feet = new Map(); // "x,z" -> feet y of an open column with solid ground, or null
  const feetAt = (x, z) => {
    const key = `${x},${z}`;
    if (feet.has(key)) return feet.get(key);
    let found = null;
    for (let y = hy + 3; y >= hy - 3 && found === null; y--) {
      const ground = bot.blockAt(new Vec3(x, y - 1, z));
      const a = bot.blockAt(new Vec3(x, y, z)), b = bot.blockAt(new Vec3(x, y + 1, z));
      if (ground?.boundingBox === "block" && a?.name === "air" && b?.name === "air") found = y;
    }
    feet.set(key, found);
    return found;
  };
  let best = null, bestDist = Infinity;
  for (let dx = -20; dx <= 20; dx++) {
    for (let dz = -20; dz <= 20; dz++) {
      const dist = Math.hypot(dx, dz);
      if (dist < 8 || dist > 20 || dist >= bestDist) continue;
      const y = feetAt(hx + dx, hz + dz);
      if (y === null) continue;
      let flat = true;
      for (let ox = -3; ox <= 3 && flat; ox++) {
        for (let oz = -3; oz <= 3 && flat; oz++) flat = feetAt(hx + dx + ox, hz + dz + oz) === y;
      }
      if (flat) { best = new Vec3(hx + dx, y, hz + dz); bestDist = dist; }
    }
  }
  return best;
}

// Farm plots (harvest). Farmland is hydrated by water within 4 blocks at its own level, so the plot
// goes around the water with the most tillable ground beside it; with no water, the tillable blocks
// closest together near the bot. Tilling needs nothing on top, so small plants get cleared first.
const FARM_PLOT_SIZE = 8;
const TILLABLE = new Set(["dirt", "grass_block", "dirt_path", "rooted_dirt"]);
const CLEAR_ABOVE = new Set(["short_grass", "grass", "tall_grass", "fern", "large_fern", "dead_bush",
  ...BREEDING_FOOD.bee]);
function tillableAt(bot, pos) {
  const ground = bot.blockAt(pos), above = bot.blockAt(pos.offset(0, 1, 0));
  return !!ground && TILLABLE.has(ground.name) && !!above && (above.name === "air" || CLEAR_ABOVE.has(above.name));
}

export function chooseFarmPlot(bot, near) {
  const origin = near || bot.entity.position;
  const waterId = bot.registry.blocksByName.water?.id;
  const waters = waterId === undefined ? [] : bot.findBlocks({ matching: waterId, maxDistance: 32, count: 60, point: origin });
  let best = null;
  for (const w of waters) {
    const around = [];
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const pos = w.offset(dx, 0, dz);
        if ((dx || dz) && tillableAt(bot, pos)) around.push(pos);
      }
    }
    if (around.length < 4) continue;
    if (!best || around.length > best.plot.length ||
        (around.length === best.plot.length && w.distanceTo(origin) < best.water.distanceTo(origin))) {
      best = { water: w, plot: around };
    }
  }
  if (best) {
    const plot = best.plot.sort((a, b) => a.distanceTo(best.water) - b.distanceTo(best.water)).slice(0, FARM_PLOT_SIZE);
    return { plot, hydrated: true, center: best.water };
  }
  const soil = bot.findBlocks({ matching: (b) => TILLABLE.has(b.name), maxDistance: 32, count: 200, point: origin })
    .filter((pos) => tillableAt(bot, pos));
  if (!soil.length) return null;
  const first = soil[0];
  const plot = soil.filter((pos) => pos.distanceTo(first) <= 3).slice(0, FARM_PLOT_SIZE);
  return { plot, hydrated: false, center: first };
}

export const CROP_MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };

// Breaking a crop (or the grass on a plot) from 2 blocks away leaves its drops on the ground -- the
// harvested wheat never reached her inventory (live test, 2026-09-25). Walk over what's lying around
// the spots she worked, nearest first, for at most maxMs.
async function collectDrops(bot, token, spots, maxMs = 10_000) {
  const deadline = Date.now() + maxMs;
  for (let tries = 0; tries < 12 && Date.now() < deadline && !token.cancelled; tries++) {
    const drop = Object.values(bot.entities)
      .filter((e) => e.name === "item" && spots.some((spot) => e.position.distanceTo(spot) <= 4))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) return;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)),
        Math.max(1000, deadline - Date.now()), () => bot.pathfinder.setGoal(null));
    } catch {
      // unreachable or timed out -- the loop's deadline and try cap end it
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    await new Promise((r) => setTimeout(r, 300)); // the pickup lands a tick or two later
  }
}

// What's planted near a spot: ripe crops, and crops still growing.
export function farmStatus(bot, near) {
  const cropIds = Object.keys(CROP_MAX_AGE).map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  const crops = bot.findBlocks({ matching: cropIds, maxDistance: 32, count: 128, ...(near ? { point: near } : {}) })
    .map((p) => bot.blockAt(p)).filter(Boolean);
  const ripe = crops.filter((b) => Number(b.getProperties?.().age) === CROP_MAX_AGE[b.name]);
  return { ripe: ripe.length, growing: crops.length - ripe.length };
}

// Direct request, 2026-09-13 ("remember what is in chests when someone opens it. if someone
// takes the item out of a chest, redact it from global memory"). A structured, mutable, SHARED
// registry -- deliberately NOT the fuzzy RAG-based world-memory notes (hermes-rag/longterm.js)
// used for resource/crafted-object LOCATIONS elsewhere in this file: that system is append-only/
// dedup-based, built for "is this roughly the same fact as one already noted," not "replace this
// chest's exact contents with what's true right now." A chest's contents change every time
// anyone opens it, so this needs real point-in-time overwrites, not a growing pile of similar
// notes -- same "small shared JSON file under the durable mount" pattern PEN_FILE/BEDS_DIR
// already use, keyed by chest position (rounded -- a chest occupies one exact block, no need for
// SwimMovements-style fuzziness). Recording a FULL snapshot on every real interaction means
// "redaction" is a side effect of always writing the current truth, never a separate
// delete-this-one-item operation that could drift from reality.
const KNOWN_CHESTS_FILE = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/known_chests.json`;

function chestKey(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`;
}

async function loadKnownChests() {
  try {
    return JSON.parse(await readFile(KNOWN_CHESTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveKnownChests(data) {
  try {
    await mkdir(path.dirname(KNOWN_CHESTS_FILE), { recursive: true });
    await writeFile(KNOWN_CHESTS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("known_chests: failed to persist:", err.message);
  }
}

// Called after every real chest interaction (a plain open, or open+withdraw, or open+deposit)
// with whatever chest.containerItems() shows AT THAT EXACT MOMENT -- always the current truth,
// so an item someone just withdrew is simply absent from this write, and one just deposited is
// present. Read-modify-write against one shared file, same low-contention tolerance every other
// piece of shared fleet state here already accepts (pen location, claimed beds) -- a rare
// simultaneous write from two bots opening the same chest at once could lose one update, judged
// an acceptable, self-correcting-on-next-open tradeoff rather than building real locking for it.
async function recordChestSnapshot(position, items) {
  const known = await loadKnownChests();
  const contents = {};
  for (const item of items) contents[item.name] = (contents[item.name] || 0) + item.count;
  known[chestKey(position)] = {
    position: { x: position.x, y: position.y, z: position.z },
    contents,
    lastSeenAt: new Date().toISOString(),
  };
  await saveKnownChests(known);
}

// The read-side counterpart: a real, structured, position-precise lookup ("which known chest
// actually has enough of this item") rather than the fuzzy RAG search findRememberedLocation()
// already does for raw resource veins. Returns the NEAREST matching chest (not just the first
// found), since "closest known chest with the item" is a more useful answer than an arbitrary
// one once more than a handful of chests are tracked. Best-effort: a chest emptied by someone
// else since its last recorded snapshot simply won't be found again until its own next open
// re-snapshots it -- the same eventual-consistency tradeoff recordChestSnapshot's own comment
// already accepts.
async function findKnownChestWithItem(bot, itemName, wantCount) {
  const known = await loadKnownChests();
  let best = null, bestDist = Infinity;
  for (const entry of Object.values(known)) {
    const have = entry.contents?.[itemName] || 0;
    if (have < 1) continue;
    const pos = new Vec3(entry.position.x, entry.position.y, entry.position.z);
    const dist = pos.distanceTo(bot.entity.position);
    if (dist < bestDist) {
      best = { position: pos, count: Math.min(have, wantCount) };
      bestDist = dist;
    }
  }
  return best;
}

// Exported 2026-09-09 so index.js's storeSurplusNearHome() ("after any crafting activity,
// surplus materials should be stored in a chest as close to their sleeping home as possible")
// can read the same real claimed-bed position "sleep" itself already tries first every night,
// rather than a second, drifting notion of "home."
export async function loadClaimedBed(bot) {
  return (await readBedClaims(bot))[bot.username] || null; // null: no claim -- fresh search
}

// Direct request, 2026-09-25: bed assignments shared between hosts. Claims live in hermes-memory's
// agent_state (agent "minecraft-beds", key = bot name), which every bot on spark and spark2 already
// reaches, so a spark2 bot sees spark's claims and vice versa. The service has no delete, so {} is
// "no claim". BEDS_DIR stays as this host's fallback copy for when hermes-memory is unreachable,
// and a local claim the shared store has never seen is published on the owner's first read.
const BED_CLAIMS_AGENT = "minecraft-beds";
const BED_CLAIMS_SHARED = (process.env.MC_BED_CLAIMS_SHARED ?? "true") !== "false";
const BED_CLAIMS_TIMEOUT_MS = 5000;
let bedClaimsSharedDown = false; // log the fallback once per outage, not every read

const toBedPos = (v) => (Number.isFinite(v?.x) && Number.isFinite(v?.y) && Number.isFinite(v?.z)
  ? new Vec3(v.x, v.y, v.z) : null);

async function readLocalBedClaims() {
  const claims = {};
  let files = [];
  try {
    files = await readdir(BEDS_DIR);
  } catch {}
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const pos = toBedPos(JSON.parse(await readFile(path.join(BEDS_DIR, file), "utf8")));
      if (pos) claims[file.slice(0, -5)] = pos;
    } catch {} // a half-written or corrupt claim just doesn't count
  }
  return claims;
}

async function writeLocalBedClaim(username, position) {
  const file = path.join(BEDS_DIR, `${username}.json`);
  try {
    if (!position) return await unlink(file).catch(() => {});
    await mkdir(BEDS_DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ x: position.x, y: position.y, z: position.z }), "utf8");
  } catch (err) {
    console.error("beds: failed to write local claim:", err.message);
  }
}

// Every bot's claim, { username: Vec3 } -- the shared store when reachable, else this host's copy.
async function readBedClaims(bot) {
  const local = await readLocalBedClaims();
  if (!BED_CLAIMS_SHARED) return local;
  let rows;
  try {
    rows = await listState(BED_CLAIMS_AGENT, BED_CLAIMS_TIMEOUT_MS);
  } catch (err) {
    if (!bedClaimsSharedDown) console.log(`[beds] shared claims unreachable, using this host's: ${err.message}`);
    bedClaimsSharedDown = true;
    return local;
  }
  if (bedClaimsSharedDown) console.log("[beds] shared claims reachable again.");
  bedClaimsSharedDown = false;
  const claims = {};
  for (const row of rows) {
    const pos = toBedPos(row.value);
    if (pos) claims[row.key] = pos;
  }
  const mine = local[bot.username];
  if (!rows.some((r) => r.key === bot.username)) {
    if (mine) { // first read since sharing began: publish this host's claim
      await setState(BED_CLAIMS_AGENT, bot.username, { x: mine.x, y: mine.y, z: mine.z }, BED_CLAIMS_TIMEOUT_MS)
        .catch((err) => console.error("beds: failed to publish claim:", err.message));
      claims[bot.username] = mine;
    }
  } else {
    const shared = claims[bot.username] || null; // keep the fallback copy in step with the store
    if (!(mine && shared ? mine.equals(shared) : !mine && !shared)) await writeLocalBedClaim(bot.username, shared);
  }
  return claims;
}

async function writeBedClaim(bot, position) {
  await writeLocalBedClaim(bot.username, position);
  if (!BED_CLAIMS_SHARED) return;
  const value = position ? { x: position.x, y: position.y, z: position.z } : {};
  await setState(BED_CLAIMS_AGENT, bot.username, value, BED_CLAIMS_TIMEOUT_MS)
    .catch((err) => console.error("beds: failed to share claim:", err.message));
}

async function saveClaimedBed(bot, position) {
  await writeBedClaim(bot, position);
}

async function clearClaimedBed(bot) {
  await writeBedClaim(bot, null);
}

// Direct request, 2026-09-25: "if a bot's bed is destroyed, it should just claim another
// unclaimed bed." A bed is two blocks and a claim may name either half (sleep saved whichever
// block findBlocks returned), so claims are compared against both halves. Vanilla places the head
// one block along `facing` from the foot.
const BED_FACING_STEP = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
function bedHalves(block) {
  const props = block.getProperties?.() || {};
  const [dx, dz] = BED_FACING_STEP[props.facing] || [0, 0];
  if (!dx && !dz) return [block.position];
  const head = props.part === "foot" ? block.position.offset(dx, 0, dz) : block.position;
  return [head, head.offset(-dx, 0, -dz)];
}

// Every OTHER bot's claim, { username, position }.
async function loadOtherBedClaims(bot) {
  return Object.entries(await readBedClaims(bot))
    .filter(([username]) => username !== bot.username)
    .map(([username, position]) => ({ username, position }));
}

function bedClaimant(block, claims) {
  const halves = bedHalves(block);
  return claims.find((c) => halves.some((h) => h.equals(c.position)))?.username || null;
}

// Nearby usable beds, one entry per bed (its head block), nearest to `near` first, each tagged
// with the other bot that has already claimed it (null = unclaimed).
function nearbyBeds(bot, claims, near) {
  const seen = [];
  for (const pos of bot.findBlocks({ matching: (block) => bot.isABed(block), maxDistance: 32, count: 64 })) {
    const block = bot.blockAt(pos);
    if (!block) continue;
    const head = bedHalves(block)[0];
    if (seen.some((b) => b.position.equals(head)) || bedNearHazard(bot, head)) continue;
    seen.push({ position: head, claimant: bedClaimant(block, claims) });
  }
  const origin = near || bot.entity.position;
  return seen.sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin));
}

// Checked periodically by index.js. A claimed bed that's loaded but no longer a bed was destroyed:
// claim the nearest unclaimed bed right away instead of waiting for bedtime, so "home" (lighting,
// surplus storage) moves too. Two bots claiming one bed (a claim race, or legacy claims from
// before this check) is settled deterministically: the lower-sorted name keeps it.
export async function checkClaimedBed(bot) {
  const claimed = await loadClaimedBed(bot);
  if (!claimed) return { status: "none" };
  const block = bot.blockAt(claimed);
  if (!block) return { status: "unloaded" }; // can't see it from here -- don't guess
  const claims = await loadOtherBedClaims(bot);
  let reason;
  if (!bot.isABed(block)) {
    reason = "destroyed";
  } else {
    const rival = bedClaimant(block, claims);
    if (!rival || rival > bot.username) return { status: "ok", position: claimed };
    reason = `also claimed by ${rival}`;
  }
  const next = nearbyBeds(bot, claims, claimed).find((b) => !b.claimant);
  if (!next) {
    await clearClaimedBed(bot);
    console.log(`[beds] ${bot.username}'s bed at ${claimed} is ${reason}; no unclaimed bed nearby, claim cleared.`);
    return { status: "lost", from: claimed, reason };
  }
  await saveClaimedBed(bot, next.position);
  console.log(`[beds] ${bot.username}'s bed at ${claimed} is ${reason}; claimed the bed at ${next.position}.`);
  return { status: "replaced", from: claimed, to: next.position, reason };
}

// Direct request, 2026-09-10 ("write up a plan for that single arbiter..." -> the approved
// per-bot coherence arbiter plan). This function's own real body (the 4 cancel primitives +
// token rotation + sleep-interrupt) now lives in arbiter.js's own cancelAndRotate() -- moved, not
// duplicated, so index.js's reflex handlers (self-defense, the health/breath emergencies, squad
// response, etc.) share the exact same token instead of index.js maintaining its own, separate
// raw setGoal(null) calls that this file's own cancelToken never knew about (the confirmed root
// cause of the recover()-retry bug arbiter.js's own header documents).
//
// Phase 2 addition, real bug caught live while migrating the first reflex handler: if a caller
// already acquired legitimate control via arbiter.requestControl() before calling
// performAction(), this must NOT unconditionally cancelAndRotate() again -- that would
// immediately stomp the caller's own just-acquired token (marking it cancelled, rotating
// `current` out from under it) the instant the caller went on to run its actual action. Reuses
// the already-current token instead whenever one exists; falls back to the original unconditional
// cancel-and-rotate for every NOT-yet-migrated caller (goalTick, runAction, and every routine
// idle-tick check still call performAction() directly with no prior requestControl()), so this
// stays zero behavior change for all of them until their own later migration phases.
//
// 2026-09-24 (review MB-02/MB-04): "reuse whatever token is current" let a PREEMPTED caller's
// stale continuation borrow the new owner's token and act under it (a goal step starting FOLLOW
// mid-emergency). Every caller now passes the handle it acquired; a handle that no longer holds
// control is refused before anything moves, and a handle-less call while someone else owns the
// body is refused too. Only a handle-less call on an idle arbiter takes the legacy
// cancel-and-rotate path. performAction() also normalizes outcomes: any result produced after
// its token was cancelled is reported `{ ok: false, cancelled: true }` -- ~56 branches used to
// return ok("stopped early") on cancellation, which recovery's retry test, goal failure
// counters, skill replay, and skill authoring all read as genuine success.
const LOST_CONTROL = Object.freeze({ ok: false, cancelled: true, text: "something more urgent has control right now." });

export async function performAction(bot, action, speaker, handle = null) {
  const startedAt = Date.now();
  if (handle ? !holdsControl(handle) : isBusy()) return logOutcome(bot, action, startedAt, { ...LOST_CONTROL }, true);
  const alreadyHeld = !!handle;
  const token = handle ? handle.token : cancelAndRotate(bot);
  let result;
  try {
    result = await performActionAs(bot, action, speaker, token);
  } finally {
    // Only release if THIS call acquired (the legacy handle-less path) -- a caller holding a
    // handle owns its own release via handle.release().
    if (!alreadyHeld) releaseControl({ token });
  }
  return logOutcome(bot, action, startedAt, token.cancelled ? { ...result, ok: false, cancelled: true } : result);
}

// Review MB-18 follow-up (2026-09-24): one structured line per action outcome, so triage and
// tests/baseline.mjs count outcomes from data instead of pattern-matching each action's prose.
function logOutcome(bot, action, startedAt, result, refused = false) {
  const why = !result.ok && !result.cancelled && result.text ? { why: String(result.text).slice(0, 100) } : {};
  console.log(`[${bot.username}] OUTCOME ${JSON.stringify({ type: action.type, ok: !!result.ok,
    cancelled: !!result.cancelled, refused, ms: Date.now() - startedAt, ...why })}`);
  return result;
}

// `token` is the caller's live ownership token; nested sub-actions pass it straight through.
async function performActionAs(bot, action, speaker, token) {
  // Direct request, 2026-09-10 (Phase 2 of the approved coherence-arbiter plan). Real bug caught
  // live while migrating the first reflex handler: `current` must actually clear once THIS call
  // is done, for a caller that acquired it here (the common, not-yet-migrated case -- goalTick,
  // runAction, every routine idle-tick check still call performAction() with no prior
  // requestControl()) -- otherwise arbiter.isBusy() would report true forever after the very
  // first action any bot ever runs, permanently short-circuiting stopCurrent()'s own
  // cancel-before-every-new-action behavior for every action after that one. `alreadyHeld`
  // records whether a caller had ALREADY acquired legitimate control (via requestControl(), e.g.
  // checkSelfDefense) before calling in -- if so, releasing here would be wrong: that caller owns
  // release via its own handle.release(), not this function. The try/finally wraps the whole
  // switch below WITHOUT re-indenting it, a deliberate, minimal-diff choice over reformatting
  // ~1400 existing lines for a change that doesn't touch any of their own logic.
  // (2026-09-24: acquisition/release moved to the performAction() wrapper above; this finally
  // is now a no-op kept only to avoid re-indenting the switch.)
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });

  try {
  switch (action.type) {
    case "stop":
      return ok("stopped.");

    case "goto": {
      const target = bot.players[speaker]?.entity;
      if (!target) return fail(`I can't see ${speaker} nearby.`);
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(target, 2)), ACTION_TIMEOUT_MS,
                           () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way.");
        return fail(`couldn't reach ${speaker}: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      return token.cancelled ? ok("stopped on the way.") : ok(`reached ${speaker}.`);
    }

    case "follow": {
      const target = bot.players[speaker]?.entity;
      if (!target) return fail(`I can't see ${speaker} nearby.`);
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); // dynamic: keeps tracking
      return ok(`following ${speaker} now.`);
    }

    case "mine": {
      const blockIds = resolveBlockFamily(bot, action.block);
      if (!blockIds.length) return fail(`I don't recognize the block "${action.block}".`);
      // Direct request, 2026-09-08 ("make sure it is not a functional block like a bed or a
      // furnace... before they dig or destroy a block"). resolveBlockFamily()'s own raw
      // single-name fallback will resolve ANY real block name, functional ones included --
      // checked here, not inside that function, so it stays a pure "does this name exist"
      // resolver and every caller decides for itself what's off-limits.
      if (blockIds.some((id) => isProtectedBlockName(bot.registry.blocks[id]?.name))) {
        return fail(`won't mine ${action.block} -- that's a placed/crafted block, not a raw resource.`);
      }

      // Direct request, 2026-09-08 ("if a resource is in a nearby chest, they should not mine
      // it"). Checks the REAL resulting item (itemNamesForMinedBlocks/MINE_DROPS above), not the
      // block name itself -- a chest holds raw_iron, not iron_ore.
      const chestMatch = await tryTakeFromNearbyChest(bot, token,
        itemNamesForMinedBlocks(bot, blockIds), action.count);
      if (chestMatch) {
        await refreshGear(bot);
        return ok(`found ${chestMatch.count} ${chestMatch.name} already in a chest, no need to mine it.`);
      }

      const wantCount = action.count || 1;
      const findOptions = { matching: blockIds, maxDistance: MINE_SEARCH_RADIUS, count: wantCount * CONTENTION_SEARCH_OVERFETCH };
      let positions = bot.findBlocks(findOptions);
      // Direct request, 2026-09-11 ("each bot uses the global world memory to gather a resource
      // it needs, if it's not in their immediate vicinity"): a remembered position -- her own
      // earlier scan, or another bot's, either written directly or in response to a "scout"
      // broadcast (see index.js's noteNearbyResources()/the "scout" Buzz payload) -- is worth
      // trying BEFORE the blind extended wander below: cheap (one RAG query, no movement) and,
      // when it hits, a direct trip instead of a directionless search. A stale/wrong note just
      // falls through to the exact same wander fallback that already existed, no worse off than
      // before this existed.
      if (!positions.length) {
        const remembered = await findRememberedLocation(action.block).catch(() => null);
        if (remembered) {
          await gotoRememberedSpot(bot, token, remembered);
          positions = bot.findBlocks(findOptions);
        }
      }
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, findOptions);
      if (!positions.length) return fail(`couldn't find any ${action.block} nearby, even after looking around.`);
      positions = filterAwayFromOtherBots(bot, positions).slice(0, wantCount);
      const blocks = positions.map((pos) => bot.blockAt(pos)).filter(Boolean);
      // Report what she actually found/collected, not just the name she was originally given --
      // asked for "oak_log" but the only trees around were spruce, this should say so rather than
      // claiming oak_log when resolveBlockFamily is what actually made that substitution work.
      const collectedNames = [...new Set(blocks.map((b) => b.name))].join(", ");

      // Direct request, 2026-09-07 ("build the water crossing mechanic" -> "do 1,2,4,5" -> a
      // tech-tier check, following external research on how Voyager avoids wasted mining
      // attempts by sequencing wood -> stone -> iron -> diamond tools explicitly instead of
      // letting a model free-associate a target each cycle). Real data, not a hand-typed tier
      // table that could drift from whatever this server's actual version considers correct:
      // block.harvestTools (minecraft-data, confirmed live against this exact server's registry
      // -- e.g. iron_ore requires copper/stone/iron/diamond/netherite pickaxe, gold pickaxe is
      // deliberately absent from that list despite mining faster, matching real vanilla) is
      // undefined for a block with no tool requirement at all (coal/wood need nothing) and a
      // real {itemId: true} lookup otherwise. Checking her whole inventory, not just whatever's
      // currently held, since mineflayer-tool's own equipForBlock() (already wired via
      // mineflayer-collectblock) re-equips the best tool she owns before actually digging --
      // this only needs to answer "does she own ANY tool that would work," not which one.
      const toolReq = blocks[0]?.harvestTools;
      if (toolReq && !bot.inventory.items().some((item) => toolReq[item.type])) {
        const needed = Object.keys(toolReq).map((id) => bot.registry.items[id]?.name).filter(Boolean);
        return fail(`need a better tool for ${collectedNames} -- one of: ${needed.join(", ")}.`);
      }

      try {
        await withTimeout(bot.collectBlock.collect(blocks, { ignoreNoPath: true }), ACTION_TIMEOUT_MS,
                           () => { bot.collectBlock.cancelTask(); bot.stopDigging(); });
      } catch (err) {
        if (token.cancelled) return ok("stopped mining early.");
        return fail(`had trouble mining ${collectedNames}: ${err.message}`);
      } finally {
        if (!token.cancelled) await refreshGear(bot); // may have picked up something worth wearing/wielding
      }
      return token.cancelled ? ok("stopped mining early.") : ok(`collected some ${collectedNames}.`);
    }

    case "explore": {
      // Direct request, 2026-09-08 ("if they can't craft, they should explore, and find
      // resources for later"). For when a specific target isn't known -- CRAFT failed on a
      // missing ingredient with nothing obvious nearby, but there's no one named block worth a
      // dedicated "mine" attempt. Scans broadly for ANY common raw material (every log species,
      // every ore family -- the same real id sets resolveBlockFamily() already resolves for a
      // single request) instead of one target, reusing the same directed extended-search
      // wandering wanderAndRetryFind() already relies on for "mine." Gathers a full batch of
      // whatever's found first, not just enough for right now -- the travel is the real cost
      // here, not the extra inventory slots, so "find resources for later" means actually
      // stockpiling while she's already out looking, not just solving today's shortage.
      // Review MB-16, 2026-09-24: EXPLORE used to succeed on the spot whenever a nearby chest held
      // any common resource -- Wade could "explore" by withdrawing home stock, and a "find a
      // village" goal was satisfied by a stocked chest. Chest withdrawal is LOOT's job, so that
      // shortcut is gone. `action.feature` (EXPLORE <feature>) is a separate scouting mode that
      // only succeeds when a block unique to that feature is actually found.
      if (action.feature) {
        const featureBlocks = SCOUT_FEATURE_BLOCKS[action.feature];
        if (!featureBlocks) return fail(`don't know how to recognize a ${action.feature}.`);
        const ids = featureBlocks.map((name) => bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined);
        const scoutOptions = { matching: ids, maxDistance: EXPLORE_SEARCH_RADIUS * 2, count: 1 };
        let found = bot.findBlocks(scoutOptions);
        if (!found.length) found = await wanderAndRetryFind(bot, token, scoutOptions);
        if (token.cancelled) return ok("stopped scouting early.");
        if (!found.length) return fail(`scouted around but found no sign of a ${action.feature}.`);
        const at = found[0].floored?.() ?? found[0];
        return ok(`found a ${action.feature} (${bot.blockAt(found[0])?.name ?? "landmark"} at ${at.x}, ${at.y}, ${at.z})`);
      }

      const blockIds = getResourceBlockNames(bot)
        .map((name) => bot.registry.blocksByName[name]?.id)
        .filter((id) => id !== undefined);

      const EXPLORE_BATCH_COUNT = 8;

      const findOptions = { matching: blockIds, maxDistance: EXPLORE_SEARCH_RADIUS, count: EXPLORE_BATCH_COUNT * CONTENTION_SEARCH_OVERFETCH };
      let positions = bot.findBlocks(findOptions);
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, findOptions);
      if (!positions.length) return fail("didn't find anything useful nearby, even after looking around.");
      positions = filterAwayFromOtherBots(bot, positions).slice(0, EXPLORE_BATCH_COUNT);
      const blocks = positions.map((pos) => bot.blockAt(pos)).filter(Boolean);
      const collectedNames = [...new Set(blocks.map((b) => b.name))].join(", ");

      // Same tool-tier gate "mine" already applies -- no point starting a collect on ore she
      // can't yet break, same real block.harvestTools data.
      const toolReq = blocks[0]?.harvestTools;
      if (toolReq && !bot.inventory.items().some((item) => toolReq[item.type])) {
        return fail(`found ${collectedNames} but don't have a good enough tool for it yet.`);
      }

      try {
        await withTimeout(bot.collectBlock.collect(blocks, { ignoreNoPath: true }), ACTION_TIMEOUT_MS,
                           () => { bot.collectBlock.cancelTask(); bot.stopDigging(); });
      } catch (err) {
        if (token.cancelled) return ok("stopped exploring early.");
        return fail(`found ${collectedNames} but had trouble gathering it: ${err.message}`);
      } finally {
        if (!token.cancelled) await refreshGear(bot);
      }
      return token.cancelled ? ok("stopped exploring early.") : ok(`explored and found some ${collectedNames}.`);
    }

    case "craft": {
      const itemDef = bot.registry.itemsByName[action.item];
      if (!itemDef) return fail(`I don't recognize the item "${action.item}".`);

      // Direct report, 2026-09-08 ("they keep creating crafting tables, even when there is a
      // number of them nearby"). Real gap: the "does this need a table" check just below only
      // ever asks whether crafting THIS item needs a DIFFERENT existing table/furnace as a
      // station -- crafting_table's own recipe needs no table at all (4 planks, fits the
      // personal 2x2 grid), so that check always says "no" for it and falls straight through to
      // making a brand new one, never once checking whether an instance of what she's ABOUT TO
      // MAKE already exists in reach. Same real gap applies to furnace (also craftable without a
      // table, also commonly over-made). Reusable utility blocks -- unlike a personal tool or a
      // piece of armor, there's no reason to own a SECOND one when the first is right there.
      const REUSABLE_UTILITY_BLOCKS = ["crafting_table", "furnace"];
      if (REUSABLE_UTILITY_BLOCKS.includes(action.item)) {
        const existingType = bot.registry.blocksByName[action.item];
        const existing = existingType ? bot.findBlocks({ matching: existingType.id, maxDistance: 32, count: 1 }) : [];
        if (existing.length) {
          return ok(`already have a ${action.item} nearby, no need to make another.`);
        }
      }

      // Direct request, 2026-09-08 ("the duplicate crafting check should be for all resources as
      // well as utilities like crafting tables"). Generalizes the check above beyond just
      // crafting_table/furnace (placed WORLD blocks) to any item at all, checked against nearby
      // CHESTS instead -- no reason to spend raw materials crafting something that's already
      // sitting in a container within reach. gearCategoryNames() (2026-09-18) broadens this to
      // ANY tier of the same equipment when action.item is gear -- a chest with an iron_pickaxe
      // satisfies a "craft wooden_pickaxe" goal just as well, no reason to craft (or overlook)
      // one just because it's not the exact material she happened to name.
      const chestMatch = await tryTakeFromNearbyChest(bot, token,
        gearCategoryNames(bot, action.item), action.count);
      if (chestMatch) {
        await refreshGear(bot);
        return ok(`found ${chestMatch.count} ${chestMatch.name} already in a chest, no need to craft it.`);
      }

      // Does this need a table? `true` satisfies recipesFor()'s own requiresTable check
      // without needing a real Block reference yet -- confirmed against mineflayer's own
      // craft.js source -- this is only checking whether a table would help, not using one.
      const noTableRecipes = bot.recipesFor(itemDef.id, null, 1, null);
      const tableWouldHelp = !noTableRecipes.length && bot.recipesFor(itemDef.id, null, 1, true).length > 0;
      let tableBlock = null;
      if (tableWouldHelp) {
        const tableType = bot.registry.blocksByName.crafting_table;
        let positions = tableType ? bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }) : [];
        // Direct request, 2026-09-13 ("extend resource sharing memory and scouting to *any*
        // resource or crafted object"): same local-search-first-remembered-location-second
        // pattern "mine" already uses -- a crafting table someone else placed (or one this bot
        // saw earlier and wandered away from) is exactly as worth remembering as an iron vein.
        if (!positions.length) {
          const remembered = await findRememberedLocation("crafting_table").catch(() => null);
          if (remembered) {
            await gotoRememberedSpot(bot, token, remembered);
            positions = tableType ? bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }) : [];
          }
        }
        if (!positions.length) return fail(`need a crafting table nearby for ${action.item}.`);
        tableBlock = bot.blockAt(positions[0]);
        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(tableBlock.position.x,
            tableBlock.position.y, tableBlock.position.z, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
        } catch (err) {
          if (token.cancelled) return ok("stopped on the way to a crafting table.");
          return fail(`couldn't reach a crafting table: ${err.message}`);
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) return ok("stopped on the way to a crafting table.");
      }

      try {
        await craftItem(bot, action.item, action.count, tableBlock);
      } catch (err) {
        return fail(`couldn't craft ${action.item}: ${err.message}`);
      } finally {
        if (!token.cancelled) await refreshGear(bot); // a freshly-crafted tool/weapon/armor piece should get equipped
        // Direct request, 2026-09-17 ("if they craft armor or weapons or tools, they should
        // equip them"): refreshGear's own equipBestArmor/equipBestWeapon already cover armor and
        // sword/axe-class weapons (this comment's own claim above was only ever half true) -- but
        // pickaxe/shovel/hoe aren't weapon-classed, so a freshly-crafted mining/digging/farming
        // tool just sat unequipped in inventory until some later action happened to reach for
        // one. Equips the SPECIFIC item just crafted, not a tier comparison against whatever's
        // already held -- she made it on purpose, presumably to use it soon. See "attack"'s own
        // 2026-09-17 note for why holding a tool instead of a weapon right after this is safe:
        // combat now re-equips the best weapon for itself before engaging, regardless of what
        // was held a moment before.
        const TOOL_SUFFIXES = ["_pickaxe", "_shovel", "_hoe"];
        if (TOOL_SUFFIXES.some((s) => action.item.endsWith(s))) {
          const freshTool = bot.inventory.items().find((i) => i.name === action.item);
          if (freshTool) {
            try {
              await bot.equip(freshTool, "hand");
            } catch (err) {
              console.error(`craft: failed to equip freshly-crafted ${action.item}:`, err.message);
            }
          }
        }
      }
      return ok(`crafted ${action.count} ${action.item}.`);
    }

    case "loot": {
      const chestType = bot.registry.blocksByName.chest;
      const trappedType = bot.registry.blocksByName.trapped_chest;
      const matchIds = [chestType?.id, trappedType?.id].filter((id) => id !== undefined);
      if (!matchIds.length) return fail("don't know how to recognize a chest here.");
      // Real gap found live (2026-09-07): this used to fetch only the single NEAREST chest --
      // if that one chest is permanently obstructed or otherwise unopenable, findBlocks(count:1)
      // deterministically returns the exact same bad chest on every future attempt, and the bot
      // can never loot ANYTHING again even with dozens of other chests nearby. Now tries up to
      // MAX_CANDIDATES in distance order, skipping to the next on any per-chest failure
      // (obstructed, unreachable, won't open) instead of giving up after the first one.
      const MAX_CANDIDATES = 3;
      const lootFindOptions = { matching: matchIds, maxDistance: 32, count: MAX_CANDIDATES };
      let positions = bot.findBlocks(lootFindOptions);
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, lootFindOptions);
      if (!positions.length) return fail("couldn't find any chests nearby, even after looking around.");

      // Direct request, 2026-09-17 ("they loot EVERYTHING instead of what they need... take only
      // the mats they need"): this used to sweep every stack in the chest (capped at one per
      // distinct tool, otherwise a full stack) regardless of whether any of it was actually
      // wanted. Now genuinely need-based: action.item names exactly what she's after, reusing
      // tryTakeFromThisChest -- the SAME open/withdraw/snapshot helper "mine"/"craft"'s own
      // chest-first fallback already relies on, so there is only ever one implementation of
      // "take up to <count> of <item> from a chest," not two that could quietly drift apart.
      if (action.item) {
        const group = LOOT_GROUPS[action.item]; // "food", "seeds" (2026-09-25)
        if (!group && !bot.registry.itemsByName[action.item]) return fail(`I don't recognize the item "${action.item}".`);
        // gearCategoryNames() (2026-09-18, "pick up ONE of those pieces... and abandon the quest
        // to craft it"): broadens an equipment request to ANY tier of the same category, not
        // just the exact material she named -- a chest's diamond_pickaxe satisfies "LOOT
        // wooden_pickaxe" just as well.
        const wantedNames = group || gearCategoryNames(bot, action.item);
        let sawObstruction = false;
        for (const pos of positions) {
          if (token.cancelled) return ok("stopped on the way to a chest.");
          const chestBlock = bot.blockAt(pos);
          if (!chestBlock) continue;
          if (chestObstructed(bot, chestBlock)) { sawObstruction = true; continue; }
          const result = await tryTakeFromThisChest(bot, token, chestBlock, wantedNames, action.count);
          if (result === "cancelled") return ok("stopped on the way to a chest.");
          if (result) {
            await refreshGear(bot);
            return ok(`found ${result.count} ${result.name} in a chest.`);
          }
          // else: reachable and openable, just didn't have any -- try the next local candidate
        }
        // Local search came up empty for this specific item -- consult the shared known-chests
        // registry (same "local first, remembered second" pattern tryTakeFromNearbyChest's own
        // callers already use for MINE/CRAFT's chest-first fallback) before giving up outright.
        // findKnownChestWithItem() only ever checks one exact name per call (unlike
        // tryTakeFromThisChest's own array-of-names shape), so a gear-broadened search means
        // trying each real tier name in turn -- same loop shape tryTakeFromNearbyChest's own
        // remembered-chest fallback already uses for exactly this reason.
        let known = null;
        for (const name of wantedNames) {
          known = await findKnownChestWithItem(bot, name, action.count);
          if (known) break;
        }
        if (known && !token.cancelled) {
          try {
            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(known.position.x,
              known.position.y, known.position.z, 3)), ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
            const chestBlock = bot.blockAt(known.position);
            if (chestBlock && !chestObstructed(bot, chestBlock)) {
              const result = await tryTakeFromThisChest(bot, token, chestBlock, wantedNames, action.count);
              if (result === "cancelled") return ok("stopped on the way to a chest.");
              if (result) {
                await refreshGear(bot);
                return ok(`found ${result.count} ${result.name} in a remembered chest.`);
              }
            }
          } catch {
            // couldn't reach the remembered chest -- fall through to the normal failure below
          } finally {
            if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
          }
        }
        return fail(sawObstruction
          ? `found chests nearby, but they're all obstructed, and no remembered chest has ${action.item} either.`
          : `checked nearby chests, no ${action.item} in any of them.`);
      }

      // No item named -- this is a plain inspection, not a withdrawal: open the nearest reachable
      // chest, snapshot its real contents into known_chests.json for the whole fleet to see
      // (§19/§27's own "remembering and redacting are the same operation" design), and take
      // nothing. This is now the ONLY case that opens a chest without a specific target in mind.
      let sawObstruction = false;
      for (const pos of positions) {
        if (token.cancelled) return ok("stopped on the way to a chest.");
        const chestBlock = bot.blockAt(pos);
        if (!chestBlock) continue;
        if (chestObstructed(bot, chestBlock)) { sawObstruction = true; continue; }

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
            chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
        } catch (err) {
          if (token.cancelled) return ok("stopped on the way to a chest.");
          continue; // couldn't reach this one -- try the next candidate
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) return ok("stopped on the way to a chest.");

        try {
          const chest = await bot.openChest(chestBlock);
          // Real bug found live (2026-09-06): Window.items() returns itemsRange(inventoryStart,
          // inventoryEnd) -- the PLAYER'S OWN inventory slots within the combined window, not the
          // container's. containerItems() (itemsRange(0, inventoryStart)) is the actual
          // container-only view.
          const contents = chest.containerItems();
          console.log(`[loot] chest contents: ${contents.map((i) => `${i.name}x${i.count}`).join(", ") || "(empty)"}`);
          await recordChestSnapshot(chestBlock.position, contents);
          await chest.close();
          return ok(contents.length
            ? `checked a chest -- has ${contents.map((i) => `${i.count} ${i.name}`).join(", ")}.`
            : "checked a chest, it's empty.");
        } catch (err) {
          continue; // couldn't open this one (e.g. windowOpen timeout) -- try the next candidate
        }
      }
      return fail(sawObstruction
        ? "found chests nearby, but they're all obstructed."
        : "found chests nearby, but couldn't reach or open any of them.");
    }

    case "attack": {
      // Real live bug, 2026-09-08: checkSelfDefense() already finds a specific real entity
      // (nearestHostile(bot, SELF_DEFENSE_RANGE)) before calling here -- re-deriving it a second
      // time via a fresh nearestHostile(bot) call raced against that exact entity moving out of
      // range or despawning in the gap between detection and this call (checkSelfDefense's own
      // force-cancel-then-wait sequence can take up to 3s). Confirmed live: Mark spammed "threat
      // detected" -> "no hostile mobs nearby" every 2s for 90+ seconds straight, never landing a
      // single hit, because the second lookup kept missing what the first one had already found.
      // action.target (when a caller already has the real entity in hand) is now used directly,
      // no re-derivation -- goal-directed callers with no known entity still fall back to a fresh
      // search exactly as before.
      const target = action.target || nearestHostile(bot);
      if (!target) return fail("no hostile mobs nearby.");
      // Direct request, 2026-09-17 ("if they craft armor or weapons or tools, they should equip
      // them"): a real gap this surfaced -- nothing here ever re-equipped a weapon before
      // engaging, only refreshGear() in the finally block AFTER the fight ends ("mob drops may
      // include something worth wearing/wielding"). Combat has always just used whatever
      // happened to already be held, and now that a freshly-crafted tool deliberately stays held
      // after "craft" (this same file's own new note there), a bot could otherwise walk into a
      // fight holding a pickaxe. equipBestWeapon() here guarantees combat always starts
      // weapon-in-hand regardless of what was held a moment before, whether that's a fresh tool,
      // a fishing rod, or held food.
      await equipBestWeapon(bot);
      // Real gap found by reading mineflayer-pvp's own source (PVP.js), 2026-09-07: it already
      // fully automates shield use during combat -- blocking a creeper's explosion, and an
      // active-block-then-attack cadence on every swing (hasShield()/checkExplosion()/
      // attemptAttack()) -- but ALL of it is conditional on a shield already sitting in the
      // off-hand slot, which nothing in this codebase ever put there. Equipping one here (if
      // she's carrying one) is the entire fix; everything downstream is already handled
      // internally with no further changes needed.
      const shield = bot.inventory.items().find((i) => i.name.includes("shield"));
      const offHandSlot = bot.getEquipmentDestSlot("off-hand");
      if (shield && bot.inventory.slots[offHandSlot]?.name !== shield.name) {
        try {
          await bot.equip(shield, "off-hand");
        } catch (err) {
          console.error("attack: failed to equip shield:", err.message);
        }
      }
      // Real live bug found 2026-09-10 (direct report: "they're still not fighting back or
      // running"), confirmed by reading the actually-installed mineflayer-pvp 1.3.2 source
      // (lib/PVP.js) directly: the comment this replaces was WRONG for this version --
      // bot.pvp.attack() does NOT wait for the target to die or be lost. It only sets
      // this.target and a fresh pathfinder GoalFollow, then returns almost immediately; the real
      // attacking (chase + swing) runs separately, forever, off the library's own internal
      // physicTick listener.
      //
      // A FIRST fix attempt (waiting on the library's own 'stoppedAttacking' event instead) was
      // ALSO wrong, confirmed live a second time: that event fires for ANY stop() call, including
      // arbiter.js's own cancelPhysical() -- called unconditionally and fire-and-forget at the top
      // of every requestControl() acquisition, even a same-owner reacquisition against the SAME
      // still-alive target. That prior cycle's own cleanup stop() was still asynchronously
      // in-flight (it awaits the pathfinder's own 'path_stop' event internally) when this fight's
      // fresh listener attached a moment later, so its STALE emission -- completely unrelated to
      // this fight -- was mistaken for "the fight just ended," reproducing the exact same
      // instant-"took care of it" symptom as the original bug.
      //
      // Polling the target's own real, unambiguous state -- is it still a tracked entity at all --
      // sidesteps both promises entirely, matching the "don't infer from a shared/ambiguous event"
      // approach every OTHER cancellable action in this file already uses (token.cancelled checked
      // directly against real pathfinder/collectBlock rejection, never guessed at). Also aborts
      // promptly on a genuine higher-priority preemption (token.cancelled) rather than only on the
      // full ACTION_TIMEOUT_MS ceiling.
      // Direct request, 2026-09-21 ("re-evaluate the entire defense scheme"), root-caused from a
      // live mass-death incident: EMERGENCY-tier combat (bot.on("health"), index.js) commits to
      // "attack" unconditionally once health is critical, with no way to reconsider if the fight
      // simply isn't going well -- and until now that meant riding out the FULL ACTION_TIMEOUT_MS
      // (90s) with nothing able to preempt it (HEALTH_CRITICAL sits above every other tier except
      // the cancel-only TELEPORT_HOME). Confirmed live: Wade logged "yielded to (HEALTH_CRITICAL)"
      // for over 20 straight seconds -- a single stuck emergency attack holding control that whole
      // time while he stayed at critical health with no way out. `action.maxDurationMs` lets a
      // caller give a MUCH shorter leash for exactly this situation (see index.js's own EMERGENCY
      // handler, which now bails to flee if this returns non-ok) -- defaults to the normal
      // ACTION_TIMEOUT_MS for every other caller, unchanged.
      //
      // Review MB-01, 2026-09-24: the 1.42.0 rewrite above replaced
      // `await withTimeout(bot.pvp.attack(target), ...)` with the polling loop below but dropped
      // the bot.pvp.attack() call itself -- nothing started the chase-and-swing, so every fight
      // since 2026-09-10 just waited out its timer (the root of 2.86.0-2.88.0's "they just stand
      // there" reports). attack() is started here, fire-and-forget (it resolves once the chase is
      // set up), and re-issued if the library drops the target while it still exists. A kill is
      // now only claimed on the server's own entityDead status for THIS target; the entity merely
      // unloading (out of range, despawned) is reported as losing track, not a kill.
      const FIGHT_POLL_MS = 250;
      const deadline = Date.now() + (action.maxDurationMs ?? ACTION_TIMEOUT_MS);
      let killed = false;
      const onDead = (entity) => { if (entity?.id === target.id) killed = true; };
      const startAttack = () => {
        Promise.resolve(bot.pvp.attack(target))
          .catch((err) => console.error("attack: pvp.attack failed:", err.message));
      };
      bot.on("entityDead", onDead);
      try {
        if (!token.cancelled) startAttack();
        while (!killed && bot.entities[target.id] && !token.cancelled && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, FIGHT_POLL_MS));
          if (!killed && !token.cancelled && bot.entities[target.id] && bot.pvp.target !== target) startAttack();
        }
      } finally {
        bot.removeListener("entityDead", onDead);
        // A preemptor's own cancelPhysical() already stopped PvP; only the owner cleans up.
        if (!token.cancelled) {
          if (bot.pvp.target) bot.pvp.stop();
          await refreshGear(bot); // mob drops may include something worth wearing/wielding
        }
      }
      if (token.cancelled) return ok("broke off the fight.");
      if (killed) return ok("took care of it.");
      if (!bot.entities[target.id]) return fail("lost track of it.");
      return fail("gave up on the fight -- took too long.");
    }

    case "flee": {
      // Fourth of five scoped enhancements ("what other logic enhancements are available" ->
      // self-defense). GoalInvert negates the wrapped goal's heuristic, so pathfinder actively
      // maximizes distance from the threat instead of closing it -- confirmed against
      // mineflayer-pathfinder's own goals.js (heuristic() returns -goal.heuristic(); isEnd()
      // returns !goal.isEnd(), so the flee goal is "reached" once genuinely outside the wrapped
      // GoalFollow's own radius, not an arbitrary duration this code has to guess at).
      // Same fix as "attack" above -- use the already-found entity when the caller has one
      // instead of racing a second nearestHostile(bot) lookup against it moving/despawning.
      const target = action.target || nearestHostile(bot);
      if (!target) return ok("nothing to flee from.");
      // Direct request, 2026-09-18 ("run towards safety, run towards golems, or soldiers"):
      // index.js's checkSelfDefense/checkSleepingThreat/respondToSquadCall compute this (golem >
      // nearby Soldier teammate > home, in that priority -- see their own nearestRallyPoint())
      // since they're the ones with role/teammate-position knowledge; this action just heads
      // there instead of blindly maximizing distance with no destination in mind. Deliberately no
      // path-safety check between here and the rally point (same best-effort level as the rest of
      // self-defense) -- a rally point is only ever picked when it's a real place to go, not a
      // guarantee the route there is threat-free.
      const rally = action.rallyPoint;
      // Direct live observation, 2026-09-21 ("none of them fight back including the soldiers...
      // if the bots are inside a building with a zombie, they seem to act as if they are
      // trapped"). Root-caused live: fleeing shares the same canDig-enabled Movements every
      // other action uses (never explicitly set, so it's at mineflayer-pathfinder's own
      // default). In a small enclosed room, the only path that "increases distance" can require
      // digging through a wall -- when that dig fails, pathfinder recomputes the IDENTICAL
      // best-cost path (same dig step) and fails again immediately, forever: confirmed live via
      // path_reset: dig_error firing dozens of times a SECOND with an unchanged nodes/cost
      // signature, holding control the whole time while she's still being hit and (critically,
      // this is EMERGENCY/self-defense's own flee, which never attacks) never fights back
      // either. Disabling digging for just this one pathfind forces pathfinder to either find a
      // real walkable escape route or fail cleanly and fast, instead of spinning on an
      // impossible one until death.
      // Review MB-02 follow-up (2026-09-24): flee used to flip canDig on the ONE Movements object
      // every owner shares and restore it in finally -- after a preemption that restore landed in
      // the middle of the new owner's route. Flee now runs on its own shallow copy and only puts
      // the original back if its copy is still the active one.
      const sharedMovements = bot.pathfinder.movements;
      const fleeMovements = Object.assign(Object.create(Object.getPrototypeOf(sharedMovements)), sharedMovements);
      fleeMovements.canDig = false;
      bot.pathfinder.setMovements(fleeMovements);
      try {
        const goal = rally
          ? new goals.GoalNear(rally.x, rally.y, rally.z, 3)
          : new goals.GoalInvert(new goals.GoalFollow(target, 16));
        await withTimeout(bot.pathfinder.goto(goal), ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped fleeing.");
        return fail(`couldn't get away: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        if (bot.pathfinder.movements === fleeMovements) bot.pathfinder.setMovements(sharedMovements);
      }
      if (token.cancelled) return ok("stopped fleeing.");
      return ok(rally ? "made it to safety." : "got some distance from it.");
    }

    case "eat": {
      // Direct request, 2026-09-07: hunger management. Built on mineflayer's own core
      // consume() (confirmed against inventory.js source: requires the food already equipped
      // to hand -- bot.equip() first, the same pattern already used for fuel/tools elsewhere in
      // this file).
      // Review MB-15: best-first by FOOD_NAMES order (cooked before raw), golden apples saved for last
      // -- not whatever inventory slot happens to come first.
      const eatRank = (name) => (name.includes("golden_apple") ? 1000 : 0) + FOOD_NAMES.indexOf(name);
      const foodItem = bot.inventory.items().filter((i) => FOOD_NAMES.includes(i.name))
        .sort((a, b) => eatRank(a.name) - eatRank(b.name))[0];
      if (!foodItem) return fail("don't have anything to eat.");
      try {
        await bot.equip(foodItem, "hand");
        await bot.consume();
      } catch (err) {
        return fail(`couldn't eat: ${err.message}`);
      } finally {
        if (!token.cancelled) await refreshGear(bot); // consume() leaves the food item held -- get a real weapon back
      }
      return ok(`ate some ${foodItem.name}.`);
    }

    case "fish": {
      // Direct request, 2026-09-07 ("do 1-3" -> "and 4"): a passive, low-risk food source for
      // when there's no food on hand and no crops/animals nearby to harvest/breed. Built on
      // mineflayer's own core fish() (confirmed against fishing.js source: casts via
      // activateItem(), waits for the real bobber-splash particle event, then reels in itself --
      // no dedicated timing guess needed). fish() only resolves on an actual bite; it has no
      // built-in timeout of its own, so like every other open-ended wait in this file it's
      // wrapped in withTimeout, whose onTimeout calls activateItem() a second time to reel in
      // and cancel cleanly (confirmed: this is exactly how a real player aborts a cast, and the
      // plugin's own entity_destroy handler treats it as a clean cancellation, not an error).
      const rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
      if (!rod) return fail("don't have a fishing rod.");

      const waterType = bot.registry.blocksByName.water;
      if (!waterType) return fail("don't know how to recognize water here.");
      let positions = bot.findBlocks({ matching: waterType.id, maxDistance: 32, count: 5 });
      if (!positions.length) positions = await wanderAndRetryFind(bot, token,
        { matching: waterType.id, maxDistance: 32, count: 5 });
      if (!positions.length) return fail("couldn't find any water nearby, even after looking around.");
      const waterPos = positions[0];

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(waterPos.x, waterPos.y, waterPos.z, 3)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way to the water.");
        return fail(`couldn't reach the water: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped on the way to the water.");

      try {
        await bot.equip(rod, "hand");
        await bot.lookAt(waterPos.offset(0.5, 1, 0.5));
        await withTimeout(bot.fish(), FISH_TIMEOUT_MS, () => bot.activateItem());
      } catch (err) {
        if (token.cancelled) return ok("stopped fishing.");
        return fail(`fishing didn't pan out: ${err.message}`);
      } finally {
        if (!token.cancelled) await refreshGear(bot); // fish() leaves the rod held -- get a real weapon back
      }
      return ok("caught something.");
    }

    case "give": {
      // Direct request, 2026-09-07: bot-to-bot help. General enough to also work for a human
      // asking directly ("give me some bread") -- classifyIntent resolves the target to the
      // speaker for that case; the autonomous cross-bot request flow (index.js) names the other
      // bot's real in-game username explicitly. Built on mineflayer's own core toss() (drops the
      // item at her own feet -- confirmed against simple_inventory.js source -- so she has to
      // actually be standing next to the recipient first for it to be picked up, same
      // path-then-act pattern as every other action here).
      const target = bot.players[action.player]?.entity;
      if (!target) return fail(`I can't see ${action.player} nearby.`);
      const itemDef = bot.registry.itemsByName[action.item];
      if (!itemDef) return fail(`I don't recognize the item "${action.item}".`);
      const have = bot.inventory.count(itemDef.id, null);
      if (!have) return fail(`don't have any ${action.item} to give.`);
      const giveCount = Math.min(action.count, have);

      // Direct request, 2026-09-19 ("Mayor/Leader missions, if they would effectively DOWNGRADE a
      // bot's equipment or status, should be rejected by the bot"). Real, already-confirmed
      // failure shape (§34/MINECRAFT_BOTS_DESIGN.md): Mark was gifted a sword twice by teammates
      // responding to a request, yet a give this blind can just as easily strip the GIVER bare --
      // "give" never checked whether complying would leave her without a weapon/armor/tool she
      // still needs, whoever asked. Sword and axe are treated as one interchangeable "weapon"
      // category (matching equipment.js's own hasWeapon() definition); armor/tool suffixes are
      // each their own category (a spare pickaxe doesn't cover for giving away her only shovel).
      //
      // Direct follow-up, 2026-09-19 ("must also reject if... the quality of their equipment
      // [would be] reduced"): going to zero was only half of it -- giving away her BEST piece in
      // a category while a worse one stays behind is a downgrade too, even though she'd technically
      // "still have one." Checks the highest GEAR_TIER_RANK she'd be left with in this exact
      // category against the tier of what's being given away.
      const giveSuffix = GEAR_SUFFIXES.find((s) => action.item.endsWith(s));
      if (giveSuffix) {
        const isWeapon = giveSuffix === "_sword" || giveSuffix === "_axe";
        const category = isWeapon ? ["_sword", "_axe"] : [giveSuffix];
        const categoryItems = bot.inventory.items().filter((i) => category.some((s) => i.name.endsWith(s)));
        const totalOfCategory = categoryItems.reduce((sum, i) => sum + i.count, 0);
        const remainingAfterGive = totalOfCategory - giveCount;

        const givingSuffix = category.find((s) => action.item.endsWith(s));
        const givingTier = gearTierRank(action.item, givingSuffix);
        const bestRemainingTier = categoryItems.reduce((best, i) => {
          const remaining = i.name === action.item ? i.count - giveCount : i.count;
          if (remaining <= 0) return best;
          const s = category.find((suf) => i.name.endsWith(suf));
          return Math.max(best, gearTierRank(i.name, s));
        }, -1);

        const wouldZeroOut = remainingAfterGive <= 0;
        const wouldDowngradeQuality = !wouldZeroOut && givingTier >= 0 && givingTier > bestRemainingTier;
        if (wouldZeroOut || wouldDowngradeQuality) {
          const label = isWeapon ? "weapon" : giveSuffix.slice(1);
          const reason = wouldZeroOut ? `that's my only ${label}`
            : `it's my best ${label} and I'd be left with a worse one`;
          return fail(`won't give away my ${action.item} -- ${reason}, and that would leave me ` +
            `worse off than before.`);
        }
      }

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(target, 2)), ACTION_TIMEOUT_MS,
          () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way.");
        return fail(`couldn't reach ${action.player}: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped on the way.");

      try {
        await bot.toss(itemDef.id, null, giveCount);
      } catch (err) {
        return fail(`couldn't give the ${action.item}: ${err.message}`);
      }
      return ok(`gave ${giveCount} ${action.item} to ${action.player}.`);
    }

    case "gohome": {
      // Direct request, 2026-09-07: "bots should pay attention to the time of day, and try to
      // return 'home' before full dark." bot.spawnPoint (confirmed against mineflayer's own
      // spawn_point.js source: populated from the server's own spawn_position packet -- her bed
      // if she's claimed one, otherwise the world spawn) is the same real "home" reference the
      // teleport-when-stuck mechanism already uses -- one shared notion of home, not a second one.
      const dest = bot.spawnPoint;
      if (!dest || (dest.x === 0 && dest.y === 0 && dest.z === 0)) {
        return fail("don't know where home is yet.");
      }
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 3)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped heading home.");
        // Direct request, 2026-09-07 ("build the water crossing mechanic"): a normal walking
        // route failing (timeout/no-path) is exactly the shape water-blocked routes take --
        // worth one real attempt at a boat crossing before giving up outright, rather than
        // stranding her every dusk a lake happens to sit between here and spawn.
        if (await attemptBoatCrossing(bot, token, dest)) {
          try {
            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 3)),
              ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
            return ok("made it home before dark (by boat).");
          } catch {
            return ok("got most of the way home by boat, on foot from here.");
          } finally {
            if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
          }
        }
        return fail(`couldn't make it home: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      return token.cancelled ? ok("stopped heading home.") : ok("made it home before dark.");
    }

    case "sleep": {
      // Direct request, 2026-09-07: bots should know to go to bed at night. Built entirely on
      // mineflayer's own bed.js plugin (core, no extra plugin load needed) -- bot.sleep()
      // already handles the real vanilla rules (night-or-thunderstorm window, occupied bed,
      // monsters nearby, reach distance) and throws a specific reason for each, so this only
      // needs to find a bed and try it, same multi-candidate pattern as "loot" (1.8.2) since one
      // bad bed (occupied, monsters nearby right there) shouldn't block trying another.
      if (bot.isSleeping) return ok("already asleep.");
      const MAX_CANDIDATES = 3;

      // Direct follow-up to "what other autonomous behaviors are solvable" -> "fix all the
      // above": bed ownership. Real gap: every bot re-ran the SAME "nearest N beds" search every
      // single night with zero memory of what worked before -- on a shared map with fewer beds
      // than bots, several would converge on the same nearest bed the same night, only one
      // succeeding (bot.sleep()'s own real "occupied" rejection was already caught and skipped
      // below, so this never crashed anything, just wasted a travel-then-fail cycle for whoever
      // lost the race). Persists whichever bed actually worked last time (one small per-bot file,
      // same hermes-data-mount-backed pattern skills.js's SKILLS_DIR already uses) and tries that
      // SPECIFIC position FIRST, ahead of the normal broad search -- a bot that already has a
      // working bed stops competing for "nearest" every night and just goes home, only falling
      // back to the broad candidate list if her own bed is gone, occupied, or unreachable.
      // 2026-09-25: a destroyed claim is replaced with an unclaimed bed first (checkClaimedBed),
      // then candidates are one per bed (both halves used to fill two of the 3 slots): her own,
      // then unclaimed beds, and other bots' claimed beds only as a last resort, never re-claimed.
      await checkClaimedBed(bot);
      const claimed = await loadClaimedBed(bot);
      const claimedBlock = claimed && bot.blockAt(claimed);
      const candidates = claimedBlock && bot.isABed(claimedBlock) && !bedNearHazard(bot, claimed)
        ? [{ position: bedHalves(claimedBlock)[0], claimant: null }] : [];
      const beds = nearbyBeds(bot, await loadOtherBedClaims(bot), null)
        .filter((b) => !candidates.some((c) => c.position.equals(b.position)));
      candidates.push(...beds.filter((b) => !b.claimant), ...beds.filter((b) => b.claimant));
      candidates.length = Math.min(candidates.length, MAX_CANDIDATES);
      if (!candidates.length) return fail("couldn't find a bed nearby.");

      for (const { position: pos, claimant } of candidates) {
        if (token.cancelled) return ok("stopped on the way to bed.");
        const bedBlock = bot.blockAt(pos);
        if (!bedBlock) continue;
        if (bedNearHazard(bot, bedBlock.position)) {
          console.log(`[sleep] skipping bed at ${bedBlock.position}: water/lava nearby.`);
          continue; // a bad bed to bond her respawn point to -- try the next candidate
        }

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x,
            bedBlock.position.y, bedBlock.position.z, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
        } catch (err) {
          if (token.cancelled) return ok("stopped on the way to bed.");
          // Real gap found live (2026-09-07): this used to swallow the reason silently -- when
          // every candidate failed, the only visible result was "couldn't use any of them,"
          // giving no way to diagnose why after the fact. Logging each per-candidate reason now,
          // same lesson already learned once today for the goal loop's own transitions.
          console.log(`[sleep] couldn't reach bed at ${bedBlock.position}: ${err.message}`);
          continue; // couldn't reach this bed -- try the next candidate
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) return ok("stopped on the way to bed.");

        try {
          await bot.sleep(bedBlock);
        } catch (err) {
          console.log(`[sleep] couldn't use bed at ${bedBlock.position}: ${err.message}`);
          continue; // this bed didn't work (occupied, monsters nearby, too far, etc) -- try next
        }
        // This bed worked -- go straight back to it next time, unless it's another bot's.
        if (!claimant) await saveClaimedBed(bot, bedHalves(bedBlock)[0]);

        // Asleep now. Wait for the real 'wake' event (fires when day comes, or when everyone
        // sleeping lets the server skip the night) rather than guessing a duration -- a plain
        // safety timeout forces a wake only if something has gone genuinely wrong (SLEEP_TIMEOUT_MS
        // is well beyond a real night's length).
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(); } };
          bot.once("wake", finish);
          setTimeout(() => {
            if (!settled && bot.isSleeping) bot.wake().catch(() => {});
            finish();
          }, SLEEP_TIMEOUT_MS);
        });
        return ok("slept through the night.");
      }
      return fail("found beds nearby, but couldn't use any of them.");
    }

    case "smelt": {
      // Direct request, 2026-09-07: "they can't seem to find the furnaces" -- most of tonight's
      // goal failures were bots correctly reasoning they needed an ingot and having no way to
      // get one beyond hoping a chest had it (craft/mine alone were never enough; see index.js's
      // planNextStep comments). Built on mineflayer's own openFurnace() (core, no extra plugin).
      //
      // Real gap found live minutes after shipping: the prompt says <item_id> is the OUTPUT
      // (e.g. "copper_ingot"), but the planner sometimes names the INPUT raw material instead
      // ("raw_copper"). Cheap and always-safe to just accept either rather than keep tightening
      // prompt wording for something this easy to normalize -- if the named item isn't a known
      // output, check whether it's actually a known input for one and use that recipe instead.
      let outputItem = action.item;
      if (!SMELT_RECIPES[outputItem]) {
        const matched = Object.entries(SMELT_RECIPES).find(([, inputs]) => inputs.includes(outputItem));
        if (matched) outputItem = matched[0];
      }
      const inputCandidates = SMELT_RECIPES[outputItem];
      if (!inputCandidates) return fail(`don't know how to smelt "${action.item}".`);
      const inputItem = bot.inventory.items().find((i) => inputCandidates.includes(i.name));
      if (!inputItem) return fail(`don't have anything to smelt into ${outputItem}.`);
      const smeltCount = Math.min(action.count, inputItem.count);

      const fuelItem = pickFuel(bot);
      if (!fuelItem) return fail("don't have any fuel to smelt with.");

      const furnaceNames = ["furnace", "blast_furnace", "smoker"];
      const matchIds = furnaceNames.map((n) => bot.registry.blocksByName[n]?.id)
        .filter((id) => id !== undefined);
      if (!matchIds.length) return fail("don't know how to recognize a furnace here.");
      const furnaceFindOptions = { matching: matchIds, maxDistance: 32, count: 3 };
      let positions = bot.findBlocks(furnaceFindOptions);
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, furnaceFindOptions);
      if (!positions.length) return fail("couldn't find a furnace nearby, even after looking around.");

      for (const pos of positions) {
        if (token.cancelled) return ok("stopped on the way to a furnace.");
        const furnaceBlock = bot.blockAt(pos);
        if (!furnaceBlock) continue;

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x,
            furnaceBlock.position.y, furnaceBlock.position.z, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
        } catch (err) {
          if (token.cancelled) return ok("stopped on the way to a furnace.");
          console.log(`[smelt] couldn't reach furnace at ${furnaceBlock.position}: ${err.message}`);
          continue; // couldn't reach this furnace -- try the next candidate
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) return ok("stopped on the way to a furnace.");

        let furnace;
        try {
          furnace = await bot.openFurnace(furnaceBlock);
          // Real gap found live (2026-09-07): the same 3 furnaces failed "destination full"
          // across several separate goal attempts -- logging what's actually sitting in each
          // slot on open, so a repeat is diagnosable (someone else's items? a stuck previous
          // attempt of our own?) instead of just "full" with no further evidence.
          const slot = (item) => item ? `${item.name}x${item.count}` : "empty";
          console.log(`[smelt] furnace at ${furnaceBlock.position} slots: ` +
            `input=${slot(furnace.inputItem())} fuel=${slot(furnace.fuelItem())} output=${slot(furnace.outputItem())}`);
        } catch (err) {
          console.log(`[smelt] couldn't open furnace at ${furnaceBlock.position}: ${err.message}`);
          continue; // couldn't open this one -- try the next candidate
        }

        try {
          // Direct request, 2026-09-21 ("I want real confirmation they can use the crafting
          // table and furnace"). Investigating turned up a real, severe, already-live bug: a
          // fleet-wide 24h log sweep found ZERO successful smelts, every single attempt failing
          // "found furnaces nearby, but couldn't use any of them." This codebase's own per-
          // furnace slot logging (2026-09-07) caught the real cause directly: furnace at
          // (94,63,64) had 63 coal_block already sitting in its fuel slot (coal_block smelts 800
          // items each -- decades of fuel) plus 16 iron_ingot stranded in output, uncollected;
          // furnace at (94,63,63) had exactly 64 coal_block, the hard per-slot cap. putFuel() was
          // called UNCONDITIONALLY on every single attempt regardless of how much fuel a furnace
          // already had -- once a slot maxes out, every future putFuel() throws "destination
          // full" and the whole smelt aborted right there, before ever reaching putInput, even
          // though the furnace already had more than enough fuel to actually smelt with.
          //
          // Fix, two parts: (1) collect any output already sitting there first -- recovers
          // whatever a prior successful smelt (ours or another bot's) left stranded, and frees
          // the slot; (2) treat a failed putFuel() as "already has fuel," not fatal -- log it and
          // fall through to putInput using whatever's already in the fuel slot, rather than
          // aborting the entire attempt over a top-up that was never actually needed.
          const existingOutput = furnace.outputItem();
          if (existingOutput && existingOutput.count > 0) {
            await furnace.takeOutput();
          }
          try {
            // One fuel item per item smelted is a generous overestimate for any fuel type (coal
            // alone smelts 8 per item) -- errs toward "definitely enough fuel" over precision.
            await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, smeltCount));
          } catch (fuelErr) {
            console.log(`[smelt] furnace at ${furnaceBlock.position} already has fuel, ` +
              `skipping top-up: ${fuelErr.message}`);
          }
          await furnace.putInput(inputItem.type, null, smeltCount);

          // furnace.js has no built-in "wait until done" -- poll its own 'update' event (fired
          // on every server progress packet) for a non-empty output, with a safety timeout.
          const outputReady = await new Promise((resolve) => {
            let settled = false;
            const check = () => {
              const out = furnace.outputItem();
              if (out && out.count > 0 && !settled) { settled = true; resolve(true); }
            };
            furnace.on("update", check);
            check();
            setTimeout(() => { if (!settled) resolve(false); }, SMELT_TIMEOUT_MS);
          });
          furnace.removeAllListeners("update");

          let smelted = 0;
          if (outputReady) {
            const out = await furnace.takeOutput();
            smelted = out?.count ?? 0;
          }
          await furnace.close();
          if (!smelted) return fail("waited at the furnace but nothing came out -- may be out of fuel.");
          await refreshGear(bot); // a freshly-smelted ingot might feed straight into new gear
          return ok(`smelted ${smelted} ${outputItem}.`);
        } catch (err) {
          try { await furnace.close(); } catch { /* already closed or never opened cleanly */ }
          console.log(`[smelt] furnace at ${furnaceBlock.position} failed: ${err.message}`);
          continue; // this furnace didn't work out -- try the next candidate
        }
      }
      return fail("found furnaces nearby, but couldn't use any of them.");
    }

    case "place": {
      // Direct request, 2026-09-07: bots could craft a furnace or crafting table but had no way
      // to actually use one they made themselves, only ones already sitting in the world -- a
      // real dead end hit live tonight. Deliberately narrow: ONE utility block, right next to
      // herself, not a general building capability -- structure placement stays explicitly out
      // of scope (see this file's own header). Built on mineflayer's own placeBlock() (core, no
      // extra plugin).
      const heldCandidate = bot.inventory.items().find((i) => i.name === action.item);
      if (!heldCandidate) return fail(`don't have a ${action.item} to place.`);

      try {
        await bot.equip(heldCandidate, "hand");
      } catch (err) {
        return fail(`couldn't hold the ${action.item} to place it: ${err.message}`);
      }
      if (token.cancelled) return ok("stopped before placing it.");

      // A cardinal-adjacent spot with solid ground and clear air above it -- simpler and more
      // robust than assuming the block directly below her own feet works, since that's
      // literally where she's standing.
      const feet = bot.entity.position.floored();
      let referenceBlock = null;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ground = bot.blockAt(feet.offset(dx, -1, dz));
        const space = bot.blockAt(feet.offset(dx, 0, dz));
        if (ground?.boundingBox === "block" && space && space.boundingBox !== "block") {
          referenceBlock = ground;
          break;
        }
      }
      if (!referenceBlock) return fail("no clear spot nearby to place it.");

      try {
        await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
      } catch (err) {
        return fail(`couldn't place the ${action.item}: ${err.message}`);
      }
      return ok(`placed a ${action.item}.`);
    }

    // Review MB-08 follow-up (2026-09-24): the Builder's checklist items ("go home and place a
    // furnace there") as one deterministic action -- walk home, then place -- instead of hoping
    // the planner sequences GOHOME and PLACE correctly. goalTick uses it directly (see
    // runBuilderPlacement); "gohome"/"place" do the actual work, sharing this call's token.
    case "place_home": {
      if (!bot.inventory.items().some((i) => i.name === action.item)) {
        return fail(`don't have a ${action.item} to place.`);
      }
      const home = await performActionAs(bot, { type: "gohome" }, speaker, token);
      if (token.cancelled) return home;
      if (!home.ok) return fail(`couldn't get home to place the ${action.item}: ${home.text}`);
      const placed = await performActionAs(bot, { type: "place", item: action.item }, speaker, token);
      return placed.ok ? ok(`placed a ${action.item} at home.`) : placed;
    }

    case "light_area": {
      // Direct request, 2026-09-10 ("fix the lighting logic"), following a real live incident:
      // 1260+ deaths in ~26h traced to the shared base sitting in pitch dark (light=0 at ground
      // level, confirmed live) with an uncapped nightly mob buildup (dozens of hostiles counted
      // within 80 blocks at once) -- self-defense fighting one threat at a time was never going
      // to survive an actual swarm. The existing "place a torch" logic (checkLighting, index.js)
      // only ever reacted to wherever a bot personally happened to be standing at the moment its
      // own tile went dark -- nothing ever proactively lit up the AREA bots actually live in.
      // This is that: walks to each dark, mob-spawn-capable spot near a real anchor point
      // (action.near -- checkHomeLighting's own claimed-bed position) and places a torch there.
      // Self-limiting by construction, no cross-bot coordination needed: a placed torch persists
      // in the world and clears that spot for every bot's next sweep, not just this one's -- five
      // bots independently sweeping the same shared base converges on "fully lit," it doesn't
      // duplicate work forever.
      const torchLit = bot.inventory.items().find((i) => i.name === "torch");
      if (!torchLit) return fail("don't have any torches to light the area with.");

      const LIGHT_AREA_RADIUS = 10;
      const LIGHT_AREA_BATCH_LIMIT = 6;
      const positions = bot.findBlocks({
        point: action.near,
        matching: (block) => {
          if (!block?.position || block.boundingBox === "block" || block.light === undefined ||
              block.light >= DARK_LIGHT_LEVEL) return false;
          const below = bot.blockAt(block.position.offset(0, -1, 0));
          return !!below && below.boundingBox === "block" && !isProtectedBlockName(below.name);
        },
        maxDistance: LIGHT_AREA_RADIUS,
        count: LIGHT_AREA_BATCH_LIMIT,
      });
      if (!positions.length) return ok("area's already lit up -- nothing dark found nearby.");

      let placed = 0;
      for (const pos of positions) {
        if (token.cancelled) break;
        const current = bot.inventory.items().find((i) => i.name === "torch");
        if (!current) break; // ran out of torches partway through the sweep

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)),
            ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
        } catch {
          if (token.cancelled) break;
          continue; // couldn't reach this one -- try the next dark spot
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) break;

        // Re-check: another bot (or this one, via an earlier iteration) may have already lit
        // this exact spot since the batch was found.
        const ground = bot.blockAt(pos.offset(0, -1, 0));
        const spaceNow = bot.blockAt(pos);
        if (!ground || ground.boundingBox !== "block" || spaceNow?.light >= DARK_LIGHT_LEVEL) continue;

        try {
          await bot.equip(current, "hand");
          await bot.placeBlock(ground, new Vec3(0, 1, 0));
          placed++;
        } catch (err) {
          console.error(`light_area: failed to place a torch at ${pos}:`, err.message);
        }
      }

      if (!placed) return token.cancelled ? ok("stopped lighting the area.") : fail("found dark spots but couldn't light any of them.");
      return ok(`lit up ${placed} dark spot(s)${token.cancelled ? ", stopped early" : ""}.`);
    }

    case "build": {
      // Direct request, 2026-09-07 ("build the water crossing mechanic" -> "do 1,2,4,5" -> a
      // real building capability, the "own pass" this file's header always said it deserved
      // rather than being half-built alongside navigate/gather/fight, see the header's own
      // 1.0.0-era comment). Deliberately one fixed, small shape (a 3x3 footprint, three walls
      // tall, one doorway, a roof) using whatever solid block she already has the most of --
      // not a general blueprint/planning system (even Voyager needs human feedback for its own
      // house-building; a real planner is its own much bigger feature, left for a future pass
      // same as this one was). Placement order matters: walls are generated ground-up
      // (dy 0 -> 1 -> 2 per column) so each new block always has an already-placed block right
      // below it to reference off of, and the roof is generated so the center tile references an
      // already-placed edge tile horizontally -- no cell ever needs a reference that doesn't
      // exist yet. The doorway (south edge, one column, all three wall heights) is never in the
      // placement list at all, so she can never seal herself in no matter what order placement
      // actually succeeds in.
      const material = bot.inventory.items()
        .filter((i) => bot.registry.blocksByName[i.name] && !isEssentialItem(i.name))
        .sort((a, b) => b.count - a.count)[0];
      if (!material) return fail("don't have a good building material -- need a stack of some solid block.");

      const base = bot.entity.position.floored();
      const wallPositions = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (Math.abs(dx) !== 1 && Math.abs(dz) !== 1) continue; // interior column -- no wall here
          if (dx === 0 && dz === 1) continue; // doorway column -- never placed, on purpose
          for (let dy = 0; dy <= 2; dy++) wallPositions.push(base.offset(dx, dy, dz));
        }
      }
      const roofPositions = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) roofPositions.push(base.offset(dx, 3, dz));
      }
      const buildOrder = [...wallPositions, ...roofPositions];

      const needed = buildOrder.length;
      if (material.count < needed) {
        return fail(`need ${needed} ${material.name} for a small shelter, only have ${material.count}.`);
      }

      let placed = 0;
      for (const pos of buildOrder) {
        if (token.cancelled) break;
        const existing = bot.blockAt(pos);
        if (existing?.boundingBox === "block") { placed++; continue; } // terrain already solid here

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)),
            ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
        } catch {
          if (token.cancelled) break;
          continue; // couldn't get near this spot -- an imperfect shelter beats abandoning it
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) break;

        // A solid neighbor to place against, below first (matches how a wall naturally grows
        // upward), otherwise whichever cardinal/vertical neighbor is already solid.
        let refBlock = null, face = null;
        for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
          const neighbor = bot.blockAt(pos.offset(dx, dy, dz));
          if (neighbor?.boundingBox === "block") {
            refBlock = neighbor;
            face = new Vec3(-dx, -dy, -dz);
            break;
          }
        }
        if (!refBlock) continue; // nothing solid to place against yet -- skip, a later pass could catch it

        try {
          const item = bot.inventory.items().find((i) => i.name === material.name);
          if (!item) break; // ran out mid-build
          await bot.equip(item, "hand");
          await bot.placeBlock(refBlock, face);
          placed++;
        } catch (err) {
          console.error(`build: placement failed at ${pos}:`, err.message);
        }
      }

      if (token.cancelled) return ok(`stopped building (${placed}/${needed} placed).`);
      if (!placed) return fail("couldn't place any of the shelter.");
      return ok(`built a small shelter out of ${material.name} (${placed}/${needed} blocks placed).`);
    }

    case "build_pen": {
      // Direct request, 2026-09-11 (§15.11 follow-up -- pen/fence containment for bred animals).
      // Deliberately one fixed, small shape, same philosophy as "build"'s own shelter above: a
      // 5x5 fence perimeter (open top -- fences already block ground-bound animals without
      // needing a roof) with ONE fence_gate replacing a perimeter block so she isn't sealing
      // anything in without a way through. Not a general planner -- even "build" above isn't
      // one, see this file's own header on why.
      const fence = bot.inventory.items().find((i) => i.name.endsWith("_fence") && !i.name.endsWith("_fence_gate"));
      const gate = bot.inventory.items().find((i) => i.name.endsWith("_fence_gate"));
      if (!fence) return fail("don't have any fence blocks for a pen.");
      if (!gate) return fail("don't have a fence gate for a pen.");

      const base = action.at ? new Vec3(action.at.x, action.at.y, action.at.z).floored() : bot.entity.position.floored();
      const perimeter = [];
      // 2026-09-25: 7x7 (5x5 inside), was 5x5 -- a tempted animal stops ~2.5 blocks from her, so in a
      // 3x3 pen there was nowhere inside for it to stop.
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          if (Math.abs(dx) !== 3 && Math.abs(dz) !== 3) continue; // interior -- open pen floor, no fence here
          perimeter.push(base.offset(dx, 0, dz));
        }
      }
      const gatePos = base.offset(0, 0, 3); // south edge, middle -- the gate, matching "build"'s own doorway convention
      const fencePositions = perimeter.filter((p) => !(p.x === gatePos.x && p.y === gatePos.y && p.z === gatePos.z));
      const PEN_TOTAL = perimeter.length; // small fixed shape -- no extra batch cap needed

      let placed = 0;
      async function placeAt(pos, item) {
        const existing = bot.blockAt(pos);
        if (existing?.boundingBox === "block") { placed++; return true; }
        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)),
            ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
        } catch {
          return false; // couldn't reach this one -- skip, matches "build"'s own tolerance for gaps
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) return false;
        const below = bot.blockAt(pos.offset(0, -1, 0));
        if (!below || below.boundingBox !== "block") return false; // no ground to reference off yet
        const current = bot.inventory.items().find((i) => i.name === item.name);
        if (!current) return false;
        try {
          await bot.equip(current, "hand");
          await bot.placeBlock(below, new Vec3(0, 1, 0));
          placed++;
          return true;
        } catch (err) {
          console.error(`build_pen: placement failed at ${pos}:`, err.message);
          return false;
        }
      }

      for (const pos of fencePositions) {
        if (token.cancelled) break;
        await placeAt(pos, fence);
      }
      const gatePlaced = token.cancelled ? false : await placeAt(gatePos, gate);

      if (token.cancelled) return ok(`stopped building the pen (${placed}/${PEN_TOTAL} placed).`);
      if (!placed) return fail("couldn't place any of the pen.");
      // Direct request, 2026-09-11 ("fix the pen herding"): only remember this pen's location if
      // the GATE specifically went in -- herd_to_pen needs a real, known entry point, and a
      // fence-without-a-gate isn't a usable pen regardless of how many wall segments landed.
      if (gatePlaced) await savePenLocation(base, gatePos);
      return ok(`built a small pen out of ${fence.name} with a ${gate.name} (${placed}/${PEN_TOTAL} placed).` +
        (gatePlaced ? "" : " gate didn't go in -- not usable for herding yet."));
    }

    case "herd_to_pen": {
      // Direct request, 2026-09-11 ("fix the pen herding"): build_pen (above) only ever placed
      // the STRUCTURE -- the design doc's own §15.8 flagged this as a real, separate gap the day
      // it shipped ("build_pen places the structure but doesn't move an animal INTO it"). Reuses
      // a real vanilla mechanic rather than inventing one: an adult animal already follows
      // whoever's holding its tempting food (vanilla's own TemptGoal AI) once close enough --
      // exactly the same food/BREEDING_FOOD relationship "breed" already leans on, just used for
      // movement instead of feeding. Walks toward the pen in short, bounded hops (not one long
      // goto) specifically so the animal's own AI has a real chance to keep pace -- covering the
      // whole distance in one pathfinder goal would very likely outrun her and break the tempt
      // range partway there, with no way to notice until arrival.
      const pen = await loadPenLocation();
      if (!pen) return fail("no pen built yet -- build one first.");

      const foods = BREEDING_FOOD[action.species];
      if (!foods) return fail(`don't know what tempts a ${action.species}.`);
      const foodItem = bot.inventory.items().find((i) => foods.includes(i.name));
      if (!foodItem) return fail(`don't have the right food to lure a ${action.species} (need ${foods[0]}).`);

      const animal = Object.values(bot.entities)
        .filter((e) => e.name === action.species &&
          !(Math.abs(e.position.x - (pen.center.x + 0.5)) < 2.6 && Math.abs(e.position.z - (pen.center.z + 0.5)) < 2.6) && // not already penned
          e.position.distanceTo(bot.entity.position) <= 32)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!animal) return fail(`no loose ${action.species} nearby to herd.`);

      // Walk up to it empty-handed; the food comes out once she's there (below).
      try {
        await withTimeout(
          bot.pathfinder.goto(new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 3)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped before reaching the animal.");
        return fail(`couldn't reach the ${action.species}: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped before herding.");

      // 2026-09-25 (live test): the food comes out only now that she's at the animal -- held from the
      // start, the one already in the pen followed her out -- and the gate is held open only while
      // she leads (performAction used to hold it for the whole action, walk out included).
      const releaseDoors = holdDoorsOpen(bot);
      try {
        return await (async () => {
      try {
        await bot.equip(foodItem, "hand");
      } catch (err) {
        return fail(`couldn't hold the ${foodItem.name}: ${err.message}`);
      }


      const HERD_STEP_DISTANCE = 3;
      const HERD_MAX_STEPS = 15;
      const HERD_FOLLOW_RANGE = 8; // generous margin over vanilla TemptGoal's own real tempt radius
      const waitForAnimal = async (done, ms) => {
        for (let waited = 0; waited < ms && !token.cancelled && !done(); waited += 250) {
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      let steps = 0;
      while (steps < HERD_MAX_STEPS) {
        if (token.cancelled) return ok(`stopped herding partway (${steps} steps).`);
        // Real, checked distance every step -- never assumed still-following just because the
        // bot itself kept moving toward the pen.
        const liveAnimal = bot.entities[animal.id];
        if (!liveAnimal) return fail(`lost track of the ${action.species} -- it may have died or unloaded.`);
        if (liveAnimal.position.distanceTo(bot.entity.position) > HERD_FOLLOW_RANGE) {
          return fail(`the ${action.species} stopped following -- fell too far behind (${steps} steps in).`);
        }

        const toGate = pen.gate.minus(bot.entity.position);
        const dist = toGate.norm();
        if (dist < 1.5) break; // reached the gate

        const target = bot.entity.position.plus(toGate.normalize().scale(Math.min(HERD_STEP_DISTANCE, dist)));
        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1)),
            ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
        } catch {
          if (token.cancelled) return ok(`stopped herding partway (${steps} steps).`);
          // couldn't complete this one short step -- not necessarily fatal, the animal-distance
          // check at the top of the next iteration is the real judge of whether to keep going
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        steps++;
        // 2026-09-25 (live test): a tempted animal walks slower than she does -- let it catch up
        // before the next step instead of outrunning it.
        await waitForAnimal(() => bot.entities[animal.id]?.position.distanceTo(bot.entity.position) <= 4, 3000);
      }

      // Final leg: through the gate to the pen's back wall. A tempted animal stops ~2.5 blocks short of
      // her, so leading only to the middle left it standing in the gateway (live test, 2026-09-25).
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(pen.center.x, pen.center.y, pen.center.z - 2)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch {
        // best effort -- the real success check below decides regardless of how this leg went
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }

      // It trails her in through the gate: wait for it to be inside the pen, not merely near it.
      const inPen = (e) => !!e && Math.abs(e.position.x - (pen.center.x + 0.5)) < 2.6 &&
        Math.abs(e.position.z - (pen.center.z + 0.5)) < 2.6;
      await waitForAnimal(() => inPen(bot.entities[animal.id]), 15_000);
      const finalAnimal = bot.entities[animal.id];
      if (!inPen(finalAnimal)) {
        return fail(`reached the pen, but the ${action.species} didn't follow all the way in.`);
      }

      // Close the gate behind her -- only toggle if it's actually open, never blind-toggle one
      // that's already shut (activateBlock on a fence gate flips its open/closed state).
      const gateBlock = bot.blockAt(pen.gate);
      if (gateBlock?.getProperties?.().open) {
        try {
          await bot.activateBlock(gateBlock);
        } catch (err) {
          console.error("herd_to_pen: couldn't close the gate:", err.message);
        }
      }

      await recordAchievement(bot, `penned:${action.species}`);
      return ok(`herded a ${action.species} into the pen.`);
        })();
      } finally {
        releaseDoors();
        await refreshGear(bot); // put the food away, or the animal follows her back out
      }
    }

    case "repair_terrain": {
      // §15.10: fills action.position (the pit's lowest empty spot, as {x, y, z, targetY} --
      // index.js's checkTerrainDamage() found and validated this, not decided here) one block at
      // a time, bottom-up, up to targetY -- the fleet's own home-level grade.
      const { x, y, z, targetY } = action.position;
      const PIT_FILL_BATCH_LIMIT = 8;
      const columnBase = new Vec3(x, y, z);

      // Material: an explicit override (action.material) wins -- checkTerrainDamage sets this
      // only when the spot needs to stay plantable (§15.10's "guided by function" case).
      // Otherwise sample the solid blocks immediately surrounding the pit's rim and fill with
      // whichever is most common -- cosmetic repair blends into what's already there.
      let materialName = action.material;
      if (!materialName) {
        const rimOffsets = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                             [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]];
        const counts = new Map();
        for (const [dx, dy, dz] of rimOffsets) {
          const block = bot.blockAt(columnBase.offset(dx, dy, dz));
          if (block?.boundingBox === "block" && !isProtectedBlockName(block.name)) {
            counts.set(block.name, (counts.get(block.name) || 0) + 1);
          }
        }
        let bestCount = 0;
        for (const [name, count] of counts) {
          if (count > bestCount) { materialName = name; bestCount = count; }
        }
      }
      if (!materialName) return fail("couldn't tell what material belongs here -- no solid neighbors to match.");

      const materialItem = bot.inventory.items().find((i) => i.name === materialName);
      if (!materialItem) return fail(`need ${materialName} to fill this in -- don't have any.`);

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3)), ACTION_TIMEOUT_MS,
                           () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way to the repair site.");
        return fail(`couldn't reach the spot to repair: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped before repairing.");

      let placed = 0;
      for (let dy = 0; dy <= targetY - y && placed < PIT_FILL_BATCH_LIMIT; dy++) {
        if (token.cancelled) break;
        const pos = columnBase.offset(0, dy, 0);
        const existing = bot.blockAt(pos);
        if (existing?.boundingBox === "block") continue; // already solid -- a lower layer, or someone beat her to it

        const below = bot.blockAt(pos.offset(0, -1, 0));
        if (!below || below.boundingBox !== "block") break; // nothing to reference off yet -- next visit catches it once the layer below is filled

        const item = bot.inventory.items().find((i) => i.name === materialName);
        if (!item) break; // ran out mid-fill
        try {
          await bot.equip(item, "hand");
          await bot.placeBlock(below, new Vec3(0, 1, 0));
          placed++;
        } catch (err) {
          console.error(`repair_terrain: placement failed at ${pos}:`, err.message);
          break;
        }
      }

      if (token.cancelled) return ok(`stopped repairing (${placed} block(s) filled).`);
      if (!placed) return fail("couldn't fill in the damage -- nothing placed.");
      return ok(`filled in ${placed} block(s) of damage with ${materialName}.`);
    }

    case "store": {
      // Direct request, 2026-09-07 ("do all" -> base/chest storage): the inverse of "loot" --
      // deposit an item into the nearest chest instead of withdrawing from it. Same multi-
      // candidate + obstruction-check pattern (chestObstructed(), extracted from loot for this).
      const itemDef = bot.registry.itemsByName[action.item];
      if (!itemDef) return fail(`I don't recognize the item "${action.item}".`);
      const have = bot.inventory.count(itemDef.id, null);
      if (!have) return fail(`don't have any ${action.item} to store.`);
      const storeCount = Math.min(action.count, have);

      const chestType = bot.registry.blocksByName.chest;
      const trappedType = bot.registry.blocksByName.trapped_chest;
      const matchIds = [chestType?.id, trappedType?.id].filter((id) => id !== undefined);
      if (!matchIds.length) return fail("don't know how to recognize a chest here.");
      // Direct request, 2026-09-09 ("after any crafting activity, surplus materials should be
      // stored in a chest as close to their sleeping home as possible"). action.near (optional):
      // search FROM that point instead of the bot's own current position -- confirmed against
      // mineflayer's own findBlocks() source (blocks.js): `point` (default bot.entity.position)
      // is the real reference every result is sorted by distance to, not a cosmetic option.
      // storeNearHome() (index.js) is the one caller that sets this, to her own claimed bed
      // position; every other "store" caller (checkInventoryFull/Insurance) omits it and keeps
      // the original "nearest to wherever I am right now" behavior, which is what they actually
      // want (get rid of it quickly, not necessarily near home).
      const storeFindOptions = { matching: matchIds, maxDistance: 32, count: 3, point: action.near };
      let positions = bot.findBlocks(storeFindOptions);
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, storeFindOptions);
      if (!positions.length) return fail("couldn't find a chest nearby, even after looking around.");

      for (const pos of positions) {
        if (token.cancelled) return ok("stopped on the way to a chest.");
        const chestBlock = bot.blockAt(pos);
        if (!chestBlock) continue;
        // Real live gap, 2026-09-09: this and the pathfinder catch just below were exactly as
        // silent as the deposit failure right after them ("found chests nearby, but couldn't
        // store anything in any of them" with zero clue why) -- a real occurrence of this
        // failure showed no deposit-failure log at all, meaning it was skipped here or below
        // instead, neither of which said so. Logged for the same reason.
        if (chestObstructed(bot, chestBlock)) {
          console.log(`[store] skipping chest at ${chestBlock.position}: obstructed (blocked above).`);
          continue;
        }

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
            chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
        } catch (err) {
          if (token.cancelled) return ok("stopped on the way to a chest.");
          console.log(`[store] couldn't reach chest at ${chestBlock.position}: ${err.message}`);
          continue; // couldn't reach this one -- try the next candidate
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) return ok("stopped on the way to a chest.");

        try {
          const chest = await bot.openChest(chestBlock);
          await chest.deposit(itemDef.id, null, storeCount);
          // Direct request, 2026-09-13 ("remember what is in chests when someone opens it") --
          // a deposit is exactly as real a change to this chest's contents as a withdrawal.
          await recordChestSnapshot(chestBlock.position, chest.containerItems());
          await chest.close();
        } catch (err) {
          // Real live gap found 2026-09-09 (storeSurplusNearHome's own post-craft cleanup
          // failed twice, live, with zero visibility into why): silently swallowing this per-
          // candidate reason meant "found chests nearby, but couldn't store anything in any of
          // them" was undiagnosable from the log alone -- same lesson "sleep" already learned
          // once (2026-09-07) for its own multi-candidate loop, never applied here until now.
          console.log(`[store] couldn't deposit into chest at ${chestBlock.position}: ${err.message}`);
          continue; // couldn't open/deposit into this one -- try the next candidate
        }
        return ok(`stored ${storeCount} ${action.item} in a chest.`);
      }
      return fail("found chests nearby, but couldn't store anything in any of them.");
    }

    case "trade": {
      // Direct request, 2026-09-07 ("do all" -> villager trading): a whole real mechanic (trade
      // UI, emeralds) untouched until now. Built on mineflayer's own openVillager()/trade()
      // (core) -- confirmed against villager.js source: trades expose .outputs[0].type, .inputs
      // (1-2 required items), .tradeDisabled (out of uses). <item> is the OUTPUT she wants, not
      // a trade index or price she'd have to already know -- this finds a matching, currently-
      // affordable, not-disabled trade herself. Deliberately direct-command only, not wired into
      // the goal planner's own vocabulary -- villager availability is unpredictable enough that
      // adding it there risks another hallucination surface rather than real capability.
      const villagerEntity = bot.nearestEntity((e) => e.name === "villager" &&
        e.position.distanceTo(bot.entity.position) <= 16);
      if (!villagerEntity) return fail("no villager nearby.");

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(villagerEntity, 2)), ACTION_TIMEOUT_MS,
          () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way to the villager.");
        return fail(`couldn't reach the villager: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped on the way to the villager.");

      let villager;
      try {
        villager = await bot.openVillager(villagerEntity);
      } catch (err) {
        return fail(`couldn't open trading with the villager: ${err.message}`);
      }

      try {
        const wantedId = bot.registry.itemsByName[action.item]?.id;
        const tradeIndex = (villager.trades ?? []).findIndex((t) =>
          !t.tradeDisabled && t.outputs[0]?.type === wantedId &&
          t.inputs.every((ing) => bot.inventory.count(ing.type, null) >= ing.count));
        if (tradeIndex < 0) {
          await villager.close();
          return fail(`this villager doesn't have a usable trade for ${action.item}.`);
        }
        await bot.trade(villager, tradeIndex, 1);
        await villager.close();
      } catch (err) {
        try { await villager.close(); } catch { /* already closed or never opened cleanly */ }
        return fail(`couldn't complete the trade: ${err.message}`);
      }
      await refreshGear(bot);
      return ok(`traded with a villager for ${action.item}.`);
    }

    case "recover": {
      // Direct request, 2026-09-07 ("do all" -> death/respawn handling). Vanilla drops
      // everything at the death location on a 5-minute despawn timer (unless keepInventory is
      // on) -- worth trying to get back before it's gone. Picking items up is automatic on
      // proximity, no dedicated mineflayer API needed -- just getting there is the whole job.
      // action.position is a plain {x,y,z} (index.js's own captured bot.entity.position at the
      // moment of death), not a real action verb a player/planner would ever construct by hand.
      const { position } = action;
      if (!position) return fail("don't know where I died.");
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("gave up heading back.");
        return fail(`couldn't get back to where I died: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("gave up heading back.");
      // Give auto-pickup a moment to actually register nearby items before reporting done.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await refreshGear(bot);
      return ok("made it back to recover what I could.");
    }

    case "harvest": {
      // Direct request, 2026-09-07 (farming), rebuilt 2026-09-25 from a day of logs: the old
      // start-a-farm branch tilled the 8 nearest dirt blocks wherever they were, counted a till that
      // silently failed (grass on top), ignored water, and never said why it failed. action.near:
      // work around this spot (a farm goal's plot). action.onlyRipe: harvest ripe crops or nothing
      // -- the ripe-crop routine uses it so it never starts a farm on its own.
      const CROP_REPLANT = { wheat: "wheat_seeds", carrots: "carrot", potatoes: "potato", beetroots: "beetroot_seeds" };
      const HARVEST_BATCH_LIMIT = 8;
      const cropIds = Object.keys(CROP_MAX_AGE).map((n) => bot.registry.blocksByName[n]?.id)
        .filter((id) => id !== undefined);
      if (!cropIds.length) return fail("don't know how to recognize any crops here.");
      const near = action.near ? new Vec3(action.near.x, action.near.y, action.near.z) : null;

      const positions = bot.findBlocks({ matching: cropIds, maxDistance: 32, count: 64, ...(near ? { point: near } : {}) });
      const matureBlocks = positions.map((pos) => bot.blockAt(pos))
        .filter((block) => block && Number(block.getProperties?.().age) === CROP_MAX_AGE[block.name])
        .slice(0, HARVEST_BATCH_LIMIT);

      if (!matureBlocks.length) {
        if (action.onlyRipe) return fail("nothing ripe to harvest.");
        const hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
        if (!hoe) return { ...fail("couldn't find any ripe crops, and don't have a hoe to start a new farm."), missing: "hoe" };
        if (!bot.inventory.items().some((i) => SEED_NAMES.includes(i.name))) {
          return { ...fail("couldn't find any ripe crops, and don't have any seeds to start a new farm."), missing: "seeds" };
        }
        const site = chooseFarmPlot(bot, near);
        if (!site) return fail("couldn't find any ripe crops or open ground to start a new farm.");

        let tilled = 0, planted = 0;
        const problems = [];
        for (const pos of site.plot) {
          if (token.cancelled) break;
          if (!tillableAt(bot, pos) && bot.blockAt(pos)?.name !== "farmland") continue; // changed since chosen
          try {
            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)),
              ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
          } catch {
            if (token.cancelled) break;
            problems.push("unreachable");
            continue;
          } finally {
            if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
          }
          if (token.cancelled) break;

          const above = bot.blockAt(pos.offset(0, 1, 0));
          if (above && above.name !== "air") {
            try {
              await withTimeout(bot.dig(above), ACTION_TIMEOUT_MS, () => bot.stopDigging()); // grass often drops seeds
            } catch {
              problems.push(`couldn't clear the ${above.name}`);
              continue;
            }
          }
          if (bot.blockAt(pos)?.name !== "farmland") {
            try {
              const currentHoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
              if (!currentHoe) { problems.push("hoe broke"); break; }
              await bot.equip(currentHoe, "hand");
              await bot.activateBlock(bot.blockAt(pos));
            } catch (err) {
              problems.push(`tilling: ${err.message}`);
              continue;
            }
            await new Promise((r) => setTimeout(r, 250)); // the block update lands a tick or two later
            if (bot.blockAt(pos)?.name !== "farmland") {
              problems.push(`the ${bot.blockAt(pos)?.name ?? "block"} didn't turn to farmland`);
              continue;
            }
          }
          tilled++;
          const seed = bot.inventory.items().find((i) => SEED_NAMES.includes(i.name));
          if (!seed) { problems.push("ran out of seeds"); continue; }
          try {
            await bot.equip(seed, "hand");
            await bot.placeBlock(bot.blockAt(pos), new Vec3(0, 1, 0));
          } catch (err) {
            problems.push(`planting: ${err.message}`);
            continue;
          }
          if (cropIds.includes(bot.blockAt(pos.offset(0, 1, 0))?.type)) planted++;
          else problems.push("the seed didn't take");
        }
        await collectDrops(bot, token, site.plot); // seeds from the cleared grass
        await refreshGear(bot);
        const why = problems.length ? ` (${[...new Set(problems)].slice(0, 3).join("; ")})` : "";
        if (!planted && !token.cancelled) return fail(`couldn't start a farm: tilled ${tilled}, planted 0${why}.`);
        const result = ok(`started a farm plot${site.hydrated ? " by water" : " (no water nearby, it'll grow slowly)"}: ` +
          `tilled ${tilled}, planted ${planted}${token.cancelled ? ", stopped early" : ""}${why}.`);
        return { ...result, tilled, planted, plot: { x: site.center.x, y: site.center.y, z: site.center.z } };
      }

      const harvestedCounts = {};
      const missed = []; // why each ripe crop wasn't picked (live, 2026-09-25: failures said nothing)
      let replantedCount = 0;
      let stoppedEarly = false;

      for (const cropBlock of matureBlocks) {
        if (token.cancelled) {
          stoppedEarly = true;
          break;
        }
        const current = bot.blockAt(cropBlock.position);
        if (!current || Number(current.getProperties?.().age) !== CROP_MAX_AGE[current.name]) continue;

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(current.position.x,
            current.position.y, current.position.z, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
        } catch (err) {
          if (token.cancelled) { stoppedEarly = true; break; }
          missed.push(`can't reach the one at ${current.position} (${err.message})`);
          continue; // couldn't reach this one -- move on to the next rather than abandon the batch
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) { stoppedEarly = true; break; }

        const farmlandPos = current.position.offset(0, -1, 0); // the crop sits on this block
        try {
          await withTimeout(bot.dig(current), ACTION_TIMEOUT_MS, () => bot.stopDigging());
        } catch (err) {
          if (token.cancelled) { stoppedEarly = true; break; }
          missed.push(`couldn't break the one at ${current.position} (${err.message})`);
          continue; // this one failed -- still worth trying the rest of the batch
        }
        harvestedCounts[current.name] = (harvestedCounts[current.name] || 0) + 1;

        const seedName = CROP_REPLANT[current.name];
        const seedItem = bot.inventory.items().find((i) => i.name === seedName);
        if (seedItem) {
          try {
            await bot.equip(seedItem, "hand");
            await bot.placeBlock(bot.blockAt(farmlandPos), new Vec3(0, 1, 0));
            replantedCount++;
          } catch (err) {
            console.error(`harvest: replant failed:`, err.message); // this harvest still counts
          }
        }
      }

      const total = Object.values(harvestedCounts).reduce((a, b) => a + b, 0);
      if (total) await collectDrops(bot, token, matureBlocks.map((b) => b.position));
      await refreshGear(bot);
      if (!total) {
        return stoppedEarly ? ok("stopped harvesting.")
          : fail(`couldn't harvest any of the ${matureBlocks.length} ripe crops found: ${missed.slice(0, 2).join("; ") || "they changed"}.`);
      }
      for (const crop of Object.keys(harvestedCounts)) await recordAchievement(bot, `harvested:${crop}`);
      const summary = Object.entries(harvestedCounts).map(([name, n]) => `${n} ${name}`).join(", ");
      return { ...ok(`harvested ${summary} (${replantedCount} replanted)${stoppedEarly ? ", stopped early" : ""}.`),
        harvested: harvestedCounts };
    }

    case "plant_sapling": {
      // Direct request, 2026-09-09: "when they find saplings, they should plant them (1) near
      // other trees of the same variety if they can (2) in any free soil not directly adjacent
      // to a building if they can't." action.item is the specific sapling name (e.g.
      // "oak_sapling") -- checkSaplings() (index.js) is the one caller, picking whichever
      // sapling she's actually carrying, never invented.
      const saplingItem = bot.inventory.items().find((i) => i.name === action.item);
      if (!saplingItem) return fail(`don't have a ${action.item} to plant.`);

      const SAPLING_PLANT_BATCH_LIMIT = 4;
      const treeName = action.item.replace("_sapling", "_log"); // oak_sapling -> oak_log
      const treeLogId = bot.registry.blocksByName[treeName]?.id;
      const groundIds = [bot.registry.blocksByName.grass_block?.id, bot.registry.blocksByName.dirt?.id]
        .filter((id) => id !== undefined);

      let planted = 0;
      for (let i = 0; i < SAPLING_PLANT_BATCH_LIMIT; i++) {
        if (token.cancelled) break;
        const current = bot.inventory.items().find((it) => it.name === action.item);
        if (!current) break; // ran out of this sapling type

        // Rule 1: near an existing tree of the same species, if one's reachable.
        let targetPos = null;
        if (treeLogId !== undefined) {
          const treePositions = bot.findBlocks({ matching: [treeLogId], maxDistance: 32, count: 5 });
          for (const treePos of treePositions) {
            targetPos = findPlantableSpotNear(bot, treePos, 4);
            if (targetPos) break;
          }
        }
        // Rule 2: fall back to any free soil not directly adjacent to a building.
        if (!targetPos) {
          // Real live gap found 2026-09-09, minutes after this first deployed: Luke and Mayor
          // both failed to find ANY spot, every single retry, for the entire 25-minute window --
          // rule 2 only ever checked within a fixed 32 blocks of wherever the bot currently
          // stood, with no fallback if that came up empty (unlike "mine"/"store"/harvest's own
          // till-from-scratch fallback, all of which already reach for wanderAndRetryFind()).
          // Near a base, most nearby open ground legitimately IS near a building by design
          // (that's the whole point of a base) -- this needs the same directed-wander capability
          // every other search-based action already has to reach open, unclaimed ground beyond
          // the immediate settled area.
          const groundFindOptions = {
            // Real live crash, 2026-09-09: a findBlocks() matcher candidate can have a null
            // .position despite the block itself being non-null -- the exact same mineflayer
            // edge case findNearestShore() (index.js) already found and guarded against; this
            // matcher hit it too ("sapling check failed: Cannot read properties of null
            // (reading 'offset')", repeating every idle tick for any bot carrying a sapling).
            // Also tightened here to real "air" (not just a non-solid bounding box) -- a
            // pre-existing sapling/tall-grass/flower already occupying that space isn't "block"
            // either, and a real live placement failure ("Server refused to place
            // dark_oak_sapling ... the block is still dark_oak_sapling") traced to exactly that.
            matching: (block) => {
              if (!block?.position || !groundIds.includes(block.type)) return false;
              if (bot.blockAt(block.position.offset(0, 1, 0))?.name !== "air") return false;
              return !nearBuilding(bot, block.position);
            },
            maxDistance: 32, count: 1,
          };
          let positions = bot.findBlocks(groundFindOptions);
          if (!positions.length) positions = await wanderAndRetryFind(bot, token, groundFindOptions);
          targetPos = positions[0] || null;
        }
        if (!targetPos) break; // nowhere good found -- stop, don't force a bad spot

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2)),
            ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
        } catch {
          if (token.cancelled) break;
          break; // couldn't reach this one -- don't keep hunting for spots this call
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
        if (token.cancelled) break;

        try {
          await bot.equip(current, "hand");
          await bot.placeBlock(bot.blockAt(targetPos), new Vec3(0, 1, 0));
          planted++;
        } catch (err) {
          console.error(`plant_sapling: failed to plant at ${targetPos}:`, err.message);
          break; // an unexpected placement failure -- don't loop on the same problem
        }
      }

      if (!planted) return token.cancelled ? ok("stopped planting.") : fail(`couldn't find anywhere good to plant the ${action.item}.`);
      return ok(`planted ${planted} ${action.item}${token.cancelled ? ", stopped early" : ""}.`);
    }

    case "breed": {
      // Direct request, 2026-09-07 ("what else can we add" -> animal breeding, the other half
      // of a sustainable food source). Built on mineflayer's own activateEntity() (core --
      // confirmed against inventory.js source: right-clicks the entity while holding whatever's
      // equipped, exactly vanilla's own feed-to-breed mechanic, no dedicated "breed" API needed).
      // BREEDING_FOOD hoisted to module scope 2026-09-11 -- see its own comment above.
      const foods = BREEDING_FOOD[action.species];
      if (!foods) return fail(`don't know how to breed a ${action.species}.`);
      const foodItem = bot.inventory.items().find((i) => foods.includes(i.name));
      if (!foodItem) return fail(`don't have the right food to breed a ${action.species} (need ${foods[0]}).`);

      // action.near (a ranch goal's pen centre): breed the pair inside the pen, not two strays.
      const near = action.near ? new Vec3(action.near.x + 0.5, action.near.y, action.near.z + 0.5) : null;
      const kin = () => Object.values(bot.entities).filter((e) => e.name === action.species &&
        (near ? e.position.distanceTo(near) <= 3.6 : e.position.distanceTo(bot.entity.position) <= 24));
      const before = kin().length;
      const animals = kin().slice(0, 2);
      if (animals.length < 2) {
        return fail(`need two ${action.species}s nearby to breed, only found ${animals.length}.`);
      }

      try {
        await bot.equip(foodItem, "hand");
      } catch (err) {
        return fail(`couldn't hold the ${foodItem.name}: ${err.message}`);
      }

      let fed = 0;
      for (const animal of animals) {
        if (token.cancelled) return ok("stopped breeding.");
        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(animal, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
          await bot.activateEntity(animal);
          fed++;
        } catch (err) {
          console.error(`breed: couldn't feed one ${action.species}:`, err.message);
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
        }
      }
      await refreshGear(bot);
      if (!fed) return fail(`couldn't get close enough to feed any ${action.species}s.`);
      // 2026-09-25: success used to be "fed some" -- a pair already on cooldown, or one fed twice,
      // looked the same. A baby appearing within ~10s is the real result.
      let bred = false;
      for (let waited = 0; waited < 10_000 && !token.cancelled; waited += 500) {
        await new Promise((r) => setTimeout(r, 500));
        if (kin().length > before) { bred = true; break; }
      }
      if (!bred) return fail(`fed ${fed} ${action.species}${fed > 1 ? "s" : ""}, but no baby came of it (on cooldown, or too young?).`);
      await recordAchievement(bot, `bred:${action.species}`);
      return { ...ok(`bred a baby ${action.species}.`), bred: action.species };
    }

    case "harvest_hive": {
      // Direct request, 2026-09-11 ("bee nests/hives") -- honey output for the Herder role,
      // narrowing (not closing -- pen/fence containment for other animals is still open, §15.11)
      // the gap that section flagged. Real vanilla beehive/bee_nest interaction has no dedicated
      // mineflayer API, same as "harvest"'s own tilling step above -- bot.activateBlock() while
      // holding the right item is the same "simulate a real client interaction" primitive.
      //
      // Direct follow-up, same day ("nest" again -> "honeycomb via shears too"): action.tool
      // picks the real tradeoff explicitly rather than hiding it -- "bottle" (default, honey)
      // never angers the bees at full honey_level; "shears" (honeycomb, the ONLY path to enough
      // honeycomb to ever craft a NEW beehive -- see the "craft"/"place" cases above, both
      // already fully generic, no code change needed there) always does, regardless of level.
      // Defaulting to bottle keeps every self-directed hive visit calm unless a caller
      // specifically needs honeycomb badly enough to accept the risk.
      const useShears = action.tool === "shears";
      const toolName = useShears ? "shears" : "glass_bottle";
      const tool = bot.inventory.items().find((i) => i.name === toolName);
      if (!tool) {
        return fail(`don't have ${useShears ? "shears" : "a glass bottle"} to collect ` +
          `${useShears ? "honeycomb" : "honey"} with.`);
      }

      const hiveIds = [bot.registry.blocksByName.beehive?.id, bot.registry.blocksByName.bee_nest?.id]
        .filter((id) => id !== undefined);
      if (!hiveIds.length) return fail("don't know how to recognize a beehive here.");

      const positions = bot.findBlocks({ matching: hiveIds, maxDistance: 32, count: 10 });
      const fullHive = positions.map((pos) => bot.blockAt(pos))
        .find((block) => block && Number(block.getProperties?.().honey_level) >= 5);
      if (!fullHive) return fail("no full beehive/bee nest nearby -- nothing ready to collect yet.");

      try {
        await withTimeout(
          bot.pathfinder.goto(new goals.GoalNear(fullHive.position.x, fullHive.position.y, fullHive.position.z, 2)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way to the hive.");
        return fail(`couldn't reach the hive: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped before collecting.");

      try {
        await bot.equip(tool, "hand");
        await bot.activateBlock(bot.blockAt(fullHive.position));
      } catch (err) {
        return fail(`couldn't collect ${useShears ? "honeycomb" : "honey"}: ${err.message}`);
      }
      await refreshGear(bot);
      return ok(useShears
        ? "took honeycomb from the hive -- might have upset the bees."
        : "collected a bottle of honey from the hive.");
    }

    case "shear": {
      // Direct request, 2026-09-11 (§15.11 follow-up -- "shear/milk verb for non-bee animals").
      // Real vanilla shearing has no dedicated mineflayer API beyond the generic right-click
      // primitive -- bot.activateEntity() (core, the same primitive "breed" already uses to feed
      // an animal) simulates it here too. No pre-check for "already sheared, wool hasn't regrown
      // yet" -- mineflayer's own entity-metadata index for that flag isn't confirmed stable
      // across versions, so this just tries and lets the server be the source of truth, same
      // discipline "breed" already applies to a cooldown it also doesn't pre-check.
      const shears = bot.inventory.items().find((i) => i.name === "shears");
      if (!shears) return fail("don't have shears.");

      const sheep = Object.values(bot.entities)
        .filter((e) => e.name === "sheep" && e.position.distanceTo(bot.entity.position) <= 24)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!sheep) return fail("no sheep nearby to shear.");

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(sheep, 2)), ACTION_TIMEOUT_MS,
          () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way to the sheep.");
        return fail(`couldn't reach the sheep: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped before shearing.");

      try {
        await bot.equip(shears, "hand");
        await bot.activateEntity(sheep);
      } catch (err) {
        return fail(`couldn't shear the sheep: ${err.message}`);
      }
      await refreshGear(bot);
      return ok("sheared a sheep for wool.");
    }

    case "milk": {
      // Same primitive as "shear" just above, different tool/species -- an empty bucket
      // right-clicked on a cow (core bot.activateEntity()) returns a filled milk_bucket, real
      // vanilla mechanic, no dedicated API.
      const bucket = bot.inventory.items().find((i) => i.name === "bucket");
      if (!bucket) return fail("don't have an empty bucket.");

      const cow = Object.values(bot.entities)
        .filter((e) => e.name === "cow" && e.position.distanceTo(bot.entity.position) <= 24)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!cow) return fail("no cow nearby to milk.");

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(cow, 2)), ACTION_TIMEOUT_MS,
          () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way to the cow.");
        return fail(`couldn't reach the cow: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped before milking.");

      try {
        await bot.equip(bucket, "hand");
        await bot.activateEntity(cow);
      } catch (err) {
        return fail(`couldn't milk the cow: ${err.message}`);
      }
      await refreshGear(bot);
      return ok("milked a cow.");
    }

    case "enchant": {
      // Direct request, 2026-09-07 ("what else can we add" -> enchanting, a real mechanic
      // untouched until now). Built on mineflayer's own openEnchantmentTable() (core) --
      // confirmed against its source: putTargetItem()/putLapis() move items in, enchant(choice)
      // picks one of the 3 offered options. Picks the first AFFORDABLE option by real XP level
      // (see the affordability check further down) rather than always the cheapest slot.
      const itemDef = bot.registry.itemsByName[action.item];
      if (!itemDef) return fail(`I don't recognize the item "${action.item}".`);
      const targetItem = bot.inventory.items().find((i) => i.type === itemDef.id);
      if (!targetItem) return fail(`don't have a ${action.item} to enchant.`);
      const lapisItem = bot.inventory.items().find((i) => i.name === "lapis_lazuli");
      if (!lapisItem) return fail("don't have any lapis lazuli to enchant with.");

      const tableType = bot.registry.blocksByName.enchanting_table;
      if (!tableType) return fail("don't know how to recognize an enchanting table here.");
      const enchFindOptions = { matching: tableType.id, maxDistance: 32, count: 1 };
      let positions = bot.findBlocks(enchFindOptions);
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, enchFindOptions);
      if (!positions.length) return fail("couldn't find an enchanting table nearby, even after looking around.");
      const tableBlock = bot.blockAt(positions[0]);

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(tableBlock.position.x,
          tableBlock.position.y, tableBlock.position.z, 2)), ACTION_TIMEOUT_MS,
          () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way to the enchanting table.");
        return fail(`couldn't reach the enchanting table: ${err.message}`);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) return ok("stopped on the way to the enchanting table.");

      let table;
      try {
        table = await bot.openEnchantmentTable(tableBlock);
        await table.putTargetItem(targetItem);
        await table.putLapis(lapisItem);
        if (!table.enchantments.some((e) => e.level > -1)) {
          await withTimeout(new Promise((resolve) => table.once("ready", resolve)), 5000, () => {});
        }
        // Real gap found by reading enchantment_table.js's own source, 2026-09-07: .level on
        // each slot IS the real XP-level cost the server will charge (confirmed: it's populated
        // directly from the same window-property packet vanilla uses to show that number to a
        // real player), and enchant() has no affordability check of its own -- it just sends the
        // packet and awaits an inventory update that may never come if the server silently
        // rejects an unaffordable choice, hanging this action instead of failing it. Picking the
        // first AFFORDABLE option (mineflayer's own anvil.js uses the identical bot.experience.
        // level comparison for repair costs) avoids both problems at once.
        const available = table.enchantments.filter((e) => e.level > -1);
        const optionIndex = table.enchantments.findIndex((e) => e.level > -1 && e.level <= bot.experience.level);
        if (optionIndex < 0) {
          await table.takeTargetItem().catch(() => {});
          await table.close();
          return fail(available.length
            ? `can't afford any enchantment offered (cheapest needs level ` +
              `${Math.min(...available.map((e) => e.level))}, only have ${bot.experience.level}).`
            : "no enchantments available right now (maybe needs more bookshelves or levels).");
        }
        await table.enchant(optionIndex);
        await table.takeTargetItem();
        await table.close();
      } catch (err) {
        try { await table?.close(); } catch { /* already closed or never opened cleanly */ }
        return fail(`couldn't enchant the ${action.item}: ${err.message}`);
      }
      await refreshGear(bot);
      return ok(`enchanted the ${action.item}.`);
    }

    default:
      return fail("not sure how to do that yet.");
  }
  } finally {
    // Release moved to the performAction() wrapper (2026-09-24).
  }
}
