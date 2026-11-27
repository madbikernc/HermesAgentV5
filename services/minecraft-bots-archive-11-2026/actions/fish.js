// Version: 1.0.0
//
// The "fish" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, FISH_TIMEOUT_MS, goals, refreshGear, wanderAndRetryFind, withTimeout } from "../actions.js";


export async function fishAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07 ("do 1-3" -> "and 4"): a passive, low-risk food source for
  // when there's no food on hand and no crops/animals nearby to harvest/breed. Built on
  // mineflayer's own core fish() (confirmed against fishing.js source: casts via
  // activateItem(), waits for the real bobber-splash particle event, then reels in itself --
  // no dedicated timing guess needed). fish() only resolves on an actual bite; it has no
  // built-in timeout of its own, so like every other open-ended wait in this file it's
  // wrapped in withTimeout, whose onTimeout calls activateItem() a second time to reel in
  // and cancel cleanly (confirmed: this is exactly how a real player aborts a cast, and the
  // plugin's own entity_destroy handler treats it as a clean cancellation, not an error).
  const rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
  if (!rod) return fail("don't have a fishing rod.");

  const waterType = bot.registry.blocksByName.water;
  if (!waterType) return fail("don't know how to recognize water here.");
  let positions = bot.findBlocks({ matching: waterType.id, maxDistance: 32, count: 5 });
  if (!positions.length) positions = await wanderAndRetryFind(bot, token,
    { matching: waterType.id, maxDistance: 32, count: 5 });
  if (!positions.length) return fail("couldn't find any water nearby, even after looking around.");
  const waterPos = positions[0];

  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(waterPos.x, waterPos.y, waterPos.z, 3)),
      ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped on the way to the water.");
    return fail(`couldn't reach the water: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("stopped on the way to the water.");

  try {
    await bot.equip(rod, "hand");
    await bot.lookAt(waterPos.offset(0.5, 1, 0.5));
    await withTimeout(bot.fish(), FISH_TIMEOUT_MS, () => bot.activateItem());
  } catch (err) {
    if (token.cancelled) return ok("stopped fishing.");
    return fail(`fishing didn't pan out: ${err.message}`);
  } finally {
    if (!token.cancelled) await refreshGear(bot); // fish() leaves the rod held -- get a real weapon back
  }
  return ok("caught something.");
}
