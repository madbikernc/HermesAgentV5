// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/chests-1.test.mjs and tests/unit/chests-2.test.mjs
// against the Mindcraft-ported architecture (skills.js/world.js/shelter.js). See
// services/minecraft-bots-archive-11-2026/ for the archived "best past implementation" this
// measures against. Run: node --test services/minecraft-bots/tests/legacy-baseline/chests.test.mjs
//
// Behavioral checks (real test(), pass/fail counted in the baseline score) port the OLD
// capability claim onto the NEW real modules. Mechanism checks that depend on removed
// architecture (goal queue, priority tiers, file-based claims, known_chests.json/rag-backend.js
// memory, curriculum/RAG evidence, old per-role dedicated runners) are test.todo(name) -- excluded
// from the score, but never silently dropped: the name states exactly what old mechanism is gone
// and why re-creating it verbatim isn't the goal.
//
// Four of the checks below assert against skills.js's own SOURCE TEXT rather than executing it.
// putInChest/takeFromChest/viewChest all call goToPosition(), which constructs a real
// swim-movements.js Movements instance against the live bot/world -- not safely mockable here
// without risking a false crash from an under-specified mock (this suite cannot run node locally
// to verify first). This mirrors the precedent already in tests/unit/faults.test.mjs ("index.js
// runs every periodic check through guardedInterval") and tests/unit/services.test.mjs's chat-site
// scan, both of which assert against source text for the same reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as shelter from "../../shelter.js";
import * as world from "../../world.js";
import { V3, makeBot } from "./_mockbot.mjs";
import minecraftData from "minecraft-data";

const root = fileURLToPath(new URL("../../", import.meta.url));
const skillsSrc = readFileSync(root + "skills.js", "utf8");

// A flat world of named blocks for shelter.js's own geometry checks -- the real functions, not a
// mock of them. Ported from tests/unit/_harness.mjs's blockWorld(), trimmed: shelter.js falls back
// to bot.isABed()/approachCells() heuristics when bot.registry.blocksByName has no matching entry,
// so no populated registry or light data is needed for these two checks.
function blockWorld({ groundY = 63 } = {}) {
  const at = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const bot = {
    registry: { blocksByName: {} },
    isABed: (b) => !!b?.name?.endsWith("_bed"),
    entity: { position: new V3(0, 64, 0) },
    blockAt(p) {
      const spec = at.get(key(p));
      if (spec) {
        return { name: spec.name, position: p, boundingBox: spec.name === "air" ? "empty" : "block",
          getProperties: () => spec.props || {} };
      }
      const stone = p.y <= groundY;
      return { name: stone ? "stone" : "air", position: p, boundingBox: stone ? "block" : "empty",
        getProperties: () => ({}) };
    },
    findBlocks({ matching, point, maxDistance = 32, count = 16 }) {
      const origin = point || bot.entity.position;
      const out = [];
      for (const k of at.keys()) {
        const [x, y, z] = k.split(",").map(Number);
        const pos = new V3(x, y, z);
        if (pos.distanceTo(origin) > maxDistance) continue;
        if (matching(bot.blockAt(pos))) out.push(pos);
        if (out.length >= count) break;
      }
      return out;
    },
  };
  const place = ([x, y, z], name, props) => at.set(`${x},${y},${z}`, { name, props });
  const door = ([x, y, z], name = "oak_door", facing = "north") => {
    place([x, y, z], name, { facing, half: "lower", open: false });
    place([x, y + 1, z], name, { facing, half: "upper", open: false });
  };
  const bed = ([x, y, z]) => {
    place([x, y, z], "white_bed", { facing: "south", part: "head" });
    place([x, y, z - 1], "white_bed", { facing: "south", part: "foot" });
  };
  return { bot, place, door, bed };
}

// ---- real behavioral checks --------------------------------------------------------------------

test('[legacy:chests] takeFromChest withdraws from multiple matching slots to reach the requested total (MB-17, narrowed)', () => {
  // The old tryTakeFromThisChest took a LIST of acceptable item names ("oak_log" OR "birch_log"
  // satisfy the same request) -- takeFromChest(bot, itemName, num) takes exactly one itemName, so
  // that breadth has no current equivalent. What does carry over, and still runs in the real
  // function today: withdrawing from more than one matching slot of THE SAME item to reach the
  // requested count. Verified against source rather than executed, per the file header above.
  const body = skillsSrc.slice(skillsSrc.indexOf("export async function takeFromChest("),
    skillsSrc.indexOf("export async function viewChest("));
  assert.match(body, /matchingItems\.reduce/, "sums availability across every matching slot");
  assert.match(body, /for \(const item of matchingItems\)/, "withdraws from each matching slot in turn, not just the first");
});

