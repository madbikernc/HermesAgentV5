// Version: 2.0.0
//
// 2.0.0 (2026-11-27): direct request, "make the world memory reachable from bots on both
// nodes" -- 1.0.0's local-file design never actually crossed hosts: /mnt/hermes-data is NOT a
// shared mount despite the identical path on every host (confirmed live: separate local LVM
// volumes on dgx-spark and dgx-spark2, different usage, same name by convention only). Rebuilt
// on hermes-memory (tools/hermes-memory.py) instead -- a fleet-wide key/value HTTP service
// already running as a singleton on dgx-spark (MEMORY_URL, default http://10.129.1.15:8102),
// already reachable and authenticated from BOTH hosts, and already wired into every bot process's
// environment (run-bot.sh exports MEMORY_URL/MEMORY_TOKEN for every bot, carried over unused from
// the old architecture -- no new secret, no new service, no new mount). One row per (name,
// position) pair under a single shared "minecraft-world-memory" agent, so a write to one object
// never clobbers another's (unlike 1.0.0's single-blob-per-call-site file, which needed a
// read-modify-write). No local fallback: a failed call is logged and the sighting is simply not
// recorded that one time, the same "fire and forget, never block the caller" contract 1.0.0 had.
//
// Direct request, 2026-11-27 ("verify that all discovered objects get an entry in the world
// memory"): world.getNearestBlocksWhere() -- the one chokepoint every block search in this
// project funnels through -- records every notable result here, fire-and-forget. Entities are
// deliberately NOT recorded: they move, so a remembered position goes stale immediately, unlike a
// chest, a furnace, or an ore vein.

const MEMORY_URL = process.env.MEMORY_URL || "http://10.129.1.15:8102";
const MEMORY_TOKEN = process.env.MEMORY_TOKEN || "";
const MEMORY_AGENT = "minecraft-world-memory";
const MEMORY_TIMEOUT_MS = 3000;

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

async function setState(key, value) {
  const res = await fetch(`${MEMORY_URL}/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MEMORY_TOKEN}` },
    body: JSON.stringify({ agent: MEMORY_AGENT, key, value }),
    signal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`hermes-memory POST /state -> ${res.status}`);
}

async function listState() {
  const res = await fetch(`${MEMORY_URL}/state/${MEMORY_AGENT}`, {
    headers: { Authorization: `Bearer ${MEMORY_TOKEN}` },
    signal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`hermes-memory GET /state/${MEMORY_AGENT} -> ${res.status}`);
  const body = await res.json();
  return body.state || [];
}

// Fire-and-forget by every caller: getNearestBlocksWhere() is synchronous (mineflayer-pathfinder
// and the whole skill library depend on that), so recording a sighting can never block into, or
// throw out of, the caller's own control flow.
export async function recordSightingIfNotable(name, position) {
  if (!isNotableDiscovery(name)) return;
  try {
    await setState(`${name}:${posKey(position)}`, {
      x: position.x, y: position.y, z: position.z, lastSeenAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("world-memory: failed to record a sighting:", err.message);
  }
}

export async function getKnownSightings(name) {
  try {
    const rows = await listState();
    return rows.filter((r) => r.key.startsWith(`${name}:`)).map((r) => r.value);
  } catch (err) {
    console.error("world-memory: failed to read known sightings:", err.message);
    return [];
  }
}

// For the "/closest <item>" chat command: the nearest known sighting of `name` to `fromPosition`,
// with its own distance attached, or null if nothing is known yet.
export async function findClosest(name, fromPosition) {
  const sightings = await getKnownSightings(name);
  let best = null;
  let bestDistance = Infinity;
  for (const s of sightings) {
    const distance = Math.hypot(s.x - fromPosition.x, s.y - fromPosition.y, s.z - fromPosition.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = s;
    }
  }
  return best ? { ...best, distance: bestDistance } : null;
}
