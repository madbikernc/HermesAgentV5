// Version: 1.0.0
//
// Unit checks: gathering and mining.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/gathering.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, arbiter, V3, between, actionFn, timeoutFn, makeBot, context, sleep, check, goalTickContext, slice, passedCount } from './_harness.mjs';


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


await check('Tier 2: checkLocationSharing runs noteNearbyResources on a standing cadence, not just as a side effect', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 4 -- "makes it an explicit tier item so a bot
  // who's otherwise idle can go looking specifically to report back, not just incidentally while
  // doing something else"). No arbiter/busy gate needed -- noteNearbyResources() is a pure,
  // no-movement scan, same as when mine/explore/craft already trigger it as a side effect.
  let calls = 0;
  const bot = { entity: { position: {} } };
  const c = vm.createContext({ setInterval() {}, console: { error() {} },
    AUTONOMY_ENABLED: true, bot, noteNearbyResources: async (reason) => { calls++; assert.match(reason, /location sweep/); } });
  vm.runInContext(between(index, 'async function checkLocationSharing(', 'setInterval(() => {\n  checkLocationSharing'), c);
  await c.checkLocationSharing();
  assert.equal(calls, 1, 'runs while loaded in and autonomous');
  bot.entity = null;
  await c.checkLocationSharing();
  assert.equal(calls, 1, 'skipped while not loaded in (no entity yet)');
  bot.entity = { position: {} };
  vm.runInContext('AUTONOMY_ENABLED = false', c);
  await c.checkLocationSharing();
  assert.equal(calls, 1, 'skipped while autonomy is off');
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


await check('MB-10 an interrupted skill replay is not scored and can run again', async () => {
  const bot = makeBot(); let scored = 0;
  const goal = { description: 'g', servedBySkill: false, log: [], steps: 0, consecutiveFailures: 0 };
  const c = goalTickContext(bot, { currentGoal: goal, findSkill: async () => ({ name: 's', jsonPath: 's.json', steps: [] }),
    runSkill: async () => ({ ok: false, cancelled: true, text: 'interrupted' }), recordSkillOutcome: async () => { scored++; } });
  await c.goalTick();
  assert.equal(scored, 0); assert.equal(goal.servedBySkill, false); assert.equal(goal.consecutiveFailures, 0);
});


// 2026-10-28: wood gathered "in fits and starts" -- a path timeout mid-dig used to fail the whole
// collect and abort the swing (the block heals). collectBlocks() lets the dig finish and retries.
await check('Collect: a path timeout mid-dig lets the swing finish, then retries instead of failing', async () => {
  const c = vm.createContext({ console: { log() {} }, setTimeout, Promise, Date });
  vm.runInContext(between(actions, 'const COLLECT_THINK_TIMEOUT_MS', 'function simpleSourceFor('), c);
  const log = { type: 5, position: new V3(1, 65, 1) };
  let mining = true, attempts = 0, thinkSeen = 0;
  const bot = { username: 'Babs', blockAt: () => ({ type: 5 }),
    pathfinder: { thinkTimeout: 1000, isMining: () => mining },
    collectBlock: { collect: async () => {
      attempts++; thinkSeen = bot.pathfinder.thinkTimeout;
      if (attempts === 1) {
        setTimeout(() => { mining = false; }, 30);
        throw Object.assign(new Error('Took to long to decide path to goal!'), { name: 'Timeout' });
      }
      assert.equal(mining, false, 'the retry waited for the in-flight dig instead of aborting it');
    } } };
  await c.collectBlocks(bot, { cancelled: false }, [log]);
  assert.equal(attempts, 2, 'one timeout is retried, not reported as a failed mine');
  assert(thinkSeen >= 3000, 'tree searches get a wider think window than the 1000ms default');
  assert.equal(bot.pathfinder.thinkTimeout, 1000, 'the global think window is restored afterwards');

  attempts = 0;
  bot.collectBlock.collect = async () => { attempts++; throw new Error('digging aborted'); };
  await assert.rejects(c.collectBlocks(bot, { cancelled: false }, [log]), /digging aborted/);
  assert.equal(attempts, 1, 'a non-path error is not retried');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
