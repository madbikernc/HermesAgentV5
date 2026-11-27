// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of actions.js (2.0.0) unchanged: boats, action plugins, gear refresh, timeouts, clearing a cell to place into, block collection, recipe sources.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. actions.js imports
// it; this file reads actions.js's state through live imports, so nothing here may touch it
// before actions.js has run (only declarations live here).

import collectBlockPkg from "mineflayer-collectblock";
import pvpPkg from "mineflayer-pvp";
import { Vec3 } from "vec3";
import { equipBestArmor, equipBestWeapon, loadEquipmentPlugins } from "./equipment.js";
import { craftItem } from "./action-crafting.js";
import { ACTION_TIMEOUT_MS, goals, isProtectedBlockName } from "./action-vocab.js";


// Direct request, 2026-09-07 ("build the water crossing mechanic" -> boat/vehicle use, following
// the swim-crossing work). A boat is the real, standard way a player crosses open water --
// faster and with zero drowning risk, unlike swimming (index.js's own anti-drowning reflex is a
// safety net for when she's already in the water, not a substitute for a real crossing plan).
// mineflayer core already has everything needed for this, confirmed by reading its own source:
// bot.placeEntity() (place_entity.js) is a first-class API for spawning a rideable boat -- not a
// repurposed placeBlock() call, it sends the extra packet vanilla boats specifically need after
// the initial place -- and bot.mount()/bot.moveVehicle()/bot.dismount() (entities.js) are the
// real steering primitives a mounted vehicle uses, distinct from the normal walking controls
// (setControlState). bot.lookAt() (physics.js) computes the yaw/pitch to face a point directly,
// avoiding a hand-rolled (and easy to get backwards) yaw formula for steering.
const BOAT_STEER_INTERVAL_MS = 200;
const BOAT_CROSSING_TIMEOUT_MS = 60_000;
const BOAT_ARRIVAL_RADIUS = 4;

function findBoatItem(bot) {
  return bot.inventory.items().find((i) => i.name.endsWith("_boat"));
}

// Vanilla's boat recipe is real data bot.recipesFor() already knows -- checked live against
// this exact server's registry, not assumed: it's a 3-wide shape (5 planks of one species),
// which DOES need a crafting table (the personal grid is only 2x2), confirmed after an initial
// version of this wrongly assumed otherwise and failed live. Same tableBlock-lookup pattern the
// "craft" action already uses.
export async function ensureBoat(bot) {
  const existing = findBoatItem(bot);
  if (existing) return existing;
  const planks = bot.inventory.items().find((i) => i.name.endsWith("_planks") && i.count >= 5);
  if (!planks) return null;
  const boatName = planks.name.replace("_planks", "_boat");
  const itemDef = bot.registry.itemsByName[boatName];
  if (!itemDef) return null;

  const tableType = bot.registry.blocksByName.crafting_table;
  const positions = tableType ? bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 }) : [];
  if (!positions.length) return null; // no table nearby -- can't craft a boat, nothing more to try
  const tableBlock = bot.blockAt(positions[0]);

  try {
    await craftItem(bot, boatName, 1, tableBlock);
  } catch (err) {
    console.error("ensureBoat: craft failed:", err.message);
    return null;
  }
  return findBoatItem(bot);
}

