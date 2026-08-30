#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — security-review fix: vault_get()/vault_set() now catch
# subprocess.TimeoutExpired instead of crashing (vault_set() logs a warning
# and continues, since it's a best-effort session-state cache write).
"""
hermes-vivint.py — Status and control for a Vivint home security system, via
Vivint's cloud API (Phase 22, IMPLEMENTATION_PLAN.md §7 — the last item on the
11-22 roadmap).

Ported from v1's four scripts (../HermesAgent/scripts/vivint-{auth,status,
control,daemon}.py), merged into one tool matching this project's one-tool-
per-integration convention. Real changes from v1:

1. Credentials (email/password) and the live session (cookie jar + panel_id)
   come from Vaultwarden (item "Hermes Vivint", Fleet-Service collection) via
   tools/vault-get-secret.sh / tools/vault-set-secret.sh — never the local
   plaintext files v1 used (~/.hermes/config/vivint.json,
   vivint_session.json, vivint_cookies.txt). The cookie jar is written to a
   real file only for the duration of a single curl call, then deleted.
2. `lock`, `unlock`, and `garage open/close/toggle` — real physical-security
   actions — now go through tools/hermes-confirm-gate.sh first: nothing
   happens unless The Boss replies with a matching confirmation code in the
   calling identity's own home room, polled for up to 5 minutes. v1 shipped
   these with no confirmation step of any kind (LESSONS_LEARNED.md §1).
   `light`/`switch`/`therm` commands are NOT gated — same household-
   convenience tier as the Wyze plugs Phase 21 already controls directly.

Requests go through `curl` specifically, not Python's `requests` — carried
over from v1 deliberately: curl's TLS fingerprint passes Vivint's Cloudflare
front door in a way a Python TLS stack might not.

No arm/disarm control — v1 never built this either (vivint-status.py only
*reads* arm state). No camera live-feed/snapshot — v1's Vivint integration
only ever exposed camera metadata (online/offline, RSSI), same ceiling Wyze
hit in Phase 21.

One-time setup (run once, with The Boss present to relay the MFA code Vivint
sends). Two calls, not a live input() prompt — a non-interactive caller can't
hold a terminal session open across a human relaying a code from their phone:

    tools/hermes-vivint.py --setup                    # triggers the MFA challenge
    tools/hermes-vivint.py --setup --mfa-code <code>   # completes it once you have the code

Usage:
  hermes-vivint.py status                          # full system report
  hermes-vivint.py list                             # controllable devices only
  hermes-vivint.py on <name> [brightness]           # light/switch on
  hermes-vivint.py off <name>                       # light/switch off
  hermes-vivint.py dim <name> <0-100>               # set brightness
  hermes-vivint.py therm status|cool <F>|heat <F>|mode <m>|setpoints
  hermes-vivint.py lock <name|all>                  # GATED
  hermes-vivint.py unlock <name|all>                # GATED
  hermes-vivint.py garage status|open|close|toggle [name]   # open/close/toggle GATED
"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_GET = f"{REPO_DIR}/tools/vault-get-secret.sh"
VAULT_SET = f"{REPO_DIR}/tools/vault-set-secret.sh"
CONFIRM_GATE = f"{REPO_DIR}/tools/hermes-confirm-gate.sh"
VAULT_ITEM = "Hermes Vivint"
CLOUD_BASE = "https://www.vivintsky.com/api"

# Same per-node home rooms tools/session-guardian.sh already uses for the one
# other "requires The Boss's real reply" flow in this project.
HOME_ROOMS = {
    "sintra": "!teSvzXTJKwZyuh8QK8:spark",
    "amy": "!KvSV6SCscjEO8QWjuP:spark",
}

CURL_HDRS = [
    "-H", "Accept: application/json, text/plain, */*",
    "-H", "Accept-Language: en-US,en;q=0.9",
    "-H", "Accept-Encoding: gzip, deflate, br",
    "-H", "Origin: https://www.vivintsky.com",
    "-H", "Referer: https://www.vivintsky.com/",
    "-H", "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 VivintMobile/5.47",
]

CONTROLLABLE_LIGHTS = {"multilevel_switch_device", "binary_switch_device"}
CONTROLLABLE_LOCKS = {"door_lock_device"}
CONTROLLABLE_GARAGE = {"garage_door_device"}

ARM_STATES = {0: "Disarmed", 1: "Armed Away", 2: "Armed (Custom)", 3: "Armed Stay"}
GARAGE_STATES = {0: "UNKNOWN", 1: "CLOSED", 2: "CLOSING", 3: "STOPPED", 4: "OPENING", 5: "OPENED"}
DEVICE_TYPES = {
    "wireless_sensor": "sensor",
    "garage_door_device": "garage door",
    "door_lock_device": "lock",
    "thermostat_device": "thermostat",
    "camera_device": "camera",
    "multilevel_switch_device": "light/switch",
    "binary_switch_device": "switch",
    "group_device": "group",
}
SKIP_TYPES = {
    "panel_diagnostics_service", "primary_touch_link_device", "iot_service",
    "scheduler_service", "yofi_device", "sensor_group", "lgit_poe_wifi_bridge_device",
    "mqtt_audio_sync_service", "holiday_theme_service",
}


def get_node():
    node = os.environ.get("VAULT_NODE", "")
    if not node and os.path.exists("/etc/hermes/vault-node-name"):
        node = Path("/etc/hermes/vault-node-name").read_text().strip()
    if not node:
        print("ERROR: set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name", file=sys.stderr)
        sys.exit(1)
    return node


def vault_get(field):
    # timeout=60, not 30: vault-get-secret.sh 1.2.0 retries internally up to 3x on a real
    # transient bw/Vaultwarden failure; a 30s timeout could kill it mid-recovery.
    # Security-review fix: a *complete* outage (both this call and the internal
    # retries exhausting the full 60s) previously raised TimeoutExpired uncaught.
    try:
        result = subprocess.run([VAULT_GET, VAULT_ITEM, field], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def vault_set(field, value):
    # Vivint's API returns panel/panid as a JSON number, not a string, at least
    # sometimes — found live on the first real --setup run. subprocess's stdin
    # needs a real str.
    try:
        subprocess.run([VAULT_SET, VAULT_ITEM, field], input=str(value), capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        print(f"WARNING: timed out caching '{field}' back to Vaultwarden — session state not persisted", file=sys.stderr)


class VivintSession:
    """Holds the cookie jar in a real file only for this process's lifetime."""

    def __init__(self):
        self.panel_id = vault_get("panel_id")
        cookie_content = vault_get("cookie_jar")
        fd, self.cookie_path = tempfile.mkstemp(prefix="vivint-cookies-")
        os.close(fd)
        os.chmod(self.cookie_path, 0o600)
        if cookie_content:
            Path(self.cookie_path).write_text(cookie_content)

    def persist(self):
        content = Path(self.cookie_path).read_text() if os.path.exists(self.cookie_path) else ""
        if content:
            vault_set("cookie_jar", content)
        if self.panel_id:
            vault_set("panel_id", self.panel_id)

    def cleanup(self):
        try:
            os.remove(self.cookie_path)
        except OSError:
            pass


