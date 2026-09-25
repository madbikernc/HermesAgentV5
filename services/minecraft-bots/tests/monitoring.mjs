// Version: 1.0.0
//
// Monitoring coverage check (review MB-18): every active minecraft-bot-* unit on THIS host must be
// (1) mirrored into the raw activity log and (2) visible to triage -- its structured OUTCOME
// failures appear in triage-events.jsonl. Journald attributes lines to a unit by cgroup, so a
// failure can't be injected into a real bot unit from outside; instead this checks the real
// traffic each unit produced in the window.
//   node tests/monitoring.mjs [--hours 24]
// Exit 1 if any active bot is missing from the activity log, or had real failures that triage
// never recorded.
//
// Revision History: 1.0.0 | 2026-09-25 | Initial coverage check for MB-18.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const HOURS = Number(args.includes("--hours") ? args[args.indexOf("--hours") + 1] : "24");
const MEM = process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory";
const sh = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });

const units = sh("systemctl", ["list-units", "minecraft-bot-*.service", "--state=active", "--no-legend", "--plain"])
  .split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u) => u?.endsWith(".service"));
const sinceMs = Date.now() - HOURS * 3_600_000;
const activity = existsSync(`${MEM}/activity.log`) ? sh("tail", ["-n", "400000", `${MEM}/activity.log`]) : "";
const events = existsSync(`${MEM}/triage-events.jsonl`)
  ? sh("tail", ["-n", "200000", `${MEM}/triage-events.jsonl`]).split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((e) => e && Date.parse(e.at) >= sinceMs - 86_400_000)
  : [];

let failed = 0;
console.log(`monitoring coverage -- ${units.length} active bot unit(s), last ${HOURS}h`);
for (const unit of units) {
  const journal = sh("journalctl", ["-u", unit, "--since", `-${HOURS}h`, "-o", "cat", "--no-pager"]);
  const name = journal.match(/^\[([A-Z][A-Za-z]+)\] /m)?.[1];
  const failures = (journal.match(/\] OUTCOME \{.*"ok":false,"cancelled":false,"refused":false/g) || []).length;
  const mirrored = !!name && activity.includes(`[${name}] `);
  const triaged = events.filter((e) => e.unit === unit).length;
  const ok = mirrored && (failures === 0 || triaged > 0);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${unit.padEnd(30)} bot=${name ?? "?"} mirrored=${mirrored} ` +
    `failures=${failures} triage-events=${triaged}`);
}
if (!units.length) { console.log("  FAIL no active minecraft-bot-* units"); failed++; }
console.log(failed ? `${failed} unit(s) not fully monitored.` : "every bot unit is mirrored and triaged.");
process.exit(failed ? 1 : 0);
