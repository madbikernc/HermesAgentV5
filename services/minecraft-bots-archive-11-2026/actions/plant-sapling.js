// Version: 1.0.0
//
// The "plant_sapling" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, findPlantableSpotNear, goals, nearBuilding, wanderAndRetryFind, withTimeout } from "../actions.js";


export async function plantSaplingAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-09: "when they find saplings, they should plant them (1) near
  // other trees of the same variety if they can (2) in any free soil not directly adjacent
  // to a building if they can't." action.item is the specific sapling name (e.g.
  // "oak_sapling") -- checkSaplings() (index.js) is the one caller, picking whichever
  // sapling she's actually carrying, never invented.
  const saplingItem = bot.inventory.items().find((i) => i.name === action.item);
  if (!saplingItem) return fail(`don't have a ${action.item} to plant.`);

  const SAPLING_PLANT_BATCH_LIMIT = 4;
  const treeName = action.item.replace("_sapling", "_log"); // oak_sapling -> oak_log
  const treeLogId = bot.registry.blocksByName[treeName]?.id;
  const groundIds = [bot.registry.blocksByName.grass_block?.id, bot.registry.blocksByName.dirt?.id]
    .filter((id) => id !== undefined);

  let planted = 0;
  for (let i = 0; i < SAPLING_PLANT_BATCH_LIMIT; i++) {
    if (token.cancelled) break;
    const current = bot.inventory.items().find((it) => it.name === action.item);
    if (!current) break; // ran out of this sapling type

    // Rule 1: near an existing tree of the same species, if one's reachable.
    let targetPos = null;
    if (treeLogId !== undefined) {
      const treePositions = bot.findBlocks({ matching: [treeLogId], maxDistance: 32, count: 5 });
      for (const treePos of treePositions) {
        targetPos = findPlantableSpotNear(bot, treePos, 4);
        if (targetPos) break;
      }
    }
    // Rule 2: fall back to any free soil not directly adjacent to a building.
    if (!targetPos) {
      // Real live gap found 2026-09-09, minutes after this first deployed: Luke and Mayor
      // both failed to find ANY spot, every single retry, for the entire 25-minute window --
      // rule 2 only ever checked within a fixed 32 blocks of wherever the bot currently
      // stood, with no fallback if that came up empty (unlike "mine"/"store"/harvest's own
      // till-from-scratch fallback, all of which already reach for wanderAndRetryFind()).
      // Near a base, most nearby open ground legitimately IS near a building by design
      // (that's the whole point of a base) -- this needs the same directed-wander capability
      // every other search-based action already has to reach open, unclaimed ground beyond
      // the immediate settled area.
      const groundFindOptions = {
        // Real live crash, 2026-09-09: a findBlocks() matcher candidate can have a null
        // .position despite the block itself being non-null -- the exact same mineflayer
        // edge case findNearestShore() (index.js) already found and guarded against; this
        // matcher hit it too ("sapling check failed: Cannot read properties of null
        // (reading 'offset')", repeating every idle tick for any bot carrying a sapling).
        // Also tightened here to real "air" (not just a non-solid bounding box) -- a
        // pre-existing sapling/tall-grass/flower already occupying that space isn't "block"
        // either, and a real live placement failure ("Server refused to place
        // dark_oak_sapling ... the block is still dark_oak_sapling") traced to exactly that.
        matching: (block) => {
          if (!block || !groundIds.includes(block.type)) return false;
          if (!block.position) return true; // findBlocks' palette pre-check (2026-11-04)
          if (bot.blockAt(block.position.offset(0, 1, 0))?.name !== "air") return false;
          return !nearBuilding(bot, block.position);
        },
        maxDistance: 32, count: 1,
      };
      let positions = bot.findBlocks(groundFindOptions);
      if (!positions.length) positions = await wanderAndRetryFind(bot, token, groundFindOptions);
      targetPos = positions[0] || null;
    }
    if (!targetPos) break; // nowhere good found -- stop, don't force a bad spot

    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      if (token.cancelled) break;
      break; // couldn't reach this one -- don't keep hunting for spots this call
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) break;

    try {
      await bot.equip(current, "hand");
      await bot.placeBlock(bot.blockAt(targetPos), new Vec3(0, 1, 0));
      planted++;
    } catch (err) {
      console.error(`plant_sapling: failed to plant at ${targetPos}:`, err.message);
      break; // an unexpected placement failure -- don't loop on the same problem
    }
  }

  if (!planted) return token.cancelled ? ok("stopped planting.") : fail(`couldn't find anywhere good to plant the ${action.item}.`);
  return ok(`planted ${planted} ${action.item}${token.cancelled ? ", stopped early" : ""}.`);
}
