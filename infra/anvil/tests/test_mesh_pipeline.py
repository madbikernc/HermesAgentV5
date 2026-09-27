#!/usr/bin/env python3
# Version: 1.0.0
#
# Checks for the S19 viable-STL pipeline (IMPLEMENTATION_PLAN.md S19c): tools/hermes-mesh-verify.py
# must catch each named viability failure on its own, and tools/hermes-mesh-repair.py must either
# turn a broken mesh into one the verifier passes or fail with exit 5 and leave no file behind.
# Fixtures are built in code, each breaking one property, so nothing binary is committed.
#
# Needs no GPU and no Anvil — runs anywhere trimesh/pymeshlab/manifold3d install (tested on the
# Sparks' aarch64 and intended for Anvil's win_amd64):
#   python3 infra/anvil/tests/test_mesh_pipeline.py
#
# Revision History: 1.0.0 | 2026-09-27 | Initial checks, written before Anvil exists.
import importlib.util
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh

REPO = Path(__file__).resolve().parents[3]
REPAIR = REPO / "tools" / "hermes-mesh-repair.py"
spec = importlib.util.spec_from_file_location("mesh_verify", REPO / "tools" / "hermes-mesh-verify.py")
mesh_verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mesh_verify)

TMP = Path(tempfile.mkdtemp(prefix="s19-mesh-"))
passed = 0


def check(name, fn):
    global passed
    fn()
    passed += 1
    print(f"PASS: {name}")


# ---- fixtures -------------------------------------------------------------------------------

def sphere(radius=5.0, center=(0, 0, 0)):
    s = trimesh.creation.icosphere(subdivisions=3, radius=radius)
    s.apply_translation(center)
    return s


def tetra(offset=(0, 0, 0)):
    v = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=float) + offset
    f = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]])
    return trimesh.Trimesh(v, f, process=False)


def raw(vertices, faces):
    return trimesh.Trimesh(np.asarray(vertices, float), np.asarray(faces), process=False)


def join(*meshes):
    verts, faces, base = [], [], 0
    for m in meshes:
        verts.append(m.vertices)
        faces.append(np.asarray(m.faces) + base)
        base += len(m.vertices)
    return raw(np.vstack(verts), np.vstack(faces))


def write(mesh, name, ascii_=False):
    path = TMP / name
    mesh.export(path, file_type="stl_ascii" if ascii_ else "stl")
    return path


def write_binary(tris, name, normals=None, header=b"hermes test fixture"):
    """Hand-rolled writer, for bytes trimesh's exporter would never produce."""
    tris = np.asarray(tris, dtype=np.float32)
    if normals is None:
        n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        normals = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-30)
    out = bytearray(header.ljust(80, b" ")[:80])
    out += struct.pack("<I", len(tris))
    for n, t in zip(np.asarray(normals, np.float32), tris):
        out += n.tobytes() + t.tobytes() + b"\0\0"
    path = TMP / name
    path.write_bytes(bytes(out))
    return path


