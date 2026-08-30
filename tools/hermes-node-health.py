#!/usr/bin/env python3
# Version: 1.2.0
#
# 1.2.0 (2026-08-30) — DEFAULT_CONFIG's "services" no longer defaults to expecting
# hermes-gateway. Root cause of hermes-fleet-health.service's daily failure, traced from
# the email report down through this script: hermes-gateway was retired fleet-wide at S8,
# but nothing that expected it to be running was ever updated to know that, so the "Agent
# router (hermes-gateway): not active" check (section_services()) has been reporting a
# permanent, correctly-predicted critical every single day since. Sintra's and Amy's own
# ~/.hermes/config/node-health.json (not in git, fixed directly on each host) had the same
# problem for hermes-gateway/hermes-gateway-amy plus the four now-dormant S8 daemons
# (hermes-fabrication-guard, hermes-session-cap-guard-*, hermes-session-guardian-*) and
# three retired timers (hermes-wiki-checkin-{amy,sintra}.timer, hermes-wiki-sync.timer) —
# all removed from each identity's expected services/timers, since none of them are
# supposed to be running post-S8. This default only ever mattered as a fallback for a node
# with no config file of its own; every node currently in the fleet already has one.
#
# 1.1.2 (2026-08-26) — real bug found live: the "Managed cron jobs" check reported "warn"
# whenever zero cron lines matched cfg["cron_patterns"], without distinguishing "patterns
# were configured and none matched" (a real gap) from "cron_patterns is deliberately empty
# for this node" (nothing to check, vacuously fine). Amy's node-health.json sets
# cron_patterns: [] on purpose; her real crontab has an unrelated entry that just doesn't
# match this fleet's naming convention. Fixed: an empty patterns list now reports "ok".
"""
hermes-node-health.py — Generic node health status check (Phase 13,
IMPLEMENTATION_PLAN.md §7: "Generic and config-driven, working on both
nodes unmodified").

Ported from v1 (HermesAgent/skills/ops/hermes-node-health/scripts/), which
was already built exactly to that spec — nothing here is hardcoded to one
machine or one identity. What to check (which services/ports/directories/
network targets) comes from an optional per-HERMES_HOME config file;
everything else is auto-detected, and every individual check degrades to
"unknown" instead of crashing or fabricating a result. A standalone tool
here, not a skill wrapping it, per this project's own §2a preference for
model-agnostic tools over framework-specific skills.

Runs per HERMES_HOME, not per physical node — on the Spark that means once
as Sintra (her own ~/.hermes) and once as Amy (hers), since they're
separate identities sharing one host, same pattern as Phase 11/12. On
HomeD13, which has no persona or Hermes Agent install of its own since
migration Stage 3, HERMES_HOME points at the render-worker's own directory
instead, with a config describing that node's actual services (ComfyUI,
hermes-render-worker) rather than a Hermes gateway.

Implements the report defined in HERMES_AGENT_HEALTH_STATUS_REQUIREMENTS.md
(carried forward from v1 unmodified — the requirements themselves didn't
change):
  1. Node Identity and Context      5. Data and Storage
  2. Service Availability           6. Security Posture
  3. Compute Health                 7. Task and Pipeline Health
  4. Network Health                 8. Observability and Telemetry
                                     9. Summary and Severity

Usage:
  python3 hermes-node-health.py                         # markdown report to stdout
  python3 hermes-node-health.py --format json
  python3 hermes-node-health.py --format yaml
  python3 hermes-node-health.py --quick                 # skip slow network/security checks
  python3 hermes-node-health.py --section compute network
  python3 hermes-node-health.py --output /tmp/report.json --format json

Config (optional): $HERMES_HOME/config/node-health.json
State (written each run): $HERMES_HOME/state/node-health/last-report.json

1.1.0 (2026-08-09, direct request: "recheck the node health check, make sure
it is comprehensive... if anything flags as an error, make sure the report
it mails is very clear on what test failed"):
  - build_summary()'s `issues` list — the thing hermes-fleet-health.py's
    email actually shows per identity — was dropping each check's `detail`
    field and its severity, leaving only "{name}: {value}". For checks like
    "Failed units" or "Config file permissions", the useful diagnostic (which
    units, which files) lives in `detail`, not `value` — the email showed a
    count with no way to act on it. Now prefixed with [CRITICAL]/[WARN] and
    includes detail inline.
  - Added `expected_timers` config: a raw timer count can't say which timer
    went missing/disabled if one did, and is a different concern from
    "Failed units" catching a timer's own triggered service failing (a timer
    can stay active(waiting) forever while what it triggers fails every run —
    real, found live: hermes-fleet-health.service was failing daily while
    hermes-fleet-health.timer stayed active throughout).

1.1.1 (2026-08-12, direct request: make "Time since last health check" more
resilient to run-to-run timer drift — every fleet report was showing a
1-minute-over-24h WARN on all three identities, night after night, since
each identity's own check also runs roughly daily): threshold raised from
1440 min (24h) to 2160 min (36h), so ordinary drift no longer trips it and
it now only warns when a check has genuinely been skipped for the better
part of a day.
"""
import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ── paths ────────────────────────────────────────────────────────────────────

HERMES_HOME  = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
CONFIG_PATH  = HERMES_HOME / "config" / "node-health.json"
STATE_DIR    = HERMES_HOME / "state" / "node-health"
STATE_PATH   = STATE_DIR / "last-report.json"
LOG_PATH     = HERMES_HOME / "logs" / "node-health.log"

