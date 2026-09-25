// Version: 1.2.0
//
// 1.2.0 (2026-09-25) -- direct report: bots can't get in or out of a building through its doors,
// "even when the doors are open." Doors and fence gates are now judged by their current state
// (applyDoorState): open = walkable, a closed wooden door or gate = opened on the way through.
// installDoorSupport keeps doorway waypoints on the floor and never shuts an already-open door.
//
// 1.0.0 (2026-09-07) -- direct request: "build the water crossing mechanic," following the
// anti-drowning reflex (index.js 2.29.0), which fixes SURVIVAL but not CAPABILITY: stock
// mineflayer-pathfinder can already cross the surface of open water just fine (getMoveForward
// applies movements.liquidCost at a constant Y-level), but it can never generate a move that
// changes Y-level while the bot is already standing in liquid -- confirmed directly against its
// own source (node_modules/mineflayer-pathfinder/lib/movements.js): getMoveDown() and
// getMoveUp() both unconditionally `return` (no move at all, not just an expensive one) the
// moment the current block is liquid. That means a bot who dives down a submerged bank, falls
// into water deeper than one block, or needs to resurface partway across a crossing has no path
// pathfinding can offer -- not "discouraged," genuinely absent from the search graph. Confirmed
// live: bots stuck in repeated path_update status=timeout / path_reset: goal_updated loops right
// after this world's own coastal-village seed put real water between them and several goals.
//
// SwimMovements overrides just those two methods to allow vertical travel through WATER
// specifically -- checked by block name, not the library's own generic `liquid` flag, because
// that flag does not distinguish water from lava (confirmed: Movements' own constructor adds
// BOTH registry.blocksByName.water.id and .lava.id to `this.liquids`). Falling through to the
// stock implementation whenever the current block isn't water means lava's vertical-movement
// refusal is completely unchanged -- this only ever opens up water. Costed the same as
// horizontal liquid travel (this.liquidCost, currently 20 -- see index.js's own comment on it)
// so a dry route is still preferred whenever one exists within searchRadius; this only makes a
// water crossing POSSIBLE, not cheap.
import pathfinderPkg from "mineflayer-pathfinder";
import Move from "mineflayer-pathfinder/lib/move.js";
import nbt from "prismarine-nbt";
import { Vec3 } from "vec3";

const { Movements } = pathfinderPkg;

function isWater(block) {
  return !!block && (block.name === "water" || block.name === "flowing_water" || block.name === "bubble_column");
}

// 1.1.0 (2026-09-21) -- direct report ("they still destroy walls instead of using doors") after
// two prior swings at the SAME digCost knob (index.js 2.79.0/2.81.0) both ended up wrong in
// opposite directions: 30 was strong enough to deter, but blew the search-cost budget for a slow
// dig and made real exits unreachable (§47); 5 fixed that, but made a well-tooled dig nearly free
// again (§this section), reopening the original wall-vs-door gap. Root cause, confirmed by
// directly measuring `block.digTime()` (the same call movements.js's own safeOrBreak makes):
// digTime for the SAME block varies over 100x depending on what tool the bot happens to own --
// cobblestone measured 100ms with a netherite pickaxe + efficiency 5, 10000ms with no tool at
// all. `laborCost = (1 + 3*digTime/1000) * digCost` means those two cases scale by roughly 1.3x
// and 31x the same digCost respectively -- no single flat digCost can be both a meaningful
// deterrent for the common (well-tooled) case and safe against the same maxCost pruning §47
// already fixed once for the rare (untooled/slow) case; raising it enough for the former
// recreates the latter's crisis outright. Capping the labor-cost contribution directly
// sidesteps the tradeoff instead of chasing an unsatisfiable single number: MAX_DIG_LABOR_COST
// bounds what any ONE dig step can cost the search regardless of digTime, so it can never
// single-handedly exceed the ~48-58 budget (bot.pathfinder.searchRadius=48), while digCost
// itself (15, unchanged intent from §44/§47, just now actually reaching well-tooled digs) still
// sets a real, comparable-to-a-real-detour cost for the common case the cap doesn't touch.
// Flagged: a route needing 3+ digs in one path could still approach the budget even capped
// (3 * 20 = 60) -- not addressed here since no live report has ever shown more than one dig
// being the actual blocker, matching liquidCost's own still-open flag from §47.
// mineflayer-pathfinder 2.4.5 decides passability from the block TYPE's boundingBox, which is
// "block" for every door and fence gate whether open or closed, and only treats names containing
// "gate" as openable. So an open door or open gate was a solid wall (and doors are in
// blocksCantBreak, so no route at all), and a closed door was never opened. Judge them by state
// instead: open = walkable; a closed wooden door or gate = openable, which getMoveForward turns
// into a "use this block" step (the executor right-clicks it, then walks through). Opening a
// door's lower half opens both, so a closed upper half counts as passable. Iron doors only open by
// redstone. A door is never something to stand on.
export function applyDoorState(b) {
  const name = b?.name;
  const door = !!name?.endsWith("_door");
  if (!door && !name?.endsWith("_fence_gate")) return b;
  if (door) b.physical = false;
  const props = b.getProperties?.() || {};
  if (props.open) {
    b.safe = true;
    b.openable = false;
  } else if (name !== "iron_door") {
    if (door && props.half === "upper") {
      b.safe = true;
      b.openable = false;
    } else {
      b.openable = true;
    }
  }
  return b;
}

