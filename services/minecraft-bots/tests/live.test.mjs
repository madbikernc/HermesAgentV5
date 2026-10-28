// Version: 1.24.0
//
// 1.24.0 (2026-10-28, direct report: wood gathered "in fits and starts", the block healing between
// swings): new scenario felling a 4-log trunk in one "mine" with the think window squeezed to 1ms,
// so the path-timeout-mid-dig case collectBlocks() (actions.js 1.95.0) now survives is forced.
//
// 1.23.0 (2026-10-27, first real runs of 1.22.0's new scenarios, against the real server): three
// real gaps found and fixed, all in the scenarios themselves, not the fix they test -- each only
// surfaced by actually running against the real server, not by reading the code. The chest
// scenario (also 1.22.0) needed no fix: chestObstructed()'s "lid" rule is a direct block-above
// check, not a reachability simulation, so it worked first try, every time.
//
// Shelter: the new crowded-core scenario didn't fit the ~20x20 test arena -- a symmetric block
// cube around an arena-centred home leaves no room for a wider site before hitting the glass
// walls in every direction. Fixed by putting home off-centre so there's real open room on one
// side (see the scenario's own comment for the exact geometry).
//
// Furnace, three attempts: (1) a single bedrock layer immediately around the furnace does not
// block mineflayer's reach at all -- reach is straight-line, not path-following, and the bot
// stood on the one-block cap and opened it fine three times. (2) Buried it deep instead (large
// margin on every side), which created a WORSE bug: resetTester() spawns the tester at the
// arena's own centre, which that large box also happened to enclose -- RCON's fill doesn't push
// a standing player out of newly-solid blocks, so the bot ended up glitched, overlapping bedrock,
// and "reach" from inside a glitched state proved nothing. Fixed the entombment (explicit
// separation, tester teleported well clear first) -- but then, running as part of the full suite
// rather than isolated, it STILL got through on attempts 2-3 after a real attempt-1 failure
// ("Took too long to decide path to goal!"). Checked mineflayer-pathfinder's own source directly
// rather than guess why: bedrock IS correctly excluded from digging (blocksCantBreak is built
// from minecraft-data's diggable flag, which is false for bedrock, regardless of this fleet's
// own additional hardness-based exclusions) -- so a dig-through-bedrock miscalculation is ruled
// out, not just unconfirmed. The real cause is still unknown (plausibly some earlier scenario's
// leftover structure -- resetTester()'s own clear only covers y+1..y+4, not every height a big
// communal-shelter scenario might reach -- giving a real, undug walkable route near the burial
// that isolation alone doesn't hit); not worth chasing further given (3) below sidesteps the
// question entirely. (3) Lava instead, which this fleet's own movement code already treats as
// unsafe/unwalkable terrain outright (see the `b.name !== "lava"` checks already elsewhere in
// this file's own source), not a cost to weigh -- genuinely no path to find, fast and every time,
// isolated or full-suite. Bumped the scenario's own attempt count from 3 to 5 too:
// noteUtilityOutcome() resets the streak on any single success, so one flake anywhere in the run
// would have silently passed before.
//
// Full suite, confirmed clean on a dedicated run after all three fixes: 34/34 scenarios passed
// on dgx-spark against the live bot-sandbox server.
//
// 1.22.0 (2026-10-27, investigating "why don't furnaces/chests/shelter get built"): new scenarios
// proving a furnace and a chest sealed/obstructed accumulate real failures until
// isUtilityUsable() (actions.js 1.94.0) reports them broken -- the signal index.js 2.122.0's
// countUsableNearHome() now checks instead of bare existence -- and a shelter site search that
// finds a site farther out once the inner core is crowded. Written but NOT run against the real
// server this pass (no live access from this environment) -- treat as unverified until a real
// run confirms it.
//
// 1.21.0 (2026-10-22, direct follow-up, generalizing 1.20.0's own scenario): new scenario for
// the unified detection path real bots now actually take -- shelterRoomsNear()/holesIn()
// (shelter.js 1.3.0) finding a real hole from real block state, no predetermined geometry on
// the detection side at all, and the new "patch_shelter" action (actions.js 1.93.0) filling
// exactly what was found, against the real server.
//
// 1.20.0 (2026-10-22, direct report: a large communal shelter with holes/missing parts was not
// being repaired as a large structure): new scenario mirroring "Shelter integrity" just above,
// for checkCommunalShelterIntegrity()'s self-repair (index.js 2.120.0) -- a hole knocked in the
// communal structure's wall via RCON is filled back in by the real "build_communal_shelter"
// action, same as a small shelter already was.
//
// 1.19.0 (2026-10-18, direct request): bed claiming removed -- the "destroyed claimed bed moves
// to the nearest unclaimed one" scenario (checkClaimedBed, a bedsDir fixture, placeBed()) is gone
// along with the subsystem it exercised; "places a bed at home" no longer asserts she claimed it.
// MC_BED_CLAIMS_SHARED is no longer read by actions.js, so this file stops setting it.
//
// 1.18.0 (2026-10-11, direct report: a shelter needs "complete walls, ceiling, floor, and at
// least one door..., no other openings..., with at least one bed"; damage "becomes a temporary
// top priority") -- the shelter-build scenario now requires and checks for a real door (not an
// open gap) and a solid floor; new scenario for checkShelterIntegrity()'s self-repair. First live
// run found a real door and a bed could never both fit in the room (still 2x2 at that point) --
// fixed by widening the room to 2x3 (actions.js 1.85.0's own header has the full account), and
// this scenario now places and checks a real bed too, not just the walls and door. The older
// "shelter around her bed" scenario needed more planks (for the door) and more cobblestone (the
// bigger room) in its own setup for the same reason.
//
// 1.17.0 (2026-10-10, direct report: bots "give up on constructed goals without seeming to
// attempt to get the raw materials they lack") -- scenario for get_wool's new wander-before-
// giving-up fix (actions.js 1.84.0): no sheep anywhere, the failure now says she looked.
//
// 1.16.0 (2026-10-09, direct report: bots "repeatedly complain about crafting tables" without
// trying to make one, noticing two standing right next to them, or remembering either's
// location) -- scenario for the recipesFor/recipesAll fix (actions.js 1.83.0): planks but no
// sticks, a real table two blocks away, craft a pickaxe end to end.
//
// Live behavior tests: a dedicated test bot (MC_TEST_USERNAME, default "MBTester") joins the real
// bot-sandbox server and runs the REAL actions.js / arbiter.js / equipment.js code against real
// mobs and items, on an isolated sea-lantern platform far from the fleet's base, set up over RCON
// (tests/live/rcon.py). This is what the offline unit tests can't prove: that mineflayer, the
// plugins and the server actually behave the way the fixes assume.
//
// Run on a Spark node (needs node_modules and the vault/SSH access rcon.py uses):
//   node tests/live.test.mjs                 run every scenario
//   node tests/live.test.mjs combat armor    run only scenarios whose name contains a filter
//
// Chest snapshots, beds and other memory files go to MC_MEMORY_ROOT (default: a fresh temp dir),
// never the fleet's /mnt/hermes-data/minecraft-memory, and the RAG corpora are disabled.
// Every behavior fix that is observable in-world should add a scenario here (see tests/README.md).
//
// Revision History: 1.0.0 | 2026-09-24 | Initial scenarios for MB-01, MB-02/04, MB-07, MB-15.
// 1.1.0 | 2026-09-24 | Scenarios for MB-02 (takeover closes an open window) and MB-08 (place_home).
// 1.2.0 | 2026-09-25 | Chest scenarios (MB-17 mixed stacks, MB-16 stocked chest vs village scouting),
//   safe now that MC_MEMORY_ROOT keeps chest snapshots out of the fleet's known_chests.json.
// 1.3.0 | 2026-09-25 | Beds scenario: a destroyed claimed bed is replaced by the nearest unclaimed one.
// 1.3.1 | 2026-09-25 | MC_BED_CLAIMS_SHARED=false: test bed claims stay out of the shared hermes-memory store.
// 1.4.0 | 2026-09-25 | Door scenarios: out of a sealed room through a closed/open door and an open/closed
//   fence gate, and into one through an open door, on the bots' real movement setup.
// 1.5.0 | 2026-09-25 | Door scenarios also require the door or gate to be shut behind the bot.
// 1.6.0 | 2026-09-25 | Farming/ranching: loot food, a new plot by water, ripe-only harvest + achievement,
//   pen on a site, herd, and a verified birth.
// 1.7.0 | 2026-09-25 | Door scenarios carry cobblestone, the condition that crashed pathfinder's door step.
// 1.8.0 | 2026-09-25 | The ripe-harvest scenario holds an enchanted sword (the enchants/dig crash).
// 1.9.0 | 2026-09-25 | ...and starts with no seeds: it must replant from the drops.
// 1.10.0 | 2026-09-26 | Beds: wool from a sheep, craft "bed" by wool colour, place_bed at home with a claim.
// 1.11.0 | 2026-09-26 | Shelters: build on a site from mixed cobblestone and dirt.
// 1.12.0 | 2026-09-26 | place_bed with a cow standing on the best spot (the server refuses occupied cells).
// 1.13.0 | 2026-09-27 | Shelter scenario: a 4x4 shelter from mixed blocks, then a bed placed inside its room.
// 1.14.0 | 2026-10-07 | Access/shelters/torches: "place" refuses a chest lid, "clear_access" frees a
//   covered chest and the chest then opens, a bot inside a real shelter leaves by its doorway with
//   digging ON, and a torch trail down a sealed dark corridor at a measured spacing.
// 1.15.0 | 2026-10-07 | First live run of the above: chests must be sunk INTO the arena floor for the
//   lid rule to apply; the whole floor layer (sea lanterns, emitLight 15) has to go for the torch
//   scenario, not just the corridor, because litNearby is blind to walls; and the craft step retries,
//   since bot.craft() intermittently loses a race with the server's inventory update.
// 1.16.0 | 2026-10-09 | Craft: a table-needing recipe is detected with the wrong materials in hand
//   (planks, no sticks), so she finds and uses the real table standing nearby instead of failing.
// 1.17.0 | 2026-10-10 | get_wool: with no sheep anywhere, she wanders to look rather than an
//   instant give-up.
// 1.18.0 | 2026-10-11 | Shelter: a real door seals the doorway and a solid floor is required;
//   checkShelterIntegrity() repairs a hole knocked in a built shelter.
// 1.0.1 | 2026-09-24 | First live run fixes: wait for the dead mob's removal, a 1000-HP husk for
//   lost-track (RCON takes ~8s, it used to die first), clear the spare helmet before re-equipping.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolation BEFORE the bot modules load: their memory paths are read at import time.
const ownMemoryRoot = !process.env.MC_MEMORY_ROOT;
process.env.MC_MEMORY_ROOT ||= mkdtempSync(path.join(os.tmpdir(), "mbtest-memory-"));
process.env.MC_RAG_DISABLED = "true";
const { loadActionPlugins, performAction, loadPenLocation, countInPen, findBedSites, shelterPositions,
  communalShelterPositions, communalDoorwayPosition, isUtilityUsable, findShelterSite } = await import("../actions.js");