// Best-effort: false covers every "can't do this right now" case (no boat/materials, no
// reachable water, launch failed, never got close enough before the timeout) uniformly, so
// callers can fall back to reporting their own original failure rather than a boat-specific one.
// Extracted so attemptBoatCrossing can retry against several candidate water/shore pairs --
// real testing found the first candidate found is often a bad launch spot (a shallow puddle, or
// a "ground neighbor" that pathfinder actually approaches from the far side, landing her at the
// water's edge rather than clearly on dry land), same "don't give up on the first failure"
// reasoning as every other multi-candidate loop in this file (loot/sleep/harvest).
//
// KNOWN LIMITATION, not yet resolved (2026-09-07): the actual boat spawn does not currently
// succeed live on this server, and extensive live testing narrowed down why without fully
// fixing it. One real, confirmed bug IS fixed here: bot.placeEntity() (mineflayer core,
// place_entity.js) sent boats' own supplementary "use_item" packet with only a `hand` field --
// this exact server's protocol.json (1.21.11) requires `hand`, `sequence`, AND `rotation`, and
// the missing fields crashed serialization outright the first time this was tried
// ("SizeOf error... reading 'x'"). Switching to bot.activateItem() (which builds that packet
// correctly -- the same call this file's "fish" action already uses successfully, confirmed
// live here too by directly testing it) stopped the crash, but no boat entity has been observed
// to actually spawn afterward despite: correct packet shape (confirmed via direct packet-write
// logging), correct entity-name matching for this version's per-species boat entities
// (oak_boat/spruce_boat/... replacing the old generic "Boat"), a non-forced bot.lookAt() (so the
// orientation update is confirmed sent before activating, not just applied locally), and precise
// /tp-based positioning that ruled out pathfinding drift as the cause. This matches a real,
// currently open, unresolved upstream report (PrismarineJS/mineflayer#3742, "use_item packet /
// activateItem not working on Minecraft 1.21.8") describing the exact same rotation/use_item
// breakage on 1.21.x -- closed "not planned" upstream with no fix or workaround published.
// Left in place rather than removed: the crash fix, crafting/table logic, multi-candidate
// launch-site selection, and steering-once-mounted code are all real and correct, and
// attemptBoatCrossing degrades safely to `return false` (its caller, "gohome", just falls
// through to its normal failure message) -- if a future mineflayer release fixes the underlying
// use_item/rotation handling, this should start working with no further changes needed here.
async function tryLaunchBoat(bot, token, boatItem, launch) {
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(launch.ground.position.x,
      launch.ground.position.y, launch.ground.position.z, 0)), ACTION_TIMEOUT_MS,
      () => bot.pathfinder.setGoal(null));
  } catch {
    return null;
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return null;
  // Real gap found live: GoalNear(..., 1) let pathfinder settle anywhere within 1 block of the
  // "ground" reference, including the water's own far edge -- confirmed live by ending up
  // standing on the FAR side of the water, looking almost straight down at her own feet instead
  // of across at it. GoalNear(..., 0) plus this direct check make sure she's actually somewhere
  // sane before ever trying to launch from here.
  if (bot.entity.isInWater) return null;
  if (bot.entity.position.distanceTo(launch.water.position) > 2.5) return null;

  try {
    await bot.equip(boatItem, "hand");
    const spawnPromise = new Promise((resolve, reject) => {
      const onSpawn = (entity) => {
        // Real gap found live (2026-09-07): this server's version gives each wood species its
        // own distinct boat entity (oak_boat, spruce_boat, ...), not a single generic
        // "Boat"/"boat" entity like older versions -- confirmed against this exact server's own
        // entitiesArray data. The spawned entity's name matches the item name directly.
        if (entity.name !== boatItem.name) return;
        if (entity.position.distanceTo(launch.water.position) > 3) return;
        bot.off("entitySpawn", onSpawn);
        resolve(entity);
      };
      bot.on("entitySpawn", onSpawn);
      setTimeout(() => { bot.off("entitySpawn", onSpawn); reject(new Error("boat never spawned")); }, 3000);
    });
    // Non-forced (awaited) lookAt -- confirmed the orientation update actually reaches the
    // server before activating, not just applied to local state (see this function's own header
    // comment on why that distinction mattered here). Aiming at the water's real surface height
    // (~0.88, not its lower raw block-center) keeps the look angle from being steeper than
    // necessary.
    await bot.lookAt(launch.water.position.offset(0.5, 0.88, 0.5), false);
    bot.activateItem();
    const boatEntity = await spawnPromise;
    await bot.mount(boatEntity);
    return boatEntity;
  } catch (err) {
    console.error("tryLaunchBoat: launch failed:", err.message);
    return null;
  }
}

