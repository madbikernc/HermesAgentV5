# hermes-router (V4) — recreate checklist

**Version:** 1.2.0

Ordered steps to stand up `hermes-router` under HermesAgentV5's target topology
(`IMPLEMENTATION_PLAN.md` §4, §6 Stage 2): capability endpoints reachable by either persona
regardless of which node hosts them, plus `super`/`coder` loading on demand. Deployed and live
since Stage 2 cut over; this doc is kept accurate rather than archived, same as every other
`infra/*/README.md` in this project once its stage has run.

## 0. What changed from HermesAgentRedo's single-router setup

`HermesAgentRedo` ran exactly one `hermes-router` instance, on `spark`, because every backend
Sintra needed (`core`/`weaver`/`muse`) was local to that node — Amy's own `core`/`vision` never
needed routing since she called them directly, same-host. V4 has capability endpoints split
across both nodes (`nano`/`super` on `spark`; `muse`/`omni`/`coder`/`coder2` on `spark-2`), so
**both nodes now run their own router instance**, each with the same code but a different
`HERMES_NODE` value selecting which roles resolve to `127.0.0.1` versus the peer's LAN IP.
(`coder` moved from spark-2 to spark 2026-08-26, then back to spark-2 2026-10-07 — see §3.)

## 1. Firewall — the one new opening this requires

Each router now proxies to some roles on the *other* node over the LAN. This needs a narrow ufw
rule on each node — not a new general opening, the same LAN-scoped posture Continuwuity's
node-to-node traffic already uses (`IMPLEMENTATION_PLAN.md` §4e):

```bash
# On spark-2 — allow spark to reach muse/omni/coder/coder2:
sudo ufw allow from 10.129.1.15 to any port 8090,8091,8094,8099 proto tcp

# On spark — allow spark-2 to reach nano/super:
sudo ufw allow from 10.129.1.17 to any port 8088,8095 proto tcp
```

(`coder` left spark 2026-10-07 — the old `8094` entry on spark's own inbound rule was removed,
not just left stale, since nothing on spark serves that port anymore.)

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

## 3. `spark` — wake worker and idle-sleep timer for `super` only (as of 2026-10-07)

```bash
sudo cp hermes-model-wake-worker.service /etc/systemd/system/
sudo cp hermes-super-idle-sleep.service hermes-super-idle-sleep.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-model-wake-worker.service
sudo systemctl enable --now hermes-super-idle-sleep.timer
```

`coder`'s own wake-worker entry and idle-sleep timer moved to spark-2 2026-10-07 (see below) —
spark's `hermes-model-wake-worker.py` instance now only serves `super`. **Caveat found live, not
yet reconciled:** `super`'s own systemd unit on spark is in fact `enabled`/`Restart=always`
("always-resident" in its own Description) despite `ROLES`/`WAKE_TARGETS` still listing it as
on-demand, and there is no evidence `hermes-super-idle-sleep.timer` has ever actually stopped it
— looks like an earlier on-demand migration for `super` that was never finished. Harmless today
(nothing currently tries to stop it), but worth resolving one way or the other rather than
leaving the unit and the router code disagreeing about what `super` is.

## 3a. `spark-2` — wake worker and idle-sleep timers for `coder` and `coder2`

```bash
sudo cp hermes-coder-idle-sleep.service hermes-coder-idle-sleep.timer /etc/systemd/system/
sudo cp hermes-coder2-idle-sleep.service hermes-coder2-idle-sleep.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-coder-idle-sleep.timer
sudo systemctl enable --now hermes-coder2-idle-sleep.timer
```

(spark-2's own `hermes-model-wake-worker.py` instance and its systemd unit are not tracked in this
repo — same untracked-on-spark gap `start-coder.sh`/`llama-coder.service` have always had, per
`infra/hermes-coder2/README.md` §4. It needs `WAKE_TARGETS` to include both `coder` and `coder2`
now, same file, `HERMES_NODE=spark-2` branch.)

