// Version: 1.0.0
//
// Unit checks: farming, food and ranching.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/farming.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, arbiter, V3, between, actionFn, timeoutFn, makeBot, context, shelter, check, longterm, hungerWorld, farmGoalSrc, farmGoalWorld, passedCount } from './_harness.mjs';


await check('MB-16 EXPLORE <feature> parses to scouting; plain EXPLORE still gathers', async () => {
  const c = vm.createContext({ console: { log() {} }, USERNAME: 'Wade', SCOUT_FEATURE_BLOCKS: { village: ['bell'] } });
  vm.runInContext(between(index, 'function parseGoalStep(', 'async function planNextStep('), c);
  assert.deepEqual({ ...c.parseGoalStep('ACTION EXPLORE village').action }, { type: 'explore', feature: 'village' });
  assert.deepEqual({ ...c.parseGoalStep('ACTION EXPLORE').action }, { type: 'explore' });
});


await check('EFF a repeated memory note skips the duplicate-search process', async () => {
  let searches = 0; let writes = 0;
  const c = vm.createContext({ Date, Map, console: { log() {} },
    memWrite: async () => { writes++; }, slugify: (t) => t, ragIngest: async () => {},
    DUPLICATE_DISTANCE_THRESHOLD: 0.1, RAG_DISABLED: false, searchMemory: async () => { searches++; return []; } });
  vm.runInContext(between(longterm, 'const RECENT_NOTE_TTL_MS', 'export async function searchMemory('), c);
  await c.writeMemoryNote({ scope: 'world', persona: 'amy', text: 'Found oak_log near (1, 2, 3)' });
  await c.writeMemoryNote({ scope: 'world', persona: 'amy', text: 'Found oak_log near (4, 5, 6)' });
  assert.equal(searches, 1); assert.equal(writes, 1);
});


await check('Survival (Tier 1): survivalPriorityItemSatisfied re-checks real state, not a claim', async () => {
  // Same hallucinated-DONE guard builderPriorityItemSatisfied() already gives Builder's own
  // items (2026-09-13's beehive bug): "shelter" and "food" don't reduce to "holds item X," so a
  // model claiming either done gets re-checked against the same real condition the ladder itself
  // trusts, not taken on its word.
  const slots = []; let weapon = false, ownShelter = false, food = false;
  const c = vm.createContext({ bot: { inventory: { slots } }, hasWeapon: () => weapon,
    hasOwnShelterWithBed: () => ownShelter, residencePlan: () => ({ kind: ownShelter ? 'done' : 'bed' }), hasFood: () => food });
  vm.runInContext(between(index, 'function survivalPriorityItemSatisfied(', '\n// Real bug found live 2026-09-12'), c);
  assert.equal(c.survivalPriorityItemSatisfied('weapon'), false); weapon = true;
  assert.equal(c.survivalPriorityItemSatisfied('weapon'), true);
  assert.equal(c.survivalPriorityItemSatisfied('shelter'), false); ownShelter = true;
  assert.equal(c.survivalPriorityItemSatisfied('shelter'), true);
  assert.equal(c.survivalPriorityItemSatisfied('food'), false); food = true;
  assert.equal(c.survivalPriorityItemSatisfied('food'), true);
  assert.equal(c.survivalPriorityItemSatisfied('armor'), false, 'no armor worn at all');
  for (const s of [5, 6, 7]) slots[s] = { name: 'iron_helmet' };
  assert.equal(c.survivalPriorityItemSatisfied('armor'), false, '3 of 4 pieces is not a full set');
  slots[8] = { name: 'iron_boots' };
  assert.equal(c.survivalPriorityItemSatisfied('armor'), true);
  assert.equal(c.survivalPriorityItemSatisfied('something-unrelated'), true, 'not one of the four known items -- nothing to block on');
});


