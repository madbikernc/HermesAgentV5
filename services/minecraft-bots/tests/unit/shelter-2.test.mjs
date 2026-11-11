// Version: 1.0.0
//
// Unit checks: shelter detection, building and repair (part 2 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/shelter-2.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, swim, V3, between, actionFn, timeoutFn, makeBot, context, shelter, check, blockWorld, shelterLivingSpace, smallRoom, room, tunnel, slice, passedCount } from './_harness.mjs';


await check('Shelter upgrade: dirt and wood cells are dug out and refilled with stone, one at a time', async () => {
  // Direct request, 2026-10-28: "gradually replace the earth shelter with stone".
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const world = new Map([[key(new V3(0, 65, 0)), 'dirt'], [key(new V3(1, 65, 0)), 'cobblestone'], [key(new V3(2, 65, 0)), 'oak_planks'],
    [key(new V3(0, 64, 0)), 'dirt'], [key(new V3(2, 64, 0)), 'dirt']]);
  const inv = [{ name: 'cobblestone', count: 5 }];
  const log = [];
  const bot = makeBot();
  Object.assign(bot, {
    entity: { position: new V3(5, 64, 5) },
    inventory: { items: () => inv.filter((i) => i.count > 0), slots: [] },
    blockAt: (p) => { const name = world.get(key(p)) ?? 'air'; return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }; },
    dig: async (b) => { log.push(`dig ${b.name} ${key(b.position)}`); world.delete(key(b.position)); },
    equip: async () => {},
    placeBlock: async (ref, face) => { const p = ref.position.offset(face.x, face.y, face.z); log.push(`place ${key(p)}`); world.set(key(p), 'cobblestone'); inv[0].count--; },
  });
  bot.pathfinder.goto = async () => {};
  bot.pathfinder.setMovements = function (m) { this.movements = m; };
  const c = context(bot, { Vec3: V3, refreshGear: async () => {} });
  vm.runInContext(timeoutFn + actionFn + between(actions, 'const SHELTER_MATERIAL', 'export function communalShelterMaterialCount('), c);
  const result = await c.performAction(bot, { type: 'reface_shelter', cells: [new V3(0, 65, 0), new V3(1, 65, 0), new V3(2, 65, 0)] }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.equal(result.refaced, 2);
  assert.deepEqual(log, ['dig dirt 0,65,0', 'place 0,65,0', 'dig oak_planks 2,65,0', 'place 2,65,0'],
    'each dug cell is refilled before the next is touched; stone is left alone');
});


await check('Access: a falling block is judged where it lands, not where it leaves her hand', async () => {
  const c = shelter();
  const w = blockWorld();
  w.place([20, 64, 0], 'chest');
  assert.equal(c.wouldBlockAccess(w.bot, new V3(20, 68, 0), 'cobblestone'), null, 'cobblestone stays where it is put');
  const fell = c.wouldBlockAccess(w.bot, new V3(20, 68, 0), 'sand');
  assert(fell && fell.fixture === 'chest', `sand four blocks up lands on the lid: ${JSON.stringify(fell)}`);
  assert.deepEqual([fell.falls.x, fell.falls.y, fell.falls.z], [20, 65, 0], 'and it says where');
  assert.equal(c.isFallingBlockName('red_concrete_powder'), true);
  assert.equal(c.isFallingBlockName('cobblestone'), false);
});


await check('Shelter walls: a hole in a wall is a second way out, so it can be filled back in', async () => {
  const { c, w, base } = shelterLivingSpace();
  w.open([base.x - 1, base.y, base.z]); // knock a hole in the west wall at floor level
  const holed = c.refreshLivingSpace(w.bot, base);
  assert.deepEqual([...holed.exits.keys()].sort(), ['-1,0', '0,3'], 'the hole counts as a way out too');
  assert.equal(c.wouldBlockAccess(w.bot, base.offset(-1, 0, 0)), null, 'so repairing it is allowed');
  assert.equal(c.wouldBlockAccess(w.bot, base.offset(0, 0, 3)), null, 'and the doorway is no longer the only one');

  // Hang a door in the doorway (now local z=3, the room having grown to 2x3) and cap the cell
  // above it (the shelter's doorway column is three high, a door only two). The fill stops at the
  // door, but the door still counts as the way out -- otherwise the first hole knocked in a wall
  // would look like the only exit and be protected from repair, exactly backwards.
  const d = shelterLivingSpace();
  d.w.door([d.base.x, d.base.y, d.base.z + 3]);
  d.w.place([d.base.x, d.base.y + 2, d.base.z + 3], 'cobblestone');
  const shut = d.c.refreshLivingSpace(d.w.bot, d.base);
  assert.deepEqual([...shut.exits.keys()], ['0,2'], 'the cell inside the door is the way out');
  const onlyWay = d.c.wouldBlockAccess(d.w.bot, d.base.offset(0, 1, 2));
  assert(onlyWay && /_door$/.test(onlyWay.fixture), `walling the door off from inside: ${JSON.stringify(onlyWay)}`);
  d.w.open([d.base.x - 1, d.base.y, d.base.z]);
  d.c.refreshLivingSpace(d.w.bot, d.base);
  assert.equal(d.c.wouldBlockAccess(d.w.bot, d.base.offset(-1, 0, 0)), null, 'with a hole too, the hole can be repaired');
});


