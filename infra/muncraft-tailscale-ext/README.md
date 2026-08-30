# muncraft-tailscale-ext — recreate checklist

**Version:** 1.2.0

A second, independent `tailscaled` instance on the muncraft box (`192.168.1.221`), joining a
second tailnet dedicated to external game access — so friends can reach Minecraft/Zomboid over
Tailscale without public port-forwarding, without putting them on the Hermes fleet's own tailnet
(Phase 6). This is a **remote-box change**, like `../zomboid-backup/` and `../muncraft-ufw-dump/`
— it lives on `192.168.1.221`, not in this repo's `tools/`, tracked here only as a reference copy
plus its own recreate checklist.

Phase 34 (`IMPLEMENTATION_PLAN.md` §7), direct request: "lets do a second tailscale instance on
muncraft."

## ⚠ Needs a human with real root access — same as `../zomboid-backup/` and `../muncraft-ufw-dump/`

Same limitation as those two: nothing available to Hermes (the `Zomboid Admin - muncraft`
credential) can install a systemd unit, write to `/etc/systemd/system/`, or create a new network
interface (`CAP_NET_ADMIN`) on this box. Every step below needs a human with real root on
`192.168.1.221`. It also needs a Tailscale auth key for the second tailnet — a Tailscale login
Hermes has no path to and can't generate itself.

## Before you start: two things only you can provide

1. **A second tailnet.** One Tailscale account = one tailnet (outside of paid multi-tailnet org
   features). If "external game access" doesn't already have its own separate Tailscale
   account/tailnet, create one now (a different sign-in email works fine) — this instance joins
   *that* tailnet, not the fleet's.
2. **An auth key for it**, generated from *that* tailnet's admin console:
   - `console.tailscale.com`, signed into the second account → **Settings → Keys → Generate auth
     key**
   - Reusable: **No** — this only needs to authenticate muncraft once.
   - Ephemeral: **No** — the node should persist across reboots, not vanish when it disconnects.
   - Tags: optional, leave blank unless the second tailnet's ACLs require one.
   - **Expiration: 90 days (the max the console allows).** Set this explicitly — don't accept
     whatever the form defaults to. Maximizes the buffer between generating the key and actually
     running the install below; see "no rush" note just after this list for why that buffer
     matters and what to do if it still runs out.
   - Copy the resulting `tskey-auth-...` string and treat it as a secret — don't paste it into a
     committed file or chat log. It's consumed the moment `tailscale up` runs below.
   - **No rush once generated.** A pre-auth key's expiry counts down from generation, not from
     first use — up to 90 days by default (1-90, your choice on the console). Generating it today
     and running the install whenever real root time on muncraft is arranged is fine; there's no
     minutes-scale window to hit. If the root session ends up taking longer than the chosen expiry,
     generate a fresh key rather than reusing the stale one.

## Real finding, flagged and left open by direct decision (2026-08-17)