SECTION_NAMES = [
    "identity", "services", "compute", "network",
    "storage", "security", "tasks", "observability",
]

DEFAULT_CONFIG = {
    "node_name": None,
    "agent_name": None,
    "agent_role": None,
    "operational_environment": None,
    "host_hardware_override": None,
    "services": [],
    "model_endpoints": [
        {"name": "Ollama",       "port": 11434},
        {"name": "vLLM",         "port": 8000},
        {"name": "vLLM-alt",     "port": 8080},
        {"name": "llama.cpp-1",  "port": 8082},
        {"name": "llama.cpp-2",  "port": 8083},
        {"name": "llama.cpp-3",  "port": 8084},
        {"name": "llama.cpp-4",  "port": 8085},
    ],
    "network_targets": ["1.1.1.1", "8.8.8.8"],
    "external_services": [
        {"name": "Hugging Face Hub", "url": "https://huggingface.co"},
    ],
    "data_dirs": ["~/.hermes"],
    "artifact_dirs": [],
    "cron_patterns": ["hermes", "canary", "podcast"],
    "allowed_listen_ports": None,
    "queue_probe_command": None,
    "expected_timers": [],
}


# ── generic helpers ────────────────────────────────────────────────────────

def run(cmd, timeout=8, shell=False):
    """Run a command (argv list preferred over shell=True) and return (stdout, returncode)."""
    try:
        r = subprocess.run(cmd, shell=shell, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip(), r.returncode
    except FileNotFoundError:
        return "", 127
    except subprocess.TimeoutExpired:
        return "", -1
    except Exception:
        return "", -1


def which(name):
    return shutil.which(name) is not None


def human_bytes(n):
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} EB"


def check(name, status, value=None, detail=None):
    """status: ok | warn | critical | unknown"""
    return {"name": name, "status": status, "value": value, "detail": detail}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            user_cfg = json.loads(CONFIG_PATH.read_text())
            for k, v in user_cfg.items():
                cfg[k] = v
        except Exception as e:
            print(f"WARNING: could not parse {CONFIG_PATH}: {e}", file=sys.stderr)
    return cfg


IS_LINUX = platform.system() == "Linux"
IS_MAC   = platform.system() == "Darwin"
IS_WIN   = platform.system() == "Windows"


# ── 1. Node Identity and Context ──────────────────────────────────────────

