#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-08) — volumetric fallback. Real TRELLIS.2 output defeats the surgical chain:
# repairing non-manifold edges deletes faces, which opens holes that meshing_close_holes then
# refuses, leaving a manifold-but-open surface that manifold3d rejects. No parameter fixes it
# (--max-hole-edges 200000, method='Split Vertices' and selfintersection=False were all measured
# and all fail), so a component that cannot be repaired surgically is now rebuilt volumetrically
# with screened Poisson, which is closed by construction. Always reported, never silent.
#
# 1.0.0 (2026-09-27, HermesAgentV5 S19, pre-node) — initial version.
#
# hermes-mesh-repair — turns a raw generated mesh into a VIABLE STL, or fails honestly
# (IMPLEMENTATION_PLAN.md S19c; this is the stage's real deliverable).
#
# A generated mesh is not a valid one: it arrives non-manifold, with floating fragments, holes and
# inconsistent winding. "Viable" is defined in S19c and checked by tools/hermes-mesh-verify.py: a
# single watertight, manifold solid with consistent outward normals, no degenerate or duplicate
# faces, and no stray disconnected shells.
#
# The chain, each stage doing the job it is actually good at:
#   1. trimesh   — load (STL/GLB/OBJ/PLY; a GLB scene is flattened with its transforms), drop
#                  degenerate/duplicate faces, split into connected components, and discard
#                  floating fragments below --min-shell-fraction of the largest component's area
#   2. PyMeshLab — per remaining component: remove non-manifold edges/vertices, close holes up to
#                  --max-hole-edges, re-orient faces coherently (repeated, since removing a
#                  non-manifold face opens a new hole)
#   2b. PyMeshLab (fallback) — if a component still is not a manifold after step 2, rebuild it with
#                  screened Poisson reconstruction, which produces a closed surface by construction
#                  rather than by repair, then decimate back to the component's original face count.
#                  This is a LOSS of fine detail and is recorded in the report under
#                  "reconstructed" every time it happens. Poisson also leaves small spurious
#                  shells ("bubbles"); those below --bubble-fraction of the largest reconstructed
#                  shell's volume are dropped and counted. Disable with --no-reconstruct.
#   3. manifold3d — accept each component only if it is a true manifold, union overlapping
#                  components into one solid, and emit a guaranteed-watertight result. Enclosed
#                  voids are FILLED (an inside-out input shell is flipped in step 2 and absorbed by
#                  the union; a void the union itself encloses is dropped and reported) — in
#                  generated meshes they are artifacts, and S19c allows no disconnected shells
#   4. hermes-mesh-verify.py — the independent check. The STL is written to a temp file, verified,
#                  and only renamed into place if every check passes.
#
# Failing honestly is the point (same principle as screen_artifact() and
# hermes-fabrication-guard.sh). A mesh that cannot be made viable exits 5 with the real reason and
# leaves NO output file behind — never a plausible-looking STL that only reveals itself as broken
# in someone's slicer. That includes a model whose significant parts do not touch (a detached
# propeller, say): the repair tool does not silently delete a real part of the model. Pass
# --keep-largest to accept losing them; the report then says exactly what was dropped.
#
# Units: STL has none (S19c). The report records the real bounding-box extents in whatever unit
# the source mesh used; choosing a print scale stays a human decision.
#
# Not handled: self-intersections within a single component (manifold3d assumes its inputs do
# not self-intersect; it does not resolve them). Exit gate 4's third-party tool is the check.
#
# Usage: hermes-mesh-repair.py <input> <output.stl> [--report <path>] [--keep-largest]
#                              [--min-shell-fraction F] [--max-hole-edges N]
#                              [--no-reconstruct] [--reconstruct-depth N]
#   stdout: the output path as the final line (the render worker's artifact convention)
#   report: JSON written to --report (default <output>.json), on failure as well as success
#   exit:   0 viable STL written, 2 unreadable input / bad usage, 5 not repairable,
#           1 the repair tool itself crashed (still reported, still leaves no output file)
# Requires: numpy, scipy, networkx, trimesh, pymeshlab, manifold3d (all have win_amd64 and aarch64
# wheels). scipy and networkx are trimesh graph engines (split(), winding checks) that trimesh
# does not pull in itself — without them the chain fails mid-job, so both are imported up front.

