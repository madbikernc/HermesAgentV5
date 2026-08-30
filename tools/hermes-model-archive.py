#!/usr/bin/env python3
# Version: 1.3.0
#
# 1.3.0 — direct request: throttle the actual transfer. The real Stage 13 run (2026-08-24)
# hit `[Errno 5] Input/output error` under sustained full-speed writes -- NAS2's own
# `soft,timeo=50,retrans=3` mount gave up once the NAS (busy with its own cloud-sync
# daemon) got slow enough to miss that window. A saturating, unthrottled copy is a real
# contributing cause the fleet controls; the NAS's own background load isn't. Replaced
# `shutil.copy2()` with an `rsync --bwlimit=<KB/s>` subprocess -- rsync's own bandwidth
# cap is a real, tested mechanism rather than a hand-rolled sleep loop. Default 15000
# KB/s (~15MB/s), overridable with --bwlimit-kbps; comfortably under what saturated the
# NAS during the incident (that run had no cap at all) while still finishing a ~400GB
# fleet-wide backup in a bounded time. `rsync` confirmed already installed on spark
# (3.2.7) -- no new dependency to provision.
#
# 1.2.0 — direct request: destination folders were keyed by an invented status label
# ("nano", "candidate-qwen3-coder-30b", "retired-nemotron-3-super", "duplicate-muse-...")
# instead of the model's real identity. Renamed the config key and every internal
# reference from `role` to `hf_id` — destination folders are now the model's actual
# Hugging Face repo ID (org/repo, e.g. `unsloth/Nemotron-3-Nano-30B-A3B-GGUF`), nested
# naturally since `hf_id` contains a `/`. No "candidate"/"retired"/"duplicate" labels —
# a model's identity doesn't change based on whether it's currently deployed, an
# unused bake-off loser, or a redundant copy; that's deployment status, not identity,
# and belongs in IMPLEMENTATION_PLAN.md's own tables, not the archive's folder names.
# Every existing config entry and everything already archived under the old role-based
# names needs re-verifying/moving by hand after this change — not done automatically,
# since a real HF-ID must be looked up per model, not derived mechanically from the
# old label.
"""
hermes-model-archive.py — Best-effort archive of downloaded model files to
NAS2, so re-provisioning after a wipe (or the documented LUKS-remount issue
on spark, `HermesAgentRedo/LESSONS_LEARNED.md` §7) restores from NAS2 instead
of re-downloading tens of GB per model from Hugging Face. Stage 13,
`IMPLEMENTATION_PLAN.md` §6 — designed, not yet deployed to either node.

Destination is `/mnt/nas2-hermes-backup/Private/Hermes/Models/<hf_id>/` — a
new folder tree on the fleet's one existing NAS2 NFS mount, at the same level as
`Private/Hermes/Spark_Backup/` and `Private/Hermes/Images/`. `<hf_id>` is the
model's real Hugging Face repo ID (e.g. `unsloth/Nemotron-3-Nano-30B-A3B-GGUF`),
so a multi-shard model naturally nests under one `org/repo/` directory and an
org with several models on this fleet groups under one `org/` directory. No new
NFS export or automount unit is needed; this reuses the mount every other NAS2
tool in this repo already depends on.

Motivating gap this closes: Stage 12 (§6) left the retired 78GB Nemotron 3
Super shard set on spark's local disk with no off-node copy at all —
deletion was flagged rather than acted on unprompted purely because there
was nowhere else to safely park it first. Every model file downloaded onto
`spark` (`/mnt/hermes-data/models/`) or `spark-2` (`/opt/hermes-models/`)
exists in exactly one place today.

Runs independently and locally on each node — deliberately not centralized
on spark reaching out over SSH the way `hermes-nfs-backup.sh` handles both
identities from one place, because no direct pmoney-to-pmoney SSH path
exists between spark and spark-2 (Stage 8, §6, had to work around exactly
this gap with a manual staged copy through amy's home directory to move
`muse`'s model file). Multiple config entries may share the same `hf_id`
(e.g. a multi-shard model, one entry per shard file) — they accumulate into
the same destination directory and manifest, one archive_model() call per
entry, same as before.

Each node's own local config file (default
~/.hermes/config/model-archive-roles.json, override with --config) lists
which local model files that node should archive — spark's covers
nano/super (plus anything else downloaded there), spark-2's covers
omni/coder/muse. The exact on-disk layout for a model (a single .gguf vs. a
multi-shard set, like Nemotron 3 Super's retired 3-shard set) is not
something this planning session can verify against live hardware, so the
config file is the one place that mapping needs to be correct, not this
script. Every hf_id below must be independently verified against the
model's real Hugging Face page before being trusted — this project's own
"byte-verified, not guessed" discipline applies to identity strings the same
as it applies to file sizes.

Config file format (a JSON list):
[
  {"hf_id": "unsloth/Nemotron-3-Nano-30B-A3B-GGUF", "source": "/mnt/hermes-data/models/Nemotron-3-Nano-30B-A3B-Q4_K_M.gguf"},
  {"hf_id": "zai-org/GLM-4.7-Flash", "source": "/mnt/hermes-data/models/GLM-4.7-Flash-Q4_K_M.gguf"}
]
"source" may be a single file or a directory (archived recursively, so a
multi-shard set not sharing a subdirectory is instead covered by one config
entry per shard file, all sharing the same hf_id).

Best-effort, never fatal — same explicit precedent as amy-generate-image.sh's
NAS archive copy: if /mnt/nas2-hermes-backup isn't mounted, or the config
file is missing, this logs and exits 0. A node's actual model-serving
capability must never depend on this script. A real failure partway through
a copy (not just "nothing to do") still exits 1, so it surfaces via
hermes-node-health.py's "Failed units" check.

Idempotent by filename + byte size, same comparison
hermes_game_backup_common.py already uses for its own NAS pulls — an
already-archived file is skipped, not re-copied. A manifest.json entry
(byte size, sha256, archive date, original source path) is written per file,
matching the "byte-verified" discipline IMPLEMENTATION_PLAN.md §4 already
applies to every model size in this document.

Usage: hermes-model-archive.py [--config PATH] [--dry-run] [--verbose] [--bwlimit-kbps N]

--bwlimit-kbps caps the transfer rate via `rsync --bwlimit` (KB/s, rsync's own unit).
Default 15000 (~15MB/s) -- chosen after Stage 13's real incident to stay well clear of
whatever saturated NAS2 during an uncapped run, not a precise measurement of its ceiling.
Pass 0 to disable the cap entirely (real risk of repeating the incident under NAS load).
"""

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

