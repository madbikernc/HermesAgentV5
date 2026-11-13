// Version: 3.0.0
//
// The Firmament's Minecraft bot: one process per bot (run-bot.sh), configured by its unit's
// environment. Change history: history/index.js.md (moved out of this file 2026-11-13, verbatim).
// Most of the code lives in the modules imported below; this file creates the bot, holds the
// state they share, and wires every listener and periodic check in its original order.

import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { loadPersona } from "./persona.js";
import { publish as buzzPublish } from "./buzz.js";
import { sendMessage as matrixSend, watchRoom } from "./matrix.js";
import { loadAchievements, loadActionPlugins } from "./actions.js";
import { equipBestArmor, equipBestWeapon, installEnchantsFix } from "./equipment.js";
import { clearGoal, loadGoal, loadStuckState, saveStuckState } from "./goals.js";
import { setupPathfinding } from "./pathfinding.js";
import { guardedInterval, installFatalHandlers } from "./faults.js";
import { installSelfDefense, lastKnownThreat } from "./self-defense.js";
import { refreshLivingSpace } from "./shelter.js";
import { installTorchTrail } from "./tunneling.js";
import { BOT_ROLES, ROLES } from "./roles.js";
import { installChat, narrateAction } from "./chat.js";
import { Vec3 } from "vec3";
import { GOAL_HEARTBEAT_MS, broadcastDeathAlert, broadcastGoalState, goalHeartbeatTick, recordGoalOutcome } from "./fleet-coordination.js";
import { ROUTINE_SKIP_REPORT_MS, routineSkips } from "./goal-proposal.js";
import { runGoalTick } from "./goal-tick.js";
import { drainIncoming, handleIncoming, watchFleetTopics } from "./incoming.js";
import { MAYOR_DIRECTIVE_MS, MAYOR_LIVENESS_TIMEOUT_MS, heldCurriculumItems, loadCurriculumStage, proposeDirectiveForOthers, proposeFallbackDirective } from "./mayor.js";
import { DEATH_THREAT_ATTRIBUTION_MS, DUSK_CHECK_MS, SLEEPING_THREAT_CHECK_MS, SLEEP_CHECK_MS, checkDusk, checkSleep, checkSleepingThreat, onEmergencyHealth, onLowBreath } from "./night-survival.js";
import { HOME_LIGHTING_CHECK_MS, LIGHTING_CHECK_MS, SAPLING_CHECK_MS, TRASH_CHECK_MS, checkHomeLighting, checkInventoryFull, checkInventoryInsurance, checkLighting, checkSaplings, checkTrash } from "./upkeep-home.js";
import { CHEST_CONSOLIDATION_CHECK_MS, GIVE_CHECK_MS, HUNGER_CHECK_MS, INVENTORY_CHECK_MS, LOCATION_SHARING_CHECK_MS, RIPE_CHECK_MS, SURPLUS_SHARING_CHECK_MS, checkChestConsolidation, checkDeferredSurplusCleanup, checkHunger, checkLocationSharing, checkPendingGiveRequests, checkRipeCrops, checkSurplusSharing } from "./upkeep-inventory.js";
import { ACCESS_CHECK_MS, LIVING_SPACE_REFRESH_MS, LIVING_SPACE_REPORT_MS, RESTART_STUCK_RADIUS, RESTART_STUCK_THRESHOLD, SHELTER_INTEGRITY_CHECK_MS, STUCK_CHECK_MS, TERRAIN_REPAIR_CHECK_MS, TORCH_SUPPLY_CHECK_MS, checkAccessObstructions, checkShelterIntegrity, checkStuck, checkTerrainDamage, checkTorchSupply, teleportToSpawn } from "./upkeep-world.js";
export { GOAL_LEASE_MS, broadcastThreatAlert, otherBotGoalSeenAt, otherBotGoals, otherGoalsNote } from "./fleet-coordination.js";
export { hasPickaxe, toolStep } from "./gear-goals.js";
export { proposeOwnGoal } from "./goal-proposal.js";
export { activeDirectSpeaker, setActiveDirectSpeaker } from "./incoming.js";
export { TOOL_TIERS } from "./mayor.js";
export { EMERGENCY_HEALTH_THRESHOLD } from "./night-survival.js";
export { HUNGER_THRESHOLD, SURPLUS_CLEANUP_QUIET_MS, foodFetchBlockedUntil, hasFood, hasRod, setSurplusCleanupDueAt } from "./upkeep-inventory.js";
export const { pathfinder, goals } = pathfinderPkg;

