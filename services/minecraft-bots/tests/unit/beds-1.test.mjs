// Version: 1.1.0
//
// 1.1.0 (2026-11-10): slices read the split modules (actions/*.js via actionCases/actionHandlerSrc, the modules out of index.js via index/indexOnly), and sandboxes stub guardedInterval.
//
// Unit checks: beds and sleeping (part 1 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/beds-1.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actionCases, actionHandlerSrc, actions, index, swim, V3, between, context, shelter, sleep, check, longterm, bedWorld, farmGoalSrc, bedFns, bedSiteWorld, shelterFns, room, slice, passedCount } from './_harness.mjs';


await check('Survival (Tier 1): weapon, then her own sheltered bed, then food, then armor, then null', async () => {
  const slots = []; let weapon = false, ownShelter = false, food = false, rod = false;
  let held = [], shelters = [];
  const bot = { food: 20, inventory: { slots, items: () => held }, blockAt: () => ({ name: 'dirt' }) };
  // 2026-10-28: the tool and shelter upgrade items sit at the bottom of the ladder (see below).
  // 2026-11-04: the shelter item is the residence plan now (residencePlan, stubbed here by ownShelter).
  const c = vm.createContext({ Date, bot, hasWeapon: () => weapon, hasOwnShelterWithBed: () => ownShelter,
    residencePlan: () => ({ kind: ownShelter ? 'done' : 'build', beds: 0, active: 1 }), residenceDirective: () => 'build a shelter',
    hasFood: () => food, hasRod: () => rod, HUNGER_THRESHOLD: 18, foodFetchBlockedUntil: Infinity,
    TOOL_NAME: /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe)$/,
    countUsableNearHome: () => 0, completeSheltersNearHome: () => shelters, shelterHasBed: () => true,
    shelterGeometryPositions: (base) => [base], isCommunalShelterMaterial: (n) => n === 'cobblestone',
    hasPickaxe: () => held.some((i) => i.name.endsWith('_pickaxe')) });
  vm.runInContext(between(index, 'function nextSurvivalPriority(', 'function survivalPriorityItemSatisfied('), c);
  assert.equal(c.nextSurvivalPriority().name, 'weapon', 'no weapon beats everything else');
  weapon = true;
  assert.equal(c.nextSurvivalPriority().name, 'shelter', 'armed, but no sheltered bed of her own yet');
  ownShelter = true;
  bot.food = 10; // < HUNGER_THRESHOLD, no food, no rod, and the reactive fetch already backed off
  assert.equal(c.nextSurvivalPriority().name, 'food', 'sheltered, but trending toward starvation');
  food = true;
  assert.equal(c.nextSurvivalPriority().name, 'armor', 'fed, but no armor at all');
  for (const s of [5, 6, 7, 8]) slots[s] = { name: 'iron_helmet' };
  // 2026-11-04: no pickaxe at all is a tools upgrade too -- a wooden one (it used to fall through).
  assert.match(c.nextSurvivalPriority()?.directive ?? '', /wooden pickaxe/, 'armored, but no pickaxe: a wooden one');
  assert.equal(c.nextSurvivalPriority(), null, 'every Tier 1 baseline met (tools on its timer) -- falls through to role work');
  vm.runInContext('toolUpgradeRetryAt = 0', c);
  held = [{ name: 'wooden_pickaxe', count: 1 }];
  assert.equal(c.nextSurvivalPriority().name, 'tools', 'a pickaxe she can mine stone with: upgrade tools next');
  assert.equal(c.nextSurvivalPriority(), null, 'and not again until its retry timer runs out');
  shelters = [{ x: 0, y: 65, z: 0 }];
  assert.equal(c.nextSurvivalPriority().name, 'shelter_upgrade', 'a bedded dirt shelter gets reinforced, last of all');
  assert.equal(c.nextSurvivalPriority(), null, 'also behind its own retry timer');
  held = []; shelters = [];
  // The food item only escalates to a real goal once the reactive chore has already tried and
  // backed off -- not the instant food drops, which would just duplicate what that chore (running
  // every 15s) is already doing.
  for (const s of [5, 6, 7, 8]) slots[s] = null;
  food = false; bot.food = 10;
  vm.runInContext('foodFetchBlockedUntil = 0; survivalArmorRetryAt = 0', c);
  assert.equal(c.nextSurvivalPriority().name, 'armor', 'low on food, but the reactive chore has not even tried yet -- not escalated');
});


