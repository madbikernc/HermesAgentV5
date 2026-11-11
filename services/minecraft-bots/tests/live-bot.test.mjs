// Version: 1.5.0
// 1.5.0 | 2026-11-11 | Full goal-loop regression for a completed shelter masking the new site.
//
// Full-bot live tests: runs a REAL bot process (index.js, as "MBProbe") against the bot-sandbox
// server and drives it the way a player would -- whispers from the MBTester bot, restarts, injected
// coordination messages -- to check the behaviors that only exist in the whole bot: STOP handling,
// goal identity, restart/resume, the night pause, inventory storing during a goal, and Mayor's
// curriculum persistence.
//
// Isolation (nothing touches the real fleet):
//   - a fake Buzz + hermes-memory server in this process (BUZZ_URL/MEMORY_URL), so the probe's
//     coordination traffic never reaches the fleet, and tests can inject and observe it
//   - MC_MEMORY_ROOT = a temp dir (goals, chests, beds, curriculum), MC_RAG_DISABLED=true
//   - MC_HOME_POS pins the probe's "home" to the arena; the real bots ignore MBProbe/MBTester chat
//   - no Matrix credentials; model calls go to the local hermes-router like any bot
//
// Run on spark:  node tests/live-bot.test.mjs [filter...]   (several minutes; model-dependent
// steps use generous timeouts)
//
// Revision History: 1.0.0 | 2026-09-25 | Initial scenarios for MB-05, MB-06, MB-09, MB-12, MB-14, MB-20.
// 1.0.1 | 2026-09-25 | Night-pause scenario holds the goal loop off in its first restart (the planner
//   could drop the seeded goal before the night restart), and every boot clears the probe's
//   cross-restart stuck state (repeated test restarts at one spot tripped the real wedge rescue).
// 1.0.2 | 2026-09-25 | The probe's server inventory is cleared at every boot (it persists between
//   runs), and the STOP scenario uses reachable floor-level logs and checks the action is still
//   running when STOP is sent.
// 1.1.0 | 2026-09-25 | Fight-or-flee at critical health (flee two, fight one), safe stuck rescue
//   after crash-restarts, clean restarts not counted as wedged (stuck state no longer cleared).
// 1.1.1 | 2026-09-25 | Fight-or-flee: arm the probe first, then summon the mobs beside it and damage it
//   in one RCON call (it used to flee unarmed out of range before the hit).
// 1.1.2 | 2026-10-07 | The access sweep and torch top-up are pushed out of this suite's way.
// 1.2.0 | 2026-11-04 | Full inventory with full chests drops only plain surplus; a Builder furnace not
//   in hand is crafted and placed by the runner, never asked of the planner. Every boot puts the probe
//   back in survival (a spectator MBProbe left over from another probe could not drop or craft).
// 1.3.0 | 2026-11-04 | Residences (a held bed goes into the empty shelter), trash into lava, out of a
//   deep pool to dry land with one emergency, and a new chest when every chest at home is full.
// 1.3.1 | 2026-11-05 | The full-chest scenario fills the chest only once the logs are in hand (it
//   raced the storage check during boot and the 10-minute chest retry outlasted the wait).
// 1.4.0 | 2026-11-06 | The Water scenario's pool is wide and shallow, and its shore must be above the
//   water, not the pool's own floor.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mineflayer from "mineflayer";

const execFileAsync = promisify(execFile);
const BOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const RCON = fileURLToPath(new URL("./live/rcon.py", import.meta.url));
const HOST = process.env.MC_HOST || "192.168.1.221";
const PORT = parseInt(process.env.MC_PORT || "25580", 10);
const TESTER = "MBTester";
const PROBE = "MBProbe";
const FLEET = "Babs,Amy,Mark,Luke,Mayor,Bob,Nell,Wade,Dale";
const ARENA = { x: 2000, y: 200, z: 2000, r: 10 };
const { x, y, z, r } = ARENA;
const HOME = [x + 5, y + 1, z - 5];
const filters = process.argv.slice(2);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function rcon(...commands) {
  const { stdout } = await execFileAsync("python3", [RCON, ...commands], { timeout: 90_000 });
  return stdout;
}
async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

