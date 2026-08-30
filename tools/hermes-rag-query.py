#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 — Phase 31: query() now delegates to hermes_rag_common.search(),
# factored out once hermes-news-digest.py needed the same retrieval logic
# restricted to chunks newer than a cursor. No behavior change here.
"""
hermes-rag-query.py — Phase 30 (IMPLEMENTATION_PLAN.md §7) retrieval tool.
Narrow and deterministic per §2a: cosine-similarity search over
/mnt/hermes-data/rag/vectors.db, no LLM judgment involved, so it adds no new
fabrication surface. Every result carries its real source citation
(constraint 6) so a caller can never present a match without a way to check
it against the underlying document.

Opens the database read-only — this tool never writes. Both Sintra and Amy
call it directly; it's a subprocess, not a service, same invocation pattern
as every other status/monitoring tool in this project (skills/*/SKILL.md
document the exact command).

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-query.py "question text" [--corpus fleet-docs] [--top-k 5]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402


def query(text: str, corpus: str, top_k: int):
    return rag.search(text, corpus=corpus, top_k=top_k)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("question")
    ap.add_argument("--corpus", default=None, help="restrict to one corpus (e.g. fleet-docs)")
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    try:
        results = query(args.question, args.corpus, args.top_k)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if not results:
        print("No matching chunks found." if not args.json else "[]")
        return 0

    if args.json:
        print(json.dumps(results, indent=2))
        return 0

    for r in results:
        print(f"--- {r['citation']}  (distance={r['distance']:.4f})")
        print(r["text"])
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
