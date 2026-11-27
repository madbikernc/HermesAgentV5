// Version: 1.0.0
//
// The "eat" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { FOOD_NAMES, refreshGear } from "../actions.js";


export async function eatAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07: hunger management. Built on mineflayer's own core
  // consume() (confirmed against inventory.js source: requires the food already equipped
  // to hand -- bot.equip() first, the same pattern already used for fuel/tools elsewhere in
  // this file).
  // Review MB-15: best-first by FOOD_NAMES order (cooked before raw), golden apples saved for last
  // -- not whatever inventory slot happens to come first.
  // 2026-10-30: action.lastResort also allows rotten flesh -- starving with nothing else, its 4
  // food points beat its chance of Hunger.
  const edible = (name) => FOOD_NAMES.includes(name) || (action.lastResort && name === "rotten_flesh");
  const eatRank = (name) => (name === "rotten_flesh" ? 2000 : 0) + (name.includes("golden_apple") ? 1000 : 0) + FOOD_NAMES.indexOf(name);
  const foodItem = bot.inventory.items().filter((i) => edible(i.name))
    .sort((a, b) => eatRank(a.name) - eatRank(b.name))[0];
  if (!foodItem) return fail("don't have anything to eat.");
  try {
    await bot.equip(foodItem, "hand");
    await bot.consume();
  } catch (err) {
    return fail(`couldn't eat: ${err.message}`);
  } finally {
    if (!token.cancelled) await refreshGear(bot); // consume() leaves the food item held -- get a real weapon back
  }
  return ok(`ate some ${foodItem.name}.`);
}
