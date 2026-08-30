# hermes-podcast-sync — recreate checklist

**Version:** 1.1.1

Daily sync of Security Now! and Intelligent Machines transcripts/show-notes from GRC.com and
twit.tv, plus (1.1.0) Tech Brew Ride Home's official story-links citation list from its own RSS
feed, to the NAS (`tools/hermes-podcast-sync.py`, wrapping `tools/hermes-podcast-retriever.py`).
Silent when there's nothing new and nothing broken; emails `notifications@canislupisnc.net` only
when something's actually worth seeing (new episodes landed, or an unexpected/recent failure).
Same tier as `hermes-nfs-backup.timer` and `hermes-pfsense-report.timer`.

Phase 24 (`IMPLEMENTATION_PLAN.md` §7). Ported from v1
(`../../HermesAgent/scripts/podcast_retriever.py` + `podcast-sync.py`), whose retriever logic and
suppression policy needed no rework — only the deployment layer was stale: v1's output path
(`/mnt/nfs/PMoney/PodCasts`) was an autofs mount that no longer exists post-migration, its email
used a plaintext `~/.hermes/config/email.json` predating this project's Vaultwarden-only
credential rule, and it was scheduled through v1's own `hermes cron` subsystem, which has no
equivalent here. All three fixed; the archive itself survived the migration untouched —
confirmed live 2026-08-12: `/mnt/nas2-hermes-backup/PodCasts/` still holds the full history (2786
SN files, 74 IM files at verification time), just three-ish episodes behind current.

## Install

```bash
sudo cp hermes-podcast-sync.service hermes-podcast-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-podcast-sync.timer
```

Runs at 06:00, same slot v1 used (and just ahead of `hermes-fleet-health.timer`'s own 06:00 —
`RandomizedDelaySec` on both keeps them from colliding exactly). Adjust `OnCalendar` if a
different time is wanted.

## Manual trigger (testing)

```bash
sudo -u pmoney /usr/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-podcast-sync.py
```

No `--dry-run` mode — the retriever itself is already idempotent (it only downloads what's
missing locally, so a repeat run with nothing new to fetch is a safe no-op that just re-scans).
The state file only tracks *failures* it's suppressing, so a clean run doesn't touch it beyond
pruning resolved entries.

To exercise the retriever directly against a narrow slice instead of the full show list:

```bash
python3 /home/pmoney/HermesAgentV5/tools/hermes-podcast-retriever.py \
  --outputdir /mnt/nas2-hermes-backup/PodCasts --shows im --episodes 880-885 -v
```

## Verify

```bash
systemctl list-timers hermes-podcast-sync.timer
journalctl -u hermes-podcast-sync.service --no-pager
cat ~pmoney/.hermes/state/podcast-sync/missing-since.json
ls /mnt/nas2-hermes-backup/PodCasts/SecurityNow/transcripts_txt | sort -t- -k2 -n | tail -3
```

## Requires

- `tools/hermes-podcast-sync.py`, `tools/hermes-podcast-retriever.py`, `tools/vault-get-secret.sh`
  on the Spark. Standard library only — no venv needed.
- The Phase 12 NFS mount (`mnt-nas2-hermes-backup.automount` → `/mnt/nas2-hermes-backup`).
- Vault item `email-sintra` (already provisioned — same one `hermes-fleet-health.py` and
  `hermes-pfsense-report.py` use).

## Behavior notes carried forward from v1

- `sn`, `im`, and (1.1.0) `tbrh` are synced daily (`SHOWS` in the script) — `twig` stopped
  producing new episodes once the show became Intelligent Machines at episode 805, so it's
  retrieval-capable but not part of the daily pull.
- `tbrh` (Tech Brew Ride Home) has no transcript at all — no official one exists for this show
  (confirmed live 2026-08-15). What gets pulled instead is its own official RSS feed's per-episode
  story-links citation list (headline + source publication + URL for each story that episode
  covered), saved as `tbrh-YYYYMMDD.json`. Episodes are keyed by publish date, not a sequential
  number — the feed has neither (checked live against real feed content).
- A missing file only stops being reported once it's been missing 30+ continuous days *and* is
  more than 10 episodes older than the latest known episode for its show — recent gaps always
  stay visible (the ones worth a human noticing); only long-abandoned ones (GRC never publishing
  a given transcript) get auto-hidden. Tracked per-filename in the state file above. For `tbrh`,
  "10 episodes older" is measured in real calendar days (`episode_distance()`), not raw
  subtraction on the YYYYMMDD key, which breaks across a month/year boundary.
- Failure-suppression state only gets written on a real script run (not `--dry-run`, since there
  isn't one) — matches v1 exactly.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.1.0 | 2026-08-15 | Adds `tbrh` (Tech Brew Ride Home) to the daily `SHOWS` list — direct request, after confirming live that this show has no official transcript, only its own RSS feed's per-episode story-links citation list. Also fixes a real latent bug this exposed: the missing-file recency check assumed every show's episode numbers are sequential integers, which isn't true for `tbrh`'s date-keyed ones — see `episode_distance()` in `hermes-podcast-sync.py`. |
| 1.0.0 | 2026-08-12 | Initial version — Phase 24, ported from v1. Output path fixed to the real current NFS mount, email switched to Vaultwarden, scheduled via this timer (v1 was never actually scheduled anywhere in HermesAgentV4). |
