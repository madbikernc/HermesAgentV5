// Version: 1.2.0
//
// 1.2.0 (2026-11-11): a complete shelter is not an unfinished shell, and a "build" that says it stands
// only passes shelterStep's guard when that goal's own site checks out as complete.
// 1.1.0 (2026-11-10): slices read the split modules (actions/*.js via actionCases/actionHandlerSrc, the modules out of index.js via index/indexOnly), and sandboxes stub guardedInterval.
//
// Unit checks: doors and doorways (part 1 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/doors-1.test.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { prioritiesSrc, indexOnly, homeScanSrc, actionCases, actions, index, swim, V3, between, actionFn, timeoutFn, makeBot, context, shelter, passed, check, doorBlock, doorFns, closerWorld, farmGoalSrc, closedIron, shelterFns, room, slice, passedCount } from './_harness.mjs';


await check('Doors: an open door or gate is walkable, never a floor', async () => {
  const { applyDoorState } = doorFns();
  for (const half of ['lower', 'upper']) {
    const b = applyDoorState(doorBlock('oak_door', { half, open: true }));
    assert.equal(b.safe, true, `open door ${half}`); assert.equal(b.physical, false); assert.equal(b.openable, false);
  }
  const iron = applyDoorState(doorBlock('iron_door', { half: 'lower', open: true }));
  assert.equal(iron.safe, true, 'an iron door held open by redstone is walkable too');
  const gate = applyDoorState(doorBlock('oak_fence_gate', { open: true }));
  assert.equal(gate.safe, true); assert.equal(gate.openable, false);
});


await check('Doors: a closed wooden door or gate is routed through (never pathfinder\'s "use" step); a closed iron door is a wall', async () => {
  const { applyDoorState } = doorFns();
  const lower = applyDoorState(doorBlock('spruce_door', { half: 'lower', open: false }));
  assert.equal(lower.openable, false, 'the use step crashes the executor'); assert.equal(lower.safe, true); assert.equal(lower.physical, false);
  const upper = applyDoorState(doorBlock('spruce_door', { half: 'upper', open: false }));
  assert.equal(upper.safe, true); assert.equal(upper.openable, false);
  const gate = applyDoorState(doorBlock('birch_fence_gate', { open: false }));
  assert.equal(gate.openable, false); assert.equal(gate.safe, true);
  const iron = applyDoorState(doorBlock('iron_door', { half: 'lower', open: false }));
  assert.equal(iron.openable, false); assert.equal(iron.safe, false);
  const ironTop = applyDoorState(doorBlock('iron_door', { half: 'upper', open: false }));
  assert.equal(ironTop.safe, false);
  const stone = { name: 'stone', safe: false, physical: true, openable: false };
  assert.deepEqual({ ...applyDoorState(stone) }, { name: 'stone', safe: false, physical: true, openable: false });
});


await check('Doors: a doorway waypoint lifted onto the door, or left on its corner, goes back to the floor centre', async () => {
  // The door's lower half is at (5, 64, 7). postProcessPath put one route's waypoint on top of it
  // (5.703, 65, 7.5); a closed door's "use" step left another at the raw corner (5, 64, 7).
  const door = { name: 'oak_door', position: { y: 64 }, getProperties: () => ({ half: 'lower', open: true }) };
  const at = (x, y, z) => (x === 5 && y === 64 && z === 7 ? door : { name: 'air', getProperties: () => ({}) });
  class V { constructor(x, y, z) { Object.assign(this, { x, y, z }); } }
  const c = vm.createContext({ Vec3: V });
  vm.runInContext(between(swim, 'function isDoorway(', 'export function isOpenDoorOrGate(') + between(swim, 'function fixDoorWaypoints(', 'function installDoorSupport('), c);
  const fakeBot = { blockAt: (p) => at(p.x, p.y, p.z) };
  const path = [{ x: 5.5, y: 64, z: 6.5 }, { x: 5.703125, y: 65, z: 7.5 }, { x: 5, y: 64, z: 7 }, { x: 5.5, y: 64, z: 8.5 }];
  c.fixDoorWaypoints(fakeBot, path);
  assert.deepEqual(path.map((p) => [p.x, p.y, p.z]), [[5.5, 64, 6.5], [5.5, 64, 7.5], [5.5, 64, 7.5], [5.5, 64, 8.5]]);
});


