// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: dropping, trash, inventory insurance, saplings and lighting.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { DARK_LIGHT_LEVEL, performAction } from "./actions.js";
import * as arbiter from "./arbiter.js";
import { countUsableNearHome } from "./home-scan.js";
import { TOOL_RANK } from "./priorities.js";
import { routineBlocked } from "./goal-proposal.js";
import { AUTONOMY_ENABLED, HOME_LIGHTING_MAINTAINER, USERNAME, bot, goals } from "./index.js";
import { INVENTORY_FULL_SLOTS, INVENTORY_MAIN_HOTBAR_SLOTS, makeHomeChest, storageBlockedUntil, storeSurplusValuables } from "./upkeep-inventory.js";
import { torchBatch } from "./upkeep-world.js";


const DROP_DISTANCE = 6;

// Standable ground DROP_DISTANCE out from home -- the way she already is from it first, else
// whichever compass direction has floor -- and a point further out to face while throwing.
export function dropSpotAwayFrom(home) {
  const off = bot.entity ? { x: bot.entity.position.x - home.x, z: bot.entity.position.z - home.z } : null;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (off && Math.hypot(off.x, off.z) >= 1) {
    const len = Math.hypot(off.x, off.z);
    dirs.unshift([off.x / len, off.z / len]);
  }
  for (const [dx, dz] of dirs) {
    const at = home.offset(Math.round(dx * DROP_DISTANCE), 0, Math.round(dz * DROP_DISTANCE));
    const standable = bot.blockAt(at.offset(0, -1, 0))?.boundingBox === "block" &&
      bot.blockAt(at)?.boundingBox === "empty" && bot.blockAt(at.offset(0, 1, 0))?.boundingBox === "empty";
    if (standable) return { at, facing: home.offset(dx * 4 * DROP_DISTANCE, 1, dz * 4 * DROP_DISTANCE) };
  }
  return null;
}

export async function walkTo(pos, range, handle) {
  const timer = setTimeout(() => { if (arbiter.holdsControl(handle)) bot.pathfinder.setGoal(null); }, 20_000);
  try {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range));
  } catch { /* short of the spot is still away from where she stood */ } finally {
    clearTimeout(timer);
    if (arbiter.holdsControl(handle)) bot.pathfinder.setGoal(null);
  }
}

// Trash (2026-11-04, direct request: "'trash' items like almost broken weapons, zombie flesh can be
// disposed of in lava"): rotten flesh and poisonous potatoes, and any tool, weapon or armor piece at
// NEAR_BROKEN wear or worse -- unless it's the only one of its kind she carries (then the least worn
// stays), so she is never left with no sword because her sword was nearly spent.
const TRASH_NAMES = new Set(["rotten_flesh", "poisonous_potato"]);
const NEAR_BROKEN = 0.9;
const GEAR_TIER = /^(wooden|stone|iron|golden|diamond|netherite|leather|chainmail|turtle|copper)_/;

function trashItems(items) {
  const trash = [];
  const kinds = new Map();
  const maxWear = (i) => bot.registry?.items?.[i.type]?.maxDurability ?? 0;
  for (const i of items) {
    if (TRASH_NAMES.has(i.name)) { trash.push({ item: i, count: i.count }); continue; }
    if (!maxWear(i)) continue;
    const kind = i.name.replace(GEAR_TIER, "");
    kinds.set(kind, [...(kinds.get(kind) ?? []), i]);
  }
  for (const stacks of kinds.values()) {
    const wear = (i) => (i.durabilityUsed ?? 0) / maxWear(i);
    const worn = stacks.filter((i) => wear(i) >= NEAR_BROKEN).sort((a, b) => wear(a) - wear(b));
    for (const i of worn.length === stacks.length ? worn.slice(1) : worn) trash.push({ item: i, count: i.count });
  }
  return trash;
}

// junkToDrop() and trashItems() together, one entry per stack.
export function surplusToDrop(items) {
  const counts = new Map();
  for (const { item, count } of [...junkToDrop(items), ...trashItems(items)]) {
    counts.set(item, Math.max(counts.get(item) ?? 0, count));
  }
  return [...counts].map(([item, count]) => ({ item, count }));
}

