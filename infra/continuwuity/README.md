# Continuwuity setup — recreate checklist

**Version:** 1.0.1

Ordered steps to stand up the Matrix homeserver and connect both Hermes nodes to it. For the full
narrative — why native Hermes Matrix support meant no custom plugin was needed, the account/room design
rationale, the two post-launch gotchas (pairing gate, home-channel nag) — see `LESSONS_LEARNED.md` §7
and §5 in the repo root. This file is the recipe; those sections are the reasoning.

Runs on one node only (the plan's convention: Sintra's node). Every command below assumes that node unless
stated otherwise.

## 1. Install the binary

Recent GitHub releases of `continuwuity/continuwuity` don't ship binary assets (moved to container images) —
use the last tagged release that does, checking https://github.com/continuwuity/continuwuity/releases for
`conduwuit-linux-<arch>` (the binary keeps its pre-rename name). Verify it's a real ELF binary before
running it, then install:

```bash
curl -fsSL -o conduwuit https://github.com/continuwuity/continuwuity/releases/download/<tag>/conduwuit-linux-<arch>
file conduwuit          # confirm: ELF ... executable
chmod +x conduwuit

sudo useradd -r -s /sbin/nologin continuwuity
sudo mkdir -p /opt/continuwuity /var/lib/continuwuity /etc/continuwuity
sudo chown continuwuity:continuwuity /var/lib/continuwuity
sudo cp conduwuit /opt/continuwuity/continuwuity
sudo chmod +x /opt/continuwuity/continuwuity
```

On Ubuntu/Debian you'll also need `liburing2` (io_uring userspace lib) — not installed by default:

```bash
sudo apt-get install -y liburing2
```

## 2. Configure and start

```bash
sudo cp continuwuity.toml.template /etc/continuwuity/continuwuity.toml
# Edit: server_name, registration_token (openssl rand -base64 32 | tr -d '/+=' | head -c 40),
# and well_known.client once you know this node's Tailscale hostname.

sudo cp continuwuity.service /etc/systemd/system/continuwuity.service
sudo systemctl daemon-reload
sudo systemctl enable --now continuwuity
sudo systemctl status continuwuity   # expect: active (running), ~30-80MB memory

curl -s http://localhost:6167/_matrix/client/versions   # expect real JSON, not a connection error
```

## 3. Scope the firewall

Same pattern as every other service in this project — LAN-only by default:

```bash
sudo ufw allow from 10.129.1.0/24 to any port 6167 comment 'Continuwuity Matrix'
```

## 4. Register accounts, then lock registration

One per agent identity, one for the operator, one separate admin identity — see
`IMPLEMENTATION_PLAN.md` §4e/§5 for exactly why these are kept separate (the agent must never hold
admin-room credentials).

```bash
TOKEN="<registration_token from the config>"
URL="http://localhost:6167"

for user in sintra amy admin phone1; do
  pass="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
  resp="$(curl -s -X POST "$URL/_matrix/client/v3/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$pass\",\"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$TOKEN\"}}")"
  echo "$resp" > "/tmp/matrix_${user}.json"   # contains access_token + user_id -- see step 5
done
```

Then immediately lock it back down:

```bash
sudo sed -i 's/allow_registration = true/allow_registration = false/' /etc/continuwuity/continuwuity.toml
sudo systemctl restart continuwuity
```

## 5. Distribute credentials — per-node, never shared

**Agent accounts (`sintra`, `amy`) go into Vaultwarden**, fetched by each node via
`tools/vault-get-secret.sh` — never left as local files. Extract `user_id`/`access_token` from each
account's `/tmp/matrix_<user>.json` and create a Login-type Vaultwarden item (username=`user_id`,
password=`access_token`, a custom field for the homeserver URL) in a collection both machine accounts can
reach, then delete the temp file.

**`admin`/`phone1` go to The Boss directly, never through either agent's Vaultwarden access** — per §5
constraint 3 (the agent must never hold standing admin-room credentials). Leave those two temp files
root/owner-readable-only until retrieved, then delete them. Don't create a Vaultwarden item for these via
either agent's own session — that session's org-shared collections are visible to *both* agents by design in
this project, which would defeat the point.

