// Version: 1.1.0
//
// 1.1.0 (2026-11-10): slices read the split modules (actions/*.js via actionCases/actionHandlerSrc, the modules out of index.js via index/indexOnly), and sandboxes stub guardedInterval.
//
// Unit checks: chest memory, storing, looting and consolidation (part 2 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/chests-2.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, arbiter, V3, between, actionFn, timeoutFn, makeBot, context, shelter, check, blockWorld, room, tunnel, slice, residenceWorld, chestMemory, chestAt, chestWorld, chestActionContext, passedCount } from './_harness.mjs';


await check('Torches: a trail torch never hangs on a chest, glass or leaves -- a wall is used instead', async () => {
  const c = tunnel();
  assert.equal(c.canHoldTorch({ name: 'stone', boundingBox: 'block' }), true);
  for (const name of ['chest', 'white_bed', 'oak_door', 'furnace', 'glass', 'oak_leaves', 'oak_fence', 'ice']) {
    assert.equal(c.canHoldTorch({ name, boundingBox: 'block' }), false, name);
  }
  assert.equal(c.canHoldTorch({ name: 'oak_leaves', boundingBox: 'empty' }), false);

  const w = blockWorld({ groundY: 40 });
  w.place([0, 40, 0], 'chest');       // standing on a chest: the floor can't hold one
  w.place([1, 41, 0], 'deepslate');   // but the tunnel wall beside her can
  w.place([0, 43, 0], 'deepslate');   // under cover
  w.bot.entity = { position: new V3(0.5, 41, 0.5) };
  w.bot.inventory.items = () => [{ name: 'torch', count: 4 }];
  const spot = c.trailTorchSpot(w.bot, null);
  assert(!spot.skip, JSON.stringify(spot));
  assert.equal(spot.reference.name, 'deepslate');
  assert.equal(`${spot.face}`, '(-1, 0, 0)', 'facing out of the wall'); // as a string: -0 is not 0 to strictEqual
});


await check('Torches: she tops up from coal she carries, falls back to a chest, and backs off after a failure', async () => {
  const calls = [];
  let reply = { ok: true, text: 'crafted 16 torch' };
  let inv = [{ name: 'torch', count: 2 }, { name: 'coal', count: 4 }, { name: 'oak_log', count: 3 }];
  const bot = { isSleeping: false, entity: { position: new V3(0, 64, 0) }, inventory: { items: () => inv } };
  const t = tunnel();
  const c = vm.createContext({ bot, Date, process: { env: {} }, console: { log() {}, error() {} },
    USERNAME: 'Babs', AUTONOMY_ENABLED: true, routineBlocked: () => false,
    arbiter: { OWNERS: { ROUTINE: 1 }, requestControl: async () => ({ release() {} }) },
    needsTorches: t.needsTorches, torchCount: t.torchCount, TORCH_CARRY_MIN: vm.runInContext('TORCH_CARRY_MIN', t),
    heldCount: (test) => inv.filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    performAction: async (b, a) => { calls.push(a); return reply; } });
  vm.runInContext(between(index, 'const TORCH_SUPPLY_CHECK_MS', 'guardedInterval(() => {\n  checkTorchSupply'), c);

  await c.checkTorchSupply();
  assert.deepEqual(calls.map((a) => `${a.type}:${a.item}`), ['craft:torch'], 'coal and a log on hand: make them');
  assert.equal(calls[0].count, 16, 'four coal: 16 torches (a craft count is items wanted, 2026-10-29)');

  inv = [{ name: 'torch', count: 2 }]; // no coal, no wood
  await c.checkTorchSupply();
  assert.equal(calls[1].type, 'loot', 'nothing to craft from: try a chest');

  reply = { ok: false, text: "couldn't find a chest" };
  await c.checkTorchSupply();
  const after = calls.length;
  await c.checkTorchSupply();
  assert.equal(calls.length, after, 'a failed attempt backs off instead of retrying every two minutes');

  inv = [{ name: 'torch', count: 16 }];
  assert.equal(t.needsTorches(bot), false, 'a full pouch is left alone');
});


// ---- 2026-11-04: the 24h-review loops (index.js 2.133.0 / actions.js 1.103.0) ----------------------

