#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-10-03) — comment only: the workflow is now exported from ComfyUI's native TRELLIS.2
# nodes (0.34.0+), not from the withdrawn visualbruno/ComfyUI-Trellis2 custom node. No code change;
# this script never named a node class and does not care which produced the graph.
#
# 1.1.0 (2026-09-27) — required, hash-verified NAS2 archive copy (MESH_ARCHIVE_DIR, exit 8), per the
# operator decision that `mesh` is a quiet broker type and STLs are stored on NAS2.
#
# 1.0.0 (2026-09-27, HermesAgentV5 S19b, pre-node) — initial version.
#
# hermes-generate-mesh — Anvil's generation script for `mesh` broker jobs (IMPLEMENTATION_PLAN.md
# S19b), run by hermes-render-worker.py with JOB_TYPE=mesh, exactly as hermes-generate-image.sh is
# run for `render`. Same contract: the artifact path is the final stdout line, a non-zero exit is a
# real failure, and no file means no success.
#
# TRELLIS.2 is image-to-3D, so a mesh job does not carry an image — it names the finished `render`
# job whose image to use (--source-job). The bytes come from the broker's existing
# GET /jobs/{id}/artifact route (hermes-broker.py 1.3.0), so text-to-mesh is two ordinary broker
# jobs in sequence, not a new transport:
#   1. fetch the source image from the broker, check it really is an image
#   2. upload it to the local ComfyUI, submit the mesh-only TRELLIS.2 workflow, wait for it
#   3. pull the output mesh (.glb/.obj/.ply/.stl) back out of ComfyUI
#   4. tools/hermes-mesh-repair.py — viable STL or an honest failure (S19c)
#   5. rename the STL to carry its real extents, since STL has no units and this is the one place
#      a human sees the size before opening the file: mesh-<source>-<X>x<Y>x<Z>.stl
#   6. copy it and its repair report to NAS2 (MESH_ARCHIVE_DIR) — REQUIRED and hash-verified, not
#      best-effort like the render scripts' NAS copy: `mesh` is a quiet broker type (operator
#      decision 2026-09-27), so NAS2 is the one place a human can actually get the STL
#
# The workflow is NOT hand-written here. Its node graph only exists once TRELLIS.2 is installed on
# Anvil: start from the TRELLIS.2 template shipped with ComfyUI 0.34.0+, strip it to the shape path
# (STL carries no materials, so texturing is pure cost), export with "Save (API Format)", replace the
# LoadImage filename with the literal string {{INPUT_IMAGE}} (and any seed with {{SEED}}, so a broker
# retry is a genuinely different attempt), and commit it at MESH_WORKFLOW.
# Until then this script refuses to start a job rather than guess at a graph (infra/anvil/README.md).
#
# Timings for S19 exit gate 2 (fetch / ComfyUI / repair, in seconds) are written into the repair
# report next to the STL, so the first real runs leave their own measurements behind.
#
# Usage: hermes-generate-mesh.py --source-job <render-job-id> [--prompt <caption>] [--keep-largest]
# Config (environment; BROKER_URL/BROKER_TOKEN are inherited from hermes-render-worker.py):
#   BROKER_URL, BROKER_TOKEN   required
#   COMFYUI_URL        default http://127.0.0.1:8188 — Anvil's own ComfyUI, bound to loopback
#   MESH_WORKFLOW      default <repo>/infra/anvil/workflows/trellis2-mesh-only.api.json
#   MESH_OUT_DIR       default ~/hermes-mesh-out
#   MESH_COMFY_TIMEOUT default 3600 — PROVISIONAL, not measured; S19 exit gate 2 replaces it
#   MESH_ARCHIVE_DIR   required — NAS2's Private\Hermes\Meshes, as this node reaches it
# Exit: 0 STL written, 2 bad usage/config, 5 mesh not repairable, 6 source image unavailable,
#       7 ComfyUI failed, 8 NAS2 archive copy failed, 1 anything else.

import argparse
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BROKER_URL = os.environ.get("BROKER_URL", "").rstrip("/")
BROKER_TOKEN = os.environ.get("BROKER_TOKEN", "")
COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")
MESH_WORKFLOW = Path(os.environ.get(
    "MESH_WORKFLOW", REPO / "infra" / "anvil" / "workflows" / "trellis2-mesh-only.api.json"))
MESH_OUT_DIR = Path(os.environ.get("MESH_OUT_DIR", Path.home() / "hermes-mesh-out"))
MESH_COMFY_TIMEOUT = int(os.environ.get("MESH_COMFY_TIMEOUT", "3600"))
MESH_ARCHIVE_DIR = os.environ.get("MESH_ARCHIVE_DIR", "")
COMFY_POLL_SECONDS = 5

JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
IMAGE_TYPES = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"))
MESH_EXTS = (".glb", ".gltf", ".obj", ".ply", ".stl")
REPAIR = REPO / "tools" / "hermes-mesh-repair.py"


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def log(msg):
    print(f"[generate-mesh] {msg}", file=sys.stderr, flush=True)


