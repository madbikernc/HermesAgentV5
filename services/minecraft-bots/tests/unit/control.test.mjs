// Version: 1.2.1
// 1.2.1 (2026-11-13): index.js 3.0.0 split into subject modules -- the end marker is the next declaration, not the periodic check that stayed in index.js.
// 1.2.0 | 2026-11-11 | Partial drop acknowledgements and narration after releasing control.
//
// 1.1.0 (2026-11-10): slices read the split modules (actions/*.js via actionCases/actionHandlerSrc, the modules out of index.js via index/indexOnly), and sandboxes stub guardedInterval.
//
// Unit checks: goals, arbitration, commands and memory notes.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/control.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, skills, arbiter, V3, between, actionFn, actionSource, timeoutFn, makeBot, context, shelter, sleep, check, skillsSrc, router, goalTickContext, ragContext, farmGoalSrc, slice, passedCount } from './_harness.mjs';


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


await check('MB-08 goal parser accepts GOHOME', async () => {
  const c = vm.createContext({ console: { log() {} }, USERNAME: 'Amy' });
  vm.runInContext(between(index, 'function parseGoalStep(', 'async function planNextStep('), c);
  assert.deepEqual({ ...c.parseGoalStep('ACTION GOHOME').action }, { type: 'gohome' });
});


