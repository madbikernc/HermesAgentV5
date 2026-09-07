// Version: 1.0.0
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
    candidates.sort((a, b) => materialTier(b.name) - materialTier(a.name));
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
    const tierDiff = materialTier(b.name) - materialTier(a.name);
    if (tierDiff !== 0) return tierDiff;
    return (b.name.endsWith("_sword") ? 1 : 0) - (a.name.endsWith("_sword") ? 1 : 0);
  });
  try {
    await bot.equip(candidates[0], "hand");
  } catch (err) {
    console.error(`equipBestWeapon: failed to equip ${candidates[0].name}:`, err.message);
  }
}