await check('MB-12 heartbeat re-announces the goal and expires silent peers', async () => {
  const sent = []; const otherBotGoals = new Map([['mc-bob', 'mine'], ['mc-nell', 'farm']]);
  const c = vm.createContext({ console: { log() {} }, USERNAME: 'Mayor', Date, otherBotGoals, setInterval() {},
    currentGoal: { description: 'coordinate' }, broadcastGoalState: (...a) => { sent.push(a); } });
  vm.runInContext('var currentGoal = this.currentGoal;' + between(index, '// goal every GOAL_HEARTBEAT_MS', 'setInterval(goalHeartbeatTick'), c);
  const now = 10_000_000;
  vm.runInContext(`otherBotGoalSeenAt.set("mc-bob", ${now - 60_000}); otherBotGoalSeenAt.set("mc-nell", ${now - 3_600_000});`, c);
  c.goalHeartbeatTick(now);
  assert.deepEqual(sent[0], ['active', 'coordinate', null, true]);
  assert.equal(otherBotGoals.has('mc-bob'), true, 'recently heard peer kept');
  assert.equal(otherBotGoals.has('mc-nell'), false, 'silent peer expired');
});


await check('Food: a failed fetch backs off instead of failing "eat" every 15 seconds', async () => {
  const w = hungerWorld();
  await w.c.checkHunger();
  assert.deepEqual(w.calls, ['loot:food'], 'no eat attempt with nothing to eat');
  await w.c.checkHunger(); await w.c.checkHunger();
  assert.deepEqual(w.calls, ['loot:food'], 'nothing at all while the fetch backs off');
  const fisher = hungerWorld({ items: [{ name: 'fishing_rod', count: 1 }] });
  await fisher.c.checkHunger();
  assert.deepEqual(fisher.calls, ['loot:food', 'fish'], 'a rod is still the fallback');
});


await check('Farm goals: farming and ranching goals are recognised; iron farms and wool are not', async () => {
  const c = vm.createContext({ setInterval() {}, Date });
  vm.runInContext(farmGoalSrc(), c);
  const t = (d) => c.farmTaskFor(d);
  assert.equal(t('start a farm and bring back some real food from it -- till ground, plant seeds'), 'farm');
  assert.equal(t('Wade, scout out some arable land, till it, and plant seeds'), 'farm');
  assert.equal(t('harvest crops for the storehouse'), 'farm');
  assert.equal(t('set up a ranch near home: build an animal pen, lead two animals of one kind into it, and breed them'), 'ranch');
  assert.equal(t('breed two cows'), 'ranch');
  assert.equal(t("I'm heading to the iron farm to check on Mark"), null);
  assert.equal(t('shear a sheep for wool'), null);
  assert.equal(t('mine iron and smelt it'), null);
});


await check('Farm goals: plant, wait while it grows (no actions), harvest when ripe, then done', async () => {
  const w = farmGoalWorld([
    { ok: true, text: 'started a farm plot by water: tilled 8, planted 8.', planted: 8, plot: { x: 5, y: 64, z: 5 } },
    { ok: true, text: 'harvested 8 wheat (8 replanted).', harvested: { wheat: 8 } },
  ]);
  await w.tick();
  assert.deepEqual(w.goal.farmPlot, { x: 5, y: 64, z: 5 }); assert.equal(w.retired.length, 0);
  w.world.status = { ripe: 0, growing: 8 };
  await w.tick(); await w.tick();
  assert.equal(w.calls.length, 1, 'no actions while it grows');
  w.world.status = { ripe: 8, growing: 0 };
  await w.tick();
  assert.deepEqual(w.calls[1], { type: 'harvest', near: { x: 5, y: 64, z: 5 } });
  assert.deepEqual(w.done, [['done', 'wheat']]); assert.equal(w.retired.length, 1);
});


