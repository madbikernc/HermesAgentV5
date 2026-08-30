#!/usr/bin/env python3
# Version: 1.5.0
#
# 1.5.0 — security-review fix: vault_get()/vault_get_email_password() now
# catch subprocess.TimeoutExpired instead of crashing on a complete
# Vaultwarden outage.
"""
hermes-game-server-monitor.py — Daily health check for every known game
server on the muncraft box (192.168.1.221): silent when healthy, emails
notifications@canislupisnc.net only when something's actually wrong. Same
silent-unless-issues discipline as v1's minecraft-health-cron.sh, extended
to cover Project Zomboid too (not part of v1 at all — that server didn't
exist in v1's era).

Phase 26 (IMPLEMENTATION_PLAN.md §7). Ported from v1
(../HermesAgent/scripts/minecraft-monitor.sh, minecraft-health-cron.sh),
which assumed exactly one Minecraft instance under /opt/minecraft with
RCON on 25575 and a companion minecraft-monitor.service — confirmed still
literally true by connecting to the live box (2026-08-12), not assumed:
`systemctl list-units` there shows exactly minecraft.service,
minecraft-monitor.service, minecraft-backup.service, and zomboid.service —
one of each, no hidden second instance.

Real access/credential finding while building this: v1's scripts (and this
project's own tools/hermes-zomboid-admin.sh) assume ambient `ssh $HOST`
access with no explicit user or key. No such ambient access exists for any
current identity (pmoney/sintra/amy all get "Permission denied
(publickey,password)" against 192.168.1.221) — the real, working credential
is Vaultwarden item "Zomboid Admin - muncraft" (user `zomboid-admin`,
password auth, secondary member of the `muncraft` group). This means
hermes-zomboid-admin.sh has almost certainly never actually run
successfully as committed. Not fixed here (out of scope for a monitoring
tool) but flagged plainly — see IMPLEMENTATION_PLAN.md §7 Phase 26.

`zomboid-admin` has no passwordless sudo (confirmed live: `sudo -n
systemctl ...`/`sudo -n journalctl ...` both fail) — unlike
hermes-zomboid-admin.sh, every check here deliberately uses only what a
plain, unprivileged SSH session can already do without sudo: `systemctl
is-active`/`status` (this host's polkit allows status queries for all
local users), `ps`, `df`, directory listings, and a direct RCON socket
connection to Minecraft's own 127.0.0.1:25575 (using the real
rcon.password read straight out of server.properties, which the
`muncraft` group membership makes group-readable). Zomboid's own RCON is
disabed on this install (blank RCONPassword — see hermes-zomboid-admin.sh's
header) so player-count-style checks aren't attempted for it here; a
Zomboid health check is limited to service/process/resource/disk, which is
everything that's actually reachable without sudo or a working RCON.

Two real findings surfaced on the first live investigation, both reported
by this tool every run until resolved (not one-off notices):
  - Minecraft's RCON is configured `rcon.ip=127.0.0.1` in server.properties
    but is actually listening on `*:25575` (confirmed via `ss -tln` on the
    live box) — every interface, not just loopback. Vanilla Minecraft is
    known not to reliably honor rcon.ip as a bind-address restriction; this
    is a real, currently-live exposure, not a config typo waiting to be
    read correctly.
  - Zomboid had no backup mechanism at all — unlike Minecraft's daily
    03:00 cron-driven backup.sh, `find /opt/zomboid -iname '*backup*'`
    turned up nothing except an unrelated leftover .sh.bak file.

1.1.0 (2026-08-12, Phase 27, direct request: "setup a backup for Zomboid,
in the same style as the minecraft backups"): the Zomboid-backups check
above is no longer a standing "none exists" notice — `zomboid-backup.sh` +
`zomboid-backup.timer` now exist (see infra/zomboid-backup/README.md,
styled directly on Minecraft's own backup.sh), so this now checks real
backup freshness/count the same way check_minecraft() already did, and
CRITICALs plainly if the backups directory is still empty (most likely
meaning the timer hasn't been installed yet — that half needed a human
with real root/muncraft access; `zomboid-admin`'s sudo grant, confirmed
live via `sudo -l`, covers only zomboid.service's own lifecycle, nothing
that can write to /etc/systemd/system/).

1.2.0 (2026-08-12, Phase 29, direct request: review the box's UFW rules so
only the games' own connect ports are open to Anywhere, and everything
else — SSH, RCON, anything — is restricted to 10.129.1.x/Tailscale only,
with a violation recorded as a FAILURE): added check_firewall(). Currently
always reports "cannot verify" — thoroughly checked live that no
credential capable of reading UFW exists anywhere (zomboid-admin has no
sudo/file access to it; no muncraft credential exists in Vaultwarden, as
an attachment on any item, or as a key file anywhere on the Spark or its
pre-migration backup) — and The Boss's direct call was to leave it a
manual check (`sudo ufw status verbose`) rather than grant broader access.
The parsing/evaluation logic is fully built and ready to activate the
moment real access exists; see check_firewall()'s own docstring for the
three-way live-confirmed access gap. The standing "cannot verify" state
deliberately does not drive the daily email on its own (see main()) — only
an actual detected violation does.

1.3.0 (2026-08-12, direct follow-up: "can you just run the checks in a
root-owned process, to get visibility to ufw?"): check_firewall() now
actually runs, reading a periodic dump instead of attempting live sudo.
`infra/muncraft-ufw-dump/ufw-status-dump.timer` runs `ufw status verbose`
as root every 15 minutes on the muncraft box and writes it to
`/opt/zomboid/server/.ufw-status.txt` (`640 root:muncraft`) — readable by
`zomboid-admin` via its existing `muncraft` group membership, so this
grants that account read visibility into the ruleset without granting any
new *capability* (no sudo widened, no new credential). Needs the same
one-time manual root install `infra/zomboid-backup/` needed (Hermes has no
path to install a systemd unit on that box itself) — see
`infra/muncraft-ufw-dump/README.md`.

1.4.0 (2026-08-12, same day, once the dump timer was installed and this
check ran against the real ruleset for the first time): fixed a real
parser bug and tuned two real policy exceptions, both confirmed against
live output rather than assumed. The bug: UFW's real output carries
trailing "# reason" comments on rules (e.g. "10.129.1.0/24    # SSH admin
subnet") that the regex's greedy capture pulled into the source field,
making `ipaddress.ip_network()` fail to parse an otherwise-legitimate CIDR
and report it as an unrestricted violation purely because of the comment
text — fixed by stripping everything from "#" onward before parsing. The
two exceptions, both confirmed with The Boss before adding rather than
assumed: `192.168.1.215` (pfSense's own DMZ-side IP, per the pfSense
integration's network-topology reference — SSH admin traffic from the
fleet's LAN gets NAT-hairpinned through the router and arrives here as
that address, not the original 10.129.1.x source) added to
UFW_ALLOWED_SOURCE_NETS; `25566/tcp` ("Minecraft Paper" per the rule's own
UFW comment — a real second Minecraft instance, not a stale rule) added to
GAME_PORTS_GLOBAL_OK.

Usage:
  hermes-game-server-monitor.py             # real run: check, email if issues, exit 1 if any
  hermes-game-server-monitor.py --dry-run   # print instead of emailing
"""
import argparse
import ipaddress
import re
import smtplib
import subprocess
import sys
from datetime import datetime, timezone
from email.mime.text import MIMEText
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

EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

DISK_WARN_PCT = 80
BACKUP_STALE_HOURS = 30  # Minecraft's backup.sh runs daily at 03:00

# Only these ranges are acceptable sources for a non-game port's ALLOW
# rule: this fleet's own LAN, Tailscale's CGNAT range, and pfSense's own
# DMZ-side IP. Anything else (starting with UFW's own "Anywhere"/0.0.0.0::0
# default) is a FAILURE per direct request, 2026-08-12: "an SSH, RCON, or
# other non-game-specific port is not firewalled to ONLY 10.129.1.x and
# tailscale IPs must be recorded as a FAILURE."
UFW_ALLOWED_SOURCE_NETS = [
    ipaddress.ip_network("10.129.1.0/24"),
    ipaddress.ip_network("100.64.0.0/10"),  # Tailscale's CGNAT range
    # pfSense's own DMZ-side interface (igc0, per the pfSense integration's
    # network-topology reference) — confirmed 2026-08-12 against this
    # box's real live UFW rules (SSH allowed from both 10.129.1.0/24 and
    # this single IP): admin SSH from the fleet's LAN gets NAT-hairpinned
    # through the router and arrives here as pfSense's own address, not
    # the original 10.129.1.x source. The Boss confirmed this is the real,
    # intended admin path, not a stray exposure.
    ipaddress.ip_network("192.168.1.215/32"),
]

