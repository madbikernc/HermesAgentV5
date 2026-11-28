// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/pathfinding.test.mjs against the Mindcraft-ported
// architecture. Unlike that old file (which slices OLD source by string markers into a vm
// context -- tests/unit/_harness.mjs), every check here imports pathfinding.js/swim-movements.js
// directly and calls them for real: both files were kept almost unchanged by the restart
// (MINECRAFT_BOTS_RESTART_PLAN.md) -- this is the one area of the whole legacy suite where
// near-total parity with the old check set was possible, because the thing under test never
// actually changed. The few checks that DID lose their ground (chooseFarmPlot, the oxygen-
// depletion drowning reflex) point at services/minecraft-bots-archive-11-2026/ in their
// test.todo reason. Run: node --test services/minecraft-bots/tests/legacy-baseline/pathfinding.test.mjs
// (needs node_modules -- dgx-spark/spark2, same requirement tests/live.test.mjs already has).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import pathfinderPkg from "mineflayer-pathfinder";
import minecraftData from "minecraft-data";
import { V3 } from "./_mockbot.mjs";
import { setupPathfinding } from "../../pathfinding.js";
import { isOpenDoorOrGate, installDoorSupport, installSteppedGoto } from "../../swim-movements.js";

const { goals } = pathfinderPkg;

function doorBlock(name, props) {
  return { name, getProperties: () => props };
}

// The real mineflayer-pathfinder Movements constructor (SwimMovements's parent class) needs a
// real, complete registry -- it reads registry.itemsByName.{dirt,cobblestone}.id, sweeps every
// blocksArray entry through prismarine-block's Block.fromStateId(x.minStateId, 0) (which throws on
// a made-up id with no real state-id range), and only THEN adds every non-diggable block's id to
// blocksCantBreak. A minimal hand-rolled registry can't satisfy that -- every mock bot here uses
// the real minecraft-data registry instead, same as tests/legacy-baseline/_mockbot.mjs's makeBot().
const REAL_REGISTRY = minecraftData("1.20.4");

// A scripted mock pathfinder.goto(), adapted from tests/unit/_harness.mjs's steppedGotoWorld() --
// but here it's handed to the REAL installSteppedGoto(bot) (swim-movements.js), not run as vm
// source. `script`: one entry per real goto() call -- an ordinary "walk to this point" leg is told
// apart from a climb's own synthetic leg by `goal instanceof goals.GoalBlock` combined with
// searchRadius===500 (CLIMB_SEARCH_BUDGET, swim-movements.js's own internal constant), the same
// signal the old harness used.
function steppedGotoWorld(script, { start = new V3(0, 64, 0), rock = false, canDig = true, failBlock = false } = {}) {
  const bot = new EventEmitter();
  const calls = [];
  const named = (name) => Object.assign(new Error(name), { name });
  bot.username = "Amy";
  bot.entity = { position: start, yaw: 0 };
  // rock: every cell above her start is solid, as in a cave; otherwise open sky.
  bot.blockAt = (p) => ({ boundingBox: rock && p.y > start.y + 1 ? "block" : "empty" });
  bot.pathfinder = {
    searchRadius: 48, legRadii: [], climbDigCosts: [], climbRadii: [],
    movements: { digCost: 15, canDig },
    async goto(goal) {
      const isBlockGoal = goal instanceof goals.GoalBlock;
      calls.push(isBlockGoal ? "block" : "goal");
      if (isBlockGoal) {
        const isClimb = bot.pathfinder.searchRadius === 500;
        if (isClimb) {
          bot.pathfinder.climbDigCosts.push(bot.pathfinder.movements.digCost);
          bot.pathfinder.climbRadii.push(bot.pathfinder.searchRadius);
          if (script[0]?.climbPartial) {
            const st = script.shift();
            bot.emit("path_update", { status: "noPath", path: st.climbPartial, cost: st.cost ?? 10 });
            throw named("NoPath");
          }
          bot.entity.position = new V3(goal.x, goal.y, goal.z);
          return;
        }
        bot.pathfinder.legRadii.push(bot.pathfinder.searchRadius);
        if (failBlock) throw named("NoPath");
        bot.entity.position = new V3(goal.x, goal.y, goal.z);
        return;
      }
      const step = script.shift();
      if (step === "ok") return;
      if (step.error) throw named(step.error);
      bot.emit("path_update", { status: step.status, path: step.path, cost: step.cost ?? 10 });
      if (step.resolves) return;
      throw named(step.status === "noPath" ? "NoPath" : "Timeout");
    },
  };
  installSteppedGoto(bot); // the real retry/climb wrapper, not a vm-sliced copy of it
  const goal = { heuristic: (n) => Math.abs(100 - n.x) };
  return { bot, calls, goal };
}

