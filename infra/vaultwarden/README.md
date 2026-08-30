# Vaultwarden setup — recreate checklist

**Version:** 1.1.0

Ordered steps to stand this up from scratch on a Synology NAS (or any Docker host).
For the full narrative — why each decision was made, what was tried and abandoned,
every gotcha hit along the way — see `LESSONS_LEARNED.md` §5 and §7 in the repo root.
This file is the recipe; that section is the reasoning.

## 1. Deploy the compose stack

```bash
mkdir -p /path/to/vaultwarden/{data,certs}
cp docker-compose.yml .env.template smtp.env.template /path/to/vaultwarden/
cd /path/to/vaultwarden
mv .env.template .env
# Edit .env: fill in ADMIN_TOKEN (openssl rand -base64 48) and DOMAIN.
# Leave SMTP_* blank for now — Vaultwarden hard-fails at startup on an
# invalid SMTP_FROM, so don't add SMTP config until you have real values
# (see smtp.env.template).
```

Edit `docker-compose.yml`'s `ports:` section to use this host's real LAN IP
instead of `10.129.1.167`.

## 2. Generate the self-signed cert

Official Bitwarden clients (the web vault *and* the `bw` CLI) hard-refuse
non-HTTPS servers — plain HTTP only works for unauthenticated health checks,
not real use. A self-signed cert wired directly into Vaultwarden's own
`ROCKET_TLS` avoids the reverse-proxy route entirely (a Caddy-based attempt at
this hit an unresolved TLS bug — see `LESSONS_LEARNED.md` §5):

```bash
openssl req -x509 -nodes -newkey rsa:2048 -days 1825 \
  -keyout certs/vw-lan.key -out certs/vw-lan.crt \
  -subj '/CN=<this-host-LAN-IP>' \
  -addext 'subjectAltName=IP:<this-host-LAN-IP>'
chmod 600 certs/vw-lan.key
chmod 644 certs/vw-lan.crt
```

## 3. Bring it up

```bash
docker compose up -d --force-recreate vaultwarden
curl -sk https://<this-host-LAN-IP>:8222/alive   # expect a 200 + timestamp
```

## 4. First-run org setup (needs a browser, temporarily allow signups)

`SIGNUPS_ALLOWED` should already be `false` in the template. Flip it to `true`
in `docker-compose.yml`, `docker compose up -d --force-recreate vaultwarden`,
then in a browser at `https://<LAN-IP>:8222` (accept the self-signed cert
warning — it's expected, it's your own cert):

1. Register the human admin account. Use **TOTP** for 2FA, not WebAuthn/security
   keys — WebAuthn credentials bind to the exact origin used at registration,
   which breaks if you ever access this vault from a different hostname/IP.
2. Create an organization and whatever collections you want to scope access by.
3. For **each node** that needs to authenticate here, register a **separate**
   machine account (its own email/alias, its own master password) — don't share
   one credential across nodes. Log into it once, then Settings → Security →
   Keys → View API Key for its `client_id`/`client_secret`.
4. Invite each machine account into the org, scoped to only the collections it
   needs.

Flip `SIGNUPS_ALLOWED` back to `false` and `docker compose up -d
--force-recreate vaultwarden` once every account that needs to exist, exists —
registering a new machine account later means briefly reopening signups again.

## 5. Seal each node's bootstrap secret (do this per consuming node, not here)

Each node that needs to reach this vault seals its own machine account's API
key and master password locally — TPM-sealed if the node has a TPM, host-key
sealed via the same tool otherwise (still real encryption-at-rest tied to that
specific machine, just not hardware-backed):

```bash
# Run ON the consuming node, not on the Vaultwarden host:
sudo mkdir -p /etc/credstore.encrypted
sudo systemd-creds encrypt --name=vaultwarden-<node>-apikey - \
  /etc/credstore.encrypted/vaultwarden-<node>-apikey <<'EOF'
BW_CLIENTID=<client_id from step 4>
BW_CLIENTSECRET=<client_secret from step 4>
EOF
sudo systemd-creds encrypt --name=vaultwarden-<node>-masterpw - \
  /etc/credstore.encrypted/vaultwarden-<node>-masterpw <<'EOF'
BW_PASSWORD=<that machine account's master password>
EOF
sudo chmod 600 /etc/credstore.encrypted/vaultwarden-<node>-*
sudo chown root:root /etc/credstore.encrypted/vaultwarden-<node>-*
```

`<node>` is a short name for that node (e.g. `sintra`, `amy`) — also write it to
`/etc/hermes/vault-node-name` so `tools/vault-get-secret.sh` can find it without
being told explicitly each time.

