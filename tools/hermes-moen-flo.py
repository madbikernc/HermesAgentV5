#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — security-review fix: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing on a complete Vaultwarden
# outage.
"""
hermes-moen-flo.py — Query a Moen Flo smart water shutoff valve / leak-detector
puck via the Flo Cloud API (Phase 20, IMPLEMENTATION_PLAN.md §7).

Ported from v1 (../HermesAgent/skills/moen-flo/scripts/flo_status.py), using
the `aioflo` library (asyncio-only; legacy "Flo by Moen" auth against
api.meetflo.com — this account is confirmed still on that app, not migrated
to the newer OAuth2-based "Moen Smart Water Network"). There is no local/LAN
API — everything goes through Flo's cloud, same shape as Generac.

Two real changes from v1:

1. Credentials come from Vaultwarden (item "Hermes Moen Flo", Fleet-Service
   collection) via tools/vault-get-secret.sh, never from a local
   ~/.hermes/config/moen-flo.json or env vars (IMPLEMENTATION_PLAN.md §2b).
2. `--health-test` (briefly pressurizes the line) and `--open-valve` /
   `--close-valve` (closing cuts water to the whole house) are intentionally
   NOT ported. These are physical actions requiring their own code-level
   confirmation gate under constraint 5, which no phase in this repo has
   built a working precedent for yet. Don't re-add them without designing
   that gate first.

Auto-discovers every location and device on the account — nothing device-
specific is hardcoded. A shutoff-valve device reports valve state, flow
(GPM), pressure (PSI), and water temperature; a leak-detector puck
(deviceType "puck_oem") reports battery, humidity, and leak state instead.

Requires the shared venv set up for this tool (aioflo needs a PEP
668-exempt venv on this Ubuntu host, same reasoning as Generac's Playwright
venv, though this one has no browser dependency):

    /opt/hermes/venvs/moen-flo/bin/python3 tools/hermes-moen-flo.py [--detail|--alerts|--json]

Usage:
  hermes-moen-flo.py                  # Quick status (all devices)
  hermes-moen-flo.py --detail         # Full report + today's water consumption
  hermes-moen-flo.py --alerts         # Active alarms
  hermes-moen-flo.py --json           # Raw JSON dump
"""

import asyncio
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"
VAULT_ITEM = "Hermes Moen Flo"


def vault_get(field):
    # timeout=60, not 30: vault-get-secret.sh 1.2.0 retries internally up to 3x on a real
    # transient bw/Vaultwarden failure; a 30s timeout could kill it mid-recovery.
    # Security-review fix: a *complete* outage (both this call and the internal
    # retries exhausting the full 60s) previously raised TimeoutExpired uncaught.
    try:
        result = subprocess.run(
            [VAULT_SCRIPT, VAULT_ITEM, field], capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def load_credentials():
    return vault_get("username"), vault_get("password")


async def discover_devices(api):
    """Return a list of (location_info, device_summary) across the account."""
    user_info = await api.user.get_info(include_location_info=True)
    devices = []
    for loc in user_info.get("locations", []):
        location_info = await api.location.get_info(loc["id"], include_device_info=True)
        for dev in location_info.get("devices", []):
            devices.append((location_info, dev))
    return devices


def print_device(location_info, device_info):
    device_type = device_info.get("deviceType")
    is_puck = device_type == "puck_oem"

    print(f"\nDevice: {device_info.get('nickname', 'Unnamed')} ({device_type or 'Unknown'})")
    print(f"Location: {location_info.get('nickname', location_info.get('address', 'Unknown'))}")
    print(f"Connected: {'Yes' if device_info.get('isConnected') else 'No'}")
    print(f"Last Heard From: {device_info.get('lastHeardFromTime', 'Unknown')}")

    telemetry = device_info.get("telemetry", {}).get("current", {})

    if is_puck:
        leak = device_info.get("fwProperties", {}).get("telemetry_water")
        print(f"Leak Detected: {'YES' if leak else 'No'}")
        if "humidity" in telemetry:
            print(f"Humidity: {telemetry.get('humidity')}%")
    else:
        valve = device_info.get("valve", {})
        print(f"Valve: {valve.get('lastKnown', 'Unknown')} (target: {valve.get('target', 'Unknown')})")
        mode = device_info.get("systemMode", {})
        print(f"System Mode: {mode.get('lastKnown', 'Unknown')}")
        if "gpm" in telemetry:
            print(f"Flow Rate: {telemetry.get('gpm')} GPM")
        if "psi" in telemetry:
            print(f"Pressure: {telemetry.get('psi')} PSI")

    if "tempF" in telemetry:
        print(f"Temperature: {telemetry.get('tempF')}F")

    battery = device_info.get("battery", {}).get("level")
    if battery is not None:
        print(f"Battery: {battery}%")

    fw = device_info.get("fwVersion")
    if fw:
        print(f"Firmware: {fw}")

    notifications = device_info.get("notifications", {}).get("pending", {})
    critical = notifications.get("criticalCount", 0)
    warning = notifications.get("warningCount", 0)
    info = notifications.get("infoCount", 0)
    if critical or warning or info:
        print(f"Pending Notifications: {critical} critical, {warning} warning, {info} info")


async def check_status(api, detail=False):
    devices = await discover_devices(api)
    if not devices:
        print("No devices found on this account.")
        return None

    for location_info, device_summary in devices:
        device_info = await api.device.get_info(device_summary["id"])
        print_device(location_info, device_info)

        if detail and device_info.get("deviceType") != "puck_oem":
            now = datetime.now(timezone.utc)
            start = datetime(now.year, now.month, now.day, 0, 0)
            end = start + timedelta(hours=23, minutes=59, seconds=59)
            consumption = await api.water.get_consumption_info(location_info["id"], start, end)
            total = consumption.get("aggregations", {}).get("sumTotalGallonsConsumed")
            if total is not None:
                print(f"Today's Consumption: {round(total, 1)} gal")

    return devices


async def check_alerts(api):
    alarms = await api.alarm.get_all()
    items = alarms.get("items", []) if isinstance(alarms, dict) else (alarms or [])

    if not items:
        print("No alarms found.")
        return alarms

    print(f"Alarms ({len(items)}):")
    for a in items:
        print(f"  - {a}")

    return alarms


async def output_json(api):
    devices = await discover_devices(api)
    out = []
    for location_info, device_summary in devices:
        device_info = await api.device.get_info(device_summary["id"])
        out.append({"location": location_info, "device": device_info})
    print(json.dumps(out, indent=2, default=str))
    return out


async def main_async(args):
    from aioflo import async_get_api

    email, password = load_credentials()
    if not email or not password:
        print(f"ERROR: could not fetch credentials from vault item '{VAULT_ITEM}'", file=sys.stderr)
        sys.exit(1)

    try:
        api = await async_get_api(email, password)
    except Exception as e:
        print(f"ERROR: login failed: {e}", file=sys.stderr)
        sys.exit(1)

    if args.alerts:
        await check_alerts(api)
    elif args.json:
        await output_json(api)
    else:
        await check_status(api, detail=args.detail)


def main():
    parser = argparse.ArgumentParser(description="Moen Flo water shutoff/leak-detector monitor (read-only)")
    parser.add_argument("--detail", action="store_true", help="Include today's water consumption")
    parser.add_argument("--alerts", action="store_true", help="Check active alarms")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
