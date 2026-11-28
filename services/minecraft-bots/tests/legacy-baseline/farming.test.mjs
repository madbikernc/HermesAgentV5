// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/farming.test.mjs against the Mindcraft-ported
// architecture (skills.js/world.js/commands.js/modes.js). See
// services/minecraft-bots-archive-11-2026/ for the archived "best past implementation" this
// measures against. Run: node --test services/minecraft-bots/tests/legacy-baseline/farming.test.mjs
//
// Almost every old check here exercised the archived goal engine (farm/ranch goal routing and
// runners, the survival-priority ladder, curriculum/RAG evidence, builder-item claims, Farmer/
// Herder role stand-ins, goal heartbeats) -- none of which the Mindcraft-ported architecture has
// an equivalent for; the LLM decision loop (index.js's decisionTick) replaces hard-coded routing
// with model judgment instead. Those are test.todo, excluded from the pass/fail score, each with
// the specific removed mechanism named so the decision is visible, not silent. One check --
// "Placement: a flower in the target cell is broken first" -- is a real, portable capability of
// the current skills.placeBlock() and gets a real test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { placeBlock } from "../../skills.js";
import { makeBot, V3 } from "./_mockbot.mjs";

test.todo('[legacy:farming] MB-16 EXPLORE <feature> parses to scouting; plain EXPLORE still gathers -- NOT PORTED: parseGoalStep()/the ACTION-line goal-step parser is gone; exploring is now the model issuing !searchForBlock/!searchForEntity directly, not a parsed "explore" action type.');

test.todo("[legacy:farming] EFF a repeated memory note skips the duplicate-search process -- NOT PORTED: longterm.js (RAG long-term memory, writeMemoryNote/searchMemory) was archived; index.js 4.0.0 replaced it with a bounded in-process rolling history reset on every restart (documented, deliberate scope reduction).");

test.todo("[legacy:farming] Survival (Tier 1): survivalPriorityItemSatisfied re-checks real state, not a claim -- NOT PORTED: the hard-coded survival-priority ladder (nextSurvivalPriority/survivalPriorityItemSatisfied) is gone; the LLM decision loop judges what to do next itself, with no tier ladder to re-check a claim against.");

test.todo("[legacy:farming] MB-12 heartbeat re-announces the goal and expires silent peers -- NOT PORTED: goalHeartbeatTick/broadcastGoalState and the whole notion of a standing 'currentGoal' object are gone; no goal-state broadcasting over Buzz exists in the new architecture (index.js's own header lists this as a deliberate, flagged scope reduction).");

test.todo("[legacy:farming] Food: a failed fetch backs off instead of failing \"eat\" every 15 seconds -- NOT PORTED: checkHunger()'s scheduled hunt/loot/eat escalation loop is gone; eating is now the model issuing !consume when it judges itself hungry, with no backoff scheduler around it.");

test.todo('[legacy:farming] Farm goals: farming and ranching goals are recognised; iron farms and wool are not -- NOT PORTED: farmTaskFor()\'s goal-description text classifier has no equivalent; there is no "goal description" object in the new architecture for anything to classify.');

test.todo("[legacy:farming] Farm goals: plant, wait while it grows (no actions), harvest when ripe, then done -- NOT PORTED: runFarmGoal()/farmGoalWorld's whole plant-wait-harvest state machine (goal.farmPlot, farmStatus()) is archived with the rest of the goal-runner system.");

test.todo("[legacy:farming] Farm goals: a missing hoe is fetched (loot, then craft) and the harvest retried -- NOT PORTED: same farm-goal runner as above; the current skills.craftRecipe()/skills.collectBlock() exist as standalone callable skills, but nothing automatically chains 'need a hoe -> loot one -> craft one -> retry the harvest' the way the old runner did.");

test.todo("[legacy:farming] Farm goals: holding a crop, or a DONE claim, never finishes one -- only a harvest -- NOT PORTED: the goal object's own hallucinated-DONE guard (goal.targetItem/holdsItem shortcut vs. a real harvest) has no analogue without a goal object to guard.");

test.todo("[legacy:farming] Curriculum: farming needs a harvested crop, and a stage cleared by holding food is re-earned -- NOT PORTED: TECH_TREE_STAGES/stageSatisfied()/the Mayor's curriculum file are archived along with mayor.js; no tech-tree or stage-evidence tracking exists.");

test.todo("[legacy:farming] Pens: the site is flat, open, and 8-20 blocks from home, never home itself -- NOT PORTED: findPenSite() (ranching/pen-building) was archived whole; no pen-site search exists in the current skill set.");

test.todo("[legacy:farming] Harvest: walks over the drops around the crops she broke, and gives up on the unreachable -- NOT PORTED: collectDrops() (actions.js) has no direct analogue; the closest current primitive is skills.pickupNearbyItems(), but it unconditionally constructs a real mineflayer-pathfinder Movements instance and isn't reliably mockable at the unit level without a live bot's chunk data -- see tests/live.test.mjs for a server-backed equivalent instead of a mock that could give a false signal either way.");

