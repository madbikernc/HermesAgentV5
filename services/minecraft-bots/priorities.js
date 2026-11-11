// Version: 1.0.0
//
// 1.0.0 (2026-11-10) -- split out of index.js (2.144.0) unchanged: what to work on next -- the
// survival, tool-upgrade, shelter-reface, builder and soldier priority lists, the communal
// shelter checks and the fleet's iron-tool evidence. Its own file, under the self-repair
// pipeline's 40000-char whole-file limit. bot, USERNAME and the rest are read back from
// index.js, only inside functions.

import { FLEE_ONLY_MOBS, communalDoorwayPosition, communalShelterPositions, getAchievements, holdsGuardAnchor, isCommunalShelterMaterial, nearestHostile } from "./actions.js";
import { hasWeapon } from "./equipment.js";
import { BUILDER_PRIORITY_RADIUS, completeSheltersNearHome, countNearHome, countUsableNearHome, residenceDirective, residencePlan, shelterGeometryPositions, shelterHasBed } from "./home-scan.js";
import { BOT_ROLES, ROLES } from "./roles.js";
import { SELF_DEFENSE_RANGE } from "./self-defense.js";
import { isDoorway } from "./swim-movements.js";
import { BOT_USERNAMES, GOAL_LEASE_MS, HUNGER_THRESHOLD, TOOL_TIERS, USERNAME, bot, foodFetchBlockedUntil, hasFood, hasPickaxe, hasRod, otherBotGoalSeenAt, proposeOwnGoal, toolStep } from "./index.js";

// Home scanning: counting blocks near home, shelter and residence detection: in home-scan.js (split out 2026-11-10).
// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a -- "once the fleet's
// progression reaches iron tools or better... checked the same verified way the existing
// curriculum already checks tool tiers... not a new detection mechanism"). TECH_TREE_STAGES'
// own fleet-wide evidence tracking (stageEvidence/stageProgress, below) is Mayor-only by design
// (only Mayor ever credits it) -- reusing it here would mean only Mayor's own process could ever
// see the communal shelter as unlocked, defeating the whole "any idle bot" point of Tier 2.
// Instead: a small, UNGATED (every bot, not just Mayor) tracker fed by the exact same verified
// evidence already flowing fleet-wide -- her own current gear, checked fresh every call, plus
// whatever an incoming "goal"/"evidence" Buzz message's real item names reveal (see the incoming
// handler below) -- never a bare claim, the same trust TECH_TREE_STAGES' own mayorHasStageItem()
// already relies on. In-memory only (resets on restart), same low-stakes tradeoff
// otherBotActivityAt already makes.
const TOOL_NAME = /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe)$/;
function isIronOrBetterTool(name) {
  const m = TOOL_NAME.exec(name);
  return !!m && TOOL_TIERS.indexOf(m[1]) >= TOOL_TIERS.indexOf("iron");
}
let fleetHasIronTool = false;
export function noteIronToolEvidence(itemNames) {
  if (!fleetHasIronTool && itemNames?.some(isIronOrBetterTool)) fleetHasIronTool = true;
}
function fleetHasReachedIronTools() {
  const mine = bot.inventory.items().map((i) => i.name)
    .concat([5, 6, 7, 8, 45].map((s) => bot.inventory.slots[s]?.name).filter(Boolean));
  noteIronToolEvidence(mine);
  return fleetHasIronTool;
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a), sized per the operator's
// own rule (2026-10-12: "large enough for beds to suit all active bots... at least N+1 for N
// bots"). No exact bed layout is pre-planned (see communalShelterPositions()'s own header,
// actions.js) -- the room is just sized generously enough that findBedSites() can actually fit
// the target count, called once per bed by runCommunalShelterGoal() below. Roughly 4 floor cells
// per bed (a bed's own foot+head, plus room for the stand cell and a little aisle slack) keeps
// the room squarish and not razor-thin for a large target.
function communalShelterTargetBeds() {
  return BOT_USERNAMES.size + 1;
}
export function communalShelterSize() {
  const side = Math.max(5, Math.ceil(Math.sqrt(communalShelterTargetBeds() * 4)));
  return { width: side, depth: side };
}

