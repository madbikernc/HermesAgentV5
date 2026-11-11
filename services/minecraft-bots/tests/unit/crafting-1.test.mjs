// Version: 1.0.0
//
// Unit checks: crafting, tools, torches and gear (part 1 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/crafting-1.test.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, equipment, between, actionFn, timeoutFn, makeBot, context, shelterConst, passed, check, passedCount } from './_harness.mjs';


await check('MB-07 armor selection keeps better worn armor and converges', async () => {
  const slots = []; slots[5] = { name: 'netherite_helmet' };
  let equips = 0;
  const bot = { inventory: { items: () => [{ name: 'leather_helmet' }], slots },
    getEquipmentDestSlot: (s) => ({ head: 5, torso: 6, legs: 7, feet: 8 })[s],
    async equip() { equips++; } };
  const c = vm.createContext({ console });
  vm.runInContext(between(equipment, 'const MATERIAL_TIER', 'export const WEAPON_SUFFIXES') +
    between(equipment, 'export async function equipBestArmor(', 'export async function equipBestWeapon('), c);
  await c.equipBestArmor(bot); await c.equipBestArmor(bot);
  assert.equal(equips, 0);
  slots[5] = { name: 'leather_helmet' }; bot.inventory.items = () => [{ name: 'iron_helmet' }];
  await c.equipBestArmor(bot); assert.equal(equips, 1, 'a strictly better carried piece is equipped');
});


await check('EFF gear refresh does nothing when no gear changed', async () => {
  let equips = 0;
  const bot = { inventory: { items: () => [{ name: 'iron_sword', durabilityUsed: 3 }], slots: [] }, heldItem: { name: 'iron_sword' } };
  const c = vm.createContext({ console, WeakMap, JSON, equipBestArmor: async () => { equips++; }, equipBestWeapon: async () => {} });
  vm.runInContext(between(actions, 'const lastGearSignature', '\n// Rejects after `ms`'), c);
  await c.refreshGear(bot); await c.refreshGear(bot);
  assert.equal(equips, 1);
  bot.heldItem = { name: 'cod' };
  await c.refreshGear(bot);
  assert.equal(equips, 2, 'holding food again triggers a refresh');
});


await check('Resource-gathering override: gatherPlanks crafts from a held log, else mines a tree', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md -- "gathering that resource becomes her temporary
  // priority"). Extracted from bedStep's own inline fallback -- see gatherPlanks' own header for
  // why shelterStep's near-identical-LOOKING fallback (which wants ANY wall material, not
  // specifically planks) is deliberately NOT also folded into this.
  let calls = [];
  const bot = { inventory: { items: () => [] }, findBlocks: () => [], blockAt: () => ({ name: 'oak_log' }) };
  const performAction = async (b, action) => { calls.push(action); return { ok: true, text: 'did it' }; };
  const c = vm.createContext({ bot, USERNAME: 'Amy',
    heldCount: (test) => bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    performAction });
  vm.runInContext(between(index, 'async function gatherPlanks(', 'async function bedStep('), c);

  bot.inventory.items = () => [{ name: 'oak_planks', count: 10 }];
  assert.equal(await c.gatherPlanks({}, 7), null, 'already holds enough -- nothing to do');
  assert.equal(calls.length, 0);

  bot.inventory.items = () => [{ name: 'spruce_log', count: 2 }];
  const crafted = await c.gatherPlanks({}, 7);
  assert.equal(crafted.action.type, 'craft');
  assert.equal(crafted.action.item, 'spruce_planks');
  assert.deepEqual({ ...calls.at(-1) }, { type: 'craft', item: 'spruce_planks', count: 7 });

  // 2026-10-29: Babs' real pocket -- one plank each of three woods, two dark oak logs. A bed needs
  // three planks of ONE wood, so that is not "3 planks" (14,738 failed bed crafts overnight).
  calls = [];
  bot.inventory.items = () => [{ name: 'jungle_planks', count: 1 }, { name: 'spruce_planks', count: 1 },
    { name: 'birch_planks', count: 1 }, { name: 'dark_oak_log', count: 2 }];
  const mixed = await c.gatherPlanks({}, 3);
  assert.notEqual(mixed, null, 'three planks of three different woods are not three planks');
  assert.equal(calls.at(-1).item, 'dark_oak_planks', 'her logs become planks of one wood');
  assert.equal(calls.at(-1).count, 3);
  calls = [];
  bot.inventory.items = () => [{ name: 'dark_oak_log', count: 2 }];
  await c.gatherPlanks({}, 10);
  assert.equal(calls.at(-1).count, 8, 'never more planks than her logs make -- that failed the whole craft');

  calls = [];
  bot.inventory.items = () => [];
  bot.findBlocks = () => [{ x: 5, y: 64, z: 5 }];
  bot.blockAt = () => ({ name: 'birch_log' });
  const mined = await c.gatherPlanks({}, 8);
  assert.equal(mined.action.type, 'mine');
  assert.equal(mined.action.block, 'birch_log');
  assert.equal(calls.at(-1).count, 2, 'ceil(8/4) logs -- each gives ~4 planks');

  // 2026-11-05 (fresh world): no tree within 32 blocks of spawn -- every bot's first goal failed
  // "no tree nearby" 60+ times. "mine" goes looking (a remembered spot, then a wandering search).
  calls = [];
  bot.findBlocks = () => [];
  const far = await c.gatherPlanks({}, 8);
  assert.deepEqual({ ...calls.at(-1) }, { type: 'mine', block: 'oak_log', count: 2 }, 'no tree in sight: she goes looking for one');
  assert.equal(far.ok, true);
  c.performAction = async (b, action) => { calls.push(action); return { ok: false, text: "couldn't find any oak_log nearby, even after looking around." }; };
  const stuck = await c.gatherPlanks({}, 8);
  assert.equal(stuck.ok, false);
  assert.equal(stuck.noWood, true, 'still none after looking: the failure that backs off');
  assert.match(stuck.text, /need wood: couldn't find any oak_log/);
});


