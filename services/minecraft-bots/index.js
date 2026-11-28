// Version: 4.3.0
//
// 4.3.0 (2026-11-27): direct request -- a "/closest <item>" chat/whisper/Matrix command, answered
// deterministically from world-memory.js's cross-host discovery registry (no LLM call, read-only,
// so it answers even while the bot is busy). See history/index.js.md for the full account.
//
// 4.2.0 (2026-11-27, security finding during the legacy-baseline test port): decisionTick()'s
// callRole() carried a bare `analysis: true` even though its messages include conversationHistory,
// which can hold a raw, untrusted player/whisper/Matrix line pushed by handleChatMessage -- the
// exact "a player can type anything reaches an unscreened call" hole the S34 fix (see
// tests/unit/services.test.mjs's history) closed for the old architecture's call sites, reopened
// here on a new one. pushHistory() now tags each entry `trusted` (false only for handleChatMessage's
// raw speaker line when !isAnotherBot(speaker)); decisionTick's analysis flag is now
// `conversationHistory.every((h) => h.trusted)`, never a literal.
//
// 4.1.0 (2026-11-27, live verification against Babs/Amy): decision tick and chat/whisper replies
// now push the real command result (success text or parse/control-acquisition error) back into
// conversationHistory as the next turn's own context -- without this, a failed command (e.g. the
// model trying named-arg syntax commands.js's positional-only parser rejects) was only ever
// logged, never visible to the model again, so there was no way for it to notice and self-correct.
// Also dropped a dead-code ternary in handleChatMessage (both branches picked the same
// OWNERS.DIRECT_COMMAND tier).
//
// 4.0.0 (2026-11-27, MINECRAFT_BOTS_RESTART_PLAN.md Phase 5): the bot entrypoint, rewritten to
// call the Mindcraft-ported skill/command/mode layer (skills.js, world.js, mcdata.js, commands.js,
// modes.js) and the new agents/minecraft-common.json + agents/minecraft-<name>/profile.json
// persona format, instead of the archived hand-built goal/priority engine
// (services/minecraft-bots-archive-11-2026/). Process shape, systemd unit, and the kept infra this
// file wires up are otherwise the same as 3.2.0: pathfinding/movements (pathfinding.js,
// swim-movements.js), control arbitration (arbiter.js), gear (equipment.js), living-space safety
// (shelter.js), Buzz/Matrix clients (buzz.js, matrix.js, not actively wired into this minimal
// decision loop yet -- see the note near the bottom), and the role/persona roster (roles.js).
//
// Deliberately NOT restored in this pass (known gaps, not oversights -- flagged here rather than
// silently dropped):
// - Cross-restart "wedged" detection and its teleport-home rescue (old index.js's position
//   persistence via the archived goals.js's loadStuckState/saveStuckState). pathfinding.js's own
//   per-tick stuck handling is unaffected; this was the separate, rarer across-restart case.
// - Goal-state/death-alert Buzz broadcasts and achievement/curriculum tracking (archived
//   fleet-coordination.js/mayor.js/goals.js) -- buzz.js itself is untouched and ready for a later
//   phase to wire back in; nothing publishes to it yet.
// - Long-term/RAG memory (archived memory.js/longterm.js/rag-backend.js) -- replaced for now with
//   a bounded in-process rolling chat history only, reset on every restart.
//
// Change history: history/index.js.md (this file is over the self-repair pipeline's 40000-char
// per-file limit when its changelog is included inline, so the changelog lives there instead).

import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import collectBlockPkg from "mineflayer-collectblock";
import pvpPkg from "mineflayer-pvp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sendMessage as matrixSend, watchRoom } from "./matrix.js";
import { equipBestArmor, equipBestWeapon, installEnchantsFix, loadEquipmentPlugins } from "./equipment.js";
import { setupPathfinding } from "./pathfinding.js";
import { guardedInterval, installFatalHandlers } from "./faults.js";
import { refreshLivingSpace } from "./shelter.js";
import { BOT_ROLES, ROLES } from "./roles.js";
import { callRole } from "./router.js";
import { containsCommand, executeCommand, getCommandDocs } from "./commands.js";
import { MODES, runModes } from "./modes.js";
import { OWNERS, isBusy } from "./arbiter.js";
import { findClosest } from "./world-memory.js";
import { Vec3 } from "vec3";

