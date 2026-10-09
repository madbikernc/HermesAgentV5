#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-feed-reader — S26. Pulls the public AI/security RSS and Atom feeds listed in
# infra/hermes-feed-reader/feeds.yaml and ingests each new entry into the existing RAG store, so
# hermes-news-digest.py has something real to search. IMPLEMENTATION_PLAN.md S26 is the design;
# this header records only what a reader of the code needs that the plan does not say.
#
# It is a RAG SOURCE AND NOTHING ELSE. No digest code lives here and none is needed:
# hermes-news-digest.py already searches "content added since the last run" per topic with no
# corpus filter (its own rag.search(topic, min_chunk_id=cursor) call), so a feed entry is simply a
# new chunk to it. There is no LLM call anywhere in this file.
#
# The fetch and parse half is pure stdlib on purpose — urllib plus xml.etree, no feedparser —
# the same shape hermes_botnet_intel.py already proves for its own keyless public sources.
# S26b's "no venv" claim holds for that half only, and NOT for the script as a whole: the
# write half goes through hermes_rag_common.connect(), which loads the sqlite-vec extension,
# and /usr/bin/python3 cannot see sqlite_vec. The first live run proved it. The unit therefore
# runs /opt/hermes/venvs/rag/bin/python3, the same interpreter every other
# hermes-rag-ingest-*.service and hermes-news-digest-daily.service already use.
#
# ── Four decisions that are not in the plan, because building it is what raised them ──
#
# 1. DEDUPE IS BY CHUNK EXISTENCE, NOT BY A LAST-SEEN-GUID CURSOR.
#    S26b asks for a per-feed "last seen entry guid" cursor. Built that way it would have a silent
#    failure the plan's own wording is trying to avoid: a pointer to the newest guid skips any
#    entry that appears *below* it later, and back-filling and reordering are both normal for these
#    feeds (CISA revises advisories; arXiv re-lists). Instead every entry gets a deterministic
#    source_path of "<category>/<feed-slug>/<guid-hash>", and an entry is new if no chunk with that
#    source_path exists. That is order-independent, survives a restart, and cannot skip a
#    back-filled entry. The UNIQUE(corpus, source_path, chunk_index) constraint already in the
#    schema is the structural backstop. Per-feed run bookkeeping still goes to discovery_state via
#    rag.get_state/set_state, for observability rather than for correctness.
#
# 2. A LAYER-1 INJECTION SCAN RUNS AT INGEST, AND TAGS RATHER THAN DROPS.
#    §5.1 orders S22 (fixing the Layer-2 screener, which the Clef bake-off measured missing 14 of
#    18 injections) before S26. S26 was built first, on direct instruction, so this is the
#    mitigation that is actually available: every entry is scanned with
#    hermes_injection_guard.scan() — a pure local regex pass, no network, no model — and any hit is
#    recorded in the chunk's own citation as "[layer1: <categories>]".
#    It deliberately does NOT drop the entry. Half of these feeds are security publications whose
#    legitimate articles quote attack strings verbatim; Krebs writing about a prompt-injection
#    campaign would be exactly the article worth surfacing, and dropping it would be the wrong
#    failure. Tagging makes the content legible to whatever reads it later without pretending this
#    file can adjudicate it. The run summary counts the hits.
#
# 3. CONFIDENCE AND SOURCE TAGS LIVE IN corpus/source_path/citation, BECAUSE THE SCHEMA HAS NO
#    TAG COLUMNS. S26b says to tag entries `source=feed-reader`, the feed's category, and
#    `confidence=high`. The chunks table has no such columns — it has corpus, source_path, section,
#    chunk_text, citation, content_hash, ingested_at. So: corpus is "feeds" (addressable as a
#    class, and rag-query can scope to it), the category is the first segment of source_path
#    (`source_path LIKE 'security/%'`, the same scoping hermes-rag-ingest-podcasts.py uses for a
#    show), and the citation carries the publisher name plus "confidence=high" so it is visible in
#    a digest email and greppable in the store. Nothing was added to the schema for this.
#
# 4. THE FEED FETCH MUST NOT BE curl. Verified on spark 2026-10-08: both cisa.gov feeds return
#    403 to curl and 200 to urllib from the same host and the same egress IP (98.26.163.185), so
#    Akamai is fingerprinting the client rather than blocking the address. urllib is what this
#    script uses, which is why all fourteen feeds work here. Worth knowing before anyone
#    "verifies" a feed with curl and concludes it is dead.
#
# ── Failure posture ──
#   A feed that fails is isolated: it is logged, collected, and reported in one summary email at
#   the end of the run, and the other thirteen are unaffected. Nothing here raises on a bad feed, a
#   malformed entry, a missing date or an unparseable XML body, because the expected steady state
#   for third-party RSS is that something is broken somewhere. The embedder is the one hard
#   dependency: without it nothing can be ingested, and that is reported as such.
#
# Throttling is on from the first run rather than added after a flood (S26 risk 2): arXiv cs.AI
# alone lists hundreds of entries, and hermes-rag-source-discovery.py already paid for learning
# this the other way round.
#
# Config (environment):
#   HERMES_RAG_DB / HERMES_RAG_EMBED_URL   as hermes_rag_common.py defines them
#   FEEDS_PATH             default infra/hermes-feed-reader/feeds.yaml
#   MAX_ENTRIES_PER_FEED   default 15 — newest first, per feed, per run
#   MAX_CHUNKS_PER_RUN     default 150 — global stop, counted across feeds
#   FEED_TIMEOUT           default 30 seconds per feed
#   NO_EMAIL               set to 1 to suppress the failure email
#
# Usage:
#   hermes-feed-reader.py                  # one pass over every feed
#   hermes-feed-reader.py --dry-run        # fetch and parse, write nothing, embed nothing
#   hermes-feed-reader.py --only krebs     # one feed, matched on slug substring
#   hermes-feed-reader.py --list           # show the parsed feed list and exit
import argparse
import datetime
import hashlib
import html
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO_DIR = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import hermes_rag_common as rag  # noqa: E402
import hermes_injection_guard as guard  # noqa: E402

