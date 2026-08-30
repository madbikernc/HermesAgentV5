---
name: podcast-sync
description: "Download/sync Security Now! and Intelligent Machines transcripts, show notes, and Tech Brew Ride Home's story-links citation list, to the NAS archive. Also runs automatically once daily."
version: 1.1.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [podcast, archive, security-now, transcripts, nas]
prerequisites:
  commands: [python3]
---

# Podcast Archive Sync

**Version:** 1.1.0

Downloads transcripts, show notes, and (for Security Now) transcript PDFs for **Security Now!**
(GRC.com) and **Intelligent Machines** (twit.tv, formerly This Week in Google through episode
804) into the NAS archive at `/mnt/nas2-hermes-backup/PodCasts`. Ported conceptually from v1
(`../../HermesAgent/scripts/podcast_retriever.py`), whose scraping/probing logic was already
correct and needed no rework. Also downloads (1.1.0) **Tech Brew Ride Home**'s per-episode
story-links citation list (headline + source publication + URL for each story covered) from its
own official RSS feed — this show has no transcript anywhere, confirmed live 2026-08-15.

## How to use it

```bash
python3 ~/HermesAgentV5/tools/hermes-podcast-retriever.py --outputdir /mnt/nas2-hermes-backup/PodCasts
python3 ~/HermesAgentV5/tools/hermes-podcast-retriever.py --outputdir /mnt/nas2-hermes-backup/PodCasts --shows im -v
python3 ~/HermesAgentV5/tools/hermes-podcast-retriever.py --outputdir /mnt/nas2-hermes-backup/PodCasts --shows sn --types notes --episodes 900-950
python3 ~/HermesAgentV5/tools/hermes-podcast-retriever.py --outputdir /mnt/nas2-hermes-backup/PodCasts --shows tbrh -v
```

Only downloads what's missing locally — safe to re-run at any time. No credentials needed (GRC,
twit.tv, and the TBRH RSS feed are all public). Standard library only — no venv.

**A daily automated sync also runs on its own** (`tools/hermes-podcast-sync.py`, via
`hermes-podcast-sync.timer` at 06:00 — see `infra/hermes-podcast-sync/`): pulls `sn`, `im`, and
`tbrh` (not `twig`, which stopped producing new episodes at the IM rename), and emails The Boss at
`notifications@canislupisnc.net` only when something's actually new or unexpectedly broken —
silent otherwise. Trigger it by hand the same way:

```bash
python3 ~/HermesAgentV5/tools/hermes-podcast-sync.py
```

## Rules

- **Read/download only.** This doesn't touch, rename, or delete anything already in the archive —
  it only adds files that are missing locally.
- If a download fails, report the real error the tool printed (it validates content type before
  writing — a failed PDF magic-byte check or a too-short transcript page both surface as a named
  failure, not a silently-corrupt file). Don't describe a sync as clean if the tool's own output
  shows failures.
- **The daily sync deliberately suppresses old, long-abandoned gaps** (missing 30+ days *and* more
  than 10 episodes behind the show's latest known episode) so a permanently-unpublished transcript
  doesn't nag forever — but always reports a *recent* gap, even past 30 days, since that's the
  kind of stuck-and-worth-a-look case the suppression logic exists to still catch. If asked why a
  known-missing file isn't in a report, check
  `~pmoney/.hermes/state/podcast-sync/missing-since.json` before assuming the sync is broken.
- See `../../IMPLEMENTATION_PLAN.md` §7 Phase 24 for the full scope and porting notes.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.1.0 | 2026-08-15 | Adds `tbrh` (Tech Brew Ride Home): direct request, after confirming live this show has no official transcript anywhere — only its own RSS feed's per-episode story-links citation list, which is what gets pulled instead. Added to the daily sync's `SHOWS` list too. |
| 1.0.0 | 2026-08-12 | Initial version. Phase 24 (`IMPLEMENTATION_PLAN.md` §7) built — ported from v1, fixed for the current NAS mount path and Vaultwarden-backed email, and actually scheduled (v1 never was, post-migration). |