await check('Inventory: full, with every chest at home full -- plain surplus is dropped, never food, ore or tools', async () => {
  // Babs, 2026-11-04: 36 slots full (10 bows, 4 crossbows, 576 seeds...), every chest "destination
  // full", and the old code only ever retried storing -- which the storage backoff skipped.
  const inv = [];
  const add = (name, count, extra = {}) => inv.push({ name, count, type: name, ...extra });
  for (let i = 0; i < 10; i++) add('bow', 1, { durabilityUsed: i === 3 ? 2 : 50 + i });
  for (let i = 0; i < 4; i++) add('crossbow', 1, { durabilityUsed: 10 + i });
  add('wooden_sword', 1, { durabilityUsed: 0 }); add('iron_sword', 1, { durabilityUsed: 200 }); add('stone_sword', 1);
  add('crafting_table', 3);
  for (let i = 0; i < 9; i++) add('wheat_seeds', 64);
  for (const n of [64, 64, 64, 8]) add('wheat', n);
  add('rotten_flesh', 5); add('cobblestone', 64); add('cobblestone', 64); add('iron_ingot', 3); add('bone', 9);
  assert.equal(inv.length, 36);
  const tossed = [], walked = [];
  const bot = {
    isSleeping: false, spawnPoint: new V3(0, 64, 0), entity: { position: new V3(0, 64, 0) }, registry: { items: {} },
    blockAt: (p) => ({ boundingBox: p.y < 64 ? 'block' : 'empty' }),
    pathfinder: { goto: async (g) => { walked.push([g.x, g.z, tossed.length]); }, setGoal() {} },
    lookAt: async () => {},
    inventory: { items: () => inv.filter((i) => i.count > 0) },
    tossStack: async (item) => { tossed.push([item.name, item.count]); item.count = 0; },
    toss: async (type, _m, count) => { tossed.push([type, count]); inv.find((i) => i.name === type && i.count >= count).count -= count; },
  };
  const calls = [];
  const c = vm.createContext({ bot, console: { log() {}, error() {} }, Date, Map, Set, Math, setTimeout, clearTimeout,
    goals: { GoalNear: class { constructor(x, y, z) { Object.assign(this, { x, z }); } } },
    AUTONOMY_ENABLED: true, routineBlocked: () => false, INVENTORY_MAIN_HOTBAR_SLOTS: 36, INVENTORY_FULL_SLOTS: 3,
    countUsableNearHome: () => 2, storageBlockedUntil: Date.now() + 60_000, USERNAME: 'Babs',
    arbiter: { OWNERS: { ROUTINE: 'routine' }, requestControl: async () => ({ release() {} }), holdsControl: () => true },
    storeSurplusValuables: async () => calls.push('store'),
    heldCount: (t) => inv.filter((i) => i.count > 0 && t(i.name)).reduce((n, i) => n + i.count, 0),
    gatherPlanks: async () => ({ ok: true, text: 'gathering' }),
    performAction: async (_b, a) => { calls.push(`${a.type} ${a.item}`); return { ok: true, text: 'done' }; },
    writeMemoryNote: async () => {}, PERSONA_NAME: 'babs',
    TOOL_RANK: { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 } });
  vm.runInContext(between(index, 'async function makeHomeChest', 'guardedInterval(() => {\n  checkInventoryFull'), c);
  await c.checkInventoryFull();
  const total = (name) => tossed.filter(([n]) => n === name).reduce((n, [, k]) => n + k, 0);
  assert.equal(total('bow'), 9, 'nine bows go');
  assert.equal(inv.find((i) => i.name === 'bow' && i.count).durabilityUsed, 2, 'the least worn bow stays');
  assert.equal(total('crossbow'), 3);
  assert.equal(total('wooden_sword') + total('stone_sword'), 2);
  assert.equal(total('iron_sword'), 0, 'the best sword (by tier) stays');
  assert.equal(total('crafting_table'), 2, 'one crafting table kept');
  assert.equal(total('wheat_seeds'), 512, 'seeds beyond a stack of 64 go');
  assert.equal(total('rotten_flesh'), 5);
  for (const keep of ['wheat', 'cobblestone', 'iron_ingot', 'bone']) assert.equal(total(keep), 0, `${keep} is never dropped`);
  assert(!calls.includes('store'), 'no walk back to the full chests');
  // Not at her feet, where home's traffic would pick it back up: she throws from 6 blocks out, then walks home.
  assert.deepEqual(walked[0], [6, 0, 0], 'out to standable ground 6 blocks from home before anything is thrown');
  assert.deepEqual(walked.at(-1).slice(0, 2), [0, 0], 'then straight back home');
  assert(walked.at(-1)[2] > 0, 'after the throw');

  // Holding a chest with every chest full: it goes down, and storing starts again.
  inv.length = 0; tossed.length = 0; calls.length = 0;
  for (let i = 0; i < 33; i++) add('cobblestone', 64);
  add('chest', 1);
  c.storageBlockedUntil = Date.now() + 60_000;
  await c.checkInventoryFull();
  assert.deepEqual(calls, ['place_home chest'], 'a new chest is placed at home');
  assert.equal(c.storageBlockedUntil, 0, 'and the storage backoff is cleared');

  // 2026-11-04 ("when a chest is full, they should build another chest"): not only when she's full.
  inv.length = 0; calls.length = 0;
  add('chest', 1); add('cobblestone', 10);
  c.storageBlockedUntil = Date.now() + 60_000;
  await c.checkInventoryFull();
  assert.deepEqual(calls, ['place_home chest'], 'every chest full, her own slots free: another chest anyway');

  // 2026-11-05: a transient craft failure ("missing ingredient" off a stale inventory) retries on the
  // next check; only no wood at all waits out the retry.
  inv.length = 0; calls.length = 0;
  add('oak_planks', 8);
  c.storageBlockedUntil = Date.now() + 60_000;
  c.gatherPlanks = async () => null; // planks in hand
  c.performAction = async (_b, a) => { calls.push(`${a.type} ${a.item}`); return { ok: false, text: 'missing ingredient' }; };
  await c.checkInventoryFull();
  await c.checkInventoryFull();
  assert.deepEqual(calls, ['craft chest', 'craft chest'], 'a failed craft is tried again on the next check');
  calls.length = 0;
  c.gatherPlanks = async () => ({ ok: false, noWood: true, text: "need wood and there's no tree nearby." });
  await c.checkInventoryFull();
  c.gatherPlanks = async () => { calls.push('gather'); return null; };
  await c.checkInventoryFull();
  assert.deepEqual(calls, [], 'no wood: the next check waits');
});


