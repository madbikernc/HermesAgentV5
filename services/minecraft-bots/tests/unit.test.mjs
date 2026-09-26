// Version: 1.15.0
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
// 1.6.0 | 2026-09-25 | Fight-or-flee policy and attacker tracking, /spreadplayers rescue, rag-backend
//   local timeouts and remote mode (spark2 RAG).
// 1.7.0 | 2026-09-25 | Beds: a destroyed claim moves to the nearest unclaimed bed, claim conflicts,
//   sleep tries unclaimed beds first (one candidate per bed) and never claims another bot's.
// 1.8.0 | 2026-09-25 | Shared bed claims: cross-host conflicts, migration of a host's claim, store
//   clears, sleep skipping another host's bed; the older bed checks now cover the local fallback.
// 1.9.0 | 2026-09-25 | Doors: open doors/gates walkable, closed wooden ones openable, iron closed a wall,
//   doorway waypoints put back on the floor, and the guard that never re-toggles an open door.
// 1.10.0 | 2026-09-25 | Close behind: doors/gates shut once clear, without a head turn; held for a
//   follower and during herd_to_pen; iron and already-shut doors left alone.
// 1.11.0 | 2026-09-25 | Farming/ranching: food fetch and backoff, farm/ranch goal routing and runners,
//   harvested-crop curriculum evidence, farm plot and pen site choice.
// 1.12.0 | 2026-09-25 | Ripe-crop routine backoff; drops collected only after a real harvest.
// 1.13.0 | 2026-09-25 | Enchants normalization (digging with enchanted gear).
// 1.14.0 | 2026-09-26 | Beds: colour choice, bed site, bed goal routing and runner, the no-bed-at-night goal.
// 1.15.0 | 2026-09-26 | Shelters: materials, site, routing, the height-tolerant shelter check, the goal runner.
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
const swim = await readFile(root + 'swim-movements.js', 'utf8');
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
    ACTION_TIMEOUT_MS: 400, equipBestWeapon: async () => {}, refreshGear: async () => {}, holdDoorsOpen: () => () => {},
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
  const c = vm.createContext({ Date, Map, console: { log() {} },
    memWrite: async () => { writes++; }, slugify: (t) => t, ragIngest: async () => {},
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
    broadcastGoalState: async () => {}, recordGoalOutcome() {}, clearGoal: async () => {}, TELEPORT_SAFE_RANGE: 4 });
  vm.runInContext('var currentGoal = null;' + between(index, 'async function teleportToSpawn(', 'function checkStuck('), c);
  await c.teleportToSpawn('test');
  // A safe landing spot near spawn, never the spawn block's corner (that suffocated bots in walls).
  assert.equal(said, '/spreadplayers 5.5 5.5 0 4 false Amy');
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

const ragBackend = await readFile(root + 'rag-backend.js', 'utf8');
const ragContext = (extras) => {
  const c = vm.createContext({ JSON, Map, AbortSignal, PYTHON: 'py', SEARCH_SCRIPT: 's.py', INGEST_SCRIPT: 'i.py',
    SEARCH_TIMEOUT_MS: 30000, INGEST_TIMEOUT_MS: 180000, REMOTE_TIMEOUT_MS: 35000, RAG_TOKEN: 'tok',
    MEMORY_DIR: '/m', path: { join: (...p) => p.join('/'), dirname: (p) => p.split('/').slice(0, -1).join('/') }, ...extras });
  vm.runInContext(between(ragBackend, 'export const isRemote').replace(/export /g, ''), c);
  return c;
};

await check('MB-21 RAG subprocesses carry a timeout (local mode)', async () => {
  const calls = [];
  const c = ragContext({ RAG_URL: '', execFileAsync: async (cmd, args, opts) => { calls.push([args, opts]); return { stdout: '[]' }; } });
  await c.ragSearch('q', { corpus: 'minecraft-skills', topK: 2 });
  assert.equal(calls[0][1].timeout, 30000);
  assert.deepEqual([...calls[0][0]], ['s.py', 'q', '--top-k', '2', '--corpus', 'minecraft-skills']);
});

