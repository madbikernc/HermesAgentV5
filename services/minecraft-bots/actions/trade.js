// Version: 1.0.0
//
// The "trade" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, goals, refreshGear, withTimeout } from "../actions.js";


export async function tradeAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07 ("do all" -> villager trading): a whole real mechanic (trade
  // UI, emeralds) untouched until now. Built on mineflayer's own openVillager()/trade()
  // (core) -- confirmed against villager.js source: trades expose .outputs[0].type, .inputs
  // (1-2 required items), .tradeDisabled (out of uses). <item> is the OUTPUT she wants, not
  // a trade index or price she'd have to already know -- this finds a matching, currently-
  // affordable, not-disabled trade herself. Deliberately direct-command only, not wired into
  // the goal planner's own vocabulary -- villager availability is unpredictable enough that
  // adding it there risks another hallucination surface rather than real capability.
  const villagerEntity = bot.nearestEntity((e) => e.name === "villager" &&
    e.position.distanceTo(bot.entity.position) <= 16);
  if (!villagerEntity) return fail("no villager nearby.");

  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(villagerEntity, 2)), ACTION_TIMEOUT_MS,
      () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped on the way to the villager.");
    return fail(`couldn't reach the villager: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("stopped on the way to the villager.");

  let villager;
  try {
    villager = await bot.openVillager(villagerEntity);
  } catch (err) {
    return fail(`couldn't open trading with the villager: ${err.message}`);
  }

  try {
    const wantedId = bot.registry.itemsByName[action.item]?.id;
    const tradeIndex = (villager.trades ?? []).findIndex((t) =>
      !t.tradeDisabled && t.outputs[0]?.type === wantedId &&
      t.inputs.every((ing) => bot.inventory.count(ing.type, null) >= ing.count));
    if (tradeIndex < 0) {
      await villager.close();
      return fail(`this villager doesn't have a usable trade for ${action.item}.`);
    }
    await bot.trade(villager, tradeIndex, 1);
    await villager.close();
  } catch (err) {
    try { await villager.close(); } catch { /* already closed or never opened cleanly */ }
    return fail(`couldn't complete the trade: ${err.message}`);
  }
  await refreshGear(bot);
  return ok(`traded with a villager for ${action.item}.`);
}
