#!/usr/bin/env python3
# Version: 1.2.0
#
# 1.2.0 (2026-08-26) — added `coder` (Qwen3.8-27B-abliterated, port 8094, llama-coder unit) as a
# real, active WAKE_TARGETS entry -- un-retiring `coder` as on-demand rather than always-resident,
# moved from spark-2 (Qwen3-Coder-Next) to spark since that's where the winning bake-off candidate
# was already downloaded. First WAKE_TARGETS entry that's actually exercised in normal operation
# since `super` went always-resident at Stage 12.
#
# 1.1.0 — `super`'s WAKE_TARGETS entry updated for the GLM-4.7-Flash swap (Stage 12,
# 2026-08-23): required_gib 85 -> 25, matching the new model's real size. Functionally dead in
# normal operation now that `super` is always-resident; kept accurate rather than stale in case
# the narrow crash-recovery path (a request landing between a crash and systemd's automatic
# restart) ever exercises it.
#
# hermes-model-wake-worker — brings an on-demand model backend up on request
# (IMPLEMENTATION_PLAN.md §4a, §6 Stage 2).
#
# Pulls JOB_TYPE=wake jobs from the broker, same claim/report protocol
# hermes-render-worker.py already uses, and runs ONLY on the node that hosts
# the on-demand backend (today: `spark`, for `super`) — this is what keeps the
# actual privileged action (`sudo systemctl start/stop`) local to the host it
# targets. hermes-router.py submits a wake job regardless of which node's
# router instance received the original request (IMPLEMENTATION_PLAN.md §4c's
# "no LLM turn, and no general-purpose network-facing process, is ever
# load-bearing for a privileged action" — extended here from cross-node
# render/embed jobs to cross-node model-lifecycle jobs), so this worker never
# needs a cross-node credential of its own.
#
# Already-warm counts as success immediately, at whatever cost one /health
# probe takes — most wake calls hit this path, since a role only goes idle
# after IDLE_TIMEOUT_S with no requests.
#
# Also touches WAKE_STATE_DIR/<role>.last_used on every invocation (success or
# already-warm) — hermes-model-idle-sleep.sh reads that file to decide when to
# stop an idle on-demand backend. Keeping that logic in a separate, simple,
# timer-triggered script rather than a background thread in this process
# means the sleep side can be reasoned about (and tested) independently of
# whether wake jobs are actively flowing.
#
# Deliberately boring: stdlib only, same as every other worker in this fleet.
#
# Config, all from the environment (mirrors hermes-render-worker.py's own):
#   BROKER_URL         default http://10.129.1.15:8100
#   BROKER_TOKEN       required
#   WORKER_NAME        default <hostname>
#   JOB_TYPE           default wake
#   POLL_SECONDS       default 5     — jobs should be claimed fast, this isn't a media queue
#   WAKE_TIMEOUT_S     default 180  — real measured cold-load times: nano ~56s, super ~100s
#                                     (IMPLEMENTATION_PLAN.md §4a/§4b) — generous margin, not tight
#   WAKE_STATE_DIR     default ~/.hermes/state/wake
#
# WAKE_TARGETS below is the one thing this file hardcodes rather than reads from the
# environment — it names a real systemd unit and a real sudo command, so it gets the same
# "verify before trusting" treatment as every model choice in this plan, not silent config.

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BROKER_URL = os.environ.get("BROKER_URL", "http://10.129.1.15:8100").rstrip("/")
TOKEN = os.environ.get("BROKER_TOKEN", "")
WORKER = os.environ.get("WORKER_NAME", socket.gethostname())
JOB_TYPE = os.environ.get("JOB_TYPE", "wake")
POLL = int(os.environ.get("POLL_SECONDS", "5"))
WAKE_TIMEOUT_S = int(os.environ.get("WAKE_TIMEOUT_S", "180"))
STATE_DIR = Path(os.environ.get("WAKE_STATE_DIR", str(Path.home() / ".hermes" / "state" / "wake")))