import argparse
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

try:
    import manifold3d
    import networkx  # noqa: F401 — trimesh graph engines: fail at start, not mid-job
    import scipy  # noqa: F401
    import pymeshlab
    import trimesh
except ImportError as exc:
    sys.exit(f"[mesh-repair] missing dependency: {exc} — install scipy, networkx, trimesh, pymeshlab, manifold3d")

_spec = importlib.util.spec_from_file_location(
    "hermes_mesh_verify", Path(__file__).resolve().with_name("hermes-mesh-verify.py"))
mesh_verify = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mesh_verify)

REPAIR_ROUNDS = 3
# Screened-Poisson octree depth for the volumetric fallback. 10 measured on a real TRELLIS.2 figure:
# watertight and manifold in ~11s, against ~6s at depth 9 which kept 4x as many spurious shells.
RECONSTRUCT_DEPTH = 10
# Poisson emits small closed bubbles away from the data. Same spirit as --min-shell-fraction, but by
# volume, and applied only to reconstruction output.
BUBBLE_FRACTION = 0.01
# Poisson fits a surface only where it has evidence, so a large missing region comes back as an open
# boundary rather than a closed cap. Those holes are the whole point of reconstructing, so close them
# all rather than applying the surgical path's --max-hole-edges budget to them.
CLOSE_EVERY_HOLE = 1_000_000
# PyMeshLab moves each copy of a split non-manifold vertex this fraction of the way toward the
# centroid of its own fan of faces — enough to be a distinct float32 position, too little to see.
SPLIT_DISPLACEMENT = 0.01


class Unreadable(Exception):
    pass


class Unrepairable(Exception):
    pass


def log(msg):
    print(f"[mesh-repair] {msg}", file=sys.stderr, flush=True)


def load(path):
    try:
        mesh = trimesh.load(path, force="mesh", process=True)
    except Exception as exc:
        raise Unreadable(f"cannot load {path}: {exc}")
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        raise Unreadable(f"{path} contains no triangles")
    if not np.isfinite(mesh.vertices).all():
        raise Unreadable(f"{path} has NaN or infinite vertex coordinates")
    return mesh


def clean(mesh):
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()
    return mesh


def closed_and_consistent(vertices, faces):
    t = trimesh.Trimesh(vertices, faces, process=False)
    return len(faces) > 0 and t.is_watertight and t.is_winding_consistent


def meshlab_repair(vertices, faces, max_hole_edges):
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=np.asarray(vertices, dtype=np.float64),
                               face_matrix=np.asarray(faces, dtype=np.int32)))
    for _ in range(REPAIR_ROUNDS):
        try:
            ms.meshing_remove_duplicate_vertices()
            ms.meshing_remove_duplicate_faces()
            ms.meshing_remove_null_faces()
            ms.meshing_repair_non_manifold_edges()
            # Displace split copies: undisplaced, they share a position and the STL re-welds them.
            ms.meshing_repair_non_manifold_vertices(vertdispratio=SPLIT_DISPLACEMENT)
            ms.meshing_remove_unreferenced_vertices()
            ms.meshing_close_holes(maxholesize=max_hole_edges)
            ms.meshing_re_orient_faces_coherently()
        except pymeshlab.PyMeshLabException as exc:
            raise Unrepairable(f"PyMeshLab repair failed: {exc}")
        m = ms.current_mesh()
        vertices, faces = m.vertex_matrix(), m.face_matrix()
        if closed_and_consistent(vertices, faces):
            break
    if len(faces) == 0:
        raise Unrepairable("PyMeshLab repair removed every face")
    if trimesh.Trimesh(vertices, faces, process=False).volume < 0:
        faces = faces[:, ::-1]
    return vertices, faces


