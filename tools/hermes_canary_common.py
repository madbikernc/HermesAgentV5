#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes_canary_common.py — Shared helpers for the canary-monitor scripts
(hermes-canary-report.py, hermes-canary-probe-report.py). Keeps the "known
infrastructure IPs" and port -> service mapping in one place so the two
scripts can't drift apart.

Ported from v1 (HermesAgent/scripts/canary_common.py) with no logic
changes — get_homed13_ips() already used the `ssh homed13` alias this
project independently set up for Phase 13/15/16/17 work, so it needed
nothing adapted.

Named with underscores, breaking this project's usual hyphenated-filename
convention for tools/ scripts — deliberately: this file is `import`ed by
the other canary scripts, not invoked directly, and Python cannot import
a module whose filename contains a hyphen. Same reasoning v1 used.
"""
import re
import subprocess

# Honeypot port -> service name, matches HONEYPOT_TCP/HONEYPOT_UDP in
# hermes-canary-health.py. Keep in sync if the opencanary.conf module list changes.
PORT_SERVICE = {
    21: "FTP", 22: "SSH", 23: "Telnet", 80: "HTTP", 139: "SMB/NBT",
    443: "HTTPS", 445: "SMB", 1433: "MSSQL", 3306: "MySQL", 3389: "RDP",
    5900: "VNC", 6379: "Redis", 9418: "Git", 25565: "Minecraft",
    2222: "SSH-mgmt",  # canary's own management port, never a honeypot hit
    161: "SNMP", 5060: "SIP",
}

# HomeD13 has a single, stable LAN IP. Used as a fallback if the live SSH
# lookup below fails (offline node, network blip) so a report never
# misclassifies HomeD13 as a suspicious external source just because it
# couldn't be reached at report time.
HOMED13_FALLBACK_IPS = {"10.129.1.16"}


def get_spark_ips() -> set:
    """All non-loopback, non-docker IPv4 addresses on this machine (the Spark)."""
    try:
        out = subprocess.check_output(["ip", "-4", "addr", "show"], text=True)
        ips = set()
        for m in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+)/", out):
            ip = m.group(1)
            if not ip.startswith("127.") and not ip.startswith("172."):
                ips.add(ip)
        return ips
    except Exception:
        return {"10.129.1.15"}


def get_homed13_ips(timeout: int = 5) -> set:
    """HomeD13's live IPv4 addresses via SSH; falls back to a static snapshot
    if HomeD13 is unreachable, so a network blip never causes it to be
    mistaken for an external attacker."""
    try:
        out = subprocess.check_output(
            ["ssh", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={timeout}",
             "homed13", "ip", "-4", "addr", "show"],
            text=True, timeout=timeout + 3, stderr=subprocess.DEVNULL,
        )
        ips = {m.group(1) for m in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+)/", out)
               if not m.group(1).startswith("127.")}
        return ips or set(HOMED13_FALLBACK_IPS)
    except Exception:
        return set(HOMED13_FALLBACK_IPS)


def get_known_infra_ips() -> set:
    """Every IP that belongs to the Spark or HomeD13 — our own fleet, never
    an attacker. Anything outside this set is a candidate for
    hermes-node-probe + hermes-security-scan."""
    return get_spark_ips() | get_homed13_ips()
