// Version: 1.0.1
//
// 1.0.1 (2026-11-11, direct report: "they are all showing a history of build successes. are those
// false positives?"): unfinishedShelterNearHome() no longer returns a shelter that is already
// complete. It accepted "missing at most 8" -- 0 included -- with a door, so once shelterStep
// cleared a goal's site for being a finished shelter, this handed the same finished residence
// (1, 96, 8) straight back: Amy, Bob and Dale each called "build" on it every ~2.7s, 0ms, ok:true
// ("already standing"), Amy for 1,242 steps, while no new shelter for the missing beds went up.
//
// 1.0.0 (2026-11-10) -- split out of index.js (2.143.0) unchanged: home scanning -- counting
// blocks near home, finding and judging shelters, and the residence plan (a bed and a chest per
// bot). Its own file, under the self-repair pipeline's 40000-char whole-file limit. Reads bot
// and BOT_USERNAMES back from index.js, only inside functions.

import { SHELTER_ROOM, doorwayPosition, isShelterDoor, isUtilityUsable, shelterPositions } from "./actions.js";
import { wouldBlockAccess } from "./shelter.js";
import { isDoorway } from "./swim-movements.js";
import { BOT_USERNAMES, bot } from "./index.js";

// Planning: runAction, the goal-step parser, planNextStep and goal-conflict arbitration: in planning.js (split out 2026-11-10).
// §15.6: Builder's own infrastructure priority ladder -- crafting table -> furnace -> chest ->
// 6+ beds -> shelter, the operator's own specified order, checked via real bot.findBlocks()/
// blockAt() world-state queries near bot.spawnPoint (the same "home" anchor gohome/
// teleportToSpawn already use, not any one bot's own claimed bed -- claiming a bed depends on a
// bed already existing, so this checklist is what gets the FIRST ones built). Same "check
// reality, don't trust a self-report" discipline TECH_TREE_STAGES' own mayorHasStageItem()
// already established for the fleet-wide curriculum, applied here to one role's own checklist.
export const BUILDER_PRIORITY_RADIUS = 24;

function blockIdsByName(names) {
  return names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
}

export function countNearHome(names, filterFn) {
  if (!bot.spawnPoint) return 0;
  const ids = blockIdsByName(names);
  if (!ids.length) return 0;
  const positions = bot.findBlocks({ point: bot.spawnPoint, matching: ids, maxDistance: BUILDER_PRIORITY_RADIUS, count: 64 });
  if (!filterFn) return positions.length;
  return positions.filter((pos) => filterFn(bot.blockAt(pos))).length;
}

// Real bug found live, 2026-10-27: crafting_table/furnace/chest used to count as "done" the
// moment one existed anywhere near home (countNearHome's own bare existence scan) -- never
// checked reachability or usability, and nothing ever re-opened the item once satisfied. Two
// real chests sat failing "No path to the goal!"/windowOpen timeouts for a full day while the
// checklist called chest storage done. isUtilityUsable() (actions.js) tracks real interaction
// outcomes from the smelt/craft/loot/store call sites that already exist -- this just plugs that
// into countNearHome's own existing (previously unused) filterFn parameter, the same way
// bedsNearHome already uses it. Only ever called with ONE name at a time (crafting_table,
// furnace, or chest individually) -- unlike countNearHome, which some callers use with a whole
// family of names (e.g. every *_bed variant) where "usability" of a single type wouldn't mean
// anything.
export function countUsableNearHome(names) {
  return countNearHome(names, (block) => isUtilityUsable(names[0], block.position));
}

