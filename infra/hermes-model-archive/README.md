# hermes-model-archive — recreate checklist

**Version:** 1.4.1

Weekly best-effort archive (`tools/hermes-model-archive.py`) of each node's downloaded model files to NAS2,
so re-provisioning after a wipe (or the documented LUKS-remount issue on spark,
`HermesAgentRedo/LESSONS_LEARNED.md` §7) restores from NAS2 instead of re-downloading tens of GB per model
from Hugging Face. Stage 13, `IMPLEMENTATION_PLAN.md` §6 — **deployed and verified on both nodes as of
HermesAgentV5 S9** (`../../HermesAgentV5/IMPLEMENTATION_PLAN.md`). Real archives with verified `sha256`
manifests exist on NAS2 for every currently-active role on both spark and spark-2.

Motivating gap: Stage 12 (§6) left the retired 78GB Nemotron 3 Super shard set on spark's local disk with no
off-node copy at all — deletion was flagged rather than acted on unprompted purely because there was nowhere
else to safely park it first.

**Destination: `/mnt/nas2-hermes-backup/Private/Hermes/Models/<hf_id>/`** — a new folder tree on the fleet's
one existing NAS2 NFS mount, at the same level as `Private/Hermes/Spark_Backup/` (see `hermes-nfs-backup.sh`)
and `Private/Hermes/Images/` (see `skills/amy-image-gen/SKILL.md`). **No new NFS export or mountpoint** —
this reuses the mount `hermes-nfs-backup.sh`, `hermes-podcast-sync.py`, `hermes-rag-ingest-kb.py`, the
Zomboid/Minecraft pulls, and `amy-generate-image.sh`'s own NAS archive copy already all depend on. (1.0.0's
design proposed a new dedicated mount — corrected per direct request before anything was ever deployed.)

**`<hf_id>` is the model's real Hugging Face repo ID** (e.g. `unsloth/Nemotron-3-Nano-30B-A3B-GGUF`), not a
role/status label — 1.2.0 corrected this after the first real run archived under invented names like
`candidate-qwen3-coder-30b` and `retired-nemotron-3-super`. A model's identity doesn't change based on
whether it's currently deployed, a bake-off loser, or a redundant copy sitting on a second node; that's
deployment status, tracked in `IMPLEMENTATION_PLAN.md`, not the archive's folder name. Because `hf_id`
contains a `/`, destination directories nest naturally (`Models/unsloth/Nemotron-3-Nano-30B-A3B-GGUF/`),
grouping every archived model from the same publisher under one folder.

**Runs independently on each node — this is not a single centrally-run job.** Originally because no direct
pmoney-to-pmoney SSH path existed between spark and spark-2 (Stage 8, §6) — that gap closed in
HermesAgentV5 S1 (`~/.ssh/spark2_access` / `~/.ssh/spark_access`, both directions, provisioned for node-to-
node bulk transfer generally), but the per-node design still holds: each node archiving only its own local
model files is simpler than centralizing, and since every model role is pinned to exactly one node (§4a/
§4b), the two nodes never write to the same NAS2 role directory anyway.

## Install (per node)

```bash
sudo cp hermes-model-archive.service hermes-model-archive.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-model-archive.timer
```

