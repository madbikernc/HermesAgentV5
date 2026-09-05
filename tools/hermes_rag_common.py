#!/usr/bin/env python3
# Version: 1.7.0
#
# 1.7.0 (2026-09-04) — EMBED_DIMS 1024 -> 4096, matching the embed swap to Qwen3-Embedding-8B
# (infra/hermes-rag/start-embed.sh). New `_migrate_vec_chunks_dims()`: `vec_chunks` is a sqlite-vec
# vec0 table with its dimension fixed at CREATE time, so changing the constant alone does nothing
# to the live table -- CREATE VIRTUAL TABLE IF NOT EXISTS no-ops against it, and the next real
# insert of a 4096-dim vector into a table still declared float[1024] fails outright. Detects the
# live table's actual dimension from sqlite_master (same idiom hermes-memory.py's own
# _migrate_turns_autoincrement() already uses for its schema-shape changes) and, on mismatch,
# rebuilds the table and re-embeds every row already in `chunks` -- self-contained, doesn't need a
# full rag_reindex of all four corpora first since chunk_text already lives in this database.
#
# 1.6.0 (2026-09-04) — moved split_sections()/chunk_file() here from
# hermes-rag-ingest-docs.py (unchanged in behavior, chunk_file() now takes
# max_chars as a parameter instead of reading that script's own module
# global): hermes-rag-ingest-kb.py needed the identical header-aware
# chunking once it started converting PDF/DOCX to real structured markdown
# via the new hermes_doc_to_markdown.py rather than flat plain text. Same
# "a hyphenated tools/ filename can't be imported" reasoning that already
# justified every other function in this file.
#
# 1.5.0 — S16b: reranking. search() over-fetches a wider KNN candidate pool (RERANK_WIDEN, default
# 4x top_k) and reranks it down to the real top_k via a cross-encoder (Qwen3-Reranker-0.6B,
# infra/hermes-rag/start-rerank.sh, port 8093 — reserved for this since target §4.1's own model
# table, unused until now). Real bug found and fixed before this shipped, not assumed away: the
# first GGUF tried (a third-party conversion) produced backwards relevance scores — confirmed
# live with a real query, then confirmed as a known llama.cpp issue (ggml-org/llama.cpp#16407,
# missing `cls.output.weight`) rather than a local misconfiguration, and a `--pooling rank
# --embedding` requirement neither `--reranking` alone nor the broken GGUF's own defaults
# surfaced. Fails open on any rerank error (backend down, timeout, malformed response) — same
# graceful-degradation shape hermes-router.py already uses for Layer 2 (guard unreachable,
# proceed on Layer 1 alone): a worse-ranked top_k beats a hard failure on every retrieval in the
# fleet.
#
# 1.4.0 — Phase 33: discovery_candidates/discovery_scanned_chunks' schema and
# the list/decide operations on them moved here from
# hermes-rag-source-discovery.py, which owned them alone until the new
# hermes-rag-discovery-portal.py (a browser review UI for the same
# candidates) needed the identical list/decide logic. Factored out rather
# than duplicated, same reasoning as every other shared helper in this file
# -- and the only way to actually share it: hermes-rag-source-discovery.py's
# own hyphenated filename can't be `import`ed, so the CLI and the portal both
# import this module instead, same as they already did for connect()/embed().
#
# 1.3.1 — real bug found live during Phase 31 verification: connect() never
# set PRAGMA busy_timeout, so a genuine concurrent writer (the podcast
# backfill, still running in the background) crashed outright with
# "database is locked" the moment a second connection (ad hoc verification
# queries during this same session) touched the file. Fixed with a 30s
# busy_timeout — every legitimate concurrent access pattern in this project
# (five daily ingestion timers, a long-running backfill, interactive
# queries) now waits its turn instead of failing.
#
# 1.3.0 — Phase 31: added search() (factored out of hermes-rag-query.py's
# own query() once hermes-news-digest.py needed the same retrieval but
# restricted to chunks newer than a cursor) and get_state()/set_state()
# (factored out of hermes-rag-source-discovery.py's own state helpers once
# the news digest needed the same key/value bookkeeping in the same
# vectors.db, per constraint "no fifth new store").
#
# 1.2.0 — Phase 30g: added prune_stale(), shared by all four ingestion
# tools. None of them previously removed chunks for a source that
# disappeared since the last run (a deleted fleet doc, a personal-KB note,
# a retired podcast file) -- they'd sit in the index forever, queryable but
# pointing at nothing real. Content-hash incremental re-embed (the other
# half of "freshness") already existed from 30a onward via each ingester's
# own ingest_state check; this closes the other half.
#
# 1.1.0 — Phase 30c: added group_blocks()/hard_split_text(), factored out of
# hermes-rag-ingest-docs.py so the new podcast ingester doesn't duplicate the
# same hard sentence/character-boundary chunk-splitting logic.
"""
hermes_rag_common.py — Shared vector-store and embedding-client helpers for
Phase 30 (RAG infrastructure, IMPLEMENTATION_PLAN.md §7). Factored out ahead
of a second script needing it (hermes-rag-ingest-docs.py and
hermes-rag-query.py both need it from the start), same reasoning
hermes_pfsense_common.py/hermes_canary_common.py were split out for their
own script pairs.

Named with underscores, breaking this project's usual hyphenated-filename
convention for tools/ scripts — deliberately: this file is `import`ed by
the other rag scripts, not invoked directly, and Python cannot import a
module whose filename contains a hyphen.

Vector store: SQLite + the sqlite-vec extension, one file
(/mnt/hermes-data/rag/vectors.db), mirroring hermes-broker's own jobs.db —
boring, durable, one inspectable file, no new service dependency. Owned by
pmoney (0755 dir, 0644 db) so both Sintra's and Amy's own Unix identities
can open it read-only for query-time retrieval; writes (ingestion) are
expected to run as pmoney, the same identity that owns every other
cross-persona data store in this fleet (broker's jobs.db, the botnet-intel
cache, the usage log).

Embedding: query-time embedding always goes through the resident
llama.cpp server on 127.0.0.1:8092 (Qwen3-Embedding-0.6B-Q8_0,
infra/hermes-rag/), never re-implemented per caller.
"""
import datetime
import hashlib
import json
import sys
import os
import re
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path