await check('Resource-gathering override: TOOL_WORDS never collides with weaponStep\'s own "sword or axe" text', async () => {
  // The whole reason TOOL_WORDS is anchored on "pickaxe" and never bare "axe": weaponStep's own
  // directive ("you have no sword or axe -- get one before anything else...") mentions an axe
  // too, and farmTaskFor is checked for EVERY goal regardless of source -- a bare-axe match would
  // have silently stolen every weapon goal into the tool runner instead.
  // `const` at script top level never becomes a context property (unlike `var`/function
  // declarations) -- same trick shelterConst() above uses: the extracted script's own last
  // expression statement is what vm.runInContext returns.
  const toolWords = vm.runInContext(between(index, 'const TOOL_WORDS', 'function farmTaskFor(') + 'TOOL_WORDS', vm.createContext({}));
  assert.equal(toolWords.test('you have no sword or axe -- get one before anything else.'), false,
    'the weapon directive text is not mistaken for a tool request');
  assert.equal(toolWords.test('make sure you have basic tools -- at least a pickaxe and an axe, wood or stone is fine to start.'), true,
    'the real tech-tree "basic tools" directive is recognized');
});


await check('Craft: an urgent craft ("here") puts a carried table down beside her instead of walking to a far one', async () => {
  // 2026-10-30: ten wooden-sword crafts in a row cancelled on the walk to a table.
  const src = between(actions, '    case "craft": {', '\n    case "');
  assert.match(src, /action\.here && bot\.inventory\.items\(\)\.some\(\(i\) => i\.name === "crafting_table"\) &&\s*!positions\.some\(\(p\) => p\.distanceTo\(bot\.entity\.position\) <= 4\)\)/,
    'a carried table and none within 4 blocks');
  assert(src.indexOf('action.here') < src.indexOf('bot.pathfinder.goto(new goals.GoalNear(tableBlock.position.x'),
    'decided before any walk to a table');
  assert.match(between(index, 'async function weaponStep(', 'async function runWeaponGoal('),
    /type: "craft", item: "wooden_sword", count: 1, here: true/, 'the weapon goal crafts here');
});


await check('Enchants: the 1.21 component shape becomes [{ name, lvl }], so digging with enchanted gear works', async () => {
  const c = vm.createContext({ Object });
  vm.runInContext(between(equipment, 'function normalizeEnchants(', 'function loadEquipmentPlugins('), c);
  const registry = { enchantments: { 33: { name: 'sharpness' }, 40: { name: 'unbreaking' } } };
  const raw = { enchantments: [{ id: 33, level: 5 }, { id: 40, level: 3 }] }; // captured live from the server
  assert.deepEqual(c.normalizeEnchants(raw, registry).map((e) => ({ ...e })), [{ name: 'sharpness', lvl: 5 }, { name: 'unbreaking', lvl: 3 }]);
  assert.deepEqual(c.normalizeEnchants([], registry).length, 0);
  class Item { get enchants() { return raw; } }
  const bot = new EventEmitter();
  Object.assign(bot, { registry, inventory: { slots: [null, new Item()] } });
  c.installEnchantsFix(bot); c.installEnchantsFix(bot); // idempotent
  const held = new Item().enchants;
  assert(Array.isArray(held)); assert.equal([].concat(held).length, 2, 'what digTime does with it');
});


