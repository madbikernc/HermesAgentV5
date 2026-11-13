// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: hunger, ripe crops, give requests, surplus storage and the home chest.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { writeMemoryNote } from "./longterm.js";
import { publish as buzzPublish } from "./buzz.js";
import { FOOD_NAMES, consolidationPending, farmStatus, isEssentialItem, performAction, takeConsolidationHint } from "./actions.js";
import * as arbiter from "./arbiter.js";
import { narrateAction } from "./chat.js";
import { noteNearbyResources, pendingGiveRequest, setPendingGiveRequest, settleGiveClaims } from "./fleet-coordination.js";
import { gatherPlanks } from "./gear-goals.js";
import { routineBlocked } from "./goal-proposal.js";
import { heldCount, lastHarvestAt, setLastHarvestAt } from "./goal-runners.js";
import { AGENT_ID, AUTONOMY_ENABLED, PERSONA_NAME, USERNAME, bot, currentGoal } from "./index.js";
import { dropSpotAwayFrom, surplusToDrop, walkTo } from "./upkeep-home.js";


// Direct follow-up, 2026-09-07: "look for more ways to improve their autonomy" -> hunger. Same
// idle-tick/busy-acting pattern as checkSleep/checkSelfDefense. Eats proactively (below full, not
// only once it's a real problem) since a failed "nothing to eat" check is cheap and harmless --
// correctness over minimizing calls, same standing instruction as everywhere else tonight.
export const HUNGER_CHECK_MS = parseInt(process.env.MC_HUNGER_CHECK_MS || "15000", 10);
export const HUNGER_THRESHOLD = 18; // out of a max of 20

// Review MB-15, 2026-09-24: hunger used to wait politely behind any model call or same-tier work,
// with no escalation -- a bot doing back-to-back goal steps could starve. At or below this food
// level it preempts goal steps and chores (HUNGER_CRITICAL tier) instead of waiting for idle.
const CRITICAL_FOOD_LEVEL = 6; // vanilla: sprinting stops at 6, starvation damage at 0

// 2026-09-25 (4,203 failed "eat"s in a day on spark, 10 successes): with nothing to eat this used to
// fail silently every 15s, forever -- next to a chest holding 64 of every food. Now she fetches food
// from a chest first (loot "food"); fishing stays the fallback. A failed fetch waits
// FOOD_FETCH_BACKOFF_MS before the next try, and with nothing to eat, no rod and the fetch backing
// off, the check does nothing at all instead of logging another failed "eat".
const FOOD_FETCH_COUNT = 8;
const FOOD_FETCH_BACKOFF_MS = 5 * 60_000;
export let foodFetchBlockedUntil = 0;
export const hasFood = () => bot.inventory.items().some((i) => FOOD_NAMES.includes(i.name));
export const hasRod = () => bot.inventory.items().some((i) => i.name === "fishing_rod");

