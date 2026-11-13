// Version: 3.0.0
//
// The bots' actions: performAction() and the dispatcher over ACTION_HANDLERS (actions/*.js, one
// file per action). Change history: history/actions.js.md (moved out of this file 2026-11-13,
// verbatim). The shared helpers the actions use live in the action-*.js modules below and are
// re-exported from here, so `import ... from "../actions.js"` keeps working for every caller.

import { cancelAndRotate, holdsControl, isBusy, releaseControl } from "./arbiter.js";
import { stopAction } from "./actions/stop.js";
import { gotoAction } from "./actions/goto.js";
import { followAction } from "./actions/follow.js";
import { mineAction } from "./actions/mine.js";
import { exploreAction } from "./actions/explore.js";
import { craftAction } from "./actions/craft.js";
import { lootAction } from "./actions/loot.js";
import { attackAction } from "./actions/attack.js";
import { fleeAction } from "./actions/flee.js";
import { eatAction } from "./actions/eat.js";
import { huntAction } from "./actions/hunt.js";
import { gatherSeedsAction } from "./actions/gather-seeds.js";
import { fishAction } from "./actions/fish.js";
import { giveAction } from "./actions/give.js";
import { gohomeAction } from "./actions/gohome.js";
import { sleepAction } from "./actions/sleep.js";
import { smeltAction } from "./actions/smelt.js";
import { placeAction } from "./actions/place.js";
import { placeHomeAction } from "./actions/place-home.js";
import { lightAreaAction } from "./actions/light-area.js";
import { clearAccessAction } from "./actions/clear-access.js";
import { buildAction } from "./actions/build.js";
import { patchShelterAction } from "./actions/patch-shelter.js";
import { refaceShelterAction } from "./actions/reface-shelter.js";
import { buildCommunalShelterAction } from "./actions/build-communal-shelter.js";
import { buildPenAction } from "./actions/build-pen.js";
import { herdToPenAction } from "./actions/herd-to-pen.js";
import { repairTerrainAction } from "./actions/repair-terrain.js";
import { storeAction } from "./actions/store.js";
import { consolidateChestsAction } from "./actions/consolidate-chests.js";
import { tradeAction } from "./actions/trade.js";
import { recoverAction } from "./actions/recover.js";
import { harvestAction } from "./actions/harvest.js";
import { plantSaplingAction } from "./actions/plant-sapling.js";
import { breedAction } from "./actions/breed.js";
import { harvestHiveAction } from "./actions/harvest-hive.js";
import { getWoolAction } from "./actions/get-wool.js";
import { placeBedAction } from "./actions/place-bed.js";
import { shearAction } from "./actions/shear.js";
import { milkAction } from "./actions/milk.js";
import { enchantAction } from "./actions/enchant.js";
import { FOOD_NAMES } from "./action-vocab.js";
import { BREEDING_FOOD, SEED_NAMES, loadPenLocation } from "./action-world.js";
export { STORE_CANDIDATE_LIMIT, consolidationPending, findConsolidation, findKnownChestWithItem, isUtilityUsable, itemFamily, loadKnownChests, noteUtilityOutcome, openChestAt, rankStoreChests, recordChestSnapshot, takeConsolidationHint } from "./action-chests.js";
export { claimBuilderItem, holdsGuardAnchor, myBuilderClaim, nearbyBeds, releaseBuilderItem } from "./action-claims.js";
export { chestObstructed, craftItem, tryTakeFromNearbyChest, tryTakeFromThisChest } from "./action-crafting.js";
export { attemptBoatCrossing, clearCellForPlacement, collectBlocks, ensureBoat, isClearableCover, loadActionPlugins, refreshGear, withTimeout } from "./action-movement.js";
export { CHEST_SEARCH_RADIUS, EXPLORE_SEARCH_RADIUS, MINE_SEARCH_RADIUS, SCOUT_FEATURE_BLOCKS, findRememberedLocation, getResourceBlockNames, hopToward, visitRememberedSpot, wanderAndRetryFind, wanderAndRetryForSheep } from "./action-search.js";
export { CROP_MAX_AGE, SHELTER_ROOM, collectDrops, communalDoorwayPosition, communalRoomCells, communalShelterMaterialCount, communalShelterPositions, doorItemFor, doorwayPosition, farmStatus, findCommunalShelterSite, findShelterSite, isCommunalShelterMaterial, isShelterDoor, isShelterMaterial, shelterMaterialCount, shelterPositions } from "./action-shelter.js";
export { ACTION_TIMEOUT_MS, DARK_LIGHT_LEVEL, FISH_TIMEOUT_MS, FLEE_ONLY_MOBS, FOOD_NAMES, GEAR_SUFFIXES, GEAR_TIER_RANK, HOSTILE_MOBS, HUNTABLE_ANIMALS, HUNT_RANGE, SKILL_ACTION_VERBS, SLEEP_TIMEOUT_MS, SMELT_RECIPES, SMELT_TIMEOUT_MS, gearCategoryNames, gearTierRank, goals, isEssentialItem, isProtectedBlockName, nearestFriendlyGolem, nearestHostile, pickFuel, resolveBlockFamily } from "./action-vocab.js";
export { BREEDING_FOOD, CONTENTION_SEARCH_OVERFETCH, GATHER_SEEDS_MAX_DIGS, HERD_SEARCH_RADIUS, LIVESTOCK, MINE_DROPS, SEED_GRASS, SEED_NAMES, bedItemFor, bedNearHazard, bedSpotKey, cellOccupied, chooseFarmPlot, countInPen, filterAwayFromOtherBots, findBedSite, findBedSites, findPenSite, findPlantableSpotNear, getAchievements, isRecentlyRefusedBedSpot, itemNamesForMinedBlocks, loadAchievements, loadPenLocation, nearBuilding, recordAchievement, refusedBedSpots, savePenLocation, tillableAt, woolCounts } from "./action-world.js";
export const LOOT_GROUPS = { food: FOOD_NAMES, seeds: SEED_NAMES };

