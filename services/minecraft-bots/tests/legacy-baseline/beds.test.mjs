// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/beds-1.test.mjs and tests/unit/beds-2.test.mjs (26 old
// checks total) against the Mindcraft-ported architecture. See
// services/minecraft-bots-archive-11-2026/ for the archived "best past implementation" this
// measures against, and MINECRAFT_BOTS_RESTART_PLAN.md for why the goal/priority engine those old
// checks mostly tested was deliberately not re-created.
//
// skills.goToBed (Mindcraft-ported) is the ONLY surviving bed-related capability: it USES the
// single nearest bed it can find. Everything about autonomously choosing a bed SITE, BUILDING a
// bed or shelter, claiming/retrying beds, or routing a free-text goal to any of that is archived
// with shelter-goals.js/goal-tick.js/priorities.js -- those checks are test.todo with a reason
// naming the removed mechanism. shelter.js's own living-space geometry (refreshLivingSpace,
// coveredInterior, holesIn) is kept and real-tested directly where a bed is the anchor.
//
// Run: node --test services/minecraft-bots/tests/legacy-baseline/beds.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { goToBed } from "../../skills.js";
import { refreshLivingSpace, holesIn, posKey } from "../../shelter.js";
import { V3, makeBot } from "./_mockbot.mjs";

// shelter.js's bedAnchors()/doorAnchors() pass `matching` as an array of registry block ids once
// bot.registry.blocksByName is populated (the fast path), falling back to a predicate function
// only when it's missing -- a mock findBlocks() has to accept either, the same duality
// tests/unit/_harness.mjs's own blockWorld() already handled for the old code. Every mock bed
// below registers as id 1, so an id-array match just checks for a 1.
const isBedMatch = (matching) => (typeof matching === "function"
  ? matching({ name: "white_bed" })
  : [].concat(matching).includes(1));

// A world with zero, one or two beds, each at a given position, plus which ones (by position key)
// the "server" refuses to sleep in -- same shape as tests/unit/_harness.mjs's bedWorld(), wired to
// the real skills.goToBed() instead of a vm-sliced copy of the old action.
function bedWorld({ beds = [], occupied = [] } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const occupiedSet = new Set(occupied.map(key));
  const blocks = new Map(beds.map((p) => [key(p), { name: "white_bed", position: p, getProperties: () => ({ facing: "south", part: "head" }) }]));
  const bot = makeBot({
    entity: { position: new V3(0, 64, 0), yaw: 0 },
    findBlocks: ({ matching, count }) => beds
      .filter((p) => matching({ name: "white_bed" }))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      .slice(0, count),
    blockAt: (p) => blocks.get(key(p)) ?? { name: "air", position: p, getProperties: () => ({}) },
  });
  bot.pathfinder.goto = async () => {};
  bot.sleep = async (block) => {
    if (occupiedSet.has(key(block.position))) throw new Error("occupied.");
    setTimeout(() => { bot.isSleeping = true; setTimeout(() => { bot.isSleeping = false; bot.emit("wake"); }, 5); }, 0);
  };
  return bot;
}

// ---- beds-1.test.mjs (16 checks) --------------------------------------------------------------

test.todo('[legacy:beds-1] Survival (Tier 1): weapon, then her own sheltered bed, then food, then armor, then null -- NOT PORTED: nextSurvivalPriority() and the whole priority-tier engine (priorities.js) are archived; the new decision loop has no priority tiers at all, it asks muse what to do next every tick.');

test.todo('[legacy:beds-1] Tier 2: builderPriorityCandidates merges beds+shelter, and claims the way the others do -- NOT PORTED: builderPriorityCandidates()/the builder-item claim mechanism are archived with priorities.js.');

test.todo('[legacy:beds-1] Tier 2: a beehive is only proposed once honeycomb is held or a nest/hive is known nearby -- NOT PORTED: same archived priorities.js candidate list.');

test('[legacy:beds-1] Beds: goToBed uses the nearest bed; an occupied nearest bed with a free alternative nearby currently FAILS, not retried', async () => {
  // Old claim (actions.js's "sleep"): try every usable bed nearest-first, skip occupied ones, no
  // cap, no claim file ever written. skills.goToBed (Mindcraft) only ever looks at the SINGLE
  // nearest bed (findBlocks({..., count: 1})) and calls bot.sleep() on it with no retry and no
  // try/catch -- a rejection (occupied) propagates straight out.
  const near = new V3(1, 64, 0);
  const far = new V3(5, 64, 0);
  const bot = bedWorld({ beds: [near, far], occupied: [near] });
  await assert.rejects(goToBed(bot), /occupied/,
    "REGRESSION: the nearest bed is occupied and there is no retry onto the free one farther away");
});