CORPUS = "feeds"
CONFIDENCE = "high"

FEEDS_PATH = Path(os.environ.get(
    "FEEDS_PATH", str(REPO_DIR / "infra" / "hermes-feed-reader" / "feeds.yaml")))
MAX_ENTRIES_PER_FEED = int(os.environ.get("MAX_ENTRIES_PER_FEED", "15"))
# Sized from the real first pass rather than guessed: 11 feeds produced 150 chunks, so a full
# 14-feed backfill lands near 300. A ceiling below that silently starves the tail of the list
# (the first dry run never reached either CISA feed), which is why this is 400 AND why the
# run order rotates below.
MAX_CHUNKS_PER_RUN = int(os.environ.get("MAX_CHUNKS_PER_RUN", "400"))
FEED_TIMEOUT = int(os.environ.get("FEED_TIMEOUT", "30"))
MAX_CHUNK_CHARS = 2000

# Identifies this fleet honestly rather than impersonating a browser. Every feed in the list
# answers it (verified on spark, 2026-10-08) — see header decision 4 for the one real gotcha,
# which is about curl, not about the user agent.
USER_AGENT = ("Mozilla/5.0 (compatible; HermesFeedReader/1.0; "
              "+https://github.com/madbikernc/HermesAgentV5)")
ACCEPT = "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8"

SMTP_HOST = "mail.hover.com"
SMTP_PORT = 587
SMTP_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"
VAULT_GET = str(TOOLS / "vault-get-secret.sh")

ATOM = "{http://www.w3.org/2005/Atom}"
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t]+")
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def log(msg):
    print(f"[hermes-feed-reader] {msg}", flush=True)


def slugify(name):
    return _SLUG_RE.sub("-", name.lower()).strip("-")[:48]


# ── the source list ───────────────────────────────────────────────────────

def load_feeds(path=None):
    """`category | name | url` per line, # comments and blanks ignored. No YAML is parsed — see
    feeds.yaml's own header for why the extension is kept anyway. A malformed line is reported and
    skipped rather than fatal: one bad edit must not take the other thirteen feeds down."""
    path = Path(path or FEEDS_PATH)
    feeds, bad = [], []
    if not path.is_file():
        return feeds, [f"{path} does not exist"]
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 3 or not all(parts):
            bad.append(f"line {lineno}: expected 'category | name | url', got {raw!r}")
            continue
        category, name, url = parts
        if category not in ("ai", "security"):
            bad.append(f"line {lineno}: category must be 'ai' or 'security', got {category!r}")
            continue
        if not url.startswith(("http://", "https://")):
            bad.append(f"line {lineno}: url must be http(s), got {url!r}")
            continue
        feeds.append({"category": category, "name": name, "url": url, "slug": slugify(name)})
    return feeds, bad