# The only ports a global (Anywhere) ALLOW rule is expected/acceptable for
# — everything else must be source-restricted. Zomboid's pair confirmed
# live via `ss -ulnp` (0.0.0.0:16261, 0.0.0.0:16261+1 — direct-connect and
# Steam); Minecraft's primary is read dynamically from server.properties in
# check_firewall() below rather than hardcoded, since that value is a
# config a person could change. 25566/tcp added 2026-08-12 after the real
# live UFW dump showed it tagged "# Minecraft Paper" — The Boss confirmed
# it's a real second Minecraft (Paper) instance, not a stale rule.
GAME_PORTS_GLOBAL_OK = {
    ("16261", "udp"): "Zomboid game port",
    ("16262", "udp"): "Zomboid game port",
    ("25566", "tcp"): "Minecraft Paper game port",
}

# ufw's "app profile" names appear in `ufw status` instead of a raw port
# when the rule was added via `ufw allow OpenSSH` rather than `ufw allow
# 22/tcp` — mapped here so those rules aren't silently skipped as
# unparseable.
UFW_APP_PORT_MAP = {
    "openssh": ("22", "tcp"),
}

_UFW_RULE_RE = re.compile(r"^(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)\s+(.+)$")

# Minimal Source RCON client (same protocol Minecraft and Source-engine
# games use), run *on* the remote box against 127.0.0.1 — deliberately not
# connected to directly from here even though the live *:25575 bind would
# currently allow it, so this tool doesn't come to depend on (or quietly
# normalize) the insecure binding this same run flags as a finding.
_RCON_PY = r'''
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
send_packet(s, 2, 2, "list")
_, _, body = read_packet(s)
print("RCON_OK:" + body.replace("\n", " "))
s.close()
'''


def check(name, status, detail=""):
    return {"name": name, "status": status, "detail": detail}


def vault_get(field):
    # No VAULT_NODE set deliberately: this host's /etc/hermes/vault-node-name
    # defaults to "sintra", the same fallthrough hermes_pfsense_common.py's
    # vault_get() already relies on for pmoney-run tools reaching a shared
    # Fleet-Service vault item.
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
    user = vault_get("username")
    password = vault_get("password")
    if not user or not password:
        raise RuntimeError(f"could not fetch credentials from vault item '{VAULT_ITEM}'")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=user, password=password, timeout=CONNECT_TIMEOUT)
    return client


def run(client, cmd, timeout=EXEC_TIMEOUT):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    return out.strip(), err.strip()


def check_minecraft(client):
    checks = []

    active, _ = run(client, "systemctl is-active minecraft.service minecraft-monitor.service "
                             "minecraft-backup.service")
    states = active.splitlines()
    mc_state = states[0] if len(states) > 0 else "unknown"
    monitor_state = states[1] if len(states) > 1 else "unknown"
    checks.append(check("Minecraft service", "ok" if mc_state == "active" else "critical", mc_state))
    checks.append(check("Minecraft box-local monitor", "ok" if monitor_state == "active" else "warn",
                         monitor_state))

    ps_out, _ = run(client, "ps -C java -o rss,%cpu,etime --no-headers")
    if ps_out:
        rss, cpu, etime = ps_out.split(None, 2)
        checks.append(check("Minecraft process", "ok",
                             f"{int(rss) // 1024}MB RAM, {cpu}% CPU, up {etime}"))
    else:
        checks.append(check("Minecraft process", "critical", "no java process found"))

    disk_out, _ = run(client, "df --output=pcent /opt/minecraft | tail -1")
    pct = int(re.sub(r"\D", "", disk_out) or 0)
    checks.append(check("Minecraft disk usage", "warn" if pct > DISK_WARN_PCT else "ok", f"{pct}%"))

    backups_out, _ = run(client, "ls -t /opt/minecraft/backups/world_*.tar.gz 2>/dev/null")
    backup_files = [f for f in backups_out.splitlines() if f]
    if not backup_files:
        checks.append(check("Minecraft backups", "critical", "no backup files found"))
    else:
        mtime_out, _ = run(client, f"stat -c %Y {backup_files[0]}")
        try:
            age_hours = (datetime.now(timezone.utc).timestamp() - int(mtime_out)) / 3600
            status = "warn" if age_hours > BACKUP_STALE_HOURS else "ok"
            checks.append(check("Minecraft backups", status,
                                 f"{len(backup_files)} file(s), latest {age_hours:.1f}h ago"))
        except ValueError:
            checks.append(check("Minecraft backups", "unknown",
                                 f"{len(backup_files)} file(s), could not read latest mtime"))

    stdin, stdout, stderr = client.exec_command("python3 -", timeout=EXEC_TIMEOUT)
    stdin.write(_RCON_PY)
    stdin.channel.shutdown_write()
    rcon_out = stdout.read().decode(errors="replace").strip()
    rcon_err = stderr.read().decode(errors="replace").strip()
    if rcon_out.startswith("RCON_OK:"):
        checks.append(check("Minecraft RCON", "ok", rcon_out[len("RCON_OK:"):].strip() or "responded"))
    elif rcon_out == "RCON_AUTH_FAILED":
        checks.append(check("Minecraft RCON", "critical",
                             "auth failed — rcon.password in server.properties may be stale"))
    else:
        checks.append(check("Minecraft RCON", "critical", rcon_err or "no response"))

    # Real finding, checked every run rather than assumed fixed: rcon.ip=127.0.0.1
    # is the configured intent, but Minecraft doesn't reliably enforce it as an
    # actual bind restriction. ss doesn't need root to read listening sockets.
    ss_out, _ = run(client, "ss -tln")
    bound_all = bool(re.search(r"^\S+\s+\d+\s+\d+\s+\*:25575\s", ss_out, re.M)) or ":25575" in ss_out and "127.0.0.1:25575" not in ss_out
    bound_local_only = "127.0.0.1:25575" in ss_out and not bound_all
    if bound_local_only:
        checks.append(check("Minecraft RCON binding", "ok", "127.0.0.1:25575 only"))
    else:
        checks.append(check("Minecraft RCON binding", "warn",
                             "listening on all interfaces, not just 127.0.0.1 — "
                             "rcon.ip=127.0.0.1 in server.properties is not being enforced"))

    return checks


