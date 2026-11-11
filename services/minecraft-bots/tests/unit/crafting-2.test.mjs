// Version: 1.0.0
//
// Unit checks: crafting, tools, torches and gear (part 2 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/crafting-2.test.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, V3, between, sleep, check, BLOCK_ID, blockWorld, tunnel, passedCount } from './_harness.mjs';


await check('Tool upgrades: stone once she can mine it, iron once she can smelt, all five tools', async () => {
  // Direct request, 2026-10-28: tools evolve wood -> stone (any pickaxe) -> iron (stone pickaxe +
  // a usable furnace near home), pickaxe/axe/sword/shovel/hoe.
  let inv = [], furnace = 0;
  const c = vm.createContext({ bot: { inventory: { items: () => inv } }, countUsableNearHome: () => furnace });
  vm.runInContext(between(index, 'const TOOL_NAME', 'function isIronOrBetterTool(') +
    between(index, 'const UPGRADE_TOOLS', 'function ownBeddedShelter('), c);
  const has = (...names) => { inv = names.map((name) => ({ name, count: 1 })); };
  has();
  // 2026-11-04: was null ("the plain wooden-pickaxe goal comes first") -- but that goal is only ever
  // Mayor-assigned, so a bot without one never got a pickaxe. The wooden one is the upgrade now.
  assert.equal(c.nextToolUpgrade(), 'wooden_pickaxe', 'no pickaxe at all: a wooden one first');
  has('wooden_pickaxe', 'wooden_sword');
  assert.equal(c.nextToolUpgrade(), 'stone_pickaxe', 'a pickaxe means stone is minable: pickaxe first');
  has('stone_pickaxe', 'wooden_sword');
  assert.equal(c.nextToolUpgrade(), 'stone_axe', 'then the rest, missing tools included');
  has('stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'golden_hoe');
  assert.equal(c.nextToolUpgrade(), 'stone_hoe', 'a golden tool ranks with wood');
  has('stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'stone_hoe');
  assert.equal(c.nextToolUpgrade(), null, 'all stone and no furnace: nothing to do');
  furnace = 1;
  assert.equal(c.nextToolUpgrade(), 'iron_pickaxe', 'a usable furnace near home unlocks iron');
  has('wooden_pickaxe', 'stone_sword');
  assert.equal(c.nextToolUpgrade(), 'stone_pickaxe', 'iron ore needs a stone pickaxe first, furnace or not');
});


await check('Tool upgrades: the step gets the material, smelts raw iron before mining more, then crafts', async () => {
  let inv = [];
  const actions_ = [];
  const c = vm.createContext({ USERNAME: 'Babs', bot: { inventory: { items: () => inv }, registry: { blocksByName: { crafting_table: { id: 9 } } },
      findBlocks: () => [{ x: 0, y: 64, z: 0 }] },
    nextToolUpgrade: () => c.target, target: 'stone_pickaxe',
    heldCount: (test) => inv.filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    gatherPlanks: async () => null,
    performAction: async (_b, action) => { actions_.push(`${action.type}:${action.block ?? action.item}`); return { ok: true, text: 'ok' }; } });
  vm.runInContext(between(index, 'const TOOL_HEADS', 'async function runUpgradeToolsGoal('), c);
  inv = [{ name: 'cobblestone', count: 1 }];
  await c.upgradeToolsStep({}, null);
  assert.equal(actions_.at(-1), 'mine:stone', 'short of 3 cobblestone: mines stone');
  inv = [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 4 }];
  await c.upgradeToolsStep({}, null);
  assert.equal(actions_.at(-1), 'craft:stone_pickaxe');
  c.target = 'iron_sword';
  inv = [{ name: 'raw_iron', count: 5 }];
  await c.upgradeToolsStep({}, null);
  assert.equal(actions_.at(-1), 'smelt:iron_ingot', 'raw iron she holds is smelted first');
  inv = [];
  await c.upgradeToolsStep({}, null);
  assert.equal(actions_.at(-1), 'mine:iron_ore', 'nothing to smelt: mine ore');
  c.target = null;
  assert.equal((await c.upgradeToolsStep({}, null)).done, true);
  assert.match(between(index, 'goal.standing === "guard"', 'goal.farmTask === "farm"'),
    /survivalPriorityItem === "tools"[\s\S]*goal\.farmTask \?\?= farmTaskFor/,
    'routed before farmTaskFor -- "craft a stone pickaxe" would otherwise match TOOL_WORDS');
});


await check('Craft: the auto-chain works for shaped recipes too, so coal + planks makes a torch', async () => {
  // Real ids and the real recipe shapes, captured off the server 2026-10-07: a torch is SHAPED,
  // so `ingredients` is undefined and only `delta` describes what it consumes. The old code read
  // `ingredients` alone and skipped the recipe, so the stick was never crafted.
  const ITEM = { oak_planks: 41, coal: 897, stick: 946, torch: 322 };
  const byId = Object.fromEntries(Object.entries(ITEM).map(([name, id]) => [id, { name, id }]));
  const inv = { oak_planks: 8, coal: 8, stick: 0, torch: 0 };
  const crafted = [];
  const shaped = (out, ins) => ({ result: { id: ITEM[out], count: 4 },
    delta: [...ins.map(([n, c]) => ({ id: ITEM[n], count: -c })), { id: ITEM[out], count: 4 }] });
  const RECIPES = { torch: shaped('torch', [['coal', 1], ['stick', 1]]), stick: shaped('stick', [['oak_planks', 2]]) };

  const bot = {
    registry: { itemsByName: Object.fromEntries(Object.entries(ITEM).map(([n, id]) => [n, { id }])), items: byId },
    inventory: {
      items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })),
      count: (id) => inv[byId[id]?.name] ?? 0, // mineflayer's count() takes an item id, not a name
    },
    // Affordable right now only: what recipesFor really does.
    recipesFor: (id, _m, count, _t) => {
      const name = byId[id].name;
      const r = RECIPES[name];
      if (!r) return [];
      return r.delta.filter((d) => d.count < 0).every((d) => inv[byId[d.id].name] >= -d.count) ? [r] : [];
    },
    recipesAll: (id) => (RECIPES[byId[id].name] ? [RECIPES[byId[id].name]] : []),
    craft: async (recipe, count) => {
      for (const d of recipe.delta) inv[byId[d.id].name] += d.count * (count || 1);
      crafted.push(byId[recipe.result.id].name);
    },
  };
  const c = vm.createContext({ bot, console: { log() {}, error() {} }, setTimeout });
  // From simpleSourceFor so the chain's own "what makes a stick" helper comes along with it.
  vm.runInContext(between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);

  assert.deepEqual(c.recipeInputs(RECIPES.torch).map((i) => i.id).sort(), [ITEM.coal, ITEM.stick].sort(),
    'a shaped recipe\'s inputs come out of delta');
  assert.equal(c.recipeInputs({ ingredients: [{ id: 1, count: 1 }] })[0].id, 1, 'a shapeless recipe still works');
  assert.equal(c.recipeInputs({}), null, 'and a recipe with neither is skipped, not crashed on');

  await c.craftItem(bot, 'torch', 1, null);
  assert.deepEqual(crafted, ['stick', 'torch'], 'the stick was chained first, from her planks');
  assert(inv.torch >= 4, `she ended up with torches: ${inv.torch}`);
});


