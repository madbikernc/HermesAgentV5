#!/usr/bin/env python3
# Version: 1.0.1
"""
hermes-node-probe.py — Investigate a LAN node: hostnames, MAC/vendor, OS
fingerprint, services (Phase 15, IMPLEMENTATION_PLAN.md §7: "LAN
fingerprinting. Reintroduced specifically to support Phase 18" — the
canary/honeypot integration, deferred; this tool is self-contained and
useful standalone in the meantime).

Ported from v1 (HermesAgent/scripts/node-probe.py) with no logic changes —
it was already a clean, self-contained script with no v1-specific
assumptions baked in.

Authorized use only: this fleet's own network, investigating devices you
have the right to scan. The exhaustive -p- nmap sweep with -O/-sV/-sC is
intentionally thorough, not fast (10-30 min against an unresponsive host)
— built for a scheduled/background investigation, not an interactive one.

Usage: python3 hermes-node-probe.py <IP> [--json]
Requires: nmap (sudo for -O), optional: avahi-utils, samba-common-bin
"""

import argparse
import ipaddress
import json
import re
import socket
import subprocess
import sys
from datetime import datetime

# Informational only — the script still probes any target given. A warning,
# not a block, since legitimately auditing your own fleet nodes is a real
# use case (e.g. confirming no *unexpected* port opened on Sintra's own
# host). Update this list if the fleet's own addresses change.
KNOWN_FLEET_IPS = {
    "10.129.1.15": "Spark (Sintra + Amy's gateways, router, broker)",
    "10.129.1.16": "HomeD13 (render worker)",
    "10.129.1.17": "spark-2 (second DGX Spark, §6 Stage 7 — Amy's Vision backend, not yet built)",
}


def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip(), r.returncode
    except subprocess.TimeoutExpired:
        return "[TIMEOUT]", 1
    except FileNotFoundError:
        return f"[NOT FOUND: {cmd[0]}]", 1


def resolve_hostnames(ip):
    names = {"dns": None, "dns_forward_confirmed": None, "mdns": None, "netbios": None}

    # Reverse DNS (PTR)
    try:
        names["dns"] = socket.gethostbyaddr(ip)[0]
    except Exception:
        pass

    # Forward-confirm the PTR result: resolve the hostname back to an A
    # record and check it actually points at the IP we started with. A
    # mismatch (or NXDOMAIN) is itself a signal — spoofed/stale PTR records
    # are common on scanning infrastructure and abuse-hosting networks.
    if names["dns"]:
        try:
            forward_ip = socket.gethostbyname(names["dns"])
            names["dns_forward_confirmed"] = (forward_ip == ip)
        except Exception:
            names["dns_forward_confirmed"] = False

    # mDNS via avahi-resolve-address
    out, rc = run(["avahi-resolve-address", "-4", ip], timeout=5)
    if rc == 0 and "\t" in out:
        names["mdns"] = out.split("\t")[-1].rstrip(".")

    # NetBIOS via nmblookup
    out, rc = run(["nmblookup", "-A", ip], timeout=6)
    if rc == 0:
        for line in out.splitlines():
            line = line.strip()
            # Lines like: HOSTNAME      <00> -         B <ACTIVE>
            if "<00>" in line and "GROUP" not in line and "<ACTIVE>" in line:
                parts = line.split()
                if parts:
                    names["netbios"] = parts[0]
                    break

    return names


def get_mac_vendor(ip):
    # Ensure the node is in the ARP cache; one ping is enough
    run(["ping", "-c", "1", "-W", "2", ip], timeout=4)

    mac = None
    out, _ = run(["arp", "-n", ip])
    for line in out.splitlines():
        m = re.search(r"(([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})", line)
        if m:
            mac = m.group(1)
            break

    if not mac:
        return None, None

    vendor = _lookup_vendor(mac)
    return mac, vendor


