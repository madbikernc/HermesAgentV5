// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of actions.js (2.0.0) unchanged: other bots' positions, mine drops, buildings, planting, pens and herds, seeds, achievements, farm plots, wool and bed sites.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. actions.js imports
// it; this file reads actions.js's state through live imports, so nothing here may touch it
// before actions.js has run (only declarations live here).

import { Vec3 } from "vec3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { posKey, shelterInteriorsNear } from "./shelter.js";
import { isClearableCover } from "./action-movement.js";
import { isProtectedBlockName } from "./action-vocab.js";


// Direct follow-up to "what other autonomous behaviors are solvable" -> "fix all the above":
// cross-bot resource contention. arbitrateGoalConflict() (index.js) already judges conflict at
// GOAL-SELECTION time from goal *text* -- real, but blind to the case that actually matters here:
// two bots with differently-worded, individually-non-conflicting goals ("get some iron" /
// "smelt myself a chestplate") converging on the exact same ore vein simply because that's where
// the ore happens to be, discovered only once both are already standing on top of each other. No
// amount of language-level judgment catches that -- it's a physical fact about the world, not a
// disagreement about intent. This is purely spatial and runs at mining time, not goal time:
// other known bots are ordinary named players from this bot's own point of view (bot.players),
// so their live position is already free, real data -- no Buzz coordination message needed for
// something this bot can just see. Independent small env-derived roster, same pattern
// index.js's own BOT_USERNAMES already uses -- actions.js stays a leaf module with no import from
// index.js (this file's own header: "index.js does the mutating," never the reverse).
// "Bob" added 2026-09-11, "Nell,Wade,Dale" added 2026-09-13 (§22 rebalance) -- both times kept in
// sync with index.js's own BOT_USERNAMES default since this really is an independent duplicate
// of that same roster, not a second source of truth.
const OTHER_BOT_USERNAMES = new Set(
  (process.env.MC_BOT_USERNAMES || "Babs,Amy,Mark,Luke,Mayor,Bob,Nell,Wade,Dale").split(",").map((s) => s.trim()).filter(Boolean),
);
const BOT_PROXIMITY_AVOID_DISTANCE = 6;
// How many extra candidates to fetch beyond what's actually needed, so filtering out ones too
// close to another bot still leaves enough real candidates -- findBlocks' own `count` caps
// results BEFORE this filter can run, so asking for only the bare minimum up front would silently
// defeat this the moment the nearest few happen to be the contested ones.
export const CONTENTION_SEARCH_OVERFETCH = 3;

export function filterAwayFromOtherBots(bot, positions) {
  const otherPositions = [...OTHER_BOT_USERNAMES]
    .filter((name) => name !== bot.username)
    .map((name) => bot.players[name]?.entity?.position)
    .filter(Boolean);
  if (!otherPositions.length) return positions; // no other bot even visible -- nothing to avoid
  const clear = positions.filter((pos) =>
    otherPositions.every((otherPos) => pos.distanceTo(otherPos) > BOT_PROXIMITY_AVOID_DISTANCE));
  // Avoiding crowding is a courtesy, not a hard requirement -- if EVERY candidate is contested
  // (e.g. a single small vein with a bot already parked on it), mining the contested one still
  // beats finding nothing at all.
  return clear.length ? clear : positions;
}

// What item actually lands in her inventory when she MINES this block, for the unenchanted
// (non-Silk-Touch) case this codebase always uses -- real vanilla drop behavior, not the
// block's own name. Most ores drop a raw/processed item, not a copy of themselves (confirmed
// against real game rules: coal_ore drops "coal", iron/copper/gold ore drop "raw_x", diamond/
// emerald/redstone/lapis ore drop the gem/dust item directly). Logs are the one common case
// that genuinely doesn't need an entry -- an oak_log block drops an oak_log item, same name.
// Small and deliberately curated, same pragmatic scope as SMELT_RECIPES/FUEL_PREFERENCE above,
// not an attempt at exhaustive coverage of every block in the game.
export const MINE_DROPS = {
  coal_ore: "coal", deepslate_coal_ore: "coal",
  iron_ore: "raw_iron", deepslate_iron_ore: "raw_iron",
  copper_ore: "raw_copper", deepslate_copper_ore: "raw_copper",
  gold_ore: "raw_gold", deepslate_gold_ore: "raw_gold", nether_gold_ore: "gold_nugget",
  diamond_ore: "diamond", deepslate_diamond_ore: "diamond",
  emerald_ore: "emerald", deepslate_emerald_ore: "emerald",
  redstone_ore: "redstone", deepslate_redstone_ore: "redstone",
  lapis_ore: "lapis_lazuli", deepslate_lapis_ore: "lapis_lazuli",
};

