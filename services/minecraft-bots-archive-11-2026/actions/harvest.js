// Version: 1.0.0
//
// The "harvest" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { Vec3 } from "vec3";
import { ACTION_TIMEOUT_MS, CROP_MAX_AGE, SEED_NAMES, chooseFarmPlot, collectDrops, goals, recordAchievement, refreshGear, tillableAt, withTimeout } from "../actions.js";


export async function harvestAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07 (farming), rebuilt 2026-09-25 from a day of logs: the old
  // start-a-farm branch tilled the 8 nearest dirt blocks wherever they were, counted a till that
  // silently failed (grass on top), ignored water, and never said why it failed. action.near:
  // work around this spot (a farm goal's plot). action.onlyRipe: harvest ripe crops or nothing
  // -- the ripe-crop routine uses it so it never starts a farm on its own.
  const CROP_REPLANT = { wheat: "wheat_seeds", carrots: "carrot", potatoes: "potato", beetroots: "beetroot_seeds" };
  const HARVEST_BATCH_LIMIT = 8;
  const cropIds = Object.keys(CROP_MAX_AGE).map((n) => bot.registry.blocksByName[n]?.id)
    .filter((id) => id !== undefined);
  if (!cropIds.length) return fail("don't know how to recognize any crops here.");
  const near = action.near ? new Vec3(action.near.x, action.near.y, action.near.z) : null;

  const positions = bot.findBlocks({ matching: cropIds, maxDistance: 32, count: 64, ...(near ? { point: near } : {}) });
  const matureBlocks = positions.map((pos) => bot.blockAt(pos))
    .filter((block) => block && Number(block.getProperties?.().age) === CROP_MAX_AGE[block.name])
    .slice(0, HARVEST_BATCH_LIMIT);

  if (!matureBlocks.length) {
    if (action.onlyRipe) return fail("nothing ripe to harvest.");
    const hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
    if (!hoe) return { ...fail("couldn't find any ripe crops, and don't have a hoe to start a new farm."), missing: "hoe" };
    if (!bot.inventory.items().some((i) => SEED_NAMES.includes(i.name))) {
      return { ...fail("couldn't find any ripe crops, and don't have any seeds to start a new farm."), missing: "seeds" };
    }
    const site = chooseFarmPlot(bot, near);
    if (!site) return fail("couldn't find any ripe crops or open ground to start a new farm.");

    let tilled = 0, planted = 0;
    const problems = [];
    for (const pos of site.plot) {
      if (token.cancelled) break;
      if (!tillableAt(bot, pos) && bot.blockAt(pos)?.name !== "farmland") continue; // changed since chosen
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)),
          ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      } catch {
        if (token.cancelled) break;
        problems.push("unreachable");
        continue;
      } finally {
        if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
      }
      if (token.cancelled) break;

      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (above && above.name !== "air") {
        try {
          await withTimeout(bot.dig(above), ACTION_TIMEOUT_MS, () => bot.stopDigging()); // grass often drops seeds
        } catch {
          problems.push(`couldn't clear the ${above.name}`);
          continue;
        }
      }
      if (bot.blockAt(pos)?.name !== "farmland") {
        try {
          const currentHoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
          if (!currentHoe) { problems.push("hoe broke"); break; }
          await bot.equip(currentHoe, "hand");
          await bot.activateBlock(bot.blockAt(pos));
        } catch (err) {
          problems.push(`tilling: ${err.message}`);
          continue;
        }
        await new Promise((r) => setTimeout(r, 250)); // the block update lands a tick or two later
        if (bot.blockAt(pos)?.name !== "farmland") {
          problems.push(`the ${bot.blockAt(pos)?.name ?? "block"} didn't turn to farmland`);
          continue;
        }
      }
      tilled++;
      const seed = bot.inventory.items().find((i) => SEED_NAMES.includes(i.name));
      if (!seed) { problems.push("ran out of seeds"); continue; }
      try {
        await bot.equip(seed, "hand");
        await bot.placeBlock(bot.blockAt(pos), new Vec3(0, 1, 0));
      } catch (err) {
        problems.push(`planting: ${err.message}`);
        continue;
      }
      if (cropIds.includes(bot.blockAt(pos.offset(0, 1, 0))?.type)) planted++;
      else problems.push("the seed didn't take");
    }
    await collectDrops(bot, token, site.plot); // seeds from the cleared grass
    await refreshGear(bot);
    const why = problems.length ? ` (${[...new Set(problems)].slice(0, 3).join("; ")})` : "";
    if (!planted && !token.cancelled) return fail(`couldn't start a farm: tilled ${tilled}, planted 0${why}.`);
    const result = ok(`started a farm plot${site.hydrated ? " by water" : " (no water nearby, it'll grow slowly)"}: ` +
      `tilled ${tilled}, planted ${planted}${token.cancelled ? ", stopped early" : ""}${why}.`);
    return { ...result, tilled, planted, plot: { x: site.center.x, y: site.center.y, z: site.center.z } };
  }

  const harvestedCounts = {};
  const missed = []; // why each ripe crop wasn't picked (live, 2026-09-25: failures said nothing)
  const emptied = []; // harvested with no seed in hand yet -- replanted after picking up the drops
  let replantedCount = 0;
  let stoppedEarly = false;

  for (const cropBlock of matureBlocks) {
    if (token.cancelled) {
      stoppedEarly = true;
      break;
    }
    const current = bot.blockAt(cropBlock.position);
    if (!current || Number(current.getProperties?.().age) !== CROP_MAX_AGE[current.name]) continue;

    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(current.position.x,
        current.position.y, current.position.z, 2)), ACTION_TIMEOUT_MS,
        () => bot.pathfinder.setGoal(null));
    } catch (err) {
      if (token.cancelled) { stoppedEarly = true; break; }
      missed.push(`can't reach the one at ${current.position} (${err.message})`);
      continue; // couldn't reach this one -- move on to the next rather than abandon the batch
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) { stoppedEarly = true; break; }

    const farmlandPos = current.position.offset(0, -1, 0); // the crop sits on this block
    try {
      await withTimeout(bot.dig(current), ACTION_TIMEOUT_MS, () => bot.stopDigging());
    } catch (err) {
      if (token.cancelled) { stoppedEarly = true; break; }
      missed.push(`couldn't break the one at ${current.position} (${err.message})`);
      continue; // this one failed -- still worth trying the rest of the batch
    }
    harvestedCounts[current.name] = (harvestedCounts[current.name] || 0) + 1;

    const seedName = CROP_REPLANT[current.name];
    const seedItem = bot.inventory.items().find((i) => i.name === seedName);
    if (!seedItem) emptied.push({ farmlandPos, seedName });
    if (seedItem) {
      try {
        await bot.equip(seedItem, "hand");
        await bot.placeBlock(bot.blockAt(farmlandPos), new Vec3(0, 1, 0));
        replantedCount++;
      } catch (err) {
        console.error(`harvest: replant failed:`, err.message); // this harvest still counts
      }
    }
  }

  const total = Object.values(harvestedCounts).reduce((a, b) => a + b, 0);
  if (total) await collectDrops(bot, token, matureBlocks.map((b) => b.position));
  // The seeds come out of the crop she just broke, so on a farm she didn't plant herself there
  // were none in hand at replant time (live: "harvested 8 wheat (0 replanted)"). Second pass.
  for (const { farmlandPos, seedName } of emptied) {
    if (token.cancelled) break;
    const seedItem = bot.inventory.items().find((i) => i.name === seedName);
    if (!seedItem) continue;
    if (bot.blockAt(farmlandPos)?.name !== "farmland" || bot.blockAt(farmlandPos.offset(0, 1, 0))?.name !== "air") continue;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(farmlandPos.x, farmlandPos.y, farmlandPos.z, 2)),
        ACTION_TIMEOUT_MS, () => bot.pathfinder.setGoal(null));
      await bot.equip(seedItem, "hand");
      await bot.placeBlock(bot.blockAt(farmlandPos), new Vec3(0, 1, 0));
      replantedCount++;
    } catch (err) {
      console.error("harvest: late replant failed:", err.message);
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
  }
  await refreshGear(bot);
  if (!total) {
    return stoppedEarly ? ok("stopped harvesting.")
      : fail(`couldn't harvest any of the ${matureBlocks.length} ripe crops found: ${missed.slice(0, 2).join("; ") || "they changed"}.`);
  }
  for (const crop of Object.keys(harvestedCounts)) await recordAchievement(bot, `harvested:${crop}`);
  const summary = Object.entries(harvestedCounts).map(([name, n]) => `${n} ${name}`).join(", ");
  return { ...ok(`harvested ${summary} (${replantedCount} replanted)${stoppedEarly ? ", stopped early" : ""}.`),
    harvested: harvestedCounts };
}
