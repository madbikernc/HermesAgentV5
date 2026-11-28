// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/shelter-1.test.mjs and tests/unit/shelter-2.test.mjs
// (27 old checks total) against the Mindcraft-ported architecture. See
// services/minecraft-bots-archive-11-2026/ for the archived "best past implementation" this
// measures against, and MINECRAFT_BOTS_RESTART_PLAN.md for why the goal/priority/curriculum
// engine those old checks largely tested was deliberately not re-created.
//
// shelter.js itself (detection/geometry: refreshLivingSpace, wouldBlockAccess, shelterRoomsNear,
// holesIn, shelterInteriorsNear, isSandWallName, isLivingSpaceWall, findAccessObstructions, ...)
// is KEPT, unchanged in kind, and is what most real tests below exercise directly -- no vm, no
// source-slicing, just the real module. What's gone is the GOAL-DRIVEN layer that decided to
// autonomously build/repair/size a shelter (shelter-goals.js, gear-goals.js, mayor.js curriculum,
// shelter-memory.js) -- those checks are test.todo with a reason naming the removed mechanism,
// not silently dropped.
//
// Run: node --test services/minecraft-bots/tests/legacy-baseline/shelter.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  posKey, bedHalves, chestHalves, wouldBlockAccess, restingCell, isFallingBlockName,
  refreshLivingSpace, isLivingSpaceWall, livingSpaceExitBlockedBy, isCovered,
  enclosedInterior, isSandWallName, shelterInteriorsNear, shelterRoomsNear, holesIn,
  findAccessObstructions, isDoorwayName,
} from "../../shelter.js";
import { isProtectedBlockName } from "../../action-vocab.js";
import { setupPathfinding } from "../../pathfinding.js";
import { placeBlock } from "../../skills.js";
import { V3, makeBot } from "./_mockbot.mjs";

// A flat world: solid stone at y <= groundY, air above, named blocks placed on top of that.
// Modeled on tests/unit/_harness.mjs's blockWorld(), wired to the REAL shelter.js instead of a
// vm context. `registry.blocksByName` needs real-looking ids so bedAnchors()/doorAnchors()'s
// id-based scan (and pathfinding's blocksCantBreak-by-id loop) works the way the live registry does.
const BLOCK_NAMES = ["air", "stone", "cobblestone", "dirt", "sand", "glass", "glass_pane",
  "chest", "white_bed", "oak_door", "sand"];
function makeRegistry() {
  const blocksByName = {};
  const blocksArray = [];
  BLOCK_NAMES.forEach((name, i) => {
    const b = { name, id: i + 1, emitLight: 0 };
    blocksByName[name] = b;
    blocksArray.push(b);
  });
  return { blocksByName, blocksArray, itemsByName: {} };
}

function blockWorld({ groundY = 63 } = {}) {
  const at = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const bot = makeBot({ registry: makeRegistry() });
  bot.blockAt = (p) => {
    const spec = at.get(key(p));
    const position = new V3(p.x, p.y, p.z);
    if (spec) {
      return { name: spec.name, position, boundingBox: spec.name === "air" ? "empty" : "block",
        getProperties: () => spec.props || {} };
    }
    const stone = p.y <= groundY;
    const name = stone ? "stone" : "air";
    return { name, position, boundingBox: stone ? "block" : "empty", getProperties: () => ({}) };
  };
  bot.findBlocks = ({ matching, point, maxDistance = 32, count = 32 }) => {
    const origin = point || bot.entity.position;
    const ids = typeof matching === "function" ? null : new Set([].concat(matching));
    const out = [];
    for (const k of at.keys()) {
      const [bx, by, bz] = k.split(",").map(Number);
      const pos = new V3(bx, by, bz);
      if (pos.distanceTo(origin) > maxDistance) continue;
      const block = bot.blockAt(pos);
      const hit = ids ? ids.has(bot.registry.blocksByName[block.name]?.id) : matching(block);
      if (hit) out.push(pos);
      if (out.length >= count) break;
    }
    return out;
  };
  bot.isABed = (b) => !!b?.name?.endsWith("_bed");
  const place = (bx, by, bz, name, props) => at.set(key({ x: bx, y: by, z: bz }), { name, props });
  const bed = (bx, by, bz, facing = "south") => {
    place(bx, by, bz, "white_bed", { facing, part: "head" });
    place(bx, by, bz - 1, "white_bed", { facing, part: "foot" });
  };
  const door = (bx, by, bz, facing = "north") => {
    place(bx, by, bz, "oak_door", { facing, half: "lower", open: false });
    place(bx, by + 1, bz, "oak_door", { facing, half: "upper", open: false });
  };
  return { bot, place, bed, door, at };
}

