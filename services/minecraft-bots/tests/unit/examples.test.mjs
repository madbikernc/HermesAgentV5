// Version: 1.0.0
//
// Unit checks: index.js's renderExamples() (4.7.0) -- the $EXAMPLES block that teaches a persona's
// system prompt what narration-paired-with-a-real-command looks like. Found live 2026-11-28 that
// this was always substituted empty (no persona's conversation_examples was ever populated, and
// nothing read it anyway), and both running bots went roughly an hour, ~116 decision ticks, without
// issuing a single real !command as a result.
//
// renderExamples() is pure and exported from index.js, but index.js itself is NOT importable here
// (import-time side effects: it calls mineflayer.createBot() and connects to the real game server,
// which would kick the live bot of the same username -- same reason tests/README.md's own
// link-check.mjs never imports index.js for real). So this file inlines a copy of the function
// instead of importing it, same tradeoff metrics.test.mjs accepted for a different reason (that
// one avoided the already-broken tests/unit/_harness.mjs; this one avoids import-time side
// effects). Keep this copy in sync with index.js's own renderExamples() by hand -- it is a
// five-line pure function, not a maintenance burden on the scale that would justify extracting it
// into its own zero-dependency module the way metrics.js was.
// Run every file: node tests/unit.test.mjs; this one alone: node --test tests/unit/examples.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

function renderExamples(examples) {
  if (!examples || !examples.length) return "";
  return "EXAMPLES (how to pair narration with a real command; see COMMAND DOCS above for syntax)\n" +
    examples.map((e) => `Example: ${e.context}\nYou: ${e.reply}`).join("\n\n") + "\n";
}

test('Examples: empty/missing input renders to an empty string, not a dangling header', () => {
  assert.equal(renderExamples([]), '');
  assert.equal(renderExamples(undefined), '');
  assert.equal(renderExamples(null), '');
});

test('Examples: one example renders its context and reply, paired', () => {
  const out = renderExamples([{ context: 'You see iron ore.', reply: 'Mining it. !collectBlocks("iron_ore", 1)' }]);
  assert.match(out, /Example: You see iron ore\.\nYou: Mining it\. !collectBlocks\("iron_ore", 1\)/);
});

test('Examples: multiple examples are all present and separated, not merged into one block', () => {
  const out = renderExamples([
    { context: 'A', reply: 'reply A' },
    { context: 'B', reply: 'reply B' },
  ]);
  assert.match(out, /Example: A\nYou: reply A/);
  assert.match(out, /Example: B\nYou: reply B/);
  // distinct examples, not one concatenated into the other
  assert.notEqual(out.indexOf('Example: A'), out.indexOf('Example: B'));
});

test('Examples: the fallback-selection logic this feeds (persona own examples, else shared default)', () => {
  // This mirrors buildSystemPrompt()'s own one-line fallback -- not a copy of index.js, just a
  // check that the selection rule (own examples win when non-empty, shared default otherwise)
  // behaves as index.js 4.7.0 documents it.
  const pick = (persona, common) => (persona.conversation_examples?.length ? persona.conversation_examples : common.default_conversation_examples);
  const shared = [{ context: 'shared', reply: 'shared reply' }];
  const ownExamples = [{ context: 'own', reply: 'own reply' }];
  assert.deepEqual(pick({ conversation_examples: [] }, { default_conversation_examples: shared }), shared);
  assert.deepEqual(pick({ conversation_examples: ownExamples }, { default_conversation_examples: shared }), ownExamples);
  assert.deepEqual(pick({}, { default_conversation_examples: shared }), shared);
});
