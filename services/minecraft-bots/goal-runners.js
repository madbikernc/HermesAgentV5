// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: goal retirement, guard duty, builder placement, the farm and ranch runners.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { writeMemoryNote } from "./longterm.js";
import { BREEDING_FOOD, LIVESTOCK, countInPen, farmStatus, findPenSite, loadPenLocation, performAction, releaseBuilderItem } from "./actions.js";
import { clearGoal, logStep, saveGoal } from "./goals.js";
import { narrateAction } from "./chat.js";
import { builderPriorityItemSatisfied, nextSoldierPriority } from "./priorities.js";
import { Vec3 } from "vec3";
import { broadcastGoalState, recordGoalOutcome } from "./fleet-coordination.js";
import { BED_WORDS, NOT_MAKING_A_BED, gatherPlanks, hasPickaxe, roleWorkGaveUpAt, standInGaveUpAt, toolStep } from "./gear-goals.js";
import { MAX_CONSECUTIVE_FAILURES, PERSONA_NAME, USERNAME, bot, currentGoal, setCurrentGoal } from "./index.js";
import { SHELTER_WORDS } from "./shelter-goals.js";


// Goal-identity guards for goalTick (review MB-05): clear/persist only if `goal` is still the
// bot's current goal, so an old tick finishing late can't erase or overwrite its replacement.
export async function retireGoal(goal) {
  if (currentGoal !== goal) return;
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 claim, §1 PR2): freed the moment the goal that held
  // it ends, success or not, rather than waiting out BUILDER_CLAIM_TTL_MS -- a bot who just
  // finished (or gave up on) an infrastructure item lets another idle bot pick up a DIFFERENT one
  // right away instead of seeing it claimed for up to another 10 minutes.
  if (goal.builderPriorityItem) await releaseBuilderItem(bot).catch((err) => console.error(`[${USERNAME}] failed to release builder claim:`, err.message));
  setCurrentGoal(null);
  await clearGoal(PERSONA_NAME);
}

export async function saveGoalIfCurrent(goal) {
  if (currentGoal === goal) await saveGoal(PERSONA_NAME, goal);
}

export const SKILL_RECHECK_MS = 10 * 60_000;

// Standing guard duty (efficiency pass, 2026-09-24): no planner call. Ends the goal as soon as
// the Soldier's real priority is something else (no weapon, a monster to hunt), otherwise just
// keeps her within GUARD_RADIUS of home. Threats themselves are handled by checkSelfDefense as
// always.
//
// 2026-10-11 (PRIORITIES_PROPOSAL.md §2a): "escort" (the non-anchor Soldier's own standing
// priority) reuses this exact same ends-on-priority-change shape -- the same "811 guard goals a
// day, each one immediately re-proposed" churn this function was built to stop would hit a
// second vague, ongoing directive just as hard if it went through the normal planner instead.
// The one real difference: no fixed position to hold, so it skips the GUARD_RADIUS homing walk
// entirely and just stays assigned until her priority actually changes.
const GUARD_RADIUS = 12;
export async function guardTick(goal, takeControl, getHandle) {
  const priority = await nextSoldierPriority();
  if (priority.name !== goal.standing) {
    console.log(`[${USERNAME}] ${goal.standing} duty ends -- new priority: ${priority.name}`);
    recordGoalOutcome(goal.description, "done", null);
    await broadcastGoalState("done", goal.description);
    await retireGoal(goal);
    return;
  }
  if (goal.standing !== "guard") return; // escort: nothing to hold a position for
  const home = bot.spawnPoint;
  if (!home || !bot.entity || bot.entity.position.distanceTo(home) <= GUARD_RADIUS) return;
  if (currentGoal !== goal || !(await takeControl())) return;
  const result = await performAction(bot, { type: "gohome" }, USERNAME, getHandle());
  console.log(`[${USERNAME}] guard duty: back to post -- ${result.text} (ok=${result.ok})`);
}

export const HOME_PLACEABLE = new Set(["crafting_table", "furnace", "chest", "beehive"]);

