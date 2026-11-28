// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/doors-1.test.mjs + doors-2.test.mjs against the
// Mindcraft-ported architecture. Unlike those old files (vm-sliced source, tests/unit/
// _harness.mjs), every real test here imports swim-movements.js/shelter.js/action-vocab.js
// directly -- all three were kept close to unchanged by the restart. The checks that lost their
// ground are the ones that lived in the old goal engine or in actions.js's own case handlers
// (archived whole, as action-*.js, in services/minecraft-bots-archive-11-2026/): bed/shelter SITE
// FINDING and BUILDING (findBedSites, shelterPositions, build/build_communal_shelter/patch_shelter),
// as opposed to shelter.js's own structure-DETECTION functions (refreshLivingSpace,
// shelterInteriorsNear, enclosedInterior, findAccessObstructions, wouldBlockAccess), which are
// still real and still exercised below. Run:
// node --test services/minecraft-bots/tests/legacy-baseline/doors.test.mjs
// (needs node_modules -- dgx-spark/spark2, same requirement tests/live.test.mjs already has).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { V3, sleep } from "./_mockbot.mjs";
import {
  applyDoorState, isDoorway, isOpenDoorOrGate, fixDoorWaypoints, isClosedOpenableDoorway,
  installDoorOpener, isClosableDoorway, holdDoorsOpen, installDoorCloser,
} from "../../swim-movements.js";
import {
  findAccessObstructions, refreshLivingSpace, isInsideLivingSpace, isLivingSpaceWall,
  wouldBlockAccess, doorPassageSides, enclosedInterior, shelterInteriorsNear, posKey,
} from "../../shelter.js";
import { isProtectedBlockName } from "../../action-vocab.js";

function doorBlock(name, props) {
  return { name, safe: false, physical: !name.endsWith("_fence_gate"), openable: name.endsWith("_fence_gate"),
    getProperties: () => props };
}

// A flat world: solid stone at y <= groundY, air above, plus blocks placed by name -- generic test
// infra (not a port of any production module), reconstructed from tests/unit/_harness.mjs's own
// blockWorld() since that helper has no dependency on archived code either.
function blockWorld({ groundY = 63 } = {}) {
  const at = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const bot = {
    blockAt(p) {
      if (!p) return null;
      const spec = at.get(key(p));
      if (spec) return { name: spec.name, position: p, boundingBox: spec.name === "air" ? "empty" : "block", getProperties: () => spec.props || {} };
      const stone = p.y <= groundY;
      const name = stone ? "stone" : "air";
      return { name, position: p, boundingBox: stone ? "block" : "empty", getProperties: () => ({}) };
    },
    findBlocks({ matching, point, maxDistance = 32, count = 16 }) {
      const origin = point || bot.entity.position;
      const out = [];
      for (const k of at.keys()) {
        const [bx, by, bz] = k.split(",").map(Number);
        const pos = new V3(bx, by, bz);
        if (pos.distanceTo(origin) > maxDistance) continue;
        if (matching(bot.blockAt(pos))) out.push(pos);
        if (out.length >= count) break;
      }
      return out;
    },
    isABed: (b) => !!b?.name?.endsWith("_bed"),
    username: "Babs",
    entity: { position: new V3(0, 64, 0) },
    entities: {},
    inventory: { items: () => [] },
    pathfinder: { goal: null, setGoal(g) { this.goal = g; }, movements: { canDig: true } },
    pvp: { target: null, stop() { this.target = null; } },
    collectBlock: { cancelTask() {} },
    stopDigging() {},
  };
  const place = ([bx, by, bz], name, props) => at.set(`${bx},${by},${bz}`, { name, props });
  const open = ([bx, by, bz]) => at.set(`${bx},${by},${bz}`, { name: "air" });
  const bed = ([bx, by, bz]) => {
    place([bx, by, bz], "white_bed", { facing: "south", part: "head" });
    place([bx, by, bz - 1], "white_bed", { facing: "south", part: "foot" });
  };
  const door = ([bx, by, bz], name = "oak_door", facing = "north") => {
    place([bx, by, bz], name, { facing, half: "lower", open: false });
    place([bx, by + 1, bz], name, { facing, half: "upper", open: false });
  };
  return { bot, place, open, bed, door, at };
}

