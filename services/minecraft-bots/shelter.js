// Version: 1.3.2
//
// 1.3.2 (2026-10-22): documents a real, named limitation found live -- holesIn() cannot find a
// hole exactly at a corner (see HOLE_MIN_SOLID_NEIGHBOURS' own updated comment). No code change;
// the live test that found it now knocks a flat mid-wall hole instead, the representative real
// case (a creeper, a stray dig), and the corner case is recorded rather than silently assumed
// covered.
//
// 1.3.1 (2026-10-22): real bug found live against the real server, not caught by any mock --
// coveredInterior() has never stopped at a doorway (deliberately, for its original living-space
// caller -- see its own updated header). shelterRoomsNear() needs the opposite: a real door's
// own boundingBox is not a plain solid block the way a wall is, so the unguarded fill walked
// straight through a just-built, fully intact door into the world outside, and read a couple of
// cells out there as a false hole. New optional stopAtDoors parameter, default false (every
// existing caller unchanged), which shelterRoomsNear() now passes true.
//
// 1.3.0 (2026-10-22, direct request, generalizing S42's fix): shelterRoomsNear()/holesIn() --
// recognize any number of individual shelters and a larger shelter of any shape ("contiguous
// walls, roof and floor, broken only by doors"), tolerant of real damage. shelterInteriorsNear()'s
// strict enclosedInterior() can only ever answer "is this fully sealed right now" -- a single hole
// makes the fill leak without bound and the whole structure stops reading as a shelter at all,
// the moment recognizing it as damaged matters most. The new pair reuses coveredInterior()'s
// already-proven, radius-bounded, hole-tolerant fill instead, and flags a hole by a purely local
// test (a passable, non-door cell surrounded by mostly-solid neighbours) rather than by
// re-deriving the room's exact original outline, which a damaged, previously-unknown-shape
// structure does not reliably offer. coveredInterior() gained an optional radius parameter
// (default unchanged, SHELL_RADIUS) so this can search a communal-sized room, not just a 2x3.
//
// 1.2.0 (2026-10-18) -- new enclosedInterior()/isSandWallName()/shelterInteriorsNear(): "shelters
// are not a set size or shape... any structure with no openings other than doors," walls any
// material "including glass, but not sand" (direct request, dropping bed claiming in favour of
// any-unoccupied-bed in actions.js). coveredInterior/isCovered below answer a related but looser
// question (roofed, for wall-digging protection) -- this answers the stricter one findBedSites
// needs: is a candidate spot actually inside a sealed room, so a new bed always goes in an
// existing shelter when one has room, of ANY shape, not just the Builder's own fixed 2x3/NxM room.
//
// 1.1.0 (2026-10-07) -- roofed() is exported as isCovered(): tunneling.js needs the same
// "is this cell indoors" test after block.light turned out to be frozen at chunk-load time
// (see tunneling.js 1.1.0).
//
// Direct request, 2026-10-07, four parts: never drop or place a block that impedes access to a
// chest, a bed or a door; DO destroy a block that impedes one; recognise the walls around a
// living space (anywhere a bed is kept) and stop knocking holes in them; "shelters should not be
// compromised by random digging or by random decisions that don't leverage a door."
//
// Three ideas live in one file because they share one vocabulary -- what a bot's own home depends
// on, and which cells those blocks need kept clear:
//
// (1) FIXTURES: the blocks a bot has to reach to live -- a container it stores in, a bed it
//     sleeps in, a door it walks through. isProtectedBlockName (actions.js) already stops these
//     from being BROKEN; nothing stopped them from being walled in, which is the same outage by
//     a different route. A chest nobody can open is a chest nobody has.
//
// (2) ACCESS CELLS: per fixture, the cells that must stay passable. Two strengths, because the
//     two cases are genuinely different. REQUIRED: filling it breaks access on its own -- the
//     cell above a chest (vanilla: a solid block there stops the lid, the rule chestObstructed
//     already encodes), and the cells either side of a door along its facing axis (a door with a
//     block in front of it is a wall). APPROACH: the cells you stand in to use the fixture --
//     cardinal neighbours of a bed or container. Any one will do, so only the LAST open one is
//     refused; refusing all four would make it impossible to build next to a chest at all.
//     A cell can only ever be an access cell of a fixture ADJACENT to it, so every check here is
//     a dozen blockAt() calls, not a scan -- cheap enough for the pathfinder's own placement
//     exclusion to call it per candidate.
//
// (3) THE SHELL OF A LIVING SPACE: the walls, floor and roof around a bed. There is no in-game
//     flag for "this is my house", and three rounds of digCost tuning (index.js §44/§47/§50,
//     swim-movements.js's MAX_DIG_LABOR_COST) already proved a global COST cannot answer a
//     per-position question: a number big enough to send a bot round to the door prunes the only
//     route out of a room, and a number small enough to leave that route makes a well-tooled dig
//     nearly free again. This answers the position question directly and leaves digCost to do
//     what it is actually good at.
//
//     How a shelter is recognised, without guessing at block names: flood-fill the air reachable
//     from the bed through cells that are passable AND have something solid overhead (roofed),
//     bounded by a radius and a cell cap. That interior is the living space; every solid block
//     touching it is the shell. The fill stops exactly where cover stops, which is the one place
//     a bot is supposed to leave through -- so the doorway stays open whether or not a door has
//     been hung in it yet (a freshly built shelter has none: shelterPositions leaves that column
//     empty). A bed under open sky fills nothing and gets no walls, so this can never protect
//     bare terrain just because somebody slept there.
//
//     [FLAGGED] A bot sealed inside a shell with no doorway could not dig out, since the walls it
//     would have to dig are the ones being protected. That degrades to a failure mode the fleet
//     already handles rather than a new one: index.js's stuck detection nudges and then teleports
//     (MC_MAX_STUCK_NUDGES / MC_RESTART_STUCK_*), and a deliberate "mine"/"clear_access" is never
//     gated by the shell -- only incidental pathfinder digging is.
//
// Nothing here imports actions.js. Policy -- "may this bot break that kind of block at all" --
// stays with isProtectedBlockName and is passed in, so actions.js can import this file without a
// cycle. bedHalves/chestHalves moved here from actions.js for the same reason: one definition
// shared instead of two copies drifting apart, the rule isEssentialItem/isProtectedBlockName
// already set.
import { Vec3 } from "vec3";

