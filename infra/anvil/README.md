# Anvil — mesh node setup checklist

**Version:** 2.3.0

Ordered steps to stand up `Anvil`, the fleet's mesh node (IMPLEMENTATION_PLAN.md S19): a Windows box that
turns a finished render into a viable STL. This file is the recipe; S19 in the plan is the
reasoning (why not the Sparks, why TRELLIS.2, what "viable" means). Like `Kiln`, Anvil is a **tooling
endpoint** — no agent, no persona, no Matrix identity. Its only job is pulling `mesh` jobs from the broker.

**Status (2026-10-04): ComfyUI updated, models in place, win_amd64 gate closed. The exported workflow
is the only remaining pre-node item, and it needs the GUI.** `Anvil` is the operator's own Windows workstation,
`PMWIN11` — see "1. The hardware" for what is actually in it. Everything below that does not need the node
is already built and tested — see "What already exists".

> **Route change, 2026-10-03.** Steps 2 and 3 were rewritten. TRELLIS.2 runs on **ComfyUI's own native
> nodes** as of ComfyUI 0.34.0 (2026-08-31); the `visualbruno/ComfyUI-Trellis2` custom node, its Torch 2.10
> wheel pin, its `blackwell_fix.py` CPU fallback and its gated DINOv3 clone are **all withdrawn**. Nothing
> is compiled and nothing is gated any more. S19a in the plan carries the full reasoning and a table of
> what was deleted.

The operator decisions the plan required are made (2026-09-27):

| Decision | Chosen | Built as |
|---|---|---|
| Service wrapper | **NSSM** | `install-anvil.ps1` (services `HermesComfyUI`, `HermesMeshWorker`) |
| Secrets | **native `bw` CLI** | `tools/vault-get-secret.ps1`, `set-vault-bootstrap.ps1`, `hermes-mesh-worker.ps1` |
| Repo sync | **scheduled task, every 30 min** | `hermes-repo-sync.ps1`, task `HermesRepoSync` |
| Where STLs go | **NAS2**, not FleetOps | `mesh` is a quiet broker type; the worker's copy to NAS2 is required and hash-verified |

## What already exists (built before the node)

| Piece | Where | Tested by |
|---|---|---|
| Repair chain → viable STL or honest failure | `tools/hermes-mesh-repair.py` | `tests/test_mesh_pipeline.py` |
| Independent viability checker (exit gate 3) | `tools/hermes-mesh-verify.py` | `tests/test_mesh_pipeline.py` |
| Generation script: broker image → ComfyUI → repair | `tools/hermes-generate-mesh.py` | `tests/test_mesh_e2e.py` (fake ComfyUI) |
| Worker: `source_job` passthrough, `.py` scripts, mesh screening | `tools/hermes-render-worker.py` 1.7.0 | both of the above |
| Client: `--type mesh` (render first, or `--source-job`) | `tools/hermes-render-request.sh` 1.4.0 | `tests/test_mesh_e2e.py` |
| `media` topic route, **off** (`MESH_ENABLED=0`) | `tools/hermes-media.py` 1.3.0 | `tests/test_media_mesh.py` |
| Exact library pins | `requirements-mesh.txt` | **passed on aarch64 and win_amd64** (2026-10-04) |
| Required NAS2 copy of every STL + its report | `tools/hermes-generate-mesh.py` 1.1.1 | `tests/test_mesh_e2e.py` |
| Windows services, secrets, repo sync | `install-anvil.ps1` and friends | `tests/test_windows_scripts.ps1` (on Windows) |

The only things missing are the ones that need the GPU: a ComfyUI at 0.34.0+ with the TRELLIS.2 models,
and the exported workflow.

## 1. The hardware

**Done 2026-10-03.** Read off the machine rather than recalled, which corrected the plan:

```
> nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
NVIDIA GeForce RTX 5060 Ti, 16311 MiB, 610.88      # one GPU; compute capability (12, 0)
```

Host `PMWIN11`, i9-12900K, 128GB system RAM, Windows 11 Pro.