await check('Craft: a wooden hoe from birch planks -- the chain counts by item id, and a birch log makes no cherry planks', async () => {
  // 2026-11-01, Babs live: 4 birch planks and a birch log, "craft wooden_hoe" failed. The hoe has a
  // recipe per plank species, cherry first. The chain read count(name), always 0, so each variant
  // made more sticks; and any log counted as the source of cherry planks.
  const ITEM = { cherry_planks: 1, birch_planks: 2, birch_log: 3, cherry_log: 4, stick: 5, wooden_hoe: 6 };
  const byId = Object.fromEntries(Object.entries(ITEM).map(([name, id]) => [id, { name, id }]));
  const inv = { birch_planks: 4, birch_log: 1, stick: 0, wooden_hoe: 0, cherry_planks: 0 };
  const crafted = [];
  const recipe = (out, n, ins) => ({ result: { id: ITEM[out], count: n },
    delta: [...ins.map(([name, c]) => ({ id: ITEM[name], count: -c })), { id: ITEM[out], count: n }] });
  const RECIPES = {
    wooden_hoe: [recipe('wooden_hoe', 1, [['cherry_planks', 2], ['stick', 2]]), recipe('wooden_hoe', 1, [['birch_planks', 2], ['stick', 2]])],
    stick: [recipe('stick', 4, [['birch_planks', 2]])],
    cherry_planks: [recipe('cherry_planks', 4, [['cherry_log', 1]])],
    birch_planks: [recipe('birch_planks', 4, [['birch_log', 1]])],
  };
  const affordable = (r) => r.delta.filter((d) => d.count < 0).every((d) => (inv[byId[d.id].name] ?? 0) >= -d.count);
  const bot = {
    registry: { itemsByName: Object.fromEntries(Object.entries(ITEM).map(([n, id]) => [n, { id }])), items: byId },
    inventory: { items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })),
      count: (id) => inv[byId[id]?.name] ?? 0 },
    recipesFor: (id) => (RECIPES[byId[id].name] ?? []).filter(affordable),
    recipesAll: (id) => RECIPES[byId[id].name] ?? [],
    craft: async (r, times) => {
      for (const d of r.delta) inv[byId[d.id].name] = (inv[byId[d.id].name] ?? 0) + d.count * (times || 1);
      crafted.push(byId[r.result.id].name);
    },
  };
  const c = vm.createContext({ bot, console: { log() {}, error() {} } });
  vm.runInContext(between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);
  await c.craftItem(bot, 'wooden_hoe', 1, { name: 'crafting_table' });
  assert.deepEqual(crafted, ['stick', 'wooden_hoe'], 'one batch of sticks, then the hoe');
  assert.equal(inv.wooden_hoe, 1);
  assert.equal(inv.birch_log, 1, 'her log untouched');
});


