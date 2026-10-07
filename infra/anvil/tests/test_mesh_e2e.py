#!/usr/bin/env python3
# Version: 1.1.1
#
# End-to-end check of the S19 mesh path through the REAL broker, workers and client — everything
# but TRELLIS.2 itself (IMPLEMENTATION_PLAN.md S19b). Nothing touches the live fleet:
#   - tools/hermes-broker.py runs as a throwaway instance on a free loopback port with a temp
#     database and artifact dir, and no Matrix credentials, so nothing is delivered anywhere
#   - tools/hermes-render-worker.py runs twice: JOB_TYPE=render with a stub script that writes a
#     real PNG, and JOB_TYPE=mesh with the real tools/hermes-generate-mesh.py
#   - ComfyUI is faked in-process (upload/prompt/history/view) and returns a deliberately broken
#     mesh, so the real repair chain has real work to do
#   - tools/hermes-render-request.sh --type mesh drives it, exactly as a Spark caller would
#
# Needs bash, curl, jq and the requirements-mesh.txt set, so run it on a Spark:
#   python3 infra/anvil/tests/test_mesh_e2e.py
#
# Revision History: 1.0.0 | 2026-09-27 | Initial end-to-end check, written before Anvil exists.
#                   1.1.0 | 2026-09-27 | NAS2 archive: verified copy on success, exit 8 when unreachable.
#                   1.1.1 | 2026-10-03 | Fixture node class names made synthetic: they named the withdrawn
#                                         custom node, which read as if the script depended on them.
import hashlib
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import trimesh

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"
TMP = Path(tempfile.mkdtemp(prefix="s19-e2e-"))
TOKEN = "s19-e2e-test-token"
spec = importlib.util.spec_from_file_location("mesh_verify", TOOLS / "hermes-mesh-verify.py")
mesh_verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mesh_verify)
passed = 0


def check(name, fn):
    global passed
    fn()
    passed += 1
    print(f"PASS: {name}")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---- fake ComfyUI ---------------------------------------------------------------------------

def broken_glb():
    """What a generator plausibly emits: a sphere with a hole in it plus a floating speck."""
    s = trimesh.creation.icosphere(subdivisions=3, radius=40)
    holed = trimesh.Trimesh(s.vertices, s.faces[6:], process=False)
    speck = trimesh.creation.icosphere(subdivisions=1, radius=0.5).apply_translation((90, 0, 0))
    return trimesh.util.concatenate([holed, speck]).export(file_type="glb")


def flat_glb():
    """Nothing to make a solid from: one open square."""
    sheet = trimesh.Trimesh([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], [[0, 1, 2], [0, 2, 3]],
                            process=False)
    return sheet.export(file_type="glb")


class FakeComfy:
    mesh = b""
    uploads, prompts = [], []


class ComfyHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, code=200):
        blob = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/upload/image":
            name = re.search(rb'filename="([^"]+)"', body).group(1).decode()
            FakeComfy.uploads.append((name, body))
            self._json({"name": name, "subfolder": "", "type": "input"})
        elif self.path == "/prompt":
            FakeComfy.prompts.append(json.loads(body)["prompt"])
            self._json({"prompt_id": f"p{len(FakeComfy.prompts)}", "number": 1, "node_errors": {}})
        else:
            self._json({"error": "no route"}, 404)

    def do_GET(self):
        if self.path.startswith("/history/"):
            pid = self.path.rsplit("/", 1)[1]
            self._json({pid: {
                "outputs": {"9": {"result": [{"filename": "trellis_00001_.glb", "subfolder": "",
                                              "type": "output"}]}},
                "status": {"status_str": "success", "completed": True, "messages": []}}})
        elif self.path.startswith("/view?"):
            self.send_response(200)
            self.send_header("Content-Length", str(len(FakeComfy.mesh)))
            self.end_headers()
            self.wfile.write(FakeComfy.mesh)
        else:
            self._json({"error": "no route"}, 404)


# ---- fleet processes, all throwaway ---------------------------------------------------------

BROKER_PORT, COMFY_PORT = free_port(), free_port()
BROKER_URL = f"http://127.0.0.1:{BROKER_PORT}"
WORKFLOW = TMP / "workflow.api.json"
ARCHIVE = TMP / "nas2" / "Private" / "Hermes" / "Meshes"   # stands in for the NAS2 share
LAST_RENDER = []
# The node class names here are deliberately synthetic. hermes-generate-mesh.py never looks at a
# class_type -- it substitutes the two placeholders and finds mesh outputs structurally -- so this
# fixture asserts that independence rather than mirroring whatever the real graph happens to use.
# (It previously named the withdrawn custom node's classes, which read as if they mattered.)
WORKFLOW.write_text(json.dumps({
    "1": {"class_type": "LoadImage", "inputs": {"image": "{{INPUT_IMAGE}}"}},
    "2": {"class_type": "AnyMeshGeneratorNode", "inputs": {"image": ["1", 0], "seed": "{{SEED}}"}},
    "9": {"class_type": "AnyMeshExportNode", "inputs": {"mesh": ["2", 0]}},
}))
RENDER_STUB = TMP / "stub-generate-image.py"
RENDER_STUB.write_text(
    "import os, sys, tempfile\n"
    "fd, p = tempfile.mkstemp(suffix='.png', dir=os.environ['STUB_OUT'])\n"
    "os.write(fd, b'\\x89PNG\\r\\n\\x1a\\n' + os.urandom(4096)); os.close(fd)\n"
    "print(p)\n")
