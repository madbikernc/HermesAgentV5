# model-finetuning — recreate checklist

**Version:** 1.0.0

One-time install of the LoRA/QLoRA fine-tuning stack (`transformers`/`peft`/`trl`/`bitsandbytes`/
`torch`, plus the same document-extraction libraries `hermes-rag-ingest-kb.py` already uses:
`pypdf`/`python-docx`/`EbookLib`+`lxml`) for `tools/hermes-finetune-train.py`. For the operational
wrapper around freeing memory and invoking it, see `tools/hermes-finetune-model.sh` and
`skills/model-finetuning/SKILL.md`.

Verified live on `spark-2` (GB10, aarch64) 2026-08-19 before this was built for real, not assumed:
a full proof run (tiny Qwen3-MoE model, 4-bit quantized load, LoRA wrap, real training steps, adapter
save/reload) passed end to end. See `IMPLEMENTATION_PLAN.md`'s matching revision-history entry for
the complete account, including two real things found and fixed in the process:

- **`python3.12-dev` was missing** — `torch`'s newer internal ops JIT-compile a small CUDA helper via
  Triton, which needs `Python.h` at build time. Without it, the very first real training step fails
  with a `gcc`/`Python.h: No such file or directory` error, not anything CUDA- or model-related.
  `sudo apt-get install -y python3.12-dev` (match the venv's actual Python version) before the first
  real run on any fresh node.
- **Plain PyPI `torch` already resolves a real aarch64+CUDA wheel** (`torch==2.13.0+cu130` at
  verification time) — the `model-abliteration/README.md`'s own caution about needing NVIDIA's
  special SBSA build wheels turned out to be stale for current PyTorch. Don't reach for the SBSA
  build unless plain `pip install torch` genuinely fails to give you a CUDA-enabled wheel first —
  check with `python -c "import torch; print(torch.cuda.is_available())"` before assuming.

## 1. Install the venv

```bash
python3 -m venv /opt/finetune-venv
source /opt/finetune-venv/bin/activate
pip install --upgrade pip
pip install torch bitsandbytes 'transformers>=4.51' peft trl accelerate datasets pypdf python-docx EbookLib lxml
```

**Verify CUDA and 4-bit quantization actually work before relying on either** — not just that they
import, since a real 4-bit kernel path failing silently is a worse outcome than an import error:

```bash
python3 -c "
import torch, bitsandbytes as bnb
print('torch:', torch.__version__, 'CUDA:', torch.cuda.is_available())
layer = bnb.nn.Linear4bit(256, 256, bias=False, compute_dtype=torch.bfloat16, quant_type='nf4').to('cuda')
out = layer(torch.randn(2, 256, dtype=torch.bfloat16, device='cuda'))
print('4-bit quantized forward pass OK:', out.shape)
"
```

If `torch.cuda.is_available()` prints `False`, the resolved wheel is CPU-only for this platform —
try NVIDIA's own aarch64/SBSA PyTorch build instead of the generic PyPI wheel (same fallback
`model-abliteration/README.md` documents), though as of this writing that hasn't been necessary here.

## 2. Run it

Via `tools/hermes-finetune-model.sh` (handles freeing memory from Weaver/Muse or Vision first) — not
by invoking `hermes-finetune-train.py` directly, unless doing a one-off test on a model small enough
that nothing needs to be stopped. Full usage in `skills/model-finetuning/SKILL.md`.

Training material: point `--data-dir` (passed through by the wrapper as its second argument) at a
folder of raw documents — `.txt`/`.md`/`.pdf`/`.docx`/`.epub`, scanned recursively, extracted the same
way `hermes-rag-ingest-kb.py` already extracts `RAGDocs` for the `personal-kb` RAG corpus. No
pre-formatted instruction/response pairs required — this trains on the raw text itself
(continued-fine-tuning / style-and-content absorption), which is the right shape for prose without a
natural question/answer structure (fiction, transcripts, regulatory documents). If instruction-following
behavior specifically (not just style/content) turns out to be the actual goal later, that needs a
separate document-to-instruction-pairs synthesis pass this script doesn't do.

## 3. After training: merge, convert to GGUF, sanity-check

Not part of the training script — deliberate separate steps, same discipline
`model-abliteration/README.md` already follows for its own output.

```bash
source /opt/finetune-venv/bin/activate
python3 -c "
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
base = AutoModelForCausalLM.from_pretrained('<base-model-id>', torch_dtype='bfloat16')
merged = PeftModel.from_pretrained(base, '<adapter-output-dir>').merge_and_unload()
merged.save_pretrained('<merged-output-dir>')
AutoTokenizer.from_pretrained('<base-model-id>').save_pretrained('<merged-output-dir>')
"

cd ~/llama.cpp   # or wherever this node's build lives — confirm with `which llama-server`
python convert_hf_to_gguf.py <merged-output-dir> --outfile <model>-f16.gguf --outtype f16
./build*/bin/llama-quantize <model>-f16.gguf <model>-Q4_K_M.gguf Q4_K_M
```

Delete the merged bf16 intermediate once the quantized file is confirmed working — same reasoning
`model-abliteration/README.md` gives: 2-4x the size of the quant, no further use.

**Sanity-check before treating a result as done** — chat-test it (`llama-server` + a real prompt, or
the model-abliteration precedent's own "always chat-test before calling it done") rather than assuming
a clean training-loss curve means the output is actually good. A fine-tune that memorizes training
text without generalizing is a real, common failure mode this doesn't catch automatically.

## 4. Deploying as a backend (only if actually promoting the result)

Most runs should be treated as exploratory until proven otherwise — same "left on disk, not
auto-deployed" default `model-abliteration/README.md` already establishes for heretic output. Only
wire a result in as a real resident backend if it's actually replacing or adding to
`IMPLEMENTATION_PLAN.md` §4a's table: follow the existing `llama-*.service` unit shape, register it
with `hermes-router.py`'s role-mapping if it's meant to be reachable from Sintra's router, and update
§4a's table plus this file's own Revision History in the same pass.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-19 | Initial version, written alongside `tools/hermes-finetune-train.py` and `tools/hermes-finetune-model.sh`, following a real proof run on `spark-2` that verified the whole stack (CUDA, bitsandbytes 4-bit, peft LoRA on a MoE architecture, a real trl training step, adapter save/reload) works on GB10/aarch64. |
