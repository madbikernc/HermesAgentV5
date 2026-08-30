#!/usr/bin/env python3
# Version: 1.0.0
#
# LoRA/QLoRA fine-tuning against local raw documents (prose: fiction,
# transcripts, regulatory material -- no assumption of pre-formatted
# instruction/response pairs). Direct request, 2026-08-19, following a
# proof run on spark-2 that confirmed the full stack (bitsandbytes 4-bit +
# transformers Qwen3-MoE architecture + peft LoRA + trl training loop)
# works correctly on GB10/aarch64 -- see IMPLEMENTATION_PLAN.md's matching
# revision-history entry for that verification's full account, including
# the one real gotcha found (`python3.12-dev` missing, needed for Triton's
# JIT-compiled kernels -- install it before this script's first real run on
# a fresh node).
#
# Document handling deliberately mirrors hermes-rag-ingest-kb.py's own
# extract_pdf_text()/extract_docx_text()/extract_epub_text() exactly (same
# libraries: pypdf, python-docx, EbookLib+lxml) -- not imported directly,
# since this venv is intentionally separate from the RAG venv it lives in
# (different dependency set: transformers/peft/trl/bitsandbytes vs.
# sqlite-vec), but kept behaviorally identical so a document extracts the
# same way regardless of which pipeline touches it. If that extraction
# logic ever changes, update both.
#
# Training shape: raw-text continued fine-tuning (trl's SFTTrainer with a
# plain "text" field), not instruction/response pairs. Deliberate choice
# for this material -- fiction/transcripts/regulatory documents don't have
# a natural question/answer structure to synthesize without an extra,
# separate LLM-assisted labeling pass (not built here; a real future option
# if instruction-following behavior specifically, not just style/content
# absorption, turns out to be the actual goal). Paragraph-boundary chunked
# into training-length windows, the same "respect paragraph breaks, split
# an over-long block if it doesn't fit" shape hermes_rag_common.group_blocks()
# already uses elsewhere in this project -- reimplemented here rather than
# imported for the same cross-venv reason as the extraction functions.
#
# LoRA targets every real Linear layer peft can find (target_modules=
# "all-linear") rather than a hand-listed set of module names -- confirmed
# in the same proof run that this correctly reaches a MoE model's expert
# layers, not just attention, without needing this project to hardcode a
# module-name list that would silently stop matching the moment a
# different model family's naming convention doesn't line up.
#
# Model-agnostic by design (--model takes any HF repo id or local path) --
# deliberately not hardcoded to one specific target, since which model this
# project settles on for real use is still an open question the first real
# run will help answer, not something to lock into this script.
"""
hermes-finetune-train.py — QLoRA fine-tune a causal-LM (dense or MoE) on a
directory of local documents.

Not meant to be invoked directly in normal use -- see
tools/hermes-finetune-model.sh, which brackets this with the memory-freeing
and resident-service restore steps a real run on a shared node needs. Direct
invocation is fine for local testing when nothing else needs freeing.

Usage:
    python3 hermes-finetune-train.py --model <hf-repo-id-or-path> \\
        --data-dir <dir of .txt/.md/.pdf/.docx/.epub> --output <adapter dir>
"""
import argparse
import sys
from pathlib import Path

import ebooklib
import lxml.html
import pypdf
import torch
from datasets import Dataset
from docx import Document
from ebooklib import epub
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

HANDLED_EXTENSIONS = {".md", ".txt", ".pdf", ".docx", ".epub"}
EPUB_BLOCK_XPATH = ".//p | .//li | .//h1 | .//h2 | .//h3 | .//h4 | .//h5 | .//h6"


def log(msg):
    print(f"[hermes-finetune-train] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Document extraction -- mirrors hermes-rag-ingest-kb.py exactly (see header)
# ---------------------------------------------------------------------------

def extract_pdf_text(path: Path) -> str:
    reader = pypdf.PdfReader(str(path))
    return "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()


def extract_docx_text(path: Path) -> str:
    doc = Document(str(path))
    return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())


def extract_epub_text(path: Path) -> str:
    book = epub.read_epub(str(path))
    blocks = []
    for idref, _linear in book.spine:
        item = book.get_item_with_id(idref)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        tree = lxml.html.fromstring(item.get_content())
        for bad in tree.xpath(".//script | .//style"):
            bad.getparent().remove(bad)
        found = [el.text_content().strip() for el in tree.xpath(EPUB_BLOCK_XPATH)]
        found = [t for t in found if t]
        if found:
            blocks.extend(found)
        else:
            whole = tree.text_content().strip()
            if whole:
                blocks.append(whole)
    return "\n\n".join(blocks)


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return extract_pdf_text(path)
    if suffix == ".docx":
        return extract_docx_text(path)
    if suffix == ".epub":
        return extract_epub_text(path)
    return path.read_text(encoding="utf-8", errors="replace")


def discover_documents(root: Path):
    handled, skipped = [], []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        (handled if p.suffix.lower() in HANDLED_EXTENSIONS else skipped).append(p)
    return handled, skipped


# ---------------------------------------------------------------------------
# Chunking -- same paragraph-boundary-packing shape as
# hermes_rag_common.group_blocks(), reimplemented (see header for why)
# ---------------------------------------------------------------------------