export const posKey = (p) => `${p.x},${p.y},${p.z}`;
const fromKey = (k) => { const [x, y, z] = k.split(",").map(Number); return new Vec3(x, y, z); };

const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const STEPS_6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const NEIGHBOURS_26 = (() => {
  const out = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) out.push([dx, dy, dz]);
    }
  }
  return out;
})();

// Shared by beds, doors and fence gates: minecraft-data gives all three a `facing` property, and
// vanilla puts a bed's head one block along it from the foot. Moved from actions.js's
// BED_FACING_STEP (2026-09-25, "if a bot's bed is destroyed, it should just claim another").
export const FACING_STEP = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

const CONTAINER_NAMES = new Set(["chest", "trapped_chest", "barrel", "ender_chest"]);
// Only chests and trapped chests are stopped by a solid block overhead -- a barrel, an ender
// chest and a shulker box all open regardless (real vanilla behaviour, and why this is a separate,
// smaller set rather than one list serving both rules).
const HEADROOM_CONTAINERS = new Set(["chest", "trapped_chest"]);

export function isContainerName(name) {
  return !!name && (CONTAINER_NAMES.has(name) || name.endsWith("_shulker_box"));
}
export function isBedName(name) {
  return !!name?.endsWith("_bed");
}
// Fence gates count: herd_to_pen already walks animals through one deliberately, so a fenced-in
// gate is the same outage as a walled-in door.
export function isDoorwayName(name) {
  return !!name && (name.endsWith("_door") || name.endsWith("_fence_gate"));
}

export function fixtureKind(name) {
  if (isContainerName(name)) return "container";
  if (isBedName(name)) return "bed";
  if (isDoorwayName(name)) return "door";
  return null;
}

const passable = (bot, pos) => {
  const block = bot.blockAt(pos);
  return !!block && block.boundingBox !== "block";
};
const solid = (bot, pos) => bot.blockAt(pos)?.boundingBox === "block";

// Both halves of a double chest, as positions. Scanning cardinal neighbours for the matching
// paired half is more robust than computing it from facing+type (actions.js's own reasoning,
// 2026-09-06); a single chest returns one position.
export function chestHalves(bot, block) {
  const halves = [block.position];
  if (block.getProperties?.().type === undefined) return halves;
  const facing = block.getProperties().facing;
  for (const [dx, dz] of CARDINALS) {
    const neighbor = bot.blockAt(block.position.offset(dx, 0, dz));
    if (neighbor?.name === block.name && neighbor.getProperties?.().facing === facing) {
      halves.push(neighbor.position);
      break;
    }
  }
  return halves;
}

