#!/usr/bin/env python3
# Version: 1.4.0
#
# 1.4.0 (2026-09-04) — direct request, found during a RAG-ingest coverage
# audit: this corpus is a deliberately curated allowlist (DOC_ROOT_FILES/
# DOC_GLOBS below), not a repo-wide walk, and previously gave no signal at
# all if a new top-level `.md` file showed up in the repo that the allowlist
# didn't cover — it would just silently never be indexed. report_unhandled()
# now lists any other `*.md` file sitting at the repo root, at runtime, same
# "every skipped file is named explicitly" discipline the other three
# ingesters already apply to their own corpora. Deliberately root-only, not
# a full repo walk: this corpus's own scope is intentionally narrow (see this
# file's own Phase 30b docstring below), and a full-tree scan would flag
# hundreds of files (scripts, configs, non-fleet-doc notes) that were never
# meant to be in this corpus, burying the signal a real gap would give.
#
# 1.3.0 (2026-09-04) — split_sections()/chunk_file() (this script's own
# markdown-header chunking, since 30b) moved to hermes_rag_common.py once
# hermes-rag-ingest-kb.py needed the identical logic for PDF/DOCX converted
# to markdown. No behavior change here — chunk_file() now takes max_chars
# as a parameter instead of reading this file's own module global, called
# as rag.chunk_file(text, MAX_CHUNK_CHARS).
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: --repo CLI flag default repointed
# from HermesAgentV4 to HermesAgentV5.
#
# 1.2.0 — Phase 30g: prunes stale entries (a fleet doc removed since the
# last run) via hermes_rag_common.prune_stale(), skipped on --dry-run.
#
# 1.1.0 — Phase 30c: hard/sentence-boundary chunk splitting factored out to
# hermes_rag_common.group_blocks()/hard_split_text(), shared with the new
# podcast ingester rather than duplicated. No behavior change.
"""
hermes-rag-ingest-docs.py — Phase 30b (IMPLEMENTATION_PLAN.md §7, Phase 30):
first of four narrow, per-corpus ingestion tools ("one per corpus, not one
general ingester", per constraint 2). This one covers the fleet's own docs —
IMPLEMENTATION_PLAN.md, LESSONS_LEARNED.md, README.md, CLAUDE.md, both
personas' SOUL.md, every skills/*/SKILL.md and infra/*/README.md — the
smallest, most tightly controlled corpus, picked first per the plan's own
staged order.

Deliberately embeds locally against the resident query-time backend
(127.0.0.1:8092) rather than routing through the broker's future `embed` job
type: the whole fleet-docs corpus is low-hundreds-of-KB, not the
multi-hundred-episode podcast archive Phase 30c will cover, so there's no
real bus-contention concern here to justify moving the compute off-box. The
broker-routed bulk path stays reserved for 30c per the plan's own framing
("keeps heavy backfill compute off the Spark's shared 273GB/s bus").

Chunking: markdown-header sections; any section over MAX_CHUNK_CHARS is
further split on paragraph breaks. Content-hash dedup at the whole-file
level (ingest_state table) — an unchanged file is skipped entirely, not
re-chunked and re-diffed line by line, same coarse-grained dedup
hermes-botnet-intel-sync.py and the podcast retriever already use.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-ingest-docs.py [--repo PATH] [--dry-run]
"""
import argparse
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

CORPUS = "fleet-docs"
MAX_CHUNK_CHARS = 1800

DOC_ROOT_FILES = ["IMPLEMENTATION_PLAN.md", "LESSONS_LEARNED.md", "README.md", "CLAUDE.md"]
DOC_GLOBS = [
    "DesignFiles/*/SOUL.md",
    "skills/*/SKILL.md",
    "infra/*/README.md",
]

def discover_files(repo: Path):
    files = []
    for name in DOC_ROOT_FILES:
        p = repo / name
        if p.exists():
            files.append(p)
    for pattern in DOC_GLOBS:
        files.extend(sorted(repo.glob(pattern)))
    return files


def report_unhandled(repo: Path, known: set):
    """Lists any `*.md` at the repo root not in DOC_ROOT_FILES -- this
    corpus's own allowlist gives no other signal if a new fleet-wide doc
    shows up that nobody added to DOC_ROOT_FILES/DOC_GLOBS. Root-only,
    deliberately: see this file's own 1.4.0 changelog entry for why a full
    repo walk would bury the signal instead of surfacing it."""
    unknown = sorted(p for p in repo.glob("*.md") if p not in known)
    for p in unknown:
        print(f"SKIPPED (root .md not on allowlist): {p.relative_to(repo)}", file=sys.stderr)


def ingest_file(conn, repo: Path, path: Path, dry_run: bool) -> int:
    rel = str(path.relative_to(repo))
    text = path.read_text(encoding="utf-8", errors="replace")
    file_hash = rag.content_hash(text)

    row = conn.execute(
        "SELECT file_hash FROM ingest_state WHERE corpus=? AND source_path=?", (CORPUS, rel)
    ).fetchone()
    if row and row[0] == file_hash:
        return 0

    chunks = list(rag.chunk_file(text, MAX_CHUNK_CHARS))
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    if dry_run:
        print(f"[dry-run] {rel}: {len(chunks)} chunk(s) would be (re)embedded")
        return len(chunks)

    conn.execute("DELETE FROM chunks WHERE corpus=? AND source_path=?", (CORPUS, rel))
    conn.execute(
        "DELETE FROM vec_chunks WHERE chunk_id IN "
        "(SELECT id FROM chunks WHERE corpus=? AND source_path=?)",
        (CORPUS, rel),
    )

    for idx, (header, chunk_text) in enumerate(chunks):
        citation = f"{rel} — {header}" if header not in ("(preamble)", "(no heading)") else rel
        vec = rag.embed(chunk_text)
        cur = conn.execute(
            "INSERT INTO chunks (corpus, source_path, section, chunk_index, chunk_text, "
            "citation, content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
            (CORPUS, rel, header, idx, chunk_text, citation, rag.content_hash(chunk_text), now),
        )
        chunk_id = cur.lastrowid
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (chunk_id, rag.pack_vec(vec)),
        )

    conn.execute(
        "INSERT INTO ingest_state (corpus, source_path, file_hash, last_ingested) VALUES (?,?,?,?) "
        "ON CONFLICT(corpus, source_path) DO UPDATE SET file_hash=excluded.file_hash, "
        "last_ingested=excluded.last_ingested",
        (CORPUS, rel, file_hash, now),
    )
    conn.commit()
    return len(chunks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=str(Path.home() / "HermesAgentV5"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    files = discover_files(repo)
    if not files:
        print(f"ERROR: no fleet-doc files found under {repo}", file=sys.stderr)
        return 1

    report_unhandled(repo, set(files))

    conn = rag.connect(readonly=False)
    total_chunks = 0
    changed_files = 0
    for path in files:
        try:
            n = ingest_file(conn, repo, path, args.dry_run)
        except RuntimeError as e:
            print(f"ERROR embedding {path}: {e}", file=sys.stderr)
            return 1
        if n:
            changed_files += 1
            total_chunks += n

    if args.dry_run:
        print(f"Scanned {len(files)} file(s), {changed_files} changed, {total_chunks} chunk(s) (re)embedded.")
        return 0

    current = {str(p.relative_to(repo)) for p in files}
    pruned = rag.prune_stale(conn, CORPUS, current)
    if pruned:
        print(f"Pruned {len(pruned)} stale source(s): {', '.join(pruned)}")

    print(f"Scanned {len(files)} file(s), {changed_files} changed, {total_chunks} chunk(s) (re)embedded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
