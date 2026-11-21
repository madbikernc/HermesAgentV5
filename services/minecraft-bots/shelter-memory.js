// Version: 1.0.0
//
// 1.0.0 (2026-11-20) -- new file. Direct request: "shelter and bed locations should be stored in
// world memory." Same small-JSON-file-under-the-durable-mount pattern action-chests.js's own
// known_chests.json already uses (deliberately NOT the fuzzy RAG-based world-memory notes
// longterm.js's writeMemoryNote already writes for shelters/beds -- those are append-only,
// dedup-by-similarity free text, built for "is this roughly the same fact as one already noted,"
// not a structured, position-keyed, overwrite-on-write record). known_shelters.json, keyed by
// each qualifying room's door position: whether it currently has a bed and a chest, where it
// came from (the fleet's own "built" work, or a "found" structure -- a village house, say), and
// when that was last confirmed true.
//
// Its own file rather than folded into home-scan.js (which judges candidates) or shelter.js
// (which scans the live world): a position-keyed read-modify-write record is a different job
// from either, the same separation action-chests.js already drew from actions.js for chests.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const KNOWN_SHELTERS_FILE = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/known_shelters.json`;

function shelterKey(doorPosition) {
  return `${Math.round(doorPosition.x)},${Math.round(doorPosition.y)},${Math.round(doorPosition.z)}`;
}

export async function loadKnownShelters() {
  try {
    return JSON.parse(await readFile(KNOWN_SHELTERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveKnownShelters(data) {
  try {
    await mkdir(path.dirname(KNOWN_SHELTERS_FILE), { recursive: true });
    await writeFile(KNOWN_SHELTERS_FILE, JSON.stringify(data, null, 2), "utf8");
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
