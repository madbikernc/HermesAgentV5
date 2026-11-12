// Version: 1.2.0
//
// 1.2.0 (2026-11-11): far below the goal under rock, stepped goto climbs (swim-movements.js 1.7.0).
// 1.1.0 (2026-11-10): setupPathfinding() (pathfinding.js 1.0.0, out of index.js) installs the
// movement costs, unbreakable blocks, search limits and the dig_error burst guard.
//
// Unit checks: pathfinding, water and swimming.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/pathfinding.test.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { root, actions, index, swim, arbiter, V3, between, sleep, passed, check, doorBlock, doorFns, plotWorld, steppedGotoWorld, passedCount } from './_harness.mjs';


await check('Doors: only an already-open door or gate is skipped by the pathfinding guard', async () => {
  const { isOpenDoorOrGate } = doorFns();
  assert.equal(isOpenDoorOrGate(doorBlock('oak_door', { half: 'lower', open: true })), true);
  assert.equal(isOpenDoorOrGate(doorBlock('oak_door', { half: 'lower', open: false })), false);
  assert.equal(isOpenDoorOrGate(doorBlock('oak_fence_gate', { open: true })), true);
  assert.equal(isOpenDoorOrGate({ name: 'chest', getProperties: () => ({}) }), false);
  const used = []; let moving = true;
  const fakeBot = Object.assign(new EventEmitter(), {
    activateBlock: async (b) => { used.push(b.name); }, pathfinder: { isMoving: () => moving } });
  const c = vm.createContext({ Vec3: class {}, Promise });
  vm.runInContext(between(swim, 'function isOpenDoorOrGate(', 'const MAX_DIG_LABOR_COST'), c);
  c.installDoorSupport(fakeBot);
  await fakeBot.activateBlock(doorBlock('oak_door', { half: 'lower', open: true }));
  await fakeBot.activateBlock(doorBlock('oak_door', { half: 'lower', open: false }));
  moving = false;
  await fakeBot.activateBlock(doorBlock('oak_fence_gate', { open: true })); // herd_to_pen closing its gate
  assert.deepEqual(used, ['oak_door', 'oak_fence_gate']);
});


await check('Farm plots: ground around water, grass cleared first, covered ground skipped; else a tight cluster', async () => {
  const c = vm.createContext({ BREEDING_FOOD: { bee: ['poppy'] }, Vec3: V3 });
  vm.runInContext(between(actions, 'const FARM_PLOT_SIZE', 'export const CROP_MAX_AGE').replace(/export /g, ''), c);
  const blocks = { '10,64,10': 'water' };
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx || dz) blocks[`${10 + dx},64,${10 + dz}`] = 'grass_block';
  blocks['11,65,10'] = 'short_grass'; // clearable
  blocks['9,65,10'] = 'stone';        // covered: not tillable
  const bot = plotWorld(blocks, [new V3(10, 64, 10)]);
  const site = c.chooseFarmPlot(bot, null);
  assert.equal(site.hydrated, true); assert.equal(site.plot.length, 8);
  const keys = site.plot.map((p) => `${p.x},${p.z}`);
  assert(keys.includes('11,10'), 'grass-covered ground is kept (cleared when tilled)');
  assert(!keys.includes('9,10'), 'stone-covered ground is skipped');
  assert(site.plot.every((p) => Math.max(Math.abs(p.x - 10), Math.abs(p.z - 10)) <= 4), 'all within hydration range');
  const dry = { '0,64,0': 'dirt', '1,64,0': 'dirt', '2,64,1': 'dirt', '20,64,20': 'dirt' };
  const drySite = c.chooseFarmPlot(plotWorld(dry, []), new V3(0, 64, 0));
  assert.equal(drySite.hydrated, false);
  assert.deepEqual(drySite.plot.map((p) => p.x).sort((a, b) => a - b), [0, 1, 2], 'the close cluster, not the far block');
});


