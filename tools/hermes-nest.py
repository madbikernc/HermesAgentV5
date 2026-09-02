#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-09-02) — real bug found live on first deploy: pubsub_listener()'s
# google-cloud-pubsub import used to sit outside its own retry loop, so hermes-nest-wrapper.sh
# 1.0.0 running this whole process under the system Python (missing that package) silently killed
# the entire background thread on first startup — the on-demand Buzz path kept working with no
# visible sign the motion-trigger path was dead. Fixed the wrapper (now execs
# /opt/hermes/venvs/nest/bin/python3, the same venv hermes-nest-framegrab.py already used) and
# moved the import inside pubsub_listener()'s try block so any future startup failure gets the
# same log-and-retry treatment as every other failure mode there, instead of a second, silently
# fatal failure shape.
#
"""
hermes-nest — Nest/Google Home camera specialist. Owns the Buzz `nest` topic AND runs an
independent Google Cloud Pub/Sub subscriber for CameraMotion/CameraPerson events — two trigger
paths feeding one shared capture pipeline (run_capture()): negotiate the camera's WebRTC live
stream, pull one decoded frame (tools/hermes-nest-framegrab.py, an isolated subprocess — see its
own docstring for why), describe it via `omni` using the exact image_url data-URI pattern
hermes-media.py's evaluate_image() already proved live.

Direct request (2026-09-01): "does the fleet have sufficient capability to trigger off camera
motion or camera person, trigger camera Livestream, and strip out a frame for analysis?" — none of
the three pieces existed; this is that build.

Two trigger paths:

1. On-demand (Buzz claim), same async-nothing-blocks-anything shape as hermes-probe.py's
   process_new_claim()/in_flight/check_in_flight() (though captures here are seconds, not minutes —
   still async because a WebRTC negotiation is exactly the kind of external, network-dependent
   operation that shouldn't block a poll loop). Delivered to Matrix via the presenter's existing
   check_outstanding() path — no presenter changes needed beyond its own NEST_TASK_TIMEOUT_SECONDS
   override (hermes-presenter.py).

2. Motion-triggered (Pub/Sub), a background thread (same "runs independently of the main loop"
   shape as hermes-vault-agent.py's refresh_loop) using google-cloud-pubsub's streaming pull with a
   callback. The callback does the minimum possible work — parse the event, ack the Pub/Sub message
   immediately (never block Google's redelivery clock on this fleet's own processing time, same
   "ack immediately, work happens after" reasoning every other async specialist here already
   uses), and put a job descriptor on a queue.Queue. The main loop drains that queue exactly like it
   drains new Buzz claims, sharing MAX_CONCURRENT_CAPTURES and the in_flight tracking dict with the
   on-demand path.

   Scoping decision, confirmed with the operator (2026-09-01): this path delivers over EMAIL,
   reusing hermes-model-watch.py's exact send_email() pattern — the fleet has no existing mechanism
   for a specialist to push an unprompted message into the Matrix room (the presenter only replies
   to a room-originated request it's already tracking), and building that was explicitly ruled out
   of scope for this round. On-demand asks still answer normally in Matrix.

   Per-device cooldown (COOLDOWN_SECONDS_PER_DEVICE): motion can fire continuously, and each
   capture is a real, rate-limited SDM API call. The cooldown timestamp is written the moment a
   job is ACCEPTED into in_flight (not on completion) — a second motion event arriving mid-capture
   must not queue a second capture either. Persisted in hermes-memory's agent_state (agent="nest",
   key=f"device:{device_id}") so it survives a restart — same GET /state/<agent> list+filter
   pattern hermes-presenter.py's continuity code already uses (not the single-key
   GET /state/<agent>/<key> route — that route never percent-decodes its path segments, a real
   footgun documented at hermes-presenter.py's get_room_conv_state(); this file's keys don't
   contain unsafe characters today, but there's no reason to depend on that never changing).

Config, all from the environment (injected by hermes-nest-wrapper.sh):
  BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN, GUARD_URL/GUARD_TOKEN — same as every specialist
  ROUTER_URL              default http://127.0.0.1:8080 — this agent runs on Forge (spark-2),
                          co-resident with `omni`, same placement reasoning hermes-media.py
                          documents (avoids a cross-node hop for the vision-model call)
  POLL_SECONDS            default 5
  NEST_TIMEOUT_SECONDS    default 60 — hard-kill budget for the framegrab subprocess. UNVERIFIED
                          placeholder; must be corrected from a real measured cost (see
                          hermes-nest-framegrab.py's own docstring and
                          infra/hermes-nest/README.md's Verification section) before this is
                          trusted the way PROBE_TIMEOUT_SECONDS was after real measurement.
  MAX_CONCURRENT_CAPTURES default 1 — WebRTC stream negotiation is a real per-account rate-limited
                          SDM API resource, same conservative-by-default posture
                          MAX_CONCURRENT_PROBES already established for nmap
  COOLDOWN_SECONDS_PER_DEVICE default 120
  CLAIMANT                default "hermes-nest"
  FRAMEGRAB_PYTHON        default /opt/hermes/venvs/nest/bin/python3
  PUBSUB_ENABLED          default "1" — set "0" to run the on-demand Buzz path alone (e.g. before
                          the GCP Pub/Sub side of setup is complete)
"""