// Mirrors (does not import -- a deliberate small duplication of pure position math, not worth a
// cross-module refactor for one caller) actions.js's own "build" case geometry: a 3x3 footprint,
// three walls tall, one doorway, a roof, a floor. Anchored at bot.spawnPoint since
// nextBuilderPriority()'s own "shelter" directive always sends her home first via ACTION GOHOME
// before ACTION BUILD, so a real attempt lands there.
// Real bug found 2026-09-11 (direct request "fix the shelter check"): this used to check ONLY
// bot.spawnPoint.floored() itself, but "gohome" (actions.js) walks to bot.spawnPoint via
// GoalNear(..., 3) -- a 3-block-radius goal, not the exact block -- so a shelter actually built
// right after "go home and build a small shelter there" (nextBuilderPriority's own directive) can
// legitimately sit up to 3 blocks off spawnPoint. The old fixed-anchor check would then almost
// always report "no shelter" even after a real, successful build, since it was checking the wrong
// 3x3 footprint. Now slides the candidate anchor across a small search radius (matching gohome's
// own tolerance plus a margin) and accepts the first one that passes.
// 2026-09-27: the shape now comes from actions.js (shelterPositions) -- one definition for what
// "build" builds and what this check accepts. The room must be 2x2 and clear two high (a bed in it
// still counts): a shelter that can't fit a bed isn't enough.
// Direct report, 2026-10-11 ("complete walls, ceiling, floor, and at least one door... no other
// openings... with at least one bed"): this used to accept 80% solid, which is not "complete" by
// any reading, and never checked for a door at all -- shelterPositions() left that whole column
// out of the fill, so a bare, permanent gap passed every time. Tightened to require every wall/
// roof/floor cell solid (100%, shelterPositions() now includes the floor too) AND a real door/gate
// at the doorway. A fourth, separate "no connection to a cave system" check was never needed: once
// every wall/roof/floor cell is solid and the one remaining opening holds a real door, there is no
// other gap left for a cave to connect through -- satisfied by construction, not a new scan.
export const shelterGeometryPositions = shelterPositions;

// 2026-11-04: a chest in the room is furniture too -- a residence has one (see residencePlan).
function hasHollowInterior(base) {
  return SHELTER_ROOM.every(([dx, dz]) => {
    const floor = bot.blockAt(base.offset(dx, 0, dz)), above = bot.blockAt(base.offset(dx, 1, dz));
    return (floor?.boundingBox !== "block" || bot.isABed(floor) || /^(trapped_)?chest$/.test(floor?.name ?? "")) &&
      above?.boundingBox !== "block";
  });
}

// Scans the same candidate grid hasShelterNearHome() always has, but returns the actual best
// match instead of a bare boolean: `complete: true` once a real, fully-sealed shelter exists (what
// callers that only care about "is there one" want), or `complete: false` with the base of the
// MOST complete hollow-interior-shaped candidate found, as long as it's already at least half
// solid -- a genuine, damaged (or half-built) shelter, not just an open-air pocket that happens to
// be the right shape (hasHollowInterior() alone never checks for walls at all, and a cleared,
// flat home site can easily have more than one open 2x2 pocket near it). Returns null only when
// nothing shelter-shaped and at-least-half-real exists here at all.
//
// 2026-10-22: no longer checkShelterIntegrity()'s own repair target -- that check now uses
// shelterRoomsNear()/holesIn() (shelter.js), shape- and count-agnostic, instead of this
// function's fixed small-room geometry. This function and hasShelterNearHome()/
// hasOwnShelterWithBed()/countQualifyingSheltersNearHome() below it still use that fixed
// geometry on purpose, for a different job: deciding whether the fleet has built enough
// qualifying shelters to progress, and where to site a brand-new one when none exists yet --
// both need a concrete shape to build towards, which repairing a shelter that already exists,
// whatever shape it turned out to be, does not.
// Horizontal only, not vertical: gohome's GoalNear(..., 3) tolerance is 3D, but Y-slop near a
// built-up home is usually just terrain-following, not meaningful horizontal wandering -- kept
// to one dimension deliberately, matching this codebase's "bounded, not unbounded" search
// philosophy rather than multiplying the already-real cost (81 candidate anchors x 30 blockAt
// calls each) by a third axis for a much smaller real-world benefit.
// 2026-10-27: rings outward the same way findShelterSite() (actions.js) now does, capped at
// BUILDER_PRIORITY_RADIUS rather than findShelterSite's own 48 -- this function backs
// hasShelterNearHome()/hasOwnShelterWithBed(), called from nextSurvivalPriority() on the hot
// fleet-wide tick path (not once per goal, cached, the way a site pick is), so it stays
// consistent with its own Tier-2 sibling countQualifyingSheltersNearHome(), which already scans
// the full BUILDER_PRIORITY_RADIUS. Real regression this closes: findShelterSite() widening alone
// would let a shelter get built beyond the old fixed 4-block window while this function stayed
// blind to it -- shelterStep() would then report the build itself ok:true (resetting
// consecutiveFailures) but done:false forever, a silent infinite loop with no escape, worse than
// the bounded give-up/re-propose churn that existed before any of this.
// 2026-10-28 (direct report: "they completed a few shelter buildings, but don't seem to realize
// they can place a bed"): that exact loop happened anyway -- capping detection at 24 while
// findShelterSite() searched to 48 left Babs' three finished shelters (~50 blocks out, doors at
// (41,70,-27), (21,70,-45), (39,71,-35)) invisible: 328 "the shelter is already standing" steps,
// each ok:true, never done. A full 48-ring block scan is far too slow for this hot path, but a
// COMPLETE shelter always has a door at doorwayPosition(base), so completeSheltersNearHome() finds
// doors first (findBlocks, palette-filtered -- cheap) and checks only the shelter each one would
// close, across findShelterSite's whole SHELTER_SITE_RADIUS. The ring scan stays only for the
// innermost "damaged, worth repairing" candidate, which has no door to anchor on.
export const SHELTER_SITE_RADIUS = 48;

