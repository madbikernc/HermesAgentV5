#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-rag-eval — retrieval-quality evaluation harness for the RAG stack
# (HermesAgentV5/IMPLEMENTATION_PLAN.md S16a). Distinct from tools/hermes-benchmark-model.py's
# suite (S11) — that measures general model capability, this measures whether the actual vector
# search finds the right chunk for a real question. Same "eval sets before promoting anything"
# discipline S11 used for abliteration, applied here to retrieval quality instead of a checkpoint,
# and built deliberately *before* S16b's reranker so "it helped" is a measured claim, not an
# assumption.
#
# Two modes:
#   --generate   Sample real chunks from the live vector store, ask `dispatch` (stock, always
#                resident — same reasoning hermes-retrieve.py already established for
#                non-adversarial synthesis work) to write one natural question each chunk
#                directly answers, and save {question, corpus, expected_chunk_id, citation} as a
#                fixed eval set. Grounded in real indexed content, not hand-invented — every
#                expected answer is a real chunk that really exists.
#   (default)    Load the saved eval set, run each question through hermes_rag_common.search()
#                exactly as hermes-retrieve.py calls it (corpus=None — the harder, realistic case:
#                can the system find the right corpus AND chunk, not just rank within a known
#                one), and report recall@k: does the expected chunk actually land in the top k
#                results. Appends one line to a JSONL history file so a later "with reranker" run
#                has a real baseline to compare against, same shape S11's benchmark-compare
#                history already uses.
#
# The eval set is fixed once generated (not regenerated per run) specifically so a before/after
# reranker comparison is measuring the same questions, not new ones.
#
# Usage:
#   /opt/hermes/venvs/rag/bin/python3 hermes-rag-eval.py --generate [--per-corpus N]
#   /opt/hermes/venvs/rag/bin/python3 hermes-rag-eval.py [--top-k 5] [--notes "..."]
#
# Requires the rag venv (sqlite-vec) — same as hermes-rag-query.py.

import argparse
import json
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rc  # noqa: E402

EVAL_SET_PATH = Path.home() / ".hermes" / "state" / "rag-eval-set.json"
HISTORY_PATH = Path.home() / ".hermes" / "state" / "rag-eval-history.jsonl"

# ops/personal-kb are real but small (24/17 chunks live, 2026-08-31) — sampling more than exists
# would just be the whole corpus with extra steps; capped per-corpus below, not forced uniform.
DEFAULT_PER_CORPUS = 25
CORPORA = ["fleet-docs", "podcasts", "ops", "personal-kb"]

QUESTION_PROMPT = (
    "You are building a retrieval-evaluation question. Given the excerpt below, write ONE "
    "specific, natural question that a person would plausibly ask, whose answer is directly "
    "contained in this excerpt and nowhere else. Reply with ONLY the question, ending in '?' — "
    "no preamble, no quotes, no explanation. If the excerpt is too short or generic to support a "
    "specific question (e.g. a bare heading, a timestamp line), reply with exactly: SKIP"
)


def log(msg):
    print(f"[hermes-rag-eval] {msg}", flush=True)


def sample_chunks(conn, corpus, n, seed):
    rows = conn.execute(
        "SELECT id, citation, chunk_text FROM chunks WHERE corpus=?", (corpus,)
    ).fetchall()
    if not rows:
        return []
    rnd = random.Random(seed)
    rnd.shuffle(rows)
    return rows[:n]


def generate_question(chunk_text):
    text = rc.sanitize_llm_input(chunk_text, max_len=3000)
    reply = rc.router_chat(
        [
            {"role": "system", "content": QUESTION_PROMPT},
            {"role": "user", "content": text},
        ],
        model="dispatch",
        timeout=60,
    ).strip()
    if reply.upper() == "SKIP" or len(reply) < 8 or "?" not in reply:
        return None
    return reply