(TMP / "render-out").mkdir()

BASE_ENV = {**os.environ, "BROKER_TOKEN": TOKEN, "BROKER_URL": BROKER_URL, "POLL_SECONDS": "1"}
procs = []


def start(args, env, name):
    log = open(TMP / f"{name}.log", "w")
    procs.append((subprocess.Popen([sys.executable, *args], env=env, stdout=log,
                                   stderr=subprocess.STDOUT), name))


def client(*args):
    env = {**BASE_ENV, "POLL_INTERVAL": "1", "HERMES_REPO_DIR": str(REPO)}
    return subprocess.run(["bash", str(TOOLS / "hermes-render-request.sh"), *args],
                          env=env, capture_output=True, text=True, timeout=300)


def broker_job(job_id):
    out = subprocess.run(["curl", "-s", f"{BROKER_URL}/jobs/{job_id}", "-H",
                          f"Authorization: Bearer {TOKEN}"], capture_output=True, text=True)
    return json.loads(out.stdout)


def submitted_ids(stderr):
    return re.findall(r"Submitted (\w+) job as (\w+)", stderr)


def mesh_path_end_to_end():
    FakeComfy.mesh = broken_glb()
    proc = client("--prompt", "a toy whale", "--type", "mesh")
    assert proc.returncode == 0, f"client exit {proc.returncode}\n{proc.stderr}"
    artifact, sha = proc.stdout.strip().splitlines()[-2:]
    jobs = submitted_ids(proc.stderr)
    assert [t for t, _ in jobs] == ["render", "mesh"], jobs
    render_id, mesh_id = jobs[0][1], jobs[1][1]

    # The render was steered toward image-to-3D, and its image is what ComfyUI received.
    render = broker_job(render_id)
    assert "plain white background" in json.loads(render["payload"])["prompt"]
    name, body = FakeComfy.uploads[-1]
    assert name == f"hermes-{render_id}.png" and b"\x89PNG" in body
    workflow = FakeComfy.prompts[-1]
    assert workflow["1"]["inputs"]["image"] == name
    assert isinstance(workflow["2"]["inputs"]["seed"], int), "the {{SEED}} placeholder was not replaced"

    # The mesh job's artifact is a real, viable STL whose name carries its size.
    mesh = broker_job(mesh_id)
    assert json.loads(mesh["payload"])["source_job"] == render_id
    size = re.fullmatch(rf"mesh-{render_id}-([\d.]+)x([\d.]+)x([\d.]+)\.stl", os.path.basename(artifact))
    assert size and all(75 < float(e) <= 80.0 for e in size.groups()), artifact
    blob = Path(artifact).read_bytes()
    assert hashlib.sha256(blob).hexdigest() == sha == mesh["sha256"]
    code, result = mesh_verify.verify_file(artifact)
    assert code == 0, result["failed"]
    assert result["stats"]["shells"] == 1

    # Exit gate 2's measurements are left behind next to the STL on the worker side.
    reports = sorted((TMP / "mesh-out").glob(f"{render_id}-*/repair-report.json"))
    timings = json.loads(reports[-1].read_text())["timings"]
    assert set(timings) == {"fetch_seconds", "comfyui_seconds", "repair_seconds"}, timings
    print(f"      timings (fake ComfyUI, so only fetch/repair mean anything): {timings}")

    # NAS2 is where a human gets it: the same bytes, plus the report, and no partial files.
    archived = ARCHIVE / os.path.basename(artifact)
    assert hashlib.sha256(archived.read_bytes()).hexdigest() == sha, "archived STL differs"
    report = json.loads(archived.with_suffix(".json").read_text())
    assert report["viable"] and report["timings"], report
    assert not list(ARCHIVE.glob(".*.partial")), "a partial archive file was left behind"
    LAST_RENDER.append(render_id)


def unrepairable_mesh_dead_letters():
    FakeComfy.mesh = flat_glb()
    before = len(FakeComfy.prompts)
    proc = client("--prompt", "a sheet of paper", "--type", "mesh")
    assert proc.returncode == 1, f"expected failure, got {proc.returncode}\n{proc.stderr}"
    assert "dead-lettered" in proc.stderr and "repair failed" in proc.stderr, proc.stderr[-1500:]
    mesh_id = submitted_ids(proc.stderr)[-1][1]
    mesh = broker_job(mesh_id)
    assert mesh["state"] == "dead" and not mesh["artifact"], mesh
    # Each broker retry was a fresh ComfyUI run (a new seed), not a replay of the same failure.
    assert len(FakeComfy.prompts) - before == 2, len(FakeComfy.prompts) - before


