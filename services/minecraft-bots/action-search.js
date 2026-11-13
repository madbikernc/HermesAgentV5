// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of actions.js (2.0.0) unchanged: exploring, search radii, remembered spots, hopping toward a target, wander-and-retry.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. actions.js imports
// it; this file reads actions.js's state through live imports, so nothing here may touch it
// before actions.js has run (only declarations live here).

import { Vec3 } from "vec3";
import { searchMemory } from "./longterm.js";
import { withTimeout } from "./action-movement.js";
import { goals } from "./action-vocab.js";


// Direct request, 2026-09-07 ("what other logic enhancements are available" -> "explore/
// wander"): the single biggest recurring blocker across a whole night's live testing was
// "couldn't find X nearby" (wood, ore, chests) purely because nothing existed within the normal
// maxDistance of wherever the bot happened to be standing -- with no way to deliberately look
// further. Deliberately bounded, not open-ended exploration: a wander-then-retry per failed
// search, a fixed modest distance, not a search loop. This runs the same kind of long-distance
// pathfinding linked to tonight's cave-pathfinding OOM crashes, so it stays conservative
// (EXPLORE_DISTANCE well under a chunk-loading concern, a real timeout on the wander itself)
// rather than searching further and further outward.
//
// 2026-09-08 ("the bots just stand around most of the time"): real, confirmed root cause of a
// live report, not guessed -- direct on-server check found ZERO logs within 100 blocks of
// spawn, so the original single-hop version of this function (and this fix's own first two live-
// tested attempts: one long hop in a random direction, then several random-direction hops) had
// no reliable way to reach wood at all -- confirmed live that pure random-direction wandering
// missed a real tree cluster sitting ~83 blocks away in one specific direction, repeatedly,
// since nothing steered it that way. Every wood-gathering goal step failing instantly, over and
// over, is what "standing around" actually looked like in the logs: goal after goal giving up
// within 1-2 ticks because the very first, most basic resource was never reachable.
//
// The actual fix: this server's own view-distance (confirmed live: view-distance=10, 160
// blocks) means mineflayer already has chunk data for anything within ~160 blocks, whether or
// not she could path there directly -- bot.findBlocks() with a large maxDistance is a real,
// free, stationary lookup (no movement, no pathfinder search at all), it was only ever "mine"'s
// own SEARCH radius (32) that was narrow, not what the client could actually see. So rather than
// guessing a wander direction, EXTENDED_SEARCH_DISTANCE first checks if anything exists further
// out than the normal search, and if so, wanders TOWARD ITS REAL KNOWN BEARING in bounded hops
// (each still EXPLORE_DISTANCE, safely under bot.pathfinder.searchRadius's own 48-block OOM-
// safety cap from tonight's investigation) instead of a blind guess -- re-checking the ORIGINAL
// (narrow, cheap) findOptions after every hop, since the real goal is always "close enough for
// the normal search radius to find it now," not the extended one.
const EXPLORE_DISTANCE = 40;
const EXPLORE_TIMEOUT_MS = 15_000;
// Direct request, 2026-09-19 ("expand their search capabilities further, especially the miner and
// explorer roles"): env-tunable per-bot, same pattern as MC_SELF_DEFENSE_RANGE (§21) -- lets
// Babs/Wade's own systemd units search farther than the shared 32-block default without touching
// every other bot. EXTENDED_SEARCH_DISTANCE (the wanderAndRetryFind "beacon" scan) is safe to raise
// freely -- the actual walk there is already hop-capped at EXPLORE_DISTANCE regardless of how far
// the beacon itself is (see wanderAndRetryFind's own step = Math.min(EXPLORE_DISTANCE, dist)
// below). MINE_SEARCH_RADIUS/EXPLORE_SEARCH_RADIUS are a different risk: a found block up to that
// many blocks away gets ONE unhopped bot.collectBlock.collect() pathfind straight to it, not a
// hop-capped walk -- kept well under bot.pathfinder.searchRadius's own 48-block OOM ceiling (this
// file's own established caution, see EXPLORE_DISTANCE's header above) even when raised.
export const MINE_SEARCH_RADIUS = parseInt(process.env.MC_MINE_SEARCH_RADIUS || "32", 10);
export const EXPLORE_SEARCH_RADIUS = parseInt(process.env.MC_EXPLORE_SEARCH_RADIUS || "32", 10);
// Review MB-16: blocks that only (or overwhelmingly) occur at a given feature -- what EXPLORE
// <feature> scouts for. Keys are the feature words the planner/classifier may pass.
export const SCOUT_FEATURE_BLOCKS = {
  village: ["bell", "composter", "lectern", "fletching_table", "cartography_table", "smithing_table"],
  bee_nest: ["bee_nest"],
  mineshaft: ["rail", "cobweb"],
  stronghold: ["end_portal_frame", "infested_stone_bricks", "cracked_stone_bricks"],
};
const EXTENDED_SEARCH_DISTANCE = parseInt(process.env.MC_EXTENDED_SEARCH_DISTANCE || "150", 10);
const MAX_DIRECTED_HOPS = 4;

