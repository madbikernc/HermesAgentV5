// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: sleep, dusk, emergency health, drowning and sleeping-threat helpers.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { performAction } from "./actions.js";
import * as arbiter from "./arbiter.js";
import { SELF_DEFENSE_RANGE, attackAsLastResort, decideFightType, fleeAsLastResort, nearestRallyPoint, noteThreatSeen, pickThreat } from "./self-defense.js";
import { narrateAction } from "./chat.js";
import { bedsNearHome, wantBed } from "./gear-goals.js";
import { routineBlocked } from "./goal-proposal.js";
import { AUTONOMY_ENABLED, BOT_USERNAMES, USERNAME, bot, currentGoal, goals, isAnotherBot } from "./index.js";


// Direct request (2026-09-07): "the bots need to know to go to sleep at night." Deliberately a
// plain deterministic check on its own timer, not folded into goalTick's model-driven loop --
// "is it night" needs no reasoning, just bot.time.timeOfDay (the exact window bed.js's own
// bot.sleep() already enforces, matched here so this never tries when sleep() would just reject
// anyway). Uses the same busy/acting mutex as everything else, so it never fires mid-command and
// a live command always interrupts it (actions.js's stopCurrent() forces a wake for that).
export const SLEEP_CHECK_MS = parseInt(process.env.MC_SLEEP_CHECK_MS || "30000", 10);
// Review MB-14, 2026-09-24: the night used to be one-shot intent -- the "tried tonight" flags were
// set before control was even acquired, so a failed or preempted trip home or bed attempt was
// never retried, and dusk abandoned the standing goal (even a player's) before trying to leave.
// Now each nightly step records success, retries a bounded number of times with spacing (so a
// bed-less bot still doesn't spam chat all night), and dusk only PAUSES goals -- goalTick skips
// work during the night phase and picks the same goal back up in the morning.
const NIGHT_RETRY_MS = 2 * 60_000;
const MAX_NIGHT_ATTEMPTS = 3;
const nightStep = () => ({ done: false, attempts: 0, lastAt: 0 });
let sleepTonight = nightStep();
let homeTonight = nightStep();

// True if a nightly step should be tried now; false once done, out of attempts, or too soon.
function nightStepDue(step) {
  return !step.done && step.attempts < MAX_NIGHT_ATTEMPTS && Date.now() - step.lastAt >= NIGHT_RETRY_MS;
}

