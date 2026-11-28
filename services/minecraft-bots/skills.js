// Version: 1.2.0
//
// 1.2.0 (2026-11-28): direct request ("have prometheus record... mobs killed/blocks placed/
// blocks destroyed/items created... by bot") -- three one-line additions at each function's own
// existing success point, metrics.js's new recordMobKilled/recordBlockPlaced/recordItemsCrafted.
// Blocks mined are NOT instrumented here: every dig path in this file (collectBlock, breakBlockAt,
// digDown, ...) already funnels through bot.dig(), and mineflayer's own diggingCompleted event
// fires once per completed dig regardless of call site -- index.js hooks that single event
// instead, so no skills.js dig path needed touching. craftRecipe records the real inventory delta
// (recipe yield varies, and a short-on-resources craft produces fewer than requested), not the
// craft-operation count.
//
// 1.1.0 (2026-11-27): direct request, following the legacy-baseline test suite's two confirmed
// chest regressions -- chest lookups widened from mineflayer-pathfinder's 32-block default to the
// archived fleet's own tuned CHEST_SEARCH_RADIUS (128), plus a short-lived in-process miss cache
// (findNearestChest()) so an immediate retry from the same spot doesn't re-scan for nothing.
// goToBed()'s own direct bot.findBlocks() call now goes through world.getNearestBlocksWhere()
// instead, closing the one gap in that module's shared discovery-recording chokepoint (see
// world-memory.js) -- a found bed is now recorded there too, same as chests/furnaces/ore.
//
// Bot action library, ported from Mindcraft's src/agent/library/skills.js
// (https://github.com/kolbytn/mindcraft) -- every exported function kept at its original name and
// `async function name(bot, ...args)` signature, returning the same truthy/falsy success value, so
// a command layer written against Mindcraft's own convention still works against this.
//
// Three adaptations from the original, everywhere they apply:
// 1. `new pf.Movements(bot)` -> `new Movements(bot)`, this project's own SwimMovements subclass
//    (swim-movements.js) -- carries the water-handling/dig-cost/climb-assist fixes from the
//    2026-11 pathfinding debugging session. Mindcraft's originals always just install whatever
//    Movements is passed to bot.pathfinder.setMovements(); swapping the class is the whole change.
// 2. `mc.foo(x)` -> `mc.foo(bot, x)` -- this project's mcdata.js shim takes `bot` explicitly rather
//    than relying on a module-level global set by Mindcraft's own initBot() (not ported here).
// 3. craftRecipe's post-craft `bot.armorManager.equipAll()` -> `equipBestArmor(bot)` from this
//    project's own equipment.js -- mineflayer-armor-manager isn't an installed dependency here,
//    and equipment.js's own armor selection is more deliberate than Mindcraft's "equip everything".
//
// Everything else -- including every call into `bot.modes.pause/unpause/isOn`, `bot.interrupt_code`,
// and `bot.output` -- is kept verbatim. Those are Mindcraft's own execution-context contract: a
// ported modes.js must set `bot.modes`, and whatever drives the decision loop (index.js) must set
// `bot.interrupt_code` on interruption and read `bot.output` after a command runs. Neither skill
// function here does its own arbiter.js control-management -- confirmed while porting, none of the
// originals touch arbiter/requestControl/holdsControl at all; that's modes.js/commands.js's job.

import * as mc from "./mcdata.js";
import * as world from "./world.js";
import pf from "mineflayer-pathfinder";
import Vec3 from "vec3";
import { SwimMovements as Movements } from "./swim-movements.js";
import { equipBestArmor } from "./equipment.js";
import { recordMobKilled, recordBlockPlaced, recordItemsCrafted } from "./metrics.js";

export function log(bot, message) {
  bot.output += message + "\n";
}

async function autoLight(bot) {
  if (world.shouldPlaceTorch(bot)) {
    try {
      const pos = world.getPosition(bot);
      return await placeBlock(bot, "torch", pos.x, pos.y, pos.z, "bottom", true);
    } catch (err) {
      return false;
    }
  }
  return false;
}

async function equipHighestAttack(bot) {
  let weapons = bot.inventory.items().filter((item) => item.name.includes("sword") || (item.name.includes("axe") && !item.name.includes("pickaxe")));
  if (weapons.length === 0) weapons = bot.inventory.items().filter((item) => item.name.includes("pickaxe") || item.name.includes("shovel"));
  if (weapons.length === 0) return;
  weapons.sort((a, b) => b.attackDamage - a.attackDamage);
  const weapon = weapons[0];
  if (weapon) await bot.equip(weapon, "hand");
}

