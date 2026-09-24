// Version: 1.2.0
// Fix-validation checks for docs/reviews/2026-09-24-minecraft-bots-review.md. Each case is the
// matching reproduction from 2026-09-24-minecraft-bots-repro.mjs, inverted to assert the corrected
// behavior. Source-extraction harness: no Minecraft server or npm install needed.
// Run: node services/minecraft-bots/tests/remediation.test.mjs
// Revision History: 1.0.0 | 2026-09-24 | Initial checks for MB-01..MB-11 and MB-22 remediations.
// 1.1.0 | 2026-09-24 | Checks for MB-13, MB-14, MB-16, MB-17, MB-20.
// 1.2.0 | 2026-09-24 | Efficiency checks: standing guard, home-lighting backoff, storage backoff.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const actions = await readFile(root + 'actions.js', 'utf8');
const index = await readFile(root + 'index.js', 'utf8');
const equipment = await readFile(root + 'equipment.js', 'utf8');
const skills = await readFile(root + 'skills.js', 'utf8');
const arbiter = await import(pathToFileURL(root + 'arbiter.js').href);

function between(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, start);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert(to > from, end);
  return source.slice(from, to).replace(/export /g, '');
}
const actionFn = between(actions, 'const LOST_CONTROL');
const timeoutFn = between(actions, 'function withTimeout(', 'function simpleSourceFor(');

function makeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    pathfinder: { goal: null, setGoal(g) { this.goal = g; }, movements: { canDig: true } },
    pvp: { target: null, attacks: 0, stop() { this.target = null; }, attack(t) { this.attacks++; this.target = t; } },
    collectBlock: { cancelTask() {} }, stopDigging() {},
    inventory: { items: () => [], slots: [] }, entities: {}, players: {},
    getEquipmentDestSlot: () => 45,
  });
  return bot;
}
function context(bot, extras = {}) {
  return vm.createContext({ bot, console, setTimeout, clearTimeout, Promise, ...arbiter,
    ACTION_TIMEOUT_MS: 400, equipBestWeapon: async () => {}, refreshGear: async () => {},
    goals: { GoalNear: class {}, GoalFollow: class {} }, ...extras });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS: ' + name); }

await check('MB-01 attack starts combat and only claims a kill on entityDead', async () => {
  const bot = makeBot(); const target = { id: 1 }; bot.entities[1] = target;
  const c = context(bot); vm.runInContext(timeoutFn + actionFn, c);
  const pending = c.performAction(bot, { type: 'attack', target }, 'test');
  await sleep(50);
  assert(bot.pvp.attacks >= 1, 'pvp.attack() was never called');
  bot.emit('entityDead', target); delete bot.entities[1];
  const result = await pending;
  assert.equal(result.ok, true); assert.match(result.text, /took care of it/);
  assert.equal(arbiter.isBusy(), false);
});

await check('MB-01 a target that merely unloads is not reported as a kill', async () => {
  const bot = makeBot(); const target = { id: 2 }; bot.entities[2] = target;
  const c = context(bot); vm.runInContext(timeoutFn + actionFn, c);
  const pending = c.performAction(bot, { type: 'attack', target }, 'test');
  await sleep(50); delete bot.entities[2];
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.text, /lost track/);
});

await check('MB-03 teleport-style cancelAndClear leaves no owner behind', async () => {
  const bot = makeBot(); const held = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP);
  arbiter.cancelAndClear(bot);
  assert.equal(arbiter.isBusy(), false); assert.equal(held.token.preempted, true);
  const next = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP, { waitMs: 0 });
  assert(next, 'GOAL_STEP should be acquirable after a teleport'); next.release();
});

await check('MB-02 a preempted caller cannot act under the emergency token', async () => {
  const bot = makeBot(); bot.players.test = { entity: {} };
  const old = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP);
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  const c = context(bot); vm.runInContext(timeoutFn + actionFn, c);
  const stale = await c.performAction(bot, { type: 'follow' }, 'test', old);
  assert.equal(stale.ok, false); assert.equal(stale.cancelled, true);
  const handleless = await c.performAction(bot, { type: 'follow' }, 'test');
  assert.equal(handleless.cancelled, true);
  assert.equal(bot.pathfinder.goal, null);
  assert.equal(arbiter.currentOwner(), 'HEALTH_CRITICAL'); emergency.release();
});

