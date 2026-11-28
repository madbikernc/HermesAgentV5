// Version: 1.2.0
//
// 1.2.0 (2026-11-28): checks for instrumentDig() (metrics.js 1.1.0) -- found live that
// mineflayer's own diggingCompleted event fires with the post-dig block (air), not the one
// destroyed, so every mined block was being recorded wrong. instrumentDig() wraps bot.dig()
// itself instead, using a bare {dig} mock object -- no real mineflayer bot needed for this.
//
// 1.1.0 (2026-11-28): dropped the _harness.mjs import -- importing it currently throws at module
// load (ENOENT on action-search.js/action-movement.js/...), a pre-existing break unrelated to this
// file: _harness.mjs still eagerly reads several archived action-*.js files that no longer exist
// in services/minecraft-bots/ since MINECRAFT_BOTS_RESTART_PLAN.md Phase 5 moved them to
// services/minecraft-bots-archive-11-2026/. Confirmed on dgx-spark that every existing area file
// (faults.test.mjs included) fails the same way at HEAD, independent of this change -- not
// something to silently paper over here, and a real fix for _harness.mjs itself is a separate,
// larger task than "add Prometheus metrics." This file uses plain node:test instead, so it runs
// standalone regardless of that harness's state; still registered in unit.test.mjs for whenever
// _harness.mjs itself is fixed.
//
// 1.0.0 (2026-11-28): initial checks for metrics.js (1.0.0) -- the per-bot Prometheus action
// counters (mobs killed, blocks placed/mined, items crafted, distance traveled) and their HTTP
// exposition. No mineflayer dependency, so this imports the real module directly.
// Run every file: node tests/unit.test.mjs; this one alone: node --test tests/unit/metrics.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as metrics from '../../metrics.js';

test('Metrics: mob kills accumulate per mob type, per bot label', () => {
  metrics._resetForTest();
  metrics.recordMobKilled('zombie');
  metrics.recordMobKilled('zombie');
  metrics.recordMobKilled('skeleton');
  const out = metrics.renderMetrics('Babs_Miner');
  assert.match(out, /mc_bot_mobs_killed_total\{bot="Babs_Miner",mob="zombie"\} 2\n/);
  assert.match(out, /mc_bot_mobs_killed_total\{bot="Babs_Miner",mob="skeleton"\} 1\n/);
});

test('Metrics: blocks placed and blocks mined are separate counters', () => {
  metrics._resetForTest();
  metrics.recordBlockPlaced('torch');
  metrics.recordBlockMined('stone');
  metrics.recordBlockMined('stone');
  const out = metrics.renderMetrics('Amy_Builder');
  assert.match(out, /mc_bot_blocks_placed_total\{bot="Amy_Builder",block="torch"\} 1\n/);
  assert.match(out, /mc_bot_blocks_mined_total\{bot="Amy_Builder",block="stone"\} 2\n/);
});

test('Metrics: items crafted accumulates by the real inventory delta, ignoring a zero delta', () => {
  metrics._resetForTest();
  metrics.recordItemsCrafted('stick', 4);
  metrics.recordItemsCrafted('stick', 2);
  metrics.recordItemsCrafted('torch', 0); // craftRecipe() passes the real before/after delta -- 0 means nothing was actually produced
  const out = metrics.renderMetrics('Bob_Farmer');
  assert.match(out, /mc_bot_items_crafted_total\{bot="Bob_Farmer",item="stick"\} 6\n/);
  assert.doesNotMatch(out, /item="torch"/);
});

test('Metrics: distance traveled accumulates and ignores a non-positive delta', () => {
  metrics._resetForTest();
  metrics.addDistanceTraveled(3.5);
  metrics.addDistanceTraveled(1.25);
  metrics.addDistanceTraveled(-5); // a caller bug, not real movement -- must not run the counter backwards
  const out = metrics.renderMetrics('Wade_Explorer');
  assert.match(out, /mc_bot_distance_traveled_blocks_total\{bot="Wade_Explorer"\} 4\.75\n/);
});

test('Metrics: a label value with a double quote is escaped, not left as broken Prometheus text', () => {
  metrics._resetForTest();
  metrics.recordMobKilled('weird"mob');
  const out = metrics.renderMetrics('Babs_Miner');
  assert.match(out, /mob="weird\\"mob"/);
});

test('Metrics: startMetricsServer serves real Prometheus text on /metrics and 404s elsewhere', async () => {
  metrics._resetForTest();
  metrics.recordMobKilled('creeper');
  const server = metrics.startMetricsServer('Babs_Miner', { port: 0, bind: '127.0.0.1' });
  assert.ok(server, 'a server should start when a port is given');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/metrics`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    assert.match(body, /mc_bot_mobs_killed_total\{bot="Babs_Miner",mob="creeper"\} 1\n/);
    const notFoundStatus = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/other`, (res) => resolve(res.statusCode)).on('error', reject);
    });
    assert.equal(notFoundStatus, 404);
  } finally {
    server.close();
  }
});

test('Metrics: startMetricsServer is a no-op when no port is configured (local dev/tests)', () => {
  assert.equal(metrics.startMetricsServer('Babs_Miner', {}), null);
});

test('Metrics: instrumentDig records the real pre-dig block name, not mineflayer\'s own post-dig one', async () => {
  metrics._resetForTest();
  const bot = { dig: async (block) => { /* real mineflayer would emit diggingCompleted(airBlock) here */ } };
  metrics.instrumentDig(bot);
  await bot.dig({ name: 'oak_leaves' });
  await bot.dig({ name: 'oak_leaves' });
  await bot.dig({ name: 'grass_block' });
  const out = metrics.renderMetrics('Babs_Miner');
  assert.match(out, /mc_bot_blocks_mined_total\{bot="Babs_Miner",block="oak_leaves"\} 2\n/);
  assert.match(out, /mc_bot_blocks_mined_total\{bot="Babs_Miner",block="grass_block"\} 1\n/);
  assert.doesNotMatch(out, /block="air"/);
});

test('Metrics: instrumentDig does not record an aborted/rejected dig', async () => {
  metrics._resetForTest();
  const bot = { dig: async () => { throw new Error('Digging aborted'); } };
  metrics.instrumentDig(bot);
  await assert.rejects(() => bot.dig({ name: 'stone' }));
  const out = metrics.renderMetrics('Babs_Miner');
  assert.doesNotMatch(out, /blocks_mined_total\{bot="Babs_Miner",block="stone"\}/);
});

test('Metrics: instrumentDig forwards extra arguments to the original bot.dig', async () => {
  metrics._resetForTest();
  let seenArgs = null;
  const bot = { dig: async (block, ...args) => { seenArgs = args; } };
  metrics.instrumentDig(bot);
  await bot.dig({ name: 'stone' }, true, 'auto');
  assert.deepEqual(seenArgs, [true, 'auto']);
});