def curl(session: VivintSession, method, path, body=None):
    cmd = ["curl", "-s", "-w", "\n__CODE__%{http_code}",
           "-c", session.cookie_path, "-b", session.cookie_path, "--compressed"]
    if method == "POST":
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "-d", json.dumps(body or {})]
    elif method == "PUT":
        cmd += ["-X", "PUT", "-H", "Content-Type: application/json;charset=utf-8", "-d", json.dumps(body or {})]
    else:
        cmd += ["-X", "GET"]
    cmd += CURL_HDRS + [f"{CLOUD_BASE}{path}"]

    out = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout
    body_text, _, code_str = out.rpartition("\n__CODE__")
    try:
        return json.loads(body_text.strip()), int(code_str.strip())
    except Exception:
        return {"raw": body_text.strip()}, int(code_str.strip()) if code_str.strip().isdigit() else 0


def refresh(session: VivintSession):
    email = vault_get("username")
    password = vault_get("password")
    if not email or not password:
        print(f"ERROR: incomplete credentials in vault item '{VAULT_ITEM}'", file=sys.stderr)
        sys.exit(1)
    print("[*] Re-authenticating ...", file=sys.stderr)
    resp, status = curl(session, "POST", "/login", {"username": email, "password": password})
    if status not in (200, 201):
        if "mfa" in json.dumps(resp).lower():
            print("ERROR: Vivint is asking for a fresh MFA code — this needs a live human. "
                  "Run 'hermes-vivint.py --setup' with The Boss present.", file=sys.stderr)
        else:
            print(f"ERROR: refresh failed (HTTP {status}): {str(resp)[:300]}", file=sys.stderr)
        sys.exit(1)
    session.persist()