def section_identity(cfg):
    checks = []
    hostname = socket.gethostname()

    node_name = cfg.get("node_name") or hostname
    checks.append(check("Node name", "ok", node_name))

    hw = cfg.get("host_hardware_override")
    if not hw:
        hw = _detect_hardware_model()
    checks.append(check("Host hardware", "ok" if hw else "unknown", hw or "not detected"))

    agent_name = cfg.get("agent_name")
    checks.append(check("Agent name", "ok" if agent_name else "unknown", agent_name or "not configured"))

    agent_role = cfg.get("agent_role")
    checks.append(check("Agent role", "ok" if agent_role else "unknown", agent_role or "not configured"))

    version = _detect_hermes_version()
    checks.append(check("Agent/framework version", "ok" if version else "unknown", version or "unknown"))

    env = cfg.get("operational_environment") or "not configured"
    checks.append(check("Operational environment", "ok" if cfg.get("operational_environment") else "unknown", env))

    return {
        "checks": checks,
        "hostname": hostname,
        "node_name": node_name,
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _detect_hardware_model():
    if IS_LINUX:
        for path in ("/sys/class/dmi/id/product_name", "/sys/firmware/devicetree/base/model"):
            try:
                val = Path(path).read_text().strip().strip("\x00")
                if val:
                    return val
            except Exception:
                continue
        out, rc = run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"])
        if rc == 0 and out:
            return out.splitlines()[0].strip()
    elif IS_MAC:
        out, rc = run(["sysctl", "-n", "hw.model"])
        if rc == 0 and out:
            return out
    elif IS_WIN:
        out, rc = run(["wmic", "computersystem", "get", "model"])
        if rc == 0 and out:
            lines = [l.strip() for l in out.splitlines() if l.strip() and "Model" not in l]
            if lines:
                return lines[0]
    return None


def _detect_hermes_version():
    # Prefer an installed `hermes` CLI's own version string.
    out, rc = run(["hermes", "--version"])
    if rc == 0 and out:
        return out.splitlines()[0].strip()
    # Fall back to this repo's README "**Version:** x.y.z" if HERMES_HOME points at a checkout.
    for candidate in (HERMES_HOME / "README.md", HERMES_HOME / "HermesAgent" / "README.md"):
        try:
            m = re.search(r"\*\*Version:\*\*\s*([0-9][\w.\-]*)", candidate.read_text())
            if m:
                return m.group(1)
        except Exception:
            continue
    return None


# ── 2. Service Availability ───────────────────────────────────────────────

def _systemctl_status(name, scope):
    if not IS_LINUX or not which("systemctl"):
        return "unsupported"
    args = ["systemctl"] + (["--user"] if scope == "user" else []) + ["is-active", name]
    out, rc = run(args)
    return out or "not-found"


def section_services(cfg, quick=False):
    checks = []
    services_seen = []

    for svc in cfg.get("services", []):
        name, scope = svc["name"], svc.get("scope", "system")
        status = _systemctl_status(name, scope)
        services_seen.append({"name": name, "scope": scope, "status": status})
        if status == "unsupported":
            checks.append(check(f"Service: {name} ({scope})", "unknown", status, "systemctl not available on this platform"))
        else:
            checks.append(check(f"Service: {name} ({scope})", "ok" if status == "active" else "critical", status))

    # Plugin runtime / agent router: treat hermes-gateway itself as the router process.
    router_up = any(s["status"] == "active" for s in services_seen if s["name"] == "hermes-gateway")
    if any(s["name"] == "hermes-gateway" for s in services_seen):
        checks.append(check("Agent router (hermes-gateway)", "ok" if router_up else "critical",
                             "active" if router_up else "not active"))
    else:
        checks.append(check("Agent router (hermes-gateway)", "unknown", "not configured to check"))

    # Scheduled task runners: cron + systemd timers.
    cron_out, cron_rc = run(["crontab", "-l"])
    if cron_rc == 0:
        n_jobs = len([l for l in cron_out.splitlines() if l.strip() and not l.strip().startswith("#")])
        checks.append(check("Cron jobs (user crontab)", "ok", f"{n_jobs} job(s)"))
    else:
        checks.append(check("Cron jobs (user crontab)", "unknown", "no crontab or crontab not available"))

    if IS_LINUX and which("systemctl"):
        timers_out, _ = run(["systemctl", "list-timers", "--all", "--no-pager"])
        n_timers = max(0, len(timers_out.splitlines()) - 2) if timers_out else 0
        checks.append(check("Systemd timers (total)", "ok", f"{n_timers} timer(s)",
                             "informational count — see individual checks below for named timers"))
        # A raw count alone can't tell you WHICH timer went missing, disabled, or failed to load
        # if one did — the count could stay identical while a specific expected timer silently
        # disappears and an unrelated one takes its place. Checking each by name catches that;
        # it's deliberately a different concern from "Failed units" below, which catches the
        # *service* a timer triggers failing when it runs — a timer can be perfectly
        # active(waiting) while the service underneath it keeps failing every run, and this
        # check alone wouldn't see that (found real 2026-08-09: hermes-fleet-health.service was
        # failing daily while hermes-fleet-health.timer stayed active throughout).
        for timer in cfg.get("expected_timers", []):
            status = _systemctl_status(timer, "system")
            checks.append(check(f"Timer: {timer}", "ok" if status == "active" else "critical", status))
    else:
        checks.append(check("Systemd timers", "unknown", "systemctl not available"))

    # Model serving endpoints (OpenAI-compatible /v1/models probe).
    loaded, available_not_loaded = [], []
    for ep in cfg.get("model_endpoints", []):
        port, label = ep["port"], ep["name"]
        if quick:
            checks.append(check(f"Model endpoint: {label}:{port}", "unknown", "skipped (--quick)"))
            continue
        out, rc = run(["curl", "-s", "--max-time", "2", f"http://localhost:{port}/v1/models"])
        if rc == 0 and out and '"data"' in out:
            try:
                data = json.loads(out)
                ids = [m.get("id", "?") for m in data.get("data", [])]
                loaded.extend([{"endpoint": label, "port": port, "model": mid} for mid in ids])
                checks.append(check(f"Model endpoint: {label}:{port}", "ok", f"{len(ids)} model(s) loaded: {', '.join(ids) or '(none)'}"))
            except Exception:
                checks.append(check(f"Model endpoint: {label}:{port}", "warn", "responded but response was not parseable"))
        else:
            available_not_loaded.append({"endpoint": label, "port": port})
            checks.append(check(f"Model endpoint: {label}:{port}", "unknown", "not reachable (not started, or not installed on this node)"))

    return {
        "checks": checks,
        "services": services_seen,
        "loaded_models": loaded,
        "endpoints_not_reachable": available_not_loaded,
    }


# ── 3. Compute Health ─────────────────────────────────────────────────────

def section_compute(cfg):
    checks = []
    data = {}

    # CPU load
    if IS_LINUX:
        try:
            load1, load5, load15 = Path("/proc/loadavg").read_text().split()[:3]
            ncpu = os.cpu_count() or 1
            pct1 = float(load1) / ncpu * 100
            checks.append(check("CPU load (1/5/15m)", "warn" if pct1 > 90 else "ok",
                                 f"{load1} / {load5} / {load15} (ncpu={ncpu})"))
            data["load"] = {"1m": load1, "5m": load5, "15m": load15, "ncpu": ncpu}
        except Exception as e:
            checks.append(check("CPU load", "unknown", None, str(e)))
    else:
        try:
            load1, _, _ = os.getloadavg()
            checks.append(check("CPU load (1m)", "ok", f"{load1:.2f}"))
        except (AttributeError, OSError):
            checks.append(check("CPU load", "unknown", "not available on this platform"))

    # Memory + swap
    if IS_LINUX:
        mem_out, _ = run(["free", "-b"])
        mem_line = next((l for l in mem_out.splitlines() if l.startswith("Mem:")), "")
        swap_line = next((l for l in mem_out.splitlines() if l.startswith("Swap:")), "")
        mem = mem_line.split()
        if len(mem) >= 3:
            total, used = int(mem[1]), int(mem[2])
            pct = round(used / total * 100) if total else 0
            checks.append(check("Memory", "warn" if pct > 90 else "ok",
                                 f"{human_bytes(used)} / {human_bytes(total)} ({pct}%)"))
            data["memory"] = {"total": total, "used": used, "pct": pct}
        swap = swap_line.split()
        if len(swap) >= 3 and int(swap[1]) > 0:
            s_total, s_used = int(swap[1]), int(swap[2])
            s_pct = round(s_used / s_total * 100)
            checks.append(check("Swap", "warn" if s_pct > 50 else "ok", f"{human_bytes(s_used)} / {human_bytes(s_total)} ({s_pct}%)"))
    else:
        checks.append(check("Memory", "unknown", "detailed memory stats require Linux `free`"))

    # GPU + NVLink (best-effort; absent on nodes without an NVIDIA GPU)
    if which("nvidia-smi"):
        out, rc = run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                        "--format=csv,noheader,nounits"])
        if rc == 0 and out:
            gpus = []
            for i, line in enumerate(out.splitlines()):
                parts = [p.strip() for p in line.split(",")]
                if len(parts) == 5:
                    name, util, mused, mtotal, temp = parts
                    gpus.append({"index": i, "name": name, "util_pct": util, "mem_used_mb": mused,
                                 "mem_total_mb": mtotal, "temp_c": temp})
                    warn = float(temp) > 85 if temp.replace(".", "", 1).isdigit() else False
                    checks.append(check(f"GPU {i}: {name}", "warn" if warn else "ok",
                                         f"util={util}% mem={mused}/{mtotal}MB temp={temp}C"))
            data["gpus"] = gpus
        else:
            checks.append(check("GPU", "warn", "nvidia-smi present but query failed"))

        nvlink_out, nvlink_rc = run(["nvidia-smi", "nvlink", "-s"])
        link_lines = [l for l in nvlink_out.splitlines() if re.search(r"\bLink\s+\d+\b", l)]
        if nvlink_rc == 0 and link_lines:
            checks.append(check("NVLink", "ok", link_lines[0][:80]))
        else:
            checks.append(check("NVLink", "unknown", "no active NVLink partitions detected (normal for single-GPU nodes like DGX Spark GB10)"))
    else:
        checks.append(check("GPU", "unknown", "nvidia-smi not found — no NVIDIA GPU or driver not installed"))

    # Disk
    disks = []
    for path in ["/"] + [d for d in cfg.get("data_dirs", []) if d != "~/.hermes"]:
        p = Path(path).expanduser()
        try:
            total, used, free = shutil.disk_usage(p)
            pct = round(used / total * 100) if total else 0
            disks.append({"path": str(p), "total": total, "used": used, "free": free, "pct": pct})
            checks.append(check(f"Disk {p}", "warn" if pct > 85 else "ok",
                                 f"{human_bytes(used)} / {human_bytes(total)} ({pct}% used, {human_bytes(free)} free)"))
        except Exception as e:
            checks.append(check(f"Disk {p}", "unknown", None, str(e)))
    data["disks"] = disks

    return {"checks": checks, **data}