await check('Farm goals: a missing hoe is fetched (loot, then craft) and the harvest retried', async () => {
  const w = farmGoalWorld([
    { ok: false, text: "don't have a hoe", missing: 'hoe' },
    { ok: false, text: 'no hoe in any chest' },
    { ok: true, text: 'crafted 1 wooden_hoe.' },
    { ok: true, text: 'started a farm plot', planted: 4, plot: { x: 1, y: 64, z: 1 } },
  ], undefined, [{ name: 'oak_planks', count: 8 }]);
  await w.tick();
  assert.deepEqual(w.calls.map((a) => a.type + (a.item ? `:${a.item}` : '')), ['harvest', 'loot:wooden_hoe', 'craft:wooden_hoe', 'harvest']);
  assert.deepEqual(w.goal.farmPlot, { x: 1, y: 64, z: 1 });
});


await check('Farm goals: holding a crop, or a DONE claim, never finishes one -- only a harvest', async () => {
  // 1400, not 900: 2026-10-12's new weapon-goal dispatch (its own header comment included) sits
  // in this same block, between farmTask routing and the "already holding the target" shortcut.
  assert.match(index, /goal\.farmTask \?\?= farmTaskFor\(goal\.description\);[\s\S]{0,1400}if \(goal\.targetItem && holdsItem\(goal\.targetItem\)\)/,
    'farm/ranch/weapon routing runs before the "already holding the target" shortcut and the skill lookup');
  const w = farmGoalWorld([{ ok: false, text: "couldn't start a farm: tilled 0, planted 0 (the grass_block didn't turn to farmland)." }]);
  await w.tick(); await w.tick(); await w.tick();
  assert.deepEqual(w.done, [['abandoned', undefined]], 'three real failures give up; nothing claims done');
});


await check('Curriculum: farming needs a harvested crop, and a stage cleared by holding food is re-earned', async () => {
  const c = vm.createContext({});
  vm.runInContext(between(index, 'const withTiers', '\nconst MEMORY_ROOT'), c);
  const farming = vm.runInContext('TECH_TREE_STAGES', c)[2];
  assert.equal(farming.name, 'farming');
  assert.equal(c.stageSatisfied(farming, new Set(['wheat', 'bread', 'carrot'])), false, 'looted food is not farming');
  assert.equal(c.stageSatisfied(farming, new Set(['harvested:carrots'])), true);
  const disk = { '/mem/mayor-curriculum.json': JSON.stringify({ stageIndex: 2, stageProgress: ['Amy', 'Babs'],
    evidence: { Amy: ['wheat', 'bread'], Babs: ['harvested:wheat'] } }) };
  const m = vm.createContext({ readFile: async (p) => disk[p], writeFile: async () => {}, mkdir: async () => {}, JSON, Object, Map, Set,
    console: { error() {} }, USERNAME: 'Mayor', BOT_ROLES: {}, ROLES: { SOLDIER: {} }, bot: { inventory: { items: () => [], slots: [] } } });
  vm.runInContext(between(index, 'const withTiers', '\nconst MEMORY_ROOT') + '\nconst MEMORY_ROOT = "/mem";' +
    between(index, 'const CURRICULUM_FILE', 'async function checkCurriculumAdvance('), m);
  await m.loadCurriculumStage();
  assert.deepEqual([...vm.runInContext('stageProgress', m)], ['Babs'], 'Amy only held food; Babs harvested');
});


await check('Pens: the site is flat, open, and 8-20 blocks from home, never home itself', async () => {
  const c = vm.createContext({ Vec3: V3 });
  vm.runInContext(between(actions, 'function findPenSite(', '// Farm plots'), c);
  const tree = new Set(['8,64,0', '8,65,0']); // something standing on the nearest spot east
  const bot = { blockAt: (p) => ({ boundingBox: p.y < 64 ? 'block' : 'empty',
    name: p.y < 64 ? 'grass_block' : (tree.has(`${p.x},${p.y},${p.z}`) ? 'oak_log' : 'air') }) };
  const site = c.findPenSite(bot, new V3(0, 64, 0));
  const dist = Math.hypot(site.x, site.z);
  assert(dist >= 8 && dist <= 20, `distance ${dist}`); assert.equal(site.y, 64);
  assert(Math.abs(site.x - 8) > 3 || Math.abs(site.z) > 3, 'the 7x7 area avoids the obstacle');
});