export async function craftRecipe(bot, itemName, num = 1) {
  /** Attempt to craft the given item name from a recipe. May craft many items. */
  let placedTable = false;

  if (mc.getItemCraftingRecipes(bot, itemName) == null) {
    log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
    return false;
  }

  let recipes = bot.recipesFor(mc.getItemId(bot, itemName), null, 1, null);
  let craftingTable = null;
  const craftingTableRange = 16;
  placeTable: if (!recipes || recipes.length === 0) {
    recipes = bot.recipesFor(mc.getItemId(bot, itemName), null, 1, true);
    if (!recipes || recipes.length === 0) break placeTable;

    craftingTable = world.getNearestBlock(bot, "crafting_table", craftingTableRange);
    if (craftingTable === null) {
      const hasTable = world.getInventoryCounts(bot)["crafting_table"] > 0;
      if (hasTable) {
        const pos = world.getNearestFreeSpace(bot, 1, 6);
        await placeBlock(bot, "crafting_table", pos.x, pos.y, pos.z);
        craftingTable = world.getNearestBlock(bot, "crafting_table", craftingTableRange);
        if (craftingTable) {
          recipes = bot.recipesFor(mc.getItemId(bot, itemName), null, 1, craftingTable);
          placedTable = true;
        }
      } else {
        log(bot, `Crafting ${itemName} requires a crafting table.`);
        return false;
      }
    } else {
      recipes = bot.recipesFor(mc.getItemId(bot, itemName), null, 1, craftingTable);
    }
  }
  if (!recipes || recipes.length === 0) {
    const recipeInfo = mc.getItemCraftingRecipes(bot, itemName)[0][0];
    log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${Object.entries(recipeInfo).map(([k, v]) => `${k}: ${v}`).join(", ")}.`);
    if (placedTable) await collectBlock(bot, "crafting_table", 1);
    return false;
  }

  if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
    await goToNearestBlock(bot, "crafting_table", 4, craftingTableRange);
  }

  const recipe = recipes[0];
  const inventory = world.getInventoryCounts(bot);
  const requiredIngredients = mc.ingredientsFromPrismarineRecipe(bot, recipe);
  const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);

  const beforeCount = world.getInventoryCounts(bot)[itemName] ?? 0;
  await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
  const afterCount = world.getInventoryCounts(bot)[itemName] ?? 0;
  recordItemsCrafted(itemName, afterCount - beforeCount);
  if (craftLimit.num < num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
  else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
  if (placedTable) await collectBlock(bot, "crafting_table", 1);

  await equipBestArmor(bot);

  return true;
}

export async function wait(bot, milliseconds) {
  /** Waits for the given number of milliseconds, interruptible. */
  let timeLeft = milliseconds;
  const startTime = Date.now();
  while (timeLeft > 0) {
    if (bot.interrupt_code) return false;
    const waitTime = Math.min(2000, timeLeft);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    timeLeft = milliseconds - (Date.now() - startTime);
  }
  return true;
}

export async function smeltItem(bot, itemName, num = 1) {
  /** Puts 1 fuel in furnace and smelts the given item name until the furnace runs out of fuel or input. */
  if (!mc.isSmeltable(itemName)) {
    log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
    return false;
  }

  let placedFurnace = false;
  const furnaceRange = 16;
  let furnaceBlock = world.getNearestBlock(bot, "furnace", furnaceRange);
  if (!furnaceBlock) {
    const hasFurnace = world.getInventoryCounts(bot)["furnace"] > 0;
    if (hasFurnace) {
      const pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
      await placeBlock(bot, "furnace", pos.x, pos.y, pos.z);
      furnaceBlock = world.getNearestBlock(bot, "furnace", furnaceRange);
      placedFurnace = true;
    }
  }
  if (!furnaceBlock) {
    log(bot, `There is no furnace nearby and you have no furnace.`);
    return false;
  }
  if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
    await goToNearestBlock(bot, "furnace", 4, furnaceRange);
  }
  bot.modes.pause("unstuck");
  await bot.lookAt(furnaceBlock.position);

  const furnace = await bot.openFurnace(furnaceBlock);
  const input_item = furnace.inputItem();
  if (input_item && input_item.type !== mc.getItemId(bot, itemName) && input_item.count > 0) {
    log(bot, `The furnace is currently smelting ${mc.getItemName(bot, input_item.type)}.`);
    if (placedFurnace) await collectBlock(bot, "furnace", 1);
    return false;
  }
  const inv_counts = world.getInventoryCounts(bot);
  if (!inv_counts[itemName] || inv_counts[itemName] < num) {
    log(bot, `You do not have enough ${itemName} to smelt.`);
    if (placedFurnace) await collectBlock(bot, "furnace", 1);
    return false;
  }

  if (!furnace.fuelItem()) {
    const fuel = mc.getSmeltingFuel(bot);
    if (!fuel) {
      log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
      if (placedFurnace) await collectBlock(bot, "furnace", 1);
      return false;
    }
    const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));
    if (fuel.count < put_fuel) {
      log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
      if (placedFurnace) await collectBlock(bot, "furnace", 1);
      return false;
    }
    await furnace.putFuel(fuel.type, null, put_fuel);
    log(bot, `Added ${put_fuel} ${mc.getItemName(bot, fuel.type)} to furnace fuel.`);
  }
  await furnace.putInput(mc.getItemId(bot, itemName), null, num);

  let total = 0;
  let smelted_item = null;
  await new Promise((resolve) => setTimeout(resolve, 200));
  let last_collected = Date.now();
  while (total < num) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (furnace.outputItem()) {
      smelted_item = await furnace.takeOutput();
      if (smelted_item) {
        total += smelted_item.count;
        last_collected = Date.now();
      }
    }
    if (Date.now() - last_collected > 11000) break;
    if (bot.interrupt_code) break;
  }
  if (furnace.inputItem()) await furnace.takeInput();
  if (furnace.fuelItem()) await furnace.takeFuel();
  await bot.closeWindow(furnace);
  if (placedFurnace) await collectBlock(bot, "furnace", 1);

  if (total === 0) {
    log(bot, `Failed to smelt ${itemName}.`);
    return false;
  }
  if (total < num) {
    log(bot, `Only smelted ${total} ${mc.getItemName(bot, smelted_item.type)}.`);
    return false;
  }
  log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(bot, smelted_item.type)}.`);
  return true;
}

export async function clearNearestFurnace(bot) {
  /** Clears the nearest furnace of all items. */
  const furnaceBlock = world.getNearestBlock(bot, "furnace", 32);
  if (!furnaceBlock) {
    log(bot, `No furnace nearby to clear.`);
    return false;
  }
  if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
    await goToNearestBlock(bot, "furnace", 4, 32);
  }
  const furnace = await bot.openFurnace(furnaceBlock);
  let smelted_item, input_item, fuel_item;
  if (furnace.outputItem()) smelted_item = await furnace.takeOutput();
  if (furnace.inputItem()) input_item = await furnace.takeInput();
  if (furnace.fuelItem()) fuel_item = await furnace.takeFuel();
  const smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
  const input_name = input_item ? `${input_item.count} ${input_item.name}` : `0 input items`;
  const fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
  log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
  return true;
}

export async function attackNearest(bot, mobType, kill = true) {
  /** Attack the nearest mob of the given type. */
  bot.modes.pause("cowardice");
  if (["drowned", "cod", "salmon", "tropical_fish", "squid"].includes(mobType)) bot.modes.pause("self_preservation");
  const mob = world.getNearbyEntities(bot, 24).find((entity) => entity.name === mobType);
  if (mob) return await attackEntity(bot, mob, kill);
  log(bot, "Could not find any " + mobType + " to attack.");
  return false;
}

export async function attackEntity(bot, entity, kill = true) {
  /** Attack a specific entity. */
  const pos = entity.position;
  await equipHighestAttack(bot);

  if (!kill) {
    if (bot.entity.position.distanceTo(pos) > 5) await goToPosition(bot, pos.x, pos.y, pos.z);
    await bot.attack(entity);
    return true;
  }
  bot.pvp.attack(entity);
  while (world.getNearbyEntities(bot, 24).includes(entity)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (bot.interrupt_code) {
      bot.pvp.stop();
      return false;
    }
  }
  log(bot, `Successfully killed ${entity.name}.`);
  recordMobKilled(entity.name);
  await pickupNearbyItems(bot);
  return true;
}

export async function defendSelf(bot, range = 9) {
  /** Defend yourself from all nearby hostile mobs until there are no more. */
  bot.modes.pause("self_defense");
  bot.modes.pause("cowardice");
  let attacked = false;
  let enemy = world.getNearestEntityWhere(bot, (entity) => mc.isHostile(entity), range);
  while (enemy) {
    await equipHighestAttack(bot);
    if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== "creeper" && enemy.name !== "phantom") {
      try {
        bot.pathfinder.setMovements(new Movements(bot));
        await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
      } catch (err) {}
    }
    if (bot.entity.position.distanceTo(enemy.position) <= 2) {
      try {
        bot.pathfinder.setMovements(new Movements(bot));
        const inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
        await bot.pathfinder.goto(inverted_goal, true);
      } catch (err) {}
    }
    bot.pvp.attack(enemy);
    attacked = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    enemy = world.getNearestEntityWhere(bot, (entity) => mc.isHostile(entity), range);
    if (bot.interrupt_code) {
      bot.pvp.stop();
      return false;
    }
  }
  bot.pvp.stop();
  log(bot, attacked ? `Successfully defended self.` : `No enemies nearby to defend self from.`);
  return attacked;
}

