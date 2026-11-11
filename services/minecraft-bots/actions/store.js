// Version: 1.0.0
//
// The "store" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, CHEST_SEARCH_RADIUS, STORE_CANDIDATE_LIMIT, chestObstructed, goals, hopToward, loadKnownChests, noteUtilityOutcome, rankStoreChests, recordChestSnapshot, wanderAndRetryFind, withTimeout } from "../actions.js";


export async function storeAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
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
  // 2026-11-07: candidates are ranked by what the fleet knows each chest holds (rankStoreChests),
  // so an item joins its own kind instead of going into whichever chest is nearest.
  const storeFindOptions = { matching: matchIds, maxDistance: CHEST_SEARCH_RADIUS, count: 8, point: action.near };
  const searchPoint = action.near ? new Vec3(action.near.x, action.near.y, action.near.z) : bot.entity.position;
  const known = await loadKnownChests();
  let ranked = rankStoreChests(known, bot.findBlocks(storeFindOptions), action.item, searchPoint);
  if (!ranked.length) ranked = rankStoreChests(known, await wanderAndRetryFind(bot, token, storeFindOptions), action.item, searchPoint);
  if (!ranked.length) return fail("couldn't find a chest nearby, even after looking around.");

  for (const { position: pos, tier } of ranked.slice(0, STORE_CANDIDATE_LIMIT)) {
    if (token.cancelled) return ok("stopped on the way to a chest.");
    const chestBlock = bot.blockAt(pos);
    if (chestBlock && !matchIds.includes(chestBlock.type)) {
      console.log(`[store] skipping remembered chest at ${pos}: it's ${chestBlock.name} now.`);
      continue;
    }
    if (chestBlock && tier <= 1) {
      console.log(`[store] ${action.item} -> chest at ${pos}, which already holds ${tier === 0 ? "some" : "the same kind"}.`);
    }
    // Real live gap, found 2026-10-07 investigating spark's own store_failure_rate baseline
    // (0.781, already the worst metric in the fleet): this candidate was still as silent as
    // the other two the 2026-09-09 fix closed -- blockAt() returning nothing for a position
    // findBlocks() just reported (stale/unloaded chunk) left zero trace, same undiagnosable
    // shape as the obstruction and deposit-failure cases just below.
    if (!chestBlock) {
      console.log(`[store] skipping chest at ${pos}: blockAt() returned nothing (unloaded chunk?).`);
      continue;
    }
    // Real live gap, 2026-09-09: this and the pathfinder catch just below were exactly as
    // silent as the deposit failure right after them ("found chests nearby, but couldn't
    // store anything in any of them" with zero clue why) -- a real occurrence of this
    // failure showed no deposit-failure log at all, meaning it was skipped here or below
    // instead, neither of which said so. Logged for the same reason.
    if (chestObstructed(bot, chestBlock)) {
      console.log(`[store] skipping chest at ${chestBlock.position}: obstructed (blocked above).`);
      noteUtilityOutcome("chest", chestBlock.position, false);
      continue;
    }

    await hopToward(bot, token, chestBlock.position);
    if (token.cancelled) return ok("stopped on the way to a chest.");
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
        chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
        () => bot.pathfinder.setGoal(null));
    } catch (err) {
      if (token.cancelled) return ok("stopped on the way to a chest.");
      console.log(`[store] couldn't reach chest at ${chestBlock.position}: ${err.message}`);
      noteUtilityOutcome("chest", chestBlock.position, false);
      continue; // couldn't reach this one -- try the next candidate
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return ok("stopped on the way to a chest.");

    try {
      const chest = await bot.openChest(chestBlock);
      noteUtilityOutcome("chest", chestBlock.position, true);
      await chest.deposit(itemDef.id, null, storeCount);
      // Direct request, 2026-09-13 ("remember what is in chests when someone opens it") --
      // a deposit is exactly as real a change to this chest's contents as a withdrawal.
      await recordChestSnapshot(chestBlock.position, chest.containerItems(), chest.inventoryStart);
      await chest.close();
    } catch (err) {
      // Real live gap found 2026-09-09 (storeSurplusNearHome's own post-craft cleanup
      // failed twice, live, with zero visibility into why): silently swallowing this per-
      // candidate reason meant "found chests nearby, but couldn't store anything in any of
      // them" was undiagnosable from the log alone -- same lesson "sleep" already learned
      // once (2026-09-07) for its own multi-candidate loop, never applied here until now.
      console.log(`[store] couldn't deposit into chest at ${chestBlock.position}: ${err.message}`);
      noteUtilityOutcome("chest", chestBlock.position, false);
      continue; // couldn't open/deposit into this one -- try the next candidate
    }
    return ok(`stored ${storeCount} ${action.item} in a chest.`);
  }
  return fail("found chests nearby, but couldn't store anything in any of them.");
}