export async function checkHunger() {
  if (!AUTONOMY_ENABLED || bot.isSleeping) return;
  if (bot.food >= HUNGER_THRESHOLD) return;
  const canFetch = Date.now() >= foodFetchBlockedUntil;
  const critical = bot.food <= CRITICAL_FOOD_LEVEL;
  if (!hasFood() && !hasRod() && !canFetch && !(critical && heldCount((n) => n === "rotten_flesh") > 0)) return;
  if (!critical && routineBlocked("checkHunger")) return;

  const handle = await arbiter.requestControl(bot,
    critical ? arbiter.OWNERS.HUNGER_CRITICAL : arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    if (!hasFood() && canFetch) {
      const fetched = await performAction(bot, { type: "loot", item: "food", count: FOOD_FETCH_COUNT }, USERNAME, handle);
      console.log(`[${USERNAME}] hunger: nothing to eat, fetching food -- ${fetched.text} (ok=${fetched.ok})`);
      if (fetched.cancelled) return;
      // 2026-10-30: no food in any chest and starving -- hunt. Babs sat at food 0 for hours,
      // retrying the empty chests every five minutes. Only when critical: a herd isn't spent on
      // a snack.
      if (!hasFood() && critical) {
        const hunted = await performAction(bot, { type: "hunt" }, USERNAME, handle);
        console.log(`[${USERNAME}] hunger: no food in chests, hunting -- ${hunted.text} (ok=${hunted.ok})`);
        if (hunted.cancelled) return;
      }
      if (!hasFood()) foodFetchBlockedUntil = Date.now() + FOOD_FETCH_BACKOFF_MS;
    }
    // Starving with no real food after all that: rotten flesh, if she has any.
    const lastResort = !hasFood() && critical && heldCount((n) => n === "rotten_flesh") > 0;
    if (hasFood() || lastResort) {
      const result = await performAction(bot, { type: "eat", lastResort }, USERNAME, handle);
      if (result.ok) {
        console.log(`[${USERNAME}] hunger: ${result.text} (food was ${bot.food})`);
        return;
      }
      if (result.cancelled) return;
    }
    if (hasRod()) {
      const fishResult = await performAction(bot, { type: "fish" }, USERNAME, handle);
      console.log(`[${USERNAME}] hunger (fishing): ${fishResult.text} (ok=${fishResult.ok})`);
    }
  } catch (err) {
    console.error(`[${USERNAME}] hunger check failed:`, err.message);
  } finally {
    handle.release();
  }
}

// Ripe crops near home get harvested and replanted whoever planted them -- onlyRipe, so this never
// starts a farm by itself. Any bot near home with a free moment does it.
export const RIPE_CHECK_MS = parseInt(process.env.MC_RIPE_CHECK_MS || "60000", 10);
// First live hour (2026-09-25): every bot found the same ripe crops and failed to reach them.
// After a failure, leave them alone for a while instead of retrying every minute.
const RIPE_FAIL_BACKOFF_MS = 15 * 60_000;
let ripeBlockedUntil = 0;

export async function checkRipeCrops() {
  if (!AUTONOMY_ENABLED || bot.isSleeping || !bot.entity) return;
  const home = bot.spawnPoint;
  if (home && bot.entity.position.distanceTo(home) > 48) return;
  if (Date.now() < ripeBlockedUntil || !farmStatus(bot, null).ripe || routineBlocked("checkRipeCrops")) return;
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const result = await performAction(bot, { type: "harvest", onlyRipe: true }, USERNAME, handle);
    console.log(`[${USERNAME}] ripe crops: ${result.text} (ok=${result.ok})`);
    if (result.harvested) setLastHarvestAt(Date.now());
    else if (!result.cancelled) ripeBlockedUntil = Date.now() + RIPE_FAIL_BACKOFF_MS;
  } finally {
    handle.release();
  }
}


// Direct follow-up, 2026-09-07: "look for more ways to improve their autonomy" -> bot-to-bot
// help. Fulfilling a request is itself a real action (path to the requester, toss the item), so
// it goes through the same idle-tick/busy-acting gate as everything else -- never interrupts
// whatever she's already doing. Clears the pending request regardless of outcome once attempted,
// rather than retrying indefinitely if the requester wandered off in the meantime.
export const GIVE_CHECK_MS = parseInt(process.env.MC_GIVE_CHECK_MS || "10000", 10);