// A sealed 1x1x3 room, walls on all four sides, a roof and a floor, one real door -- generic test
// infra, reconstructed verbatim from tests/unit/_harness.mjs's smallRoom() (also no archived
// dependency: it never called shelterPositions()).
function smallRoom({ wallName = "cobblestone" } = {}) {
  const w = blockWorld();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      w.place([dx, 63, dz], wallName); // floor
      w.place([dx, 67, dz], wallName); // roof
      if (dx === 0 && dz === 0) continue; // the interior column (y 64-66) stays open air
      for (let dy = 64; dy <= 66; dy++) {
        if (dx === 0 && dz === 1 && dy <= 65) continue; // the doorway (two cells tall), filled below
        w.place([dx, dy, dz], wallName);
      }
    }
  }
  w.door([0, 64, 1], "oak_door", "south");
  return w;
}

// A bot walking through a doorway one tick at a time, for installDoorCloser -- reconstructed from
// tests/unit/_harness.mjs's closerWorld(), now wired to the REAL installDoorCloser (swim-movements.js).
function closerWorld({ name = "oak_door", open = true } = {}) {
  const props = { half: "lower", open };
  const door = { name, position: new V3(0, 64, 0), getProperties: () => props };
  const bot = new EventEmitter();
  const used = []; let looked = 0;
  Object.assign(bot, {
    username: "Amy", entities: {}, entity: { position: new V3(0.5, 64, -2) },
    blockAt: (p) => (p.x === 0 && p.y === 64 && p.z === 0 ? door : { name: "air", getProperties: () => ({}) }),
    lookAt: async () => { looked++; },
  });
  bot.entities[1] = bot.entity;
  const activate = (b) => { used.push({ name: b.name, looked }); bot.lookAt(); props.open = !props.open; return Promise.resolve(); };
  installDoorCloser(bot, activate);
  const walk = async (...zs) => { for (const z of zs) { bot.entity.position = new V3(0.5, 64, z); bot.emit("physicsTick"); await sleep(0); } };
  return { bot, used, props, walk, looks: () => looked };
}

test('[legacy:doors] Doors: an open door or gate is walkable, never a floor', () => {
  for (const half of ["lower", "upper"]) {
    const b = applyDoorState(doorBlock("oak_door", { half, open: true }));
    assert.equal(b.safe, true, `open door ${half}`); assert.equal(b.physical, false); assert.equal(b.openable, false);
  }
  const iron = applyDoorState(doorBlock("iron_door", { half: "lower", open: true }));
  assert.equal(iron.safe, true, "an iron door held open by redstone is walkable too");
  const gate = applyDoorState(doorBlock("oak_fence_gate", { open: true }));
  assert.equal(gate.safe, true); assert.equal(gate.openable, false);
});

test('[legacy:doors] Doors: a closed wooden door or gate is routed through (never pathfinder\'s "use" step); a closed iron door is a wall', () => {
  const lower = applyDoorState(doorBlock("spruce_door", { half: "lower", open: false }));
  assert.equal(lower.openable, false, "the use step crashes the executor"); assert.equal(lower.safe, true); assert.equal(lower.physical, false);
  const upper = applyDoorState(doorBlock("spruce_door", { half: "upper", open: false }));
  assert.equal(upper.safe, true); assert.equal(upper.openable, false);
  const gate = applyDoorState(doorBlock("birch_fence_gate", { open: false }));
  assert.equal(gate.openable, false); assert.equal(gate.safe, true);
  const iron = applyDoorState(doorBlock("iron_door", { half: "lower", open: false }));
  assert.equal(iron.openable, false); assert.equal(iron.safe, false);
  const ironTop = applyDoorState(doorBlock("iron_door", { half: "upper", open: false }));
  assert.equal(ironTop.safe, false);
  const stone = { name: "stone", safe: false, physical: true, openable: false };
  assert.deepEqual({ ...applyDoorState(stone) }, { name: "stone", safe: false, physical: true, openable: false });
});

