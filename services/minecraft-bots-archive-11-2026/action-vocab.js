// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of actions.js (2.0.0) unchanged: timeouts, mob and food lists, gear tiers, fuels, smelt recipes, ore and block families, protected blocks.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. actions.js imports
// it; this file reads actions.js's state through live imports, so nothing here may touch it
// before actions.js has run (only declarations live here).

import pathfinderPkg from "mineflayer-pathfinder";


export const { goals } = pathfinderPkg;

// 2026-09-08 ("the bots just stand around most of the time"): raised 60s -> 90s. Real evidence:
// wanderAndRetryFind() now takes up to 3 wander hops (its own 2026-09-08 fix, see its header
// comment) to actually reach resources that turned out to be 150+ blocks from spawn -- a
// worst-case 45s of wandering alone left too little of the old 60s ceiling for the real work
// (walking to and digging/interacting with whatever was actually found) that needs to happen
// afterward, inside the very same withTimeout() call. Every action here already has its own
// real cancellation via withTimeout's required onTimeout callback, so a larger ceiling doesn't
// add a new risk class -- it just means a genuinely stuck action takes a bit longer to be
// force-cancelled.
export const ACTION_TIMEOUT_MS = 90_000;
// A real Minecraft night (or the wait for it to naturally pass while sleeping) runs several
// real-world minutes even at normal speed -- ACTION_TIMEOUT_MS (60s) would abort a perfectly
// normal night's sleep as a "failure." This is a safety backstop for something going genuinely
// wrong (a stuck day/night cycle, a disabled gamerule), not the expected case.
export const SLEEP_TIMEOUT_MS = 15 * 60_000;
// Vanilla's bite timer is randomized per cast (roughly 5-30s unenchanted, longer is possible) --
// generous headroom over the realistic range rather than a tight bound, same reasoning as
// SLEEP_TIMEOUT_MS above. A cast that genuinely never bites (bad water, e.g. too shallow/enclosed)
// should time out and get reported as a real failure, not hang the action loop indefinitely.
export const FISH_TIMEOUT_MS = 90_000;
// Vanilla smelts one item per 10 real-world seconds with normal fuel/speed -- generous headroom
// per item rather than a tight bound, consistent with this being local compute with no per-call
// cost to economize on.
export const SMELT_TIMEOUT_MS = 3 * 60_000;

// Exported (2026-09-10) so "light_area" (its own real bug fix -- see that case's own header) and
// index.js's checkLighting()/checkHomeLighting() share exactly one definition instead of two
// copies drifting apart. block.light (confirmed against prismarine-block source) is the real
// per-position light value, 0-15; under 8 is the common threshold below which hostile mobs can
// spawn, the same heuristic most mineflayer bots use since there's no simpler "is this dark"
// signal exposed directly.
export const DARK_LIGHT_LEVEL = 8;

export const HOSTILE_MOBS = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "spider", "cave_spider",
  "creeper", "enderman", "witch", "phantom", "slime", "magma_cube", "silverfish", "blaze",
  "ghast", "guardian", "elder_guardian", "shulker", "vex", "vindicator", "evoker", "pillager",
  "ravager", "hoglin", "zoglin", "piglin_brute", "warden",
]);

// Shared between the "attack"/"flee" actions here and index.js's checkSelfDefense()/
// checkSleepingThreat() (fourth of five scoped enhancements, direct follow-up to "what other
// logic enhancements are available") so HOSTILE_MOBS has exactly one definition instead of two
// copies drifting apart.
//
// Real, foundational bug found live 2026-09-08 (direct report: "they still don't seem to react
// to a threatening creature"): confirmed by directly inspecting a real, freshly summoned zombie
// entity on this exact server that its own entity.type is "hostile", not "mob" -- this check had
// been requiring "mob" the entire time, meaning this function has NEVER matched a single real
// hostile mob (zombie, skeleton, creeper, or anything else in HOSTILE_MOBS below), on any
// version of this codebase, since the day it was written. Not a timing/gating bug -- every
// caller (checkSelfDefense, checkSleepingThreat, "attack"/"flee" targeting) was working from a
// function that always returned undefined.
//
// Second real bug found live 2026-09-10 (direct report: "they don't seem to be able to fight,
// or run from, phantoms"): the "hostile" requirement added above is ITSELF wrong for a real
// subset of HOSTILE_MOBS -- confirmed directly against minecraft-data's own entity registry
// (mineflayer's entity.type is populated straight from this same field, lib/plugins/entities.js):
// phantom, ghast, slime, and shulker all carry type "mob", not "hostile", despite minecraft-data's
// own SEPARATE "category" field correctly listing all four as "Hostile mobs" -- an inconsistency
// within minecraft-data itself between its coarse `type` and its more specific `category`. Adding
// the "hostile" type check on top of the already-curated HOSTILE_MOBS name allowlist didn't add
// real safety (nothing outside this deliberate list was ever going to match by name), it just
// silently excluded every entry whose real `type` field happens not to be "hostile" -- self-
// defense/flee never even saw a nearby phantom as a threat, not a targeting or combat failure,
// a detection failure with no error to show for it. HOSTILE_MOBS.has(e.name) alone is the correct,
// sufficient condition: it's already the deliberate, curated "treat this as a threat" list this
// function exists to check against.
export function nearestHostile(bot, maxDistance = 16) {
  return bot.nearestEntity((e) => HOSTILE_MOBS.has(e.name) &&
    e.position.distanceTo(bot.entity.position) <= maxDistance);
}

