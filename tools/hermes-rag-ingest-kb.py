#!/usr/bin/env python3
# Version: 1.6.0
#
# 1.6.0 (2026-09-04) — direct request, found during a RAG-ingest coverage
# audit: discover_files() had no sibling-preference logic at all. A `notes.pdf`
# and `notes.md` with the same stem in the same folder were both being
# ingested as two separate source_path rows -- duplicate content, two
# citations, no preference either way. Now a PDF/DOCX with a same-stem `.md`
# sibling anywhere under the scanned root (case-insensitive stem match, same
# directory) is excluded from `handled` before conversion even runs -- the MD
# is assumed to be the preferred/curated version, same reasoning a human
# converting a PDF to Markdown by hand would have for keeping only the MD.
# Reported under its own "SUPERSEDED" category, distinct from "SKIPPED
# (unhandled type)", so an operator can tell the two apart in a run's output.
# No extra pruning logic needed: a PDF previously indexed under its own
# source_path before a sibling .md showed up is already excluded from
# `handled` (and therefore from prune_stale()'s `current` set) the next run,
# so the existing stale-source pruning removes its old chunks automatically.
#
# 1.5.0 (2026-09-04) — direct request: PDF/DOCX now convert to real
# structured Markdown (new hermes_doc_to_markdown.py — pymupdf4llm for PDF,
# a hand-rolled python-docx walk for DOCX) instead of the flat plain-text
# join extract_pdf_text()/extract_docx_text() produced (both removed, now
# dead code). Chunking follows: these two extensions plus .md now go
# through hermes_rag_common.chunk_file(), the markdown-header chunking
# 30b's fleet-docs ingester already had (moved there this same session so
# both ingesters share one implementation) -- this file's own 1.0.0-era
# docstring left header-chunking as "add later if real files show it's
# worth it," which converting PDF/DOCX to markdown instead of flat text
# just did. .txt/.epub are unaffected, still group_blocks()'d as before --
# neither produces real markdown headings to key on.
#
# The hand-rolled pdftoppm+tesseract OCR path (ocr_pdf_page(), OCR_MIN_CHARS/
# OCR_DPI) is also removed: pymupdf4llm does real OCR internally
# (confirmed live -- it OCR'd 8 pages of a real scanned PDF unprompted, its
# own use_ocr default is True) via its own use_ocr kwarg, now wired to this
# file's pre-existing --ocr flag so the operator-facing contract (off by
# default, explicit per-run opt-in -- S16c's own reasoning, a scanned-heavy
# folder turning a quick catch-up into a multi-hour run) is unchanged even
# though the mechanism underneath it is entirely different.
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