// What a full bot may drop: rotten flesh; every weapon of a kind but the best one (bow, crossbow,
// sword -- a sword by tier, then wear); every crafting table, shield, rod, shears or flint and
// steel but the least worn; seeds beyond SEED_RESERVE of each kind. Nothing else -- not food, ore,
// building blocks, armor or tools she works with.
const KEEP_ONE_OF = new Set(["bow", "crossbow", "crafting_table", "shield", "fishing_rod", "shears", "flint_and_steel"]);
const SEED_RESERVE = 64;
const SEED_ITEM = /^(wheat|beetroot|melon|pumpkin|torchflower)_seeds$|^pitcher_pod$/;

function junkToDrop(items) {
  const drops = [];
  const kinds = new Map();
  const kindOf = (name) => (KEEP_ONE_OF.has(name) ? name : name.endsWith("_sword") ? "sword" : null);
  const worth = (i) => [i.name.endsWith("_sword") ? (TOOL_RANK[i.name.split("_")[0]] ?? 0) : 0, -(i.durabilityUsed ?? 0)];
  const better = (a, b) => { const [x, y] = [worth(a), worth(b)]; return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1]; };
  const seedsKept = new Map();
  for (const i of items) {
    if (i.name === "rotten_flesh") { drops.push({ item: i, count: i.count }); continue; }
    if (SEED_ITEM.test(i.name)) {
      const room = Math.max(0, SEED_RESERVE - (seedsKept.get(i.name) ?? 0));
      seedsKept.set(i.name, (seedsKept.get(i.name) ?? 0) + Math.min(room, i.count));
      if (i.count > room) drops.push({ item: i, count: i.count - room });
      continue;
    }
    const kind = kindOf(i.name);
    if (kind) kinds.set(kind, [...(kinds.get(kind) ?? []), i]);
  }
  for (const stacks of kinds.values()) {
    const best = stacks.reduce((a, b) => (better(b, a) ? b : a));
    for (const i of stacks) {
      const count = i === best ? i.count - 1 : i.count;
      if (count > 0) drops.push({ item: i, count });
    }
  }
  return drops;
}

const EXTRA_CHEST_RETRY_MS = 10 * 60_000;
let extraChestRetryAt = 0;

export async function checkInventoryFull() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkInventoryFull") || bot.isSleeping) return;
  const emptySlots = INVENTORY_MAIN_HOTBAR_SLOTS - bot.inventory.items().length;
  const chestsFull = Date.now() < storageBlockedUntil;
  // 2026-11-04 (direct request: "when a chest is full, they should build another chest"): every
  // chest at home full is reason enough on its own, not only once her own slots run out.
  if (emptySlots > INVENTORY_FULL_SLOTS && !(chestsFull && bot.spawnPoint && Date.now() >= extraChestRetryAt)) return;
  if (bot.spawnPoint && (chestsFull || countUsableNearHome(["chest"]) < 1)) {
    const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
    if (!handle) return;
    try {
      const result = await makeHomeChest(handle);
      console.log(`[${USERNAME}] ${emptySlots > INVENTORY_FULL_SLOTS ? "chests" : "inventory"} full, ` +
        `${chestsFull ? "every chest at home full" : "no chest at home"}: ${result.text} (ok=${result.ok})`);
      // No wood within reach is no wood 20s from now: that failure waits before the next try. Any
      // other (2026-11-05: a planks craft read a stale inventory, "missing ingredient") retries on
      // the next check -- backing off on it left a bot holding 8 planks idle for 10 minutes.
      if (result.noWood) extraChestRetryAt = Date.now() + EXTRA_CHEST_RETRY_MS;
    } finally {
      handle.release();
    }
    return;
  }
  await storeSurplusValuables("inventory management");
}

// Trash into lava (2026-11-04, direct request). Lava she can see, with open air over it so a thrown
// item falls in; she walks to within reach of it -- a GoalNear beside it, and the pathfinder never
// routes through lava (it's in Movements.blocksToAvoid) -- looks at it and throws. No lava in sight
// and nothing happens here: a full inventory still drops surplus the old way (makeHomeChest).
export const TRASH_CHECK_MS = parseInt(process.env.MC_TRASH_CHECK_MS || "300000", 10);
const LAVA_SEARCH_RADIUS = 24;
const LAVA_REACH = 4;