// Hoisted to module scope (was a local const inside "explore" alone) and exported, 2026-09-11
// (direct request: "ask the other bots to look near themselves... they add/update their
// knowledge of nearby resources into global world memory") -- index.js's new noteNearbyResources()
// scans this SAME curated "common raw materials" list so a scout request and an ordinary explore
// success note stay in exactly one vocabulary; one bot's "mine" query can match another bot's
// incidental discovery either way, not two independently-drifting lists.
//
// Real gap found live 2026-09-13 (direct request: "extend resource sharing memory and scouting
// to *any* resource or crafted object"). A hand-maintained 4-item list meant gold/diamond/
// redstone/lapis/every other log species/every other ore got ZERO benefit from any of this --
// rediscovered from scratch by every bot, every time. Derived programmatically from this
// server's own real block registry instead of hand-maintained: every block whose name ends in
// "_ore" or "_log"/"_stem" (every wood species this server actually has, not a guessed list),
// plus ancient_debris (the one real valuable resource that matches neither suffix). Memoized --
// the registry is fixed once a bot has spawned, no reason to recompute this every call.
let resourceBlockNamesCache = null;
export function getResourceBlockNames(bot) {
  if (resourceBlockNamesCache) return resourceBlockNamesCache;
  resourceBlockNamesCache = bot.registry.blocksArray
    .map((b) => b.name)
    .filter((name) => name.endsWith("_ore") || name.endsWith("_log") || name.endsWith("_stem") ||
      name === "ancient_debris");
  return resourceBlockNamesCache;
}

// Direct request, 2026-09-11 ("if one bot is looking for a specific resource... each bot uses the
// global world memory to gather a resource it needs, if it's not in their immediate vicinity").
// Memory notes have no structured position field (longterm.js's own writeMemoryNote just stores
// free text) -- every existing position-bearing note already uses the one real format,
// "near (x, y, z)" (explore's own success note, index.js's goalTick), so parsing that back out
// reuses an existing convention rather than inventing a new structured schema.
const MEMORY_POSITION_PATTERN = /near \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/;

// Direct report, 2026-10-28 ("why do they keep returning to 24/67/-88?"): every night Babs and
// Dale walked to a remembered bed at (23, 68, -95) that no longer existed -- 97 failed sleeps in
// 10 hours -- while a real, noted bed at (-6, 64, -56) sat unused. Two gaps: the FIRST semantic
// hit won (search rank, not distance), and a spot found empty on arrival was never forgotten, so
// the same dead note won again on the next try. Now the nearest live hit wins, and
// visitRememberedSpot() below marks a spot stale once she's been there and still found nothing.
// In-memory per bot (a restart re-checks each spot once) -- the RAG corpus has no delete.
const staleRememberedSpots = new Set();
const rememberedSpotKey = (resourceName, pos) => `${resourceName}@${pos.x},${pos.y},${pos.z}`;

export async function findRememberedLocation(resourceName, from = null) {
  const hits = await searchMemory(`${resourceName} location nearby`, { topK: 10 });
  const spots = [];
  for (const hit of hits) {
    // searchMemory is semantic/fuzzy -- a hit about an unrelated resource can still score close
    // enough to come back, so a real substring check on the resource name is worth keeping on
    // top of whatever ranking the search itself already did.
    if (!hit.text || !hit.text.toLowerCase().includes(resourceName.toLowerCase())) continue;
    const match = hit.text.match(MEMORY_POSITION_PATTERN);
    if (!match) continue;
    const pos = new Vec3(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!staleRememberedSpots.has(rememberedSpotKey(resourceName, pos))) spots.push(pos);
  }
  if (from) spots.sort((a, b) => a.distanceTo(from) - b.distanceTo(from));
  return spots[0] ?? null;
}

// The local-scan-empty fallback every caller shares: walk to the nearest remembered spot, rescan
// from there, and forget the spot if the rescan still comes up empty.
export async function visitRememberedSpot(bot, token, resourceName, rescan) {
  const remembered = await findRememberedLocation(resourceName, bot.entity.position).catch(() => null);
  if (!remembered) return [];
  await gotoRememberedSpot(bot, token, remembered);
  const found = rescan();
  if (!found.length && !token.cancelled) {
    staleRememberedSpots.add(rememberedSpotKey(resourceName, remembered));
    console.log(`[${bot.username}] remembered ${resourceName} at ${remembered} isn't there any more -- forgetting it.`);
  }
  return found;
}

