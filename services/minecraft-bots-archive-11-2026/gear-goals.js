// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: bed, weapon, tool, food, stand-in and shelter-upgrade goal steps.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { writeMemoryNote } from "./longterm.js";
import { BREEDING_FOOD, bedItemFor, communalShelterMaterialCount, countInPen, farmStatus, findRememberedLocation, loadPenLocation, performAction, woolCounts } from "./actions.js";
import { hasWeapon } from "./equipment.js";
import { logStep, newGoal, saveGoal } from "./goals.js";
import { BOT_ROLES, ROLES } from "./roles.js";
import { BUILDER_PRIORITY_RADIUS, countNearHome } from "./home-scan.js";
import { SHELTER_REFACE_BATCH, nextToolUpgrade, shelterCellsToReface } from "./priorities.js";
import { broadcastGoalState, recordGoalOutcome } from "./fleet-coordination.js";
import { selfProposeResumeAt } from "./goal-proposal.js";
import { completeGoal, failGoalStep, heldCount, holdsItem, retireGoal, saveGoalIfCurrent } from "./goal-runners.js";
import { IDLE_BEFORE_SELF_GOAL_MS, PERSONA_NAME, SELF_PROPOSE_GOALS, USERNAME, bot, currentGoal, lastActivityAt, myRole, persona, setCurrentGoal } from "./index.js";
import { hasFood } from "./upkeep-inventory.js";


// Beds (2026-09-26): after the world reset nobody had a bed, "craft bed" failed for every bot, and
// the Builder's "set up more beds" went to the planner. A bed goal now runs directly, one step a
// tick: place a bed she holds, else craft one from 3 wool of a colour, else take wool from a chest
// (once), else get it from sheep. Done only when a bed is actually standing near home.
export const BED_WORDS = /\b(make|craft|build|set up|place|get|need|more)\b[^.]*?\bbeds?\b/i;
export const NOT_MAKING_A_BED = /\b(go(ing)? to|sleep(ing)? in|find a|head(ing)? to) (a |the |your |her )?bed\b/i;
const BED_GOAL = "make myself a bed and place it at home";

// Resource-gathering override (2026-10-11, PRIORITIES_PROPOSAL.md -- "when any task requires a
// resource she doesn't have, gathering that resource becomes her temporary priority, superseded
// only by defense"). The first, most-needed instance: planks specifically (not shelterStep's own
// fallback below, which wants ANY wall material and happily substitutes dirt -- a real
// difference, not the same pattern). Extracted from bedStep's own inline "craft planks from a
// held log, else mine a tree" so the communal shelter's own door (which needs planks too, for
// the exact same reason a bed does) reuses it instead of becoming a second copy. Returns null
// once she already holds `count` planks (the caller proceeds); otherwise the in-progress
// gathering step.
// 2026-10-29: planks of ONE wood, not planks in total -- every plank recipe (bed, door, sticks,
// table) is one species per craft, so Babs' 1 jungle + 1 spruce + 1 birch read as "3 planks, go
// ahead" and the bed craft failed "don't have the ingredients" 14,738 times overnight, with two
// dark oak logs in her pocket that would have made the planks.
export async function gatherPlanks(handle, count) {
  const planksOf = (wood) => heldCount((n) => n === `${wood}_planks`);
  const woods = bot.inventory.items().filter((i) => i.name.endsWith("_planks")).map((i) => i.name.replace(/_planks$/, ""));
  if (woods.some((wood) => planksOf(wood) >= count)) return null;
  const log = bot.inventory.items().find((i) => /_(log|stem)$/.test(i.name));
  if (log) {
    const wood = log.name.replace(/^stripped_/, "").replace(/_(log|stem)$/, "");
    const item = `${wood}_planks`;
    const want = Math.min(count - planksOf(wood), 4 * heldCount((n) => n === log.name));
    return { ...(await performAction(bot, { type: "craft", item, count: want }, USERNAME, handle)), action: { type: "craft", item } };
  }
  const tree = bot.findBlocks({ matching: (b) => /_log$/.test(b.name) && !b.name.startsWith("stripped_"), maxDistance: 32, count: 1 })[0];
  if (!tree) {
    // 2026-11-05 (fresh world): no tree within 32 of spawn, and every bot's first goal -- a wooden
    // sword -- failed "no tree nearby" 60+ times, blocking all work below it. "mine" goes further:
    // a remembered spot, then a wandering search, and any log answers for "oak_log".
    const mined = await performAction(bot, { type: "mine", block: "oak_log", count: Math.ceil(count / 4) }, USERNAME, handle);
    if (mined.ok || mined.cancelled) return { ...mined, action: { type: "mine", block: "oak_log" } };
    return { ok: false, noWood: true, text: `need wood: ${mined.text}`, action: { type: "mine", block: "oak_log" } };
  }
  const block = bot.blockAt(tree).name;
  return { ...(await performAction(bot, { type: "mine", block, count: Math.ceil(count / 4) }, USERNAME, handle)), action: { type: "mine", block } };
}