Handles `.md`/`.txt` (as plain text), `.pdf` and `.docx` (converted to real
structured Markdown via `hermes_doc_to_markdown.py`, 2026-09-04 — see that
file's own header for why PDF gets a real dependency, pymupdf4llm, and DOCX
is hand-rolled against `python-docx` directly), and `.epub` (via
`EbookLib`), recursively. `.md`/`.pdf`/`.docx` are header-aware chunked
(`hermes_rag_common.chunk_file()`, the same markdown-header chunking 30b's
fleet-docs ingester uses — no longer avoided here now that PDF/DOCX
actually produce real heading structure instead of flat text, closing the
gap this file's own 1.0.0-era docstring left as "add later if worth it").
`.txt`/`.epub` stay on the older paragraph-boundary chunker
(`hermes_rag_common.group_blocks()`) — plain notes have no headers to key
on, and EPUB's own block extraction already yields paragraph-shaped text,
not markdown. Every skipped file (unhandled type, one that extracts to
nothing — most often a scanned/image-only PDF with no real text layer and
no `--ocr` — or a PDF/DOCX superseded by a same-stem `.md` sibling, 1.6.0)
is named explicitly in the run's own output, not silently dropped.

A PDF/DOCX with a `.md` file of the same stem in the same directory is
never converted or indexed — the `.md` is assumed to be the preferred/
curated version and is indexed on its own (1.6.0). This avoids duplicate
chunks/citations for the same content under two different source_paths.

Embeds locally against the resident Spark backend (127.0.0.1:8092), same
choice 30b made for fleet-docs — a personal-notes folder is not expected to
approach the podcast archive's scale, so there's no bus-contention
rationale here to justify the broker/HomeD13 path 30c built.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-ingest-kb.py [--root PATH] [--dry-run] [--ocr]

--ocr (S16c) is off by default — the daily scheduled timer never passes it. Run it by hand when a
scanned/image-only PDF is known to be in the folder. As of 1.5.0 this is pymupdf4llm's own
`use_ocr` (hermes_doc_to_markdown.pdf_to_markdown()), not this file's hand-rolled
pdftoppm+tesseract path (removed, now dead code with pymupdf4llm doing real OCR internally) — the
operator-facing contract (off by default, explicit per-run opt-in) is unchanged.
"""
import argparse
import datetime
import sys
from pathlib import Path

import ebooklib
import lxml.html
from ebooklib import epub

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_doc_to_markdown as doc2md  # noqa: E402
import hermes_rag_common as rag  # noqa: E402

CORPUS = "personal-kb"
MAX_CHUNK_CHARS = 1800
ROOT = "/mnt/nas2-hermes-backup/RAGDocs"
HANDLED_EXTENSIONS = {".md", ".txt", ".pdf", ".docx", ".epub"}
MARKDOWN_EXTENSIONS = {".md", ".pdf", ".docx"}  # header-aware chunked; see docstring
EPUB_BLOCK_XPATH = ".//p | .//li | .//h1 | .//h2 | .//h3 | .//h4 | .//h5 | .//h6"


def extract_epub_text(path: Path) -> str:
    """Walks the book's own spine (reading order, not manifest order) and
    pulls text out of each chapter's block-level tags (paragraphs, list
    items, headings) as separate blocks -- paragraph-boundary shape, not
    markdown (EPUB's own heading tags aren't preserved as "#" markers here,
    unlike the PDF/DOCX->markdown path), so group_blocks() rather than
    chunk_file() handles this one. A chapter with no block tags at all
    (rare, but real for some converted EPUBs) falls back to that item's
    whole text as one block rather than silently dropping it, the same
    "never index nothing silently" discipline the PDF/DOCX path follows."""
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
    handled, skipped, superseded = [], [], []
    if not root.is_dir():
        return handled, skipped, superseded
    all_files = [p for p in sorted(root.rglob("*")) if p.is_file()]
    md_stems = {
        (p.parent, p.stem.lower()) for p in all_files if p.suffix.lower() == ".md"
    }
    for p in all_files:
        suffix = p.suffix.lower()
        if suffix in (".pdf", ".docx") and (p.parent, p.stem.lower()) in md_stems:
            superseded.append(p)
        elif suffix in HANDLED_EXTENSIONS:
            handled.append(p)
        else:
            skipped.append(p)
    return handled, skipped, superseded


def ingest_file(conn, root: Path, path: Path, dry_run: bool, ocr: bool = False) -> int:
    rel = str(path.relative_to(root))
    suffix = path.suffix.lower()
    is_markdown = suffix in MARKDOWN_EXTENSIONS

    if suffix in (".pdf", ".docx"):
        try:
            text = doc2md.to_markdown(path, ocr=ocr)
        except Exception as e:
            # Broad on purpose: pymupdf4llm/python-docx can raise several
            # distinct exception types on a corrupt/malformed real-world
            # file (bad zip for .docx, malformed xref for .pdf, ...) --
            # this file's own docstring commits to naming every skipped
            # file explicitly rather than crashing the whole batch run on
            # one bad document, same discipline the empty-text check below
            # already applies to a scanned PDF with no --ocr.
            print(f"WARNING: {rel}: could not convert to markdown, skipping: {e}", file=sys.stderr)
            return 0
    elif suffix == ".epub":
        text = extract_epub_text(path)
    else:
        text = path.read_text(encoding="utf-8", errors="replace")

    if not text.strip():
        hint = " (pass --ocr for scanned/image-only PDFs)" if (suffix == ".pdf" and not ocr) else ""
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

    if is_markdown:
        chunks = list(rag.chunk_file(text, MAX_CHUNK_CHARS))  # [(header, body), ...]
    else:
        chunks = [(None, t) for t in rag.group_blocks(text.split("\n\n"), MAX_CHUNK_CHARS)]
    if not chunks:
        return 0
    n = len(chunks)

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
    for idx, (header, chunk_text) in enumerate(chunks):
        if header and header not in ("(preamble)", "(no heading)"):
            citation = f"{rel} — {header}"
        else:
            citation = rel if n == 1 else f"{rel} (part {idx + 1}/{n})"
        vec = rag.embed(chunk_text)
        cur = conn.execute(
            "INSERT INTO chunks (corpus, source_path, section, chunk_index, chunk_text, "
            "citation, content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
            (CORPUS, rel, header, idx, chunk_text, citation, rag.content_hash(chunk_text), now),
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

    handled, skipped, superseded = discover_files(root)
    for p in skipped:
        print(f"SKIPPED (unhandled type): {p.relative_to(root)}", file=sys.stderr)
    for p in superseded:
        print(f"SUPERSEDED (matching .md preferred, not converted): {p.relative_to(root)}", file=sys.stderr)

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

    print(f"Scanned {len(handled)} file(s) ({len(skipped)} skipped, unhandled type; "
          f"{len(superseded)} superseded by a sibling .md), "
          f"{changed} changed, {total_chunks} chunk(s) (re)embedded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
