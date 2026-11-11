// Version: 1.0.0
//
// 1.0.0 (2026-11-10) -- split out of index.js (2.140.0) unchanged: self-defense (fight or flee,
// last-resort attack/flee, the outnumbered and creeper rules), threat memory, squad response
// and rally points. Its own file, under the self-repair pipeline's 40000-char whole-file limit.
// index.js calls installSelfDefense() once at startup; everything else here is functions and
// constants it imports. Reads bot, USERNAME and a few settings back from index.js (a cycle that
// is safe because nothing here touches them until installSelfDefense() runs).

import { FLEE_ONLY_MOBS, HOSTILE_MOBS, nearestFriendlyGolem, nearestHostile, performAction } from "./actions.js";
import { hasWeapon } from "./equipment.js";
import * as arbiter from "./arbiter.js";
import { guardedInterval } from "./faults.js";
import { BOT_ROLES, ROLES } from "./roles.js";
import { AUTONOMY_ENABLED, BOT_USERNAMES, EMERGENCY_HEALTH_THRESHOLD, USERNAME, bot, broadcastThreatAlert, goals, myRole } from "./index.js";

// Fourth of five scoped enhancements, direct follow-up to "what other logic enhancements are
// available" -> self-defense. checkSelfDefense() itself is now a true mid-action interrupt
// (2026-09-08, see its own header comment), not the idle-tick version this comment originally
// described -- but real live testing of THAT fix found a second, separate gap worth fixing at
// the same time: a zombie that spawned right next to Babs killed her in about 7 seconds, right
// at the edge of this interval's own old 7000ms value, meaning the routine check may not have
// gotten a single turn before she died, independent of the acting-gate bug. Lowered to 2000ms --
// a melee mob hits roughly once a second at adjacent range, so this now gets at least 2-3
// chances to react within a typical short encounter instead of maybe zero.
const SELF_DEFENSE_CHECK_MS = parseInt(process.env.MC_SELF_DEFENSE_CHECK_MS || "2000", 10);
// Out of a max of 20 -- flee rather than fight once she's below half health with a threat
// actually nearby, same "correctness over guessing" reasoning as everywhere else tonight: an
// exact threshold beats a vague "if hurt." Now env-configurable (direct request, 2026-09-07:
// "ask Muse to spawn two more bots... military oriented profiles, priority towards arming
// themselves and defending the spawn point") so a combat-postured bot (Mark/Luke) can run a
// lower flee threshold and a wider detection range than the default -- same code, per-bot tuning
// via each unit's own Environment= lines, no behavior change for Babs/Amy who don't set these.
export const SELF_DEFENSE_RANGE = parseInt(process.env.MC_SELF_DEFENSE_RANGE || "12", 10);

// Direct request, 2026-09-21 ("if truly unable to flee, they should all fight. Soldiers fight
// *always*, others fight when under half health"). Replaces the flat SELF_DEFENSE_FLEE_HEALTH
// threshold (a single number, previously tuned per-bot only via each unit's own env override --
// see the retired MC_SELF_DEFENSE_FLEE_HEALTH, now superseded) with an explicit role-based rule.
// A Soldier's whole job is fighting, so health alone never sends her running; anyone else avoids
// a fight while healthy (better spent doing her actual role) but stops retreating and finishes it
// once she's already hurt badly enough for it to matter. FLEE_ONLY_MOBS and no-weapon still
// override both roles -- those aren't a courage judgment call, they're a genuine inability to
// land a hit (see FLEE_ONLY_MOBS's own header in actions.js).
const HALF_HEALTH = 10; // out of a max of 20