# ── 4. Network Health ──────────────────────────────────────────────────────

def section_network(cfg, quick=False):
    checks = []
    interfaces = []

    if IS_LINUX and which("ip"):
        ip_out, _ = run(["ip", "-4", "addr", "show"])
        for m in re.finditer(r"^\d+: (\S+):.*?\n\s+inet (\S+)", ip_out, re.MULTILINE | re.DOTALL):
            iface, addr = m.group(1), m.group(2)
            if iface == "lo":
                continue
            interfaces.append({"iface": iface, "addr": addr})
            checks.append(check(f"Interface {iface}", "ok", addr))
        if not interfaces:
            checks.append(check("Network interfaces", "critical", "no non-loopback IPv4 address found"))
    else:
        try:
            interfaces.append({"iface": "primary", "addr": socket.gethostbyname(socket.gethostname())})
            checks.append(check("Network interfaces", "ok", interfaces[0]["addr"],
                                 "best-effort lookup — `ip` not available on this platform"))
        except Exception as e:
            checks.append(check("Network interfaces", "unknown", None, str(e)))

    # DNS resolution
    try:
        socket.setdefaulttimeout(3)
        socket.gethostbyname("example.com")
        checks.append(check("DNS resolution", "ok", "resolved example.com"))
    except Exception as e:
        checks.append(check("DNS resolution", "critical", None, str(e)))
    finally:
        socket.setdefaulttimeout(None)

    if quick:
        checks.append(check("Latency / connectivity checks", "unknown", "skipped (--quick)"))
        return {"checks": checks, "interfaces": interfaces}

    # Latency / packet loss to configured targets
    for target in cfg.get("network_targets", []):
        flag = "-n" if IS_WIN else "-c"
        count = "2"
        cmd = ["ping", flag, count, target] if not IS_WIN else ["ping", flag, count, target]
        out, rc = run(cmd, timeout=6)
        if rc == 0:
            loss_m = re.search(r"(\d+(?:\.\d+)?)%\s*(?:packet)?\s*loss", out)
            loss = loss_m.group(1) if loss_m else "0"
            checks.append(check(f"Latency: {target}", "warn" if float(loss) > 0 else "ok", f"{loss}% loss"))
        else:
            checks.append(check(f"Latency: {target}", "critical", "unreachable"))

    # External service connectivity. Judge success from the captured HTTP status code
    # alone (not curl's own exit code) — curl can exit non-zero for reasons unrelated
    # to the request itself (e.g. failing to write the discarded body on some platforms)
    # even though -w already captured a valid response code.
    for svc in cfg.get("external_services", []):
        name, url = svc["name"], svc["url"]
        out, _ = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url])
        ok = bool(re.match(r"^[23]\d\d$", out.strip()))
        checks.append(check(f"External: {name}", "ok" if ok else "warn", out or "no response"))

    return {"checks": checks, "interfaces": interfaces}


