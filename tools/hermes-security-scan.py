#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — two security-review fixes: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing; TARGET_RE validation moved
# into run_nmap()/whois_lookup() themselves (previously only enforced in
# main(), so hermes-canary-probe-report.py importing and calling these
# functions directly bypassed it entirely on the one path where `target`
# actually originates from untrusted honeypot log data).
"""
hermes-security-scan.py — Run an nmap scan against a target IP/hostname and
email the results as an attachment. Part of Phase 18's canary/honeypot
integration (IMPLEMENTATION_PLAN.md §7).

Ported from v1 (HermesAgent/scripts/security-scan.py). The only real
change: v1 read SMTP credentials from a plaintext ~/.hermes/config/email.json;
this project's own constraint (§2b, "Credentials live in Vaultwarden") means
that file must not exist here — credentials are fetched fresh from
Vaultwarden via tools/vault-get-secret.sh on every run instead, same
"email-sintra" item already used by tools/hermes-fleet-health.py.

Usage:
  python3 hermes-security-scan.py <target> [--event "description"] [--to recipient@domain]

Examples:
  python3 hermes-security-scan.py 203.0.113.45
  python3 hermes-security-scan.py 203.0.113.45 --event "SSH_NEW_CONNECTION on OpenCanary"
  python3 hermes-security-scan.py 203.0.113.45 --to admin@example.com
"""
import argparse
import os
import re
import smtplib
import subprocess
import sys
import tempfile
from datetime import datetime
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"

FROM = "mercury@canislupisnc.net"
SMTP = "mail.hover.com"
USER = "mercury@canislupisnc.net"
DEFAULT_TO = "notifications@canislupisnc.net"

NMAP_FLAGS = ["-Pn", "-p-", "-sV", "--open", "-T4"]

# Target must look like an IP or hostname — in particular it must not start with
# "-" (which nmap/whois would parse as a flag) and can't contain spaces or shell
# metacharacters. This matters because `target` can originate from an untrusted
# honeypot log field (src_host) forwarded by hermes-canary-probe-report.py.
TARGET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:_-]*$")


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


def run_nmap(target: str, xml_path: str) -> tuple[str, int]:
    # Validated here, not just in main(): hermes-canary-probe-report.py imports
    # this module and calls run_nmap()/whois_lookup() directly, bypassing
    # main()'s own TARGET_RE check entirely -- found in a security review.
    # `target` can originate from an untrusted honeypot log field (src_host)
    # on that path, so the guard has to live at the actual function boundary,
    # not only at the CLI entry point.
    if not TARGET_RE.match(target):
        return f"ERROR: '{target}' doesn't look like a valid IP/hostname — refusing to scan.", 1
    cmd = ["sudo", "nmap"] + NMAP_FLAGS + ["-oX", xml_path, target]
    print(f"[*] Running: {' '.join(cmd)}", flush=True)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=1800
        )
        output = result.stdout + (f"\n[stderr]\n{result.stderr}" if result.stderr.strip() else "")
        return output, result.returncode
    except FileNotFoundError:
        return "ERROR: nmap not found. Run: sudo apt install nmap", 1
    except subprocess.TimeoutExpired:
        return "ERROR: nmap timed out after 30 minutes", 1
    except Exception as e:
        return f"ERROR: {e}", 1


def whois_lookup(target: str) -> str:
    # Same validation-at-the-function-boundary fix as run_nmap() above.
    if not TARGET_RE.match(target):
        return f"(refused: '{target}' doesn't look like a valid IP/hostname)"
    try:
        r = subprocess.run(
            ["whois", target], capture_output=True, text=True, timeout=15
        )
        lines = [l for l in r.stdout.splitlines()
                 if any(k in l.lower() for k in
                        ("orgname", "org-name", "netname", "country", "descr",
                         "cidr", "inetnum", "abuse", "owner", "role"))]
        return "\n".join(lines[:20]) if lines else r.stdout[:500]
    except Exception as e:
        return f"(whois unavailable: {e})"


def send_report(to: str, target: str, event: str,
                nmap_text: str, nmap_xml: str, whois_text: str, exit_code: int):
    now = datetime.now()
    status = "SCAN COMPLETE" if exit_code == 0 else "SCAN ERROR"
    subject = f"Security Scan Alert — {target} — {now.strftime('%Y-%m-%d %H:%M')} — {status}"

    body = f"""\
Security Event Scan Report
Generated: {now.strftime('%Y-%m-%d %H:%M:%S')}
Target   : {target}
Event    : {event or '(manual scan)'}
Scanner  : hermes-security-scan (nmap {' '.join(NMAP_FLAGS)})

{'=' * 55}
WHOIS / OWNERSHIP
{'=' * 55}
{whois_text}

{'=' * 55}
NMAP SUMMARY
{'=' * 55}
{nmap_text}

Detailed XML report attached as nmap-{target}-{now.strftime('%Y%m%d%H%M')}.xml
"""

    msg = MIMEMultipart()
    msg["From"]    = FROM
    msg["To"]      = to
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    # Attach plain-text nmap output
    txt_attach = MIMEApplication(nmap_text.encode(), Name=f"nmap-{target}-{now.strftime('%Y%m%d%H%M')}.txt")
    txt_attach["Content-Disposition"] = f'attachment; filename="nmap-{target}-{now.strftime("%Y%m%d%H%M")}.txt"'
    msg.attach(txt_attach)

    # Attach XML if it was written
    xml_path = Path(nmap_xml)
    if xml_path.exists() and xml_path.stat().st_size > 0:
        xml_attach = MIMEApplication(xml_path.read_bytes(), Name=xml_path.name)
        xml_attach["Content-Disposition"] = f'attachment; filename="{xml_path.name}"'
        msg.attach(xml_attach)

    password = vault_get("email-sintra", "password")
    with smtplib.SMTP(SMTP, 587, timeout=30) as s:
        s.starttls()
        s.login(USER, password)
        s.sendmail(FROM, [to], msg.as_string())

    print(f"[+] Report sent to {to}: {subject}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("target", help="IP address or hostname to scan")
    parser.add_argument("--event",  default="", help="Description of the triggering event")
    parser.add_argument("--to",     default=DEFAULT_TO, help="Recipient email address")
    args = parser.parse_args()

    target = args.target.strip()
    if not target:
        print("ERROR: target is required")
        sys.exit(1)
    if not TARGET_RE.match(target):
        print(f"ERROR: '{target}' doesn't look like a valid IP/hostname — refusing to scan.")
        sys.exit(1)

    # Whois while nmap starts
    print(f"[*] Whois lookup for {target}...", flush=True)
    whois_text = whois_lookup(target)

    with tempfile.NamedTemporaryFile(
        suffix=".xml",
        prefix=f"nmap-{target}-",
        delete=False
    ) as f:
        xml_path = f.name

    try:
        nmap_text, exit_code = run_nmap(target, xml_path)
        send_report(
            to=args.to,
            target=target,
            event=args.event,
            nmap_text=nmap_text,
            nmap_xml=xml_path,
            whois_text=whois_text,
            exit_code=exit_code,
        )
    finally:
        Path(xml_path).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