// A 3x3x3 room (interior 1x1x1 is too narrow for holesIn() -- MIN_SHELTER_ROOM_SPAN); used where
// a wider room matters, callers pass size explicitly.
function room(w, { baseX = 0, baseZ = 0, wallName = "cobblestone", width = 3, depth = 3, doorFacing = "south" } = {}) {
  const half = (n) => Math.floor(n / 2);
  for (let dx = -half(width); dx <= width - half(width) - 1; dx++) {
    for (let dz = -half(depth); dz <= depth - half(depth) - 1; dz++) {
      w.place(baseX + dx, 63, baseZ + dz, wallName); // floor
      w.place(baseX + dx, 67, baseZ + dz, wallName); // roof
      const edge = dx === -half(width) || dx === width - half(width) - 1 || dz === -half(depth) || dz === depth - half(depth) - 1;
      if (!edge) continue;
      for (let dy = 64; dy <= 66; dy++) w.place(baseX + dx, dy, baseZ + dz, wallName);
    }
  }
  const doorZ = doorFacing === "south" ? depth - half(depth) - 1 : -half(depth);
  w.place(baseX, 64, baseZ + doorZ, "air");
  w.place(baseX, 65, baseZ + doorZ, "air");
  w.door(baseX, 64, baseZ + doorZ, doorFacing);
  return new V3(baseX, 64, baseZ + doorZ);
}

// ---- shelter-1.test.mjs (12 checks) -----------------------------------------------------------

test.todo('[legacy:shelter-1] Shelter memory: known_shelters.json records a residence by its door, merging updates -- NOT PORTED: shelter-memory.js is archived; no current module persists a shelter registry at all.');

test.todo('[legacy:shelter-1] Communal shelter: fleet-wide iron-tool evidence, never a bare claim -- NOT PORTED: fleetHasReachedIronTools() lived in the archived goal/curriculum engine (mayor.js/longterm.js); no current evidence-tracking exists.');

test.todo('[legacy:shelter-1] Communal shelter: sized per the operator\'s own rule (at least N+1 beds for N bots) -- NOT PORTED: communalShelterSize()/communalShelterPositions() are archived with the rest of shelter-goals.js; nothing currently sizes or builds a communal structure.');

test.todo('[legacy:shelter-1] Communal shelter: "communal" routes to its own runner, not the individual-shelter one -- NOT PORTED: farmTask/goal-type routing is part of the archived goal engine (goal-tick.js/goal-runners.js); the new decision loop has no goal-type dispatch at all.');

test.todo('[legacy:shelter-1] Shelters: any mix of plain building blocks; never sand, gravel, valuables or functional blocks -- NOT PORTED: SHELTER_MATERIAL selection is autonomous-building logic (shelter-goals.js, archived); nothing currently builds a shelter, so nothing currently chooses its materials.');

test('[legacy:shelter-1] Communal shelter / checkShelterIntegrity, generalized: shelterRoomsNear finds a damaged room as a repair target, not just complete-or-nothing', () => {
  // The old communal-specific wrapper (findCommunalShelterNearHome) and the unified periodic
  // repair dispatcher (checkShelterIntegrity, index.js) are both archived -- but the detection
  // primitive they were both built on, shelterRoomsNear()/holesIn(), is exactly what survived
  // into shelter.js (1.3.0's own header: "generalizes... recognize any number of individual
  // shelters and a larger shelter of any shape... tolerant of real damage"). This exercises that
  // surviving primitive directly: a 5x5 room with one wall cell knocked out reads as a damaged
  // room with exactly that hole, not as "not a shelter at all".
  const w = blockWorld();
  room(w, { width: 5, depth: 5 });
  w.place(2, 65, 0, "air"); // knock a hole in the east wall, mid-height
  const rooms = shelterRoomsNear(w.bot, new V3(0, 64, 0));
  assert.equal(rooms.length, 1, "exactly one room found");
  assert.equal(rooms[0].holes.size, 1, "exactly one hole found");
  assert.ok(rooms[0].holes.has(posKey(new V3(2, 65, 0))), "the hole is the cell actually knocked out");
});