test('[legacy:doors] Doors: a doorway waypoint lifted onto the door, or left on its corner, goes back to the floor centre', () => {
  const door = { name: "oak_door", position: { y: 64 }, getProperties: () => ({ half: "lower", open: true }) };
  const bot = { blockAt: (p) => (p.x === 5 && p.y === 64 && p.z === 7 ? door : { name: "air", getProperties: () => ({}) }) };
  const path = [{ x: 5.5, y: 64, z: 6.5 }, { x: 5.703125, y: 65, z: 7.5 }, { x: 5, y: 64, z: 7 }, { x: 5.5, y: 64, z: 8.5 }];
  fixDoorWaypoints(bot, path);
  assert.deepEqual(path.map((p) => [p.x, p.y, p.z]), [[5.5, 64, 6.5], [5.5, 64, 7.5], [5.5, 64, 7.5], [5.5, 64, 8.5]]);
  assert.equal(isDoorway(door), true);
});

test('[legacy:doors] Close behind: a door she walked through is shut once she is clear, without turning her head', async () => {
  const w = closerWorld();
  await w.walk(-1, 0.5, 1.0); // through the doorway, still beside it
  assert.equal(w.used.length, 0, "not while she is still in or next to it");
  await w.walk(2.0, 2.5, 3.0);
  assert.equal(w.used.length, 1, "closed exactly once"); assert.equal(w.props.open, false);
  assert.equal(w.used[0].looked, 0, "no lookAt before the click");
  assert.equal(w.looks(), 0, "the bot's own lookAt was stubbed for the click and restored");
  const gate = closerWorld({ name: "oak_fence_gate" });
  await gate.walk(0.5, 2.5);
  assert.equal(gate.used.length, 1, "gates too");
});

test('[legacy:doors] Close behind: not on someone following, not while herding, not an iron or already-shut door', async () => {
  const w = closerWorld();
  w.bot.entities[2] = { type: "player", position: new V3(0.5, 64, -1) }; // a bot right behind her
  await w.walk(0.5, 2.5);
  assert.equal(w.used.length, 0, "held for the follower");
  w.bot.entities[2].position = new V3(0.5, 64, 2.6); // the follower is through too
  w.bot.entities[2].position.distanceTo = (o) => Math.hypot(0.5 - o.x, 64 - o.y, 2.6 - o.z) + 3; // and clear of it
  await w.walk(2.6);
  assert.equal(w.used.length, 1, "shut once nobody is at it");

  const herd = closerWorld({ name: "oak_fence_gate" });
  const release = holdDoorsOpen(herd.bot);
  await herd.walk(0.5, 2.5);
  release(); await herd.walk(2.6);
  assert.equal(herd.used.length, 0, "a doorway passed while herding is forgotten, not shut later");

  const iron = closerWorld({ name: "iron_door" });
  await iron.walk(0.5, 2.5);
  const shut = closerWorld({ open: false });
  await shut.walk(0.5, 2.5);
  assert.equal(iron.used.length + shut.used.length, 0);
});

test.todo('[legacy:doors] Close behind: herd_to_pen holds doors open only while leading, with the food out only then -- NOT PORTED: herd_to_pen was an actions.js case handler, archived whole (services/minecraft-bots-archive-11-2026/actions/herd-to-pen.js); no animal-penning skill exists in the new skills.js at all');

test.todo('[legacy:doors] Ranch goals: fences and gate crafted from the wood she has, pen built on a site, pair penned, bred -- NOT PORTED: the ranch goal (runRanchGoal) was part of the old persistent-goal engine, archived whole; the new index.js has no goal object and no autonomous ranch/breeding behavior at all');

