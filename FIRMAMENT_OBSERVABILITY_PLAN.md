# Firmament Observability Plan: Prometheus + Grafana

**Version:** 1.4.0
**Status:** Approved, live. Operator sign-off 2026-11-28: proceed now, full scope
including Alertmanager. Notification target (open question 4 below) defaults to Matrix per this
plan's own recommendation unless told otherwise. All phases done or best-effort-deferred as of
2026-11-28 — see §5's table.

## 0. Open questions for operator sign-off

1. ~~Proceed with implementation at all, or file this for later?~~ **Resolved 2026-11-28: proceed now.**
2. ~~Scope for v1~~ — **Resolved: full plan (§5's phases 2-8), including Alertmanager.**
3. ~~Alertmanager now or later?~~ **Resolved: now, in v1.**
4. **Notification target for Alertmanager**: Matrix (this fleet's existing room) is the obvious
   candidate and is the default this plan proceeds with — flag here if that's wrong.
5. Anything already running elsewhere (a personal Grafana instance, a cloud account) this should
   integrate with instead of being greenfield? Nothing was found in this repo or on any fleet host
   during research (§2) — proceeding on the assumption this is genuinely greenfield.

## 1. Recommendation in one paragraph

Run the Prometheus + Grafana stack on **HomeD13**, not on either Spark. HomeD13 is idle (load
average 0.13, 19 of 31GiB RAM free, 750GB of 883GB disk free), already runs Docker and several
always-on Hermes worker daemons that pull jobs from a broker on dgx-spark — the stack fits a
pattern this fleet already operates, not a new kind of workload. It has a confirmed sub-millisecond
network path to both Sparks (same LAN segment) plus a redundant Tailscale overlay. Running the
TSDB and dashboard service there means the two GPU-constrained Spark boxes carry nothing but a
lightweight `node_exporter` each — exactly the "protect resources on the Sparks" goal.

## 2. What's actually out there (confirmed this session, not assumed)

**Hosts and roles** (`tools/hermes-*.py` service inventory, read live via SSH):
- **dgx-spark** runs nearly the entire fleet: `hermes-router`, `-dispatch`, `-guard`, `-memory`,
  `-broker`, `-buzz`, the full self-repair pipeline (`-generate`/`-apply`/`-bridge`/
  `-promote-gate`), `-presenter`, `-probe`, `-rerank`, `-embed`, `-websearch`, `-market-gate`,
  `-model-scout-gate`, `-model-wake-worker`, `-minecraft-rag`, `-minecraft-triage`,
  `-fleetops-ui`, `-game-admin`, `-status`, `-logs`, `-baseline-authorize-watch`, `-vault-agent`,
  `llama-dispatch`/`llama-super`, and the Minecraft bot clients (`minecraft-bot-amy`/`-babs`).
- **dgx-spark2** is a lighter satellite, not a mirror (confirms a standing memory note): its own
  `hermes-router` instance, `-media`, `-reolink`, `-tts`, `-model-wake-worker`,
  `-minecraft-triage`, `-vault-agent`, `minecraft-bots-activity-log`, `llama-muse`.
- **GPU load**: spark runs 4 `llama-server` processes (dispatch/super/coder/coder2, ~57GB
  combined); spark2 runs 1 (muse, ~25GB). **No GPU monitoring exists anywhere today** — zero
  DCGM/nvidia-exporter units on either host.
- **Disk**: spark `/` 3.7T 62% used (1.4T free), `/mnt/hermes-data` 2.0T 71% used (568G free);
  spark2 `/` 3.7T 74% used (939G free), `/mnt/hermes-data` 2.0T 57% used (836G free).
  `/mnt/hermes-data` is confirmed (again, with real numbers this time) a separate local volume
  per host, not shared storage.
- **Already-cheap-to-expose metrics**: `hermes-router.py` calls `_log_usage()` on every single
  model request — `role`, `status`, `latency_ms`, `ttfb_ms`, `prompt_tokens`, `completion_tokens`,
  `total_tokens`, `error_message` — into a real database already. Adding Prometheus counters/
  histograms at that exact call site is the cheapest instrumentation in this whole plan.
- **Existing health tooling, all bespoke polling, none scrape-based**: `hermes-fleet-health.py`,
  `hermes-node-health.py`, `hermes-canary-health.py`, `hermes-game-server-monitor.py`,
  `hermes-minecraft-bots-status.py`, `hermes-self-repair-status.py`,
  `hermes-synology-health.py`, `hermes-status.py`. These are candidates to eventually complement
  or retire in favor of Grafana dashboards/alerts — not touched by this plan directly.

**HomeD13** (10.129.1.16, Debian 13 — a real desktop/workstation box, confirmed **not** the same
machine as NAS2, which is a separate Synology-style device at 10.129.1.167 that HomeD13 itself
NFS-mounts):
- Intel i7-7700K (4C/8T @ 4.2GHz), 31GiB RAM (19GiB available, some historical swap pressure but
  not active now), 883GB root volume with 750GB free. RTX 3060 (12GB VRAM), currently 0%
  utilization but ~7.9GB resident (held by ComfyUI, ready to burst, not actively computing).
- Already runs: `comfyui-homed13.service`, `hermes-embed-homed13.service` (a local llama.cpp
  embedding server), `hermes-embed-worker.service`, `hermes-render-worker.service`,
  `hermes-render-worker-video.service` (the last three **pull jobs from a broker on dgx-spark** —
  the exact cross-host offload pattern this plan would extend), Docker/containerd, fail2ban,
  Tailscale.
- Network: LAN ping from dgx-spark to HomeD13 is 0.2ms (same segment, not routed); Tailscale gives
  a second path (homed13 100.69.3.100, spark 100.96.59.79, spark-2 100.100.178.25, same tailnet).
  HomeD13 → 192.168.1.221 (the Minecraft server's own subnet) confirmed reachable: 1.5ms, routed
  via `10.129.1.1`.

**Plugin/exporter landscape** (version-confirmed via live Modrinth API queries, the same method
that found Prism/NBT-API last session):
- **TickScope** (Modrinth, GPL-3.0) is the Minecraft-side pick: confirmed `26.1.2`-compatible
  across multiple stable releases, zero runtime dependencies, exposes MSPT percentiles, per-world
  entity/chunk counts, JVM and CPU stats "ready for Grafana" by its own description.
  [modrinth.com/plugin/tickscope](https://modrinth.com/plugin/tickscope)
- A plugin literally named `prometheus-exporter` also confirms `26.1.2` but is v0.0.1-beta
  (two releases total) — a fallback, not the first pick.
- **Explicitly do not use** `sladkoff/minecraft-prometheus-exporter` despite being the most
  historically popular (~530 GitHub stars) — its last release predates this server's `26.x`
  version-string era and is unconfirmed for `26.1.2`.
- **spark (already installed) cannot feed Prometheus directly** — confirmed via its own docs:
  it's profiler/report-based (on-demand `/spark profiler`), not a continuous scrape endpoint. No
  companion bridge exists for Paper (only a Fabric-specific one). TickScope is the path, not spark.
- **node_exporter** is confirmed as the standing default for Linux host metrics (Grafana's own
  docs call it the industry standard; even Grafana Alloy's newer agent reuses its collector code).
- **DCGM-exporter is NOT viable on the Spark hosts.** Confirmed via NVIDIA's own developer
  forums: DCGM is explicitly unsupported on DGX Spark's GB10 chip — utilization reports "mirrored"
  (identical) across every process and VRAM reports `0MB`/`N/A` due to GB10's unified-memory
  architecture, an unresolved issue as of the latest toolchain. A community NVML unified-memory
  shim exists but isn't confirmed-reliable. **GPU metrics on the Sparks should be scoped as
  best-effort** (a simpler `nvidia-smi`-shelling exporter for aggregate utilization/power/temp),
  not a confirmed, fully-working feature — say this plainly to whoever reads a GPU dashboard later.

## 3. Deployment convention — corrected during implementation

**Native install, not Docker Compose.** §1/§4's original draft recommended Docker Compose on
HomeD13, based on generic home-lab research (§2 of the original research pass). Checking this
fleet's own `infra/` directory (confirmed live on HomeD13) found every one of its ~80 existing
services deployed natively — systemd units calling a plain Python/Node process or a git-cloned
tool in a venv (ComfyUI itself: `git clone` + venv + pip, nothing containerized), despite Docker
being installed on HomeD13 for an unrelated reason. Docker Compose would be the one inconsistent
piece of infrastructure in this entire fleet. Corrected: Prometheus and Alertmanager are static Go
binaries (the project's own normal distribution format) installed under `/opt`, each its own
systemd unit; Grafana uses its official Debian apt repo (ships its own systemd unit). This matches
`infra/comfyui/README.md`'s own "recreate checklist" format and installs under `/opt`.

**Firewall discipline.** Checked live `ufw status numbered` on all three hosts — this fleet's rules
are narrow and source-scoped (e.g. spark's rule 13: `8095/tcp ALLOW IN 10.129.1.16 # HermesAgentV5
SWE-bench: HomeD13 -> super`), never a blanket allow. Every new exporter port gets the same
treatment: a rule scoped to HomeD13's LAN IP (`10.129.1.16`) only, naming this plan in its comment,
on `10.129.1.0/24` — never opened on the `10.129.9.0/30`/`10.129.10.0/30` fabric/RDMA planes (see
`infra/network-planes.md`, which exists specifically because that discipline broke by accident
once already).

## 4. Proposed architecture

```
                    ┌───────────────────────────────────────────┐
                    │ HomeD13 (10.129.1.16) — idle, native services │
                    │                                             │
                    │  prometheus.service, alertmanager.service   │
                    │  (static Go binaries under /opt)             │
                    │  grafana-server.service (official apt repo)  │
                    │  node_exporter.service                       │
                    └───────────────┬─────────────────────────────┘
                                    │ scrapes (pull), LAN + Tailscale fallback
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
┌─────────▼─────────┐     ┌─────────▼─────────┐     ┌─────────▼─────────┐
│ dgx-spark          │     │ dgx-spark2         │     │ Minecraft server   │
│ node_exporter       │     │ node_exporter       │     │ (192.168.1.221)    │
│ nvidia-smi exporter │     │ nvidia-smi exporter │     │ TickScope plugin   │
│   (best-effort)     │     │   (best-effort)     │     │   (new /metrics)   │
│ hermes-router        │     │ hermes-router        │     └────────────────────┘
│   /metrics (new,     │     │   /metrics (new,     │
│   via _log_usage())  │     │   via _log_usage())  │
└──────────────────────┘     └──────────────────────┘
```

Everything above is a **pull** model (Prometheus scrapes outward from HomeD13) — no fleet host
pushes data anywhere, no new inbound port on HomeD13 beyond Grafana's own UI, and that UI should
be bound to LAN/Tailscale only, never exposed publicly (the same caution already applied to
Prism's own embedded web server last session). Every new exporter port gets its own narrow,
source-scoped `ufw` rule (HomeD13's IP only) per §3, documented in `infra/firmament-observability/README.md`.

## 5. Phased plan

| Phase | What | Status | Date | Notes |
|---|---|---|---|---|
| 0 | Write this plan | done | 2026-11-28 | |
| 1 | Operator sign-off on §0's open questions | done | 2026-11-28 | Operator: proceed now, full scope including Alertmanager |
| 2 | Stand up Prometheus + Alertmanager + Grafana (native systemd) on HomeD13 | done | 2026-11-28 | All three live: Prometheus 3.16.0 (`:9090`), Alertmanager 0.35.1 (`:9093`, cluster/gossip port disabled — single node, no mesh needed), Grafana 13.3.2 via apt (`:3000`). `hermes-alertmanager-matrix-bridge.py` (new, loopback-only `:9094`) relays alerts into FleetOps Matrix via the fleet's own `hermes_alert_common.matrix_notice()` — needed a `MATRIX_HOMESERVER` override (its default assumes co-location with Continuwuity on dgx-spark). End-to-end tested live with two real test alerts. |
| 3 | Deploy `node_exporter` (native systemd) on dgx-spark, dgx-spark2, HomeD13; narrow `ufw` rules; wire into Prometheus scrape config | done | 2026-11-28 | v1.13.1. Sparks are **aarch64** (Grace CPU), not x86-64 as first assumed — correct tarball used per host. HomeD13's own instance bound `127.0.0.1` only (co-located, no rule needed); Sparks bound `0.0.0.0` with a `ufw` rule scoped to HomeD13's IP. Verified the firewall boundary is real: spark2→spark:9100 times out (correctly blocked), homed13→both Sparks succeeds. All three `up` in Prometheus. |
| 4 | Install TickScope on the Minecraft bot-sandbox server; wire into scrape config | done | 2026-11-28 | TickScope 2.1.0 installed, checksum-verified, confirmed `26.1.2`-compatible, bearer-token auth enabled (verified live: no/wrong token → 401, correct token → 200). **Two real blockers found and fixed, both corrections to this plan's own earlier assumptions**: (1) the operator opened the pfSense rule for port 9101 across the `10.129.1.0/24` ↔ `192.168.1.0/24` boundary, which revealed the fleet-LAN source gets **NAT-hairpinned to `192.168.1.215`** on that path (the same address the box's pre-existing `22/tcp`/`25580/tcp` "fleet NAT hairpin" ufw rules already named — this plan just hadn't connected the two). (2) The Minecraft box's "no firewall capability at all — no sudo, no ufw/iptables" claim from this row's own first draft was **wrong**, found live via `tcpdump` (source IP `192.168.1.215`, confirming the hairpin) plus a direct `sudo ufw status` check that this process does in fact hold NOPASSWD sudo for: `ufw` is installed, active, default-deny-incoming, with zero rule for 9101 — a silent drop, which is exactly the "SYN leaves, nothing comes back" symptom reported, not a routing problem (SSH/25580 already round-tripped fine over the same path). Fixed with `sudo ufw allow from 192.168.1.215 to any port 9101 proto tcp comment 'FIRMAMENT_OBSERVABILITY: HomeD13 Prometheus -> TickScope (fleet NAT hairpin)'`. Verified end-to-end: `TCP_CONNECT_OK` from HomeD13, Prometheus's own `/api/v1/targets` reports the `minecraft_tickscope` job `up` with no `lastError`. |
| 5 | Instrument `hermes-router.py`'s `_log_usage()` call site with `prometheus_client` counters/histograms (requests by role+status, latency_ms/ttfb_ms histograms, token gauges); expose `/metrics` on each router instance (spark and spark2 separately) | done | 2026-11-28 | `hermes-router.py` 2.23.0: a **second**, metrics-only HTTP listener (own port, `9101`, default `0.0.0.0`) added via a new `MetricsHandler` class -- deliberately not a new path on the existing `Handler`, which keeps its `127.0.0.1`-only bind and request-routing logic completely unchanged. Hand-rolled Prometheus text format (no new pip dependency, matching this file's own stdlib-only style), in-process counters updated from `_log_usage()`. Verified in isolation before touching the live service (a real bug in my OWN test harness, not the patch, cost real time here -- see commit notes). Restarted both hosts' `hermes-router.service` one at a time, verified `/health` unaffected and `/metrics` serving real traffic on both before moving on. |
| 6 | Best-effort GPU metrics on dgx-spark/dgx-spark2 (`nvidia-smi`-shelling exporter, given DCGM is confirmed unsupported) | not started | | Deferred past this session's stopping point -- node/router/Minecraft metrics landed first since they were unambiguous; GPU is explicitly best-effort/experimental per §2's own research, worth its own careful pass |
| 7 | Initial Grafana dashboards: fleet host health, Minecraft server health, router latency/error rate, GPU (best-effort) | partial | 2026-11-28 | Three of four dashboards provisioned, confirmed loaded, and now confirmed **live with real data**: fleet hosts (CPU/memory/disk/up), hermes-router (request rate/error rate/latency by role), Minecraft (TPS/MSPT/players/chunks/entities/JVM heap, using TickScope's real metric names) — the Minecraft one was waiting on Phase 4's network fix, now resolved, target confirmed `up`. No GPU dashboard yet (Phase 6 not started). Default `admin`/`admin` login changed — see `infra/firmament-observability/README.md` 1.2.0 for the new `grafana-admin` Vaultwarden item. |
| 8 | Alertmanager + notification routing into Matrix | done | 2026-11-28 | Covered by Phase 2 above (built together) -- end-to-end verified with real test alerts through the full chain: Prometheus rule → Alertmanager → webhook → bridge → FleetOps Matrix room. |
| 9 | Candidate future exporters: self-repair queue depth, triage crash-pattern hit rate, Buzz message throughput | not started | | Deliberately deferred — add only when a specific diagnostic need justifies it, matching this project's own "don't add a metric speculatively" rule (see `tests/README.md`'s baseline-metric guidance) |
| 10 | Surface Grafana in `hermes-fleetops-ui` (the fleet's existing read-only ops page) | done | 2026-11-28 | `hermes-fleetops-ui.py` 2.29.0: a new "Observability (Grafana)" home-page card, plus a one-line pointer on `/status` and `/minecraft` to the same live Grafana instance — linked plainly (own auth realm, tailnet address), never iframed or proxied, matching that file's own established `RAG_PORTAL_URL` convention. No new read path, no sandbox or unit change; 494 existing offline checks still pass unchanged. |

## 6. Values — Minecraft specifically

- **TPS/MSPT as a live signal, not a manual check.** Right now, "is the bot behaving oddly because
  the server is lagging" means remembering to run `/spark profiler` by hand. A Grafana panel makes
  it a glance.
- **Entity/chunk counts over time** could retroactively explain mob-cap/chunk-loading pressure
  behind incidents like the archived phantom-swarm episode, instead of reconstructing it from logs
  after the fact.
- **Cross-referencing client and server timelines.** This session added client-side logging for
  mode firings, control denial/preemption, and death context. Correlating one of those against the
  server's own MSPT/entity-count at the *same timestamp* is only practical once both are on one
  Grafana timeline — journald alone can't do that overlay.
- **Trend tracking for fixes.** The chest-search-radius/world-memory fix from this session could
  be validated with "did 'could not find a chest' incidents actually drop" as a trend line over
  days, extending the legacy-baseline scorecard's philosophy from a point-in-time test run into a
  live production trend.

## 7. Values — the rest of the Firmament fleet

- **GPU visibility that doesn't exist today.** Nobody can currently see "is `coder` GPU-starved at
  2pm on weekdays" without manually running `nvidia-smi`. A dashboard answers it at a glance and
  could directly inform load-aware decisions already made by `hermes-model-scout-gate`/
  `hermes-model-wake-worker`.
- **The router's own usage log becomes actionable.** `_log_usage()` already writes every request's
  latency/error/token data to a database nobody queries live. Exporting it turns a write-only log
  into alertable signal (a role's error rate spiking, p99 latency degrading) — real value from data
  already being collected today.
- **One pane of glass across three hosts**, replacing or complementing the scattered
  `hermes-fleet-health.py`/`hermes-node-health.py`/`hermes-canary-health.py`-style scripts with a
  standard, queryable system — those could eventually become Grafana alert rules instead of
  separately maintained Python polling logic.
- **A real paging path**, if Alertmanager is in scope — routed into Matrix, which this fleet
  already uses, rather than relying on someone noticing a problem by eye.
- **Faster incident review.** Several detours this session itself (querying the wrong RCON port
  and wrongly suspecting 0 players online; chasing stuck-bot symptoms) would have been faster to
  rule out with a dashboard open instead of reconstructing a timeline from journald after the fact.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-28 | Initial proposal, written in response to a direct request to propose a plan for Prometheus/Grafana placement and value, considering HomeD13 as host. Not yet approved or executed. |
| 1.1.0 | 2026-11-28 | Operator approved full scope including Alertmanager; implementation started same day. Corrected the deployment convention from Docker Compose to native systemd services after checking this fleet's own `infra/` directory (every existing service is native) — see new §3. Confirmed HomeD13→192.168.1.221 reachability (was an open risk in 1.0.0). |
| 1.2.0 | 2026-11-28 | Phases 2, 3, 5, 8 done; Phase 7 partial (dashboards built, Minecraft one has no data yet); Phase 4 blocked on a real finding, not yet resolved: port 9101 doesn't cross the `10.129.1.0/24` ↔ `192.168.1.0/24` boundary from ANY fleet host, not just HomeD13 — almost certainly a pfSense rule, an operator decision, not something fixable from any host checked. Phase 6 (GPU) deliberately deferred past this session. |
| 1.3.0 | 2026-11-28 | **Phase 4 resolved, correcting two of this plan's own earlier assumptions, not just the pfSense piece the operator took on.** The operator opened the pfSense rule; that surfaced a NAT hairpin (fleet-LAN traffic into `192.168.1.0/24` arrives as `192.168.1.215`, same address this box's existing SSH/game-port rules already used), and a direct `ufw status` check (NOPASSWD sudo this process does hold) found the Minecraft box's "no firewall capability at all" claim from Phase 4's first draft was simply wrong — it runs `ufw`, default-deny, with no rule for 9101. Fixed with one scoped `ufw allow` rule; Prometheus's own targets API now reports that job `up`. Phase 7's Minecraft dashboard confirmed live with real data as a result. New Phase 10, done: Grafana links added to `hermes-fleetops-ui` (home card plus `/status`/`/minecraft` pointers), closing the loop the user asked for — "add appropriate links on the fleetops UI wherever appropriate to surface the grafana views." |
| 1.4.0 | 2026-11-28 | Phase 7's last loose end closed, direct operator request: Grafana's default `admin`/`admin` login changed to a generated password, stored in its own new `grafana-admin` Vaultwarden item (one item per service, same convention as every other credentialed Hermes service) — see `infra/firmament-observability/README.md` 1.2.0 for how it was created and set. Verified live: the old default now 401s, the new credential 200s. |