// 2026-11-04 (24h review): "go home and place a furnace there" went to the planner whenever she
// didn't already hold one, and the planner answered "DONE NONE" -- rejected, since no usable furnace
// stands at home -- 421 times in a day, with nothing ever making one. A crafting table, furnace or
// chest is made here, one step per tick (material, then the craft), and placed by the same runner
// once it's in hand. A furnace's cobblestone needs a pickaxe, so that comes first.
export const BUILDER_CRAFTABLE = new Set(["crafting_table", "furnace", "chest"]);
const BUILDER_COBBLESTONE = 8;

export async function builderAcquireStep(item, goal, handle) {
  const tableType = bot.registry.blocksByName.crafting_table;
  const tableNear = item === "crafting_table" || heldCount((n) => n === "crafting_table") > 0 ||
    (tableType && bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }).length > 0);
  if (item === "furnace") {
    const short = BUILDER_COBBLESTONE - heldCount((n) => n === "cobblestone");
    if (short > 0) {
      if (!hasPickaxe()) return toolStep(goal, handle);
      return { ...(await performAction(bot, { type: "mine", block: "stone", count: short }, USERNAME, handle)),
        action: { type: "mine", block: "stone" } };
    }
  }
  const planks = { crafting_table: 4, chest: 8, furnace: 0 }[item] + (tableNear ? 0 : 4);
  if (planks > 0) {
    const gathering = await gatherPlanks(handle, planks);
    if (gathering) return gathering;
  }
  return { ...(await performAction(bot, { type: "craft", item, count: 1 }, USERNAME, handle)), action: { type: "craft", item } };
}

export async function runBuilderPlacement(goal, takeControl, getHandle, replaced) {
  const item = goal.builderPriorityItem;
  if (replaced() || !(await takeControl())) return;
  if (!holdsItem(item)) {
    const step = await builderAcquireStep(item, goal, getHandle());
    getHandle()?.release();
    if (step.cancelled || replaced()) return;
    logStep(goal, `${item}: ${step.text}`, step.ok, step.action);
    console.log(`[${USERNAME}] builder ${item}: ${step.text} (ok=${step.ok})`);
    if (step.ok) {
      goal.consecutiveFailures = 0;
      await saveGoalIfCurrent(goal);
      return;
    }
    return failGoalStep(goal, step.text);
  }
  const result = await performAction(bot, { type: "place_home", item }, USERNAME, getHandle());
  getHandle().release();
  if (result.cancelled || replaced()) return;
  logStep(goal, `place_home: ${result.text}`, result.ok, { type: "place_home", item });
  if (result.ok && builderPriorityItemSatisfied(item)) {
    console.log(`[${USERNAME}] goal complete (placed ${item} at home): ${goal.description}`);
    bot.chat(await narrateAction(`goal complete: ${goal.description}.`));
    recordGoalOutcome(goal.description, "done", null);
    await broadcastGoalState("done", goal.description, item);
    // 2026-10-27 (direct request: "all resources, including buildable resources, should be
    // registered to the RAG"): same fleet-wide convention noteNearbyResources() already uses for
    // raw ore veins, so crafting_table/furnace/chest/beehive built via the Builder checklist
    // become discoverable the same way, closing the spark/spark2 split for chest specifically
    // (known_chests.json is per-host; this note isn't). place_home's own result carries no
    // position, and this placement is always "at home" anyway, so bot.spawnPoint is the real
    // position here, not a stand-in.
    if (bot.spawnPoint) {
      writeMemoryNote({ scope: "world", persona: PERSONA_NAME, text: `Built a ${item} near ` +
        `(${bot.spawnPoint.x}, ${bot.spawnPoint.y}, ${bot.spawnPoint.z}), as of ${new Date().toISOString()}.` })
        .catch((err) => console.error(`[${USERNAME}] ${item} memory write failed:`, err.message));
    }
    await retireGoal(goal);
    return;
  }
  goal.consecutiveFailures += 1;
  console.log(`[${USERNAME}] builder placement of ${item} didn't stick (${result.text}); ` +
              `consecutiveFailures=${goal.consecutiveFailures}`);
  if (goal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    recordGoalOutcome(goal.description, "gave up", `couldn't place ${item} at home`);
    await broadcastGoalState("abandoned", goal.description);
    await retireGoal(goal);
    return;
  }
  await saveGoalIfCurrent(goal);
}