def to_manifold(vertices, faces, label):
    mesh = manifold3d.Mesh(vert_properties=np.asarray(vertices, dtype=np.float32),
                           tri_verts=np.asarray(faces, dtype=np.uint32))
    mesh.merge()
    solid = manifold3d.Manifold(mesh)
    status = solid.status()
    if status != manifold3d.Error.NoError:
        raise Unrepairable(f"{label} is still not a manifold after repair ({status.name})")
    if solid.is_empty() or solid.volume() <= 0:
        raise Unrepairable(f"{label} encloses no volume after repair")
    return solid


def volumetric_reconstruct(vertices, faces, label, depth):
    """Rebuild a component as a closed surface instead of repairing it into one.

    Screened Poisson fits an implicit surface to the input and meshes its level set, so the result
    is watertight by construction however non-manifold the input was. The cost is fidelity: fine
    detail is smoothed and the face count explodes, so it is decimated back to where it started.
    """
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=np.asarray(vertices, dtype=np.float64),
                               face_matrix=np.asarray(faces, dtype=np.int32)))
    try:
        ms.generate_surface_reconstruction_screened_poisson(depth=depth, preclean=True)
        if ms.current_mesh().face_number() == 0:
            raise Unrepairable(f"{label}: volumetric reconstruction produced no faces")
        if ms.current_mesh().face_number() > len(faces):
            ms.meshing_decimation_quadric_edge_collapse(
                targetfacenum=int(len(faces)), preservenormal=True, preservetopology=True,
                planarquadric=True)
        # Measured: Poisson leaves a boundary where the input was missing a large region (an open
        # cap comes back open), and decimation can leave duplicate or null faces behind. Close and
        # tidy here, or manifold3d rejects an otherwise good reconstruction.
        ms.meshing_close_holes(maxholesize=CLOSE_EVERY_HOLE)
        ms.meshing_remove_duplicate_vertices()
        ms.meshing_remove_duplicate_faces()
        ms.meshing_remove_null_faces()
        ms.meshing_re_orient_faces_coherently()
    except pymeshlab.PyMeshLabException as exc:
        raise Unrepairable(f"{label}: volumetric reconstruction failed: {exc}")
    m = ms.current_mesh()
    v, f = m.vertex_matrix(), m.face_matrix()
    if len(f) == 0:
        raise Unrepairable(f"{label}: volumetric reconstruction left no faces")
    if trimesh.Trimesh(v, f, process=False).volume < 0:
        f = f[:, ::-1]
    return v, f


def drop_bubbles(solid, label, report, fraction):
    """Discard the small spurious shells Poisson leaves behind, counting them in the report."""
    parts = [p for p in solid.decompose() if p.volume() > 0]
    if not parts:
        raise Unrepairable(f"{label}: volumetric reconstruction enclosed no volume")
    largest = max(p.volume() for p in parts)
    keep = [p for p in parts if p.volume() >= fraction * largest]
    if len(keep) < len(parts):
        entry = report.setdefault("reconstruction_bubbles", {"count": 0})
        entry["count"] += len(parts) - len(keep)
        entry["rule"] = f"volume below {fraction:g} of the largest reconstructed shell"
    if len(keep) == 1:
        return keep[0]
    return manifold3d.Manifold.batch_boolean(keep, manifold3d.OpType.Add)