await check('spark2 RAG: remote mode sends search/read/write/ingest to spark with the bot token', async () => {
  const sent = [];
  const c = ragContext({ RAG_URL: 'http://spark:8105', execFileAsync: async () => { throw new Error('must not run locally'); },
    fetch: async (url, opts) => {
      sent.push([url, JSON.parse(opts.body), opts.headers.Authorization]);
      const reply = url.endsWith('/search') ? { results: [{ text: 't', source_path: 'a.md', distance: 0.1 }] }
        : url.endsWith('/read') ? { content: '{"name":"x"}' } : { ok: true };
      return { ok: true, json: async () => reply };
    } });
  assert.equal((await c.ragSearch('oak', { corpus: 'minecraft', topK: 1 }))[0].source_path, 'a.md');
  assert.equal(await c.memRead('skills/x.json'), '{"name":"x"}');
  await c.memWrite('world/1-note.md', 'hi\n');
  await c.ragIngest('minecraft');
  assert.deepEqual(sent.map(([u, b, a]) => [u.split('/').pop(), a]),
    [['search', 'Bearer tok'], ['read', 'Bearer tok'], ['write', 'Bearer tok'], ['ingest', 'Bearer tok']]);
  assert.deepEqual({ ...sent[2][1] }, { path: 'world/1-note.md', content: 'hi\n' });
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

// ---- 2026-09-25: fight-or-flee policy -------------------------------------------------------------
function policyContext({ health = 20, soldier = false, armed = true, mobs = [] }) {
  const entities = {};
  mobs.forEach(([name, dist], i) => { entities[i + 1] = { id: i + 1, name, position: { distanceTo: () => dist } }; });
  const bot = { health, entity: { position: {} }, entities };
  const c = vm.createContext({ bot, Date, Object, hasWeapon: () => armed, FLEE_ONLY_MOBS: new Set(['phantom', 'ghast', 'enderman']),
    HOSTILE_MOBS: new Set(['zombie', 'husk', 'creeper', 'skeleton', 'pillager', 'spider']),
    EMERGENCY_HEALTH_THRESHOLD: 6, HALF_HEALTH: 10, ROLES: { SOLDIER: 'S' }, myRole: soldier ? { primary: 'S' } : null,
    CONSECUTIVE_FLEE_ESCALATE_AFTER: 3, CONSECUTIVE_FLEE_RESET_MS: 15000 });
  vm.runInContext('var consecutiveFleeCount = 0, lastFleeDecisionAt = 0;' +
    between(index, 'const OUTNUMBERED_RADIUS', 'async function attackAsLastResort('), c);
  return { c, threat: entities[1] };
}

await check('Fight-or-flee: armed bot at critical health fights a single melee or ranged mob', async () => {
  for (const mob of ['zombie', 'pillager']) {
    const { c, threat } = policyContext({ health: 5, mobs: [[mob, 3]] });
    assert.equal(c.decideFightType(threat), 'attack', mob);
  }
});

await check('Fight-or-flee: outnumbered at critical health flees, even a Soldier', async () => {
  const { c, threat } = policyContext({ health: 5, soldier: true, mobs: [['zombie', 2], ['zombie', 6]] });
  assert.equal(c.decideFightType(threat), 'flee');
  const healthy = policyContext({ health: 18, soldier: true, mobs: [['zombie', 2], ['zombie', 6]] });
  assert.equal(healthy.c.decideFightType(healthy.threat), 'attack', 'a healthy Soldier holds against two');
});

await check('Fight-or-flee: 3+ hostiles send a non-Soldier running at any health; a close creeper always does', async () => {
  const crowd = policyContext({ health: 20, mobs: [['zombie', 2], ['spider', 4], ['skeleton', 7]] });
  assert.equal(crowd.c.decideFightType(crowd.threat), 'flee');
  const soldier = policyContext({ health: 20, soldier: true, mobs: [['zombie', 2], ['spider', 4], ['skeleton', 7]] });
  assert.equal(soldier.c.decideFightType(soldier.threat), 'attack');
  const creeper = policyContext({ health: 20, soldier: true, mobs: [['creeper', 3]] });
  assert.equal(creeper.c.decideFightType(creeper.threat), 'flee');
  const unarmed = policyContext({ health: 20, armed: false, mobs: [['zombie', 3]] });
  assert.equal(unarmed.c.decideFightType(unarmed.threat), 'flee');
});

await check('Fight-or-flee: the mob that just hurt the bot is the threat, not merely the nearest', async () => {
  const { EventEmitter } = await import('node:events');
  const bot = new EventEmitter();
  const here = {};
  const at = (d) => ({ d, distanceTo() { return this.d; } });
  const zombie = { id: 1, name: 'zombie', position: at(2) };
  const skeleton = { id: 2, name: 'skeleton', position: at(15) };
  Object.assign(bot, { health: 20, entity: { position: here }, entities: { 1: zombie, 2: skeleton },
    nearestEntity: (pred) => [zombie, skeleton].filter(pred).sort((a, b) => a.position.d - b.position.d)[0] });
  const c = vm.createContext({ bot, Date, HOSTILE_MOBS: new Set(['zombie', 'skeleton']),
    nearestHostile: () => zombie });
  vm.runInContext(between(index, 'const RANGED_MOBS', 'async function checkSelfDefense('), c);
  assert.equal(c.pickThreat(24), zombie, 'nothing has hit it yet: nearest');
  zombie.position.d = 8; // the zombie backs off; an arrow lands
  bot.health = 17; bot.emit('health');
  assert.equal(c.pickThreat(24), skeleton, 'the archer that just hit it');
});

// Beds (2026-09-25): a fake world of bed blocks plus a temp claims directory, with the real claim
// helpers and the real "sleep" action.
class V3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  offset(dx, dy, dz) { return new V3(this.x + dx, this.y + dy, this.z + dz); }
  equals(o) { return o.x === this.x && o.y === this.y && o.z === this.z; }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
  toString() { return `(${this.x}, ${this.y}, ${this.z})`; }
  floored() { return new V3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
}
// `shared`: hermes-memory's minecraft-beds rows as { name: value } (mutated by writes); omitted =
// hermes-memory unreachable, so claims fall back to this host's files.
async function bedWorld(username, { claims = {}, standAt = new V3(0, 64, 0), shared } = {}) {
  const fs = await import('node:fs/promises');
  const pathMod = (await import('node:path')).default;
  const dir = await fs.mkdtemp(pathMod.join((await import('node:os')).tmpdir(), 'mbtest-beds-'));
  for (const [name, [bx, by, bz]] of Object.entries(claims)) {
    await fs.writeFile(pathMod.join(dir, `${name}.json`), JSON.stringify({ x: bx, y: by, z: bz }));
  }
  const blocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  // A bed facing east: foot at (bx, by, bz), head at (bx + 1, by, bz).
  const addBed = (bx, by, bz) => {
    for (const [dx, part] of [[0, 'foot'], [1, 'head']]) {
      const position = new V3(bx + dx, by, bz);
      blocks.set(key(position), { name: 'red_bed', position, getProperties: () => ({ facing: 'east', part }) });
    }
  };
  const bot = makeBot();
  const tried = [];
  Object.assign(bot, {
    username, entity: { position: standAt }, isSleeping: false,
    blockAt: (p) => blocks.get(key(p)) || { name: 'air', position: p, getProperties: () => ({}) },
    isABed: (b) => !!b?.name?.endsWith('_bed'),
    findBlocks: ({ matching, count }) => [...blocks.values()].filter(matching)
      .sort((a, b) => a.position.distanceTo(standAt) - b.position.distanceTo(standAt))
      .slice(0, count).map((b) => b.position),
    sleep: async (b) => { tried.push(key(b.position)); setTimeout(() => bot.emit('wake'), 5); },
  });
  bot.pathfinder.goto = async () => {};
  const listState = async (agent) => {
    if (!shared) throw new Error('connect ECONNREFUSED');
    assert.equal(agent, 'minecraft-beds');
    return Object.entries(shared).map(([key, value]) => ({ key, value }));
  };
  const setState = async (agent, k, value) => {
    if (!shared) throw new Error('connect ECONNREFUSED');
    shared[k] = value;
  };
  const c = context(bot, { BEDS_DIR: dir, Vec3: V3, path: pathMod, readFile: fs.readFile, listState, setState, process: { env: {} },
    writeFile: fs.writeFile, mkdir: fs.mkdir, readdir: fs.readdir, unlink: fs.unlink, SLEEP_TIMEOUT_MS: 1000 });
  vm.runInContext(between(actions, 'function bedNearHazard(', '\n// Direct request, 2026-09-09') +
    between(actions, 'async function loadClaimedBed(', '\n// Direct request, 2026-09-10') + timeoutFn + actionFn, c);
  const claimOf = async (name) => {
    try { return JSON.parse(await fs.readFile(pathMod.join(dir, `${name}.json`), 'utf8')); } catch { return null; }
  };
  return { bot, c, addBed, blocks, tried, claimOf, destroy: (p) => { blocks.delete(key(p)); blocks.delete(`${p.x + 1},${p.y},${p.z}`); } };
}

await check('Beds: a destroyed claimed bed is replaced by the nearest bed no other bot claimed', async () => {
  // Amy's bed at x=0 is gone; x=4 is nearer but Babs claimed it by its FOOT half; x=10 is free.
  const w = await bedWorld('Amy', { claims: { Amy: [1, 64, 0], Babs: [4, 64, 0] } });
  w.addBed(4, 64, 0); w.addBed(10, 64, 0);
  const result = await w.c.checkClaimedBed(w.bot);
  assert.equal(result.status, 'replaced');
  assert.deepEqual(await w.claimOf('Amy'), { x: 11, y: 64, z: 0 }, 'the free bed, by its head');
  assert.deepEqual(await w.claimOf('Babs'), { x: 4, y: 64, z: 0 }, "Babs's claim is untouched");
});

await check('Beds: no unclaimed bed left clears the dead claim; a live or unloaded claim is kept', async () => {
  const w = await bedWorld('Amy', { claims: { Amy: [1, 64, 0], Babs: [5, 64, 0] } });
  w.addBed(4, 64, 0);
  assert.equal((await w.c.checkClaimedBed(w.bot)).status, 'lost');
  assert.equal(await w.claimOf('Amy'), null);
  const live = await bedWorld('Amy', { claims: { Amy: [4, 64, 0] } });
  live.addBed(4, 64, 0);
  assert.equal((await live.c.checkClaimedBed(live.bot)).status, 'ok');
  const unloaded = await bedWorld('Amy', { claims: { Amy: [900, 64, 0] } });
  unloaded.bot.blockAt = () => null;
  assert.equal((await unloaded.c.checkClaimedBed(unloaded.bot)).status, 'unloaded');
  assert.deepEqual(await unloaded.claimOf('Amy'), { x: 900, y: 64, z: 0 });
});

await check('Beds: two bots on one bed -- the lower-sorted name keeps it, the other moves', async () => {
  const claims = { Amy: [4, 64, 0], Babs: [5, 64, 0] }; // same bed, different halves
  const babs = await bedWorld('Babs', { claims });
  babs.addBed(4, 64, 0); babs.addBed(10, 64, 0);
  assert.equal((await babs.c.checkClaimedBed(babs.bot)).status, 'replaced');
  assert.deepEqual(await babs.claimOf('Babs'), { x: 11, y: 64, z: 0 });
  const amy = await bedWorld('Amy', { claims });
  amy.addBed(4, 64, 0); amy.addBed(10, 64, 0);
  assert.equal((await amy.c.checkClaimedBed(amy.bot)).status, 'ok');
});

await check('Beds: sleep after the bed is destroyed goes to an unclaimed bed and claims it', async () => {
  // Nearest beds: x=2 (Babs's), x=6 (Cal's), x=12 (free). The old code tried the 3 nearest
  // bed BLOCKS -- both halves of x=2 and one of x=6 -- and never reached the free bed.
  const w = await bedWorld('Amy', { claims: { Amy: [0, 64, 5], Babs: [2, 64, 0], Cal: [6, 64, 0] } });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0); w.addBed(12, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['13,64,0'], 'the free bed first, by its head');
  assert.deepEqual(await w.claimOf('Amy'), { x: 13, y: 64, z: 0 });
});

await check("Beds: sleeping in another bot's bed as a last resort doesn't claim it", async () => {
  const w = await bedWorld('Amy', { claims: { Babs: [3, 64, 0] } });
  w.addBed(2, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['3,64,0']);
  assert.equal(await w.claimOf('Amy'), null);
});

await check('Shared beds: a claim made on the other host is seen, and the later name moves', async () => {
  // Amy (spark) claimed the bed at x=4 in the shared store; Wade (spark2) has the same bed only in
  // his own host's file. Amy sorts first, so Wade moves to the free bed.
  const shared = { Amy: { x: 5, y: 64, z: 0 } };
  const w = await bedWorld('Wade', { claims: { Wade: [4, 64, 0] }, shared });
  w.addBed(4, 64, 0); w.addBed(10, 64, 0);
  assert.equal((await w.c.checkClaimedBed(w.bot)).status, 'replaced');
  assert.deepEqual({ ...shared.Wade }, { x: 11, y: 64, z: 0 }, 'published to the shared store');
  assert.deepEqual(await w.claimOf('Wade'), { x: 11, y: 64, z: 0 }, 'and kept as the local fallback');
});

await check("Shared beds: a host's existing claim is published on first read; the store then wins", async () => {
  const shared = {};
  const w = await bedWorld('Nell', { claims: { Nell: [4, 64, 0] }, shared });
  w.addBed(4, 64, 0);
  assert.deepEqual(await w.c.loadClaimedBed(w.bot), new V3(4, 64, 0));
  assert.deepEqual({ ...shared.Nell }, { x: 4, y: 64, z: 0 }, 'migrated');
  shared.Nell = {}; // cleared elsewhere (e.g. by the same bot on a restart elsewhere)
  assert.equal(await w.c.loadClaimedBed(w.bot), null, 'the store is authoritative once it knows the bot');
  assert.equal(await w.claimOf('Nell'), null, 'local fallback follows the store');
});

await check('Shared beds: losing the bed with nothing free clears the claim in the store', async () => {
  const shared = { Dale: { x: 1, y: 64, z: 0 }, Bob: { x: 4, y: 64, z: 0 } };
  const w = await bedWorld('Dale', { shared });
  w.addBed(4, 64, 0);
  assert.equal((await w.c.checkClaimedBed(w.bot)).status, 'lost');
  assert.deepEqual({ ...shared.Dale }, {});
});

await check('Shared beds: sleep skips a bed claimed on the other host', async () => {
  const shared = { Amy: { x: 3, y: 64, z: 0 } };
  const w = await bedWorld('Wade', { shared });
  w.addBed(2, 64, 0); w.addBed(8, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['9,64,0']);
  assert.deepEqual({ ...shared.Wade }, { x: 9, y: 64, z: 0 });
});

// Doors (2026-09-25): pathfinder's own getBlock() marks every door and gate unsafe and physical from
// the block type, and never openable for doors; applyDoorState must correct that from the state.
function doorBlock(name, props) {
  return { name, safe: false, physical: !name.endsWith('_fence_gate'), openable: name.endsWith('_fence_gate'),
    getProperties: () => props };
}
const doorFns = () => {
  const c = vm.createContext({});
  vm.runInContext(between(swim, 'function applyDoorState(', 'const MAX_DIG_LABOR_COST') + between(swim, 'function isDoorway(', 'export function isOpenDoorOrGate('), c);
  return c;
};

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

// Closing behind (2026-09-25): a fake bot walks through a doorway at (0, 64, 0) one tick at a time.
function closerWorld({ name = 'oak_door', open = true } = {}) {
  const props = { half: 'lower', open };
  const door = { name, position: new V3(0, 64, 0), getProperties: () => props };
  const bot = new EventEmitter();
  const used = []; let looked = 0;
  Object.assign(bot, { username: 'Amy', entities: {}, entity: { position: new V3(0.5, 64, -2) },
    blockAt: (p) => (p.x === 0 && p.y === 64 && p.z === 0 ? door : { name: 'air', getProperties: () => ({}) }),
    lookAt: async () => { looked++; } });
  bot.entities[1] = bot.entity;
  const activate = (b) => { used.push({ name: b.name, looked }); bot.lookAt(); props.open = !props.open; return Promise.resolve(); };
  const c = vm.createContext({ Vec3: V3, Promise, console: { log() {}, error() {} } });
  vm.runInContext(between(swim, 'const DOOR_CLOSE_MIN', 'const MAX_DIG_LABOR_COST'), c);
  c.installDoorCloser(bot, activate);
  const walk = async (...zs) => { for (const z of zs) { bot.entity.position = new V3(0.5, 64, z); bot.emit('physicsTick'); await sleep(0); } };
  return { bot, c, used, props, walk, looks: () => looked };
}

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
  const herd = actions.slice(actions.indexOf('case "herd_to_pen": {'), actions.indexOf('case "repair_terrain": {'));
  const [approach, hold, equip, backWall] = ['GoalNear(animal.position.x', 'holdDoorsOpen(bot)', 'bot.equip(foodItem', 'pen.center.z - 2']
    .map((t) => herd.indexOf(t));
  assert(approach > 0 && approach < hold && hold < equip && equip < backWall, 'walk out empty-handed, then hold + food, then lead to the back wall');
  assert.match(herd, /} finally \{\s+releaseDoors\(\);\s+await refreshGear\(bot\);/, 'released and the food put away on every exit');
});

