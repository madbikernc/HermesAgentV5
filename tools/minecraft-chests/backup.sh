#!/usr/bin/env bash
# Version: 1.0.0
# Snapshot a local Minecraft server world while RCON saves are paused.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mc="$script_dir/mc"

if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != --name=* ]]; }; then
  echo "Usage: backup.sh [--name=LABEL]" >&2
  exit 2
fi
if [[ -z "${MC_WORLD_DIR:-}" || -z "${MC_BACKUP_DIR:-}" ]]; then
  echo "Set MC_WORLD_DIR and MC_BACKUP_DIR to absolute paths." >&2
  exit 2
fi
[[ "$MC_WORLD_DIR" == /* && "$MC_BACKUP_DIR" == /* ]] || { echo "Paths must be absolute." >&2; exit 2; }
[[ -d "$MC_WORLD_DIR" ]] || { echo "World directory does not exist: $MC_WORLD_DIR" >&2; exit 2; }
[[ "$MC_BACKUP_DIR/" != "$MC_WORLD_DIR/"* && "$MC_WORLD_DIR/" != "$MC_BACKUP_DIR/"* ]] || { echo "World and backup directories must not contain one another." >&2; exit 2; }

label=manual
if (( $# == 1 )); then label="${1#--name=}"; fi
[[ "$label" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Backup label must contain only letters, numbers, underscores, or dashes." >&2; exit 2; }

mkdir -p -- "$MC_BACKUP_DIR"
archive="$MC_BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$label.tar.gz"
[[ ! -e "$archive" ]] || { echo "Backup already exists: $archive" >&2; exit 2; }

save_on() { "$mc" 'save-on' >/dev/null; }
"$mc" 'save-all flush'
"$mc" 'save-off'
trap save_on EXIT
tar -C "$(dirname -- "$MC_WORLD_DIR")" -czf "$archive" -- "$(basename -- "$MC_WORLD_DIR")"
trap - EXIT
save_on
echo "$archive"

# Revision History
# 1.0.0 | 2026-09-19 | Initial consistent local world snapshot.