await check('Harvest: walks over the drops around the crops she broke, and gives up on the unreachable', async () => {
  const bot = makeBot();
  bot.entity = { position: new V3(0, 64, 0) };
  bot.entities = { 1: { name: 'item', position: new V3(3, 64, 0) }, 2: { name: 'item', position: new V3(30, 64, 0) },
    3: { name: 'cow', position: new V3(2, 64, 0) } };
  const visited = [];
  bot.pathfinder.goto = async (goal) => { visited.push(goal.x); bot.entity.position = new V3(goal.x, 64, 0); delete bot.entities[1]; };
  const c = context(bot, { Vec3: V3, goals: { GoalNear: class { constructor(x) { this.x = x; } } } });
  vm.runInContext(timeoutFn + between(actions, 'async function collectDrops(', "// What's planted near a spot"), c);
  await c.collectDrops(bot, { cancelled: false }, [new V3(2, 64, 0)], 3000);
  assert.deepEqual(visited, [3], 'only the drop near the harvested spot, once');
});


await check('Ripe crops: a failed routine harvest backs off 15 minutes; a cancelled one does not', async () => {
  const calls = []; let reply = { ok: false, text: "couldn't harvest any of the 3 ripe crops found: can't reach the one at (1, 64, 1)" };
  const bot = { isSleeping: false, entity: { position: new V3(0, 64, 0) }, spawnPoint: new V3(0, 64, 0) };
  const c = vm.createContext({ bot, Date, process: { env: {} }, console: { log() {}, error() {} }, USERNAME: 'Amy', AUTONOMY_ENABLED: true,
    farmStatus: () => ({ ripe: 3, growing: 0 }), routineBlocked: () => false,
    arbiter: { OWNERS: { ROUTINE: 1 }, requestControl: async () => ({ release() {} }) },
    performAction: async (b, a) => { calls.push(a); return reply; } });
  vm.runInContext('let lastHarvestAt = 0;' + between(index, 'const RIPE_CHECK_MS', 'setInterval(() => {'), c);
  await c.checkRipeCrops(); await c.checkRipeCrops();
  assert.equal(calls.length, 1, 'backing off after the failure');
  assert.deepEqual({ ...calls[0] }, { type: 'harvest', onlyRipe: true });
  const c2 = vm.createContext({ ...c, performAction: async (b, a) => { calls.push(a); return { ok: false, cancelled: true, text: 'stopped' }; } });
  vm.runInContext('let lastHarvestAt = 0;' + between(index, 'const RIPE_CHECK_MS', 'setInterval(() => {'), c2);
  await c2.checkRipeCrops(); await c2.checkRipeCrops();
  assert.equal(calls.length, 3, 'an interrupted harvest is retried');
  assert.match(actions, /if \(total\) await collectDrops/, 'drops are collected only after a real harvest');
});


await check('get_wool: wanders to look for a sheep instead of instant-failing when none is in range', async () => {
  // Real bug found live 2026-10-10 (direct report: bots "give up on constructed goals without
  // seeming to attempt to get the raw materials they lack"): this used to check bot.entities
  // within 32 blocks of wherever she already stood and break immediately if empty -- an instant
  // give-up, unlike "mine"/"explore"'s own wanderAndRetryFind(). Confirmed live: Mayor's bed goal
  // failed 3 times in a row, ~45s apart, each an identical ms=0 "no sheep nearby," never once
  // moving to actually look. No sheep ever appears in this test either, so the only thing being
  // checked is that she WALKED somewhere to look before giving up.
  const bot = makeBot();
  let gotoCalls = 0;
  Object.assign(bot, {
    entity: { position: new V3(0, 64, 0) },
    entities: {},
    inventory: { items: () => [], slots: [] },
  });
  bot.pathfinder.goto = async () => { gotoCalls++; };
  const c = context(bot, {
    EXPLORE_DISTANCE: 40, EXPLORE_TIMEOUT_MS: 15000, MAX_DIRECTED_HOPS: 4,
    woolCounts: () => ({}), collectDrops: async () => {},
  });
  vm.runInContext(timeoutFn + actionFn +
    between(actions, 'async function wanderAndRetryForSheep(', '// Direct request, 2026-09-07 ("build the water crossing'), c);

  const result = await c.performAction(bot, { type: 'get_wool', count: 3 }, 'test');
  assert(gotoCalls >= 1, 'should wander to look for a sheep instead of giving up on the spot');
  assert.equal(result.ok, false);
  assert.match(result.text, /even after looking around/);
});