def load_system(session: VivintSession):
    if not session.panel_id:
        print("ERROR: no session found — run 'hermes-vivint.py --setup' first.", file=sys.stderr)
        sys.exit(1)
    resp, status = curl(session, "GET", f"/systems/{session.panel_id}")
    if status == 401:
        refresh(session)
        resp, status = curl(session, "GET", f"/systems/{session.panel_id}")
    if status != 200:
        print(f"ERROR: failed to fetch system data (HTTP {status}): {str(resp)[:300]}", file=sys.stderr)
        sys.exit(1)
    return resp.get("system", resp)


def send_command(session: VivintSession, device: dict, payload: dict, endpoint_type: str) -> bool:
    part_id = "1"  # residential panels typically use partition 1, matching v1
    dev_id = device["_id"]
    dev_name = device.get("n", str(dev_id))
    endpoint = f"/{session.panel_id}/{part_id}/{endpoint_type}/{dev_id}"

    resp, status = curl(session, "PUT", endpoint, payload)
    if status in (200, 201, 204):
        return True
    if status == 401:
        refresh(session)
        resp, status = curl(session, "PUT", endpoint, payload)
        return status in (200, 201, 204)

    print(f"  ERROR: {dev_name} -> HTTP {status}: {str(resp)[:200]}")
    return False


# ── data helpers ──────────────────────────────────────────────────────────

def c_to_f(c) -> str:
    try:
        return f"{float(c) * 9 / 5 + 32:.1f}"
    except (TypeError, ValueError):
        return str(c)


def f_to_c(f) -> float:
    return (float(f) - 32) * 5 / 9


def get_devices(sys_data, types):
    par = sys_data.get("par", [{}])[0]
    return [d for d in par.get("d", []) if d.get("t") in types]


def match_devices(devices, name):
    if name.lower() == "all":
        return devices
    needle = name.lower()
    return [d for d in devices if needle in d.get("n", "").lower()]


def state_str(device):
    dtype = device.get("t", "")
    s = device.get("s")
    val = device.get("val", "")
    if dtype in CONTROLLABLE_LIGHTS:
        if s is False:
            return "off"
        if dtype == "multilevel_switch_device" and val != "":
            return f"on @{val}%"
        return "on"
    if dtype == "door_lock_device":
        return "LOCKED" if (s is True or s == 1) else "UNLOCKED"
    if dtype == "garage_door_device":
        return GARAGE_STATES.get(s, f"state={s}")
    return str(s) if s is not None else "N/A"


def device_state_for_report(d):
    s = d.get("s")
    dtype = d.get("t", "")
    if dtype == "door_lock_device":
        return "LOCKED" if (s == 1 or s is True) else "UNLOCKED"
    if dtype == "garage_door_device":
        return GARAGE_STATES.get(s, f"state={s}")
    if dtype == "thermostat_device":
        cur, cool, heat = c_to_f(d.get("val", "?")), c_to_f(d.get("csp", "?")), c_to_f(d.get("hsp", "?"))
        mode = {0: "off", 1: "heat", 2: "cool", 3: "auto", 4: "eco"}.get(d.get("om"), str(d.get("om", "?")))
        return f"current {cur}F  cool@{cool}F  heat@{heat}F  mode={mode}"
    if dtype == "camera_device":
        online = "online" if d.get("ol") else "offline"
        return f"{online}  RSSI={d.get('rssi', '?')}"
    if dtype in ("multilevel_switch_device", "binary_switch_device"):
        if s == 1:
            level = d.get("val", "")
            return f"ON{(' @' + str(level) + '%') if level else ''}"
        return "off"
    return "open/active" if s == 1 else ("closed/inactive" if s == 0 else str(s))


