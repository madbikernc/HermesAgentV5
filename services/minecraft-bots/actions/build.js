// Version: 1.0.0
//
// The "build" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { wouldBlockAccess } from "../shelter.js";
import { isDoorway } from "../swim-movements.js";
import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, clearCellForPlacement, collectDrops, craftItem, doorItemFor, doorwayPosition, findShelterSite, goals, isShelterDoor, isShelterMaterial, performActionAs, refreshGear, shelterMaterialCount, shelterPositions, withTimeout } from "../actions.js";


export async function buildAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // A small fixed shelter (3x3, walls three high with a doorway, a roof). Rebuilt 2026-09-26:
  // any mix of plain building blocks (isShelterMaterial), only the blocks not already solid
  // count toward what she needs, and action.at puts it on a chosen site (a shelter goal's
  // findShelterSite) rather than wherever she stood. No site: around her, as before.
  const base = action.at ? new Vec3(action.at.x, action.at.y, action.at.z).floored() : bot.entity.position.floored();
  const buildOrder = shelterPositions(base);
  const missing = () => buildOrder.filter((pos) => bot.blockAt(pos)?.boundingBox !== "block").length;
  const needed = missing();
  const have = shelterMaterialCount(bot);
  if (needed && have < needed) {
    return { ...fail(`need ${needed} building blocks (dirt, cobblestone, planks...) for a small shelter, only have ${have}.`),
      short: needed - have };
  }

  // Pathfinder's default scaffolding blocks are dirt and cobblestone -- the shelter's own
  // materials -- so reaching for the roof she pillared up inside it and filled the interior
  // (live test, 2026-09-26). Build on a copy with no scaffolding and no pillaring (flee's
  // pattern), and reach 4 so the roof can be placed from the ground.
  const sharedMovements = bot.pathfinder.movements;
  const buildMovements = Object.assign(Object.create(Object.getPrototypeOf(sharedMovements)), sharedMovements);
  buildMovements.scafoldingBlocks = [];
  buildMovements.allow1by1towers = false;
  bot.pathfinder.setMovements(buildMovements);

  // Direct report, 2026-10-11 ("a real door, not an opening or arch"). Two real bugs found
  // live, not one: (1) getting the door ITEM has to happen before the generic wall/roof/floor
  // loop below -- oak_planks (or any species) counts as ordinary isShelterMaterial() too, so
  // letting that loop run first spent every plank she carried on walls (dirt/cobblestone work
  // just as well there) before the door, which has no substitute, ever got a turn: 20 planks
  // in hand, all gone to walls, "don't have the ingredients" for the door. (2) PLACING the
  // door, though, has to happen AFTER the walls -- confirmed live, placing it into open air
  // before any neighbouring wall exists gave it an east/west `facing` instead of north/south,
  // and doorPassageSides() (shelter.js) then protected the WALL cells beside the door as "the
  // way through" it instead of the cells actually in front of/behind it, so every one of
  // those walls refused to place. (No door held -> craft one; needs a table, which
  // craftItem's own fixed tableWouldHelp check, 1.83.1, already handles finding/making.)
  // 2026-10-30: correction to (2) -- a door's facing is the way SHE faces as it goes down, not
  // anything about its neighbours; see the placement below. A door already set in the doorway
  // the wrong way round comes out first, and goes back in the right way.
  const doorPos = doorwayPosition(base);
  let doorAlready = isShelterDoor(bot.blockAt(doorPos));
  if (!doorAlready && isDoorway(bot.blockAt(doorPos)) && !token.cancelled) {
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(doorPos.x, doorPos.y, doorPos.z, 3)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      if (!token.cancelled) await bot.dig(bot.blockAt(doorPos));
      // Pick the door back up, for the placement below -- its item entity shows up a moment
      // after dig() resolves, and collectDrops() gives up at once if there's nothing yet.
      const dropDeadline = Date.now() + 2000;
      while (Date.now() < dropDeadline && !token.cancelled &&
             !Object.values(bot.entities).some((e) => e.name === "item" && e.position.distanceTo(doorPos) <= 2)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!token.cancelled) await collectDrops(bot, token, [doorPos], 6000);
    } catch (err) {
      console.error(`build: couldn't take out the wrong-way door at ${doorPos}:`, err.message);
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
  }
  if (!doorAlready && !token.cancelled && !bot.inventory.items().some((i) => i.name.endsWith("_door"))) {
    await performActionAs(bot, { type: "craft", item: doorItemFor(bot), count: 1 }, speaker, token);
  }
  let doorPlaced = doorAlready;

  if (!needed && doorAlready) return { ...ok("the shelter is already standing."), built: true };

  let placed = 0;
  let shutIn = 0; // declared out here: the try block below is a real scope, and the result text reads it
  try {
  for (const pos of buildOrder) {
    if (token.cancelled) break;
    if (bot.blockAt(pos)?.boundingBox === "block") continue; // terrain already solid here
    // 2026-10-07: a shelter site is only checked for fixtures INSIDE its own 4x4 footprint
    // (findShelterSite's own clear() test); a chest or door just outside it can still fall in
    // a wall's access cell. A gap in the wall beats a chest nobody can open, and the 80%
    // completion bar below already tolerates a few missing blocks.
    const shuts = wouldBlockAccess(bot, pos);
    if (shuts) {
      shutIn++;
      console.log(`build: left ${pos} open -- a wall there would block ${shuts.reason} the ${shuts.fixture}`);
      continue;
    }

    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      if (token.cancelled) break;
      continue; // couldn't get near this spot -- an imperfect shelter beats abandoning it
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) break;
    await clearCellForPlacement(bot, pos); // a flower in the wall line refuses every placement

    let refBlock = null, face = null;
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const neighbor = bot.blockAt(pos.offset(dx, dy, dz));
      if (neighbor?.boundingBox === "block") {
        refBlock = neighbor;
        face = new Vec3(-dx, -dy, -dz);
        break;
      }
    }
    if (!refBlock) continue; // nothing solid to place against yet -- the second pass below catches it

    const item = bot.inventory.items().filter((i) => isShelterMaterial(i.name)).sort((a, b) => b.count - a.count)[0];
    if (!item) break; // ran out mid-build
    try {
      await bot.equip(item, "hand");
      await bot.placeBlock(refBlock, face);
      placed++;
    } catch (err) {
      console.error(`build: placement failed at ${pos}:`, err.message);
    }
  }
  } finally {
    if (bot.pathfinder.movements === buildMovements) bot.pathfinder.setMovements(sharedMovements);
  }
  await refreshGear(bot);

  // Placing the door itself, now that the walls flanking it exist (see this step's own
  // header comment above for why that order matters for its facing).
  if (!doorAlready && !token.cancelled) {
    const doorItem = bot.inventory.items().find((i) => i.name.endsWith("_door"));
    const floorBelow = bot.blockAt(doorPos.offset(0, -1, 0));
    if (doorItem && floorBelow?.boundingBox === "block") {
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(doorPos.x, doorPos.y, doorPos.z, 4)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
        if (!token.cancelled) {
          await bot.equip(doorItem, "hand");
          // Facing straight out through the doorway (away from the room, +z) -- her OWN x,
          // not doorPos's, so the look vector has zero x component regardless of exactly
          // where GoalNear(..., 4) left her standing (a diagonal vector can still round to
          // the wrong cardinal direction). 2026-10-30: a point +z of HER, not of the door --
          // GoalNear can leave her farther out than doorPos.z + 3, and looking back at that
          // point faced her north.
          await clearCellForPlacement(bot, doorPos);
          await clearCellForPlacement(bot, doorPos.offset(0, 1, 0));
          await bot.lookAt(bot.entity.position.offset(0, bot.entity.height, 5), true);
          // The look only reaches the server on the next physics tick; placed before that, the
          // door took her old facing (west, from inside the room, in the live test).
          await bot.waitForTicks(2);
          // placeBlock turns her to look at the floor block first, undoing the look above --
          // the door then faced wherever she stood relative to it. forceLook "ignore" keeps it.
          await bot._placeBlockWithOptions(floorBelow, new Vec3(0, 1, 0), { swingArm: "right", forceLook: "ignore" });
          doorPlaced = isShelterDoor(bot.blockAt(doorPos));
        }
      } catch (err) {
        console.error(`build: door placement failed at ${doorPos}:`, err.message);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
    }
    // No door item (craft above failed -- genuinely out of planks) or no floor under the
    // doorway yet: nothing to place against this pass -- a later call catches up, same as
    // any other still-missing piece.
  }

  // A cell left open on purpose still counts as missing, and against index.js's own
  // hasShelterNearHome() -- the two must not disagree about whether a shelter stands. It's
  // named in the result instead, so a site that keeps coming out partial for this reason is
  // visible rather than a mystery.
  const openedFor = shutIn ? ` (${shutIn} left open so a neighbouring fixture stays reachable)` : "";
  if (token.cancelled) return ok(`stopped building (${placed} placed, ${missing()} still missing)${openedFor}.`);
  const left = missing();
  if (!placed && left && !doorPlaced) return fail(`couldn't place any of the shelter (${left} blocks still missing)${openedFor}.`);
  // 2026-10-11: 100%, not the old 80% -- a shelter with a gap in it (or no real door) isn't
  // sealed, and a half-sealed shelter is exactly what this fix exists to stop calling "done."
  const built = left === 0 && doorPlaced;
  return { ...(built ? ok(`built a small shelter (${placed} blocks placed, sealed with a door)${openedFor}.`)
    : fail(`built part of a shelter: ${placed} placed, ${left} still missing` +
           `${doorPlaced ? "" : ", no door yet"}${openedFor}.`)), built };
}