await check('Role work: the Farmer farms and the Herder ranches on their own, not only as a stand-in', async () => {
  // Direct report, 2026-11-05: "the herder is not herding, and no-one is farming. the farm plots have
  // all reverted to grass". Nothing gave either role its own job.
  let now = 10_000_000, crops = { ripe: 0, growing: 0 }, penned = 0, pen = null;
  const ROLES = { FARMER: { name: 'Farmer' }, HERDER: { name: 'Herder' }, MINER: { name: 'Miner' } };
  const c = vm.createContext({ ROLES, Date: { now: () => now }, bot: { spawnPoint: new V3(0, 64, 0) },
    farmStatus: () => crops, loadPenLocation: async () => pen, BREEDING_FOOD: { cow: ['wheat'], sheep: ['wheat'] },
    countInPen: () => penned, myRole: { primary: ROLES.FARMER } });
  vm.runInContext(between(index, 'const ROLE_WORK_RETRY_MS', 'async function startStandInGoal('), c);
  assert.equal((await c.nextRoleWork())?.task, 'farm', 'the Farmer, nothing growing: tend the farm');
  crops = { ripe: 0, growing: 12 };
  assert.equal(await c.nextRoleWork(), null, 'crops growing, none ripe: nothing to do yet');
  crops = { ripe: 3, growing: 9 };
  assert.equal((await c.nextRoleWork())?.task, 'farm', 'something ripe: harvest it');
  vm.runInContext(`roleWorkGaveUpAt.farm = ${now}`, c);
  assert.equal(await c.nextRoleWork(), null, 'a farm goal just given up waits');
  c.myRole = { primary: ROLES.HERDER };
  assert.equal((await c.nextRoleWork())?.task, 'ranch', 'the Herder, no pen yet: ranch');
  pen = { center: new V3(10, 64, 10) }; penned = 6;
  assert.equal(await c.nextRoleWork(), null, 'six penned: the herd is up');
  c.myRole = { primary: ROLES.MINER };
  penned = 0;
  assert.equal(await c.nextRoleWork(), null, 'any other role: none');
  assert.match(between(index, 'async function proposeOwnGoal(', 'if (myRole?.primary === ROLES.SOLDIER)'),
    /nextSurvivalPriority\(\)[\s\S]*nextRoleWork\(\)[\s\S]*survival\?\.name === "shelter" && roleWork[\s\S]*builderPriorityCandidates\(\)/,
    'after Tier 1 survival -- except the fleet-wide residence item, which yields to it -- ahead of the Builder checklist');
});


