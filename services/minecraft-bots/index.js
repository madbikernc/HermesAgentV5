// Version: 2.13.1
//
// 2.13.1 (2026-09-07) -- third of five scoped enhancements: cave-pathfinding cap. Real evidence
// from tonight's own OOM crashes (hermes-minecraft-triage.py's log) traced to
// bot.pathfinder.searchRadius's DEFAULT of -1, confirmed by reading mineflayer-pathfinder's own
// source (index.js/astar.js) -- "don't limit the search area" at all. thinkTimeout (5000ms
// default) only bounds wall-clock time, not how many node objects get allocated within that
// window; in complex cave terrain that was enough to hit 25,000+ visited nodes and exhaust the
// heap before the timeout even fired. Set to 128 -- real headroom over every target distance this
// codebase actually asks for, while directly bounding the pathological case.
//
// 2.13.0 (2026-09-07) -- direct follow-up to "what other logic enhancements are available,"
// first two of five scoped and built in order: "ACTION PLACE <item_id>" wired throughout
// (classifyIntent so a player can ask directly, planNextStep's vocabulary and SMELT/CRAFT
// guidance -- placing a spare furnace/table she's carrying is now the preferred fallback over
// giving up or looting, proposeOwnGoal's own placement claim corrected to match). Explore/wander
// (actions.js 1.11.0's wanderAndRetryFind()) needed no wiring here -- it's internal to
// mine/loot/smelt's own existing "not found" handling, not a new verb the planner needs to know.
//
// 2.12.3 (2026-09-07) -- real gap found live: both bots kept self-proposing the exact same goal
// (e.g. "smelt some copper") immediately after giving up on it, since proposeOwnGoal had no
// memory of what she'd just tried -- an unproductive loop across separate goal cycles, distinct
// from and not fixed by anything within a single goal's own retry/consecutiveFailures logic. New
// recentGoalOutcomes (small, capped) records every done/gave-up outcome and gets folded into the
// self-propose prompt as data to reason about, not a hard blocklist -- sometimes repeating IS
// right (e.g. she just looted fuel she didn't have before).
//
// 2.12.2 (2026-09-07) -- two real gaps found live minutes after smelting shipped: (1) planNextStep
// never told the planner SMELT needs fuel, or what to do about it -- a bot with raw copper but no
// coal/charcoal/logs just kept retrying the same smelt attempt and gave up 3/3. Prompt now says
// to mine a log (valid fuel) if smelting fails for lack of fuel, same "mine the missing raw
// material" pattern already taught for crafting. (2) actions.js 1.10.1 fixes the matching root
// cause: SMELT's <item_id> is supposed to be the OUTPUT, but the planner sometimes named the
// INPUT raw material instead and got a confusing rejection -- now accepts either.
//
// 2.12.1 (2026-09-07) -- direct request: "they can't seem to find the furnaces." Most of
// tonight's goal-loop failures were bots correctly reasoning they needed an ingot and having no
// way to get one beyond hoping a chest had it -- real gap, not a bug: nothing here ever taught
// them furnaces exist. New "smelt" action (actions.js 1.10.0) wired in throughout: classifyIntent
// gets "ACTION SMELT" (a player can ask directly, same as every other action), planNextStep's
// prompt now teaches SMELT as the primary path for a smelted item (raw material -> furnace, not
// a crafting-table recipe, which can never produce one) with LOOT as the fallback rather than
// the only option, and proposeOwnGoal no longer tells a bot she has no furnace at all -- all
// three previously said "NO furnace/smelting capability," which was true when written and is
// simply no longer accurate now.
//
// 2.12.0 (2026-09-07) -- direct request: "the bots need to know to go to sleep at night." New
// checkSleep(), on its own 30s timer, entirely separate from goalTick's model-driven loop --
// deciding whether it's night needs no reasoning, just bot.time.timeOfDay (mineflayer core,
// matched to the exact window bed.js's own bot.sleep() enforces). Reuses busy/acting so a live
// command always takes precedence and interrupts a night's sleep (actions.js 1.9.0's stopCurrent
// now forces a wake for that). The real per-bed logic (finding one, trying it, waiting for
// morning) lives in actions.js's new "sleep" action, built on mineflayer's own bed.js plugin.
// Also added "ACTION SLEEP" to classifyIntent's vocabulary so a player can directly tell her to
// go to bed too, same as every other action.
//
// 2.11.6 (2026-09-07) -- two more fixes minutes after 2.11.5's token-budget bump: (1) the SAME
// truncation failure as 2.11.3 recurred at the doubled 220-token budget -- the model still
// doesn't reliably keep its reasoning to one sentence, so the budget went to 500 instead of a
// third incremental guess. (2) the loot-before-BLOCKED instruction (2.11.2) was ignored a second
// time -- the model stated its own reasoning ("no prior LOOT attempt...") and went BLOCKED
// anyway. This specific condition is simple and mechanically checkable (has "loot:" ever
// appeared in this goal's own log?), so goalTick now enforces it in code as a backstop rather
// than trusting a written instruction alone a second time.
//
// 2.11.4 (2026-09-07) -- real gap found live minutes after 2.11.3 shipped: even with the
// loot-before-BLOCKED requirement (2.11.2), a self-proposed goal phrased around an impossible
// METHOD ("smelt the copper into ingots") made the planner treat the goal as literally requiring
// that verb and go BLOCKED immediately, reasoning "the goal explicitly asks to smelt" -- never
// trying LOOT even though Recent progress was empty. The instruction to reinterpret charitably
// wasn't enough once the goal text itself named an impossible verb. Real fix is upstream:
// proposeOwnGoal's prompt now requires goals be phrased around the OUTCOME wanted ("get some
// copper armor"), never a specific method she can't perform ("smelt X", "build X") -- an
// outcome-phrased goal leaves room for the planner to reach it by looting instead.
//
// 2.11.3 (2026-09-07) -- two more real gaps found live within minutes of 2.11.2 shipping: (1) a
// factually-confused self-proposed goal ("smashing cobblestone into planks" -- planks come from
// logs, not stone) made the planner ramble past its one-sentence reasoning budget and get cut
// off by maxTokens before reaching its required final decision line -- parseGoalStep's fallback
// then counted as a real strike for a goal that was never fairly evaluated. Fixed at both ends:
// proposeOwnGoal's prompt now states the same real crafting facts planNextStep already knew, and
// planNextStep's own budget went from 120 to 220 tokens plus an explicit "reinterpret charitably,
// always end with a decision line" instruction. (2) a bot self-proposed "build a warm little
// house" -- building/placing was explicitly out of scope from this system's first design pass
// (MINECRAFT_BOTS_DESIGN.md §5) and no such action exists at all, so she'd have mined materials
// forever with no way to ever finish. Both prompts now say so explicitly.
//
// 2.11.2 (2026-09-07) -- real gap found live minutes after 2.11.1's reasoning fix shipped: Amy
// correctly reasoned, three separate times, that an ingot she needed could only come from
// looting a chest -- and then went BLOCKED anyway without ever actually issuing ACTION LOOT to
// check one. Correct diagnosis, no follow-through. planNextStep's prompt now explicitly requires
// a LOOT attempt to actually appear in Recent progress before BLOCKED is allowed for that reason.
//
// 2.11.1 (2026-09-07) -- real gap found live within minutes of 2.11.0 shipping: every goal-loop
// transition (a step taken, DONE, BLOCKED, giving up) only ever reached the player via bot.chat
// (in-game) or the goal's own persisted log -- nothing printed to console/journalctl, so a crash
// inside a step (see actions.js 1.8.1) left no trace to diagnose from except reading goal.json
// directly after the fact. Added explicit console.log for every one of these transitions --
// same "correctness/diagnosability over log-volume minimalism" instruction that made 2.10.0's
// path_update logging permanent.
//
// Firmament Minecraft bot orchestrator. Connects one bot and wires the first real decision
// loop: chat perception -> cheap relevance classification (dispatch role) -> in-character
// reply (muse role) -> bot chats back. See ../../MINECRAFT_BOTS_DESIGN.md.
//
// 2.11.0 (2026-09-07) -- direct request: "give her more autonomy to work towards longer goals,"
// with a real fork resolved by direct instruction: goals can come from a player (new "ACTION
// GOAL <description>" verb, classifyIntent's existing one-call vocabulary) OR the bot can
// propose her own once she's had no active goal and heard from no one for a while. Either way,
// a goal persists (goals.js, survives restart the same way inventory does) and gets worked one
// step at a time on its own timer (goalTick, MC_GOAL_TICK_MS) through the *same* performAction()
// pipeline a direct chat command already uses -- a standing goal is never a separate, less-
// tested way of moving/mining/fighting/crafting/looting. The tick only ever fires when nothing
// else has the bot's attention (`busy`/new `acting` flag), so a live player command always wins
// immediately and the goal loop just resumes on its own next tick once that command's action
// finishes -- no separate interrupt/resume logic needed, it falls out of the existing mutex.
// `ACTION STOP` now also abandons any active goal (matches the plain-English expectation that
// "stop" means stop everything, not just the current physical motion). performAction() needed a
// structural success/failure signal for this (actions.js 1.8.0, { ok, text } instead of a bare
// string) rather than regex-guessing "ok" from English result text, which would silently break
// the moment a message's wording changed.
//
// 2.10.0 (2026-09-07) -- direct report: navigation is unreliable around doors/ladders/stairs.
// mineflayer-pathfinder defaults canOpenDoors to false with its own comment ("Causes issues.
// Probably due to none paper servers.") -- enabled now that this fleet runs a mature, fully-
// supported version (1.21.11) rather than trusting a comment of unknown vintage. Also added
// permanent path_update/goal_reached/path_reset logging (astar's own real status/cost/visited-
// node data) so any future navigation failure is diagnosable from real data, not guesswork --
// kept permanently per direct instruction: correctness/diagnosability over call/log-volume
// minimalism, since everything here runs on local compute with no per-call cost.
//
// 2.9.0 (2026-09-06) -- direct request: "pre-teach the most common recipes." New "craft"
// action (classifyIntent detects it the same one-call way as every other action; the real
// implementation is actions.js's craftItem(), which uses minecraft-data's own built-in recipe
// knowledge rather than anything taught here).
//
// 2.8.0 (2026-09-06) -- direct request: bots should look in chests for gear, wear the best
// armor they find, and hold the best weapon unless a task needs a specific tool. New "loot"
// action (equipment.js + actions.js); gear is rechecked automatically after mine/attack/loot
// and once at spawn (inventory persists across restarts -- it's tied to the player's UUID in
// the world save). Crafting and building are still explicitly out of scope for this pass.
//
// 2.7.0 (2026-09-06) -- real in-world actions (actions.js): navigate (goto/follow/stop),
// gather (mine), and fight (attack) -- closing the gap between what the personas' Core
// Directives always claimed and what the bots could actually do. classifyIntent() replaces
// the old plain-YES/NO isRelevant() with one dispatch call that also detects an action
// request, keeping the "one cheap call" efficiency discipline intact rather than adding a
// second round-trip. Actions run in the background via runAction(), deliberately outside the
// `busy` window that guards the classify/reply step -- a mine/follow/attack can run for up to
// a minute (actions.js's own ACTION_TIMEOUT_MS), and holding that mutex for the whole span
// would make the bot go silent to chat while she works. Building/structure placement stays
// explicitly out of scope -- a much bigger feature (planning, materials, layout) that deserves
// its own pass, not something to half-build alongside navigate/gather/fight.
//
// 2.6.0 (2026-09-06) -- Matrix wired (design doc §10, matrix.js): a single shared room
// (operator's own decision, not one room per bot like the retired Sintra/Amy pattern), both
// bots and the operator as members. Talks directly to Continuwuity's Client-Server API, not
// the fleet's old "hermes gateway" tool (built around the different per-agent-room
// architecture). New Matrix accounts (mc-babs, mc-amy) registered via the standard
// enable-registration/create/re-lock recipe in infra/continuwuity/README.md. Credentials in
// ~/.hermes/minecraft-matrix.env, not Vaultwarden -- see run-bot.sh 1.3.0's own note on why.
// Reuses handleIncoming() exactly as public chat/whisper already did -- the isAnotherBot()
// guard (renamed from the Buzz-era BOT_USERNAMES-only check) now also recognizes any `@mc-`
// Matrix identity, so the same bot-relaying-into-a-shared-channel feedback loop 2.5.0 fixed for
// Buzz->in-game-chat can't happen for Matrix either.
//
// 2.5.0 (2026-09-06) -- bot-to-bot coordination over hermes-buzz.py (design doc §9, buzz.js).
// Every WORLD-scoped long-term memory (see maybeRemember) is also published to the shared
// `minecraft` Buzz topic; each bot subscribes and relays what it hears from other bots into
// in-game chat, a directly observable trace that coordination happened. Real feedback-loop
// risk found and fixed while building this: every bot is just another player to mineflayer, so
// without a guard, Babs relaying a Buzz message into public chat would trigger Amy's own `chat`
// listener and send her down the normal human-reply pipeline (and vice versa) -- MC_BOT_USERNAMES
// now excludes known bot identities from that pipeline entirely; bot-to-bot traffic stays on
// Buzz, never the chat-relevance loop meant for human players.
//
// 2.4.0 (2026-09-06) -- long-term memory via the new "minecraft" hermes-rag corpus (design doc
// §7, longterm.js): before each reply, a semantic search over past notes (both this bot's own
// and shared world facts) is folded into the muse call's system message. After each reply
// (never blocking it -- see maybeRemember's own comment), a cheap dispatch call decides
// whether the exchange contained anything worth remembering long-term and writes it as a small
// markdown note, reindexed immediately (content-hash dedup keeps repeat reindexes cheap).
//
// 2.3.0 (2026-09-06) -- persistent per-bot conversation memory via hermes-memory.py (design
// doc §7): every incoming line and every reply is recorded as a turn (agent=mc-<persona>,
// conv_id=mc-<persona>:<speaker>), and recent history for that speaker is read back before
// each reply -- she now remembers a conversation across restarts, not just within one process
// lifetime. Run via run-babs.sh, which fetches MEMORY_TOKEN from Vaultwarden once at startup
// (fetch-once-at-startup, same pattern every other fleet caller of hermes-memory uses) --
// running index.js directly without it still works, just stateless (memory.js's own
// best-effort fallback), same as before this version.
//
// 2.2.0 (2026-09-06) -- Boss registration: BOSS_USERNAMES resolves a real in-game username to
// the "Boss" role a persona file can reference (see agents/minecraft-babs/PROMPT.md's
// Behavioral Modifiers) without the persona file itself hardcoding an identity. Orchestrator's
// job, not the persona's -- CanisLupisM registered as the first Boss identity.
//
// 2.1.0 (2026-09-06) -- whisper handling: /msg, /tell, /w fire mineflayer's separate `whisper`
// event, not `chat` -- confirmed live (a real /tell produced no log line under 2.0.0). Replies
// to a whisper go back as a whisper, and skip the relevance check entirely since a whisper is
// already addressed to her by construction.
//
// 2.0.0 (2026-09-06) -- decision loop wired for the first time, replacing 1.0.0's pure
// connectivity-proof scaffolding. Deliberately minimal still: no memory (hermes-memory/
// hermes-rag), no Buzz, no Matrix -- one bot, one persona, one loop, proven end to end before
// any of that gets added. A `busy` flag serializes decisions per bot rather than letting
// concurrent chat lines pile up parallel router calls -- matches the design doc's own
// efficiency principle (§5): don't spend a model call faster than the previous one resolved.