test.todo('[legacy:shelter-1] Shelters: the site is a flat, clear 4x5 within 4 blocks of home, even a step above or below it -- NOT PORTED: findShelterSite() (site selection for autonomously BUILDING a shelter) is archived with shelter-goals.js; goToBed (skills.js) only ever uses an existing bed, it never builds one.');

test.todo('[legacy:shelter-1] Shelters: a shallow pond in the footprint is filled instead of refusing the site -- NOT PORTED: same findShelterSite()/building pipeline as above, archived.');

test.todo('[legacy:shelter-1] Shelters: a shallow dip in the apron outside the footprint is levelable, a real cliff is not -- NOT PORTED: same findShelterSite() terrain-leveling logic, archived.');

test.todo('[legacy:shelter-1] Shelters: a crowded core still finds a site farther out once maxRadius allows it -- NOT PORTED: same findShelterSite() ring-expansion logic, archived.');

test('[legacy:shelter-1] Shelter detection near a point at a different elevation finds a real shelter a block above or below it', () => {
  // The old claim bundled two things: free-text goal-type recognition ("shelter" vs other words
  // in a directive) and hasShelterNearHome()'s own elevation tolerance. The first has no current
  // equivalent at all -- the new decision loop never parses free text into a goal type, commands
  // are explicit (!goToBed etc.) -- so only the detection half is exercised here, via
  // shelterInteriorsNear() (the function hasShelterNearHome() itself called), seeded one block
  // above the door's own foot level the way a real step/half-slab approach would be.
  const w = blockWorld();
  room(w);
  const interiors = shelterInteriorsNear(w.bot, new V3(0, 65, 1));
  assert.ok(interiors.size > 0, "a real shelter one block above the seed point is still found");
});

// ---- shelter-2.test.mjs (15 checks) -----------------------------------------------------------

test.todo('[legacy:shelter-2] Shelter upgrade: dirt and wood cells are dug out and refilled with stone, one at a time -- NOT PORTED: autonomous shelter upgrading is archived with shelter-goals.js; no current skill performs it.');

test('[legacy:shelter-2] Access: a falling block is judged where it lands, not where it leaves her hand', () => {
  const w = blockWorld();
  w.place(0, 64, 0, "chest");
  // Sand dropped two cells above the chest's lid falls and lands directly on it.
  const result = wouldBlockAccess(w.bot, new V3(0, 66, 0), "sand");
  assert.ok(result, "flagged, even though the placement cell itself is not the lid");
  assert.ok(result.falls?.equals(new V3(0, 65, 0)), "the resting cell is the chest's lid, not the drop point");
  assert.equal(isFallingBlockName("sand"), true);
  assert.equal(isFallingBlockName("cobblestone"), false, "a non-falling block is judged only at the placement cell");
});

test('[legacy:shelter-2] Shelter walls: a hole in a wall is a second way out, so it can be filled back in', () => {
  const w = blockWorld();
  room(w, { width: 5, depth: 5 });
  w.bed(0, 64, -1);
  w.place(2, 65, 0, "air"); // a second opening, directly in a wall
  refreshLivingSpace(w.bot);
  // Two ways out now (the real door, and the hole) -- livingSpaceExitBlockedBy only ever protects
  // the LAST remaining exit, so neither one is "the only way out" while both are open.
  assert.equal(livingSpaceExitBlockedBy(w.bot, new V3(2, 65, 0)), null, "the hole's own column is not treated as the sole exit");
});

