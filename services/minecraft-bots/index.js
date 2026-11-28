// Version: 4.11.0
//
// 4.11.0 (2026-11-28, direct report: "they seem to be reporting successful actions that are
// entirely fictitious"): a real, distinct bug from 4.10.0's -- both decisionTick() and
// handleChatMessage() speak the model's own pre-action narration (`spoken`) IMMEDIATELY, before
// the command behind it has even run, then execute the real command and push its real `result`
// only into conversationHistory -- never into chat. A human (or a player who asked for the
// action) only ever sees the model's own claim ("Got the iron, now crafting stone pickaxe.")
// and never the correction when the real result disagrees ("You do not have the resources to
// craft a stone_pickaxe. It requires: cobblestone: 3, stick: 2."), confirmed live, repeatedly.
// Fixed in both places: the real result is now ALSO spoken/sent (truncated to MAX_CHAT_LEN,
// same as the narration), right after it's known, as its own follow-up chat line rather than
// folded into the narration's own message (which already went out before the result existed, and
// combining them into one later message risks the result -- the one part that matters most here
// -- being the part MAX_CHAT_LEN's truncation cuts if the narration ran long). Deliberately speaks
// the raw result text verbatim rather than trying to classify it as success/failure first: the
// same reason the 4.10.0 stall detector uses a real inventory delta instead of pattern-matching
// skills.js's own heterogeneous, independently-worded result strings -- speaking the ground truth
// unconditionally needs no classification to get right, and never mis-hides a real failure behind
// a guessed-wrong "that looked like success" check.
//
// 4.10.0 (2026-11-28, direct instruction "fix that", following up on the muse planning/retry gap
// flagged -- not fixed -- by 4.9.0/router.js 1.3.0's own changelog): neither bot was BLOCKED or
// STUCK anymore by that point, but both kept re-issuing the exact same already-failed command
// forever. Confirmed live: Babs alternated `craftRecipe("stone_pickaxe", ...)` (needs cobblestone
// she had none of) and `collectBlocks("cobblestone", ...)` (needs a pickaxe she had none of -- a
// real Minecraft tech-tree dead end the model never worked around by making a WOOD pickaxe
// first); Amy retried `craftRecipe("bed", 1)` after "Invalid item type: bed" every single tick.
// decisionTick() already feeds the real command result back into conversationHistory (4.1.0), but
// a chat model reliably ignoring "this already failed, don't repeat it" buried in its own history
// is exactly the shape pathfinding.js's own stuck-burst detector (1.5.0) exists to break
// mechanically rather than trust the model to self-correct from context alone -- same idea here.
// Tracks the real command signature (name+args, not the narration wrapped around it, via the
// already-exported parseCommandMessage()) and a genuine inventory snapshot (describeInventory(),
// already computed every tick) before and after execution -- inventory rather than result text,
// because result text is not a reliable success/failure signal across this many independently-
// worded skill functions (ported one at a time from Mindcraft), while "did my inventory actually
// change" is unambiguous, the same rigor metrics.js's own craftRecipe fix already uses. After
// STALL_REPEAT_THRESHOLD identical (command, zero-inventory-change) ticks in a row -- 3, matching
// the stuck-burst detector's own threshold, generous enough that an ordinary multi-tick action
// (e.g. a drawn-out fight) isn't flagged after one unlucky tick -- the next command result carries
// an explicit NOTICE telling the model to stop repeating it. Deliberately does NOT auto-pick a
// replacement action: only the model has the context for what else is worth trying; this only
// breaks the loop, it doesn't plan the way out of it.
//
// 4.9.0 (2026-11-28, direct report: "the bots are still not moving or doing anything useful"):
// Babs was permanently deadlocked -- every single decisionTick() call blocked by the Hermes Guard
// Layer 2 classifier (label=MALICIOUS score=1.000), confirmed live via hermes-router's own
// journal. The flagged text was DECISION_TICK_PROMPT itself (4.7.0's fix), not anything a player
// said. Root cause was 4.2.0's own analysis-flag gate, `analysis: allTrusted` -- reasonable-
// sounding, but built on a premise hermes-router.py's Layer 2 stopped matching back in its own
// 2.11.0 (2026-09-11): Layer 2 only ever classifies `newest["content"]`, the single newest
// message, never the full history. decisionTick()'s own messages array always ends with `{ role:
// "user", content: DECISION_TICK_PROMPT }` -- a fixed, self-authored string, never
// conversationHistory's last entry -- so "newest" here is NEVER the player's text regardless of
// what sits earlier in conversationHistory. Gating analysis on allTrusted protected nothing (the
// player's untrusted line is never the thing Layer 2 inspects on this call) while creating a real
// deadlock: once any bot ever received one untrusted chat/whisper line, every future decisionTick
// scored MALICIOUS on its own prompt and threw, and the catch block returns WITHOUT calling
// pushHistory() -- so the untrusted entry could never age out of the HISTORY_TURNS window either.
// Permanent from the first real player interaction onward, confirmed live (Babs blocked on every
// tick for over an hour straight). Fixed: analysis is now an unconditional `true` here, matching
// what Layer 2 actually screens on this call site -- the S27f exemption doctrine's own "payloads
// that are data by construction" language describes DECISION_TICK_PROMPT exactly. This does not
// reopen the 4.2.0 finding: a player's raw chat/whisper/Matrix line is screened for real
// (analysis never true) at the call site that answers it directly (handleChatMessage), which is
// the point at which it IS the newest message -- by the time it's just background context in
// conversationHistory for a LATER decisionTick, it already passed screening once, which is
// hermes-router.py's own stated doctrine ("every prior turn already passed screening the request
// it first arrived in").
//
// Amy's symptom looked different (isMoving=true, actively pathing) but was the same underlying
// shape: DEBUG_PHYSICS showed her frozen at the same position for 12+ minutes straight, a
// path_update status=success (nodes=6, cost=8.7) immediately followed by path_reset: stuck, over
// and over, recomputing the IDENTICAL path every ~3.5s forever -- jump was never held (not the
// land 1-block-rise case pathfinding.js already fixes) and she was never in water (not the swim
// case either), so neither existing physicsTick assist could apply. This is pathfinding.js's own
// documented dig_error shape ("a 'success' path immediately followed by getting stuck again...
// recomputing trivial routes that never actually complete") but for plain "stuck", which had no
// equivalent burst-detector. Worse than cosmetic: the stuck goto() never settles, so the
// performAction() call that started it never returns and never releases arbiter control --
// confirmed live, a player's Rcon command to Amy was refused ("DIRECT_COMMAND (priority 10) still
// holds it") while she was deadlocked like this. Fixed in pathfinding.js (1.5.0): a burst
// detector, same shape as the existing dig_error one, abandons the goal (setGoal(null), confirmed
// by this file's own arbiter.js history to reject the in-flight goto() promise rather than just
// log something) after 3 consecutive "stuck" resets with under a block of real position progress
// between them.
//
// 4.8.0 (2026-11-28, found while verifying 4.7.0 live): 4.6.0's claim below that "diggingCompleted
// ... covers every dig path" was wrong in a way that only showed up once a bot actually mined
// something for the first time -- confirmed from mineflayer's own digging.js source, that event
// fires with the block AFTER digging (`newBlock` from the blockUpdate it waits on, air by
// definition), not the block destroyed. Every mined block was being recorded as block="air".
// Fixed by wrapping bot.dig() itself instead, capturing the real name from what the caller passed
// in before the call -- still the one chokepoint (collectBlock, breakBlockAt, digDown, and
// mineflayer-collectblock's own internal bot.dig() call), so skills.js still needed no changes.
//
// 4.7.0 (2026-11-28, direct request -- "look into why the bots are not doing anything"): found,
// across ~116 decision ticks on both running bots over roughly an hour, ZERO ever issued a real
// !command -- confirmed via the new 4.6.0 metrics staying at zero, then via the journal itself.
// Root cause, two compounding gaps: (1) $EXAMPLES was always substituted empty -- every persona's
// own conversation_examples was `[]`, and buildSystemPrompt() never read it anyway, so the model
// had no demonstrated narration+command pairing to imitate; (2) the decision tick's own prompt was
// a bare "What will you do next?", which a chat-tuned model answers with prose by default. Fixed:
// buildSystemPrompt() now renders a persona's own conversation_examples, falling back to
// minecraft-common.json's new default_conversation_examples (new renderExamples(), exported and
// unit-tested standalone); minecraft-common.json 1.1.0 adds that fallback plus a narration-vs-
// command bullet; decisionTick's prompt (now DECISION_TICK_PROMPT) spells out that a command is
// expected unless genuinely idle. New services/minecraft-bots/tests/unit/examples.test.mjs.
//
// 4.6.0 (2026-11-28, direct request): Prometheus action counters, metrics.js's new
// recordBlockMined/addDistanceTraveled wired up here (recordMobKilled/recordBlockPlaced/
// recordItemsCrafted are wired in skills.js itself, at their own existing success points).
// Blocks mined: mineflayer's own `diggingCompleted` event fires once per completed dig
// regardless of call site (collectBlock, breakBlockAt, digDown, ...), so one listener here covers
// every dig path in skills.js without touching any of them. Distance traveled: accumulated from
// `physicsTick` position deltas (already used by the DEBUG_PHYSICS block above); a single-tick
// delta over TELEPORT_JUMP_BLOCKS is skipped as a teleport/respawn, not real travel -- no sprint-
// jump can cover that distance in one 50ms tick under normal physics, so this isn't a hypothetical
// guard, pathfinding.js's own TELEPORT_HOME rescue and death/respawn both produce exactly this.
// Starts a dedicated HTTP listener only when MC_BOT_METRICS_PORT is set (systemd units only, per
// infra/minecraft-bots/README.md) -- unset in local dev/tests, same optionality as
// MATRIX_ACCESS_TOKEN below.
//
// 4.5.0 (2026-11-28, diagnosability follow-up): the death handler logged just "died" -- no
// position, no sense of what killed it. Now logs position plus bot.lastDamageTaken/lastDamageTime
// (mineflayer's own fields, already read by modes.js's self_preservation check) -- doesn't name an
// attacker, but the amount and recency usually tell a fall/lava/mob hit apart from drowning.
//
// 4.4.0 (2026-11-27, diagnosability audit): three fixes, none of them visible in Minecraft chat --
// a fired reactive mode (runModes()) is now logged to the console/journal (previously only visible
// as its own bot.chat() side effect, indistinguishable in the journal from a deliberate decisionTick
// action); the chat-issued command result log line now names the speaker; /closest's own reply is
// now logged too. See history/index.js.md for the full account.
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
import { containsCommand, executeCommand, getCommandDocs, parseCommandMessage } from "./commands.js";
import { MODES, runModes } from "./modes.js";
import { OWNERS, isBusy } from "./arbiter.js";
import { findClosest } from "./world-memory.js";
import { instrumentDig, addDistanceTraveled, startMetricsServer } from "./metrics.js";
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