// Mirrors findShelterNearHome()/hasHollowInterior() above, parameterized by width/depth instead
// of the individual shelter's fixed SHELTER_ROOM -- same "100% solid walls/roof/floor, a real
// door" completeness bar, just no bed-count check here (that's tracked separately below, since
// the target is N+1 beds, not just one).
function hasHollowCommunalInterior(base, width, depth) {
  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      const floor = bot.blockAt(base.offset(dx, 0, dz)), above = bot.blockAt(base.offset(dx, 1, dz));
      if (!((floor?.boundingBox !== "block" || bot.isABed(floor)) && above?.boundingBox !== "block")) return false;
    }
  }
  return true;
}
export function findCommunalShelterNearHome() {
  if (!bot.spawnPoint) return null;
  const { width, depth } = communalShelterSize();
  const center = bot.spawnPoint.floored();
  let damaged = null, damagedSolid = -1;
  for (let dx = -BUILDER_PRIORITY_RADIUS; dx <= BUILDER_PRIORITY_RADIUS; dx++) {
    for (let dz = -BUILDER_PRIORITY_RADIUS; dz <= BUILDER_PRIORITY_RADIUS; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const base = center.offset(dx, dy, dz);
        if (!hasHollowCommunalInterior(base, width, depth)) continue;
        const positions = communalShelterPositions(base, width, depth);
        const solid = positions.filter((pos) => bot.blockAt(pos)?.boundingBox === "block").length;
        const hasDoor = isDoorway(bot.blockAt(communalDoorwayPosition(base, depth)));
        if (solid === positions.length && hasDoor) return { base, width, depth, complete: true };
        if (solid >= positions.length * 0.5 && solid > damagedSolid) {
          damaged = base;
          damagedSolid = solid;
        }
      }
    }
  }
  return damaged ? { base: damaged, width, depth, complete: false } : null;
}
function hasCommunalShelterStructure() {
  return findCommunalShelterNearHome()?.complete === true;
}
// Real beds specifically inside the communal room's own footprint -- not a bare "near home"
// count, which would also catch every individual shelter's own bed and over-report progress.
function communalShelterBedCount(base, width, depth) {
  let count = 0;
  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      if (bot.isABed(bot.blockAt(base.offset(dx, 0, dz)))) count++;
    }
  }
  return Math.ceil(count / 2); // each bed is two cells (foot+head), both inside the same room
}
export function communalShelterSatisfied() {
  const found = findCommunalShelterNearHome();
  return !!found?.complete && communalShelterBedCount(found.base, found.width, found.depth) >= communalShelterTargetBeds();
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md §1, Tier 1 -- "survival needs... don't stop
// applying to a Miner or a Farmer just because her role happens not to enforce them"). Mirrors
// nextBuilderPriority()/nextSoldierPriority()'s own shape -- a deterministic, world-checked
// ladder ahead of freeform self-propose -- but applies to EVERY bot regardless of role, checked
// FIRST in proposeOwnGoal() (Tier 1 outranks Tier 2/3, so Builder's/Soldier's own remaining
// role-specific items only run once this returns null). Weapon and armor move here from
// nextSoldierPriority(), which drops both (now redundant: Tier 1 already intercepts first).
//
// Item 0 (shelter-integrity repair) isn't checked here: checkShelterIntegrity() (above) already
// runs as its own fully autonomous periodic routine and repairs a breach directly, without
// waiting on a goal to carry it -- nothing here would make that faster, only redundant.
//
// Item 3 (not trending toward starvation) deliberately escalates to a real goal only once the
// existing reactive chore (checkHunger, below) has already tried and backed off -- that chore
// already runs every 15s well before this would ever be checked, so jumping straight to a goal
// before giving it a chance would just duplicate, not improve on, what it's already doing.
export function nextSurvivalPriority() {
  if (!hasWeapon(bot)) {
    return {
      name: "weapon",
      directive: "you have no sword or axe -- get one before anything else. Check a nearby or " +
        "remembered chest first, ask the fleet if anyone has a spare to give you, and if neither " +
        "works, gather materials and craft one.",
    };
  }
  // 2026-11-04: the residence model (residencePlan) -- beds for the active bots, each in a
  // residence with a chest -- replaces "her own shelter with a bed in it".
  const residence = residencePlan();
  if (residence.kind !== "done") return { name: "shelter", directive: residenceDirective(residence) };
  if (bot.food < HUNGER_THRESHOLD && !hasFood() && !hasRod() && Date.now() < foodFetchBlockedUntil) {
    return {
      name: "food",
      directive: "you're low on food, with nothing to eat nearby and no fishing rod -- go get " +
        "some: hunt a nearby animal for meat, harvest a ripe crop, or head to a remembered food " +
        "source.",
    };
  }
  const wornPieces = [5, 6, 7, 8].filter((slot) => bot.inventory.slots[slot]).length;
  if (wornPieces < 4 && Date.now() >= survivalArmorRetryAt) {
    survivalArmorRetryAt = Date.now() + SURVIVAL_ARMOR_RETRY_MS;
    return {
      name: "armor",
      directive: `you're only wearing ${wornPieces} of 4 armor pieces -- get a full set, any ` +
        "tier: check nearby chests, ask the fleet for spares, or gather materials and craft them.",
    };
  }
  const upgrade = nextToolUpgrade();
  if (upgrade && Date.now() >= toolUpgradeRetryAt) {
    toolUpgradeRetryAt = Date.now() + TOOL_UPGRADE_RETRY_MS;
    return { name: "tools", directive: `upgrade your tools: craft a ${upgrade.replace("_", " ")}.` };
  }
  // 2026-11-04: not without a pickaxe -- stone is the whole job. Babs (no pickaxe) ran this goal
  // ~1,140 times a day, every step "need a better tool for stone"; nextToolUpgrade() now asks for
  // the wooden pickaxe first.
  if (hasPickaxe() && shelterCellsToReface().length && Date.now() >= shelterUpgradeRetryAt) {
    shelterUpgradeRetryAt = Date.now() + SHELTER_UPGRADE_RETRY_MS;
    return { name: "shelter_upgrade", directive: "reinforce your home: swap some of its dirt and wood blocks for stone." };
  }
  return null;
}
const SURVIVAL_ARMOR_RETRY_MS = 30 * 60_000;
let survivalArmorRetryAt = 0;

// Direct request, 2026-10-28 ("their goals should evolve in shelter quality, just like in tools
// quality... when they have the capability to easily mine stone, tools should be upgraded to
// stone; when they can smelt metal, tools should upgrade to metal; once they have safe shelter to
// sleep in, they should gradually replace the earth shelter with stone"). Operator's calls: all
// five tools, and shelters stop at stone (an iron-block shelter is ~630 ingots). The two lowest
// Tier 1 items, each behind a retry timer like armor so an upgrade that's stuck (no iron found
// yet) never crowds out everything below it.
//
// Tools: the target tier is what she can make now -- stone once she holds any pickaxe (stone is
// then minable), iron once she holds a stone-or-better pickaxe (iron ore needs one) AND a usable
// furnace stands near home. Golden tools rank with wooden: softer than stone, they last no time.
const UPGRADE_TOOLS = ["pickaxe", "axe", "sword", "shovel", "hoe"];
export const TOOL_RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };
const TOOL_UPGRADE_RETRY_MS = 20 * 60_000;
let toolUpgradeRetryAt = 0;

