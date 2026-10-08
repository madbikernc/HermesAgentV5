// Version: 1.1.0
//
// Direct request, 2026-10-07: "carry torches when tunneling, and place them at an appropriate
// distance to prevent spawns."
//
// What already existed and why it is not this. checkLighting (index.js, 2026-09-07) places a
// torch wherever the bot happens to be standing when its own tile reads dark, on a 20s timer,
// gated on not being busy -- so it never fires during the one activity that actually creates
// unlit space, because digging a tunnel IS being busy for minutes at a time. light_area
// (actions.js, 2026-09-10) sweeps dark spots around home, which is the opposite end of the map
// from a fresh shaft. Neither has any notion of distance: the 20s reflex will happily put two
// torches one block apart and then none for the next forty.
//
// So: a trail, hung off `diggingCompleted`, which is the one moment in a mining trip when the
// bot is reliably between digs. It fires at most every TORCH_SPACING blocks travelled from the
// last torch it placed, only under cover, only where nothing is already shedding light, and only
// onto a block a torch can hold. (The darkness test does NOT read block.light -- see 1.1.0.)
//
// TORCH_SPACING = 6, and it is a real number rather than a guess: a torch is light level 14 at
// its own cell and falls off 1 per block, so the midpoint between two torches 6 apart still
// reads 14 - 6 = 8 -- exactly DARK_LIGHT_LEVEL, the threshold the rest of this codebase already
// uses for "a mob can spawn here". Wider spacing leaves a spawnable gap in the middle of the
// corridor; narrower just burns torches. In a straight shaft the realised spacing is 7, since
// the last torch is itself a light source within TORCH_SPACING at exactly 6.
//
// 1.1.0 (2026-10-07) -- the darkness test does NOT use block.light, and must not. Measured live
// while the first run of this file's own live scenario placed nothing: block.light is populated
// when a chunk loads and is never updated afterwards on this stack. Confirmed three ways in the
// test arena -- a cell sealed inside solid deepslate still read light=10, a chunk unload/reload
// did not change it, and placing a real torch in that very cell with bot.placeBlock left it at 10.
// It is not a constant (neighbouring cells read 14 and 10), so it is real data, just frozen.
//
// That makes it unusable as a gate: it would answer "already lit" for a tunnel that is pitch dark
// and "still dark" for one the bot just lit. (The same dependency sits under checkLighting and
// light_area, which is a separate, pre-existing problem and not fixed here -- see
// MINECRAFT_BOTS_DESIGN.md §11.) Both replacement gates read data that is always current:
//
//   * UNDER COVER (shelter.js's isCovered): something solid overhead. This is what stops the trail
//     firing while a bot crosses a field at noon -- the job block.light was doing for daylight.
//   * NO LIGHT SOURCE WITHIN TORCH_SPACING, by block id, from the registry's own emitLight field
//     (56 blocks carry it; 37 emit DARK_LIGHT_LEVEL or more) rather than a hand-typed list of
//     names. This is what stops the trail re-lighting a stretch another bot already lit, or a
//     tunnel that breaks into a lava-lit cave -- the job block.light was doing for brightness.
//
// Equipping a torch mid-dig would fight mineflayer-collectblock's own equipForBlock() (the reason
// checkLighting was deliberately kept to idle ticks, see its own comment) -- `bot.targetDigBlock`
// being set means the next dig has already started, and this bails rather than racing it.
// collectBlock re-equips the right tool before every dig of its own accord, so a torch in hand
// between two digs is handed back without any bookkeeping here.
import { DARK_LIGHT_LEVEL, isProtectedBlockName } from "./actions.js";
import { fixtureKind, isCovered } from "./shelter.js";
import { Vec3 } from "vec3";

export const TORCH_SPACING = parseInt(process.env.MC_TORCH_SPACING || "6", 10);
// What counts as "carrying torches": enough to light a reasonable shaft without a trip home.
// At TORCH_SPACING = 6 this is around 50 blocks of corridor.
export const TORCH_CARRY_MIN = parseInt(process.env.MC_TORCH_CARRY_MIN || "8", 10);
const TORCH_SKIP_REPORT_MS = 60_000;

// Torches won't attach to these, so placeBlock would just fail: glass and ice are see-through,
// leaves and fences aren't full faces, slime/honey/powder snow aren't solid enough. Everything
// else with a full bounding box holds one. A fixture never does, matching light_area's own
// "never torch on top of someone's chest/furnace/bed" rule.
const NO_TORCH_BASE_NAMES = new Set(["glass", "ice", "packed_ice", "blue_ice", "frosted_ice",
  "slime_block", "honey_block", "powder_snow", "barrier", "cactus", "magma_block", "soul_sand",
  "farmland", "tnt"]);
const NO_TORCH_BASE_SUFFIXES = ["_leaves", "_fence", "_fence_gate", "_glass", "_glass_pane",
  "_sign", "_banner", "_carpet", "_bed", "_door", "_trapdoor", "_pane"];

export function canHoldTorch(block) {
  if (!block || block.boundingBox !== "block") return false;
  if (fixtureKind(block.name) || isProtectedBlockName(block.name)) return false;
  if (NO_TORCH_BASE_NAMES.has(block.name)) return false;
  return !NO_TORCH_BASE_SUFFIXES.some((suffix) => block.name.endsWith(suffix));
}

