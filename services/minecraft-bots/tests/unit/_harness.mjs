// Version: 1.4.0
// 1.4.0 | 2026-11-11 | Normalize CRLF before slicing runtime sources.
//
// 1.3.0 (2026-11-10): `index` also carries chat.js, planning.js, home-scan.js and priorities.js;
// `indexOnly` is index.js alone.
// 1.2.0 (2026-11-10): `index` also carries self-defense.js (index.js 2.140.0).
//
// 1.1.0 (2026-11-10): actionFn carries the actions/*.js handlers (actions.js 2.0.0).
//
// Shared harness for the unit checks in this directory (split out of ../unit.test.mjs on
// 2026-11-10): the module sources every check slices, the V3/bot/context() stubs, and check().
// Every top-level helper the checks use is exported from here.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const readSource = async (file) => (await readFile(root + file, 'utf8')).replace(/\r\n/g, '\n');
export const actions = await readSource('actions.js');
// index.js plus the modules split out of it (self-defense.js, chat.js, planning.js, home-scan.js, priorities.js, 2026-11-10), so a check that slices a
// function by its markers finds it wherever it now lives.
export const indexOnly = await readSource('index.js');
export const selfDefenseSrc = await readSource('self-defense.js');
export const chatSrc = await readSource('chat.js');
export const planningSrc = await readSource('planning.js');
export const homeScanSrc = await readSource('home-scan.js');
export const prioritiesSrc = await readSource('priorities.js');
export const index = [indexOnly, selfDefenseSrc, chatSrc, planningSrc, homeScanSrc, prioritiesSrc].join(String.fromCharCode(10));
export const equipment = await readSource('equipment.js');
export const skills = await readSource('skills.js');
export const swim = await readSource('swim-movements.js');
export const shelterSrc = await readSource('shelter.js');
export const tunnelSrc = await readSource('tunneling.js');
export const arbiter = await import(pathToFileURL(root + 'arbiter.js').href);

// The `vec3` stand-in for every context below: there is no node_modules in this suite. Declared
// here rather than beside its first bed/shelter use, because `class` is not hoisted and the very
// first check() now builds a context that needs it (2026-10-07).
export class V3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  offset(dx, dy, dz) { return new V3(this.x + dx, this.y + dy, this.z + dz); }
  equals(o) { return o.x === this.x && o.y === this.y && o.z === this.z; }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
  toString() { return `(${this.x}, ${this.y}, ${this.z})`; }
  floored() { return new V3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
}

export function between(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, start);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert(to > from, end);
  return source.slice(from, to).replace(/export /g, '');
}
// actions.js 2.0.0: each action is its own file under actions/, dispatched by ACTION_HANDLERS.
// Their source, imports dropped, is appended to every slice that runs performActionAs, so the
// handlers are plain functions in the same context, the way the switch's cases used to be.
const actionFiles = (await readdir(root + 'actions')).filter((f) => f.endsWith('.js')).sort();
export const actionHandlerSrc = (await Promise.all(actionFiles.map((f) => readSource('actions/' + f))))
  .map((s) => s.replace(/^import [^;]*;$/gm, '').replace(/export /g, '')).join(String.fromCharCode(10));
const actionSources = Object.fromEntries(await Promise.all(actionFiles.map(async (f) =>
  [f.replace(/\.js$/, '').replace(/-/g, '_'), await readSource('actions/' + f)])));
// The source of one action's own file (what used to be its `case "<type>":` block).
export const actionSource = (type) => { assert(actionSources[type], type); return actionSources[type]; };
// The old performActionAs switch, rebuilt from the action files in ACTION_HANDLERS' order: each
// file's function body under its `case "<type>": {` label(s). Checks that slice one case's text
// (or wrap it back into a switch to run it) read it from here; the code is the real file's.
const handlerTable = between(actions, '  const ACTION_HANDLERS = {', '  };');
const caseOrder = [...handlerTable.matchAll(/^    (\w+): (\w+),$/gm)].map((m) => [m[1], m[2]]);
const bodyOf = (fn) => {
  const src = actionHandlerSrc.slice(actionHandlerSrc.indexOf(`async function ${fn}(`));
  const lines = src.split(String.fromCharCode(10));
  const end = lines.findIndex((l, i) => i > 0 && l === '}');
  return lines.slice(3, end).map((l) => (l ? '    ' + l : l)).join(String.fromCharCode(10));
};
export const actionCases = caseOrder.map(([type, fn], i) => {
  const next = caseOrder[i + 1];
  const label = `    case "${type}":` + (next && next[1] === fn ? '' : ' {');
  return next && next[1] === fn ? label : label + String.fromCharCode(10) + bodyOf(fn) + String.fromCharCode(10) + '    }';
}).join(String.fromCharCode(10)) + String.fromCharCode(10) + '    default:';
export const actionFn = between(actions, 'const LOST_CONTROL') + String.fromCharCode(10) + actionHandlerSrc;
export const timeoutFn = between(actions, 'function withTimeout(', 'function simpleSourceFor(');