test('[legacy:pathfinding] Doors: only an already-open door or gate is skipped by the pathfinding guard', async () => {
  assert.equal(isOpenDoorOrGate(doorBlock("oak_door", { half: "lower", open: true })), true);
  assert.equal(isOpenDoorOrGate(doorBlock("oak_door", { half: "lower", open: false })), false);
  assert.equal(isOpenDoorOrGate(doorBlock("oak_fence_gate", { open: true })), true);
  assert.equal(isOpenDoorOrGate({ name: "chest", getProperties: () => ({}) }), false);

  const used = [];
  let moving = true;
  const bot = Object.assign(new EventEmitter(), {
    activateBlock: async (b) => { used.push(b.name); },
    pathfinder: { isMoving: () => moving },
  });
  installDoorSupport(bot);
  await bot.activateBlock(doorBlock("oak_door", { half: "lower", open: true }));
  await bot.activateBlock(doorBlock("oak_door", { half: "lower", open: false }));
  moving = false;
  await bot.activateBlock(doorBlock("oak_fence_gate", { open: true })); // herd_to_pen closing its gate
  assert.deepEqual(used, ["oak_door", "oak_fence_gate"]);
});

test.todo('[legacy:pathfinding] Farm plots: ground around water, grass cleared first, covered ground skipped; else a tight cluster -- NOT PORTED: chooseFarmPlot() lived in action-world.js, archived whole with the rest of actions.js (services/minecraft-bots-archive-11-2026/); no farm-plot site selection exists in the new skills.js, which only tills a single given (x,y,z) via tillAndSow()');

test.todo('[legacy:pathfinding] Water: the drowning reflex reads her own air, and the shore search survives findBlocks\' palette pass -- NOT PORTED: the oxygen-depletion threshold/findNearestShore reflex lived in index.js and was deliberately not re-implemented (modes.js 1.0.0\'s own header: "Mindcraft\'s self_preservation only prevents standing water-above-head by jumping... it has no oxygen-depletion tracking of its own. That\'s a real, known gap versus the archived behavior")');

test.todo('[legacy:pathfinding] Water: bobbing at the surface (isInWater false for a tick) still sends her for the shore -- NOT PORTED: same gap as the check above -- modes.js\'s self_preservation reacts to water directly overhead, not to oxygen level, so there is no shore search to retain or lose a tick of');

test('[legacy:pathfinding] Pathfinding: out of search budget, she walks the partial path toward the goal and searches again', async () => {
  const { bot, calls, goal } = steppedGotoWorld([
    { status: "noPath", path: [new V3(10, 64, 0), new V3(20, 64, 0)], cost: 64 },
    { status: "timeout", path: [new V3(45, 64, 0)] },
    "ok",
  ]);
  await bot.pathfinder.goto(goal);
  assert.deepEqual(calls, ["goal", "block", "goal", "block", "goal"], "two legs walked, then the whole way found");
  assert.equal(bot.entity.position.x, 45);
  assert.deepEqual(bot.pathfinder.legRadii, [72, 48], "a leg costing 64 gets the budget to walk it; the limit is put back after");
  assert.equal(bot.pathfinder.searchRadius, 48);
});