await check('Water: the drowning reflex reads her own air, and the shore search survives findBlocks\' palette pass', async () => {
  // Direct report, 2026-11-04: "the bots do not seem to be able to get out of water". mineflayer
  // 4.39 sets bot.oxygenLevel from ANY entity's air_supply; and findBlocks first calls the matcher on
  // position-less palette blocks, which findNearestShore rejected -- every section skipped.
  const logs = [];
  const bot = new EventEmitter();
  Object.assign(bot, { oxygenLevel: 4, entity: { isInWater: true, metadata: { 1: 300 } }, setControlState() {} });
  const c = vm.createContext({ bot, console: { log: (l) => logs.push(String(l)), error() {} }, Date, Math, setTimeout, clearTimeout,
    AUTONOMY_ENABLED: true, USERNAME: 'Babs', goals: { GoalNear: class {} },
    arbiter: { OWNERS: { DROWNING: 'drowning' }, requestControl: async () => null, currentOwner: () => 'x' } });
  vm.runInContext(between(index, 'const DROWNING_OXYGEN_THRESHOLD', '// Direct request, 2026-09-07 ("they don\'t seem to be fighting back'), c);
  bot.emit('breath');
  assert(!logs.some((l) => /EMERGENCY: oxygen critical/.test(l)), 'a nearby squid\'s air (oxygenLevel 4) with her own at 300 ticks: no emergency');
  await sleep(10);
  bot.entity.metadata[1] = 30; bot.oxygenLevel = 20;
  bot.emit('breath');
  assert(logs.some((l) => /EMERGENCY: oxygen critical \(2\)/.test(l)), 'her own air at 30 ticks: emergency');

  const land = new V3(4, 64, 0);
  const shoreBot = {
    findBlocks: ({ matching }) => {
      // The palette pass: one position-less block per section; false skips the whole section.
      if (!matching({ name: 'air', boundingBox: 'empty', liquid: false })) return [];
      return matching({ name: 'air', boundingBox: 'empty', liquid: false, position: land }) ? [land] : [];
    },
    blockAt: (p) => (p.y === 63 ? { name: 'stone', boundingBox: 'block', liquid: false } : { name: 'air', boundingBox: 'empty' }),
  };
  assert.deepEqual(c.findNearestShore(shoreBot, 48), land, 'dry land beside the water is found');

  // 2026-11-06: mineflayer's Block has no `liquid`. A water block over sand passed as air over dry
  // ground -- the "shore" was the sea floor, 9 blocks down, and every trip there failed No path.
  const seabed = new V3(0, 54, 0);
  const seaBot = {
    findBlocks: ({ matching }) => {
      if (!matching({ name: 'water', boundingBox: 'empty' })) return [];
      return matching({ name: 'water', boundingBox: 'empty', position: seabed }) ? [seabed] : [];
    },
    blockAt: (p) => (p.y < 54 ? { name: 'sand', boundingBox: 'block' } : { name: 'water', boundingBox: 'empty' }),
  };
  assert.equal(c.findNearestShore(seaBot, 48), null, 'water over sand is the sea floor, not dry land');
});