const HOST = process.env.MC_HOST || "192.168.1.221";
const PORT = parseInt(process.env.MC_PORT || "25580", 10);
export const USERNAME = process.env.MC_BOT_USERNAME || "Babs";
installFatalHandlers(USERNAME); // faults.js: log an uncaught error with where it came from, then exit
export const PERSONA_NAME = process.env.MC_BOT_PERSONA || USERNAME.toLowerCase();
export const MAX_CHAT_LEN = 200;

// "The Boss" is a role a persona file can reference (see agents/minecraft-babs/PROMPT.md's
// Behavioral Modifiers) without the persona file itself needing to know a real username --
// identity resolution belongs to the orchestrator, not the persona. Registered here rather
// than in a config file since no config system exists yet; comma-separated for more than one
// in-game account later.
const BOSS_USERNAMES = (process.env.MC_BOSS_USERNAMES || "CanisLupisM,@phone1:spark")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isBoss(speaker) {
  return BOSS_USERNAMES.includes(speaker);
}

// Every bot is also just another player in mineflayer's eyes -- without this, Babs relaying a
// Buzz message into public chat (see the watchTopic handler below) would fire Amy's own `chat`
// listener and send her down the normal human-reply pipeline, and vice versa: an endless
// bot-reacts-to-bot loop. Known bot identities are excluded from that pipeline entirely;
// coordination between them happens over Buzz, not the in-game chat relevance/reply loop.
// "Bob" added to the default list 2026-09-11 (§15.3/§15.12) alongside his own persona/role
// entries -- harmless for the 5 bots actually running today (an unset MC_BOT_USERNAMES env var
// on a live unit still won't spawn a 6th process; this only changes what a FRESH deploy defaults
// to), but keeps this list in sync with roles.js's own BOT_ROLES rather than silently drifting.
// "Nell,Wade,Dale" added 2026-09-13 (§22, "rebalance the bots so they each have exactly one
// role... create [more] so every role has at least one bot") -- same "harmless for bots not
// actually running yet, keeps this list in sync with roles.js's own BOT_ROLES rather than
// silently drifting" reasoning as Bob's own addition to this list.
export const BOT_USERNAMES = new Set(
  (process.env.MC_BOT_USERNAMES || "Babs,Amy,Mark,Luke,Mayor,Bob,Nell,Wade,Dale").split(",").map((s) => s.trim()).filter(Boolean),
);

export function isAnotherBot(speaker) {
  return BOT_USERNAMES.has(speaker) || speaker.startsWith("@mc-"); // Matrix bot identities
}

// Direct request, 2026-09-08 ("add another bot, Mayor, whose personality is to be a leader and
// set goals for the others. The others can defer to him when his instructions are not in
// conflict"). Every other bot's own chat stays coordinate-over-Buzz-not-chat (isAnotherBot's own
// original reasoning, unchanged) -- Mayor is the one deliberate exception, since his whole
// purpose requires a directive to actually reach the other bots' real decision loop
// (classifyIntent -> ACTION GOAL), the same path a player's own instruction already takes.
// Matches on both the plain in-game name and his Matrix identity (@mc-mayor:spark), the two
// forms isAnotherBot() itself already recognizes.
export const MAYOR_USERNAME = process.env.MC_MAYOR_USERNAME || "Mayor";
export function isMayor(speaker) {
  return speaker === MAYOR_USERNAME || speaker === `@mc-${MAYOR_USERNAME.toLowerCase()}:spark`;
}

// Autonomy (standing goals): a whole-bot kill switch, an idle-before-self-proposing-a-goal
// window (real chat/whisper/Matrix/goal-setting all count as "not idle" -- see lastActivityAt),
// and a tick interval for actually working a goal. Since everything here runs on local compute
// with no per-call cost (direct instruction, 2026-09-06), 45s errs toward checking in often and
// reasoning carefully each time rather than stretching the interval to save calls.
export const AUTONOMY_ENABLED = (process.env.MC_AUTONOMY_ENABLED ?? "true") !== "false";
export const SELF_PROPOSE_GOALS = (process.env.MC_SELF_PROPOSE_GOALS ?? "true") !== "false";
const GOAL_TICK_MS = parseInt(process.env.MC_GOAL_TICK_MS || "45000", 10);
export const IDLE_BEFORE_SELF_GOAL_MS = parseInt(process.env.MC_IDLE_SELF_GOAL_MS || "600000", 10); // 10 min
export const MAX_CONSECUTIVE_FAILURES = 3;