import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { callRole } from "./router.js";
import { loadPersona } from "./persona.js";
import { recordTurn, recentTurns } from "./memory.js";
import { searchMemory, writeMemoryNote } from "./longterm.js";
import { publish as buzzPublish, watchTopic } from "./buzz.js";
import { watchRoom, sendMessage as matrixSend } from "./matrix.js";
import { loadActionPlugins, performAction } from "./actions.js";
import { equipBestArmor, equipBestWeapon, describeGear } from "./equipment.js";
import { loadGoal, saveGoal, clearGoal, newGoal, logStep } from "./goals.js";

const { pathfinder, Movements } = pathfinderPkg;

const HOST = process.env.MC_HOST || "192.168.1.221";
const PORT = parseInt(process.env.MC_PORT || "25580", 10);
const USERNAME = process.env.MC_BOT_USERNAME || "Babs";
const PERSONA_NAME = process.env.MC_BOT_PERSONA || USERNAME.toLowerCase();
const MAX_CHAT_LEN = 200;

// "The Boss" is a role a persona file can reference (see agents/minecraft-babs/PROMPT.md's
// Behavioral Modifiers) without the persona file itself needing to know a real username --
// identity resolution belongs to the orchestrator, not the persona. Registered here rather
// than in a config file since no config system exists yet; comma-separated for more than one
// in-game account later.
const BOSS_USERNAMES = (process.env.MC_BOSS_USERNAMES || "CanisLupisM,@phone1:spark")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isBoss(speaker) {
  return BOSS_USERNAMES.includes(speaker);
}

