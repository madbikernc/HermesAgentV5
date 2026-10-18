#!/usr/bin/env python3
# Version: 1.3.0
#
# 1.3.0 (2026-10-18) - S40 Phase B (design doc §8.3): send_email() gains a `priority="normal"`
# kwarg. priority="critical" prefixes the subject with "[CRITICAL] " (matching
# hermes-node-health.py's own live severity-tag convention, skipped if already present) and sets
# `Importance: high`/`X-Priority: 1`. Every existing caller is unaffected -- the default stays
# "normal", exactly one subject and one priority, same as before this kwarg existed. Used by
# hermes_egress_guard.py's new §8 deny-report pipeline for its own hi-pri alert. Also now returns
# True/False (sent vs. skipped-or-failed) instead of nothing -- added so hermes-model-scan.py/
# -watch.py/hermes-linodemercury-watch.py's own duplicate send_email()s, each of which returned a
# boolean its own caller checked, could be consolidated onto this one without losing that check
# (same §8.2 consolidation the design doc calls out, now actually done for the three real
# duplicates S40 Phase A's own wrapping touched -- not hermes-fleet-health.py/hermes-model-
# scout.py, which the design doc named but which turned out not to have their own send_email at
# all; see EGRESS_GUARD_DESIGN.md's own revision note).
#
# 1.2.0 (2026-10-18) - S40 Layer 3: send_email() and matrix_notice() now call
# hermes_egress_guard.check_destination() before reaching mail.hover.com / MATRIX_HOMESERVER,
# same as every other real external call site this stage wraps. mail.hover.com is on this
# module's own entry in the tool registry's allowlist (infra/firmament-tool-registry.yaml); the
# Matrix homeserver resolves as fleet-internal under its default (127.0.0.1) and needs no entry.
# Both functions keep their "never raises" contract -- a denial is caught by the same try/except
# that already handles every other failure here. Pure hardening; nothing changes about what a
# normal call does.
#
# 1.1.0 (2026-10-16) - real gap found deploying hermes-boot-unit-check.py (S32 item a): it has
# no wrapper script, so EMAIL_PASSWORD/FLEETOPS_MATRIX_TOKEN/FLEETOPS_ROOM were never set and
# its alerts silently no-op'd ("no EMAIL_PASSWORD" every run). hermes-router-wrapper.sh's own
# 2.1.0 comment already states the reason the two existing patterns differ: a resident daemon
# prefetches once via a wrapper (free amortized over its whole lifetime); a one-shot script
# calls vault-get-secret.sh directly per invocation, same as hermes-fleet-health.py and
# hermes-linodemercury-watch.py already do. This module now does the latter itself, as a
# fallback, so a one-shot caller needs no wrapper of its own: the env var still wins and is
# checked first (free, and preserves hermes-router.py's existing zero-cost fast path exactly as
# it was), and only an UNSET env var falls through to one cached-per-process vault fetch.
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
# Environment variables (all optional -- a resident daemon's own wrapper script should still
# set these so this module never has to touch vault from inside a hot request path):
#   EMAIL_PASSWORD          if unset, falls back to vault item email-sintra/password.
#   MATRIX_HOMESERVER       default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN   if unset, falls back to vault item matrix-fleetops/password.
#   FLEETOPS_ROOM           if unset, falls back to vault item matrix-fleetops/room.

import json
import os
import smtplib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.mime.text import MIMEText
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_egress_guard  # noqa: E402

VAULT_SCRIPT = str(Path(__file__).resolve().parent / "vault-get-secret.sh")

EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")
EMAIL_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")

_email_warned = False
_email_password_cache = None   # None = not yet resolved; "" = resolved, genuinely absent
_fleetops_cache = None         # None = not yet resolved; else (token, room), either may be ""


def _vault_get(item, field, timeout=60):
    # Same discipline as every other caller of vault-get-secret.sh in this fleet (e.g.
    # hermes-linodemercury-watch.py's own vault_get()): a Vaultwarden outage must not crash or
    # hang the caller's real job, so a timeout or non-zero exit is a soft "" result.
    try:
        r = subprocess.run([VAULT_SCRIPT, item, field], capture_output=True, text=True, timeout=timeout)
    except Exception:
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def _resolve_email_password():
    global _email_password_cache
    if EMAIL_PASSWORD:
        return EMAIL_PASSWORD
    if _email_password_cache is None:
        _email_password_cache = _vault_get("email-sintra", "password")
    return _email_password_cache


def _resolve_fleetops():
    global _fleetops_cache
    if FLEETOPS_TOKEN and FLEETOPS_ROOM:
        return FLEETOPS_TOKEN, FLEETOPS_ROOM
    if _fleetops_cache is None:
        _fleetops_cache = (_vault_get("matrix-fleetops", "password"), _vault_get("matrix-fleetops", "room"))
    return _fleetops_cache


def send_email(subject, body, log=print, priority="normal"):
    """Best-effort -- never raises. Returns True once the message was actually handed to the
    SMTP server, False on any skip or failure (no password, egress denied, connection/auth
    error) -- added in the S40 Phase B consolidation so a caller that used to check its own
    duplicate send_email()'s return value keeps working after switching to this one.

    `priority="critical"` (S40 §8.3): prefixes the subject with the same `[CRITICAL] ...`
    convention hermes-node-health.py's own severity tagging already uses live, and sets
    `Importance: high` / `X-Priority: 1` so a mail client flags it ahead of routine digests.
    Every other caller is unaffected -- the default stays "normal", one subject, one priority,
    exactly as before this kwarg existed."""
    global _email_warned
    password = _resolve_email_password()
    if not password:
        if not _email_warned:
            log("no EMAIL_PASSWORD (env or vault email-sintra) — email alerts disabled for "
                "this process's lifetime")
            _email_warned = True
        return False
    if priority == "critical" and not subject.startswith("[CRITICAL]"):
        subject = f"[CRITICAL] {subject}"
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"
    if priority == "critical":
        msg["Importance"] = "high"
        msg["X-Priority"] = "1"
    try:
        hermes_egress_guard.check_destination("mail.hover.com", "hermes_alert_common.py")  # S40 Layer 3
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, password)
            server.send_message(msg)
        return True
    except Exception as exc:
        log(f"alert email failed: {exc}")
        return False


def matrix_notice(text, log=print):
    """Best-effort real-time notice to FleetOps. Never raises."""
    token, room = _resolve_fleetops()
    if not token or not room:
        return
    try:
        hermes_egress_guard.check_destination(MATRIX_HOMESERVER, "hermes_alert_common.py")  # S40 Layer 3
        txn = f"alert-note-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(room)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"notice delivery failed: {exc}")
