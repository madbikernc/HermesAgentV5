// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/gathering.test.mjs against the Mindcraft-ported
// architecture (skills.js/world.js/commands.js/modes.js). See
// services/minecraft-bots-archive-11-2026/ for the archived "best past implementation" this
// measures against. Run: node --test services/minecraft-bots/tests/legacy-baseline/gathering.test.mjs
//
// Every old check here is test.todo. Two different reasons, both named per check rather than
// left silent:
//
// 1. Goal-engine/role/coordination mechanics with no current equivalent at all (the fallback
//    coordinator, Tier-2 location-sharing cadence, OUTCOME logging, skill-replay scoring,
//    opportunistic-gather goal tagging) -- archived whole with goals.js/priorities.js/chat.js.
//
// 2. Real, still-in-scope gathering/mining behavior (exposed-vs-buried ranking, a path-timeout
//    mid-dig retry, climb-to-surface when nothing's found underground, felling a whole tree) that
//    the ported skills.collectBlock() genuinely does NOT reproduce -- it just takes
//    world.getNearestBlocksWhere()'s first (nearest, not most-reachable) match and calls
//    bot.collectBlock.collect() once, with none of the old actions.js "mine" handler's retry/
//    ranking/fallback logic. These are real capability regressions, flagged here rather than
//    silently dropped -- but collectBlock() unconditionally constructs a real
//    mineflayer-pathfinder Movements instance before any of that logic would even run, and
//    Movements' own safeToBreak()/getNeighbors() machinery is not reliably mockable without a
//    live bot's real chunk/world data: a hand-built mock risks giving a false signal (failing on
//    a mock-shape gap, not on the actual missing behavior) in either direction. The honest
//    measurement of these sits in tests/live.test.mjs against the real server, not here.

import { test } from "node:test";

test.todo("[legacy:gathering] MB-11 fallback coordinator accepted once Mayor is unreachable; server echoes ignored -- NOT PORTED: handleIncoming()'s fallback-coordinator/classifyIntent routing is archived with index.js's old chat-command layer; index.js 4.0.0's handleChatMessage treats every non-bot, non-test speaker as OWNERS.DIRECT_COMMAND, with no Mayor-liveness fallback concept.");

test.todo("[legacy:gathering] Tier 2: checkLocationSharing runs noteNearbyResources on a standing cadence, not just as a side effect -- NOT PORTED: the Tier 2 priority-item cadence system (priorities.js) is archived whole; nothing currently schedules a periodic resource-sharing scan.");

test.todo("[legacy:gathering] MB-18 every action outcome is logged as one structured OUTCOME line -- NOT PORTED: the `[name] OUTCOME {...}` structured log line (actions.js's performAction wrapper) has no equivalent; commands.js's executeCommand() returns a plain result string, logged ad hoc by index.js, not in a fixed machine-parseable shape triage could match on.");

test.todo("[legacy:gathering] MB-10 an interrupted skill replay is not scored and can run again -- NOT PORTED: goalTick()'s skill-lookup/runSkill()/recordSkillOutcome() scoring loop is archived with the rest of the goal engine; commands.js's executeCommand() has no concept of a scored 'skill' distinct from any other command.");

test.todo("[legacy:gathering] Collect: a path timeout mid-dig lets the swing finish, then retries instead of failing -- NOT PORTED (regression): actions.js's collectBlocks() caught a mid-dig pathfinder Timeout, waited out the in-flight dig, and retried with a widened thinkTimeout; skills.collectBlock() calls bot.collectBlock.collect(block) once per block with no such retry. A real capability loss, but proving it requires driving collectBlock()'s unconditional Movements construction -- not safely mockable here, see file header.");

test.todo("[legacy:gathering] Opportunistic gather: a nearby ore she can break becomes a goal; wood and an unmet tool tier do not -- NOT PORTED: nextOpportunisticGather() (priorities.js) and its goal-tagging are archived; the model can still choose to mine a spotted ore via !collectBlocks on its own judgment, but nothing automatically proposes it as a goal, and no tool-tier gate exists outside the model's own reasoning.");

test.todo("[legacy:gathering] Opportunistic gather: a tagged goal mines the spotted block once and finishes; real failures still give up -- NOT PORTED: same opportunistic-gather goal-tagging and dedicated-runner dispatch (goal-runners.js) as above, archived whole.");

test.todo("[legacy:gathering] Mine: a wood search that fails everywhere climbs toward the surface and tries again -- NOT PORTED (regression): mine.js's climbTowardSurface() fallback (action-search.js) has no equivalent in skills.collectBlock(), which just reports no match found; a bot stuck underground with no visible wood has no automatic recovery. Not safely mockable here, see file header.");

test.todo("[legacy:gathering] Mine: ore/stone never climbs toward the surface -- underground is exactly where it belongs -- NOT PORTED: paired with the climb-to-surface check above; the underlying climbTowardSurface()/mine.js fallback this guarded against misusing is itself archived.");

test.todo("[legacy:gathering] Mine: felling a tree mines the whole trunk and its leaves, not just the base log -- NOT PORTED (regression): mine.js's expandWholeTree() flood-fill (archived) has no equivalent; skills.collectBlock() mines exactly `num` instances of the named block type and nothing it's structurally attached to. Not safely mockable here, see file header.");
