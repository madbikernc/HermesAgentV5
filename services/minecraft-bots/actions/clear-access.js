// Version: 1.0.0
//
// The "clear_access" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { findAccessObstructions, ACCESS_SCAN_RADIUS } from "../shelter.js";
import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, goals, isProtectedBlockName, refreshGear, withTimeout } from "../actions.js";


export async function clearAccessAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-10-07: "allow them to destroy a block that impedes access to a bed
  // or chest or door." The companion to the refusals above -- those stop a bot creating the
  // condition, this one undoes it, whether a bot caused it (a pre-fix placement, a filled pit,
  // a dropped sand column) or the world did (gravel falling into a doorway, a creeper's
  // crater refilled by a landslide).
  //
  // Which cells count, which fixtures are off-limits to dig, and the two restraints on a
  // doorway built into solid ground all live in shelter.js's findAccessObstructions -- the
  // same geometry the placement refusals use, read the other way round. action.targets is the
  // caller's already-scanned list (index.js's checkAccessObstructions, matching
  // repair_terrain's own shape); bare, it scans for itself, which is what makes it a usable
  // SKILL_ACTION_VERB where repair_terrain isn't.
  const CLEAR_ACCESS_BATCH_LIMIT = 6;
  const targets = (action.targets?.length
    ? action.targets.map((t) => ({ ...t, position: new Vec3(t.position.x, t.position.y, t.position.z) }))
    : findAccessObstructions(bot, bot.entity.position, action.radius || ACCESS_SCAN_RADIUS,
                             (name) => !isProtectedBlockName(name)))
    .slice(0, CLEAR_ACCESS_BATCH_LIMIT);
  if (!targets.length) return ok("nothing's blocking a chest, bed or door around here.");

  let cleared = 0;
  const stillThere = [];
  for (const target of targets) {
    if (token.cancelled) break;
    // Re-check: another bot may have cleared this one since the scan, and a stale target from
    // action.targets may describe a block that's already gone.
    const block = bot.blockAt(target.position);
    if (!block || block.boundingBox !== "block" || isProtectedBlockName(block.name)) continue;

    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 3)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      if (token.cancelled) break;
      stillThere.push(`${block.name} at ${target.position}`);
      continue; // couldn't get to this one -- try the next
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) break;

    try {
      // collectBlock, not bot.dig: the block comes back into inventory instead of being left
      // on the floor to despawn, and it equips the right tool itself -- the same reasoning
      // "mine" already relies on. withTimeout/stopDigging per this file's own 2026-09-08 note
      // on untimed digs.
      await withTimeout(bot.collectBlock.collect(block, { ignoreNoPath: true }), ACTION_TIMEOUT_MS,
                        () => { bot.collectBlock.cancelTask(); bot.stopDigging(); });
      cleared++;
      console.log(`[${bot.username}] cleared a ${block.name} at ${target.position} blocking the ${target.fixture}`);
    } catch (err) {
      if (token.cancelled) break;
      stillThere.push(`${block.name} at ${target.position} (${err.message})`);
    }
  }
  if (!token.cancelled) await refreshGear(bot);

  if (token.cancelled) return ok(`stopped clearing access (${cleared} cleared).`);
  // Nothing cleared and nothing left in the way means another bot got there first -- nine bots
  // scan the same shared base, so this is the common case, not a failure. Reporting it as one
  // would put a steady stream of phantom failures into action_failure_rate.
  if (!cleared) {
    return stillThere.length
      ? fail(`couldn't clear what's blocking access: ${stillThere.join("; ")}.`)
      : ok("whatever was blocking a chest, bed or door is already gone.");
  }
  const fixtures = [...new Set(targets.map((t) => t.fixture))].join(", ");
  return ok(`cleared ${cleared} block(s) blocking access to ${fixtures}` +
    (stillThere.length ? `, ${stillThere.length} still in the way` : "") + ".");
}
