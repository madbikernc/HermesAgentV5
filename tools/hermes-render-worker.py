#!/usr/bin/env python3
# Version: 1.5.1
#
# 1.5.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5; also fixed a stale GENERATE_SCRIPT docstring line that
# still named the retired amy-generate-image.sh instead of hermes-generate-image.sh.
#
# 1.5.0 (HermesAgentV5 S14) — GENERATE_SCRIPT default updated: amy-generate-image.sh renamed to
# hermes-generate-image.sh (Amy retired since S8; the script's own logic has been persona-agnostic
# since Migration Stage 3, only the name still said otherwise).
#
# 1.4.0 (HermesAgentV5 S10) — screens the generated artifact before it's ever read into
# report() and uploaded to the broker: real magic-byte signature checks (PNG/JPEG/WEBP for
# images, MP4-ftyp/WebM-EBML for video) plus a size bound. Target §9.3's "returned images pass
# through the §8 screener — no exception for rendered images," placed at the earliest point in
# the whole pipeline: this worker has the file locally, straight from ComfyUI on HomeD13, before
# the broker or Matrix ever see it. Deterministic only, no ML content classifier — target §8.1
# puts deterministic checks first anyway, and building an image classifier is out of scope. A
# rejected artifact is reported to the broker as a real failure (exit 4), never silently dropped
# or delivered.
#
# 1.3.0 (HermesAgentV4) — added `engine` to the validated payload passthrough, same
# allowlist-regex discipline as resolution/frames, wiring `amy-generate-image.sh`'s new
# `--engine sdxl|flux2` flag through the broker (IMPLEMENTATION_PLAN.md §6 Stage 3/6).
#
# 1.2.0 — security-review fix: run_job() now validates the broker job
# payload's resolution/frames fields (WIDTHxHEIGHT digits / plain integer)
# before passing them to the generation script — both scripts splice these
# largely unvalidated into a JSON workflow request sent to ComfyUI, so a
# crafted payload value could otherwise alter that request's structure.
# Validated at the earliest point untrusted broker-job data enters the
# pipeline; both scripts also validate independently as defense-in-depth.
#
# hermes-render-worker — HomeD13's side of the execution plane
# (IMPLEMENTATION_PLAN.md §4c, Stage 1).
#
# Pulls jobs of one type from the broker on the Spark and runs a configured
# generation script against them. Reports the real exit code, the real
# artifact bytes, and a real sha256 back to the broker.
#
# THE WORKER PULLS. It makes only outbound connections, so:
#   - no new inbound port is opened on this node (§5 constraint 2)
#   - this node being down is not a failure — jobs simply queue on the Spark and
#     drain when it returns. HomeD13 needs a console passphrase on every boot,
#     so that property is doing real work, not hypothetical work.
#
# Stage 1 deliberately did NOT modify amy-generate-image.sh. That script still
# performs its own VRAM swap and its own Matrix delivery; the point of this stage
# is to prove the broker against the known-good path before changing that path.
# Expect each successful render to appear twice during Stage 1 — once in
# SintraAmy from the script, once in FleetOps from the broker. Stage 3e removes
# the script's own delivery and the swap along with it.
#
# Stage 6 (2026-08-09) generalized this from a hardcoded "render"-only worker
# to a JOB_TYPE-parameterized one, exactly as IMPLEMENTATION_PLAN.md §6 Stage 6
# specified ("same worker, same pull model, longer timeout, no new port") — a
# second systemd instance runs this same file with JOB_TYPE=video and
# GENERATE_SCRIPT=hermes-generate-video.sh, polling independently from the
# image-render instance. No server-side broker change was needed at all: the
# broker already treated `type` as an opaque string and already mime-sniffed
# video/* to msgtype m.video in matrix_deliver().
#
# Config, all from the environment (injected by hermes-render-worker-wrapper.sh):
#   BROKER_URL       default http://10.129.1.15:8100
#   BROKER_TOKEN     required
#   WORKER_NAME      default homed13
#   JOB_TYPE         default render     — which broker job type this instance claims
#   POLL_SECONDS     default 10
#   GENERATE_SCRIPT  default ~/HermesAgentV5/tools/hermes-generate-image.sh
#   JOB_TIMEOUT      default 900

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Both generation scripts splice these two payload fields, largely
# unvalidated, into a JSON workflow request sent to ComfyUI's own API --
# found in a security review. Validated here, at the point untrusted broker
# job-payload data first enters the pipeline, so a crafted value (e.g.
# `1024, "extra_node": {...}`) never reaches either script at all.
RESOLUTION_RE = re.compile(r"^\d{2,5}x\d{2,5}$")
FRAMES_RE = re.compile(r"^\d{1,4}$")
# V4: same allowlist discipline, for amy-generate-image.sh's new --engine flag
# (IMPLEMENTATION_PLAN.md §6 Stage 3/6 — SDXL stays the default, flux2 is opt-in).
ENGINE_RE = re.compile(r"^(sdxl|flux2)$")

