// Version: 1.0.0
//
// Reactive behavior, ported from kolbytn/mindcraft's src/agent/modes.js. Each mode reacts
// immediately to world state between planned actions. Ported: self_preservation, self_defense,
// cowardice, hunting, item_collecting, torch_placing. Deliberately NOT ported: unstuck
// (pathfinding.js/swim-movements.js already carry a thoroughly-debugged fix for bots freezing on
// land/in water -- a generic "move away and hope" fallback would fight that, not complement it),
// elbow_room/idle_staring (cosmetic only), cheat (debug-only noclip/fly, not applicable here).
//
// Mindcraft's self_defense/cowardice are two SEPARATE, normally-exclusive modes (fight vs. flee a
// nearby hostile), not one combined mode -- its own default profile ships self_defense:true,
// cowardice:false. Ported faithfully as two modes rather than merged into one; which one a given
// persona runs is a per-profile call for whoever wires modes into index.js, not decided here.
//
// Mindcraft's own modes.js calls into its action_manager/Agent class for interruption and
// "is anything already running" bookkeeping. This project has no such class -- replaced with
// services/minecraft-bots/arbiter.js's tiered control (requestControl/releaseControl/OWNERS),
// matched to the tier it was actually built for: self_defense/cowardice (reacting to a hostile)
// use OWNERS.SELF_DEFENSE; the fire/lava/low-health branches of self_preservation use
// OWNERS.HEALTH_CRITICAL (arbiter.js's own comment: "a near-fatal hit already landed -- closer to
// death, wins"); hunting/item_collecting/torch_placing are routine opportunistic behavior, not a
// threat response, so they use OWNERS.ROUTINE (this differs from a first guess that hunting might
// share the self_defense tier -- it doesn't, Mindcraft's own mode treats it as idle-time chore,
// same bucket as collecting items or placing torches, not as a threat reaction).
//
// arbiter.js has a DROWNING tier (archived night-survival.js's oxygen-threshold "breath" handler
// used to request it) and a TELEPORT_HOME tier (pathfinding.js's own checkStuck escalation, kept,
// unrelated to this file). Nothing here requests either -- Mindcraft's self_preservation only
// prevents standing water-above-head by jumping (a direct control-state nudge, no arbiter needed,
// ported as-is) and treats fire/lava as the urgent case; it has no oxygen-depletion tracking of
// its own. That's a real, known gap versus the archived behavior, not something to silently
// invent here -- flagging it rather than fixing it, since inventing new behavior wasn't asked for.
//
// Simplification versus Mindcraft's own ModeController: no interrupts/active/pause bookkeeping, no
// per-profile on/off loading (Mindcraft's profiles carry a "modes": {...} block; nothing here reads
// one yet -- whoever wires this into index.js can add that later). runModes() just walks MODES in
// priority order each tick and stops at the first mode whose update() reports it acted, mirroring
// Mindcraft's "one active mode wins the tick" behavior without the extra machinery.

import { OWNERS, requestControl, releaseControl } from "./arbiter.js";
import { defendSelf, avoidEnemies, attackEntity, pickupNearbyItems, placeBlock } from "./skills.js";
import { getNearestEntityWhere, isClearPath, shouldPlaceTorch } from "./world.js";

// Ported from kolbytn/mindcraft's src/utils/mcdata.js isHostile/isHuntable -- small, self-contained
// classification helpers, not world-query mechanics, so inlined here rather than added to world.js.
function isHostile(mob) {
  if (!mob || !mob.name) return false;
  return (mob.type === "mob" || mob.type === "hostile") && mob.name !== "iron_golem" && mob.name !== "snow_golem";
}

function isHuntable(mob) {
  if (!mob || !mob.name) return false;
  const animals = ["chicken", "cow", "llama", "mooshroom", "pig", "rabbit", "sheep"];
  return animals.includes(mob.name.toLowerCase()) && !mob.metadata[16]; // metadata 16: not a baby
}

const FALL_BLOCKS = ["sand", "gravel", "concrete_powder"]; // substring match, e.g. "sandstone", "red_sand"

async function withControl(bot, owner, fn) {
  const handle = await requestControl(bot, owner, { waitMs: 0 });
  if (!handle) return false;
  try {
    await fn();
    return true;
  } finally {
    releaseControl(handle);
  }
}

