---
name: minecraft-admin
description: "Remote administer the vanilla Minecraft server at 192.168.1.221 (minecraft.service, alongside the Project Zomboid server on the same box) — whitelist, ops, kick/ban, broadcasts, and RCON console access."
version: 1.1.0
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Minecraft, Zomboid, Monitoring, Remote, Server]
    related_skills: [vault-secret, game-server-monitor, zomboid-admin]
prerequisites:
  commands: []
  files:
    - tools/hermes-minecraft-admin.py
---

# Minecraft Admin Remote Management

**Version:** 1.1.0

**Now reachable from Matrix chat, not just this CLI.** Direct operator request (2026-09-06):
`tools/hermes-game-admin.py` (Buzz topic `gameadmin`) parses admin requests out of chat text and
subprocesses to this exact tool for the Minecraft side — whitelist add/remove, op/deop, kick/ban/
pardon, broadcast, save, start/stop/restart are all reachable this way, with **no confirmation
step**. See that file's header for the full account, including why `console <raw command>` is
deliberately not exposed to chat even though this CLI supports it directly.

Manages the vanilla Minecraft server (`minecraft.service`) running on `192.168.1.221` —
the same Debian 13 box that hosts the Project Zomboid server (see
[[zomboid-admin]]). Unlike Zomboid on this box, Minecraft's RCON is actually
enabled (`rcon.port=25575` in `server.properties`), so administration here
goes through RCON rather than a console FIFO. RCON is bound to
`127.0.0.1:25575` by config, so every command runs *on* the box over SSH
(same approach `tools/hermes-game-server-monitor.py` already uses and
verifies live every day) rather than connecting to 25575 directly from
wherever this tool is invoked.

This is a v1→V5 port: v1's `HermesAgent/skills/network/minecraft-admin` was
a monitor-only skill (health/security/login-activity checks via raw `ssh`
to a `muncraft` key/host alias that no longer — and may never have —
existed for any identity this fleet actually runs as). That monitoring
half was already ported and extended to cover Zomboid too in
[[game-server-monitor]]. What v1 never had was a real *admin/control* tool
for Minecraft — the RCON-based capability this skill and
`tools/hermes-minecraft-admin.py` add, modeled on the admin tool this repo
already built for Zomboid (`tools/hermes-zomboid-admin.sh`) but using the
credential path that tool's own docs (see [[game-server-monitor]]'s Rules
section) found was never actually wired up for Zomboid either: the
Vaultwarden-backed `zomboid-admin` account, not an assumed ambient SSH key.

## When to Use

Invoke this skill whenever a request contains any of the following:

- "check the minecraft server" / "minecraft players" / "who's on minecraft"
- "whitelist a minecraft player" / "remove from minecraft whitelist" / "minecraft whitelist"
- "op a minecraft player" / "deop" / "make someone an operator"
- "kick/ban a minecraft player" / "unban" / "pardon"
- "broadcast a message on minecraft" / "say something on the minecraft server"
- "save the minecraft world now"
- "start/stop/restart the minecraft server"
- "run a minecraft console command" / "minecraft rcon"

For health/security/backup checks instead of admin actions, use
[[game-server-monitor]] — it already covers this box's Minecraft and
Zomboid health daily.

## Server Connection

Credentials come from Vaultwarden (item `Zomboid Admin - muncraft`, user
`zomboid-admin`) via `tools/vault-get-secret.sh` — the same real, working
credential `tools/hermes-game-server-monitor.py` already uses. No separate
Minecraft-specific credential exists or is needed; `zomboid-admin`'s group
membership on `muncraft` is what makes `/opt/minecraft/server.properties`
(and its `rcon.password`) group-readable.

## Running the Tool

```bash
python3 tools/hermes-minecraft-admin.py <command> [args...]
```

**Status / players:**
```bash
python3 tools/hermes-minecraft-admin.py status     # service state, process, disk, players
python3 tools/hermes-minecraft-admin.py players    # RCON 'list'
```

**Whitelist:**
```bash
python3 tools/hermes-minecraft-admin.py whitelist list
python3 tools/hermes-minecraft-admin.py whitelist add <name>
python3 tools/hermes-minecraft-admin.py whitelist remove <name>
python3 tools/hermes-minecraft-admin.py whitelist reload
```

**Operators:**
```bash
python3 tools/hermes-minecraft-admin.py op <name>
python3 tools/hermes-minecraft-admin.py deop <name>
```

**Moderation:**
```bash
python3 tools/hermes-minecraft-admin.py kick <name> [reason]
python3 tools/hermes-minecraft-admin.py ban <name> [reason]
python3 tools/hermes-minecraft-admin.py pardon <name>
```

