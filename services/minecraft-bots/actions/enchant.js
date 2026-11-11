// Version: 1.0.0
//
// The "enchant" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, goals, refreshGear, wanderAndRetryFind, withTimeout } from "../actions.js";


export async function enchantAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
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
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
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
