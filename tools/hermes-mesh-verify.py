#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-09-27, HermesAgentV5 S19, pre-node) — initial version.
#
# hermes-mesh-verify — the INDEPENDENT viability check for an STL (IMPLEMENTATION_PLAN.md S19c,
# exit gate 3: "every property asserted by an independent check — not by the repair tool's own
# self-report").
#
# Independent is meant literally. This file shares no code with tools/hermes-mesh-repair.py and
# imports none of its libraries: no trimesh, no PyMeshLab, no manifold3d. It parses the STL bytes
# itself and derives every property from raw triangle soup with numpy, so a wrong assumption baked
# into one of those libraries cannot certify its own output. Exit gate 4 (opens clean in an
# unrelated third-party tool) is still required on top — this checker can share *our* wrong
# assumptions, just not the repair chain's.
#
# "Viable" (S19c): a single watertight, manifold solid with consistent outward normals, no
# degenerate or duplicate faces, and no stray disconnected shells. Each is its own named check:
#   parse           — the bytes are a structurally valid binary STL (80 + 4 + 50*n == size) or an
#                     ASCII STL whose vertex count is a multiple of 3
#   nonempty, finite
#   no_degenerate   — no face repeats a vertex, no face has zero area
#   no_duplicate    — no two faces use the same three vertices
#   watertight      — every edge is shared by at least two faces (no boundary)
#   manifold_edges  — no edge is shared by more than two faces
#   manifold_verts  — the faces around every vertex form one fan (no "bow-tie" vertices)
#   consistent_winding — every shared edge is traversed once in each direction
#   outward         — signed volume is positive (closed + consistent + positive = outward)
#   stored_normals  — no stored facet normal points against its triangle's winding
#   single_shell    — exactly one edge-connected component
#
# NOT checked, and said so in the output rather than implied: self-intersection. A correct test is
# a triangle-triangle intersection sweep that this file does not implement; manifold3d's output is
# the pipeline's defence there, and exit gate 4's third-party tool is the independent one.
#
# Vertices are welded by EXACT coordinate equality. That is correct for STL written from an indexed
# mesh (the same float32 is written for every use of a vertex), and it is deliberately not
# tolerance-based: a tolerance weld would quietly close near-miss gaps that a slicer might not.
#
# Usage: hermes-mesh-verify.py <file.stl> [--quiet]
#   stdout: one JSON object {"viable": bool, "checks": {...}, "stats": {...}, "not_checked": [...]}
#   exit:   0 viable, 1 not viable, 2 unreadable / not an STL
# Requires: numpy.

import json
import re
import sys

import numpy as np

BINARY_DTYPE = np.dtype([("normal", "<f4", (3,)), ("verts", "<f4", (3, 3)), ("attr", "<u2")])
ASCII_VERTEX_RE = re.compile(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)")
ASCII_NORMAL_RE = re.compile(rb"facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)")


class Unreadable(Exception):
    pass


def parse_stl(data):
    """Returns (triangles[n,3,3] float64, stored_normals[n,3] float64, format). Raises Unreadable."""
    # Binary first: its 80-byte header is free-form and some exporters start it with "solid", so
    # "starts with solid" does NOT mean ASCII. The size identity is the only real binary check.
    if len(data) >= 84:
        count = int.from_bytes(data[80:84], "little")
        if 84 + 50 * count == len(data):
            rec = np.frombuffer(data, dtype=BINARY_DTYPE, count=count, offset=84)
            return rec["verts"].astype(np.float64), rec["normal"].astype(np.float64), "binary"
    if data.lstrip()[:5].lower() == b"solid":
        try:
            verts = np.array(ASCII_VERTEX_RE.findall(data), dtype=np.float64)
            normals = np.array(ASCII_NORMAL_RE.findall(data), dtype=np.float64)
        except ValueError as exc:
            raise Unreadable(f"ASCII STL has a non-numeric coordinate: {exc}")
        if len(verts) % 3:
            raise Unreadable(f"ASCII STL has {len(verts)} vertices, not a multiple of 3")
        tris = verts.reshape(-1, 3, 3)
        if len(normals) != len(tris):
            normals = np.zeros((len(tris), 3))
        return tris, normals, "ascii"
    if len(data) >= 84:
        raise Unreadable(f"not an STL: binary size identity fails (84 + 50*{count} = "
                         f"{84 + 50 * count}, file is {len(data)} bytes) and it does not start "
                         "with 'solid'")
    raise Unreadable(f"not an STL: {len(data)} bytes is shorter than a binary STL header")