// Direct request, 2026-10-12 (root-caused from a real, confirmed live regression: Luke/Mark's own
// attack_win_rate collapsed to 0.167 from a 0.846 baseline). Weapon acquisition used to rely
// entirely on the generic freeform planner -- the SAME kind of multi-step "gather wood -> craft
// planks -> craft table -> craft weapon" chain this project already found unreliable everywhere
// else, which is exactly why bed/shelter/farm/ranch all got dedicated deterministic runners
// instead. Confirmed live: Luke's own "you have no sword or axe" goal fired 360 times in 24h,
// and a real "ACTION CRAFT wooden_sword 1" attempt was logged as "craft interrupted -- stopped on
// the way to a crafting table" -- almost certainly a self-defense interrupt, since decideFightType
// (below) forces flee for ANY weaponless bot regardless of role, making this a vicious cycle for
// a Soldier specifically: no weapon means constant forced fleeing, which keeps interrupting the
// one goal that would fix it. A dedicated runner, same shape as bedStep/shelterStep: a nearby/
// remembered chest first, else gatherPlanks() + craft -- reliable regardless of how many times
// self-defense knocks it off course, since (like every other dedicated runner) it just resumes
// on the next tick rather than needing a fresh multi-step plan from the model each time.
//
// Deliberately narrower than the directive's own text ("ask the fleet... if neither works"):
// skips the REQUEST-another-bot step entirely -- crafting from scratch is always achievable
// (wood exists somewhere), while waiting on a teammate who may not have a spare either, in a
// fresh-world bootstrap, is exactly the kind of unreliable path this fix exists to avoid. Targets
// wooden_sword specifically (the cheapest real weapon) rather than "sword or axe" generically --
// matching how bedStep targets one specific bed item rather than staying open-ended.
async function weaponStep(goal, handle) {
  if (hasWeapon(bot)) return { ok: true, text: "already have a real weapon.", done: true };
  if (!goal.triedWeaponChest) {
    goal.triedWeaponChest = true;
    const looted = await performAction(bot, { type: "loot", item: "sword", count: 1 }, USERNAME, handle);
    if (looted.ok || looted.cancelled) return { ...looted, action: { type: "loot", item: "sword" } };
  }
  const tableType = bot.registry.blocksByName.crafting_table;
  const tableNear = heldCount((n) => n === "crafting_table") > 0 ||
    (tableType && bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }).length > 0);
  // A wooden_sword needs 2 planks + 1 stick, and craftItem's own auto-chain already makes the
  // stick from spare planks (the same mechanism "coal + planks makes a torch" relies on) -- but
  // that stick itself costs 2 MORE planks (a stick recipe yields 4 per craft, from 2 planks, and
  // there's no way to craft fewer than a full batch). 4 total, not 2 -- found live 2026-10-13
  // (direct report "combat is better, but...") still looping, cleanly, on an occasional first
  // attempt short one log; the retry-and-resume shape already recovers either way, but the
  // correct number means one fewer wasted cycle most of the time. 4 more if she'll have to make
  // the crafting table herself too.
  const gathering = await gatherPlanks(handle, 4 + (tableNear ? 0 : 4));
  if (gathering) return gathering;
  // here: a table she carries goes down beside her, rather than a walk to one with mobs about
  // (2026-10-30: ten crafts in a row cancelled on that walk).
  return { ...(await performAction(bot, { type: "craft", item: "wooden_sword", count: 1, here: true }, USERNAME, handle)),
    action: { type: "craft", item: "wooden_sword" } };
}

