// Version: 1.0.0
//
// The "breed" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, BREEDING_FOOD, goals, recordAchievement, refreshGear, withTimeout } from "../actions.js";


export async function breedAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07 ("what else can we add" -> animal breeding, the other half
  // of a sustainable food source). Built on mineflayer's own activateEntity() (core --
  // confirmed against inventory.js source: right-clicks the entity while holding whatever's
  // equipped, exactly vanilla's own feed-to-breed mechanic, no dedicated "breed" API needed).
  // BREEDING_FOOD hoisted to module scope 2026-09-11 -- see its own comment above.
  const foods = BREEDING_FOOD[action.species];
  if (!foods) return fail(`don't know how to breed a ${action.species}.`);
  const foodItem = bot.inventory.items().find((i) => foods.includes(i.name));
  if (!foodItem) return fail(`don't have the right food to breed a ${action.species} (need ${foods[0]}).`);

  // action.near (a ranch goal's pen centre): breed the pair inside the pen, not two strays.
  const near = action.near ? new Vec3(action.near.x + 0.5, action.near.y, action.near.z + 0.5) : null;
  const kin = () => Object.values(bot.entities).filter((e) => e.name === action.species &&
    (near ? e.position.distanceTo(near) <= 3.6 : e.position.distanceTo(bot.entity.position) <= 24));
  const before = kin().length;
  const animals = kin().slice(0, 2);
  if (animals.length < 2) {
    return fail(`need two ${action.species}s nearby to breed, only found ${animals.length}.`);
  }

  try {
    await bot.equip(foodItem, "hand");
  } catch (err) {
    return fail(`couldn't hold the ${foodItem.name}: ${err.message}`);
  }

  let fed = 0;
  for (const animal of animals) {
    if (token.cancelled) return ok("stopped breeding.");
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalFollow(animal, 2)), ACTION_TIMEOUT_MS,
        () => bot.pathfinder.setGoal(null));
      await bot.activateEntity(animal);
      fed++;
    } catch (err) {
      console.error(`breed: couldn't feed one ${action.species}:`, err.message);
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
  }
  await refreshGear(bot);
  if (!fed) return fail(`couldn't get close enough to feed any ${action.species}s.`);
  // 2026-09-25: success used to be "fed some" -- a pair already on cooldown, or one fed twice,
  // looked the same. A baby appearing within ~10s is the real result.
  let bred = false;
  for (let waited = 0; waited < 10_000 && !token.cancelled; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    if (kin().length > before) { bred = true; break; }
  }
  if (!bred) return fail(`fed ${fed} ${action.species}${fed > 1 ? "s" : ""}, but no baby came of it (on cooldown, or too young?).`);
  await recordAchievement(bot, `bred:${action.species}`);
  return { ...ok(`bred a baby ${action.species}.`), bred: action.species };
}