export async function collectBlock(bot, blockType, num = 1, exclude = null) {
  /** Collect `num` of the given block type. */
  if (num < 1) {
    log(bot, `Invalid number of blocks to collect: ${num}.`);
    return false;
  }
  const blocktypes = [blockType];
  if (["coal", "diamond", "emerald", "iron", "gold", "lapis_lazuli", "redstone"].includes(blockType)) blocktypes.push(blockType + "_ore");
  if (blockType.endsWith("ore")) blocktypes.push("deepslate_" + blockType);
  if (blockType === "dirt") blocktypes.push("grass_block");
  if (blockType === "cobblestone") blocktypes.push("stone");
  const isLiquid = blockType === "lava" || blockType === "water";

  let collected = 0;
  const movements = new Movements(bot);
  movements.dontMineUnderFallingBlock = false;
  movements.dontCreateFlow = true;
  const unsafeBlocks = ["obsidian"];

  for (let i = 0; i < num; i++) {
    const blocks = world.getNearestBlocksWhere(bot, (block) => {
      if (!blocktypes.includes(block.name)) return false;
      if (exclude) {
        for (const position of exclude) {
          if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) return false;
        }
      }
      if (isLiquid) return block.metadata === 0;
      return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
    }, 64, 1);

    if (blocks.length === 0) {
      log(bot, collected === 0 ? `No ${blockType} nearby to collect.` : `No more ${blockType} nearby to collect.`);
      break;
    }
    const block = blocks[0];
    await bot.tool.equipForBlock(block);
    if (isLiquid) {
      const bucket = bot.inventory.findInventoryItem("bucket");
      if (!bucket) {
        log(bot, `Don't have bucket to harvest ${blockType}.`);
        return false;
      }
      await bot.equip(bucket, "hand");
    }
    const itemId = bot.heldItem ? bot.heldItem.type : null;
    if (!block.canHarvest(itemId)) {
      log(bot, `Don't have right tools to harvest ${blockType}.`);
      return false;
    }
    try {
      let success = false;
      if (isLiquid) {
        success = await useToolOnBlock(bot, "bucket", block);
      } else if (mc.mustCollectManually(blockType)) {
        await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
        await bot.dig(block);
        await pickupNearbyItems(bot);
        success = true;
      } else {
        await bot.collectBlock.collect(block);
        success = true;
      }
      if (success) collected++;
      await autoLight(bot);
    } catch (err) {
      if (err.name === "NoChests") {
        log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
        break;
      }
      log(bot, `Failed to collect ${blockType}: ${err}.`);
      continue;
    }
    if (bot.interrupt_code) break;
  }
  log(bot, `Collected ${collected} ${blockType}.`);
  return collected > 0;
}

export async function pickupNearbyItems(bot) {
  /** Pick up all nearby dropped items. */
  const distance = 8;
  const getNearestItem = (b) => b.nearestEntity((entity) => entity.name === "item" && b.entity.position.distanceTo(entity.position) < distance);
  let nearestItem = getNearestItem(bot);
  let pickedUp = 0;
  while (nearestItem) {
    const movements = new Movements(bot);
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
    await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const prev = nearestItem;
    nearestItem = getNearestItem(bot);
    if (prev === nearestItem) break;
    pickedUp++;
  }
  log(bot, `Picked up ${pickedUp} items.`);
  return true;
}

export async function breakBlockAt(bot, x, y, z) {
  /** Break the block at the given position with the currently best-equipped tool. */
  if (x == null || y == null || z == null) throw new Error("Invalid position to break block at.");
  const block = bot.blockAt(Vec3(x, y, z));
  if (block.name === "air" || block.name === "water" || block.name === "lava") {
    log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
    return false;
  }
  if (bot.modes.isOn("cheat")) {
    bot.chat("/setblock " + Math.floor(x) + " " + Math.floor(y) + " " + Math.floor(z) + " air");
    log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
    return true;
  }
  if (bot.entity.position.distanceTo(block.position) > 4.5) {
    const pos = block.position;
    const movements = new Movements(bot);
    movements.canPlaceOn = false;
    movements.allow1by1towers = false;
    bot.pathfinder.setMovements(movements);
    await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
  }
  if (bot.game.gameMode !== "creative") {
    await bot.tool.equipForBlock(block);
    const itemId = bot.heldItem ? bot.heldItem.type : null;
    if (!block.canHarvest(itemId)) {
      log(bot, `Don't have right tools to break ${block.name}.`);
      return false;
    }
  }
  await bot.dig(block, true);
  log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
  return true;
}