await check('Tier 2: builderPriorityCandidates merges beds+shelter, and claims the way the others do', async () => {
  const bedNames = []; let shelterCount = 0; let beehive = 0; let bred = false;
  let ironTools = false; let communalDone = false;
  const usableUtility = { crafting_table: 1, furnace: 1, chest: 1 };
  // 2026-11-04: the shelter target is the bots in the game (all three here), and the item is only
  // hers while she has no shelter of her own.
  const c = vm.createContext({ bot: { registry: { blocksByName: {} }, players: { amy: {}, babs: {}, mark: {} } },
    hasOwnShelterWithBed: () => false,
    residencePlan: () => (shelterCount >= 3 ? { kind: 'done', beds: 3, active: 3 } : { kind: 'build', beds: shelterCount, active: 3 }),
    residenceDirective: (plan) => `our residences have ${plan.beds} beds for ${plan.active} active bots`,
    countNearHome: (names) => (names[0] === 'beehive' ? beehive : 0),
    // 2026-10-27: crafting_table/furnace/chest now go through countUsableNearHome (real
    // interaction outcomes, isUtilityUsable in actions.js), not bare countNearHome -- this slice
    // doesn't include that function's own definition, so it's stubbed here same as every other
    // cross-module function this context already injects.
    countUsableNearHome: (names) => usableUtility[names[0]],
    countQualifyingSheltersNearHome: () => shelterCount, getAchievements: () => (bred ? ['bred:cow'] : []),
    fleetHasReachedIronTools: () => ironTools, communalShelterSatisfied: () => communalDone,
    communalShelterTargetBeds: () => 4,
    BOT_USERNAMES: new Set(['amy', 'babs', 'mark']) });
  vm.runInContext(between(index, 'function builderPriorityCandidates(', 'function nextBuilderPriority('), c);
  const names = () => c.builderPriorityCandidates().map((x) => x.name);
  assert(!names().includes('crafting_table') && !names().includes('furnace') && !names().includes('chest'),
    'all three usable -- none are candidates');
  // Real bug found live, 2026-10-27: these used to be bare countNearHome() existence checks --
  // once a block existed anywhere near home it counted as "done" forever, even after it was
  // proven unreachable/unusable by real interaction failures. Now a demonstrably-broken one
  // (isUtilityUsable says no) re-opens the item instead of staying silently "satisfied."
  usableUtility.chest = 0;
  assert(names().includes('chest'), 're-opens once the only known chest is unusable');
  usableUtility.chest = 1;
  assert(!names().includes('chest'), 'closes again once a usable one exists');
  usableUtility.furnace = 0;
  assert(names().includes('furnace'), 'same re-opening for furnace');
  usableUtility.furnace = 1;
  usableUtility.crafting_table = 0;
  assert(names().includes('crafting_table'), 'same re-opening for crafting_table');
  usableUtility.crafting_table = 1;
  assert(names().includes('shelter_capacity'), 'merged item present when short');
  assert(!names().includes('beds') && !names().includes('shelter'), 'the old separate items are gone');
  const capacityItem = c.builderPriorityCandidates().find((x) => x.name === 'shelter_capacity');
  assert.match(capacityItem.directive, /have 0 beds for 3 active bots/);
  shelterCount = 3;
  assert(!names().includes('shelter_capacity'), 'baseline met -- drops off the list');
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a): additive, not blocking on the rest, but
  // gated on the fleet actually having reached iron tools -- and last in the list either way.
  assert(!names().includes('communal_shelter'), 'no iron tools yet -- not even a candidate');
  ironTools = true;
  assert.equal(names().at(-1), 'communal_shelter', 'unlocked, and last in priority order');
  const communalItem = c.builderPriorityCandidates().find((x) => x.name === 'communal_shelter');
  assert.match(communalItem.directive, /at least 4 beds/);
  communalDone = true;
  assert(!names().includes('communal_shelter'), 'already satisfied -- drops off the list');
});


