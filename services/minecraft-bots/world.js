// Version: 1.1.0
//
// 1.1.0 (2026-11-27): direct request, "verify that all discovered objects get an entry in the
// world memory" -- getNearestBlocksWhere() now records every notable result (world-memory.js's
// own allowlist) as a sighting, fire-and-forget, so any search through this file's shared
// chokepoint leaves a world-memory entry without its caller needing to do anything extra.
//
// World-query helpers, ported from Mindcraft's src/agent/library/world.js
// (https://github.com/kolbytn/mindcraft) -- the read-only lookups skills.js and the modes system
// depend on. Names/signatures kept identical to the original so code written against Mindcraft's
// own convention still works; only the `mc.*` calls were adapted to this project's mcdata.js shim
// (which takes `bot` explicitly rather than a module-level global set by Mindcraft's own initBot(),
// never ported here -- see mcdata.js's own header).

import pf from "mineflayer-pathfinder";
import * as mc from "./mcdata.js";
import { recordSightingIfNotable } from "./world-memory.js";

export function getNearestFreeSpace(bot, size = 1, distance = 8) {
  /**
   * Get the nearest empty space with solid blocks beneath it of the given size.
   * @returns {Vec3} the south-west corner position of the nearest free space.
   */
  const empty_pos = bot.findBlocks({
    matching: (block) => block && block.name == "air",
    maxDistance: distance,
    count: 1000,
  });
  for (let i = 0; i < empty_pos.length; i++) {
    let empty = true;
    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        const top = bot.blockAt(empty_pos[i].offset(x, 0, z));
        const bottom = bot.blockAt(empty_pos[i].offset(x, -1, z));
        if (!top || !top.name == "air" || !bottom || bottom.drops.length == 0 || !bottom.diggable) {
          empty = false;
          break;
        }
      }
      if (!empty) break;
    }
    if (empty) return empty_pos[i];
  }
}

export function getBlockAtPosition(bot, x = 0, y = 0, z = 0) {
  let block = bot.blockAt(bot.entity.position.offset(x, y, z));
  if (!block) block = { name: "air" };
  return block;
}

export function getSurroundingBlocks(bot) {
  return [
    `Block Below: ${getBlockAtPosition(bot, 0, -1, 0).name}`,
    `Block at Legs: ${getBlockAtPosition(bot, 0, 0, 0).name}`,
    `Block at Head: ${getBlockAtPosition(bot, 0, 1, 0).name}`,
  ];
}

export function getFirstBlockAboveHead(bot, ignore_types = null, distance = 32) {
  let ignore_blocks = [];
  if (ignore_types === null) {
    ignore_blocks = ["air", "cave_air"];
  } else {
    if (!Array.isArray(ignore_types)) ignore_types = [ignore_types];
    for (const ignore_type of ignore_types) {
      if (mc.getBlockId(bot, ignore_type)) ignore_blocks.push(ignore_type);
    }
  }
  let block_above = { name: "air" };
  let height = 0;
  for (let i = 0; i < distance; i++) {
    let block = bot.blockAt(bot.entity.position.offset(0, i + 2, 0));
    if (!block) block = { name: "air" };
    if (ignore_blocks.includes(block.name)) continue;
    block_above = block;
    height = i;
    break;
  }
  if (ignore_blocks.includes(block_above.name)) return "none";
  return `${block_above.name} (${height} blocks up)`;
}

// The one chokepoint every block search in this project funnels through (getNearestBlocks()/
// getNearestBlock() below call it; skills.js's own direct bot.findBlocks() calls were swept to go
// through it too) -- every notable result (world-memory.js's own allowlist: chests, furnaces,
// crafting/utility blocks, ore, beds) gets recorded there, fire-and-forget, so "a search found
// this" always leaves an entry without each caller needing its own write.
export function getNearestBlocksWhere(bot, predicate, distance = 8, count = 10000) {
  const positions = bot.findBlocks({ matching: predicate, maxDistance: distance, count });
  const blocks = positions.map((position) => {
    const block = bot.blockAt(position);
    if (block?.name) recordSightingIfNotable(block.name, position);
    return block;
  });
  return blocks;
}

export function getNearestBlocks(bot, block_types = null, distance = 8, count = 10000) {
  let block_ids = [];
  if (block_types === null) {
    block_ids = mc.getAllBlockIds(bot, ["air"]);
  } else {
    if (!Array.isArray(block_types)) block_types = [block_types];
    for (const block_type of block_types) block_ids.push(mc.getBlockId(bot, block_type));
  }
  return getNearestBlocksWhere(bot, (block) => block_ids.includes(block.type), distance, count);
}

export function getNearestBlock(bot, block_type, distance = 16) {
  const blocks = getNearestBlocks(bot, block_type, distance, 1);
  return blocks.length > 0 ? blocks[0] : null;
}