export function holdsItem(name) {
  return bot.inventory.items().some((i) => i.name === name) ||
    [5, 6, 7, 8, 45].some((slot) => bot.inventory.slots[slot]?.name === name);
}

// ---- farm and ranch goals (2026-09-25) ---------------------------------------------------------
// A day of logs: farming goals issued all day, and the planner chose zero farm or ranch steps --
// its first answer to "till the ground, plant seeds" was a hallucinated "DONE wheat", and the
// stored-skill lookup matched "Mine and Craft" to it. Ranching was never asked for at all. These
// goals now run their actions directly, one step per goal tick, like builder placement and guard
// duty, and finish only on a verified result (a crop actually harvested, a baby actually born).
const FARM_WORDS = /\b(farm(ing|land)?|till(ing|ed)?|crops?|sow(ing)?|plant(ing)? (some |the )?(seeds|crops|wheat|carrots|potatoes|beetroots?))\b/i;
const NOT_A_CROP_FARM = /\b(iron|xp|mob|tree|gold|sugar ?cane|wool|honey|bee|fish) farm/i;
const RANCH_WORDS = /\b(ranch(ing)?|breed(ing)?|livestock|(animal|cow|sheep|pig|chicken) pen|herd(ing)?)\b/i;

// 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a): checked BEFORE the plain SHELTER_WORDS
// below, which would otherwise also match "communal shelter" text (it just requires the word
// "shelter" somewhere near a build/make verb) and route it to the wrong, individual-shelter runner.
const COMMUNAL_SHELTER_WORDS = /\bcommunal\b[^.]*?\bshelter\b|\bshelter\b[^.]*?\bcommunal\b/i;

// toolStep's own header has the full story. Anchored on "pickaxe" specifically, never bare
// "axe" -- weaponStep's own directive text ("you have no sword or axe") mentions an axe too, and
// this must never steal that goal into the wrong runner.
const TOOL_WORDS = /\bpickaxe\b/i;

// Real bug found live 2026-10-16 (direct report: "check the last 24 hours behavior logs for
// incorrect behaviors"). BED_WORDS used to be checked FIRST, before COMMUNAL_SHELTER_WORDS/
// SHELTER_WORDS -- fine as long as nothing both mentions a bed AND is really asking for a
// shelter, which held right up until nextSurvivalPriority()'s own Tier 1 "shelter" directive
// ("you don't have your own shelter with a bed in it yet -- build one near home...") started
// literally saying "bed" too. BED_WORDS matched it (the word "bed" is right there), so the
// WHOLE Tier 1 goal -- build a real room, not just place a bed -- got routed to bedStep, which
// happily places a bed in the open and calls it done, leaving hasOwnShelterWithBed() still
// false and the identical goal re-proposed forever. Confirmed live: Bob/Dale/Nell -- the three
// bots without a shelter yet -- had 313 combined "bed goal:" log lines and 0 "shelter goal:"
// ones in 24h on a goal whose own text says "shelter" first. Checking communal/plain shelter
// before bed fixes it without touching BED_WORDS itself, which still correctly wins for BED_GOAL
// ("make myself a bed and place it at home") -- that text never mentions a shelter at all.
export function farmTaskFor(description) {
  if (!description) return null;
  if (COMMUNAL_SHELTER_WORDS.test(description)) return "communal_shelter";
  if (SHELTER_WORDS.test(description)) return "shelter";
  if (BED_WORDS.test(description) && !NOT_MAKING_A_BED.test(description)) return "bed";
  if (TOOL_WORDS.test(description)) return "tool";
  if (RANCH_WORDS.test(description)) return "ranch";
  if (FARM_WORDS.test(description) && !NOT_A_CROP_FARM.test(description)) return "farm";
  return null;
}

export async function completeGoal(goal, why, item = null) {
  console.log(`[${USERNAME}] goal complete (${why}): ${goal.description}`);
  bot.chat(await narrateAction(`goal complete: ${goal.description}.`));
  recordGoalOutcome(goal.description, "done", null);
  await broadcastGoalState("done", goal.description, item);
  await retireGoal(goal);
}