// Matrix (design doc §10): a single shared room, operator + all bots -- the operator's own
// decision, a deliberate deviation from the retired Sintra/Amy per-agent-room pattern. Talks
// directly to Continuwuity's Client-Server API (matrix.js), not the old "hermes gateway" tool,
// which was built around that different architecture. Optional: if MATRIX_ACCESS_TOKEN isn't
// set, the bot simply doesn't join Matrix, same as every other best-effort integration here.
const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER || "http://10.129.1.15:6167";
export const MATRIX_USER_ID = process.env.MATRIX_USER_ID || `@mc-${PERSONA_NAME}:spark`;
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || "";
const MATRIX_ROOM_ID = process.env.MATRIX_ROOM_ID || "!2rXcMwykUS2yVNTLGw:spark";

// mc-<persona> matches the design doc's own Buzz-identity convention (§9) -- reused here as
// the hermes-memory agent id so the same name means the same thing everywhere this bot shows
// up. One conv_id per speaker: a bot's memory of "the conversation with CanisLupisM" spans
// both public chat and whispers, rather than splitting by channel for no real benefit.
export const AGENT_ID = `mc-${PERSONA_NAME}`;
export const TASK_ID = `${AGENT_ID}-chat`;
export const HISTORY_TURNS = 8;

export function convId(speaker) {
  return `${AGENT_ID}:${speaker}`;
}

export const persona = loadPersona(PERSONA_NAME);
console.log(`[${USERNAME}] loaded persona '${PERSONA_NAME}' (${persona.length} chars)`);

// §15.4: this bot's own role entry, or null for a bot not yet in BOT_ROLES. Looked up once at
// startup, matching persona's own load-once pattern -- a role reassignment means editing
// roles.js and restarting, the same "edit the file, restart the process" model every other piece
// of per-bot config here already uses.
export const myRole = BOT_ROLES[PERSONA_NAME] || null;

export const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: "offline",
});

bot.loadPlugin(pathfinder);
loadActionPlugins(bot);