GOOD_SPHERE = sphere()
FIXTURES = {
    "good_box": write(trimesh.creation.box((10, 20, 30)), "good_box.stl"),
    "good_sphere": write(GOOD_SPHERE, "good_sphere.stl"),
    "good_torus": write(trimesh.creation.torus(10, 3), "good_torus.stl"),
    "good_ascii": write(GOOD_SPHERE, "good_ascii.stl", ascii_=True),
    "solid_header_binary": write_binary(GOOD_SPHERE.triangles, "solid_header.stl",
                                        header=b"solid exported-by-something"),
    "open_box": write(raw(trimesh.creation.box((10, 10, 10)).vertices,
                          trimesh.creation.box((10, 10, 10)).faces[2:]), "open_box.stl"),
    "flipped_patch": write(raw(GOOD_SPHERE.vertices,
                               np.vstack([GOOD_SPHERE.faces[:10, ::-1], GOOD_SPHERE.faces[10:]])),
                           "flipped_patch.stl"),
    "inside_out": write(raw(GOOD_SPHERE.vertices, GOOD_SPHERE.faces[:, ::-1]), "inside_out.stl"),
    "fragment": write(join(GOOD_SPHERE, sphere(0.2, (30, 0, 0))), "fragment.stl"),
    "two_solids": write(join(GOOD_SPHERE, sphere(5, (20, 0, 0))), "two_solids.stl"),
    "overlapping": write(join(GOOD_SPHERE, sphere(5, (6, 0, 0))), "overlapping.stl"),
    # A ball with an enclosed void: outer shell plus an inside-out inner shell.
    "hollow": write(join(GOOD_SPHERE, raw(sphere(2).vertices, sphere(2).faces[:, ::-1])),
                    "hollow.stl"),
    # A void the union itself encloses: six overlapping slabs walling in a 1x1x1 pocket of air
    # (the Bambu hotend's nozzle-in-hole pocket, reduced to its shape). Slab sizes differ per
    # axis so no two slabs share a vertex or a coplanar face — the pocket is the only subtlety.
    "trapped_void": write(join(*[trimesh.creation.box(e).apply_translation(c) for e, c in (
        ((3.2, 1, 3.4), (0, -1, 0)), ((3.2, 1, 3.4), (0, 1, 0)),
        ((1, 3.3, 3.1), (-1, 0, 0)), ((1, 3.3, 3.1), (1, 0, 0)),
        ((2.9, 3.1, 1), (0, 0, -1)), ((2.9, 3.1, 1), (0, 0, 1)))]),
        "trapped_void.stl"),
    "duplicate_face": write(raw(GOOD_SPHERE.vertices,
                                np.vstack([GOOD_SPHERE.faces, GOOD_SPHERE.faces[:1]])),
                            "duplicate_face.stl"),
    "degenerate": write(raw(GOOD_SPHERE.vertices, np.vstack([GOOD_SPHERE.faces, [[0, 0, 1]]])),
                        "degenerate.stl"),
    "bowtie": write(join(tetra(), tetra((-1, 0, 0))), "bowtie.stl"),  # meet only at the origin
    "shared_edge": write(join(trimesh.creation.box((1, 1, 1)),
                              trimesh.creation.box((1, 1, 1)).apply_translation((1, 1, 0))),
                         "shared_edge.stl"),
    "flat_sheet": write(raw([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], [[0, 1, 2], [0, 2, 3]]),
                        "flat_sheet.stl"),
}
_flipped_normals = np.cross(GOOD_SPHERE.triangles[:, 1] - GOOD_SPHERE.triangles[:, 0],
                            GOOD_SPHERE.triangles[:, 2] - GOOD_SPHERE.triangles[:, 0])
_flipped_normals[:5] *= -1
FIXTURES["stored_normals_flipped"] = write_binary(GOOD_SPHERE.triangles, "stored_normals.stl",
                                                  normals=_flipped_normals)
_good_bytes = FIXTURES["good_sphere"].read_bytes()
(TMP / "truncated.stl").write_bytes(_good_bytes[:-10])
FIXTURES["truncated"] = TMP / "truncated.stl"
(TMP / "garbage.stl").write_bytes(np.random.default_rng(0).bytes(1000))
FIXTURES["garbage"] = TMP / "garbage.stl"
(TMP / "tiny.stl").write_bytes(b"not a mesh")
FIXTURES["tiny"] = TMP / "tiny.stl"


# ---- verifier -------------------------------------------------------------------------------

def verdict(name):
    return mesh_verify.verify_file(str(FIXTURES[name]))


def expect_viable(name):
    code, result = verdict(name)
    assert code == 0 and result["viable"], f"{name}: expected viable, got {json.dumps(result)[:600]}"
    return result


def expect_fails(name, *properties, exact=False):
    code, result = verdict(name)
    assert code == 1, f"{name}: expected exit 1, got {code}: {json.dumps(result)[:600]}"
    for prop in properties:
        assert prop in result["failed"], f"{name}: expected {prop} to fail, failed={result['failed']}"
    if exact:
        assert sorted(result["failed"]) == sorted(properties), \
            f"{name}: expected only {properties} to fail, failed={result['failed']}"