// Direct live follow-up, 2026-09-21 ("they still wont fight back when pressured... a single
// zombie... systematically attacking them, with no reprisals"). Confirmed live: a healthy bot
// (Mayor, 16-20 HP -- well above HALF_HEALTH) can get re-engaged by the SAME zombie every ~2s
// (SELF_DEFENSE_CHECK_MS) in a cramped space, "successfully" fleeing every single time -- a few
// blocks of separation isn't real safety when the zombie closes it again before the next check --
// so she never takes enough CUMULATIVE damage to cross the health threshold above, and never
// escalates, for minutes at a stretch. That is "truly unable to flee" in every way that actually
// matters, even though each individual flee call itself reports ok=true. Tracks consecutive flee
// decisions and escalates to fighting once they pile up, same reasoning as attackAsLastResort's
// own header just below -- resets on any attack (the cycle's broken) or once enough real time has
// passed since the last one that it's clearly a new, unrelated encounter, not the same standoff.
const CONSECUTIVE_FLEE_ESCALATE_AFTER = 3;
const CONSECUTIVE_FLEE_RESET_MS = 15_000;
let consecutiveFleeCount = 0;
let lastFleeDecisionAt = 0;
// Fight-or-flee policy, decided 2026-09-25 (the review deferred it until combat worked). Live data
// from the first ~8h with working combat: deaths fell from ~1,700 to 18 per 8h on spark,
// emergency attacks mostly win, and the remaining mob deaths are pillagers/zombies. So an armed bot
// still fights a single melee or ranged threat (closing on an archer beats running from arrows in
// the open), but:
//   - outnumbered at critical health (2+ hostiles within OUTNUMBERED_RADIUS) -> flee, any role
//   - outnumbered by 3+ at any health -> flee, unless a Soldier
//   - a creeper within CREEPER_FLEE_RANGE -> flee (meleeing it means eating the blast)
// The threat itself is the mob that just hurt this bot when known (pickThreat), not merely the
// nearest one. Measured by tests/baseline.mjs's deaths_per_bot_day and attack_win_rate.
const OUTNUMBERED_RADIUS = 8;
const CREEPER_FLEE_RANGE = 5;

function hostilesWithin(radius) {
  const here = bot.entity?.position;
  if (!here) return 0;
  return Object.values(bot.entities).filter((e) => HOSTILE_MOBS.has(e.name) &&
    e.position.distanceTo(here) <= radius).length;
}

export function decideFightType(threat) {
  const threatName = threat.name;
  if (FLEE_ONLY_MOBS.has(threatName) || !hasWeapon(bot)) return "flee";
  if (threatName === "creeper" && bot.entity &&
      threat.position.distanceTo(bot.entity.position) <= CREEPER_FLEE_RANGE) return "flee";
  const nearby = hostilesWithin(OUTNUMBERED_RADIUS);
  if (nearby >= 2 && bot.health <= EMERGENCY_HEALTH_THRESHOLD) return "flee";
  if (nearby >= 3 && myRole?.primary !== ROLES.SOLDIER) return "flee";
  // Direct report, 2026-10-10 ("they still aren't fighting back when even a single mob is
  // attacking them"): this policy's own header above already says "an armed bot still fights a
  // single melee or ranged threat," but the code never implemented that for a healthy
  // non-Soldier -- nearby === 1 fell through to the consecutive-flee counter below, which starts
  // at "flee" and only escalates after CONSECUTIVE_FLEE_ESCALATE_AFTER decisions, or sooner if
  // CONSECUTIVE_FLEE_RESET_MS passes between unrelated single-mob encounters, resetting the count
  // to zero before it ever gets there. Confirmed live (Bob, 2026-10-10): fled a single zombie at
  // 11.8/20 health, clearly not outnumbered, not critical, not a Soldier -- exactly the
  // "shouldn't even reach the counter" case. nearby <= 1 is a genuinely solo threat, no outnumbered
  // judgment call to make, so it now attacks directly like the Soldier/low-health cases beside it.
  if (nearby <= 1 || myRole?.primary === ROLES.SOLDIER || bot.health < HALF_HEALTH) {
    consecutiveFleeCount = 0;
    return "attack";
  }
  if (Date.now() - lastFleeDecisionAt > CONSECUTIVE_FLEE_RESET_MS) consecutiveFleeCount = 0;
  if (consecutiveFleeCount >= CONSECUTIVE_FLEE_ESCALATE_AFTER) {
    consecutiveFleeCount = 0;
    return "attack";
  }
  consecutiveFleeCount++;
  lastFleeDecisionAt = Date.now();
  return "flee";
}

