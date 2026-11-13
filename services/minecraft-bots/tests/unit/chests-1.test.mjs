// Version: 1.1.1
// 1.1.1 (2026-11-13): index.js/actions.js 3.0.0 split into subject modules -- the end marker is the next declaration, not the periodic check that stayed in index.js; LOOT_GROUPS is read from where it now is.
//
// 1.1.0 (2026-11-10): slices read the split modules (actions/*.js via actionCases/actionHandlerSrc, the modules out of index.js via index/indexOnly), and sandboxes stub guardedInterval.
//
// Unit checks: chest memory, storing, looting and consolidation (part 1 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/chests-1.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actionHandlerSrc, root, actions, index, arbiter, V3, between, actionFn, timeoutFn, makeBot, context, shelter, sleep, check, builderClaimsWorld, goalTickContext, hungerWorld, farmGoalSrc, farmGoalWorld, blockWorld, room, slice, passedCount } from './_harness.mjs';


await check('MB-17 chest withdrawal spans mixed item types', async () => {
  const withdrawn = [];
  const contents = [{ type: 1, name: 'oak_log', count: 2 }, { type: 2, name: 'birch_log', count: 2 }];
  let closed = 0;
  const chest = { containerItems: () => contents, async withdraw(type, _, n) { withdrawn.push([type, n]); }, async close() { closed++; } };
  const bot = makeBot(); bot.pathfinder.goto = async () => {}; bot.openChest = async () => chest;
  const c = context(bot, { recordChestSnapshot: async () => {} });
  vm.runInContext(timeoutFn + between(actions, 'async function tryTakeFromThisChest(', '\n// Direct follow-up'), c);
  const taken = await c.tryTakeFromThisChest(bot, { cancelled: false }, { position: { x: 0, y: 0, z: 0 } }, ['oak_log', 'birch_log'], 4);
  assert.deepEqual(withdrawn, [[1, 2], [2, 2]]); assert.equal(taken.count, 4); assert.equal(closed, 1);
});


await check('EFF storage pauses after only full/obstructed chests, resumes on success', async () => {
  const c = vm.createContext({ Date, console: { log() {} }, USERNAME: 'Babs' });
  vm.runInContext(between(index, 'const STORAGE_BACKOFF_MS', 'async function storeSurplusValuables('), c);
  c.noteStoreResult({ ok: false, text: "found chests nearby, but couldn't store anything in any of them." });
  assert(vm.runInContext('storageBlockedUntil', c) > Date.now());
  c.noteStoreResult({ ok: false, cancelled: true, text: 'found chests nearby, but they are all obstructed' });
  c.noteStoreResult({ ok: true, text: 'stored 3 dirt' });
  assert.equal(vm.runInContext('storageBlockedUntil', c), 0);
  c.noteStoreResult({ ok: false, text: "can't find dirt in slots" });
  assert.equal(vm.runInContext('storageBlockedUntil', c), 0, 'item-specific failures do not pause storage');
});


await check('Tier 2: checkSurplusSharing runs storeSurplusNearHome on a standing cadence, gated like its siblings', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 3 -- "elevates 'don't hoard' from an
  // incidental cleanup pass to an explicit, regularly-checked Tier 2 item"). Before this,
  // storeSurplusNearHome() only ever ran right after a craft; surplus picked up any other way
  // never got checked. Same gating as checkDeferredSurplusCleanup's own post-craft version.
  let calls = 0;
  const bot = { isSleeping: false };
  const c = vm.createContext({ setInterval() {}, guardedInterval() {}, console: { error() {} }, process: { env: {} },
    AUTONOMY_ENABLED: true, currentGoal: null, routineBlocked: () => false, bot,
    storeSurplusNearHome: async () => { calls++; }, USERNAME: 'Amy' });
  vm.runInContext(between(index, 'const SURPLUS_SHARING_CHECK_MS', 'const LOCATION_SHARING_CHECK_MS'), c);
  await c.checkSurplusSharing();
  assert.equal(calls, 1, 'runs when idle, awake, autonomous, and not routine-blocked');
  vm.runInContext('currentGoal = {}', c);
  await c.checkSurplusSharing();
  assert.equal(calls, 1, 'skipped while a goal is active');
  vm.runInContext('currentGoal = null', c);
  bot.isSleeping = true;
  await c.checkSurplusSharing();
  assert.equal(calls, 1, 'skipped while asleep');
  bot.isSleeping = false;
  vm.runInContext('AUTONOMY_ENABLED = false', c);
  await c.checkSurplusSharing();
  assert.equal(calls, 1, 'skipped while autonomy is off');
});