export async function runWeaponGoal(goal, takeControl, getHandle, replaced) {
  if (replaced() || !(await takeControl())) return;
  const step = await weaponStep(goal, getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `weapon: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] weapon goal: ${step.text} (ok=${step.ok})`);
  if (step.done) return completeGoal(goal, "got a real weapon");
  if (step.ok) {
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, step.text);
}

export function hasPickaxe() {
  return bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
}

// Direct report, 2026-10-13 ("combat seems better, but building and tooling do not"). Pickaxe/
// axe acquisition (TECH_TREE_STAGES' own "basic tools" stage, Mayor-assigned over chat as free
// text -- "make sure you have basic tools -- at least a pickaxe and an axe...") still went
// through the generic freeform planner, the exact failure class weaponStep's own header
// documents: live evidence was Nell's "craft wooden_pickaxe" throwing a raw "Error: missing
// ingredient" (an execution race, not a clean failure) and Mark/Wade producing long, rambling
// multi-paragraph self-talk that never converged on a next step. Same shape as weaponStep, same
// deliberately narrower scope (crafts from scratch, never waits on a teammate's spare): targets
// wooden_pickaxe specifically, not "pickaxe and axe" -- a pickaxe unblocks mining everything else
// (stone, ore), while the axe is a convenience this doesn't need to chase to unblock the rest of
// the tech tree. Text-matched (TOOL_WORDS), not a survivalPriorityItem tag, because unlike
// weapon/shelter/food/armor this directive is Mayor-ASSIGNED free text, not self-proposed by this
// bot's own structured Tier 1 ladder -- there is no creation-time moment to tag it the safe way.
export async function toolStep(goal, handle) {
  if (hasPickaxe()) return { ok: true, text: "already have a pickaxe.", done: true };
  if (!goal.triedToolChest) {
    goal.triedToolChest = true;
    const looted = await performAction(bot, { type: "loot", item: "pickaxe", count: 1 }, USERNAME, handle);
    if (looted.ok || looted.cancelled) return { ...looted, action: { type: "loot", item: "pickaxe" } };
  }
  const tableType = bot.registry.blocksByName.crafting_table;
  const tableNear = heldCount((n) => n === "crafting_table") > 0 ||
    (tableType && bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }).length > 0);
  // A wooden_pickaxe needs 3 planks + 2 sticks -- the 2 sticks cost 2 more planks (one full
  // stick-batch, same accounting as weaponStep's own 4). 5 total, 4 more if she needs the table too.
  const gathering = await gatherPlanks(handle, 5 + (tableNear ? 0 : 4));
  if (gathering) return gathering;
  return { ...(await performAction(bot, { type: "craft", item: "wooden_pickaxe", count: 1 }, USERNAME, handle)),
    action: { type: "craft", item: "wooden_pickaxe" } };
}

export async function runToolGoal(goal, takeControl, getHandle, replaced) {
  if (replaced() || !(await takeControl())) return;
  const step = await toolStep(goal, getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `tool: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] tool goal: ${step.text} (ok=${step.ok})`);
  if (step.done) return completeGoal(goal, "got a pickaxe");
  if (step.ok) {
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, step.text);
}

