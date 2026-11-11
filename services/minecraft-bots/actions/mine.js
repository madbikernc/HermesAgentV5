// Version: 1.0.0
//
// The "mine" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { isLivingSpaceWall } from "../shelter.js";
import path from "node:path";
import { ACTION_TIMEOUT_MS, CONTENTION_SEARCH_OVERFETCH, MINE_DROPS, MINE_RANKING_FETCH, MINE_SEARCH_RADIUS, collectBlocks, filterAwayFromOtherBots, isProtectedBlockName, itemNamesForMinedBlocks, noteMineUnreachable, rankMineTargets, refreshGear, resolveBlockFamily, tryTakeFromNearbyChest, visitRememberedSpot, wanderAndRetryFind, withTimeout } from "../actions.js";


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
  if (!positions.length) return fail(`couldn't find any ${action.block} nearby, even after looking around.`);
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

  try {
    await withTimeout(collectBlocks(bot, token, blocks), ACTION_TIMEOUT_MS,
                       () => { bot.collectBlock.cancelTask(); bot.stopDigging(); });
  } catch (err) {
    if (token.cancelled) return ok("stopped mining early.");
    if (err.name === "NoPath" || /no path/i.test(err.message)) noteMineUnreachable(bot, blocks);
    return fail(`had trouble mining ${collectedNames}: ${err.message}`);
  } finally {
    if (!token.cancelled) await refreshGear(bot); // may have picked up something worth wearing/wielding
  }
  if (token.cancelled) return ok("stopped mining early.");
  return ok(chestMatch ? `took ${chestMatch.count} ${chestMatch.name} from a chest and collected some ${collectedNames}.`
    : `collected some ${collectedNames}.`);
}
