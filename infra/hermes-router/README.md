# hermes-router (V4) — recreate checklist

**Version:** 1.8.0

Ordered steps to stand up `hermes-router` under HermesAgentV5's target topology
(`IMPLEMENTATION_PLAN.md` §4, §6 Stage 2): capability endpoints reachable by either persona
regardless of which node hosts them, plus `super`/`coder` loading on demand. Deployed and live
since Stage 2 cut over; this doc is kept accurate rather than archived, same as every other
`infra/*/README.md` in this project once its stage has run.

## 0. What changed from HermesAgentRedo's single-router setup

`HermesAgentRedo` ran exactly one `hermes-router` instance, on `spark`, because every backend
Sintra needed (`core`/`weaver`/`muse`) was local to that node — Amy's own `core`/`vision` never
needed routing since she called them directly, same-host. V4 has capability endpoints split
across both nodes (`super`/`dispatch`/`log-analyst` on `spark`; `muse`/`omni`/`coder`/`coder2` on
`spark-2`; `nano` retired in S13), so **both nodes now run their own router instance**, each with
the same code but a different `HERMES_NODE` value selecting which roles resolve to `127.0.0.1`
versus the peer's LAN IP. (`coder` moved from spark-2 to spark 2026-08-26, then back to spark-2
2026-10-07 — see §3.)

### Current role placement (verified live 2026-11-04)

| Role | Node | Port | Model (as loaded) | Residency |
|---|---|---|---|---|
| `super` | spark | 8095 | Huihui-GLM-4.7-Flash-abliterated Q4_K_M, ctx 65536 | resident; displaced while `log-analyst` needs its memory, woken back on demand or restored when log-analyst idles out (§3) |
| `dispatch` | spark | 8097 | Qwen3.6-35B-A3B-UD-Q4_K_M (stock), ctx 65536, `--parallel 4` | resident |
| `log-analyst` | spark | 8098 | NousResearch Hermes-4.3-36B-Q4_K_M (stock), ctx 16384, q8_0 KV | on-demand, 300s idle — see `infra/hermes-log-analyst/README.md` §5 |
| `coder` | spark-2 | 8094 | Qwen3-Coder-Next-UD-Q4_K_M (stock), ctx 65536 | on-demand |
| `coder2` | spark-2 | 8099 | GLM-4.7-Flash-Q4_K_M (stock), ctx 65536 | on-demand |
| `muse` | spark-2 | 8090 | NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning UD-Q4_K_M (stock, text-only load) | on-demand (demoted from resident 2026-11-16, §3a) |
| `omni` | spark-2 | 8091 | NVIDIA-Nemotron-3.5-Bolt-74B-A9B (stock, + mmproj) | on-demand (demoted from resident 2026-11-19, §3a) |
| `reflector` | spark-2 | 8093 | GLM-5.3-Flash-Q2-DGX-Spark (stock) | on-demand, GEPA reflection backend only — see `infra/hermes-reflector/README.md` |

Not proxied by this router: `embed` (spark :8092 and HomeD13, Qwen3-Embedding-8B-Q8_0) and
`rerank` (spark :8093, Qwen3-Reranker-0.6B-Q8_0). The `llama-super`/`llama-dispatch`/`llama-coder`
units and their `start-*.sh` scripts are tracked as of 2026-11-04, copied from the live nodes:
`infra/hermes-super/`, `infra/hermes-dispatch/`, `infra/hermes-coder/` (spark-2's copy; spark's own
idle `llama-coder` unit is a leftover from before the 2026-10-07 move and is no longer woken).

## 1. Firewall — the one new opening this requires

Each router now proxies to some roles on the *other* node over the LAN. This needs a narrow ufw
rule on each node — not a new general opening, the same LAN-scoped posture Continuwuity's
node-to-node traffic already uses (`IMPLEMENTATION_PLAN.md` §4e):