// Maps a resolved family of block ids (resolveBlockFamily's own output -- e.g. every log
// species, or both the stone- and deepslate-layer variant of one ore) to the real item name(s)
// that would already satisfy the same need if sitting in a chest, deduplicated since a whole ore
// family usually collapses to one drop item.
export function itemNamesForMinedBlocks(bot, blockIds) {
  const names = blockIds.map((id) => {
    const blockName = bot.registry.blocks[id]?.name;
    return blockName ? (MINE_DROPS[blockName] || blockName) : null;
  }).filter(Boolean);
  return [...new Set(names)];
}

// Real incident found live (2026-09-07): Amy's bed sat right at the edge of open water, so every
// death near it turned "recover" into a repeated drowning loop -- the bed itself was never the
// bug, but sleeping in one next to a hazard is what put her in harm's way in the first place.
// Vanilla doesn't stop a player from using a bed next to water/lava, so this is a check nothing
// upstream enforces. Scans a generous box around the bed rather than just the block it's on,
// since the actual sleeping/wake-up position can land a block or two off the bed block itself.
export function bedNearHazard(bot, bedPos) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const block = bot.blockAt(bedPos.offset(dx, dy, dz));
        if (block?.name === "water" || block?.name === "lava") return true;
      }
    }
  }
  return false;
}

// Direct request, 2026-09-09 ("when they find saplings, they should plant them... in any free
// soil not directly adjacent to a building if they can't [find same-variety trees]"). "A
// building" has no real in-game flag to check -- this is a practical heuristic, not an exact
// detector: any functional/crafted block (isProtectedBlockName() -- a chest, furnace, bed, etc.
// sitting there is a very strong building signal) or a common hand-placed construction material
// (planks/cobblestone/stone-family/glass/doors -- exactly the kind of block "build"'s own
// material selection would have used) nearby counts as "a building." A false positive here just
// means one more otherwise-fine spot gets skipped in favor of another -- cheap, since real
// forests rarely run short of open ground.
const BUILDING_MATERIAL_NAMES = ["cobblestone", "mossy_cobblestone", "stone", "smooth_stone",
  "stone_bricks", "mossy_stone_bricks", "cracked_stone_bricks", "bricks", "glass", "glass_pane"];
const BUILDING_MATERIAL_SUFFIXES = ["_planks", "_door", "_trapdoor", "_stairs", "_slab", "_fence",
  "_fence_gate", "_stained_glass", "_stained_glass_pane"];

function looksLikeBuilding(block) {
  if (!block) return false;
  if (isProtectedBlockName(block.name)) return true;
  if (BUILDING_MATERIAL_NAMES.includes(block.name)) return true;
  return BUILDING_MATERIAL_SUFFIXES.some((suffix) => block.name.endsWith(suffix));
}

// radius=6, direct request 2026-09-09 ("'near a building' is defined as 6 blocks") -- was 3
// (a guess) until specified exactly.
export function nearBuilding(bot, pos, radius = 6) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (looksLikeBuilding(bot.blockAt(pos.offset(dx, dy, dz)))) return true;
      }
    }
  }
  return false;
}

// Rule 1 of sapling planting: near other trees of the same variety, if any are reachable.
// `center` is some log block belonging to that tree (findBlocks' own match, not necessarily the
// trunk's base) -- real trunks are several blocks tall, so this scans a small vertical band
// around center's own Y, not just center's exact level, to find the actual ground surface.
// Skips the immediate trunk area (radius < 2) so the sapling doesn't get crammed right against
// the tree it's supposed to be planted "near," not "inside."
export function findPlantableSpotNear(bot, center, radius) {
  const groundIds = [bot.registry.blocksByName.grass_block?.id, bot.registry.blocksByName.dirt?.id]
    .filter((id) => id !== undefined);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
      for (let dy = 2; dy >= -2; dy--) {
        const pos = center.offset(dx, dy, dz);
        const ground = bot.blockAt(pos);
        if (!ground || !groundIds.includes(ground.type)) continue;
        // Real "air", not just non-solid -- a pre-existing sapling/tall-grass/flower isn't
        // "block" either, and planting into one is a real placement failure (found live,
        // 2026-09-09: "Server refused to place dark_oak_sapling ... the block is still
        // dark_oak_sapling").
        if (bot.blockAt(pos.offset(0, 1, 0))?.name !== "air") continue;
        return pos;
      }
    }
  }
  return null;
}

