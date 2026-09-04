#!/usr/bin/env python3
# Version: 1.2.3
#
# 1.2.3 (2026-09-03) — fixes a real, previously-hidden gap the 1.2.2 fix
# below uncovered: with the TBRH noise gone, a second batch of "no turns
# parsed" warnings turned out to be a genuine parser bug, not a false alarm.
# Episodes im-805 through im-831 (27 of the archive's 81 IntelligentMachines
# transcripts, one third of the whole show) have sat permanently unindexed
# since the corpus was first ingested -- confirmed live: episodes 805-831 are
# the show's first ~7 months right after its rebrand from "This Week in
# Google", and TWiT's site used an older transcript template for them
# ("H:MM:SS - Speaker" turn markers) before switching to the current
# "Speaker [HH:MM:SS]:" style at episode 832, where IM_TURN_RE has matched
# ever since. parse_intelligent_machines() only ever tried the new pattern.
# Added IM_TURN_RE_OLD as a fallback tried when the new pattern finds zero
# matches; factored the shared turn-extraction loop into
# _im_turns_from_matches(), which both patterns now feed identically since
# both capture the speaker name as group 1. First fallback attempt only
# covered 26 of the 27 -- im-818 turned out to be a third sub-variant within
# the same old-template era (bare "MM:SS" instead of "H:MM:SS", plus a role
# tag on every speaker like "Leo Laporte (Host)"), found live by dry-running
# against the real archive before trusting the fix. IM_TURN_RE_OLD's final
# form covers all three shapes in one pattern: 1-2 timestamp components, and
# an optional "(Role)" suffix that can never leak into the captured name
# since the name charset excludes parens. Also made IM_TITLE_RE
# case-insensitive: im-818's header capitalizes "818 Transcript" where every
# other sampled episode doesn't, which had been silently dropping this one
# file's episode number and date (citation fell back to "Intelligent
# Machines #?") even after its dialogue started parsing. A one-off manual
# run after deploying both fixes re-ingested all 27 previously-silent
# episodes with correct citations.
#
# 1.2.2 (2026-09-03) — fixes a standing false-alarm bug found while checking
# daily ingest logs: ~295 TBRH story-links files (bonus/call-in/portfolio-
# profile episodes going back to 2020) were logging "no turns parsed --
# skipping (format may have changed)" on *every single run, forever*,
# because parse_tbrh() correctly returning zero lines for a genuinely empty
# "links": [] (confirmed live against the real archive -- sampled files are
# well-formed JSON, not malformed) was never written to ingest_state, so it
# could never be cached and kept getting re-parsed and re-warned daily. Now
# tbrh's empty-links case is recognized as expected (episode cited no news
# stories) and cached like a normal ingest, logged at INFO level with an
# accurate reason instead of a misleading WARNING; sn/im's empty-parse case
# is left exactly as before (uncached, still a WARNING) since dialogue-based
# shows genuinely finding zero turns does mean the format broke.
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.2.0 — adds Tech Brew Ride Home ("tbrh"): direct request, 2026-08-15,
# following hermes-podcast-retriever.py 1.2.0 / hermes-podcast-sync.py 1.2.0
# adding this show. No transcript exists for it (confirmed live the same
# day) — the archive holds a small per-episode JSON citation list (headline
# + source publication + URL for each story that episode covered) instead of
# turn-by-turn dialogue. parse_tbrh() formats each citation as one short
# line ("Headline (Source): URL"); chunking/embedding/citation-storage below
# is otherwise identical to the SN/IM path. Show-key dispatch in
# ingest_file() changed from a two-way ternary to a PARSERS dict to fit a
# third show in without it turning into nested ternaries.
#
# 1.1.0 — Phase 30g: prunes stale entries (an episode file removed from the
# archive since the last run) via hermes_rag_common.prune_stale(), skipped
# on --dry-run. Unaffected by --limit — discover_files() always returns the
# full real file list regardless of how many get ingested this run.
"""
hermes-rag-ingest-podcasts.py — Phase 30c (IMPLEMENTATION_PLAN.md §7, Phase
30): second of four narrow, per-corpus ingestion tools. Reads the real
transcript archive Phase 24's hermes-podcast-sync.timer already maintains at
/mnt/nas2-hermes-backup/PodCasts — no new scrape, no new acquisition risk.

Scope, decided live against the real archive rather than the plan's original
"two shows" assumption: covers SecurityNow/transcripts_txt/*.txt (1075 real
files), IntelligentMachines/transcripts/*.txt (78 real files), and (1.2.0)
TechBrewRideHome/story_links/*.json — the complete, clean-text transcript
set plus TBRH's citation-list equivalent (no transcript exists for that
show). Two things found in the same archive and deliberately left out of
this pass, flagged rather than silently ingested or silently dropped:
SecurityNow/show_notes/ (645 PDF-only files, a different corpus — per-
episode notes, not transcripts) and a third, undocumented `TheVoid/` folder
(1 HTML file). Neither blocks ingesting the real transcript set.

Bulk embedding is compute-heavy at this corpus's real scale (~1150 episodes,
tens of thousands of chunks) — routed through the broker's `embed` job type
to hermes-embed-worker.py on HomeD13's own GPU, one broker job per episode
(a batch of that episode's chunks, not one job per chunk — cuts job count by
~30-40x against per-chunk granularity), keeping that compute off the Spark's
shared 273GB/s bus during live conversation, per this phase's own bandwidth
rationale (already applied locally-embedded for the much smaller fleet-docs
corpus in 30b, where the same concern doesn't apply at that scale).

Parsing: two distinct per-show formats, found by reading real files rather
than assumed —
  SecurityNow: a fixed header block (SERIES/EPISODE/DATE/TITLE/HOSTS/...)
    followed by "SPEAKER:  text" paragraphs, blank-line separated.
  IntelligentMachines: a page-chrome preamble (stripped), then
    "Speaker Name [HH:MM:SS]:" turn markers on their own line.
Both are chunked into ~1800-char groups via hermes_rag_common.group_blocks(),
each chunk citation carrying the real show/episode/title/date back to the
source per constraint 6 — never a bare excerpt.

Content-hash dedup at the whole-file level (ingest_state table), same
coarse-grained approach 30b uses — an unchanged episode is skipped entirely.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-ingest-podcasts.py [--archive PATH] [--limit N] [--dry-run]
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

CORPUS = "podcasts"
MAX_CHUNK_CHARS = 1800
ARCHIVE_ROOT = "/mnt/nas2-hermes-backup/PodCasts"

BROKER_URL = os.environ.get("BROKER_URL", "http://10.129.1.15:8100").rstrip("/")
REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"
JOB_POLL_SECONDS = 3
JOB_WAIT_TIMEOUT = 360  # a bit above the embed worker's own JOB_TIMEOUT (300s)

SN_HEADER_STOPLIST = {
    "GIBSON RESEARCH CORPORATION", "SERIES", "EPISODE", "DATE", "TITLE",
    "HOSTS", "SOURCE", "ARCHIVE",
}
SN_TURN_RE = re.compile(r"^([A-Z][A-Z0-9 .&/'-]{0,24}):\s+(.*)$", re.DOTALL)

# IGNORECASE: im-818's header capitalizes it ("818 Transcript") where every
# other sampled episode doesn't ("805 transcript") -- found live while
# verifying the IM_TURN_RE_OLD fix below, which fixed im-818's dialogue but
# left this title match (and therefore its episode number and date) silently
# empty until this flag was added.
IM_TITLE_RE = re.compile(r"Intelligent Machines (\d+) transcript", re.IGNORECASE)
IM_TURN_RE = re.compile(r"^([A-Za-z][A-Za-z .'-]{1,40}) \[(\d{2}:\d{2}:\d{2})\]:$", re.MULTILINE)
# Episodes 805-831 -- the show's first ~7 months right after its rebrand from
# "This Week in Google" -- used TWiT's older transcript template instead:
# "TIME - Speaker" turn markers (timestamp first, dialogue starting on the
# next line same as the new format). Confirmed live against the real
# archive: im-832 onward is exclusively IM_TURN_RE, 805-831 exclusively this
# one -- a clean cutover, not a mix. Within 805-831 the timestamp itself
# varies (most are "H:MM:SS", e.g. "0:02:06"; im-818 alone uses bare
# "MM:SS", e.g. "00:00", and appends a role tag to every speaker, e.g.
# "Leo Laporte (Host)") -- one pattern covers all of it: 1-2 timestamp
# components after the leading digits, and an optional "(Role)" suffix
# stripped from the captured name (the speaker charset excludes parens, so
# it can never be captured by accident).
IM_TURN_RE_OLD = re.compile(
    r"^\d{1,2}(?::\d{2}){1,2} - ([A-Za-z][A-Za-z .'-]{1,40}?)(?:\s*\([A-Za-z]+\))?$",
    re.MULTILINE,
)


def broker_token():
    out = subprocess.run(
        [VAULT_SCRIPT, "broker-token", "password"], capture_output=True, text=True, timeout=60
    )
    token = out.stdout.strip()
    if out.returncode != 0 or not token:
        raise RuntimeError(f"could not fetch broker-token: {out.stderr.strip()}")
    return token


def broker_request(token, method, path, data=None, headers=None):
    req = urllib.request.Request(
        f"{BROKER_URL}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {token}", **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


# ---- SecurityNow parsing ---------------------------------------------------

def parse_security_now(text: str):
    episode = re.search(r"^EPISODE:\s*#?(\d+)", text, re.MULTILINE)
    date = re.search(r"^DATE:\s*(.+)$", text, re.MULTILINE)
    title = re.search(r"^TITLE:\s*(.+)$", text, re.MULTILINE)

    meta = {
        "show": "Security Now!",
        "episode": episode.group(1) if episode else "?",
        "date": date.group(1).strip() if date else "",
        "title": title.group(1).strip() if title else "",
    }

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    turns = []
    for p in paragraphs:
        m = SN_TURN_RE.match(p)
        if not m:
            continue
        label, body = m.group(1).strip(), m.group(2).strip()
        if label in SN_HEADER_STOPLIST or not body:
            continue
        turns.append(f"{label}: {' '.join(body.split())}")
    return meta, turns


# ---- IntelligentMachines parsing ------------------------------------------

def parse_intelligent_machines(text: str):
    num = IM_TITLE_RE.search(text)
    episode = num.group(1) if num else "?"

    date = ""
    if num:
        rest = text[num.end():].splitlines()
        for line in rest[:5]:
            line = line.strip()
            if line and not line.lower().startswith("please be advised"):
                date = line
                break

    meta = {"show": "Intelligent Machines", "episode": episode, "date": date, "title": ""}

    matches = list(IM_TURN_RE.finditer(text)) or list(IM_TURN_RE_OLD.finditer(text))
    return meta, _im_turns_from_matches(text, matches)


def _im_turns_from_matches(text: str, matches) -> list[str]:
    # Both IM_TURN_RE and IM_TURN_RE_OLD capture the speaker name as group 1.
    turns = []
    for i, m in enumerate(matches):
        speaker = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = " ".join(text[start:end].split())
        if body:
            turns.append(f"{speaker}: {body}")
    return turns


# ---- Tech Brew Ride Home parsing -------------------------------------------

def parse_tbrh(text: str):
    """TBRH has no transcript -- the archive file is the story-links JSON
    hermes-podcast-retriever.py's fetch_tbrh_remote_listing() already
    extracted from the show's own official RSS feed. Each citation (headline
    + source publication + URL, already just that -- not surrounding show-
    notes prose) becomes one short line; there's no dialogue to chunk by
    speaker turn the way SN/IM's parsers do."""
    data = json.loads(text)
    meta = {
        "show": "Tech Brew Ride Home",
        "episode": str(data.get("episode", "?")),
        "date": data.get("date") or data.get("pubdate", ""),
        "title": data.get("title", ""),
    }
    lines = []
    for link in data.get("links", []):
        headline = (link.get("headline") or "").strip()
        url = (link.get("url") or "").strip()
        if not headline or not url:
            continue
        source = link.get("source")
        tag = f" ({source})" if source else ""
        lines.append(f"{headline}{tag}: {url}")
    return meta, lines