```bash
# On spark-2 — allow spark to reach muse/omni/coder/coder2/reflector:
sudo ufw allow from 10.129.1.15 to any port 8090,8091,8093,8094,8099 proto tcp

# On spark — allow spark-2 to reach super/log-analyst, and dispatch for S12 standby failover:
sudo ufw allow proto tcp from 10.129.1.17 to any port 8095,8098
sudo ufw allow proto tcp from 10.129.1.17 to any port 8097
# On spark — HomeD13's SWE-bench harness reaches super:
sudo ufw allow proto tcp from 10.129.1.16 to any port 8095
```

(`coder` left spark 2026-10-07 — the old `8094` entry on spark's own inbound rule was removed,
not just left stale, since nothing on spark serves that port anymore.)

Spark's live rules match this block as of 2026-11-04: the legacy `8088` (`nano`, retired) and
`8090,8091` (nothing on spark serves them) rules for spark-2 and HomeD13 were removed, and `8098`
was added so spark-2's router can reach `log-analyst`.

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

## 3. `spark` — wake worker for `super` and `log-analyst`

```bash
sudo cp hermes-model-wake-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-model-wake-worker.service
```

`coder`'s own wake-worker entry and idle-sleep timer moved to spark-2 2026-10-07 (see below) —
spark's `hermes-model-wake-worker.py` instance served only `super` until S44 (2026-10-27) added
`log-analyst` (its own idle-sleep timer: `infra/hermes-log-analyst/README.md` §3).

**Resolved 2026-11-16 (HermesAgentV6 `IMPLEMENTATION_PLAN.md` §7.4), was flagged as an
unreconciled caveat as of 1.4.0.** `super`'s unit is deliberately a hybrid, not a half-finished
on-demand migration: `enabled`/`Restart=always`/boot-started because it's a shared
deep-reasoning tier meant to stay hot under normal load (its live Description already says so —
"shared deep-reasoning escalation tier, resident, displaced by log-analyst on demand, spark", not
"always-resident" as 1.4.0 found it), while `ROLES["super"]`'s `on_demand=True` exists for exactly
one purpose: so a `super` request made while it's *displaced* (stopped by `log-analyst`'s own
need for memory, via `hermes-model-wake-worker.py`'s `make_room()`) goes through `wake_role()`
and actually wakes it back up,
rather than erroring against a backend that's down. Confirmed live: `hermes-model-wake-worker.py`'s
`WAKE_TARGETS["super"]` entry exists for exactly this. `super` is not meant to idle-timeout-sleep
on its own, separately from that displacement — doing so would add `super`'s own real cold-start
(~100s) to the first call after any 15-minute quiet stretch, for a tier whose whole point is
staying hot. `hermes-super-idle-sleep.service`/`.timer` (still committed below, each now carrying
an explicit "not deployed" header comment) were never actually installed on spark — confirmed
2026-11-16: absent from `/etc/systemd/system`, `is-enabled` reports `not-found` — not a bug, this
is the intended end state. They stay in the repo as a template only, for if staying-hot is ever
deliberately revisited; don't `cp`/`enable` them without that being a real decision, since it
changes `super`'s latency behavior for every caller.

## 3a. `spark-2` — wake worker and idle-sleep timers for `coder`, `coder2`, `muse`, and `reflector`

```bash
sudo cp hermes-coder-idle-sleep.service hermes-coder-idle-sleep.timer /etc/systemd/system/
sudo cp hermes-coder2-idle-sleep.service hermes-coder2-idle-sleep.timer /etc/systemd/system/
sudo cp hermes-muse-idle-sleep.service hermes-muse-idle-sleep.timer /etc/systemd/system/
sudo cp hermes-reflector-idle-sleep.service hermes-reflector-idle-sleep.timer /etc/systemd/system/
sudo cp hermes-omni-idle-sleep.service hermes-omni-idle-sleep.timer /etc/systemd/system/
sudo cp hermes-model-wake-worker-spark2.service /etc/systemd/system/hermes-model-wake-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-coder-idle-sleep.timer
sudo systemctl enable --now hermes-coder2-idle-sleep.timer
sudo systemctl enable --now hermes-muse-idle-sleep.timer
sudo systemctl enable --now hermes-reflector-idle-sleep.timer
sudo systemctl enable --now hermes-omni-idle-sleep.timer
sudo systemctl restart hermes-model-wake-worker.service
```

