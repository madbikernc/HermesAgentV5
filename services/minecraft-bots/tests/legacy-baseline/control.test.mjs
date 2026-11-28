// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/control.test.mjs ("goals, arbitration, commands and
// memory notes") against current services/minecraft-bots/arbiter.js and router.js. arbiter.js's
// public API (OWNERS/requestControl/releaseControl/cancelAndClear/cancelIfAtMost/holdsControl/
// isBusy/currentOwner) is unchanged by the Mindcraft port, so every arbitration check below runs
// against the real module directly -- no vm, no mocking of arbiter.js itself. Checks tied to the
// old goal engine (currentGoal/goalTick/parseGoalStep/curriculum/give-request claims/remembered
// locations), all archived at services/minecraft-bots-archive-11-2026/, are test.todo() with the
// specific removed mechanism named -- excluded from the score, never silently dropped.
// Run: node --test services/minecraft-bots/tests/legacy-baseline/control.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makeBot, V3 } from "./_mockbot.mjs";
import * as arbiter from "../../arbiter.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("[legacy:control] MB-03 teleport-style cancelAndClear leaves no owner behind", async () => {
  const bot = makeBot();
  const held = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP);
  arbiter.cancelAndClear(bot);
  assert.equal(arbiter.isBusy(), false);
  assert.equal(held.token.preempted, true);
  const next = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP, { waitMs: 0 });
  assert(next, "GOAL_STEP should be acquirable after a teleport");
  next.release();
});

test("[legacy:control] MB-02 a preempted caller loses holdsControl() once a higher tier takes over", async () => {
  const bot = makeBot();
  const old = await arbiter.requestControl(bot, arbiter.OWNERS.GOAL_STEP);
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  assert.equal(arbiter.holdsControl(old), false, "the preempted caller must not still appear to hold control");
  assert.equal(old.token.cancelled, true);
  assert.equal(old.token.preempted, true);
  assert.equal(bot.pathfinder.goal, null, "cancelPhysical() clears the pathfinder goal on preemption");
  assert.equal(arbiter.currentOwner(), "HEALTH_CRITICAL");
  emergency.release();
});
test.todo("[legacy:control] MB-02 ...and performAction() itself refuses to act under a stale handle -- NOT PORTED: performAction()/actions.js were archived; commands.js's own executeCommand() dispatch wasn't audited here for the same stale-handle guard (flagged, not reproduced)");

test.todo("[legacy:control] MB-04 cancelled recovery is not success and keeps the preemptor's path -- NOT PORTED: the 'recover' action (actions.js) and its own token.preempted-aware retry loop were archived; the surviving arbiter-level claim (a preempted holder is marked preempted, not just cancelled) is already covered by the MB-02 check above");

test.todo("[legacy:control] MB-08 goal parser accepts GOHOME -- NOT PORTED: parseGoalStep()/the ACTION grammar were archived with the goal engine; the model now emits !commands directly");
test.todo("[legacy:control] MB-06 an addressed STOP is recognized without the model -- NOT PORTED: isAddressedStop()'s natural-language 'Amy, stop!' regex heuristic was archived; only the explicit !stop command syntax stops a bot now");

test("[legacy:control] MB-06 a newer player command preempts an older one at the same tier (preemptEqual), and STOP never touches an emergency", async () => {
  const bot = makeBot();
  const first = await arbiter.requestControl(bot, arbiter.OWNERS.DIRECT_COMMAND);
  const second = await arbiter.requestControl(bot, arbiter.OWNERS.DIRECT_COMMAND, { preemptEqual: true, waitMs: 0 });
  assert(second);
  assert.equal(first.token.preempted, true);
  assert.equal(arbiter.cancelIfAtMost(bot, arbiter.OWNERS.DIRECT_COMMAND.priority, "STOP"), true);
  assert.equal(arbiter.isBusy(), false);
  const drowning = await arbiter.requestControl(bot, arbiter.OWNERS.DROWNING);
  assert.equal(arbiter.cancelIfAtMost(bot, arbiter.OWNERS.DIRECT_COMMAND.priority, "STOP"), false, "STOP must not cancel a higher-tier emergency");
  assert.equal(drowning.token.cancelled, false);
  drowning.release();
});

