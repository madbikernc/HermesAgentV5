// Version: 1.2.0
//
// 1.2.0 (2026-11-23, direct report "random structures of blocks, perhaps aborted shelters" ->
// "add logic that site choice requires enough contiguous flat space, either naturally occurring
// or as part of the landscape maintenance routing"): findShelterSiteAtRadius() now checks the
// whole ring outside the 4x5 footprint (shelterApronPositions), not just the one cell in front of
// the doorway -- see APRON_LEVEL_DEPTH's own header for the live bug this closes. New
// shelterApronLevelSpot(), exported for shelterStep() (shelter-goals.js) to level a shallow dip
// with the same repair_terrain action checkTerrainDamage already uses.
//
// 1.1.0 (2026-11-22, direct report: "it looks like pure chaos, with little measurable success",
// direct follow-up: "or, start leveling land to make it useable"): a shelter site may now
// include up to MAX_FILLABLE_COLUMNS floor columns of shallow water over solid ground --
// shelterPositions() floors the whole 4x5 footprint (new SHELTER_FOOTPRINT), not just the room,
// so build.js's existing wall-placement loop fills the water in with no new logic of its own.
//
// 1.0.0 (2026-11-13) -- split out of actions.js (2.0.0) unchanged: shelter materials and geometry, shelter and communal-shelter sites, crop age, drop collection, farm status.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. actions.js imports
// it; this file reads actions.js's state through live imports, so nothing here may touch it
// before actions.js has run (only declarations live here).

import { Vec3 } from "vec3";
import { isDoorway } from "./swim-movements.js";
import { withTimeout } from "./action-movement.js";
import { goals, isProtectedBlockName } from "./action-vocab.js";


// Shelters (2026-09-26, "what's wrong with shelter building?"): in two days the Builder got "build a
// small shelter" 120 times, the planner claimed it done 202 times (all rejected), and "build" ran
// once. It also only built from one stack of 33+ of a single block (the biggest stack, sand and
// gravel included), wherever she happened to stand.
// Plain building blocks she may use, mixed freely; never gravity blocks or anything valuable/functional.
const SHELTER_MATERIAL = /^(dirt|coarse_dirt|rooted_dirt|cobblestone|cobbled_deepslate|mossy_cobblestone|stone|deepslate|andesite|diorite|granite|tuff|calcite|netherrack|blackstone|basalt|sandstone|red_sandstone|packed_mud|mud_bricks|bricks|stone_bricks|.+_planks|(stripped_)?.+_(log|wood|stem|hyphae))$/;

export function isShelterMaterial(name) {
  return SHELTER_MATERIAL.test(name);
}