bot.once("spawn", async () => {
  console.log(`[${USERNAME}] spawned at`, bot.entity.position);
  // MC_HOME_POS="x,y,z" (test bots only, tests/live-bot.test.mjs): "home" is normally the world
  // spawn; a test bot's home is pinned to its arena so go-home behavior never walks it to the base.
  if (process.env.MC_HOME_POS) {
    const [hx, hy, hz] = process.env.MC_HOME_POS.split(",").map(Number);
    bot.spawnPoint = new Vec3(hx, hy, hz);
    console.log(`[${USERNAME}] home pinned to`, bot.spawnPoint);
  }
  // Tech-tree curriculum (2026-09-08): only Mayor's own process ever reads curriculumStageIndex,
  // but loading it is cheap and harmless for every other bot too -- one code path, not a
  // separate Mayor-only startup branch.
  if (USERNAME === MAYOR_USERNAME) await loadCurriculumStage();
  await loadAchievements(bot);
  // 2026-09-25: a new verified achievement (harvested:/penned:/bred:) reaches the Mayor right away,
  // not only when a goal happens to finish -- the ripe-crop routine harvests outside any goal.
  bot.on("achievement", () => {
    buzzPublish(AGENT_ID, "minecraft-coordination", JSON.stringify({ type: "evidence", have: heldCurriculumItems() }))
      .catch((err) => console.error(`[${USERNAME}] evidence publish failed:`, err.message));
  });
  // Pathfinder setup -- movement costs, unbreakable blocks, search limits, path diagnostics --
  // is in pathfinding.js (split out 2026-11-10).
  setupPathfinding(bot, { username: USERNAME });
  installTorchTrail(bot); // tunneling.js: a torch every TORCH_SPACING blocks while digging
  // The shell SwimMovements.safeToBreak() reads has to exist before the first path search, not
  // only after the first timer tick (LIVING_SPACE_REFRESH_MS below) -- a bot spawns inside the
  // shared base and starts pathing immediately.
  try {
    refreshLivingSpace(bot, bot.spawnPoint);
  } catch (err) {
    console.error(`[${USERNAME}] initial living-space scan failed:`, err.message);
  }
  installEnchantsFix(bot); // equipment.js: digging while holding enchanted gear threw

  // Inventory persists across restarts (it's tied to the player's UUID in the world save, not
  // this process) -- worth checking gear right away, not only after an action changes it.
  equipBestArmor(bot).then(() => equipBestWeapon(bot)).catch((err) =>
    console.error(`[${USERNAME}] initial gear check failed:`, err.message));

  // Direct request, 2026-09-07 ("if a bot gets stuck... teleport... rather than continually
  // restart"). Real evidence: Babs reconnected at the EXACT SAME coordinate across seven
  // consecutive restarts over 9 minutes -- Minecraft persists player position across reconnects
  // just like a real player logging back in, so a crash-and-restart cycle does nothing for a bot
  // wedged in terrain; she just gets stuck again immediately. If something ELSE is also
  // crash-looping her every minute or two, checkStuck's own multi-minute in-process threshold
  // may never even complete one cycle before the next restart wipes its counters -- comparing
  // THIS fresh spawn's position against wherever she was saved right before the process went
  // down catches that compound case immediately, rather than needing to survive long enough in
  // one continuous run to notice on its own.
  try {
    const prior = await loadStuckState(PERSONA_NAME);
    const pos = bot.entity.position;
    let closeToLast = false;
    // 2026-09-25: a clean stop (deploy, systemctl restart) is not evidence of being wedged -- deploy
    // restarts had been adding to the streak and triggering the (then lethal) rescue teleport.
    if (prior && !prior.cleanShutdown) {
      const dx = pos.x - prior.x, dy = pos.y - prior.y, dz = pos.z - prior.z;
      closeToLast = Math.sqrt(dx * dx + dy * dy + dz * dz) < RESTART_STUCK_RADIUS;
    }
    currentSameSpotCount = closeToLast ? (prior.sameSpotCount || 0) + 1 : 0;
    await saveStuckState(PERSONA_NAME, { x: pos.x, y: pos.y, z: pos.z, sameSpotCount: currentSameSpotCount });
    if (currentSameSpotCount >= RESTART_STUCK_THRESHOLD) {
      const streak = currentSameSpotCount + 1;
      console.log(`[${USERNAME}] reconnected at essentially the same spot ${streak} times in a ` +
        `row -- likely wedged across restarts`);
      currentSameSpotCount = 0;
      await saveStuckState(PERSONA_NAME, { x: pos.x, y: pos.y, z: pos.z, sameSpotCount: 0 });
      await teleportToSpawn(`reconnected at the same spot ${streak} times in a row`);
    }
  } catch (err) {
    console.error(`[${USERNAME}] cross-restart stuck check failed:`, err.message);
  }
});

// TEMPORARY diagnostic (2026-09-06): both bots hit V8's heap limit and crashed twice in a row,
// at a steady ~4-5 MB/s from very early in the process's life -- not obviously tied to any one
// action. Logging memory + loaded-chunk-column count every 15s to find which subsystem is
// actually leaking before changing anything else. Remove once root-caused.
guardedInterval(() => {
  const mem = process.memoryUsage();
  const columns = bot.world?.getColumns ? bot.world.getColumns().length : "n/a";
  console.log(`[${USERNAME}] mem rss=${(mem.rss / 1048576).toFixed(1)}MB ` +
              `heap=${(mem.heapUsed / 1048576).toFixed(1)}/${(mem.heapTotal / 1048576).toFixed(1)}MB ` +
              `external=${(mem.external / 1048576).toFixed(1)}MB arrayBuffers=` +
              `${(mem.arrayBuffers / 1048576).toFixed(1)}MB chunks=${columns}`);
}, 15_000);

