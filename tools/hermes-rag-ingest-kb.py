#!/usr/bin/env python3
# Version: 1.4.0
#
# 1.4.0 — HermesAgentV5 S16c: optional OCR for scanned/image-only PDF pages, direct request.
# `--ocr` is off by default and must be passed explicitly — a personal-notes folder can hold large
# scanned-image PDFs (an old photo album exported as PDF, for example) where OCR would turn a
# quick catch-up ingest into a multi-hour run, and that trade-off is the operator's call each run,
# not a default this script should make for them. Per-page, not per-document: `extract_pdf_text()`
# already worked page-by-page; a page whose own native extraction comes back near-empty (<50 chars
# — a bare heading or page number on an otherwise-scanned page counts as "empty" for this purpose)
# is individually rasterized (`pdftoppm`, already installed system-wide, confirmed live rather than
# assumed) and OCR'd (`tesseract`, installed for this stage — `apt-get install tesseract-ocr`, no
# new Python dependency, same "shell out to a real established tool" pattern hermes-logs.py already
# used for pfSense/canary/game-server data) — a partially-scanned document gets its scanned pages
# recovered without discarding the pages that already had a real text layer. Mechanics verified
# live against a real PDF already in `RAGDocs` before writing the ingestion path: rasterize a real
# page, OCR it, confirm real recognizable text comes back (it does, cleanly, on body-text pages;
# stylized cover-page fonts recognize less reliably, expected OCR behavior, not a pipeline bug).
# Every OCR'd page is logged explicitly (which page, how many characters recovered) — same "every
# skipped file is named explicitly" discipline this script's own docstring already commits to,
# extended to "every OCR'd page," not silent either way.
#
# 1.3.0 — direct request: adds `.epub` (via `EbookLib`, HTML stripped with
# `lxml.html`, already in the venv for other reasons) alongside the existing
# `.md`/`.txt`/`.pdf`/`.docx` handling. Extracts each spine item (chapter) in
# the book's own reading order, splitting on block-level tags (`<p>`,
# `<li>`, headings) so a chapter becomes several paragraph-sized blocks for
# `rag.group_blocks()` rather than one giant chapter-sized blob -- same
# paragraph-boundary shape the `.docx` path already produces. A chapter with
# no block tags at all (rare, but seen in some converted EPUBs) falls back
# to that item's whole text as one block instead of silently dropping it.
# `.mobi`/`.azw3` deliberately NOT built here, same "don't build ahead of a
# real need" reasoning `.doc` was left out for at 1.2.0: no clean
# pure-Python reader exists for Amazon's proprietary formats (unlike EPUB's
# open XHTML structure), they're frequently DRM-locked, and no real
# `.mobi`/`.azw3` file exists anywhere in `RAGDocs` today -- revisit if one
# actually shows up.
#
# 1.2.0 — adds `.pdf` (via pypdf) and `.docx` (via python-docx) alongside
# the existing `.md`/`.txt` handling: direct request, following a plan-mode
# design pass 2026-08-15 that also considered video/audio. That half was
# deliberately deferred, not built here — HomeD13's GPU had only ~4GB VRAM
# free (measured live) alongside the resident ComfyUI checkpoint, and the
# planned Stage 7 second Spark's Nemotron 3 Nano Omni backend (native audio
# encoder, not yet built) is very likely a better fit than squeezing a
# Whisper worker onto that already-tight 12GB card. PDF/docx need none of
# that — pure CPU-side text extraction, no GPU, no broker job, same as this
# script already does for `.md`/`.txt`. `.doc` (legacy pre-2007 binary
# Word) stays out of scope too — python-docx can't read it and no real
# `.doc` file exists anywhere in the fleet today; same "don't build ahead
# of a real need" reasoning this file's own 1.0.0 docstring already used.
#
# 1.1.0 — Phase 30g: prunes stale entries (a note deleted from RAGDocs since
# the last run) via hermes_rag_common.prune_stale(), skipped on --dry-run
# and on an unreachable root (a down NAS mount must never be treated as "the
# folder was emptied" — pruning only runs once root.is_dir() is confirmed).
"""
hermes-rag-ingest-kb.py — Phase 30f (IMPLEMENTATION_PLAN.md §7, Phase 30):
last of four narrow, per-corpus ingestion tools. The personal-KB source
location was genuinely undecided when Phase 30 was designed; direct answer
2026-08-14: a NAS share, `RAGDocs`, sibling to Phase 24's own `PodCasts`
share (`/mnt/nas2-hermes-backup/RAGDocs`) — created for this purpose, empty
at build time ("I'll add files later").

Handles `.md`/`.txt` (as plain text), `.pdf` (via `pypdf`), `.docx` (via
`python-docx`), and `.epub` (via `EbookLib`), recursively. Paragraph-chunked
(blank-line boundaries, same `hermes_rag_common.group_blocks()` fallback
every other ingester uses) rather than the header-aware chunking 30b's
fleet-docs ingester uses — a personal-notes folder's structure is unknown
ahead of any real content, so the simpler, format-agnostic approach is the
honest default; markdown header-chunking can be added later if real files
show it's worth the extra complexity, not built speculatively ahead of
that. Every skipped file (unhandled type, or a PDF/docx/epub that extracts
to nothing — most often a scanned/image-only PDF with no real text layer)
is named explicitly in the run's own output, not silently dropped.

Embeds locally against the resident Spark backend (127.0.0.1:8092), same
choice 30b made for fleet-docs — a personal-notes folder is not expected to
approach the podcast archive's scale, so there's no bus-contention
rationale here to justify the broker/HomeD13 path 30c built.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-ingest-kb.py [--root PATH] [--dry-run] [--ocr]

--ocr (S16c) is off by default — the daily scheduled timer never passes it. Run it by hand when a
scanned/image-only PDF is known to be in the folder; see this file's own 1.4.0 header for why it
stays an explicit, per-run operator choice rather than an automatic default.
"""
import argparse
import datetime
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import ebooklib
import lxml.html
import pypdf
from docx import Document
from ebooklib import epub

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