export function shelterMaterialCount(bot) {
  return bot.inventory.items().filter((i) => isShelterMaterial(i.name)).reduce((n, i) => n + i.count, 0);
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a -- "every block used must be
// at least stone tier... though the materials don't all have to match each other"). Stricter
// than isShelterMaterial() above, which still governs the individual-shelter baseline: this is
// ONLY for the communal shelter. Explicitly excludes planks/dirt/sand/wood -- the whole point of
// the constraint -- and excludes raw ore blocks too (an ore block isn't "stone-tier building
// material" just because it's stone-hard; smooth_stone/bricks/concrete/terracotta are real,
// finished building blocks, which is the actual category this is meant to capture).
const STONE_OR_BETTER_MATERIAL = /^(stone|smooth_stone|cobblestone|mossy_cobblestone|cobbled_deepslate|polished_deepslate|deepslate|deepslate_bricks|deepslate_tiles|chiseled_deepslate|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|andesite|polished_andesite|diorite|polished_diorite|granite|polished_granite|tuff|polished_tuff|tuff_bricks|chiseled_tuff|chiseled_tuff_bricks|calcite|basalt|polished_basalt|smooth_basalt|blackstone|polished_blackstone|blackstone_bricks|chiseled_polished_blackstone|bricks|.+_bricks|iron_block|.+_concrete|.+_terracotta|glazed_terracotta)$/;

export function isCommunalShelterMaterial(name) {
  return STONE_OR_BETTER_MATERIAL.test(name);
}

export function communalShelterMaterialCount(bot) {
  return bot.inventory.items().filter((i) => isCommunalShelterMaterial(i.name)).reduce((n, i) => n + i.count, 0);
}

// The shelter: 4x5 outside, a 2x3 room inside. `base` is the room's back-left cell at floor level;
// the room is base..base+(1,0,2), walls three high round it with a doorway at (0, *, 3), and a 4x5
// roof on top. index.js's hasShelterNearHome() checks this same shape.
export const SHELTER_ROOM = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]];
// The shelter's own 4x5 footprint (the room plus the wall margin around it) -- shared by
// findShelterSiteAtRadius() below (what ground a site needs) and shelterPositions() (what floor
// it actually places), so a site that search finds buildable and the floor build.js places
// always agree on what "the floor" covers. Matches findShelterSiteAtRadius's own ox -1..2, oz
// -1..3 loop exactly.
const SHELTER_FOOTPRINT = [];
for (let dx = -1; dx <= 2; dx++) for (let dz = -1; dz <= 3; dz++) SHELTER_FOOTPRINT.push([dx, dz]);
// Direct report, 2026-10-11 ("a shelter needs... a real door, not an opening or arch... no other
// openings... with at least one bed"): the doorway used to exclude all three wall-height cells at
// (0, 0..2, 2) from the generic fill, leaving a bare, permanent gap -- nothing ever placed a door
// there, and nothing ever checked the floor beneath the room at all. Now only the two door-height
// cells (dy 0-1, doorwayPosition() below) are left for door placement specifically; the lintel
// (dy 2) rejoins the ordinary wall fill, and the floor under the room is included too -- one real
// opening, filled by an actual door, is the only way in or out once this is complete.
//
// Found live the same day: with the room still only 2x2, a real door and a bed could never both
// fit. findBedSites() (below) needs a bed's foot, head AND the cell she stands in to place it, all
// three colinear -- that's 3 cells deep, but every row of a 2-deep room is adjacent to the single
// door, and nearDoor() (correctly) refuses to put a bed's foot or head next to a real door. Before,
// the doorway was just an open gap -- "air", not a door -- so it transparently stood in as that
// third cell; placing an actual door there is what broke it. Fixed by making the room one row
// deeper (2x3, not 2x2): the two rows farthest from the door hold the bed (foot and head, neither
// adjacent to the door), and the new row right at the door is free to be her stand-cell -- nearDoor
// only rules out a bed's own foot/head, never the cell she's merely standing in to place it.
export function doorwayPosition(base) { return base.offset(0, 0, 3); }
// 2026-10-30: the doorway is in the room's +z wall, so the way through runs north-south and its
// door must face north or south. Babs' door at (-221, 64, -92) faced west: closed, it left the
// way through open; opened, it swung across it, so the pathfinder could never get into the room
// and every bed placement there timed out.
export function isShelterDoor(block) {
  const facing = block?.getProperties?.().facing;
  return isDoorway(block) && (facing === "north" || facing === "south");
}
export function shelterPositions(base) {
  const walls = [];
  for (let dx = -1; dx <= 2; dx++) {
    for (let dz = -1; dz <= 3; dz++) {
      if (dx >= 0 && dx <= 1 && dz >= 0 && dz <= 2) continue; // the room
      for (let dy = 0; dy <= 2; dy++) {
        if (dx === 0 && dz === 3 && dy <= 1) continue; // the doorway itself -- a door, not a wall block
        walls.push(base.offset(dx, dy, dz));
      }
    }
  }
  const roof = [];
  for (let dx = -1; dx <= 2; dx++) {
    for (let dz = -1; dz <= 3; dz++) roof.push(base.offset(dx, 3, dz));
  }
  // 2026-11-22: the WHOLE footprint's floor, not just the room's -- see SHELTER_FOOTPRINT's own
  // header. On ordinary dry land every one of these cells is already solid (findShelterSiteAtRadius
  // already required it), so build.js's "skip if already solid" loop no-ops on all of them,
  // exactly as before; on a water-tolerant site (same report), this is what actually gets the
  // shallow water under the walls filled in -- no new placement logic needed, the existing
  // "place against whatever's already solid" loop does it the same way it places any other wall.
  const floor = SHELTER_FOOTPRINT.map(([dx, dz]) => base.offset(dx, -1, dz));
  return [...walls, ...floor, ...roof];
}