test('[legacy:shelter-2] Shelter walls: a freshly built shell with no bed yet is still protected, from its door', () => {
  const w = blockWorld();
  room(w, { width: 3, depth: 3 });
  // No bed placed at all -- doorAnchors() (shelter.js 1.4.0) must protect the shell on its own.
  const space = refreshLivingSpace(w.bot);
  assert.ok(space.cells.size > 0, "the shell has real protected cells even with no bed inside it");
  assert.equal(isLivingSpaceWall(w.bot, new V3(-1, 65, 0)), true, "a side wall reads as protected");
});

test('[legacy:shelter-2] Shelter walls: pathfinder refuses to dig one, and still digs ordinary terrain -- currently FAILS: no dig-exclusion is wired to isLivingSpaceWall at all', () => {
  // setupPathfinding() wires wouldBlockAccess into exclusionAreasPlace (scaffolding only) and
  // isProtectedBlockName into blocksCantBreak (by BLOCK TYPE, e.g. beds/doors/chests) -- but never
  // wires isLivingSpaceWall into any dig-exclusion. A shelter wall built of ordinary cobblestone
  // is therefore diggable exactly like the same block anywhere else in the world: the old
  // position-based protection this check asserted does not exist in the new pathfinder wiring.
  const w = blockWorld();
  room(w, { width: 3, depth: 3 });
  w.bed(0, 64, -1);
  refreshLivingSpace(w.bot);
  const wallPos = new V3(-1, 65, 0);
  assert.equal(isLivingSpaceWall(w.bot, wallPos), true, "shelter.js still correctly identifies it as a wall cell");
  setupPathfinding(w.bot, { username: "Amy" });
  const wallBlockId = w.bot.registry.blocksByName.cobblestone.id;
  assert.equal(w.bot.pathfinder.movements.blocksCantBreak.has(wallBlockId), false,
    "REGRESSION: cobblestone is not in blocksCantBreak, and nothing else consults isLivingSpaceWall before a dig -- the pathfinder can dig straight through this shelter wall");
});

test('[legacy:shelter-2] Shelter detection: a sand wall disqualifies an otherwise-sealed room; glass does not', () => {
  const sealed = blockWorld();
  room(sealed, { width: 3, depth: 3 });
  assert.ok(shelterInteriorsNear(sealed.bot, new V3(0, 64, 0)).size > 0, "an ordinary cobblestone room qualifies");

  const sandy = blockWorld();
  room(sandy, { width: 3, depth: 3, wallName: "sand" });
  assert.equal(shelterInteriorsNear(sandy.bot, new V3(0, 64, 0)).size, 0, "a sand-walled room is disqualified");
  assert.equal(isSandWallName("sand"), true);
  assert.equal(isSandWallName("glass"), false, "glass is explicitly allowed by the same rule");

  const glassy = blockWorld();
  room(glassy, { width: 3, depth: 3, wallName: "glass" });
  assert.ok(shelterInteriorsNear(glassy.bot, new V3(0, 64, 0)).size > 0, "a glass-walled room still qualifies");
});

test('[legacy:shelter-2] Shelter rooms (general): a sealed room is recognized with zero holes, even when it is too narrow for hole-finding itself', () => {
  // A 1-wide room (narrower than MIN_SHELTER_ROOM_SPAN) must never guess at holes -- holesIn()
  // documents exactly why: it can't tell a hole from the room's own interior at that width.
  const w = blockWorld();
  for (let dy = 64; dy <= 66; dy++) { w.place(-1, dy, 0, "cobblestone"); w.place(1, dy, 0, "cobblestone"); }
  w.place(0, 63, 0, "cobblestone"); w.place(0, 67, 0, "cobblestone");
  w.place(0, 64, -1, "cobblestone"); w.place(0, 65, -1, "cobblestone"); w.place(0, 66, -1, "cobblestone");
  w.door(0, 64, 1);
  const rooms = shelterRoomsNear(w.bot, new V3(0, 64, 0));
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].holes.size, 0, "a 1-wide room never reports a false hole");
});

test('[legacy:shelter-2] Shelter rooms (general): any number of separate individual shelters, each kept apart', () => {
  const w = blockWorld();
  room(w, { baseX: 0, baseZ: 0, width: 3, depth: 3 });
  room(w, { baseX: 10, baseZ: 0, width: 3, depth: 3 });
  room(w, { baseX: 0, baseZ: 10, width: 3, depth: 3 });
  const rooms = shelterRoomsNear(w.bot, new V3(5, 64, 5), 20);
  assert.equal(rooms.length, 3, "three separate rooms, not merged into one or lost");
});