function visibleLava() {
  const lava = bot.registry.blocksByName.lava;
  if (!lava) return null;
  return bot.findBlocks({ matching: lava.id, maxDistance: LAVA_SEARCH_RADIUS, count: 16 })
    .find((pos) => bot.blockAt(pos.offset(0, 1, 0))?.boundingBox === "empty") ?? null;
}

export async function checkTrash() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkTrash") || bot.isSleeping || !bot.entity) return;
  const trash = trashItems(bot.inventory.items());
  if (!trash.length) return;
  const lava = visibleLava();
  if (!lava) return;
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    await walkTo(lava, 2, handle);
    if (!arbiter.holdsControl(handle)) return;
    if (bot.entity.position.distanceTo(lava) > LAVA_REACH) {
      console.log(`[${USERNAME}] trash: couldn't get within reach of the lava at ${lava}.`);
      return;
    }
    await bot.lookAt(lava.offset(0.5, 0.5, 0.5), true);
    for (const { item, count } of trash) {
      if (count >= item.count) await bot.tossStack(item);
      else await bot.toss(item.type, null, count);
    }
    console.log(`[${USERNAME}] trash: threw ${trash.map(({ item, count }) => `${count} ${item.name}`).join(", ")} ` +
      `into the lava at ${lava}.`);
  } finally {
    handle.release();
  }
}

// Item #5 of "fix all the above" (inventory insurance). Real gap: checkInventoryFull() only ever
// stores surplus when SPACE runs low -- a bot can carry a stack of diamonds or a full spare
// armor set indefinitely with room to spare and never bank any of it, so a death that was
// otherwise perfectly survivable-in-hindsight (just bad luck, not a resource problem) still wipes
// out real, hard-won progress for no reason a chest three minutes away couldn't have prevented.
// This is the same storeSurplusValuables() pass, triggered by a different, risk-based condition
// instead: taken real damage (health at or below INSURANCE_HEALTH_THRESHOLD, well above
// EMERGENCY_HEALTH_THRESHOLD's near-death flee trigger -- this fires on "this is getting risky,"
// not "about to die"). A cooldown keeps one low-health episode from retrying every tick while
// health stays low -- one honest attempt is enough; retrying constantly wouldn't bank anything
// new and would just compete with checkSelfDefense for the same idle ticks.
const INSURANCE_HEALTH_THRESHOLD = 14; // out of 20
const INSURANCE_COOLDOWN_MS = 120_000;
let lastInsuranceAttemptAt = 0;

export async function checkInventoryInsurance() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkInventoryInsurance") || bot.isSleeping) return;
  if (bot.health > INSURANCE_HEALTH_THRESHOLD) return;
  if (Date.now() - lastInsuranceAttemptAt < INSURANCE_COOLDOWN_MS) return;
  lastInsuranceAttemptAt = Date.now();
  await storeSurplusValuables("inventory insurance");
}

// Direct request, 2026-09-09 ("when they find saplings, they should plant them"). A reflex, same
// idle-tick/busy-acting pattern as checkInventoryFull/checkInventoryInsurance -- fires whenever
// she happens to be carrying ANY sapling (mining/chopping trees drops them incidentally, not
// something she ever went looking for on purpose), not something a player/planner has to ask
// for. actions.js's own "plant_sapling" (1.33.0) decides WHERE (near a same-species tree, else
// open ground away from a building); this only decides WHETHER and WHICH.
export const SAPLING_CHECK_MS = parseInt(process.env.MC_SAPLING_CHECK_MS || "30000", 10);

export async function checkSaplings() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkSaplings") || bot.isSleeping) return;
  const sapling = bot.inventory.items().find((i) => i.name.endsWith("_sapling"));
  if (!sapling) return;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const result = await performAction(bot, { type: "plant_sapling", item: sapling.name }, USERNAME, handle);
    console.log(`[${USERNAME}] sapling planting: ${result.text} (ok=${result.ok})`);
  } catch (err) {
    console.error(`[${USERNAME}] sapling check failed:`, err.message);
  } finally {
    handle.release();
  }
}