export async function checkPendingGiveRequests() {
  settleGiveClaims();
  if (pendingGiveRequest && Date.now() > pendingGiveRequest.expiresAt) {
    console.log(`[${USERNAME}] give request expired: ${pendingGiveRequest.count} ${pendingGiveRequest.item} for ${pendingGiveRequest.forPlayer}`);
    setPendingGiveRequest(null);
  }
  if (!AUTONOMY_ENABLED || routineBlocked("checkPendingGiveRequests") || bot.isSleeping || !pendingGiveRequest) return;
  const pending = pendingGiveRequest;
  const { forPlayer, item, count } = pending;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note. A failed
  // acquisition leaves the request pending (retried each check until GIVE_REQUEST_TTL_MS) --
  // silently dropping a promise already made to a specific player is a real regression.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return; // still pending -- retried next check until it expires
  setPendingGiveRequest(null);
  let result;
  try {
    console.log(`[${USERNAME}] fulfilling request: giving ${count} ${item} to ${forPlayer}`);
    result = await performAction(bot, { type: "give", player: forPlayer, item, count }, USERNAME, handle);
    console.log(`[${USERNAME}] give result: ${result.text} (ok=${result.ok})`);
    if (result.cancelled) setPendingGiveRequest(pending); // interrupted, not failed -- deliver later
    // Review MB-13 follow-up (2026-09-24): a genuine failure gets one retry before the promise is
    // dropped. A successful toss reports the dropped count. Only the recipient can verify pickup.
    else if (!result.ok && (pending.attempts ?? 0) < 1) setPendingGiveRequest({ ...pending, attempts: (pending.attempts ?? 0) + 1 });
    if (result.ok) {
      buzzPublish(AGENT_ID, "minecraft-coordination", JSON.stringify({ type: "delivered",
        requestId: pending.requestId, forPlayer, item, count: result.droppedCount, donor: USERNAME }))
        .catch((err) => console.error(`[${USERNAME}] delivery ack publish failed:`, err.message));
    }
  } catch (err) {
    console.error(`[${USERNAME}] give check failed:`, err.message);
  } finally {
    handle.release();
  }
  if (result?.ok) bot.chat(await narrateAction(result.text));
}

// Direct request, 2026-09-07 ("do all" -> base/chest storage). Same idle-tick/busy-acting
// pattern as everything else. bot.inventory.items().length is a clean count of occupied slots
// in the 36-slot main+hotbar range (one entry per occupied slot, confirmed against how loot's
// own containerItems()/items() distinction was worked out earlier tonight) -- no need to touch
// raw slot indices directly. Picks the single LARGEST non-essential stack so one trip actually
// frees meaningful space rather than storing one item at a time.
export const INVENTORY_CHECK_MS = parseInt(process.env.MC_INVENTORY_CHECK_MS || "20000", 10);
export const INVENTORY_FULL_SLOTS = 3; // 3 or fewer empty slots counts as "getting full"
export const INVENTORY_MAIN_HOTBAR_SLOTS = 36;

// Extracted so checkInventoryInsurance() (below) can trigger the exact same store pass off a
// different condition, instead of a second copy drifting out of sync.
// Efficiency pass, 2026-09-24 (measured: 404 failed store trips/day vs 177 successful, 929
// "destination full"). Once a store attempt finds only full or obstructed chests, all surplus
// storing pauses for STORAGE_BACKOFF_MS instead of walking back to the same full chests.
const STORAGE_BACKOFF_MS = 20 * 60_000;
export let storageBlockedUntil = 0;
function noteStoreResult(result) {
  if (result.ok) {
    storageBlockedUntil = 0;
  } else if (!result.cancelled && /found chests nearby, but|no chests? (nearby|found)/i.test(result.text)) {
    storageBlockedUntil = Date.now() + STORAGE_BACKOFF_MS;
    console.log(`[${USERNAME}] storage: no usable chest space -- pausing surplus storing for ${STORAGE_BACKOFF_MS / 60_000} min`);
  }
}

// Review MB-09 follow-up (2026-09-24): inventory-full and insurance storing run DURING goals, so
// they skip whatever the active goal is using: its target and Builder item, every item/block its
// steps have named, items its description names, and the recipe inputs for all of those.
function goalReservedItems() {
  const reserved = new Set();
  const goal = currentGoal;
  if (!goal) return reserved;
  const named = [goal.targetItem, goal.builderPriorityItem];
  for (const step of goal.actionsTaken ?? []) named.push(step.item, step.block);
  const text = goal.description.toLowerCase();
  for (const i of bot.inventory.items()) {
    if (text.includes(i.name) || text.includes(i.name.replace(/_/g, " "))) named.push(i.name);
  }
  // Items the goal names but doesn't hold yet ("craft a furnace", "some iron ingots"): 1-3 word
  // runs of the description checked against real item ids, so their recipe inputs are kept too.
  const words = text.split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const id = words.slice(i, i + n).join("_");
      if (bot.registry.itemsByName[id]) named.push(id);
      else if (bot.registry.itemsByName[id.replace(/s$/, "")]) named.push(id.replace(/s$/, ""));
    }
  }
  for (const name of named.filter(Boolean)) {
    reserved.add(name);
    const itemDef = bot.registry.itemsByName[name];
    if (!itemDef) continue;
    try {
      for (const recipe of bot.recipesAll(itemDef.id, null, true)) {
        for (const d of recipe.delta ?? []) {
          if (d.count < 0 && bot.registry.items[d.id]) reserved.add(bot.registry.items[d.id].name);
        }
      }
    } catch { /* no recipe data for this item -- the name itself is still reserved */ }
  }
  return reserved;
}

