// Version: 1.0.0
// 1.0.0 | 2026-11-11 | Disposable-world Buzz handoff and paired planner load trials.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const botDir = fileURLToPath(new URL("../", import.meta.url));
const buzzFile = fileURLToPath(new URL("../../../tools/hermes-buzz.py", import.meta.url));
const names = ["Babs", "Amy", "Mark", "Nell", "Wade", "Luke"];
const seeds = (process.env.MB_MULTI_SEEDS || "173,419").split(",");
const budget = 240_000;
const router = process.env.HERMES_ROUTER_URL || "http://127.0.0.1:8080/v1/chat/completions";
const remote = process.env.MB_MULTI_SSH;
const remoteScript = process.env.MB_MULTI_REMOTE_SCRIPT;
const lanHost = process.env.MB_MULTI_LAN_HOST;
const handoffItem = "raw_iron";

async function until(check, deadline, label) {
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function child(command, args, options) {
  const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
  const lines = [];
  for (const stream of [proc.stdout, proc.stderr]) {
    readline.createInterface({ input: stream }).on("line", (line) => {
      lines.push(line);
      if (lines.length > 150) lines.shift();
    });
  }
  proc.stdin.on("error", () => {});
  let finished = false;
  const done = new Promise((resolve) => {
    proc.once("error", (error) => { lines.push(error.message); finished = true; resolve(); });
    proc.once("exit", () => { finished = true; resolve(); });
  });
  return {
    proc, lines,
    check() {
      if (finished) throw new Error(`${command} exited\n${lines.slice(-15).join("\n")}`);
    },
    async stop() {
      if (finished) return;
      proc.stdin.end();
      if (command !== "ssh") proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
      try { await done; } finally { clearTimeout(timer); }
    },
  };
}

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function freePort(host) {
  const server = net.createServer();
  const port = await listen(server, host);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startBot(root, env, goal) {
  const goalPath = path.join(root, "bots", env.MC_BOT_USERNAME.toLowerCase());
  if (goal) {
    await mkdir(goalPath, { recursive: true });
    await writeFile(path.join(goalPath, "goal.json"), JSON.stringify(goal));
  }
  return child(process.execPath, ["index.js"], {
    cwd: botDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MC_MEMORY_ROOT: root, ...env },
  });
}

// SSH mode uses the same checked-out test file on spark2. EOF on SSH stdin stops the remote bot.
async function worker() {
  const input = readline.createInterface({ input: process.stdin });
  const [line] = await new Promise((resolve, reject) => {
    input.once("line", (...args) => { input.pause(); resolve(args); });
    input.once("close", () => reject(new Error("missing worker configuration")));
  });
  const { env, goal } = JSON.parse(line);
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-remote-bot-"));
  let actor;
  try {
    actor = await startBot(root, env, goal);
    actor.proc.stdout.pipe(process.stdout, { end: false });
    actor.proc.stderr.pipe(process.stderr, { end: false });
    await new Promise((resolve) => {
      actor.proc.once("exit", resolve);
      actor.proc.once("error", resolve);
      input.once("close", resolve);
      input.resume();
    });
  } finally {
    input.close();
    await actor?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function trial(jar, seed, mode, count) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-minecraft-trial-"));
  const processes = [];
  const actors = [];
  const plannerMs = [];
  const plannedBy = new Set();
  let plannerErrors = 0;
  let proxy;
  const team = names.slice(0, count);
  const crossHost = mode === "handoff" && !!remote;
  const bind = crossHost ? lanHost : "127.0.0.1";
  const token = randomBytes(16).toString("hex");
  const password = randomBytes(16).toString("hex");
  let startedAt;
  const milestones = {};
  try {
    const gamePort = await freePort(bind);
    let rconPort = await freePort(bind);
    while (rconPort === gamePort) rconPort = await freePort(bind);
    const rcon = async (command) => (await exec(process.env.MB_MULTI_MCRCON || "mcrcon",
      ["-H", bind, "-P", String(rconPort), command], {
        env: { ...process.env, MCRCON_PASS: password }, timeout: 8000,
      })).stdout;
    const inventory = async (player, item) => {
      const output = await rcon(`clear ${player} minecraft:${item} 0`);
      const found = output.match(/Found (\d+) matching/);
      if (found) return Number(found[1]);
      if (/No items were found/.test(output)) return 0;
      throw new Error(`unexpected inventory response for ${player}: ${output.trim()}`);
    };
    await writeFile(path.join(root, "eula.txt"), "eula=true\n");
    await writeFile(path.join(root, "server.properties"), [
      `server-ip=${bind}`, `server-port=${gamePort}`, `rcon.port=${rconPort}`, `rcon.password=${password}`,
      "enable-rcon=true", "online-mode=false", "enforce-secure-profile=false",
      "level-name=trial", `level-seed=${seed}`,
      "level-type=minecraft:flat", "generate-structures=false", "difficulty=peaceful",
      "view-distance=5", "simulation-distance=5", "spawn-protection=0", "allow-flight=true",
    ].join("\n") + "\n");
    const game = child(process.env.MB_MULTI_JAVA || "java", ["-Xmx2G", "-jar", jar, "nogui"], { cwd: root });
    processes.push(game);
    await until(async () => {
      game.check();
      return game.lines.some((line) => /Done \([\d.]+s\)!/.test(line));
    }, Date.now() + 180_000, "fresh Java world");
    assert.match(await rcon("list"), /There are 0 of a max of/);
    const buzzPort = await freePort(bind);
    const buzz = child(process.env.MB_MULTI_PYTHON || "python3", [buzzFile], {
      cwd: root, env: { PATH: process.env.PATH, BUZZ_BIND: bind, BUZZ_PORT: String(buzzPort),
        BUZZ_DB: path.join(root, "buzz.db"), BUZZ_TOKEN: token },
    });
    processes.push(buzz);
    const buzzUrl = `http://${bind}:${buzzPort}`;
    await until(async () => {
      buzz.check();
      return fetch(`${buzzUrl}/health`, { signal: AbortSignal.timeout(2000) })
        .then((response) => response.ok).catch(() => false);
    }, Date.now() + 15_000, "isolated Buzz");

    proxy = http.createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        const planning = body.messages[0]?.content.match(/^You are the planner for a Minecraft bot named (\w+) /);
        if (planning) plannedBy.add(planning[1]);
        if (planning && mode !== "handoff") body.model = mode;
        const start = performance.now();
        try {
          const response = await fetch(router, {
            method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
            headers: { "Content-Type": "application/json",
              ...(req.headers["x-hermes-screening"] ? { "X-Hermes-Screening": req.headers["x-hermes-screening"] } : {}) },
          });
          const answer = await response.text();
          if (planning && !response.ok) plannerErrors++;
          res.writeHead(response.status, { "Content-Type": "application/json" }).end(answer);
        } catch (error) {
          if (planning) plannerErrors++;
          throw error;
        } finally {
          if (planning) plannerMs.push(Math.round(performance.now() - start));
        }
      } catch {
        res.writeHead(502).end("{}");
      }
    });
    const proxyPort = await listen(proxy, "127.0.0.1");

    // Identical fresh fixtures for each planner. Separate workstations limit furnace contention
    // while keeping all bots in the same world and sharing the model endpoint.
    const position = (index) => [mode === "handoff" ? 0 : index * 12, 101, 0];
    for (let i = 0; i < team.length; i++) {
      const [x] = position(i);
      if (mode === "handoff" && i > 0) continue;
      await rcon(`forceload add ${x - 4} -4 ${x + 4} 4`);
      await rcon(`fill ${x - 4} 100 -4 ${x + 4} 100 4 minecraft:stone`);
      await rcon(`setblock ${x + 2} 101 1 minecraft:furnace`);
      await rcon(`setblock ${x + 2} 101 -1 minecraft:crafting_table`);
    }
    async function launch(i, goal, goalTickMs) {
      const name = team[i];
      const env = {
        MC_HOST: bind, MC_PORT: String(gamePort), MC_BOT_USERNAME: name, MC_BOT_USERNAMES: team.join(","),
        MC_HOME_POS: position(i).join(","), MC_RAG_DISABLED: "true", MC_SELF_PROPOSE_GOALS: "false",
        MC_GOAL_TICK_MS: String(goalTickMs),
        MC_DUSK_START_TICK: "24000", MC_GIVE_CHECK_MS: "1000",
        MC_INVENTORY_CHECK_MS: "3600000", MC_LIGHTING_CHECK_MS: "3600000",
        MC_HOME_LIGHTING_CHECK_MS: "3600000", MC_TORCH_SUPPLY_CHECK_MS: "3600000",
        MC_ACCESS_CHECK_MS: "3600000", MC_STUCK_CHECK_MS: "3600000",
        BUZZ_URL: buzzUrl, BUZZ_TOKEN: token,
        HERMES_ROUTER_URL: `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
      };
      let actor;
      if (crossHost && i === 1) {
        delete env.HERMES_ROUTER_URL;
        actor = child("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
          remote, "node", remoteScript, "--worker"]);
        actor.proc.stdin.write(JSON.stringify({ env, goal }) + "\n");
      } else {
        actor = await startBot(path.join(root, name), env, goal);
      }
      actors[i] = actor;
      processes.push(actor);
      return actor;
    }
    const goal = (description, targetItem) => ({
      description, targetItem, source: "user", setBy: "Benchmark", steps: 0, consecutiveFailures: 0,
      log: [], actionsTaken: [], servedBySkill: true, createdAt: Date.now(), updatedAt: Date.now(),
    });
    for (const [i] of team.entries()) {
      await launch(i, mode === "handoff" ? null : goal(
        "Use your raw iron and coal. Smelt nine iron ingots at the furnace, then craft one iron block at the crafting table.",
        "iron_block"), mode === "handoff" ? 3_600_000 : 60_000);
    }
    await until(() => actors.every((actor) => {
      actor.check();
      return actor.lines.some((line) => line.includes("spawned at"));
    }), Date.now() + 45_000, "all Mineflayer processes to spawn");
    const players = await rcon("list");
    for (const name of team) assert.match(players, new RegExp(`\\b${name}\\b`));
    for (const [i, name] of team.entries()) {
      const [x, y, z] = position(i);
      await rcon(`tp ${name} ${x + 0.5} ${y} ${z + 0.5}`);
      if (mode !== "handoff") {
        await rcon(`give ${name} minecraft:raw_iron 9`);
        await rcon(`give ${name} minecraft:coal 2`);
        assert.equal(await inventory(name, "iron_block"), 0);
      }
    }
    assert.equal(plannedBy.size, 0, "fixture setup must finish before the first planner request");
    startedAt = Date.now();

    if (mode === "handoff") {
      const publish = async (from, body) => {
        const response = await fetch(`${buzzUrl}/messages`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ from, topic: "minecraft-coordination", body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        });
        assert(response.ok, await response.text());
      };
      await sleep(7000); // allow both topic watchers to capture their starting cursor
      await publish("mc-babs", { type: "delivered", forPlayer: "Amy", item: handoffItem, count: 3, donor: "Babs" });
      await until(() => actors[1].lines.some((line) => /drop reported: 3 raw_iron/.test(line)),
        Date.now() + 15_000, "Amy to see the negative-control acknowledgement");
      assert.equal(await inventory("Amy", handoffItem), 0, "Buzz acknowledgement alone cannot satisfy the observer");
      await rcon("give Babs minecraft:raw_iron 4");
      await publish("mc-amy", { type: "request", forPlayer: "Amy", item: handoffItem, count: 3 });
      await until(() => actors[0].lines.some((line) => /give result: dropped 3 raw_iron/.test(line)),
        Date.now() + 60_000, "Babs to claim and drop the requested iron");
      await until(async () => await inventory("Amy", handoffItem) === 3, Date.now() + 15_000,
        "server-confirmed pickup by Amy");
      assert.equal(await inventory("Babs", handoffItem), 1, "only the requested count left the sender");
      milestones.pickup = Date.now() - startedAt;
      await rcon("give Amy minecraft:coal 1");
      await actors[1].stop();
      await until(async () => !/\bAmy\b/.test(await rcon("list")), Date.now() + 15_000, "Amy to log out");
      const recipient = await launch(1, goal(
        "Smelt the three raw iron from Babs, then craft a bucket at the crafting table.", "bucket"), 10_000);
      await until(() => {
        recipient.check();
        return recipient.lines.some((line) => line.includes("spawned at"));
      }, Date.now() + 45_000, "Amy to resume with the received iron");
      await until(async () => {
        recipient.check();
        return await inventory("Amy", "bucket") === 1;
      }, startedAt + budget, "Amy to craft a bucket from the delivered iron");
      milestones.bucket = Date.now() - startedAt;
    } else {
      await until(async () => {
        for (const [i, name] of team.entries()) {
          actors[i].check();
          if (!(name in milestones) && await inventory(name, "iron_block") === 1) {
            milestones[name] = Date.now() - startedAt;
          }
        }
        return Object.keys(milestones).length === team.length;
      }, startedAt + budget, "every bot to craft an iron block");
      for (const name of team) assert(plannedBy.has(name), `${name} must exercise the planner`);
    }
    return true;
  } catch (error) {
    console.error(`FAIL ${mode} seed=${seed} bots=${count}: ${error.message}`);
    for (const actor of actors) console.error(actor.lines.slice(-10).join("\n"));
    return false;
  } finally {
    const outcomes = actors.flatMap((actor) => actor.lines.flatMap((line) => {
      const match = line.match(/ OUTCOME (\{.*\})$/);
      return match ? [JSON.parse(match[1])] : [];
    }));
    console.log(JSON.stringify({ mode, seed, bots: count, crossHost, milestones, plannerErrors, plannerMs,
      plannedBy: [...plannedBy],
      elapsedMs: startedAt ? Date.now() - startedAt : null, recentActionOutcomes: outcomes }));
    proxy?.closeAllConnections();
    proxy?.close();
    for (const proc of processes.reverse()) await proc.stop();
    await rm(root, { recursive: true, force: true });
  }
}

if (!process.env.MB_MULTI_SERVER_JAR && !process.argv.includes("--worker")) {
  console.log("=== multibot: skipped (set MB_MULTI_SERVER_JAR to a compatible vanilla server jar)");
} else if (process.argv.includes("--worker")) {
  await worker();
} else {
  assert(seeds.every((seed) => /^-?\d+$/.test(seed)), "MB_MULTI_SEEDS must contain numeric seeds");
  if (remote) {
    assert(/^\w[\w.-]*$/.test(remote) && /^\/[\w./-]+$/.test(remoteScript || "") &&
      net.isIPv4(lanHost), "SSH handoff requires a host alias, absolute remote script path, and local LAN IPv4");
  } else {
    console.log("=== multibot: cross-host variant skipped (MB_MULTI_SSH unset), running same-host handoff");
  }
  const jar = path.resolve(process.env.MB_MULTI_SERVER_JAR);
  const focus = process.argv[2] || "all";
  assert(["all", "handoff", "planner"].includes(focus), "expected all, handoff or planner");
  let failures = 0;
  for (const [index, seed] of seeds.entries()) {
    if (focus !== "planner" && !await trial(jar, seed, "handoff", 2)) failures++;
    if (focus === "handoff") continue;
    const planners = index % 2 ? ["coder", "dispatch"] : ["dispatch", "coder"];
    for (const count of [2, 6]) {
      for (const role of planners) if (!await trial(jar, seed, role, count)) failures++;
    }
  }
  process.exitCode = failures ? 1 : 0;
}