test('[legacy:doors] Doors: a closed gate lifted onto its top is put back on the floor too', () => {
  const gate = { name: "oak_fence_gate", position: { y: 64 }, getProperties: () => ({ open: false }) };
  const bot = { blockAt: (p) => (p.x === 3 && p.y === 64 && p.z === 7 ? gate : { name: "air", getProperties: () => ({}) }) };
  const path = [{ x: 3.5, y: 65.5, z: 7.5 }];
  fixDoorWaypoints(bot, path);
  assert.deepEqual([path[0].x, path[0].y, path[0].z], [3.5, 64, 7.5]);
});

test('[legacy:doors] Doors: a closed door on her route is opened just ahead of her, without a head turn, not twice at once', async () => {
  const props = { half: "lower", open: false };
  const door = { name: "oak_door", position: new V3(0, 64, 2), getProperties: () => props };
  const bot = new EventEmitter();
  let looks = 0, moving = true; const used = [];
  Object.assign(bot, { username: "Amy", entity: { position: new V3(0.5, 64, 0.5) }, lookAt: async () => { looks++; },
    pathfinder: { isMoving: () => moving },
    blockAt: (p) => (p.x === 0 && p.y === 64 && p.z === 2 ? door : { name: "air", getProperties: () => ({}) }) });
  const activate = (b) => { bot.lookAt(); used.push(b.name); return new Promise(() => {}); }; // never settles: one at a time
  const route = { path: [{ x: 0.5, y: 64, z: 1.5 }, { x: 0.5, y: 64, z: 2.5 }, { x: 0.5, y: 64, z: 3.5 }] };
  installDoorOpener(bot, activate, route);
  bot.emit("physicsTick"); bot.emit("physicsTick");
  assert.deepEqual(used, ["oak_door"], "opened once, not again while the first click is pending");
  assert.equal(looks, 0, "her head didn't turn");
  moving = false; void moving;
  assert.equal(isClosedOpenableDoorway({ name: "iron_door", getProperties: () => ({ half: "lower", open: false }) }), false, "an iron door is never clicked");
  assert.equal(isClosableDoorway({ name: "iron_door", getProperties: () => ({ half: "lower", open: true }) }), false, "nor closed behind her");
});

test.todo('[legacy:doors] Communal shelter: stone-or-better material, parameterized geometry, a door-first build -- NOT PORTED: isCommunalShelterMaterial/communalShelterPositions/communalDoorwayPosition and the "build_communal_shelter" case lived in action-shelter.js, archived whole; no communal-shelter building exists in the new skills.js (which has no building/construction skill at all, Mindcraft-style or otherwise)');

test.todo('[legacy:doors] Shelter patch: takes an explicit hole list, never a door, never its own geometry -- NOT PORTED: "patch_shelter" was an action-shelter.js case handler, archived whole; shelter.js\'s own holesIn()/shelterRoomsNear() detection that would feed such a repair are still real and kept (see [legacy:shelter] below), only the action that consumed them is gone');

test.todo('[legacy:doors] Shelters: a doorless shell near home is found again, not abandoned for a new site -- NOT PORTED: unfinishedShelterNearHome()/isShelterDoor() lived in the old index.js plus the now-archived home-scan.js/priorities.js/action-shelter.js; no shelter-goal tracking exists in the new index.js, which has no persistent goal object at all');

test.todo('[legacy:doors] Shelter goal: a door is secured before the walls, and an unfinished shell is reused -- NOT PORTED: shelterStep() was part of the old persistent-goal engine, archived whole with goal-tick.js/shelter-goals.js');

test.todo('[legacy:doors] Shelter goal: levelling the site\'s apron fills with material she actually holds, not whatever repair_terrain would sample off the rim -- NOT PORTED: same shelterStep()/shelter-goals.js mechanism as the check above, archived whole');

// ---- from tests/unit/doors-2.test.mjs -----------------------------------------------------------

test.todo('[legacy:shelter] Beds: the first choice is a spot under a roof -- the shelter room, entered from its doorway -- NOT PORTED: findBedSites()/shelterPositions() (bed SITE finding, as opposed to bed USE) lived in action-shelter.js, archived whole; the new skills.goToBed(bot) only sleeps in an EXISTING bed found by world.js, it never chooses or builds a bed site');