function bestToolRank(tool) {
  let best = -1;
  for (const item of bot.inventory.items()) {
    const m = TOOL_NAME.exec(item.name);
    if (m && m[2] === tool) best = Math.max(best, TOOL_RANK[m[1]]);
  }
  return best;
}

function toolTargetTier() {
  const pickaxe = bestToolRank("pickaxe");
  if (pickaxe < 0) return null; // no pickaxe at all: toolStep's own wooden one comes first
  return pickaxe >= TOOL_RANK.stone && countUsableNearHome(["furnace"]) >= 1 ? "iron" : "stone";
}

// 2026-11-04: with no pickaxe at all, a wooden one is the upgrade. toolTargetTier() has nothing to
// offer then, and its "toolStep's own wooden one comes first" only ever ran for a Mayor-assigned
// "get a pickaxe" -- nothing in Tier 1 ever got a pickaxe-less bot one.
export function nextToolUpgrade() {
  if (bestToolRank("pickaxe") < 0) return "wooden_pickaxe";
  const tier = toolTargetTier();
  if (!tier) return null;
  const tool = UPGRADE_TOOLS.find((name) => bestToolRank(name) < TOOL_RANK[tier]);
  return tool ? `${tier}_${tool}` : null;
}

// Shelter: the cells of her own bedded shelter (walls, roof, floor) that aren't stone-tier yet --
// isCommunalShelterMaterial() is already the codebase's "stone or better building block" test.
const SHELTER_UPGRADE_RETRY_MS = 20 * 60_000;
export const SHELTER_REFACE_BATCH = 8;
let shelterUpgradeRetryAt = 0;

