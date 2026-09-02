#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-reolink — Reolink camera specialist. Owns the Buzz `reolink` topic (on-demand snapshot +
description via Matrix chat) and runs an AI-detection poll loop (person/vehicle/pet, email-
delivered — same scoping decision already made for tools/hermes-nest.py: no proactive-Matrix-push
mechanism exists in this fleet).

Direct follow-on to the Nest/Google Home build: asked for outdoor/battery/solar-compatible camera
recommendations for this exact "image pull and ID" skill, researched live, and picked Reolink over
UniFi Protect (best local API, but confirmed no official solar accessory for any battery-capable
model) and over Wyze/Nest (both already built this session, both real dead ends for this specific
need — Wyze's own image endpoint confirmed broken, Nest's SDM API has no snapshot trait at all).

**NOT YET LIVE-TESTED — no test unit existed as of writing.** Real, load-bearing difference from
the Nest build: Reolink's local CGI API needs no OAuth, no cloud project, no Pub/Sub — a plain
username/password against the camera's own LAN IP (confirmed from `reolink_aio`'s source: a
`Login` CGI command, token held by the library). No WebRTC negotiation either (Nest's one
genuinely hang-prone piece) — a snapshot is one bounded HTTP call, so no isolated-subprocess
pattern is needed here at all, unlike hermes-nest-framegrab.py.

**The one thing NOT independently confirmed**: the exact public method names `reolink_aio.Host`
exposes for login/snapshot/AI-state (`login()`/`get_snapshot()`/`get_ai_state()` below are the
library's documented CGI command names translated through typical Home-Assistant-integration
naming conventions, not read from the library's own method signatures directly). Confirm these
against the actually-installed version (`python3 -c "from reolink_aio.api import Host; help(Host)"`
in the venv) before trusting this file — see infra/hermes-reolink/README.md's Verification
section, step 1.

Async bridging (the one real structural difference from every other specialist in this fleet):
every existing specialist here is a synchronous `while True: ... time.sleep()` loop using
`urllib`. `reolink_aio` is `async def` throughout, built on one persistent `aiohttp` session per
`Host` object that needs to stay alive for this process's whole life (re-creating it per call would
mean re-logging in every time, defeating the point of holding a session). Rather than rewrite the
simple, already-working Buzz/Memory/omni `urllib` calls as `aiohttp` too, this file's `main()` runs
inside one `asyncio.run()`, uses `asyncio.sleep()` for the poll interval, and wraps each
synchronous HTTP helper in `await asyncio.to_thread(fn, ...)` — the helpers themselves are
untouched copies of hermes-nest.py's own claim_next/ack_claim/fetch_raw_text/etc.

Config, all from the environment (injected by hermes-reolink-wrapper.sh):
  BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN, GUARD_URL/GUARD_TOKEN — same as every specialist
  ROUTER_URL              default http://127.0.0.1:8080 — co-resident with `omni` on Forge
  POLL_SECONDS            default 3 — AI-detection poll cadence; community/Home-Assistant-
                          recommended value (Reolink's own webhook/HTTPS push is documented as
                          unreliable for AI events, polling is the accepted approach)
  COOLDOWN_SECONDS_PER_DEVICE default 120
  CLAIMANT                default "hermes-reolink"
