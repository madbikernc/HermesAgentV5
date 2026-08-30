#!/usr/bin/env bash
# Version: 1.3.1
#
# 1.3.1 — real bug found live immediately after 1.3.0 deployed, verifying
# it: Amy's ssh backup only ever produced 1 of her 6 real files. Classic
# bash pitfall — `back_up_ssh_ssh`'s `while read f; do ... ssh "$ssh_host"
# "cat '$f'" ...; done < <(ssh "$ssh_host" find ...)` has an `ssh` call
# *inside* a loop that's reading its own input from a pipe, and `ssh`
# forwards local stdin to the remote command by default, silently draining
# the rest of the file list out of the outer loop after the first
# iteration. Sintra's local variant never had this problem — `sudo -u cat
# "$f"` with an explicit filename argument never touches stdin at all, so
# there was nothing to drain. Fixed with `ssh -n`, which is the standard
# fix for exactly this shape of bug: stops ssh from touching local stdin
# at all.
#
# 1.3.0 — real gap found live, 2026-08-17, direct question ("is Amy and
# Spark-2 setup to backup correctly") right after 1.2.0 shipped: the answer
# was "her conversation state, yes — her *access* to GitHub, no." Amy's
# original deploy key was permanently lost earlier the same night precisely
# because the pre-relocation backup only ever covered `~/.hermes`, never
# `~/.ssh` — and the replacement key generated to fix that had exactly the
# same zero coverage, meaning a lost spark-2 disk today would trigger the
# identical multi-step recovery (new keypair, remove the orphaned GitHub
# entry, reconcile the checkout) all over again. Added `back_up_ssh_local`/
# `back_up_ssh_ssh`, backing up every regular file in `~/.ssh` (not a fixed
# filename list like the .hermes trio below — a key's filename isn't
# standardized the way state.db/config.yaml/.env are, and pmoney's own
# equivalent key for reaching Amy is `spark2_deploy`, not the same name as
# her own `hermesagentredo_deploy`) into a `ssh/` subdirectory, mode 700/600
# throughout since a private key is exactly the kind of thing this backup
# exists to protect. Same identity-appropriate local/SSH split as the
# .hermes backup, same reasoning.
#
# 1.2.0 — real gap found live, 2026-08-17, during a routine fleet-health
# check ("check their current status") long after Amy's persona relocated
# to spark-2 (Stage 7, §6): this script still tried `sudo -u amy` against a
# local Unix account that no longer exists on this host, failing with
# `sudo: unknown user amy` on every single run since the relocation — the
# exact same "migration moved the primary thing but missed a satellite
# script" pattern already hit for `session-guardian`/`fabrication-guard`
# and for `hermes-repo-sync.sh`'s own reach-Amy gap this same night, just
# not caught until a health check specifically looked. Amy's `.hermes`
# state had zero NAS backup coverage for as long as she's been on spark-2.
# Fixed by giving her the same SSH-based treatment `hermes-repo-sync.sh`'s
# `sync_amy()` already uses (pmoney's own `Host spark2-amy` alias) instead
# of `sudo -u` — she owns her files directly over that connection, no sudo
# needed at all, unlike the local sintra path which still requires it
# since pmoney can't traverse into her drwx------ home directory.
#
# 1.1.0 — reads each identity's files via `sudo -u <identity>` instead of a
# direct filesystem read, after /home/sintra and /home/amy were locked to
# drwx------ by the per-identity Unix user migration and this script wasn't
# updated to match, causing 2026-08-03's real (silent, "0 files found") daily
# failures. See the header note below and LESSONS_LEARNED.md §7.
#
# Phase 12 (IMPLEMENTATION_PLAN.md §7): daily backup of what's actually
# irreplaceable on the Spark if its disk dies. Re-scoped from v1's design
# (scripts/sensitive-file-backup.sh, HermesAgent/skills/sensitive-file-backup):
# v1 scanned broadly for any file that might hold a plaintext secret
# (.env, auth.json, *.pem, id_rsa, ...) because that's genuinely where its
# secrets lived. This project's own constraint (§2b, "Credentials live in
# Vaultwarden") means that class of file mostly doesn't exist here anymore —
# real secrets are fetched fresh on every use, never written to disk. What's
# actually irreplaceable now is much narrower: each identity's state.db
# (real conversation history, not regenerable) and config.yaml/.env
# (environment-specific, reconstructable but not trivially). SOUL.md is
# deliberately excluded — it's already tracked in this repo and pushed to
# GitHub, a real off-site copy that doesn't need a second one here.
#
# Runs as pmoney, reading each identity's files via `sudo -u <identity>`
# rather than direct filesystem access — neither identity can read the
# other's home directory, by design, and (as of the per-identity Unix user
# migration) pmoney can't either: /home/sintra and /home/amy are both
# drwx------, not traversable by pmoney at all. This script originally did
# a direct `cp "$home/.hermes/..."`, which worked before that hardening and
# then failed silently (0 files "found", not a permission error visibly
# surfaced) after it — same "migration moved the primary thing but missed a
# satellite script" pattern already hit twice in LESSONS_LEARNED.md §7
# (session-guardian, fabrication-guard). Fixed to use the same
# `sudo -u <identity>` pattern hermes-fleet-health.py and
# hermes-node-health.py already use correctly for the same reason.
#
# Stage 0 took a one-time snapshot of this same class of data
# (Private/Hermes/Spark_Backup/hermes-spark-<date>.zip) as a migration
# prerequisite. That snapshot is not touched or superseded by this script —
# it predates most of what's been built since and is kept as a historical
# point-in-time reference, not a live backup.
#
# Requires: the Spark's own NFS mount to NAS2 at /mnt/nas2-hermes-backup
# (soft, bounded timeout — see LESSONS_LEARNED.md §7, a hard mount blocks
# indefinitely if the NAS goes away).
set -uo pipefail

