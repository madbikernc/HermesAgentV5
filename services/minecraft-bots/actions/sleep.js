// Version: 1.0.0
//
// The "sleep" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, SLEEP_TIMEOUT_MS, bedNearHazard, goals, nearbyBeds, visitRememberedSpot, withTimeout } from "../actions.js";


export async function sleepAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07: bots should know to go to bed at night. Built entirely on
  // mineflayer's own bed.js plugin (core, no extra plugin load needed) -- bot.sleep()
  // already handles the real vanilla rules (night-or-thunderstorm window, occupied bed,
  // monsters nearby, reach distance) and throws a specific reason for each, so this only
  // needs to find a bed and try it, same multi-candidate pattern as "loot" (1.8.2) since one
  // bad bed (occupied, monsters nearby right there) shouldn't block trying another.
  if (bot.isSleeping) return ok("already asleep.");

  // Direct request, 2026-10-18: no bed ownership -- "any bed not already occupied," trying the
  // next one until she finds one free, rather than a short, priority-banded candidate list
  // (her own claimed bed, then unclaimed, then others' as a last resort). nearbyBeds() (above)
  // is now just every usable bed nearest-first; bot.sleep()'s own real "occupied" rejection is
  // what actually tells a free bed from a taken one, caught and skipped below same as always.
  let candidates = nearbyBeds(bot, null);
  if (!candidates.length) {
    // 2026-10-27 (direct request: "seeking out a bed should not be limited to 'nearby'...
    // if it's a known resource that can be reached, they should use it to sleep"): same
    // local-then-remembered pattern mine/craft already use for crafting_table/furnace -- a
    // bed registered elsewhere on the server (runBedGoal's own writeMemoryNote, index.js) is
    // exactly as worth a trip as a remembered resource vein. A stale/wrong note just falls
    // through to the normal "couldn't find a bed nearby" failure below, no worse off.
    // 2026-10-28: ...and is forgotten, so the next attempt tries the next-nearest bed instead.
    candidates = await visitRememberedSpot(bot, token, "bed", () => nearbyBeds(bot, null));
  }
  if (!candidates.length) return fail("couldn't find a bed nearby.");

  for (const pos of candidates) {
    if (token.cancelled) return ok("stopped on the way to bed.");
    const bedBlock = bot.blockAt(pos);
    if (!bedBlock) continue;
    if (bedNearHazard(bot, bedBlock.position)) {
      console.log(`[sleep] skipping bed at ${bedBlock.position}: water/lava nearby.`);
      continue; // a bad bed to bond her respawn point to -- try the next candidate
    }

    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x,
        bedBlock.position.y, bedBlock.position.z, 2)), ACTION_TIMEOUT_MS,
        () => bot.pathfinder.setGoal(null));
    } catch (err) {
      if (token.cancelled) return ok("stopped on the way to bed.");
      // Real gap found live (2026-09-07): this used to swallow the reason silently -- when
      // every candidate failed, the only visible result was "couldn't use any of them,"
      // giving no way to diagnose why after the fact. Logging each per-candidate reason now,
      // same lesson already learned once today for the goal loop's own transitions.
      console.log(`[sleep] couldn't reach bed at ${bedBlock.position}: ${err.message}`);
      continue; // couldn't reach this bed -- try the next candidate
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return ok("stopped on the way to bed.");

    try {
      await bot.sleep(bedBlock);
    } catch (err) {
      console.log(`[sleep] couldn't use bed at ${bedBlock.position}: ${err.message}`);
      continue; // this bed didn't work (occupied, monsters nearby, too far, etc) -- try next
    }
    // Asleep now. Wait for the real 'wake' event (fires when day comes, or when everyone
    // sleeping lets the server skip the night) rather than guessing a duration -- a plain
    // safety timeout forces a wake only if something has gone genuinely wrong (SLEEP_TIMEOUT_MS
    // is well beyond a real night's length).
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      bot.once("wake", finish);
      setTimeout(() => {
        if (!settled && bot.isSleeping) bot.wake().catch(() => {});
        finish();
      }, SLEEP_TIMEOUT_MS);
    });
    return ok("slept through the night.");
  }
  return fail("found beds nearby, but couldn't use any of them.");
}