await check('Craft: a table-needing recipe is detected even with empty hands, so she searches for/uses a real one instead of guessing', async () => {
  // Real bug found live 2026-10-09 (direct report: bots "repeatedly complain about crafting
  // tables" without ever trying to make one, noticing two standing right next to them, or
  // remembering either's location). recipesFor() filters to recipes she can afford RIGHT NOW --
  // with no planks/sticks on hand it returns nothing for either a no-table or a with-table
  // lookup, so the old tableWouldHelp check (built on recipesFor) always said "no" regardless of
  // what the item's real recipe needs, and the whole search/remember/auto-make-and-place block
  // below it never ran. This reproduces that exact starting state (empty inventory, a real
  // crafting table standing 5 blocks away) against the full "craft" case, not just craftItem().
  const ITEM = { oak_planks: 41, stick: 946, wooden_pickaxe: 827 };
  const PICKAXE_RECIPE = { delta: [{ id: ITEM.stick, count: -2 }, { id: ITEM.oak_planks, count: -3 },
    { id: ITEM.wooden_pickaxe, count: 1 }] };
  const findBlocksCalls = [];
  let gotoCalls = 0;
  const bot = makeBot();
  Object.assign(bot, {
    registry: {
      itemsByName: { wooden_pickaxe: { id: ITEM.wooden_pickaxe } },
      items: { [ITEM.oak_planks]: { name: 'oak_planks' }, [ITEM.stick]: { name: 'stick' } },
      blocksByName: { crafting_table: { id: 10 } },
    },
    inventory: { items: () => [], count: () => 0, slots: [] },
    // Affordable right now only -- what recipesFor really does; empty hands means empty either way.
    recipesFor: () => [],
    recipesAll: (id, _m, table) => (id === ITEM.wooden_pickaxe && table ? [PICKAXE_RECIPE] : []),
    findBlocks: (opts) => { findBlocksCalls.push(opts); return opts.matching === 10 ? [{ x: 5, y: 64, z: 5 }] : []; },
    blockAt: (pos) => ({ position: pos, name: 'crafting_table' }),
    craft: async () => {},
  });
  bot.pathfinder.goto = async () => { gotoCalls++; };
  const c = context(bot, { gearCategoryNames: () => [], tryTakeFromNearbyChest: async () => null,
    visitRememberedSpot: async () => [] });
  vm.runInContext(timeoutFn + actionFn + between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);

  const result = await c.performAction(bot, { type: 'craft', item: 'wooden_pickaxe', count: 1 }, 'test');
  assert.equal(findBlocksCalls.filter((o) => o.matching === 10).length, 1,
    'should search nearby for an existing crafting table instead of skipping straight to "no ingredients"');
  assert.equal(gotoCalls, 1, 'and actually walk to the one it found');
  assert.equal(result.ok, false);
  assert.equal(result.text, "couldn't craft wooden_pickaxe: don't have the ingredients",
    'a real table was found and used, so the failure should name the actual problem (no planks), not guess at the table');
});