DB_PATH = Path(os.environ.get("HERMES_RAG_DB", "/mnt/hermes-data/rag/vectors.db"))
EMBED_URL = os.environ.get("HERMES_RAG_EMBED_URL", "http://127.0.0.1:8092/v1/embeddings")
# 4096 as of 2026-09-04 (Qwen3-Embedding-8B, up from the 0.6B model's 1024) -- see
# infra/hermes-rag/start-embed.sh's own changelog for why. _migrate_vec_chunks_dims() below
# handles the live-table consequence of this changing.
EMBED_DIMS = 4096
EMBED_TIMEOUT = 30
RERANK_URL = os.environ.get("HERMES_RAG_RERANK_URL", "http://127.0.0.1:8093/rerank")
RERANK_TIMEOUT = 15
RERANK_WIDEN = 4  # candidate pool fetched before reranking = top_k * RERANK_WIDEN

SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    corpus TEXT NOT NULL,
    source_path TEXT NOT NULL,
    section TEXT,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    citation TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    UNIQUE(corpus, source_path, chunk_index)
);

CREATE TABLE IF NOT EXISTS ingest_state (
    corpus TEXT NOT NULL,
    source_path TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    last_ingested TEXT NOT NULL,
    PRIMARY KEY (corpus, source_path)
);
"""

VEC_TABLE_SQL = "CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[{dims}])"

_VEC_DIMS_RE = re.compile(r"embedding float\[(\d+)\]")


def _migrate_vec_chunks_dims(conn):
    """`vec_chunks` is a sqlite-vec vec0 table with a dimension fixed at CREATE time -- changing
    EMBED_DIMS (2026-09-04, 1024 -> 4096 for the Qwen3-Embedding-8B swap) does nothing to an
    already-existing table, since VEC_TABLE_SQL uses CREATE VIRTUAL TABLE IF NOT EXISTS. Left
    alone, the very next insert of a real 4096-dim vector into a table still declared float[1024]
    fails outright -- not a quality regression, a hard error on every ingester. Detected the same
    way hermes-memory.py's _migrate_turns_autoincrement() detects its own schema-shape change:
    read the live table's actual CREATE statement out of sqlite_master rather than trusting
    EMBED_DIMS matches reality.

    Re-embeds every row already in `chunks` (chunk_text, never deleted by normal ingestion) rather
    than requiring a full rag_reindex of all four corpora first -- source documents aren't needed
    for this, only what's already in this database. Safe to run unattended: idempotent (a
    same-dimension table is a no-op check, not a rebuild), and this file's own `embed()` already
    raises loudly on a backend failure rather than writing a wrong vector."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    ).fetchone()
    if row is None:
        return  # fresh DB -- VEC_TABLE_SQL below creates it at the right dimension directly
    match = _VEC_DIMS_RE.search(row[0])
    live_dims = int(match.group(1)) if match else None
    if live_dims == EMBED_DIMS:
        return  # already migrated, or never needed to be
    print(f"[hermes_rag_common] vec_chunks is {live_dims}-dim, EMBED_DIMS is {EMBED_DIMS} -- "
          f"rebuilding and re-embedding every chunk", file=sys.stderr, flush=True)
    chunks = conn.execute("SELECT id, chunk_text FROM chunks").fetchall()
    conn.execute("DROP TABLE vec_chunks")
    conn.execute(VEC_TABLE_SQL.format(dims=EMBED_DIMS))
    for i, (chunk_id, chunk_text) in enumerate(chunks):
        vec = embed(chunk_text)
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (chunk_id, json.dumps(vec)),
        )
        if (i + 1) % 200 == 0:
            conn.commit()
            print(f"[hermes_rag_common] re-embedded {i + 1}/{len(chunks)} chunks",
                  file=sys.stderr, flush=True)
    conn.commit()
    print(f"[hermes_rag_common] vec_chunks migration done: {len(chunks)} chunks re-embedded at "
          f"{EMBED_DIMS} dims", file=sys.stderr, flush=True)


