#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — real bug found on this agent's very first live run: exec'd
# /usr/bin/python3, which has no sqlite_vec, so the very first claimed task failed with "No
# module named 'sqlite_vec'". Fixed to exec the RAG venv's interpreter, same one every other
# rag-* systemd unit already uses.
#
# systemd ExecStart for hermes-retrieve.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, and
# GUARD_TOKEN from Vaultwarden, exports them, then `exec`s the retrieval agent — same
# fetch-then-exec pattern every other Buzz-subscriber service in this fleet already uses.
#
# Runs under the RAG venv, not the system interpreter — hermes_rag_common.py needs sqlite_vec,
# which only exists there (same interpreter hermes-rag-ingest-docs.service and every other
# rag-* unit already uses). Real bug found on this agent's very first live run: it started fine
# under /usr/bin/python3, then failed its first real claim with "No module named 'sqlite_vec'".
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

if GUARD_TOKEN="$("$VAULT_GET" guard-token password 2>/dev/null)"; then
  export GUARD_TOKEN
else
  echo "[hermes-retrieve-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

exec /opt/hermes/venvs/rag/bin/python3 "$REPO_DIR/tools/hermes-retrieve.py"
