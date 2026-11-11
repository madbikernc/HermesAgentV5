// Version: 1.0.0
//
// The "smelt" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import path from "node:path";
import { ACTION_TIMEOUT_MS, SMELT_RECIPES, SMELT_TIMEOUT_MS, goals, noteUtilityOutcome, pickFuel, refreshGear, wanderAndRetryFind, withTimeout } from "../actions.js";


export async function smeltAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-09-07: "they can't seem to find the furnaces" -- most of tonight's
  // goal failures were bots correctly reasoning they needed an ingot and having no way to
  // get one beyond hoping a chest had it (craft/mine alone were never enough; see index.js's
  // planNextStep comments). Built on mineflayer's own openFurnace() (core, no extra plugin).
  //
  // Real gap found live minutes after shipping: the prompt says <item_id> is the OUTPUT
  // (e.g. "copper_ingot"), but the planner sometimes names the INPUT raw material instead
  // ("raw_copper"). Cheap and always-safe to just accept either rather than keep tightening
  // prompt wording for something this easy to normalize -- if the named item isn't a known
  // output, check whether it's actually a known input for one and use that recipe instead.
  let outputItem = action.item;
  if (!SMELT_RECIPES[outputItem]) {
    const matched = Object.entries(SMELT_RECIPES).find(([, inputs]) => inputs.includes(outputItem));
    if (matched) outputItem = matched[0];
  }
  const inputCandidates = SMELT_RECIPES[outputItem];
  if (!inputCandidates) return fail(`don't know how to smelt "${action.item}".`);
  const inputItem = bot.inventory.items().find((i) => inputCandidates.includes(i.name));
  if (!inputItem) return fail(`don't have anything to smelt into ${outputItem}.`);
  const smeltCount = Math.min(action.count, inputItem.count);

  const fuelItem = pickFuel(bot);
  if (!fuelItem) return fail("don't have any fuel to smelt with.");

  const furnaceNames = ["furnace", "blast_furnace", "smoker"];
  const matchIds = furnaceNames.map((n) => bot.registry.blocksByName[n]?.id)
    .filter((id) => id !== undefined);
  if (!matchIds.length) return fail("don't know how to recognize a furnace here.");
  const furnaceFindOptions = { matching: matchIds, maxDistance: 32, count: 3 };
  let positions = bot.findBlocks(furnaceFindOptions);
  if (!positions.length) positions = await wanderAndRetryFind(bot, token, furnaceFindOptions);
  if (!positions.length) return fail("couldn't find a furnace nearby, even after looking around.");

  for (const pos of positions) {
    if (token.cancelled) return ok("stopped on the way to a furnace.");
    const furnaceBlock = bot.blockAt(pos);
    if (!furnaceBlock) continue;

    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x,
        furnaceBlock.position.y, furnaceBlock.position.z, 2)), ACTION_TIMEOUT_MS,
        () => bot.pathfinder.setGoal(null));
    } catch (err) {
      if (token.cancelled) return ok("stopped on the way to a furnace.");
      console.log(`[smelt] couldn't reach furnace at ${furnaceBlock.position}: ${err.message}`);
      noteUtilityOutcome("furnace", furnaceBlock.position, false);
      continue; // couldn't reach this furnace -- try the next candidate
    } finally {
      if (!token.cancelled) bot.pathfinder.setGoal(null); // never clear a preemptor's path
    }
    if (token.cancelled) return ok("stopped on the way to a furnace.");

    let furnace;
    try {
      furnace = await bot.openFurnace(furnaceBlock);
      noteUtilityOutcome("furnace", furnaceBlock.position, true);
      // Real gap found live (2026-09-07): the same 3 furnaces failed "destination full"
      // across several separate goal attempts -- logging what's actually sitting in each
      // slot on open, so a repeat is diagnosable (someone else's items? a stuck previous
      // attempt of our own?) instead of just "full" with no further evidence.
      const slot = (item) => item ? `${item.name}x${item.count}` : "empty";
      console.log(`[smelt] furnace at ${furnaceBlock.position} slots: ` +
        `input=${slot(furnace.inputItem())} fuel=${slot(furnace.fuelItem())} output=${slot(furnace.outputItem())}`);
    } catch (err) {
      console.log(`[smelt] couldn't open furnace at ${furnaceBlock.position}: ${err.message}`);
      noteUtilityOutcome("furnace", furnaceBlock.position, false);
      continue; // couldn't open this one -- try the next candidate
    }

    try {
      // Direct request, 2026-09-21 ("I want real confirmation they can use the crafting
      // table and furnace"). Investigating turned up a real, severe, already-live bug: a
      // fleet-wide 24h log sweep found ZERO successful smelts, every single attempt failing
      // "found furnaces nearby, but couldn't use any of them." This codebase's own per-
      // furnace slot logging (2026-09-07) caught the real cause directly: furnace at
      // (94,63,64) had 63 coal_block already sitting in its fuel slot (coal_block smelts 800
      // items each -- decades of fuel) plus 16 iron_ingot stranded in output, uncollected;
      // furnace at (94,63,63) had exactly 64 coal_block, the hard per-slot cap. putFuel() was
      // called UNCONDITIONALLY on every single attempt regardless of how much fuel a furnace
      // already had -- once a slot maxes out, every future putFuel() throws "destination
      // full" and the whole smelt aborted right there, before ever reaching putInput, even
      // though the furnace already had more than enough fuel to actually smelt with.
      //
      // Fix, two parts: (1) collect any output already sitting there first -- recovers
      // whatever a prior successful smelt (ours or another bot's) left stranded, and frees
      // the slot; (2) treat a failed putFuel() as "already has fuel," not fatal -- log it and
      // fall through to putInput using whatever's already in the fuel slot, rather than
      // aborting the entire attempt over a top-up that was never actually needed.
      const existingOutput = furnace.outputItem();
      if (existingOutput && existingOutput.count > 0) {
        await furnace.takeOutput();
      }
      try {
        // One fuel item per item smelted is a generous overestimate for any fuel type (coal
        // alone smelts 8 per item) -- errs toward "definitely enough fuel" over precision.
        await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, smeltCount));
      } catch (fuelErr) {
        console.log(`[smelt] furnace at ${furnaceBlock.position} already has fuel, ` +
          `skipping top-up: ${fuelErr.message}`);
      }
      await furnace.putInput(inputItem.type, null, smeltCount);

      // furnace.js has no built-in "wait until done" -- poll its own 'update' event (fired
      // on every server progress packet) for a non-empty output, with a safety timeout.
      const outputReady = await new Promise((resolve) => {
        let settled = false;
        const check = () => {
          const out = furnace.outputItem();
          if (out && out.count > 0 && !settled) { settled = true; resolve(true); }
        };
        furnace.on("update", check);
        check();
        setTimeout(() => { if (!settled) resolve(false); }, SMELT_TIMEOUT_MS);
      });
      furnace.removeAllListeners("update");

      let smelted = 0;
      if (outputReady) {
        const out = await furnace.takeOutput();
        smelted = out?.count ?? 0;
      }
      await furnace.close();
      if (!smelted) return fail("waited at the furnace but nothing came out -- may be out of fuel.");
      await refreshGear(bot); // a freshly-smelted ingot might feed straight into new gear
      return ok(`smelted ${smelted} ${outputItem}.`);
    } catch (err) {
      try { await furnace.close(); } catch { /* already closed or never opened cleanly */ }
      console.log(`[smelt] furnace at ${furnaceBlock.position} failed: ${err.message}`);
      continue; // this furnace didn't work out -- try the next candidate
    }
  }
  return fail("found furnaces nearby, but couldn't use any of them.");
}
