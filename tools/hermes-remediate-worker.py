#!/usr/bin/env python3
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: ALLOWLIST_PATH default repointed
# from HermesAgentV4 to HermesAgentV5.
#
# hermes-remediate-worker — executes allowlisted self-remediation actions (service restarts, nudges)
# on behalf of a persona, without ever giving that persona sudo/systemctl access herself.
#
# Direct request (2026-08-21, following the Stage 8 near-miss where a Buzz watcher went quiet with
# no way to tell "transient" from "stuck" apart): Sintra and Amy check on each other and themselves
# hourly and should be able to fix routine problems without waking The Boss for every one. This
# worker is the mechanical, privileged half of that — same "no LLM turn, and no general-purpose
# process, is ever load-bearing for a mechanical/privileged action" split this whole fleet already
# uses for on-demand model wakes (hermes-model-wake-worker.py) and renders. A persona never gets a
# new sudo grant; she asks the broker, and this already-privileged worker (running as `pmoney`, full
# existing sudo) does the actual restart, checked against a hard allowlist first.
#
# Runs one instance per node, each with its own JOB_TYPE ("remediate-sintra" on spark,
# "remediate-amy" on spark-2) so a job for one identity's services is never claimed by the worker on
# the wrong node — mirrors hermes-render-worker-video.service's own JOB_TYPE=video split from plain
# image renders, not a new pattern.
#
# Actions (checked against infra/hermes-remediate/allowlist.json — see that file to add more; no
# code change needed for a new *target*, only for a genuinely new *action type*):
#   restart-service  payload: {identity, action: "restart-service", target: "<exact unit name>"}
#                    Refuses (exit 2) if target isn't in this identity's restart-service allowlist.
#                    Restarts, then polls `systemctl is-active` for up to RESTART_TIMEOUT_S.
#   send-nudge       payload: {identity, action: "send-nudge", target: "<other identity>", body}
#                    Refuses if target isn't in this identity's send-nudge allowlist. Posts into the
#                    target identity's own home room via @hermes-ops-ctl, same m.mentions-required
#                    pattern hermes-buzz-watch.sh 1.2.0 already found necessary for these rooms.
#
# Throttle (direct request: "no more than three successive attempts, then email + FleetOps") is
# tracked here, not by the calling persona — a local per-target state file, same precedent as
# hermes-buzz-watch.sh's own THROTTLE_NOTICE_FILE, not a broker query. Attempt count resets to 0
# only on a report of real, confirmed health; three attempts that each still end unhealthy escalates
# instead of trying a fourth, and stays escalated (no further silent retries) until a human resets it
# by deleting the state file or the target reports healthy through some other path.
#
# Config, all from the environment (mirrors hermes-model-wake-worker.py's own):
#   BROKER_URL           default http://10.129.1.15:8100
#   BROKER_TOKEN         required
#   WORKER_NAME          default <hostname>
#   JOB_TYPE             required — "remediate-sintra" or "remediate-amy", selects the allowlist section
#   POLL_SECONDS         default 5
#   RESTART_TIMEOUT_S    default 30 — real restarts observed live this session: a few seconds each
#   MAX_ATTEMPTS         default 3
#   REMEDIATE_STATE_DIR  default ~/.hermes/state/remediate
#   ALLOWLIST_PATH       default ~/HermesAgentV5/infra/hermes-remediate/allowlist.json
#   MATRIX_HOMESERVER    default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN / FLEETOPS_ROOM   for the FleetOps escalation notice
#   OPS_CTL_TOKEN                            for both the send-nudge action and email-adjacent alerts
#   NOTIFY_EMAIL         default notifications@canislupisnc.net
#
# Deliberately boring: stdlib only, same as every other worker in this fleet.

import json
import os
import smtplib
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.mime.text import MIMEText
from pathlib import Path