// Direct request, 2026-09-07 ("do 1-3" + "and 4" -> torch placement). Same idle-tick/busy-acting
// pattern as everything else -- fires between discrete actions rather than interrupting an
// in-flight bot.collectBlock.collect() mid-dig (which already handles its own tool/hand equip
// internally; swapping to a torch mid-collect would fight that). Reuses the EXISTING "place"
// action (already generic over any held block, see actions.js's own comment on it) rather than a
// new performAction case -- placing a torch is mechanically identical to placing a furnace.
// block.light (confirmed against prismarine-block source) is the real per-position light value,
// 0-15; under 8 is the common threshold below which hostile mobs can spawn, the same heuristic
// most mineflayer bots use since there's no simpler "is this dark" signal exposed directly.
export const LIGHTING_CHECK_MS = parseInt(process.env.MC_LIGHTING_CHECK_MS || "20000", 10);
// DARK_LIGHT_LEVEL now lives in actions.js (2026-09-10), shared with the new "light_area" action
// below rather than kept as a second, driftable copy here.

export async function checkLighting() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkLighting") || bot.isSleeping || !bot.entity) return;
  if (!bot.inventory.items().some((i) => i.name === "torch")) return;
  const block = bot.blockAt(bot.entity.position);
  if (!block || block.light >= DARK_LIGHT_LEVEL) return;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const result = await performAction(bot, { type: "place", item: "torch" }, USERNAME, handle);
    if (result.ok) console.log(`[${USERNAME}] lighting: ${result.text} (light was ${block.light})`);
  } catch (err) {
    console.error(`[${USERNAME}] lighting check failed:`, err.message);
  } finally {
    handle.release();
  }
}

// Direct request, 2026-09-10 ("fix the lighting logic"), following a confirmed live incident:
// 1260+ deaths in ~26h traced to the shared base sitting in pitch dark at ground level with an
// uncapped nightly mob buildup (dozens of hostiles counted within 80 blocks at once) -- a single
// bot's self-defense fighting one threat at a time was never going to survive an actual swarm.
// checkLighting() above only ever reacted to wherever a bot personally happened to be standing
// the moment its own tile went dark -- nothing proactively lit up the area bots actually live
// and sleep in. New checkHomeLighting(): when she's carrying torches, runs actions.js's new
// "light_area" centered on home (bot.spawnPoint) -- a real area sweep, not a per-tile reflex, so a
// longer interval than checkLighting's own 20s is appropriate. Self-limiting across the whole
// fleet by construction (see light_area's own header): no explicit cross-bot coordination needed.
export const HOME_LIGHTING_CHECK_MS = parseInt(process.env.MC_HOME_LIGHTING_CHECK_MS || "90000", 10);
const HOME_LIGHTING_MAX_BACKOFF_MS = 30 * 60_000;
let homeLightingFailures = 0;
let homeLightingNextAt = 0;

export async function checkHomeLighting() {
  if (!HOME_LIGHTING_MAINTAINER || Date.now() < homeLightingNextAt) return;
  if (!AUTONOMY_ENABLED || routineBlocked("checkHomeLighting") || bot.isSleeping) return;
  let succeeded = false;
  try {
    succeeded = await lightHomeOnce();
  } finally {
    homeLightingFailures = succeeded ? 0 : homeLightingFailures + 1;
    homeLightingNextAt = succeeded ? 0 : Date.now() +
      Math.min(HOME_LIGHTING_CHECK_MS * 2 ** homeLightingFailures, HOME_LIGHTING_MAX_BACKOFF_MS);
  }
}