// Tier 1 "tools" (2026-10-28, see nextToolUpgrade()): one tool per goal, the first of
// UPGRADE_TOOLS below the target tier. Material first (cobblestone mined as "stone"; iron as
// ingots, smelting raw iron she holds before mining more ore), then planks for the sticks (one
// 2-plank batch makes 4, enough for any single tool, +4 if she has to make the table), then craft.
const TOOL_HEADS = { pickaxe: 3, axe: 3, sword: 2, shovel: 1, hoe: 2 };

async function upgradeToolsStep(goal, handle) {
  const item = nextToolUpgrade();
  if (!item) return { ok: true, text: "my tools are as good as I can make them right now.", done: true };
  if (item === "wooden_pickaxe") return toolStep(goal, handle); // a chest's pickaxe, else planks and a craft
  const [tier, tool] = item.split("_");
  const need = TOOL_HEADS[tool];
  if (tier === "stone") {
    const short = need - heldCount((n) => n === "cobblestone");
    if (short > 0) {
      return { ...(await performAction(bot, { type: "mine", block: "stone", count: short }, USERNAME, handle)),
        action: { type: "mine", block: "stone" } };
    }
  } else {
    const short = need - heldCount((n) => n === "iron_ingot");
    if (short > 0) {
      const raw = heldCount((n) => n === "raw_iron");
      if (raw > 0) {
        return { ...(await performAction(bot, { type: "smelt", item: "iron_ingot", count: Math.min(raw, short) }, USERNAME, handle)),
          action: { type: "smelt", item: "iron_ingot" } };
      }
      return { ...(await performAction(bot, { type: "mine", block: "iron_ore", count: short }, USERNAME, handle)),
        action: { type: "mine", block: "iron_ore" } };
    }
  }
  const tableType = bot.registry.blocksByName.crafting_table;
  const tableNear = heldCount((n) => n === "crafting_table") > 0 ||
    (tableType && bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }).length > 0);
  if (heldCount((n) => n === "stick") < 2) {
    const gathering = await gatherPlanks(handle, 2 + (tableNear ? 0 : 4));
    if (gathering) return gathering;
  }
  return { ...(await performAction(bot, { type: "craft", item, count: 1 }, USERNAME, handle)), action: { type: "craft", item } };
}

export async function runUpgradeToolsGoal(goal, takeControl, getHandle, replaced) {
  if (replaced() || !(await takeControl())) return;
  // One tool per goal: done once the tool it set out for exists (or nothing's left to upgrade).
  goal.upgradeTarget ??= nextToolUpgrade();
  const step = await upgradeToolsStep(goal, getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `tools: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] tool upgrade goal: ${step.text} (ok=${step.ok})`);
  if (step.done || (goal.upgradeTarget && holdsItem(goal.upgradeTarget))) return completeGoal(goal, "upgraded a tool");
  if (step.ok) {
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, step.text);
}

// Tier 1 "food" (2026-10-30): its directive says "harvest a ripe crop", which FARM_WORDS matched,
// so it ran as a farm goal -- and a farm goal with no hoe and no planks only ever fails. Babs
// looped harvest/loot hoe/craft hoe every ten seconds for hours, starving, the goal re-proposed
// each time it gave up. Food is what's wanted, not a farm: hunt, else take a ripe crop.
// 2026-11-01: wheat isn't food until it's bread. And with nothing to hunt or harvest, she stands in
// for a missing Farmer or Herder (see standInRole).
async function foodStep(handle) {
  if (hasFood()) return { ok: true, text: "I have food.", done: true };
  const wheat = heldCount((n) => n === "wheat");
  if (wheat >= 3) {
    return { ...(await performAction(bot, { type: "craft", item: "bread", count: Math.floor(wheat / 3), here: true }, USERNAME, handle)),
      action: { type: "craft", item: "bread" } };
  }
  const hunted = await performAction(bot, { type: "hunt" }, USERNAME, handle);
  if (hunted.ok || hunted.cancelled) return { ...hunted, action: { type: "hunt" } };
  const harvested = await performAction(bot, { type: "harvest", onlyRipe: true }, USERNAME, handle);
  if (harvested.cancelled || hasFood()) return { ...harvested, ok: true, action: { type: "harvest" } };
  return { ok: false, text: `${hunted.text} ${harvested.text}`, action: { type: "harvest" }, standIn: standInRole() };
}