// Mirrors bedItemFor's own simplicity: whatever species she's already holding planks of, else
// oak. A door needs a table (6 planks in a 2x3 shape -- 3 rows exceeds the personal 2x2 grid), but
// that's craftItem's own concern (via the fixed tableWouldHelp check, actions.js 1.83.1), not this
// function's.
// 2026-10-30: the wood she holds the most planks of, not the first stack -- a door is 6 planks of
// one wood, and Babs' first stack was 2 spruce beside 6 birch, so "craft spruce_door" failed (and
// "build" said nothing about it) every tick all night.
export function doorItemFor(bot) {
  const counts = {};
  for (const i of bot.inventory.items()) {
    if (i.name.endsWith("_planks")) counts[i.name] = (counts[i.name] || 0) + i.count;
  }
  const [planks] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [];
  const species = planks ? planks.replace(/_planks$/, "") : "oak";
  return `${species}_door`;
}

// A flat, clear 4x5 footprint near home: solid ground under all twenty columns, four blocks of
// open air above each, no bed/door/chest in the way, and a walkable cell outside the doorway so
// the room can be entered. Nearest home wins within whichever radius actually finds a site.
// 2026-10-11: oz/outside widened from the room's old 2x2 (dz 0-1, door at 2) to 2x3 (dz 0-2, door
// at 3) -- see SHELTER_ROOM's own header comment for why the room grew.
// 2026-10-27 (direct request, "allow the shelter search radius to go up to 48 blocks"): up to
// BOT_USERNAMES.size separate individual shelters need to fit somewhere near home, and the old
// fixed 4-block search ran out of room the moment the crafting table/furnace/chest/earlier
// shelters crowded that tight 9x9 core -- site-finding then failed forever, correctly, given the
// radius it was allowed to search. Now rings outward (SHELTER_SITE_SEARCH_RINGS) and stops at the
// first radius that finds ANY valid site, so the common case (a site right at home) costs exactly
// what it always did; only a genuinely crowded base pays for the wider scan. maxRadius is a
// parameter (default 4, preserving exact prior behaviour/cost for any 2-arg caller, including
// existing unit tests) so callers that want the wider search opt in explicitly. This is a plain
// nested-loop block scan, not a pathfinder search -- unrelated to README.md's "keep under 48"
// pathfinder.searchRadius OOM caveat, which is about mineflayer-pathfinder's own A* search, a
// completely different mechanism.
const SHELTER_SITE_SEARCH_RINGS = [4, 8, 16, 32, 48];

// Direct report, 2026-11-22 ("it looks like pure chaos, with little measurable success"), direct
// follow-up requests the same breath ("if the spawn is unsuitable... seek a better place", "or
// start leveling land to make it useable"): the fresh world's spawn landed the whole fleet
// somewhere water-heavy (shelter_site_failures_per_bot_day: 123.2, zero beds placed in 24h) --
// every floor column used to need ALREADY-dry ground, so a pond anywhere inside a candidate's
// 4x5 disqualified it outright however good the rest of the spot was. A column whose floor is
// shallow water over solid ground (MAX_FILL_DEPTH or less) now counts too, bounded by
// MAX_FILLABLE_COLUMNS so a genuine lake still refuses rather than accepting a mostly-submerged
// site -- shelterPositions()'s own floor (now the whole footprint, not just the room) is what
// actually gets these filled, by the ordinary wall-placement loop, no new logic needed there.
const MAX_FILL_DEPTH = 1;
const MAX_FILLABLE_COLUMNS = 6;

