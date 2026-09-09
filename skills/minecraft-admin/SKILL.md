---
name: minecraft-admin
description: "Remote administer the vanilla Minecraft server at 192.168.1.221 (minecraft.service, alongside the Project Zomboid server on the same box) and the separate Firmament bot-sandbox instance (minecraft-bots.service) — whitelist, ops, kick/ban, broadcasts, RCON console access, and bot-sandbox world reinit."
version: 1.2.0
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

**Version:** 1.2.0

**Reachable from Matrix chat, not just this CLI.** Direct operator request (2026-09-06):
`tools/hermes-game-admin.py` (Buzz topic `gameadmin`) parses admin requests out of chat text and
subprocesses to this exact tool for the Minecraft side — whitelist add/remove, op/deop, kick/ban/
pardon, broadcast, save, start/stop/restart, and (2026-09-09) bot-sandbox `bots list`/world reinit
are all reachable this way, with **no confirmation step**. See that file's header for the full
account, including why `console <raw command>` is deliberately not exposed to chat even though
this CLI supports it directly.

**This Matrix path was built 2026-09-06 but never actually deployed until 2026-09-09** — found
live while wiring the new bot-sandbox action in: `hermes-game-admin.service` was never installed
on the Spark, and its `hermes-game-admin-wrapper.sh` was checked into git without the executable
bit set (`100644`, would fail with `203/EXEC` the moment anyone DID try to start it), and the
`gameadmin` Buzz topic/agent identity was never added to `hermes-buzz.py`'s own
`KNOWN_AGENTS`/`KNOWN_TOPICS` (would 400 on its very first poll). All three fixed and verified
live in the same pass — see that file's own Revision History and `hermes-buzz.py` 2.0.21.

## Bot Sandbox (`bots` subcommand group, 2026-09-09)

A SEPARATE Minecraft server instance on the same box (192.168.1.221) — `minecraft-bots.service`,
port 25580, offline-mode, no RCON — from the `minecraft.service` (port 25565, RCON-managed)
everything else in this skill targets. This is the Firmament fleet's own bot sandbox (Babs/Amy/
Mark/Luke/Mayor and however many more exist by the time this is read), not the real,
human-player-facing survival server.

```bash
python3 tools/hermes-minecraft-admin.py bots list                    # discover the current bot roster
python3 tools/hermes-minecraft-admin.py bots reinit-world [seed]     # back up, wipe, regenerate
```

**The bot roster is never hardcoded.** `bots list`/`bots reinit-world` both query systemd
directly (`minecraft-bot-*.service`, the per-instance naming convention) every single call — a
bot added or removed from the fleet since this file was last touched is picked up automatically,
with zero code change needed. This was a direct instruction, not an implementation detail: "make
sure the tool does not ASSUME the existing bots... it needs to DISCOVER the existing bots and
handle them dynamically."

`reinit-world` mirrors the exact manual sequence used the first time this was done live (verified
against a real world wipe+reseed, 2026-09-09): stop every discovered bot client, take a fresh
`backup.sh` safety backup, rename the current world directory aside (never deleted — recoverable),
set (or blank, for a fresh random one) `level-seed`, restart the sandbox server the only way this
account actually can (its own process is killed directly and `Restart=always` brings it back —
`systemctl stop/restart minecraft-bots` fails with "Access denied" even though the process runs
as this same account, since managing a *system* unit needs root regardless of which user the
unit's own process runs as), wait for it to come back up, clear every bot's now-stale claimed-bed
file (`/mnt/hermes-data/minecraft-memory/beds/*.json` — old-world coordinates), then restart
every discovered bot client.

From Matrix: "reinit/reset/regenerate the bot sandbox world [seed <N>]" or "list the minecraft
bots" — both require "bot(s)"/"sandbox" explicitly in the phrasing so this can never be confused
with (and accidentally reach) the real Minecraft server via a plain "reset the minecraft world."

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
- "list the minecraft bots" / "which bots are running" / "bot status"
- "reinit/reset/regenerate the bot sandbox world [with seed N]"

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

**Bot sandbox** (see "Bot Sandbox" section above):
```bash
python3 tools/hermes-minecraft-admin.py bots list
python3 tools/hermes-minecraft-admin.py bots reinit-world [seed]
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
| 1.2.0 | 2026-09-09 | Direct request: added the `bots` subcommand group (`list`, `reinit-world`) for the separate Firmament bot-sandbox instance (`minecraft-bots.service`) -- bot roster always discovered from systemd, never hardcoded. Also found and fixed three real deployment gaps that had left the whole Matrix-admin path (built 2026-09-06) never actually live: `hermes-game-admin.service` was never installed, its wrapper script was committed without the executable bit, and the `gameadmin` Buzz topic/agent was never registered in `hermes-buzz.py`'s `KNOWN_AGENTS`. All fixed and verified live. |
| 1.1.0 | 2026-09-06 | Direct operator request: wired into Matrix chat via the new `gameadmin` Buzz topic (`tools/hermes-game-admin.py`), with no confirm gate. |
| 1.0.0 | 2026-09-06 | Ported forward from v1's `HermesAgent/skills/network/minecraft-admin` (monitor-only; its own admin/control gap was never closed in HermesAgentV4 or HermesAgentRedo — both carried forward only the Minecraft backup-pull tool, not this skill). Built `tools/hermes-minecraft-admin.py` as the RCON-based admin tool v1 never had, using the vault-credential path `tools/hermes-game-server-monitor.py` already proved live rather than v1's non-existent `muncraft` SSH key. Written from this repo's own verified facts (RCON transport, credential source, box layout) plus Minecraft's documented vanilla command syntax — see Pitfalls for exactly what has and hasn't been exercised against the real server yet. |