export async function attemptBoatCrossing(bot, token, target) {
  const boatItem = await ensureBoat(bot);
  if (!boatItem) return false;

  const waterId = bot.registry.blocksByName.water?.id;
  if (waterId === undefined) return false;
  // Any water within a short walk with dry ground on one side to launch from -- doesn't need to
  // be exactly on the route, just somewhere she can actually get a boat into the water near
  // wherever she already got stuck trying to walk.
  const waterPositions = bot.findBlocks({ matching: waterId, maxDistance: 24, count: 20 });
  const candidates = [];
  for (const pos of waterPositions) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ground = bot.blockAt(pos.offset(dx, 0, dz));
      if (ground?.boundingBox === "block") {
        candidates.push({ water: bot.blockAt(pos), ground });
        break;
      }
    }
    if (candidates.length >= 5) break; // enough real attempts without walking her all over the map
  }
  if (!candidates.length) return false;

  let boatEntity = null;
  for (const launch of candidates) {
    if (token.cancelled) return false;
    boatEntity = await tryLaunchBoat(bot, token, boatItem, launch);
    if (boatEntity) break;
  }
  if (!boatEntity) return false;

  const deadline = Date.now() + BOAT_CROSSING_TIMEOUT_MS;
  let arrived = false;
  try {
    while (Date.now() < deadline && !token.cancelled && bot.vehicle) {
      const pos = bot.entity.position;
      const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
      if (dist <= BOAT_ARRIVAL_RADIUS) {
        arrived = true;
        break;
      }
      await bot.lookAt(new Vec3(target.x, pos.y, target.z), true);
      bot.moveVehicle(0, 1);
      await new Promise((resolve) => setTimeout(resolve, BOAT_STEER_INTERVAL_MS));
    }
  } finally {
    bot.moveVehicle(0, 0);
    if (bot.vehicle) bot.dismount();
  }
  return arrived;
}

export function loadActionPlugins(bot) {
  bot.loadPlugin(collectBlockPkg.plugin);
  bot.loadPlugin(pvpPkg.plugin);
  loadEquipmentPlugins(bot);
}

// Best-effort, deliberately swallows its own errors: called after any action that might have
// changed the inventory (mine, attack, loot) so gear stays current without a separate request
// -- a failure here should never turn a successful action into a reported failure.
// Redundancy note (review, 2026-09-24): refreshGear runs after almost every action. When nothing
// gear-relevant changed since the last refresh (same armor/weapon candidates and durability, same
// worn pieces, same held item) there is nothing to re-equip, so it returns without touching the
// inventory.
const lastGearSignature = new WeakMap();
const GEAR_NAME = /_(helmet|chestplate|leggings|boots|sword|axe)$/;
function gearSignature(bot) {
  const carried = bot.inventory.items().filter((i) => GEAR_NAME.test(i.name))
    .map((i) => `${i.name}:${i.durabilityUsed ?? 0}`).sort();
  const worn = [5, 6, 7, 8].map((slot) => bot.inventory.slots[slot]?.name ?? "-");
  return JSON.stringify([carried, worn, bot.heldItem?.name ?? "-"]);
}

export async function refreshGear(bot) {
  const signature = gearSignature(bot);
  if (lastGearSignature.get(bot) === signature) return;
  try {
    await equipBestArmor(bot);
    await equipBestWeapon(bot);
    lastGearSignature.set(bot, gearSignature(bot));
  } catch (err) {
    console.error("refreshGear failed:", err.message);
  }
}

