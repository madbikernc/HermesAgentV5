// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/crafting-1.test.mjs and tests/unit/crafting-2.test.mjs
// against the Mindcraft-ported architecture (skills.js/mcdata.js/equipment.js). See
// services/minecraft-bots-archive-11-2026/ for the archived "best past implementation" (actions.js's
// craftItem/smeltAction, index.js's gatherPlanks/nextToolUpgrade/priorities) this measures against.
// Run: node --test services/minecraft-bots/tests/legacy-baseline/crafting.test.mjs
//
// Unlike tests/unit/_harness.mjs (vm + string-sliced OLD source), every real test below imports the
// REAL current skills.js/equipment.js and drives them with a mineflayer-shaped mock bot
// (tests/legacy-baseline/_mockbot.mjs). Checks whose old behavior depended on now-archived
// architecture (the goal engine, priorities.js's tool/survival tiers, longterm.js/rag-backend.js's
// remembered locations, actions.js's own chain-crafting helper) are test.todo(...) with the specific
// removed mechanism named -- never silently dropped, per this project's CLAUDE.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { craftRecipe, smeltItem } from "../../skills.js";
import * as mc from "../../mcdata.js";
import { equipBestArmor, normalizeEnchants, installEnchantsFix } from "../../equipment.js";
import { makeBot, V3 } from "./_mockbot.mjs";

// ---- Real behavioral tests -------------------------------------------------------------------

// [legacy:crafting-1] "MB-07 armor selection keeps better worn armor and converges" -- ported
// verbatim in spirit: equipment.js itself is unchanged by the Mindcraft port (not one of the four
// ported files), so this is the closest thing to a direct carry-over in this whole suite.
test("[legacy:crafting] MB-07 armor selection keeps better worn armor, and only re-equips on a strictly better carried piece", async () => {
  const slots = [];
  slots[5] = { name: "netherite_helmet" };
  let equips = 0;
  const bot = {
    inventory: { items: () => [{ name: "leather_helmet" }], slots },
    getEquipmentDestSlot: (s) => ({ head: 5, torso: 6, legs: 7, feet: 8 })[s],
    async equip() { equips++; },
  };
  await equipBestArmor(bot);
  await equipBestArmor(bot);
  assert.equal(equips, 0, "a netherite helmet worn beats a leather one carried -- no swap");

  slots[5] = { name: "leather_helmet" };
  bot.inventory.items = () => [{ name: "iron_helmet" }];
  await equipBestArmor(bot);
  assert.equal(equips, 1, "a strictly better carried piece is equipped");
});

// [legacy:crafting-1] "Enchants: the 1.21 component shape becomes [{ name, lvl }]..." -- same file,
// unchanged logic; ported close to verbatim.
test("[legacy:crafting] Enchants: the 1.21 component shape normalizes to [{ name, lvl }], so digging with enchanted gear works", async () => {
  const registry = { enchantments: { 33: { name: "sharpness" }, 40: { name: "unbreaking" } } };
  const raw = { enchantments: [{ id: 33, level: 5 }, { id: 40, level: 3 }] }; // captured live from the server
  assert.deepEqual(normalizeEnchants(raw, registry).map((e) => ({ ...e })), [{ name: "sharpness", lvl: 5 }, { name: "unbreaking", lvl: 3 }]);
  assert.equal(normalizeEnchants([], registry).length, 0, "an already-array passes through unchanged");

  class Item {
    get enchants() { return raw; }
  }
  const bot = makeBot({ registry, inventory: { slots: [null, new Item()], items: () => [] } });
  installEnchantsFix(bot);
  installEnchantsFix(bot); // idempotent
  const held = new Item().enchants;
  assert(Array.isArray(held));
  assert.equal([].concat(held).length, 2, "what mineflayer's digTime() does with it");
});