await check('Shelter walls: pathfinder refuses to dig one, and still digs ordinary terrain', async () => {
  const { w, base } = shelterLivingSpace();
  const c = vm.createContext({ Movements: class { safeToBreak() { return true; } }, Move: class {},
    nbt: { simplify: () => ({}) }, Vec3: V3, isWater: () => false, applyDoorState: (b) => b,
    isLivingSpaceWall: shelter().isLivingSpaceWall });
  vm.runInContext(between(swim, 'const MAX_DIG_LABOR_COST'), c);
  const movements = new (vm.runInContext('SwimMovements', c))();
  movements.bot = w.bot;
  assert.equal(movements.safeToBreak(w.bot.blockAt(base.offset(-1, 1, 0))), false, 'a wall of the shelter');
  assert.equal(movements.safeToBreak(w.bot.blockAt(base.offset(0, 3, 0))), false, 'its roof');
  assert.equal(movements.safeToBreak(w.bot.blockAt(base.offset(20, -1, 20))), true, 'stone out in the open');
  assert.equal(movements.safeToBreak({ name: 'stone' }), true, "a block with no position (the library's own null stub)");
});


await check('Shelter detection: a sand wall disqualifies an otherwise-sealed room; glass does not', async () => {
  const c = shelter();
  assert.equal(c.isSandWallName('sand'), true);
  assert.equal(c.isSandWallName('red_sand'), true);
  assert.equal(c.isSandWallName('gravel'), false, "the user's ask was sand specifically, not gravel");
  assert.equal(c.isSandWallName('glass'), false, 'walls may be any material, including glass');

  const sandy = smallRoom({ wallName: 'sand' });
  const glassy = smallRoom({ wallName: 'glass' });
  const doorsNear = (w) => c.shelterInteriorsNear(w.bot, new V3(0, 64, 1), 8);
  assert.equal(doorsNear(sandy).size, 0, 'sealed, but a sand wall is not an acceptable shelter wall');
  assert(doorsNear(glassy).size > 0, 'glass is an acceptable wall');
});


await check('Shelter rooms (general): a sealed room is recognized with zero holes, even when it is too narrow for hole-finding itself', async () => {
  // smallRoom() is 1x1 interior -- exactly the shape holesIn()'s own header explains cannot be
  // told apart from a hole by neighbour count alone (every real floor-level cell there has 4 of
  // 6 neighbours solid, the same count a genuine breach would). Found live, offline, while
  // writing this test: the first version of holesIn() false-positived THIS room's own floor
  // cell as a hole. MIN_SHELTER_ROOM_SPAN now deliberately leaves a room this narrow to
  // findShelterNearHome() (index.js), which has a real reference geometry and needs no
  // heuristic -- so recognition still succeeds here, holes is just never attempted on it.
  const c = shelter();
  const w = smallRoom();
  const intact = c.shelterRoomsNear(w.bot, new V3(0, 64, 1), 8);
  assert.equal(intact.length, 1, 'exactly one room found');
  assert.equal(intact[0].holes.size, 0, 'too narrow for hole-finding to even attempt -- not a false claim of damage');
  assert(intact[0].inside.has('0,64,0'), 'the room interior is in it');

  // Confirmed deliberately bare: even with the same real gap the strict enclosedInterior test
  // above shows breaks "sealed" entirely, a room this narrow still reports zero holes -- the
  // point of the test above is exactly that this must never become a false positive.
  w.open([-1, 65, 0]);
  const damaged = c.shelterRoomsNear(w.bot, new V3(0, 64, 1), 8);
  assert.equal(damaged.length, 1, 'still recognized as one room -- real damage does not erase it');
  assert.equal(damaged[0].holes.size, 0, 'too narrow for this mechanism -- the individual-shelter repair path owns this one, not a false negative');
});