// Direct follow-up, same request ("if truly unable to flee, they should all fight"): a failed
// flee (pathfinder genuinely couldn't create distance -- see actions.js 1.62.0's own dig-loop
// fix, which makes this a fast, clean failure now instead of an infinite stuck retry) means
// retreating just isn't working right now, independent of why "flee" was chosen in the first
// place. Standing there and absorbing hits because running away didn't pan out is strictly worse
// than fighting back -- including bare-handed: a no-weapon bot who genuinely cannot run is still
// better off swinging her fists than standing still and taking every hit for free. Direct
// follow-up, 2026-10-09 ("if no-one is armed, and they are under attack and for some reason
// cannot run, they should still try to fight even if it's hopeless"): this used to also bail on
// !hasWeapon(bot), the one case it exists for -- an unarmed bot who failed to flee just stood
// there. decideFightType() above still tries fleeing FIRST whenever it's an option, armed or not
// (running away beats a fistfight when running is actually possible); this only ever runs once
// that's already failed. Deliberately still excludes FLEE_ONLY_MOBS -- a flyer or teleport-evader
// is still unreachable no matter how desperate this gets, the exact doomed-melee shape
// FLEE_ONLY_MOBS exists to prevent (actions.js); that's "can't reach it," not "won't try."
export async function attackAsLastResort(threat, label, handle) {
  if (FLEE_ONLY_MOBS.has(threat.name)) return;
  const result = await performAction(bot, { type: "attack", target: threat }, USERNAME, handle);
  console.log(`[${USERNAME}] ${label}: couldn't get away, fighting instead -- ${result.text} ` +
              `(ok=${result.ok})`);
}

// Direct request, 2026-09-21 ("re-evaluate the entire defense scheme"), the mirror image of
// attackAsLastResort just above -- root-caused from a live mass-death incident where EMERGENCY's
// own unconditional "fight, no matter what" rule at critical health had no escape hatch: once
// committed to "attack," nothing short of the target actually dying (or the new short
// EMERGENCY_ATTACK_TIMEOUT_MS below) would end it, riding out up to the full 90s ACTION_TIMEOUT_MS
// at critical health with zero re-evaluation. That's fine when the fight is actually winnable --
// it's exactly how a bot that's this hurt should behave -- but a fight that's CLEARLY not working
// (still not dead after several real seconds of trying) means every additional second spent
// swinging is a second closer to death with no upside. Symmetric with attackAsLastResort: fighting
// is still the first choice at critical health (unchanged, direct request), this only fires when
// that first choice has already had a fair, bounded shot and hasn't paid off.
export async function fleeAsLastResort(threat, label, handle) {
  if (bot.health <= 0) return;
  const rallyPoint = await nearestRallyPoint(bot);
  const result = await performAction(bot, { type: "flee", target: threat, rallyPoint }, USERNAME, handle);
  console.log(`[${USERNAME}] ${label}: fight wasn't working, fleeing instead -- ${result.text} ` +
              `(ok=${result.ok})`);
}

// Item #6 of "fix all the above" (squad response). Real gap: self-defense was purely individual
// -- Mark/Luke's own "military... defending the spawn point" framing (2026-09-07) implied a
// squad that backs each other up, but nothing ever told a teammate someone else was under
// attack. ANY bot broadcasts a threat alert (calling for help costs nothing and might as well be
// universal), but only a SQUAD_RESPONDER actually drops what she's doing to go help -- Babs/Amy
// abandoning a gathering run for a spider three biomes away would be a net loss, not backup.
// Mirrors MC_SELF_DEFENSE_FLEE_HEALTH/RANGE's own "same code, per-bot tuning via each unit's own
// Environment= lines" pattern, set true for Mark/Luke only.
//
// Direct request, 2026-09-13 ("soldier personas need to... be responsive to calls for help"): a
// real, confirmed gap -- this used to be gated ONLY by the env var, structurally independent of
// roles.js's own SOLDIER assignment. A bot could be given the Soldier role and still never
// respond to a squad call unless someone separately remembered to also set
// MC_SQUAD_RESPONDER=true on her unit file; today that happens to line up for Mark/Luke, but
// nothing enforced it. Now derived from the role assignment itself (primary OR secondary --
// backing up the fleet is exactly what a secondary-Soldier lean means) with the env var kept as
// an explicit override for a non-Soldier bot the operator still wants on squad-response duty.
export let SQUAD_RESPONDER = false; // set by installSelfDefense(): it reads index.js's myRole
// No point racing across half the map for a fight that's very likely already over by the time
// she'd arrive -- bounded to a real, reachable-in-time assist radius.
export const SQUAD_ASSIST_RANGE = 48;
// Keeps one drawn-out fight from re-alerting every 2000ms (checkSelfDefense's own tick) for the
// entire duration -- one call for help per fight is enough for a teammate to start moving.
const SQUAD_ALERT_COOLDOWN_MS = 15_000;
let lastSquadAlertAt = 0;
export let squadResponseInFlight = false;

