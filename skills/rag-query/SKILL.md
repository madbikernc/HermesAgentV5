---
name: rag-query
description: "Search the fleet's own indexed knowledge — fleet docs, the podcast archive (Security Now!, Intelligent Machines, Tech Brew Ride Home story-links), each node's latest health snapshot, and a personal-notes folder (once populated) — for passages relevant to a question. Read-only, deterministic retrieval — every result carries a real citation back to its source."
version: 2.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [rag, search, knowledge-base]
prerequisites:
  commands: [python3]
  venv: /opt/hermes/venvs/rag/
---

# RAG Query

**Version:** 2.0.0

Retrieval-augmented search over the fleet's indexed corpora (Phase 30,
`IMPLEMENTATION_PLAN.md` §7). Four corpora, all live as of this build:
- `fleet-docs` — this project's own documentation.
- `podcasts` — Security Now! and Intelligent Machines transcripts (~1150
  episodes), plus Tech Brew Ride Home's per-episode story-links
  citation list (no transcript exists for that show) — growing via a daily
  catch-up timer.
- `ops` — each node's **latest** `hermes-node-health.py` snapshot (Sintra,
  Amy, HomeD13). A current-state corpus, not a history — the underlying
  report itself is overwrite-only, so this reflects "as of the last real
  health-check run," not a live-real-time or historical query.
- `personal-kb` — `.md`/`.txt`, `.pdf`/`.docx`, and `.epub`, files from the
  `RAGDocs` NAS share (sibling to `PodCasts`), a Boss-managed personal notes
  folder. `.mobi`/`.azw3` aren't ingested — no clean pure-Python reader
  exists for Amazon's proprietary formats and they're frequently
  DRM-locked; video/audio aren't ingested either.

This tool never asks an LLM to judge relevance; it's pure cosine-similarity
search against `/mnt/hermes-data/rag/vectors.db`, so it can't fabricate a
match — only return real indexed text with its real source citation.

## How to use it

Use the **shared venv's** `python3`, not the system one:

```bash
/opt/hermes/venvs/rag/bin/python3 ~/HermesAgentV5/tools/hermes-rag-query.py "your question" [--corpus fleet-docs|podcasts|ops|personal-kb] [--top-k 5]
```

Omit `--corpus` to search everything indexed. Each result prints its citation
directly above the matched text — a doc section (`file — section`) for
`fleet-docs`, a show/episode/date for `podcasts` (with a `(part N/M)` suffix
for a multi-chunk episode), `Node health — <node> — <section> (as of
<timestamp>)` for `ops`, or the relative file path for `personal-kb` — always
relay that citation alongside anything quoted from a result, so whoever reads
the answer can check it against the real source. A result with a high
`distance` value is a weak match; don't present it as authoritative without
saying so.

## What it can't do

- No write path — this tool never modifies the index. Ingestion is separate,
  pmoney-run tooling (`hermes-rag-ingest-docs.py`, `hermes-rag-ingest-podcasts.py`,
  `hermes-rag-ingest-ops.py`, `hermes-rag-ingest-kb.py`).
- No cross-corpus judgment or summarization — it returns raw matched chunks,
  not a synthesized answer. If a task needs a synthesized brief from matched
  passages (the way the pfSense/canary daily digests already delegate
  narrative judgment to `super`), that composition step happens in the
  calling context, not in this tool.
- `ops` results can be stale — they reflect the last real health-check run,
  not this instant. For a genuinely live check, use `skills/fleet-health/SKILL.md`
  instead.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 2.0.0 | 2026-08-21 | Ported from `HermesAgentRedo` 1.5.0 — repo path updated, and the "narrative judgment" cross-reference updated from `weaver` to `super` (a general-reasoning task, not a coding one — found in the same honest-delegation sweep that caught `hermes-fabrication-guard.sh`'s stale role names, not by the original migration audit). No other behavior changes. |