test('[legacy:pathfinding] Pathfinding: no progress, a changed goal, or too many legs still fail', async () => {
  let w = steppedGotoWorld([{ status: "noPath", path: [new V3(1, 64, 0)] }]);
  await assert.rejects(w.bot.pathfinder.goto(w.goal), { name: "NoPath" }, "one block closer is no progress");
  w = steppedGotoWorld([{ error: "GoalChanged" }]);
  await assert.rejects(w.bot.pathfinder.goto(w.goal), { name: "GoalChanged" });
  assert.deepEqual(w.calls, ["goal"], "a preemptor took over -- no leg walked");
  w = steppedGotoWorld(Array.from({ length: 12 }, (_, i) => ({ status: "noPath", path: [new V3(5 * (i + 1), 64, 0)] })));
  await assert.rejects(w.bot.pathfinder.goto(w.goal), { name: "NoPath" });
  assert.equal(w.calls.filter((k) => k === "goal").length, 8, "eight searches, then she gives up");
});

test('[legacy:pathfinding] Pathfinding: far below the goal under rock, she climbs in legs with digging made cheap, then finds the way', async () => {
  const home = { y: 94, heuristic: (n) => Math.abs(100 - n.x) + Math.abs(94 - n.y) };
  const { bot, calls } = steppedGotoWorld([
    { status: "noPath", path: [new V3(20, 3, 0)] },
    { status: "noPath", path: [] },
    { status: "noPath", path: [new V3(20, 50, 0)] }, // this one climbs on its own: walked, as before
    "ok",
  ], { start: new V3(0, 3, 0), rock: true });
  await bot.pathfinder.goto(home);
  assert.deepEqual(calls.slice(0, 4), ["goal", "block", "goal", "block"], "a sideways partial and no partial both get a climb instead");
  assert.deepEqual(bot.pathfinder.climbDigCosts, [1, 1], "digging is cheap only while climbing");
  assert.equal(bot.pathfinder.movements.digCost, 15, "and put back after");
  assert.deepEqual(bot.pathfinder.climbRadii, [500, 500], "a climb search gets the budget for 8 blocks of rock");
  assert.equal(bot.pathfinder.searchRadius, 48, "the budget is put back after");
  assert.equal(calls.at(-1), "goal", "then the whole way is searched again");
  assert.equal(bot.entity.position.y, 50, "two climbs, then a partial path that rises is walked");
});

test('[legacy:pathfinding] Pathfinding: a climb is a diagonal staircase toward the goal, not a vertical shaft', async () => {
  const farCorner = { x: 100, y: 94, z: -100, heuristic: (n) => Math.abs(100 - n.x) + Math.abs(-100 - n.z) + Math.abs(94 - n.y) };
  const { bot } = steppedGotoWorld([{ status: "noPath", path: [] }, "ok"], { start: new V3(0, 3, 0), rock: true });
  await bot.pathfinder.goto(farCorner);
  assert.deepEqual([bot.entity.position.x, bot.entity.position.y, bot.entity.position.z], [8, 11, -8],
    "climbed 8 up AND 8 toward the goal, diagonally -- not straight up with x/z left unchanged");
});

test('[legacy:pathfinding] Pathfinding: a climb with no horizontal goal falls back to her own facing, never NaN', async () => {
  const { bot } = steppedGotoWorld([{ status: "noPath", path: [] }, "ok"], { start: new V3(0, 3, 0), rock: true });
  bot.entity.yaw = Math.PI / 2;
  await bot.pathfinder.goto({ y: 94, heuristic: (n) => Math.abs(94 - n.y) });
  assert.equal(bot.entity.position.y, 11, "still climbs -- a goal with no x/z is not a reason to refuse");
  assert(Number.isFinite(bot.entity.position.x) && Number.isFinite(bot.entity.position.z),
    "her own facing stands in for a direction, never leaves x/z undefined or NaN");
});

