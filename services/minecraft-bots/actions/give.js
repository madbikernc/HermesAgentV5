// Version: 1.0.0
//
// The "give" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, GEAR_SUFFIXES, GEAR_TIER_RANK, gearTierRank, goals, withTimeout } from "../actions.js";


export async function giveAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07: bot-to-bot help. General enough to also work for a human
  // asking directly ("give me some bread") -- classifyIntent resolves the target to the
  // speaker for that case; the autonomous cross-bot request flow (index.js) names the other
  // bot's real in-game username explicitly. Built on mineflayer's own core toss() (drops the
  // item at her own feet -- confirmed against simple_inventory.js source -- so she has to
  // actually be standing next to the recipient first for it to be picked up, same
  // path-then-act pattern as every other action here).
  const target = bot.players[action.player]?.entity;
  if (!target) return fail(`I can't see ${action.player} nearby.`);
  const itemDef = bot.registry.itemsByName[action.item];
  if (!itemDef) return fail(`I don't recognize the item "${action.item}".`);
  const have = bot.inventory.count(itemDef.id, null);
  if (!have) return fail(`don't have any ${action.item} to give.`);
  const giveCount = Math.min(action.count, have);

  // Direct request, 2026-09-19 ("Mayor/Leader missions, if they would effectively DOWNGRADE a
  // bot's equipment or status, should be rejected by the bot"). Real, already-confirmed
  // failure shape (§34/MINECRAFT_BOTS_DESIGN.md): Mark was gifted a sword twice by teammates
  // responding to a request, yet a give this blind can just as easily strip the GIVER bare --
  // "give" never checked whether complying would leave her without a weapon/armor/tool she
  // still needs, whoever asked. Sword and axe are treated as one interchangeable "weapon"
  // category (matching equipment.js's own hasWeapon() definition); armor/tool suffixes are
  // each their own category (a spare pickaxe doesn't cover for giving away her only shovel).
  //
  // Direct follow-up, 2026-09-19 ("must also reject if... the quality of their equipment
  // [would be] reduced"): going to zero was only half of it -- giving away her BEST piece in
  // a category while a worse one stays behind is a downgrade too, even though she'd technically
  // "still have one." Checks the highest GEAR_TIER_RANK she'd be left with in this exact
  // category against the tier of what's being given away.
  const giveSuffix = GEAR_SUFFIXES.find((s) => action.item.endsWith(s));
  if (giveSuffix) {
    const isWeapon = giveSuffix === "_sword" || giveSuffix === "_axe";
    const category = isWeapon ? ["_sword", "_axe"] : [giveSuffix];
    const categoryItems = bot.inventory.items().filter((i) => category.some((s) => i.name.endsWith(s)));
    const totalOfCategory = categoryItems.reduce((sum, i) => sum + i.count, 0);
    const remainingAfterGive = totalOfCategory - giveCount;

    const givingSuffix = category.find((s) => action.item.endsWith(s));
    const givingTier = gearTierRank(action.item, givingSuffix);
    const bestRemainingTier = categoryItems.reduce((best, i) => {
      const remaining = i.name === action.item ? i.count - giveCount : i.count;
      if (remaining <= 0) return best;
      const s = category.find((suf) => i.name.endsWith(suf));
      return Math.max(best, gearTierRank(i.name, s));
    }, -1);

    const wouldZeroOut = remainingAfterGive <= 0;
    const wouldDowngradeQuality = !wouldZeroOut && givingTier >= 0 && givingTier > bestRemainingTier;
    if (wouldZeroOut || wouldDowngradeQuality) {
      const label = isWeapon ? "weapon" : giveSuffix.slice(1);
      const reason = wouldZeroOut ? `that's my only ${label}`
        : `it's my best ${label} and I'd be left with a worse one`;
      return fail(`won't give away my ${action.item} -- ${reason}, and that would leave me ` +
        `worse off than before.`);
    }
  }

  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(target, 2)), ACTION_TIMEOUT_MS,
      () => bot.pathfinder.setGoal(null));
  } catch (err) {
    if (token.cancelled) return ok("stopped on the way.");
    return fail(`couldn't reach ${action.player}: ${err.message}`);
  } finally {
    if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
  }
  if (token.cancelled) return ok("stopped on the way.");

  try {
    await bot.toss(itemDef.id, null, giveCount);
  } catch (err) {
    return fail(`couldn't give the ${action.item}: ${err.message}`);
  }
  return ok(`gave ${giveCount} ${action.item} to ${action.player}.`);
}
