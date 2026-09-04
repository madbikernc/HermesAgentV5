#!/usr/bin/env python3
# Version: 1.5.0
#
# 1.5.0 (2026-09-04) — direct request, found reviewing a real TBRH sample
# while describing this corpus's integration level: parse_tbrh() indexed
# every link in a story-links file as if it were a real story citation,
# including sponsor/ad-read plugs and the recurring "subscribe to the
# ad-free feed" self-promo line. Added _is_tbrh_sponsor_noise() -- see that
# function's own comment for how the filter shape was found and quantified
# against the real archive (2405 files) before shipping. IMPORTANT
# operational note: file_hash dedup (ingest_state) is computed from the raw
# JSON text, which this fix doesn't change, so a normal incremental reindex
# will NOT reprocess any of the 2405 already-indexed TBRH files -- their old,
# noise-included chunks stay in the index until ingest_state rows for
# corpus='podcasts' AND source_path LIKE 'TechBrewRideHome/%' are cleared
# (or dropped entirely), forcing a full re-embed of the whole TBRH set on
# the next run.
#
# 1.4.0 (2026-09-04) — direct request, found during a RAG-ingest coverage
# audit: two real sources sitting in the archive had been excluded from this
# corpus entirely, flagged only in this file's own header comment below with
# no live signal an operator would ever see. Both are now ingested:
#   - SecurityNow/show_notes/*.pdf (645 real files, `SN-<ep>-Notes.pdf` per
#     hermes-podcast-retriever.py's own SN_FILE_TYPES naming) — converted to
#     real structured Markdown via hermes_doc_to_markdown.py (the same
#     converter hermes-rag-ingest-kb.py already uses for personal-kb's PDFs),
#     then header-aware chunked (hermes_rag_common.chunk_file()) rather than
#     the flat turn-based group_blocks() every other show here uses — show
#     notes are prose/bullet content with real headings, not dialogue.
#     New show_key "sn_notes"; ingest_file() branches around the normal
#     text-file-read + PARSERS dispatch for this one key since it needs
#     PDF conversion instead, but still ends up as the same flat list of
#     {"citation", "text"} dicts every other show already produces, so it
#     rides the existing broker embed-submission path unchanged.
#   - TheVoid/*.htm(l) (1 real file, still genuinely undocumented — no known
#     per-episode structure like SN/IM's transcript templates) — stripped
#     via lxml.html the same way hermes-rag-ingest-kb.py's own
#     extract_epub_text() walks EPUB chapters, paragraph-boundary chunked
#     like SN/IM since there's no real heading structure to key on. New
#     "thevoid" PARSERS entry, parse_thevoid().
# citation_base() now omits the "#?" episode tag when episode is unknown
# ("?") rather than printing a bare "Show #?" — only visibly changes
# TheVoid's citation (which has no episode numbering at all); every other
# show's real regex match still produces a real episode number as before.
#
# Also added report_unhandled(): after discover_files() builds the known
# file list, every other real file under the archive root not covered by any
# known glob is now surfaced at runtime, grouped by extension with one
# example path each — the same "every skipped file is named explicitly"
# discipline hermes-rag-ingest-kb.py's discover_files() already applies,
# extended here in aggregate (not per-file — this archive can hold
# thousands of non-transcript files, e.g. audio, and a thousand-line skip
# report in a daily timer log would bury the signal it's meant to surface).
#
# 1.3.0 (2026-09-04) — adds ingestion for the two new sources
# hermes-podcast-retriever.py 1.4.0 introduced: "twit" (This Week in Tech,
# ThisWeekInTech/transcripts/*.txt) and "sn_club" (SN's Club TWiT gap-fill
# fallback, SecurityNow/transcripts_txt_club/*.txt). Both land on the exact
# same twit.tv transcript template IM's current format already parses
# (confirmed live) -- rather than duplicate parse_intelligent_machines(),
# factored its shared header-parsing (episode number + date from the title
# line) into _twit_family_meta(), reused by parse_twit() and the new
# parse_sn_club(). parse_sn_club() deliberately sets meta["show"] to plain
# "Security Now!", identical to GRC-sourced episodes -- the citation should
# never reveal which of the two sources actually supplied a given episode;
# that distinction only matters upstream, for discovery/dedup.
#
# The turn-marker cascade this first assumed (IM_TURN_RE, falling back to
# IM_TURN_RE_OLD) turned out incomplete once actually run against TWiT's
# real back catalog during the same session's live backfill: TWiT episodes
# from 2021-2022 (852, 900 confirmed) use a fourth shape, "Speaker
# (HH:MM:SS):" -- parens, not the current format's square brackets, and
# name-first unlike IM_TURN_RE_OLD's timestamp-first shape. Added
# TWIT_TURN_RE_PARENS as a third fallback, and factored the growing
# cascade (shared by all three parsers here) into _twit_family_turns()
# rather than repeating it. Also widened TWIT_TITLE_RE: TWiT's own title
# line drops the word "Episode" for some older episodes ("This Week in Tech
# 968 Transcript" vs "...Episode 900 Transcript") -- found the same way,
# live, not assumed.
#
# Two more of the same kind, found re-running the dry-run after the above
# and checking every remaining "no turns parsed" straggler rather than
# stopping at "mostly fixed": a fifth turn shape, TWIT_TURN_RE_BARE (bare
# "Speaker:" with no timestamp at all, episodes 882/912, 2022-2023) --
# broadest pattern in the cascade, so tried last, and paired with
# TWIT_TURN_STOPLIST since it also matches a page-footer "Share" copy-link
# button, confirmed live inspecting twit-912's raw text before trusting the
# pattern. And a second TWIT_TITLE_RE gap: episode 882 titles itself with
# the bare "TWIT" abbreviation, not "This Week in Tech" anywhere on the page.
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
files), IntelligentMachines/transcripts/*.txt (78 real files), (1.2.0)
TechBrewRideHome/story_links/*.json, and (1.4.0) SecurityNow/show_notes/*.pdf
(645 real files, converted to Markdown) and TheVoid/*.htm(l) (1 real,
still-undocumented file) — every real source in the archive is now either
ingested or explicitly named as skipped at runtime (report_unhandled()),
rather than a source's exclusion living only in this comment where no
operator running the daily timer would ever see it.

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
source per constraint 6 — never a bare excerpt. (1.4.0) SN show notes PDFs
are prose/bullet content, not dialogue — converted to Markdown via
hermes_doc_to_markdown.py and header-aware chunked via
hermes_rag_common.chunk_file() instead. TheVoid's single HTML file has no
known per-episode structure, so it's paragraph-boundary chunked like SN/IM.

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

import lxml.html

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_doc_to_markdown as doc2md  # noqa: E402
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
# A fourth turn-marker shape, found live 2026-09-04 in TWiT's own back
# catalog (episodes 852 and 900, both older than any im-8xx episode this
# tool has ever downloaded -- IM's archive starts in 2025, TWiT's goes back
# to 2021): "Speaker (HH:MM:SS):" -- name first like the *current* format,
# but parens instead of square brackets, and no role tag ever seen with it.
# Tried last in the cascade (see _twit_family_meta()'s callers) since it's
# rarer and only confirmed for TWiT so far.
TWIT_TURN_RE_PARENS = re.compile(
    r"^([A-Za-z][A-Za-z .'-]{1,40}) \((\d{2}:\d{2}:\d{2})\):$", re.MULTILINE
)
# A fifth shape, also found live in the same backfill (twit-882, twit-912,
# both 2022-2023): no timestamp at all, just "Speaker:" on its own line --
# an even older/simpler template. Broadest pattern in the cascade by far
# (any capitalized "Word:" line), so tried last and paired with
# TWIT_TURN_STOPLIST below: confirmed live that twit-912's page-footer
# "Share:" button label (a "copy link" widget, not a speaker) matches this
# shape too, right before real page-navigation junk ("Copied!", "All
# Transcripts posts", "Contact", "Advertise", ...) that would otherwise
# become one bogus trailing chunk. "Host:" is deliberately NOT stoplisted --
# confirmed live (twit-882) it's a real, if generic, speaker attribution
# TWiT's own template uses when a co-host isn't individually named.
TWIT_TURN_RE_BARE = re.compile(r"^([A-Z][A-Za-z .'-]{0,30}):$", re.MULTILINE)
TWIT_TURN_STOPLIST = {"Share"}

# TWiT ("This Week in Tech") and SN's Club TWiT gap-fill fallback both land
# on the same twit.tv transcript-page family IM's parsers already handle --
# IM_TURN_RE/IM_TURN_RE_OLD/TWIT_TURN_RE_PARENS/TWIT_TURN_RE_BARE below are
# reused for both rather than duplicated. Title wording varies more than
# initially assumed: confirmed live against TWiT's real back-catalog
# (2026-09-04, the first backfill run) that "Episode " is sometimes absent
# ("This Week in Tech 968 Transcript" vs "...Episode 900 Transcript") --
# optional in the pattern, not two separate regexes. A separate older
# episode (882, 2022) titles itself with the bare abbreviation instead:
# "TWIT Episode 882 Transcript", no "This Week in Tech" anywhere on the
# page -- IGNORECASE already covers "TWIT"/"TWiT"/"twit" as one alternative.
TWIT_TITLE_RE = re.compile(
    r"(?:This Week in Tech|TWiT) (?:Episode )?(\d+) Transcript", re.IGNORECASE
)
SN_CLUB_TITLE_RE = re.compile(r"Security Now (\d+) transcript", re.IGNORECASE)


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


# ---- Shared header parsing for any twit.tv AI-transcript page -------------

def _twit_family_meta(text: str, title_re, show_name: str) -> dict:
    """Episode number from the title line, then the next non-blank,
    non-disclaimer line as the date -- the shape every twit.tv transcript
    page (IM, TWiT, and SN's Club TWiT fallback) shares, just with a
    different title wording per show."""
    num = title_re.search(text)
    episode = num.group(1) if num else "?"

    date = ""
    if num:
        rest = text[num.end():].splitlines()
        for line in rest[:5]:
            line = line.strip()
            if line and not line.lower().startswith("please be advised"):
                date = line
                break

    return {"show": show_name, "episode": episode, "date": date, "title": ""}


def _twit_family_turns(text: str) -> list[str]:
    """Try every known twit.tv turn-marker shape in order (current brackets
    first, since it's what every recent episode across all three shows
    uses), stopping at the first pattern that matches anything -- a given
    page only ever uses one shape throughout, never a mix."""
    matches = (
        list(IM_TURN_RE.finditer(text))
        or list(IM_TURN_RE_OLD.finditer(text))
        or list(TWIT_TURN_RE_PARENS.finditer(text))
        or list(TWIT_TURN_RE_BARE.finditer(text))
    )
    return _im_turns_from_matches(text, matches)


# ---- IntelligentMachines parsing ------------------------------------------

def parse_intelligent_machines(text: str):
    meta = _twit_family_meta(text, IM_TITLE_RE, "Intelligent Machines")
    return meta, _twit_family_turns(text)


# ---- This Week in Tech parsing ---------------------------------------------

def parse_twit(text: str):
    meta = _twit_family_meta(text, TWIT_TITLE_RE, "This Week in Tech")
    return meta, _twit_family_turns(text)


# ---- Security Now (Club TWiT gap-fill fallback) parsing --------------------

def parse_sn_club(text: str):
    """SN episodes GRC never published its own txt for (see
    hermes-podcast-retriever.py 1.4.0's sn_transcript_club_txt) -- sourced
    from the same twit.tv transcript page template as IM/TWiT, not GRC's own
    header/turn format, so this does NOT reuse parse_security_now(). meta["show"]
    is still plain "Security Now!" (matching GRC-sourced episodes) so a RAG
    citation looks identical regardless of which source actually supplied
    it -- the distinction only matters for discovery/dedup, never downstream."""
    meta = _twit_family_meta(text, SN_CLUB_TITLE_RE, "Security Now!")
    return meta, _twit_family_turns(text)


def _im_turns_from_matches(text: str, matches) -> list[str]:
    # Every turn-marker pattern in the cascade captures the speaker name as
    # group 1. TWIT_TURN_STOPLIST catches page-chrome labels shaped exactly
    # like a bare speaker turn (confirmed live: a "Share" copy-link button)
    # -- see TWIT_TURN_RE_BARE's own comment for why "Host" is not included.
    turns = []
    for i, m in enumerate(matches):
        speaker = m.group(1).strip()
        if speaker in TWIT_TURN_STOPLIST:
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = " ".join(text[start:end].split())
        if body:
            turns.append(f"{speaker}: {body}")
    return turns


# ---- Tech Brew Ride Home parsing -------------------------------------------

# Added 1.5.0, direct request, after noticing a real sample TBRH file
# indexed "Subscribe to the ad-free feed.: https://tech.supercast.com/" as
# if it were a real story. Quantified against the full real archive (2405
# files, 15898 links) before writing this: 2913 links have no attributed
# `source` at all, and within those, 2426 are sponsor/ad-read plugs whose
# "headline" is really just the sponsor's own URL/brand read aloud --
# "Metalab.co", "TinyCapital.com", "Mealime", "Shopify.com/ride" -- always a
# single space-free token, never a sentence. The remaining 487 null-source
# entries are real content (a full headline sentence or book title TBRH's
# own show-notes just didn't wrap in a "(Source)" parenthetical) -- sampled
# across the whole archive, every one of them contains a space. A link WITH
# a real attributed source is never touched by this filter, regardless of
# shape (e.g. "Cerebras" attributed to "Pierre Lamond" stays, since `source`
# is not null for it).
TBRH_ADFEED_RE = re.compile(r"ad-free feed", re.IGNORECASE)


def _is_tbrh_sponsor_noise(headline: str) -> bool:
    """True for a null-source TBRH link entry that's sponsor/ad-read noise,
    not a real story. See this section's own comment above for how this
    shape was found and quantified against the real archive."""
    if TBRH_ADFEED_RE.search(headline):
        return True
    return " " not in headline


def parse_tbrh(text: str):
    """TBRH has no transcript -- the archive file is the story-links JSON
    hermes-podcast-retriever.py's fetch_tbrh_remote_listing() already
    extracted from the show's own official RSS feed. Each citation (headline
    + source publication + URL, already just that -- not surrounding show-
    notes prose) becomes one short line; there's no dialogue to chunk by
    speaker turn the way SN/IM's parsers do. 1.5.0: sponsor/ad-read links and
    the recurring "subscribe to the ad-free feed" self-promo line are
    dropped via _is_tbrh_sponsor_noise() rather than indexed as if they were
    real story citations."""
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
        if source is None and _is_tbrh_sponsor_noise(headline):
            continue
        tag = f" ({source})" if source else ""
        lines.append(f"{headline}{tag}: {url}")
    return meta, lines


# ---- TheVoid parsing (1.4.0) -----------------------------------------------

THEVOID_BLOCK_XPATH = ".//p | .//li | .//h1 | .//h2 | .//h3 | .//h4 | .//h5 | .//h6"


def parse_thevoid(text: str):
    """The one-off `TheVoid/` folder holds a single undocumented HTML file --
    flagged in this file's own header since before 1.4.0 but never actually
    ingested until now. No known per-episode structure exists for it (unlike
    SN/IM/TWiT's documented transcript templates), so this extracts flat
    paragraph text via the same block-tag walk hermes-rag-ingest-kb.py's own
    extract_epub_text() uses for EPUB chapters, rather than assuming a
    turn-by-turn dialogue shape that may not apply. A page with no block tags
    at all falls back to its whole text as one block, same "never index
    nothing silently" discipline extract_epub_text() already follows."""
    tree = lxml.html.fromstring(text)
    for bad in tree.xpath(".//script | .//style"):
        bad.getparent().remove(bad)
    blocks = [el.text_content().strip() for el in tree.xpath(THEVOID_BLOCK_XPATH)]
    blocks = [b for b in blocks if b]
    if not blocks:
        whole = tree.text_content().strip()
        blocks = [whole] if whole else []
    meta = {"show": "TheVoid", "episode": "?", "date": "", "title": ""}
    return meta, blocks


PARSERS = {
    "sn": parse_security_now, "im": parse_intelligent_machines, "tbrh": parse_tbrh,
    "twit": parse_twit, "sn_club": parse_sn_club, "thevoid": parse_thevoid,
}


def citation_base(meta: dict) -> str:
    parts = [meta["show"]]
    if meta["episode"] != "?":
        parts.append(f"#{meta['episode']}")
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
    sn_club_dir = archive / "SecurityNow" / "transcripts_txt_club"
    if sn_club_dir.is_dir():
        files += [("sn_club", p) for p in sorted(sn_club_dir.glob("*.txt"))]
    sn_notes_dir = archive / "SecurityNow" / "show_notes"
    if sn_notes_dir.is_dir():
        files += [("sn_notes", p) for p in sorted(sn_notes_dir.glob("*.pdf"))]
    im_dir = archive / "IntelligentMachines" / "transcripts"
    if im_dir.is_dir():
        files += [("im", p) for p in sorted(im_dir.glob("*.txt"))]
    twit_dir = archive / "ThisWeekInTech" / "transcripts"
    if twit_dir.is_dir():
        files += [("twit", p) for p in sorted(twit_dir.glob("*.txt"))]
    tbrh_dir = archive / "TechBrewRideHome" / "story_links"
    if tbrh_dir.is_dir():
        files += [("tbrh", p) for p in sorted(tbrh_dir.glob("*.json"))]
    thevoid_dir = archive / "TheVoid"
    if thevoid_dir.is_dir():
        files += [("thevoid", p) for p in sorted(thevoid_dir.glob("*.htm*"))]
    return files


def report_unhandled(archive: Path, known: set):
    """Surfaces every real file under `archive` that no known per-show glob
    above covers, grouped by extension with one example path each -- the
    same "every skipped file is named explicitly" discipline
    hermes-rag-ingest-kb.py's own discover_files() already applies to
    personal-kb, extended here in aggregate rather than per-file: this
    archive can hold thousands of non-transcript files (audio, artwork, ...),
    and a thousand-line skip report in a daily timer log would bury the
    signal it's meant to surface. Added 1.4.0 after show_notes/TheVoid sat
    unindexed for months with their only "flag" being a comment in this
    file's own header, invisible to anyone just watching the timer's real
    output."""
    if not archive.is_dir():
        return
    by_ext = {}
    for p in archive.rglob("*"):
        if p.is_file() and p not in known:
            by_ext.setdefault(p.suffix.lower(), []).append(p)
    for ext, paths in sorted(by_ext.items()):
        example = paths[0].relative_to(archive)
        print(f"SKIPPED (unhandled, {len(paths)} file(s), ext={ext or '(none)'}): "
              f"e.g. {example}", file=sys.stderr)


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


SN_NOTES_NAME_RE = re.compile(r"SN-(\d+)-Notes\.pdf", re.IGNORECASE)


def ingest_file(conn, token, show_key, path: Path, archive: Path, dry_run: bool) -> int:
    rel = str(path.relative_to(archive))

    if show_key == "sn_notes":
        # PDF, not a text file -- can't go through path.read_text() like
        # every other show here. Converted via the same
        # hermes_doc_to_markdown.py the personal-kb corpus already uses.
        try:
            text = doc2md.to_markdown(path)
        except Exception as e:
            # Broad on purpose, same reasoning hermes-rag-ingest-kb.py's own
            # ingest_file() already documents: pymupdf4llm can raise several
            # distinct exception types on a malformed real-world PDF, and one
            # bad show-notes file shouldn't crash the whole 645-file batch.
            print(f"WARNING: {rel}: could not convert to markdown, skipping: {e}", file=sys.stderr)
            return 0
    else:
        text = path.read_text(encoding="utf-8", errors="replace")
    file_hash = rag.content_hash(text)

    row = conn.execute(
        "SELECT file_hash FROM ingest_state WHERE corpus=? AND source_path=?", (CORPUS, rel)
    ).fetchone()
    if row and row[0] == file_hash:
        return 0

    if show_key == "sn_notes":
        if not text.strip():
            print(f"WARNING: {rel}: no extractable text — skipping (scanned/image-only PDF?)",
                  file=sys.stderr)
            return 0
        m = SN_NOTES_NAME_RE.search(path.name)
        show_label = "Security Now! Show Notes"
        base = f"{show_label} #{m.group(1)}" if m else f"{show_label} ({path.stem})"
        sections = list(rag.chunk_file(text, MAX_CHUNK_CHARS))  # [(header, body), ...]
        n = len(sections)
        chunks = []
        for i, (header, body) in enumerate(sections):
            if header not in ("(preamble)", "(no heading)"):
                citation = f"{base} — {header}"
            else:
                citation = base if n == 1 else f"{base} (part {i + 1}/{n})"
            chunks.append({"citation": citation, "text": body})
    else:
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
                # SN/IM/TWiT/TheVoid always have real content -- an empty parse
                # here means the source format genuinely changed, not "nothing to
                # say." Left uncached (unlike tbrh above) so it keeps surfacing
                # until fixed.
                print(f"WARNING: {rel}: no turns parsed — skipping (format may have changed)", file=sys.stderr)
            return 0

        show_label = meta["show"]
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
            (CORPUS, rel, show_label, idx, chunk["text"], chunk["citation"],
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

    report_unhandled(archive, {p for _, p in files})

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
