# Anvil — mesh node setup checklist

**Version:** 1.2.0

Ordered steps to stand up `Anvil`, the fleet's mesh node (IMPLEMENTATION_PLAN.md S19): a Windows box with
an RTX 5090 that turns a finished render into a viable STL. This file is the recipe; S19 in the plan is the
reasoning (why not the Sparks, why TRELLIS.2, what "viable" means). Like `Kiln`, Anvil is a **tooling
endpoint** — no agent, no persona, no Matrix identity. Its only job is pulling `mesh` jobs from the broker.

**Status (2026-09-27): not stood up.** Everything below that does not need the node is already built and
tested — see "What already exists". The operator decisions the plan required are made (2026-09-27):

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
| Exact library pins | `requirements-mesh.txt` | all tests passed against it on aarch64 |
| Required NAS2 copy of every STL + its report | `tools/hermes-generate-mesh.py` 1.1.0 | `tests/test_mesh_e2e.py` |
| Windows services, secrets, repo sync | `install-anvil.ps1` and friends | `tests/test_windows_scripts.ps1` (on Windows) |

The only thing missing is the thing that needs the GPU: TRELLIS.2 in ComfyUI, and the exported workflow.

## 1. Record the hardware

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
```

Write the real VRAM figure into S19a's open discrepancy (described as 24GB; a retail 5090 is 32GB) before
anyone sizes anything against it.

## 2. ComfyUI + TRELLIS.2

The plan verified the constraints, not a command transcript, so follow `visualbruno/ComfyUI-Trellis2`'s own
README for the exact commands and **record here what you actually ran**:

- **Torch 2.10 / CUDA 13.1, Python 3.11–3.13.** That is the Windows wheel set the repo ships (`cumesh`,
  `custom_rasterizer`, `flex_gemm`, `nvdiffrast`, `o_voxel`, `natten`, `dcx_pkg`). **Do not install Torch
  2.11** — no Windows wheels exist for it (upstream issue #184).
- **Apply `blackwell_fix.py`.** CuMesh's remeshing is broken on `sm_120`; the fix moves mesh extraction to
  CPU marching cubes. Expect CPU time in every job.
- **DINOv3** (`facebook/dinov3-vitl16-pretrain-lvd1689m`, access approved 2026-09-27) cloned into
  `ComfyUI/models/facebook/`. It is Meta's `dinov3-license`, not MIT — do not redistribute it.
- **Shape only.** Use the mesh-only nodes (`Trellis2MeshWithVoxelGenerator` / `Trellis2ExportMesh`), not
  `Trellis2MeshTexturing*`. STL cannot carry texture.

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

1. In the ComfyUI GUI (on Anvil itself, at `http://127.0.0.1:8188`), load ComfyUI-Trellis2's shipped
   **mesh-only** example workflow and run it once by hand on a test image until it produces a `.glb`.
2. **Workflow → Export (API)**. Save it as `infra/anvil/workflows/trellis2-mesh-only.api.json`.
3. Edit that file: set the `LoadImage` node's `image` input to the literal string `"{{INPUT_IMAGE}}"`, and
   every `seed` input to `"{{SEED}}"` (quoted — the script swaps it for a random integer, so a broker retry
   is a genuinely different attempt, not a replay of the failure).
4. Commit it. `hermes-generate-mesh.py` refuses to run without it rather than guess a node graph.

## 4. The mesh worker's Python

A venv of its own, **not** ComfyUI's — the repair chain's numpy/scipy pins must not fight Torch's.

```powershell
git clone https://github.com/madbikernc/HermesAgentV5.git C:\hermes\HermesAgentV5
py -3.12 -m venv C:\hermes\venv
C:\hermes\venv\Scripts\python -m pip install -r C:\hermes\HermesAgentV5\infra\anvil\requirements-mesh.txt
C:\hermes\venv\Scripts\python C:\hermes\HermesAgentV5\infra\anvil\tests\test_mesh_pipeline.py
```

That last line is the **win_amd64 gate**: the pins were only proven on aarch64. All checks must pass here
before the worker runs. (`test_mesh_e2e.py` needs bash/curl/jq and stays a Spark-side test.)

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
