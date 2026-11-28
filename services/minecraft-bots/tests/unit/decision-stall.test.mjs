// Version: 1.0.0
//
// Unit checks: index.js's decision-stall detector (4.10.0). Direct instruction ("fix that"),
// following up on the muse planning/retry gap flagged -- not fixed -- when the two live
// deadlocks (guard false-block, stuck pathfinding) were closed. Confirmed live: neither bot was
// BLOCKED or STUCK anymore, but both kept re-issuing the exact same already-failed command
// forever -- Babs alternating `craftRecipe("stone_pickaxe", ...)` (needs cobblestone she had
// none of) and `collectBlocks("cobblestone", ...)` (needs a pickaxe she had none of); Amy
// retrying `craftRecipe("bed", 1)` after "Invalid item type: bed" every single tick.
//
// commandSignature() is tested against the REAL commands.js (safe to import directly -- it has
// no live mineflayer/network side effects at module scope, confirmed live, unlike index.js
// itself, which connects to the real game server on import -- examples.test.mjs's own header has
// the full reasoning for why index.js can never be imported here). The stall-counting logic
// itself is a few lines inlined directly in decisionTick() (closing over module-level state), not
// its own exported function, so this file mirrors it by hand in trackStall() below -- the same
// tradeoff metrics.test.mjs/examples.test.mjs already accepted, documented there and here rather
// than silently diverging. Keep in sync with index.js's own decisionTick() by hand.
//
// This file does not import tests/unit/_harness.mjs -- see stuck-burst.test.mjs's own header for
// why that import now throws for every file that uses it.
// Run every file: node tests/unit.test.mjs; this one alone: node --test tests/unit/decision-stall.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCommandMessage } from '../../commands.js';

const indexSrc = await readFile(fileURLToPath(new URL('../../index.js', import.meta.url)), 'utf8');

function commandSignature(reply) {
  const parsed = parseCommandMessage(reply);
  return typeof parsed === "string" ? reply : `${parsed.commandName}(${JSON.stringify(parsed.args)})`;
}

const STALL_REPEAT_THRESHOLD = 3;

// Mirrors decisionTick()'s own inline logic: given the running state and this tick's inputs,
// returns the new {lastCommandSignature, stalledRepeats}. This attempt itself always counts as
// at least one, so a threshold of 3 is crossed BY the 3rd identical, no-progress attempt, not
// only after it -- matching pathfinding.js's own stuck-burst detector's framing exactly.
function trackStall(state, signature, inventoryChanged) {
  const matches = signature === state.lastCommandSignature && !inventoryChanged;
  const stalledRepeats = matches ? state.stalledRepeats + 1 : 1;
  return { lastCommandSignature: signature, stalledRepeats };
}

test('commandSignature: two different narrations wrapping the identical command are the same signature', () => {
  const a = commandSignature('Let\'s get cobblestone. !collectBlocks("cobblestone", 3)');
  const b = commandSignature('Need stone for a pickaxe -- !collectBlocks("cobblestone", 3)');
  assert.equal(a, b);
});

test('commandSignature: different args are different signatures', () => {
  const a = commandSignature('!collectBlocks("cobblestone", 3)');
  const b = commandSignature('!collectBlocks("iron_ore", 3)');
  assert.notEqual(a, b);
});

test('commandSignature: an unparseable command falls back to the raw reply, never throws', () => {
  const reply = '!notARealCommand("x")';
  assert.doesNotThrow(() => commandSignature(reply));
  assert.equal(commandSignature(reply), reply);
});

test('Decision stall: the same command with zero inventory change, 3 ticks running, crosses the threshold', () => {
  let state = { lastCommandSignature: null, stalledRepeats: 0 };
  const sig = commandSignature('!craftRecipe("bed", 1)');
  state = trackStall(state, sig, false);
  assert(state.stalledRepeats < STALL_REPEAT_THRESHOLD, 'first attempt: no streak yet');
  state = trackStall(state, sig, false);
  assert(state.stalledRepeats < STALL_REPEAT_THRESHOLD, 'second identical attempt: not over the threshold yet');
  state = trackStall(state, sig, false);
  assert(state.stalledRepeats >= STALL_REPEAT_THRESHOLD, 'third identical attempt in a row crosses it');
});

test('Decision stall: a real inventory change resets the streak even if the command repeats', () => {
  let state = { lastCommandSignature: null, stalledRepeats: 0 };
  const sig = commandSignature('!collectBlocks("oak_log", 1)');
  state = trackStall(state, sig, false);
  state = trackStall(state, sig, false);
  state = trackStall(state, sig, true); // this attempt actually collected a log
  assert.equal(state.stalledRepeats, 1, 'genuine progress must clear the streak back down to just this one attempt');
  state = trackStall(state, sig, false);
  assert(state.stalledRepeats < STALL_REPEAT_THRESHOLD, 'streak restarts after the reset, not where it left off');
});

test('Decision stall: a different command never accumulates toward the old one\'s streak', () => {
  let state = { lastCommandSignature: null, stalledRepeats: 0 };
  state = trackStall(state, commandSignature('!craftRecipe("stone_pickaxe", 1)'), false);
  state = trackStall(state, commandSignature('!craftRecipe("stone_pickaxe", 1)'), false);
  state = trackStall(state, commandSignature('!collectBlocks("cobblestone", 3)'), false); // switched commands
  assert.equal(state.stalledRepeats, 1, 'switching commands resets the streak to just this one attempt');
});

// The checks above only verify this file's own hand-written mirror of decisionTick()'s logic --
// real regression coverage for index.js itself needs to look at its actual source text, the same
// approach decision-tick-guard.test.mjs already uses for the same reason (index.js can't be
// imported directly -- see that file's own header).
test('index.js: decisionTick() actually computes a command signature and compares real inventory before/after', () => {
  const body = between(indexSrc, 'async function decisionTick()', 'guardedInterval(decisionTick');
  assert.match(body, /commandSignature\(reply\)/, 'must compute a real signature from this tick\'s reply');
  assert.match(body, /beforeInventory\s*=\s*describeInventory\(\)/, 'must snapshot inventory before executing');
  assert.match(body, /beforeInventory\s*===\s*describeInventory\(\)/, 'must compare against a fresh after-snapshot, not a stale one');
});

test('index.js: decisionTick() warns the model only once a real stall streak crosses the threshold', () => {
  const body = between(indexSrc, 'async function decisionTick()', 'guardedInterval(decisionTick');
  assert.match(body, /stalledRepeats\s*>=\s*STALL_REPEAT_THRESHOLD/, 'the NOTICE must be gated on the real threshold constant');
  assert.match(body, /stop repeating it/i, 'the NOTICE text must actually tell the model to stop repeating');
});

function between(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `marker not found: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert(to > from, `end marker not found: ${end}`);
  return source.slice(from, to);
}
