#!/usr/bin/env python3
# Version: 1.0.1
#
# 1.0.1 — real bug found live on the very first `status` run: `cmd_status()` keyed the registry
# lookup by role in a plain dict comprehension, which keeps only the last row seen for a role
# with multiple files. Reported omni as 1.6GB (the mmproj alone) instead of ~25.5GB. Fixed to
# group and sum per role.
#
# hermes-forge-residency — the residency controller for Forge (spark-2), HermesAgentV5 S9. Watch
# (spark) is static residency, no controller needed (target §9's own framing — nano/super/coder/
# dispatch/guard/embed are all fixed placements). Forge is the swappable, throughput-tolerant
# node: muse and omni are always-resident until something needs the node's full unified memory —
# fine-tuning or abliteration work (V5 target state §4.2's own note: "takes the node when
# active").
#
# Deliberately a CLI tool a human or a future job runs, not a resident daemon — draining a node
# for a fine-tune run is a deliberate, occasional, human-in-the-loop action (per V4 S17's own
# finding that spark-2 root-level work is human-attended), not something to automate a trigger
# for without a real fine-tuning pipeline behind it yet.
#
# "Which checkpoint is current per role" is answered by querying hermes-memory's model registry
# (S9's other half, `/models`) — this tool doesn't duplicate that data, it reads it.
#
# Usage:
#   hermes-forge-residency.py status    # what's resident now, against budget, per the registry
#   hermes-forge-residency.py drain     # stop the swappable services, free the node
#   hermes-forge-residency.py restore   # start them again
#
# Config:
#   MEMORY_URL/MEMORY_TOKEN   required for `status` (reads the model registry)
#   FORGE_SWAPPABLE_UNITS     default "llama-muse.service,llama-omni.service"
#   FORGE_RAM_BUDGET_GB       default 105 — usable ceiling, same figure used throughout
#                             IMPLEMENTATION_PLAN.md for this node's real headroom

import json
import os
import subprocess
import sys
import urllib.request

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
SWAPPABLE_UNITS = os.environ.get("FORGE_SWAPPABLE_UNITS", "llama-muse.service,llama-omni.service").split(",")
RAM_BUDGET_GB = int(os.environ.get("FORGE_RAM_BUDGET_GB", "105"))


def log(msg):
    print(f"[hermes-forge-residency] {msg}")


def systemctl(*args):
    return subprocess.run(["sudo", "systemctl", *args], capture_output=True, text=True)


def unit_active(unit):
    return systemctl("is-active", "--quiet", unit).returncode == 0


def registry_models():
    if not MEMORY_TOKEN:
        log("WARNING: MEMORY_TOKEN not set — registry lookup skipped, showing process state only")
        return []
    req = urllib.request.Request(f"{MEMORY_URL}/models?node=spark-2")
    req.add_header("Authorization", f"Bearer {MEMORY_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode()).get("models", [])
    except Exception as exc:
        log(f"WARNING: registry lookup failed: {exc}")
        return []


def free_gb():
    with open("/proc/meminfo") as f:
        info = {line.split(":")[0]: line.split()[1] for line in f if ":" in line}
    return int(info.get("MemAvailable", "0")) / 1024 / 1024


def cmd_status():
    # A role can back multiple files (omni's GGUF + its mmproj, one registry row each) -- group
    # and sum sizes per role rather than keying a dict by role, which would silently keep only
    # the last row seen and undercount. Real bug found live testing this against omni: reported
    # 1.6GB (the mmproj alone) instead of the correct ~25.5GB.
    by_role = {}
    for m in registry_models():
        if m.get("status") == "active":
            by_role.setdefault(m["role"], []).append(m)

    resident_gb = 0.0
    for unit in SWAPPABLE_UNITS:
        active = unit_active(unit)
        role = unit.replace("llama-", "").replace(".service", "")
        rows = by_role.get(role, [])
        size_gb = sum(r["size_bytes"] for r in rows if r.get("size_bytes")) / 1e9 if rows else None
        if active and size_gb:
            resident_gb += size_gb
        state = "resident" if active else "drained"
        checkpoint = rows[0]["hf_id"] if rows else "(not in registry)"
        size_str = f"{size_gb:.1f}GB" if size_gb else "?"
        log(f"{role:8} {state:9} {size_str:8} {checkpoint}")
    avail = free_gb()
    log(f"~{resident_gb:.0f}GB resident (from registry sizes) / {avail:.0f}GB free / "
        f"{RAM_BUDGET_GB}GB usable budget")


def cmd_drain():
    log("draining Forge — stopping swappable units for fine-tuning/abliteration work")
    for unit in SWAPPABLE_UNITS:
        if unit_active(unit):
            result = systemctl("stop", unit)
            if result.returncode != 0:
                log(f"FAILED to stop {unit}: {result.stderr.strip()}")
                sys.exit(1)
            log(f"stopped {unit}")
        else:
            log(f"{unit} already inactive")
    log("drained — node is free")


def cmd_restore():
    log("restoring Forge — starting swappable units")
    for unit in SWAPPABLE_UNITS:
        if not unit_active(unit):
            result = systemctl("start", unit)
            if result.returncode != 0:
                log(f"FAILED to start {unit}: {result.stderr.strip()}")
                sys.exit(1)
            log(f"started {unit}")
        else:
            log(f"{unit} already active")
    log("restored")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "status":
        cmd_status()
    elif cmd == "drain":
        cmd_drain()
    elif cmd == "restore":
        cmd_restore()
    else:
        sys.exit("usage: hermes-forge-residency.py {status|drain|restore}")


if __name__ == "__main__":
    main()