// Real bug found live 2026-10-16 (direct report: "check the last 24 hours behavior logs for
// incorrect behaviors"), against the freshly reinitialized world (2026-10-14): MAX_CONSECUTIVE_
// FAILURES=3 is shared between the freeform planner -- where 3 failures genuinely means "stuck,
// re-plan from scratch" -- and the dedicated runners (bedStep/shelterStep/weaponStep/toolStep/
// farmGoal/ranchGoal/communalShelterStep), which are built on the OPPOSITE philosophy: resilient
// to being interrupted and resumed on the next tick, never meant to give up. In the new,
// harder-to-navigate terrain, three transient "No path to the goal" failures in a row (confirmed
// live: Mayor couldn't path to any tree, repeatedly) now abandon the WHOLE goal instead of just
// the one step -- Bob/Dale/Nell alone logged 313 abandons of their shelter-or-bed goal in 24h.
// Abandoning doesn't lose the underlying need (nextSurvivalPriority/builderPriorityCandidates
// re-propose it immediately, since it's still unmet) but DOES throw away the goal object's own
// accumulated progress (triedWeaponChest, triedToolChest, goal.shelterAt/site) every 3 strikes,
// forcing the chest-check and site-pick to restart from scratch each cycle. A dedicated-runner
// goal now gets a much longer leash -- long enough that checkStuck's own teleport-rescue
// (15 minutes of real zero-movement) gets a real chance to physically fix a bad spot before the
// goal gives up on it, rather than racing it and usually losing.
const DEDICATED_RUNNER_MAX_CONSECUTIVE_FAILURES = 20;
const DEDICATED_RUNNER_FARM_TASKS = new Set(["farm", "ranch", "bed", "shelter", "communal_shelter", "tool"]);
function isDedicatedRunnerGoal(goal) {
  return DEDICATED_RUNNER_FARM_TASKS.has(goal.farmTask) ||
    ["weapon", "tools", "shelter_upgrade", "food"].includes(goal.survivalPriorityItem);
}

export async function failGoalStep(goal, reason) {
  goal.consecutiveFailures += 1;
  const limit = isDedicatedRunnerGoal(goal) ? DEDICATED_RUNNER_MAX_CONSECUTIVE_FAILURES : MAX_CONSECUTIVE_FAILURES;
  if (goal.consecutiveFailures >= limit) {
    console.log(`[${USERNAME}] giving up on goal after ${goal.consecutiveFailures} failures: ${goal.description}`);
    if (goal.standIn) standInGaveUpAt[goal.farmTask] = Date.now();
    if (goal.roleWork) roleWorkGaveUpAt[goal.farmTask] = Date.now();
    recordGoalOutcome(goal.description, "gave up", reason);
    await broadcastGoalState("abandoned", goal.description);
    await retireGoal(goal);
    return;
  }
  await saveGoalIfCurrent(goal);
}

// Crops ripen on their own schedule (tens of minutes), so a farm goal plants, then waits -- holding
// nothing, routines and chat carry on -- and finishes when something is harvested: by this goal, or
// by the ripe-crop routine below, which any bot near home runs.
const FARM_WAIT_LOG_MS = 5 * 60_000;
const FARM_GIVE_UP_MS = 90 * 60_000; // crops that haven't ripened in 90 min won't soon
export let lastHarvestAt = 0;
export function setLastHarvestAt(value) { lastHarvestAt = value; return value; }
const CROP_ITEM = { wheat: "wheat", carrots: "carrot", potatoes: "potato", beetroots: "beetroot" };

// 2026-11-01: a chest was the only source of either, so with empty chests a farm never started.
// A wooden hoe is 2 planks and 2 sticks (2 more planks), 4 more for a table; seeds come from grass.
async function fetchFarmSupply(missing, handle) {
  if (missing === "hoe") {
    const looted = await performAction(bot, { type: "loot", item: "wooden_hoe", count: 1 }, USERNAME, handle); // any hoe
    if (looted.ok || looted.cancelled) return { ...looted, type: "loot" };
    const tableType = bot.registry.blocksByName.crafting_table;
    const tableNear = heldCount((n) => n === "crafting_table") > 0 ||
      (tableType && bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }).length > 0);
    const gathering = await gatherPlanks(handle, 4 + (tableNear ? 0 : 4));
    if (gathering) return { ...gathering, type: gathering.action?.type ?? "craft" };
    return { ...(await performAction(bot, { type: "craft", item: "wooden_hoe", count: 1, here: true }, USERNAME, handle)), type: "craft" };
  }
  const looted = await performAction(bot, { type: "loot", item: "seeds", count: 16 }, USERNAME, handle);
  if (looted.ok || looted.cancelled) return { ...looted, type: "loot" };
  return { ...(await performAction(bot, { type: "gather_seeds", count: 8 }, USERNAME, handle)), type: "gather_seeds" };
}

