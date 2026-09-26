// Version: 1.2.0
//
// Behavior baseline for the Minecraft bots: measures what the bots on THIS host actually did over
// a recent window (from their systemd journals) and compares it against the committed baseline in
// tests/baselines/<host>.json. A metric that moved in its "worse" direction by more than its
// tolerance is a regression and fails the run.
//
//   node tests/baseline.mjs                 compare the last 24h against the baseline
//   node tests/baseline.mjs --hours 6       ...a different window
//   node tests/baseline.mjs --update        record the current window AS the new baseline
//   node tests/baseline.mjs --save <file>   also write this run's measurements to <file>
//   node tests/baseline.mjs --log <file>    read log lines from a file instead of journalctl
//
// Rates are per bot-day (or ratios), so a baseline survives a different window length or bot count.
// When a behavior fix lands, add the metric that proves it here (see tests/README.md), and after
// the fix has run live for a day, --update and commit the new baseline deliberately.
//
// Revision History: 1.0.0 | 2026-09-24 | Initial metrics from the 2026-09-23 fleet measurement.
// 1.1.0 | 2026-09-24 | action_failure_rate (OUTCOME lines) and routine_skips_per_bot_day (ROUTINE_SKIPS).
// 1.2.0 | 2026-09-25 | failed_eats_per_bot_day and farm_ranch_successes_per_bot_day (farming/ranching fixes).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const HOURS = Number(option("--hours", "24"));
const HOST = option("--host", os.hostname());
const BASELINE_DIR = fileURLToPath(new URL("./baselines/", import.meta.url));
const BASELINE_FILE = `${BASELINE_DIR}${HOST}.json`;