await check('MB-02 flee restores shared movements only if its own copy is still active', async () => {
  const bot = makeBot(); let rejectGoto;
  const shared = bot.pathfinder.movements;
  bot.pathfinder.setMovements = (m) => { bot.pathfinder.movements = m; };
  bot.pathfinder.goto = () => new Promise((_, reject) => { rejectGoto = reject; });
  const flee = await arbiter.requestControl(bot, arbiter.OWNERS.SELF_DEFENSE);
  const c = context(bot, { goals: { GoalNear: class {}, GoalFollow: class {}, GoalInvert: class {} } });
  vm.runInContext(timeoutFn + actionFn, c);
  const pending = c.performAction(bot, { type: 'flee', target: { id: 9 } }, 'test', flee);
  await sleep(10);
  assert.equal(bot.pathfinder.movements.canDig, false, 'flee runs with digging off');
  assert.equal(shared.canDig, true, 'the shared Movements object was not mutated');
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  const emergencyMovements = { canDig: true, owner: 'emergency' };
  bot.pathfinder.setMovements(emergencyMovements);
  rejectGoto(new Error('The goal was changed'));
  await pending;
  assert.equal(bot.pathfinder.movements, emergencyMovements, 'the preemptor\'s movements survived flee cleanup');
  emergency.release();
});


await check('MB-09 inventory storing keeps the active goal\'s items and recipe inputs', async () => {
  const items = { 1: { name: 'furnace' }, 2: { name: 'cobblestone' } };
  const bot = { inventory: { items: () => [{ name: 'cobblestone' }, { name: 'iron_ingot' }, { name: 'dirt' }] },
    registry: { itemsByName: { furnace: { id: 1 }, cobblestone: { id: 2 } }, items },
    recipesAll: (id) => (id === 1 ? [{ delta: [{ id: 2, count: -8 }, { id: 1, count: 1 }] }] : []) };
  const c = vm.createContext({ bot, currentGoal: { description: 'craft a furnace and some iron ingot', actionsTaken: [{ type: 'mine', block: 'stone' }] } });
  vm.runInContext('var currentGoal = this.currentGoal;' + between(index, 'function goalReservedItems(', 'async function storeSurplusValuables('), c);
  const reserved = c.goalReservedItems();
  for (const name of ['furnace', 'cobblestone', 'iron_ingot', 'stone']) assert(reserved.has(name), `${name} reserved`);
  assert(!reserved.has('dirt'), 'unrelated items are still storable');
});


await check('EFF a chest search that just came up empty is not repeated from the same spot', async () => {
  let searches = 0;
  const bot = makeBot(); const here = { x: 0, y: 64, z: 0, distanceTo: () => 2, clone() { return this; } };
  bot.entity = { position: here };
  const c = context(bot, { searchChestsFor: async () => { searches++; return null; } });
  vm.runInContext(between(actions, 'const CHEST_MISS_TTL_MS', 'async function searchChestsFor('), c);
  await c.tryTakeFromNearbyChest(bot, { cancelled: false }, ['oak_log'], 4);
  await c.tryTakeFromNearbyChest(bot, { cancelled: false }, ['oak_log'], 4);
  assert.equal(searches, 1);
  await c.tryTakeFromNearbyChest(bot, { cancelled: false }, ['iron_ingot'], 1);
  assert.equal(searches, 2, 'a different item list still searches');
});


await check('Builder claims: the shared store down falls back to this host\'s own file, same as bed claims', async () => {
  const w = await builderClaimsWorld('Amy'); // no `shared` -- listState/setState both throw
  assert.equal(await w.c.claimBuilderItem(w.bot, 'chest'), true);
  assert.equal(await w.c.myBuilderClaim(w.bot), 'chest', 'the local fallback file still answers her own claim');
});