# ── fetch and parse ───────────────────────────────────────────────────────

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": ACCEPT})
    with urllib.request.urlopen(req, timeout=FEED_TIMEOUT) as resp:
        return resp.read()


def _text(el):
    return "".join(el.itertext()) if el is not None else ""


def strip_html(s):
    """Feed bodies carry HTML, and some carry it escaped inside CDATA. Unescape first so tags that
    arrive as &lt;p&gt; are stripped too, then collapse whitespace while keeping paragraph breaks,
    which is what the chunker splits on."""
    if not s:
        return ""
    s = html.unescape(s)
    s = re.sub(r"(?i)<br\s*/?>|</p>", "\n\n", s)
    s = _TAG_RE.sub(" ", s)
    s = html.unescape(s)
    s = _WS_RE.sub(" ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return "\n".join(ln.strip() for ln in s.splitlines()).strip()


def parse_date(raw):
    """RSS uses RFC-822, Atom uses ISO-8601, and real feeds carry both plus junk. Returns an
    ISO-8601 string or None — a missing date is never fatal, it just sorts last."""
    if not raw:
        return None
    raw = raw.strip()
    try:
        return parsedate_to_datetime(raw).astimezone(datetime.timezone.utc).isoformat()
    except (TypeError, ValueError, IndexError):
        pass
    try:
        dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt.astimezone(datetime.timezone.utc).isoformat()
    except ValueError:
        return None


def parse_feed(body):
    """Returns a list of {guid, title, link, published, summary} for RSS or Atom. Raises
    ET.ParseError on a body that is not XML at all; every other malformation degrades to a missing
    field, because a feed with one broken entry should still yield the other nine."""
    root = ET.fromstring(body)
    entries = []
    items = root.findall(".//item")
    if items:
        for item in items:
            guid = _text(item.find("guid")) or _text(item.find("link"))
            summary = (_text(item.find("description"))
                       or _text(item.find("{http://purl.org/rss/1.0/modules/content/}encoded")))
            entries.append({
                "guid": guid.strip(),
                "title": strip_html(_text(item.find("title"))),
                "link": _text(item.find("link")).strip(),
                "published": parse_date(_text(item.find("pubDate"))
                                        or _text(item.find("{http://purl.org/dc/elements/1.1/}date"))),
                "summary": strip_html(summary),
            })
        return entries
    for entry in root.findall(f".//{ATOM}entry"):
        link = ""
        for cand in entry.findall(f"{ATOM}link"):
            rel = cand.get("rel") or "alternate"
            if rel == "alternate":
                link = cand.get("href") or ""
                break
        summary = _text(entry.find(f"{ATOM}content")) or _text(entry.find(f"{ATOM}summary"))
        entries.append({
            "guid": (_text(entry.find(f"{ATOM}id")) or link).strip(),
            "title": strip_html(_text(entry.find(f"{ATOM}title"))),
            "link": link.strip(),
            "published": parse_date(_text(entry.find(f"{ATOM}updated"))
                                    or _text(entry.find(f"{ATOM}published"))),
            "summary": strip_html(summary),
        })
    return entries


def entry_key(entry):
    """Stable, filesystem-and-SQL-safe identity for an entry. The guid is the feed's own identity
    when it has one, the link otherwise, and the title as a last resort — hashed so a 300-character
    arXiv guid cannot blow out source_path."""
    basis = entry.get("guid") or entry.get("link") or entry.get("title") or ""
    return hashlib.sha256(basis.encode("utf-8", "replace")).hexdigest()[:16]


# ── ingest ────────────────────────────────────────────────────────────────

def already_ingested(conn, source_path):
    row = conn.execute(
        "SELECT 1 FROM chunks WHERE corpus=? AND source_path=? LIMIT 1", (CORPUS, source_path)
    ).fetchone()
    return row is not None


def build_citation(feed, entry, guard_hits):
    bits = [f"{feed['name']} ({feed['category']}, confidence={CONFIDENCE})"]
    if entry.get("title"):
        bits.append(entry["title"][:200])
    if entry.get("published"):
        bits.append(entry["published"][:10])
    if entry.get("link"):
        bits.append(entry["link"])
    if guard_hits:
        bits.append(f"[layer1: {','.join(sorted(guard_hits))}]")
    return " — ".join(bits)


def ingest_entry(conn, feed, entry, dry_run):
    """Returns (chunks_written, guard_categories). Entry text is sanitized before anything else
    touches it, then scanned; see header decision 2 for why a hit tags rather than drops."""
    source_path = f"{feed['category']}/{feed['slug']}/{entry_key(entry)}"
    if already_ingested(conn, source_path):
        return 0, set()

    raw_text = "\n\n".join(p for p in (entry.get("title"), entry.get("summary")) if p)
    text = rag.sanitize_llm_input(raw_text, max_len=20000)
    if not text.strip():
        return 0, set()

    hits = guard.scan(text)
    categories = set(hits)
    citation = build_citation(feed, entry, categories)
    section = (entry.get("title") or feed["name"])[:200]

    # group_blocks() is a generator; materialized because the count is needed twice (the dry-run
    # return and the write loop) and consuming it once would silently yield nothing the second time.
    blocks = list(rag.group_blocks(text.split("\n\n"), MAX_CHUNK_CHARS, sep="\n\n"))
    if dry_run:
        return len(blocks), categories

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for idx, block in enumerate(blocks):
        vec = rag.embed(block)
        cur = conn.execute(
            "INSERT INTO chunks (corpus, source_path, section, chunk_index, chunk_text, "
            "citation, content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
            (CORPUS, source_path, section, idx, block, citation, rag.content_hash(block), now),
        )
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (cur.lastrowid, rag.pack_vec(vec)),
        )
    conn.execute(
        "INSERT INTO ingest_state (corpus, source_path, file_hash, last_ingested) "
        "VALUES (?,?,?,?) ON CONFLICT(corpus, source_path) DO UPDATE SET "
        "file_hash=excluded.file_hash, last_ingested=excluded.last_ingested",
        (CORPUS, source_path, rag.content_hash(text), now),
    )
    conn.commit()
    return len(blocks), categories