// Direct request, 2026-09-13 ("non-soldier bots need to call for help properly"). Real, confirmed
// gap found while adding death-awareness below: checkSelfDefense's own idle-tick threat detection
// was the ONLY place that ever called broadcastThreatAlert -- the two situations where a bot most
// needs the fleet's help, the true health-critical emergency interrupt (bot.on("health") below)
// and a hostile creeping up on her while she's asleep (checkSleepingThreat), never called for
// help at all, they just handled it (or tried to) alone. All three threat-detection sites now
// funnel through this one function instead of three drifting copies of the same cooldown check.
// Also doubles as the source of truth for "who probably just killed her" (lastKnownThreat,
// consumed by bot.on("death") below) -- freshness for that purpose is tracked independently of
// the alert's own spam-prevention cooldown, since a recent sighting is still a good guess even if
// an alert for it was suppressed a few seconds ago.
export let lastKnownThreat = null;
export function noteThreatSeen(threatName) {
  lastKnownThreat = { name: threatName, at: Date.now() };
  if (Date.now() - lastSquadAlertAt > SQUAD_ALERT_COOLDOWN_MS) {
    lastSquadAlertAt = Date.now();
    broadcastThreatAlert(threatName);
  }
}

// Direct request, 2026-09-18 ("have the threatened bot run towards safety, run towards golems, or
// soldiers") -- direct follow-up to confirming SQUAD_ASSIST_RANGE (48 blocks) leaves a fleeing bot
// beyond it with no real help coming (the exact live incident that prompted this: Nell, alone and
// critical, ~70 blocks from both Soldiers). "Flee" previously had no destination at all -- it just
// maximized distance from the threat, which could just as easily run a bot deeper into danger as
// out of it. Priority, cheapest/most-effective first: a nearby iron golem (fights hostiles near it
// on its own vanilla AI -- real backup even with zero teammates in range) > a nearby Soldier
// teammate whose entity this bot's own client currently has loaded (bot.players -- no new
// broadcast infrastructure needed, this is just each bot's own already-tracked world state) > home
// (always a safer place to end up than wherever the flee happened to start, even with nobody
// there). Returns null only when none of the three are known at all, in which case "flee" falls
// back to its original plain away-from-threat behavior.
const RALLY_SEARCH_RANGE = 32;
export async function nearestRallyPoint(bot) {
  const golem = nearestFriendlyGolem(bot, RALLY_SEARCH_RANGE);
  if (golem) return golem.position;

  let nearestSoldierPos = null;
  let nearestSoldierDist = RALLY_SEARCH_RANGE;
  for (const name of BOT_USERNAMES) {
    if (name === USERNAME) continue;
    if (BOT_ROLES[name.toLowerCase()]?.primary !== ROLES.SOLDIER) continue;
    const entity = bot.players[name]?.entity;
    if (!entity) continue;
    const dist = entity.position.distanceTo(bot.entity.position);
    if (dist <= nearestSoldierDist) {
      nearestSoldierPos = entity.position;
      nearestSoldierDist = dist;
    }
  }
  if (nearestSoldierPos) return nearestSoldierPos;

  // Direct live report, 2026-09-21 ("zombie is in the building again, attacking the crowd of
  // bots"): this fallback's own original assumption -- home is "always a safer place to end up...
  // even with nobody there" -- breaks down completely for the exact incident this session keeps
  // returning to: the threat is INSIDE home, and most of the fleet is already there. Confirmed
  // live: every bot's own "self-defense: flee" attempt failed with "No path to the goal!" the
  // whole time this was happening, fast failures (2-4ms) consistent with a genuinely unreachable
  // GoalNear rather than a slow, exhausted search. A bed/spawnPoint that sits in a different room
  // of the same structure than wherever she's currently cornered turns what should be "take one
  // step toward any nearby exit" into "path all the way across the building to one specific
  // point" -- far more likely to fail outright, and even when it succeeds, walks her TOWARD the
  // same building the threat is already in rather than away from it. Only worth returning when it
  // represents real progress toward a genuinely different, farther-away place -- close enough and
  // she's arguably already home, in which case this fallback can only hurt, never help, and flee
  // is better off falling through to its own plain maximize-distance goal below (no specific
  // destination required, just any nearby improvement, exactly what a real doorway or gap needs).
  const HOME_RALLY_MIN_DISTANCE = 20;
  const home = bot.spawnPoint || null;
  if (home && home.distanceTo(bot.entity.position) >= HOME_RALLY_MIN_DISTANCE) return home;
  return null;
}