export async function storeSurplusValuables(reason) {
  // Saplings excluded, 2026-09-09: checkSaplings() (below) exists specifically to plant them,
  // not warehouse them -- without this, a bot with a near-full inventory would chest away her
  // largest sapling stack before ever getting a chance to plant it, since a sapling is otherwise
  // just as "non-essential" as any other raw material by isEssentialItem()'s own gear/fuel/food
  // definition.
  if (Date.now() < storageBlockedUntil) return;
  const reserved = goalReservedItems();
  const surplus = bot.inventory.items().filter((i) => !isEssentialItem(i.name) && !isKeptItem(i.name) &&
    !reserved.has(i.name) && !i.name.endsWith("_sapling"));
  if (!surplus.length) return; // genuinely nothing spare to store this tick
  surplus.sort((a, b) => b.count - a.count);
  const target = surplus[0];

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const result = await performAction(bot, { type: "store", item: target.name, count: target.count }, USERNAME, handle);
    console.log(`[${USERNAME}] ${reason}: ${result.text} (ok=${result.ok})`);
    noteStoreResult(result);
  } catch (err) {
    console.error(`[${USERNAME}] ${reason} failed:`, err.message);
  } finally {
    handle.release();
  }
}

// Direct request, 2026-09-09: "after any crafting activity, surplus materials should be stored
// in a chest as close to their sleeping home as possible." A deliberately separate function from
// storeSurplusValuables above, not a shared parameter on it: that one is a SPACE-management
// reflex (picks the single largest non-essential stack, nearest-to-wherever-she-is chest, "get
// rid of it quickly"), this one is a CLEANUP reflex after a specific activity (batches every
// distinct surplus item, always aimed at home specifically) -- different triggers, different
// goals, worth keeping legible as two functions rather than one with a mode flag. "Home" is
// bot.spawnPoint (2026-10-18: no more claimed bed to prefer over it -- "sleep" itself now just
// tries any unoccupied bed nearest-first, with no persistent notion of "hers").
const STORE_NEAR_HOME_BATCH_LIMIT = 5;

// Review MB-09, 2026-09-24: post-craft cleanup ran immediately after every craft/smelt/loot, while
// the goal that needed the result was still active -- a crafting table made for the next PLACE
// step went straight into a chest, and freshly looted ingredients went back before the CRAFT.
// Cleanup is now deferred: a craft only marks it due, and checkDeferredSurplusCleanup() runs it
// once there's no active goal and nothing has been crafted for SURPLUS_CLEANUP_QUIET_MS.
// KEEP_ITEM_NAMES / KEEP_ITEM_SUFFIXES are never "surplus": placeable infrastructure and
// working tools a bot needs on hand regardless of goal.
export const SURPLUS_CLEANUP_QUIET_MS = 2 * 60_000;
const KEEP_ITEM_NAMES = new Set([
  "crafting_table", "furnace", "chest", "torch", "shield", "fishing_rod", "shears", "bucket",
  "water_bucket", "flint_and_steel", "bow", "arrow", "crossbow",
]);
const KEEP_ITEM_SUFFIXES = ["_bed", "_boat"];
export let surplusCleanupDueAt = 0;
// For modules split out of this file: an imported binding is read-only there.
export function setSurplusCleanupDueAt(value) { surplusCleanupDueAt = value; }

