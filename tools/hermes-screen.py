#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-screen — an on-demand text-classification utility, exposed as a Buzz-callable service.
# Owns the Buzz `screen` topic, reserved since S6 with no real subscriber until now.
#
# **Not the mandatory pre-dispatch security gate target §8.2 describes.** That gate already
# exists, twice over: inline in hermes-router.py (a stopgap, since presenter didn't exist until
# S7) and inline in hermes-dispatch.py's own screen() (the real one — text is screened before
# choose_topic() is ever called, i.e. before routing, exactly what §8.2 requires). By
# construction, nothing can reach this agent's `screen` topic without already having passed
# through dispatch's own inline screen first — a Buzz-dispatched "screen" topic is structurally
# downstream of the routing decision §8.2 exists to protect, so it cannot be that gate. What it
# can be, consistent with `screen` sitting in hermes-dispatch.py's own VALID_TARGETS alongside
# `code`/`vision`/`retrieve`, is a narrower on-demand utility: "classify this specific piece of
# text for me" — e.g. for a future caller wanting to check an uploaded file, a pasted blob, or
# retrieved content (target §8.3's scope items) without re-implementing the check inline.
#
# Thin bridge to the exact same L1+L2 machinery every other specialist already runs inline
# (hermes-dispatch.py's screen(), hermes-media.py's/hermes-logs.py's screen_request()) — this
# agent doesn't re-implement classification, it returns the verdict as its answer instead of only
# using it to gate its own next step.
#
# Config, all from the environment (injected by hermes-screen-wrapper.sh):
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN, GUARD_URL/GUARD_TOKEN — same as
#   hermes-dispatch.py/hermes-logs.py/hermes-media.py
#   POLL_SECONDS    default 5
#   CLAIMANT        default "hermes-screen"

import json
import os
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
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
CLAIMANT = os.environ.get("CLAIMANT", "hermes-screen")


def log(msg):
    print(f"[hermes-screen] {msg}", flush=True)


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
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
        payload = {"id": task_id, "agent": "screen", "state": state}
        if topic:
            payload["topic"] = topic
        _post(f"{MEMORY_URL}/tasks", payload, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_guard_verdict(layer, severity_value, detail):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": "guard-log", "agent": "guard", "role": "system",
            "raw": json.dumps({"node": "screen", "layer": layer, "severity": severity_value, **detail}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"guard verdict logging failed: {exc}")


def classify(text):
    """Same shape as hermes-dispatch.py's own screen(), but returns the full verdict instead of
    just a bool — this agent's whole job is producing that verdict, not gating on it."""
    verdict = {"verdict": "clean", "layer1_categories": [], "layer2_label": None, "layer2_score": None}

    hits = hermes_injection_guard.scan_messages([{"role": "user", "content": text}])
    severity = hermes_injection_guard.overall_severity(hits)
    categories = sorted({cat for r in hits for cat in r["hits"]})
    verdict["layer1_categories"] = categories

    if severity == "block":
        log(f"Layer 1 verdict BLOCKED: categories={categories}")
        log_guard_verdict("L1", "block", {"categories": categories})
        verdict["verdict"] = "blocked"
        return verdict
    if severity == "flag":
        log_guard_verdict("L1", "flag", {"categories": categories})
        verdict["verdict"] = "flagged"

    if GUARD_TOKEN:
        try:
            l2 = _post(f"{GUARD_URL}/classify", {"text": text}, GUARD_TOKEN, timeout=10)
            verdict["layer2_label"] = l2.get("label")
            verdict["layer2_score"] = l2.get("score")
            if l2.get("hit"):
                log(f"Layer 2 verdict BLOCKED: score={l2.get('score'):.3f}")
                log_guard_verdict("L2", "block", {"label": l2.get("label"), "score": l2.get("score")})
                verdict["verdict"] = "blocked"
        except Exception as exc:
            log(f"Layer 2 unreachable, verdict based on Layer 1 alone: {exc}")

    return verdict


def publish_result(task_id, memory_ref, ok, message):
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "screen", "role": "assistant",
        "raw": message, "presented": message,
    }, MEMORY_TOKEN)
    set_task_state(task_id, "done" if ok else "error")
    _post(f"{BUZZ_URL}/messages", {
        "from": "screen", "topic": "results", "task_id": task_id,
        "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)


def process_one():
    claim = claim_next("screen")
    if not claim:
        return False

    claim_id = claim["id"]
    msg = claim["message"]
    task_id, memory_ref = msg.get("task_id"), msg.get("memory_ref")

    if not task_id:
        log(f"claim {claim_id}: message has no task_id — acking and dropping")
        ack_claim(claim_id)
        return True

    text = fetch_raw_text(task_id, memory_ref)
    if not text:
        log(f"claim {claim_id}: task {task_id!r} has no raw text — acking and dropping")
        ack_claim(claim_id)
        set_task_state(task_id, "error-no-content")
        return True

    ack_claim(claim_id)  # ack immediately — classification is fast, no long-running work here
    set_task_state(task_id, "classifying", topic="screen")
    log(f"claim {claim_id}: task {task_id!r} -> classifying ({len(text)} chars)")

    try:
        verdict = classify(text)
    except Exception as exc:
        log(f"task {task_id!r}: classify failed: {exc}")
        publish_result(task_id, memory_ref, False, f"Classification failed: {exc}")
        return True

    publish_result(task_id, memory_ref, True, json.dumps(verdict))
    log(f"task {task_id!r}: verdict published: {verdict['verdict']}")
    return True


def main():
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")
    if not GUARD_TOKEN:
        log("WARNING: GUARD_TOKEN not set — Layer 2 classification is skipped, verdicts are Layer 1 only")
    log(f"watching Buzz topic 'screen', polling every {POLL_SECONDS}s")
    while True:
        try:
            did_work = process_one()
        except Exception as exc:
            log(f"unhandled error this cycle, continuing: {exc}")
            did_work = False
        if not did_work:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
