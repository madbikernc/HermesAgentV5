# hermes-wiki-checkin — recreate checklist

**Version:** 1.0.1

The real mechanism behind "the wiki page updates automatically" for Sintra and Amy. Neither
persona has crontab or systemctl access — that's a deliberate consequence of per-identity
isolation, not an oversight, and it isn't changing. Without a real external trigger, "schedule a
daily update" is a request neither of them can actually fulfill with a real tool — see
`LESSONS_LEARNED.md` for the incident where that gap produced a fabricated claim ("scheduled a
daily cron job") with nothing behind it.

This is that external trigger: a pmoney-owned systemd timer per persona that runs
`tools/hermes-wiki-checkin-trigger.sh <persona>`, which posts a real Matrix message into the
persona's own home room as `@hermes-ops-ctl:spark` — the same "never the persona" pattern already
used for `@fleetops:spark` (render delivery) and the `!new` trigger in
`hermes-session-cap-guard.sh`. The message flows through the gateway's ordinary inbound pipeline,
so it produces a real agent turn, not a special invocation path — the persona reads it, decides
whether anything is worth logging, and if so, writes it using the same `mediawiki.py` tools she
already has. Doing nothing on a quiet day is a correct, expected outcome, not a failure.

## Why a timer that only sends a prompt, not a timer that writes the page itself

`hermes-wiki-sync.py` (Configuration/Changelog pages) is deliberately code-only, no LLM in the
loop — those pages are pulled straight from `systemctl`/`curl` output, so templating them
directly is strictly more reliable. A Daily Blog is different: it's supposed to be a real
reflection on the day, which inherently needs a model's judgment about what's worth noting. The
timer's job is only to provide the real, external "it's time to check" signal — never to decide
or write the content itself.

## Install

```bash
sudo cp hermes-wiki-checkin@.service hermes-wiki-checkin-sintra.timer hermes-wiki-checkin-amy.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-wiki-checkin-sintra.timer hermes-wiki-checkin-amy.timer
```

Times are staggered (09:00 Sintra, 09:20 Amy) so both aren't reasoning at once, and land after the
existing 06:00 `hermes-fleet-health.timer` and 03:15 `hermes-nfs-backup.timer` so this isn't
competing with those for attention. Adjust `OnCalendar` if a different time is wanted — nothing
else depends on the specific hour.

## Manual trigger (testing, or an on-demand check-in)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-wiki-checkin-trigger.sh sintra
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-wiki-checkin-trigger.sh amy
```

## Verify

```bash
systemctl list-timers hermes-wiki-checkin-*
journalctl -u hermes-wiki-checkin@sintra.service -u hermes-wiki-checkin@amy.service --no-pager
```

A successful run logs `check-in prompt posted to <node>'s home room (...), event $...` — that only
confirms the *prompt* was delivered, not what the persona did with it. Confirm real follow-through
the same way as any other claim in this fleet: read the actual page back
(`mediawiki.py read "<Persona>/Daily-Blog"`) or check `mediawiki.py recent`, don't take a
self-report as proof.

## Requires

- `tools/hermes-wiki-checkin-trigger.sh`, `tools/vault-get-secret.sh`, `jq`, `curl` on the Spark.
- Vault item `matrix-ops-ctl` (already provisioned for the session-cap-guard `!new` trigger).
- `@hermes-ops-ctl:spark` already joined to both Sintra's and Amy's home rooms, already present in
  both identities' `MATRIX_ALLOWED_USERS` — no new provisioning needed, this reuses the existing
  control identity.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-03 | Initial version — real external daily trigger replacing the fabricated "self-scheduled" automation claim found on `Sintra/Daily-Blog`. |