await check('Close behind: a door she walked through is shut once she is clear, without turning her head', async () => {
  const w = closerWorld();
  await w.walk(-1, 0.5, 1.0); // through the doorway, still beside it
  assert.equal(w.used.length, 0, 'not while she is still in or next to it');
  await w.walk(2.0, 2.5, 3.0);
  assert.equal(w.used.length, 1, 'closed exactly once'); assert.equal(w.props.open, false);
  assert.equal(w.used[0].looked, 0, 'no lookAt before the click');
  assert.equal(w.looks(), 0, "the bot's own lookAt was stubbed for the click and restored");
  const gate = closerWorld({ name: 'oak_fence_gate' });
  await gate.walk(0.5, 2.5);
  assert.equal(gate.used.length, 1, 'gates too');
});


await check("Close behind: not on someone following, not while herding, not an iron or already-shut door", async () => {
  const w = closerWorld();
  w.bot.entities[2] = { type: 'player', position: new V3(0.5, 64, -1) }; // a bot right behind her
  await w.walk(0.5, 2.5);
  assert.equal(w.used.length, 0, 'held for the follower');
  w.bot.entities[2].position = new V3(0.5, 64, 2.6); // the follower is through too
  w.bot.entities[2].position.distanceTo = (o) => Math.hypot(0.5 - o.x, 64 - o.y, 2.6 - o.z) + 3; // and clear of it
  await w.walk(2.6);
  assert.equal(w.used.length, 1, 'shut once nobody is at it');

  const herd = closerWorld({ name: 'oak_fence_gate' });
  const release = herd.c.holdDoorsOpen(herd.bot);
  await herd.walk(0.5, 2.5);
  release(); await herd.walk(2.6);
  assert.equal(herd.used.length, 0, 'a doorway passed while herding is forgotten, not shut later');

  const iron = closerWorld({ name: 'iron_door' });
  await iron.walk(0.5, 2.5);
  const shut = closerWorld({ open: false });
  await shut.walk(0.5, 2.5);
  assert.equal(iron.used.length + shut.used.length, 0);
});


await check('Close behind: herd_to_pen holds doors open only while leading, with the food out only then', async () => {
  const bot = makeBot(); let held = 0;
  const c = context(bot, { loadPenLocation: async () => null, holdDoorsOpen: () => { held++; return () => {}; } });
  vm.runInContext(timeoutFn + actionFn, c);
  await c.performAction(bot, { type: 'herd_to_pen', species: 'cow' }, 'test');
  assert.equal(held, 0, 'no hold when there is nothing to lead');
  const herd = actionCases.slice(actionCases.indexOf('case "herd_to_pen": {'), actionCases.indexOf('case "repair_terrain": {'));
  const [approach, hold, equip, backWall] = ['GoalNear(animal.position.x', 'holdDoorsOpen(bot)', 'bot.equip(foodItem', 'pen.center.z - 2']
    .map((t) => herd.indexOf(t));
  assert(approach > 0 && approach < hold && hold < equip && equip < backWall, 'walk out empty-handed, then hold + food, then lead to the back wall');
  assert.match(herd, /} finally \{\s+releaseDoors\(\);\s+await refreshGear\(bot\);/, 'released and the food put away on every exit');
});


