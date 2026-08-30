#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — two security-review fixes: vault_get()/vault_set() now catch
# subprocess.TimeoutExpired instead of crashing; with_reauth()'s re-login
# path is now guarded by a cross-process file lock with double-checked
# re-read of the cached token, closing a race where two concurrent callers
# hitting an expired token could both trigger a fresh Wyze login at once —
# exactly the repeated-login rate-limit scenario the token cache exists to
# avoid. get_client() removed (fully absorbed into with_reauth()).
"""
hermes-wyze.py — Query Wyze smart-home devices (plugs, bulbs, switches, cameras,
locks/safe, watch, vacuum, thermostat, motion/entry sensors) via the Wyze Cloud
API (Phase 21, IMPLEMENTATION_PLAN.md §7).

Ported from v1 (../HermesAgent/skills/wyze/scripts/wyze.py), using the `wyze-sdk`
library. Two real changes from v1:

1. Credentials come from Vaultwarden (item "Hermes Wyze", Fleet-Service
   collection) instead of a local ~/.hermes/config/wyze.json
   (IMPLEMENTATION_PLAN.md §2b). Unlike Generac/Moen Flo, this doesn't
   re-authenticate on every run: Wyze rate-limits repeated logins (v1's own
   docs flag this), so the access token itself is cached as a custom field
   on the same vault item via the new tools/vault-set-secret.sh, and reused
   until a real API call proves it's stale — never written to a local file.
2. Every actuation command is intentionally NOT ported: plug/switch/bulb
   on-off, bulb brightness/color-temp/color/away-mode, vacuum dock/sweep,
   thermostat set, and lock/unlock the safe. These are physical actions
   requiring their own code-level confirmation gate under constraint 5,
   which no phase in this repo has built a working precedent for yet.
   Don't re-add them without designing that gate first. Only `list` and
   every *-status/info/history command are ported.

Requires the shared venv set up for this tool (wyze-sdk needs a PEP
668-exempt venv on this Ubuntu host):

    /opt/hermes/venvs/wyze/bin/python3 tools/hermes-wyze.py <command> [args...]

Real, live-diagnosed TLS gap (2026-08-07): api.wyzecam.com's server sends its leaf +
intermediate (DigiCert TLS RSA SHA256 2020 CA1) but the chain's root (DigiCert Global
Root CA, valid until 2031) isn't present in this host's `ca-certificates` bundle —
confirmed with `openssl s_client -showcerts` plus `openssl verify`, and reproduced with
plain `curl` (independent of Python/requests, so it's a real system trust-store gap, not
an env-var-not-taking-effect bug). Worked around with a supplemental CA bundle scoped to
this tool rather than editing the system-wide store (which `update-ca-certificates` would
silently revert, and which would affect every other service on the host for a Wyze-only
quirk): `/opt/hermes/venvs/wyze/ca-bundle.pem` = the system bundle + the fetched root,
built once via:
    curl -sS -o /tmp/digicert_global_root_ca.der http://cacerts.digicert.com/DigiCertGlobalRootCA.crt
    openssl x509 -inform der -in /tmp/digicert_global_root_ca.der -out /tmp/digicert_global_root_ca.pem
    cat /etc/ssl/certs/ca-certificates.crt /tmp/digicert_global_root_ca.pem > /opt/hermes/venvs/wyze/ca-bundle.pem
If this venv is ever recreated, redo this step before expecting the tool to work — it's a
real, external gap in the host's trust store, not something a fresh venv install fixes.

Usage:
  hermes-wyze.py list [--type TYPE]
  hermes-wyze.py plug status --device NAME
  hermes-wyze.py switch status --device NAME
  hermes-wyze.py bulb status --device NAME
  hermes-wyze.py lock --device NAME --history [--hours N]
  hermes-wyze.py vacuum status --device NAME
  hermes-wyze.py sensor-motion --device NAME
  hermes-wyze.py sensor-entry --device NAME
  hermes-wyze.py thermostat status --device NAME
  hermes-wyze.py camera --device NAME
  hermes-wyze.py watch --device NAME
  hermes-wyze.py safe --device NAME
"""

import argparse
import datetime
import fcntl
import os
import subprocess
import sys
from pathlib import Path