await check('Beds: sleep tries every usable bed nearest-first, with no claim ever written', async () => {
  const w = bedWorld({ standAt: new V3(0, 64, 5) });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0); w.addBed(12, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['3,64,0'], 'nearest bed, by its head, first try');
});


await check('Beds: an occupied bed is skipped and the next nearest is tried', async () => {
  const w = bedWorld({ standAt: new V3(0, 64, 5), occupied: [new V3(2, 64, 0)] });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0); w.addBed(12, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['3,64,0', '7,64,0'], 'the occupied nearest bed, then the next nearest, which works');
});


await check('Beds: an occupied nearest bed is skipped, and every further bed is still tried (no cap at 3)', async () => {
  const w = bedWorld({ standAt: new V3(0, 64, 5), occupied: [new V3(2, 64, 0), new V3(6, 64, 0), new V3(10, 64, 0)] });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0); w.addBed(10, 64, 0); w.addBed(20, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['3,64,0', '7,64,0', '11,64,0', '21,64,0'], 'all four tried in distance order, 3-candidate cap gone');
});


await check('Beds: every nearby bed occupied fails with the exact text checkSleep pattern-matches', async () => {
  const w = bedWorld({ standAt: new V3(0, 64, 5), occupied: [new V3(2, 64, 0), new V3(6, 64, 0)] });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, false);
  assert.equal(result.text, 'found beds nearby, but couldn\'t use any of them.',
    'index.js checkSleep() regex-matches this exact string to decide whether to self-propose a bed goal');
});


await check('Beds: no bed anywhere fails with the exact text checkSleep pattern-matches', async () => {
  const w = bedWorld();
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, false);
  assert.equal(result.text, "couldn't find a bed nearby.");
});


await check('Beds: nothing nearby falls back to a remembered bed, and travels to use it', async () => {
  // 2026-10-27 (direct request: "seeking out a bed should not be limited to 'nearby'... if it's
  // a known resource that can be reached, they should use it to sleep"): same local-then-
  // remembered pattern mine/craft already use for crafting_table/furnace.
  const w = bedWorld({ standAt: new V3(0, 64, 5), rememberedBed: { x: 100, y: 64, z: 0 } });
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['101,64,0'], 'the remembered bed, only visible after "travelling" there');
});


await check('Beds: "bed" is crafted in the colour she has 3 wool of, white when she has none', async () => {
  const c = bedFns();
  const inv = (items) => ({ inventory: { items: () => items } });
  assert.equal(c.bedItemFor(inv([])), 'white_bed');
  assert.equal(c.bedItemFor(inv([{ name: 'red_wool', count: 2 }, { name: 'blue_wool', count: 4 }])), 'blue_bed');
  assert.equal(c.bedItemFor(inv([{ name: 'red_wool', count: 2 }, { name: 'red_wool', count: 1 }])), 'red_bed', 'stacks add up');
  assert.match(actionHandlerSrc, /if \(action\.item === "bed" \|\| action\.item === "beds"\) action = \{ \.\.\.action, item: bedItemFor\(bot\) \};/);
  assert.match(actionHandlerSrc, /const group = action\.item === "wool"/, 'loot "wool" takes any colour');
  const craftCase = actionCases.slice(actionCases.indexOf('case "craft": {'), actionCases.indexOf('case "loot": {') > actionCases.indexOf('case "craft": {') ? actionCases.indexOf('case "loot": {') : undefined);
  // Searched from the make step: "here" (2026-10-30) places a carried table earlier in the case too.
  const makeTable = craftCase.indexOf('{ type: "craft", item: "crafting_table", count: 1 }');
  const placeTable = craftCase.indexOf('{ type: "place", item: "crafting_table" }', makeTable);
  const giveUp = craftCase.indexOf('need a crafting table nearby for');
  assert(makeTable > 0 && makeTable < placeTable && placeTable < giveUp, 'no table around: make one and set it down before giving up');
});