// One home-lighting attempt; true only if the area actually got (or already was) lit.
async function lightHomeOnce() {
  const home = bot.spawnPoint;
  if (!home) return false; // spawn point not known yet -- genuinely nothing to anchor on

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return true; // busy this tick -- not a failure
  try {
    // Direct report, 2026-09-17 ("dig in" -> Amy's chronic near-home danger, root-caused live):
    // the old "no torches -> return" used to be COMPLETELY SILENT -- no log line at all -- so a
    // resource-starved bot (confirmed live: Amy, stuck early in the tech tree for 17+ hours)
    // could go the ENTIRE time with this check doing nothing, and there was no trace of why in
    // the logs. Torches need no crafting table (a real, confirmed recipe fact, same as
    // sticks/planks -- bot.recipesFor(..., null) already finds the table-less recipe on its
    // own), so if she's carrying fuel and a stick, she can just make some herself instead of
    // only ever depending on already having some. If she genuinely can't (no fuel, no stick),
    // that's now a real, visible log line instead of silence.
    if (!bot.inventory.items().some((i) => i.name === "torch")) {
      // Direct live incident, 2026-09-18 (nighttime mob crisis, 7+ deaths in under a minute):
      // confirmed this whole gate has been the real, recurring blocker -- it only EVER checked
      // this one bot's own personal inventory at the exact 90s-interval instant this check
      // happens to fire, while not busy/asleep/arbiter-locked. Across a fleet whose self-defense
      // triggers every few seconds during any real incident, no bot reliably has fuel+stick AND a
      // free moment at the same time, so this branch has been silently doing nothing for days
      // despite two prior fix attempts (see this function's own 2026-09-17 note above). Now tries
      // a chest first -- reuses "loot"'s own existing local-then-remembered-chest search (§30/§19)
      // instead of only ever depending on what she happens to be personally carrying; cheaper and
      // far more likely to succeed than crafting from scratch, especially now that the shared base
      // chests can be pre-stocked (tools/minecraft-chests/).
      const lootResult = await performAction(bot, { type: "loot", item: "torch", count: 4 }, USERNAME, handle);
      if (lootResult.ok) {
        console.log(`[${USERNAME}] home lighting: grabbed torches from a chest -- ${lootResult.text}`);
      } else if (lootResult.cancelled) {
        return true;
      } else {
        // Direct live incident, 2026-09-21 (a full nighttime mob swarm -- 21 zombies killed via
        // RCON around one unlit base in a single sweep -- "combat is not fixed, they just stand
        // there and get killed": no amount of per-bot combat tuning was ever going to survive an
        // environment spawning hostiles faster than 9 bots could kill them; this gate is the real
        // upstream cause). Root-caused live: `craftItem()` (this file's own reuse of actions.js's
        // helper) already auto-chains stick <- planks <- log up to 3 levels deep
        // (`simpleSourceFor()`) -- a bot carrying logs, which routine wood-gathering makes common,
        // can craft a torch from them without ever holding a loose stick first. This gate was
        // checking for an ALREADY-MADE stick specifically, which almost nothing keeps around once
        // consumed into other crafts -- so it kept bailing out here even when a torch was
        // trivially craftable, exactly the same shape as this function's own two PRIOR fix
        // attempts (2026-09-17, 2026-09-18) each closed a different way this gate went silent.
        // Now checks for ANY real wood source (stick, planks, or a log/stem craft() can chain
        // through), not just a finished stick -- letting craft's own existing auto-chain do the
        // rest, same as every other caller already relies on it for.
        const fuel = bot.inventory.items().find((i) => i.name === "coal" || i.name === "charcoal");
        const hasWoodSource = bot.inventory.items().some((i) => i.name === "stick" ||
          i.name.endsWith("_planks") || i.name.endsWith("_log") || i.name.endsWith("_stem"));
        if (!fuel || !hasWoodSource) {
          console.log(`[${USERNAME}] home lighting: no torches (chest check came up empty too: ` +
            `${lootResult.text}), and no fuel+wood on hand to craft one -- skipping for now.`);
          return false;
        }
        const craftResult = await performAction(bot, { type: "craft", item: "torch", count: torchBatch() }, USERNAME, handle);
        console.log(`[${USERNAME}] home lighting: crafted torches first -- ${craftResult.text} (ok=${craftResult.ok})`);
        if (!craftResult.ok) return !!craftResult.cancelled;
      }
    }
    const result = await performAction(bot, { type: "light_area", near: home }, USERNAME, handle);
    console.log(`[${USERNAME}] home lighting: ${result.text} (ok=${result.ok})`);
    return result.ok || !!result.cancelled;
  } catch (err) {
    console.error(`[${USERNAME}] home lighting check failed:`, err.message);
    return false;
  } finally {
    handle.release();
  }
}