await check('Residences: a bed for each active bot -- in an empty shelter first, a chest in a bedded one, else a new shelter', async () => {
  // Direct request, 2026-11-04: "a residence should consist of a bed, a chest, at least one door, and
  // enclosed walls/ceiling/floor ... 4 active bots means 4 beds ... if not enough room in existing
  // shelters, start a new shelter." The old shelterStep was done as soon as HER shelter had a bed.
  const calls = [];
  const c = vm.createContext({ Vec3: V3, USERNAME: 'Amy', console: { log() {}, error() {} }, Math,
    BOT_USERNAMES: new Set(['Babs', 'Amy', 'Mark']), SHELTER_ROOM: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]],
    SHELTER_SITE_RADIUS: 48, held: [],
    holdsItem: (n) => c.held.includes(n), heldCount: () => 0,
    builderAcquireStep: async (item) => ({ ok: true, text: `making a ${item}`, action: { type: 'craft', item } }),
    bedStep: async () => ({ ok: true, text: 'got wool.', action: { type: 'get_wool' } }),
    findShelterNearHome: () => ({ base: c.bases[0], complete: true }), // what the old code went by
    unfinishedShelterNearHome: () => null, findShelterSite: () => new V3(20, 64, 0),
    isDoorway: () => true, doorwayPosition: (b) => b.offset(0, 0, 3), shelterPositions: () => [], shelterMaterialCount: () => 0,
    gatherPlanks: async () => null,
    completeSheltersNearHome: () => c.bases, blockedCells: [],
    wouldBlockAccess: (_b, p) => (c.blockedCells.some((q) => q.equals(p)) ? { fixture: 'white_bed', reason: 'the last way up to' } : null),
    shelterHasBed: (b) => c.bot.isABed(c.bot.blockAt(b)),
    performAction: async (_b, a) => { calls.push(a); return { ok: true, text: a.type }; } });
  const use = (w) => { c.bot = w.bot; c.bases = w.bases; calls.length = 0; };
  vm.runInContext(slice(index, 'function activeBotCount', '// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1 --') +
    between(index, 'async function shelterStep(', 'async function runShelterGoal('), c);
  c.bot = { inventory: { items: () => [] } };

  use(residenceWorld({ online: ['Amy', 'Babs'], shelters: [{ base: new V3(0, 64, 0), bed: true, chest: true },
    { base: new V3(10, 64, 0) }] }));
  c.bot.inventory = { items: () => [{ name: 'white_bed', count: 1 }] };
  let step = await c.shelterStep({}, null);
  assert.equal(calls[0]?.type, 'place_bed', `two active bots, one bed: ${step.text}`);
  assert.equal(calls[0].near.x, 10, 'into the empty shelter');

  use(residenceWorld({ online: ['Amy'], shelters: [{ base: new V3(0, 64, 0), bed: true }] }));
  c.bot.inventory = { items: () => [] }; c.held = ['chest'];
  step = await c.shelterStep({}, null);
  assert.equal(calls[0]?.type, 'place', `a bedded shelter with no chest gets one: ${step.text}`);
  assert.deepEqual({ ...calls[0].at }, { x: 1, y: 64, z: 0 }, 'on free floor in its room, not in the way through the door');

  use(residenceWorld({ online: ['Amy', 'Babs'], shelters: [{ base: new V3(0, 64, 0), bed: true, chest: true }] }));
  c.held = [];
  const goal = {};
  step = await c.shelterStep(goal, null);
  assert.equal(calls[0]?.type, 'build', `no shelter has room: a new one -- ${step.text}`);
  assert.deepEqual({ ...goal.shelterAt }, { x: 20, y: 64, z: 0 });

  use(residenceWorld({ online: ['Amy'], shelters: [{ base: new V3(0, 64, 0), bed: true, chest: true }] }));
  step = await c.shelterStep({}, null);
  assert.equal(step.done, true, 'one active bot, one residence with bed and chest: done');

  // 2026-11-05: a bed in each column leaves one free cell, and it is one bed's last way in. Every
  // bot asked for a chest there and was refused, ~1,500 times each, with all other work blocked.
  use(residenceWorld({ online: ['Amy', 'Babs'], shelters: [{ base: new V3(0, 64, 0), bed: true, secondBed: true }] }));
  c.blockedCells = [new V3(1, 64, 2)]; c.held = ['chest'];
  step = await c.shelterStep({}, null);
  assert(!calls.some((a) => a.type === 'place'), `no chest into a bed's last way in: ${step.text}`);
  assert.equal(step.done, true, 'two beds for two active bots in a shelter with no room for a chest: done');
  c.blockedCells = [];
});


