// Version: 1.0.0
//
// 1.0.0 (2026-11-10) -- split out of index.js (2.138.0) unchanged: the bot's pathfinder setup --
// SwimMovements and its costs (liquid, entity, dig), the blocks it may never break, the
// scaffolding guard, door support and stepped goto, the search limits (searchRadius,
// thinkTimeout, tickTimeout), and the path_update/path_reset diagnostics with the dig_error
// burst guard. Its own file, under the self-repair pipeline's 40000-char whole-file limit, so a
// pathfinding fix can be generated against it; index.js (585k chars) never could be.
//
// setupPathfinding() runs once, from index.js's spawn handler, before the bot's first path
// search, and returns the shared SwimMovements instance it installed.

import { Vec3 } from "vec3";
import { SwimMovements, installDoorSupport, installSteppedGoto } from "./swim-movements.js";
import { isProtectedBlockName } from "./actions.js";
import { wouldBlockAccess } from "./shelter.js";

export function setupPathfinding(bot, { username: USERNAME }) {
  // SwimMovements (swim-movements.js): stock Movements can walk across open water at a
  // constant Y-level but can never change depth once already in it -- see that file's own
  // comment for the confirmed library gap this closes (water crossings only, lava unaffected).
  const movements = new SwimMovements(bot);
  // mineflayer-pathfinder defaults canOpenDoors to false, with its own comment: "Causes
  // issues. Probably due to none paper servers." Direct report: bots navigate badly around
  // doors, ladders, and stairs -- doors are the one of those three with a known, named,
  // library-level default working against them. Worth enabling now that this fleet runs a
  // mature, well-supported version (1.21.11) rather than trusting a comment of unknown
  // vintage -- if it turns out to genuinely misbehave here, that's diagnosable from the
  // path_update logging below, not a reason to leave it off untested.
  movements.canOpenDoors = true;
  // Real incident tonight: Amy drowned repeatedly because her death spot (and separately, a bed
  // she'd used) sat right at open water, and every path back to either simply waded straight
  // through. Confirmed against mineflayer-pathfinder's own astar.js: liquidCost (default 1, the
  // same as a normal step) adds to a node's cost when it's inside a liquid -- barely a
  // deterrent. Raised well above a typical land route's cost so pathfinder strongly prefers dry
  // ground when one exists within its search radius, while still leaving water crossable (just
  // deprioritized) when it's genuinely the only way through -- not banned outright, since that
  // would strand her at any water-crossed goal with no alternative route.
  movements.liquidCost = 20;
  // Direct request, 2026-09-21 ("re-evaluate the entire defense scheme"), root-caused from a live
  // mass-death incident (5 bots died within ~90 seconds, several repeatedly): most of the fleet
  // sleeps in one small shared area, and a live log sweep during the incident showed constant
  // `path_reset: stuck` for whichever bots were packed in tightest -- a "success" path immediately
  // followed by getting stuck again a few seconds later, over and over, recomputing trivial 1-3
  // node routes that never actually complete. mineflayer-pathfinder's own entityCost (default 1,
  // the SAME magnitude as a single walk step) barely discourages routing through a square another
  // bot is standing in or near -- with 7-9 entities packed into a tight space, nearly every route
  // touches at least one occupied square, and Minecraft's own real collision (unlike the search's
  // cost model) can make that square genuinely unreachable at execution time even though the plan
  // said "success," triggering the stuck-detection/recompute loop seen live. Raised well above a
  // plain step's cost, same "strongly prefer, don't forbid" reasoning as liquidCost/digCost --
  // encourages routing AROUND a crowd instead of through it whenever an alternative exists, while
  // still leaving a genuinely crowd-only route possible rather than refusing to move at all.
  movements.entityCost = 8;
  // Direct report, 2026-09-21 ("they still destroy walls instead of using doors"). A real,
  // distinct gap from the door-protection fix just below this comment: doors/trapdoors/fence
  // gates are already protected from being dug through outright (blocksCantBreak), but an
  // ORDINARY wall block -- stone, planks, whatever the building is actually made of -- is not,
  // rightly so in general (she needs to be able to dig through genuine terrain obstructions).
  // The problem is cost, not permission: confirmed against this same astar.js-fed cost formula
  // liquidCost already tunes -- digCost (default 1) multiplies straight into a node's cost, and
  // for anything quick to break (planks, dirt) that's often cheaper than detouring around a
  // building to its actual door, so pathfinder happily punches a new hole instead. Raised well
  // above a typical walking route's cost, same "strongly prefer, don't forbid" reasoning as
  // liquidCost above -- she'll still dig through a genuine dead end with no path around it, just
  // never again as a shortcut past a door that was right there.
  //
  // Direct live follow-up, 2026-09-21 ("they can't get out of the home"): the original value here
  // (30) was a real, self-inflicted regression, not a tuning nitpick -- confirmed live via
  // astar.js's own maxCost ceiling (this.maxCost = startNode.h + searchRadius, and any node whose
  // cost exceeds it gets PRUNED from the search entirely, not just deprioritized). With
  // searchRadius fixed at 48 (below) and a nearby goal's own heuristic near zero, the entire
  // search budget for a short local trip is only ~48-58 -- and laborCost = (1 + 3*digTime/1000) *
  // digCost means a SINGLE dig on an ordinary block at digCost 30 could cost 40-120+ on its own,
  // consuming the whole budget in one step and turning "expensive but valid path" into a hard
  // noPath. Confirmed live: 7 bots crammed into one small shelter, one bot alone logging 239
  // noPath results in 2 hours, zero successful travel the entire window. Lowered to 5, which
  // fixed that crisis -- but reopened the ORIGINAL one it was chasing: direct report, again,
  // "they are back to digging through the wall instead of opening the door."
  //
  // Direct live follow-up, same day: confirmed by measuring real block.digTime() values (the
  // same call movements.js's own cost formula makes) that digCost alone can never satisfy both
  // reports at once. digTime for the identical block varies over 100x by tool: cobblestone
  // measured 100ms with a netherite pickaxe + efficiency 5 (common gear in this fleet) vs 10000ms
  // with no tool. At digCost 5, the well-tooled case costs barely more than a plain walk step
  // (~6.5) -- nowhere near enough to prefer a door a few blocks out of the way, exactly the
  // regression just reported. Raising digCost enough to fix that (~15, chosen below) makes the
  // untooled case cost 400+ again, recreating the exact pruning crisis this value was just
  // lowered to fix. SwimMovements now caps the per-block labor-cost contribution directly
  // (MAX_DIG_LABOR_COST, swim-movements.js 1.1.0) so raising digCost back up is finally safe --
  // see that file's own comment for the full reasoning.
  movements.digCost = 15;
  // Direct request, 2026-09-08 ("before they dig or destroy a block, they should make sure it
  // is not a functional block like a bed or a furnace... or any other form of crafted item or
  // block"). Confirmed against mineflayer-pathfinder's own movements.js source: its default
  // blocksCantBreak only ever protects chests and non-diggable blocks (bedrock etc.) from being
  // auto-dug through while routing around an obstacle -- a furnace, bed, or bookshelf sitting in
  // a bot's way is "diggable" by that library's own definition and gets bulldozed exactly like
  // stone would. Adds every real functional/crafted block (isProtectedBlockName(), actions.js --
  // the same shared list "mine" now also refuses to deliberately target) to blocksCantBreak, so
  // this holds regardless of WHY the pathfinder wanted to dig, not just for one action's own
  // deliberate target check.
  for (const block of bot.registry.blocksArray) {
    if (isProtectedBlockName(block.name)) movements.blocksCantBreak.add(block.id);
  }
  // Direct live report, 2026-09-21 ("group of bots standing in the open, not moving or running,
  // being actively attacked -- automation failure"), traced back to this same day's own
  // MAX_DIG_LABOR_COST fix (swim-movements.js 1.1.0, added to solve the wall-vs-door regression).
  // Confirmed live: Mayor, Nell, and Bob were all independently hitting
  // `dig_error target: netherite_block` at nearly the same home-base coordinates, over and over.
  // Measured the real digTime: netherite_block/obsidian take 75000ms to dig even with a netherite
  // pickaxe + efficiency 5 (hardness 50 barely responds to efficiency at all) -- a REAL 75-second
  // dig attempt, not a cheap one. The labor-cost cap that makes doors-vs-walls tuning safe has a
  // real cost: it flattens laborCost for EVERY diggable block down to the same ceiling regardless
  // of actual hardness, so a block that should cost 3000+ (and therefore never look worth
  // attempting) now reads as identically "cheap" as a plank wall. Pathfinder kept choosing this
  // route, starting a real 75-second dig, and almost immediately getting interrupted by some
  // OTHER periodic check in the same process (self-defense fires every 2s) -- bot.stopDigging()
  // aborts the in-flight dig, which the library reports as the same dig_error, and the next tick
  // recomputes the identical "cheap" route into the identical abort, forever. During combat, this
  // is exactly what "standing still while being hit" looks like from outside: attack's own
  // chase-to-target movement (bot.pvp shares this same movements object) thrashing on this loop
  // instead of ever actually closing distance or landing a hit.
  //
  // The right fix isn't to lower the cap back down (that reopens §50's own wall-vs-door
  // regression) -- it's to stop letting the cap apply to blocks no reasonable cost tuning should
  // ever call "cheap" in the first place. blocksCantBreak already excludes furnaces/chests/doors
  // from casual auto-dig-while-routing without making them permanently unbreakable outright (a
  // bot that wants one gone still can via a deliberate action); the same reasoning extends
  // naturally to real-world hardness. HARDNESS_THRESHOLD=10 is a wide, deliberately conservative
  // gap: every normal terrain/building material this fleet actually builds with or digs through
  // tops out at hardness 5 (iron_block, diamond_block, coal_block) or well under (stone 1.5,
  // deepslate 3) -- obsidian/netherite_block/ancient_debris/crying_obsidian/respawn_anchor all
  // sit at 30-50, a clean, wide separation with nothing real in between. Deliberately excluded
  // from isProtectedBlockName() (which also drives "mine"'s own deliberate-target refusal, with
  // an explicit "that's a placed/crafted block" message) rather than added there -- a bot
  // deliberately choosing to reclaim a stored netherite/diamond/iron block should still be able
  // to via "mine"; this only ever stops pathfinder from treating one as an incidental shortcut
  // while routing to somewhere else entirely.
  const HARDNESS_THRESHOLD = 10;
  for (const block of bot.registry.blocksArray) {
    if (typeof block.hardness === "number" && block.hardness >= HARDNESS_THRESHOLD) {
      movements.blocksCantBreak.add(block.id);
    }
  }
  // Direct request, 2026-10-07 ("never place a block that will impede access to a chest or bed or
  // door"). The actions.js placement sites are the deliberate half; this is the incidental one --
  // pathfinder's own scaffolding mechanic places a block to bridge a gap or pillar up, chosen by
  // the search with no idea what sits next to it, and it has already been caught consuming
  // inventory mid-travel (see §"a real one observed live" above). exclusionAreasPlace is
  // mineflayer-pathfinder's own documented hook for exactly this: a function per candidate
  // placement returning a cost, where >= 100 excludes it outright. Guarded rather than assumed --
  // this process must not fail to spawn over a vendor property that moved, and a missing hook
  // leaves only the scaffolding path uncovered, not any of the deliberate ones.
  if (Array.isArray(movements.exclusionAreasPlace)) {
    movements.exclusionAreasPlace.push((block) => (block?.position && wouldBlockAccess(bot, block.position) ? 100 : 0));
  } else {
    console.log(`[${USERNAME}] pathfinder has no exclusionAreasPlace -- scaffolding placements are unguarded`);
  }
  bot.pathfinder.setMovements(movements);
  installDoorSupport(bot); // swim-movements.js: doorway waypoints, never shut an open door
  installSteppedGoto(bot); // swim-movements.js: past the search limit, walk the partial path and search again
  // Real bug found live 2026-09-11 (direct report: "what's wrong with the bots now" -> repeated
  // "self-defense result: gave up on the fight -- took too long" against drowned specifically).
  // Confirmed by reading mineflayer-pvp's own source (lib/PVP.js, already read in full for the
  // 1.42.0 attack-resolution fix): its constructor builds its OWN separate, generic
  // `this.movements = new Movements(bot, mcData)`, and attack() calls
  // `pathfinder.setMovements(this.movements)` on every single invocation -- silently swapping the
  // bot's own swim-aware `movements` (set just above) back out for stock Movements, which "can
  // walk across open water but can never change depth once already in it" (swim-movements.js's
  // own header). A drowned mob living underwater was therefore never actually reachable during
  // "attack" specifically -- explains why this pattern never showed up against zombies/
  // skeletons/creepers, only drowned. Pointing bot.pvp's own movements reference at the SAME
  // SwimMovements instance makes every future attack() call re-apply the correct one.
  bot.pvp.movements = movements;

  // Real bug found live 2026-09-13 (direct report: 24h of logs show bots "can't use doors" and
  // are "generally ineffective even during the daytime when there are no monsters nearby").
  // canOpenDoors was already enabled above (2026-09-07) -- so the ORIGINAL claim just above this
  // comment ("every other action already used the correct swim-aware movements the whole time")
  // was simply wrong, never actually verified against every plugin. Confirmed by reading
  // mineflayer-collectblock's own source (lib/CollectBlock.js): its constructor builds the EXACT
  // same kind of separate, generic `this.movements = new Movements(bot)` mineflayer-pvp's own
  // fix just above already had to work around, and collect() -- called by both "mine" and
  // "explore," almost certainly the two most common daytime actions this fleet runs -- calls
  // `this.bot.pathfinder.setMovements(this.movements)` on EVERY SINGLE invocation. That silently
  // swapped the bot's own correctly-configured `movements` (canOpenDoors, swim-awareness,
  // blocksCantBreak) back out for a stock, unconfigured instance for the full duration of every
  // mining/exploring trip -- explaining doors specifically (undone every time a mining trip
  // crossed one) and plausibly a real share of the broader "ineffective" pattern (bulldozing
  // through functional blocks, refusing water crossings) during the single most common daytime
  // activity. Same fix shape as bot.pvp.movements just above: point collectBlock's own reference
  // at the SAME SwimMovements instance so every future collect() call re-applies the correct one.
  bot.collectBlock.movements = movements;

  // Direct follow-up to "what other logic enhancements are available" -> cave-pathfinding cap:
  // real evidence from tonight's own OOM crashes (hermes-minecraft-triage.py's own log) traced
  // to bot.pathfinder.searchRadius's DEFAULT VALUE OF -1 (confirmed in mineflayer-pathfinder's
  // own index.js/astar.js) -- "don't limit the search area" at all. thinkTimeout (default 5000ms)
  // only bounds wall-clock time, not how many node objects get allocated within that window --
  // in complex cave terrain, that was enough to hit 25,000+ visited nodes and exhaust the V8
  // heap before the timeout even fired.
  //
  // Lowered from 128 to 48, 2026-09-07 (chasing the same all-day recurring OOM the coder/coder2
  // triage service kept flagging): 128 bounded any ONE search, but not how OFTEN a search
  // reruns. Confirmed against mineflayer-pvp's own source: attack() sets a DYNAMIC GoalFollow
  // (pathfinder.setGoal(goal, true)) to chase its target, and mineflayer-pathfinder's own tick
  // loop calls resetPath('goal_moved') -- discarding the current search and starting a fresh one
  // -- every time stateGoal.hasChanged() is true, with no debounce of its own. Against an
  // erratically-flying target (a phantom, live evidence: 419 path_update lines in under 30
  // seconds fighting one, "goal_moved" the single largest reason), that's a fresh full search
  // firing on nearly every tick, each one visiting well into the thousands of nodes within the
  // old 128-block radius -- allocation pressure high enough to exhaust the heap in under a
  // minute even though each individual search was, technically, bounded. 48 still gives real
  // headroom over every real target distance this codebase asks for outside combat (mine/loot/
  // smelt/wander are all well under 64 blocks, and combat pursuit only ever needs to close a
  // much shorter gap than that) while directly cutting the cost of each of those rapid-fire
  // recomputes, since the recompute FREQUENCY itself isn't something this codebase can bound
  // without patching mineflayer-pvp/mineflayer-pathfinder directly.
  bot.pathfinder.searchRadius = 48;

  // Direct request, 2026-09-07 ("check the Firmament coder logs... yes... yes" -- three rounds
  // deep into the same all-day OOM). A real heap snapshot (--heapsnapshot-near-heap-limit, taken
  // automatically right before an actual crash) showed the dominant memory cost wasn't
  // pathfinding nodes at all -- it was ~2.5M V8 Context objects, ~1M Generators, ~1M Promises,
  // and 514,115 EACH of closures literally named step/fulfilled/rejected/adopt (the compiled
  // TypeScript `__awaiter` helper used by mineflayer-collectblock/-tool/-pvp). Tracing their
  // retainers confirmed they're rooted via (Stack roots)/(GC roots) -- genuinely PENDING
  // promises that never settled, not simply forgotten references. Root cause, confirmed against
  // astar.js's own compute(): it's a fully synchronous `while` loop, checked against elapsed
  // time only at the top of each iteration, bounded by tickTimeout (default 40ms per chunk) and
  // thinkTimeout (default 5000ms total ceiling) -- meaning a single hard search can legitimately
  // hog Node's single-threaded event loop in ~40ms synchronous chunks for up to 5 STRAIGHT
  // SECONDS, with negligible time handed back in between (live evidence matches exactly: 28
  // consecutive path_update lines each ~40-50ms apart, zero gap). While starved like that,
  // nothing else -- Buzz polling, Matrix, incoming Minecraft packets, any already-resolved
  // promise's own .then() -- gets a turn, so anything scheduled during that window piles up
  // unsettled. Repeated searches (goal_moved/block_updated kept re-triggering fresh ones) could
  // hit this ceiling over and over. Lowered thinkTimeout to 1000ms (real searches this codebase
  // asks for complete in well under 100ms per the very same live evidence; only the pathological
  // cases were ever hitting the old 5000ms ceiling) and tickTimeout to 20ms (smaller synchronous
  // chunks, more frequent opportunities for the event loop to interleave other work between
  // them) to bound the worst case far short of where it was.
  bot.pathfinder.thinkTimeout = 1000;
  bot.pathfinder.tickTimeout = 20;

  // Real-data visibility into navigation, not a guess: astar's own result status
  // ('success'/'partial'/'noPath'/'timeout') for every path (re)computation, so a bad
  // goto/follow (doors, ladders, stairs -- direct report, 2026-09-06) can be diagnosed from
  // what pathfinder itself actually concluded, the same evidence-based approach that found
  // every other real bug this build. Kept permanently, not stripped after one use --
  // correctness/diagnosability over minimizing log volume, per direct instruction.
  let lastPathToBreak = null;
  bot.on("path_update", (r) => {
    console.log(`[${USERNAME}] path_update status=${r.status} nodes=${r.path?.length ?? 0} ` +
                `visited=${r.visitedNodes ?? "?"} cost=${r.cost?.toFixed?.(1) ?? "?"} ` +
                `time=${r.time?.toFixed?.(0) ?? "?"}ms`);
    lastPathToBreak = r.path && r.path.length ? r.path[0].toBreak : null;
  });
  bot.on("goal_reached", () => console.log(`[${USERNAME}] goal_reached`));

  // Live diagnostic added alongside the burst detector below, 2026-09-21: mineflayer-pathfinder
  // discards the REAL reason bot.dig() rejected (`.catch(_ignoreError => resetPath('dig_error'))`
  // -- see the burst-detector comment just below), so which block and why has been pure
  // speculation ("a teammate's hitbox in the way" was the leading guess, not a confirmed cause).
  // This logs the actual target block (type, position, distance) plus every other bot within 3
  // blocks of it the moment a dig_error fires, straight from `path_update`'s own `toBreak` list
  // (captured just above) -- enough to confirm or rule out the crowding theory, or surface
  // something else entirely (wrong tool, block already gone, out of reach) from real evidence
  // instead of another guess.
  bot.on("path_reset", (reason) => {
    if (reason !== "dig_error" || !lastPathToBreak || !lastPathToBreak.length) return;
    const pos = lastPathToBreak[0];
    const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    const dist = bot.entity.position.distanceTo(pos);
    const nearby = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position && e.position.distanceTo(pos) < 3)
      .map((e) => `${e.username || e.name}@${e.position.distanceTo(pos).toFixed(1)}`);
    console.log(`[${USERNAME}] dig_error target: ${block?.name ?? "?"} at (${pos.x},${pos.y},` +
                `${pos.z}) dist=${dist.toFixed(2)} nearbyEntities=[${nearby.join(", ")}]`);
  });

  // Direct live follow-up ("they can't get out of the home"), 2026-09-21: §47's digCost fix
  // (30->5) made a real path findable again where the search cost ceiling had previously
  // pruned it outright -- confirmed live, Luke's own path_update went from permanent noPath to
  // status=success cost=24.5. But finding the path isn't the same as walking it: mineflayer-
  // pathfinder's own move-execution code (index.js: `bot.dig(block, true).catch(_ignoreError =>
  // resetPath('dig_error'))`) SWALLOWS whatever the real dig failure was and just tears the
  // path down -- with nothing about the world having changed, the very next tick recomputes the
  // IDENTICAL path and hits the IDENTICAL dig failure again. Live evidence matches exactly:
  // Luke logged the same path_update status=success/cost=24.5 dozens of times within about one
  // second, each immediately followed by path_reset: dig_error, a true infinite tight loop (not
  // merely slow -- ACTION_TIMEOUT_MS would eventually cut off any ONE attempt, but the very next
  // attempt just re-enters the same trap, so functionally she never leaves). §42 already solved
  // this exact failure shape once, but only for "flee" (disabling canDig for that one action's
  // own goto before it runs) -- gohome and every other pathfinder.goto() call site never got the
  // same protection, so any of them can fall into it whenever their found route happens to
  // require a dig that keeps failing. The real per-block reason is invisible to us (the plugin
  // discards it), but with 7 bots packed into one ~2x5 shelter, a teammate's own hitbox blocking
  // line of sight to the target block is the leading suspect -- not that it matters: this
  // defends against the SYMPTOM regardless of cause, the same pragmatic choice digCost/liquidCost
  // already made. Fix: watch for a burst of dig_error resets in a short window and temporarily
  // force canDig off so the very next recompute is walk-only -- a real building hit by this
  // almost always still has a door-based route, which is exactly what direct reports have asked
  // for over digging anyway. Restore is timestamp-gated (only fires if nothing re-armed a longer
  // suppression since) so it can't race a newer burst's own restore.
  const DIG_ERROR_BURST_THRESHOLD = 4;
  const DIG_ERROR_BURST_WINDOW_MS = 3000;
  const DIG_DISABLE_COOLDOWN_MS = 15000;
  let digErrorTimestamps = [];
  let digSuppressedUntil = 0;
  bot.on("path_reset", (reason) => {
    console.log(`[${USERNAME}] path_reset: ${reason}`);
    if (reason !== "dig_error") return;
    const now = Date.now();
    digErrorTimestamps.push(now);
    digErrorTimestamps = digErrorTimestamps.filter((t) => now - t < DIG_ERROR_BURST_WINDOW_MS);
    if (digErrorTimestamps.length < DIG_ERROR_BURST_THRESHOLD) return;
    digErrorTimestamps = [];
    digSuppressedUntil = now + DIG_DISABLE_COOLDOWN_MS;
    if (movements.canDig) {
      console.log(`[${USERNAME}] dig_error burst -- forcing walk-only pathing for ` +
                  `${DIG_DISABLE_COOLDOWN_MS}ms`);
      movements.canDig = false;
    }
    setTimeout(() => {
      if (Date.now() >= digSuppressedUntil) movements.canDig = true;
    }, DIG_DISABLE_COOLDOWN_MS);
  });
  return movements;
}