PARSERS = {"sn": parse_security_now, "im": parse_intelligent_machines, "tbrh": parse_tbrh}


def citation_base(meta: dict) -> str:
    parts = [meta["show"], f"#{meta['episode']}"]
    if meta.get("title"):
        parts.append(f"— {meta['title']}")
    if meta.get("date"):
        parts.append(f"({meta['date']})")
    return " ".join(parts)


# ---- ingestion --------------------------------------------------------

def discover_files(archive: Path):
    files = []
    sn_dir = archive / "SecurityNow" / "transcripts_txt"
    if sn_dir.is_dir():
        files += [("sn", p) for p in sorted(sn_dir.glob("*.txt"))]
    im_dir = archive / "IntelligentMachines" / "transcripts"
    if im_dir.is_dir():
        files += [("im", p) for p in sorted(im_dir.glob("*.txt"))]
    tbrh_dir = archive / "TechBrewRideHome" / "story_links"
    if tbrh_dir.is_dir():
        files += [("tbrh", p) for p in sorted(tbrh_dir.glob("*.json"))]
    return files


def submit_embed_job(token, source_id, chunks):
    job_id = rag.content_hash(source_id + "|".join(c["citation"] for c in chunks))[:32]
    payload = {"type": "embed", "id": job_id, "payload": {"source": source_id, "chunks": chunks}}
    resp = broker_request(token, "POST", "/jobs", data=json.dumps(payload).encode("utf-8"),
                           headers={"Content-Type": "application/json"})
    return resp["id"]


