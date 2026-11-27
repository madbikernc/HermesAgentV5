// Version: 1.0.0
//
// Small per-version Minecraft data shim for skills.js/world.js, ported from Mindcraft's
// src/utils/mcdata.js (https://github.com/kolbytn/mindcraft) -- only the lookups those two files
// actually call. Mindcraft's original caches `minecraft-data`/`prismarine-item` behind a
// module-level global set by its own initBot(); this project creates the bot elsewhere (index.js),
// so instead each function here takes `bot` and lazily (re)builds the cache keyed on bot.version --
// cheap, since minecraft-data caches per-version internally too.
//
// `minecraft-data` and `prismarine-item` are not listed directly in package.json -- both are
// transitive dependencies of mineflayer already present in node_modules, same as every other
// mineflayer script that imports them this way, but worth adding explicitly if this ever proves
// fragile.

import minecraftData from "minecraft-data";
import prismarineItem from "prismarine-item";

let cachedVersion = null;
let mcdata = null;
let Item = null;

function ensure(bot) {
  if (cachedVersion !== bot.version) {
    cachedVersion = bot.version;
    mcdata = minecraftData(bot.version);
    Item = prismarineItem(bot.version);
  }
}

export function isHostile(mob) {
  if (!mob || !mob.name) return false;
  return (mob.type === "mob" || mob.type === "hostile") && mob.name !== "iron_golem" && mob.name !== "snow_golem";
}

// Blocks that don't work with collectBlock, need to be manually collected.
export function mustCollectManually(blockName) {
  const full_names = ["wheat", "carrots", "potatoes", "beetroots", "nether_wart", "cocoa", "sugar_cane", "kelp",
    "short_grass", "fern", "tall_grass", "bamboo", "poppy", "dandelion", "blue_orchid", "allium", "azure_bluet",
    "oxeye_daisy", "cornflower", "lilac", "wither_rose", "lily_of_the_valley", "lever", "redstone_wire", "lantern"];
  const partial_names = ["sapling", "torch", "button", "carpet", "pressure_plate", "mushroom", "tulip", "bush", "vines", "fern"];
  return full_names.includes(blockName.toLowerCase()) || partial_names.some((partial) => blockName.toLowerCase().includes(partial));
}

export function getItemId(bot, itemName) {
  ensure(bot);
  const item = mcdata.itemsByName[itemName];
  return item ? item.id : null;
}

export function getItemName(bot, itemId) {
  ensure(bot);
  const item = mcdata.items[itemId];
  return item ? item.name : null;
}

export function getBlockId(bot, blockName) {
  ensure(bot);
  const block = mcdata.blocksByName[blockName];
  return block ? block.id : null;
}

export function getEntityId(bot, entityName) {
  ensure(bot);
  const entity = mcdata.entitiesByName[entityName];
  return entity ? entity.id : null;
}

export function getAllItems(bot, ignore = []) {
  ensure(bot);
  const items = [];
  for (const itemId in mcdata.items) {
    const item = mcdata.items[itemId];
    if (!ignore.includes(item.name)) items.push(item);
  }
  return items;
}

export function getAllBlocks(bot, ignore = []) {
  ensure(bot);
  const blocks = [];
  for (const blockId in mcdata.blocks) {
    const block = mcdata.blocks[blockId];
    if (!ignore.includes(block.name)) blocks.push(block);
  }
  return blocks;
}

export function getAllBlockIds(bot, ignore = []) {
  return getAllBlocks(bot, ignore).map((block) => block.id);
}

export function getAllBiomes(bot) {
  ensure(bot);
  return mcdata.biomes;
}

export function getItemCraftingRecipes(bot, itemName) {
  ensure(bot);
  const itemId = getItemId(bot, itemName);
  if (!mcdata.recipes[itemId]) return null;

  const recipes = [];
  for (const r of mcdata.recipes[itemId]) {
    const recipe = {};
    const ingredients = r.ingredients || (r.inShape ? r.inShape.flat() : []);
    for (const ingredient of ingredients) {
      const ingredientName = getItemName(bot, ingredient);
      if (ingredientName === null) continue;
      recipe[ingredientName] = (recipe[ingredientName] || 0) + 1;
    }
    recipes.push([recipe, { craftedCount: r.result.count }]);
  }
  const commonItems = ["oak_planks", "oak_log", "coal", "cobblestone"];
  recipes.sort((a, b) => {
    const countA = Object.keys(a[0]).filter((k) => commonItems.includes(k)).reduce((acc, k) => acc + a[0][k], 0);
    const countB = Object.keys(b[0]).filter((k) => commonItems.includes(k)).reduce((acc, k) => acc + b[0][k], 0);
    return countB - countA;
  });
  return recipes;
}

export function isSmeltable(itemName) {
  const misc_smeltables = ["beef", "chicken", "cod", "mutton", "porkchop", "rabbit", "salmon", "tropical_fish",
    "potato", "kelp", "sand", "cobblestone", "clay_ball"];
  return itemName.includes("raw") || itemName.includes("log") || misc_smeltables.includes(itemName);
}

export function getSmeltingFuel(bot) {
  let fuel = bot.inventory.items().find((i) => i.name === "coal" || i.name === "charcoal" || i.name === "blaze_rod");
  if (fuel) return fuel;
  fuel = bot.inventory.items().find((i) => i.name.includes("log") || i.name.includes("planks"));
  if (fuel) return fuel;
  return bot.inventory.items().find((i) => i.name === "coal_block" || i.name === "lava_bucket");
}

export function getFuelSmeltOutput(fuelName) {
  if (fuelName === "coal" || fuelName === "charcoal") return 8;
  if (fuelName === "blaze_rod") return 12;
  if (fuelName.includes("log") || fuelName.includes("planks")) return 1.5;
  if (fuelName === "coal_block") return 80;
  if (fuelName === "lava_bucket") return 100;
  return 0;
}

export function makeItem(bot, name, amount = 1) {
  ensure(bot);
  return new Item(getItemId(bot, name), amount);
}

// Returns the number of ingredients required to use the recipe once. prismarine-recipe uses
// positive counts for shaped ingredients but negative for unshaped -- the `-=` below is
// intentional, not a bug (confirmed against the original Mindcraft source).
export function ingredientsFromPrismarineRecipe(bot, recipe) {
  const required = {};
  if (recipe.inShape) {
    for (const ingredient of recipe.inShape.flat()) {
      if (ingredient.id < 0) continue;
      const name = getItemName(bot, ingredient.id);
      required[name] = (required[name] || 0) + ingredient.count;
    }
  }
  if (recipe.ingredients) {
    for (const ingredient of recipe.ingredients) {
      if (ingredient.id < 0) continue;
      const name = getItemName(bot, ingredient.id);
      required[name] = (required[name] || 0) - ingredient.count;
    }
  }
  return required;
}

export function calculateLimitingResource(availableItems, requiredItems, discrete = true) {
  let limitingResource = null;
  let num = Infinity;
  for (const itemType in requiredItems) {
    if (availableItems[itemType] < requiredItems[itemType] * num) {
      limitingResource = itemType;
      num = availableItems[itemType] / requiredItems[itemType];
    }
  }
  if (discrete) num = Math.floor(num);
  return { num, limitingResource };
}
