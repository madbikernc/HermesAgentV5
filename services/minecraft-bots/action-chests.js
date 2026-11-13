// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of actions.js (2.0.0) unchanged: the known-chests record, store ranking, consolidation, and utility-block usability.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. actions.js imports
// it; this file reads actions.js's state through live imports, so nothing here may touch it
// before actions.js has run (only declarations live here).

import { Vec3 } from "vec3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTimeout } from "./action-movement.js";
import { CHEST_SEARCH_RADIUS, hopToward } from "./action-search.js";
import { ACTION_TIMEOUT_MS, FOOD_NAMES, goals } from "./action-vocab.js";


// Direct request, 2026-09-13 ("remember what is in chests when someone opens it. if someone
// takes the item out of a chest, redact it from global memory"). A structured, mutable, SHARED
// registry -- deliberately NOT the fuzzy RAG-based world-memory notes (hermes-rag/longterm.js)
// used for resource/crafted-object LOCATIONS elsewhere in this file: that system is append-only/
// dedup-based, built for "is this roughly the same fact as one already noted," not "replace this
// chest's exact contents with what's true right now." A chest's contents change every time
// anyone opens it, so this needs real point-in-time overwrites, not a growing pile of similar
// notes -- same "small shared JSON file under the durable mount" pattern PEN_FILE already uses,
// keyed by chest position (rounded -- a chest occupies one exact block, no need for
// SwimMovements-style fuzziness). Recording a FULL snapshot on every real interaction means
// "redaction" is a side effect of always writing the current truth, never a separate
// delete-this-one-item operation that could drift from reality.
const KNOWN_CHESTS_FILE = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/known_chests.json`;

function chestKey(position) {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`;
}

