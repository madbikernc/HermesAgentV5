// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: the shelter and communal-shelter goal runners.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { writeMemoryNote } from "./longterm.js";
import { SHELTER_ROOM, communalShelterMaterialCount, communalShelterPositions, doorwayPosition, findCommunalShelterSite, findShelterSite, performAction, shelterMaterialCount, shelterPositions } from "./actions.js";
import { logStep } from "./goals.js";
import { isDoorway } from "./swim-movements.js";
import { SHELTER_SITE_RADIUS, completeSheltersNearHome, residenceChestCell, residencePlan, unfinishedShelterNearHome } from "./home-scan.js";
import { communalShelterSatisfied, communalShelterSize, findCommunalShelterNearHome } from "./priorities.js";
import { Vec3 } from "vec3";
import { bedStep, gatherPlanks } from "./gear-goals.js";
import { builderAcquireStep, completeGoal, failGoalStep, heldCount, holdsItem, saveGoalIfCurrent } from "./goal-runners.js";
import { PERSONA_NAME, USERNAME, bot } from "./index.js";


// Shelters (2026-09-26): the Builder's "build a small shelter" went to the planner -- 202 rejected
// DONE claims and one real "build" in two days. A shelter goal now runs directly: a flat, clear
// site within 4 blocks of home, enough building blocks (planks from logs she holds, else dirt), then
// "build" on that site. Done only when hasShelterNearHome() sees it.
// Real bug found live 2026-10-16: only ever matched verb-then-"shelter" -- but
// nextSurvivalPriority()'s own Tier 1 directive says "shelter" FIRST ("you don't have your own
// shelter with a bed in it yet -- build one near home..."), the same reverse-order gap
// COMMUNAL_SHELTER_WORDS already had to handle for its own directive text.
export const SHELTER_WORDS = /\b(build(ing)?|mak(e|ing)|set(ting)? up|put(ting)? up|need)\b[^.]*?\bshelter\b|\bshelter\b[^.]*?\b(build(ing)?|mak(e|ing)|set(ting)? up|put(ting)? up|need)\b/i;