export async function placeBlock(bot, blockType, x, y, z, placeOn = "bottom", dontCheat = false) {
  /** Place the given block type at the given position, building off an adjacent block. */
  const placedBlockType = blockType; // the cheat branch below mutates blockType (facing suffixes); keep the clean name for the metric
  const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

  if (blockType === "air") {
    log(bot, `Placing air (removing block) at ${target_dest}.`);
    return await breakBlockAt(bot, x, y, z);
  }

  if (bot.modes.isOn("cheat") && !dontCheat) {
    if (bot.restrict_to_inventory) {
      const block = bot.inventory.findInventoryItem(blockType);
      if (!block) {
        log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
        return false;
      }
    }
    const face = placeOn === "north" ? "south" : placeOn === "south" ? "north" : placeOn === "east" ? "west" : "east";
    if (blockType.includes("torch") && placeOn !== "bottom") {
      blockType = blockType.replace("torch", "wall_torch");
      if (placeOn !== "side" && placeOn !== "top") blockType += `[facing=${face}]`;
    }
    if (blockType.includes("button") || blockType === "lever") {
      blockType += placeOn === "top" ? `[face=ceiling]` : placeOn === "bottom" ? `[face=floor]` : `[facing=${face}]`;
    }
    if (blockType === "ladder" || blockType === "repeater" || blockType === "comparator") blockType += `[facing=${face}]`;
    if (blockType.includes("stairs")) blockType += `[facing=${face}]`;
    bot.chat("/setblock " + Math.floor(x) + " " + Math.floor(y) + " " + Math.floor(z) + " " + blockType);
    if (blockType.includes("door")) bot.chat("/setblock " + Math.floor(x) + " " + Math.floor(y + 1) + " " + Math.floor(z) + " " + blockType + "[half=upper]");
    if (blockType.includes("bed")) bot.chat("/setblock " + Math.floor(x) + " " + Math.floor(y) + " " + Math.floor(z - 1) + " " + blockType + "[part=head]");
    log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
    recordBlockPlaced(placedBlockType);
    return true;
  }

  let item_name = blockType;
  if (item_name == "redstone_wire") item_name = "redstone";
  else if (item_name === "water") item_name = "water_bucket";
  else if (item_name === "lava") item_name = "lava_bucket";
  let block_item = bot.inventory.findInventoryItem(item_name);
  if (!block_item && bot.game.gameMode === "creative" && !bot.restrict_to_inventory) {
    await bot.creative.setInventorySlot(36, mc.makeItem(bot, item_name, 1));
    block_item = bot.inventory.findInventoryItem(item_name);
  }
  if (!block_item) {
    log(bot, `Don't have any ${item_name} to place.`);
    return false;
  }

  const targetBlock = bot.blockAt(target_dest);
  if (targetBlock.name === blockType || (targetBlock.name === "grass_block" && blockType === "dirt")) {
    log(bot, `${blockType} already at ${targetBlock.position}.`);
    return false;
  }
  const empty_blocks = ["air", "water", "lava", "grass", "short_grass", "tall_grass", "snow", "dead_bush", "fern"];
  if (!empty_blocks.includes(targetBlock.name)) {
    log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
    const removed = await breakBlockAt(bot, x, y, z);
    if (!removed) {
      log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  let buildOffBlock = null;
  let faceVec = null;
  const dir_map = {
    top: Vec3(0, 1, 0), bottom: Vec3(0, -1, 0), north: Vec3(0, 0, -1),
    south: Vec3(0, 0, 1), east: Vec3(1, 0, 0), west: Vec3(-1, 0, 0),
  };
  let dirs = [];
  if (placeOn === "side") {
    dirs.push(dir_map["north"], dir_map["south"], dir_map["east"], dir_map["west"]);
  } else if (dir_map[placeOn] !== undefined) {
    dirs.push(dir_map[placeOn]);
  } else {
    dirs.push(dir_map["bottom"]);
    log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
  }
  dirs.push(...Object.values(dir_map).filter((d) => !dirs.includes(d)));

  for (const d of dirs) {
    const block = bot.blockAt(target_dest.plus(d));
    if (!empty_blocks.includes(block.name)) {
      buildOffBlock = block;
      faceVec = new Vec3(-d.x, -d.y, -d.z);
      break;
    }
  }
  if (!buildOffBlock) {
    log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
    return false;
  }

  const pos = bot.entity.position;
  const pos_above = pos.plus(Vec3(0, 1, 0));
  const dont_move_for = ["torch", "redstone_torch", "redstone", "lever", "button", "rail", "detector_rail",
    "powered_rail", "activator_rail", "tripwire_hook", "tripwire", "water_bucket", "string"];
  if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
    const goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
    const inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
  }
  if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
    const pos2 = targetBlock.position;
    bot.pathfinder.setMovements(new Movements(bot));
    await goToGoal(bot, new pf.goals.GoalNear(pos2.x, pos2.y, pos2.z, 4));
  }

  try {
    if (item_name.includes("bucket")) {
      await useToolOnBlock(bot, item_name, buildOffBlock);
    } else {
      await bot.equip(block_item, "hand");
      await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
      await bot.placeBlock(buildOffBlock, faceVec);
      log(bot, `Placed ${blockType} at ${target_dest}.`);
      recordBlockPlaced(placedBlockType);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return true;
    }
  } catch (err) {
    log(bot, `Failed to place ${blockType} at ${target_dest}.`);
    return false;
  }
}

export async function equip(bot, itemName) {
  /** Equip the given item to its proper body part by exact name. For "the best", use equipment.js's equipBestArmor/equipBestWeapon instead. */
  if (itemName === "hand") {
    await bot.unequip("hand");
    log(bot, `Unequipped hand.`);
    return true;
  }
  let item = bot.inventory.slots.find((slot) => slot && slot.name === itemName);
  if (!item) {
    if (bot.game.gameMode === "creative") {
      await bot.creative.setInventorySlot(36, mc.makeItem(bot, itemName, 1));
      item = bot.inventory.findInventoryItem(itemName);
    } else {
      log(bot, `You do not have any ${itemName} to equip.`);
      return false;
    }
  }
  if (itemName.includes("leggings")) await bot.equip(item, "legs");
  else if (itemName.includes("boots")) await bot.equip(item, "feet");
  else if (itemName.includes("helmet")) await bot.equip(item, "head");
  else if (itemName.includes("chestplate") || itemName.includes("elytra")) await bot.equip(item, "torso");
  else if (itemName.includes("shield")) await bot.equip(item, "off-hand");
  else await bot.equip(item, "hand");
  log(bot, `Equipped ${itemName}.`);
  return true;
}

export async function discard(bot, itemName, num = -1) {
  /** Discard (toss) the given item. */
  let discarded = 0;
  while (true) {
    const item = bot.inventory.findInventoryItem(itemName);
    if (!item) break;
    const to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
    await bot.toss(item.type, null, to_discard);
    discarded += to_discard;
    if (num !== -1 && discarded >= num) break;
  }
  if (discarded === 0) {
    log(bot, `You do not have any ${itemName} to discard.`);
    return false;
  }
  log(bot, `Discarded ${discarded} ${itemName}.`);
  return true;
}

// Direct request, 2026-11-27: chest lookups now reach CHEST_SEARCH_RADIUS (the archived fleet's
// own tuned value, actions.js 1.106.0 -- its header: "bots gave up on chests well within walking
// distance" at the old 32-block default), and a search that just came up empty is remembered
// briefly so an immediate retry from the same spot doesn't re-scan for nothing -- same spirit as
// the archived fleet's own short-lived CHEST_MISS_RADIUS cache (action-crafting.js), rebuilt here
// in-process (no persistent file -- this project's own "bounded, reset on restart" memory
// philosophy, see index.js's header) since a stale chest-miss is cheap to recover from on the next
// decision tick regardless.
const CHEST_SEARCH_RADIUS = 128;
const CHEST_MISS_TTL_MS = 60_000;
const chestMissCache = new Map(); // "x,y,z" (rounded searcher position) -> expiry timestamp
function chestMissKey(pos) { return `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`; }
function findNearestChest(bot) {
  const key = chestMissKey(bot.entity.position);
  const missUntil = chestMissCache.get(key);
  if (missUntil !== undefined && Date.now() < missUntil) return null;
  const chest = world.getNearestBlock(bot, "chest", CHEST_SEARCH_RADIUS);
  if (!chest) chestMissCache.set(key, Date.now() + CHEST_MISS_TTL_MS);
  else chestMissCache.delete(key);
  return chest;
}

export async function putInChest(bot, itemName, num = -1) {
  /** Put the given item in the nearest chest. */
  const chest = findNearestChest(bot);
  if (!chest) {
    log(bot, `Could not find a chest nearby.`);
    return false;
  }
  const item = bot.inventory.findInventoryItem(itemName);
  if (!item) {
    log(bot, `You do not have any ${itemName} to put in the chest.`);
    return false;
  }
  const to_put = num === -1 ? item.count : Math.min(num, item.count);
  await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
  const chestContainer = await bot.openContainer(chest);
  await chestContainer.deposit(item.type, null, to_put);
  await chestContainer.close();
  log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
  return true;
}