def connect(readonly=False):
    """Open the vector store with the sqlite-vec extension loaded. Raises if
    sqlite_vec isn't importable — callers must run under a venv that has it
    (/opt/hermes/venvs/rag/bin/python3), same convention as hermes-wyze.py's
    wyze-sdk venv."""
    import sqlite_vec  # deferred import: gives a clear error if run under the wrong interpreter

    if readonly:
        uri = f"file:{DB_PATH}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=30)
    else:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(DB_PATH), timeout=30)
    # busy_timeout is the real fix here (sqlite3.connect's own `timeout` only
    # governs Python's own retry loop before it raises, which WAL mode can
    # still race past) -- found live: the podcast backfill (a long-running
    # writer) crashed with "database is locked" the moment a second process
    # (ad hoc verification queries, run concurrently during this same build
    # session) touched the file at the same time. 30s gives any legitimate
    # concurrent writer (the five ingestion timers, the backfill, an
    # interactive query) room to wait its turn instead of failing outright.
    conn.execute("PRAGMA busy_timeout=30000")
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    if not readonly:
        conn.executescript(SCHEMA)
        _migrate_vec_chunks_dims(conn)
        conn.execute(VEC_TABLE_SQL.format(dims=EMBED_DIMS))
        conn.commit()
    return conn


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def embed(text: str) -> list:
    """Call the resident query-time embedding backend. Raises on any failure
    rather than returning a zero vector — a silently-wrong embedding is worse
    than a loud failure, same principle as every credential-fetch tool in
    this project refusing to degrade to a guessed value."""
    payload = json.dumps({"input": text}).encode("utf-8")
    req = urllib.request.Request(
        EMBED_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=EMBED_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise RuntimeError(f"embedding backend at {EMBED_URL} unreachable: {e}") from e
    vec = body["data"][0]["embedding"]
    if len(vec) != EMBED_DIMS:
        raise RuntimeError(f"embedding backend returned {len(vec)} dims, expected {EMBED_DIMS}")
    return vec


def pack_vec(vec: list) -> bytes:
    import sqlite_vec

    return sqlite_vec.serialize_float32(vec)


def rerank(query: str, candidates: list) -> list:
    """Reorders `candidates` (each a dict with a "text" key, from search()'s own row shape) by a
    real cross-encoder relevance score against `query`. Returns the same dicts, most-relevant
    first, each with a new "rerank_score" key. Raises on failure — callers decide whether to fail
    open, same as embed()'s own contract; search() below fails open, a caller with a harder
    requirement doesn't have to."""
    payload = json.dumps({
        "query": query, "documents": [c["text"] for c in candidates],
    }).encode("utf-8")
    req = urllib.request.Request(
        RERANK_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=RERANK_TIMEOUT) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    scored = []
    for r in body["results"]:
        c = dict(candidates[r["index"]])
        c["rerank_score"] = r["relevance_score"]
        scored.append(c)
    scored.sort(key=lambda c: c["rerank_score"], reverse=True)
    return scored


def search(text: str, corpus: str = None, top_k: int = 5, min_chunk_id: int = None, use_rerank: bool = True):
    """Cosine-similarity search over the vector store — the one retrieval
    implementation both hermes-rag-query.py and hermes-news-digest.py use,
    factored out once the news digest needed the same search restricted to
    only chunks newer than a cursor (`min_chunk_id`) rather than the whole
    index. sqlite-vec's KNN can't pre-filter by an arbitrary SQL condition,
    so a `min_chunk_id`/`corpus` filter works by over-fetching (a wider `k`)
    and trimming in Python — fine at this corpus's real scale, and correct
    regardless: a caller never sees a chunk older than min_chunk_id or from
    the wrong corpus, only possibly fewer than top_k results if not enough
    survive the filter."""
    vec = embed(text)
    conn = connect(readonly=True)
    packed = pack_vec(vec)

    widen = 1
    if corpus:
        widen *= 4
    if min_chunk_id is not None:
        widen *= 8
    if use_rerank:
        widen *= RERANK_WIDEN  # a wider candidate pool for the reranker to actually choose among —
                                # reranking a pool the same size as top_k can only ever reorder,
                                # never surface a real KNN-runner-up the initial pass ranked just
                                # outside top_k

    sql = (
        "SELECT c.id, c.citation, c.corpus, c.source_path, c.chunk_text, v.distance "
        "FROM vec_chunks v JOIN chunks c ON c.id = v.chunk_id "
        "WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance"
    )
    rows = conn.execute(sql, [packed, top_k * widen]).fetchall()

    if corpus:
        rows = [r for r in rows if r[2] == corpus]
    if min_chunk_id is not None:
        rows = [r for r in rows if r[0] > min_chunk_id]

    candidates = [
        {"chunk_id": r[0], "citation": r[1], "corpus": r[2], "source_path": r[3], "text": r[4], "distance": r[5]}
        for r in rows
    ]

    if use_rerank and len(candidates) > 1:
        try:
            candidates = rerank(text, candidates)
        except Exception as exc:
            # Fails open, same shape as hermes-router.py's own Layer 2 degradation: a worse-ranked
            # top_k (plain KNN order) beats a hard failure on every retrieval in the fleet.
            print(f"WARNING: rerank failed, falling back to KNN order: {exc}", file=sys.stderr)

    return candidates[:top_k]


ROUTER_URL = os.environ.get("HERMES_ROUTER_URL", "http://127.0.0.1:8080")


def router_chat(messages, model: str = "super", timeout: int = 120) -> str:
    """A narrative-judgment call to the router (IMPLEMENTATION_PLAN.md §4d,
    Stage 4) — factored out of hermes-rag-source-discovery.py once
    hermes-news-digest.py needed the identical call. Raises on any failure
    or empty content rather than returning a placeholder, same principle as
    embed()."""
    body = json.dumps({"model": model, "messages": messages, "stream": False}).encode()
    req = urllib.request.Request(
        f"{ROUTER_URL}/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read().decode())
    err = result.get("error", {}).get("message")
    if err:
        raise RuntimeError(f"router error: {err}")
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError(f"router returned no content: {result}")
    return content


def sanitize_llm_input(s: str, max_len: int = 4000) -> str:
    """Strip control characters and bound length before third-party content
    reaches an LLM prompt — same discipline hermes-canary-report.py's
    _sanitize_intel_text() established, generalized here since a second RAG
    tool (hermes-news-digest.py) needs the same guard."""
    s = "".join(ch if ch.isprintable() or ch == "\n" else " " for ch in s)
    return s[:max_len]


def get_state(conn, key: str, default=None):
    """Generic key/value bookkeeping in the same vectors.db — Phase 30h
    introduced this table for its own scan cursor; Phase 31's news digest
    reuses it (different key prefix) rather than adding a fifth store."""
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS discovery_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    row = conn.execute("SELECT value FROM discovery_state WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_state(conn, key: str, value):
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS discovery_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO discovery_state (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )
    conn.commit()


def prune_stale(conn, corpus: str, current_source_paths) -> list:
    """Delete chunks/vec_chunks/ingest_state rows for any source_path under
    `corpus` no longer present in current_source_paths — the file (or, for
    the ops corpus, the node) was removed since the last run. Returns the
    list of pruned source_paths so the caller can report it; commits only if
    something was actually pruned."""
    current = set(current_source_paths)
    known = {
        row[0]
        for row in conn.execute("SELECT DISTINCT source_path FROM ingest_state WHERE corpus=?", (corpus,))
    }
    stale = sorted(known - current)
    for sp in stale:
        conn.execute(
            "DELETE FROM vec_chunks WHERE chunk_id IN "
            "(SELECT id FROM chunks WHERE corpus=? AND source_path=?)",
            (corpus, sp),
        )
        conn.execute("DELETE FROM chunks WHERE corpus=? AND source_path=?", (corpus, sp))
        conn.execute("DELETE FROM ingest_state WHERE corpus=? AND source_path=?", (corpus, sp))
    if stale:
        conn.commit()
    return stale


SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def hard_split_text(text: str, max_chars: int):
    """Fallback for a single block of text that alone exceeds max_chars —
    split on sentence boundaries first, then on a hard character boundary as
    a last resort, so no chunk can ever exceed the embedding backend's
    context window regardless of the source's own formatting. Shared between
    hermes-rag-ingest-docs.py (a table row written as one giant line) and
    hermes-rag-ingest-podcasts.py (a single long monologue turn)."""
    sentences = SENTENCE_RE.split(text)
    chunk = ""
    for s in sentences:
        candidate = f"{chunk} {s}".strip() if chunk else s
        if len(candidate) > max_chars and chunk:
            yield chunk
            chunk = s
        else:
            chunk = candidate
    if chunk:
        if len(chunk) > max_chars:
            for i in range(0, len(chunk), max_chars):
                yield chunk[i : i + max_chars]
        else:
            yield chunk


def group_blocks(blocks, max_chars: int, sep: str = "\n\n"):
    """Group a sequence of text blocks (paragraphs, speaker turns, ...) into
    chunks up to max_chars, joined by sep. A single block already over
    max_chars is hard-split on its own rather than silently exceeding the
    cap."""
    chunk = ""
    for b in blocks:
        if not b.strip():
            continue
        if len(b) > max_chars:
            if chunk:
                yield chunk
                chunk = ""
            yield from hard_split_text(b, max_chars)
            continue
        candidate = f"{chunk}{sep}{b}".strip() if chunk else b
        if len(candidate) > max_chars and chunk:
            yield chunk
            chunk = b
        else:
            chunk = candidate
    if chunk:
        yield chunk


HEADER_RE = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)


def split_sections(text: str):
    """Yield (header_path, body) for each markdown header block. header_path
    is the nearest header text (not a full breadcrumb) — enough for a real
    citation without over-engineering a heading-stack tracker this corpus
    doesn't need. Originally hermes-rag-ingest-docs.py's own (Phase 30b);
    moved here 2026-09-04 once hermes-rag-ingest-kb.py needed the identical
    logic for markdown converted from PDF/DOCX (hermes_doc_to_markdown.py) —
    same "a hyphenated tools/ filename can't be imported" reasoning as every
    other function in this file."""
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


def chunk_file(text: str, max_chars: int):
    """Header-aware chunking for markdown text: each section stays one chunk
    unless it exceeds max_chars, in which case group_blocks()'s own
    paragraph/sentence/hard-boundary fallback splits it further (a table row
    or long-form entry written as one giant line with no blank-line breaks —
    real in both the fleet-docs corpus this was built for and PDF/DOCX
    conversions with dense paragraphs)."""
    for header, body in split_sections(text):
        if len(body) <= max_chars:
            yield (header, body)
        else:
            for sub in group_blocks(body.split("\n\n"), max_chars):
                yield (header, sub)


# ---- source-discovery candidates (Phase 30h; shared with the portal since
# Phase 33) -------------------------------------------------------------

DISCOVERY_SCHEMA = """
CREATE TABLE IF NOT EXISTS discovery_candidates (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    mention_text TEXT,
    source_corpus TEXT NOT NULL,
    source_citation TEXT NOT NULL,
    chunk_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    decided_at TEXT,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS discovery_scanned_chunks (
    chunk_id INTEGER PRIMARY KEY
);
"""

VALID_DISCOVERY_DECISIONS = {"archived", "archived-indexed", "declined"}

DISCOVERY_LIST_COLUMNS = [
    "id", "title", "type", "mention_text", "source_corpus", "source_citation",
    "status", "created_at", "decided_at", "notes",
]


def connect_discovery():
    """Open the vector store with the discovery_candidates/discovery_scanned_chunks
    tables also guaranteed present -- the one connect path every discovery
    caller (the CLI's scan/list/decide and the portal) uses, so schema setup
    never drifts between them."""
    conn = connect(readonly=False)
    conn.executescript(DISCOVERY_SCHEMA)
    conn.commit()
    return conn


def list_candidates(conn, status: str = None) -> list:
    """Returns discovery_candidates rows as dicts, optionally filtered by
    status, oldest-id first. Shared by the CLI's `list` subcommand and the
    portal's /api/candidates route."""
    q = f"SELECT {', '.join(DISCOVERY_LIST_COLUMNS)} FROM discovery_candidates"
    params = ()
    if status:
        q += " WHERE status=?"
        params = (status,)
    q += " ORDER BY id"
    return [dict(zip(DISCOVERY_LIST_COLUMNS, row)) for row in conn.execute(q, params).fetchall()]


def decide_candidate(conn, cid: int, decision: str, notes: str = None) -> str:
    """Apply a Boss decision to one discovery candidate. Returns the prior
    status on success. Raises ValueError for an invalid decision or an
    unknown id -- callers (the CLI's `decide` subcommand, the portal's
    /api/decide route) translate that into their own error surface (a
    stderr message + exit code, or a 400 JSON response) rather than this
    shared function assuming either."""
    if decision not in VALID_DISCOVERY_DECISIONS:
        raise ValueError(f"decision must be one of {sorted(VALID_DISCOVERY_DECISIONS)}")
    row = conn.execute("SELECT status FROM discovery_candidates WHERE id=?", (cid,)).fetchone()
    if not row:
        raise ValueError(f"no candidate with id {cid}")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn.execute(
        "UPDATE discovery_candidates SET status=?, decided_at=?, notes=? WHERE id=?",
        (decision, now, notes, cid),
    )
    conn.commit()
    return row[0]