export function completeSheltersNearHome() {
  if (!bot.spawnPoint) return [];
  const center = bot.spawnPoint.floored();
  // findBlocks' maxDistance is a sphere; the site search is a square, so reach its corners and
  // trim back to the square below.
  // 2026-10-30: isShelterDoor, not isDoorway -- a door set the wrong way round blocks the way in,
  // so that shelter isn't complete; unfinishedShelterNearHome() hands it to "build", which resets it.
  const doors = bot.findBlocks({ point: center, matching: (block) => isShelterDoor(block),
    maxDistance: Math.ceil(SHELTER_SITE_RADIUS * Math.SQRT2) + 3, count: 128 });
  return doors.map((door) => door.offset(0, 0, -3)).filter((base) =>
    Math.abs(base.x - center.x) <= SHELTER_SITE_RADIUS && Math.abs(base.z - center.z) <= SHELTER_SITE_RADIUS &&
    Math.abs(base.y - center.y) <= SHELTER_SITE_RADIUS && hasHollowInterior(base) &&
    shelterGeometryPositions(base).every((pos) => bot.blockAt(pos)?.boundingBox === "block"));
}

export const shelterHasBed = (base) => SHELTER_ROOM.some(([dx, dz]) => bot.isABed(bot.blockAt(base.offset(dx, 0, dz))));

// hasHollowInterior() alone isn't enough to call something "shelter-shaped": it only checks the
// room's own 4 cells, nothing about walls ever having existed, so an ordinary open-air pocket
// (plausible near a cleared home site) would match it too. Only worth returning as a repair
// target once it's ALSO already mostly a real structure -- at least half its wall/roof/floor
// cells genuinely solid -- the same real/coincidental distinction the old 80% tolerance was
// trying to draw, just now gating "is this worth repairing" instead of "does this count as done."
const DAMAGED_SOLID_FLOOR = 0.5;

// trackDamaged is only ever true for the innermost ring: a half-built "repair this" candidate is
// only meaningful right at home, not something picked up 16-24 blocks out purely because a wider
// ring happened to scan past it (2026-09-26's own "also 2 blocks above/below spawn height" fix
// was about terrain-following near home, not about finding distant rubble to repair).
function scanShelterRing(center, radius, trackDamaged) {
  let damaged = null, damagedSolid = -1;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const base = center.offset(dx, dy, dz);
        if (!hasHollowInterior(base)) continue; // not shelter-shaped here at all
        const positions = shelterGeometryPositions(base);
        const solid = positions.filter((pos) => bot.blockAt(pos)?.boundingBox === "block").length;
        const hasDoor = isShelterDoor(bot.blockAt(doorwayPosition(base)));
        if (solid === positions.length && hasDoor) return { base, complete: true };
        // Keep the MOST complete candidate seen, not just the first -- a real damaged shelter
        // should outrank a coincidental half-empty pocket scanned earlier purely by iteration
        // order.
        if (trackDamaged && solid >= positions.length * DAMAGED_SOLID_FLOOR && solid > damagedSolid) {
          damaged = base;
          damagedSolid = solid;
        }
      }
    }
  }
  return damaged ? { base: damaged, complete: false } : null;
}

export function findShelterNearHome() {
  if (!bot.spawnPoint) return null;
  const center = bot.spawnPoint.floored();
  // A damaged (incomplete) match from the innermost ring must NOT stop the search -- a real bug
  // this exact fix would otherwise introduce: a half-built structure sitting right at home would
  // make this return early as "found, but not complete," so a genuinely complete shelter built
  // farther out (exactly the crowded-base scenario this widening exists for) would never even be
  // looked for. Only a complete match short-circuits; a damaged one is remembered as a fallback
  // and the search keeps widening, since a real shelter somewhere is always worth more than a
  // repair candidate.
  // 2026-10-28: complete shelters come from completeSheltersNearHome() (nearest first) -- a bedded
  // one wins over an empty one, so a bot with a bed already in one shelter isn't sent to another.
  const complete = completeSheltersNearHome();
  const best = complete.find(shelterHasBed) ?? complete[0];
  if (best) return { base: best, complete: true };
  return scanShelterRing(center, 4, true);
}