// ---- log source ------------------------------------------------------------------------------
function readLines() {
  const file = option("--log", null);
  const text = file
    ? readFileSync(file, "utf8")
    : execFileSync("journalctl", ["-u", "minecraft-bot-*.service", "--since", `-${HOURS}h`, "-o", "cat", "--no-pager"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  return text.split("\n");
}

// ---- metrics -----------------------------------------------------------------------------------
// Each metric: count(s) of regexes over the window, turned into a value. `better` says which
// direction is an improvement; `tolerance` is the allowed relative move the other way (plus
// `floor`, an absolute slack so near-zero metrics don't flap).
const perBotDay = (n, ctx) => n / Math.max(1, ctx.bots) / (ctx.hours / 24);
const ratio = (a, b) => (a + b ? a / (a + b) : null);

// One line per finished home-lighting attempt: gave up for lack of torches, a failed torch craft,
// or the final light_area outcome (intermediate "grabbed/crafted torches" lines aren't counted).
const LIGHTING_ATTEMPT = /home lighting: (no torches|crafted torches first -- .*\(ok=false|(?!crafted|grabbed|no torches).*\(ok=)/;

const METRICS = {
  deaths_per_bot_day: {
    about: "deaths ('died at ...') per bot per day",
    better: "lower", tolerance: 0.25, floor: 1,
    value: (c, ctx) => perBotDay(c(/\] died at /), ctx),
  },
  attack_win_rate: {
    about: "share of finished fights that ended in a real kill (MB-01)",
    better: "higher", tolerance: 0.15, floor: 0.05,
    value: (c) => ratio(c(/(attack|squad response result|self-defense result): took care of it/),
      c(/gave up on the fight|lost track of it/)),
  },
  planner_action_ratio: {
    about: "goal steps actually executed per planner call (efficiency pass)",
    better: "higher", tolerance: 0.25, floor: 0.05,
    value: (c) => { const plans = c(/\] goal plan:/); return plans ? c(/\] goal step: /) / plans : null; },
  },
  planner_calls_per_bot_day: {
    about: "goal-planner model calls per bot per day",
    better: "lower", tolerance: 0.3, floor: 20,
    value: (c, ctx) => perBotDay(c(/\] goal plan:/), ctx),
  },
  guard_goals_per_bot_day: {
    about: "Soldier guard goals started per bot per day (guard churn)",
    better: "lower", tolerance: 0.5, floor: 5,
    value: (c, ctx) => perBotDay(c(/Soldier priority goal \(guard\)/), ctx),
  },
  home_lighting_attempts_per_bot_day: {
    about: "home-lighting attempts per bot per day",
    better: "lower", tolerance: 0.5, floor: 10,
    value: (c, ctx) => perBotDay(c(LIGHTING_ATTEMPT), ctx),
  },
  home_lighting_success_rate: {
    about: "home-lighting attempts that lit something",
    better: "higher", tolerance: 0.3, floor: 0.05,
    value: (c) => { const all = c(LIGHTING_ATTEMPT); return all ? c(/home lighting: (lit up|area's already lit)/) / all : null; },
  },
  store_failure_rate: {
    about: "surplus-store trips that found no usable chest",
    better: "lower", tolerance: 0.25, floor: 0.05,
    value: (c) => ratio(c(/(inventory management|inventory insurance|post-craft cleanup): found chests nearby, but/),
      c(/(inventory management|inventory insurance|post-craft cleanup): stored /)),
  },
  dropped_messages_per_bot_day: {
    about: "incoming messages dropped unanswered (MB-06)",
    better: "lower", tolerance: 0.5, floor: 3,
    value: (c, ctx) => perBotDay(c(/busy, dropping|incoming queue full, dropping|queued message expired/), ctx),
  },
  stuck_teleports_per_bot_day: {
    about: "stuck-rescue teleports (MB-03/MB-22)",
    better: "lower", tolerance: 0.5, floor: 1,
    value: (c, ctx) => perBotDay(c(/\] TELEPORT: /), ctx),
  },
  rejected_done_per_bot_day: {
    about: "completion claims that failed validation",
    better: "lower", tolerance: 0.5, floor: 3,
    value: (c, ctx) => perBotDay(c(/REJECTED DONE|SUSPICIOUS DONE/), ctx),
  },
  action_failure_rate: {
    about: "actions that genuinely failed (not interrupted, not refused), from OUTCOME lines (MB-18)",
    better: "lower", tolerance: 0.25, floor: 0.05,
    value: (c) => {
      const all = c(/\] OUTCOME \{/);
      return all ? c(/\] OUTCOME \{.*"ok":false,"cancelled":false,"refused":false/) / all : null;
    },
  },
  routine_skips_per_bot_day: {
    about: "periodic checks that lost their turn to other work (fairness), from ROUTINE_SKIPS lines",
    better: "lower", tolerance: 0.5, floor: 50,
    value: (c, ctx) => { const n = c.sumJson(/\] ROUTINE_SKIPS (\{.*\})/); return n ? perBotDay(n, ctx) : null; },
  },
  failed_eats_per_bot_day: {
    about: "\"eat\" with nothing to eat -- 4,203/day on spark before hunger fetched food (2026-09-25)",
    better: "lower", tolerance: 0.5, floor: 5,
    value: (c, ctx) => perBotDay(c(/\] OUTCOME \{"type":"eat","ok":false,"cancelled":false/), ctx),
  },
  farm_ranch_successes_per_bot_day: {
    about: "harvest/build_pen/herd_to_pen/breed that succeeded -- 0/day before farm goals ran directly (2026-09-25)",
    better: "higher", tolerance: 0.5, floor: 0.2,
    value: (c, ctx) => perBotDay(c(/\] OUTCOME \{"type":"(harvest|build_pen|herd_to_pen|breed)","ok":true/), ctx),
  },
  crashes_per_bot_day: {
    about: "JS runtime errors and OOMs",
    better: "lower", tolerance: 0.5, floor: 0.5,
    value: (c, ctx) => perBotDay(c(/TypeError|ReferenceError|is not a function|heap out of memory/), ctx),
  },
};

export function measure(lines, hours) {
  const bots = new Set();
  for (const line of lines) {
    const m = line.match(/^\[([A-Z][a-z]+)\] /);
    if (m) bots.add(m[1]);
  }
  const ctx = { bots: bots.size, hours };
  const count = (re) => { let n = 0; for (const l of lines) if (re.test(l)) n++; return n; };
  // Sums every number in the JSON object captured by `re`'s first group (ROUTINE_SKIPS lines).
  count.sumJson = (re) => {
    let total = 0;
    for (const l of lines) {
      const m = l.match(re);
      if (!m) continue;
      try { for (const v of Object.values(JSON.parse(m[1]))) total += Number(v) || 0; } catch { /* malformed line */ }
    }
    return total;
  };
  const values = {};
  for (const [name, metric] of Object.entries(METRICS)) {
    const v = metric.value(count, ctx);
    values[name] = v === null || Number.isNaN(v) ? null : Math.round(v * 1000) / 1000;
  }
  return { bots: [...bots].sort(), hours, values };
}

export function compare(current, baseline) {
  const rows = [];
  for (const [name, metric] of Object.entries(METRICS)) {
    const now = current.values[name];
    const then = baseline?.values?.[name];
    if (now === null || now === undefined || then === null || then === undefined) {
      rows.push({ name, now, then, status: "n/a" });
      continue;
    }
    const slack = Math.max(Math.abs(then) * metric.tolerance, metric.floor);
    const worse = metric.better === "lower" ? now - then : then - now;
    const status = worse > slack ? "REGRESSED" : worse < -slack ? "improved" : "ok";
    rows.push({ name, now, then, status });
  }
  return rows;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const current = measure(readLines(), HOURS);
  current.host = HOST;
  current.recorded_at = new Date().toISOString();
  current.commit = gitCommit();
  const save = option("--save", null);
  if (save) writeFileSync(save, JSON.stringify(current, null, 2) + "\n");

  if (flag("--update")) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + "\n");
    console.log(`baseline recorded for ${HOST}: ${BASELINE_FILE} (bots: ${current.bots.join(", ")}, ${HOURS}h)`);
    for (const [k, v] of Object.entries(current.values)) console.log(`  ${k.padEnd(36)} ${v}`);
    process.exit(0);
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : null;
  if (!baseline) console.log(`no baseline yet for ${HOST} -- run with --update to record one`);
  const rows = compare(current, baseline);
  console.log(`behavior baseline -- host ${HOST}, last ${HOURS}h, bots: ${current.bots.join(", ") || "(none seen)"}`);
  console.log(`baseline: ${baseline ? `${baseline.recorded_at} @ ${baseline.commit}` : "none"}`);
  for (const r of rows) {
    console.log(`  ${r.status.padEnd(9)} ${r.name.padEnd(36)} now=${r.now ?? "-"}  baseline=${r.then ?? "-"}`);
  }
  const regressed = rows.filter((r) => r.status === "REGRESSED");
  console.log(regressed.length ? `${regressed.length} metric(s) regressed.` : "no regressions.");
  process.exit(regressed.length ? 1 : 0);
}
