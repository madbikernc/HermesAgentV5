#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-09-03) — built as the interim path for the camera at 10.129.1.19: confirmed live
# (ping answers instantly and repeatedly, but a port scan of 80/443/9000/8000/554 all get an
# immediate connection refused -- not a timeout) that this is a standalone battery/solar Reolink
# camera with no Reolink Home Hub or NVR paired to it. Reolink's own support documentation states
# plainly that standalone battery-powered cameras do not support local web/CGI API access at all --
# a hardware/firmware limitation, not a setting -- and the only officially supported way to get
# programmatic local access is through a Home Hub or NVR, which exposes its own local API and
# proxies to the paired camera. hermes-reolink.py's entire design (reolink_aio's
# Host(ip, user, pass) local-API polling) cannot work against this camera and won't until a Home
# Hub/NVR is purchased and the camera is re-paired to it -- direct request, deferred for now.
#
# Interim path, direct request: rely on the camera's own native "email me a snapshot on AI
# detection" feature (configured once in the Reolink app's Detection & Alarm settings, no local API
# needed at all) instead of external polling. This tool watches one IMAP mailbox for those native
# alert emails, pulls the attached JPEG snapshot, describes it with the same router/omni vision call
# hermes-reolink.py's on-demand path already uses, and re-sends a cleaner, AI-described alert to the
# fleet notification address. No injection screening here, deliberately -- same posture as
# hermes-reolink.py's own check_ai_detection() path: there is no user-supplied natural-language
# instruction driving further agent action, just a fixed prompt over an image and a fixed outbound
# email, so there is nothing for hermes_injection_guard to usefully screen.
#
# Trade-off versus the local-API design this replaces, made explicit rather than silently accepted:
# no on-demand "check the camera right now" chat path exists here at all -- that needs a live
# connection to the camera that, per the finding above, only a Home Hub/NVR can provide. This tool
# only covers the AI-detection alert half of the original design.
"""
hermes-reolink-mail-watch.py — interim Reolink AI-detection alerting via the camera's own native
email-on-detection feature, for a standalone battery/solar camera with no local CGI API. See this
file's own header comment and infra/hermes-reolink/README.md for why hermes-reolink.py's polling
design cannot reach this camera today.

Polls one IMAP mailbox for unread messages. Any message carrying a JPEG attachment is treated as a
camera alert: the image is described via the router's `omni` vision model and a cleaner alert email
is sent to the fleet notification address. Messages without a recognizable image attachment are
marked read and skipped, not left to be reprocessed forever. A message is marked read only after
it's been fully handled (or definitively given up on), so a crash mid-cycle leaves it unread for a
safe retry on the next poll rather than silently losing it.

Config, all from the environment (injected by hermes-reolink-mail-watch-wrapper.sh):
  ROUTER_URL       default http://127.0.0.1:8080 — co-resident with `omni` on Forge (spark-2), same
                   placement reasoning as hermes-reolink.py/hermes-nest.py
  MEMORY_URL/MEMORY_TOKEN — used only to persist the cross-restart cooldown timestamp
                   (hermes-memory's /state endpoint), same pattern hermes-reolink.py's own cooldown
                   already uses
  POLL_SECONDS     default 60 — IMAP is not latency-critical the way the old 3s local poll was; the
                   camera's own alert email typically arrives well under a minute after the event
  COOLDOWN_SECONDS default 60 — backstop only. The camera's own alert cadence already debounces most
                   repeat triggers; this just guards against a burst of several emails landing in
                   one poll cycle
"""

import email
import imaplib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")

POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))
COOLDOWN_SECONDS = int(os.environ.get("COOLDOWN_SECONDS", "60"))

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_GET = str(REPO_DIR / "tools" / "vault-get-secret.sh")
MAIL_ITEM = "Hermes Reolink Mail"

DESCRIBE_SYSTEM_PROMPT = (
    "You are looking at one frame from a home security camera. Describe factually what's visible "
    "-- people, vehicles, animals, packages, notable activity or lack of it. Do not speculate about "
    "identity, intent, or anything not actually visible in the frame. One or two sentences."
)

# Same outbound identity/recipient hermes-reolink.py's own send_email() uses -- one fleet
# notification channel, not a second one for this interim path.
SMTP_HOST = "mail.hover.com"
SMTP_PORT = 587
SMTP_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"


def log(msg):
    print(f"[hermes-reolink-mail-watch] {msg}", flush=True)


# ── vault plumbing (unchanged copy of hermes-reolink.py's own) ────────────────────────────────────

