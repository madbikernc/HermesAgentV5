// Version: 1.0.0
//
// Unit checks: index.js's decisionTick() analysis flag (4.9.0). Direct report, 2026-11-28 ("the
// bots are still not moving or doing anything useful"): Babs was permanently deadlocked -- every
// single decisionTick() call blocked by the Hermes Guard Layer 2 classifier
// (label=MALICIOUS score=1.000), confirmed live via hermes-router's own journal. The flagged text
// was DECISION_TICK_PROMPT itself (4.7.0's own fix), never anything a player said.
//
// Root cause was 4.2.0's own analysis-flag gate, `analysis: allTrusted` (allTrusted =
// conversationHistory.every((h) => h.trusted)) -- reasonable-sounding, but built on a premise
// hermes-router.py's Layer 2 stopped matching back in its own 2.11.0 (2026-09-11): Layer 2 only
// ever classifies `newest["content"]`, the single newest message, never the full history.
// decisionTick()'s own messages array always ends with `{ role: "user", content:
// DECISION_TICK_PROMPT }` -- a fixed, self-authored string, never conversationHistory's last
// entry -- so "newest" here is NEVER the player's text regardless of what sits earlier in
// conversationHistory. Gating analysis on allTrusted protected nothing (the player's untrusted
// line is never the thing Layer 2 inspects on this call) while creating a real deadlock: once any
// bot ever received one untrusted chat/whisper line, every future decisionTick scored MALICIOUS
// on its own prompt and threw, and the catch block returns WITHOUT calling pushHistory() -- so
// the untrusted entry could never age out of the HISTORY_TURNS window either. Permanent from the
// first real player interaction onward, confirmed live (Babs blocked on every tick for over an
// hour straight).
//
// This does not reopen the 4.2.0 finding it replaces: a player's raw chat/whisper/Matrix line is
// still screened for real (never analysis:true) at the call site that answers it directly
// (handleChatMessage/generateReply -- see services.test.mjs's own S27f/S34 check), which is the
// point at which it IS the newest message. By the time it's just background context in
// conversationHistory for a LATER decisionTick, it already passed screening once, which is
// hermes-router.py's own stated doctrine ("every prior turn already passed screening the request
// it first arrived in").
//
// This file does not import tests/unit/_harness.mjs: confirmed live (2026-11-28) that importing
// it now throws at module load for every test file that does (see stuck-burst.test.mjs's own
// header for the full accounting), and index.js itself is not importable either way (import-time
// side effects -- examples.test.mjs's own header has the full reasoning). Reads index.js's real
// source text directly instead, the same regex-scan approach services.test.mjs's own S27f/S34
// check already uses for this exact file.
// Run every file: node tests/unit.test.mjs; this one alone: node --test tests/unit/decision-tick-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const indexSrc = await readFile(fileURLToPath(new URL('../../index.js', import.meta.url)), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `marker not found: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert(to > from, `end marker not found: ${end}`);
  return source.slice(from, to);
}

test('decisionTick calls callRole with a literal analysis: true', () => {
  const body = between(indexSrc, 'async function decisionTick()', 'guardedInterval(decisionTick');
  assert.match(body, /callRole\(\s*"muse",\s*messages,\s*\{\s*analysis:\s*true,\s*maxTokens:\s*300\s*\}\s*\)/,
    'decisionTick\'s newest message is always the fixed DECISION_TICK_PROMPT, never ' +
    'conversationHistory\'s own last entry -- unlike the player-chat-reply sites, a bare literal is correct here');
});

test('decisionTick never reintroduces the history-trust gate that caused the live deadlock', () => {
  const body = between(indexSrc, 'async function decisionTick()', 'guardedInterval(decisionTick');
  assert(!/allTrusted/.test(body), 'the old 4.2.0 analysis:allTrusted gate must not come back');
  assert(!/conversationHistory\.every/.test(body), 'nor any equivalent history-trust gate on this call');
});