await check('MB-04 cancelled recovery is not success and keeps the preemptor\'s path', async () => {
  const bot = makeBot(); let rejectGoto;
  bot.pathfinder.goto = () => new Promise((_, reject) => { rejectGoto = reject; });
  const recovery = await arbiter.requestControl(bot, arbiter.OWNERS.RECOVERY);
  const c = context(bot); vm.runInContext(timeoutFn + actionFn, c);
  const pending = c.performAction(bot, { type: 'recover', position: { x: 1, y: 2, z: 3 } }, 'test', recovery);
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  bot.pathfinder.goal = 'emergency-path';
  rejectGoto(new Error('The goal was changed'));
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.cancelled, true);
  assert.equal(result.ok || !recovery.token.preempted, false, 'retry predicate should choose retry');
  assert.equal(bot.pathfinder.goal, 'emergency-path'); emergency.release();
});

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

await check('MB-08 goal parser accepts GOHOME', async () => {
  const c = vm.createContext({ console: { log() {} }, USERNAME: 'Amy' });
  vm.runInContext(between(index, 'function parseGoalStep(', 'async function planNextStep('), c);
  assert.deepEqual({ ...c.parseGoalStep('ACTION GOHOME').action }, { type: 'gohome' });
});

await check('MB-11 fallback coordinator is accepted once Mayor is unreachable', async () => {
  let classified = 0;
  const c = vm.createContext({ bot: { username: 'Amy' }, MATRIX_USER_ID: '@mc-amy:spark', USERNAME: 'Amy',
    MAYOR_USERNAME: 'Mayor', MAYOR_LIVENESS_TIMEOUT_MS: 0, lastMayorSeenAt: 0, busy: false,
    lastActivityAt: 0, setInterval() {}, Date, process: { env: {} },
    isAnotherBot: (s) => ['Mark', 'Mayor', 'Luke'].includes(s), isMayor: (s) => s === 'Mayor',
    classifyIntent: async () => { classified++; return { type: 'none' }; }, console: { log() {}, error() {} } });
  vm.runInContext('var lastMayorSeenAt = 0;' + between(index, 'const PROCESS_STARTED_AT', '// Real gap found live (2026-09-07): with no memory') +
    between(index, 'function handleIncoming(', 'bot.on("chat"'), c);
  c.handleIncoming('Mark', 'Amy, gather wood', { alreadyAddressed: false, send() {} });
  c.handleIncoming('Luke', 'Amy, gather wood', { alreadyAddressed: false, send() {} });
  await sleep(0);
  assert.equal(classified, 1, 'Mark accepted, Luke still ignored');
});

await check('MB-06 an addressed STOP is recognized without the model', async () => {
  const c = vm.createContext({ USERNAME: 'Amy', setInterval() {} });
  vm.runInContext(between(index, 'const STOP_MESSAGE', 'async function stopNow('), c);
  assert.equal(c.isAddressedStop('Amy, stop!', false), true);
  assert.equal(c.isAddressedStop('stop', true), true);
  assert.equal(c.isAddressedStop('stop', false), false, 'unaddressed shared-chat stop still goes to the classifier');
  assert.equal(c.isAddressedStop('Amy, stop by the farm later', false), false);
});

await check('MB-06 a newer player command preempts an older one at the same tier', async () => {
  const bot = makeBot();
  const first = await arbiter.requestControl(bot, arbiter.OWNERS.DIRECT_COMMAND);
  const second = await arbiter.requestControl(bot, arbiter.OWNERS.DIRECT_COMMAND, { preemptEqual: true, waitMs: 0 });
  assert(second); assert.equal(first.token.preempted, true);
  assert.equal(arbiter.cancelIfAtMost(bot, arbiter.OWNERS.DIRECT_COMMAND.priority, 'STOP'), true);
  assert.equal(arbiter.isBusy(), false);
  const drowning = await arbiter.requestControl(bot, arbiter.OWNERS.DROWNING);
  assert.equal(arbiter.cancelIfAtMost(bot, arbiter.OWNERS.DIRECT_COMMAND.priority, 'STOP'), false);
  assert.equal(drowning.token.cancelled, false); drowning.release();
});

