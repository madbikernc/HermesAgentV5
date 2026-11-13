// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: role notes, recent goal outcomes, the fleet's goal/give/threat/death broadcasts and resource notes.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { writeMemoryNote } from "./longterm.js";
import { publish as buzzPublish } from "./buzz.js";
import { getResourceBlockNames, isEssentialItem } from "./actions.js";
import { SQUAD_ASSIST_RANGE } from "./self-defense.js";
import { BOT_ROLES } from "./roles.js";
import { AGENT_ID, PERSONA_NAME, USERNAME, bot, currentGoal, myRole, persona } from "./index.js";
import { heldCurriculumItems } from "./mayor.js";
import { isKeptItem } from "./upkeep-inventory.js";


// §15.5(a): additive text folded into proposeOwnGoal()'s freeform prompt -- a lean, not a hard
// filter. Empty string for a bot with no role entry yet, so this is a no-op until every bot has
// one.
// roles.js 1.2.0: an optional advisory `priorities` list on a role -- an ordered SUGGESTION, not
// a hard filter or a checked-against-reality ladder the way Builder's own §15.6 checklist is
// (that one lives in this file's own nextBuilderPriority(), deliberately separate and
// deterministic). Formatted here as plain numbered text folded into the same prompt -- the model
// is free to ignore it if something better fits what's actually in front of her right now.
function priorityListNote(role) {
  if (!role?.priorities?.length) return "";
  const lines = role.priorities.map((p, i) => `${i + 1}. ${p}`).join("\n");
  return `\n\nSuggested priority order for ${role.name} (not a strict requirement, just a lean):\n${lines}`;
}

// Direct request, 2026-09-11 ("adaptive role-leaning"). Most recent timestamp among every bot
// whose PRIMARY role matches roleName being seen actively working on something (including this
// bot herself, if it's her own primary and she has a live goal right now) -- reads
// otherBotActivityAt (updated for free alongside otherBotGoals in the existing Buzz handler
// below, no new message/poll). Returns 0 if nobody holding that role has been observed active
// this process's lifetime -- deliberately in-memory only, same low-stakes tradeoff
// lastRoleAssignedAt (Mayor's own tiebreak, §15.5(b)) already makes.
function lastRoleActivityAt(roleName) {
  let latest = (myRole?.primary?.name === roleName && currentGoal) ? Date.now() : 0;
  for (const [agent, at] of otherBotActivityAt) {
    const persona = agent.replace(/^mc-/, "");
    if (BOT_ROLES[persona]?.primary?.name === roleName && at > latest) latest = at;
  }
  return latest;
}

const ROLE_NEGLECTED_MS = 20 * 60_000; // 20 min with zero observed activity -> worth leaning into

export function roleBiasNote() {
  if (!myRole) return "";
  const secondary = myRole.secondary
    ? ` Your secondary focus is ${myRole.secondary.name} (${myRole.secondary.domain}).`
    : "";
  // Project Sid's own key specialization finding: role differentiation required agents to track
  // OTHER agents' goals and adjust their own accordingly -- without it, roles stayed homogeneous.
  // This fleet's roles are operator-assigned, not emergent, but the same signal (otherBotGoals,
  // already tracked for collision-avoidance, §12) can still make the SECONDARY lean adaptive
  // instead of a fixed, always-primary-first preference: if nobody holding this bot's secondary
  // role as their OWN primary has done anything observable in a while, that's a real, concrete
  // reason to lean into it now rather than defaulting to primary out of habit.
  let neglectNote = "";
  if (myRole.secondary) {
    const lastSeen = lastRoleActivityAt(myRole.secondary.name);
    if (lastSeen === 0 || Date.now() - lastSeen > ROLE_NEGLECTED_MS) {
      neglectNote = ` Nobody in the fleet appears to have done real ${myRole.secondary.name} ` +
        `work recently -- extra reason to lean into your secondary now if nothing in your ` +
        `primary's lane stands out.`;
    }
  }
  return `\n\nYour primary role is ${myRole.primary.name} (${myRole.primary.domain}).` +
    `${secondary} Usually propose something in your primary's lane; your secondary is fair game ` +
    `too, especially if primary opportunities are thin nearby or something secondary-shaped is ` +
    `right in front of you.${neglectNote} Universal needs (hunger, gear, safety) still come ` +
    `first regardless of role, exactly as before.` +
    `${priorityListNote(myRole.primary)}${priorityListNote(myRole.secondary)}`;
}
// Real gap found live (2026-09-07): with no memory of what she just gave up on, proposeOwnGoal
// kept re-picking the same goal (e.g. "smelt some copper") immediately after giving up on it for
// an environmental reason that hadn't changed (no unoccupied furnace nearby) -- an unproductive
// loop, not a bug in any single step. Capped small (not full history) since only the most recent
// couple of outcomes are relevant to "should I try this again right now."
const RECENT_GOAL_OUTCOMES_MAX = 4;
export let recentGoalOutcomes = [];

