#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — two security-review fixes: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing on a complete Vaultwarden
# outage; run_canary_report()'s own subprocess timeout raised 60s→240s to
# actually cover its child's worst-case runtime (~210s: a 30s SSH pull plus
# up to 180s for a reasoning-model call), also now caught gracefully instead
# of crashing.
"""
hermes-canary-probe-report.py — Canary event report + full investigation of
every non-fleet source IP (Phase 18, IMPLEMENTATION_PLAN.md §7).

For every unique source IP in the canary events since the last report
(excluding Spark's and HomeD13's own IPs — see hermes_canary_common.py):
  - Runs a full hermes-node-probe (DNS/reverse-DNS, MAC/vendor, exhaustive
    nmap OS + service scan)
  - Runs a full hermes-security-scan pass (whois, exhaustive nmap all-ports
    scan)
Both run synchronously so everything lands in one combined email — a full
port sweep can take 10-30 minutes per target, so this script is meant for a
scheduled/background run, not an interactive one.

Ported from v1 (HermesAgent/scripts/canary-probe-report.py). Only real
change: SMTP credentials moved to Vaultwarden, same as the other canary
scripts.

Usage:
  python3 hermes-canary-probe-report.py [--to recipient@domain]

Recommended timer (daily at 08:00): see hermes-canary-probe-report.timer.
"""

import argparse
import importlib.util
import json
import os
import smtplib
import subprocess
import sys
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"
sys.path.insert(0, str(SCRIPT_DIR))
from hermes_canary_common import get_known_infra_ips  # noqa: E402

FROM_ADDR = "mercury@canislupisnc.net"
SMTP_HOST = "mail.hover.com"
SMTP_USER = "mercury@canislupisnc.net"
DEFAULT_TO = "notifications@canislupisnc.net"

JSON_START = "###EVENTS_JSON_START###"
JSON_END = "###EVENTS_JSON_END###"

# hermes-security-scan.py sends its own email in main() — import its reusable
# pieces directly instead of invoking the CLI, so this script controls the
# one combined email itself.
_spec = importlib.util.spec_from_file_location("hermes_security_scan", SCRIPT_DIR / "hermes-security-scan.py")
hermes_security_scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hermes_security_scan)


def vault_get(item, field):
    # timeout=60, not 30: vault-get-secret.sh 1.2.0 retries internally up to 3x on a real
    # transient bw/Vaultwarden failure; a 30s timeout could kill it mid-recovery.
    # Security-review fix: a *complete* outage (both this call and the internal
    # retries exhausting the full 60s) previously raised TimeoutExpired uncaught.
    try:
        result = subprocess.run(
            [VAULT_SCRIPT, item, field], capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def run_canary_report() -> tuple[str, dict]:
    """Run hermes-canary-report.py; return (human-readable text, {ip: [event dicts]})."""
    # timeout=240, not 60: the child's own worst case is ~210s (pull_logs()'s
    # timeout=30 SSH pull + ask_llm()'s timeout=180 reasoning-model call), so a
    # 60s parent timeout would kill a legitimately slow-but-healthy run mid-way
    # -- found in a security review alongside the matching uncaught-TimeoutExpired
    # bug this same fix also closes.
    try:
        result = subprocess.run(
            ["python3", str(SCRIPT_DIR / "hermes-canary-report.py")],
            capture_output=True, text=True, timeout=240,
        )
    except subprocess.TimeoutExpired:
        return "[hermes-canary-report error]\ntimed out after 240s", {}
    stdout = result.stdout
    if result.returncode != 0 and not stdout:
        return f"[hermes-canary-report error]\n{result.stderr.strip()}", {}

    if JSON_START in stdout and JSON_END in stdout:
        human = stdout.split(JSON_START)[0].strip()
        raw_json = stdout.split(JSON_START, 1)[1].split(JSON_END)[0].strip()
        try:
            data = json.loads(raw_json)
            return human, data.get("by_src", {})
        except json.JSONDecodeError:
            return human, {}
    return stdout.strip(), {}


def format_connections(events: list) -> str:
    """Human-readable per-IP connection detail: service/port/timestamps."""
    from collections import defaultdict
    groups = defaultdict(list)
    for e in events:
        groups[(e["port"], e["service"], e["type"])].append(e["time"])
    lines = []
    for (port, service, etype), times in sorted(groups.items(), key=lambda x: -len(x[1])):
        shown = [t.split(".")[0] for t in times[:20]]
        more = f" (+{len(times) - 20} more)" if len(times) > 20 else ""
        lines.append(f"  {service}/{port} ({etype}): {len(times)}x at "
                     f"{', '.join(shown)} UTC{more}")
    return "\n".join(lines)


def run_node_probe(ip: str) -> str:
    """Full node-probe: DNS/reverse-DNS, MAC/vendor, exhaustive nmap OS+service scan."""
    result = subprocess.run(
        ["python3", str(SCRIPT_DIR / "hermes-node-probe.py"), ip],
        capture_output=True, text=True, timeout=1900,
    )
    out = result.stdout.strip()
    err = result.stderr.strip()
    return out or err or "(no output)"


def run_security_scan(ip: str, event_desc: str) -> str:
    """Full security-scan: whois + exhaustive nmap all-ports scan. Returns
    formatted text; does not send its own email (see hermes_security_scan import)."""
    whois_text = hermes_security_scan.whois_lookup(ip)
    nmap_text, _ = hermes_security_scan.run_nmap(ip, xml_path="/dev/null")
    return (
        f"Event: {event_desc}\n\n"
        f"{'=' * 55}\nWHOIS / OWNERSHIP\n{'=' * 55}\n{whois_text}\n\n"
        f"{'=' * 55}\nNMAP (all 65535 ports, service detection)\n{'=' * 55}\n{nmap_text}"
    )


def send_email(to: str, subject: str, body: str) -> None:
    msg = MIMEMultipart()
    msg["From"]    = FROM_ADDR
    msg["To"]      = to
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))
    try:
        password = vault_get("email-sintra", "password")
        with smtplib.SMTP(SMTP_HOST, 587, timeout=30) as s:
            s.starttls()
            s.login(SMTP_USER, password)
            s.sendmail(FROM_ADDR, [to], msg.as_string())
    except Exception as e:
        print(f"Email failed: {e}", file=sys.stderr)


