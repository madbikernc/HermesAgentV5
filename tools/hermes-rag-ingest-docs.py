#!/usr/bin/env python3
# Version: 1.2.1
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
import re
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

HEADER_RE = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)


def split_sections(text: str):
    """Yield (header_path, body) for each markdown header block. header_path
    is the nearest header text (not a full breadcrumb) — enough for a real
    citation without over-engineering a heading-stack tracker this corpus
    doesn't need."""
    matches = list(HEADER_RE.finditer(text))
    if not matches:
        yield ("(no heading)", text.strip())
        return
    if matches[0].start() > 0:
        preamble = text[: matches[0].start()].strip()
        if preamble:
            yield ("(preamble)", preamble)
    for i, m in enumerate(matches):
        header = m.group(2).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if body:
            yield (header, body)


def split_paragraphs(body: str, max_chars: int):
    """This doc set has table rows and long-form entries written as one
    giant line with no blank-line breaks (IMPLEMENTATION_PLAN.md's per-phase
    log rows run several thousand characters) — rag.group_blocks()'s hard
    sentence/character fallback handles those, shared with the podcast
    ingester's own long-monologue-turn problem."""
    return rag.group_blocks(body.split("\n\n"), max_chars)


def chunk_file(text: str):
    for header, body in split_sections(text):
        if len(body) <= MAX_CHUNK_CHARS:
            yield (header, body)
        else:
            for sub in split_paragraphs(body, MAX_CHUNK_CHARS):
                yield (header, sub)


def discover_files(repo: Path):
    files = []
    for name in DOC_ROOT_FILES:
        p = repo / name
        if p.exists():
            files.append(p)
    for pattern in DOC_GLOBS:
        files.extend(sorted(repo.glob(pattern)))
    return files


def ingest_file(conn, repo: Path, path: Path, dry_run: bool) -> int:
    rel = str(path.relative_to(repo))
    text = path.read_text(encoding="utf-8", errors="replace")
    file_hash = rag.content_hash(text)

    row = conn.execute(
        "SELECT file_hash FROM ingest_state WHERE corpus=? AND source_path=?", (CORPUS, rel)
    ).fetchone()
    if row and row[0] == file_hash:
        return 0

    chunks = list(chunk_file(text))
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