export async function takeFromChest(bot, itemName, num = -1) {
  /** Take the given item from the nearest chest, potentially from multiple slots. */
  const chest = findNearestChest(bot);
  if (!chest) {
    log(bot, `Could not find a chest nearby.`);
    return false;
  }
  await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
  const chestContainer = await bot.openContainer(chest);
  const matchingItems = chestContainer.containerItems().filter((item) => item.name === itemName);
  if (matchingItems.length === 0) {
    log(bot, `Could not find any ${itemName} in the chest.`);
    await chestContainer.close();
    return false;
  }
  const totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
  let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
  let totalTaken = 0;
  for (const item of matchingItems) {
    if (remaining <= 0) break;
    const toTakeFromSlot = Math.min(remaining, item.count);
    await chestContainer.withdraw(item.type, null, toTakeFromSlot);
    totalTaken += toTakeFromSlot;
    remaining -= toTakeFromSlot;
  }
  await chestContainer.close();
  log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
  return totalTaken > 0;
}

export async function viewChest(bot) {
  /** View the contents of the nearest chest. */
  const chest = findNearestChest(bot);
  if (!chest) {
    log(bot, `Could not find a chest nearby.`);
    return false;
  }
  await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
  const chestContainer = await bot.openContainer(chest);
  const items = chestContainer.containerItems();
  if (items.length === 0) {
    log(bot, `The chest is empty.`);
  } else {
    log(bot, `The chest contains:`);
    for (const item of items) log(bot, `${item.count} ${item.name}`);
  }
  await chestContainer.close();
  return true;
}

export async function consume(bot, itemName = "") {
  /** Eat/drink the given item. */
  let item, name;
  if (itemName) {
    item = bot.inventory.findInventoryItem(itemName);
    name = itemName;
  }
  if (!item) {
    log(bot, `You do not have any ${name} to eat.`);
    return false;
  }
  await bot.equip(item, "hand");
  await bot.consume();
  log(bot, `Consumed ${item.name}.`);
  return true;
}

export async function giveToPlayer(bot, itemType, username, num = 1) {
  /** Give one of the specified item to the specified player. */
  if (bot.username === username) {
    log(bot, `You cannot give items to yourself.`);
    return false;
  }
  const player = bot.players[username]?.entity;
  if (!player) {
    log(bot, `Could not find ${username}.`);
    return false;
  }
  await goToPlayer(bot, username, 3);
  if (bot.entity.position.y < player.position.y - 1) {
    await goToPlayer(bot, username, 1);
  }
  if (bot.entity.position.distanceTo(player.position) < 2) {
    let too_close = true;
    const start_moving_away = Date.now();
    await moveAwayFromEntity(bot, player, 2);
    while (too_close && !bot.interrupt_code) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      too_close = bot.entity.position.distanceTo(player.position) < 5;
      if (too_close) await moveAwayFromEntity(bot, player, 5);
      if (Date.now() - start_moving_away > 3000) break;
    }
    if (too_close) {
      log(bot, `Failed to give ${itemType} to ${username}, too close.`);
      return false;
    }
  }

  await bot.lookAt(player.position);
  if (await discard(bot, itemType, num)) {
    let given = false;
    bot.once("playerCollect", (collector) => {
      if (collector.username === username) {
        log(bot, `${username} received ${itemType}.`);
        given = true;
      }
    });
    const start = Date.now();
    while (!given && !bot.interrupt_code) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (given) return true;
      if (Date.now() - start > 3000) break;
    }
  }
  log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
  return false;
}

export async function goToGoal(bot, goal) {
  /** Navigate to the given goal, preferring a non-destructive path, using doors along the way. */
  const nonDestructiveMovements = new Movements(bot);
  for (const block of ["glass", "glass_pane"]) {
    nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(bot, block));
  }
  nonDestructiveMovements.placeCost = 2;
  nonDestructiveMovements.digCost = 10;

  const destructiveMovements = new Movements(bot);
  let final_movements = destructiveMovements;

  const pathfind_timeout = 1000;
  if ((await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout)).status === "success") {
    final_movements = nonDestructiveMovements;
    log(bot, `Found non-destructive path.`);
  } else if ((await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout)).status === "success") {
    log(bot, `Found destructive path.`);
  } else {
    log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
  }

  const doorCheckInterval = startDoorInterval(bot);
  bot.pathfinder.setMovements(final_movements);
  try {
    await bot.pathfinder.goto(goal);
    clearInterval(doorCheckInterval);
    return true;
  } catch (err) {
    clearInterval(doorCheckInterval);
    throw err;
  }
}

let _doorInterval = null;
function startDoorInterval(bot) {
  /** Helper interval that opens nearby doors if the bot is stuck. */
  if (_doorInterval) clearInterval(_doorInterval);
  let prev_pos = bot.entity.position.clone();
  let prev_check = Date.now();
  let stuck_time = 0;

  const doorCheckInterval = setInterval(() => {
    const now = Date.now();
    if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
      stuck_time = 0;
    } else {
      stuck_time += now - prev_check;
    }
    if (stuck_time > 1200) {
      const positions = [
        bot.entity.position.clone(),
        bot.entity.position.offset(0, 0, 1),
        bot.entity.position.offset(0, 0, -1),
        bot.entity.position.offset(1, 0, 0),
        bot.entity.position.offset(-1, 0, 0),
      ];
      positions.push(...positions.map((p) => p.offset(0, 1, 0)));
      positions.push(bot.entity.position.offset(0, 2, 0));
      positions.push(bot.entity.position.offset(0, -1, 0));

      let currentIndex = positions.length;
      while (currentIndex != 0) {
        const randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [positions[currentIndex], positions[randomIndex]] = [positions[randomIndex], positions[currentIndex]];
      }
      for (const position of positions) {
        const block = bot.blockAt(position);
        if (block && block.name && !block.name.includes("iron") &&
          (block.name.includes("door") || block.name.includes("fence_gate") || block.name.includes("trapdoor"))) {
          bot.activateBlock(block);
          break;
        }
      }
      stuck_time = 0;
    }
    prev_pos = bot.entity.position.clone();
    prev_check = now;
  }, 200);
  _doorInterval = doorCheckInterval;
  return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance = 2) {
  /** Navigate to the given position. */
  if (x == null || y == null || z == null) {
    log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
    return false;
  }
  if (bot.modes.isOn("cheat")) {
    bot.chat("/tp @s " + x + " " + y + " " + z);
    log(bot, `Teleported to ${x}, ${y}, ${z}.`);
    return true;
  }

  const checkDigProgress = () => {
    if (bot.targetDigBlock) {
      const targetBlock = bot.targetDigBlock;
      const itemId = bot.heldItem ? bot.heldItem.type : null;
      if (!targetBlock.canHarvest(itemId)) {
        log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
        bot.pathfinder.stop();
        bot.stopDigging();
      }
    }
  };
  const progressInterval = setInterval(checkDigProgress, 1000);
  try {
    await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
    clearInterval(progressInterval);
    const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
    if (distance <= min_distance + 1) {
      log(bot, `You have reached at ${x}, ${y}, ${z}.`);
      return true;
    }
    log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
    return false;
  } catch (err) {
    log(bot, `Pathfinding stopped: ${err.message}.`);
    clearInterval(progressInterval);
    return false;
  }
}

