// Version: 1.0.0
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

const { Movements } = pathfinderPkg;

function isWater(block) {
  return !!block && (block.name === "water" || block.name === "flowing_water" || block.name === "bubble_column");
}

export class SwimMovements extends Movements {
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
}
