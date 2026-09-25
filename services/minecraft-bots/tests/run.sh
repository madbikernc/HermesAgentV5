#!/usr/bin/env bash
# Version: 1.0.0
#
# Minecraft bot test runner -- see tests/README.md.
#   tests/run.sh unit        offline fix-validation checks (runs anywhere with node)
#   tests/run.sh live        live scenarios against the bot-sandbox server (Spark nodes only)
#   tests/run.sh baseline    this host's last-24h behavior vs tests/baselines/<host>.json
#   tests/run.sh all         unit, then live (if this host can reach the server), then baseline
# Extra arguments after the suite name are passed to it (e.g. `run.sh live combat`).
#
# Reports: with MB_TEST_REPORT_DIR set, output is also written to <dir>/<suite>-<host>-<ts>.log.
#
# Revision History: 1.0.0 | 2026-09-24 | Initial runner.
set -uo pipefail
cd "$(dirname "$0")/.."

suite="${1:-all}"; shift || true
host="$(hostname)"
status=0

run() {
  local name="$1"; shift
  echo "=== $name ($(date -Is), $host, $(git rev-parse --short HEAD 2>/dev/null || echo '?'))"
  if [ -n "${MB_TEST_REPORT_DIR:-}" ]; then
    mkdir -p "$MB_TEST_REPORT_DIR"
    "$@" 2>&1 | tee "$MB_TEST_REPORT_DIR/$name-$host-$(date +%Y%m%dT%H%M%S).log"
  else
    "$@"
  fi
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || status=1
  return 0
}

case "$suite" in
  unit)     run unit node tests/unit.test.mjs "$@" ;;
  live)     run live node tests/live.test.mjs "$@" ;;
  baseline) run baseline node tests/baseline.mjs "$@" ;;
  all)
    run unit node tests/unit.test.mjs
    if [ -d node_modules/mineflayer ] && timeout 3 bash -c "</dev/tcp/${MC_HOST:-192.168.1.221}/${MC_PORT:-25580}" 2>/dev/null; then
      run live node tests/live.test.mjs
    else
      echo "=== live: skipped (no node_modules or bot server unreachable from $host)"
    fi
    if command -v journalctl >/dev/null && [ -f "tests/baselines/$host.json" ]; then
      run baseline node tests/baseline.mjs
    else
      echo "=== baseline: skipped (no journal or no tests/baselines/$host.json)"
    fi
    ;;
  *) echo "usage: $0 {unit|live|baseline|all} [args]"; exit 2 ;;
esac
exit $status