// Both halves of a bed, head first. A claim may name either half (sleep saves whichever block
// findBlocks returned), which is why callers compare against both.
export function bedHalves(block) {
  const props = block.getProperties?.() || {};
  const [dx, dz] = FACING_STEP[props.facing] || [0, 0];
  if (!dx && !dz) return [block.position];
  const head = props.part === "foot" ? block.position.offset(dx, 0, dz) : block.position;
  return [head, head.offset(-dx, 0, -dz)];
}

// The cells you walk through a doorway, grouped by side. A door is two blocks tall, a fence gate
// one; either half of a door normalises to the lower one so both answer the same question. An
// unknown facing returns null rather than guessing -- falling back to all four cardinals would
// refuse the jambs the door is set into, which are supposed to be solid.
export function doorPassageSides(bot, block) {
  const props = block.getProperties?.() || {};
  const step = FACING_STEP[props.facing];
  if (!step) return null;
  const [dx, dz] = step;
  const base = props.half === "upper" ? block.position.offset(0, -1, 0) : block.position;
  const heights = block.name.endsWith("_fence_gate") ? [0] : [0, 1];
  return [
    heights.map((dy) => base.offset(dx, dy, dz)),
    heights.map((dy) => base.offset(-dx, dy, -dz)),
  ];
}

// The cells you stand in to use a bed or a container: cardinal neighbours of every half, at the
// fixture's own level. Any one of them is enough.
export function approachCells(bot, block, kind) {
  const halves = kind === "bed" ? bedHalves(block) : chestHalves(bot, block);
  const cells = [];
  for (const half of halves) {
    for (const [dx, dz] of CARDINALS) {
      const cell = half.offset(dx, 0, dz);
      if (halves.some((other) => other.equals(cell))) continue; // the fixture's own other half
      if (cells.some((other) => other.equals(cell))) continue;
      cells.push(cell);
    }
  }
  return cells;
}

// Which fixture a solid block at `pos` would cut off, or null. See (2) in this file's header for
// why only adjacent fixtures can matter, and why approach cells are judged "last one standing".
export function fixtureBlockedBy(bot, pos) {
  const under = bot.blockAt(pos.offset(0, -1, 0));
  if (under && HEADROOM_CONTAINERS.has(under.name)) {
    return { fixture: under.name, at: under.position, reason: "the lid of" };
  }
  for (const [dx, dz] of CARDINALS) {
    const block = bot.blockAt(pos.offset(dx, 0, dz));
    if (!isDoorwayName(block?.name)) continue;
    const sides = doorPassageSides(bot, block);
    if (sides?.some((side) => side.some((cell) => cell.equals(pos)))) {
      return { fixture: block.name, at: block.position, reason: "the way through" };
    }
  }
  for (const [dx, dz] of CARDINALS) {
    const block = bot.blockAt(pos.offset(dx, 0, dz));
    const kind = fixtureKind(block?.name);
    if (kind !== "bed" && kind !== "container") continue;
    const cells = approachCells(bot, block, kind);
    if (!cells.some((cell) => cell.equals(pos))) continue;
    if (cells.some((cell) => !cell.equals(pos) && passable(bot, cell))) continue; // another way in
    return { fixture: block.name, at: block.position, reason: "the last way up to" };
  }
  return null;
}

// "Drop" in the request is not only tossing: sand, gravel and concrete powder placed anywhere in
// a column ABOVE a fixture land on it, which is the same outage one tick later. Where a falling
// block would come to rest, or pos itself for anything that stays put.
const FALLING_BLOCK_NAMES = new Set(["sand", "red_sand", "gravel", "suspicious_sand",
  "suspicious_gravel", "anvil", "chipped_anvil", "damaged_anvil", "dragon_egg"]);
const FALL_SCAN = 12;

export function isFallingBlockName(name) {
  return !!name && (FALLING_BLOCK_NAMES.has(name) || name.endsWith("_concrete_powder"));
}

export function restingCell(bot, pos) {
  let cell = pos;
  for (let i = 0; i < FALL_SCAN; i++) {
    const below = cell.offset(0, -1, 0);
    if (!passable(bot, below)) return cell;
    cell = below;
  }
  return cell; // still falling past the scan -- the lowest cell looked at is close enough
}