def divider(title: str = "", width: int = 62) -> str:
    if title:
        pad = width - len(title) - 4
        return f"{'─' * 2} {title} {'─' * max(pad, 2)}"
    return "─" * width


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--to", default=DEFAULT_TO, help="Report recipient email")
    args = parser.parse_args()

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"[hermes-canary-probe-report] {now}")

    print("[1/3] Running canary-report...")
    canary_output, by_src = run_canary_report()

    if not by_src:
        print("[hermes-canary-probe-report] No events — exiting silently.")
        return

    infra_ips = get_known_infra_ips()
    actionable = {ip: events for ip, events in by_src.items() if ip not in infra_ips}
    print(f"      Found {len(by_src)} source IP(s); {len(actionable)} not from Spark/HomeD13.")

    if not actionable:
        print("[hermes-canary-probe-report] All source IPs belong to Spark/HomeD13 — exiting silently.")
        return

    print(f"[2/3] Investigating {len(actionable)} source IP(s) (node-probe + security-scan, "
          f"this can take a while)...")
    ip_sections: list[str] = []
    for ip, events in actionable.items():
        print(f"      {ip}: {len(events)} connection attempt(s)")
        event_desc = f"OpenCanary honeypot hits at {now} ({len(events)} attempt(s))"

        print(f"        node-probe {ip}...")
        probe_out = run_node_probe(ip)

        print(f"        security-scan {ip}...")
        scan_out = run_security_scan(ip, event_desc)

        ip_sections.append(
            f"{divider(f'SOURCE IP — {ip}')}\n\n"
            f"Connections:\n{format_connections(events)}\n\n"
            f"{divider('NODE PROBE')}\n{probe_out}\n\n"
            f"{divider('SECURITY SCAN')}\n{scan_out}\n"
        )

    print("[3/3] Sending combined report email...")

    lines = [
        "Canary + Full Investigation Report",
        f"Generated : {now}",
        f"Spark     : home-spark",
        "",
        divider("CANARY EVENTS"),
        "",
        canary_output,
        "",
        divider("INVESTIGATED SOURCE IPs (not Spark/HomeD13)"),
        "",
    ]
    lines += ip_sections

    body    = "\n".join(lines)
    subject = f"Canary Alert — {len(actionable)} source IP(s) investigated — {now}"

    send_email(args.to, subject, body)
    print(f"[+] Report sent to {args.to}")


if __name__ == "__main__":
    main()