await check("Crafting: a plank type comes only from its own wood's log", async () => {
  // 2026-11-01, Babs live: one birch log and 4 birch planks, "craft wooden_hoe" failed "don't have
  // the ingredients" -- the hoe's first recipe variant is cherry_planks, any log counted as its
  // source, and the cherry-planks sub-craft threw before the birch recipe was ever tried.
  const items = [{ name: 'birch_log', count: 1 }, { name: 'birch_planks', count: 4 }];
  const c = vm.createContext({});
  vm.runInContext(between(actions, 'function simpleSourceFor(', '// Real bug found live 2026-10-07'), c);
  const bot = { inventory: { items: () => items } };
  assert.equal(c.simpleSourceFor(bot, 'cherry_planks'), undefined, 'a birch log is no source of cherry planks');
  assert.equal(c.simpleSourceFor(bot, 'birch_planks')?.name, 'birch_log');
  items.push({ name: 'stripped_crimson_stem', count: 1 });
  assert.equal(c.simpleSourceFor(bot, 'crimson_planks')?.name, 'stripped_crimson_stem');
  assert.equal(c.simpleSourceFor(bot, 'stick')?.name, 'birch_planks', 'any planks still make sticks');
});


await check('Torches: the light test uses the registry and real blocks, never the frozen block.light', async () => {
  const c = tunnel();
  const w = blockWorld({ groundY: 40, light: 15 }); // light 15 everywhere: a gate reading it would skip
  w.place([0, 43, 0], 'deepslate'); // a roof, so she counts as under cover
  const ids = c.lightSourceBlockIds(w.bot);
  assert(ids.length >= 4, `light sources come from emitLight: ${ids.length}`);
  for (const name of ['torch', 'lantern', 'glowstone', 'lava']) assert(ids.includes(BLOCK_ID[name]), name);
  for (const name of ['candle', 'stone', 'cobblestone']) assert(!ids.includes(BLOCK_ID[name]), name);

  assert.equal(c.litNearby(w.bot, new V3(0, 41, 0)), false, 'nothing shedding light yet');
  w.place([3, 41, 0], 'torch');
  assert.equal(c.litNearby(w.bot, new V3(0, 41, 0)), true, "another bot's torch three blocks away");
  assert.equal(c.litNearby(w.bot, new V3(0, 41, 20)), false, 'and not one twenty blocks away');
});