// Direct request, 2026-09-10 ("write up a plan for that single arbiter..." -> the approved
// per-bot coherence arbiter plan). This function's own real body (the 4 cancel primitives +
// token rotation + sleep-interrupt) now lives in arbiter.js's own cancelAndRotate() -- moved, not
// duplicated, so index.js's reflex handlers (self-defense, the health/breath emergencies, squad
// response, etc.) share the exact same token instead of index.js maintaining its own, separate
// raw setGoal(null) calls that this file's own cancelToken never knew about (the confirmed root
// cause of the recover()-retry bug arbiter.js's own header documents).
//
// Phase 2 addition, real bug caught live while migrating the first reflex handler: if a caller
// already acquired legitimate control via arbiter.requestControl() before calling
// performAction(), this must NOT unconditionally cancelAndRotate() again -- that would
// immediately stomp the caller's own just-acquired token (marking it cancelled, rotating
// `current` out from under it) the instant the caller went on to run its actual action. Reuses
// the already-current token instead whenever one exists; falls back to the original unconditional
// cancel-and-rotate for every NOT-yet-migrated caller (goalTick, runAction, and every routine
// idle-tick check still call performAction() directly with no prior requestControl()), so this
// stays zero behavior change for all of them until their own later migration phases.
//
// 2026-09-24 (review MB-02/MB-04): "reuse whatever token is current" let a PREEMPTED caller's
// stale continuation borrow the new owner's token and act under it (a goal step starting FOLLOW
// mid-emergency). Every caller now passes the handle it acquired; a handle that no longer holds
// control is refused before anything moves, and a handle-less call while someone else owns the
// body is refused too. Only a handle-less call on an idle arbiter takes the legacy
// cancel-and-rotate path. performAction() also normalizes outcomes: any result produced after
// its token was cancelled is reported `{ ok: false, cancelled: true }` -- ~56 branches used to
// return ok("stopped early") on cancellation, which recovery's retry test, goal failure
// counters, skill replay, and skill authoring all read as genuine success.
const LOST_CONTROL = Object.freeze({ ok: false, cancelled: true, text: "something more urgent has control right now." });

// 2026-11-04 (24h review): Amy's "mine stone" failed "No path to the goal!" 2,204 times in a day.
// findBlocks hands back the nearest matches, and the nearest stone at home is buried under dirt --
// past what the pathfinder's search budget will dig to -- while bare hillside stone a few blocks
// further out was never tried. A block with an open face comes first now, and one that just
// failed "No path" sits out MINE_UNREACHABLE_MS so the next attempt picks another.
const MINE_UNREACHABLE_MS = 10 * 60_000;
export const MINE_RANKING_FETCH = 64;
const mineUnreachableUntil = new Map();
const MINE_FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function hasOpenFace(bot, pos) {
  return MINE_FACES.some(([dx, dy, dz]) => bot.blockAt(pos.offset(dx, dy, dz))?.boundingBox === "empty");
}

