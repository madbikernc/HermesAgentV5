// Version: 1.0.0
//
// The "craft" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { equipBestArmor, equipBestWeapon } from "../equipment.js";
import path from "node:path";
import { ACTION_TIMEOUT_MS, bedItemFor, craftItem, ensureBoat, findBedSites, findRememberedLocation, gearCategoryNames, goals, noteUtilityOutcome, performActionAs, refreshGear, tryTakeFromNearbyChest, visitRememberedSpot, withTimeout } from "../actions.js";


export async function craftAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  if (action.item === "bed" || action.item === "beds") action = { ...action, item: bedItemFor(bot) }; // beds come in colours
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
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 2 -- "a bot about to make any of these
  // checks shared world-memory... not just her own immediate 32-block view, before spending
  // materials on a duplicate"): extends the local-only check above with the SAME fleet-wide
  // findRememberedLocation() fallback tableWouldHelp's own workbench search already uses
  // (below) -- a table or furnace someone else placed out of this bot's own 32-block view,
  // or one she saw earlier and wandered away from, is exactly as worth remembering as a
  // resource vein. Chest deliberately excluded from this list: unlike a table or furnace, a
  // chest can legitimately need a second one once the first is full, so "one exists
  // somewhere" isn't by itself a reason to skip making another -- bedItemFor/findBedSites and
  // the shelter_capacity checklist item already have their own, fuller-aware "don't duplicate"
  // logic for beds and shelters respectively.
  const REUSABLE_UTILITY_BLOCKS = ["crafting_table", "furnace"];
  if (REUSABLE_UTILITY_BLOCKS.includes(action.item)) {
    const existingType = bot.registry.blocksByName[action.item];
    const findExisting = () => existingType ? bot.findBlocks({ matching: existingType.id, maxDistance: 32, count: 1 }) : [];
    let existing = findExisting();
    if (!existing.length) existing = await visitRememberedSpot(bot, token, action.item, findExisting);
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

  // Does this need a table? Real bug found live 2026-10-09 (direct report: bots "repeatedly
  // complain about crafting tables," yet never try to make one, never notice two standing
  // right next to them, and never remember either's location). Root cause, confirmed against
  // live logs: this used to call recipesFor(), which -- unlike recipesAll() -- filters to
  // recipes she can afford with her CURRENT inventory. With zero planks/sticks on hand (the
  // ordinary state before her first trip for wood), BOTH the no-table and with-table lookups
  // came back empty regardless of what the item's real recipe needs, tableWouldHelp was
  // always false, and the entire table search/remember/auto-make-and-place block below never
  // ran at all. Confirmed live: Nell's "craft wooden_pickaxe" failed in 78ms -- far too fast
  // to have pathfound anywhere or placed anything -- landing straight in craftItem()'s own
  // generic "don't have the ingredients (might need a crafting table)" guess, which several
  // bots then took at face value and self-proposed "gather wood to craft a crafting table"
  // for, even though a table was never actually the blocker. recipesAll() (the same call
  // craftItem's own fallback chain just below, and ensureBoat's own header, already use for
  // exactly this) answers the real, inventory-independent question instead -- does crafting
  // this item EVER need a table -- `true` satisfies its requiresTable check without needing a
  // real Block reference yet, confirmed against mineflayer's own craft.js source; this is
  // only checking whether a table would help, not using one.
  //
  // First live run of the above (2026-10-09) found a second, narrower real bug the unit tests
  // never could: "craft red_bed" (wool + planks, needs a table) STILL skipped the table search,
  // this time with noTableRecipes genuinely non-empty -- a colored bed ALSO has a real, no-table
  // *recycling* recipe (dye + an existing bed of another colour, confirmed live against this
  // server's own recipe data), so "!noTableRecipes.length" was simply the wrong question for any
  // item with more than one path to it. The real question is whether a table unlocks recipes she
  // doesn't have without one, not whether EVERY path happens to need one.
  const noTableRecipes = bot.recipesAll(itemDef.id, null, null);
  const withTableRecipes = bot.recipesAll(itemDef.id, null, true);
  const tableWouldHelp = withTableRecipes.length > noTableRecipes.length;
  let tableBlock = null;
  if (tableWouldHelp) {
    const tableType = bot.registry.blocksByName.crafting_table;
    const findTables = () => tableType ? bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }) : [];
    let positions = findTables();
    // 2026-10-30: action.here -- an urgent craft (a weapon, with mobs about) puts a carried table
    // down beside her instead of walking up to 32 blocks to one. Babs' wooden sword was
    // cancelled ten times in a row on the walk to a table, each time by a mob she had to flee.
    if (action.here && bot.inventory.items().some((i) => i.name === "crafting_table") &&
        !positions.some((p) => p.distanceTo(bot.entity.position) <= 4)) {
      const placed = await performActionAs(bot, { type: "place", item: "crafting_table" }, speaker, token);
      if (token.cancelled) return ok("stopped setting down a crafting table.");
      if (placed.ok) positions = findTables(); // nearest first: the one she just put down
    }
    // Direct request, 2026-09-13 ("extend resource sharing memory and scouting to *any*
    // resource or crafted object"): same local-search-first-remembered-location-second
    // pattern "mine" already uses -- a crafting table someone else placed (or one this bot
    // saw earlier and wandered away from) is exactly as worth remembering as an iron vein.
    if (!positions.length) positions = await visitRememberedSpot(bot, token, "crafting_table", findTables);
    if (!positions.length && action.item !== "crafting_table") {
      // 2026-09-26 (fresh world, live test): with no table anywhere yet, every table recipe --
      // a bed, a pickaxe, fences -- just failed. Make one (2x2, no table needed) and set it down.
      // 2026-10-29: one she already carries goes down first -- Babs had 11 in her pocket, each
      // made from planks the bed she was crafting then didn't have.
      const carried = bot.inventory.items().some((i) => i.name === "crafting_table");
      const made = carried ? { ok: true }
        : await performActionAs(bot, { type: "craft", item: "crafting_table", count: 1 }, speaker, token);
      if (made.ok && !token.cancelled) {
        const placed = await performActionAs(bot, { type: "place", item: "crafting_table" }, speaker, token);
        if (placed.ok) positions = tableType ? bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }) : [];
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
      noteUtilityOutcome("crafting_table", tableBlock.position, false);
      return fail(`couldn't reach a crafting table: ${err.message}`);
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return ok("stopped on the way to a crafting table.");
    // Reach success is the only clean usability signal here -- craftItem() can still fail
    // right after this for reasons that have nothing to do with the table (missing
    // ingredients), which must never be read as "this table is broken."
    noteUtilityOutcome("crafting_table", tableBlock.position, true);
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