test('[legacy:pathfinding] Pathfinding: a climb search that runs short is walked as far as it rose', async () => {
  const home = { y: 94, heuristic: (n) => Math.abs(94 - n.y) };
  const { bot, calls } = steppedGotoWorld([
    { status: "noPath", path: [] },
    { climbPartial: [new V3(1, 4, 0), new V3(2, 7, 0)], cost: 520 },
    "ok",
  ], { start: new V3(0, 3, 0), rock: true });
  await bot.pathfinder.goto(home);
  assert.deepEqual(calls, ["goal", "block", "block", "goal"], "climb, walk its partial up, then search again");
  assert.equal(bot.entity.position.y, 7);
  assert.deepEqual(bot.pathfinder.legRadii, [528], "the walk gets the budget its partial path cost");
  assert.equal(bot.pathfinder.searchRadius, 48);
  assert.equal(bot.pathfinder.movements.digCost, 15);
});

test('[legacy:pathfinding] Pathfinding: climbs do not use up legs, and a partial that barely rises gets a climb instead', async () => {
  const deep = { y: 200, heuristic: (n) => Math.abs(200 - n.y) };
  let w = steppedGotoWorld([...Array.from({ length: 12 }, () => ({ status: "noPath", path: [] })), "ok"],
    { start: new V3(0, 3, 0), rock: true });
  await w.bot.pathfinder.goto(deep);
  assert.equal(w.bot.pathfinder.climbDigCosts.length, 12, "twelve climbs, past the eight-leg limit");
  assert.equal(w.bot.entity.position.y, 99);
  w = steppedGotoWorld([{ status: "noPath", path: [new V3(0, 5, 0)] }, "ok"], { start: new V3(0, 3, 0), rock: true });
  await w.bot.pathfinder.goto(deep);
  assert.deepEqual(w.calls, ["goal", "block", "goal"], "a partial rising 2 is not walked: she climbs 8");
});

test('[legacy:pathfinding] Pathfinding: no climb under open sky, close to the goal height, or while digging is off', async () => {
  const above = { y: 94, heuristic: (n) => Math.abs(100 - n.x) };
  let w = steppedGotoWorld([{ status: "noPath", path: [new V3(20, 64, 0)] }, "ok"], { rock: false });
  await w.bot.pathfinder.goto(above);
  assert.equal(w.bot.pathfinder.climbDigCosts.length, 0, "open sky: she walks round, never tunnels up a hillside");
  w = steppedGotoWorld([{ status: "noPath", path: [new V3(20, 64, 0)] }, "ok"], { rock: true });
  await w.bot.pathfinder.goto({ y: 70, heuristic: above.heuristic });
  assert.equal(w.bot.pathfinder.climbDigCosts.length, 0, "six blocks up is not a climb");
  w = steppedGotoWorld([{ status: "noPath", path: [] }], { start: new V3(0, 3, 0), rock: true, canDig: false });
  await assert.rejects(w.bot.pathfinder.goto(above), { name: "NoPath" }, "digging suppressed: nothing to climb with");
  w = steppedGotoWorld([{ status: "noPath", path: [new V3(20, 64, 0)] }, "ok"], { rock: true });
  await w.bot.pathfinder.goto({ heuristic: above.heuristic });
  assert.equal(w.bot.pathfinder.climbDigCosts.length, 0, "a goal with no height (following someone) is never climbed to");
});

test('[legacy:pathfinding] Pathfinding: open sky, but walking round fails too -- she climbs anyway as a last resort', async () => {
  const above = { y: 94, heuristic: (n) => Math.abs(100 - n.x) };
  const w = steppedGotoWorld([{ status: "noPath", path: [new V3(20, 64, 0)] }, "ok"], { rock: false, failBlock: true });
  await w.bot.pathfinder.goto(above);
  assert.deepEqual(w.calls, ["goal", "block", "block", "goal"],
    "walk round tried and failed, only then a forced climb, then the whole way searched again");
  assert.equal(w.bot.entity.position.y, 72, "climbed CLIMB_LEG_RISE (8) up from the start height 64");
});