// ---- fake Buzz + hermes-memory ------------------------------------------------------------------
const bus = [];
let seq = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const send = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && url.pathname === "/messages") {
      const m = JSON.parse(body || "{}");
      bus.push({ seq: ++seq, from_agent: m.from, topic: m.topic, body: m.body, at: Date.now() });
      return send({ seq });
    }
    if (req.method === "GET" && url.pathname === "/messages/poll") {
      const since = Number(url.searchParams.get("since") || 0);
      return send({ messages: bus.filter((m) => m.topic === url.searchParams.get("topic") && m.seq > since) });
    }
    if (url.pathname === "/turns") return send(req.method === "GET" ? { turns: [] } : { ok: true });
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const FAKE_URL = `http://127.0.0.1:${server.address().port}`;
const inject = (from, body) => bus.push({ seq: ++seq, from_agent: from, topic: "minecraft-coordination", body: JSON.stringify(body), at: Date.now() });
const published = (pred, since = 0) => bus.find((m) => m.from_agent === "mc-mbprobe" && m.at >= since && pred(safeJson(m.body)));
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// ---- the probe (a real bot process) -------------------------------------------------------------
let probe = null;
function startProbe(memoryRoot, env = {}) {
  const lines = [];
  const child = spawn(process.execPath, ["index.js"], {
    cwd: BOT_DIR,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      MC_HOST: HOST, MC_PORT: String(PORT), MC_BOT_USERNAME: PROBE, MC_BOT_USERNAMES: `${FLEET},${PROBE}`,
      MC_TEST_USERNAMES: "", MC_MEMORY_ROOT: memoryRoot, MC_RAG_DISABLED: "true",
      BUZZ_URL: FAKE_URL, BUZZ_TOKEN: "test", MEMORY_URL: FAKE_URL, MEMORY_TOKEN: "test",
      MC_SELF_PROPOSE_GOALS: "false", MC_GOAL_TICK_MS: "8000", MC_DUSK_START_TICK: "24000",
      MC_DUSK_CHECK_MS: "5000", MC_HOME_POS: HOME.join(","),
      // Pushed out of this suite's way (2026-10-07): neither routine is what these scenarios test,
      // and a torch top-up or an access sweep taking the arbiter mid-whisper is pure flakiness.
      // Their own coverage is in live.test.mjs and unit.test.mjs.
      MC_ACCESS_CHECK_MS: "3600000", MC_TORCH_SUPPLY_CHECK_MS: "3600000", ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let partial = "";
  const onData = (d) => {
    partial += d;
    const parts = partial.split("\n");
    partial = parts.pop();
    for (const l of parts) lines.push({ at: Date.now(), text: l });
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exited = new Promise((res) => child.on("exit", res));
  probe = {
    lines,
    since: (t, re) => lines.find((l) => l.at >= t && re.test(l.text)),
    waitLine: (re, ms, t = 0) => waitFor(() => lines.find((l) => l.at >= t && re.test(l.text)), ms, `probe line ${re}`),
    // SIGTERM is a clean stop (the bot records it, so it doesn't count toward the cross-restart
    // wedge streak); { crash: true } kills it outright, like a crash would.
    async stop({ crash = false } = {}) {
      child.kill(crash ? "SIGKILL" : "SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
      child.kill("SIGKILL");
      await sleep(3000);
    },
  };
  return probe;
}
async function bootProbe(memoryRoot, env) {
  startProbe(memoryRoot, env);
  await probe.waitLine(/\[MBProbe\] spawned at/, 60_000);
  // The server keeps MBProbe's inventory between runs; every scenario starts empty-handed. And its
  // game mode: a spectator probe (other probes log in as MBProbe that way) can't drop, craft or place.
  await rcon(`gamemode survival ${PROBE}`, `clear ${PROBE}`, `tp ${PROBE} ${HOME[0]} ${HOME[1]} ${HOME[2]}`, `effect give ${PROBE} minecraft:resistance 900 4 true`,
    `effect give ${PROBE} minecraft:saturation 1 20 true`);
  await sleep(8000); // let its Buzz watchers prime, so injected messages count as new
}

// ---- the driver (MBTester) ----------------------------------------------------------------------
const tester = mineflayer.createBot({ host: HOST, port: PORT, username: TESTER, auth: "offline" });
const whispers = [];
tester.on("whisper", (from, message) => { if (from === PROBE) whispers.push({ at: Date.now(), message }); });
const say = (msg) => tester.whisper(PROBE, msg);
const probeSaid = (re, t) => whispers.find((w) => w.at >= t && re.test(w.message));

function newRoot() { const d = mkdtempSync(path.join(os.tmpdir(), "mbprobe-memory-")); roots.push(d); return d; }
const goalFile = (root) => path.join(root, "bots", "mbprobe", "goal.json");
function seedGoal(root, description, extra = {}) {
  mkdirSync(path.dirname(goalFile(root)), { recursive: true });
  const at = Date.now() - 3_600_000;
  writeFileSync(goalFile(root), JSON.stringify({ description, source: "user", setBy: TESTER, createdAt: at, updatedAt: at,
    sawSuccess: false, steps: 0, consecutiveFailures: 0, log: [], actionsTaken: [], servedBySkill: true, ...extra }));
}
async function arena() {
  await rcon(`forceload add ${x - r} ${z - r} ${x + r} ${z + r}`,
    `fill ${x - r} ${y} ${z - r} ${x + r} ${y} ${z + r} minecraft:sea_lantern`,
    `fill ${x - r + 1} ${y + 1} ${z - r + 1} ${x + r - 1} ${y + 4} ${z + r - 1} minecraft:air`,
    `kill @e[type=minecraft:item,x=${x - r},y=${y},z=${z - r},dx=${2 * r},dy=6,dz=${2 * r}]`,
    `tp ${TESTER} ${x} ${y + 1} ${z}`, `effect give ${TESTER} minecraft:resistance 900 4 true`);
}

// ---- scenarios -------------------------------------------------------------------------------------
const scenarios = [];
const scenarioCleanup = []; // undo steps a scenario registers; run after it, pass or fail
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario("MB-06 STOP ends a long direct action within seconds", async () => {
  const root = newRoot();
  // One floor-level layer: every log is reachable, so the action is long but never path-blocked.
  await rcon(`fill ${x - 8} ${y + 1} ${z - 8} ${x + 8} ${y + 1} ${z - 6} minecraft:oak_log`,
    `fill ${x - 8} ${y + 1} ${z + 6} ${x + 8} ${y + 1} ${z + 8} minecraft:oak_log`);
  await bootProbe(root);
  const t0 = Date.now();
  say("mine 60 oak_log for me right now");
  await waitFor(() => probeSaid(/./, t0), 60_000, "probe to acknowledge the command");
  await sleep(5000);
  assert(!probe.since(t0, /OUTCOME {"type":"mine"/), "setup: the mine action was still running when STOP was sent");
  const tStop = Date.now();
  say("stop");
  const reply = await waitFor(() => probeSaid(/stopping/i, tStop), 10_000, "a 'stopping' reply");
  assert(reply.at - tStop < 10_000, `stop acknowledged in ${reply.at - tStop}ms`);
  await probe.waitLine(/OUTCOME \{"type":"mine".*"cancelled":true/, 15_000, tStop);
});

scenario("MB-05 STOP mid-goal drops the goal and no later step lands in it", async () => {
  const root = newRoot();
  await rcon(`fill ${x - 8} ${y + 1} ${z + 4} ${x - 4} ${y + 3} ${z + 8} minecraft:oak_log`);
  await bootProbe(root);
  const t0 = Date.now();
  say("new standing goal for you: collect 40 oak_log");
  const active = await waitFor(() => published((b) => b.type === "goal" && b.status === "active", t0), 90_000, "goal to go active");
  const description = safeJson(active.body).description;
  await probe.waitLine(/goal plan:/, 60_000, t0);
  const tStop = Date.now();
  say("stop");
  await waitFor(() => published((b) => b.type === "goal" && b.status === "abandoned" && b.description === description, tStop),
    15_000, "goal abandoned");
  await sleep(20_000);
  assert(!probe.since(tStop + 2000, /goal step: \w+ -> .*\(ok=true/), "no goal step recorded after STOP");
  assert(!existsSync(goalFile(root)) || !safeJson(readFileSync(goalFile(root), "utf8")).description,
    "persisted goal cleared");
});

scenario("MB-12/MB-14 restart re-announces the goal; night pauses it; morning resumes it", async () => {
  const root = newRoot();
  seedGoal(root, "collect 12 oak_log");
  // restart 1 (day): the resumed goal is announced to peers. The goal loop is held off so the
  // planner can't finish or drop the seeded goal before the night restart.
  let t = Date.now();
  await bootProbe(root, { MC_GOAL_TICK_MS: "600000" });
  await waitFor(() => published((b) => b.type === "goal" && b.status === "active" && b.description === "collect 12 oak_log", t),
    20_000, "resumed goal announced");
  await probe.stop();
  assert.equal(safeJson(readFileSync(goalFile(root), "utf8")).description, "collect 12 oak_log", "goal still saved");
  // restart 2 (night): paused -- no planning
  t = Date.now();
  await bootProbe(root, { MC_DUSK_START_TICK: "0" });
  await probe.waitLine(/dusk -- pausing goal until morning/, 30_000, t);
  const tPaused = Date.now();
  await sleep(25_000);
  assert(!probe.since(tPaused, /goal plan:/), "no planning while paused for the night");
  await probe.stop();
  // restart 3 (day again): planning resumes on the same goal
  t = Date.now();
  await bootProbe(root);
  await probe.waitLine(/goal plan:/, 60_000, t);
});

scenario("MB-09 inventory-full storing keeps the goal's materials", async () => {
  const root = newRoot();
  seedGoal(root, "craft a furnace");
  await rcon(`setblock ${HOME[0] + 2} ${HOME[1]} ${HOME[2]} minecraft:chest`);
  await bootProbe(root, { MC_GOAL_TICK_MS: "600000", MC_INVENTORY_CHECK_MS: "5000" });
  const junk = ["dirt", "sand", "gravel", "andesite", "diorite", "granite", "clay_ball", "flint", "feather", "string",
    "bone", "gunpowder", "leather", "paper", "sugar", "wheat_seeds", "pumpkin_seeds", "melon_seeds", "beetroot_seeds",
    "egg", "snowball", "glass", "sandstone", "terracotta", "brick", "nether_brick", "quartz", "amethyst_shard",
    "prismarine_shard", "slime_ball", "ink_sac", "glowstone_dust"];
  const t0 = Date.now();
  await rcon(`give ${PROBE} minecraft:cobblestone 64`, ...junk.map((j) => `give ${PROBE} minecraft:${j} 1`));
  await probe.waitLine(/inventory management: /, 90_000, t0);
  assert(!probe.since(t0, /inventory management: .*cobblestone/), "cobblestone (a furnace input) was never stored");
  const out = await rcon(`clear ${PROBE} minecraft:cobblestone 0`);
  assert.match(out, /Found 64 matching/, `probe still has all 64 cobblestone (${out.trim()})`);
});

// 2026-11-04 (24h review): Babs at 36/36 slots, every chest at home full ("destination full"), and
// nothing but the storage backoff ever happened (index.js 2.133.0). Full chest, full probe, no wood:
// she drops the plain surplus -- spare bows and crossbows, seeds past 64, rotten flesh -- and nothing else.
scenario("Inventory: full, with the only chest at home full, plain surplus is dropped and the rest kept", async () => {
  const root = newRoot();
  const [cx, cy, cz] = [HOME[0] + 2, HOME[1], HOME[2]];
  await rcon(`setblock ${cx} ${cy} ${cz} minecraft:chest`,
    ...Array.from({ length: 27 }, (_, i) => `item replace block ${cx} ${cy} ${cz} container.${i} with minecraft:cobblestone 64`));
  await bootProbe(root, { MC_GOAL_TICK_MS: "600000", MC_INVENTORY_CHECK_MS: "5000" });
  const other = ["dirt", "sand", "gravel", "andesite", "diorite", "granite", "clay_ball", "flint", "feather", "string",
    "bone", "gunpowder"];
  const t0 = Date.now();
  await rcon(...Array.from({ length: 10 }, () => `give ${PROBE} minecraft:bow 1`),
    ...Array.from({ length: 4 }, () => `give ${PROBE} minecraft:crossbow 1`),
    `give ${PROBE} minecraft:wheat_seeds 576`, `give ${PROBE} minecraft:rotten_flesh 5`,
    ...other.map((o) => `give ${PROBE} minecraft:${o} 1`));
  await probe.waitLine(/inventory full, every chest at home full: dropped /, 120_000, t0);
  await sleep(3000);
  const count = async (item) => Number((await rcon(`clear ${PROBE} minecraft:${item} 0`)).match(/Found (\d+)/)?.[1] ?? 0);
  assert.equal(await count("bow"), 1, "one bow kept");
  assert.equal(await count("crossbow"), 1, "one crossbow kept");
  assert.equal(await count("wheat_seeds"), 64, "a stack of seeds kept");
  for (const o of other) assert.equal(await count(o), 1, `${o} kept`);
});

// 2026-11-04: "go home and place a furnace there" without a furnace in hand went to the planner,
// which answered DONE NONE 421 times a day. The Builder runner makes one from the cobblestone she
// holds, beside a crafting table, and puts it down at home.
scenario("Builder: a furnace she doesn't hold is crafted and placed at home by the runner", async () => {
  const root = newRoot();
  seedGoal(root, "go home and place a furnace there", { builderPriorityItem: "furnace", servedBySkill: false });
  await rcon(`setblock ${HOME[0] - 2} ${HOME[1]} ${HOME[2]} minecraft:crafting_table`);
  // The first tick a minute out: the cobblestone (given after boot clears her inventory) has to land
  // first -- an RCON step can take seconds, and three failed ticks 2s apart abandon the goal.
  await bootProbe(root, { MC_GOAL_TICK_MS: "60000" });
  const t0 = Date.now();
  await rcon(`give ${PROBE} minecraft:cobblestone 8`);
  assert.match(await rcon(`clear ${PROBE} minecraft:cobblestone 0`), /Found 8 matching/, "cobblestone in hand before the first tick");
  await probe.waitLine(/builder furnace: /, 90_000, t0);
  await probe.waitLine(/goal complete \(placed furnace at home\)/, 120_000, t0);
  assert(!probe.since(t0, /goal plan: DONE NONE/), "the planner was never asked");
});

// Direct request, 2026-11-04: a bed for each ACTIVE bot, in an existing shelter with room before a
// new one. Two shelters at home: one a full residence (bed, chest, door), one empty. The probe,
// online with the fleet's own bots, holds a bed: it goes into the empty shelter (the old code was
// done the moment HER nearest shelter had a bed).
function rconShelter(bx, by, bz, { bed = false, chest = false } = {}) {
  return [`fill ${bx - 1} ${by - 1} ${bz - 1} ${bx + 2} ${by + 3} ${bz + 3} minecraft:cobblestone hollow`,
    `setblock ${bx} ${by} ${bz + 3} minecraft:oak_door[facing=north,half=lower]`,
    `setblock ${bx} ${by + 1} ${bz + 3} minecraft:oak_door[facing=north,half=upper]`,
    ...(bed ? [`setblock ${bx} ${by} ${bz} minecraft:white_bed[facing=north,part=head]`,
      `setblock ${bx} ${by} ${bz + 1} minecraft:white_bed[facing=north,part=foot]`] : []),
    ...(chest ? [`setblock ${bx + 1} ${by} ${bz + 2} minecraft:chest`] : [])];
}
scenario("Residences: a held bed goes into the empty shelter, not counted done by the bedded one", async () => {
  const root = newRoot();
  const [ax, ay, az] = [HOME[0] - 8, HOME[1], HOME[2] + 2], [ex, ey, ez] = [HOME[0] - 3, HOME[1], HOME[2] + 2];
  await rcon(...rconShelter(ax, ay, az, { bed: true, chest: true }), ...rconShelter(ex, ey, ez));
  scenarioCleanup.push(() => rcon(`fill ${ax - 1} ${ay - 1} ${az - 1} ${ex + 2} ${ey + 3} ${ez + 3} minecraft:air`,
    `fill ${ax - 1} ${ay - 1} ${az - 1} ${ex + 2} ${ay - 1} ${ez + 3} minecraft:sea_lantern`));
  seedGoal(root, "our residences need beds -- make a bed and place it in the empty shelter near home.",
    { survivalPriorityItem: "shelter", servedBySkill: false });
  await bootProbe(root, { MC_GOAL_TICK_MS: "60000" });
  await rcon(`give ${PROBE} minecraft:white_bed 1`);
  assert.match(await rcon(`clear ${PROBE} minecraft:white_bed 0`), /Found 1 matching/, "bed in hand before the first tick");
  const t0 = Date.now();
  await probe.waitLine(/shelter goal: .*\(ok=true\)/, 150_000, t0);
  const bedIn = async (bx, by, bz) => {
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      if (/passed/.test(await rcon(`execute if block ${bx + dx} ${by} ${bz + dz} #minecraft:beds`))) return true;
    }
    return false;
  };
  await sleep(1000);
  assert.equal(await bedIn(ex, ey, ez), true, "the empty shelter now has a bed");
});

scenario("Residences: an existing complete shelter does not satisfy the new build site", async () => {
  const root = newRoot();
  const [ax, ay, az] = [HOME[0] - 2, HOME[1], HOME[2] + 2];
  const [bx, by, bz] = [HOME[0] - 8, HOME[1], HOME[2] + 2];
  const hole = `${bx - 1} ${by + 1} ${bz}`;
  scenarioCleanup.push(() => rcon(
    `fill ${bx - 1} ${by} ${bz - 1} ${ax + 2} ${ay + 3} ${az + 3} minecraft:air`,
    `fill ${bx - 1} ${by - 1} ${bz - 1} ${ax + 2} ${ay - 1} ${az + 3} minecraft:sea_lantern`));
  await rcon(...rconShelter(ax, ay, az, { bed: true, chest: true }),
    ...rconShelter(bx, by, bz), `setblock ${hole} minecraft:air`);
  assert.match(await rcon(`execute if block ${hole} minecraft:air`), /passed/);
  seedGoal(root, "Build a second residence near home.", {
    survivalPriorityItem: "shelter", servedBySkill: false, shelterAt: { x: ax, y: ay, z: az },
  });
  await bootProbe(root, {
    MC_BOT_USERNAMES: `${PROBE},${TESTER}`, MC_GOAL_TICK_MS: "60000",
    MC_SHELTER_INTEGRITY_CHECK_MS: "3600000",
  });
  await rcon(`give ${PROBE} minecraft:cobblestone 32`);
  const step = await probe.waitLine(/shelter goal: .*\(ok=(true|false)\)/, 150_000);
  assert.match(step.text, /ok=true/);
  assert.match(await rcon(`execute if block ${hole} minecraft:cobblestone`), /passed/,
    "the goal must place the missing block at the second site");
});

// Direct request, 2026-11-04: "'trash' items like almost broken weapons, zombie flesh can be disposed
// of in lava". A lava pit in the arena floor (bedrock under it, so it can't pour out); the probe
// holds a spent iron sword, a good diamond one, rotten flesh and bread.
scenario("Trash: a spent sword and rotten flesh go into the lava; the good sword and the bread stay", async () => {
  const root = newRoot();
  const [lx, ly, lz] = [HOME[0] + 3, y, HOME[2]];
  await rcon(`setblock ${lx} ${ly - 1} ${lz} minecraft:bedrock`, `setblock ${lx} ${ly} ${lz} minecraft:lava`);
  scenarioCleanup.push(() => rcon(`setblock ${lx} ${ly} ${lz} minecraft:sea_lantern`, `setblock ${lx} ${ly - 1} ${lz} minecraft:air`));
  await bootProbe(root, { MC_GOAL_TICK_MS: "600000", MC_TRASH_CHECK_MS: "5000" });
  const t0 = Date.now();
  await rcon(`give ${PROBE} minecraft:iron_sword[minecraft:damage=240]`, `give ${PROBE} minecraft:diamond_sword`,
    `give ${PROBE} minecraft:rotten_flesh 4`, `give ${PROBE} minecraft:bread 2`);
  await probe.waitLine(/trash: threw /, 90_000, t0);
  await sleep(3000);
  const count = async (item) => Number((await rcon(`clear ${PROBE} minecraft:${item} 0`)).match(/Found (\d+)/)?.[1] ?? 0);
  assert.equal(await count("iron_sword"), 0, "the spent sword is gone");
  assert.equal(await count("rotten_flesh"), 0, "the flesh is gone");
  assert.equal(await count("diamond_sword"), 1, "the good sword stays");
  assert.equal(await count("bread"), 2, "food stays");
});

// Direct report, 2026-11-04: "the bots do not seem to be able to get out of water". A pool six
// cut into the arena floor beside dry floor; the probe starts at the bottom. It surfaces once
// and swims to land -- the old shore search never matched anything.
scenario("Water: from the bottom of a deep pool she surfaces once and reaches dry land", async () => {
  const root = newRoot();
  // 2026-11-06: wide and shallow, like the sea -- from mid-pool its own bottom (2 down) is nearer than
  // the floor round it (7 across), which is what made the live "shore" the sea floor. The old pool,
  // 5 wide and 6 deep, had dry floor nearer than its bottom and could not catch that.
  const [px, pz, R] = [1997, 2003, 6];
  await rcon(`fill ${px - R - 1} ${y - 3} ${pz - R - 1} ${px + R + 1} ${y} ${pz + R + 1} minecraft:glass`,
    `fill ${px - R} ${y - 2} ${pz - R} ${px + R} ${y} ${pz + R} minecraft:water`);
  scenarioCleanup.push(() => rcon(`fill ${px - R - 1} ${y - 3} ${pz - R - 1} ${px + R + 1} ${y - 1} ${pz + R + 1} minecraft:air`,
    `fill ${px - R - 1} ${y} ${pz - R - 1} ${px + R + 1} ${y} ${pz + R + 1} minecraft:sea_lantern`));
  await bootProbe(root, { MC_GOAL_TICK_MS: "600000" });
  const t0 = Date.now();
  await rcon(`tp ${PROBE} ${px} ${y - 2} ${pz}`);
  await probe.waitLine(/EMERGENCY: oxygen critical/, 60_000, t0);
  const heading = await probe.waitLine(/heading for dry land at/, 20_000, t0);
  // 2026-11-06: up on the floor, not the pool's own bottom -- a water block over glass passed as
  // dry land, and live the "shore" was the sea floor.
  const shoreY = Number(heading.text.match(/y: (-?\d+)/)?.[1]);
  assert(shoreY > y, `the shore is above the water, not under it (y=${shoreY}, surface ${y})`);
  await probe.waitLine(/reached shore attempt finished \(isInWater=false\)/, 30_000, t0);
  const emergencies = probe.lines.filter((l) => l.at >= t0 && /EMERGENCY: oxygen critical/.test(l.text)).length;
  assert(emergencies <= 1, `one emergency, not a burst (${emergencies})`);
});

// Direct request, 2026-11-04: "when a chest is full, they should build another chest". The only
// chest at home is full; the probe has room in her own inventory and three logs.
scenario("Chests: with every chest at home full, she makes and places another one", async () => {
  const root = newRoot();
  const [cx, cy, cz] = [HOME[0] + 2, HOME[1], HOME[2]];
  await bootProbe(root, { MC_GOAL_TICK_MS: "600000", MC_INVENTORY_CHECK_MS: "5000", MC_SURPLUS_SHARING_CHECK_MS: "5000" });
  const t0 = Date.now();
  await rcon(`give ${PROBE} minecraft:oak_log 3`, `give ${PROBE} minecraft:dirt 20`, `give ${PROBE} minecraft:sand 20`,
    `give ${PROBE} minecraft:crafting_table 1`);
  // The full chest only once the logs are in hand (2026-11-05): set up before boot, the storage
  // check found it full while she was still empty-handed, the chest attempt failed "need wood",
  // and its 10-minute retry outlasted this scenario.
  await sleep(5000);
  await rcon(`setblock ${cx} ${cy} ${cz} minecraft:chest`,
    ...Array.from({ length: 27 }, (_, i) => `item replace block ${cx} ${cy} ${cz} container.${i} with minecraft:cobblestone 64`));
  await probe.waitLine(/storage: no usable chest space/, 90_000, t0);
  await probe.waitLine(/chests full, every chest at home full: placed a chest at home/, 150_000, t0);
});

scenario("MB-20 Mayor keeps curriculum evidence across a restart", async () => {
  const root = newRoot();
  const mayorEnv = { MC_MAYOR_USERNAME: PROBE };
  await bootProbe(root, mayorEnv);
  const t0 = Date.now();
  inject("mc-babs", { type: "goal", status: "done", description: "basic tools", item: "wooden_pickaxe", have: ["wooden_pickaxe", "wooden_axe"] });
  await probe.waitLine(/curriculum: Babs cleared "basic tools"/, 30_000, t0);
  await probe.stop();
  const saved = JSON.parse(readFileSync(path.join(root, "mayor-curriculum.json"), "utf8"));
  assert(saved.stageProgress.includes("Babs"));
  assert.deepEqual([...saved.evidence.Babs].sort(), ["wooden_axe", "wooden_pickaxe"]);
  const t1 = Date.now();
  await bootProbe(root, mayorEnv);
  inject("mc-babs", { type: "goal", status: "done", description: "something else", item: "wooden_axe", have: ["wooden_axe"] });
  await sleep(15_000);
  assert(!probe.since(t1, /curriculum: Babs cleared/), "Babs's progress survived the restart (not re-cleared)");
  const after = JSON.parse(readFileSync(path.join(root, "mayor-curriculum.json"), "utf8"));
  assert(after.stageProgress.includes("Babs"));
});

scenario("Stuck rescue: clean restarts aren't 'wedged'; a crash-loop rescue lands safely", async () => {
  const root = newRoot();
  for (let i = 0; i < 3; i++) { await bootProbe(root); await probe.stop(); }
  const t0 = Date.now();
  await bootProbe(root);
  await sleep(5000);
  assert(!probe.since(t0, /likely wedged across restarts/), "three clean restarts in one spot are not a wedge");
  await probe.stop({ crash: true });
  // Crash-restarts in one spot ARE the wedge signal: the rescue fires, and must land safely.
  // /spreadplayers needs op; the real bots are ops, the probe only for this scenario.
  await rcon(`op ${PROBE}`);
  scenarioCleanup.push(() => rcon(`deop ${PROBE}`));
  let rescuedAt = 0;
  for (let i = 0; i < 4 && !rescuedAt; i++) {
    const t = Date.now();
    await bootProbe(root);
    await sleep(6000);
    if (probe.since(t, /TELEPORT: reconnected at the same spot/)) rescuedAt = Date.now();
    else await probe.stop({ crash: true });
  }
  assert(rescuedAt, "crash-restarts in one spot trigger the wedge rescue");
  await sleep(8000);
  assert(!probe.since(rescuedAt - 6000, /\] died at /), "the rescue teleport didn't kill it (no suffocation)");
  const pos = await rcon(`data get entity ${PROBE} Pos`);
  const [px, , pz] = (pos.match(/\[([^\]]+)\]/)?.[1] ?? "").split(",").map((v) => parseFloat(v));
  assert(Math.abs(px - HOME[0]) <= 6 && Math.abs(pz - HOME[2]) <= 6, `landed near home (${pos.trim()})`);
});

scenario("Fight-or-flee: at critical health the probe flees two mobs but fights one", async () => {
  // Summoned right beside the probe, wherever it is, in the same RCON call as the damage -- so it
  // can't have wandered or fled out of range first.
  const husk = (dx) => `execute at ${PROBE} run summon minecraft:husk ~${dx} ~ ~ ` +
    `{NoAI:1b,PersistenceRequired:1b,Health:1000f,attributes:[{id:"minecraft:max_health",base:1000}],Tags:["mbtest"]}`;
  // Each check gets a fresh probe: a flee/fight against a 1000-HP mob can hold the emergency
  // tier for a long time, and a second critical hit would be ignored while it's in flight.
  // 2026-10-30: killed in cleanup, pass or fail -- these 1000-HP no-AI husks outlive the scenario
  // otherwise, and the next run's stuck-rescue probe fled one away from home.
  scenarioCleanup.push(() => rcon(`kill @e[tag=mbtest]`));
  const critical = async (count) => {
    if (probe) await probe.stop();
    await bootProbe(newRoot());
    // Armed first (an unarmed bot always flees, which isn't what this checks).
    await rcon(`kill @e[tag=mbtest]`, `give ${PROBE} minecraft:iron_sword`, `effect clear ${PROBE}`,
      `effect give ${PROBE} minecraft:instant_health 1 5 true`);
    await sleep(4000);
    const t = Date.now();
    await rcon(...Array.from({ length: count }, (_, i) => husk(1 + i)), `damage ${PROBE} 15 minecraft:generic`);
    const line = await probe.waitLine(/EMERGENCY: health critical .* force-cancelling current action to (flee|attack)/, 15_000, t);
    await rcon(`effect give ${PROBE} minecraft:instant_health 1 5 true`, `effect give ${PROBE} minecraft:resistance 900 4 true`);
    return line.text.match(/to (flee|attack)$/)[1];
  };
  assert.equal(await critical(2), "flee", "outnumbered at critical health");
  assert.equal(await critical(1), "attack", "one melee mob at critical health");
});

// ---- runner -------------------------------------------------------------------------------------
let failed = 0;
let ran = 0;
const roots = [];
try {
  await new Promise((resolve, reject) => {
    tester.once("spawn", resolve);
    tester.once("kicked", (reason) => reject(new Error(`kicked: ${JSON.stringify(reason)}`)));
    setTimeout(() => reject(new Error("tester: no spawn within 30s")), 30_000);
  });
  console.log(`connected as ${TESTER}; fake Buzz/memory at ${FAKE_URL}`);
  for (const s of scenarios) {
    if (filters.length && !filters.some((f) => s.name.toLowerCase().includes(f.toLowerCase()))) continue;
    ran++;
    try {
      await arena();
      await s.fn();
      console.log(`PASS: ${s.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL: ${s.name}\n      ${err.message}`);
      if (probe) console.log(probe.lines.slice(-15).map((l) => `      | ${l.text.slice(0, 160)}`).join("\n"));
    } finally {
      if (probe) await probe.stop();
      while (scenarioCleanup.length) await scenarioCleanup.pop()();
      probe = null;
    }
  }
} catch (err) {
  failed++;
  console.log(`FAIL: live-bot setup -- ${err.message}`);
} finally {
  try {
    await rcon(`clear ${TESTER}`, `kill @e[type=minecraft:item,x=${x - r},y=${y},z=${z - r},dx=${2 * r},dy=6,dz=${2 * r}]`,
      `forceload remove ${x - r} ${z - r} ${x + r} ${z + r}`);
  } catch (err) {
    console.log(`cleanup failed: ${err.message}`);
  }
  tester.quit();
  server.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
}
console.log(`${ran - failed}/${ran} live-bot scenarios passed.`);
process.exit(failed ? 1 : 0);
