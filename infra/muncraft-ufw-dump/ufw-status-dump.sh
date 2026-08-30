#!/bin/bash
# Version: 1.0.0
#
# Dumps `ufw status verbose` to a file zomboid-admin (secondary member of
# the muncraft group) can read, so hermes-game-server-monitor.py's
# check_firewall() can review the real ruleset without needing any new
# sudo grant or credential for that account. This is the only place UFW's
# actual rule data crosses from root to a lower-privileged account, and
# it's read-only (firewall status text) — it grants zomboid-admin no new
# *capability*, just visibility into config it previously couldn't see.
#
# Runs as root via ufw-status-dump.timer (every 15 min) — see
# ../hermes-game-server-monitor/README.md for why zomboid-admin couldn't
# just be granted `sudo ufw status verbose` directly: this project's own
# 2026-08-12 call was to leave that path closed rather than widen an
# existing service account's sudo grant, so this dump-file approach was
# built instead.
set -euo pipefail

OUT=/opt/zomboid/server/.ufw-status.txt
TMP="$OUT.tmp"

/usr/sbin/ufw status verbose > "$TMP"
chown root:muncraft "$TMP"
chmod 640 "$TMP"
mv "$TMP" "$OUT"