## 6. Create the rooms — mind who creates which one

The creator of a room automatically joins it, so get this backwards and an account ends up somewhere it
shouldn't (most importantly: `sintra` must never end up in `admin`).

```bash
# SintrasBoss: created by sintra, invites phone1
# AmysBoss:    created by amy,    invites phone1
# SintraAmy:   created by sintra, invites amy + phone1
# admin:       created by admin,  invites phone1 -- NEVER created/invited via sintra's token
curl -s -X POST "$URL/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer <creator's access_token>" -H 'Content-Type: application/json' \
  -d '{"name":"<RoomName>","preset":"trusted_private_chat","is_direct":false,"invite":["@user:servername"]}'
```

Verify the sensitive one directly rather than trusting self-report:

```bash
curl -s -H "Authorization: Bearer <admin's access_token>" \
  "$URL/_matrix/client/v3/rooms/<admin-room-id>/joined_members"
# Expect only @admin:servername -- if @sintra:servername shows up, something went wrong.
```

## 7. Wire each node's Hermes gateway

On each node (fetching that node's own credential from Vaultwarden — never another node's):

```bash
MATRIX_USER_ID="$(tools/vault-get-secret.sh matrix-<node> username)"
MATRIX_ACCESS_TOKEN="$(tools/vault-get-secret.sh matrix-<node> password)"
MATRIX_HOMESERVER="http://<homeserver-host-LAN-IP>:6167"
# Home channel: pick that node's own *sBoss room ID (not the shared SintraAmy room) --
# fixes the "no home channel" onboarding nag for cron/scheduled output.
MATRIX_HOME_ROOM="<that node's *sBoss room ID>"

cat >> ~/.hermes/.env <<EOF
MATRIX_USER_ID=$MATRIX_USER_ID
MATRIX_ACCESS_TOKEN=$MATRIX_ACCESS_TOKEN
MATRIX_HOMESERVER=$MATRIX_HOMESERVER
MATRIX_HOME_ROOM=$MATRIX_HOME_ROOM
EOF
chmod 600 ~/.hermes/.env

sudo hermes gateway restart --system
```

## 8. Tailscale Serve for phone access

On the homeserver node:

```bash
sudo tailscale serve --bg --https=443 http://localhost:6167
tailscale serve status   # expect: https://<hostname>.<tailnet>.ts.net -> http://localhost:6167
curl -s https://<hostname>.<tailnet>.ts.net/_matrix/client/versions   # real JSON over real HTTPS
```

Phone client (Element or FluffyChat): set the homeserver to that HTTPS URL, log in as `phone1`.

## 9. Approve the pairing request

Hermes gates each *new user identity* separately from room membership — the first message from a not-yet-seen
Matrix user (even one already in the room) needs an explicit approval:

```bash
hermes pairing list                       # shows the pending code
hermes pairing approve matrix <code>
hermes pairing list                       # confirm it moved to Approved Users
```

Note: a stale-looking `not found or expired` error on the first attempt has been seen even when the
approval actually succeeded — always re-run `list` to check real state rather than trusting the error text.

## Verifying the whole pipeline

```bash
# Real message, sender to recipient, without relying on either agent's LLM:
curl -s -X PUT "$URL/_matrix/client/v3/rooms/<room-id>/send/m.room.message/txn1" \
  -H "Authorization: Bearer <sender's access_token>" -H 'Content-Type: application/json' \
  -d '{"msgtype":"m.text","body":"verification message"}'

curl -s -H "Authorization: Bearer <recipient's access_token>" \
  "$URL/_matrix/client/v3/rooms/<room-id>/messages?dir=b&limit=3"
# Expect the message readable from the recipient's own account.
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-07-27 | Initial version, written after the full Phase 7 setup was built and verified end to end on both nodes — filling a reproducibility gap `infra/vaultwarden/` already had but this didn't. |
| 1.0.1 | 2026-07-30 | Cross-reference fix only: pointers into `IMPLEMENTATION_PLAN.md`'s former per-phase progress logs now point at `LESSONS_LEARNED.md`, which holds that content after the 4.0.0 restructure. No procedural change. |
