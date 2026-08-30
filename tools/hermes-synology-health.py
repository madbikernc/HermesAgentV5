#!/usr/bin/env python3
# Version: 1.2.1
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.2.0 — certificate pinning activated for both NAS devices: real
# fingerprints captured live, cross-checked against openssl and each DSM's
# own Control Panel, and pasted into pinned_sha256. TLS verification for
# both devices now has a real, enforced substitute instead of running in
# observe-only TOFU mode.
#
# 1.1.0 — two security-review fixes: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing; both devices' TLS
# verification (previously fully disabled with only a printed warning) now
# does certificate pinning as a real substitute — see peer_cert_sha256()
# and the pinned_sha256 field on each DEVICES entry.
"""
hermes-synology-health.py — Synology NAS health checker (Phase 17,
IMPLEMENTATION_PLAN.md §7: "DSM API — storage, SMART"). Queries both
Synology NAS devices on the home LAN via the DSM REST API and reports
system health, storage volumes, and disk SMART status.

Ported from v1 (HermesAgent/scripts/synology-health.py). The only real
change: v1 read credentials from a plaintext ~/.hermes/config/synology.json
(admin/password in the clear); this project's own constraint (§2b,
"Credentials live in Vaultwarden") means that file must not exist here —
credentials are fetched fresh from Vaultwarden via tools/vault-get-secret.sh
on every run instead. Also switched from the v1 `admin`-group account to a
dedicated, scoped `Hermes` user with no administrators-group membership on
either NAS — deliberately: a v1 comment notes DSM's "Enforce 2FA for
admins" policy (error 406) applies specifically to administrators-group
accounts, and the storage-info endpoint this script relies on already
works without admin-group membership, so there was no reason to hold
broader rights than the checks need.

Exits 0 always — errors per device are reported inline, matching v1.

Usage: python3 hermes-synology-health.py
"""
import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"

# pinned_sha256: certificate-pinning fix from a security review — both devices
# are self-signed with no real CA available, so `insecure: True` disabled TLS
# verification entirely with nothing standing in for it, leaving an on-LAN
# MITM undetectable. check_device() enforces this once set (mismatch is a
# CRITICAL, refused connection); prints an unenforced NOTICE with the
# observed value if left None. Both pins below confirmed 2026-08-14: matched
# across three independent channels — this tool's own observed value, a
# separate live `openssl s_client` connection from the Spark, and each DSM's
# own Control Panel → Security → Certificate thumbprint (the actual
# out-of-band trust check; the first two only prove self-consistency, not
# authenticity). Re-verify and update if either NAS's certificate is ever
# regenerated (renewal, reinstall, factory reset) — a stale pin fails
# CRITICAL rather than silently accepting the new cert, which is intended.
DEVICES = [
    {"name": "NAS1", "host": "10.129.1.165", "port": 5001, "vault_item": "Hermes Nas1",
     "insecure": True, "pinned_sha256": "c93175f61d7537c2f6ae6bba6c6a20e710e0d744fca55c15c9f9db95b556b5e4"},
    {"name": "NAS2", "host": "10.129.1.167", "port": 5001, "vault_item": "Hermes Nas2",
     "insecure": True, "pinned_sha256": "7d8301e812342032995042e6e55a79ed09c0db440c7f6272c3b30bd81144b678"},
]


def peer_cert_sha256(host, port, ctx, timeout=10):
    """Connects once and returns the sha256 hex digest of the peer's DER
    certificate. Used to pin the specific certificate in place of the
    hostname/CA verification that isn't available for a self-signed LAN
    device — getpeercert(binary_form=True) works even with verify_mode
    CERT_NONE, unlike the parsed-dict form, which requires verification to
    have actually run."""
    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as ssock:
            der = ssock.getpeercert(binary_form=True)
    return hashlib.sha256(der).hexdigest()


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


def make_context(device):
    if device.get("insecure", False):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return ssl.create_default_context()


def get(url, ctx):
    with urllib.request.urlopen(url, context=ctx, timeout=10) as r:
        return json.loads(r.read())


def api_call(host, port, sid, api_name, version, method, ctx, extra=None):
    params = {"api": api_name, "version": str(version), "method": method, "_sid": sid}
    if extra:
        params.update(extra)
    url = f"https://{host}:{port}/webapi/entry.cgi?" + urllib.parse.urlencode(params)
    try:
        return get(url, ctx)
    except Exception as e:
        return {"success": False, "error": str(e)}


def login(host, port, user, password, ctx):
    url = f"https://{host}:{port}/webapi/entry.cgi?" + urllib.parse.urlencode({
        "api": "SYNO.API.Auth", "version": "7", "method": "login",
        "account": user, "passwd": password, "format": "sid",
    })
    try:
        data = get(url, ctx)
        if data.get("success"):
            return data["data"]["sid"], None
        code = data.get("error", {}).get("code", "?")
        reason = {
            400: "invalid credentials",
            401: "account disabled",
            402: "permission denied",
            403: "OTP required",
            406: "global admin 2FA policy enforced — disable in DSM Control Panel → Security → Account",
        }.get(code, f"error code {code}")
        return None, reason
    except Exception as e:
        return None, str(e)