NFS_ROOT="/mnt/nas2-hermes-backup/Private/Hermes/Spark_Backup"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DATE="$(date +%Y-%m-%d)"
AMY_SSH="spark2-amy"
LOG() { echo "[hermes-nfs-backup] $*"; }

if ! mountpoint -q /mnt/nas2-hermes-backup; then
  LOG "ERROR: /mnt/nas2-hermes-backup is not mounted, skipping this run"
  exit 1
fi

finish_backup() {
  local identity="$1" dest="$2" day_dest="$3" copied="$4"
  if [ "$copied" -eq 0 ]; then
    LOG "WARNING: nothing found to back up for $identity"
    rmdir "$day_dest" 2>/dev/null || true
    return 1
  fi
  LOG "$identity: backed up $copied file(s) to $day_dest"
  # Retention: delete dated subdirectories older than RETENTION_DAYS.
  find "$dest" -maxdepth 1 -type d -name '20*-*-*' -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} \; \
    | while read -r old; do LOG "$identity: pruned old backup $old"; done
  return 0
}

back_up_identity_local() {
  local identity="$1"
  local home="/home/$identity"
  local dest="$NFS_ROOT/$identity"
  mkdir -p "$dest"
  local day_dest="$dest/$DATE"
  mkdir -p "$day_dest"

  local copied=0
  for f in "$home/.hermes/state.db" "$home/.hermes/config.yaml" "$home/.hermes/.env"; do
    if sudo -u "$identity" test -f "$f"; then
      local dest_file="$day_dest/$(basename "$f")"
      # Read as the owning identity (sudo -u), not a direct filesystem read —
      # pmoney can't traverse into /home/<identity> at all, see header note.
      # `cat` through sudo rather than `cp`, since `cp` run via sudo would
      # create the destination file as root, not pmoney, on some sudoers
      # configs; `cat`'s stdout redirect happens in pmoney's own shell so the
      # destination file is always pmoney-owned. Explicit chmod 600 right
      # after, same reasoning as before: a trailing glob chmod pass would
      # silently skip dotfiles like .env under bash's default globbing.
      if sudo -u "$identity" cat "$f" > "$dest_file" 2>/dev/null; then
        chmod 600 "$dest_file" && copied=$((copied + 1))
      else
        rm -f "$dest_file"
      fi
    fi
  done
  finish_backup "$identity" "$dest" "$day_dest" "$copied"
}