export function rankMineTargets(bot, positions) {
  const now = Date.now();
  const reachable = positions.filter((pos) => (mineUnreachableUntil.get(`${pos.x},${pos.y},${pos.z}`) ?? 0) <= now);
  const open = reachable.filter((pos) => hasOpenFace(bot, pos));
  return [...open, ...reachable.filter((pos) => !open.includes(pos))];
}

export function noteMineUnreachable(bot, blocks) {
  const until = Date.now() + MINE_UNREACHABLE_MS;
  for (const b of blocks) {
    if (bot.blockAt(b.position)?.type === b.type) mineUnreachableUntil.set(`${b.position.x},${b.position.y},${b.position.z}`, until);
  }
}

export async function performAction(bot, action, speaker, handle = null) {
  const startedAt = Date.now();
  if (handle ? !holdsControl(handle) : isBusy()) return logOutcome(bot, action, startedAt, { ...LOST_CONTROL }, true);
  const alreadyHeld = !!handle;
  const token = handle ? handle.token : cancelAndRotate(bot);
  let result;
  try {
    result = await performActionAs(bot, action, speaker, token);
  } finally {
    // Only release if THIS call acquired (the legacy handle-less path) -- a caller holding a
    // handle owns its own release via handle.release().
    if (!alreadyHeld) releaseControl({ token });
  }
  return logOutcome(bot, action, startedAt, token.cancelled ? { ...result, ok: false, cancelled: true } : result);
}

// Review MB-18 follow-up (2026-09-24): one structured line per action outcome, so triage and
// tests/baseline.mjs count outcomes from data instead of pattern-matching each action's prose.
function logOutcome(bot, action, startedAt, result, refused = false) {
  const why = !result.ok && !result.cancelled && result.text ? { why: String(result.text).slice(0, 100) } : {};
  console.log(`[${bot.username}] OUTCOME ${JSON.stringify({ type: action.type, ok: !!result.ok,
    cancelled: !!result.cancelled, refused, ms: Date.now() - startedAt, ...why })}`);
  return result;
}

// `token` is the caller's live ownership token; nested sub-actions pass it straight through.
export async function performActionAs(bot, action, speaker, token) {
  // Every action is its own file under actions/ (2.0.0, 2026-11-10); ACTION_HANDLERS maps
  // action.type to it. Built here, at call time, so a test slice of this file that never
  // calls performActionAs needs none of the handlers. Control acquisition and release live in
  // the performAction() wrapper above (2026-09-24).
  const ACTION_HANDLERS = {
    stop: stopAction,
    goto: gotoAction,
    follow: followAction,
    mine: mineAction,
    explore: exploreAction,
    craft: craftAction,
    loot: lootAction,
    attack: attackAction,
    flee: fleeAction,
    eat: eatAction,
    hunt: huntAction,
    gather_seeds: gatherSeedsAction,
    fish: fishAction,
    give: giveAction,
    gohome: gohomeAction,
    sleep: sleepAction,
    smelt: smeltAction,
    place: placeAction,
    place_home: placeHomeAction,
    light_area: lightAreaAction,
    clear_access: clearAccessAction,
    build: buildAction,
    patch_shelter: patchShelterAction,
    reface_shelter: refaceShelterAction,
    build_communal_shelter: buildCommunalShelterAction,
    build_pen: buildPenAction,
    herd_to_pen: herdToPenAction,
    repair_terrain: repairTerrainAction,
    store: storeAction,
    consolidate_chests: consolidateChestsAction,
    trade: tradeAction,
    recover: recoverAction,
    harvest: harvestAction,
    plant_sapling: plantSaplingAction,
    breed: breedAction,
    harvest_hive: harvestHiveAction,
    get_wool: getWoolAction,
    place_bed: placeBedAction,
    shear: shearAction,
    milk: milkAction,
    enchant: enchantAction,
  };
  const handler = ACTION_HANDLERS[action.type];
  if (!handler) return { ok: false, text: "not sure how to do that yet." };
  return await handler(bot, action, speaker, token);
}