const arbiter = await import("../arbiter.js");
const { equipBestArmor, installEnchantsFix } = await import("../equipment.js");
const { SwimMovements, installDoorSupport } = await import("../swim-movements.js");
const { isProtectedBlockName } = await import("../actions.js");
const { refreshLivingSpace, shelterRoomsNear } = await import("../shelter.js");
const { installTorchTrail, needsTorches, torchCount, TORCH_CARRY_MIN, TORCH_SPACING } = await import("../tunneling.js");

const { pathfinder, Movements, goals } = pathfinderPkg;
const execFileAsync = promisify(execFile);

const HOST = process.env.MC_HOST || "192.168.1.221";
const PORT = parseInt(process.env.MC_PORT || "25580", 10);
const TESTER = process.env.MC_TEST_USERNAME || "MBTester";
// Arena: far from the fleet's home so real bots never wander in; y=200 so nothing spawns around it.
const ARENA = { x: 2000, y: 200, z: 2000, r: 10 };
const TAG = "mbtest";
const RCON = fileURLToPath(new URL("./live/rcon.py", import.meta.url));
const filters = process.argv.slice(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rcon(...commands) {
  const { stdout } = await execFileAsync("python3", [RCON, ...commands], { timeout: 90_000 });
  return stdout;
}

async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

const { x, y, z, r } = ARENA;
async function buildArena() {
  await rcon(
    `forceload add ${x - r} ${z - r} ${x + r} ${z + r}`,
    `fill ${x - r} ${y} ${z - r} ${x + r} ${y} ${z + r} minecraft:sea_lantern`,
    `fill ${x - r} ${y + 1} ${z - r} ${x + r} ${y + 4} ${z + r} minecraft:air`,
    `fill ${x - r} ${y + 1} ${z - r} ${x + r} ${y + 3} ${z - r} minecraft:glass`,
    `fill ${x - r} ${y + 1} ${z + r} ${x + r} ${y + 3} ${z + r} minecraft:glass`,
    `fill ${x - r} ${y + 1} ${z - r} ${x - r} ${y + 3} ${z + r} minecraft:glass`,
    `fill ${x + r} ${y + 1} ${z - r} ${x + r} ${y + 3} ${z + r} minecraft:glass`,
  );
}

async function resetTester() {
  await rcon(
    `kill @e[tag=${TAG}]`,
    // Clear the arena interior (chests/blocks from the last scenario), then any items that spilled.
    `fill ${x - r + 1} ${y + 1} ${z - r + 1} ${x + r - 1} ${y + 4} ${z + r - 1} minecraft:air`,
    `kill @e[type=minecraft:item,x=${x - r},y=${y},z=${z - r},dx=${2 * r},dy=6,dz=${2 * r}]`,
    `gamemode survival ${TESTER}`,
    `clear ${TESTER}`,
    `effect clear ${TESTER}`,
    `effect give ${TESTER} minecraft:resistance 600 4 true`,
    `effect give ${TESTER} minecraft:saturation 1 20 true`,
    `tp ${TESTER} ${x} ${y + 1} ${z}`,
  );
  await waitFor(() => bot.entity && bot.entity.position.distanceTo({ x, y: y + 1, z }) < 3, 15_000, "tester at arena");
  arbiter.cancelAndClear(bot);
}

// `tanky`: 1000 health, so it can't die before a slow (~8s) RCON step lands.
async function summonHusk(dx, { tanky = false } = {}) {
  const hp = tanky ? ',Health:1000f,attributes:[{id:"minecraft:max_health",base:1000}]' : "";
  await rcon(`summon minecraft:husk ${x + dx} ${y + 1} ${z} {PersistenceRequired:1b,Tags:["${TAG}"]${hp}}`);
  return waitFor(() => Object.values(bot.entities).find((e) => e.name === "husk" &&
    e.position.distanceTo(bot.entity.position) < 12), 10_000, "husk to appear");
}

// ---- scenarios -----------------------------------------------------------------------------
const scenarios = [];
const scenarioCleanup = []; // undo steps a scenario registers; run after it, pass or fail
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario("MB-01 combat: attack actually fights and kills a real mob", async () => {
  await rcon(`give ${TESTER} minecraft:iron_sword`);
  await waitFor(() => bot.inventory.items().some((i) => i.name === "iron_sword"), 5000, "sword");
  const husk = await summonHusk(4);
  const result = await performAction(bot, { type: "attack", target: husk, maxDurationMs: 45_000 }, TESTER);
  assert.equal(result.ok, true, `attack result: ${result.text}`);
  assert.match(result.text, /took care of it/);
  // A dead mob lingers briefly (death animation) before the server removes it.
  await waitFor(() => !bot.entities[husk.id], 5000, "dead husk to be removed");
});

scenario("MB-01 combat: a target that leaves is 'lost track', not a kill", async () => {
  await rcon(`give ${TESTER} minecraft:wooden_sword`);
  const husk = await summonHusk(6, { tanky: true });
  const pending = performAction(bot, { type: "attack", target: husk, maxDurationMs: 60_000 }, TESTER);
  await sleep(2000);
  await rcon(`tp @e[tag=${TAG}] ${x} ${y + 1} ${z + 600}`);
  const result = await pending;
  assert.equal(result.ok, false, `attack result: ${result.text}`);
  assert.match(result.text, /lost track/);
});

scenario("MB-02/04 preemption: interrupted action reports cancelled and leaves the new path alone", async () => {
  const recovery = await arbiter.requestControl(bot, arbiter.OWNERS.RECOVERY);
  const pending = performAction(bot, { type: "recover", position: { x: x + 8, y: y + 1, z: z + 8 } }, TESTER, recovery);
  await sleep(400);
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  const escape = new goals.GoalNear(x - 8, y + 1, z - 8, 1);
  bot.pathfinder.setGoal(escape);
  const result = await pending;
  try {
    assert.equal(result.ok, false, `recover result: ${result.text}`);
    assert.equal(result.cancelled, true);
    assert.equal(recovery.token.preempted, true);
    assert.equal(bot.pathfinder.goal, escape, "the preemptor's path survived the old action's cleanup");
    const stale = await performAction(bot, { type: "recover", position: { x, y: y + 1, z } }, TESTER, recovery);
    assert.equal(stale.cancelled, true, "a stale handle is refused");
    assert.equal(bot.pathfinder.goal, escape);
  } finally {
    bot.pathfinder.setGoal(null);
    emergency.release();
  }
});

scenario("MB-07 armor: better worn armor is kept, and a better carried piece is equipped", async () => {
  await rcon(`item replace entity ${TESTER} armor.head with minecraft:netherite_helmet`,
    `give ${TESTER} minecraft:leather_helmet`);
  const head = () => bot.inventory.slots[bot.getEquipmentDestSlot("head")]?.name;
  await waitFor(() => head() === "netherite_helmet" && bot.inventory.items().some((i) => i.name === "leather_helmet"),
    5000, "helmets in place");
  for (let i = 0; i < 3; i++) {
    await equipBestArmor(bot);
    await sleep(300);
    assert.equal(head(), "netherite_helmet", `refresh ${i + 1} kept the netherite helmet`);
  }
  // clear first: `clear` also strips worn armor, so it must run before the new helmet goes on.
  await rcon(`clear ${TESTER} minecraft:leather_helmet`,
    `item replace entity ${TESTER} armor.head with minecraft:leather_helmet`, `give ${TESTER} minecraft:iron_helmet`);
  await waitFor(() => head() === "leather_helmet" && bot.inventory.items().some((i) => i.name === "iron_helmet"),
    5000, "leather worn, iron carried");
  await equipBestArmor(bot);
  await waitFor(() => head() === "iron_helmet", 5000, "iron helmet equipped");
});

scenario("MB-15 food: a hungry bot eats raw fish", async () => {
  await rcon(`effect give ${TESTER} minecraft:hunger 10 255 true`);
  await waitFor(() => bot.food <= 16, 30_000, "food to drop");
  await rcon(`effect clear ${TESTER} minecraft:hunger`, `give ${TESTER} minecraft:cod 4`);
  await waitFor(() => bot.inventory.items().some((i) => i.name === "cod"), 5000, "cod");
  const before = bot.food;
  const result = await performAction(bot, { type: "eat" }, TESTER);
  assert.equal(result.ok, true, `eat result: ${result.text}`);
  assert.match(result.text, /cod/);
  await waitFor(() => bot.food > before, 5000, "food to go up");
});

scenario("MB-02 takeover closes the interrupted action's open window", async () => {
  await rcon(`setblock ${x + 2} ${y + 1} ${z} minecraft:crafting_table`);
  const table = await waitFor(() => { const b = bot.blockAt(new Vec3(x + 2, y + 1, z)); return b?.name === "crafting_table" && b; },
    5000, "crafting table");
  const routine = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  await bot.openBlock(table);
  await waitFor(() => bot.currentWindow, 5000, "window open");
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  try {
    await waitFor(() => !bot.currentWindow, 3000, "window closed by the takeover");
    assert.equal(routine.token.preempted, true);
  } finally {
    emergency.release();
  }
});

scenario("MB-08 place_home walks to the spawn point and places the item there", async () => {
  // "home" is bot.spawnPoint -- the WORLD spawn (mineflayer's spawn_position packet), not a
  // player's /spawnpoint. Moving the world spawn would move the real fleet's home, so the tester's
  // own copy is pointed at the arena instead.
  const home = new Vec3(x + 7, y + 1, z + 7);
  const worldSpawn = bot.spawnPoint;
  bot.spawnPoint = home;
  scenarioCleanup.push(() => { bot.spawnPoint = worldSpawn; });
  await rcon(`give ${TESTER} minecraft:crafting_table`);
  await waitFor(() => bot.inventory.items().some((i) => i.name === "crafting_table"), 5000, "crafting table in inventory");
  const result = await performAction(bot, { type: "place_home", item: "crafting_table" }, TESTER);
  assert.equal(result.ok, true, `place_home result: ${result.text}`);
  const placed = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, point: new Vec3(home.x, home.y, home.z), maxDistance: 4 });
  assert(placed, "a crafting table stands within 4 blocks of home");
});