await check('Resource-gathering override: weaponStep -- a chest first, else gatherPlanks + craft', async () => {
  // 2026-10-12: root-caused a real, confirmed live regression (attack_win_rate collapsed from a
  // 0.846 baseline to 0.167) to weapon acquisition relying entirely on the freeform planner --
  // see weaponStep's own header for the full account, including the vicious cycle a weaponless
  // Soldier falls into (forced to flee, which keeps interrupting the one goal that would fix it).
  let calls = []; let armed = false;
  const bot = { inventory: { items: () => [] }, findBlocks: () => [], blockAt: () => ({ name: 'oak_log' }),
    registry: { blocksByName: {} } };
  const performAction = async (b, action) => {
    calls.push(action);
    if (action.type === 'loot') return { ok: false, text: 'nothing in any chest' };
    if (action.type === 'craft' && action.item === 'wooden_sword') { armed = true; return { ok: true, text: 'crafted a wooden_sword' }; }
    return { ok: true, text: 'did it' };
  };
  const c = vm.createContext({ bot, USERNAME: 'Amy', hasWeapon: () => armed,
    heldCount: (test) => bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    performAction });
  vm.runInContext(between(index, 'async function gatherPlanks(', 'async function bedStep('), c);

  armed = true;
  const done = await c.weaponStep({}, {});
  assert.equal(done.done, true, 'already has a real weapon -- immediately done');
  assert.equal(calls.length, 0, 'no action taken when already armed');
  armed = false;

  const goal = {};
  bot.findBlocks = () => [{ x: 1, y: 64, z: 1 }]; // a tree, for gatherPlanks' own fallback
  // A failed chest loot (bedStep's own "if ok or cancelled" convention, reused verbatim) falls
  // straight through to gathering within this SAME call, not a separate tick.
  const first = await c.weaponStep(goal, {});
  assert.equal(goal.triedWeaponChest, true, 'the chest check ran exactly once');
  assert.equal(first.action.type, 'mine');
  assert.equal(calls.filter((a) => a.type === 'loot').length, 1);
  assert.equal(calls.at(-1).count, 2, 'ceil(6/4) logs -- 2 planks for the sword, 4 more for her own table');

  const second = await c.weaponStep(goal, {}); // chest already tried -- never retried
  assert.equal(second.action.type, 'mine');
  assert.equal(calls.filter((a) => a.type === 'loot').length, 1, 'still just the one attempt');

  bot.inventory.items = () => [{ name: 'oak_planks', count: 10 }]; // now holds enough
  const crafted = await c.weaponStep(goal, {});
  assert.equal(crafted.action.item, 'wooden_sword');
  assert.equal(armed, true);

  assert.match(index, /if \(goal\.survivalPriorityItem === "weapon"\) \{\s+await runWeaponGoal/,
    'goalTick actually dispatches a weapon-tagged goal to the dedicated runner, not the freeform planner');
});


await check('Resource-gathering override: toolStep -- a chest first, else gatherPlanks + craft a pickaxe', async () => {
  // 2026-10-13: extends weaponStep's own fix to tooling (direct report: "combat seems better,
  // but building and tooling do not" -- live evidence was Nell's "craft wooden_pickaxe" throwing
  // a raw "Error: missing ingredient" and Mark/Wade producing long, rambling self-talk that never
  // converged). Same shape, same deliberately narrow scope (a pickaxe specifically, crafted from
  // scratch, never waiting on a teammate's spare).
  let calls = []; let toolInHand = false;
  const bot = { inventory: { items: () => [] }, findBlocks: () => [], blockAt: () => ({ name: 'oak_log' }),
    registry: { blocksByName: {} } };
  const performAction = async (b, action) => {
    calls.push(action);
    if (action.type === 'loot') return { ok: false, text: 'nothing in any chest' };
    if (action.type === 'craft' && action.item === 'wooden_pickaxe') { toolInHand = true; return { ok: true, text: 'crafted a wooden_pickaxe' }; }
    return { ok: true, text: 'did it' };
  };
  const c = vm.createContext({ bot, USERNAME: 'Nell',
    heldCount: (test) => bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    performAction });
  vm.runInContext(between(index, 'async function gatherPlanks(', 'async function bedStep('), c);

  bot.inventory.items = () => [{ name: 'wooden_pickaxe', count: 1 }];
  const done = await c.toolStep({}, {});
  assert.equal(done.done, true, 'already has a pickaxe -- immediately done');
  assert.equal(calls.length, 0, 'no action taken when already equipped');
  bot.inventory.items = () => [];

  const goal = {};
  bot.findBlocks = () => [{ x: 1, y: 64, z: 1 }]; // a tree, for gatherPlanks' own fallback
  const first = await c.toolStep(goal, {});
  assert.equal(goal.triedToolChest, true, 'the chest check ran exactly once');
  assert.equal(first.action.type, 'mine');
  assert.equal(calls.filter((a) => a.type === 'loot').length, 1);
  assert.equal(calls.at(-1).count, 3, 'ceil(9/4) logs -- 5 planks for the pickaxe, 4 more for her own table');

  const second = await c.toolStep(goal, {}); // chest already tried -- never retried
  assert.equal(second.action.type, 'mine');
  assert.equal(calls.filter((a) => a.type === 'loot').length, 1, 'still just the one attempt');

  bot.inventory.items = () => [{ name: 'oak_planks', count: 10 }]; // now holds enough
  const crafted = await c.toolStep(goal, {});
  assert.equal(crafted.action.item, 'wooden_pickaxe');
  assert.equal(toolInHand, true);

  assert.match(index, /if \(goal\.farmTask === "tool"\) \{\s+await runToolGoal/,
    'goalTick actually dispatches a tool-tagged goal to the dedicated runner, not the freeform planner');
  assert.match(index, /const TOOL_WORDS = \/\\bpickaxe\\b\/i;/,
    'routed by a text match on "pickaxe" specifically');
});


await check('Builder placement: a successful crafting_table/furnace/chest/beehive placement registers a RAG note', async () => {
  // 2026-10-27 (direct request: "all resources, including buildable resources, should be
  // registered to the RAG"): runBuilderPlacement() is the one function Fix 1's own checklist
  // dispatch uses for crafting_table/furnace/chest/beehive -- covers all four for free.
  const bot = makeBot(); bot.chat = () => {}; bot.spawnPoint = { x: 5, y: 64, z: 5 };
  bot.inventory = { items: () => [{ name: 'chest', count: 1 }], slots: [] }; // in hand: placed, not made (2026-11-04)
  const goal = { description: 'go home and place a chest there', builderPriorityItem: 'chest',
    consecutiveFailures: 0, log: [], steps: 0 };
  const notes = [];
  const c = goalTickContext(bot, { currentGoal: goal,
    performAction: async () => ({ ok: true, text: 'placed a chest at home.' }),
    builderPriorityItemSatisfied: () => true,
    broadcastGoalState: async () => {}, recordGoalOutcome() {}, releaseBuilderItem: async () => {},
    narrateAction: async (t) => t,
    writeMemoryNote: async (note) => { notes.push(note); } });
  await c.runBuilderPlacement(goal, async () => true, () => ({ release() {} }), () => false);
  assert.equal(notes.length, 1, 'one RAG note written on a successful placement');
  assert.equal(notes[0].scope, 'world');
  assert.match(notes[0].text, /Built a chest near \(5, 64, 5\)/);
});


// Farming and ranching (2026-09-25).
await check('Food: loot "food" asks chests for every edible item; "seeds" for anything plantable', async () => {
  const c = vm.createContext({ FOOD_NAMES: ['bread', 'carrot'] });
  // actions.js 3.0.0: LOOT_GROUPS stays in actions.js (it reads FOOD_NAMES at load), its seeds in action-world.js.
  vm.runInContext(between(actions, 'const SEED_NAMES', '// Verified achievements') + between(actions, 'const LOOT_GROUPS', '\n'), c);
  const groups = vm.runInContext('LOOT_GROUPS', c);
  assert.deepEqual([...groups.food], ['bread', 'carrot']);
  assert.deepEqual([...groups.seeds], ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds']);
  assert.match(actionHandlerSrc, /: LOOT_GROUPS\[action\.item\]; \/\/ "food", "seeds"/);
  assert.match(actionHandlerSrc, /const wantedNames = group \|\| gearCategoryNames\(bot, action\.item\);/);
});


await check('Food: a hungry bot with nothing to eat fetches food from a chest, then eats', async () => {
  const w = hungerWorld({ lootGives: 'bread' });
  await w.c.checkHunger();
  assert.deepEqual(w.calls, ['loot:food', 'eat']);
});


await check('Food: starving with no food in any chest, she hunts; with nothing to hunt, rotten flesh', async () => {
  // 2026-10-30: Babs sat at food 0 for hours, retrying the same empty chests every five minutes.
  const hunter = hungerWorld({ food: 0, huntGives: 'beef' });
  await hunter.c.checkHunger();
  assert.deepEqual(hunter.calls, ['loot:food', 'hunt', 'eat'], 'empty chests: hunt, then eat what she caught');
  const peckish = hungerWorld({ food: 12, huntGives: 'beef' });
  await peckish.c.checkHunger();
  assert.deepEqual(peckish.calls, ['loot:food'], 'not critical: no herd spent on a snack');
  const flesh = hungerWorld({ food: 2, items: [{ name: 'rotten_flesh', count: 3 }] });
  await flesh.c.checkHunger();
  assert.deepEqual(flesh.calls, ['loot:food', 'hunt', 'eat:lastResort'], 'nothing to hunt: rotten flesh, as a last resort');
  await flesh.c.checkHunger();
  assert.deepEqual(flesh.calls.slice(3), ['eat:lastResort'], 'while the fetch backs off, still the rotten flesh');
});


await check('Farm goals: with empty chests, the hoe\'s planks come from a tree and the seeds from grass', async () => {
  // 2026-11-01: a chest was the only source of either, and every chest near home was empty.
  const tree = { name: 'oak_log', position: new V3(5, 64, 5) };
  const w = farmGoalWorld([
    { ok: false, text: "don't have a hoe", missing: 'hoe' },
    { ok: false, text: 'no hoe in any chest' },
    { ok: true, text: 'mined 2 oak_log.' },
    { ok: false, text: "don't have a hoe", missing: 'hoe' },
  ], undefined, [], [tree]);
  await w.tick();
  assert.deepEqual(w.calls.map((a) => a.type + (a.item ? `:${a.item}` : '') + (a.block ? `:${a.block}` : '')),
    ['harvest', 'loot:wooden_hoe', 'mine:oak_log', 'harvest'], 'no planks and no logs: a tree');
  assert.equal(w.goal.consecutiveFailures, 0, 'a supply step that worked is progress, not a failure');
  const seeds = farmGoalWorld([
    { ok: false, text: "don't have any seeds", missing: 'seeds' },
    { ok: false, text: 'no seeds in any chest' },
    { ok: true, text: 'gathered 3 wheat seeds from the grass.' },
    { ok: true, text: 'started a farm plot', planted: 3, plot: { x: 1, y: 64, z: 1 } },
  ]);
  await seeds.tick();
  assert.deepEqual(seeds.calls.map((a) => a.type), ['harvest', 'loot', 'gather_seeds', 'harvest']);
});


await check('Inventory: full with no chest at home, she makes and places one; only plain surplus is ever dropped', async () => {
  // 2026-10-30: Babs at 36/36 slots with no chest anywhere -- store failed, crafted bed planks had
  // no slot, mining logs failed. Operator's call: build a chest; drop rotten flesh only to bootstrap.
  // 2026-11-04: widened to junkToDrop() (spare weapons/tables, extra seeds) -- checked on its own below.
  const calls = [], tossed = [];
  const c = vm.createContext({ USERNAME: 'Babs', INVENTORY_MAIN_HOTBAR_SLOTS: 36, inv: [],
    bot: { inventory: { items: () => c.inv }, toss: async (type, meta, count) => { tossed.push([type, count]); },
      tossStack: async (item) => { tossed.push([item.type, item.count]); } },
    heldCount: (test) => c.inv.filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    gatherPlanks: async (_h, count) => (c.inv.some((i) => i.name === 'birch_planks' && i.count >= count) ? null
      : { ok: true, text: 'mined a log.', action: { type: 'mine' } }),
    performAction: async (_b, action) => { calls.push(action); return { ok: true, text: action.type }; } });
  vm.runInContext(between(index, 'async function makeHomeChest(', 'async function checkInventoryFull('), c);
  const filler = (n) => Array.from({ length: n }, (_, k) => ({ name: `junk${k}`, count: 1 }));

  c.inv = [...filler(33), { name: 'rotten_flesh', type: 900, count: 64 }, { name: 'rotten_flesh', type: 900, count: 7 },
    { name: 'spruce_planks', count: 2 }];
  let r = await c.makeHomeChest(null);
  assert.deepEqual(tossed, [[900, 64], [900, 7]], 'every rotten flesh stack, nothing else');
  assert.equal(calls.length, 0, 'no other action that step');
  assert.match(r.text, /dropped 71 rotten_flesh/);

  tossed.length = 0;
  c.inv = [...filler(35), { name: 'bone', count: 34 }];
  r = await c.makeHomeChest(null);
  assert.equal(r.ok, false, 'full, no wood, nothing on the surplus list: nothing dropped');
  assert.equal(tossed.length, 0);

  c.inv = [...filler(35), { name: 'rotten_flesh', type: 900, count: 9 }, { name: 'oak_log', count: 1 }];
  r = await c.makeHomeChest(null);
  assert.equal(tossed.length, 0, 'full but holding a log: no drop, she makes planks from it');
  assert.equal(r.action.type, 'mine', 'gatherPlanks is asked for the 8 planks');

  c.inv = [...filler(10), { name: 'birch_planks', count: 8 }];
  await c.makeHomeChest(null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { type: 'craft', item: 'chest', count: 1 }, '8 planks of one wood: craft the chest');

  c.inv = [...filler(10), { name: 'chest', count: 1 }];
  await c.makeHomeChest(null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { type: 'place_home', item: 'chest' }, 'holding a chest: put it down at home');

  const full = between(index, 'async function checkInventoryFull(', 'const TRASH_CHECK_MS');
  assert.match(full, /countUsableNearHome\(\["chest"\]\) < 1[\s\S]*makeHomeChest\(handle\)/,
    'the full-inventory check makes a chest when there is no usable one at home');
});


await check('Ranch goals: chicken feed comes from grass when no chest has any', async () => {
  const calls = [];
  const pen = { center: new V3(20, 64, 20), gate: new V3(20, 64, 22) };
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Amy', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, spawnPoint: new V3(0, 64, 0), inventory: { items: () => [] }, registry: { blocksByName: {} }, findBlocks: () => [],
      entities: { 1: { name: 'chicken', position: new V3(21, 64, 20) }, 2: { name: 'chicken', position: new V3(22, 64, 20) } } },
    Vec3: V3, performAction: async (_b, action) => { calls.push(action.type + (action.item ? `:${action.item}` : '')); return { ok: false, text: 'none' }; },
    farmStatus: () => ({ ripe: 0, growing: 0 }), narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async () => {}, retireGoal: async () => {}, saveGoalIfCurrent: async () => {},
    logStep: () => {}, loadPenLocation: async () => pen, LIVESTOCK: ['chicken'], BREEDING_FOOD: { chicken: ['wheat_seeds'] },
    countInPen: () => 0, findPenSite: () => null });
  vm.runInContext(farmGoalSrc(), c);
  await c.ranchStep({}, null);
  assert.deepEqual(calls, ['loot:wheat_seeds', 'gather_seeds']);
});


