// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of index.js (2.145.0) unchanged: living space, access obstructions, torch supply, terrain repair, shelter integrity and stuck detection.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. index.js imports
// it; this file reads index.js's state through live imports, so nothing here may touch it
// before index.js has run (only declarations live here).

import { isProtectedBlockName, performAction } from "./actions.js";
import * as arbiter from "./arbiter.js";
import { clearGoal, saveStuckState } from "./goals.js";
import { ACCESS_SCAN_RADIUS, findAccessObstructions, shelterRoomsNear } from "./shelter.js";
import { TORCH_CARRY_MIN, needsTorches, torchCount } from "./tunneling.js";
import { ROLES } from "./roles.js";
import { Vec3 } from "vec3";
import { broadcastGoalState, recordGoalOutcome } from "./fleet-coordination.js";
import { routineBlocked } from "./goal-proposal.js";
import { heldCount } from "./goal-runners.js";
import { AUTONOMY_ENABLED, PERSONA_NAME, USERNAME, bot, currentGoal, currentSameSpotCount, lastMoveAttemptAt, myRole, setCurrentGoal } from "./index.js";


// Direct request, 2026-10-07 ("recognize walls around living spaces (defined as places where beds
// are maintained)"). shelter.js does the recognising; this decides how often. Deliberately a
// timer and not a per-query answer: SwimMovements.safeToBreak() consults the result thousands of
// times per path search, so it has to already be a Set by then (see shelter.js's own note). The
// scan is a bounded flood fill (SHELL_MAX_CELLS) from every bed in sight plus spawn, so its cost
// does not grow with how long the fleet has been building. Synchronous on purpose -- there is no
// await in it, and a half-updated shell read by a path search in between would be worse than a
// slightly stale one.
// The scan reruns every 30s but is only reported when the answer changed, or every ten minutes
// regardless -- nine bots logging an unchanged shell every half minute is 26k journal lines a day
// for no information. The periodic line is what keeps the baseline's living_spaces_recognised
// ratio honest: a bot that finds nothing still says so, so "0 interior cells" is visible rather
// than silent, which is how this fleet's lighting gate stayed broken for days.
export const LIVING_SPACE_REFRESH_MS = parseInt(process.env.MC_LIVING_SPACE_REFRESH_MS || "30000", 10);
export const LIVING_SPACE_REPORT_MS = 10 * 60_000;

// Direct request, 2026-10-07 ("allow them to destroy a block that impedes access to a bed or
// chest or door"). The refusals in actions.js keep a bot from creating the condition; nothing
// undoes one that already exists, and the fleet's base has had chests pre-stocked by hand
// (tools/minecraft-chests/) and pits filled by repair_terrain for weeks before this rule landed.
// Same shape as checkTerrainDamage below: a cheap local scan first so a clean base never acquires
// the arbiter, then the real verb with what the scan already found.
export const ACCESS_CHECK_MS = parseInt(process.env.MC_ACCESS_CHECK_MS || "90000", 10);

export async function checkAccessObstructions() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkAccessObstructions") || bot.isSleeping || !bot.entity) return;
  const blocked = findAccessObstructions(bot, bot.entity.position, ACCESS_SCAN_RADIUS,
                                          (name) => !isProtectedBlockName(name));
  if (!blocked.length) return;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const result = await performAction(bot, { type: "clear_access", targets: blocked }, USERNAME, handle);
    console.log(`[${USERNAME}] access check: ${result.text} (ok=${result.ok})`);
  } catch (err) {
    console.error(`[${USERNAME}] access check failed:`, err.message);
  } finally {
    handle.release();
  }
}

// Direct request, 2026-10-07 ("carry torches when tunneling"). tunneling.js places the trail; this
// is what keeps there being something to place. Crafting is tried before a chest, which is the
// reverse of checkHomeLighting's order and deliberately so: that check runs at a dark base where
// a chest is a few steps away, this one has to work with a bot already underground, where a trip
// back up costs the whole point of carrying torches in the first place. Coal and a wood source
// are both common in a miner's inventory, and craft's own auto-chain turns a log into the stick
// (the 2026-09-21 root cause: this gate used to demand an already-made stick, which nothing
// keeps). A long backoff on failure, because checkHomeLighting's own history is a string of
// incidents caused by nine bots retrying the same impossible torch attempt every 90 seconds.
export const TORCH_SUPPLY_CHECK_MS = parseInt(process.env.MC_TORCH_SUPPLY_CHECK_MS || "120000", 10);
const TORCH_SUPPLY_BACKOFF_MS = 10 * 60_000;
let torchSupplyBlockedUntil = 0;