// [legacy:crafting-1] "Craft: a table-needing recipe is detected even with empty hands..." and
// "...even when a DIFFERENT, unusable no-table recipe also exists" -- consolidated into one test.
// craftRecipe() (skills.js) doesn't need the old tableWouldHelp heuristic those two checks existed
// to fix: it just tries bot.recipesFor(id, null, 1, null) then, if empty, bot.recipesFor(id, null, 1,
// true) directly -- so an unrelated no-table recipe existing can't fool it, by construction. This
// proves that still holds against the real function.
test("[legacy:crafting] Craft: an empty-handed recipe lookup that needs a table searches for a real one nearby, not a guess", async () => {
  const bot = makeBot({ inventory: { items: () => [], slots: [] } });
  // getItemCraftingRecipes()/getBlockId() need a real minecraft-data registry (bot.version) --
  // this is the same lookup craftRecipe() itself uses to decide "does this item have ANY recipe"
  // and to resolve the crafting_table block id world.getNearestBlock() searches for.
  bot.version = "1.20.1";
  const tableBlockId = mc.getBlockId(bot, "crafting_table");
  let withTable = false;
  bot.recipesFor = (_id, _m, _min, table) => (table ? [{ result: { id: 1, count: 1 }, ingredients: [] }] : []);
  // Within 4 blocks on purpose: craftRecipe() only calls goToNearestBlock() (real pathfinding,
  // real mineflayer-pathfinder Movements -- too deep to mock lightly here) when the table it
  // found is farther than that. Staying close keeps this a fast, real exercise of the detection
  // logic itself without needing a full pathfinding double.
  bot.findBlocks = (opts) => (opts.matching({ type: tableBlockId }) ? [new V3(2, 64, 0)] : []);
  bot.blockAt = (p) => ({ name: "crafting_table", position: p, type: tableBlockId, getProperties: () => ({}) });
  bot.craft = async () => { withTable = true; };
  const ok = await craftRecipe(bot, "wooden_pickaxe", 1);
  assert.equal(ok, true, bot.output);
  assert(withTable, "crafted using the table-aware recipe lookup, not the empty-handed one -- it found the real table instead of reporting \"no ingredients\"");
});

// [legacy:crafting-1] "Craft: a count is items wanted, not recipe runs" -- the behavioral claim the
// old craftItem() existed to guarantee (mineflayer's craft() reads a stale inventory across runs,
// so count had to become N single-item runs). craftRecipe() (skills.js 58) has no such loop: it
// calls `bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable)` exactly once. Documented
// here as a real, named regression risk rather than silently ported away: if this project ever
// hits that mineflayer bug again on a multi-item craft, this is the function that would need the
// old per-run workaround back.
test("[legacy:crafting] Craft: a multi-item craft is one single bot.craft() call, not one run per item (regression risk vs. the old per-run workaround)", async () => {
  const runs = [];
  const bot = makeBot({
    registry: { itemsByName: { oak_planks: { id: 1 } }, blocksByName: {} },
    inventory: { items: () => [{ name: "oak_log", count: 10 }], slots: [] },
  });
  bot.version = "1.20.1";
  // An empty ingredients list keeps calculateLimitingResource()'s result deterministic (no
  // resource can be the limiter, so craftLimit.num stays Infinity) without needing to guess a
  // real item id's exact minecraft-data mapping just to make it never-limiting.
  bot.recipesFor = (_id, _m, _min) => [{ result: { id: 1, count: 4 }, ingredients: [] }];
  bot.craft = async (_recipe, count) => { runs.push(count); };
  await craftRecipe(bot, "oak_planks", 30);
  assert.deepEqual(runs, [30], "craftRecipe asks mineflayer's craft() to run the recipe 30 times in one call -- the old code deliberately never did this (ran it 8 times, once per output batch)");
});

// [legacy:crafting-1 #14, crafting-2 #5/#6/#12] "the ingredient chain makes enough for every run"
// (23 fences need 16 sticks), "the auto-chain works for shaped recipes too" (torch from coal+
// planks), "a wooden hoe from birch planks" (chain by item id), "a torch from coal and logs" --
// all four prove the SAME now-missing capability: the old actions.js craftItem() auto-crafted
// missing intermediate ingredients (sticks, planks) before the final item. craftRecipe() (skills.js,
// ported from Mindcraft) does not chain-craft at all -- it only ever looks at bot.recipesFor() for
// the one target item, right now. Real test, not test.todo: this is a genuine capability regression
// a bot can hit today (e.g. "craft a fence" with planks but no sticks), worth tracking as the
// baseline score moves.
test("[legacy:crafting] Craft: craftRecipe does not auto-chain-craft a missing intermediate ingredient (e.g. sticks before a fence)", async () => {
  const bot = makeBot({
    registry: { itemsByName: { birch_fence: { id: 7 } }, blocksByName: {} },
    // Planks to spare, but no sticks -- the old code would have crafted sticks first.
    inventory: { items: () => [{ name: "birch_planks", count: 40 }], slots: [] },
  });
  bot.version = "1.20.1";
  bot.recipesFor = () => []; // no stick on hand -- real recipesFor() would return nothing affordable right now
  let crafted = false;
  bot.craft = async () => { crafted = true; };
  const ok = await craftRecipe(bot, "birch_fence", 1);
  assert.equal(ok, false, "with no sticks and no chain-crafting, craftRecipe cannot make the fence");
  assert.equal(crafted, false);
});