await check('Torches: the trail fires between digs, not into one, and remembers where the last went', async () => {
  const c = tunnel();
  const w = blockWorld({ groundY: 40 });
  for (let dz = -2; dz <= 12; dz++) w.place([0, 43, dz], 'deepslate'); // roofed corridor
  const bot = new EventEmitter();
  Object.assign(bot, w.bot, { username: 'Babs', entity: { position: new V3(0.5, 41, 0.5) },
    inventory: { items: () => [{ name: 'torch', count: 4 }] }, equip: async () => {}, targetDigBlock: null });
  const placed = [];
  // Writes the torch into the world, so litNearby sees it the way it would in game.
  bot.placeBlock = async (ref, face) => {
    placed.push(`${ref.position.x},${ref.position.y},${ref.position.z}:${face.y}`);
    w.place([ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z], 'torch');
  };
  const trail = c.installTorchTrail(bot);

  bot.targetDigBlock = { name: 'stone' }; // the next dig already started
  bot.emit('diggingCompleted');
  await sleep(10);
  assert.deepEqual(placed, [], "never equips a torch while a dig is in flight -- that fights collectBlock's own tool");

  bot.targetDigBlock = null;
  bot.emit('diggingCompleted');
  await sleep(10);
  assert.deepEqual(placed, ['0,40,0:1'], 'one torch, on the floor');
  assert.deepEqual([trail.last.x, trail.last.y, trail.last.z], [0, 41, 0]);

  bot.entity.position = new V3(0.5, 41, 3.5); // three blocks on: too soon
  bot.emit('diggingCompleted');
  await sleep(10);
  assert.equal(placed.length, 1, 'spacing is kept across digs, not reset by each one');

  bot.entity.position = new V3(0.5, 41, 9.5);
  bot.emit('diggingCompleted');
  await sleep(10);
  assert.equal(placed.length, 2, 'and the next one goes down once she is clear of the last');
  trail.reset();
  assert.equal(trail.last, null);
});


await check('Tools: with no pickaxe at all, the Tier 1 upgrade is a wooden pickaxe, and stone reinforcement waits for one', async () => {
  // Babs, 2026-11-04: no pickaxe, so the "tools" item had nothing to offer and "shelter_upgrade"
  // ran instead -- ~1,140 "need a better tool for stone" a day.
  const bot = { food: 20, inventory: { items: () => [{ name: 'wooden_sword', count: 1 }], slots: { 5: {}, 6: {}, 7: {}, 8: {} } } };
  const c = vm.createContext({ bot, Date, hasWeapon: () => true, hasOwnShelterWithBed: () => true, HUNGER_THRESHOLD: 6,
    residencePlan: () => ({ kind: 'done', beds: 1, active: 1 }),
    hasFood: () => true, hasRod: () => false, foodFetchBlockedUntil: 0, shelterCellsToReface: () => [new V3(0, 64, 0)],
    hasPickaxe: () => false, countUsableNearHome: () => 0,
    TOOL_NAME: /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe)$/ });
  vm.runInContext(between(index, 'function nextSurvivalPriority', 'function ownBeddedShelter'), c);
  const pick = c.nextSurvivalPriority();
  assert.equal(pick?.name, 'tools', `got ${pick?.name}`);
  assert.match(pick.directive, /wooden pickaxe/);
  assert.equal(c.nextSurvivalPriority(), null, 'with tools on its retry timer, shelter_upgrade is not offered without a pickaxe');

  const steps = [];
  const s = vm.createContext({ bot, nextToolUpgrade: () => 'wooden_pickaxe', USERNAME: 'Babs',
    heldCount: () => 0, toolStep: async () => { steps.push('toolStep'); return { ok: true, text: 'crafted a wooden pickaxe' }; },
    performAction: async (_b, a) => { steps.push(`${a.type} ${a.block ?? a.item}`); return { ok: true, text: '' }; },
    gatherPlanks: async () => null });
  vm.runInContext(between(index, 'const TOOL_HEADS', 'async function runUpgradeToolsGoal'), s);
  await s.upgradeToolsStep({}, null);
  assert.deepEqual(steps, ['toolStep'], 'a wooden pickaxe is crafted (or looted), not iron ore mined');
});