function hasShelterNearHome() {
  return findShelterNearHome()?.complete === true;
}

// 2026-10-28 (direct report: "there are no doors or beds, but she built two"): a shell with all
// its walls/roof/floor but no door is invisible to completeSheltersNearHome() (it anchors on the
// door), so once a shelter goal gave up, the next one picked a fresh site and built a second
// shell. Nearest shell within SHELTER_SITE_RADIUS whose doorway is still open (or holds a door)
// and is missing at most UNFINISHED_SHELL_MAX_MISSING blocks -- the build fills those. Only run
// once per shelter goal (shelterStep caches its pick in goal.shelterAt), never on the hot tick
// path; the missing-count bail keeps open air to a handful of block lookups per base.
const UNFINISHED_SHELL_MAX_MISSING = 8;

export function unfinishedShelterNearHome() {
  if (!bot.spawnPoint) return null;
  const center = bot.spawnPoint.floored();
  let best = null, bestDist = Infinity;
  for (let dx = -SHELTER_SITE_RADIUS; dx <= SHELTER_SITE_RADIUS; dx++) {
    for (let dz = -SHELTER_SITE_RADIUS; dz <= SHELTER_SITE_RADIUS; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const dist = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
        if (dist >= bestDist) continue;
        const base = center.offset(dx, dy, dz);
        if (!hasHollowInterior(base)) continue;
        const door = bot.blockAt(doorwayPosition(base));
        if (door?.boundingBox === "block" && !isDoorway(door)) continue;
        let missing = 0;
        for (const pos of shelterGeometryPositions(base)) {
          if (bot.blockAt(pos)?.boundingBox !== "block" && ++missing > UNFINISHED_SHELL_MAX_MISSING) break;
        }
        // Complete (nothing missing, a door the right way round) is finished, not unfinished.
        if (missing === 0 && isShelterDoor(door)) continue;
        if (missing <= UNFINISHED_SHELL_MAX_MISSING) { best = base; bestDist = dist; }
      }
    }
  }
  return best;
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 1 item 2): "her own qualifying shelter,
// with a bed in it" is a materially stronger claim than hasShelterNearHome() and the fleet's own
// bed count checked separately -- confirmed live, the two are fully independent, so the fleet can
// report both satisfied with nine beds scattered in the open and one shelter nowhere near most of
// them. This is the real per-bot check: a complete shelter (same definition as hasShelterNearHome)
// AND a bed actually standing in one of its own room cells.
function hasOwnShelterWithBed() {
  return completeSheltersNearHome().some(shelterHasBed);
}

// ---- residences (2026-11-04, direct request) -----------------------------------------------------
// Replaces "every bot builds her own individual shelter": "a residence should consist of a bed, a
// chest, at least one door, and enclosed walls/ceiling/floor ... a bed is needed for each resident
// that is ACTIVE. 4 active bots means 4 beds ... if enough beds are not present, make and place a new
// one in existing shelter (if room); if not enough room in existing shelters, start a new shelter."
// A complete shelter (completeSheltersNearHome: every wall/roof/floor cell solid, a real door) is a
// residence once it holds a bed and a chest. The 2x3 room fits one bed and one chest -- with a bed
// in each column the chest would cut one of them off (fixtureBlockedBy's "last way up") -- so a
// shelter has room for a bed while it has none. Order of work, fleet-wide and the same for every
// bot: a bedded shelter's missing chest first (finishing a residence beats starting one), then beds
// for the active bots, in an empty shelter first, else a new shelter.
function activeBotCount() {
  const online = new Set(Object.keys(bot.players ?? {}).map((name) => name.toLowerCase()));
  return Math.max(1, [...BOT_USERNAMES].filter((name) => online.has(name.toLowerCase())).length);
}

const CHEST_NAME = /^(trapped_)?chest$/;
const shelterBedCount = (base) =>
  Math.ceil(SHELTER_ROOM.filter(([dx, dz]) => bot.isABed(bot.blockAt(base.offset(dx, 0, dz)))).length / 2);