await check('Stand-ins: with no Farmer in the game the food goal becomes a farm goal; no Herder, a ranch goal', async () => {
  // Direct request, 2026-11-01: "there are farmer and rancher roles. they should be universal at
  // need, when no bot with that role is in game."
  let now = 10_000_000;
  const roster = { bob: { primary: { name: 'Farmer' } }, dale: { primary: { name: 'Herder' } }, babs: { primary: { name: 'Miner' } } };
  const started = [];
  const players = { Babs: {} };
  const c = vm.createContext({ bot: { players }, USERNAME: 'Babs', myRole: null, BOT_ROLES: roster, Date: { now: () => now },
    hasFood: () => false, heldCount: () => 0, logStep() {}, console: { log() {} }, recordGoalOutcome() {},
    performAction: async () => ({ ok: false, text: 'nothing.' }), failGoalStep: async () => { throw new Error('should hand off'); },
    completeGoal: async () => {}, retireGoal: async () => {}, saveGoal: async () => {}, PERSONA_NAME: 'babs',
    newGoal: ({ description }) => ({ description }), broadcastGoalState: async (_s, d) => started.push(d) });
  vm.runInContext(between(index, 'async function foodStep(', '// Tier 1 "shelter_upgrade"'), c);
  assert.equal(c.standInRole(), 'farm', 'Bob and Dale both offline: farm first');
  players.Bob = {};
  assert.equal(c.standInRole(), 'ranch', 'Bob online, Dale not: ranch');
  players.Dale = {};
  assert.equal(c.standInRole(), null, 'both roles covered: no stand-in');
  // 2026-11-05: Bob counted as "the Farmer in the game" for Bob himself, so a hungry Farmer never farmed.
  c.myRole = roster.bob;
  assert.equal(c.standInRole(), 'farm', 'the Farmer herself, hungry with nothing to hunt: she farms');
  c.myRole = null;
  delete players.Bob; delete players.Dale;
  vm.runInContext(`standInGaveUpAt.farm = ${now - 60_000}`, c); // a script-level const, not a context property
  assert.equal(c.standInRole(), 'ranch', 'a farm stand-in that just gave up: ranch has a turn');
  now += 31 * 60_000;
  assert.equal(c.standInRole(), 'farm', 'and half an hour on, farming again');
  await c.runFoodGoal({ description: 'food' }, async () => true, () => null, () => false);
  const goal = vm.runInContext('currentGoal', c);
  assert.equal(goal.farmTask, 'farm');
  assert.equal(goal.standIn, true);
  assert.match(started[0], /no Farmer is in the game/);
  assert.match(between(index, 'const DEDICATED_RUNNER_FARM_TASKS', 'function isDedicatedRunnerGoal'), /"farm"/);
  assert.match(between(index, 'async function failGoalStep(', 'recordGoalOutcome(goal.description, "gave up"'),
    /if \(goal\.standIn\) standInGaveUpAt\[goal\.farmTask\] = Date\.now\(\)/, 'a stand-in that gives up is noted');
});


await check('Food goal: wheat she holds becomes bread', async () => {
  const calls = [];
  const c = vm.createContext({ bot: { players: {} }, USERNAME: 'Babs', myRole: null, BOT_ROLES: {}, hasFood: () => false, heldCount: () => 7,
    performAction: async (_b, action) => { calls.push(action); return { ok: true, text: 'crafted 2 bread.' }; } });
  vm.runInContext(between(index, 'async function foodStep(', 'async function runFoodGoal('), c);
  const r = await c.foodStep(null);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((a) => `${a.type}:${a.item}:${a.count}`), ['craft:bread:2'], '7 wheat: 2 bread');
});


