#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-crystal-water.py — Query the Crystal Water Monitor (General Galactic
Systems Inc., device model CWM-PNPTG-002) pool/hot tub/swim-spa water
chemistry sensor via its official Crystal Connect REST API.

New smart-home integration (IMPLEMENTATION_PLAN.md S17), not a v1 port —
Crystal Water Monitor didn't exist in the V4/Redo tool set. API contract
confirmed 2026-09-05 against the vendor's own published docs and its
official, MIT-licensed Home Assistant integration source
(github.com/general-galactic/home-assistant-crystal-water-monitor):

  Base URL   https://connect.crystalwatermonitor.app       (production)
             https://dev.connect.crystalwatermonitor.app   (dev/test account)
  Auth       `x-api-key: <key>` header on every request
  Endpoints  GET /connect/v1/vessels            — list pools/spas/hot tubs on the account
             GET /connect/v1/vessels/{vesselId} — full reading/status/action detail for one

This is a clean, documented REST+JSON API — unlike Moen Flo (needs the
aioflo library) or Generac (needs headless-browser Playwright to get past
its WAF), no dedicated venv is required here. stdlib `urllib.request` only,
same request/error shape as hermes_pfsense_common.py's api_get().

Rate limit: the vendor's own live OpenAPI description (embedded in the HA
integration's generated client) allows up to 10 req/sec with a 200 req/day
quota, and recommends polling at most every 15 minutes since the monitor
device itself only uploads new readings every ~20 minutes. (A separate,
older "1 request per 15 minutes per key" figure appears in that same repo's
api-info.md — a design prompt doc, not confirmed current — the live spec
description is the one trusted here.) This tool makes 1 + N requests per
run (list, then one detail call per vessel) — fine for on-demand or
hourly-timer use, but do not put it on a tight polling loop. A 429/503 is
surfaced verbatim, not retried.

Credentials come from Vaultwarden (item "Hermes Crystal Water Monitor",
Fleet-Service collection, field "api_key") via tools/vault-get-secret.sh,
same as every other smart-home tool here — never a local config file or env
var (IMPLEMENTATION_PLAN.md §2b).

