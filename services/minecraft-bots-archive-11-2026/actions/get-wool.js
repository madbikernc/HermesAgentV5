// Version: 1.0.0
//
// The "get_wool" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { collectDrops, performActionAs, wanderAndRetryForSheep, woolCounts } from "../actions.js";


export async function getWoolAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Wool for a bed (2026-09-26): shear a sheep with shears, otherwise take it the hard way --
  // a killed sheep drops one wool -- and pick up what drops. Until she holds action.count of
  // one colour, a handful of sheep at most.
  const want = action.count ?? 3;
  const best = () => Math.max(0, ...Object.values(woolCounts(bot)));
  const startedWith = best();
  // 2026-10-28 (direct report: shelters finished, never a bed): no sheep anywhere near home on
  // this seed -- Babs and Dale failed "no sheep nearby" 32+ times each -- while Babs carried 45
  // string from the spiders she fights every night. Four string craft one white wool (2x2, no
  // table), so string she already holds comes before a long, often fruitless sheep hunt.
  const whiteShort = want - (woolCounts(bot).white ?? 0);
  const string = bot.inventory.items().filter((i) => i.name === "string").reduce((n, i) => n + i.count, 0);
  if (best() < want && string >= whiteShort * 4) {
    const crafted = await performActionAs(bot, { type: "craft", item: "white_wool", count: whiteShort }, speaker, token);
    if (token.cancelled) return ok("stopped gathering wool.");
    if (best() >= want) return ok(`crafted wool from string: now have ${best()} of one colour.`);
    console.log(`[${bot.username}] get_wool: crafting wool from string didn't work: ${crafted.text}`);
  }
  for (let tries = 0; tries < 6 && best() < want && !token.cancelled; tries++) {
    let sheep = Object.values(bot.entities)
      .filter((e) => e.name === "sheep" && e.position.distanceTo(bot.entity.position) <= 32)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    // Real bug found live 2026-10-10: this used to just break here -- an instant give-up the
    // moment no sheep happened to be in her current 32-block radius, never once walking
    // anywhere to actually look. wanderAndRetryForSheep() is a single attempt (it already
    // fails fast if the wander itself turns up nothing), so this can only extend the loop by
    // one real search, not six.
    if (!sheep) sheep = await wanderAndRetryForSheep(bot, token);
    if (!sheep) break;
    const shears = bot.inventory.items().some((i) => i.name === "shears");
    const got = await performActionAs(bot, shears ? { type: "shear" } : { type: "attack", target: sheep }, speaker, token);
    if (token.cancelled) return ok("stopped gathering wool.");
    if (!got.ok) continue;
    await collectDrops(bot, token, [bot.entity.position.clone()], 6000);
  }
  if (best() >= want) return ok(`gathered wool: now have ${best()} of one colour.`);
  const gained = best() - startedWith;
  return fail(gained > 0 ? `got ${gained} wool, still short of ${want} of one colour.`
    : "no sheep nearby to get wool from, even after looking around.");
}