// "dry" (solid already, nothing to fill), "fill" (shallow water over solid ground,
// MAX_FILL_DEPTH or less -- build.js will fill it in), or null (too deep, lava, open air with
// nothing solid under it, or anything else that isn't a buildable floor).
function floorKind(bot, floorPos) {
  const block = bot.blockAt(floorPos);
  if (block?.boundingBox === "block") return "dry";
  if (block?.name !== "water") return null;
  for (let depth = 1; depth <= MAX_FILL_DEPTH; depth++) {
    const below = bot.blockAt(floorPos.offset(0, -depth, 0));
    if (below?.boundingBox === "block") return "fill";
    if (below?.name !== "water") return null; // lava, air, anything else below: too uncertain to fill
  }
  return null; // still water past MAX_FILL_DEPTH -- too deep to fill cheaply
}

// Direct request, 2026-11-23 ("I keep finding random structures of blocks, perhaps they are part
// of aborted shelters" -> "add logic that site choice requires enough contiguous flat space,
// either naturally occurring or as part of the landscape maintenance routing"): confirmed live
// (journalctl on both hosts) that a shelter can get permanently stuck a handful of blocks short,
// identical count, call after call, for a reason wouldBlockAccess never catches -- e.g.
// "[Mayor] built part of a shelter: 52 placed, 8 still missing" sat unchanged across an 8-minute
// build attempt. The only ground findShelterSiteAtRadius ever checked outside the footprint
// itself was the single cell in front of the doorway; a site boxed in by a cliff, ravine or water
// on any OTHER side still passed every other check, and bot.pathfinder.goto's own GoalNear(pos,4)
// then has nowhere to stand within reach of those wall cells -- forever, since the terrain never
// changes on its own. build.js's new unreachable/noRef instrumentation is what would have made
// this visible immediately instead of a multi-host log dive.
//
// Now the whole ring one block outside the 4x5 footprint is checked, not just the door-front
// cell. APRON_LEVEL_DEPTH mirrors upkeep-world.js's own TERRAIN_REPAIR_MAX_DEPTH deliberately: a
// site needs ground that is EITHER already flat (naturally occurring) OR shallow enough that the
// landscape maintenance routine (checkTerrainDamage/repair_terrain, upkeep-world.js) can level it
// -- shelterStep() (shelter-goals.js) runs that same action against this site's own apron, via
// shelterApronLevelSpot() below, before building reaches it. Anything deeper, or water/lava past
// that depth, still refuses the site outright, same as floorKind() already does for the footprint.
const APRON_LEVEL_DEPTH = 4;

// The ring of columns one block outside the 4x5 footprint, all four sides -- the ground she
// actually has to stand on to reach every wall cell from outside, not just the doorway.
function shelterApronPositions(base) {
  const ring = [];
  for (let dx = -2; dx <= 3; dx++) {
    for (let dz = -2; dz <= 4; dz++) {
      if (dx >= -1 && dx <= 2 && dz >= -1 && dz <= 3) continue; // inside the footprint itself
      ring.push(base.offset(dx, -1, dz)); // at the same height as the footprint's own floor
    }
  }
  return ring;
}

// Mirrors floorKind() exactly, just with APRON_LEVEL_DEPTH in place of MAX_FILL_DEPTH and no
// fillable-column cap (the apron isn't placed by the ordinary wall loop the way the floor is --
// shelterApronLevelSpot()'s own caller levels it separately, one spot at a time, before building
// reaches it). "flat" (already solid at grade -- nothing to do), "level" (a shallow dip, air or
// water, with solid ground within APRON_LEVEL_DEPTH below -- fixable), or null (lava, or still
// open past that depth -- a genuine cliff or ravine, not flat enough at all).
function apronKind(bot, groundPos) {
  const top = bot.blockAt(groundPos);
  if (top?.boundingBox === "block") return "flat";
  if (top?.name !== "water" && top?.name !== "air") return null;
  for (let depth = 1; depth <= APRON_LEVEL_DEPTH; depth++) {
    const below = bot.blockAt(groundPos.offset(0, -depth, 0));
    if (below?.boundingBox === "block") return "level";
    if (below?.name !== "water" && below?.name !== "air") return null;
  }
  return null;
}

