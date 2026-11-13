// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: incoming chat and commands: new goals, stop, and the incoming queue.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { publish as buzzPublish, watchTopic } from "./buzz.js";
import * as arbiter from "./arbiter.js";
import { clearGoal, newGoal, saveGoal } from "./goals.js";
import { SQUAD_RESPONDER, respondToSquadCall, squadResponseInFlight } from "./self-defense.js";
import { classifyIntent, generateReply, maybeRemember, narrateAction } from "./chat.js";
import { runAction } from "./planning.js";
import { noteIronToolEvidence } from "./priorities.js";
import { GIVE_CLAIM_WINDOW_MS, broadcastGoalState, canSpareForRequest, giveClaims, noteNearbyResources, otherBotActivityAt, otherBotGoalSeenAt, otherBotGoals, pendingGiveRequest, recordGoalOutcome, withinSquadAssistRange } from "./fleet-coordination.js";
import { AGENT_ID, MATRIX_USER_ID, MAX_CHAT_LEN, MAYOR_USERNAME, PERSONA_NAME, USERNAME, bot, busy, currentGoal, isActingCoordinator, isAnotherBot, isMayor, lastActivityAt, lastMayorSeenAt, setBusy, setCurrentGoal, setLastActivityAt, setLastMayorSeenAt } from "./index.js";
import { creditCurriculumEvidence } from "./mayor.js";


// Setting a goal is a fast, synchronous-feeling operation (a disk write, not a physical
// action) -- it runs inline inside handleIncoming's busy window rather than through runAction's
// fire-and-forget/`acting` path.
async function setNewGoal(description, speaker) {
  setCurrentGoal(newGoal({ description, source: "user", setBy: speaker }));
  await saveGoal(PERSONA_NAME, currentGoal);
  await broadcastGoalState("active", description);
  return currentGoal;
}

// Not players: every bot is an op, so the server echoes each RCON/console command to it as chat
// from "Rcon"/"Server" (found by the behavior baseline, 2026-09-24 -- a live-test run flooded all
// nine bots' model classifier and message queues). The live-test bot (tests/live.test.mjs) is
// ignored too.
const NON_PLAYER_SPEAKERS = new Set(["Rcon", "Server",
  ...(process.env.MC_TEST_USERNAMES ?? "MBTester,MBProbe").split(",").map((s) => s.trim()).filter(Boolean)]);