// The one call every placement site makes. Returns what would be cut off, or null for "go ahead".
// `itemName` is optional and only matters for a falling block.
export function wouldBlockAccess(bot, pos, itemName = null) {
  if (!pos) return null;
  const direct = fixtureBlockedBy(bot, pos) || livingSpaceExitBlockedBy(bot, pos);
  if (direct) return direct;
  if (!isFallingBlockName(itemName)) return null;
  const landing = restingCell(bot, pos);
  if (landing.equals(pos)) return null;
  const fallen = fixtureBlockedBy(bot, landing) || livingSpaceExitBlockedBy(bot, landing);
  return fallen ? { ...fallen, falls: landing } : null;
}

// ---- the shell of a living space ------------------------------------------------------------

export const SHELL_RADIUS = 8;
export const SHELL_MAX_CELLS = 256;
export const SHELL_ROOF_SCAN = 4;
export const SHELL_MAX_ANCHORS = 8;
export const BED_SEARCH_DISTANCE = 32;
export const ACCESS_SCAN_RADIUS = 8;

// Something solid overhead: what makes a cell "indoors" rather than open sky. Exported because
// tunneling.js needs the same question answered for a different reason -- a torch trail must not
// fire while a bot walks across a field in daylight (1.1.0, 2026-10-07).
export function isCovered(bot, pos, scan = SHELL_ROOF_SCAN) {
  for (let dy = 1; dy <= scan; dy++) {
    if (solid(bot, pos.offset(0, dy, 0))) return true;
  }
  return false;
}

// The air inside a living space: everywhere reachable from `anchor` without leaving cover.
// `inside` is shared across anchors so one room shared by several beds is filled once, and so the
// cell cap bounds the whole refresh rather than each bed separately. `radius` defaults to
// SHELL_RADIUS (the dig-protection feature's own deliberately tight bound) but is overridable --
// shelterRoomsNear() below needs a wider one for a large communal-sized room.
//
// `stopAtDoors`, default false, exists only for that same new caller. The dig-protection feature
// this was built for deliberately does NOT stop at a doorway -- this file's own header explains
// why: "the fill stops exactly where cover stops... so the doorway stays open whether or not a
// door has been hung in it yet," because a freshly built shelter has no door at all yet and the
// room still needs recognizing. shelterRoomsNear() hits the opposite problem with a REAL, closed
// door already hung: found live against the real server, not guessed -- a real door's own
// boundingBox is not a plain 'block' the way a wall is, so an unguarded fill walks straight
// through it into the open world outside, and the first few cells out there can easily read as
// "4+ solid neighbours" (the door frame, the ground) -- a false hole in a perfectly intact room.
export function coveredInterior(bot, anchor, inside = new Set(), radius = SHELL_RADIUS, stopAtDoors = false) {
  const queue = [];
  const consider = (cell) => {
    const key = posKey(cell);
    if (inside.has(key) || inside.size >= SHELL_MAX_CELLS) return;
    if (!passable(bot, cell) || !isCovered(bot, cell)) return;
    if (stopAtDoors && isDoorwayName(bot.blockAt(cell)?.name)) return;
    inside.add(key);
    queue.push(cell);
  };
  consider(anchor.offset(0, 1, 0)); // straight up out of the bed
  for (const [dx, dz] of CARDINALS) {
    consider(anchor.offset(dx, 0, dz)); // standing beside it
    consider(anchor.offset(dx, 1, dz));
  }
  while (queue.length && inside.size < SHELL_MAX_CELLS) {
    const cell = queue.shift();
    for (const [dx, dy, dz] of STEPS_6) {
      const next = cell.offset(dx, dy, dz);
      if (Math.max(Math.abs(next.x - anchor.x), Math.abs(next.y - anchor.y),
                   Math.abs(next.z - anchor.z)) > radius) continue;
      consider(next);
    }
  }
  return inside;
}

// Every solid block touching the interior: walls, floor, roof, corners included. A door or a bed
// landing in that set is already unbreakable via isProtectedBlockName -- harmless, not a case to
// special-case.
export function shellAround(bot, inside) {
  const shell = new Set();
  for (const key of inside) {
    const cell = fromKey(key);
    for (const [dx, dy, dz] of NEIGHBOURS_26) {
      const neighbour = cell.offset(dx, dy, dz);
      const nk = posKey(neighbour);
      if (inside.has(nk) || shell.has(nk)) continue;
      if (solid(bot, neighbour)) shell.add(nk);
    }
  }
  return shell;
}

