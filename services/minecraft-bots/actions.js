// Version: 1.0.0
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

const { goals } = pathfinderPkg;

const ACTION_TIMEOUT_MS = 60_000;

const HOSTILE_MOBS = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "spider", "cave_spider",
  "creeper", "enderman", "witch", "phantom", "slime", "magma_cube", "silverfish", "blaze",
  "ghast", "guardian", "elder_guardian", "shulker", "vex", "vindicator", "evoker", "pillager",
  "ravager", "hoglin", "zoglin", "piglin_brute", "warden",
]);

export function loadActionPlugins(bot) {
  bot.loadPlugin(collectBlockPkg.plugin);
  bot.loadPlugin(pvpPkg.plugin);
}

// Rejects after ACTION_TIMEOUT_MS rather than letting a bad path/target hang an action (and the
// busy-tracking below) forever -- a real risk with pathfinder/collectBlock/pvp promises that
// have no built-in timeout of their own.
function withTimeout(promise, ms = ACTION_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
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
        await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(target, 2)));
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
        await withTimeout(bot.collectBlock.collect(blocks, { ignoreNoPath: true }), 120_000);
      } catch (err) {
        if (token.cancelled) return "stopped mining early.";
        return `had trouble mining ${action.block}: ${err.message}`;
      }
      return token.cancelled ? "stopped mining early." : `collected some ${action.block}.`;
    }

    case "attack": {
      const target = bot.nearestEntity((e) => e.type === "mob" && HOSTILE_MOBS.has(e.name));
      if (!target) return "no hostile mobs nearby.";
      // bot.pvp.attack() resolves its own promise once the target is dead or lost -- no need
      // for a manually-wired event listener (confirmed against mineflayer-pvp's own .d.ts).
      try {
        await withTimeout(bot.pvp.attack(target));
      } catch (err) {
        if (token.cancelled) return "broke off the fight.";
        await bot.pvp.stop();
        return "gave up on the fight -- took too long.";
      }
      return token.cancelled ? "broke off the fight." : "took care of it.";
    }

    default:
      return "not sure how to do that yet.";
  }
}
