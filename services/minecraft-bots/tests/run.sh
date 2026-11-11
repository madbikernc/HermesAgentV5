#!/usr/bin/env bash
# Version: 1.4.0
#
# 1.4.0 (2026-11-10): unit and all also run tests/link-check.mjs where node_modules exists -- every
# import of index.js and the modules split out of it resolves, checked without running a bot.
#
# Minecraft bot test runner -- see tests/README.md.
#   tests/run.sh unit        offline fix-validation checks (runs anywhere with node)
#   tests/run.sh live        action-level live scenarios against the bot-sandbox server (Spark nodes)
#   tests/run.sh livebot     full-bot live scenarios (a real index.js as MBProbe; Spark nodes)
#   tests/run.sh baseline    this host's last-24h behavior vs tests/baselines/<host>.json, plus
#                            monitoring coverage (every bot unit mirrored and triaged)
#   tests/run.sh all         unit, then live + livebot (if the server is reachable), then baseline
# Extra arguments after the suite name are passed to it (e.g. `run.sh live combat`).
#
# Reports: with MB_TEST_REPORT_DIR set, output is also written to <dir>/<suite>-<host>-<ts>.log.
#
# Revision History: 1.0.0 | 2026-09-24 | Initial runner.
# 1.1.0 | 2026-09-25 | triage unit checks, livebot suite, monitoring coverage in baseline.
# 1.2.0 | 2026-09-25 | RAG server checks in the unit suite.
# 1.3.0 (2026-11-07) -- S47: infra/minecraft-bots-tests split one shared-timeout unit into a
# fast->live->livebot->baseline chain (each phase's own TimeoutStartSec, sized to what that
# phase actually takes -- live+livebot alone had grown to consume the old single 60min budget
# with no slack left for baseline). Standalone `live`/`livebot` invocations now share the same
# server-reachability guard `all` already had (server_up()), instead of only `all` skipping
# gracefully when the bot-sandbox server is down.
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

server_up() {
  [ -d node_modules/mineflayer ] && timeout 3 bash -c "</dev/tcp/${MC_HOST:-192.168.1.221}/${MC_PORT:-25580}" 2>/dev/null
}

linkcheck() { if [ -d node_modules ]; then run linkcheck node --experimental-vm-modules --no-warnings tests/link-check.mjs; else echo "=== linkcheck: skipped (no node_modules)"; fi; }

case "$suite" in
  unit)     run unit node tests/unit.test.mjs "$@"; linkcheck; run triage python3 tests/test_triage.py; run ragserver python3 tests/test_rag_server.py ;;
  live)     if server_up; then run live node tests/live.test.mjs "$@"; else echo "=== live: skipped (no node_modules or bot server unreachable from $host)"; fi ;;
  livebot)  if server_up; then run livebot node tests/live-bot.test.mjs "$@"; else echo "=== livebot: skipped (no node_modules or bot server unreachable from $host)"; fi ;;
  baseline) run baseline node tests/baseline.mjs "$@"; run monitoring node tests/monitoring.mjs ;;
  all)
    run unit node tests/unit.test.mjs
    linkcheck
    run triage python3 tests/test_triage.py
    run ragserver python3 tests/test_rag_server.py
    if server_up; then
      run live node tests/live.test.mjs
      run livebot node tests/live-bot.test.mjs
    else
      echo "=== live: skipped (no node_modules or bot server unreachable from $host)"
    fi
    if command -v journalctl >/dev/null && [ -f "tests/baselines/$host.json" ]; then
      run baseline node tests/baseline.mjs
      run monitoring node tests/monitoring.mjs
    else
      echo "=== baseline: skipped (no journal or no tests/baselines/$host.json)"
    fi
    ;;
  *) echo "usage: $0 {unit|live|livebot|baseline|all} [args]"; exit 2 ;;
esac
exit $status
