# hermes-router (V4) — recreate checklist

**Version:** 1.1.1

Ordered steps to stand up `hermes-router` under HermesAgentV5's target topology
(`IMPLEMENTATION_PLAN.md` §4, §6 Stage 2): capability endpoints reachable by either persona
regardless of which node hosts them, plus `super`/`coder` loading on demand. Deployed and live
since Stage 2 cut over; this doc is kept accurate rather than archived, same as every other
`infra/*/README.md` in this project once its stage has run.

## 0. What changed from HermesAgentRedo's single-router setup

`HermesAgentRedo` ran exactly one `hermes-router` instance, on `spark`, because every backend
Sintra needed (`core`/`weaver`/`muse`) was local to that node — Amy's own `core`/`vision` never
needed routing since she called them directly, same-host. V4 has capability endpoints split
across both nodes (`nano`/`super`/`coder` on `spark`; `muse`/`omni` on `spark-2`), so **both nodes
now run their own router instance**, each with the same code but a different `HERMES_NODE`
value selecting which roles resolve to `127.0.0.1` versus the peer's LAN IP. (`coder` moved from
spark-2 to spark 2026-08-26 — see §3.)

## 1. Firewall — the one new opening this requires

Each router now proxies to some roles on the *other* node over the LAN. This needs a narrow ufw
rule on each node — not a new general opening, the same LAN-scoped posture Continuwuity's
node-to-node traffic already uses (`IMPLEMENTATION_PLAN.md` §4e):

```bash
# On spark-2 — allow spark to reach muse/omni:
sudo ufw allow from 10.129.1.15 to any port 8090,8091 proto tcp

# On spark — allow spark-2 to reach nano/super/coder:
sudo ufw allow from 10.129.1.17 to any port 8088,8094,8095 proto tcp
```

## 2. Both nodes — install the router

```bash
sudo cp hermes-router-spark.service /etc/systemd/system/hermes-router.service      # on spark
sudo cp hermes-router-spark2.service /etc/systemd/system/hermes-router.service     # on spark-2
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-router.service
curl -s http://127.0.0.1:8080/health   # {"ok": true, "node": "spark"|"spark-2", "roles": [...]}
```

Requires a `broker-token`/`password` vault item to already exist (it does — every broker caller
in this fleet already shares it) and, for real-time FleetOps notices, a `matrix-fleetops` item
(also already exists, same as `HermesAgentRedo`).

## 3. `spark` only — the wake worker and idle-sleep timers for `super` and `coder`

```bash
sudo cp hermes-model-wake-worker.service /etc/systemd/system/
sudo cp hermes-super-idle-sleep.service hermes-super-idle-sleep.timer /etc/systemd/system/
sudo cp hermes-coder-idle-sleep.service hermes-coder-idle-sleep.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-model-wake-worker.service
sudo systemctl enable --now hermes-super-idle-sleep.timer
sudo systemctl enable --now hermes-coder-idle-sleep.timer
```

`coder` (2026-08-26, `tools/hermes-model-wake-worker.py` 1.2.0): moved here from spark-2 after a
real execution-verified bake-off picked Qwen3.8-27B-abliterated (dense, on-demand) over the
spark-2-resident Qwen3-Coder-Next (MoE, always-configured-but-retired) — Coder-Next crashed with
a real `TypeError` on its own generated LRU-cache code, Qwen3.8 passed all 12 independent
correctness checks run against it. `llama-coder.service` has no `[Install]` section and
`Restart=no` deliberately — it must never auto-start at boot or auto-restart after the idle-sleep
timer stops it, only the wake worker's `sudo systemctl start` should ever bring it up.

**No new sudoers grant needed.** The wake worker runs as `User=pmoney`, same as every model
backend and the router itself already do on both nodes (verified live 2026-08-21 — `pmoney` has
`(ALL : ALL) NOPASSWD: ALL`, the human admin account's existing blanket grant). This is a
deliberate reuse of an already-accepted trust boundary, not a new one: `IMPLEMENTATION_PLAN.md`
§5 constraint 4's per-identity scoping is specifically about *gateway* processes (the ones
executing arbitrary tool calls from persona/Matrix-driven input) — `hermes-gateway.service`
already runs as the scoped `sintra`/`amy` accounts, confirmed live. Model-serving infrastructure
(the backends, the router, and now this worker) is lower-trust-surface: it never executes
anything beyond a small, fixed, reviewed set of commands (`sudo systemctl start/stop` against
one of `WAKE_TARGETS`'s literal unit names), not arbitrary agent-directed input. Worth
re-examining if that worker's command set ever grows past "systemctl start/stop one named unit."

## 4. Broker config — keep wake jobs out of FleetOps

`hermes-broker`'s existing `BROKER_QUIET_TYPES` env var (default `embed`, added Phase 30c for the
same reason) needs `wake` added when this deploys, so a wake job's non-artifact "result" doesn't
try to post a delivery notice meant for real render/embed output:

```
Environment="BROKER_QUIET_TYPES=embed,wake"
```

on `hermes-broker.service` (on `spark`) — a config change on an already-existing service, not a
broker code change, same as Phase 30c's own addition of the `embed` type.

## 5. Verify, don't assume

- `curl http://127.0.0.1:8080/v1/models` on each node should list all five roles.
- A `super` or `coder` call after real idle time should measurably wake it (check
  `journalctl -u hermes-model-wake-worker -f` for the claim/start/report sequence) and the
  `/v1/chat/completions` call itself should succeed once it's up.
- After ~15 minutes of no calls, each role's own idle-sleep timer should stop it — confirm with
  `systemctl is-active llama-super` / `llama-coder` before and after, not by assumption.
- Cross-node calls (e.g. `spark-2`'s router proxying to `coder` on `spark`) need the §1 ufw rules
  in place first, or they'll fail with a connection error, not a silent misroute.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | (baseline) | Initial recreate checklist for Stage 2 cutover. |
| 1.1.0 | 2026-08-26 | `coder` moved from spark-2 (Qwen3-Coder-Next, always-configured-but-retired) to spark (Qwen3.8-27B-abliterated, on-demand) after a real bake-off — updated node placement, ufw rules, wake-worker/idle-sleep setup accordingly. |