`coder` (2026-08-26, `tools/hermes-model-wake-worker.py` 1.2.0): moved from spark-2 to spark after
a real execution-verified bake-off picked Qwen3.8-27B-abliterated (dense, on-demand) over the
spark-2-resident Qwen3-Coder-Next (MoE, always-configured-but-retired) — Coder-Next crashed with
a real `TypeError` on its own generated LRU-cache code, Qwen3.8 passed all 12 independent
correctness checks run against it.

`coder` (2026-10-07, `tools/hermes-model-wake-worker.py` 1.4.0): moved back to spark-2, this time
alongside `coder2` — spark was chronically at ~97% memory and swapping heavily; `coder`, despite
being nominally on-demand, was in near-continuous real use and never actually idled out, making it
the single largest avoidable resident consumer on spark. Model weights rsynced spark → spark-2 over
`bond-fabric0` (16.8GB in 38s, sha256-verified identical before cutover). This puts `coder` back on
the same node as `coder2` — the original 2026-08-26 placement deliberately kept them apart for
memory-bandwidth isolation during a dual-coder review, but `hermes-dualcoder.py`'s own task log
shows zero real reviews claimed in the 30 days before this move (`claim_next()` only ever timing
out / connection-refused), and its two `security_review()` calls are sequential even when it does
run, never concurrent — so this is a deliberately accepted dormant risk, not a resolved one.
Revisit if dual-coder-review ever becomes real traffic again. `llama-coder.service` has no
`[Install]` section and `Restart=on-failure` (not `always`) deliberately — it must never auto-start
at boot or auto-restart after the idle-sleep timer stops it, only the wake worker's
`sudo systemctl start` should ever bring it up.

**Measured live, 2026-10-07, immediately after cutover:** spark-2 went from 83GiB/38GiB
(used/available) to 97GiB/23GiB once `coder` finished loading alongside the three backends already
resident there (`muse`, `omni`, `coder2` — all four happened to be awake at once) — swap jumped
1.6GiB → 8.7GiB in the same window. Real headroom exists but is measurably less generous than
`free -h`'s "available" column suggests before the load lands (same warning V4 §4a and this
project's `IMPLEMENTATION_PLAN.md` have made before about this hardware's unified memory). Revisit
if spark-2 itself starts showing sustained swap pressure the way spark did.

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
- A `super` (spark), `coder`, or `coder2` (spark-2) call after real idle time should measurably
  wake it (check `journalctl -u hermes-model-wake-worker -f` on the node that hosts it, for the
  claim/start/report sequence) and the `/v1/chat/completions` call itself should succeed once
  it's up.
- After ~15 minutes of no calls, each role's own idle-sleep timer should stop it — confirm with
  `systemctl is-active llama-super` (spark) / `llama-coder` / `llama-coder2` (spark-2) before and
  after, not by assumption. (`super`'s own idle-sleep has no confirmed stop in its history as of
  2026-10-07 — see §3's caveat.)
- Cross-node calls (e.g. `spark`'s router proxying to `coder` on `spark-2`) need the §1 ufw rules
  in place first, or they'll fail with a connection error, not a silent misroute.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.2.0 | 2026-10-07 | `coder` moved from spark back to spark-2, alongside `coder2` — spark's own wake-worker/idle-sleep setup (§3) now covers `super` only; spark-2 gets its own §3a. Firewall rules in §1 flipped accordingly. Noted a live-found caveat: `super`'s on-demand config on spark looks unfinished (unit is enabled/always-restart, no confirmed idle-sleep stop ever). |
| 1.1.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | (baseline) | Initial recreate checklist for Stage 2 cutover. |
| 1.1.0 | 2026-08-26 | `coder` moved from spark-2 (Qwen3-Coder-Next, always-configured-but-retired) to spark (Qwen3.8-27B-abliterated, on-demand) after a real bake-off — updated node placement, ufw rules, wake-worker/idle-sleep setup accordingly. |