// Rejects after `ms` rather than letting a bad path/target hang an action forever -- a real
// risk with pathfinder/collectBlock/pvp promises that have no built-in timeout of their own.
//
// Real bug found live (2026-09-06): the first version of this only raced the promise --
// Promise.race abandons the *loser*, it does not cancel it. A bot sent to mine terracotta
// (which generates naturally in badlands biomes, often behind cliffs/lava -- a genuinely
// hard-to-path target, not a bad block name) hit this: withTimeout gave up and reported
// failure after 120s, but the real bot.collectBlock.collect() call kept running underneath,
// unbounded, for another ~11 minutes until the process hit V8's heap limit and crashed --
// which is what actually disconnected the bot from the game, not a network drop. `onTimeout`
// is required now specifically so every call site cancels the real underlying work (pathfinder
// goal, collectBlock task, or pvp target) the moment the timeout fires, not just how this
// function's own caller interprets the result.
export function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error("timed out"));
    }, ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

// Direct report, 2026-10-28 ("she built many shelter structures, but all are incomplete because
// of... ground cover like flowers"). Confirmed in Babs' journal: the same few cells refused 20
// times each -- "Server refused to place dirt at (39, 71, -32): the block is still wildflowers"
// (and poppy). Grass is replaceable, so the server lets a block go straight in over it; flowers
// are not, and nothing ever cleared them. findShelterSite and place already count a non-solid
// cell as open (findBedSites wanted pure air, so it now does the same via isClearableCover), so
// the fix belongs at placement: break whatever
// non-solid, diggable thing is standing in the target cell first. Air, fluids, protected fixtures
// (doors, beds, chests...) and crops are left alone -- a crop is someone's farm, not ground cover.
const PLACEMENT_KEEP = new Set(["water", "lava", "bubble_column", "fire", "soul_fire",
  "wheat", "carrots", "potatoes", "beetroots"]); // the crops: CROP_MAX_AGE is declared further down

export function isClearableCover(block) {
  return !!block && block.boundingBox === "empty" && !block.name.endsWith("air") && !!block.diggable &&
    !PLACEMENT_KEEP.has(block.name) && !isProtectedBlockName(block.name);
}

export async function clearCellForPlacement(bot, pos) {
  const block = bot.blockAt(pos);
  if (!isClearableCover(block)) return false;
  try {
    await withTimeout(bot.dig(block, true), 10_000, () => bot.stopDigging());
    return true;
  } catch (err) {
    console.error(`[${bot.username}] couldn't clear the ${block.name} at ${pos}:`, err.message);
    return false;
  }
}

// Direct report, 2026-10-28 ("gathering wood is done in fits and starts -- not enough hacks at
// the wood occur, she stops, the wood 'heals', she starts again"). Confirmed against
// mineflayer-pathfinder's own source: while A* is still searching, goto() already walks the
// partial path, and a partial path toward a log usually has a block to break on it (the trunk
// itself, or leaves). With thinkTimeout at 1000ms (index.js, the OOM fix), a tree target's search
// hits "Took to long to decide path to goal!" about a second in -- goto() rejects with that dig
// mid-swing, collectBlock throws, and the next setGoal() aborts the dig (bot.stopDigging()), which
// is the crack visibly healing. The whole mine step then failed and waited for the next goal tick.
// Two fixes, both scoped to block collection only: a wider think window for these searches (the
// 20ms tickTimeout still hands the event loop back between chunks), and on a timeout or no-path
// rejection, let the in-flight dig finish before trying again from wherever she now stands.
const COLLECT_THINK_TIMEOUT_MS = 3000;
const COLLECT_PATH_RETRIES = 2;
const COLLECT_DIG_SETTLE_MS = 10_000;