**That vault item does not exist yet.** Provisioning it requires requesting
an API key from Crystal customer support
(crystalwatermonitor.com/pages/crystal-connect-api) against a real account
with an active Crystal Water Monitor subscription. Until then this tool has
no credentials to run with — it has been written carefully against the
vendor's published API contract, but has **not been live-verified against a
real device or a real key**. Flag that explicitly rather than claiming
otherwise (LESSONS_LEARNED.md §6, "verify from raw output, never
self-report").

Read-only by design, and not a narrowed-down port like Moen Flo/Generac:
there is no actuation surface on this device to begin with. It doses
nothing itself — the `actions` the API returns are dosing *recommendations*
for a human to act on, not a command channel — so there is nothing gated
being intentionally left out here.

Usage:
  hermes-crystal-water.py                  # Quick status (all vessels)
  hermes-crystal-water.py --detail         # Full report: reading ranges, timestamps, source
  hermes-crystal-water.py --alerts         # Only vessels/readings outside normal status
  hermes-crystal-water.py --json           # Raw JSON dump
  hermes-crystal-water.py --dev            # Hit the dev environment instead of production
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"
VAULT_ITEM = "Hermes Crystal Water Monitor"

BASE_URLS = {
    "production": "https://connect.crystalwatermonitor.app",
    "development": "https://dev.connect.crystalwatermonitor.app",
}

STATUS_LABELS = {
    "really_low": "REALLY LOW", "low": "Low", "ok": "OK",
    "high": "High", "really_high": "REALLY HIGH",
    "invalid": "Invalid", "unknown": "Unknown",
}

WATER_STATUS_LABELS = {
    "blue": "Balanced", "orange": "Needs Attention",
    "red": "NEEDS IMMEDIATE ATTENTION", "gray": "Unknown",
}


def vault_get(field):
    # Same TimeoutExpired accommodation as every other cloud-API tool here (moen-flo 1.1.0,
    # pfsense 1.1.0) — a complete Vaultwarden outage must not crash this uncaught.
    try:
        result = subprocess.run(
            [VAULT_SCRIPT, VAULT_ITEM, field], capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def load_api_key():
    return vault_get("api_key")


def api_get(path, api_key, base_url, timeout=15):
    """Mirrors hermes_pfsense_common.py's api_get() shape: (data, error) tuple,
    error is a human-readable string pulled from the JSON body when present."""
    req = urllib.request.Request(
        f"{base_url}{path}",
        headers={"x-api-key": api_key, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            msg = body.get("message", f"HTTP {e.code}")
        except Exception:
            msg = f"HTTP {e.code}"
        if e.code == 429:
            msg = f"rate limited — {msg}"
        elif e.code == 503:
            msg = f"maintenance — {msg}"
        elif e.code in (401, 403):
            msg = f"auth failed — {msg}"
        elif e.code == 402:
            msg = f"subscription inactive — {msg}"
        return None, msg
    except Exception as e:
        return None, str(e)


def list_vessels(api_key, base_url):
    data, err = api_get("/connect/v1/vessels", api_key, base_url)
    if err:
        return None, err
    return data.get("vessels", []), None


def get_vessel(api_key, base_url, vessel_id):
    return api_get(f"/connect/v1/vessels/{vessel_id}", api_key, base_url)


def print_vessel(vessel, detail=False):
    disc = vessel.get("disc", {}) or {}
    name = disc.get("name") or vessel.get("name", "Unnamed")
    vtype = vessel.get("type", "Unknown")
    color = disc.get("waterStatusColor", "gray")

    print(f"\n{name} ({vtype})")
    print(f"Status: {WATER_STATUS_LABELS.get(color, color)}")
    if disc.get("text"):
        print(f"  {disc['text']}")
    if disc.get("lastUpdatedText"):
        print(f"Last Updated: {disc['lastUpdatedText']}")
    temp_c = disc.get("tempC")
    if temp_c is not None:
        print(f"Water Temperature: {temp_c}C ({temp_c * 9 / 5 + 32:.1f}F)")

    readings = vessel.get("readings", {}) or {}
    for rtype, r in readings.items():
        if not r or "value" not in r:
            continue
        status = STATUS_LABELS.get(r.get("status"), r.get("status", ""))
        print(f"  {r.get('title', rtype)}: {r['value']} {r.get('unitTitle', r.get('unit', ''))} ({status})")
        if detail:
            rng = r.get("range") or {}
            if rng:
                print(f"    Ideal range: {rng.get('low')}-{rng.get('high')}")
            if r.get("date"):
                print(f"    As of: {r['date']} (source: {r.get('source', 'unknown')})")

    actions = vessel.get("actions", []) or []
    if actions:
        print(f"Recommended Actions ({len(actions)}):")
        for a in actions:
            print(f"  - {a.get('title', 'Action')}: {a.get('details', '')}")


def check_status(api_key, base_url, detail=False):
    vessels, err = list_vessels(api_key, base_url)
    if err:
        print(f"ERROR: {err}", file=sys.stderr)
        return None
    if not vessels:
        print("No vessels found on this account.")
        return None

    results = []
    for v in vessels:
        vessel_detail, verr = get_vessel(api_key, base_url, v["vesselId"])
        if verr:
            print(f"\n{v.get('name', 'Unnamed')} ({v.get('type', 'Unknown')})")
            print(f"ERROR: {verr}", file=sys.stderr)
            continue
        print_vessel(vessel_detail, detail=detail)
        results.append(vessel_detail)
    return results


def check_alerts(api_key, base_url):
    vessels, err = list_vessels(api_key, base_url)
    if err:
        print(f"ERROR: {err}", file=sys.stderr)
        return None
    if not vessels:
        print("No vessels found on this account.")
        return None

    found_any = False
    for v in vessels:
        vessel_detail, verr = get_vessel(api_key, base_url, v["vesselId"])
        if verr:
            print(f"{v.get('name', 'Unnamed')}: ERROR: {verr}", file=sys.stderr)
            continue

        disc = vessel_detail.get("disc", {}) or {}
        name = disc.get("name") or vessel_detail.get("name", "Unnamed")
        color = disc.get("waterStatusColor", "gray")
        bad_readings = [
            r for r in (vessel_detail.get("readings", {}) or {}).values()
            if r and r.get("status") not in (None, "ok")
        ]
        actions = vessel_detail.get("actions", []) or []

        if color in ("orange", "red") or bad_readings or actions:
            found_any = True
            print(f"\n{name}: {WATER_STATUS_LABELS.get(color, color)}")
            for r in bad_readings:
                print(f"  - {r.get('title')}: {r.get('value')} "
                      f"({STATUS_LABELS.get(r.get('status'), r.get('status'))})")
            for a in actions:
                print(f"  - Action: {a.get('title')}: {a.get('details', '')}")

    if not found_any:
        print("All vessels balanced — no active alerts.")
    return found_any


def output_json(api_key, base_url):
    vessels, err = list_vessels(api_key, base_url)
    if err:
        print(json.dumps({"error": err}))
        sys.exit(1)
    out = []
    for v in vessels:
        vessel_detail, verr = get_vessel(api_key, base_url, v["vesselId"])
        out.append(vessel_detail if not verr else {"vesselId": v.get("vesselId"), "error": verr})
    print(json.dumps(out, indent=2, default=str))
    return out


def main():
    parser = argparse.ArgumentParser(
        description="Crystal Water Monitor (General Galactic Systems, CWM-PNPTG-002) status (read-only)"
    )
    parser.add_argument("--detail", action="store_true", help="Include reading ranges, timestamps, and source")
    parser.add_argument("--alerts", action="store_true", help="Only vessels/readings outside normal status")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--dev", action="store_true", help="Use the development API environment instead of production")
    args = parser.parse_args()

    api_key = load_api_key()
    if not api_key:
        print(f"ERROR: could not fetch credentials from vault item '{VAULT_ITEM}'", file=sys.stderr)
        sys.exit(1)

    base_url = BASE_URLS["development"] if args.dev else BASE_URLS["production"]

    if args.alerts:
        check_alerts(api_key, base_url)
    elif args.json:
        output_json(api_key, base_url)
    else:
        check_status(api_key, base_url, detail=args.detail)


if __name__ == "__main__":
    main()
