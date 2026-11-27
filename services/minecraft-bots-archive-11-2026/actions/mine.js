// Version: 1.2.0
//
// 1.2.0 (2026-11-23, direct report "if a bot mines a tree for wood, they should mine the whole
// tree... pick up any dropped items... replant any saplings"): a wood-family target now expands
// to the whole tree -- expandWholeTree()'s own comment below has the detail -- instead of
// stopping at whichever single log findBlocks/rankMineTargets happened to hand back (almost
// always the exposed base, per gatherPlanks' own typical "mine oak_log 1"). collectBlocks
// already walks to and picks up every drop from every block it digs, so pulling the leaves into
// that same list is the entire "pick up dropped items" fix; replanting any sapling that drops is
// already checkSaplings' job (upkeep-home.js) and needed no change at all.
//
// 1.1.0 (2026-11-22, direct report "some of the bots are underground, deep... thus no wood --
// they should know to climb out to the surface to get wood"): a wood-family search (oak_log and
// friends) that's still empty after the remembered-spot and wander-and-retry fallbacks now climbs
// toward the surface (action-search.js 1.1.0's climbTowardSurface()) and tries once more, wander
// included, before giving up. Ore/stone never climbs -- see WOOD_BLOCK_RE's own comment.
//
// 1.0.0 (2026-11-10) -- split out of actions.js's performActionAs() switch
// (actions.js 2.0.0) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { isLivingSpaceWall } from "../shelter.js";
import path from "node:path";
import { ACTION_TIMEOUT_MS, CONTENTION_SEARCH_OVERFETCH, MINE_DROPS, MINE_RANKING_FETCH, MINE_SEARCH_RADIUS, climbTowardSurface, collectBlocks, filterAwayFromOtherBots, isProtectedBlockName, itemNamesForMinedBlocks, noteMineUnreachable, rankMineTargets, refreshGear, resolveBlockFamily, tryTakeFromNearbyChest, visitRememberedSpot, wanderAndRetryFind, withTimeout } from "../actions.js";

// Wood-family block names (oak_log, stripped_birch_log, warped_stem, ...) -- the surface-biased
// resource climbTowardSurface() exists for. Never ore/stone: those are legitimately underground,
// and climbing toward the surface to look for them would be actively wrong.
const WOOD_BLOCK_RE = /_(log|stem)$/;

// orthogonal only -- a tree's own logs and leaves are always face-connected in vanilla
// generation, and this keeps the search cheap and exact (no diagonal leak into a block that
// just happens to sit next to, rather than belong to, the same tree).
const TREE_NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// A real dark oak or giant jungle trunk can be 2x2; jungle canopies are the largest leaf volume
// in the game. Generous enough for any of that, while still bounding a flood fill that could
// otherwise run away if two trees' canopies happen to touch.
const TREE_TRUNK_CAP = 48;
const TREE_LEAF_CAP = 96;

// Every block matching `matches`, reachable from `startPositions` by a chain of face-adjacent
// matching blocks -- `startPositions` themselves are never returned (the caller already has
// those; this only finds what's newly connected to them).
function connectedBlocks(bot, startPositions, matches, cap) {
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const seen = new Set(startPositions.map(key));
  const found = [];
  const queue = [...startPositions];
  while (queue.length && found.length < cap) {
    const pos = queue.shift();
    for (const [dx, dy, dz] of TREE_NEIGHBORS) {
      const next = pos.offset(dx, dy, dz);
      const k = key(next);
      if (seen.has(k)) continue;
      seen.add(k);
      const block = bot.blockAt(next);
      if (!block || !matches(block)) continue;
      found.push(block);
      queue.push(next);
      if (found.length >= cap) break;
    }
  }
  return found;
}

// Direct report, 2026-11-23 ("mine the whole tree, not just what's at ground level... pick up
// any dropped items"): the rest of `seed`'s own trunk -- every block of the exact same id
// connected to it (never resolveBlockFamily's whole cross-species id list the caller searched
// with, so this can never jump from one tree into a different, merely-nearby one) -- plus, for a
// real species log (a nether stem has no comparable leaf canopy, so skipped entirely), its
// attached leaves, found the same way starting from every trunk block just found. Returns only
// the EXTRA blocks (seed excluded, exactly like connectedBlocks()'s own contract); the caller
// still has seed.
function expandWholeTree(bot, seed) {
  // A real mineflayer Block always has a numeric .type; this only guards against ever matching
  // "b.type === undefined" against every neighbor whose own .type also happens to be unset,
  // which would flood the whole cap instead of stopping at the tree's real edge.
  if (seed.type === undefined) return [];
  const trunk = connectedBlocks(bot, [seed.position], (b) => b.type === seed.type, TREE_TRUNK_CAP - 1);
  if (!seed.name.endsWith("_log")) return trunk;
  const leafId = bot.registry.blocksByName?.[seed.name.replace(/_log$/, "_leaves")]?.id;
  if (leafId === undefined) return trunk;
  const leaves = connectedBlocks(bot, [seed.position, ...trunk.map((b) => b.position)],
    (b) => b.type === leafId, TREE_LEAF_CAP);
  return [...trunk, ...leaves];
}


