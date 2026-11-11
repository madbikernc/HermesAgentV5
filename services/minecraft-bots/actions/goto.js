// Version: 1.0.0
//
// The "goto" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, goals, withTimeout } from "../actions.js";


export async function gotoAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  const target = bot.players[speaker]?.entity;
  if (!target) return fail(`I can't see ${speaker} nearby.`);
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(target, 2)), ACTION_TIMEOUT_MS,
                       () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped on the way.");
    return fail(`couldn't reach ${speaker}: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  return token.cancelled ? ok("stopped on the way.") : ok(`reached ${speaker}.`);
}
