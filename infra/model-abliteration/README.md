# heretic (model abliteration) — recreate checklist

**Version:** 1.1.0

One-time install of [`heretic`](https://github.com/p-e-w/heretic) (AGPL-3.0 — applies to the tool
itself, not to weights it produces) plus the GGUF conversion/deployment path for its output. Runs on
either node (GB10, aarch64, 121GB unified memory) — `IMPLEMENTATION_PLAN.md`'s own Stage 7 locked
decisions call out `spark-2` as the preferred node now (more headroom: ~93GB free with Amy's full
stack resident, vs. `spark`'s own Weaver/Muse-constrained free memory). For the operational wrapper
around freeing memory and invoking it, see `tools/hermes-abliterate-model.sh` and
`skills/model-abliteration/SKILL.md`.

**Installed and verified for real on `spark-2` 2026-08-19** — this checklist had never actually been
carried out anywhere before that (`IMPLEMENTATION_PLAN.md` said as much explicitly: "still the plan,
not yet exercised for real"). Confirmed working: `torch` 2.13.0+cu130 with real CUDA compute (a real
matmul, not just an import check), `optuna` 4.9.0, `heretic-llm` 1.4.0 itself importing and its CLI
entrypoint (`heretic --help`) resolving correctly.

## 1. Install heretic in an isolated venv

Kept separate from `hermes-agent`'s own venv and from `hermes-router`'s process — heretic pulls its own
`torch`/`transformers`/`optuna` stack and shouldn't risk version drift touching either.

```bash
python3 -m venv /opt/heretic-venv
source /opt/heretic-venv/bin/activate
pip install -U heretic-llm
```

**Verify CUDA actually works before relying on it** — not just that it imports, since a real kernel
path failing silently on this hardware is a worse outcome than an import error:

```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

If `cuda.is_available()` prints `False`, the resolved `torch` wheel is CPU-only for this platform —
try reinstalling from NVIDIA's aarch64/SBSA PyTorch build instead of the generic PyPI wheel. **As of
2026-08-19 this hasn't actually been necessary** — plain `pip install -U heretic-llm` resolved a real
CUDA-enabled aarch64 `torch` wheel on `spark-2` with no special index or fallback needed. This
supersedes this file's own earlier caution (through 1.0.0) that PyPI wheels for `torch`/`bitsandbytes`
"historically had thinner aarch64+CUDA coverage than x86_64" — that turned out to be stale for current
PyTorch releases; don't reach for the SBSA build reflexively before checking the plain wheel first.
llama.cpp's own need for an explicit `sm_121a` build flag on this hardware (see HermesAgent's
`llama-cpp` skill, `dgx-spark-gb10.md`) is a separate, still-real issue — it just doesn't mean `torch`
has the same problem.

## 2. Run it

Via `tools/hermes-abliterate-model.sh` (handles freeing memory from Weaver/Muse first) — not by
invoking `heretic` directly, unless doing a one-off test on a model small enough that nothing needs to
be stopped. Full usage in `skills/model-abliteration/SKILL.md`.

## 3. Convert the result to GGUF

heretic's output is full-precision (fp16/bf16) HF-format weights. This fleet's model-serving stack is
GGUF/llama.cpp-only (`IMPLEMENTATION_PLAN.md` §4a) — convert and quantize the same way as any other HF
checkpoint, using the Spark's own llama.cpp checkout:

```bash
cd ~/llama.cpp   # or wherever this node's build lives — confirm with `which llama-server`
git pull && cmake --build build121 --config Release -j$(nproc)   # only if the target architecture is newer than the current checkout

python convert_hf_to_gguf.py /path/to/heretic-output --outfile /path/to/model-f16.gguf --outtype f16
./build121/bin/llama-quantize /path/to/model-f16.gguf /path/to/model-Q4_K_M.gguf Q4_K_M
```

Delete the fp16 intermediate once the quantized file is confirmed working — it's 2-4x the size of the
quant and has no further use.

## 4. Deploying as a backend (only if actually promoting the result)

Most runs are exploratory (matching the pattern already set by HermesAgent's own Muse-Glimmer-30B
benchmark — measured, found not to be a speed win over what's already running, left on disk rather than
deployed). Only wire a result in if it's actually replacing or adding to a real resident backend.
Follow the same shape as the existing `llama-*.service` units — on `spark`, ports 8088-8091 are
Core/Weaver/Muse/Vision per `IMPLEMENTATION_PLAN.md` §4a, and a new Weaver/Muse-role backend should be
registered with `hermes-router` per `tools/hermes-router.py`'s role-mapping; `spark-2` has no router
(Amy's gateway calls her two backends, Core on 8088 and Vision on 8091, directly) and no free role port
in that range to reuse. Update `IMPLEMENTATION_PLAN.md` §4a's table plus this file's own Revision
History in the same pass — this is exactly the kind of infrastructure change v1's mission-statement
docs failed to record in real time; don't repeat that here.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-13 | Initial version, written alongside `tools/hermes-abliterate-model.sh` and `skills/model-abliteration/SKILL.md`. |
| 1.1.0 | 2026-08-19 | Actually installed and verified for real on `spark-2` for the first time — this checklist had never been carried out anywhere before (confirmed: `/opt/heretic-venv` didn't exist on `spark` either). Corrected the stale aarch64+CUDA wheel caution (plain PyPI `torch` already resolves a real CUDA-enabled wheel; the SBSA-build fallback wasn't needed). `spark-2`-specific notes added to §1 (headroom rationale) and §4 (no router, no free 8088-8091 port to reuse there). Found and fixed a related bug in `tools/hermes-abliterate-model.sh` (1.0.0→1.1.0) and `skills/model-abliteration/SKILL.md` (1.0.0→1.1.0) in the same pass: the Core-liveness check was hardcoded to `llama-sintra-core.service`, which would have warned spuriously on every `spark-2` run. |
