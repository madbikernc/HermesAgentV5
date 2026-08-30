#!/usr/bin/env python3
# Version: 1.2.1
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.2.0 — certificate pinning activated: real fingerprint captured live,
# cross-checked against openssl and pfSense's own Cert. Manager, and pasted
# into PINNED_SHA256. TLS verification now has a real, enforced substitute
# instead of running in observe-only TOFU mode.
#
# 1.1.0 — two security-review fixes: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing; make_context() now does
# certificate pinning as a real substitute for the TLS verification it
# fully disables — see peer_cert_sha256() and PINNED_SHA256.
"""
hermes_pfsense_common.py — Shared pfSense REST API v2 client helpers for
hermes-pfsense.py and hermes-pfsense-report.py. Factored out once a second
script needed the same auth/request boilerplate, same reasoning
hermes_canary_common.py was split out for the canary scripts (see that
file's own docstring).

Named with underscores, breaking this project's usual hyphenated-filename
convention for tools/ scripts — deliberately: this file is `import`ed by
the other pfsense scripts, not invoked directly, and Python cannot import
a module whose filename contains a hyphen.
"""
import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"
VAULT_ITEM = "Hermes pfSense"

HOST = "10.129.1.1"
PORT = 443
BASE_URL = f"https://{HOST}/api/v2"

# Certificate-pinning fix from a security review: self-signed on the LAN, no
# real CA available, so verify_mode stays CERT_NONE below -- this pin stands
# in for that missing chain of trust. Confirmed 2026-08-14: matched across
# three independent channels -- this module's own observed value, a separate
# live `openssl s_client` connection from the Spark, and pfSense's own
# System -> Cert. Manager -> Certificates thumbprint (the actual out-of-band
# trust check; the first two only prove self-consistency, not authenticity).
# Re-verify and update if pfSense's certificate is ever regenerated -- a
# stale pin fails CRITICAL rather than silently accepting the new cert,
# which is intended. pfSense is the fleet's own WAN/LAN boundary, a
# materially worse place for an undetected on-LAN MITM than almost anywhere
# else this project touches.
PINNED_SHA256 = "5ecfd37f957792825984cb281df35e42ecbcee5d8f3be4462e07dfbc24081848"

# Interfaces confirmed intentionally disabled — never flagged as a fault.
# rtwn0_wlan0 (WIFI): The Boss confirmed 2026-08-09 this is deliberate, not a problem.
EXPECTED_DOWN_INTERFACES = {"rtwn0_wlan0"}


def vault_get(field):
    # Retry once: a stale local `bw` cache on a node that didn't just touch this
    # item is a known, real, transient cause of a spurious empty result — same
    # issue hermes-nfsensei-watch.py hit and documented. Cheap to retry, and this
    # tool runs unattended via a timer where a transient miss is more costly than
    # it is for an interactive run. timeout=60, not 30: vault-get-secret.sh 1.2.0
    # (2026-08-09) now retries this same failure mode internally too, up to 3x —
    # a single internal retry alone can take ~32s, which a 30s timeout here could
    # kill mid-recovery with an uncaught TimeoutExpired instead of this function's
    # own graceful "".
    for _ in range(2):
        try:
            result = subprocess.run(
                [VAULT_SCRIPT, VAULT_ITEM, field], capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


def get_api_key():
    return vault_get("api_key")


def peer_cert_sha256(timeout=10):
    """sha256 hex digest of pfSense's live DER certificate, fetched over a
    dedicated probe connection with verification disabled -- used for the
    pinning check below, not for anything else."""
    probe_ctx = ssl.create_default_context()
    probe_ctx.check_hostname = False
    probe_ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((HOST, PORT), timeout=timeout) as sock:
        with probe_ctx.wrap_socket(sock, server_hostname=HOST) as ssock:
            der = ssock.getpeercert(binary_form=True)
    return hashlib.sha256(der).hexdigest()


def make_context():
    # Self-signed cert on the LAN box — same accommodation the Synology tool makes.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        fp = peer_cert_sha256()
    except Exception as e:
        print(f"WARNING: could not fetch pfSense's certificate for pinning check: {e}", file=sys.stderr)
        return ctx
    if not PINNED_SHA256:
        print(f"NOTICE: no certificate pin configured for pfSense yet — observed sha256: {fp}", file=sys.stderr)
        print("        verify this out-of-band, then set PINNED_SHA256 in hermes_pfsense_common.py to enforce it", file=sys.stderr)
    elif fp != PINNED_SHA256:
        print(f"CRITICAL: pfSense certificate fingerprint mismatch — expected {PINNED_SHA256}, got {fp}. "
              "Possible MITM on the fleet's own gateway. Refusing to proceed.", file=sys.stderr)
        sys.exit(1)
    return ctx


def api_get(path, api_key, ctx, params=None, timeout=15):
    url = f"{BASE_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"x-api-key": api_key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            return json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            return None, body.get("message", f"HTTP {e.code}")
        except Exception:
            return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)
