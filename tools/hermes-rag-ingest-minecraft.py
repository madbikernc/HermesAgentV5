#!/usr/bin/env python3
# Version: 2.0.0
#
# 2.0.0 (2026-09-24) -- direct request ("minimize and deduplicate behavior rules and tools"):
# absorbed hermes-rag-ingest-minecraft-skills.py. The two files were the same ~90-line ingester
# differing in five spots -- corpus name, source directory, recursive vs flat glob, and the
# citation string. Those five now live in CORPORA below and the second file is deleted rather
# than kept in sync by hand (it had already drifted: the skills copy never gained a changelog
# entry for anything this one fixed). --corpus defaults to "minecraft", so existing callers are
# unaffected.
#
# Putting the two side by side also surfaced a real, pre-existing bug, fixed here: the memory
# corpus's recursive scan was swallowing skills/*.md (the skills directory lives inside the
# memory directory) and embedding every skill description into the "minecraft" corpus, which is
# precisely the cross-contamination the separate corpus was built to prevent. See CORPORA's own
# `skip` note below. No migration needed -- prune_stale() drops the wrongly-ingested skills/*
# rows from the "minecraft" corpus on this script's next real run, since they no longer appear
# in its discovered set.
"""
hermes-rag-ingest-minecraft.py -- (re)embeds the Minecraft bots' markdown memory into RAG, one
file per memory, same chunks/vec_chunks/ingest_state shape and content-hash dedup every other
per-corpus ingester in this repo uses (hermes-rag-ingest-ops.py is the closest sibling -- its
docstring covers that schema's rationale, not repeated here).

Two corpora, deliberately separate rather than one corpus with a third source_path prefix:
ordinary note recall (longterm.js's searchMemory(), used before replies and planning) must never
surface a skill's structured description as if it were a free-text world fact.

    minecraft         /mnt/hermes-data/minecraft-memory, scanned recursively. Two source_path
                      prefixes distinguish the two kinds of long-term memory inside one corpus,
                      avoiding a corpus (and an ingest script) per bot as bots get added:
                        world/...       shared, objective facts any bot writes and all bots read
                        bots/<name>/... one bot's own personal/episodic memory
    minecraft-skills  .../skills, flat. A skill is two files sharing a basename: <name>.md is
                      the human-readable description, and is the ONLY part embedded here --
                      keeping retrieval clean rather than diluted by the payload. <name>.json
                      holds the runnable {name, steps}; skills.js reads it directly once a
                      search hit names it, and this script never touches it.

Notes are written by the orchestrator (services/minecraft-bots/longterm.js, skills.js) as plain
files, never touching this script's storage directly -- the embedding and vector logic stays in
Python where the sqlite-vec dependency lives, the same "shell out to a purpose-built script"
split memory.js/router.js already use for fleet services that speak plain HTTP instead.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-ingest-minecraft.py [--dry-run]
        [--corpus minecraft|minecraft-skills]
"""
import argparse
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

MEMORY_DIR = Path("/mnt/hermes-data/minecraft-memory")
MAX_CHUNK_CHARS = 1200

# Everything that actually differed between the two former scripts, plus one exclusion that
# should always have been there. `recursive` is real, not cosmetic: the memory corpus nests
# (world/, bots/<name>/) while the skills directory is flat -- and sits INSIDE the memory dir.
#
# `skip`: the memory corpus's own rglob was silently swallowing skills/*.md and embedding every
# skill description into the "minecraft" corpus as if it were a world fact -- the exact
# cross-contamination both scripts' docstrings said the separate corpus existed to prevent. A
# real pre-existing bug, present since the skills corpus was added (2026-09-08) and only visible
# once the two ingesters sat side by side in one file. Excluded explicitly rather than by moving
# the directory, which would strand every already-written skill.
CORPORA = {
    "minecraft": {
        "dir": MEMORY_DIR,
        "recursive": True,
        "skip": lambda p: p.parts[0] == "skills",
        "citation": lambda p: "Minecraft " + (
            "World memory" if p.startswith("world/") else "Personal memory") + f" -- {p}",
    },
    "minecraft-skills": {
        "dir": MEMORY_DIR / "skills",
        "recursive": False,
        "skip": lambda p: False,
        "citation": lambda p: f"Minecraft Skill -- {Path(p).stem}",
    },
}


def discover_files(cfg):
    src = cfg["dir"]
    if not src.is_dir():
        return []
    globber = src.rglob if cfg["recursive"] else src.glob
    return sorted(p for p in globber("*.md")
                  if p.is_file() and not cfg["skip"](p.relative_to(src)))


def ingest_file(conn, corpus, cfg, path: Path, dry_run: bool) -> int:
    source_path = str(path.relative_to(cfg["dir"]))
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        return 0

    file_hash = rag.content_hash(text)
    row = conn.execute(
        "SELECT file_hash FROM ingest_state WHERE corpus=? AND source_path=?", (corpus, source_path)
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
    conn.execute("DELETE FROM chunks WHERE corpus=? AND source_path=?", (corpus, source_path))
    conn.execute(
        "DELETE FROM vec_chunks WHERE chunk_id IN "
        "(SELECT id FROM chunks WHERE corpus=? AND source_path=?)",
        (corpus, source_path),
    )
    base_citation = cfg["citation"](source_path)
    for idx, (header, body) in enumerate(chunks):
        citation = base_citation + (f" ({header})" if header else "")
        vec = rag.embed(body)
        cur = conn.execute(
            "INSERT INTO chunks (corpus, source_path, section, chunk_index, chunk_text, "
            "citation, content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
            (corpus, source_path, header, idx, body, citation, rag.content_hash(body), now),
        )
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (cur.lastrowid, rag.pack_vec(vec)),
        )
    conn.execute(
        "INSERT INTO ingest_state (corpus, source_path, file_hash, last_ingested) VALUES (?,?,?,?) "
        "ON CONFLICT(corpus, source_path) DO UPDATE SET file_hash=excluded.file_hash, "
        "last_ingested=excluded.last_ingested",
        (corpus, source_path, file_hash, now),
    )
    conn.commit()
    return len(chunks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--corpus", choices=tuple(CORPORA), default="minecraft")
    args = ap.parse_args()

    corpus = args.corpus
    cfg = CORPORA[corpus]

    conn = rag.connect(readonly=False)
    files = discover_files(cfg)
    total_chunks = 0
    changed = 0
    for path in files:
        n = ingest_file(conn, corpus, cfg, path, args.dry_run)
        if n:
            changed += 1
            total_chunks += n

    if not args.dry_run:
        current = {str(p.relative_to(cfg["dir"])) for p in files}
        pruned = rag.prune_stale(conn, corpus, current)
        if pruned:
            print(f"Pruned {len(pruned)} stale source(s): {', '.join(pruned)}")

    print(f"Scanned {len(files)} file(s), {changed} changed, {total_chunks} chunk(s) (re)embedded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
