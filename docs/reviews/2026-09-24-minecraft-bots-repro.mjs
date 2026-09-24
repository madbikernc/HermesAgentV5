// Version: 1.0.0
// Review-only source-extraction checks. No Minecraft connection or dependencies needed.
// Revision History: 1.0.0 | 2026-09-24 | Initial behavioral defect reproductions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../services/minecraft-bots/', import.meta.url));
const actions = await readFile(root + 'actions.js', 'utf8');
const index = await readFile(root + 'index.js', 'utf8');
const equipment = await readFile(root + 'equipment.js', 'utf8');
const skills = await readFile(root + 'skills.js', 'utf8');
const arbiter = await import(root + 'arbiter.js');
function between(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, start);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert(to > from, end);
  return source.slice(from, to).replace(/export /g, '');
}
const actionFn = between(actions, 'export async function performAction(');
const stopFn = between(actions, 'function stopCurrent(', 'export async function performAction(');
const timeoutFn = between(actions, 'function withTimeout(', 'function simpleSourceFor(');
function makeBot() {
  return {
    pathfinder: { setGoal(g) { this.goal = g; }, movements: { canDig: true } },
    pvp: { target: null, attacks: 0, stop() {}, attack() { this.attacks++; } },
    collectBlock: { cancelTask() {} }, stopDigging() {},
    inventory: { items: () => [], slots: [] }, entities: {}, players: {},
    getEquipmentDestSlot: () => 45,
  };
}
function context(bot, extras = {}) {
  return vm.createContext({ bot, console, setTimeout, clearTimeout, ...arbiter,
    ACTION_TIMEOUT_MS: 50, equipBestWeapon: async () => {}, refreshGear: async () => {},
    goals: { GoalNear: class {}, GoalFollow: class {} }, ...extras });
}
async function check(name, fn) { await fn(); console.log('CONFIRMED: ' + name); }
await check('attack waits and times out without starting combat', async () => {
  const bot = makeBot(); bot.entities[1] = { id: 1 };
  const c = context(bot); vm.runInContext(stopFn + timeoutFn + actionFn, c);
  const result = await c.performAction(bot, { type: 'attack', target: bot.entities[1], maxDurationMs: 0 }, 'test');
  assert.equal(bot.pvp.attacks, 0); assert.equal(result.ok, false);
});
await check('teleport-style cancelAndRotate leaves routine control occupied', async () => {
  const bot = makeBot(); const token = arbiter.cancelAndRotate(bot);
  assert.equal(arbiter.isBusy(), true);
  assert.equal(await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP, { waitMs: 0 }), null);
  arbiter.releaseControl({ token });
});
await check('a preempted caller can start an action under the emergency token', async () => {
  const bot = makeBot(); bot.players.test = { entity: {} };
  const old = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP);
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  const c = context(bot); vm.runInContext(stopFn + actionFn, c);
  assert.equal(old.token.cancelled, true);
  const result = await c.performAction(bot, { type: 'follow' }, 'test');
  assert.equal(result.ok, true); assert(bot.pathfinder.goal);
  assert.equal(arbiter.currentOwner(), 'HEALTH_CRITICAL'); emergency.release();
});
await check('cancelled recovery reports success and suppresses its retry condition', async () => {
  const bot = makeBot(); let rejectGoto;
  bot.pathfinder.goto = () => new Promise((_, reject) => { rejectGoto = reject; });
  const recovery = await arbiter.requestControl(bot, arbiter.OWNERS.RECOVERY);
  const c = context(bot); vm.runInContext(stopFn + timeoutFn + actionFn, c);
  const pending = c.performAction(bot, { type: 'recover', position: { x: 1, y: 2, z: 3 } }, 'test');
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  bot.pathfinder.goal = 'emergency-path';
  rejectGoto(new Error('The goal was changed'));
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(recovery.token.preempted, true);
  assert.equal(result.ok || !recovery.token.preempted, true);
  assert.equal(bot.pathfinder.goal, null); emergency.release();
});
await check('armor selection downgrades and then oscillates with spare armor', async () => {
  const worn = { name: 'netherite_helmet' }; const spare = { name: 'leather_helmet' };
  let carried = [spare]; let equipped = worn;
  const bot = { inventory: { items: () => carried }, async equip(item) { carried = [equipped]; equipped = item; } };
  const c = vm.createContext({ console });
  vm.runInContext(between(equipment, 'const MATERIAL_TIER', 'export const WEAPON_SUFFIXES') +
    between(equipment, 'export async function equipBestArmor(', 'export async function equipBestWeapon('), c);
  await c.equipBestArmor(bot); assert.equal(equipped.name, 'leather_helmet');
  await c.equipBestArmor(bot); assert.equal(equipped.name, 'netherite_helmet');
});
await check('goal parser rejects GOHOME required by Builder goals', async () => {
  const c = vm.createContext({ console: { log() {} }, USERNAME: 'Amy' });
  vm.runInContext(between(index, 'function parseGoalStep(', 'async function planNextStep('), c);
  assert.equal(c.parseGoalStep('ACTION GOHOME').type, 'blocked');
});
await check('fallback coordinator Mark is rejected at the message entry point', async () => {
  let classified = false;
  const c = vm.createContext({ bot: { username: 'Amy' }, MATRIX_USER_ID: '@mc-amy:spark', USERNAME: 'Amy',
    isAnotherBot: (s) => ['Mark', 'Mayor'].includes(s), isMayor: (s) => s === 'Mayor',
    classifyIntent: async () => { classified = true; } });
  vm.runInContext(between(index, 'function handleIncoming(', 'bot.on("chat"'), c);
  c.handleIncoming('Mark', 'Amy, gather wood', { alreadyAddressed: false, send() {} });
  assert.equal(classified, false);
});
await check('skill runner advances after a cancelled step reported as ok', async () => {
  const c = vm.createContext({});
  vm.runInContext(between(skills, 'export async function runSkill(', 'export async function recordSkillOutcome('), c);
  const executed = [];
  const result = await c.runSkill(async (_, action) => { executed.push(action.type); return { ok: true, text: 'stopped early' }; }, {},
    { name: 'example', steps: [{ type: 'mine' }, { type: 'craft' }] }, 'test');
  assert.deepEqual(executed, ['mine', 'craft']); assert.equal(result.ok, true);
});
await check('old goal action writes its result into a replacement goal', async () => {
  const bot = makeBot(); let finish;
  const oldGoal = { description: 'old goal', servedBySkill: true, log: [], steps: 0 };
  const newGoal = { description: 'new goal', servedBySkill: true, log: [], steps: 0 };
  const c = vm.createContext({ console: { log() {}, error() {} }, bot, arbiter, busy: false,
    AUTONOMY_ENABLED: true, currentGoal: oldGoal, USERNAME: 'Amy', PERSONA_NAME: 'amy', MAX_CONSECUTIVE_FAILURES: 3,
    planNextStep: async () => 'ACTION ATTACK', parseGoalStep: () => ({ type: 'step', action: { type: 'attack' } }),
    performAction: () => new Promise(resolve => { finish = resolve; }),
    logStep: (goal, line) => { goal.log.push(line); goal.steps++; }, saveGoal: async () => {} });
  vm.runInContext(between(index, 'async function goalTick(', 'setInterval(() => {'), c);
  const pending = c.goalTick();
  while (!finish) await Promise.resolve();
  c.currentGoal = newGoal; finish({ ok: true, text: 'old work result' }); await pending;
  assert.equal(oldGoal.steps, 0); assert.equal(newGoal.steps, 1);
  assert.match(newGoal.log[0], /old work result/);
});
console.log('9 source-level behavior checks confirmed. These demonstrate defects; they are not fix-validation tests.');