export async function loadKnownChests() {
  try {
    return JSON.parse(await readFile(KNOWN_CHESTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveKnownChests(data) {
  try {
    await mkdir(path.dirname(KNOWN_CHESTS_FILE), { recursive: true });
    await writeFile(KNOWN_CHESTS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("known_chests: failed to persist:", err.message);
  }
}

// Called after every real chest interaction (a plain open, or open+withdraw, or open+deposit)
// with whatever chest.containerItems() shows AT THAT EXACT MOMENT -- always the current truth,
// so an item someone just withdrew is simply absent from this write, and one just deposited is
// present. Read-modify-write against one shared file, same low-contention tolerance every other
// piece of shared fleet state here already accepts (pen location, claimed beds) -- a rare
// simultaneous write from two bots opening the same chest at once could lose one update, judged
// an acceptable, self-correcting-on-next-open tradeoff rather than building real locking for it.
// slotCount (the chest window's inventoryStart) records how many slots are still free, so storing
// can pass over a chest already known to be full. When this chest shares a kind of item with
// another known chest nearby, the move that would bring them together is left for
// takeConsolidationHint() (2026-11-07).
export async function recordChestSnapshot(position, items, slotCount) {
  const known = await loadKnownChests();
  const contents = {};
  for (const item of items) contents[item.name] = (contents[item.name] || 0) + item.count;
  known[chestKey(position)] = {
    position: { x: position.x, y: position.y, z: position.z },
    contents,
    ...(slotCount ? { freeSlots: Math.max(0, slotCount - items.length) } : {}),
    lastSeenAt: new Date().toISOString(),
  };
  await saveKnownChests(known);
  const plan = findConsolidation(known, position, { involving: chestKey(position) });
  if (plan) consolidationHint = plan;
}

// Direct request, 2026-11-07: "check world knowledge of chest contents before stashing inventory in
// a chest, and stash their items in a chest already containing the same or similar items. If they
// look in a chest, and learn that something in there is the same or similar to what's in another
// chest, they should move the items to be together in full stacks." Similar means one family: any
// wood's logs, any color's wool, every seed, all the stone kinds, all food, tools, armor.
const STONE_ITEM_NAMES = new Set(["cobblestone", "stone", "cobbled_deepslate", "deepslate", "granite",
  "diorite", "andesite", "tuff", "blackstone", "netherrack", "sandstone"]);
const FAMILY_SUFFIX = /_(log|wood|stem|planks|sapling|leaves|wool|carpet|bed|seeds|ingot|nugget|ore|dye|boat)$/;
export function itemFamily(name) {
  if (name.startsWith("raw_")) return "ore";
  if (STONE_ITEM_NAMES.has(name)) return "stone";
  if (FOOD_NAMES.includes(name)) return "food";
  if (/_(sword|pickaxe|axe|shovel|hoe)$/.test(name)) return "tools";
  if (/_(helmet|chestplate|leggings|boots)$/.test(name)) return "armor";
  const suffix = name.match(FAMILY_SUFFIX)?.[1];
  if (suffix === "wood" || suffix === "stem") return "log";
  return suffix ?? name;
}

export const STORE_CANDIDATE_LIMIT = 5;

// Where to put itemName: chests already holding it first, then ones holding its family, then empty
// or never-opened ones, then the rest; a chest last seen full goes behind all of those. Nearest
// first within each. `positions` are the chests findBlocks just saw; known chests within the
// search radius of `point` join them even when findBlocks missed them.
export function rankStoreChests(known, positions, itemName, point) {
  const family = itemFamily(itemName);
  const candidates = new Map();
  for (const pos of positions) candidates.set(chestKey(pos), { position: pos, entry: known[chestKey(pos)] });
  for (const [key, entry] of Object.entries(known)) {
    if (candidates.has(key)) continue;
    const pos = new Vec3(entry.position.x, entry.position.y, entry.position.z);
    if (pos.distanceTo(point) <= CHEST_SEARCH_RADIUS) candidates.set(key, { position: pos, entry });
  }
  const tier = ({ entry }) => {
    const names = Object.keys(entry?.contents ?? {});
    const base = names.includes(itemName) ? 0
      : names.some((n) => itemFamily(n) === family) ? 1
      : names.length === 0 ? 2 : 3;
    return entry?.freeSlots === 0 ? base + 4 : base;
  };
  return [...candidates.values()]
    .map((c) => ({ ...c, tier: tier(c), dist: c.position.distanceTo(point) }))
    .sort((a, b) => a.tier - b.tier || a.dist - b.dist);
}

// One family's items split between two known chests near `point`: the move is from the chest
// holding less of it into the one holding more. `involving` limits it to splits that include
// that chest (the one just looked into). Null when nothing near is split.
export function findConsolidation(known, point, { involving } = {}) {
  const byFamily = new Map();
  for (const [key, entry] of Object.entries(known)) {
    const pos = new Vec3(entry.position.x, entry.position.y, entry.position.z);
    if (pos.distanceTo(point) > CHEST_SEARCH_RADIUS) continue;
    for (const [name, count] of Object.entries(entry.contents ?? {})) {
      const family = itemFamily(name);
      if (!byFamily.has(family)) byFamily.set(family, new Map());
      const chests = byFamily.get(family);
      if (!chests.has(key)) chests.set(key, { key, position: pos, freeSlots: entry.freeSlots, total: 0, items: {} });
      const holding = chests.get(key);
      holding.total += count;
      holding.items[name] = count;
    }
  }
  let best = null;
  for (const [family, chests] of byFamily) {
    if (chests.size < 2) continue;
    if (involving && !chests.has(involving)) continue;
    const ordered = [...chests.values()].sort((a, b) => b.total - a.total);
    const to = ordered[0];
    const from = ordered[ordered.length - 1];
    // A full chest takes nothing; what she carried would go straight back where it came from.
    if (to.freeSlots === 0) continue;
    if (!best || from.total > best.from.total) best = { family, from, to };
  }
  return best;
}

// Walk to a chest and open it: { chest }, { cancelled: true }, or { error }.
export async function openChestAt(bot, token, position) {
  await hopToward(bot, token, position);
  if (token.cancelled) return { cancelled: true };
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 2)),
      ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return { cancelled: true };
    noteUtilityOutcome("chest", position, false);
    return { error: err.message };
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return { cancelled: true };
  const block = bot.blockAt(position);
  if (!block || !["chest", "trapped_chest"].includes(block.name)) return { error: "there's no chest there now" };
  try {
    const chest = await bot.openChest(block);
    noteUtilityOutcome("chest", position, true);
    return { chest };
  } catch (err) {
    noteUtilityOutcome("chest", position, false);
    return { error: err.message };
  }
}

let consolidationHint = null;
export function consolidationPending() {
  return consolidationHint !== null;
}
export function takeConsolidationHint() {
  const plan = consolidationHint;
  consolidationHint = null;
  return plan;
}

// The read-side counterpart: a real, structured, position-precise lookup ("which known chest
// actually has enough of this item") rather than the fuzzy RAG search findRememberedLocation()
// already does for raw resource veins. Returns the NEAREST matching chest (not just the first
// found), since "closest known chest with the item" is a more useful answer than an arbitrary
// one once more than a handful of chests are tracked. Best-effort: a chest emptied by someone
// else since its last recorded snapshot simply won't be found again until its own next open
// re-snapshots it -- the same eventual-consistency tradeoff recordChestSnapshot's own comment
// already accepts.
export async function findKnownChestWithItem(bot, itemName, wantCount) {
  const known = await loadKnownChests();
  let best = null, bestDist = Infinity;
  for (const entry of Object.values(known)) {
    const have = entry.contents?.[itemName] || 0;
    if (have < 1) continue;
    const pos = new Vec3(entry.position.x, entry.position.y, entry.position.z);
    const dist = pos.distanceTo(bot.entity.position);
    if (dist < bestDist) {
      best = { position: pos, count: Math.min(have, wantCount) };
      bestDist = dist;
    }
  }
  return best;
}

// Real bug found live, 2026-10-27: builderPriorityCandidates()/builderPriorityItemSatisfied()
// (index.js) used to treat crafting_table/furnace/chest as "done" the moment one existed near
// home, by bare bot.findBlocks() existence -- never reachability or usability, and nothing ever
// re-checked it once satisfied. Two real chests sat there failing "No path to the goal!"/
// "windowOpen did not fire" for a full day while the checklist called chest storage done. This
// tracks REAL interaction outcomes (the catch sites smelt/craft/loot/store already have, not a
// new speculative reachability probe) so index.js's countUsableNearHome() can exclude a position
// once it's demonstrably broken. In-memory only, resets on restart -- same low-stakes tradeoff
// fleetHasIronTool/builderStallItem (index.js) already make for comparably short-lived fleet
// state; a restarted bot just re-discovers unusability through a few more real attempts, bounded
// by UTILITY_UNUSABLE_AFTER_FAILURES same as everything else that leans on real-world feedback
// here. Deliberately NOT persisted to a file: builderPriorityCandidates() must stay synchronous
// (called directly by proposeOwnGoal(), used as nextBuilderPriority()'s default parameter, and
// called synchronously by the existing unit test), so this can never become an async lookup.
const UTILITY_UNUSABLE_AFTER_FAILURES = 3; // mirrors BUILDER_ITEM_STALL_LIMIT's "don't thrash on noise"
const utilityStatus = new Map(); // "type,x,y,z" -> consecutive real-interaction failure count

function utilityKey(type, position) {
  return `${type},${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`;
}

export function noteUtilityOutcome(type, position, ok) {
  const key = utilityKey(type, position);
  if (ok) utilityStatus.delete(key);
  else utilityStatus.set(key, (utilityStatus.get(key) || 0) + 1);
}

export function isUtilityUsable(type, position) {
  return (utilityStatus.get(utilityKey(type, position)) || 0) < UTILITY_UNUSABLE_AFTER_FAILURES;
}