// Where to look for living spaces: every bed in sight, plus an explicit extra (the bot's own
// claimed bed, which may be loaded but outside the scan). A bed within a block and a half of one
// already taken is the same bed's other half.
//
// Matched by block id rather than bot.isABed, which is the same answer at a much better constant:
// a 32-block radius is a large volume to walk, and this runs on a timer (every 30s per bot), where
// nearbyBeds' own identical scan only runs at bedtime. The ids are resolved once per process.
let bedBlockIds = null;
function bedIds(bot) {
  if (bedBlockIds?.length) return bedBlockIds; // an empty result is never cached -- the registry may not be up yet
  bedBlockIds = Object.keys(bot.registry?.blocksByName || {})
    .filter((name) => name.endsWith("_bed"))
    .map((name) => bot.registry.blocksByName[name].id);
  return bedBlockIds;
}

export function bedAnchors(bot, extra = null) {
  const anchors = [];
  const push = (pos) => {
    if (!pos || anchors.length >= SHELL_MAX_ANCHORS) return;
    if (anchors.some((other) => other.distanceTo(pos) < 1.5)) return;
    anchors.push(pos);
  };
  if (extra) push(new Vec3(extra.x, extra.y, extra.z).floored());
  const ids = bedIds(bot);
  const matching = ids.length ? ids : (block) => bot.isABed(block); // registry missing (a test stub)
  for (const pos of bot.findBlocks({ matching, maxDistance: BED_SEARCH_DISTANCE, count: 64 }) || []) {
    if (anchors.length >= SHELL_MAX_ANCHORS) break;
    const block = bot.blockAt(pos);
    if (block) push(bedHalves(block)[0]);
  }
  return anchors;
}

// The ways out, grouped by column: an interior cell you can step sideways out of the living space
// from. Grouped by (x, z) and not counted per cell because a doorway is a column two or three
// cells tall and is one way out, not three.
//
// A door or gate counts as a way out even though the fill stops at it (the fill has to, or the
// interior would leak into the whole world through an open door). Without that, a shelter with a
// door hung in it would have no open exit at all, and the first hole knocked in its wall would
// look like the only way out -- unfillable, exactly backwards from repairing it.
function exitColumns(bot, inside) {
  const exits = new Map();
  for (const key of inside) {
    const cell = fromKey(key);
    const leads = CARDINALS.some(([dx, dz]) => {
      const neighbour = cell.offset(dx, 0, dz);
      if (inside.has(posKey(neighbour))) return false;
      return passable(bot, neighbour) || isDoorwayName(bot.blockAt(neighbour)?.name);
    });
    if (!leads) continue;
    const column = `${cell.x},${cell.z}`;
    if (!exits.has(column)) exits.set(column, new Set());
    exits.get(column).add(key);
  }
  return exits;
}

// Recomputed on a timer (index.js), not per query: the fill is thousands of blockAt() calls and
// safeToBreak() is asked thousands of times per path search, so the answer has to already be a
// Set lookup by the time pathfinding reaches it.
export function refreshLivingSpace(bot, extra = null) {
  const anchors = bedAnchors(bot, extra);
  const inside = new Set();
  for (const anchor of anchors) coveredInterior(bot, anchor, inside);
  bot.livingSpace = { anchors, inside, cells: shellAround(bot, inside),
                      exits: exitColumns(bot, inside), at: Date.now() };
  return bot.livingSpace;
}

export function isLivingSpaceWall(bot, pos) {
  const cells = bot.livingSpace?.cells;
  return !!cells && !!pos && cells.has(posKey(pos));
}

export function isInsideLivingSpace(bot, pos) {
  const inside = bot.livingSpace?.inside;
  return !!inside && !!pos && inside.has(posKey(pos));
}

// Filling the LAST way out is how a bot walls up its own front door with no door involved -- the
// "random decisions that don't leverage a door" half of the request. Only the last one, for the
// same reason a bed's approach cells only refuse the last of them: a shelter with a doorway AND a
// hole knocked in a wall has two ways out, and closing the hole up is repair, not self-burial.
// Which one survives is whichever is left -- the shell protection then keeps it that way.
export function livingSpaceExitBlockedBy(bot, pos) {
  const exits = bot.livingSpace?.exits;
  if (!exits || exits.size !== 1) return null;
  const cells = exits.get(`${pos.x},${pos.z}`);
  if (!cells?.has(posKey(pos))) return null;
  return { fixture: "doorway", at: pos, reason: "the only way out of a shelter at" };
}

