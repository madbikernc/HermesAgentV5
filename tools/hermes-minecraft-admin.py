#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-09-09) -- direct request: "add this task to the minecraft admin tool/skill on the
# Fleet ... discover the existing bots and handle them dynamically." New "bots" subcommand group
# (list, reinit-world) for the Firmament bot-sandbox instance (minecraft-bots.service, port
# 25580) -- a separate server from the one this file otherwise manages. See the new BOTS_*
# constants' own header comment for the full account of what's different about it (different
# account owns it outright but still can't systemctl it, different host for the per-bot clients,
# etc.) and discover_bot_units()'s own comment for why the bot roster is queried from systemd
# every call rather than ever hardcoded.
#
# Remote admin for the vanilla Minecraft server on the muncraft box
# (192.168.1.221, systemd unit minecraft.service). Ported from v1's
# HermesAgent/skills/network/minecraft-admin (a bash/raw-`ssh` monitor-only
# skill that assumed a `muncraft` SSH key/host alias which does not exist
# for any identity available to this fleet — see
# skills/game-server-monitor/SKILL.md's Rules section, which found the same
# problem in hermes-zomboid-admin.sh) and modeled structurally on
# tools/hermes-zomboid-admin.sh (the equivalent admin tool this repo already
# built for the other game server on this same box) — but using the
# credential path and connection style tools/hermes-game-server-monitor.py
# actually proved live: paramiko + the "Zomboid Admin - muncraft" Vaultwarden
# item (user `zomboid-admin`), fetched via tools/vault-get-secret.sh, not an
# assumed ambient SSH key.
#
# Minecraft has no equivalent of Zomboid's stdin-console FIFO — its admin
# surface is RCON (rcon.port=25575 in server.properties), which
# hermes-game-server-monitor.py already speaks (a from-scratch minimal
# Source RCON client, since `mcrcon` is not installed on the box and the
# port is 127.0.0.1-only, so the RCON call has to run *on* the box over SSH
# rather than connecting to it directly from here — same reasoning as that
# monitor's own comment). That client is reused verbatim below; every
# subcommand in this tool is just a different RCON command string sent
# through it. Unlike the Zomboid FIFO (plain text, one command per line,
# genuinely shell-adjacent), RCON is a length-prefixed binary protocol — the
# command text is never interpolated into a shell string at any point in
# this tool's path (it's Python `repr()`-embedded into a script sent over
# SSH stdin, then written as one binary packet), so there is no FIFO-style
# newline-injection surface to guard against the way
# hermes-zomboid-admin.sh's 1.6.0 fix needed. Player-facing arguments are
# still validated below (see _valid_player_name/_reject_unsafe_text) as
# defense in depth and to fail loud on a typo rather than sending Minecraft
# a command it will silently misparse.
#
# WHAT'S ACTUALLY BEEN VERIFIED LIVE, AND WHAT HASN'T:
#   - RCON auth + a real command (`list`) round-tripping via `zomboid-admin`
#     over SSH to 127.0.0.1:25575, reading rcon.password out of
#     /opt/minecraft/server.properties: proven live, repeatedly, by
#     hermes-game-server-monitor.py's own daily runs.
#   - Every *other* RCON command below (whitelist/op/kick/ban/say/save-all)
#     was written from Minecraft's documented vanilla command syntax, not
#     re-verified against this specific box. Low-risk (RCON commands are the
#     same ones the server console accepts, and vanilla Minecraft's command
#     parser hasn't changed shape across recent versions), but treat the
#     first real use of each as a smoke test, not an assumed-working action.
#   - start/stop/restart go through `sudo -n systemctl <action>
#     minecraft.service`. skills/zomboid-admin/SKILL.md documents
#     `zomboid-admin`'s actual sudoers grant (/etc/sudoers.d/zomboid-admin)
#     as scoped ONLY to zomboid.service systemctl/journalctl commands —
#     minecraft.service is NOT in that list. Until The Boss extends that
#     drop-in, expect start/stop/restart here to fail with a sudo
#     permission error, not a crash — that failure is expected and
#     informative, not a bug in this tool.
#
# Requires: tools/vault-get-secret.sh reachable and the "Zomboid Admin -
# muncraft" Vaultwarden item populated (same credential
# hermes-game-server-monitor.py already depends on — no new secret needed).
# No credentials are hardcoded here.
from __future__ import annotations

import argparse
import datetime
import glob
import os
import subprocess
import sys
import time
from pathlib import Path

try:
    import paramiko