// Hoisted to module scope 2026-09-11 (direct request "fix the pen herding") so both "breed" and
// the new "herd_to_pen" case below can share one definition -- it used to live only inside
// "breed"'s own case block, which meant the herding verb would otherwise need a second,
// independently-drifting copy of which food tempts which species.
// 2026-11-06: 32 blocks found no chicken near Dale's new pen 20 times running; the animals that
// made pickRanchSpecies() choose chickens were up to 48 from the pen.
export const HERD_SEARCH_RADIUS = 64;

export const BREEDING_FOOD = {
  cow: ["wheat"], sheep: ["wheat"], pig: ["carrot", "potato", "beetroot"],
  chicken: ["wheat_seeds", "pumpkin_seeds", "melon_seeds", "beetroot_seeds"],
  // Added 2026-09-11 ("bee nests/hives") -- real vanilla bees breed on any flower, not one
  // specific item, so this lists every common flower id rather than picking a single canonical
  // one the way cow/sheep/pig/chicken each have.
  bee: ["poppy", "dandelion", "blue_orchid", "allium", "azure_bluet", "red_tulip",
        "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy", "cornflower",
        "lily_of_the_valley", "sunflower", "lilac", "rose_bush", "peony"],
};

// Direct request, 2026-09-11 ("fix the pen herding"): a pen built by "build_pen" needs to be
// FOUND again later by "herd_to_pen" -- one small shared file, same durable-mount pattern
// loadClaimedBed/saveClaimedBed just below already uses. Deliberately ONE shared pen, not
// per-bot: unlike a bed (personal, claimed), a pen is fleet infrastructure -- the same "shared,
// not per-bot" reasoning MINECRAFT_BOTS_DESIGN.md §15.6 already gives for the crafting
// table/furnace/chest.
const PEN_FILE = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/pen.json`;

export async function loadPenLocation() {
  try {
    const data = JSON.parse(await readFile(PEN_FILE, "utf8"));
    return { center: new Vec3(data.center.x, data.center.y, data.center.z), gate: new Vec3(data.gate.x, data.gate.y, data.gate.z) };
  } catch {
    return null; // no pen built yet, or the file's gone/corrupt
  }
}

export async function savePenLocation(center, gate) {
  try {
    await mkdir(path.dirname(PEN_FILE), { recursive: true });
    await writeFile(PEN_FILE, JSON.stringify({
      center: { x: center.x, y: center.y, z: center.z },
      gate: { x: gate.x, y: gate.y, z: gate.z },
    }), "utf8");
  } catch (err) {
    console.error("build_pen: failed to persist pen location:", err.message);
  }
}

// 2026-09-25 farming/ranching. loot's item can name a group: "food" (a hungry bot with nothing to eat
// fetches some -- index.js checkHunger) or "seeds" (anything harvest can plant).
export const SEED_NAMES = ["wheat_seeds", "carrot", "potato", "beetroot_seeds"];
// What "gather_seeds" breaks: each drops wheat seeds about one time in eight.
export const SEED_GRASS = ["short_grass", "grass", "tall_grass", "fern", "large_fern"];
export const GATHER_SEEDS_MAX_DIGS = 64;

// Verified achievements -- recorded by the action that actually did the thing (harvest picked a ripe
// crop, herd_to_pen got an animal into the pen, breed saw a baby appear), never by a planner's claim.
// Mayor's curriculum counts these instead of "holding a crop", which looting satisfied. One small
// per-bot file so a restart keeps them; bot.emit("achievement") lets index.js report a new one.
const ACHIEVEMENTS_DIR = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/achievements`;
const achievementsByBot = new Map();

