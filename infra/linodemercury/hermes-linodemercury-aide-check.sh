#!/bin/bash
# Weekly AIDE integrity check, output captured locally only. Always exits 0 --
# aide --check's own exit status is a bitmask (non-zero means "found
# new/changed entries", not "crashed"); interpretation happens on spark's
# side when it parses this log, not here.
OUT=/var/log/hermes-linodemercury
mkdir -p "$OUT"
aide --check --config /etc/aide/aide.conf > "$OUT/aide-check.log" 2>&1
rc=$?
echo "exit_code=$rc" >> "$OUT/aide-check.log"
exit 0