BROKER_URL = os.environ.get("BROKER_URL", "http://10.129.1.15:8100").rstrip("/")
TOKEN = os.environ.get("BROKER_TOKEN", "")
WORKER = os.environ.get("WORKER_NAME", "homed13")
JOB_TYPE = os.environ.get("JOB_TYPE", "render")
POLL = int(os.environ.get("POLL_SECONDS", "10"))
SCRIPT = os.environ.get(
    "GENERATE_SCRIPT", os.path.expanduser("~/HermesAgentV5/tools/hermes-generate-image.sh"))
JOB_TIMEOUT = int(os.environ.get("JOB_TIMEOUT", "900"))


def log(msg):
    print(f"[render-worker] {msg}", flush=True)


def request(method, path, data=None, headers=None):
    req = urllib.request.Request(
        f"{BROKER_URL}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", **(headers or {})})
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def claim():
    try:
        return request("GET", f"/jobs/claim?type={JOB_TYPE}&worker={urllib.parse.quote(WORKER)}"
                       ).get("job")
    except urllib.error.URLError as exc:
        # The broker being unreachable is expected sometimes — the Spark's LUKS
        # container is not auto-mounted after a reboot. Keep polling quietly.
        log(f"broker unreachable ({exc}) — retrying in {POLL}s")
        return None
    except Exception as exc:
        log(f"claim failed: {exc}")
        return None


def run_job(job):
    payload = job.get("payload", {})
    prompt = payload.get("prompt", "")
    if not prompt:
        return 2, None, "payload has no prompt"

    cmd = [SCRIPT, "--prompt", prompt]
    for flag, key in (("--style", "style"), ("--negative", "negative"),
                      ("--resolution", "resolution"), ("--room", "room"),
                      ("--frames", "frames"), ("--engine", "engine")):
        if not payload.get(key):
            continue
        value = str(payload[key])
        if key == "resolution" and not RESOLUTION_RE.match(value):
            return 2, None, f"payload resolution {value!r} is not WIDTHxHEIGHT digits — refused"
        if key == "frames" and not FRAMES_RE.match(value):
            return 2, None, f"payload frames {value!r} is not a plain integer — refused"
        if key == "engine" and not ENGINE_RE.match(value):
            return 2, None, f"payload engine {value!r} is not 'sdxl' or 'flux2' — refused"
        cmd += [flag, value]

    log(f"job {job['id']}: running {os.path.basename(SCRIPT)} (attempt {job.get('attempt')})")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=JOB_TIMEOUT)
    except subprocess.TimeoutExpired:
        return 124, None, f"generation exceeded {JOB_TIMEOUT}s"

    # The script prints the artifact path as its final stdout line.
    path = (proc.stdout or "").strip().splitlines()
    path = path[-1].strip() if path else ""
    err = (proc.stderr or "")[-4000:]

    if proc.returncode != 0:
        return proc.returncode, None, err or "script exited non-zero"
    if not path or not os.path.isfile(path):
        # A clean exit with no real file is exactly the fabrication-shaped outcome
        # this whole architecture exists to make impossible. Treat it as failure.
        return 3, None, f"script exited 0 but produced no readable artifact (path={path!r})\n{err}"
    return 0, path, ""


