// Version: 1.1.0
//
// 1.1.0 (2026-11-28): new instrumentDig() -- moved here from index.js so the wrap itself has a
// direct unit test. Found live, the first time a bot actually mined anything under the 4.7.0
// command-issuance fix: mineflayer's own `diggingCompleted` event fires with the block AFTER
// digging (confirmed from its digging.js source: it emits the post-blockUpdate block, air by
// definition), not the block destroyed -- every mined block was being recorded as block="air".
// Wrapping bot.dig() itself instead captures the real name from what the caller passed in, before
// the call; still the one chokepoint every dig path in skills.js funnels through, including
// mineflayer-collectblock's own internal bot.dig() call (confirmed in its source).
//
// 1.0.1 (2026-11-28): startMetricsServer's "no port configured" check used `!port`, so `port: 0`
// (a real, valid "let the OS pick one" request -- this file's own unit test uses it) was wrongly
// treated as disabled. Found by that same test. Now checks for undefined/null specifically.
//
// Per-bot action counters -- mobs killed, blocks placed, blocks mined, items crafted, distance
// traveled -- exposed as Prometheus text format on a dedicated HTTP listener. The Minecraft-bot
// analogue of hermes-router.py's own metrics-only listener (infra/firmament-observability/
// README.md §6) and TickScope's server-side mc_* metrics -- prefixed mc_bot_* here instead of
// mc_*, so "the server observed this" and "this bot did this" stay visually distinct in PromQL
// without a shared-prefix collision. See FIRMAMENT_OBSERVABILITY_PLAN.md and
// infra/minecraft-bots/README.md for the scrape-config/firewall side of this.
//
// In-memory only, reset on every restart -- the same convention every other counter in this fleet
// already uses (hermes-router.py's own counters, TickScope's). Prometheus's rate()/increase()
// already handle a counter reset correctly, so there's nothing to persist across restarts.

import http from "http";

const mobsKilled = new Map(); // mobType -> count
const blocksPlaced = new Map(); // blockType -> count
const blocksMined = new Map(); // blockType -> count
const itemsCrafted = new Map(); // itemType -> count
let distanceTraveledBlocks = 0;

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

export function recordMobKilled(mobType) {
  bump(mobsKilled, mobType, 1);
}

export function recordBlockPlaced(blockType) {
  bump(blocksPlaced, blockType, 1);
}

export function recordBlockMined(blockType) {
  bump(blocksMined, blockType, 1);
}

// Wraps bot.dig() in place so every dig this bot performs is recorded under the real block name
// it was called with -- not mineflayer's own post-dig `diggingCompleted` block (see this file's
// 1.1.0 changelog above for why that's always air). Recording happens only after the dig actually
// resolves; an aborted/rejected dig throws through the await and is never recorded.
export function instrumentDig(bot) {
  const originalDig = bot.dig.bind(bot);
  bot.dig = async (block, ...args) => {
    const minedBlockName = block?.name;
    await originalDig(block, ...args);
    if (minedBlockName) recordBlockMined(minedBlockName);
  };
}

// count is the real inventory delta (see skills.js's craftRecipe), not the number of craft
// operations -- one craft can yield more than one item, and a short-on-resources craft yields
// fewer than requested. A delta of 0 (or less) means nothing was actually produced; don't record it.
export function recordItemsCrafted(itemType, count = 1) {
  if (count > 0) bump(itemsCrafted, itemType, count);
}

// blocks is a per-tick position delta the caller has already sanity-checked against teleports
// (index.js's physicsTick handler skips implausibly large jumps -- death/respawn, /tp rescue).
// A non-positive value here would only come from a caller bug, not real movement; ignore it rather
// than let the counter run backwards.
export function addDistanceTraveled(blocks) {
  if (blocks > 0) distanceTraveledBlocks += blocks;
}

// For tests only -- lets a check reset state between cases without reaching into this module's
// own closed-over Maps.
export function _resetForTest() {
  mobsKilled.clear();
  blocksPlaced.clear();
  blocksMined.clear();
  itemsCrafted.clear();
  distanceTraveledBlocks = 0;
}

function escapeLabel(value) {
  return JSON.stringify(String(value));
}

function renderFamily(name, help, botLabel, typeLabelName, map) {
  let out = `# HELP ${name} ${help}\n# TYPE ${name} counter\n`;
  for (const [key, count] of map) {
    out += `${name}{bot=${escapeLabel(botLabel)},${typeLabelName}=${escapeLabel(key)}} ${count}\n`;
  }
  return out;
}

export function renderMetrics(botLabel) {
  let out = "";
  out += renderFamily("mc_bot_mobs_killed_total", "Mobs killed by this bot, by mob type.", botLabel, "mob", mobsKilled);
  out += renderFamily("mc_bot_blocks_placed_total", "Blocks placed by this bot, by block type.", botLabel, "block", blocksPlaced);
  out += renderFamily("mc_bot_blocks_mined_total", "Blocks mined (dug to completion) by this bot, by block type.", botLabel, "block", blocksMined);
  out += renderFamily("mc_bot_items_crafted_total", "Items crafted by this bot at a crafting table, by item type.", botLabel, "item", itemsCrafted);
  out += "# HELP mc_bot_distance_traveled_blocks_total Total distance this bot has moved, in blocks (3D, summed per physics tick; teleports excluded).\n" +
    "# TYPE mc_bot_distance_traveled_blocks_total counter\n" +
    `mc_bot_distance_traveled_blocks_total{bot=${escapeLabel(botLabel)}} ${distanceTraveledBlocks.toFixed(2)}\n`;
  return out;
}

// MC_BOT_METRICS_PORT unset (local dev, tests) -> no listener; index.js only calls this with a
// port when that env var is set, so a bot running without it behaves exactly as before. Bound
// 0.0.0.0 by default -- Prometheus runs on HomeD13, not co-located with any bot host, same as
// node_exporter/hermes-router's own Sparks instances; the firewall boundary is each Spark's own
// ufw (see infra/minecraft-bots/README.md), not the bind address.
export function startMetricsServer(botLabel, { port, bind = "0.0.0.0" } = {}) {
  if (port === undefined || port === null) return null; // port 0 (OS-assigned, used by this file's own test) is a real, valid request -- not "disabled"
  const server = http.createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(renderMetrics(botLabel));
  });
  server.listen(port, bind);
  return server;
}