await check('Builder: a furnace she does not hold is made -- stone mined, else a pickaxe first -- not left to the planner', async () => {
  // 2026-11-04: "go home and place a furnace there" without a furnace in hand went to the planner,
  // which answered DONE NONE (rejected) 421 times a day.
  let cobble = 0, pickaxe = true;
  const actions = [];
  const goal = { builderPriorityItem: 'furnace', description: 'go home and place a furnace there', consecutiveFailures: 0 };
  const c = vm.createContext({ bot: { registry: { blocksByName: { crafting_table: { id: 1 } } }, findBlocks: () => [new V3(0, 64, 0)] },
    console: { log() {}, error() {} }, USERNAME: 'Amy', holdsItem: () => false,
    heldCount: (t) => (t('cobblestone') ? cobble : 0), hasPickaxe: () => pickaxe,
    toolStep: async () => { actions.push('toolStep'); return { ok: true, text: 'made a pickaxe' }; },
    gatherPlanks: async () => null,
    performAction: async (_b, a) => { actions.push(`${a.type} ${a.block ?? a.item}${a.count ? ' ' + a.count : ''}`); return { ok: true, text: 'ok' }; },
    logStep() {}, saveGoalIfCurrent: async () => {}, failGoalStep: async () => {}, builderPriorityItemSatisfied: () => false,
    MAX_CONSECUTIVE_FAILURES: 20, recordGoalOutcome() {}, broadcastGoalState: async () => {}, retireGoal: async () => {},
    narrateAction: async (t) => t, writeMemoryNote: async () => {} });
  vm.runInContext(between(index, 'const HOME_PLACEABLE', 'function holdsItem('), c);
  const run = () => c.runBuilderPlacement(goal, async () => true, () => ({ release() {} }), () => false);
  await run();
  assert.deepEqual(actions, ['mine stone 8'], 'eight cobblestone mined first');
  actions.length = 0; pickaxe = false; await run();
  assert.deepEqual(actions, ['toolStep'], 'no pickaxe: that comes first');
  actions.length = 0; cobble = 8; await run();
  assert.deepEqual(actions, ['craft furnace 1'], 'with the stone, the furnace is crafted');
});


await check('Craft: a torch from coal and logs -- the stick comes by way of planks', async () => {
  // 2026-11-04: torch supply counts a log as wood, but with no planks the stick was never made.
  const ITEM = { coal: 1, stick: 2, oak_planks: 3, oak_log: 4, torch: 5 };
  const byId = Object.fromEntries(Object.entries(ITEM).map(([name, id]) => [id, { name, id }]));
  const inv = { coal: 2, oak_log: 2, stick: 0, oak_planks: 0, torch: 0 };
  const crafted = [];
  const recipe = (out, n, ins) => ({ result: { id: ITEM[out], count: n },
    delta: [...ins.map(([name, k]) => ({ id: ITEM[name], count: -k })), { id: ITEM[out], count: n }] });
  const RECIPES = { torch: [recipe('torch', 4, [['coal', 1], ['stick', 1]])], stick: [recipe('stick', 4, [['oak_planks', 2]])],
    oak_planks: [recipe('oak_planks', 4, [['oak_log', 1]])] };
  const affordable = (r) => r.delta.filter((d) => d.count < 0).every((d) => (inv[byId[d.id].name] ?? 0) >= -d.count);
  const bot = {
    registry: { itemsByName: Object.fromEntries(Object.entries(ITEM).map(([n, id]) => [n, { id }])), items: byId },
    inventory: { items: () => Object.entries(inv).filter(([, k]) => k > 0).map(([name, count]) => ({ name, count })),
      count: (id) => inv[byId[id]?.name] ?? 0 },
    recipesFor: (id) => (RECIPES[byId[id].name] ?? []).filter(affordable),
    recipesAll: (id) => RECIPES[byId[id].name] ?? [],
    craft: async (r, times) => {
      for (const d of r.delta) inv[byId[d.id].name] = (inv[byId[d.id].name] ?? 0) + d.count * (times || 1);
      crafted.push(byId[r.result.id].name);
    },
  };
  const c = vm.createContext({ bot, console: { log() {}, error() {} } });
  vm.runInContext(between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);
  await c.craftItem(bot, 'torch', 4, null);
  assert.deepEqual(crafted, ['oak_planks', 'stick', 'torch']);
  assert.equal(inv.torch, 4);
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
