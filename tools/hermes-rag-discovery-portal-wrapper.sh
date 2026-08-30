#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-rag-discovery-portal.service. Fetches the
# portal's Basic Auth credential from Vaultwarden, exports it as a real
# process environment variable, then `exec`s the portal — replacing this
# shell rather than forking, so the credential exists only in the final
# process's environment block and never touches disk. Same pattern as
# tools/hermes-broker-wrapper.sh (IMPLEMENTATION_PLAN.md §2b), for the same
# reason.
#
# Requires a Vaultwarden item named "rag-discovery-portal" (username +
# password fields) — one-time manual setup, same as every other credential
# this project's tools fetch (see vault-get-secret.sh's own usage comment).
# Not created by this script or any tool: creating vault items is a Boss
# action, per §2b.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export PORTAL_USER
PORTAL_USER="$("$VAULT_GET" rag-discovery-portal username)"
export PORTAL_PASSWORD
PORTAL_PASSWORD="$("$VAULT_GET" rag-discovery-portal password)"

exec /opt/hermes/venvs/rag/bin/python3 "$REPO_DIR/tools/hermes-rag-discovery-portal.py"