Each node also needs its own `~/.hermes/config/model-archive-roles.json` before the first real run — see
"Config file" below for the real, live-verified content to use directly. No config file ships in this repo
itself (each node's file lives under `~/.hermes/config/`, not this checkout).

Runs Monday 09:00 — one hour after `hermes-model-scan.timer`'s existing Monday 08:00 slot, deliberately
staggered rather than coincidental. Weekly is intentionally infrequent: new model downloads are rare,
deliberate events (a Stage in this document), not a daily occurrence.

## Config file

`~/.hermes/config/model-archive-roles.json` — a JSON list of `{"hf_id": ..., "source": ...}` entries. `source`
may point at a single file or a directory (archived recursively). A multi-shard model that doesn't live in
its own subdirectory (e.g. Nemotron 3 Super's 3 loose shard files) needs one config entry per shard file, all
sharing the same `hf_id` — they accumulate into the same destination directory and manifest.

**Every path and `hf_id` below is live-verified** (real `ls` against both nodes, real HF repo pages checked
2026-08-24 — not best-guess):

**spark** — every model file actually present in `/mnt/hermes-data/models/`, not just the currently-deployed
two:

```json
[
  {"hf_id": "unsloth/Nemotron-3-Nano-30B-A3B-GGUF", "source": "/mnt/hermes-data/models/Nemotron-3-Nano-30B-A3B-Q4_K_M.gguf"},
  {"hf_id": "zai-org/GLM-4.7-Flash", "source": "/mnt/hermes-data/models/GLM-4.7-Flash-Q4_K_M.gguf"},
  {"hf_id": "unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF", "source": "/mnt/hermes-data/models/NVIDIA-Nemotron-3-Super-120B-A12B-UD-Q4_K_M-00001-of-00003.gguf"},
  {"hf_id": "unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF", "source": "/mnt/hermes-data/models/NVIDIA-Nemotron-3-Super-120B-A12B-UD-Q4_K_M-00002-of-00003.gguf"},
  {"hf_id": "unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF", "source": "/mnt/hermes-data/models/NVIDIA-Nemotron-3-Super-120B-A12B-UD-Q4_K_M-00003-of-00003.gguf"},
  {"hf_id": "Qwen/Qwen3-Embedding-0.6B", "source": "/mnt/hermes-data/models/Qwen3-Embedding-0.6B-Q8_0.gguf"},
  {"hf_id": "Qwen/Qwen3-Coder-30B-A3B-Instruct", "source": "/mnt/hermes-data/models/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"},
  {"hf_id": "Qwen/Qwen3.6-35B-A3B", "source": "/mnt/hermes-data/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"},
  {"hf_id": "huihui-ai/Huihui-Qwen3-30B-A3B-Instruct-2507-abliterated", "source": "/mnt/hermes-data/models/Huihui-Qwen3-30B-A3B-Instruct-2507-abliterated.Q4_K_M.gguf"},
  {"hf_id": "darkc0de/Muse-Glimmer-30B-heretic", "source": "/mnt/hermes-data/models/darkc0de_Muse-Glimmer-30B-heretic-Q4_K_M.gguf"},
  {"hf_id": "huihui-ai/Huihui-Qwen3.6-35B-A3B-abliterated", "source": "/mnt/hermes-data/models/Huihui-Qwen3.6-35B-A3B-abliterated.Q4_K_M.gguf"}
]
```

**spark-2** (`muse`, `omni` — S1 reclaimed Forge; `coder` moved to spark and isn't spark-2's concern anymore,
superseding this section's original Stage-8-era placement):

```json
[
  {"hf_id": "huihui-ai/Huihui-Qwen3.6-35B-A3B-abliterated", "source": "/mnt/hermes-data/models/Huihui-Qwen3.6-35B-A3B-abliterated.Q4_K_M.gguf"},
  {"hf_id": "unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF", "source": "/mnt/hermes-data/models/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf"},
  {"hf_id": "unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF", "source": "/mnt/hermes-data/models/mmproj-F16.gguf"}
]
```

Paths are `/mnt/hermes-data/models/` (the current LUKS-container location, same as spark), not the
`/opt/hermes-models/` this section originally listed — that path predates the LUKS migration and no longer
exists. **`/mnt/nas2-hermes-backup` is mounted and working on spark-2** — confirmed live during
HermesAgentV5 S1. This section originally said spark-2 had no NAS2 mount yet; true as of this file's
2026-08-24 origin, false since — the mount was added sometime between then and 2026-08-29.

## Manual trigger (testing)

```bash
python3 ~/HermesAgentV5/tools/hermes-model-archive.py --dry-run --verbose
python3 ~/HermesAgentV5/tools/hermes-model-archive.py --verbose
```

`--dry-run` prints what would be archived and copies nothing — safe to run repeatedly while verifying a new
config file's paths.

**Transfers are bandwidth-capped by default** (`--bwlimit-kbps`, default 15000 ~= 15MB/s, via `rsync
--bwlimit`) — added 1.3.0 after the real Stage 13 incident where an uncapped run hit `[Errno 5] Input/output
error` on most files once NAS2 (busy with its own background load) missed the `soft` mount's response
window. Override per-run (`--bwlimit-kbps 5000` to go slower, `--bwlimit-kbps 0` to disable the cap entirely
— only if NAS2 is confirmed idle first).

## Verify

```bash
systemctl list-timers hermes-model-archive.timer
journalctl -u hermes-model-archive.service --no-pager
ls -la /mnt/nas2-hermes-backup/Private/Hermes/Models/<hf_id>/
cat /mnt/nas2-hermes-backup/Private/Hermes/Models/<hf_id>/manifest.json
```

## Restore (after a wipe or a lost local model dir)

Not automated — a deliberate manual step, same as every other destructive/re-provisioning action in this
project (§5 constraint 5). Copy the relevant `<hf_id>/` directory back from
`/mnt/nas2-hermes-backup/Private/Hermes/Models/`, verify each file's `sha256` against `manifest.json` before
pointing the relevant `start-*.sh` at it — replaces a from-Hugging-Face re-download with a from-NAS2 restore.

## Design notes

- Best-effort, never fatal on a missing NAS2 mount or missing config — same explicit precedent as
  `amy-generate-image.sh`'s NAS archive copy: a node's actual model-serving capability must never depend on
  this script. A genuine mid-copy failure still exits 1, so it surfaces via `hermes-node-health.py`'s
  "Failed units" check — the non-fatal stance only covers "nothing to do," not "something broke."
- Idempotent by filename + byte size, same comparison `hermes_game_backup_common.py` already uses for its
  own NAS pulls.
- No retention/pruning, unlike the game-server-backup pulls — models aren't a daily-growing dataset the way
  world saves are; an archived model stays archived until a human deliberately removes it.
- No change needed to `hermes-fleet-health.py`'s existing NAS2-mount check — `/mnt/nas2-hermes-backup` is
  already checked there, and `Models/` is just a folder under that same mount.

## Requires

- `tools/hermes-model-archive.py` on each node; no third-party packages beyond the standard library.
- The existing NAS2 NFS mount (`mnt-nas2-hermes-backup.automount` → `/mnt/nas2-hermes-backup`) — already
  provisioned and depended on by several other tools; nothing new to set up here.
- Each node's own `~/.hermes/config/model-archive-roles.json` (see "Config file" above for the real,
  live-verified content).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.4.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-23 | Initial version — Stage 13. Designed following the direct request to give downloaded models a NAS2 repository; not deployed or live-verified against either node yet. |
| 1.1.0 | 2026-08-23 | Corrected per direct request: no new dedicated NFS mount/export. `Models/` is a new folder under `Private/Hermes/` on the *existing* `/mnt/nas2-hermes-backup` mount, sibling to `Spark_Backup/` and `Images/`, not a separate share. Removed the "Prerequisite: NAS2 mount" section entirely (nothing new to provision) and the corresponding `hermes-fleet-health.py` check (redundant — the existing mount check already covers it). 1.0.0's design was never deployed, so nothing downstream depended on the wrong mount path. |
| 1.2.0 | 2026-08-24 | First real deployment attempt on spark surfaced two real problems, both fixed: (1) destination folders were keyed by an invented role/status label (`nano`, `candidate-qwen3-coder-30b`, `retired-nemotron-3-super`) instead of the model's actual identity — config schema and script both renamed `role`→`hf_id`, using each model's real, individually-verified Hugging Face repo ID as the destination folder (nests naturally since `hf_id` contains `/`). (2) The real run also hit `[Errno 5] Input/output error` on 9 of 11 files — NAS2's `soft,timeo=50,retrans=3` mount gave up under sustained heavy transfer load, worsened by concurrent diagnostic reads against the same share mid-transfer. Not a config/code bug; a real NAS2 capacity/timeout limit under this workload, re-run planned without concurrent load. This entry also replaces every config example in this file with live-verified paths (previously explicitly flagged as best-guess). |
| 1.4.0 | 2026-08-29 | HermesAgentV5 S9: deployed on spark-2 for the first time (had never run there — `muse`/`omni`, 46.6GB, archived successfully), corrected the spark-2 config example to current post-S1 paths and role placement (`coder` moved to spark; stale `/opt/hermes-models/` paths replaced with `/mnt/hermes-data/models/`), and corrected two stale claims this file made at its 2026-08-24 origin: spark-2 does have a working NAS2 mount now, and a direct pmoney-to-pmoney SSH path between the nodes exists now (S1). Added a weekly systemd timer on both nodes — the tool had been run manually but was never actually scheduled despite this file already describing a timer. |