except ImportError:
    paramiko = None

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_SCRIPT = REPO_DIR / "tools" / "vault-get-secret.sh"
VAULT_ITEM = "Zomboid Admin - muncraft"

HOST = "192.168.1.221"
CONNECT_TIMEOUT = 10
EXEC_TIMEOUT = 20

# --- Firmament bot-sandbox instance -----------------------------------------
# Direct request, 2026-09-09 ("add this task to the minecraft admin tool/skill on the Fleet"):
# a SEPARATE Minecraft server instance on the SAME box (192.168.1.221) from the one this file was
# originally built for -- minecraft-bots.service (port 25580, offline-mode, no RCON), not
# minecraft.service (port 25565, RCON-managed, the real survival server with a real human player).
# Confirmed live while re-initializing the bot world by hand: it runs as `zomboid-admin` (the
# SAME account this file already authenticates as -- WorkingDirectory=/home/zomboid-admin/
# minecraft-bots, owned by that account directly, not muncraft:muncraft like the main server), but
# `systemctl stop/restart minecraft-bots` still fails with "Access denied" even so -- managing a
# SYSTEM unit needs root regardless of which user the unit's own process runs as. Since the
# process itself runs as zomboid-admin, killing it directly (a user can always signal their own
# process) and letting the unit's own Restart=always bring it back up works without ever needing
# systemctl access -- confirmed live, this is not a theoretical fallback.
#
# The per-bot Node.js clients (minecraft-bot-<name>.service, one per persona: Babs/Amy/Mark/Luke/
# Mayor as of 2026-09-08, MORE ADDED SINCE) run on a DIFFERENT host entirely -- the Spark
# (dgx-spark), not this box. This tool is meant to run there (same assumption
# tools/vault-get-secret.sh and every other spark-hosted hermes-*.py wrapper already makes), so
# those steps use plain local systemctl/file calls, no second SSH hop.
#
# Direct instruction, 2026-09-09: "make sure the tool does not ASSUME the existing bots. it needs
# to DISCOVER the existing bots and handle them dynamically." The bot roster is NEVER hardcoded
# here -- discover_bot_units() queries systemd directly (glob "minecraft-bot-*.service", the
# per-instance naming convention -- deliberately excludes "minecraft-bots*.service", the plural
# server + its own companion services) every time, so a bot added or removed from the fleet after
# this file was last edited is picked up automatically, with zero code change needed.
BOTS_DIR_REMOTE = "/home/zomboid-admin/minecraft-bots"
BOTS_SERVICE = "minecraft-bots"
BOT_UNIT_GLOB = "minecraft-bot-*.service"
BEDS_DIR = "/mnt/hermes-data/minecraft-memory/beds"
SANDBOX_RESTART_TIMEOUT_S = 60
SANDBOX_RESTART_POLL_S = 5

# Minimal Source RCON client (same protocol Minecraft and Source-engine
# games use), run *on* the remote box against 127.0.0.1 — copied from
# tools/hermes-game-server-monitor.py's _RCON_PY rather than shared via
# import, matching that file's own note that it deliberately never connects
# to 25575 from off-box even though the live *:25575 bind currently allows
# it, so this tool doesn't come to depend on (or quietly normalize) the
# insecure binding that monitor flags as a standing finding. {command!r}
# below is a Python repr() substitution, not string interpolation into a
# shell command — it produces a correctly-quoted Python string literal
# inside the script text, so a command containing quotes/backslashes still
# round-trips correctly and cannot break out of the generated script.
_RCON_TEMPLATE = r'''
import socket, struct, sys

def send_packet(sock, pkt_id, pkt_type, body):
    payload = struct.pack("<ii", pkt_id, pkt_type) + body.encode() + b"\x00\x00"
    sock.send(struct.pack("<i", len(payload)) + payload)

def read_packet(sock):
    length = struct.unpack("<i", sock.recv(4))[0]
    data = b""
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            break
        data += chunk
    pkt_id, pkt_type = struct.unpack("<ii", data[:8])
    body = data[8:-2].decode(errors="replace")
    return pkt_id, pkt_type, body

password = open("/opt/minecraft/server.properties").read()
password = [l for l in password.splitlines() if l.startswith("rcon.password=")][0].split("=", 1)[1]

s = socket.create_connection(("127.0.0.1", 25575), timeout=8)
send_packet(s, 1, 3, password)
auth_id, _, _ = read_packet(s)
if auth_id == -1:
    print("RCON_AUTH_FAILED")
    sys.exit(1)
send_packet(s, 2, 2, {command!r})
_, _, body = read_packet(s)
print("RCON_OK:" + body.replace("\n", " "))
s.close()
'''