// Guards LLM-call reentrancy only (classify/muse/planNextStep generating a reply or a plan) --
// a genuinely separate concern from physical-action coherence, which is why it was never folded
// into the arbiter migration below. See goalTick's own "busy deliberately not held" comments,
// scattered across every idle-tick check, for why: an in-flight physical action must never block
// handleIncoming from at least classifying a live chat message, only from acting on it twice at
// once.
export let busy = false;
export function setBusy(value) { busy = value; return value; }
// The old `acting` flag (true for the whole span of a directly-requested/routine physical
// action, guarding the goal loop and every idle-tick check from starting a second one
// concurrently) is gone as of the coherence arbiter's Phase 3/4 migration (2026-09-10, see
// arbiter.js's own header) -- arbiter.isBusy()/requestControl()/release() is the one remaining
// source of truth for "is something physically happening right now," replacing 20+ independent
// reads of a bare boolean with a single, testable, priority-ordered module.
export let currentGoal = null;
export function setCurrentGoal(value) { currentGoal = value; return value; }
// Updated on every real chat/whisper/Matrix line and every goal set by a player -- the goal
// loop only ever proposes her own goal after this has been quiet a while (IDLE_BEFORE_SELF_GOAL_MS).
export let lastActivityAt = Date.now();
export function setLastActivityAt(value) { lastActivityAt = value; return value; }
// §15.5(d): updated in handleIncoming() whenever Mayor's own chat reaches this process (the same
// isMayor() exception to isAnotherBot() his directives already need to reach classifyIntent) --
// the liveness signal proposeFallbackDirective() uses to decide whether a Leader-secondary bot
// should step up. 0 means "never heard from Mayor this process," deliberately distinct from "he
// went quiet a while ago" -- see proposeFallbackDirective's own comment on why a fresh process
// with no baseline yet doesn't activate the fallback immediately.
export let lastMayorSeenAt = 0;
export function setLastMayorSeenAt(value) { lastMayorSeenAt = value; return value; }
// Review MB-11, 2026-09-24: recipients rejected every bot but Mayor, so the fallback coordinator's
// directives never reached anyone; and "never seen Mayor" (0) blocked the fallback forever for a
// fleet that booted without him. Liveness is now measured from process start when Mayor has
// never been heard, and every bot accepts the named fallback coordinator while Mayor is quiet.
const PROCESS_STARTED_AT = Date.now();
const FALLBACK_COORDINATOR_USERNAME = process.env.MC_FALLBACK_COORDINATOR_NAME || "Mark";
export function mayorUnreachable() {
  return Date.now() - (lastMayorSeenAt || PROCESS_STARTED_AT) >= MAYOR_LIVENESS_TIMEOUT_MS;
}
export function isActingCoordinator(speaker) {
  if (isMayor(speaker)) return true;
  return speaker !== USERNAME && mayorUnreachable() &&
    (speaker === FALLBACK_COORDINATOR_USERNAME ||
     speaker === `@mc-${FALLBACK_COORDINATOR_USERNAME.toLowerCase()}:spark`);
}
guardedInterval(goalHeartbeatTick, GOAL_HEARTBEAT_MS);

loadGoal(PERSONA_NAME).then((g) => {
  currentGoal = g;
  if (g) {
    console.log(`[${USERNAME}] resumed goal: ${g.description} (${g.steps} steps so far)`);
    broadcastGoalState("active", g.description); // MB-12: peers can't see a resume otherwise
  }
}).catch((err) => console.error(`[${USERNAME}] failed to load saved goal:`, err.message));

// Chat and intent: classifyIntent, the chat reply, narration and what gets remembered: in chat.js (split out 2026-11-10).
installChat();
guardedInterval(() => {
  if (!Object.keys(routineSkips).length) return;
  console.log(`[${USERNAME}] ROUTINE_SKIPS ${JSON.stringify(routineSkips)}`);
  for (const k of Object.keys(routineSkips)) delete routineSkips[k];
}, ROUTINE_SKIP_REPORT_MS);

guardedInterval(runGoalTick, GOAL_TICK_MS);

guardedInterval(() => {
  proposeDirectiveForOthers().catch((err) => console.error(`[${USERNAME}] proposeDirectiveForOthers error:`, err.message));
}, MAYOR_DIRECTIVE_MS);

guardedInterval(() => {
  proposeFallbackDirective().catch((err) => console.error(`[${USERNAME}] proposeFallbackDirective error:`, err.message));
}, MAYOR_DIRECTIVE_MS);