def verify_good_meshes():
    for name in ("good_box", "good_sphere", "good_ascii", "solid_header_binary"):
        expect_viable(name)
    box = expect_viable("good_box")
    assert np.allclose(box["stats"]["extents_unitless"], [10, 20, 30]), box["stats"]
    assert box["stats"]["genus"] == 0
    torus = expect_viable("good_torus")
    assert torus["stats"]["genus"] == 1, torus["stats"]
    assert expect_viable("good_sphere")["not_checked"] == ["self_intersection"]


def verify_catches_each_property():
    expect_fails("open_box", "watertight", exact=True)
    expect_fails("flipped_patch", "consistent_winding", exact=True)
    expect_fails("inside_out", "outward", exact=True)
    expect_fails("fragment", "single_shell", exact=True)
    expect_fails("two_solids", "single_shell", exact=True)
    expect_fails("overlapping", "single_shell", exact=True)
    expect_fails("duplicate_face", "no_duplicate", "manifold_edges")
    expect_fails("degenerate", "no_degenerate")
    expect_fails("bowtie", "manifold_verts")
    expect_fails("shared_edge", "manifold_edges")
    expect_fails("stored_normals_flipped", "stored_normals", exact=True)
    expect_fails("flat_sheet", "watertight")
    expect_fails("hollow", "single_shell", exact=True)


def verify_rejects_non_stl():
    for name in ("truncated", "garbage", "tiny"):
        code, result = verdict(name)
        assert code == 2 and not result["viable"] and result["error"], f"{name}: {code} {result}"


# ---- repair ---------------------------------------------------------------------------------

def run_repair(name, *extra):
    out = TMP / f"repaired_{name}{'_'.join(extra).replace('-', '')}.stl"
    report_path = Path(str(out) + ".json")
    for p in (out, report_path):
        if p.exists():
            p.unlink()
    proc = subprocess.run([sys.executable, str(REPAIR), str(FIXTURES[name]), str(out), *extra],
                          capture_output=True, text=True, timeout=600)
    report = json.loads(report_path.read_text()) if report_path.exists() else None
    return proc, out, report


def expect_repaired(name, *extra):
    proc, out, report = run_repair(name, *extra)
    assert proc.returncode == 0, f"{name}: exit {proc.returncode}\n{proc.stderr}"
    assert proc.stdout.strip().splitlines()[-1] == str(out.resolve()), proc.stdout
    code, result = mesh_verify.verify_file(str(out))
    assert code == 0, f"{name}: repaired output fails independent check: {result['failed']}"
    assert report["viable"] and report["output"]["extents_unitless"]
    return report, result


def expect_refused(name, code, *extra, reason=""):
    proc, out, report = run_repair(name, *extra)
    assert proc.returncode == code, f"{name}: expected exit {code}, got {proc.returncode}\n{proc.stderr}"
    assert not out.exists(), f"{name}: a failed repair left an output file behind"
    assert not [p for p in TMP.glob("tmp*.stl")], "a failed repair left a temp file behind"
    assert report and not report["viable"] and reason in report["error"], report
    return report


def repair_passes_good_mesh_through():
    report, result = expect_repaired("good_sphere")
    assert report["dropped_fragments"]["count"] == 0
    assert abs(result["stats"]["volume"] - GOOD_SPHERE.volume) / GOOD_SPHERE.volume < 1e-3
    report, result = expect_repaired("good_torus")
    assert result["stats"]["genus"] == 1


def repair_fixes_what_it_can():
    for name in ("open_box", "flipped_patch", "inside_out", "duplicate_face", "degenerate",
                 "stored_normals_flipped", "good_ascii"):
        expect_repaired(name)
    report, _ = expect_repaired("fragment")
    assert report["dropped_fragments"]["count"] == 1, report["dropped_fragments"]
    report, result = expect_repaired("overlapping")
    assert result["stats"]["shells"] == 1
    assert GOOD_SPHERE.volume < result["stats"]["volume"] < 2 * GOOD_SPHERE.volume