def check_zomboid(client):
    checks = []

    active, _ = run(client, "systemctl is-active zomboid.service")
    checks.append(check("Zomboid service", "ok" if active == "active" else "critical", active))

    ps_out, _ = run(client, "ps -C ProjectZomboid64 -o rss,%cpu,etime --no-headers")
    if ps_out:
        rss, cpu, etime = ps_out.split(None, 2)
        checks.append(check("Zomboid process", "ok",
                             f"{int(rss) // 1024}MB RAM, {cpu}% CPU, up {etime}"))
    else:
        checks.append(check("Zomboid process", "critical", "no ProjectZomboid64 process found"))

    disk_out, _ = run(client, "df --output=pcent /opt/zomboid | tail -1")
    pct = int(re.sub(r"\D", "", disk_out) or 0)
    checks.append(check("Zomboid disk usage", "warn" if pct > DISK_WARN_PCT else "ok", f"{pct}%"))

    # Phase 27 (2026-08-12) added zomboid-backup.sh + .timer, styled on
    # Minecraft's own backup.sh/minecraft-backup.timer — see
    # infra/zomboid-backup/README.md. Same freshness/count check as
    # check_minecraft()'s backup check, now that there's a real mechanism
    # to check instead of a standing "none exists" notice.
    backups_out, _ = run(client, "ls -t /opt/zomboid/server/backups/zomboid_*.tar.gz 2>/dev/null")
    backup_files = [f for f in backups_out.splitlines() if f]
    if not backup_files:
        checks.append(check("Zomboid backups", "critical",
                             "no backup files found — zomboid-backup.timer may not be installed "
                             "yet (see infra/zomboid-backup/README.md)"))
    else:
        mtime_out, _ = run(client, f"stat -c %Y {backup_files[0]}")
        try:
            age_hours = (datetime.now(timezone.utc).timestamp() - int(mtime_out)) / 3600
            status = "warn" if age_hours > BACKUP_STALE_HOURS else "ok"
            checks.append(check("Zomboid backups", status,
                                 f"{len(backup_files)} file(s), latest {age_hours:.1f}h ago"))
        except ValueError:
            checks.append(check("Zomboid backups", "unknown",
                                 f"{len(backup_files)} file(s), could not read latest mtime"))

    return checks