# ── 5. Data and Storage ────────────────────────────────────────────────────

def section_storage(cfg):
    checks = []

    # Mounted filesystem health
    if IS_LINUX and which("findmnt"):
        out, rc = run(["findmnt", "-t", "nfs,nfs4,cifs", "-o", "TARGET,SOURCE,FSTYPE", "-n"])
        if rc == 0 and out:
            for line in out.splitlines():
                checks.append(check(f"Mount: {line.split()[0]}", "ok", line))
        else:
            checks.append(check("Network mounts", "ok", "none configured / none active"))

    # Writable status of key data directories
    for d in cfg.get("data_dirs", ["~/.hermes"]):
        p = Path(d).expanduser()
        if not p.exists():
            checks.append(check(f"Data dir {p}", "warn", "does not exist"))
            continue
        writable = os.access(p, os.W_OK)
        checks.append(check(f"Data dir {p}", "ok" if writable else "critical",
                             "writable" if writable else "NOT writable"))

    # Artifact storage locations — existence + non-trivial size as an integrity proxy
    for d in cfg.get("artifact_dirs", []):
        p = Path(d).expanduser()
        if not p.exists():
            checks.append(check(f"Artifact store {p}", "warn", "does not exist"))
            continue
        try:
            n_files = sum(1 for _ in p.rglob("*") if _.is_file())
            checks.append(check(f"Artifact store {p}", "ok", f"{n_files} file(s) present"))
        except Exception as e:
            checks.append(check(f"Artifact store {p}", "unknown", None, str(e)))

    if not cfg.get("artifact_dirs"):
        checks.append(check("Artifact storage", "unknown", "no artifact_dirs configured in node-health.json"))

    return {"checks": checks}


# ── 6. Security Posture ────────────────────────────────────────────────────

def section_security(cfg, quick=False):
    checks = []

    # Authentication mechanism sanity (SSH key-only, no root login) — best-effort, Linux only.
    # Query `sshd -T` (sshd's own resolved config), not the raw sshd_config file. Found live,
    # 2026-08-02: a naive regex grep of /etc/ssh/sshd_config's own text produced a false
    # positive here — the main file had a stale-looking `PermitRootLogin yes`, but an
    # `Include /etc/ssh/sshd_config.d/*.conf` earlier in the file pulled in a drop-in that
    # actually set it to `no` (OpenSSH keeps the *first* value seen per keyword, so the
    # drop-in wins) — a real, deliberate hardening config the file-regex approach was
    # completely blind to. `sshd -T` reports what sshd itself resolved, Include directives,
    # first-wins semantics and all, so it can't be fooled the same way. Reports the
    # top-level default, not a Match-scoped per-user override (e.g. a documented, narrow
    # `Match User` exception) — that's the right thing to report for a general posture check.
    if IS_LINUX and which("sshd"):
        out, rc = run(["sudo", "-n", "sshd", "-T"], timeout=5)
        if rc != 0:
            out, rc = run(["sshd", "-T"], timeout=5)
        if rc == 0 and out:
            pw_auth = re.search(r"(?im)^passwordauthentication\s+(\S+)", out)
            root_login = re.search(r"(?im)^permitrootlogin\s+(\S+)", out)
            pw_ok = pw_auth and pw_auth.group(1).lower() == "no"
            checks.append(check("SSH password auth disabled", "ok" if pw_ok else "warn",
                                 pw_auth.group(1) if pw_auth else "not reported"))
            root_ok = root_login and root_login.group(1).lower() in ("no", "prohibit-password")
            checks.append(check("SSH root login restricted", "ok" if root_ok else "warn",
                                 root_login.group(1) if root_login else "not reported"))
        else:
            checks.append(check("SSH auth config", "unknown",
                                 "`sshd -T` failed or needs root — run as root/with sudo for this check"))
    else:
        checks.append(check("SSH auth config", "unknown", "sshd not found on this platform"))

    # Config/secret file permission integrity — every ~/.hermes/config/*.json should be 0600
    cfg_dir = HERMES_HOME / "config"
    if cfg_dir.is_dir():
        loose = []
        for f in cfg_dir.glob("*.json"):
            try:
                mode = f.stat().st_mode & 0o777
                if mode & 0o077:
                    loose.append((f.name, oct(mode)))
            except Exception:
                continue
        if loose:
            checks.append(check("Config file permissions", "warn",
                                 f"{len(loose)} file(s) readable/writable by group or others",
                                 ", ".join(f"{n} ({m})" for n, m in loose)))
        else:
            checks.append(check("Config file permissions", "ok", f"all {len(list(cfg_dir.glob('*.json')))} config file(s) are 0600 or stricter"))
    else:
        checks.append(check("Config file permissions", "unknown", f"{cfg_dir} not found"))

    if quick:
        checks.append(check("Open ports scan", "unknown", "skipped (--quick)"))
        return {"checks": checks}

    # Open / listening ports vs an optional allowlist
    if IS_LINUX and which("ss"):
        out, rc = run(["ss", "-tln"])
        ports = sorted(set(int(m) for m in re.findall(r":(\d+)\s", out)))
        allowed = cfg.get("allowed_listen_ports")
        if allowed is None:
            checks.append(check("Listening ports", "unknown", f"{len(ports)} port(s) open: {ports}",
                                 "no allowed_listen_ports baseline configured — informational only"))
        else:
            unexpected = [p for p in ports if p not in allowed]
            checks.append(check("Listening ports", "warn" if unexpected else "ok",
                                 f"{len(ports)} open, {len(unexpected)} unexpected",
                                 f"unexpected: {unexpected}" if unexpected else None))
    else:
        checks.append(check("Listening ports", "unknown", "`ss` not available on this platform"))

    # Recent audit / security check evidence
    audit_log_candidates = [
        HERMES_HOME / "logs" / "security-scan.log",
        HERMES_HOME / "logs" / "canary-audit.log",
    ]
    found = [p for p in audit_log_candidates if p.exists()]
    if found:
        newest = max(found, key=lambda p: p.stat().st_mtime)
        age_h = (time.time() - newest.stat().st_mtime) / 3600
        checks.append(check("Recent security audit", "warn" if age_h > 168 else "ok",
                             f"last evidence {age_h:.0f}h ago ({newest.name})"))
    else:
        checks.append(check("Recent security audit", "unknown",
                             "no audit log found — run the security-scanner or canary-monitor skill"))

    return {"checks": checks}