// Every bot is also just another player in mineflayer's eyes -- without this, Babs relaying a
// Buzz message into public chat (see the watchTopic handler below) would fire Amy's own `chat`
// listener and send her down the normal human-reply pipeline, and vice versa: an endless
// bot-reacts-to-bot loop. Known bot identities are excluded from that pipeline entirely;
// coordination between them happens over Buzz, not the in-game chat relevance/reply loop.
const BOT_USERNAMES = new Set(
  (process.env.MC_BOT_USERNAMES || "Babs,Amy").split(",").map((s) => s.trim()).filter(Boolean),
);

function isAnotherBot(speaker) {
  return BOT_USERNAMES.has(speaker) || speaker.startsWith("@mc-"); // Matrix bot identities
}

// Autonomy (standing goals): a whole-bot kill switch, an idle-before-self-proposing-a-goal
// window (real chat/whisper/Matrix/goal-setting all count as "not idle" -- see lastActivityAt),
// and a tick interval for actually working a goal. Since everything here runs on local compute
// with no per-call cost (direct instruction, 2026-09-06), 45s errs toward checking in often and
// reasoning carefully each time rather than stretching the interval to save calls.
const AUTONOMY_ENABLED = (process.env.MC_AUTONOMY_ENABLED ?? "true") !== "false";
const SELF_PROPOSE_GOALS = (process.env.MC_SELF_PROPOSE_GOALS ?? "true") !== "false";
const GOAL_TICK_MS = parseInt(process.env.MC_GOAL_TICK_MS || "45000", 10);
const IDLE_BEFORE_SELF_GOAL_MS = parseInt(process.env.MC_IDLE_SELF_GOAL_MS || "600000", 10); // 10 min
const MAX_CONSECUTIVE_FAILURES = 3;

// Matrix (design doc §10): a single shared room, operator + all bots -- the operator's own
// decision, a deliberate deviation from the retired Sintra/Amy per-agent-room pattern. Talks
// directly to Continuwuity's Client-Server API (matrix.js), not the old "hermes gateway" tool,
// which was built around that different architecture. Optional: if MATRIX_ACCESS_TOKEN isn't
// set, the bot simply doesn't join Matrix, same as every other best-effort integration here.
const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER || "http://10.129.1.15:6167";
const MATRIX_USER_ID = process.env.MATRIX_USER_ID || `@mc-${PERSONA_NAME}:spark`;
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || "";
const MATRIX_ROOM_ID = process.env.MATRIX_ROOM_ID || "!2rXcMwykUS2yVNTLGw:spark";

// mc-<persona> matches the design doc's own Buzz-identity convention (§9) -- reused here as
// the hermes-memory agent id so the same name means the same thing everywhere this bot shows
// up. One conv_id per speaker: a bot's memory of "the conversation with CanisLupisM" spans
// both public chat and whispers, rather than splitting by channel for no real benefit.
const AGENT_ID = `mc-${PERSONA_NAME}`;
const TASK_ID = `${AGENT_ID}-chat`;
const HISTORY_TURNS = 8;

function convId(speaker) {
  return `${AGENT_ID}:${speaker}`;
}

const persona = loadPersona(PERSONA_NAME);
console.log(`[${USERNAME}] loaded persona '${PERSONA_NAME}' (${persona.length} chars)`);

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: "offline",
});

bot.loadPlugin(pathfinder);
loadActionPlugins(bot);

bot.once("spawn", () => {
  console.log(`[${USERNAME}] spawned at`, bot.entity.position);
  const movements = new Movements(bot);
  // mineflayer-pathfinder defaults canOpenDoors to false, with its own comment: "Causes
  // issues. Probably due to none paper servers." Direct report: bots navigate badly around
  // doors, ladders, and stairs -- doors are the one of those three with a known, named,
  // library-level default working against them. Worth enabling now that this fleet runs a
  // mature, well-supported version (1.21.11) rather than trusting a comment of unknown
  // vintage -- if it turns out to genuinely misbehave here, that's diagnosable from the
  // path_update logging below, not a reason to leave it off untested.
  movements.canOpenDoors = true;
  bot.pathfinder.setMovements(movements);

  // Direct follow-up to "what other logic enhancements are available" -> cave-pathfinding cap:
  // real evidence from tonight's own OOM crashes (hermes-minecraft-triage.py's own log) traced
  // to bot.pathfinder.searchRadius's DEFAULT VALUE OF -1 (confirmed in mineflayer-pathfinder's
  // own index.js/astar.js) -- "don't limit the search area" at all. thinkTimeout (default 5000ms)
  // only bounds wall-clock time, not how many node objects get allocated within that window --
  // in complex cave terrain, that was enough to hit 25,000+ visited nodes and exhaust the V8
  // heap before the timeout even fired. 128 gives real headroom over every real target distance
  // this codebase ever asks for (mine/loot/smelt/wander are all well under 64 blocks) while
  // directly bounding the pathological case instead of just how long it's allowed to run.
  bot.pathfinder.searchRadius = 128;

  // Real-data visibility into navigation, not a guess: astar's own result status
  // ('success'/'partial'/'noPath'/'timeout') for every path (re)computation, so a bad
  // goto/follow (doors, ladders, stairs -- direct report, 2026-09-06) can be diagnosed from
  // what pathfinder itself actually concluded, the same evidence-based approach that found
  // every other real bug this build. Kept permanently, not stripped after one use --
  // correctness/diagnosability over minimizing log volume, per direct instruction.
  bot.on("path_update", (r) => {
    console.log(`[${USERNAME}] path_update status=${r.status} nodes=${r.path?.length ?? 0} ` +
                `visited=${r.visitedNodes ?? "?"} cost=${r.cost?.toFixed?.(1) ?? "?"} ` +
                `time=${r.time?.toFixed?.(0) ?? "?"}ms`);
  });
  bot.on("goal_reached", () => console.log(`[${USERNAME}] goal_reached`));
  bot.on("path_reset", (reason) => console.log(`[${USERNAME}] path_reset: ${reason}`));

  // Inventory persists across restarts (it's tied to the player's UUID in the world save, not
  // this process) -- worth checking gear right away, not only after an action changes it.
  equipBestArmor(bot).then(() => equipBestWeapon(bot)).catch((err) =>
    console.error(`[${USERNAME}] initial gear check failed:`, err.message));
});