// 2026-10-28 (direct report: "they completed a few shelter buildings, but don't seem to realize
// they can place a bed"): done used to mean "a complete structure exists" -- but the Tier 1 item
// proposing this goal is hasOwnShelterWithBed(), so a finished, empty shelter completed the goal
// and the very next proposal re-opened it, forever. Once the structure stands, the goal's second
// phase puts a bed in it: place one she holds, else bedStep()'s own wool/craft acquisition (its own
// place branch is unreachable here, same as communalShelterStep's use of it).
// 2026-11-04: one step of residencePlan()'s work -- a chest into a bedded shelter, a bed into an
// empty one, else a new shelter (the build below). Done once every active bot has a bed in a
// residence.
async function shelterStep(goal, handle) {
  const plan = residencePlan();
  if (plan.kind === "done") {
    return { ok: true, text: `${plan.beds} bed${plan.beds === 1 ? "" : "s"} in residences for ${plan.active} active bots.`, done: true };
  }
  if (plan.kind === "chest") {
    if (!holdsItem("chest")) return builderAcquireStep("chest", goal, handle);
    const cell = residenceChestCell(plan.base);
    if (!cell) return { ok: false, text: "the residence has no free floor for a chest." };
    const placed = await performAction(bot, { type: "place", item: "chest", at: { x: cell.x, y: cell.y, z: cell.z } }, USERNAME, handle);
    return { ...placed, action: { type: "place", item: "chest" } };
  }
  if (plan.kind === "bed") {
    if (!bot.inventory.items().some((i) => i.name.endsWith("_bed"))) return bedStep(goal, handle);
    // 2026-10-30: in the room itself, not just near it -- two beds "near" Babs' shelter landed
    // in other covered spots nearby, and each one sent her off for wool for another.
    const cells = SHELTER_ROOM.map(([dx, dz]) => plan.base.offset(dx, 0, dz)).map(({ x, y, z }) => ({ x, y, z }));
    const placed = await performAction(bot, { type: "place_bed", near: plan.base, cells }, USERNAME, handle);
    return { ...placed, action: { type: "place_bed" } };
  }
  if (!bot.spawnPoint) return { ok: false, text: "don't know where home is yet." };
  // A site an earlier build picked that has since become a complete shelter is no site any more.
  if (goal.shelterAt && completeSheltersNearHome().some((b) =>
    b.x === goal.shelterAt.x && b.y === goal.shelterAt.y && b.z === goal.shelterAt.z)) {
    goal.shelterAt = null;
  }
  const site = goal.shelterAt ? new Vec3(goal.shelterAt.x, goal.shelterAt.y, goal.shelterAt.z)
    : (unfinishedShelterNearHome() ?? findShelterSite(bot, bot.spawnPoint, SHELTER_SITE_RADIUS));
  if (!site) return { ok: false, text: `couldn't find a flat, clear 3x3 spot within ${SHELTER_SITE_RADIUS} blocks of home.` };
  goal.shelterAt = { x: site.x, y: site.y, z: site.z };
  // 2026-10-28: the door before the walls. "build" crafts its door first but never reports that
  // the craft failed, so with no planks it put up every wall, came back "no door yet" in ~5ms
  // per tick, and burned through the 20-failure limit in 40 seconds. A door is 6 planks, plus 4
  // for the crafting table if none is around -- and those planks are held back from the wall
  // count below, or the walls would spend them (planks are shelter material too).
  const needsDoor = !isDoorway(bot.blockAt(doorwayPosition(site))) &&
    !bot.inventory.items().some((i) => i.name.endsWith("_door"));
  let doorPlanks = 0;
  if (needsDoor) {
    const tableType = bot.registry.blocksByName.crafting_table;
    const tableNear = heldCount((n) => n === "crafting_table") > 0 ||
      (tableType && bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }).length > 0);
    doorPlanks = 6 + (tableNear ? 0 : 4);
    const gathering = await gatherPlanks(handle, doorPlanks);
    if (gathering) return gathering;
  }
  const needed = shelterPositions(site).filter((p) => bot.blockAt(p)?.boundingBox !== "block").length;
  const short = needed - (shelterMaterialCount(bot) - doorPlanks);
  if (short > 0) {
    const log = bot.inventory.items().find((i) => /_(log|stem)$/.test(i.name));
    if (log) {
      // Only as many planks as her logs make: asking for more failed the whole craft every tick.
      const item = `${log.name.replace(/^stripped_/, "").replace(/_(log|stem)$/, "")}_planks`;
      const count = Math.min(short, 4 * heldCount((n) => n === log.name));
      return { ...(await performAction(bot, { type: "craft", item, count }, USERNAME, handle)), action: { type: "craft", item } };
    }
    return { ...(await performAction(bot, { type: "mine", block: "dirt", count: short }, USERNAME, handle)),
      action: { type: "mine", block: "dirt" } };
  }
  // Never done here any more -- the next tick's bed phase (above) finishes the goal. A build that
  // says it stands but that completeSheltersNearHome() can't see AT THIS SITE is a failure, not a
  // success (any other complete shelter near home is no proof this one stands):
  // ok:true there is exactly what kept the 328-step loop from ever hitting the failure limit.
  const built = await performAction(bot, { type: "build", at: goal.shelterAt }, USERNAME, handle);
  if (built.built && !completeSheltersNearHome().some((b) => b.equals(site))) {
    return { ...built, ok: false, built: false, text: `${built.text} -- but it doesn't check out as a complete shelter.`,
      action: { type: "build" } };
  }
  return { ...built, action: { type: "build" } };
}