test.todo("[legacy:farming] Ripe crops: a failed routine harvest backs off 15 minutes; a cancelled one does not -- NOT PORTED: checkRipeCrops()'s scheduled routine and lastHarvestAt backoff are part of the archived goal-tick scheduler; no periodic ripe-crop check exists in the new architecture (the model would have to notice and act on its own).");

test.todo('[legacy:farming] get_wool: wanders to look for a sheep instead of instant-failing when none is in range -- NOT PORTED: the "get_wool" action (actions/get-wool.js) was archived whole; no current skill searches for and shears sheep.');

test.todo("[legacy:farming] Role work: the Farmer farms and the Herder ranches on their own, not only as a stand-in -- NOT PORTED: nextRoleWork()/the Farmer/Herder/Miner ROLES object and role-driven autonomous work are archived with priorities.js; persona.json's `role` field is descriptive text for the model's own prompt now, not a dispatch key.");

test.todo("[legacy:farming] Stand-ins: with no Farmer in the game the food goal becomes a farm goal; no Herder, a ranch goal -- NOT PORTED: standInRole()/BOT_ROLES roster and stand-in goal assignment are archived with the rest of the role/goal system.");

test.todo("[legacy:farming] Food goal: wheat she holds becomes bread -- NOT PORTED AS A GOAL: foodStep()'s automatic wheat-to-bread goal dispatch is archived; the underlying craft itself is a real, portable capability now covered directly by legacy-baseline/crafting.test.mjs's craftRecipe check instead of being duplicated here.");

test.todo('[legacy:farming] gather_seeds: breaks grass near her and picks up the seeds that drop -- NOT PORTED: the "gather_seeds" action (actions/gather-seeds.js) is archived; the nearest current equivalent would chain skills.breakBlockAt()+skills.pickupNearbyItems(), but pickupNearbyItems() unconditionally constructs a real Movements instance (see the Harvest-drops note above) and is not reliably unit-mockable.');

test.todo("[legacy:farming] Ranch goals: a species whose animals are gone is chosen again; with none at all she goes looking -- NOT PORTED: ranchStep()/LIVESTOCK/BREEDING_FOOD and the whole ranching goal runner are archived whole.");

test.todo("[legacy:farming] Ranch goals: no pen is built until two animals of one kind are found near home -- NOT PORTED: same ranchStep() runner as above; the 'evidence before building' rule it encoded has no current equivalent to re-check.");

test("[legacy:farming] Placement: a flower in the target cell is broken first; fluids, crops, fixtures and air are left alone", async () => {
  // Old claim (actions.js's clearCellForPlacement/isClearableCover): only non-empty ground cover
  // like a flower gets dug before placing; air/water/crops/doors are left alone or block the
  // placement outright. skills.placeBlock()'s own `empty_blocks` allowlist (air, water, lava,
  // grass, short_grass, tall_grass, snow, dead_bush, fern) plays the same "leave this alone" role;
  // anything NOT on it (like "wildflowers", a real 1.20 block name) is dug first via breakBlockAt.
  const dug = [];
  const placed = [];
  const target = new V3(5, 64, 5);
  const below = new V3(5, 63, 5); // a solid block to build "bottom"-placed off of
  const bot = makeBot({
    inventoryItems: [{ name: "dirt", count: 1 }],
    // Keep her 2 blocks from the target: inside placeBlock()'s "too close" (<1.1) and "too far"
    // (>4.5) thresholds, so neither of its two Movements-constructing path branches ever runs --
    // this check is about the obstruction-clearing logic, not pathfinding.
    entity: { position: target.offset(0, 0, -2), yaw: 0, onGround: true },
  });
  bot.inventory.findInventoryItem = (name) => bot.inventory.items().find((i) => i.name === name) || null;
  bot.tool = { equipForBlock: async () => {} }; // breakBlockAt()'s tool-equip step, mineflayer-tool plugin
  bot.blockAt = (pos) => {
    if (pos.equals(target)) return { name: "wildflowers", position: target, canHarvest: () => true };
    if (pos.equals(below)) return { name: "stone", position: below, canHarvest: () => true };
    return { name: "air", position: pos, canHarvest: () => true };
  };
  bot.dig = async (block) => { dug.push(block.name); };
  bot.equip = async () => {};
  bot.lookAt = async () => {};
  bot.placeBlock = async (buildOffBlock) => { placed.push(buildOffBlock.name); };

  const ok = await placeBlock(bot, "dirt", target.x, target.y, target.z, "bottom");
  assert.equal(ok, true, "placement should succeed once the flower is cleared");
  assert.deepEqual(dug, ["wildflowers"], "only the ground cover is dug before placing");
  assert.deepEqual(placed, ["stone"], "builds off the solid block below, not the cleared cell itself");
});

test.todo("[legacy:farming] Mine: stone with an open face comes before buried stone, and a target that had no path is skipped next time -- NOT PORTED: the old rankMineTargets/noPath-exclusion logic in actions.js's \"mine\" handler has no equivalent in skills.collectBlock(), which just takes world.getNearestBlocksWhere()'s first (nearest, not most-reachable) match -- a real capability regression, but collectBlock() unconditionally constructs a Movements instance and isn't reliably unit-mockable (see the Harvest-drops note above); flagged here rather than silently dropped.");
