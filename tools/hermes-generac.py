#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — two security-review fixes: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing on a complete Vaultwarden
# outage; check_status() no longer crashes with AttributeError when the API
# returns a non-list error object (e.g. a WAF/session hiccup) instead of the
# expected apparatus list.
"""
hermes-generac.py — Query the Generac Guardian standby generator (Ironwood,
apparatus 602633) via the Mobile Link Cloud API (Phase 19, IMPLEMENTATION_PLAN.md §7).

Ported from v1 (../HermesAgent/skills/generac/scripts/generac_status.py). Two
real changes from v1:

1. Credentials come from Vaultwarden (item "Hermes Generac", Fleet-Service
   collection) via tools/vault-get-secret.sh, never from a local
   ~/.hermes/config/generac.json or env vars (IMPLEMENTATION_PLAN.md §2b).
2. `--test-cycle` (physically starts the generator) is intentionally NOT
   ported. v1 never got it reliably working outside a manual browser session
   (mostly 500s — likely a missing CSRF token/DeviceId, see
   ../HermesAgent/skills/generac/references/api_auth_details.md) and it's a
   physical action requiring its own code-level confirmation gate under
   constraint 5, which no phase in this repo has built a working precedent
   for yet. Don't re-add it without designing that gate first.

There is no local web UI for this device — the WiFi module only talks to
Generac's cloud, so this always goes over the internet, not the LAN.

The API sits behind Imperva WAF + Ecobee OAuth; plain requests/curl get
challenge-cookie 401s, so this drives real headless Chromium via Playwright
to complete the login and let the browser's own fetch() carry the resulting
cookies. Requires the shared venv set up for this tool (Chromium has no ARM64
apt package and Playwright's own browser download is per-install):

    /opt/hermes/venvs/generac/bin/python3 tools/hermes-generac.py [--detail|--alerts|--json]

Usage:
  hermes-generac.py                  # Quick status
  hermes-generac.py --detail         # Full device report
  hermes-generac.py --alerts         # Check for active alerts
  hermes-generac.py --json           # Output as JSON
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Shared browser cache — installed once, read by any identity invoking this tool.
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/hermes/ms-playwright")

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"
VAULT_ITEM = "Hermes Generac"

API_BASE = "https://app.mobilelinkgen.com/api"
APPARATUS_ID = 602633  # Ironwood

# Ecobee auth selectors (from v1's actual page inspection)
EMAIL_INPUT = "#username"
EMAIL_CONTINUE_BUTTON = "button._button-login-id"
PASSWORD_INPUT = "#password"
PASSWORD_SIGNIN_BUTTON = "button._button-login-password"

STATUS_LABELS = {
    0: "Stopped",
    1: "Ready to Run",
    2: "Running",
    3: "Exercising",
    4: "Warning",
    5: "Communication Issue",
    6: "Unknown",
    7: "Online",
    8: "Offline",
}

FUEL_TYPES = {
    0: "Gasoline",
    1: "Propane",
    2: "Dual Fuel",
    3: "Diesel",
}

# Property type codes: 32 Hours of Protection, 70 Battery Voltage,
# 71 Engine Hours, 88 Fuel Type, 95 Exercise Minutes.


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
    email = vault_get("username")
    password = vault_get("password")
    return email, password


def login(page, email, password):
    """Log in via Ecobee OAuth, then trigger the Imperva challenge on the API host.

    Flow: app.mobilelinkgen.com -> auth.ecobee.com -> callback -> dashboard.
    Navigating to the API endpoint after login gets the Imperva cookie bound
    to port 443 so page.evaluate() fetch() calls succeed afterward.
    """
    page.goto("https://app.mobilelinkgen.com", timeout=30000, wait_until="load")
    page.wait_for_selector(EMAIL_INPUT, timeout=15000)

    page.fill(EMAIL_INPUT, email)
    page.click(EMAIL_CONTINUE_BUTTON)

    page.wait_for_selector(PASSWORD_INPUT, timeout=10000)
    page.fill(PASSWORD_INPUT, password)
    page.click(PASSWORD_SIGNIN_BUTTON)

    page.wait_for_selector('h1:has-text("All Products")', timeout=30000)

    page.goto(f"{API_BASE}/v2/Apparatus/list", timeout=10000, wait_until="domcontentloaded")
    page.wait_for_timeout(3000)
    page.goto("https://app.mobilelinkgen.com/dashboard", timeout=15000, wait_until="load")
    page.wait_for_selector('h1:has-text("All Products")', timeout=15000)


def api_fetch(page, method, endpoint):
    url = f"{API_BASE}{endpoint}"
    js_code = f"""
    (async () => {{
        try {{
            const response = await fetch('{url}', {{
                method: '{method.lower()}',
                headers: {{
                    'Accept': 'application/json',
                    'Referer': 'https://app.mobilelinkgen.com/dashboard',
                    'Content-Type': 'application/json'
                }}
            }});
            const text = await response.text();
            return JSON.stringify({{status: response.status, text: text}});
        }} catch(e) {{
            return JSON.stringify({{status: -1, text: e.message}});
        }}
    }})();
    """
    result = page.evaluate(js_code)
    data = json.loads(result)

    if data["status"] == 200:
        return json.loads(data["text"]) if data["text"] else {}
    if data["status"] in (204,):
        return None
    print(f"WARNING: API returned {data['status']}", file=sys.stderr)
    return json.loads(data["text"]) if data["text"] else None


def get_property_value(properties, type_code):
    for prop in properties or []:
        if prop.get("type") == type_code:
            return prop.get("value")
    return None


def get_status_label(status_code):
    return STATUS_LABELS.get(status_code, f"Code {status_code}")


def get_fuel_type(fuel_code):
    return FUEL_TYPES.get(fuel_code, f"Code {fuel_code}")


def format_timestamp(ts):
    if not ts:
        return "Unknown"
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt.strftime("%Y-%m-%d %H:%M")


def check_status(page):
    data = api_fetch(page, "GET", "/v2/Apparatus/list")
    if not data:
        print("No apparatus found (check credentials or network)")
        return None
    if not isinstance(data, list):
        # A non-200/204 response with a JSON *object* body (e.g. a WAF/session
        # hiccup returning {"message": "Unauthorized"}) is truthy, so the
        # `not data` check above doesn't catch it -- found in a security
        # review: this crashed with AttributeError on the very next line
        # ('app.get' on a dict's string keys) instead of reporting a clean
        # error, the same class of bug already fixed once for Wyze.
        print(f"ERROR: unexpected API response (expected a list of apparatuses): {data}")
        return None

    for app in data:
        if app.get("apparatusId") == APPARATUS_ID:
            status = app.get("apparatusStatus")
            alert = app.get("alert") or {}

            print(f"Generator: {app.get('name', 'Ironwood')}")
            print(f"Status: {get_status_label(status)}")
            print(f"Connected: {'Yes' if app.get('isConnected') else 'No'}")
            print(f"Last Seen: {format_timestamp(alert.get('timestamp'))}")

            if alert.get("eCode", 0) > 0:
                print(f"Alert E-Code: {alert['eCode']}")
            if app.get("showWarning"):
                print("Warning: Active")
            if app.get("weather"):
                temp = app.get("weather", {}).get("temperature", {}).get("value")
                print(f"Weather: {temp}F")

            return app
    print(f"Apparatus {APPARATUS_ID} not found in device list")
    return None


def check_detail(page):
    details = api_fetch(page, "GET", f"/v1/Apparatus/details/{APPARATUS_ID}")
    if not details:
        print("No details found (check credentials or network)")
        return None

    props = details.get("properties", [])
    status_label = details.get("statusLabel") or get_status_label(details.get("apparatusStatus"))
    battery = get_property_value(props, 70) or "Unknown"
    fuel_type_raw = get_property_value(props, 88)
    fuel_type = get_fuel_type(int(fuel_type_raw)) if fuel_type_raw not in (None, "") else "Unknown"
    engine_hours = get_property_value(props, 71) or "Unknown"
    exercise_mins = get_property_value(props, 95) or "Unknown"
    protection_hours = get_property_value(props, 32) or "Unknown"

    weather = details.get("weather")
    subscription = details.get("subscription")
    sub_type = "Premium" if subscription and subscription.get("type") == 1 else "Basic"
    sub_status = "Active" if subscription and subscription.get("status") == 1 else "Dunning"
    alert = details.get("alert") or {}

    print("=" * 50)
    print(f"GENERATOR: {details.get('name', 'Ironwood')}")
    print("=" * 50)
    print(f"  Serial: {details.get('serialNumber')}")
    print(f"  Status: {status_label}")
    if details.get("statusText"):
        print(f"  Detail: {details['statusText']}")
    print(f"  Connected: {'Yes' if details.get('isConnected') else 'No'}")
    print(f"  Last Seen: {format_timestamp(details.get('lastSeen'))}")
    print()
    print(f"  Battery: {battery}")
    print(f"  Fuel Type: {fuel_type}")
    print(f"  Engine Hours: {engine_hours}")
    print(f"  Hours of Protection: {protection_hours}")
    print(f"  Exercise Minutes: {exercise_mins}")
    if weather:
        temp = weather.get("temperature", {}).get("value")
        print()
        print(f"  Weather: {temp}F")
    print()
    print(f"  Subscription: {sub_type} ({sub_status})")
    if alert.get("eCode"):
        print(f"  Last Alert: E-Code {alert['eCode']} ({format_timestamp(alert.get('timestamp'))})")
    print()
    return details


def check_alerts(page):
    details = api_fetch(page, "GET", f"/v1/Apparatus/details/{APPARATUS_ID}")
    if not details:
        print("No details found")
        return None

    alert = details.get("alert") or {}
    alarms = details.get("alarms") or []
    warnings = details.get("warnings") or []
    maintenance = details.get("maintenance") or []

    print(f"Generator: {details.get('name', 'Ironwood')}")
    print(f"Current Alarm: {details.get('currentAlarm')}")
    if alert.get("eCode"):
        print(f"  Last E-Code: {alert['eCode']} ({format_timestamp(alert.get('timestamp'))})")

    print(f"  Alarms ({len(alarms)}):" if alarms else "  Alarms: None")
    for a in alarms:
        print(f"    - {a}")
    print(f"  Warnings ({len(warnings)}):" if warnings else "  Warnings: None")
    for w in warnings:
        print(f"    - {w}")
    print(f"  Maintenance ({len(maintenance)}):" if maintenance else "  Maintenance: None")
    for m in maintenance:
        print(f"    - {m}")

    return details


def output_json(page):
    details = api_fetch(page, "GET", f"/v1/Apparatus/details/{APPARATUS_ID}")
    if details:
        print(json.dumps(details, indent=2))
    return details


def main():
    email, password = load_credentials()
    if not email or not password:
        print(f"ERROR: could not fetch credentials from vault item '{VAULT_ITEM}'", file=sys.stderr)
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Generac Guardian generator status monitor (read-only)")
    parser.add_argument("--detail", action="store_true", help="Show full device details")
    parser.add_argument("--alerts", action="store_true", help="Check for active alerts")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-gpu",
                "--no-sandbox",
                "--headless=new",
                "--disable-blink-features=AutomationControlled",
                "--lang=en-US",
            ],
            ignore_default_args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 720},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => false});
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
            Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4]});
            window.chrome = {runtime: {onMessage: {}, onInstalled: {}, sendMessage: {}, updateHost: {}}};
        """)
        page = context.new_page()

        try:
            login(page, email, password)
        except Exception as e:
            print(f"ERROR: login failed: {e}", file=sys.stderr)
            browser.close()
            sys.exit(1)

        if args.json:
            output_json(page)
        elif args.alerts:
            check_alerts(page)
        elif args.detail:
            check_detail(page)
        else:
            check_status(page)

        browser.close()


if __name__ == "__main__":
    main()