# ── 7. Task and Pipeline Health ────────────────────────────────────────────

def section_tasks(cfg):
    checks = []

    # Failed systemd units — a cheap, universal signal for stalled/failing tasks
    if IS_LINUX and which("systemctl"):
        for scope_args, label in [([], "system"), (["--user"], "user")]:
            out, rc = run(["systemctl"] + scope_args + ["--failed", "--no-legend"])
            n_failed = len([l for l in out.splitlines() if l.strip()]) if rc == 0 else 0
            checks.append(check(f"Failed units ({label})", "critical" if n_failed else "ok",
                                 f"{n_failed} failed unit(s)", out if n_failed else None))
    else:
        checks.append(check("Failed units", "unknown", "systemctl not available on this platform"))

    # Cron entries matching this node's managed patterns
    cron_out, cron_rc = run(["crontab", "-l"])
    if cron_rc == 0:
        patterns = cfg.get("cron_patterns", [])
        if not patterns:
            # Nothing configured to check for this node -- vacuously satisfied, not a gap.
            # Found live 2026-08-26: Amy's node-health.json sets cron_patterns: [] on purpose
            # (she has a real crontab entry, just nothing matching this fleet's own naming
            # convention), and the old logic reported "warn" for that regardless of whether
            # patterns was empty or genuinely unmatched -- indistinguishable "0 matched" in
            # both cases.
            checks.append(check("Managed cron jobs", "ok", "no patterns configured for this node"))
        else:
            matched = [l for l in cron_out.splitlines()
                       if l.strip() and not l.strip().startswith("#")
                       and any(p in l for p in patterns)]
            checks.append(check("Managed cron jobs", "ok" if matched else "warn",
                                 f"{len(matched)}/{len(patterns)} pattern group(s) matched"))
    else:
        checks.append(check("Managed cron jobs", "unknown", "no crontab found"))

    # Queue depth — pluggable, since this is entirely workload-specific.
    # timeout=60, not 15 or 30: a probe that fetches a credential from Vaultwarden
    # (the common case in this fleet) routinely takes ~15-20s on its own — see
    # LESSONS_LEARNED.md §7 ("Vaultwarden-fetching services take ~20s to start").
    # Found live: the default 15s cut off `hermes-queue-probe.sh` (~15.8s end to
    # end) with zero error surfaced, just a bare "(no output)" — rc=-1 (timeout)
    # and rc!=0 (real failure) were reported identically, which cost real
    # debugging time to tell apart. Raised again to 60s on 2026-08-09:
    # vault-get-secret.sh 1.2.0 now retries internally up to 3x on a real,
    # previously-hit transient bw/Vaultwarden failure, and a single successful
    # retry alone can take ~32s — 30s was no longer enough margin.
    probe_cmd = cfg.get("queue_probe_command")
    if probe_cmd:
        out, rc = run(probe_cmd, shell=True, timeout=60)
        if rc == 0:
            checks.append(check("Queue depth", "ok", out or "(no output)"))
        elif rc == -1:
            checks.append(check("Queue depth", "unknown", "probe command timed out (>60s)"))
        else:
            checks.append(check("Queue depth", "unknown", f"probe command failed (exit {rc})", out or None))
    else:
        checks.append(check("Queue depth", "unknown", "no queue_probe_command configured in node-health.json"))

    return {"checks": checks}


# ── 8. Observability and Telemetry ─────────────────────────────────────────

