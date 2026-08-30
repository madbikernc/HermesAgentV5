# hermes-usage-report — recreate checklist

**Version:** 1.0.1

Weekly digest of `hermes-router.py`'s per-request usage log (`tools/hermes_usage_log.py`'s SQLite
store), emailed to The Boss — per-role (nano/super/coder/muse/omni) request volume and its trend against
the prior week, latency percentiles, token throughput, and error rate, with idle and high-error roles
called out explicitly. Not part of the 11-22 roadmap — a standalone weekly task, same tier as
`hermes-model-scan.timer`.

Built in direct response to: "propose a way for the Spark to actively monitor model usage, so I can
make data driven decisions on the choice of models used over time" (2026-08-14). `hermes-router.py`
(bumped to 1.2.0) is the actual data source — every request it proxies is logged there regardless of
caller; this tool only reads that log back out.

Deliberately no LLM call in the report itself — see `tools/hermes-usage-report.py`'s own docstring:
the content is a small set of exact counts already computed in plain code, and asking the router for a
closing brief would itself be a `core` request landing in the very log being summarized.

## Install

```bash
sudo cp hermes-usage-report.service hermes-usage-report.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-usage-report.timer
```

Runs Monday 08:15, shortly after the 08:00 `hermes-model-scan.timer`. Adjust `OnCalendar` if a
different day/time is wanted — nothing else depends on the specific slot.

The usage log itself has no separate install step — `hermes-router.py` 1.2.0 creates
`~/.hermes/state/usage.db` (SQLite, WAL mode) the moment it starts, and starts writing a row per
request from then on. **The router must actually be running 1.2.0 for any data to appear** — a `git
pull` alone doesn't restart the already-running service:

```bash
sudo systemctl restart hermes-router.service
```

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-usage-report.py --dry-run
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-usage-report.py
```

`--dry-run` prints the report instead of emailing it. Safe to run repeatedly — unlike the pfSense/
canary reports, this one has no state file to disturb; it always recomputes from two fixed trailing
7-day windows read straight out of the SQLite log, so a rerun is idempotent by construction. Expect an
all-zero/IDLE report until the router has been running 1.2.0 for a while and has real traffic to log.

## Verify

```bash
systemctl list-timers hermes-usage-report.timer
journalctl -u hermes-usage-report.service --no-pager
sqlite3 ~pmoney/.hermes/state/usage.db "select role, status, latency_ms, ttfb_ms, total_tokens, ts from usage_log order by ts desc limit 20;"
```

## Requires

- `tools/hermes-usage-report.py`, `tools/hermes_usage_log.py`, `tools/vault-get-secret.sh` on the
  Spark. Standard library only (`sqlite3` is stdlib) — no venv needed.
- `hermes-router.service` running **1.2.0 or later** — earlier versions never write to the usage log.
- Vault item `email-sintra` (already provisioned — same one `hermes-fleet-health.py` and
  `hermes-pfsense-report.py` use).

## Real bug found on the first live run (2026-08-14)

`hermes-usage-report.py` 1.0.0 assumed the log's SQLite schema always existed by the time it ran,
since `hermes-router.py`'s own `main()` creates it. On a freshly pulled checkout where the router
hadn't yet been restarted onto 1.2.0, running the report first hit `sqlite3.OperationalError: no such
table: usage_log` instead of just reporting an empty week. Fixed in 1.0.1 — the report script now
creates the schema itself too (`CREATE TABLE IF NOT EXISTS`, safe to call from both processes under
WAL mode).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-14 | Initial version — written after the fact to close a real gap: every other `infra/` tool in this project ships a README with an install checklist, and this one didn't when first committed. |
