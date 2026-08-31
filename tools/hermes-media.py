#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-08-30) — target §9.2's generate->evaluate->regenerate loop, the co-resident half
# ("Can loop with the co-resident vision evaluator: generate -> evaluate -> regenerate"),
# deliberately not built at S10 (IMPLEMENTATION_PLAN.md: "no consumer for that loop exists yet").
# Synchronous and direct, same reasoning hermes-dispatch.py already established for calling
# `super`/`coder` without a Buzz round-trip -- not a separate Buzz `vision` topic/agent, which
# would be structurally the wrong shape for a co-resident loop and would need its own results-
# watcher this agent doesn't have. Confirmed live before writing any of this: `omni` genuinely
# sees and accurately describes a real generated image via the router's OpenAI-compatible proxy
# (model: "omni", standard image_url data-URI content block, ~3s). The one real gap was moving
# the artifact bytes at all -- this agent runs on Forge (spark-2), the broker's ARTIFACT_DIR is a
# LUKS-mounted path on Watch (spark), and no route existed to serve those bytes remotely;
# hermes-broker.py 1.3.0 added GET /jobs/{id}/artifact for exactly this. Regeneration is bounded
# to MAX_REGENERATE_ATTEMPTS (default 1) -- never an unbounded loop. Evaluation is fail-open:
# any exception evaluating just delivers the image unevaluated (same posture every other
# best-effort step in this fleet takes); a *regenerated* job dying is different and does fail the
# task, since there is then no image left to deliver at all. No new screening added for the image
# bytes themselves -- hermes-render-worker.py already does real magic-byte/size screening on
# every generated artifact before the broker ever sees it (target §8.1 step 1, satisfied
# upstream of this agent already).
#
# hermes-media — the media agent (HermesAgentV5/IMPLEMENTATION_PLAN.md S10; target architecture
# §9.2). Owns the Buzz `media` topic; bridges it to the execution plane that already exists and
# already works (`hermes-broker.py` + `hermes-render-worker.py` on HomeD13) rather than inventing
# a second job model — the plan's own explicit instruction for this stage.
#
# Runs on Forge (spark-2), per target §9.2: "A thin media agent on Node B owns the endpoint" —
# not the dispatcher (would turn the router into a workflow author and block it on slow external
# calls, target §9.2's own rejected alternative) and not the presenter (stays a stylist).
#
# Async contract (target §9.4), the actual point of this stage's own text: **ack the task
# immediately, post completion separately.** The Buzz claim is acked the moment a broker job is
# successfully submitted — not after the render finishes. A 78-second (or ~1400-second video)
# render held open as a live Buzz claim is indistinguishable from a dead agent to
# `hermes-buzz-lockup-check.sh`. Completion is polled from the broker in the same loop iteration
# pattern `hermes-dispatch.py` already uses for `results`, then reported forward via
# `hermes-memory` + Buzz's own `results` topic — the same closure mechanism S6 already built,
# not a second one.
#
# Screening: the actual image/video bytes are screened as early as physically possible — inside
# `hermes-render-worker.py` itself (S10, same stage), on HomeD13, before the broker or Matrix
# ever see the file. This agent additionally screens the *prompt text* (both layers, same as
# `hermes-dispatch.py`) before ever submitting a broker job — nothing upstream of this process
# screens Buzz traffic yet, same reasoning S6 already established for dispatch's own input.
#
# Still does not re-deliver the artifact itself for the human-facing copy: `hermes-broker.py`
# already delivers every successful render (original and, since 1.1.0, any regenerated attempt)
# to Matrix (FleetOps) directly, with its own real sha256 and a human actually seeing the pixels —
# rebuilding that path here would duplicate working infrastructure for no benefit (S10's own
# instruction: use the broker's existing shape). This agent does now fetch the bytes once, purely
# for the evaluation model call (1.1.0) — a private, in-process read, not a second delivery path.
# This agent's own completion report back through hermes-memory/Buzz is a plain text acknowledgment
# ("delivered to FleetOps" or the real failure reason) — `hermes-presenter.py` has no image
# support yet (S7's own explicit scope: builds the seam, not the voice), so a real, honest text
# status is what "escalate verbatim" means for this stage, not a placeholder.
#
# Config, all from the environment (injected by hermes-media-wrapper.sh):
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN — required, same as hermes-dispatch.py
#   BROKER_URL      default http://<SPARK_LAN_IP>:8100 (broker always lives on spark)
#   BROKER_TOKEN    required
#   GUARD_URL/GUARD_TOKEN — optional, same graceful-degradation as hermes-dispatch.py
#   POLL_SECONDS    default 5
#   JOB_POLL_SECONDS default 15 — how often an in-flight broker job's status is checked
#   CLAIMANT        default "hermes-media"
#   ROUTER_URL      default http://127.0.0.1:8080 — this agent and `omni` are co-resident on
#                    Forge (spark-2), so the local router instance resolves `omni` to its own
#                    127.0.0.1:8091, no cross-node hop
#   EVAL_ENABLED    default "1" — set "0" to skip evaluation entirely (revert to 1.0.0 behavior)
#   EVAL_TIMEOUT_SECONDS default 60 — confirmed live a real evaluation takes ~3s; generous margin
#   MAX_REGENERATE_ATTEMPTS default 1 — bounded, never loop more than one regeneration

