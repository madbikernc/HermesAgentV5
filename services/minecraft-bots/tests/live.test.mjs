// Version: 1.1.0
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
// Scenarios never touch chests: chest snapshots go into the fleet's shared known_chests.json.
// Every behavior fix that is observable in-world should add a scenario here (see tests/README.md).
//
// Revision History: 1.0.0 | 2026-09-24 | Initial scenarios for MB-01, MB-02/04, MB-07, MB-15.
// 1.1.0 | 2026-09-24 | Scenarios for MB-02 (takeover closes an open window) and MB-08 (place_home).
// 1.0.1 | 2026-09-24 | First live run fixes: wait for the dead mob's removal, a 1000-HP husk for
//   lost-track (RCON takes ~8s, it used to die first), clear the spare helmet before re-equipping.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { loadActionPlugins, performAction } from "../actions.js";
import * as arbiter from "../arbiter.js";
import { equipBestArmor } from "../equipment.js";

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
}
console.log(`${ran - failed}/${ran} live scenarios passed.`);
process.exit(failed ? 1 : 0);