await check('Trash: a near-broken weapon and rotten flesh go into visible lava; the only one of a kind stays', async () => {
  // Direct request, 2026-11-04: "'trash' items like almost broken weapons, zombie flesh can be
  // disposed of in lava".
  const inv = [
    { name: 'iron_sword', type: 'iron_sword', count: 1, durabilityUsed: 240 },
    { name: 'diamond_sword', type: 'diamond_sword', count: 1, durabilityUsed: 10 },
    { name: 'wooden_pickaxe', type: 'wooden_pickaxe', count: 1, durabilityUsed: 58 },
    { name: 'rotten_flesh', type: 'rotten_flesh', count: 3 }, { name: 'bread', type: 'bread', count: 4 }];
  const tossed = [], walked = [];
  let lava = [new V3(5, 63, 0)];
  const bot = {
    isSleeping: false, entity: { position: new V3(3, 64, 0) },
    registry: { items: { iron_sword: { maxDurability: 250 }, diamond_sword: { maxDurability: 1561 }, wooden_pickaxe: { maxDurability: 59 } },
      blocksByName: { lava: { id: 99 } } },
    inventory: { items: () => inv.filter((i) => i.count > 0) },
    findBlocks: ({ matching }) => (matching === 99 ? lava : []),
    blockAt: (p) => ({ boundingBox: 'empty', name: 'air', position: p }),
    pathfinder: { goto: async (g) => walked.push(g), setGoal() {} }, lookAt: async () => {},
    tossStack: async (item) => { tossed.push(item.name); item.count = 0; },
    toss: async () => {},
  };
  const c = vm.createContext({ bot, console: { log() {}, error() {} }, Date, Map, Set, Math, setTimeout, clearTimeout,
    AUTONOMY_ENABLED: true, routineBlocked: () => false, USERNAME: 'Amy', process: { env: {} },
    goals: { GoalNear: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } } },
    arbiter: { OWNERS: { ROUTINE: 'routine' }, requestControl: async () => ({ release() {} }), holdsControl: () => true },
    TOOL_RANK: { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 } });
  vm.runInContext(slice(index, 'const DROP_DISTANCE', 'const EXTRA_CHEST_RETRY_MS') +
    slice(index, '// Trash into lava', 'guardedInterval(() => {\n  checkTrash'), c);
  await c.checkTrash();
  assert.deepEqual(tossed.sort(), ['iron_sword', 'rotten_flesh'], 'the spent sword (a good one stays) and the flesh');
  assert.equal(walked.length, 1, 'she walks beside the lava first');
  tossed.length = 0; lava = [];
  inv.push({ name: 'rotten_flesh', type: 'rotten_flesh', count: 2 });
  await c.checkTrash();
  assert.deepEqual(tossed, [], 'no lava in sight: nothing thrown here (a full inventory still drops it the old way)');
});