// Up to 16 torches, but never more than her coal makes (4 per piece): craft counts are items
// wanted (actions.js 1.98.0), and asking for more than she can afford fails the whole craft.
export const torchBatch = () => 4 * Math.max(1, Math.min(4, heldCount((n) => n === "coal" || n === "charcoal")));

export async function checkTorchSupply() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkTorchSupply") || bot.isSleeping || !bot.entity) return;
  if (Date.now() < torchSupplyBlockedUntil || !needsTorches(bot)) return;

  const fuel = bot.inventory.items().some((i) => i.name === "coal" || i.name === "charcoal");
  const wood = bot.inventory.items().some((i) => i.name === "stick" || i.name.endsWith("_planks") ||
    i.name.endsWith("_log") || i.name.endsWith("_stem"));

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const action = fuel && wood ? { type: "craft", item: "torch", count: torchBatch() }
      : { type: "loot", item: "torch", count: TORCH_CARRY_MIN };
    const result = await performAction(bot, action, USERNAME, handle);
    console.log(`[${USERNAME}] torch supply: ${action.type} -- ${result.text} ` +
      `(ok=${result.ok}, carrying ${torchCount(bot)}/${TORCH_CARRY_MIN})`);
    if (!result.ok && !result.cancelled) {
      torchSupplyBlockedUntil = Date.now() + TORCH_SUPPLY_BACKOFF_MS;
      console.log(`[${USERNAME}] torch supply: nothing worked -- waiting ${TORCH_SUPPLY_BACKOFF_MS}ms before trying again.`);
    }
  } catch (err) {
    console.error(`[${USERNAME}] torch supply check failed:`, err.message);
  } finally {
    handle.release();
  }
}

// §15.10: Builder/Artist terrain-repair duty. Deliberately scoped tight (design doc's own [RISK]
// note on false positives -- filling in an intentional feature like a mine entrance or a
// foundation dug for tomorrow's build): only ever scans within TERRAIN_REPAIR_RADIUS of
// bot.spawnPoint, never anywhere else, and only flags a column within a bounded depth band --
// shallower than TERRAIN_REPAIR_MIN_DEPTH isn't worth a trip, deeper than TERRAIN_REPAIR_MAX_DEPTH
// looks deliberately dug (a vertical shaft), not incidental damage.
const TERRAIN_REPAIR_RADIUS = 10;
const TERRAIN_REPAIR_GRID_STEP = 2;
const TERRAIN_REPAIR_MIN_DEPTH = 2;
const TERRAIN_REPAIR_MAX_DEPTH = 4;
export const TERRAIN_REPAIR_CHECK_MS = parseInt(process.env.MC_TERRAIN_REPAIR_CHECK_MS || "300000", 10); // 5 min

// Topmost solid block in this column, scanning down from a fixed height above aroundY -- the
// same "scan down to find the real surface" shape checkStuck/findPlantableSpotNear-style checks
// elsewhere in this codebase already use, just walked here rather than via findBlocks() since a
// per-column scan (not a matching-block search) is what a surface-height comparison needs.
function surfaceY(x, z, aroundY) {
  for (let y = aroundY + 8; y >= aroundY - 12; y--) {
    if (bot.blockAt(new Vec3(x, y, z))?.boundingBox === "block") return y;
  }
  return null;
}