await check('Ranch goals: fences and gate crafted from the wood she has, pen built on a site, pair penned, bred', async () => {
  const inv = [{ name: 'birch_planks', count: 64 }];
  let pen = null; const cows = [];
  const calls = [];
  const performAction = async (b, action) => {
    calls.push(action.type + (action.item ? `:${action.item}` : '') + (action.species ? `:${action.species}` : ''));
    if (action.type === 'craft') { inv.push({ name: action.item, count: action.item.endsWith('_gate') ? 1 : 23 }); return { ok: true, text: 'crafted' }; }
    if (action.type === 'build_pen') { pen = { center: new V3(20, 64, 20), gate: new V3(20, 64, 22) }; return { ok: true, text: 'built a pen' }; }
    if (action.type === 'loot') { inv.push({ name: action.item, count: 8 }); return { ok: true, text: 'found wheat' }; }
    if (action.type === 'herd_to_pen') { cows.push(1); return { ok: true, text: 'herded a cow into the pen.' }; }
    if (action.type === 'breed') return { ok: true, text: 'bred a baby cow.', bred: 'cow' };
    return { ok: false, text: '?' };
  };
  const done = [];
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Amy', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, spawnPoint: new V3(0, 64, 0), inventory: { items: () => inv }, registry: { blocksByName: {} }, findBlocks: () => [],
      entities: { 1: { name: 'cow', position: new V3(30, 64, 30) }, 2: { name: 'cow', position: new V3(31, 64, 30) } } },
    Vec3: V3, performAction, farmStatus: () => ({ ripe: 0, growing: 0 }), narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async (status) => { done.push(status); }, retireGoal: async () => {}, saveGoalIfCurrent: async () => {},
    logStep: () => {}, loadPenLocation: async () => pen, LIVESTOCK: ['cow', 'sheep'], BREEDING_FOOD: { cow: ['wheat'], sheep: ['wheat'] },
    countInPen: () => cows.length, findPenSite: () => new V3(20, 64, 20) });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { description: 'set up a ranch', createdAt: Date.now(), consecutiveFailures: 0 };
  for (let i = 0; i < 8 && !done.length; i++) await c.runRanchGoal(goal, async () => true, () => ({ release() {} }), () => false);
  assert.deepEqual(calls, ['craft:birch_fence', 'craft:birch_fence_gate', 'build_pen', 'loot:wheat',
    'herd_to_pen:cow', 'herd_to_pen:cow', 'breed:cow']);
  assert.deepEqual(done, ['done']); assert.equal(goal.ranchSpecies, 'cow');
});


await check('Doors: a closed gate lifted onto its top is put back on the floor too', async () => {
  const gate = { name: 'oak_fence_gate', position: { y: 64 }, getProperties: () => ({ open: false }) };
  const c = vm.createContext({ Vec3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } } });
  vm.runInContext(between(swim, 'function isDoorway(', 'export function isOpenDoorOrGate(') + between(swim, 'function fixDoorWaypoints(', 'function installDoorSupport('), c);
  const path = [{ x: 3.5, y: 65.5, z: 7.5 }];
  c.fixDoorWaypoints({ blockAt: (p) => (p.x === 3 && p.y === 64 && p.z === 7 ? gate : { name: 'air', getProperties: () => ({}) }) }, path);
  assert.deepEqual([path[0].x, path[0].y, path[0].z], [3.5, 64, 7.5]);
});


await check('Doors: a closed door on her route is opened just ahead of her, without a head turn, not twice at once', async () => {
  const props = { half: 'lower', open: false };
  const door = { name: 'oak_door', position: new V3(0, 64, 2), getProperties: () => props };
  const bot = new EventEmitter();
  let looks = 0, moving = true; const used = [];
  Object.assign(bot, { username: 'Amy', entity: { position: new V3(0.5, 64, 0.5) }, lookAt: async () => { looks++; },
    pathfinder: { isMoving: () => moving },
    blockAt: (p) => (p.x === 0 && p.y === 64 && p.z === 2 ? door : { name: 'air', getProperties: () => ({}) }) });
  const activate = (b) => { bot.lookAt(); used.push(b.name); return new Promise(() => {}); }; // never settles: one at a time
  const c = vm.createContext({ Vec3: V3, Promise, Date, console: { log() {}, error() {} } });
  vm.runInContext(between(swim, 'function isDoorway(', 'export function isOpenDoorOrGate(') +
    between(swim, 'function useWithoutLooking(', 'export function installDoorCloser(') +
    between(swim, 'const DOOR_OPEN_REACH', 'const DOOR_CLOSE_MIN'), c);
  const route = { path: [{ x: 0.5, y: 64, z: 1.5 }, { x: 0.5, y: 64, z: 2.5 }, { x: 0.5, y: 64, z: 3.5 }] };
  c.installDoorOpener(bot, activate, route);
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.deepEqual(used, ['oak_door'], 'opened once, not again while the first click is pending');
  assert.equal(looks, 0, "her head didn't turn");
  moving = false;
  const idle = { ...c }; void idle;
  const iron = closedIron(c);
  assert.equal(iron, false, 'an iron door is never clicked');
});