await check('MB-04/MB-10 skill runner stops on a cancelled step', async () => {
  const c = vm.createContext({});
  vm.runInContext(between(skills, 'export async function runSkill(', 'export async function recordSkillOutcome('), c);
  const executed = [];
  const result = await c.runSkill(async (_, action) => { executed.push(action.type); return { ok: false, cancelled: true, text: 'interrupted' }; }, {},
    { name: 'example', steps: [{ type: 'mine' }, { type: 'craft' }] }, 'test');
  assert.deepEqual(executed, ['mine']); assert.equal(result.ok, false); assert.equal(result.cancelled, true);
});

await check('MB-05 an old goal action does not write into a replacement goal', async () => {
  const bot = makeBot(); let finish;
  const oldGoal = { description: 'old goal', servedBySkill: true, log: [], steps: 0 };
  const newGoal = { description: 'new goal', servedBySkill: true, log: [], steps: 0 };
  let cleared = 0; let saved = 0;
  const c = vm.createContext({ console: { log() {}, error() {} }, bot, arbiter, busy: false,
    AUTONOMY_ENABLED: true, currentGoal: oldGoal, USERNAME: 'Amy', PERSONA_NAME: 'amy', MAX_CONSECUTIVE_FAILURES: 3,
    planNextStep: async () => 'ACTION ATTACK', parseGoalStep: () => ({ type: 'step', action: { type: 'attack' } }),
    performAction: () => new Promise(resolve => { finish = resolve; }),
    logStep: (goal, line) => { goal.log.push(line); goal.steps++; },
    goalPausedForNight: () => false,
    saveGoal: async () => { saved++; }, clearGoal: async () => { cleared++; } });
  vm.runInContext('var currentGoal = this.currentGoal;' + between(index, 'async function retireGoal(', 'setInterval(() => {\n  goalTick()'), c);
  const pending = c.goalTick();
  while (!finish) await sleep(1);
  vm.runInContext('currentGoal = this.newGoal', Object.assign(c, { newGoal }));
  finish({ ok: true, text: 'old work result' }); await pending;
  assert.equal(newGoal.steps, 0); assert.equal(newGoal.log.length, 0);
  assert.equal(cleared, 0); assert.equal(saved, 0);
});

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

await check('MB-20 curriculum stages need every requirement, tier-aware', async () => {
  const c = vm.createContext({});
  vm.runInContext(between(index, 'const withTiers', '\nconst CURRICULUM_FILE'), c);
  const [tools, armor, , iron] = vm.runInContext('TECH_TREE_STAGES', c);
  assert.equal(c.stageSatisfied(tools, new Set(['wooden_axe'])), false, 'an axe alone is not "pickaxe and axe"');
  assert.equal(c.stageSatisfied(tools, new Set(['wooden_axe', 'stone_pickaxe'])), true);
  assert.equal(c.stageSatisfied(iron, new Set(['iron_sword'])), false, 'a sword alone is not "full iron armor and a sword"');
  assert.equal(c.stageSatisfied(iron, new Set(['iron_helmet', 'diamond_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword'])), true);
  assert.equal(c.stageSatisfied(armor, new Set(['leather_chestplate'])), false);
});

await check('MB-16 EXPLORE <feature> parses to scouting; plain EXPLORE still gathers', async () => {
  const c = vm.createContext({ console: { log() {} }, USERNAME: 'Wade', SCOUT_FEATURE_BLOCKS: { village: ['bell'] } });
  vm.runInContext(between(index, 'function parseGoalStep(', 'async function planNextStep('), c);
  assert.deepEqual({ ...c.parseGoalStep('ACTION EXPLORE village').action }, { type: 'explore', feature: 'village' });
  assert.deepEqual({ ...c.parseGoalStep('ACTION EXPLORE').action }, { type: 'explore' });
});

await check('MB-14 goals pause at night unless a player set them tonight', async () => {
  const now = Date.now();
  const c = vm.createContext({ Date, DUSK_START_TICK: 10000, DAWN_TICK: 23458, bot: { time: { timeOfDay: 15000 } },
    isAnotherBot: (s) => s === 'Mayor' });
  vm.runInContext('var nightStartedAt = ' + (now - 1000) + ';' +
    between(index, 'function isNightPhase(', 'async function checkDusk('), c);
  assert.equal(c.goalPausedForNight(null), true, 'no self-proposing at night');
  assert.equal(c.goalPausedForNight({ setBy: 'Steve', createdAt: now - 60_000 }), true, 'daytime goal pauses');
  assert.equal(c.goalPausedForNight({ setBy: 'Steve', createdAt: now }), false, 'player asked tonight');
  assert.equal(c.goalPausedForNight({ setBy: 'Mayor', createdAt: now }), true, 'Mayor assignments wait');
  c.bot.time.timeOfDay = 2000;
  assert.equal(c.goalPausedForNight({ setBy: 'Steve', createdAt: 0 }), false, 'daytime resumes');
});