"""

import asyncio
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_injection_guard  # noqa: E402

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
GUARD_URL = os.environ.get("GUARD_URL", f"http://{SPARK_IP}:8096").rstrip("/")
GUARD_TOKEN = os.environ.get("GUARD_TOKEN", "")
ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")

POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "3"))
COOLDOWN_SECONDS_PER_DEVICE = int(os.environ.get("COOLDOWN_SECONDS_PER_DEVICE", "120"))
CLAIMANT = os.environ.get("CLAIMANT", "hermes-reolink")

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_GET = str(REPO_DIR / "tools" / "vault-get-secret.sh")
REOLINK_ITEM = "Hermes Reolink"

AI_LABELS = ("people", "vehicle", "dog_cat")

DESCRIBE_SYSTEM_PROMPT = (
    "You are looking at one frame from a home security camera. Describe factually what's visible "
    "-- people, vehicles, animals, packages, notable activity or lack of it. Do not speculate about "
    "identity, intent, or anything not actually visible in the frame. One or two sentences."
)

SMTP_HOST = "mail.hover.com"
SMTP_PORT = 587
SMTP_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"


def log(msg):
    print(f"[hermes-reolink] {msg}", flush=True)


# ── vault plumbing ────────────────────────────────────────────────────────

def _vault_get(item, field):
    for _ in range(2):
        try:
            result = subprocess.run([VAULT_GET, item, field], capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


def load_camera_config():
    host = _vault_get(REOLINK_ITEM, "host")
    port = _vault_get(REOLINK_ITEM, "port") or "443"
    username = _vault_get(REOLINK_ITEM, "username")
    password = _vault_get(REOLINK_ITEM, "password")
    channel = int(_vault_get(REOLINK_ITEM, "channel") or "0")
    if not all([host, username, password]):
        sys.exit(f"ERROR: incomplete config in vault item '{REOLINK_ITEM}' (need host, username, password)")
    return host, int(port), username, password, channel


# ── plain HTTP helpers (unchanged copies of hermes-nest.py's own — kept sync deliberately, see
#    module docstring's Async bridging section) ──────────────────────────────────────────────────

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
        payload = {"id": task_id, "agent": "reolink", "state": state}
        if topic:
            payload["topic"] = topic
        _post(f"{MEMORY_URL}/tasks", payload, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_guard_verdict(layer, severity_value, detail):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": "guard-log", "agent": "guard", "role": "system",
            "raw": json.dumps({"node": "reolink", "layer": layer, "severity": severity_value, **detail}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"guard verdict logging failed: {exc}")


def screen(text):
    hits = hermes_injection_guard.scan_messages([{"role": "user", "content": text}])
    severity = hermes_injection_guard.overall_severity(hits)
    if severity == "block":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log(f"Layer 1 BLOCKED reolink request: categories={categories}")
        log_guard_verdict("L1", "block", {"categories": categories})
        return False
    if severity == "flag":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log_guard_verdict("L1", "flag", {"categories": categories})

    if GUARD_TOKEN:
        try:
            verdict = _post(f"{GUARD_URL}/classify", {"text": text}, GUARD_TOKEN, timeout=10)
            if verdict.get("hit"):
                log(f"Layer 2 BLOCKED reolink request: score={verdict['score']:.3f}")
                log_guard_verdict("L2", "block", {"label": verdict["label"], "score": verdict["score"]})
                return False
        except Exception as exc:
            log(f"Layer 2 unreachable, proceeding on Layer 1 alone: {exc}")
    return True


def publish_result(task_id, memory_ref, ok, message):
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "reolink", "role": "assistant",
        "raw": message, "presented": message,
    }, MEMORY_TOKEN)
    set_task_state(task_id, "done" if ok else "error")
    _post(f"{BUZZ_URL}/messages", {
        "from": "reolink", "topic": "results", "task_id": task_id,
        "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)


def get_last_capture(channel):
    try:
        entries = _get(f"{MEMORY_URL}/state/reolink", MEMORY_TOKEN).get("state", [])
    except Exception as exc:
        log(f"could not read cooldown state, proceeding as if no cooldown active: {exc}")
        return 0
    for e in entries:
        if e["key"] == f"device:{channel}":
            return e.get("value", {}).get("last_capture", 0)
    return 0


def set_last_capture(channel, epoch):
    try:
        _post(f"{MEMORY_URL}/state",
              {"agent": "reolink", "key": f"device:{channel}", "value": {"last_capture": epoch}},
              MEMORY_TOKEN)
    except Exception as exc:
        log(f"could not persist cooldown state (non-fatal): {exc}")


def describe_frame(image_bytes):
    b64 = base64.b64encode(image_bytes).decode("ascii")
    body = {
        "model": "omni",
        "messages": [
            {"role": "system", "content": DESCRIBE_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ]},
        ],
        "max_tokens": 200,
    }
    result = _post(f"{ROUTER_URL}/v1/chat/completions", body, timeout=60)
    return result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()


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


# ── camera calls (the genuinely async half — see module docstring's naming caveat) ───────────────

async def camera_login(host_obj):
    await host_obj.login()


async def camera_snapshot(host_obj, channel):
    return await host_obj.get_snapshot(channel)


async def camera_ai_state(host_obj, channel):
    return await host_obj.get_ai_state(channel)


# ── on-demand (Buzz claim) trigger path ──────────────────────────────────────

async def process_new_claim(host_obj, channel):
    claim = await asyncio.to_thread(claim_next, "reolink")
    if not claim:
        return False

    claim_id = claim["id"]
    msg = claim["message"]
    task_id, memory_ref = msg.get("task_id"), msg.get("memory_ref")

    if not task_id:
        log(f"claim {claim_id}: message has no task_id — acking and dropping")
        await asyncio.to_thread(ack_claim, claim_id)
        return True

    request_text = await asyncio.to_thread(fetch_raw_text, task_id, memory_ref)
    if not request_text:
        log(f"claim {claim_id}: task {task_id!r} has no raw text — acking and dropping")
        await asyncio.to_thread(ack_claim, claim_id)
        await asyncio.to_thread(set_task_state, task_id, "error-no-content")
        return True

    if not await asyncio.to_thread(screen, request_text):
        await asyncio.to_thread(set_task_state, task_id, "blocked")
        await asyncio.to_thread(ack_claim, claim_id)
        await asyncio.to_thread(publish_result, task_id, memory_ref, False,
                                 "This request was rejected by the fleet's screening layer.")
        return True

    await asyncio.to_thread(ack_claim, claim_id)  # ack immediately, real work follows

    try:
        image_bytes = await camera_snapshot(host_obj, channel)
        description = await asyncio.to_thread(describe_frame, image_bytes)
        await asyncio.to_thread(publish_result, task_id, memory_ref, True, description)
    except Exception as exc:
        log(f"claim {claim_id}: snapshot/describe failed: {exc}")
        await asyncio.to_thread(publish_result, task_id, memory_ref, False,
                                 f"Couldn't pull a snapshot from the camera: {exc}")
    return True


# ── AI-detection polling path ─────────────────────────────────────────────────

_last_ai_state = {}


async def check_ai_detection(host_obj, channel):
    try:
        state = await camera_ai_state(host_obj, channel)
    except Exception as exc:
        log(f"AI-state poll failed: {exc}")
        return

    prev = _last_ai_state.get(channel, {})
    rising = [label for label in AI_LABELS if state.get(label) and not prev.get(label)]
    _last_ai_state[channel] = dict(state)
    if not rising:
        return

    since_last = time.time() - await asyncio.to_thread(get_last_capture, channel)
    if since_last < COOLDOWN_SECONDS_PER_DEVICE:
        log(f"detection ({', '.join(rising)}) dropped — within cooldown "
            f"({since_last:.0f}s < {COOLDOWN_SECONDS_PER_DEVICE}s)")
        return

    await asyncio.to_thread(set_last_capture, channel, time.time())
    reason = ", ".join(rising)
    log(f"detection rising edge: {reason} — capturing")
    try:
        image_bytes = await camera_snapshot(host_obj, channel)
        description = await asyncio.to_thread(describe_frame, image_bytes)
        body = f"Trigger: {reason}\n\n{description}"
    except Exception as exc:
        log(f"detection capture failed: {exc}")
        body = f"Trigger: {reason}\n\nCapture failed: {exc}"

    ok = await asyncio.to_thread(send_email, f"Reolink camera alert — {reason}", body)
    if not ok:
        log("detection email delivery failed — result not lost, just not delivered")


async def async_main():
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")
    if not GUARD_TOKEN:
        log("WARNING: GUARD_TOKEN not set — this agent's own Layer 2 screening is skipped")

    from reolink_aio.api import Host

    cam_host, cam_port, cam_user, cam_pass, channel = await asyncio.to_thread(load_camera_config)
    host_obj = Host(cam_host, cam_user, cam_pass, port=cam_port)
    await camera_login(host_obj)
    log(f"logged into Reolink camera at {cam_host}:{cam_port} (channel {channel}), "
        f"watching Buzz topic 'reolink', AI-poll every {POLL_SECONDS}s")

    try:
        while True:
            try:
                await check_ai_detection(host_obj, channel)
                claimed = await process_new_claim(host_obj, channel)
            except Exception as exc:
                log(f"unhandled error this cycle, continuing: {exc}")
                claimed = False
            if not claimed:
                await asyncio.sleep(POLL_SECONDS)
    finally:
        try:
            await host_obj.logout()
        except Exception:
            pass


def main():
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