// Direct request, 2026-09-18 ("have the threatened bot run towards safety, run towards golems, or
// soldiers"), direct follow-up to the SQUAD_ASSIST_RANGE finding (a fleeing bot beyond 48 blocks
// of both Soldiers gets no help at all). Same shape as nearestHostile -- an iron golem fights
// nearby hostiles on its own vanilla AI once a bot leads a threat near one, real backup a bot can
// reach on foot even when no teammate is close enough to come to her.
export function nearestFriendlyGolem(bot, maxDistance = 32) {
  return bot.nearestEntity((e) => e.name === "iron_golem" &&
    e.position.distanceTo(bot.entity.position) <= maxDistance);
}

// Real bug found live 2026-09-10 (direct report: "they don't seem to be able to fight, or run
// from, phantoms"), AFTER both the detection gap above (1.43.0) and the combat-resolution bug
// (1.42.0) were already fixed: a ground-bound bot's "attack" (bot.pvp.attack() -> a pathfinder
// GoalFollow within 2 blocks) can never actually close to melee range against a mob that flies
// well above pathfinding reach. Confirmed live via a direct, unambiguous read: Luke's own
// checkSelfDefense "attack" against a phantom held SELF_DEFENSE-tier arbiter control
// CONTINUOUSLY for the full 90s ACTION_TIMEOUT_MS ceiling -- during which every other
// self-defense re-trigger, squad response, and recovery attempt correctly reported "yielded to
// something more urgent (SELF_DEFENSE)" for the entire span, repeating every time the doomed
// chase re-triggered. That's exactly what "can't fight or run" looks like live, even though both
// prior fixes are individually correct and working. Fleeing, unlike attacking, never needs to
// reach the target -- already confirmed live to genuinely create real distance every cycle. Mobs
// in this set are always fled from, never melee-attacked, regardless of health -- ghast included
// on the same reasoning (also a flyer, also effectively unreachable on foot).
//
// Direct report, 2026-09-18 ("Luke is getting shot, not reacting. there is no mass mob"): enderman
// added on the same underlying reasoning, confirmed live -- Luke's own self-defense held
// SELF_DEFENSE-tier control on an "attack (threat=enderman)" for over a minute straight (silently
// re-returning on every 2s checkSelfDefense tick the whole time, since selfDefenseInFlight was
// still true) while a skeleton he had no ability to respond to sniped him from range, only broken
// by the separate EMERGENCY health-critical flee once he'd already dropped to ~6 HP -- then
// immediately re-engaged the SAME enderman and repeated. Endermen aren't flightless-unreachable
// like phantom/ghast, but teleporting away whenever hit makes bot.pvp's chase-and-melee approach
// close to it in practice: confirmed fleet-wide, Mark and Luke (the two bots actually willing to
// melee-attack rather than flee at their own tuned health thresholds) logged 2,800 and 1,770
// enderman self-defense triggers respectively in 24h -- far above every other bot -- consistent
// with the same doomed-retry shape, not an occasional unlucky fight.
export const FLEE_ONLY_MOBS = new Set(["phantom", "ghast", "enderman"]);

