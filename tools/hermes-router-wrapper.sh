#!/usr/bin/env bash
# Version: 2.2.1
#
# 2.2.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 2.2.0 (2026-08-29) — HermesAgentV5 S5: also fetches `guard-token` (Layer 2,
# hermes-guard.py) and `memory-token` (hermes-memory.py, so guard verdicts can be logged there).
# Both optional at this fetch layer, same graceful-degradation shape every other token here
# already has — hermes-router.py itself decides what's skipped when either is absent.
#
# 2.1.0 (2026-08-28) — Direct request: also fetches `email-sintra`'s password and exports it as
# EMAIL_PASSWORD, so hermes-router.py 2.4.0 can send an email alert on an injection-guard block.
# Same vault item hermes-fleet-health.py's daily digest already uses — nothing new provisioned.
# Fetched once here rather than per-call inside hermes-router.py, same reason FLEETOPS_MATRIX_TOKEN
# and BROKER_TOKEN already are: this is a resident daemon handling live traffic continuously, not
# a one-shot script where a per-invocation vault-get-secret.sh call would be free.
#
# systemd ExecStart for hermes-router.service. Fetches the FleetOps Matrix credentials and the
# broker token from Vaultwarden and execs the router — same pattern as
# tools/hermes-broker-wrapper.sh, for the same reason (IMPLEMENTATION_PLAN.md §2b). The router
# needs no bearer token of its own for its caller-facing side; it's internal-only (127.0.0.1).
# FleetOps delivery needs a secret, and (new in 2.0.0) so does submitting a wake job to the
# broker for an on-demand role (§6 Stage 2) — same vault item every other broker caller in this
# fleet already uses, nothing new provisioned.
#
# HERMES_NODE is NOT fetched from Vaultwarden — it's not a secret, it's which of the two
# identical copies of this file is running, set directly in each node's own systemd unit
# (Environment=HERMES_NODE=spark or HERMES_NODE=spark-2). Carried over unchanged from
# HermesAgentRedo's hermes-router-wrapper.sh 1.0.0 except for that addition and the broker
# token fetch.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

if FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password 2>/dev/null)"; then
  export FLEETOPS_MATRIX_TOKEN
  FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room 2>/dev/null || true)"
  [ -n "${FLEETOPS_ROOM:-}" ] && export FLEETOPS_ROOM
else
  echo "[hermes-router-wrapper] matrix-fleetops not in vault — starting without real-time notices" >&2
fi

if BROKER_TOKEN="$("$VAULT_GET" broker-token password 2>/dev/null)"; then
  export BROKER_TOKEN
else
  echo "[hermes-router-wrapper] hermes-broker token not in vault — on-demand roles (super) will" \
       "fail to wake until this is fixed; always-resident roles are unaffected" >&2
fi

if EMAIL_PASSWORD="$("$VAULT_GET" email-sintra password 2>/dev/null)"; then
  export EMAIL_PASSWORD
else
  echo "[hermes-router-wrapper] email-sintra not in vault — injection-guard block emails will be" \
       "skipped; FleetOps notices and blocking itself are unaffected" >&2
fi

if GUARD_TOKEN="$("$VAULT_GET" guard-token password 2>/dev/null)"; then
  export GUARD_TOKEN
else
  echo "[hermes-router-wrapper] guard-token not in vault — Layer 2 screening disabled;" \
       "Layer 1 alone is active" >&2
fi

if MEMORY_TOKEN="$("$VAULT_GET" memory-token password 2>/dev/null)"; then
  export MEMORY_TOKEN
else
  echo "[hermes-router-wrapper] memory-token not in vault — guard verdicts enforced but not" \
       "logged to hermes-memory" >&2
fi

: "${HERMES_NODE:?HERMES_NODE must be set in the systemd unit for this service (spark or spark-2)}"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-router.py"