def http(method, url, data=None, headers=None, timeout=60):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_source_image(source_job):
    try:
        blob = http("GET", f"{BROKER_URL}/jobs/{source_job}/artifact",
                    headers={"Authorization": f"Bearer {BROKER_TOKEN}"}, timeout=120)
    except urllib.error.HTTPError as exc:
        raise Failure(6, f"broker has no artifact for source job {source_job}: HTTP {exc.code}")
    except urllib.error.URLError as exc:
        raise Failure(6, f"broker unreachable fetching source job {source_job}: {exc.reason}")
    for magic, ext in IMAGE_TYPES:
        if blob.startswith(magic):
            return blob, ext
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return blob, "webp"
    raise Failure(6, f"source job {source_job}'s artifact is not a PNG/JPEG/WEBP image")


def load_workflow():
    if not MESH_WORKFLOW.is_file():
        raise Failure(2, f"no TRELLIS.2 workflow at {MESH_WORKFLOW} — export it from ComfyUI on "
                         "Anvil first (infra/anvil/README.md). Refusing to guess a node graph.")
    text = MESH_WORKFLOW.read_text(encoding="utf-8")
    if text.count("{{INPUT_IMAGE}}") != 1:
        raise Failure(2, f"{MESH_WORKFLOW} must contain the placeholder {{{{INPUT_IMAGE}}}} "
                         f"exactly once (found {text.count('{{INPUT_IMAGE}}')})")
    return text


def upload_image(blob, name):
    boundary = uuid.uuid4().hex
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
        "Content-Type: application/octet-stream\r\n\r\n".encode() + blob + b"\r\n",
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n".encode(),
        f"--{boundary}--\r\n".encode(),
    ]
    resp = json.loads(http("POST", f"{COMFYUI_URL}/upload/image", data=b"".join(parts),
                           headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}))
    uploaded = resp.get("name")
    if not uploaded:
        raise Failure(7, f"ComfyUI upload returned no name: {resp}")
    return f"{resp['subfolder']}/{uploaded}" if resp.get("subfolder") else uploaded


def run_workflow(workflow_text, image_name):
    text = workflow_text.replace("{{INPUT_IMAGE}}", json.dumps(image_name)[1:-1])
    text = text.replace('"{{SEED}}"', str(random.randint(0, 2**31 - 1)))
    try:
        workflow = json.loads(text)
    except json.JSONDecodeError as exc:
        raise Failure(2, f"{MESH_WORKFLOW} is not valid JSON after substitution: {exc}")
    try:
        resp = json.loads(http("POST", f"{COMFYUI_URL}/prompt",
                               data=json.dumps({"prompt": workflow,
                                                "client_id": f"hermes-{uuid.uuid4().hex[:8]}"}).encode(),
                               headers={"Content-Type": "application/json"}))
    except urllib.error.HTTPError as exc:
        raise Failure(7, f"ComfyUI rejected the workflow: HTTP {exc.code} "
                         f"{exc.read()[:1500].decode('utf-8', 'replace')}")
    if resp.get("node_errors"):
        raise Failure(7, f"ComfyUI node errors: {json.dumps(resp['node_errors'])[:1500]}")
    prompt_id = resp.get("prompt_id")
    if not prompt_id:
        raise Failure(7, f"ComfyUI returned no prompt_id: {resp}")

    deadline = time.monotonic() + MESH_COMFY_TIMEOUT
    while time.monotonic() < deadline:
        history = json.loads(http("GET", f"{COMFYUI_URL}/history/{prompt_id}"))
        entry = history.get(prompt_id)
        if entry and entry.get("status", {}).get("completed") is not None:
            status = entry.get("status", {})
            if status.get("status_str") == "error" or not status.get("completed"):
                messages = [m for m in status.get("messages", []) if m and m[0] == "execution_error"]
                raise Failure(7, f"ComfyUI execution failed: {json.dumps(messages)[:1500]}")
            return entry.get("outputs", {})
        time.sleep(COMFY_POLL_SECONDS)
    raise Failure(7, f"ComfyUI did not finish within {MESH_COMFY_TIMEOUT}s (prompt {prompt_id})")


def find_mesh_outputs(node):
    """Custom 3D nodes report their output in different shapes: a {filename, subfolder, type}
    record like SaveImage, or a bare path string. Accept both, anywhere in the outputs tree."""
    if isinstance(node, dict):
        name = node.get("filename")
        if isinstance(name, str) and name.lower().endswith(MESH_EXTS):
            yield {"filename": name, "subfolder": node.get("subfolder", ""),
                   "type": node.get("type", "output")}
        for value in node.values():
            yield from find_mesh_outputs(value)
    elif isinstance(node, list):
        for value in node:
            yield from find_mesh_outputs(value)
    elif isinstance(node, str) and node.lower().endswith(MESH_EXTS):
        yield {"path": node}