// Farming and ranching (2026-09-25).
await check('Food: loot "food" asks chests for every edible item; "seeds" for anything plantable', async () => {
  const c = vm.createContext({ FOOD_NAMES: ['bread', 'carrot'] });
  vm.runInContext(between(actions, 'const SEED_NAMES', '// Verified achievements'), c);
  const groups = vm.runInContext('LOOT_GROUPS', c);
  assert.deepEqual([...groups.food], ['bread', 'carrot']);
  assert.deepEqual([...groups.seeds], ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds']);
  assert.match(actions, /: LOOT_GROUPS\[action\.item\]; \/\/ "food", "seeds"/);
  assert.match(actions, /const wantedNames = group \|\| gearCategoryNames\(bot, action\.item\);/);
});

function hungerWorld({ food = 10, items = [], lootGives = null } = {}) {
  const inv = [...items];
  const calls = [];
  const bot = { food, isSleeping: false, inventory: { items: () => inv } };
  const performAction = async (b, action) => {
    calls.push(action.type + (action.item ? `:${action.item}` : ''));
    if (action.type === 'loot') {
      if (!lootGives) return { ok: false, text: 'checked nearby chests, no food in any of them.' };
      inv.push({ name: lootGives, count: 8 });
      return { ok: true, text: `found 8 ${lootGives} in a chest.` };
    }
    if (action.type === 'eat') {
      const i = inv.findIndex((it) => ['bread', 'carrot'].includes(it.name));
      return i < 0 ? { ok: false, text: "don't have anything to eat." } : { ok: true, text: `ate some ${inv[i].name}.` };
    }
    return { ok: true, text: 'fished.' };
  };
  const c = vm.createContext({ bot, performAction, console: { log() {}, error() {} }, Date, USERNAME: 'Amy',
    AUTONOMY_ENABLED: true, HUNGER_THRESHOLD: 18, CRITICAL_FOOD_LEVEL: 6, FOOD_NAMES: ['bread', 'carrot'],
    routineBlocked: () => false, arbiter: { OWNERS: { ROUTINE: 1, HUNGER_CRITICAL: 2 }, requestControl: async () => ({ release() {} }) } });
  vm.runInContext(between(index, 'const FOOD_FETCH_COUNT', 'setInterval(() => {'), c);
  return { c, calls, inv };
}

await check('Food: a hungry bot with nothing to eat fetches food from a chest, then eats', async () => {
  const w = hungerWorld({ lootGives: 'bread' });
  await w.c.checkHunger();
  assert.deepEqual(w.calls, ['loot:food', 'eat']);
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

const farmGoalSrc = () => between(index, 'const FARM_WORDS', 'async function goalTick(');

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

function farmGoalWorld(results, status = { ripe: 0, growing: 0 }) {
  const calls = [], done = [], retired = [];
  const performAction = async (b, action) => { calls.push({ ...action }); return results.shift() ?? { ok: false, text: 'nothing' }; };
  const world = { status };
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Babs', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, inventory: { items: () => [] }, entities: {} }, Vec3: V3, performAction,
    farmStatus: () => world.status, narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async (status, d, item) => { done.push([status, item]); },
    retireGoal: async (g) => { retired.push(g); }, saveGoalIfCurrent: async () => {},
    logStep: () => {}, loadPenLocation: async () => null, LIVESTOCK: [], BREEDING_FOOD: {}, countInPen: () => 0, findPenSite: () => null });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { description: 'start a farm', createdAt: Date.now() - 1000, consecutiveFailures: 0 };
  const tick = () => c.runFarmGoal(goal, async () => true, () => ({ release() {} }), () => false);
  return { c, calls, done, retired, goal, world, tick };
}

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
  ]);
  await w.tick();
  assert.deepEqual(w.calls.map((a) => a.type + (a.item ? `:${a.item}` : '')), ['harvest', 'loot:wooden_hoe', 'craft:wooden_hoe', 'harvest']);
  assert.deepEqual(w.goal.farmPlot, { x: 1, y: 64, z: 1 });
});