test('[legacy:beds-1] Beds: no bed anywhere still fails cleanly, without throwing', async () => {
  // The one part of the old claim that still holds exactly: `if (beds.length === 0) return false`
  // is unchanged in skills.goToBed.
  const bot = bedWorld({ beds: [] });
  assert.equal(await goToBed(bot), false);
});

test.todo('[legacy:beds-1] Beds: nothing nearby falls back to a remembered bed, and travels to use it -- NOT PORTED: findRememberedLocation()/visitRememberedSpot() depended on the archived longterm.js/rag-backend.js memory; the new bounded in-process history has no remembered-location concept.');

test.todo('[legacy:beds-1] Beds: "bed" is crafted in the colour she has 3 wool of, white when she has none -- NOT PORTED: actions/craft.js\'s own colour-by-held-wool choice is archived; skills.craftRecipe (Mindcraft) crafts the exact item name it is given, with no automatic colour selection.');

test.todo('[legacy:beds-1] Beds: a bed spot is two open, supported cells with room to stand behind, off spawn, beside other beds -- NOT PORTED: findBedSites() (site selection for PLACING a new bed) is archived; goToBed only ever uses an existing bed, it never places one.');

test.todo('[legacy:beds-1] Beds: bed goals are recognised; going to bed and bedrock are not -- NOT PORTED: BED_WORDS free-text goal-type matching is part of the archived goal engine; the new decision loop never parses free text into a goal type at all.');

test.todo('[legacy:beds-1] Beds: a bed goal loots wool once, gets the rest from sheep, makes planks from her logs, crafts, places, then is done -- NOT PORTED: the whole multi-step bed-acquisition goal runner (goal-runners.js) is archived.');

test.todo('[legacy:beds-1] Beds: a bed in hand builds at home when near, but on the spot when far from both home and any remembered bed -- NOT PORTED: bedStep()\'s placement-site decision is archived with the goal engine.');

test.todo('[legacy:beds-1] Beds: a night with no bed gives an idle bot a bed goal for the morning, and never replaces a goal -- NOT PORTED: night-survival.js (the whole idle/night goal-assignment mechanism) is archived.');

test.todo('[legacy:beds-1] Communal shelter: structure completeness and bed-count verification, mocked -- NOT PORTED: residencePlan()/communal verification are archived with the goal/curriculum engine (see also tests/legacy-baseline/shelter.test.mjs for the general, non-communal survivor of this mechanism).');

// ---- beds-2.test.mjs (10 checks) --------------------------------------------------------------

test.todo('[legacy:beds-2] Shelter goal: a finished shelter gets a bed put in it; a build nobody can see is a failure -- NOT PORTED: runShelterGoal()/residencePlan() are archived with shelter-goals.js.');

test.todo('[legacy:beds-2] Shelters: a shelter goal gets materials (planks from her logs), builds on its site, then puts her bed in it -- NOT PORTED: same archived shelter-goals.js pipeline.');

test.todo('[legacy:beds-2] Beds: a spot with a bot standing in it is skipped, and a refused spot is not retried -- NOT PORTED: findBedSites() placement-site selection is archived; nothing currently chooses or places a bed site.');

test.todo('[legacy:beds-2] Beds: given the room cells, a bed goes in that room even when another covered space counts as a shelter -- NOT PORTED: same archived findBedSites() site preference.');

test.todo('[legacy:beds-2] Beds: always placed inside an existing shelter when one has room, else falls back as before -- NOT PORTED: same archived findBedSites() placement pipeline.');