await check('Access: a block over a chest lid, in a doorway, or on the last way up to a bed is refused', async () => {
  const c = shelter();
  const w = blockWorld();
  w.place([0, 64, 0], 'chest');
  w.place([3, 64, 0], 'barrel');
  const lid = c.wouldBlockAccess(w.bot, new V3(0, 65, 0));
  assert(lid && lid.fixture === 'chest' && /lid/.test(lid.reason), `the chest lid is refused: ${JSON.stringify(lid)}`);
  assert.equal(c.wouldBlockAccess(w.bot, new V3(3, 65, 0)), null, 'a barrel opens with a block above it');

  w.door([0, 64, 6]);
  const through = c.wouldBlockAccess(w.bot, new V3(0, 64, 5));
  assert(through && /way through/.test(through.reason), `in front of the door: ${JSON.stringify(through)}`);
  assert(c.wouldBlockAccess(w.bot, new V3(0, 65, 7)), 'the far side at head height counts too');
  assert.equal(c.wouldBlockAccess(w.bot, new V3(1, 64, 6)), null, "the door's own jamb is supposed to be solid");

  w.bed([10, 64, 0]);
  const around = [[11, 64, 0], [9, 64, 0], [10, 64, 1], [11, 64, -1], [9, 64, -1], [10, 64, -2]];
  assert.equal(c.wouldBlockAccess(w.bot, new V3(11, 64, 0)), null, 'plenty of room round the bed still');
  for (const cell of around.slice(0, 5)) w.place(cell, 'cobblestone');
  const last = c.wouldBlockAccess(w.bot, new V3(10, 64, -2));
  assert(last && /_bed$/.test(last.fixture) && /last way/.test(last.reason), `the last way up: ${JSON.stringify(last)}`);
});


