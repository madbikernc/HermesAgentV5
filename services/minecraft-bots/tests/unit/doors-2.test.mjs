// Version: 1.0.0
//
// Unit checks: doors and doorways (part 2 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/doors-2.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, swim, V3, between, actionFn, timeoutFn, context, shelter, check, bedFns, shelterFns, blockWorld, shelterLivingSpace, smallRoom, room, passedCount } from './_harness.mjs';


await check('Beds: the first choice is a spot under a roof -- the shelter room, entered from its doorway', async () => {
  const c = bedFns();
  vm.runInContext(between(actions, 'function cellOccupied(', 'export function findBedSite('), c);
  const s = shelterFns();
  const base = new V3(5, 64, 5);
  const walls = new Set(s.shelterPositions(base).map((p) => `${p.x},${p.y},${p.z}`));
  const bot = { entity: {}, entities: {}, isABed: () => false, findBlocks: () => [],
    blockAt: (p) => (p.y < 64 || walls.has(`${p.x},${p.y},${p.z}`) ? { name: 'cobblestone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) };
  const site = c.findBedSites(bot, new V3(0, 64, 0))[0];
  // 2026-10-11: the room grew from 2x2 to 2x3 rows (local z 0-1 -> 0-2), so the middle row (local
  // z=1) now has two equally-scored orientations -- head toward the open doorway gap or away from
  // it -- and BED_DIRS tries (0,1) before (0,-1), so the former wins the tie.
  assert.deepEqual([site.foot.x, site.foot.z, site.head.x, site.head.z, site.stand.x, site.stand.z], [5, 6, 5, 7, 5, 5],
    'foot (0,1) and head (0,2) of the room, standing at (0,0) to place it');
  const atSpawn = c.findBedSites(bot, base)[0]; // spawn inside the shelter, as at the fleet's home
  assert.deepEqual([atSpawn.foot.x, atSpawn.foot.z], [5, 6], 'the room is still used when it sits on spawn');
});


await check('Access: a door sealed on both sides is left alone; one blocked side is cleared', async () => {
  const c = shelter();
  const w = blockWorld();
  w.door([0, 64, 6]);
  w.place([0, 64, 5], 'cobblestone');
  w.place([0, 65, 5], 'cobblestone');
  const oneSide = c.findAccessObstructions(w.bot, new V3(0, 64, 6), 4, () => true);
  assert.deepEqual([...oneSide].map((f) => f.position.z), [5, 5], 'both cells of the blocked side');
  w.place([0, 64, 7], 'cobblestone');
  w.place([0, 65, 7], 'cobblestone');
  assert.deepEqual([...c.findAccessObstructions(w.bot, new V3(0, 64, 6), 4, () => true)], [],
    'a door built into solid ground on both sides is not a passage anyone uses');
});


await check('Shelter walls: the covered fill finds the room, stops at the doorway, and names every wall', async () => {
  const { c, w, base, space } = shelterLivingSpace();
  assert.equal(space.anchors.length, 1, 'one bed, not two halves');
  // 2026-10-11: the doorway's lintel (y 2) now rejoins the wall fill (doorwayPosition() only
  // takes the two door-height cells, y 0-1), so only those two, not all three, are still passable.
  // Also 2026-10-11: the room itself grew from 2x2 to 2x3 rows (a real door and a bed could never
  // both fit in 2x2 -- SHELTER_ROOM's own header comment has the full account), moving the doorway
  // from local z=2 to z=3.
  assert.equal(space.inside.size, 18, '2x3 room x3 high less the two bed blocks, plus the doorway\'s two door-height cells');
  assert.equal(c.isInsideLivingSpace(w.bot, base.offset(0, 0, 3)), true, 'the doorway is inside');
  assert.equal(c.isInsideLivingSpace(w.bot, base.offset(0, 0, 4)), false, 'the step outside it is not -- no roof there');

  assert.equal(c.isLivingSpaceWall(w.bot, base.offset(-1, 1, 0)), true, 'a wall block');
  assert.equal(c.isLivingSpaceWall(w.bot, base.offset(0, 3, 0)), true, 'the roof');
  assert.equal(c.isLivingSpaceWall(w.bot, base.offset(0, -1, 0)), true, 'the floor');
  assert.equal(c.isLivingSpaceWall(w.bot, base.offset(20, -1, 20)), false, 'ordinary terrain well clear of it');

  // The doorway: filling it seals the shelter even though no door hangs there yet.
  assert.deepEqual([...space.exits.keys()], ['0,3'], 'one way out: the doorway column');
  const sealed = c.wouldBlockAccess(w.bot, base.offset(0, 0, 3));
  assert(sealed && /way out/.test(sealed.reason), `the doorway is refused: ${JSON.stringify(sealed)}`);
  assert.equal(c.wouldBlockAccess(w.bot, base.offset(1, 0, 1)), null, 'a cell deep inside the room is not an exit');
});


await check('Shelter detection: a fully enclosed room with one real door is sealed; a missing wall is not', async () => {
  const c = shelter();
  const w = smallRoom();
  // doorPassageSides' two sides are [+facing, -facing]; south steps +z, so [1] (-z) is the inside.
  const inside = c.doorPassageSides(w.bot, w.bot.blockAt(new V3(0, 64, 1)))[1];
  const { inside: cells, sealed } = c.enclosedInterior(w.bot, inside);
  assert.equal(sealed, true, 'four walls, a roof and a floor, one real door -- nothing else open');
  assert(cells.has('0,64,0'), 'the room interior itself is in it');
  assert(!cells.has('0,64,2'), 'the far side of the door (outside) is a different flood, not merged in by this call');

  w.open([-1, 65, 0]); // knock a hole in the west wall, one block up
  const holed = c.enclosedInterior(w.bot, inside);
  assert.equal(holed.sealed, false, 'a real gap in the wall leaks out into the open world instead of terminating');
});


await check('Shelter detection: shelterInteriorsNear finds a room from its door, and nothing from open terrain', async () => {
  const c = shelter();
  const w = smallRoom();
  const found = c.shelterInteriorsNear(w.bot, new V3(0, 64, 1), 8);
  assert(found.has('0,64,0'), 'the room is found starting from its own door');

  const field = blockWorld();
  assert.equal(c.shelterInteriorsNear(field.bot, new V3(0, 64, 0), 8).size, 0, 'no doors at all -- nothing qualifies');
});


await check('Shelter patch: never fills a door\'s way through, even when handed it as a hole', async () => {
  // Live, 2026-11-02: a plank kept reappearing in the cell inside a shelter door, and
  // clear_access kept digging it back out. Every other placer asks wouldBlockAccess first.
  const w = blockWorld();
  w.door([0, 64, 1]); // facing north: (0,64,0) and (0,64,2) are its way through
  w.bot.inventory.items = () => [{ name: 'cobblestone', count: 64 }];
  w.bot.equip = async () => {};
  w.bot.pathfinder.goto = async () => {};
  w.bot.pathfinder.setMovements = () => {};
  const placed = [];
  w.bot.placeBlock = async (ref, face) => placed.push(ref.position.offset(face.x, face.y, face.z).toString());
  const c = context(w.bot, { Vec3: V3, attemptBoatCrossing: async () => false,
    shelterMaterialCount: () => 64, isShelterMaterial: () => true,
    clearCellForPlacement: async () => {}, refreshGear: async () => {} });
  vm.runInContext(timeoutFn + actionFn, c);
  await c.performAction(w.bot, { type: 'patch_shelter', holes: [{ x: 0, y: 64, z: 0 }] }, 'test');
  assert.deepEqual(placed, [], 'the doorway stays open');
});


await check('Access: "place" takes another side rather than blocking a door, and says so when every side would', async () => {
  const w = blockWorld();
  // Standing at (0,64,0). The first side "place" tries is +x, and a door at (1,64,1) facing north
  // makes (1,64,0) its own way through -- so the furnace has to go on the next side instead.
  w.door([1, 64, 1]);
  w.bot.inventory.items = () => [{ name: 'furnace' }];
  w.bot.equip = async () => {};
  const placed = [];
  w.bot.placeBlock = async (ref) => placed.push(`${ref.position.x},${ref.position.y},${ref.position.z}`);
  const c = context(w.bot, { Vec3: V3, attemptBoatCrossing: async () => false });
  vm.runInContext(timeoutFn + actionFn, c);
  const result = await c.performAction(w.bot, { type: 'place', item: 'furnace' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(placed, ['-1,63,0'], 'placed on the next side, not into the doorway at (1,64,0)');

  // Four doors facing her, two blocks out on each axis: every candidate cell is a way through.
  const boxed = blockWorld();
  boxed.door([0, 64, 2]);
  boxed.door([0, 64, -2]);
  boxed.door([2, 64, 0], 'spruce_door', 'east');
  boxed.door([-2, 64, 0], 'spruce_door', 'east');
  boxed.bot.inventory.items = () => [{ name: 'furnace' }];
  boxed.bot.equip = async () => {};
  boxed.bot.placeBlock = async () => { throw new Error('should never place'); };
  const c2 = context(boxed.bot, { Vec3: V3, attemptBoatCrossing: async () => false });
  vm.runInContext(timeoutFn + actionFn, c2);
  const refused = await c2.performAction(boxed.bot, { type: 'place', item: 'furnace' }, 'test');
  assert.equal(refused.ok, false);
  assert.match(refused.text, /wouldn't block the way through the \w+_door/, refused.text);
});


await check('Protected blocks: a pen fence is never dug through, like its gate', async () => {
  // Direct report, 2026-11-01: "they are destroying the fence in the pen".
  const c = vm.createContext({});
  vm.runInContext(between(actions, 'const PROTECTED_BLOCK_NAMES = [', '// Direct request, 2026-09-07 ("what other logic').replace(/export /g, ''), c);
  for (const name of ['birch_fence', 'oak_fence', 'nether_brick_fence', 'birch_fence_gate', 'oak_door', 'chest'])
    assert.equal(c.isProtectedBlockName(name), true, name);
  for (const name of ['birch_planks', 'stone', 'dirt']) assert.equal(c.isProtectedBlockName(name), false, name);
});


await check('Placement: every shelter, door, bed and fill placement clears its cell before placing', async () => {
  const caseSrc = (name) => between(actions, `    case "${name}": {`, '\n    case "');
  const before = (src, clear, place, what) =>
    assert(src.indexOf(clear) >= 0 && src.indexOf(clear) < src.indexOf(place), what);
  for (const name of ['build', 'build_communal_shelter', 'patch_shelter']) {
    before(caseSrc(name), 'clearCellForPlacement(bot, pos)', 'bot.placeBlock(refBlock, face)', `${name}: walls`);
  }
  for (const name of ['build', 'build_communal_shelter']) {
    before(caseSrc(name), 'clearCellForPlacement(bot, doorPos.offset(0, 1, 0))', 'bot._placeBlockWithOptions(floorBelow', `${name}: both door cells`);
  }
  const bed = caseSrc('place_bed');
  before(bed, 'clearCellForPlacement(bot, candidate.head)', 'bot.placeBlock(bot.blockAt(candidate.foot', 'place_bed: both bed cells');
  before(caseSrc('place'), 'clearCellForPlacement(bot, referenceBlock.position', 'bot.placeBlock(referenceBlock', 'place');
  assert.match(between(actions, 'export function findBedSites(', 'const solid'), /isClearableCover\(b\)/,
    'a flowery room still offers bed sites');
});


await check('Doors: a shelter door faces through its doorway; a wrong-way one is no door, and build resets it', async () => {
  // 2026-10-30: Babs' door at (-221, 64, -92) faced west in a south wall. Opening it swung it across
  // the way in, so every bed placement in the room timed out on the path there.
  const s = shelterFns();
  const door = (facing) => ({ name: 'birch_door', getProperties: () => ({ half: 'lower', facing }) });
  const h = vm.createContext({});
  vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
    between(actions, 'export function isShelterDoor(', 'export function shelterPositions('), h);
  assert.equal(h.isShelterDoor(door('south')), true);
  assert.equal(h.isShelterDoor(door('north')), true);
  assert.equal(h.isShelterDoor(door('west')), false, 'Babs\' door');
  assert.equal(h.isShelterDoor(door('east')), false);

  // The complete-shelter search no longer counts a shelter whose door is set the wrong way round.
  const base = new V3(0, 65, 0), doorPos = s.doorwayPosition(base);
  const solid = new Set(s.shelterPositions(base).map((p) => `${p.x},${p.y},${p.z}`));
  const complete = (facing) => {
    const blockAt = (p) => (p.equals(doorPos) ? { ...door(facing), boundingBox: 'empty' }
      : { name: 'x', boundingBox: p.y <= 64 || solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' });
    const bot = { spawnPoint: new V3(0, 64, 0), isABed: () => false, blockAt,
      findBlocks: ({ matching }) => (matching(blockAt(doorPos)) ? [doorPos] : []) };
    const c = vm.createContext({ bot, Math, shelterPositions: s.shelterPositions, doorwayPosition: s.doorwayPosition,
      SHELTER_ROOM: vm.runInContext('SHELTER_ROOM', s), BUILDER_PRIORITY_RADIUS: 24 });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
      between(actions, 'export function isShelterDoor(', 'export function shelterPositions(') +
      between(index, 'const shelterGeometryPositions', 'const BUILDER_ITEM_STALL_LIMIT'), c);
    return { complete: c.hasShelterNearHome(), unfinished: c.unfinishedShelterNearHome() };
  };
  assert.equal(complete('south').complete, true, 'door facing out: complete');
  const west = complete('west');
  assert.equal(west.complete, false, 'door facing west: not complete');
  assert.equal(JSON.stringify(west.unfinished), JSON.stringify(base), 'so the shelter goal hands it to "build"');

  // "build" takes a wrong-way door out before anything else, and places without placeBlock's own look.
  const build = between(actions, '    case "build": {', '\n    case "');
  assert.match(build, /let doorAlready = isShelterDoor\(bot\.blockAt\(doorPos\)\)/);
  assert(build.indexOf('await bot.dig(bot.blockAt(doorPos))') >= 0 &&
    build.indexOf('await bot.dig(bot.blockAt(doorPos))') < build.indexOf('type: "craft", item: doorItemFor(bot)'),
    'the wrong-way door comes out before a new one would be crafted');
  for (const name of ['build', 'build_communal_shelter']) {
    const src = between(actions, `    case "${name}": {`, '\n    case "');
    assert.match(src, /bot\._placeBlockWithOptions\(floorBelow, new Vec3\(0, 1, 0\), \{ swingArm: "right", forceLook: "ignore" \}\)/,
      `${name}: the door keeps the look set just before it`);
    assert.match(src, /bot\.lookAt\(bot\.entity\.position\.offset\(0, bot\.entity\.height, 5\), true\);\s*(\/\/.*\n\s*)*await bot\.waitForTicks\(2\);/,
      `${name}: +z of her, and the look sent before the door goes down`);
    assert(!/bot\.placeBlock\(floorBelow/.test(src), `${name}: never placeBlock for the door`);
  }
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
