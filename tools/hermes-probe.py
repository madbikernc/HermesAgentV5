#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-probe — chat access to tools/hermes-node-probe.py's real network node investigation
# (hostnames, MAC/vendor, OS fingerprint, full port/service scan via nmap). Owns the new Buzz
# `probe` topic. Direct operator request: "probe <IP>" fires the real tool against that IP.
#
# Genuinely async, unlike every other specialist in this fleet: hermes-node-probe.py's own
# exhaustive scan (-p- every port, -O OS fingerprint, -sV/-sC service/script detection) takes
# 10-30 minutes by design -- its own docstring says outright "built for a scheduled/background
# investigation, not an interactive one." Far too long for the claim/ack/synchronous-publish shape
# every other specialist here uses. This agent's main loop is deliberately different: it launches
# the probe as a detached subprocess (Popen, not run()), immediately acks the Buzz claim, and polls
# in-flight jobs non-blockingly on every loop iteration alongside claiming new work -- one
# long-running probe never blocks another probe/status claim from being picked up (though
# MAX_CONCURRENT_PROBES caps how many actually run at once; see below). hermes-presenter.py needed
# no new plumbing for the delayed follow-up beyond one change: its existing check_outstanding()
# poll loop already delivers whenever a task's state resolves, however long that takes -- the one
# thing that DID need fixing was its *generic* TASK_TIMEOUT_SECONDS notice, which would otherwise
# fire (default 300s) well before a real probe finishes; see PROBE_TASK_TIMEOUT_SECONDS in
# hermes-presenter.py 1.6.2.
#
# Max ONE probe in flight at a time (MAX_CONCURRENT_PROBES, default 1) -- nmap's own exhaustive
# mode is heavy on both source and target; a second "probe X" request while one is already running
# gets an honest "already running" message instead of silently queuing or running two heavy scans
# concurrently.
#
# Scope: direct operator decision (2026-08-31) was to allow any IP, not restrict to the fleet's own
# LAN -- hermes-node-probe.py's own docstring already carries an "authorized use only" note as a
# warning, not an enforced boundary; this agent adds no additional restriction on top of that,
# matching the operator's own explicit choice. It does append a plain visibility note to the
# delivered report when the target isn't a private/LAN address -- not a block, just a flag.
#
# Known limitation, accepted for v1, not solved here: an in-flight probe is tracked in this
# process's own memory only. A restart of this service mid-scan loses track of that one job -- the
# underlying nmap process (already detached via sudo) keeps running as an orphan with no one left
# to collect or report its result. Acceptable given Restart=always/RestartSec=10 makes a mid-scan
# restart rare in practice, and re-running the probe costs nothing but time.
#
# Config, all from the environment (injected by hermes-probe-wrapper.sh):
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN, GUARD_URL/GUARD_TOKEN — same as every other
#   specialist
#   POLL_SECONDS          default 5
#   PROBE_TIMEOUT_SECONDS  default 2100 (35 min) — outer safety net above hermes-node-probe.py's
#                        own internal 1800s (30 min) nmap budget; a probe still running past this
#                        gets killed and reported as a timeout failure rather than left to run
#                        forever
#   MAX_CONCURRENT_PROBES default 1
#   CLAIMANT               default "hermes-probe"

import ipaddress
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_injection_guard  # noqa: E402