// Direct report, 2026-09-08 ("they still don't seem to react to a threatening creature"). Real,
// confirmed gap: this used to be gated on !acting, same as every other idle-tick check here --
// but `acting` now spans an entire physical action end-to-end (up to ACTION_TIMEOUT_MS, 90s
// after tonight's own earlier raise), and goal-directed autonomy keeps a bot "acting" a large
// fraction of the time. A threat that showed up mid-mine/mid-craft got NO response at all from
// this check until the health-triggered TRUE interrupt (bot.on("health") below) finally fired --
// and that one only engages at EMERGENCY_HEALTH_THRESHOLD (30% health), meaning she'd already
// taken several real, avoidable hits first. This borrows that handler's own proven force-cancel-
// then-wait-then-act sequence instead of the idle-tick gate every other routine check still
// correctly uses (their own physical actions genuinely can wait; a live threat cannot) --
// consistent with checkSleepingThreat's own precedent of bypassing busy/acting for exactly the
// one case nothing else can reach in time.
let selfDefenseInFlight = false;

// Direct report, 2026-09-14 ("bots are generally stationary... 'route can't be resolved'/'can't
// reach you' even with nothing in the way"). Root-caused from live evidence, not guessed: Mark
// alone logged 268 self-defense triggers in a single hour (240 of them phantoms) and 1,608
// pathfinder goal-resets over 15.5h -- a threat re-detected and re-force-cancelled roughly every
// 13 seconds, almost entirely phantoms. The FLEE_ONLY_MOBS "flee" response only ever buys a few
// blocks of distance from a flying mob that's faster on the wing than she is on foot, so it
// re-enters SELF_DEFENSE_RANGE well within the next 2000ms tick almost every time -- she wasn't
// stationary from being blocked, she was flinching in place, since EVERY real travel goal
// (a goto/follow toward a player, walking to a chest or bed, terrain repair) kept getting
// force-cancelled by the next tick's re-trigger before it could ever finish. A real melee threat
// (zombie/spider/creeper) still gets the full, immediate 2000ms response every time -- only a
// FLEE_ONLY_MOB's own re-trigger is throttled, since fleeing already bought real safety
// (phantoms rarely land a hit on a moving target, and the separate health-critical emergency
// handler below is untouched and still fires immediately regardless of this cooldown if one
// somehow does) while repeating the full interrupt every 2s bought nothing further.
const FLEE_MOB_RESPONSE_COOLDOWN_MS = 20_000;
let lastFleeMobResponseAt = 0;

// Direct request, 2026-09-10 ("write up a plan for that single arbiter..." -> the approved
// per-bot coherence arbiter plan, Phase 2 of its migration). The old inline 4-primitive cancel +
// busy||acting poll loop is now arbiter.requestControl() -- see arbiter.js's own header for why
// this specific handler was one of the 4 duplicated, drifted copies this phase closes.
// Attacker tracking (fight-or-flee policy, 2026-09-25): when this bot loses health, the hostile
// in melee reach (else the nearest ranged mob with a shot) is remembered as the attacker for
// ATTACKER_MEMORY_MS, and pickThreat() answers it instead of whatever mob happens to be nearest.
// prependListener: this must run before the critical-health handler reads it for the same hit.
const RANGED_MOBS = new Set(["skeleton", "stray", "pillager", "witch", "blaze", "ghast"]);
const ATTACKER_MEMORY_MS = 6_000;
let lastAttacker = null; // { id, at }
let lastHealthSeen = 20;

// 2026-10-30: a spider in daylight leaves you alone unless you hit it (vanilla). Counting one as a
// threat sent weaponless Babs fleeing again and again from the table her sword needed. One that
// just hurt her is still lastAttacker, below, and still answered.
const DAY_NEUTRAL_MOBS = new Set(["spider"]);

