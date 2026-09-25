// Version: 1.0.0
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
      MC_DUSK_CHECK_MS: "5000", MC_HOME_POS: HOME.join(","), ...env,
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
    async stop() { child.kill("SIGTERM"); await Promise.race([exited, sleep(10_000)]); child.kill("SIGKILL"); await sleep(3000); },
  };
  return probe;
}
async function bootProbe(memoryRoot, env) {
  startProbe(memoryRoot, env);
  await probe.waitLine(/\[MBProbe\] spawned at/, 60_000);
  await rcon(`tp ${PROBE} ${HOME[0]} ${HOME[1]} ${HOME[2]}`, `effect give ${PROBE} minecraft:resistance 900 4 true`,
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
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario("MB-06 STOP ends a long direct action within seconds", async () => {
  const root = newRoot();
  await rcon(`fill ${x - 8} ${y + 1} ${z + 4} ${x - 4} ${y + 3} ${z + 8} minecraft:oak_log`);
  await bootProbe(root);
  const t0 = Date.now();
  say("mine 60 oak_log for me right now");
  await waitFor(() => probeSaid(/./, t0), 60_000, "probe to acknowledge the command");
  await sleep(5000);
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
  // restart 1 (day): the resumed goal is announced to peers
  let t = Date.now();
  await bootProbe(root);
  await waitFor(() => published((b) => b.type === "goal" && b.status === "active" && b.description === "collect 12 oak_log", t),
    20_000, "resumed goal announced");
  await probe.stop();
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
