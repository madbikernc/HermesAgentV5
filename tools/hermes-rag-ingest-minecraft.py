#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-rag-ingest-minecraft.py -- long-term memory corpus for the Firmament's Minecraft bots
(MINECRAFT_BOTS_DESIGN.md §7). Scans /mnt/hermes-data/minecraft-memory/ for small markdown
notes and (re)embeds them into the "minecraft" corpus, same chunks/vec_chunks/ingest_state
shape and content-hash dedup every other per-corpus ingester in this repo already uses
(hermes-rag-ingest-ops.py is the closest sibling -- ops.py's own docstring covers that
schema's rationale, not repeated here).

Two source_path prefixes distinguish the two kinds of long-term memory the design doc calls
for, inside one corpus rather than one corpus per kind (avoids a CORPORA entry -- and an
ingest script -- per bot as more bots get added):
  world/...      -- shared, objective facts any bot can write and all bots read.
  bots/<name>/... -- one bot's own personal/episodic memory.

Notes are small individual .md files (one memory = one file), written by the orchestrator
(services/minecraft-bots/longterm.js) as plain text, not touching this script's own storage
directly -- it only ever writes files to a directory, keeping the actual embedding/vector
logic in Python where the sqlite-vec dependency actually lives, same "shell out to a
purpose-built script" split memory.js/router.js already use for other fleet services that
speak plain HTTP instead.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-ingest-minecraft.py [--dry-run]
"""
import argparse
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

CORPUS = "minecraft"
MEMORY_DIR = Path("/mnt/hermes-data/minecraft-memory")
MAX_CHUNK_CHARS = 1200


def discover_files():
    if not MEMORY_DIR.is_dir():
        return []
    return sorted(p for p in MEMORY_DIR.rglob("*.md") if p.is_file())


def ingest_file(conn, path: Path, dry_run: bool) -> int:
    source_path = str(path.relative_to(MEMORY_DIR))
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        return 0

    file_hash = rag.content_hash(text)
    row = conn.execute(
        "SELECT file_hash FROM ingest_state WHERE corpus=? AND source_path=?", (CORPUS, source_path)
    ).fetchone()
    if row and row[0] == file_hash:
        return 0

    chunks = list(rag.chunk_file(text, MAX_CHUNK_CHARS))
    if not chunks:
        return 0

    if dry_run:
        print(f"[dry-run] {source_path}: {len(chunks)} chunk(s) would be (re)embedded")
        return len(chunks)

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn.execute("DELETE FROM chunks WHERE corpus=? AND source_path=?", (CORPUS, source_path))
    conn.execute(
        "DELETE FROM vec_chunks WHERE chunk_id IN "
        "(SELECT id FROM chunks WHERE corpus=? AND source_path=?)",
        (CORPUS, source_path),
    )
    scope = "World memory" if source_path.startswith("world/") else "Personal memory"
    for idx, (header, body) in enumerate(chunks):
        citation = f"Minecraft {scope} -- {source_path}" + (f" ({header})" if header else "")
        vec = rag.embed(body)
        cur = conn.execute(
            "INSERT INTO chunks (corpus, source_path, section, chunk_index, chunk_text, "
            "citation, content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
            (CORPUS, source_path, header, idx, body, citation, rag.content_hash(body), now),
        )
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (cur.lastrowid, rag.pack_vec(vec)),
        )
    conn.execute(
        "INSERT INTO ingest_state (corpus, source_path, file_hash, last_ingested) VALUES (?,?,?,?) "
        "ON CONFLICT(corpus, source_path) DO UPDATE SET file_hash=excluded.file_hash, "
        "last_ingested=excluded.last_ingested",
        (CORPUS, source_path, file_hash, now),
    )
    conn.commit()
    return len(chunks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = rag.connect(readonly=False)
    files = discover_files()
    total_chunks = 0
    changed = 0
    for path in files:
        n = ingest_file(conn, path, args.dry_run)
        if n:
            changed += 1
            total_chunks += n

    if not args.dry_run:
        current = {str(p.relative_to(MEMORY_DIR)) for p in files}
        pruned = rag.prune_stale(conn, CORPUS, current)
        if pruned:
            print(f"Pruned {len(pruned)} stale source(s): {', '.join(pruned)}")

    print(f"Scanned {len(files)} file(s), {changed} changed, {total_chunks} chunk(s) (re)embedded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
