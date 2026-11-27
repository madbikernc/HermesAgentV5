// Version: 1.0.0
//
// The "milk" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, goals, refreshGear, withTimeout } from "../actions.js";


export async function milkAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Same primitive as "shear" just above, different tool/species -- an empty bucket
  // right-clicked on a cow (core bot.activateEntity()) returns a filled milk_bucket, real
  // vanilla mechanic, no dedicated API.
  const bucket = bot.inventory.items().find((i) => i.name === "bucket");
  if (!bucket) return fail("don't have an empty bucket.");

  const cow = Object.values(bot.entities)
    .filter((e) => e.name === "cow" && e.position.distanceTo(bot.entity.position) <= 24)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  if (!cow) return fail("no cow nearby to milk.");

  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(cow, 2)), ACTION_TIMEOUT_MS,
      () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped on the way to the cow.");
    return fail(`couldn't reach the cow: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("stopped before milking.");

  try {
    await bot.equip(bucket, "hand");
    await bot.activateEntity(cow);
  } catch (err) {
    return fail(`couldn't milk the cow: ${err.message}`);
  }
  await refreshGear(bot);
  return ok("milked a cow.");
}