**Other:**
```bash
python3 tools/hermes-minecraft-admin.py say "<message>"      # broadcast
python3 tools/hermes-minecraft-admin.py save                 # save-all
python3 tools/hermes-minecraft-admin.py console "<raw rcon command>"
python3 tools/hermes-minecraft-admin.py start|stop|restart   # see Notes — sudo grant unconfirmed
```

## Notes

- Server files: `/opt/minecraft/` (world, `server.properties`, `whitelist.json`, `ops.json`, `logs/`)
- RCON port 25575 is `127.0.0.1`-only per `server.properties`, though
  [[game-server-monitor]] has an open, standing finding that vanilla
  Minecraft doesn't reliably enforce `rcon.ip` as a real bind restriction —
  don't assume the port is unreachable from off-box just because the config
  says so.
- Player names are validated against Minecraft's real username shape
  (3-16 chars, `[A-Za-z0-9_]`) before ever reaching an RCON command —
  fails loud on a typo rather than sending the server something it will
  silently misparse.
- Whitelist/ops data lives in flat JSON files (`whitelist.json`, `ops.json`)
  server-side, unlike Zomboid's SQLite account DB — this tool manages them
  entirely through RCON (`whitelist add/remove`, `op`/`deop`), never by
  editing those files directly, so there's no separate "reload" step needed
  beyond the `whitelist reload` command RCON itself exposes.
- **`start`/`stop`/`restart` are unconfirmed.** They run
  `sudo -n systemctl <action> minecraft.service` as `zomboid-admin`, but
  [[zomboid-admin]]'s documented sudoers grant
  (`/etc/sudoers.d/zomboid-admin`) is scoped only to `zomboid.service`
  commands. Expect a sudo permission error until that drop-in is extended
  to cover `minecraft.service` too — that failure is this tool correctly
  reporting a real permission gap, not a bug. Fixing it is a manual,
  root-access step for The Boss, same precedent as the original
  `zomboid-admin` sudoers install (see [[zomboid-admin]] Revision History
  1.5.0/1.6.0).
- No credentials are hardcoded in `tools/hermes-minecraft-admin.py` — the
  RCON password is read directly off the box from `server.properties` by a
  small Python script run over SSH, never transmitted or stored anywhere
  else.

## Pitfalls

### Everything except `list`/`status` is unverified against the real server
The RCON transport itself (auth + a real round trip) is proven live daily
by [[game-server-monitor]]. Every other command here (`whitelist`, `op`,
`kick`, `ban`, `say`, `save-all`) was written from Minecraft's documented
vanilla RCON command syntax, not yet exercised against this specific box.
Treat the first real use of each as a smoke test — if a command's response
looks like a Minecraft "Unknown command" or usage-error message rather than
a real result, trust that over this doc.

### RCON has no shell-injection surface, but Minecraft's own parser still matters
Every argument travels as one length-prefixed binary RCON packet, built via
Python `repr()`, not shell string interpolation — there's no FIFO- or
shell-style command-chaining risk the way `hermes-zomboid-admin.sh` had to
fix (see [[zomboid-admin]] 1.6.0). The validation this tool does apply
(player-name shape, rejecting embedded newlines/nulls in free-text
messages) exists to avoid confusing Minecraft's own command tokenizer, not
to prevent remote code execution.

### `console` is unrestricted
`console "<raw command>"` sends anything verbatim via RCON — including
destructive vanilla commands this skill doesn't have a dedicated
subcommand for (`stop`, `/gamemode`, `/difficulty`, world-editing commands
via a datapack, etc.). There is no allowlist on `console` the way
`hermes-zomboid-admin.sh`'s `sandboxvar` allowlists its own writes — use it
deliberately, not as a default path.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.0 | 2026-09-06 | Direct operator request: wired into Matrix chat via the new `gameadmin` Buzz topic (`tools/hermes-game-admin.py`), with no confirm gate. |
| 1.0.0 | 2026-09-06 | Ported forward from v1's `HermesAgent/skills/network/minecraft-admin` (monitor-only; its own admin/control gap was never closed in HermesAgentV4 or HermesAgentRedo — both carried forward only the Minecraft backup-pull tool, not this skill). Built `tools/hermes-minecraft-admin.py` as the RCON-based admin tool v1 never had, using the vault-credential path `tools/hermes-game-server-monitor.py` already proved live rather than v1's non-existent `muncraft` SSH key. Written from this repo's own verified facts (RCON transport, credential source, box layout) plus Minecraft's documented vanilla command syntax — see Pitfalls for exactly what has and hasn't been exercised against the real server yet. |