def _parse_ufw_to_spec(to_spec: str):
    """'22/tcp' -> ('22','tcp',False); '22/tcp (v6)' -> ('22','tcp',True);
    'OpenSSH' -> ('22','tcp',False) via UFW_APP_PORT_MAP. Returns
    (None, None, is_v6) if the spec can't be mapped to a port/proto."""
    is_v6 = "(v6)" in to_spec
    spec = to_spec.replace("(v6)", "").strip()
    mapped = UFW_APP_PORT_MAP.get(spec.lower())
    if mapped:
        return mapped[0], mapped[1], is_v6
    if "/" in spec:
        port, proto = spec.split("/", 1)
        return port.strip(), proto.strip().lower(), is_v6
    return None, None, is_v6


def _source_is_restricted(from_spec: str) -> bool:
    """True only if from_spec is entirely inside 10.129.1.0/24 or
    Tailscale's CGNAT range. UFW's "Anywhere"/"Anywhere (v6)" (no source
    restriction at all) and anything unparseable both fail closed —
    if we can't positively confirm it's restricted, it isn't."""
    from_spec = from_spec.strip()
    if from_spec.lower().startswith("anywhere"):
        return False
    try:
        net = ipaddress.ip_network(from_spec, strict=False)
    except ValueError:
        return False
    return any(net.version == allowed.version and net.subnet_of(allowed)
               for allowed in UFW_ALLOWED_SOURCE_NETS)


def check_firewall(client) -> list:
    """UFW rule review, direct request 2026-08-12: only the game's own
    connect ports may be open to Anywhere; every other ALLOW rule (SSH,
    RCON, anything else) must be restricted to 10.129.1.x/Tailscale only,
    or it's a FAILURE (mapped to this tool's "critical" severity — the
    most severe tier it already uses, matching the user's own word for
    this exact finding).

    `zomboid-admin` (the only credential available for this box — see the
    module docstring) has no direct access to UFW at all, confirmed live
    2026-08-12 three separate ways — `ufw` itself requires root even to
    read status, its sudo grant (`sudo -l`) doesn't cover `ufw`, and
    `/etc/ufw/user.rules` is `640 root:root`, unreadable directly. No
    `muncraft` credential exists anywhere to use instead either. Rather
    than widen `zomboid-admin`'s own sudo grant or add a new broad
    `muncraft` credential, The Boss's direct call (2026-08-12) was a
    root-owned periodic dump instead: `ufw-status-dump.timer` (see
    `infra/muncraft-ufw-dump/README.md`) runs `ufw status verbose` as root
    every 15 minutes and writes it to `/opt/zomboid/server/.ufw-status.txt`
    (`640 root:muncraft`) — readable by `zomboid-admin` via its existing
    `muncraft` group membership, granting that account visibility into the
    ruleset without granting it any new *capability*. Reads that dump file
    here rather than attempting `ufw` directly."""
    DUMP_PATH = "/opt/zomboid/server/.ufw-status.txt"
    DUMP_STALE_MINUTES = 45  # dump timer runs every 15 min; 3x that before calling it stale

    mtime_out, _ = run(client, f"stat -c %Y {DUMP_PATH} 2>/dev/null")
    if not mtime_out:
        return [check("UFW firewall rules", "warn",
                       f"cannot verify — {DUMP_PATH} doesn't exist yet. zomboid-admin has no direct "
                       "UFW access (confirmed live: no sudo grant, rules file unreadable); "
                       "ufw-status-dump.timer hasn't been installed — see "
                       "infra/muncraft-ufw-dump/README.md.")]

    try:
        age_min = (datetime.now(timezone.utc).timestamp() - int(mtime_out)) / 60
    except ValueError:
        age_min = None
    if age_min is not None and age_min > DUMP_STALE_MINUTES:
        return [check("UFW firewall rules", "warn",
                       f"cannot verify — UFW status dump is {age_min:.0f} min old (expected every "
                       "15 min) — ufw-status-dump.timer may be down on the muncraft box.")]

    out, _ = run(client, f"cat {DUMP_PATH}")
    if not out:
        return [check("UFW firewall rules", "warn", f"cannot verify — {DUMP_PATH} exists but is empty")]

    if "Status: active" not in out:
        return [check("UFW firewall", "critical", "UFW is not active")]

    mc_port, _ = run(client, "grep '^server-port=' /opt/minecraft/server.properties")
    game_ports_ok = dict(GAME_PORTS_GLOBAL_OK)
    if "=" in mc_port:
        game_ports_ok[(mc_port.split("=", 1)[1].strip(), "tcp")] = "Minecraft game port"

    failures = []
    for line in out.splitlines():
        m = _UFW_RULE_RE.match(line.strip())
        if not m:
            continue
        to_spec, action, direction, from_spec = m.groups()
        # Real live output (2026-08-12) confirmed rules commonly carry a
        # trailing "# reason" annotation (e.g. "10.129.1.0/24    # SSH
        # admin subnet") — strip it before parsing, or a legitimate CIDR
        # source fails ipaddress.ip_network() and gets reported as an
        # unrestricted violation purely because of the comment text.
        from_spec = from_spec.split("#", 1)[0].strip()
        if action != "ALLOW" or direction != "IN":
            continue
        port, proto, is_v6 = _parse_ufw_to_spec(to_spec)
        if port is None or (port, proto) in game_ports_ok:
            continue
        if not _source_is_restricted(from_spec):
            failures.append(f"{port}/{proto}{' (v6)' if is_v6 else ''} open to '{from_spec}'")

    if failures:
        return [check("UFW firewall rules", "critical",
                       "non-game port(s) not restricted to 10.129.1.x/Tailscale: " + "; ".join(failures))]
    return [check("UFW firewall rules", "ok",
                   "all non-game ALLOW rules restricted to 10.129.1.x/Tailscale")]


