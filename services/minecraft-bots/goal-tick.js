// Version: 1.1.0
//
// 1.1.0 (2026-11-13) -- the planner's three "giving up on goal" lines use goal-runners.js 1.1.0's format,
// `after N failures (kind=...)`, so self-repair tells one kind of abandoned goal from another.
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: goalTick() and its follow-up scheduling.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { writeMemoryNote } from "./longterm.js";
import { publish as buzzPublish } from "./buzz.js";
import { performAction } from "./actions.js";
import * as arbiter from "./arbiter.js";
import { logStep } from "./goals.js";
import { authorSkillFromGoal, findSkill, recordSkillOutcome, runSkill } from "./skills.js";
import { narrateAction } from "./chat.js";
import { parseGoalStep, planNextStep } from "./planning.js";
import { builderPriorityItemSatisfied, survivalPriorityItemSatisfied } from "./priorities.js";
import { CRAFTED_OBJECT_NAMES, broadcastGoalState, noteNearbyResources, recordGoalOutcome } from "./fleet-coordination.js";
import { runBedGoal, runFoodGoal, runShelterUpgradeGoal, runToolGoal, runUpgradeToolsGoal, runWeaponGoal } from "./gear-goals.js";
import { proposeOwnGoal, routineBlocked, selfProposeResumeAt } from "./goal-proposal.js";
import { BUILDER_CRAFTABLE, HOME_PLACEABLE, SKILL_RECHECK_MS, farmTaskFor, goalKind, guardTick, holdsItem, retireGoal, runBuilderPlacement, runFarmGoal, runRanchGoal, saveGoalIfCurrent } from "./goal-runners.js";
import { AGENT_ID, AUTONOMY_ENABLED, IDLE_BEFORE_SELF_GOAL_MS, MAX_CONSECUTIVE_FAILURES, PERSONA_NAME, SELF_PROPOSE_GOALS, USERNAME, bot, busy, currentGoal, lastActivityAt, setBusy } from "./index.js";
import { goalPausedForNight } from "./night-survival.js";
import { runCommunalShelterGoal, runShelterGoal } from "./shelter-goals.js";
import { SURPLUS_CLEANUP_QUIET_MS, setSurplusCleanupDueAt, surplusCleanupDueAt } from "./upkeep-inventory.js";