import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_injection_guard  # noqa: E402
import hermes_nest_common  # noqa: E402

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
GUARD_URL = os.environ.get("GUARD_URL", f"http://{SPARK_IP}:8096").rstrip("/")
GUARD_TOKEN = os.environ.get("GUARD_TOKEN", "")
ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")

POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
NEST_TIMEOUT_SECONDS = int(os.environ.get("NEST_TIMEOUT_SECONDS", "60"))
MAX_CONCURRENT_CAPTURES = int(os.environ.get("MAX_CONCURRENT_CAPTURES", "1"))
COOLDOWN_SECONDS_PER_DEVICE = int(os.environ.get("COOLDOWN_SECONDS_PER_DEVICE", "120"))
CLAIMANT = os.environ.get("CLAIMANT", "hermes-nest")
FRAMEGRAB_PYTHON = os.environ.get("FRAMEGRAB_PYTHON", "/opt/hermes/venvs/nest/bin/python3")
PUBSUB_ENABLED = os.environ.get("PUBSUB_ENABLED", "1") == "1"

REPO_DIR = Path(__file__).resolve().parent.parent
FRAMEGRAB_SCRIPT = str(REPO_DIR / "tools" / "hermes-nest-framegrab.py")

# Reused verbatim from hermes-model-watch.py's send_email() — same sending identity, same
# vault item for the SMTP account password.
SMTP_HOST = "mail.hover.com"
SMTP_PORT = 587
SMTP_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

DESCRIBE_SYSTEM_PROMPT = (
    "You are looking at one frame from a home security camera. Describe factually what's visible "
    "-- people, vehicles, animals, packages, notable activity or lack of it. Do not speculate about "
    "identity, intent, or anything not actually visible in the frame. One or two sentences."
)

MOTION_TRAITS = {
    "sdm.devices.events.CameraMotion.Motion": "motion detected",
    "sdm.devices.events.CameraPerson.Person": "person detected",
}


def log(msg):
    print(f"[hermes-nest] {msg}", flush=True)


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


