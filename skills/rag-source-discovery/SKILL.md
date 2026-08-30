---
name: rag-source-discovery
description: "Review and decide on external-resource mentions (books, papers, podcast episodes, articles, sites) found automatically inside newly-indexed RAG chunks. Boss-review tool, not a self-directed persona action — a candidate stays inert until the Boss actually decides on it."
version: 2.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [rag, discovery, boss-review]
prerequisites:
  commands: [python3]
  venv: /opt/hermes/venvs/rag/
---

# RAG Source Discovery

**Version:** 2.0.0

A daily scan (`hermes-rag-source-discovery.timer`) reads newly-indexed
RAG chunks, asks the router (`super`) to name any explicit resource mentions in
them, and records candidates in `vectors.db`. Anything pending is emailed to the
Boss as a digest. **This tool never fetches or indexes anything on its own — a
candidate is inert until the Boss decides.**

## Boss-review only

This is not a capability either persona should reach for on its own initiative —
only when directly relaying an explicit Boss decision ("mark candidate 3 as
archived and indexed"). Same tier as `hermes-fleet-health.py`'s daily rollup:
built for the Boss's own review, not a self-directed persona action.

## How to use it

```bash
# See what's pending
/opt/hermes/venvs/rag/bin/python3 ~/HermesAgentV5/tools/hermes-rag-source-discovery.py list [--status pending]

# Record the Boss's decision on a candidate — two separable gates:
#   declined          — not worth tracking at all
#   archived          — worth tracking as a source, but not indexed into RAG
#   archived-indexed  — worth tracking AND indexing
/opt/hermes/venvs/rag/bin/python3 ~/HermesAgentV5/tools/hermes-rag-source-discovery.py decide <id> <archived|archived-indexed|declined> [--notes "..."]
```

`decide archived-indexed` only **records** that decision — it does not fetch or
embed anything. Actually acquiring a resource needs its own narrow,
resource-type-specific tool (following Phase 24's podcast-sync precedent), built
once a real candidate is approved, never speculatively ahead of one.

## What it can't do

- No auto-onboarding — nothing here ever adds a new source or corpus on its own
  initiative.
- No general-purpose fetcher — per constraint 2, a real "yes" gets its own
  narrow, scoped acquisition tool, not a generic downloader that could reach
  arbitrary URLs.
- The first scan after install doesn't retroactively process the existing
  backlog — only chunks indexed after that point are ever considered.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 2.0.0 | 2026-08-21 | Ported from `HermesAgentRedo` 1.0.0 — repo path updated, and the router call updated from `weaver` to `super` (a general-reasoning/extraction task, not a coding one — found in the same honest-delegation sweep that caught `hermes-fabrication-guard.sh`'s stale role names, not by the original migration audit). No other behavior changes. Earlier versions' changes were never recorded in a table — it starts here rather than reconstructing history this file didn't track. |
