// Version: 1.0.0
//
// The "gather_seeds" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, GATHER_SEEDS_MAX_DIGS, SEED_GRASS, collectDrops, goals, withTimeout } from "../actions.js";


export async function gatherSeedsAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // 2026-11-01: a bot standing in for a missing Farmer or Herder could only get seeds from a
  // chest, and every chest was empty. Grass and ferns drop wheat seeds about one time in eight.
  const want = action.count ?? 8;
  const seeds = () => bot.inventory.items().filter((i) => i.name === "wheat_seeds").reduce((n, i) => n + i.count, 0);
  const start = seeds();
  const grassIds = SEED_GRASS.map((name) => bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined);
  const spots = bot.findBlocks({ matching: grassIds, maxDistance: 32, count: GATHER_SEEDS_MAX_DIGS });
  if (!spots.length) return fail("no grass nearby to gather seeds from.");
  let broken = 0;
  let dug = [];
  for (const pos of spots) {
    if (token.cancelled || seeds() - start >= want) break;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      continue;
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) break;
    const block = bot.blockAt(pos);
    if (!block || !grassIds.includes(block.type)) continue;
    try {
      await withTimeout(bot.dig(block), ACTION_TIMEOUT_MS, () => bot.stopDigging());
    } catch {
      continue;
    }
    broken++;
    dug.push(pos);
    if (dug.length >= 6) {
      await bot.waitForTicks(4); // the drop lands a few ticks after the block breaks
      await collectDrops(bot, token, dug, 5000);
      dug = [];
    }
  }
  if (dug.length && !token.cancelled) {
    await bot.waitForTicks(4);
    await collectDrops(bot, token, dug, 5000);
  }
  if (token.cancelled) return ok("stopped gathering seeds.");
  const gained = seeds() - start;
  if (gained > 0) return ok(`gathered ${gained} wheat seeds from the grass (now carrying ${seeds()}).`);
  return fail(broken ? `broke ${broken} grass, and no seeds dropped.` : "couldn't reach any of the grass nearby.");
}