**`/etc/hermes/vault-node-name` is a fallback for ad hoc/manual use only, not a
substitute for step 6a below.** It is host-wide — if more than one identity ever
ends up running on the same physical host (as `amy` and `sintra` do today, both
on the Spark), it silently answers for whichever identity ran second, and a
manual command that forgets to export `VAULT_NODE` first will fetch and unlock
the *other* identity's vault account without any error. This actually happened
(`LESSONS_LEARNED.md` §2j, 2026-08-02) — it corrupted the wrong node's local `bw`
session state and broke its gateway's logins for nine restart cycles. Every
long-running consumer (the gateway service, timers, cron) must set `VAULT_NODE`
explicitly in its own unit rather than relying on this file.

## 6a. Scope this node's sudo rule to its own credential files only

`tools/vault-get-secret.sh` and `tools/vault-set-secret.sh` both shell out to
`sudo systemd-creds decrypt` to unseal step 5's files. A rule scoped to the
*command* (`systemd-creds decrypt *`) but not to *which files* it can target
means any caller on that account — including one that forgot to set
`VAULT_NODE` — can decrypt another identity's sealed credentials too, with no
error to signal it went wrong. Scope it per node instead:

```bash
# On the consuming node, as root — replace <node> with this node's own name
# (e.g. amy, sintra). <unix-user> is the account this node's agent process
# actually runs as (see IMPLEMENTATION_PLAN.md §5 constraint 2 — a dedicated
# Unix user per identity, never the shared interactive admin account).
cat <<EOF | sudo tee /etc/sudoers.d/<node>-vault
<unix-user> ALL=(root) NOPASSWD: /usr/bin/systemd-creds decrypt /etc/credstore.encrypted/vaultwarden-<node>-*
EOF
sudo chmod 440 /etc/sudoers.d/<node>-vault
sudo visudo -c   # verify syntax before trusting it
```

If this node previously had a broader `systemd-creds decrypt *` rule (e.g. an
earlier `amy-vault`/`sintra-vault` drop-in), replace it with the file above
rather than leaving both in place.

## 6. Install `bw` and trust the cert, on each consuming node

```bash
# Pick the right asset for the node's architecture from
# https://github.com/bitwarden/clients/releases (tag cli-v*, assets named
# bw-linux-*.zip / bw-linux-arm64-*.zip)
curl -fsSL -o bw.zip <release-url>
unzip bw.zip && sudo install -m 755 bw /usr/local/bin/bw

bw config server https://<vaultwarden-host-LAN-IP>:8222

# Trust the self-signed cert (copy certs/vw-lan.crt from the Vaultwarden host
# to this node first):
sudo mkdir -p /usr/local/share/ca-certificates/hermes /etc/hermes
sudo cp vw-lan.crt /usr/local/share/ca-certificates/hermes/
sudo update-ca-certificates
sudo cp vw-lan.crt /etc/hermes/vw-lan.crt   # for NODE_EXTRA_CA_CERTS — bw's
                                            # bundled Node runtime doesn't use
                                            # the OS trust store automatically
```

## 7. Deploy the credential-fetch skill

Copy (or symlink, if this repo is checked out on the node — see repo root
`README.md`) `tools/vault-get-secret.sh` and `skills/vault-secret/` into place,
matching wherever this node's agent framework expects local skills. Test it:

```bash
tools/vault-get-secret.sh "<some test item name>" password
```

## Verifying the whole pipeline

```bash
NODE_EXTRA_CA_CERTS=/etc/hermes/vw-lan.crt bash -c '
  set -a
  eval "$(sudo systemd-creds decrypt /etc/credstore.encrypted/vaultwarden-<node>-apikey -)"
  eval "$(sudo systemd-creds decrypt /etc/credstore.encrypted/vaultwarden-<node>-masterpw -)"
  set +a
  bw login --apikey
  bw unlock --passwordenv BW_PASSWORD
'
```

A real session key on the last line means everything above is wired correctly.
Run `bw lock` afterward — nothing should stay unlocked when not actively in use.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-07-26 | Initial version, written after the full setup was built and verified end to end on both Hermes Fleet nodes. |
| 1.0.1 | 2026-07-30 | Cross-reference fix only: pointers into `IMPLEMENTATION_PLAN.md`'s former per-phase progress logs now point at `LESSONS_LEARNED.md`, which holds that content after the 4.0.0 restructure. No procedural change. |
| 1.1.0 | 2026-08-10 | Added §6a (per-node sudoers scoping to `vaultwarden-<node>-*` only, replacing the broader `systemd-creds decrypt *` rule) and a warning under step 5 about `/etc/hermes/vault-node-name` being a host-wide fallback, not a substitute for each long-running consumer setting `VAULT_NODE` explicitly. Both written in direct response to `LESSONS_LEARNED.md` §2j — a real cross-identity credential fetch between `amy` and `sintra` once they ended up on the same host. |
