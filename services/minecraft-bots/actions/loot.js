// Version: 1.0.0
//
// The "loot" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, CHEST_SEARCH_RADIUS, LOOT_GROUPS, chestObstructed, findKnownChestWithItem, gearCategoryNames, goals, hopToward, noteUtilityOutcome, recordChestSnapshot, refreshGear, tryTakeFromNearbyChest, tryTakeFromThisChest, wanderAndRetryFind, withTimeout } from "../actions.js";


export async function lootAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
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
  const lootFindOptions = { matching: matchIds, maxDistance: CHEST_SEARCH_RADIUS, count: MAX_CANDIDATES };
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
    const group = action.item === "wool" // any colour (2026-09-26)
      ? Object.keys(bot.registry.itemsByName).filter((n) => n.endsWith("_wool"))
      : LOOT_GROUPS[action.item]; // "food", "seeds" (2026-09-25)
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
      if (chestObstructed(bot, chestBlock)) {
        noteUtilityOutcome("chest", chestBlock.position, false);
        sawObstruction = true;
        continue;
      }
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
        if (chestBlock && chestObstructed(bot, chestBlock)) {
          noteUtilityOutcome("chest", chestBlock.position, false);
        } else if (chestBlock) {
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
    if (chestObstructed(bot, chestBlock)) {
      noteUtilityOutcome("chest", chestBlock.position, false);
      sawObstruction = true;
      continue;
    }

    await hopToward(bot, token, chestBlock.position);
    if (token.cancelled) return ok("stopped on the way to a chest.");
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
        chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
        () => bot.pathfinder.setGoal(null));
    } catch (err) {
      noteUtilityOutcome("chest", chestBlock.position, false);
      if (token.cancelled) return ok("stopped on the way to a chest.");
      continue; // couldn't reach this one -- try the next candidate
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return ok("stopped on the way to a chest.");

    try {
      const chest = await bot.openChest(chestBlock);
      noteUtilityOutcome("chest", chestBlock.position, true);
      // Real bug found live (2026-09-06): Window.items() returns itemsRange(inventoryStart,
      // inventoryEnd) -- the PLAYER'S OWN inventory slots within the combined window, not the
      // container's. containerItems() (itemsRange(0, inventoryStart)) is the actual
      // container-only view.
      const contents = chest.containerItems();
      console.log(`[loot] chest contents: ${contents.map((i) => `${i.name}x${i.count}`).join(", ") || "(empty)"}`);
      await recordChestSnapshot(chestBlock.position, contents, chest.inventoryStart);
      await chest.close();
      return ok(contents.length
        ? `checked a chest -- has ${contents.map((i) => `${i.count} ${i.name}`).join(", ")}.`
        : "checked a chest, it's empty.");
    } catch (err) {
      noteUtilityOutcome("chest", chestBlock.position, false);
      continue; // couldn't open this one (e.g. windowOpen timeout) -- try the next candidate
    }
  }
  return fail(sawObstruction
    ? "found chests nearby, but they're all obstructed."
    : "found chests nearby, but couldn't reach or open any of them.");
}