**`omni` demoted resident -> on-demand 2026-11-19** — see this file's own 1.8.0 changelog entry
and `infra/hermes-omni/README.md` §2a. Unlike `reflector`'s own entry, this one really is exercised
in normal operation: `omni` backs the live `fleet_vision_judge` role, and its idle-sleep timer
updates `omni.last_used` the same way `coder`'s already does, through the router path — a direct
`--endpoint` test still won't touch it (same caveat as every other role here).

**`reflector`'s idle-sleep timer is installed but inert for its actual use case** — see
`infra/hermes-reflector/README.md` §2a: the GEPA harness calls it by direct `--endpoint`, never
through this router's dispatch, so `.last_used` is never written and the timer never fires.
Manual `sudo systemctl stop llama-reflector` is the real shutdown step for this one role.

**Tracking gap closed 2026-11-16:** spark-2's own `hermes-model-wake-worker.py` instance's systemd
unit is now committed as `hermes-model-wake-worker-spark2.service` — it had been running live,
untracked under that name, since 2026-09-05 (same gap `start-coder.sh`/`llama-coder.service` have
always had, per `infra/hermes-coder2/README.md` §4); captured verbatim from the live deployed unit
before this edit. Its `WAKE_TARGETS` (in `tools/hermes-model-wake-worker.py`, `HERMES_NODE=spark-2`
branch) now includes `coder`, `coder2`, and `muse` (1.8.0, added alongside `muse`'s on-demand
demotion — `infra/hermes-muse/README.md` §2a).

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

- `curl http://127.0.0.1:8080/v1/models` on each node should list all roles, including `reflector`.
- A `super` call made while it's displaced (spark), or a `coder`/`coder2`/`muse`/`omni` call after
  real idle time (spark-2), should measurably wake it (check
  `journalctl -u hermes-model-wake-worker -f` on the node that hosts it, for the claim/start/report
  sequence) and the `/v1/chat/completions` call itself should succeed once it's up.
- After ~15 minutes of no calls, `coder`/`coder2`/`log-analyst`/`muse`/`omni`'s own idle-sleep
  timer should stop them — confirm with `systemctl is-active llama-coder` / `llama-coder2` /
  `llama-muse` / `llama-omni` (spark-2) / `llama-log-analyst` (spark) before and after, not by
  assumption. `super` is the deliberate exception: it has no idle-sleep timer installed at all
  (§3) and should stay running except when `log-analyst` displaces it. `reflector` is a different
  exception: its timer is installed but never fires in practice (it's called by direct
  `--endpoint`, not through the router), so confirm its shutdown with a manual
  `sudo systemctl stop llama-reflector` instead of waiting on the timer.