export async function runShelterGoal(goal, takeControl, getHandle, replaced) {
  if (replaced() || !(await takeControl())) return;
  const step = await shelterStep(goal, getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `shelter: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] shelter goal: ${step.text} (ok=${step.ok})`);
  // Only register a note on the tick that actually finished the build (step.built, carried
  // through from performAction's "build" result, and confirmed by shelterStep) -- not on the bed
  // phase's ticks, which aren't a new fact worth telling the rest of the fleet about.
  // 2026-10-27 (direct request: "all resources, including buildable resources, should be
  // registered to the RAG"): crafting_table/furnace/chest/beehive already get this via
  // runBuilderPlacement() -- shelter had no equivalent (it's not in CRAFTED_OBJECT_NAMES, and
  // can't be: it's a multi-block structure, not a single scannable block type).
  if (step.built && step.ok && goal.shelterAt) {
    writeMemoryNote({ scope: "world", persona: PERSONA_NAME, text: `Built a shelter near ` +
      `(${goal.shelterAt.x}, ${goal.shelterAt.y}, ${goal.shelterAt.z}), as of ${new Date().toISOString()}.` })
      .catch((err) => console.error(`[${USERNAME}] shelter memory write failed:`, err.message));
  }
  if (step.bedAt && step.ok) {
    writeMemoryNote({ scope: "world", persona: PERSONA_NAME, text: `Built a bed near ` +
      `(${step.bedAt.x}, ${step.bedAt.y}, ${step.bedAt.z}), as of ${new Date().toISOString()}.` })
      .catch((err) => console.error(`[${USERNAME}] bed memory write failed:`, err.message));
  }
  if (step.done) return completeGoal(goal, "every active bot has a bed in a residence");
  if (step.ok) {
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, step.text);
}

// Communal shelter (2026-10-11, PRIORITIES_PROPOSAL.md Tier 2 item 1a): same shape as
// shelterStep/runShelterGoal above -- a site persisted on the goal, build when short on
// material, done only on a verified result -- plus a second phase shelterStep never needs:
// once the structure itself is complete, populate it with beds up to the fleet-size target, one
// per tick, reusing bedStep's own wool-to-bed acquisition sequence rather than a third copy of it.
async function communalShelterStep(goal, handle) {
  if (communalShelterSatisfied()) return { ok: true, text: "the communal shelter is fully built and bedded.", done: true };
  const found = findCommunalShelterNearHome();
  const { width, depth } = communalShelterSize();
  if (!found?.complete) {
    if (!bot.spawnPoint) return { ok: false, text: "don't know where home is yet." };
    const site = goal.communalShelterAt ? new Vec3(goal.communalShelterAt.x, goal.communalShelterAt.y, goal.communalShelterAt.z)
      : (found?.base ?? findCommunalShelterSite(bot, bot.spawnPoint, width, depth));
    if (!site) return { ok: false, text: `couldn't find a flat, clear ${width}x${depth} spot near home for the communal shelter.` };
    goal.communalShelterAt = { x: site.x, y: site.y, z: site.z };
    const needed = communalShelterPositions(site, width, depth).filter((p) => bot.blockAt(p)?.boundingBox !== "block").length;
    const short = needed - communalShelterMaterialCount(bot);
    if (short > 0) {
      // Stone, not planks: the communal shelter's own material floor (actions.js's
      // isCommunalShelterMaterial) -- "stone" is what mining it drops as, the same block nearly
      // every biome has underground, same reasoning "mine" already applies everywhere else.
      return { ...(await performAction(bot, { type: "mine", block: "stone", count: short }, USERNAME, handle)),
        action: { type: "mine", block: "stone" } };
    }
    const built = await performAction(bot, { type: "build_communal_shelter", at: goal.communalShelterAt, width, depth }, USERNAME, handle);
    return { ...built, done: false, action: { type: "build_communal_shelter" } }; // structure alone is never "done" -- still needs beds
  }
  if (bot.inventory.items().some((i) => i.name.endsWith("_bed"))) {
    const placed = await performAction(bot, { type: "place_bed", near: found.base }, USERNAME, handle);
    return { ...placed, action: { type: "place_bed" } };
  }
  // Doesn't hold a bed yet: bedStep's own wool/craft sequence gets her one (its OWN place_bed
  // branch is unreachable here since we just confirmed she isn't holding one) -- same acquisition,
  // not a second copy of it.
  return bedStep(goal, handle);
}

export async function runCommunalShelterGoal(goal, takeControl, getHandle, replaced) {
  if (replaced() || !(await takeControl())) return;
  const step = await communalShelterStep(goal, getHandle());
  getHandle()?.release();
  if (step.cancelled || replaced()) return;
  logStep(goal, `communal shelter: ${step.text}`, step.ok, step.action);
  console.log(`[${USERNAME}] communal shelter goal: ${step.text} (ok=${step.ok})`);
  if (step.done) return completeGoal(goal, "the communal shelter is built and bedded");
  if (step.ok) {
    goal.consecutiveFailures = 0;
    await saveGoalIfCurrent(goal);
    return;
  }
  await failGoalStep(goal, step.text);
}
