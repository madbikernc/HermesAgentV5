#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-10-16) - S32 item (b)/(a): extracted from hermes-router.py's send_email()/
# matrix_notice(), which were the only implementation of either in the fleet. Pulled out so
# the new hermes-boot-unit-check.py (S32 item a) can alert through the same two channels
# instead of growing a third copy. hermes-router.py now imports these rather than keeping
# its own; behavior is unchanged -- same env vars, same best-effort/never-raises contract.
#
# Both helpers are best-effort and MUST NOT raise: a notification failure must never affect
# whatever primary job the caller is actually doing. Each caller passes its own `log`
# function so a failure is reported with that tool's own prefix instead of a generic one.
#
# Environment variables:
#   EMAIL_PASSWORD          optional -- if unset, send_email() is a no-op with a one-time
#                           warning (per process) instead of an error.
#   MATRIX_HOMESERVER       default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN   optional -- if unset (or FLEETOPS_ROOM is unset), matrix_notice()
#                           is a silent no-op.
#   FLEETOPS_ROOM           optional -- room to post notices into.

import json
import os
import smtplib
import time
import urllib.error
import urllib.parse
import urllib.request
from email.mime.text import MIMEText

EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")
EMAIL_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")

_email_warned = False


def send_email(subject, body, log=print):
    """Best-effort -- never raises."""
    global _email_warned
    if not EMAIL_PASSWORD:
        if not _email_warned:
            log("no EMAIL_PASSWORD — email alerts disabled for this process's lifetime")
            _email_warned = True
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, EMAIL_PASSWORD)
            server.send_message(msg)
    except Exception as exc:
        log(f"alert email failed: {exc}")


def matrix_notice(text, log=print):
    """Best-effort real-time notice to FleetOps. Never raises."""
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        return
    try:
        txn = f"alert-note-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"notice delivery failed: {exc}")