export async function goToNearestBlock(bot, blockType, min_distance = 2, range = 64) {
  /** Navigate to the nearest block of the given type. */
  const MAX_RANGE = 512;
  if (range > MAX_RANGE) {
    log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
    range = MAX_RANGE;
  }
  let block = null;
  if (blockType === "water" || blockType === "lava") {
    let blocks = world.getNearestBlocksWhere(bot, (b) => b.name === blockType && b.metadata === 0, range, 1);
    if (blocks.length === 0) {
      log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
      blocks = world.getNearestBlocksWhere(bot, (b) => b.name === blockType, range, 1);
    }
    block = blocks[0];
  } else {
    block = world.getNearestBlock(bot, blockType, range);
  }
  if (!block) {
    log(bot, `Could not find any ${blockType} in ${range} blocks.`);
    return false;
  }
  log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
  await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
  return true;
}

export async function goToNearestEntity(bot, entityType, min_distance = 2, range = 64) {
  /** Navigate to the nearest entity of the given type. */
  const entity = world.getNearestEntityWhere(bot, (e) => e.name === entityType, range);
  if (!entity) {
    log(bot, `Could not find any ${entityType} in ${range} blocks.`);
    return false;
  }
  const distance = bot.entity.position.distanceTo(entity.position);
  log(bot, `Found ${entityType} ${distance} blocks away.`);
  await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
  return true;
}

export async function goToPlayer(bot, username, distance = 3) {
  /** Navigate to the given player. */
  if (bot.username === username) {
    log(bot, `You are already at ${username}.`);
    return true;
  }
  if (bot.modes.isOn("cheat")) {
    bot.chat("/tp @s " + username);
    log(bot, `Teleported to ${username}.`);
    return true;
  }
  bot.modes.pause("self_defense");
  bot.modes.pause("cowardice");
  const player = bot.players[username]?.entity;
  if (!player) {
    log(bot, `Could not find ${username}.`);
    return false;
  }
  distance = Math.max(distance, 0.5);
  const goal = new pf.goals.GoalFollow(player, distance);
  await goToGoal(bot, goal, true);
  log(bot, `You have reached ${username}.`);
  return true;
}

export async function followPlayer(bot, username, distance = 4) {
  /** Follow the given player endlessly until interrupted. */
  const player = bot.players[username]?.entity;
  if (!player) return false;

  const move = new Movements(bot);
  move.digCost = 10;
  bot.pathfinder.setMovements(move);
  let doorCheckInterval = startDoorInterval(bot);

  bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
  log(bot, `You are now actively following player ${username}.`);

  while (!bot.interrupt_code) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const distance_from_player = bot.entity.position.distanceTo(player.position);
    const teleport_distance = 100;
    const ignore_modes_distance = 30;
    const nearby_distance = distance + 2;

    if (distance_from_player > teleport_distance && bot.modes.isOn("cheat")) {
      await goToPlayer(bot, username);
    } else if (distance_from_player > ignore_modes_distance) {
      bot.modes.pause("item_collecting");
      bot.modes.pause("hunting");
      bot.modes.pause("torch_placing");
    } else if (distance_from_player <= ignore_modes_distance) {
      bot.modes.unpause("item_collecting");
      bot.modes.unpause("hunting");
      bot.modes.unpause("torch_placing");
    }

    if (distance_from_player <= nearby_distance) {
      clearInterval(doorCheckInterval);
      doorCheckInterval = null;
      bot.modes.pause("unstuck");
      bot.modes.pause("elbow_room");
    } else {
      if (!doorCheckInterval) doorCheckInterval = startDoorInterval(bot);
      bot.modes.unpause("unstuck");
      bot.modes.unpause("elbow_room");
    }
  }
  clearInterval(doorCheckInterval);
  return true;
}

export async function moveAway(bot, distance) {
  /** Move away from the current position in any direction. */
  const pos = bot.entity.position;
  const goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
  const inverted_goal = new pf.goals.GoalInvert(goal);
  bot.pathfinder.setMovements(new Movements(bot));

  if (bot.modes.isOn("cheat")) {
    const move = new Movements(bot);
    const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
    const last_move = path.path[path.path.length - 1];
    if (last_move) {
      bot.chat("/tp @s " + Math.floor(last_move.x) + " " + Math.floor(last_move.y) + " " + Math.floor(last_move.z));
      return true;
    }
  }

  await goToGoal(bot, inverted_goal);
  log(bot, `Moved away from ${pos.floored()} to ${bot.entity.position.floored()}.`);
  return true;
}

export async function moveAwayFromEntity(bot, entity, distance = 16) {
  /** Move away from the given entity. */
  const goal = new pf.goals.GoalFollow(entity, distance);
  const inverted_goal = new pf.goals.GoalInvert(goal);
  bot.pathfinder.setMovements(new Movements(bot));
  await bot.pathfinder.goto(inverted_goal);
  return true;
}

export async function avoidEnemies(bot, distance = 16) {
  /** Move a given distance away from all nearby enemy mobs. */
  bot.modes.pause("self_preservation");
  let enemy = world.getNearestEntityWhere(bot, (entity) => mc.isHostile(entity), distance);
  while (enemy) {
    const follow = new pf.goals.GoalFollow(enemy, distance + 1);
    const inverted_goal = new pf.goals.GoalInvert(follow);
    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(inverted_goal, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    enemy = world.getNearestEntityWhere(bot, (entity) => mc.isHostile(entity), distance);
    if (bot.interrupt_code) break;
    if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) await attackEntity(bot, enemy, false);
  }
  bot.pathfinder.stop();
  log(bot, `Moved ${distance} away from enemies.`);
  return true;
}

export async function stay(bot, seconds = 30) {
  /** Stay in the current position until interrupted, with all reactive modes paused. */
  for (const mode of ["self_preservation", "unstuck", "cowardice", "self_defense", "hunting", "torch_placing", "item_collecting"]) {
    bot.modes.pause(mode);
  }
  const start = Date.now();
  while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds * 1000)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log(bot, `Stayed for ${(Date.now() - start) / 1000} seconds.`);
  return true;
}