await check('Shelter rooms (general): any number of separate individual shelters, each kept apart', async () => {
  const c = shelter();
  const w = blockWorld();
  const doorA = room(w, { baseX: 0, baseZ: 0 });
  const doorB = room(w, { baseX: 20, baseZ: 0 }); // far enough apart not to overlap
  const doorC = room(w, { baseX: 40, baseZ: 0 });
  const rooms = c.shelterRoomsNear(w.bot, doorA, 48);
  assert.equal(rooms.length, 3, `three separate shelters, not merged into one or lost: found ${rooms.length}`);
  for (const d of [doorA, doorB, doorC]) {
    // door faces north (step [0,-1]); the room's own interior column sits one block further
    // north again (same x/y, z-1) -- not y-1, which is the solid floor underneath it.
    assert(rooms.some((r) => r.inside.has(`${d.x},${d.y},${d.z - 1}`)), `room at door ${JSON.stringify(d)} is one of them`);
  }
  assert.equal(new Set(rooms.flatMap((r) => [...r.inside])).size,
    [...rooms[0].inside, ...rooms[1].inside, ...rooms[2].inside].length, 'no cell is claimed by two rooms at once');
});


await check('Shelter rooms (general): a larger shelter, a shape neither fixed geometry builds, is recognized and its hole found', async () => {
  const c = shelter();
  const w = blockWorld();
  // A 5x5 interior (bigger than the Builder's own 1x1 smallRoom() and a different shape than
  // communalShelterPositions()' own formula-sized rectangle), walls/roof/floor built directly
  // from blockWorld() primitives -- proving this is shape detection, not a geometry match.
  const size = 5; // interior cells 0..4 on each axis
  for (let dx = -1; dx <= size; dx++) {
    for (let dz = -1; dz <= size; dz++) {
      const edge = dx === -1 || dx === size || dz === -1 || dz === size;
      w.place([dx, 63, dz], 'stone_bricks'); // floor under every cell, including the walls' own footing
      w.place([dx, 68, dz], 'stone_bricks'); // roof, one layer above the 4-tall interior (64..67)
      if (!edge) continue; // interior stays open
      for (let dy = 64; dy <= 67; dy++) {
        if (dx === -1 && dz === 0 && dy <= 65) continue; // doorway on the west wall, two cells tall
        w.place([dx, dy, dz], 'stone_bricks');
      }
    }
  }
  w.door([-1, 64, 0], 'oak_door', 'west');
  const found = c.shelterRoomsNear(w.bot, new V3(-1, 64, 0), 12);
  assert.equal(found.length, 1, 'one large room found');
  assert.equal(found[0].holes.size, 0, 'intact -- no holes yet');
  assert(found[0].inside.has('2,65,2'), 'the far interior corner is really reached, not just the cell by the door');

  w.open([2, 65, size]); // a real gap in the far (east) wall
  const damaged = c.shelterRoomsNear(w.bot, new V3(-1, 64, 0), 12);
  assert.equal(damaged.length, 1, 'still one room, now damaged');
  assert(damaged[0].holes.has(`2,65,${size}`), `the hole in the far wall of a 5x5 room is found: ${[...damaged[0].holes]}`);
});