// TEMPORARY diagnostic (2026-09-06): both bots hit V8's heap limit and crashed twice in a row,
// at a steady ~4-5 MB/s from very early in the process's life -- not obviously tied to any one
// action. Logging memory + loaded-chunk-column count every 15s to find which subsystem is
// actually leaking before changing anything else. Remove once root-caused.
setInterval(() => {
  const mem = process.memoryUsage();
  const columns = bot.world?.getColumns ? bot.world.getColumns().length : "n/a";
  console.log(`[${USERNAME}] mem rss=${(mem.rss / 1048576).toFixed(1)}MB ` +
              `heap=${(mem.heapUsed / 1048576).toFixed(1)}/${(mem.heapTotal / 1048576).toFixed(1)}MB ` +
              `external=${(mem.external / 1048576).toFixed(1)}MB arrayBuffers=` +
              `${(mem.arrayBuffers / 1048576).toFixed(1)}MB chunks=${columns}`);
}, 15_000);

let busy = false;
// True for the whole span of a directly-requested action (runAction), not just the fast
// classify step `busy` already guards -- the goal loop must never issue its own step while a
// player-requested mine/craft/loot/attack/goto/follow is actually running underneath it.
let acting = false;
let currentGoal = null;
// Updated on every real chat/whisper/Matrix line and every goal set by a player -- the goal
// loop only ever proposes her own goal after this has been quiet a while (IDLE_BEFORE_SELF_GOAL_MS).
let lastActivityAt = Date.now();
// Real gap found live (2026-09-07): with no memory of what she just gave up on, proposeOwnGoal
// kept re-picking the same goal (e.g. "smelt some copper") immediately after giving up on it for
// an environmental reason that hadn't changed (no unoccupied furnace nearby) -- an unproductive
// loop, not a bug in any single step. Capped small (not full history) since only the most recent
// couple of outcomes are relevant to "should I try this again right now."
const RECENT_GOAL_OUTCOMES_MAX = 4;
let recentGoalOutcomes = [];

function recordGoalOutcome(description, outcome, reason) {
  recentGoalOutcomes.push({ description, outcome, reason });
  if (recentGoalOutcomes.length > RECENT_GOAL_OUTCOMES_MAX) recentGoalOutcomes.shift();
}

loadGoal(PERSONA_NAME).then((g) => {
  currentGoal = g;
  if (g) console.log(`[${USERNAME}] resumed goal: ${g.description} (${g.steps} steps so far)`);
}).catch((err) => console.error(`[${USERNAME}] failed to load saved goal:`, err.message));

// One dispatch call classifies relevance AND detects an action request together, replacing
// the old plain YES/NO relevance check -- same "keep it to one cheap call" efficiency
// discipline the rest of this file already follows (maybeRemember, the old isRelevant this
// replaces). Real verbs only (actions.js): navigate, gather, fight -- no building/placement,
// a deliberately separate, much bigger feature not attempted here.
//
// Real bug found live (2026-09-06): a message addressed to Babs by name also made Amy start
// mining -- each bot's own classifier only ever knew about itself, with no way to recognize
// "this names a DIFFERENT bot" and stand down. OTHER_BOTS below fixes that. Same incident also
// surfaced a second bug: both bots mined "stone" despite neither being asked for it -- with no
// instruction covering "no specific block was actually named," the classifier had to invent
// *something* for ACTION MINE's required <block_id> rather than falling back to CHAT.
const OTHER_BOTS = [...BOT_USERNAMES].filter((n) => n !== USERNAME);

async function classifyIntent(speaker, message) {
  const otherBotsNote = OTHER_BOTS.length
    ? ` Other bots who may also be in this chat: ${OTHER_BOTS.join(", ")} -- if the message ` +
      `clearly names one of them instead of ${USERNAME}, respond NONE even if it looks like an ` +
      `action request.`
    : "";
  const reply = await callRole(
    "dispatch",
    [
      {
        role: "system",
        content:
          `You are an intent classifier for a Minecraft bot named ${USERNAME}, who has real ` +
          `in-game abilities: moving, following, mining/gathering blocks, fighting hostile ` +
          `mobs, checking chests for gear, and crafting items.${otherBotsNote} Given one chat ` +
          `message from another player, respond with EXACTLY ONE line, no explanation, no ` +
          `extra punctuation, in one of these forms:\n` +
          `NONE - not directed at ${USERNAME}, no response needed\n` +
          `CHAT - directed at ${USERNAME} but just conversation, not a request to do something\n` +
          `ACTION GOTO - asks ${USERNAME} to come to the speaker\n` +
          `ACTION FOLLOW - asks ${USERNAME} to follow the speaker\n` +
          `ACTION STOP - asks ${USERNAME} to stop what she is doing\n` +
          `ACTION MINE <block_id> <count> - asks ${USERNAME} to gather/mine a resource, ONLY ` +
          `if a specific resource/block was actually named or clearly implied. <block_id> must ` +
          `be the exact modern Minecraft block id (e.g. oak_log, stone, iron_ore, cobblestone). ` +
          `<count> is a small positive integer, default 4 if unstated. If no specific block is ` +
          `named, respond CHAT instead -- never invent a block.\n` +
          `ACTION ATTACK - asks ${USERNAME} to fight a nearby hostile mob\n` +
          `ACTION LOOT - asks ${USERNAME} to check a nearby chest for equipment/gear\n` +
          `ACTION SLEEP - asks ${USERNAME} to go find a bed and sleep (only makes sense at ` +
          `night or during a thunderstorm)\n` +
          `ACTION CRAFT <item_id> <count> - asks ${USERNAME} to craft/make an item, ONLY if a ` +
          `specific item was actually named or clearly implied. <item_id> must be the exact ` +
          `modern Minecraft item id (e.g. stick, oak_planks, wooden_pickaxe, crafting_table). ` +
          `<count> is a small positive integer, default 1 if unstated. If no specific item is ` +
          `named, respond CHAT instead -- never invent one.\n` +
          `ACTION SMELT <item_id> <count> - asks ${USERNAME} to smelt ore into an ingot (or ` +
          `similar) at a furnace, ONLY if a specific output was actually named or clearly ` +
          `implied (e.g. iron_ingot, copper_ingot, gold_ingot, glass, stone). <count> is a small ` +
          `positive integer, default 1 if unstated.\n` +
          `ACTION PLACE <item_id> - asks ${USERNAME} to place a block she's carrying right next ` +
          `to herself (e.g. a furnace or crafting_table she crafted). ONLY for placing one ` +
          `utility block for her own use, never for building/constructing anything.\n` +
          `ACTION GOAL <description> - gives ${USERNAME} a standing objective to keep working ` +
          `on by herself over time (not a single one-off task), e.g. "get full iron armor" or ` +
          `"stock up on wood". Only use this if the speaker is clearly assigning an ongoing ` +
          `objective, not just asking for one immediate thing. <description> is a short phrase.`,
      },
      { role: "user", content: `<${speaker}> ${message}` },
    ],
    { maxTokens: 16, temperature: 0 },
  );
  const trimmed = reply.trim().toUpperCase();
  if (trimmed.startsWith("ACTION")) {
    const parts = trimmed.split(/\s+/);
    const verb = parts[1];
    if (verb === "GOTO") return { type: "action", action: { type: "goto" } };
    if (verb === "FOLLOW") return { type: "action", action: { type: "follow" } };
    if (verb === "STOP") return { type: "action", action: { type: "stop" } };
    if (verb === "ATTACK") return { type: "action", action: { type: "attack" } };
    if (verb === "LOOT") return { type: "action", action: { type: "loot" } };
    if (verb === "SLEEP") return { type: "action", action: { type: "sleep" } };
    if (verb === "CRAFT") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (item) return { type: "action", action: { type: "craft", item, count: count > 0 ? count : 1 } };
    }
    if (verb === "SMELT") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (item) return { type: "action", action: { type: "smelt", item, count: count > 0 ? count : 1 } };
    }
    if (verb === "PLACE") {
      const item = (parts[2] || "").toLowerCase();
      if (item) return { type: "action", action: { type: "place", item } };
    }
    if (verb === "MINE") {
      const block = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (block) return { type: "action", action: { type: "mine", block, count: count > 0 ? count : 4 } };
    }
    if (verb === "GOAL") {
      // Re-extracted from the original (non-uppercased) reply so the description keeps its
      // natural casing/spacing rather than the all-caps, single-spaced tokens `parts` has.
      const match = reply.trim().match(/^ACTION\s+GOAL\s+(.+)$/i);
      const description = match ? match[1].trim() : "";
      if (description) return { type: "action", action: { type: "goal", description } };
    }
    return { type: "chat" }; // unparseable ACTION line -- fall back to a normal reply
  }
  if (trimmed.startsWith("CHAT")) return { type: "chat" };
  return { type: "none" };
}

