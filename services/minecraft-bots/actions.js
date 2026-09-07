// Version: 1.19.0
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
import { loadEquipmentPlugins, equipBestArmor, equipBestWeapon } from "./equipment.js";

const { goals } = pathfinderPkg;

const ACTION_TIMEOUT_MS = 60_000;
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

const HOSTILE_MOBS = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "spider", "cave_spider",
  "creeper", "enderman", "witch", "phantom", "slime", "magma_cube", "silverfish", "blaze",
  "ghast", "guardian", "elder_guardian", "shulker", "vex", "vindicator", "evoker", "pillager",
  "ravager", "hoglin", "zoglin", "piglin_brute", "warden",
]);

// Shared between the "attack"/"flee" actions here and index.js's checkSelfDefense() (fourth of
// five scoped enhancements, direct follow-up to "what other logic enhancements are available")
// so HOSTILE_MOBS has exactly one definition instead of two copies drifting apart.
export function nearestHostile(bot, maxDistance = 16) {
  return bot.nearestEntity((e) => e.type === "mob" && HOSTILE_MOBS.has(e.name) &&
    e.position.distanceTo(bot.entity.position) <= maxDistance);
}

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
];

// Suffix-matched, same convention as equipment.js -- what's worth pulling out of a chest.
// Food/blocks/misc items are left behind; this is specifically about gearing up.
const GEAR_SUFFIXES = [
  "_helmet", "_chestplate", "_leggings", "_boots", "_sword", "_axe", "_pickaxe", "_shovel", "_hoe",
];

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

// Direct request, 2026-09-07 ("what other logic enhancements are available" -> "explore/
// wander"): the single biggest recurring blocker across a whole night's live testing was
// "couldn't find X nearby" (wood, ore, chests) purely because nothing existed within the normal
// maxDistance of wherever the bot happened to be standing -- with no way to deliberately look
// further. Deliberately bounded, not open-ended exploration: ONE wander-then-retry per failed
// search, a fixed modest distance, not a search loop. This runs the same kind of long-distance
// pathfinding linked to tonight's cave-pathfinding OOM crashes, so it stays conservative
// (EXPLORE_DISTANCE well under a chunk-loading concern, a real timeout on the wander itself)
// rather than searching further and further outward.
const EXPLORE_DISTANCE = 40;
const EXPLORE_TIMEOUT_MS = 30_000;

async function wanderAndRetryFind(bot, token, findOptions) {
  if (token.cancelled) return [];
  const angle = Math.random() * Math.PI * 2;
  const dx = Math.round(Math.cos(angle) * EXPLORE_DISTANCE);
  const dz = Math.round(Math.sin(angle) * EXPLORE_DISTANCE);
  const target = bot.entity.position.offset(dx, 0, dz);
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 4)),
      EXPLORE_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch {
    // Couldn't fully reach the wander point (cliff, water, whatever's out there) -- still worth
    // searching from wherever she actually ended up rather than giving up on wandering entirely.
  } finally {
    bot.pathfinder.setGoal(null);
  }
  if (token.cancelled) return [];
  return bot.findBlocks(findOptions);
}

export function loadActionPlugins(bot) {
  bot.loadPlugin(collectBlockPkg.plugin);
  bot.loadPlugin(pvpPkg.plugin);
  loadEquipmentPlugins(bot);
}