export function isOpenDoorOrGate(block) {
  const name = block?.name;
  return !!(name?.endsWith("_door") || name?.endsWith("_fence_gate")) && block.getProperties?.().open === true;
}

// Pathfinder's path clean-up (postProcessPath) lifts each waypoint onto the top of whatever shape
// fills its block -- right for a slab or carpet, but in a doorway that block is the door, so the
// waypoint landed ON the door's lower half, one block up, and the bot tried to climb it forever
// (live, 2026-09-25). Clean-up also stops at the first "use a block" step, leaving a closed door's
// waypoint on the block's corner, exactly where the opened door's panel swings to. Any waypoint in
// or lifted over a doorway goes back to the centre of the door block, at floor level.
export function fixDoorWaypoints(bot, path) {
  for (const point of path) {
    const fx = Math.floor(point.x), fz = Math.floor(point.z);
    for (const dy of [0, -1]) {
      const block = bot.blockAt(new Vec3(fx, Math.floor(point.y) + dy, fz));
      if (!block?.name?.endsWith("_door") || block.getProperties?.().half !== "lower") continue;
      point.x = fx + 0.5;
      point.y = block.position.y;
      point.z = fz + 0.5;
      break;
    }
  }
}

// Called once per bot after the pathfinder plugin loads (index.js, and the live tests). path_update
// fires synchronously before pathfinder adopts results.path, so fixing the points there is enough.
// Pathfinder's executor also "uses" a door on the route even if someone opened it after the path
// was planned, which would shut it in the bot's face -- skipped, but only while pathfinding, so
// herd_to_pen still closes its gate deliberately after she has stopped.
export function installDoorSupport(bot) {
  bot.on("path_update", (results) => fixDoorWaypoints(bot, results.path));
  const activateBlock = bot.activateBlock.bind(bot);
  bot.activateBlock = (block, ...rest) => (bot.pathfinder.isMoving() && isOpenDoorOrGate(block)
    ? Promise.resolve() : activateBlock(block, ...rest));
}

const MAX_DIG_LABOR_COST = 20;

export class SwimMovements extends Movements {
  getBlock(pos, dx, dy, dz) {
    return applyDoorState(super.getBlock(pos, dx, dy, dz));
  }

  getMoveDown(node, neighbors) {
    const current = this.getBlock(node, 0, 0, 0);
    if (!isWater(current)) return super.getMoveDown(node, neighbors);

    // A controlled one-block descent while already swimming -- block0.safe already excludes
    // lava/fire/cobweb (Movements' own getBlock() sets it, see its "!this.blocksToAvoid.has"
    // clause), so this can only ever descend into more water or open air, never a hazard.
    if (this.getNumEntitiesAt(node, 0, -1, 0) > 0) return;
    const block0 = this.getBlock(node, 0, -1, 0);
    if (!block0.safe) return;

    neighbors.push(new Move(node.x, node.y - 1, node.z, node.remainingBlocks, 1 + this.liquidCost));
  }

  getMoveUp(node, neighbors) {
    const block1 = this.getBlock(node, 0, 0, 0);
    if (!isWater(block1)) return super.getMoveUp(node, neighbors);

    // The other half of the same gap: this is what actually lets a bot who dove down (or fell
    // in) resurface via real pathfinding, rather than relying only on the emergency "hold jump"
    // reflex (index.js 2.29.0), which only ever fires once oxygen is already critical.
    if (this.getNumEntitiesAt(node, 0, 1, 0) > 0) return;
    const block2 = this.getBlock(node, 0, 2, 0);
    if (!block2.safe) return;

    neighbors.push(new Move(node.x, node.y + 1, node.z, node.remainingBlocks, 1 + this.liquidCost));
  }

  // See MAX_DIG_LABOR_COST's own comment above for why this exists. Deliberately a full
  // reimplementation rather than a call-super-then-adjust wrapper -- safeOrBreak fuses
  // exclusionStep/entityCost/laborCost into one returned number with no way to recover just the
  // labor-cost component afterward, and this codebase already has a direct precedent for
  // reimplementing a small vendor method wholesale (getMoveDown/getMoveUp above) rather than
  // fighting the library's own return shape. Every line before the final `cost +=` is copied
  // verbatim from mineflayer-pathfinder's own movements.js so behavior stays identical except for
  // the one clamp this override exists to add.
  safeOrBreak(block, toBreak) {
    let cost = 0;
    cost += this.exclusionStep(block);
    cost += this.getNumEntitiesAt(block.position, 0, 0, 0) * this.entityCost;
    if (block.safe) return cost;
    if (!this.safeToBreak(block)) return 100;
    toBreak.push(block.position);
    if (block.physical) cost += this.getNumEntitiesAt(block.position, 0, 1, 0) * this.entityCost;

    const tool = this.bot.pathfinder.bestHarvestTool(block);
    const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : [];
    const effects = this.bot.entity.effects;
    const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects);
    const laborCost = (1 + 3 * digTime / 1000) * this.digCost;
    cost += Math.min(laborCost, MAX_DIG_LABOR_COST);
    return cost;
  }
}
