// Version: 1.0.0
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
  const floor = SHELTER_ROOM.map(([dx, dz]) => base.offset(dx, -1, dz));
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
        let ok = true;
        for (let ox = -1; ox <= 2 && ok; ox++) {
          for (let oz = -1; oz <= 3 && ok; oz++) {
            ok = bot.blockAt(base.offset(ox, -1, oz))?.boundingBox === "block";
            for (let oy = 0; oy <= 3 && ok; oy++) ok = clear(base.offset(ox, oy, oz));
          }
        }
        const outside = base.offset(0, 0, 4); // in front of the doorway
        ok = ok && bot.blockAt(outside.offset(0, -1, 0))?.boundingBox === "block" && clear(outside) && clear(outside.offset(0, 1, 0));
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
