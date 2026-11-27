// Version: 1.0.0
//
// The "repair_terrain" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { wouldBlockAccess } from "../shelter.js";
import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, clearCellForPlacement, goals, isProtectedBlockName, withTimeout } from "../actions.js";


export async function repairTerrainAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // §15.10: fills action.position (the pit's lowest empty spot, as {x, y, z, targetY} --
  // index.js's checkTerrainDamage() found and validated this, not decided here) one block at
  // a time, bottom-up, up to targetY -- the fleet's own home-level grade.
  const { x, y, z, targetY } = action.position;
  const PIT_FILL_BATCH_LIMIT = 8;
  const columnBase = new Vec3(x, y, z);

  // Material: an explicit override (action.material) wins -- checkTerrainDamage sets this
  // only when the spot needs to stay plantable (§15.10's "guided by function" case).
  // Otherwise sample the solid blocks immediately surrounding the pit's rim and fill with
  // whichever is most common -- cosmetic repair blends into what's already there.
  let materialName = action.material;
  if (!materialName) {
    const rimOffsets = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                         [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]];
    const counts = new Map();
    for (const [dx, dy, dz] of rimOffsets) {
      const block = bot.blockAt(columnBase.offset(dx, dy, dz));
      if (block?.boundingBox === "block" && !isProtectedBlockName(block.name)) {
        counts.set(block.name, (counts.get(block.name) || 0) + 1);
      }
    }
    let bestCount = 0;
    for (const [name, count] of counts) {
      if (count > bestCount) { materialName = name; bestCount = count; }
    }
  }
  if (!materialName) return fail("couldn't tell what material belongs here -- no solid neighbors to match.");

  const materialItem = bot.inventory.items().find((i) => i.name === materialName);
  if (!materialItem) return fail(`need ${materialName} to fill this in -- don't have any.`);

  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3)), ACTION_TIMEOUT_MS,
                       () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped on the way to the repair site.");
    return fail(`couldn't reach the spot to repair: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("stopped before repairing.");

  let placed = 0;
  for (let dy = 0; dy <= targetY - y && placed < PIT_FILL_BATCH_LIMIT; dy++) {
    if (token.cancelled) break;
    const pos = columnBase.offset(0, dy, 0);
    const existing = bot.blockAt(pos);
    if (existing?.boundingBox === "block") continue; // already solid -- a lower layer, or someone beat her to it
    // 2026-10-07: terrain repair fills bottom-up toward the surrounding grade, which is
    // exactly how a pit dug right next to a chest gets filled back in over the top of it.
    // Stop the column here rather than skipping the layer -- everything above it would be
    // left unsupported anyway (see the `below` check just under this).
    const shuts = wouldBlockAccess(bot, pos, materialName);
    if (shuts) {
      console.log(`repair_terrain: stopped at ${pos} -- filling it would block ${shuts.reason} the ${shuts.fixture}`);
      break;
    }

    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || below.boundingBox !== "block") break; // nothing to reference off yet -- next visit catches it once the layer below is filled

    const item = bot.inventory.items().find((i) => i.name === materialName);
    if (!item) break; // ran out mid-fill
    try {
      await clearCellForPlacement(bot, pos);
      await bot.equip(item, "hand");
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      placed++;
    } catch (err) {
      console.error(`repair_terrain: placement failed at ${pos}:`, err.message);
      break;
    }
  }

  if (token.cancelled) return ok(`stopped repairing (${placed} block(s) filled).`);
  if (!placed) return fail("couldn't fill in the damage -- nothing placed.");
  return ok(`filled in ${placed} block(s) of damage with ${materialName}.`);
}