test('[legacy:shelter] Access: a door sealed on both sides is left alone; one blocked side is cleared', () => {
  const w = blockWorld();
  w.door([0, 64, 6]);
  w.place([0, 64, 5], "cobblestone");
  w.place([0, 65, 5], "cobblestone");
  const oneSide = findAccessObstructions(w.bot, new V3(0, 64, 6), 4, () => true);
  assert.deepEqual([...oneSide].map((f) => f.position.z), [5, 5], "both cells of the blocked side");
  w.place([0, 64, 7], "cobblestone");
  w.place([0, 65, 7], "cobblestone");
  assert.deepEqual([...findAccessObstructions(w.bot, new V3(0, 64, 6), 4, () => true)], [],
    "a door built into solid ground on both sides is not a passage anyone uses");
});

test('[legacy:shelter] Shelter walls: the covered fill finds a sealed room, recognizes its doorway as the one way out, and never flags a cell deep inside', () => {
  // Reconstructed with a 1x2 interior (room enough for a bed), not the old fixed 2x3 Builder
  // shelter (shelterPositions(), archived with action-shelter.js) -- the claim under test
  // (refreshLivingSpace/isInsideLivingSpace/isLivingSpaceWall/wouldBlockAccess, all real, kept
  // unchanged in shelter.js) doesn't depend on that specific old geometry.
  const w = blockWorld();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 2; dz++) {
      w.place([dx, 63, dz], "cobblestone"); // floor
      w.place([dx, 67, dz], "cobblestone"); // roof
      if (dx === 0 && (dz === 0 || dz === 1)) continue; // the 1x2 interior stays open air
      for (let dy = 64; dy <= 66; dy++) {
        if (dx === 0 && dz === 2 && dy <= 65) continue; // the doorway (two cells tall), filled below
        w.place([dx, dy, dz], "cobblestone");
      }
    }
  }
  w.door([0, 64, 2], "oak_door", "south");
  w.bed([0, 64, 1]); // head at (0,64,1), foot at (0,64,0)

  // refreshLivingSpace's own fill (coveredInterior, stopAtDoors defaulted false) only needs
  // passable()+isCovered() -- a bed or a door block is boundingBox "block" in this mock world, so
  // neither its own cell nor the door's is ever "inside"; the air directly above the bed is.
  const space = refreshLivingSpace(w.bot, new V3(0, 64, 0));
  assert(space.inside.has(posKey(new V3(0, 65, 0))), "the covered air above the bed's foot is inside");
  assert(space.inside.has(posKey(new V3(0, 65, 1))), "the covered air above the bed's head is inside");
  assert.equal(isInsideLivingSpace(w.bot, new V3(0, 64, 2)), false, "the door's own (solid) cell is never \"inside\"");
  assert.equal(isInsideLivingSpace(w.bot, new V3(0, 64, 3)), false, "outside the door, no roof there either");
  assert.equal(isLivingSpaceWall(w.bot, new V3(-1, 65, 0)), true, "a wall block beside the covered air");
  assert.equal(isLivingSpaceWall(w.bot, new V3(0, 67, 0)), true, "the roof");
  // "A door or a bed landing in [the shell] set is already unbreakable via isProtectedBlockName --
  // harmless, not a case to special-case" (shelter.js's own shellAround() comment): the bed's own
  // cell is solid and touches the covered air above it, so it lands in the wall/shell set too.
  assert.equal(isLivingSpaceWall(w.bot, new V3(0, 64, 0)), true, "the bed's own cell, same reasoning");
  assert.equal(isLivingSpaceWall(w.bot, new V3(20, 63, 20)), false, "ordinary terrain well clear of it");

  const sealed = wouldBlockAccess(w.bot, new V3(0, 64, 1));
  // shelter.js's real reason strings: "the lid of", "the way through", "the last way up to", "the
  // only way out of a shelter at" -- the last of those comes from a different function entirely
  // (livingSpaceExitBlockedBy, not imported here). This cell sits on the path to the doorway, so
  // "the way through" (wouldBlockAccess's own doorway-passage reason) is the one it actually returns.
  assert(sealed && /way through/.test(sealed.reason), `the door's own inside passage cell is refused: ${JSON.stringify(sealed)}`);
  // The bed's foot is not an approach cell of the bed (those are the cells beside it, not its own
  // two halves) and touches no doorway, so hypothetically placing there cuts nothing off.
  assert.equal(wouldBlockAccess(w.bot, new V3(0, 64, 0)), null, "the bed's own cell blocks no fixture's access");
});