scenario("Craft: a table-needing recipe is detected even with the wrong materials in hand, so she uses the real table standing nearby", async () => {
  // Real bug found live 2026-10-09 (direct report: bots "repeatedly complain about crafting
  // tables" without trying to make one, noticing two standing right next to them, or
  // remembering either's location). actions.js's "craft" case used recipesFor() to decide
  // whether a table would help -- recipesFor() filters to recipes she can afford with her
  // CURRENT inventory, so giving her string but no sticks at all (a bow needs both at once) makes
  // that check come back empty whether or not a table is involved, same as having nothing. Under
  // the old code that meant tableWouldHelp was always false: she'd never look for the crafting
  // table standing two blocks away, fall into craftItem() with no table reference, and -- even
  // after successfully chaining her planks into sticks along the way, since sticks need no table
  // -- the final affordability check excludes every table-requiring recipe when no table is
  // passed, so she'd still fail with "don't have the ingredients (might need a crafting table)"
  // while standing right next to one. recipesAll() answers the real, inventory-independent
  // question instead, so she finds/uses the real table and actually finishes.
  //
  // A bow, not a wooden_pickaxe: minecraft-data carries one wooden_pickaxe recipe PER plank
  // species (12 of them, since planks are a direct ingredient), and craftItem's own fallback loop
  // (actions.js) has no memory across candidates -- each of the 12 independently notices "stick"
  // is missing and tries to chain-craft it, several of them concurrently/redundantly against the
  // same crafting-table window, which lost a real race live ("missing ingredient") unrelated to
  // this fix. A bow has exactly one recipe (stick + string, neither species-ambiguous), so the
  // chain only ever fires once.
  await rcon(`setblock ${x + 2} ${y + 1} ${z} minecraft:crafting_table`,
    `give ${TESTER} minecraft:oak_planks 8`, `give ${TESTER} minecraft:string 3`);
  await waitFor(() => held("oak_planks") >= 8 && held("string") >= 3 &&
    bot.blockAt(new Vec3(x + 2, y + 1, z))?.name === "crafting_table", 5000, "planks, string and a standing table");
  const result = await performAction(bot, { type: "craft", item: "bow", count: 1 }, TESTER);
  assert.equal(result.ok, true, `craft result: ${result.text}`);
  await waitFor(() => held("bow") >= 1, 5000, "a bow");
  const tableId = bot.registry.blocksByName.crafting_table.id;
  const tables = bot.findBlocks({ matching: tableId, point: new Vec3(x, y + 1, z), maxDistance: 16, count: 5 });
  assert.equal(tables.length, 1, "used the table that was already standing there, not a second one");
});


// Doors (2026-09-25): a glass room around the arena centre whose only opening is one door or gate
// on its south wall, and the bot's real movement setup (index.js: SwimMovements, canOpenDoors,
// doors in blocksCantBreak) with digging off, so a pass means it went through the opening.
async function doorRoom(block, { gapAbove = false } = {}) {
  const wall = [];
  for (const [x1, z1, x2, z2] of [[-2, -2, 2, -2], [-2, 2, 2, 2], [-2, -2, -2, 2], [2, -2, 2, 2]]) {
    wall.push(`fill ${x + x1} ${y + 1} ${z + z1} ${x + x2} ${y + 3} ${z + z2} minecraft:glass`);
  }
  await rcon(...wall, `fill ${x - 2} ${y + 4} ${z - 2} ${x + 2} ${y + 4} ${z + 2} minecraft:glass`);
  const door = block.endsWith("_door");
  const lower = door ? `${block}[facing=south,half=lower,hinge=left,${"OPEN"}]` : `${block}[facing=south,${"OPEN"}]`;
  return {
    door,
    async place(open) {
      const state = (b) => b.replace("OPEN", `open=${open}`);
      const cmds = [`setblock ${x} ${y + 1} ${z + 2} minecraft:${state(lower)}`];
      if (door) cmds.push(`setblock ${x} ${y + 2} ${z + 2} minecraft:${state(`${block}[facing=south,half=upper,hinge=left,OPEN]`)}`);
      else if (gapAbove) cmds.push(`setblock ${x} ${y + 2} ${z + 2} minecraft:air`);
      await rcon(...cmds);
      await waitFor(() => bot.blockAt(new Vec3(x, y + 1, z + 2))?.name === block &&
        bot.blockAt(new Vec3(x, y + 1, z + 2)).getProperties().open === open, 5000, `${block} open=${open}`);
    },
  };
}
function useBotMovements() {
  // Carrying placeable blocks is what crashed pathfinder's own "use a door" step in production
  // (Babs, 2026-09-25), so every door scenario carries some.
  rcon(`give ${TESTER} minecraft:cobblestone 16`).catch(() => {});
  const movements = new SwimMovements(bot);
  movements.canOpenDoors = true;
  movements.canDig = false;
  for (const block of bot.registry.blocksArray) {
    if (isProtectedBlockName(block.name)) movements.blocksCantBreak.add(block.id);
  }
  const previous = bot.pathfinder.movements;
  bot.pathfinder.setMovements(movements);
  scenarioCleanup.push(() => bot.pathfinder.setMovements(previous));
}
async function walkTo(tx, tz) {
  await withTimeoutMs(bot.pathfinder.goto(new goals.GoalBlock(tx, y + 1, tz)), 30_000, () => bot.pathfinder.setGoal(null));
  assert(bot.entity.position.distanceTo(new Vec3(tx + 0.5, y + 1, tz + 0.5)) < 1.5, `ended at ${bot.entity.position}`);
}
function withTimeoutMs(promise, ms, onTimeout) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error(`no route after ${ms}ms`)); }, ms);
  })]).finally(() => clearTimeout(timer));
}
for (const [label, block, open, gapAbove] of [
  ["a closed door", "oak_door", false], ["an open door", "oak_door", true],
  ["an open fence gate", "oak_fence_gate", true, true], ["a closed fence gate", "oak_fence_gate", false, true],
]) {
  scenario(`Doors: walks out of a room through ${label}`, async () => {
    useBotMovements();
    const room = await doorRoom(block, { gapAbove });
    await room.place(open);
    await walkTo(x, z + 5);
    assert.equal(bot.blockAt(new Vec3(x, y + 1, z + 2))?.name, block, "the door/gate is still there (not dug)");
    await waitFor(() => bot.blockAt(new Vec3(x, y + 1, z + 2)).getProperties().open === false, 5000, "it shut behind her");
  });
}
scenario("Doors: walks into a room through an open door", async () => {
  useBotMovements();
  const room = await doorRoom("spruce_door");
  await rcon(`tp ${TESTER} ${x} ${y + 1} ${z + 5}`);
  await waitFor(() => bot.entity.position.distanceTo(new Vec3(x, y + 1, z + 5)) < 2, 10_000, "tester outside");
  await room.place(true);
  await walkTo(x, z);
  await waitFor(() => bot.blockAt(new Vec3(x, y + 1, z + 2)).getProperties().open === false, 5000, "it shut behind her");
});