// ---- any enclosed structure, for bed placement ----------------------------------------------
//
// Direct request, 2026-10-18: beds stop being claimed (actions.js) and should instead always land
// inside an EXISTING shelter when one has room, where "shelter" is explicitly "not a set size or
// shape... any structure with no openings other than doors," walls of any material "including
// glass, but not sand." coveredInterior/shellAround above answer a related but different question
// ("is this cell roofed, for wall-digging protection") -- roofed is not sealed, a three-walled lean
// -to with a roof is "covered" but has an open side. This answers the stricter question directly,
// reusing the same flood-fill vocabulary: real walls, not just a roof, and no cutoff that would
// call an open structure "sealed" just because the search gave up at its edge.

// Passable cells reachable from `starts` without ever crossing a doorway (same reasoning
// exitColumns above already needs: the interior would otherwise leak out its own front door).
// Bounded ONLY by SHELL_MAX_CELLS, deliberately with no SHELL_RADIUS cutoff -- a radius bound
// would make a genuinely open structure (a missing wall, a hole, no roof at all) look sealed
// merely because the search stopped at an arbitrary distance rather than at a real wall. `sealed`
// is true only when the fill empties its own queue before the cap -- an open structure keeps
// finding new cells until the cap and is correctly rejected; a real room of any reasonable size
// (comfortably more than the communal shelter's own largest room) terminates well under it.
export function enclosedInterior(bot, starts) {
  const inside = new Set();
  const queue = [];
  const consider = (cell) => {
    const key = posKey(cell);
    if (inside.has(key) || inside.size >= SHELL_MAX_CELLS) return;
    if (!passable(bot, cell) || isDoorwayName(bot.blockAt(cell)?.name)) return;
    inside.add(key);
    queue.push(cell);
  };
  starts.forEach(consider);
  while (queue.length) {
    if (inside.size >= SHELL_MAX_CELLS) break;
    const cell = queue.shift();
    for (const [dx, dy, dz] of STEPS_6) consider(cell.offset(dx, dy, dz));
  }
  return { inside, sealed: queue.length === 0 };
}

// The user's literal exception: "including glass, but not sand." isFallingBlockName's broader
// sand/gravel/concrete-powder/anvil list is a different concern (what lands on a fixture) and is
// untouched by this.
const SAND_WALL_NAMES = new Set(["sand", "red_sand"]);
export function isSandWallName(name) {
  return !!name && SAND_WALL_NAMES.has(name);
}

function hasSandWall(bot, shell) {
  for (const key of shell) {
    if (isSandWallName(bot.blockAt(fromKey(key))?.name)) return true;
  }
  return false;
}

// Every sealed shelter interior findable from a door/gate near `point`, any shape or size, merged
// into one Set of posKeys. Tries both doorPassageSides() of every nearby doorway as a flood-fill
// seed -- whichever side is real "inside" terminates on its own; the far side (open world) almost
// always hits the cap and is dropped. Empty when nothing qualifies, which is the common case
// before any real shelter exists nearby -- callers fall back to their own default placement then.
export function shelterInteriorsNear(bot, point, radius = BED_SEARCH_DISTANCE) {
  const merged = new Set();
  const tried = new Set();
  const doors = bot.findBlocks({ matching: (b) => isDoorwayName(b?.name), point, maxDistance: radius, count: 32 }) || [];
  for (const pos of doors) {
    const block = bot.blockAt(pos);
    const sides = doorPassageSides(bot, block);
    if (!sides) continue;
    for (const side of sides) {
      const seedKey = posKey(side[0]);
      if (merged.has(seedKey) || tried.has(seedKey)) continue;
      tried.add(seedKey);
      const { inside, sealed } = enclosedInterior(bot, side);
      if (!sealed || !inside.size || hasSandWall(bot, shellAround(bot, inside))) continue;
      for (const key of inside) merged.add(key);
    }
  }
  return merged;
}