test('[legacy:beds-2] Shelter walls: a bed under open sky protects nothing, and the cell cap bounds the fill', () => {
  // shelter.js's own header is explicit that this still holds by design: "A bed under open sky
  // fills nothing and gets no walls, so this can never protect bare terrain just because somebody
  // slept there." Exercised directly against the real, kept refreshLivingSpace()/coveredInterior().
  const openSky = makeBot({
    registry: { blocksByName: { white_bed: { id: 1 }, cobblestone: { id: 2 } }, blocksArray: [] },
    blockAt: () => ({ name: "air", boundingBox: "empty" }),
    // shelter.js's bedAnchors() passes `matching` as an array of registry ids when blocksByName is
    // populated (the common case, as here), a predicate function only as its no-registry fallback.
    findBlocks: ({ matching }) => (isBedMatch(matching) ? [new V3(0, 64, 0)] : []),
  });
  const space = refreshLivingSpace(openSky, new V3(0, 64, 0));
  assert.equal(space.inside.size, 0, "no roof overhead -- nothing is recognized as indoors");
  assert.equal(space.cells.size, 0, "and so nothing at all is protected");

  // Cell cap: a large flat roofed hall must not grow the fill without bound.
  const hallSize = 40; // comfortably more than one SHELL_RADIUS (8) reaches on its own in any one
  // direction, but the repeated flood-fill from many internal steps can still reach the cap.
  const solidAt = new Set();
  for (let x = -hallSize; x <= hallSize; x++) {
    for (let z = -hallSize; z <= hallSize; z++) solidAt.add(`${x},67,${z}`); // one continuous roof
  }
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) solidAt.add(`${x},63,${z}`); // small floor patch
  const hall = makeBot({
    registry: { blocksByName: { white_bed: { id: 1 } }, blocksArray: [] },
    blockAt: (p) => ({ name: solidAt.has(`${p.x},${p.y},${p.z}`) ? "cobblestone" : "air",
      boundingBox: solidAt.has(`${p.x},${p.y},${p.z}`) ? "block" : "empty" }),
    findBlocks: ({ matching }) => (isBedMatch(matching) ? [new V3(0, 64, 0)] : []),
  });
  const hallSpace = refreshLivingSpace(hall, new V3(0, 64, 0));
  assert.ok(hallSpace.inside.size <= 256, `the fill is bounded (SHELL_MAX_CELLS), got ${hallSpace.inside.size}`);
});

test('[legacy:beds-2] Shelter rooms (general): the floor cell in a corner beside a bed is room, not a hole', () => {
  // shelter.js 1.3.3's own fix, directly exercised: a bed, chest or door no longer counts as a
  // solid neighbour, so the floor cell in the corner next to a bed is not flagged as a breach.
  const solidAt = new Set();
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) { solidAt.add(`${x},63,${z}`); solidAt.add(`${x},67,${z}`); }
  }
  for (let dx = -1; dx <= 1; dx++) for (let dy = 64; dy <= 66; dy++) {
    if (dx !== 0) solidAt.add(`${dx},${dy},-1`);
  }
  const bedPos = new V3(-1, 64, 1); // corner floor cell, with a bed at (0, 64, 1)
  const w = makeBot({
    registry: { blocksByName: { white_bed: { id: 1 } }, blocksArray: [] },
    blockAt: (p) => {
      const k = `${p.x},${p.y},${p.z}`;
      // bedAnchors() -> bedHalves(block) reads block.position to find the bed's other half --
      // every returned block needs one, not just the ones solidAt actually names.
      if (p.x === 0 && p.y === 64 && p.z === 1) return { name: "white_bed", position: p, boundingBox: "block", getProperties: () => ({ facing: "south", part: "head" }) };
      return { name: solidAt.has(k) ? "cobblestone" : "air", position: p, boundingBox: solidAt.has(k) ? "block" : "empty" };
    },
    findBlocks: ({ matching }) => (isBedMatch(matching) ? [new V3(0, 64, 1)] : []),
  });
  const space = refreshLivingSpace(w, new V3(0, 64, 1));
  const holes = holesIn(w, space.inside);
  assert.equal(holes.has(posKey(bedPos)), false, "the corner floor cell beside the bed is not a false hole");
});

test.todo('[legacy:beds-2] Beds: a spot the server refuses is not retried on a later goal tick -- NOT PORTED: the goal-tick retry mechanism is archived; there is no multi-tick goal object at all in the new decision loop.');

test.todo('[legacy:beds-2] place_bed: a bed spot she couldn\'t reach is reported as unreachable, not as a server refusal -- NOT PORTED: place_bed (actions/place-bed.js, placing a NEW bed) is archived; goToBed never places a bed.');

test.todo('[legacy:beds-2] Builder: shelter_capacity counts the bots in the game -- beds for the active bots, each in a residence -- NOT PORTED: residencePlan()/home-scan.js\'s residence model is archived; nothing currently plans bed-per-bot capacity.');