def build_report(mc_checks, zb_checks, fw_checks):
    lines = ["Game Server Monitor — muncraft box (192.168.1.221)", ""]
    lines.append("=== Minecraft ===")
    for c in mc_checks:
        lines.append(f"  [{c['status'].upper()}] {c['name']}: {c['detail']}")
    lines.append("")
    lines.append("=== Project Zomboid ===")
    for c in zb_checks:
        lines.append(f"  [{c['status'].upper()}] {c['name']}: {c['detail']}")
    lines.append("")
    lines.append("=== Firewall (box-wide) ===")
    for c in fw_checks:
        lines.append(f"  [{c['status'].upper()}] {c['name']}: {c['detail']}")
    return "\n".join(lines)


def vault_get_email_password():
    try:
        result = subprocess.run([str(VAULT_SCRIPT), "email-sintra", "password"],
                                 capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def send_email(subject, body):
    password = vault_get_email_password()
    if not password:
        print("ERROR: could not fetch email-sintra password from vault", file=sys.stderr)
        return False
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = "mercury@canislupisnc.net"
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login("mercury@canislupisnc.net", password)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"ERROR: email send failed: {e}", file=sys.stderr)
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Daily game server (Minecraft + Zomboid) health check")
    parser.add_argument("--dry-run", action="store_true", help="Print instead of emailing")
    args = parser.parse_args()

    if paramiko is None:
        print("ERROR: paramiko not available", file=sys.stderr)
        return 1

    try:
        client = connect()
    except Exception as e:
        print(f"ERROR: could not connect to {HOST}: {e}", file=sys.stderr)
        return 1

    try:
        mc_checks = check_minecraft(client)
        zb_checks = check_zomboid(client)
        fw_checks = check_firewall(client)
    finally:
        client.close()

    # fw_checks' "warn" is specifically the standing "cannot verify UFW"
    # state (see check_firewall()'s docstring — a real access gap, not a
    # transient issue) and is deliberately excluded from what drives a
    # daily email: The Boss's own call, 2026-08-12, was to leave this as a
    # manual check rather than grant broader access, so re-emailing the
    # same unresolved, accepted gap every day would just be noise. A real
    # detected violation ("critical") still emails immediately. The report
    # text below always shows the current state either way, so it's never
    # silently hidden — just not what wakes up the inbox on its own.
    issues = [c for c in (mc_checks + zb_checks) if c["status"] in ("warn", "critical")]
    issues += [c for c in fw_checks if c["status"] == "critical"]
    report = build_report(mc_checks, zb_checks, fw_checks)
    print(report)

    if not issues:
        print("\nNo issues found.")
        return 0

    subject = f"Game Server Health — {len(issues)} issue(s) — {datetime.now().strftime('%Y-%m-%d')}"
    if args.dry_run:
        print(f"\n--dry-run: would email '{subject}' to {EMAIL_TO}, not sending")
        return 0

    sent = send_email(subject, report)
    print(f"\nEmail {'sent' if sent else 'FAILED to send'} to {EMAIL_TO}")
    # Issues are content this run already surfaced (by email, on success) —
    # not a broken tool. Same exit-code rule hermes-podcast-sync.py 1.0.1
    # established: only a failure to run the checks or to send the
    # notification is a real tool failure worth phantom-failing the
    # systemd unit over.
    return 0 if sent else 1


if __name__ == "__main__":
    sys.exit(main())
