// Version: 1.0.0
//
// The "place_bed" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { wouldBlockAccess, posKey } from "../shelter.js";
import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, bedSpotKey, cellOccupied, clearCellForPlacement, findBedSites, goals, isRecentlyRefusedBedSpot, performActionAs, refreshGear, refusedBedSpots, withTimeout } from "../actions.js";


export async function placeBedAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // 2026-09-26: "place" put a bed down like any one-block item, next to wherever she stood --
  // a bed needs two free, supported cells the way she faces, and nothing checked it appeared.
  const bedItem = bot.inventory.items().find((i) => i.name.endsWith("_bed"));
  if (!bedItem) return fail("don't have a bed to place.");
  // 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 item 1a): an optional target, same shape as
  // "store"'s own action.near -- without it, unchanged (her claimed-bed/spawn "home", via
  // "gohome"). The communal shelter's own runner passes its site here instead, so a bed meant
  // for the communal room doesn't end up scattered wherever findBedSites' generic "nearest
  // covered spot near home" scoring happens to prefer.
  const target = action.near ? new Vec3(action.near.x, action.near.y, action.near.z) : null;
  // 2026-10-30: action.cells, optional -- the bed must stand in these cells (a shelter goal
  // passes its own room). Babs placed two beds "near" her shelter that landed elsewhere
  // nearby, so her shelter stayed bedless and she went for wool for a third.
  const within = action.cells ? new Set(action.cells.map(posKey)) : null;
  const home = target
    ? await (async () => {
        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 3)),
            ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
          return ok("made it to the target site.");
        } catch (err) {
          return token.cancelled ? ok("stopped heading to the target site.") : fail(`couldn't reach the target site: ${err.message}`);
        } finally {
          if (!token.cancelled) bot.pathfinder.setGoal(null);
        }
      })()
    : await performActionAs(bot, { type: "gohome" }, speaker, token);
  if (token.cancelled) return home;
  if (!home.ok) return fail(`couldn't get to the bed site: ${home.text}`);
  // Up to 4 spots, best first: a refusal (someone stepped into it, a stale view) moves on to the
  // next instead of retrying the same one. A bed that appeared despite an error still counts.
  const tried = [];
  const unreachable = []; // in `tried` too, but never offered to the server
  let site = null;
  for (let attempt = 0; attempt < 4 && !token.cancelled && !site; attempt++) {
    // 2026-10-07: a bed is two solid blocks, so it impedes access exactly like any other
    // placement -- and findBedSites prefers the shelter room, which is where the chests and
    // the door are. Judged inside the predicate, not recorded in `tried`: the four attempts
    // each re-read the world, and a spot that is blocked now may not be on the next pass
    // (someone moves a chest, another bot clears the way) -- unlike a spot the SERVER
    // refused, which is what `tried` is for.
    const candidate = findBedSites(bot, target ?? bot.spawnPoint ?? bot.entity.position, within)
      .find((c) => !tried.some((t) => t.equals(c.foot)) &&
        !wouldBlockAccess(bot, c.foot) && !wouldBlockAccess(bot, c.head) &&
        !isRecentlyRefusedBedSpot(c.foot));
    if (!candidate) break;
    tried.push(candidate.foot);
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(candidate.stand.x, candidate.stand.y, candidate.stand.z)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
    } catch {
      if (token.cancelled) return ok("stopped on the way to the bed spot.");
      unreachable.push(candidate.foot);
      continue; // unreachable -- next spot
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return ok("stopped before placing the bed.");
    if (cellOccupied(bot, candidate.foot) || cellOccupied(bot, candidate.head)) continue; // someone walked in
    const bedNow = bot.inventory.items().find((i) => i.name.endsWith("_bed"));
    if (!bedNow) break;
    try {
      await clearCellForPlacement(bot, candidate.foot);
      await clearCellForPlacement(bot, candidate.head);
      await bot.equip(bedNow, "hand");
      await bot.placeBlock(bot.blockAt(candidate.foot.offset(0, -1, 0)), new Vec3(0, 1, 0));
    } catch (err) {
      refusedBedSpots.set(bedSpotKey(candidate.foot), Date.now());
      console.log(`[${bot.username}] place_bed: ${candidate.foot} refused (${err.message}) -- trying another spot`);
    }
    await new Promise((r) => setTimeout(r, 250)); // the head half's update lands a tick later
    if (bot.isABed(bot.blockAt(candidate.foot)) && bot.isABed(bot.blockAt(candidate.head))) site = candidate;
  }
  await refreshGear(bot);
  if (token.cancelled) return ok("stopped placing the bed.");
  if (!site) {
    // 2026-10-30: two 90s path timeouts read "the server refused the bed" for hours, with no
    // refusal ever logged -- the real problem (a door the pathfinder couldn't get through) hid.
    const refused = tried.filter((t) => !unreachable.includes(t));
    return fail(refused.length ? `the server refused the bed at ${refused.length} spot(s) near home (${refused.join(", ")}).`
      : tried.length ? `couldn't reach where she'd stand to place the bed at ${tried.length} spot(s) (${tried.join(", ")}).`
      : within ? "couldn't find room for a bed inside the shelter's own room."
      : "couldn't find two free, flat blocks in a row near home for a bed.");
  }
  return { ...ok(`placed a ${bedItem.name} at home.`), bedAt: { x: site.foot.x, y: site.foot.y, z: site.foot.z } };
}
