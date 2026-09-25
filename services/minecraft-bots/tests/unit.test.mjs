// Version: 1.5.0
// Fix-validation checks for docs/reviews/2026-09-24-minecraft-bots-review.md. Each case is the
// matching reproduction from 2026-09-24-minecraft-bots-repro.mjs, inverted to assert the corrected
// behavior. Source-extraction harness: no Minecraft server or npm install needed.
// Run: node services/minecraft-bots/tests/unit.test.mjs  (or tests/run.sh unit)
// Revision History: 1.0.0 | 2026-09-24 | Initial checks for MB-01..MB-11 and MB-22 remediations.
// 1.1.0 | 2026-09-24 | Checks for MB-13, MB-14, MB-16, MB-17, MB-20.
// 1.2.0 | 2026-09-24 | Efficiency checks: standing guard, home-lighting backoff, storage backoff.
// 1.3.0 | 2026-09-24 | MB-11 check also asserts server echoes (Rcon) and the live-test bot are ignored.
// 1.4.0 | 2026-09-24 | Review follow-up checks: open window closed on takeover, flee movements scoping,
//   place_home, bare stop from the active commander, goal-reserved items, delivery retry/ack,
//   OUTCOME lines, chest-miss cache, gear-refresh skip, note dedupe, Soldier armor, routine skips.
// 1.5.0 | 2026-09-25 | Review acceptance checks: MB-03 rejected /tp, MB-05 replacement during skill
//   lookup and planning, MB-10 cancelled replay + 13-step authoring, MB-12 heartbeat/lease, MB-20
//   restart persistence, MB-21 router/RAG timeouts, MB-22 stationary vs wedged.
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
  const quiet = { ...console, log: (l, ...r) => { if (!String(l).includes(' OUTCOME ')) console.log(l, ...r); } };
  return vm.createContext({ bot, console: quiet, setTimeout, clearTimeout, Promise, ...arbiter,
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

await check('MB-11 fallback coordinator accepted once Mayor is unreachable; server echoes ignored', async () => {
  let classified = 0;
  const c = vm.createContext({ bot: { username: 'Amy' }, MATRIX_USER_ID: '@mc-amy:spark', USERNAME: 'Amy',
    MAYOR_USERNAME: 'Mayor', MAYOR_LIVENESS_TIMEOUT_MS: 0, lastMayorSeenAt: 0, busy: false,
    lastActivityAt: 0, setInterval() {}, Date, process: { env: {} },
    isAnotherBot: (s) => ['Mark', 'Mayor', 'Luke'].includes(s), isMayor: (s) => s === 'Mayor',
    classifyIntent: async () => { classified++; return { type: 'none' }; }, console: { log() {}, error() {} } });
  vm.runInContext('var lastMayorSeenAt = 0;' + between(index, 'const PROCESS_STARTED_AT', '// Real gap found live (2026-09-07): with no memory') +
    between(index, 'const NON_PLAYER_SPEAKERS', 'bot.on("chat"'), c);
  c.handleIncoming('Mark', 'Amy, gather wood', { alreadyAddressed: false, send() {} });
  c.handleIncoming('Luke', 'Amy, gather wood', { alreadyAddressed: false, send() {} });
  c.handleIncoming('Rcon', 'Teleported MBTester to 2000, 201, 2000', { alreadyAddressed: false, send() {} });
  c.handleIncoming('MBTester', 'Amy, stop', { alreadyAddressed: false, send() {} });
  await sleep(0);
  assert.equal(classified, 1, 'Mark accepted; Luke, the server echo (Rcon) and the live-test bot ignored');
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
    goalPausedForNight: () => false, routineBlocked: () => false,
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
  vm.runInContext(between(index, 'const withTiers', '\nconst MEMORY_ROOT'), c);
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
    AUTONOMY_ENABLED: true, busy: false, arbiter: { isBusy: () => false }, bot: { isSleeping: false }, routineBlocked: () => false,
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

// ---- 2026-09-24 follow-up: remaining gaps from the review ----------------------------------------
const longterm = await readFile(root + 'longterm.js', 'utf8');

await check('MB-02 a takeover closes the interrupted action\'s open window', async () => {
  const bot = makeBot(); let closed = 0;
  bot.currentWindow = { id: 3 }; bot.closeWindow = (w) => { closed++; bot.currentWindow = null; };
  const old = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  assert.equal(closed, 1); assert.equal(bot.currentWindow, null); assert.equal(old.token.preempted, true);
  emergency.release();
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

await check('MB-08 place_home walks home, then places the item', async () => {
  const bot = makeBot(); const steps = [];
  const pos = { x: 0, y: 64, z: 0, floored() { return this; }, offset(dx, dy, dz) { return { dx, dy, dz }; } };
  bot.spawnPoint = { x: 10, y: 64, z: 10 };
  bot.entity = { position: pos };
  bot.inventory.items = () => [{ name: 'furnace' }];
  bot.pathfinder.goto = async () => { steps.push('goto-home'); };
  bot.equip = async () => {};
  bot.blockAt = (p) => (p.dy === -1 ? { boundingBox: 'block' } : { boundingBox: 'empty' });
  bot.placeBlock = async () => { steps.push('place'); };
  const c = context(bot, { Vec3: class {}, attemptBoatCrossing: async () => false });
  vm.runInContext(timeoutFn + actionFn, c);
  const result = await c.performAction(bot, { type: 'place_home', item: 'furnace' }, 'test');
  assert.equal(result.ok, true, result.text); assert.deepEqual(steps, ['goto-home', 'place']);
  bot.inventory.items = () => [];
  const none = await c.performAction(bot, { type: 'place_home', item: 'furnace' }, 'test');
  assert.equal(none.ok, false);
});

await check('MB-06 a bare "stop" from the player whose command is running stops the bot', async () => {
  const c = vm.createContext({ USERNAME: 'Amy', setInterval() {} });
  vm.runInContext(between(index, 'const STOP_MESSAGE', 'async function stopNow('), c);
  assert.equal(c.isStopFromActiveCommander('Steve', 'stop'), false, 'no command running');
  vm.runInContext('activeDirectSpeaker = "Steve"', c);
  assert.equal(c.isStopFromActiveCommander('Steve', 'stop!'), true);
  assert.equal(c.isStopFromActiveCommander('Alex', 'stop'), false, 'a different player');
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

await check('MB-13 a failed delivery is retried once; a success is acknowledged', async () => {
  const published = []; let outcome = { ok: false, text: 'nope' };
  const c = vm.createContext({ Date, console: { log() {}, error() {} }, USERNAME: 'Bob', AUTONOMY_ENABLED: true,
    bot: { isSleeping: false }, AGENT_ID: 'mc-bob', settleGiveClaims() {}, routineBlocked: () => false,
    arbiter: { requestControl: async () => ({ release() {} }), OWNERS: { ROUTINE: {} } },
    performAction: async () => outcome, narrateAction: async (t) => t,
    buzzPublish: async (_, __, body) => { published.push(JSON.parse(body)); } });
  vm.runInContext('var pendingGiveRequest = { forPlayer: "Amy", item: "oak_log", count: 2, requestId: "r1", attempts: 0, expiresAt: Date.now() + 60000 };' +
    between(index, 'async function checkPendingGiveRequests(', 'setInterval(() => {\n  checkPendingGiveRequests'), c);
  await c.checkPendingGiveRequests();
  assert.equal(vm.runInContext('pendingGiveRequest?.attempts', c), 1, 'queued for one retry');
  await c.checkPendingGiveRequests();
  assert.equal(vm.runInContext('pendingGiveRequest', c), null, 'dropped after the retry');
  vm.runInContext('pendingGiveRequest = { forPlayer: "Amy", item: "oak_log", count: 2, requestId: "r2", attempts: 0, expiresAt: Date.now() + 60000 }', c);
  outcome = { ok: true, text: 'gave' };
  await c.checkPendingGiveRequests();
  assert.deepEqual(published.map((p) => [p.type, p.requestId, p.count]), [['delivered', 'r2', 2]]);
});

await check('MB-18 every action outcome is logged as one structured OUTCOME line', async () => {
  const lines = [];
  const bot = makeBot(); bot.username = 'Amy';
  const c = context(bot, { console: { log: (l) => lines.push(l), error() {} } });
  vm.runInContext(timeoutFn + actionFn, c);
  await c.performAction(bot, { type: 'stop' }, 'test');
  const held = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  await c.performAction(bot, { type: 'stop' }, 'test');
  held.release();
  const outcomes = lines.filter((l) => l.startsWith('[Amy] OUTCOME ')).map((l) => JSON.parse(l.slice(14)));
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].ok, true); assert.equal(outcomes[1].refused, true);
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

await check('EFF a repeated memory note skips the duplicate-search process', async () => {
  let searches = 0; let writes = 0;
  const c = vm.createContext({ Date, Map, console: { log() {} }, MEMORY_DIR: '/m', path: { join: (...p) => p.join('/') },
    mkdir: async () => {}, writeFile: async () => { writes++; }, slugify: (t) => t, runIngestCoalesced: async () => {},
    DUPLICATE_DISTANCE_THRESHOLD: 0.1, RAG_DISABLED: false, searchMemory: async () => { searches++; return []; } });
  vm.runInContext(between(longterm, 'const RECENT_NOTE_TTL_MS', 'export async function searchMemory('), c);
  await c.writeMemoryNote({ scope: 'world', persona: 'amy', text: 'Found oak_log near (1, 2, 3)' });
  await c.writeMemoryNote({ scope: 'world', persona: 'amy', text: 'Found oak_log near (4, 5, 6)' });
  assert.equal(searches, 1); assert.equal(writes, 1);
});

await check('Soldier priorities: weapon, then monster, then missing armor (rate-limited), then guard', async () => {
  const slots = []; let weapon = true; let threat = null;
  const c = vm.createContext({ Date, bot: { inventory: { slots } }, hasWeapon: () => weapon,
    nearestHostile: () => threat, FLEE_ONLY_MOBS: new Set(), SOLDIER_PATROL_RANGE: 32 });
  vm.runInContext(between(index, 'function nextSoldierPriority(', 'async function proposeOwnGoal('), c);
  weapon = false; assert.equal(c.nextSoldierPriority().name, 'weapon'); weapon = true;
  threat = { name: 'zombie' }; assert.equal(c.nextSoldierPriority().name, 'monster'); threat = null;
  assert.equal(c.nextSoldierPriority().name, 'armor');
  assert.equal(c.nextSoldierPriority().name, 'guard', 'armor retried at most every 30 min');
  vm.runInContext('soldierArmorRetryAt = 0', c);
  for (const s of [5, 6, 7, 8]) slots[s] = { name: 'iron_helmet' };
  assert.equal(c.nextSoldierPriority().name, 'guard', 'fully armored');
});

await check('Fairness: routine checks that lose their turn are counted', async () => {
  const c = vm.createContext({ busy: true, arbiter: { isBusy: () => false }, setInterval() {}, console, USERNAME: 'Amy', JSON, Object });
  vm.runInContext('var busy = this.busy;' + between(index, 'const ROUTINE_SKIP_REPORT_MS', '\n// Goal-identity guards'), c);
  assert.equal(c.routineBlocked('checkHunger'), true);
  assert.equal(c.routineBlocked('checkHunger'), true);
  vm.runInContext('busy = false', c);
  assert.equal(c.routineBlocked('checkSaplings'), false);
  assert.deepEqual({ ...vm.runInContext('routineSkips', c) }, { checkHunger: 2 });
});

// ---- 2026-09-25: acceptance checks from the review that had no test yet -----------------------
const skillsSrc = skills;
const router = await readFile(root + 'router.js', 'utf8');
const goalTickSrc = () => between(index, 'async function retireGoal(', 'setInterval(() => {\n  goalTick()');
function goalTickContext(bot, extras) {
  const c = vm.createContext({ console: { log() {}, error() {} }, bot, arbiter, busy: false, Date, Promise,
    AUTONOMY_ENABLED: true, USERNAME: 'Amy', PERSONA_NAME: 'amy', MAX_CONSECUTIVE_FAILURES: 3,
    goalPausedForNight: () => false, routineBlocked: () => false, parseGoalStep: () => ({ type: 'step', action: { type: 'mine' } }),
    logStep: (goal, line) => { goal.log.push(line); goal.steps++; }, saveGoal: async () => {}, clearGoal: async () => {},
    recordSkillOutcome: async () => {}, runSkill: async () => ({ ok: true, text: 'ran' }), ...extras });
  vm.runInContext('var currentGoal = this.currentGoal;' + goalTickSrc(), c);
  return c;
}

await check('MB-03 a rejected /tp still leaves no control owner behind', async () => {
  const bot = makeBot(); bot.spawnPoint = { x: 5, y: 64, z: 5 };
  let said = null; bot.chat = (m) => { said = m; }; // the server ignores it: a rejected /tp
  const held = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP);
  const c = vm.createContext({ bot, arbiter, console: { log() {}, error() {} }, USERNAME: 'Amy', PERSONA_NAME: 'amy',
    broadcastGoalState: async () => {}, recordGoalOutcome() {}, clearGoal: async () => {} });
  vm.runInContext('var currentGoal = null;' + between(index, 'async function teleportToSpawn(', 'function checkStuck('), c);
  await c.teleportToSpawn('test');
  assert.match(said, /^\/tp 5\.00 64\.00 5\.00/);
  assert.equal(arbiter.isBusy(), false, 'no owner left whether or not the /tp worked');
  assert.equal(held.token.preempted, true);
});

await check('MB-05 a goal replaced during skill lookup gets no skill run and no writes', async () => {
  const bot = makeBot(); let resolveSkill; let ran = 0;
  const oldGoal = { description: 'old', servedBySkill: false, log: [], steps: 0 };
  const c = goalTickContext(bot, { currentGoal: oldGoal,
    findSkill: () => new Promise((r) => { resolveSkill = r; }), runSkill: async () => { ran++; return { ok: true, text: 'x' }; } });
  const pending = c.goalTick();
  while (!resolveSkill) await sleep(1);
  vm.runInContext('currentGoal = { description: "new", servedBySkill: false, log: [], steps: 0 }', c);
  resolveSkill({ name: 'skill', jsonPath: 'x.json', steps: [] }); await pending;
  assert.equal(ran, 0); assert.equal(oldGoal.servedBySkill, false); assert.equal(oldGoal.steps, 0);
});

await check('MB-05/MB-21 planning holds no control, and a goal replaced mid-plan is not acted on', async () => {
  const bot = makeBot(); let resolvePlan; let acted = 0;
  const oldGoal = { description: 'old', servedBySkill: true, log: [], steps: 0 };
  const c = goalTickContext(bot, { currentGoal: oldGoal, findSkill: async () => null,
    planNextStep: () => new Promise((r) => { resolvePlan = r; }), performAction: async () => { acted++; return { ok: true, text: 'x' }; } });
  const pending = c.goalTick();
  while (!resolvePlan) await sleep(1);
  assert.equal(arbiter.isBusy(), false, 'the body is free while the model plans');
  vm.runInContext('currentGoal = null', c);
  resolvePlan('ACTION MINE oak_log 4'); await pending;
  assert.equal(acted, 0); assert.equal(oldGoal.steps, 0);
});

await check('MB-10 an interrupted skill replay is not scored and can run again', async () => {
  const bot = makeBot(); let scored = 0;
  const goal = { description: 'g', servedBySkill: false, log: [], steps: 0, consecutiveFailures: 0 };
  const c = goalTickContext(bot, { currentGoal: goal, findSkill: async () => ({ name: 's', jsonPath: 's.json', steps: [] }),
    runSkill: async () => ({ ok: false, cancelled: true, text: 'interrupted' }), recordSkillOutcome: async () => { scored++; } });
  await c.goalTick();
  assert.equal(scored, 0); assert.equal(goal.servedBySkill, false); assert.equal(goal.consecutiveFailures, 0);
});

await check('MB-10 a 13-step solve is not truncated into a 12-step skill', async () => {
  let asked = 0;
  const c = vm.createContext({ MIN_STEPS_TO_AUTHOR: 2, MAX_SKILL_STEPS: 12, isValidSkill: () => true,
    callRole: async () => { asked++; return 'NAME: x\nDESCRIPTION: y'; }, writeSkill: async () => true, console });
  vm.runInContext(between(skillsSrc, 'export async function authorSkillFromGoal('), c);
  const steps = Array.from({ length: 13 }, (_, i) => ({ type: i === 12 ? 'place' : 'mine' }));
  assert.equal(await c.authorSkillFromGoal('build a thing', steps), false);
  assert.equal(asked, 0, 'no model call for a solve that would be truncated');
  assert.equal(await c.authorSkillFromGoal('build a thing', steps.slice(0, 12)), true);
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

await check('MB-20 curriculum progress and evidence survive a Mayor restart', async () => {
  const disk = {};
  const fsStub = { readFile: async (p) => { if (!(p in disk)) throw new Error('ENOENT'); return disk[p]; },
    writeFile: async (p, d) => { disk[p] = d; }, mkdir: async () => {} };
  const src = between(index, 'const withTiers', '\nconst MEMORY_ROOT') + '\nconst MEMORY_ROOT = "/mem";' +
    between(index, 'const CURRICULUM_FILE', 'async function checkCurriculumAdvance(');
  const boot = () => {
    const c = vm.createContext({ ...fsStub, JSON, Object, Map, Set, console: { error() {} }, USERNAME: 'Mayor',
      BOT_ROLES: {}, ROLES: { SOLDIER: {} }, bot: { inventory: { items: () => [], slots: [] } } });
    vm.runInContext(src, c); return c;
  };
  const first = boot();
  first.recordCurriculumEvidence('Babs', 'wooden_axe');
  assert.equal(first.recordCurriculumEvidence('Babs', 'stone_pickaxe'), true, 'Babs clears basic tools');
  await sleep(5);
  const second = boot();
  await second.loadCurriculumStage();
  assert.equal(vm.runInContext('stageProgress.has("Babs")', second), true);
  assert.deepEqual([...vm.runInContext('stageEvidence.get("Babs")', second)].sort(), ['stone_pickaxe', 'wooden_axe']);
});

await check('MB-21 a stalled router call times out instead of hanging', async () => {
  const c = vm.createContext({ process: { env: { HERMES_ROUTER_TIMEOUT_MS: '50' } }, AbortSignal, JSON,
    fetch: (_, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))) });
  vm.runInContext(between(router, 'const ROUTER_URL').replace(/export /g, ''), c);
  const started = Date.now();
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer doesn't hold the process open
  try {
    await assert.rejects(c.callRole('dispatch', []), (err) => err.name === 'TimeoutError');
  } finally {
    clearTimeout(keepAlive);
  }
  assert(Date.now() - started < 2000);
});

await check('MB-21 RAG subprocesses carry a timeout', async () => {
  const calls = [];
  const c = vm.createContext({ RAG_DISABLED: false, PYTHON: 'py', SEARCH_SCRIPT: 's.py', RAG_SEARCH_TIMEOUT_MS: 30000, JSON, console,
    execFileAsync: async (cmd, args, opts) => { calls.push(opts); return { stdout: '[]' }; } });
  vm.runInContext(between(longterm, 'export async function searchMemory(').replace(/export /g, ''), c);
  await c.searchMemory('q');
  assert.equal(calls[0]?.timeout, 30000);
});

await check('MB-22 a stationary bot nobody is moving never escalates; a wedged one does', async () => {
  let t = 0; const events = [];
  const pos = { x: 0, y: 64, z: 0, distanceTo: () => 0, clone() { return this; } };
  const c = vm.createContext({ AUTONOMY_ENABLED: true, bot: { isSleeping: false, entity: { position: pos } },
    Date: { now: () => t }, Math, console: { log() {}, error() {} }, USERNAME: 'Mark', PERSONA_NAME: 'mark',
    saveStuckState: async () => {}, STUCK_THRESHOLD_MS: 300_000, MAX_STUCK_NUDGES: 2,
    teleportToSpawn: async () => { events.push('teleport'); }, nudgeUnstuck: async () => { events.push('nudge'); } });
  vm.runInContext('var currentSameSpotCount = 0, lastPosition = null, lastMovedAt = 0, stuckNudgeCount = 0, lastMoveAttemptAt = 0;' +
    between(index, 'function checkStuck(', '\n// Review MB-22 follow-up'), c);
  for (let i = 0; i < 40; i++) { t += 30_000; c.checkStuck(); }
  assert.deepEqual(events, [], 'a guard standing still for 20 min is left alone');
  for (let i = 0; i < 40; i++) { t += 30_000; vm.runInContext(`lastMoveAttemptAt = ${t}`, c); c.checkStuck(); }
  assert.deepEqual(events.slice(0, 3), ['nudge', 'nudge', 'teleport'], 'trying to move but not moving escalates');
});

console.log(`${passed} unit checks passed.`);
