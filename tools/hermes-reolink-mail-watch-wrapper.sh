#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-reolink-mail-watch.service. Fetches MEMORY_TOKEN from Vaultwarden and
# execs the watcher under plain system python3 -- no dedicated venv needed, the script only uses the
# standard library (imaplib, email, smtplib, urllib), same reasoning hermes-embed-worker.py already
# documents for its own plain-python3 placement. The IMAP mailbox credential itself ("Hermes Reolink
# Mail") is fetched by the script directly, same pattern hermes-reolink.py's own
# load_camera_config() uses for the camera credential -- not duplicated here.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-reolink-mail-watch.py"