test('[legacy:chests] chest lookups reach 128 blocks like the old fleet, not 32', () => {
  // 2026-11-07 (actions.js 1.106.0): chest searches were widened to CHEST_SEARCH_RADIUS=128 after
  // a real fleet regression (bots gave up on chests well within walking distance). skills.js's
  // putInChest/takeFromChest/viewChest all call world.getNearestBlock(bot, "chest", 32) --
  // unchanged from mineflayer-pathfinder's own 16-32 block default-of-convenience, not the fleet's
  // own tuned 128. Expected to fail now: this is a real, trackable capability regression, not a
  // removed mechanism -- a wider search is still exactly what you'd want here.
  const calls = [...skillsSrc.matchAll(/getNearestBlock\(bot, ["']chest["'], *(\d+)\)/g)].map((m) => Number(m[1]));
  assert(calls.length >= 3, "expected putInChest/takeFromChest/viewChest to each call getNearestBlock for \"chest\"");
  assert(calls.every((d) => d >= 128), `expected every chest lookup to reach at least 128 blocks, found: ${calls.join(", ")}`);
});

test('[legacy:chests] a chest search that just came up empty is not repeated from the same spot', () => {
  // The old actions.js kept a short-lived per-position miss cache (CHEST_MISS_TTL_MS) so a failed
  // chest search wasn't immediately retried from the same spot for the same item. No such cache
  // exists in skills.js today -- every call to putInChest/takeFromChest/viewChest searches fresh.
  // Expected to fail now, for the same reason as the radius check above: a real, worth-fixing gap,
  // not a deliberately dropped mechanism.
  assert.match(skillsSrc, /MISS_TTL|missCache|lastMiss/i,
    "expected some form of chest-search-miss cache in skills.js; found none");
});

test('[legacy:chests] shelter.wouldBlockAccess refuses a chest lid, a doorway, and the last way up to a bed', () => {
  const w = blockWorld();
  w.place([0, 64, 0], "chest");
  w.place([3, 64, 0], "barrel");
  const lid = shelter.wouldBlockAccess(w.bot, new V3(0, 65, 0));
  assert(lid && lid.fixture === "chest" && /lid/.test(lid.reason), `the chest lid is refused: ${JSON.stringify(lid)}`);
  assert.equal(shelter.wouldBlockAccess(w.bot, new V3(3, 65, 0)), null, "a barrel opens with a block above it");

  w.door([0, 64, 6]);
  const through = shelter.wouldBlockAccess(w.bot, new V3(0, 64, 5));
  assert(through && /way through/.test(through.reason), `in front of the door: ${JSON.stringify(through)}`);
  assert.equal(shelter.wouldBlockAccess(w.bot, new V3(1, 64, 6)), null, "the door's own jamb is supposed to be solid");

  w.bed([10, 64, 0]);
  const around = [[11, 64, 0], [9, 64, 0], [10, 64, 1], [11, 64, -1], [9, 64, -1]];
  assert.equal(shelter.wouldBlockAccess(w.bot, new V3(11, 64, 0)), null, "plenty of room round the bed still");
  for (const cell of around) w.place(cell, "cobblestone");
  const last = shelter.wouldBlockAccess(w.bot, new V3(10, 64, -2));
  assert(last && /_bed$/.test(last.fixture) && /last way/.test(last.reason), `the last way up: ${JSON.stringify(last)}`);
});

test('[legacy:chests] shelter.findAccessObstructions finds a blocked lid and both halves of a double chest', () => {
  const w = blockWorld();
  w.place([0, 64, 0], "chest", { type: "left", facing: "north" });
  w.place([1, 64, 0], "chest", { type: "right", facing: "north" });
  w.place([1, 65, 0], "cobblestone"); // over the far half -- blocks the whole double chest in vanilla
  const found = shelter.findAccessObstructions(w.bot, new V3(0, 64, 0), 8, () => true);
  assert.equal(found.length, 1, `exactly the one block in the way: ${JSON.stringify(found)}`);
  assert.deepEqual([found[0].position.x, found[0].position.y, found[0].position.z], [1, 65, 0]);
  assert.equal(found[0].name, "cobblestone");
});

test('[legacy:chests] shouldPlaceTorch skips a spot within 6 blocks of a real torch (no frozen block.light to go stale)', () => {
  // 2026-11-22 direct report ("they waste resources by putting torches too close together"): the
  // old checkLighting/light_area read a frozen block.light snapshot that never updated after chunk
  // load. The new mechanism (world.shouldPlaceTorch, driven by modes.js's torch_placing mode) never
  // reads block.light at all -- it looks for a real torch/wall_torch within 6 blocks via
  // bot.findBlocks, live every call. This records that the simpler new mechanism never had that bug
  // class to begin with; a genuinely passing legacy-equivalent check.
  // mcdata.js (skills.js/world.js's own data shim) resolves block/item ids from the real
  // minecraft-data package keyed on bot.version, not from bot.registry -- the mock bot needs a
  // real version and the real torch block id, not a made-up one, or getBlockId() silently
  // mismatches and the test would pass for the wrong reason.
  const mcVersion = "1.20.4";
  const data = minecraftData(mcVersion);
  const torchId = data.blocksByName.torch.id;
  const bot = makeBot({ version: mcVersion, modes: { isOn: () => true }, interrupt_code: false });
  const torchPos = new V3(2, 64, 0);
  bot.findBlocks = ({ matching, maxDistance }) =>
    matching({ name: "torch", type: torchId }) && torchPos.distanceTo(bot.entity.position) <= maxDistance ? [torchPos] : [];
  bot.blockAt = (p) => (p && p.distanceTo(torchPos) < 0.5 ? { name: "torch" } : { name: "air" });
  bot.inventory.findInventoryItem = () => ({ name: "torch", count: 4 });
  assert.equal(world.shouldPlaceTorch(bot), false, "a real torch 2 blocks away suppresses another placement");
});

// ---- not ported: removed architecture, named so the gap is never silent -----------------------

test.todo('[legacy:chests] EFF storage pauses after only full/obstructed chests, resumes on success -- NOT PORTED: storageBlockedUntil backoff lived in the old goal/priority engine (index.js, archived); the new decision loop has no backoff state machine');
test.todo('[legacy:chests] Tier 2: checkSurplusSharing runs on a standing cadence -- NOT PORTED: priority-tier cadence checks (priorities.js) are archived; no tier concept in modes.js');
test.todo('[legacy:chests] MB-02 flee restores shared movements only if its own copy is still active -- NOT PORTED: the generic performAction dispatcher and its per-action movements-safety wrapper (actions.js\'s "flee" handler) are archived; skills.js\'s avoidEnemies does not coordinate with arbiter preemption the same way');
test.todo('[legacy:chests] MB-09 inventory storing keeps the active goal\'s items and recipe inputs -- NOT PORTED: goalReservedItems() depends on the old currentGoal object (index.js, archived); no persistent goal object exists');
test.todo('[legacy:chests] Builder claims: the shared store falls back to this host\'s own file -- NOT PORTED: the file-based builder-item-claims mechanism (actions.js) is archived; no claims system exists');
test.todo('[legacy:chests] Resource-gathering override: weaponStep tries a chest first, else gathers+crafts -- NOT PORTED: the dedicated weapon-acquisition goal runner (index.js) is archived; the LLM decision loop now makes this call itself, not a deterministic runner');
test.todo('[legacy:chests] Resource-gathering override: toolStep tries a chest first, else gathers+crafts a pickaxe -- NOT PORTED: same dedicated-runner mechanism as weaponStep, archived');
test.todo('[legacy:chests] Builder placement registers a RAG note on success -- NOT PORTED: rag-backend.js and the whole RAG/long-term memory system are archived; replaced by bounded in-process history with no persistent notes');
test.todo('[legacy:chests] Food: loot "food"/"seeds" asks chests via LOOT_GROUPS -- NOT PORTED: the generic action-dispatch LOOT_GROUPS table (actions.js) is archived; skills.js has no generic "loot" action, only specific functions');
test.todo('[legacy:chests] Food: a hungry bot with nothing to eat fetches from a chest, then eats -- NOT PORTED: checkHunger() (upkeep-inventory.js) is archived; no proactive hunger-management hook in modes.js, the LLM must notice food in its own stats');
test.todo('[legacy:chests] Food: starving with no food anywhere, she hunts, then rotten flesh as a last resort -- NOT PORTED: same checkHunger() mechanism as above, archived');
test.todo('[legacy:chests] Farm goals: with empty chests, the hoe\'s planks come from a tree and seeds from grass -- NOT PORTED: the farm goal runner\'s chest-then-gather fallback orchestration (goal-runners.js) is archived; skills.js\'s tillAndSow is a bare primitive with no fallback chain');
test.todo('[legacy:chests] Inventory: full with no chest at home, she makes and places one -- NOT PORTED: makeHomeChest() (upkeep-inventory.js) is archived; no inventory-full response exists in the new decision loop or modes.js');
test.todo('[legacy:chests] Ranch goals: chicken feed comes from grass when no chest has any -- NOT PORTED: the ranch goal runner (goal-runners.js) is archived');
test.todo('[legacy:chests] Mine: a chest holding fewer than needed is taken, and the shortfall is still mined -- NOT PORTED: the generic "mine" action\'s chest-then-mine-shortfall orchestration (actions.js) is archived; skills.js\'s collectBlock is a bare primitive with no chest-first check (collectBlock itself is covered in the gathering legacy-baseline file)');
test.todo('[legacy:chests] Torches: a trail torch never hangs on a chest, glass or leaves -- NOT PORTED: the wall-reference torch-trail logic (tunneling.js, canHoldTorch/trailTorchSpot) is archived; world.shouldPlaceTorch only decides WHEN to place (see the passing check above), not WHICH surface, and skills.placeBlock\'s generic reference-block picking is not torch-aware');
test.todo('[legacy:chests] Torches: tops up from carried coal, falls back to a chest, backs off after failure -- NOT PORTED: checkTorchSupply() (upkeep-world.js) is archived; no proactive torch-supply management exists, only the reactive shouldPlaceTorch check');
test.todo('[legacy:chests] Torches: no coal and no chest torch -- mines some coal instead of waiting out the backoff -- NOT PORTED: same checkTorchSupply() mechanism as above, archived');
test.todo('[legacy:chests] Light area: the dark-spot search and its placement recheck use real nearby light -- NOT PORTED: the home-area sweep (actions/light-area.js) is archived; only the per-tick shouldPlaceTorch check remains, with no area sweep');
test.todo('[legacy:chests] Inventory: full with every chest at home full, plain surplus is dropped -- NOT PORTED: checkInventoryFull()\'s surplus-triage logic (index.js) is archived; no inventory-full response exists in the new architecture');
test.todo('[legacy:chests] Chests: a teammate\'s new chest clears a stale "every chest full" reading -- NOT PORTED: the fleet-coordination "chest_built" broadcast/listener (incoming.js, fleet-coordination.js) is archived');
test.todo('[legacy:chests] Residences: a bed for each active bot, filling empty shelters before building a new one -- NOT PORTED: the residence/shelter goal orchestration (shelter-goals.js, home-scan.js) is archived; no residency-planning concept exists');
test.todo('[legacy:chests] Residences: a found room (a village house) counts toward the housing tally -- NOT PORTED: same residencePlan()/home-scan.js mechanism as above, archived');
test.todo('[legacy:chests] Trash: a near-broken weapon and rotten flesh go into visible lava -- NOT PORTED: checkTrash() (index.js) is archived; no proactive trash-disposal routine exists');
test.todo('[legacy:chests] Chests: an item is stored with its own kind before the nearest empty chest -- NOT PORTED: the known_chests.json content-aware ranking (rankStoreChests/itemFamily, rag-backend.js-backed memory) is archived; putInChest always targets the single nearest chest with no contents awareness');
test.todo('[legacy:chests] Chests: a split kind is moved from the smaller pile to the larger via consolidation -- NOT PORTED: findConsolidation() depends on the same archived known_chests.json memory');
test.todo('[legacy:chests] Chests: looking into a chest that shares a kind with another leaves a consolidation hint -- NOT PORTED: same known_chests.json memory system, archived');
test.todo('[legacy:chests] Chests: loot and chest-first fallback walk far chests in 40-block hops -- NOT PORTED: hopToward()\'s multi-hop long-distance walk (actions.js) is archived; the 128-block radius claim itself is covered above as a real, currently-failing check');
test.todo('[legacy:chests] Chests: a plain "look in a chest" skips one the registry already knows is fresh -- NOT PORTED: the known-chests freshness registry (CHEST_INSPECT_FRESH_MS, rag-backend.js-backed) is archived');
test.todo('[legacy:chests] Chests: store walks past the nearest empty chest to the one already holding that kind -- NOT PORTED: same content-aware chest selection as the ranking check above, archived; putInChest has no selection logic at all');
test.todo('[legacy:chests] Chests: consolidating moves the smaller pile in as full stacks -- NOT PORTED: the "consolidate_chests" action (action-chests.js) is archived; no multi-chest consolidation feature exists in skills.js');
