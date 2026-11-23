// Version: 1.3.0
// 1.3.0 (2026-11-22): new checks for mine.js 1.1.0's wood-family climb-to-surface fallback
// (action-search.js 1.1.0's climbTowardSurface()), and that ore/stone never triggers it.
// 1.2.0 (2026-11-22): new checks for nextOpportunisticGather() (priorities.js 1.2.0) and its
// dedicated runner, runOpportunisticGatherGoal() (goal-runners.js 1.3.0).
// 1.1.1 (2026-11-13): index.js 3.0.0 split into subject modules -- the end marker is the next declaration, not the periodic check that stayed in index.js.
//
// 1.1.0 (2026-11-10): slices read the split modules (actions/*.js via actionCases/actionHandlerSrc, the modules out of index.js via index/indexOnly), and sandboxes stub guardedInterval.
//
// Unit checks: gathering and mining.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/gathering.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, prioritiesSrc, arbiter, V3, between, actionFn, timeoutFn, makeBot, context, sleep, check, goalTickContext, slice, passedCount } from './_harness.mjs';


await check('MB-11 fallback coordinator accepted once Mayor is unreachable; server echoes ignored', async () => {
  let classified = 0;
  const c = vm.createContext({ bot: { username: 'Amy' }, MATRIX_USER_ID: '@mc-amy:spark', USERNAME: 'Amy',
    MAYOR_USERNAME: 'Mayor', MAYOR_LIVENESS_TIMEOUT_MS: 0, lastMayorSeenAt: 0, busy: false,
    lastActivityAt: 0, setInterval() {}, guardedInterval() {}, Date, process: { env: {} },
    isAnotherBot: (s) => ['Mark', 'Mayor', 'Luke'].includes(s), isMayor: (s) => s === 'Mayor',
    classifyIntent: async () => { classified++; return { type: 'none' }; }, console: { log() {}, error() {} } });
  vm.runInContext('var lastMayorSeenAt = 0;' + between(index, 'const PROCESS_STARTED_AT', 'guardedInterval(goalHeartbeatTick') +
    between(index, 'const NON_PLAYER_SPEAKERS', 'function watchFleetTopics('), c);
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
  const c = vm.createContext({ setInterval() {}, guardedInterval() {}, console: { error() {} },
    AUTONOMY_ENABLED: true, bot, noteNearbyResources: async (reason) => { calls++; assert.match(reason, /location sweep/); } });
  vm.runInContext(between(index, 'async function checkLocationSharing(', 'const CHEST_CONSOLIDATION_CHECK_MS'), c);
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

await check('Opportunistic gather: a nearby ore she can break becomes a goal; wood and an unmet tool tier do not', async () => {
  // Direct report, 2026-11-22 ("bots need to be opportunistic. if they find themselves near a
  // minable resource other than wood or grass, they should gather it... particularly true of
  // in-ground or underground resources like coal, ore, redstone, lapis lazuli").
  const items = [];
  let lastMatching = null;
  const bot = { inventory: { items: () => items },
    // oak_log has a real registry id too -- a test that only omitted it from the registry
    // wouldn't actually prove the "_log"/"_stem" exclusion filter is doing anything.
    registry: { blocksByName: { coal_ore: { id: 10 }, iron_ore: { id: 11 }, oak_log: { id: 12 } } },
    findBlocks: () => [], blockAt: () => null };
  const c = vm.createContext({ bot,
    getResourceBlockNames: () => ['coal_ore', 'iron_ore', 'oak_log'], MINE_SEARCH_RADIUS: 32 });
  vm.runInContext(between(prioritiesSrc, 'export function nextOpportunisticGather('), c);

  assert.equal(c.nextOpportunisticGather(), null, 'nothing nearby');

  bot.findBlocks = (opts) => { lastMatching = opts.matching; return [{ x: 1, y: 64, z: 1 }]; };
  bot.blockAt = () => ({ name: 'coal_ore' }); // no harvestTools entry -- minable by hand
  const coal = c.nextOpportunisticGather();
  assert.deepEqual(lastMatching, [10, 11], 'oak_log (id 12) dropped from the search -- wood is not opportunistic');
  assert.equal(coal.name, 'opportunistic_gather');
  assert.equal(coal.block, 'coal_ore');

  bot.blockAt = () => ({ name: 'iron_ore', harvestTools: { 999: true } });
  assert.equal(c.nextOpportunisticGather(), null, 'needs a pickaxe she does not have yet');
  items.push({ type: 999, name: 'stone_pickaxe' });
  assert.equal(c.nextOpportunisticGather().block, 'iron_ore', 'now holds the right tool');
});


await check('Opportunistic gather: a tagged goal mines the spotted block once and finishes; real failures still give up', async () => {
  const calls = []; const outcomes = [];
  let reply = { ok: true, text: 'collected some coal_ore.' };
  const bot = makeBot();
  bot.chat = () => {};
  bot.spawnPoint = new V3(0, 64, 0);
  const goal = { description: "there's some coal_ore right nearby -- worth mining while you're here.",
    source: 'self', opportunisticGather: 'opportunistic_gather', gatherBlock: 'coal_ore',
    log: [], steps: 0, consecutiveFailures: 0 };
  const c = goalTickContext(bot, { currentGoal: goal,
    performAction: async (_b, action) => { calls.push(action); return reply; },
    narrateAction: async (t) => t, recordGoalOutcome: (_d, outcome) => outcomes.push(outcome), broadcastGoalState: async () => {} });
  await c.goalTick();
  // calls[0] was built inside the vm realm (performAction's own argument object literal), not
  // reference-equal to an outer-realm literal even when structurally identical -- spread it out.
  assert.deepEqual(calls.map((a) => ({ ...a })), [{ type: 'mine', block: 'coal_ore', count: 4 }]);
  assert.deepEqual(outcomes, ['done']);
  assert.equal(vm.runInContext('currentGoal', c), null, 'goal retired on success');

  reply = { ok: false, text: 'could not find any coal_ore nearby.' };
  const failGoal = { description: 'mine coal_ore', opportunisticGather: 'opportunistic_gather', gatherBlock: 'coal_ore',
    log: [], steps: 0, consecutiveFailures: 0 };
  const c2 = goalTickContext(bot, { currentGoal: failGoal,
    performAction: async (_b, action) => { calls.push(action); return reply; },
    narrateAction: async (t) => t, recordGoalOutcome: (_d, outcome) => outcomes.push(outcome), broadcastGoalState: async () => {} });
  await c2.goalTick(); await c2.goalTick(); await c2.goalTick();
  assert.equal(outcomes.filter((o) => o === 'gave up').length, 1, 'three real failures give up, like every other dedicated runner');

  assert.match(index, /if \(goal\.gatherBlock\) \{\s+await runOpportunisticGatherGoal/,
    'goalTick dispatches a gatherBlock-tagged goal to the dedicated runner, not the freeform planner');
  assert.match(index,
    /const gather = nextOpportunisticGather\(\);[\s\S]*?currentGoal\.gatherBlock = gather\.block;[\s\S]*?return;[\s\S]*?const gearNote = describeGear/,
    'proposeOwnGoal tags the goal before falling through to the freeform LLM self-propose call');
});


await check('Mine: a wood search that fails everywhere climbs toward the surface and tries again', async () => {
  // Direct report, 2026-11-22 ("some of the bots are underground, deep... thus no wood. They
  // should know to climb out to the surface to get wood"): confirmed live -- Nell repeated
  // "couldn't find any oak_log nearby, even after looking around" for hours, deep underground,
  // because wanderAndRetryFind only ever moves horizontally. mine.js 1.1.0's new fallback tries
  // climbTowardSurface() (action-search.js 1.1.0) once the ordinary search and wander both come
  // up empty, then searches again.
  const bot = makeBot();
  bot.entity = { position: new V3(5, 4, 5) };
  bot.registry = { blocks: { 1: { name: 'oak_log' } } };
  bot.blockAt = (p) => ({ name: 'oak_log', position: p, harvestTools: null });
  let findCalls = 0;
  bot.findBlocks = () => { findCalls++; return findCalls < 2 ? [] : [new V3(8, 64, 8)]; }; // nothing until after the climb
  let climbed = 0;
  const collected = [];
  bot.collectBlock = { collect: async (blocks) => collected.push(...blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`)), cancelTask() {} };
  const extras = { Vec3: V3, resolveBlockFamily: () => [1], itemNamesForMinedBlocks: () => ['oak_log'],
    tryTakeFromNearbyChest: async () => null, visitRememberedSpot: async () => [],
    wanderAndRetryFind: async () => [], climbTowardSurface: async () => { climbed++; },
    filterAwayFromOtherBots: (b, p) => p, isProtectedBlockName: () => false,
    MINE_SEARCH_RADIUS: 32, CONTENTION_SEARCH_OVERFETCH: 3, isLivingSpaceWall: () => false };
  const c = context(bot, extras);
  vm.runInContext(timeoutFn + actionFn, c);

  const result = await c.performAction(bot, { type: 'mine', block: 'oak_log', count: 1 }, 'test');
  assert.equal(climbed, 1, 'nothing found nearby or by wandering -- must climb toward the surface before giving up');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(collected, ['8,64,8'], 'the post-climb search found real wood and mined it');
});


await check('Mine: ore/stone never climbs toward the surface -- underground is exactly where it belongs', async () => {
  const bot = makeBot();
  bot.entity = { position: new V3(5, 4, 5) };
  bot.registry = { blocks: { 1: { name: 'coal_ore' } } };
  bot.blockAt = (p) => ({ name: 'coal_ore', position: p, harvestTools: null });
  bot.findBlocks = () => [];
  let climbed = 0;
  const extras = { Vec3: V3, resolveBlockFamily: () => [1], itemNamesForMinedBlocks: () => ['coal_ore'],
    tryTakeFromNearbyChest: async () => null, visitRememberedSpot: async () => [],
    wanderAndRetryFind: async () => [], climbTowardSurface: async () => { climbed++; },
    filterAwayFromOtherBots: (b, p) => p, isProtectedBlockName: () => false,
    MINE_SEARCH_RADIUS: 32, CONTENTION_SEARCH_OVERFETCH: 3, isLivingSpaceWall: () => false };
  const c = context(bot, extras);
  vm.runInContext(timeoutFn + actionFn, c);

  const result = await c.performAction(bot, { type: 'mine', block: 'coal_ore', count: 1 }, 'test');
  assert.equal(climbed, 0, 'ore is legitimately underground -- a failed ore search must never climb toward the surface looking for it');
  assert.equal(result.ok, false);
  assert.match(result.text, /couldn't find any coal_ore nearby, even after looking around\./);
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
