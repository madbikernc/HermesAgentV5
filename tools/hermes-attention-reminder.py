#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-attention-reminder — daily nudge that anything sitting in a "needs a human decision"
# hermes-memory task state for 24+ hours gets a real email (direct operator request, 2026-09-05).
#
# Spiritual successor to the now-retired tools/hermes-self-repair-reminder.py (V5 S13: "no V5
# successor for the self-repair skill exists... inventing one is a real design decision, not
# something to do inside a currency-fix pass") — same shape: read-only, no email spam beyond
# "still present," clears only when a human actually resolves the underlying thing, never by this
# script deleting or modifying anything.
#
# Honest scope note: "anytime a message requiring my attention goes unanswered" is, in full
# generality, a Matrix-read-receipt-tracking problem this script does NOT attempt. What it actually
# does is narrower and real: scan hermes-memory's `tasks` table (read-only, `hermes-memory.py`'s
# own connect(readonly=True), imported directly rather than reimplemented) for any task whose
# `state` is in ATTENTION_STATES and whose `updated_at` is more than ATTENTION_SECONDS old.
# ATTENTION_STATES defaults to just {"unresolved"} (tools/hermes-dualcoder.py's own escalation
# state, the first — and as of this writing, only — real "a human must decide" state this fleet
# produces) but is a plain set, meant to be extended the same way KNOWN_TOPICS/VALID_TARGETS
# already get extended ahead of a real consumer elsewhere in this codebase.
#
# Naturally self-limiting to one reminder per day by running once/day via its own timer -- no
# separate dedupe/suppress state needed: "still present at tomorrow's check" IS the "keep
# reminding every day for as long as it's still there" behavior wanted, and clearing an entry is a
# human action (resolving the underlying task), never something this script does.
#
# Config, all from the environment:
#   NOTIFY_EMAIL       default notifications@canislupisnc.net
#   EMAIL_FROM         default mercury@canislupisnc.net
#   MATRIX_HOMESERVER  default http://127.0.0.1:6167
#   ATTENTION_SECONDS  default 86400 (24h)
#   ATTENTION_STATES   default "unresolved" (comma-separated)
#
# Usage: python3 hermes-attention-reminder.py [--no-email] [--no-fleetops]
import argparse
import importlib
import json
import smtplib
import sys
import time
import urllib.parse
import urllib.request
from email.mime.text import MIMEText
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
_hermes_memory = importlib.import_module("hermes-memory")  # hyphenated filename, same pattern
                                                             # hermes-status.py uses for its siblings

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_GET = str(REPO_DIR / "tools" / "vault-get-secret.sh")
NOTIFY_EMAIL = "notifications@canislupisnc.net"
EMAIL_FROM = "mercury@canislupisnc.net"
MATRIX_HOMESERVER = "http://127.0.0.1:6167"
ATTENTION_SECONDS = 86400
ATTENTION_STATES = {"unresolved"}


def log(msg):
    print(f"[hermes-attention-reminder] {msg}", flush=True)


def vault_get(item, field):
    import subprocess
    try:
        r = subprocess.run([VAULT_GET, item, field], capture_output=True, text=True, timeout=30)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def find_stale_tasks():
    """Read-only scan -- never writes, never clears an entry. A task's own `updated_at` (REAL,
    epoch seconds, already in the schema -- no migration needed) is the staleness clock."""
    cutoff = time.time() - ATTENTION_SECONDS
    placeholders = ",".join("?" * len(ATTENTION_STATES))
    conn = _hermes_memory.connect(readonly=True)
    try:
        rows = conn.execute(
            f"SELECT id, agent, topic, state, updated_at FROM tasks "
            f"WHERE state IN ({placeholders}) AND updated_at < ? ORDER BY updated_at ASC",
            (*ATTENTION_STATES, cutoff),
        ).fetchall()
    finally:
        conn.close()
    return rows


def format_list(rows):
    now = time.time()
    lines = []
    for row in rows:
        age_hours = (now - row["updated_at"]) / 3600
        lines.append(f"  - task {row['id']!r} (agent={row['agent']}, topic={row['topic']}, "
                      f"state={row['state']}) — stale {age_hours:.1f}h")
    return "\n".join(lines)


def send_email(subject, body):
    password = vault_get("email-sintra", "password")
    if not password:
        log("no email-sintra vault credential — skipping email")
        return False
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = NOTIFY_EMAIL
    # The real lever available for "high priority" over plain SMTP -- most clients that honor
    # priority headers read these.
    msg["Importance"] = "high"
    msg["X-Priority"] = "1"
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, password)
            server.send_message(msg)
        return True
    except Exception as exc:
        log(f"email send failed: {exc}")
        return False


def post_fleetops(text):
    token = vault_get("fleetops-matrix-token", "password")
    room = vault_get("fleetops-room", "password")
    if not token or not room:
        log("no FleetOps Matrix credentials — skipping notice")
        return False
    try:
        txn = f"attention-reminder-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(room)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return True
    except Exception as exc:
        log(f"FleetOps notice failed: {exc}")
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-email", action="store_true")
    parser.add_argument("--no-fleetops", action="store_true")
    args = parser.parse_args()

    rows = find_stale_tasks()
    if not rows:
        log("no stale attention-needing tasks found")
        return

    listing = format_list(rows)
    subject = f"[ACTION NEEDED] {len(rows)} fleet task(s) awaiting your response"
    body = (
        f"{len(rows)} task(s) have been sitting in a state that needs a human decision for over "
        f"{ATTENTION_SECONDS / 3600:.0f} hours:\n\n{listing}\n\n"
        f"This is a daily reminder — it will repeat every day this list is non-empty. Resolving "
        f"the underlying task (not this email) is what clears it."
    )
    log(f"found {len(rows)} stale task(s)")

    if not args.no_email:
        if send_email(subject, body):
            log("email sent")
    if not args.no_fleetops:
        if post_fleetops(f"{subject}\n\n{listing}"):
            log("FleetOps notice posted")


if __name__ == "__main__":
    main()