def single_solid(solid, report, keep_largest):
    """Reduces a Manifold to its one solid, filling enclosed voids and refusing to drop real parts
    unless keep_largest. Accumulates what it did into report."""
    # decompose() returns each connected shell. An inside-out one (negative volume) is an
    # enclosed void — e.g. the air pocket left where a nozzle sits in a slightly larger hole, found
    # on a real Bambu hotend model. It is not a separate solid; dropping it fills the void.
    parts = solid.decompose()
    cavities = [p.volume() for p in parts if p.volume() < 0]
    parts = [p for p in parts if p.volume() > 0]
    if cavities:
        filled = report.setdefault("filled_cavities", {"count": 0, "volumes": []})
        filled["count"] += len(cavities)
        filled["volumes"] += cavities
        log(f"filled {len(cavities)} enclosed void(s), total volume {-sum(cavities):.4g}")
    if not parts:
        raise Unrepairable("no positive-volume solid remains after union")
    volumes = [p.volume() for p in parts]
    largest = int(np.argmax(volumes))
    if len(parts) > 1:
        if not keep_largest:
            raise Unrepairable(
                f"{len(parts)} separate solids remain after union (volumes "
                f"{', '.join(f'{v:.4g}' for v in sorted(volumes, reverse=True))}) — real parts of "
                "the model are apart, or touch only at a point or an edge, so they do not join "
                "into one solid. Not deleting them silently; rerun with --keep-largest to keep "
                "only the largest")
        dropped = report.setdefault("dropped_solids", {"count": 0, "volumes": [],
                                                       "rule": "--keep-largest"})
        dropped["count"] += len(parts) - 1
        dropped["volumes"] += [v for i, v in enumerate(volumes) if i != largest]
        log(f"--keep-largest: dropped {len(parts) - 1} separate solid(s)")
    return parts[largest]


def stl_weld(solid):
    """The mesh exactly as an STL reader will see it: float32 positions, welded by position."""
    out = solid.to_mesh()
    vertices = np.asarray(out.vert_properties, dtype=np.float32)[:, :3].astype(np.float64)
    welded = clean(trimesh.Trimesh(vertices, np.asarray(out.tri_verts), process=True))
    return welded.vertices, welded.faces


def stl_clean(vertices, faces):
    t = trimesh.Trimesh(vertices, faces, process=False)
    return (len(faces) > 0 and t.is_watertight and t.is_winding_consistent
            and t.body_count == 1 and t.volume > 0)


def repair(in_path, out_path, report, keep_largest=False, min_shell_fraction=0.01,
           max_hole_edges=2000, reconstruct=True, reconstruct_depth=RECONSTRUCT_DEPTH):
    mesh = clean(load(in_path))
    report["input"] = {
        "faces": int(len(mesh.faces)),
        "vertices": int(len(mesh.vertices)),
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
    }

    components = mesh.split(only_watertight=False)
    areas = np.array([c.area for c in components])
    keep = areas >= min_shell_fraction * areas.max()
    report["input"]["components"] = len(components)
    report["dropped_fragments"] = {
        "count": int((~keep).sum()),
        "faces": int(sum(len(c.faces) for c, k in zip(components, keep) if not k)),
        "rule": f"area below {min_shell_fraction:g} of the largest component",
    }
    significant = [c for c, k in zip(components, keep) if k]
    significant.sort(key=lambda c: c.area, reverse=True)
    log(f"{len(components)} components, {len(significant)} significant, "
        f"{report['dropped_fragments']['count']} fragments dropped")

    solids = []
    for i, comp in enumerate(significant):
        label = f"component {i} ({len(comp.faces)} faces)"
        try:
            v, f = meshlab_repair(comp.vertices, comp.faces, max_hole_edges)
            solids.append(to_manifold(v, f, label))
        except Unrepairable as exc:
            if not reconstruct:
                raise
            # Surgical repair cannot close this one. Rebuild it instead of giving up -- but say so,
            # because the result is a smoothed approximation of the input, not the input repaired.
            log(f"{label}: surgical repair failed ({exc}) - rebuilding volumetrically")
            v, f = volumetric_reconstruct(comp.vertices, comp.faces, label, reconstruct_depth)
            rebuilt = drop_bubbles(to_manifold(v, f, f"{label} after volumetric reconstruction"),
                                   label, report, BUBBLE_FRACTION)
            report.setdefault("reconstructed", []).append({
                "component": i, "reason": str(exc), "poisson_depth": reconstruct_depth,
                "faces_in": int(len(comp.faces)), "faces_out": int(len(f)),
                "detail": "closed by construction, not by repair — fine detail is smoothed"})
            solids.append(rebuilt)
    solid = single_solid(solids[0] if len(solids) == 1
                         else manifold3d.Manifold.batch_boolean(solids, manifold3d.OpType.Add),
                         report, keep_largest)

    # manifold3d is manifold by vertex INDEX; an STL is only positions. Where union surfaces touch
    # tangentially it can keep two vertices at one position (found on a real Bambu hotend model),
    # which the STL then welds into a non-manifold pinch with zero-area slivers. So weld exactly as
    # the STL will, and send anything that breaks back through PyMeshLab — whose vertex split
    # displaces the copies, so they stay apart in the file.
    for round_ in range(REPAIR_ROUNDS):
        vertices, faces = stl_weld(solid)
        if stl_clean(vertices, faces):
            break
        report["post_union_repair_rounds"] = round_ + 1
        log(f"union output is not clean once welded as an STL — repair round {round_ + 1}")
        v, f = meshlab_repair(vertices, faces, max_hole_edges)
        solid = single_solid(to_manifold(v, f, "union result"), report, keep_largest)
    else:
        vertices, faces = stl_weld(solid)

    out_dir = os.path.dirname(os.path.abspath(out_path))
    fd, tmp = tempfile.mkstemp(suffix=".stl", dir=out_dir)
    os.close(fd)
    try:
        trimesh.Trimesh(vertices, faces, process=False).export(tmp, file_type="stl")
        code, verdict = mesh_verify.verify_file(tmp)
        report["verify"] = verdict
        if code != 0:
            raise Unrepairable("repaired mesh failed independent verification: "
                               f"{', '.join(verdict.get('failed', [])) or verdict.get('error')}")
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    report["output"] = {"path": os.path.abspath(out_path),
                        "extents_unitless": verdict["stats"]["extents_unitless"],
                        "triangles": verdict["stats"]["triangles"],
                        "volume": verdict["stats"]["volume"]}