export async function collectBlocks(bot, token, blocks) {
  const savedThink = bot.pathfinder.thinkTimeout;
  bot.pathfinder.thinkTimeout = Math.max(savedThink, COLLECT_THINK_TIMEOUT_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bot.collectBlock.collect(blocks, { ignoreNoPath: true });
      } catch (err) {
        if (token.cancelled || attempt >= COLLECT_PATH_RETRIES || (err.name !== "Timeout" && err.name !== "NoPath")) throw err;
        const settleBy = Date.now() + COLLECT_DIG_SETTLE_MS;
        while (bot.pathfinder.isMining() && Date.now() < settleBy && !token.cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (token.cancelled) throw err;
        blocks = blocks.filter((b) => bot.blockAt(b.position)?.type === b.type);
        if (!blocks.length) return;
        console.log(`[${bot.username}] collect: ${err.message} -- retrying from here (${blocks.length} left)`);
      }
    }
  } finally {
    bot.pathfinder.thinkTimeout = savedThink;
  }
}

// Common shallow crafting chains: the overwhelming majority of "craft X" requests that start
// from raw gathered resources bottleneck on one of these two conversions. Deliberately narrow
// and hard-coded, not a general recursive planner (see this file's own header on why building
// stays out of scope) -- covers "pre-teach the most common recipes" as a real capability
// without attempting to solve arbitrary multi-tier crafting trees.
export function simpleSourceFor(bot, itemName) {
  // 2026-11-04: or a log, which the planks step below turns into planks first. checkTorchSupply
  // counts a log as wood for a torch, but with logs and no planks the stick never got made: 230
  // "torch supply" failures in a day, "don't have the ingredients" with coal and logs in hand.
  if (itemName === "stick" || itemName === "crafting_table") {
    const items = bot.inventory.items();
    return items.find((i) => i.name.endsWith("_planks")) ?? items.find((i) => /_(log|stem)$/.test(i.name));
  }
  // 2026-11-01: only that wood's own log. Any log used to count, and the hoe's recipes start at
  // cherry_planks: Babs, holding one birch log and 4 birch planks, tried cherry planks from her
  // birch log, that sub-craft threw, and "craft wooden_hoe" failed with the planks for it in hand.
  if (itemName.endsWith("_planks")) {
    const wood = itemName.replace(/_planks$/, "");
    const sources = [`${wood}_log`, `${wood}_stem`, `stripped_${wood}_log`, `stripped_${wood}_stem`];
    return bot.inventory.items().find((i) => sources.includes(i.name));
  }
  return null;
}

// Real bug found live 2026-10-07, by the torch-trail live scenario failing on its very first step
// ("craft torch" with 8 coal and 8 oak_planks in hand -> "don't have the ingredients"). Root cause,
// confirmed by printing the real recipe objects off this server: `ingredients` is only populated
// for SHAPELESS recipes. A torch, a stick, and a crafting table are all SHAPED -- they carry
// `inShape` instead, and `ingredients` is undefined. craftItem's auto-chain loop below read only
// `ingredients`, so for every shaped recipe it hit the "not an array" guard and skipped the recipe
// entirely -- meaning the chain could never fire for any of them.
//
// That is the same gate checkHomeLighting has now had three separate fixes aimed at (2026-09-17,
// 2026-09-18, 2026-09-21), the last of which deliberately widened it from "has a stick" to "has
// any wood source" precisely so craftItem's chain would turn planks into the stick a torch needs.
// It never could. A bot carrying coal and planks but no loose stick -- the ordinary state after
// any crafting -- still could not make a torch.
//
// `delta` is the fix and the right data to use: every recipe has it, shaped or shapeless, already
// aggregated per item id, with inputs as negative counts and the output positive (verified live:
// torch's delta is coal -1, stick -1, torch +4). Returning null for a recipe with no usable delta
// keeps the protection the old `Array.isArray` guard was added for -- a smelting-only item's
// recipe object once crashed this loop outright.
export function recipeInputs(recipe) {
  if (Array.isArray(recipe?.delta)) {
    const inputs = recipe.delta.filter((d) => d.count < 0).map((d) => ({ id: d.id, count: -d.count }));
    if (inputs.length) return inputs;
  }
  return Array.isArray(recipe?.ingredients) ? recipe.ingredients : null;
}
