// Version: 1.0.0
//
// The "place" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { wouldBlockAccess } from "../shelter.js";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, clearCellForPlacement, goals, withTimeout } from "../actions.js";


export async function placeAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07: bots could craft a furnace or crafting table but had no way
  // to actually use one they made themselves, only ones already sitting in the world -- a
  // real dead end hit live tonight. Deliberately narrow: ONE utility block, right next to
  // herself, not a general building capability -- structure placement stays explicitly out
  // of scope (see this file's own header). Built on mineflayer's own placeBlock() (core, no
  // extra plugin).
  const heldCandidate = bot.inventory.items().find((i) => i.name === action.item);
  if (!heldCandidate) return fail(`don't have a ${action.item} to place.`);

  try {
    await bot.equip(heldCandidate, "hand");
  } catch (err) {
    return fail(`couldn't hold the ${action.item} to place it: ${err.message}`);
  }
  if (token.cancelled) return ok("stopped before placing it.");

  // 2026-11-04 (residences): `at`, one named cell -- a residence's chest goes in its room, not
  // wherever she stands. Walk within reach, then the same access check every placement makes.
  if (action.at) {
    const at = new Vec3(action.at.x, action.at.y, action.at.z);
    const ground = bot.blockAt(at.offset(0, -1, 0));
    if (ground?.boundingBox !== "block") return fail(`nothing to set the ${action.item} on at ${at}.`);
    if (bot.blockAt(at)?.boundingBox === "block") return fail(`something already stands at ${at}.`);
    const shuts = wouldBlockAccess(bot, at, action.item);
    if (shuts) return fail(`a ${action.item} at ${at} would block ${shuts.reason} the ${shuts.fixture} at ${shuts.at}.`);
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(at.x, at.y, at.z, 2)), ACTION_TIMEOUT_MS,
        () => bot.pathfinder.setGoal(null));
    } catch (err) {
      if (token.cancelled) return ok("stopped on the way.");
      return fail(`couldn't get to ${at} to place the ${action.item}: ${err.message}`);
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null);
    }
    try {
      await bot.equip(heldCandidate, "hand");
      await clearCellForPlacement(bot, at);
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
    } catch (err) {
      return fail(`couldn't place the ${action.item} at ${at}: ${err.message}`);
    }
    return ok(`placed a ${action.item} at ${at}.`);
  }

  // A cardinal-adjacent spot with solid ground and clear air above it -- simpler and more
  // robust than assuming the block directly below her own feet works, since that's
  // literally where she's standing.
  //
  // Direct request, 2026-10-07 ("never drop or place a block that will impede access to a
  // chest or bed or door"): four candidate spots were already being tried in order, so the
  // access check costs nothing but a skip -- a furnace set down in front of the shelter door
  // picks the next side instead. Only the LAST spot being blocked is a real refusal, and it
  // says which fixture it would have shut in rather than "no clear spot nearby" (which was
  // already this action's only failure message and would have been a lie here).
  const feet = bot.entity.position.floored();
  let referenceBlock = null;
  let wouldShutIn = null;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ground = bot.blockAt(feet.offset(dx, -1, dz));
    const space = bot.blockAt(feet.offset(dx, 0, dz));
    if (!(ground?.boundingBox === "block" && space && space.boundingBox !== "block")) continue;
    const shuts = wouldBlockAccess(bot, feet.offset(dx, 0, dz), action.item);
    if (shuts) { wouldShutIn = wouldShutIn || shuts; continue; }
    referenceBlock = ground;
    break;
  }
  if (!referenceBlock) {
    return fail(wouldShutIn
      ? `nowhere to put the ${action.item} that wouldn't block ${wouldShutIn.reason} ` +
        `the ${wouldShutIn.fixture} at ${wouldShutIn.at}.`
      : "no clear spot nearby to place it.");
  }

  try {
    await clearCellForPlacement(bot, referenceBlock.position.offset(0, 1, 0));
    await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
  } catch (err) {
    return fail(`couldn't place the ${action.item}: ${err.message}`);
  }
  return ok(`placed a ${action.item}.`);
}