function findTerrainDamage() {
  if (!bot.spawnPoint) return null;
  const cx = Math.floor(bot.spawnPoint.x);
  const cz = Math.floor(bot.spawnPoint.z);
  const cy = bot.spawnPoint.y;
  const columns = [];
  for (let dx = -TERRAIN_REPAIR_RADIUS; dx <= TERRAIN_REPAIR_RADIUS; dx += TERRAIN_REPAIR_GRID_STEP) {
    for (let dz = -TERRAIN_REPAIR_RADIUS; dz <= TERRAIN_REPAIR_RADIUS; dz += TERRAIN_REPAIR_GRID_STEP) {
      const x = cx + dx, z = cz + dz;
      const y = surfaceY(x, z, cy);
      if (y !== null) columns.push({ x, z, y });
    }
  }
  for (const col of columns) {
    const neighbors = columns.filter((c) => c !== col &&
      Math.abs(c.x - col.x) <= TERRAIN_REPAIR_GRID_STEP * 2 && Math.abs(c.z - col.z) <= TERRAIN_REPAIR_GRID_STEP * 2);
    if (neighbors.length < 2) continue; // not enough context around this one to judge it
    const avgY = Math.round(neighbors.reduce((sum, c) => sum + c.y, 0) / neighbors.length);
    const depth = avgY - col.y;
    if (depth >= TERRAIN_REPAIR_MIN_DEPTH && depth <= TERRAIN_REPAIR_MAX_DEPTH) {
      return { x: col.x, y: col.y + 1, z: col.z, targetY: avgY };
    }
  }
  return null;
}

// §15.10's "guided by function" override: if plantable ground (grass_block/dirt -- the exact set
// actions.js's own plant_sapling case already treats as soil via its groundIds check, reused here
// rather than a second definition) borders the pit, force "dirt" regardless of what the majority
// neighbor material actually is, so a later planting attempt there doesn't fail for a reason
// repair itself could have prevented. Returns null (no override) when nothing plantable borders
// it -- actions.js's own "repair_terrain" case then samples the neighborhood itself.
function terrainRepairMaterial(spot) {
  const rimOffsets = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                       [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]];
  const plantableNearby = rimOffsets.some(([dx, , dz]) => {
    const block = bot.blockAt(new Vec3(spot.x + dx, spot.y - 1, spot.z + dz));
    return block && (block.name === "grass_block" || block.name === "dirt");
  });
  return plantableNearby ? "dirt" : null;
}

function hasTerrainRepairRole() {
  return myRole?.primary === ROLES.BUILDER || myRole?.secondary === ROLES.BUILDER ||
    myRole?.primary === ROLES.ARTIST || myRole?.secondary === ROLES.ARTIST;
}

export async function checkTerrainDamage() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkTerrainDamage") || !hasTerrainRepairRole()) return;
  const spot = findTerrainDamage();
  if (!spot) return;
  const material = terrainRepairMaterial(spot);

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note (checkHomeLighting
  // follows the same convention just above).
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const result = await performAction(bot, { type: "repair_terrain", position: spot, material }, USERNAME, handle);
    console.log(`[${USERNAME}] terrain repair: ${result.text} (ok=${result.ok})`);
  } catch (err) {
    console.error(`[${USERNAME}] terrain repair check failed:`, err.message);
  } finally {
    handle.release();
  }
}

// Direct report, 2026-10-11 ("if a shelter gets damaged, violating its integrity..., repairing it
// becomes a temporary top priority"), generalized 2026-10-22 (direct request, after a separate
// report -- "there is a large shelter with many beds, but it has holes or missing parts. They
// are not repairing it as a large structure" -- found the first version of this fix only ever
// covered ONE shelter at a time, via two separate hand-coded geometries): nothing before the
// 2026-10-11 fix ever re-checked a shelter after it was first built, and this stage's own first
// pass still missed two things the operator then named directly -- any number of individual
// shelters, not just the nearest one, and a larger shelter of any shape, not just the two
// fixed-rectangle geometries "build"/"build_communal_shelter" know how to construct from
// scratch. shelterRoomsNear() (shelter.js) now finds every qualifying room near home in one pass,
// any count, any shape -- "contiguous walls, roof and floor, broken only by doors" -- tolerant of
// real damage, and reports each one's own specific hole positions directly rather than relying on
// a predetermined position list. ROUTINE tier, same as every other self-healing infrastructure
// check (checkTerrainDamage, checkAccessObstructions) -- real urgency against a role goal/
// self-propose (Tier 1, not yet built) comes from ordering, not from outranking combat or
// anything else in the arbiter. One damaged room is repaired per tick (the first found); a fleet
// with several damaged at once catches up over a few ticks rather than holding control for all of
// them at once.
export const SHELTER_INTEGRITY_CHECK_MS = parseInt(process.env.MC_SHELTER_INTEGRITY_CHECK_MS || "60000", 10);

