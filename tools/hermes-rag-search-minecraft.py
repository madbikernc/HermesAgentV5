#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-rag-search-minecraft.py -- CLI search over the "minecraft" long-term memory corpus
(MINECRAFT_BOTS_DESIGN.md §7), for services/minecraft-bots/longterm.js to shell out to.
hermes_rag_common has no HTTP API (direct SQLite+sqlite-vec file access, unlike
hermes-router.py/hermes-memory.py) -- this is the thin bridge, same split as
hermes-rag-ingest-minecraft.py's own docstring explains, kept to a single-purpose read path.

Prints a JSON array of {citation, text, source_path} to stdout, best (lowest distance) first.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-search-minecraft.py "<query>" [--top-k N]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

CORPUS = "minecraft"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--top-k", type=int, default=3)
    args = ap.parse_args()

    try:
        results = rag.search(args.query, corpus=CORPUS, top_k=args.top_k)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    print(json.dumps([
        {"citation": r["citation"], "text": r["text"], "source_path": r["source_path"]}
        for r in results
    ]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