def vault_get(field: str) -> str:
    # No VAULT_NODE set deliberately: this host's /etc/hermes/vault-node-name
    # defaults to "sintra", the same fallthrough hermes-game-server-monitor.py
    # already relies on for this exact vault item.
    for _ in range(2):
        try:
            result = subprocess.run([str(VAULT_SCRIPT), VAULT_ITEM, field],
                                     capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


def connect():
    if paramiko is None:
        sys.exit("ERROR: paramiko is not installed (pip install paramiko)")
    user = vault_get("username")
    password = vault_get("password")
    if not user or not password:
        sys.exit(f"ERROR: could not fetch credentials from vault item '{VAULT_ITEM}'")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=user, password=password, timeout=CONNECT_TIMEOUT)
    return client


def run(client, cmd: str, timeout: int = EXEC_TIMEOUT):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    return out.strip(), err.strip()


def rcon(client, command: str) -> str:
    """Send one RCON command, return the server's response text. Exits with
    an error message (not a traceback) on auth failure or no response, since
    every caller below just wants to print the result or fail loudly."""
    script = _RCON_TEMPLATE.format(command=command)
    stdin, stdout, stderr = client.exec_command("python3 -", timeout=EXEC_TIMEOUT)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode(errors="replace").strip()
    err = stderr.read().decode(errors="replace").strip()
    if out.startswith("RCON_OK:"):
        return out[len("RCON_OK:"):].strip()
    if out == "RCON_AUTH_FAILED":
        sys.exit("ERROR: RCON auth failed — rcon.password in server.properties may be stale")
    sys.exit(f"ERROR: RCON command failed: {err or out or 'no response'}")


# --- input validation ---------------------------------------------------
# Real Minecraft/Mojang usernames are 3-16 chars of [A-Za-z0-9_] — enforced
# here before a name ever reaches an RCON command string, both to fail loud
# on an obvious typo and as defense in depth (mirrors
# hermes-zomboid-admin.sh's reject_unsafe_console_arg, adapted to RCON's
# different threat shape — see the module docstring above for why RCON
# itself has no FIFO-style injection path).
def _valid_player_name(name: str) -> bool:
    import re
    return bool(re.fullmatch(r"[A-Za-z0-9_]{1,16}", name))


def _reject_unsafe_text(value: str, label: str) -> str:
    if "\x00" in value or "\n" in value or "\r" in value:
        sys.exit(f"ERROR: {label} contains a null byte or newline — refused")
    return value


def _require_player_name(name: str) -> str:
    if not _valid_player_name(name):
        sys.exit(f"ERROR: '{name}' is not a valid Minecraft username "
                  f"(3-16 chars, letters/digits/underscore) — refused")
    return name


# --- subcommands ----------------------------------------------------------
def cmd_status(client, args):
    active, _ = run(client, "systemctl is-active minecraft.service minecraft-monitor.service "
                             "minecraft-backup.service 2>/dev/null")
    states = active.splitlines()
    print("=== minecraft.service ===")
    print(f"  service: {states[0] if states else 'unknown'}")
    print(f"  box-local monitor: {states[1] if len(states) > 1 else 'unknown'}")
    print(f"  backup timer unit: {states[2] if len(states) > 2 else 'unknown'}")

    ps_out, _ = run(client, "ps -C java -o rss,%cpu,etime --no-headers")
    if ps_out:
        rss, cpu, etime = ps_out.split(None, 2)
        print(f"  process: {int(rss) // 1024}MB RAM, {cpu}% CPU, up {etime}")
    else:
        print("  process: NOT FOUND")

    disk_out, _ = run(client, "df -h /opt/minecraft --output=used,size,pcent | tail -1")
    print(f"  disk: {disk_out}")

    print()
    print("=== players ===")
    print(rcon(client, "list"))


def cmd_players(client, args):
    print(rcon(client, "list"))


def cmd_whitelist(client, args):
    if args.action == "list":
        print(rcon(client, "whitelist list"))
    elif args.action == "reload":
        print(rcon(client, "whitelist reload"))
    else:
        name = _require_player_name(args.name)
        print(rcon(client, f"whitelist {args.action} {name}"))


def cmd_op(client, args):
    name = _require_player_name(args.name)
    print(rcon(client, f"op {name}"))


def cmd_deop(client, args):
    name = _require_player_name(args.name)
    print(rcon(client, f"deop {name}"))


def cmd_kick(client, args):
    name = _require_player_name(args.name)
    if args.reason:
        reason = _reject_unsafe_text(args.reason, "reason")
        print(rcon(client, f"kick {name} {reason}"))
    else:
        print(rcon(client, f"kick {name}"))


