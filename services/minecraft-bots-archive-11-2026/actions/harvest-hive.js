// Version: 1.0.0
//
// The "harvest_hive" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, goals, refreshGear, withTimeout } from "../actions.js";


export async function harvestHiveAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-11 ("bee nests/hives") -- honey output for the Herder role,
  // narrowing (not closing -- pen/fence containment for other animals is still open, §15.11)
  // the gap that section flagged. Real vanilla beehive/bee_nest interaction has no dedicated
  // mineflayer API, same as "harvest"'s own tilling step above -- bot.activateBlock() while
  // holding the right item is the same "simulate a real client interaction" primitive.
  //
  // Direct follow-up, same day ("nest" again -> "honeycomb via shears too"): action.tool
  // picks the real tradeoff explicitly rather than hiding it -- "bottle" (default, honey)
  // never angers the bees at full honey_level; "shears" (honeycomb, the ONLY path to enough
  // honeycomb to ever craft a NEW beehive -- see the "craft"/"place" cases above, both
  // already fully generic, no code change needed there) always does, regardless of level.
  // Defaulting to bottle keeps every self-directed hive visit calm unless a caller
  // specifically needs honeycomb badly enough to accept the risk.
  const useShears = action.tool === "shears";
  const toolName = useShears ? "shears" : "glass_bottle";
  const tool = bot.inventory.items().find((i) => i.name === toolName);
  if (!tool) {
    return fail(`don't have ${useShears ? "shears" : "a glass bottle"} to collect ` +
      `${useShears ? "honeycomb" : "honey"} with.`);
  }

  const hiveIds = [bot.registry.blocksByName.beehive?.id, bot.registry.blocksByName.bee_nest?.id]
    .filter((id) => id !== undefined);
  if (!hiveIds.length) return fail("don't know how to recognize a beehive here.");

  const positions = bot.findBlocks({ matching: hiveIds, maxDistance: 32, count: 10 });
  const fullHive = positions.map((pos) => bot.blockAt(pos))
    .find((block) => block && Number(block.getProperties?.().honey_level) >= 5);
  if (!fullHive) return fail("no full beehive/bee nest nearby -- nothing ready to collect yet.");

  try {
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNear(fullHive.position.x, fullHive.position.y, fullHive.position.z, 2)),
      ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped on the way to the hive.");
    return fail(`couldn't reach the hive: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("stopped before collecting.");

  try {
    await bot.equip(tool, "hand");
    await bot.activateBlock(bot.blockAt(fullHive.position));
  } catch (err) {
    return fail(`couldn't collect ${useShears ? "honeycomb" : "honey"}: ${err.message}`);
  }
  await refreshGear(bot);
  return ok(useShears
    ? "took honeycomb from the hive -- might have upset the bees."
    : "collected a bottle of honey from the hive.");
}