def main(argv):
    ap = argparse.ArgumentParser(description="Repair a generated mesh into a viable STL.")
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--report", help="JSON report path (default <output>.json)")
    ap.add_argument("--keep-largest", action="store_true",
                    help="if separate solids remain, keep only the largest instead of failing")
    ap.add_argument("--min-shell-fraction", type=float, default=0.01,
                    help="components below this fraction of the largest one's area are dropped "
                         "as floating fragments (default 0.01)")
    ap.add_argument("--max-hole-edges", type=int, default=2000,
                    help="largest hole, in boundary edges, that will be closed (default 2000)")
    ap.add_argument("--no-reconstruct", action="store_true",
                    help="do not fall back to volumetric (screened Poisson) reconstruction for a "
                         "component that cannot be repaired surgically; fail instead")
    ap.add_argument("--reconstruct-depth", type=int, default=RECONSTRUCT_DEPTH,
                    help=f"screened-Poisson octree depth for that fallback "
                         f"(default {RECONSTRUCT_DEPTH}; higher is finer and slower)")
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        return 2
    report_path = args.report or args.output + ".json"
    report = {"input_path": os.path.abspath(args.input), "viable": False}

    code = 0
    try:
        repair(args.input, args.output, report, keep_largest=args.keep_largest,
               min_shell_fraction=args.min_shell_fraction, max_hole_edges=args.max_hole_edges,
               reconstruct=not args.no_reconstruct, reconstruct_depth=args.reconstruct_depth)
        report["viable"] = True
    except Unreadable as exc:
        report["error"], code = str(exc), 2
    except Unrepairable as exc:
        report["error"], code = str(exc), 5
    except Exception as exc:
        # A bug in this tool is still a failed job, reported like one — never a traceback with
        # no report, and never a half-written file (repair() only renames after verification).
        report["error"], code = f"repair tool crashed: {exc!r}", 1

    with open(report_path, "w") as fh:
        json.dump(report, fh, indent=2)
    if code:
        log(f"FAILED: {report['error']}")
        return code
    extents = " x ".join(f"{e:.4g}" for e in report["output"]["extents_unitless"])
    log(f"viable: {report['output']['triangles']} triangles, extents {extents} (no units)")
    print(os.path.abspath(args.output))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
