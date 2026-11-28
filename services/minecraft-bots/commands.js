// Version: 1.1.0
//
// 1.1.0 (2026-11-27, diagnosability audit): real bug fix, not just a logging improvement --
// performCommand() returned a bare true/false/undefined from most skills.js functions, which
// narrate what actually happened via log(bot, ...) into bot.output instead of their return value
// (e.g. viewChest's own item listing). That narration reached neither the model nor an operator
// reading the journal. New describeOutcome(bot, result) (exported for direct testing) prefers
// bot.output.trim() when the command's own call left anything there.
//
// 1.0.1 (2026-11-27, Phase 4 integration fix): !stop now sets bot.interrupt_code and calls
// arbiter.cancelAndClear() -- skills.js's own long-running loops (digDown, tillAndSow, goToGoal's
// retry loop, ...) check bot.interrupt_code to bail early and skills.js hadn't landed yet when
// this file was first written, so the original port only stopped the current primitive, not a
// multi-step skill in progress.
//
// Ported from kolbytn/mindcraft's src/agent/commands/{index,actions,queries}.js (MIT) as part of
// MINECRAFT_BOTS_RESTART_PLAN.md Phase 4 -- the `!commandName(args)` parsing convention, the
// command registry shape (name/description/params/perform), and the command-docs generator that
// feeds a persona's system prompt, all kept close to the original. Mindcraft's own `agent` wrapper
// (agent.actions/self_prompter/memory_bank/vision_interpreter/coder, its mindserver-based
// convoManager) is NOT ported -- this project keeps its own bot-to-bot coordination (buzz.js,
// kept) and arbitration (arbiter.js, kept) instead of adopting Mindcraft's. Every `perform()` here
// takes `bot` directly, not an agent object, and state-changing commands are dispatched through
// `performCommand()` below, which acquires arbiter control at a tier the CALLER picks (so
// index.js can tell a player-issued command from the bot's own self-chosen step) rather than a
// tier hardcoded per command the way Mindcraft's own runAsAction() always used one.
//
// Commands intentionally NOT ported, and why:
// - !newAction: Mindcraft's "write and execute arbitrary JS" mode. A materially different
//   architecture/security posture than this project's fixed, reviewable action set -- adopting it
//   silently would be a bigger change than "port the skill library," so it's left out rather than
//   folded in without a decision.
// - !stfu/!restart/!clearChat: Mindcraft's own process-lifecycle controls; this project's bot
//   process lifecycle is systemd/run-bot.sh's job.
// - !rememberHere/!goToRememberedPlace: needs Mindcraft's memory_bank, not ported this phase.
// - !goal/!endGoal: Mindcraft's continuous self-prompter; superseded by index.js's own tick loop
//   (being rewritten separately) calling the LLM on a cadence -- that loop IS the self-prompting.
// - !setMode/!modes: needs a modes registry; modes.js (reactive behavior checks) is being ported
//   in a separate change and isn't wired up yet. Revisit once it lands.
// - !startConversation/!endConversation/!lookAtPlayer/!lookAtPosition: Mindcraft's own multi-bot
//   conversation/vision layer. This project already has its own bot-to-bot coordination (Buzz,
//   kept) and no vision/image-analysis capability; not adopting Mindcraft's in its place.
// - !checkBlueprintLevel/!checkBlueprint/!getBlueprint/!getBlueprintLevel: Mindcraft's
//   construction-task system; this project has no equivalent "blueprint" task concept.
// - !getCraftingPlan: needs Mindcraft's own mcdata.js getDetailedCraftingPlan(), not ported.

import * as skills from "./skills.js";
import * as world from "./world.js";
import { OWNERS, cancelAndClear, requestControl, releaseControl } from "./arbiter.js";
import { equipBestArmor, equipBestWeapon } from "./equipment.js";