def cmd_ban(client, args):
    name = _require_player_name(args.name)
    if args.reason:
        reason = _reject_unsafe_text(args.reason, "reason")
        print(rcon(client, f"ban {name} {reason}"))
    else:
        print(rcon(client, f"ban {name}"))


def cmd_pardon(client, args):
    name = _require_player_name(args.name)
    print(rcon(client, f"pardon {name}"))


def cmd_say(client, args):
    message = _reject_unsafe_text(args.message, "message")
    print(rcon(client, f"say {message}"))


def cmd_save(client, args):
    print(rcon(client, "save-all"))


def cmd_console(client, args):
    command = _reject_unsafe_text(args.command, "command")
    print(rcon(client, command))


def cmd_lifecycle(client, args):
    # See the module docstring: zomboid-admin's documented sudoers grant
    # (skills/zomboid-admin/SKILL.md) is scoped to zomboid.service only, not
    # minecraft.service. This will very likely fail with a sudo permission
    # error until that drop-in is extended — that is an expected, correctly
    # surfaced result, not a bug in this command.
    out, err = run(client, f"sudo -n systemctl {args.action} minecraft.service")
    if err:
        print(err, file=sys.stderr)
    out2, _ = run(client, "sudo -n systemctl is-active minecraft.service")
    print(f"minecraft.service: {out2 or 'unknown'}")


# --- bot-sandbox subcommands (minecraft-bots.service, see module docstring) -----------------
def discover_bot_units() -> list[str]:
    """The real, current bot roster -- queried from systemd every call, never a hardcoded list.
    Local (this tool is meant to run on the Spark, where the per-bot units actually live)."""
    result = subprocess.run(
        ["systemctl", "list-units", "--all", "--type=service", "--plain", "--no-legend", BOT_UNIT_GLOB],
        capture_output=True, text=True, timeout=15,
    )
    units = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if parts and parts[0].endswith(".service"):
            units.append(parts[0])
    return sorted(units)


def cmd_bots_list(client, args):
    units = discover_bot_units()
    if not units:
        print(f"No {BOT_UNIT_GLOB} units found on this host.")
        return
    print(f"Discovered {len(units)} bot unit(s):")
    for unit in units:
        active = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True).stdout.strip()
        print(f"  {unit}: {active or 'unknown'}")


def cmd_bots_reinit_world(client, args):
    # Direct request, 2026-09-09: "re-init the world using seed <N>," now a repeatable admin
    # action instead of a one-off manual sequence. Mirrors that live sequence exactly: fresh
    # backup first, rename the old world aside (never delete -- recoverable if this was a
    # mistake), set the seed, restart the sandbox server the only way this account actually can
    # (kill its own process, not systemctl), clear stale claimed-bed files (old-world
    # coordinates), restart every DISCOVERED bot client.
    seed = _reject_unsafe_text(args.seed, "seed") if args.seed else None

    units = discover_bot_units()
    if not units:
        sys.exit(f"ERROR: no {BOT_UNIT_GLOB} units discovered on this host -- refusing to "
                  f"proceed without knowing which bots to stop/restart")
    print(f"Discovered {len(units)} bot unit(s): {', '.join(units)}")

    print("Stopping bot clients...")
    subprocess.run(["sudo", "systemctl", "stop", *units], check=False)

    print("Backing up the current bot-sandbox world...")
    out, err = run(client, f"cd {BOTS_DIR_REMOTE} && ./backup.sh 2>&1", timeout=60)
    print(out or err or "(no backup output)")

    level_name_line, _ = run(client, f"grep '^level-name=' {BOTS_DIR_REMOTE}/server.properties")
    level_name = level_name_line.split("=", 1)[1].strip() if "=" in level_name_line else "world"

    ts = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    backup_dirname = f"{level_name}.bak-{ts}"
    print(f"Renaming current world '{level_name}' aside as '{backup_dirname}' (not deleted)...")
    run(client, f"mv {BOTS_DIR_REMOTE}/{level_name} {BOTS_DIR_REMOTE}/{backup_dirname}")

    if seed:
        run(client, f"sed -i 's/^level-seed=.*/level-seed={seed}/' {BOTS_DIR_REMOTE}/server.properties")
        print(f"Set level-seed={seed}")
    else:
        run(client, f"sed -i 's/^level-seed=.*/level-seed=/' {BOTS_DIR_REMOTE}/server.properties")
        print("Cleared level-seed -- the server will generate a fresh random seed")

    pid, _ = run(client, f"systemctl show {BOTS_SERVICE} -p MainPID --value")
    pid = pid.strip()
    if not pid or pid == "0":
        sys.exit(f"ERROR: could not find the running PID for {BOTS_SERVICE}.service -- "
                  f"aborting before restart (the world dir has already been renamed and the "
                  f"seed already set; rerun once the service is confirmed running)")
    print(f"Restarting the bot-sandbox server (killing PID {pid} -- Restart=always brings it back)...")
    run(client, f"kill {pid}")

    print("Waiting for the sandbox server to come back up with the new world...")
    for _ in range(SANDBOX_RESTART_TIMEOUT_S // SANDBOX_RESTART_POLL_S):
        time.sleep(SANDBOX_RESTART_POLL_S)
        status, _ = run(client, f"systemctl is-active {BOTS_SERVICE}")
        if status.strip() == "active":
            break
    else:
        print(f"WARNING: {BOTS_SERVICE}.service did not report active within "
              f"{SANDBOX_RESTART_TIMEOUT_S}s -- check it manually before restarting the bots")

    print("Clearing stale claimed-bed files (they name old-world coordinates)...")
    for bed_file in glob.glob(os.path.join(BEDS_DIR, "*.json")):
        os.remove(bed_file)

    print(f"Restarting {len(units)} bot client(s)...")
    subprocess.run(["sudo", "systemctl", "start", *units], check=False)
    time.sleep(3)
    for unit in units:
        active = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True).stdout.strip()
        print(f"  {unit}: {active or 'unknown'}")

    seed_note = f"seed {seed}" if seed else "a fresh random seed"
    print(f"Done. World reinitialized with {seed_note}. Previous world preserved as {backup_dirname}.")