# role -> (health_url, systemd unit name, required free memory in GiB before starting)
# The memory figure is the real byte-verified model size (IMPLEMENTATION_PLAN.md §4a) plus a
# margin for KV cache and process overhead — not a guess. This exists because of a real incident
# (2026-08-21): starting `super` (76.9GB, Nemotron 3 Super at the time) while spark's three
# legacy backends (61GB) were still resident pushed total demand to 137.9GB against a 121GB+15GB
# swap ceiling, and the node became fully unresponsive over the network — not just slow,
# unreachable — requiring a hard reboot and a manual LUKS unlock to recover. This worker must
# refuse to start a model rather than trust that "it'll probably fit," the same "verify before
# trusting" rule this whole project already applies to model choices, extended to memory headroom.
#
# `super` is now GLM-4.7-Flash (Stage 12, 2026-08-23) and always-resident (Restart=always), not
# on-demand — this table only still matters for the narrow crash-recovery race where a caller
# requests `super` in the gap between a crash and systemd's own restart. 25 = 17.2GB byte-verified
# file size (18,474,983,296 bytes) plus the same margin proportion the 76.9GB->85GiB figure above
# used, rounded up.
WAKE_TARGETS = {
    "super": ("http://127.0.0.1:8095/health", "llama-super", 25),
    # coder = Huihui-Qwen3.8-27B-abliterated, byte-verified 16,810,714,400 bytes (15.65GiB),
    # moved here from spark-2's retired Qwen3-Coder-Next after a real execution-verified bake-off
    # (2026-08-26): Coder-Next crashed on its own generated code, Qwen3.8 passed all correctness
    # checks. On-demand rather than always-resident since coding tasks tolerate the wake latency.
    # 23 = 15.65GiB real size * the same ~1.45 margin ratio super's own 17.2GB->25GiB figure used.
    "coder": ("http://127.0.0.1:8094/health", "llama-coder", 23),
}


def log(msg):
    print(f"[hermes-model-wake-worker] {msg}", flush=True)


def available_gib():
    """Real MemAvailable from /proc/meminfo, in GiB — the kernel's own estimate of what can be
    given to a new process without swapping existing ones out, not a naive free-memory count."""
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                kib = int(line.split()[1])
                return kib / (1024 * 1024)
    raise RuntimeError("MemAvailable not found in /proc/meminfo")


def request(method, path, data=None, headers=None):
    req = urllib.request.Request(
        f"{BROKER_URL}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", **(headers or {})})
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def claim():
    try:
        return request("GET", f"/jobs/claim?type={JOB_TYPE}&worker={WORKER}").get("job")
    except urllib.error.URLError as exc:
        log(f"broker unreachable ({exc}) — retrying in {POLL}s")
        return None
    except Exception as exc:
        log(f"claim failed: {exc}")
        return None


def is_healthy(health_url):
    try:
        with urllib.request.urlopen(health_url, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


def touch_last_used(role):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    (STATE_DIR / f"{role}.last_used").write_text(str(time.time()))


def run_job(job):
    role = (job.get("payload") or {}).get("role", "")
    target = WAKE_TARGETS.get(role)
    if target is None:
        return 2, f"unknown wake role {role!r} — expected one of {sorted(WAKE_TARGETS)}"
    health_url, unit, required_gib = target

    if is_healthy(health_url):
        touch_last_used(role)
        return 0, ""

    free_gib = available_gib()
    if free_gib < required_gib:
        return 1, (f"refusing to start {unit}: needs ~{required_gib}GiB free, only "
                    f"{free_gib:.1f}GiB available — stop another resident backend first "
                    f"(see LESSONS_LEARNED-equivalent note in IMPLEMENTATION_PLAN.md §9, "
                    f"2026-08-21 incident)")

    log(f"job {job['id']}: {role!r} ({unit}) not healthy — {free_gib:.1f}GiB free, starting")
    proc = subprocess.run(["sudo", "systemctl", "start", unit], capture_output=True, text=True)
    if proc.returncode != 0:
        return 1, f"sudo systemctl start {unit} failed: {(proc.stderr or '').strip()[:500]}"

    deadline = time.monotonic() + WAKE_TIMEOUT_S
    while time.monotonic() < deadline:
        if is_healthy(health_url):
            touch_last_used(role)
            return 0, ""
        time.sleep(3)
    return 1, f"{unit} did not become healthy within {WAKE_TIMEOUT_S}s of starting"


def report(job_id, exit_code, error):
    headers = {
        "Content-Type": "application/octet-stream",
        "X-Exit-Code": str(exit_code),
        "X-Sha256": "",
        "X-Filename": "",
        "X-Error": (error or "").replace("\n", " ")[:900].encode("ascii", "replace").decode("ascii"),
        "X-Caption": "",
    }
    result = request("POST", f"/jobs/{job_id}/result", data=b"", headers=headers)
    log(f"job {job_id}: reported exit={exit_code} -> {result.get('state')}")


def main():
    if not TOKEN:
        sys.exit("BROKER_TOKEN is required")
    log(f"polling {BROKER_URL} every {POLL}s as '{WORKER}' for type='{JOB_TYPE}' jobs "
        f"(targets: {sorted(WAKE_TARGETS)})")
    while True:
        job = claim()
        if not job:
            time.sleep(POLL)
            continue
        try:
            exit_code, error = run_job(job)
            report(job["id"], exit_code, error)
        except Exception as exc:
            log(f"job {job['id']}: worker error: {exc}")
            try:
                report(job["id"], 1, f"worker exception: {exc}")
            except Exception as inner:
                log(f"job {job['id']}: could not report failure either: {inner}")


if __name__ == "__main__":
    main()
