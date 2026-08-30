#!/usr/bin/env bash
# Version: 1.0.1 (2026-08-10 — comment-only: sudoers requirement below now
# documents the per-node-scoped rule from infra/vaultwarden/README.md §6a
# instead of an unscoped `systemd-creds decrypt *`. See vault-get-secret.sh
# 1.2.1's header and LESSONS_LEARNED.md §2j for why. No behavior change.)
#
# Write-capable companion to tools/vault-get-secret.sh. Sets one custom field on an
# existing item in the Hermes Fleet Vaultwarden vault (Phase 21, IMPLEMENTATION_PLAN.md
# §7 — the first tool in this project to write back to Vaultwarden rather than only
# read from it, built so a token-yielding integration like Wyze can cache what it gets
# from a real login instead of re-authenticating on every invocation).
#
# Usage: value on stdin, never as an argv value (same reasoning vault-get-secret.sh
# already applies to the vault's own master password via --passwordenv rather than a
# positional arg — argv is visible to other local users via `ps`, stdin is not):
#
#   printf '%s' "$TOKEN" | vault-set-secret.sh <item-name> <field-name>
#
# The target item must already exist (created directly in Vaultwarden, same as every
# credential this project stores) — this only sets/replaces one custom field on it,
# never creates or renames an item. If a field with that name already exists, its
# value is replaced; otherwise a new hidden-type custom field is appended.
#
# Requires the same per-node setup as vault-get-secret.sh (see that script's header):
# `bw` CLI configured, sealed apikey/masterpw creds, VAULT_NODE or
# /etc/hermes/vault-node-name, a sudoers rule scoped to this node's own
# credential files (infra/vaultwarden/README.md §6a), and jq.
set -euo pipefail

ITEM_NAME="${1:?usage: vault-set-secret.sh <item-name> <field-name> (value on stdin)}"
FIELD="${2:?usage: vault-set-secret.sh <item-name> <field-name> (value on stdin)}"
VALUE="$(cat -)"
: "${VALUE:?no value read from stdin}"

NODE="${VAULT_NODE:-}"
if [ -z "$NODE" ] && [ -f /etc/hermes/vault-node-name ]; then
  NODE="$(cat /etc/hermes/vault-node-name)"
fi
: "${NODE:?Set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name}"

export NODE_EXTRA_CA_CERTS="${VAULT_CA_CERT:-/etc/hermes/vw-lan.crt}"

APIKEY_CRED="/etc/credstore.encrypted/vaultwarden-${NODE}-apikey"
MASTERPW_CRED="/etc/credstore.encrypted/vaultwarden-${NODE}-masterpw"

set -a
eval "$(sudo systemd-creds decrypt "$APIKEY_CRED" -)"
eval "$(sudo systemd-creds decrypt "$MASTERPW_CRED" -)"
set +a

bw login --apikey >/dev/null 2>&1 || true
SESSION="$(bw unlock --passwordenv BW_PASSWORD --raw)"
bw sync --session "$SESSION" >/dev/null

ITEM_JSON="$(bw get item "$ITEM_NAME" --session "$SESSION")"
ITEM_ID="$(echo "$ITEM_JSON" | jq -r '.id')"

UPDATED_JSON="$(echo "$ITEM_JSON" | jq --arg f "$FIELD" --arg v "$VALUE" '
  .fields = ((.fields // []) | map(select(.name != $f))) + [{name: $f, value: $v, type: 1, linkedId: null}]
')"

echo "$UPDATED_JSON" | bw encode | bw edit item "$ITEM_ID" --session "$SESSION" >/dev/null

bw lock >/dev/null 2>&1 || true