test("[legacy:control] MB-10 a skill function stops cleanly on bot.interrupt_code instead of running to completion", async () => {
  // Old: runSkill() (the old skills.js's authored-skill sequencer) stopped on a cancelled step.
  // New: there is no skill sequencer -- but every real skills.js primitive loop (collectBlock,
  // attackEntity, defendSelf, stay, ...) checks bot.interrupt_code itself. This proves that
  // contract on a real one: attackEntity() must return false, not hang or finish, once
  // interrupt_code flips mid-call.
  const { attackEntity } = await import("../../skills.js");
  const bot = makeBot();
  const target = { id: 1, name: "zombie", position: new V3(2, 64, 0) };
  bot.entities[1] = target; // left in place -- the target must never vanish on its own here
  const pending = attackEntity(bot, target);
  await new Promise((r) => setTimeout(r, 50));
  bot.interrupt_code = true;
  const result = await pending;
  assert.equal(result, false, "a cancelled attack must report failure, not a kill");
});

test.todo("[legacy:control] MB-20 curriculum stages need every requirement, tier-aware -- NOT PORTED: the tech-tree curriculum tracker was archived with mayor.js");
test.todo("[legacy:control] MB-14 goals pause at night unless a player set them tonight -- NOT PORTED: goalPausedForNight()/the goal engine were archived; the decision loop runs on the same interval day or night now");
test.todo("[legacy:control] MB-13 exactly one claimant wins a give request -- NOT PORTED: giveClaims/settleGiveClaims (cross-bot give-request arbitration) were archived; skills.js's giveToPlayer() is a direct, unclaimed drop with no multi-bot race to settle");

test("[legacy:control] MB-02 a takeover closes the interrupted action's open chest/furnace/crafting window", async () => {
  const bot = makeBot();
  let closed = 0;
  bot.currentWindow = { id: 3 };
  bot.closeWindow = () => { closed++; bot.currentWindow = null; };
  const old = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  const emergency = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
  assert.equal(closed, 1);
  assert.equal(bot.currentWindow, null);
  assert.equal(old.token.preempted, true);
  emergency.release();
});

test.todo("[legacy:control] MB-06 a bare 'stop' from the player whose command is running stops the bot -- NOT PORTED: activeDirectSpeaker/isStopFromActiveCommander were archived; commands.js's !stop has no notion of 'whose command is currently running'");
test.todo("[legacy:control] Give reports the actual partial drop without claiming recipient pickup -- NOT PORTED: skills.js's giveToPlayer() return shape was not audited for partial-drop accuracy against this exact claim (flagged, not reproduced)");
test.todo("[legacy:control] MB-13 a failed delivery is retried once; a success is acknowledged -- NOT PORTED: pendingGiveRequest/checkPendingGiveRequests (the cross-bot delivery-retry/ack loop) were archived");
test.todo("[legacy:control] Fairness: routine checks that lose their turn are counted -- NOT PORTED: routineBlocked()/routineSkips were archived; the new decisionTick/modes ticks only gate on arbiter.isBusy(), with no per-check fairness counter");
test.todo("[legacy:control] MB-03 a rejected /tp still leaves no control owner behind -- NOT PORTED: teleportToSpawn()/checkStuck() were dropped entirely from index.js 4.1.0 (no cross-restart wedge/teleport-home rescue); arbiter.js still defines OWNERS.TELEPORT_HOME but nothing currently requests it");
test.todo("[legacy:control] MB-05 a goal replaced during skill lookup gets no skill run and no writes -- NOT PORTED: the goal engine (currentGoal/findSkill/goalTick) was archived");
test.todo("[legacy:control] MB-05/MB-21 planning holds no control, and a goal replaced mid-plan is not acted on -- NOT PORTED: planNextStep()/the goal engine were archived; decisionTick() holds no control while awaiting callRole() either, but there is no 'goal' object left to be replaced underneath it");
test.todo("[legacy:control] MB-10 a 13-step solve is not truncated into a 12-step skill -- NOT PORTED: authorSkillFromGoal() (dynamic skill authoring from a solved goal) was archived; skills.js is now a fixed library, nothing is authored at runtime");
test.todo("[legacy:control] MB-20 curriculum progress and evidence survive a Mayor restart -- NOT PORTED: recordCurriculumEvidence()/loadCurriculumStage() were archived with mayor.js");

