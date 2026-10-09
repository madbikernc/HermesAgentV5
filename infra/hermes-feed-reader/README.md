# hermes-feed-reader — recreate checklist

**Version:** 1.1.0

S26: pulls the fourteen public AI and security feeds listed in `feeds.yaml` and ingests each new
entry into the existing RAG store, so `hermes-news-digest.py` has something real to search.
`IMPLEMENTATION_PLAN.md` S26 is the design account; this file is the recipe and the operational
notes.

**Status: built, deployed and live on `spark` since 2026-10-08.** Timer enabled, first real run
ingested 185 entries / 263 chunks from all fourteen feeds with zero failures in 41 seconds. It is
a RAG source and nothing else — no digest code lives here, and no LLM call happens anywhere in it.

## 1. What runs

| Unit | Type | What it does |
|---|---|---|
| `hermes-feed-reader.timer` | timer | daily, `06:40` + up to 120s jitter |
| `hermes-feed-reader.service` | oneshot | one pass over every feed in `feeds.yaml` |

`06:40` is deliberate: ahead of `hermes-news-digest-daily.timer`'s `07:10` so the day's entries are
indexed before the digest searches, and clear of the `06:50`/`06:57`/`06:59` RAG ingest cluster,
which competes for the same embedder.

**The unit runs `/opt/hermes/venvs/rag/bin/python3`, not `/usr/bin/python3`** — the same
interpreter every other `hermes-rag-ingest-*.service` uses. See finding 1.

## 2. One-time setup

No Vaultwarden item is needed for the feeds themselves — every source is public and keyless. The
only credential used anywhere is the existing `email-sintra` password, fetched in-script and only
when a feed has failed and a summary email needs sending (the same in-script pattern
`hermes-model-scan.py` uses). There is no wrapper for that reason.

```bash
sudo cp infra/hermes-feed-reader/hermes-feed-reader.service \
        infra/hermes-feed-reader/hermes-feed-reader.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-feed-reader.timer
```

Verify:

```bash
python3 infra/hermes-feed-reader/tests/test_feed_reader.py          # 65 offline checks, no network
/opt/hermes/venvs/rag/bin/python3 tools/hermes-feed-reader.py --list
/opt/hermes/venvs/rag/bin/python3 tools/hermes-feed-reader.py --dry-run
journalctl -u hermes-feed-reader.service -n 30
```

The offline suite needs neither the venv nor the network and runs off-fleet; the other three want
the venv because they touch the store.

## 3. Adding or removing a source

Edit `feeds.yaml` — one `category | name | url` line, `#` for comments. No code change, no restart.
A malformed line is reported and skipped rather than fatal, so one bad edit cannot take the other
thirteen feeds down. `category` must be `ai` or `security`; it becomes the first segment of
`source_path`, so `source_path LIKE 'security/%'` scopes a query to one side.

## 4. How an entry becomes a chunk

```
corpus       "feeds"
source_path  "<category>/<feed-slug>/<16-hex guid hash>"
section      the entry title
citation     "<Publisher> (<category>, confidence=high) — <title> — <date> — <url>"  [+ layer1 tag]
chunk_text   sanitize_llm_input(title + blank line + body), HTML stripped, chunked at 2000 chars
```

`hermes-news-digest.py` needs no change to see these: it already calls
`rag.search(topic, min_chunk_id=cursor)` with no corpus filter, so a feed entry is just a new
chunk to it. Verified live — see finding 4, which is the one thing about this worth understanding
before trusting it.

## 5. Findings from building and running it

1. **"No venv" is true of the fetch half and false for the script.** S26b specifies pure stdlib,
   and the fetch/parse half is exactly that. But the write half calls
   `hermes_rag_common.connect()`, which loads the sqlite-vec extension, and `/usr/bin/python3`
   cannot see `sqlite_vec` — the first live run failed on it. The unit therefore uses the RAG venv.
