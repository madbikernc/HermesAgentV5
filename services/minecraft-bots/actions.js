// Version: 1.3.0
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
      // actually open -- any solid block directly above a chest blocks it, a real, common
      // world-state issue, not a bug in this code. Checking first turns a cryptic 20s hang
      // into an immediate, specific answer.
      const above = bot.blockAt(chestBlock.position.offset(0, 1, 0));
      if (above?.boundingBox === "block") {
        return "found a chest, but there's something on top of it blocking the lid.";
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
        const gear = chest.items().filter((i) => GEAR_SUFFIXES.some((s) => i.name.endsWith(s)));
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