export async function checkShelterIntegrity() {
  if (!AUTONOMY_ENABLED || routineBlocked("checkShelterIntegrity") || !bot.spawnPoint) return;
  const damaged = shelterRoomsNear(bot, bot.spawnPoint).find((room) => room.holes.size > 0);
  if (!damaged) return;

  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE);
  if (!handle) return;
  try {
    const holes = [...damaged.holes].map((key) => {
      const [x, y, z] = key.split(",").map(Number);
      return { x, y, z };
    });
    const result = await performAction(bot, { type: "patch_shelter", holes }, USERNAME, handle);
    console.log(`[${USERNAME}] shelter integrity repair: ${result.text} (ok=${result.ok})`);
  } catch (err) {
    console.error(`[${USERNAME}] shelter integrity check failed:`, err.message);
  } finally {
    handle.release();
  }
}

// Direct request, 2026-09-07 ("what else can we add" -> stuck-detection): robustness, not new
// capability -- a periodic check for "hasn't moved at all in a long time," regardless of
// busy/acting (deliberately NOT gated the same way as everything else: the whole point is to
// catch a bot that's wedged mid-action, and a jump doesn't cancel or conflict with whatever's
// actually running, unlike every other check here). A long threshold (5 minutes of literally
// zero movement) rather than a short one -- she can legitimately stand still for a while
// (idle, waiting to self-propose; sleeping; crafting/trading/enchanting at a fixed spot), and a
// jump nudge is harmless even in a false-positive case, so there's no need to be clever about
// distinguishing "genuinely idle" from "actually stuck," just patient about the threshold.
export const STUCK_CHECK_MS = parseInt(process.env.MC_STUCK_CHECK_MS || "30000", 10);
const STUCK_THRESHOLD_MS = 5 * 60_000;
// Direct request, 2026-09-07 ("if a bot gets stuck, there needs to be a mechanism to teleport it
// back to its spawn point rather than continually restart that bot"): a jump nudge handles the
// common minor snag, but does nothing for a bot genuinely wedged (fallen into an inaccessible
// pocket, glitched into a block). MAX_STUCK_NUDGES consecutive zero-movement cycles despite
// nudging (10 minutes total, on top of the first 5 before nudging even starts) escalates to a
// real teleport rather than nudging forever.
const MAX_STUCK_NUDGES = parseInt(process.env.MC_MAX_STUCK_NUDGES || "2", 10);
// How close a fresh spawn's position has to be to the last saved one to count as "reconnected
// into the same spot," and how many such consecutive reconnects (via bot.once("spawn") below)
// before teleporting home immediately rather than waiting for checkStuck's own in-process timer.
export const RESTART_STUCK_RADIUS = parseInt(process.env.MC_RESTART_STUCK_RADIUS || "3", 10);
export const RESTART_STUCK_THRESHOLD = parseInt(process.env.MC_RESTART_STUCK_THRESHOLD || "2", 10);

let lastPosition = null;
let lastMovedAt = Date.now();
let stuckNudgeCount = 0;

// bot.spawnPoint (confirmed against mineflayer's own spawn_point.js source: populated from the
// server's own spawn_position packet -- the same coordinate the vanilla compass points to, her
// bed if she's claimed one, otherwise the world spawn) is used as the teleport target rather
// than her own physical position, specifically because it's NOT corrupted by whatever bad spot
// she's currently wedged in. Requires /tp permission -- Babs/Amy/Mark/Luke were added to
// ops.json at level 2 (command access, not full admin) for exactly this.
const TELEPORT_SAFE_RANGE = 4;

