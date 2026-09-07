// Version: 1.9.1
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
import { loadEquipmentPlugins, equipBestArmor, equipBestWeapon } from "./equipment.js";

const { goals } = pathfinderPkg;

const ACTION_TIMEOUT_MS = 60_000;
// A real Minecraft night (or the wait for it to naturally pass while sleeping) runs several
// real-world minutes even at normal speed -- ACTION_TIMEOUT_MS (60s) would abort a perfectly
// normal night's sleep as a "failure." This is a safety backstop for something going genuinely
// wrong (a stuck day/night cycle, a disabled gamerule), not the expected case.
const SLEEP_TIMEOUT_MS = 15 * 60_000;

const HOSTILE_MOBS = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "spider", "cave_spider",
  "creeper", "enderman", "witch", "phantom", "slime", "magma_cube", "silverfish", "blaze",
  "ghast", "guardian", "elder_guardian", "shulker", "vex", "vindicator", "evoker", "pillager",
  "ravager", "hoglin", "zoglin", "piglin_brute", "warden",
]);

// Suffix-matched, same convention as equipment.js -- what's worth pulling out of a chest.
// Food/blocks/misc items are left behind; this is specifically about gearing up.
const GEAR_SUFFIXES = [
  "_helmet", "_chestplate", "_leggings", "_boots", "_sword", "_axe", "_pickaxe", "_shovel", "_hoe",
];

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

let cancelToken = { cancelled: false };

function stopCurrent(bot) {
  cancelToken.cancelled = true;
  cancelToken = { cancelled: false };
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  bot.collectBlock.cancelTask(); // real cancellation, not just how we interpret the eventual result
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
      const blockType = bot.registry.blocksByName[action.block];
      if (!blockType) return fail(`I don't recognize the block "${action.block}".`);
      const positions = bot.findBlocks({ matching: blockType.id, maxDistance: 32, count: action.count });
      if (!positions.length) return fail(`couldn't find any ${action.block} nearby.`);
      const blocks = positions.map((pos) => bot.blockAt(pos)).filter(Boolean);
      try {
        await withTimeout(bot.collectBlock.collect(blocks, { ignoreNoPath: true }), ACTION_TIMEOUT_MS,
                           () => bot.collectBlock.cancelTask());
      } catch (err) {
        if (token.cancelled) return ok("stopped mining early.");
        return fail(`had trouble mining ${action.block}: ${err.message}`);
      } finally {
        await refreshGear(bot); // may have picked up something worth wearing/wielding
      }
      return token.cancelled ? ok("stopped mining early.") : ok(`collected some ${action.block}.`);
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
      const positions = bot.findBlocks({ matching: matchIds, maxDistance: 32, count: MAX_CANDIDATES });
      if (!positions.length) return fail("couldn't find any chests nearby.");

      let sawObstruction = false;
      for (const pos of positions) {
        if (token.cancelled) return ok("stopped on the way to a chest.");
        const chestBlock = bot.blockAt(pos);
        if (!chestBlock) continue;

        // Real error found live (2026-09-06): openChest() waited its own internal 20s timeout
        // ("Event windowOpen did not fire") against a chest that vanilla Minecraft will never
        // actually open -- any solid block directly above EITHER half of a double chest blocks
        // the whole thing, a real, common world-state issue, not a bug in this code. Scanning
        // cardinal neighbors for the matching paired half (rather than trusting a memorized
        // left/right-to-offset convention) is more robust than computing it from facing+type.
        const chestHalves = [chestBlock];
        if (chestBlock.getProperties?.().type !== undefined) {
          const facing = chestBlock.getProperties().facing;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const neighbor = bot.blockAt(chestBlock.position.offset(dx, 0, dz));
            if (neighbor?.name === chestBlock.name && neighbor.getProperties?.().facing === facing) {
              chestHalves.push(neighbor);
              break;
            }
          }
        }
        const obstructed = chestHalves.some(
          (half) => bot.blockAt(half.position.offset(0, 1, 0))?.boundingBox === "block");
        if (obstructed) {
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
          const gear = contents.filter((i) => GEAR_SUFFIXES.some((s) => i.name.endsWith(s)));
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
      const target = bot.nearestEntity((e) => e.type === "mob" && HOSTILE_MOBS.has(e.name));
      if (!target) return fail("no hostile mobs nearby.");
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

    default:
      return fail("not sure how to do that yet.");
  }
}