BROKER_URL = os.environ.get("BROKER_URL", "http://10.129.1.15:8100").rstrip("/")
TOKEN = os.environ.get("BROKER_TOKEN", "")
WORKER = os.environ.get("WORKER_NAME", socket.gethostname())
JOB_TYPE = os.environ.get("JOB_TYPE", "")
POLL = int(os.environ.get("POLL_SECONDS", "5"))
RESTART_TIMEOUT_S = int(os.environ.get("RESTART_TIMEOUT_S", "30"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
STATE_DIR = Path(os.environ.get("REMEDIATE_STATE_DIR", str(Path.home() / ".hermes" / "state" / "remediate")))
ALLOWLIST_PATH = Path(os.environ.get(
    "ALLOWLIST_PATH", str(Path.home() / "HermesAgentV5" / "infra" / "hermes-remediate" / "allowlist.json")))

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")
OPS_CTL_TOKEN = os.environ.get("OPS_CTL_TOKEN", "")
NOTIFY_EMAIL = os.environ.get("NOTIFY_EMAIL", "notifications@canislupisnc.net")
EMAIL_FROM = os.environ.get("EMAIL_FROM", "mercury@canislupisnc.net")
EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")  # EMAIL_FROM's own SMTP password

HOME_ROOMS = {"sintra": "!teSvzXTJKwZyuh8QK8:spark", "amy": "!KvSV6SCscjEO8QWjuP:spark"}

if not JOB_TYPE.startswith("remediate-"):
    sys.exit(f"JOB_TYPE must be 'remediate-<identity>', got {JOB_TYPE!r}")
IDENTITY = JOB_TYPE.split("-", 1)[1]


def log(msg):
    print(f"[hermes-remediate-worker:{JOB_TYPE}] {msg}", flush=True)


def load_allowlist():
    with open(ALLOWLIST_PATH) as f:
        data = json.load(f)
    return data.get(IDENTITY, {})


def request(method, path, data=None, headers=None):
    req = urllib.request.Request(
        f"{BROKER_URL}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as resp:
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


def state_file(action, target):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    safe = target.replace("/", "_")
    return STATE_DIR / f"{action}-{safe}.json"


def load_attempts(action, target):
    f = state_file(action, target)
    if not f.exists():
        return 0
    try:
        return json.loads(f.read_text()).get("attempts", 0)
    except Exception:
        return 0


def save_attempts(action, target, attempts):
    state_file(action, target).write_text(json.dumps({"attempts": attempts, "at": time.time()}))


def clear_attempts(action, target):
    f = state_file(action, target)
    if f.exists():
        f.unlink()


def matrix_notice(text):
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        log(f"no FleetOps credentials — cannot post notice: {text}")
        return
    try:
        txn = f"remediate-note-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"FleetOps notice failed: {exc}")


def send_email(subject, body):
    if not EMAIL_PASSWORD:
        log("no EMAIL_PASSWORD — cannot send escalation email")
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = NOTIFY_EMAIL
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, EMAIL_PASSWORD)
            server.send_message(msg)
    except Exception as exc:
        log(f"escalation email failed: {exc}")


def escalate(action, target, detail):
    text = (f"[hermes-remediate] {IDENTITY}: {action} on {target!r} still unhealthy after "
            f"{MAX_ATTEMPTS} attempts — giving up automatically, needs a human. {detail}")
    matrix_notice(text)
    send_email(f"[Hermes Remediate] {IDENTITY}/{action}/{target} needs attention", text)
    log(f"ESCALATED: {text}")


def do_restart_service(target, allowed):
    if target not in allowed:
        return 2, f"{target!r} is not in {IDENTITY}'s restart-service allowlist"
    attempts = load_attempts("restart-service", target)
    if attempts >= MAX_ATTEMPTS:
        escalate("restart-service", target, "refusing further attempts until reset")
        return 1, f"already at {attempts} attempts for {target}, escalated instead of retrying"

    proc = subprocess.run(["sudo", "systemctl", "restart", target], capture_output=True, text=True)
    if proc.returncode != 0:
        attempts += 1
        save_attempts("restart-service", target, attempts)
        detail = f"sudo systemctl restart {target} itself failed: {(proc.stderr or '').strip()[:400]}"
        if attempts >= MAX_ATTEMPTS:
            escalate("restart-service", target, detail)
        return 1, detail

    deadline = time.monotonic() + RESTART_TIMEOUT_S
    while time.monotonic() < deadline:
        check = subprocess.run(["systemctl", "is-active", "--quiet", target])
        if check.returncode == 0:
            clear_attempts("restart-service", target)
            return 0, ""
        time.sleep(2)

    attempts += 1
    save_attempts("restart-service", target, attempts)
    detail = f"{target} did not report active within {RESTART_TIMEOUT_S}s of restart (attempt {attempts}/{MAX_ATTEMPTS})"
    if attempts >= MAX_ATTEMPTS:
        escalate("restart-service", target, detail)
    return 1, detail


def do_send_nudge(target, body, allowed):
    if target not in allowed:
        return 2, f"{target!r} is not in {IDENTITY}'s send-nudge allowlist"
    room = HOME_ROOMS.get(target)
    if not room or not OPS_CTL_TOKEN:
        return 1, f"no home room or ops-ctl token configured for nudging {target}"
    text = body or f"SYSTEM (remediate, automated): {IDENTITY} asked me to check in with you — see Buzz for details."
    try:
        txn = f"remediate-nudge-{int(time.time() * 1000)}"
        room_enc = urllib.parse.quote(room)
        mxid = f"@{target}:spark"
        payload = json.dumps({"msgtype": "m.text", "body": text, "m.mentions": {"user_ids": [mxid]}}).encode()
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/{room_enc}/send/m.room.message/{txn}",
            data=payload, method="PUT",
            headers={"Authorization": f"Bearer {OPS_CTL_TOKEN}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return 0, ""
    except Exception as exc:
        return 1, f"nudge post failed: {exc}"


def run_job(job):
    payload = job.get("payload") or {}
    action = payload.get("action", "")
    target = payload.get("target", "")
    allowlist = load_allowlist()

    if action == "restart-service":
        return do_restart_service(target, allowlist.get("restart-service", []))
    if action == "send-nudge":
        return do_send_nudge(target, payload.get("body", ""), allowlist.get("send-nudge", []))
    return 2, f"unknown remediate action {action!r} — expected restart-service or send-nudge"


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
    if not ALLOWLIST_PATH.exists():
        sys.exit(f"allowlist not found at {ALLOWLIST_PATH}")
    log(f"polling {BROKER_URL} every {POLL}s as '{WORKER}' for type='{JOB_TYPE}' jobs "
        f"(identity={IDENTITY}, max_attempts={MAX_ATTEMPTS})")
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
