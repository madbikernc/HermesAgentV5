#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 — security-review fix: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing on a complete Vaultwarden
# outage — this was the reference pattern several other tools' vault_get()
# copied, carrying the same gap forward; fixed here and in each of those.
"""
hermes_game_backup_common.py — Shared SSH/SFTP pull logic for the muncraft
box's game-server backup jobs (hermes-zomboid-backup-pull.py,
hermes-minecraft-backup-pull.py). Factored out once a second game needed
the identical connect/pull/prune logic — same reasoning
hermes_canary_common.py and hermes_pfsense_common.py were each split out
the moment a second script needed their boilerplate.

Named with underscores, breaking this project's usual hyphenated-filename
convention for tools/ scripts — deliberately: this file is `import`ed by
the per-game scripts, not invoked directly, and Python cannot import a
module whose filename contains a hyphen.
"""
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import paramiko
except ImportError:
    paramiko = None

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_SCRIPT = REPO_DIR / "tools" / "vault-get-secret.sh"
# One vault item covers the whole box, not just Zomboid — the underlying
# credential is a real SSH login for 192.168.1.221 (user zomboid-admin,
# secondary member of the muncraft group), which is exactly what reading
# /opt/minecraft/backups/ needs too. Not renamed here to avoid touching
# Vaultwarden state as a side effect of a code change.
VAULT_ITEM = "Zomboid Admin - muncraft"

HOST = "192.168.1.221"
CONNECT_TIMEOUT = 10


def vault_get(field: str) -> str:
    # Security-review fix: a *complete* Vaultwarden outage (both attempts
    # here hitting the full 60s timeout) previously raised TimeoutExpired
    # uncaught instead of returning "" — this was the reference pattern
    # several other tools' vault_get() copied, carrying the same gap forward.
    for _ in range(2):
        try:
            result = subprocess.run([str(VAULT_SCRIPT), VAULT_ITEM, field],
                                     capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


def connect():
    if paramiko is None:
        raise RuntimeError("paramiko not available")
    user = vault_get("username")
    password = vault_get("password")
    if not user or not password:
        raise RuntimeError(f"could not fetch credentials from vault item '{VAULT_ITEM}'")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=user, password=password, timeout=CONNECT_TIMEOUT)
    return client


def pull_new_backups(client, remote_dir: str, filename_prefix: str, dest_dir: Path) -> tuple:
    """Downloads any `<filename_prefix>*.tar.gz` in `remote_dir` not already
    present at the same size in `dest_dir`. Returns (pulled, skipped, failed)."""
    sftp = client.open_sftp()
    dest_dir.mkdir(parents=True, exist_ok=True)

    try:
        remote_files = sftp.listdir_attr(remote_dir)
    except FileNotFoundError:
        sftp.close()
        raise RuntimeError(f"{remote_dir} does not exist on {HOST}")

    pulled, skipped, failed = [], [], []
    for f in remote_files:
        if not f.filename.startswith(filename_prefix) or not f.filename.endswith(".tar.gz"):
            continue
        dest_path = dest_dir / f.filename
        if dest_path.exists() and dest_path.stat().st_size == f.st_size:
            skipped.append(f.filename)
            continue
        remote_path = f"{remote_dir}/{f.filename}"
        tmp_path = dest_path.with_suffix(".tar.gz.partial")
        try:
            sftp.get(remote_path, str(tmp_path))
            if tmp_path.stat().st_size != f.st_size:
                raise IOError(f"size mismatch after transfer: got {tmp_path.stat().st_size}, "
                               f"expected {f.st_size}")
            tmp_path.rename(dest_path)
            pulled.append(f.filename)
        except Exception as e:
            tmp_path.unlink(missing_ok=True)
            failed.append((f.filename, str(e)))

    sftp.close()
    return pulled, skipped, failed


def prune_old(dest_dir: Path, filename_prefix: str, days: int) -> list:
    """Deletes local NAS copies older than `days`, independent of what still
    exists on the source — the source has its own, shorter prune window."""
    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    removed = []
    for f in dest_dir.glob(f"{filename_prefix}*.tar.gz"):
        if f.stat().st_mtime < cutoff:
            f.unlink()
            removed.append(f.name)
    return removed


def run_pull_job(remote_dir: str, filename_prefix: str, dest_dir: Path,
                  retention_days: int, verbose: bool) -> int:
    """Shared main-body logic for a per-game pull script's main(). Returns
    the process exit code (0 unless a transfer genuinely failed)."""
    try:
        client = connect()
    except Exception as e:
        print(f"ERROR: could not connect to {HOST}: {e}", file=sys.stderr)
        return 1

    try:
        pulled, skipped, failed = pull_new_backups(client, remote_dir, filename_prefix, dest_dir)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    finally:
        client.close()

    removed = prune_old(dest_dir, filename_prefix, retention_days)

    if verbose or pulled or failed or removed:
        print(f"Pulled: {len(pulled)}  Already present: {len(skipped)}  "
              f"Failed: {len(failed)}  Pruned (>{retention_days}d): {len(removed)}")
        for name in pulled:
            print(f"  + {name}")
        for name, err in failed:
            print(f"  FAILED {name}: {err}", file=sys.stderr)
        for name in removed:
            print(f"  - {name} (pruned)")

    return 1 if failed else 0