export function recordGoalOutcome(description, outcome, reason) {
  recentGoalOutcomes.push({ description, outcome, reason });
  if (recentGoalOutcomes.length > RECENT_GOAL_OUTCOMES_MAX) recentGoalOutcomes.shift();
}

// Cross-bot coordination (direct follow-up, 2026-09-07: "look for more ways to improve their
// autonomy"), kept current by the "minecraft-coordination" Buzz subscription set up alongside
// the existing "minecraft" one, near the bottom of this file.
//
// Real gap found live, 2026-09-07 ("ask Muse to spawn two more bots, named Mark and Luke"): this
// was a single `let otherBotGoal`, correct only for exactly two bots -- with a 3rd/4th bot on the
// roster, each new Buzz message would just overwrite it, silently losing track of every OTHER
// bot's goal except whichever one posted most recently. Keyed by from_agent instead, so it
// scales to however many bots are actually running.
export const otherBotGoals = new Map(); // from_agent -> last-known active goal description

// Direct request, 2026-09-11 ("adaptive role-leaning" -- a research pass into Project Sid found
// its key specialization finding: role differentiation required agents to track OTHER agents'
// goals/intentions and adjust their own accordingly -- without that, roles stayed homogeneous.
// This fleet's roles are operator-assigned, not emergent, but the same signal was sitting right
// here unused: otherBotGoals already tracks what everyone else is doing in real time, just never
// fed into a bot's own role-lean. Timestamped alongside otherBotGoals itself, same Buzz handler,
// so this is genuinely free -- no new message, no new poll.
export const otherBotActivityAt = new Map(); // from_agent -> Date.now() of their last "active" goal broadcast
export let pendingGiveRequest = null;
export function setPendingGiveRequest(value) { pendingGiveRequest = value; return value; } // {forPlayer, item, count, expiresAt} she's won and must fulfill, or null
// Review MB-13, 2026-09-24: every bot holding enough used to answer the same request, so several
// dropped their work to deliver duplicates. Eligible donors now publish a "claim"; after
// GIVE_CLAIM_WINDOW_MS (longer than two Buzz poll intervals, so every claim has arrived) each
// claimant applies the same deterministic rule -- lowest-sorted name wins -- so exactly one bot
// delivers. requestId -> { request, claimants: Set<name>, decideAt }.
export const GIVE_CLAIM_WINDOW_MS = 15_000;
const GIVE_REQUEST_TTL_MS = 5 * 60_000;
export const giveClaims = new Map();

// A donor never gives away its last essential/kept item, or something its own goal names.
export function canSpareForRequest(item, count) {
  const itemDef = bot.registry.itemsByName[item];
  const have = itemDef ? bot.inventory.count(itemDef.id, null) : 0;
  const mustKeep = isEssentialItem(item) || isKeptItem(item) ? 1 : 0;
  if (have - count < mustKeep) return false;
  return !(currentGoal && currentGoal.description.toLowerCase().includes(item.replace(/_/g, " ")));
}

export function settleGiveClaims() {
  const now = Date.now();
  for (const [requestId, claim] of giveClaims) {
    if (now < claim.decideAt) continue;
    giveClaims.delete(requestId);
    const winner = [...claim.claimants].sort()[0];
    if (winner !== USERNAME || pendingGiveRequest) continue;
    if (!canSpareForRequest(claim.request.item, claim.request.count)) continue;
    pendingGiveRequest = { ...claim.request, requestId, attempts: 0, expiresAt: now + GIVE_REQUEST_TTL_MS };
    console.log(`[${USERNAME}] won the claim for ${requestId} (${claim.claimants.size} claimant(s))`);
  }
}

// Shared by planNextStep and proposeOwnGoal (previously two near-identical inline blocks, one
// per singular `otherBotGoal` -- now one function over the Map, listing every other bot with an
// active goal instead of assuming there's only ever one).
export function otherGoalsNote(intro) {
  if (!otherBotGoals.size) return "";
  const lines = [...otherBotGoals.entries()].map(([agent, desc]) => `- ${agent}: ${desc}`).join("\n");
  return `\n\n${intro}\n${lines}`;
}