export async function checkSleep() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkSleep") || bot.isSleeping) return;

  const thunderstorm = bot.isRaining && bot.thunderState > 0;
  const isNight = thunderstorm || (bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458);
  if (!isNight) {
    sleepTonight = nightStep();
    return;
  }
  if (!nightStepDue(sleepTonight)) return;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note on why an
  // idle-tick physical action shouldn't block handleIncoming's `busy` check. The arbiter's
  // OWNERS.ROUTINE tier alone still prevents another idle-tick action from starting while this
  // one runs (coherence arbiter Phase 4, 2026-09-10).
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  sleepTonight.attempts += 1;
  sleepTonight.lastAt = Date.now();
  try {
    if (sleepTonight.attempts === 1) bot.chat(await narrateAction("getting sleepy -- heading to bed."));
    const result = await performAction(bot, { type: "sleep" }, USERNAME, handle);
    console.log(`[${USERNAME}] sleep (attempt ${sleepTonight.attempts}): ${result.text} (ok=${result.ok})`);
    if (result.ok) sleepTonight.done = true;
    // No bed at all, or beds but none free (occupied, hazardous, unreachable) while home has
    // fewer beds than bots (2026-09-27: with five beds taken, spark2's four bots only ever saw
    // "found beds nearby, but couldn't use any").
    if (!result.ok && !result.cancelled && (/couldn't find a bed/.test(result.text) ||
        (/found beds nearby, but couldn't use any/.test(result.text) && bedsNearHome() < BOT_USERNAMES.size))) await wantBed();
    if (!result.cancelled && (result.ok || sleepTonight.attempts >= MAX_NIGHT_ATTEMPTS)) {
      bot.chat(await narrateAction(result.ok ? result.text : `couldn't get to sleep: ${result.text}`));
    }
  } catch (err) {
    console.error(`[${USERNAME}] sleep check failed:`, err.message);
  } finally {
    handle.release();
  }
}

// Direct request, 2026-09-07: "bots should pay attention to the time of day, and try to return
// 'home' before full dark." Plain deterministic check on its own timer, same shape as
// checkSleep just above -- "is dusk approaching" needs no reasoning, just bot.time.timeOfDay.
// DUSK_START_TICK (10000) is set well before checkSleep's own 12541 (the exact tick bed.js's
// bot.sleep() actually becomes usable, matched there so sleep never tries early) specifically so
// she has real travel time to walk home -- roughly 2500 ticks/~127 real seconds of buffer,
// generous over any real distance searchRadius (48 blocks) ever puts her at from a normal
// day's wandering -- rather than only noticing once it's already the sleep-eligible window.
// "home" is bot.spawnPoint (actions.js's new "gohome" action) -- the same real reference the
// teleport-when-stuck mechanism already uses, not a second notion of home.
export const DUSK_CHECK_MS = parseInt(process.env.MC_DUSK_CHECK_MS || "30000", 10);
const DUSK_START_TICK = parseInt(process.env.MC_DUSK_START_TICK || "10000", 10);
const DAWN_TICK = 23458; // same boundary checkSleep uses for "no longer night"
let nightStartedAt = 0; // wall-clock start of the current dusk-to-dawn phase, 0 during the day

function isNightPhase() {
  const t = bot.time?.timeOfDay;
  return t !== undefined && t >= DUSK_START_TICK && t < DAWN_TICK;
}

// goalTick's night rule: goals are paused from dusk to dawn, except one a real player set during
// this same night (they asked for it knowing it's dark) -- Mayor assignments wait for morning.
export function goalPausedForNight(goal) {
  if (!isNightPhase()) return false;
  const playerSetTonight = goal && goal.setBy && !isAnotherBot(goal.setBy) &&
    nightStartedAt && goal.createdAt >= nightStartedAt;
  return !playerSetTonight;
}

export async function checkDusk() {
  if (!bot.time) return;
  if (!isNightPhase()) {
    if (nightStartedAt && currentGoal) console.log(`[${USERNAME}] morning -- resuming goal: ${currentGoal.description}`);
    nightStartedAt = 0;
    homeTonight = nightStep();
    return;
  }
  if (!nightStartedAt) {
    nightStartedAt = Date.now();
    if (currentGoal) console.log(`[${USERNAME}] dusk -- pausing goal until morning: ${currentGoal.description}`);
  }
  if (!AUTONOMY_ENABLED || routineBlocked("checkDusk") || bot.isSleeping) return;
  if (!nightStepDue(homeTonight)) return;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  homeTonight.attempts += 1;
  homeTonight.lastAt = Date.now();
  try {
    if (homeTonight.attempts === 1) bot.chat(await narrateAction("sun's getting low -- heading home before dark."));
    const result = await performAction(bot, { type: "gohome" }, USERNAME, handle);
    console.log(`[${USERNAME}] heading home (attempt ${homeTonight.attempts}): ${result.text} (ok=${result.ok})`);
    if (result.ok) homeTonight.done = true;
  } catch (err) {
    console.error(`[${USERNAME}] heading home failed:`, err.message);
  } finally {
    handle.release();
  }
}

// A sighting older than this is too stale to blame for THIS death -- e.g. a zombie noticed a
// minute ago that wandered off before something else (fall, drowning, a different mob she never
// saw) actually killed her. "unknown" is the honest answer once lastKnownThreat ages out.
export const DEATH_THREAT_ATTRIBUTION_MS = 10_000;

// True mid-action self-defense interrupt (direct request, 2026-09-07: "do all" -- explicitly
// deferred when self-defense first shipped as "a bigger design decision"). checkSelfDefense()'s
// own idle-tick version only ever runs BETWEEN actions; this fires in real time off mineflayer's
// own 'health' event so a bot mid-mine doesn't just keep swinging while a creeper closes in.
// Deliberately does NOT try to make every existing busy/acting call site aware of an external
// override (a much bigger, riskier refactor) -- instead, force-cancels whatever's physically
// happening RIGHT NOW using the exact same primitives actions.js's own stopCurrent() calls
// (safe, idempotent, a no-op if nothing's running), which makes the interrupted call's own
// promise settle almost immediately; THEN waits (briefly, bounded) for its normal finally block
// to release busy/acting on its own before running the real flee through the standard safe path.
export const EMERGENCY_HEALTH_THRESHOLD = 6; // out of 20 -- stricter than checkSelfDefense's idle 10,
                                       // reserved for genuine near-death, not routine caution
let emergencyInFlight = false;

// Direct request, 2026-09-21 ("re-evaluate the entire defense scheme"), root-caused from a live
// mass-death incident: 5 bots died within ~90 seconds, several of them multiple times in quick
// succession. Confirmed live via Wade's own logs: "self-defense: yielded to (HEALTH_CRITICAL)"
// repeated for over 20 STRAIGHT seconds -- a single EMERGENCY-triggered "attack" (mandatory at
// critical health, no exceptions) holding the arbiter's highest real-combat tier that whole time,
// with nothing able to preempt it and no way for the bot herself to reconsider whether the fight
// was actually going anywhere. The standard ACTION_TIMEOUT_MS (90s) is far too generous a leash
// for a bot who's already at 6 HP or below -- she doesn't have 90 seconds of margin to lose while
// finding out a fight isn't working. A short, bounded window instead: if the target isn't dead by
// then, fleeAsLastResort() (below) takes over rather than continuing to slug it out blind.
const EMERGENCY_ATTACK_TIMEOUT_MS = 8_000;

export function onEmergencyHealth() {
  if (!AUTONOMY_ENABLED || emergencyInFlight) return;
  if (bot.health <= 0 || bot.health > EMERGENCY_HEALTH_THRESHOLD) return;
  const threat = pickThreat(SELF_DEFENSE_RANGE);
  if (!threat) return;

  emergencyInFlight = true;
  // Direct request, 2026-09-21 ("Soldiers fight *always*, others fight when under half health").
  // This handler only ever fires at EMERGENCY_HEALTH_THRESHOLD (6) or below -- always "under
  // half health" by definition -- so it used to hardcode an unconditional flee regardless of
  // role, the one place decideFightType()'s own rule wasn't actually applied. Now it is: a
  // Soldier fights here too, and so does anyone else, since being this hurt is exactly the
  // "under half health" condition that rule fights on. FLEE_ONLY_MOBS/no-weapon still flee.
  const type = decideFightType(threat);
  console.log(`[${USERNAME}] EMERGENCY: health critical (${bot.health}) with ${threat.name} ` +
              `nearby -- force-cancelling current action to ${type}`);
  noteThreatSeen(threat.name);
  // Real gap found live, 2026-09-07 ("they don't seem to be fighting back... when woken up from
  // sleeping"): the force-cancel primitives alone don't touch sleep. The in-flight "sleep"
  // performAction call holds control for its ENTIRE duration (until the real 'wake' event or
  // SLEEP_TIMEOUT_MS, up to 15 minutes) -- while she's actually asleep, a forced flee attempt
  // can't move her (the avatar is pinned in bed), and this handler's own wait-then-force-through
  // logic below would just collide with sleep's own still-pending cleanup instead of freeing it.
  // bot.wake() lets sleep's own existing bot.once("wake", finish) listener resolve it and
  // release control normally.
  if (bot.isSleeping) {
    bot.wake().catch((err) => console.error(`[${USERNAME}] emergency wake failed:`, err.message));
  }

  // Direct request, 2026-09-10 (coherence-arbiter Phase 2). This was the one duplicated copy of
  // the 4-primitive cancel block that was missing bot.stopDigging() -- arbiter.requestControl()
  // always includes it (see arbiter.js's own cancelPhysical()), closing that real, live
  // inconsistency as a direct consequence of migrating rather than a separate fix.
  (async () => {
    const handle = await arbiter.requestControl(bot, arbiter.OWNERS.HEALTH_CRITICAL);
    if (!handle) {
      console.log(`[${USERNAME}] EMERGENCY: yielded to something more urgent ` +
                  `(${arbiter.currentOwner()})`);
      emergencyInFlight = false;
      return;
    }
    try {
      const rallyPoint = type === "flee" ? await nearestRallyPoint(bot) : null;
      // EMERGENCY_ATTACK_TIMEOUT_MS (not the standard ACTION_TIMEOUT_MS -- see its own comment
      // just below): a fight this bot is already losing badly enough to be at critical health
      // gets one short, bounded shot, not a 90-second commitment with no way to reconsider.
      const maxDurationMs = type === "attack" ? EMERGENCY_ATTACK_TIMEOUT_MS : undefined;
      const result = await performAction(bot, { type, target: threat, rallyPoint, maxDurationMs },
        USERNAME, handle);
      console.log(`[${USERNAME}] emergency ${type}: ${result.text} (ok=${result.ok})`);
      if (type === "flee" && !result.ok && !result.cancelled) await attackAsLastResort(threat, "emergency", handle);
      if (type === "attack" && !result.ok && !result.cancelled) await fleeAsLastResort(threat, "emergency", handle);
    } catch (err) {
      console.error(`[${USERNAME}] emergency ${type} failed:`, err.message);
    } finally {
      handle.release();
      emergencyInFlight = false;
    }
  })();
}

// Direct request, 2026-09-07 ("they need to know how to swim"). Real, confirmed gap: nothing in
// this file ever watched bot.oxygenLevel -- movements.liquidCost's own comment above already
// documents a live incident ("Amy drowned repeatedly because her death spot ... sat right at
// open water"), but that fix only ever discourages PATHFINDER route choice; it does nothing once
// a bot is actually submerged and running low on air for any other reason (fell in, a
// gohome/goal route crossed open water, chased into a lake while fleeing). mineflayer-pathfinder
// itself can never generate a "swim to the surface" move on its own -- confirmed against its own
// movements.js: getMoveUp() unconditionally refuses once already in liquid ("if (block1.liquid)
// return"), so resurfacing can never come from the path search itself, no matter the settings.
// bot.oxygenLevel (mineflayer's own entities.js, real server-tracked air supply 0-20, matching
// the vanilla bubble meter) and the real 'breath' event it fires on every change give a direct,
// verified hook; confirmed against prismarine-physics's own tick loop that holding the jump
// control while entity.isInWater adds upward velocity every tick (vel.y += 0.04) -- the same
// real mechanic a player uses to swim up, not a guess. Deliberately just a vertical surfacing
// reflex, not full swim-to-shore navigation -- a bigger feature than "don't drown" needed.
const DROWNING_OXYGEN_THRESHOLD = 4; // out of ~20 -- drowning damage only starts once air
                                      // actually hits 0, so this leaves a few real seconds of
                                      // margin, same "stricter than routine caution" reasoning
                                      // as EMERGENCY_HEALTH_THRESHOLD above
const SURFACE_SWIM_TIMEOUT_MS = 8000; // bounded -- never hold jump forever if something's wrong

// Direct report, 2026-09-08 ("they get in water, jump to come up, but do not ever try to reach
// land"): confirmed real -- the surfacing reflex above only ever answers "don't drown right
// now"; once oxygen recovered, nothing steered her anywhere, so she'd just keep floating (or
// sink again the moment something else needed her attention) exactly where she surfaced. This
// genuinely couldn't have worked when the surfacing reflex first shipped: mineflayer-pathfinder
// refused to generate any vertical move while already in liquid, so a goto() call from inside
// open water had no way to route out at all. swim-movements.js's own SwimMovements (shipped the
// same night, separately) is what makes this possible now -- getMoveUp()/getMoveDown() no
// longer refuse in water, so a normal pathfinder goal can actually find a way to shore.
// findNearestShore() can't match by block type (land isn't one block id) -- it scans for a
// column where the space to stand IN is open/non-liquid and the block below it is solid,
// non-liquid ground, using bot.findBlocks()'s own function-matcher path (confirmed sorted
// nearest-first by mineflayer's own blocks.js, not assumed).
const SHORE_SEARCH_DISTANCE = 48; // matches bot.pathfinder.searchRadius's own OOM-safety cap
                                   // from tonight's earlier investigation -- no point finding a
                                   // "shore" pathfinder could never actually route to anyway
const SHORE_TRAVEL_TIMEOUT_MS = 20_000;
let drowningInFlight = false;

// 2026-11-04 (direct report: "the bots do not seem to be able to get out of water"): mineflayer
// 4.39's entity_metadata handler sets bot.oxygenLevel from ANY entity's air_supply and emits
// 'breath' for it -- a squid, fish or dolphin nearby drove her drowning emergency (Babs: 124 in 4
// minutes, each "surfaced (oxygen=296)", a dolphin's 4440 ticks / 15). Her own air is her own
// entity's metadata, index 1, in ticks (0-300), on the same 0-20 scale.
function ownOxygenLevel() {
  const air = bot.entity?.metadata?.[1];
  return typeof air === "number" ? Math.round(air / 15) : 20;
}

// In water, or just above it with water at her feet or under them.
function atWater() {
  if (bot.entity.isInWater) return true;
  const at = bot.entity.position?.floored?.();
  return !!at && [0, -1].some((dy) => /^(water|bubble_column)$/.test(bot.blockAt(at.offset(0, dy, 0))?.name ?? ""));
}

function findNearestShore(bot, maxDistance) {
  // Real bug found live (2026-09-08): block.position was null for some candidate blocks
  // findBlocks() itself handed in (bot.blockAt() can return a Block missing this even when the
  // Block itself isn't null -- an edge the block-scanning code elsewhere in this file never hit
  // since it always calls blockAt() on a position IT already has, never a position handed back
  // TO it by the search). Defensive on both the block and its position now, not just liquid
  // checks that never actually threw.
  const positions = bot.findBlocks({
    maxDistance,
    count: 1,
    // 2026-11-04: findBlocks first asks this about each section's palette, as blocks with no
    // position (Block.fromStateId) -- returning false there skipped every section, so no shore was
    // ever found (490 "couldn't find dry land" in 14 days, not one "heading for dry land"). A
    // position-less block gets the cheap half of the test.
    // 2026-11-06: by name, not block.liquid -- mineflayer's Block has no such property, so a water
    // block over sand read as air over dry ground and the "shore" was the sea floor (Dale: "heading
    // for dry land at (-158, 54, -75)", sea level 63, then No path, ~300 times in an hour).
    matching: (block) => {
      if (!block || isWet(block) || block.boundingBox === "block") return false;
      if (!block.position) return true;
      const below = bot.blockAt(block.position.offset(0, -1, 0));
      const above = bot.blockAt(block.position.offset(0, 1, 0));
      return !!below && !isWet(below) && below.boundingBox === "block" &&
        !!above && !isWet(above) && above.boundingBox !== "block";
    },
  });
  return positions[0] || null;
}

const WET_BLOCK_NAMES = new Set(["water", "bubble_column", "kelp", "kelp_plant", "seagrass", "tall_seagrass", "lava"]);
function isWet(block) {
  return WET_BLOCK_NAMES.has(block.name) || block.getProperties?.().waterlogged === true;
}

export function onLowBreath() {
  if (!AUTONOMY_ENABLED || drowningInFlight) return;
  if (!bot.entity.isInWater || ownOxygenLevel() > DROWNING_OXYGEN_THRESHOLD) return;

  drowningInFlight = true;
  console.log(`[${USERNAME}] EMERGENCY: oxygen critical (${ownOxygenLevel()}) -- force-cancelling ` +
              `current action to surface`);

  // Direct request, 2026-09-10 (coherence-arbiter Phase 2 -- see checkSelfDefense's own
  // migration note above for the full account). DROWNING sits below HEALTH_CRITICAL in the
  // arbiter's own priority order: oxygen-critical banks several real seconds of margin before
  // drowning damage actually starts (this handler's own DROWNING_OXYGEN_THRESHOLD comment), so a
  // brief wait behind a genuine near-death flee costs nothing real.
  (async () => {
    const handle = await arbiter.requestControl(bot, arbiter.OWNERS.DROWNING);
    if (!handle) {
      console.log(`[${USERNAME}] EMERGENCY: oxygen response yielded to something more urgent ` +
                  `(${arbiter.currentOwner()})`);
      drowningInFlight = false;
      return;
    }
    try {
      bot.setControlState("jump", true);
      const surfaceDeadline = Date.now() + SURFACE_SWIM_TIMEOUT_MS;
      // Keep holding jump until oxygen is actually recovering (a reliable sign her head cleared
      // the surface) rather than just "not in water anymore" -- isInWater stays true while
      // floating right at the surface, so that alone would release control too early.
      while (bot.entity.isInWater && ownOxygenLevel() <= DROWNING_OXYGEN_THRESHOLD + 2 &&
             Date.now() < surfaceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      console.log(`[${USERNAME}] surfaced (oxygen=${ownOxygenLevel()}, stillInWater=${bot.entity.isInWater})`);
      bot.setControlState("jump", false);

      // Surviving the dunk isn't the same as being somewhere sensible -- head for the nearest
      // real dry land now that the pathfinder can actually generate a route out of water.
      // 2026-11-05: still at water, not just isInWater -- bobbing at the surface of a deep pool,
      // isInWater reads false for the tick her jump lifts her out, so the shore search was skipped
      // and she sank again (live: four emergencies in a row, no "heading for dry land").
      if (atWater() && arbiter.holdsControl(handle)) { // MB-02: a higher tier may own her now
        const shore = findNearestShore(bot, SHORE_SEARCH_DISTANCE);
        if (!shore) {
          console.log(`[${USERNAME}] surfaced but couldn't find dry land within ${SHORE_SEARCH_DISTANCE} blocks`);
        } else {
          console.log(`[${USERNAME}] heading for dry land at`, shore);
          let timedOut = false;
          const timer = setTimeout(() => { timedOut = true; if (arbiter.holdsControl(handle)) bot.pathfinder.setGoal(null); }, SHORE_TRAVEL_TIMEOUT_MS);
          try {
            await bot.pathfinder.goto(new goals.GoalNear(shore.x, shore.y, shore.z, 1));
          } catch (err) {
            if (!timedOut && !handle.token.cancelled) console.error(`[${USERNAME}] couldn't reach shore:`, err.message);
          } finally {
            clearTimeout(timer);
            if (arbiter.holdsControl(handle)) bot.pathfinder.setGoal(null);
          }
          console.log(`[${USERNAME}] reached shore attempt finished (isInWater=${bot.entity.isInWater})`);
        }
      }
    } catch (err) {
      console.error(`[${USERNAME}] surfacing failed:`, err.message);
    } finally {
      bot.setControlState("jump", false);
      handle.release();
      drowningInFlight = false;
    }
  })();
}

// Direct request, 2026-09-07 ("they don't seem to be fighting back... when woken up from
// sleeping"). Real gap: EVERY idle-tick check (checkSelfDefense included) is gated by the
// busy/acting mutex, and "sleep"'s own performAction call holds that mutex for its ENTIRE
// duration -- so until now, NOTHING but the emergency health-triggered interrupt above could
// react to a threat while she was actually asleep, and that one only ever fires once health has
// ALREADY dropped to a near-death threshold. A hostile that wanders up to a sleeping bot got to
// hit her repeatedly, completely unopposed, until she was nearly dead or happened to wake
// naturally. This check runs on its own short timer, deliberately bypassing busy/acting
// (checkStuck's own precedent) for the one case nothing else can reach: the moment a hostile is
// nearby while she's asleep, wake her up and respond exactly like checkSelfDefense normally
// would (flee below half health, otherwise fight) -- proactively, not just as a last resort.
export const SLEEPING_THREAT_CHECK_MS = parseInt(process.env.MC_SLEEPING_THREAT_CHECK_MS || "5000", 10);

export async function checkSleepingThreat() {
  if (!AUTONOMY_ENABLED || !bot.isSleeping) return;
  const threat = pickThreat(SELF_DEFENSE_RANGE);
  if (!threat) return;

  console.log(`[${USERNAME}] threat while sleeping (${threat.name}) -- waking up to respond`);
  noteThreatSeen(threat.name);
  try {
    await bot.wake();
  } catch (err) {
    console.error(`[${USERNAME}] force-wake failed:`, err.message);
    return;
  }
  // Direct request, 2026-09-10 (coherence-arbiter Phase 2). requestControl() itself replaces the
  // old fixed-250ms-pause-then-single-check -- the in-flight "sleep" action's own wake listener
  // needs a moment to resolve and release control naturally, and requestControl()'s own
  // wait-and-retry loop (up to 3000ms) is a real robustness improvement over a single check that
  // just gave up if sleep's cleanup hadn't finished in exactly 250ms. Reuses SELF_DEFENSE's own
  // tier -- mechanically identical attack/flee decision, just reached via a different trigger.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.SELF_DEFENSE);
  if (!handle) {
    console.log(`[${USERNAME}] post-wake defense: yielded to something more urgent ` +
                `(${arbiter.currentOwner()})`);
    return;
  }
  try {
    // See checkSelfDefense's own 2026-09-10/2026-09-15 notes and decideFightType()'s own header
    // (actions.js's FLEE_ONLY_MOBS) -- a flyer is never worth attacking regardless of health, and
    // neither is anything else when she has no weapon to fight it with.
    const type = decideFightType(threat);
    const rallyPoint = type === "flee" ? await nearestRallyPoint(bot) : null;
    const result = await performAction(bot, { type, target: threat, rallyPoint }, USERNAME, handle);
    console.log(`[${USERNAME}] post-wake defense: ${type} -> ${result.text} (ok=${result.ok})`);
    if (type === "flee" && !result.ok && !result.cancelled) await attackAsLastResort(threat, "post-wake defense", handle);
  } catch (err) {
    console.error(`[${USERNAME}] post-wake defense failed:`, err.message);
  } finally {
    handle.release();
  }
}
