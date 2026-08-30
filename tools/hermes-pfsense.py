#!/usr/bin/env python3
# Version: 1.1.0
"""
hermes-pfsense.py — pfSense firewall/gateway status monitor (Phase 23,
IMPLEMENTATION_PLAN.md §7). Queries the fleet's own gateway/firewall at
10.129.1.1 via pfSense's REST API v2 package (pfSense-pkg-RESTAPI) and
reports system status, WAN/LAN interface health, and gateway status —
plus, on request, DHCP leases and recent firewall log entries.

Deliberately status/monitoring only. Unlike Phase 22 (Vivint), this gets
no gated actuation path either, even though hermes-confirm-gate.sh already
exists: pfSense is the fleet's own network boundary, and a bad rule/alias
change or a reboot here can cut off remote access to every other node —
a materially worse failure mode than a stuck lock or an unstarted
generator. See IMPLEMENTATION_PLAN.md §7 Phase 23 for the full scope
decision.

Endpoints below were confirmed against the pfrest/pfSense-pkg-RESTAPI
source on GitHub (Endpoints/Status*.inc `$this->url` assignments), not
guessed from the rendered Swagger UI, which returns no path information
without a live box behind it to render against:
  GET /api/v2/status/system
  GET /api/v2/status/interfaces
  GET /api/v2/status/gateways
  GET /api/v2/status/dhcp_server/leases
  GET /api/v2/status/logs/firewall
Auth: `x-api-key` header (RESTAPI\\Auth\\KeyAuth — confirmed from source,
matches v1's own `X-API-Key` usage). Response envelope confirmed from
RESTAPI\\Core\\Response::to_representation(): {"code", "status",
"response_id", "message", "data"}.

Verified live 2026-08-09 from the Spark (`pmoney`, `VAULT_NODE=sintra`,
default fallthrough to the shared `Fleet-Service`-collection vault item —
same pattern Phases 19-22 already rely on): all three default sections
returned real data (168-day uptime, real WAN/LAN/WIFI interface states,
three real gateways), `--leases` returned 19 real DHCP leases, and
`--logs` returned real `filterlog` entries. One real bug found and fixed
on this first live run: `/status/logs/firewall` returns
`{"id": int, "text": "<raw filterlog CSV line>"}` per entry, not
pre-parsed fields — the log section was printing the wrapper dict instead
of the actual log line; fixed to print `entry["text"]`.

The `WIFI` interface (`rtwn0_wlan0`) reporting `down` was flagged as an
open question on first verification — The Boss confirmed 2026-08-09 it's
intentionally disabled, not a fault. `hermes_pfsense_common.py`'s
EXPECTED_DOWN_INTERFACES now excludes it from the "!" flag and from the
exit-code signal, so this tool stops crying wolf about it daily.

Shared HTTP/auth plumbing now lives in `hermes_pfsense_common.py` — split
out once `hermes-pfsense-report.py` needed the same client, same
reasoning `hermes_canary_common.py` was split for the canary scripts.

Ported conceptually from v1's `skills/pfsense-network/` — that skill used
root-over-SSH with password auth and a plaintext `pfsense_credentials.json`
on the NFS share. Both are real anti-patterns under this project's own
rules and are not carried forward: the REST API's own scoped key auth
replaces general shell access (constraint 2), and a Vaultwarden item
(`Hermes pfSense`, custom field `api_key`) replaces the plaintext file
(§2b).

Usage:
  hermes-pfsense.py                  # System + interfaces + gateways
  hermes-pfsense.py --leases         # + DHCP leases
  hermes-pfsense.py --logs [N]       # + last N firewall log entries (default 20)
  hermes-pfsense.py --json           # Raw JSON dump of every section queried
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_pfsense_common import (  # noqa: E402
    HOST, EXPECTED_DOWN_INTERFACES, get_api_key, make_context, api_get,
)


def fetch_all(api_key, ctx, want_leases, want_logs, log_count):
    sections, errors = {}, []

    for key, path in (("system", "/status/system"), ("interfaces", "/status/interfaces"),
                       ("gateways", "/status/gateways")):
        data, err = api_get(path, api_key, ctx)
        if err:
            errors.append(f"{key}: {err}")
        else:
            sections[key] = data.get("data", {} if key == "system" else [])

    if want_leases:
        data, err = api_get("/status/dhcp_server/leases", api_key, ctx)
        if err:
            errors.append(f"leases: {err}")
        else:
            sections["leases"] = data.get("data", [])

    if want_logs:
        data, err = api_get("/status/logs/firewall", api_key, ctx, params={"limit": log_count})
        if err:
            errors.append(f"logs: {err}")
        else:
            sections["logs"] = data.get("data", [])

    return sections, errors


def _gateway_name(gw):
    name = gw.get("name")
    # ForeignModelField — representation shape not confirmed live; handle both
    # a resolved string and a nested object defensively rather than assuming.
    if isinstance(name, dict):
        return name.get("name", "?")
    return name or "?"


def print_report(sections, errors, want_leases, want_logs):
    print(f"=== pfSense Status ({HOST}) ===\n")
    any_flagged = bool(errors)

    sys_info = sections.get("system")
    if sys_info:
        print(f"Platform : {sys_info.get('platform', '?')}")
        print(f"Uptime   : {sys_info.get('uptime', '?')}")
        print(f"CPU      : {sys_info.get('cpu_model', '?')} ({sys_info.get('cpu_count', '?')} cores)")
        print()

    interfaces = sections.get("interfaces")
    if interfaces is not None:
        print("--- Interfaces ---")
        for iface in interfaces:
            hwif = iface.get("hwif", "?")
            name = iface.get("descr") or iface.get("name") or hwif
            status = iface.get("status", "?")
            ip = iface.get("ipaddr", "?")
            flagged = status not in ("up", "active") and hwif not in EXPECTED_DOWN_INTERFACES
            expected_note = "  (intentionally disabled)" if hwif in EXPECTED_DOWN_INTERFACES else ""
            any_flagged = any_flagged or flagged
            print(f"  {name} ({hwif}): {status}{'  !' if flagged else expected_note}  {ip}")
        print()

    gateways = sections.get("gateways")
    if gateways is not None:
        print("--- Gateways ---")
        for gw in gateways:
            status = gw.get("status", "?")
            flagged = status not in ("online", "none")
            any_flagged = any_flagged or flagged
            print(f"  {_gateway_name(gw)}: {status}{'  !' if flagged else ''}  "
                  f"delay={gw.get('delay', '?')}ms  loss={gw.get('loss', '?')}%")
        print()

    if want_leases and sections.get("leases") is not None:
        leases = sections["leases"]
        print(f"--- DHCP Leases ({len(leases)}) ---")
        for lease in leases:
            print(f"  {lease.get('ip', '?'):15}  {lease.get('mac', '?')}  "
                  f"{lease.get('hostname') or '(no hostname)'}  {lease.get('online_status', '?')}")
        print()

    if want_logs and sections.get("logs") is not None:
        logs = sections["logs"]
        print(f"--- Recent Firewall Log ({len(logs)}) ---")
        for entry in logs:
            # Each entry is {"id": int, "text": "<raw filterlog CSV line>"} — print the
            # real log line, not the wrapper dict (found live 2026-08-09: the API returns
            # raw filterlog text, not the pre-parsed fields the field list implied).
            print(f"  {entry.get('text', entry) if isinstance(entry, dict) else entry}")
        print()

    if errors:
        print("--- Errors ---")
        for e in errors:
            print(f"  ERROR: {e}")

    return any_flagged


def main():
    parser = argparse.ArgumentParser(description="pfSense firewall status monitor (read-only)")
    parser.add_argument("--leases", action="store_true", help="Include DHCP leases")
    parser.add_argument("--logs", nargs="?", const=20, type=int, metavar="N",
                         help="Include last N firewall log entries (default 20)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of a report")
    args = parser.parse_args()

    api_key = get_api_key()
    if not api_key:
        print("ERROR: could not fetch 'api_key' from vault item 'Hermes pfSense'", file=sys.stderr)
        sys.exit(1)

    ctx = make_context()
    want_logs = args.logs is not None
    sections, errors = fetch_all(api_key, ctx, args.leases, want_logs, args.logs or 20)

    if args.json:
        print(json.dumps({"sections": sections, "errors": errors}, indent=2))
        sys.exit(1 if errors else 0)

    flagged = print_report(sections, errors, args.leases, want_logs)
    sys.exit(1 if flagged else 0)


if __name__ == "__main__":
    main()
