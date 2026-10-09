#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-fleetops-ui.service. Fetches this service's own Basic Auth
# credential from Vaultwarden and execs the UI -- the same wrapper pattern every other
# credentialed service in this fleet uses.
#
# Its own vault item, deliberately not a reuse of the RAG portal's: one item per service is the
# convention here (`memory-token`, `buzz-token`, `email-sintra`), and a shared Basic Auth realm
# across two independently-reasoned-about services would mean one leaked credential opens both.
#
# This is the whole credential set. The UI reads four stores and the router, all of them
# unauthenticated-by-bind on this host, and holds no token that could write to any of them.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export FLEETOPS_UI_USER
FLEETOPS_UI_USER="$("$VAULT_GET" fleetops-ui username)"

export FLEETOPS_UI_PASSWORD
FLEETOPS_UI_PASSWORD="$("$VAULT_GET" fleetops-ui password)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-fleetops-ui.py" "$@"