def wait_for_job(token, job_id):
    deadline = time.monotonic() + JOB_WAIT_TIMEOUT
    while time.monotonic() < deadline:
        row = broker_request(token, "GET", f"/jobs/{job_id}")
        if row.get("state") in ("done", "dead"):
            return row
        time.sleep(JOB_POLL_SECONDS)
    raise RuntimeError(f"job {job_id} did not finish within {JOB_WAIT_TIMEOUT}s")


def ingest_file(conn, token, show_key, path: Path, archive: Path, dry_run: bool) -> int:
    rel = str(path.relative_to(archive))
    text = path.read_text(encoding="utf-8", errors="replace")
    file_hash = rag.content_hash(text)

    row = conn.execute(
        "SELECT file_hash FROM ingest_state WHERE corpus=? AND source_path=?", (CORPUS, rel)
    ).fetchone()
    if row and row[0] == file_hash:
        return 0

    meta, turns = PARSERS[show_key](text)
    if not turns:
        if show_key == "tbrh":
            # TBRH's story-links files are frequently and legitimately empty --
            # bonus/call-in/portfolio-profile episodes cite no news stories at
            # all (confirmed against the real archive: every empty-links file
            # sampled is well-formed JSON with "links": [], not a broken
            # parse). Cache the hash so it's not re-read and re-logged on
            # every future run; a real edit to the file still invalidates it
            # via the file_hash check above.
            print(f"{rel}: 0 chunk(s) — no story links for this episode")
            if not dry_run:
                conn.execute(
                    "INSERT INTO ingest_state (corpus, source_path, file_hash, last_ingested) "
                    "VALUES (?,?,?,?) ON CONFLICT(corpus, source_path) DO UPDATE SET "
                    "file_hash=excluded.file_hash, last_ingested=excluded.last_ingested",
                    (CORPUS, rel, file_hash,
                     datetime.datetime.now(datetime.timezone.utc).isoformat()),
                )
                conn.commit()
        else:
            # SN/IM always have real dialogue -- an empty parse here means the
            # source format genuinely changed, not "nothing to say." Left
            # uncached (unlike tbrh above) so it keeps surfacing until fixed.
            print(f"WARNING: {rel}: no turns parsed — skipping (format may have changed)", file=sys.stderr)
        return 0

    base = citation_base(meta)
    chunk_texts = list(rag.group_blocks(turns, MAX_CHUNK_CHARS, sep="\n\n"))
    n = len(chunk_texts)
    chunks = [
        {"citation": base if n == 1 else f"{base} (part {i + 1}/{n})", "text": t}
        for i, t in enumerate(chunk_texts)
    ]

    if dry_run:
        print(f"[dry-run] {rel}: {n} chunk(s) would be (re)embedded — {base}")
        return n

    job_id = submit_embed_job(token, base, chunks)
    result = wait_for_job(token, job_id)
    if result.get("state") != "done":
        print(f"ERROR: {rel}: embed job {job_id} -> {result.get('state')}: "
              f"{result.get('error')}", file=sys.stderr)
        return 0

    artifact_path = result.get("artifact")
    with open(artifact_path, "r", encoding="utf-8") as fh:
        embeddings = json.load(fh)["embeddings"]
    if len(embeddings) != n:
        print(f"ERROR: {rel}: expected {n} embeddings, got {len(embeddings)}", file=sys.stderr)
        return 0

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn.execute("DELETE FROM chunks WHERE corpus=? AND source_path=?", (CORPUS, rel))
    conn.execute(
        "DELETE FROM vec_chunks WHERE chunk_id IN "
        "(SELECT id FROM chunks WHERE corpus=? AND source_path=?)",
        (CORPUS, rel),
    )
    for idx, (chunk, vec) in enumerate(zip(chunks, embeddings)):
        cur = conn.execute(
            "INSERT INTO chunks (corpus, source_path, section, chunk_index, chunk_text, "
            "citation, content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
            (CORPUS, rel, meta["show"], idx, chunk["text"], chunk["citation"],
             rag.content_hash(chunk["text"]), now),
        )
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (cur.lastrowid, rag.pack_vec(vec)),
        )
    conn.execute(
        "INSERT INTO ingest_state (corpus, source_path, file_hash, last_ingested) VALUES (?,?,?,?) "
        "ON CONFLICT(corpus, source_path) DO UPDATE SET file_hash=excluded.file_hash, "
        "last_ingested=excluded.last_ingested",
        (CORPUS, rel, file_hash, now),
    )
    conn.commit()
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", default=ARCHIVE_ROOT)
    ap.add_argument("--limit", type=int, default=0, help="ingest at most N changed files (0 = no limit)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    archive = Path(args.archive)
    files = discover_files(archive)
    if not files:
        print(f"ERROR: no podcast transcript files found under {archive}", file=sys.stderr)
        return 1

    token = None if args.dry_run else broker_token()
    conn = rag.connect(readonly=False)

    total_chunks = 0
    changed_files = 0
    for show_key, path in files:
        if args.limit and changed_files >= args.limit:
            break
        try:
            n = ingest_file(conn, token, show_key, path, archive, args.dry_run)
        except (RuntimeError, urllib.error.URLError) as e:
            print(f"ERROR embedding {path}: {e}", file=sys.stderr)
            continue
        if n:
            changed_files += 1
            total_chunks += n
            print(f"{path.relative_to(archive)}: {n} chunk(s)")

    if not args.dry_run:
        current = {str(p.relative_to(archive)) for _, p in files}
        pruned = rag.prune_stale(conn, CORPUS, current)
        if pruned:
            print(f"Pruned {len(pruned)} stale source(s): {', '.join(pruned)}")

    print(f"Scanned {len(files)} file(s), {changed_files} changed, {total_chunks} chunk(s) (re)embedded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
