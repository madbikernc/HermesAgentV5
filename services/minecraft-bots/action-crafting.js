// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of actions.js (2.0.0) unchanged: crafting, and taking items from nearby chests.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. actions.js imports
// it; this file reads actions.js's state through live imports, so nothing here may touch it
// before actions.js has run (only declarations live here).

import { chestHalves } from "./shelter.js";
import { findKnownChestWithItem, noteUtilityOutcome, recordChestSnapshot } from "./action-chests.js";
import { recipeInputs, simpleSourceFor, withTimeout } from "./action-movement.js";
import { CHEST_SEARCH_RADIUS, hopToward } from "./action-search.js";
import { ACTION_TIMEOUT_MS, goals } from "./action-vocab.js";


// minecraft-data already knows every vanilla recipe correctly (Recipe.ingredients,
// Recipe.requiresTable, etc., confirmed against prismarine-recipe's own types) -- there is no
// external recipe data to "teach" it. What's actually missing is this: given a target item and
// current inventory, find a recipe that's affordable *right now* (bot.recipesFor() already
// filters to exactly that -- confirmed against mineflayer's own craft.js source), and if none
// is, check whether the shortfall is one of the common intermediates above and, if so, craft
// that first before retrying. depth guards against a pathological cycle; the known chains above
// are acyclic in practice (stick/table <- planks <- log) so this rarely recurses past 1.
export async function craftItem(bot, itemName, count, tableBlock, depth = 0) {
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
      // separate mineflayer API this doesn't implement) -- skipping a recipe whose inputs can't be
      // read means an unsupported smelting-only item now fails cleanly ("don't have the
      // ingredients") instead of crashing the bot's whole craft/goal step. (2026-10-07: that
      // "can't be read" test moved into recipeInputs(), which also reads SHAPED recipes -- the
      // original here only looked at `ingredients` and so skipped every shaped one as well.)
      const inputs = recipeInputs(recipe);
      if (!inputs) continue;
      // 2026-11-01: count() takes an item id. Given the name it always read 0, so with a recipe per
      // plank species (a wooden hoe has 12) every variant made more sticks, until Babs' 4 birch
      // planks were 16 sticks and no hoe. And once one variant is affordable, stop.
      // 2026-11-05: for every run of the recipe, not one. 23 fences is 8 runs (16 sticks); holding
      // enough for a single run (2), no stick was made, and "craft birch_fence" failed "don't have
      // the ingredients" every tick -- Dale never built a pen.
      const runs = Math.ceil(count / (recipe.result?.count || 1));
      for (const ing of inputs) {
        const ingName = bot.registry.items[ing.id]?.name;
        if (!ingName) continue;
        const need = ing.count * runs;
        const have = bot.inventory.count(ing.id, null);
        if (have >= need) continue;
        if (simpleSourceFor(bot, ingName)) {
          await craftItem(bot, ingName, need - have, tableBlock, depth + 1);
          // bot.craft() resolves before the inventory shows what it made; recipesFor() below would
          // read the old counts (live, 2026-11-05: 16 sticks made, the fences still "no ingredients").
          for (let waited = 0; waited < 3000 && bot.inventory.count(ing.id, null) < need; waited += 100) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      if (bot.recipesFor(itemDef.id, null, count, tableBlock ?? null).length) break;
    }
    recipes = bot.recipesFor(itemDef.id, null, count, tableBlock ?? null);
  }
  if (!recipes.length) {
    throw new Error(`don't have the ingredients${tableBlock ? "" : " (might need a crafting table)"}`);
  }
  // `count` is items wanted, which is how recipesFor() read it just above -- but bot.craft()'s
  // count is how many times to run the recipe. Passing it straight through (until 2026-10-29)
  // asked for 4x the planks, 3x the fences, 4x the torches: "craft 30 planks" with 8 logs passed
  // the recipesFor check and then failed on the 9th craft, every tick, all afternoon.
  // 2026-11-05: one run per bot.craft() call, each waited for. With several runs in one call,
  // mineflayer's next run works from an inventory the server hasn't updated yet: it ran one of four
  // stick runs without an error, and threw "missing ingredient" partway through 8 runs of fences --
  // Dale's pen never got built. `count` is items wanted (2026-10-29), so the runs stop once the
  // inventory shows that many made.
  const held = () => bot.inventory.count(itemDef.id, null);
  const before = held();
  const runs = Math.ceil(count / recipes[0].result.count);
  for (let run = 0; run < runs + 2 && held() - before < count; run++) { // +2: a run the server dropped
    const recipe = run === 0 ? recipes[0] : bot.recipesFor(itemDef.id, null, 1, tableBlock ?? null)[0];
    if (!recipe) break;
    const had = held();
    await bot.craft(recipe, 1, tableBlock ?? undefined);
    for (let waited = 0; waited < 1500 && held() <= had; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// Extracted from "loot" (2026-09-06's own real find, see 1.5.0's history) so "store" (2026-09-07,
// "do all" -> base/chest storage) can reuse the exact same check instead of a second copy
// drifting out of sync. Any solid block directly above EITHER half of a double chest blocks the
// whole thing in vanilla.
//
// 2026-10-07: the half-finding half of this moved to shelter.js as chestHalves() -- the new
// "never place a block that impedes access to a chest" rule needs the same two positions to
// decide whether a placement would CREATE this condition, and two copies of a double-chest
// pairing convention drifting apart is exactly what extracting this helper avoided the first time.
export function chestObstructed(bot, chestBlock) {
  return chestHalves(bot, chestBlock).some((half) => bot.blockAt(half.offset(0, 1, 0))?.boundingBox === "block");
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

export async function tryTakeFromNearbyChest(bot, token, itemNames, wantCount) {
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
  const positions = bot.findBlocks({ matching: matchIds, maxDistance: CHEST_SEARCH_RADIUS, count: CHEST_CHECK_MAX_CANDIDATES });

  for (const pos of positions) {
    if (token.cancelled) return null;
    const chestBlock = bot.blockAt(pos);
    if (!chestBlock) continue;
    if (chestObstructed(bot, chestBlock)) { noteUtilityOutcome("chest", chestBlock.position, false); continue; }
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
    if (!chestBlock) continue;
    if (chestObstructed(bot, chestBlock)) { noteUtilityOutcome("chest", chestBlock.position, false); continue; }
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
export async function tryTakeFromThisChest(bot, token, chestBlock, itemNames, wantCount) {
  await hopToward(bot, token, chestBlock.position);
  if (token.cancelled) return "cancelled";
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x,
      chestBlock.position.y, chestBlock.position.z, 2)), ACTION_TIMEOUT_MS,
      () => bot.pathfinder.setGoal(null));
  } catch {
    noteUtilityOutcome("chest", chestBlock.position, false);
    return null; // couldn't reach this one -- try the next candidate
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return "cancelled";

  let chest = null;
  try {
    chest = await bot.openChest(chestBlock);
    const contents = chest.containerItems();
    noteUtilityOutcome("chest", chestBlock.position, true); // opened fine -- usable, even if empty
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
      await recordChestSnapshot(chestBlock.position, contents, chest.inventoryStart);
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
    await recordChestSnapshot(chestBlock.position, chest.containerItems(), chest.inventoryStart);
    return taken ? { name: firstName, count: taken } : null;
  } catch {
    noteUtilityOutcome("chest", chestBlock.position, false);
    return null; // couldn't open this one -- try the next candidate
  } finally {
    try { await chest?.close(); } catch { /* already closed */ }
  }
}
