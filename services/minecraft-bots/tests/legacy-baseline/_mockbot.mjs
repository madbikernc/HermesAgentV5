// Version: 1.0.0
//
// Shared mock-bot primitives for the legacy-baseline suite (tests/legacy-baseline/*.test.mjs).
// Unlike tests/unit/_harness.mjs (which slices OLD, now-archived source by string markers and
// runs it in a vm context), every check here imports the REAL current modules
// (skills.js/world.js/commands.js/modes.js/pathfinding.js/shelter.js/action-vocab.js/
// equipment.js/faults.js/arbiter.js) as plain ES modules and drives them with a mineflayer-shaped
// mock bot. No vm, no source-slicing: these modules are already small and modular.

import { EventEmitter } from "node:events";
import Vec3 from "vec3";
import minecraftData from "minecraft-data";

// Real mineflayer sets bot.version/bot.registry this same way on login (registry =
// minecraft-data(bot.version)) -- mineflayer-pathfinder's Movements (world.js's isClearPath(),
// skills.js's goToGoal() and friends all construct one) reads many registry fields a hand-rolled
// stub would have to keep guessing at, so every mock bot below gets the real thing instead.
const MOCK_MC_VERSION = "1.20.4";
const MOCK_REGISTRY = minecraftData(MOCK_MC_VERSION);

// This suite only ever runs where node_modules exists (dgx-spark/spark2), the same requirement
// live.test.mjs/live-bot.test.mjs already have -- so, unlike tests/unit/_harness.mjs's V3 stub
// (built for an offline vm context with no node_modules), every check here uses the REAL `vec3`
// package the current modules themselves import, never a hand-rolled stand-in that could drift
// from its actual API.
export const V3 = Vec3;

// A mineflayer-shaped bot with the primitives skills.js/world.js/commands.js/modes.js actually
// touch (surveyed by grepping `bot\.` across those four files). Each test overrides only what its
// scenario needs via `overrides` or by mutating the returned bot directly -- the same pattern
// tests/unit/_harness.mjs's makeBot() used for the old code.
export function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  const inv = overrides.inventoryItems || [];
  delete overrides.inventoryItems;
  Object.assign(bot, {
    username: "Amy",
    version: MOCK_MC_VERSION,
    entity: { position: new V3(0, 64, 0), yaw: 0, onGround: true },
    health: 20, food: 20, isSleeping: false,
    game: { gameMode: "survival" }, time: { timeOfDay: 6000 }, rainState: 0, thunderState: 0,
    entities: {}, players: {},
    registry: MOCK_REGISTRY,
    inventory: {
      items: () => inv.filter((i) => i.count > 0),
      slots: [],
      emptySlotCount: () => 36 - inv.filter((i) => i.count > 0).length,
      // Real mineflayer Inventory#findInventoryItem; skills.js calls it by item NAME (not the
      // numeric type id its real signature also accepts) at every placeBlock/craftRecipe/consume
      // call site that needs "do I already have one of these".
      findInventoryItem: (itemType, metadata = null, notFull = false) =>
        inv.find((i) => (i.name === itemType || i.type === itemType) && i.count > 0 &&
          (!notFull || i.count < (i.stackSize ?? 64))) || null,
    },
    heldItem: null,
    pathfinder: {
      goal: null,
      setGoal(g) { this.goal = g; },
      movements: { canDig: true },
      goto: async () => {},
      setMovements() {},
      stop() {},
      // world.js's isClearPath() (the gate every modes.js reflex checks before acting) calls this
      // directly -- default "reachable", so a scenario only has to override it to prove the
      // opposite.
      getPathTo: async () => ({ status: "success" }),
    },
    pvp: { target: null, attacks: 0, stop() { this.target = null; }, attack(t) { this.attacks++; this.target = t; } },
    collectBlock: { collect: async () => {}, cancelTask() {} },
    stopDigging() {},
    clearControlStates() {},
    setControlState() {},
    blockAt: () => ({ name: "air", boundingBox: "empty", position: new V3(0, 0, 0), getProperties: () => ({}) }),
    blockAtCursor: () => null,
    findBlocks: () => [],
    nearestEntity: () => null,
    chat() {},
    lookAt: async () => {},
    equip: async () => {},
    unequip: async () => {},
    dig: async () => {},
    placeBlock: async () => {},
    activateBlock: async () => {},
    activateItem: async () => {},
    useOn: async () => {},
    toss: async () => {},
    consume: async () => {},
    sleep: async () => {},
    craft: async () => {},
    recipesFor: () => [],
    openContainer: async () => ({ close() {} }),
    openFurnace: async () => ({ close() {} }),
    openVillager: async () => ({ close() {} }),
    trade: async () => {},
    closeWindow() {},
    armorManager: { equipAll: async () => {} },
    modes: { pause() {}, unpause() {}, isOn: () => false },
    interrupt_code: false,
    output: "",
    restrict_to_inventory: null,
    ...overrides,
  });
  return bot;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