await check('MB-13 exactly one claimant wins a give request', async () => {
  const winners = [];
  for (const me of ['Bob', 'Amy', 'Nell']) {
    const c = vm.createContext({ Date, console: { log() {} }, USERNAME: me, pendingGiveRequest: null,
      giveClaims: new Map([['mc-babs:7', { request: { forPlayer: 'Babs', item: 'oak_log', count: 2 },
        claimants: new Set(['Bob', 'Amy', 'Nell']), decideAt: 0 }]]),
      canSpareForRequest: () => true, GIVE_REQUEST_TTL_MS: 1000 });
    vm.runInContext('var pendingGiveRequest = null;' + between(index, 'function settleGiveClaims(', '\n// Shared by planNextStep'), c);
    c.settleGiveClaims();
    if (vm.runInContext('pendingGiveRequest', c)) winners.push(me);
  }
  assert.deepEqual(winners, ['Amy']);
});

await check('EFF guard duty is a standing goal: no planner, back to post, ends on a new priority', async () => {
  const bot = makeBot(); const moves = []; let retired = 0;
  bot.spawnPoint = { x: 0, y: 64, z: 0 };
  bot.entity = { position: { distanceTo: () => 30 } };
  const goal = { description: 'stand guard', standing: 'guard' };
  let priority = 'guard';
  const c = vm.createContext({ bot, console: { log() {} }, USERNAME: 'Mark', currentGoal: goal,
    nextSoldierPriority: () => ({ name: priority }), recordGoalOutcome() {}, broadcastGoalState: async () => {},
    retireGoal: async () => { retired++; },
    performAction: async (_, a) => { moves.push(a.type); return { ok: true, text: 'home' }; } });
  vm.runInContext('var currentGoal = this.currentGoal;' + between(index, 'const GUARD_RADIUS', 'function holdsItem('), c);
  await c.guardTick(goal, async () => true, () => ({}));
  assert.deepEqual(moves, ['gohome']); assert.equal(retired, 0);
  bot.entity.position.distanceTo = () => 3;
  await c.guardTick(goal, async () => true, () => ({}));
  assert.deepEqual(moves, ['gohome'], 'already at post -- nothing to do');
  priority = 'weapon';
  await c.guardTick(goal, async () => true, () => ({}));
  assert.equal(retired, 1);
});

await check('EFF home lighting backs off exponentially and only runs on the maintainer', async () => {
  let attempts = 0; let outcome = false;
  const src = between(index, 'const HOME_LIGHTING_MAX_BACKOFF_MS', 'async function lightHomeOnce(');
  const c = vm.createContext({ Date, Math, HOME_LIGHTING_MAINTAINER: true, HOME_LIGHTING_CHECK_MS: 90_000,
    AUTONOMY_ENABLED: true, busy: false, arbiter: { isBusy: () => false }, bot: { isSleeping: false },
    lightHomeOnce: async () => { attempts++; return outcome; } });
  vm.runInContext(src, c);
  await c.checkHomeLighting(); await c.checkHomeLighting();
  assert.equal(attempts, 1, 'second call waits out the backoff');
  const wait = vm.runInContext('homeLightingNextAt', c) - Date.now();
  assert(wait > 170_000 && wait <= 180_000, `first backoff ~180s, got ${wait}`);
  vm.runInContext('homeLightingNextAt = 0', c); outcome = true; await c.checkHomeLighting();
  assert.equal(vm.runInContext('homeLightingFailures', c), 0);
  const off = vm.createContext({ ...c, HOME_LIGHTING_MAINTAINER: false, lightHomeOnce: async () => { attempts++; return true; } });
  vm.runInContext(src, off); await off.checkHomeLighting();
  assert.equal(attempts, 2, 'non-maintainers never try');
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

console.log(`${passed} remediation checks passed.`);
