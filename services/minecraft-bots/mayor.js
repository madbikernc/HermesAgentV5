// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: the Mayor's tech-tree curriculum, directives for the other bots, and the fallback coordinator.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { callRole } from "./router.js";
import { getAchievements } from "./actions.js";
import { BOT_ROLES, ROLES } from "./roles.js";
import { narrateAction } from "./chat.js";
import { otherBotGoals } from "./fleet-coordination.js";
import { routineBlocked } from "./goal-proposal.js";
import { AUTONOMY_ENABLED, BOT_USERNAMES, MAYOR_USERNAME, USERNAME, bot, busy, mayorUnreachable, persona, setBusy } from "./index.js";


// Mayor-only autonomous behavior, 2026-09-08 ("add another bot, Mayor, whose personality is to
// be a leader and set goals for the others"). A no-op check (USERNAME !== MAYOR_USERNAME) makes
// this genuinely inert for every other bot's own process -- same file, same timer registration,
// no separate build for "the other four" vs "Mayor." A cheap `muse` call in Mayor's own voice
// turns the assigned objective into a real, addressed in-game chat line, which then flows
// through the EXACT SAME classifyIntent -> ACTION GOAL path a player's own instruction already
// takes (isMayor()'s own exception to isAnotherBot(), and the priority check in handleIncoming's
// own ACTION GOAL branch, both above) -- no separate "assign a goal to another bot" mechanism to
// build or keep in sync with the real one.
export const MAYOR_DIRECTIVE_MS = parseInt(process.env.MC_MAYOR_DIRECTIVE_MS || "300000", 10); // 5 min

// Direct request, 2026-09-08: "give the mayor a default set of goals to try to accomplish,
// starting with basic tools for everyone, then basic armor, then farming. he should set
// increasingly useful larger goals as they successfully meet earlier goals. progress through
// the tech tree." Replaces the previous fully-freeform "invent whatever task" directive with a
// fixed, ordered curriculum -- muse still phrases each directive in Mayor's own voice, but the
// underlying real objective for the CURRENT stage is always this list's, never invented, until
// the whole fleet clears it and moves on. doneItems is deliberately a small SET of real
// (never-invented) item ids per stage, not one exact item -- multiple tool/armor materials count
// (a bot who skips straight to iron tools has still cleared "basic tools"), and matches
// parseGoalStep's own DONE <item_id> verification (index.js 2.43.0) exactly: real, checked
// completion, not a self-reported claim. Farming's stage is proven by a harvested crop ITEM
// (wheat/carrot/potato/beetroot/bread), not "a farm exists somewhere" -- a real, unambiguous,
// checkable fact instead of something that would need its own separate detection method.
//
// Review MB-20, 2026-09-24: doneItems was matched with .some(), so ONE listed item cleared a
// stage -- a lone axe satisfied "a pickaxe and an axe", a lone iron sword "full iron armor and a
// sword". Each stage is now `requires`: groups that must ALL be satisfied, each by ANY one of its
// items. Groups are tier-aware (better materials count toward a lower stage).
const withTiers = (materials, piece) => materials.map((m) => `${m}_${piece}`);
export const TOOL_TIERS = ["wooden", "stone", "iron", "golden", "diamond", "netherite"];
const ARMOR_TIERS = ["leather", "chainmail", "iron", "golden", "diamond", "netherite"];
const IRON_UP = ["iron", "diamond", "netherite"];
const ARMOR_PIECES = ["helmet", "chestplate", "leggings", "boots"];
const TECH_TREE_STAGES = [
  {
    name: "basic tools",
    directive: "make sure you have basic tools -- at least a pickaxe and an axe, wood or stone is fine to start",
    requires: [withTiers(TOOL_TIERS, "pickaxe"), withTiers(TOOL_TIERS, "axe")],
  },
  {
    name: "basic armor",
    directive: "get yourself a full set of armor -- helmet, chestplate, leggings and boots; leather is fine to start, iron is better",
    requires: ARMOR_PIECES.map((piece) => withTiers(ARMOR_TIERS, piece)),
  },
  {
    name: "farming",
    directive: "start a farm and bring back some real food from it -- till ground, plant seeds, and harvest what you grow",
    // 2026-09-25: a crop the bot HARVESTED (verified achievement), not one it holds -- six bots
    // "cleared" farming by looting bread and carrots from a chest.
    requires: [["harvested:wheat", "harvested:carrots", "harvested:potatoes", "harvested:beetroots"]],
  },
  {
    name: "iron gear",
    directive: "mine iron and smelt enough for a full set of iron armor and an iron sword",
    requires: [...ARMOR_PIECES.map((piece) => withTiers(IRON_UP, piece)), withTiers(IRON_UP, "sword")],
  },
  {
    name: "diamond gear",
    directive: "find diamonds -- you'll need an iron pickaxe first -- and craft diamond tools or armor",
    requires: [["diamond_pickaxe", "diamond_sword", "diamond_axe", "diamond_chestplate", "diamond_helmet",
                "diamond_leggings", "diamond_boots"]],
  },
  {
    name: "enchanting",
    directive: "set up an enchanting table (needs obsidian and diamonds) and get some lapis lazuli for it",
    requires: [["enchanting_table"]],
  },
];