function ownBeddedShelter() {
  return completeSheltersNearHome().find(shelterHasBed) ?? null;
}

export function shelterCellsToReface() {
  const base = ownBeddedShelter();
  if (!base) return [];
  return shelterGeometryPositions(base).filter((pos) => !isCommunalShelterMaterial(bot.blockAt(pos)?.name ?? ""));
}

// Same hallucinated-DONE problem builderPriorityItemSatisfied() already guards against (a model
// claiming success the instant an item exists in inventory, regardless of whether the real-world
// condition the directive actually asked for is true) -- "shelter" and "food" don't reduce to
// "holds item X" the generic DONE check (parsed.item, below) already covers, so they need the
// same kind of explicit re-check Builder's own items get. "weapon"/"armor" ARE already covered by
// that generic check (an axe or a chestplate is a real inventory item), so they're included here
// too only for a uniform guarantee, not because the generic path was found lacking for them.
export function survivalPriorityItemSatisfied(name) {
  switch (name) {
    case "weapon": return hasWeapon(bot);
    case "shelter": return residencePlan().kind === "done";
    case "food": return hasFood();
    case "armor": return [5, 6, 7, 8].filter((slot) => bot.inventory.slots[slot]).length >= 4;
    case "tools": return !nextToolUpgrade();
    default: return true;
  }
}

// Real bug found live 2026-09-12 (direct report the fleet is "still not functional," traced
// through logs, not guessed): Amy self-proposed the IDENTICAL "go home and place a furnace
// there" directive every single cycle for 6+ hours straight, zero progress, because
// nextBuilderPriority() had no memory of past attempts -- a genuinely hard blocker (furnace
// needs cobblestone needs a pickaxe needs an uninterrupted stretch) just re-picked the same
// still-unmet item forever. Real, severe consequence, not just wasted cycles: beds (item #4)
// never even got ATTEMPTED, so nobody could sleep, and phantoms -- a real vanilla mechanic
// triggered by extended sleep deprivation -- swarmed the base (1473 threat-detections in 2
// hours, the single largest hostile category, more than every other mob combined), on top of
// ordinary dark-base zombie/spider/skeleton spawns from lighting also never landing
// (checkHomeLighting requires a claimed bed to run at all, and zero beds meant zero claims).
// New per-item stall counter: after BUILDER_ITEM_STALL_LIMIT consecutive cycles proposing the
// SAME still-unmet item, it's temporarily skipped in favor of the next unmet one -- so a hard
// blocker doesn't block strictly-easier later items (beds, chest) forever. Resets whenever a
// DIFFERENT item gets proposed, so a skipped item gets retried later, not abandoned outright.
const BUILDER_ITEM_STALL_LIMIT = 3;
let builderStallItem = null;
let builderStallCount = 0;