// --- Minecraft name validation (BlockName/ItemName param types) ------------------------------
// Mindcraft's own parser validates block/item names against a fixed minecraft-data snapshot at
// parse time (before a bot/connection exists). minecraft-data is a transitive dependency of
// mineflayer (already installed, not added here) -- loaded once at module load (ESM top-level
// await) and defensively: if it can't be resolved for any reason, validation is skipped rather
// than crashing command parsing.
let mcNames = { blocks: null, items: null };
try {
  const mcDataModule = await import("minecraft-data");
  const mcData = mcDataModule.default("1.21.1");
  mcNames = { blocks: mcData.blocksByName, items: mcData.itemsByName };
} catch (err) {
  console.error("[commands] minecraft-data unavailable, skipping block/item name validation:", err.message);
}
function getBlockId(name) {
  if (!mcNames.blocks) return 0; // validation disabled -- treat as always-valid
  return mcNames.blocks[name]?.id ?? null;
}
function getItemId(name) {
  if (!mcNames.items) return 0;
  return mcNames.items[name]?.id ?? null;
}

// --- Registry ----------------------------------------------------------------------------------

export const queryList = [
  {
    name: "!stats",
    description: "Get the bot's location, health, hunger, and time of day.",
    perform: (bot) => {
      const pos = bot.entity.position;
      let res = "STATS";
      res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
      res += `\n- Gamemode: ${bot.game.gameMode}`;
      res += `\n- Health: ${Math.round(bot.health)} / 20`;
      res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
      res += `\n- Biome: ${world.getBiomeName(bot)}`;
      let weather = "Clear";
      if (bot.rainState > 0) weather = "Rain";
      if (bot.thunderState > 0) weather = "Thunderstorm";
      res += `\n- Weather: ${weather}`;
      res += bot.time.timeOfDay < 6000 ? "\n- Time: Morning"
        : bot.time.timeOfDay < 12000 ? "\n- Time: Afternoon" : "\n- Time: Night";
      const players = world.getNearbyPlayerNames(bot);
      res += "\n- Nearby Players: " + (players.length > 0 ? players.join(", ") : "None.");
      return res;
    },
  },
  {
    name: "!inventory",
    description: "Get the bot's inventory and what it's wearing.",
    perform: (bot) => {
      const inventory = world.getInventoryCounts(bot);
      let res = "INVENTORY";
      for (const item in inventory) {
        if (inventory[item] > 0) res += `\n- ${item}: ${inventory[item]}`;
      }
      if (res === "INVENTORY") res += ": Nothing";
      const [helmet, chestplate, leggings, boots] = [5, 6, 7, 8].map((i) => bot.inventory.slots[i]);
      res += "\nWEARING: ";
      if (helmet) res += `\nHead: ${helmet.name}`;
      if (chestplate) res += `\nTorso: ${chestplate.name}`;
      if (leggings) res += `\nLegs: ${leggings.name}`;
      if (boots) res += `\nFeet: ${boots.name}`;
      if (!helmet && !chestplate && !leggings && !boots) res += "Nothing";
      return res;
    },
  },
  {
    name: "!nearbyBlocks",
    description: "Get the blocks near the bot.",
    perform: (bot) => {
      let res = "NEARBY_BLOCKS";
      const blocks = world.getNearestBlocks(bot);
      const details = new Set();
      for (const block of blocks) {
        let d = block.name;
        if (block.name === "water" || block.name === "lava") d += block.metadata === 0 ? " (source)" : " (flowing)";
        details.add(d);
      }
      if (details.size === 0) return res + ": none";
      for (const d of details) res += `\n- ${d}`;
      return res;
    },
  },
  {
    name: "!craftable",
    description: "Get the items the bot can currently craft.",
    perform: (bot) => {
      const craftable = world.getCraftableItems(bot);
      let res = "CRAFTABLE_ITEMS";
      for (const item of craftable) res += `\n- ${item}`;
      return craftable.length ? res : res + ": none";
    },
  },
  {
    name: "!entities",
    description: "Get the nearby players and entities.",
    perform: (bot) => {
      let res = "NEARBY_ENTITIES";
      for (const player of world.getNearbyPlayerNames(bot)) res += `\n- Player: ${player}`;
      const counts = {};
      for (const entity of world.getNearbyEntities(bot)) {
        if (entity.type === "player" || entity.name === "item") continue;
        counts[entity.name] = (counts[entity.name] ?? 0) + 1;
      }
      for (const [name, count] of Object.entries(counts)) res += `\n- entities: ${count} ${name}(s)`;
      return res;
    },
  },
  {
    name: "!searchWiki",
    description: "Search the Minecraft Wiki for the given query.",
    params: { query: { type: "string", description: "The query to search for." } },
    perform: async (bot, query) => {
      try {
        const res = await fetch(`https://minecraft.wiki/w/${query}`);
        if (res.status === 404) return `${query} was not found on the Minecraft Wiki.`;
        const html = await res.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return text.slice(0, 4000);
      } catch (err) {
        return `Error fetching the wiki: ${err.message}`;
      }
    },
  },
  {
    name: "!help",
    description: "List all available commands and their descriptions.",
    perform: () => getCommandDocs(),
  },
];

