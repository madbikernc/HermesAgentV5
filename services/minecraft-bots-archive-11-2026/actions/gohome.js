// Version: 1.0.0
//
// The "gohome" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, attemptBoatCrossing, goals, withTimeout } from "../actions.js";


export async function gohomeAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07: "bots should pay attention to the time of day, and try to
  // return 'home' before full dark." bot.spawnPoint (confirmed against mineflayer's own
  // spawn_point.js source: populated from the server's own spawn_position packet -- her bed
  // if she's claimed one, otherwise the world spawn) is the same real "home" reference the
  // teleport-when-stuck mechanism already uses -- one shared notion of home, not a second one.
  const dest = bot.spawnPoint;
  if (!dest || (dest.x === 0 && dest.y === 0 && dest.z === 0)) {
    return fail("don't know where home is yet.");
  }
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 3)),
      ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped heading home.");
    // Direct request, 2026-09-07 ("build the water crossing mechanic"): a normal walking
    // route failing (timeout/no-path) is exactly the shape water-blocked routes take --
    // worth one real attempt at a boat crossing before giving up outright, rather than
    // stranding her every dusk a lake happens to sit between here and spawn.
    if (await attemptBoatCrossing(bot, token, dest)) {
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 3)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
        return ok("made it home before dark (by boat).");
      } catch {
        return ok("got most of the way home by boat, on foot from here.");
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
    }
    return fail(`couldn't make it home: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  return token.cancelled ? ok("stopped heading home.") : ok("made it home before dark.");
}