await check('Chests: an item is stored with its own kind before the nearest empty chest', async () => {
  const c = chestMemory();
  const known = {
    '2,64,0': chestAt(2, {}),
    '4,64,0': chestAt(4, { white_wool: 5 }),
    '8,64,0': chestAt(8, { oak_log: 12 }),
    '10,64,0': chestAt(10, { birch_log: 64 }, { freeSlots: 0 }),
    '12,64,0': chestAt(12, { birch_log: 3 }),
    '100,64,0': chestAt(100, { birch_log: 30 }),
    '200,64,0': chestAt(200, { birch_log: 30 }),
  };
  const seen = [new V3(2, 64, 0), new V3(3, 64, 0), new V3(4, 64, 0)]; // (3,64,0) never opened
  const order = Array.from(c.rankStoreChests(known, seen, 'birch_log', new V3(0, 64, 0)), (r) => r.position.x);
  assert.deepEqual(order, [12, 100, 8, 2, 3, 4, 10],
    'same item (100 blocks off still counts), then same kind, then empty/unknown, then other things, a full chest last, 200 off not at all');
  assert.equal(c.itemFamily('spruce_wood'), 'log'); assert.equal(c.itemFamily('red_wool'), 'wool');
  assert.equal(c.itemFamily('cobbled_deepslate'), 'stone'); assert.equal(c.itemFamily('raw_iron'), 'ore');
  assert.equal(c.itemFamily('beef'), 'food'); assert.equal(c.itemFamily('stone_pickaxe'), 'tools');
});


await check('Chests: a split kind is moved from the smaller pile to the larger, not into a full chest', async () => {
  const c = chestMemory();
  const known = {
    '0,64,0': chestAt(0, { oak_log: 10, bread: 4 }),
    '5,64,0': chestAt(5, { birch_log: 70, cobblestone: 64 }, { freeSlots: 5 }),
    '9,64,0': chestAt(9, { bread: 30 }, { freeSlots: 0 }),
    '200,64,0': chestAt(200, { oak_log: 500 }),
  };
  const plan = c.findConsolidation(known, new V3(0, 64, 0));
  assert.equal(plan.family, 'log');
  assert.equal(plan.from.position.x, 0); assert.equal(plan.to.position.x, 5);
  assert.deepEqual({ ...plan.from.items }, { oak_log: 10 });
  assert.equal(c.findConsolidation(known, new V3(0, 64, 0), { involving: '9,64,0' }), null,
    'the bread chest is full, so there is nothing to bring into it');
  assert.equal(c.findConsolidation({ a: chestAt(0, { oak_log: 1 }), b: chestAt(3, { white_wool: 1 }) }, new V3(0, 64, 0)), null);
});


await check('Chests: looking into a chest that shares a kind with another leaves the move as a hint', async () => {
  const c = chestMemory({ '5,64,0': chestAt(5, { birch_log: 40 }, { freeSlots: 10 }) });
  await c.recordChestSnapshot(new V3(0, 64, 0), [{ name: 'white_wool', count: 3 }], 27);
  assert.equal(c.consolidationPending(), false, 'wool and logs are not the same kind');
  await c.recordChestSnapshot(new V3(0, 64, 0), [{ name: 'oak_log', count: 3 }], 27);
  const plan = c.takeConsolidationHint();
  assert.equal(plan.family, 'log'); assert.equal(plan.to.position.x, 5);
  assert.equal(c.consolidationPending(), false, 'taking the hint clears it');
});