// [legacy:crafting-2] "Smelt stopped mid-batch closes the furnace window" -- smeltItem()'s own
// while-loop (skills.js 197) checks bot.interrupt_code every iteration and, on break, still runs
// takeInput/takeFuel/closeWindow below the loop -- a different mechanism than the old dedicated
// cancel-token/'close'-event helper, but the same outcome (the window is never left open on a
// cancel). Fast to test: interrupt_code flips true as a side effect of putInput, so the loop body
// never has to run.
test("[legacy:crafting] Smelt: interrupting mid-batch still closes the furnace window", async () => {
  // smeltItem(bot, itemName, num)'s itemName is the RAW/smeltable input (mc.isSmeltable() checks
  // for "raw"/"log"/etc.), not the smelted output -- "raw_iron" in, iron_ingot out.
  let closed = 0;
  // world.getInventoryCounts() (called inside smeltItem) reads bot.inventory.slots, not items()
  // -- both need the real raw_iron entry, or the "enough to smelt" check fails before putInput.
  const bot = makeBot({ inventory: { items: () => [{ name: "raw_iron", count: 3 }], slots: [{ name: "raw_iron", count: 3 }] } });
  bot.version = "1.20.1";
  const furnaceBlockId = mc.getBlockId(bot, "furnace");
  bot.findBlocks = (opts) => (opts.matching({ type: furnaceBlockId }) ? [new V3(1, 64, 0)] : []);
  bot.blockAt = (p) => ({ name: "furnace", position: p, type: furnaceBlockId, getProperties: () => ({}) });
  const furnace = {
    inputItem: () => null, // nothing cooking yet -- skips the "already smelting something else" check
    fuelItem: () => ({ type: mc.getItemId(bot, "coal"), count: 3 }), // already fuelled -- skips the put-fuel step
    outputItem: () => null,
    putInput: async () => { bot.interrupt_code = true; }, // the mid-batch interruption
    takeInput: async () => null,
    takeFuel: async () => null,
    takeOutput: async () => null,
  };
  bot.openFurnace = async () => furnace;
  bot.closeWindow = async () => { closed++; };
  await smeltItem(bot, "raw_iron", 3);
  assert.equal(closed, 1, "the furnace window is closed even though the batch was interrupted, not left open");
});

// ---- Mechanism-level gaps: no current equivalent, named rather than silently skipped ----------

test.todo("[legacy:crafting-1] EFF gear refresh does nothing when no gear changed -- NOT PORTED: actions.js's periodic lastGearSignature-cached refresh loop was archived whole; index.js 4.x only calls equipBestArmor/equipBestWeapon once at spawn (plus whatever !equipBestGear is invoked explicitly), no periodic dedup-on-no-change loop exists to test.");

test.todo("[legacy:crafting-1] Resource-gathering override: gatherPlanks crafts from a held log, else mines a tree -- NOT PORTED: gatherPlanks lived in the archived goal engine (index.js's old gatherPlanks(), called from bedStep/weaponStep); there is no automatic 'need planks, go get them' override in the Mindcraft-ported decision loop at all.");

test.todo("[legacy:crafting-1] Resource-gathering override: TOOL_WORDS never collides with weaponStep's own text -- NOT PORTED: TOOL_WORDS/weaponStep/the freeform planner they fed are all archived with index.js's old goal engine; the new decision loop has no text-match-to-goal-type dispatch to test.");

test.todo("[legacy:crafting-1] Craft: an urgent craft ('here') puts a carried table down beside her instead of walking to a far one -- NOT PORTED: the 'here'/urgency flag was goal-engine threading (weaponStep's own craft directive); craftRecipe() has no urgency concept -- it always evaluates distance-to-table the same way regardless of caller.");