// Split from nextBuilderPriority() 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 -- "ownable by
// whichever bot is idle and able"): the pure "what's unmet" list, no stall-tracking or claiming,
// so proposeOwnGoal() can try every candidate in order (skipping ones another bot already holds
// a live claim on) instead of only ever seeing nextBuilderPriority()'s own single stall-aware
// pick.
export function builderPriorityCandidates() {
  const candidates = [];
  if (countUsableNearHome(["crafting_table"]) < 1) {
    candidates.push({ name: "crafting_table", directive: "go home and place a crafting table there" });
  }
  if (countUsableNearHome(["furnace"]) < 1) {
    candidates.push({ name: "furnace", directive: "go home and place a furnace there" });
  }
  if (countUsableNearHome(["chest"]) < 1) {
    candidates.push({ name: "chest", directive: "go home and place a chest there" });
  }
  // 2026-10-11: merged from two independent items ("beds": a bare count; "shelter":
  // hasShelterNearHome, the single nearest match) into one real check -- confirmed live the two
  // could both report satisfied with nine beds scattered in the open and one shelter nowhere near
  // most of them. countQualifyingSheltersNearHome() (above) counts actual qualifying structures
  // (complete, sealed, a bed inside); shelterCapacityNeeded() (below) has the target.
  if (shelterCapacityNeeded()) {
    candidates.push({ name: "shelter_capacity", directive: residenceDirective(residencePlan()) });
  }
  // Added 2026-09-11 ("nest" again -> "wire honey/wax into Builder's ... priority list"). Sits
  // AFTER the operator's original five (crafting table/furnace/chest/beds/shelter) rather than
  // among them -- a beehive is a nice-to-have sustainable resource, not core survival infra.
  if (countNearHome(["beehive"]) < 1) {
    candidates.push({ name: "beehive", directive: "craft a beehive (needs planks and honeycomb) and place it near home" });
  }
  // 2026-09-25: nothing ever asked for ranching. Last on the list: a pen near home with a breeding
  // pair, done for good once she has bred an animal (a verified achievement, never a claim).
  if (![...getAchievements(bot)].some((a) => a.startsWith("bred:"))) {
    candidates.push({ name: "ranch", directive: "set up a ranch near home: build an animal pen, lead two animals of one kind into it, and breed them" });
  }
  // Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a -- "once the fleet's
  // progression reaches iron tools or better... building one single communal shelter becomes a
  // Tier 2 goal, in addition to -- not instead of -- the individual shelters above"). Last on the
  // list by design: §3's own Builder priority order has it AFTER the rest of the checklist, not
  // blocking on every other item being 100% done first (the de-exclusive claim mechanism already
  // lets a different bot work an earlier item while this one waits its turn).
  if (fleetHasReachedIronTools() && !communalShelterSatisfied()) {
    const target = communalShelterTargetBeds();
    candidates.push({ name: "communal_shelter", directive: "lead the fleet's communal shelter near " +
      `home: a single larger shelter built entirely from stone-tier material or better (no planks ` +
      `or dirt), with real walls, a roof, a real door, and room for at least ${target} beds.` });
  }
  return candidates;
}

// 2026-11-04 (24h review): "We have 2, need at least 9" -- the target was the whole configured
// roster, online or not, and its runner (shelterStep) built HER OWN shelter, so a bot who already
// had one "completed" it on the spot and proposed it again: 209 false completions a day. Now the
// residence plan's own count: beds for the bots in the game, each in a residence with a chest.
function shelterCapacityNeeded() {
  return residencePlan().kind !== "done";
}