CORPUS = "personal-kb"
MAX_CHUNK_CHARS = 1800
ROOT = "/mnt/nas2-hermes-backup/RAGDocs"
HANDLED_EXTENSIONS = {".md", ".txt", ".pdf", ".docx", ".epub"}
EPUB_BLOCK_XPATH = ".//p | .//li | .//h1 | .//h2 | .//h3 | .//h4 | .//h5 | .//h6"
OCR_MIN_CHARS = 50  # a page's own native extraction below this is treated as "empty" for OCR
OCR_DPI = 200


def ocr_pdf_page(pdf_path: Path, page_num: int) -> str:
    """Rasterizes one PDF page (1-indexed, matching pypdf's own enumeration once +1'd by the
    caller) via pdftoppm and OCRs it via tesseract. Both are real system binaries, checked live
    before this path was written, not assumed present — raises RuntimeError with the real
    stderr/exit code if either is missing or fails, so a broken OCR install surfaces as a real
    error on first use rather than a silent empty page."""
    if not shutil.which("pdftoppm") or not shutil.which("tesseract"):
        raise RuntimeError("pdftoppm/tesseract not found on PATH — install poppler-utils/tesseract-ocr")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        prefix = tmp_path / "page"
        result = subprocess.run(
            ["pdftoppm", "-png", "-f", str(page_num), "-l", str(page_num), "-r", str(OCR_DPI),
             str(pdf_path), str(prefix)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(f"pdftoppm failed on page {page_num}: {result.stderr.strip()}")
        pngs = sorted(tmp_path.glob("page*.png"))
        if not pngs:
            raise RuntimeError(f"pdftoppm produced no image for page {page_num}")
        result = subprocess.run(
            ["tesseract", str(pngs[0]), "stdout"],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"tesseract failed on page {page_num}: {result.stderr.strip()}")
        return result.stdout.strip()


def extract_pdf_text(path: Path, ocr: bool = False) -> str:
    """Join every page's extracted text. Returns "" for a scanned/image-only PDF with no real
    text layer and ocr=False (pypdf alone has no OCR) -- callers must treat that as "skip, don't
    index," not an error. With ocr=True (S16c, off by default -- see this file's own 1.4.0 header),
    any individual page whose native extraction comes back under OCR_MIN_CHARS is rasterized and
    OCR'd instead, page by page -- a partially-scanned document keeps its real text-layer pages
    exactly as before and only recovers the scanned ones."""
    reader = pypdf.PdfReader(str(path))
    pages = []
    for i, page in enumerate(reader.pages):
        native = (page.extract_text() or "").strip()
        if ocr and len(native) < OCR_MIN_CHARS:
            try:
                recovered = ocr_pdf_page(path, i + 1)
            except Exception as exc:
                print(f"WARNING: {path.name} page {i + 1}: OCR failed, keeping native "
                      f"extraction ({len(native)} chars): {exc}", file=sys.stderr)
                pages.append(native)
                continue
            if len(recovered) > len(native):
                print(f"  {path.name} page {i + 1}: OCR recovered {len(recovered)} chars "
                      f"(native extraction had {len(native)})", file=sys.stderr)
                pages.append(recovered)
                continue
        pages.append(native)
    return "\n\n".join(pages).strip()


def extract_docx_text(path: Path) -> str:
    """Join every paragraph's text, blank-line separated so the existing
    paragraph-boundary chunker (rag.group_blocks()) treats each Word
    paragraph the same way it already treats a markdown paragraph."""
    doc = Document(str(path))
    return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())


def extract_epub_text(path: Path) -> str:
    """Walks the book's own spine (reading order, not manifest order) and
    pulls text out of each chapter's block-level tags (paragraphs, list
    items, headings) as separate blocks -- same paragraph-boundary shape
    extract_docx_text() already produces, so group_blocks() treats an EPUB
    chapter the same way it treats a Word document. A chapter with no
    block tags at all (rare, but real for some converted EPUBs) falls back
    to that item's whole text as one block rather than silently dropping
    it, the same "never index nothing silently" discipline the PDF/docx
    paths already follow."""
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


def discover_files(root: Path):
    handled, skipped = [], []
    if not root.is_dir():
        return handled, skipped
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix.lower() in HANDLED_EXTENSIONS:
            handled.append(p)
        else:
            skipped.append(p)
    return handled, skipped


def ingest_file(conn, root: Path, path: Path, dry_run: bool, ocr: bool = False) -> int:
    rel = str(path.relative_to(root))
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        text = extract_pdf_text(path, ocr=ocr)
    elif suffix == ".docx":
        text = extract_docx_text(path)
    elif suffix == ".epub":
        text = extract_epub_text(path)
    else:
        text = path.read_text(encoding="utf-8", errors="replace")

    if not text.strip():
        hint = "" if (suffix == ".pdf" and ocr) else " (pass --ocr for scanned/image-only PDFs)" if suffix == ".pdf" else ""
        print(f"WARNING: {rel}: no extractable text — skipping (scanned/image-only PDF, "
              f"empty document, or extraction failure){hint}", file=sys.stderr)
        return 0

    # Hash the extracted text, not the raw file bytes -- a PDF/docx re-save
    # that doesn't change visible content (metadata touch, re-export, etc.)
    # shouldn't trigger a spurious re-embed. Same as .md/.txt already did.
    file_hash = rag.content_hash(text)

    row = conn.execute(
        "SELECT file_hash FROM ingest_state WHERE corpus=? AND source_path=?", (CORPUS, rel)
    ).fetchone()
    if row and row[0] == file_hash:
        return 0

    paragraphs = text.split("\n\n")
    chunk_texts = list(rag.group_blocks(paragraphs, MAX_CHUNK_CHARS))
    if not chunk_texts:
        return 0
    n = len(chunk_texts)

    if dry_run:
        print(f"[dry-run] {rel}: {n} chunk(s) would be (re)embedded")
        return n

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn.execute("DELETE FROM chunks WHERE corpus=? AND source_path=?", (CORPUS, rel))
    conn.execute(
        "DELETE FROM vec_chunks WHERE chunk_id IN "
        "(SELECT id FROM chunks WHERE corpus=? AND source_path=?)",
        (CORPUS, rel),
    )
    for idx, chunk_text in enumerate(chunk_texts):
        citation = rel if n == 1 else f"{rel} (part {idx + 1}/{n})"
        vec = rag.embed(chunk_text)
        cur = conn.execute(
            "INSERT INTO chunks (corpus, source_path, section, chunk_index, chunk_text, "
            "citation, content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
            (CORPUS, rel, None, idx, chunk_text, citation, rag.content_hash(chunk_text), now),
        )
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (cur.lastrowid, rag.pack_vec(vec)),
        )
    conn.execute(
        "INSERT INTO ingest_state (corpus, source_path, file_hash, last_ingested) VALUES (?,?,?,?) "
        "ON CONFLICT(corpus, source_path) DO UPDATE SET file_hash=excluded.file_hash, "
        "last_ingested=excluded.last_ingested",
        (CORPUS, rel, file_hash, now),
    )
    conn.commit()
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=ROOT)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--ocr", action="store_true",
                     help="OCR scanned/image-only PDF pages (S16c) — off by default; a "
                          "scanned-image-heavy folder can turn a quick catch-up ingest into a "
                          "multi-hour run, so this stays an explicit per-run choice")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        # Deliberately does NOT prune here: an unreachable NAS mount looks
        # identical to "the folder was deleted" from here, and treating a
        # transient mount hiccup as "delete every indexed note" would be
        # actively destructive. Only a confirmed-reachable, genuinely empty
        # folder (below) is trusted enough to prune against.
        print(f"NOTE: {root} does not exist (yet) — nothing to ingest.")
        return 0

    handled, skipped = discover_files(root)
    for p in skipped:
        print(f"SKIPPED (unhandled type): {p.relative_to(root)}", file=sys.stderr)

    conn = rag.connect(readonly=False)
    total_chunks = 0
    changed = 0
    for path in handled:
        try:
            n = ingest_file(conn, root, path, args.dry_run, ocr=args.ocr)
        except RuntimeError as e:
            print(f"ERROR embedding {path}: {e}", file=sys.stderr)
            continue
        if n:
            changed += 1
            total_chunks += n
            print(f"{path.relative_to(root)}: {n} chunk(s)")

    if not args.dry_run:
        current = {str(p.relative_to(root)) for p in handled}
        pruned = rag.prune_stale(conn, CORPUS, current)
        if pruned:
            print(f"Pruned {len(pruned)} stale source(s): {', '.join(pruned)}")

    print(f"Scanned {len(handled)} file(s) ({len(skipped)} skipped, unhandled type), "
          f"{changed} changed, {total_chunks} chunk(s) (re)embedded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