await check('Water: bobbing at the surface (isInWater false for a tick) still sends her for the shore', async () => {
  // Live, 2026-11-05: four emergencies in a row in a deep pool, each "surfaced (stillInWater=false)"
  // and no shore search -- her jump lifted her clear of the water for the tick it was checked.
  const logs = [];
  const bot = new EventEmitter();
  const feet = new V3(0, 64, 0);
  Object.assign(bot, {
    entity: { isInWater: true, metadata: { 1: 30 }, position: { floored: () => feet } },
    setControlState() {},
    blockAt: (p) => (p.y === 64 ? { name: 'water', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' }),
    findBlocks: () => [],
    pathfinder: { setGoal() {} },
  });
  const handle = { token: {}, release() {} };
  const c = vm.createContext({ bot, console: { log: (...l) => logs.push(l.join(' ')), error() {} }, Date, Math, setTimeout, clearTimeout,
    AUTONOMY_ENABLED: true, USERNAME: 'Babs', goals: { GoalNear: class {} },
    arbiter: { OWNERS: { DROWNING: 'drowning' }, requestControl: async () => handle, holdsControl: () => true, currentOwner: () => 'x' } });
  vm.runInContext(between(index, 'const DROWNING_OXYGEN_THRESHOLD', '// Direct request, 2026-09-07 ("they don\'t seem to be fighting back'), c);
  bot.emit('breath');
  bot.entity.isInWater = false; // her head clears the surface for a tick
  await sleep(300);
  assert(logs.some((l) => /surfaced .*stillInWater=false/.test(l)), 'she surfaced');
  assert(logs.some((l) => /dry land/.test(l)), 'the shore search ran with water still at her feet');
});


await check('Pathfinding: out of search budget, she walks the partial path toward the goal and searches again', async () => {
  const { bot, calls, goal } = steppedGotoWorld([
    { status: 'noPath', path: [new V3(10, 64, 0), new V3(20, 64, 0)], cost: 64 },
    { status: 'timeout', path: [new V3(45, 64, 0)] },
    'ok',
  ]);
  await bot.pathfinder.goto(goal);
  assert.deepEqual(calls, ['goal', 'block', 'goal', 'block', 'goal'], 'two legs walked, then the whole way found');
  assert.equal(bot.entity.position.x, 45);
  assert.deepEqual(bot.pathfinder.legRadii, [72, 48], 'a leg costing 64 gets the budget to walk it; the limit is put back after');
  assert.equal(bot.pathfinder.searchRadius, 48);
});


await check('Pathfinding: no progress, a changed goal, or too many legs still fail', async () => {
  let w = steppedGotoWorld([{ status: 'noPath', path: [new V3(1, 64, 0)] }]);
  await assert.rejects(w.bot.pathfinder.goto(w.goal), { name: 'NoPath' }, 'one block closer is no progress');
  w = steppedGotoWorld([{ error: 'GoalChanged' }]);
  await assert.rejects(w.bot.pathfinder.goto(w.goal), { name: 'GoalChanged' });
  assert.deepEqual(w.calls, ['goal'], 'a preemptor took over -- no leg walked');
  w = steppedGotoWorld(Array.from({ length: 12 }, (_, i) => ({ status: 'noPath', path: [new V3(5 * (i + 1), 64, 0)] })));
  await assert.rejects(w.bot.pathfinder.goto(w.goal), { name: 'NoPath' });
  assert.equal(w.calls.filter((k) => k === 'goal').length, 8, 'eight searches, then she gives up');
});

// 2026-11-11 (swim-movements.js 1.7.0): Amy, 90 blocks under home in a cave with no pickaxe, never
// came back up -- a step up through rock was priced past the pathfinder's per-move limit.
await check('Pathfinding: far below the goal under rock, she climbs in legs with digging made cheap, then finds the way', async () => {
  const home = { y: 94, heuristic: (n) => Math.abs(100 - n.x) + Math.abs(94 - n.y) };
  // A cave search that wanders sideways, as Amy's did; then the whole way from near the top.
  const { bot, calls } = steppedGotoWorld([
    { status: 'noPath', path: [new V3(20, 3, 0)] },
    { status: 'noPath', path: [] },
    { status: 'noPath', path: [new V3(20, 50, 0)] }, // this one climbs on its own: walked, as before
    'ok',
  ], { start: new V3(0, 3, 0), rock: true });
  await bot.pathfinder.goto(home);
  assert.deepEqual(calls.slice(0, 4), ['goal', 'y', 'goal', 'y'], 'a sideways partial and no partial both get a climb instead');
  assert.deepEqual(bot.pathfinder.climbDigCosts, [1, 1], 'digging is cheap only while climbing');
  assert.equal(bot.pathfinder.movements.digCost, 15, 'and put back after');
  assert.deepEqual(bot.pathfinder.climbRadii, [500, 500], 'a climb search gets the budget for 8 blocks of rock');
  assert.equal(bot.pathfinder.searchRadius, 48, 'the budget is put back after');
  assert.equal(calls.at(-1), 'goal', 'then the whole way is searched again');
  assert.equal(bot.entity.position.y, 50, 'two climbs, then a partial path that rises is walked');
});

await check('Pathfinding: a climb search that runs short is walked as far as it rose', async () => {
  const home = { y: 94, heuristic: (n) => Math.abs(94 - n.y) };
  const { bot, calls } = steppedGotoWorld([
    { status: 'noPath', path: [] },
    { climbPartial: [new V3(1, 4, 0), new V3(2, 7, 0)], cost: 520 },
    'ok',
  ], { start: new V3(0, 3, 0), rock: true });
  await bot.pathfinder.goto(home);
  assert.deepEqual(calls, ['goal', 'y', 'block', 'goal'], 'climb, walk its partial up, then search again');
  assert.equal(bot.entity.position.y, 7);
  assert.deepEqual(bot.pathfinder.legRadii, [528], 'the walk gets the budget its partial path cost');
  assert.equal(bot.pathfinder.searchRadius, 48);
  assert.equal(bot.pathfinder.movements.digCost, 15);
});

await check('Pathfinding: climbs do not use up legs, and a partial that barely rises gets a climb instead', async () => {
  // Live (2026-11-11): counted as legs, two 2-block pillar legs spent the last of them 12 short.
  const deep = { y: 200, heuristic: (n) => Math.abs(200 - n.y) };
  let w = steppedGotoWorld([...Array.from({ length: 12 }, () => ({ status: 'noPath', path: [] })), 'ok'],
    { start: new V3(0, 3, 0), rock: true });
  await w.bot.pathfinder.goto(deep);
  assert.equal(w.calls.filter((k) => k === 'y').length, 12, 'twelve climbs, past the eight-leg limit');
  assert.equal(w.bot.entity.position.y, 99);
  w = steppedGotoWorld([{ status: 'noPath', path: [new V3(0, 5, 0)] }, 'ok'], { start: new V3(0, 3, 0), rock: true });
  await w.bot.pathfinder.goto(deep);
  assert.deepEqual(w.calls, ['goal', 'y', 'goal'], 'a partial rising 2 is not walked: she climbs 8');
});

await check('Pathfinding: no climb under open sky, close to the goal height, or while digging is off', async () => {
  const above = { y: 94, heuristic: (n) => Math.abs(100 - n.x) };
  let w = steppedGotoWorld([{ status: 'noPath', path: [new V3(20, 64, 0)] }, 'ok'], { rock: false });
  await w.bot.pathfinder.goto(above);
  assert(!w.calls.includes('y'), 'open sky: she walks round, never tunnels up a hillside');
  w = steppedGotoWorld([{ status: 'noPath', path: [new V3(20, 64, 0)] }, 'ok'], { rock: true });
  await w.bot.pathfinder.goto({ y: 70, heuristic: above.heuristic });
  assert(!w.calls.includes('y'), 'six blocks up is not a climb');
  w = steppedGotoWorld([{ status: 'noPath', path: [] }], { start: new V3(0, 3, 0), rock: true, canDig: false });
  await assert.rejects(w.bot.pathfinder.goto(above), { name: 'NoPath' }, 'digging suppressed: nothing to climb with');
  w = steppedGotoWorld([{ status: 'noPath', path: [new V3(20, 64, 0)] }, 'ok'], { rock: true });
  await w.bot.pathfinder.goto({ heuristic: above.heuristic });
  assert(!w.calls.includes('y'), 'a goal with no height (following someone) is never climbed to');
});

await check('Pathfinding: an empty, failed search the library resolved gets a climb when sealed in rock, else stands', async () => {
  // The live scenario found it: sealed in rock, the search came back partial with no nodes and
  // goto() resolved -- she "arrived" 32 blocks under her goal without a step.
  const sealed = { y: 94, heuristic: (n) => Math.abs(94 - n.y), isEnd: (n) => n.y === 94 };
  let w = steppedGotoWorld([{ status: 'partial', path: [], resolves: true }, 'ok'], { start: new V3(0, 3, 0), rock: true });
  await w.bot.pathfinder.goto(sealed);
  assert.deepEqual(w.calls.slice(0, 2), ['goal', 'y'], 'sealed in: she climbs instead of "arriving"');
  // "mine" relies on the library's "as close as it gets" (live: felling a whole trunk broke when
  // this was a NoPath everywhere).
  w = steppedGotoWorld([{ status: 'noPath', path: [], resolves: true }], { rock: false });
  await w.bot.pathfinder.goto({ y: 94, heuristic: () => 5, isEnd: () => false });
  assert.deepEqual(w.calls, ['goal'], 'no climb to make: it resolves, as the library does');
});

// 2026-11-10 (pathfinding.js 1.0.0): the pathfinder setup moved out of index.js unchanged.
await check('Pathfinding: setupPathfinding installs the costs, unbreakable blocks, search limits and the dig_error burst guard', async () => {
  const src = await readFile(root + 'pathfinding.js', 'utf8');
  class Movements { constructor() { this.blocksCantBreak = new Set(); this.exclusionAreasPlace = []; this.canDig = true; } }
  const installed = [];
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry: { blocksArray: [{ id: 1, name: 'chest', hardness: 2.5 }, { id: 2, name: 'obsidian', hardness: 50 },
                              { id: 3, name: 'dirt', hardness: 0.5 }] },
    pathfinder: { setMovements(m) { this.movements = m; } }, pvp: {}, collectBlock: {},
    entity: { position: new V3(0, 64, 0) }, entities: {}, blockAt: () => null,
  });
  const c = vm.createContext({ console: { log() {}, error() {} }, Vec3: V3, SwimMovements: Movements, setTimeout, Date,
    installDoorSupport: () => installed.push('doors'), installSteppedGoto: () => installed.push('stepped'),
    isProtectedBlockName: (name) => name === 'chest', wouldBlockAccess: () => true });
  vm.runInContext(between(src, 'function setupPathfinding'), c);
  const movements = c.setupPathfinding(bot, { username: 'Amy' });
  assert.equal(bot.pathfinder.movements, movements, 'the one shared instance is the pathfinder movements');
  assert.ok(bot.pvp.movements === movements && bot.collectBlock.movements === movements, 'and pvp/collectBlock reuse it');
  assert.deepEqual([movements.liquidCost, movements.entityCost, movements.digCost, movements.canOpenDoors], [20, 8, 15, true]);
  assert.deepEqual([bot.pathfinder.searchRadius, bot.pathfinder.thinkTimeout, bot.pathfinder.tickTimeout], [48, 1000, 20]);
  assert.deepEqual(Array.from(movements.blocksCantBreak).sort(), [1, 2], 'protected and very hard blocks, not dirt');
  assert.equal(movements.exclusionAreasPlace[0]({ position: new V3(1, 64, 1) }), 100, 'no scaffolding in a doorway');
  assert.deepEqual(installed, ['doors', 'stepped']);
  for (let i = 0; i < 4; i++) bot.emit('path_reset', 'dig_error');
  assert.equal(movements.canDig, false, 'four dig_errors in a burst force walk-only pathing');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
