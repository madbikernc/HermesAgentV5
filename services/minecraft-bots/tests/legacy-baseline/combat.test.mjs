// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/combat.test.mjs ("fighting, fleeing, hunting and guard
// duty") against the Mindcraft-ported architecture (modes.js/skills.js/arbiter.js), not the old
// goal-engine/priority-tier/role system archived at services/minecraft-bots-archive-11-2026/.
// Real test() entries port the old CLAIM onto real current code and are counted in the baseline
// score. test.todo() entries are old checks whose own mechanism (ROLES/Soldier, the goal engine,
// decideFightType, attacker-memory) has no current equivalent at all -- excluded from the score,
// but never silently dropped: each names exactly what's gone and why.
// Run: node --test services/minecraft-bots/tests/legacy-baseline/combat.test.mjs
// (needs node_modules -- same requirement tests/live.test.mjs already has)

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBot, V3, sleep } from "./_mockbot.mjs";
import { attackEntity } from "../../skills.js";
import { runModes, MODES } from "../../modes.js";

// defendSelf()/attackEntity() loop until their target is gone from bot.entities or
// bot.interrupt_code is set -- never both at once in these mocks, so every runModes()-driven check
// below asserts on bot.pvp.target first, THEN sets interrupt_code to let the loop unwind cleanly,
// instead of awaiting the full call (which would otherwise poll forever against a mock world that
// never makes the target disappear on its own).
async function runModesBounded(bot) {
  const pending = runModes(bot);
  await sleep(20);
  const target = bot.pvp.target;
  bot.interrupt_code = true;
  const acted = await pending;
  return { acted, target };
}

function hostileAt(id, name, distance) {
  return { id, name, type: "hostile", metadata: [], position: new V3(distance, 64, 0) };
}

// Old: "MB-01 attack starts combat and only claims a kill on entityDead". attackEntity() has no
// mineflayer entityDead listener at all -- it polls world.getNearbyEntities() and declares success
// once the target is no longer in the list, exactly the "merely unloaded" shape the old code
// specifically guarded against (see the second test below).
test("[legacy:combat] attackEntity attacks a nearby target and reports success once it leaves nearby-entities range", async () => {
  const bot = makeBot();
  const target = hostileAt(1, "zombie", 2);
  bot.entities[1] = target;
  const pending = attackEntity(bot, target);
  await sleep(50);
  assert.equal(bot.pvp.target, target, "bot.pvp.attack() was never called");
  delete bot.entities[1];
  const result = await pending;
  assert.equal(result, true);
});

test("[legacy:combat] a target that merely leaves render distance must not be reported as a kill (regression vs. old entityDead-driven check)", async () => {
  // Expected to FAIL now: attackEntity() has no way to tell a real kill from a mere unload --
  // this is the exact MB-01 distinction the old entityDead-listener code made on purpose.
  const bot = makeBot();
  const target = hostileAt(2, "zombie", 2);
  bot.entities[2] = target;
  const pending = attackEntity(bot, target);
  await sleep(50);
  delete bot.entities[2]; // unloaded, not killed -- no death event exists to tell the function that
  const result = await pending;
  assert.equal(result, false, "attackEntity reported a kill for a target that only unloaded");
});

test.todo("[legacy:combat] MB-01 attack bails early on a noPath burst -- NOT PORTED: the burst-of-4-noPath bailout heuristic lived in the old actions.js 'attack' case; attackEntity() consults no path_update events at all");
test.todo("[legacy:combat] MB-01 a lone/transient noPath does not abandon a fight that then lands a kill -- NOT PORTED: same removed noPath-burst bookkeeping as above");
test.todo("[legacy:combat] EFF guard duty is a standing goal: no planner, back to post, ends on a new priority -- NOT PORTED: the goal engine (currentGoal/goalTick/retireGoal) and guardTick() were archived; there is no standing-goal concept in index.js 4.1.0");
test.todo("[legacy:combat] Soldier priorities: monster, then guard -- NOT PORTED: the ROLES/Soldier system and nextSoldierPriority() were archived; personas are now free-form profiles with no priority-tier dispatch");
test.todo("[legacy:combat] Guard anchor: one holder blocks a second bot, released or stale frees it for the next -- NOT PORTED: holdsGuardAnchor()'s shared-claim file was archived with the rest of the Soldier role machinery");
test.todo("[legacy:combat] Soldier priorities: one live Soldier is trivially the anchor; two or more contend for it -- NOT PORTED: same removed guard-anchor/Soldier-role system");

// Old: a nuanced decideFightType (health/outnumbered/Soldier/creeper/unarmed-aware). New: modes.js's
// self_defense mode fights ANY single hostile within 8 blocks unconditionally when the mode is on --
// no health check at all. The coarse claim ("an armed-or-not bot fights a single nearby hostile")
// still holds; the nuance (outnumbered flees, creeper always flees, unarmed flees) does not and is
// marked separately below.
test("[legacy:combat] self_defense mode fights a single nearby hostile regardless of health (coarser than old decideFightType, which also checked health)", async () => {
  for (const [mob, health] of [["zombie", 5], ["pillager", 20]]) {
    const bot = makeBot({ health });
    const enemy = hostileAt(1, mob, 3);
    bot.entities[1] = enemy;
    const { acted, target } = await runModesBounded(bot);
    assert.equal(acted, "self_defense", mob);
    assert.equal(target, enemy);
  }
});

