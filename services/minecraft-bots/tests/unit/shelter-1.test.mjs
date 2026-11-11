// Version: 1.0.0
//
// Unit checks: shelter detection, building and repair (part 1 of 2).
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/shelter-1.test.mjs

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { actions, index, swim, arbiter, V3, between, context, shelter, sleep, passed, check, farmGoalSrc, shelterFns, shelterWorld, room, slice, passedCount } from './_harness.mjs';


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
  // 2026-10-30: Babs held 2 spruce (first slot) beside 6 birch -- "spruce_door" failed all night.
  assert.equal(c.doorItemFor({ inventory: { items: () => [{ name: 'spruce_planks', count: 2 }, { name: 'dirt', count: 9 },
    { name: 'birch_planks', count: 6 }, { name: 'oak_planks', count: 1 }] } }), 'birch_door', 'the wood she has the most planks of');
  const build = actions.slice(actions.indexOf('case "build": {'), actions.indexOf('case "build_pen": {'));
  assert.match(build, /buildMovements\.scafoldingBlocks = \[\];/, 'no scaffolding: she pillared up inside her own shelter');
  assert.match(build, /buildMovements\.allow1by1towers = false;/);
  assert.match(build, /finally \{\s+if \(bot\.pathfinder\.movements === buildMovements\) bot\.pathfinder\.setMovements\(sharedMovements\);/);
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
      blockAt: (p) => (doors.has(key(p)) ? { name: 'oak_door', boundingBox: 'empty', getProperties: () => ({ half: 'lower', facing: 'south' }) }
        : { name: 'x', boundingBox: solid.has(key(p)) ? 'block' : 'empty' }) };
    const h = vm.createContext({ bot: mockBot, Math, BOT_USERNAMES: new Set(['amy']), BUILDER_PRIORITY_RADIUS: 6,
      communalShelterPositions: s.communalShelterPositions, communalDoorwayPosition: s.communalDoorwayPosition });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') + between(actions, 'export function isShelterDoor(', 'export function shelterPositions(') +
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
      : doors.some((d) => p.equals(d)) ? { name: 'oak_door', boundingBox: 'empty', getProperties: () => ({ half: 'lower', facing: 'south' }) }
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
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') + between(actions, 'export function isShelterDoor(', 'export function shelterPositions(') +
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
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') + between(actions, 'export function isShelterDoor(', 'export function shelterPositions(') +
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
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') + between(actions, 'export function isShelterDoor(', 'export function shelterPositions(') +
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
      : doors.has(k(p)) ? { name: 'oak_door', boundingBox: 'empty', getProperties: () => ({ half: 'lower', facing: 'south' }) }
      : { name: 'x', boundingBox: p.y <= 64 || solid.has(k(p)) ? 'block' : 'empty' });
    return { spawnPoint, isABed: (b) => b.name === 'white_bed', blockAt,
      findBlocks: doorFinder(shelters.map((sh) => sh.doorAt).filter(Boolean), blockAt) };
  };
  const count = (bot) => {
    const h = vm.createContext({ bot, Math, shelterPositions: s.shelterPositions, doorwayPosition: s.doorwayPosition,
      SHELTER_ROOM: vm.runInContext('SHELTER_ROOM', s), BUILDER_PRIORITY_RADIUS: 24 });
    vm.runInContext(between(swim, 'export function isDoorway(', 'export function isOpenDoorOrGate(') + between(actions, 'export function isShelterDoor(', 'export function shelterPositions(') +
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