NAS_MOUNT_ROOT = Path("/mnt/nas2-hermes-backup")
NAS_MODELS_DIR = NAS_MOUNT_ROOT / "Private" / "Hermes" / "Models"
DEFAULT_CONFIG = Path.home() / ".hermes" / "config" / "model-archive-roles.json"
MANIFEST_NAME = "manifest.json"


def log(msg, verbose_only=False, verbose=True):
    if verbose_only and not verbose:
        return
    print(f"[hermes-model-archive] {msg}")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_config(path: Path) -> list:
    entries = json.loads(path.read_text())
    for e in entries:
        if "hf_id" not in e or "source" not in e:
            raise ValueError(f"config entry missing 'hf_id' or 'source': {e}")
    return entries


def load_manifest(model_dir: Path) -> dict:
    manifest_path = model_dir / MANIFEST_NAME
    if manifest_path.exists():
        return json.loads(manifest_path.read_text())
    return {}


def save_manifest(model_dir: Path, manifest: dict):
    (model_dir / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, sort_keys=True))


def iter_source_files(source: Path):
    if source.is_file():
        yield source
    elif source.is_dir():
        for f in sorted(source.rglob("*")):
            if f.is_file():
                yield f


def rsync_copy(source: Path, dest: Path, bwlimit_kbps: int):
    """Copies source -> dest via rsync, optionally bandwidth-capped. Raises on any
    non-zero exit (rsync's own stderr is the error message) so the caller's existing
    try/except + .partial-cleanup handling covers this exactly like the old
    shutil.copy2() call did -- rsync failing partway leaves a partial dest file, which
    the caller unlinks on the way out."""
    cmd = ["rsync"]
    if bwlimit_kbps > 0:
        cmd.append(f"--bwlimit={bwlimit_kbps}")
    cmd += [str(source), str(dest)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise IOError(f"rsync exited {proc.returncode}: {proc.stderr.strip()[:500]}")


def archive_model(hf_id: str, source: Path, dry_run: bool, verbose: bool, bwlimit_kbps: int) -> tuple:
    if not source.exists():
        log(f"{hf_id}: source {source} does not exist, skipping", verbose=verbose)
        return 0, 0, 0

    files = list(iter_source_files(source))
    if not files:
        log(f"{hf_id}: no files found under {source}", verbose=verbose)
        return 0, 0, 0

    model_dir = NAS_MODELS_DIR / hf_id
    manifest = load_manifest(model_dir) if model_dir.exists() else {}

    copied = skipped = failed = 0
    for f in files:
        rel_name = f.name
        dest = model_dir / rel_name
        local_size = f.stat().st_size

        if dest.exists() and dest.stat().st_size == local_size:
            skipped += 1
            log(f"{hf_id}: {rel_name} already archived ({local_size} bytes), skipping",
                verbose_only=True, verbose=verbose)
            continue

        if dry_run:
            log(f"{hf_id}: would archive {rel_name} ({local_size} bytes)", verbose=verbose)
            copied += 1
            continue

        model_dir.mkdir(parents=True, exist_ok=True)
        tmp_dest = dest.with_name(dest.name + ".partial")
        try:
            rsync_copy(f, tmp_dest, bwlimit_kbps)
            copied_size = tmp_dest.stat().st_size
            if copied_size != local_size:
                raise IOError(f"size mismatch after copy: got {copied_size}, expected {local_size}")
            tmp_dest.rename(dest)
            manifest[rel_name] = {
                "size": local_size,
                "sha256": sha256_file(dest),
                "archived": datetime.now(timezone.utc).isoformat(),
                "source": str(f),
            }
            save_manifest(model_dir, manifest)
            copied += 1
            log(f"{hf_id}: archived {rel_name} ({local_size} bytes)", verbose=verbose)
        except Exception as e:
            tmp_dest.unlink(missing_ok=True)
            failed += 1
            log(f"{hf_id}: FAILED to archive {rel_name}: {e}", verbose=verbose)

    return copied, skipped, failed


def main() -> int:
    parser = argparse.ArgumentParser(description="Best-effort archive of downloaded model files to NAS2")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG,
                         help="path to this node's model-list config file")
    parser.add_argument("--dry-run", action="store_true", help="print what would be archived, copy nothing")
    parser.add_argument("--verbose", action="store_true", help="print skip/no-op lines too, not just changes")
    parser.add_argument("--bwlimit-kbps", type=int, default=15000,
                         help="rsync bandwidth cap in KB/s (default 15000 ~= 15MB/s); 0 disables the cap")
    args = parser.parse_args()

    if not NAS_MOUNT_ROOT.is_mount():
        log(f"NAS2 mount ({NAS_MOUNT_ROOT}) not present — skipping this run (best-effort, non-fatal)")
        return 0

    try:
        entries = load_config(args.config)
    except Exception as e:
        log(f"config problem ({args.config}): {e} — skipping this run (best-effort, non-fatal)")
        return 0

    if not args.dry_run:
        cap = f"{args.bwlimit_kbps} KB/s" if args.bwlimit_kbps > 0 else "uncapped"
        log(f"Transfer cap: {cap}")

    total_copied = total_skipped = total_failed = 0
    for entry in entries:
        copied, skipped, failed = archive_model(
            entry["hf_id"], Path(entry["source"]), args.dry_run, args.verbose, args.bwlimit_kbps)
        total_copied += copied
        total_skipped += skipped
        total_failed += failed

    suffix = " (dry-run, nothing written)" if args.dry_run else ""
    log(f"Done: {total_copied} archived, {total_skipped} already present, {total_failed} failed{suffix}")

    return 1 if total_failed else 0


if __name__ == "__main__":
    sys.exit(main())