def format_status_report(sys_data):
    lines = []
    arm = sys_data.get("s", "?")
    name = sys_data.get("cn", "Unknown")
    addr = sys_data.get("add", "")
    ts = sys_data.get("ts", "")[:16].replace("T", " ")

    lines.append("=== Vivint Security System Status ===")
    lines.append(f"  Property : {name} - {addr}")
    lines.append(f"  Arm State: {ARM_STATES.get(arm, str(arm))}")
    lines.append(f"  Timestamp: {ts} UTC")
    lines.append("")

    par = sys_data.get("par", [{}])[0]
    devices = par.get("d", [])
    alerts = []
    cats = {"lock": [], "garage door": [], "sensor": [], "light/switch": [],
            "thermostat": [], "camera": [], "other": []}

    for d in devices:
        dtype = d.get("t", "")
        if dtype in SKIP_TYPES:
            continue
        name_d = d.get("n", f"Device {d.get('_id')}")
        cat = DEVICE_TYPES.get(dtype, "other")
        state = device_state_for_report(d)
        low_bat = " [LOW BAT]" if d.get("lb") else ""
        bypass = " [BYPASSED]" if d.get("byp") else ""
        cats.setdefault(cat, []).append(f"    {name_d:<38} {state}{low_bat}{bypass}")

        if dtype == "door_lock_device" and d.get("s") == 0:
            alerts.append(f"UNLOCKED: {name_d}")
        if dtype == "garage_door_device" and d.get("s") in (4, 5):
            alerts.append(f"GARAGE OPEN: {name_d}")
        if dtype == "wireless_sensor" and d.get("s") == 1 and not d.get("byp"):
            alerts.append(f"OPEN: {name_d}")
        if d.get("lb"):
            alerts.append(f"LOW BATTERY: {name_d}")

    if alerts:
        lines.append("  *** ALERTS ***")
        lines.extend(f"    ! {a}" for a in alerts)
        lines.append("")

    for cat in ["lock", "garage door", "sensor", "thermostat", "camera", "light/switch", "other"]:
        items = cats.get(cat, [])
        if items:
            lines.append(f"  {cat.upper()} ({len(items)}):")
            lines.extend(items)
            lines.append("")

    return "\n".join(lines)


# ── gate ──────────────────────────────────────────────────────────────────

def require_confirmation(description: str) -> bool:
    node = get_node()
    room = HOME_ROOMS.get(node)
    if not room:
        print(f"ERROR: no home room mapped for node '{node}' — cannot request confirmation.", file=sys.stderr)
        return False
    print(f"[*] Requesting confirmation in {room}: {description}", file=sys.stderr)
    result = subprocess.run([CONFIRM_GATE, room, description], timeout=330)
    return result.returncode == 0


# ── commands ──────────────────────────────────────────────────────────────

def cmd_status(session, sys_data):
    print(format_status_report(sys_data))


def cmd_list(session, sys_data):
    lights = get_devices(sys_data, CONTROLLABLE_LIGHTS)
    locks = get_devices(sys_data, CONTROLLABLE_LOCKS)
    garages = get_devices(sys_data, CONTROLLABLE_GARAGE)
    thermos = get_devices(sys_data, {"thermostat_device"})

    for label, devs in (("LIGHTS/SWITCHES", lights), ("LOCKS", locks),
                         ("GARAGE DOORS", garages), ("THERMOSTATS", thermos)):
        if not devs:
            continue
        print(f"{label}:")
        for d in devs:
            print(f"  {d['_id']:<6} {d.get('t', ''):<28} {d.get('n', ''):<30} {state_str(d)}")
        print()


