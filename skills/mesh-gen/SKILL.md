---
name: mesh-gen
description: "Turn a description or an existing render into a real, watertight STL for 3D printing, via the fleet's job broker. Use this when The Boss wants an actual printable 3D model file, not a picture of one."
version: 1.1.0
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [TRELLIS.2, image-to-3D, STL, 3D-printing, mesh, job-broker]
prerequisites:
  commands: [curl, jq]
---

# Mesh Generation

**Version:** 1.1.0

> **Not live yet.** The mesh node (`Anvil`, IMPLEMENTATION_PLAN.md S19) has not been stood up. Until it
> is, a mesh job is accepted by the broker and then waits for a worker that does not exist, and the
> command below times out. **If asked for an STL before then, say plainly that 3D model generation is
> not available yet** — do not submit a job and leave it waiting, and never offer a render as if it
> were a model.

The fleet makes a real STL in two broker jobs: a normal render (on `Kiln`) of the object on a plain
background, then a `mesh` job (on `Anvil`) that turns that image into a 3D mesh with TRELLIS.2 and
repairs it into a single watertight, manifold solid. There is no other way to produce a real mesh, and
nothing about writing OpenSCAD, "blueprints" or descriptive text produces one.

## How to use it

From a description (renders a reference image first, then builds the mesh from it):

```bash
~/HermesAgentV5/tools/hermes-render-request.sh --type mesh --prompt "<the object>"
```

From a render that already exists (skips the render; pass its broker job id):

```bash
~/HermesAgentV5/tools/hermes-render-request.sh --type mesh --prompt "<the object>" --source-job <id>
```

Describe **one object**. Image-to-3D builds whatever is in the picture, so the reference render is
automatically steered toward one whole object on a plain background. Scenes, several objects, or
anything cut off by the frame make poor meshes.

On success it prints the STL's path and sha256. The filename carries the model's size, for example
`mesh-<job>-80.0x40.0x25.5.stl`.

**The STL is not posted to FleetOps.** It is saved to NAS2, next to its repair report
(`<same name>.json`). Every STL is there, or the job failed. On spark:

```bash
ls -lat /mnt/nas2-hermes-backup/Private/Hermes/Meshes/
```

Point The Boss to the file there. The path the command prints is the broker's own storage, and you
can't open it (see `render-request`).

## What comes back, and what it is not

- **Watertight and verified, not sliced.** Every STL has passed an independent check: one closed,
  manifold solid, consistent outward normals, no degenerate or duplicate faces, no stray pieces. There
  is no G-code and no printer profile. Slicing is out of scope and is not coming (S19c), so do not
  offer it or imply it is pending.
- **No units.** STL does not store units. The numbers in the filename are in the model's own units, not
  millimetres, so The Boss chooses the print scale in their slicer. Say so whenever you report a result.
- **Enclosed voids are filled** and tiny floating fragments are dropped. Both are recorded in the repair
  report.
- **Self-intersection is not checked** by the fleet's own verifier. A slicer may still flag it.

## When it fails

A failure is a real result. Report the error verbatim and stop. The common ones:

- **"separate solids remain after union"** — parts of the model don't join into one solid (a detached
  propeller, parts touching at only a point). The fleet will not silently delete part of a model. It can
  be retried with `--keep-largest` **only if The Boss agrees** to losing the smaller parts.
- **"no viable STL" / "repair failed"** — the generated mesh couldn't be made into a solid. A fresh
  attempt uses a new seed, so re-asking may work; a clearer single-object description helps more.
- **Timeout** — mesh jobs are slow, and part of the work runs on CPU on this GPU class. Pass a generous
  terminal timeout (e.g. `timeout=3600`).

## Rules

- **Never describe or claim an STL without a real path and checksum from this command.** This fleet was
  rebuilt because agents once narrated fabricated renders (`LESSONS_LEARNED.md` §2). A missing or failing
  tool is something to report, not something to fake.
- Don't run `tools/hermes-generate-mesh.py` or `tools/hermes-mesh-repair.py` directly. They belong to
  Anvil's worker; this command is the entrypoint from anywhere else.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-27 | Initial version, written before `Anvil` exists and marked not-live accordingly. Documents `hermes-render-request.sh` 1.4.0's `--type mesh`, the two-job render-then-mesh shape, the S19c viability guarantee, no units, no slicing, and the real failure modes found building the repair chain. |
| 1.1.0 | 2026-09-27 | STLs are stored on NAS2 (`Private/Hermes/Meshes`, with their repair report) and not posted to FleetOps — operator decision, same day. Added where to find them. |