export function nextBuilderPriority(candidates = builderPriorityCandidates()) {
  if (!candidates.length) {
    builderStallItem = null;
    builderStallCount = 0;
    return null; // checklist complete -- proposeOwnGoal falls through to its normal freeform reasoning
  }

  const skip = builderStallCount > BUILDER_ITEM_STALL_LIMIT ? builderStallItem : null;
  const pick = candidates.find((c) => c.name !== skip) || candidates[0];

  if (pick.name === builderStallItem) builderStallCount++;
  else { builderStallItem = pick.name; builderStallCount = 1; }

  return pick;
}

// Real bug found live 2026-09-13 (direct report: bots "hallucinate their achievements"),
// confirmed with hard evidence: "craft a beehive ... and place it near home" was announced
// "goal complete" TWICE in the same 24h window, and EVERY builder-priority cycle before and
// after each claim still found zero beehives near home. Root cause: parseGoalStep's own DONE
// verification (2.43.0) checks whether the named item exists in inventory/equipped gear -- true
// the moment she CRAFTS a beehive, regardless of whether she ever actually walked home and
// placed it, since a crafted-but-unplaced item sits right there in her inventory satisfying that
// check. Reuses the exact same real-world checks nextBuilderPriority() itself already trusts,
// rather than a second, independently-drifting definition of "done" for these six items.
export function builderPriorityItemSatisfied(name) {
  switch (name) {
    case "crafting_table":
    case "furnace":
    case "chest":
      // Must stay in lockstep with builderPriorityCandidates()'s own check just above, or the
      // two diverge: a bot could see "furnace still needed" in the checklist while being told
      // "yes, done" right after placing a 2nd furnace next to a broken 1st one.
      return countUsableNearHome([name]) >= 1;
    case "beehive":
      return countNearHome([name]) >= 1;
    case "shelter_capacity":
      // 2026-10-11: replaces the old separate "beds"/"shelter" cases -- kept in lockstep with
      // builderPriorityCandidates() through the one shared shelterCapacityNeeded() (2026-11-04),
      // the same two-copies-of-the-same-number drift this function exists to prevent.
      return !shelterCapacityNeeded();
    case "communal_shelter":
      return communalShelterSatisfied();
    default:
      return true; // not one of the six known items -- nothing real to re-check, don't block
  }
}

// Direct request, 2026-09-13 ("soldier personas need to... prioritize a) getting a weapon...
// b) killing monsters c) secondary roles"). Mirrors nextBuilderPriority()'s own deterministic,
// world-checked-ahead-of-freeform shape (§15.6) instead of a third pattern -- a hostile either is
// or isn't within patrol range on any given tick, nothing here can get "stuck" the way Builder's
// multi-step blockers can, so no stall counter like Builder's either. Item (c), "secondary
// roles," needs no code of its own here: returning null falls straight through to
// proposeOwnGoal's normal freeform reasoning below, where roleBiasNote() already leans toward
// myRole.secondary.
//
// 2026-10-11 (PRIORITIES_PROPOSAL.md -- "Narrowed: weapon/armor move to Tier 1"): both checks
// this function used to run itself are gone. nextSurvivalPriority() (above), checked first for
// EVERY bot in proposeOwnGoal(), already intercepts an unarmed or under-armored Soldier before
// this function is ever reached -- keeping a second copy here would only risk the two drifting
// apart (a different threshold, a different retry timer) rather than add any real coverage.
const SOLDIER_PATROL_RANGE = 32; // wider than SELF_DEFENSE_RANGE -- a Soldier hunts, not just reacts

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md §2a -- "with one, she patrols near home,
// unchanged from today. With two or more, exactly one holds a claim to stay anchored near home
// at all times; every other Soldier's priority becomes escort/rescue instead."). "Still a live
// Soldier" reuses the SAME goal-heartbeat liveness signal goalHeartbeatTick's own peer-expiry
// already trusts (otherBotGoalSeenAt/GOAL_LEASE_MS), rather than inventing a second one: a
// Soldier's own ladder never returns null (always monster or guard/escort), so a genuinely
// running Soldier is never idle long enough for her own lease to go stale.
function isLiveSoldier(name) {
  if (name === USERNAME) return true; // herself -- trivially live if this code is even running
  if (BOT_ROLES[name.toLowerCase()]?.primary !== ROLES.SOLDIER) return false; // demoted/reassigned
  const seenAt = otherBotGoalSeenAt.get(`mc-${name.toLowerCase()}`);
  return seenAt !== undefined && Date.now() - seenAt <= GOAL_LEASE_MS;
}