// Short in-character line for an action's start/outcome -- same persona voice as a normal
// chat reply, just a much shorter, single-purpose prompt (no history/long-term recall: an
// action's own result text is already all the context worth having).
async function narrateAction(text) {
  const reply = await callRole(
    "muse",
    [
      { role: "system", content: `${persona}\n\n---\n\nYou are chatting in Minecraft's in-game ` +
          `chat, in character. State the following in one short sentence, in your own voice, ` +
          `without changing its meaning: "${text}"` },
      { role: "user", content: text },
    ],
    { maxTokens: 40, temperature: 0.9 },
  );
  return reply.trim().slice(0, MAX_CHAT_LEN) || text;
}

const CHAT_INSTRUCTION =
  "You are chatting in Minecraft's in-game chat, in character. Reply to the latest message " +
  "in 1-2 short sentences suitable for game chat. Do not prefix your own name.";

async function generateReply(speaker, message) {
  const conv = convId(speaker);

  // Best-effort: record the incoming line, then read back recent history for this speaker
  // (this call already includes the line just recorded, oldest-first -- see
  // hermes-memory.py's _list_turns). A hermes-memory outage degrades to a single-message
  // reply rather than failing the interaction -- never a hard dependency for chatting at all.
  let history = [{ role: "user", content: `<${speaker}> ${message}` }];
  try {
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "user",
                        raw: `<${speaker}> ${message}` });
    const turns = await recentTurns({ agent: AGENT_ID, convId: conv, limit: HISTORY_TURNS });
    if (turns.length) {
      history = turns.map((t) => ({ role: t.role, content: t.raw }));
    }
  } catch (err) {
    console.error(`[${USERNAME}] memory unavailable, replying without history:`, err.message,
                  err.cause ?? "");
  }

  // Long-term recall (design doc §7): a handful of semantically relevant notes from the
  // "minecraft" corpus -- both this bot's own personal memory and shared world facts, not
  // filtered by scope here since the corpus is still small and an instruction-following model
  // handles a little irrelevant context fine. Best-effort like everything else memory-related.
  let memoryNote = "";
  const hits = await searchMemory(message, { topK: 3 });
  if (hits.length) {
    memoryNote = "\n\nRelevant things you remember:\n" +
      hits.map((h) => `- ${h.text}`).join("\n");
  }

  // muse's chat template rejects a second system-role message anywhere but position 0
  // ("System message must be at the beginning") -- confirmed live, not assumed -- so persona,
  // the per-call instruction, the Boss note (when it applies), and any recalled long-term
  // memory are all merged into one system message, not sent separately.
  const bossNote = isBoss(speaker)
    ? ` The speaker (${speaker}) is The Boss -- respond accordingly to her Behavioral Modifiers.`
    : "";
  const text = await callRole(
    "muse",
    [{ role: "system", content: `${persona}\n\n---\n\n${CHAT_INSTRUCTION}${bossNote}${memoryNote}` },
     ...history],
    { maxTokens: 80, temperature: 0.9 },
  );
  const reply = text.slice(0, MAX_CHAT_LEN);

  if (reply) {
    try {
      await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "assistant",
                          raw: reply });
    } catch (err) {
      console.error(`[${USERNAME}] failed to record reply to memory:`, err.message, err.cause ?? "");
    }
  }
  return reply;
}

// Runs after a reply has already been sent -- never on the critical path a player is waiting
// on. Uses the same cheap `dispatch` tier the relevance check uses (design doc §6: dispatch is
// for reactive classification, not creative generation), asking it to decide whether anything
// in the exchange is worth long-term memory and, if so, whether it's a shared world fact or
// personal to this bot. A hermes-rag outage here just means nothing gets remembered long-term
// this turn -- never affects the chat itself.
async function maybeRemember(speaker, message, reply) {
  try {
    const verdict = await callRole(
      "dispatch",
      [
        {
          role: "system",
          content:
            "Given this Minecraft chat exchange, is there a concrete fact worth remembering " +
            "long-term (a discovery, location, stated preference, promise, or plan)? If yes, " +
            "respond exactly as 'WORLD: <one-sentence fact>' for an objective fact about the " +
            "world (locations, builds, shared knowledge), or 'PERSONAL: <one-sentence fact>' " +
            "for something about this specific speaker. If nothing is worth remembering, " +
            "respond exactly 'NONE'. Never explain, never add anything else.",
        },
        { role: "user", content: `<${speaker}> ${message}\n<bot reply> ${reply}` },
      ],
      { maxTokens: 60, temperature: 0 },
    );
    const trimmed = verdict.trim();
    if (trimmed.toUpperCase().startsWith("WORLD:")) {
      const fact = trimmed.slice(6).trim();
      await writeMemoryNote({ scope: "world", persona: PERSONA_NAME, text: fact });
      // Buzz coordination (design doc §9): other bots hear about a new world fact within one
      // poll interval, not only whenever they next happen to searchMemory() something related.
      try {
        await buzzPublish(AGENT_ID, "minecraft", fact);
      } catch (err) {
        console.error(`[${USERNAME}] buzz publish failed:`, err.message);
      }
    } else if (trimmed.toUpperCase().startsWith("PERSONAL:")) {
      await writeMemoryNote({ scope: "bot", persona: PERSONA_NAME,
                              text: `(about ${speaker}) ${trimmed.slice(9).trim()}` });
    }
  } catch (err) {
    console.error(`[${USERNAME}] maybeRemember failed:`, err.message);
  }
}