export function isKeptItem(name) {
  return KEEP_ITEM_NAMES.has(name) || KEEP_ITEM_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export async function checkDeferredSurplusCleanup() {
  if (!surplusCleanupDueAt || Date.now() < surplusCleanupDueAt) return;
  if (!AUTONOMY_ENABLED || currentGoal || routineBlocked("checkDeferredSurplusCleanup") || bot.isSleeping) return;
  surplusCleanupDueAt = 0;
  await storeSurplusNearHome("post-craft cleanup");
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 3 -- "elevates 'don't hoard'
// from an incidental cleanup pass to an explicit, regularly-checked Tier 2 item"). Until now,
// storeSurplusNearHome() only ever ran right after a craft (checkDeferredSurplusCleanup, just
// above) -- surplus picked up any other way (looted, given by a teammate, mined without
// crafting anything from it) never got checked at all. Same gating, just unconditional on a
// standing interval rather than waiting on a prior craft to schedule it.
export const SURPLUS_SHARING_CHECK_MS = parseInt(process.env.MC_SURPLUS_SHARING_CHECK_MS || "300000", 10); // 5 min
export async function checkSurplusSharing() {
  if (!AUTONOMY_ENABLED || currentGoal || routineBlocked("checkSurplusSharing") || bot.isSleeping) return;
  await storeSurplusNearHome("Tier 2: regular surplus check");
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 4 -- "makes [location-sharing]
// an explicit tier item so a bot who's otherwise idle can go looking specifically to report
// back, not just incidentally while doing something else"). noteNearbyResources() (above) is
// already a pure, no-movement findBlocks + memory-write sweep -- safe alongside an active goal
// the same way mine/explore/craft already fire it as a side effect, so this needs no arbiter
// control or busy-check, just a standing cadence of its own instead of only ever running when
// something else happens to succeed first.
export const LOCATION_SHARING_CHECK_MS = parseInt(process.env.MC_LOCATION_SHARING_CHECK_MS || "600000", 10); // 10 min
export async function checkLocationSharing() {
  if (!AUTONOMY_ENABLED || !bot.entity) return;
  await noteNearbyResources("Tier 2: regular location sweep");
}

// Direct request, 2026-11-07: when a look into a chest shows it shares a kind of item with another
// chest nearby (recordChestSnapshot leaves the move as a hint), she brings them together in full
// stacks once she has nothing else to do.
export const CHEST_CONSOLIDATION_CHECK_MS = 60_000;
export async function checkChestConsolidation() {
  if (!consolidationPending()) return;
  if (!AUTONOMY_ENABLED || currentGoal || routineBlocked("checkChestConsolidation") || bot.isSleeping) return;
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const plan = takeConsolidationHint();
    if (!plan) return;
    const result = await performAction(bot, { type: "consolidate_chests", plan }, USERNAME, handle);
    console.log(`[${USERNAME}] chest consolidation (${plan.family}): ${result.text} (ok=${result.ok})`);
  } catch (err) {
    console.error(`[${USERNAME}] chest consolidation failed:`, err.message);
  } finally {
    handle.release();
  }
}

async function storeSurplusNearHome(reason) {
  if (Date.now() < storageBlockedUntil) return;
  const surplusNames = [...new Set(bot.inventory.items()
    .filter((i) => !isEssentialItem(i.name) && !isKeptItem(i.name) && !i.name.endsWith("_sapling"))
    .map((i) => i.name))].slice(0, STORE_NEAR_HOME_BATCH_LIMIT);
  if (!surplusNames.length) return;
  const home = bot.spawnPoint;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note. Called
  // fire-and-forget after the caller (runAction/goalTick) has already released its own handle,
  // so this acquires a fresh one of its own -- see runAction/goalTick's post-craft cleanup note.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    for (const name of surplusNames) {
      // Infinity: "store" already caps at however much she actually has via Math.min() --
      // matches STORE's own existing player-command convention (index.js's classifyIntent,
      // "unlike every other count default (1), this defaults to 'all of it'").
      const result = await performAction(bot, { type: "store", item: name, count: Infinity, near: home }, USERNAME, handle);
      console.log(`[${USERNAME}] ${reason}: ${result.text} (ok=${result.ok})`);
      if (result.cancelled) break; // MB-02: lost control -- stop the batch, not just this item
      noteStoreResult(result);
      if (Date.now() < storageBlockedUntil) break; // chests are full -- the rest won't fit either
      // Real live gap found 2026-09-09 ("monitor their behavior, look for issues"): a real
      // failure was observed for one item ("can't find dirt in slots..." -- pathfinder's own
      // scaffolding mechanic had consumed it mid-travel between when this item was picked as
      // surplus and when the deposit actually ran) that had nothing to do with the OTHER surplus
      // items in this same batch -- `break` was throwing away a perfectly good remaining batch
      // over one item-specific hiccup. Now tries every item regardless; still bounded by
      // STORE_NEAR_HOME_BATCH_LIMIT either way.
    }
  } catch (err) {
    console.error(`[${USERNAME}] ${reason} failed:`, err.message);
  } finally {
    handle.release();
  }
}