def existing_source_job_is_reused():
    FakeComfy.mesh = broken_glb()
    first = client("--prompt", "a toy whale", "--type", "render")
    assert first.returncode == 0, first.stderr
    render_id = submitted_ids(first.stderr)[-1][1]
    proc = client("--prompt", "a toy whale", "--type", "mesh", "--source-job", render_id)
    assert proc.returncode == 0, proc.stderr
    assert [t for t, _ in submitted_ids(proc.stderr)] == ["mesh"], "a second render was submitted"


def unreachable_archive_fails_the_job():
    # An archive dir that cannot exist (its parent is a file) stands in for NAS2 being down.
    FakeComfy.mesh = broken_glb()
    blocker = TMP / "not-a-dir"
    blocker.write_text("")
    env = {**BASE_ENV, "COMFYUI_URL": f"http://127.0.0.1:{COMFY_PORT}", "MESH_WORKFLOW": str(WORKFLOW),
           "MESH_OUT_DIR": str(TMP / "mesh-out-2"), "MESH_ARCHIVE_DIR": str(blocker / "Meshes")}
    proc = subprocess.run([sys.executable, str(TOOLS / "hermes-generate-mesh.py"),
                           "--source-job", LAST_RENDER[-1]], env=env, capture_output=True, text=True,
                          timeout=300)
    assert proc.returncode == 8, f"expected exit 8, got {proc.returncode}\n{proc.stderr[-1500:]}"
    assert "NAS2 archive copy" in proc.stderr and not proc.stdout.strip(), proc.stderr[-800:]
    env["MESH_ARCHIVE_DIR"] = ""
    proc = subprocess.run([sys.executable, str(TOOLS / "hermes-generate-mesh.py"),
                           "--source-job", LAST_RENDER[-1]], env=env, capture_output=True, text=True)
    assert proc.returncode == 2 and "MESH_ARCHIVE_DIR is required" in proc.stderr, proc.stderr


def bad_input_refused_before_submit():
    proc = client("--prompt", "x", "--type", "sculpture")
    assert proc.returncode == 1 and "must be render, video or mesh" in proc.stderr, proc.stderr


def main():
    comfy = ThreadingHTTPServer(("127.0.0.1", COMFY_PORT), ComfyHandler)
    threading.Thread(target=comfy.serve_forever, daemon=True).start()
    start([str(TOOLS / "hermes-broker.py")], {**BASE_ENV,
          "BROKER_DB": str(TMP / "jobs.db"), "BROKER_ARTIFACTS": str(TMP / "artifacts"),
          "BROKER_BIND": "127.0.0.1", "BROKER_PORT": str(BROKER_PORT), "BROKER_MAX_ATTEMPTS": "2",
          "FLEETOPS_MATRIX_TOKEN": "", "FLEETOPS_ROOM": ""}, "broker")
    start([str(TOOLS / "hermes-render-worker.py")], {**BASE_ENV, "JOB_TYPE": "render",
          "WORKER_NAME": "e2e-render", "GENERATE_SCRIPT": str(RENDER_STUB),
          "STUB_OUT": str(TMP / "render-out")}, "render-worker")
    start([str(TOOLS / "hermes-render-worker.py")], {**BASE_ENV, "JOB_TYPE": "mesh",
          "WORKER_NAME": "e2e-mesh", "GENERATE_SCRIPT": str(TOOLS / "hermes-generate-mesh.py"),
          "COMFYUI_URL": f"http://127.0.0.1:{COMFY_PORT}", "MESH_WORKFLOW": str(WORKFLOW),
          "MESH_OUT_DIR": str(TMP / "mesh-out"), "MESH_ARCHIVE_DIR": str(ARCHIVE)}, "mesh-worker")
    for _ in range(50):
        if subprocess.run(["curl", "-sf", f"{BROKER_URL}/health"], capture_output=True).returncode == 0:
            break
        time.sleep(0.2)
    try:
        check("client -> render -> mesh -> repair -> viable STL, through the real broker",
              mesh_path_end_to_end)
        check("an unrepairable mesh is retried fresh, then dead-lettered with no artifact",
              unrepairable_mesh_dead_letters)
        check("--source-job reuses an existing render instead of making another",
              existing_source_job_is_reused)
        check("an unreachable NAS2 archive fails the job (exit 8); an unset one refuses to start",
              unreachable_archive_fails_the_job)
        check("an unknown --type is refused before anything is submitted",
              bad_input_refused_before_submit)
    except BaseException:
        for _, name in procs:
            print(f"--- {name}.log (tail) ---\n{(TMP / f'{name}.log').read_text()[-3000:]}")
        raise
    finally:
        for proc, _ in procs:
            proc.terminate()
        comfy.shutdown()
    print(f"\n{passed} checks passed (logs in {TMP})")


if __name__ == "__main__":
    main()
