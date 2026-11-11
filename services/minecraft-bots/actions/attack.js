// Version: 1.0.0
//
// The "attack" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { equipBestWeapon } from "../equipment.js";
import path from "node:path";
import { ACTION_TIMEOUT_MS, FLEE_ONLY_MOBS, nearestHostile, refreshGear, withTimeout } from "../actions.js";


export async function attackAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Real live bug, 2026-09-08: checkSelfDefense() already finds a specific real entity
  // (nearestHostile(bot, SELF_DEFENSE_RANGE)) before calling here -- re-deriving it a second
  // time via a fresh nearestHostile(bot) call raced against that exact entity moving out of
  // range or despawning in the gap between detection and this call (checkSelfDefense's own
  // force-cancel-then-wait sequence can take up to 3s). Confirmed live: Mark spammed "threat
  // detected" -> "no hostile mobs nearby" every 2s for 90+ seconds straight, never landing a
  // single hit, because the second lookup kept missing what the first one had already found.
  // action.target (when a caller already has the real entity in hand) is now used directly,
  // no re-derivation -- goal-directed callers with no known entity still fall back to a fresh
  // search exactly as before.
  const target = action.target || nearestHostile(bot);
  if (!target) return fail("no hostile mobs nearby.");
  // Direct request, 2026-09-17 ("if they craft armor or weapons or tools, they should equip
  // them"): a real gap this surfaced -- nothing here ever re-equipped a weapon before
  // engaging, only refreshGear() in the finally block AFTER the fight ends ("mob drops may
  // include something worth wearing/wielding"). Combat has always just used whatever
  // happened to already be held, and now that a freshly-crafted tool deliberately stays held
  // after "craft" (this same file's own new note there), a bot could otherwise walk into a
  // fight holding a pickaxe. equipBestWeapon() here guarantees combat always starts
  // weapon-in-hand regardless of what was held a moment before, whether that's a fresh tool,
  // a fishing rod, or held food.
  await equipBestWeapon(bot);
  // Real gap found by reading mineflayer-pvp's own source (PVP.js), 2026-09-07: it already
  // fully automates shield use during combat -- blocking a creeper's explosion, and an
  // active-block-then-attack cadence on every swing (hasShield()/checkExplosion()/
  // attemptAttack()) -- but ALL of it is conditional on a shield already sitting in the
  // off-hand slot, which nothing in this codebase ever put there. Equipping one here (if
  // she's carrying one) is the entire fix; everything downstream is already handled
  // internally with no further changes needed.
  const shield = bot.inventory.items().find((i) => i.name.includes("shield"));
  const offHandSlot = bot.getEquipmentDestSlot("off-hand");
  if (shield && bot.inventory.slots[offHandSlot]?.name !== shield.name) {
    try {
      await bot.equip(shield, "off-hand");
    } catch (err) {
      console.error("attack: failed to equip shield:", err.message);
    }
  }
  // Real live bug found 2026-09-10 (direct report: "they're still not fighting back or
  // running"), confirmed by reading the actually-installed mineflayer-pvp 1.3.2 source
  // (lib/PVP.js) directly: the comment this replaces was WRONG for this version --
  // bot.pvp.attack() does NOT wait for the target to die or be lost. It only sets
  // this.target and a fresh pathfinder GoalFollow, then returns almost immediately; the real
  // attacking (chase + swing) runs separately, forever, off the library's own internal
  // physicTick listener.
  //
  // A FIRST fix attempt (waiting on the library's own 'stoppedAttacking' event instead) was
  // ALSO wrong, confirmed live a second time: that event fires for ANY stop() call, including
  // arbiter.js's own cancelPhysical() -- called unconditionally and fire-and-forget at the top
  // of every requestControl() acquisition, even a same-owner reacquisition against the SAME
  // still-alive target. That prior cycle's own cleanup stop() was still asynchronously
  // in-flight (it awaits the pathfinder's own 'path_stop' event internally) when this fight's
  // fresh listener attached a moment later, so its STALE emission -- completely unrelated to
  // this fight -- was mistaken for "the fight just ended," reproducing the exact same
  // instant-"took care of it" symptom as the original bug.
  //
  // Polling the target's own real, unambiguous state -- is it still a tracked entity at all --
  // sidesteps both promises entirely, matching the "don't infer from a shared/ambiguous event"
  // approach every OTHER cancellable action in this file already uses (token.cancelled checked
  // directly against real pathfinder/collectBlock rejection, never guessed at). Also aborts
  // promptly on a genuine higher-priority preemption (token.cancelled) rather than only on the
  // full ACTION_TIMEOUT_MS ceiling.
  // Direct request, 2026-09-21 ("re-evaluate the entire defense scheme"), root-caused from a
  // live mass-death incident: EMERGENCY-tier combat (bot.on("health"), index.js) commits to
  // "attack" unconditionally once health is critical, with no way to reconsider if the fight
  // simply isn't going well -- and until now that meant riding out the FULL ACTION_TIMEOUT_MS
  // (90s) with nothing able to preempt it (HEALTH_CRITICAL sits above every other tier except
  // the cancel-only TELEPORT_HOME). Confirmed live: Wade logged "yielded to (HEALTH_CRITICAL)"
  // for over 20 straight seconds -- a single stuck emergency attack holding control that whole
  // time while he stayed at critical health with no way out. `action.maxDurationMs` lets a
  // caller give a MUCH shorter leash for exactly this situation (see index.js's own EMERGENCY
  // handler, which now bails to flee if this returns non-ok) -- defaults to the normal
  // ACTION_TIMEOUT_MS for every other caller, unchanged.
  //
  // Review MB-01, 2026-09-24: the 1.42.0 rewrite above replaced
  // `await withTimeout(bot.pvp.attack(target), ...)` with the polling loop below but dropped
  // the bot.pvp.attack() call itself -- nothing started the chase-and-swing, so every fight
  // since 2026-09-10 just waited out its timer (the root of 2.86.0-2.88.0's "they just stand
  // there" reports). attack() is started here, fire-and-forget (it resolves once the chase is
  // set up), and re-issued if the library drops the target while it still exists. A kill is
  // now only claimed on the server's own entityDead status for THIS target; the entity merely
  // unloading (out of range, despawned) is reported as losing track, not a kill.
  // Direct report, 2026-10-22 (attack_win_rate collapsed 0.846 baseline -> 0.099 measured):
  // root-caused from real spark journals, not guessed -- Luke and Mark (the two Soldiers,
  // SELF_DEFENSE_RANGE=20 and decideFightType()'s "a Soldier always fights" rule, never
  // flees) logged 5,901 and 1,718 path_update status=noPath results in 24h, 7-20x Amy/Babs/
  // Mayor's 298-832, almost certainly the fresh 2026-10-08 world reset putting their guard
  // posts near terrain their wide detection range can sense across but the pathfinder can't
  // route through (water/elevation/gaps). A Soldier who can't flee and can't reach the
  // target just polled this loop for the full 90s ACTION_TIMEOUT_MS every single time --
  // 206-266 such losses per bot per day, each one holding SELF_DEFENSE-tier arbiter control
  // the entire span. FLEE_ONLY_MOBS already exists for the identical shape of problem with
  // flying mobs ("a melee attack can never land, don't commit to it"); nothing gave melee an
  // equivalent escape when the target is sensed but genuinely unpathable. Same burst-
  // detection shape this file's own dig_error handler already uses (index.js,
  // DIG_ERROR_BURST_THRESHOLD=4 within DIG_ERROR_BURST_WINDOW_MS=3000) -- a handful of real,
  // persistent noPath results in a few seconds is strong evidence of structural
  // unreachability, not a single transient blip (a door about to open, a teammate's hitbox
  // briefly in the way) that a lower threshold would wrongly abandon.
  const FIGHT_POLL_MS = 250;
  const NOPATH_BURST_THRESHOLD = 4;
  const NOPATH_BURST_WINDOW_MS = 3000;
  const deadline = Date.now() + (action.maxDurationMs ?? ACTION_TIMEOUT_MS);
  let killed = false;
  let unreachable = false;
  let noPathTimestamps = [];
  const onDead = (entity) => { if (entity?.id === target.id) killed = true; };
  const onPathUpdate = (r) => {
    if (r.status !== "noPath") { noPathTimestamps = []; return; }
    const now = Date.now();
    noPathTimestamps = [...noPathTimestamps.filter((t) => now - t < NOPATH_BURST_WINDOW_MS), now];
    if (noPathTimestamps.length >= NOPATH_BURST_THRESHOLD) unreachable = true;
  };
  const startAttack = () => {
    Promise.resolve(bot.pvp.attack(target))
      .catch((err) => console.error("attack: pvp.attack failed:", err.message));
  };
  bot.on("entityDead", onDead);
  bot.on("path_update", onPathUpdate);
  try {
    if (!token.cancelled) startAttack();
    while (!killed && !unreachable && bot.entities[target.id] && !token.cancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, FIGHT_POLL_MS));
      if (!killed && !token.cancelled && bot.entities[target.id] && bot.pvp.target !== target) startAttack();
    }
  } finally {
    bot.removeListener("entityDead", onDead);
    bot.removeListener("path_update", onPathUpdate);
    // A preemptor's own cancelPhysical() already stopped PvP; only the owner cleans up.
    if (!token.cancelled) {
      if (bot.pvp.target) bot.pvp.stop();
      await refreshGear(bot); // mob drops may include something worth wearing/wielding
    }
  }
  if (token.cancelled) return ok("broke off the fight.");
  if (killed) return ok("took care of it.");
  // Deliberately its own outcome, excluded from attack_win_rate's loss count the same way
  // "broke off the fight" already is (tests/baseline.mjs) -- this was never a fight with any
  // chance of landing a hit, the same reasoning that already excludes FLEE_ONLY_MOBS from
  // ever entering one. Tracked separately by unreachable_target_bailouts_per_bot_day so the
  // underlying terrain/range problem stays visible rather than just vanishing from the ratio.
  if (unreachable) return fail("couldn't reach it -- no path through.");
  if (!bot.entities[target.id]) return fail("lost track of it.");
  return fail("gave up on the fight -- took too long.");
}
