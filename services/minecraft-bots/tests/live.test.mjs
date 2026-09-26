// Version: 1.11.0
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
// 1.0.1 | 2026-09-24 | First live run fixes: wait for the dead mob's removal, a 1000-HP husk for
//   lost-track (RCON takes ~8s, it used to die first), clear the spare helmet before re-equipping.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolation BEFORE the bot modules load: their memory paths are read at import time.
const ownMemoryRoot = !process.env.MC_MEMORY_ROOT;
process.env.MC_MEMORY_ROOT ||= mkdtempSync(path.join(os.tmpdir(), "mbtest-memory-"));
process.env.MC_RAG_DISABLED = "true";
process.env.MC_BED_CLAIMS_SHARED = "false"; // never write test claims into the fleet's hermes-memory
const { loadActionPlugins, performAction, checkClaimedBed, loadPenLocation, countInPen, loadClaimedBed } = await import("../actions.js");
const arbiter = await import("../arbiter.js");
const { equipBestArmor, installEnchantsFix } = await import("../equipment.js");
const { SwimMovements, installDoorSupport } = await import("../swim-movements.js");
const { isProtectedBlockName } = await import("../actions.js");

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

// A bed facing east: foot at (dx, dz), head one block east.
async function placeBed(dx, dz) {
  await rcon(`setblock ${x + dx} ${y + 1} ${z + dz} minecraft:red_bed[facing=east,part=foot]`,
    `setblock ${x + dx + 1} ${y + 1} ${z + dz} minecraft:red_bed[facing=east,part=head]`);
  await waitFor(() => bot.isABed(bot.blockAt(new Vec3(x + dx + 1, y + 1, z + dz))), 5000, "bed placed");
}

scenario("Beds: a destroyed claimed bed is replaced by the nearest unclaimed one", async () => {
  const bedsDir = path.join(process.env.MC_MEMORY_ROOT, "beds");
  const claim = (name, dx, dz) => writeFileSync(path.join(bedsDir, `${name}.json`),
    JSON.stringify({ x: x + dx, y: y + 1, z: z + dz }));
  mkdirSync(bedsDir, { recursive: true });
  scenarioCleanup.push(() => rmSync(bedsDir, { recursive: true, force: true }));
  await placeBed(2, 3); await placeBed(-3, 3); await placeBed(-6, -5);
  claim(TESTER, 2, 3);     // the tester's own bed, by its foot half
  claim("MBRival", -3, 3); // the nearest other bed belongs to someone else
  await rcon(`setblock ${x + 2} ${y + 1} ${z + 3} minecraft:air`, `setblock ${x + 3} ${y + 1} ${z + 3} minecraft:air`);
  await waitFor(() => !bot.isABed(bot.blockAt(new Vec3(x + 3, y + 1, z + 3))), 5000, "bed destroyed");
  const result = await checkClaimedBed(bot);
  assert.equal(result.status, "replaced", JSON.stringify(result));
  const now = JSON.parse(readFileSync(path.join(bedsDir, `${TESTER}.json`), "utf8"));
  assert.deepEqual(now, { x: x - 5, y: y + 1, z: z - 5 }, "claimed the free bed's head, not MBRival's");
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

scenario("Beds: crafts \"bed\" as the colour of the wool she holds", async () => {
  // No crafting table anywhere, as in a fresh world: craft has to make and place one first.
  await rcon(`give ${TESTER} minecraft:red_wool 3`, `give ${TESTER} minecraft:oak_planks 7`);
  await waitFor(() => held("red_wool") >= 3 && held("oak_planks") >= 7, 8000, "wool and planks");
  const result = await performAction(bot, { type: "craft", item: "bed", count: 1 }, TESTER);
  assert.equal(result.ok, true, result.text);
  await waitFor(() => held("red_bed") >= 1, 5000, "a red bed");
  assert(bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 6 }), "the table she made is standing");
});