def logout(host, port, sid, ctx):
    try:
        api_call(host, port, sid, "SYNO.API.Auth", 7, "logout", ctx)
    except Exception:
        pass


def human(b):
    b = int(b)
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} EB"


def parse_uptime(up_time):
    try:
        h, m = int(str(up_time).split(":")[0]), int(str(up_time).split(":")[1])
        d, h = divmod(h, 24)
        parts = ([f"{d}d"] if d else []) + ([f"{h}h"] if h else []) + [f"{m}m"]
        return " ".join(parts)
    except Exception:
        return str(up_time)


def check_device(device):
    name = device.get("name", device["host"])
    host, port = device["host"], device.get("port", 5001)

    lines = [f"--- {name} ({host}) ---"]
    ctx = make_context(device)
    if device.get("insecure", False):
        lines.append("  WARNING: TLS certificate verification disabled for this device")
        try:
            fp = peer_cert_sha256(host, port, ctx)
        except Exception as e:
            lines.append(f"  ERROR: could not fetch peer certificate for pinning check: {e}")
            return "\n".join(lines)
        pinned = device.get("pinned_sha256")
        if not pinned:
            lines.append(f"  NOTICE: no certificate pin configured yet — observed sha256: {fp}")
            lines.append(f"          verify this out-of-band, then set pinned_sha256 in DEVICES to enforce it")
        elif fp != pinned:
            lines.append(f"  CRITICAL: certificate fingerprint mismatch — expected {pinned}, got {fp}. "
                         "Possible MITM. Refusing to connect.")
            return "\n".join(lines)

    user = vault_get(device["vault_item"], "username")
    password = vault_get(device["vault_item"], "password")
    if not user or not password:
        lines.append(f"  ERROR: could not fetch credentials from vault item '{device['vault_item']}'")
        return "\n".join(lines)

    sid, err = login(host, port, user, password, ctx)
    if err:
        lines.append(f"  LOGIN FAILED: {err}")
        return "\n".join(lines)

    try:
        # System info
        r = api_call(host, port, sid, "SYNO.Core.System", 3, "info", ctx)
        if r.get("success"):
            s = r["data"]
            lines.append(f"  Model : {s.get('model', '?')}  (S/N {s.get('serial', '?')})")
            lines.append(f"  DSM   : {s.get('firmware_ver', '?')}")
            lines.append(
                f"  CPU   : {s.get('cpu_vendor', '')} {s.get('cpu_series', '')} "
                f"{s.get('cpu_family', '')} @ {s.get('cpu_clock_speed', '?')} MHz "
                f"({s.get('cpu_cores', '?')} cores)"
            )
            lines.append(f"  Temp  : {s.get('sys_temp', '?')}°C{'  WARN' if s.get('sys_tempwarn') else ''}")
            lines.append(f"  Uptime: {parse_uptime(s.get('up_time', '?'))}")
            ram_mb = s.get("ram_size", 0)
            if ram_mb:
                lines.append(f"  RAM   : {ram_mb / 1024:.1f} GB total")
        else:
            code = r.get("error", {}).get("code", "?")
            lines.append(f"  System info: unavailable (code {code})")

        # Storage — volumes and disks via CGI endpoint (works without admin group membership)
        r = api_call(host, port, sid, "SYNO.Storage.CGI.Storage", 1, "load_info", ctx)
        if r.get("success"):
            data = r["data"]

            for v in data.get("volumes", []):
                vid = v.get("id", "?")
                label = v.get("vol_desc", "") or v.get("vol_path", vid)
                status = v.get("summary_status", v.get("status", "?"))
                sz = v.get("size", {})
                total = int(sz.get("total", 0))
                used = int(sz.get("used", 0))
                free = total - used
                pct = round(used / total * 100) if total else 0
                raid = v.get("device_type", "?").replace("_", " ")
                enc = "  encrypted" if v.get("is_encrypted") else ""
                flag = " !" if status not in ("normal",) else ""
                lines.append(
                    f"  Vol {label} ({vid}): {status}{flag}  {raid}{enc}"
                    f"  {human(free)} free / {human(total)} ({pct}% used)"
                )

            for d in data.get("disks", []):
                did = d.get("id", "?")
                dname = d.get("name", did)
                dstatus = d.get("drive_status_key", d.get("overview_status", "?"))
                smart = d.get("smart_status", "?")
                temp = d.get("temp", "?")
                model = d.get("model", "?")
                flag = " !" if dstatus not in ("normal",) or smart not in ("normal", "not_tested", "-") else ""
                lines.append(
                    f"  {dname} ({did}): {dstatus}{flag}  SMART={smart}  {temp}°C  {model}"
                )
        else:
            code = r.get("error", {}).get("code", "?")
            lines.append(f"  Storage: unavailable (code {code})")

    finally:
        logout(host, port, sid, ctx)

    return "\n".join(lines)


def main():
    print("=== Synology NAS Health Report ===")
    print()
    any_flagged = False
    for device in DEVICES:
        report = check_device(device)
        print(report)
        print()
        if " !" in report or "LOGIN FAILED" in report or "ERROR:" in report or "CRITICAL:" in report:
            any_flagged = True
    sys.exit(1 if any_flagged else 0)


if __name__ == "__main__":
    main()