await check('gather_seeds: breaks grass near her and picks up the seeds that drop', async () => {
  const inv = [];
  const grass = [new V3(2, 64, 0), new V3(3, 64, 0), new V3(4, 64, 0)];
  const world = new Map(grass.map((p) => [p.toString(), { type: 7, name: 'short_grass' }]));
  const dug = [];
  const c = vm.createContext({ bot: { inventory: { items: () => inv }, registry: { blocksByName: { short_grass: { id: 7 } } },
      findBlocks: () => grass, blockAt: (p) => world.get(p.toString()) ?? { type: 0, name: 'air' },
      pathfinder: { goto: async () => {}, setGoal() {} }, dig: async (b) => { dug.push(b); }, stopDigging() {}, waitForTicks: async () => {} },
    goals: { GoalNear: class {} }, withTimeout: (p) => p, ACTION_TIMEOUT_MS: 1000, SEED_GRASS: ['short_grass', 'grass'],
    GATHER_SEEDS_MAX_DIGS: 64, ok: (text) => ({ ok: true, text }), fail: (text) => ({ ok: false, text }),
    collectDrops: async () => { inv.push({ name: 'wheat_seeds', count: 1 }); } });
  const src = between(actions, '    case "gather_seeds": {', '\n    case "');
  vm.runInContext(`async function run(action, token) { switch (action.type) {${src}} }`, c);
  const r = await c.run({ type: 'gather_seeds', count: 1 }, { cancelled: false });
  assert.equal(dug.length, 3, 'all three grass blocks broken');
  assert.equal(r.ok, true, r.text);
  inv.length = 0;
  const none = vm.createContext({ ...c, bot: { ...c.bot, findBlocks: () => [] } });
  vm.runInContext(`async function run(action, token) { switch (action.type) {${src}} }`, none);
  assert.equal((await none.run({ type: 'gather_seeds' }, { cancelled: false })).ok, false, 'no grass: fails');
});


await check('Ranch goals: a species whose animals are gone is chosen again; with none at all she goes looking', async () => {
  // Direct report, 2026-11-06: "there's a pen but none of the livestock is moved to it". Dale's goal
  // stayed on chickens through 20 "no loose chicken nearby to herd" in a row.
  const calls = [];
  const pen = { center: new V3(20, 64, 20), gate: new V3(20, 64, 22) };
  let herdResult = { ok: false, text: 'no loose chicken nearby to herd.' };
  const entities = { 1: { name: 'cow', position: new V3(70, 64, 20) }, 2: { name: 'cow', position: new V3(72, 64, 20) } };
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Dale', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, spawnPoint: new V3(0, 64, 0), inventory: { items: () => [{ name: 'wheat', count: 8 }, { name: 'wheat_seeds', count: 8 }] },
      registry: { blocksByName: {} }, findBlocks: () => [], entities },
    Vec3: V3, performAction: async (_b, action) => { calls.push(action.type + (action.species ? `:${action.species}` : ''));
      return action.type === 'herd_to_pen' ? herdResult : { ok: true, text: 'looked around' }; },
    farmStatus: () => ({ ripe: 0, growing: 0 }), narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async () => {}, retireGoal: async () => {}, saveGoalIfCurrent: async () => {},
    logStep: () => {}, loadPenLocation: async () => pen, LIVESTOCK: ['chicken', 'cow'],
    BREEDING_FOOD: { chicken: ['wheat_seeds'], cow: ['wheat'] }, countInPen: () => 0, findPenSite: () => null });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { ranchSpecies: 'chicken' };
  await c.ranchStep(goal, null);
  assert.deepEqual(calls, ['herd_to_pen:chicken']);
  assert.equal(goal.ranchSpecies, null, 'the chickens are gone: choose again');
  await c.ranchStep(goal, null);
  assert.equal(calls.at(-1), 'herd_to_pen:cow', 'two cows 50 blocks from the pen are the herd now');
  for (const k of Object.keys(entities)) delete entities[k];
  goal.ranchSpecies = null;
  const step = await c.ranchStep(goal, null);
  assert.equal(calls.at(-1), 'explore', `no animals in sight: she walks out to find some -- ${step.text}`);
  assert.match(between(actions, '    case "herd_to_pen": {', '\n    case "'), /<= HERD_SEARCH_RADIUS\)/, 'herd_to_pen looks HERD_SEARCH_RADIUS out');
  assert.match(actions, /const HERD_SEARCH_RADIUS = 64;/);
});