// --- self_preservation: drowning (water above head), fire/lava, critical recent damage ---------
async function selfPreservationUpdate(bot) {
  const pos = bot.entity.position;
  const block = bot.blockAt(pos) || { name: "air" };
  const blockAbove = bot.blockAt(pos.offset(0, 1, 0)) || { name: "air" };

  if (blockAbove.name === "water") {
    // Direct control-state nudge, no arbiter needed -- doesn't fight the pathfinder.
    if (!bot.pathfinder.goal) bot.setControlState("jump", true);
    return false;
  }

  if (FALL_BLOCKS.some((name) => blockAbove.name.includes(name))) {
    return withControl(bot, OWNERS.HEALTH_CRITICAL, async () => {
      await avoidEnemies(bot, 2);
    });
  }

  if (block.name === "lava" || block.name === "fire" || blockAbove.name === "lava" || blockAbove.name === "fire") {
    bot.chat("I'm on fire!");
    return withControl(bot, OWNERS.HEALTH_CRITICAL, async () => {
      const waterBucket = bot.inventory.findInventoryItem("water_bucket");
      if (waterBucket) {
        const placed = await placeBlock(bot, "water_bucket", block.position.x, block.position.y, block.position.z);
        if (placed) bot.chat("Placed some water, ahhhh that's better!");
        return;
      }
      await avoidEnemies(bot, 5);
    });
  }

  if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
    bot.chat("I'm dying!");
    return withControl(bot, OWNERS.HEALTH_CRITICAL, async () => {
      await avoidEnemies(bot, 20);
    });
  }

  return false;
}

// --- self_defense: fight the nearest hostile -----------------------------------------------------
async function selfDefenseUpdate(bot) {
  const enemy = getNearestEntityWhere(bot, (e) => isHostile(e), 8);
  if (!enemy || !(await isClearPath(bot, enemy))) return false;
  bot.chat(`Fighting ${enemy.name}!`);
  return withControl(bot, OWNERS.SELF_DEFENSE, async () => {
    await defendSelf(bot, 8);
  });
}

// --- cowardice: flee the nearest hostile (normally exclusive with self_defense, see header) ------
async function cowardiceUpdate(bot) {
  const enemy = getNearestEntityWhere(bot, (e) => isHostile(e), 16);
  if (!enemy || !(await isClearPath(bot, enemy))) return false;
  bot.chat(`Aaa! A ${enemy.name.replace("_", " ")}!`);
  return withControl(bot, OWNERS.SELF_DEFENSE, async () => {
    await avoidEnemies(bot, 24);
  });
}

// --- hunting: opportunistically hunt nearby huntable animals (routine, not a threat reaction) ----
async function huntingUpdate(bot) {
  const prey = getNearestEntityWhere(bot, (e) => isHuntable(e), 8);
  if (!prey || !(await isClearPath(bot, prey))) return false;
  return withControl(bot, OWNERS.ROUTINE, async () => {
    bot.chat(`Hunting ${prey.name}!`);
    await attackEntity(bot, prey);
  });
}

// --- item_collecting: pick up nearby dropped items, debounced 2s ---------------------------------
let collectPrevItemId = null;
let collectNoticedAt = -1;
const COLLECT_WAIT_MS = 2000;

async function itemCollectingUpdate(bot) {
  const item = getNearestEntityWhere(bot, (e) => e.name === "item", 8);
  const emptySlots = bot.inventory.emptySlotCount();
  if (!item || item.id === collectPrevItemId || emptySlots <= 1 || !(await isClearPath(bot, item))) {
    collectNoticedAt = -1;
    return false;
  }
  if (collectNoticedAt === -1) {
    collectNoticedAt = Date.now();
    return false;
  }
  if (Date.now() - collectNoticedAt <= COLLECT_WAIT_MS) return false;

  collectPrevItemId = item.id;
  collectNoticedAt = -1;
  return withControl(bot, OWNERS.ROUTINE, async () => {
    bot.chat("Picking up item!");
    await pickupNearbyItems(bot);
  });
}

// --- torch_placing: place a torch when it's dark nearby and one is held, 5s cooldown -------------
let lastTorchPlaceAt = 0;
const TORCH_COOLDOWN_MS = 5000;

async function torchPlacingUpdate(bot) {
  if (!shouldPlaceTorch(bot)) return false;
  if (Date.now() - lastTorchPlaceAt < TORCH_COOLDOWN_MS) return false;
  lastTorchPlaceAt = Date.now();
  return withControl(bot, OWNERS.ROUTINE, async () => {
    const pos = bot.entity.position;
    await placeBlock(bot, "torch", pos.x, pos.y, pos.z, "bottom", true);
  });
}

// Priority order matters: earlier modes get first refusal each tick, matching Mindcraft's own
// modes_list ordering (self-preservation first, routine chores last).
export const MODES = [
  { name: "self_preservation", on: true, update: selfPreservationUpdate },
  { name: "self_defense", on: true, update: selfDefenseUpdate },
  { name: "cowardice", on: false, update: cowardiceUpdate }, // off by default, matches Mindcraft's own _default.json
  { name: "hunting", on: true, update: huntingUpdate },
  { name: "item_collecting", on: true, update: itemCollectingUpdate },
  { name: "torch_placing", on: true, update: torchPlacingUpdate },
];

/** Runs enabled modes in priority order, stopping at the first one that acts this tick. */
export async function runModes(bot) {
  for (const mode of MODES) {
    if (!mode.on) continue;
    const acted = await mode.update(bot);
    if (acted) return mode.name;
  }
  return null;
}