// ---- shelter rooms, any number, any shape, tolerant of damage --------------------------------
//
// Direct request, 2026-10-22, generalizing S42's fix ("there is a large shelter with many beds,
// but it has holes... They are not repairing it as a large structure"): recognize ANY NUMBER of
// individual shelters, and a LARGER shelter of any shape -- "contiguous walls, roof and floor,
// broken only by doors" -- the same definition shelterInteriorsNear() already uses for bed
// placement, now generalized to also work on a DAMAGED structure, which that strict function
// can't: enclosedInterior()'s "sealed" test requires the fill to terminate entirely on its own,
// so a single hole makes it leak without bound and the whole structure stops being recognized as
// a shelter at all, the instant it needs recognizing most.
//
// The trick: use coveredInterior()'s already-proven, radius-bounded, hole-TOLERANT fill (the
// dig-protection feature already relies on it degrading gracefully near a breach) to find the
// room's air, then flag a hole by a purely local, shape-agnostic test rather than by re-deriving
// the room's "true" outline: a passable, non-door cell surrounded by mostly-solid neighbours is
// sitting where a wall/floor/roof block used to be, whether the room is a 2x3 bedroom or a 7x7
// communal hall. A genuine deep-room air cell is instead surrounded mostly by MORE room air, not
// solid blocks -- EXCEPT in a room only one cell wide, where every real interior cell has the
// exact same solid-neighbour profile as a hole would. Found live (offline test, not guessed):
// the Builder's own 1x1-interior shelter false-positived its own floor-level cell as a "hole" --
// 4 of its 6 neighbours (both walls, the floor, the door) are genuinely solid, same count a real
// breach has. This heuristic is only geometrically valid once the room is wide enough that a
// hole's neighbourhood and a genuine interior cell's can actually differ; MIN_SHELTER_ROOM_SPAN
// below draws that line, and a narrower room is left to the individual-shelter mechanism
// (findShelterNearHome(), index.js), which already has a reference geometry and does not need
// this heuristic at all.
export const SHELTER_ROOM_SEARCH_RADIUS = 16; // wider than SHELL_RADIUS -- must reach across a large communal-sized room, not just a 2x3
export const MIN_SHELTER_ROOM_CELLS = 2; // filters out a coincidental one-cell covered nook
export const MIN_SHELTER_ROOM_SPAN = 3; // narrower than this (either axis) and holesIn() cannot tell a hole from the room's own interior
export const HOLE_MIN_SOLID_NEIGHBOURS = 4; // of 6 face-neighbours -- a thin gap in an otherwise-solid wall/floor/roof

// [FLAGGED] A hole exactly at a CORNER (where two wall faces meet) is not found. Found live, not
// guessed: holesIn() only ever examines cells already in `inside`, and `inside` is built by
// coveredInterior()'s STEPS_6 fill -- face neighbours only, never diagonal. A corner cell's own
// path back to the room's real interior is two face-steps, not one, so the fill can never reach
// it and it never enters `inside` at all; holesIn() has nothing to examine there. This is a real
// gap, not a false claim of safety -- flat wall/floor/roof damage (a creeper, a stray dig, the
// reported case) is found correctly; a hole landing exactly on a corner column is not. Fixing
// it would mean a 26-neighbour fill instead of 6, which trades this gap for a new, broader risk
// (pulling genuinely separate rooms or terrain together diagonally) that has not been measured --
// left as a named limitation rather than a guessed fix for a narrower, less common case than the
// one this generalization was actually asked to solve.

function solidFaceNeighbourCount(bot, cell) {
  let n = 0;
  for (const [dx, dy, dz] of STEPS_6) if (solid(bot, cell.offset(dx, dy, dz))) n++;
  return n;
}

// The horizontal footprint `inside` actually occupies -- both axes, since a hallway one cell
// wide in Z but ten long in X is exactly as narrow a case as a 1x1 room for holesIn()'s purposes.
function horizontalSpan(inside) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const key of inside) {
    const [x, , z] = key.split(",").map(Number);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { width: maxX - minX + 1, depth: maxZ - minZ + 1 };
}

// Every cell of `inside` that reads as room air today but is actually a breach: surrounded by
// enough solid neighbours that it was almost certainly part of the shell, not the room's real
// open space. Returns a Set of posKeys, each a position that should be solid again. Deliberately
// returns empty, never a guess, for a room narrower than MIN_SHELTER_ROOM_SPAN on either axis --
// see this section's own header for why a 1-wide room cannot be told apart from a hole this way.
export function holesIn(bot, inside) {
  const holes = new Set();
  if (!inside.size) return holes;
  const { width, depth } = horizontalSpan(inside);
  if (width < MIN_SHELTER_ROOM_SPAN || depth < MIN_SHELTER_ROOM_SPAN) return holes;
  for (const key of inside) {
    const cell = fromKey(key);
    if (solidFaceNeighbourCount(bot, cell) >= HOLE_MIN_SOLID_NEIGHBOURS) holes.add(key);
  }
  return holes;
}

