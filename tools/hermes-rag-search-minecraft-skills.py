#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-rag-search-minecraft-skills.py -- CLI search over the "minecraft-skills" dynamic skill
library corpus (MINECRAFT_BOTS_DESIGN.md §14), for services/minecraft-bots/skills.js to shell
out to. Same thin-bridge split as hermes-rag-search-minecraft.py (hermes_rag_common has no HTTP
API, unlike hermes-router.py/hermes-memory.py).

Prints a JSON array of {citation, text, source_path, distance} to stdout, best (lowest
distance) first. `text` here is a skill's own description (see the ingest script's own
docstring for why only the description is embedded, not the runnable steps); the caller reads
`source_path`'s matching `.json` sibling directly to get the actual `{name, steps}` payload.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-search-minecraft-skills.py "<goal description>" [--top-k N]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

CORPUS = "minecraft-skills"


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
        {"citation": r["citation"], "text": r["text"], "source_path": r["source_path"],
         "distance": r["distance"]}
        for r in results
    ]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