// The first apron cell (if any) still short of grade, shaped exactly like upkeep-world.js's own
// findTerrainDamage() spot ({x, y, z, targetY}) so shelterStep() can hand it straight to the same
// "repair_terrain" action checkTerrainDamage already uses, rather than a second fill mechanism.
export function shelterApronLevelSpot(bot, base) {
  for (const groundPos of shelterApronPositions(base)) {
    if (apronKind(bot, groundPos) !== "level") continue;
    for (let depth = 1; depth <= APRON_LEVEL_DEPTH; depth++) {
      const surface = groundPos.offset(0, -depth, 0);
      if (bot.blockAt(surface)?.boundingBox === "block") {
        return { x: surface.x, y: surface.y + 1, z: surface.z, targetY: groundPos.y };
      }
    }
  }
  return null;
}

function findShelterSiteAtRadius(bot, home, radius) {
  const hx = Math.floor(home.x), hy = Math.floor(home.y), hz = Math.floor(home.z);
  const clear = (p) => {
    const b = bot.blockAt(p);
    return !!b && b.boundingBox !== "block" && b.name !== "water" && b.name !== "lava" && !isProtectedBlockName(b.name);
  };
  let best = null, bestDist = Infinity;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const base = new Vec3(hx + dx, hy + dy, hz + dz);
        const dist = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
        if (dist >= bestDist) continue;
        let ok = true, fillable = 0;
        for (const [ox, oz] of SHELTER_FOOTPRINT) {
          if (!ok) break;
          const kind = floorKind(bot, base.offset(ox, -1, oz));
          if (kind === null) { ok = false; break; }
          if (kind === "fill" && ++fillable > MAX_FILLABLE_COLUMNS) { ok = false; break; }
          for (let oy = 0; oy <= 3 && ok; oy++) ok = clear(base.offset(ox, oy, oz));
        }
        // The whole apron, not just the door-front cell -- see shelterApronPositions()'s own
        // header above for the live bug this replaces. groundPos.offset(0,1,0)/(0,2,0) are the
        // same two cells the old door-front-only check verified (headroom to stand in), now
        // checked all the way around instead of at one point.
        for (const groundPos of ok ? shelterApronPositions(base) : []) {
          if (apronKind(bot, groundPos) === null || !clear(groundPos.offset(0, 1, 0)) || !clear(groundPos.offset(0, 2, 0))) {
            ok = false;
            break;
          }
        }
        if (ok) { best = base; bestDist = dist; }
      }
    }
  }
  return best;
}

