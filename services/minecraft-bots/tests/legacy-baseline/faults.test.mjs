// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/faults.test.mjs against the Mindcraft-ported
// architecture. Unlike that file (which ran index.js as vm-sliced source with no node_modules),
// every check here imports the REAL current faults.js and reads the real current index.js as
// text. See services/minecraft-bots-archive-11-2026/ for what this measures against.
// Run: node --test services/minecraft-bots/tests/legacy-baseline/faults.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const faults = await import(root + "faults.js");
const indexSrc = await readFile(root + "index.js", "utf8");

function captureErrors(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try { return [fn(), lines]; } finally { console.error = real; }
}

test("[legacy:faults] a periodic check that throws is logged with its file:line, and the next tick still runs", async () => {
  const realSet = globalThis.setInterval;
  let tick = null;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  let calls = 0;
  try {
    faults.guardedInterval(() => { calls++; if (calls === 1) null.position; }, 1000);
  } finally { globalThis.setInterval = realSet; }
  const [, lines] = captureErrors(() => { tick(); tick(); });
  assert.equal(calls, 2, "the second tick ran");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /periodic check failed: TypeError: Cannot read properties of null/);
  assert.match(lines[0], /\(at .*faults\.test\.mjs:\d+\)/, "names the file and line it was thrown from");
});

test("[legacy:faults] a periodic check whose promise rejects is logged too, not left unhandled", async () => {
  const realSet = globalThis.setInterval;
  let tick = null;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  try {
    faults.guardedInterval(async () => { throw new ReferenceError("lastHarvestAt is not defined"); }, 1000);
  } finally { globalThis.setInterval = realSet; }
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try { tick(); await new Promise((r) => setTimeout(r, 10)); } finally { console.error = real; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /periodic check failed: ReferenceError: lastHarvestAt is not defined \(at .*faults\.test\.mjs:\d+\)/);
});

test("[legacy:faults] an uncaught error is written out with where it came from, then the process exits 1", async () => {
  const proc = new EventEmitter();
  let written = "", exitCode = null;
  proc.stderr = { write: (text, done) => { written += text; done(); } };
  proc.exit = (code) => { exitCode = code; };
  faults.installFatalHandlers("Amy", proc);
  proc.emit("unhandledRejection", new TypeError("bot.entity is undefined"));
  assert.match(written, /^\[Amy\] FATAL unhandledRejection: TypeError: bot\.entity is undefined \(at .*faults\.test\.mjs:\d+\)/);
  assert.equal(exitCode, 1, "still exits, for systemd to restart -- the error is not swallowed");
  exitCode = null; written = "";
  proc.emit("uncaughtException", "a string, not an Error");
  assert.match(written, /FATAL uncaughtException: non-Error value thrown: a string, not an Error/);
  assert.equal(exitCode, 1);
});

test("[legacy:faults] index.js runs every periodic check through guardedInterval and installs the handlers first", async () => {
  // Re-derived against the real current index.js (4.1.0, ~417 lines): the old threshold (>= 30
  // guardedInterval calls, from the pre-restart ~2500-line index.js with the whole goal/priority
  // engine inline) no longer applies -- the new decision loop has far fewer periodic checks
  // (the 15s memory/chunk diagnostic, decisionTick, runModes), but the invariant itself (no bare
  // setInterval, handlers installed right after USERNAME is defined) still must hold.
  const code = indexSrc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /(?<!\w)setInterval\(/, "no bare setInterval left");
  const guardedCount = (code.match(/guardedInterval\(/g) ?? []).length;
  assert.ok(guardedCount >= 3, `expected at least 3 guardedInterval call sites, found ${guardedCount}`);
  assert.match(indexSrc, /export const USERNAME = [^\n]*\ninstallFatalHandlers\(USERNAME\);/,
    "right after USERNAME, before any timer starts");
});
