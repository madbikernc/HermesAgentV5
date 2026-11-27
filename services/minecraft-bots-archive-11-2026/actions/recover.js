// Version: 1.0.0
//
// The "recover" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, goals, refreshGear, withTimeout } from "../actions.js";


export async function recoverAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07 ("do all" -> death/respawn handling). Vanilla drops
  // everything at the death location on a 5-minute despawn timer (unless keepInventory is
  // on) -- worth trying to get back before it's gone. Picking items up is automatic on
  // proximity, no dedicated mineflayer API needed -- just getting there is the whole job.
  // action.position is a plain {x,y,z} (index.js's own captured bot.entity.position at the
  // moment of death), not a real action verb a player/planner would ever construct by hand.
  const { position } = action;
  if (!position) return fail("don't know where I died.");
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1)),
      ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("gave up heading back.");
    return fail(`couldn't get back to where I died: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("gave up heading back.");
  // Give auto-pickup a moment to actually register nearby items before reporting done.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await refreshGear(bot);
  return ok("made it back to recover what I could.");
}