// Farming and ranching (2026-09-25). The arena floor is one layer of sea lanterns with air under it,
// so dirt, farmland and water go into that layer (water gets glass under it), and each scenario puts
// the floor back.
const restoreFloor = () => scenarioCleanup.push(() => rcon(
  `fill ${x - r + 1} ${y} ${z - r + 1} ${x + r - 1} ${y} ${z + r - 1} minecraft:sea_lantern`,
  `fill ${x - r + 1} ${y - 1} ${z - r + 1} ${x + r - 1} ${y - 1} ${z + r - 1} minecraft:air`,
  `kill @e[type=minecraft:item,x=${x - r},y=${y - 2},z=${z - r},dx=${2 * r},dy=8,dz=${2 * r}]`).catch(() => {}));
const held = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);

scenario("Food: loot \"food\" takes food out of a chest", async () => {
  await placeChest(3, 0, [["bread", 5]]);
  const result = await performAction(bot, { type: "loot", item: "food", count: 8 }, TESTER);
  assert.equal(result.ok, true, result.text);
  await waitFor(() => held("bread") > 0, 5000, "bread in inventory");
});

scenario("Farming: starts a plot by water -- clears grass, tills, plants, and checks each took", async () => {
  restoreFloor();
  await rcon(`fill ${x + 3} ${y} ${z + 3} ${x + 7} ${y} ${z + 7} minecraft:grass_block`,
    `setblock ${x + 5} ${y - 1} ${z + 5} minecraft:glass`, `setblock ${x + 5} ${y} ${z + 5} minecraft:water`,
    `setblock ${x + 4} ${y + 1} ${z + 5} minecraft:short_grass`,
    `give ${TESTER} minecraft:wooden_hoe`, `give ${TESTER} minecraft:wheat_seeds 8`);
  await waitFor(() => held("wheat_seeds") >= 8 && bot.blockAt(new Vec3(x + 5, y, z + 5))?.name === "water", 8000, "plot setup");
  const result = await performAction(bot, { type: "harvest", near: { x: x + 5, y, z: z + 5 } }, TESTER);
  assert.equal(result.ok, true, result.text);
  assert(result.planted >= 4, `planted ${result.planted}: ${result.text}`);
  let crops = 0;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const ground = bot.blockAt(new Vec3(x + 5 + dx, y, z + 5 + dz));
      const crop = bot.blockAt(new Vec3(x + 5 + dx, y + 1, z + 5 + dz));
      if (crop?.name === "wheat") { crops++; assert.equal(ground.name, "farmland"); }
    }
  }
  assert.equal(crops, result.planted, "every planted count is a real wheat crop on farmland");
  assert.notEqual(bot.blockAt(new Vec3(x + 4, y + 1, z + 5))?.name, "short_grass", "the grass on the plot was cleared");
});

scenario("Farming: harvests ripe crops only, replants, and records the harvest", async () => {
  restoreFloor();
  const spots = [[-4, -4], [-4, -3], [-3, -4]];
  await rcon(...spots.map(([dx, dz]) => `setblock ${x + dx} ${y} ${z + dz} minecraft:farmland`),
    ...spots.map(([dx, dz]) => `setblock ${x + dx} ${y + 1} ${z + dz} minecraft:wheat[age=7]`),
    `setblock ${x - 3} ${y} ${z - 3} minecraft:farmland`, `setblock ${x - 3} ${y + 1} ${z - 3} minecraft:wheat[age=2]`,
    `give ${TESTER} minecraft:netherite_sword[enchantments={sharpness:5,unbreaking:3}]`);
  await waitFor(() => bot.blockAt(new Vec3(x - 3, y + 1, z - 4))?.name === "wheat" && held("netherite_sword") > 0,
    8000, "crops set up");
  // No seeds in hand, like a bot harvesting a farm it didn't plant: the replant has to use the drops.
  // Holding enchanted gear, as the fleet does: digging used to throw "enchantments.concat is not a function".
  await bot.equip(bot.inventory.items().find((i) => i.name === "netherite_sword"), "hand");
  const result = await performAction(bot, { type: "harvest", onlyRipe: true }, TESTER);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.harvested?.wheat, 3, result.text);
  await waitFor(() => held("wheat") >= 3, 8000, "wheat picked up");
  assert.equal(Number(bot.blockAt(new Vec3(x - 3, y + 1, z - 3)).getProperties().age), 2, "the unripe one was left alone");
  const replanted = spots.filter(([dx, dz]) => bot.blockAt(new Vec3(x + dx, y + 1, z + dz))?.name === "wheat").length;
  assert(replanted >= 2, `replanted ${replanted}/3 from the dropped seeds: ${result.text}`);
  const file = path.join(process.env.MC_MEMORY_ROOT, "achievements", `${TESTER}.json`);
  assert(JSON.parse(readFileSync(file, "utf8")).includes("harvested:wheat"), "achievement recorded");
  const again = await performAction(bot, { type: "harvest", onlyRipe: true }, TESTER);
  assert.equal(again.ok, false, "onlyRipe never starts a farm");
});

scenario("Ranching: builds a pen on its site, herds a cow in, and breeds a real baby", async () => {
  useBotMovements(); // the fleet's real movement setup: gates open on the way through
  scenarioCleanup.push(() => rcon(`kill @e[type=minecraft:cow,x=${x - r},y=${y},z=${z - r},dx=${2 * r},dy=6,dz=${2 * r}]`).catch(() => {}));
  await rcon(`give ${TESTER} minecraft:oak_fence 23`, `give ${TESTER} minecraft:oak_fence_gate 1`, `give ${TESTER} minecraft:wheat 16`);
  await waitFor(() => held("oak_fence") >= 23 && held("oak_fence_gate") >= 1 && held("wheat") >= 16, 8000, "pen materials");
  const site = { x: x - 5, y: y + 1, z: z - 5 };
  const built = await performAction(bot, { type: "build_pen", at: site }, TESTER);
  assert.equal(built.ok, true, built.text);
  const pen = await loadPenLocation();
  assert.deepEqual([pen.center.x, pen.center.y, pen.center.z], [site.x, site.y, site.z], "pen saved at its site");
  // One cow already inside (summoned), one out in the arena to herd in.
  await rcon(`summon minecraft:cow ${site.x + 0.5} ${site.y} ${site.z + 0.5} {Tags:["${TAG}"],PersistenceRequired:1b}`,
    `summon minecraft:cow ${x + 5} ${y + 1} ${z + 5} {Tags:["${TAG}"],PersistenceRequired:1b}`);
  await waitFor(() => Object.values(bot.entities).filter((e) => e.name === "cow").length >= 2, 10_000, "two cows");
  const herded = await performAction(bot, { type: "herd_to_pen", species: "cow" }, TESTER);
  assert.equal(herded.ok, true, herded.text);
  assert(countInPen(bot, pen, "cow") >= 2, `cows in pen: ${countInPen(bot, pen, "cow")}`);
  const bred = await performAction(bot, { type: "breed", species: "cow", near: pen.center }, TESTER);
  assert.equal(bred.ok, true, bred.text);
  assert.equal(bred.bred, "cow");
});

// Beds (2026-09-26): after the world reset no bot could make a bed. Wool from a sheep, a bed crafted
// from it, and a bed placed at home the right way round.
scenario("Beds: gets wool from a sheep (no shears: hunts it and picks up the drop)", async () => {
  scenarioCleanup.push(() => rcon(`kill @e[type=minecraft:sheep,x=${x - r},y=${y},z=${z - r},dx=${2 * r},dy=6,dz=${2 * r}]`).catch(() => {}));
  await rcon(`give ${TESTER} minecraft:netherite_sword[enchantments={sharpness:5}]`,
    `summon minecraft:sheep ${x + 4} ${y + 1} ${z} {Tags:["${TAG}"],PersistenceRequired:1b,Color:0b}`);
  await waitFor(() => held("netherite_sword") > 0 && Object.values(bot.entities).some((e) => e.name === "sheep"), 10_000, "sword and sheep");
  const result = await performAction(bot, { type: "get_wool", count: 1 }, TESTER);
  assert.equal(result.ok, true, result.text);
  assert(held("white_wool") >= 1, "wool picked up");
});

scenario("get_wool: with no sheep anywhere, she wanders to look rather than failing on the spot", async () => {
  // Real bug found live 2026-10-10 (direct report: bots "give up on constructed goals without
  // seeming to attempt to get the raw materials they lack"): get_wool used to check only her
  // immediate 32-block radius and fail instantly ("no sheep nearby to get wool from.") with no
  // attempt to go look, confirmed live from Mayor's bed goal failing 3 times in a row at ms=0.
  // No sheep exists anywhere in or near the arena here either -- the fix still can't conjure one
  // up, so this only proves she actually tried (the fail text names that explicitly) rather than
  // asserting a find this arena can't support.
  const result = await performAction(bot, { type: "get_wool", count: 1 }, TESTER);
  assert.equal(result.ok, false);
  assert.match(result.text, /even after looking around/,
    "should say she looked, not fail instantly the way the old code did");
});

scenario("Beds: crafts \"bed\" as the colour of the wool she holds", async () => {
  // No crafting table anywhere, as in a fresh world: craft has to make and place one first.
  await rcon(`give ${TESTER} minecraft:red_wool 3`, `give ${TESTER} minecraft:oak_planks 7`);
  await waitFor(() => held("red_wool") >= 3 && held("oak_planks") >= 7, 8000, "wool and planks");
  const result = await performAction(bot, { type: "craft", item: "bed", count: 1 }, TESTER);
  assert.equal(result.ok, true, result.text);
  await waitFor(() => held("red_bed") >= 1, 5000, "a red bed");
  assert(bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 6 }), "the table she made is standing");
});

