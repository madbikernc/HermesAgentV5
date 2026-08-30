# Hermes gateway — Vaultwarden-backed credential injection

**Version:** 1.2.0

How each node's `hermes-gateway` systemd service gets its real secrets (`EMAIL_PASSWORD`,
`MATRIX_ACCESS_TOKEN`, `TAVILY_API_KEY`) without ever writing them to disk. For the full narrative — why
this replaced the earlier `vault-get-secret.sh ... >> ~/.hermes/.env` pattern, and the reliability trade-off
it accepts — see `IMPLEMENTATION_PLAN.md` §2b and its dated addendum in the repo root. This file is the
recipe; that section is the reasoning.

## How it works

`hermes gateway install --system` normally points the systemd unit's `ExecStart` straight at the venv's
`python`, which then reads `~/.hermes/.env` for all config, secrets included. Instead, `ExecStart` points at
[`tools/hermes-gateway-wrapper.sh`](../../tools/hermes-gateway-wrapper.sh), which:

1. Fetches this node's `EMAIL_PASSWORD`, `MATRIX_ACCESS_TOKEN`, and `TAVILY_API_KEY` from Vaultwarden via
   `tools/vault-get-secret.sh` (one call per secret).
2. Exports each as a real process environment variable.
3. `exec`s the actual gateway process — replacing itself rather than forking, so the secrets never exist
   anywhere but that final process's own environment block, and never touch disk at any point.

Non-secret config (`EMAIL_ADDRESS`, `*_HOST`, `EMAIL_ALLOWED_USERS`, `MATRIX_USER_ID`, `MATRIX_HOMESERVER`,
room IDs, etc.) stays in `~/.hermes/.env` as before — python-dotenv's default (`override=False`) never
clobbers a variable already present in the process environment, so as long as the three secret lines above
are absent from `.env`, the wrapper's exported values are what the gateway actually sees.

## Applying it to a node

If a second identity is ever colocated on a host that already runs
`hermes-gateway.service` (as `amy` and `sintra` both do on the Spark today),
give the second one its own unit filename — `hermes-gateway-<node>.service` —
rather than overwriting the first; systemd unit files are one-per-filename, so
two identities on one host cannot both be plain `hermes-gateway.service`. Live
today: `hermes-gateway.service` is sintra's, `hermes-gateway-amy.service` is
amy's.

```bash
# Strip the secret lines from .env — keep everything else:
sed -i '/^EMAIL_PASSWORD=/d; /^MATRIX_ACCESS_TOKEN=/d; /^TAVILY_API_KEY=/d' ~/.hermes/.env

UNIT=hermes-gateway.service   # or hermes-gateway-<node>.service if this host
                              # already runs another identity's gateway
sudo cp hermes-gateway.service.template "/etc/systemd/system/$UNIT"
# Edit User/Group/paths if this node's username or install layout differs from `pmoney`.
# Set VAULT_NODE to this node's own identity (amy|sintra) — do not leave the
# placeholder in and do not omit it. See the comment above that line in the
# template for why this must not be left to fall through to
# /etc/hermes/vault-node-name.
sudo systemctl daemon-reload
sudo systemctl restart "$UNIT"
sudo systemctl status "$UNIT"   # expect: active (running)
journalctl -u "$UNIT" -n 30 --no-pager   # confirm no fetch errors, platforms started
```

## The trade-off

This makes Vaultwarden reachability a hard requirement for **every** gateway start — boots, restarts, crash
recovery — not just initial setup. If Vaultwarden is unreachable when the service needs to start, the
wrapper exits before `exec`, and systemd's `Restart=always` / `RestartSec=5` just keeps retrying every 5
seconds until Vaultwarden comes back — no manual intervention needed, but the gateway is down for that
whole window. The static-`.env` approach this replaced didn't have that failure mode. This was a deliberate,
explicit choice (over the alternative of sealing these secrets locally via `systemd-creds`, the same way the
Vaultwarden bootstrap credential itself is handled) to satisfy the project's actual policy: only the
bootstrap credential gets a local-storage exception, nothing else does.

## Re-applying after `hermes gateway install --system`

That command regenerates `/etc/systemd/system/hermes-gateway.service` from scratch and will silently
overwrite the custom `ExecStart` line. After any future re-run, re-copy the template (or manually re-point
`ExecStart` at the wrapper) and `daemon-reload` + `restart`.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.3.0 | 2026-08-15 | Template's `RestartSec=5` fixed retry replaced with exponential backoff (`RestartSteps=9`, `RestartMaxDelaySec=300`), `StartLimitIntervalSec=0` kept. Real incident same day: Sintra's and Amy's gateways crash-looped simultaneously on a Vaultwarden login failure, each restart's retries re-tripping Vaultwarden's own rate limit every 5s, indefinitely — never clearing on its own. Backoff caps at a 5min retry interval, comparable to the manual cooldown this failure mode has needed by hand twice now (here and in `hermes-repo-sync.sh`'s 2026-08-09 incident). |
| 1.0.0 | 2026-07-27 | Initial version — written when the static-`.env`-secrets pattern used for email/Matrix/Tavily was replaced with Vaultwarden-at-startup injection, per direct user feedback that the earlier pattern violated §2b. |
| 1.1.0 | 2026-08-10 | Template now sets `VAULT_NODE` explicitly (was previously left to fall through to `/etc/hermes/vault-node-name`); "Applying it to a node" updated to require setting it per node. Fixes the real cross-identity credential fetch in `LESSONS_LEARNED.md` §2j. |
| 1.2.0 | 2026-08-10 | Checked the live Spark and found this doc had fallen behind reality: `amy` and `sintra` are colocated there today under two separately-named units (`hermes-gateway.service`, `hermes-gateway-amy.service`), which this doc never documented — it implied one filename for all nodes, which cannot work once a second identity shares a host. "Applying it to a node" now covers picking a distinct unit filename in that case. |