export function makeBot() {
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
export function context(bot, extras = {}) {
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
    // 2026-11-07: chest searches reach CHEST_SEARCH_RADIUS and walk far chests in hops (hopToward),
    // both defined above every slice taken here.
    CHEST_SEARCH_RADIUS: 128, hopToward: async () => {},
    ...extras });
}

// shelter.js / tunneling.js run as source in their own contexts, like every other module here:
// no node_modules offline, so `Vec3` is the V3 stub below. `export const` bindings are lexical,
// not context properties, so shelterConst() evaluates them by name (the same trick the shelter
// geometry checks already use for SHELTER_ROOM).
export let shelterCtx = null;
export function shelter() {
  if (!shelterCtx) {
    shelterCtx = vm.createContext({ Vec3: V3 });
    vm.runInContext(between(shelterSrc, 'export const posKey'), shelterCtx);
  }
  return shelterCtx;
}
export const shelterConst = (name) => vm.runInContext(name, shelter());
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export let passed = 0;
export async function check(name, fn) { await fn(); passed++; console.log('PASS: ' + name); }
export const passedCount = () => passed;

// ---- 2026-09-24 follow-up: remaining gaps from the review ----------------------------------------
export const longterm = await readFile(root + 'longterm.js', 'utf8');

// Builder-item claims (2026-10-11, PRIORITIES_PROPOSAL.md Tier 2 PR2): same shape as bedWorld's
// own claims directory + shared-store mock, just a {item, claimedAt} value instead of a position.
// `shared`: hermes-memory's minecraft-builder-claims rows as { name: value } (mutated by writes);
// omitted = hermes-memory unreachable, so claims fall back to this host's files.
export async function builderClaimsWorld(username, { shared } = {}) {
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

// Guard anchor (2026-10-11, PRIORITIES_PROPOSAL.md §2a): same shape as builderClaimsWorld, just
// a single shared row ({holder, claimedAt}, key "anchor") instead of one per bot.
export async function guardAnchorWorld(username, { shared } = {}) {
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

// ---- 2026-09-25: acceptance checks from the review that had no test yet -----------------------
export const skillsSrc = skills;
export const router = await readFile(root + 'router.js', 'utf8');
export const goalTickSrc = () => between(index, 'async function retireGoal(', '// Direct request, 2026-10-28 ("the 45 second');
export function goalTickContext(bot, extras) {
  const c = vm.createContext({ console: { log() {}, error() {} }, bot, arbiter, busy: false, Date, Promise,
    AUTONOMY_ENABLED: true, USERNAME: 'Amy', PERSONA_NAME: 'amy', MAX_CONSECUTIVE_FAILURES: 3,
    goalPausedForNight: () => false, routineBlocked: () => false, parseGoalStep: () => ({ type: 'step', action: { type: 'mine' } }),
    logStep: (goal, line) => { goal.log.push(line); goal.steps++; }, saveGoal: async () => {}, clearGoal: async () => {},
    recordSkillOutcome: async () => {}, runSkill: async () => ({ ok: true, text: 'ran' }), ...extras });
  vm.runInContext('var currentGoal = this.currentGoal;' + goalTickSrc(), c);
  return c;
}

export const ragBackend = await readFile(root + 'rag-backend.js', 'utf8');
export const ragContext = (extras) => {
  const c = vm.createContext({ JSON, Map, AbortSignal, PYTHON: 'py', SEARCH_SCRIPT: 's.py', INGEST_SCRIPT: 'i.py',
    SEARCH_TIMEOUT_MS: 30000, INGEST_TIMEOUT_MS: 180000, REMOTE_TIMEOUT_MS: 35000, RAG_TOKEN: 'tok',
    MEMORY_DIR: '/m', path: { join: (...p) => p.join('/'), dirname: (p) => p.split('/').slice(0, -1).join('/') }, ...extras });
  vm.runInContext(between(ragBackend, 'export const isRemote').replace(/export /g, ''), c);
  return c;
};

// ---- 2026-09-25: fight-or-flee policy -------------------------------------------------------------
export function policyContext({ health = 20, soldier = false, armed = true, mobs = [] }) {
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

// Beds (2026-10-18): a fake world of bed blocks, with the real "sleep" action and no claim
// plumbing at all. `occupied`: positions (either half) where bot.sleep() rejects as taken, same
// way the real server does for a bed someone is actually in.
export function bedWorld({ standAt = new V3(0, 64, 0), occupied = [], rememberedBed = null } = {}) {
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

// Doors (2026-09-25): pathfinder's own getBlock() marks every door and gate unsafe and physical from
// the block type, and never openable for doors; applyDoorState must correct that from the state.
export function doorBlock(name, props) {
  return { name, safe: false, physical: !name.endsWith('_fence_gate'), openable: name.endsWith('_fence_gate'),
    getProperties: () => props };
}
export const doorFns = () => {
  const c = vm.createContext({});
  vm.runInContext(between(swim, 'function applyDoorState(', 'const MAX_DIG_LABOR_COST') + between(swim, 'function isDoorway(', 'export function isOpenDoorOrGate('), c);
  return c;
};

// Closing behind (2026-09-25): a fake bot walks through a doorway at (0, 64, 0) one tick at a time.
export function closerWorld({ name = 'oak_door', open = true } = {}) {
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

export function hungerWorld({ food = 10, items = [], lootGives = null, huntGives = null } = {}) {
  const inv = [...items];
  const calls = [];
  const bot = { food, isSleeping: false, inventory: { items: () => inv } };
  const performAction = async (b, action) => {
    calls.push(action.type + (action.item ? `:${action.item}` : '') + (action.lastResort ? ':lastResort' : ''));
    if (action.type === 'hunt') {
      if (!huntGives) return { ok: false, text: 'no animals to spare nearby to hunt.' };
      inv.push({ name: huntGives, count: 2 });
      return { ok: true, text: 'hunted.' };
    }
    if (action.type === 'eat' && action.lastResort && inv.some((it) => it.name === 'rotten_flesh')) {
      return { ok: true, text: 'ate some rotten_flesh.' };
    }
    if (action.type === 'loot') {
      if (!lootGives) return { ok: false, text: 'checked nearby chests, no food in any of them.' };
      inv.push({ name: lootGives, count: 8 });
      return { ok: true, text: `found 8 ${lootGives} in a chest.` };
    }
    if (action.type === 'eat') {
      const i = inv.findIndex((it) => ['bread', 'carrot', 'beef'].includes(it.name));
      return i < 0 ? { ok: false, text: "don't have anything to eat." } : { ok: true, text: `ate some ${inv[i].name}.` };
    }
    return { ok: true, text: 'fished.' };
  };
  const c = vm.createContext({ bot, performAction, console: { log() {}, error() {} }, Date, USERNAME: 'Amy',
    AUTONOMY_ENABLED: true, HUNGER_THRESHOLD: 18, CRITICAL_FOOD_LEVEL: 6, FOOD_NAMES: ['bread', 'carrot', 'beef'],
    heldCount: (test) => inv.filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0),
    routineBlocked: () => false, arbiter: { OWNERS: { ROUTINE: 1, HUNGER_CRITICAL: 2 }, requestControl: async () => ({ release() {} }) } });
  vm.runInContext(between(index, 'const FOOD_FETCH_COUNT', 'guardedInterval(() => {'), c);
  return { c, calls, inv };
}

export const farmGoalSrc = () => between(index, 'const FARM_WORDS', 'async function goalTick(');

export function farmGoalWorld(results, status = { ripe: 0, growing: 0 }, inv = [], blocks = []) {
  const calls = [], done = [], retired = [];
  const performAction = async (b, action) => { calls.push({ ...action }); return results.shift() ?? { ok: false, text: 'nothing' }; };
  const world = { status };
  const c = vm.createContext({ console: { log() {}, error() {} }, Date, USERNAME: 'Babs', MAX_CONSECUTIVE_FAILURES: 3,
    bot: { chat() {}, inventory: { items: () => inv }, entities: {}, registry: { blocksByName: {} },
      findBlocks: ({ matching }) => blocks.filter((b) => typeof matching !== 'function' || matching(b)).map((b) => b.position),
      blockAt: (pos) => blocks.find((b) => b.position === pos) },
    Vec3: V3, performAction,
    farmStatus: () => world.status, narrateAction: async (t) => t, recordGoalOutcome() {},
    broadcastGoalState: async (status, d, item) => { done.push([status, item]); },
    retireGoal: async (g) => { retired.push(g); }, saveGoalIfCurrent: async () => {},
    logStep: () => {}, loadPenLocation: async () => null, LIVESTOCK: [], BREEDING_FOOD: {}, countInPen: () => 0, findPenSite: () => null });
  vm.runInContext(farmGoalSrc(), c);
  const goal = { description: 'start a farm', createdAt: Date.now() - 1000, consecutiveFailures: 0 };
  const tick = () => c.runFarmGoal(goal, async () => true, () => ({ release() {} }), () => false);
  return { c, calls, done, retired, goal, world, tick };
}

export function plotWorld(blocks, water) {
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
export function closedIron(c) { return c.isClosedOpenableDoorway({ name: 'iron_door', getProperties: () => ({ half: 'lower', open: false }) }); }

// Beds (2026-09-26). findBedSites (inside this slice) calls shelter.js's shelterInteriorsNear/
// posKey (2026-10-18) -- wired from the real shelter() context, same pattern context() already
// uses for actions.js's own geometry imports, so the default (no doors in bedSiteWorld) behaves
// exactly like today and a test can still override shelterInteriorsNear to prove the preference.
export const bedFns = () => {
  const s = shelter();
  const c = vm.createContext({ Vec3: V3, Math, Object, shelterInteriorsNear: s.shelterInteriorsNear,
    posKey: shelterConst('posKey'), isProtectedBlockName: (n) => n.endsWith('_bed') || n.endsWith('_door') });
  // 2026-10-28: findBedSites' open() now asks isClearableCover() -- the real one, so a flower counts.
  vm.runInContext(between(actions, 'const PLACEMENT_KEEP', 'export async function clearCellForPlacement'), c);
  vm.runInContext(between(actions, 'function woolCounts(', 'export const CROP_MAX_AGE'), c);
  return c;
};

export function bedSiteWorld({ beds = [], doors = [], walls = [] } = {}) {
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

// Shelters (2026-09-26).
export const shelterFns = () => {
  const c = vm.createContext({ Vec3: V3, Math, isProtectedBlockName: (n) => /chest|_bed$|_door$|crafting_table|furnace/.test(n) });
  vm.runInContext(between(actions, 'const SHELTER_MATERIAL', 'export const CROP_MAX_AGE').replace(/export /g, ''), c);
  return c;
};

export function shelterWorld({ groundY = (x, z) => 63, blocked = [] } = {}) {
  const b = new Set(blocked.map((p) => `${p.x},${p.y},${p.z}`));
  return { blockAt: (p) => (p.y <= groundY(p.x, p.z) || b.has(`${p.x},${p.y},${p.z}`)
    ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }) };
}

// ---- 2026-10-07: access to chests/beds/doors, shelter walls, tunnelling torches --------------

// A flat world: solid stone at y <= groundY, air above, plus blocks placed by name. Beds, doors
// and chests are solid here because they are solid in the real registry -- the access rules and
// the covered flood fill both depend on that.
// Block ids and a minimal registry, so a scan by id (bedAnchors, litNearby) works the way the
// real one does. emitLight is the registry field tunneling.js derives its light sources from.
export const BLOCK_DEFS = [
  ['air', 0], ['stone', 0], ['deepslate', 0], ['cobblestone', 0], ['grass_block', 0],
  ['chest', 0], ['barrel', 0], ['furnace', 0], ['white_bed', 0], ['oak_door', 0],
  ['spruce_door', 0], ['oak_fence_gate', 0], ['sand', 0], ['gravel', 0],
  ['torch', 14], ['lantern', 15], ['glowstone', 15], ['lava', 15], ['candle', 0],
];
export const BLOCK_ID = Object.fromEntries(BLOCK_DEFS.map(([name], i) => [name, i + 1]));
export const TEST_REGISTRY = {
  blocksArray: BLOCK_DEFS.map(([name, emitLight], i) => ({ name, id: i + 1, emitLight })),
  blocksByName: Object.fromEntries(BLOCK_DEFS.map(([name, emitLight], i) => [name, { name, id: i + 1, emitLight }])),
};

export function blockWorld({ groundY = 63, light = 0 } = {}) {
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

// The 4x5 shelter from actions.js, with a bed in its room -- the real geometry, not a mock of it.
export function shelterLivingSpace() {
  const s = shelterFns();
  const c = shelter();
  const base = new V3(0, 64, 0);
  const w = blockWorld();
  for (const pos of s.shelterPositions(base)) w.place([pos.x, pos.y, pos.z], 'cobblestone');
  w.bed([base.x, base.y, base.z + 1]); // head at the room's (0,1), foot at (0,0)
  const space = c.refreshLivingSpace(w.bot, base);
  return { c, w, base, space };
}

// Any enclosed structure, for bed placement (2026-10-18): "not a set size or shape... no openings
// other than doors," walls any material "including glass, but not sand." A 1x1x3 room, walls of
// `wallName` on all four sides, a roof and a floor, one real door -- built with blockWorld()'s own
// primitives, not shelterPositions(), to prove this works on a shape the Builder's own fixed room
// never uses.
export function smallRoom({ wallName = 'cobblestone' } = {}) {
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

// Direct request, 2026-10-22, generalizing S42's fix: "recognize any number of individual
// shelters; larger shelters as defined by contiguous walls roof and floor, broken only by
// doors." shelterRoomsNear()/holesIn() must work on damage shelterInteriorsNear()'s own strict
// test structurally cannot (a hole makes that fill leak without bound -- see the "Shelter
// detection" test two above, `holed.sealed === false`), on any number of separate rooms, and on
// a shape neither of this file's two hand-coded geometries (shelterPositions'/
// communalShelterPositions' fixed rectangles) ever builds.
export function room(w, { baseX = 0, baseZ = 0, wallName = 'cobblestone', doorFacing = 'north' } = {}) {
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

// Tunnelling torches (2026-10-07).
export function tunnel(extras = {}) {
  const c = vm.createContext({ Vec3: V3, process: { env: {} }, console: { log() {}, error() {} },
    Promise, DARK_LIGHT_LEVEL: 8, isProtectedBlockName: (n) => /chest|furnace|crafting_table/.test(n),
    fixtureKind: shelter().fixtureKind, isCovered: shelter().isCovered, ...extras });
  vm.runInContext(between(tunnelSrc, 'export const TORCH_SPACING'), c);
  return c;
}

// Residence world for the checks below: shelters are bases; a bed fills column 0 (two cells), a chest
// sits at (1, 0, 2). slice() tolerates a marker the old code doesn't have, so a check fails on what
// the old code DOES, not on a missing function.
export const slice = (src, a, b) => { try { return between(src, a, b); } catch { return ''; } };
export function residenceWorld({ online, shelters }) {
  const blocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  for (const { base, bed, chest, secondBed } of shelters) {
    if (bed) { blocks.set(key(base), 'white_bed'); blocks.set(key(base.offset(0, 0, 1)), 'white_bed'); }
    if (secondBed) { blocks.set(key(base.offset(1, 0, 0)), 'white_bed'); blocks.set(key(base.offset(1, 0, 1)), 'white_bed'); }
    if (chest) blocks.set(key(base.offset(1, 0, 2)), 'chest');
  }
  const bot = { players: Object.fromEntries(online.map((n) => [n, {}])), spawnPoint: new V3(0, 64, 0),
    isABed: (b) => !!b?.name?.endsWith('_bed'),
    blockAt: (p) => { const name = blocks.get(key(p)) ?? 'air'; return { name, boundingBox: name === 'air' ? 'empty' : 'block' }; } };
  return { bot, bases: shelters.map((x) => x.base) };
}

// 2026-11-07 (actions.js 1.106.0): chests are chosen by what the fleet knows they hold, and one kind
// of item split between two chests is brought together.
export function chestMemoryStubs(known) {
  const files = { k: JSON.stringify(known) };
  return {
    Vec3: V3, FOOD_NAMES: ['bread', 'beef'], KNOWN_CHESTS_FILE: 'k', path: { dirname: () => '.' }, CHEST_SEARCH_RADIUS: 128,
    readFile: async (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; },
    writeFile: async (f, data) => { files[f] = data; }, mkdir: async () => {},
  };
}
export const chestMemorySrc = between(actions, 'function chestKey(', '// The read-side counterpart');
export function chestMemory(known = {}) {
  const c = vm.createContext({ ...chestMemoryStubs(known), console: { log() {}, error() {} } });
  vm.runInContext(chestMemorySrc, c);
  return c;
}
export const chestAt = (x, contents, extra = {}) => ({ position: { x, y: 64, z: 0 }, contents, ...extra });

// A bot, its inventory and real-enough chests: withdraw/deposit move counts between them, and a
// deposit tops up part-filled stacks before starting new ones, as mineflayer's transfer() does.
export function chestWorld(chests, held) {
  const stackSize = 64;
  const names = { 5: 'oak_log', 6: 'birch_log' };
  const bot = makeBot();
  const opened = [];
  const deposits = [];
  const inv = held.map((i) => ({ ...i }));
  Object.assign(bot, {
    username: 'Amy', entity: { position: new V3(0, 64, 0) },
    registry: { itemsByName: { oak_log: { id: 5 }, birch_log: { id: 6 } }, blocksByName: { chest: { id: 9 } } },
    blockAt: (p) => ({ type: 9, name: 'chest', position: new V3(p.x, p.y, p.z) }),
    findBlocks: () => Object.keys(chests).map((k) => new V3(...k.split(',').map(Number))),
    inventory: {
      items: () => inv.filter((i) => i.count > 0),
      count: (type) => inv.filter((i) => i.type === type).reduce((n, i) => n + i.count, 0),
      emptySlotCount: () => 36 - inv.filter((i) => i.count > 0).length,
    },
    openChest: async (block) => {
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      opened.push(key);
      const slots = chests[key];
      return {
        inventoryStart: 27,
        containerItems: () => slots.filter((i) => i.count > 0).map((i) => ({ ...i, stackSize })),
        items: () => inv.filter((i) => i.count > 0),
        async withdraw(type, _, n) {
          for (const slot of slots) {
            if (slot.type !== type || !n) continue;
            const t = Math.min(n, slot.count); slot.count -= t; n -= t;
            inv.push({ type, name: slot.name, count: t });
          }
        },
        async deposit(type, _, n) {
          deposits.push([key, type, n]);
          let left = n;
          for (const item of inv) { if (item.type === type && left) { const t = Math.min(left, item.count); item.count -= t; left -= t; } }
          left = n;
          for (const slot of slots) {
            if (slot.type === type && slot.count && slot.count < stackSize) { const t = Math.min(left, stackSize - slot.count); slot.count += t; left -= t; }
          }
          while (left > 0) { const t = Math.min(left, stackSize); slots.push({ type, name: names[type], count: t }); left -= t; }
        },
        async close() {},
      };
    },
  });
  bot.pathfinder.goto = async () => {};
  return { bot, opened, deposits };
}
export function chestActionContext(bot, known) {
  const ctx = context(bot, { chestObstructed: () => false, wanderAndRetryFind: async () => [], ...chestMemoryStubs(known) });
  vm.runInContext(timeoutFn + chestMemorySrc + actionFn, ctx);
  return ctx;
}

// 2026-11-07 (swim-movements.js 1.6.0): a search that runs out of budget walks its partial path
// toward the goal and searches again, instead of failing.
export function steppedGotoWorld(script) {
  // script: one entry per real goto() call -- { path, status } rejects with that status's error after
  // emitting path_update; 'ok' resolves. A GoalBlock leg moves her to its block.
  const bot = new EventEmitter();
  const calls = [];
  const named = (name) => Object.assign(new Error(name), { name });
  bot.username = 'Amy';
  bot.entity = { position: new V3(0, 64, 0) };
  bot.pathfinder = {
    searchRadius: 48, legRadii: [],
    async goto(goal) {
      calls.push(goal.kind ?? 'goal');
      if (goal.kind === 'block') bot.pathfinder.legRadii.push(bot.pathfinder.searchRadius);
      if (goal.kind === 'block') { bot.entity.position = new V3(goal.x, goal.y, goal.z); return; }
      const step = script.shift();
      if (step === 'ok') return;
      if (step.error) throw named(step.error);
      bot.emit('path_update', { status: step.status, path: step.path, cost: step.cost ?? 10 });
      throw named(step.status === 'noPath' ? 'NoPath' : 'Timeout');
    },
  };
  const c = vm.createContext({ console: { log() {} }, pathfinderPkg: { goals: {
    GoalBlock: class { constructor(x, y, z) { Object.assign(this, { x, y, z, kind: 'block' }); } } } } });
  vm.runInContext(between(swim, 'export const STEPPED_GOTO_MAX_LEGS', '// Opens a closed wooden door'), c);
  c.installSteppedGoto(bot);
  // The goal: 100 blocks east; its estimate is the distance left.
  const goal = { heuristic: (n) => Math.abs(100 - n.x) };
  return { bot, calls, goal };
}