scenario("Beds: places a bed at home as two blocks facing away from her", async () => {
  const home = new Vec3(x - 4, y + 1, z - 4);
  const worldSpawn = bot.spawnPoint;
  bot.spawnPoint = home;
  scenarioCleanup.push(() => { bot.spawnPoint = worldSpawn; });
  await rcon(`give ${TESTER} minecraft:white_bed`);
  await waitFor(() => held("white_bed") >= 1, 5000, "a bed to place");
  // Something standing on the best spot's foot, as the fleet crowds spawn: the server refuses a bed
  // whose foot cell is occupied (live, 2026-09-26; a mob on the head cell it allows), so place_bed
  // has to use another spot.
  scenarioCleanup.push(() => rcon(`kill @e[type=minecraft:cow,x=${x - r},y=${y},z=${z - r},dx=${2 * r},dy=6,dz=${2 * r}]`).catch(() => {}));
  const best = findBedSites(bot, home)[0];
  await rcon(`summon minecraft:cow ${best.foot.x + 0.5} ${best.foot.y} ${best.foot.z + 0.5} {NoAI:1b,Tags:["${TAG}"],PersistenceRequired:1b}`);
  await waitFor(() => Object.values(bot.entities).some((e) => e.name === "cow"), 8000, "a cow on the best spot");
  const result = await performAction(bot, { type: "place_bed" }, TESTER);
  assert.equal(result.ok, true, result.text);
  const foot = new Vec3(result.bedAt.x, result.bedAt.y, result.bedAt.z);
  const halves = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => bot.blockAt(foot.offset(dx, 0, dz)))
    .filter((b) => bot.isABed(b));
  assert(bot.isABed(bot.blockAt(foot)) && halves.length >= 1, "both halves of the bed are there");
  assert(foot.distanceTo(home) >= 2 && foot.distanceTo(home) <= 11, `near home but not on it: ${foot}`);
  assert(!bot.isABed(bot.blockAt(best.foot)), "not on the cell the cow stands in");
});

// Shelters (2026-09-26/27): build on a chosen site from a mix of blocks (the old build needed 33+
// of one kind), and the shelter must fit a bed: a 2x3 room, then a bed placed in it from the doorway.
//
// Found live 2026-10-11: with the room still 2x2, a real door and a bed could never both fit --
// findBedSites()'s nearDoor() exclusion, correctly applied now that a real door exists, refused
// every foot/head cell next to it, and the room was too narrow for a "stand" cell outside its own
// footprint (confirmed by tracing all four BED_DIRS orientations against the real coordinates).
// Fixed by widening the room to 2x3 (actions.js's own SHELTER_ROOM comment has the full account):
// the bed lives in the two rows farthest from the door, the new row at the door is free to be her
// stand-cell, and this scenario now places and checks a real bed again, not just the walls.
scenario("Shelters: builds a 4x5 shelter from mixed blocks, seals it with a real door, and fits a bed", async () => {
  // Real bug found live 2026-10-11 (direct report: a shelter needs "complete walls, ceiling,
  // floor, and at least one door (not an opening or arch)..."). The doorway used to be a bare,
  // permanent gap -- shelterPositions() excluded it from the fill entirely and nothing ever
  // placed a door there. Gives her planks too (for the door -- it needs a crafting table, which
  // the existing table-sourcing fallback, actions.js 1.83.1, now finds/makes on its own) on top
  // of the dirt/cobblestone the walls/roof/floor use.
  await rcon(`give ${TESTER} minecraft:cobblestone 26`, `give ${TESTER} minecraft:dirt 26`, `give ${TESTER} minecraft:oak_planks 20`,
             `give ${TESTER} minecraft:white_bed`);
  await waitFor(() => held("cobblestone") >= 26 && held("dirt") >= 26 && held("oak_planks") >= 20 && held("white_bed") >= 1,
    8000, "mixed blocks, planks for a door, and a bed");
  const base = new Vec3(x - 4, y + 1, z - 4); // the room's back-left cell
  const result = await performAction(bot, { type: "build", at: { x: base.x, y: base.y, z: base.z } }, TESTER);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.built, true, result.text);
  const room = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]].map(([dx, dz]) => base.offset(dx, 0, dz));
  for (const cell of room) {
    assert.notEqual(bot.blockAt(cell)?.boundingBox, "block", `room cell ${cell} is open`);
    assert.equal(bot.blockAt(cell.offset(0, -1, 0))?.boundingBox, "block", `floor under ${cell} is solid`);
  }
  assert.equal(bot.blockAt(base.offset(0, 3, 0))?.boundingBox, "block", "roofed");
  assert.equal(bot.blockAt(base.offset(0, 2, 3))?.boundingBox, "block", "the lintel above the doorway is solid too");
  const doorBlock = bot.blockAt(base.offset(0, 0, 3));
  assert.match(doorBlock?.name ?? "", /_door$/, "a real door seals the doorway, not an open gap");
  assert(held("cobblestone") < 26 && held("dirt") < 26, "both kinds of block were used");

  const worldSpawn = bot.spawnPoint;
  bot.spawnPoint = base;
  scenarioCleanup.push(() => { bot.spawnPoint = worldSpawn; });
  const bedded = await performAction(bot, { type: "place_bed" }, TESTER);
  assert.equal(bedded.ok, true, bedded.text);
  const foot = new Vec3(bedded.bedAt.x, bedded.bedAt.y, bedded.bedAt.z);
  const local = foot.minus(base);
  assert(local.y === 0 && local.x >= 0 && local.x <= 1 && local.z >= 0 && local.z <= 1,
    `the bed landed inside the room, not the door's own row: ${JSON.stringify(local)}`);
});

scenario("Builder checklist: a crowded core still finds a shelter site farther out", async () => {
  // 2026-10-27 (direct request, "allow the shelter search radius to go up to 48 blocks"):
  // findShelterSite() (actions.js 1.94.0) used to search a fixed 4-block radius -- once the
  // crafting table/furnace/chest/earlier shelters crowd that tight core, site-finding failed
  // forever, correctly, given the radius it was allowed to search.
  //
  // First live run found this scenario's own design didn't fit the arena: the test platform is
  // only ~20x20 (ARENA.r), too small to block radius-4's ENTIRE reachable footprint with a
  // symmetric cube around an arena-centered home and still leave room for a wider site inside the
  // walls (every direction runs into glass at about the same distance the block itself needed).
  // Fixed by putting home off-centre (5 west of the arena's own centre) instead: the block cube
  // still fully covers every cell a radius-4 search could reach (x -6..6, and z -6..9 -- the
  // doorway's own "outside" cell makes the real footprint deeper in +z than -z, see
  // findShelterSite's own header), but the arena now has far more open room on home's EAST side
  // (14 blocks to the glass, not 10) than the block needs, same amount of open room as before on
  // every other side.
  const home = new Vec3(x - 5, y + 1, z);
  const CORE_X = 6, CORE_Z_NEG = 6, CORE_Z_POS = 9; // the asymmetric footprint union, +1 margin
  await rcon(`fill ${home.x - CORE_X} ${y - 1} ${home.z - CORE_Z_NEG} ${home.x + CORE_X} ${y + 6} ${home.z + CORE_Z_POS} minecraft:bedrock`);
  await waitFor(() => bot.blockAt(home)?.boundingBox === "block", 5000, "the core to fill in");
  // The fill also replaces the arena's own sea-lantern floor inside the core (y - 1 is below it);
  // put that back along with the rest of the blocked air column, same pattern restoreFloor() uses.
  scenarioCleanup.push(() => rcon(
    `fill ${home.x - CORE_X} ${y - 1} ${home.z - CORE_Z_NEG} ${home.x + CORE_X} ${y + 6} ${home.z + CORE_Z_POS} minecraft:air`,
    `fill ${x - r + 1} ${y} ${z - r + 1} ${x + r - 1} ${y} ${z + r - 1} minecraft:sea_lantern`,
  ).catch(() => {}));

  assert.equal(findShelterSite(bot, home, 4), null,
    "default maxRadius=4 still fails -- same cost/behavior as before this fix");
  const wider = findShelterSite(bot, home, 48);
  assert(wider, "a wider search finds a site once allowed past the crowded core");
  assert(wider.x - home.x > CORE_X,
    `the found site is actually outside the blocked core, east of it: ${JSON.stringify(wider)}`);
});

