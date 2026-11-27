// Version: 1.0.0
//
// The "reface_shelter" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, goals, isCommunalShelterMaterial, isShelterMaterial, refreshGear, withTimeout } from "../actions.js";


export async function refaceShelterAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-10-28 ("once they have safe shelter to sleep in, they should
  // gradually replace the earth shelter with stone"): each given wall/roof/floor cell that
  // isn't stone-tier is dug out and immediately refilled with a stone-tier block
  // (isCommunalShelterMaterial), one cell at a time, so the shelter is never open by more
  // than one block. Same no-scaffolding movements as "patch_shelter". A floor cell she is
  // standing on is skipped -- digging it would drop her into the hole.
  const cells = (action.cells || []).map((p) => new Vec3(p.x, p.y, p.z));
  const stone = () => bot.inventory.items().filter((i) => isCommunalShelterMaterial(i.name)).sort((a, b) => b.count - a.count)[0];
  if (!stone()) return fail("don't have any stone to reinforce the shelter with.");

  const sharedMovements = bot.pathfinder.movements;
  const buildMovements = Object.assign(Object.create(Object.getPrototypeOf(sharedMovements)), sharedMovements);
  buildMovements.scafoldingBlocks = [];
  buildMovements.allow1by1towers = false;
  buildMovements.canDig = false; // never tunnel through her own walls to reach a cell
  bot.pathfinder.setMovements(buildMovements);

  let refaced = 0;
  try {
    for (const pos of cells) {
      if (token.cancelled) break;
      const current = bot.blockAt(pos);
      if (!current || isCommunalShelterMaterial(current.name) || current.boundingBox !== "block") continue;
      const item = stone();
      if (!item) break;
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch {
        if (token.cancelled) break;
        continue;
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null);
      }
      if (token.cancelled) break;
      if (bot.entity.position.floored().offset(0, -1, 0).equals(pos)) continue;
      try {
        await withTimeout(bot.dig(current, true), 10_000, () => bot.stopDigging());
      } catch (err) {
        console.error(`reface_shelter: couldn't dig ${current.name} at ${pos}:`, err.message);
        continue;
      }
      let refBlock = null, face = null;
      for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const neighbor = bot.blockAt(pos.offset(dx, dy, dz));
        if (neighbor?.boundingBox === "block") { refBlock = neighbor; face = new Vec3(-dx, -dy, -dz); break; }
      }
      try {
        if (!refBlock) throw new Error("no solid neighbour to place against");
        await bot.equip(item, "hand");
        await bot.placeBlock(refBlock, face);
        refaced++;
      } catch (err) {
        // The hole she just dug must not stay open: put back whatever plain block she has.
        console.error(`reface_shelter: placement failed at ${pos}:`, err.message);
        const fallback = bot.inventory.items().find((i) => isShelterMaterial(i.name));
        if (refBlock && fallback) {
          try { await bot.equip(fallback, "hand"); await bot.placeBlock(refBlock, face); } catch { /* checkShelterIntegrity patches it */ }
        }
      }
    }
  } finally {
    if (bot.pathfinder.movements === buildMovements) bot.pathfinder.setMovements(sharedMovements);
  }
  await refreshGear(bot);
  if (token.cancelled) return { ...ok(`stopped reinforcing the shelter (${refaced} block(s) swapped for stone).`), refaced };
  if (!refaced) return { ...fail("couldn't swap any of the shelter's blocks for stone."), refaced };
  return { ...ok(`reinforced the shelter: ${refaced} block(s) swapped for stone.`), refaced };
}
