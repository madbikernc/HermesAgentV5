// Version: 1.0.0
//
// Unit checks: pathfinding.js's generic "stuck" burst detector (1.5.0). Direct report, 2026-11-28
// ("the bots are still not moving or doing anything useful") -- confirmed live on Amy: a
// path_update status=success (nodes=6, cost=8.7) immediately followed by path_reset: stuck, over
// and over, every ~3.5s for 12+ minutes straight, real position frozen the whole window. Neither
// existing stuck fix applied (jump was never held -- not the land 1-block-rise case; she was
// never in water -- not the swim case either). This is the exact "'success' path immediately
// followed by getting stuck again... recomputing trivial routes that never actually complete"
// shape the dig_error burst-detector already breaks, just triggered by plain "stuck", which that
// detector never watches. Worse than cosmetic: the stuck goto() never settles, so whatever
// performAction() call started it never returns and never releases arbiter control -- confirmed
// live, a player's Rcon command to Amy was refused while she was deadlocked like this.
//
// This file does not import tests/unit/_harness.mjs: confirmed live (2026-11-28) that importing
// it now throws at module load for every test file that does -- ACTION_MODULES/INDEX_MODULES both
// eagerly read files that no longer exist in services/minecraft-bots/ at all (moved to
// services/minecraft-bots-archive-11-2026/ by MINECRAFT_BOTS_RESTART_PLAN.md Phase 5), worse than
// the already-documented "action-*.js missing" gap -- every one of the seventeen INDEX_MODULES is
// gone too. Same tradeoff metrics.test.mjs/examples.test.mjs already accepted for this exact
// reason: a small local `root`/`between` (identical to _harness.mjs's own) and plain node:test,
// so this runs standalone regardless of that harness's state. pathfinding.js itself IS safely
// importable (no live side effects), but its own setupPathfinding() needs a mineflayer-shaped bot
// mock either way, so the existing pathfinding.test.mjs's own vm.runInContext(between(...))
// technique is reused here rather than a real import.
// Run every file: node tests/unit.test.mjs; this one alone: node --test tests/unit/stuck-burst.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

function between(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, start);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert(to > from, end);
  return source.slice(from, to).replace(/export /g, '');
}

class V3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
}

async function makeBot() {
  const src = await readFile(root + 'pathfinding.js', 'utf8');
  class Movements { constructor() { this.blocksCantBreak = new Set(); this.exclusionAreasPlace = []; this.canDig = true; } }
  let goal = 'the-goal';
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry: { blocksArray: [] },
    pathfinder: { setMovements(m) { this.movements = m; }, setGoal(g) { goal = g; } },
    pvp: {}, collectBlock: {}, entity: { position: new V3(10, 64, 0) }, entities: {}, blockAt: () => null,
  });
  const c = vm.createContext({ console: { log() {}, error() {} }, Vec3: V3, SwimMovements: Movements, setTimeout, Date,
    installDoorSupport: () => {}, installSteppedGoto: () => {}, isProtectedBlockName: () => false, wouldBlockAccess: () => false });
  vm.runInContext(between(src, 'function setupPathfinding'), c);
  c.setupPathfinding(bot, { username: 'Amy' });
  return { bot, goalRef: () => goal };
}

test('Stuck burst: no real progress across 3 consecutive "stuck" resets abandons the goal', async () => {
  const { bot, goalRef } = await makeBot();
  bot.emit('path_reset', 'stuck');
  bot.emit('path_reset', 'stuck');
  assert.notEqual(goalRef(), null, 'two consecutive stuck resets alone do not give up yet');
  bot.emit('path_reset', 'stuck');
  assert.equal(goalRef(), null, 'a third, with no real position change across all three, abandons the goal');
});

test('Stuck burst: real position progress between "stuck" resets never abandons the goal', async () => {
  const { bot, goalRef } = await makeBot();
  for (let i = 0; i < 5; i++) {
    bot.entity.position = new V3(i * 2, 64, 0); // genuinely, if slowly, inching forward each reset
    bot.emit('path_reset', 'stuck');
  }
  assert.notEqual(goalRef(), null, 'real progress between resets -- never treated as deadlocked');
});

test('Stuck burst: a different reset reason in between breaks the "stuck" streak', async () => {
  const { bot, goalRef } = await makeBot();
  bot.emit('path_reset', 'stuck');
  bot.emit('path_reset', 'stuck');
  bot.emit('path_reset', 'goal_moved'); // something genuinely changed -- the streak must not carry over
  bot.emit('path_reset', 'stuck');
  bot.emit('path_reset', 'stuck');
  assert.notEqual(goalRef(), null, 'only 2 consecutive stuck resets since the interruption -- not abandoned yet');
});