test('[legacy:pathfinding] Pathfinding: an empty, failed search the library resolved gets a climb when sealed in rock, else stands', async () => {
  const sealed = { y: 94, heuristic: (n) => Math.abs(94 - n.y), isEnd: (n) => n.y === 94 };
  let w = steppedGotoWorld([{ status: "partial", path: [], resolves: true }, "ok"], { start: new V3(0, 3, 0), rock: true });
  await w.bot.pathfinder.goto(sealed);
  assert.deepEqual(w.calls.slice(0, 2), ["goal", "block"], "sealed in: she climbs instead of \"arriving\"");
  w = steppedGotoWorld([{ status: "noPath", path: [], resolves: true }], { rock: false });
  await w.bot.pathfinder.goto({ y: 94, heuristic: () => 5, isEnd: () => false });
  assert.deepEqual(w.calls, ["goal"], "no climb to make: it resolves, as the library does");
});

test('[legacy:pathfinding] Pathfinding: setupPathfinding installs the costs, unbreakable blocks, search limits and the dig_error burst guard', async () => {
  const installed = [];
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry: REAL_REGISTRY, activateBlock: async () => {},
    pathfinder: { setMovements(m) { this.movements = m; }, goto: async () => {} }, pvp: {}, collectBlock: {},
    entity: { position: new V3(0, 64, 0) }, entities: {},
    // A chest sits right below (1,64,1): wouldBlockAccess (shelter.js, real, not stubbed) reports
    // its lid as blocked; anywhere else is unrestricted. installDoorSupport/installSteppedGoto
    // (swim-movements.js) also run for real here -- not reproduced separately, since
    // setupPathfinding() is the only caller and this is already an end-to-end check of it.
    blockAt: (p) => (p.equals(new V3(1, 63, 1)) ? { name: "chest", position: p, getProperties: () => ({}) }
      : { name: "air", position: p, getProperties: () => ({}) }),
  });
  const movements = setupPathfinding(bot, { username: "Amy" });
  installed.push(bot.pathfinder.movements === movements, bot.pvp.movements === movements, bot.collectBlock.movements === movements);
  assert.deepEqual(installed, [true, true, true], "the one shared SwimMovements instance is reused by pvp/collectBlock too");
  assert.deepEqual([movements.liquidCost, movements.entityCost, movements.digCost, movements.canOpenDoors], [20, 8, 15, true]);
  assert.deepEqual([bot.pathfinder.searchRadius, bot.pathfinder.thinkTimeout, bot.pathfinder.tickTimeout], [48, 1000, 20]);
  // The real library adds every block id unconditionally via registry.blocksByName.chest.id (one
  // of mineflayer-pathfinder's own hardcoded defaults), plus every block whose real registry entry
  // says diggable:false (bedrock, barrier, command blocks, ...) -- never by hardness, which the old
  // archived code used for this same "protected or very hard" idea but the real library doesn't.
  const cantBreak = movements.blocksCantBreak;
  assert.ok(cantBreak.has(REAL_REGISTRY.blocksByName.chest.id), "the chest block itself (hardcoded default)");
  assert.ok(cantBreak.has(REAL_REGISTRY.blocksByName.bedrock.id), "a genuinely undiggable block (diggable:false)");
  assert.equal(cantBreak.has(REAL_REGISTRY.blocksByName.dirt.id), false, "an ordinary diggable block is not excluded");
  assert.equal(movements.exclusionAreasPlace[0]({ position: new V3(1, 64, 1) }), 100, "no scaffolding over a chest's lid (wouldBlockAccess)");
  assert.equal(movements.exclusionAreasPlace[0]({ position: new V3(10, 64, 10) }), 0, "an ordinary cell with nothing to cut off is unrestricted");
  for (let i = 0; i < 4; i++) bot.emit("path_reset", "dig_error");
  assert.equal(movements.canDig, false, "four dig_errors in a burst force walk-only pathing");
});