// 2026-10-28: shelters left unfinished because flowers (not replaceable, unlike grass) sat in wall
// cells -- "Server refused to place dirt ... the block is still wildflowers", 20 times per cell.
await check('Placement: a flower in the target cell is broken first; fluids, crops, fixtures and air are left alone', async () => {
  const c = vm.createContext({ console: { error() {} }, setTimeout, clearTimeout, Promise,
    isProtectedBlockName: (n) => n.endsWith('_door') || n.endsWith('_bed') });
  vm.runInContext(timeoutFn, c); // withTimeout() through simpleSourceFor(): the placement helpers sit inside it
  const cell = (name, boundingBox = 'empty', diggable = true) => ({ name, boundingBox, diggable });
  const dug = [];
  const world = { poppy: cell('wildflowers'), air: cell('air'), water: cell('water'), wheat: cell('wheat'),
    door: cell('oak_door', 'block'), torch: cell('oak_door_like_open', 'empty', false), stone: cell('stone', 'block') };
  const bot = { username: 'Babs', blockAt: (p) => world[p], dig: async (b) => { dug.push(b.name); }, stopDigging() {} };
  for (const key of Object.keys(world)) await c.clearCellForPlacement(bot, key);
  assert.deepEqual(dug, ['wildflowers'], 'only the ground cover is dug');
  assert.equal(c.isClearableCover(cell('poppy')), true);
  assert.equal(c.isClearableCover(cell('short_grass')), true, 'grass too -- harmless, it breaks instantly');
});


await check('Mine: stone with an open face comes before buried stone, and a target that had no path is skipped next time', async () => {
  // Amy, 2026-11-04: 2,204 "No path to the goal!" a day on "mine stone" -- the nearest stone at home
  // is buried, while bare stone a few blocks out was never tried.
  const exposed = new V3(8, 64, 8);
  const stone = (p) => ({ name: 'stone', type: 1, position: p, harvestTools: null, boundingBox: 'block' });
  const bot = makeBot();
  bot.entity = { position: new V3(0, 64, 0) };
  bot.registry = { blocks: { 1: { name: 'stone' } } };
  bot.pathfinder = { ...bot.pathfinder, thinkTimeout: 1000, isMining: () => false };
  bot.blockAt = (p) => (p.x === 8 && p.y === 65 && p.z === 8 ? { name: 'air', boundingBox: 'empty', position: p } : stone(p));
  let positions = [new V3(1, 60, 1), new V3(2, 60, 2), exposed];
  bot.findBlocks = () => positions;
  const collected = [];
  let noPathAt = null;
  bot.collectBlock = { cancelTask() {}, collect: async (blocks) => {
    const at = blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`);
    collected.push(...at);
    if (noPathAt && at.includes(noPathAt)) { const e = new Error('No path to the goal!'); e.name = 'NoPath'; throw e; }
  } };
  const c = context(bot, { Vec3: V3, resolveBlockFamily: () => [1], itemNamesForMinedBlocks: () => ['cobblestone'],
    tryTakeFromNearbyChest: async () => null, visitRememberedSpot: async () => [], wanderAndRetryFind: async () => [],
    filterAwayFromOtherBots: (b, p) => p, isProtectedBlockName: () => false, MINE_SEARCH_RADIUS: 32,
    CONTENTION_SEARCH_OVERFETCH: 3, isLivingSpaceWall: () => false });
  vm.runInContext(timeoutFn + actionFn, c);
  const first = await c.performAction(bot, { type: 'mine', block: 'stone', count: 1 }, 'test');
  assert.equal(first.ok, true, first.text);
  assert.deepEqual(collected, ['8,64,8'], 'the exposed stone, not the nearer buried one');

  positions = [new V3(1, 60, 1), new V3(2, 60, 2)];
  collected.length = 0; noPathAt = '1,60,1';
  const failed = await c.performAction(bot, { type: 'mine', block: 'stone', count: 1 }, 'test');
  assert.equal(failed.ok, false);
  collected.length = 0; noPathAt = null;
  const next = await c.performAction(bot, { type: 'mine', block: 'stone', count: 1 }, 'test');
  assert.equal(next.ok, true, next.text);
  assert.deepEqual(collected, ['2,60,2'], 'the block that had no path sits out; the next one is tried');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
