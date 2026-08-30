#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — security-review fix: vault_get() now catches subprocess.TimeoutExpired
# (a *complete* Vaultwarden outage previously crashed this script uncaught
# instead of returning "" as its own comment already documented).
"""
hermes-canary-health.py — OpenCanary honeypot health monitor with automatic
recovery and port test mode (Phase 18, IMPLEMENTATION_PLAN.md §7).

Normal mode (timer, every 5 minutes):
  python3 hermes-canary-health.py

Test mode — verifies all configured honeypot ports are responding
externally, tests all 4 physical interfaces, and emails a full tabulated
report:
  python3 hermes-canary-health.py --test

Ported from v1 (HermesAgent/scripts/canary-health.py) with two real
changes: SMTP credentials moved from a plaintext ~/.hermes/config/email.json
to Vaultwarden (this project's own constraint §2b), and the SSH key path
points at this project's own dedicated ~/.ssh/canary (generated fresh for
this port — the v1 key was never carried over). Network topology
(KNOWN_SUBNETS) reverified live against the device on 2026-08-02 and found
unchanged from v1's documented values.

Recovery escalation (restart -> reboot -> alert) ported as-is, per
explicit confirmation it should be — see IMPLEMENTATION_PLAN.md's Phase 18
entry. It only triggers once the service is already confirmed down.
"""
import argparse
import ipaddress
import json
import os
import re
import smtplib
import socket
import subprocess
import sys
import time
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

# ── config ────────────────────────────────────────────────────────────────────

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"

CANARY_HOST = "10.129.1.75"       # LAN interface — used for SSH/mgmt access
CANARY_PORT = 2222
CANARY_USER = "root"
CANARY_KEY = Path.home() / ".ssh" / "canary"
CANARY_SVC = "opencanary.service"

# The 4 canonical network segments in this environment — reverified live
# against the device 2026-08-02, unchanged from v1.
# "gating": interfaces whose failures count toward the overall Failed status.
# IOT/IdiotProof is intentionally disabled in this environment — non-gating.
# Secure/VPN has no pfSense route at all — confirmed VPN-only by design, not
# a fault — non-gating.
KNOWN_SUBNETS = [
    ("Home LAN",           ipaddress.ip_network("10.129.1.0/24"),   True),
    ("Secure/VPN",         ipaddress.ip_network("192.168.132.0/24"), False),
    ("IOT/IdiotProof",     ipaddress.ip_network("192.168.86.0/24"),  False),
    ("DMZ/StrangerDanger", ipaddress.ip_network("192.168.1.0/24"),   True),
]

ALERT_TO = "notifications@canislupisnc.net"
SMTP_HOST = "mail.hover.com"
SMTP_FROM = "mercury@canislupisnc.net"

RESTART_WAIT = 12
REBOOT_WAIT = 90

STATE_FILE = Path.home() / ".hermes" / "canary-health.state"


def vault_get(item, field):
    # timeout=60, not 30: vault-get-secret.sh 1.2.0 (2026-08-09) retries internally up to
    # 3x on a real, previously-hit transient bw/Vaultwarden failure — a single successful
    # retry alone can take ~32s, which a 30s subprocess timeout would kill mid-recovery
    # with an uncaught TimeoutExpired instead of the graceful "" this function returns.
    # Security-review fix: that comment was aspirational until now -- a *complete*
    # Vaultwarden outage (both this call and vault-get-secret.sh's own internal
    # retries exhausting the full 60s) previously raised TimeoutExpired uncaught,
    # crashing this script instead of returning "" as documented above.
    try:
        result = subprocess.run(
            [VAULT_SCRIPT, item, field], capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def get_local_ips() -> set:
    """Return all non-loopback, non-docker IPv4 addresses on this machine."""
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


# Spark's own addresses — used to identify our traffic in canary reports
SPARK_IPS = get_local_ips()

# Honeypot target ports derived from opencanary.conf
HONEYPOT_TCP = [
    (21,    "FTP"),
    (22,    "SSH"),
    (23,    "Telnet"),
    (80,    "HTTP"),
    (139,   "SMB/NBT"),
    (443,   "HTTPS"),
    (445,   "SMB"),
    (1433,  "MSSQL"),
    (3306,  "MySQL"),
    (3389,  "RDP"),
    (5900,  "VNC"),
    (6379,  "Redis"),
    (9418,  "Git"),
    (25565, "Minecraft"),
]
HONEYPOT_UDP = [
    (161,  "SNMP"),
    (5060, "SIP"),
]

# "Key" ports — failure here → status FAILED (not just Indeterminate)
KEY_TCP_PORTS = {21, 22, 23, 80, 443, 445, 3306, 3389}

# Management port must be REJECTED from WiFi
MGMT_PORT = 2222

SSH_BASE = [
    "ssh", "-p", str(CANARY_PORT), "-i", str(CANARY_KEY),
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    f"{CANARY_USER}@{CANARY_HOST}",
]


# ── shared helpers ────────────────────────────────────────────────────────────

def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


# ── persistent down-state tracking ────────────────────────────────────────────
# State file persists across timer runs so we can:
#   • suppress duplicate "canary down" emails (one per calendar day)
#   • send a "canary returned" email when it recovers from a persistent outage

def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"was_down": False, "alert_sent": False, "last_alert_date": None}