// Direct request, 2026-09-07 ("look for more ways to improve their autonomy" -> hunger). Checked
// live: minecraft-data's own item registry carries no food/nutrition field at all (bread/apple
// both come back with no foodPoints), unlike blocks/recipes -- there's no real data to defer to
// here, so this is a small, deliberately curated list of common foods, the same pragmatic
// approach already used for FUEL_PREFERENCE/SMELT_RECIPES rather than an attempt at exhaustive
// coverage. Exported so "loot" can also recognize food as worth taking, same reasoning as fuel.
export const FOOD_NAMES = [
  "bread", "apple", "golden_apple", "enchanted_golden_apple", "cooked_beef", "cooked_porkchop",
  "cooked_chicken", "cooked_mutton", "cooked_rabbit", "cooked_cod", "cooked_salmon",
  "baked_potato", "potato", "carrot", "golden_carrot", "melon_slice", "sweet_berries",
  "glow_berries", "cookie", "pumpkin_pie", "mushroom_stew", "rabbit_stew", "beetroot",
  "beetroot_soup", "dried_kelp",
  // Review MB-15, 2026-09-24: raw catches/drops safe to eat uncooked, listed LAST so "eat" prefers
  // anything cooked. Fishing is checkHunger's fallback, and raw cod/salmon used to be inedible
  // here with no cooking recipe either -- the food loop never closed.
  // 2026-11-01: raw chicken too, dead last -- its poison is a 30% chance of a brief Hunger effect,
  // a fraction of a food point, and leaving it out left Babs and Amy at food 0 for a day with 15
  // chickens and no other spare animal within 64 blocks of home.
  "cod", "salmon", "beef", "porkchop", "mutton", "rabbit", "chicken",
];
// What "hunt" goes after: each drops a raw meat in FOOD_NAMES.
export const HUNTABLE_ANIMALS = new Set(["cow", "mooshroom", "pig", "sheep", "rabbit", "chicken"]);
// 32 found nothing around home on 2026-11-01; 64 found 15 chickens.
export const HUNT_RANGE = 64;

// Suffix-matched, same convention as equipment.js -- what's worth pulling out of a chest.
// Food/blocks/misc items are left behind; this is specifically about gearing up.
export const GEAR_SUFFIXES = [
  "_helmet", "_chestplate", "_leggings", "_boots", "_sword", "_axe", "_pickaxe", "_shovel", "_hoe",
];