scenario("Shelter integrity: a hole knocked in a built shelter gets repaired on its own", async () => {
  // Direct report, 2026-10-11 ("if a shelter gets damaged..., repairing it becomes a temporary
  // top priority"): nothing before this ever re-checked a shelter after the initial build.
  // checkShelterIntegrity() is the periodic version; this calls its own logic directly (the
  // interval is 60s, too slow for a live test to wait out) via the same "build" action it uses.
  await rcon(`give ${TESTER} minecraft:cobblestone 30`, `give ${TESTER} minecraft:dirt 30`, `give ${TESTER} minecraft:oak_planks 20`);
  await waitFor(() => held("cobblestone") >= 30 && held("dirt") >= 30 && held("oak_planks") >= 20, 8000, "building materials");
  const base = new Vec3(x - 4, y + 1, z - 4);
  const built = await performAction(bot, { type: "build", at: { x: base.x, y: base.y, z: base.z } }, TESTER);
  assert.equal(built.ok, true, built.text);
  assert.equal(built.built, true, built.text);

  const worldSpawn = bot.spawnPoint;
  bot.spawnPoint = base;
  scenarioCleanup.push(() => { bot.spawnPoint = worldSpawn; });

  // Knock a hole in the wall directly via RCON (not "mine" -- this is damage, not a deliberate
  // dig) and confirm the shelter now reads as damaged, not complete.
  const hole = base.offset(-1, 1, 0);
  await rcon(`setblock ${hole.x} ${hole.y} ${hole.z} minecraft:air`);
  await waitFor(() => bot.blockAt(hole)?.boundingBox !== "block", 5000, "the hole to appear");
  await rcon(`give ${TESTER} minecraft:cobblestone 4`); // enough to patch the one missing block
  await waitFor(() => held("cobblestone") >= 4, 5000, "a little more cobblestone to repair with");

  const repaired = await performAction(bot, { type: "build", at: { x: base.x, y: base.y, z: base.z } }, TESTER);
  assert.equal(repaired.ok, true, repaired.text);
  assert.equal(bot.blockAt(hole)?.boundingBox, "block", "the hole is filled back in");
});

scenario("Communal shelter integrity: a hole in the large structure gets repaired, same as a small one", async () => {
  // Direct report, 2026-10-22 ("there is a large shelter with many beds, but it has holes or
  // missing parts. They are not repairing it as a large structure"): checkShelterIntegrity()'s
  // self-healing never covered the communal shelter at all -- findCommunalShelterNearHome() was
  // only ever called while a bot was actively pursuing the one-time "build it" goal, which
  // nextBuilderPriority() stops proposing forever the instant it's first satisfied. New
  // checkCommunalShelterIntegrity() (index.js 2.120.0) is the periodic version, same shape as
  // checkShelterIntegrity() just above; this calls its own "build_communal_shelter" action
  // directly (same reason the individual-shelter scenario above does: the real timer is 60s,
  // too slow for a live test to wait out).
  const width = 5, depth = 5;
  const base = new Vec3(x - 2, y + 1, z - 2);
  const needed = communalShelterPositions(base, width, depth).length;
  await rcon(`give ${TESTER} minecraft:cobblestone ${needed + 10}`, `give ${TESTER} minecraft:oak_planks 10`);
  await waitFor(() => held("cobblestone") >= needed && held("oak_planks") >= 10, 10000, "communal shelter building materials");
  const built = await performAction(bot, { type: "build_communal_shelter", at: { x: base.x, y: base.y, z: base.z }, width, depth }, TESTER);
  assert.equal(built.ok, true, built.text);
  assert.equal(built.built, true, built.text);

  const worldSpawn = bot.spawnPoint;
  bot.spawnPoint = base;
  scenarioCleanup.push(() => { bot.spawnPoint = worldSpawn; });

  // Knock a real hole in the wall via RCON (damage, not a deliberate dig) at a position taken
  // from the real geometry function -- not guessed -- and confirm it reads as damaged.
  const wallPositions = communalShelterPositions(base, width, depth);
  const doorPos = communalDoorwayPosition(base, depth);
  const hole = wallPositions.find((p) => p.y === base.y + 1 && (p.x !== doorPos.x || p.z !== doorPos.z));
  await rcon(`setblock ${hole.x} ${hole.y} ${hole.z} minecraft:air`);
  await waitFor(() => bot.blockAt(hole)?.boundingBox !== "block", 5000, "the hole to appear");
  await rcon(`give ${TESTER} minecraft:cobblestone 4`);
  await waitFor(() => held("cobblestone") >= 4, 5000, "a little more cobblestone to repair with");

  const repaired = await performAction(bot, { type: "build_communal_shelter", at: { x: base.x, y: base.y, z: base.z }, width, depth }, TESTER);
  assert.equal(repaired.ok, true, repaired.text);
  assert.equal(bot.blockAt(hole)?.boundingBox, "block", "the hole in the large structure is filled back in, same as a small shelter");
});

scenario("Shelter rooms (general): shelterRoomsNear finds a real hole in a real large structure, and patch_shelter fills it", async () => {
  // Direct follow-up, 2026-10-22 ("it should recognize: any number of individual shelters;
  // larger shelters as defined by contiguous walls roof and floor, broken only by doors"): the
  // scenario above proves build_communal_shelter's own repair path still works; this one proves
  // the NEW general path real bots actually take now -- shelterRoomsNear()/holesIn() finding the
  // real hole from the real block state (no predetermined geometry involved on this side at
  // all), and "patch_shelter" filling exactly what was found, against the real server.
  const width = 5, depth = 5;
  const base = new Vec3(x + 4, y + 1, z + 4); // a different spot from the scenario above, same arena
  const needed = communalShelterPositions(base, width, depth).length;
  await rcon(`give ${TESTER} minecraft:cobblestone ${needed + 10}`, `give ${TESTER} minecraft:oak_planks 10`);
  await waitFor(() => held("cobblestone") >= needed && held("oak_planks") >= 10, 10000, "building materials");
  const built = await performAction(bot, { type: "build_communal_shelter", at: { x: base.x, y: base.y, z: base.z }, width, depth }, TESTER);
  assert.equal(built.ok, true, built.text);

  // Identify "my" room among whatever shelterRoomsNear finds near this door (the scenario above
  // left its own, now-intact structure permanently standing nearby in the same arena) by real
  // wall overlap -- never by guessing an interior cell's coordinates.
  const myWalls = new Set(communalShelterPositions(base, width, depth).map((p) => `${p.x},${p.y},${p.z}`));
  const isMine = (r) => [...r.shell].some((k) => myWalls.has(k));
  const doorPos = communalDoorwayPosition(base, depth);
  const myRoom = () => shelterRoomsNear(bot, doorPos, 12).find(isMine);

  // Real door placement auto-creates both halves server-side in one action, but the upper
  // half's own block-update packet can land a moment after the lower half's -- found live, not
  // guessed: checking immediately after the build reported success read the real upper-door
  // cell as still-air for up to ~2s, one false hole, gone on the very next check. Production's
  // checkShelterIntegrity() never checks this soon after a build (a 60s timer), so this settle
  // wait belongs here, not in the implementation.
  await waitFor(() => myRoom()?.holes.size === 0, 5000, "the client's world model to settle after the build");
  const intact = myRoom();
  assert(intact, "the real, just-built structure is found by the general detector");
  assert.equal(intact.holes.size, 0, "intact -- no holes yet");

  // A flat mid-wall-face cell (west wall, dz in the middle of the room, not a corner where two
  // wall faces meet). Found live, not guessed: holesIn() walks STEPS_6 (face neighbours only,
  // never diagonal) outward from `inside`, and a corner cell's own path back to the interior is
  // two face-steps, not one -- the flood fill can never reach it, so it never enters `inside`
  // and holesIn() (which only ever examines cells already in `inside`) never sees it at all.
  // communalShelterPositions()'s own wall loop confirms the shape directly: dx=-1 is the west
  // wall for every dz in [0, depth), so (dx=-1, dz=floor(depth/2)) is guaranteed flat, not a
  // corner. This is a real, named limitation (shelter.js's own holesIn() header), not something
  // this test works around by accident.
  const hole = base.offset(-1, 1, Math.floor(depth / 2));
  assert.equal(bot.blockAt(hole)?.boundingBox, "block", "sanity: this really is a solid wall cell before the hole");
  await rcon(`setblock ${hole.x} ${hole.y} ${hole.z} minecraft:air`);
  await waitFor(() => bot.blockAt(hole)?.boundingBox !== "block", 5000, "the hole to appear");

  const damaged = shelterRoomsNear(bot, doorPos, 12).find(isMine);
  assert(damaged, "still recognized once damaged");
  assert(damaged.holes.has(`${hole.x},${hole.y},${hole.z}`),
    `the real hole, from real block state, is found by holesIn(): ${JSON.stringify([...damaged.holes])}`);

  await rcon(`give ${TESTER} minecraft:cobblestone 4`);
  await waitFor(() => held("cobblestone") >= 4, 5000, "a little more cobblestone to patch with");
  const holesList = [...damaged.holes].map((k) => {
    const [hx, hy, hz] = k.split(",").map(Number);
    return { x: hx, y: hy, z: hz };
  });
  const patched = await performAction(bot, { type: "patch_shelter", holes: holesList }, TESTER);
  assert.equal(patched.ok, true, patched.text);
  assert.equal(bot.blockAt(hole)?.boundingBox, "block", "the real hole, found by the general detector, is filled by patch_shelter");
});

const logCount = () => bot.inventory.items().filter((i) => i.name.endsWith("_log")).reduce((n, i) => n + i.count, 0);
async function placeChest(dx, dz, items) {
  const nbt = items.map(([id, count], slot) => `{Slot:${slot}b,id:"minecraft:${id}",count:${count}}`).join(",");
  await rcon(`setblock ${x + dx} ${y + 1} ${z + dz} minecraft:chest{Items:[${nbt}]}`);
  await waitFor(() => bot.blockAt(new Vec3(x + dx, y + 1, z + dz))?.name === "chest", 5000, "chest placed");
}