def cmd_generate(per_corpus):
    conn = rc.connect(readonly=True)
    eval_set = []
    for corpus in CORPORA:
        n = min(per_corpus, 999)
        chunks = sample_chunks(conn, corpus, n, seed=f"rag-eval-{corpus}")
        log(f"{corpus}: sampled {len(chunks)} chunks, generating questions...")
        kept = 0
        for chunk_id, citation, chunk_text in chunks:
            try:
                question = generate_question(chunk_text)
            except Exception as exc:
                log(f"  chunk {chunk_id}: generation failed, skipping ({exc})")
                continue
            if not question:
                continue
            eval_set.append({
                "question": question,
                "corpus": corpus,
                "expected_chunk_id": chunk_id,
                "citation": citation,
            })
            kept += 1
        log(f"{corpus}: kept {kept} real questions")

    EVAL_SET_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVAL_SET_PATH.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "per_corpus_requested": per_corpus,
        "questions": eval_set,
    }, indent=2))
    log(f"wrote {len(eval_set)} questions to {EVAL_SET_PATH}")
    return 0


def cmd_run(top_k, notes):
    if not EVAL_SET_PATH.exists():
        log(f"no eval set at {EVAL_SET_PATH} — run --generate first")
        return 1
    data = json.loads(EVAL_SET_PATH.read_text())
    questions = data["questions"]
    log(f"loaded {len(questions)} questions (generated {data.get('generated_at', '?')})")

    hits = 0
    per_corpus = {c: {"n": 0, "hits": 0} for c in CORPORA}
    misses = []
    for q in questions:
        corpus = q["corpus"]
        per_corpus[corpus]["n"] += 1
        try:
            # corpus=None deliberately — the real, harder case: hermes-retrieve.py never knows
            # which corpus has the answer in advance, so neither should this eval.
            results = rc.search(q["question"], corpus=None, top_k=top_k)
        except Exception as exc:
            log(f"search failed for {q['question']!r}: {exc}")
            misses.append({**q, "reason": "search-error"})
            continue
        found_ids = [r["chunk_id"] for r in results]
        if q["expected_chunk_id"] in found_ids:
            hits += 1
            per_corpus[corpus]["hits"] += 1
        else:
            misses.append({**q, "reason": "not-in-top-k", "got_chunk_ids": found_ids})

    recall = hits / len(questions) if questions else 0.0
    log(f"\n=== recall@{top_k}: {hits}/{len(questions)} = {recall:.3f} ===")
    for corpus in CORPORA:
        n = per_corpus[corpus]["n"]
        h = per_corpus[corpus]["hits"]
        if n:
            log(f"  {corpus:14s} {h}/{n} = {h/n:.3f}")
    if misses:
        log(f"\n{len(misses)} misses (first 5):")
        for m in misses[:5]:
            log(f"  [{m['corpus']}] {m['question']!r} — expected chunk {m['expected_chunk_id']}, reason={m['reason']}")

    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "date": datetime.now(timezone.utc).isoformat(),
        "top_k": top_k,
        "n_questions": len(questions),
        "hits": hits,
        "recall": recall,
        "per_corpus": {c: (v["hits"] / v["n"] if v["n"] else None) for c, v in per_corpus.items()},
        "notes": notes,
    }
    with HISTORY_PATH.open("a") as f:
        f.write(json.dumps(entry) + "\n")
    log(f"\nrecorded to {HISTORY_PATH}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="RAG retrieval-quality evaluation harness (S16a)")
    parser.add_argument("--generate", action="store_true", help="generate a new fixed eval set")
    parser.add_argument("--per-corpus", type=int, default=DEFAULT_PER_CORPUS,
                         help=f"questions to attempt per corpus when generating (default {DEFAULT_PER_CORPUS})")
    parser.add_argument("--top-k", type=int, default=5, help="recall@k to measure (default 5, matches hermes-retrieve.py's own TOP_K default)")
    parser.add_argument("--notes", default="", help="free-text note stored with this run")
    args = parser.parse_args()

    if args.generate:
        return cmd_generate(args.per_corpus)
    return cmd_run(args.top_k, args.notes)


if __name__ == "__main__":
    sys.exit(main())