export function pickThreat(range) {
  if (lastAttacker && Date.now() - lastAttacker.at <= ATTACKER_MEMORY_MS && bot.entity) {
    const attacker = bot.entities[lastAttacker.id];
    if (attacker && attacker.position.distanceTo(bot.entity.position) <= range) return attacker;
  }
  const threat = nearestHostile(bot, range);
  if (threat && DAY_NEUTRAL_MOBS.has(threat.name) && bot.time?.isDay) {
    const here = bot.entity.position;
    return bot.nearestEntity((e) => HOSTILE_MOBS.has(e.name) && !DAY_NEUTRAL_MOBS.has(e.name) &&
      e.position.distanceTo(here) <= range);
  }
  return threat;
}

export async function checkSelfDefense() {
  if (!AUTONOMY_ENABLED || selfDefenseInFlight || bot.isSleeping) return;
  const threat = pickThreat(SELF_DEFENSE_RANGE);
  if (!threat) return;
  if (FLEE_ONLY_MOBS.has(threat.name) &&
      Date.now() - lastFleeMobResponseAt < FLEE_MOB_RESPONSE_COOLDOWN_MS) {
    return; // already fled one of these recently -- let real travel/goals actually run for a bit
  }

  selfDefenseInFlight = true;
  console.log(`[${USERNAME}] self-defense: threat detected (${threat.name}) -- force-cancelling ` +
              `current action to respond`);
  noteThreatSeen(threat.name);

  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.SELF_DEFENSE);
  if (!handle) {
    console.log(`[${USERNAME}] self-defense: yielded to something more urgent ` +
                `(${arbiter.currentOwner()})`);
    selfDefenseInFlight = false;
    return;
  }
  try {
    // Direct request, 2026-09-10 (direct report: "can't fight, or run from, phantoms" -- see
    // actions.js's own FLEE_ONLY_MOBS header for the confirmed live root cause: melee-attacking
    // a flyer can never actually land, holding SELF_DEFENSE-tier control for the full 90s
    // ACTION_TIMEOUT_MS every single time and blocking everything else for that whole span).
    // Checked ahead of the health threshold -- a flyer is never worth attacking regardless of
    // how much health is left to spend on a doomed chase.
    //
    // Direct report, 2026-09-15 ("look for behavioral gaps"): the exact same doomed-timeout
    // shape, found live -- Mark logged 909 "gave up on the fight -- took too long" results in
    // 34 hours (~27/hour, against every hostile type, not just flyers) because he had no sword
    // or axe the ENTIRE window. A bare-handed bot attacking anything is nearly as doomed as
    // meleeing a flyer -- it just fails by timeout instead of by unreachability. Worse, this was
    // self-reinforcing: constant SELF_DEFENSE-tier combat (always chosen over flee, since none
    // of these mobs were FLEE_ONLY and health never dropped low enough to trigger the OTHER
    // flee condition) never gave GOAL_STEP tier -- the tier her own "go get a weapon" directive
    // runs under -- a long enough uninterrupted window to ever actually loot/craft/request one,
    // which kept her bare-handed, which kept every future encounter doomed the same way. Now
    // checked alongside the other two flee conditions: no weapon means flee, regardless of mob
    // type or health, breaking the cycle by actually surviving long enough between encounters to
    // get equipped. See decideFightType()'s own header for the current role/health rule.
    const type = decideFightType(threat);
    if (FLEE_ONLY_MOBS.has(threat.name)) lastFleeMobResponseAt = Date.now();
    console.log(`[${USERNAME}] self-defense: ${type} (health=${bot.health}, threat=${threat.name})`);
    const rallyPoint = type === "flee" ? await nearestRallyPoint(bot) : null;
    // action.target: the already-found entity, not re-derived -- see actions.js's own
    // "attack"/"flee" 2026-09-08 changelog for the live thrash bug this closes.
    const result = await performAction(bot, { type, target: threat, rallyPoint }, USERNAME, handle);
    console.log(`[${USERNAME}] self-defense result: ${result.text} (ok=${result.ok})`);
    if (type === "flee" && !result.ok && !result.cancelled) await attackAsLastResort(threat, "self-defense", handle);
  } catch (err) {
    console.error(`[${USERNAME}] self-defense check failed:`, err.message);
  } finally {
    handle.release();
    selfDefenseInFlight = false;
  }
}