_CA_BUNDLE = "/opt/hermes/venvs/wyze/ca-bundle.pem"
_SYSTEM_CA = "/etc/ssl/certs/ca-certificates.crt"
os.environ.setdefault("REQUESTS_CA_BUNDLE", _CA_BUNDLE if os.path.exists(_CA_BUNDLE) else _SYSTEM_CA)
os.environ.setdefault("SSL_CERT_FILE", _CA_BUNDLE if os.path.exists(_CA_BUNDLE) else _SYSTEM_CA)

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_GET = f"{REPO_DIR}/tools/vault-get-secret.sh"
VAULT_SET = f"{REPO_DIR}/tools/vault-set-secret.sh"
VAULT_ITEM = "Hermes Wyze"
# Cross-process lock guarding the re-login path in with_reauth() below --
# Wyze rate-limits repeated logins, so two callers racing an expired cached
# token must not both trigger a fresh login concurrently.
REAUTH_LOCK_PATH = Path.home() / ".hermes" / "wyze-reauth.lock"


def vault_get(field):
    # timeout=60, not 30: vault-get-secret.sh 1.2.0 retries internally up to 3x on a real
    # transient bw/Vaultwarden failure; a 30s timeout could kill it mid-recovery.
    # Security-review fix: a *complete* outage (both this call and the internal
    # retries exhausting the full 60s) previously raised TimeoutExpired uncaught.
    try:
        result = subprocess.run(
            [VAULT_GET, VAULT_ITEM, field], capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def vault_set(field, value):
    try:
        subprocess.run(
            [VAULT_SET, VAULT_ITEM, field], input=value, capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        print(f"WARNING: timed out caching '{field}' back to Vaultwarden — not persisted", file=sys.stderr)


def fresh_login():
    """Real login against Wyze, using the account credentials + developer API
    key/key ID from Vaultwarden. Returns a new access token and caches it."""
    from wyze_sdk import Client

    email = vault_get("username")
    password = vault_get("password")
    api_key = vault_get("api_key")
    key_id = vault_get("key_id")
    totp_key = vault_get("totp_key")
    # A "no 2FA" field is sometimes left as a literal placeholder rather than
    # truly empty (seen live: the string "null") — treat those as absent too.
    if totp_key.strip().lower() in ("", "null", "none", "n/a", "na"):
        totp_key = ""

    if not all([email, password, api_key, key_id]):
        print(f"ERROR: incomplete credentials in vault item '{VAULT_ITEM}' "
              "(need username, password, api_key, key_id)", file=sys.stderr)
        sys.exit(1)

    kwargs = dict(email=email, password=password, key_id=key_id, api_key=api_key)
    if totp_key:
        kwargs["totp_key"] = totp_key

    response = Client().login(**kwargs)
    access_token = response.get("access_token") or response.get("data", {}).get("access_token")
    if not access_token:
        print(f"ERROR: login succeeded but no access_token in response: {response}", file=sys.stderr)
        sys.exit(1)

    vault_set("access_token", access_token)
    return access_token


def with_reauth(fn):
    """Run fn(client); on a Wyze auth error, log in fresh once and retry.

    The re-login path is guarded by a cross-process file lock (security
    review finding): two invocations racing an expired cached token would
    otherwise both hit WyzeApiError and both call fresh_login() concurrently
    -- exactly the repeated-login-triggers-a-rate-limit scenario the token
    cache exists to avoid, plus a race between their two vault_set() writes
    over which token ends up cached. Double-checked after acquiring the lock:
    re-read the cached token once more in case a different process already
    refreshed it while this one waited, so only the actual first caller pays
    for a real login.
    """
    from wyze_sdk import Client
    from wyze_sdk.errors import WyzeApiError

    used_token = vault_get("access_token")
    client = Client(token=used_token) if used_token else Client(token=fresh_login())
    try:
        return fn(client)
    except WyzeApiError:
        REAUTH_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(REAUTH_LOCK_PATH, "w") as lockf:
            fcntl.flock(lockf, fcntl.LOCK_EX)
            try:
                fresh_token = vault_get("access_token")
                if fresh_token and fresh_token != used_token:
                    client = Client(token=fresh_token)
                else:
                    client = Client(token=fresh_login())
            finally:
                fcntl.flock(lockf, fcntl.LOCK_UN)
        return fn(client)


def find_devices(client, name, prefixes):
    devices = client.devices_list()
    matches = []
    for d in devices:
        if name.lower() in d.nickname.lower():
            model = d.product.model
            if any(model.startswith(p) for p in prefixes):
                matches.append(d)
    return matches


def get_single_device(client, name, prefixes):
    matches = find_devices(client, name, prefixes)
    if not matches:
        print(f"No device matching '{name}'. Available:")
        for d in client.devices_list():
            s = "ONLINE" if d.is_online else "OFFLINE"
            print(f"  {d.nickname} ({d.product.model}) [{s}]")
        sys.exit(1)
    if len(matches) > 1:
        print(f"Multiple devices match '{name}' — using first:")
        for m in matches:
            print(f"  {m.nickname} ({m.product.model})")
    return matches[0]


def cmd_list(args):
    def run(client):
        devices = client.devices_list()
        type_map = {
            "plug": ["WLPPO"], "bulb": ["WLPA"], "switch": ["WLPP1"],
            "camera": ["HL_", "GW_", "ME_", "WYZE_", "AN_"],
            "lightstrip": ["HL_LSL"], "lock": ["YD"], "watch": ["RY"],
        }
        if args.type and args.type in type_map:
            prefixes = type_map[args.type]
            devices = [d for d in devices if any(d.product.model.startswith(p) for p in prefixes)]
        if not devices:
            print(f"No devices for type: {args.type or 'all'}")
            return
        online = sum(1 for d in devices if d.is_online)
        print(f"Found {len(devices)} device(s) — {online} online, {len(devices) - online} offline\n")
        for d in devices:
            s = "ONLINE" if d.is_online else "OFFLINE"
            print(f"  {d.nickname:35s} [{s}]  ({d.product.model})")
    with_reauth(run)


def _info_or_fallback(dev, info):
    """wyze-sdk's per-category .info() calls return None for some device/model
    combinations — v1's own docs flagged this for cameras.info(), and live
    testing here (2026-08-07) found it's not limited to cameras: a real WLPP1
    switch on this account returned None from switches.info() too. Rather than
    crash, fall back to the basic online/offline status devices_list() already
    gave us."""
    if info is None:
        print(f"{dev.nickname}: Info unavailable (SDK returned nothing for this device) "
              f"| Online={dev.is_online}")
        return True
    return False


def cmd_plug_status(args):
    def run(client):
        dev = get_single_device(client, args.device, ["WLPPO"])
        info = client.plugs.info(device_mac=dev.mac)
        if _info_or_fallback(dev, info):
            return
        print(f"{dev.nickname}: Power={'ON' if info.is_on else 'OFF'} | Online={info.is_online}")
    with_reauth(run)


def cmd_switch_status(args):
    def run(client):
        dev = get_single_device(client, args.device, ["WLPP1"])
        info = client.switches.info(device_mac=dev.mac)
        if _info_or_fallback(dev, info):
            return
        print(f"{dev.nickname}: Power={'ON' if info.is_on else 'OFF'}")
    with_reauth(run)


def cmd_bulb_status(args):
    def run(client):
        dev = get_single_device(client, args.device, ["WLPA"])
        info = client.bulbs.info(device_mac=dev.mac)
        if _info_or_fallback(dev, info):
            return
        print(f"{dev.nickname}: Power={'ON' if info.is_on else 'OFF'} | Online={info.is_online}")
    with_reauth(run)


def cmd_lock_history(args):
    def run(client):
        dev = get_single_device(client, args.device, ["YD"])
        hours = int(args.hours) if args.hours else 24
        since = datetime.datetime.now() - datetime.timedelta(hours=hours)
        print(f"Lock history — {dev.nickname} (last {hours}h):\n")
        try:
            records = client.locks.get_records(device_mac=dev.mac, since=since)
        except TypeError:
            # Live testing found this raises internally (family_record: null
            # in the API response, which the SDK iterates without a None
            # check) for at least the YD.GS1 safe — not a real "no records"
            # answer, but not something we can distinguish from one either.
            print("  No records returned (or this device type isn't fully "
                  "supported by the SDK's lock-records call).")
            return
        if not records:
            print("  No recent records.")
            return
        for r in records[:20]:
            print(f"  {r.time}: {r.action} ({r.source})")
    with_reauth(run)


def cmd_vacuum_status(args):
    def run(client):
        dev = get_single_device(client, args.device, ["JA"])
        info = client.vacuums.info(device_mac=dev.mac)
        if _info_or_fallback(dev, info):
            return
        print(f"{dev.nickname}: Status={info.mode} | Battery={info.battery}%")
    with_reauth(run)


def cmd_sensor_motion(args):
    def run(client):
        dev = get_single_device(client, args.device, ["MS"])
        info = client.motion_sensors.info(device_mac=dev.mac)
        if _info_or_fallback(dev, info):
            return
        print(f"{dev.nickname}: Motion={info.motion_detected} | Battery={info.battery}%")
    with_reauth(run)


def cmd_sensor_entry(args):
    def run(client):
        dev = get_single_device(client, args.device, ["DS", "ES"])
        info = client.entry_sensors.info(device_mac=dev.mac)
        if _info_or_fallback(dev, info):
            return
        print(f"{dev.nickname}: Open={info.opened} | Battery={info.battery}%")
    with_reauth(run)


def cmd_thermostat_status(args):
    def run(client):
        dev = get_single_device(client, args.device, ["HSC"])
        info = client.thermostats.info(device_mac=dev.mac)
        if _info_or_fallback(dev, info):
            return
        print(f"{dev.nickname}: Current={info.indoor_temperature}F | "
              f"Target={info.target_temperature}F | Mode={info.hvac_mode}")
    with_reauth(run)


def cmd_camera(args):
    def run(client):
        dev = get_single_device(client, args.device, ["HL_", "GW_", "ME_", "WYZE_", "AN_"])
        print(f"{dev.nickname}:")
        print(f"  Model: {dev.product.model}")
        print(f"  MAC: {dev.mac}")
        print(f"  Online: {dev.is_online}")
        print("  Note: Camera status from device list only — live feed data needs a different API.")
    with_reauth(run)


def cmd_watch(args):
    def run(client):
        dev = get_single_device(client, args.device, ["RY"])
        print(f"{dev.nickname}: Model={dev.product.model} | Online={dev.is_online}")
    with_reauth(run)


def cmd_safe(args):
    def run(client):
        dev = get_single_device(client, args.device, ["YD"])
        print(f"{dev.nickname}: Model={dev.product.model} | Online={dev.is_online}")
    with_reauth(run)


def build_parser():
    p = argparse.ArgumentParser(description="Wyze device monitor (read-only)")
    sub = p.add_subparsers(dest="cmd")

    sp = sub.add_parser("list")
    sp.add_argument("--type", choices=["plug", "bulb", "switch", "camera", "lightstrip", "lock", "watch"])

    for name in ("plug", "switch", "bulb", "vacuum", "thermostat"):
        sp = sub.add_parser(name)
        sp.add_argument("action", choices=["status"])
        sp.add_argument("--device", required=True)

    sp = sub.add_parser("lock")
    sp.add_argument("--device", required=True)
    sp.add_argument("--history", action="store_true", required=True,
                     help="Only history is supported — lock/unlock is not ported (see module docstring)")
    sp.add_argument("--hours", help="Hours back for history")

    for name in ("sensor-motion", "sensor-entry", "camera", "watch", "safe"):
        sp = sub.add_parser(name)
        sp.add_argument("--device", required=True)

    return p


def main():
    p = build_parser()
    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        sys.exit(1)

    dispatch = {
        "list": cmd_list,
        "plug": cmd_plug_status,
        "switch": cmd_switch_status,
        "bulb": cmd_bulb_status,
        "vacuum": cmd_vacuum_status,
        "thermostat": cmd_thermostat_status,
        "lock": cmd_lock_history,
        "sensor-motion": cmd_sensor_motion,
        "sensor-entry": cmd_sensor_entry,
        "camera": cmd_camera,
        "watch": cmd_watch,
        "safe": cmd_safe,
    }
    dispatch[args.cmd](args)


if __name__ == "__main__":
    main()
