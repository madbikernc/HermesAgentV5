// Version: 1.40.0
// 1.35.0 (2026-10-27): checks for index.js 2.122.0/actions.js 1.94.0's four fixes. Builder
// checklist: builderPriorityCandidates()/builderPriorityItemSatisfied() re-open crafting_table/
// furnace/chest once isUtilityUsable() reports the only known one broken, and the two functions
// stay in lockstep for the same signal. Shelter: findShelterSite() finds a site farther out once
// the old fixed-radius core is fully blocked, and findShelterNearHome() (the regression this fix
// had to close in lockstep) now recognizes a shelter built just beyond the old 4-block window --
// plus a second regression caught in review: ring-expansion must not stop on a merely-damaged
// match from the innermost ring, or a half-built structure near home would hide a genuinely
// complete shelter farther out.
// RAG registration: runBuilderPlacement() and runShelterGoal() each write a note on a real
// completion (stubbed in every farmGoalSrc()-based context that reaches their success path --
// bedWorld()'s "sleep" tests needed a findRememberedLocation()/gotoRememberedSpot() stub too, for
// the same reason). Beds: sleep falls back to a remembered bed when nothing is nearby, and
// bedStep() builds on the spot instead of trekking home once she's far from both home and any
// remembered bed.
// 1.34.0 (2026-10-22): generalizes 1.33.0's checks for shelter.js 1.3.0's shelterRoomsNear()/
// holesIn() and the unified index.js 2.121.0 checkShelterIntegrity() -- replaces the now-removed
// checkCommunalShelterIntegrity() test. New coverage: a sealed room has zero holes and a real
// gap is found exactly; any number of separate individual shelters are each kept apart, not
// merged or lost; a larger shelter in a shape neither fixed geometry builds is recognized and
// its hole found; the unified periodic check repairs whichever room in the list is damaged via
// the new generic "patch_shelter" action, and "patch_shelter" itself never computes its own
// geometry or touches a door.
// 1.33.0 (2026-10-22): two new checks for index.js 2.120.0's checkCommunalShelterIntegrity() --
// findCommunalShelterNearHome() correctly reports a damaged (not just complete-or-nothing)
// communal shelter, and the new periodic wrapper calls build_communal_shelter with the right
// base/width/depth only when damaged, never on a complete structure or a bare absence.
// 1.32.0 (2026-10-22): two new MB-01 checks for actions.js 1.92.0's noPath burst bailout (the
// attack_win_rate regression fix) -- four real noPath path_update results bail out well short
// of the test's 400ms ACTION_TIMEOUT_MS with a new "couldn't reach it" outcome, and a lone/
// transient noPath that's followed by a real path doesn't abandon a fight that then lands a
// kill.
// 1.31.1 (2026-10-21): the S34 "S27f analysis mode..." test's chat-site scan window was 25
// lines, too short to reach generateReply()'s callRole() options (36 lines from its <speaker>
// content line) -- found live on spark, crashed the whole suite on an uncaught assertion.
// Widened to 40. No other test changed.
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
// 1.16.0 | 2026-09-26 | Beds: occupied spots skipped and refused spots not retried; wood before crafting.
// 1.17.0 | 2026-09-27 | Shelters fit a bed (4x4, 2x2 room; the old 3x3 no longer counts); beds prefer the room; the bed-shortage goal trigger.
// 1.18.0 | 2026-10-07 | Access: chest lids, doorways, the last way up to a bed, falling blocks, the
//   obstruction scan, "place"/"clear_access"/"mine" and the other four placement sites. Shelter walls:
//   the covered fill, its cap, an open-sky bed, and pathfinder's refusal to dig one. Torches: trail
//   spacing, what can hold one, between-digs timing, and the supply top-up's backoff.
// 1.19.0 | 2026-10-07 | First real run of the above, on spark: `class V3` hoisted (not hoisted by JS,
//   and the first check now needs it), the place_home stub given a real V3 world, vm-context arrays
//   spread before deepStrictEqual (different Array prototype), blockWorld given block ids plus a
//   registry with emitLight, and a check that craftItem chains through shaped recipes.
// 1.20.0 | 2026-10-09 | attackAsLastResort fights bare-handed when genuinely unable to flee; craft's
//   tableWouldHelp check against empty hands (recipesAll, not recipesFor); an already-placed utility
//   block found during a craft attempt gets written to world memory too.
// 1.21.0 | 2026-10-09 | First live run of the above found tableWouldHelp was still wrong for any
//   item with a second, unusable no-table recipe (a colored bed's dye-recolor shortcut) -- a check
//   for that case too.
// 1.22.0 | 2026-10-10 | A healthy non-Soldier fights a single ordinary mob directly, not just a
//   hurt or Soldier one; get_wool wanders to look for a sheep instead of instant-failing.
// 1.23.0 | 2026-10-11 | Shelter: a real door required (not just an opening), 100% solid walls/
//   roof/floor (not 80%), the floor itself now checked at all; findShelterNearHome()'s own
//   damaged-but-real-structure detection, separate from the hasShelterNearHome() boolean. Also:
//   the room grew from 2x2 to 2x3 (found live the same day -- a real door and a bed could never
//   both fit in 2x2), updating every geometry-derived count and offset this file asserts.
// 1.24.0 | 2026-10-11 | PRIORITIES_PROPOSAL.md Tiers 1-2: nextSurvivalPriority()'s ordering
//   (weapon, sheltered bed, food, armor, null) and survivalPriorityItemSatisfied(); the Soldier
//   priorities check narrowed now that weapon/armor live there instead; the new builder-item
//   claim mechanism (blocks, releases, TTL-expires, falls back to a local file); and
//   builderPriorityCandidates()'s "beds"+"shelter" merge into one real countQualifyingSheltersNearHome()
//   check (multiple separate structures, not just the nearest).
// 1.25.0 | 2026-10-11 | PRIORITIES_PROPOSAL.md Tier 2 items 2-4: "craft"'s reusable-utility-block
//   check now falls back to a remembered location, not just the local 32-block view; new
//   checkSurplusSharing() and checkLocationSharing() give surplus-storing and location-sharing
//   a standing cadence of their own instead of only running as a side effect of something else.
// 1.26.0 | 2026-10-11 | PRIORITIES_PROPOSAL.md §2a (the guard-anchor claim): actions.js's new
//   holdsGuardAnchor() (a single shared slot, not one row per bot); index.js's isLiveSoldier()/
//   isGuardAnchor()/nextSoldierPriority()'s new anchor-vs-escort split, now async.
// 1.27.0 | 2026-10-12 | PRIORITIES_PROPOSAL.md Tier 2 item 1a (the communal shelter, sized per
//   the operator's own rule) and the first instance of the resource-gathering override:
//   isCommunalShelterMaterial/communalShelterPositions/findCommunalShelterSite (actions.js), the
//   new "build_communal_shelter" case and place_bed's action.near; fleetHasReachedIronTools()'s
//   fleet-wide evidence tracking, communalShelterSize()'s dynamic sizing, structure/bed-count
//   verification, farmTaskFor's "communal" routing, and the shared gatherPlanks() helper
//   (index.js). Also fixes this file's own top "Version:" line, which had quietly fallen behind
//   the Revision History below it since 1.24.0 -- a real, if harmless, drift this bump closes.
// 1.28.0 | 2026-10-12 | Root-caused a real, confirmed live regression (attack_win_rate collapsed
//   from a 0.846 baseline to 0.167): weaponStep()/runWeaponGoal(), a dedicated runner for weapon
//   acquisition (a nearby chest first, else gatherPlanks() + craft), dispatched off
//   currentGoal.survivalPriorityItem rather than the unreliable freeform planner.
// 1.29.0 | 2026-10-13 | Direct report after a fleet reset ("combat seems better, but building
//   and tooling do not"): "mine" takes a partial chest match and still mines the shortfall
//   (actions.js); a server-refused bed spot is not retried on a later goal tick (actions.js);
//   toolStep()/runToolGoal(), the same dedicated-runner shape extended to pickaxe acquisition,
//   dispatched by TOOL_WORDS text match rather than the freeform planner, plus a check that
//   TOOL_WORDS ("pickaxe" only) never collides with weaponStep's own "sword or axe" text.
// 1.30.0 | 2026-10-16 | Direct report after a world reinit ("check the last 24 hours behavior
//   logs for incorrect behaviors"): the Tier 1 shelter+bed directive now routes to shelterStep,
//   not bedStep (BED_WORDS was checked before SHELTER_WORDS/COMMUNAL_SHELTER_WORDS, and matched
//   the directive's own mention of "bed"); dedicated runners (farmTask-tagged or
//   survivalPriorityItem="weapon") get a 20-failure leash instead of sharing the freeform
//   planner's 3, so transient terrain failures no longer wipe accumulated goal progress.
// 1.31.0 | 2026-10-18 | Direct request: bed claiming removed -- the old bedWorld()/claim-conflict
//   checks (1.7.0/1.8.0/1.16.0/1.17.0's bed-shortage half) are replaced with sleep trying every
//   usable bed nearest-first, skipping occupied ones, no cap at 3, no claim file ever written.
//   New shelter-detection checks (enclosedInterior/isSandWallName/shelterInteriorsNear, any shape,
//   no openings but doors, walls any material but sand) and findBedSites' own preference for a
//   site inside one. bedSiteWorld()'s findBlocks fixed to honour its own `matching` filter.
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
const shelterSrc = await readFile(root + 'shelter.js', 'utf8');
const tunnelSrc = await readFile(root + 'tunneling.js', 'utf8');
const arbiter = await import(pathToFileURL(root + 'arbiter.js').href);

// The `vec3` stand-in for every context below: there is no node_modules in this suite. Declared
// here rather than beside its first bed/shelter use, because `class` is not hoisted and the very
// first check() now builds a context that needs it (2026-10-07).
class V3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  offset(dx, dy, dz) { return new V3(this.x + dx, this.y + dy, this.z + dz); }
  equals(o) { return o.x === this.x && o.y === this.y && o.z === this.z; }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
  toString() { return `(${this.x}, ${this.y}, ${this.z})`; }
  floored() { return new V3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
}

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
  const s = shelter(); // actions.js imports its access/bed/chest geometry from shelter.js (1.81.0)
  return vm.createContext({ bot, console: quiet, setTimeout, clearTimeout, Promise, ...arbiter,
    ACTION_TIMEOUT_MS: 400, equipBestWeapon: async () => {}, refreshGear: async () => {}, holdDoorsOpen: () => () => {},
    goals: { GoalNear: class {}, GoalFollow: class {} },
    bedHalves: s.bedHalves, chestHalves: s.chestHalves, wouldBlockAccess: s.wouldBlockAccess,
    findAccessObstructions: s.findAccessObstructions, isLivingSpaceWall: s.isLivingSpaceWall,
    ACCESS_SCAN_RADIUS: shelterConst('ACCESS_SCAN_RADIUS'),
    // 2026-10-27: noteUtilityOutcome() (actions.js 1.94.0) is now called from several of the
    // chest/furnace/crafting_table call sites extracted into a context() slice below -- a
    // harmless no-op default here, same as equipBestWeapon/refreshGear above, so every existing
    // test using this shared context keeps working without having to know about it; a test that
    // actually cares passes its own via `extras`, which overrides this default.
    noteUtilityOutcome: () => {},
    ...extras });
}

// shelter.js / tunneling.js run as source in their own contexts, like every other module here:
// no node_modules offline, so `Vec3` is the V3 stub below. `export const` bindings are lexical,
// not context properties, so shelterConst() evaluates them by name (the same trick the shelter
// geometry checks already use for SHELTER_ROOM).
let shelterCtx = null;
function shelter() {
  if (!shelterCtx) {
    shelterCtx = vm.createContext({ Vec3: V3 });
    vm.runInContext(between(shelterSrc, 'export const posKey'), shelterCtx);
  }
  return shelterCtx;
}
const shelterConst = (name) => vm.runInContext(name, shelter());
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
  vm.runInContext('var currentGoal = this.currentGoal;' + between(index, 'async function retireGoal(', '// Direct request, 2026-10-28 ("the 45 second'), c);
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

await check('Tier 2: checkSurplusSharing runs storeSurplusNearHome on a standing cadence, gated like its siblings', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 3 -- "elevates 'don't hoard' from an
  // incidental cleanup pass to an explicit, regularly-checked Tier 2 item"). Before this,
  // storeSurplusNearHome() only ever ran right after a craft; surplus picked up any other way
  // never got checked. Same gating as checkDeferredSurplusCleanup's own post-craft version.
  let calls = 0;
  const bot = { isSleeping: false };
  const c = vm.createContext({ setInterval() {}, console: { error() {} }, process: { env: {} },
    AUTONOMY_ENABLED: true, currentGoal: null, routineBlocked: () => false, bot,
    storeSurplusNearHome: async () => { calls++; }, USERNAME: 'Amy' });
  vm.runInContext(between(index, 'const SURPLUS_SHARING_CHECK_MS', 'const LOCATION_SHARING_CHECK_MS'), c);
  await c.checkSurplusSharing();
  assert.equal(calls, 1, 'runs when idle, awake, autonomous, and not routine-blocked');
  vm.runInContext('currentGoal = {}', c);
  await c.checkSurplusSharing();
  assert.equal(calls, 1, 'skipped while a goal is active');
  vm.runInContext('currentGoal = null', c);
  bot.isSleeping = true;
  await c.checkSurplusSharing();
  assert.equal(calls, 1, 'skipped while asleep');
  bot.isSleeping = false;
  vm.runInContext('AUTONOMY_ENABLED = false', c);
  await c.checkSurplusSharing();
  assert.equal(calls, 1, 'skipped while autonomy is off');
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

await check('Survival (Tier 1): weapon, then her own sheltered bed, then food, then armor, then null', async () => {
  const slots = []; let weapon = false, ownShelter = false, food = false, rod = false;
  let held = [], shelters = [];
  const bot = { food: 20, inventory: { slots, items: () => held }, blockAt: () => ({ name: 'dirt' }) };
  // 2026-10-28: the tool and shelter upgrade items sit at the bottom of the ladder (see below).
  const c = vm.createContext({ Date, bot, hasWeapon: () => weapon, hasOwnShelterWithBed: () => ownShelter,
    hasFood: () => food, hasRod: () => rod, HUNGER_THRESHOLD: 18, foodFetchBlockedUntil: Infinity,
    TOOL_NAME: /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe)$/,
    countUsableNearHome: () => 0, completeSheltersNearHome: () => shelters, shelterHasBed: () => true,
    shelterGeometryPositions: (base) => [base], isCommunalShelterMaterial: (n) => n === 'cobblestone' });
  vm.runInContext(between(index, 'function nextSurvivalPriority(', 'function survivalPriorityItemSatisfied('), c);
  assert.equal(c.nextSurvivalPriority().name, 'weapon', 'no weapon beats everything else');
  weapon = true;
  assert.equal(c.nextSurvivalPriority().name, 'shelter', 'armed, but no sheltered bed of her own yet');
  ownShelter = true;
  bot.food = 10; // < HUNGER_THRESHOLD, no food, no rod, and the reactive fetch already backed off
  assert.equal(c.nextSurvivalPriority().name, 'food', 'sheltered, but trending toward starvation');
  food = true;
  assert.equal(c.nextSurvivalPriority().name, 'armor', 'fed, but no armor at all');
  for (const s of [5, 6, 7, 8]) slots[s] = { name: 'iron_helmet' };
  assert.equal(c.nextSurvivalPriority(), null, 'every Tier 1 baseline met -- falls through to role work');
  held = [{ name: 'wooden_pickaxe', count: 1 }];
  assert.equal(c.nextSurvivalPriority().name, 'tools', 'a pickaxe she can mine stone with: upgrade tools next');
  assert.equal(c.nextSurvivalPriority(), null, 'and not again until its retry timer runs out');
  shelters = [{ x: 0, y: 65, z: 0 }];
  assert.equal(c.nextSurvivalPriority().name, 'shelter_upgrade', 'a bedded dirt shelter gets reinforced, last of all');
  assert.equal(c.nextSurvivalPriority(), null, 'also behind its own retry timer');
  held = []; shelters = [];
  // The food item only escalates to a real goal once the reactive chore has already tried and
  // backed off -- not the instant food drops, which would just duplicate what that chore (running
  // every 15s) is already doing.
  for (const s of [5, 6, 7, 8]) slots[s] = null;
  food = false; bot.food = 10;
  vm.runInContext('foodFetchBlockedUntil = 0; survivalArmorRetryAt = 0', c);
  assert.equal(c.nextSurvivalPriority().name, 'armor', 'low on food, but the reactive chore has not even tried yet -- not escalated');
});