await check('Access: the obstruction scan finds a blocked lid and both halves of a double chest', async () => {
  const c = shelter();
  const w = blockWorld();
  w.place([0, 64, 0], 'chest', { type: 'left', facing: 'north' });
  w.place([1, 64, 0], 'chest', { type: 'right', facing: 'north' });
  w.place([1, 65, 0], 'cobblestone'); // over the far half -- blocks the whole double chest in vanilla
  const found = c.findAccessObstructions(w.bot, new V3(0, 64, 0), 8, () => true);
  assert.equal(found.length, 1, `exactly the one block in the way: ${JSON.stringify(found)}`);
  assert.deepEqual([found[0].position.x, found[0].position.y, found[0].position.z], [1, 65, 0]);
  assert.equal(found[0].name, 'cobblestone');
  w.place([0, 65, 0], 'furnace'); // a fixture: never dug out to reach another fixture
  const policy = c.findAccessObstructions(w.bot, new V3(0, 64, 0), 8, (name) => name !== 'furnace');
  // Spread first: an array built inside the vm context has that context's Array prototype, which
  // deepStrictEqual rejects even when the contents match.
  assert.deepEqual([...policy].map((f) => f.name), ['cobblestone'], "the caller's own no-break policy is honoured");
});


await check('Mine: a chest holding fewer than needed is taken, and the shortfall is still mined', async () => {
  // Real bug found live 2026-10-13 (direct report: "building and tooling do not [work]"). Babs's
  // own weapon-acquisition loop (weaponStep/gatherPlanks, index.js) asked "mine" for more logs
  // than a nearby chest actually had. The old code treated ANY truthy chest match -- even a
  // partial one -- as fully satisfying the request and returned immediately: she looped for 20+
  // minutes on "found 1 ... already in a chest, no need to mine it" (wanted more) followed by a
  // craft that needed the full count and failed every single time, never once mining the
  // shortfall herself.
  const bot = makeBot();
  bot.entity = { position: new V3(5, 64, 5) };
  bot.registry = { blocks: { 1: { name: 'oak_log' } } };
  bot.blockAt = (p) => ({ name: 'oak_log', position: p, harvestTools: null });
  bot.findBlocks = () => [new V3(8, 64, 8)];
  const collected = [];
  bot.collectBlock = { collect: async (blocks) => collected.push(...blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`)), cancelTask() {} };
  const extras = { Vec3: V3, resolveBlockFamily: () => [1], itemNamesForMinedBlocks: () => ['oak_log'],
    tryTakeFromNearbyChest: async () => ({ name: 'oak_log', count: 1 }), visitRememberedSpot: async () => [],
    wanderAndRetryFind: async () => [], filterAwayFromOtherBots: (b, p) => p,
    isProtectedBlockName: () => false, MINE_SEARCH_RADIUS: 32, CONTENTION_SEARCH_OVERFETCH: 3,
    isLivingSpaceWall: () => false };
  const c = context(bot, extras);
  vm.runInContext(timeoutFn + actionFn, c);

  const result = await c.performAction(bot, { type: 'mine', block: 'oak_log', count: 2 }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(collected, ['8,64,8'], 'mined exactly the shortfall (1), not the full original count of 2');
  assert.match(result.text, /took 1 oak_log from a chest and collected some oak_log/, result.text);

  // Regression guard: a chest that fully covers the request still short-circuits, same as before
  // this fix -- no wasted trip to a tree when the chest already had enough.
  collected.length = 0;
  c.tryTakeFromNearbyChest = async () => ({ name: 'oak_log', count: 2 });
  const full = await c.performAction(bot, { type: 'mine', block: 'oak_log', count: 2 }, 'test');
  assert.equal(full.ok, true);
  assert.deepEqual(collected, [], 'a fully-sufficient chest match still skips mining entirely');
  assert.match(full.text, /found 2 oak_log already in a chest, no need to mine it/, full.text);
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
