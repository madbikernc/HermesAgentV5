// Version: 1.6.2
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

let cancelToken = { cancelled: false };

function stopCurrent(bot) {
  cancelToken.cancelled = true;
  cancelToken = { cancelled: false };
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  bot.collectBlock.cancelTask(); // real cancellation, not just how we interpret the eventual result
  return cancelToken;
}

export async function performAction(bot, action, speaker) {
  const token = stopCurrent(bot);

  switch (action.type) {
    case "stop":
      return "stopped.";

    case "goto": {
      const target = bot.players[speaker]?.entity;
      if (!target) return `I can't see ${speaker} nearby.`;
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(target, 2)), ACTION_TIMEOUT_MS,
                           () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return "stopped on the way.";
        return `couldn't reach ${speaker}: ${err.message}`;
      } finally {
        bot.pathfinder.setGoal(null);
      }
      return token.cancelled ? "stopped on the way." : `reached ${speaker}.`;
    }

    case "follow": {
      const target = bot.players[speaker]?.entity;
      if (!target) return `I can't see ${speaker} nearby.`;
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); // dynamic: keeps tracking
      return `following ${speaker} now.`;
    }

    case "mine": {
      const blockType = bot.registry.blocksByName[action.block];
      if (!blockType) return `I don't recognize the block "${action.block}".`;
      const positions = bot.findBlocks({ matching: blockType.id, maxDistance: 32, count: action.count });
      if (!positions.length) return `couldn't find any ${action.block} nearby.`;
      const blocks = positions.map((pos) => bot.blockAt(pos)).filter(Boolean);
      try {
        await withTimeout(bot.collectBlock.collect(blocks, { ignoreNoPath: true }), ACTION_TIMEOUT_MS,
                           () => bot.collectBlock.cancelTask());
      } catch (err) {
        if (token.cancelled) return "stopped mining early.";
        return `had trouble mining ${action.block}: ${err.message}`;
      } finally {
        await refreshGear(bot); // may have picked up something worth wearing/wielding
      }
      return token.cancelled ? "stopped mining early." : `collected some ${action.block}.`;
    }

    case "loot": {
      const chestType = bot.registry.blocksByName.chest;
      const trappedType = bot.registry.blocksByName.trapped_chest;
      const matchIds = [chestType?.id, trappedType?.id].filter((id) => id !== undefined);
      if (!matchIds.length) return "don't know how to recognize a chest here.";
      const positions = bot.findBlocks({ matching: matchIds, maxDistance: 32, count: 1 });
      if (!positions.length) return "couldn't find any chests nearby.";
      const chestBlock = bot.blockAt(positions[0]);
      // Real error found live (2026-09-06): openChest() waited its own internal 20s timeout
      // ("Event windowOpen did not fire") against a chest that vanilla Minecraft will never
      // actually open -- any solid block directly above EITHER half of a double chest blocks
      // the whole thing, a real, common world-state issue, not a bug in this code. First
      // version of this check only looked above the single block findBlocks happened to
      // return; real evidence from a live failure (getProperties() showed {type: "right",
      // facing: "east"}) confirmed this chest is one half of a double chest, and the *other*
      // half's obstruction was never checked. Scanning cardinal neighbors for the matching
      // paired half (rather than trusting a memorized left/right-to-offset convention) is more
      // robust than computing it from facing+type directly.
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
      for (const half of chestHalves) {
        const above = bot.blockAt(half.position.offset(0, 1, 0));
        if (above?.boundingBox === "block") {
          return "found a chest, but there's something on top of it blocking the lid.";
        }
      }
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
          chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
          () => bot.pathfinder.setGoal(null));
      } catch (err) {
        if (token.cancelled) return "stopped on the way to a chest.";
        return `couldn't reach a chest: ${err.message}`;
      } finally {
        bot.pathfinder.setGoal(null);
      }
      if (token.cancelled) return "stopped on the way to a chest.";

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
        return `found a chest but couldn't open it: ${err.message}`;
      }
      await refreshGear(bot);
      return taken.length ? `found ${taken.join(", ")} in a chest.` : "checked a chest, nothing worth taking.";
    }

    case "attack": {
      const target = bot.nearestEntity((e) => e.type === "mob" && HOSTILE_MOBS.has(e.name));
      if (!target) return "no hostile mobs nearby.";
      // bot.pvp.attack() resolves its own promise once the target is dead or lost -- no need
      // for a manually-wired event listener (confirmed against mineflayer-pvp's own .d.ts).
      try {
        await withTimeout(bot.pvp.attack(target), ACTION_TIMEOUT_MS, () => bot.pvp.stop());
      } catch (err) {
        if (token.cancelled) return "broke off the fight.";
        return "gave up on the fight -- took too long.";
      } finally {
        await refreshGear(bot); // mob drops may include something worth wearing/wielding
      }
      return token.cancelled ? "broke off the fight." : "took care of it.";
    }

    default:
      return "not sure how to do that yet.";
  }
}