// Deliberately a separate topic from "minecraft" -- see hermes-buzz.py 2.0.18's own comment on
// why (both bots relay everything they hear on "minecraft" into in-game chat; a raw JSON
// coordination payload has no business being read aloud). Best-effort like every other Buzz call
// in this file -- a publish failure here should never break the goal loop that triggered it.
// `item` (optional): the real, verified item that proved a "done" completion (parseGoalStep's
// own DONE <item_id>, already checked against real inventory/equipped gear before this ever
// fires -- see that fix's own header). Added for Mayor's tech-tree curriculum
// (proposeDirectiveForOthers/checkCurriculumProgress below): a trustworthy, structured "bot X
// really has item Y now" signal, not another text description to fuzzy-match against.
export async function broadcastGoalState(status, description, item = null, heartbeat = false) {
  // Efficiency pass, 2026-09-24: a "done" also reports every curriculum item she holds, so Mayor
  // gets complete stage evidence in one message instead of re-assigning the stage item by item.
  const have = status === "done" ? heldCurriculumItems() : undefined;
  try {
    await buzzPublish(AGENT_ID, "minecraft-coordination",
      JSON.stringify({ type: "goal", status, description, item, heartbeat, have }));
  } catch (err) {
    console.error(`[${USERNAME}] goal broadcast failed:`, err.message);
  }
}

// Review MB-12, 2026-09-24: peers only ever learned about goal TRANSITIONS, Buzz skips history on
// startup, and a resumed goal was never announced -- a restarted Mayor saw busy bots as idle, and
// a bot that disconnected mid-goal stayed "busy" forever. Every bot now re-announces its current
// goal every GOAL_HEARTBEAT_MS, and peers expire an entry not heard for GOAL_LEASE_MS.
export const GOAL_HEARTBEAT_MS = 2 * 60_000;
export const GOAL_LEASE_MS = GOAL_HEARTBEAT_MS * 3 + 30_000;
export const otherBotGoalSeenAt = new Map(); // from_agent -> Date.now() of their last "active" broadcast

export function goalHeartbeatTick(now = Date.now()) {
  if (currentGoal) broadcastGoalState("active", currentGoal.description, null, true);
  for (const [agent, at] of otherBotGoalSeenAt) {
    if (now - at <= GOAL_LEASE_MS) continue;
    otherBotGoalSeenAt.delete(agent);
    if (otherBotGoals.delete(agent)) console.log(`[${USERNAME}] ${agent}'s goal lease expired -- treating as idle`);
  }
}

// Item #6 of "fix all the above" (squad response for Mark/Luke). Same best-effort broadcast
// pattern as broadcastGoalState -- see checkSelfDefense's own call site for the cooldown that
// keeps one drawn-out fight from spamming this every 2s.
export async function broadcastThreatAlert(threatName) {
  try {
    await buzzPublish(AGENT_ID, "minecraft-coordination", JSON.stringify({
      type: "threat", name: threatName,
      x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
    }));
  } catch (err) {
    console.error(`[${USERNAME}] threat alert broadcast failed:`, err.message);
  }
}

// Direct request, 2026-09-13 ("soldier personas need to... be aware when fellow bots are killed
// by a mob") -- a real, confirmed gap: bot.on("death") below only ever broadcast a "goal
// abandoned" message, which carries no signal that she DIED (as opposed to giving up on a goal
// for any other reason) and no position, so nothing could react any differently. Fired from
// bot.on("death") itself (every death, including a rapid-succession one that skips gear
// recovery) using the death POSITION (bot.entity.position at the moment of death, before
// respawn), same shape as broadcastThreatAlert's payload plus a best-guess killer name from
// lastKnownThreat -- "unknown" when nothing hostile was actually seen recently (e.g. fall damage,
// drowning), which is honest rather than fabricating a cause.
export async function broadcastDeathAlert(position, killerName) {
  try {
    await buzzPublish(AGENT_ID, "minecraft-coordination", JSON.stringify({
      type: "death", killer: killerName,
      x: position.x, y: position.y, z: position.z,
    }));
  } catch (err) {
    console.error(`[${USERNAME}] death alert broadcast failed:`, err.message);
  }
}