await check('Beds: a bed spot is two open, supported cells with room to stand behind, off spawn, beside other beds', async () => {
  const c = bedFns();
  const home = new V3(0, 64, 0);
  const site = c.findBedSite(bedSiteWorld(), home);
  assert(Math.max(Math.abs(site.foot.x), Math.abs(site.foot.z)) >= 2, 'not on the spawn spot');
  const dir = [site.head.x - site.foot.x, site.head.z - site.foot.z];
  assert.deepEqual([site.stand.x - site.foot.x, site.stand.z - site.foot.z], [0 - dir[0] + 0, 0 - dir[1] + 0], 'she stands behind the foot');
  const near = c.findBedSite(bedSiteWorld({ beds: [new V3(6, 64, 6), new V3(7, 64, 6)] }), home);
  assert(Math.min(near.foot.distanceTo(new V3(6, 64, 6)), near.foot.distanceTo(new V3(7, 64, 6))) <= 1.5, `next to the other beds: ${near.foot}`);
  const doorAt = new V3(2, 64, 0);
  const byDoor = c.findBedSite(bedSiteWorld({ doors: [doorAt] }), home);
  for (const cell of [byDoor.foot, byDoor.head]) assert(cell.distanceTo(doorAt) > 1, 'never beside a door');
});


await check('Beds: bed goals are recognised; going to bed and bedrock are not', async () => {
  const c = vm.createContext({ setInterval() {}, guardedInterval() {}, Date });
  vm.runInContext(farmGoalSrc(), c);
  assert.equal(c.farmTaskFor('go home and set up more beds there -- we have 0, need at least 9'), 'bed');
  assert.equal(c.farmTaskFor('Amy, craft a bed and store your gear in a chest'), 'bed');
  assert.equal(c.farmTaskFor('make myself a bed and place it at home'), 'bed');
  assert.equal(c.farmTaskFor('go to bed, it is late'), null);
  assert.equal(c.farmTaskFor('mine down to bedrock'), null);
  assert.equal(c.farmTaskFor('breed two cows'), 'ranch', 'breed is not bed');
});


await check('Beds: a bed goal loots wool once, gets the rest from sheep, makes planks from her logs, crafts, places, then is done', async () => {
  const inv = [{ name: 'oak_log', count: 4 }];
  const calls = []; const done = [];
  const performAction = async (b, action) => {
    calls.push(action.type + (action.item ? `:${action.item}` : ''));
    if (action.type === 'loot') return { ok: false, text: 'no wool in any chest' };
    if (action.type === 'get_wool') { inv.push({ name: 'white_wool', count: 3 }); return { ok: true, text: 'gathered wool' }; }
    if (action.type === 'craft' && action.item.endsWith('_planks')) { inv.push({ name: action.item, count: action.count }); return { ok: true, text: 'crafted planks' }; }
    if (action.type === 'craft') { inv.splice(0, inv.length, { name: action.item, count: 1 }); return { ok: true, text: 'crafted' }; }
    if (action.type === 'place_bed') return { ok: true, text: 'placed a white_bed at home.', bedAt: { x: 3, y: 64, z: 0 } };
    return { ok: false, text: '?' };
  };
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Amy', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, inventory: { items: () => inv }, entities: {}, registry: { blocksByName: { crafting_table: { id: 1 } } },
      findBlocks: () => [] }, Vec3: V3, performAction,
    farmStatus: () => ({ ripe: 0, growing: 0 }), narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async (status) => { done.push(status); }, retireGoal: async () => {}, saveGoalIfCurrent: async () => {},
    logStep: () => {}, loadPenLocation: async () => null, LIVESTOCK: [], BREEDING_FOOD: {}, countInPen: () => 0, findPenSite: () => null,
    woolCounts: (b) => Object.fromEntries(b.inventory.items().filter((i) => i.name.endsWith('_wool')).map((i) => [i.name.slice(0, -5), i.count])),
    bedItemFor: () => 'white_bed',
    // 2026-10-27: runBedGoal now registers a RAG note on completion (writeMemoryNote,
    // longterm.js) -- this slice starts after that import, so it has to be stubbed here same as
    // every other cross-module function this context already injects.
    writeMemoryNote: async () => {}, PERSONA_NAME: 'amy' });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { description: 'make myself a bed and place it at home', createdAt: Date.now(), consecutiveFailures: 0 };
  for (let i = 0; i < 8 && !done.length; i++) await c.runBedGoal(goal, async () => true, () => ({ release() {} }), () => false);
  assert.deepEqual(calls, ['loot:wool', 'get_wool', 'craft:oak_planks', 'craft:white_bed', 'place_bed'],
    'no table nearby: 7 planks from her logs before the bed');
  assert.deepEqual(done, ['done']);
});


