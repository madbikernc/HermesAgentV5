// Version: 1.1.0
//
// 1.0.0 (2026-11-20) -- new file. Direct request: "shelter and bed locations should be stored in
// world memory." Same small-JSON-file pattern action-chests.js's own known_chests.json already
// uses (deliberately NOT the fuzzy RAG-based world-memory notes longterm.js's writeMemoryNote
// already writes for shelters/beds -- those are append-only, dedup-by-similarity free text,
// built for "is this roughly the same fact as one already noted," not a structured,
// position-keyed, overwrite-on-write record). known_shelters.json, keyed by each qualifying
// room's door position: whether it currently has a bed and a chest, where it came from (the
// fleet's own "built" work, or a "found" structure -- a village house, say), and when that was
// last confirmed true.
//
// 1.1.0 (2026-11-22, direct report: "check that *all* discovered resources and structures are
// stored in world memory, available to both spark nodes"): moved from its own per-host file
// under MC_MEMORY_ROOT to world/known_shelters.json, read/written through rag-backend.js's own
// memRead/memWrite -- the SAME proxy every "found X near (Y)" note already uses, making this
// fleet-wide (spark2's bots already read/write spark's copy of everything under world/ over
// HTTP) instead of a second, independent per-host store. See action-chests.js 1.2.0's own header
// for the full account, including why a ".json" path under world/ is safe (already in the
// remote server's path whitelist, never swept into the embedded corpus, which only globs "*.md"
// there).
//
// Its own file rather than folded into home-scan.js (which judges candidates) or shelter.js
// (which scans the live world): a position-keyed read-modify-write record is a different job
// from either, the same separation action-chests.js already drew from actions.js for chests.

import { memRead, memWrite } from "./rag-backend.js";

const KNOWN_SHELTERS_PATH = "world/known_shelters.json";

function shelterKey(doorPosition) {
  return `${Math.round(doorPosition.x)},${Math.round(doorPosition.y)},${Math.round(doorPosition.z)}`;
}

export async function loadKnownShelters() {
  try {
    return JSON.parse(await memRead(KNOWN_SHELTERS_PATH));
  } catch {
    return {};
  }
}

async function saveKnownShelters(data) {
  try {
    await memWrite(KNOWN_SHELTERS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("known_shelters: failed to persist:", err.message);
  }
}

// Upserts one shelter's record by its door position. `updates` only needs to carry what the
// caller actually just confirmed (a bed just went in, a chest just went in, a shell just went
// up) -- any field left out keeps its previous value (false/"built" the first time this door is
// ever seen), the same low-contention read-modify-write tolerance known_chests.json's own
// recordChestSnapshot() already accepts for a rare simultaneous write from two bots.
export async function recordKnownShelter(doorPosition, updates = {}) {
  const known = await loadKnownShelters();
  const key = shelterKey(doorPosition);
  const existing = known[key] ?? {};
  known[key] = {
    door: { x: doorPosition.x, y: doorPosition.y, z: doorPosition.z },
    hasBed: updates.hasBed ?? existing.hasBed ?? false,
    hasChest: updates.hasChest ?? existing.hasChest ?? false,
    source: updates.source ?? existing.source ?? "built",
    lastSeenAt: new Date().toISOString(),
  };
  await saveKnownShelters(known);
}