# Screening (HermesAgentV5 S10; target §9.3 — "returned images pass through the §8 screener...
# no exception for rendered images", target §8.1's deterministic-checks-first). Placed here,
# immediately after generation and before the artifact is ever read into `report()` and uploaded
# to the broker, is the earliest point in the whole pipeline this can happen — Node C (HomeD13)
# is explicitly a third machine with a permissive attack surface (target §9.3: "ComfyUI custom
# nodes execute arbitrary Python"), so nothing downstream of this worker should ever have to
# trust that a file claiming to be a PNG actually is one. Deterministic only: real magic-byte
# signature checks and a size bound, no ML content classifier — building one is out of scope, and
# target §8.1 puts deterministic checks first for exactly this kind of file anyway.
IMAGE_SIGNATURES = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")  # PNG, JPEG (WEBP checked separately)
MIN_ARTIFACT_BYTES = 1024                  # a real render is never this small
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024  # 2GB — generous, still a real bound


def screen_artifact(path, job_type):
    """Returns None if the artifact passes, or a human-readable reason string if it doesn't.
    Never raises — a screening bug must fail closed (reject) via its caller, not crash the
    worker; see the try/except around this call in main()."""
    try:
        size = os.path.getsize(path)
        if size < MIN_ARTIFACT_BYTES:
            return f"artifact is {size} bytes — smaller than a real render could plausibly be"
        if size > MAX_ARTIFACT_BYTES:
            return f"artifact is {size} bytes — larger than the {MAX_ARTIFACT_BYTES} byte bound"
        with open(path, "rb") as fh:
            head = fh.read(16)

        if job_type == "video":
            # MP4/MOV (ISO base media): a 4-byte box size, then literal b"ftyp" at offset 4 —
            # the size varies, so unlike the fixed-offset checks below this only fixes bytes
            # 4:8, not the leading length. WebM/Matroska: a fixed EBML header at offset 0.
            ok = head[4:8] == b"ftyp" or head.startswith(b"\x1a\x45\xdf\xa3")
            if not ok:
                return f"first 16 bytes don't match MP4 ('ftyp' at offset 4) or WebM/EBML: {head!r}"
            return None

        if head.startswith(IMAGE_SIGNATURES):
            return None
        if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
            return None
        return f"first 16 bytes don't match any known image signature (PNG/JPEG/WEBP): {head!r}"
    except Exception as exc:
        return f"screening itself failed, treating as a reject: {exc}"


def report(job_id, exit_code, path, error, caption):
    blob, sha, filename = b"", "", ""
    if path:
        with open(path, "rb") as fh:
            blob = fh.read()
        sha = hashlib.sha256(blob).hexdigest()
        filename = os.path.basename(path)
    headers = {
        "Content-Type": "application/octet-stream",
        "X-Exit-Code": str(exit_code),
        "X-Sha256": sha,
        "X-Filename": filename,
        # Headers must be latin-1 safe; prompts are arbitrary user text.
        "X-Error": (error or "").replace("\n", " ")[:900].encode(
            "ascii", "replace").decode("ascii"),
        "X-Caption": (caption or "").replace("\n", " ")[:400].encode(
            "ascii", "replace").decode("ascii"),
    }
    result = request("POST", f"/jobs/{job_id}/result", data=blob, headers=headers)
    log(f"job {job_id}: reported exit={exit_code} sha={sha[:12] or 'none'} "
        f"-> {result.get('state')}")


def main():
    if not TOKEN:
        sys.exit("BROKER_TOKEN is required")
    if not os.path.isfile(SCRIPT):
        sys.exit(f"generation script not found at {SCRIPT} — refusing to start. "
                 "A missing tool is something to report, never something to fake.")
    log(f"polling {BROKER_URL} every {POLL}s as '{WORKER}' for type='{JOB_TYPE}' jobs")
    while True:
        job = claim()
        if not job:
            time.sleep(POLL)
            continue
        try:
            exit_code, path, error = run_job(job)
            if exit_code == 0 and path:
                reject_reason = screen_artifact(path, JOB_TYPE)
                if reject_reason:
                    log(f"job {job['id']}: REJECTED by screening: {reject_reason}")
                    exit_code, path, error = 4, None, f"rejected by screening: {reject_reason}"
            report(job["id"], exit_code, path, error,
                   job.get("payload", {}).get("prompt", ""))
        except Exception as exc:
            log(f"job {job['id']}: worker error: {exc}")
            try:
                report(job["id"], 1, None, f"worker exception: {exc}", "")
            except Exception as inner:
                # Reporting failed too — leave it. The broker's lease expiry will
                # requeue this job rather than stranding it.
                log(f"job {job['id']}: could not report failure either: {inner}")


if __name__ == "__main__":
    main()