await check('MB-06 an addressed STOP is recognized without the model', async () => {
  const c = vm.createContext({ USERNAME: 'Amy', setInterval() {}, guardedInterval() {} });
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


await check('MB-02 a takeover closes the interrupted action\'s open window', async () => {
  const bot = makeBot(); let closed = 0;
  bot.currentWindow = { id: 3 }; bot.closeWindow = (w) => { closed++; bot.currentWindow = null; };
  const old = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  assert.equal(closed, 1); assert.equal(bot.currentWindow, null); assert.equal(old.token.preempted, true);
  emergency.release();
});


await check('MB-06 a bare "stop" from the player whose command is running stops the bot', async () => {
  const c = vm.createContext({ USERNAME: 'Amy', setInterval() {}, guardedInterval() {} });
  vm.runInContext(between(index, 'const STOP_MESSAGE', 'async function stopNow('), c);
  assert.equal(c.isStopFromActiveCommander('Steve', 'stop'), false, 'no command running');
  vm.runInContext('activeDirectSpeaker = "Steve"', c);
  assert.equal(c.isStopFromActiveCommander('Steve', 'stop!'), true);
  assert.equal(c.isStopFromActiveCommander('Alex', 'stop'), false, 'a different player');
});


await check('Give reports the actual partial drop without claiming recipient pickup', async () => {
  const drops = [];
  const bot = {
    players: { Amy: { entity: {} } },
    registry: { itemsByName: { raw_iron: { id: 7 } } },
    inventory: { count: () => 1 },
    pathfinder: { goto: async () => {}, setGoal() {} },
    toss: async (id, metadata, count) => { drops.push([id, metadata, count]); },
  };
  const c = vm.createContext({ GEAR_SUFFIXES: [], ACTION_TIMEOUT_MS: 100,
    goals: { GoalFollow: class {} }, withTimeout: (promise) => promise });
  vm.runInContext(between(actionSource('give'), 'export async function giveAction('), c);
  const result = await c.giveAction(bot, { player: 'Amy', item: 'raw_iron', count: 3 }, 'Babs', {});
  assert.deepEqual(drops, [[7, null, 1]]);
  assert.equal(result.droppedCount, 1);
  assert.equal(result.text, 'dropped 1 raw_iron near Amy.');
});

await check('MB-13 a failed delivery is retried once; a success is acknowledged', async () => {
  const published = []; let outcome = { ok: false, text: 'nope' }; let held = false;
  const c = vm.createContext({ Date, console: { log() {}, error() {} }, USERNAME: 'Bob', AUTONOMY_ENABLED: true,
    bot: { isSleeping: false, chat() {} }, AGENT_ID: 'mc-bob', settleGiveClaims() {}, routineBlocked: () => false,
    arbiter: { requestControl: async () => {
      held = true;
      return { release() { held = false; } };
    }, OWNERS: { ROUTINE: {} } },
    performAction: async () => outcome, narrateAction: async (t) => {
      assert.equal(held, false, 'narration must not hold the bot body');
      return t;
    },
    buzzPublish: async (_, __, body) => { published.push(JSON.parse(body)); } });
  vm.runInContext('var pendingGiveRequest = { forPlayer: "Amy", item: "oak_log", count: 2, requestId: "r1", attempts: 0, expiresAt: Date.now() + 60000 };' +
    between(index, 'async function checkPendingGiveRequests(', 'const INVENTORY_CHECK_MS'), c);
  await c.checkPendingGiveRequests();
  assert.equal(vm.runInContext('pendingGiveRequest?.attempts', c), 1, 'queued for one retry');
  await c.checkPendingGiveRequests();
  assert.equal(vm.runInContext('pendingGiveRequest', c), null, 'dropped after the retry');
  vm.runInContext('pendingGiveRequest = { forPlayer: "Amy", item: "oak_log", count: 2, requestId: "r2", attempts: 0, expiresAt: Date.now() + 60000 }', c);
  outcome = { ok: true, text: 'dropped 1 oak_log near Amy.', droppedCount: 1 };
  await c.checkPendingGiveRequests();
  assert.deepEqual(published.map((p) => [p.type, p.requestId, p.count]), [['delivered', 'r2', 1]],
    'acknowledge the actual drop count, which may be smaller than the request');
});


await check('Fairness: routine checks that lose their turn are counted', async () => {
  const c = vm.createContext({ busy: true, arbiter: { isBusy: () => false }, setInterval() {}, guardedInterval() {}, console, USERNAME: 'Amy', JSON, Object });
  vm.runInContext('var busy = this.busy;' + between(index, 'const ROUTINE_SKIP_REPORT_MS', '\n// Goal-identity guards'), c);
  assert.equal(c.routineBlocked('checkHunger'), true);
  assert.equal(c.routineBlocked('checkHunger'), true);
  vm.runInContext('busy = false', c);
  assert.equal(c.routineBlocked('checkSaplings'), false);
  assert.deepEqual({ ...vm.runInContext('routineSkips', c) }, { checkHunger: 2 });
});


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


await check('MB-23 classifyIntent() exempts a verified bot sender from full screening, never a player (S34)', async () => {
  let lastOptions;
  const c = vm.createContext({ console: { log() {}, error() {} },
    OTHER_BOTS: [], USERNAME: 'Amy', SCOUT_FEATURE_BLOCKS: {},
    isAnotherBot: (s) => ['Mark', 'Mayor', 'Luke'].includes(s),
    callRole: async (_role, _messages, options) => { lastOptions = options; return 'NONE'; } });
  vm.runInContext(between(index, 'async function classifyIntent(', 'async function narrateAction('), c);

  await c.classifyIntent('Mayor', 'Everyone, let\'s get full iron armor');
  assert.equal(lastOptions.analysis, true,
    'a verified bot sender (Mayor, already gated through isAnotherBot upstream) must not take the full-screening path');

  await c.classifyIntent('SomePlayer', 'Amy, gather wood');
  assert.equal(lastOptions.analysis, false,
    'an ordinary player must still take the full-screening path, even typing a Mayor-shaped directive');
});


await check('MB-21 RAG subprocesses carry a timeout (local mode)', async () => {
  const calls = [];
  const c = ragContext({ RAG_URL: '', execFileAsync: async (cmd, args, opts) => { calls.push([args, opts]); return { stdout: '[]' }; } });
  await c.ragSearch('q', { corpus: 'minecraft-skills', topK: 2 });
  assert.equal(calls[0][1].timeout, 30000);
  assert.deepEqual([...calls[0][0]], ['s.py', 'q', '--top-k', '2', '--corpus', 'minecraft-skills']);
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


await check('Remembered spots: the nearest one wins, and one found empty on arrival is forgotten', async () => {
  // 2026-10-28 (direct report: "why do they keep returning to 24/67/-88?"): the first semantic
  // hit, a bed at (23, 68, -95) that no longer existed, won every night -- 97 failed sleeps in
  // 10 hours -- while a real noted bed at (-6, 64, -56) went unused.
  const notes = [
    { text: 'Built a bed near (23, 68, -95), as of 2026-10-28T04:30:24.016Z.' },
    { text: 'Found birch_log near (25, 67, -82), as of 2026-10-26.' },
    { text: 'Built a bed near (-6, 64, -56), as of 2026-10-28T06:27:07.723Z.' },
  ];
  const visited = [];
  const c = vm.createContext({ Vec3: V3, console, EXPLORE_TIMEOUT_MS: 1000,
    searchMemory: async () => notes,
    withTimeout: (p) => p,
    goals: { GoalNear: class { constructor(x, y, z) { visited.push(new V3(x, y, z)); } } },
    bot: { username: 'Babs', entity: { position: new V3(25, 67, -91) }, pathfinder: { goto: async () => {}, setGoal() {} } } });
  vm.runInContext(between(actions, 'const MEMORY_POSITION_PATTERN', 'async function wanderAndRetryFind('), c);

  assert.deepEqual(await c.findRememberedLocation('bed', new V3(-10, 64, -50)), new V3(-6, 64, -56),
    'nearest to where she stands, not the first search hit');
  const token = { cancelled: false };
  let beds = [];
  assert.deepEqual(await c.visitRememberedSpot(c.bot, token, 'bed', () => beds), [], 'nothing at the first spot');
  assert.deepEqual(visited.at(-1), new V3(23, 68, -95), 'she went to the nearest remembered bed first');
  beds = [new V3(-6, 64, -56)];
  assert.deepEqual(await c.visitRememberedSpot(c.bot, token, 'bed', () => beds), beds, 'a real bed there is found');
  assert.deepEqual(visited.at(-1), new V3(-6, 64, -56), 'the empty spot is forgotten -- next time the next bed');
  assert.deepEqual(await c.findRememberedLocation('bed'), new V3(-6, 64, -56), 'and it stays remembered');
});


await check('Dedicated runners get a much longer failure leash than the freeform planner', async () => {
  // Real bug found live 2026-10-16 (direct report: "check the last 24 hours behavior logs for
  // incorrect behaviors"). MAX_CONSECUTIVE_FAILURES=3 was shared between the freeform planner
  // (where 3 genuinely means "stuck, re-plan from scratch") and the dedicated runners (bedStep/
  // shelterStep/weaponStep/toolStep/farmGoal/ranchGoal/communalShelterStep), built on the
  // OPPOSITE philosophy: resilient to being interrupted and resumed on the next tick, never
  // meant to give up. Against the freshly reinitialized world's harder terrain, three transient
  // "No path to the goal" failures in a row abandoned the WHOLE goal -- losing accumulated
  // progress flags like triedWeaponChest/goal.shelterAt -- instead of just the one step.
  let retired = false;
  const c = vm.createContext({ setInterval() {}, guardedInterval() {}, Date, USERNAME: 'Amy', console, MAX_CONSECUTIVE_FAILURES: 3,
    recordGoalOutcome() {}, broadcastGoalState: async () => {},
    retireGoal: async () => { retired = true; }, saveGoalIfCurrent: async () => {} });
  vm.runInContext(farmGoalSrc(), c);

  const dedicated = { consecutiveFailures: 0, description: 'd', farmTask: 'shelter' };
  for (let i = 0; i < 19; i++) await c.failGoalStep(dedicated, 'no path');
  assert.equal(retired, false, 'a dedicated-runner goal survives well past the old 3-failure limit');
  assert.equal(dedicated.consecutiveFailures, 19);
  await c.failGoalStep(dedicated, 'no path'); // the 20th
  assert.equal(retired, true, 'but it does eventually give up, at 20');

  const weaponGoal = { consecutiveFailures: 0, description: 'w', survivalPriorityItem: 'weapon' };
  for (let i = 0; i < 19; i++) await c.failGoalStep(weaponGoal, 'no path');
  assert.equal(retired, true, 'already true from the dedicated case above'); // sanity: unchanged
  retired = false;
  await c.failGoalStep(weaponGoal, 'no path'); // the 20th for weaponGoal specifically
  assert.equal(retired, true, 'the weapon tag (survivalPriorityItem) gets the same long leash, not just farmTask');

  retired = false;
  const freeform = { consecutiveFailures: 0, description: 'f' }; // no farmTask, no survivalPriorityItem
  await c.failGoalStep(freeform, 'bad plan');
  await c.failGoalStep(freeform, 'bad plan');
  assert.equal(retired, false);
  await c.failGoalStep(freeform, 'bad plan'); // the 3rd
  assert.equal(retired, true, 'a plain freeform-planner goal still gives up at 3, unchanged');

  retired = false;
  const armorGoal = { consecutiveFailures: 0, description: 'armor', survivalPriorityItem: 'armor' };
  await c.failGoalStep(armorGoal, 'bad plan');
  await c.failGoalStep(armorGoal, 'bad plan');
  assert.equal(retired, false);
  await c.failGoalStep(armorGoal, 'bad plan'); // the 3rd
  assert.equal(retired, true,
    'armor is Tier 1 tagged but has no dedicated runner yet -- still the freeform 3-failure limit');
});


// 2026-10-28: "should the bots poll for a next action when a previous action concludes, rather
// than on a timer?" -- a tick that ran a step chains the next one; an empty tick does not.
await check('Goal loop: a finished step chains the next tick instead of waiting out the 45s timer', async () => {
  const timers = [];
  const goal = { steps: 0 };
  let ran = 0, step = true;
  const c = vm.createContext({ console: { error() {} }, USERNAME: 'Babs', process: { env: {} }, parseInt,
    currentGoal: goal, setTimeout: (fn, ms) => timers.push(ms), setInterval: () => {}, guardedInterval: () => {},
    goalTick: async () => { ran++; if (step) goal.steps++; } });
  vm.runInContext('var currentGoal = this.currentGoal;' +
    between(index, 'const GOAL_FOLLOWUP_MS', 'const MAYOR_DIRECTIVE_MS'), c);
  await c.runGoalTick();
  assert.deepEqual([...timers], [2000], 'a step ran: the next tick is queued 2s out');
  step = false;
  await c.runGoalTick();
  assert.equal(timers.length, 1, 'nothing ran (no control, night pause): fall back to the interval');
  assert.equal(ran, 2);
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