test.todo("[legacy:combat] Fight-or-flee: outnumbered at critical health flees, even a Soldier -- NOT PORTED: decideFightType's outnumbered-mob-count threshold and Soldier exception were archived; self_defense/cowardice are mutually-exclusive on/off modes with no mob-count awareness");
test.todo("[legacy:combat] Fight-or-flee: 3+ hostiles flee a non-Soldier, a Soldier holds, a close creeper always flees, an unarmed bot flees -- NOT PORTED: same removed decideFightType policy -- no mob-count, role, creeper-specific, or armament-aware branching exists in modes.js");
test.todo("[legacy:combat] attackAsLastResort: an unarmed bot who failed to flee still fights, bare-handed -- NOT PORTED: attackAsLastResort/fleeAsLastResort (night-survival.js/self-defense.js) were archived; there is no last-resort escalation layer above self_defense/cowardice");

test("[legacy:combat] self_defense picks the NEAREST hostile, not the one that actually attacked her (regression vs. old attacker-memory pickThreat)", async () => {
  // Expected to FAIL now: the old pickThreat() remembered which mob just landed a hit via a
  // "health" event listener and preferred it over a merely-nearer bystander. modes.js's
  // self_defense has no such memory -- it always re-picks nearest via world.getNearestEntityWhere.
  const bot = makeBot();
  const attacker = hostileAt(1, "skeleton", 15); // far away, but the one that just shot her
  const bystander = hostileAt(2, "zombie", 2); // nearer, but never touched her
  bot.entities[1] = attacker;
  bot.entities[2] = bystander;
  bot.lastDamageTime = Date.now();
  bot.lastDamageTaken = 3;
  const { target } = await runModesBounded(bot);
  assert.equal(target, attacker, "self_defense fought the nearest mob instead of the one that actually hurt her");
});

test("[legacy:combat] Hunt: a species' last two nearby must be left alone, never hunted down to zero (regression)", async () => {
  // Expected to FAIL now: modes.js's hunting mode has no population-floor check at all -- the old
  // actions.js 'hunt' case specifically never hunted a species' last two visible animals.
  const bot = makeBot();
  const pigA = { id: 1, name: "pig", type: "animal", metadata: [], position: new V3(2, 64, 0) };
  const pigB = { id: 2, name: "pig", type: "animal", metadata: [], position: new V3(3, 64, 0) };
  bot.entities[1] = pigA;
  bot.entities[2] = pigB;
  const huntingMode = MODES.find((m) => m.name === "hunting");
  const pending = huntingMode.update(bot);
  await sleep(20);
  bot.interrupt_code = true; // unwind attackEntity()'s poll loop if it was entered
  const acted = await pending;
  assert.equal(acted, false, "hunted one of only two pigs nearby, which the old code specifically refused to do");
});

test.todo("[legacy:combat] Hunt: raw chicken counts as food, ranked after everything else and eaten last -- NOT PORTED: there is no food-ranking list in the current skills.js; consume() takes an explicit item name with no preference ordering (chickens are at least still huntable: modes.js's isHuntable() list includes 'chicken')");

test("[legacy:combat] Self-defense: a spider in daylight must be left alone unless it just hit her (regression)", async () => {
  // Expected to FAIL now: modes.js's isHostile()/self_defense has no day/night or per-attacker
  // nuance at all -- it fights any entity whose type is 'hostile'/'mob' (other than golems),
  // day or night, hit or not.
  const bot = makeBot();
  bot.time = { isDay: true };
  const spider = { id: 1, name: "spider", type: "hostile", metadata: [], position: new V3(3, 64, 0) };
  bot.entities[1] = spider;
  await runModes(bot);
  assert.equal(bot.pvp.target, undefined, "fought a daytime spider that had not attacked her");
});

test.todo("[legacy:combat] Wool: string she already holds becomes wool before any sheep hunt -- NOT PORTED: the old 'get_wool' action's string-to-wool shortcut was archived with actions.js; craftRecipe() in skills.js has no item-specific preference logic");
test.todo("[legacy:combat] Food goal: hunts, else takes a ripe crop, never runs as a farm goal needing a hoe -- NOT PORTED: foodStep()/runFoodGoal() and the goal engine they lived in were archived; food-seeking is now entirely the LLM's own judgment via !commands");
test.todo("[legacy:combat] Flee honors a short maxDurationMs instead of the full leash (regression: 'unresponsive, won't run or fight back') -- NOT PORTED: skills.js's avoidEnemies()/stay() loop only on bot.interrupt_code, with no maxDurationMs parameter at all -- the same unbounded-wait risk the old fix closed could recur with no leash to catch it");
test.todo("[legacy:combat] EMERGENCY: flee and both last-resort fallbacks share attack's short leash -- NOT PORTED: EMERGENCY_ATTACK_TIMEOUT_MS/attackAsLastResort/fleeAsLastResort do not exist anywhere in the current index.js (confirmed absent by inspection, 2026-11-27)");