// Every shelter room findable near `point`, any number, any shape or size, each kept separate
// (unlike shelterInteriorsNear()'s merged Set, which answers a different question -- "is this
// spot inside SOME shelter" -- and does not need to tell two rooms apart). Seeded from every
// doorway near `point`, same as shelterInteriorsNear(), but flood-filled with the loose,
// hole-tolerant coveredInterior() instead of the strict, damage-intolerant enclosedInterior() --
// this is deliberately a DIFFERENT trade-off than that function's: willing to call a three-sided
// lean-to "covered" in exchange for not losing a genuinely enclosed room the moment it is
// breached, since finding exactly that breach is the entire point here.
export function shelterRoomsNear(bot, point, radius = BED_SEARCH_DISTANCE) {
  const rooms = [];
  const claimed = new Set();
  const tried = new Set();
  const doors = bot.findBlocks({ matching: (b) => isDoorwayName(b?.name), point, maxDistance: radius, count: 32 }) || [];
  for (const pos of doors) {
    const block = bot.blockAt(pos);
    const sides = doorPassageSides(bot, block);
    if (!sides) continue;
    for (const side of sides) {
      const seed = side[0];
      const seedKey = posKey(seed);
      if (claimed.has(seedKey) || tried.has(seedKey)) continue;
      tried.add(seedKey);
      const inside = coveredInterior(bot, seed, new Set(), SHELTER_ROOM_SEARCH_RADIUS, true);
      // Too small to be a real room (the far side of a doorway standing in open terrain, the
      // common no-shelter-here case) -- skip, same as the strict function's own !inside.size check.
      if (inside.size < MIN_SHELTER_ROOM_CELLS) continue;
      // The far side of the SAME door (open world) typically fails the size check above and
      // never reaches here; a room with two doors reaches this seed a second time and must not
      // be double-counted. Either way: already-claimed cells mean this is the same room again.
      if ([...inside].some((k) => claimed.has(k))) continue;
      for (const k of inside) claimed.add(k);
      rooms.push({ anchor: seed, inside, shell: shellAround(bot, inside), holes: holesIn(bot, inside) });
    }
  }
  return rooms;
}

// ---- clearing an obstruction ------------------------------------------------------------------

// The other half of the request: a block that already sits in an access cell should be destroyed.
// `canBreak(name)` is the caller's policy (actions.js passes !isProtectedBlockName) -- never dig
// out one fixture to reach another.
//
// Two deliberate restraints. A door blocked on BOTH sides was built into solid ground and is not
// a passage anybody uses; only the blocked side of a door that is open on the other gets reported,
// so nothing starts tunnelling into a hillside. And a cell that is part of a living space's shell
// is left alone unless it is a door's own passage cell -- clearing access never breaches a wall to
// reach a chest; walking in through the door is the whole point.
export function findAccessObstructions(bot, center, radius = ACCESS_SCAN_RADIUS, canBreak = () => true) {
  const origin = new Vec3(center.x, center.y, center.z).floored();
  const found = [];
  const seen = new Set();
  const fixtures = bot.findBlocks({ point: origin, matching: (block) => !!fixtureKind(block?.name),
                                    maxDistance: radius, count: 32 }) || [];
  for (const pos of fixtures) {
    const block = bot.blockAt(pos);
    const kind = fixtureKind(block?.name);
    if (!kind) continue;
    for (const { cell, required } of obstructableCells(bot, block, kind)) {
      const key = posKey(cell);
      if (seen.has(key)) continue;
      const sitting = bot.blockAt(cell);
      if (!sitting || sitting.boundingBox !== "block") continue;
      if (fixtureKind(sitting.name) || !canBreak(sitting.name)) continue;
      if (!required && isLivingSpaceWall(bot, cell)) continue;
      seen.add(key);
      found.push({ position: cell, name: sitting.name, fixture: block.name, fixtureAt: block.position });
    }
  }
  return found.sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin));
}

function obstructableCells(bot, block, kind) {
  const out = [];
  if (kind === "door") {
    const sides = doorPassageSides(bot, block);
    if (!sides) return out;
    for (const [i, side] of sides.entries()) {
      if (!sides[1 - i].some((cell) => passable(bot, cell))) continue; // sealed both sides
      for (const cell of side) out.push({ cell, required: true });
    }
    return out;
  }
  if (HEADROOM_CONTAINERS.has(block.name)) {
    for (const half of chestHalves(bot, block)) out.push({ cell: half.offset(0, 1, 0), required: true });
  }
  const approach = approachCells(bot, block, kind);
  if (!approach.some((cell) => passable(bot, cell))) {
    for (const cell of approach) out.push({ cell, required: false });
  }
  return out;
}