export const actionsList = [
  {
    name: "!goToPlayer",
    description: "Go to the given player.",
    params: {
      player_name: { type: "string", description: "The name of the player to go to." },
      closeness: { type: "float", description: "How close to get to the player.", domain: [0, Infinity] },
    },
    perform: (bot, player_name, closeness) => skills.goToPlayer(bot, player_name, closeness),
  },
  {
    name: "!followPlayer",
    description: "Endlessly follow the given player.",
    params: {
      player_name: { type: "string", description: "Name of the player to follow." },
      follow_dist: { type: "float", description: "The distance to follow from.", domain: [0, Infinity] },
    },
    perform: (bot, player_name, follow_dist) => skills.followPlayer(bot, player_name, follow_dist),
  },
  {
    name: "!goToCoordinates",
    description: "Go to the given x, y, z location.",
    params: {
      x: { type: "float", description: "The x coordinate.", domain: [-Infinity, Infinity] },
      y: { type: "float", description: "The y coordinate.", domain: [-64, 320] },
      z: { type: "float", description: "The z coordinate.", domain: [-Infinity, Infinity] },
      closeness: { type: "float", description: "How close to get to the location.", domain: [0, Infinity] },
    },
    perform: (bot, x, y, z, closeness) => skills.goToPosition(bot, x, y, z, closeness),
  },
  {
    name: "!searchForBlock",
    description: "Find and go to the nearest block of a given type in a given range.",
    params: {
      type: { type: "BlockName", description: "The block type to go to." },
      search_range: { type: "float", description: "The range to search. Minimum 32.", domain: [10, 512] },
    },
    perform: (bot, block_type, range) => skills.goToNearestBlock(bot, block_type, 4, Math.max(range, 32)),
  },
  {
    name: "!searchForEntity",
    description: "Find and go to the nearest entity of a given type in a given range.",
    params: {
      type: { type: "string", description: "The type of entity to go to." },
      search_range: { type: "float", description: "The range to search for the entity.", domain: [32, 512] },
    },
    perform: (bot, entity_type, range) => skills.goToNearestEntity(bot, entity_type, 4, range),
  },
  {
    name: "!moveAway",
    description: "Move away from the current location in any direction by a given distance.",
    params: { distance: { type: "float", description: "The distance to move away.", domain: [0, Infinity] } },
    perform: (bot, distance) => skills.moveAway(bot, distance),
  },
  {
    name: "!givePlayer",
    description: "Give the specified item to the given player.",
    params: {
      player_name: { type: "string", description: "The name of the player to give the item to." },
      item_name: { type: "ItemName", description: "The name of the item to give." },
      num: { type: "int", description: "The number of items to give.", domain: [1, Number.MAX_SAFE_INTEGER] },
    },
    perform: (bot, player_name, item_name, num) => skills.giveToPlayer(bot, item_name, player_name, num),
  },
  {
    name: "!consume",
    description: "Eat/drink the given item.",
    params: { item_name: { type: "ItemName", description: "The name of the item to consume." } },
    perform: (bot, item_name) => skills.consume(bot, item_name),
  },
  {
    name: "!equip",
    description: "Equip the given item by name. For the best armor/weapon the bot already owns, use !equipBestGear instead.",
    params: { item_name: { type: "ItemName", description: "The name of the item to equip." } },
    perform: (bot, item_name) => skills.equip(bot, item_name),
  },
  {
    name: "!equipBestGear",
    description: "Wear the best armor and wield the best weapon currently in inventory.",
    perform: async (bot) => {
      await equipBestArmor(bot);
      await equipBestWeapon(bot);
      return "Equipped the best available armor and weapon.";
    },
  },
  {
    name: "!putInChest",
    description: "Put the given item in the nearest chest.",
    params: {
      item_name: { type: "ItemName", description: "The name of the item to put in the chest." },
      num: { type: "int", description: "The number of items to put in the chest.", domain: [1, Number.MAX_SAFE_INTEGER] },
    },
    perform: (bot, item_name, num) => skills.putInChest(bot, item_name, num),
  },
  {
    name: "!takeFromChest",
    description: "Take the given items from the nearest chest.",
    params: {
      item_name: { type: "ItemName", description: "The name of the item to take." },
      num: { type: "int", description: "The number of items to take.", domain: [1, Number.MAX_SAFE_INTEGER] },
    },
    perform: (bot, item_name, num) => skills.takeFromChest(bot, item_name, num),
  },
  {
    name: "!viewChest",
    description: "View the items/counts of the nearest chest.",
    perform: (bot) => skills.viewChest(bot),
  },
  {
    name: "!discard",
    description: "Discard the given item from the inventory.",
    params: {
      item_name: { type: "ItemName", description: "The name of the item to discard." },
      num: { type: "int", description: "The number of items to discard.", domain: [1, Number.MAX_SAFE_INTEGER] },
    },
    perform: (bot, item_name, num) => skills.discard(bot, item_name, num),
  },
  {
    name: "!collectBlocks",
    description: "Collect the nearest blocks of a given type.",
    params: {
      type: { type: "BlockName", description: "The block type to collect." },
      num: { type: "int", description: "The number of blocks to collect.", domain: [1, Number.MAX_SAFE_INTEGER] },
    },
    perform: (bot, type, num) => skills.collectBlock(bot, type, num),
  },
  {
    name: "!craftRecipe",
    description: "Craft the given recipe a given number of times.",
    params: {
      recipe_name: { type: "ItemName", description: "The name of the output item to craft." },
      num: { type: "int", description: "Number of times to craft the recipe (not the output count).", domain: [1, Number.MAX_SAFE_INTEGER] },
    },
    perform: (bot, recipe_name, num) => skills.craftRecipe(bot, recipe_name, num),
  },
  {
    name: "!smeltItem",
    description: "Smelt the given item the given number of times.",
    params: {
      item_name: { type: "ItemName", description: "The name of the input item to smelt." },
      num: { type: "int", description: "The number of times to smelt the item.", domain: [1, Number.MAX_SAFE_INTEGER] },
    },
    perform: (bot, item_name, num) => skills.smeltItem(bot, item_name, num),
  },
  {
    name: "!clearFurnace",
    description: "Take all items out of the nearest furnace.",
    perform: (bot) => skills.clearNearestFurnace(bot),
  },
  {
    name: "!placeHere",
    description: "Place a given block at the current location. Not for structures -- single blocks/torches only.",
    params: { type: { type: "BlockOrItemName", description: "The block type to place." } },
    perform: (bot, type) => {
      const pos = bot.entity.position;
      return skills.placeBlock(bot, type, pos.x, pos.y, pos.z);
    },
  },
  {
    name: "!attack",
    description: "Attack and kill the nearest entity of a given type.",
    params: { type: { type: "string", description: "The type of entity to attack." } },
    perform: (bot, type) => skills.attackNearest(bot, type, true),
  },
  {
    name: "!goToBed",
    description: "Go to the nearest bed and sleep.",
    perform: (bot) => skills.goToBed(bot),
  },
  {
    name: "!stay",
    description: "Stay in the current location no matter what.",
    params: { seconds: { type: "int", description: "Seconds to stay. -1 for forever.", domain: [-1, Number.MAX_SAFE_INTEGER] } },
    perform: (bot, seconds) => skills.stay(bot, seconds),
  },
  {
    name: "!showVillagerTrades",
    description: "Show trades of a specified villager.",
    params: { id: { type: "int", description: "The id number of the villager to trade with." } },
    perform: (bot, id) => skills.showVillagerTrades(bot, id),
  },
  {
    name: "!tradeWithVillager",
    description: "Trade with a specified villager.",
    params: {
      id: { type: "int", description: "The id number of the villager to trade with." },
      index: { type: "int", description: "The trade index to execute (1-indexed).", domain: [1, Number.MAX_SAFE_INTEGER] },
      count: { type: "int", description: "How many times to execute that trade.", domain: [1, Number.MAX_SAFE_INTEGER] },
    },
    perform: (bot, id, index, count) => skills.tradeWithVillager(bot, id, index, count),
  },
  {
    name: "!digDown",
    description: "Dig down a specified distance. Stops at lava, water, or a >=4 block fall below the bot.",
    params: { distance: { type: "int", description: "Distance to dig down.", domain: [1, Number.MAX_SAFE_INTEGER] } },
    perform: (bot, distance) => skills.digDown(bot, distance),
  },
  {
    name: "!goToSurface",
    description: "Move the bot to the highest block above it (usually the surface).",
    perform: (bot) => skills.goToSurface(bot),
  },
  {
    name: "!useOn",
    description: "Use (right-click) the given tool on the nearest target of the given type.",
    params: {
      tool_name: { type: "string", description: 'Name of the tool to use, or "hand" for none.' },
      target: { type: "string", description: 'Target as an entity type, block type, or "nothing".' },
    },
    perform: (bot, tool_name, target) => skills.useToolOn(bot, tool_name, target),
  },
  {
    name: "!stop",
    description: "Force-stop whatever the bot is currently doing.",
    // Integration fix (Phase 4 wiring, after skills.js landed): the ported skill functions in
    // skills.js check `bot.interrupt_code` inside their own loops to bail out early -- Mindcraft's
    // own `!stop` sets that flag for exactly this reason. Mechanically stopping the pathfinder/pvp/
    // digging alone (the original port) only stops the *current primitive*, not a skill like
    // `digDown` or `tillAndSow` that loops calling several primitives in turn; without the flag and
    // without cancelAndClear() releasing whoever holds arbiter control, those loops kept running.
    perform: (bot) => {
      bot.interrupt_code = true;
      cancelAndClear(bot);
      bot.pathfinder.setGoal(null);
      if (bot.pvp?.target) bot.pvp.stop();
      bot.collectBlock?.cancelTask?.();
      bot.stopDigging();
      bot.clearControlStates();
      setTimeout(() => { bot.interrupt_code = false; }, 500);
      return "Stopped.";
    },
  },
];