def process_feed(conn, feed, budget, dry_run):
    """One feed. Never raises: returns (chunks, entries_seen, new_entries, guard_cats, error)."""
    try:
        body = fetch(feed["url"])
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        return 0, 0, 0, set(), f"fetch failed: {type(exc).__name__}: {exc}"
    try:
        entries = parse_feed(body)
    except ET.ParseError as exc:
        return 0, 0, 0, set(), f"not parseable as RSS or Atom: {exc}"
    if not entries:
        return 0, 0, 0, set(), "no entries found (feed shape changed?)"

    # Newest first so a throttled run takes the most recent, not whatever the feed lists first.
    entries.sort(key=lambda e: e.get("published") or "", reverse=True)
    considered = entries[:MAX_ENTRIES_PER_FEED]

    chunks = new_entries = 0
    all_cats = set()
    for entry in considered:
        if chunks >= budget:
            break
        try:
            written, cats = ingest_entry(conn, feed, entry, dry_run)
        except RuntimeError as exc:          # rag.embed() raises this when the embedder is down
            return chunks, len(entries), new_entries, all_cats, f"embedder unavailable: {exc}"
        except Exception as exc:            # one malformed entry must not lose the rest of the feed
            log(f"  {feed['slug']}: entry skipped ({type(exc).__name__}: {exc})")
            continue
        if written:
            new_entries += 1
            chunks += written
            all_cats |= cats
    return chunks, len(entries), new_entries, all_cats, None


# ── failure reporting ─────────────────────────────────────────────────────

def vault_get(item, field):
    try:
        r = subprocess.run([VAULT_GET, item, field], capture_output=True, text=True, timeout=60)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (subprocess.TimeoutExpired, OSError):
        return ""


def send_failure_email(failures, summary_lines):
    if os.environ.get("NO_EMAIL") == "1":
        log("NO_EMAIL=1 — not sending the failure summary")
        return
    import smtplib
    password = vault_get("email-sintra", "password")
    if not password:
        log("could not fetch the email password from vault — failure summary not sent")
        return
    body = ["Feeds that failed on this run:", ""]
    body += [f"  - {name}: {err}" for name, err in failures]
    body += ["", "Run summary:", ""] + [f"  {ln}" for ln in summary_lines]
    body += ["", "A failing feed leaves previously-ingested entries in place; it does not",
             "affect the other feeds. See infra/hermes-feed-reader/README.md."]
    msg = MIMEText("\n".join(body))
    msg["Subject"] = f"hermes-feed-reader: {len(failures)} feed(s) failed"
    msg["From"] = SMTP_FROM
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.starttls()
            s.login(SMTP_FROM, password)
            s.send_message(msg)
        log(f"failure summary emailed ({len(failures)} feed(s))")
    except Exception as exc:
        log(f"failure email failed: {exc}")


