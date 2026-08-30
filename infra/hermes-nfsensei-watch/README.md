# hermes-nfsensei-watch — recreate checklist

**Version:** 1.0.1

Daily check of the nfSensei project blog against a fixed list of "worth evaluating switching from
pfSense" criteria (`tools/hermes-nfsensei-watch.py`), emailing The Boss when a new post crosses one
that wasn't already met. Not part of the 11-22 smart-home roadmap — a standalone daily task, same
tier as `hermes-fleet-health.timer`.

Deterministic parts (fetching the blog, tracking seen posts/met criteria) are plain code; judging
whether a given post actually satisfies a criterion goes through the fleet's own router
(`tools/hermes-router.py`, `model: "nano"`) rather than a separate LLM dependency.

## Install

```bash
sudo cp hermes-nfsensei-watch.service hermes-nfsensei-watch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-nfsensei-watch.timer
```

Runs at 07:30, after the 06:00 `hermes-fleet-health.timer` and the 03:15 `hermes-nfs-backup.timer`,
before the 09:00/09:20 wiki check-ins. Adjust `OnCalendar` if a different time is wanted — nothing
else depends on the specific hour.

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-nfsensei-watch.py --dry-run
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-nfsensei-watch.py
```

`--dry-run` prints what would be emailed instead of sending it and leaves the state file untouched
— safe to run repeatedly while testing.

## Verify

```bash
systemctl list-timers hermes-nfsensei-watch.timer
journalctl -u hermes-nfsensei-watch.service --no-pager
cat ~pmoney/.hermes/state/nfsensei_state.json
```

## Requires

- `tools/hermes-nfsensei-watch.py`, `tools/vault-get-secret.sh` on the Spark.
- `python3-requests` and `python3-bs4` (both plain apt packages — no venv needed).
- `hermes-router.service` running and reachable at `127.0.0.1:8080`.
- Vault item `email-sintra` (already provisioned — same one `hermes-fleet-health.py` uses).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-09 | Initial version. Ported from a draft (`skills/nfsensei_watch.py`) written in a separate session and reviewed here — swapped its placeholder OpenAI-compatible endpoint for the real router and its plaintext SMTP env vars for the real Vaultwarden-backed path `hermes-fleet-health.py` already uses. |
