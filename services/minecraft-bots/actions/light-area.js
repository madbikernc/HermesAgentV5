// Version: 1.1.0
//
// 1.1.0 (2026-11-22, direct report: "they waste resources by putting torches too close
// together"): the dark-spot search and the just-before-placing recheck both used block.light,
// which MINECRAFT_BOTS_DESIGN.md §12 already flagged as frozen at chunk-load time here and never
// fixed. Both now read real nearby light sources (tunneling.js's lightSourceBlockIds) instead.
//
// The "light_area" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, goals, isProtectedBlockName, withTimeout } from "../actions.js";
import { TORCH_SPACING, lightSourceBlockIds } from "../tunneling.js";


export async function lightAreaAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-10 ("fix the lighting logic"), following a real live incident:
  // 1260+ deaths in ~26h traced to the shared base sitting in pitch dark (light=0 at ground
  // level, confirmed live) with an uncapped nightly mob buildup (dozens of hostiles counted
  // within 80 blocks at once) -- self-defense fighting one threat at a time was never going
  // to survive an actual swarm. The existing "place a torch" logic (checkLighting, index.js)
  // only ever reacted to wherever a bot personally happened to be standing at the moment its
  // own tile went dark -- nothing ever proactively lit up the AREA bots actually live in.
  // This is that: walks to each dark, mob-spawn-capable spot near a real anchor point
  // (action.near -- checkHomeLighting's own claimed-bed position) and places a torch there.
  // Self-limiting by construction, no cross-bot coordination needed: a placed torch persists
  // in the world and clears that spot for every bot's next sweep, not just this one's -- five
  // bots independently sweeping the same shared base converges on "fully lit," it doesn't
  // duplicate work forever.
  const torchLit = bot.inventory.items().find((i) => i.name === "torch");
  if (!torchLit) return fail("don't have any torches to light the area with.");

  const LIGHT_AREA_RADIUS = 10;
  const LIGHT_AREA_BATCH_LIMIT = 6;
  // Direct report, 2026-11-22 ("they waste resources by putting torches too close together"):
  // this used to read block.light, which MINECRAFT_BOTS_DESIGN.md §12 already flagged as frozen
  // at chunk-load time on this stack and never fixed here -- near home, where chunks loaded while
  // it was dark, every position read "dark" forever, including ones this very sweep, or another
  // bot, had already lit. Same substitution tunneling.js's torch trail already uses: real nearby
  // light SOURCES (registry emitLight), not a stale per-position reading -- fetched once up
  // front, not per candidate, since findBlocks' own matcher below runs over every block in the
  // scanned volume and a litNearby-style findBlocks call inside it would multiply that cost.
  let lit = bot.findBlocks({ point: action.near, matching: lightSourceBlockIds(bot),
    maxDistance: LIGHT_AREA_RADIUS + TORCH_SPACING, count: 64 });
  const isLit = (pos) => lit.some((l) => l.distanceTo(pos) <= TORCH_SPACING);

  const positions = bot.findBlocks({
    point: action.near,
    // 2026-11-04: a position-less palette block (findBlocks' section pre-check) gets the cheap
    // test -- rejecting it skipped every section, so no dark spot was ever found.
    matching: (block) => {
      if (!block || block.boundingBox === "block") return false;
      if (!block.position) return true;
      if (isLit(block.position)) return false;
      const below = bot.blockAt(block.position.offset(0, -1, 0));
      return !!below && below.boundingBox === "block" && !isProtectedBlockName(below.name);
    },
    maxDistance: LIGHT_AREA_RADIUS,
    count: LIGHT_AREA_BATCH_LIMIT,
  });
  if (!positions.length) return ok("area's already lit up -- nothing dark found nearby.");

  let placed = 0;
  for (const pos of positions) {
    if (token.cancelled) break;
    const current = bot.inventory.items().find((i) => i.name === "torch");
    if (!current) break; // ran out of torches partway through the sweep

    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      if (token.cancelled) break;
      continue; // couldn't reach this one -- try the next dark spot
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) break;

    // Re-check: another bot (or this one, via an earlier iteration) may have already lit
    // this exact spot since the batch was found.
    const ground = bot.blockAt(pos.offset(0, -1, 0));
    if (!ground || ground.boundingBox !== "block" || isLit(pos)) continue;

    try {
      await bot.equip(current, "hand");
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      lit = [...lit, pos]; // counts toward isLit immediately, so this sweep doesn't stack a second torch nearby
      placed++;
    } catch (err) {
      console.error(`light_area: failed to place a torch at ${pos}:`, err.message);
    }
  }

  if (!placed) return token.cancelled ? ok("stopped lighting the area.") : fail("found dark spots but couldn't light any of them.");
  return ok(`lit up ${placed} dark spot(s)${token.cancelled ? ", stopped early" : ""}.`);
}