await check('Craft: a table requirement is detected even when a DIFFERENT, unusable no-table recipe also exists', async () => {
  // First live run of the check above (2026-10-09) found a second, narrower real bug the mocked
  // version couldn't have caught: a colored bed has a real no-table RECYCLING recipe (dye + a
  // different-colour bed) alongside its real wool+planks shaped recipe (which DOES need a
  // table). "!noTableRecipes.length" treated the mere EXISTENCE of that unrelated, unusable
  // no-table recipe as proof no table was needed at all -- skipping the search even though she
  // can't actually use that recipe (no spare bed, no dye). Confirmed live: "craft red_bed" from
  // wool+planks failed in ~150ms, the same instant-failure signature as the original bug. The
  // real question is whether a table unlocks MORE recipes than she has without one, not whether
  // every recipe happens to need one.
  const ITEM = { red_bed: 1100 };
  const NO_TABLE_RECIPE = { delta: [] }; // stand-in for the real dye-recolor recipe
  const WOOL_PLANKS_RECIPE = { delta: [] }; // stand-in for the real shaped recipe
  const findBlocksCalls = [];
  const bot = makeBot();
  Object.assign(bot, {
    registry: { itemsByName: { red_bed: { id: ITEM.red_bed } }, items: {}, blocksByName: { crafting_table: { id: 10 } } },
    inventory: { items: () => [], count: () => 0, slots: [] },
    recipesFor: () => [],
    recipesAll: (id, _m, table) => (id !== ITEM.red_bed ? [] : table ? [NO_TABLE_RECIPE, WOOL_PLANKS_RECIPE] : [NO_TABLE_RECIPE]),
    findBlocks: (opts) => { findBlocksCalls.push(opts); return opts.matching === 10 ? [{ x: 5, y: 64, z: 5 }] : []; },
    blockAt: (pos) => ({ position: pos, name: 'crafting_table' }),
    craft: async () => {},
  });
  bot.pathfinder.goto = async () => {};
  const c = context(bot, { gearCategoryNames: () => [], tryTakeFromNearbyChest: async () => null,
    visitRememberedSpot: async () => [] });
  vm.runInContext(timeoutFn + actionFn + between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);

  await c.performAction(bot, { type: 'craft', item: 'red_bed', count: 1 }, 'test');
  assert.equal(findBlocksCalls.filter((o) => o.matching === 10).length, 1,
    'an unrelated, unusable no-table recipe existing should not skip the table search');
});


await check('Craft: a reusable utility block found via remembered location skips making a duplicate', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 2 -- "not just her own immediate 32-block
  // view, before spending materials on a duplicate"). REUSABLE_UTILITY_BLOCKS' own local-only
  // check (2026-09-08) now falls back to findRememberedLocation() too, the same "nearby, then
  // remembered" pattern tableWouldHelp's own workbench search already has.
  let gotoRememberedCalls = 0;
  let localHasIt = false; // flips true only once she's actually walked to the remembered spot
  const bot = makeBot();
  Object.assign(bot, {
    registry: { itemsByName: { crafting_table: { id: 1 } }, blocksByName: { crafting_table: { id: 10 } } },
    inventory: { items: () => [], count: () => 0, slots: [] },
    findBlocks: (opts) => ((opts.matching === 10 && localHasIt) ? [{ x: 40, y: 64, z: 40 }] : []),
  });
  const c = context(bot, { gearCategoryNames: () => [], tryTakeFromNearbyChest: async () => null,
    visitRememberedSpot: async (_bot, _token, name, rescan) => {
      assert.equal(name, 'crafting_table');
      gotoRememberedCalls++; localHasIt = true;
      return rescan();
    } });
  vm.runInContext(timeoutFn + actionFn + between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);

  const result = await c.performAction(bot, { type: 'craft', item: 'crafting_table', count: 1 }, 'test');
  assert.equal(gotoRememberedCalls, 1, 'walked to the remembered spot instead of crafting a new one outright');
  assert.equal(result.ok, true);
  assert.match(result.text, /already have a crafting_table nearby/);
});


await check('Craft: finding an already-placed utility block nearby gets remembered too, not just a freshly-placed one', async () => {
  // Real bug found live 2026-10-09, same direct report as the check above: "craft"'s own
  // REUSABLE_UTILITY_BLOCKS short-circuit (actions.js) finds an existing crafting_table/furnace
  // within 32 blocks and skips making a duplicate ("already have a crafting_table nearby, no
  // need to make another") -- a real, just-confirmed position that used to just vanish, so the
  // next bot who needed one started from zero again. goalTick now reuses noteNearbyResources()
  // (the same scan/record step mine/explore/scout already trigger) for any successful "craft"
  // step on a CRAFTED_OBJECT_NAMES item, whether she made a new one or merely found one standing
  // there already.
  const calls = [];
  const c = vm.createContext({
    result: { ok: true, text: 'already have a crafting_table nearby, no need to make another.' },
    parsed: { action: { type: 'craft', item: 'crafting_table' } },
    CRAFTED_OBJECT_NAMES: ['crafting_table', 'furnace', 'chest', 'trapped_chest', 'beehive', 'bee_nest'],
    noteNearbyResources: (reason) => { calls.push(reason); return Promise.resolve(); },
    USERNAME: 'Amy', console: { log() {}, error() {} },
  });
  vm.runInContext(between(index, 'if (result.ok && parsed.action.type === "craft"',
    '// Environmental memory (direct follow-up, 2026-09-07'), c);
  assert.deepEqual(calls, ['after a successful craft'],
    'an existing crafting table found nearby during a craft attempt used to go unrecorded');
});