function stageSatisfied(stage, itemNames) {
  return stage.requires.every((group) => group.some((name) => itemNames.has(name)));
}

export function heldCurriculumItems() {
  const names = new Set(bot.inventory.items().map((i) => i.name));
  for (const slot of [5, 6, 7, 8, 45]) if (bot.inventory.slots[slot]) names.add(bot.inventory.slots[slot].name);
  for (const achievement of getAchievements(bot)) names.add(achievement);
  return [...names].filter(isCurriculumItem);
}

function isCurriculumItem(name) {
  return TECH_TREE_STAGES.some((stage) => stage.requires.some((group) => group.includes(name)));
}

// Persisted so Mayor's own process restarting doesn't reset the whole fleet back to "basic
// tools" -- same small-JSON-file-under-the-durable-mount pattern actions.js's PEN_FILE already
// uses. Only curriculumStageIndex is persisted,
// not per-bot within-stage progress -- a Mayor restart mid-stage just re-observes completions as
// they're (re-)broadcast or re-checked, an acceptable, low-cost simplification given stages take
// a while regardless.
const MEMORY_ROOT = (process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory"); // MC_MEMORY_ROOT: test isolation
const CURRICULUM_FILE = `${MEMORY_ROOT}/mayor-curriculum.json`;
let curriculumStageIndex = 0;
// Bot names (plain, e.g. "Mark") who've provably cleared the CURRENT stage -- reset on advance.
let stageProgress = new Set();
// Review MB-20: per-bot curriculum evidence (agent name -> Set of verified curriculum item ids),
// accumulated across "done" broadcasts because each broadcast proves only ONE item while stages
// now need several. Persisted with the stage index so a Mayor restart doesn't reset progress.
let stageEvidence = new Map();

export async function loadCurriculumStage() {
  try {
    const data = JSON.parse(await readFile(CURRICULUM_FILE, "utf8"));
    if (Number.isInteger(data.stageIndex)) curriculumStageIndex = data.stageIndex;
    if (Array.isArray(data.stageProgress)) stageProgress = new Set(data.stageProgress);
    if (data.evidence && typeof data.evidence === "object") {
      stageEvidence = new Map(Object.entries(data.evidence).map(([name, items]) => [name, new Set(items)]));
    }
    // 2026-09-25: re-judge the current stage by its current requirement, so a stage cleared under an
    // older, looser rule (farming by holding looted food) has to be earned again.
    const stage = TECH_TREE_STAGES[curriculumStageIndex];
    if (stage) stageProgress = new Set([...stageProgress].filter((name) => stageSatisfied(stage, stageEvidence.get(name) ?? new Set())));
  } catch {
    // no saved progress yet -- start at stage 0, the normal first-ever-run case
  }
}

async function saveCurriculumStage() {
  try {
    await mkdir(MEMORY_ROOT, { recursive: true });
    await writeFile(CURRICULUM_FILE, JSON.stringify({
      stageIndex: curriculumStageIndex,
      stageProgress: [...stageProgress],
      evidence: Object.fromEntries([...stageEvidence].map(([name, items]) => [name, [...items]])),
    }), "utf8");
  } catch (err) {
    console.error(`[${USERNAME}] failed to persist curriculum stage:`, err.message);
  }
}

// Mayor's own progress on an item-based stage is checked directly against his own real
// inventory/equipped gear -- no broadcast round-trip needed, he can just look. Other bots'
// progress arrives via their own verified "done" broadcasts (see the minecraft-coordination
// subscriber below) since Mayor has no direct view into their inventories.
function mayorHasStageItem(stage) {
  const names = new Set(bot.inventory.items().map((i) => i.name));
  for (const slot of [5, 6, 7, 8, 45]) if (bot.inventory.slots[slot]) names.add(bot.inventory.slots[slot].name);
  for (const achievement of getAchievements(bot)) names.add(achievement);
  return stageSatisfied(stage, names);
}

// Stage participants: everyone the stage's completion waits on (Soldiers are exempt).
function isCurriculumParticipant(name) {
  return BOT_ROLES[name.toLowerCase()]?.primary !== ROLES.SOLDIER;
}

// Records one bot's verified "done" item; returns true if it newly clears the current stage.
function recordCurriculumEvidence(agentName, item) {
  if (!isCurriculumItem(item)) return false;
  const items = stageEvidence.get(agentName) ?? new Set();
  items.add(item);
  stageEvidence.set(agentName, items);
  const stage = TECH_TREE_STAGES[curriculumStageIndex];
  if (!stage || stageProgress.has(agentName) || !stageSatisfied(stage, items)) {
    saveCurriculumStage();
    return false;
  }
  stageProgress.add(agentName);
  saveCurriculumStage();
  return true;
}

// Checked after every relevant "done" broadcast AND once per directive tick -- advancing
// promptly rather than waiting up to a full MAYOR_DIRECTIVE_MS after the fleet's last bot
// actually finishes the current stage.
// Mayor: credit one bot's curriculum items -- a finished goal's item and holdings, or an "evidence"
// message carrying a new verified achievement.
export function creditCurriculumEvidence(fromAgent, items) {
  if (curriculumStageIndex >= TECH_TREE_STAGES.length) return;
  const stage = TECH_TREE_STAGES[curriculumStageIndex];
  const agentName = [...BOT_USERNAMES].find((name) => `mc-${name.toLowerCase()}` === fromAgent);
  if (!agentName) return;
  // MB-20: one item is evidence toward a stage, not the whole stage.
  const evidence = [...new Set(items.filter(Boolean))];
  if (!evidence.map((it) => recordCurriculumEvidence(agentName, it)).some(Boolean)) return;
  console.log(`[${USERNAME}] curriculum: ${agentName} cleared "${stage.name}"`);
  checkCurriculumAdvance().catch((err) => console.error(`[${USERNAME}] checkCurriculumAdvance error:`, err.message));
}

async function checkCurriculumAdvance() {
  if (curriculumStageIndex >= TECH_TREE_STAGES.length) return; // graduated the whole ladder
  const stage = TECH_TREE_STAGES[curriculumStageIndex];
  if (mayorHasStageItem(stage)) stageProgress.add(MAYOR_USERNAME);
  // Direct request, 2026-09-13: Soldiers are never assigned a curriculum-stage directive
  // (proposeDirectiveForOthers' own targetIsSoldier branch) or expected to self-propose one
  // (nextSoldierPriority's own §21 scope never touches TECH_TREE_STAGES either) -- requiring
  // them to independently produce a farming/enchanting-table/etc. item just to unblock the
  // WHOLE FLEET's advancement would either stall the curriculum forever or reward wandering
  // outside their restricted lane. The curriculum is a non-Soldier fleet ladder now.
  const everyone = [...BOT_USERNAMES].filter(isCurriculumParticipant);
  if (!everyone.every((name) => stageProgress.has(name))) return;

  curriculumStageIndex += 1;
  // Evidence already gathered may clear the NEXT stage too (e.g. iron armor from "basic armor").
  const nextStage = TECH_TREE_STAGES[curriculumStageIndex];
  stageProgress = new Set(nextStage
    ? [...stageEvidence].filter(([, items]) => stageSatisfied(nextStage, items)).map(([name]) => name)
    : []);
  await saveCurriculumStage();
  const next = TECH_TREE_STAGES[curriculumStageIndex];
  console.log(`[${USERNAME}] curriculum stage complete: "${stage.name}" -- advancing to ` +
    (next ? `"${next.name}"` : "the full ladder, improvising from here"));
  bot.chat(await narrateAction(next
    ? `everyone's cleared "${stage.name}" -- nice work. Next up: ${next.name}.`
    : `everyone's cleared the whole starting curriculum -- "${stage.name}" was the last of it. Good work, all of you.`));
}

// §15.5(b): role -> last-assignment-timestamp, an in-memory-only tiebreak (lost on restart, same
// as recentGoalOutcomes already is -- no new persistence for something this low-stakes) used by
// pickIdleTarget() below whenever more than one bot is idle at once. Updated by both
// proposeDirectiveForOthers() and proposeFallbackDirective() so the two don't defeat each other's
// own bookkeeping.
const lastRoleAssignedAt = new Map();

function pickIdleTarget(idleBots) {
  if (idleBots.length <= 1) return idleBots[0];
  return idleBots.slice().sort((a, b) => {
    const roleA = BOT_ROLES[a.toLowerCase()]?.primary?.name;
    const roleB = BOT_ROLES[b.toLowerCase()]?.primary?.name;
    const atA = roleA ? (lastRoleAssignedAt.get(roleA) ?? 0) : 0;
    const atB = roleB ? (lastRoleAssignedAt.get(roleB) ?? 0) : 0;
    return atA - atB; // whichever role was least recently assigned something, first
  })[0];
}

function markRoleAssigned(target) {
  const roleName = BOT_ROLES[target.toLowerCase()]?.primary?.name;
  if (roleName) lastRoleAssignedAt.set(roleName, Date.now());
}

// Direct request, 2026-09-13 ("Soldiers should not get tasks beyond equipping weapons and
// armor, and fighting off monsters"): shared by both leader-directive functions below
// (Mayor's own, and Mark's fallback stand-in) so a Soldier gets the exact same restricted task
// space no matter which of them is doing the assigning right now. Matches
// nextSoldierPriority()'s own self-propose scope (§21) so Mayor-assigned and self-proposed
// Soldier work never contradict each other -- a Soldier is never told to mine, build, farm, or
// explore by anyone.
const SOLDIER_DIRECTIVE_NOTE =
  "their whole job is staying armed and keeping the fleet safe, nothing else. Tell them to " +
  "make sure they're fully equipped (weapon and armor, upgrading if they can) and to stand " +
  "guard / deal with any monsters nearby. Don't give them a mining, building, farming, or " +
  "exploring task.";

export async function proposeDirectiveForOthers() {
  if (USERNAME !== MAYOR_USERNAME || !AUTONOMY_ENABLED || routineBlocked("proposeDirectiveForOthers")) return;
  await checkCurriculumAdvance();
  const idleBots = [...BOT_USERNAMES].filter((name) =>
    name !== MAYOR_USERNAME && !otherBotGoals.has(`mc-${name.toLowerCase()}`));
  if (!idleBots.length) return; // everyone already has something going -- nothing to assign
  // Prefer an idle bot who still needs the current stage over one who's already cleared it --
  // matching "increasingly useful larger goals as they successfully meet earlier goals" means
  // pushing the ones behind, not re-nagging someone already done. §15.5(b): the final fallback
  // (nobody's behind, or the whole curriculum's cleared) is now role-aware, not purely random.
  // Review MB-20: stage work goes to stage participants who haven't cleared it, with role
  // fairness among them -- an idle Soldier no longer grabs the slot ahead of later workers.
  const stageCandidates = curriculumStageIndex < TECH_TREE_STAGES.length
    ? idleBots.filter((name) => isCurriculumParticipant(name) && !stageProgress.has(name)) : [];
  const target = stageCandidates.length ? pickIdleTarget(stageCandidates) : pickIdleTarget(idleBots);
  const targetRole = BOT_ROLES[target.toLowerCase()];
  // A Soldier target never gets a curriculum-stage directive, regardless of where the rest of
  // the fleet's own progression stands -- see SOLDIER_DIRECTIVE_NOTE's own comment.
  const targetIsSoldier = targetRole?.primary === ROLES.SOLDIER;
  const stage = !targetIsSoldier && curriculumStageIndex < TECH_TREE_STAGES.length
    ? TECH_TREE_STAGES[curriculumStageIndex] : null;

  setBusy(true);
  try {
    const reply = await callRole("muse", [
      {
        role: "system",
        content: targetIsSoldier
          ? `${persona}\n\n---\n\n${target} currently has no active goal. ${target} is a ` +
            `Soldier -- ${SOLDIER_DIRECTIVE_NOTE} Address ${target} by name, exactly like a ` +
            `real chat message you'd actually send. One or two sentences, nothing else -- no ` +
            `quotes, no stage directions.`
          : stage
          ? `${persona}\n\n---\n\n${target} currently has no active goal. The fleet's current ` +
            `curriculum stage is "${stage.name}": ${stage.directive}. Tell ${target} to do ` +
            `exactly that, in your own voice -- don't invent a different objective. ` +
            (targetRole ? `Where it fits naturally, frame it around ${target}'s role as ` +
              `${targetRole.primary.name} (${targetRole.primary.domain}). ` : "") +
            `Address ` +
            `${target} by name, exactly like a real chat message you'd actually send. One or ` +
            `two sentences, nothing else -- no quotes, no stage directions.`
          // §15.5(b): role folded into the post-curriculum branch, replacing the previous fully
          // role-blind "invent a task" prompt -- Mayor now knows what ${target} actually does.
          : `${persona}\n\n---\n\n${target} currently has no active goal, and the fleet has ` +
            `already cleared the whole starting curriculum (basic tools, armor, farming, iron, ` +
            `diamonds, enchanting). ` +
            (targetRole
              ? `${target}'s role is ${targetRole.primary.name} (${targetRole.primary.domain}) ` +
                `-- assign something in their wheelhouse. `
              : "") +
            `Give ${target} ONE short, specific, in-character task that pushes further -- a ` +
            `real, more advanced Minecraft objective, not vague encouragement. Address ` +
            `${target} by name, exactly like a real chat message you'd actually send. One or ` +
            `two sentences, nothing else -- no quotes, no stage directions.`,
      },
      { role: "user", content: `What do you tell ${target}?` },
    ], { maxTokens: 60, temperature: 0.9, analysis: true });   // bot-to-bot message, no player input
    if (reply) {
      bot.chat(reply);
      markRoleAssigned(target);
      console.log(`[${USERNAME}] issued directive to ${target} ` +
        `(${targetIsSoldier ? "soldier gear/guard" : stage?.name ?? "post-curriculum"}): ${reply}`);
    }
  } catch (err) {
    console.error(`[${USERNAME}] failed to issue a directive:`, err.message);
  } finally {
    setBusy(false);
  }
}

// §15.5(d): fallback coordination only, never a standing second voice -- originally gated on
// Mark's Leader secondary, now on its own FALLBACK_COORDINATOR flag (see that constant's own
// 2026-09-13 comment below for why). Deliberately a SEPARATE function from
// proposeDirectiveForOthers() above (Mayor's own, untouched
// by this whole change) rather than a branch threaded through it -- Mayor's path is well-exercised
// and this keeps zero risk of changing his behavior. Never touches curriculumStageIndex/
// stageProgress/mayor-curriculum.json at all (Mayor-only state) -- a fallback directive is always
// freeform-style, never curriculum-stage-aware, a smaller and safer scope than §15.5(d)'s
// original full proposal.
export const MAYOR_LIVENESS_TIMEOUT_MS = MAYOR_DIRECTIVE_MS * 3;

// Direct request, 2026-09-13 ("rebalance the bots so they each have exactly one role"). Real
// regression this would otherwise have silently caused: this gate used to be
// `myRole?.secondary === ROLES.LEADER`, and Mark was the only bot ever given Leader as a
// secondary -- flattening every BOT_ROLES entry to a single role (§22) would have set his
// secondary to null along with everyone else's, permanently disabling this whole mechanism with
// no error, no log line, nothing to notice. This is a real, live, working feature (unlike
// §15.5(d)'s own doc comment above, which still calls it a smaller/safer scope of an
// "originally proposed" plan -- it shipped) -- decoupling it into its own explicit flag, same
// env-var-plus-role-derivation shape as SQUAD_RESPONDER, keeps it alive and independent of
// whatever the one-role-per-bot rule does to roles.js from here on.
const FALLBACK_COORDINATOR = process.env.MC_FALLBACK_COORDINATOR === "true";

export async function proposeFallbackDirective() {
  if (USERNAME === MAYOR_USERNAME || !FALLBACK_COORDINATOR) return;
  if (!AUTONOMY_ENABLED || routineBlocked("proposeFallbackDirective")) return;
  // lastMayorSeenAt === 0 means "never heard from Mayor this process," deliberately distinct
  // from "he went quiet a while ago" -- a fresh process with no baseline yet doesn't activate the
  // fallback immediately (avoids every bot racing to coordinate on a simultaneous fresh boot
  // before anyone's actually heard Mayor at all).
  if (!mayorUnreachable()) return;

  const idleBots = [...BOT_USERNAMES].filter((name) =>
    name !== USERNAME && name !== MAYOR_USERNAME && !otherBotGoals.has(`mc-${name.toLowerCase()}`));
  if (!idleBots.length) return;
  const target = pickIdleTarget(idleBots);
  const targetRole = BOT_ROLES[target.toLowerCase()];
  // Same restriction as Mayor's own proposeDirectiveForOthers -- see SOLDIER_DIRECTIVE_NOTE's
  // comment. A Soldier gets the identical restricted task space regardless of which of the two
  // functions is doing the assigning.
  const targetIsSoldier = targetRole?.primary === ROLES.SOLDIER;

  setBusy(true);
  try {
    const reply = await callRole("muse", [
      {
        role: "system",
        // "you carry Leader as a secondary role" removed 2026-09-13 -- stale since §22's
        // rebalance retired every bot's secondary; FALLBACK_COORDINATOR is its own explicit
        // flag now, not a role membership, so this no longer claims one that doesn't exist.
        content: targetIsSoldier
          ? `${persona}\n\n---\n\nMayor's been unreachable for a while -- as the fleet's ` +
            `stand-in coordinator, step up and coordinate, plainly, without claiming to BE ` +
            `Mayor or making a big deal of it. ${target} currently has no active goal. ` +
            `${target} is a Soldier -- ${SOLDIER_DIRECTIVE_NOTE} Address ${target} by name, ` +
            `exactly like a real chat message you'd actually send. One or two sentences, ` +
            `nothing else -- no quotes, no stage directions.`
          : `${persona}\n\n---\n\nMayor's been unreachable for a while -- as the fleet's ` +
            `stand-in coordinator, step up and coordinate, plainly, without claiming to BE ` +
            `Mayor or making a big deal of it. ${target} currently has no active goal` +
            (targetRole ? `, and their role is ${targetRole.primary.name} ` +
              `(${targetRole.primary.domain})` : "") +
            `. Give ${target} ONE short, specific, in-character task fitting their role -- a ` +
            `real Minecraft objective, not vague encouragement. Address ${target} by name, ` +
            `exactly like a real chat message you'd actually send. One or two sentences, ` +
            `nothing else -- no quotes, no stage directions.`,
      },
      { role: "user", content: `What do you tell ${target}?` },
    ], { maxTokens: 60, temperature: 0.9, analysis: true });   // bot-to-bot message, no player input
    if (reply) {
      bot.chat(reply);
      markRoleAssigned(target);
      console.log(`[${USERNAME}] issued fallback directive to ${target} (Mayor unreachable): ${reply}`);
    }
  } catch (err) {
    console.error(`[${USERNAME}] failed to issue a fallback directive:`, err.message);
  } finally {
    setBusy(false);
  }
}