export async function useDoor(bot, door_pos = null) {
  /** Open and walk through the door at the given position, or the nearest door if none given. */
  if (!door_pos) {
    for (const door_type of ["oak_door", "spruce_door", "birch_door", "jungle_door", "acacia_door", "dark_oak_door",
      "mangrove_door", "cherry_door", "bamboo_door", "crimson_door", "warped_door"]) {
      const found = world.getNearestBlock(bot, door_type, 16);
      if (found) {
        door_pos = found.position;
        break;
      }
    }
  } else {
    door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
  }
  if (!door_pos) {
    log(bot, `Could not find a door to use.`);
    return false;
  }

  bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  while (bot.pathfinder.isMoving()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const door_block = bot.blockAt(door_pos);
  await bot.lookAt(door_pos);
  if (!door_block._properties.open) await bot.activateBlock(door_block);

  bot.setControlState("forward", true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  bot.setControlState("forward", false);
  await bot.activateBlock(door_block);

  log(bot, `Used door at ${door_pos}.`);
  return true;
}

export async function goToBed(bot) {
  /** Sleep in the nearest bed. */
  // Routed through world.getNearestBlocksWhere() (previously a direct bot-level search) so a
  // found bed is recorded in world memory too, the same as every other block search in this file.
  const beds = world.getNearestBlocksWhere(bot, (block) => block.name.includes("bed"), 32, 1);
  if (beds.length === 0) {
    log(bot, `Could not find a bed to sleep in.`);
    return false;
  }
  const bed = beds[0];
  await goToPosition(bot, bed.position.x, bed.position.y, bed.position.z);
  await bot.sleep(bed);
  log(bot, `You are in bed.`);
  bot.modes.pause("unstuck");
  while (bot.isSleeping) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log(bot, `You have woken up.`);
  return true;
}

export async function tillAndSow(bot, x, y, z, seedType = null) {
  /** Till the ground at the given position and plant the given seed type. */
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  const block = bot.blockAt(pos);
  log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

  if (bot.modes.isOn("cheat")) {
    for (const remove of ["_seed", "_seeds"]) {
      if (seedType?.endsWith(remove)) seedType = seedType.replace(remove, "");
    }
    await placeBlock(bot, "farmland", x, y, z);
    await placeBlock(bot, seedType, x, y + 1, z);
    return true;
  }

  if (block.name !== "grass_block" && block.name !== "dirt" && block.name !== "farmland") {
    log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
    return false;
  }
  const above = bot.blockAt(new Vec3(x, y + 1, z));
  if (above.name !== "air") {
    if (block.name === "farmland") {
      log(bot, `Land is already farmed with ${above.name}.`);
      return true;
    }
    const broken = await breakBlockAt(bot, x, y + 1, z);
    if (!broken) {
      log(bot, `Cannot cannot break above block to till.`);
      return false;
    }
  }
  if (bot.entity.position.distanceTo(block.position) > 4.5) {
    const pos2 = block.position;
    bot.pathfinder.setMovements(new Movements(bot));
    await goToGoal(bot, new pf.goals.GoalNear(pos2.x, pos2.y, pos2.z, 4));
  }
  if (block.name !== "farmland") {
    const hoe = bot.inventory.items().find((item) => item.name.includes("hoe"));
    const to_equip = hoe?.name || "diamond_hoe";
    if (!(await equip(bot, to_equip))) {
      log(bot, `Cannot till, no hoes.`);
      return false;
    }
    await bot.activateBlock(block);
    log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
  }
  if (seedType) {
    if (seedType.endsWith("seed") && !seedType.endsWith("seeds")) seedType += "s";
    const equipped_seeds = await equip(bot, seedType);
    if (!equipped_seeds) {
      log(bot, `No ${seedType} to plant.`);
      return false;
    }
    await bot.activateBlock(block);
    log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
  }
  return true;
}

export async function activateNearestBlock(bot, type) {
  /** Activate (right-click) the nearest block of the given type. */
  const block = world.getNearestBlock(bot, type, 16);
  if (!block) {
    log(bot, `Could not find any ${type} to activate.`);
    return false;
  }
  if (bot.entity.position.distanceTo(block.position) > 4.5) {
    const pos = block.position;
    bot.pathfinder.setMovements(new Movements(bot));
    await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
  }
  await bot.activateBlock(block);
  log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
  return true;
}

async function findAndGoToVillager(bot, id) {
  id = id + "";
  const entity = bot.entities[id];
  if (!entity) {
    log(bot, `Cannot find villager with id ${id}`);
    const entities = world.getNearbyEntities(bot, 16);
    let villager_list = "Available villagers:\n";
    for (const e of entities) {
      if (e.name === "villager") {
        if (e.metadata && e.metadata[16] === 1) villager_list += `${e.id}: baby villager\n`;
        else villager_list += `${e.id}: ${world.getVillagerProfession(e)}\n`;
      }
    }
    if (villager_list === "Available villagers:\n") {
      log(bot, "No villagers found nearby.");
      return null;
    }
    log(bot, villager_list);
    return null;
  }
  if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
    log(bot, "Entity is not a villager");
    return null;
  }
  if (entity.metadata && entity.metadata[16] === 1) {
    log(bot, "This is either a baby villager or a villager with no job - neither can trade");
    return null;
  }
  const distance = bot.entity.position.distanceTo(entity.position);
  if (distance > 4) {
    log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
    try {
      bot.modes.pause("unstuck");
      const goal = new pf.goals.GoalFollow(entity, 2);
      await goToGoal(bot, goal);
      log(bot, "Successfully reached villager");
    } catch (err) {
      log(bot, "Failed to reach villager - pathfinding error or villager moved");
      return null;
    } finally {
      bot.modes.unpause("unstuck");
    }
  }
  return entity;
}

export async function showVillagerTrades(bot, id) {
  /** Show available trades for a specified villager entity id. */
  const villagerEntity = await findAndGoToVillager(bot, id);
  if (!villagerEntity) return false;
  try {
    const villager = await bot.openVillager(villagerEntity);
    if (!villager.trades || villager.trades.length === 0) {
      log(bot, "This villager has no trades available - might be sleeping, a baby, or jobless");
      villager.close();
      return false;
    }
    log(bot, `Villager has ${villager.trades.length} available trades:`);
    stringifyTrades(bot, villager.trades).forEach((trade, i) => log(bot, `${i + 1}: ${trade}`));
    villager.close();
    return true;
  } catch (err) {
    log(bot, "Failed to open villager trading interface - they might be sleeping, a baby, or jobless");
    return false;
  }
}

export async function tradeWithVillager(bot, id, index, count) {
  /** Trade with a specified villager: 1-based trade index, repeated `count` times. */
  const villagerEntity = await findAndGoToVillager(bot, id);
  if (!villagerEntity) return false;
  try {
    const villager = await bot.openVillager(villagerEntity);
    if (!villager.trades || villager.trades.length === 0) {
      log(bot, "This villager has no trades available - might be sleeping, a baby, or jobless");
      villager.close();
      return false;
    }
    const tradeIndex = parseInt(index) - 1;
    const trade = villager.trades[tradeIndex];
    if (!trade) {
      log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
      villager.close();
      return false;
    }
    if (trade.disabled) {
      log(bot, `Trade ${index} is currently disabled`);
      villager.close();
      return false;
    }
    const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2) + " " : "";
    log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
    const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
    const actualCount = Math.min(count, maxPossibleTrades);
    if (actualCount <= 0) {
      log(bot, `Trade ${index} has been used to its maximum limit`);
      villager.close();
      return false;
    }
    if (!hasResources(villager.slots, trade, actualCount)) {
      log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
      villager.close();
      return false;
    }
    try {
      await bot.trade(villager, tradeIndex, actualCount);
      log(bot, `Successfully traded ${actualCount} time(s)`);
      villager.close();
      return true;
    } catch (tradeErr) {
      log(bot, "An error occurred while trying to execute the trade");
      villager.close();
      return false;
    }
  } catch (err) {
    log(bot, "Failed to open villager trading interface");
    return false;
  }
}