export async function runFarmGoal(goal, takeControl, getHandle, replaced) {
  if (lastHarvestAt > (goal.createdAt ?? 0)) return completeGoal(goal, "harvested crops from the farm");
  const plot = goal.farmPlot ? new Vec3(goal.farmPlot.x, goal.farmPlot.y, goal.farmPlot.z) : null;
  if (plot) {
    const status = farmStatus(bot, plot);
    if (!status.ripe && status.growing) {
      if (Date.now() - (goal.farmPlantedAt ?? 0) > FARM_GIVE_UP_MS) {
        console.log(`[${USERNAME}] farm goal: nothing ripened in ${FARM_GIVE_UP_MS / 60_000} min, giving up`);
        recordGoalOutcome(goal.description, "gave up", "crops never ripened");
        await broadcastGoalState("abandoned", goal.description);
        await retireGoal(goal);
        return;
      }
      if (Date.now() - (goal.farmWaitLoggedAt ?? 0) >= FARM_WAIT_LOG_MS) {
        goal.farmWaitLoggedAt = Date.now();
        console.log(`[${USERNAME}] farm goal: ${status.growing} crops growing, none ripe yet`);
      }
      return;
    }
  }
  if (replaced() || !(await takeControl())) return;
  const harvestAction = { type: "harvest", ...(plot ? { near: goal.farmPlot } : {}) };
  let result = await performAction(bot, harvestAction, USERNAME, getHandle());
  if (!result.ok && !result.cancelled && result.missing && !replaced()) {
    const supply = await fetchFarmSupply(result.missing, getHandle());
    logStep(goal, `farm supply (${result.missing}): ${supply.text}`, supply.ok, { type: supply.type });
    console.log(`[${USERNAME}] farm goal: needed ${result.missing} -- ${supply.text} (ok=${supply.ok})`);
    if (supply.ok && !replaced()) result = await performAction(bot, harvestAction, USERNAME, getHandle());
    if (supply.ok && !result.ok && !result.cancelled && result.missing && !replaced()) {
      getHandle()?.release();
      goal.consecutiveFailures = 0;
      await saveGoalIfCurrent(goal);
      return;
    }
  }
  getHandle()?.release();
  if (result.cancelled || replaced()) return;
  logStep(goal, `harvest: ${result.text}`, result.ok, { type: "harvest" });
  console.log(`[${USERNAME}] farm goal: ${result.text} (ok=${result.ok})`);
  if (result.harvested) {
    lastHarvestAt = Date.now();
    return completeGoal(goal, "harvested crops", CROP_ITEM[Object.keys(result.harvested)[0]] ?? null);
  }
  if (result.planted) {
    goal.farmPlot = result.plot;
    goal.farmPlantedAt = Date.now();
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, result.text);
}

// A ranch goal: a pen near home (crafting the fences and gate first), then two animals of one kind
// led into it, then bred. Each goal tick takes the next missing step; done when a baby is born.
const RANCH_PEN_FENCES = 23; // build_pen's 7x7 ring is 24 blocks, one of them the gate

export function heldCount(test) {
  return bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0);
}

function woodKind() {
  const wood = bot.inventory.items().map((i) => i.name).find((n) => /_(planks|log|stem)$/.test(n));
  return wood ? wood.replace(/^stripped_/, "").replace(/_(planks|log|stem)$/, "") : "oak";
}

const RANCH_SPECIES_RADIUS = 64; // matches herd_to_pen's own search (actions.js HERD_SEARCH_RADIUS)