def build_parser():
    p = argparse.ArgumentParser(description="Remote admin for the Minecraft server on 192.168.1.221")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Service state, process, disk, players").set_defaults(func=cmd_status)
    sub.add_parser("players", help="List connected players (RCON 'list')").set_defaults(func=cmd_players)

    wl = sub.add_parser("whitelist", help="Manage the whitelist")
    wl.add_argument("action", choices=["list", "reload", "add", "remove"])
    wl.add_argument("name", nargs="?", help="Required for add/remove")
    wl.set_defaults(func=cmd_whitelist)

    op = sub.add_parser("op", help="Grant operator status")
    op.add_argument("name")
    op.set_defaults(func=cmd_op)

    deop = sub.add_parser("deop", help="Revoke operator status")
    deop.add_argument("name")
    deop.set_defaults(func=cmd_deop)

    kick = sub.add_parser("kick", help="Kick a player")
    kick.add_argument("name")
    kick.add_argument("reason", nargs="?", default="")
    kick.set_defaults(func=cmd_kick)

    ban = sub.add_parser("ban", help="Ban a player")
    ban.add_argument("name")
    ban.add_argument("reason", nargs="?", default="")
    ban.set_defaults(func=cmd_ban)

    pardon = sub.add_parser("pardon", help="Unban a player")
    pardon.add_argument("name")
    pardon.set_defaults(func=cmd_pardon)

    say = sub.add_parser("say", help="Broadcast a message to all players")
    say.add_argument("message")
    say.set_defaults(func=cmd_say)

    sub.add_parser("save", help="Force-save the world now (save-all)").set_defaults(func=cmd_save)

    console = sub.add_parser("console", help="Send any raw RCON command verbatim")
    console.add_argument("command")
    console.set_defaults(func=cmd_console)

    for action in ("start", "stop", "restart"):
        lp = sub.add_parser(action, help=f"systemctl {action} minecraft.service (needs sudo grant — see Notes)")
        lp.set_defaults(func=cmd_lifecycle, action=action)

    bots = sub.add_parser("bots", help="Manage the Firmament bot-sandbox instance "
                                        "(minecraft-bots.service, port 25580) and its bot clients")
    bots_sub = bots.add_subparsers(dest="bots_cmd", required=True)

    bots_sub.add_parser("list", help="Discover and list the current minecraft-bot-*.service "
                                      "units (never hardcoded)").set_defaults(func=cmd_bots_list)

    reinit = bots_sub.add_parser("reinit-world", help="Back up, wipe, and regenerate the bot-"
                                  "sandbox world; restarts every discovered bot client")
    reinit.add_argument("seed", nargs="?", default=None,
                         help="New level-seed (omit for a fresh random seed)")
    reinit.set_defaults(func=cmd_bots_reinit_world)

    return p


def main() -> int:
    args = build_parser().parse_args()
    client = connect()
    try:
        args.func(client, args)
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