export function getNearbyEntities(bot, maxDistance = 16) {
  const entities = [];
  for (const entity of Object.values(bot.entities)) {
    const distance = entity.position.distanceTo(bot.entity.position);
    if (distance > maxDistance) continue;
    entities.push({ entity, distance });
  }
  entities.sort((a, b) => a.distance - b.distance);
  return entities.map((e) => e.entity);
}

export function getNearestEntityWhere(bot, predicate, maxDistance = 16) {
  return bot.nearestEntity((entity) => predicate(entity) && bot.entity.position.distanceTo(entity.position) < maxDistance);
}

export function getNearbyPlayers(bot, maxDistance) {
  if (maxDistance == null) maxDistance = 16;
  const players = [];
  for (const entity of Object.values(bot.entities)) {
    const distance = entity.position.distanceTo(bot.entity.position);
    if (distance > maxDistance) continue;
    if (entity.type == "player" && entity.username != bot.username) players.push({ entity, distance });
  }
  players.sort((a, b) => a.distance - b.distance);
  return players.map((p) => p.entity);
}

// Villager profession mapping based on metadata.
export function getVillagerProfession(entity) {
  const professions = {
    0: "Unemployed", 1: "Armorer", 2: "Butcher", 3: "Cartographer", 4: "Cleric", 5: "Farmer",
    6: "Fisherman", 7: "Fletcher", 8: "Leatherworker", 9: "Librarian", 10: "Mason", 11: "Nitwit",
    12: "Shepherd", 13: "Toolsmith", 14: "Weaponsmith",
  };
  if (entity.metadata && entity.metadata[18]) {
    if (typeof entity.metadata[18] === "object" && entity.metadata[18].villagerProfession !== undefined) {
      const professionId = entity.metadata[18].villagerProfession;
      const level = entity.metadata[18].level || 1;
      return `${professions[professionId] || "Unknown"} L${level}`;
    }
    if (typeof entity.metadata[18] === "number") {
      return professions[entity.metadata[18]] || "Unknown";
    }
  }
  if (entity.metadata && entity.metadata[16] !== 1) return "Adult";
  return "Unknown";
}

export function getInventoryCounts(bot) {
  const inventory = {};
  for (const slot of bot.inventory.slots) {
    if (slot != null && slot.name) {
      inventory[slot.name] = (inventory[slot.name] || 0) + slot.count;
    }
  }
  return inventory;
}

export function getCraftableItems(bot) {
  let table = getNearestBlock(bot, "crafting_table");
  if (!table) {
    for (const item of bot.inventory.items()) {
      if (item != null && item.name === "crafting_table") {
        table = item;
        break;
      }
    }
  }
  const res = [];
  for (const item of mc.getAllItems(bot)) {
    if (bot.recipesFor(item.id, null, 1, table).length > 0) res.push(item.name);
  }
  return res;
}

export function getPosition(bot) {
  return bot.entity.position;
}

export function getNearbyEntityTypes(bot) {
  const mobs = getNearbyEntities(bot, 16);
  const found = [];
  for (const mob of mobs) if (!found.includes(mob.name)) found.push(mob.name);
  return found;
}

export function isEntityType(bot, name) {
  return mc.getEntityId(bot, name) !== null;
}

export function getNearbyPlayerNames(bot) {
  const players = getNearbyPlayers(bot, 64);
  const found = [];
  for (const p of players) if (!found.includes(p.username) && p.username != bot.username) found.push(p.username);
  return found;
}

export function getNearbyBlockTypes(bot, distance = 16) {
  const blocks = getNearestBlocks(bot, null, distance);
  const found = [];
  for (const block of blocks) if (!found.includes(block.name)) found.push(block.name);
  return found;
}

export async function isClearPath(bot, target) {
  const movements = new pf.Movements(bot);
  movements.canDig = false;
  movements.canPlaceOn = false;
  movements.canOpenDoors = false;
  const goal = new pf.goals.GoalNear(target.position.x, target.position.y, target.position.z, 1);
  const path = await bot.pathfinder.getPathTo(movements, goal, 100);
  return path.status === "success";
}

export function shouldPlaceTorch(bot) {
  if (!bot.modes?.isOn?.("torch_placing") || bot.interrupt_code) return false;
  const pos = getPosition(bot);
  let nearest_torch = getNearestBlock(bot, "torch", 6) || getNearestBlock(bot, "wall_torch", 6);
  if (!nearest_torch) {
    const block = bot.blockAt(pos);
    const has_torch = bot.inventory.findInventoryItem("torch");
    return has_torch && block?.name === "air";
  }
  return false;
}

export function getBiomeName(bot) {
  const biomeId = bot.world.getBiome(bot.entity.position);
  return mc.getAllBiomes(bot)[biomeId].name;
}