function pickRanchSpecies(pen) {
  return LIVESTOCK.map((species) => [species, Object.values(bot.entities)
    .filter((e) => e.name === species && e.position.distanceTo(pen.center) <= RANCH_SPECIES_RADIUS).length])
    .filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

async function ranchStep(goal, handle) {
  const pen = await loadPenLocation();
  if (!pen) {
    const fences = heldCount((n) => n.endsWith("_fence") && !n.endsWith("_fence_gate"));
    // 2026-11-01: planks first -- a fence craft is 4 planks and 2 sticks (1 more plank) for 3 fences.
    const tableType = bot.registry.blocksByName.crafting_table;
    const tableNear = heldCount((n) => n === "crafting_table") > 0 ||
      (tableType && bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }).length > 0);
    if (fences < RANCH_PEN_FENCES) {
      const gathering = await gatherPlanks(handle, 5 * Math.ceil((RANCH_PEN_FENCES - fences) / 3) + (tableNear ? 0 : 4));
      if (gathering) return gathering;
      const item = `${woodKind()}_fence`;
      return { ...(await performAction(bot, { type: "craft", item, count: RANCH_PEN_FENCES - fences }, USERNAME, handle)),
        action: { type: "craft", item } };
    }
    if (!heldCount((n) => n.endsWith("_fence_gate"))) {
      const gathering = await gatherPlanks(handle, 4 + (tableNear ? 0 : 4));
      if (gathering) return gathering;
      const item = `${woodKind()}_fence_gate`;
      return { ...(await performAction(bot, { type: "craft", item, count: 1 }, USERNAME, handle)), action: { type: "craft", item } };
    }
    const site = bot.spawnPoint && findPenSite(bot, bot.spawnPoint);
    if (!site) return { ok: false, text: "couldn't find a flat, open 5x5 spot near home for a pen." };
    return { ...(await performAction(bot, { type: "build_pen", at: site }, USERNAME, handle)), action: { type: "build_pen" } };
  }
  const species = goal.ranchSpecies ?? pickRanchSpecies(pen);
  if (!species) {
    // 2026-11-06: none in sight is no reason to stand by the pen -- walking out loads new ground,
    // and its animals with it.
    const looked = await performAction(bot, { type: "explore" }, USERNAME, handle);
    if (looked.cancelled) return { ...looked, action: { type: "explore" } };
    return { ok: false, text: "no two animals of one kind anywhere near the pen -- went looking.", action: { type: "explore" } };
  }
  goal.ranchSpecies = species;
  const foods = BREEDING_FOOD[species];
  if (!bot.inventory.items().some((i) => foods.includes(i.name))) {
    for (const item of foods) {
      const got = await performAction(bot, { type: "loot", item, count: 8 }, USERNAME, handle);
      if (got.ok || got.cancelled) return { ...got, action: { type: "loot", item } };
    }
    if (foods.includes("wheat_seeds")) {
      return { ...(await performAction(bot, { type: "gather_seeds", count: 8 }, USERNAME, handle)), action: { type: "gather_seeds" } };
    }
    return { ok: false, text: `need ${foods[0]} to lure and breed ${species}s, and no chest has any.` };
  }
  if (countInPen(bot, pen, species) < 2) {
    const herded = await performAction(bot, { type: "herd_to_pen", species }, USERNAME, handle);
    // 2026-11-06: the species stayed chosen after its animals were gone ("no loose chicken nearby to
    // herd", 20 times running for Dale). Choose again next step.
    if (!herded.ok && !herded.cancelled && /^no loose /.test(herded.text)) goal.ranchSpecies = null;
    return { ...herded, action: { type: "herd_to_pen", species } };
  }
  const bred = await performAction(bot, { type: "breed", species, near: pen.center }, USERNAME, handle);
  return { ...bred, done: !!bred.bred, action: { type: "breed", species } };
}

export async function runRanchGoal(goal, takeControl, getHandle, replaced) {
  if (replaced() || !(await takeControl())) return;
  const step = await ranchStep(goal, getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `ranch: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] ranch goal: ${step.text} (ok=${step.ok})`);
  if (step.done) return completeGoal(goal, `bred a ${goal.ranchSpecies}`);
  if (step.ok) {
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, step.text);
}