// Runs an action in the background and reports back -- deliberately NOT inside the `busy`
// window (see handleIncoming): a mine/follow/attack action can take up to ACTION_TIMEOUT_MS
// (actions.js), and holding the classify/reply mutex for that whole span would make the bot
// go unresponsive to chat while she works. `busy` only ever guards the fast classify step.
async function runAction(action, speaker, message, send) {
  // Real bug found live (2026-09-06): this used to record a generic "[requested action:
  // mine]" label, discarding the actual message text and parsed params (block/count) -- when
  // a mining request went to the wrong block, there was no way to tell from memory alone
  // whether the classifier misheard the request or the player's own message was ambiguous.
  // Recording the full parsed action alongside the original text fixes that for next time.
  const actionDesc = action.type === "mine" ? `mine ${action.block} x${action.count}`
    : action.type === "craft" ? `craft ${action.item} x${action.count}`
    : action.type === "smelt" ? `smelt ${action.item} x${action.count}`
    : action.type === "place" ? `place ${action.item}` : action.type;
  acting = true; // blocks the goal loop from stepping until this direct command is done
  try {
    const startLine = {
      goto: `heading to ${speaker}.`, follow: `following ${speaker} now.`, stop: "stopping.",
      mine: `off to gather some ${action.block}.`, attack: "engaging.",
      loot: "checking a nearby chest.", craft: `let's see about crafting ${action.item}.`,
      sleep: "heading to bed.", smelt: `time to smelt some ${action.item}.`,
      place: `let's set up a ${action.item} here.`,
    }[action.type];
    if (startLine) send(await narrateAction(startLine));

    const result = await performAction(bot, action, speaker);
    send(await narrateAction(result.text));

    // Actions are conversational events too -- worth the same continuity as a chat exchange.
    const conv = convId(speaker);
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "user",
                        raw: `<${speaker}> ${message} [parsed as: ${actionDesc}]` });
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "assistant", raw: result.text });
  } catch (err) {
    console.error(`[${USERNAME}] action '${action.type}' failed:`, err.message);
    send(`something went wrong trying to do that.`);
  } finally {
    acting = false;
  }
}

// Parses the goal planner's verdict -- deliberately separate from classifyIntent's own
// ACTION-line parser above, even though they overlap: the goal loop's vocabulary is narrower
// (no goto/follow/stop, which are speaker-relative and don't mean anything for a standing goal
// pursued alone) and has two extra terminal states classifyIntent has no use for (DONE/BLOCKED).
//
// Real gap found live (2026-09-07): the first version required the WHOLE reply to start with a
// known keyword, forcing a bare one-line answer with no room to reason -- dispatch is actually a
// full 35B model (same family as muse, just the stock quant, confirmed against hermes-router.py's
// own ROLES table), not a tiny classifier, but a one-line-only format meant it never connected
// "craft failed, no ingredients" back to "mine the raw material first": a live goal ("get a chest
// and some armor") burned all 3 retries on different CRAFT targets that all failed for the same
// underlying reason (no logs at all) and gave up, when mining logs first would have worked.
// Scanning from the LAST non-empty line for a known keyword lets the model reason for a
// sentence first (planNextStep's prompt now explicitly invites that) while still parsing
// reliably -- direct instruction: correctness/reasoning over minimizing tokens, since this all
// runs on local compute with no per-call cost.
function parseGoalStep(text) {
  const lines = text.trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.toUpperCase();
    if (trimmed.startsWith("DONE")) return { type: "done" };
    if (trimmed.startsWith("BLOCKED")) return { type: "blocked", reason: line.slice(7).trim() || "stuck" };
    if (trimmed.startsWith("ACTION")) {
      const parts = trimmed.split(/\s+/);
      const verb = parts[1];
      if (verb === "LOOT") return { type: "step", action: { type: "loot" } };
      if (verb === "ATTACK") return { type: "step", action: { type: "attack" } };
      if (verb === "CRAFT") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (item) return { type: "step", action: { type: "craft", item, count: count > 0 ? count : 1 } };
      }
      if (verb === "SMELT") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (item) return { type: "step", action: { type: "smelt", item, count: count > 0 ? count : 1 } };
      }
      if (verb === "PLACE") {
        const item = (parts[2] || "").toLowerCase();
        if (item) return { type: "step", action: { type: "place", item } };
      }
      if (verb === "MINE") {
        const block = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (block) return { type: "step", action: { type: "mine", block, count: count > 0 ? count : 4 } };
      }
    }
  }
  return { type: "blocked", reason: "couldn't decide what to do next" };
}

// One dispatch call per tick, grounded in real state (describeGear -- never guessed) and the
// goal's own recent log, not just the description -- so a repeated failure actually steers the
// next choice instead of retrying the same dead end forever (MAX_CONSECUTIVE_FAILURES is the
// hard backstop if reasoning alone doesn't catch it). maxTokens is deliberately generous (not
// the old 24) -- see parseGoalStep's comment on why a one-line-only format was the real problem.
async function planNextStep(goal) {
  const gearNote = describeGear(bot);
  const recentLog = goal.log.length ? goal.log.slice(-6).join("\n") : "(nothing done yet)";
  const reply = await callRole(
    "dispatch",
    [
      {
        role: "system",
        content:
          `You are the planner for a Minecraft bot named ${USERNAME} working toward a standing ` +
          `goal on her own, unprompted by anyone right now.\n\n` +
          `Real limits on what she can do: she can craft via a crafting-table/hand-crafting grid ` +
          `recipe (bot.craft), AND she can smelt at a furnace (ACTION SMELT) -- she is NOT stuck ` +
          `without ingots. An item normally obtained by smelting (iron_ingot, copper_ingot, ` +
          `gold_ingot, glass, stone from cobblestone) needs raw material first (raw_iron, ` +
          `raw_copper, raw_gold, sand, cobblestone -- mine it if she doesn't have any), THEN ` +
          `ACTION SMELT, not ACTION CRAFT -- crafting-table recipes can never produce a smelted ` +
          `item. SMELT also needs FUEL (coal, charcoal, or any log/planks) -- if it fails for ` +
          `lack of fuel and she has no coal/charcoal, mine a log (ACTION MINE oak_log or ` +
          `whatever log is nearby) rather than repeating the same smelt attempt; any log works ` +
          `as furnace fuel. If SMELT/CRAFT fails specifically because no furnace/crafting table ` +
          `is reachable, check her inventory for a spare one first -- ACTION PLACE it rather than ` +
          `giving up or looting, since placing a utility block she already made is faster and ` +
          `more reliable than hoping a chest has what she needs. Only fall back to ACTION LOOT if ` +
          `she has the raw material and fuel but SMELT still fails, or has no furnace reachable ` +
          `and none to place.\n` +
          `Common material chain: sticks and a crafting table both need planks; planks come from ` +
          `logs. If a craft fails for missing ingredients, check whether she's missing the raw ` +
          `material (e.g. no logs at all) rather than the item itself -- mine the raw material ` +
          `first instead of retrying the same craft.\n` +
          `She can place ONE utility block she's carrying (a furnace or crafting table, ACTION ` +
          `PLACE) for her own use, but has NO ability to build or place actual structures. If the ` +
          `goal is really about building/placing something bigger (a house, a base, a wall) ` +
          `rather than gearing up/gathering/crafting a portable item, respond BLOCKED immediately ` +
          `-- don't gather materials for a structure that can never actually get built.\n\n` +
          `Given the goal, her current gear/inventory, and what she's already tried below, you ` +
          `may reason briefly first -- AT MOST one short sentence, no matter how confusing or ` +
          `factually off the goal description sounds (reinterpret it charitably as the closest ` +
          `realistic Minecraft objective rather than dwelling on why it's worded oddly) -- then ` +
          `on its own final line you MUST respond with EXACTLY ONE of these forms, no exceptions:\n` +
          `DONE - the goal is already fully achieved given her current gear/inventory\n` +
          `BLOCKED <short reason> - she cannot make progress right now and should give up\n` +
          `ACTION MINE <block_id> <count> - gather a resource. <block_id> must be the exact ` +
          `modern Minecraft block id -- never invent one.\n` +
          `ACTION CRAFT <item_id> <count> - craft an item via a crafting-table/grid recipe only. ` +
          `<item_id> must be the exact modern Minecraft item id -- never invent one.\n` +
          `ACTION SMELT <item_id> <count> - smelt raw material into an ingot (or similar) at a ` +
          `furnace. <item_id> is the OUTPUT (e.g. iron_ingot), the exact modern Minecraft item ` +
          `id -- never invent one.\n` +
          `ACTION PLACE <item_id> - place a furnace or crafting_table she's already carrying, ` +
          `right next to herself, when SMELT/CRAFT needs one and none is reachable.\n` +
          `ACTION LOOT - check the nearest chest for gear\n` +
          `ACTION ATTACK - fight a nearby hostile mob\n` +
          `Pick the single most useful next step toward the goal. If the same step already ` +
          `failed more than once in a row (see recent progress below), you must try a genuinely ` +
          `different step that addresses the actual missing ingredient, or respond BLOCKED.`,
      },
      { role: "user", content: `Goal: ${goal.description}\n${gearNote}\nRecent progress:\n${recentLog}` },
    ],
    // Real bug found live (2026-09-07), TWICE -- once at 120 tokens, again at 220: the model
    // does not reliably obey "at most one short sentence" and sometimes writes a long run-on
    // reasoning sentence with parenthetical asides, getting cut off before its required final
    // decision line -- parseGoalStep's fallback ("couldn't decide what to do next") then counts
    // as a real strike toward MAX_CONSECUTIVE_FAILURES for a goal that was never actually given a
    // fair evaluation. Fighting the model's verbosity with prompt wording alone hasn't held up
    // twice in a row -- a genuinely generous budget is the robust fix instead of a third guess at
    // a slightly bigger number. This runs on local compute with no per-call cost, so there's no
    // real reason to be stingy here.
    { maxTokens: 500, temperature: 0 },
  );
  return reply.trim();
}