await check('Beds: a bed in hand builds at home when near, but on the spot when far from both home and any remembered bed', async () => {
  // 2026-10-27 (direct request: "if exploring, and far away from a known bed listed in world
  // resources, they should try to build a new one"): place_bed already supports an arbitrary
  // action.near (added for the communal shelter) -- bedStep now points it at her own current
  // position instead of forcing a long trip home, once she's genuinely far from both.
  let lastAction = null;
  const performAction = async (b, action) => { lastAction = action; return { ok: true, text: 'placed a bed.', bedAt: { x: 1, y: 64, z: 1 } }; };
  const invBed = { items: () => [{ name: 'white_bed', count: 1 }] };
  const makeCtx = (bot, findRememberedLocation) => {
    const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Amy',
      bot, performAction, woolCounts: () => ({}), BUILDER_PRIORITY_RADIUS: 24, findRememberedLocation });
    vm.runInContext(farmGoalSrc(), c);
    return c;
  };
  // Near home: default behaviour, unchanged -- no action.near at all, findRememberedLocation
  // never even consulted.
  const near = makeCtx({ inventory: invBed, spawnPoint: new V3(0, 64, 0), entity: { position: new V3(5, 64, 0) } },
    async () => { throw new Error('should not be consulted when already near home'); });
  await near.bedStep({}, {});
  assert.equal(lastAction.type, 'place_bed');
  assert.equal(lastAction.near, undefined, 'near home -- goes home as before, no explicit near');

  // Far from home, and no remembered bed either: builds right where she is.
  const far = makeCtx({ inventory: invBed, spawnPoint: new V3(0, 64, 0), entity: { position: new V3(100, 64, 0) } },
    async () => null);
  await far.bedStep({}, {});
  // Field-by-field, not assert.deepEqual on the whole object: lastAction.near was built by code
  // running inside a separate vm.Context (farmGoalSrc()'s own realm), so its object literal has
  // that realm's Object.prototype, not this test file's -- deepStrictEqual (what the strict
  // assert module's deepEqual actually is) fails on that cross-realm identity mismatch even
  // though the own-enumerable values are identical and print identically.
  assert.equal(lastAction.near.x, 100, 'far from everything -- builds where she is (x)');
  assert.equal(lastAction.near.y, 64, 'far from everything -- builds where she is (y)');
  assert.equal(lastAction.near.z, 0, 'far from everything -- builds where she is (z)');

  // Far from home, but a remembered bed is close to her CURRENT position: the "far from
  // everything" trigger doesn't fire, so the default (home) still applies.
  const nearRemembered = makeCtx({ inventory: invBed, spawnPoint: new V3(0, 64, 0), entity: { position: new V3(100, 64, 0) } },
    async () => ({ x: 105, y: 64, z: 0 }));
  await nearRemembered.bedStep({}, {});
  assert.equal(lastAction.near, undefined, 'a nearby remembered bed means she is not "far from everything" -- default applies');
});