test('[legacy:shelter] Shelter detection: a fully enclosed room with one real door is sealed; a missing wall is not', () => {
  const w = smallRoom();
  // doorPassageSides' two sides are [+facing, -facing]; south steps +z, so [1] (-z) is the inside.
  const inside = doorPassageSides(w.bot, w.bot.blockAt(new V3(0, 64, 1)))[1];
  const { inside: cells, sealed } = enclosedInterior(w.bot, inside);
  assert.equal(sealed, true, "four walls, a roof and a floor, one real door -- nothing else open");
  assert(cells.has("0,64,0"), "the room interior itself is in it");
  assert(!cells.has("0,64,2"), "the far side of the door (outside) is a different flood, not merged in by this call");

  w.open([-1, 65, 0]); // knock a hole in the west wall, one block up
  const holed = enclosedInterior(w.bot, inside);
  assert.equal(holed.sealed, false, "a real gap in the wall leaks out into the open world instead of terminating");
});

test('[legacy:shelter] Shelter detection: shelterInteriorsNear finds a room from its door, and nothing from open terrain', () => {
  const w = smallRoom();
  const found = shelterInteriorsNear(w.bot, new V3(0, 64, 1), 8);
  assert(found.has("0,64,0"), "the room is found starting from its own door");
  const field = blockWorld();
  assert.equal(shelterInteriorsNear(field.bot, new V3(0, 64, 0), 8).size, 0, "no doors at all -- nothing qualifies");
});

test.todo('[legacy:shelter] Shelter patch: never fills a door\'s way through, even when handed it as a hole -- NOT PORTED: "patch_shelter" was an action-shelter.js case handler, archived whole; the invariant it protected (never place into a doorway) still holds for pathfinder\'s own incidental scaffolding via pathfinding.js\'s exclusionAreasPlace (wouldBlockAccess), but skills.placeBlock (the new, LLM-invoked placement primitive) consults no such check at all -- a real, un-reimplemented gap, not merely dropped scope');

test.todo('[legacy:shelter] Access: "place" takes another side rather than blocking a door, and says so when every side would -- NOT PORTED: the old "place" action (action-world.js, archived) searched outward from the bot for a free side and refused when every candidate would block a door; skills.placeBlock(bot, blockType, x, y, z, ...) (the new primitive) takes one explicit position with no site search and no door-awareness at all -- a genuine capability regression worth tracking, not a stylistic difference');

test('[legacy:shelter] Protected blocks: a pen fence is never dug through, like its gate', () => {
  for (const name of ["birch_fence", "oak_fence", "nether_brick_fence", "birch_fence_gate", "oak_door", "chest"])
    assert.equal(isProtectedBlockName(name), true, name);
  for (const name of ["birch_planks", "stone", "dirt"]) assert.equal(isProtectedBlockName(name), false, name);
});

test.todo('[legacy:shelter] Placement: every shelter, door, bed and fill placement clears its cell before placing -- NOT PORTED: clearCellForPlacement() and every case ("build"/"build_communal_shelter"/"patch_shelter"/"place_bed"/"place") it guarded were actions.js case handlers, archived whole; skills.placeBlock (new) calls no equivalent clearing step before placing -- a real gap, not merely dropped scope');

test.todo('[legacy:shelter] Doors: a shelter door faces through its doorway; a wrong-way one is no door, and build resets it -- NOT PORTED: isShelterDoor()/hasShelterNearHome()/unfinishedShelterNearHome() lived in actions.js and the old index.js, archived whole; no shelter-door orientation check exists in the new code, which has no shelter-building skill at all');
