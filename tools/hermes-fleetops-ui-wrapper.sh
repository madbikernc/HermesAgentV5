#!/usr/bin/env bash
# Version: 2.0.0
#
# systemd ExecStart for hermes-fleetops-ui.service. Fetches this service's own Basic Auth
# credential from Vaultwarden and execs the UI -- the same wrapper pattern every other
# credentialed service in this fleet uses.
#
# Its own vault item, deliberately not a reuse of the RAG portal's: one item per service is the
# convention here (`memory-token`, `buzz-token`, `email-sintra`), and a shared Basic Auth realm
# across two independently-reasoned-about services would mean one leaked credential opens both.
#
# As of 2.0.0 it also carries WRITE credentials, which 1.0.0 deliberately did not: the shared
# hermes-memory token and the FleetOps Matrix credential, for the backlog's decide buttons. Both
# already exist as vault items -- no new secret was minted -- but the blast radius is genuinely
# larger and is stated rather than buried: `memory-token` is the fleet's single shared token and is
# not scoped to model-scout tasks by the server, so the scoping is done in the UI's own code (one
# transition, from the gate's table, on a model-scout task, after re-reading its state).
#
# Both are fetched with `|| true`: the reports are the bulk of this service and need no token at
# all, so a vault hiccup must degrade the decide buttons rather than take the whole page down.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export FLEETOPS_UI_USER
FLEETOPS_UI_USER="$("$VAULT_GET" fleetops-ui username)"

export FLEETOPS_UI_PASSWORD
FLEETOPS_UI_PASSWORD="$("$VAULT_GET" fleetops-ui password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password || true)"

export FLEETOPS_MATRIX_TOKEN
FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password || true)"

export FLEETOPS_ROOM
FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room || true)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-fleetops-ui.py" "$@"