2. **Do not verify a feed with `curl`.** Both `cisa.gov` feeds return **403 to curl and 200 to
   `urllib`** from the same host and the same egress IP (`98.26.163.185`, checked against this
   workstation's). Akamai is fingerprinting the client, not blocking the address. A `curl` check
   would have wrongly concluded both CISA feeds were dead and dropped the two highest-value
   security sources in the list.
3. **Dedupe is by chunk existence, not a last-seen-guid cursor.** S26b asks for a guid cursor;
   built that way it would silently skip any entry that appears *below* the pointer later, and
   back-filling and revision are normal here (CISA revises advisories, arXiv re-lists). Every entry
   instead gets a deterministic `source_path`, and an entry is new if no chunk with that path
   exists — order-independent, restart-safe, and backed by the schema's own
   `UNIQUE(corpus, source_path, chunk_index)`. Proven by a second real run: 0 new, 0 chunks.
4. **Feed chunks lose a *global* semantic search and win the one the digest actually makes.** On
   `"newly exploited vulnerability added to the KEV catalog"`, an unrestricted search returns
   Security Now show notes (distance 0.711) ahead of the CISA KEV entries (0.772) — long,
   jargon-dense podcast chunks beat short, precisely-on-topic ones, and the podcast archive is
   99.7% of the store's 80k chunks. Under the digest's real query, `min_chunk_id=<cursor>`, the
   old chunks are excluded by id and the feed entries are what come back. So S26 works as designed,
   but the margin comes from the recency restriction, not from relevance — worth knowing before
   anyone reuses this corpus in a query that lacks that restriction.
5. **The global chunk ceiling starved the tail of the list, and the skip was invisible.** The first
   dry run exhausted a 150-chunk budget at feed 11, so SANS and *both* CISA feeds were never read
   — and the skip was recorded only in the failure email, not the journal. Fixed twice over: the
   ceiling is 400 (sized from the real 263-chunk full pass, not guessed), skips are logged by name,
   and the run order **rotates** — a starved feed leads the next run, with the resume point stored
   in `discovery_state`. Without the rotation, a permanently busy feed at the top of the file would
   mean the bottom of the file was never read.
6. **A layer-1 injection hit tags the chunk; it never drops it.** §5.1 orders S22 before S26 and
   S26 was built first, so every entry gets `hermes_injection_guard.scan()` at ingest — a local
   regex pass, no network, no model — and any hit lands in the citation as `[layer1: <categories>]`.
   Dropping would be the wrong failure: half these feeds are security publications whose
   legitimate articles quote attack strings verbatim, and a Krebs piece about a prompt-injection
   campaign is exactly the article worth surfacing. The run summary counts hits.
7. **Pre-existing, not ours: 250 orphaned `vec_chunks` rows.** The store holds 80,266 chunks and
   80,516 vectors. All 263 feed chunks have a vector and none are orphaned, so this predates S26 —
   but it is the same class of bug S9 hit in `hermes-memory` (a vector row surviving its chunk),
   and it belongs with S24's other RAG findings rather than being silently left.
8. **Volume is wildly uneven and the per-feed throttle matters.** OpenAI lists 1258 entries, Hugging
   Face 876, arXiv cs.AI 447; MIT Technology Review and Krebs list 10. `MAX_ENTRIES_PER_FEED`
   (15, newest first) is what keeps a single publisher from consuming the run. CISA advisories are
   the heaviest per entry — 15 entries produced 77 chunks, because the bodies are long.

## 6. Live verification, 2026-10-08

- 65 offline checks pass on `spark` and on an off-fleet Windows box.
- All fourteen feeds answered `200` via `urllib` before any code was written against them.
- First real run: **185 entries, 263 chunks, 0 failures, 0 skipped, 41s**; 97 `ai` / 166 `security`;
  185 distinct entries; every chunk has a vector.
- Second run: **0 new, 0 chunks** — dedupe confirmed against the real store.
- Retrieval confirmed under the digest's own query shape for four separate topics, returning CISA
  for the KEV topic and Hugging Face / DeepMind for the AI topics.
- The oneshot unit ran through systemd itself (`Result=success`, `ExecMainStatus=0`), because a
  script that works by hand and a unit that works are different claims.

## 7. Exit gate — met 2026-10-09

The gate was one line citing one of these feeds that a human confirms was worth surfacing. It is a
CISA advisory published 2026-10-08, fetched the same evening, retrieved by an operator-written topic
and summarized with its real MITRE technique ids (`T1595.002`, `T1189`, `T1059.001`) intact:

> **attacker tactics, techniques and procedures:** Table 2 details reconnaissance like T1595.002
> active scanning. Table 3 details initial access such as T1189 drive-by compromise. Table 4
> details execution like T1059.001 PowerShell. `[CISA — Cybersecurity Advisories … aa26-281a, …]`

Confirmed by the operator, 2026-10-09. Two limits worth keeping next to it: the same run returned
`nothing new` for six of eight topics, so this is proof the chain works and **not** a yield figure;
and the evidence came from a `--dry-run`, which composes the body and stops before SMTP, so the
first real send is the 07:10 timer run. See `IMPLEMENTATION_PLAN.md`'s S26 gate record.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-08 | Initial version — S26 built, deployed and live-verified on `spark`: `feeds.yaml` (14 sources), `tools/hermes-feed-reader.py`, the daily timer, a 65-check offline suite, and the eight findings above. |
| 1.1.0 | 2026-10-09 | Added §7, the exit-gate record: met on a confirmed digest line citing a real 2026-10-08 CISA advisory, with its two limits stated alongside (six of eight topics returned `nothing new`, and the evidence came from a dry run that stops before SMTP). |