await check('Survival (Tier 1): survivalPriorityItemSatisfied re-checks real state, not a claim', async () => {
  // Same hallucinated-DONE guard builderPriorityItemSatisfied() already gives Builder's own
  // items (2026-09-13's beehive bug): "shelter" and "food" don't reduce to "holds item X," so a
  // model claiming either done gets re-checked against the same real condition the ladder itself
  // trusts, not taken on its word.
  const slots = []; let weapon = false, ownShelter = false, food = false;
  const c = vm.createContext({ bot: { inventory: { slots } }, hasWeapon: () => weapon,
    hasOwnShelterWithBed: () => ownShelter, hasFood: () => food });
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

// Builder-item claims (2026-10-11, PRIORITIES_PROPOSAL.md Tier 2 PR2): same shape as bedWorld's
// own claims directory + shared-store mock, just a {item, claimedAt} value instead of a position.
// `shared`: hermes-memory's minecraft-builder-claims rows as { name: value } (mutated by writes);
// omitted = hermes-memory unreachable, so claims fall back to this host's files.
async function builderClaimsWorld(username, { shared } = {}) {
  const fs = await import('node:fs/promises');
  const pathMod = (await import('node:path')).default;
  const dir = await fs.mkdtemp(pathMod.join((await import('node:os')).tmpdir(), 'mbtest-builder-claims-'));
  const bot = { username };
  const listState = async (agent) => {
    if (!shared) throw new Error('connect ECONNREFUSED');
    assert.equal(agent, 'minecraft-builder-claims');
    return Object.entries(shared).map(([key, value]) => ({ key, value }));
  };
  const setState = async (agent, k, value) => {
    if (!shared) throw new Error('connect ECONNREFUSED');
    shared[k] = value;
  };
  const c = vm.createContext({ bot, Date, console: { log() {}, error() {} }, process: { env: {} },
    BUILDER_CLAIMS_DIR: dir, path: pathMod, readFile: fs.readFile, writeFile: fs.writeFile,
    mkdir: fs.mkdir, readdir: fs.readdir, unlink: fs.unlink, listState, setState });
  vm.runInContext(between(actions, 'const BUILDER_CLAIMS_DIR', '\n// Direct request, 2026-10-11'), c);
  return { bot, c };
}

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

await check('Builder claims: the shared store down falls back to this host\'s own file, same as bed claims', async () => {
  const w = await builderClaimsWorld('Amy'); // no `shared` -- listState/setState both throw
  assert.equal(await w.c.claimBuilderItem(w.bot, 'chest'), true);
  assert.equal(await w.c.myBuilderClaim(w.bot), 'chest', 'the local fallback file still answers her own claim');
});

// Guard anchor (2026-10-11, PRIORITIES_PROPOSAL.md §2a): same shape as builderClaimsWorld, just
// a single shared row ({holder, claimedAt}, key "anchor") instead of one per bot.
async function guardAnchorWorld(username, { shared } = {}) {
  const fs = await import('node:fs/promises');
  const pathMod = (await import('node:path')).default;
  const dir = await fs.mkdtemp(pathMod.join((await import('node:os')).tmpdir(), 'mbtest-guard-anchor-'));
  const bot = { username };
  const listState = async (agent) => {
    if (!shared) throw new Error('connect ECONNREFUSED');
    assert.equal(agent, 'minecraft-guard-anchor');
    return Object.entries(shared).map(([key, value]) => ({ key, value }));
  };
  const setState = async (agent, k, value) => {
    if (!shared) throw new Error('connect ECONNREFUSED');
    shared[k] = value;
  };
  const c = vm.createContext({ bot, Date, console: { log() {}, error() {} }, process: { env: { MC_MEMORY_ROOT: dir } },
    path: pathMod, readFile: fs.readFile, writeFile: fs.writeFile, mkdir: fs.mkdir, unlink: fs.unlink, listState, setState });
  vm.runInContext(between(actions, 'const GUARD_ANCHOR_AGENT', '\n// A bed is two blocks;'), c);
  return { bot, c };
}

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

await check('Communal shelter: fleet-wide iron-tool evidence, never a bare claim', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a -- "checked the same verified way the
  // existing curriculum already checks tool tiers... not a new detection mechanism"). Ungated
  // (every bot, not just Mayor) unlike TECH_TREE_STAGES' own evidence tracking -- see
  // fleetHasReachedIronTools()'s own header for why that distinction matters here.
  const slots = [];
  const bot = { inventory: { items: () => [], slots } };
  const c = vm.createContext({ bot, BOT_USERNAMES: new Set(['amy']),
    TOOL_TIERS: ["wooden", "stone", "iron", "golden", "diamond", "netherite"] });
  vm.runInContext(between(index, 'const TOOL_NAME', 'function communalShelterTargetBeds('), c);
  assert.equal(c.isIronOrBetterTool('iron_pickaxe'), true);
  assert.equal(c.isIronOrBetterTool('stone_pickaxe'), false);
  assert.equal(c.isIronOrBetterTool('golden_sword'), true);
  assert.equal(c.isIronOrBetterTool('diamond_hoe'), true);
  assert.equal(c.isIronOrBetterTool('iron_ingot'), false, 'not a tool at all');
  assert.equal(c.fleetHasReachedIronTools(), false, 'nothing seen yet');
  c.noteIronToolEvidence(['stone_axe']); // worse than iron -- doesn't flip it
  assert.equal(c.fleetHasReachedIronTools(), false);
  slots[6] = { name: 'iron_chestplate' }; // armor, not a tool -- shouldn't flip it either
  assert.equal(c.fleetHasReachedIronTools(), false);
  slots[6] = null;
  c.noteIronToolEvidence(['diamond_pickaxe']); // a teammate's real, broadcast evidence
  assert.equal(c.fleetHasReachedIronTools(), true, 'verified evidence, even from someone else, is enough');
  c.noteIronToolEvidence(['stone_pickaxe']); // a later, worse report never un-sets it
  assert.equal(c.fleetHasReachedIronTools(), true);
});

await check('Communal shelter: sized per the operator\'s own rule (at least N+1 beds for N bots)', async () => {
  const c = vm.createContext({ bot: {}, Math,
    BOT_USERNAMES: new Set(['amy', 'babs', 'mark', 'luke', 'mayor', 'bob', 'nell', 'wade', 'dale']) });
  vm.runInContext(between(index, 'function communalShelterTargetBeds(', 'function hasHollowCommunalInterior('), c);
  assert.equal(c.communalShelterTargetBeds(), 10, 'N+1 for a 9-bot fleet');
  const size = c.communalShelterSize();
  assert(size.width * size.depth >= 10 * 4, `generously sized for the target: ${JSON.stringify(size)}`);
  assert.equal(size.width, size.depth, 'kept square');
});

await check('Communal shelter: "communal" routes to its own runner, not the individual-shelter one', async () => {
  const c = vm.createContext({
    BED_WORDS: /\b(make|craft|build|set up|place|get|need|more)\b[^.]*?\bbeds?\b/i,
    NOT_MAKING_A_BED: /\b(go(ing)? to|sleep(ing)? in|find a|head(ing)? to) (a |the |your |her )?bed\b/i,
    SHELTER_WORDS: /\b(build(ing)?|mak(e|ing)|set(ting)? up|put(ting)? up|need)\b[^.]*?\bshelter\b/i,
  });
  vm.runInContext(between(index, 'const FARM_WORDS', 'async function completeGoal('), c);
  assert.equal(c.farmTaskFor('lead the fleet\'s communal shelter near home'), 'communal_shelter');
  assert.equal(c.farmTaskFor('build a shelter near home'), 'shelter', 'a plain shelter is unaffected');
});

await check('Resource-gathering override: gatherPlanks crafts from a held log, else mines a tree', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md -- "gathering that resource becomes her temporary
  // priority"). Extracted from bedStep's own inline fallback -- see gatherPlanks' own header for
  // why shelterStep's near-identical-LOOKING fallback (which wants ANY wall material, not
  // specifically planks) is deliberately NOT also folded into this.
  let calls = [];
  const bot = { inventory: { items: () => [] }, findBlocks: () => [], blockAt: () => ({ name: 'oak_log' }) };
  const performAction = async (b, action) => { calls.push(action); return { ok: true, text: 'did it' }; };
  const c = vm.createContext({ bot, USERNAME: 'Amy',
    heldCount: (test) => bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    performAction });
  vm.runInContext(between(index, 'async function gatherPlanks(', 'async function bedStep('), c);

  bot.inventory.items = () => [{ name: 'oak_planks', count: 10 }];
  assert.equal(await c.gatherPlanks({}, 7), null, 'already holds enough -- nothing to do');
  assert.equal(calls.length, 0);

  bot.inventory.items = () => [{ name: 'spruce_log', count: 2 }];
  const crafted = await c.gatherPlanks({}, 7);
  assert.equal(crafted.action.type, 'craft');
  assert.equal(crafted.action.item, 'spruce_planks');
  assert.deepEqual({ ...calls.at(-1) }, { type: 'craft', item: 'spruce_planks', count: 7 });

  // 2026-10-29: Babs' real pocket -- one plank each of three woods, two dark oak logs. A bed needs
  // three planks of ONE wood, so that is not "3 planks" (14,738 failed bed crafts overnight).
  calls = [];
  bot.inventory.items = () => [{ name: 'jungle_planks', count: 1 }, { name: 'spruce_planks', count: 1 },
    { name: 'birch_planks', count: 1 }, { name: 'dark_oak_log', count: 2 }];
  const mixed = await c.gatherPlanks({}, 3);
  assert.notEqual(mixed, null, 'three planks of three different woods are not three planks');
  assert.equal(calls.at(-1).item, 'dark_oak_planks', 'her logs become planks of one wood');
  assert.equal(calls.at(-1).count, 3);
  calls = [];
  bot.inventory.items = () => [{ name: 'dark_oak_log', count: 2 }];
  await c.gatherPlanks({}, 10);
  assert.equal(calls.at(-1).count, 8, 'never more planks than her logs make -- that failed the whole craft');

  calls = [];
  bot.inventory.items = () => [];
  bot.findBlocks = () => [{ x: 5, y: 64, z: 5 }];
  bot.blockAt = () => ({ name: 'birch_log' });
  const mined = await c.gatherPlanks({}, 8);
  assert.equal(mined.action.type, 'mine');
  assert.equal(mined.action.block, 'birch_log');
  assert.equal(calls.at(-1).count, 2, 'ceil(8/4) logs -- each gives ~4 planks');

  calls = [];
  bot.findBlocks = () => [];
  const stuck = await c.gatherPlanks({}, 8);
  assert.equal(stuck.ok, false);
  assert.match(stuck.text, /no tree nearby/);
  assert.equal(calls.length, 0, 'a real, reported failure -- not a crash');
});