export async function loadAchievements(bot) {
  if (!achievementsByBot.has(bot.username)) {
    let names = [];
    try {
      names = JSON.parse(await readFile(path.join(ACHIEVEMENTS_DIR, `${bot.username}.json`), "utf8"));
    } catch {}
    if (!achievementsByBot.has(bot.username)) achievementsByBot.set(bot.username, new Set(Array.isArray(names) ? names : []));
  }
  return achievementsByBot.get(bot.username);
}

export function getAchievements(bot) {
  return achievementsByBot.get(bot.username) ?? new Set();
}

export async function recordAchievement(bot, name) {
  const set = await loadAchievements(bot);
  if (set.has(name)) return false;
  set.add(name);
  try {
    await mkdir(ACHIEVEMENTS_DIR, { recursive: true });
    await writeFile(path.join(ACHIEVEMENTS_DIR, `${bot.username}.json`), JSON.stringify([...set]), "utf8");
  } catch (err) {
    console.error("achievements: failed to persist:", err.message);
  }
  console.log(`[${bot.username}] achievement: ${name}`);
  bot.emit("achievement", name);
  return true;
}

export const LIVESTOCK = ["cow", "sheep", "pig", "chicken"];

// Animals of one kind standing inside the pen (its 5x5 interior).
export function countInPen(bot, pen, species) {
  return Object.values(bot.entities).filter((e) => e.name === species &&
    Math.abs(e.position.x - (pen.center.x + 0.5)) < 2.6 && Math.abs(e.position.z - (pen.center.z + 0.5)) < 2.6 &&
    Math.abs(e.position.y - pen.center.y) < 2).length;
}

// A flat, open 7x7 spot 8-20 blocks from home for build_pen (which builds around its site): same
// floor height across all 49 columns, two blocks of air above each. Building around the bot where
// she stood at home would fence the fleet into its own shelter.
export function findPenSite(bot, home) {
  const hx = Math.floor(home.x), hy = Math.floor(home.y), hz = Math.floor(home.z);
  const feet = new Map(); // "x,z" -> feet y of an open column with solid ground, or null
  const feetAt = (x, z) => {
    const key = `${x},${z}`;
    if (feet.has(key)) return feet.get(key);
    let found = null;
    for (let y = hy + 3; y >= hy - 3 && found === null; y--) {
      const ground = bot.blockAt(new Vec3(x, y - 1, z));
      const a = bot.blockAt(new Vec3(x, y, z)), b = bot.blockAt(new Vec3(x, y + 1, z));
      if (ground?.boundingBox === "block" && a?.name === "air" && b?.name === "air") found = y;
    }
    feet.set(key, found);
    return found;
  };
  let best = null, bestDist = Infinity;
  for (let dx = -20; dx <= 20; dx++) {
    for (let dz = -20; dz <= 20; dz++) {
      const dist = Math.hypot(dx, dz);
      if (dist < 8 || dist > 20 || dist >= bestDist) continue;
      const y = feetAt(hx + dx, hz + dz);
      if (y === null) continue;
      let flat = true;
      for (let ox = -3; ox <= 3 && flat; ox++) {
        for (let oz = -3; oz <= 3 && flat; oz++) flat = feetAt(hx + dx + ox, hz + dz + oz) === y;
      }
      if (flat) { best = new Vec3(hx + dx, y, hz + dz); bestDist = dist; }
    }
  }
  return best;
}

// Farm plots (harvest). Farmland is hydrated by water within 4 blocks at its own level, so the plot
// goes around the water with the most tillable ground beside it; with no water, the tillable blocks
// closest together near the bot. Tilling needs nothing on top, so small plants get cleared first.
const FARM_PLOT_SIZE = 8;
const TILLABLE = new Set(["dirt", "grass_block", "dirt_path", "rooted_dirt"]);
const CLEAR_ABOVE = new Set(["short_grass", "grass", "tall_grass", "fern", "large_fern", "dead_bush",
  ...BREEDING_FOOD.bee]);
export function tillableAt(bot, pos) {
  const ground = bot.blockAt(pos), above = bot.blockAt(pos.offset(0, 1, 0));
  return !!ground && TILLABLE.has(ground.name) && !!above && (above.name === "air" || CLEAR_ABOVE.has(above.name));
}