// Shared by the "threat" and "death" listener branches below -- both only care about "is this
// close enough to actually help with," the exact same SQUAD_ASSIST_RANGE bound.
export function withinSquadAssistRange(payload) {
  const dx = bot.entity.position.x - payload.x;
  const dy = bot.entity.position.y - payload.y;
  const dz = bot.entity.position.z - payload.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= SQUAD_ASSIST_RANGE;
}

// Direct request, 2026-09-11: "if one bot is looking for a specific resource, it should (1) look
// near itself, current understanding of nearby resources added to global world memory; (2) ask
// the other bots to look near themselves, they add/update their knowledge into global world
// memory; (3) each bot uses the global world memory to gather a resource it needs, if it's not
// in their immediate vicinity." This function covers (1) and the "add/update" half of (2) -- a
// pure read (bot.findBlocks never moves her), so it's safe to run fire-and-forget, without
// acquiring the arbiter, from either her own "mine" failure (see goalTick below) or another
// bot's "scout" broadcast (see the minecraft-coordination listener below): never interrupts
// whatever she's actually doing. Scans actions.js's own EXPLORE_TARGET_NAMES (the same curated
// "common raw materials" list "explore" already searches) so a scout note and an ordinary
// explore success note stay in exactly one vocabulary -- one bot's "mine" query can match
// another bot's incidental discovery either way, not two independently-drifting lists. Position
// format ("near (x, y, z)") matches explore's own success note exactly -- see actions.js's own
// findRememberedLocation() for the parser that reads it back out. writeMemoryNote's own
// near-duplicate check (longterm.js) keeps repeated scans of an already-noted spot cheap and
// harmless rather than piling up redundant notes.
// Real gap found live 2026-09-13 (direct request: "extend resource sharing memory and scouting
// to *any* resource or crafted object"). Two real bugs closed here, not one: (1) the resource
// list was a hand-picked 4 items -- now actions.js's own getResourceBlockNames() (every real
// ore/log/ancient_debris this server's registry has) plus a fixed CRAFTED_OBJECT_NAMES set, so a
// crafting table or chest sighted incidentally is exactly as noteworthy as an iron vein. (2) the
// scout-receiver call site below used to pass NOTHING of what was actually being asked about --
// `${msg.from_agent}'s scout request for ${payload.resource}` only ever named it in the LOG
// line, the real scan always ran the same fixed list regardless of the question. extraTargets
// lets a specific request get checked even if it falls outside both standing sets. One single
// findBlocks() call (a matcher set, not one call per name) keeps this cheap regardless of how
// large the combined target list gets.
export const CRAFTED_OBJECT_NAMES = ["crafting_table", "furnace", "chest", "trapped_chest", "beehive", "bee_nest"];

// Direct request, 2026-09-19 ("expand their search capabilities... especially the miner and
// explorer roles"): Explorer's own stated priorities (roles.js) name "locate a village" and
// "locate a notable feature" explicitly, but nothing anywhere ever actually searched for one --
// only ore/log/crafted-object names were ever scanned. bell and composter are real, low-
// false-positive village indicator blocks (villager job-site/meeting blocks, not found outside a
// village in vanilla generation) -- noting one is a genuine "found a village here" fact, not a
// guess. Deliberately note-only, never a collect target (see noteNearbyResources -- a pure
// findBlocks + write, no movement or mining): breaking a villager's job-site block would be
// griefing a real structure, not resource-gathering.
const VILLAGE_INDICATOR_NAMES = ["bell", "composter"];
// 2026-11-04: lava too -- it's where trash goes (checkTrash), so a sighting is worth sharing.
const DISPOSAL_NAMES = ["lava"];

export async function noteNearbyResources(reason, extraTargets = []) {
  const targets = new Set([...getResourceBlockNames(bot), ...CRAFTED_OBJECT_NAMES,
    ...VILLAGE_INDICATOR_NAMES, ...DISPOSAL_NAMES, ...extraTargets]);
  const positions = bot.findBlocks({ matching: (block) => targets.has(block.name), maxDistance: 24, count: 64 });
  const noted = new Set(); // one note per distinct name per sweep is enough -- matches prior behavior
  for (const pos of positions) {
    const block = bot.blockAt(pos);
    if (!block || noted.has(block.name)) continue;
    noted.add(block.name);
    try {
      await writeMemoryNote({ scope: "world", persona: PERSONA_NAME,
        text: `Found ${block.name} near (${pos.x}, ${pos.y}, ${pos.z}), as of ${new Date().toISOString()}.` });
    } catch (err) {
      console.error(`[${USERNAME}] nearby-resource memory write failed (${block.name}, ${reason}):`, err.message);
    }
  }
}