export const { pathfinder } = pathfinderPkg;

const HOST = process.env.MC_HOST || "192.168.1.221";
const PORT = parseInt(process.env.MC_PORT || "25580", 10);
export const USERNAME = process.env.MC_BOT_USERNAME || "Babs_Miner";
installFatalHandlers(USERNAME); // faults.js: log an uncaught error with where it came from, then exit
export const PERSONA_NAME = process.env.MC_BOT_PERSONA || USERNAME.toLowerCase();
export const MAX_CHAT_LEN = 200;

// "The Boss" is a role a persona file can reference without the persona file itself needing to
// know a real username -- identity resolution belongs to the orchestrator, not the persona.
const BOSS_USERNAMES = (process.env.MC_BOSS_USERNAMES || "CanisLupisM,@phone1:spark")
  .split(",").map((s) => s.trim()).filter(Boolean);
export function isBoss(speaker) { return BOSS_USERNAMES.includes(speaker); }

// Every bot is also just another player in mineflayer's eyes -- without this, Babs relaying
// something into public chat would fire Amy's own `chat` listener, an endless bot-reacts-to-bot
// loop. Known bot identities are excluded from the human-reply pipeline entirely.
export const BOT_USERNAMES = new Set(
  (process.env.MC_BOT_USERNAMES || "Babs_Miner,Amy_Builder,Mark_Soldier,Luke_Soldier,Mayor_Leader,Bob_Farmer,Nell_Artist,Wade_Explorer,Dale_Herder")
    .split(",").map((s) => s.trim()).filter(Boolean),
);
export function isAnotherBot(speaker) {
  return BOT_USERNAMES.has(speaker) || speaker.startsWith("@mc-");
}

// 2026-11-26 rename: every bot's in-game display username is Name_Role (Mayor -> Mayor_Leader);
// its persona key (and so its Buzz/Matrix identity) stays the short lowercase name.
const USERNAME_TO_PERSONA = Object.freeze({
  Mayor_Leader: "mayor", Mark_Soldier: "mark", Luke_Soldier: "luke", Babs_Miner: "babs",
  Amy_Builder: "amy", Bob_Farmer: "bob", Nell_Artist: "nell", Wade_Explorer: "wade", Dale_Herder: "dale",
});
export function personaOf(name) { return USERNAME_TO_PERSONA[name] || name.toLowerCase(); }

export const MAYOR_USERNAME = process.env.MC_MAYOR_USERNAME || "Mayor_Leader";
export function isMayor(speaker) {
  return speaker === MAYOR_USERNAME || speaker === `@mc-${personaOf(MAYOR_USERNAME)}:spark`;
}

export const myRole = BOT_ROLES[PERSONA_NAME] || null;
export const AGENT_ID = `mc-${PERSONA_NAME}`; // matches MINECRAFT_BOTS_DESIGN.md's old Buzz-identity convention; buzz.js itself isn't wired into this file yet, see header

// Matrix (design doc §10, archived -- the facts still hold): a single shared room, operator + all
// bots. Optional -- no MATRIX_ACCESS_TOKEN, no watcher.
const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER || "http://10.129.1.15:6167";
export const MATRIX_USER_ID = process.env.MATRIX_USER_ID || `@mc-${PERSONA_NAME}:spark`;
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || "";
const MATRIX_ROOM_ID = process.env.MATRIX_ROOM_ID || "!2rXcMwykUS2yVNTLGw:spark";

// --- Persona profile loading (replaces archived persona.js's PROMPT.md prepend) ------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, "..", "..", "agents");

function loadProfile(personaName) {
  const common = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, "minecraft-common.json"), "utf8"));
  const profile = JSON.parse(
    fs.readFileSync(path.join(AGENTS_DIR, `minecraft-${personaName}`, "profile.json"), "utf8"));
  return { common, profile };
}

const { common: personaCommon, profile: persona } = loadProfile(PERSONA_NAME);
console.log(`[${USERNAME}] loaded profile '${persona.name}' (${persona.role})`);