test.todo("[legacy:crafting-1] Craft: a reusable utility block found via remembered location skips making a duplicate -- NOT PORTED: 'remembered location' was longterm.js/rag-backend.js's visitRememberedSpot, both fully archived; craftRecipe() only ever looks at what world.getNearestBlock finds locally visible right now.");

test.todo("[legacy:crafting-1] Craft: finding an already-placed utility block nearby gets remembered too -- NOT PORTED: noteNearbyResources()/goalTick's environmental-memory write-back lived in the archived goal engine; there is no memory layer in the new decision loop to record this into.");

test.todo("[legacy:crafting-1] Craft: a dropped 2x2 craft run's ingredients come back out of the grid -- NOT PORTED (narrower than inapplicable): this guarded against a mineflayer bug that only manifests across MULTIPLE bot.craft() runs; craftRecipe() makes exactly one bot.craft() call per invocation (see the 'one single call' test above), so the multi-run grid-recovery scenario this guarded doesn't arise the same way -- a single bulk-count call could still drop output, but that needs live-server verification, not a unit mock.");

test.todo("[legacy:crafting-1] Craft: an ingredient stack left on the cursor goes back and is used -- NOT PORTED: same root cause as the 2x2-grid check above (a multi-run cursor-recovery workaround); craftRecipe()'s single-call shape doesn't hit the scenario this guarded against.");

test.todo("[legacy:crafting-2] Smelt waits for the batch and stops on a closed furnace window -- NOT PORTED (test-speed, not inapplicable): smeltItem()'s poll loop (skills.js 197) has no furnace 'close'-event listener at all, unlike the old dedicated waitForSmeltOutput() helper -- it only notices via 11 seconds of no output progress or bot.interrupt_code. A real gap, but only honestly testable with an 11s+ wait; belongs in live.test.mjs as a live scenario, not this fast unit-style file.");

test.todo("[legacy:crafting-2] Tool upgrades: stone once she can mine it, iron once she can smelt, all five tools -- NOT PORTED: nextToolUpgrade()'s deterministic tool-tier ladder lived in the archived priorities.js/index.js goal engine; tool choice is now left entirely to the muse decision loop's own judgment, with no tier function to test.");

test.todo("[legacy:crafting-2] Tool upgrades: the step gets the material, smelts raw iron before mining more, then crafts -- NOT PORTED: upgradeToolsStep()/runUpgradeToolsGoal() are archived with the goal engine; no equivalent dedicated runner exists.");

test.todo("[legacy:crafting-2] Crafting: a plank type comes only from its own wood's log (simpleSourceFor) -- NOT PORTED: simpleSourceFor() was actions.js's own chain-crafting helper, archived whole along with craftItem(); mcdata.js/skills.js have no equivalent 'what feeds this recipe' lookup (see the chain-crafting regression test above, which covers the capability this fed).");

test.todo("[legacy:crafting-2] Torches: the light test uses the registry and real blocks, never the frozen block.light -- NOT PORTED: lightSourceBlockIds()/litNearby() were tunneling.js's own registry-driven scan, archived whole; the new world.shouldPlaceTorch() (world.js 213) only checks 'is there a torch within 6 blocks', a much simpler, unrelated mechanism.");

test.todo("[legacy:crafting-2] Torches: the trail fires between digs, not into one, and remembers where the last went -- NOT PORTED: installTorchTrail() and its spacing/memory state are archived with tunneling.js; the ported autoLight()/shouldPlaceTorch() (skills.js/world.js) place a torch at the bot's own feet when dark and none is nearby, with no trail-spacing concept at all.");

test.todo("[legacy:crafting-2] Tools: with no pickaxe at all, the Tier 1 upgrade is a wooden pickaxe, and stone reinforcement waits for one -- NOT PORTED: nextSurvivalPriority()'s tool-tier branch is archived with priorities.js; see the general survival-tiers gap noted in the beds/control legacy-baseline files.");

test.todo("[legacy:crafting-2] Builder: a furnace she does not hold is made -- stone mined, else a pickaxe first -- not left to the planner -- NOT PORTED: runBuilderPlacement()/builderPriorityItem are archived with the goal engine; placement decisions are now entirely the muse decision loop's call, dispatched through commands.js's !craftRecipe/!placeHere, with no dedicated builder runner to test.");