def main():
    ap = argparse.ArgumentParser(description="S26 — public AI/security feeds into the RAG store")
    ap.add_argument("--dry-run", action="store_true", help="fetch and parse only; no writes, no embeds")
    ap.add_argument("--only", help="limit to feeds whose slug contains this substring")
    ap.add_argument("--list", action="store_true", help="print the parsed feed list and exit")
    args = ap.parse_args()

    feeds, bad = load_feeds()
    for problem in bad:
        log(f"feeds.yaml: {problem}")
    if not feeds:
        log(f"no usable feeds in {FEEDS_PATH} — nothing to do")
        return 0

    if args.only:
        feeds = [f for f in feeds if args.only.lower() in f["slug"]]
        if not feeds:
            log(f"--only {args.only!r} matched no feed")
            return 1

    if args.list:
        for f in feeds:
            print(f"  {f['category']:<9} {f['slug']:<32} {f['url']}")
        return 0

    conn = rag.connect(readonly=False)
    budget = MAX_CHUNKS_PER_RUN
    failures, summary, skipped, guard_total = [], [], [], {}
    total_chunks = total_new = 0

    # Rotate where the pass starts, so a run that hits the global ceiling does not starve the same
    # feeds every day. Without this, the tail of feeds.yaml is read only when every feed above it
    # happens to be quiet — on the first pass that meant both CISA feeds were never reached at all.
    offset = 0
    if len(feeds) > 1:
        try:
            offset = int(rag.get_state(conn, "feedreader:rotation_offset", 0) or 0) % len(feeds)
        except (TypeError, ValueError):
            offset = 0
    ordered = feeds[offset:] + feeds[:offset]
    if offset:
        log(f"starting at {ordered[0]['slug']} (rotation offset {offset}) so the ceiling cannot "
            f"starve the same feeds every run")

    for feed in ordered:
        if budget <= 0:
            summary.append(f"{feed['slug']}: skipped — global chunk budget exhausted")
            log(f"{feed['slug']}: SKIPPED — global chunk budget exhausted "
                f"(MAX_CHUNKS_PER_RUN={MAX_CHUNKS_PER_RUN}); it leads the next run")
            skipped.append(feed["slug"])
            continue
        chunks, seen, new, cats, error = process_feed(conn, feed, budget, args.dry_run)
        budget -= chunks
        total_chunks += chunks
        total_new += new
        for c in cats:
            guard_total[c] = guard_total.get(c, 0) + 1
        if error:
            failures.append((feed["name"], error))
            summary.append(f"{feed['slug']}: FAILED — {error}")
            log(f"{feed['slug']}: FAILED — {error}")
            continue
        throttled = " (throttled)" if seen > MAX_ENTRIES_PER_FEED else ""
        summary.append(f"{feed['slug']}: {new} new of {seen} listed{throttled}, {chunks} chunk(s)")
        log(f"{feed['slug']}: {new} new of {seen} listed{throttled}, {chunks} chunk(s)"
            + (f", layer1 hits: {','.join(sorted(cats))}" if cats else ""))
        if not args.dry_run:
            rag.set_state(conn, f"feedreader:{feed['slug']}:last_run",
                          datetime.datetime.now(datetime.timezone.utc).isoformat())
            rag.set_state(conn, f"feedreader:{feed['slug']}:last_new_count", new)

    if not args.dry_run and len(feeds) > 1:
        # Next run starts at the first feed this one could not reach; if everything was read, step
        # one along so the starting point still moves and no feed is permanently first in line.
        next_slug = skipped[0] if skipped else None
        if next_slug:
            next_offset = next(i for i, f in enumerate(feeds) if f["slug"] == next_slug)
        else:
            next_offset = (offset + 1) % len(feeds)
        rag.set_state(conn, "feedreader:rotation_offset", next_offset)

    log(f"{'[dry-run] ' if args.dry_run else ''}{total_new} new entr{'y' if total_new == 1 else 'ies'}, "
        f"{total_chunks} chunk(s) across {len(feeds)} feed(s); "
        f"{len(failures)} failure(s), {len(skipped)} skipped for budget; "
        f"budget left {max(budget, 0)}")
    if guard_total:
        log("layer-1 scan hits (tagged in the citation, not dropped — see header decision 2): "
            + ", ".join(f"{k}={v}" for k, v in sorted(guard_total.items())))
    if failures and not args.dry_run:
        send_failure_email(failures, summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
