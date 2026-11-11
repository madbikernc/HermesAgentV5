// Version: 1.0.0
//
// Unit checks: builder priorities and placement.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/builder.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { index, arbiter, V3, between, actionFn, timeoutFn, makeBot, context, sleep, check, builderClaimsWorld, passedCount } from './_harness.mjs';


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
  vm.runInContext('var currentGoal = this.currentGoal;' + between(index, 'async function retireGoal(', '// Direct request, 2026-10-28 ("the 45 second'), c);
  const pending = c.goalTick();
  while (!finish) await sleep(1);
  vm.runInContext('currentGoal = this.newGoal', Object.assign(c, { newGoal }));
  finish({ ok: true, text: 'old work result' }); await pending;
  assert.equal(newGoal.steps, 0); assert.equal(newGoal.log.length, 0);
  assert.equal(cleared, 0); assert.equal(saved, 0);
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


await check('MB-08 place_home walks home, then places the item', async () => {
  const bot = makeBot(); const steps = [];
  // A real V3 and a coordinate-based world, not a position stub with a fake offset(): "place" now
  // asks wouldBlockAccess about the candidate cell, which walks the cell's own neighbours.
  bot.spawnPoint = { x: 10, y: 64, z: 10 };
  bot.entity = { position: new V3(0, 64, 0) };
  bot.inventory.items = () => [{ name: 'furnace' }];
  bot.pathfinder.goto = async () => { steps.push('goto-home'); };
  bot.equip = async () => {};
  bot.blockAt = (p) => ({ name: 'stone', position: p, boundingBox: p.y <= 63 ? 'block' : 'empty',
    getProperties: () => ({}) });
  bot.placeBlock = async () => { steps.push('place'); };
  const c = context(bot, { Vec3: class {}, attemptBoatCrossing: async () => false });
  vm.runInContext(timeoutFn + actionFn, c);
  const result = await c.performAction(bot, { type: 'place_home', item: 'furnace' }, 'test');
  assert.equal(result.ok, true, result.text); assert.deepEqual(steps, ['goto-home', 'place']);
  bot.inventory.items = () => [];
  const none = await c.performAction(bot, { type: 'place_home', item: 'furnace' }, 'test');
  assert.equal(none.ok, false);
});


await check('Builder claims: a live claim blocks another bot on the same item, not a different one', async () => {
  const shared = {}; // the same mock store, shared by both bots -- same hermes-memory row set
  const amy = await builderClaimsWorld('Amy', { shared });
  const babs = await builderClaimsWorld('Babs', { shared });
  assert.equal(await amy.c.claimBuilderItem(amy.bot, 'furnace'), true, 'unclaimed -- she gets it');
  assert.equal(await amy.c.myBuilderClaim(amy.bot), 'furnace');
  assert.equal(await babs.c.claimBuilderItem(babs.bot, 'furnace'), false, "Amy already holds it -- Babs doesn't get it too");
  assert.equal(await babs.c.claimBuilderItem(babs.bot, 'chest'), true, 'a different item is still free');
});


await check('Builder claims: releasing frees the item, and a stale claim expires on its own', async () => {
  const w = await builderClaimsWorld('Amy');
  await w.c.claimBuilderItem(w.bot, 'furnace');
  await w.c.releaseBuilderItem(w.bot);
  assert.equal(await w.c.myBuilderClaim(w.bot), null);
  const other = await builderClaimsWorld('Babs', { shared: { Amy: { item: 'furnace', claimedAt: Date.now() } } });
  assert.equal(await other.c.claimBuilderItem(other.bot, 'furnace'), false, 'a fresh claim still blocks');
  const stale = await builderClaimsWorld('Babs',
    { shared: { Amy: { item: 'furnace', claimedAt: Date.now() - 20 * 60_000 } } }); // older than BUILDER_CLAIM_TTL_MS (10 min)
  assert.equal(await stale.c.claimBuilderItem(stale.bot, 'furnace'), true,
    "a dead bot's stale claim doesn't block the fleet's infrastructure forever");
});


await check('Tier 2: builderPriorityItemSatisfied stays in lockstep with builderPriorityCandidates for the same usability signal', async () => {
  // Real bug risk flagged in review: builderPriorityCandidates() and builderPriorityItemSatisfied()
  // both decide crafting_table/furnace/chest from the SAME isUtilityUsable-backed check -- if only
  // one were fixed, a bot could see "furnace still needed" in the checklist while being told "yes,
  // done" right after placing a 2nd furnace next to a broken 1st one. This proves they agree.
  let usable = 0;
  const c = vm.createContext({ bot: { registry: { blocksByName: {} } },
    countNearHome: () => 0, countUsableNearHome: () => usable, hasOwnShelterWithBed: () => false,
    residencePlan: () => ({ kind: 'done', beds: 1, active: 1 }),
    countQualifyingSheltersNearHome: () => 0, communalShelterSatisfied: () => false,
    getAchievements: () => [], fleetHasReachedIronTools: () => false,
    BOT_USERNAMES: new Set(['amy']) });
  vm.runInContext(between(index, 'function builderPriorityCandidates(', 'function builderPriorityItemSatisfied('), c);
  vm.runInContext(between(index, 'function builderPriorityItemSatisfied(', 'const SOLDIER_PATROL_RANGE'), c);
  assert.equal(c.builderPriorityCandidates().some((x) => x.name === 'furnace'), true, 'unusable -- candidates lists it');
  assert.equal(c.builderPriorityItemSatisfied('furnace'), false, 'unusable -- NOT satisfied, matching candidates');
  usable = 1;
  assert.equal(c.builderPriorityCandidates().some((x) => x.name === 'furnace'), false, 'usable -- candidates drops it');
  assert.equal(c.builderPriorityItemSatisfied('furnace'), true, 'usable -- satisfied, matching candidates');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