export function torchCount(bot) {
  return bot.inventory.items().filter((i) => i.name === "torch").reduce((n, i) => n + i.count, 0);
}

export function needsTorches(bot) {
  return torchCount(bot) < TORCH_CARRY_MIN;
}

// Every block that emits real light, straight from the registry's own emitLight field -- 37 of
// them at DARK_LIGHT_LEVEL or above on this server, from torches and lanterns to lava, froglights
// and campfires. Resolved once per process; an empty result is never cached, since the registry
// may not be up on the first call.
let lightSourceIds = null;
export function lightSourceBlockIds(bot) {
  if (lightSourceIds?.length) return lightSourceIds;
  lightSourceIds = (bot.registry?.blocksArray || [])
    .filter((block) => (block.emitLight ?? 0) >= DARK_LIGHT_LEVEL)
    .map((block) => block.id);
  return lightSourceIds;
}

// Is this stretch already lit by something? One findBlocks by id, not a hand-rolled cube scan --
// the trail asks this at most once per TORCH_SPACING blocks travelled, never per dig.
//
// [FLAGGED] This is blind to walls: a lantern six blocks away on the far side of solid rock lights
// nothing here, but still counts. Accepted deliberately, because the alternative is real light
// propagation and the one field that would have given it (block.light) is frozen -- see this
// file's 1.1.0 note. The cost is a torch occasionally not placed where a parallel tunnel runs
// close by; the benefit is never re-lighting a stretch a teammate just lit, which is the case
// that actually recurs in a nine-bot fleet sharing one mine. The distance gate, not this, is what
// does the real spacing work, so a false "lit" only ever delays a torch to the next TORCH_SPACING
// step, it does not skip the stretch for good.
export function litNearby(bot, pos, radius = TORCH_SPACING) {
  const ids = lightSourceBlockIds(bot);
  if (!ids.length) return false; // no registry: better to light it than to skip for a bad reason
  return (bot.findBlocks({ point: pos, matching: ids, maxDistance: radius, count: 1 }) || []).length > 0;
}

// Where the next trail torch goes: { reference, face, at }, or { skip } with the reason why not.
// The floor is tried before a wall -- a torch on the floor of a corridor lights it both ways,
// where one on a wall wastes half its radius inside the rock.
export function trailTorchSpot(bot, last, spacing = TORCH_SPACING) {
  if (!bot.entity) return { skip: "not spawned" };
  if (!torchCount(bot)) return { skip: "no torches" };
  const here = bot.entity.position.floored();
  if (last && here.distanceTo(last) < spacing) return { skip: "last torch still close" };
  const cell = bot.blockAt(here);
  if (!cell || cell.boundingBox === "block") return { skip: "nowhere to put one" };
  // The two gates that replaced block.light -- see this file's 1.1.0 note for why it cannot be used.
  if (!isCovered(bot, here)) return { skip: "out in the open" };
  if (litNearby(bot, here)) return { skip: "already lit" };

  const floor = bot.blockAt(here.offset(0, -1, 0));
  if (canHoldTorch(floor)) return { reference: floor, face: new Vec3(0, 1, 0), at: here };
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const wall = bot.blockAt(here.offset(dx, 0, dz));
    if (canHoldTorch(wall)) return { reference: wall, face: new Vec3(-dx, 0, -dz), at: here };
  }
  return { skip: "nothing solid to hang one on" };
}

// Per-bot state is closed over rather than hung on the bot, except for `bot.torchTrail` so a
// test (and a future action) can read and reset the last position. Skips are counted and
// summarised on a timer instead of logged per dig: "log the skip, always" (§32/§38/§54) is the
// standing rule, but a dig completes several times a second and four of the five skip reasons
// are the normal, expected case.
export function installTorchTrail(bot) {
  let last = null;
  let placing = false;
  let reportedAt = Date.now();
  const skips = {};

  const reportSkips = () => {
    if (Date.now() - reportedAt < TORCH_SKIP_REPORT_MS || !Object.keys(skips).length) return;
    console.log(`[${bot.username}] TORCH_TRAIL_SKIPS ${JSON.stringify(skips)}`);
    for (const key of Object.keys(skips)) delete skips[key];
    reportedAt = Date.now();
  };

  const trail = {
    get last() { return last; },
    reset() { last = null; },
    async place() {
      const spot = trailTorchSpot(bot, last);
      if (spot.skip) {
        skips[spot.skip] = (skips[spot.skip] ?? 0) + 1;
        reportSkips();
        return null;
      }
      const torch = bot.inventory.items().find((i) => i.name === "torch");
      if (!torch) return null; // spent between the check and here
      await bot.equip(torch, "hand");
      await bot.placeBlock(spot.reference, spot.face);
      last = spot.at;
      console.log(`[${bot.username}] torch trail: lit ${spot.at}, ${torchCount(bot)} torch(es) left`);
      return spot.at;
    },
  };
  bot.torchTrail = trail;

  bot.on("diggingCompleted", () => {
    if (placing || bot.targetDigBlock) return; // the next dig has already started -- don't race its tool
    placing = true;
    trail.place()
      .catch((err) => console.error(`[${bot.username}] torch trail: ${err.message}`))
      .finally(() => { placing = false; });
  });
  return trail;
}