await check('Access: "clear_access" digs what is in the way and reports which fixture it freed', async () => {
  const w = blockWorld();
  w.place([0, 64, 0], 'chest');
  w.place([0, 65, 0], 'cobblestone');
  w.bot.entity = { position: new V3(2, 64, 0) };
  w.bot.pathfinder = { goto: async () => {}, setGoal() {}, movements: {} };
  const dug = [];
  w.bot.collectBlock = { collect: async (block) => { dug.push(block.name); w.open([0, 65, 0]); }, cancelTask() {} };
  w.bot.stopDigging = () => {};
  const c = context(w.bot, { Vec3: V3, isProtectedBlockName: (n) => /chest|furnace/.test(n) });
  vm.runInContext(timeoutFn + actionFn, c);
  const result = await c.performAction(w.bot, { type: 'clear_access' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(dug, ['cobblestone'], 'the obstruction, never the chest');
  assert.match(result.text, /chest/, result.text);
  const again = await c.performAction(w.bot, { type: 'clear_access' }, 'test');
  assert.equal(again.ok, true, again.text);
  assert.match(again.text, /nothing's blocking/, again.text);
  assert.deepEqual(dug, ['cobblestone'], 'and it does not go looking for more work');
});


await check('Shelter walls: "mine" skips a target inside one, and says so when that is all there is', async () => {
  const walls = new Set(['0,64,0', '0,64,1']);
  const bot = makeBot();
  bot.entity = { position: new V3(5, 64, 5) };
  bot.registry = { blocks: { 1: { name: 'cobblestone' } } };
  bot.blockAt = (p) => ({ name: 'cobblestone', position: p, harvestTools: null });
  let positions = [new V3(0, 64, 0), new V3(0, 64, 1), new V3(8, 64, 8)];
  bot.findBlocks = () => positions;
  const collected = [];
  bot.collectBlock = { collect: async (blocks) => collected.push(...blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`)), cancelTask() {} };
  const c = context(bot, { Vec3: V3, resolveBlockFamily: () => [1], itemNamesForMinedBlocks: () => ['cobblestone'],
    tryTakeFromNearbyChest: async () => null, visitRememberedSpot: async () => [],
    wanderAndRetryFind: async () => [], filterAwayFromOtherBots: (b, p) => p,
    isProtectedBlockName: () => false, MINE_SEARCH_RADIUS: 32, CONTENTION_SEARCH_OVERFETCH: 3,
    isLivingSpaceWall: (b, pos) => walls.has(`${pos.x},${pos.y},${pos.z}`) });
  vm.runInContext(timeoutFn + actionFn, c);
  const result = await c.performAction(bot, { type: 'mine', block: 'cobblestone', count: 3 }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(collected, ['8,64,8'], 'only the cobblestone that is not a shelter wall');

  positions = [new V3(0, 64, 0), new V3(0, 64, 1)];
  const nothing = await c.performAction(bot, { type: 'mine', block: 'cobblestone', count: 3 }, 'test');
  assert.equal(nothing.ok, false);
  assert.match(nothing.text, /part of a shelter wall/, nothing.text);
});


await check('Access: the other four placement sites ask first, each in the way that suits it', async () => {
  const slice = (from, to) => actions.slice(actions.indexOf(from), actions.indexOf(to));
  const build = slice('case "build": {', 'case "build_pen": {');
  assert.match(build, /const shuts = wouldBlockAccess\(bot, pos\);/, 'build checks every wall cell');
  assert.match(build, /shutIn\+\+;[\s\S]{0,200}continue;/, 'and leaves it open rather than abandoning the shelter');
  assert.match(build, /left open so a neighbouring fixture stays reachable/, 'the result says why it is short');

  const pen = slice('case "build_pen": {', 'case "herd_to_pen": {');
  assert.match(pen, /wouldBlockAccess\(bot, pos, item\.name\)/, 'build_pen checks, with the fence/gate it would place');

  const repair = slice('case "repair_terrain": {', 'case "store": {');
  assert.match(repair, /wouldBlockAccess\(bot, pos, materialName\)/);
  assert.match(repair, /if \(shuts\) \{[\s\S]{0,300}?\n\s+break;\n\s+\}/,
    'a pit fill stops at the fixture, it does not skip a layer and keep going');

  const bed = slice('case "place_bed": {', 'case "shear": {');
  assert.match(bed, /!wouldBlockAccess\(bot, c\.foot\) && !wouldBlockAccess\(bot, c\.head\)/, 'both halves of the bed');
});


await check('Torches: a trail torch goes down every 6 blocks of covered tunnel, on the floor before a wall', async () => {
  const c = tunnel();
  assert.equal(vm.runInContext('TORCH_SPACING', c), 6, '14 - 6 = 8, exactly DARK_LIGHT_LEVEL at the midpoint');
  const w = blockWorld({ groundY: 40, light: 15 });
  for (let dz = -8; dz <= 8; dz++) w.place([0, 43, dz], 'deepslate'); // the tunnel roof
  w.bot.entity = { position: new V3(0.5, 41, 0.5) };
  w.bot.inventory.items = () => [{ name: 'torch', count: 4 }];
  const first = c.trailTorchSpot(w.bot, null);
  assert(!first.skip, JSON.stringify(first));
  assert.deepEqual([first.reference.position.y, first.face.y], [40, 1], 'placed on the floor, facing up');

  assert.match(c.trailTorchSpot(w.bot, new V3(0, 41, -3)).skip, /still close/, 'three blocks back is not far enough');
  assert(!c.trailTorchSpot(w.bot, new V3(0, 41, -6)).skip, 'six blocks back is');

  w.place([3, 41, 0], 'lantern'); // something already lighting this stretch
  assert.match(c.trailTorchSpot(w.bot, null).skip, /already lit/, 'a lit stretch costs nothing');

  const open = blockWorld({ groundY: 40 }); // no roof at all: she is out on the surface
  open.bot.entity = w.bot.entity; open.bot.inventory.items = w.bot.inventory.items;
  assert.match(c.trailTorchSpot(open.bot, null).skip, /out in the open/, 'no torches dropped across a field');

  const empty = blockWorld({ groundY: 40 });
  empty.place([0, 43, 0], 'deepslate');
  empty.bot.entity = w.bot.entity; empty.bot.inventory.items = () => [];
  assert.match(c.trailTorchSpot(empty.bot, null).skip, /no torches/);
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