const commandList = [...queryList, ...actionsList];
const commandMap = {};
for (const command of commandList) commandMap[command.name] = command;
const queryNames = new Set(queryList.map((c) => c.name));

export function getCommand(name) {
  return commandMap[name];
}

export function isAction(name) {
  return !queryNames.has(name) && commandMap[name] !== undefined;
}

// --- Parsing (ported near-verbatim from Mindcraft's own regex approach) ------------------------

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/;
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

export function containsCommand(message) {
  const m = message.match(commandRegex);
  return m ? "!" + m[1] : null;
}

export function commandExists(name) {
  if (!name.startsWith("!")) name = "!" + name;
  return commandMap[name] !== undefined;
}

export function truncCommandMessage(message) {
  const m = message.match(commandRegex);
  return m ? message.substring(0, m.index + m[0].length) : message;
}

function parseBoolean(input) {
  switch (input.toLowerCase()) {
    case "false": case "f": case "0": case "off": return false;
    case "true": case "t": case "1": case "on": return true;
    default: return null;
  }
}

function checkInInterval(n, lo, hi, kind) {
  switch (kind) {
    case "[)": return lo <= n && n < hi;
    case "()": return lo < n && n < hi;
    case "(]": return lo < n && n <= hi;
    case "[]": return lo <= n && n <= hi;
    default: throw new Error("Unknown endpoint type: " + kind);
  }
}

