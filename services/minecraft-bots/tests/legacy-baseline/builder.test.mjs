// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/builder.test.mjs against the Mindcraft-ported
// architecture. Every check in the old file depends on machinery that is fully archived (the
// goal/priority-tier engine, file-based builder-item claims, home-lighting backoff state) with no
// current equivalent at all -- not a regression to chase, a deliberate architecture change
// (MINECRAFT_BOTS_RESTART_PLAN.md: replace the hand-built goal/priority engine with the
// Mindcraft-ported skill/command/mode layer plus an LLM-driven decision loop). Each entry below is
// test.todo, with the specific removed mechanism named, so the gap is recorded rather than
// silently dropped. See services/minecraft-bots-archive-11-2026/ (goal-tick.js, goal-proposal.js,
// goal-runners.js, priorities.js, upkeep-home.js, actions.js's builder-claims code) for the "best
// past implementation" this measures against.
// Run: node --test services/minecraft-bots/tests/legacy-baseline/builder.test.mjs

import { test } from "node:test";

test("[legacy:builder] MB-05 an old goal action does not write into a replacement goal",
  { todo: "NOT PORTED: there is no currentGoal/goalTick object in the new architecture -- the archived goal-tick.js's goal-replacement race has no current analog to test (index.js 4.1.0 has no persistent goal object at all; each decision tick is independent)." },
  () => {});

test("[legacy:builder] EFF home lighting backs off exponentially and only runs on the maintainer",
  { todo: "NOT PORTED: upkeep-home.js (checkHomeLighting/HOME_LIGHTING_MAINTAINER) is archived -- no periodic home-lighting behavior exists in the new decision loop yet." },
  () => {});

test("[legacy:builder] MB-08 place_home walks home, then places the item",
  { todo: "NOT PORTED: the \"place_home\" action type (actions.js) is archived. The underlying primitives (skills.js's goToPosition/goToGoal and placeBlock) are both real and portable individually -- see tests/legacy-baseline/*.test.mjs for those -- but the composed \"walk home, then place\" behavior itself has no current equivalent to call." },
  () => {});

test("[legacy:builder] Builder claims: a live claim blocks another bot on the same item, not a different one",
  { todo: "NOT PORTED: the file/hermes-memory-backed builder-item-claims mechanism (actions.js's claimBuilderItem/myBuilderClaim) is archived -- no claim registry exists in the new architecture." },
  () => {});

test("[legacy:builder] Builder claims: releasing frees the item, and a stale claim expires on its own",
  { todo: "NOT PORTED: same removed builder-item-claims mechanism as the check above." },
  () => {});

test("[legacy:builder] Tier 2: builderPriorityItemSatisfied stays in lockstep with builderPriorityCandidates for the same usability signal",
  { todo: "NOT PORTED: the survival/builder priority-tier engine (priorities.js's builderPriorityCandidates/builderPriorityItemSatisfied) is archived -- the new decision loop asks the muse role what to do next each tick rather than walking a hardcoded priority list, so there is no second function to keep in lockstep." },
  () => {});
