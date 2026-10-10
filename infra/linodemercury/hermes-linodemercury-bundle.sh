#!/bin/bash
# Daily bundler: rolls up whatever local scan output currently exists into one
# compressed tarball, so the Fleet's one-way daily pull is a single file instead
# of several round trips. Consumes (moves, not copies) each raw file it rolls up
# -- their content now lives only in the bundle. Bundles are NOT deleted here on
# any schedule: retention is Fleet-driven (see the watcher on spark), so a missed
# retrieval day never loses data to a blind local rotation.
set -uo pipefail
DATE=$(date +%Y-%m-%d)
SRC=/var/log/hermes-linodemercury
BUNDLE_DIR=/var/local/hermes-bundle
CURSOR=/var/local/hermes-bundle/.sshd-journal-cursor
WORK=$(mktemp -d)
mkdir -p "$BUNDLE_DIR" "$SRC"

apt list --upgradable 2>/dev/null > "$WORK/apt-upgradable.txt"
ufw status verbose > "$WORK/ufw-status.txt" 2>&1

# --cursor-file alone (no --since) is deliberate: journalctl refuses --since and
# --cursor-file together, and --cursor-file's own documented first-run behavior
# (start at the earliest available entry) is exactly what's wanted here -- bounded
# by Phase 1's journald MaxRetentionSec=90day, not unbounded.
#
# Both _COMM=sshd (the listener's own lifecycle messages) and _COMM=sshd-session are
# matched -- confirmed live on this box (Debian 13 / OpenSSH 10.0) that connection
# handling, including the only reliably-logged evidence of a session at all
# ("Disconnected from user X from IP port N"), runs under the newer privsep
# re-exec child's own comm, sshd-session, not the classic single "sshd" comm older
# guides assume. journalctl ORs multiple matches on the same field automatically.
journalctl _COMM=sshd _COMM=sshd-session --cursor-file="$CURSOR" --no-pager > "$WORK/sshd-journal.log" 2>&1

for f in aide-check.log sbom.json grype.json syft.err grype.err; do
  if [ -f "$SRC/$f" ]; then
    mv "$SRC/$f" "$WORK/$f"
  fi
done
for f in /var/log/lynis-report.dat /var/log/lynis.log; do
  if [ -f "$f" ]; then
    mv "$f" "$WORK/$(basename "$f")"
  fi
done

tar -C "$WORK" -czf "$BUNDLE_DIR/linodemercury-${DATE}.tar.gz" .
rm -rf "$WORK"
exit 0