await check('Chests: loot and the chest-first fallback look 128 blocks out, walking far chests in hops', async () => {
  const bot = makeBot();
  const radii = [];
  Object.assign(bot, { registry: { blocksByName: { chest: { id: 9 } }, itemsByName: {} },
    findBlocks: (o) => { radii.push(o.maxDistance); return []; } });
  const c = context(bot, { chestObstructed: () => false, wanderAndRetryFind: async () => [],
    findKnownChestWithItem: async () => null, refreshGear: async () => {}, CHEST_CHECK_MAX_CANDIDATES: 3 });
  vm.runInContext(timeoutFn + between(actions, 'async function searchChestsFor(', '// Extracted from tryTakeFromNearbyChest') + actionFn, c);
  await c.searchChestsFor(bot, { cancelled: false }, ['stick'], 2);
  await c.performAction(bot, { type: 'loot' }, 'test');
  assert.deepEqual(radii, [128, 128]);
  // hopToward: a chest 120 blocks east is walked to in 40-block hops, and one 30 away not at all.
  const hops = [];
  const walker = { entity: { position: new V3(0, 64, 0) }, pathfinder: { setGoal() {},
    goto: async (g) => { hops.push(Math.round(g.x)); walker.entity.position = new V3(g.x, 64, g.z); } } };
  const h = vm.createContext({ setTimeout, clearTimeout, Promise, EXPLORE_DISTANCE: 40, MAX_DIRECTED_HOPS: 4, EXPLORE_TIMEOUT_MS: 1000,
    goals: { GoalNearXZ: class { constructor(x, z) { this.x = x; this.z = z; } } } });
  vm.runInContext(timeoutFn + between(actions, 'async function hopToward(', 'async function gotoRememberedSpot('), h);
  await h.hopToward(walker, { cancelled: false }, new V3(120, 64, 0));
  assert.deepEqual(hops, [40, 80]);
  hops.length = 0; walker.entity.position = new V3(0, 64, 0);
  await h.hopToward(walker, { cancelled: false }, new V3(30, 64, 0));
  assert.deepEqual(hops, []);
});


await check('Chests: store walks past the nearest empty chest to the one already holding that kind', async () => {
  const chests = { '2,64,0': [], '9,64,0': [{ type: 6, name: 'birch_log', count: 20 }] };
  const { bot, opened } = chestWorld(chests, [{ type: 5, name: 'oak_log', count: 8 }]);
  const ctx = chestActionContext(bot, {
    '2,64,0': chestAt(2, {}, { freeSlots: 27 }), '9,64,0': chestAt(9, { birch_log: 20 }, { freeSlots: 26 }) });
  const result = await ctx.performAction(bot, { type: 'store', item: 'oak_log', count: Infinity }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(opened, ['9,64,0'], 'the logs went in with the other logs');
});


await check('Chests: consolidating moves the smaller pile in as full stacks and leaves her own logs alone', async () => {
  const chests = {
    '0,64,0': [{ type: 5, name: 'oak_log', count: 10 }],
    '5,64,0': [{ type: 5, name: 'oak_log', count: 40 }, { type: 6, name: 'birch_log', count: 64 }, { type: 5, name: 'oak_log', count: 20 }],
  };
  const { bot, deposits } = chestWorld(chests, [{ type: 5, name: 'oak_log', count: 3 }]);
  const ctx = chestActionContext(bot, {
    '0,64,0': chestAt(0, { oak_log: 10 }, { freeSlots: 26 }),
    '5,64,0': chestAt(5, { oak_log: 60, birch_log: 64 }, { freeSlots: 24 }) });
  const result = await ctx.performAction(bot, { type: 'consolidate_chests' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(deposits, [['5,64,0', 5, 70]], 'the 60 already there came out and went back with the 10');
  assert.deepEqual(chests['5,64,0'].filter((s) => s.type === 5 && s.count).map((s) => s.count), [64, 6],
    'two part-filled stacks and the moved ten end as one full stack and the rest');
  assert.equal(chests['0,64,0'].reduce((n, s) => n + s.count, 0), 0, 'the small pile is gone');
  assert.equal(bot.inventory.count(5), 3, 'her own three logs stayed with her');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