guardedInterval(() => {
  checkSleep().catch((err) => console.error(`[${USERNAME}] checkSleep error:`, err.message));
}, SLEEP_CHECK_MS);

guardedInterval(() => {
  checkDusk().catch((err) => console.error(`[${USERNAME}] checkDusk error:`, err.message));
}, DUSK_CHECK_MS);

// Self-defense, threat memory and squad response are in self-defense.js (split out 2026-11-10).
installSelfDefense();

guardedInterval(() => {
  checkHunger().catch((err) => console.error(`[${USERNAME}] checkHunger error:`, err.message));
}, HUNGER_CHECK_MS);

guardedInterval(() => {
  checkRipeCrops().catch((err) => console.error(`[${USERNAME}] checkRipeCrops error:`, err.message));
}, RIPE_CHECK_MS);

guardedInterval(() => {
  checkPendingGiveRequests().catch((err) =>
    console.error(`[${USERNAME}] checkPendingGiveRequests error:`, err.message));
}, GIVE_CHECK_MS);

guardedInterval(() => {
  checkDeferredSurplusCleanup().catch((err) =>
    console.error(`[${USERNAME}] post-craft cleanup failed:`, err.message));
}, 30_000);
guardedInterval(() => {
  checkSurplusSharing().catch((err) =>
    console.error(`[${USERNAME}] surplus sharing check failed:`, err.message));
}, SURPLUS_SHARING_CHECK_MS);
guardedInterval(() => {
  checkLocationSharing().catch((err) =>
    console.error(`[${USERNAME}] location sharing sweep failed:`, err.message));
}, LOCATION_SHARING_CHECK_MS);
guardedInterval(() => {
  checkChestConsolidation().catch((err) =>
    console.error(`[${USERNAME}] chest consolidation check failed:`, err.message));
}, CHEST_CONSOLIDATION_CHECK_MS);

guardedInterval(() => {
  checkInventoryFull().catch((err) => console.error(`[${USERNAME}] checkInventoryFull error:`, err.message));
}, INVENTORY_CHECK_MS);

guardedInterval(() => {
  checkTrash().catch((err) => console.error(`[${USERNAME}] checkTrash error:`, err.message));
}, TRASH_CHECK_MS);

guardedInterval(() => {
  checkInventoryInsurance().catch((err) =>
    console.error(`[${USERNAME}] checkInventoryInsurance error:`, err.message));
}, INVENTORY_CHECK_MS);

guardedInterval(() => {
  checkSaplings().catch((err) => console.error(`[${USERNAME}] checkSaplings error:`, err.message));
}, SAPLING_CHECK_MS);

guardedInterval(() => {
  checkLighting().catch((err) => console.error(`[${USERNAME}] checkLighting error:`, err.message));
}, LIGHTING_CHECK_MS);

// Efficiency pass, 2026-09-24 (measured: 6,195 home-lighting attempts/day across the fleet, 96
// successful -- every bot tried every ~90s, most walking to a chest for torches that weren't
// there). Now one maintainer (the Builder by default; MC_HOME_LIGHTING=true/false overrides per
// bot), and every failed attempt doubles the wait (up to 30 min) until one succeeds. Each bot's
// immediate local torch placement (checkLighting) is unchanged.
export const HOME_LIGHTING_MAINTAINER = process.env.MC_HOME_LIGHTING
  ? process.env.MC_HOME_LIGHTING === "true"
  : myRole?.primary === ROLES.BUILDER;

guardedInterval(() => {
  checkHomeLighting().catch((err) => console.error(`[${USERNAME}] checkHomeLighting error:`, err.message));
}, HOME_LIGHTING_CHECK_MS);
let lastLivingSpaceReport = "";
let lastLivingSpaceReportAt = 0;

guardedInterval(() => {
  if (!bot.entity) return;
  try {
    const space = refreshLivingSpace(bot, bot.spawnPoint);
    // "anchor(s)", not "bed(s)": bedAnchors() always includes the spawn point, so a world with no
    // beds in it at all still reports one anchor. Read as "bed(s)" that is simply wrong, which it
    // looked like on the fresh world of 2026-10-08 ("1 bed(s)" with nine bots and no bed placed).
    const summary = `${space.anchors.length} anchor(s), ${space.inside.size} interior cell(s), ` +
      `${space.cells.size} wall block(s) protected, ${space.exits.size} way(s) out`;
    if (summary === lastLivingSpaceReport && Date.now() - lastLivingSpaceReportAt < LIVING_SPACE_REPORT_MS) return;
    lastLivingSpaceReport = summary;
    lastLivingSpaceReportAt = Date.now();
    console.log(`[${USERNAME}] living space: ${summary}`);
  } catch (err) {
    console.error(`[${USERNAME}] living-space scan failed:`, err.message);
  }
}, LIVING_SPACE_REFRESH_MS);