def repair_fills_enclosed_voids():
    report, result = expect_repaired("hollow")
    assert result["stats"]["shells"] == 1
    assert abs(result["stats"]["volume"] - GOOD_SPHERE.volume) / GOOD_SPHERE.volume < 1e-3
    report, result = expect_repaired("trapped_void")
    assert report["filled_cavities"]["count"] == 1, report
    assert abs(report["filled_cavities"]["volumes"][0] + 1) < 1e-6, report["filled_cavities"]
    assert result["stats"]["shells"] == 1


def repair_refuses_to_delete_real_parts():
    expect_refused("two_solids", 5, reason="separate solids")
    report, result = expect_repaired("two_solids", "--keep-largest")
    assert report["dropped_solids"]["count"] == 1
    assert abs(result["stats"]["volume"] - GOOD_SPHERE.volume) / GOOD_SPHERE.volume < 1e-3


def repair_fails_honestly():
    # Exit gate 5: a deliberately bad mesh fails with a real error and no artifact.
    expect_refused("flat_sheet", 5)
    for name in ("garbage", "tiny"):
        expect_refused(name, 2)


def repair_handles_touching_solids():
    # Two solids meeting at one vertex / one edge: neither is a single manifold solid, and there is
    # no honest way to make one. Either outcome is acceptable ONLY if it is honest: a viable file
    # the independent check passes, or exit 5 with nothing written.
    for name in ("bowtie", "shared_edge"):
        proc, out, report = run_repair(name)
        if proc.returncode == 0:
            assert mesh_verify.verify_file(str(out))[0] == 0, name
        else:
            assert proc.returncode == 5 and not out.exists(), f"{name}: {proc.returncode}"
        print(f"      {name}: exit {proc.returncode} — {report.get('error', 'viable')}")


# ---- render worker screening (S19b) -----------------------------------------------------------

_wspec = importlib.util.spec_from_file_location("render_worker", REPO / "tools" / "hermes-render-worker.py")
render_worker = importlib.util.module_from_spec(_wspec)
_wspec.loader.exec_module(render_worker)


def worker_screens_mesh_by_format():
    screen = render_worker.screen_artifact
    for name in ("good_sphere", "good_ascii", "solid_header_binary"):
        assert screen(str(FIXTURES[name]), "mesh") is None, (name, screen(str(FIXTURES[name]), "mesh"))
    glb = TMP / "sphere.glb"
    GOOD_SPHERE.export(glb)
    assert screen(str(glb), "mesh") is None, screen(str(glb), "mesh")
    bad_glb = TMP / "bad_length.glb"
    bad_glb.write_bytes(glb.read_bytes() + b"\0" * 16)
    assert "length" in screen(str(bad_glb), "mesh")
    for name in ("truncated", "garbage"):
        assert screen(str(FIXTURES[name]), "mesh"), f"{name} passed mesh screening"
    png = TMP / "image.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(2000))
    assert screen(str(png), "mesh"), "a PNG passed mesh screening"
    # The other job types are unchanged: an STL is not an image, a PNG still is.
    assert screen(str(FIXTURES["good_sphere"]), "render"), "an STL passed image screening"
    assert screen(str(png), "render") is None


check("verifier passes known-good meshes, binary and ASCII", verify_good_meshes)
check("verifier catches each viability property on its own", verify_catches_each_property)
check("verifier rejects bytes that are not an STL", verify_rejects_non_stl)
check("repair passes a good mesh through unchanged in volume", repair_passes_good_mesh_through)
check("repair fixes holes, winding, orientation, dups, degenerates, fragments, overlaps",
      repair_fixes_what_it_can)
check("repair fills enclosed voids and reports the one it made", repair_fills_enclosed_voids)
check("repair will not silently delete a real part of the model", repair_refuses_to_delete_real_parts)
check("repair fails honestly with no artifact (exit gate 5)", repair_fails_honestly)
check("repair of touching solids is honest either way", repair_handles_touching_solids)
check("render worker screens mesh artifacts by format; other types unchanged",
      worker_screens_mesh_by_format)
print(f"\n{passed} checks passed (fixtures in {TMP})")
