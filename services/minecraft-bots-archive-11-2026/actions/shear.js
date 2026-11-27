// Version: 1.0.0
//
// The "shear" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, goals, refreshGear, withTimeout } from "../actions.js";


export async function shearAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-11 (§15.11 follow-up -- "shear/milk verb for non-bee animals").
  // Real vanilla shearing has no dedicated mineflayer API beyond the generic right-click
  // primitive -- bot.activateEntity() (core, the same primitive "breed" already uses to feed
  // an animal) simulates it here too. No pre-check for "already sheared, wool hasn't regrown
  // yet" -- mineflayer's own entity-metadata index for that flag isn't confirmed stable
  // across versions, so this just tries and lets the server be the source of truth, same
  // discipline "breed" already applies to a cooldown it also doesn't pre-check.
  const shears = bot.inventory.items().find((i) => i.name === "shears");
  if (!shears) return fail("don't have shears.");

  const sheep = Object.values(bot.entities)
    .filter((e) => e.name === "sheep" && e.position.distanceTo(bot.entity.position) <= 24)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  if (!sheep) return fail("no sheep nearby to shear.");

  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(sheep, 2)), ACTION_TIMEOUT_MS,
      () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped on the way to the sheep.");
    return fail(`couldn't reach the sheep: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("stopped before shearing.");

  try {
    await bot.equip(shears, "hand");
    await bot.activateEntity(sheep);
  } catch (err) {
    return fail(`couldn't shear the sheep: ${err.message}`);
  }
  await refreshGear(bot);
  return ok("sheared a sheep for wool.");
}