def group_blocks(blocks: list[str], max_chars: int):
    current: list[str] = []
    current_len = 0
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        if len(block) > max_chars:
            if current:
                yield "\n\n".join(current)
                current, current_len = [], 0
            for i in range(0, len(block), max_chars):
                yield block[i:i + max_chars]
            continue
        if current_len + len(block) + 2 > max_chars and current:
            yield "\n\n".join(current)
            current, current_len = [], 0
        current.append(block)
        current_len += len(block) + 2
    if current:
        yield "\n\n".join(current)


def build_dataset(data_dir: Path, max_chars: int) -> Dataset:
    handled, skipped = discover_documents(data_dir)
    for p in skipped:
        log(f"SKIPPED (unhandled type): {p.relative_to(data_dir)}")

    texts: list[str] = []
    n_files = n_empty = 0
    for path in handled:
        try:
            text = extract_text(path)
        except Exception as e:
            log(f"ERROR extracting {path.relative_to(data_dir)}: {e} -- skipping")
            continue
        if not text.strip():
            n_empty += 1
            log(f"WARNING: {path.relative_to(data_dir)}: no extractable text -- skipping "
                f"(scanned/image-only PDF, empty document, or extraction failure)")
            continue
        chunks = list(group_blocks(text.split("\n\n"), max_chars))
        texts.extend(chunks)
        n_files += 1
        log(f"{path.relative_to(data_dir)}: {len(chunks)} training example(s)")

    if not texts:
        raise RuntimeError(f"no training examples extracted from {data_dir} "
                            f"({len(handled)} file(s) scanned, {n_empty} had no extractable text)")
    log(f"Built {len(texts)} training example(s) from {n_files} file(s) "
        f"({len(skipped)} skipped as unhandled type, {n_empty} skipped as empty)")
    return Dataset.from_dict({"text": texts})


# ---------------------------------------------------------------------------
# Model / LoRA / training
# ---------------------------------------------------------------------------

def load_model_and_tokenizer(model_id: str):
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    log(f"Loading {model_id} in 4-bit (NF4)...")
    model = AutoModelForCausalLM.from_pretrained(model_id, quantization_config=bnb_config,
                                                  device_map={"": 0})
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    return model, tokenizer


def wrap_lora(model, r: int, alpha: int, dropout: float):
    lora_config = LoraConfig(
        r=r, lora_alpha=alpha, lora_dropout=dropout,
        target_modules="all-linear",  # finds every real Linear (incl. MoE experts) -- see header
        task_type="CAUSAL_LM",
    )
    peft_model = get_peft_model(model, lora_config)
    trainable, total = peft_model.get_nb_trainable_parameters()
    log(f"LoRA-wrapped: {trainable:,} / {total:,} trainable params ({100 * trainable / total:.2f}%)")
    if trainable == 0:
        raise RuntimeError("peft found zero trainable parameters -- LoRA did not attach to anything; "
                            "check that --model resolves to a real causal-LM architecture")
    return peft_model


def train(args):
    dataset = build_dataset(Path(args.data_dir), args.max_chars)
    model, tokenizer = load_model_and_tokenizer(args.model)
    peft_model = wrap_lora(model, args.lora_r, args.lora_alpha, args.lora_dropout)

    sft_config = SFTConfig(
        output_dir=args.output,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        learning_rate=args.learning_rate,
        logging_steps=1,
        save_strategy="no",  # this script saves the final adapter itself, below
        report_to=[],
        max_length=args.max_seq_length,
        dataset_text_field="text",
        bf16=True,
    )
    trainer = SFTTrainer(model=peft_model, args=sft_config, train_dataset=dataset,
                          processing_class=tokenizer)

    log("Starting training...")
    trainer.train()
    losses = [h["loss"] for h in trainer.state.log_history if "loss" in h]
    if not losses or any(l != l for l in losses):  # l != l catches NaN
        raise RuntimeError(f"training did not produce valid loss values: {losses}")
    log(f"Training finished. Loss: first={losses[0]:.4f} last={losses[-1]:.4f} "
        f"({len(losses)} logged step(s))")

    Path(args.output).mkdir(parents=True, exist_ok=True)
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)
    log(f"Adapter saved to {args.output}")
    log("Next step (not run automatically): merge into the base weights and convert to GGUF -- "
        "see infra/model-finetuning/README.md.")


def main():
    ap = argparse.ArgumentParser(description="LoRA/QLoRA fine-tune a causal-LM on local documents")
    ap.add_argument("--model", required=True, help="HF repo id or local path of the base model")
    ap.add_argument("--data-dir", required=True,
                     help="Directory of raw documents (.txt/.md/.pdf/.docx/.epub), scanned recursively")
    ap.add_argument("--output", required=True, help="Where to save the trained LoRA adapter")
    ap.add_argument("--max-chars", type=int, default=6000,
                     help="Max characters per training example, paragraph-boundary packed (default: 6000)")
    ap.add_argument("--max-seq-length", type=int, default=2048)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--lora-dropout", type=float, default=0.05)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--max-steps", type=int, default=-1,
                     help="Fixed step count, overrides --epochs if set (default: -1, use --epochs)")
    ap.add_argument("--learning-rate", type=float, default=2e-4)
    args = ap.parse_args()

    try:
        train(args)
    except RuntimeError as e:
        log(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