export function chooseFarmPlot(bot, near) {
  const origin = near || bot.entity.position;
  const waterId = bot.registry.blocksByName.water?.id;
  const waters = waterId === undefined ? [] : bot.findBlocks({ matching: waterId, maxDistance: 32, count: 60, point: origin });
  let best = null;
  for (const w of waters) {
    const around = [];
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const pos = w.offset(dx, 0, dz);
        if ((dx || dz) && tillableAt(bot, pos)) around.push(pos);
      }
    }
    if (around.length < 4) continue;
    if (!best || around.length > best.plot.length ||
        (around.length === best.plot.length && w.distanceTo(origin) < best.water.distanceTo(origin))) {
      best = { water: w, plot: around };
    }
  }
  if (best) {
    const plot = best.plot.sort((a, b) => a.distanceTo(best.water) - b.distanceTo(best.water)).slice(0, FARM_PLOT_SIZE);
    return { plot, hydrated: true, center: best.water };
  }
  const soil = bot.findBlocks({ matching: (b) => TILLABLE.has(b.name), maxDistance: 32, count: 200, point: origin })
    .filter((pos) => tillableAt(bot, pos));
  if (!soil.length) return null;
  const first = soil[0];
  const plot = soil.filter((pos) => pos.distanceTo(first) <= 3).slice(0, FARM_PLOT_SIZE);
  return { plot, hydrated: false, center: first };
}

// Beds (2026-09-26, "I don't think the bots know how to build a bed"): after the world reset every
// bot failed "sleep" all night and every "craft bed" failed with "I don't recognize the item bed".
// A bed only exists as a colour (white_bed, ...), crafted from 3 wool of that colour + 3 planks.
export function woolCounts(bot) {
  const counts = {};
  for (const item of bot.inventory.items()) {
    if (item.name.endsWith("_wool")) counts[item.name.slice(0, -5)] = (counts[item.name.slice(0, -5)] || 0) + item.count;
  }
  return counts;
}

// The bed she can make from the wool she holds (3 of one colour); white when she has none yet.
export function bedItemFor(bot) {
  const [color] = Object.entries(woolCounts(bot)).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0] ?? ["white"];
  return `${color}_bed`;
}

// A spot the server itself refuses: live, 2026-10-13 (direct report, "building... do not
// [work]") -- Mayor retried the exact same 4 "Server refused ... the block is still air" spots
// every single goal tick for 20+ minutes straight. cellOccupied's own fix below only covers a
// spot going bad WITHIN one call -- `tried` (in "place_bed" further down) resets to [] on every
// fresh call, so a spot the server just proved dead on tick N is offered again, identically, on
// tick N+1, forever. Per-process (one bot per process, so module scope is already per-bot),
// TTL'd the same way chestMisses handles a chest search that came up empty: long enough to stop
// the busy-loop, short enough to retry if the world genuinely changes later (a floor gets filled
// in, chunks catch up after a fresh join).
const BED_SPOT_REFUSAL_TTL_MS = 30 * 60_000;
export const refusedBedSpots = new Map(); // "x,y,z" -> refused-at timestamp
export const bedSpotKey = (p) => `${p.x},${p.y},${p.z}`;
export function isRecentlyRefusedBedSpot(p) {
  const at = refusedBedSpots.get(bedSpotKey(p));
  return at !== undefined && Date.now() - at < BED_SPOT_REFUSAL_TTL_MS;
}

// Two free, supported cells in a row near home, plus a standing spot behind the foot: a bed is
// placed facing the way she looks, so she stands at foot - dir and looks at the foot. Beds go next
// to existing beds when there are any (one bedroom, not beds strewn across paths), else as close to
// home as possible but not on it; never beside a door or gate.
const BED_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// Something standing in a cell (a bot, a mob): the server refuses a bed there. The bots crowd around
// spawn, and two of them retried the same spot beside it six times (live, 2026-09-26).
export function cellOccupied(bot, p) {
  return Object.values(bot.entities).some((e) => e !== bot.entity && e.position &&
    Math.floor(e.position.x) === p.x && Math.floor(e.position.z) === p.z && Math.abs(e.position.y - p.y) < 2);
}

export function findBedSite(bot, home) {
  return findBedSites(bot, home)[0] ?? null;
}