guardedInterval(() => {
  checkAccessObstructions().catch((err) => console.error(`[${USERNAME}] checkAccessObstructions error:`, err.message));
}, ACCESS_CHECK_MS);

guardedInterval(() => {
  checkTorchSupply().catch((err) => console.error(`[${USERNAME}] checkTorchSupply error:`, err.message));
}, TORCH_SUPPLY_CHECK_MS);

guardedInterval(() => {
  checkTerrainDamage().catch((err) => console.error(`[${USERNAME}] checkTerrainDamage error:`, err.message));
}, TERRAIN_REPAIR_CHECK_MS);

guardedInterval(() => {
  checkShelterIntegrity().catch((err) => console.error(`[${USERNAME}] checkShelterIntegrity error:`, err.message));
}, SHELTER_INTEGRITY_CHECK_MS);
// Set once at spawn (by the cross-restart check below) and carried forward as-is by every
// periodic save in checkStuck -- NOT reset to 0 here, or the periodic saves would destroy the
// cross-restart signal before the next crash ever got a chance to read it back.
export let currentSameSpotCount = 0;

// Any pathfinder activity counts as "trying to move" for checkStuck's stationary-vs-stuck test.
export let lastMoveAttemptAt = 0;
for (const ev of ["goal_updated", "path_update", "path_reset"]) {
  bot.on(ev, () => { lastMoveAttemptAt = Date.now(); });
}

guardedInterval(checkStuck, STUCK_CHECK_MS);
// busy is also released by goalTick/proposeOwnGoal/etc., none of which know about the queue.
guardedInterval(drainIncoming, 1000);

bot.on("chat", (speaker, message) => {
  handleIncoming(speaker, message, { alreadyAddressed: false, send: (reply) => bot.chat(reply) });
});

// /msg, /tell, /w -- mineflayer fires these separately from public chat. Reply the same way
// (a private whisper back), not into public chat.
bot.on("whisper", (speaker, message) => {
  handleIncoming(speaker, message, {
    alreadyAddressed: true,
    send: (reply) => bot.whisper(speaker, reply),
  });
});

// Matrix (design doc §10): the shared room, same relevance-classification treatment as public
// in-game chat (alreadyAddressed: false) since more than one bot reads this room and a message
// may be meant for only one of them by name. Optional -- no MATRIX_ACCESS_TOKEN, no watcher.
if (MATRIX_ACCESS_TOKEN) {
  watchRoom({
    homeserver: MATRIX_HOMESERVER,
    accessToken: MATRIX_ACCESS_TOKEN,
    roomId: MATRIX_ROOM_ID,
    onMessage: ({ sender, body }) => {
      handleIncoming(sender, body, {
        alreadyAddressed: false,
        send: (reply) =>
          matrixSend({ homeserver: MATRIX_HOMESERVER, accessToken: MATRIX_ACCESS_TOKEN,
                       roomId: MATRIX_ROOM_ID, body: reply }).catch((err) =>
            console.error(`[${USERNAME}] matrix send failed:`, err.message)),
      });
    },
  });
  console.log(`[${USERNAME}] watching Matrix room ${MATRIX_ROOM_ID} as ${MATRIX_USER_ID}`);
} else {
  console.log(`[${USERNAME}] MATRIX_ACCESS_TOKEN not set -- Matrix room disabled`);
}
bot.once("spawn", watchFleetTopics);

// Direct request, 2026-09-07 ("do all" -> death/respawn handling), never addressed before now.
// Confirmed against mineflayer's own health.js source: bot.respawn() fires automatically on
// death (this fleet never passes `respawn: false`), and 'spawn' re-emits once she's actually
// back -- the SAME event the very first bot.once("spawn", ...) above reacts to, so a second,
// persistent bot.on("spawn", ...) listener is needed here rather than reusing that one (a
// `.once` listener never fires again). hasSpawnedOnce distinguishes "the initial connection" (do
// nothing extra) from "a real respawn after dying" (the only time this block should act).
let hasSpawnedOnce = false;