export function findShelterSite(bot, home, maxRadius = 4) {
  for (const radius of SHELTER_SITE_SEARCH_RINGS) {
    if (radius > maxRadius) break;
    const found = findShelterSiteAtRadius(bot, home, radius);
    if (found) return found;
  }
  return null;
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a, sized per the operator's own
// rule, 2026-10-12: "large enough for beds to suit all active bots... at least N+1 for N bots").
// Generalizes SHELTER_ROOM/shelterPositions/doorwayPosition/findShelterSite above into a
// variable-size version -- same wall/roof/floor/single-doorway shape, just parameterized by
// width/depth instead of a fixed room. Deliberately NOT a refactor of the individual-shelter
// functions themselves (a second, separate set of functions, not a shared parametric core) --
// those are proven and heavily tested; this keeps zero risk of changing their behavior.
//
// No bed positions are pre-planned here: the room is just sized generously and findBedSites()
// (already proven for individual shelters -- avoids doors, chokepoints, occupied cells, prefers
// clustering near existing beds) fills it, called once per target bed from index.js's own
// communal-shelter runner.
export function communalRoomCells(width, depth) {
  const cells = [];
  for (let dx = 0; dx < width; dx++) for (let dz = 0; dz < depth; dz++) cells.push([dx, dz]);
  return cells;
}

export function communalDoorwayPosition(base, depth) { return base.offset(0, 0, depth); }

export function communalShelterPositions(base, width, depth) {
  const inRoom = (dx, dz) => dx >= 0 && dx < width && dz >= 0 && dz < depth;
  const walls = [];
  for (let dx = -1; dx <= width; dx++) {
    for (let dz = -1; dz <= depth; dz++) {
      if (inRoom(dx, dz)) continue;
      for (let dy = 0; dy <= 2; dy++) {
        if (dx === 0 && dz === depth && dy <= 1) continue; // the doorway itself -- a door, not a wall block
        walls.push(base.offset(dx, dy, dz));
      }
    }
  }
  const roof = [];
  for (let dx = -1; dx <= width; dx++) for (let dz = -1; dz <= depth; dz++) roof.push(base.offset(dx, 3, dz));
  const floor = communalRoomCells(width, depth).map(([dx, dz]) => base.offset(dx, -1, dz));
  return [...walls, ...floor, ...roof];
}

// Mirrors findShelterSite() above exactly, just parameterized by width/depth instead of the
// individual shelter's fixed 2x3 room. Searched over a wider radius (8, not 4) since a big
// communal footprint needs more room to find a clear site for than a small personal one.
export function findCommunalShelterSite(bot, home, width, depth) {
  const hx = Math.floor(home.x), hy = Math.floor(home.y), hz = Math.floor(home.z);
  const clear = (p) => {
    const b = bot.blockAt(p);
    return !!b && b.boundingBox !== "block" && b.name !== "water" && b.name !== "lava" && !isProtectedBlockName(b.name);
  };
  let best = null, bestDist = Infinity;
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const base = new Vec3(hx + dx, hy + dy, hz + dz);
        const dist = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
        if (dist >= bestDist) continue;
        let ok = true;
        for (let ox = -1; ox <= width && ok; ox++) {
          for (let oz = -1; oz <= depth + 1 && ok; oz++) {
            ok = bot.blockAt(base.offset(ox, -1, oz))?.boundingBox === "block";
            for (let oy = 0; oy <= 3 && ok; oy++) ok = clear(base.offset(ox, oy, oz));
          }
        }
        const outside = base.offset(0, 0, depth + 1); // in front of the doorway
        ok = ok && bot.blockAt(outside.offset(0, -1, 0))?.boundingBox === "block" && clear(outside) && clear(outside.offset(0, 1, 0));
        if (ok) { best = base; bestDist = dist; }
      }
    }
  }
  return best;
}

export const CROP_MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };

// Breaking a crop (or the grass on a plot) from 2 blocks away leaves its drops on the ground -- the
// harvested wheat never reached her inventory (live test, 2026-09-25). Walk over what's lying around
// the spots she worked, nearest first, for at most maxMs.
export async function collectDrops(bot, token, spots, maxMs = 10_000) {
  const deadline = Date.now() + maxMs;
  for (let tries = 0; tries < 12 && Date.now() < deadline && !token.cancelled; tries++) {
    const drop = Object.values(bot.entities)
      .filter((e) => e.name === "item" && spots.some((spot) => e.position.distanceTo(spot) <= 4))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) return;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)),
        Math.max(1000, deadline - Date.now()), () => bot.pathfinder.setGoal(null));
    } catch {
      // unreachable or timed out -- the loop's deadline and try cap end it
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    await new Promise((r) => setTimeout(r, 300)); // the pickup lands a tick or two later
  }
}

// What's planted near a spot: ripe crops, and crops still growing.
export function farmStatus(bot, near) {
  const cropIds = Object.keys(CROP_MAX_AGE).map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  const crops = bot.findBlocks({ matching: cropIds, maxDistance: 32, count: 128, ...(near ? { point: near } : {}) })
    .map((p) => bot.blockAt(p)).filter(Boolean);
  const ripe = crops.filter((b) => Number(b.getProperties?.().age) === CROP_MAX_AGE[b.name]);
  return { ripe: ripe.length, growing: crops.length - ripe.length };
}
