// Version: 1.0.0
//
// The "build_pen" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { wouldBlockAccess } from "../shelter.js";
import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, clearCellForPlacement, findShelterSite, goals, savePenLocation, withTimeout } from "../actions.js";


export async function buildPenAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-11 (§15.11 follow-up -- pen/fence containment for bred animals).
  // Deliberately one fixed, small shape, same philosophy as "build"'s own shelter above: a
  // 5x5 fence perimeter (open top -- fences already block ground-bound animals without
  // needing a roof) with ONE fence_gate replacing a perimeter block so she isn't sealing
  // anything in without a way through. Not a general planner -- even "build" above isn't
  // one, see this file's own header on why.
  const fence = bot.inventory.items().find((i) => i.name.endsWith("_fence") && !i.name.endsWith("_fence_gate"));
  const gate = bot.inventory.items().find((i) => i.name.endsWith("_fence_gate"));
  if (!fence) return fail("don't have any fence blocks for a pen.");
  if (!gate) return fail("don't have a fence gate for a pen.");

  const base = action.at ? new Vec3(action.at.x, action.at.y, action.at.z).floored() : bot.entity.position.floored();
  const perimeter = [];
  // 2026-09-25: 7x7 (5x5 inside), was 5x5 -- a tempted animal stops ~2.5 blocks from her, so in a
  // 3x3 pen there was nowhere inside for it to stop.
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (Math.abs(dx) !== 3 && Math.abs(dz) !== 3) continue; // interior -- open pen floor, no fence here
      perimeter.push(base.offset(dx, 0, dz));
    }
  }
  const gatePos = base.offset(0, 0, 3); // south edge, middle -- the gate, matching "build"'s own doorway convention
  const fencePositions = perimeter.filter((p) => !(p.x === gatePos.x && p.y === gatePos.y && p.z === gatePos.z));
  const PEN_TOTAL = perimeter.length; // small fixed shape -- no extra batch cap needed

  let placed = 0;
  async function placeAt(pos, item) {
    const existing = bot.blockAt(pos);
    if (existing?.boundingBox === "block") { placed++; return true; }
    // 2026-10-07: a pen perimeter is laid out from where she stands with no site survey at
    // all (unlike "build", which has findShelterSite) -- it is the placement most likely to
    // run a fence straight across the shelter door. A gap in a pen leaks animals; a fenced-in
    // door strands the whole fleet, so the gap wins.
    const shuts = wouldBlockAccess(bot, pos, item.name);
    if (shuts) {
      console.log(`build_pen: skipped ${pos} -- a ${item.name} there would block ${shuts.reason} the ${shuts.fixture}`);
      return false;
    }
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      return false; // couldn't reach this one -- skip, matches "build"'s own tolerance for gaps
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return false;
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || below.boundingBox !== "block") return false; // no ground to reference off yet
    const current = bot.inventory.items().find((i) => i.name === item.name);
    if (!current) return false;
    try {
      await clearCellForPlacement(bot, pos);
      await bot.equip(current, "hand");
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      placed++;
      return true;
    } catch (err) {
      console.error(`build_pen: placement failed at ${pos}:`, err.message);
      return false;
    }
  }

  for (const pos of fencePositions) {
    if (token.cancelled) break;
    await placeAt(pos, fence);
  }
  const gatePlaced = token.cancelled ? false : await placeAt(gatePos, gate);

  if (token.cancelled) return ok(`stopped building the pen (${placed}/${PEN_TOTAL} placed).`);
  if (!placed) return fail("couldn't place any of the pen.");
  // Direct request, 2026-09-11 ("fix the pen herding"): only remember this pen's location if
  // the GATE specifically went in -- herd_to_pen needs a real, known entry point, and a
  // fence-without-a-gate isn't a usable pen regardless of how many wall segments landed.
  if (gatePlaced) await savePenLocation(base, gatePos);
  return ok(`built a small pen out of ${fence.name} with a ${gate.name} (${placed}/${PEN_TOTAL} placed).` +
    (gatePlaced ? "" : " gate didn't go in -- not usable for herding yet."));
}
