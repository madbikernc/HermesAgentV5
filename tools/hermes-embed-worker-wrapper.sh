#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-embed-worker.service on HomeD13. Fetches the
# broker token from Vaultwarden and `exec`s the worker, so the token never
# touches disk — identical pattern to tools/hermes-render-worker-wrapper.sh.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"

export BROKER_TOKEN
BROKER_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" broker-token password)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-embed-worker.py"