// Direct request, 2026-11-01: "there are farmer and rancher roles. they should be universal at
// need, when no bot with that role is in game." Babs and Amy hunted out the chickens near home
// with Bob (Farmer) and Dale (Herder) offline and nobody growing or breeding anything. A role is
// covered while a bot holding it as her primary is logged in -- this bot included.
function roleInGame(roleName) {
  const online = new Set(Object.keys(bot.players ?? {}).map((name) => name.toLowerCase()));
  return Object.entries(BOT_ROLES).some(([persona, roles]) => roles.primary?.name === roleName && online.has(persona));
}

// Farming first: seeds come from grass and a plot from open ground near home. A ranch needs a pen
// and two animals of a kind, so it waits until a farm stand-in has recently given up.
const STAND_IN_GOALS = {
  farm: { role: "Farmer", description: "no Farmer is in the game -- start a farm near home: till ground, plant seeds, and bring back food from it" },
  ranch: { role: "Herder", description: "no Herder is in the game -- breed livestock near home for food: build a pen and breed a pair" },
};
const STAND_IN_RETRY_MS = 30 * 60_000;
export const standInGaveUpAt = { farm: 0, ranch: 0 };

// 2026-11-05: or it's her own role. roleInGame() counts her too, so a hungry Farmer with nothing
// to hunt never farmed -- the Farmer was "in the game" -- and the farm plots went back to grass.
function standInRole() {
  return Object.keys(STAND_IN_GOALS).find((task) => (!roleInGame(STAND_IN_GOALS[task].role) ||
    myRole?.primary?.name === STAND_IN_GOALS[task].role) &&
    Date.now() - standInGaveUpAt[task] >= STAND_IN_RETRY_MS) ?? null;
}

// Role work (2026-11-05, direct report: "the herder is not herding, and no-one is farming. the farm
// plots have all reverted to grass"). Nothing ever gave the Farmer or the Herder their own job:
// farming and ranching ran only as a hungry bot's stand-in -- off whenever a bot with the role was
// online, even for that bot -- or as the Builder checklist's last item, done for good after one
// breeding. Right after Tier 1 survival, ahead of the shared checklist: the Farmer tends the farm
// whenever nothing is growing or something is ripe; the Herder builds the herd up to
// RANCH_HERD_TARGET penned animals. A goal given up waits ROLE_WORK_RETRY_MS.
const ROLE_WORK_RETRY_MS = 30 * 60_000;
const RANCH_HERD_TARGET = 6;
export const roleWorkGaveUpAt = { farm: 0, ranch: 0 };
const ROLE_WORK_DIRECTIVES = {
  farm: "you're the Farmer -- tend the farm near home: till ground, plant seeds, and harvest what's ripe for the fleet",
  ranch: "you're the Herder -- build up the herd near home: a pen, two animals of one kind led into it, and breed them",
};

export async function nextRoleWork() {
  const role = myRole?.primary;
  if (role === ROLES.FARMER && Date.now() - roleWorkGaveUpAt.farm >= ROLE_WORK_RETRY_MS) {
    const status = farmStatus(bot, bot.spawnPoint ?? null);
    if (status.ripe || !status.growing) return { task: "farm", directive: ROLE_WORK_DIRECTIVES.farm };
  }
  if (role === ROLES.HERDER && Date.now() - roleWorkGaveUpAt.ranch >= ROLE_WORK_RETRY_MS) {
    const pen = await loadPenLocation();
    const penned = pen ? Object.keys(BREEDING_FOOD).reduce((n, species) => n + countInPen(bot, pen, species), 0) : 0;
    if (penned < RANCH_HERD_TARGET) return { task: "ranch", directive: ROLE_WORK_DIRECTIVES.ranch };
  }
  return null;
}