function liveSoldierNames() {
  return [...BOT_USERNAMES].filter((name) => BOT_ROLES[name.toLowerCase()]?.primary === ROLES.SOLDIER && isLiveSoldier(name));
}

// One live Soldier: trivially the anchor, no claim contention at all -- today's unchanged
// single-guard behavior. Two or more: holdsGuardAnchor() (actions.js) arbitrates, same shared-
// claim shape as a bed claim, lower-sorted-name-wins on a genuine race.
async function isGuardAnchor() {
  if (liveSoldierNames().length <= 1) return true;
  return holdsGuardAnchor(bot, isLiveSoldier);
}

export async function nextSoldierPriority() {
  // FLEE_ONLY_MOBS excluded deliberately -- checkSelfDefense/respondToSquadCall's own established
  // fix already found that melee-attacking a flyer just hangs holding arbiter control for the
  // full ACTION_TIMEOUT_MS with no real chance of landing a hit; proactively picking one as a
  // self-propose target would walk straight into the same dead end.
  const threat = nearestHostile(bot, SOLDIER_PATROL_RANGE);
  if (threat && !FLEE_ONLY_MOBS.has(threat.name)) {
    return { name: "monster", directive: `hunt down and kill the nearby ${threat.name}.` };
  }
  // Direct report, 2026-09-15 ("look for behavioral gaps"): a real, confirmed live violation of
  // "Soldiers should not get tasks beyond equipping weapons and armor, and fighting off
  // monsters" -- Mark self-proposed "Secure Luke's flank -- craft a pickaxe" during a window
  // where both conditions above happened to be false (armed, nothing hostile in patrol range).
  // Returning null here, like Builder's own checklist does once its infrastructure is built,
  // was the bug: Builder graduates to unrestricted freeform once her one-time checklist is
  // done, but a Soldier's job was never meant to have a "checklist complete" state to graduate
  // out of (§21) -- standing guard is supposed to be ongoing, never "done." A Soldier-primary
  // bot now never reaches the unrestricted freeform path at all.
  if (await isGuardAnchor()) {
    return { name: "guard", directive: "stand guard near home and keep watch for anything hostile." };
  }
  // Not holding the anchor: the squad-response arbiter tier already preempts either goal equally
  // (SQUAD_RESPONSE outranks ROUTINE/GOAL_STEP regardless) -- what changes here is what she does
  // BETWEEN calls. Deliberately not a standing goal like "guard": she stays mobile, not anchored
  // to one spot, ready to move toward wherever she's actually needed. "Recover a teammate's
  // dropped gear" (the proposal's other half of escort/rescue) is NOT included here: the
  // existing RECOVERY/post-death logic only ever recovers the SAME bot's own death position, and
  // nothing today broadcasts one bot's death location to the rest of the fleet -- a real,
  // separate gap flagged for confirmation (not assumed) before promising it, not silently built.
  return { name: "escort", directive: "patrol more broadly rather than anchoring in one spot -- " +
    "stay ready to respond to a squad call or help a teammate before resuming your own patrol." };
}

