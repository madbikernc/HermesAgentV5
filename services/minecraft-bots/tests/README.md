# Minecraft bot tests

**Version:** 1.0.0

Three layers, one runner (`tests/run.sh`, or the `npm run test*` scripts in `package.json`).

| Suite | What it proves | Where it runs |
|---|---|---|
| `unit` — `unit.test.mjs` | The fixed logic, extracted from the real source and run against controlled stubs | Anywhere with Node (no server, no `npm install`) |
| `live` — `live.test.mjs` | The real `actions.js`/`arbiter.js`/`equipment.js` against the real server, mobs and items | Spark nodes (needs `node_modules`, the bot server, and `live/rcon.py`'s vault/SSH access) |
| `baseline` — `baseline.mjs` | What the deployed fleet on this host actually did over the last 24h, vs the committed baseline | Each Spark node, over its own `minecraft-bot-*` journals |

```bash
tests/run.sh unit            # offline
tests/run.sh live [filter]   # e.g. tests/run.sh live combat
tests/run.sh baseline        # add --hours 6, --update, --save <file>
tests/run.sh all             # everything this host can run
```

## Live scenarios

`live.test.mjs` joins as `MBTester` (override with `MC_TEST_USERNAME`) and sets up an isolated
sea-lantern platform at (2000, 200, 2000) over RCON. The platform is far from the fleet's base,
lit so nothing spawns, and fenced with glass. Before each scenario the tester is cleared, made
immune to damage and teleported onto the platform. Test mobs are tagged `mbtest` and removed at the end.
Scenarios must not open chests: chest snapshots go into the fleet's shared `known_chests.json`.

RCON goes through `live/rcon.py`. It reuses `tools/hermes-minecraft-admin.py`'s SSH connection
and runs the server box's own `mcrcon`, reading the RCON password on the box itself. No secrets
live in this directory.

## Behavior baseline

`baselines/<host>.json` is the committed reference for each host (`spark`, `spark-2`).
`baseline.mjs` measures each metric per bot-day or as a ratio, then compares against that file.
A metric that moves in its worse direction by more than its tolerance fails the run.
`baselines/<host>.pre-remediation.json` keeps the pre-fix fleet, measured on 2026-09-24 at
`9091ea8`, for reference.

The daily `minecraft-bots-tests.timer` (see `infra/minecraft-bots-tests/`) runs the suites and
keeps reports in `/mnt/hermes-data/minecraft-memory/test-reports/`.

## Rule: every behavior fix adds a test

When a change fixes or adds bot behavior:

1. **Unit:** add a check to `unit.test.mjs` that fails on the old code and passes on the new.
2. **Live:** if the behavior is observable in-world (movement, combat, items, equipment,
   hunger), add a scenario to `live.test.mjs`.
3. **Baseline:** if the fix should move a fleet-level number, add or adjust a metric in
   `baseline.mjs`.
4. **After deploying:** once the fix has run live for about a day, run
   `tests/run.sh baseline --update` on each host and commit the new `baselines/<host>.json`.
   Do this deliberately, never just to silence a regression.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-24 | Initial unit/live/baseline test system and maintenance rule. |
