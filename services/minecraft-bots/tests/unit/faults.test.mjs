// Version: 1.0.0
//
// Unit checks: faults.js -- a periodic check's error is contained and located, and any other
// uncaught error is logged where triage can read it before the process exits (2026-11-10).
// Run every file: node tests/unit.test.mjs; this one alone: node tests/unit/faults.test.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { root, index, check, passedCount } from './_harness.mjs';

const faults = await import(pathToFileURL(root + 'faults.js').href);
const triage = await readFile(root + '../../tools/hermes-minecraft-triage.py', 'utf8');
// The "crash" pattern exactly as triage defines it (two adjacent Python string literals).
const crashPattern = new RegExp([...triage.match(/\("crash", re\.compile\(([\s\S]*?)\),\s*\n/)[1]
  .matchAll(/r"([^"]*)"/g)].map((m) => m[1]).join(''));

function captureErrors(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try { return [fn(), lines]; } finally { console.error = real; }
}

await check('Faults: a periodic check that throws is logged with its file:line, and the next tick still runs', async () => {
  const realSet = globalThis.setInterval;
  let tick = null;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  let calls = 0;
  try {
    faults.guardedInterval(() => { calls++; if (calls === 1) null.position; }, 1000);
  } finally { globalThis.setInterval = realSet; }
  const [, lines] = captureErrors(() => { tick(); tick(); });
  assert.equal(calls, 2, 'the second tick ran');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /periodic check failed: TypeError: Cannot read properties of null/);
  assert.match(lines[0], /\(at tests\/unit\/faults\.test\.mjs:\d+\)/, 'names the file and line it was thrown from');
  assert.match(lines[0], crashPattern, "triage's crash pattern picks the line up");
});

await check('Faults: a periodic check whose promise rejects is logged too, not left unhandled', async () => {
  const realSet = globalThis.setInterval;
  let tick = null;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  try {
    faults.guardedInterval(async () => { throw new ReferenceError('lastHarvestAt is not defined'); }, 1000);
  } finally { globalThis.setInterval = realSet; }
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try { tick(); await new Promise((r) => setTimeout(r, 10)); } finally { console.error = real; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /periodic check failed: ReferenceError: lastHarvestAt is not defined \(at tests\/unit\/faults\.test\.mjs:\d+\)/);
});

await check('Faults: an uncaught error is written out with where it came from, then the process exits 1', async () => {
  const proc = new EventEmitter();
  let written = '', exitCode = null;
  proc.stderr = { write: (text, done) => { written += text; done(); } };
  proc.exit = (code) => { exitCode = code; };
  faults.installFatalHandlers('Amy', proc);
  proc.emit('unhandledRejection', new TypeError('bot.entity is undefined'));
  assert.match(written, /^\[Amy\] FATAL unhandledRejection: TypeError: bot\.entity is undefined \(at tests\/unit\/faults\.test\.mjs:\d+\)/);
  assert.match(written, crashPattern);
  assert.equal(exitCode, 1, 'still exits, for systemd to restart -- the error is not swallowed');
  exitCode = null; written = '';
  proc.emit('uncaughtException', 'a string, not an Error');
  assert.match(written, /FATAL uncaughtException: non-Error value thrown: a string, not an Error/);
  assert.equal(exitCode, 1);
});

await check('Faults: index.js runs every periodic check through guardedInterval and installs the handlers first', async () => {
  const code = index.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /(?<!\w)setInterval\(/, 'no bare setInterval left');
  assert.ok((code.match(/guardedInterval\(/g) ?? []).length >= 30);
  assert.match(index, /const USERNAME = [^\n]*\ninstallFatalHandlers\(USERNAME\);/, 'right after USERNAME, before any timer starts');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
