// Version: 1.0.0
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
// last torch it placed, only where the cell actually reads dark, and only onto a block a torch
// can hold.
//
// TORCH_SPACING = 6, and it is a real number rather than a guess: a torch is light level 14 at
// its own cell and falls off 1 per block, so the midpoint between two torches 6 apart still
// reads 14 - 6 = 8 -- exactly DARK_LIGHT_LEVEL, the threshold the rest of this codebase already
// uses for "a mob can spawn here" (see actions.js's own note on block.light). Wider spacing
// leaves a spawnable gap in the middle of the corridor; narrower just burns torches.
//
// Placement is gated on the MEASURED block.light, not on geometry alone, so a tunnel that breaks
// into an already-lit cave, or one another bot has already lit, costs nothing. Equipping a torch
// mid-dig would fight mineflayer-collectblock's own equipForBlock() (the reason checkLighting was
// deliberately kept to idle ticks, see its own comment) -- `bot.targetDigBlock` being set means
// the next dig has already started, and this bails rather than racing it. collectBlock re-equips
// the right tool before every dig of its own accord, so a torch in hand between two digs is
// handed back without any bookkeeping here.
import { DARK_LIGHT_LEVEL, isProtectedBlockName } from "./actions.js";
import { fixtureKind } from "./shelter.js";
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
  if (cell.light === undefined || cell.light >= DARK_LIGHT_LEVEL) return { skip: "already lit" };

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