export function handleIncoming(speaker, message, { alreadyAddressed, send }) {
  if (speaker === bot.username || speaker === MATRIX_USER_ID) return;
  if (NON_PLAYER_SPEAKERS.has(speaker)) return;
  // isMayor(speaker) exception, 2026-09-08: USERNAME !== MAYOR_USERNAME guards Mayor's own
  // process from ever treating himself as "a player talking to him" (redundant with the
  // bot.username check above in practice, kept explicit since this condition is the one place
  // that check is bypassed).
  if (isAnotherBot(speaker) && !(isActingCoordinator(speaker) && USERNAME !== MAYOR_USERNAME)) return;
  // §15.5(d): a real, already-arriving signal that Mayor is alive -- reuses the isMayor()
  // exception above rather than adding a new heartbeat. USERNAME !== MAYOR_USERNAME guards
  // Mayor's own process from tracking his own liveness (moot for him, and this condition is
  // already unreachable there in practice since his own messages never reach his own "chat"
  // listener -- kept explicit anyway, matching the same guard's existing precedent one line up).
  if (isMayor(speaker) && USERNAME !== MAYOR_USERNAME) setLastMayorSeenAt(Date.now());
  // Real live bug found 2026-09-08 ("check the bots other than mayor, they are stuck?"):
  // isMayor()'s own exception above lets Mayor's chat reach this function (needed for his
  // directives to reach classifyIntent -> ACTION GOAL), but this line used to reset
  // lastActivityAt for ANY message that got this far, Mayor's included -- and Mayor talks
  // periodically on his own (proposeDirectiveForOthers every MAYOR_DIRECTIVE_MS, his own
  // self-proposed-goal chat), which kept perpetually restarting every other bot's
  // IDLE_BEFORE_SELF_GOAL_MS countdown. Once a bot's own goal ended, she'd just stand there --
  // Mayor's mere presence meant the 10-minute idle window needed to self-propose a new one
  // could never actually elapse, unless he happened to specifically hand HER a new directive
  // (proposeDirectiveForOthers only ever picks one bot at a time) or a real player intervened.
  // Only an actual real player should count as "someone is here" for this specific clock --
  // Mayor's own directive-assignment already has its own real mechanism (ACTION GOAL) for
  // giving a bot something to do, it doesn't also need to gate everyone else's unrelated
  // self-propose timer.
  if (!isAnotherBot(speaker)) {
    setLastActivityAt(Date.now()); // a real player is here -- the self-propose-a-goal idle clock resets
  }
  // Review MB-06, 2026-09-24: an addressed STOP never waits on the model or on `busy` -- it
  // cancels the current physical action (anything up to DIRECT_COMMAND tier; emergencies keep
  // running) and drops the standing goal immediately.
  if (!isAnotherBot(speaker) && (isAddressedStop(message, alreadyAddressed) || isStopFromActiveCommander(speaker, message))) {
    stopNow(speaker, send).catch((err) => console.error(`[${USERNAME}] stop failed:`, err.message));
    return;
  }
  // ...and anything else that arrives mid-thought is queued, not dropped.
  if (busy) {
    queueIncoming(speaker, message, { alreadyAddressed, send });
    return;
  }
  setBusy(true);
  (async () => {
    try {
      const intent = await classifyIntent(speaker, message);
      // A whisper is already directed at her by construction -- a whisper classified as not
      // relevant at all still deserves *some* reply, unlike an unaddressed line in public chat.
      const type = alreadyAddressed && intent.type === "none" ? "chat" : intent.type;
      if (type === "none") return;

      if (type === "action") {
        if (intent.action.type === "goal") {
          // Direct request, 2026-09-08 ("the others can defer to him when his instructions are
          // not in conflict"): Mayor's own directive is the one goal-source that can be
          // overridden by something already in place -- a REAL PLAYER's own assignment
          // (source "user", set by anyone other than Mayor himself) outranks him, the same
          // hierarchy his own persona describes (defer to The President completely). A
          // self-proposed goal, an idle bot, or an earlier Mayor directive all yield to a new
          // one from him -- only a live human instruction doesn't.
          if (isActingCoordinator(speaker) && currentGoal?.source === "user" && currentGoal.setBy &&
              !isAnotherBot(currentGoal.setBy)) {
            send(await narrateAction(
              `already on something for ${currentGoal.setBy}, ${speaker} -- that comes first.`));
            return;
          }
          await setNewGoal(intent.action.description, speaker);
          send(await narrateAction(`new goal: ${intent.action.description}. I'll work on it.`));
          return;
        }
        // "stop" means stop everything, not just the current physical motion -- a standing
        // goal she was working on shouldn't silently keep going after being told to stop.
        if (intent.action.type === "stop" && currentGoal) {
          await broadcastGoalState("abandoned", currentGoal.description);
          setCurrentGoal(null);
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
      setBusy(false);
      drainIncoming();
    }
  })();
}

const STOP_MESSAGE = /^\s*(?:@?[\w-]+[,:]?\s+)?(?:stop|halt|freeze|cancel|stand down)(?:\s+(?:it|that|now|please))*\s*[!.]*\s*$/i;
function isAddressedStop(message, alreadyAddressed) {
  if (!STOP_MESSAGE.test(message)) return false;
  return alreadyAddressed || message.toLowerCase().includes(USERNAME.toLowerCase());
}

// Review MB-06 follow-up (2026-09-24): an unaddressed bare "stop" in shared chat still goes to
// the model -- unless it comes from the player whose direct command this bot is running right
// now, who clearly means this bot.
export let activeDirectSpeaker = null;
// For modules split out of this file: an imported binding is read-only there.
export function setActiveDirectSpeaker(value) { activeDirectSpeaker = value; }
function isStopFromActiveCommander(speaker, message) {
  return !!activeDirectSpeaker && speaker === activeDirectSpeaker && STOP_MESSAGE.test(message);
}

async function stopNow(speaker, send) {
  const stopped = arbiter.cancelIfAtMost(bot, arbiter.OWNERS.DIRECT_COMMAND.priority, "STOP");
  if (currentGoal) {
    await broadcastGoalState("abandoned", currentGoal.description);
    recordGoalOutcome(currentGoal.description, "gave up", `stopped by ${speaker}`);
    setCurrentGoal(null);
    await clearGoal(PERSONA_NAME);
  }
  console.log(`[${USERNAME}] STOP from ${speaker} (physical action cancelled: ${stopped})`);
  send(stopped || !arbiter.isBusy() ? "stopping." : "stopping as soon as I'm out of danger.");
}

const MAX_QUEUED_INCOMING = 5;
const QUEUED_INCOMING_MAX_AGE_MS = 60_000;
const pendingIncoming = [];
function queueIncoming(speaker, message, opts) {
  if (pendingIncoming.length >= MAX_QUEUED_INCOMING) {
    const dropped = pendingIncoming.shift();
    console.log(`[${USERNAME}] incoming queue full, dropping oldest: <${dropped.speaker}> ${dropped.message}`);
  }
  pendingIncoming.push({ speaker, message, opts, at: Date.now() });
  console.log(`[${USERNAME}] busy, queued: <${speaker}> ${message}`);
}
export function drainIncoming() {
  while (!busy && pendingIncoming.length) {
    const next = pendingIncoming.shift();
    if (Date.now() - next.at > QUEUED_INCOMING_MAX_AGE_MS) {
      console.log(`[${USERNAME}] queued message expired: <${next.speaker}> ${next.message}`);
      continue;
    }
    handleIncoming(next.speaker, next.message, next.opts);
  }
}

// Bot-to-bot coordination (design doc §9): hear what other bots have decided is worth
// remembering, and say so in-game -- a directly observable trace that coordination actually
// happened, the same reasoning BuzzLog's Matrix mirror exists for human observability.
export function watchFleetTopics() {
  watchTopic({
    topic: "minecraft",
    selfAgent: AGENT_ID,
    onMessage: (msg) => {
      console.log(`[${USERNAME}] heard on Buzz from ${msg.from_agent}: ${msg.body}`);
      bot.chat(`(heard from ${msg.from_agent}) ${msg.body}`.slice(0, MAX_CHAT_LEN));
    },
  });

  // Cross-bot coordination (direct request, 2026-09-07: "look for more ways to improve their
  // autonomy") -- goal-awareness and item-requests. Structured JSON, never relayed into chat
  // (see hermes-buzz.py 2.0.18's own comment on why this is a separate topic from "minecraft").
  watchTopic({
    topic: "minecraft-coordination",
    selfAgent: AGENT_ID,
    onMessage: (msg) => {
      let payload;
      try {
        payload = JSON.parse(msg.body);
      } catch {
        return; // not a real coordination payload -- ignore rather than crash on it
      }
      if (payload.type === "goal") {
        const unchangedHeartbeat = payload.heartbeat && otherBotGoals.get(msg.from_agent) === payload.description;
        if (payload.status === "active") {
          otherBotGoals.set(msg.from_agent, payload.description);
          otherBotActivityAt.set(msg.from_agent, Date.now());
          otherBotGoalSeenAt.set(msg.from_agent, Date.now());
        } else {
          otherBotGoals.delete(msg.from_agent);
          otherBotGoalSeenAt.delete(msg.from_agent);
        }
        if (unchangedHeartbeat) return; // lease refresh only -- nothing new to log or act on
        console.log(`[${USERNAME}] heard ${msg.from_agent}'s goal: ${payload.status === "active" ? payload.description : "(idle)"}`);
        // Tech-tree curriculum (2026-09-08): Mayor has no view into another bot's own
        // inventory, so her OWN verified "done" broadcast (parseGoalStep's real, checked
        // DONE <item_id>, not a self-reported claim) is the only trustworthy signal available
        // for tracking someone else's progress -- payload.item is null for a skill-served
        // completion or a NONE-typed goal, both harmlessly no-ops here.
        if (USERNAME === MAYOR_USERNAME && payload.status === "done" && (payload.item || payload.have?.length)) {
          creditCurriculumEvidence(msg.from_agent, [payload.item, ...(payload.have ?? [])]);
        }
        // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a): NOT Mayor-gated, unlike the credit
        // above -- every bot needs to be able to see "has the fleet reached iron tools" for
        // herself, not just Mayor (see fleetHasReachedIronTools()'s own header for why).
        noteIronToolEvidence([payload.item, ...(payload.have ?? [])].filter(Boolean));
      } else if (payload.type === "evidence") {
        if (USERNAME === MAYOR_USERNAME && payload.have?.length) creditCurriculumEvidence(msg.from_agent, payload.have);
        noteIronToolEvidence(payload.have ?? []);
      } else if (payload.type === "threat" && SQUAD_RESPONDER && !squadResponseInFlight) {
        if (withinSquadAssistRange(payload)) {
          console.log(`[${USERNAME}] squad response: ${msg.from_agent} under attack (${payload.name}) ` +
                      `-- moving to assist`);
          respondToSquadCall(payload).catch((err) =>
            console.error(`[${USERNAME}] squad response failed:`, err.message));
        }
      } else if (payload.type === "death") {
        // Direct request, 2026-09-13 ("be aware when fellow bots are killed by a mob"). Every
        // bot logs it (cheap, universal awareness -- same "costs nothing, might as well be
        // universal" reasoning broadcastThreatAlert's own header already uses); only a
        // SQUAD_RESPONDER actually goes to secure the spot, reusing respondToSquadCall as-is
        // since it only ever reads payload.x/y/z -- whatever killed her may well still be right
        // there.
        console.log(`[${USERNAME}] heard ${msg.from_agent} was killed (likely by ${payload.killer})`);
        if (SQUAD_RESPONDER && !squadResponseInFlight && withinSquadAssistRange(payload)) {
          console.log(`[${USERNAME}] squad response: ${msg.from_agent} was killed by ` +
                      `${payload.killer} -- moving to secure the area`);
          respondToSquadCall(payload).catch((err) =>
            console.error(`[${USERNAME}] squad response (death) failed:`, err.message));
        }
      } else if (payload.type === "request" && !pendingGiveRequest) {
        // Only claims one request at a time, and only with inventory to spare (review MB-13 --
        // see giveClaims' own header for the single-supplier protocol).
        if (payload.forPlayer !== USERNAME && canSpareForRequest(payload.item, payload.count)) {
          const requestId = `${msg.from_agent}:${msg.seq}`;
          const request = { forPlayer: payload.forPlayer, item: payload.item, count: payload.count };
          giveClaims.set(requestId, { request, claimants: new Set([USERNAME]), decideAt: Date.now() + GIVE_CLAIM_WINDOW_MS });
          buzzPublish(AGENT_ID, "minecraft-coordination", JSON.stringify({ type: "claim", requestId, donor: USERNAME }))
            .catch((err) => console.error(`[${USERNAME}] give claim publish failed:`, err.message));
          console.log(`[${USERNAME}] claiming ${msg.from_agent}'s request for ${payload.count} ${payload.item}`);
        }
      } else if (payload.type === "claim") {
        giveClaims.get(payload.requestId)?.claimants.add(payload.donor);
      } else if (payload.type === "delivered" && payload.forPlayer === USERNAME) {
        console.log(`[${USERNAME}] drop reported: ${payload.count} ${payload.item} from ${payload.donor}; pickup unverified`);
      } else if (payload.type === "scout") {
        // Direct request, 2026-09-11 ("ask the other bots to look near themselves... they
        // add/update their knowledge of nearby resources into global world memory"). Same
        // fire-and-forget, no-arbiter-needed reasoning as noteNearbyResources()'s own header --
        // never interrupts whatever she's actually doing, and never replies directly to
        // msg.from_agent either: every bot (asker included) writes to the one shared world-
        // memory corpus, so the asker's own later findRememberedLocation() (actions.js) picks
        // up whatever anyone wrote, same as if she'd stumbled onto it herself.
        noteNearbyResources(`${msg.from_agent}'s scout request for ${payload.resource}`, [payload.resource]).catch((err) =>
          console.error(`[${USERNAME}] scout response failed:`, err.message));
      }
    },
  });
}