# Amy — separate host since Stage 7 (§6), reached over SSH as her own
# account (no sudo needed, she owns her files directly) rather than
# `sudo -u`, which stopped meaning anything the moment her Unix account
# left this host. Same SSH alias hermes-repo-sync.sh's sync_amy() uses.
back_up_identity_ssh() {
  local identity="$1" ssh_host="$2" remote_home="$3"
  local dest="$NFS_ROOT/$identity"
  mkdir -p "$dest"
  local day_dest="$dest/$DATE"
  mkdir -p "$day_dest"

  local copied=0
  for f in "$remote_home/.hermes/state.db" "$remote_home/.hermes/config.yaml" "$remote_home/.hermes/.env"; do
    local dest_file="$day_dest/$(basename "$f")"
    if ssh "$ssh_host" "test -f '$f' && cat '$f'" > "$dest_file" 2>/dev/null && [ -s "$dest_file" ]; then
      chmod 600 "$dest_file" && copied=$((copied + 1))
    else
      rm -f "$dest_file"
    fi
  done
  finish_backup "$identity" "$dest" "$day_dest" "$copied"
}

# ~/.ssh backup — every regular file, not a fixed name list (a key's
# filename isn't standardized project-wide). Its own subdirectory, kept at
# 700/600 throughout since a private key lives in here, not just
# environment-specific config.
back_up_ssh_local() {
  local identity="$1"
  local ssh_dir="/home/$identity/.ssh"
  local dest="$NFS_ROOT/$identity"
  local day_dest="$dest/$DATE/ssh"
  mkdir -p "$day_dest"
  chmod 700 "$day_dest"

  local copied=0
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    local dest_file="$day_dest/$(basename "$f")"
    if sudo -u "$identity" cat "$f" > "$dest_file" 2>/dev/null; then
      chmod 600 "$dest_file" && copied=$((copied + 1))
    else
      rm -f "$dest_file"
    fi
  done < <(sudo -u "$identity" find "$ssh_dir" -maxdepth 1 -type f 2>/dev/null)
  finish_backup "$identity (ssh)" "$dest" "$day_dest" "$copied"
}

back_up_ssh_ssh() {
  local identity="$1" ssh_host="$2" remote_home="$3"
  local dest="$NFS_ROOT/$identity"
  local day_dest="$dest/$DATE/ssh"
  mkdir -p "$day_dest"
  chmod 700 "$day_dest"

  local copied=0
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    local dest_file="$day_dest/$(basename "$f")"
    # -n: stops ssh from touching local stdin at all -- without it, this
    # call silently drains the rest of the outer loop's own input (the
    # process substitution below), since ssh forwards local stdin to the
    # remote command by default. See 1.3.1 note above.
    if ssh -n "$ssh_host" "cat '$f'" > "$dest_file" 2>/dev/null && [ -s "$dest_file" ]; then
      chmod 600 "$dest_file" && copied=$((copied + 1))
    else
      rm -f "$dest_file"
    fi
  done < <(ssh "$ssh_host" "find '$remote_home/.ssh' -maxdepth 1 -type f" 2>/dev/null)
  finish_backup "$identity (ssh)" "$dest" "$day_dest" "$copied"
}

overall_rc=0
back_up_identity_local sintra || overall_rc=1
back_up_ssh_local sintra || overall_rc=1
back_up_identity_ssh amy "$AMY_SSH" "/home/amy" || overall_rc=1
back_up_ssh_ssh amy "$AMY_SSH" "/home/amy" || overall_rc=1

exit $overall_rc
