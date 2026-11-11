// Version: 1.0.0
//
// The "place_home" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { performActionAs } from "../actions.js";


// Review MB-08 follow-up (2026-09-24): the Builder's checklist items ("go home and place a
// furnace there") as one deterministic action -- walk home, then place -- instead of hoping
// the planner sequences GOHOME and PLACE correctly. goalTick uses it directly (see
// runBuilderPlacement); "gohome"/"place" do the actual work, sharing this call's token.
export async function placeHomeAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  if (!bot.inventory.items().some((i) => i.name === action.item)) {
    return fail(`don't have a ${action.item} to place.`);
  }
  const home = await performActionAs(bot, { type: "gohome" }, speaker, token);
  if (token.cancelled) return home;
  if (!home.ok) return fail(`couldn't get home to place the ${action.item}: ${home.text}`);
  const placed = await performActionAs(bot, { type: "place", item: action.item }, speaker, token);
  return placed.ok ? ok(`placed a ${action.item} at home.`) : placed;
}
