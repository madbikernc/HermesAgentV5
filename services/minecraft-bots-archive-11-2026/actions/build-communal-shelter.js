// Version: 1.0.0
//
// The "build_communal_shelter" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { wouldBlockAccess } from "../shelter.js";
import { isDoorway } from "../swim-movements.js";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, clearCellForPlacement, communalDoorwayPosition, communalShelterMaterialCount, communalShelterPositions, doorItemFor, goals, isCommunalShelterMaterial, performActionAs, refreshGear, withTimeout } from "../actions.js";


export async function buildCommunalShelterAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a), sized per the
  // operator's own rule (2026-10-12: "large enough for beds to suit all active bots"). Same
  // door-first-craft, wall-loop, door-last-placement shape as "build" above (see its own
  // header for the two real bugs that order fixes) -- just the bigger, parameterized
  // communalShelterPositions()/communalDoorwayPosition() geometry and the stricter
  // isCommunalShelterMaterial() (stone or better, no planks/dirt) instead of the individual
  // shelter's permissive baseline. action.width/action.depth come from index.js's own
  // runner, which is the one place that actually knows the fleet size -- not guessed here.
  const base = action.at ? new Vec3(action.at.x, action.at.y, action.at.z).floored() : bot.entity.position.floored();
  const { width, depth } = action;
  if (!width || !depth) return fail("don't know how big to build the communal shelter.");
  const buildOrder = communalShelterPositions(base, width, depth);
  const missing = () => buildOrder.filter((pos) => bot.blockAt(pos)?.boundingBox !== "block").length;
  const needed = missing();
  const have = communalShelterMaterialCount(bot);
  if (needed && have < needed) {
    return { ...fail(`need ${needed} stone-or-better building blocks (stone, cobblestone, stone ` +
      `bricks, deepslate...) for the communal shelter, only have ${have}.`), short: needed - have };
  }

  const sharedMovements = bot.pathfinder.movements;
  const buildMovements = Object.assign(Object.create(Object.getPrototypeOf(sharedMovements)), sharedMovements);
  buildMovements.scafoldingBlocks = [];
  buildMovements.allow1by1towers = false;
  bot.pathfinder.setMovements(buildMovements);

  const doorPos = communalDoorwayPosition(base, depth);
  let doorAlready = isDoorway(bot.blockAt(doorPos));
  if (!doorAlready && !token.cancelled && !bot.inventory.items().some((i) => i.name.endsWith("_door"))) {
    await performActionAs(bot, { type: "craft", item: doorItemFor(bot), count: 1 }, speaker, token);
  }
  let doorPlaced = doorAlready;

  if (!needed && doorAlready) return { ...ok("the communal shelter is already standing."), built: true };

  let placed = 0;
  let shutIn = 0;
  try {
  for (const pos of buildOrder) {
    if (token.cancelled) break;
    if (bot.blockAt(pos)?.boundingBox === "block") continue;
    const shuts = wouldBlockAccess(bot, pos);
    if (shuts) {
      shutIn++;
      console.log(`build_communal_shelter: left ${pos} open -- a wall there would block ${shuts.reason} the ${shuts.fixture}`);
      continue;
    }

    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      if (token.cancelled) break;
      continue;
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null);
    }
    if (token.cancelled) break;
    await clearCellForPlacement(bot, pos);

    let refBlock = null, face = null;
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const neighbor = bot.blockAt(pos.offset(dx, dy, dz));
      if (neighbor?.boundingBox === "block") {
        refBlock = neighbor;
        face = new Vec3(-dx, -dy, -dz);
        break;
      }
    }
    if (!refBlock) continue;

    const item = bot.inventory.items().filter((i) => isCommunalShelterMaterial(i.name)).sort((a, b) => b.count - a.count)[0];
    if (!item) break;
    try {
      await bot.equip(item, "hand");
      await bot.placeBlock(refBlock, face);
      placed++;
    } catch (err) {
      console.error(`build_communal_shelter: placement failed at ${pos}:`, err.message);
    }
  }
  } finally {
    if (bot.pathfinder.movements === buildMovements) bot.pathfinder.setMovements(sharedMovements);
  }
  await refreshGear(bot);

  if (!doorAlready && !token.cancelled) {
    const doorItem = bot.inventory.items().find((i) => i.name.endsWith("_door"));
    const floorBelow = bot.blockAt(doorPos.offset(0, -1, 0));
    if (doorItem && floorBelow?.boundingBox === "block") {
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(doorPos.x, doorPos.y, doorPos.z, 4)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
        if (!token.cancelled) {
          await bot.equip(doorItem, "hand");
          // Same facing fix as "build"'s door (2026-10-30): look +z of her, then place
          // without placeBlock's own look at the floor.
          await clearCellForPlacement(bot, doorPos);
          await clearCellForPlacement(bot, doorPos.offset(0, 1, 0));
          await bot.lookAt(bot.entity.position.offset(0, bot.entity.height, 5), true);
          await bot.waitForTicks(2); // the look reaches the server a tick later (see "build")
          await bot._placeBlockWithOptions(floorBelow, new Vec3(0, 1, 0), { swingArm: "right", forceLook: "ignore" });
          doorPlaced = isDoorway(bot.blockAt(doorPos));
        }
      } catch (err) {
        console.error(`build_communal_shelter: door placement failed at ${doorPos}:`, err.message);
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null);
      }
    }
  }

  const openedFor = shutIn ? ` (${shutIn} left open so a neighbouring fixture stays reachable)` : "";
  if (token.cancelled) return ok(`stopped building the communal shelter (${placed} placed, ${missing()} still missing)${openedFor}.`);
  const left = missing();
  if (!placed && left && !doorPlaced) return fail(`couldn't place any of the communal shelter (${left} blocks still missing)${openedFor}.`);
  const built = left === 0 && doorPlaced;
  return { ...(built ? ok(`built the communal shelter (${placed} blocks placed, sealed with a door)${openedFor}.`)
    : fail(`built part of the communal shelter: ${placed} placed, ${left} still missing` +
           `${doorPlaced ? "" : ", no door yet"}${openedFor}.`)), built };
}