const shelterHasChest = (base) => SHELTER_ROOM.some(([dx, dz]) => CHEST_NAME.test(bot.blockAt(base.offset(dx, 0, dz))?.name ?? ""));

// The room cell a chest can go in: free floor, not the door's way through, and not the last way
// in to a bed (wouldBlockAccess). 2026-11-05: a shelter with a bed in each column has none -- the
// only free cell is one bed's last approach -- and every bot asked for a chest there, refused
// every time (1,500 refusals each in a few hours), with all lower work blocked behind it.
export function residenceChestCell(base) {
  const doorRow = base.offset(0, 0, 2);
  return SHELTER_ROOM.map(([dx, dz]) => base.offset(dx, 0, dz)).find((p) => !p.equals(doorRow) &&
    bot.blockAt(p)?.boundingBox !== "block" && !bot.isABed(bot.blockAt(p)) && !wouldBlockAccess(bot, p, "chest")) ?? null;
}

export function residencePlan() {
  const shelters = completeSheltersNearHome();
  const active = activeBotCount();
  const beds = shelters.reduce((n, base) => n + shelterBedCount(base), 0);
  // A shelter with no room for a chest (two beds) is a full residence as it stands.
  const chestless = shelters.find((base) => shelterHasBed(base) && !shelterHasChest(base) && residenceChestCell(base));
  if (chestless) return { kind: "chest", base: chestless, beds, active };
  if (beds >= active) return { kind: "done", beds, active };
  const empty = shelters.find((base) => !shelterHasBed(base));
  return empty ? { kind: "bed", base: empty, beds, active } : { kind: "build", beds, active };
}

export function residenceDirective(plan) {
  const tally = `our residences have ${plan.beds} bed${plan.beds === 1 ? "" : "s"} for ${plan.active} ` +
    `active bot${plan.active === 1 ? "" : "s"}`;
  if (plan.kind === "chest") return "a residence near home has a bed but no chest -- make a chest and put it inside that shelter.";
  if (plan.kind === "bed") return `${tally} -- make a bed and place it in the empty shelter near home.`;
  return `${tally} and no shelter has room for another -- build a new shelter near home: a small ` +
    "sealed room with complete walls, a roof, a floor and a real door, then a bed and a chest inside.";
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1 -- "today's separate 'beds'
// and 'shelter' checklist items merge into one, because satisfying them independently doesn't
// actually get anyone a safe place to sleep"). Confirmed live: builderPriorityItemSatisfied's old
// "beds" (a bare count) and "shelter" (hasShelterNearHome, a single nearest match) items are
// fully independent -- nine beds scattered in the open and one small shelter nowhere near most of
// them could report both satisfied. This counts actual qualifying structures (100% solid walls/
// roof/floor, a real door, a bed inside) near home, same BUILDER_PRIORITY_RADIUS "near home"
// every other Tier 2 item already uses -- wider than findShelterNearHome's own +/-4, since this
// needs room for up to BOT_USERNAMES.size separate structures, not just the nearest one.
//
// Real shelters can't physically overlap (you can't wall over another shelter's own walls), so in
// practice a shifted candidate base whose "room" clips a real wall just fails the hollow-interior
// gate on its own. The `claimed` set below is a cheap extra safety net against double-counting,
// not load-bearing for the common case.
function countQualifyingSheltersNearHome() {
  if (!bot.spawnPoint) return 0;
  const center = bot.spawnPoint.floored();
  const claimed = new Set();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  let count = 0;
  for (let dx = -BUILDER_PRIORITY_RADIUS; dx <= BUILDER_PRIORITY_RADIUS; dx++) {
    for (let dz = -BUILDER_PRIORITY_RADIUS; dz <= BUILDER_PRIORITY_RADIUS; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const base = center.offset(dx, dy, dz);
        if (claimed.has(key(base)) || !hasHollowInterior(base)) continue;
        const positions = shelterGeometryPositions(base);
        if (positions.some((pos) => claimed.has(key(pos)))) continue;
        const solid = positions.filter((pos) => bot.blockAt(pos)?.boundingBox === "block").length;
        if (solid !== positions.length) continue;
        if (!isShelterDoor(bot.blockAt(doorwayPosition(base)))) continue;
        const bedCells = SHELTER_ROOM.map(([rx, rz]) => base.offset(rx, 0, rz));
        if (!bedCells.some((p) => bot.isABed(bot.blockAt(p)))) continue;
        count++;
        for (const pos of [...positions, ...bedCells]) claimed.add(key(pos));
      }
    }
  }
  return count;
}