// Fires once a bot has had no active goal and heard from no one (chat/whisper/Matrix/a goal
// being set) for IDLE_BEFORE_SELF_GOAL_MS -- the "self-proposed" half of the operator's chosen
// autonomy design (the alternative, user-assigned-only, was explicitly not chosen). Uses `muse`,
// not `dispatch`: this is the one place autonomy calls for personality/creativity rather than
// mechanical classification -- what a bot chooses to do with idle time should sound like her,
// grounded in her real gear (never invented) and whatever long-term memory might suggest
// something worth pursuing.
async function proposeOwnGoal() {
  const gearNote = describeGear(bot);
  let memoryNote = "";
  try {
    const hits = await searchMemory("goals, plans, things worth doing or building", { topK: 3 });
    if (hits.length) {
      memoryNote = "\n\nThings you remember that might matter:\n" + hits.map((h) => `- ${h.text}`).join("\n");
    }
  } catch (err) {
    console.error(`[${USERNAME}] memory recall for self-goal failed:`, err.message);
  }

  // Real gap found live (2026-09-07): with no memory of what she just gave up on, this kept
  // re-picking the same goal (e.g. "smelt some copper") immediately after abandoning it for an
  // environmental reason that hadn't changed (no unoccupied furnace nearby) -- an unproductive
  // loop across separate goal cycles, distinct from and not fixed by anything within a single
  // goal's own retry logic. Handed to the model as data to reason about (not a hard blocklist)
  // since sometimes repeating IS right -- e.g. if she just looted fuel she didn't have before.
  const recentOutcomesNote = recentGoalOutcomes.length
    ? "\n\nYour last few goals:\n" + recentGoalOutcomes.map((o) =>
        `- "${o.description}" -> ${o.outcome}${o.reason ? ` (${o.reason})` : ""}`).join("\n") +
      "\nIf you gave up on something recently for a reason that hasn't changed (check your " +
      "gear/inventory below), pick something different instead of immediately repeating it."
    : "";

  const text = await callRole(
    "muse",
    [
      {
        role: "system",
        content:
          `${persona}\n\n---\n\nNo one has talked to you in a while and you have no standing ` +
          `goal right now. Given your own gear/inventory below, decide on ONE concrete, ` +
          `achievable objective to work on by yourself for a while (gearing up, gathering a ` +
          `resource, crafting or smelting something useful). Stay correctly grounded in real ` +
          `Minecraft mechanics -- e.g. planks/sticks/a table come from logs (never stone); ` +
          `ingots (iron/copper/gold) come from smelting raw ore at a furnace, which you CAN do, ` +
          `never from a crafting-table recipe. You can place a single utility block you're ` +
          `carrying (a furnace or crafting table) for your own use, but have NO ability to build ` +
          `or place actual structures -- never propose a goal about building/placing something ` +
          `(a house, a base, a wall); stick to gearing up, gathering a resource, or crafting/` +
          `smelting a portable item. Phrase the goal around the OUTCOME you want (e.g. "get some copper armor," ` +
          `"stock up on iron") rather than one specific method, since more than one way to get ` +
          `there might work -- but naming smelting/crafting as part of it is fine now, unlike ` +
          `building, which is never possible. Respond with ONLY a short phrase naming the goal, ` +
          `in your own words -- nothing else, no quotes.\n\n${gearNote}${memoryNote}${recentOutcomesNote}`,
      },
      { role: "user", content: "What's your goal?" },
    ],
    { maxTokens: 30, temperature: 0.9 },
  );
  const description = text.trim().replace(/^["']|["']$/g, "").slice(0, 120);
  if (!description) return;

  currentGoal = newGoal({ description, source: "self" });
  await saveGoal(PERSONA_NAME, currentGoal);
  console.log(`[${USERNAME}] self-proposed goal: ${description}`);
  bot.chat(await narrateAction(`new goal, on my own: ${description}.`));
}

// Runs on its own timer, entirely separate from handleIncoming's chat-driven busy window --
// only steps when nothing else has the bot's attention (busy/acting), so a live player command
// always wins immediately and this simply resumes on its own next tick once that command's
// action finishes. Reuses `busy`/`acting` themselves (rather than a third flag) so there is
// exactly one place goal-loop-vs-live-command precedence is decided, not two that could drift
// out of sync.
async function goalTick() {
  if (!AUTONOMY_ENABLED || busy || acting) return;

  if (!currentGoal) {
    if (!SELF_PROPOSE_GOALS || Date.now() - lastActivityAt < IDLE_BEFORE_SELF_GOAL_MS) return;
    busy = true;
    try {
      await proposeOwnGoal();
    } catch (err) {
      console.error(`[${USERNAME}] failed to self-propose a goal:`, err.message);
    } finally {
      busy = false;
    }
    return;
  }

  busy = true;
  acting = true;
  try {
    const stepLine = await planNextStep(currentGoal);
    let parsed = parseGoalStep(stepLine);
    console.log(`[${USERNAME}] goal plan: ${stepLine}`);

    // Real gap found live (2026-09-07), twice: the prompt explicitly says to try ACTION LOOT
    // before giving up on a smelting-only ingredient, and the model sometimes states that exact
    // reasoning out loud ("no prior LOOT attempt...") and goes BLOCKED anyway -- correct
    // diagnosis, no follow-through, the same failure shape as 2.11.2 but surviving a prose fix.
    // This particular condition is simple and mechanically checkable (has "loot:" appeared in
    // this goal's own log yet?), so it's enforced in code here instead of trusted to a written
    // instruction a second time -- prompt guidance plus a code guard, not prompt guidance alone.
    // Still a valid last-resort fallback now that ACTION SMELT exists (2.12.1): the prompt teaches
    // SMELT as the primary path for a smelted item, but if she's genuinely stuck (no furnace
    // reachable, out of fuel) LOOT remains a legitimate alternate source worth forcing once.
    if (parsed.type === "blocked" && /smelt|furnace|ingot/i.test(parsed.reason) &&
        !currentGoal.log.some((l) => l.startsWith("loot:"))) {
      console.log(`[${USERNAME}] overriding BLOCKED (${parsed.reason}) -- no LOOT attempt yet, forcing one`);
      parsed = { type: "step", action: { type: "loot" } };
    }

    if (parsed.type === "done") {
      console.log(`[${USERNAME}] goal complete: ${currentGoal.description}`);
      bot.chat(await narrateAction(`goal complete: ${currentGoal.description}.`));
      recordGoalOutcome(currentGoal.description, "done", null);
      currentGoal = null;
      await clearGoal(PERSONA_NAME);
      return;
    }

    if (parsed.type === "blocked") {
      logStep(currentGoal, `blocked: ${parsed.reason}`);
      currentGoal.consecutiveFailures += 1;
      console.log(`[${USERNAME}] goal blocked (${currentGoal.consecutiveFailures}/` +
                  `${MAX_CONSECUTIVE_FAILURES}): ${parsed.reason}`);
      if (currentGoal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[${USERNAME}] giving up on goal: ${currentGoal.description}`);
        bot.chat(await narrateAction(`giving up on "${currentGoal.description}" -- ${parsed.reason}.`));
        recordGoalOutcome(currentGoal.description, "gave up", parsed.reason);
        currentGoal = null;
        await clearGoal(PERSONA_NAME);
      } else {
        await saveGoal(PERSONA_NAME, currentGoal);
      }
      return;
    }

    const result = await performAction(bot, parsed.action, currentGoal.setBy || USERNAME);
    logStep(currentGoal, `${parsed.action.type}: ${result.text}`);
    currentGoal.consecutiveFailures = result.ok ? 0 : currentGoal.consecutiveFailures + 1;
    console.log(`[${USERNAME}] goal step: ${parsed.action.type} -> ${result.text} ` +
                `(ok=${result.ok}, consecutiveFailures=${currentGoal.consecutiveFailures})`);

    if (currentGoal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`[${USERNAME}] giving up on goal: ${currentGoal.description}`);
      bot.chat(await narrateAction(`giving up on "${currentGoal.description}" -- ${result.text}`));
      recordGoalOutcome(currentGoal.description, "gave up", result.text);
      currentGoal = null;
      await clearGoal(PERSONA_NAME);
      return;
    }

    await saveGoal(PERSONA_NAME, currentGoal);
    // A check-in every few steps, not every step -- otherwise gearing up would spam chat once
    // per GOAL_TICK_MS the whole time she works.
    if (currentGoal.steps % 3 === 0) {
      bot.chat(await narrateAction(`still working on ${currentGoal.description}: ${result.text}`));
    }
  } catch (err) {
    console.error(`[${USERNAME}] goal tick failed:`, err.message);
  } finally {
    busy = false;
    acting = false;
  }
}

setInterval(() => {
  goalTick().catch((err) => console.error(`[${USERNAME}] goalTick error:`, err.message));
}, GOAL_TICK_MS);

// Direct request (2026-09-07): "the bots need to know to go to sleep at night." Deliberately a
// plain deterministic check on its own timer, not folded into goalTick's model-driven loop --
// "is it night" needs no reasoning, just bot.time.timeOfDay (the exact window bed.js's own
// bot.sleep() already enforces, matched here so this never tries when sleep() would just reject
// anyway). Uses the same busy/acting mutex as everything else, so it never fires mid-command and
// a live command always interrupts it (actions.js's stopCurrent() forces a wake for that).
const SLEEP_CHECK_MS = parseInt(process.env.MC_SLEEP_CHECK_MS || "30000", 10);
// Tracks whether tonight's sleep has already been tried (successfully or not) so a bed-less
// bot doesn't retry every 30s and spam chat for the whole ~7-real-minute length of one night --
// resets the moment it's day again, ready for the next night.
let sleepAttemptedThisNight = false;

async function checkSleep() {
  if (!AUTONOMY_ENABLED || busy || acting || bot.isSleeping) return;

  const thunderstorm = bot.isRaining && bot.thunderState > 0;
  const isNight = thunderstorm || (bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458);
  if (!isNight) {
    sleepAttemptedThisNight = false;
    return;
  }
  if (sleepAttemptedThisNight) return;
  sleepAttemptedThisNight = true;

  busy = true;
  acting = true;
  try {
    bot.chat(await narrateAction("getting sleepy -- heading to bed."));
    const result = await performAction(bot, { type: "sleep" }, USERNAME);
    console.log(`[${USERNAME}] sleep: ${result.text} (ok=${result.ok})`);
    bot.chat(await narrateAction(result.ok ? result.text : `couldn't get to sleep: ${result.text}`));
  } catch (err) {
    console.error(`[${USERNAME}] sleep check failed:`, err.message);
  } finally {
    busy = false;
    acting = false;
  }
}

setInterval(() => {
  checkSleep().catch((err) => console.error(`[${USERNAME}] checkSleep error:`, err.message));
}, SLEEP_CHECK_MS);

// Setting a goal is a fast, synchronous-feeling operation (a disk write, not a physical
// action) -- it runs inline inside handleIncoming's busy window rather than through runAction's
// fire-and-forget/`acting` path.
async function setNewGoal(description, speaker) {
  currentGoal = newGoal({ description, source: "user", setBy: speaker });
  await saveGoal(PERSONA_NAME, currentGoal);
  return currentGoal;
}

function handleIncoming(speaker, message, { alreadyAddressed, send }) {
  if (speaker === bot.username || speaker === MATRIX_USER_ID) return;
  if (isAnotherBot(speaker)) return; // another bot's own chat/Matrix message -- coordinate over Buzz, not here
  lastActivityAt = Date.now(); // a real player is here -- the self-propose-a-goal idle clock resets
  if (busy) {
    console.log(`[${USERNAME}] busy, dropping: <${speaker}> ${message}`);
    return;
  }
  busy = true;
  (async () => {
    try {
      const intent = await classifyIntent(speaker, message);
      // A whisper is already directed at her by construction -- a whisper classified as not
      // relevant at all still deserves *some* reply, unlike an unaddressed line in public chat.
      const type = alreadyAddressed && intent.type === "none" ? "chat" : intent.type;
      if (type === "none") return;

      if (type === "action") {
        if (intent.action.type === "goal") {
          await setNewGoal(intent.action.description, speaker);
          send(await narrateAction(`new goal: ${intent.action.description}. I'll work on it.`));
          return;
        }
        // "stop" means stop everything, not just the current physical motion -- a standing
        // goal she was working on shouldn't silently keep going after being told to stop.
        if (intent.action.type === "stop" && currentGoal) {
          currentGoal = null;
          await clearGoal(PERSONA_NAME);
        }
        runAction(intent.action, speaker, message, send); // fire-and-forget, not awaited -- see runAction
        return;
      }

      const reply = await generateReply(speaker, message);
      if (reply) {
        send(reply);
        maybeRemember(speaker, message, reply); // fire-and-forget, not awaited
      }
    } catch (err) {
      console.error(`[${USERNAME}] decision loop error:`, err.message);
    } finally {
      busy = false;
    }
  })();
}

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

// Bot-to-bot coordination (design doc §9): hear what other bots have decided is worth
// remembering, and say so in-game -- a directly observable trace that coordination actually
// happened, the same reasoning BuzzLog's Matrix mirror exists for human observability.
bot.once("spawn", () => {
  watchTopic({
    topic: "minecraft",
    selfAgent: AGENT_ID,
    onMessage: (msg) => {
      console.log(`[${USERNAME}] heard on Buzz from ${msg.from_agent}: ${msg.body}`);
      bot.chat(`(heard from ${msg.from_agent}) ${msg.body}`.slice(0, MAX_CHAT_LEN));
    },
  });
});

bot.on("kicked", (reason) => console.log(`[${USERNAME}] kicked:`, reason));
bot.on("error", (err) => console.log(`[${USERNAME}] error:`, err));
bot.on("end", (reason) => console.log(`[${USERNAME}] disconnected:`, reason));