await check('Communal shelter: stone-or-better material, parameterized geometry, a door-first build', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a -- "every block used must be at least
  // stone tier... though the materials don't all have to match each other").
  const c = shelterFns();
  for (const n of ['stone', 'cobblestone', 'mossy_cobblestone', 'deepslate', 'stone_bricks', 'andesite', 'iron_block', 'bricks', 'white_concrete']) {
    assert.equal(c.isCommunalShelterMaterial(n), true, n);
  }
  for (const n of ['dirt', 'sand', 'oak_planks', 'oak_log', 'gravel', 'iron_ore', 'netherrack', 'glass']) {
    assert.equal(c.isCommunalShelterMaterial(n), false, n);
  }
  const bot = { inventory: { items: () => [{ name: 'stone', count: 40 }, { name: 'oak_planks', count: 20 }, { name: 'cobblestone', count: 10 }] } };
  assert.equal(c.communalShelterMaterialCount(bot), 50, 'stone and cobblestone count; planks (wood) do not');

  // 5x5 interior: dx -1..5 (7) x dz -1..5 (7) = 49 pairs, minus the 5x5=25 room pairs = 24 wall
  // columns; 23 full (x3 = 69) + the doorway column's lintel only (1) = 70 walls, + a 7x7 roof
  // (49) + a 5x5 floor (25) = 144.
  const base = new V3(0, 64, 0);
  assert.equal(c.communalShelterPositions(base, 5, 5).length, 144,
    '23 full wall columns x 3, + the doorway column\'s lintel, + a 7x7 roof, + a 5x5 floor');
  const doorPos = c.communalDoorwayPosition(base, 5);
  assert.deepEqual({ x: doorPos.x, y: doorPos.y, z: doorPos.z }, { x: 0, y: 64, z: 5 });
  assert.deepEqual([...c.communalRoomCells(2, 1)].map((p) => [...p]), [[0, 0], [1, 0]]);

  const communalBuild = actionCases.slice(actionCases.indexOf('case "build_communal_shelter": {'), actionCases.indexOf('case "build_pen": {'));
  assert.match(communalBuild, /isCommunalShelterMaterial/, 'uses the stricter material check, not the individual-shelter baseline');
  assert.match(communalBuild, /if \(!width \|\| !depth\) return fail/, 'refuses to guess a size if none was given');
  // Same door-first-craft/door-last-placement order as "build" -- see that case's own header for
  // the two real bugs (plank starvation, wrong door facing) this order exists to avoid repeating.
  const doorCraftIdx = communalBuild.indexOf('type: "craft", item: doorItemFor(bot)');
  const wallLoopIdx = communalBuild.indexOf('for (const pos of buildOrder)');
  const doorPlaceIdx = communalBuild.indexOf('await bot._placeBlockWithOptions(floorBelow');
  assert(doorCraftIdx > 0 && doorCraftIdx < wallLoopIdx && wallLoopIdx < doorPlaceIdx,
    'door item crafted before the wall loop, door itself placed after it');
});


await check('Shelter patch: takes an explicit hole list, never a door, never its own geometry', async () => {
  // Direct request, 2026-10-22, generalizing S42: "patch_shelter" exists specifically so a
  // shelter's REAL, already-found holes (shelterRoomsNear()/holesIn(), shelter.js) get filled
  // exactly as found -- never recomputed from a predetermined shape the way "build"/
  // "build_communal_shelter" above do, which is what lets it work on a shelter of any size or
  // shape. holesIn() already excludes every doorway cell from its own output, so there is
  // structurally never a door to craft or place here.
  const patchBody = actionCases.slice(actionCases.indexOf('case "patch_shelter": {'), actionCases.indexOf('case "build_communal_shelter": {'));
  assert(patchBody.length > 0, 'the case exists');
  assert(!/doorItemFor|doorPlaced|doorAlready/.test(patchBody), 'never touches a door -- holesIn() already excludes doorway cells');
  assert.match(patchBody, /action\.holes \|\| \[\]/, 'takes an explicit hole list from the caller');
  assert(!/buildOrder|shelterPositions|communalShelterPositions/.test(patchBody), 'never computes its own geometry');
  assert.match(patchBody, /isShelterMaterial/, 'uses the same permissive material check "build" does');
});