class DisjointSet:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, x):
        parent = self.parent
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def verify(data):
    tris, stored_normals, fmt = parse_stl(data)
    checks = {}

    def record(name, ok, detail=""):
        checks[name] = {"ok": bool(ok), "detail": detail}

    record("parse", True, f"{fmt} STL, {len(tris)} triangles")
    record("nonempty", len(tris) > 0, f"{len(tris)} triangles")
    if not len(tris):
        return checks, {}
    finite = bool(np.isfinite(tris).all())
    record("finite", finite, "" if finite else "NaN or infinite coordinate present")
    if not finite:
        return checks, {}

    # Weld by exact coordinate. "+ 0.0" folds -0.0 into 0.0, which compare equal as floats but
    # differ as bytes, and np.unique(axis=0) compares bytes.
    flat = tris.reshape(-1, 3) + 0.0
    verts, inverse = np.unique(flat, axis=0, return_inverse=True)
    faces = inverse.reshape(-1, 3)
    n_faces = len(faces)

    repeated = (faces[:, 0] == faces[:, 1]) | (faces[:, 1] == faces[:, 2]) | (faces[:, 0] == faces[:, 2])
    v0, v1, v2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    cross = np.cross(v1 - v0, v2 - v0)
    area2 = np.linalg.norm(cross, axis=1)
    zero_area = area2 == 0.0
    degenerate = repeated | zero_area
    record("no_degenerate", not degenerate.any(),
           f"{int(repeated.sum())} faces repeat a vertex, {int((zero_area & ~repeated).sum())} "
           "have zero area" if degenerate.any() else "")

    sorted_faces = np.sort(faces, axis=1)
    _, face_counts = np.unique(sorted_faces, axis=0, return_counts=True)
    dup = int((face_counts - 1).sum())
    record("no_duplicate", dup == 0, f"{dup} duplicate faces" if dup else "")

    # Edges. Directed edge i of face f is (faces[f, i], faces[f, (i+1)%3]).
    directed = np.stack([faces, np.roll(faces, -1, axis=1)], axis=2).reshape(-1, 2)
    undirected = np.sort(directed, axis=1)
    edge_keys, edge_inverse, edge_counts = np.unique(
        undirected, axis=0, return_inverse=True, return_counts=True)
    boundary = int((edge_counts == 1).sum())
    over = int((edge_counts > 2).sum())
    record("watertight", boundary == 0, f"{boundary} boundary edges" if boundary else "")
    record("manifold_edges", over == 0, f"{over} edges shared by more than two faces" if over else "")

    _, directed_counts = np.unique(directed, axis=0, return_counts=True)
    repeated_direction = int((directed_counts > 1).sum())
    record("consistent_winding", repeated_direction == 0,
           f"{repeated_direction} directed edges used more than once (adjacent faces disagree "
           "on winding)" if repeated_direction else "")

    # Vertex manifoldness: around vertex v, each incident face contributes the edge between its
    # other two corners (the "link"). The link of a manifold vertex is one connected loop. Nodes
    # are (v, neighbour) pairs; link edges union them; more than one root per v = bow-tie.
    centre = faces.reshape(-1)
    a = np.roll(faces, -1, axis=1).reshape(-1)
    b = np.roll(faces, -2, axis=1).reshape(-1)
    pair_keys, pair_inverse = np.unique(
        np.concatenate([np.stack([centre, a], 1), np.stack([centre, b], 1)]),
        axis=0, return_inverse=True)
    pair_inverse = pair_inverse.reshape(2, -1)
    link = DisjointSet(len(pair_keys))
    for pa, pb in zip(pair_inverse[0].tolist(), pair_inverse[1].tolist()):
        link.union(pa, pb)
    roots = np.array([link.find(i) for i in range(len(pair_keys))])
    fans = np.unique(np.stack([pair_keys[:, 0], roots], 1), axis=0)
    fans_per_vertex = np.bincount(fans[:, 0], minlength=len(verts))
    bowtie = int((fans_per_vertex > 1).sum())
    record("manifold_verts", bowtie == 0,
           f"{bowtie} vertices joined by more than one fan of faces" if bowtie else "")

    # Shells: faces joined through a shared edge.
    shells = DisjointSet(n_faces)
    face_of_directed = np.repeat(np.arange(n_faces), 3)
    order = np.argsort(edge_inverse, kind="stable")
    grouped_edges = edge_inverse[order]
    grouped_faces = face_of_directed[order]
    same = grouped_edges[1:] == grouped_edges[:-1]
    for fa, fb in zip(grouped_faces[:-1][same].tolist(), grouped_faces[1:][same].tolist()):
        shells.union(fa, fb)
    n_shells = len({shells.find(i) for i in range(n_faces)})
    record("single_shell", n_shells == 1, f"{n_shells} disconnected shells" if n_shells != 1 else "")

    volume = float(np.einsum("ij,ij->i", v0, np.cross(v1, v2)).sum() / 6.0)
    record("outward", volume > 0,
           f"signed volume {volume:.6g} — faces wound inward" if volume <= 0 else "")

    # Stored normals: zero normals are allowed (the spec lets readers recompute); a non-zero
    # normal pointing against its own triangle's winding is a real inconsistency.
    stored_len = np.linalg.norm(stored_normals, axis=1)
    usable = (stored_len > 0) & ~degenerate
    against = int(((np.einsum("ij,ij->i", stored_normals, cross) < 0) & usable).sum())
    record("stored_normals", against == 0,
           f"{against} stored normals point against their triangle's winding" if against else "")

    lo, hi = verts.min(axis=0), verts.max(axis=0)
    euler = len(verts) - len(edge_keys) + n_faces
    stats = {
        "triangles": n_faces,
        "vertices": len(verts),
        "edges": len(edge_keys),
        "shells": n_shells,
        "volume": volume,
        "surface_area": float(area2.sum() / 2.0),
        "bbox_min": lo.tolist(),
        "bbox_max": hi.tolist(),
        # STL carries no units (S19c). These are extents in whatever unit the file was written in.
        "extents_unitless": (hi - lo).tolist(),
        "euler_characteristic": int(euler),
    }
    if n_shells == 1 and all(checks[k]["ok"] for k in ("watertight", "manifold_edges", "manifold_verts")):
        stats["genus"] = int((2 - euler) // 2)
    return checks, stats


def verify_file(path):
    """Returns (exit_code, result_dict). Never raises for a bad file."""
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        return 2, {"viable": False, "error": f"cannot read {path}: {exc}"}
    try:
        checks, stats = verify(data)
    except Unreadable as exc:
        return 2, {"viable": False, "error": str(exc)}
    viable = all(c["ok"] for c in checks.values())
    result = {
        "viable": viable,
        "failed": [name for name, c in checks.items() if not c["ok"]],
        "checks": checks,
        "stats": stats,
        "not_checked": ["self_intersection"],
    }
    return (0 if viable else 1), result


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print("usage: hermes-mesh-verify.py <file.stl> [--quiet]", file=sys.stderr)
        return 2
    code, result = verify_file(args[0])
    if "--quiet" not in argv:
        print(json.dumps(result, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