// One bounded hop toward a remembered position, same shape as wanderAndRetryFind's own per-hop
// goto (EXPLORE_TIMEOUT_MS, cancel-on-token, best-effort if she can't fully reach it) -- worth
// checking from wherever she actually ends up even on a partial path, same reasoning as that
// function's own catch block.
// Direct request, 2026-11-07: "expand the range of 'nearby chests' from 32 to 128 -- you keep using
// 32 as 'nearby' and keep learning that it's too small a range." Every chest search (loot, the
// chest-first fallback for mine/craft, store, consolidation) looks this far.
export const CHEST_SEARCH_RADIUS = 128;

// A chest up to CHEST_SEARCH_RADIUS away is walked to in EXPLORE_DISTANCE hops, the way
// wanderAndRetryFind walks toward its beacon, before the final short GoalNear to it.
export async function hopToward(bot, token, pos) {
  for (let hop = 0; hop < MAX_DIRECTED_HOPS && !token.cancelled; hop++) {
    const here = bot.entity.position;
    const dx = pos.x - here.x, dz = pos.z - here.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= EXPLORE_DISTANCE) return;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(here.x + (dx / dist) * EXPLORE_DISTANCE,
        here.z + (dz / dist) * EXPLORE_DISTANCE, 4)), EXPLORE_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      // short of this hop's point -- the next hop (or the final GoalNear) starts from wherever she got to
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
  }
}

async function gotoRememberedSpot(bot, token, pos) {
  if (token.cancelled) return;
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 4)),
      EXPLORE_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch {
    // Couldn't fully reach it (stale note, terrain changed, whatever) -- still worth a local
    // findBlocks from wherever she ended up rather than giving up on the memory hit entirely.
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
}

export async function wanderAndRetryFind(bot, token, findOptions) {
  if (token.cancelled) return [];
  // Callers only reach here after their own initial findBlocks(findOptions) already came up
  // empty -- no need to repeat that exact same scan.
  let positions;
  const farPositions = bot.findBlocks({ ...findOptions, maxDistance: EXTENDED_SEARCH_DISTANCE, count: 1 });
  if (!farPositions.length) return []; // genuinely nothing visible at all, not just unreachable yet

  const beacon = farPositions[0];
  for (let hop = 0; hop < MAX_DIRECTED_HOPS; hop++) {
    if (token.cancelled) return [];
    const pos = bot.entity.position;
    const dx = beacon.x - pos.x, dz = beacon.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1) break; // already there
    const step = Math.min(EXPLORE_DISTANCE, dist);
    const target = pos.offset((dx / dist) * step, 0, (dz / dist) * step);
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 4)),
        EXPLORE_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      // Couldn't fully reach this hop's point (cliff, water, whatever's out there) -- still worth
      // checking from wherever she actually ended up rather than giving up on the whole approach.
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return [];
    positions = bot.findBlocks(findOptions);
    if (positions.length) return positions;
  }
  return [];
}

// Real bug found live 2026-10-10 (direct report: bots "give up on constructed goals without
// seeming to attempt to get the raw materials they lack"): "get_wool"'s own sheep search only
// ever checked bot.entities within 32 blocks of wherever she happened to already be standing --
// an instant, un-wandering check, unlike "mine"/"explore"'s own wanderAndRetryFind(). Confirmed
// live: Mayor's bed goal failed 3 times in a row, ~45s apart, with an identical "no sheep nearby"
// and ms=0 each time -- she never moved an inch to go actually look for one, just re-checked the
// same empty radius until the goal gave up entirely. wanderAndRetryFind() itself is block-search-
// specific (bot.findBlocks, a far-off "beacon" to hop toward) and has no equivalent for a live,
// moving ENTITY that isn't rendered/tracked at all until she's already near it -- there's no
// "scan a wider radius" to beacon off, only "walk somewhere new and look again." A few random
// short hops, same distance/timeout "explore" already uses to look around, before genuinely
// giving up.
export async function wanderAndRetryForSheep(bot, token) {
  const nearestSheep = () => Object.values(bot.entities)
    .filter((e) => e.name === "sheep" && e.position.distanceTo(bot.entity.position) <= 32)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  for (let hop = 0; hop < MAX_DIRECTED_HOPS && !token.cancelled; hop++) {
    const angle = Math.random() * 2 * Math.PI;
    const pos = bot.entity.position;
    const target = pos.offset(Math.cos(angle) * EXPLORE_DISTANCE, 0, Math.sin(angle) * EXPLORE_DISTANCE);
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 4)),
        EXPLORE_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      // Couldn't fully reach this hop's point -- still worth checking from wherever she ended up.
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return null;
    const sheep = nearestSheep();
    if (sheep) return sheep;
  }
  return null;
}