await check('Resource-gathering override: weaponStep -- a chest first, else gatherPlanks + craft', async () => {
  // 2026-10-12: root-caused a real, confirmed live regression (attack_win_rate collapsed from a
  // 0.846 baseline to 0.167) to weapon acquisition relying entirely on the freeform planner --
  // see weaponStep's own header for the full account, including the vicious cycle a weaponless
  // Soldier falls into (forced to flee, which keeps interrupting the one goal that would fix it).
  let calls = []; let armed = false;
  const bot = { inventory: { items: () => [] }, findBlocks: () => [], blockAt: () => ({ name: 'oak_log' }),
    registry: { blocksByName: {} } };
  const performAction = async (b, action) => {
    calls.push(action);
    if (action.type === 'loot') return { ok: false, text: 'nothing in any chest' };
    if (action.type === 'craft' && action.item === 'wooden_sword') { armed = true; return { ok: true, text: 'crafted a wooden_sword' }; }
    return { ok: true, text: 'did it' };
  };
  const c = vm.createContext({ bot, USERNAME: 'Amy', hasWeapon: () => armed,
    heldCount: (test) => bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    performAction });
  vm.runInContext(between(index, 'async function gatherPlanks(', 'async function bedStep('), c);

  armed = true;
  const done = await c.weaponStep({}, {});
  assert.equal(done.done, true, 'already has a real weapon -- immediately done');
  assert.equal(calls.length, 0, 'no action taken when already armed');
  armed = false;

  const goal = {};
  bot.findBlocks = () => [{ x: 1, y: 64, z: 1 }]; // a tree, for gatherPlanks' own fallback
  // A failed chest loot (bedStep's own "if ok or cancelled" convention, reused verbatim) falls
  // straight through to gathering within this SAME call, not a separate tick.
  const first = await c.weaponStep(goal, {});
  assert.equal(goal.triedWeaponChest, true, 'the chest check ran exactly once');
  assert.equal(first.action.type, 'mine');
  assert.equal(calls.filter((a) => a.type === 'loot').length, 1);
  assert.equal(calls.at(-1).count, 2, 'ceil(6/4) logs -- 2 planks for the sword, 4 more for her own table');

  const second = await c.weaponStep(goal, {}); // chest already tried -- never retried
  assert.equal(second.action.type, 'mine');
  assert.equal(calls.filter((a) => a.type === 'loot').length, 1, 'still just the one attempt');

  bot.inventory.items = () => [{ name: 'oak_planks', count: 10 }]; // now holds enough
  const crafted = await c.weaponStep(goal, {});
  assert.equal(crafted.action.item, 'wooden_sword');
  assert.equal(armed, true);

  assert.match(index, /if \(goal\.survivalPriorityItem === "weapon"\) \{\s+await runWeaponGoal/,
    'goalTick actually dispatches a weapon-tagged goal to the dedicated runner, not the freeform planner');
});

await check('Resource-gathering override: toolStep -- a chest first, else gatherPlanks + craft a pickaxe', async () => {
  // 2026-10-13: extends weaponStep's own fix to tooling (direct report: "combat seems better,
  // but building and tooling do not" -- live evidence was Nell's "craft wooden_pickaxe" throwing
  // a raw "Error: missing ingredient" and Mark/Wade producing long, rambling self-talk that never
  // converged). Same shape, same deliberately narrow scope (a pickaxe specifically, crafted from
  // scratch, never waiting on a teammate's spare).
  let calls = []; let toolInHand = false;
  const bot = { inventory: { items: () => [] }, findBlocks: () => [], blockAt: () => ({ name: 'oak_log' }),
    registry: { blocksByName: {} } };
  const performAction = async (b, action) => {
    calls.push(action);
    if (action.type === 'loot') return { ok: false, text: 'nothing in any chest' };
    if (action.type === 'craft' && action.item === 'wooden_pickaxe') { toolInHand = true; return { ok: true, text: 'crafted a wooden_pickaxe' }; }
    return { ok: true, text: 'did it' };
  };
  const c = vm.createContext({ bot, USERNAME: 'Nell',
    heldCount: (test) => bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    performAction });
  vm.runInContext(between(index, 'async function gatherPlanks(', 'async function bedStep('), c);

  bot.inventory.items = () => [{ name: 'wooden_pickaxe', count: 1 }];
  const done = await c.toolStep({}, {});
  assert.equal(done.done, true, 'already has a pickaxe -- immediately done');
  assert.equal(calls.length, 0, 'no action taken when already equipped');
  bot.inventory.items = () => [];

  const goal = {};
  bot.findBlocks = () => [{ x: 1, y: 64, z: 1 }]; // a tree, for gatherPlanks' own fallback
  const first = await c.toolStep(goal, {});
  assert.equal(goal.triedToolChest, true, 'the chest check ran exactly once');
  assert.equal(first.action.type, 'mine');
  assert.equal(calls.filter((a) => a.type === 'loot').length, 1);
  assert.equal(calls.at(-1).count, 3, 'ceil(9/4) logs -- 5 planks for the pickaxe, 4 more for her own table');

  const second = await c.toolStep(goal, {}); // chest already tried -- never retried
  assert.equal(second.action.type, 'mine');
  assert.equal(calls.filter((a) => a.type === 'loot').length, 1, 'still just the one attempt');

  bot.inventory.items = () => [{ name: 'oak_planks', count: 10 }]; // now holds enough
  const crafted = await c.toolStep(goal, {});
  assert.equal(crafted.action.item, 'wooden_pickaxe');
  assert.equal(toolInHand, true);

  assert.match(index, /if \(goal\.farmTask === "tool"\) \{\s+await runToolGoal/,
    'goalTick actually dispatches a tool-tagged goal to the dedicated runner, not the freeform planner');
  assert.match(index, /const TOOL_WORDS = \/\\bpickaxe\\b\/i;/,
    'routed by a text match on "pickaxe" specifically');
});

await check('Resource-gathering override: TOOL_WORDS never collides with weaponStep\'s own "sword or axe" text', async () => {
  // The whole reason TOOL_WORDS is anchored on "pickaxe" and never bare "axe": weaponStep's own
  // directive ("you have no sword or axe -- get one before anything else...") mentions an axe
  // too, and farmTaskFor is checked for EVERY goal regardless of source -- a bare-axe match would
  // have silently stolen every weapon goal into the tool runner instead.
  // `const` at script top level never becomes a context property (unlike `var`/function
  // declarations) -- same trick shelterConst() above uses: the extracted script's own last
  // expression statement is what vm.runInContext returns.
  const toolWords = vm.runInContext(between(index, 'const TOOL_WORDS', 'function farmTaskFor(') + 'TOOL_WORDS', vm.createContext({}));
  assert.equal(toolWords.test('you have no sword or axe -- get one before anything else.'), false,
    'the weapon directive text is not mistaken for a tool request');
  assert.equal(toolWords.test('make sure you have basic tools -- at least a pickaxe and an axe, wood or stone is fine to start.'), true,
    'the real tech-tree "basic tools" directive is recognized');
});

await check('Tier 2: builderPriorityCandidates merges beds+shelter, and claims the way the others do', async () => {
  const bedNames = []; let shelterCount = 0; let beehive = 0; let bred = false;
  let ironTools = false; let communalDone = false;
  const usableUtility = { crafting_table: 1, furnace: 1, chest: 1 };
  const c = vm.createContext({ bot: { registry: { blocksByName: {} } },
    countNearHome: (names) => (names[0] === 'beehive' ? beehive : 0),
    // 2026-10-27: crafting_table/furnace/chest now go through countUsableNearHome (real
    // interaction outcomes, isUtilityUsable in actions.js), not bare countNearHome -- this slice
    // doesn't include that function's own definition, so it's stubbed here same as every other
    // cross-module function this context already injects.
    countUsableNearHome: (names) => usableUtility[names[0]],
    countQualifyingSheltersNearHome: () => shelterCount, getAchievements: () => (bred ? ['bred:cow'] : []),
    fleetHasReachedIronTools: () => ironTools, communalShelterSatisfied: () => communalDone,
    communalShelterTargetBeds: () => 4,
    BOT_USERNAMES: new Set(['amy', 'babs', 'mark']) });
  vm.runInContext(between(index, 'function builderPriorityCandidates(', 'function nextBuilderPriority('), c);
  const names = () => c.builderPriorityCandidates().map((x) => x.name);
  assert(!names().includes('crafting_table') && !names().includes('furnace') && !names().includes('chest'),
    'all three usable -- none are candidates');
  // Real bug found live, 2026-10-27: these used to be bare countNearHome() existence checks --
  // once a block existed anywhere near home it counted as "done" forever, even after it was
  // proven unreachable/unusable by real interaction failures. Now a demonstrably-broken one
  // (isUtilityUsable says no) re-opens the item instead of staying silently "satisfied."
  usableUtility.chest = 0;
  assert(names().includes('chest'), 're-opens once the only known chest is unusable');
  usableUtility.chest = 1;
  assert(!names().includes('chest'), 'closes again once a usable one exists');
  usableUtility.furnace = 0;
  assert(names().includes('furnace'), 'same re-opening for furnace');
  usableUtility.furnace = 1;
  usableUtility.crafting_table = 0;
  assert(names().includes('crafting_table'), 'same re-opening for crafting_table');
  usableUtility.crafting_table = 1;
  assert(names().includes('shelter_capacity'), 'merged item present when short');
  assert(!names().includes('beds') && !names().includes('shelter'), 'the old separate items are gone');
  const capacityItem = c.builderPriorityCandidates().find((x) => x.name === 'shelter_capacity');
  assert.match(capacityItem.directive, /We have 0, need at least 3/);
  shelterCount = 3;
  assert(!names().includes('shelter_capacity'), 'baseline met -- drops off the list');
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a): additive, not blocking on the rest, but
  // gated on the fleet actually having reached iron tools -- and last in the list either way.
  assert(!names().includes('communal_shelter'), 'no iron tools yet -- not even a candidate');
  ironTools = true;
  assert.equal(names().at(-1), 'communal_shelter', 'unlocked, and last in priority order');
  const communalItem = c.builderPriorityCandidates().find((x) => x.name === 'communal_shelter');
  assert.match(communalItem.directive, /at least 4 beds/);
  communalDone = true;
  assert(!names().includes('communal_shelter'), 'already satisfied -- drops off the list');
});

await check('Tier 2: builderPriorityItemSatisfied stays in lockstep with builderPriorityCandidates for the same usability signal', async () => {
  // Real bug risk flagged in review: builderPriorityCandidates() and builderPriorityItemSatisfied()
  // both decide crafting_table/furnace/chest from the SAME isUtilityUsable-backed check -- if only
  // one were fixed, a bot could see "furnace still needed" in the checklist while being told "yes,
  // done" right after placing a 2nd furnace next to a broken 1st one. This proves they agree.
  let usable = 0;
  const c = vm.createContext({ bot: { registry: { blocksByName: {} } },
    countNearHome: () => 0, countUsableNearHome: () => usable,
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
const goalTickSrc = () => between(index, 'async function retireGoal(', '// Direct request, 2026-10-28 ("the 45 second');
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

await check('Builder placement: a successful crafting_table/furnace/chest/beehive placement registers a RAG note', async () => {
  // 2026-10-27 (direct request: "all resources, including buildable resources, should be
  // registered to the RAG"): runBuilderPlacement() is the one function Fix 1's own checklist
  // dispatch uses for crafting_table/furnace/chest/beehive -- covers all four for free.
  const bot = makeBot(); bot.chat = () => {}; bot.spawnPoint = { x: 5, y: 64, z: 5 };
  const goal = { description: 'go home and place a chest there', builderPriorityItem: 'chest',
    consecutiveFailures: 0, log: [], steps: 0 };
  const notes = [];
  const c = goalTickContext(bot, { currentGoal: goal,
    performAction: async () => ({ ok: true, text: 'placed a chest at home.' }),
    builderPriorityItemSatisfied: () => true,
    broadcastGoalState: async () => {}, recordGoalOutcome() {}, releaseBuilderItem: async () => {},
    narrateAction: async (t) => t,
    writeMemoryNote: async (note) => { notes.push(note); } });
  await c.runBuilderPlacement(goal, async () => true, () => ({ release() {} }), () => false);
  assert.equal(notes.length, 1, 'one RAG note written on a successful placement');
  assert.equal(notes[0].scope, 'world');
  assert.match(notes[0].text, /Built a chest near \(5, 64, 5\)/);
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

await check('S27f analysis mode is opt-in, and the chat paths only opt in for a verified bot sender (S34)', async () => {
  // Regression for the 2026-10-09 breakage: S22d gave Layer 2 a screener that actually detects
  // injections, and it scored the bots' own planning prompt as malicious -- 189 blocked planning
  // calls in six hours. callRole() can now declare the payload is bot state, but player chat
  // must keep being screened, which is the half that is easy to get wrong silently.
  //
  // Widened 2026-10-21 (S34): classifyIntent()/generateReply() now conditionally pass
  // analysis: fromVerifiedBot (isAnotherBot(speaker)) at their own <speaker> content site --
  // this must stay tied to that verified-bot variable, never a bare `analysis: true` literal,
  // which would silently re-open "a player can type anything" for every one of these sites.
  const seen = [];
  const mkContext = () => vm.createContext({
    process: { env: {} }, AbortSignal, JSON,
    fetch: (_url, opts) => { seen.push(opts.headers); return Promise.resolve({
      ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }); },
  });

  const c = mkContext();
  vm.runInContext(between(router, 'const ROUTER_URL').replace(/export /g, ''), c);

  await c.callRole('dispatch', [], {});
  assert.equal(seen[0]['X-Hermes-Screening'], undefined,
    'screening must be the default -- an omitted flag must never mean "skip Layer 2"');

  await c.callRole('dispatch', [], { analysis: true });
  assert.equal(seen[1]['X-Hermes-Screening'], 'analysis', 'analysis: true must set the header');

  await c.callRole('dispatch', [], { analysis: false });
  assert.equal(seen[2]['X-Hermes-Screening'], undefined, 'analysis: false must not set it');

  // And the real call sites: every one that carries `<speaker> message` must either stay
  // unflagged (player chat, screened in full) or flag only via `fromVerifiedBot` -- never a
  // literal `analysis: true`, which has no way to tell a verified bot sender from a player.
  const src = await readFile(root + 'index.js', 'utf8');
  const lines = src.split(String.fromCharCode(10));
  const chatSites = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /\{ role: "user", content: `<\$\{speaker\}>/.test(l));
  assert(chatSites.length >= 3, 'expected to find the player-chat call sites');
  let conditionalSites = 0;
  for (const { i } of chatSites) {
    // the options object for a call site sits within ~40 lines after its user message --
    // generateReply()'s is the farthest, 36 lines away (its <speaker> content line builds
    // `history`, which the real callRole() invocation only joins in later, after the
    // memory-lookup/bossNote work in between); classifyIntent()'s and maybeRemember()'s are
    // both within 2. Found live on spark (2026-10-21): a 25-line window missed generateReply()
    // entirely and crashed the whole suite on an uncaught assertion -- the fix itself was
    // already correct, only this scan's window was too short.
    const window = lines.slice(i, i + 40).join(String.fromCharCode(10));
    const opts = window.match(/\{ *maxTokens:[^}]*\}/);
    if (!opts || !/analysis/.test(opts[0])) continue;
    assert(!/analysis:\s*true\b/.test(opts[0]),
      `index.js line ${i + 1}: a literal analysis:true on a <speaker> content site cannot tell a player from a bot -- found: ${opts[0]}`);
    assert(/analysis:\s*fromVerifiedBot\b/.test(opts[0]),
      `index.js line ${i + 1}: expected analysis tied to fromVerifiedBot, found: ${opts[0]}`);
    conditionalSites++;
  }
  assert.equal(conditionalSites, 2,
    'expected exactly classifyIntent() and generateReply() to carry the S34 verified-bot exemption; maybeRemember() deliberately stays unflagged');
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

// Beds (2026-10-18): a fake world of bed blocks, with the real "sleep" action and no claim
// plumbing at all. `occupied`: positions (either half) where bot.sleep() rejects as taken, same
// way the real server does for a bed someone is actually in.
function bedWorld({ standAt = new V3(0, 64, 0), occupied = [], rememberedBed = null } = {}) {
  const blocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const occupiedSet = new Set(occupied.map(key));
  const addBed = (bx, by, bz) => {
    for (const [dx, part] of [[0, 'foot'], [1, 'head']]) {
      const position = new V3(bx + dx, by, bz);
      blocks.set(key(position), { name: 'red_bed', position, getProperties: () => ({ facing: 'east', part }) });
    }
  };
  const bot = makeBot();
  const tried = [];
  Object.assign(bot, {
    entity: { position: standAt }, isSleeping: false,
    blockAt: (p) => blocks.get(key(p)) || { name: 'air', position: p, getProperties: () => ({}) },
    isABed: (b) => !!b?.name?.endsWith('_bed'),
    findBlocks: ({ matching, count }) => [...blocks.values()].filter(matching)
      .sort((a, b) => a.position.distanceTo(standAt) - b.position.distanceTo(standAt))
      .slice(0, count).map((b) => b.position),
    sleep: async (b) => {
      tried.push(key(b.position));
      // Either half can be in `occupied` -- a bed's head is what nearbyBeds/sleep track, but the
      // server's own real rejection is keyed off whichever half she actually tries to use.
      if (occupiedSet.has(key(b.position)) || occupiedSet.has(key(b.position.offset(-1, 0, 0))) ||
          occupiedSet.has(key(b.position.offset(1, 0, 0)))) throw new Error('occupied.');
      setTimeout(() => bot.emit('wake'), 5);
    },
  });
  bot.pathfinder.goto = async () => {};
  // 2026-10-27: "sleep" now falls back to findRememberedLocation()/gotoRememberedSpot() when
  // nearbyBeds() comes up empty, same stub pattern mine/craft's own remembered-chest/table
  // fallback tests already use elsewhere in this file. Defaults to "nothing remembered either"
  // so every existing bedWorld() scenario (which already has real local beds, or deliberately
  // none at all) behaves exactly as before; rememberedBed (optional) simulates a bed that only
  // becomes locally visible after "travelling" there, same shape addBed() already builds.
  const c = context(bot, { Vec3: V3, SLEEP_TIMEOUT_MS: 1000,
    // 2026-10-28: the shared visit-and-rescan helper (visitRememberedSpot) is what "sleep" calls now.
    visitRememberedSpot: async (_bot, _token, _name, rescan) => {
      if (!rememberedBed) return [];
      addBed(rememberedBed.x, rememberedBed.y, rememberedBed.z);
      return rescan();
    } });
  vm.runInContext(between(actions, 'function bedNearHazard(', '\n// Direct request, 2026-09-09') +
    between(actions, '// A bed is two blocks;', '\n// Direct request, 2026-09-10') + timeoutFn + actionFn, c);
  return { bot, c, addBed, blocks, tried };
}

await check('Beds: sleep tries every usable bed nearest-first, with no claim ever written', async () => {
  const w = bedWorld({ standAt: new V3(0, 64, 5) });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0); w.addBed(12, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['3,64,0'], 'nearest bed, by its head, first try');
});

await check('Beds: an occupied bed is skipped and the next nearest is tried', async () => {
  const w = bedWorld({ standAt: new V3(0, 64, 5), occupied: [new V3(2, 64, 0)] });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0); w.addBed(12, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['3,64,0', '7,64,0'], 'the occupied nearest bed, then the next nearest, which works');
});

await check('Beds: an occupied nearest bed is skipped, and every further bed is still tried (no cap at 3)', async () => {
  const w = bedWorld({ standAt: new V3(0, 64, 5), occupied: [new V3(2, 64, 0), new V3(6, 64, 0), new V3(10, 64, 0)] });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0); w.addBed(10, 64, 0); w.addBed(20, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['3,64,0', '7,64,0', '11,64,0', '21,64,0'], 'all four tried in distance order, 3-candidate cap gone');
});

await check('Beds: every nearby bed occupied fails with the exact text checkSleep pattern-matches', async () => {
  const w = bedWorld({ standAt: new V3(0, 64, 5), occupied: [new V3(2, 64, 0), new V3(6, 64, 0)] });
  w.addBed(2, 64, 0); w.addBed(6, 64, 0);
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, false);
  assert.equal(result.text, 'found beds nearby, but couldn\'t use any of them.',
    'index.js checkSleep() regex-matches this exact string to decide whether to self-propose a bed goal');
});

await check('Beds: no bed anywhere fails with the exact text checkSleep pattern-matches', async () => {
  const w = bedWorld();
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, false);
  assert.equal(result.text, "couldn't find a bed nearby.");
});

await check('Beds: nothing nearby falls back to a remembered bed, and travels to use it', async () => {
  // 2026-10-27 (direct request: "seeking out a bed should not be limited to 'nearby'... if it's
  // a known resource that can be reached, they should use it to sleep"): same local-then-
  // remembered pattern mine/craft already use for crafting_table/furnace.
  const w = bedWorld({ standAt: new V3(0, 64, 5), rememberedBed: { x: 100, y: 64, z: 0 } });
  const result = await w.c.performAction(w.bot, { type: 'sleep' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(w.tried, ['101,64,0'], 'the remembered bed, only visible after "travelling" there');
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
  // 1400, not 900: 2026-10-12's new weapon-goal dispatch (its own header comment included) sits
  // in this same block, between farmTask routing and the "already holding the target" shortcut.
  assert.match(index, /goal\.farmTask \?\?= farmTaskFor\(goal\.description\);[\s\S]{0,1400}if \(goal\.targetItem && holdsItem\(goal\.targetItem\)\)/,
    'farm/ranch/weapon routing runs before the "already holding the target" shortcut and the skill lookup');
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

// Beds (2026-09-26). findBedSites (inside this slice) calls shelter.js's shelterInteriorsNear/
// posKey (2026-10-18) -- wired from the real shelter() context, same pattern context() already
// uses for actions.js's own geometry imports, so the default (no doors in bedSiteWorld) behaves
// exactly like today and a test can still override shelterInteriorsNear to prove the preference.
const bedFns = () => {
  const s = shelter();
  const c = vm.createContext({ Vec3: V3, Math, Object, shelterInteriorsNear: s.shelterInteriorsNear,
    posKey: shelterConst('posKey'), isProtectedBlockName: (n) => n.endsWith('_bed') || n.endsWith('_door') });
  // 2026-10-28: findBedSites' open() now asks isClearableCover() -- the real one, so a flower counts.
  vm.runInContext(between(actions, 'const PLACEMENT_KEEP', 'export async function clearCellForPlacement'), c);
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

await check('Craft: a table-needing recipe is detected even with empty hands, so she searches for/uses a real one instead of guessing', async () => {
  // Real bug found live 2026-10-09 (direct report: bots "repeatedly complain about crafting
  // tables" without ever trying to make one, noticing two standing right next to them, or
  // remembering either's location). recipesFor() filters to recipes she can afford RIGHT NOW --
  // with no planks/sticks on hand it returns nothing for either a no-table or a with-table
  // lookup, so the old tableWouldHelp check (built on recipesFor) always said "no" regardless of
  // what the item's real recipe needs, and the whole search/remember/auto-make-and-place block
  // below it never ran. This reproduces that exact starting state (empty inventory, a real
  // crafting table standing 5 blocks away) against the full "craft" case, not just craftItem().
  const ITEM = { oak_planks: 41, stick: 946, wooden_pickaxe: 827 };
  const PICKAXE_RECIPE = { delta: [{ id: ITEM.stick, count: -2 }, { id: ITEM.oak_planks, count: -3 },
    { id: ITEM.wooden_pickaxe, count: 1 }] };
  const findBlocksCalls = [];
  let gotoCalls = 0;
  const bot = makeBot();
  Object.assign(bot, {
    registry: {
      itemsByName: { wooden_pickaxe: { id: ITEM.wooden_pickaxe } },
      items: { [ITEM.oak_planks]: { name: 'oak_planks' }, [ITEM.stick]: { name: 'stick' } },
      blocksByName: { crafting_table: { id: 10 } },
    },
    inventory: { items: () => [], count: () => 0, slots: [] },
    // Affordable right now only -- what recipesFor really does; empty hands means empty either way.
    recipesFor: () => [],
    recipesAll: (id, _m, table) => (id === ITEM.wooden_pickaxe && table ? [PICKAXE_RECIPE] : []),
    findBlocks: (opts) => { findBlocksCalls.push(opts); return opts.matching === 10 ? [{ x: 5, y: 64, z: 5 }] : []; },
    blockAt: (pos) => ({ position: pos, name: 'crafting_table' }),
    craft: async () => {},
  });
  bot.pathfinder.goto = async () => { gotoCalls++; };
  const c = context(bot, { gearCategoryNames: () => [], tryTakeFromNearbyChest: async () => null,
    visitRememberedSpot: async () => [] });
  vm.runInContext(timeoutFn + actionFn + between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);

  const result = await c.performAction(bot, { type: 'craft', item: 'wooden_pickaxe', count: 1 }, 'test');
  assert.equal(findBlocksCalls.filter((o) => o.matching === 10).length, 1,
    'should search nearby for an existing crafting table instead of skipping straight to "no ingredients"');
  assert.equal(gotoCalls, 1, 'and actually walk to the one it found');
  assert.equal(result.ok, false);
  assert.equal(result.text, "couldn't craft wooden_pickaxe: don't have the ingredients",
    'a real table was found and used, so the failure should name the actual problem (no planks), not guess at the table');
});

await check('Craft: a table requirement is detected even when a DIFFERENT, unusable no-table recipe also exists', async () => {
  // First live run of the check above (2026-10-09) found a second, narrower real bug the mocked
  // version couldn't have caught: a colored bed has a real no-table RECYCLING recipe (dye + a
  // different-colour bed) alongside its real wool+planks shaped recipe (which DOES need a
  // table). "!noTableRecipes.length" treated the mere EXISTENCE of that unrelated, unusable
  // no-table recipe as proof no table was needed at all -- skipping the search even though she
  // can't actually use that recipe (no spare bed, no dye). Confirmed live: "craft red_bed" from
  // wool+planks failed in ~150ms, the same instant-failure signature as the original bug. The
  // real question is whether a table unlocks MORE recipes than she has without one, not whether
  // every recipe happens to need one.
  const ITEM = { red_bed: 1100 };
  const NO_TABLE_RECIPE = { delta: [] }; // stand-in for the real dye-recolor recipe
  const WOOL_PLANKS_RECIPE = { delta: [] }; // stand-in for the real shaped recipe
  const findBlocksCalls = [];
  const bot = makeBot();
  Object.assign(bot, {
    registry: { itemsByName: { red_bed: { id: ITEM.red_bed } }, items: {}, blocksByName: { crafting_table: { id: 10 } } },
    inventory: { items: () => [], count: () => 0, slots: [] },
    recipesFor: () => [],
    recipesAll: (id, _m, table) => (id !== ITEM.red_bed ? [] : table ? [NO_TABLE_RECIPE, WOOL_PLANKS_RECIPE] : [NO_TABLE_RECIPE]),
    findBlocks: (opts) => { findBlocksCalls.push(opts); return opts.matching === 10 ? [{ x: 5, y: 64, z: 5 }] : []; },
    blockAt: (pos) => ({ position: pos, name: 'crafting_table' }),
    craft: async () => {},
  });
  bot.pathfinder.goto = async () => {};
  const c = context(bot, { gearCategoryNames: () => [], tryTakeFromNearbyChest: async () => null,
    visitRememberedSpot: async () => [] });
  vm.runInContext(timeoutFn + actionFn + between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);

  await c.performAction(bot, { type: 'craft', item: 'red_bed', count: 1 }, 'test');
  assert.equal(findBlocksCalls.filter((o) => o.matching === 10).length, 1,
    'an unrelated, unusable no-table recipe existing should not skip the table search');
});

await check('Craft: a reusable utility block found via remembered location skips making a duplicate', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 2 -- "not just her own immediate 32-block
  // view, before spending materials on a duplicate"). REUSABLE_UTILITY_BLOCKS' own local-only
  // check (2026-09-08) now falls back to findRememberedLocation() too, the same "nearby, then
  // remembered" pattern tableWouldHelp's own workbench search already has.
  let gotoRememberedCalls = 0;
  let localHasIt = false; // flips true only once she's actually walked to the remembered spot
  const bot = makeBot();
  Object.assign(bot, {
    registry: { itemsByName: { crafting_table: { id: 1 } }, blocksByName: { crafting_table: { id: 10 } } },
    inventory: { items: () => [], count: () => 0, slots: [] },
    findBlocks: (opts) => ((opts.matching === 10 && localHasIt) ? [{ x: 40, y: 64, z: 40 }] : []),
  });
  const c = context(bot, { gearCategoryNames: () => [], tryTakeFromNearbyChest: async () => null,
    visitRememberedSpot: async (_bot, _token, name, rescan) => {
      assert.equal(name, 'crafting_table');
      gotoRememberedCalls++; localHasIt = true;
      return rescan();
    } });
  vm.runInContext(timeoutFn + actionFn + between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);

  const result = await c.performAction(bot, { type: 'craft', item: 'crafting_table', count: 1 }, 'test');
  assert.equal(gotoRememberedCalls, 1, 'walked to the remembered spot instead of crafting a new one outright');
  assert.equal(result.ok, true);
  assert.match(result.text, /already have a crafting_table nearby/);
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

await check('Craft: finding an already-placed utility block nearby gets remembered too, not just a freshly-placed one', async () => {
  // Real bug found live 2026-10-09, same direct report as the check above: "craft"'s own
  // REUSABLE_UTILITY_BLOCKS short-circuit (actions.js) finds an existing crafting_table/furnace
  // within 32 blocks and skips making a duplicate ("already have a crafting_table nearby, no
  // need to make another") -- a real, just-confirmed position that used to just vanish, so the
  // next bot who needed one started from zero again. goalTick now reuses noteNearbyResources()
  // (the same scan/record step mine/explore/scout already trigger) for any successful "craft"
  // step on a CRAFTED_OBJECT_NAMES item, whether she made a new one or merely found one standing
  // there already.
  const calls = [];
  const c = vm.createContext({
    result: { ok: true, text: 'already have a crafting_table nearby, no need to make another.' },
    parsed: { action: { type: 'craft', item: 'crafting_table' } },
    CRAFTED_OBJECT_NAMES: ['crafting_table', 'furnace', 'chest', 'trapped_chest', 'beehive', 'bee_nest'],
    noteNearbyResources: (reason) => { calls.push(reason); return Promise.resolve(); },
    USERNAME: 'Amy', console: { log() {}, error() {} },
  });
  vm.runInContext(between(index, 'if (result.ok && parsed.action.type === "craft"',
    '// Environmental memory (direct follow-up, 2026-09-07'), c);
  assert.deepEqual(calls, ['after a successful craft'],
    'an existing crafting table found nearby during a craft attempt used to go unrecorded');
});

function bedSiteWorld({ beds = [], doors = [], walls = [] } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const bedSet = new Set(beds.map(key)), doorSet = new Set(doors.map(key)), wallSet = new Set(walls.map(key));
  const blockAt = (p) => {
    if (p.y < 64) return { name: 'grass_block', boundingBox: 'block' };
    if (bedSet.has(key(p))) return { name: 'red_bed', boundingBox: 'block' };
    if (doorSet.has(key(p))) return { name: 'oak_door', boundingBox: 'block' };
    if (wallSet.has(key(p))) return { name: 'cobblestone', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  return {
    blockAt,
    isABed: (b) => b.name.endsWith('_bed'),
    entity: {}, entities: {},
    // 2026-10-18: used to ignore `matching` entirely and always return bed positions -- harmless
    // while only findBedSites' own bed lookup ever called this, but shelterInteriorsNear now
    // scans the same world for doors, so this has to honour its own filter for real.
    findBlocks: ({ matching } = {}) => [...beds, ...doors, ...walls].map((p) => new V3(p.x, p.y, p.z))
      .filter((p) => (typeof matching === 'function' ? matching(blockAt(p)) : true)),
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

await check('Beds: a bed goal loots wool once, gets the rest from sheep, makes planks from her logs, crafts, places, then is done', async () => {
  const inv = [{ name: 'oak_log', count: 4 }];
  const calls = []; const done = [];
  const performAction = async (b, action) => {
    calls.push(action.type + (action.item ? `:${action.item}` : ''));
    if (action.type === 'loot') return { ok: false, text: 'no wool in any chest' };
    if (action.type === 'get_wool') { inv.push({ name: 'white_wool', count: 3 }); return { ok: true, text: 'gathered wool' }; }
    if (action.type === 'craft' && action.item.endsWith('_planks')) { inv.push({ name: action.item, count: action.count }); return { ok: true, text: 'crafted planks' }; }
    if (action.type === 'craft') { inv.splice(0, inv.length, { name: action.item, count: 1 }); return { ok: true, text: 'crafted' }; }
    if (action.type === 'place_bed') return { ok: true, text: 'placed a white_bed at home.', bedAt: { x: 3, y: 64, z: 0 } };
    return { ok: false, text: '?' };
  };
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Amy', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, inventory: { items: () => inv }, entities: {}, registry: { blocksByName: { crafting_table: { id: 1 } } },
      findBlocks: () => [] }, Vec3: V3, performAction,
    farmStatus: () => ({ ripe: 0, growing: 0 }), narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async (status) => { done.push(status); }, retireGoal: async () => {}, saveGoalIfCurrent: async () => {},
    logStep: () => {}, loadPenLocation: async () => null, LIVESTOCK: [], BREEDING_FOOD: {}, countInPen: () => 0, findPenSite: () => null,
    woolCounts: (b) => Object.fromEntries(b.inventory.items().filter((i) => i.name.endsWith('_wool')).map((i) => [i.name.slice(0, -5), i.count])),
    bedItemFor: () => 'white_bed',
    // 2026-10-27: runBedGoal now registers a RAG note on completion (writeMemoryNote,
    // longterm.js) -- this slice starts after that import, so it has to be stubbed here same as
    // every other cross-module function this context already injects.
    writeMemoryNote: async () => {}, PERSONA_NAME: 'amy' });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { description: 'make myself a bed and place it at home', createdAt: Date.now(), consecutiveFailures: 0 };
  for (let i = 0; i < 8 && !done.length; i++) await c.runBedGoal(goal, async () => true, () => ({ release() {} }), () => false);
  assert.deepEqual(calls, ['loot:wool', 'get_wool', 'craft:oak_planks', 'craft:white_bed', 'place_bed'],
    'no table nearby: 7 planks from her logs before the bed');
  assert.deepEqual(done, ['done']);
});

await check('Beds: a bed in hand builds at home when near, but on the spot when far from both home and any remembered bed', async () => {
  // 2026-10-27 (direct request: "if exploring, and far away from a known bed listed in world
  // resources, they should try to build a new one"): place_bed already supports an arbitrary
  // action.near (added for the communal shelter) -- bedStep now points it at her own current
  // position instead of forcing a long trip home, once she's genuinely far from both.
  let lastAction = null;
  const performAction = async (b, action) => { lastAction = action; return { ok: true, text: 'placed a bed.', bedAt: { x: 1, y: 64, z: 1 } }; };
  const invBed = { items: () => [{ name: 'white_bed', count: 1 }] };
  const makeCtx = (bot, findRememberedLocation) => {
    const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Amy',
      bot, performAction, woolCounts: () => ({}), BUILDER_PRIORITY_RADIUS: 24, findRememberedLocation });
    vm.runInContext(farmGoalSrc(), c);
    return c;
  };
  // Near home: default behaviour, unchanged -- no action.near at all, findRememberedLocation
  // never even consulted.
  const near = makeCtx({ inventory: invBed, spawnPoint: new V3(0, 64, 0), entity: { position: new V3(5, 64, 0) } },
    async () => { throw new Error('should not be consulted when already near home'); });
  await near.bedStep({}, {});
  assert.equal(lastAction.type, 'place_bed');
  assert.equal(lastAction.near, undefined, 'near home -- goes home as before, no explicit near');

  // Far from home, and no remembered bed either: builds right where she is.
  const far = makeCtx({ inventory: invBed, spawnPoint: new V3(0, 64, 0), entity: { position: new V3(100, 64, 0) } },
    async () => null);
  await far.bedStep({}, {});
  // Field-by-field, not assert.deepEqual on the whole object: lastAction.near was built by code
  // running inside a separate vm.Context (farmGoalSrc()'s own realm), so its object literal has
  // that realm's Object.prototype, not this test file's -- deepStrictEqual (what the strict
  // assert module's deepEqual actually is) fails on that cross-realm identity mismatch even
  // though the own-enumerable values are identical and print identically.
  assert.equal(lastAction.near.x, 100, 'far from everything -- builds where she is (x)');
  assert.equal(lastAction.near.y, 64, 'far from everything -- builds where she is (y)');
  assert.equal(lastAction.near.z, 0, 'far from everything -- builds where she is (z)');

  // Far from home, but a remembered bed is close to her CURRENT position: the "far from
  // everything" trigger doesn't fire, so the default (home) still applies.
  const nearRemembered = makeCtx({ inventory: invBed, spawnPoint: new V3(0, 64, 0), entity: { position: new V3(100, 64, 0) } },
    async () => ({ x: 105, y: 64, z: 0 }));
  await nearRemembered.bedStep({}, {});
  assert.equal(lastAction.near, undefined, 'a nearby remembered bed means she is not "far from everything" -- default applies');
});

await check('Beds: a night with no bed gives an idle bot a bed goal for the morning, and never replaces a goal', async () => {
  assert.match(index, /\/couldn't find a bed\/\.test\(result\.text\) \|\|\s+\(\/found beds nearby, but couldn't use any\/\.test\(result\.text\) && bedsNearHome\(\) < BOT_USERNAMES\.size\)\)\) await wantBed\(\);/,
    'no bed at all, or none free while home has fewer beds than bots');
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
  // 2026-10-11: the doorway column used to be excluded from the fill entirely (a bare, permanent
  // gap); now only its two door-height cells are (doorwayPosition() takes them for a real door),
  // its lintel rejoins the wall count, and the floor under the room is included too.
  // Also 2026-10-11: the room itself grew from 2x2 to 2x3 (a real door and a bed could never both
  // fit in 2x2 -- SHELTER_ROOM's own header comment has the full account).
  // 13 full wall columns x 3 (39) + the doorway column's lintel (1) + a 4x5 roof (20) + a 2x3
  // floor (6) = 66.
  assert.equal(c.shelterPositions(new V3(0, 64, 0)).length, 66,
    '13 full wall columns x 3, + the doorway column\'s lintel, + a 4x5 roof, + a 2x3 floor');
  const doorPos = c.doorwayPosition(new V3(0, 64, 0));
  assert.deepEqual({ x: doorPos.x, y: doorPos.y, z: doorPos.z }, { x: 0, y: 64, z: 3 },
    'the doorway sits at the lower door cell, excluded from the generic fill above');
  assert.equal(c.doorItemFor({ inventory: { items: () => [{ name: 'spruce_planks', count: 4 }] } }), 'spruce_door');
  assert.equal(c.doorItemFor({ inventory: { items: () => [] } }), 'oak_door', 'no planks held -- defaults to oak');
  const build = actions.slice(actions.indexOf('case "build": {'), actions.indexOf('case "build_pen": {'));
  assert.match(build, /buildMovements\.scafoldingBlocks = \[\];/, 'no scaffolding: she pillared up inside her own shelter');
  assert.match(build, /buildMovements\.allow1by1towers = false;/);
  assert.match(build, /finally \{\s+if \(bot\.pathfinder\.movements === buildMovements\) bot\.pathfinder\.setMovements\(sharedMovements\);/);
});

await check('Communal shelter: stone-or-better material, parameterized geometry, a door-first build', async () => {
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a -- "every block used must be at least
  // stone tier... though the materials don't all have to match each other").
  const c = shelterFns();
  for (const n of ['stone', 'cobblestone', 'mossy_cobblestone', 'deepslate', 'stone_bricks', 'andesite', 'iron_block', 'bricks', 'white_concrete']) {
    assert.equal(c.isCommunalShelterMaterial(n), true, n);
  }
  for (const n of ['dirt', 'sand', 'oak_planks', 'oak_log', 'gravel', 'iron_ore', 'netherrack', 'glass']) {
    assert.equal(c.isCommunalShelterMaterial(n), false, n);
  }
  const bot = { inventory: { items: () => [{ name: 'stone', count: 40 }, { name: 'oak_planks', count: 20 }, { name: 'cobblestone', count: 10 }] } };
  assert.equal(c.communalShelterMaterialCount(bot), 50, 'stone and cobblestone count; planks (wood) do not');

  // 5x5 interior: dx -1..5 (7) x dz -1..5 (7) = 49 pairs, minus the 5x5=25 room pairs = 24 wall
  // columns; 23 full (x3 = 69) + the doorway column's lintel only (1) = 70 walls, + a 7x7 roof
  // (49) + a 5x5 floor (25) = 144.
  const base = new V3(0, 64, 0);
  assert.equal(c.communalShelterPositions(base, 5, 5).length, 144,
    '23 full wall columns x 3, + the doorway column\'s lintel, + a 7x7 roof, + a 5x5 floor');
  const doorPos = c.communalDoorwayPosition(base, 5);
  assert.deepEqual({ x: doorPos.x, y: doorPos.y, z: doorPos.z }, { x: 0, y: 64, z: 5 });
  assert.deepEqual([...c.communalRoomCells(2, 1)].map((p) => [...p]), [[0, 0], [1, 0]]);

  const communalBuild = actions.slice(actions.indexOf('case "build_communal_shelter": {'), actions.indexOf('case "build_pen": {'));
  assert.match(communalBuild, /isCommunalShelterMaterial/, 'uses the stricter material check, not the individual-shelter baseline');
  assert.match(communalBuild, /if \(!width \|\| !depth\) return fail/, 'refuses to guess a size if none was given');
  // Same door-first-craft/door-last-placement order as "build" -- see that case's own header for
  // the two real bugs (plank starvation, wrong door facing) this order exists to avoid repeating.
  const doorCraftIdx = communalBuild.indexOf('type: "craft", item: doorItemFor(bot)');
  const wallLoopIdx = communalBuild.indexOf('for (const pos of buildOrder)');
  const doorPlaceIdx = communalBuild.indexOf('await bot.placeBlock(floorBelow');
  assert(doorCraftIdx > 0 && doorCraftIdx < wallLoopIdx && wallLoopIdx < doorPlaceIdx,
    'door item crafted before the wall loop, door itself placed after it');
});

await check('Shelter patch: takes an explicit hole list, never a door, never its own geometry', async () => {
  // Direct request, 2026-10-22, generalizing S42: "patch_shelter" exists specifically so a
  // shelter's REAL, already-found holes (shelterRoomsNear()/holesIn(), shelter.js) get filled
  // exactly as found -- never recomputed from a predetermined shape the way "build"/
  // "build_communal_shelter" above do, which is what lets it work on a shelter of any size or
  // shape. holesIn() already excludes every doorway cell from its own output, so there is
  // structurally never a door to craft or place here.
  const patchBody = actions.slice(actions.indexOf('case "patch_shelter": {'), actions.indexOf('case "build_communal_shelter": {'));
  assert(patchBody.length > 0, 'the case exists');
  assert(!/doorItemFor|doorPlaced|doorAlready/.test(patchBody), 'never touches a door -- holesIn() already excludes doorway cells');
  assert.match(patchBody, /action\.holes \|\| \[\]/, 'takes an explicit hole list from the caller');
  assert(!/buildOrder|shelterPositions|communalShelterPositions/.test(patchBody), 'never computes its own geometry');
  assert.match(patchBody, /isShelterMaterial/, 'uses the same permissive material check "build" does');
});

await check('Communal shelter: structure completeness and bed-count verification, mocked', async () => {
  const s = shelterFns();
  const base = new V3(0, 64, 0);
  const width = 5, depth = 5;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const communalMockBot = (doorAt, bedCells) => {
    const solid = new Set(s.communalShelterPositions(base, width, depth).map(key));
    const doors = new Set(doorAt ? [key(doorAt)] : []);
    const beds = new Set((bedCells || []).map(key));
    return { spawnPoint: base, isABed: (b) => b?.name === 'white_bed',
      blockAt: (p) => (beds.has(key(p)) ? { name: 'white_bed', boundingBox: 'block' }
        : doors.has(key(p)) ? { name: 'oak_door', boundingBox: 'empty', getProperties: () => ({ half: 'lower' }) }
        : { name: 'x', boundingBox: solid.has(key(p)) ? 'block' : 'empty' }) };
  };
  const check2 = (bot) => {
    const h = vm.createContext({ bot, Math, BOT_USERNAMES: new Set(['amy']), BUILDER_PRIORITY_RADIUS: 6,
      communalShelterPositions: s.communalShelterPositions, communalDoorwayPosition: s.communalDoorwayPosition });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
      between(index, 'const TOOL_NAME', 'function nextSurvivalPriority('), h);
    return h;
  };
  const doorPos = s.communalDoorwayPosition(base, depth);
  const noBeds = check2(communalMockBot(doorPos, []));
  assert.equal(noBeds.hasCommunalShelterStructure(), true, 'walls/roof/floor/door complete');
  assert.equal(noBeds.communalShelterSatisfied(), false, 'no beds yet -- not satisfied');
  const oneBed = check2(communalMockBot(doorPos, [base.offset(0, 0, 0), base.offset(1, 0, 0)]));
  assert.equal(oneBed.communalShelterBedCount(base, width, depth), 1);
  assert.equal(oneBed.communalShelterSatisfied(), false, '1 bed, need 2 (N+1 for a 1-bot fleet)');
  const bedCells2 = [base.offset(0, 0, 0), base.offset(1, 0, 0), base.offset(0, 0, 1), base.offset(1, 0, 1)];
  const twoBeds = check2(communalMockBot(doorPos, bedCells2));
  assert.equal(twoBeds.communalShelterBedCount(base, width, depth), 2);
  assert.equal(twoBeds.communalShelterSatisfied(), true, '2 beds meets the target');
  const noDoor = check2(communalMockBot(null, bedCells2));
  assert.equal(noDoor.hasCommunalShelterStructure(), false, 'no real door -- not complete, regardless of beds');
});

await check('findCommunalShelterNearHome finds a damaged communal shelter as a repair target, not just complete-or-nothing', async () => {
  // Direct report, 2026-10-22 ("there is a large shelter with many beds, but it has holes or
  // missing parts. They are not repairing it as a large structure"): this detector already
  // existed and was already correct, but nothing had ever exercised its DAMAGED case -- only
  // "fully complete" and "missing its door entirely" were tested above. checkCommunalShelterIntegrity()
  // (index.js 2.120.0) depends on exactly this case to find its repair target.
  const s = shelterFns();
  const base = new V3(0, 64, 0);
  const width = 5, depth = 5;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const full = s.communalShelterPositions(base, width, depth);
  const doorPos = s.communalDoorwayPosition(base, depth);
  const findCheck = (positions, doorAt) => {
    const solid = new Set(positions.map(key));
    const doors = new Set(doorAt ? [key(doorAt)] : []);
    const mockBot = { spawnPoint: base, isABed: () => false,
      blockAt: (p) => (doors.has(key(p)) ? { name: 'oak_door', boundingBox: 'empty', getProperties: () => ({ half: 'lower' }) }
        : { name: 'x', boundingBox: solid.has(key(p)) ? 'block' : 'empty' }) };
    const h = vm.createContext({ bot: mockBot, Math, BOT_USERNAMES: new Set(['amy']), BUILDER_PRIORITY_RADIUS: 6,
      communalShelterPositions: s.communalShelterPositions, communalDoorwayPosition: s.communalDoorwayPosition });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
      between(index, 'const TOOL_NAME', 'function nextSurvivalPriority('), h);
    return h.findCommunalShelterNearHome();
  };
  assert.equal(findCheck(full, doorPos).complete, true, 'sanity: the full structure reads as complete');

  // A few blocks knocked out (the real "a creeper blew a hole in it" shape) -- still well over
  // half solid, still shelter-shaped, just not sealed.
  const damaged = findCheck(full.slice(5), doorPos);
  assert.equal(damaged.complete, false, 'missing wall blocks -- not complete');
  assert.deepEqual([damaged.base.x, damaged.base.y, damaged.base.z], [base.x, base.y, base.z],
    "the damaged shelter's own base is returned -- checkCommunalShelterIntegrity()'s repair target, not a bare false");
  assert.equal(damaged.width, width); assert.equal(damaged.depth, depth);

  // Well under half solid -- not a real repair target, just coincidental open space.
  const tooDamaged = findCheck(full.slice(Math.ceil(full.length / 2) + 5), doorPos);
  assert.equal(tooDamaged, null, 'under half solid -- too far gone to count as a genuine repair target');
});

await check('checkShelterIntegrity (unified, general) repairs the first damaged room found, any count or shape, never a complete one or a bare absence', async () => {
  // S42 shipped checkShelterIntegrity()/checkCommunalShelterIntegrity() as two separate
  // functions, one per hand-coded geometry. The very next request generalized detection itself
  // (shelterRoomsNear(), tested directly above) and asked for "any number" -- this is the
  // matching check on the periodic wrapper: it must act on whichever room in the list is
  // damaged, not just the first one found, and must hand the real hole positions straight to
  // the new generic "patch_shelter" action rather than any geometry-specific build call.
  const calls = [];
  const mkContext = (rooms) => {
    const c = vm.createContext({
      AUTONOMY_ENABLED: true, routineBlocked: () => false,
      shelterRoomsNear: () => rooms,
      arbiter: { requestControl: async () => ({ release() {} }), OWNERS: { ROUTINE: 'routine' } },
      performAction: async (_bot, action) => { calls.push(action); return { ok: true, text: 'patched the shelter.' }; },
      bot: { spawnPoint: new V3(0, 64, 0) }, USERNAME: 'Test', console: { log() {}, error() {} },
    });
    vm.runInContext(between(index, 'async function checkShelterIntegrity() {', 'setInterval(() => {'), c);
    return c;
  };
  const complete = { inside: new Set(['0,64,0']), shell: new Set(), holes: new Set() };
  const damaged = { inside: new Set(['10,64,0']), shell: new Set(), holes: new Set(['9,65,0', '9,66,0']) };

  await mkContext([complete, damaged]).checkShelterIntegrity();
  assert.equal(calls.length, 1, 'the damaged room, found anywhere in the list, triggers a repair');
  assert.equal(calls[0].type, 'patch_shelter');
  // holes was built inside the vm context, so it (and anything .map() derives from it without
  // first re-literalizing) carries that context's own Array.prototype -- deepEqual against a
  // plain literal then fails on realm identity alone, "same structure but not reference-equal,"
  // even with identical content. Spreading into a fresh array first constructs it in THIS realm.
  const gotKeys = [...calls[0].holes].map((p) => `${p.x},${p.y},${p.z}`).sort();
  assert.deepEqual(gotKeys, ['9,65,0', '9,66,0'], 'the real hole positions, not a recomputed geometry, are passed through');

  calls.length = 0;
  await mkContext([complete]).checkShelterIntegrity();
  assert.equal(calls.length, 0, 'every room complete -- nothing to repair');

  calls.length = 0;
  await mkContext([]).checkShelterIntegrity();
  assert.equal(calls.length, 0, 'no shelter rooms at all near home -- nothing to repair');
});

function shelterWorld({ groundY = (x, z) => 63, blocked = [] } = {}) {
  const b = new Set(blocked.map((p) => `${p.x},${p.y},${p.z}`));
  return { blockAt: (p) => (p.y <= groundY(p.x, p.z) || b.has(`${p.x},${p.y},${p.z}`)
    ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }) };
}

await check('Shelters: the site is a flat, clear 4x5 within 4 blocks of home, even a step above or below it', async () => {
  const c = shelterFns();
  const home = new V3(0, 64, 0);
  const flat = c.findShelterSite(shelterWorld(), home);
  assert.deepEqual([flat.x, flat.y, flat.z], [0, 64, 0], 'right on home when that is clear');
  const wall = [];
  for (let z = -3; z <= 6; z++) for (let y = 64; y <= 66; y++) wall.push(new V3(3, y, z)); // a wall one block past the 4x5
  const tight = c.findShelterSite(shelterWorld({ blocked: wall }), home);
  assert(tight.x + 2 < 3, `the whole 4x5 footprint stays clear of the wall: base ${tight}`);
  const tree = c.findShelterSite(shelterWorld({ blocked: [new V3(0, 65, 0)] }), home);
  assert(Math.max(Math.abs(tree.x), Math.abs(tree.z)) <= 4 && Math.max(Math.abs(tree.x), Math.abs(tree.z)) >= 2, `moved off the obstacle: ${tree}`);
  const raised = c.findShelterSite(shelterWorld({ groundY: () => 64 }), home);
  assert.equal(raised.y, 65, 'the ground is a block higher than spawn');
  assert.equal(c.findShelterSite(shelterWorld({ groundY: (x, z) => 63 + ((x + z) & 1) }), home), null, 'nowhere flat');
});

await check('Shelters: a crowded core still finds a site farther out once maxRadius allows it', async () => {
  // 2026-10-27 (direct request, "allow the shelter search radius to go up to 48 blocks"): up to
  // BOT_USERNAMES.size individual shelters need to fit somewhere near home -- once the crafting
  // table/furnace/chest/earlier shelters crowd the old fixed 4-block core, site-finding used to
  // fail forever. Blocks every column a radius-4 search could possibly reach (footprint offsets
  // are dx-1..dx+2 in x, dz-1..dz+3 in z, for dx/dz in [-4,4] -- so x in [-5,6], z in [-5,7]) up
  // through the shelter's own height, leaving everything farther out untouched.
  const c = shelterFns();
  const home = new V3(0, 64, 0);
  const core = [];
  for (let x = -5; x <= 6; x++) for (let z = -5; z <= 7; z++) for (let y = 64; y <= 67; y++) core.push(new V3(x, y, z));
  const world = shelterWorld({ blocked: core });
  assert.equal(c.findShelterSite(world, home), null,
    'default maxRadius=4 still fails -- same cost/behavior as before this fix');
  const wider = c.findShelterSite(world, home, 48);
  assert(wider, 'a wider search finds a site once allowed past the crowded core');
  assert(Math.max(Math.abs(wider.x), Math.abs(wider.z)) > 6, `the found site is actually outside the blocked core: ${wider}`);
});

await check('Shelters: shelter goals are recognised, and the shelter check finds one a block above spawn', async () => {
  const c = vm.createContext({ setInterval() {}, Date });
  vm.runInContext(farmGoalSrc(), c);
  assert.equal(c.farmTaskFor('go home and build a small shelter there'), 'shelter');
  assert.equal(c.farmTaskFor("No roof over my head yet... I'm building a quick shelter nearby"), 'shelter');
  assert.equal(c.farmTaskFor('go to the shelter and wait'), null);
  // Real bug found live 2026-10-16 (direct report: "check the last 24 hours behavior logs for
  // incorrect behaviors"). BED_WORDS used to be checked before SHELTER_WORDS/
  // COMMUNAL_SHELTER_WORDS -- harmless until nextSurvivalPriority()'s own Tier 1 directive
  // started literally saying "bed" too ("...shelter with a bed in it yet -- build one near
  // home..."). BED_WORDS matched first, so the whole goal (build a real room) got routed to
  // bedStep (place a bed in the open) instead of shelterStep. Confirmed live: Bob/Dale/Nell had
  // 313 combined "bed goal:" lines and 0 "shelter goal:" lines in 24h on exactly this goal.
  const SHELTER_DIRECTIVE = "you don't have your own shelter with a bed in it yet -- build one " +
    "near home: a small sealed room with complete walls, a roof, a floor, a real door (not just " +
    "an opening), and a bed inside. Check whether an existing shelter nearby already has room " +
    "for another bed before starting a brand new structure.";
  assert.equal(c.farmTaskFor(SHELTER_DIRECTIVE), 'shelter',
    'the whole-room directive routes to shelterStep, not bedStep, even though it says "bed" too');
  assert.equal(c.farmTaskFor('make myself a bed and place it at home'), 'bed',
    'the plain bed goal (no mention of a shelter) still routes to bedStep as before');
  // A complete shelter whose floor is at spawn height + 1: the old check only looked at spawn height.
  const s = shelterFns();
  // 2026-10-11: a shelter now also needs a real door (not an opening) and a fully (not 80%)
  // solid wall/roof/floor -- shelterBot() places one at doorwayPosition() unless told not to, and
  // `cells` controls exactly how complete the rest is.
  // findBlocks (2026-10-28): completeSheltersNearHome() finds complete shelters by their doors.
  const doorFinder = (doorCells, blockAt) => ({ point, matching, maxDistance }) => doorCells
    .filter((p) => matching(blockAt(p)) && p.distanceTo(point) <= maxDistance)
    .sort((a, b) => a.distanceTo(point) - b.distanceTo(point));
  const shelterBot = (cells, { bedAt = null, doorAt = null, bedsAt = [] } = {}) => {
    const solid = new Set(cells.map((p) => `${p.x},${p.y},${p.z}`));
    const doors = [].concat(doorAt ?? []), beds = [].concat(bedAt ?? [], bedsAt);
    const blockAt = (p) => (beds.some((b) => p.equals(b)) ? { name: 'white_bed', boundingBox: 'block' }
      : doors.some((d) => p.equals(d)) ? { name: 'oak_door', boundingBox: 'empty', getProperties: () => ({ half: 'lower' }) }
      : { name: 'x', boundingBox: p.y <= 64 || solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' });
    return { spawnPoint: new V3(0, 64, 0), isABed: (b) => b.name === 'white_bed', blockAt, findBlocks: doorFinder(doors, blockAt) };
  };
  const check = (bot) => {
    const h = vm.createContext({ bot, Math, shelterPositions: s.shelterPositions, doorwayPosition: s.doorwayPosition,
      SHELTER_ROOM: vm.runInContext('SHELTER_ROOM', s),
      // 2026-10-27: findShelterNearHome() now rings outward up to BUILDER_PRIORITY_RADIUS (see
      // its own header comment, index.js) -- the extracted slice starts AFTER that const's real
      // declaration, so it has to be injected here, same as every other module-level const this
      // slice already needs from outside it (SHELTER_ROOM above).
      BUILDER_PRIORITY_RADIUS: 24 });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
      between(index, 'const shelterGeometryPositions', 'const BUILDER_ITEM_STALL_LIMIT'), h);
    return h.hasShelterNearHome();
  };
  const base = new V3(0, 65, 0);
  const full = s.shelterPositions(base), doorPos = s.doorwayPosition(base);
  assert.equal(check(shelterBot(full, { doorAt: doorPos })), true, 'a 4x5 shelter a step up, sealed with a door');
  assert.equal(check(shelterBot(full, { doorAt: doorPos, bedAt: new V3(0, 65, 1) })), true, 'a bed in the room still counts');
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 1 item 2): hasShelterNearHome() alone only proves the
  // STRUCTURE is complete -- confirmed live that the fleet's separate bed-count and
  // shelter-exists checks are fully independent, so a shelter with no bed at all still passes it.
  // hasOwnShelterWithBed() is the real per-bot check: the same complete structure, PLUS an actual
  // bed in one of its own room cells.
  const ownShelterCheck = (bot) => {
    const h = vm.createContext({ bot, Math, shelterPositions: s.shelterPositions, doorwayPosition: s.doorwayPosition,
      SHELTER_ROOM: vm.runInContext('SHELTER_ROOM', s),
      // 2026-10-27: findShelterNearHome() now rings outward up to BUILDER_PRIORITY_RADIUS (see
      // its own header comment, index.js) -- the extracted slice starts AFTER that const's real
      // declaration, so it has to be injected here, same as every other module-level const this
      // slice already needs from outside it (SHELTER_ROOM above).
      BUILDER_PRIORITY_RADIUS: 24 });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
      between(index, 'const shelterGeometryPositions', 'const BUILDER_ITEM_STALL_LIMIT'), h);
    return h.hasOwnShelterWithBed();
  };
  assert.equal(ownShelterCheck(shelterBot(full, { doorAt: doorPos })), false,
    'a complete, sealed shelter with no bed inside is not "her own sheltered bed" yet');
  assert.equal(ownShelterCheck(shelterBot(full, { doorAt: doorPos, bedAt: new V3(0, 65, 1) })), true,
    'complete, sealed, and a bed inside -- this is what Tier 1 item 2 actually requires');
  // Real gap found live 2026-10-11: before this, a shelter with no door at all (shelterPositions()
  // left that whole column permanently excluded from the fill) still passed every time.
  assert.equal(check(shelterBot(full)), false, 'no door at all -- not sealed, does not count');
  // Before this, an 80%-complete shelter counted; it no longer does -- one missing wall block out
  // of 66 is still a real, unsealed gap.
  const oneShort = full.slice(1);
  assert.equal(check(shelterBot(oneShort, { doorAt: doorPos })), false, 'one missing wall block out of 66 -- not 100%, does not count');
  // The floor was never checked at all before this; a room floating over open air now fails too.
  // A higher base (not y <= 64, shelterBot's own hardcoded "ground") so the floor cells actually
  // depend on `cells` instead of always reading as solid regardless.
  const base2 = new V3(0, 66, 0); // within findShelterNearHome's dy -2..2 search range; floor at y=65, not the mock's hardcoded y<=64 "ground"
  const full2 = s.shelterPositions(base2), doorPos2 = s.doorwayPosition(base2);
  const floorCells = vm.runInContext('SHELTER_ROOM', s).map(([dx, dz]) => ({ x: base2.x + dx, y: base2.y - 1, z: base2.z + dz }));
  const noFloor = full2.filter((p) => !floorCells.some((f) => f.x === p.x && f.y === p.y && f.z === p.z));
  assert.equal(check(shelterBot(full2, { doorAt: doorPos2 })), true, 'sanity: the same shape at a higher base still counts complete');
  assert.equal(check(shelterBot(noFloor, { doorAt: doorPos2 })), false, 'walls and roof solid, floor missing -- does not count');
  // findShelterNearHome() itself (not just the hasShelterNearHome() boolean wrapper): a real,
  // damaged shelter -- hollow-interior-shaped, missing its door -- is a repair target, not a
  // bare "no shelter," since checkShelterIntegrity() needs its base to send "build" back to.
  const findCheck = (bot) => {
    const h = vm.createContext({ bot, Math, shelterPositions: s.shelterPositions, doorwayPosition: s.doorwayPosition,
      SHELTER_ROOM: vm.runInContext('SHELTER_ROOM', s),
      // 2026-10-27: findShelterNearHome() now rings outward up to BUILDER_PRIORITY_RADIUS (see
      // its own header comment, index.js) -- the extracted slice starts AFTER that const's real
      // declaration, so it has to be injected here, same as every other module-level const this
      // slice already needs from outside it (SHELTER_ROOM above).
      BUILDER_PRIORITY_RADIUS: 24 });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
      between(index, 'const shelterGeometryPositions', 'const BUILDER_ITEM_STALL_LIMIT'), h);
    return h.findShelterNearHome();
  };
  const damaged = findCheck(shelterBot(full2));
  assert.equal(damaged.complete, false, 'no door -- incomplete');
  assert.deepEqual([damaged.base.x, damaged.base.y, damaged.base.z], [base2.x, base2.y, base2.z],
    'and the damaged shelter\'s own base is returned, not just a bare false');
  // The old 3x3 shelter (one cell inside) no longer counts: it can't fit a bed.
  const old = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if ((dx || dz) && !(dx === 0 && dz === 1)) for (let dy = 0; dy <= 2; dy++) old.push(new V3(dx, 65 + dy, dz));
    old.push(new V3(dx, 68, dz));
  }
  assert.equal(check(shelterBot(old)), false, "a shelter that can't fit a bed isn't enough");

  // 2026-10-27: findShelterNearHome() now rings outward up to BUILDER_PRIORITY_RADIUS, the same
  // way findShelterSite() (actions.js) now does for siting a NEW shelter -- otherwise a shelter
  // genuinely built beyond the old fixed 4-block window would be invisible to this check, and
  // shelterStep() would report its own build ok:true but done:false forever (a silent infinite
  // loop, confirmed worse than the bounded give-up/re-propose churn that existed before).
  const base3 = new V3(10, 65, 0); // outside the old radius-4 window, inside the new 24 cap
  const full3 = s.shelterPositions(base3), doorPos3 = s.doorwayPosition(base3);
  assert.equal(check(shelterBot(full3, { doorAt: doorPos3 })), true,
    'a complete shelter 10 blocks out is now recognised, not just one right at home');

  // Real bug caught in review, 2026-10-27: the naive ring-expansion stopped as soon as ANY ring
  // returned non-null -- but the innermost ring (radius 4) can return a non-null DAMAGED match
  // (trackDamaged is only true there) well before a genuinely complete shelter farther out ever
  // gets looked for. A half-built structure left near home (plausible in exactly the crowded-base
  // scenario this whole fix targets) would have made hasShelterNearHome() report false even
  // though a complete shelter demonstrably exists 10 blocks away. Combine the existing damaged
  // (no-door) shelter at home with the existing complete one at base3 in one world: only a
  // complete match may short-circuit the ring search, so this must still find and return it.
  const damagedAndFarComplete = [...full2, ...full3];
  assert.equal(check(shelterBot(damagedAndFarComplete, { doorAt: doorPos3 })), true,
    'a damaged shelter at home must not hide a genuinely complete one farther out');
  const farCompleteResult = findCheck(shelterBot(damagedAndFarComplete, { doorAt: doorPos3 }));
  assert.equal(farCompleteResult.complete, true, 'the complete one farther out wins, not the near damaged one');
  assert.deepEqual([farCompleteResult.base.x, farCompleteResult.base.y, farCompleteResult.base.z],
    [base3.x, base3.y, base3.z], 'and it is specifically the far shelter\'s own base that comes back');

  // 2026-10-28 (direct report: finished shelters, never a bed): findShelterSite() sites shelters
  // up to 48 out, but detection stopped at 24 -- Babs' three real shelters (~50 blocks out, e.g.
  // the one whose door is at (41,70,-27)) were invisible, 328 "already standing" steps in a loop.
  const base4 = new V3(41, 65, -30); // the live shelter's offset from home: past 24, inside the 48 square
  const full4 = s.shelterPositions(base4), doorPos4 = s.doorwayPosition(base4);
  assert.equal(check(shelterBot(full4, { doorAt: doorPos4 })), true,
    'a complete shelter 41/30 blocks out -- where findShelterSite really put one -- is recognised');
  assert.equal(ownShelterCheck(shelterBot(full4, { doorAt: doorPos4, bedAt: base4.offset(0, 0, 1) })), true,
    'and a bed inside it satisfies the Tier 1 shelter item');
  const base5 = new V3(60, 65, 0);
  assert.equal(check(shelterBot(s.shelterPositions(base5), { doorAt: s.doorwayPosition(base5) })), false,
    'one beyond the 48 site radius still is not "near home"');
  // Two complete shelters, the farther one bedded: the bedded one is hers, the empty nearer one
  // must not hide it (findShelterNearHome returns it for the bed phase to skip straight to done).
  const twoShelters = shelterBot([...full3, ...full4], { doorAt: [doorPos3, doorPos4], bedAt: base4.offset(0, 0, 1) });
  assert.equal(ownShelterCheck(twoShelters), true, 'a bed in any complete shelter near home counts');
  assert.deepEqual(findCheck(twoShelters).base, base4, 'the bedded shelter wins over a nearer empty one');

  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1 -- "today's separate 'beds' and 'shelter'
  // items merge into one"): hasOwnShelterWithBed above only ever answers "does SHE have one";
  // the fleet-wide checklist needs an actual count of how many qualifying structures exist near
  // home, not a single nearest-match boolean.
  const multiShelterBot = (spawnPoint, shelters) => {
    const solid = new Set(), doors = new Set(), beds = new Set();
    const k = (p) => `${p.x},${p.y},${p.z}`;
    for (const sh of shelters) {
      for (const p of sh.cells) solid.add(k(p));
      if (sh.doorAt) doors.add(k(sh.doorAt));
      if (sh.bedAt) beds.add(k(sh.bedAt));
    }
    const blockAt = (p) => (beds.has(k(p)) ? { name: 'white_bed', boundingBox: 'block' }
      : doors.has(k(p)) ? { name: 'oak_door', boundingBox: 'empty', getProperties: () => ({ half: 'lower' }) }
      : { name: 'x', boundingBox: p.y <= 64 || solid.has(k(p)) ? 'block' : 'empty' });
    return { spawnPoint, isABed: (b) => b.name === 'white_bed', blockAt,
      findBlocks: doorFinder(shelters.map((sh) => sh.doorAt).filter(Boolean), blockAt) };
  };
  const count = (bot) => {
    const h = vm.createContext({ bot, Math, shelterPositions: s.shelterPositions, doorwayPosition: s.doorwayPosition,
      SHELTER_ROOM: vm.runInContext('SHELTER_ROOM', s), BUILDER_PRIORITY_RADIUS: 24 });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
      between(index, 'const shelterGeometryPositions', 'const BUILDER_ITEM_STALL_LIMIT'), h);
    return h.countQualifyingSheltersNearHome();
  };
  const multiSpawn = new V3(0, 64, 0);
  // y=65, not 64 -- same reason `base` above is: the mock's own "y<=64 is always solid ground"
  // rule would otherwise read every room floor cell as solid, not just the real floor beneath it.
  const baseA = new V3(0, 65, 0), baseB = new V3(10, 65, 0); // far enough apart not to overlap
  const shelterA = { cells: s.shelterPositions(baseA), doorAt: s.doorwayPosition(baseA), bedAt: baseA.offset(0, 0, 1) };
  const shelterB = { cells: s.shelterPositions(baseB), doorAt: s.doorwayPosition(baseB), bedAt: baseB.offset(0, 0, 1) };
  assert.equal(count(multiShelterBot(multiSpawn, [shelterA])), 1, 'one complete, sealed, bedded shelter');
  assert.equal(count(multiShelterBot(multiSpawn, [shelterA, shelterB])), 2, 'two separate ones both count -- not just the nearest');
  const shelterBNoBed = { ...shelterB, bedAt: null };
  assert.equal(count(multiShelterBot(multiSpawn, [shelterA, shelterBNoBed])), 1, 'complete and sealed, but no bed inside -- does not count');
});

await check('Shelter goal: a finished shelter gets a bed put in it; a build nobody can see is a failure', async () => {
  // 2026-10-28 (direct report: "they completed a few shelter buildings, but don't seem to realize
  // they can place a bed"): done used to mean "a complete structure", so an empty shelter finished
  // the goal and Tier 1 re-proposed it forever; and a build reported standing but not detected
  // returned ok:true, 328 times, never tripping the failure limit.
  const calls = [];
  const c = vm.createContext({ Vec3: V3, USERNAME: 'Babs', SHELTER_SITE_RADIUS: 48, console,
    bot: { spawnPoint: new V3(0, 64, 0), inventory: { items: () => c.held }, blockAt: () => null },
    held: [], found: null, bedded: false, buildResult: null,
    // The door check (2026-10-28) is its own test below -- here the doorway already has one.
    isDoorway: () => true, doorwayPosition: (b) => b.offset(0, 0, 3), unfinishedShelterNearHome: () => null,
    findShelterNearHome: () => c.found, shelterHasBed: () => c.bedded,
    bedStep: async () => ({ ok: true, text: 'got wool.', action: { type: 'get_wool' } }),
    findShelterSite: () => new V3(41, 65, -30), shelterPositions: () => [], shelterMaterialCount: () => 0,
    performAction: async (_bot, action) => {
      calls.push(action);
      if (action.type === 'place_bed') { c.bedded = true; return { ok: true, text: 'placed a bed.', bedAt: new V3(41, 65, -29) }; }
      return c.buildResult;
    } });
  vm.runInContext(between(index, 'async function shelterStep(', 'async function runShelterGoal('), c);

  c.found = { base: new V3(41, 65, -30), complete: true };
  let step = await c.shelterStep({}, null);
  assert.equal(step.done, undefined, 'a complete shelter with no bed is not done');
  assert.equal(step.action.type, 'get_wool', 'no bed held -- bedStep goes and gets one');
  c.held = [{ name: 'white_bed', count: 1 }];
  step = await c.shelterStep({}, null);
  assert.equal(calls.at(-1).type, 'place_bed');
  assert.equal(calls.at(-1).near, c.found.base, 'a held bed goes into that shelter');
  assert.equal(step.done, true, 'and that finishes the goal');
  assert.equal((await c.shelterStep({}, null)).done, true, 'a bedded shelter is done straight away');

  c.found = null; c.bedded = false; c.held = [];
  c.buildResult = { ok: true, built: true, text: 'the shelter is already standing.' };
  step = await c.shelterStep({ shelterAt: { x: 41, y: 65, z: -30 } }, null);
  assert.equal(step.ok, false, 'built but undetectable is a failure, so the goal can give up');
  assert.equal(step.built, false, 'and no "Built a shelter" note for something nobody can find');
});

await check('Shelters: a doorless shell near home is found again, not abandoned for a new site', async () => {
  // 2026-10-28 (direct report: "there are no doors or beds, but she built two"): a shell with no
  // door is invisible to the door-anchored complete-shelter search, so each new shelter goal
  // built another one.
  const s = shelterFns();
  const shellBot = (cells, solidExtra = []) => {
    const solid = new Set([...cells, ...solidExtra].map((p) => `${p.x},${p.y},${p.z}`));
    return { spawnPoint: new V3(0, 64, 0), isABed: () => false, findBlocks: () => [],
      blockAt: (p) => ({ name: 'x', boundingBox: p.y <= 64 || solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' }) };
  };
  const find = (bot) => {
    const h = vm.createContext({ bot, Math, shelterPositions: s.shelterPositions, doorwayPosition: s.doorwayPosition,
      SHELTER_ROOM: vm.runInContext('SHELTER_ROOM', s), BUILDER_PRIORITY_RADIUS: 24 });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') +
      between(index, 'const shelterGeometryPositions', 'const BUILDER_ITEM_STALL_LIMIT'), h);
    return h.unfinishedShelterNearHome();
  };
  const far = new V3(41, 65, -30), near = new V3(10, 65, 0);
  const farShell = s.shelterPositions(far), nearShell = s.shelterPositions(near);
  assert.equal(find(shellBot([])), null, 'open ground is not a shell');
  assert.equal(JSON.stringify(find(shellBot(farShell))), JSON.stringify(far), 'a doorless shell 41/30 blocks out is found');
  assert.equal(JSON.stringify(find(shellBot([...farShell, ...nearShell]))), JSON.stringify(near), 'the nearest of two shells wins');
  assert.equal(JSON.stringify(find(shellBot(farShell.slice(5)))), JSON.stringify(far), 'a few blocks short still counts -- the build fills them');
  assert.equal(find(shellBot(farShell.slice(20))), null, 'a third of it missing is not a shell');
  const door = s.doorwayPosition(far);
  assert.equal(find(shellBot(farShell, [door, door.offset(0, 1, 0)])), null, 'a solid block where the door goes is a closed box, not her shell');
});

await check('Shelter goal: a door is secured before the walls, and an unfinished shell is reused', async () => {
  // 2026-10-28: "build" crafted its door first but swallowed the failure -- with no planks Babs
  // put up all 60 wall blocks, then "no door yet" in ~5ms a tick until the goal gave up 40s later.
  const calls = [];
  const c = vm.createContext({ Vec3: V3, USERNAME: 'Babs', SHELTER_SITE_RADIUS: 48, console,
    bot: { spawnPoint: new V3(0, 64, 0), inventory: { items: () => c.held }, blockAt: () => null,
      registry: { blocksByName: { crafting_table: { id: 1 } } }, findBlocks: () => (c.tableNear ? [new V3(0, 64, 0)] : []) },
    held: [], tableNear: false, shell: null, siteCalls: 0, materials: 0,
    isDoorway: () => false, doorwayPosition: (b) => b.offset(0, 0, 3), heldCount: (fn) => c.held.filter((i) => fn(i.name)).reduce((n, i) => n + i.count, 0),
    findShelterNearHome: () => null, unfinishedShelterNearHome: () => c.shell,
    findShelterSite: () => { c.siteCalls++; return new V3(5, 65, 5); },
    shelterPositions: () => Array.from({ length: 60 }, (_, i) => new V3(i, 100, 0)), shelterMaterialCount: () => c.materials,
    gatherPlanks: async (_handle, count) => {
      calls.push({ type: 'gatherPlanks', count });
      return c.held.filter((i) => i.name.endsWith('_planks')).reduce((n, i) => n + i.count, 0) >= count ? null
        : { ok: true, text: 'gathered wood.', action: { type: 'mine', block: 'oak_log' } };
    },
    performAction: async (_bot, action) => { calls.push(action); return { ok: true, text: action.type }; } });
  vm.runInContext(between(index, 'async function shelterStep(', 'async function runShelterGoal('), c);

  let goal = {};
  let step = await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).type, 'gatherPlanks', 'no door and no planks: wood first');
  assert.equal(calls.at(-1).count, 10, '6 planks for the door, 4 for a table since none is around');
  assert.ok(!calls.some((a) => a.type === 'build'), 'and no walls go up yet');
  c.tableNear = true; calls.length = 0;
  await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).count, 6, 'a table nearby: just the door\'s 6');

  // 60 wall blocks needed, 60 materials held, 6 of them the door's planks: still 6 short.
  c.held = [{ name: 'oak_planks', count: 6 }]; c.materials = 60; calls.length = 0;
  await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).type, 'mine', 'the door\'s planks are not counted as wall blocks');
  assert.equal(calls.at(-1).count, 6);
  c.materials = 66; calls.length = 0;
  await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).type, 'build', 'door planks plus a full set of walls: build');

  c.shell = new V3(41, 65, -30); c.siteCalls = 0;
  goal = {};
  await c.shelterStep(goal, null);
  assert.equal(JSON.stringify(goal.shelterAt), JSON.stringify({ x: 41, y: 65, z: -30 }), 'a new shelter goal picks up her unfinished shell');
  assert.equal(c.siteCalls, 0, 'instead of siting a fresh one');

  // 2026-10-29: wall planks from logs asked for every missing block's worth ("craft 60
  // dark_oak_planks" with 2 logs) and failed the craft every tick.
  c.held = [{ name: 'oak_door', count: 1 }, { name: 'dark_oak_log', count: 2 }]; c.materials = 2; calls.length = 0;
  await c.shelterStep(goal, null);
  assert.equal(calls.at(-1).type, 'craft');
  assert.equal(calls.at(-1).count, 8, 'as many planks as two logs make, not all 58 missing');
});

await check('Craft: a count is items wanted, not recipe runs', async () => {
  // 2026-10-29: craftItem passed its count straight to bot.craft(), which runs the recipe that
  // many times -- "craft 30 planks" needed 30 logs, and failed with 8.
  const runs = [];
  const c = vm.createContext({
    bot: { registry: { itemsByName: { oak_planks: { id: 1 }, white_bed: { id: 2 }, torch: { id: 3 } } },
      recipesFor: (id) => [{ result: { count: id === 1 ? 4 : id === 3 ? 4 : 1 } }],
      craft: async (_recipe, count) => { runs.push(count); } },
    recipeInputs: () => null, simpleSourceFor: () => null });
  vm.runInContext(between(actions, 'async function craftItem(', 'function chestObstructed('), c);
  await c.craftItem(c.bot, 'oak_planks', 3, null);
  await c.craftItem(c.bot, 'oak_planks', 30, null);
  await c.craftItem(c.bot, 'white_bed', 1, null);
  await c.craftItem(c.bot, 'torch', 16, null);
  assert.equal(JSON.stringify(runs), JSON.stringify([1, 8, 1, 4]), '3 planks is one log, 30 is eight, one bed is one, 16 torches is four');
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

await check('Tool upgrades: stone once she can mine it, iron once she can smelt, all five tools', async () => {
  // Direct request, 2026-10-28: tools evolve wood -> stone (any pickaxe) -> iron (stone pickaxe +
  // a usable furnace near home), pickaxe/axe/sword/shovel/hoe.
  let inv = [], furnace = 0;
  const c = vm.createContext({ bot: { inventory: { items: () => inv } }, countUsableNearHome: () => furnace });
  vm.runInContext(between(index, 'const TOOL_NAME', 'function isIronOrBetterTool(') +
    between(index, 'const UPGRADE_TOOLS', 'function ownBeddedShelter('), c);
  const has = (...names) => { inv = names.map((name) => ({ name, count: 1 })); };
  has();
  assert.equal(c.nextToolUpgrade(), null, 'no pickaxe at all: the plain wooden-pickaxe goal comes first');
  has('wooden_pickaxe', 'wooden_sword');
  assert.equal(c.nextToolUpgrade(), 'stone_pickaxe', 'a pickaxe means stone is minable: pickaxe first');
  has('stone_pickaxe', 'wooden_sword');
  assert.equal(c.nextToolUpgrade(), 'stone_axe', 'then the rest, missing tools included');
  has('stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'golden_hoe');
  assert.equal(c.nextToolUpgrade(), 'stone_hoe', 'a golden tool ranks with wood');
  has('stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'stone_hoe');
  assert.equal(c.nextToolUpgrade(), null, 'all stone and no furnace: nothing to do');
  furnace = 1;
  assert.equal(c.nextToolUpgrade(), 'iron_pickaxe', 'a usable furnace near home unlocks iron');
  has('wooden_pickaxe', 'stone_sword');
  assert.equal(c.nextToolUpgrade(), 'stone_pickaxe', 'iron ore needs a stone pickaxe first, furnace or not');
});

await check('Tool upgrades: the step gets the material, smelts raw iron before mining more, then crafts', async () => {
  let inv = [];
  const actions_ = [];
  const c = vm.createContext({ USERNAME: 'Babs', bot: { inventory: { items: () => inv }, registry: { blocksByName: { crafting_table: { id: 9 } } },
      findBlocks: () => [{ x: 0, y: 64, z: 0 }] },
    nextToolUpgrade: () => c.target, target: 'stone_pickaxe',
    heldCount: (test) => inv.filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    gatherPlanks: async () => null,
    performAction: async (_b, action) => { actions_.push(`${action.type}:${action.block ?? action.item}`); return { ok: true, text: 'ok' }; } });
  vm.runInContext(between(index, 'const TOOL_HEADS', 'async function runUpgradeToolsGoal('), c);
  inv = [{ name: 'cobblestone', count: 1 }];
  await c.upgradeToolsStep({}, null);
  assert.equal(actions_.at(-1), 'mine:stone', 'short of 3 cobblestone: mines stone');
  inv = [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 4 }];
  await c.upgradeToolsStep({}, null);
  assert.equal(actions_.at(-1), 'craft:stone_pickaxe');
  c.target = 'iron_sword';
  inv = [{ name: 'raw_iron', count: 5 }];
  await c.upgradeToolsStep({}, null);
  assert.equal(actions_.at(-1), 'smelt:iron_ingot', 'raw iron she holds is smelted first');
  inv = [];
  await c.upgradeToolsStep({}, null);
  assert.equal(actions_.at(-1), 'mine:iron_ore', 'nothing to smelt: mine ore');
  c.target = null;
  assert.equal((await c.upgradeToolsStep({}, null)).done, true);
  assert.match(between(index, 'goal.standing === "guard"', 'goal.farmTask === "farm"'),
    /survivalPriorityItem === "tools"[\s\S]*goal\.farmTask \?\?= farmTaskFor/,
    'routed before farmTaskFor -- "craft a stone pickaxe" would otherwise match TOOL_WORDS');
});

await check('Shelter upgrade: dirt and wood cells are dug out and refilled with stone, one at a time', async () => {
  // Direct request, 2026-10-28: "gradually replace the earth shelter with stone".
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const world = new Map([[key(new V3(0, 65, 0)), 'dirt'], [key(new V3(1, 65, 0)), 'cobblestone'], [key(new V3(2, 65, 0)), 'oak_planks'],
    [key(new V3(0, 64, 0)), 'dirt'], [key(new V3(2, 64, 0)), 'dirt']]);
  const inv = [{ name: 'cobblestone', count: 5 }];
  const log = [];
  const bot = makeBot();
  Object.assign(bot, {
    entity: { position: new V3(5, 64, 5) },
    inventory: { items: () => inv.filter((i) => i.count > 0), slots: [] },
    blockAt: (p) => { const name = world.get(key(p)) ?? 'air'; return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }; },
    dig: async (b) => { log.push(`dig ${b.name} ${key(b.position)}`); world.delete(key(b.position)); },
    equip: async () => {},
    placeBlock: async (ref, face) => { const p = ref.position.offset(face.x, face.y, face.z); log.push(`place ${key(p)}`); world.set(key(p), 'cobblestone'); inv[0].count--; },
  });
  bot.pathfinder.goto = async () => {};
  bot.pathfinder.setMovements = function (m) { this.movements = m; };
  const c = context(bot, { Vec3: V3, refreshGear: async () => {} });
  vm.runInContext(timeoutFn + actionFn + between(actions, 'const SHELTER_MATERIAL', 'export function communalShelterMaterialCount('), c);
  const result = await c.performAction(bot, { type: 'reface_shelter', cells: [new V3(0, 65, 0), new V3(1, 65, 0), new V3(2, 65, 0)] }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.equal(result.refaced, 2);
  assert.deepEqual(log, ['dig dirt 0,65,0', 'place 0,65,0', 'dig oak_planks 2,65,0', 'place 2,65,0'],
    'each dug cell is refilled before the next is touched; stone is left alone');
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
  const c = vm.createContext({ setInterval() {}, Date, USERNAME: 'Amy', console, MAX_CONSECUTIVE_FAILURES: 3,
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
  const foodGoal = { consecutiveFailures: 0, description: 'food', survivalPriorityItem: 'food' };
  await c.failGoalStep(foodGoal, 'bad plan');
  await c.failGoalStep(foodGoal, 'bad plan');
  assert.equal(retired, false);
  await c.failGoalStep(foodGoal, 'bad plan'); // the 3rd
  assert.equal(retired, true,
    'food/armor are Tier 1 tagged but have no dedicated runner yet -- still the freeform 3-failure limit');
});

await check('Shelters: a shelter goal gets materials (planks from her logs), builds on its site, then puts her bed in it', async () => {
  // 2026-10-28: done is "a bed in the finished shelter" now, not just "it stands" -- see the
  // "Shelter goal: a finished shelter gets a bed" check above.
  // A door already held: the door-planks check (2026-10-28) has its own test above.
  const inv = [{ name: 'oak_log', count: 3 }, { name: 'white_bed', count: 1 }, { name: 'oak_door', count: 1 }];
  let standing = false, bedded = false; const calls = []; const done = [];
  const performAction = async (b, action) => {
    calls.push(action.type + (action.item ? `:${action.item}` : '') + (action.block ? `:${action.block}` : ''));
    // 70, not 60: the shelter's own room grew from 2x2 to 2x3 (2026-10-11), needing more material
    // than one craft call used to provide -- a second call here would mean a second 'craft' entry
    // in `calls` below, which this test treats as a regression (one craft, then build, not two).
    if (action.type === 'craft') { inv.push({ name: 'oak_planks', count: 70 }); return { ok: true, text: 'crafted planks' }; }
    if (action.type === 'build') { standing = true; return { ok: true, text: 'built a small shelter', built: true }; }
    if (action.type === 'place_bed') { bedded = true; return { ok: true, text: 'placed a bed', bedAt: new V3(1, 64, 2) }; }
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
    findShelterNearHome: () => (standing ? { base: new V3(1, 64, 1), complete: true } : null), shelterHasBed: () => bedded,
    findShelterSite: () => new V3(1, 64, 1), shelterPositions: s.shelterPositions,
    unfinishedShelterNearHome: () => null, isDoorway: () => false, doorwayPosition: s.doorwayPosition,
    shelterMaterialCount: (b) => b.inventory.items().filter((i) => /_(planks|log)$/.test(i.name)).reduce((n, i) => n + i.count, 0),
    // 2026-10-27: runShelterGoal now registers a RAG note on completion (writeMemoryNote,
    // longterm.js) -- stubbed here same as every other cross-module function this context
    // already injects.
    writeMemoryNote: async () => {}, PERSONA_NAME: 'amy', SHELTER_SITE_RADIUS: 48 });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { description: 'go home and build a small shelter there', createdAt: Date.now(), consecutiveFailures: 0 };
  for (let i = 0; i < 4 && !done.length; i++) await c.runShelterGoal(goal, async () => true, () => ({ release() {} }), () => false);
  assert.deepEqual(calls, ['craft:oak_planks', 'build', 'place_bed']);
  assert.deepEqual(done, ['done']);
  assert.deepEqual({ ...goal.shelterAt }, { x: 1, y: 64, z: 1 });
});

await check('Beds: a spot with a bot standing in it is skipped, and a refused spot is not retried', async () => {
  const c = bedFns();
  vm.runInContext(between(actions, 'function cellOccupied(', 'export function findBedSite('), c);
  const world = bedSiteWorld();
  const free = c.findBedSites({ ...world, entity: {}, entities: {} }, new V3(0, 64, 0));
  const best = free[0];
  const crowded = { ...world, entity: {}, entities: { 7: { position: new V3(best.head.x + 0.5, 64, best.head.z + 0.5) } } };
  const next = c.findBedSites(crowded, new V3(0, 64, 0))[0];
  assert(!(next.foot.equals(best.foot) && next.head.equals(best.head)), 'the occupied spot is not offered');
  for (const cell of [next.foot, next.head]) assert(!(cell.x === best.head.x && cell.z === best.head.z), 'nothing standing in it');
  const place = actions.slice(actions.indexOf('case "place_bed": {'), actions.indexOf('case "shear": {'));
  // The predicate gained an access clause in 1.81.0, so this only pins the "not tried yet" half;
  // the access half has its own check further down.
  assert.match(place, /\.find\(\(c\) => !tried\.some\(\(t\) => t\.equals\(c\.foot\)\)/, 'each attempt takes a spot not tried yet');
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a): an optional action.near (the communal
  // shelter's own runner passes its site), same shape as "store"'s own -- unset, she still goes
  // "home" exactly as before.
  assert.match(place, /action\.near \? new Vec3\(action\.near\.x, action\.near\.y, action\.near\.z\) : null/);
  assert.match(place, /findBedSites\(bot, target \?\? bot\.spawnPoint \?\? bot\.entity\.position\)/,
    'the target, when given, is what findBedSites actually searches around');
});

await check('Beds: the first choice is a spot under a roof -- the shelter room, entered from its doorway', async () => {
  const c = bedFns();
  vm.runInContext(between(actions, 'function cellOccupied(', 'export function findBedSite('), c);
  const s = shelterFns();
  const base = new V3(5, 64, 5);
  const walls = new Set(s.shelterPositions(base).map((p) => `${p.x},${p.y},${p.z}`));
  const bot = { entity: {}, entities: {}, isABed: () => false, findBlocks: () => [],
    blockAt: (p) => (p.y < 64 || walls.has(`${p.x},${p.y},${p.z}`) ? { name: 'cobblestone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) };
  const site = c.findBedSites(bot, new V3(0, 64, 0))[0];
  // 2026-10-11: the room grew from 2x2 to 2x3 rows (local z 0-1 -> 0-2), so the middle row (local
  // z=1) now has two equally-scored orientations -- head toward the open doorway gap or away from
  // it -- and BED_DIRS tries (0,1) before (0,-1), so the former wins the tie.
  assert.deepEqual([site.foot.x, site.foot.z, site.head.x, site.head.z, site.stand.x, site.stand.z], [5, 6, 5, 7, 5, 5],
    'foot (0,1) and head (0,2) of the room, standing at (0,0) to place it');
  const atSpawn = c.findBedSites(bot, base)[0]; // spawn inside the shelter, as at the fleet's home
  assert.deepEqual([atSpawn.foot.x, atSpawn.foot.z], [5, 6], 'the room is still used when it sits on spawn');
});

await check('Beds: always placed inside an existing shelter when one has room, else falls back as before', async () => {
  // Direct request, 2026-10-18: "beds will always be placed within a shelter if space is
  // available in an existing shelter." bedFns() wires the real shelterInteriorsNear in (from
  // shelter()); overridden here (same pattern tryTakeFromNearbyChest already uses elsewhere in
  // this file) to isolate findBedSites' OWN consumption of it from shelter.js's own flood-fill
  // correctness, which gets its own dedicated tests next to shelterLivingSpace() below.
  const c = bedFns();
  const world = bedSiteWorld();
  const home = new V3(0, 64, 0);
  const open = c.findBedSites(world, home)[0];
  assert(open, 'an open-ground site exists with no shelter nearby');

  // (8,64,8)/(8,64,9): a real candidate findBedSites' own loop generates in this flat, open
  // world, but scored far worse than the open pick above -- only the shelter preference, not the
  // ordinary nearest/under-a-roof scoring, can explain it winning below.
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const shelterFoot = new V3(8, 64, 8), shelterHead = new V3(8, 64, 9);
  c.shelterInteriorsNear = () => new Set([key(shelterFoot), key(shelterHead)]);
  const preferred = c.findBedSites(world, home)[0];
  assert.deepEqual([preferred.foot.x, preferred.foot.z, preferred.head.x, preferred.head.z],
    [shelterFoot.x, shelterFoot.z, shelterHead.x, shelterHead.z],
    'the shelter-interior site wins even though it scores worse than the open one');

  c.shelterInteriorsNear = () => new Set(); // nothing qualifies -- the common case before any shelter exists
  const fallback = c.findBedSites(world, home)[0];
  assert.deepEqual([fallback.foot.x, fallback.foot.z], [open.foot.x, open.foot.z],
    "with no qualifying shelter nearby, falls back to today's ordinary scoring unchanged");
});

// ---- 2026-10-07: access to chests/beds/doors, shelter walls, tunnelling torches --------------

// A flat world: solid stone at y <= groundY, air above, plus blocks placed by name. Beds, doors
// and chests are solid here because they are solid in the real registry -- the access rules and
// the covered flood fill both depend on that.
// Block ids and a minimal registry, so a scan by id (bedAnchors, litNearby) works the way the
// real one does. emitLight is the registry field tunneling.js derives its light sources from.
const BLOCK_DEFS = [
  ['air', 0], ['stone', 0], ['deepslate', 0], ['cobblestone', 0], ['grass_block', 0],
  ['chest', 0], ['barrel', 0], ['furnace', 0], ['white_bed', 0], ['oak_door', 0],
  ['spruce_door', 0], ['oak_fence_gate', 0], ['sand', 0], ['gravel', 0],
  ['torch', 14], ['lantern', 15], ['glowstone', 15], ['lava', 15], ['candle', 0],
];
const BLOCK_ID = Object.fromEntries(BLOCK_DEFS.map(([name], i) => [name, i + 1]));
const TEST_REGISTRY = {
  blocksArray: BLOCK_DEFS.map(([name, emitLight], i) => ({ name, id: i + 1, emitLight })),
  blocksByName: Object.fromEntries(BLOCK_DEFS.map(([name, emitLight], i) => [name, { name, id: i + 1, emitLight }])),
};

function blockWorld({ groundY = 63, light = 0 } = {}) {
  const at = new Map();
  const bot = {
    registry: TEST_REGISTRY,
    blockAt(p) {
      if (!p) return null;
      const spec = at.get(`${p.x},${p.y},${p.z}`);
      const position = new V3(p.x, p.y, p.z);
      if (spec) {
        return { name: spec.name, position, light: spec.light ?? light, type: BLOCK_ID[spec.name] ?? 0,
          boundingBox: spec.name === 'air' ? 'empty' : 'block', getProperties: () => spec.props || {} };
      }
      const stone = p.y <= groundY;
      const name = stone ? 'stone' : 'air';
      return { name, position, light: stone ? 0 : light, type: BLOCK_ID[name],
        boundingBox: stone ? 'block' : 'empty', getProperties: () => ({}) };
    },
    findBlocks({ matching, point, maxDistance = 32, count = 16 }) {
      const origin = point || bot.entity.position;
      const ids = typeof matching === 'function' ? null : new Set([].concat(matching));
      const out = [];
      for (const k of at.keys()) {
        const [bx, by, bz] = k.split(',').map(Number);
        const pos = new V3(bx, by, bz);
        if (pos.distanceTo(origin) > maxDistance) continue;
        const block = bot.blockAt(pos);
        const hit = ids ? ids.has(block.type) : matching(block);
        if (hit) out.push(pos);
        if (out.length >= count) break;
      }
      return out;
    },
    isABed: (b) => !!b?.name?.endsWith('_bed'),
    username: 'Babs',
    entity: { position: new V3(0, 64, 0) },
    entities: {},
    inventory: { items: () => [] },
    // The same four primitives arbiter.cancelPhysical() touches on every performAction (see
    // makeBot above) -- a scenario that drives a real action overrides whichever it cares about.
    pathfinder: { goal: null, setGoal(g) { this.goal = g; }, movements: { canDig: true } },
    pvp: { target: null, stop() { this.target = null; } },
    collectBlock: { cancelTask() {} },
    stopDigging() {},
  };
  const place = ([bx, by, bz], name, props) => at.set(`${bx},${by},${bz}`, { name, props });
  const open = ([bx, by, bz]) => at.set(`${bx},${by},${bz}`, { name: 'air' });
  // A bed facing south: the head block carries part:"head", the foot sits one block north of it.
  const bed = ([bx, by, bz]) => {
    place([bx, by, bz], 'white_bed', { facing: 'south', part: 'head' });
    place([bx, by, bz - 1], 'white_bed', { facing: 'south', part: 'foot' });
  };
  // A door: the way through it runs along `facing` -- north/south along z, east/west along x.
  const door = ([bx, by, bz], name = 'oak_door', facing = 'north') => {
    place([bx, by, bz], name, { facing, half: 'lower', open: false });
    place([bx, by + 1, bz], name, { facing, half: 'upper', open: false });
  };
  return { bot, place, open, bed, door, at };
}

await check('Access: a block over a chest lid, in a doorway, or on the last way up to a bed is refused', async () => {
  const c = shelter();
  const w = blockWorld();
  w.place([0, 64, 0], 'chest');
  w.place([3, 64, 0], 'barrel');
  const lid = c.wouldBlockAccess(w.bot, new V3(0, 65, 0));
  assert(lid && lid.fixture === 'chest' && /lid/.test(lid.reason), `the chest lid is refused: ${JSON.stringify(lid)}`);
  assert.equal(c.wouldBlockAccess(w.bot, new V3(3, 65, 0)), null, 'a barrel opens with a block above it');

  w.door([0, 64, 6]);
  const through = c.wouldBlockAccess(w.bot, new V3(0, 64, 5));
  assert(through && /way through/.test(through.reason), `in front of the door: ${JSON.stringify(through)}`);
  assert(c.wouldBlockAccess(w.bot, new V3(0, 65, 7)), 'the far side at head height counts too');
  assert.equal(c.wouldBlockAccess(w.bot, new V3(1, 64, 6)), null, "the door's own jamb is supposed to be solid");

  w.bed([10, 64, 0]);
  const around = [[11, 64, 0], [9, 64, 0], [10, 64, 1], [11, 64, -1], [9, 64, -1], [10, 64, -2]];
  assert.equal(c.wouldBlockAccess(w.bot, new V3(11, 64, 0)), null, 'plenty of room round the bed still');
  for (const cell of around.slice(0, 5)) w.place(cell, 'cobblestone');
  const last = c.wouldBlockAccess(w.bot, new V3(10, 64, -2));
  assert(last && /_bed$/.test(last.fixture) && /last way/.test(last.reason), `the last way up: ${JSON.stringify(last)}`);
});

await check('Access: a falling block is judged where it lands, not where it leaves her hand', async () => {
  const c = shelter();
  const w = blockWorld();
  w.place([20, 64, 0], 'chest');
  assert.equal(c.wouldBlockAccess(w.bot, new V3(20, 68, 0), 'cobblestone'), null, 'cobblestone stays where it is put');
  const fell = c.wouldBlockAccess(w.bot, new V3(20, 68, 0), 'sand');
  assert(fell && fell.fixture === 'chest', `sand four blocks up lands on the lid: ${JSON.stringify(fell)}`);
  assert.deepEqual([fell.falls.x, fell.falls.y, fell.falls.z], [20, 65, 0], 'and it says where');
  assert.equal(c.isFallingBlockName('red_concrete_powder'), true);
  assert.equal(c.isFallingBlockName('cobblestone'), false);
});

await check('Access: the obstruction scan finds a blocked lid and both halves of a double chest', async () => {
  const c = shelter();
  const w = blockWorld();
  w.place([0, 64, 0], 'chest', { type: 'left', facing: 'north' });
  w.place([1, 64, 0], 'chest', { type: 'right', facing: 'north' });
  w.place([1, 65, 0], 'cobblestone'); // over the far half -- blocks the whole double chest in vanilla
  const found = c.findAccessObstructions(w.bot, new V3(0, 64, 0), 8, () => true);
  assert.equal(found.length, 1, `exactly the one block in the way: ${JSON.stringify(found)}`);
  assert.deepEqual([found[0].position.x, found[0].position.y, found[0].position.z], [1, 65, 0]);
  assert.equal(found[0].name, 'cobblestone');
  w.place([0, 65, 0], 'furnace'); // a fixture: never dug out to reach another fixture
  const policy = c.findAccessObstructions(w.bot, new V3(0, 64, 0), 8, (name) => name !== 'furnace');
  // Spread first: an array built inside the vm context has that context's Array prototype, which
  // deepStrictEqual rejects even when the contents match.
  assert.deepEqual([...policy].map((f) => f.name), ['cobblestone'], "the caller's own no-break policy is honoured");
});

await check('Access: a door sealed on both sides is left alone; one blocked side is cleared', async () => {
  const c = shelter();
  const w = blockWorld();
  w.door([0, 64, 6]);
  w.place([0, 64, 5], 'cobblestone');
  w.place([0, 65, 5], 'cobblestone');
  const oneSide = c.findAccessObstructions(w.bot, new V3(0, 64, 6), 4, () => true);
  assert.deepEqual([...oneSide].map((f) => f.position.z), [5, 5], 'both cells of the blocked side');
  w.place([0, 64, 7], 'cobblestone');
  w.place([0, 65, 7], 'cobblestone');
  assert.deepEqual([...c.findAccessObstructions(w.bot, new V3(0, 64, 6), 4, () => true)], [],
    'a door built into solid ground on both sides is not a passage anyone uses');
});

// The 4x5 shelter from actions.js, with a bed in its room -- the real geometry, not a mock of it.
function shelterLivingSpace() {
  const s = shelterFns();
  const c = shelter();
  const base = new V3(0, 64, 0);
  const w = blockWorld();
  for (const pos of s.shelterPositions(base)) w.place([pos.x, pos.y, pos.z], 'cobblestone');
  w.bed([base.x, base.y, base.z + 1]); // head at the room's (0,1), foot at (0,0)
  const space = c.refreshLivingSpace(w.bot, base);
  return { c, w, base, space };
}

await check('Shelter walls: the covered fill finds the room, stops at the doorway, and names every wall', async () => {
  const { c, w, base, space } = shelterLivingSpace();
  assert.equal(space.anchors.length, 1, 'one bed, not two halves');
  // 2026-10-11: the doorway's lintel (y 2) now rejoins the wall fill (doorwayPosition() only
  // takes the two door-height cells, y 0-1), so only those two, not all three, are still passable.
  // Also 2026-10-11: the room itself grew from 2x2 to 2x3 rows (a real door and a bed could never
  // both fit in 2x2 -- SHELTER_ROOM's own header comment has the full account), moving the doorway
  // from local z=2 to z=3.
  assert.equal(space.inside.size, 18, '2x3 room x3 high less the two bed blocks, plus the doorway\'s two door-height cells');
  assert.equal(c.isInsideLivingSpace(w.bot, base.offset(0, 0, 3)), true, 'the doorway is inside');
  assert.equal(c.isInsideLivingSpace(w.bot, base.offset(0, 0, 4)), false, 'the step outside it is not -- no roof there');

  assert.equal(c.isLivingSpaceWall(w.bot, base.offset(-1, 1, 0)), true, 'a wall block');
  assert.equal(c.isLivingSpaceWall(w.bot, base.offset(0, 3, 0)), true, 'the roof');
  assert.equal(c.isLivingSpaceWall(w.bot, base.offset(0, -1, 0)), true, 'the floor');
  assert.equal(c.isLivingSpaceWall(w.bot, base.offset(20, -1, 20)), false, 'ordinary terrain well clear of it');

  // The doorway: filling it seals the shelter even though no door hangs there yet.
  assert.deepEqual([...space.exits.keys()], ['0,3'], 'one way out: the doorway column');
  const sealed = c.wouldBlockAccess(w.bot, base.offset(0, 0, 3));
  assert(sealed && /way out/.test(sealed.reason), `the doorway is refused: ${JSON.stringify(sealed)}`);
  assert.equal(c.wouldBlockAccess(w.bot, base.offset(1, 0, 1)), null, 'a cell deep inside the room is not an exit');
});

await check('Shelter walls: a hole in a wall is a second way out, so it can be filled back in', async () => {
  const { c, w, base } = shelterLivingSpace();
  w.open([base.x - 1, base.y, base.z]); // knock a hole in the west wall at floor level
  const holed = c.refreshLivingSpace(w.bot, base);
  assert.deepEqual([...holed.exits.keys()].sort(), ['-1,0', '0,3'], 'the hole counts as a way out too');
  assert.equal(c.wouldBlockAccess(w.bot, base.offset(-1, 0, 0)), null, 'so repairing it is allowed');
  assert.equal(c.wouldBlockAccess(w.bot, base.offset(0, 0, 3)), null, 'and the doorway is no longer the only one');

  // Hang a door in the doorway (now local z=3, the room having grown to 2x3) and cap the cell
  // above it (the shelter's doorway column is three high, a door only two). The fill stops at the
  // door, but the door still counts as the way out -- otherwise the first hole knocked in a wall
  // would look like the only exit and be protected from repair, exactly backwards.
  const d = shelterLivingSpace();
  d.w.door([d.base.x, d.base.y, d.base.z + 3]);
  d.w.place([d.base.x, d.base.y + 2, d.base.z + 3], 'cobblestone');
  const shut = d.c.refreshLivingSpace(d.w.bot, d.base);
  assert.deepEqual([...shut.exits.keys()], ['0,2'], 'the cell inside the door is the way out');
  const onlyWay = d.c.wouldBlockAccess(d.w.bot, d.base.offset(0, 1, 2));
  assert(onlyWay && /_door$/.test(onlyWay.fixture), `walling the door off from inside: ${JSON.stringify(onlyWay)}`);
  d.w.open([d.base.x - 1, d.base.y, d.base.z]);
  d.c.refreshLivingSpace(d.w.bot, d.base);
  assert.equal(d.c.wouldBlockAccess(d.w.bot, d.base.offset(-1, 0, 0)), null, 'with a hole too, the hole can be repaired');
});

await check('Shelter walls: a bed under open sky protects nothing, and the cell cap bounds the fill', async () => {
  const c = shelter();
  const w = blockWorld();
  w.bed([0, 64, 0]);
  const space = c.refreshLivingSpace(w.bot, new V3(0, 64, 0));
  assert.equal(space.anchors.length, 1, 'the bed is still found');
  assert.equal(space.inside.size, 0, 'nothing overhead, so there is no interior');
  assert.equal(space.cells.size, 0, 'and no walls to protect -- this can never fence off bare terrain');

  // A roofed field: the fill stops at SHELL_MAX_CELLS instead of running away.
  const big = blockWorld();
  for (let bx = -12; bx <= 12; bx++) for (let bz = -12; bz <= 12; bz++) big.place([bx, 68, bz], 'cobblestone');
  big.bed([0, 64, 0]);
  const capped = c.refreshLivingSpace(big.bot, new V3(0, 64, 0));
  assert.equal(capped.inside.size, shelterConst('SHELL_MAX_CELLS'), 'capped, not unbounded');
});

await check('Shelter walls: pathfinder refuses to dig one, and still digs ordinary terrain', async () => {
  const { w, base } = shelterLivingSpace();
  const c = vm.createContext({ Movements: class { safeToBreak() { return true; } }, Move: class {},
    nbt: { simplify: () => ({}) }, Vec3: V3, isWater: () => false, applyDoorState: (b) => b,
    isLivingSpaceWall: shelter().isLivingSpaceWall });
  vm.runInContext(between(swim, 'const MAX_DIG_LABOR_COST'), c);
  const movements = new (vm.runInContext('SwimMovements', c))();
  movements.bot = w.bot;
  assert.equal(movements.safeToBreak(w.bot.blockAt(base.offset(-1, 1, 0))), false, 'a wall of the shelter');
  assert.equal(movements.safeToBreak(w.bot.blockAt(base.offset(0, 3, 0))), false, 'its roof');
  assert.equal(movements.safeToBreak(w.bot.blockAt(base.offset(20, -1, 20))), true, 'stone out in the open');
  assert.equal(movements.safeToBreak({ name: 'stone' }), true, "a block with no position (the library's own null stub)");
});

// Any enclosed structure, for bed placement (2026-10-18): "not a set size or shape... no openings
// other than doors," walls any material "including glass, but not sand." A 1x1x3 room, walls of
// `wallName` on all four sides, a roof and a floor, one real door -- built with blockWorld()'s own
// primitives, not shelterPositions(), to prove this works on a shape the Builder's own fixed room
// never uses.
function smallRoom({ wallName = 'cobblestone' } = {}) {
  const w = blockWorld();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      w.place([dx, 63, dz], wallName); // floor
      w.place([dx, 67, dz], wallName); // roof
      if (dx === 0 && dz === 0) continue; // the interior column (y 64-66) stays open air
      for (let dy = 64; dy <= 66; dy++) {
        if (dx === 0 && dz === 1 && dy <= 65) continue; // the doorway (two cells tall), filled below
        w.place([dx, dy, dz], wallName);
      }
    }
  }
  w.door([0, 64, 1], 'oak_door', 'south'); // faces south (+z): inside is -z, outside is +z
  return w;
}

await check('Shelter detection: a fully enclosed room with one real door is sealed; a missing wall is not', async () => {
  const c = shelter();
  const w = smallRoom();
  // doorPassageSides' two sides are [+facing, -facing]; south steps +z, so [1] (-z) is the inside.
  const inside = c.doorPassageSides(w.bot, w.bot.blockAt(new V3(0, 64, 1)))[1];
  const { inside: cells, sealed } = c.enclosedInterior(w.bot, inside);
  assert.equal(sealed, true, 'four walls, a roof and a floor, one real door -- nothing else open');
  assert(cells.has('0,64,0'), 'the room interior itself is in it');
  assert(!cells.has('0,64,2'), 'the far side of the door (outside) is a different flood, not merged in by this call');

  w.open([-1, 65, 0]); // knock a hole in the west wall, one block up
  const holed = c.enclosedInterior(w.bot, inside);
  assert.equal(holed.sealed, false, 'a real gap in the wall leaks out into the open world instead of terminating');
});

await check('Shelter detection: a sand wall disqualifies an otherwise-sealed room; glass does not', async () => {
  const c = shelter();
  assert.equal(c.isSandWallName('sand'), true);
  assert.equal(c.isSandWallName('red_sand'), true);
  assert.equal(c.isSandWallName('gravel'), false, "the user's ask was sand specifically, not gravel");
  assert.equal(c.isSandWallName('glass'), false, 'walls may be any material, including glass');

  const sandy = smallRoom({ wallName: 'sand' });
  const glassy = smallRoom({ wallName: 'glass' });
  const doorsNear = (w) => c.shelterInteriorsNear(w.bot, new V3(0, 64, 1), 8);
  assert.equal(doorsNear(sandy).size, 0, 'sealed, but a sand wall is not an acceptable shelter wall');
  assert(doorsNear(glassy).size > 0, 'glass is an acceptable wall');
});

await check('Shelter detection: shelterInteriorsNear finds a room from its door, and nothing from open terrain', async () => {
  const c = shelter();
  const w = smallRoom();
  const found = c.shelterInteriorsNear(w.bot, new V3(0, 64, 1), 8);
  assert(found.has('0,64,0'), 'the room is found starting from its own door');

  const field = blockWorld();
  assert.equal(c.shelterInteriorsNear(field.bot, new V3(0, 64, 0), 8).size, 0, 'no doors at all -- nothing qualifies');
});

// Direct request, 2026-10-22, generalizing S42's fix: "recognize any number of individual
// shelters; larger shelters as defined by contiguous walls roof and floor, broken only by
// doors." shelterRoomsNear()/holesIn() must work on damage shelterInteriorsNear()'s own strict
// test structurally cannot (a hole makes that fill leak without bound -- see the "Shelter
// detection" test two above, `holed.sealed === false`), on any number of separate rooms, and on
// a shape neither of this file's two hand-coded geometries (shelterPositions'/
// communalShelterPositions' fixed rectangles) ever builds.
function room(w, { baseX = 0, baseZ = 0, wallName = 'cobblestone', doorFacing = 'north' } = {}) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      w.place([baseX + dx, 63, baseZ + dz], wallName); // floor
      w.place([baseX + dx, 67, baseZ + dz], wallName); // roof
      if (dx === 0 && dz === 0) continue; // interior column stays open
      for (let dy = 64; dy <= 66; dy++) {
        if (dx === 0 && dz === 1 && dy <= 65) continue; // doorway, filled below
        w.place([baseX + dx, dy, baseZ + dz], wallName);
      }
    }
  }
  w.door([baseX, 64, baseZ + 1], 'oak_door', doorFacing);
  return new V3(baseX, 64, baseZ + 1);
}

await check('Shelter rooms (general): a sealed room is recognized with zero holes, even when it is too narrow for hole-finding itself', async () => {
  // smallRoom() is 1x1 interior -- exactly the shape holesIn()'s own header explains cannot be
  // told apart from a hole by neighbour count alone (every real floor-level cell there has 4 of
  // 6 neighbours solid, the same count a genuine breach would). Found live, offline, while
  // writing this test: the first version of holesIn() false-positived THIS room's own floor
  // cell as a hole. MIN_SHELTER_ROOM_SPAN now deliberately leaves a room this narrow to
  // findShelterNearHome() (index.js), which has a real reference geometry and needs no
  // heuristic -- so recognition still succeeds here, holes is just never attempted on it.
  const c = shelter();
  const w = smallRoom();
  const intact = c.shelterRoomsNear(w.bot, new V3(0, 64, 1), 8);
  assert.equal(intact.length, 1, 'exactly one room found');
  assert.equal(intact[0].holes.size, 0, 'too narrow for hole-finding to even attempt -- not a false claim of damage');
  assert(intact[0].inside.has('0,64,0'), 'the room interior is in it');

  // Confirmed deliberately bare: even with the same real gap the strict enclosedInterior test
  // above shows breaks "sealed" entirely, a room this narrow still reports zero holes -- the
  // point of the test above is exactly that this must never become a false positive.
  w.open([-1, 65, 0]);
  const damaged = c.shelterRoomsNear(w.bot, new V3(0, 64, 1), 8);
  assert.equal(damaged.length, 1, 'still recognized as one room -- real damage does not erase it');
  assert.equal(damaged[0].holes.size, 0, 'too narrow for this mechanism -- the individual-shelter repair path owns this one, not a false negative');
});

await check('Shelter rooms (general): any number of separate individual shelters, each kept apart', async () => {
  const c = shelter();
  const w = blockWorld();
  const doorA = room(w, { baseX: 0, baseZ: 0 });
  const doorB = room(w, { baseX: 20, baseZ: 0 }); // far enough apart not to overlap
  const doorC = room(w, { baseX: 40, baseZ: 0 });
  const rooms = c.shelterRoomsNear(w.bot, doorA, 48);
  assert.equal(rooms.length, 3, `three separate shelters, not merged into one or lost: found ${rooms.length}`);
  for (const d of [doorA, doorB, doorC]) {
    // door faces north (step [0,-1]); the room's own interior column sits one block further
    // north again (same x/y, z-1) -- not y-1, which is the solid floor underneath it.
    assert(rooms.some((r) => r.inside.has(`${d.x},${d.y},${d.z - 1}`)), `room at door ${JSON.stringify(d)} is one of them`);
  }
  assert.equal(new Set(rooms.flatMap((r) => [...r.inside])).size,
    [...rooms[0].inside, ...rooms[1].inside, ...rooms[2].inside].length, 'no cell is claimed by two rooms at once');
});

await check('Shelter rooms (general): a larger shelter, a shape neither fixed geometry builds, is recognized and its hole found', async () => {
  const c = shelter();
  const w = blockWorld();
  // A 5x5 interior (bigger than the Builder's own 1x1 smallRoom() and a different shape than
  // communalShelterPositions()' own formula-sized rectangle), walls/roof/floor built directly
  // from blockWorld() primitives -- proving this is shape detection, not a geometry match.
  const size = 5; // interior cells 0..4 on each axis
  for (let dx = -1; dx <= size; dx++) {
    for (let dz = -1; dz <= size; dz++) {
      const edge = dx === -1 || dx === size || dz === -1 || dz === size;
      w.place([dx, 63, dz], 'stone_bricks'); // floor under every cell, including the walls' own footing
      w.place([dx, 68, dz], 'stone_bricks'); // roof, one layer above the 4-tall interior (64..67)
      if (!edge) continue; // interior stays open
      for (let dy = 64; dy <= 67; dy++) {
        if (dx === -1 && dz === 0 && dy <= 65) continue; // doorway on the west wall, two cells tall
        w.place([dx, dy, dz], 'stone_bricks');
      }
    }
  }
  w.door([-1, 64, 0], 'oak_door', 'west');
  const found = c.shelterRoomsNear(w.bot, new V3(-1, 64, 0), 12);
  assert.equal(found.length, 1, 'one large room found');
  assert.equal(found[0].holes.size, 0, 'intact -- no holes yet');
  assert(found[0].inside.has('2,65,2'), 'the far interior corner is really reached, not just the cell by the door');

  w.open([2, 65, size]); // a real gap in the far (east) wall
  const damaged = c.shelterRoomsNear(w.bot, new V3(-1, 64, 0), 12);
  assert.equal(damaged.length, 1, 'still one room, now damaged');
  assert(damaged[0].holes.has(`2,65,${size}`), `the hole in the far wall of a 5x5 room is found: ${[...damaged[0].holes]}`);
});

await check('Access: "place" takes another side rather than blocking a door, and says so when every side would', async () => {
  const w = blockWorld();
  // Standing at (0,64,0). The first side "place" tries is +x, and a door at (1,64,1) facing north
  // makes (1,64,0) its own way through -- so the furnace has to go on the next side instead.
  w.door([1, 64, 1]);
  w.bot.inventory.items = () => [{ name: 'furnace' }];
  w.bot.equip = async () => {};
  const placed = [];
  w.bot.placeBlock = async (ref) => placed.push(`${ref.position.x},${ref.position.y},${ref.position.z}`);
  const c = context(w.bot, { Vec3: V3, attemptBoatCrossing: async () => false });
  vm.runInContext(timeoutFn + actionFn, c);
  const result = await c.performAction(w.bot, { type: 'place', item: 'furnace' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(placed, ['-1,63,0'], 'placed on the next side, not into the doorway at (1,64,0)');

  // Four doors facing her, two blocks out on each axis: every candidate cell is a way through.
  const boxed = blockWorld();
  boxed.door([0, 64, 2]);
  boxed.door([0, 64, -2]);
  boxed.door([2, 64, 0], 'spruce_door', 'east');
  boxed.door([-2, 64, 0], 'spruce_door', 'east');
  boxed.bot.inventory.items = () => [{ name: 'furnace' }];
  boxed.bot.equip = async () => {};
  boxed.bot.placeBlock = async () => { throw new Error('should never place'); };
  const c2 = context(boxed.bot, { Vec3: V3, attemptBoatCrossing: async () => false });
  vm.runInContext(timeoutFn + actionFn, c2);
  const refused = await c2.performAction(boxed.bot, { type: 'place', item: 'furnace' }, 'test');
  assert.equal(refused.ok, false);
  assert.match(refused.text, /wouldn't block the way through the \w+_door/, refused.text);
});

await check('Access: "clear_access" digs what is in the way and reports which fixture it freed', async () => {
  const w = blockWorld();
  w.place([0, 64, 0], 'chest');
  w.place([0, 65, 0], 'cobblestone');
  w.bot.entity = { position: new V3(2, 64, 0) };
  w.bot.pathfinder = { goto: async () => {}, setGoal() {}, movements: {} };
  const dug = [];
  w.bot.collectBlock = { collect: async (block) => { dug.push(block.name); w.open([0, 65, 0]); }, cancelTask() {} };
  w.bot.stopDigging = () => {};
  const c = context(w.bot, { Vec3: V3, isProtectedBlockName: (n) => /chest|furnace/.test(n) });
  vm.runInContext(timeoutFn + actionFn, c);
  const result = await c.performAction(w.bot, { type: 'clear_access' }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(dug, ['cobblestone'], 'the obstruction, never the chest');
  assert.match(result.text, /chest/, result.text);
  const again = await c.performAction(w.bot, { type: 'clear_access' }, 'test');
  assert.equal(again.ok, true, again.text);
  assert.match(again.text, /nothing's blocking/, again.text);
  assert.deepEqual(dug, ['cobblestone'], 'and it does not go looking for more work');
});

await check('Shelter walls: "mine" skips a target inside one, and says so when that is all there is', async () => {
  const walls = new Set(['0,64,0', '0,64,1']);
  const bot = makeBot();
  bot.entity = { position: new V3(5, 64, 5) };
  bot.registry = { blocks: { 1: { name: 'cobblestone' } } };
  bot.blockAt = (p) => ({ name: 'cobblestone', position: p, harvestTools: null });
  let positions = [new V3(0, 64, 0), new V3(0, 64, 1), new V3(8, 64, 8)];
  bot.findBlocks = () => positions;
  const collected = [];
  bot.collectBlock = { collect: async (blocks) => collected.push(...blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`)), cancelTask() {} };
  const c = context(bot, { Vec3: V3, resolveBlockFamily: () => [1], itemNamesForMinedBlocks: () => ['cobblestone'],
    tryTakeFromNearbyChest: async () => null, visitRememberedSpot: async () => [],
    wanderAndRetryFind: async () => [], filterAwayFromOtherBots: (b, p) => p,
    isProtectedBlockName: () => false, MINE_SEARCH_RADIUS: 32, CONTENTION_SEARCH_OVERFETCH: 3,
    isLivingSpaceWall: (b, pos) => walls.has(`${pos.x},${pos.y},${pos.z}`) });
  vm.runInContext(timeoutFn + actionFn, c);
  const result = await c.performAction(bot, { type: 'mine', block: 'cobblestone', count: 3 }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(collected, ['8,64,8'], 'only the cobblestone that is not a shelter wall');

  positions = [new V3(0, 64, 0), new V3(0, 64, 1)];
  const nothing = await c.performAction(bot, { type: 'mine', block: 'cobblestone', count: 3 }, 'test');
  assert.equal(nothing.ok, false);
  assert.match(nothing.text, /part of a shelter wall/, nothing.text);
});

await check('Mine: a chest holding fewer than needed is taken, and the shortfall is still mined', async () => {
  // Real bug found live 2026-10-13 (direct report: "building and tooling do not [work]"). Babs's
  // own weapon-acquisition loop (weaponStep/gatherPlanks, index.js) asked "mine" for more logs
  // than a nearby chest actually had. The old code treated ANY truthy chest match -- even a
  // partial one -- as fully satisfying the request and returned immediately: she looped for 20+
  // minutes on "found 1 ... already in a chest, no need to mine it" (wanted more) followed by a
  // craft that needed the full count and failed every single time, never once mining the
  // shortfall herself.
  const bot = makeBot();
  bot.entity = { position: new V3(5, 64, 5) };
  bot.registry = { blocks: { 1: { name: 'oak_log' } } };
  bot.blockAt = (p) => ({ name: 'oak_log', position: p, harvestTools: null });
  bot.findBlocks = () => [new V3(8, 64, 8)];
  const collected = [];
  bot.collectBlock = { collect: async (blocks) => collected.push(...blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`)), cancelTask() {} };
  const extras = { Vec3: V3, resolveBlockFamily: () => [1], itemNamesForMinedBlocks: () => ['oak_log'],
    tryTakeFromNearbyChest: async () => ({ name: 'oak_log', count: 1 }), visitRememberedSpot: async () => [],
    wanderAndRetryFind: async () => [], filterAwayFromOtherBots: (b, p) => p,
    isProtectedBlockName: () => false, MINE_SEARCH_RADIUS: 32, CONTENTION_SEARCH_OVERFETCH: 3,
    isLivingSpaceWall: () => false };
  const c = context(bot, extras);
  vm.runInContext(timeoutFn + actionFn, c);

  const result = await c.performAction(bot, { type: 'mine', block: 'oak_log', count: 2 }, 'test');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(collected, ['8,64,8'], 'mined exactly the shortfall (1), not the full original count of 2');
  assert.match(result.text, /took 1 oak_log from a chest and collected some oak_log/, result.text);

  // Regression guard: a chest that fully covers the request still short-circuits, same as before
  // this fix -- no wasted trip to a tree when the chest already had enough.
  collected.length = 0;
  c.tryTakeFromNearbyChest = async () => ({ name: 'oak_log', count: 2 });
  const full = await c.performAction(bot, { type: 'mine', block: 'oak_log', count: 2 }, 'test');
  assert.equal(full.ok, true);
  assert.deepEqual(collected, [], 'a fully-sufficient chest match still skips mining entirely');
  assert.match(full.text, /found 2 oak_log already in a chest, no need to mine it/, full.text);
});

await check('Beds: a spot the server refuses is not retried on a later goal tick', async () => {
  // Real bug found live 2026-10-13 (direct report: "building... do not [work]") -- Mayor retried
  // the exact same server-refused "Server refused to place ... the block is still air" spot
  // every single goal tick for 20+ minutes straight. The existing "not retried" check above only
  // pins the WITHIN-one-call `tried` guard -- `tried` resets to [] on every fresh "place_bed"
  // call, so nothing previously stopped the identical spot being offered again, identically, on
  // the very next tick.
  const SPOT = { foot: new V3(1, 65, 1), head: new V3(1, 65, 2), stand: new V3(1, 65, 0) };
  let placeAttempts = 0;
  const bot = makeBot();
  Object.assign(bot, {
    spawnPoint: new V3(0, 65, 0),
    inventory: { items: () => [{ name: 'white_bed' }] },
    isABed: () => false, // the placement never actually lands, every attempt
    blockAt: () => ({ name: 'air' }),
  });
  bot.pathfinder.goto = async () => {};
  bot.equip = async () => {};
  bot.placeBlock = async () => {
    placeAttempts++;
    throw new Error('Server refused to place white_bed at (1, 65, 1): the block is still air');
  };
  const c = context(bot, { Vec3: V3, findBedSites: () => [SPOT], wouldBlockAccess: () => false, cellOccupied: () => false,
    goals: { GoalNear: class {}, GoalBlock: class {} } });
  // The real refusal-memory functions, not mocked -- they're what this test actually verifies.
  vm.runInContext(between(actions, 'const BED_SPOT_REFUSAL_TTL_MS', 'const BED_DIRS') + timeoutFn + actionFn, c);

  const first = await c.performAction(bot, { type: 'place_bed', near: { x: 0, y: 65, z: 0 } }, 'test');
  assert.equal(placeAttempts, 1, 'the one offered spot is tried once');
  assert.equal(first.ok, false, 'the server refused the only candidate');

  const second = await c.performAction(bot, { type: 'place_bed', near: { x: 0, y: 65, z: 0 } }, 'test');
  assert.equal(placeAttempts, 1, 'the SAME spot, already proven refused last tick, is not retried');
  assert.equal(second.text, "couldn't find two free, flat blocks in a row near home for a bed.",
    'no candidates at all this time -- the refused one was filtered out before any attempt');
});

await check('Access: the other four placement sites ask first, each in the way that suits it', async () => {
  const slice = (from, to) => actions.slice(actions.indexOf(from), actions.indexOf(to));
  const build = slice('case "build": {', 'case "build_pen": {');
  assert.match(build, /const shuts = wouldBlockAccess\(bot, pos\);/, 'build checks every wall cell');
  assert.match(build, /shutIn\+\+;[\s\S]{0,200}continue;/, 'and leaves it open rather than abandoning the shelter');
  assert.match(build, /left open so a neighbouring fixture stays reachable/, 'the result says why it is short');

  const pen = slice('case "build_pen": {', 'case "herd_to_pen": {');
  assert.match(pen, /wouldBlockAccess\(bot, pos, item\.name\)/, 'build_pen checks, with the fence/gate it would place');

  const repair = slice('case "repair_terrain": {', 'case "store": {');
  assert.match(repair, /wouldBlockAccess\(bot, pos, materialName\)/);
  assert.match(repair, /if \(shuts\) \{[\s\S]{0,300}?\n\s+break;\n\s+\}/,
    'a pit fill stops at the fixture, it does not skip a layer and keep going');

  const bed = slice('case "place_bed": {', 'case "shear": {');
  assert.match(bed, /!wouldBlockAccess\(bot, c\.foot\) && !wouldBlockAccess\(bot, c\.head\)/, 'both halves of the bed');
});

await check('Craft: the auto-chain works for shaped recipes too, so coal + planks makes a torch', async () => {
  // Real ids and the real recipe shapes, captured off the server 2026-10-07: a torch is SHAPED,
  // so `ingredients` is undefined and only `delta` describes what it consumes. The old code read
  // `ingredients` alone and skipped the recipe, so the stick was never crafted.
  const ITEM = { oak_planks: 41, coal: 897, stick: 946, torch: 322 };
  const byId = Object.fromEntries(Object.entries(ITEM).map(([name, id]) => [id, { name, id }]));
  const inv = { oak_planks: 8, coal: 8, stick: 0, torch: 0 };
  const crafted = [];
  const shaped = (out, ins) => ({ result: { id: ITEM[out] },
    delta: [...ins.map(([n, c]) => ({ id: ITEM[n], count: -c })), { id: ITEM[out], count: 4 }] });
  const RECIPES = { torch: shaped('torch', [['coal', 1], ['stick', 1]]), stick: shaped('stick', [['oak_planks', 2]]) };

  const bot = {
    registry: { itemsByName: Object.fromEntries(Object.entries(ITEM).map(([n, id]) => [n, { id }])), items: byId },
    inventory: {
      items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })),
      count: (name) => inv[name] ?? 0,
    },
    // Affordable right now only: what recipesFor really does.
    recipesFor: (id, _m, count, _t) => {
      const name = byId[id].name;
      const r = RECIPES[name];
      if (!r) return [];
      return r.delta.filter((d) => d.count < 0).every((d) => inv[byId[d.id].name] >= -d.count) ? [r] : [];
    },
    recipesAll: (id) => (RECIPES[byId[id].name] ? [RECIPES[byId[id].name]] : []),
    craft: async (recipe, count) => {
      for (const d of recipe.delta) inv[byId[d.id].name] += d.count * (count || 1);
      crafted.push(byId[recipe.result.id].name);
    },
  };
  const c = vm.createContext({ bot, console: { log() {}, error() {} } });
  // From simpleSourceFor so the chain's own "what makes a stick" helper comes along with it.
  vm.runInContext(between(actions, 'function simpleSourceFor(', '// Extracted from "loot"'), c);

  assert.deepEqual(c.recipeInputs(RECIPES.torch).map((i) => i.id).sort(), [ITEM.coal, ITEM.stick].sort(),
    'a shaped recipe\'s inputs come out of delta');
  assert.equal(c.recipeInputs({ ingredients: [{ id: 1, count: 1 }] })[0].id, 1, 'a shapeless recipe still works');
  assert.equal(c.recipeInputs({}), null, 'and a recipe with neither is skipped, not crashed on');

  await c.craftItem(bot, 'torch', 1, null);
  assert.deepEqual(crafted, ['stick', 'torch'], 'the stick was chained first, from her planks');
  assert(inv.torch >= 4, `she ended up with torches: ${inv.torch}`);
});

// Tunnelling torches (2026-10-07).
function tunnel(extras = {}) {
  const c = vm.createContext({ Vec3: V3, process: { env: {} }, console: { log() {}, error() {} },
    Promise, DARK_LIGHT_LEVEL: 8, isProtectedBlockName: (n) => /chest|furnace|crafting_table/.test(n),
    fixtureKind: shelter().fixtureKind, isCovered: shelter().isCovered, ...extras });
  vm.runInContext(between(tunnelSrc, 'export const TORCH_SPACING'), c);
  return c;
}

await check('Torches: the light test uses the registry and real blocks, never the frozen block.light', async () => {
  const c = tunnel();
  const w = blockWorld({ groundY: 40, light: 15 }); // light 15 everywhere: a gate reading it would skip
  w.place([0, 43, 0], 'deepslate'); // a roof, so she counts as under cover
  const ids = c.lightSourceBlockIds(w.bot);
  assert(ids.length >= 4, `light sources come from emitLight: ${ids.length}`);
  for (const name of ['torch', 'lantern', 'glowstone', 'lava']) assert(ids.includes(BLOCK_ID[name]), name);
  for (const name of ['candle', 'stone', 'cobblestone']) assert(!ids.includes(BLOCK_ID[name]), name);

  assert.equal(c.litNearby(w.bot, new V3(0, 41, 0)), false, 'nothing shedding light yet');
  w.place([3, 41, 0], 'torch');
  assert.equal(c.litNearby(w.bot, new V3(0, 41, 0)), true, "another bot's torch three blocks away");
  assert.equal(c.litNearby(w.bot, new V3(0, 41, 20)), false, 'and not one twenty blocks away');
});

await check('Torches: a trail torch goes down every 6 blocks of covered tunnel, on the floor before a wall', async () => {
  const c = tunnel();
  assert.equal(vm.runInContext('TORCH_SPACING', c), 6, '14 - 6 = 8, exactly DARK_LIGHT_LEVEL at the midpoint');
  const w = blockWorld({ groundY: 40, light: 15 });
  for (let dz = -8; dz <= 8; dz++) w.place([0, 43, dz], 'deepslate'); // the tunnel roof
  w.bot.entity = { position: new V3(0.5, 41, 0.5) };
  w.bot.inventory.items = () => [{ name: 'torch', count: 4 }];
  const first = c.trailTorchSpot(w.bot, null);
  assert(!first.skip, JSON.stringify(first));
  assert.deepEqual([first.reference.position.y, first.face.y], [40, 1], 'placed on the floor, facing up');

  assert.match(c.trailTorchSpot(w.bot, new V3(0, 41, -3)).skip, /still close/, 'three blocks back is not far enough');
  assert(!c.trailTorchSpot(w.bot, new V3(0, 41, -6)).skip, 'six blocks back is');

  w.place([3, 41, 0], 'lantern'); // something already lighting this stretch
  assert.match(c.trailTorchSpot(w.bot, null).skip, /already lit/, 'a lit stretch costs nothing');

  const open = blockWorld({ groundY: 40 }); // no roof at all: she is out on the surface
  open.bot.entity = w.bot.entity; open.bot.inventory.items = w.bot.inventory.items;
  assert.match(c.trailTorchSpot(open.bot, null).skip, /out in the open/, 'no torches dropped across a field');

  const empty = blockWorld({ groundY: 40 });
  empty.place([0, 43, 0], 'deepslate');
  empty.bot.entity = w.bot.entity; empty.bot.inventory.items = () => [];
  assert.match(c.trailTorchSpot(empty.bot, null).skip, /no torches/);
});

await check('Torches: a trail torch never hangs on a chest, glass or leaves -- a wall is used instead', async () => {
  const c = tunnel();
  assert.equal(c.canHoldTorch({ name: 'stone', boundingBox: 'block' }), true);
  for (const name of ['chest', 'white_bed', 'oak_door', 'furnace', 'glass', 'oak_leaves', 'oak_fence', 'ice']) {
    assert.equal(c.canHoldTorch({ name, boundingBox: 'block' }), false, name);
  }
  assert.equal(c.canHoldTorch({ name: 'oak_leaves', boundingBox: 'empty' }), false);

  const w = blockWorld({ groundY: 40 });
  w.place([0, 40, 0], 'chest');       // standing on a chest: the floor can't hold one
  w.place([1, 41, 0], 'deepslate');   // but the tunnel wall beside her can
  w.place([0, 43, 0], 'deepslate');   // under cover
  w.bot.entity = { position: new V3(0.5, 41, 0.5) };
  w.bot.inventory.items = () => [{ name: 'torch', count: 4 }];
  const spot = c.trailTorchSpot(w.bot, null);
  assert(!spot.skip, JSON.stringify(spot));
  assert.equal(spot.reference.name, 'deepslate');
  assert.equal(`${spot.face}`, '(-1, 0, 0)', 'facing out of the wall'); // as a string: -0 is not 0 to strictEqual
});

await check('Torches: the trail fires between digs, not into one, and remembers where the last went', async () => {
  const c = tunnel();
  const w = blockWorld({ groundY: 40 });
  for (let dz = -2; dz <= 12; dz++) w.place([0, 43, dz], 'deepslate'); // roofed corridor
  const bot = new EventEmitter();
  Object.assign(bot, w.bot, { username: 'Babs', entity: { position: new V3(0.5, 41, 0.5) },
    inventory: { items: () => [{ name: 'torch', count: 4 }] }, equip: async () => {}, targetDigBlock: null });
  const placed = [];
  // Writes the torch into the world, so litNearby sees it the way it would in game.
  bot.placeBlock = async (ref, face) => {
    placed.push(`${ref.position.x},${ref.position.y},${ref.position.z}:${face.y}`);
    w.place([ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z], 'torch');
  };
  const trail = c.installTorchTrail(bot);

  bot.targetDigBlock = { name: 'stone' }; // the next dig already started
  bot.emit('diggingCompleted');
  await sleep(10);
  assert.deepEqual(placed, [], "never equips a torch while a dig is in flight -- that fights collectBlock's own tool");

  bot.targetDigBlock = null;
  bot.emit('diggingCompleted');
  await sleep(10);
  assert.deepEqual(placed, ['0,40,0:1'], 'one torch, on the floor');
  assert.deepEqual([trail.last.x, trail.last.y, trail.last.z], [0, 41, 0]);

  bot.entity.position = new V3(0.5, 41, 3.5); // three blocks on: too soon
  bot.emit('diggingCompleted');
  await sleep(10);
  assert.equal(placed.length, 1, 'spacing is kept across digs, not reset by each one');

  bot.entity.position = new V3(0.5, 41, 9.5);
  bot.emit('diggingCompleted');
  await sleep(10);
  assert.equal(placed.length, 2, 'and the next one goes down once she is clear of the last');
  trail.reset();
  assert.equal(trail.last, null);
});

await check('Torches: she tops up from coal she carries, falls back to a chest, and backs off after a failure', async () => {
  const calls = [];
  let reply = { ok: true, text: 'crafted 16 torch' };
  let inv = [{ name: 'torch', count: 2 }, { name: 'coal', count: 4 }, { name: 'oak_log', count: 3 }];
  const bot = { isSleeping: false, entity: { position: new V3(0, 64, 0) }, inventory: { items: () => inv } };
  const t = tunnel();
  const c = vm.createContext({ bot, Date, process: { env: {} }, console: { log() {}, error() {} },
    USERNAME: 'Babs', AUTONOMY_ENABLED: true, routineBlocked: () => false,
    arbiter: { OWNERS: { ROUTINE: 1 }, requestControl: async () => ({ release() {} }) },
    needsTorches: t.needsTorches, torchCount: t.torchCount, TORCH_CARRY_MIN: vm.runInContext('TORCH_CARRY_MIN', t),
    heldCount: (test) => inv.filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    performAction: async (b, a) => { calls.push(a); return reply; } });
  vm.runInContext(between(index, 'const TORCH_SUPPLY_CHECK_MS', 'setInterval(() => {\n  checkTorchSupply'), c);

  await c.checkTorchSupply();
  assert.deepEqual(calls.map((a) => `${a.type}:${a.item}`), ['craft:torch'], 'coal and a log on hand: make them');
  assert.equal(calls[0].count, 16, 'four coal: 16 torches (a craft count is items wanted, 2026-10-29)');

  inv = [{ name: 'torch', count: 2 }]; // no coal, no wood
  await c.checkTorchSupply();
  assert.equal(calls[1].type, 'loot', 'nothing to craft from: try a chest');

  reply = { ok: false, text: "couldn't find a chest" };
  await c.checkTorchSupply();
  const after = calls.length;
  await c.checkTorchSupply();
  assert.equal(calls.length, after, 'a failed attempt backs off instead of retrying every two minutes');

  inv = [{ name: 'torch', count: 16 }];
  assert.equal(t.needsTorches(bot), false, 'a full pouch is left alone');
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

// 2026-10-28: "should the bots poll for a next action when a previous action concludes, rather
// than on a timer?" -- a tick that ran a step chains the next one; an empty tick does not.
await check('Goal loop: a finished step chains the next tick instead of waiting out the 45s timer', async () => {
  const timers = [];
  const goal = { steps: 0 };
  let ran = 0, step = true;
  const c = vm.createContext({ console: { error() {} }, USERNAME: 'Babs', process: { env: {} }, parseInt,
    currentGoal: goal, setTimeout: (fn, ms) => timers.push(ms), setInterval: () => {},
    goalTick: async () => { ran++; if (step) goal.steps++; } });
  vm.runInContext('var currentGoal = this.currentGoal;' +
    between(index, 'const GOAL_FOLLOWUP_MS', 'setInterval(runGoalTick'), c);
  await c.runGoalTick();
  assert.deepEqual([...timers], [2000], 'a step ran: the next tick is queued 2s out');
  step = false;
  await c.runGoalTick();
  assert.equal(timers.length, 1, 'nothing ran (no control, night pause): fall back to the interval');
  assert.equal(ran, 2);
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

await check('Placement: every shelter, door, bed and fill placement clears its cell before placing', async () => {
  const caseSrc = (name) => between(actions, `    case "${name}": {`, '\n    case "');
  const before = (src, clear, place, what) =>
    assert(src.indexOf(clear) >= 0 && src.indexOf(clear) < src.indexOf(place), what);
  for (const name of ['build', 'build_communal_shelter', 'patch_shelter']) {
    before(caseSrc(name), 'clearCellForPlacement(bot, pos)', 'bot.placeBlock(refBlock, face)', `${name}: walls`);
  }
  for (const name of ['build', 'build_communal_shelter']) {
    before(caseSrc(name), 'clearCellForPlacement(bot, doorPos.offset(0, 1, 0))', 'bot.placeBlock(floorBelow', `${name}: both door cells`);
  }
  const bed = caseSrc('place_bed');
  before(bed, 'clearCellForPlacement(bot, candidate.head)', 'bot.placeBlock(bot.blockAt(candidate.foot', 'place_bed: both bed cells');
  before(caseSrc('place'), 'clearCellForPlacement(bot, referenceBlock.position', 'bot.placeBlock(referenceBlock', 'place');
  assert.match(between(actions, 'export function findBedSites(', 'const solid'), /isClearableCover\(b\)/,
    'a flowery room still offers bed sites');
});

console.log(`${passed} unit checks passed.`);
