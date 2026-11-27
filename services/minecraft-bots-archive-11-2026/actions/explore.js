// Version: 1.0.0
//
// The "explore" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { ACTION_TIMEOUT_MS, CONTENTION_SEARCH_OVERFETCH, EXPLORE_SEARCH_RADIUS, SCOUT_FEATURE_BLOCKS, collectBlocks, filterAwayFromOtherBots, getResourceBlockNames, refreshGear, resolveBlockFamily, wanderAndRetryFind, withTimeout } from "../actions.js";


export async function exploreAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-08 ("if they can't craft, they should explore, and find
  // resources for later"). For when a specific target isn't known -- CRAFT failed on a
  // missing ingredient with nothing obvious nearby, but there's no one named block worth a
  // dedicated "mine" attempt. Scans broadly for ANY common raw material (every log species,
  // every ore family -- the same real id sets resolveBlockFamily() already resolves for a
  // single request) instead of one target, reusing the same directed extended-search
  // wandering wanderAndRetryFind() already relies on for "mine." Gathers a full batch of
  // whatever's found first, not just enough for right now -- the travel is the real cost
  // here, not the extra inventory slots, so "find resources for later" means actually
  // stockpiling while she's already out looking, not just solving today's shortage.
  // Review MB-16, 2026-09-24: EXPLORE used to succeed on the spot whenever a nearby chest held
  // any common resource -- Wade could "explore" by withdrawing home stock, and a "find a
  // village" goal was satisfied by a stocked chest. Chest withdrawal is LOOT's job, so that
  // shortcut is gone. `action.feature` (EXPLORE <feature>) is a separate scouting mode that
  // only succeeds when a block unique to that feature is actually found.
  if (action.feature) {
    const featureBlocks = SCOUT_FEATURE_BLOCKS[action.feature];
    if (!featureBlocks) return fail(`don't know how to recognize a ${action.feature}.`);
    const ids = featureBlocks.map((name) => bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined);
    const scoutOptions = { matching: ids, maxDistance: EXPLORE_SEARCH_RADIUS * 2, count: 1 };
    let found = bot.findBlocks(scoutOptions);
    if (!found.length) found = await wanderAndRetryFind(bot, token, scoutOptions);
    if (token.cancelled) return ok("stopped scouting early.");
    if (!found.length) return fail(`scouted around but found no sign of a ${action.feature}.`);
    const at = found[0].floored?.() ?? found[0];
    return ok(`found a ${action.feature} (${bot.blockAt(found[0])?.name ?? "landmark"} at ${at.x}, ${at.y}, ${at.z})`);
  }

  const blockIds = getResourceBlockNames(bot)
    .map((name) => bot.registry.blocksByName[name]?.id)
    .filter((id) => id !== undefined);

  const EXPLORE_BATCH_COUNT = 8;

  const findOptions = { matching: blockIds, maxDistance: EXPLORE_SEARCH_RADIUS, count: EXPLORE_BATCH_COUNT * CONTENTION_SEARCH_OVERFETCH };
  let positions = bot.findBlocks(findOptions);
  if (!positions.length) positions = await wanderAndRetryFind(bot, token, findOptions);
  if (!positions.length) return fail("didn't find anything useful nearby, even after looking around.");
  positions = filterAwayFromOtherBots(bot, positions).slice(0, EXPLORE_BATCH_COUNT);
  const blocks = positions.map((pos) => bot.blockAt(pos)).filter(Boolean);
  const collectedNames = [...new Set(blocks.map((b) => b.name))].join(", ");

  // Same tool-tier gate "mine" already applies -- no point starting a collect on ore she
  // can't yet break, same real block.harvestTools data.
  const toolReq = blocks[0]?.harvestTools;
  if (toolReq && !bot.inventory.items().some((item) => toolReq[item.type])) {
    return fail(`found ${collectedNames} but don't have a good enough tool for it yet.`);
  }

  try {
    await withTimeout(collectBlocks(bot, token, blocks), ACTION_TIMEOUT_MS,
                       () => { bot.collectBlock.cancelTask(); bot.stopDigging(); });
  } catch (err) {
    if (token.cancelled) return ok("stopped exploring early.");
    return fail(`found ${collectedNames} but had trouble gathering it: ${err.message}`);
  } finally {
    if (!token.cancelled) await refreshGear(bot);
  }
  return token.cancelled ? ok("stopped exploring early.") : ok(`explored and found some ${collectedNames}.`);
}