def section_observability(cfg, previous_state):
    checks = []

    if previous_state and previous_state.get("identity", {}).get("timestamp"):
        try:
            prev_ts = datetime.fromisoformat(previous_state["identity"]["timestamp"])
            age_min = (datetime.now(timezone.utc) - prev_ts).total_seconds() / 60
            checks.append(check("Time since last health check", "warn" if age_min > 2160 else "ok",
                                 f"{age_min:.0f} min ago"))
        except Exception:
            checks.append(check("Time since last health check", "unknown", "could not parse previous timestamp"))
    else:
        checks.append(check("Time since last health check", "unknown", "no previous report found — this is the first run"))

    # Recent error/warning counts from the gateway journal
    if IS_LINUX and which("journalctl"):
        out, rc = run(["journalctl", "-u", "hermes-gateway", "--user", "--since", "1 hour ago", "--no-pager", "-q"])
        if rc != 0 or not out:
            out, rc = run(["journalctl", "-u", "hermes-gateway", "--since", "1 hour ago", "--no-pager", "-q"])
        if rc == 0:
            n_err  = len(re.findall(r"\bERROR\b", out))
            n_warn = len(re.findall(r"\bWARN(?:ING)?\b", out))
            checks.append(check("Gateway errors (1h)", "critical" if n_err else "ok", str(n_err)))
            checks.append(check("Gateway warnings (1h)", "warn" if n_warn else "ok", str(n_warn)))
        else:
            checks.append(check("Gateway log activity", "unknown", "journalctl unit not found or inaccessible"))
    else:
        checks.append(check("Gateway log activity", "unknown", "journalctl not available on this platform"))

    checks.append(check("Latest status report", "ok", str(STATE_PATH)))

    return {"checks": checks}


# ── 9. Summary and Severity ────────────────────────────────────────────────

_RECOMMENDATIONS = [
    (re.compile(r"disk", re.I),        "Free up space or expand the volume."),
    (re.compile(r"memory|swap", re.I), "Investigate memory pressure; consider restarting high-RSS services."),
    (re.compile(r"gpu", re.I),         "Check `nvidia-smi` for thermal throttling or a stuck process."),
    (re.compile(r"service|unit", re.I), "Check `systemctl status <unit>` and recent logs, then restart if safe."),
    (re.compile(r"dns|latency|external", re.I), "Check network connectivity and DNS resolver configuration."),
    (re.compile(r"ssh|permission|port", re.I), "Review the security posture section and tighten the flagged setting."),
    (re.compile(r"cron|queue|failed units", re.I), "Investigate the task/pipeline scheduler for stalled or failing jobs."),
]


def _recommend(name):
    for pattern, advice in _RECOMMENDATIONS:
        if pattern.search(name):
            return advice
    return f"Investigate '{name}' — see its detail field."


def build_summary(sections):
    all_checks = []
    for sec in sections.values():
        all_checks.extend(sec.get("checks", []))

    critical = [c for c in all_checks if c["status"] == "critical"]
    warn     = [c for c in all_checks if c["status"] == "warn"]
    unknown  = [c for c in all_checks if c["status"] == "unknown"]
    ok       = [c for c in all_checks if c["status"] == "ok"]

    if critical:
        overall = "Critical"
    elif warn:
        overall = "Degraded"
    elif not ok and unknown:
        overall = "Unknown"
    else:
        overall = "Healthy"

    # Include `detail` inline and a severity tag — a bare "{name}: {value}" often hides the
    # actual diagnostic (e.g. "Failed units (system): 2 failed unit(s)" without naming which
    # units; "Config file permissions: 1 file(s) readable by group" without naming the file).
    # This is what the fleet-health email actually shows per identity, so it needs to be
    # self-contained — the reader won't also be looking at the full per-section check list.
    def _fmt_issue(c):
        tag = "CRITICAL" if c["status"] == "critical" else "WARN"
        line = f"[{tag}] {c['name']}: {c['value']}"
        if c.get("detail"):
            line += f" — {c['detail']}"
        return line

    issues = [_fmt_issue(c) for c in critical + warn]
    recommendations = list(dict.fromkeys(_recommend(c["name"]) for c in critical + warn))

    if overall == "Critical":
        escalation = "Immediate attention required — one or more critical checks failed."
    elif overall == "Degraded":
        escalation = "Monitor closely; escalate if degraded checks do not clear on the next run."
    else:
        escalation = "None."

    return {
        "overall_status": overall,
        "checks_ok": len(ok),
        "checks_warn": len(warn),
        "checks_critical": len(critical),
        "checks_unknown": len(unknown),
        "issues": issues,
        "recommended_actions": recommendations,
        "escalation": escalation,
    }


# ── report assembly ────────────────────────────────────────────────────────

def load_previous_state():
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return None


def persist_state(report):
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(report, indent=2))
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(f"{report['identity']['timestamp']}  {report['summary']['overall_status']}  "
                     f"ok={report['summary']['checks_ok']} warn={report['summary']['checks_warn']} "
                     f"critical={report['summary']['checks_critical']}\n")
    except Exception as e:
        print(f"WARNING: could not persist state: {e}", file=sys.stderr)


def build_report(cfg, sections_wanted, quick):
    previous_state = load_previous_state()
    sections = {}

    if "identity" in sections_wanted:
        sections["identity"] = section_identity(cfg)
    if "services" in sections_wanted:
        sections["services"] = section_services(cfg, quick=quick)
    if "compute" in sections_wanted:
        sections["compute"] = section_compute(cfg)
    if "network" in sections_wanted:
        sections["network"] = section_network(cfg, quick=quick)
    if "storage" in sections_wanted:
        sections["storage"] = section_storage(cfg)
    if "security" in sections_wanted:
        sections["security"] = section_security(cfg, quick=quick)
    if "tasks" in sections_wanted:
        sections["tasks"] = section_tasks(cfg)
    if "observability" in sections_wanted:
        sections["observability"] = section_observability(cfg, previous_state)

    sections["summary"] = build_summary(sections)
    return sections