// Squad response (item #6 of "fix all the above"), the SQUAD_RESPONDER receiving side -- same
// force-cancel-then-wait-then-act shape checkSelfDefense already uses, since a teammate under
// attack is exactly as urgent as being under attack herself. Travels toward the alert's real
// coordinates (a manual setTimeout-guarded goto, same pattern the shore-travel code above already
// uses -- no shared withTimeout() to import, that helper is actions.js-private) and, once there,
// runs the real self-defense attack against whatever hostile she can actually find -- the
// original threat may already be dead by the time she arrives, in which case there's simply
// nothing left to do, a good outcome, not a failure.
const SQUAD_RESPONSE_TRAVEL_TIMEOUT_MS = 20_000;

// Direct request, 2026-09-10 (coherence-arbiter Phase 2 -- see checkSelfDefense's own migration
// note just above). The internal `bot.pathfinder.goto(...)` travel step's own manual
// setTimeout/setGoal(null) pair is UNTOUCHED -- that's this action's own per-step timeout escape
// hatch (the same pattern every actions.js case already uses for its own internal travel legs),
// structurally unrelated to the outer "acquire control from whatever else is happening" problem
// the arbiter solves.
export async function respondToSquadCall(payload) {
  squadResponseInFlight = true;
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.SQUAD_RESPONSE);
  if (!handle) {
    console.log(`[${USERNAME}] squad response: yielded to something more urgent ` +
                `(${arbiter.currentOwner()})`);
    squadResponseInFlight = false;
    return;
  }
  try {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (arbiter.holdsControl(handle)) bot.pathfinder.setGoal(null); },
      SQUAD_RESPONSE_TRAVEL_TIMEOUT_MS);
    try {
      await bot.pathfinder.goto(new goals.GoalNear(payload.x, payload.y, payload.z, 4));
    } catch (err) {
      if (!timedOut && !handle.token.cancelled) console.error(`[${USERNAME}] squad response travel failed:`, err.message);
    } finally {
      clearTimeout(timer);
      if (arbiter.holdsControl(handle)) bot.pathfinder.setGoal(null); // MB-02: never clear a preemptor's path
    }

    const threat = pickThreat(SELF_DEFENSE_RANGE);
    if (!threat) {
      console.log(`[${USERNAME}] squad response: arrived, nothing left to fight.`);
    } else if (FLEE_ONLY_MOBS.has(threat.name)) {
      // See actions.js's own FLEE_ONLY_MOBS header -- attacking a flyer would just hang here
      // for the full 90s ACTION_TIMEOUT_MS holding SQUAD_RESPONSE control the whole time,
      // for no real chance of ever landing a hit.
      console.log(`[${USERNAME}] squad response: arrived, but a ${threat.name} isn't worth chasing on foot.`);
    } else if (!hasWeapon(bot)) {
      // Direct report, 2026-09-15 ("look for behavioral gaps") -- same doomed-timeout shape as
      // checkSelfDefense's own fix just above: a responder who arrives with no weapon of her own
      // is exactly as unable to actually help as one facing a flyer, and committing to "attack"
      // anyway would just hold SQUAD_RESPONSE control for the full 90s for nothing.
      console.log(`[${USERNAME}] squad response: arrived, but no weapon to fight ${threat.name} with.`);
    } else {
      const result = await performAction(bot, { type: "attack", target: threat }, USERNAME, handle);
      console.log(`[${USERNAME}] squad response result: ${result.text} (ok=${result.ok})`);
    }
  } finally {
    handle.release();
    squadResponseInFlight = false;
  }
}

// Runs once, from index.js, at the point where this code used to sit: registers the health
// listener and the self-defense tick, and decides SQUAD_RESPONDER from this bot's role.
export function installSelfDefense() {
  SQUAD_RESPONDER = process.env.MC_SQUAD_RESPONDER === "true" ||
  myRole?.primary === ROLES.SOLDIER || myRole?.secondary === ROLES.SOLDIER;
  bot.prependListener("health", () => {
    if (bot.entity && bot.health < lastHealthSeen) {
      const here = bot.entity.position;
      const near = (names, radius) => bot.nearestEntity((e) => names(e.name) && e.position.distanceTo(here) <= radius);
      const attacker = near((n) => HOSTILE_MOBS.has(n), 3.5) || near((n) => RANGED_MOBS.has(n), 24);
      if (attacker) lastAttacker = { id: attacker.id, at: Date.now() };
    }
    lastHealthSeen = bot.health;
  });
  guardedInterval(() => {
    checkSelfDefense().catch((err) => console.error(`[${USERNAME}] checkSelfDefense error:`, err.message));
  }, SELF_DEFENSE_CHECK_MS);
}