def cmd_on(session, sys_data, name, brightness=100):
    targets = match_devices(get_devices(sys_data, CONTROLLABLE_LIGHTS), name)
    if not targets:
        print(f"No device matching '{name}'. Run 'list' to see available devices.")
        sys.exit(1)
    for d in targets:
        before = state_str(d)
        ok = send_command(session, d, {"_id": d["_id"], "val": brightness}, "switches")
        desc = f"on @{brightness}%" if d.get("t") == "multilevel_switch_device" else "on"
        print(f"  {'OK' if ok else 'FAIL'} {d.get('n')}: {before} -> {desc if ok else 'FAILED'}")


def cmd_off(session, sys_data, name):
    targets = match_devices(get_devices(sys_data, CONTROLLABLE_LIGHTS), name)
    if not targets:
        print(f"No device matching '{name}'. Run 'list' to see available devices.")
        sys.exit(1)
    for d in targets:
        before = state_str(d)
        ok = send_command(session, d, {"_id": d["_id"], "val": 0}, "switches")
        print(f"  {'OK' if ok else 'FAIL'} {d.get('n')}: {before} -> {'off' if ok else 'FAILED'}")


def cmd_lock(session, sys_data, name, unlock=False):
    locks = get_devices(sys_data, CONTROLLABLE_LOCKS)
    targets = match_devices(locks, name)
    if not targets:
        print(f"No lock matching '{name}'. Run 'list' to see available locks.")
        sys.exit(1)

    action = "UNLOCK" if unlock else "lock"
    names = ", ".join(d.get("n", "") for d in targets)
    if not require_confirmation(f"{action.upper()} request for: {names}"):
        print(f"Not confirmed — no action taken on: {names}")
        sys.exit(1)

    for d in targets:
        before = state_str(d)
        ok = send_command(session, d, {"_id": d["_id"], "s": 0 if unlock else 1}, "locks")
        after = ("UNLOCKED" if unlock else "locked") if ok else "FAILED"
        print(f"  {'OK' if ok else 'FAIL'} {d.get('n')}: {before} -> {after}")


def cmd_garage(session, sys_data, action, name):
    garages = get_devices(sys_data, CONTROLLABLE_GARAGE)
    if not garages:
        print("No garage door devices found.")
        return

    if action == "status":
        for d in garages:
            print(f"{d.get('n', 'Garage')}: {state_str(d)}")
        return

    targets = garages if (not name or name.lower() == "all") else match_devices(garages, name)
    if not targets:
        print(f"No garage door matching '{name}'.")
        return

    names = ", ".join(d.get("n", "") for d in targets)
    if not require_confirmation(f"Garage door {action.upper()} request for: {names}"):
        print(f"Not confirmed — no action taken on: {names}")
        sys.exit(1)

    for d in targets:
        before = state_str(d)
        current = d.get("s", 1)
        if action == "open":
            payload, after_pending = {"_id": d["_id"], "s": 4}, "opening..."
        elif action == "close":
            payload, after_pending = {"_id": d["_id"], "s": 2}, "closing..."
        elif action == "toggle":
            if current == 1:
                payload, after_pending = {"_id": d["_id"], "s": 4}, "opening..."
            elif current == 5:
                payload, after_pending = {"_id": d["_id"], "s": 2}, "closing..."
            else:
                print(f"  FAIL {d.get('n')}: door is {GARAGE_STATES.get(current, current)} "
                      f"— use 'open' or 'close' explicitly instead of toggle")
                continue
        else:
            print(f"  FAIL unknown action: {action}")
            continue
        ok = send_command(session, d, payload, "door")
        print(f"  {'OK' if ok else 'FAIL'} {d.get('n')}: {before} -> {after_pending if ok else 'FAILED'}")