await check('Farm goals: holding a crop, or a DONE claim, never finishes one -- only a harvest', async () => {
  assert.match(index, /goal\.farmTask \?\?= farmTaskFor\(goal\.description\);[\s\S]{0,900}if \(goal\.targetItem && holdsItem\(goal\.targetItem\)\)/,
    'farm/ranch routing runs before the "already holding the target" shortcut and the skill lookup');
  const w = farmGoalWorld([{ ok: false, text: "couldn't start a farm: tilled 0, planted 0 (the grass_block didn't turn to farmland)." }]);
  await w.tick(); await w.tick(); await w.tick();
  assert.deepEqual(w.done, [['abandoned', undefined]], 'three real failures give up; nothing claims done');
});

await check('Ranch goals: fences and gate crafted from the wood she has, pen built on a site, pair penned, bred', async () => {
  const inv = [{ name: 'birch_log', count: 8 }];
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
    bot: { chat() {}, spawnPoint: new V3(0, 64, 0), inventory: { items: () => inv },
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

function plotWorld(blocks, water) {
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const at = new Map(Object.entries(blocks).map(([k, name]) => [k, name]));
  const blockAt = (p) => ({ name: at.get(key(p)) ?? 'air', position: p });
  return { entity: { position: new V3(0, 65, 0) }, registry: { blocksByName: { water: { id: 1 } } }, blockAt,
    findBlocks: ({ matching, point }) => {
      if (matching === 1) return water;
      return [...at.entries()].filter(([, n]) => matching({ name: n })).map(([k]) => new V3(...k.split(',').map(Number)))
        .sort((a, b) => a.distanceTo(point) - b.distanceTo(point));
    } };
}

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
function closedIron(c) { return c.isClosedOpenableDoorway({ name: 'iron_door', getProperties: () => ({ half: 'lower', open: false }) }); }

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

// Beds (2026-09-26).
const bedFns = () => {
  const c = vm.createContext({ Vec3: V3, Math, Object });
  vm.runInContext(between(actions, 'function woolCounts(', 'export const CROP_MAX_AGE'), c);
  return c;
};

await check('Beds: "bed" is crafted in the colour she has 3 wool of, white when she has none', async () => {
  const c = bedFns();
  const inv = (items) => ({ inventory: { items: () => items } });
  assert.equal(c.bedItemFor(inv([])), 'white_bed');
  assert.equal(c.bedItemFor(inv([{ name: 'red_wool', count: 2 }, { name: 'blue_wool', count: 4 }])), 'blue_bed');
  assert.equal(c.bedItemFor(inv([{ name: 'red_wool', count: 2 }, { name: 'red_wool', count: 1 }])), 'red_bed', 'stacks add up');
  assert.match(actions, /if \(action\.item === "bed" \|\| action\.item === "beds"\) action = \{ \.\.\.action, item: bedItemFor\(bot\) \};/);
  assert.match(actions, /const group = action\.item === "wool"/, 'loot "wool" takes any colour');
  const craftCase = actions.slice(actions.indexOf('case "craft": {'), actions.indexOf('case "loot": {') > actions.indexOf('case "craft": {') ? actions.indexOf('case "loot": {') : undefined);
  const [makeTable, placeTable, giveUp] = ['{ type: "craft", item: "crafting_table", count: 1 }', '{ type: "place", item: "crafting_table" }', 'need a crafting table nearby for']
    .map((t) => craftCase.indexOf(t));
  assert(makeTable > 0 && makeTable < placeTable && placeTable < giveUp, 'no table around: make one and set it down before giving up');
});

function bedSiteWorld({ beds = [], doors = [], walls = [] } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const bedSet = new Set(beds.map(key)), doorSet = new Set(doors.map(key)), wallSet = new Set(walls.map(key));
  return {
    blockAt: (p) => {
      if (p.y < 64) return { name: 'grass_block', boundingBox: 'block' };
      if (bedSet.has(key(p))) return { name: 'red_bed', boundingBox: 'block' };
      if (doorSet.has(key(p))) return { name: 'oak_door', boundingBox: 'block' };
      if (wallSet.has(key(p))) return { name: 'cobblestone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    isABed: (b) => b.name.endsWith('_bed'),
    findBlocks: () => beds.map((b) => new V3(b.x, b.y, b.z)),
  };
}

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
  const c = vm.createContext({ setInterval() {}, Date });
  vm.runInContext(farmGoalSrc(), c);
  assert.equal(c.farmTaskFor('go home and set up more beds there -- we have 0, need at least 9'), 'bed');
  assert.equal(c.farmTaskFor('Amy, craft a bed and store your gear in a chest'), 'bed');
  assert.equal(c.farmTaskFor('make myself a bed and place it at home'), 'bed');
  assert.equal(c.farmTaskFor('go to bed, it is late'), null);
  assert.equal(c.farmTaskFor('mine down to bedrock'), null);
  assert.equal(c.farmTaskFor('breed two cows'), 'ranch', 'breed is not bed');
});

await check('Beds: a bed goal loots wool once, gets the rest from sheep, crafts, places, then is done', async () => {
  const inv = [{ name: 'oak_log', count: 4 }];
  const calls = []; const done = [];
  const performAction = async (b, action) => {
    calls.push(action.type + (action.item ? `:${action.item}` : ''));
    if (action.type === 'loot') return { ok: false, text: 'no wool in any chest' };
    if (action.type === 'get_wool') { inv.push({ name: 'white_wool', count: 3 }); return { ok: true, text: 'gathered wool' }; }
    if (action.type === 'craft') { inv.splice(0, inv.length, { name: action.item, count: 1 }); return { ok: true, text: 'crafted' }; }
    if (action.type === 'place_bed') return { ok: true, text: 'placed a white_bed at home.', bedAt: { x: 3, y: 64, z: 0 } };
    return { ok: false, text: '?' };
  };
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Amy', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, inventory: { items: () => inv }, entities: {} }, Vec3: V3, performAction,
    farmStatus: () => ({ ripe: 0, growing: 0 }), narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async (status) => { done.push(status); }, retireGoal: async () => {}, saveGoalIfCurrent: async () => {},
    logStep: () => {}, loadPenLocation: async () => null, LIVESTOCK: [], BREEDING_FOOD: {}, countInPen: () => 0, findPenSite: () => null,
    woolCounts: (b) => Object.fromEntries(b.inventory.items().filter((i) => i.name.endsWith('_wool')).map((i) => [i.name.slice(0, -5), i.count])),
    bedItemFor: () => 'white_bed' });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { description: 'make myself a bed and place it at home', createdAt: Date.now(), consecutiveFailures: 0 };
  for (let i = 0; i < 6 && !done.length; i++) await c.runBedGoal(goal, async () => true, () => ({ release() {} }), () => false);
  assert.deepEqual(calls, ['loot:wool', 'get_wool', 'craft:white_bed', 'place_bed']);
  assert.deepEqual(done, ['done']);
});

await check('Beds: a night with no bed gives an idle bot a bed goal for the morning, and never replaces a goal', async () => {
  assert.match(index, /if \(!result\.ok && !result\.cancelled && \/couldn't find a bed\/\.test\(result\.text\)\) await wantBed\(\);/);
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

// Shelters (2026-09-26).
const shelterFns = () => {
  const c = vm.createContext({ Vec3: V3, Math, isProtectedBlockName: (n) => /chest|_bed$|_door$|crafting_table|furnace/.test(n) });
  vm.runInContext(between(actions, 'const SHELTER_MATERIAL', 'export const CROP_MAX_AGE').replace(/export /g, ''), c);
  return c;
};

await check('Shelters: any mix of plain building blocks; never sand, gravel, valuables or functional blocks', async () => {
  const c = shelterFns();
  for (const n of ['dirt', 'cobblestone', 'oak_planks', 'spruce_log', 'stripped_birch_log', 'crimson_stem', 'stone_bricks', 'deepslate']) {
    assert.equal(c.isShelterMaterial(n), true, n);
  }
  for (const n of ['sand', 'gravel', 'chest', 'crafting_table', 'diamond_block', 'torch', 'oak_leaves', 'tnt', 'iron_ore']) {
    assert.equal(c.isShelterMaterial(n), false, n);
  }
  const bot = { inventory: { items: () => [{ name: 'dirt', count: 20 }, { name: 'cobblestone', count: 12 }, { name: 'sand', count: 64 }] } };
  assert.equal(c.shelterMaterialCount(bot), 32, 'dirt and cobblestone add up; sand does not count');
  assert.equal(c.shelterPositions(new V3(0, 64, 0)).length, 30, '7 wall columns x 3 + a 3x3 roof');
  const build = actions.slice(actions.indexOf('case "build": {'), actions.indexOf('case "build_pen": {'));
  assert.match(build, /buildMovements\.scafoldingBlocks = \[\];/, 'no scaffolding: she pillared up inside her own shelter');
  assert.match(build, /buildMovements\.allow1by1towers = false;/);
  assert.match(build, /finally \{\s+if \(bot\.pathfinder\.movements === buildMovements\) bot\.pathfinder\.setMovements\(sharedMovements\);/);
});

function shelterWorld({ groundY = (x, z) => 63, blocked = [] } = {}) {
  const b = new Set(blocked.map((p) => `${p.x},${p.y},${p.z}`));
  return { blockAt: (p) => (p.y <= groundY(p.x, p.z) || b.has(`${p.x},${p.y},${p.z}`)
    ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }) };
}

await check('Shelters: the site is a flat, clear 3x3 within 4 blocks of home, even a step above or below it', async () => {
  const c = shelterFns();
  const home = new V3(0, 64, 0);
  const flat = c.findShelterSite(shelterWorld(), home);
  assert.deepEqual([flat.x, flat.y, flat.z], [0, 64, 0], 'right on home when that is clear');
  const tree = c.findShelterSite(shelterWorld({ blocked: [new V3(0, 65, 0)] }), home);
  assert(Math.max(Math.abs(tree.x), Math.abs(tree.z)) <= 4 && Math.max(Math.abs(tree.x), Math.abs(tree.z)) >= 2, `moved off the obstacle: ${tree}`);
  const raised = c.findShelterSite(shelterWorld({ groundY: () => 64 }), home);
  assert.equal(raised.y, 65, 'the ground is a block higher than spawn');
  assert.equal(c.findShelterSite(shelterWorld({ groundY: (x, z) => 63 + ((x + z) & 1) }), home), null, 'nowhere flat');
});

await check('Shelters: shelter goals are recognised, and the shelter check finds one a block above spawn', async () => {
  const c = vm.createContext({ setInterval() {}, Date });
  vm.runInContext(farmGoalSrc(), c);
  assert.equal(c.farmTaskFor('go home and build a small shelter there'), 'shelter');
  assert.equal(c.farmTaskFor("No roof over my head yet... I'm building a quick shelter nearby"), 'shelter');
  assert.equal(c.farmTaskFor('go to the shelter and wait'), null);
  // A complete shelter whose floor is at spawn height + 1: the old check only looked at spawn height.
  const s = shelterFns();
  const solid = new Set(s.shelterPositions(new V3(0, 65, 0)).map((p) => `${p.x},${p.y},${p.z}`));
  const bot = { spawnPoint: new V3(0, 64, 0),
    blockAt: (p) => ({ boundingBox: p.y <= 64 || solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' }) };
  const h = vm.createContext({ bot, Math });
  vm.runInContext(between(index, 'function shelterGeometryPositions(', 'const BUILDER_ITEM_STALL_LIMIT'), h);
  assert.equal(h.hasShelterNearHome(), true);
});

await check('Shelters: a shelter goal gets materials (planks from her logs), builds on its site, and is done when it stands', async () => {
  const inv = [{ name: 'oak_log', count: 3 }];
  let standing = false; const calls = []; const done = [];
  const performAction = async (b, action) => {
    calls.push(action.type + (action.item ? `:${action.item}` : '') + (action.block ? `:${action.block}` : ''));
    if (action.type === 'craft') { inv.push({ name: 'oak_planks', count: 40 }); return { ok: true, text: 'crafted planks' }; }
    if (action.type === 'build') { standing = true; return { ok: true, text: 'built a small shelter', built: true }; }
    return { ok: false, text: '?' };
  };
  const s = shelterFns();
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Amy', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, spawnPoint: new V3(0, 64, 0), inventory: { items: () => inv }, entities: {},
      blockAt: () => ({ boundingBox: 'empty' }) },
    Vec3: V3, performAction, narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async (status) => { done.push(status); }, retireGoal: async () => {}, saveGoalIfCurrent: async () => {},
    logStep: () => {}, farmStatus: () => ({ ripe: 0, growing: 0 }), loadPenLocation: async () => null, LIVESTOCK: [],
    BREEDING_FOOD: {}, countInPen: () => 0, findPenSite: () => null, woolCounts: () => ({}), bedItemFor: () => 'white_bed',
    hasShelterNearHome: () => standing, findShelterSite: () => new V3(1, 64, 1), shelterPositions: s.shelterPositions,
    shelterMaterialCount: (b) => b.inventory.items().filter((i) => /_(planks|log)$/.test(i.name)).reduce((n, i) => n + i.count, 0) });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { description: 'go home and build a small shelter there', createdAt: Date.now(), consecutiveFailures: 0 };
  for (let i = 0; i < 4 && !done.length; i++) await c.runShelterGoal(goal, async () => true, () => ({ release() {} }), () => false);
  assert.deepEqual(calls, ['craft:oak_planks', 'build']);
  assert.deepEqual(done, ['done']);
  assert.deepEqual({ ...goal.shelterAt }, { x: 1, y: 64, z: 1 });
});

console.log(`${passed} unit checks passed.`);
