// Version: 1.0.0
//
// Direct request, 2026-11-27: "verify that all discovered objects get an entry in the world
// memory" -- a persistent, fleet-wide record of every notable static block a search has actually
// found. In the spirit of the archived fleet's known_chests.json (see
// services/minecraft-bots-archive-11-2026/action-chests.js's own header: "check that *all*
// discovered resources and structures are stored in world memory, available to both spark
// nodes"), rebuilt for the Mindcraft-ported architecture as a plain JSON file under
// MC_MEMORY_ROOT, written to directly -- the RAG/HTTP-proxy layer that made the old version
// reachable from spark2 (rag-backend.js) was deliberately not re-created (see index.js's own
// header); this file only covers hosts that share MC_MEMORY_ROOT's filesystem. Entities are
// deliberately NOT recorded: they move, so a remembered position goes stale immediately, unlike a
// chest, a furnace, or an ore vein.
//
// world.getNearestBlocksWhere() is the one chokepoint every block search in this project funnels
// through (getNearestBlocks()/getNearestBlock() call it; skills.js's own direct bot.findBlocks()
// calls were swept to go through it too, e.g. goToBed()) -- recordSightingIfNotable() is called
// there, once, so every discovered block gets an entry without each caller needing to remember to
// write one.

import fs from "fs/promises";
import path from "path";

// A function, not a module-scope const: MC_MEMORY_ROOT must be read fresh on every call, not
// baked in at import time -- tests/README.md's own documented pattern (live.test.mjs/
// live-bot.test.mjs set MC_MEMORY_ROOT to a temp directory so a test run never touches the
// fleet's real /mnt/hermes-data/minecraft-memory) only works if a later env var change is
// actually honoured, since the module may already be imported (directly or transitively, e.g.
// via world.js) before a test gets to set it.
export function discoveredObjectsPath() {
  const root = process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory";
  return path.join(root, "world", "discovered-objects.json");
}

// "Objects" worth remembering: interactable utility/storage structures, and ore/valuable blocks
// worth mining later. Deliberately excludes plain terrain (stone, dirt, air, ...) -- recording
// every block any broad search (e.g. "!nearbyBlocks", block_types=null) happens to pass over would
// turn this into a full world dump, not a registry of noteworthy finds.
const NOTABLE_BLOCK_NAMES = new Set([
  "chest", "trapped_chest", "ender_chest", "barrel",
  "furnace", "blast_furnace", "smoker",
  "crafting_table", "cartography_table", "fletching_table", "smithing_table",
  "stonecutter", "loom", "grindstone", "brewing_stand", "enchanting_table",
  "anvil", "lectern", "beacon", "respawn_anchor", "bell", "composter",
  "diamond_ore", "deepslate_diamond_ore", "ancient_debris",
  "emerald_ore", "deepslate_emerald_ore",
  "gold_ore", "deepslate_gold_ore",
  "iron_ore", "deepslate_iron_ore",
  "lapis_ore", "deepslate_lapis_ore",
  "redstone_ore", "deepslate_redstone_ore",
  "copper_ore", "deepslate_copper_ore",
  "coal_ore", "deepslate_coal_ore",
  "spawner",
]);
export function isNotableDiscovery(name) {
  return NOTABLE_BLOCK_NAMES.has(name) || name.endsWith("_bed");
}

function posKey(p) { return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`; }

async function readAll() {
  try { return JSON.parse(await fs.readFile(discoveredObjectsPath(), "utf8")); } catch { return {}; }
}

// Read-modify-write against one shared file -- the same low-contention tradeoff the archived
// fleet's own known_chests.json already accepted (a rare simultaneous write from two bots could
// lose one update; self-correcting on the next sighting, not worth real locking for).
async function writeAll(all) {
  const file = discoveredObjectsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(all, null, 2));
}

// Fire-and-forget by every caller: getNearestBlocksWhere() is synchronous (mineflayer-pathfinder
// and the whole skill library depend on that), so recording a sighting can never block into, or
// throw out of, the caller's own control flow. A failed write is logged and otherwise swallowed.
export async function recordSightingIfNotable(name, position) {
  if (!isNotableDiscovery(name)) return;
  try {
    const all = await readAll();
    all[name] = all[name] || {};
    all[name][posKey(position)] = { x: position.x, y: position.y, z: position.z, lastSeenAt: new Date().toISOString() };
    await writeAll(all);
  } catch (err) {
    console.error("world-memory: failed to record a sighting:", err.message);
  }
}

export async function getKnownSightings(name) {
  const all = await readAll();
  return Object.values(all[name] || {});
}