scenario("Beds: places a bed at home as two blocks facing away from her, and claims it", async () => {
  const home = new Vec3(x - 4, y + 1, z - 4);
  const worldSpawn = bot.spawnPoint;
  bot.spawnPoint = home;
  scenarioCleanup.push(() => { bot.spawnPoint = worldSpawn; });
  await rcon(`give ${TESTER} minecraft:white_bed`);
  await waitFor(() => held("white_bed") >= 1, 5000, "a bed to place");
  const result = await performAction(bot, { type: "place_bed" }, TESTER);
  assert.equal(result.ok, true, result.text);
  const foot = new Vec3(result.bedAt.x, result.bedAt.y, result.bedAt.z);
  const halves = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => bot.blockAt(foot.offset(dx, 0, dz)))
    .filter((b) => bot.isABed(b));
  assert(bot.isABed(bot.blockAt(foot)) && halves.length >= 1, "both halves of the bed are there");
  assert(foot.distanceTo(home) >= 2 && foot.distanceTo(home) <= 11, `near home but not on it: ${foot}`);
  assert(await loadClaimedBed(bot), "she claimed the bed she placed");
});

// Shelters (2026-09-26): build on a chosen site from a mix of blocks (the old build needed 33+ of one
// kind), and the result has walls, a roof, a doorway and a hollow inside.
scenario("Shelters: builds a shelter on its site from mixed cobblestone and dirt", async () => {
  await rcon(`give ${TESTER} minecraft:cobblestone 16`, `give ${TESTER} minecraft:dirt 16`);
  await waitFor(() => held("cobblestone") >= 16 && held("dirt") >= 16, 8000, "mixed blocks");
  const site = new Vec3(x - 4, y + 1, z - 4);
  const result = await performAction(bot, { type: "build", at: { x: site.x, y: site.y, z: site.z } }, TESTER);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.built, true, result.text);
  let solid = 0, total = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx || dz) {
        if (dx === 0 && dz === 1) continue; // doorway
        for (let dy = 0; dy <= 2; dy++) { total++; if (bot.blockAt(site.offset(dx, dy, dz))?.boundingBox === "block") solid++; }
      }
      total++; if (bot.blockAt(site.offset(dx, 3, dz))?.boundingBox === "block") solid++; // roof
    }
  }
  assert(solid >= total * 0.8, `${solid}/${total} shelter blocks in place`);
  assert.notEqual(bot.blockAt(site)?.boundingBox, "block", "hollow inside");
  assert.notEqual(bot.blockAt(site.offset(0, 0, 1))?.boundingBox, "block", "the doorway is open");
  assert(held("cobblestone") < 16 && held("dirt") < 16, "both kinds of block were used");
});

const logCount = () => bot.inventory.items().filter((i) => i.name.endsWith("_log")).reduce((n, i) => n + i.count, 0);
async function placeChest(dx, dz, items) {
  const nbt = items.map(([id, count], slot) => `{Slot:${slot}b,id:"minecraft:${id}",count:${count}}`).join(",");
  await rcon(`setblock ${x + dx} ${y + 1} ${z + dz} minecraft:chest{Items:[${nbt}]}`);
  await waitFor(() => bot.blockAt(new Vec3(x + dx, y + 1, z + dz))?.name === "chest", 5000, "chest placed");
}

scenario("MB-17 chest: a mixed-species stack is withdrawn across types", async () => {
  await placeChest(3, 0, [["oak_log", 2], ["birch_log", 2]]);
  const result = await performAction(bot, { type: "mine", block: "oak_log", count: 4 }, TESTER);
  assert.equal(result.ok, true, `mine result: ${result.text}`);
  assert.match(result.text, /already in a chest/);
  assert.equal(logCount(), 4, "2 oak + 2 birch taken");
  assert.equal(bot.currentWindow, null, "chest closed afterwards");
});

scenario("MB-16 explore: a stocked chest doesn't satisfy scouting for a village", async () => {
  await placeChest(-3, 0, [["oak_log", 16]]);
  const result = await performAction(bot, { type: "explore", feature: "village" }, TESTER);
  assert.equal(result.ok, false, `explore result: ${result.text}`);
  assert.match(result.text, /no sign of a village/);
  assert.equal(logCount(), 0, "nothing withdrawn from the chest");
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
