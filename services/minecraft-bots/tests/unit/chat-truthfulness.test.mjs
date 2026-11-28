// Version: 1.0.0
//
// Unit checks: index.js 4.11.0's fix for fictitious-sounding chat reports. Direct report: "they
// seem to be reporting successful actions that are entirely fictitious." Root cause: both
// decisionTick() and handleChatMessage() speak the model's own pre-action narration immediately
// (a claim of intent, e.g. "Got the iron, now crafting stone pickaxe."), then execute the real
// command and push its real result only into conversationHistory -- never into chat. Anyone
// watching chat (or the player who asked for the action) only ever saw the claim, never the
// correction when the real result disagreed ("You do not have the resources to craft a
// stone_pickaxe. It requires: cobblestone: 3, stick: 2."), confirmed live, repeatedly.
//
// This file does not import tests/unit/_harness.mjs or index.js directly -- see
// stuck-burst.test.mjs's/examples.test.mjs's own headers for why (the harness is independently
// broken; index.js connects to the real game server on import). Regex-scans index.js's real
// source text instead, the same approach decision-tick-guard.test.mjs/decision-stall.test.mjs
// already use for the same two reasons.
// Run every file: node tests/unit.test.mjs; this one alone: node --test tests/unit/chat-truthfulness.test.mjs

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

test('decisionTick() speaks the real command result, not just the pre-action narration', () => {
  const body = between(indexSrc, 'async function decisionTick()', 'guardedInterval(decisionTick');
  const afterExecute = body.slice(body.indexOf('await executeCommand('));
  assert.match(afterExecute, /bot\.chat\(result\.slice\(0,\s*MAX_CHAT_LEN\)\)/,
    'the real result must be chatted after executeCommand() resolves, not only pushed to history');
});

test('handleChatMessage() sends the real command result back to whoever asked, not just the narration', () => {
  const body = between(indexSrc, 'async function handleChatMessage(', 'bot.on("chat"');
  const afterExecute = body.slice(body.indexOf('await executeCommand('));
  assert.match(afterExecute, /send\(result\.slice\(0,\s*MAX_CHAT_LEN\)\)/,
    'the real result must be sent after executeCommand() resolves, not only pushed to history');
});

test('both fixes land strictly after the real result is known, never before executeCommand() is called', () => {
  // Guards against a regression that moves the chat/send call back up next to the narration's own
  // immediate speak -- which would just recreate the original bug one line later.
  for (const [startMarker, endMarker, speakCall] of [
    ['async function decisionTick()', 'guardedInterval(decisionTick', 'bot.chat(result.slice(0, MAX_CHAT_LEN))'],
    ['async function handleChatMessage(', 'bot.on("chat"', 'send(result.slice(0, MAX_CHAT_LEN))'],
  ]) {
    const body = between(indexSrc, startMarker, endMarker);
    const executeIdx = body.indexOf('await executeCommand(');
    const speakIdx = body.indexOf(speakCall);
    assert(executeIdx >= 0 && speakIdx > executeIdx,
      `${speakCall} must appear strictly after the executeCommand() call in ${startMarker}`);
  }
});
