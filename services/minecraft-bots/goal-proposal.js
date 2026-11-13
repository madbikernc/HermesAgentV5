// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: self-proposed goals and routine-skip reporting.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { callRole } from "./router.js";
import { searchMemory } from "./longterm.js";
import { claimBuilderItem, myBuilderClaim } from "./actions.js";
import * as arbiter from "./arbiter.js";
import { describeGear } from "./equipment.js";
import { newGoal, saveGoal } from "./goals.js";
import { ROLES } from "./roles.js";
import { narrateAction } from "./chat.js";
import { arbitrateGoalConflict } from "./planning.js";
import { builderPriorityCandidates, nextBuilderPriority, nextSoldierPriority, nextSurvivalPriority } from "./priorities.js";
import { broadcastGoalState, otherGoalsNote, recentGoalOutcomes, recordGoalOutcome, roleBiasNote } from "./fleet-coordination.js";
import { nextRoleWork } from "./gear-goals.js";
import { holdsItem } from "./goal-runners.js";
import { PERSONA_NAME, USERNAME, bot, busy, currentGoal, myRole, persona, setCurrentGoal } from "./index.js";

const SELF_PROPOSE_BACKOFF_MS = 10 * 60_000;
let selfProposalRejections = 0;
export let selfProposeResumeAt = 0;
// Priorities: in priorities.js (split out 2026-11-10).
export async function proposeOwnGoal() {
  // PRIORITIES_PROPOSAL.md Tier 1: checked FIRST, for every bot regardless of role -- a weapon,
  // her own sheltered bed, not starving, and basic armor outrank every role-specific ladder below
  // (Builder's checklist, Soldier's monster/guard list) the same way those already outrank plain
  // freeform self-propose. Like Builder's own ladder, this only wins the NEXT idle choice -- it
  // doesn't preempt a role goal already mid-flight.
  let survival = nextSurvivalPriority();
  // 2026-11-05: the residence item is fleet-wide (a bed for every active bot), and ahead of role work
  // it kept the Farmer and the Herder building shelters while nobody grew or bred food. Theirs is
  // food; the others build the residences.
  const roleWork = await nextRoleWork();
  if (survival?.name === "shelter" && roleWork) survival = null;
  if (survival) {
    setCurrentGoal(newGoal({ description: survival.directive, source: "self" }));
    currentGoal.survivalPriorityItem = survival.name;
    await saveGoal(PERSONA_NAME, currentGoal);
    await broadcastGoalState("active", survival.directive);
    console.log(`[${USERNAME}] Survival priority goal (${survival.name}): ${survival.directive}`);
    bot.chat(await narrateAction(`taking care of the basics first: ${survival.directive}`));
    return;
  }

  // §15.6, de-exclusived 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 -- "ownable by whichever bot
  // is idle and able, not pinned to whoever's primary role happens to be Builder"). The
  // infrastructure checklist runs AHEAD of freeform self-propose reasoning for EVERY bot now, not
  // just a Builder-primary one -- it's shared infrastructure other bots' own progress benefits
  // from having early, not personal gear that would compete with it (§15.5's general "role bias
  // only kicks in post-curriculum" rule is deliberately NOT applied here). Deterministic: no LLM
  // call decides WHAT to build, only narrateAction() below phrases the announcement in her own
  // voice -- matching how proposeDirectiveForOthers' own curriculum branch phrases a fixed
  // directive. claimBuilderItem() keeps two idle bots from converging on the same gap:
  // nextBuilderPriority()'s own stall-aware pick goes first, then every other unmet item in
  // claim order, so a bot only sits this out entirely once EVERY gap is already claimed by
  // someone else -- a single Builder being busy, dead, or stuck no longer stalls the fleet.
  if (roleWork) {
    setCurrentGoal(newGoal({ description: roleWork.directive, source: "self" }));
    currentGoal.farmTask = roleWork.task;
    currentGoal.roleWork = true;
    await saveGoal(PERSONA_NAME, currentGoal);
    await broadcastGoalState("active", roleWork.directive);
    console.log(`[${USERNAME}] ${myRole.primary.name} role goal (${roleWork.task}): ${roleWork.directive}`);
    bot.chat(await narrateAction(`back to my own work: ${roleWork.directive}`));
    return;
  }

  const builderCandidates = builderPriorityCandidates();
  const preferredBuilderItem = nextBuilderPriority(builderCandidates);
  if (preferredBuilderItem) {
    const ordered = [preferredBuilderItem,
      ...builderCandidates.filter((c) => c.name !== preferredBuilderItem.name)];
    for (const candidate of ordered) {
      const alreadyMine = await myBuilderClaim(bot);
      if (alreadyMine !== candidate.name && !(await claimBuilderItem(bot, candidate.name))) continue;
      setCurrentGoal(newGoal({ description: candidate.directive, source: "self" }));
      // Real bug found live 2026-09-13 ("hallucinate their achievements"): tagged so the DONE
      // handler below can re-verify against REAL world state (builderPriorityItemSatisfied())
      // instead of trusting inventory possession alone -- see that check's own comment for the
      // confirmed live evidence (a beehive announced "complete" twice while never actually
      // placed near home).
      currentGoal.builderPriorityItem = candidate.name;
      await saveGoal(PERSONA_NAME, currentGoal);
      await broadcastGoalState("active", candidate.directive);
      console.log(`[${USERNAME}] Tier 2 infrastructure goal (${candidate.name}): ${candidate.directive}`);
      bot.chat(await narrateAction(`getting the basics set up: ${candidate.directive}.`));
      return;
    }
    // Every unmet item is already claimed by someone else -- fall through to her own role's
    // work below instead of idling on a checklist she can't currently help with.
  }

  // Direct request, 2026-09-13: a Soldier-primary bot's own weapon/monster checklist runs AHEAD
  // of freeform self-propose the same way Builder's does just above -- unlike Builder's, this
  // isn't shared infrastructure, but "she has no way to fight" and "a hostile is loose nearby"
  // are exactly the kind of universal-safety concern roleBiasNote() itself already says comes
  // first regardless of role; making it a real override here (not just advisory prompt text)
  // closes the gap the operator called out directly: roles.js's own `priorities` array for
  // Soldier was never anything more than a suggestion the model was free to ignore.
  if (myRole?.primary === ROLES.SOLDIER) {
    const priority = await nextSoldierPriority();
    if (priority) {
      setCurrentGoal(newGoal({ description: priority.directive, source: "self" }));
      // Efficiency pass, 2026-09-24 (measured: 811 guard goals/day for Mark+Luke, almost all
      // "completed" by an immediate planner DONE, then re-proposed ~3 min later). Guard duty is
      // now a STANDING goal: goalTick holds it without planner calls (see guardTick) until the
      // Soldier's priority changes, and the goal heartbeat keeps Mayor from re-assigning it.
      // "escort" (2026-10-11, PRIORITIES_PROPOSAL.md §2a) gets the exact same treatment -- just
      // as vague and ongoing as "guard" is, so it would hit the identical churn if it went
      // through the normal planner instead.
      if (priority.name === "guard" || priority.name === "escort") currentGoal.standing = priority.name;
      await saveGoal(PERSONA_NAME, currentGoal);
      await broadcastGoalState("active", priority.directive);
      console.log(`[${USERNAME}] Soldier priority goal (${priority.name}): ${priority.directive}`);
      bot.chat(await narrateAction(`${priority.name === "guard" ? "standing guard duty" : priority.name}: ${priority.directive}`));
      return;
    }
  }

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

  // Cross-bot goal coordination (direct follow-up, 2026-09-07: "look for more ways to improve
  // their autonomy"). Real collision observed live: both bots picked "get copper armor" at the
  // same time and both burned attempts on the same occupied furnaces -- duplicated effort neither
  // needed. otherBotGoals is kept current by the "minecraft-coordination" Buzz subscription below.
  const otherGoalNote = otherGoalsNote(
    "Other bots currently working on something (avoid picking something that duplicates or " +
    "competes with one of these for the same scarce resource unless you have a good reason to):");

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
          `carrying (a furnace or crafting table) for your own use, and you CAN build a small ` +
          `fixed shelter (walls, a doorway, a roof -- not a custom house/base design, just that ` +
          `one shape) -- this is a real, working capability, don't claim otherwise. That said, ` +
          `shelter/infrastructure goals are usually handled separately, so you don't need to ` +
          `invent one yourself -- prefer gearing up, gathering a resource, or crafting/smelting ` +
          `a portable item unless something building-shaped is genuinely the obvious next thing. ` +
          `Phrase the goal around the OUTCOME you want (e.g. "get some copper armor," ` +
          `"stock up on iron") rather than one specific method, since more than one way to get ` +
          `there might work -- naming smelting/crafting/the small fixed shelter as part of it is ` +
          `all fine now. Respond in EXACTLY this form: a short phrase naming the goal in your own ` +
          `words, then " | TARGET: " and the exact item id that proves it's done (e.g. ` +
          `"stock up on iron | TARGET: iron_ingot"), or "| TARGET: NONE" if no single item ` +
          `proves it. Never pick a goal whose target you already have.\n\n${gearNote}${memoryNote}` +
          `${recentOutcomesNote}${otherGoalNote}${roleBiasNote()}`,
      },
      { role: "user", content: "What's your goal?" },
    ],
    { maxTokens: 30, temperature: 0.9, analysis: true },   // self-prompt, no player input
  );
  // Efficiency pass, 2026-09-24 (measured: ~83% of planner calls fleet-wide produced no action,
  // mostly an instant DONE on a self-proposed goal the bot had already satisfied). The proposal
  // names its target item; a target already in hand is rejected here -- no goal, no planner call,
  // no narration -- and recorded so the next proposal picks something else. Three rejections in a
  // row back self-proposal off for SELF_PROPOSE_BACKOFF_MS.
  const [rawDescription, rawTarget = ""] = text.split(/\|\s*TARGET:/i);
  let description = rawDescription.trim().replace(/^["']|["']$/g, "").slice(0, 120);
  if (!description) return;
  const targetId = rawTarget.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const targetItem = targetId && targetId !== "none" && bot.registry.itemsByName[targetId] ? targetId : null;
  if (targetItem && holdsItem(targetItem)) {
    selfProposalRejections += 1;
    recordGoalOutcome(description, "skipped", `already have ${targetItem}`);
    console.log(`[${USERNAME}] self-proposal rejected (already have ${targetItem}): ${description}`);
    if (selfProposalRejections >= 3) {
      selfProposalRejections = 0;
      selfProposeResumeAt = Date.now() + SELF_PROPOSE_BACKOFF_MS;
    }
    return;
  }
  selfProposalRejections = 0;
  description = await arbitrateGoalConflict(description);

  setCurrentGoal(newGoal({ description, source: "self" }));
  if (targetItem) currentGoal.targetItem = targetItem;
  await saveGoal(PERSONA_NAME, currentGoal);
  await broadcastGoalState("active", description);
  console.log(`[${USERNAME}] self-proposed goal: ${description}`);
  bot.chat(await narrateAction(`new goal, on my own: ${description}.`));
}

// Runs on its own timer, entirely separate from handleIncoming's chat-driven busy window --
// only steps when nothing else has the bot's attention (busy/acting), so a live player command
// always wins immediately and this simply resumes on its own next tick once that command's
// action finishes. Reuses `busy`/`acting` themselves (rather than a third flag) so there is
// exactly one place goal-loop-vs-live-command precedence is decided, not two that could drift
// out of sync.
// Fairness instrumentation (review redundancy note, 2026-09-24): every periodic check that loses
// its turn because the bot is busy (a model call in flight, or someone holding the arbiter) is
// counted here, and the counts are logged every ROUTINE_SKIP_REPORT_MS as one ROUTINE_SKIPS line
// that tests/baseline.mjs sums -- so "does work starve behind other work" is measured, not guessed.
export const ROUTINE_SKIP_REPORT_MS = 10 * 60_000;
export const routineSkips = {};
export function routineBlocked(name) {
  const blocked = busy || arbiter.isBusy();
  if (blocked) routineSkips[name] = (routineSkips[name] ?? 0) + 1;
  return blocked;
}