def _save_state(state: dict):
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state))
    except Exception as e:
        print(f"State save failed: {e}", file=sys.stderr)


def _should_alert_today(state: dict) -> bool:
    """True if we have not yet sent a 'canary down' alert today."""
    return state.get("last_alert_date") != today()


def send_email(subject: str, body: str):
    try:
        msg = MIMEMultipart()
        msg["From"], msg["To"], msg["Subject"] = SMTP_FROM, ALERT_TO, subject
        msg.attach(MIMEText(body, "plain"))
        password = vault_get("email-sintra", "password")
        with smtplib.SMTP(SMTP_HOST, 587, timeout=30) as s:
            s.starttls()
            s.login(SMTP_FROM, password)
            s.sendmail(SMTP_FROM, [ALERT_TO], msg.as_string())
    except Exception as e:
        print(f"Email failed: {e}", file=sys.stderr)


def remote(cmd: str, timeout: int = 15) -> tuple[int, str]:
    try:
        r = subprocess.run(SSH_BASE + [cmd], capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return 1, "SSH timed out"
    except Exception as e:
        return 1, str(e)


def is_reachable() -> bool:
    return remote("echo ping")[0] == 0


def service_active() -> bool:
    return remote(f"systemctl is-active {CANARY_SVC}")[0] == 0


# ── port test helpers ─────────────────────────────────────────────────────────

def tcp_probe(ip: str, port: int, timeout: float = 4.0) -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((ip, port))
        s.close()
        return "OPEN"
    except ConnectionRefusedError:
        return "REFUSED"
    except socket.timeout:
        return "TIMEOUT"
    except OSError:
        return "ERR"


def udp_probe(ip: str, port: int, timeout: float = 2.0) -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        s.sendto(b"\x00", (ip, port))
        s.recvfrom(64)
        s.close()
        return "RESPONDED"
    except socket.timeout:
        return "OPEN"      # no ICMP unreachable = port is open, just no reply
    except ConnectionRefusedError:
        return "CLOSED"
    except Exception:
        return "ERR"


# ── remote device audit (interface state, security posture, updates) ──────────
# Gathered in one SSH round-trip over the LAN management channel — this is the
# only always-reachable admin path into the multi-homed device.

_AUDIT_CMD = r"""
echo '###OS###'; . /etc/os-release; echo "$PRETTY_NAME"
echo '###UPDATES###'; apt list --upgradable 2>/dev/null | tail -n +2
echo '###ADDR###'; ip -4 -o addr show
echo '###LINK###'; ip -o link show
echo '###LISTEN###'; ss -Htulnp 2>/dev/null
echo '###IPTABLES###'; iptables -L INPUT -n 2>&1
echo '###SSHD###'; grep -Ei '^PermitRootLogin|^PasswordAuthentication' /etc/ssh/sshd_config 2>&1
echo '###FAIL2BAN###'; systemctl is-active fail2ban 2>&1
echo '###OPENCANARY_SVC###'; systemctl is-active opencanary.service 2>&1
echo '###OPENCANARY_CONF###'; python3 -c "
import json
c = json.load(open('/etc/opencanaryd/opencanary.conf'))
print('portscan.enabled =', c.get('portscan.enabled'))
print('ip.ignorelist =', c.get('ip.ignorelist'))
" 2>&1
echo '###END###'
""".strip()


def _split_sections(raw: str) -> dict[str, str]:
    sections: dict[str, str] = {}
    current = None
    for line in raw.splitlines():
        m = re.match(r"^###(\w+)###$", line.strip())
        if m:
            current = m.group(1)
            sections[current] = []
            continue
        if current:
            sections[current].append(line)
    return {k: "\n".join(v).strip() for k, v in sections.items()}


def run_remote_audit() -> dict[str, str]:
    code, out = remote(_AUDIT_CMD, timeout=30)
    if code != 0 and "###END###" not in out:
        return {}
    return _split_sections(out)


def parse_addrs(text: str) -> dict[str, tuple[str, int]]:
    """ifname -> (ipv4, prefixlen)"""
    result = {}
    for m in re.finditer(r"^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)", text, re.MULTILINE):
        result[m.group(1)] = (m.group(2), int(m.group(3)))
    return result


def parse_links(text: str) -> dict[str, bool]:
    """ifname -> carrier up (LOWER_UP present, i.e. cable/link physically up)"""
    result = {}
    for m in re.finditer(r"^\d+:\s+(\S+):\s+<([^>]*)>", text, re.MULTILINE):
        ifname, flags = m.group(1), m.group(2)
        result[ifname] = "LOWER_UP" in flags.split(",")
    return result


def parse_listening(text: str) -> set[tuple[str, str, int]]:
    """set of (proto, bind_ip, port) currently in LISTEN/UNCONN state"""
    result = set()
    for line in text.splitlines():
        m = re.match(r"^(tcp|udp)\s+\S+\s+\d+\s+\d+\s+([^\s]+):(\d+)\s", line)
        if not m:
            continue
        proto, bind, port = m.group(1), m.group(2), int(m.group(3))
        bind = bind.strip("[]")
        result.add((proto, bind, port))
    return result


def parse_updates(text: str) -> tuple[int, int]:
    lines = [l for l in text.splitlines() if l.strip()]
    security = sum(1 for l in lines if re.search(r"/\S*security", l, re.IGNORECASE))
    return len(lines), security


def parse_iptables_policy(text: str) -> tuple[str, int]:
    m = re.search(r"Chain INPUT \(policy (\S+)\)", text)
    policy = m.group(1) if m else "UNKNOWN"
    rule_lines = [
        l for l in text.splitlines()
        if l.strip() and not l.startswith("Chain") and not l.strip().startswith("target")
    ]
    return policy, len(rule_lines)


def parse_sshd(text: str) -> dict[str, str]:
    """The remote grep matches the whole config line verbatim, inline comment
    and all (e.g. "PermitRootLogin yes #prohibit-password" — a real value on
    this device, found live 2026-08-02: someone had switched from
    prohibit-password to yes and left the old value as a trailing comment
    rather than deleting it). Strip anything from a bare '#' onward before
    taking the value, or a comparison against an exact value like "yes"
    silently never matches and the check misfires."""
    result = {}
    for line in text.splitlines():
        value_part = line.split("#", 1)[0]
        parts = value_part.split(None, 1)
        if len(parts) == 2:
            result[parts[0]] = parts[1].strip()
    return result


def parse_conf(text: str) -> dict[str, str]:
    result = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            result[k.strip()] = v.strip()
    return result


def is_listening_on(listen_set: set, ip: str, port: int, proto: str = "tcp") -> bool:
    return (proto, "0.0.0.0", port) in listen_set or (proto, ip, port) in listen_set


# ── test mode ─────────────────────────────────────────────────────────────────

def run_test() -> int:
    """
    Full audit of all 4 physical honeypot interfaces: link state, assigned
    IP/CIDR, local + external port reachability, plus host-wide security
    posture and software update status. Interface IPs are discovered live
    by subnet each run (not hardcoded), since DHCP leases on the non-LAN
    NICs can drift.
    Emails a full tabulated report. Returns 0 (Successful), 1 (Failed), 2 (Indeterminate).
    """
    ts = now()
    critical: list[str] = []   # -> Failed
    warnings: list[str] = []   # -> Indeterminate (if not already Failed)

    audit = run_remote_audit()
    if not audit:
        critical.append("Could not reach canary over management SSH — audit aborted, see recovery mode")
        report_body = (
            f"OpenCanary Full Interface & Security Audit\n"
            f"Timestamp   : {ts}\n"
            f"Overall     : FAILED\n\n"
            f"FAILURES DETECTED:\n  ! {critical[0]}\n"
        )
        print(report_body)
        send_email(f"Canary Test — Failed [{ts}]", report_body)
        return 1

    os_name       = audit.get("OS", "unknown")
    addrs         = parse_addrs(audit.get("ADDR", ""))
    links         = parse_links(audit.get("LINK", ""))
    listening     = parse_listening(audit.get("LISTEN", ""))
    upd_total, upd_sec = parse_updates(audit.get("UPDATES", ""))
    ipt_policy, ipt_rules = parse_iptables_policy(audit.get("IPTABLES", ""))
    sshd          = parse_sshd(audit.get("SSHD", ""))
    conf          = parse_conf(audit.get("OPENCANARY_CONF", ""))
    fail2ban_stat = audit.get("FAIL2BAN", "unknown").strip()
    oc_svc_stat   = audit.get("OPENCANARY_SVC", "unknown").strip()

    class Iface:
        def __init__(self, label, network, gating):
            self.label, self.network, self.gating = label, network, gating
            self.ifname = self.ip = None
            for name, (ip, prefix) in addrs.items():
                if ipaddress.ip_address(ip) in network:
                    self.ifname, self.ip = name, ip
                    break
            self.link_up = links.get(self.ifname) if self.ifname else None
            self.tcp: dict[int, str] = {}
            self.udp: dict[int, str] = {}
            self.mgmt: str = "N/A"
            self.missing_local_tcp: list[tuple] = []
            self.missing_local_udp: list[tuple] = []

    ifaces = [Iface(label, net, gating) for label, net, gating in KNOWN_SUBNETS]

    for iface in ifaces:
        if not iface.ip:
            continue
        for port, svc in HONEYPOT_TCP:
            iface.tcp[port] = tcp_probe(iface.ip, port)
            if not is_listening_on(listening, iface.ip, port, "tcp"):
                iface.missing_local_tcp.append((port, svc))
        for port, svc in HONEYPOT_UDP:
            iface.udp[port] = udp_probe(iface.ip, port)
            if not is_listening_on(listening, iface.ip, port, "udp"):
                iface.missing_local_udp.append((port, svc))
        iface.mgmt = tcp_probe(iface.ip, MGMT_PORT, timeout=3.0)

    for iface in ifaces:
        tag = f"{iface.label}"
        sev = critical if iface.gating else warnings

        if not iface.ifname:
            sev.append(f"{tag}: no NIC found on subnet {iface.network}")
            continue
        if not iface.link_up:
            sev.append(f"{tag}: interface {iface.ifname} link is DOWN")
        if not iface.ip:
            sev.append(f"{tag}: interface {iface.ifname} is up but has no IPv4 address assigned")
            continue

        if iface.missing_local_tcp or iface.missing_local_udp:
            svcs = ", ".join(f"{p}/{s}" for p, s in (iface.missing_local_tcp + iface.missing_local_udp))
            sev.append(f"{tag}: not listening locally on {len(iface.missing_local_tcp) + len(iface.missing_local_udp)} honeypot port(s): {svcs}")

        key_ext = [(p, s, iface.tcp[p]) for p, s in HONEYPOT_TCP if p in KEY_TCP_PORTS and iface.tcp[p] != "OPEN"]
        other_ext = [(p, s, iface.tcp[p]) for p, s in HONEYPOT_TCP if p not in KEY_TCP_PORTS and iface.tcp[p] != "OPEN"]
        if key_ext:
            desc = ", ".join(f"{p}/{s}={r}" for p, s, r in key_ext)
            sev.append(f"{tag}: key honeypot port(s) unreachable externally: {desc}")
        elif other_ext:
            warnings.append(f"{tag}: non-key honeypot port(s) unreachable externally: "
                             + ", ".join(f"{p}/{s}={r}" for p, s, r in other_ext))

        is_lan = iface.label == "Home LAN"
        mgmt_ok = (iface.mgmt == "OPEN") if is_lan else (iface.mgmt != "OPEN")
        if not mgmt_ok:
            (critical if iface.gating or is_lan else warnings).append(
                f"{tag}: management port 2222 is {'unreachable' if is_lan else 'OPEN'} — "
                + ("mgmt SSH should be reachable from Home LAN" if is_lan else "FIREWALL RULE MAY HAVE BEEN RESET")
            )

    if oc_svc_stat != "active":
        critical.append(f"opencanary.service is not active (status: {oc_svc_stat})")
    if ipt_policy != "DROP":
        warnings.append(f"iptables INPUT default policy is {ipt_policy}, expected DROP")
    root_login = sshd.get("PermitRootLogin", "").lower()
    if root_login not in ("prohibit-password", "no", "yes"):
        critical.append(f"sshd PermitRootLogin is '{root_login or 'unset'}', expected prohibit-password/no/yes")
    if sshd.get("PasswordAuthentication", "").lower() != "no":
        critical.append(f"sshd PasswordAuthentication is '{sshd.get('PasswordAuthentication', 'unset')}', expected no")
    if ("tcp", "0.0.0.0", MGMT_PORT) in listening:
        critical.append("management SSH (2222) is bound to 0.0.0.0 (all interfaces) instead of LAN-only")
    if upd_sec > 0:
        warnings.append(f"{upd_sec} pending security update(s)")

    if critical:
        status, exit_code = "Failed", 1
    elif warnings:
        status, exit_code = "Indeterminate", 2
    else:
        status, exit_code = "Successful", 0

    LABEL_W = max(16, max(len(i.label) for i in ifaces))

    def fmt_tcp(result: str, port: int) -> str:
        marker = "PASS" if result == "OPEN" else ("FAIL*" if port in KEY_TCP_PORTS else "FAIL ")
        return f"[{marker}] {result}".ljust(LABEL_W)

    def fmt_udp(result: str) -> str:
        ok = result in ("OPEN", "RESPONDED")
        return f"[{'PASS' if ok else 'N/A '}] {result}".ljust(LABEL_W)

    hdr = f"{'Port':<7} {'Service':<12}"
    sep = "-" * (7 + 12 + len(ifaces) * (LABEL_W + 2))
    col_hdr = hdr + "".join(f"  {i.label:<{LABEL_W}}" for i in ifaces)

    lines = []
    lines.append("OpenCanary Full Interface & Security Audit")
    lines.append(f"Tested from : home-spark (Hermes fleet)")
    lines.append(f"Spark IPs   : {', '.join(sorted(SPARK_IPS))}  ← excluded from canary alerts")
    lines.append(f"Timestamp   : {ts}")
    lines.append(f"Canary OS   : {os_name}")
    lines.append(f"Overall     : {status.upper()}")
    lines.append("")

    LABEL_W_STATE = max(len(i.label) for i in ifaces)
    lines.append("INTERFACE STATE (discovered live — DHCP leases are not assumed static)")
    for i in ifaces:
        gate = "gating" if i.gating else "non-gating"
        if not i.ifname:
            lines.append(f"  {i.label:<{LABEL_W_STATE}} NIC NOT FOUND  [{gate}]")
            continue
        link = "UP" if i.link_up else "DOWN"
        ip_cidr = f"{i.ip}/{addrs[i.ifname][1]}" if i.ip else "NO IP ASSIGNED"
        local_ok = not (i.missing_local_tcp or i.missing_local_udp)
        listen_str = "all services listening" if local_ok else (
            f"{len(i.missing_local_tcp) + len(i.missing_local_udp)} service(s) NOT listening")
        lines.append(f"  {i.label:<{LABEL_W_STATE}} iface={i.ifname:<8} link={link:<5} ip={ip_cidr:<20} local={listen_str}  [{gate}]")
    lines.append("")

    lines.append("TCP HONEYPOT PORTS (external reachability probe)")
    lines.append(col_hdr)
    lines.append(sep)
    for port, svc in HONEYPOT_TCP:
        key_mark = "*" if port in KEY_TCP_PORTS else " "
        row = f"{port:<7} {svc+key_mark:<12}"
        for i in ifaces:
            row += "  " + (fmt_tcp(i.tcp[port], port) if i.ip else "[N/A ] NO-IP".ljust(LABEL_W))
        lines.append(row)
    lines.append("")
    lines.append("  * = key service (failure on a gating interface → FAILED status)")

    lines.append("")
    lines.append("UDP HONEYPOT PORTS")
    lines.append(col_hdr)
    lines.append(sep)
    for port, svc in HONEYPOT_UDP:
        row = f"{port:<7} {svc:<12}"
        for i in ifaces:
            row += "  " + (fmt_udp(i.udp[port]) if i.ip else "[N/A ] NO-IP".ljust(LABEL_W))
        lines.append(row)
    lines.append("")
    lines.append("  UDP OPEN = no ICMP unreachable received (port accepting)")

    lines.append("")
    lines.append("MANAGEMENT PORT (2222 — Home LAN only)")
    for i in ifaces:
        expect = "OPEN" if i.label == "Home LAN" else "REFUSED/TIMEOUT"
        lines.append(f"  {i.label:<{LABEL_W}} ({i.ip or 'no IP'}): {i.mgmt:<10} (expect {expect})")

    lines.append("")
    lines.append("HOST SECURITY POSTURE")
    lines.append(f"  opencanary.service       : {oc_svc_stat}")
    lines.append(f"  iptables INPUT policy    : {ipt_policy} ({ipt_rules} rules)")
    lines.append(f"  fail2ban                 : {fail2ban_stat}")
    lines.append(f"  sshd PermitRootLogin     : {sshd.get('PermitRootLogin', 'unset')}")
    lines.append(f"  sshd PasswordAuthentication: {sshd.get('PasswordAuthentication', 'unset')}")
    lines.append(f"  opencanary portscan.enabled : {conf.get('portscan.enabled', 'unknown')}")
    lines.append(f"  opencanary ip.ignorelist    : {conf.get('ip.ignorelist', 'unknown')}")

    lines.append("")
    lines.append("SOFTWARE UPDATE STATUS")
    lines.append(f"  Upgradable packages      : {upd_total}")
    lines.append(f"  Of which security        : {upd_sec}")
    lines.append(f"  Status                   : {'Up to date' if upd_total == 0 else ('Security updates pending' if upd_sec else 'Non-security updates pending')}")

    if critical or warnings:
        lines.append("")
        lines.append("FAILURES DETECTED:" if critical else "")
        for c in critical:
            lines.append(f"  ! {c}")
        if warnings:
            lines.append("")
            lines.append("WARNINGS (non-gating):")
            for w in warnings:
                lines.append(f"  - {w}")
    else:
        lines.append("")
        lines.append("No failures or warnings detected.")

    report_body = "\n".join(lines)
    print(report_body)

    subject = f"Canary Test — {status} [{ts}]"
    send_email(subject, report_body)
    print(f"\nReport emailed to {ALERT_TO}: {subject}")

    return exit_code


# ── recovery mode (normal / timer) ─────────────────────────────────────────────

def attempt_restart() -> tuple[bool, str]:
    log = []
    code, out = remote(f"systemctl restart {CANARY_SVC}")
    log.append(f"restart command exit={code}: {out[:200]}")
    if code != 0:
        return False, "\n".join(log)
    time.sleep(RESTART_WAIT)
    if service_active():
        _, status = remote(f"systemctl status {CANARY_SVC} --no-pager -l")
        log.append(f"post-restart status:\n{status[:400]}")
        return True, "\n".join(log)
    _, status = remote(f"systemctl status {CANARY_SVC} --no-pager -l")
    log.append(f"service still down after restart:\n{status[:400]}")
    return False, "\n".join(log)


def attempt_reboot() -> tuple[bool, str]:
    log = []
    code, out = remote("systemctl reboot", timeout=10)
    log.append(f"reboot command exit={code}: {out[:100]}")
    log.append(f"waiting {REBOOT_WAIT}s for node to come back up ...")
    time.sleep(REBOOT_WAIT)
    if not is_reachable():
        log.append("node unreachable after reboot wait")
        return False, "\n".join(log)
    log.append("node is back online")
    time.sleep(5)
    if service_active():
        _, status = remote(f"systemctl status {CANARY_SVC} --no-pager -l")
        log.append(f"service running after reboot:\n{status[:400]}")
        return True, "\n".join(log)
    _, status = remote(f"systemctl status {CANARY_SVC} --no-pager -l")
    log.append(f"service still not running after reboot:\n{status[:400]}")
    return False, "\n".join(log)


def notify_restart_success(restart_log: str):
    send_email(
        f"Canary Recovered — Service Restarted [{now()}]",
        f"OpenCanary Health Monitor — RECOVERED\nTime: {now()}\nNode: {CANARY_HOST}:{CANARY_PORT}\n\n"
        f"The OpenCanary service was found stopped and has been successfully restarted.\n\n"
        f"Recovery log:\n{restart_log}",
    )


def notify_reboot_success(restart_log: str, reboot_log: str):
    send_email(
        f"Canary Recovered — Node Rebooted [{now()}]",
        f"OpenCanary Health Monitor — RECOVERED (via reboot)\nTime: {now()}\nNode: {CANARY_HOST}:{CANARY_PORT}\n\n"
        f"Service restart failed. The node was rebooted and the service is now running.\n\n"
        f"Restart log:\n{restart_log}\n\nReboot log:\n{reboot_log}",
    )


def notify_failure(reachable: bool, restart_log: str, reboot_log: str):
    if reachable:
        detail = "The node is reachable but the service could not be restored."
        recs = (
            f"  1. ssh -p {CANARY_PORT} -i ~/.ssh/canary {CANARY_USER}@{CANARY_HOST}\n"
            f"  2. journalctl -u {CANARY_SVC} -n 50\n"
            f"  3. df -h && cat /etc/opencanaryd/opencanary.conf | python3 -m json.tool\n"
            f"  4. systemctl restart {CANARY_SVC}"
        )
    else:
        detail = "The node is NOT reachable via SSH. It may be offline or disconnected."
        recs = (
            f"  1. ping {CANARY_HOST}\n"
            f"  2. Check physical power and network cables\n"
            f"  3. Check DHCP table on router\n"
            f"  4. Power-cycle the device manually"
        )
    send_email(
        f"ALERT — Canary Node Unrecoverable [{now()}]",
        f"OpenCanary Health Monitor — RECOVERY FAILED\nTime: {now()}\n"
        f"Node: {CANARY_HOST}:{CANARY_PORT}\nReachable: {'Yes' if reachable else 'NO'}\n\n"
        f"{detail}\n\nRecommended actions:\n{recs}\n\n"
        f"Restart log:\n{restart_log or '(not attempted)'}\n\n"
        f"Reboot log:\n{reboot_log or '(not attempted)'}",
    )


def notify_returned():
    send_email(
        f"Canary Returned — Node Back Online [{now()}]",
        f"OpenCanary Health Monitor — ONLINE\nTime: {now()}\nNode: {CANARY_HOST}:{CANARY_PORT}\n\n"
        f"The OpenCanary node has returned to normal operation after a reported outage.",
    )


# ── entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="OpenCanary health monitor")
    parser.add_argument("--test", action="store_true",
                        help="Test all honeypot ports on both interfaces and email a report")
    args = parser.parse_args()

    if args.test:
        sys.exit(run_test())

    state = _load_state()

    if is_reachable() and service_active():
        if state.get("alert_sent"):
            notify_returned()
        _save_state({"was_down": False, "alert_sent": False, "last_alert_date": None})
        sys.exit(0)

    print(f"[{now()}] OpenCanary DOWN — starting recovery ...")

    if not is_reachable():
        if _should_alert_today(state):
            notify_failure(reachable=False,
                           restart_log="(SSH unreachable — not attempted)",
                           reboot_log="(SSH unreachable — not attempted)")
            state["alert_sent"] = True
            state["last_alert_date"] = today()
        state["was_down"] = True
        _save_state(state)
        sys.exit(1)

    restart_ok, restart_log = attempt_restart()
    if restart_ok:
        notify_restart_success(restart_log)
        _save_state({"was_down": False, "alert_sent": False, "last_alert_date": None})
        sys.exit(0)

    print(f"[{now()}] Restart failed — rebooting ...")
    reboot_ok, reboot_log = attempt_reboot()
    if reboot_ok:
        notify_reboot_success(restart_log, reboot_log)
        _save_state({"was_down": False, "alert_sent": False, "last_alert_date": None})
        sys.exit(0)

    if _should_alert_today(state):
        notify_failure(reachable=is_reachable(), restart_log=restart_log, reboot_log=reboot_log)
        state["alert_sent"] = True
        state["last_alert_date"] = today()
    state["was_down"] = True
    _save_state(state)
    sys.exit(2)


if __name__ == "__main__":
    main()