await check('Shelters: a doorless shell near home is found again, not abandoned for a new site', async () => {
  // 2026-10-28 (direct report: "there are no doors or beds, but she built two"): a shell with no
  // door is invisible to the door-anchored complete-shelter search, so each new shelter goal
  // built another one.
  const s = shelterFns();
  const shellBot = (cells, solidExtra = []) => {
    const solid = new Set([...cells, ...solidExtra].map((p) => `${p.x},${p.y},${p.z}`));
    return { spawnPoint: new V3(0, 64, 0), isABed: () => false, findBlocks: () => [],
      blockAt: (p) => ({ name: 'x', boundingBox: p.y <= 64 || solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' }) };
  };
  const find = (bot) => {
    const h = vm.createContext({ bot, Math, shelterPositions: s.shelterPositions, doorwayPosition: s.doorwayPosition,
      SHELTER_ROOM: vm.runInContext('SHELTER_ROOM', s), BUILDER_PRIORITY_RADIUS: 24 });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') + between(actions, 'export function isShelterDoor(', 'export function shelterPositions(') +
      (between(homeScanSrc, 'const shelterGeometryPositions') + between(prioritiesSrc, 'const TOOL_NAME', 'const BUILDER_ITEM_STALL_LIMIT')), h);
    return h.unfinishedShelterNearHome();
  };
  const far = new V3(41, 65, -30), near = new V3(10, 65, 0);
  const farShell = s.shelterPositions(far), nearShell = s.shelterPositions(near);
  assert.equal(find(shellBot([])), null, 'open ground is not a shell');
  assert.equal(JSON.stringify(find(shellBot(farShell))), JSON.stringify(far), 'a doorless shell 41/30 blocks out is found');
  assert.equal(JSON.stringify(find(shellBot([...farShell, ...nearShell]))), JSON.stringify(near), 'the nearest of two shells wins');
  assert.equal(JSON.stringify(find(shellBot(farShell.slice(5)))), JSON.stringify(far), 'a few blocks short still counts -- the build fills them');
  assert.equal(find(shellBot(farShell.slice(20))), null, 'a third of it missing is not a shell');
  const door = s.doorwayPosition(far);
  assert.equal(find(shellBot(farShell, [door, door.offset(0, 1, 0)])), null, 'a solid block where the door goes is a closed box, not her shell');
  // 2026-11-11: the finished residence at (1, 96, 8) came back as an "unfinished" shell every tick.
  const doored = (cells, doorAt, facing) => {
    const b = shellBot(cells);
    const blockAt = b.blockAt;
    b.blockAt = (p) => (p.equals(doorAt) ? { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ half: 'lower', facing }) } : blockAt(p));
    return b;
  };
  assert.equal(find(doored(farShell, door, 'south')), null, 'a complete shelter with its door is finished, not an unfinished shell');
  assert.equal(JSON.stringify(find(doored(farShell, door, 'west'))), JSON.stringify(far), 'a wrong-way door still hands it to "build", which turns it round');
  assert.equal(JSON.stringify(find(doored(farShell.slice(3), door, 'south'))), JSON.stringify(far), 'a doored shell with blocks missing is still unfinished');
});


await check('Shelter goal: a door is secured before the walls, and an unfinished shell is reused', async () => {
  // 2026-10-28: "build" crafted its door first but swallowed the failure -- with no planks Babs
  // put up all 60 wall blocks, then "no door yet" in ~5ms a tick until the goal gave up 40s later.
  const calls = [];
  const c = vm.createContext({ Vec3: V3, USERNAME: 'Babs', SHELTER_SITE_RADIUS: 48, console,
    bot: { spawnPoint: new V3(0, 64, 0), inventory: { items: () => c.held }, blockAt: () => null,
      registry: { blocksByName: { crafting_table: { id: 1 } } }, findBlocks: () => (c.tableNear ? [new V3(0, 64, 0)] : []) },
    held: [], tableNear: false, shell: null, siteCalls: 0, materials: 0,
    isDoorway: () => false, doorwayPosition: (b) => b.offset(0, 0, 3), heldCount: (fn) => c.held.filter((i) => fn(i.name)).reduce((n, i) => n + i.count, 0),
    findShelterNearHome: () => null, unfinishedShelterNearHome: () => c.shell,
    residencePlan: () => ({ kind: 'build', beds: 0, active: 1 }), completeSheltersNearHome: () => [],
    findShelterSite: () => { c.siteCalls++; return new V3(5, 65, 5); },
    shelterPositions: () => Array.from({ length: 60 }, (_, i) => new V3(i, 100, 0)), shelterMaterialCount: () => c.materials,
    gatherPlanks: async (_handle, count) => {
      calls.push({ type: 'gatherPlanks', count });
      return c.held.filter((i) => i.name.endsWith('_planks')).reduce((n, i) => n + i.count, 0) >= count ? null
        : { ok: true, text: 'gathered wood.', action: { type: 'mine', block: 'oak_log' } };
    },
    performAction: async (_bot, action) => { calls.push(action); return { ok: true, text: action.type }; } });
  vm.runInContext(between(index, 'async function shelterStep(', 'async function runShelterGoal('), c);

  let goal = {};
  let step = await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).type, 'gatherPlanks', 'no door and no planks: wood first');
  assert.equal(calls.at(-1).count, 10, '6 planks for the door, 4 for a table since none is around');
  assert.ok(!calls.some((a) => a.type === 'build'), 'and no walls go up yet');
  c.tableNear = true; calls.length = 0;
  await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).count, 6, 'a table nearby: just the door\'s 6');

  // 60 wall blocks needed, 60 materials held, 6 of them the door's planks: still 6 short.
  c.held = [{ name: 'oak_planks', count: 6 }]; c.materials = 60; calls.length = 0;
  await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).type, 'mine', 'the door\'s planks are not counted as wall blocks');
  assert.equal(calls.at(-1).count, 6);
  c.materials = 66; calls.length = 0;
  await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).type, 'build', 'door planks plus a full set of walls: build');

  // 2026-11-11: "already standing" at a site that isn't itself complete is a failure, even while
  // some other complete shelter (the fleet's one residence) stands near home.
  const other = new V3(1, 96, 8);
  c.findShelterNearHome = () => ({ base: other, complete: true });
  c.completeSheltersNearHome = () => [other];
  c.performAction = async (_bot, action) => { calls.push(action); return { ok: true, built: true, text: 'the shelter is already standing.' }; };
  step = await c.shelterStep({ shelterAt: { x: 5, y: 65, z: 5 } }, null);
  assert.equal(step.ok, false, 'another complete shelter near home is no proof this site stands');
  assert.equal(step.built, false);
  c.completeSheltersNearHome = (() => { let n = 0; return () => (n++ === 0 ? [other] : [other, new V3(5, 65, 5)]); })();
  step = await c.shelterStep({ shelterAt: { x: 5, y: 65, z: 5 } }, null);
  assert.equal(step.ok, true, 'once this site itself checks out complete, the build counts');
  c.findShelterNearHome = () => null; c.completeSheltersNearHome = () => [];
  c.performAction = async (_bot, action) => { calls.push(action); return { ok: true, text: action.type }; };

  c.shell = new V3(41, 65, -30); c.siteCalls = 0;
  goal = {};
  await c.shelterStep(goal, null);
  assert.equal(JSON.stringify(goal.shelterAt), JSON.stringify({ x: 41, y: 65, z: -30 }), 'a new shelter goal picks up her unfinished shell');
  assert.equal(c.siteCalls, 0, 'instead of siting a fresh one');

  // 2026-10-29: wall planks from logs asked for every missing block's worth ("craft 60
  // dark_oak_planks" with 2 logs) and failed the craft every tick.
  c.held = [{ name: 'oak_door', count: 1 }, { name: 'dark_oak_log', count: 2 }]; c.materials = 2; calls.length = 0;
  await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).type, 'craft');
  assert.equal(calls.at(-1).count, 8, 'as many planks as two logs make, not all 58 missing');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