REPO_DIR = Path(__file__).resolve().parent.parent
PY = "/usr/bin/python3"

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
GUARD_URL = os.environ.get("GUARD_URL", f"http://{SPARK_IP}:8096").rstrip("/")
GUARD_TOKEN = os.environ.get("GUARD_TOKEN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
PROBE_TIMEOUT_SECONDS = int(os.environ.get("PROBE_TIMEOUT_SECONDS", "2100"))
MAX_CONCURRENT_PROBES = int(os.environ.get("MAX_CONCURRENT_PROBES", "1"))
CLAIMANT = os.environ.get("CLAIMANT", "hermes-probe")

IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def log(msg):
    print(f"[hermes-probe] {msg}", flush=True)


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def claim_next(topic):
    try:
        return _post(f"{BUZZ_URL}/claims/next", {"topic": topic, "claimant": CLAIMANT}, BUZZ_TOKEN).get("claim")
    except Exception as exc:
        log(f"claim_next({topic!r}) failed: {exc}")
        return None


def ack_claim(claim_id):
    try:
        _post(f"{BUZZ_URL}/claims/{claim_id}/ack", {"claimant": CLAIMANT}, BUZZ_TOKEN)
    except Exception as exc:
        log(f"ack_claim({claim_id}) failed: {exc}")


def fetch_raw_text(task_id, memory_ref):
    turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=50", MEMORY_TOKEN).get("turns", [])
    if not turns:
        return None
    if memory_ref:
        for t in turns:
            if str(t["id"]) == str(memory_ref) or memory_ref == f"turn:{t['id']}":
                return t["raw"]
    return turns[-1]["raw"]


def set_task_state(task_id, state, topic=None):
    try:
        payload = {"id": task_id, "agent": "probe", "state": state}
        if topic:
            payload["topic"] = topic
        _post(f"{MEMORY_URL}/tasks", payload, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_guard_verdict(layer, severity_value, detail):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": "guard-log", "agent": "guard", "role": "system",
            "raw": json.dumps({"node": "probe", "layer": layer, "severity": severity_value, **detail}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"guard verdict logging failed: {exc}")


def screen(text):
    hits = hermes_injection_guard.scan_messages([{"role": "user", "content": text}])
    severity = hermes_injection_guard.overall_severity(hits)
    if severity == "block":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log(f"Layer 1 BLOCKED probe request: categories={categories}")
        log_guard_verdict("L1", "block", {"categories": categories})
        return False
    if severity == "flag":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log_guard_verdict("L1", "flag", {"categories": categories})

    if GUARD_TOKEN:
        try:
            verdict = _post(f"{GUARD_URL}/classify", {"text": text}, GUARD_TOKEN, timeout=10)
            if verdict.get("hit"):
                log(f"Layer 2 BLOCKED probe request: score={verdict['score']:.3f}")
                log_guard_verdict("L2", "block", {"label": verdict["label"], "score": verdict["score"]})
                return False
        except Exception as exc:
            log(f"Layer 2 unreachable, proceeding on Layer 1 alone: {exc}")
    return True


def publish_result(task_id, memory_ref, ok, message):
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "probe", "role": "assistant",
        "raw": message, "presented": message,
    }, MEMORY_TOKEN)
    set_task_state(task_id, "done" if ok else "error")
    _post(f"{BUZZ_URL}/messages", {
        "from": "probe", "topic": "results", "task_id": task_id,
        "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)


def launch_probe(ip):
    """Invokes the real, already-vetted script exactly as a user would from the CLI (`python3
    hermes-node-probe.py <ip>`) -- same "wrap the execution plane that already works" reasoning
    every other specialist in this fleet already follows, just non-blocking here. stdout goes to a
    temp file, not a PIPE -- avoids the classic subprocess deadlock risk if the report output ever
    exceeds the pipe buffer."""
    out_path = tempfile.NamedTemporaryFile(prefix="node-probe-", suffix=".log", delete=False).name
    f = open(out_path, "w")
    proc = subprocess.Popen(
        [PY, str(REPO_DIR / "tools" / "hermes-node-probe.py"), ip],
        stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        start_new_session=True,  # own process group, so a PROBE_TIMEOUT_SECONDS kill can take
                                  # down the whole tree (this python process -> sudo -> nmap), not
                                  # just the direct child -- sudo's own child would otherwise be
                                  # orphaned and keep running to completion unsupervised
    )
    f.close()  # child already has its own fd via dup(); safe to close the parent's copy
    return proc, out_path


def is_private(ip):
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return True  # fail closed on the visibility note -- never claims "public" for garbage input


def process_new_claim(in_flight):
    claim = claim_next("probe")
    if not claim:
        return False

    claim_id = claim["id"]
    msg = claim["message"]
    task_id, memory_ref = msg.get("task_id"), msg.get("memory_ref")

    if not task_id:
        log(f"claim {claim_id}: message has no task_id — acking and dropping")
        ack_claim(claim_id)
        return True

    request_text = fetch_raw_text(task_id, memory_ref)
    if not request_text:
        log(f"claim {claim_id}: task {task_id!r} has no raw text — acking and dropping")
        ack_claim(claim_id)
        set_task_state(task_id, "error-no-content")
        return True

    if not screen(request_text):
        set_task_state(task_id, "blocked")
        ack_claim(claim_id)
        publish_result(task_id, memory_ref, False,
                        "This request was rejected by the fleet's screening layer.")
        return True

    m = IP_RE.search(request_text)
    if not m:
        ack_claim(claim_id)
        publish_result(task_id, memory_ref, False,
                        "I didn't find an IP address in your request. Which IP would you like me to probe?")
        return True
    ip = m.group(0)
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        ack_claim(claim_id)
        publish_result(task_id, memory_ref, False, f"'{ip}' doesn't look like a valid IP address.")
        return True

    ack_claim(claim_id)  # ack immediately either way -- real work (if any) happens in the
                          # background, well past any Buzz lease window

    if len(in_flight) >= MAX_CONCURRENT_PROBES:
        # Claimed (so it doesn't sit ambiguously on the topic) but not launched -- an honest,
        # immediate "already running" beats either silently dropping it or queuing with no
        # feedback for up to 30 minutes.
        running = ", ".join(job["ip"] for job in in_flight.values())
        publish_result(task_id, memory_ref, False,
                        f"A probe is already in progress ({running}). Try again once it completes.")
        return True

    set_task_state(task_id, "probing", topic="probe")
    log(f"claim {claim_id}: task {task_id!r} -> probing {ip} (up to ~30 min, running in background)")

    proc, out_path = launch_probe(ip)
    in_flight[task_id] = {
        "proc": proc, "out_path": out_path, "ip": ip,
        "memory_ref": memory_ref, "started_at": time.time(),
    }
    return True


def check_in_flight(in_flight):
    now = time.time()
    for task_id, job in list(in_flight.items()):
        proc = job["proc"]
        rc = proc.poll()

        if rc is None:
            if now - job["started_at"] > PROBE_TIMEOUT_SECONDS:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)  # whole tree, see launch_probe()
                except ProcessLookupError:
                    pass  # already exited between poll() and here
                proc.wait(timeout=10)
                publish_result(task_id, job["memory_ref"], False,
                                f"Probe of {job['ip']} did not finish within "
                                f"{PROBE_TIMEOUT_SECONDS // 60} minutes and was stopped.")
                log(f"task {task_id!r}: probe of {job['ip']} killed after exceeding "
                    f"PROBE_TIMEOUT_SECONDS")
                _cleanup(job)
                del in_flight[task_id]
            continue  # still running, nothing else to do this cycle

        try:
            with open(job["out_path"]) as f:
                output = f.read().strip()
        except Exception as exc:
            output = ""
            log(f"task {task_id!r}: could not read probe output file: {exc}")

        if not is_private(job["ip"]):
            output += (f"\n\n(Note: {job['ip']} is not a private/LAN address -- "
                       f"confirm you're authorized to scan it.)")

        ok = rc == 0 and bool(output)
        message = output if output else f"Probe of {job['ip']} produced no output (exit {rc})."
        publish_result(task_id, job["memory_ref"], ok, message)
        log(f"task {task_id!r}: probe of {job['ip']} finished (exit {rc}, {len(output)} chars) after "
            f"{now - job['started_at']:.0f}s")
        _cleanup(job)
        del in_flight[task_id]


def _cleanup(job):
    try:
        os.remove(job["out_path"])
    except OSError:
        pass


def main():
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")
    if not GUARD_TOKEN:
        log("WARNING: GUARD_TOKEN not set — this agent's own Layer 2 screening is skipped")
    log(f"watching Buzz topic 'probe', polling every {POLL_SECONDS}s, "
        f"max {MAX_CONCURRENT_PROBES} concurrent, timeout {PROBE_TIMEOUT_SECONDS}s")

    in_flight = {}
    while True:
        try:
            check_in_flight(in_flight)
            claimed = process_new_claim(in_flight)
        except Exception as exc:
            log(f"unhandled error this cycle, continuing: {exc}")
            claimed = False
        if not claimed:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
