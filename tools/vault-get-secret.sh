#!/usr/bin/env bash
# Version: 1.3.0 (2026-08-17 — real bug found live: several processes
# sharing one Unix account (pmoney on spark-1 runs both
# hermes-buzz-watch@sintra and hermes-buzz-watch@amy centrally, plus ad-hoc
# manual calls) can invoke this script concurrently, and the whole
# login/unlock/sync/get/logout/lock sequence has always shared ONE local
# `bw` CLI profile under that user's own $HOME with zero mutual exclusion.
# One process's `bw logout` mid-cycle can silently invalidate another's
# freshly-unlocked session -- confirmed live: `bw unlock`+`bw sync`
# succeeded, then `bw get` returned empty, with a second concurrent `bw
# login --apikey` visible in `ps` at the same moment. This produced a long
# run of "could not fetch ... after 3 attempts" failures across guard
# daemons and watchers the same night the Buzz nudge-gating bug was fixed
# and retried repeatedly. Fixed with a per-user flock around the whole
# fetch (not per-item -- the shared state is the `bw` CLI profile itself,
# not any one vault item): concurrent callers now queue and wait their
# turn instead of racing. Scoped to $HOME rather than a shared system path
# since each Unix account already has its own separate `bw` CLI profile --
# no cross-account contention exists to protect against, so no shared-file
# permission gymnastics are needed either.
#
# Version: 1.2.1 (2026-08-10 — comment-only: sudoers requirement below now
# documents the per-node-scoped rule from infra/vaultwarden/README.md §6a
# instead of an unscoped `systemd-creds decrypt *`, which let this script
# silently decrypt another identity's sealed credentials whenever VAULT_NODE
# wasn't set explicitly and the host-wide /etc/hermes/vault-node-name fallback
# answered for the wrong node — see LESSONS_LEARNED.md §2j. No behavior change.)
#
# Version: 1.2.0 (2026-08-09 — retry the whole login/unlock/sync/get sequence
# up to 3x, with `bw logout` in between attempts. Real, repeatedly-hit
# transient failure mode: a stale local `bw` session/cache can make `bw
# unlock` fail outright with "Cryptography error, the decryption operation
# failed" (not just a spurious empty result) even though the credential is
# fine server-side. Found live 2026-08-09: hermes-fleet-health.py and
# hermes-wiki-checkin-trigger.sh both hit this the same morning — the
# fleet-health email failed to send at all that day, and the day before it
# had misreported the broker as unreachable because of the same root cause.
# At least three other callers (hermes-nfsensei-watch.py, hermes-pfsense
# tooling, hermes_pfsense_common.py) had already independently patched their
# own one-off retry around this exact script instead of it being fixed here
# once — this is that fix, centralized so every caller gets it for free.
#
# Fetch a single field of a single item from the Hermes Fleet Vaultwarden vault.
#
# Usage: vault-get-secret.sh <item-name> [password|username|notes|<custom-field-name>]
#
# Requires, per-node, already in place (see IMPLEMENTATION_PLAN.md §2b):
#   - `bw` CLI installed and `bw config server https://10.129.1.167:8222` already set
#   - /etc/hermes/vw-lan.crt (Vaultwarden's self-signed LAN cert, for NODE_EXTRA_CA_CERTS)
#   - /etc/credstore.encrypted/vaultwarden-<node>-apikey  (systemd-creds sealed: BW_CLIENTID/BW_CLIENTSECRET)
#   - /etc/credstore.encrypted/vaultwarden-<node>-masterpw (systemd-creds sealed: BW_PASSWORD)
#   - /etc/hermes/vault-node-name containing this node's name (sintra|amy), or pass VAULT_NODE explicitly
#   - sudo access to `systemd-creds decrypt /etc/credstore.encrypted/vaultwarden-<node>-*`
#     (NOPASSWD), scoped to this node's own credential files only — see
#     infra/vaultwarden/README.md §6a. Do not use a rule scoped only to the
#     command (`decrypt *`); that lets this script reach another identity's
#     sealed credentials if VAULT_NODE/vault-node-name ever resolve wrong.
#
# Never writes the fetched secret to disk — prints it to stdout only. Callers must not redirect
# the output to a file; treat it as a one-shot, in-memory value for the immediate task.
#
# Carried over unchanged from HermesAgentRedo's tools/vault-get-secret.sh (Category A,
# IMPLEMENTATION_PLAN.md §7) — model-agnostic, node/credential-agnostic, nothing about V4's
# rearchitecture touches this.
set -euo pipefail

ITEM_NAME="${1:?usage: vault-get-secret.sh <item-name> [field]}"
FIELD="${2:-password}"

NODE="${VAULT_NODE:-}"
if [ -z "$NODE" ] && [ -f /etc/hermes/vault-node-name ]; then
  NODE="$(cat /etc/hermes/vault-node-name)"
fi
: "${NODE:?Set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name}"

export NODE_EXTRA_CA_CERTS="${VAULT_CA_CERT:-/etc/hermes/vw-lan.crt}"

# Serialize the whole fetch against any other vault-get-secret.sh call
# running as this same Unix user -- they all share one local `bw` CLI
# profile under $HOME, and concurrent login/unlock/get/logout cycles race
# on it (see 1.3.0 note above). 120s covers this fleet's own documented
# worst-case real Vaultwarden latency (15-90s) plus queuing behind another
# caller's full retry loop.
LOCK_FILE="${HOME}/.hermes/vault-cli.lock"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -w 120 9 || { echo "[vault-get-secret] ERROR: timed out waiting for another vault-get-secret.sh call to finish (lock: $LOCK_FILE)" >&2; exit 1; }

APIKEY_CRED="/etc/credstore.encrypted/vaultwarden-${NODE}-apikey"
MASTERPW_CRED="/etc/credstore.encrypted/vaultwarden-${NODE}-masterpw"

set -a
eval "$(sudo systemd-creds decrypt "$APIKEY_CRED" -)"
eval "$(sudo systemd-creds decrypt "$MASTERPW_CRED" -)"
set +a

fetch_once() {
  bw login --apikey >/dev/null 2>&1 || true
  local session
  session="$(bw unlock --passwordenv BW_PASSWORD --raw 2>/dev/null)" || return 1
  bw sync --session "$session" >/dev/null 2>&1
  case "$FIELD" in
    password|username|notes)
      bw get "$FIELD" "$ITEM_NAME" --session "$session" 2>/dev/null
      ;;
    *)
      bw get item "$ITEM_NAME" --session "$session" 2>/dev/null \
        | jq -r --arg f "$FIELD" '.fields[]? | select(.name==$f) | .value'
      ;;
  esac
}

RESULT=""
for attempt in 1 2 3; do
  RESULT="$(fetch_once || true)"
  [ -n "$RESULT" ] && break
  bw logout >/dev/null 2>&1 || true
  sleep 2
done
bw lock >/dev/null 2>&1 || true

if [ -z "$RESULT" ]; then
  echo "[vault-get-secret] ERROR: could not fetch '$FIELD' from '$ITEM_NAME' after 3 attempts (node=$NODE)" >&2
  exit 1
fi
printf '%s' "$RESULT"
