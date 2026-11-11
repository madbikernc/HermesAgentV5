// Version: 1.0.0
//
// Unit checks: fighting, fleeing, hunting and guard duty.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/combat.test.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, arbiter, V3, between, actionFn, timeoutFn, makeBot, context, sleep, check, guardAnchorWorld, policyContext, slice, passedCount } from './_harness.mjs';


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


await check('MB-01 attack bails early on a noPath burst -- target sensed but unreachable', async () => {
  // Regression for the real 2026-10-22 finding: a Soldier with a wide self-defense range who
  // never flees, facing a target her pathfinder can never route to, used to poll the full
  // ACTION_TIMEOUT_MS every single time (206-266 such losses/bot/day on Luke/Mark). Four real
  // noPath results within NOPATH_BURST_WINDOW_MS now bail out well before the deadline --
  // confirmed here by never emitting entityDead at all and asserting the result lands fast.
  const bot = makeBot(); const target = { id: 3 }; bot.entities[3] = target;
  const c = context(bot); vm.runInContext(timeoutFn + actionFn, c);
  const started = Date.now();
  const pending = c.performAction(bot, { type: 'attack', target }, 'test');
  await sleep(10);
  for (let i = 0; i < 4; i++) bot.emit('path_update', { status: 'noPath' });
  const result = await pending;
  assert(Date.now() - started < 400, 'bailed well before the 400ms test ACTION_TIMEOUT_MS');
  assert.equal(result.ok, false);
  assert.match(result.text, /couldn't reach it/);
  assert(bot.entities[3], 'the target is still present -- this must not be mistaken for "lost track"');
});


await check('MB-01 a lone/transient noPath does not abandon a fight that then lands a real kill', async () => {
  const bot = makeBot(); const target = { id: 4 }; bot.entities[4] = target;
  const c = context(bot); vm.runInContext(timeoutFn + actionFn, c);
  const pending = c.performAction(bot, { type: 'attack', target }, 'test');
  await sleep(10);
  bot.emit('path_update', { status: 'noPath' });
  bot.emit('path_update', { status: 'noPath' });
  bot.emit('path_update', { status: 'success' }); // a real path found resets the burst counter
  bot.emit('entityDead', target); delete bot.entities[4];
  const result = await pending;
  assert.equal(result.ok, true); assert.match(result.text, /took care of it/);
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


await check('Soldier priorities: monster, then guard -- weapon/armor moved to the universal Tier 1', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md -- "Narrowed: weapon/armor move to Tier 1"): nextSoldierPriority()
  // no longer checks either itself -- nextSurvivalPriority() (tested separately below) now
  // intercepts both for every bot before this function is ever reached.
  // isGuardAnchor() mocked true (always the anchor) -- the anchor/escort split itself is a
  // separate concern, covered by its own test below.
  let threat = null;
  const c = vm.createContext({ bot: {}, nearestHostile: () => threat, FLEE_ONLY_MOBS: new Set(), SOLDIER_PATROL_RANGE: 32,
    isGuardAnchor: async () => true });
  vm.runInContext(between(index, 'async function nextSoldierPriority(', 'async function proposeOwnGoal('), c);
  threat = { name: 'zombie' }; assert.equal((await c.nextSoldierPriority()).name, 'monster'); threat = null;
  assert.equal((await c.nextSoldierPriority()).name, 'guard');
  assert.equal(Object.getOwnPropertyNames(c).includes('soldierArmorRetryAt'), false,
    'the old per-Soldier armor retry state is gone, not just unused');
});


await check('Guard anchor: one holder blocks a second bot, released or stale frees it for the next', async () => {
  const shared = {}; // the same mock store, shared by both bots
  const amy = await guardAnchorWorld('Amy', { shared });
  const babs = await guardAnchorWorld('Babs', { shared });
  const isAlwaysLive = () => true;
  assert.equal(await amy.c.holdsGuardAnchor(amy.bot, isAlwaysLive), true, 'empty slot -- she claims it');
  assert.equal(await babs.c.holdsGuardAnchor(babs.bot, isAlwaysLive), false, 'Amy already holds it');
  assert.equal(await amy.c.holdsGuardAnchor(amy.bot, isAlwaysLive), true, 'still hers on a later check');

  // Amy is no longer a live Soldier (dead/disconnected/reassigned) -- Babs takes over.
  const isLiveExceptAmy = (name) => name !== 'Amy';
  assert.equal(await babs.c.holdsGuardAnchor(babs.bot, isLiveExceptAmy), true, "Amy's stale claim frees the anchor");
  assert.equal(await amy.c.holdsGuardAnchor(amy.bot, isLiveExceptAmy), false, 'and Babs now genuinely holds it');
});


await check('Soldier priorities: one live Soldier is trivially the anchor; two or more contend for it', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md §2a): "with one, she patrols near home, unchanged from
  // today... with two or more, exactly one holds a claim to stay anchored... every other
  // Soldier's priority becomes escort/rescue."
  let threat = null;
  const otherBotGoalSeenAt = new Map();
  const holds = {};
  const SOLDIER_ROLE = { name: 'Soldier' };
  const c = vm.createContext({ bot: { username: 'Mark' }, nearestHostile: () => threat, FLEE_ONLY_MOBS: new Set(), SOLDIER_PATROL_RANGE: 32,
    USERNAME: 'Mark', BOT_USERNAMES: new Set(['Mark', 'Luke']), // matches BOT_USERNAMES' own capitalized convention
    BOT_ROLES: { mark: { primary: SOLDIER_ROLE }, luke: { primary: SOLDIER_ROLE } }, ROLES: { SOLDIER: SOLDIER_ROLE },
    otherBotGoalSeenAt, GOAL_LEASE_MS: 60_000, Date,
    holdsGuardAnchor: async (bot) => holds[bot.username] ?? false });
  vm.runInContext(between(index, 'function isLiveSoldier(', 'async function proposeOwnGoal('), c);

  assert.equal((await c.nextSoldierPriority()).name, 'guard', 'alone (Luke never seen) -- trivially the anchor, no claim touched');
  threat = { name: 'zombie' };
  assert.equal((await c.nextSoldierPriority()).name, 'monster', 'a real threat still outranks anchor/escort either way');
  threat = null;

  otherBotGoalSeenAt.set('mc-luke', Date.now()); // Luke heartbeats -- now a live, contending Soldier
  holds.Mark = false;
  assert.equal((await c.nextSoldierPriority()).name, 'escort', "Mark doesn't hold the claim -- escort, not guard");
  holds.Mark = true;
  assert.equal((await c.nextSoldierPriority()).name, 'guard', 'Mark holds the claim -- guard, as normal');

  otherBotGoalSeenAt.set('mc-luke', Date.now() - 120_000); // Luke's lease expired -- stale, not live
  assert.equal((await c.nextSoldierPriority()).name, 'guard', "Luke's own staleness also makes Mark trivially the anchor again");
});


