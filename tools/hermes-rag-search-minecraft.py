#!/usr/bin/env python3
# Version: 2.0.0
#
# 2.0.0 (2026-09-24) -- direct request ("minimize and deduplicate behavior rules and tools"):
# absorbed hermes-rag-search-minecraft-skills.py, which was byte-identical to this file in
# every executable line and differed only in one constant. Corpus is now a --corpus flag
# defaulting to "minecraft", so skills.js passes --corpus minecraft-skills and the second file
# is deleted rather than kept in sync by hand.
#
# 1.1.0 (2026-09-07) -- added "distance" to each result. Real gap found live: the same "no
# oak_log found nearby" fact got written to the shared world corpus four separate times over one
# night (services/minecraft-bots/longterm.js's writeMemoryNote() had no way to tell a near-
# duplicate was already there, since this script silently dropped hermes_rag_common.search()'s
# own cosine distance before it ever left this process). Exposing it lets a caller check
# "is there already a note this close?" before writing another one.
"""
hermes-rag-search-minecraft.py -- CLI search over the Minecraft bots' RAG corpora, for
services/minecraft-bots/{longterm,skills}.js to shell out to. hermes_rag_common has no HTTP API
(direct SQLite+sqlite-vec file access, unlike hermes-router.py/hermes-memory.py) -- this is the
thin bridge, kept to a single-purpose read path.

Two corpora, deliberately separate rather than one corpus with two prefixes: ordinary note recall
must never surface a skill's structured description as if it were a free-text world fact.

    minecraft         long-term memory -- world/... shared facts, bots/<name>/... personal.
    minecraft-skills  the dynamic skill library. `text` is a skill's DESCRIPTION only; the
                      caller reads source_path's matching .json sibling for {name, steps}.

Prints a JSON array of {citation, text, source_path, distance} to stdout, best (lowest
distance) first.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-search-minecraft.py "<query>" [--top-k N]
        [--corpus minecraft|minecraft-skills]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

CORPORA = ("minecraft", "minecraft-skills")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--top-k", type=int, default=3)
    ap.add_argument("--corpus", choices=CORPORA, default=CORPORA[0])
    args = ap.parse_args()

    try:
        results = rag.search(args.query, corpus=args.corpus, top_k=args.top_k)
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
