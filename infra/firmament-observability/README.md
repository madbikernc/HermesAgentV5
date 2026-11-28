# Firmament observability (Prometheus + Grafana + Alertmanager) — recreate checklist

**Version:** 1.2.0

Ordered steps to stand up the fleet's Prometheus/Grafana/Alertmanager stack. See
`FIRMAMENT_OBSERVABILITY_PLAN.md` in the repo root for the full narrative — why HomeD13, what's
actually running across the fleet, the exporter landscape, and the values this is for. This file
is the recipe; that document is the reasoning. Matches this fleet's own established convention
(confirmed by reading `infra/comfyui/README.md` and every other `infra/<service>/` directory):
every Hermes service here is a native systemd unit, never a container, even on hosts that have
Docker installed for an unrelated reason.

Runs on **HomeD13** only (idle, protects the two GPU-constrained Spark hosts' resources — see the
plan doc §1). `node_exporter` runs on every host (dgx-spark, dgx-spark2, HomeD13) — see §2 below.

## 1. Prometheus (HomeD13)

```bash
# Version pinned 2026-11-28 -- check https://github.com/prometheus/prometheus/releases for newer
PROM_VERSION=3.16.0
cd /tmp
curl -LO "https://github.com/prometheus/prometheus/releases/download/v${PROM_VERSION}/prometheus-${PROM_VERSION}.linux-amd64.tar.gz"
curl -LO "https://github.com/prometheus/prometheus/releases/download/v${PROM_VERSION}/sha256sums.txt"
sha256sum --ignore-missing -c sha256sums.txt   # must say OK for the tarball above
sudo mkdir -p /opt/prometheus-${PROM_VERSION}
sudo tar -xzf prometheus-${PROM_VERSION}.linux-amd64.tar.gz -C /opt/prometheus-${PROM_VERSION} --strip-components=1
sudo useradd --no-create-home --shell /usr/sbin/nologin prometheus 2>/dev/null || true
sudo mkdir -p /opt/prometheus-data
sudo chown -R prometheus:prometheus /opt/prometheus-${PROM_VERSION} /opt/prometheus-data
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/prometheus/prometheus.yml /opt/prometheus-${PROM_VERSION}/
sudo mkdir -p /opt/prometheus-${PROM_VERSION}/rules
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/prometheus/rules/*.yml /opt/prometheus-${PROM_VERSION}/rules/
sudo chown -R prometheus:prometheus /opt/prometheus-${PROM_VERSION}
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/prometheus/prometheus.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now prometheus.service
curl -s http://127.0.0.1:9090/-/healthy   # expect "Prometheus Server is Healthy."
```

`prometheus.yml`'s own `scrape_configs` lists every exporter in the fleet — update it (and
`sudo systemctl reload prometheus` or restart) whenever a new target is added. Prometheus itself
is reached at `http://10.129.1.16:9090` from the LAN; no inbound `ufw` rule is needed for its own
UI/API since nothing outside HomeD13 needs to query it directly (Grafana, co-located, talks to it
over `127.0.0.1`).

## 2. Alertmanager (HomeD13)

```bash
AM_VERSION=0.35.1
cd /tmp
curl -LO "https://github.com/prometheus/alertmanager/releases/download/v${AM_VERSION}/alertmanager-${AM_VERSION}.linux-amd64.tar.gz"
curl -LO "https://github.com/prometheus/alertmanager/releases/download/v${AM_VERSION}/sha256sums.txt"
sha256sum --ignore-missing -c sha256sums.txt
sudo mkdir -p /opt/alertmanager-${AM_VERSION}
sudo tar -xzf alertmanager-${AM_VERSION}.linux-amd64.tar.gz -C /opt/alertmanager-${AM_VERSION} --strip-components=1
sudo useradd --no-create-home --shell /usr/sbin/nologin alertmanager 2>/dev/null || true
sudo mkdir -p /opt/alertmanager-data
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/alertmanager/alertmanager.yml /opt/alertmanager-${AM_VERSION}/
sudo chown -R alertmanager:alertmanager /opt/alertmanager-${AM_VERSION} /opt/alertmanager-data
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/alertmanager/alertmanager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now alertmanager.service
curl -s http://127.0.0.1:9093/-/healthy
```

Alertmanager routes everything to a local webhook (`http://127.0.0.1:9094/alert`) served by
`tools/hermes-alertmanager-matrix-bridge.py`, which relays into the FleetOps Matrix room via the
fleet's own `hermes_alert_common.matrix_notice()` — the same helper `hermes-router.py` and several
other tools already use, same credentials (`matrix-fleetops` vault item), no new secret needed.

```bash
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/hermes-alertmanager-matrix-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-alertmanager-matrix-bridge.service
```

## 3. Grafana (HomeD13)

Official Debian apt repo (ships its own systemd unit — nothing to write by hand here):

```bash
sudo mkdir -p /etc/apt/keyrings/
curl -fsSL https://apt.grafana.com/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/grafana.gpg
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" | sudo tee /etc/apt/sources.list.d/grafana.list
sudo apt-get update
sudo apt-get install -y grafana
sudo mkdir -p /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/grafana/provisioning/datasources/*.yml /etc/grafana/provisioning/datasources/
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/grafana/provisioning/dashboards/*.yml /etc/grafana/provisioning/dashboards/
sudo mkdir -p /var/lib/grafana/dashboards
sudo cp /home/pmoney/HermesAgentV5/infra/firmament-observability/grafana/dashboards/*.json /var/lib/grafana/dashboards/
sudo chown -R grafana:grafana /var/lib/grafana/dashboards
sudo systemctl enable --now grafana-server
```