// 2026-10-30 (direct report: Babs "still can't make a shelter with a bed"): all 36 slots full and
// no chest near home -- every store failed, the bed's planks were crafted with nowhere to land, and
// mining logs failed outright. Operator's call: she makes a chest and puts it down at home, one
// step per check. The only thing ever dropped is rotten flesh, and only when she has no free slot
// and no wood to make the chest from (she can't pick up a log without a slot).
// 2026-11-04 (24h review): the chests at home were full too -- "destination full" 144 times, and
// with every slot taken the block collector threw "There are no defined chest locations!" on every
// dig (341 dirt, 413 clear_access). Babs held 10 bows, 4 crossbows and 576 seeds. A full set of
// chests now gets another chest, like no chest at all, and when there's no slot free and no wood
// to make one she drops what's plainly surplus (junkToDrop), not just rotten flesh -- the
// operator's call, 2026-11-04.
export async function makeHomeChest(handle) {
  if (heldCount((n) => n === "chest") > 0) {
    const placed = await performAction(bot, { type: "place_home", item: "chest" }, USERNAME, handle);
    if (placed.ok) {
      storageBlockedUntil = 0; // a new, empty chest: storing can start again
      const at = bot.spawnPoint;
      if (at) {
        writeMemoryNote({ scope: "world", persona: PERSONA_NAME, text: `Built a chest near ` +
          `(${at.x}, ${at.y}, ${at.z}), as of ${new Date().toISOString()}.` })
          .catch((err) => console.error(`[${USERNAME}] chest memory write failed:`, err.message));
      }
    }
    return placed;
  }
  const items = bot.inventory.items();
  const hasWood = items.some((i) => /_(log|stem)$/.test(i.name) ||
    (i.name.endsWith("_planks") && heldCount((n) => n === i.name) >= 8));
  if (items.length >= INVENTORY_MAIN_HOTBAR_SLOTS && !hasWood) {
    const junk = surplusToDrop(items);
    if (!junk.length) return { ok: false, noWood: true, text: "inventory full, no room in any chest, and nothing I'd drop." };
    // A thrown item can be picked up again two seconds later by whoever stands on it, and home is
    // where everyone stands. She throws from DROP_DISTANCE out from home, facing further out, then
    // walks straight back.
    const spot = bot.spawnPoint ? dropSpotAwayFrom(bot.spawnPoint.floored()) : null;
    if (spot) {
      await walkTo(spot.at, 1, handle);
      await bot.lookAt(spot.facing, true);
    }
    for (const { item, count } of junk) {
      if (count >= item.count) await bot.tossStack(item);
      else await bot.toss(item.type, null, count);
    }
    if (spot) await walkTo(bot.spawnPoint, 2, handle);
    const summary = [...junk.reduce((m, { item, count }) => m.set(item.name, (m.get(item.name) ?? 0) + count), new Map())]
      .map(([name, count]) => `${count} ${name}`).join(", ");
    return { ok: true, text: `dropped ${summary} to make room for a chest.` };
  }
  const gathering = await gatherPlanks(handle, 8);
  if (gathering) return gathering;
  return performAction(bot, { type: "craft", item: "chest", count: 1 }, USERNAME, handle);
}