await check('Beds: a night with no bed gives an idle bot a bed goal for the morning, and never replaces a goal', async () => {
  assert.match(index, /\/couldn't find a bed\/\.test\(result\.text\) \|\|\s+\(\/found beds nearby, but couldn't use any\/\.test\(result\.text\) && bedsNearHome\(\) < BOT_USERNAMES\.size\)\)\) await wantBed\(\);/,
    'no bed at all, or none free while home has fewer beds than bots');
  const saved = []; const c = vm.createContext({ console: { log() {} }, Date, USERNAME: 'Amy', PERSONA_NAME: 'amy',
    newGoal: (g) => ({ ...g }), saveGoal: async (p, g) => { saved.push(g.description); }, broadcastGoalState: async () => {},
    currentGoal: null, SELF_PROPOSE_GOALS: true, selfProposeResumeAt: 0, IDLE_BEFORE_SELF_GOAL_MS: 600_000,
    lastActivityAt: Date.now() - 60_000 });
  vm.runInContext('var currentGoal = this.currentGoal;' + between(index, 'const BED_GOAL', 'async function bedStep(') +
    between(index, 'async function wantBed(', 'async function goalTick('), c);
  await c.wantBed();
  assert.deepEqual(saved, [], 'a player spoke a minute ago (e.g. STOP): not yet');
  c.lastActivityAt = Date.now() - 11 * 60_000;
  await c.wantBed();
  assert.deepEqual(saved, ['make myself a bed and place it at home']);
  assert.equal(vm.runInContext('currentGoal.farmTask', c), 'bed');
  await c.wantBed();
  assert.equal(saved.length, 1, 'an existing goal is left alone');
});


await check('Communal shelter: structure completeness and bed-count verification, mocked', async () => {
  const s = shelterFns();
  const base = new V3(0, 64, 0);
  const width = 5, depth = 5;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const communalMockBot = (doorAt, bedCells) => {
    const solid = new Set(s.communalShelterPositions(base, width, depth).map(key));
    const doors = new Set(doorAt ? [key(doorAt)] : []);
    const beds = new Set((bedCells || []).map(key));
    return { spawnPoint: base, isABed: (b) => b?.name === 'white_bed',
      blockAt: (p) => (beds.has(key(p)) ? { name: 'white_bed', boundingBox: 'block' }
        : doors.has(key(p)) ? { name: 'oak_door', boundingBox: 'empty', getProperties: () => ({ half: 'lower', facing: 'south' }) }
        : { name: 'x', boundingBox: solid.has(key(p)) ? 'block' : 'empty' }) };
  };
  const check2 = (bot) => {
    const h = vm.createContext({ bot, Math, BOT_USERNAMES: new Set(['amy']), BUILDER_PRIORITY_RADIUS: 6,
      communalShelterPositions: s.communalShelterPositions, communalDoorwayPosition: s.communalDoorwayPosition });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') + between(actions, 'export function isShelterDoor(', 'export function shelterPositions(') +
      between(index, 'const TOOL_NAME', 'function nextSurvivalPriority('), h);
    return h;
  };
  const doorPos = s.communalDoorwayPosition(base, depth);
  const noBeds = check2(communalMockBot(doorPos, []));
  assert.equal(noBeds.hasCommunalShelterStructure(), true, 'walls/roof/floor/door complete');
  assert.equal(noBeds.communalShelterSatisfied(), false, 'no beds yet -- not satisfied');
  const oneBed = check2(communalMockBot(doorPos, [base.offset(0, 0, 0), base.offset(1, 0, 0)]));
  assert.equal(oneBed.communalShelterBedCount(base, width, depth), 1);
  assert.equal(oneBed.communalShelterSatisfied(), false, '1 bed, need 2 (N+1 for a 1-bot fleet)');
  const bedCells2 = [base.offset(0, 0, 0), base.offset(1, 0, 0), base.offset(0, 0, 1), base.offset(1, 0, 1)];
  const twoBeds = check2(communalMockBot(doorPos, bedCells2));
  assert.equal(twoBeds.communalShelterBedCount(base, width, depth), 2);
  assert.equal(twoBeds.communalShelterSatisfied(), true, '2 beds meets the target');
  const noDoor = check2(communalMockBot(null, bedCells2));
  assert.equal(noDoor.hasCommunalShelterStructure(), false, 'no real door -- not complete, regardless of beds');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