Grafana's default port is `3000`. Firewall (narrow, matching this fleet's `hermes-fleetops-ui`
precedent — LAN plus Tailscale, never the open internet):

```bash
sudo ufw allow from 10.129.1.0/24 to any port 3000 proto tcp comment 'FIRMAMENT_OBSERVABILITY: Grafana UI, fleet LAN'
sudo ufw allow from 100.64.0.0/10 to any port 3000 proto tcp comment 'FIRMAMENT_OBSERVABILITY: Grafana UI, tailnet'
```

First login is `admin`/`admin` (Grafana forces a password change on first login) — set a real
password immediately, it's reachable from the whole fleet LAN and Tailscale. **Done 2026-11-28**:
its own Vaultwarden item, `grafana-admin` (one item per service, same convention as
`fleetops-ui`/`memory-token`/`buzz-token`), created on HomeD13 using the same sealed
apikey/masterpw credentials `vault-set-secret.sh` already uses for that host (`VAULT_NODE=homed13`)
— `bw create item` with a freshly generated password, then that same password set via Grafana's own
`PUT /api/admin/users/:id/password` as the real admin user, verified live (`admin:admin` → 401,
new credential → 200):

```bash
VAULT_NODE=homed13 /home/pmoney/HermesAgentV5/tools/vault-get-secret.sh grafana-admin password
```

## 4. node_exporter (every host: dgx-spark, dgx-spark2, HomeD13)

Deployed 2026-11-28 — see `FIRMAMENT_OBSERVABILITY_PLAN.md`'s own phase table for the exact
versions/paths/firewall rules applied on each host (dgx-spark and dgx-spark2 are **aarch64**,
HomeD13 is x86_64 — different tarballs). HomeD13's own instance is bound to `127.0.0.1:9100` only
(Prometheus is co-located there; nothing remote needs it). The Sparks' instances are bound
`0.0.0.0:9100` with a `ufw` rule restricting access to HomeD13's IP only, matching every other
cross-host-reachable port in this fleet.

## 5. Minecraft exporter (TickScope, on the bot-sandbox server)

Deployed on `192.168.1.221` (the bot-sandbox Minecraft server, reached via
`tools/hermes-minecraft-admin.py`'s `connect()`/`run()`, same as the earlier Prism/NBT-API
installs this session). See the plan doc for its confirmed-compatible version and exact metrics
endpoint.

**The box runs its own `ufw`, separate from the three Hermes fleet hosts — add a rule for 9101
there too**, or Prometheus's scrape will time out with no answer (a silent drop, not a refusal).
Found live 2026-11-28 debugging exactly that symptom: an earlier draft of this checklist assumed
the box had no firewall capability at all, which was wrong. The rule must target the **NAT-
hairpinned source address**, not HomeD13's real fleet-LAN IP — pfSense rewrites the fleet-LAN
source to `192.168.1.215` crossing into `192.168.1.0/24` on this path, the same address the box's
own pre-existing `22/tcp`/`25580/tcp` rules already use:

```bash
# on 192.168.1.221 itself
sudo ufw allow from 192.168.1.215 to any port 9101 proto tcp comment 'FIRMAMENT_OBSERVABILITY: HomeD13 Prometheus -> TickScope (fleet NAT hairpin)'
```

Also needs a pfSense rule passing TCP 9101 across the `10.129.1.0/24` ↔ `192.168.1.0/24` boundary
(an operator-only step, no CLI/API access available to automate it) — see
`FIRMAMENT_OBSERVABILITY_PLAN.md`'s Phase 4 notes for how that was confirmed and what the pfSense
side looked like once this ufw rule was also in place.

## 6. `hermes-router.py` metrics

`hermes-router.py` 2.23.0 added a **second**, metrics-only HTTP listener
(`ROUTER_METRICS_BIND`/`ROUTER_METRICS_PORT`, default `0.0.0.0:9101`) serving `/metrics` in
Prometheus text format — deliberately not a new path on the existing handler, which keeps its
`127.0.0.1`-only bind and request-routing logic completely unchanged. Add the matching firewall
rule on each host running the router (dgx-spark, dgx-spark2):

```bash
sudo ufw allow from 10.129.1.16 to any port 9101 proto tcp comment 'FIRMAMENT_OBSERVABILITY: HomeD13 Prometheus -> hermes-router metrics'
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-28 | Initial recreate checklist, written while standing up the stack for the first time. |
| 1.1.0 | 2026-11-28 | §5 extended with the real TickScope `ufw` rule, found live while resolving Phase 4's blocked scrape: the box runs its own `ufw` (an earlier draft here assumed no firewall capability at all — wrong), and the rule must target the NAT-hairpinned source `192.168.1.215` pfSense uses on this path, not HomeD13's real IP. |
| 1.2.0 | 2026-11-28 | Grafana's default `admin`/`admin` login changed, direct operator request. New `grafana-admin` Vaultwarden item (one item per service, same convention as `fleetops-ui`), created via the same sealed-credential `bw` flow `vault-set-secret.sh` already uses for HomeD13; the generated password was then set as the real admin password through Grafana's own `PUT /api/admin/users/:id/password`, verified live. |