- Cross-node calls (e.g. `spark`'s router proxying to `coder` on `spark-2`) need the §1 ufw rules
  in place first, or they'll fail with a connection error, not a silent misroute.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.8.0 | 2026-11-19 | `omni` demoted resident -> on-demand (direct operator request, S39 self-repair coding-capability follow-up): spark-2 had no free headroom for a larger `coder` candidate (45.9GiB) while every backend stayed pinned resident/undisplaceable. §0's role table, §3a's install block (new `hermes-omni-idle-sleep` pair), and §5's verify checklist all updated. `coder` itself promoted to Qwen3-Coder-Next-UD-Q4_K_M in the same pass — see `infra/model-benchmark/spark2-candidate-results.md` Phase 7 and `infra/hermes-coder/start-coder.sh`'s own header. |
| 1.7.0 | 2026-11-16 | New role `reflector` added (HermesAgentV6 `IMPLEMENTATION_PLAN.md` GLM-5.3-Flash Paradigm A, Phase 2): GLM-5.3-Flash-Q2-DGX-Spark on `spark-2`, port 8093, on-demand, a GEPA reflection backend only — see `infra/hermes-reflector/README.md`. §0's role table, §1's ufw rule (8093 added to the spark-to-spark-2 block), §3a's install block and idle-sleep pair, and §5's verify checklist all updated. Flagged plainly: this role's idle-sleep timer is installed for fleet-convention completeness but never actually fires, since the GEPA harness calls it by direct `--endpoint` rather than through this router. |
| 1.6.0 | 2026-11-16 | Resolved `super`'s on-demand/systemd caveat (HermesAgentV6 `IMPLEMENTATION_PLAN.md` §7.4), open since 1.2.0/1.4.0: confirmed live that `super`'s unit Description already describes the intended hybrid (resident, displaced on demand) rather than claiming "always-resident", and that `hermes-super-idle-sleep.service`/`.timer` were never actually installed on `spark` (`is-enabled` → `not-found`) — not an unfinished migration, the intended end state. Rewrote §3 and §5 to say so plainly instead of flagging it as unreconciled; removed the idle-sleep `cp`/`enable` lines from §3's install block and added a "not deployed" header comment to both committed unit files so they read as a template, not a missed step. |
| 1.5.0 | 2026-11-16 | `muse` demoted resident -> on-demand (HermesAgentV6 `IMPLEMENTATION_PLAN.md` §6.1/§9.1), triggered by spark-2 measuring 118Gi/121Gi used with swap maxed, all four of its backends concurrently resident/awake. §0's role-placement table and §5's verify checklist updated. §3a renamed/expanded for `muse`'s new idle-sleep pair and `WAKE_TARGETS` entry (`tools/hermes-model-wake-worker.py` 1.8.0), and closed a real tracking gap found in the same pass: spark-2's own wake-worker systemd unit (live since 2026-09-05) is now committed as `hermes-model-wake-worker-spark2.service`, captured verbatim from the deployed unit rather than left untracked. |
| 1.4.0 | 2026-11-04 | log-analyst fixed (16k/q8_0 KV, wake-worker displacement of an idle super); super's residency row updated to match. super/dispatch/coder units now tracked under `infra/hermes-super/`, `infra/hermes-dispatch/`, `infra/hermes-coder/`. §1 ufw block rewritten to the live, cleaned-up rules (nano 8088 and spark-side 8090,8091 removed, 8098 added). |
| 1.3.0 | 2026-11-04 | Model-assumption sweep: added a live-verified current role/node/port/model table (§0), fixed §0 topology line (nano retired; dispatch/log-analyst on spark), noted the untracked on-node super/dispatch/coder units, recorded live ufw drift including the missing spark `8098` rule (spark-2 router cannot reach log-analyst), and §3 now mentions log-analyst on spark's wake worker. |
| 1.2.0 | 2026-10-07 | `coder` moved from spark back to spark-2, alongside `coder2` — spark's own wake-worker/idle-sleep setup (§3) now covers `super` only; spark-2 gets its own §3a. Firewall rules in §1 flipped accordingly. Noted a live-found caveat: `super`'s on-demand config on spark looks unfinished (unit is enabled/always-restart, no confirmed idle-sleep stop ever). |
| 1.1.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | (baseline) | Initial recreate checklist for Stage 2 cutover. |
| 1.1.0 | 2026-08-26 | `coder` moved from spark-2 (Qwen3-Coder-Next, always-configured-but-retired) to spark (Qwen3.8-27B-abliterated, on-demand) after a real bake-off — updated node placement, ufw rules, wake-worker/idle-sleep setup accordingly. |