await check('Fight-or-flee: armed bot at critical health fights a single melee or ranged mob', async () => {
  for (const mob of ['zombie', 'pillager']) {
    const { c, threat } = policyContext({ health: 5, mobs: [[mob, 3]] });
    assert.equal(c.decideFightType(threat), 'attack', mob);
  }
});


await check('Fight-or-flee: a healthy non-Soldier still fights one ordinary mob, not just a hurt or Soldier one', async () => {
  // Direct report, 2026-10-10 ("they still aren't fighting back when even a single mob is
  // attacking them"): this policy's own header says an armed bot fights a single threat
  // unconditionally, but nearby === 1 used to fall through to the consecutive-flee counter
  // instead, which starts at "flee." Confirmed live: Bob fled a single zombie at 11.8/20 health.
  const { c, threat } = policyContext({ health: 20, mobs: [['zombie', 3]] });
  assert.equal(c.decideFightType(threat), 'attack');
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


await check('attackAsLastResort: an unarmed bot who failed to flee still fights, bare-handed', async () => {
  const calls = [];
  const c = vm.createContext({ bot: {}, USERNAME: 'Mark', console: { log() {}, error() {} },
    FLEE_ONLY_MOBS: new Set(['phantom', 'ghast', 'enderman']), hasWeapon: () => false,
    performAction: async (_bot, action) => { calls.push(action); return { ok: true, text: 'took care of it.' }; } });
  vm.runInContext(between(index, 'async function attackAsLastResort(', 'async function fleeAsLastResort('), c);
  await c.attackAsLastResort({ name: 'zombie' }, 'self-defense', {});
  assert.equal(calls.length, 1, 'cannot run + unarmed used to stand there and take every hit for free');
  assert.equal(calls[0].type, 'attack');

  await c.attackAsLastResort({ name: 'phantom' }, 'self-defense', {});
  assert.equal(calls.length, 1, 'a genuinely unreachable mob (FLEE_ONLY_MOBS) is still skipped, armed or not');
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


await check('Hunt: goes for a spare animal -- never a species\' last two nearby -- and collects the meat', async () => {
  const inv = [];
  const at = (x) => new V3(x, 64, 0);
  const entities = { 1: { name: 'cow', position: at(2) }, 2: { name: 'cow', position: at(3) },
    3: { name: 'chicken', position: at(1) }, 4: { name: 'pig', position: at(9) }, 5: { name: 'pig', position: at(10) },
    6: { name: 'pig', position: at(11) } };
  const attacked = [];
  const c = vm.createContext({ Object, bot: { entity: { position: Object.assign(at(0), { clone() { return this; } }) }, entities, inventory: { items: () => inv } },
    FOOD_NAMES: ['porkchop', 'beef'], HUNTABLE_ANIMALS: new Set(['cow', 'pig', 'sheep']), HUNT_RANGE: 64,
    ok: (text) => ({ ok: true, text }), fail: (text) => ({ ok: false, text }),
    performActionAs: async (_b, action) => { attacked.push(action.target.name); return { ok: true }; },
    collectDrops: async () => { inv.push({ name: 'porkchop', count: 1 }); } });
  const hunt = between(actions, '    case "hunt": {', '\n    case "');
  vm.runInContext(`async function run(action, token, speaker = "test") { switch (action.type) {${hunt}} }`, c);
  let r = await c.run({ type: 'hunt' }, { cancelled: false });
  assert.deepEqual(attacked, ['pig'], 'the nearest spare: one of three pigs, not the two cows or the (here unlisted) chicken');
  assert.equal(r.ok, true);
  delete entities[4]; delete entities[5]; inv.length = 0; attacked.length = 0;
  r = await c.run({ type: 'hunt' }, { cancelled: false });
  assert.deepEqual(attacked, [], 'a pair and a lone pig left: nothing to spare');
  assert.equal(r.ok, false);
});


await check('Hunt: chickens within 64 blocks are prey, and raw chicken is food, eaten last', async () => {
  // 2026-11-01, Babs and Amy live: at food 0 for a day, no spare cow/pig/sheep within 64 blocks of
  // home, none of anything within 32 -- and 15 chickens within 64.
  const consts = vm.createContext({});
  vm.runInContext(between(actions, 'export const FOOD_NAMES = [', '// Suffix-matched').replace(/export /g, '') +
    ';this.FOOD_NAMES = FOOD_NAMES; this.HUNTABLE_ANIMALS = HUNTABLE_ANIMALS; this.HUNT_RANGE = HUNT_RANGE;', consts);
  assert.equal(consts.FOOD_NAMES.at(-1), 'chicken', 'raw chicken counts as food, ranked after everything else');
  const inv = [];
  const at = (x) => new V3(x, 64, 0);
  const entities = { 1: { name: 'chicken', position: at(50) }, 2: { name: 'chicken', position: at(52) },
    3: { name: 'chicken', position: at(55) }, 4: { name: 'cow', position: at(40) } };
  const attacked = [];
  const c = vm.createContext({ Object, bot: { entity: { position: Object.assign(at(0), { clone() { return this; } }) }, entities, inventory: { items: () => inv } },
    FOOD_NAMES: consts.FOOD_NAMES, HUNTABLE_ANIMALS: consts.HUNTABLE_ANIMALS, HUNT_RANGE: consts.HUNT_RANGE,
    ok: (text) => ({ ok: true, text }), fail: (text) => ({ ok: false, text }),
    performActionAs: async (_b, action) => { attacked.push(action.target.name); return { ok: true }; },
    collectDrops: async () => { inv.push({ name: 'chicken', count: 1 }); } });
  const hunt = between(actions, '    case "hunt": {', '\n    case "');
  vm.runInContext(`async function run(action, token, speaker = "test") { switch (action.type) {${hunt}} }`, c);
  const r = await c.run({ type: 'hunt' }, { cancelled: false });
  assert.deepEqual(attacked, ['chicken'], 'a chicken 50 blocks out, not the lone cow');
  assert.equal(r.ok, true, 'and the raw chicken it dropped counts as food');
});


await check('Self-defense: a spider in daylight is no threat unless it just hit her', async () => {
  // 2026-10-30: weaponless Babs fled daytime spiders again and again, each time cancelling the
  // craft of the sword she needed.
  const { EventEmitter } = await import('node:events');
  const bot = new EventEmitter();
  const at = (d) => ({ d, distanceTo() { return this.d; } });
  const spider = { id: 1, name: 'spider', position: at(3) };
  const zombie = { id: 2, name: 'zombie', position: at(10) };
  let mobs = [spider];
  Object.assign(bot, { health: 20, time: { isDay: true }, entity: { position: {} },
    entities: { 1: spider, 2: zombie },
    nearestEntity: (pred) => mobs.filter(pred).sort((a, b) => a.position.d - b.position.d)[0] ?? null });
  const c = vm.createContext({ bot, Date, HOSTILE_MOBS: new Set(['spider', 'zombie']),
    nearestHostile: () => mobs.slice().sort((a, b) => a.position.d - b.position.d)[0] ?? null });
  vm.runInContext(between(index, 'const RANGED_MOBS', 'async function checkSelfDefense('), c);
  assert.equal(c.pickThreat(12), null, 'a lone daytime spider is left alone');
  mobs = [spider, zombie];
  assert.equal(c.pickThreat(12), zombie, 'a zombie beyond it is still the threat');
  bot.time.isDay = false;
  assert.equal(c.pickThreat(12), spider, 'at night the spider is hostile again');
  bot.time.isDay = true; mobs = [spider];
  spider.position.d = 2; bot.health = 17; bot.emit('health');
  assert.equal(c.pickThreat(12), spider, 'one that just bit her is answered, day or not');
});


await check('Wool: string she already holds becomes wool before any sheep hunt', async () => {
  // 2026-10-28: no sheep near home on this seed (32+ "no sheep nearby" failures each for Babs and
  // Dale) while Babs carried 45 string. 4 string -> 1 white wool, no table.
  const wool = actions.slice(actions.indexOf('case "get_wool": {'), actions.indexOf('case "place_bed": {'));
  const inv = [{ name: 'string', count: 45 }];
  const crafted = [];
  let hunted = false;
  const c = vm.createContext({ console, speaker: 'Babs', token: { cancelled: false },
    bot: { username: 'Babs', entity: { position: new V3(0, 64, 0) }, entities: {}, inventory: { items: () => inv } },
    ok: (text) => ({ ok: true, text }), fail: (text) => ({ ok: false, text }),
    woolCounts: () => Object.fromEntries(inv.filter((i) => i.name.endsWith('_wool')).map((i) => [i.name.slice(0, -5), i.count])),
    performActionAs: async (_bot, action) => {
      crafted.push(action);
      inv.push({ name: 'white_wool', count: action.count });
      return { ok: true, text: 'crafted' };
    },
    wanderAndRetryForSheep: async () => { hunted = true; return null; }, collectDrops: async () => {} });
  vm.runInContext(`async function getWool(action) { switch (action.type) { ${wool} } }`, c);
  const result = await c.getWool({ type: 'get_wool', count: 3 });
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(JSON.parse(JSON.stringify(crafted)), [{ type: 'craft', item: 'white_wool', count: 3 }],
    'three white wool crafted from 12 string');
  assert.equal(hunted, false, 'no sheep hunt needed');
});


await check('Food goal: hunts, else takes a ripe crop -- never runs as a farm goal needing a hoe', async () => {
  // 2026-10-30, Babs live: the food directive says "harvest a ripe crop", FARM_WORDS matched it,
  // and the farm runner looped harvest/loot hoe/craft hoe every ten seconds for hours.
  let food = false;
  let outcomes = {};
  const actions_ = [];
  const covered = { BOT_ROLES: { bob: { primary: { name: 'Farmer' } }, dale: { primary: { name: 'Herder' } } } };
  const c = vm.createContext({ bot: { players: { Bob: {}, Dale: {} } }, USERNAME: 'Babs', myRole: null, hasFood: () => food, heldCount: () => 0, ...covered,
    performAction: async (_b, action) => {
      actions_.push(action.type + (action.onlyRipe ? ':ripe' : ''));
      const r = outcomes[action.type] ?? { ok: false, text: 'nothing.' };
      if (r.ok) food = true;
      return r;
    } });
  vm.runInContext(between(index, 'async function foodStep(', 'async function runFoodGoal('), c);
  outcomes = { hunt: { ok: true, text: 'hunted: now carrying 2 food.' } };
  assert.equal((await c.foodStep(null)).ok, true);
  assert.deepEqual(actions_, ['hunt'], 'a successful hunt is enough');
  food = false; actions_.length = 0;
  outcomes = { hunt: { ok: false, text: 'no animals to spare nearby to hunt.' }, harvest: { ok: true, text: 'harvested 3 carrots.' } };
  assert.equal((await c.foodStep(null)).ok, true);
  assert.deepEqual(actions_, ['hunt', 'harvest:ripe'], 'no prey: a ripe crop, without starting a farm');
  food = false; actions_.length = 0; outcomes = {};
  const failed = await c.foodStep(null);
  assert.equal(failed.ok, false);
  assert.ok(!actions_.some((a) => /craft|loot/.test(a)), 'never goes after a hoe');
  food = true; actions_.length = 0;
  assert.equal((await c.foodStep(null)).done, true);
  assert.deepEqual(actions_, [], 'already holding food: done');
  assert.match(between(index, 'goal.standing === "guard"', 'goal.farmTask === "farm"'),
    /survivalPriorityItem === "food"[\s\S]*goal\.farmTask \?\?= farmTaskFor/,
    'routed before farmTaskFor -- "harvest a ripe crop" would otherwise match FARM_WORDS');
  // 2026-11-01: a step that found nothing used to be retried every 2s goal tick.
  let now = 1_000_000;
  const failures = [];
  const g = vm.createContext({ bot: { players: { Bob: {}, Dale: {} } }, USERNAME: 'Babs', myRole: null, hasFood: () => false, heldCount: () => 0, ...covered,
    logStep() {}, console: { log() {} },
    Date: { now: () => now }, failGoalStep: async (_g, why) => failures.push(why),
    completeGoal: async () => {}, performAction: async () => ({ ok: false, text: 'nothing.' }) });
  vm.runInContext(between(index, 'async function foodStep(', '// Tier 1 "shelter_upgrade"'), g);
  const goal = {};
  const run = () => g.runFoodGoal(goal, async () => true, () => null, () => false);
  await run();
  assert.equal(failures.length, 1);
  now += 2_000; await run();
  assert.equal(failures.length, 1, 'the next tick, 2s later, waits');
  now += 30_000; await run();
  assert.equal(failures.length, 2, '30s on, she tries again');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