function renderModifiers(modifiers) {
  return Object.entries(modifiers || {})
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`)
    .join("\n");
}

// Builds the full system prompt for one callRole() turn by substituting
// agents/minecraft-common.json's $PLACEHOLDER tokens with this persona's own profile.json content
// plus live call-specific context (memory/stats/inventory/examples).
function buildSystemPrompt({ memory = "(none yet)", stats = "", inventory = "", examples = "" } = {}) {
  const coreDirective = persona.guardrail
    ? `${persona.core_directive}\n\n**Guardrail:** ${persona.guardrail}`
    : persona.core_directive;
  const role = persona.pairing ? `${persona.role} (${persona.pairing})` : persona.role;
  return personaCommon.conversing_template
    .replaceAll("$NAME", persona.name)
    .replace("$ROLE", role)
    .replace("$IDENTITY", persona.identity)
    .replace("$CORE_DIRECTIVE", coreDirective)
    .replace("$VOICE", persona.voice)
    .replace("$MODIFIERS", renderModifiers(persona.modifiers))
    .replace("$MEMORY", memory)
    .replace("$STATS", stats)
    .replace("$INVENTORY", inventory)
    .replace("$COMMAND_DOCS", getCommandDocs())
    .replace("$EXAMPLES", examples);
}

// This persona's modes.js overrides, layered over agents/minecraft-common.json's defaults, layered
// over whatever modes.js itself shipped as a hardcoded default (see modes.js's own MODES array).
// Mutates the shared MODES array in place -- one process per bot, so this is safe.
for (const mode of MODES) {
  const override = persona.modes?.[mode.name] ?? personaCommon.default_modes?.[mode.name];
  if (override !== undefined) mode.on = override;
}

export const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: "offline",
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlockPkg.plugin);
bot.loadPlugin(pvpPkg.plugin);

// skills.js's execution-context contract (ported from Mindcraft's own Agent/initBot, not adopted
// here -- see skills.js's own header). A minimal, working shim rather than Mindcraft's full
// ModeController: pause/unpause toggle a real MODES entry's `on` flag (so collectBlock pausing
// "cowardice" while mining genuinely stops it firing mid-task); pausing a mode this project never
// ported (e.g. "unstuck", "cheat") is a harmless no-op since modesByName[name] is undefined.
const modesByName = Object.fromEntries(MODES.map((m) => [m.name, m]));
bot.modes = {
  pause(name) {
    const m = modesByName[name];
    if (m && m._savedOn === undefined) { m._savedOn = m.on; m.on = false; }
  },
  unpause(name) {
    const m = modesByName[name];
    if (m && m._savedOn !== undefined) { m.on = m._savedOn; m._savedOn = undefined; }
  },
  isOn(name) { return !!modesByName[name]?.on; },
};
bot.interrupt_code = false;
bot.output = "";

bot.once("spawn", async () => {
  console.log(`[${USERNAME}] spawned at`, bot.entity.position);
  // MC_HOME_POS="x,y,z" (test bots only): "home" is normally the world spawn; a test bot's home is
  // pinned to its arena so go-home behavior never walks it to the base.
  if (process.env.MC_HOME_POS) {
    const [hx, hy, hz] = process.env.MC_HOME_POS.split(",").map(Number);
    bot.spawnPoint = new Vec3(hx, hy, hz);
    console.log(`[${USERNAME}] home pinned to`, bot.spawnPoint);
  }
  // Pathfinder setup -- movement costs, unbreakable blocks, search limits, path diagnostics --
  // is in pathfinding.js.
  setupPathfinding(bot, { username: USERNAME });
  // Live diagnostic (2026-11-27, default off): MC_DEBUG_PHYSICS=true logs physicsTick throughput,
  // velocity, the path's own next waypoint, and whether bot.blockAt(her own position) is null,
  // once every DEBUG_PHYSICS_LOG_MS. Kept from 3.2.0 verbatim -- still useful for the next land/
  // water stuck episode regardless of what decides goals.
  if (process.env.MC_DEBUG_PHYSICS === "true") {
    const DEBUG_PHYSICS_LOG_MS = 2000;
    let physicsTicks = 0;
    let lastDebugLogAt = Date.now();
    let lastPathUpdate = null;
    bot.on("path_update", (r) => { lastPathUpdate = r; });
    bot.on("physicsTick", () => {
      physicsTicks++;
      const now = Date.now();
      if (now - lastDebugLogAt < DEBUG_PHYSICS_LOG_MS) return;
      const elapsedMs = now - lastDebugLogAt;
      const ticks = physicsTicks;
      lastDebugLogAt = now;
      physicsTicks = 0;
      const pos = bot.entity?.position;
      const vel = bot.entity?.velocity;
      const blockHere = pos ? bot.blockAt(pos) : null;
      const next = lastPathUpdate?.path?.[0];
      const nearby = pos ? Object.values(bot.entities)
        .filter((e) => e !== bot.entity && e.position && e.position.distanceTo(pos) <= 2)
        .map((e) => `${e.username || e.name}@${e.position.distanceTo(pos).toFixed(1)}`) : [];
      console.log(`[${USERNAME}] DEBUG_PHYSICS ticks=${ticks}/${elapsedMs}ms ` +
        `pos=${pos ? `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}` : "none"} ` +
        `vel=${vel ? `${vel.x.toFixed(3)},${vel.y.toFixed(3)},${vel.z.toFixed(3)}` : "none"} ` +
        `blockAtPos=${blockHere ? blockHere.name : "NULL"} isInWater=${bot.entity?.isInWater} onGround=${bot.entity?.onGround} ` +
        `isMoving=${bot.pathfinder?.isMoving?.()} hasGoal=${!!bot.pathfinder?.goal} ` +
        `nextNode=${next ? `${next.x},${next.y},${next.z}` : "none"} pathLen=${lastPathUpdate?.path?.length ?? "?"} ` +
        `fwd=${bot.getControlState("forward")} jump=${bot.getControlState("jump")} sprint=${bot.getControlState("sprint")} ` +
        `nearby=[${nearby.join(", ")}]`);
    });
  }
  // The shell SwimMovements.safeToBreak()/shelter.js's wouldBlockAccess read has to exist before
  // the first path search, not only after the first timer tick below -- a bot spawns inside the
  // shared base and starts pathing immediately.
  try {
    refreshLivingSpace(bot, bot.spawnPoint);
  } catch (err) {
    console.error(`[${USERNAME}] initial living-space scan failed:`, err.message);
  }
  installEnchantsFix(bot); // equipment.js: digging while holding enchanted gear threw
  loadEquipmentPlugins(bot); // equipment.js: mineflayer-tool, for skills.js's useToolOn/equipForBlock

  // Inventory persists across restarts -- worth checking gear right away.
  equipBestArmor(bot).then(() => equipBestWeapon(bot)).catch((err) =>
    console.error(`[${USERNAME}] initial gear check failed:`, err.message));
});

// TEMPORARY diagnostic (2026-09-06, carried forward): memory + loaded-chunk-column count every
// 15s. Remove once genuinely root-caused as a non-issue across a full restart cycle.
guardedInterval(() => {
  const mem = process.memoryUsage();
  const columns = bot.world?.getColumns ? bot.world.getColumns().length : "n/a";
  console.log(`[${USERNAME}] mem rss=${(mem.rss / 1048576).toFixed(1)}MB ` +
              `heap=${(mem.heapUsed / 1048576).toFixed(1)}/${(mem.heapTotal / 1048576).toFixed(1)}MB ` +
              `external=${(mem.external / 1048576).toFixed(1)}MB arrayBuffers=` +
              `${(mem.arrayBuffers / 1048576).toFixed(1)}MB chunks=${columns}`);
}, 15_000);

// --- Decision loop ---------------------------------------------------------------------------
// Replaces the archived goal-tick.js/goal-proposal.js. On a cadence (MC_GOAL_TICK_MS), and on
// every real chat/whisper/Matrix line, builds this persona's system prompt plus live game state
// and asks the `muse` role (via router.js's callRole, kept) what to do next. The reply may contain
// a `!command(args)` token (commands.js parses and dispatches it, arbiter-gated) and/or
// conversational text (chatted directly). A bounded in-process rolling history stands in for the
// archived long-term/RAG memory -- reset on every restart, a known, flagged scope reduction (see
// file header).
const GOAL_TICK_MS = parseInt(process.env.MC_GOAL_TICK_MS || "45000", 10);
const MODES_TICK_MS = parseInt(process.env.MC_MODES_TICK_MS || "1000", 10);
export const HISTORY_TURNS = 8;

let conversationHistory = [];
// trusted: false for a raw line from an unverified player (handleChatMessage tags it); true
// (default) for the bot's own output and command-result text. decisionTick's analysis:true -- the
// S34 exemption that skips full injection screening -- must never cover a call whose history
// carries even one untrusted entry, or a player's chat text reaches the model unscreened by riding
// along in history instead of through the (correctly screened) chat-reply call itself.
function pushHistory(role, content, { trusted = true } = {}) {
  conversationHistory.push({ role, content, trusted });
  if (conversationHistory.length > HISTORY_TURNS * 2) {
    conversationHistory = conversationHistory.slice(-HISTORY_TURNS * 2);
  }
}

function describeStats() {
  const pos = bot.entity?.position;
  const health = bot.health ?? "?";
  const food = bot.food ?? "?";
  return `STATS\nPosition: ${pos ? `${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}` : "unknown"}\n` +
    `Health: ${health}/20, Food: ${food}/20\nTime: ${bot.time?.timeOfDay ?? "?"}`;
}

function describeInventory() {
  const items = bot.inventory?.items?.() ?? [];
  if (!items.length) return "INVENTORY\nEmpty";
  return `INVENTORY\n${items.map((i) => `${i.name} x${i.count}`).join(", ")}`;
}

async function decisionTick() {
  if (isBusy()) return; // something (a player command, an emergency mode) is already in control
  let reply;
  try {
    const prompt = buildSystemPrompt({ stats: describeStats(), inventory: describeInventory() });
    const messages = [{ role: "system", content: prompt },
      ...conversationHistory.map(({ role, content }) => ({ role, content })),
      { role: "user", content: "What will you do next?" }];
    // analysis:true only when nothing in the current history window came from an unverified
    // player -- the same "never a bare literal" rule the chat-reply call sites already follow.
    const allTrusted = conversationHistory.every((h) => h.trusted);
    reply = await callRole("muse", messages, { analysis: allTrusted, maxTokens: 300 });
  } catch (err) {
    console.error(`[${USERNAME}] decision tick callRole failed:`, err.message);
    return;
  }
  console.log(`[${USERNAME}] decision tick raw reply: ${JSON.stringify(reply).slice(0, 300)}`);
  if (!reply || !reply.trim()) return;
  const spoken = reply.replace(/!\w+(?:\([^)]*\))?/g, "").trim();
  if (spoken) bot.chat(spoken.slice(0, MAX_CHAT_LEN));
  pushHistory("assistant", reply);
  if (containsCommand(reply)) {
    bot.output = "";
    const result = await executeCommand(bot, reply, { tier: OWNERS.GOAL_STEP });
    console.log(`[${USERNAME}] goal-step command result: ${result}`);
    // Feed the real outcome back as the next tick's context -- without this, a failed command
    // (wrong arg syntax, bad arg count, "could not get control") is only ever logged, never seen
    // by the model again, so it has no way to notice and correct its own mistake.
    pushHistory("user", `Command result: ${result}`);
  }
}

guardedInterval(decisionTick, GOAL_TICK_MS);
guardedInterval(() => {
  runModes(bot).catch((err) => console.error(`[${USERNAME}] runModes failed:`, err.message));
}, MODES_TICK_MS);

// --- Chat / whisper / Matrix -------------------------------------------------------------------
const CLOSEST_COMMAND_RE = /^\/closest\s+(.+)$/i;

async function handleChatMessage(speaker, message, { send }) {
  if (speaker === USERNAME) return;
  if (isAnotherBot(speaker) && !isMayor(speaker)) return; // see isAnotherBot's own comment
  // Direct request, 2026-11-27: a deterministic world-memory query, not a conversational one --
  // intercepted before any LLM call (no judgment needed, no reason to spend a turn or a token on
  // "what is the nearest known chest"), and read-only, so it answers even while the bot is busy.
  const closestMatch = message.trim().match(CLOSEST_COMMAND_RE);
  if (closestMatch) {
    const item = closestMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
    const found = await findClosest(item, bot.entity.position);
    const reply = found
      ? `closest known ${item}: (${Math.round(found.x)}, ${Math.round(found.y)}, ${Math.round(found.z)}), ` +
        `${Math.round(found.distance)} blocks from ${USERNAME}`
      : `no known sighting of "${item}" yet.`;
    console.log(`[${USERNAME}] /closest ${item} (from ${speaker}): ${reply}`);
    send(reply);
    return;
  }
  pushHistory("user", `${speaker}: ${message}`, { trusted: isAnotherBot(speaker) });
  let reply;
  try {
    const prompt = buildSystemPrompt({ stats: describeStats(), inventory: describeInventory() });
    const messages = [{ role: "system", content: prompt },
      ...conversationHistory.map(({ role, content }) => ({ role, content }))];
    reply = await callRole("muse", messages, { maxTokens: 300 });
  } catch (err) {
    console.error(`[${USERNAME}] chat reply callRole failed:`, err.message);
    return;
  }
  console.log(`[${USERNAME}] chat reply raw: ${JSON.stringify(reply).slice(0, 300)}`);
  if (!reply || !reply.trim()) return;
  const spoken = reply.replace(/!\w+(?:\([^)]*\))?/g, "").trim();
  if (spoken) send(spoken.slice(0, MAX_CHAT_LEN));
  pushHistory("assistant", reply);
  if (containsCommand(reply)) {
    bot.output = "";
    // Every chat/whisper-issued command is DIRECT_COMMAND-tier -- a live speaker asked for this
    // by name, whether or not they're the Mayor/Boss (no second tier exists above it for that
    // distinction; see arbiter.js's own OWNERS comment).
    const result = await executeCommand(bot, reply, { tier: OWNERS.DIRECT_COMMAND });
    console.log(`[${USERNAME}] chat-issued command result: ${result}`);
    pushHistory("user", `Command result: ${result}`);
  }
}

bot.on("chat", (speaker, message) => {
  handleChatMessage(speaker, message, { send: (reply) => bot.chat(reply) })
    .catch((err) => console.error(`[${USERNAME}] chat handling failed:`, err.message));
});

bot.on("whisper", (speaker, message) => {
  handleChatMessage(speaker, message, { send: (reply) => bot.whisper(speaker, reply) })
    .catch((err) => console.error(`[${USERNAME}] whisper handling failed:`, err.message));
});

// Matrix (kept, optional -- no MATRIX_ACCESS_TOKEN, no watcher).
if (MATRIX_ACCESS_TOKEN) {
  watchRoom({
    homeserver: MATRIX_HOMESERVER,
    accessToken: MATRIX_ACCESS_TOKEN,
    roomId: MATRIX_ROOM_ID,
    onMessage: ({ sender, body }) => {
      handleChatMessage(sender, body, {
        send: (reply) =>
          matrixSend({ homeserver: MATRIX_HOMESERVER, accessToken: MATRIX_ACCESS_TOKEN,
                       roomId: MATRIX_ROOM_ID, body: reply }).catch((err) =>
            console.error(`[${USERNAME}] matrix send failed:`, err.message)),
      }).catch((err) => console.error(`[${USERNAME}] matrix message handling failed:`, err.message));
    },
  });
  console.log(`[${USERNAME}] watching Matrix room ${MATRIX_ROOM_ID} as ${MATRIX_USER_ID}`);
} else {
  console.log(`[${USERNAME}] MATRIX_ACCESS_TOKEN not set -- Matrix room disabled`);
}

// --- Death / respawn / disconnect ---------------------------------------------------------------
let hasSpawnedOnce = false;

bot.on("death", () => {
  console.log(`[${USERNAME}] died`);
});

bot.on("spawn", () => {
  if (!hasSpawnedOnce) { hasSpawnedOnce = true; return; } // the initial connection's own spawn
  (async () => {
    console.log(`[${USERNAME}] respawned after dying`);
    try {
      bot.chat("ouch, I died! let me get myself back together.");
    } catch (err) {
      console.error(`[${USERNAME}] death narration failed:`, err.message);
    }
  })().catch((err) => console.error(`[${USERNAME}] post-respawn handling failed:`, err.message));
});

bot.on("kicked", (reason) => console.log(`[${USERNAME}] kicked:`, reason));
bot.on("error", (err) => console.log(`[${USERNAME}] error:`, err));
// Every bot runs under systemd's Restart=always -- exiting non-zero on ANY disconnect (network
// blip, keepalive timeout, a kick, the game server restarting) hands recovery to that same
// machinery, giving a fresh process a real, clean reconnect instead of a stale one pretending to
// keep working (the alternative, confirmed live and root-caused in 3.x's own history).
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => process.exit(0));
}

bot.on("end", (reason) => {
  console.log(`[${USERNAME}] disconnected:`, reason);
  process.exit(1);
});
