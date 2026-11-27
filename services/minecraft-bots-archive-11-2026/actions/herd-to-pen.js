// Version: 1.0.0
//
// The "herd_to_pen" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { holdDoorsOpen } from "../swim-movements.js";
import path from "node:path";
import { ACTION_TIMEOUT_MS, BREEDING_FOOD, HERD_SEARCH_RADIUS, goals, loadPenLocation, performAction, recordAchievement, refreshGear, withTimeout } from "../actions.js";


export async function herdToPenAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-11 ("fix the pen herding"): build_pen (above) only ever placed
  // the STRUCTURE -- the design doc's own §15.8 flagged this as a real, separate gap the day
  // it shipped ("build_pen places the structure but doesn't move an animal INTO it"). Reuses
  // a real vanilla mechanic rather than inventing one: an adult animal already follows
  // whoever's holding its tempting food (vanilla's own TemptGoal AI) once close enough --
  // exactly the same food/BREEDING_FOOD relationship "breed" already leans on, just used for
  // movement instead of feeding. Walks toward the pen in short, bounded hops (not one long
  // goto) specifically so the animal's own AI has a real chance to keep pace -- covering the
  // whole distance in one pathfinder goal would very likely outrun her and break the tempt
  // range partway there, with no way to notice until arrival.
  const pen = await loadPenLocation();
  if (!pen) return fail("no pen built yet -- build one first.");

  const foods = BREEDING_FOOD[action.species];
  if (!foods) return fail(`don't know what tempts a ${action.species}.`);
  const foodItem = bot.inventory.items().find((i) => foods.includes(i.name));
  if (!foodItem) return fail(`don't have the right food to lure a ${action.species} (need ${foods[0]}).`);

  const animal = Object.values(bot.entities)
    .filter((e) => e.name === action.species &&
      !(Math.abs(e.position.x - (pen.center.x + 0.5)) < 2.6 && Math.abs(e.position.z - (pen.center.z + 0.5)) < 2.6) && // not already penned
      e.position.distanceTo(bot.entity.position) <= HERD_SEARCH_RADIUS)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  if (!animal) return fail(`no loose ${action.species} nearby to herd.`);

  // Walk up to it empty-handed; the food comes out once she's there (below).
  try {
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 3)),
      ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped before reaching the animal.");
    return fail(`couldn't reach the ${action.species}: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("stopped before herding.");

  // 2026-09-25 (live test): the food comes out only now that she's at the animal -- held from the
  // start, the one already in the pen followed her out -- and the gate is held open only while
  // she leads (performAction used to hold it for the whole action, walk out included).
  const releaseDoors = holdDoorsOpen(bot);
  try {
    return await (async () => {
  try {
    await bot.equip(foodItem, "hand");
  } catch (err) {
    return fail(`couldn't hold the ${foodItem.name}: ${err.message}`);
  }


  const HERD_STEP_DISTANCE = 3;
  // 2026-11-06: enough steps for the distance -- 15 steps of 3 blocks stopped 45 blocks short of a
  // pen 64 away, the radius she now looks in.
  const HERD_MAX_STEPS = Math.min(40, Math.max(15, Math.ceil(animal.position.distanceTo(pen.gate) / HERD_STEP_DISTANCE) + 5));
  const HERD_FOLLOW_RANGE = 8; // generous margin over vanilla TemptGoal's own real tempt radius
  const waitForAnimal = async (done, ms) => {
    for (let waited = 0; waited < ms && !token.cancelled && !done(); waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  let steps = 0;
  while (steps < HERD_MAX_STEPS) {
    if (token.cancelled) return ok(`stopped herding partway (${steps} steps).`);
    // Real, checked distance every step -- never assumed still-following just because the
    // bot itself kept moving toward the pen.
    const liveAnimal = bot.entities[animal.id];
    if (!liveAnimal) return fail(`lost track of the ${action.species} -- it may have died or unloaded.`);
    if (liveAnimal.position.distanceTo(bot.entity.position) > HERD_FOLLOW_RANGE) {
      return fail(`the ${action.species} stopped following -- fell too far behind (${steps} steps in).`);
    }

    const toGate = pen.gate.minus(bot.entity.position);
    const dist = toGate.norm();
    if (dist < 1.5) break; // reached the gate

    const target = bot.entity.position.plus(toGate.normalize().scale(Math.min(HERD_STEP_DISTANCE, dist)));
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      if (token.cancelled) return ok(`stopped herding partway (${steps} steps).`);
      // couldn't complete this one short step -- not necessarily fatal, the animal-distance
      // check at the top of the next iteration is the real judge of whether to keep going
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    steps++;
    // 2026-09-25 (live test): a tempted animal walks slower than she does -- let it catch up
    // before the next step instead of outrunning it.
    await waitForAnimal(() => bot.entities[animal.id]?.position.distanceTo(bot.entity.position) <= 4, 3000);
  }

  // Final leg: through the gate to the pen's back wall. A tempted animal stops ~2.5 blocks short of
  // her, so leading only to the middle left it standing in the gateway (live test, 2026-09-25).
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(pen.center.x, pen.center.y, pen.center.z - 2)),
      ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch {
    // best effort -- the real success check below decides regardless of how this leg went
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }

  // It trails her in through the gate: wait for it to be inside the pen, not merely near it.
  const inPen = (e) => !!e && Math.abs(e.position.x - (pen.center.x + 0.5)) < 2.6 &&
    Math.abs(e.position.z - (pen.center.z + 0.5)) < 2.6;
  await waitForAnimal(() => inPen(bot.entities[animal.id]), 15_000);
  const finalAnimal = bot.entities[animal.id];
  if (!inPen(finalAnimal)) {
    return fail(`reached the pen, but the ${action.species} didn't follow all the way in.`);
  }

  // Close the gate behind her -- only toggle if it's actually open, never blind-toggle one
  // that's already shut (activateBlock on a fence gate flips its open/closed state).
  const gateBlock = bot.blockAt(pen.gate);
  if (gateBlock?.getProperties?.().open) {
    try {
      await bot.activateBlock(gateBlock);
    } catch (err) {
      console.error("herd_to_pen: couldn't close the gate:", err.message);
    }
  }

  await recordAchievement(bot, `penned:${action.species}`);
  return ok(`herded a ${action.species} into the pen.`);
    })();
  } finally {
    releaseDoors();
    await refreshGear(bot); // put the food away, or the animal follows her back out
  }
}
