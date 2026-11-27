// Version: 1.1.0
//
// 1.1.0 (2026-11-26) -- direct report ("unresponsive, won't even run away or fight back from a
// mob"): root-caused live -- this action ignored action.maxDurationMs entirely, always running
// the full ACTION_TIMEOUT_MS (90s) no matter who called it. night-survival.js's onEmergencyHealth
// already passes a short EMERGENCY_ATTACK_TIMEOUT_MS (8s) leash for its "attack" branch (see that
// file's own 2026-09-21 header: "she doesn't have 90 seconds of margin to lose"), but a critically
// wounded, unarmed bot (decideFightType forces "flee" with no weapon, regardless of health) hits
// this file's own hardcoded ACTION_TIMEOUT_MS instead, holding HEALTH_CRITICAL-tier arbiter
// control -- and locking out every lower tier, including fresh self-defense re-evaluation -- for
// up to the full 90s on a single flee attempt that may be making no real progress at all. Now
// honours action.maxDurationMs exactly like attack.js already does, falling back to the standard
// ACTION_TIMEOUT_MS for every caller that doesn't set it (checkSelfDefense, respondToSquadCall).
//
// 1.0.0 (2026-11-10) -- split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, goals, nearestHostile, withTimeout } from "../actions.js";


export async function fleeAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Fourth of five scoped enhancements ("what other logic enhancements are available" ->
  // self-defense). GoalInvert negates the wrapped goal's heuristic, so pathfinder actively
  // maximizes distance from the threat instead of closing it -- confirmed against
  // mineflayer-pathfinder's own goals.js (heuristic() returns -goal.heuristic(); isEnd()
  // returns !goal.isEnd(), so the flee goal is "reached" once genuinely outside the wrapped
  // GoalFollow's own radius, not an arbitrary duration this code has to guess at).
  // Same fix as "attack" above -- use the already-found entity when the caller has one
  // instead of racing a second nearestHostile(bot) lookup against it moving/despawning.
  const target = action.target || nearestHostile(bot);
  if (!target) return ok("nothing to flee from.");
  // Direct request, 2026-09-18 ("run towards safety, run towards golems, or soldiers"):
  // index.js's checkSelfDefense/checkSleepingThreat/respondToSquadCall compute this (golem >
  // nearby Soldier teammate > home, in that priority -- see their own nearestRallyPoint())
  // since they're the ones with role/teammate-position knowledge; this action just heads
  // there instead of blindly maximizing distance with no destination in mind. Deliberately no
  // path-safety check between here and the rally point (same best-effort level as the rest of
  // self-defense) -- a rally point is only ever picked when it's a real place to go, not a
  // guarantee the route there is threat-free.
  const rally = action.rallyPoint;
  // Direct live observation, 2026-09-21 ("none of them fight back including the soldiers...
  // if the bots are inside a building with a zombie, they seem to act as if they are
  // trapped"). Root-caused live: fleeing shares the same canDig-enabled Movements every
  // other action uses (never explicitly set, so it's at mineflayer-pathfinder's own
  // default). In a small enclosed room, the only path that "increases distance" can require
  // digging through a wall -- when that dig fails, pathfinder recomputes the IDENTICAL
  // best-cost path (same dig step) and fails again immediately, forever: confirmed live via
  // path_reset: dig_error firing dozens of times a SECOND with an unchanged nodes/cost
  // signature, holding control the whole time while she's still being hit and (critically,
  // this is EMERGENCY/self-defense's own flee, which never attacks) never fights back
  // either. Disabling digging for just this one pathfind forces pathfinder to either find a
  // real walkable escape route or fail cleanly and fast, instead of spinning on an
  // impossible one until death.
  // Review MB-02 follow-up (2026-09-24): flee used to flip canDig on the ONE Movements object
  // every owner shares and restore it in finally -- after a preemption that restore landed in
  // the middle of the new owner's route. Flee now runs on its own shallow copy and only puts
  // the original back if its copy is still the active one.
  const sharedMovements = bot.pathfinder.movements;
  const fleeMovements = Object.assign(Object.create(Object.getPrototypeOf(sharedMovements)), sharedMovements);
  fleeMovements.canDig = false;
  bot.pathfinder.setMovements(fleeMovements);
  try {
    const goal = rally
      ? new goals.GoalNear(rally.x, rally.y, rally.z, 3)
      : new goals.GoalInvert(new goals.GoalFollow(target, 16));
    await withTimeout(bot.pathfinder.goto(goal), action.maxDurationMs ?? ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped fleeing.");
    return fail(`couldn't get away: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    if (bot.pathfinder.movements === fleeMovements) bot.pathfinder.setMovements(sharedMovements);
  }
  if (token.cancelled) return ok("stopped fleeing.");
  return ok(rally ? "made it to safety." : "got some distance from it.");
}