test('[legacy:pathfinding] Pathfinding: a blocked jump gets the same impulse a real landing-triggered one would', async () => {
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry: REAL_REGISTRY, activateBlock: async () => {},
    pathfinder: { setMovements(m) { this.movements = m; }, goto: async () => {}, isMoving: () => true },
    pvp: {}, collectBlock: {}, entity: { position: new V3(0, 64, 0), isInWater: false, onGround: false, velocity: new V3(0, -0.078, 0) },
    entities: {}, blockAt: () => null, getControlState: (c) => c === "jump",
  });
  setupPathfinding(bot, { username: "Amy" });
  bot.emit("physicsTick");
  assert.equal(bot.entity.velocity.y, 0.42, "resting against a step, jump held -- gets the real impulse");
  bot.emit("physicsTick");
  assert.equal(bot.entity.velocity.y, 0.42, "already rising (vel.y > 0) -- left alone, not re-applied mid-arc");
  bot.entity.onGround = true;
  bot.entity.velocity.y = -0.078;
  bot.emit("physicsTick");
  assert.equal(bot.entity.velocity.y, -0.078, "actually on ground -- the library's own impulse handles it, left alone");
});

test('[legacy:pathfinding] Pathfinding: sprint is forced on while swimming toward a goal', async () => {
  const controlStates = {};
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry: REAL_REGISTRY, activateBlock: async () => {},
    pathfinder: { setMovements(m) { this.movements = m; }, goto: async () => {}, isMoving: () => true },
    pvp: {}, collectBlock: {}, entity: { position: new V3(0, 64, 0), isInWater: false, onGround: true }, entities: {},
    blockAt: () => null, setControlState: (c, v) => { controlStates[c] = v; }, getControlState: () => false,
  });
  setupPathfinding(bot, { username: "Amy" });
  bot.emit("physicsTick");
  assert.equal(controlStates.sprint, undefined, "not swimming -- left alone");
  bot.entity.isInWater = true;
  bot.emit("physicsTick");
  assert.equal(controlStates.sprint, true, "swimming toward a goal -- forced on");
});

test('[legacy:pathfinding] Pathfinding: setupPathfinding debounces mineflayer-pathfinder\'s own chunk-load reset trigger', async () => {
  let now = 1000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const bot = new EventEmitter();
    Object.assign(bot, {
      registry: REAL_REGISTRY, activateBlock: async () => {},
      pathfinder: { setMovements(m) { this.movements = m; }, goto: async () => {} }, pvp: {}, collectBlock: {},
      entity: { position: new V3(0, 64, 0) }, entities: {}, blockAt: () => null,
    });
    const originalCalls = [];
    bot.on("chunkColumnLoad", (chunk) => originalCalls.push(chunk)); // mineflayer-pathfinder's own listener, registered before setupPathfinding
    setupPathfinding(bot, { username: "Amy" });

    bot.emit("chunkColumnLoad", "a");
    assert.deepEqual(originalCalls, ["a"], "the first chunk load still resets, same as before");
    now += 100;
    bot.emit("chunkColumnLoad", "b");
    assert.deepEqual(originalCalls, ["a"], "a second chunk load inside the debounce window is skipped");
    now += 500;
    bot.emit("chunkColumnLoad", "c");
    assert.deepEqual(originalCalls, ["a", "c"], "once the debounce window has passed, the reset fires again");
  } finally {
    Date.now = realNow;
  }
});

test('[legacy:pathfinding] Pathfinding: an unexpected chunkColumnLoad listener count leaves mineflayer-pathfinder alone', async () => {
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry: REAL_REGISTRY, activateBlock: async () => {},
    pathfinder: { setMovements(m) { this.movements = m; }, goto: async () => {} }, pvp: {}, collectBlock: {},
    entity: { position: new V3(0, 64, 0) }, entities: {}, blockAt: () => null,
  });
  const realError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(msg);
  try {
    setupPathfinding(bot, { username: "Amy" }); // zero chunkColumnLoad listeners registered
  } finally {
    console.error = realError;
  }
  assert.equal(bot.listeners("chunkColumnLoad").length, 0, "nothing was added in place of a listener that was never there");
  assert.match(errors[0] ?? "", /expected exactly one chunkColumnLoad listener, found 0/);
});
