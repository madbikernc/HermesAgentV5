// Version: 1.0.0
//
// The "consolidate_chests" action, split out of actions.js's performActionAs() switch
// (actions.js 2.0.0, 2026-11-10) unchanged, so a fix to it is a fix to this file alone. Called
// through ACTION_HANDLERS with performActionAs's own arguments; ok()/fail() build its result.

import { findConsolidation, loadKnownChests, openChestAt, recordChestSnapshot } from "../actions.js";


export async function consolidateChestsAction(bot, action, speaker, token) {
  const ok = (text) => ({ ok: true, text });
  const fail = (text) => ({ ok: false, text });
  // Direct request, 2026-11-07: one kind of item split between two chests is brought together
  // in full stacks. action.plan is findConsolidation()'s move (a snapshot just found it);
  // without one she works out her own from what the fleet knows of the chests around her.
  const plan = action.plan ?? findConsolidation(await loadKnownChests(), bot.entity.position);
  if (!plan) return ok("no two chests near here hold the same kind of thing.");
  const names = Object.keys(plan.from.items);
  const freeSlots = () => bot.inventory.emptySlotCount();
  if (freeSlots() < 2) return fail("no free slots to carry anything between chests.");

  // 1. Take the family out of the chest that holds less of it, as many stacks as she can carry
  // and the other chest has room for (one inventory slot kept free).
  const source = await openChestAt(bot, token, plan.from.position);
  if (source.cancelled) return ok("stopped on the way to a chest.");
  if (source.error) return fail(`couldn't open the chest at ${plan.from.position}: ${source.error}`);
  // Counts come from each open window -- its containerItems() and its own copy of her inventory
  // (items()); bot.inventory doesn't see a withdrawal until the window closes (live, 2026-11-07:
  // counted from there, only 30 of 70 birch logs went in). Item objects change under a
  // withdraw, so each count is copied out before anything moves.
  const totals = (items, wanted) => {
    const byType = new Map();
    for (const { type, name, count, stackSize } of items) {
      if (!wanted(type, name)) continue;
      const entry = byType.get(type) ?? { name, count: 0, slots: 0, stackSize: stackSize ?? 64 };
      entry.count += count;
      entry.slots++;
      byType.set(type, entry);
    }
    return byType;
  };
  const heldIn = (window, type) => window.items().filter((i) => i.type === type).reduce((n, i) => n + i.count, 0);
  const own = new Map(); // type -> { name, mine }: what she held herself beforehand is never moved
  let carried = 0;
  try {
    let room = Math.min(freeSlots() - 1, plan.to.freeSlots ?? Infinity);
    for (const [type, { name, count, stackSize }] of totals(source.chest.containerItems(), (_, name) => names.includes(name))) {
      if (token.cancelled || room < 1) break;
      const take = Math.min(count, room * stackSize);
      own.set(type, { name, mine: heldIn(source.chest, type) });
      await source.chest.withdraw(type, null, take);
      carried += take;
      room -= Math.ceil(take / stackSize);
    }
    await recordChestSnapshot(plan.from.position, source.chest.containerItems(), source.chest.inventoryStart);
  } catch (err) {
    console.log(`[consolidate] couldn't take from chest at ${plan.from.position}: ${err.message}`);
  } finally {
    try { await source.chest.close(); } catch { /* already closed */ }
  }
  if (token.cancelled) return ok("stopped while moving chest items.");
  if (!carried) return fail(`the chest at ${plan.from.position} had none of its ${plan.family} left to move.`);

  // 2. Into the chest that holds more. What it already has of these items comes out first, so
  // putting it all back fills whole stacks instead of leaving several part-filled ones.
  const target = await openChestAt(bot, token, plan.to.position);
  if (target.cancelled) return ok("stopped on the way to a chest.");
  if (target.error) return fail(`took ${carried} ${plan.family} but couldn't open the chest at ${plan.to.position}: ${target.error}`);
  let stored = 0;
  try {
    for (const [type, { count, slots, stackSize }] of totals(target.chest.containerItems(), (type) => own.has(type))) {
      const stacks = Math.ceil(count / stackSize);
      if (slots === stacks || freeSlots() < stacks) continue; // already in whole stacks, or no room to lift them
      await target.chest.withdraw(type, null, count);
    }
    for (const [type, { name, mine }] of own) {
      const put = heldIn(target.chest, type) - mine;
      if (put < 1) continue;
      try {
        await target.chest.deposit(type, null, put);
        stored += put;
      } catch (err) {
        console.log(`[consolidate] couldn't put ${name} into chest at ${plan.to.position}: ${err.message}`);
        break; // destination full -- the rest stays with her for the next store
      }
    }
    await recordChestSnapshot(plan.to.position, target.chest.containerItems(), target.chest.inventoryStart);
  } catch (err) {
    console.log(`[consolidate] couldn't sort chest at ${plan.to.position}: ${err.message}`);
  } finally {
    try { await target.chest.close(); } catch { /* already closed */ }
  }
  if (!stored) return fail(`took ${carried} ${plan.family} but couldn't put them in with the rest.`);
  return ok(`moved ${carried} ${plan.family} from the chest at ${plan.from.position} in with the rest at ${plan.to.position}.`);
}