export async function teleportToSpawn(reason) {
  const dest = bot.spawnPoint;
  if (!dest || (dest.x === 0 && dest.y === 0 && dest.z === 0)) {
    console.error(`[${USERNAME}] can't teleport home -- no real spawn point known yet`);
    return;
  }
  console.log(`[${USERNAME}] TELEPORT: ${reason} -- heading back to spawn ${dest}`);
  // Coherence arbiter Phase 3 (2026-09-10): OWNERS.TELEPORT_HOME sits above every other tier and
  // is cancel-only -- never acquire-and-hold (see arbiter.js's own OWNERS comment on why: a
  // genuinely wedged bot can't perform ANY physical action anyway, so nothing is lost by not
  // holding control afterward). cancelAndRotate() is the same unconditional physical-interrupt
  // primitive actions.js's own stopCurrent() delegates to -- whatever she's doing physically is
  // about to be invalidated by teleporting, so stop it cleanly first rather than leaving it to
  // dangle, and always wins regardless of who currently holds control.
  // Review MB-03, 2026-09-24: cancelAndRotate() left a ROUTINE owner behind that nothing ever
  // released, freezing goals and chores after every rescue; cancelAndClear() leaves no owner.
  arbiter.cancelAndClear(bot);
  // 2026-09-25: "/tp <spawn block corner>" suffocated bots in the shelter walls built around the
  // world spawn (server log: every post-teleport death was "suffocated in a wall"). /spreadplayers
  // makes the server pick a safe standing spot on the surface within a few blocks instead.
  bot.chat(`/spreadplayers ${(dest.x + 0.5).toFixed(1)} ${(dest.z + 0.5).toFixed(1)} 0 ${TELEPORT_SAFE_RANGE} false ${USERNAME}`);
  // Whatever her standing goal assumed about her surroundings is now stale, same reasoning as
  // death/respawn.
  if (currentGoal) {
    await broadcastGoalState("abandoned", currentGoal.description);
    recordGoalOutcome(currentGoal.description, "gave up", "stuck");
    setCurrentGoal(null);
    await clearGoal(PERSONA_NAME);
  }
}

export function checkStuck() {
  if (!AUTONOMY_ENABLED || bot.isSleeping || !bot.entity) return;
  const pos = bot.entity.position;
  // Kept fresh on every tick (not just while possibly-stuck) so that IF this process goes down
  // for any reason, the next spawn's own cross-restart check (bot.once("spawn") below) is
  // comparing against somewhere close to where she actually was, not a stale position from
  // hours ago or the very start of this session.
  saveStuckState(PERSONA_NAME, { x: pos.x, y: pos.y, z: pos.z, sameSpotCount: currentSameSpotCount })
    .catch((err) => console.error(`[${USERNAME}] stuck-state save failed:`, err.message));
  if (!lastPosition || pos.distanceTo(lastPosition) > 0.1) {
    lastPosition = pos.clone();
    lastMovedAt = Date.now();
    stuckNudgeCount = 0; // real movement happened -- whatever the snag was, it's resolved
    return;
  }
  // Review MB-22, 2026-09-24: standing still is only "stuck" if something is actually trying to
  // move her. A guard, an idle bot, or a stationary interaction never touches pathfinder, so it
  // restarts the clock instead of escalating toward a false-rescue teleport.
  if (lastMoveAttemptAt < lastMovedAt) {
    lastMovedAt = Date.now();
    stuckNudgeCount = 0;
    return;
  }
  const stationaryMs = Date.now() - lastMovedAt;
  if (stationaryMs < STUCK_THRESHOLD_MS) return;

  stuckNudgeCount += 1;
  lastMovedAt = Date.now(); // reset so this doesn't spam-nudge/escalate every 30s while still stuck

  if (stuckNudgeCount > MAX_STUCK_NUDGES) {
    stuckNudgeCount = 0;
    teleportToSpawn(`no movement for ${MAX_STUCK_NUDGES + 1} consecutive checks despite nudging`)
      .catch((err) => console.error(`[${USERNAME}] teleport-home failed:`, err.message));
    return;
  }

  console.log(`[${USERNAME}] possibly stuck -- no movement in ` +
              `${Math.round(stationaryMs / 1000)}s, nudging (${stuckNudgeCount}/${MAX_STUCK_NUDGES})`);
  nudgeUnstuck().catch((err) => console.error(`[${USERNAME}] stuck nudge failed:`, err.message));
}

// Review MB-22 follow-up (2026-09-24): the jump nudge used to write control state outside the
// arbiter. It now helps whoever is trying to move her (only fires while pathfinder is active, see
// checkStuck), or, if nobody holds control, takes a brief ROUTINE turn of its own.
async function nudgeUnstuck() {
  const handle = arbiter.isBusy() ? null : await arbiter.requestControl(bot, arbiter.OWNERS.ROUTINE, { waitMs: 0 });
  if (!handle && !arbiter.isBusy()) return;
  bot.setControlState("jump", true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  bot.setControlState("jump", false);
  handle?.release();
}