// Renders conversation_examples (this persona's own, or minecraft-common.json's
// default_conversation_examples as a fallback) into the $EXAMPLES block -- the demonstrated
// narration+command pairing that teaches the model what "take a real action" looks like. Exported
// for its own unit test (tests/unit/examples.test.mjs); pure, no bot/mineflayer dependency.
export function renderExamples(examples) {
  if (!examples || !examples.length) return "";
  return "EXAMPLES (how to pair narration with a real command; see COMMAND DOCS above for syntax)\n" +
    examples.map((e) => `Example: ${e.context}\nYou: ${e.reply}`).join("\n\n") + "\n";
}

// Builds the full system prompt for one callRole() turn by substituting
// agents/minecraft-common.json's $PLACEHOLDER tokens with this persona's own profile.json content
// plus live call-specific context (memory/stats/inventory). $EXAMPLES is this persona's own
// conversation_examples, falling back to minecraft-common.json's default_conversation_examples --
// found live 2026-11-28 that every persona's own array was empty and nothing ever read either one
// anyway, so the model never saw a single example of narration actually paired with a !command;
// both bots ran for roughly an hour issuing zero real commands as a result.
function buildSystemPrompt({ memory = "(none yet)", stats = "", inventory = "" } = {}) {
  const coreDirective = persona.guardrail
    ? `${persona.core_directive}\n\n**Guardrail:** ${persona.guardrail}`
    : persona.core_directive;
  const role = persona.pairing ? `${persona.role} (${persona.pairing})` : persona.role;
  const examples = persona.conversation_examples?.length
    ? persona.conversation_examples
    : personaCommon.default_conversation_examples;
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
    .replace("$EXAMPLES", renderExamples(examples));
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

// Prometheus action counters (metrics.js) -- see this file's own 4.6.0 changelog entry above.
startMetricsServer(USERNAME, { port: process.env.MC_BOT_METRICS_PORT ? parseInt(process.env.MC_BOT_METRICS_PORT, 10) : null });

const TELEPORT_JUMP_BLOCKS = 10; // no normal single physics tick covers this; see changelog
let lastMetricsPos = null;
bot.on("physicsTick", () => {
  const pos = bot.entity?.position;
  if (!pos) return;
  if (lastMetricsPos) {
    const delta = pos.distanceTo(lastMetricsPos);
    if (delta < TELEPORT_JUMP_BLOCKS) addDistanceTraveled(delta);
  }
  lastMetricsPos = new Vec3(pos.x, pos.y, pos.z);
});

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
  // Blocks mined: metrics.js's instrumentDig() wraps bot.dig() itself (see its own 1.1.0
  // changelog for why mineflayer's own diggingCompleted event can't be used here). Crash-found
  // live 2026-11-28: bot.dig doesn't exist right after createBot()/loadPlugin() -- mineflayer
  // defers its internal plugins' injection (plugin_loader.js) until its own 'inject_allowed'
  // event, well after this file's module-load-time code runs. 'spawn' guarantees it exists.
  instrumentDig(bot);
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
// (default) for the bot's own output and command-result text. Provenance only, kept for whatever
// future call site actually sends history as its OWN newest message -- decisionTick() is not that
// (see its own 4.9.0 comment): its newest message is always the fixed DECISION_TICK_PROMPT below,
// never conversationHistory's last entry, so gating ITS analysis flag on this tag protected
// nothing and is gone.
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

// Found live 2026-11-28: a bare "What will you do next?" got answered with pure narration every
// single time across ~116 ticks on both running bots -- zero real !commands issued in roughly an
// hour. Spelling out the expectation directly here, on top of the system prompt's own new
// narration-vs-command bullet and EXAMPLES block (belt and suspenders, not redundant -- this is
// the one turn actually asking for an autonomous next step, as opposed to a reply to something a
// player said).
const DECISION_TICK_PROMPT = "What will you do next? If there's anything useful to do, say a " +
  "brief line then issue exactly one !command(args) for it right now -- a plan you only describe " +
  "never happens. Skip the command only if you are genuinely idle with nothing worth doing.";

// 4.10.0: see this file's own header. A pure signature (command name + parsed args), never the
// narration wrapped around it, so two different sentences that both issue the same command still
// count as the same attempt.
function commandSignature(reply) {
  const parsed = parseCommandMessage(reply);
  return typeof parsed === "string" ? reply : `${parsed.commandName}(${JSON.stringify(parsed.args)})`;
}

const STALL_REPEAT_THRESHOLD = 3;
let lastCommandSignature = null;
let stalledRepeats = 0;

async function decisionTick() {
  if (isBusy()) return; // something (a player command, an emergency mode) is already in control
  let reply;
  try {
    const prompt = buildSystemPrompt({ stats: describeStats(), inventory: describeInventory() });
    const messages = [{ role: "system", content: prompt },
      ...conversationHistory.map(({ role, content }) => ({ role, content })),
      { role: "user", content: DECISION_TICK_PROMPT }];
    // analysis:true unconditionally -- see 4.9.0 above. Layer 2 only ever classifies the newest
    // message, which here is ALWAYS the fixed DECISION_TICK_PROMPT just below, never
    // conversationHistory's own last entry -- gating this on history trust (the 4.2.0 attempt)
    // protected nothing real and permanently deadlocked any bot that ever received one untrusted
    // chat line, confirmed live (Babs, blocked on every tick for over an hour).
    reply = await callRole("muse", messages, { analysis: true, maxTokens: 300 });
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
    const signature = commandSignature(reply);
    const beforeInventory = describeInventory();
    bot.output = "";
    const result = await executeCommand(bot, reply, { tier: OWNERS.GOAL_STEP });
    console.log(`[${USERNAME}] goal-step command result: ${result}`);
    // 4.11.0: the narration above was spoken BEFORE this ran -- it's a claim of intent, not a
    // report. Speak the real outcome too, so chat never shows only the claim when the two disagree.
    bot.chat(result.slice(0, MAX_CHAT_LEN));
    const matches = signature === lastCommandSignature && beforeInventory === describeInventory();
    stalledRepeats = matches ? stalledRepeats + 1 : 1; // this attempt itself always counts as one
    lastCommandSignature = signature;
    // Feed the real outcome back as the next tick's context -- without this, a failed command
    // (wrong arg syntax, bad arg count, "could not get control") is only ever logged, never seen
    // by the model again, so it has no way to notice and correct its own mistake.
    let resultText = `Command result: ${result}`;
    if (stalledRepeats >= STALL_REPEAT_THRESHOLD) {
      console.log(`[${USERNAME}] decision stall -- ${signature} repeated ${stalledRepeats}x with no inventory change`);
      resultText += `\nNOTICE: this exact command has now produced this exact result ${stalledRepeats} ` +
        "times in a row with zero inventory change -- stop repeating it, the approach is not " +
        "working. Try something genuinely different.";
    }
    pushHistory("user", resultText);
  }
}

guardedInterval(decisionTick, GOAL_TICK_MS);
guardedInterval(() => {
  // Direct finding, 2026-11-27 (diagnosability audit): runModes() already returns which mode
  // acted, but nothing logged it -- a mode firing (e.g. self_defense taking over mid-task) looked
  // identical in the journal to a deliberate decisionTick action, so there was no way to tell
  // "the model decided to fight" from "a reflex pre-empted it" from logs alone.
  runModes(bot)
    .then((acted) => { if (acted) console.log(`[${USERNAME}] mode fired: ${acted}`); })
    .catch((err) => console.error(`[${USERNAME}] runModes failed:`, err.message));
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
    // Direct finding, 2026-11-27 (diagnosability audit): this line never named who issued the
    // command -- couldn't tell from the journal alone whether it came from the Mayor, a random
    // player, or a verified bot.
    console.log(`[${USERNAME}] chat-issued command result (from ${speaker}): ${result}`);
    // 4.11.0: the narration above was spoken BEFORE this ran -- it's a claim of intent, not a
    // report. Send the real outcome too, so the speaker who asked never sees only the claim when
    // the two disagree (see this file's own 4.11.0 header for the live incident this fixes).
    send(result.slice(0, MAX_CHAT_LEN));
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
  // Direct finding, 2026-11-28 (diagnosability follow-up): "died" alone carried no context --
  // not even the one thing an operator reading the journal would want first, what actually
  // killed it. bot.lastDamageTaken/lastDamageTime are mineflayer's own fields (modes.js's
  // self_preservation check already reads them); logged here even though they don't name an
  // attacker -- the amount and how recently it landed is usually enough to tell a fall/lava/mob
  // hit apart from, say, drowning (lastDamageTaken near 0, health just ran out).
  const pos = bot.entity?.position;
  console.log(`[${USERNAME}] died at ${pos ? `${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}` : "unknown position"} -- ` +
    `last damage ${bot.lastDamageTaken ?? "?"} taken ${bot.lastDamageTime ? Date.now() - bot.lastDamageTime : "?"}ms before death`);
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