async function startStandInGoal(foodGoal, task) {
  const description = myRole?.primary?.name === STAND_IN_GOALS[task].role
    ? ROLE_WORK_DIRECTIVES[task] : STAND_IN_GOALS[task].description;
  console.log(`[${USERNAME}] food goal: nothing to hunt or harvest -- standing in: ${description}`);
  recordGoalOutcome(foodGoal.description, "handed off", description);
  await retireGoal(foodGoal);
  setCurrentGoal(newGoal({ description, source: "self" }));
  currentGoal.farmTask = task;
  currentGoal.standIn = true;
  await saveGoal(PERSONA_NAME, currentGoal);
  await broadcastGoalState("active", description);
}

// 2026-11-01: a step that finds nothing fails in under 100ms, and goal ticks come every 2s -- Babs
// and Amy each ran ~500 food steps an hour, re-proposing the goal every 40s. Nothing to hunt now
// usually means nothing to hunt for a while.
const FOOD_RETRY_MS = 30_000;

export async function runFoodGoal(goal, takeControl, getHandle, replaced) {
  if (Date.now() < (goal.foodRetryAt ?? 0)) return;
  if (replaced() || !(await takeControl())) return;
  const step = await foodStep(getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `food: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] food goal: ${step.text} (ok=${step.ok})`);
  if (hasFood()) return completeGoal(goal, "got food");
  if (step.standIn) return startStandInGoal(goal, step.standIn);
  goal.foodRetryAt = Date.now() + FOOD_RETRY_MS;
  await failGoalStep(goal, step.text);
}

// Tier 1 "shelter_upgrade" (2026-10-28, see shelterCellsToReface()): one batch of up to
// SHELTER_REFACE_BATCH dirt/wood cells swapped for stone per goal -- "gradually", per the request,
// and short enough that her shelter is never open for long. Cobblestone first (mined as "stone").
async function shelterUpgradeStep(goal, handle) {
  if (!hasPickaxe()) return { ...(await toolStep(goal, handle)), done: false }; // a goal saved before 2026-11-04
  const cells = shelterCellsToReface();
  if (!cells.length) return { ok: true, text: "my shelter is all stone already.", done: true };
  const batch = cells.slice(0, SHELTER_REFACE_BATCH);
  const short = batch.length - communalShelterMaterialCount(bot);
  if (short > 0) {
    return { ...(await performAction(bot, { type: "mine", block: "stone", count: short }, USERNAME, handle)),
      action: { type: "mine", block: "stone" } };
  }
  const refaced = await performAction(bot, { type: "reface_shelter", cells: batch }, USERNAME, handle);
  return { ...refaced, done: refaced.ok && refaced.refaced > 0, action: { type: "reface_shelter" } };
}

export async function runShelterUpgradeGoal(goal, takeControl, getHandle, replaced) {
  if (replaced() || !(await takeControl())) return;
  const step = await shelterUpgradeStep(goal, getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `shelter upgrade: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] shelter upgrade goal: ${step.text} (ok=${step.ok})`);
  if (step.done) return completeGoal(goal, "reinforced the shelter with stone");
  if (step.ok) {
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, step.text);
}