bot.on("death", () => {
  const now = Date.now();
  // bot.entity.position is still the death location at this point, before respawn repositions her.
  const killerGuess = (lastKnownThreat && now - lastKnownThreat.at <= DEATH_THREAT_ATTRIBUTION_MS)
    ? lastKnownThreat.name : "unknown";
  broadcastDeathAlert(bot.entity.position, killerGuess);
  console.log(`[${USERNAME}] died -- likely killed by ${killerGuess}`);
});

bot.on("spawn", () => {
  if (!hasSpawnedOnce) {
    hasSpawnedOnce = true;
    return; // the initial connection's own spawn -- already handled by the once() listener above
  }
  (async () => {
    console.log(`[${USERNAME}] respawned after dying`);
    try {
      bot.chat(await narrateAction("ouch, I died! let me get myself back together."));
    } catch (err) {
      console.error(`[${USERNAME}] death narration failed:`, err.message);
    }
    // Her standing goal's assumptions about where she is are now stale (death resets her position
    // to spawn/bed) -- doesn't make sense to just keep going as if nothing happened. Direct
    // request, 2026-10-28: with item drop on death turned off (keepInventory), gear is no longer
    // lost on death, so there's nothing left to walk back for -- the old post-death "recover"
    // march to the death position (and its rapid-death-streak cap) is gone.
    if (currentGoal) {
      await broadcastGoalState("abandoned", currentGoal.description);
      recordGoalOutcome(currentGoal.description, "gave up", "died");
      currentGoal = null;
      await clearGoal(PERSONA_NAME);
    }
  })().catch((err) => console.error(`[${USERNAME}] post-respawn handling failed:`, err.message));
});
bot.on("health", onEmergencyHealth);
bot.on("breath", onLowBreath);

guardedInterval(() => {
  checkSleepingThreat().catch((err) => console.error(`[${USERNAME}] checkSleepingThreat error:`, err.message));
}, SLEEPING_THREAT_CHECK_MS);

bot.on("kicked", (reason) => console.log(`[${USERNAME}] kicked:`, reason));
bot.on("error", (err) => console.log(`[${USERNAME}] error:`, err));
// Direct report, 2026-09-16 ("the bots do not appear to be active in world"): a real, severe,
// confirmed gap -- this handler only ever logged the disconnect, then did nothing else. Every
// setInterval-driven check (checkSelfDefense, checkSleepingThreat, proposeOwnGoal, goalTick...)
// kept firing on schedule against a `bot` object with no live connection, and several of them
// don't hard-error on a dead connection -- they resolve with misleading "success" instead
// ("squad response: arrived, nothing left to fight," "sleep: slept through the night. (ok=true)"
// were both logged live, in a tight, suspiciously regular rhythm, for over two hours after a
// real `keepAliveError` disconnect -- confirmed live: RCON's own `list` showed 0 of the 9 bots
// actually connected while every one of their systemd units still reported "active" and kept
// logging as if nothing had happened). A silently zombied process is worse than a crashed one --
// it actively misleads anyone (including a status check like this one) into believing the fleet
// is still operating. The fix is the same one already proven for OOM crashes: every bot service
// already runs under `Restart=always` -- exiting non-zero on ANY disconnect (network blip,
// keepalive timeout, a kick, the game server itself restarting) hands recovery to the exact same
// systemd machinery already relied on, giving a fresh process a real, clean reconnect instead of
// a stale one pretending to keep working.
// Record a clean shutdown so the next start doesn't count this stop toward the cross-restart
// wedge streak (see bot.once("spawn")).
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    const pos = bot.entity?.position;
    const save = pos
      ? saveStuckState(PERSONA_NAME, { x: pos.x, y: pos.y, z: pos.z, sameSpotCount: 0, cleanShutdown: true })
      : Promise.resolve();
    Promise.race([save, new Promise((r) => setTimeout(r, 2000))]).finally(() => process.exit(0));
  });
}

bot.on("end", (reason) => {
  console.log(`[${USERNAME}] disconnected:`, reason);
  process.exit(1);
});