// Best-effort, deliberately swallows its own errors: called after any action that might have
// changed the inventory (mine, attack, loot) so gear stays current without a separate request
// -- a failure here should never turn a successful action into a reported failure.
async function refreshGear(bot) {
  try {
    await equipBestArmor(bot);
    await equipBestWeapon(bot);
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

let cancelToken = { cancelled: false };

function stopCurrent(bot) {
  cancelToken.cancelled = true;
  cancelToken = { cancelled: false };
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  bot.collectBlock.cancelTask(); // real cancellation, not just how we interpret the eventual result
  // Real bug found live, 2026-09-07 (chasing an all-day recurring OOM crash the coder/coder2
  // triage service kept flagging but never pinpointed): confirmed against mineflayer-collectblock's
  // own source that cancelTask() ONLY calls bot.pathfinder.stop() -- collectBlock's mineBlock()
  // calls the CORE bot.dig() directly, entirely outside pathfinder's control, so cancelTask() does
  // nothing to an in-flight dig. mineflayer's own dig.js registers a per-block
  // `blockUpdate:${position}` listener that only ever gets removed by that exact dig completing
  // or by bot.stopDigging() -- neither happens here, so every action interrupted mid-dig (this
  // function runs before EVERY new action, including the frequent self-defense/emergency
  // interrupts) orphaned that listener and its pending promise permanently. bot.stopDigging() is
  // its own safe no-op when nothing is currently being dug (checked internally against
  // bot.targetDigBlock), so this is harmless to call unconditionally.
  bot.stopDigging();
  // Any new action (a direct command, or the goal loop wanting to do something else) should
  // interrupt a night's sleep rather than queue up behind it -- every performAction() call
  // starts here, so this is the one place that's guaranteed to run before anything else happens.
  if (bot.isSleeping) bot.wake().catch((err) => console.error("stopCurrent: wake failed:", err.message));
  return cancelToken;
}

export async function performAction(bot, action, speaker) {
  const token = stopCurrent(bot);
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });

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
        bot.pathfinder.setGoal(null);
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
      const findOptions = { matching: blockIds, maxDistance: 32, count: action.count };
      let positions = bot.findBlocks(findOptions);
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, findOptions);
      if (!positions.length) return fail(`couldn't find any ${action.block} nearby, even after looking around.`);
      const blocks = positions.map((pos) => bot.blockAt(pos)).filter(Boolean);
      // Report what she actually found/collected, not just the name she was originally given --
      // asked for "oak_log" but the only trees around were spruce, this should say so rather than
      // claiming oak_log when resolveBlockFamily is what actually made that substitution work.
      const collectedNames = [...new Set(blocks.map((b) => b.name))].join(", ");
      try {
        await withTimeout(bot.collectBlock.collect(blocks, { ignoreNoPath: true }), ACTION_TIMEOUT_MS,
                           () => { bot.collectBlock.cancelTask(); bot.stopDigging(); });
      } catch (err) {
        if (token.cancelled) return ok("stopped mining early.");
        return fail(`had trouble mining ${collectedNames}: ${err.message}`);
      } finally {
        await refreshGear(bot); // may have picked up something worth wearing/wielding
      }
      return token.cancelled ? ok("stopped mining early.") : ok(`collected some ${collectedNames}.`);
    }

    case "craft": {
      const itemDef = bot.registry.itemsByName[action.item];
      if (!itemDef) return fail(`I don't recognize the item "${action.item}".`);

      // Does this need a table? `true` satisfies recipesFor()'s own requiresTable check
      // without needing a real Block reference yet -- confirmed against mineflayer's own
      // craft.js source -- this is only checking whether a table would help, not using one.
      const noTableRecipes = bot.recipesFor(itemDef.id, null, 1, null);
      const tableWouldHelp = !noTableRecipes.length && bot.recipesFor(itemDef.id, null, 1, true).length > 0;
      let tableBlock = null;
      if (tableWouldHelp) {
        const tableType = bot.registry.blocksByName.crafting_table;
        const positions = tableType ? bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }) : [];
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
          bot.pathfinder.setGoal(null);
        }
        if (token.cancelled) return ok("stopped on the way to a crafting table.");
      }

      try {
        await craftItem(bot, action.item, action.count, tableBlock);
      } catch (err) {
        return fail(`couldn't craft ${action.item}: ${err.message}`);
      } finally {
        await refreshGear(bot); // a freshly-crafted tool/weapon/armor piece should get equipped
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

      let sawObstruction = false;
      for (const pos of positions) {
        if (token.cancelled) return ok("stopped on the way to a chest.");
        const chestBlock = bot.blockAt(pos);
        if (!chestBlock) continue;

        // Real error found live (2026-09-06): openChest() waited its own internal 20s timeout
        // ("Event windowOpen did not fire") against a chest that vanilla Minecraft will never
        // actually open -- any solid block directly above EITHER half of a double chest blocks
        // the whole thing, a real, common world-state issue, not a bug in this code.
        if (chestObstructed(bot, chestBlock)) {
          sawObstruction = true;
          continue; // try the next candidate instead of giving up entirely
        }

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
            chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
        } catch (err) {
          if (token.cancelled) return ok("stopped on the way to a chest.");
          continue; // couldn't reach this one -- try the next candidate
        } finally {
          bot.pathfinder.setGoal(null);
        }
        if (token.cancelled) return ok("stopped on the way to a chest.");

        let taken = [];
        try {
          const chest = await bot.openChest(chestBlock);
          // Real bug found live (2026-09-06), the actual root cause after two wrong guesses
          // (a timing delay, then a "wrong chest" theory -- both ruled out by direct testing):
          // Window.items() returns itemsRange(inventoryStart, inventoryEnd) -- the PLAYER'S OWN
          // inventory slots within the combined window, not the container's. A chest confirmed
          // (by a human, in-game) to hold two netherite pickaxes correctly logged as "(empty)"
          // every time because Babs' own inventory was empty, not the chest. containerItems()
          // (itemsRange(0, inventoryStart)) is the actual container-only view.
          const contents = chest.containerItems();
          console.log(`[loot] chest contents: ${contents.map((i) => `${i.name}x${i.count}`).join(", ") || "(empty)"}`);
          const gear = contents.filter((i) => isEssentialItem(i.name));
          for (const item of gear) {
            try {
              await chest.withdraw(item.type, null, item.count);
              taken.push(item.name);
            } catch (err) {
              console.error(`loot: failed to withdraw ${item.name}:`, err.message);
            }
          }
          await chest.close();
        } catch (err) {
          continue; // couldn't open this one (e.g. windowOpen timeout) -- try the next candidate
        }
        await refreshGear(bot);
        // Finding nothing worth taking is a completed check, not a failed one -- an empty/
        // already-looted chest is a legitimate outcome, not the bot getting stuck.
        return ok(taken.length ? `found ${taken.join(", ")} in a chest.` : "checked a chest, nothing worth taking.");
      }
      return fail(sawObstruction
        ? "found chests nearby, but they're all obstructed."
        : "found chests nearby, but couldn't reach or open any of them.");
    }

    case "attack": {
      const target = nearestHostile(bot);
      if (!target) return fail("no hostile mobs nearby.");
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
      // bot.pvp.attack() resolves its own promise once the target is dead or lost -- no need
      // for a manually-wired event listener (confirmed against mineflayer-pvp's own .d.ts).
      try {
        await withTimeout(bot.pvp.attack(target), ACTION_TIMEOUT_MS, () => bot.pvp.stop());
      } catch (err) {
        if (token.cancelled) return ok("broke off the fight.");
        return fail("gave up on the fight -- took too long.");
      } finally {
        await refreshGear(bot); // mob drops may include something worth wearing/wielding
      }
      return token.cancelled ? ok("broke off the fight.") : ok("took care of it.");
    }

    case "flee": {
      // Fourth of five scoped enhancements ("what other logic enhancements are available" ->
      // self-defense). GoalInvert negates the wrapped goal's heuristic, so pathfinder actively
      // maximizes distance from the threat instead of closing it -- confirmed against
      // mineflayer-pathfinder's own goals.js (heuristic() returns -goal.heuristic(); isEnd()
      // returns !goal.isEnd(), so the flee goal is "reached" once genuinely outside the wrapped
      // GoalFollow's own radius, not an arbitrary duration this code has to guess at).
      const target = nearestHostile(bot);
      if (!target) return ok("nothing to flee from.");
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalFollow(target, 16))),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped fleeing.");
        return fail(`couldn't get away: ${err.message}`);
      } finally {
        bot.pathfinder.setGoal(null);
      }
      return token.cancelled ? ok("stopped fleeing.") : ok("got some distance from it.");
    }

    case "eat": {
      // Direct request, 2026-09-07: hunger management. Built on mineflayer's own core
      // consume() (confirmed against inventory.js source: requires the food already equipped
      // to hand -- bot.equip() first, the same pattern already used for fuel/tools elsewhere in
      // this file).
      const foodItem = bot.inventory.items().find((i) => FOOD_NAMES.includes(i.name));
      if (!foodItem) return fail("don't have anything to eat.");
      try {
        await bot.equip(foodItem, "hand");
        await bot.consume();
      } catch (err) {
        return fail(`couldn't eat: ${err.message}`);
      } finally {
        await refreshGear(bot); // consume() leaves the food item held -- get a real weapon back
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
        bot.pathfinder.setGoal(null);
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
        await refreshGear(bot); // fish() leaves the rod held -- get a real weapon back
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

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(target, 2)), ACTION_TIMEOUT_MS,
          () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way.");
        return fail(`couldn't reach ${action.player}: ${err.message}`);
      } finally {
        bot.pathfinder.setGoal(null);
      }
      if (token.cancelled) return ok("stopped on the way.");

      try {
        await bot.toss(itemDef.id, null, giveCount);
      } catch (err) {
        return fail(`couldn't give the ${action.item}: ${err.message}`);
      }
      return ok(`gave ${giveCount} ${action.item} to ${action.player}.`);
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
      const positions = bot.findBlocks({ matching: (block) => bot.isABed(block), maxDistance: 32,
                                          count: MAX_CANDIDATES });
      if (!positions.length) return fail("couldn't find a bed nearby.");

      for (const pos of positions) {
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
          bot.pathfinder.setGoal(null);
        }
        if (token.cancelled) return ok("stopped on the way to bed.");

        try {
          await bot.sleep(bedBlock);
        } catch (err) {
          console.log(`[sleep] couldn't use bed at ${bedBlock.position}: ${err.message}`);
          continue; // this bed didn't work (occupied, monsters nearby, too far, etc) -- try next
        }

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
          bot.pathfinder.setGoal(null);
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
          // One fuel item per item smelted is a generous overestimate for any fuel type (coal
          // alone smelts 8 per item) -- errs toward "definitely enough fuel" over precision.
          await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, smeltCount));
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
      const storeFindOptions = { matching: matchIds, maxDistance: 32, count: 3 };
      let positions = bot.findBlocks(storeFindOptions);
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, storeFindOptions);
      if (!positions.length) return fail("couldn't find a chest nearby, even after looking around.");

      for (const pos of positions) {
        if (token.cancelled) return ok("stopped on the way to a chest.");
        const chestBlock = bot.blockAt(pos);
        if (!chestBlock || chestObstructed(bot, chestBlock)) continue;

        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
            chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
            () => bot.pathfinder.setGoal(null));
        } catch (err) {
          if (token.cancelled) return ok("stopped on the way to a chest.");
          continue; // couldn't reach this one -- try the next candidate
        } finally {
          bot.pathfinder.setGoal(null);
        }
        if (token.cancelled) return ok("stopped on the way to a chest.");

        try {
          const chest = await bot.openChest(chestBlock);
          await chest.deposit(itemDef.id, null, storeCount);
          await chest.close();
        } catch (err) {
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
        bot.pathfinder.setGoal(null);
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
        bot.pathfinder.setGoal(null);
      }
      if (token.cancelled) return ok("gave up heading back.");
      // Give auto-pickup a moment to actually register nearby items before reporting done.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await refreshGear(bot);
      return ok("made it back to recover what I could.");
    }

    case "harvest": {
      // Direct request, 2026-09-07 ("what else can we add" -> farming, a sustainable food
      // source instead of always depending on looted/found food). Simpler than farming from
      // scratch: harvest a crop that's already ripe and replant, rather than placing on bare
      // dirt. Ages/replant items confirmed against minecraft-data's own block-state definitions
      // (wheat/carrots/potatoes: age 0-7, mature at 7; beetroots: age 0-3, mature at 3).
      const CROP_MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
      const CROP_REPLANT = { wheat: "wheat_seeds", carrots: "carrot", potatoes: "potato", beetroots: "beetroot_seeds" };
      const cropIds = Object.keys(CROP_MAX_AGE).map((n) => bot.registry.blocksByName[n]?.id)
        .filter((id) => id !== undefined);
      if (!cropIds.length) return fail("don't know how to recognize any crops here.");

      // Real gap avoided here, not found live: findBlocks' own function-matcher path (used for
      // beds/sleep elsewhere in this file) was never confirmed to populate real block-state
      // properties DURING the search itself -- rather than assume, this searches broadly by
      // block TYPE (the proven-reliable pattern, same as loot/smelt/store) and checks maturity
      // afterward via direct bot.blockAt() calls, the exact pattern already confirmed working
      // for the double-chest obstruction check.
      const positions = bot.findBlocks({ matching: cropIds, maxDistance: 32, count: 15 });
      const matureBlocks = positions.map((pos) => bot.blockAt(pos))
        .filter((block) => block && Number(block.getProperties?.().age) === CROP_MAX_AGE[block.name]);
      if (!matureBlocks.length) return fail("couldn't find any ripe crops nearby.");
      const cropBlock = matureBlocks[0];

      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(cropBlock.position.x,
          cropBlock.position.y, cropBlock.position.z, 2)), ACTION_TIMEOUT_MS,
          () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return ok("stopped on the way to the crop.");
        return fail(`couldn't reach the crop: ${err.message}`);
      } finally {
        bot.pathfinder.setGoal(null);
      }
      if (token.cancelled) return ok("stopped on the way to the crop.");

      const farmlandPos = cropBlock.position.offset(0, -1, 0); // the crop sits on this block
      try {
        // Real gap found live, 2026-09-07 (chasing an all-day recurring OOM crash): a bare
        // bot.dig() with no timeout at all -- if it never settles (confirmed against dig.js's own
        // source: it awaits a promise that only resolves via a per-block blockUpdate listener or
        // bot.stopDigging(), neither guaranteed here), this would hang forever with no recovery,
        // same underlying risk "mine"'s own withTimeout exists to prevent.
        await withTimeout(bot.dig(cropBlock), ACTION_TIMEOUT_MS, () => bot.stopDigging());
      } catch (err) {
        if (token.cancelled) return ok("stopped harvesting.");
        return fail(`couldn't harvest the ${cropBlock.name}: ${err.message}`);
      }

      const seedName = CROP_REPLANT[cropBlock.name];
      const seedItem = bot.inventory.items().find((i) => i.name === seedName);
      let replanted = false;
      if (seedItem) {
        try {
          await bot.equip(seedItem, "hand");
          await bot.placeBlock(bot.blockAt(farmlandPos), new Vec3(0, 1, 0));
          replanted = true;
        } catch (err) {
          console.error(`harvest: replant failed:`, err.message); // harvest itself still succeeded
        }
      }
      await refreshGear(bot);
      return ok(`harvested some ${cropBlock.name}${replanted ? " and replanted" : ""}.`);
    }

    case "breed": {
      // Direct request, 2026-09-07 ("what else can we add" -> animal breeding, the other half
      // of a sustainable food source). Built on mineflayer's own activateEntity() (core --
      // confirmed against inventory.js source: right-clicks the entity while holding whatever's
      // equipped, exactly vanilla's own feed-to-breed mechanic, no dedicated "breed" API needed).
      const BREEDING_FOOD = {
        cow: ["wheat"], sheep: ["wheat"], pig: ["carrot", "potato", "beetroot"],
        chicken: ["wheat_seeds", "pumpkin_seeds", "melon_seeds", "beetroot_seeds"],
      };
      const foods = BREEDING_FOOD[action.species];
      if (!foods) return fail(`don't know how to breed a ${action.species}.`);
      const foodItem = bot.inventory.items().find((i) => foods.includes(i.name));
      if (!foodItem) return fail(`don't have the right food to breed a ${action.species} (need ${foods[0]}).`);

      const animals = Object.values(bot.entities)
        .filter((e) => e.name === action.species && e.position.distanceTo(bot.entity.position) <= 24)
        .slice(0, 2);
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
          bot.pathfinder.setGoal(null);
        }
      }
      if (!fed) return fail(`couldn't get close enough to feed any ${action.species}s.`);
      return ok(`fed ${fed} ${action.species}${fed > 1 ? "s" : ""} -- hopefully a baby soon.`);
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
        bot.pathfinder.setGoal(null);
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
}