function hasResources(window, trade, count) {
  const enough = (item) => {
    let c = 0;
    window.forEach((element) => {
      if (element && element.type === item.type && element.metadata === item.metadata) c += element.count;
    });
    return c >= item.count * count;
  };
  return enough(trade.inputItem1) && (!trade.inputItem2 || enough(trade.inputItem2));
}

function stringifyTrades(bot, trades) {
  return trades.map((trade) => {
    let text = stringifyItem(bot, trade.inputItem1);
    if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
    text += trade.disabled ? " x " : " » ";
    text += stringifyItem(bot, trade.outputItem);
    return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
  });
}

function stringifyItem(bot, item) {
  if (!item) return "nothing";
  let text = `${item.count} ${item.displayName}`;
  if (item.nbt && item.nbt.value) {
    const { ench, StoredEnchantments, Potion, display } = item.nbt.value;
    if (Potion) text += ` of ${Potion.value.replace(/_/g, " ").split(":")[1] || "unknown type"}`;
    if (display) text += ` named ${display.value.Name.value}`;
    if (ench || StoredEnchantments) {
      text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
        return bot.registry.enchantments[e.id.value].displayName + " " + e.lvl.value;
      }).join(" ")}`;
    }
  }
  return text;
}

export async function digDown(bot, distance = 10) {
  /** Dig straight down, stopping at lava, water, or a fall of >=3 blocks below. */
  const start_block_pos = bot.blockAt(bot.entity.position).position;
  for (let i = 1; i <= distance; i++) {
    const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
    let belowBlock = bot.blockAt(start_block_pos.offset(0, -i - 1, 0));
    if (!targetBlock || !belowBlock) {
      log(bot, `Dug down ${i - 1} blocks, but reached the end of the world.`);
      return true;
    }
    if (targetBlock.name === "lava" || targetBlock.name === "water" || belowBlock.name === "lava" || belowBlock.name === "water") {
      log(bot, `Dug down ${i - 1} blocks, but reached ${belowBlock ? belowBlock.name : "(lava/water)"}`);
      return false;
    }
    const MAX_FALL_BLOCKS = 2;
    let num_fall_blocks = 0;
    for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
      if (!belowBlock || (belowBlock.name !== "air" && belowBlock.name !== "cave_air")) break;
      num_fall_blocks++;
      belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
    }
    if (num_fall_blocks > MAX_FALL_BLOCKS) {
      log(bot, `Dug down ${i - 1} blocks, but reached a drop below the next block.`);
      return false;
    }
    if (targetBlock.name === "air" || targetBlock.name === "cave_air") continue;
    const dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
    if (!dug) {
      log(bot, "Failed to dig block at position:" + targetBlock.position);
      return false;
    }
  }
  log(bot, `Dug down ${distance} blocks.`);
  return true;
}

export async function goToSurface(bot) {
  /** Navigate to the surface (highest non-air block at the bot's current x,z). */
  const pos = bot.entity.position;
  for (let y = 360; y > -64; y--) {
    const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
    if (!block || block.name === "air" || block.name === "cave_air") continue;
    await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0);
    log(bot, `Going to the surface at y=${y + 1}.`);
    return true;
  }
  return false;
}

export async function useToolOn(bot, toolName, targetName) {
  /** Equip a tool and use it on the nearest matching target (entity type, block type, or "nothing"). */
  if (!bot.inventory.slots.find((slot) => slot && slot.name === toolName) && bot.game.gameMode !== "creative") {
    log(bot, `You do not have any ${toolName} to use.`);
    return false;
  }

  targetName = targetName.toLowerCase();
  if (targetName === "nothing") {
    const equipped = await equip(bot, toolName);
    if (!equipped) return false;
    await bot.activateItem();
    log(bot, `Used ${toolName}.`);
  } else if (world.isEntityType(bot, targetName)) {
    const entity = world.getNearestEntityWhere(bot, (e) => e.name === targetName, 64);
    if (!entity) {
      log(bot, `Could not find any ${targetName}.`);
      return false;
    }
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
    if (toolName === "hand") await bot.unequip("hand");
    else {
      const equipped = await equip(bot, toolName);
      if (!equipped) return false;
    }
    await bot.useOn(entity);
    log(bot, `Used ${toolName} on ${targetName}.`);
  } else {
    let block = null;
    if (targetName === "water" || targetName === "lava") {
      const blocks = world.getNearestBlocksWhere(bot, (b) => b.name === targetName && b.metadata === 0, 64, 1);
      if (blocks.length === 0) {
        log(bot, `Could not find any source ${targetName}.`);
        return false;
      }
      block = blocks[0];
    } else {
      block = world.getNearestBlock(bot, targetName, 64);
    }
    if (!block) {
      log(bot, `Could not find any ${targetName}.`);
      return false;
    }
    return await useToolOnBlock(bot, toolName, block);
  }
  return true;
}

export async function useToolOnBlock(bot, toolName, block) {
  /** Use a tool on a specific block reference. */
  const distance = toolName === "water_bucket" && block.name !== "lava" ? 1.5 : 2;
  await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

  const viewBlocked = () => {
    const blockInView = bot.blockAtCursor(5);
    const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
    return blockInView && !blockInView.position.equals(block.position) &&
      blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
  };
  if (viewBlocked()) {
    const blockedBy = bot.blockAtCursor(5);
    log(bot, `Block ${blockedBy.name} is in the way, moving closer...`);
    const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
    await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
    if (viewBlocked()) {
      const stillBlocked = bot.blockAtCursor(5);
      log(bot, `Block ${stillBlocked.name} is in the way, not using ${toolName}.`);
      return false;
    }
  }

  const equipped = await equip(bot, toolName);
  if (!equipped) {
    log(bot, `Could not equip ${toolName}.`);
    return false;
  }
  if (toolName.includes("bucket")) await bot.activateItem();
  else await bot.activateBlock(block);
  log(bot, `Used ${toolName} on ${block.name}.`);
  return true;
}