# ── output renderers ────────────────────────────────────────────────────────

def render_json(report):
    return json.dumps(report, indent=2)


def _yaml_scalar(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if re.search(r'[:#\[\]{}\n]|^\s|\s$|^-\s', s) or s.strip() == "" or s in ("true", "false", "null"):
        return json.dumps(s)
    return s


def _yaml_dump(obj, indent=0):
    pad = "  " * indent
    lines = []
    if isinstance(obj, dict):
        if not obj:
            lines.append(f"{pad}{{}}")
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{k}:")
                lines.extend(_yaml_dump(v, indent + 1))
            else:
                lines.append(f"{pad}{k}: {_yaml_scalar(v) if not isinstance(v, (dict, list)) else ('{}' if isinstance(v, dict) else '[]')}")
    elif isinstance(obj, list):
        if not obj:
            lines.append(f"{pad}[]")
        for item in obj:
            if isinstance(item, (dict, list)) and item:
                sub = _yaml_dump(item, indent + 1)
                if sub:
                    lines.append(f"{pad}- " + sub[0].strip())
                    lines.extend(sub[1:])
            else:
                lines.append(f"{pad}- {_yaml_scalar(item)}")
    return lines


def render_yaml(report):
    """Minimal dependency-free YAML emitter — no PyYAML requirement for a portable skill."""
    try:
        import yaml  # optional, use it if the node happens to have it — nicer output
        return yaml.safe_dump(report, sort_keys=False, default_flow_style=False)
    except ImportError:
        return "\n".join(_yaml_dump(report))


_STATUS_MARK = {"ok": "OK", "warn": "WARN", "critical": "CRIT", "unknown": "?"}


def render_markdown(report):
    lines = []
    ident = report.get("identity", {})
    summ = report.get("summary", {})
    lines.append(f"# Hermes Node Health Report — {ident.get('node_name', '?')}")
    lines.append("")
    lines.append(f"**Timestamp:** {ident.get('timestamp', '?')}  ")
    lines.append(f"**Overall status:** {summ.get('overall_status', '?')}  ")
    lines.append(f"**Checks:** {summ.get('checks_ok', 0)} ok / {summ.get('checks_warn', 0)} warn / "
                 f"{summ.get('checks_critical', 0)} critical / {summ.get('checks_unknown', 0)} unknown")
    lines.append("")

    titles = {
        "identity": "1. Node Identity and Context",
        "services": "2. Service Availability",
        "compute": "3. Compute Health",
        "network": "4. Network Health",
        "storage": "5. Data and Storage",
        "security": "6. Security Posture",
        "tasks": "7. Task and Pipeline Health",
        "observability": "8. Observability and Telemetry",
    }
    for key, title in titles.items():
        sec = report.get(key)
        if not sec:
            continue
        lines.append(f"## {title}")
        for c in sec.get("checks", []):
            mark = _STATUS_MARK.get(c["status"], "?")
            detail = f" — {c['detail']}" if c.get("detail") else ""
            lines.append(f"- [{mark}] **{c['name']}**: {c['value']}{detail}")
        lines.append("")

    lines.append("## 9. Summary and Severity")
    lines.append(f"- **Overall:** {summ.get('overall_status')}")
    if summ.get("issues"):
        lines.append("- **Issues:**")
        for issue in summ["issues"]:
            lines.append(f"  - {issue}")
    else:
        lines.append("- **Issues:** none")
    if summ.get("recommended_actions"):
        lines.append("- **Recommended actions:**")
        for rec in summ["recommended_actions"]:
            lines.append(f"  - {rec}")
    lines.append(f"- **Escalation:** {summ.get('escalation')}")
    lines.append("")

    return "\n".join(lines)


def render_text(report):
    # Plain-text variant of the markdown report (strips markdown syntax) for terminals/logs.
    md = render_markdown(report)
    text = re.sub(r"^#+\s*", "", md, flags=re.MULTILINE)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    return text


RENDERERS = {"json": render_json, "yaml": render_yaml, "markdown": render_markdown, "text": render_text}


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Hermes Agent node health status check")
    parser.add_argument("--format", choices=list(RENDERERS), default="markdown")
    parser.add_argument("--output", help="Write report to this file instead of stdout")
    parser.add_argument("--quick", action="store_true", help="Skip slow network/security checks")
    parser.add_argument("--section", nargs="+", choices=SECTION_NAMES, help="Only run these sections")
    parser.add_argument("--config", help="Override config file path")
    parser.add_argument("--no-persist", action="store_true", help="Don't write state/log files")
    args = parser.parse_args()

    global CONFIG_PATH
    if args.config:
        CONFIG_PATH = Path(args.config)

    cfg = load_config()
    sections_wanted = args.section or SECTION_NAMES
    report = build_report(cfg, sections_wanted, args.quick)

    if not args.no_persist:
        persist_state(report)

    output = RENDERERS[args.format](report)

    if args.output:
        Path(args.output).write_text(output)
        print(f"Report written to {args.output}")
    else:
        print(output)

    sys.exit(1 if report["summary"]["overall_status"] == "Critical" else 0)


if __name__ == "__main__":
    main()