async function goalTick() {
  if (!AUTONOMY_ENABLED || routineBlocked("goalTick")) return;
  // Review MB-14: no new work or goal steps from dusk to dawn (the goal is paused, not dropped).
  if (goalPausedForNight(currentGoal)) return;

  if (!currentGoal) {
    if (!SELF_PROPOSE_GOALS || Date.now() - lastActivityAt < IDLE_BEFORE_SELF_GOAL_MS) return;
    if (Date.now() < selfProposeResumeAt) return; // backing off after repeated already-done proposals
    setBusy(true);
    try {
      await proposeOwnGoal();
    } catch (err) {
      console.error(`[${USERNAME}] failed to self-propose a goal:`, err.message);
    } finally {
      setBusy(false);
    }
    return;
  }

  // Coherence arbiter Phase 3 (2026-09-10): OWNERS.GOAL_STEP sits at the same tier as ROUTINE
  // (see arbiter.js's own OWNERS comment -- today's code never distinguished them either), so a
  // requestControl() failure here means another ROUTINE/GOAL_STEP-tier action is already running
  // this tick -- exactly the old `acting` check's own early-bail, just moved to the point where
  // an async acquisition can actually happen instead of a synchronous flag read.
  // Review MB-21, 2026-09-24: control used to be held from here through skill lookup, the
  // planning model call, memory writes and narration -- hunger and chores (same tier) starved
  // behind a slow model. It's now taken lazily, right before the first physical action; a tick
  // that can't get it just ends, and nothing below moves the body without it.
  let handle = null;
  const takeControl = async () => {
    if (handle) return arbiter.holdsControl(handle);
    handle = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP);
    return !!handle;
  };
  // Review MB-05, 2026-09-24: pin this tick to the goal it started with. STOP, dusk, respawn,
  // teleport, and setNewGoal() can all replace or clear the global currentGoal while this tick is
  // awaiting a model call or a physical action; every mutation below goes to `goal`, and
  // retireGoal()/saveGoalIfCurrent() only touch the global/persisted goal if it is still this one.
  const goal = currentGoal;
  const replaced = () => currentGoal !== goal;
  // Direct request, 2026-09-09 ("after any crafting activity, surplus materials should be
  // stored in a chest as close to their sleeping home as possible"). Declared at function scope
  // (not inside the try below) so the goalTick's own outer `finally` can fire the cleanup AFTER
  // control is released, rather than racing storeSurplusNearHome's own acquisition against this
  // function's -- see its own header for why an early `return` elsewhere in this function
  // (DONE/BLOCKED/etc.) never touches this flag and so never triggers it, correctly, since those
  // paths never actually ran a craft/smelt step.
  let craftedOk = false;
  try {
    if (goal.standing === "guard" || goal.standing === "escort") {
      await guardTick(goal, takeControl, () => handle);
      return;
    }
    // Review MB-08 follow-up (2026-09-24): a Builder checklist item she's already carrying is
    // placed deterministically -- walk home, place, verify near home -- with no planner call.
    // 2026-11-04: and one she can make (BUILDER_CRAFTABLE) is made first, by the same runner.
    if (goal.builderPriorityItem && HOME_PLACEABLE.has(goal.builderPriorityItem) &&
        (holdsItem(goal.builderPriorityItem) || BUILDER_CRAFTABLE.has(goal.builderPriorityItem))) {
      await runBuilderPlacement(goal, takeControl, () => handle, replaced);
      return;
    }
    // Efficiency pass, 2026-09-24: a goal whose target item is already in hand is done -- no
    // planner call needed to notice (see targetItemFor / proposeOwnGoal's TARGET).
    // 2026-09-25: farm and ranch goals run their actions directly (see runFarmGoal), ahead of the
    // "already holding the target" shortcut and the stored-skill lookup, both of which let a farming
    // goal "finish" without farming.
    // 2026-10-28: ahead of the text-matched farmTask routing -- "craft a stone pickaxe" would
    // otherwise match TOOL_WORDS and go to toolStep, which is satisfied by ANY pickaxe.
    if (goal.survivalPriorityItem === "tools") {
      await runUpgradeToolsGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    // 2026-11-04: by tag -- the residence directive's wording changes with its plan.
    if (goal.survivalPriorityItem === "shelter") {
      await runShelterGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    if (goal.survivalPriorityItem === "shelter_upgrade") {
      await runShelterUpgradeGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    // 2026-10-30: ahead of farmTask too -- the food directive's "harvest a ripe crop" matches
    // FARM_WORDS (see foodStep).
    if (goal.survivalPriorityItem === "food") {
      await runFoodGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    goal.farmTask ??= farmTaskFor(goal.description);
    if (goal.farmTask === "farm") {
      await runFarmGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    if (goal.farmTask === "ranch") {
      await runRanchGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    if (goal.farmTask === "bed") {
      await runBedGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    if (goal.farmTask === "shelter") {
      await runShelterGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    if (goal.farmTask === "communal_shelter") {
      await runCommunalShelterGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    if (goal.farmTask === "tool") {
      await runToolGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    // Direct request, 2026-10-12 (root-caused attack_win_rate regression -- see weaponStep's own
    // header). Tagged by proposeOwnGoal() itself (currentGoal.survivalPriorityItem), not text-
    // matched like farmTask: a Tier 1 survival goal's description is a fixed string this file
    // already controls, so there's no ambiguous wording to misroute the way a regex could.
    if (goal.survivalPriorityItem === "weapon") {
      await runWeaponGoal(goal, takeControl, () => handle, replaced);
      return;
    }
    if (goal.targetItem && holdsItem(goal.targetItem)) {
      console.log(`[${USERNAME}] goal complete (already have ${goal.targetItem}): ${goal.description}`);
      recordGoalOutcome(goal.description, "done", null);
      await broadcastGoalState("done", goal.description, goal.targetItem);
      await retireGoal(goal);
      return;
    }
    // Skill retrieval (MINECRAFT_BOTS_DESIGN.md §14, 2026-09-08): before spending a
    // planNextStep call, check for an existing, trusted skill whose description matches this
    // goal closely enough to just run directly -- skips per-tick planning entirely on a hit,
    // the actual efficiency payoff a dynamic skill library is for (real, already-observed
    // evidence it would help: multiple bots independently re-deriving the identical "need a
    // pickaxe -> need planks -> need logs" chain from scratch, per bot, per goal). A miss (no
    // close match, or every close match already untrusted) costs one cheap search call and
    // falls through to normal planning unchanged. Checked once per goal (servedBySkill), not
    // every tick, once a goal has already gone one way or the other.
    // MB-21: a miss is remembered for SKILL_RECHECK_MS instead of re-searching every tick.
    if (!goal.servedBySkill && Date.now() - (goal.skillMissAt ?? 0) >= SKILL_RECHECK_MS) {
      const skill = await findSkill(goal.description);
      if (!skill) goal.skillMissAt = Date.now();
      if (skill) {
        if (replaced() || !(await takeControl())) return;
        console.log(`[${USERNAME}] running stored skill "${skill.name}" for goal: ${goal.description}`);
        const result = await runSkill((b, a, s) => performAction(b, a, s, handle), bot, skill, goal.setBy || USERNAME);
        // Preempted mid-replay: neither the skill's nor the goal's fault -- don't score either,
        // and let a later tick retry the skill from the start.
        if (result.cancelled || replaced()) return;
        await recordSkillOutcome(skill.jsonPath, result.ok);
        goal.servedBySkill = true;
        logStep(goal, `skill(${skill.name}): ${result.text}`, result.ok);
        if (result.ok) {
          // Review MB-10, 2026-09-24: a replayed skill used to complete the goal on the spot,
          // skipping the DONE inventory and Builder world checks below. It now only records the
          // progress; the next tick's planner must still claim DONE through the same validation
          // every other completion goes through.
          console.log(`[${USERNAME}] stored skill finished for goal: ${goal.description}`);
          goal.consecutiveFailures = 0;
          await saveGoalIfCurrent(goal);
        } else {
          // Doesn't duplicate the give-up/consecutiveFailures check here -- one failed skill
          // attempt counts as one failed step, same as any other, and the very next tick's own
          // normal planning already re-checks that threshold on the same shared counter.
          goal.consecutiveFailures += 1;
          await saveGoalIfCurrent(goal);
        }
        return;
      }
    }

    // busy is held only for this planning call, not the physical action below -- see the
    // 2026-09-07 fix note above planNextStep's own call site history for why. Releasing it
    // immediately after the plan is known (instead of holding it until the whole step,
    // including a potentially minute-long physical action, finishes) is what actually delivers
    // this function's own documented promise above ("a live player command always wins
    // immediately"): handleIncoming only ever checks `busy`, not `acting`, so a real chat
    // message arriving mid-action was being unconditionally dropped as "busy" for as long as
    // the action ran -- live evidence: an entire day of real player chat logged as dropped.
    // `acting` alone still prevents this function (and every other idle-tick check) from
    // starting a second physical action while this one is in flight; a live command's own
    // performAction call safely interrupts it via the same stopCurrent() every action already
    // calls first, exactly like a direct command already could while a PREVIOUS design's
    // goalTick was mid-plan.
    let stepLine, parsed;
    setBusy(true);
    try {
      stepLine = await planNextStep(goal);
      if (replaced()) return; // plan is for a goal that's gone
      parsed = parseGoalStep(stepLine);
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
          !goal.log.some((l) => l.startsWith("loot:"))) {
        console.log(`[${USERNAME}] overriding BLOCKED (${parsed.reason}) -- no LOOT attempt yet, forcing one`);
        parsed = { type: "step", action: { type: "loot" } };
      }

      // Direct request, 2026-09-08 ("if they can't craft, they should explore, and find
      // resources for later"). Same "prompt guidance plus a code guard" reasoning as the LOOT
      // override just above: the prompt already teaches EXPLORE as an option, but a model
      // BLOCKED on a missing raw material (wood/ore not found nearby) sometimes gives up rather
      // than trying it, the same failure shape that override exists to catch. Checked AFTER the
      // smelt/furnace/ingot case above (and only if that one didn't already fire, since parsed
      // would no longer be "blocked" once it does) so the two overrides can't fight over which
      // fallback wins -- LOOT for a smelting-specific shortfall, EXPLORE for everything else.
      if (parsed.type === "blocked" && /craft|log|ore|plank|wood|resource|material|ingredient/i.test(parsed.reason) &&
          !goal.log.some((l) => l.startsWith("explore:"))) {
        console.log(`[${USERNAME}] overriding BLOCKED (${parsed.reason}) -- no EXPLORE attempt yet, forcing one`);
        parsed = { type: "step", action: { type: "explore" } };
      }
    } finally {
      setBusy(false);
    }

    if (parsed.type === "done") {
      // Fifth of five scoped enhancements: tighter DONE validation. A real hallucinated DONE
      // was observed live tonight -- a goal reporting complete after every single logged step
      // had failed, with no evidence anything actually changed. Flagged, not blocked: outright
      // refusing the model's own DONE risks a worse failure mode (an endless "are you sure"
      // loop) than the rare cosmetic mislabeling this catches -- visible here for a human, and
      // matched by hermes-minecraft-triage.py's own TRIAGE_PATTERNS for the Firmament to notice.
      const noEvidenceOfProgress = goal.steps > 0 && !goal.sawSuccess;
      if (noEvidenceOfProgress) {
        console.log(`[${USERNAME}] SUSPICIOUS DONE (no successful step ever logged for this ` +
                    `goal): ${goal.description}`);
      }

      // Direct live report, 2026-09-08 ("Mark and Luke claim they have bows") -- confirmed real:
      // "Secure a bow" was marked DONE and announced complete in chat while every actual attempt
      // to gather wood/string for one had failed (sawSuccess was true only because an UNRELATED
      // step elsewhere in the same goal had succeeded, e.g. a loot pass that found something
      // else entirely -- the weak "did anything ever succeed" check above can't catch this,
      // since it doesn't verify progress on the actual thing the goal was about). The DONE
      // prompt now asks for the specific item_id that proves completion; checked here against
      // real inventory/equipped gear (not the model's own say-so) before ever telling anyone --
      // the bot herself included -- that she has something she doesn't.
      //
      // Direct follow-up, 2026-09-09 ("monitor their behavior, look for issues"): confirmed live
      // that this item check has its own loophole -- nothing stopped the model from just saying
      // DONE NONE on a goal that plainly WAS about a specific item, dodging verification entirely.
      // Caught in the act: "mine some iron" was marked DONE NONE and announced complete with
      // zero successful steps ever logged (SUSPICIOUS DONE fired on the very same line, but back
      // then that flag was cosmetic-only). A NONE claim with zero evidence of ANY real progress
      // is now rejected exactly like a false item claim, using the same safe "treat as a real
      // give-up" path already proven not to cause an endless retry loop -- NONE is still accepted
      // when real progress WAS logged (a genuinely open-ended goal like "explore the area" that
      // isn't reducible to one item, but did succeed at something).
      if (parsed.item) {
        const reallyHasIt = bot.inventory.items().some((i) => i.name === parsed.item) ||
          [5, 6, 7, 8, 45].some((slot) => bot.inventory.slots[slot]?.name === parsed.item);
        if (!reallyHasIt) {
          console.log(`[${USERNAME}] REJECTED DONE (claimed ${parsed.item}, not actually in ` +
                      `inventory or equipped): ${goal.description}`);
          bot.chat(await narrateAction(
            `giving up on "${goal.description}" -- never actually got a ${parsed.item}.`));
          recordGoalOutcome(goal.description, "gave up",
            `claimed done but no ${parsed.item} in inventory`);
          await broadcastGoalState("abandoned", goal.description);
          await retireGoal(goal);
          return;
        }
      } else if (noEvidenceOfProgress || (goal.steps === 0 && !goal.builderPriorityItem && !goal.survivalPriorityItem)) {
        // (Review MB-10: a zero-step DONE NONE has no evidence either; Builder/survival goals get
        // their own world-state check below instead.)
        console.log(`[${USERNAME}] REJECTED DONE (NONE claimed, but no successful step ever ` +
                    `logged): ${goal.description}`);
        bot.chat(await narrateAction(
          `giving up on "${goal.description}" -- never actually made any real progress.`));
        recordGoalOutcome(goal.description, "gave up", "claimed done with no real progress");
        await broadcastGoalState("abandoned", goal.description);
        await retireGoal(goal);
        return;
      }

      // Real bug found live 2026-09-13 ("hallucinate their achievements"), confirmed with hard
      // evidence: a Builder-priority goal's item check just above only ever proves she HAS the
      // named item -- true the instant she crafts a beehive/table/furnace/chest, whether or not
      // she ever actually walked home and placed it. "craft a beehive ... and place it near
      // home" was announced complete TWICE in the same 24h window; nextBuilderPriority's own
      // real world-state check still found zero beehives near home every single cycle before
      // and after both claims. builderPriorityItemSatisfied() re-checks the SAME real condition
      // nextBuilderPriority() itself trusts (a world-placed block, or a real bed/shelter count),
      // not inventory possession, before a compound "craft AND place" directive gets to announce
      // success on the crafting half alone.
      if (goal.builderPriorityItem && !builderPriorityItemSatisfied(goal.builderPriorityItem)) {
        console.log(`[${USERNAME}] REJECTED DONE (claimed ${goal.builderPriorityItem} ` +
                    `done, but it's still not actually near home): ${goal.description}`);

        // Direct report, 2026-09-19 ("I don't think they really know how to use the crafting
        // table or furnace"). Root-caused live: Amy crafted a crafting_table at 01:45, then this
        // exact rejection fired three separate times over the next 25 minutes (01:59, 02:13,
        // 02:19) -- every time, the goal was thrown away outright (currentGoal = null) rather
        // than acting on the one thing already known for certain: she was STILL CARRYING the
        // table the entire time, she just never walked home and placed it. Abandoning wasted
        // that real progress and left it up to the next re-issued directive, minutes later, to
        // rediscover from scratch -- which kept immediately re-hallucinating DONE instead of
        // ever proposing "place" as a step. Rather than another unreliable LLM round-trip for
        // something this mechanical, do it directly: if she's still holding the item, walk home
        // and place it herself right now (reusing "gohome"/"place", both already robust), one
        // deterministic shot, before giving up on the whole goal.
        const stillHasItem = bot.inventory.items()
          .some((i) => i.name === goal.builderPriorityItem);
        let recovered = false;
        if (stillHasItem && await takeControl()) {
          await performAction(bot, { type: "gohome" }, USERNAME, handle);
          const placeResult = await performAction(bot,
            { type: "place", item: goal.builderPriorityItem }, USERNAME, handle);
          console.log(`[${USERNAME}] builder-priority recovery: ${placeResult.text} ` +
                      `(ok=${placeResult.ok})`);
          recovered = placeResult.ok && builderPriorityItemSatisfied(goal.builderPriorityItem);
        }

        if (recovered) {
          console.log(`[${USERNAME}] goal complete (recovered): ${goal.description}`);
          bot.chat(await narrateAction(`goal complete: ${goal.description}.`));
          recordGoalOutcome(goal.description, "done", null);
          await broadcastGoalState("done", goal.description, goal.builderPriorityItem);
          await retireGoal(goal);
          return;
        }

        bot.chat(await narrateAction(
          `not done yet on "${goal.description}" -- it's still not actually there.`));
        recordGoalOutcome(goal.description, "gave up",
          `claimed done but ${goal.builderPriorityItem} still not near home`);
        await broadcastGoalState("abandoned", goal.description);
        await retireGoal(goal);
        return;
      }

      // Same hallucinated-DONE problem as builderPriorityItem just above, for Tier 1's own
      // universal items (2026-10-11): "shelter" and "food" don't reduce to "holds item X" the
      // way the generic parsed.item check further up already covers, so they need the same kind
      // of explicit re-check. No "still holding it, place it herself" recovery step the way
      // Builder's items get -- there's no single held item that completes "build your own
      // shelter" or "stop being hungry," so a rejection here just lets nextSurvivalPriority()
      // re-propose the same still-unmet item next cycle, same as any other failed goal.
      if (goal.survivalPriorityItem && !survivalPriorityItemSatisfied(goal.survivalPriorityItem)) {
        console.log(`[${USERNAME}] REJECTED DONE (claimed ${goal.survivalPriorityItem} ` +
                    `done, but it's still not actually true): ${goal.description}`);
        bot.chat(await narrateAction(
          `not done yet on "${goal.description}" -- that's still not actually true.`));
        recordGoalOutcome(goal.description, "gave up",
          `claimed done but ${goal.survivalPriorityItem} still not satisfied`);
        await broadcastGoalState("abandoned", goal.description);
        await retireGoal(goal);
        return;
      }

      console.log(`[${USERNAME}] goal complete: ${goal.description}`);
      bot.chat(await narrateAction(`goal complete: ${goal.description}.`));
      recordGoalOutcome(goal.description, "done", null);
      await broadcastGoalState("done", goal.description, parsed.item);
      // Authoring (MINECRAFT_BOTS_DESIGN.md §14): only for a goal that actually worked its way
      // through from scratch, not one already served by a stored skill (servedBySkill) -- that
      // would just be re-storing an existing skill's own steps back under a new name. An
      // occasional coder call, not a per-tick cost -- see authorSkillFromGoal's own header on
      // why it's safe to await here (rare, not per-tick) and why the LLM only ever names the
      // already-real actionsTaken rather than inventing steps.
      if (!goal.servedBySkill && !goal.actionsTruncated) {
        try {
          await authorSkillFromGoal(goal.description, goal.actionsTaken);
        } catch (err) {
          console.error(`[${USERNAME}] skill authoring failed:`, err.message);
        }
      }
      await retireGoal(goal);
      return;
    }

    // Bot-to-bot help (direct follow-up, 2026-09-07: "look for more ways to improve their
    // autonomy") -- REQUEST never touches the game world, only Buzz, so it's handled here rather
    // than through performAction. Counts toward consecutiveFailures like any other non-resolving
    // step: if nobody responds within a few ticks, she still gives up normally instead of waiting
    // forever.
    if (parsed.type === "request") {
      console.log(`[${USERNAME}] requesting ${parsed.count} ${parsed.item} from the other bot`);
      try {
        await buzzPublish(AGENT_ID, "minecraft-coordination",
          JSON.stringify({ type: "request", item: parsed.item, count: parsed.count, forPlayer: USERNAME }));
      } catch (err) {
        console.error(`[${USERNAME}] item request publish failed:`, err.message);
      }
      logStep(goal, `request: asked for ${parsed.count} ${parsed.item}`, false);
      goal.consecutiveFailures += 1;
      if (goal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[${USERNAME}] giving up on goal after ${goal.consecutiveFailures} failures (kind=${goalKind(goal)}): ${goal.description}`);
        bot.chat(await narrateAction(`giving up on "${goal.description}" -- nobody could help with ${parsed.item}.`));
        recordGoalOutcome(goal.description, "gave up", `needed ${parsed.item}`);
        await broadcastGoalState("abandoned", goal.description);
        await retireGoal(goal);
      } else {
        await saveGoalIfCurrent(goal);
      }
      return;
    }

    if (parsed.type === "blocked") {
      logStep(goal, `blocked: ${parsed.reason}`, false);
      goal.consecutiveFailures += 1;
      console.log(`[${USERNAME}] goal blocked (${goal.consecutiveFailures}/` +
                  `${MAX_CONSECUTIVE_FAILURES}): ${parsed.reason}`);
      if (goal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[${USERNAME}] giving up on goal after ${goal.consecutiveFailures} failures (kind=${goalKind(goal)}): ${goal.description}`);
        bot.chat(await narrateAction(`giving up on "${goal.description}" -- ${parsed.reason}.`));
        recordGoalOutcome(goal.description, "gave up", parsed.reason);
        await broadcastGoalState("abandoned", goal.description);
        await retireGoal(goal);
      } else {
        await saveGoalIfCurrent(goal);
      }
      return;
    }

    if (replaced() || !(await takeControl())) return; // something else has the body this tick
    const result = await performAction(bot, parsed.action, goal.setBy || USERNAME, handle);
    handle.release(); // MB-21: the body is free again before memory writes and narration
    // Review MB-04/MB-05, 2026-09-24: an interrupted step is neither progress nor a genuine
    // failure, and a result for a goal that was replaced mid-action belongs to nobody -- drop both
    // rather than logging them into (or failing) whatever goal is current now.
    if (result.cancelled || replaced()) {
      console.log(`[${USERNAME}] goal step: ${parsed.action.type} interrupted -- ${result.text}`);
      return;
    }
    // See runAction's own 2026-09-17 note -- a targeted loot that actually withdrew something
    // is worth the same immediate cleanup pass as a craft/smelt.
    craftedOk = result.ok && (parsed.action.type === "craft" || parsed.action.type === "smelt" ||
      (parsed.action.type === "loot" && parsed.action.item));
    logStep(goal, `${parsed.action.type}: ${result.text}`, result.ok, parsed.action);
    goal.consecutiveFailures = result.ok ? 0 : goal.consecutiveFailures + 1;
    console.log(`[${USERNAME}] goal step: ${parsed.action.type} -> ${result.text} ` +
                `(ok=${result.ok}, consecutiveFailures=${goal.consecutiveFailures})`);

    // Direct request, 2026-09-13 ("extend resource sharing memory... to *any* resource or
    // crafted object"): a successfully PLACED utility block is exactly as worth sharing as a
    // mined resource -- she knows the real position right now, no reason to wait for some other
    // bot to stumble onto it later via noteNearbyResources' own broader sweep. Scoped to
    // CRAFTED_OBJECT_NAMES specifically (crafting_table/furnace/chest/beehive/bee_nest) -- an
    // ordinary torch or building-material placement isn't a "known location" fact worth cluttering
    // world memory with the way a shared utility block is.
    if (result.ok && parsed.action.type === "place" && CRAFTED_OBJECT_NAMES.includes(parsed.action.item)) {
      const pos = bot.entity.position;
      try {
        await writeMemoryNote({ scope: "world", persona: PERSONA_NAME,
          text: `Found ${parsed.action.item} near (${pos.x}, ${pos.y}, ${pos.z}), as of ${new Date().toISOString()}.` });
      } catch (err) {
        console.error(`[${USERNAME}] placed-object memory write failed:`, err.message);
      }
    }

    // Direct report, 2026-10-09 ("they don't notice crafting tables already placed nearby, or
    // remember them"): the block just above only ever fires for a utility block THIS bot just
    // placed. actions.js's own "craft" case (REUSABLE_UTILITY_BLOCKS) has a separate, older path
    // that finds an EXISTING crafting_table/furnace within 32 blocks and skips making a
    // duplicate ("already have a crafting_table nearby, no need to make another") -- a real,
    // just-confirmed position nobody ever wrote down, so the next bot who needs one starts from
    // zero again. noteNearbyResources() already does exactly this scan-and-record step for
    // mine/explore/scout; reusing it here needs no new logic, and its own near-duplicate check
    // (longterm.js) keeps this cheap on every ordinary "crafted a new one" case too.
    if (result.ok && parsed.action.type === "craft" && CRAFTED_OBJECT_NAMES.includes(parsed.action.item)) {
      noteNearbyResources(`after a successful ${parsed.action.type}`).catch((err) =>
        console.error(`[${USERNAME}] nearby-resource scan failed:`, err.message));
    }

    // Environmental memory (direct follow-up, 2026-09-07: "look for more ways to improve their
    // autonomy"). "even after looking around" is wanderAndRetryFind()'s own signature (actions.js
    // 1.11.0) for "tried the normal search AND wandered, still nothing" -- a real, worth-
    // remembering fact about this area, not just this one attempt. World-scoped (shared corpus)
    // since it's true regardless of which bot goes looking. Best-effort, never blocks the loop.
    if (!result.ok && result.text.includes("even after looking around")) {
      try {
        await writeMemoryNote({ scope: "world", persona: PERSONA_NAME,
          text: `No ${parsed.action.block ?? parsed.action.item ?? "target"} found even after ` +
                `wandering to look, as of ${new Date().toISOString()}.` });
      } catch (err) {
        console.error(`[${USERNAME}] environmental memory write failed:`, err.message);
      }
      // Direct request, 2026-09-11 ("ask the other bots to look near themselves"): "mine"
      // specifically (a single named target), not "explore" (already a broad multi-resource
      // scan of its own -- a scout request for "explore" wouldn't even name one resource to
      // ask about). Fire-and-forget, same reasoning as the item "request" step just below this
      // one: publish and let this tick's own failure stand, a LATER goal tick's own
      // findRememberedLocation() (actions.js) is what actually benefits from whatever the fleet
      // reports back in the meantime -- no new blocking/waiting primitive needed.
      if (parsed.action.type === "mine") {
        noteNearbyResources("before asking the fleet to scout", [parsed.action.block]).catch((err) =>
          console.error(`[${USERNAME}] nearby-resource scan failed:`, err.message));
        try {
          await buzzPublish(AGENT_ID, "minecraft-coordination",
            JSON.stringify({ type: "scout", resource: parsed.action.block }));
        } catch (err) {
          console.error(`[${USERNAME}] scout request publish failed:`, err.message);
        }
      }
    }

    // Direct request, 2026-09-08 ("if they can't craft, they should explore, and find resources
    // for later"): the positive counterpart to the failure-case write just above -- a
    // successful EXPLORE found something worth remembering not just for the current goal, but
    // for whichever bot needs the same raw material next, world-scoped for the same reason.
    // Position included (rounded -- exact block precision doesn't matter for "worth checking
    // around here again"), since a note with no location is far less actionable than one with
    // one.
    //
    // Direct request, 2026-09-19 ("make *sure* that discovered resources are being stored in
    // world memory"): a real, confirmed gap -- a successful MINE never wrote anything here at
    // all, only a FAILED one did (the "no X found" branch above). A Miner who successfully finds
    // and mines iron ore all day was sharing nothing with the rest of the fleet; only her
    // failures were visible to anyone else. Now mirrors explore's own note exactly.
    if ((parsed.action.type === "explore" || parsed.action.type === "mine") && result.ok) {
      try {
        const pos = bot.entity.position.floored();
        await writeMemoryNote({ scope: "world", persona: PERSONA_NAME,
          text: `${result.text} near (${pos.x}, ${pos.y}, ${pos.z}), as of ${new Date().toISOString()}.` });
      } catch (err) {
        console.error(`[${USERNAME}] ${parsed.action.type} memory write failed:`, err.message);
      }
      // Direct request, 2026-09-19 ("expand their search capabilities further, especially the
      // miner and explorer roles"): a successful mine/explore already has her standing somewhere
      // new and worth a proper look, not just recording the one thing she was after -- the same
      // free "look near itself" sweep noteNearbyResources() already does for a scout request,
      // now also running for her own routine successes. Catches anything else in range
      // (ore/log/village indicator) that mining/exploring toward the ONE target happened to pass
      // near, at zero extra travel cost.
      noteNearbyResources(`after a successful ${parsed.action.type}`).catch((err) =>
        console.error(`[${USERNAME}] nearby-resource scan failed:`, err.message));
    }

    if (goal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`[${USERNAME}] giving up on goal after ${goal.consecutiveFailures} failures (kind=${goalKind(goal)}): ${goal.description}`);
      bot.chat(await narrateAction(`giving up on "${goal.description}" -- ${result.text}`));
      recordGoalOutcome(goal.description, "gave up", result.text);
      await broadcastGoalState("abandoned", goal.description);
      await retireGoal(goal);
      return;
    }

    await saveGoalIfCurrent(goal);
    // A check-in every few steps, not every step -- otherwise gearing up would spam chat once
    // per GOAL_TICK_MS the whole time she works.
    if (goal.steps % 3 === 0) {
      bot.chat(await narrateAction(`still working on ${goal.description}: ${result.text}`));
    }
  } catch (err) {
    console.error(`[${USERNAME}] goal tick failed:`, err.message);
  } finally {
    handle?.release();
    if (craftedOk) setSurplusCleanupDueAt(Date.now() + SURPLUS_CLEANUP_QUIET_MS); // MB-09: deferred
  }
}

// Direct request, 2026-10-28 ("the 45 second per action timer is slowing things down a lot" /
// "should the bots poll for a next action when a previous action concludes, rather than on a
// timer?"): yes. A tick that actually ran a goal step (goal.steps moved) chains the next tick
// GOAL_FOLLOWUP_MS after it ends, so a bot working a goal goes step to step instead of sitting
// out the rest of a 45s window after a 3s log chop. The GOAL_TICK_MS interval stays as the
// fallback for ticks that ran nothing (no control, night pause, no goal). The in-flight guard
// keeps the chained tick and the interval tick from both planning at once -- before this, only
// the arbiter kept overlapping ticks apart, and only at the point of moving the body.
const GOAL_FOLLOWUP_MS = parseInt(process.env.MC_GOAL_FOLLOWUP_MS || "2000", 10);
let goalTickInFlight = false;

export async function runGoalTick() {
  if (goalTickInFlight) return;
  goalTickInFlight = true;
  const goal = currentGoal;
  const stepsBefore = goal?.steps ?? 0;
  try {
    await goalTick();
  } catch (err) {
    console.error(`[${USERNAME}] goalTick error:`, err.message);
  } finally {
    goalTickInFlight = false;
  }
  if (goal && currentGoal === goal && goal.steps > stepsBefore) setTimeout(runGoalTick, GOAL_FOLLOWUP_MS);
}