export async function bedStep(goal, handle) {
  if (bot.inventory.items().some((i) => i.name.endsWith("_bed"))) {
    // 2026-10-27 (direct request: "if exploring, and far away from a known bed listed in world
    // resources, they should try to build a new one"): place_bed already supports an arbitrary
    // action.near (added for the communal shelter) -- it was just never pointed anywhere but
    // home for an individual bed. A bot who wandered far on an explore/gather goal shouldn't have
    // to walk all the way back home just to place the bed she's already holding; build it where
    // she is instead, once she's genuinely far from BOTH home and any remembered bed.
    let near = null;
    if (bot.spawnPoint && bot.entity.position.distanceTo(bot.spawnPoint) > BUILDER_PRIORITY_RADIUS) {
      const remembered = await findRememberedLocation("bed", bot.entity.position).catch(() => null);
      const rememberedIsFar = !remembered || bot.entity.position.distanceTo(remembered) > BUILDER_PRIORITY_RADIUS;
      if (rememberedIsFar) near = bot.entity.position;
    }
    const placed = await performAction(bot, near
      ? { type: "place_bed", near: { x: near.x, y: near.y, z: near.z } }
      : { type: "place_bed" }, USERNAME, handle);
    return { ...placed, done: !!placed.bedAt, action: { type: "place_bed" } };
  }
  if (Math.max(0, ...Object.values(woolCounts(bot))) >= 3) {
    // Wood first (live, 2026-09-26: Mark and Bob had the wool and failed "don't have the
    // ingredients"): 3 planks for the bed, 4 more if she'll have to make the crafting table too.
    const tableType = bot.registry.blocksByName.crafting_table;
    const tableNear = heldCount((n) => n === "crafting_table") > 0 ||
      (tableType && bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }).length > 0);
    const gathering = await gatherPlanks(handle, 3 + (tableNear ? 0 : 4));
    if (gathering) return gathering;
    const item = bedItemFor(bot);
    return { ...(await performAction(bot, { type: "craft", item, count: 1 }, USERNAME, handle)), action: { type: "craft", item } };
  }
  if (!goal.triedWoolChest) {
    goal.triedWoolChest = true;
    const looted = await performAction(bot, { type: "loot", item: "wool", count: 3 }, USERNAME, handle);
    if (looted.ok || looted.cancelled) return { ...looted, action: { type: "loot", item: "wool" } };
  }
  return { ...(await performAction(bot, { type: "get_wool", count: 3 }, USERNAME, handle)), action: { type: "get_wool" } };
}

export async function runBedGoal(goal, takeControl, getHandle, replaced) {
  if (replaced() || !(await takeControl())) return;
  const step = await bedStep(goal, getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `bed: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] bed goal: ${step.text} (ok=${step.ok})`);
  if (step.done) {
    // 2026-10-27 (direct request: "all resources, including buildable resources, should be
    // registered to the RAG"): same convention runBuilderPlacement()/runShelterGoal() now use.
    if (step.bedAt) {
      writeMemoryNote({ scope: "world", persona: PERSONA_NAME, text: `Built a bed near ` +
        `(${step.bedAt.x}, ${step.bedAt.y}, ${step.bedAt.z}), as of ${new Date().toISOString()}.` })
        .catch((err) => console.error(`[${USERNAME}] bed memory write failed:`, err.message));
    }
    return completeGoal(goal, "placed a bed");
  }
  if (step.ok) {
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, step.text);
}

// A night with no bed anywhere near: with nothing else on, she makes her own in the morning (goals
// pause overnight). Found live: all nine failed "sleep" every few minutes after the reset. Same
// rules as any self-proposed goal -- a player's STOP a minute ago still means stop (live test MB-05).
export function bedsNearHome() {
  const bedNames = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith("_bed"));
  return countNearHome(bedNames, (block) => block?.getProperties?.().part === "head");
}

export async function wantBed() {
  if (currentGoal || !SELF_PROPOSE_GOALS || Date.now() < selfProposeResumeAt ||
      Date.now() - lastActivityAt < IDLE_BEFORE_SELF_GOAL_MS) return;
  setCurrentGoal(newGoal({ description: BED_GOAL, source: "self" }));
  currentGoal.farmTask = "bed";
  await saveGoal(PERSONA_NAME, currentGoal);
  await broadcastGoalState("active", BED_GOAL);
  console.log(`[${USERNAME}] no bed to sleep in -- new goal: ${BED_GOAL}`);
}