import base64
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
BROKER_URL = os.environ.get("BROKER_URL", f"http://{SPARK_IP}:8100").rstrip("/")
BROKER_TOKEN = os.environ.get("BROKER_TOKEN", "")
GUARD_URL = os.environ.get("GUARD_URL", f"http://{SPARK_IP}:8096").rstrip("/")
GUARD_TOKEN = os.environ.get("GUARD_TOKEN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
JOB_POLL_SECONDS = int(os.environ.get("JOB_POLL_SECONDS", "15"))
CLAIMANT = os.environ.get("CLAIMANT", "hermes-media")
ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")
EVAL_ENABLED = os.environ.get("EVAL_ENABLED", "1") == "1"
EVAL_TIMEOUT_SECONDS = int(os.environ.get("EVAL_TIMEOUT_SECONDS", "60"))
MAX_REGENERATE_ATTEMPTS = int(os.environ.get("MAX_REGENERATE_ATTEMPTS", "1"))

EVAL_SYSTEM_PROMPT = (
    "You judge whether a generated image matches its prompt and looks correct -- no obvious "
    "rendering artifacts, anatomy errors, or missing/garbled elements the prompt asked for. "
    "Answer with a single leading word, PASS or FAIL, followed by a short one-sentence reason. "
    "Be a real judge, not a rubber stamp -- a plausible-looking image that still doesn't match "
    "the prompt is a FAIL."
)


def log(msg):
    print(f"[hermes-media] {msg}", flush=True)


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _get_bytes(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        content_type = resp.headers.get("Content-Type", "application/octet-stream")
        return resp.read(), content_type


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
        payload = {"id": task_id, "agent": "media", "state": state}
        if topic:
            payload["topic"] = topic
        _post(f"{MEMORY_URL}/tasks", payload, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_guard_verdict(layer, severity_value, detail):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": "guard-log", "agent": "guard", "role": "system",
            "raw": json.dumps({"node": "media", "layer": layer, "severity": severity_value, **detail}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"guard verdict logging failed: {exc}")


def screen(text):
    hits = hermes_injection_guard.scan_messages([{"role": "user", "content": text}])
    severity = hermes_injection_guard.overall_severity(hits)
    if severity == "block":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log(f"Layer 1 BLOCKED media prompt: categories={categories}")
        log_guard_verdict("L1", "block", {"categories": categories})
        return False
    if severity == "flag":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log_guard_verdict("L1", "flag", {"categories": categories})

    if GUARD_TOKEN:
        try:
            verdict = _post(f"{GUARD_URL}/classify", {"text": text}, GUARD_TOKEN, timeout=10)
            if verdict.get("hit"):
                log(f"Layer 2 BLOCKED media prompt: score={verdict['score']:.3f}")
                log_guard_verdict("L2", "block", {"label": verdict["label"], "score": verdict["score"]})
                return False
        except Exception as exc:
            log(f"Layer 2 unreachable, proceeding on Layer 1 alone: {exc}")
    return True


def submit_broker_job(prompt):
    return _post(f"{BROKER_URL}/jobs", {"type": "render", "payload": {"prompt": prompt}}, BROKER_TOKEN)


def broker_job_status(job_id):
    return _get(f"{BROKER_URL}/jobs/{job_id}", BROKER_TOKEN)


def fetch_artifact_bytes(job_id):
    """This agent runs on Forge (spark-2); the broker's ARTIFACT_DIR is a LUKS-mounted path on
    Watch (spark). hermes-broker.py 1.3.0's GET /jobs/{id}/artifact is the only route that moves
    the actual bytes across that gap."""
    return _get_bytes(f"{BROKER_URL}/jobs/{job_id}/artifact", BROKER_TOKEN, timeout=30)


def evaluate_image(image_bytes, content_type, prompt):
    """Target §9.2's generate->evaluate->regenerate loop, the co-resident half: a direct call to
    `omni` via the local router, not a Buzz round-trip (this loop is synchronous by design, same
    reasoning hermes-dispatch.py calling `super`/`coder` directly already established). Returns
    (passed: bool, reason: str). Confirmed live before this was written: a real image + this exact
    image_url data-URI shape gets a real, accurate description back from omni in ~3s."""
    b64 = base64.b64encode(image_bytes).decode("ascii")
    mime = content_type if content_type.startswith("image/") else "image/png"
    body = {
        "model": "omni",
        "messages": [
            {"role": "system", "content": EVAL_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": f"Prompt: {prompt}"},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ]},
        ],
        "max_tokens": 150,
    }
    result = _post(f"{ROUTER_URL}/v1/chat/completions", body, timeout=EVAL_TIMEOUT_SECONDS)
    verdict = result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    passed = verdict.upper().startswith("PASS")
    return passed, verdict


def publish_result(task_id, memory_ref, ok, message):
    """Reports completion the same way a real specialist eventually will: a `turns` row with the
    outcome, the task marked done, and a pointer published to Buzz's `results` topic so
    hermes-dispatch's own results-watcher (built in S6, unchanged since) closes the loop —
    exactly the same closure mechanism, not a second one."""
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "media", "role": "assistant",
        "raw": message, "presented": message,
    }, MEMORY_TOKEN)
    set_task_state(task_id, "done" if ok else "error")
    _post(f"{BUZZ_URL}/messages", {
        "from": "media", "topic": "results", "task_id": task_id,
        "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)


def process_media_request():
    claim = claim_next("media")
    if not claim:
        return False

    claim_id = claim["id"]
    msg = claim["message"]
    task_id, memory_ref = msg.get("task_id"), msg.get("memory_ref")

    if not task_id:
        log(f"claim {claim_id}: message has no task_id — acking and dropping")
        ack_claim(claim_id)
        return True

    prompt = fetch_raw_text(task_id, memory_ref)
    if not prompt:
        log(f"claim {claim_id}: task {task_id!r} has no raw text — acking and dropping")
        ack_claim(claim_id)
        set_task_state(task_id, "error-no-content")
        return True

    if not screen(prompt):
        set_task_state(task_id, "blocked")
        ack_claim(claim_id)
        publish_result(task_id, memory_ref, False,
                        "This image/video request was rejected by the fleet's screening layer.")
        return True

    try:
        job = submit_broker_job(prompt)
    except Exception as exc:
        log(f"claim {claim_id}: broker submit failed: {exc} — leaving unacked for retry")
        return True  # not acked — Buzz's own lease reclaims it, no state kept here

    job_id = job["id"]
    set_task_state(task_id, "rendering")
    ack_claim(claim_id)  # target §9.4: ack immediately once work is genuinely in flight
    log(f"claim {claim_id}: task {task_id!r} -> broker job {job_id}, acked, polling")

    # Deliberately not a separate persistent index of "jobs I'm waiting on": if this process
    # restarts mid-poll, the task simply sits in "rendering"/"evaluating" state until an operator
    # or a future stage adds a resync sweep. No claim is held open across the wait (already acked
    # above), so nothing looks like a dead agent.
    status = wait_for_job(job_id)
    if status.get("state") == "dead":
        publish_result(task_id, memory_ref, False,
                        f"Image generation failed after retries: {status.get('error', '')[:300]}")
        log(f"job {job_id}: dead, task {task_id!r} closed with failure")
        return True

    note = ""
    if EVAL_ENABLED:
        ok, note, status, job_id = evaluate_and_maybe_regenerate(task_id, prompt, job_id, status)
        if not ok:
            publish_result(task_id, memory_ref, False,
                            f"Image generation failed during regeneration: {status.get('error', '')[:300]}")
            log(f"job {job_id}: regenerated job died, task {task_id!r} closed with failure")
            return True

    publish_result(task_id, memory_ref, True, f"Image generated and delivered to FleetOps.{note}")
    log(f"job {job_id}: done, task {task_id!r} closed")
    return True


def wait_for_job(job_id):
    """Polls a broker job to a terminal state (done/dead), tolerating transient status-check
    failures forever — same infinite-retry shape the 1.0.0 poll loop already used, just factored
    out so both the initial render and an evaluation-triggered regeneration can share it."""
    while True:
        try:
            status = broker_job_status(job_id)
        except Exception as exc:
            log(f"job {job_id}: status check failed: {exc}, retrying")
            time.sleep(JOB_POLL_SECONDS)
            continue
        if status.get("state") in ("done", "dead"):
            return status
        time.sleep(JOB_POLL_SECONDS)


def evaluate_and_maybe_regenerate(task_id, prompt, job_id, status):
    """Target §9.2's loop: generate -> evaluate -> regenerate, bounded to
    MAX_REGENERATE_ATTEMPTS. Never fails the task over an evaluation *problem* — any exception
    here (artifact fetch, omni call, anything) just skips straight to delivering the
    already-generated image, unevaluated, same fail-open posture every other best-effort step in
    this fleet already takes. A *regenerated job dying* is different and does fail the task —
    there is no image left to deliver at all in that case. Returns
    (ok, note_for_completion_message, final_status, final_job_id)."""
    attempts = 0
    while True:
        try:
            image_bytes, content_type = fetch_artifact_bytes(job_id)
            passed, verdict = evaluate_image(image_bytes, content_type, prompt)
        except Exception as exc:
            log(f"job {job_id}: evaluation failed, delivering unevaluated: {exc}")
            return True, "", status, job_id

        log(f"job {job_id}: evaluation {'PASS' if passed else 'FAIL'} — {verdict}")
        if passed or attempts >= MAX_REGENERATE_ATTEMPTS:
            suffix = " (evaluated: pass)" if passed else " (evaluated: did not pass after regeneration)"
            return True, suffix, status, job_id

        attempts += 1
        set_task_state(task_id, "regenerating")
        log(f"job {job_id}: regenerating (attempt {attempts}/{MAX_REGENERATE_ATTEMPTS})")
        try:
            new_job = submit_broker_job(prompt)
        except Exception as exc:
            log(f"job {job_id}: regenerate submit failed, delivering original: {exc}")
            return True, " (evaluated: did not pass, regeneration failed)", status, job_id
        job_id = new_job["id"]
        set_task_state(task_id, "rendering")
        status = wait_for_job(job_id)
        if status.get("state") == "dead":
            return False, "", status, job_id


def main():
    if not BUZZ_TOKEN or not MEMORY_TOKEN or not BROKER_TOKEN:
        sys.exit("BUZZ_TOKEN, MEMORY_TOKEN, and BROKER_TOKEN are all required")
    if not GUARD_TOKEN:
        log("WARNING: GUARD_TOKEN not set — this agent's own Layer 2 screening pass is skipped")
    log(f"watching Buzz topic 'media', polling every {POLL_SECONDS}s, "
        f"bridging to broker job type 'render' at {BROKER_URL}")
    while True:
        try:
            did_work = process_media_request()
        except Exception as exc:
            log(f"unhandled error this cycle, continuing: {exc}")
            did_work = False
        if not did_work:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
