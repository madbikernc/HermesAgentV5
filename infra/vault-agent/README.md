# hermes-vault-agent — recreate checklist

**Version:** 1.0.0

Persistent, per-node Vaultwarden session daemon (`tools/hermes-vault-agent.py`) — an optional fast
path for `tools/vault-get-secret.sh`, the shared secret-fetch script nearly every tool in this
fleet already calls.

Built 2026-09-01, following a direct architecture question: would a single persistent Vaultwarden
session have the same cross-persona contention that originally justified `vault-get-secret.sh`
starting fresh (login/unlock/sync) and locking again on every single call? Investigated live
before building anything:

- **Real cost, measured, not assumed:** the full cycle costs ~15s/field under real conditions
  (`hermes-wyze.py`'s own cold re-auth needs 5 fields, ~77s total) — paid by *every* caller across
  the whole fleet, every call, because nothing is ever kept warm.
- **The original justification no longer applies, confirmed live:** `pmoney` used to run both
  `hermes-buzz-watch@sintra` and `hermes-buzz-watch@amy` centrally on one node, and a cached
  session can never serve two different Vaultwarden accounts at once — switching identities always
  forces a full re-login regardless of design, so "never hold a session" was the only safe answer
  at the time. Checked directly: sintra has zero active processes/timers/crontab on Spark today;
  amy has exactly one isolated daily cron job on spark-2. They're no longer colocated on any one
  node — the identity-switching conflict is gone.

## Design

One daemon per node, holding one already-unlocked `bw` session for that node's own default
identity (same `VAULT_NODE`/`/etc/hermes/vault-node-name` resolution `vault-get-secret.sh` already
uses). Served over a **Unix domain socket** (`~/.hermes/vault-agent.sock`, mode `0600`, in a
`0700` directory) — deliberately not a network port, not even loopback: this process holds live
decryption capability for every secret in the vault while it runs, more sensitive than any other
local service in this fleet (router, buzz, memory, guard all use loopback HTTP; this doesn't).

No new privilege boundary: any process running as this Unix user can already decrypt the same
systemd-creds-sealed credentials via the existing `sudo systemd-creds decrypt` NOPASSWD grant and
fetch anything from Vaultwarden directly — this agent only makes that existing access faster by
keeping one session warm, not broader.

`vault-get-secret.sh` tries the agent first (`tools/vault-agent-client.py`, a short-timeout Unix-
socket call) and falls straight through to its own complete, unchanged login/unlock/sync/lock
cycle on **any** failure — agent not running, socket missing, timeout, item/field not found. Every
existing caller across this fleet keeps working exactly as before, whether or not this daemon
happens to be running. It is an optional accelerator, never a hard dependency — the fleet does not
break if it's down.

Session refresh: a background thread calls `bw sync` (cheap — no key derivation) every
`VAULT_AGENT_REFRESH_SECONDS` (default 600s). Any request that hits a real auth failure triggers
exactly one full re-unlock, then retries — paid once by the agent instead of once per caller.

## Install

```bash
sudo cp hermes-vault-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-vault-agent.service
```

One instance per node — the same `pmoney` identity that already runs everything else, using that
node's own default `VAULT_NODE`.

## Verify

```bash
systemctl status hermes-vault-agent.service
journalctl -u hermes-vault-agent.service -n 20 --no-pager   # expect "session established for node=..."
ls -la ~/.hermes/vault-agent.sock                            # expect srwx------ pmoney pmoney

# Fast-path timing test -- should return in well under a second once the agent is warm:
time tools/vault-get-secret.sh buzz-token password
```

To confirm the fallback still works with the agent stopped:

```bash
sudo systemctl stop hermes-vault-agent.service
tools/vault-get-secret.sh buzz-token password   # slower, but still succeeds via the full cycle
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-01 | Initial version — built after confirming live that the original two-persona session-conflict no longer applies, and measuring the real per-call cost this eliminates. |