// Every usable spot, best first (next to existing beds, else nearest home), none with anything
// standing in the bed's two cells. `within` (a Set of posKeys, optional): only spots whose foot
// and head are both in it -- checked before the shelter preference below, which otherwise can
// pick some other covered space over the room the caller means.
export function findBedSites(bot, home, within = null) {
  const hx = Math.floor(home.x), hy = Math.floor(home.y), hz = Math.floor(home.z);
  // 2026-10-28: a flower or grass tuft counts as open -- place_bed clears it first
  // (clearCellForPlacement), and a meadow shelter room is full of them.
  const open = (p) => { const b = bot.blockAt(p); return !!b && (b.name === "air" || isClearableCover(b)); };
  const solid = (p) => bot.blockAt(p)?.boundingBox === "block";
  const standable = (p) => solid(p.offset(0, -1, 0)) && open(p) && open(p.offset(0, 1, 0));
  const nearDoor = (p) => BED_DIRS.some(([dx, dz]) => {
    const n = bot.blockAt(p.offset(dx, 0, dz))?.name ?? "";
    return n.endsWith("_door") || n.endsWith("_fence_gate");
  });
  // Walled on two opposite sides (a doorway, a corridor): a bed there blocks the way through --
  // the first try put one in the shelter's own doorway (2026-09-27).
  const chokepoint = (p) => [[1, 0], [0, 1]].some(([dx, dz]) =>
    solid(p.offset(dx, 0, dz)) && solid(p.offset(-dx, 0, -dz)) && solid(p.offset(dx, 1, dz)) && solid(p.offset(-dx, 1, -dz)));
  const beds = bot.findBlocks({ matching: (b) => bot.isABed(b), maxDistance: 16, count: 32, point: new Vec3(hx, hy, hz) });
  const anchor = (p) => (beds.length ? Math.min(...beds.map((b) => b.distanceTo(p))) : p.distanceTo(new Vec3(hx, hy, hz)));
  // Direct request, 2026-10-18: "beds will always be placed within a shelter if space is
  // available in an existing shelter" -- any shape/size, not just the Builder's own fixed room
  // (shelterInteriorsNear, shelter.js). Computed once per call, not per candidate: every site
  // below gets tagged, and the whole list is filtered down to the tagged ones afterwards, but
  // only when that subset isn't empty -- with no qualifying shelter nearby yet (the common case
  // before one's built), this falls through to exactly today's nearest/under-a-roof scoring.
  const shelterInterior = shelterInteriorsNear(bot, new Vec3(hx, hy, hz));
  const inShelter = (p) => shelterInterior.has(posKey(p));
  const sites = [];
  for (let dx = -10; dx <= 10; dx++) {
    for (let dz = -10; dz <= 10; dz++) {
      // Keep the open ground right at spawn clear -- but not a shelter room: the shelter is built
      // within 4 blocks of spawn, often right over it (2026-09-27).
      const nearSpawn = Math.max(Math.abs(dx), Math.abs(dz)) < 2;
      for (let dy = -2; dy <= 2; dy++) {
        const foot = new Vec3(hx + dx, hy + dy, hz + dz);
        if (!standable(foot)) continue;
        for (const [ox, oz] of BED_DIRS) {
          const head = foot.offset(ox, 0, oz), stand = foot.offset(-ox, 0, -oz);
          if (!standable(head) || !standable(stand) || nearDoor(foot) || nearDoor(head)) continue;
          if (chokepoint(foot) || chokepoint(head)) continue; // never block a doorway or a corridor
          if (cellOccupied(bot, foot) || cellOccupied(bot, head)) continue;
          if (within && !(within.has(posKey(foot)) && within.has(posKey(head)))) continue;
          // Under a roof (a shelter's room) beats anywhere in the open (2026-09-27).
          const covered = solid(foot.offset(0, 3, 0)) && solid(head.offset(0, 3, 0));
          if (nearSpawn && !covered) continue;
          sites.push({ foot, head, stand, score: anchor(foot) - (covered ? 100 : 0),
            shelter: inShelter(foot) && inShelter(head) });
        }
      }
    }
  }
  const ranked = sites.sort((a, b) => a.score - b.score);
  const withinShelter = ranked.filter((s) => s.shelter);
  return withinShelter.length ? withinShelter : ranked;
}
