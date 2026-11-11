// Version: 1.0.0
//
// The "follow" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { goals } from "../actions.js";


export async function followAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  const target = bot.players[speaker]?.entity;
  if (!target) return fail(`I can't see ${speaker} nearby.`);
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); // dynamic: keeps tracking
  return ok(`following ${speaker} now.`);
}
