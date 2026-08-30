#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR repointed from
# HermesAgentV4 to HermesAgentV5.
#
# 1.1.0 — HermesAgentV5 S13: STOPPED, not fixed in place. This entire tool exists to surface
# entries in Sintra's and Amy's own self-repair indexes — files only either persona's own agentic
# loop ever wrote to (skills/self-remediate/SKILL.md), via a skill neither has run since their
# gateways stopped at S8. Their index files are frozen; this reminder can now only ever re-report
# the same already-known stale contents (or nothing) forever. No V5 successor for the self-repair
# skill exists — dispatch/presenter's architecture doesn't have an equivalent concept, and inventing
# one is a real design decision, not something to do inside a currency-fix pass.
# `hermes-self-repair-reminder.timer` is stopped and disabled (IMPLEMENTATION_PLAN.md S13).
#
# hermes-self-repair-reminder — daily nudge to The Boss that anything in either identity's
# self-repair index (skills/self-remediate/SKILL.md) still needs an independent sanity check
# (IMPLEMENTATION_PLAN.md Stage 10, direct request).
#
# No model involved — reads both index files (Sintra's locally, Amy's over SSH, same pattern
# hermes-fleet-health.py already uses for per-identity checks) and, if either is non-empty, emails
# notifications@canislupisnc.net and posts a FleetOps notice with the real current contents. Keeps
# reminding every day for as long as an entry is still there -- clearing an entry (or the whole file)
# once it's been reviewed is a human action, not something this script or either persona does on its
# own; this script only ever reads, never writes or deletes.
#
# Deliberately boring: stdlib only, same as every other worker/report in this fleet.
#
# Config, all from the environment:
#   NOTIFY_EMAIL       default notifications@canislupisnc.net
#   EMAIL_FROM         default mercury@canislupisnc.net
#   MATRIX_HOMESERVER  default http://127.0.0.1:6167
#
# Usage: python3 hermes-self-repair-reminder.py [--no-email] [--no-fleetops]
import argparse
import json
import smtplib
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from email.mime.text import MIMEText

REPO_DIR = "/home/pmoney/HermesAgentV5"
VAULT_GET = f"{REPO_DIR}/tools/vault-get-secret.sh"
NOTIFY_EMAIL = "notifications@canislupisnc.net"
EMAIL_FROM = "mercury@canislupisnc.net"
MATRIX_HOMESERVER = "http://127.0.0.1:6167"

SINTRA_INDEX = "/home/sintra/.hermes/self-repair-index.md"
AMY_SSH = "spark2-amy"
AMY_INDEX = "/home/amy/.hermes/self-repair-index.md"


def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout, r.returncode
    except Exception as e:
        return "", -1


def read_sintra():
    out, rc = run(["sudo", "-u", "sintra", "cat", SINTRA_INDEX])
    return out if rc == 0 else ""


def read_amy():
    out, rc = run(["ssh", "-o", "ConnectTimeout=10", AMY_SSH, f"cat {AMY_INDEX}"])
    return out if rc == 0 else ""


def vault_get(item, field):
    out, rc = run([VAULT_GET, item, field])
    return out.strip() if rc == 0 else ""


def send_email(subject, body):
    password = vault_get("email-sintra", "password")
    if not password:
        print("ERROR: could not fetch email-sintra password from vault", file=sys.stderr)
        return False
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = NOTIFY_EMAIL
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, password)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"ERROR: email send failed: {e}", file=sys.stderr)
        return False


def post_fleetops(text):
    token = vault_get("matrix-fleetops", "password")
    room = vault_get("matrix-fleetops", "room")
    if not token or not room:
        print("ERROR: no FleetOps credentials", file=sys.stderr)
        return False
    try:
        room_enc = urllib.parse.quote(room)
        txn = f"selfrepair-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/{room_enc}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return True
    except Exception as e:
        print(f"ERROR: FleetOps post failed: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-email", action="store_true")
    parser.add_argument("--no-fleetops", action="store_true")
    args = parser.parse_args()

    sintra_content = read_sintra().strip()
    amy_content = read_amy().strip()

    if not sintra_content and not amy_content:
        print("[hermes-self-repair-reminder] both indexes empty — nothing to remind about")
        return

    lines = ["Self-repair index still has entries awaiting your independent sanity check:", ""]
    if sintra_content:
        lines.append("=== Sintra's self-repair index ===")
        lines.append(sintra_content)
        lines.append("")
    if amy_content:
        lines.append("=== Amy's self-repair index ===")
        lines.append(amy_content)
        lines.append("")
    body = "\n".join(lines)

    print(body)

    if not args.no_email:
        ok = send_email("[Hermes] Self-repair index needs your review", body)
        print(f"email {'sent' if ok else 'FAILED'}")
    if not args.no_fleetops:
        ok = post_fleetops(f"[self-repair-reminder] {body[:1500]}")
        print(f"FleetOps {'posted' if ok else 'FAILED'}")


if __name__ == "__main__":
    main()