scenario("Builder checklist: a furnace sealed in solid blocks is marked unusable after real failures", async () => {
  // 2026-10-27: the Builder checklist used to count a furnace as "done" forever the moment one
  // existed near home, by bare existence -- never reachability. This proves the real fix: a
  // furnace that genuinely can't be reached accumulates real failures until isUtilityUsable()
  // reports it broken, the signal countUsableNearHome() (index.js) actually checks.
  //
  // First live run found a real gap in this scenario itself (not the fix): a single bedrock
  // layer immediately around the furnace does NOT actually block mineflayer's reach -- the bot
  // stood on top of the one-block cap and opened it fine three times (OUTCOME ok:true). Second
  // run, with a large burial box instead, found a WORSE gap: resetTester() spawns the tester at
  // the arena's own centre, which that box also happened to enclose -- RCON's fill doesn't push
  // a standing player out of newly-solid blocks the way real block placement would, so the bot
  // ended up glitched, overlapping bedrock. Fixed the entombment with real, deliberate separation
  // (the burial sits entirely on one side of the arena; the tester is explicitly teleported well
  // clear of it first) -- but a THIRD run, as part of the full suite rather than isolated, still
  // got through: attempt 1 genuinely failed ("Took too long to decide path to goal!", a real
  // noteUtilityOutcome(false)), but attempts 2 and 3 both succeeded, resetting the streak back to
  // 0 each time. Bedrock is unbreakable, but nothing here confirms this fleet's own digCost
  // model actually special-cases that (hardness -1) rather than scoring it as merely expensive --
  // a slow dig-based "solution" the pathfinder sometimes finds given enough search time would
  // explain exactly this: an occasional timeout, and otherwise eventual "success." Bedrock
  // doesn't settle the question either way without digging into that cost model, which is out of
  // scope here -- lava does, unambiguously: this fleet's own movement code already treats it as
  // unsafe/unwalkable terrain (not a cost to weigh, see the `b.name !== "lava"` checks this
  // codebase already has in multiple places), so there is no plausible path through it to find,
  // slow or fast. The furnace now sits in a 1-block air pocket with lava filling every cell
  // immediately around it, itself contained by an outer bedrock shell (stopping the lava from
  // flowing anywhere a bot could approach from).
  const pos = new Vec3(x + 5, y, z);
  const testerSpot = new Vec3(x - 6, y + 1, z);
  await rcon(`fill ${pos.x - 4} ${pos.y - 4} ${pos.z - 4} ${pos.x + 4} ${pos.y + 4} ${pos.z + 4} minecraft:bedrock`,
    `fill ${pos.x - 3} ${pos.y - 3} ${pos.z - 3} ${pos.x + 3} ${pos.y + 3} ${pos.z + 3} minecraft:lava`,
    `setblock ${pos.x} ${pos.y} ${pos.z} minecraft:furnace`,
    `tp ${TESTER} ${testerSpot.x} ${testerSpot.y} ${testerSpot.z}`);
  await waitFor(() => bot.blockAt(pos)?.name === "furnace" && bot.blockAt(pos.offset(1, 0, 0))?.name === "lava",
    5000, "the furnace and its lava moat both registered");
  await waitFor(() => bot.entity.position.distanceTo(testerSpot) < 2, 5000, "the tester clear of the burial, on the arena's other side");
  scenarioCleanup.push(() => rcon(
    `fill ${pos.x - 4} ${pos.y - 4} ${pos.z - 4} ${pos.x + 4} ${pos.y + 4} ${pos.z + 4} minecraft:air`,
    `fill ${x - r + 1} ${y} ${z - r + 1} ${x + r - 1} ${y} ${z + r - 1} minecraft:sea_lantern`).catch(() => {}));
  // 5 attempts, not 3 -- noteUtilityOutcome() resets the streak on any single success
  // (correctly: a chest/furnace that works even once is not "broken"), so this scenario's own
  // proof needs every attempt to fail, not just most of them. The margin over
  // UTILITY_UNUSABLE_AFTER_FAILURES (3) is defense in depth against exactly the kind of one-off
  // flake the bedrock version of this scenario turned out to have.
  await rcon(`give ${TESTER} minecraft:raw_iron 5`, `give ${TESTER} minecraft:coal 5`);
  await waitFor(() => held("raw_iron") >= 5 && held("coal") >= 5, 5000, "fuel and ore to smelt with");
  for (let i = 0; i < 5; i++) await performAction(bot, { type: "smelt", item: "iron_ingot", count: 1 }, TESTER);
  assert.equal(isUtilityUsable("furnace", pos), false, "five real attempts, all genuinely blocked by the lava moat, mark this furnace unusable");
});

scenario("Builder checklist: a chest sealed in solid blocks is marked unusable after real failures", async () => {
  // 2026-10-27: same mechanism as the furnace scenario just above, for chests specifically --
  // tryTakeFromThisChest()'s reach/open catch sites (actions.js 1.94.0), exercised here via
  // "loot"'s targeted-withdrawal path (searchChestsFor -> tryTakeFromThisChest), now call
  // noteUtilityOutcome() too.
  await rcon(`setblock ${x + 3} ${y} ${z} minecraft:chest`,
    `setblock ${x + 2} ${y} ${z} minecraft:bedrock`, `setblock ${x + 4} ${y} ${z} minecraft:bedrock`,
    `setblock ${x + 3} ${y} ${z - 1} minecraft:bedrock`, `setblock ${x + 3} ${y} ${z + 1} minecraft:bedrock`,
    `setblock ${x + 3} ${y + 1} ${z} minecraft:bedrock`);
  await waitFor(() => bot.blockAt(new Vec3(x + 3, y, z))?.name === "chest", 5000, "the sealed chest");
  const pos = new Vec3(x + 3, y, z);
  for (let i = 0; i < 3; i++) await performAction(bot, { type: "loot", item: "cobblestone", count: 1 }, TESTER);
  assert.equal(isUtilityUsable("chest", pos), false, "three real failures mark this exact chest unusable");
});

scenario("MB-17 chest: a mixed-species stack is withdrawn across types", async () => {
  await placeChest(3, 0, [["oak_log", 2], ["birch_log", 2]]);
  const result = await performAction(bot, { type: "mine", block: "oak_log", count: 4 }, TESTER);
  assert.equal(result.ok, true, `mine result: ${result.text}`);
  assert.match(result.text, /already in a chest/);
  assert.equal(logCount(), 4, "2 oak + 2 birch taken");
  assert.equal(bot.currentWindow, null, "chest closed afterwards");
});

// 2026-10-28 ("gathering wood is done in fits and starts... the wood 'heals'"): a path search
// that times out mid-dig used to fail the whole mine and abort the swing. The base think window is
// squeezed to 1ms here so every search toward the trunk times out -- the fixed collect must still
// widen it, let any dig in flight finish, and bring the whole trunk home in ONE action.
scenario("Wood: a whole trunk is felled in one mine action even when path searches time out", async () => {
  await rcon(`fill ${x + 4} ${y + 1} ${z} ${x + 4} ${y + 4} ${z} minecraft:birch_log`,
             `fill ${x + 3} ${y + 4} ${z - 1} ${x + 5} ${y + 4} ${z + 1} minecraft:birch_leaves[persistent=true] keep`);
  await waitFor(() => bot.blockAt(new Vec3(x + 4, y + 4, z))?.name === "birch_log", 10_000, "trunk to appear");
  const savedThink = bot.pathfinder.thinkTimeout;
  bot.pathfinder.thinkTimeout = 1;
  try {
    const result = await performAction(bot, { type: "mine", block: "birch_log", count: 4 }, TESTER);
    assert.equal(result.ok, true, `mine result: ${result.text}`);
    assert.equal(bot.pathfinder.thinkTimeout, 1, "the squeezed window is restored after the collect");
  } finally {
    bot.pathfinder.thinkTimeout = savedThink;
  }
  await waitFor(() => logCount() >= 4, 10_000, "all four logs picked up");
});

scenario("MB-16 explore: a stocked chest doesn't satisfy scouting for a village", async () => {
  await placeChest(-3, 0, [["oak_log", 16]]);
  const result = await performAction(bot, { type: "explore", feature: "village" }, TESTER);
  assert.equal(result.ok, false, `explore result: ${result.text}`);
  assert.match(result.text, /no sign of a village/);
  assert.equal(logCount(), 0, "nothing withdrawn from the chest");
});

// Access and shelters (2026-10-07). The offline checks prove the geometry; these prove the server
// agrees -- that a chest with a block over it really is shut, that a bed's two cells land where
// findBedSites said, and that a bot given only one walkable way out of a real shelter takes it.
scenario("Access: \"place\" will not set a furnace down on top of a chest", async () => {
  restoreFloor();
  const sides = [[1, 0], [-1, 0], [0, 1]]; // the first three "place" tries; (0,-1) is the fourth
  await rcon(`give ${TESTER} minecraft:furnace 1`,
             ...sides.map(([dx, dz]) => `setblock ${x + dx} ${y} ${z + dz} minecraft:chest`));
  await waitFor(() => held("furnace") >= 1 &&
    sides.every(([dx, dz]) => bot.blockAt(new Vec3(x + dx, y, z + dz))?.name === "chest"),
    8000, "a furnace and three chests sunk into the floor");
  const result = await performAction(bot, { type: "place", item: "furnace" }, TESTER);
  assert.equal(result.ok, true, result.text);
  assert.equal(bot.blockAt(new Vec3(x, y + 1, z - 1))?.name, "furnace", "placed over the one side with no chest under it");
  for (const [dx, dz] of sides) {
    assert.equal(bot.blockAt(new Vec3(x + dx, y + 1, z + dz))?.name, "air", `nothing on the chest at ${dx},${dz}`);
  }
});