test('[legacy:shelter-2] Shelter rooms (general): a larger shelter, a shape neither fixed geometry builds, is recognized and its hole found', () => {
  const w = blockWorld(); // neither the old 2x3 bedroom nor any fixed communal size
  room(w, { width: 7, depth: 5 });
  w.place(3, 65, -1, "air"); // a hole in the far wall
  const rooms = shelterRoomsNear(w.bot, new V3(0, 64, 0));
  assert.equal(rooms.length, 1);
  assert.ok(rooms[0].holes.has(posKey(new V3(3, 65, -1))), "the hole in the irregular-sized room is found");
});

test('[legacy:shelter-2] Access: findAccessObstructions reports what is in the way and which fixture it would free', () => {
  // The DETECTION half ("ask first") is kept in shelter.js; the ACTING half of the old
  // "clear_access" action (dig it, report in that exact wording) is archived with actions.js --
  // there is no current !clearAccess command or skill. Only detection is exercised here.
  const w = blockWorld();
  w.place(0, 64, 0, "chest");
  w.place(0, 65, 0, "cobblestone"); // sits on the chest's required headroom cell
  const found = findAccessObstructions(w.bot, new V3(0, 64, 0), 8, (name) => !isProtectedBlockName(name));
  assert.equal(found.length, 1);
  assert.equal(found[0].fixture, "chest");
  assert.ok(found[0].position.equals(new V3(0, 65, 0)));
});

test.todo('[legacy:shelter-2] Access: a collectBlock "No path to the goal!" beside the block is retried, not reported as still in the way -- NOT PORTED: that retry was actions.js\'s own deliberate-mine error handling (archived); skills.collectBlock (Mindcraft) has no such retry.');

test.todo('[legacy:shelter-2] Shelter walls: "mine" skips a target inside one, and says so when that is all there is -- NOT PORTED: actions/mine.js\'s own isLivingSpaceWall pre-check is archived; skills.breakBlockAt/collectBlock (Mindcraft) have no shelter-wall guard before digging a named block.');

test('[legacy:shelter-2] Access: placing a block that would block a fixture is refused -- currently FAILS: skills.placeBlock calls no access check at all', async () => {
  // Every old placement action (place, place_bed, place_home, build, herd_to_pen's fencing, ...)
  // asked wouldBlockAccess() first. The only current wiring of wouldBlockAccess is
  // pathfinding.js's own scaffolding exclusion (incidental placement during a path search) --
  // skills.placeBlock (the Mindcraft-ported, deliberate placement primitive every !placeHere
  // command and skill call goes through) calls it nowhere.
  const w = blockWorld();
  w.place(0, 64, 0, "chest");
  w.bot.entity.position = new V3(0, 64, 2);
  w.bot.inventory.items = () => [{ name: "cobblestone", count: 1 }];
  w.bot.inventory.findInventoryItem = (name) => (name === "cobblestone" ? { name: "cobblestone", count: 1 } : null);
  w.bot.heldItem = { name: "cobblestone" };
  let placed = false;
  w.bot.placeBlock = async () => { placed = true; };
  w.bot.pathfinder.goto = async () => {};
  await placeBlock(w.bot, "cobblestone", 0, 65, 0); // the chest's required headroom cell
  assert.equal(placed, false,
    "REGRESSION: expected the placement to be refused (it blocks the chest's lid); skills.placeBlock placed it anyway");
});

test.todo('[legacy:shelter-2] Build: a wall cell the pathfinder can never reach is logged and counted, not a silent, permanent skip -- NOT PORTED: that bookkeeping belonged to the archived autonomous "build" action (actions/build.js); no current skill builds multi-cell structures at all.');

test.todo('[legacy:shelter-2] Torches: a trail torch goes down every 6 blocks of covered tunnel, on the floor before a wall -- NOT PORTED: tunneling.js (trail spacing/floor-preference while digging) is archived. modes.js\'s torch_placing mode is a different, simpler periodic placement with no spacing or floor-preference logic.');
