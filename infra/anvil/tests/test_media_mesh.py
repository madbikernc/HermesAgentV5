#!/usr/bin/env python3
# Version: 1.0.0
#
# Unit checks for tools/hermes-media.py's S19 mesh route: which requests count as mesh requests,
# the render -> mesh job chain, the honest failure message, and — most important before Anvil
# exists — that with MESH_ENABLED unset nothing about image requests changes. Buzz, memory, the
# broker and the router are all stubbed; stdlib only, runs anywhere:
#   python3 infra/anvil/tests/test_media_mesh.py
#
# Revision History: 1.0.0 | 2026-09-27 | Initial checks for the mesh route.
import importlib.util
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
passed = 0


def check(name, fn):
    global passed
    fn()
    passed += 1
    print(f"PASS: {name}")


def load_media(mesh_enabled):
    os.environ["MESH_ENABLED"] = "1" if mesh_enabled else "0"
    spec = importlib.util.spec_from_file_location("media", REPO / "tools" / "hermes-media.py")
    media = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(media)
    media.log = lambda msg: None
    return media


def run_request(media, text, mesh_state="done"):
    """Drives one process_media_request() with every network edge stubbed. Returns what it did."""
    calls = {"render": [], "mesh": [], "results": [], "states": []}
    media.EVAL_ENABLED = False
    media.claim_next = lambda topic: {"id": "c1", "message": {"task_id": "t1", "memory_ref": "turn:1"}}
    media.ack_claim = lambda claim_id: None
    media.fetch_raw_text = lambda task_id, ref: text
    media.screen = lambda t: True
    media.hermes_conversation_common.fetch_conv_id = lambda *a: None
    media.set_task_state = lambda task_id, state, topic=None: calls["states"].append(state)

    def submit_render(prompt):
        calls["render"].append(prompt)
        return {"id": f"r{len(calls['render'])}"}

    def submit_mesh(prompt, source_job):
        calls["mesh"].append((prompt, source_job))
        return {"id": "m1"}

    def wait(job_id):
        if job_id.startswith("m"):
            if mesh_state == "dead":
                return {"state": "dead", "error": "exit 5: repair failed: 2 separate solids remain"}
            return {"state": "done", "artifact": "/mnt/x/m1/mesh-r1-80.0x40.0x25.5.stl"}
        return {"state": "done", "artifact": "/mnt/x/r1/img.png"}

    media.submit_broker_job = submit_render
    media.submit_mesh_job = submit_mesh
    media.wait_for_job = wait
    media.publish_result = lambda task_id, ref, ok, msg: calls["results"].append((ok, msg))
    assert media.process_media_request() is True
    return calls


def detection():
    media = load_media(True)
    for text in ("make me an STL of a whale", "a 3D-printable dragon", "3d print a phone stand",
                 "I want a 3D model of a chess knight", "printable planter", "two stls please"):
        assert media.is_mesh_request(text), text
    for text in ("a 3D-style render of a city", "a mesh laundry bag on a table", "a steel bridge",
                 "draw a printer", "a photo of a 3D printer"):
        assert not media.is_mesh_request(text), text
    assert not load_media(False).is_mesh_request("make me an STL of a whale")


def mesh_request_chains_render_then_mesh():
    calls = run_request(load_media(True), "make me an STL of a whale")
    assert len(calls["render"]) == 1 and "plain white background" in calls["render"][0]
    assert calls["mesh"] == [("make me an STL of a whale", "r1")], calls["mesh"]
    assert "meshing" in calls["states"]
    ok, msg = calls["results"][-1]
    assert ok and "m1" in msg and "no units" in msg, msg
    assert "NAS2 at Private/Hermes/Meshes/mesh-r1-80.0x40.0x25.5.stl" in msg, msg


def dead_mesh_job_is_an_honest_failure():
    calls = run_request(load_media(True), "make me an STL of a whale", mesh_state="dead")
    ok, msg = calls["results"][-1]
    assert not ok and "no viable STL" in msg and "separate solids" in msg, msg


def image_requests_unchanged():
    calls = run_request(load_media(True), "a red bicycle at sunset")
    assert calls["render"] == ["a red bicycle at sunset"] and not calls["mesh"]
    assert calls["results"][-1] == (True, "Image generated and delivered to FleetOps.")


def disabled_means_no_mesh_jobs():
    calls = run_request(load_media(False), "make me an STL of a whale")
    assert calls["render"] == ["make me an STL of a whale"], "prompt was altered while disabled"
    assert not calls["mesh"] and "meshing" not in calls["states"]
    assert calls["results"][-1] == (True, "Image generated and delivered to FleetOps.")


check("mesh requests are recognised; image requests and 'mesh' alone are not", detection)
check("a mesh request renders a steered image, then submits a mesh job naming it",
      mesh_request_chains_render_then_mesh)
check("a dead mesh job is reported as a failure with the real reason",
      dead_mesh_job_is_an_honest_failure)
check("image requests are unchanged with the mesh route on", image_requests_unchanged)
check("with MESH_ENABLED unset, a mesh-shaped request is an ordinary image request",
      disabled_means_no_mesh_jobs)
print(f"\n{passed} checks passed")
