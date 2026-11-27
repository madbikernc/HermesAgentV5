// Version: 1.0.0
//
// The "hunt" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { FOOD_NAMES, HUNTABLE_ANIMALS, HUNT_RANGE, collectDrops, performActionAs } from "../actions.js";


export async function huntAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // 2026-10-30: Babs sat at food 0 for hours -- every chest near home empty of food, no rod --
  // with nothing left to try. Raw beef/pork/mutton/rabbit are already edible (FOOD_NAMES).
  // A species' last two nearby are left alone: they're someone's breeding pair, or will be.
  const near = (e) => e.position.distanceTo(bot.entity.position) <= HUNT_RANGE;
  const herd = (name) => Object.values(bot.entities).filter((e) => e.name === name && near(e)).length;
  const prey = () => Object.values(bot.entities)
    .filter((e) => HUNTABLE_ANIMALS.has(e.name) && near(e) && herd(e.name) > 2)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  const food = () => bot.inventory.items().filter((i) => FOOD_NAMES.includes(i.name)).reduce((n, i) => n + i.count, 0);
  const before = food();
  let sawPrey = false;
  for (let tries = 0; tries < 3 && food() === before && !token.cancelled; tries++) {
    const animal = prey();
    if (!animal) break;
    sawPrey = true;
    const got = await performActionAs(bot, { type: "attack", target: animal }, speaker, token);
    if (token.cancelled) return ok("stopped hunting.");
    if (!got.ok) continue;
    await collectDrops(bot, token, [bot.entity.position.clone()], 6000);
  }
  if (food() > before) return ok(`hunted: now carrying ${food()} food.`);
  return fail(sawPrey ? "hunted, but came away with no food." : `no animals to spare within ${HUNT_RANGE} blocks to hunt.`);
}
