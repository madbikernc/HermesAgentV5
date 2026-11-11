// Version: 1.0.0
//
// The "patch_shelter" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { wouldBlockAccess } from "../shelter.js";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, clearCellForPlacement, goals, isShelterMaterial, refreshGear, shelterMaterialCount, withTimeout } from "../actions.js";


export async function patchShelterAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-10-22, generalizing S42's fix: a shelter of ANY shape or size --
  // shelter.js's shelterRoomsNear()/holesIn() already found exactly which positions are
  // missing, from the real structure as it stands, not a predetermined geometry -- so unlike
  // "build"/"build_communal_shelter" above, this never computes its own position list. Door-
  // free by construction: holesIn() excludes every doorway cell, so there is never a door to
  // craft or place here, only the plain wall/floor/roof blocks a hole actually needs.
  // 2026-11-02: never fill a cell that keeps a door, bed or chest usable -- every other placer
  // already asks; this one didn't, and clear_access then dug the block straight back out.
  const holes = (action.holes || []).map((p) => new Vec3(p.x, p.y, p.z)).filter((pos) => !wouldBlockAccess(bot, pos));
  const missing = () => holes.filter((pos) => bot.blockAt(pos)?.boundingBox !== "block");
  const needed = missing();
  if (!needed.length) return { ...ok("no holes left to patch."), built: true };
  const have = shelterMaterialCount(bot);
  if (have < needed.length) {
    return { ...fail(`need ${needed.length} building blocks (dirt, cobblestone, planks...) to patch ` +
      `${needed.length} hole(s), only have ${have}.`), short: needed.length - have };
  }

  const sharedMovements = bot.pathfinder.movements;
  const buildMovements = Object.assign(Object.create(Object.getPrototypeOf(sharedMovements)), sharedMovements);
  buildMovements.scafoldingBlocks = [];
  buildMovements.allow1by1towers = false;
  bot.pathfinder.setMovements(buildMovements);

  let placed = 0;
  try {
    for (const pos of needed) {
      if (token.cancelled) break;
      if (bot.blockAt(pos)?.boundingBox === "block") continue; // another bot (or this same pass) already closed it
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch {
        if (token.cancelled) break;
        continue; // couldn't get near this one -- patch whatever else is reachable
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null);
      }
      if (token.cancelled) break;
      await clearCellForPlacement(bot, pos);

      let refBlock = null, face = null;
      for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const neighbor = bot.blockAt(pos.offset(dx, dy, dz));
        if (neighbor?.boundingBox === "block") { refBlock = neighbor; face = new Vec3(-dx, -dy, -dz); break; }
      }
      if (!refBlock) continue; // a hole with no solid neighbour left at all -- too damaged for this pass

      const item = bot.inventory.items().filter((i) => isShelterMaterial(i.name)).sort((a, b) => b.count - a.count)[0];
      if (!item) break;
      try {
        await bot.equip(item, "hand");
        await bot.placeBlock(refBlock, face);
        placed++;
      } catch (err) {
        console.error(`patch_shelter: placement failed at ${pos}:`, err.message);
      }
    }
  } finally {
    if (bot.pathfinder.movements === buildMovements) bot.pathfinder.setMovements(sharedMovements);
  }
  await refreshGear(bot);

  const left = missing().length;
  if (token.cancelled) return ok(`stopped patching the shelter (${placed} placed, ${left} hole(s) still open).`);
  if (!placed && left) return fail(`couldn't patch any of the shelter (${left} hole(s) still open).`);
  return { ...(left === 0 ? ok(`patched the shelter (${placed} hole(s) filled).`)
    : fail(`patched part of the shelter: ${placed} filled, ${left} hole(s) still open.`)), built: left === 0 };
}