test("[legacy:control] MB-21 a stalled router call times out instead of hanging", async () => {
  const realFetch = globalThis.fetch;
  process.env.HERMES_ROUTER_TIMEOUT_MS = "50";
  try {
    globalThis.fetch = (_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
    });
    const { callRole } = await import("../../router.js"); // first import in this process -- env var above applies
    const started = Date.now();
    const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's own timer doesn't hold the process open
    try {
      await assert.rejects(callRole("dispatch", []), (err) => err.name === "TimeoutError");
    } finally {
      clearTimeout(keepAlive);
    }
    assert(Date.now() - started < 2000);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.HERMES_ROUTER_TIMEOUT_MS;
  }
});

test("[legacy:control] MB-23/S34: an analysis-skipping callRole() call must never read history that can carry raw, untrusted player/speaker chat text", async () => {
  // The old classifyIntent()/narrateAction() call sites and their `fromVerifiedBot` exemption were
  // archived along with chat.js, but the security property they protected is checkable directly
  // against the real current index.js. Found during this suite's own porting (2026-11-27): a bare
  // `analysis: true` on decisionTick()'s callRole() skipped full Layer 2 injection screening over a
  // `messages` array built from the same module-level `conversationHistory` that handleChatMessage()
  // pushes raw `${speaker}: ${message}` text into -- a player's chat could reach the model unscreened
  // by riding along in history. Fixed same-day (index.js 4.2.0): pushHistory() now tags every entry
  // `trusted` (false only for an unverified speaker's raw line), and decisionTick's analysis flag is
  // `conversationHistory.every((h) => h.trusted)`, never a bare literal. This checks the fix is
  // actually in place, not just that the old literal is gone.
  const indexSrc = await readFile(ROOT + "index.js", "utf8");
  assert.doesNotMatch(indexSrc, /analysis:\s*true\s*,/, "no callRole() site may hand a bare analysis:true literal to a call whose messages can include conversationHistory");
  assert.match(indexSrc, /trusted:\s*isAnotherBot\(speaker\)/, "the raw speaker-text push into history must be tagged by its real trust (isAnotherBot), not assumed trusted");
  assert.match(indexSrc, /analysis:\s*allTrusted/, "decisionTick's analysis flag must be computed from history's actual trust, not a literal");
});

test.todo("[legacy:control] Direct investigation 2026-11-22: ACTION BUILD becomes a standing goal, not a raw one-off build -- NOT PORTED: classifyIntent()/ACTION-grammar routing and the goal engine it fed were both archived; the model now emits !commands directly, with no typed ACTION/goal classification step in between");
test.todo("[legacy:control] MB-21 RAG subprocesses carry a timeout (local mode) -- NOT PORTED: rag-backend.js (the long-term/RAG memory backend) was archived; index.js 4.0.0 replaced it with a bounded in-process rolling history reset on every restart");
test.todo("[legacy:control] MB-22 a stationary bot nobody is moving never escalates; a wedged one does -- NOT PORTED: checkStuck()/nudgeUnstuck()/teleportToSpawn() were dropped entirely (same gap as the MB-03 /tp check above) -- there is currently no stuck-bot detection or rescue of any kind");
test.todo("[legacy:control] Remembered spots: the nearest one wins, and one found empty on arrival is forgotten -- NOT PORTED: findRememberedLocation()/visitRememberedSpot() (the semantic location-memory system) were archived along with longterm.js/rag-backend.js");
test.todo("[legacy:control] Dedicated runners get a much longer failure leash than the freeform planner -- NOT PORTED: failGoalStep()/the goal engine's per-kind failure-leash logic were archived; there are no goals, dedicated or freeform, left to fail");
test.todo("[legacy:control] Giving up on a goal names its kind, so self-repair can tell one failing runner from another -- NOT PORTED: goalKind()/the goal engine were archived; self-repair's own log-pattern matching for this project was not re-pointed at anything in index.js 4.1.0 (flagged, not reproduced)");
test.todo("[legacy:control] Goal loop: a finished step chains the next tick instead of waiting out the full timer -- NOT PORTED: runGoalTick()/the goal engine were archived; decisionTick() always waits out the full GOAL_TICK_MS (45s default), even right after a command just completed");