export async function mineAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  const blockIds = resolveBlockFamily(bot, action.block);
  if (!blockIds.length) return fail(`I don't recognize the block "${action.block}".`);
  // Direct request, 2026-09-08 ("make sure it is not a functional block like a bed or a
  // furnace... before they dig or destroy a block"). resolveBlockFamily()'s own raw
  // single-name fallback will resolve ANY real block name, functional ones included --
  // checked here, not inside that function, so it stays a pure "does this name exist"
  // resolver and every caller decides for itself what's off-limits.
  if (blockIds.some((id) => isProtectedBlockName(bot.registry.blocks[id]?.name))) {
    return fail(`won't mine ${action.block} -- that's a placed/crafted block, not a raw resource.`);
  }

  const wantCount = action.count || 1;
  // Direct request, 2026-09-08 ("if a resource is in a nearby chest, they should not mine
  // it"). Checks the REAL resulting item (itemNamesForMinedBlocks/MINE_DROPS above), not the
  // block name itself -- a chest holds raw_iron, not iron_ore.
  //
  // Real bug found live 2026-10-13 (direct report: "building and tooling do not [work]"): a
  // chest holding FEWER than wantCount was still treated as fully satisfying the request --
  // Babs looped for 20+ minutes on "found 1 ... already in a chest, no need to mine it"
  // (wanted more) immediately followed by a craft that needed the full count and failed every
  // time, with nothing ever mining the shortfall. Takes whatever a chest has and mines the
  // rest herself instead of calling a partial match done.
  const chestMatch = await tryTakeFromNearbyChest(bot, token,
    itemNamesForMinedBlocks(bot, blockIds), wantCount);
  if (chestMatch && chestMatch.count >= wantCount) {
    await refreshGear(bot);
    return ok(`found ${chestMatch.count} ${chestMatch.name} already in a chest, no need to mine it.`);
  }
  const stillNeed = wantCount - (chestMatch?.count ?? 0);

  // Fetched wide enough for rankMineTargets() to find an exposed face beyond the nearest few.
  const findOptions = { matching: blockIds, maxDistance: MINE_SEARCH_RADIUS,
    count: Math.max(stillNeed * CONTENTION_SEARCH_OVERFETCH, MINE_RANKING_FETCH) };
  let positions = bot.findBlocks(findOptions);
  // Direct request, 2026-09-11 ("each bot uses the global world memory to gather a resource
  // it needs, if it's not in their immediate vicinity"): a remembered position -- her own
  // earlier scan, or another bot's, either written directly or in response to a "scout"
  // broadcast (see index.js's noteNearbyResources()/the "scout" Buzz payload) -- is worth
  // trying BEFORE the blind extended wander below: cheap (one RAG query, no movement) and,
  // when it hits, a direct trip instead of a directionless search. A stale/wrong note just
  // falls through to the exact same wander fallback that already existed, no worse off than
  // before this existed.
  if (!positions.length) positions = await visitRememberedSpot(bot, token, action.block, () => bot.findBlocks(findOptions));
  if (!positions.length) positions = await wanderAndRetryFind(bot, token, findOptions);
  // Direct report, 2026-11-22 ("some of the bots are underground, deep... thus no wood. They
  // should know to climb out to the surface to get wood"): wanderAndRetryFind only ever moves
  // horizontally, so a bot deep in a cave never finds a tree however far she wanders sideways.
  // Wood only, never ore/stone -- those are legitimately underground, and "couldn't find any
  // coal_ore nearby" should never send her climbing toward the surface to look for it.
  let climbed = false;
  if (!positions.length && WOOD_BLOCK_RE.test(action.block)) {
    climbed = true;
    await climbTowardSurface(bot, token);
    positions = bot.findBlocks(findOptions);
    if (!positions.length) positions = await wanderAndRetryFind(bot, token, findOptions);
  }
  if (!positions.length) {
    return fail(climbed ? `couldn't find any ${action.block} nearby, even after climbing toward the surface to look.`
      : `couldn't find any ${action.block} nearby, even after looking around.`);
  }
  // Direct request, 2026-10-07 ("recognize walls around living spaces... do not knock holes
  // in them"): "mine cobblestone 16" standing in the shared base is a perfectly reasonable
  // step whose nearest 16 matches are the shelter's own walls. Filtered rather than refused
  // -- the same cobblestone a few blocks further out is a fine answer, and refusing the whole
  // action would turn a solvable goal step into a dead end. shelter.js's shell is deliberately
  // not consulted for a DELIBERATE target the way pathfinder's own digging is; this is the one
  // place a bot picks its own target by name, with no idea what it's pointing at.
  const inWall = positions.filter((pos) => isLivingSpaceWall(bot, pos)).length;
  if (inWall) {
    positions = positions.filter((pos) => !isLivingSpaceWall(bot, pos));
    console.log(`[${bot.username}] mine: skipped ${inWall} ${action.block} in a shelter wall`);
    if (!positions.length) {
      return fail(`the only ${action.block} nearby is part of a shelter wall -- not digging that out.`);
    }
  }
  positions = rankMineTargets(bot, positions);
  if (!positions.length) {
    return fail(`every ${action.block} nearby is one I just couldn't path to -- trying elsewhere later.`);
  }
  positions = filterAwayFromOtherBots(bot, positions).slice(0, stillNeed);
  const blocks = positions.map((pos) => bot.blockAt(pos)).filter(Boolean);
  // Report what she actually found/collected, not just the name she was originally given --
  // asked for "oak_log" but the only trees around were spruce, this should say so rather than
  // claiming oak_log when resolveBlockFamily is what actually made that substitution work.
  const collectedNames = [...new Set(blocks.map((b) => b.name))].join(", ");

  // Direct request, 2026-09-07 ("build the water crossing mechanic" -> "do 1,2,4,5" -> a
  // tech-tier check, following external research on how Voyager avoids wasted mining
  // attempts by sequencing wood -> stone -> iron -> diamond tools explicitly instead of
  // letting a model free-associate a target each cycle). Real data, not a hand-typed tier
  // table that could drift from whatever this server's actual version considers correct:
  // block.harvestTools (minecraft-data, confirmed live against this exact server's registry
  // -- e.g. iron_ore requires copper/stone/iron/diamond/netherite pickaxe, gold pickaxe is
  // deliberately absent from that list despite mining faster, matching real vanilla) is
  // undefined for a block with no tool requirement at all (coal/wood need nothing) and a
  // real {itemId: true} lookup otherwise. Checking her whole inventory, not just whatever's
  // currently held, since mineflayer-tool's own equipForBlock() (already wired via
  // mineflayer-collectblock) re-equips the best tool she owns before actually digging --
  // this only needs to answer "does she own ANY tool that would work," not which one.
  const toolReq = blocks[0]?.harvestTools;
  if (toolReq && !bot.inventory.items().some((item) => toolReq[item.type])) {
    const needed = Object.keys(toolReq).map((id) => bot.registry.items[id]?.name).filter(Boolean);
    return fail(`need a better tool for ${collectedNames} -- one of: ${needed.join(", ")}.`);
  }

  // Whole tree, not just the log(s) findBlocks happened to hand back -- see expandWholeTree()'s
  // own comment. Deduped since stillNeed > 1 can select two exposed logs off the same tall tree.
  let mineBlocks = blocks;
  if (blocks.some((b) => WOOD_BLOCK_RE.test(b.name))) {
    const seenKey = new Set(blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`));
    const extra = [];
    for (const b of blocks.filter((b) => WOOD_BLOCK_RE.test(b.name))) {
      for (const t of expandWholeTree(bot, b)) {
        const k = `${t.position.x},${t.position.y},${t.position.z}`;
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        extra.push(t);
      }
    }
    mineBlocks = [...blocks, ...extra];
  }

  try {
    await withTimeout(collectBlocks(bot, token, mineBlocks), ACTION_TIMEOUT_MS,
                       () => { bot.collectBlock.cancelTask(); bot.stopDigging(); });
  } catch (err) {
    if (token.cancelled) return ok("stopped mining early.");
    if (err.name === "NoPath" || /no path/i.test(err.message)) noteMineUnreachable(bot, mineBlocks);
    return fail(`had trouble mining ${collectedNames}: ${err.message}`);
  } finally {
    if (!token.cancelled) await refreshGear(bot); // may have picked up something worth wearing/wielding
  }
  if (token.cancelled) return ok("stopped mining early.");
  const minedNames = [...new Set(mineBlocks.map((b) => b.name))].join(", ");
  return ok(chestMatch ? `took ${chestMatch.count} ${chestMatch.name} from a chest and collected some ${minedNames}.`
    : `collected some ${minedNames}.`);
}