# ── Buzz plumbing (identical shape to hermes-probe.py) ──────────────────────

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
        payload = {"id": task_id, "agent": "nest", "state": state}
        if topic:
            payload["topic"] = topic
        _post(f"{MEMORY_URL}/tasks", payload, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_guard_verdict(layer, severity_value, detail):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": "guard-log", "agent": "guard", "role": "system",
            "raw": json.dumps({"node": "nest", "layer": layer, "severity": severity_value, **detail}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"guard verdict logging failed: {exc}")


def screen(text):
    hits = hermes_injection_guard.scan_messages([{"role": "user", "content": text}])
    severity = hermes_injection_guard.overall_severity(hits)
    if severity == "block":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log(f"Layer 1 BLOCKED nest request: categories={categories}")
        log_guard_verdict("L1", "block", {"categories": categories})
        return False
    if severity == "flag":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log_guard_verdict("L1", "flag", {"categories": categories})

    if GUARD_TOKEN:
        try:
            verdict = _post(f"{GUARD_URL}/classify", {"text": text}, GUARD_TOKEN, timeout=10)
            if verdict.get("hit"):
                log(f"Layer 2 BLOCKED nest request: score={verdict['score']:.3f}")
                log_guard_verdict("L2", "block", {"label": verdict["label"], "score": verdict["score"]})
                return False
        except Exception as exc:
            log(f"Layer 2 unreachable, proceeding on Layer 1 alone: {exc}")
    return True


def publish_result(task_id, memory_ref, ok, message):
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "nest", "role": "assistant",
        "raw": message, "presented": message,
    }, MEMORY_TOKEN)
    set_task_state(task_id, "done" if ok else "error")
    _post(f"{BUZZ_URL}/messages", {
        "from": "nest", "topic": "results", "task_id": task_id,
        "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)


# ── cooldown state (hermes-memory agent_state, list+filter — see module docstring) ──────────────

def get_last_capture(device_id):
    try:
        entries = _get(f"{MEMORY_URL}/state/nest", MEMORY_TOKEN).get("state", [])
    except Exception as exc:
        log(f"could not read cooldown state, proceeding as if no cooldown active: {exc}")
        return 0
    for e in entries:
        if e["key"] == f"device:{device_id}":
            return e.get("value", {}).get("last_capture", 0)
    return 0


def set_last_capture(device_id, epoch):
    try:
        _post(f"{MEMORY_URL}/state",
              {"agent": "nest", "key": f"device:{device_id}", "value": {"last_capture": epoch}},
              MEMORY_TOKEN)
    except Exception as exc:
        log(f"could not persist cooldown state (non-fatal): {exc}")


# ── vision analysis (same image_url data-URI pattern hermes-media.py's evaluate_image() proved live) ──

def describe_frame(image_path):
    import base64
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    body = {
        "model": "omni",
        "messages": [
            {"role": "system", "content": DESCRIBE_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ]},
        ],
        "max_tokens": 200,
    }
    result = _post(f"{ROUTER_URL}/v1/chat/completions", body, timeout=60)
    return result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()


# ── email delivery for the motion-triggered path (direct port of hermes-model-watch.py's send_email) ──

def _vault_get(item, field):
    vault_get_script = str(REPO_DIR / "tools" / "vault-get-secret.sh")
    for _ in range(2):
        try:
            result = subprocess.run([vault_get_script, item, field], capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


def send_email(subject, body):
    import smtplib
    from email.mime.text import MIMEText

    password = _vault_get("email-sintra", "password")
    if not password:
        log("ERROR: could not fetch email-sintra password from vault — alert not sent")
        return False

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
            server.starttls()
            server.login(SMTP_FROM, password)
            server.send_message(msg)
        return True
    except Exception as exc:
        log(f"ERROR: email send failed: {exc}")
        return False


# ── device resolution from free-text chat (agent-specific NLP-ish matching — see
#    hermes_nest_common.find_device() for the precise-query CLI-style counterpart) ──────────────

def resolve_device_from_text(text):
    devices = hermes_nest_common.list_devices()
    text_l = text.lower()
    matches = [d for d in devices if hermes_nest_common.device_display_name(d).lower() in text_l]
    if not matches:
        available = ", ".join(hermes_nest_common.device_display_name(d) for d in devices) or "(none registered)"
        raise RuntimeError(f"I couldn't tell which camera you mean. Available: {available}")
    if len(matches) > 1:
        names = ", ".join(hermes_nest_common.device_display_name(d) for d in matches)
        raise RuntimeError(f"That could match more than one camera ({names}) — be more specific")
    d = matches[0]
    return d["name"], hermes_nest_common.device_display_name(d)


# ── shared capture execution (launched by both trigger paths) ───────────────

def launch_framegrab(device_name):
    """Same detach-and-track shape as hermes-probe.py's launch_probe(): own process group so
    NEST_TIMEOUT_SECONDS can take the whole tree down, stdout to a temp file (not PIPE, to avoid
    the classic deadlock)."""
    out_png = tempfile.NamedTemporaryFile(prefix="nest-frame-", suffix=".png", delete=False).name
    log_path = tempfile.NamedTemporaryFile(prefix="nest-framegrab-", suffix=".log", delete=False).name
    f = open(log_path, "w")
    proc = subprocess.Popen(
        [FRAMEGRAB_PYTHON, FRAMEGRAB_SCRIPT, device_name, out_png],
        stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    f.close()
    return proc, out_png, log_path


def _cleanup(job):
    for path in (job.get("out_png"), job.get("log_path")):
        try:
            if path:
                os.remove(path)
        except OSError:
            pass


def start_capture(in_flight, device_name, device_label, kind, **extra):
    """Common acceptance path for both triggers: launches the subprocess, records the cooldown
    timestamp immediately (see module docstring on why this happens at acceptance, not
    completion), and tracks the job in in_flight."""
    device_id = device_name.rsplit("/", 1)[-1]
    set_last_capture(device_id, time.time())
    proc, out_png, log_path = launch_framegrab(device_name)
    task_key = extra.get("task_id") or f"pubsub-{device_id}-{int(time.time())}"
    in_flight[task_key] = {
        "proc": proc, "out_png": out_png, "log_path": log_path,
        "device_name": device_name, "device_label": device_label,
        "kind": kind, "started_at": time.time(), **extra,
    }
    log(f"capture started for {device_label!r} (kind={kind}), task_key={task_key}")


def finish_capture(task_key, job, rc, killed_reason=None):
    ok = rc == 0 and os.path.exists(job["out_png"]) and os.path.getsize(job["out_png"]) > 0

    if killed_reason:
        description_or_error = killed_reason
        ok = False
    elif ok:
        try:
            description_or_error = describe_frame(job["out_png"])
        except Exception as exc:
            log(f"task {task_key}: describe_frame failed: {exc}")
            description_or_error = f"(captured a frame from {job['device_label']}, but the " \
                                    f"vision model couldn't describe it: {exc})"
    else:
        try:
            with open(job["log_path"]) as f:
                tail = f.read().strip()[-500:]
        except Exception:
            tail = ""
        description_or_error = f"Capture from {job['device_label']} failed (exit {rc}). {tail}"

    if job["kind"] == "buzz":
        message = description_or_error if ok else description_or_error
        publish_result(job["task_id"], job["memory_ref"], ok,
                        f"{job['device_label']}: {message}" if ok else message)
    else:
        subject = f"Nest camera alert — {job['device_label']} ({job['reason']})"
        body = (f"Camera: {job['device_label']}\nTrigger: {job['reason']}\n\n"
                f"{description_or_error if ok else 'Capture failed: ' + description_or_error}")
        if not send_email(subject, body):
            log(f"task {task_key}: capture finished but email delivery failed — result not lost, "
                f"just not delivered ({description_or_error!r})")

    log(f"task {task_key}: capture of {job['device_label']} finished "
        f"({'ok' if ok else 'failed'}) after {time.time() - job['started_at']:.0f}s")
    _cleanup(job)


def check_in_flight(in_flight):
    now = time.time()
    for task_key, job in list(in_flight.items()):
        proc = job["proc"]
        rc = proc.poll()

        if rc is None:
            if now - job["started_at"] > NEST_TIMEOUT_SECONDS:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=10)
                finish_capture(task_key, job, -1,
                                killed_reason=f"Capture of {job['device_label']} did not finish "
                                              f"within {NEST_TIMEOUT_SECONDS}s and was stopped.")
                del in_flight[task_key]
            continue

        finish_capture(task_key, job, rc)
        del in_flight[task_key]


# ── on-demand (Buzz claim) trigger path ──────────────────────────────────────

def process_new_claim(in_flight):
    claim = claim_next("nest")
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

    try:
        device_name, device_label = resolve_device_from_text(request_text)
    except RuntimeError as exc:
        ack_claim(claim_id)
        publish_result(task_id, memory_ref, False, str(exc))
        return True
    except Exception as exc:
        log(f"claim {claim_id}: device lookup failed: {exc}")
        ack_claim(claim_id)
        publish_result(task_id, memory_ref, False,
                        f"Couldn't reach the camera service to look up cameras: {exc}")
        return True

    ack_claim(claim_id)  # ack immediately — real work happens in the background

    if len(in_flight) >= MAX_CONCURRENT_CAPTURES:
        running = ", ".join(job["device_label"] for job in in_flight.values())
        publish_result(task_id, memory_ref, False,
                        f"A camera capture is already in progress ({running}). Try again shortly.")
        return True

    set_task_state(task_id, "capturing", topic="nest")
    start_capture(in_flight, device_name, device_label, "buzz",
                  task_id=task_id, memory_ref=memory_ref)
    return True


# ── motion-triggered (Pub/Sub) trigger path ──────────────────────────────────

def pubsub_listener(job_queue):
    """Background thread, same 'runs independently of the main loop' shape as
    hermes-vault-agent.py's refresh_loop. Wraps the streaming pull in an outer retry loop — a
    dropped connection here must not silently stop watching for motion forever.

    Real bug found live on first deploy (2026-09-02): the google-cloud-pubsub import used to sit
    outside this while loop, at function-entry time. hermes-nest-wrapper.sh 1.0.0 ran this whole
    process under the system Python (missing that package entirely) rather than the venv, so the
    import raised ModuleNotFoundError once and silently killed this entire thread forever -- no
    retry, no further log output, the on-demand Buzz path kept working with no visible sign the
    motion-trigger path was dead. Fixed the wrapper (1.1.0) to use the right venv, but ALSO moved
    the import inside the try block here: any future startup failure (import or otherwise) now
    gets the same log-and-retry-in-60s treatment as every other failure mode in this loop, instead
    of being a second, differently-shaped way for this thread to die silently."""
    while True:
        try:
            from google.cloud import pubsub_v1
            from google.oauth2 import service_account

            sa_json = hermes_nest_common.vault_get("pubsub_service_account_json")
            gcp_project_id = hermes_nest_common.vault_get("gcp_project_id")
            subscription_id = hermes_nest_common.vault_get("pubsub_subscription")
            if not all([sa_json, gcp_project_id, subscription_id]):
                log("Pub/Sub credentials incomplete in vault (need gcp_project_id, "
                    "pubsub_subscription, pubsub_service_account_json) — retrying in 60s")
                time.sleep(60)
                continue

            credentials = service_account.Credentials.from_service_account_info(json.loads(sa_json))
            subscriber = pubsub_v1.SubscriberClient(credentials=credentials)
            subscription_path = subscriber.subscription_path(gcp_project_id, subscription_id)

            def callback(message):
                # Minimum possible work on this callback's own thread: parse, ack, enqueue.
                # Never block Google's redelivery clock on this fleet's own processing time.
                try:
                    payload = json.loads(message.data.decode())
                    resource_update = payload.get("resourceUpdate", {})
                    device_name = resource_update.get("name")
                    events = resource_update.get("events", {})
                    reasons = [label for trait, label in MOTION_TRAITS.items() if trait in events]
                    if device_name and reasons:
                        job_queue.put({"device_name": device_name, "reason": ", ".join(reasons)})
                except Exception as exc:
                    log(f"Pub/Sub callback: could not parse event, dropping: {exc}")
                finally:
                    message.ack()

            log(f"Pub/Sub subscriber starting on {subscription_path}")
            future = subscriber.subscribe(subscription_path, callback=callback)
            future.result()  # blocks until the stream ends/errors
        except Exception as exc:
            log(f"Pub/Sub listener error, reconnecting in 30s: {exc}")
            time.sleep(30)


def process_pubsub_queue(in_flight, job_queue):
    try:
        job = job_queue.get_nowait()
    except queue.Empty:
        return False

    device_name = job["device_name"]
    device_id = device_name.rsplit("/", 1)[-1]
    reason = job["reason"]

    since_last = time.time() - get_last_capture(device_id)
    if since_last < COOLDOWN_SECONDS_PER_DEVICE:
        log(f"motion event for {device_id} dropped — within cooldown "
            f"({since_last:.0f}s < {COOLDOWN_SECONDS_PER_DEVICE}s)")
        return True

    if len(in_flight) >= MAX_CONCURRENT_CAPTURES:
        log(f"motion event for {device_id} dropped — a capture is already in progress")
        return True

    try:
        devices = hermes_nest_common.list_devices()
        match = next((d for d in devices if d["name"] == device_name), None)
        device_label = hermes_nest_common.device_display_name(match) if match else device_id
    except Exception as exc:
        log(f"could not resolve device label for {device_id}, using bare ID: {exc}")
        device_label = device_id

    start_capture(in_flight, device_name, device_label, "pubsub", reason=reason)
    return True


def main():
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")
    if not GUARD_TOKEN:
        log("WARNING: GUARD_TOKEN not set — this agent's own Layer 2 screening is skipped")

    job_queue = queue.Queue()
    if PUBSUB_ENABLED:
        threading.Thread(target=pubsub_listener, args=(job_queue,), daemon=True).start()
    else:
        log("PUBSUB_ENABLED=0 — motion-triggered path disabled, on-demand Buzz path only")

    log(f"watching Buzz topic 'nest', polling every {POLL_SECONDS}s, "
        f"max {MAX_CONCURRENT_CAPTURES} concurrent, timeout {NEST_TIMEOUT_SECONDS}s")

    in_flight = {}
    while True:
        try:
            check_in_flight(in_flight)
            claimed = process_new_claim(in_flight)
            triggered = process_pubsub_queue(in_flight, job_queue) if PUBSUB_ENABLED else False
        except Exception as exc:
            log(f"unhandled error this cycle, continuing: {exc}")
            claimed = triggered = False
        if not claimed and not triggered:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