scenario("Access: \"clear_access\" digs the block sitting on a chest, and leaves the chest alone", async () => {
  await placeChest(3, 0, [["bread", 1]]);
  await rcon(`give ${TESTER} minecraft:diamond_pickaxe`,
             `setblock ${x + 3} ${y + 2} ${z} minecraft:cobblestone`);
  await waitFor(() => bot.blockAt(new Vec3(x + 3, y + 2, z))?.name === "cobblestone", 5000, "the chest covered");
  const result = await performAction(bot, { type: "clear_access" }, TESTER);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /chest/, result.text);
  await waitFor(() => bot.blockAt(new Vec3(x + 3, y + 2, z))?.name === "air", 10_000, "the cobblestone gone");
  assert.equal(bot.blockAt(new Vec3(x + 3, y + 1, z))?.name, "chest", "the chest itself is untouched");
  // And the chest opens now, which is the whole point.
  const loot = await performAction(bot, { type: "loot", item: "bread", count: 1 }, TESTER);
  assert.equal(loot.ok, true, loot.text);
});

scenario("Shelter walls: with a shelter around her bed, she leaves through the doorway, not the wall", async () => {
  // 70, not 50: the room grew from 2x2 to 2x3 (2026-10-11, the bed/door room-size fix below),
  // needing more wall/roof/floor blocks than before.
  await rcon(`give ${TESTER} minecraft:cobblestone 70`, `give ${TESTER} minecraft:oak_planks 10`, `give ${TESTER} minecraft:white_bed`);
  await waitFor(() => held("cobblestone") >= 70 && held("oak_planks") >= 10 && held("white_bed") >= 1,
    8000, "blocks, planks for a door, and a bed");
  const base = new Vec3(x - 4, y + 1, z - 4);
  const built = await performAction(bot, { type: "build", at: { x: base.x, y: base.y, z: base.z } }, TESTER);
  assert.equal(built.built, true, built.text);
  const worldSpawn = bot.spawnPoint;
  bot.spawnPoint = base;
  scenarioCleanup.push(() => { bot.spawnPoint = worldSpawn; });
  const bedded = await performAction(bot, { type: "place_bed" }, TESTER);
  assert.equal(bedded.ok, true, bedded.text);

  // Her real movement setup plus the shell: digging is ON, so a route through a wall is available
  // to the search and only the shell refusal keeps her out of it.
  const space = refreshLivingSpace(bot, base);
  assert(space.inside.size > 0, `the shelter is recognised as a living space: ${JSON.stringify([...space.exits.keys()])}`);
  const movements = new SwimMovements(bot);
  movements.canOpenDoors = true;
  movements.digCost = 15;
  for (const block of bot.registry.blocksArray) {
    if (isProtectedBlockName(block.name)) movements.blocksCantBreak.add(block.id);
  }
  const previous = bot.pathfinder.movements;
  bot.pathfinder.setMovements(movements);
  scenarioCleanup.push(() => bot.pathfinder.setMovements(previous));

  // Counted, not required to be complete: build tolerates up to 20% missing, so the test asserts
  // that nothing which WAS standing stopped standing.
  const walls = shelterPositions(base);
  const standing = walls.filter((p) => bot.blockAt(p)?.boundingBox === "block").length;
  await rcon(`tp ${TESTER} ${base.x + 1} ${base.y} ${base.z + 1}`); // inside the room
  await waitFor(() => bot.entity.position.distanceTo(base.offset(1, 0, 1)) < 2, 10_000, "tester inside the shelter");
  await withTimeoutMs(bot.pathfinder.goto(new goals.GoalBlock(x + 6, y + 1, z + 6)), 45_000,
    () => bot.pathfinder.setGoal(null));
  const left = walls.filter((p) => bot.blockAt(p)?.boundingBox === "block").length;
  assert.equal(left, standing, `every wall block is still standing (${standing} before, ${left} after)`);
});

scenario("Torches: she makes some from coal, then trails them down a dark tunnel at a real spacing", async () => {
  // A deepslate corridor inside the arena. The arena's whole floor is sea lanterns (emitLight 15),
  // and litNearby is deliberately blind to walls, so every lantern within TORCH_SPACING of the
  // corridor -- which at r=10 is all of them -- has to go, not just the ones under the corridor
  // itself. restoreFloor() puts the lanterns back afterwards.
  restoreFloor();
  const [x0, x1] = [x - 8, x + 8];
  await rcon(
    `fill ${x - r} ${y} ${z - r} ${x + r} ${y} ${z + r} minecraft:deepslate`,
    `fill ${x0 - 1} ${y} ${z - 1} ${x1 + 1} ${y + 3} ${z + 1} minecraft:deepslate`,
    `fill ${x0} ${y + 1} ${z} ${x1} ${y + 2} ${z} minecraft:air`,
  );
  scenarioCleanup.push(() => rcon(`fill ${x0 - 1} ${y + 1} ${z - 1} ${x1 + 1} ${y + 3} ${z + 1} minecraft:air`).catch(() => {}));

  await rcon(`give ${TESTER} minecraft:coal 8`, `give ${TESTER} minecraft:oak_planks 8`);
  await waitFor(() => held("coal") >= 8 && held("oak_planks") >= 8, 8000, "coal and planks");
  assert.equal(needsTorches(bot), true, `starts short of torches: ${torchCount(bot)}`);
  // Up to three attempts: bot.craft() opens a real window and occasionally loses a race with the
  // server's inventory update, reporting "missing ingredient" for a chain that is actually
  // affordable (seen once here, 2026-10-07, and reproducible only intermittently). The chain
  // itself -- shaped recipes, planks into the stick a torch needs -- is pinned by a unit check.
  let made = null;
  for (let attempt = 0; attempt < 3 && !needsTorchesSatisfied(); attempt++) {
    made = await performAction(bot, { type: "craft", item: "torch", count: 4 }, TESTER);
    if (!made.ok) await sleep(1500);
  }
  function needsTorchesSatisfied() { return torchCount(bot) >= TORCH_CARRY_MIN; }
  assert(needsTorchesSatisfied(), `carrying ${torchCount(bot)} torches, wanted ${TORCH_CARRY_MIN}: ${made && made.text}`);

  // The trail reacts to a completed dig, so the event is what's driven here -- what the scenario
  // proves over the offline check is that the server accepts the reference block and face the
  // trail picks, that a real torch appears there, and that the measured light it creates is what
  // makes the next few digs skip.
  const trail = installTorchTrail(bot);
  scenarioCleanup.push(() => bot.removeAllListeners("diggingCompleted"));
  const lit = [];
  for (let step = 0; step <= 16; step += 3) {
    await rcon(`tp ${TESTER} ${x0 + step} ${y + 1} ${z}`);
    await waitFor(() => Math.abs(bot.entity.position.x - (x0 + step + 0.5)) < 1.5, 10_000, `tester at step ${step}`);
    bot.emit("diggingCompleted", bot.blockAt(new Vec3(x0 + step, y, z)));
    await sleep(800); // the server's light update for a placed torch lands a tick or two later
    if (trail.last && !lit.some((p) => p.equals(trail.last))) lit.push(trail.last);
  }
  assert(lit.length >= 2, `more than one torch down a 17-block tunnel: ${lit.map(String).join(" ")}`);
  for (let i = 1; i < lit.length; i++) {
    assert(lit[i].distanceTo(lit[i - 1]) >= TORCH_SPACING - 0.001,
      `at least ${TORCH_SPACING} blocks apart: ${lit[i - 1]} -> ${lit[i]}`);
  }
  for (const at of lit) assert.equal(bot.blockAt(at)?.name, "torch", `a real torch stands at ${at}`);
});

// ---- runner -------------------------------------------------------------------------------------
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: TESTER, auth: "offline" });
bot.loadPlugin(pathfinder);
loadActionPlugins(bot);

let failed = 0;
let ran = 0;
try {
  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    bot.once("kicked", (reason) => reject(new Error(`kicked: ${JSON.stringify(reason)}`)));
    bot.once("error", reject);
    setTimeout(() => reject(new Error("no spawn within 30s")), 30_000);
  });
  const movements = new Movements(bot);
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  installDoorSupport(bot); // as index.js does
  installEnchantsFix(bot);
  console.log(`connected as ${TESTER} to ${HOST}:${PORT} (${bot.version})`);
  await buildArena();

  for (const s of scenarios) {
    if (filters.length && !filters.some((f) => s.name.toLowerCase().includes(f.toLowerCase()))) continue;
    ran++;
    try {
      await resetTester();
      await s.fn();
      console.log(`PASS: ${s.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL: ${s.name}\n      ${err.message}`);
    } finally {
      while (scenarioCleanup.length) scenarioCleanup.pop()();
    }
  }
} catch (err) {
  failed++;
  console.log(`FAIL: live test setup -- ${err.message}`);
} finally {
  try {
    await rcon(`kill @e[tag=${TAG}]`, `clear ${TESTER}`, `forceload remove ${x - r} ${z - r} ${x + r} ${z + r}`);
  } catch (err) {
    console.log(`cleanup failed: ${err.message}`);
  }
  bot.quit();
  if (ownMemoryRoot) rmSync(process.env.MC_MEMORY_ROOT, { recursive: true, force: true });
}
console.log(`${ran - failed}/${ran} live scenarios passed.`);
process.exit(failed ? 1 : 0);
