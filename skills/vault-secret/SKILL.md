---
name: vault-secret
description: "Fetch a credential from the Hermes Fleet Vaultwarden vault, just-in-time, without ever storing it on disk."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Credentials, Vaultwarden, Bitwarden, Secrets]
prerequisites:
  commands: [bw, jq, sudo, systemd-creds]
---

# Vault Secret Fetch

**Version:** 1.0.1

This node's only local credential is a TPM-or-host-key-sealed bootstrap secret
(see `IMPLEMENTATION_PLAN.md` §2b) — everything else lives in the `Hermes Fleet`
Vaultwarden organization on NAS2 (`https://10.129.1.167:8222`). Use this skill any
time a task needs a credential (an API key, a service password, an SMTP secret,
etc.) instead of asking The Boss for it directly or writing it to a config file.

## How to use it

Run the tool at `tools/vault-get-secret.sh` (in this repo, checked out at
`~/HermesAgentV5` on this node):

```bash
~/HermesAgentV5/tools/vault-get-secret.sh "<item-name>" [password|username|notes|<custom-field>]
```

- First argument: the Vaultwarden item's name, exactly as it appears in the
  `Hermes Fleet` vault (browse via the web vault to confirm the exact name before
  first use — do not guess).
- Second argument (optional, defaults to `password`): which field to return.
  `password`, `username`, and `notes` are handled directly; anything else is
  looked up as a custom field name on that item.
- Prints the requested value to stdout — nothing else. It handles login/unlock
  itself using this node's own sealed bootstrap secret and locks the vault again
  afterward.

## Rules

- **Never redirect the tool's output to a file, log it, or echo it back verbatim
  in a way that persists** (chat history, a committed file, a long-lived
  variable). Use the value immediately for the task at hand, the same run.
- **Never fall back to hardcoding a credential** in a script or config file just
  because a Vaultwarden item doesn't exist yet for it — create the item in the
  vault first (via the web vault, or ask The Boss to), then fetch it through this
  tool. This is the whole point of §2b's credential policy.
- If the tool fails (e.g. `bw` not configured, sealed credential missing), fix
  the underlying setup — don't work around it by storing the secret locally.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-07-26 | Initial version — thin Hermes skill wrapper around `tools/vault-get-secret.sh`, built after the login/unlock pipeline was verified working end to end on both nodes. |
| 1.0.1 | 2026-07-30 | Cross-reference fix only: pointers into `IMPLEMENTATION_PLAN.md`'s former per-phase progress logs now point at `LESSONS_LEARNED.md`, which holds that content after the 4.0.0 restructure. No procedural change. |
