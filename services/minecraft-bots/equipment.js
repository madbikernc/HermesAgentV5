// Version: 1.2.0
//
// 1.2.0 (2026-09-07) -- direct request ("next set of autonomy" -> gear durability awareness):
// equipBestArmor/equipBestWeapon compared material tier alone, so a nearly-broken diamond
// item could keep outranking a perfectly healthy lower-tier one -- a real risk of a weapon
// snapping mid-fight or armor breaking with no warning. New effectiveTier() demotes a
// critically low item (durabilityUsed/maxDurability, confirmed against prismarine-item source)
// by a full material tier before comparing, so a healthy lower-tier item wins instead once the
// better one is close to breaking. Normal wear above the threshold still ranks purely by
// material, unchanged from before.
//
// 1.1.0 (2026-09-07) -- autonomy (standing goals, index.js/goals.js): describeGear() gives the
// goal planner a compact, honest snapshot of what the bot actually has -- armor worn (raw slot
// indices 5-8, the standard vanilla player-inventory window layout; bot.inventory.items() alone
// excludes armor/offhand, same reason equipBestArmor can't use it either), held item
// (bot.heldItem), and inventory contents grouped/counted by name. Never guessed at from the
// goal description -- the planner reasons from real state every tick.
//
// Equipment management: wear the best armor available, hold the best weapon by default, and
// switch to the right task-specific tool for mining (mineflayer-tool, via
// bot.tool.equipForBlock() -- real dig-time math, not a guess) before reverting to the best
// weapon afterward. See MINECRAFT_BOTS_DESIGN.md and agents/minecraft-*/PROMPT.md's Core
// Directives, which named this explicitly.
//
// Real gap this closes: mineflayer-collectblock already calls bot.tool.equipForBlock()
// internally (confirmed in its own source, CollectBlock.js) -- but only if the mineflayer-tool
// plugin is actually loaded onto the bot. It never was, so bot.tool didn't exist. Loading it
// (loadEquipmentPlugins, called from actions.js) is a real fix, not just new capability --
// though a bot with no pickaxe at all still has nothing for equipForBlock to select.

import toolPkg from "mineflayer-tool";

const MATERIAL_TIER = {
  leather: 1, wood: 1, golden: 2, gold: 2, chainmail: 3, stone: 3,
  iron: 4, diamond: 5, netherite: 6,
};

function materialTier(name) {
  for (const [mat, tier] of Object.entries(MATERIAL_TIER)) {
    if (name.startsWith(`${mat}_`)) return tier;
  }
  return 0;
}

// item.maxDurability/item.durabilityUsed confirmed against prismarine-item source -- maxDurability
// is only set for items that can actually take damage, so a stackable/undamageable item (or one
// this mc version doesn't track durability for) reads as "fully healthy" rather than crashing on
// a division by undefined.
function durabilityFraction(item) {
  if (!item.maxDurability) return 1;
  return Math.max(0, 1 - (item.durabilityUsed ?? 0) / item.maxDurability);
}

const CRITICAL_DURABILITY_FRACTION = 0.1;

// Real gap: comparing material tier alone let a nearly-broken diamond sword/piece outrank a
// perfectly healthy stone/iron one, so she could have a "better" item snap without warning
// mid-fight. Demoting a critically low item by a full tier (rather than scoring exact
// percentages) is enough to make a healthy lower-tier item win instead, while leaving normal wear
// (anything above the threshold) to keep ranking purely by material like before.
function effectiveTier(item) {
  const tier = materialTier(item.name);
  return durabilityFraction(item) < CRITICAL_DURABILITY_FRACTION ? tier - 1 : tier;
}

const ARMOR_SLOTS = [
  { suffix: "_helmet", slot: "head" },
  { suffix: "_chestplate", slot: "torso" },
  { suffix: "_leggings", slot: "legs" },
  { suffix: "_boots", slot: "feet" },
];

const WEAPON_SUFFIXES = ["_sword", "_axe"];

export function loadEquipmentPlugins(bot) {
  bot.loadPlugin(toolPkg.plugin);
}

// Always picks the single best candidate already in inventory and equips it -- simpler and
// just as correct as comparing against what's currently worn (equip()ing an already-worn item
// is a harmless near-no-op), and avoids relying on raw equipment-slot indices, which are easy
// to get wrong.
export async function equipBestArmor(bot) {
  for (const { suffix, slot } of ARMOR_SLOTS) {
    const candidates = bot.inventory.items().filter((i) => i.name.endsWith(suffix));
    if (!candidates.length) continue;
    candidates.sort((a, b) => effectiveTier(b) - effectiveTier(a));
    try {
      await bot.equip(candidates[0], slot);
    } catch (err) {
      console.error(`equipBestArmor: failed to equip ${candidates[0].name}:`, err.message);
    }
  }
}

// Ties broken toward swords over axes at the same material tier -- swords are the dedicated
// combat weapon (higher attack speed/damage against most mobs); axes are the dual-purpose
// fallback, not the first choice once a same-tier sword exists.
export async function equipBestWeapon(bot) {
  const candidates = bot.inventory.items().filter((i) => WEAPON_SUFFIXES.some((s) => i.name.endsWith(s)));
  if (!candidates.length) return;
  candidates.sort((a, b) => {
    const tierDiff = effectiveTier(b) - effectiveTier(a);
    if (tierDiff !== 0) return tierDiff;
    return (b.name.endsWith("_sword") ? 1 : 0) - (a.name.endsWith("_sword") ? 1 : 0);
  });
  try {
    await bot.equip(candidates[0], "hand");
  } catch (err) {
    console.error(`equipBestWeapon: failed to equip ${candidates[0].name}:`, err.message);
  }
}

// Slots 5-8 are the standard vanilla player-inventory window layout (head/chest/legs/feet) --
// bot.inventory.items() deliberately excludes these (and offhand), same reason equipBestArmor
// above can't rely on it for reading worn armor either.
export function describeGear(bot) {
  const name = (item) => item?.name ?? "none";
  const [head, torso, legs, feet] = [5, 6, 7, 8].map((slot) => bot.inventory.slots[slot]);

  const counts = new Map();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  const invList = [...counts.entries()].map(([n, count]) => `${count}x ${n}`).join(", ") || "empty";

  return `Wearing: head=${name(head)}, chest=${name(torso)}, legs=${name(legs)}, feet=${name(feet)}. ` +
         `Holding: ${name(bot.heldItem)}. Inventory: ${invList}.`;
}
