// Version: 1.0.0
//
// Unit checks: beds and sleeping (part 2 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/beds-2.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, V3, between, actionFn, timeoutFn, makeBot, context, shelter, shelterConst, check, longterm, farmGoalSrc, bedFns, bedSiteWorld, shelterFns, blockWorld, shelterLivingSpace, room, slice, residenceWorld, passedCount } from './_harness.mjs';


await check('Shelter goal: a finished shelter gets a bed put in it; a build nobody can see is a failure', async () => {
  // 2026-10-28 (direct report: "they completed a few shelter buildings, but don't seem to realize
  // they can place a bed"): done used to mean "a complete structure", so an empty shelter finished
  // the goal and Tier 1 re-proposed it forever; and a build reported standing but not detected
  // returned ok:true, 328 times, never tripping the failure limit.
  const calls = [];
  const c = vm.createContext({ Vec3: V3, USERNAME: 'Babs', SHELTER_SITE_RADIUS: 48, console,
    SHELTER_ROOM: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]],
    bot: { spawnPoint: new V3(0, 64, 0), inventory: { items: () => c.held }, blockAt: () => null },
    held: [], found: null, bedded: false, buildResult: null,
    // The door check (2026-10-28) is its own test below -- here the doorway already has one.
    isDoorway: () => true, doorwayPosition: (b) => b.offset(0, 0, 3), unfinishedShelterNearHome: () => null,
    findShelterNearHome: () => c.found, shelterHasBed: () => c.bedded,
    // 2026-11-04: what to do comes from the residence plan, not from her own shelter.
    residencePlan: () => c.plan, completeSheltersNearHome: () => [], holdsItem: () => false, plan: null,
    bedStep: async () => ({ ok: true, text: 'got wool.', action: { type: 'get_wool' } }),
    findShelterSite: () => new V3(41, 65, -30), shelterPositions: () => [], shelterMaterialCount: () => 0,
    performAction: async (_bot, action) => {
      calls.push(action);
      if (action.type === 'place_bed') { c.bedded = true; return { ok: true, text: 'placed a bed.', bedAt: new V3(41, 65, -29) }; }
      return c.buildResult;
    } });
  vm.runInContext(between(index, 'async function shelterStep(', 'async function runShelterGoal('), c);

  c.found = { base: new V3(41, 65, -30), complete: true };
  c.plan = { kind: 'bed', base: c.found.base, beds: 0, active: 1 };
  let step = await c.shelterStep({}, null);
  assert.equal(step.done, undefined, 'a complete shelter with no bed is not done');
  assert.equal(step.action.type, 'get_wool', 'no bed held -- bedStep goes and gets one');
  c.held = [{ name: 'white_bed', count: 1 }];
  step = await c.shelterStep({}, null);
  assert.equal(calls.at(-1).type, 'place_bed');
  assert.equal(calls.at(-1).near, c.found.base, 'a held bed goes into that shelter');
  // 2026-10-30: two of Babs' beds placed "near" her shelter landed in other covered spots.
  assert.deepEqual(calls.at(-1).cells.map(({ x, z }) => [x - 41, z + 30]), [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]],
    "and only into that shelter's own room cells");
  assert(calls.at(-1).cells.every((p) => p.y === 65), "at the room's floor level");
  c.plan = { kind: 'done', beds: 1, active: 1 };
  assert.equal((await c.shelterStep({}, null)).done, true, 'once every active bot has a bed, done');

  c.found = null; c.bedded = false; c.held = []; c.plan = { kind: 'build', beds: 1, active: 2 };
  c.buildResult = { ok: true, built: true, text: 'the shelter is already standing.' };
  step = await c.shelterStep({ shelterAt: { x: 41, y: 65, z: -30 } }, null);
  assert.equal(step.ok, false, 'built but undetectable is a failure, so the goal can give up');
  assert.equal(step.built, false, 'and no "Built a shelter" note for something nobody can find');
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
    // 2026-11-04: the residence plan, from the same two flags.
    residencePlan: () => (!standing ? { kind: 'build', beds: 0, active: 1 }
      : bedded ? { kind: 'done', beds: 1, active: 1 } : { kind: 'bed', base: new V3(1, 64, 1), beds: 0, active: 1 }),
    completeSheltersNearHome: () => (standing ? [new V3(1, 64, 1)] : []), holdsItem: () => false,
    findShelterSite: () => new V3(1, 64, 1), shelterPositions: s.shelterPositions,
    unfinishedShelterNearHome: () => null, isDoorway: () => false, doorwayPosition: s.doorwayPosition,
    shelterMaterialCount: (b) => b.inventory.items().filter((i) => /_(planks|log)$/.test(i.name)).reduce((n, i) => n + i.count, 0),
    // 2026-10-27: runShelterGoal now registers a RAG note on completion (writeMemoryNote,
    // longterm.js) -- stubbed here same as every other cross-module function this context
    // already injects.
    writeMemoryNote: async () => {}, PERSONA_NAME: 'amy', SHELTER_SITE_RADIUS: 48,
    SHELTER_ROOM: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]] });
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
  assert.match(place, /findBedSites\(bot, target \?\? bot\.spawnPoint \?\? bot\.entity\.position, within\)/,
    'the target, when given, is what findBedSites actually searches around');
});