muncraft's live UFW rules trust the *entire* Tailscale CGNAT range (`100.64.0.0/10`) for SSH and
RCON, not specific peer IPs (`tools/hermes-game-server-monitor.py`'s `UFW_ALLOWED_SOURCE_NETS`,
confirmed against the real ruleset in Phase 29). Every device on *any* tailnet gets an address
inside that same shared block — UFW has no way to tell "trusted fleet peer" from "new game-access
friend" apart, only that the source is somewhere in `100.64.0.0/10`. This instance is configured
host-only (no advertised routes, no exit-node role, `--netfilter-mode=off` so it doesn't touch the
box's existing firewall state) — that keeps friends off the rest of the LAN, but it does **not**
stop a device on tailnet 2 from reaching SSH/RCON on muncraft itself; real SSH/RCON credentials
would still be needed to do anything with that path, but the network route exists. Direct
decision: leave this open rather than tighten UFW as part of this change — same "leave manual,
don't silently widen scope" precedent as Phase 29's own firewall handling. Revisit by scoping the
UFW SSH/RCON rule to the fleet's specific Tailscale IPs instead of the whole CGNAT block, if this
needs closing later.

## Install (run as root on 192.168.1.221)

```bash
# Confirm the primary instance's tun device name and binary paths before assuming —
# standard apt-package values, but verify rather than guess:
ip link show tailscale0        # primary instance's own tun device
which tailscaled tailscale     # usually /usr/sbin/tailscaled, /usr/bin/tailscale

sudo cp tailscaled-ext.service /etc/systemd/system/
sudo cp tailscale-ext /usr/local/bin/tailscale-ext
sudo chmod 755 /usr/local/bin/tailscale-ext

sudo systemctl daemon-reload
sudo systemctl enable --now tailscaled-ext.service

# Join the second tailnet. Don't paste the key directly onto the command line —
# it would sit in this shell's history and in `ps` output for as long as the
# `tailscale-ext up` process runs. `--authkey` accepts a `file:` path instead
# (a real tailscale up flag, not a workaround), so read the key via a prompt
# that never gets recorded in history, write it to a root-only file, use it,
# then remove it:
read -s -p "Paste the tskey-auth-... value, then press Enter: " TS_EXT_KEY && echo
sudo install -m 600 /dev/null /root/.tailscale-ext.key
echo "$TS_EXT_KEY" | sudo tee /root/.tailscale-ext.key >/dev/null
unset TS_EXT_KEY
sudo tailscale-ext up --authkey=file:/root/.tailscale-ext.key
sudo shred -u /root/.tailscale-ext.key
```

## Verify

```bash
systemctl status tailscaled-ext.service
tailscale-ext status                 # should show this node connected on tailnet 2
ip link show tailscale1              # the second instance's own tun device
ip link show tailscale0              # confirm the primary instance is untouched
tailscale status                     # primary instance, confirm still connected on the fleet tailnet
```

From a device on tailnet 2, confirm it can reach the game ports (Minecraft/Zomboid) at this node's
tailscale-ext IP (`tailscale-ext ip -4`) — and confirm, this is the point of the finding above,
that RCON/SSH are reachable too unless/until that gap gets closed.

## Design notes

- **Separate state dir/socket/tun/port** (`/var/lib/tailscale-ext`, `/run/tailscale-ext/tailscaled.sock`,
  `tailscale1`, UDP `41642`) — the standard pattern for running two `tailscaled` instances on one
  Linux host; reusing any of the primary instance's paths would clobber its state.
- **`--netfilter-mode=off`** on the second instance — without it, both instances fight over the
  same iptables chains/NAT rules `tailscaled` manages. Since this instance advertises no routes and
  isn't a subnet router or exit node, it doesn't need `tailscaled`-managed NAT/isolation rules;
  ordinary UFW/kernel routing handles `tailscale1` like any other interface — which is exactly what
  produces the SSH/RCON finding above.
- **Host-only by direct decision** — no `--advertise-routes`, no `--advertise-exit-node`,
  `--accept-routes` left at its default (off). Friends on tailnet 2 can reach muncraft itself, not
  the rest of `192.168.1.0/24`.
- **Tailscale SSH deliberately not enabled** (`--ssh` omitted) — that flag turns on Tailscale's own
  built-in SSH server for the tailnet, a separate and more powerful surface than "reachable at an
  IP"; enabling it for the friends' tailnet was never the goal.
- **Reusable=No, Ephemeral=No on the auth key** — reusable isn't needed since this installs once;
  non-ephemeral so the node keeps its identity/IP across restarts instead of Tailscale forgetting
  it during the game server's normal downtime.
- **`--authkey=file:...` instead of a literal argv value** — `tailscale up`'s own flag, confirmed
  against Tailscale's CLI reference rather than assumed; keeps the key out of `ps` and, combined
  with `read -s`, out of shell history too. Same "secrets never touch disk in the clear, and only
  briefly at that" discipline this project already applies via `tools/vault-set-secret.sh`.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-17 | Initial version — Phase 34, direct request. Second `tailscaled` instance designed host-only, `--netfilter-mode=off`; real SSH/RCON exposure gap found (`UFW_ALLOWED_SOURCE_NETS` trusts the whole Tailscale CGNAT range, not specific peers) and left open by direct decision rather than silently building around it. Awaits the same manual root install `zomboid-backup.timer`/`ufw-status-dump.timer` needed, plus a second-tailnet auth key only The Boss can generate. |
| 1.1.0 | 2026-08-19 | Prep work ahead of the auth key existing, direct request. Noted the key has no minutes-scale urgency — expiry counts down from generation, up to 90 days by default, confirmed against Tailscale's own docs rather than assumed. Install step reworked to pass the key via `--authkey=file:...` (a real `tailscale up` flag) behind a `read -s` prompt instead of a literal command-line argument, so it never lands in shell history or `ps` output — the same secrets-discipline this project already applies via `tools/vault-set-secret.sh`. No behavior change to the service itself; still needs real root on muncraft plus the auth key before anything can actually be installed. |
| 1.2.0 | 2026-08-19 | Direct follow-up: the generation walkthrough listed Reusable/Ephemeral/Tags but never told the admin what to actually set Expiration to, leaving 1.1.0's "no rush, up to 90 days" note without an instruction attached to it. Added an explicit bullet: set Expiration to 90 days (the max), not whatever the console form defaults to. |