await check('Craft: a count is items wanted, not recipe runs', async () => {
  // 2026-10-29: craftItem passed its count straight to bot.craft(), which runs the recipe that
  // many times -- "craft 30 planks" needed 30 logs, and failed with 8.
  const runs = [];
  let made = 0;
  const c = vm.createContext({ setTimeout,
    bot: { registry: { itemsByName: { oak_planks: { id: 1 }, white_bed: { id: 2 }, torch: { id: 3 } } },
      inventory: { count: () => made },
      recipesFor: (id) => [{ result: { count: id === 1 ? 4 : id === 3 ? 4 : 1 } }],
      craft: async (recipe, count) => { runs.push(count); made += recipe.result.count * count; } },
    recipeInputs: () => null, simpleSourceFor: () => null });
  vm.runInContext(between(actions, 'async function craftItem(', 'function chestObstructed('), c);
  // 2026-11-05: one run per bot.craft() call -- mineflayer's multi-run craft read a stale inventory.
  const callsFor = async (item, n) => { runs.length = 0; await c.craftItem(c.bot, item, n, null); return runs.length; };
  assert.equal(await callsFor('oak_planks', 3), 1, '3 planks is one log');
  assert.equal(await callsFor('oak_planks', 30), 8, '30 planks is eight');
  assert.equal(await callsFor('white_bed', 1), 1, 'one bed is one');
  assert.equal(await callsFor('torch', 16), 4, '16 torches is four');
  assert(runs.every((n) => n === 1), 'every bot.craft() call is a single run');
  // A run the server never credited is made again.
  let dropped = 1;
  c.bot.craft = async (recipe, count) => { runs.push(count); if (dropped-- > 0) return; made += recipe.result.count * count; };
  assert.equal(await callsFor('torch', 16), 5, 'one run lost: a fifth, to get the 16 asked for');
});


await check('Craft: the ingredient chain makes enough for every run -- 23 fences need 16 sticks', async () => {
  // Dale and Bob, 2026-11-04: "couldn't craft birch_fence: don't have the ingredients" 20+ times each
  // with 40 planks and 2 sticks -- the chain checked one run's 2 sticks, so it never made more.
  const inv = { planks: 40, stick: 2, fence: 0 };
  const made = [];
  const affordable = (id, count) => (id === 7 ? inv.stick >= 2 * Math.ceil(count / 3) && inv.planks >= 4 * Math.ceil(count / 3)
    : inv.planks >= 2 * Math.ceil(count / 4));
  const c = vm.createContext({
    bot: { registry: { itemsByName: { birch_fence: { id: 7 }, stick: { id: 8 } }, items: { 5: { name: 'birch_planks' }, 8: { name: 'stick' } } },
      inventory: { count: (id) => (id === 8 ? inv.stick : id === 7 ? inv.fence : inv.planks) },
      recipesFor: (id, _m, count) => (affordable(id, count) ? [{ result: { count: id === 7 ? 3 : 4 } }] : []),
      recipesAll: () => [{ result: { count: 3 }, delta: [{ id: 5, count: -4 }, { id: 8, count: -2 }, { id: 7, count: 3 }] }],
      craft: async (r, runs) => { made.push([r.result.count, runs]); if (r.result.count === 4) { inv.stick += 4 * runs; inv.planks -= 2 * runs; } else inv.fence += 3 * runs; } },
    recipeInputs: (r) => r.delta.filter((d) => d.count < 0).map((d) => ({ id: d.id, count: -d.count })),
    simpleSourceFor: (_b, name) => name === 'stick', setTimeout });
  vm.runInContext(between(actions, 'async function craftItem(', 'function chestObstructed('), c);
  await c.craftItem(c.bot, 'birch_fence', 23, {});
  assert.deepEqual(made, [...Array(4).fill([4, 1]), ...Array(8).fill([3, 1])], '14 more sticks (four runs), then eight fence runs');
  assert.equal(inv.fence, 24, '23 fences asked for, 24 made');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