def fetch_mesh(outputs, dest_dir):
    found = list(find_mesh_outputs(outputs))
    if not found:
        raise Failure(7, "ComfyUI finished but its outputs contain no mesh file "
                         f"({', '.join(MESH_EXTS)}): {json.dumps(outputs)[:800]}")
    ref = found[0]
    if len(found) > 1:
        log(f"{len(found)} mesh outputs; using the first ({ref})")
    if "path" in ref and os.path.isfile(ref["path"]):
        blob, name = Path(ref["path"]).read_bytes(), os.path.basename(ref["path"])
    else:
        name = os.path.basename(ref.get("filename") or ref["path"])
        query = urllib.parse.urlencode({"filename": name, "subfolder": ref.get("subfolder", ""),
                                        "type": ref.get("type", "output")})
        blob = http("GET", f"{COMFYUI_URL}/view?{query}", timeout=300)
    raw = dest_dir / f"raw{Path(name).suffix.lower()}"
    raw.write_bytes(blob)
    return raw


def extents_name(source_job, extents):
    return f"mesh-{source_job}-" + "x".join(f"{e:.1f}" for e in extents) + ".stl"


def generate(source_job, keep_largest):
    if not BROKER_URL or not BROKER_TOKEN:
        raise Failure(2, "BROKER_URL and BROKER_TOKEN are required")
    if not MESH_ARCHIVE_DIR:
        raise Failure(2, "MESH_ARCHIVE_DIR is required — NAS2 is the only place a human can reach "
                         "the STL (infra/anvil/README.md)")
    workflow_text = load_workflow()
    job_dir = MESH_OUT_DIR / f"{source_job}-{int(time.time())}"
    job_dir.mkdir(parents=True, exist_ok=True)
    timings = {}

    t = time.monotonic()
    image, ext = fetch_source_image(source_job)
    timings["fetch_seconds"] = round(time.monotonic() - t, 2)

    t = time.monotonic()
    try:
        image_name = upload_image(image, f"hermes-{source_job}.{ext}")
        outputs = run_workflow(workflow_text, image_name)
        raw = fetch_mesh(outputs, job_dir)
    except urllib.error.URLError as exc:
        raise Failure(7, f"ComfyUI unreachable at {COMFYUI_URL}: {getattr(exc, 'reason', exc)}")
    timings["comfyui_seconds"] = round(time.monotonic() - t, 2)
    log(f"ComfyUI produced {raw.name} ({raw.stat().st_size} bytes) in {timings['comfyui_seconds']}s")

    t = time.monotonic()
    stl, report_path = job_dir / "repaired.stl", job_dir / "repair-report.json"
    cmd = [sys.executable, str(REPAIR), str(raw), str(stl), "--report", str(report_path)]
    if keep_largest:
        cmd.append("--keep-largest")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    timings["repair_seconds"] = round(time.monotonic() - t, 2)
    report = json.loads(report_path.read_text()) if report_path.is_file() else {}
    report["timings"] = timings
    report_path.write_text(json.dumps(report, indent=2))
    sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        raise Failure(proc.returncode, f"repair failed: {report.get('error', proc.stderr[-800:])}")

    final = job_dir / extents_name(source_job, report["output"]["extents_unitless"])
    stl.rename(final)
    archive(final, report_path)
    log(f"timings: {timings}")
    return final


def archive(stl, report_path):
    """NAS2 is where a human actually gets the STL: mesh is a quiet broker type (no FleetOps post),
    and the broker's own artifact dir is closed to everyone but the broker. So unlike the render
    scripts' best-effort NAS copy, this one is REQUIRED — a job whose STL did not verifiably land
    on NAS2 fails, and the broker retries it, rather than succeeding somewhere nobody can reach.
    Copied under a temp name, re-read and hash-checked, then renamed into place."""
    dest_dir = Path(MESH_ARCHIVE_DIR)
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        for src in (stl, report_path):
            name = stl.stem + ".json" if src == report_path else stl.name
            tmp = dest_dir / f".{name}.partial"
            data = src.read_bytes()
            tmp.write_bytes(data)
            if hashlib.sha256(tmp.read_bytes()).digest() != hashlib.sha256(data).digest():
                tmp.unlink()
                raise OSError(f"{tmp} read back different from what was written")
            os.replace(tmp, dest_dir / name)
    except OSError as exc:
        raise Failure(8, f"NAS2 archive copy to {dest_dir} failed: {exc}")
    log(f"archived to {dest_dir / stl.name}")


def main(argv):
    ap = argparse.ArgumentParser(description="Generate a viable STL from a render job's image.")
    ap.add_argument("--source-job", required=True)
    ap.add_argument("--prompt", default="", help="caption only; TRELLIS.2 is image-conditioned")
    ap.add_argument("--keep-largest", action="store_true")
    try:
        args, unknown = ap.parse_known_args(argv)
    except SystemExit:
        return 2
    if unknown:
        log(f"ignoring flags this script does not use: {unknown}")
    if not JOB_ID_RE.match(args.source_job):
        log(f"--source-job {args.source_job!r} is not a broker job id")
        return 2
    try:
        path = generate(args.source_job, args.keep_largest)
    except Failure as exc:
        log(f"FAILED: {exc}")
        return exc.code
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