/** Parses a `!commandName(args)` message. Returns `{ commandName, args }` or an error string. */
export function parseCommandMessage(message) {
  const m = message.match(commandRegex);
  if (!m) return "Command is incorrectly formatted";

  const commandName = "!" + m[1];
  const command = getCommand(commandName);
  if (!command) return `${commandName} is not a command.`;

  const paramEntries = command.params ? Object.entries(command.params) : [];
  const rawArgs = m[2] ? m[2].match(argRegex) ?? [] : [];
  if (rawArgs.length !== paramEntries.length) {
    return `Command ${commandName} was given ${rawArgs.length} args, but requires ${paramEntries.length} args.`;
  }

  const args = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const [paramName, param] = paramEntries[i];
    let arg = rawArgs[i].trim();
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      arg = arg.substring(1, arg.length - 1);
    }
    switch (param.type) {
      case "int": arg = Number.parseInt(arg, 10); break;
      case "float": arg = Number.parseFloat(arg); break;
      case "boolean": arg = parseBoolean(arg); break;
      case "BlockName": case "BlockOrItemName": case "ItemName": case "string": break;
      default: throw new Error(`Command '${commandName}' param '${paramName}' has an unknown type: ${param.type}`);
    }
    if (arg === null || Number.isNaN(arg)) return `Error: Param '${paramName}' must be of type ${param.type}.`;

    if (typeof arg === "number" && param.domain) {
      const domain = param.domain.length === 3 ? param.domain : [...param.domain, "[)"];
      if (!checkInInterval(arg, domain[0], domain[1], domain[2])) {
        return `Error: Param '${paramName}' must be in ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
      }
    } else if (param.type === "BlockName" && getBlockId(arg) === null) {
      return `Invalid block type: ${arg}.`;
    } else if (param.type === "ItemName" && getItemId(arg) === null) {
      return `Invalid item type: ${arg}.`;
    } else if (param.type === "BlockOrItemName" && getBlockId(arg) === null && getItemId(arg) === null) {
      return `Invalid block or item type: ${arg}.`;
    }
    args.push(arg);
  }
  return { commandName, args };
}

// --- Dispatch ------------------------------------------------------------------------------------

/**
 * Runs the named command against `bot`. Query commands (read-only, `queryList`) run directly.
 * Action commands (state-changing, `actionsList`) go through `arbiter.requestControl()` first --
 * `opts.tier` picks which OWNERS tier to request (default `OWNERS.DIRECT_COMMAND`, for a
 * player/LLM-issued instruction; pass `OWNERS.GOAL_STEP` for the bot's own self-chosen step).
 * Returns the command's result text, or an error string if control couldn't be acquired or the
 * command threw.
 */
// Direct finding, 2026-11-27 (diagnosability audit): most skills.js functions narrate what
// actually happened via log(bot, ...) into bot.output (e.g. viewChest's own item listing,
// craftRecipe's chain-crafting steps) and then return a bare true/false success flag -- that
// narration, not the boolean, is the result worth seeing. Every caller here reset bot.output to
// "" immediately before calling performCommand/executeCommand (index.js), so by the time a
// command's own perform() runs it starts clean; whatever landed there during this one call is
// this command's own real result text.
export function describeOutcome(bot, result) {
  const narrated = bot.output?.trim();
  return narrated || (result ?? "Done.");
}

export async function performCommand(bot, commandName, args = [], opts = {}) {
  const command = getCommand(commandName);
  if (!command) return `${commandName} is not a command.`;

  if (!isAction(commandName)) {
    try {
      return describeOutcome(bot, await command.perform(bot, ...args));
    } catch (err) {
      return `Error running ${commandName}: ${err.message}`;
    }
  }

  const tier = opts.tier ?? OWNERS.DIRECT_COMMAND;
  const handle = await requestControl(bot, tier, opts);
  if (!handle) return `${commandName} could not get control of the bot (something higher-priority is active).`;
  try {
    return describeOutcome(bot, await command.perform(bot, ...args));
  } catch (err) {
    return `Error running ${commandName}: ${err.message}`;
  } finally {
    releaseControl(handle);
  }
}

/** Parses then runs a `!commandName(args)` message. See `performCommand` for `opts`. */
export async function executeCommand(bot, message, opts = {}) {
  const parsed = parseCommandMessage(message);
  if (typeof parsed === "string") return parsed;
  return performCommand(bot, parsed.commandName, parsed.args, opts);
}

const TYPE_LABELS = { float: "number", int: "number", BlockName: "string", ItemName: "string", BlockOrItemName: "string", boolean: "bool" };

/** Command-docs text block for a persona's system prompt (Mindcraft profiles' `$COMMAND_DOCS`). */
export function getCommandDocs() {
  let docs = "\n*COMMAND DOCS\nUse commands with the syntax: !commandName or !commandName(\"arg1\", 1.2, ...).\n" +
    "Use double quotes for strings. Only use one command per response.\n";
  for (const command of commandList) {
    docs += `${command.name}: ${command.description}\n`;
    if (command.params) {
      docs += "Params:\n";
      for (const [name, param] of Object.entries(command.params)) {
        docs += `${name}: (${TYPE_LABELS[param.type] ?? param.type}) ${param.description}\n`;
      }
    }
  }
  return docs + "*\n";
}