def cmd_therm(session, sys_data, subcmd, args):
    thermos = get_devices(sys_data, {"thermostat_device"})
    if not thermos:
        print("No thermostat found.")
        sys.exit(1)
    thermo = thermos[0]

    if subcmd == "status":
        print(f"Thermostat: {thermo.get('n', 'Thermostat')}")
        print(f"  Current : {c_to_f(thermo.get('val', '?'))}F")
        print(f"  Cool @  : {c_to_f(thermo.get('csp', '?'))}F")
        print(f"  Heat @  : {c_to_f(thermo.get('hsp', '?'))}F")
        mode = {0: "off", 1: "heat", 2: "cool", 3: "auto"}.get(thermo.get("om", 0), "?")
        print(f"  Mode    : {mode}")
    elif subcmd == "cool":
        csp_f = float(args[0])
        ok = send_command(session, thermo, {"_id": thermo["_id"], "currentAutoMode": 2, "csp": f_to_c(csp_f)}, "thermostats")
        print(f"  {'OK' if ok else 'FAIL'} cool setpoint -> {csp_f}F")
    elif subcmd == "heat":
        hsp_f = float(args[0])
        ok = send_command(session, thermo, {"_id": thermo["_id"], "currentAutoMode": 2, "hsp": f_to_c(hsp_f)}, "thermostats")
        print(f"  {'OK' if ok else 'FAIL'} heat setpoint -> {hsp_f}F")
    elif subcmd == "mode":
        mode_map = {"off": 0, "heat": 1, "cool": 2, "heat-cool": 3}
        mode_val = mode_map.get(args[0].lower())
        if mode_val is None:
            print(f"Invalid mode. Options: {list(mode_map.keys())}")
            sys.exit(1)
        ok = send_command(session, thermo, {"_id": thermo["_id"], "om": mode_val}, "thermostats")
        print(f"  {'OK' if ok else 'FAIL'} mode -> {args[0]}")
    elif subcmd == "setpoints":
        print(f"Scene setpoints for {thermo.get('n', 'Thermostat')}:")
        print(f"  Home     : {c_to_f(thermo.get('hsp', '?'))}F / {c_to_f(thermo.get('csp', '?'))}F")
        print(f"  Away     : {c_to_f(thermo.get('ashp', '?'))}F / {c_to_f(thermo.get('acsp', '?'))}F")
        print(f"  Sleep    : {c_to_f(thermo.get('shsp', '?'))}F / {c_to_f(thermo.get('scsp', '?'))}F")
        print(f"  Vacation : {c_to_f(thermo.get('vshp', '?'))}F / {c_to_f(thermo.get('vcsp', '?'))}F")


# ── one-time interactive setup ───────────────────────────────────────────

def run_setup(mfa_code=None):
    """First-time login. Must be run with The Boss present to relay Vivint's
    MFA code — this tool cannot solve a live MFA prompt on its own, by design
    (constraint 5's whole point).

    Two-phase, not interactive input(): a non-interactive caller (e.g. an
    agent's own terminal tool, which can't hold a live stdin prompt open
    across a human relaying a code from their phone) runs this once with no
    code — if Vivint challenges for MFA, the pre-MFA cookie jar is persisted
    to a temporary vault field and the caller is told to re-run with
    --mfa-code once The Boss has it. Second call resumes that exact session
    rather than starting a fresh login (Vivint ties the MFA challenge to the
    session that triggered it)."""
    email = vault_get("username")
    password = vault_get("password")
    if not email or not password:
        print(f"ERROR: add email/password to the '{VAULT_ITEM}' Vaultwarden item first.", file=sys.stderr)
        sys.exit(1)

    session = VivintSession()

    if mfa_code:
        pending = vault_get("setup_cookie_jar_pending")
        if not pending:
            print("ERROR: no pending setup session found — run '--setup' (no --mfa-code) first.", file=sys.stderr)
            sys.exit(1)
        Path(session.cookie_path).write_text(pending)
        print("[*] Resuming pending session, submitting MFA code ...")
        resp, status = curl(session, "POST", "/mfa-login", {"username": email, "password": password, "mfa": mfa_code})
        if status not in (200, 201):
            print(f"ERROR: MFA failed ({status}): {resp}")
            sys.exit(1)
        user_data = resp.get("u", {})
        vault_set("setup_cookie_jar_pending", "consumed")  # vault-set-secret.sh rejects an empty value
    else:
        print(f"[*] Logging in to Vivint cloud as {email} ...")
        resp, status = curl(session, "POST", "/login", {"username": email, "password": password})
        if status not in (200, 201):
            print(f"ERROR: login failed (HTTP {status}): {json.dumps(resp, indent=2)[:600]}")
            sys.exit(1)

        user_data = resp.get("u", {})
        if not user_data and ("mfa" in json.dumps(resp).lower()):
            pending_content = Path(session.cookie_path).read_text() if os.path.exists(session.cookie_path) else ""
            vault_set("setup_cookie_jar_pending", pending_content)
            print("[!] MFA required — Vivint just sent a code to your phone/email.")
            print("    Once you have it, run: hermes-vivint.py --setup --mfa-code <code>")
            session.cleanup()
            return

    if not user_data:
        print(f"ERROR: no user data in response. Raw:\n{json.dumps(resp, indent=2)[:800]}")
        sys.exit(1)

    systems = user_data.get("system", [])
    panel_id = systems[0].get("panid", "") if systems else ""
    if not panel_id:
        print("ERROR: no panel_id in login response.")
        sys.exit(1)

    session.panel_id = panel_id
    session.persist()
    print(f"[+] Session saved to Vaultwarden item '{VAULT_ITEM}' (panel_id={panel_id}).")

    print("[*] Verifying cloud API access ...")
    sys_resp, code = curl(session, "GET", f"/systems/{panel_id}")
    if code == 200:
        sys_data = sys_resp.get("system", {})
        devices = sys_data.get("par", [{}])[0].get("d", [])
        print(f"[+] Cloud API OK - system '{sys_data.get('cn')}', {len(devices)} devices.")
    else:
        print(f"[-] Cloud API returned {code} - session saved, try 'hermes-vivint.py status'.")

    session.cleanup()