await check('Beds: given the room cells, a bed goes in that room even when another covered space counts as a shelter', async () => {
  // 2026-10-30: Babs' shelter goal placed two beds "near" her shelter; both landed in some other
  // covered space nearby that shelterInteriorsNear tagged, so her room stayed bedless.
  const c = bedFns();
  vm.runInContext(between(actions, 'function cellOccupied(', 'export function findBedSite('), c);
  const s = shelterFns();
  const base = new V3(5, 64, 5);
  const walls = new Set(s.shelterPositions(base).map((p) => `${p.x},${p.y},${p.z}`));
  const bot = { entity: {}, entities: {}, isABed: () => false, findBlocks: () => [],
    blockAt: (p) => (p.y < 64 || walls.has(`${p.x},${p.y},${p.z}`) ? { name: 'cobblestone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }) };
  c.shelterInteriorsNear = () => new Set(['0,64,-3', '0,64,-4']); // somewhere else, out in the open
  const elsewhere = c.findBedSites(bot, base)[0];
  assert.deepEqual([elsewhere.foot.x, elsewhere.foot.z], [0, -3], 'without the cells, the other space wins');
  const room = new Set([[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]].map(([dx, dz]) => `${base.x + dx},${base.y},${base.z + dz}`));
  const sites = c.findBedSites(bot, base, room);
  assert(sites.length > 0, 'the room has a spot');
  assert(sites.every((site) => room.has(`${site.foot.x},${site.foot.y},${site.foot.z}`) &&
    room.has(`${site.head.x},${site.head.y},${site.head.z}`)), 'every spot offered is inside the room');
  const place = actions.slice(actions.indexOf('case "place_bed": {'), actions.indexOf('case "shear": {'));
  assert.match(place, /findBedSites\(bot, target \?\? bot\.spawnPoint \?\? bot\.entity\.position, within\)/,
    'place_bed passes its cells through');
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


await check('Shelter rooms (general): the floor cell in a corner beside a bed is room, not a hole', async () => {
  // Direct report, 2026-11-02: "they keep enclosing themselves inside a residence with
  // un-necessary blocks". Live, the corner cells beside a shelter's bed read as holes -- floor,
  // two walls and the bed made 4 solid sides -- and patch_shelter filled them in.
  const c = shelter();
  const w = blockWorld();
  const size = 5;
  for (let dx = -1; dx <= size; dx++) {
    for (let dz = -1; dz <= size; dz++) {
      const edge = dx === -1 || dx === size || dz === -1 || dz === size;
      w.place([dx, 63, dz], 'oak_planks');
      w.place([dx, 68, dz], 'oak_planks');
      if (!edge) continue;
      for (let dy = 64; dy <= 67; dy++) {
        if (dx === -1 && dz === 0 && dy <= 65) continue;
        w.place([dx, dy, dz], 'oak_planks');
      }
    }
  }
  w.door([-1, 64, 0], 'oak_door', 'west');
  w.bed([3, 64, 4]); // head (3,64,4), foot (3,64,3): the corner cell (4,64,4) sits beside its head
  const [found] = c.shelterRoomsNear(w.bot, new V3(-1, 64, 0), 12);
  assert(found.inside.has('4,64,4'), 'the corner cell is part of the room');
  assert.equal(found.holes.size, 0, `an intact room with a bed has no holes: ${[...found.holes]}`);
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


await check('place_bed: a bed spot she couldn\'t reach is reported as unreachable, not as a server refusal', async () => {
  const bed = between(actions, '    case "place_bed": {', '\n    case "');
  assert.match(bed, /unreachable\.push\(candidate\.foot\);\s*continue;/, 'an unreachable spot is recorded as such');
  assert.match(bed, /const refused = tried\.filter\(\(t\) => !unreachable\.includes\(t\)\);/);
  assert.match(bed, /refused\.length \? `the server refused the bed/, 'only real refusals say "refused"');
  assert.match(bed, /couldn't reach where she'd stand to place the bed/);
});


await check('Builder: shelter_capacity counts the bots in the game -- beds for the active bots, each in a residence', async () => {
  // 2026-11-04: "We have 2, need at least 9" with two bots online -- and a bot with her own shelter
  // "completed" it at once and proposed it again, 209 times a day.
  let world = residenceWorld({ online: ['Amy', 'Babs', 'Steve'], shelters: [
    { base: new V3(0, 64, 0), bed: true, chest: true }, { base: new V3(10, 64, 0), bed: true, chest: true }] });
  const c = vm.createContext({ BOT_USERNAMES: new Set(['Babs', 'Amy', 'Mark', 'Luke', 'Mayor', 'Bob', 'Nell', 'Wade', 'Dale']),
    SHELTER_ROOM: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]], Math,
    countUsableNearHome: () => 1, countNearHome: () => 1, getAchievements: () => ['bred:cow'],
    fleetHasReachedIronTools: () => false, communalShelterSatisfied: () => true,
    countQualifyingSheltersNearHome: () => world.bases.length, hasOwnShelterWithBed: () => true,
    completeSheltersNearHome: () => world.bases, wouldBlockAccess: () => null,
    shelterHasBed: (b) => c.bot.isABed(c.bot.blockAt(b)) });
  const use = (w) => { world = w; c.bot = w.bot; };
  use(world);
  vm.runInContext(slice(index, 'function activeBotCount', '// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1 --'), c);
  vm.runInContext(between(index, 'function builderPriorityCandidates', 'function nextBuilderPriority('), c);
  vm.runInContext(between(index, 'function builderPriorityItemSatisfied', '// Direct request, 2026-09-13'), c);
  const capacity = () => c.builderPriorityCandidates().find((x) => x.name === 'shelter_capacity');
  assert.equal(capacity(), undefined, 'two bots online, two residences with a bed each: nothing to build');
  assert.equal(c.builderPriorityItemSatisfied('shelter_capacity'), true);
  use(residenceWorld({ online: ['Amy', 'Babs'], shelters: [{ base: new V3(0, 64, 0), bed: true, chest: true }] }));
  assert.match(capacity()?.directive ?? '', /1 bed for 2 active bots/, 'one bed for two active bots: a new shelter');
  assert.equal(c.builderPriorityItemSatisfied('shelter_capacity'), false, 'satisfied and the checklist agree');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