**This is a 16GB card, not the 32GB 5090 S19 was planned against** — and not the 24GB the plan's open
discrepancy guessed at either. It resolves below both. The architecture is unchanged (`sm_120` either way),
so every Blackwell finding still applies; only the memory budget moved, and it moved down. S19a has the
VRAM arithmetic: the int8 shape-only path is ≈7.6GB resident, so it should fit with roughly 8GB to spare,
but that is arithmetic and **exit gate 2 is still the measurement**.

Two further facts about this node that the plan did not anticipate, both worth keeping in mind below:

- It is a **workstation someone uses**, not a dedicated appliance like `Kiln`. Mesh jobs compete for the
  same 16GB as whatever is on screen.
- Its ComfyUI is **StabilityMatrix-managed** and shared with a working image/video setup, so an update
  there can move ComfyUI underneath the services step 5 installs.

Already verified present on this box: **Bambu Studio** (exit gate 4's third-party tool), the NAS2 `PMoney`
share (`\\10.129.1.167\PMoney`, with `\Private\Hermes` present), and broker reachability
(`http://10.129.1.15:8100/health` returns `{"ok": true}`). Not present yet: NSSM, the `bw` CLI, the
`C:\hermes` tree, and the mesh venv.

## 2. ComfyUI + TRELLIS.2

**No custom node, no compiled extensions, no wheel pin.** TRELLIS.2 is native in ComfyUI from 0.34.0;
upstream's own words are *"If your ComfyUI runs, these models run on your current PyTorch."* Follow the
[official tutorial](https://docs.comfy.org/tutorials/3d/trellis2) and **record here what you actually ran**.

- **Update ComfyUI to ≥ 0.34.0. Done 2026-10-04: `v0.31.0` → `v0.38.2`** (latest stable, which also
  carries the TRELLIS.2 fixes that landed after 0.34.0). Exactly what was run, in
  `E:\GenAI\StabilityMatrix\Data\Packages\ComfyUI`:

  ```powershell
  # rollback reference, recorded first: 43cb4fff = tag v0.31.0, tree clean, nothing running on 8188
  git -C $c fetch --tags origin
  git -C $c checkout v0.38.2
  & "$c\venv\Scripts\python.exe" -m pip install -r "$c\requirements.txt"
  ```

  Nine packages changed (frontend 1.48.7→1.53.6, workflow-templates, embedded-docs, `comfy-kitchen`,
  `comfy-aimdo`); **`torch` is unpinned in ComfyUI's requirements at both versions, so it was not touched** —
  still 2.13.0+cu130 on Python 3.12.11, CUDA available on `sm_120`. Nothing needed downgrading, which is the
  native route's whole point.

  Verified after the update, not assumed: `main.py --quick-test-for-ci` exits **0** with no `IMPORT FAILED`,
  **all 16 custom-node packs still import** (the existing image/video setup is intact), 1734 node classes
  register, and a real server start answers `/system_stats` with `0.38.2` and `cuda:0 NVIDIA GeForce
  RTX 5060 Ti, 16311 MiB`. StabilityMatrix's own `settings.json` was updated to
  `"InstalledReleaseVersion": "v0.38.2"` so its UI does not desync from the git-side update.
- **Fetch the model files. Done 2026-10-04 (10.2 GB).** They went into StabilityMatrix's **shared** model
  folders, not the package-local `models/` tree, because that is what this install resolves through its
  `extra_model_paths.yaml` and it survives a package reinstall:

  | File | From | Shared folder | Size |
  |---|---|---|---|
  | `trellis_2_int8_convrot.safetensors` | `Comfy-Org/TRELLIS.2` | `Data/Models/DiffusionModels` | 5.253 GB |
  | `trellis_2_shape_vae_bf16.safetensors` | `Comfy-Org/TRELLIS.2` | `Data/Models/VAE` | 1.096 GB |
  | `trellis_2_texture_vae_bf16.safetensors` | `Comfy-Org/TRELLIS.2` | `Data/Models/VAE` | 0.948 GB |
  | `dino_v3_L_naf_fp32.safetensors` | **`Comfy-Org/Pixal3D`** | `Data/Models/ClipVision` | 1.215 GB |
  | `dino_v3_vit_l.safetensors` | `Comfy-Org/TRELLIS.2` | `Data/Models/ClipVision` | 1.213 GB |
  | `birefnet.safetensors` | `Comfy-Org/BiRefNet` | `Data/Models/BackgroundRemoval` | 0.444 GB |

  Every file was header-verified as real safetensors after download (a truncated file or a saved HTML error
  page would not parse), and ComfyUI's `/models/<folder>` endpoints confirm it lists all of them.

  **Use the int8 transformer, not `trellis_2_bf16.safetensors` (10.338 GB).** On a 16GB card that choice is
  the difference between fitting and not — see S19a.

  **Both DINOv3 files are here on purpose.** The shipped template's `CLIPVisionLoader` defaults to
  `dino_v3_L_naf_fp32.safetensors`, which lives in the **Pixal3D** repo rather than TRELLIS.2's — the
  template is a combined graph and shares its conditioning loader between both branches. The two files are
  **not** the same artifact (452 vs 415 tensors), so the template-expected one was fetched rather than
  assuming the TRELLIS.2 repo's was interchangeable. Keep both until a real run shows which the shape path
  actually wants.

  **Not needed, confirmed from the template's own link graph rather than assumed:** `Comfy-Org/MoGe`
  (`moge_2_vitl_normal_fp16.safetensors`) and `pixal3d_int8_convrot.safetensors`. `LoadMoGeModel` →
  `MoGeInference` → `MoGeGeometryToFOV` feeds **only** `Pixal3DConditioning`; `Trellis2Conditioning` takes
  just a `CLIP_VISION` and an `IMAGE`. Skipping those saves ~6.2 GB and is why the download was 10.2 GB and
  not 17.
- **DINOv3 is not gated on this route.** It ships as `dino_v3_vit_l.safetensors` from `Comfy-Org/TRELLIS.2`.
  The Meta access approved 2026-09-27 is a spare; do not clone `facebook/dinov3-*` into the node.
- **Shape only.** Skip the texturing stage — STL cannot carry materials at all, so texture work is pure
  cost. Keep the shape VAE, leave the texture VAE unwired (or undownloaded).
- **Watch `DecimateMesh`'s `target_face_count`.** Upstream's 12GB report had to lower it from the template
  default of 700000 ([ComfyUI #16056](https://github.com/Comfy-Org/ComfyUI/issues/16056)). If a job dies on
  memory, this is an early knob — along with resolution.

**Network posture: ComfyUI listens on loopback only.** Start it **without** `--listen` (ComfyUI's default
bind is `127.0.0.1`). The worker is on the same machine and only makes outbound calls, so nothing on the LAN
ever needs port 8188 — stricter than the plan's "scope it to fleet hosts", and it cannot repeat S10's
`Kiln` finding (8188 open to the whole LAN). Belt and braces:

```powershell
New-NetFirewallRule -DisplayName "ComfyUI 8188 - no inbound (Anvil)" -Direction Inbound `
  -Protocol TCP -LocalPort 8188 -Action Block
```

Check from a Spark afterwards that `curl -m 5 http://<anvil-ip>:8188/` fails.

## 3. Export the workflow

**The template to start from is `3d_pixal3d_trellis2_image_to_model`**, shipped inside the
`comfyui_workflow_templates_json` package (66 nodes). Two things about it to know before loading:

- **It serves Pixal3D *and* TRELLIS.2 from one graph**, switched by `ComfySwitchNode`s driven by a
  `PrimitiveBoolean` titled "Boolean (Switch to Trellis2)" — which ships set to `False`. Check which branch
  that actually selects before concluding a run used TRELLIS.2 at all.
- **Its texture half is substantial**, so stripping it is most of the work. The nodes on the texture side,
  read from the template: `Trellis2TextureStage`, `VaeDecodeTextureTrellis`, `BakeTextureFromVoxel`,
  `ApplyTextureToMesh`, `PaintMesh`, `BakeNormalMapFromMesh`, `BakeAmbientOcclusion`, `RenderUVAtlas`,
  `UnwrapMesh`, the texture `VAELoader`, and the Base Color / Metallic / Roughness / Normal / AO
  `PreviewImage` nodes. The shape side keeps the shape `VAELoader`, `VoxelToMesh`, `RemeshMesh`,
  `DecimateMesh`, `MeshSmoothNormals` and a `MeshToFile3D` / `Save3DAdvanced` export.

Partial wiring verified from the template's links, enough to recognise the shape chain:
`CLIPVisionLoader` → `Trellis2Conditioning`; `VaeDecodeStructureTrellis2` (VOXEL) + conditioning →
`Trellis2ShapeStage` → `Trellis2UpsampleStage` (which also takes a `KSampler` LATENT and the shape
`VAELoader`) → `VaeDecodeShapeTrellis`.

The eight node classes 0.38.2 actually registers, read off the running instance rather than guessed:
`EmptyTrellis2LatentStructure`, `Trellis2Conditioning`, `Trellis2ShapeStage`, `Trellis2TextureStage`,
`Trellis2UpsampleStage`, `VaeDecodeShapeTrellis`, `VaeDecodeStructureTrellis2`, `VaeDecodeTextureTrellis`.
**For the shape-only path, the two to leave out are `Trellis2TextureStage` and `VaeDecodeTextureTrellis`.**
Build the graph from the shipped template rather than wiring it from that list — the names are recorded here
to identify what to drop, not as a verified topology.

1. In the ComfyUI GUI (on Anvil itself, at `http://127.0.0.1:8188`), start from the **TRELLIS.2 template
   that ships with ComfyUI 0.34.0+**, strip it to the shape path (no texturing — see step 2), and run it
   once by hand on a test image until it produces a `.glb`.
2. **Workflow → Export (API)**. Save it as `infra/anvil/workflows/trellis2-mesh-only.api.json`.
3. Edit that file: set the `LoadImage` node's `image` input to the literal string `"{{INPUT_IMAGE}}"`, and
   every `seed` input to `"{{SEED}}"` (quoted — the script swaps it for a random integer, so a broker retry
   is a genuinely different attempt, not a replay of the failure).
4. Commit it. `hermes-generate-mesh.py` refuses to run without it rather than guess a node graph.

## 4. The mesh worker's Python

A venv of its own, **not** ComfyUI's — the repair chain's numpy/scipy pins must not fight Torch's.

**Note for this box (2026-10-03):** there is no `py` launcher installed and the `python` on PATH is
3.13.14. The pins in `requirements-mesh.txt` were proven on 3.12. Either install the `py` launcher / a
3.12 interpreter, or point the venv at ComfyUI's own 3.12.11
(`E:\GenAI\StabilityMatrix\Data\Packages\ComfyUI\venv\Scripts\python.exe -m venv ...` — this creates a
*separate* venv and does not share ComfyUI's packages). If 3.13 is used instead, re-pin against a passing
run rather than assuming the 3.12 set carries over.

```powershell
git clone https://github.com/madbikernc/HermesAgentV5.git C:\hermes\HermesAgentV5
py -3.12 -m venv C:\hermes\venv
C:\hermes\venv\Scripts\python -m pip install -r C:\hermes\HermesAgentV5\infra\anvil\requirements-mesh.txt
C:\hermes\venv\Scripts\python C:\hermes\HermesAgentV5\infra\anvil\tests\test_mesh_pipeline.py
```

That last line is the **win_amd64 gate**: the pins were only proven on aarch64. All checks must pass here
before the worker runs. (`test_mesh_e2e.py` needs bash/curl/jq and stays a Spark-side test.)

**Done 2026-10-04 — the gate is closed.** The venv was built from ComfyUI's own 3.12.11 interpreter (this
box has no `py` launcher) and is fully isolated — it does not see ComfyUI's packages:

```powershell
& "E:\GenAI\StabilityMatrix\Data\Packages\ComfyUI\venv\Scripts\python.exe" -m venv C:\hermes\venv
& "C:\hermes\venv\Scripts\python.exe" -m pip install -r <repo>\infra\anvil\requirements-mesh.txt
& "C:\hermes\venv\Scripts\python.exe" <repo>\infra\anvil\tests\test_mesh_pipeline.py   # 10/10 PASS
```

**All six pins resolved to the exact same versions on win_amd64/cp312 as on aarch64** — numpy 2.5.3,
scipy 1.18.1, networkx 3.7, trimesh 5.1.0, pymeshlab 2025.7.post1, manifold3d 3.5.4 — so
`requirements-mesh.txt` needs no per-platform split and is **not** re-pinned. All 10 check groups pass,
including exit gate 5's honest-failure cases.

`tests/test_windows_scripts.ps1` was also re-run here (**10/10**, Windows PowerShell 5.1) so the service,
vault and repo-sync scripts are verified on the real node rather than on another Windows machine.

Still unexercised, unchanged by this: the **post-union PyMeshLab retry loop**, which no real input has hit —
the suite's fixtures are synthetic, and the hotend that originally provoked a weld fixed itself. A real
TRELLIS.2 mesh is the first thing that could exercise it.

## 5. Services, secrets, NAS2 and repo sync

**Prerequisites:**
- **NSSM** at `C:\hermes\nssm\nssm.exe`.
- The **Bitwarden CLI** (`bw`) on the system PATH.
- A local **service account** (default `.\hermes`), not an administrator, that both services run as.
- A **Vaultwarden account for Anvil** that can see only the `broker-token` item.
- `powershell -File infra\anvil\tests\test_windows_scripts.ps1` passing on Anvil.

**a. Install**, elevated, once. Re-running it is safe:

```powershell
C:\hermes\HermesAgentV5\infra\anvil\install-anvil.ps1 -ComfyDir C:\hermes\ComfyUI `
  -ComfyPython C:\hermes\ComfyUI\venv\Scripts\python.exe
```

It creates:
- the `HermesComfyUI` service (loopback only)
- the `HermesMeshWorker` service, which depends on it, restarts 15s after any exit, and logs to
  `C:\ProgramData\Hermes\logs`
- the inbound block rule for port 8188
- the `HermesRepoSync` task

It also sets the worker's environment:

| Variable | Value |
|---|---|
| `BROKER_URL` | `http://10.129.1.15:8100`. This only works if Anvil is on `10.129.1.0/24`, which the broker's ufw rule already admits. On any other network, add a narrow ufw rule on spark first. |
| `WORKER_NAME` / `JOB_TYPE` / `POLL_SECONDS` | `anvil` / `mesh` / `10` |
| `GENERATE_SCRIPT` | `tools\hermes-generate-mesh.py`, run through the venv's Python |
| `JOB_TIMEOUT`, `MESH_COMFY_TIMEOUT` | **PROVISIONAL `3600`**, replaced by exit gate 2's measurement |
| `MESH_OUT_DIR` | `C:\hermes\mesh-out` |
| `MESH_ARCHIVE_DIR` | `\\10.129.1.167\PMoney\Private\Hermes\Meshes` |
| `BROKER_TOKEN` | not in NSSM at all. `hermes-mesh-worker.ps1` fetches it from the vault into memory at each start. |

**b. Vault bootstrap, as the service account.** DPAPI ties the encrypted file to whoever writes it, so
this step must run as the service account. The script checks that it can actually fetch `broker-token`
before it reports success.

```powershell
runas /user:.\hermes "powershell -NoProfile -ExecutionPolicy Bypass -File C:\hermes\HermesAgentV5\infra\anvil\set-vault-bootstrap.ps1"
```

It asks for four things:
- the server URL
- the API key's client id and secret
- the master password
- a copy of the fleet's `vw-lan.crt`

These are the same bootstrap credentials the Linux nodes keep in `/etc/credstore.encrypted`.

**c. NAS2 access, also as the service account.** Every STL is copied to NAS2, and the copy is re-read to
check its hash. If that copy fails, **the job fails** with exit 8 and the broker retries it. NAS2 is the
only place a human can reach the file: `mesh` is a quiet broker type, and the broker's own artifact
directory is closed to everyone but the broker.

```powershell
runas /user:.\hermes "cmdkey /add:10.129.1.167 /user:<NAS2 user> /pass"
```

> **Verify before relying on it:** the Sparks mount this volume over **NFS**
> (`10.129.1.167:/volume1/PMoney`). The SMB share name `PMoney` is an assumption that Synology's usual
> share-per-folder naming holds. Check `Test-Path \\10.129.1.167\PMoney\Private\Hermes` as the service
> account. On a Spark the same folder is `/mnt/nas2-hermes-backup/Private/Hermes/Meshes`.

**d. Start** (`Start-Service HermesComfyUI, HermesMeshWorker`). Its log should show `polling ... for
type='mesh' jobs`.

## 6. Keeping the checkout current

`HermesRepoSync` runs `hermes-repo-sync.ps1` as SYSTEM every 30 minutes and at boot. It pulls with
`--ff-only`, restarts `HermesMeshWorker` if `HEAD` moved, and logs to
`C:\ProgramData\Hermes\logs\repo-sync.log`. It is the Windows analogue of `hermes-repo-sync.sh` 2.0.0.

A checkout that has diverged is logged as an ERROR and left alone, never merged. So don't edit files in
Anvil's checkout: change them in the repo and let the task bring them down.

## 7. Go live

In this order, each after the one before it works:

1. **Exit gate 1:** `hermes-render-request.sh --type mesh --prompt "..."` from a Spark produces a real STL
   through the broker — not by hand in the GUI.
2. **Exit gate 2:** read `timings` from `MESH_OUT_DIR\<job>\repair-report.json` across several real jobs,
   then set `JOB_TIMEOUT`, `MESH_COMFY_TIMEOUT`, the client's mesh `POLL_TRIES`, and check the broker's
   fleet-wide `BROKER_LEASE_SECONDS` (currently 2400) is above the worst real job — or add a per-type lease.
   Record the measurements here, the way `infra/comfyui/README.md` records video timings.
3. **Exit gates 3–5:** the tests already cover 3 and 5 with synthetic meshes; repeat both on real TRELLIS.2
   output, and open the STL in Bambu Studio (installed on the operator's PC) for gate 4.
4. **Exit gate 6:** re-run the F4U Corsair from the earlier off-fleet experiment (its STL is not on the
   operator's PC; it is probably on the old 3080 Ti box).
5. ~~Make `mesh` a quiet broker type.~~ **Done 2026-09-27:** the repo's `hermes-broker.service` was
   installed live on spark, and the broker now runs with `BROKER_QUIET_TYPES=embed,wake,mesh`. The
   previous unit is kept at `/etc/systemd/system/hermes-broker.service.bak-2026-09-27`.
6. Set `MESH_ENABLED=1` in hermes-media's service environment on spark-2.
7. Update the dispatcher's `media` target description in `tools/hermes-dispatch.py` ("generate an image or
   video via the render broker") to include 3D-printable meshes, so requests actually reach the route.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-27 | Initial checklist, written before the node exists: what is already built and tested, the install constraints S19a verified, loopback-only ComfyUI, workflow export with `{{INPUT_IMAGE}}`/`{{SEED}}` placeholders, the win_amd64 test gate, three named operator decisions (service wrapper, secrets, repo sync), and the go-live order. |
| 1.1.0 | 2026-09-27 | Operator decisions made and built, same day: NSSM (`install-anvil.ps1`: `HermesComfyUI` loopback-only + `HermesMeshWorker`), native `bw` (`tools/vault-get-secret.ps1`, `set-vault-bootstrap.ps1`, `hermes-mesh-worker.ps1`; bootstrap DPAPI-bound to the service account), 30-minute `HermesRepoSync` task (`hermes-repo-sync.ps1`), and STLs stored on NAS2 rather than posted to FleetOps (`mesh` quiet, required hash-verified NAS2 copy, `MESH_ARCHIVE_DIR`). Flagged the SMB share name `PMoney` as an assumption to verify — the Sparks reach NAS2 over NFS. Windows scripts tested by `tests/test_windows_scripts.ps1`. |
| 1.2.0 | 2026-09-27 | Go-live step 5 done: `mesh` quiet on the live broker (unit installed on spark, backup kept). |
| 2.0.0 | 2026-10-03 | **Node identified and generation route replaced.** `Anvil` is the operator's own workstation `PMWIN11`; step 1 is now the recorded hardware rather than a command to run, and it corrects the plan — an **RTX 5060 Ti with 16GB**, not a 32GB 5090, resolving below the 24GB the open discrepancy guessed at. Steps 2 and 3 rewritten for ComfyUI's **native** TRELLIS.2 nodes (0.34.0, 2026-08-31), which landed four weeks before S19 was planned: the `visualbruno/ComfyUI-Trellis2` custom node, the Torch 2.10/CUDA 13.1 wheel pin, `blackwell_fix.py`'s CPU marching-cubes fallback and the gated DINOv3 clone are all withdrawn — nothing is compiled, nothing is gated. Step 2 now lists the exact model files and sizes, and calls out using the **int8** transformer (5.253 GB) over bf16 (10.338 GB), which on 16GB is the difference between fitting and not. Recorded what is already on the box: Bambu Studio (exit gate 4's tool), the NAS2 `PMoney` share mounted with `\Private\Hermes` present (closing 1.1.0's unverified-share-name note), and a reachable broker. Recorded what is missing: ComfyUI is **0.31.0** and must be updated, and NSSM, `bw`, `C:\hermes` and the mesh venv do not exist. Added a step-4 warning that this box has no `py` launcher and a 3.13 PATH python against 3.12-proven pins. Two node properties the plan did not anticipate are now stated here: it is an interactive workstation, and its ComfyUI is StabilityMatrix-managed and shared with a working image/video setup. |
| 2.1.0 | 2026-10-04 | **ComfyUI updated on the node: `v0.31.0` → `v0.38.2`** — install gate 1 cleared. Step 2 now records exactly what was run (fetch, checkout, `pip install -r requirements.txt`) with the pre-update rollback reference, plus what it verified: `--quick-test-for-ci` exits 0 with no import failures, **all 16 custom-node packs still import** so the existing image/video setup is intact, 1734 node classes register, and a real server start answers `/system_stats` with `0.38.2` and `cuda:0 NVIDIA GeForce RTX 5060 Ti, 16311 MiB`. Nine packages changed and **`torch` was not touched** (unpinned in ComfyUI's requirements at both versions) — still 2.13.0+cu130, which is the native route's whole point. Went to latest stable rather than the 0.34.0 minimum because 0.34.0 predates the TRELLIS.2 fixes that followed it. StabilityMatrix's `settings.json` was updated to match so its UI does not desync from a git-side update. Step 3 now lists the **eight TRELLIS.2 node classes read off the running instance**, naming `Trellis2TextureStage` and `VaeDecodeTextureTrellis` as the two to omit for the shape-only path — recorded to identify what to drop, explicitly not as a verified topology. Remaining before go-live: fetch the model files, then export the workflow. |
| 2.2.0 | 2026-10-04 | **The win_amd64 test gate is closed.** The mesh venv was built from ComfyUI's own 3.12.11 interpreter (step 4's `py -3.12` does not work here — no `py` launcher) and verified isolated from ComfyUI's packages. **All six pins resolved to the identical versions on win_amd64/cp312 as on aarch64**, so `requirements-mesh.txt` needs no per-platform split and was not re-pinned. `test_mesh_pipeline.py` passes **10/10** on Windows, the suite's first run off aarch64, and `test_windows_scripts.ps1` was re-run on the real node (**10/10**, PowerShell 5.1) rather than trusted from another machine. Step 4 records the exact commands. Noted as still unexercised: the post-union PyMeshLab retry loop, which only a real TRELLIS.2 mesh can reach. |
| 2.3.0 | 2026-10-04 | **TRELLIS.2 models fetched and verified (10.2 GB); step 3 now names the real template.** Files went into StabilityMatrix's **shared** model folders rather than the package-local tree, since that is what this install resolves via `extra_model_paths.yaml` and it survives a package reinstall. Each was header-verified as real safetensors after download, and ComfyUI's `/models/<folder>` endpoints confirm it lists all of them. **Both DINOv3 files are present deliberately:** the shipped template's `CLIPVisionLoader` defaults to `dino_v3_L_naf_fp32.safetensors`, which lives in the **Pixal3D** repo and not TRELLIS.2's, and the two files are **not** the same artifact (452 vs 415 tensors) — so the template-expected one was fetched rather than assuming interchangeability. **`Comfy-Org/MoGe` and `pixal3d_int8_convrot` were confirmed unnecessary from the template's own link graph**, not assumed: the MoGe chain feeds only `Pixal3DConditioning`, while `Trellis2Conditioning` takes just a `CLIP_VISION` and an `IMAGE` — which is why this was 10.2 GB instead of 17. Step 3 now names the template (`3d_pixal3d_trellis2_image_to_model`, 66 nodes), warns that it serves both models behind a `PrimitiveBoolean` shipping as `False`, and lists the texture-side nodes to strip and the shape-side chain to keep, with the partial wiring that was actually traced. |