// Direct request, 2026-09-19 ("the downgrade rejection must also reject if the mayor's
// instructions would cause the quality of their equipment to be reduced") -- direct follow-up to
// "give"'s own §40 fix below, which only ever caught going from "has one" to "has none." Giving
// away a diamond sword while a wooden one stays behind is just as much a downgrade as giving away
// her only sword outright. A single common-sense material ranking, not a precise simulation of
// real armor-point/mining-level math (gold in particular is inconsistent in actual vanilla rules
// between tools and armor) -- good enough to answer "would she end up worse than before," which
// is all this check needs.
export const GEAR_TIER_RANK = {
  wood: 0, wooden: 0, leather: 0,
  golden: 1, gold: 1,
  stone: 2, chainmail: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

// Returns -1 for an unrecognized material (e.g. a modded item) rather than guessing -- callers
// treat that as "no tier data, don't block on quality" and fall back to the has-one/has-none check.
export function gearTierRank(itemName, suffix) {
  const material = itemName.slice(0, itemName.length - suffix.length);
  return material in GEAR_TIER_RANK ? GEAR_TIER_RANK[material] : -1;
}

// Direct request, 2026-09-18 ("if the bot is in need of a piece of equipment... and finds one
// already crafted in a chest, it should pick up ONE of those pieces... and abandon the quest to
// craft it"): the existing chest-substitution checks (craft/loot, below) only ever matched the
// EXACT item id the model happened to name (e.g. "stone_pickaxe") -- a chest holding a BETTER or
// just DIFFERENT-tier instance of the same equipment (an iron_pickaxe, say) was invisible to an
// exact match, so she'd craft or keep looking for the specific tier she'd guessed instead of
// recognizing ANY real pickaxe as already satisfying the need. Deliberately only broadens for
// gear (GEAR_SUFFIXES) -- raw materials have no equivalent "any tier will do" concept, an
// iron_ingot really is the one specific thing a recipe needs, so this is a no-op for anything
// that isn't armor/a weapon/a tool. Doesn't prefer the best tier if a chest happens to hold more
// than one -- tryTakeFromThisChest() takes whichever matches first, same as it always has; gear
// is near-universally requested one at a time, so "any real instance" is enough to satisfy this.
export function gearCategoryNames(bot, itemName) {
  const suffix = GEAR_SUFFIXES.find((s) => itemName.endsWith(s));
  if (!suffix) return [itemName];
  return Object.keys(bot.registry.itemsByName).filter((name) => name.endsWith(suffix));
}

// Real gap found live (2026-09-07): once furnace smelting existed, "no fuel" became the single
// most common reason a goal gave up, and loot -- the natural fallback -- had no idea coal/
// charcoal were worth taking, only armor/tools. Unlike a looted furnace or crafting table
// (useless without a placement capability this system doesn't have), fuel gets consumed directly
// inside an existing furnace, so it's genuinely actionable the moment it's in inventory.
const FUEL_NAMES = ["coal", "charcoal"];

// Exported for index.js's checkInventoryFull() (2026-09-07, "do all" -> base/chest storage) --
// "essential" mirrors exactly what "loot" already considers worth taking (gear/fuel/food);
// everything else is fair game to store away when space is tight, one definition shared instead
// of two copies drifting apart.
export function isEssentialItem(itemName) {
  return GEAR_SUFFIXES.some((s) => itemName.endsWith(s)) || FUEL_NAMES.includes(itemName) ||
    FOOD_NAMES.includes(itemName);
}

// Exported for skills.js (MINECRAFT_BOTS_DESIGN.md §14, 2026-09-08): the real, authoritative set
// of verbs performAction() actually implements, checked against before a model-authored skill is
// ever stored -- "validate against real data, don't trust the model" (already the tool-tier
// gate's own reasoning). Deliberately excludes "gohome" and "recover": both are invoked directly
// by index.js's own timers/handlers with context a stored skill has no way to reconstruct
// (bot.spawnPoint, a captured death position) -- they never appear in a goal's own step log a
// skill would be compressed from, so leaving them out costs nothing real.
//
// Real gap found live 2026-09-11 (direct request "fix ... the dynamic skill library"): every verb
// added THIS session (repair_terrain, harvest_hive, shear, milk, build_pen, herd_to_pen) had been
// left out of this set entirely -- not a deliberate exclusion, just never wired through, meaning
// none of them could ever be captured into a reusable skill even though five of the six are
// perfectly self-contained the same way breed/harvest already are. harvest_hive/shear/milk/
// build_pen/herd_to_pen added now. repair_terrain deliberately still excluded, same reasoning as
// gohome/recover above: action.position is a specific pit location index.js's own
// checkTerrainDamage() discovers fresh each time via a live world scan -- a stored skill has no
// way to reconstruct which pit that was.
export const SKILL_ACTION_VERBS = new Set([
  "stop", "goto", "follow", "mine", "craft", "loot", "attack", "flee", "eat", "fish", "give",
  "sleep", "smelt", "place", "build", "store", "trade", "harvest", "breed", "enchant", "explore",
  "plant_sapling", "light_area", "harvest_hive", "shear", "milk", "build_pen", "herd_to_pen", "gohome",
  "get_wool", "place_bed", "clear_access",
]);

// minecraft-data has no dedicated smelting-recipe file (confirmed: no equivalent of recipes.json
// for furnace input->output) -- unlike bot.craft()'s crafting-table recipes, there's no real data
// to defer to here, so this is a small, deliberately hand-picked map of the smelting outcomes
// that actually matter for gearing up (direct request, 2026-09-07: "they can't seem to find the
// furnaces" -- most of a night's worth of goal failures were bots correctly identifying they
// needed an ingot and having no way to get one beyond hoping a chest had it). Keyed by the
// item the bot names (the OUTPUT, same convention as ACTION CRAFT), each mapping to the raw
// materials that smelt into it, checked against her inventory in order.
export const SMELT_RECIPES = {
  iron_ingot: ["raw_iron", "iron_ore", "deepslate_iron_ore"],
  copper_ingot: ["raw_copper", "copper_ore", "deepslate_copper_ore"],
  gold_ingot: ["raw_gold", "gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
  glass: ["sand", "red_sand"],
  stone: ["cobblestone"],
  // Review MB-15: cooking, so raw food can be upgraded at a furnace.
  cooked_cod: ["cod"], cooked_salmon: ["salmon"], cooked_beef: ["beef"],
  cooked_porkchop: ["porkchop"], cooked_mutton: ["mutton"], cooked_chicken: ["chicken"],
  cooked_rabbit: ["rabbit"], baked_potato: ["potato"],
};

// Preferred fuels in order; coal/charcoal burn far longer per item than planks/logs (which are
// still valid fuel and a reasonable fallback since they're often what's actually on hand).
const FUEL_PREFERENCE = ["coal", "charcoal", "coal_block", "lava_bucket", "blaze_rod"];

export function pickFuel(bot) {
  for (const name of FUEL_PREFERENCE) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (item) return item;
  }
  return bot.inventory.items().find((i) => i.name.endsWith("_planks") || i.name.endsWith("_log"));
}

// Direct request, 2026-09-07 ("the build attempts are too narrow -- they should understand
// classes of things. wood can be any form of wood, not just oak or spruce"). Real gap: "mine"
// used to look up exactly one block id, so a goal step of "mine oak_log" failed outright
// wherever the only trees nearby were spruce or birch -- even though any log serves the
// identical purpose. Minecraft has several of these "any member of the family is equally
// usable" groups (any log/stem regardless of species, any planks, any wool/carpet/concrete/
// terracotta/stained-glass color, and ore that generates as either a stone-layer or
// deepslate-layer block depending on depth -- SMELT_RECIPES above already treats those ore
// pairs as one thing for exactly this reason). resolveBlockFamily expands a single requested
// name to every id that serves the same real purpose, so a specific example is only ever a
// hint at WHICH family to gather, never a hard requirement to find that exact one.
// GENERIC_BLOCK_ALIASES additionally lets a bare class word ("log", "wool") stand in for a real
// example of that class, in case the model names the category directly rather than a species.
const ORE_FAMILIES = [
  ["iron_ore", "deepslate_iron_ore"],
  ["copper_ore", "deepslate_copper_ore"],
  ["gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
  ["diamond_ore", "deepslate_diamond_ore"],
  ["emerald_ore", "deepslate_emerald_ore"],
  ["lapis_ore", "deepslate_lapis_ore"],
  ["coal_ore", "deepslate_coal_ore"],
  ["redstone_ore", "deepslate_redstone_ore"],
];
// A plain "_stem" suffix was tried and rejected here (verified against the real 1.21.11 block
// registry, not assumed): it also sweeps up pumpkin_stem/melon_stem/attached_*_stem (crop
// blocks) and mushroom_stem/big_dripleaf_stem (unrelated plant blocks) -- none of them wood.
// The only real wood stems are these four Nether ones, listed explicitly instead.
const NETHER_STEM_NAMES = ["crimson_stem", "warped_stem", "stripped_crimson_stem", "stripped_warped_stem"];
// Each group's `match` suffix(es) are checked with plain String.endsWith, which is why
// "_terracotta" needs its own `exclude`: "orange_glazed_terracotta" also, trivially, ends with
// the substring "_terracotta" (also verified against the real registry, not assumed) even though
// it's a visually and functionally distinct crafted block, not interchangeable with plain
// terracotta. concrete/concrete_powder and stained_glass/stained_glass_pane don't have this
// problem -- their extra suffix text comes AFTER the shared root, not as a prefix word before it.
// Order matters: resolveBlockFamily picks the FIRST group the requested name matches, so the
// more specific suffix must be listed first -- a real bug caught in testing had a request for
// "orange_glazed_terracotta" itself match the broader "_terracotta" group before ever reaching
// its own, since .find() stops at the first hit regardless of specificity.
const BLOCK_FAMILY_GROUPS = [
  { match: ["_planks"] }, { match: ["_wool"] },
  { match: ["_concrete_powder"] }, { match: ["_concrete"] },
  { match: ["_glazed_terracotta"] }, { match: ["_terracotta"], exclude: ["_glazed_terracotta"] },
  { match: ["_stained_glass_pane"] }, { match: ["_stained_glass"] },
  { match: ["_carpet"] },
];
// Real gap found live, 2026-09-07, standing up Mark/Luke (military bots whose whole standing
// goal is "arm up"): the goal planner reasoned its way to "mine raw_iron" -- raw_iron is the
// ITEM a player gets, never a real block id, so this failed outright ("I don't recognize the
// block") on exactly the step this build exists to make reliable. Same shape as the smelt
// action's existing input/output normalization (accept either name); here every raw_* ore item
// and a few other common drop-vs-block mixups alias to the block that actually drops them.
const GENERIC_BLOCK_ALIASES = {
  log: "oak_log", logs: "oak_log", wood: "oak_log", planks: "oak_planks", plank: "oak_planks",
  wool: "white_wool", carpet: "white_carpet", concrete: "white_concrete", ore: "iron_ore",
  raw_iron: "iron_ore", raw_copper: "copper_ore", raw_gold: "gold_ore",
  coal: "coal_ore", diamond: "diamond_ore", emerald: "emerald_ore",
  lapis_lazuli: "lapis_ore", redstone: "redstone_ore",
};

export function resolveBlockFamily(bot, requestedName) {
  const name = GENERIC_BLOCK_ALIASES[requestedName] || requestedName;

  const oreFamily = ORE_FAMILIES.find((family) => family.includes(name));
  if (oreFamily) {
    return oreFamily.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  }

  if (name.endsWith("_log") || NETHER_STEM_NAMES.includes(name)) {
    const names = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith("_log"))
      .concat(NETHER_STEM_NAMES);
    return names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  }

  const group = BLOCK_FAMILY_GROUPS.find((g) => g.match.some((s) => name.endsWith(s)));
  if (group) {
    return Object.keys(bot.registry.blocksByName)
      .filter((n) => group.match.some((s) => n.endsWith(s)) &&
        !(group.exclude ?? []).some((s) => n.endsWith(s)))
      .map((n) => bot.registry.blocksByName[n].id);
  }

  const single = bot.registry.blocksByName[name];
  return single ? [single.id] : [];
}

// Direct request, 2026-09-08 ("before they dig or destroy a block, they should make sure it is
// not a functional block like a bed or a furnace, a book[shelf], a table, or any other form of
// crafted item or block"). Two real, separate places this matters, both closed by this one
// shared list (exported so index.js's pathfinder Movements setup can reuse the exact same
// definition, "one definition shared instead of two copies drifting apart" per isEssentialItem's
// own precedent): (1) resolveBlockFamily()'s own raw single-name fallback (just above) will
// happily resolve ANY real block name at all, including "furnace" or "crafting_table" -- nothing
// before now stopped "mine"/"explore" from being pointed at one on purpose. (2) mineflayer-
// pathfinder's own Movements defaults (confirmed against its real movements.js source) only ever
// protects chests and non-diggable blocks (bedrock etc.) from auto-digging while pathing around
// an obstacle -- a furnace, bed, or bookshelf sitting in a bot's way is "diggable" by that
// library's own definition and gets bulldozed through exactly like stone would. Bed and shulker
// box colors are matched by suffix since minecraft-data registers each of the 16 as its own
// block name (`red_bed`, `lime_shulker_box`, etc.), not one shared id.
const PROTECTED_BLOCK_NAMES = [
  "furnace", "blast_furnace", "smoker", "crafting_table", "smithing_table", "cartography_table",
  "fletching_table", "loom", "stonecutter", "grindstone", "anvil", "chipped_anvil", "damaged_anvil",
  "enchanting_table", "brewing_stand", "cauldron", "beacon", "jukebox", "note_block", "lectern",
  "composter", "lodestone", "respawn_anchor", "chest", "trapped_chest", "ender_chest", "barrel",
  "bookshelf", "chiseled_bookshelf",
];

// Real bug found live 2026-09-13 (direct request "they need to OPEN doors not destroy them").
// Doors/trapdoors/fence gates were only ever categorized as BUILDING_MATERIAL_SUFFIXES (a
// looksLikeBuilding() detection heuristic below) -- never added here, which is the list that
// actually feeds movements.blocksCantBreak (index.js's own pathfinder setup). canOpenDoors was
// already enabled (2026-09-07) so pathfinder SHOULD open a door in its way instead of digging it,
// but nothing ever stopped it from falling back to digging through one if that logic didn't apply
// to a given move type -- the same "diggable by the library's own definition" gap this list
// already closes for furnaces/beds/chests, just never extended to the one block class the
// operator specifically named. Matches mineflayer-pathfinder's own `blockC.openable` concept
// (the exact set canOpenDoors' own check cares about) -- fence gates included since build_pen/
// herd_to_pen already open/close them deliberately via activateBlock, a different operation from
// digging, so protecting them from auto-dig doesn't conflict with that.
// 2026-11-01 (direct report, "they are destroying the fence in the pen"): plain fences too. The
// gate was protected, the 23 fences around it weren't, and the pathfinder dug through one rather
// than walk round to the gate it opens anyway (movements' `openable`).
export function isProtectedBlockName(name) {
  return PROTECTED_BLOCK_NAMES.includes(name) || (name?.endsWith("_bed") ?? false) ||
    (name?.endsWith("_shulker_box") ?? false) || (name?.endsWith("_door") ?? false) ||
    (name?.endsWith("_trapdoor") ?? false) || (name?.endsWith("_fence_gate") ?? false) ||
    (name?.endsWith("_fence") ?? false);
}