def main():
    if "--setup" in sys.argv:
        mfa_code = None
        if "--mfa-code" in sys.argv:
            idx = sys.argv.index("--mfa-code")
            if idx + 1 >= len(sys.argv):
                print("ERROR: --mfa-code requires a value", file=sys.stderr)
                sys.exit(1)
            mfa_code = sys.argv[idx + 1]
        run_setup(mfa_code=mfa_code)
        return

    import argparse
    parser = argparse.ArgumentParser(description="Vivint home security status and control")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("status")
    sub.add_parser("list")
    p_on = sub.add_parser("on")
    p_on.add_argument("name")
    p_on.add_argument("brightness", nargs="?", default="100")
    p_off = sub.add_parser("off")
    p_off.add_argument("name")
    p_dim = sub.add_parser("dim")
    p_dim.add_argument("name")
    p_dim.add_argument("brightness")
    p_therm = sub.add_parser("therm")
    p_therm.add_argument("subcmd", choices=["status", "cool", "heat", "setpoints", "mode"])
    p_therm.add_argument("therm_args", nargs="*")
    p_lock = sub.add_parser("lock")
    p_lock.add_argument("name")
    p_unlock = sub.add_parser("unlock")
    p_unlock.add_argument("name")
    p_garage = sub.add_parser("garage")
    p_garage.add_argument("action", choices=["status", "open", "close", "toggle"])
    p_garage.add_argument("name", nargs="?", default="")

    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        sys.exit(0)

    session = VivintSession()
    try:
        sys_data = load_system(session)

        if args.cmd == "status":
            cmd_status(session, sys_data)
        elif args.cmd == "list":
            cmd_list(session, sys_data)
        elif args.cmd == "on":
            cmd_on(session, sys_data, args.name, int(args.brightness))
        elif args.cmd == "off":
            cmd_off(session, sys_data, args.name)
        elif args.cmd == "dim":
            cmd_on(session, sys_data, args.name, int(args.brightness))
        elif args.cmd == "therm":
            cmd_therm(session, sys_data, args.subcmd, args.therm_args)
        elif args.cmd == "lock":
            cmd_lock(session, sys_data, args.name, unlock=False)
        elif args.cmd == "unlock":
            cmd_lock(session, sys_data, args.name, unlock=True)
        elif args.cmd == "garage":
            cmd_garage(session, sys_data, args.action, args.name)
    finally:
        session.cleanup()


if __name__ == "__main__":
    main()
