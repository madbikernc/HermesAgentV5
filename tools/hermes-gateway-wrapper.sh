#!/usr/bin/env bash
# Version: 1.0.2
#
# 1.0.2 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# script (infra/hermes-gateway/hermes-gateway.service.template) now sets
# VAULT_NODE explicitly per node, so the /etc/hermes/vault-node-name fallback
# below should only ever be hit for ad hoc manual runs, not this service. See
# LESSONS_LEARNED.md §2j. No behavior change.)
#
# Fetches this node's secret credentials from Vaultwarden and execs the real Hermes
# gateway with them injected straight into the process environment — never written to
# disk, not even transiently. This is the systemd unit's ExecStart (see
# infra/hermes-gateway/hermes-gateway.service.template), replacing the earlier pattern
# of `vault-get-secret.sh ... >> ~/.hermes/.env`, which persisted plaintext secrets at
# rest and violated IMPLEMENTATION_PLAN.md §2b.
#
# Non-secret config (hosts, addresses, room IDs, allowed-user lists) stays in
# ~/.hermes/.env as before via Hermes's own dotenv loading — python-dotenv's default
# (override=False) means it never clobbers a variable already present in the process
# environment, so as long as the *_PASSWORD/*_ACCESS_TOKEN/*_API_KEY lines below are
# absent from .env, the values exported here are what the gateway actually sees.
#
# `exec` replaces this script's own process rather than forking, so the secrets never
# exist anywhere but the final gateway process's own environment block.
#
# If any fetch fails (e.g. Vaultwarden unreachable), this script exits non-zero before
# reaching `exec` and systemd's Restart=always/RestartSec=5 keeps retrying until
# Vaultwarden is reachable again — no manual intervention needed once it's back.
#
# Requires the same per-node bootstrap prerequisites as vault-get-secret.sh (see that
# script's header) — this script just calls it once per secret needed.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"
HERMES_PYTHON="${HERMES_PYTHON:-$HOME/.hermes/hermes-agent/venv/bin/python}"

NODE="${VAULT_NODE:-}"
if [ -z "$NODE" ] && [ -f /etc/hermes/vault-node-name ]; then
  NODE="$(cat /etc/hermes/vault-node-name)"
fi
: "${NODE:?Set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name}"

export EMAIL_PASSWORD
EMAIL_PASSWORD="$("$VAULT_GET" "email-$NODE" password)"

export MATRIX_ACCESS_TOKEN
MATRIX_ACCESS_TOKEN="$("$VAULT_GET" "matrix-$NODE" password)"

export TAVILY_API_KEY
TAVILY_API_KEY="$("$VAULT_GET" TAVILY_API_KEY password)"

exec "$HERMES_PYTHON" -m hermes_cli.main gateway run