def _lookup_vendor(mac):
    oui = mac.upper().replace(":", "")[:6]

    # nmap bundles a MAC prefix list
    for path in ["/usr/share/nmap/nmap-mac-prefixes", "/usr/share/nmap/mac-prefixes"]:
        try:
            with open(path) as f:
                for line in f:
                    if line.startswith(oui):
                        return line.split(" ", 1)[1].strip()
        except FileNotFoundError:
            continue

    # ieee-data package (apt install ieee-data)
    try:
        with open("/usr/share/ieee-data/oui.txt") as f:
            for line in f:
                if oui in line.upper().replace("-", "").replace(":", ""):
                    parts = line.split("\t")
                    if len(parts) >= 3:
                        return parts[2].strip()
    except FileNotFoundError:
        pass

    return None


def nmap_probe(ip):
    # Exhaustive scan: every TCP port (-p-), not just the top 1000, plus OS
    # detection (-O, requires sudo/root) and service/version detection (-sV,
    # -sC for default scripts). Thorough rather than fast — 10-30 minutes is
    # normal for an unresponsive/filtered host.
    cmd = [
        "sudo", "nmap",
        "-O", "--osscan-guess",
        "-sV", "--version-intensity", "5",
        "-sC",
        "-T4",
        "-p-",
        "--open",
        ip,
    ]
    out, _ = run(cmd, timeout=1800)
    return out


def best_hostname(names):
    return names.get("dns") or names.get("mdns") or names.get("netbios") or "(unknown)"


def print_report(ip, ts, names, mac, vendor, nmap_out):
    bar = "=" * 62
    print()
    print(bar)
    print(f"  NODE PROBE REPORT — {ip} — {ts}")
    print(bar)

    if ip in KNOWN_FLEET_IPS:
        print(f"\n  NOTE: {ip} is a known fleet node ({KNOWN_FLEET_IPS[ip]}) — probing our own infrastructure.")

    print("\n── IDENTITY ────────────────────────────────────────────────")
    print(f"  IP Address  : {ip}")
    print(f"  DNS Name (PTR): {names.get('dns') or '(not found)'}")
    if names.get("dns"):
        conf = names.get("dns_forward_confirmed")
        print(f"  Forward-confirmed: {'yes' if conf else 'NO — PTR/A mismatch or NXDOMAIN (possible spoofed/stale record)'}")
    print(f"  mDNS Name   : {names.get('mdns') or '(not found)'}")
    print(f"  NetBIOS Name: {names.get('netbios') or '(not found)'}")
    print(f"  MAC Address : {mac or '(not found — may need to be on same subnet)'}")
    print(f"  HW Vendor   : {vendor or '(unknown)'}")

    print("\n── NMAP OS + SERVICE SCAN (all 65535 ports) ─────────────────")
    print(nmap_out)
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Probe a LAN node: hostname, MAC/vendor, OS fingerprint, services."
    )
    parser.add_argument("target", help="IP address to investigate")
    parser.add_argument("--json", action="store_true", help="Also emit JSON block at the end")
    args = parser.parse_args()

    ip = args.target
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        print(f"ERROR: '{ip}' is not a valid IP address.", file=sys.stderr)
        sys.exit(1)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")

    print(f"[node-probe] Investigating {ip}  ({ts})")
    print()

    print("  [1/3] Resolving hostnames (DNS / reverse DNS / mDNS / NetBIOS)...")
    names = resolve_hostnames(ip)

    print("  [2/3] Looking up MAC address and hardware vendor...")
    mac, vendor = get_mac_vendor(ip)

    print("  [3/3] Running exhaustive nmap scan — all 65535 ports, OS fingerprint, "
          "service detection (10-30 min)...")
    nmap_out = nmap_probe(ip)

    print_report(ip, ts, names, mac, vendor, nmap_out)

    if args.json:
        data = {
            "ip": ip,
            "timestamp": ts,
            "hostname": best_hostname(names),
            "hostnames": names,
            "mac": mac,
            "vendor": vendor,
            "known_fleet_node": KNOWN_FLEET_IPS.get(ip),
            "nmap_raw": nmap_out,
        }
        print("── JSON ─────────────────────────────────────────────────────")
        print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