def _vault_get(item, field):
    for _ in range(2):
        try:
            result = subprocess.run([VAULT_GET, item, field], capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


def load_mail_config():
    host = _vault_get(MAIL_ITEM, "host") or "mail.hover.com"
    port = int(_vault_get(MAIL_ITEM, "port") or "993")
    username = _vault_get(MAIL_ITEM, "username")
    password = _vault_get(MAIL_ITEM, "password")
    if not all([username, password]):
        sys.exit(f"ERROR: incomplete config in vault item '{MAIL_ITEM}' (need username, password)")
    return host, port, username, password


# ── plain HTTP helpers (unchanged copies of hermes-reolink.py's own) ──────────────────────────────

def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def get_last_capture():
    try:
        entries = _get(f"{MEMORY_URL}/state/reolink-mail-watch", MEMORY_TOKEN).get("state", [])
    except Exception as exc:
        log(f"could not read cooldown state, proceeding as if no cooldown active: {exc}")
        return 0
    for e in entries:
        if e["key"] == "last_alert":
            return e.get("value", {}).get("last_capture", 0)
    return 0


def set_last_capture(epoch):
    try:
        _post(f"{MEMORY_URL}/state",
              {"agent": "reolink-mail-watch", "key": "last_alert", "value": {"last_capture": epoch}},
              MEMORY_TOKEN)
    except Exception as exc:
        log(f"could not persist cooldown state (non-fatal): {exc}")


def describe_frame(image_bytes):
    import base64
    b64 = base64.b64encode(image_bytes).decode("ascii")
    body = {
        "model": "omni",
        "messages": [
            {"role": "system", "content": DESCRIBE_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ]},
        ],
        "max_tokens": 200,
    }
    result = _post(f"{ROUTER_URL}/v1/chat/completions", body, timeout=60)
    return result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()


def send_email(subject, body):
    import smtplib
    from email.mime.text import MIMEText

    password = _vault_get("email-sintra", "password")
    if not password:
        log("ERROR: could not fetch email-sintra password from vault — alert not sent")
        return False

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
            server.starttls()
            server.login(SMTP_FROM, password)
            server.send_message(msg)
        return True
    except Exception as exc:
        log(f"ERROR: email send failed: {exc}")
        return False


# ── IMAP polling ───────────────────────────────────────────────────────────────────────────────

def extract_jpeg(msg):
    """Return the first image/jpeg attachment's bytes, or None if the message has none."""
    for part in msg.walk():
        if part.get_content_type() in ("image/jpeg", "image/jpg"):
            payload = part.get_payload(decode=True)
            if payload:
                return payload
    return None


def poll_once(host, port, username, password):
    conn = imaplib.IMAP4_SSL(host, port)
    try:
        conn.login(username, password)
        conn.select("INBOX")
        status, data = conn.search(None, "UNSEEN")
        if status != "OK":
            log(f"IMAP search failed: {status}")
            return
        uids = data[0].split()
        if not uids:
            return
        log(f"{len(uids)} unread message(s)")

        for uid in uids:
            status, msg_data = conn.fetch(uid, "(RFC822)")
            if status != "OK" or not msg_data or not msg_data[0]:
                log(f"could not fetch message {uid!r}, leaving unread for retry")
                continue
            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)
            subject = msg.get("Subject", "(no subject)")

            image_bytes = extract_jpeg(msg)
            if not image_bytes:
                log(f"message {uid!r} ({subject!r}) has no JPEG attachment — marking read, skipping")
                conn.store(uid, "+FLAGS", "\\Seen")
                continue

            since_last = time.time() - get_last_capture()
            if since_last < COOLDOWN_SECONDS:
                log(f"message {uid!r} ({subject!r}) dropped — within cooldown "
                    f"({since_last:.0f}s < {COOLDOWN_SECONDS}s)")
                conn.store(uid, "+FLAGS", "\\Seen")
                continue

            try:
                description = describe_frame(image_bytes)
                body = f"Source: {subject}\n\n{description}"
                ok = send_email("Reolink camera alert", body)
                if not ok:
                    log(f"message {uid!r}: alert email delivery failed — result not lost, just not delivered")
                set_last_capture(time.time())
            except Exception as exc:
                log(f"message {uid!r}: describe/send failed: {exc}")
            # Marked read regardless of describe/send outcome -- the source email itself isn't
            # lost (still in the mailbox, just marked read), and retrying the same message forever
            # on a persistent describe/send failure would just re-fail identically every cycle.
            conn.store(uid, "+FLAGS", "\\Seen")
    finally:
        try:
            conn.close()
        except Exception:
            pass
        try:
            conn.logout()
        except Exception:
            pass


def main():
    host, port, username, password = load_mail_config()
    log(f"watching {username} on {host}:{port} for Reolink alert emails, poll every {POLL_SECONDS}s")
    while True:
        try:
            poll_once(host, port, username, password)
        except Exception as exc:
            log(f"unhandled error this cycle, continuing: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
