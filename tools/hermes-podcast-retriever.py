#!/usr/bin/env python3
# Version: 1.4.0
#
# 1.4.0 (2026-09-04) — direct request: integrate Club TWiT's memberfulcontent.com
# RSS feeds (Paul Munford's paid membership; auth token in Vaultwarden as
# twit-club-auth) as a superior discovery mechanism, replacing sequential
# HEAD-probing for TWIG/IM and adding a new show (TWiT, "This Week in Tech").
# Confirmed live before building: every feed item with a real episode number
# carries a <podcast:transcript url=...> pointing at the exact same public
# twit.tv HTML transcript page this tool already downloads for IM (no auth
# needed for the page itself, only for discovering it) -- so this is a drop-in
# replacement for how the URL is found, not a new download path. Concretely
# better than probing: no guessing episode numbers, no PROBE_GIVE_UP
# heuristic, and no separate URL template per pre/post-rebrand slug (the
# feed already resolves to the right one) -- the exact class of gap
# hermes-rag-ingest-podcasts.py 1.2.3 had to patch around downstream. One
# feed (id 9064) covers both TWIG (606-804) and IM (805+) under one episode
# numbering scheme; split by IM_FIRST_EP same as before, just sourced from
# one shared fetch instead of two separate probe runs. Removed as dead code:
# TWIT_TRANSCRIPT_TMPL, PROBE_GIVE_UP, _probe_twit_episodes(),
# fetch_twit_remote_listing() -- direct request was to prefer these feeds
# over the current methods, not run both.
#
# Also adds a second, independent use of the same mechanism: Security Now's
# discovery stays GRC-first (GRC's archive goes back to episode 1; the club
# feed only carries a rolling window from ep 813 at verification time, and
# GRC's official show-notes PDF has no club-feed equivalent at all) -- but a
# new sn_transcript_club_txt file type now fills a real, confirmed gap: SN-1094
# has sat in hermes-podcast-sync.py's daily failure email since GRC never
# published its own txt/pdf for it, yet the Club TWiT feed's own
# podcast:transcript entry for 1094 resolves to a real page GRC's absence
# says nothing about. Fetched only for episodes GRC's own sn_transcript_txt
# doesn't already cover (see compute_missing()), saved to a separate
# transcripts_txt_club/ subfolder and sn-{ep}-club.txt filename so it can
# never collide with or shadow a genuine future GRC publication, and so
# hermes-rag-ingest-podcasts.py can route it through the twit.tv-template
# parser (parse_sn_club()) rather than GRC's own header/turn format, which
# this content does not follow.
#
# Found live during this version's own first real backfill run (244 TWiT +
# 236 SN-club candidates): some episodes' <podcast:transcript> URL points at
# an unrelated /posts/tech/ news article about the episode's guest/topic
# instead of a real transcript page (im-871 was the first confirmed case) --
# every genuine transcript page seen across SN/IM/TWiT lives under
# /posts/transcripts/ instead, so fetch_club_transcript_listing() now
# rejects any transcript URL lacking that path segment at discovery time,
# before ever downloading it -- treated the same as an episode with no
# transcript tag at all, so it's retried (not permanently miscached) if
# TWiT's own feed metadata is ever fixed upstream. Also found live: twit.tv
# starts returning HTTP 418 partway through a sustained run of 100+ rapid
# sequential requests (confirmed by hand: a URL that succeeded minutes
# earlier in the same run later returned 418 too, on an otherwise-idle
# connection) -- not a per-URL problem, a volume-triggered block. Only
# matters for a first-time bulk backfill like this one; the daily catch-up
# sync only ever requests a handful of new files a day, nowhere near this
# threshold. No code changes made for it -- the fix is operational (retry
# the remainder later, spaced out via --delay), not a defect in this tool.
#
# Version: 1.3.0
#
# 1.3.0 — adds Dan Carlin's three shows (show keys "dchh"/"dchha"/"dccs"):
# direct request, 2026-08-19, prompted by the same-day discovery
# (IMPLEMENTATION_PLAN.md §7 Phase 30) that RAGDocs already held 86
# manually-placed Dan Carlin .mp3s with no naming convention and nothing
# keeping the set current. Genuinely new shape for this tool: full audio
# download (no transcript exists for this show family) into a NAS share
# (RAGDocs, sibling to this tool's usual PodCasts root — Phase 30f's
# personal-kb source, per direct request), not this tool's usual PodCasts
# root, and each show gets its own RAGDocs/DanCarlin/<Show> subfolder
# (mirrors every other show's own subfolder) rather than one flat directory,
# so the leading-episode-number naming convention this was asked for
# (`{ep}-{original-filename}`, e.g. `dchh-Addendum26-Dig-This.mp3` →
# `26-dchh-Addendum26-Dig-This.mp3`) never has to disambiguate collisions
# between shows sharing one folder. Verified live against all three real
# feeds (see the comment on DANCARLIN_FEEDS below): direct, unauthenticated
# audio enclosures, no purchase/login gate on what's actually in the feed.
# Hardcore History: Addendum is folded in under the "Hardcore History" ask
# since it's the same show family and the request's own worked example is
# an Addendum episode. Also adds --dry-run (any show, not just Dan Carlin's)
# since this is this tool's first capability that can each download
# hundreds of MB per file — cheap insurance against a first real run
# silently re-downloading content already sitting somewhere this tool
# doesn't yet know to look (the pre-existing 86 files noted above weren't
# placed by this tool and may not be where its own local-scan looks).
#
# 1.2.0 — adds Tech Brew Ride Home (show key "tbrh"): direct request,
# 2026-08-15, after confirming (same day, live) that this show has no
# official transcript anywhere — only its own official RSS feed
# (https://feeds.megaphone.fm/ridehome), where every episode's <description>
# already includes a "Links"/"Longreads"-style citation list (headline +
# source publication + URL) for every story it covered that day. That
# citation list, not a transcript, is what this show key retrieves.
# Structurally different enough from SN/TWiT that it doesn't fit either
# existing pattern: there's no per-episode URL to probe or scrape (the feed
# itself carries everything already), and the feed has no episode numbers or
# per-item link/guid at all (checked live against real feed content) — only
# a pubDate, so episodes are keyed by publish date (YYYYMMDD as int) instead
# of the sequential ints every other show here uses. RemoteFile grew an
# optional `payload` field so the already-fetched-and-parsed citation list
# can be written straight to disk as JSON, with no second per-episode HTTP
# round-trip the way SN/TWiT's download step needs.
#
# 1.1.0 — security-review fix: fetch_sn_remote_listing()/
# _probe_twit_episodes() can now distinguish a real "nothing new" from "the
# source couldn't be reached at all" (a total GRC outage, or PROBE_GIVE_UP
# consecutive connection failures on twit.tv) and return None instead of an
# empty result — previously indistinguishable, so a full outage silently
# read as "already up to date." run() now surfaces this as a real per-show
# failure (ShowStats.fetch_failed) instead of reporting a clean sync.
"""
hermes-podcast-retriever.py - Multi-Podcast Transcript & Episode Downloader

Phase 24 (IMPLEMENTATION_PLAN.md §7). Ported from v1
(../HermesAgent/scripts/podcast_retriever.py) essentially unchanged — the
scraping/probing logic itself was already correct and needed no rework;
only the wrapper around it (hermes-podcast-sync.py) needed updating for
this project's current NAS path and Vaultwarden-backed email. Verified live
against the real sites before porting (2026-08-12): GRC's archive page
still returns 200 with the same sn-NNNN.pdf/txt naming (up through sn-1089
at verification time), and TWiT's transcript URL pattern still resolves
the same way (intelligent-machines-850-transcript: 200).

Downloads transcripts, show notes, story-links, and audio files for:
  - Security Now!         (GRC.com, + Club TWiT feed as a gap-fill fallback)
                                                 -- stored in SecurityNow/
  - This Week in Google   (TWiT.tv, via Club TWiT feed) -- stored in ThisWeekInGoogle/
  - Intelligent Machines  (TWiT.tv, via Club TWiT feed) -- stored in IntelligentMachines/
  - This Week in Tech     (TWiT.tv, via Club TWiT feed) -- stored in ThisWeekInTech/
  - Tech Brew Ride Home   (official RSS feed)    -- stored in TechBrewRideHome/
  - Hardcore History           (official RSS feed) -- stored in DanCarlin/HardcoreHistory/
  - Hardcore History: Addendum (official RSS feed) -- stored in DanCarlin/Addendum/
  - Common Sense               (official RSS feed) -- stored in DanCarlin/CommonSense/
    (the three Dan Carlin shows are meant to be run against RAGDocs, not this
    tool's usual PodCasts root -- see the Dan Carlin section below and
    DANCARLIN_FEEDS' own comment)

Security Now:
  Scrapes GRC year-archive pages to discover which episodes have show-notes
  PDFs, transcript PDFs, and transcript TXTs, then downloads only what is
  missing locally -- GRC remains the primary source (full archive back to
  episode 1; the only source for the official show-notes PDF). A second,
  independent file type (sn_transcript_club_txt) additionally checks the
  Club TWiT feed for episodes GRC's own txt is missing, and downloads
  those from twit.tv's transcript page instead — a real, confirmed gap-fill
  (see the 1.4.0 changelog entry above for SN-1094).

This Week in Google / Intelligent Machines / This Week in Tech:
  Discovered via Club TWiT's memberfulcontent.com RSS feeds (Paul Munford's
  membership; auth token in Vaultwarden as twit-club-auth — see
  club_auth_token()), each item's <podcast:transcript url=...> resolving
  directly to the exact public twit.tv HTML transcript page this tool has
  always downloaded from — no auth needed for the page itself, only for
  discovering it exists via the feed. One feed (id 9064) covers both TWIG
  (episodes 1-804, pre-rebrand) and IM (805+) under one shared numbering
  scheme; a separate feed (id 9066) covers TWiT. Fetches the HTML page,
  strips it to plain text, and saves as {show}-{ep}.txt — unchanged from
  before; only how the URL is discovered changed (see fetch_club_transcript_listing()).

Tech Brew Ride Home:
  No official transcript exists for this show (confirmed live, 2026-08-15).
  Its official RSS feed's per-episode <description> already carries a
  citation list (headline + source publication + URL) for every story that
  episode covered — this extracts just that list, not the surrounding show-
  notes prose, and saves it as tbrh-{YYYYMMDD}.json.

Dan Carlin (Hardcore History / Hardcore History: Addendum / Common Sense):
  No transcript exists for any of these either — each show's own official
  RSS feed carries a direct, unauthenticated audio enclosure per episode
  (see the comment on DANCARLIN_FEEDS for what was confirmed live). Episode
  identity comes from each item's <itunes:episode>, not the enclosure
  filename, which is styled inconsistently across each show's real history.
  Saved as {ep}-{original-enclosure-filename}, e.g.
  26-dchh-Addendum26-Dig-This.mp3 — into RAGDocs/DanCarlin/<Show>/, not this
  tool's usual PodCasts root (per direct request; RAGDocs is Phase 30f's
  personal-kb source, a sibling NAS share to PodCasts).

All HTTP uses urllib (stdlib only — no external dependencies).
"""

import argparse
import email.utils
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlsplit


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GRC_BASE_URL = "https://www.grc.com/sn"
GRC_ARCHIVE_PAGES = [
    "https://www.grc.com/securitynow.htm",
    *(f"https://www.grc.com/sn/past/{y}.htm" for y in range(2025, 2004, -1)),
]

# IM starts at episode 805 (formerly TWIG); TWIG episodes are 1-804
IM_FIRST_EP   = 805
TWIG_LAST_EP  = 804

# Club TWiT (twit.memberfulcontent.com) RSS feed ids -- see 1.4.0 changelog
# entry above. "twig" and "im" share one feed/episode-numbering scheme
# (split by IM_FIRST_EP in run()); "sn" is a supplemental gap-fill source
# alongside GRC, not a replacement. Auth token: Vaultwarden item
# twit-club-auth, field "password" -- see club_auth_token().
CLUB_FEED_ID = {
    "sn":   "9054",
    "im":   "9064",
    "twig": "9064",
    "twit": "9066",
}
CLUB_FEED_URL_TMPL = "https://twit.memberfulcontent.com/rss/{feed_id}?auth={token}"
_PODCAST_NS = {"podcast": "https://podcastindex.org/namespace/1.0"}

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_SCRIPT = REPO_DIR / "tools" / "vault-get-secret.sh"

# Tech Brew Ride Home's official RSS feed -- the only official source for
# this show's per-episode story-links citation list (no transcript exists).
TBRH_FEED_URL = "https://feeds.megaphone.fm/ridehome"

# Dan Carlin's shows -- each show's own official RSS feed. Live-verified
# 2026-08-19: every one of these resolves to a real, direct, unauthenticated
# audio enclosure -- confirmed by following a real episode's URL through its
# podtrac -> libsyn redirect chain to a 200 with a real audio/mpeg
# Content-Length (a 179MB Hardcore History episode, a 60MB Addendum episode,
# a 44MB Common Sense episode), no login or purchase step anywhere in that
# chain. The "history" feed and the Common Sense feed each carry only a
# rolling recent window of full episodes (13 and 8 items respectively at
# verification time) -- Dan Carlin's older back catalog is sold separately
# through the site's own store, deliberately out of scope here since that
# needs a purchase/account this tool has no credential for. Hardcore
# History: Addendum is a separate, same-brand feed of shorter bonus
# episodes with its own independent numbering (1-34 at verification time,
# full back catalog present in the feed, not just a recent window) --
# folded in under the "Hardcore History" show family per direct request
# (whose own worked example, dchh-Addendum26-Dig-This.mp3, is an Addendum
# episode).
DANCARLIN_FEEDS = {
    "dchh":  "https://feeds.feedburner.com/dancarlin/history?format=xml",
    "dchha": "https://dchhaddendum.libsyn.com/rss",
    "dccs":  "https://feeds.feedburner.com/dancarlin/commonsense?format=xml",
}
DANCARLIN_SHOWS = tuple(DANCARLIN_FEEDS)
_ITUNES_NS = {"itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd"}

HEADERS = {"User-Agent": "hermes-podcast-retriever/1.0 (personal archiver)"}
DOWNLOAD_DELAY = 0.5          # seconds between requests


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class RemoteFile:
    show: str          # 'sn', 'twig', 'im', 'tbrh'
    episode: int        # sequential for sn/twig/im; YYYYMMDD for tbrh (see fetch_tbrh_remote_listing)
    file_type: str     # e.g. 'sn_notes_pdf', 'im_transcript_txt', 'tbrh_links_json'
    url: str
    filename: str
    # Pre-fetched content for shows where the remote-listing step already has
    # everything (tbrh: the feed's <description> is already fully parsed by
    # the time this is built) -- when set, _download_one() writes this
    # directly instead of doing a second HTTP round-trip.
    payload: Optional[dict] = None


@dataclass
class ShowStats:
    show: str
    already_local: int = 0
    downloaded: int = 0
    failed: int = 0
    failed_files: list = field(default_factory=list)
    fetch_failed: bool = False


# ---------------------------------------------------------------------------
# Show / file-type config
# ---------------------------------------------------------------------------

SHOWS = {
    "sn":    {"name": "Security Now!",              "subfolder": "SecurityNow"},
    "twig":  {"name": "This Week in Google",        "subfolder": "ThisWeekInGoogle"},
    "im":    {"name": "Intelligent Machines",       "subfolder": "IntelligentMachines"},
    "twit":  {"name": "This Week in Tech",          "subfolder": "ThisWeekInTech"},
    "tbrh":  {"name": "Tech Brew Ride Home",        "subfolder": "TechBrewRideHome"},
    "dchh":  {"name": "Hardcore History",           "subfolder": "DanCarlin/HardcoreHistory"},
    "dchha": {"name": "Hardcore History: Addendum", "subfolder": "DanCarlin/Addendum"},
    "dccs":  {"name": "Common Sense",               "subfolder": "DanCarlin/CommonSense"},
}

# File type definitions used for Security Now
SN_FILE_TYPES = {
    "sn_notes_pdf": {
        "description":   "SN Show Notes (PDF)",
        "pattern":       re.compile(r"SN-(\d+)-Notes\.pdf", re.IGNORECASE),
        "url_template":  GRC_BASE_URL + "/SN-{ep}-Notes.pdf",
        "filename_tmpl": "SN-{ep}-Notes.pdf",
        "subfolder":     "show_notes",
        "validate":      "pdf",
    },
    "sn_transcript_pdf": {
        "description":   "SN Transcript (PDF)",
        "pattern":       re.compile(r"\bsn-(\d+)\.pdf\b", re.IGNORECASE),
        "url_template":  GRC_BASE_URL + "/sn-{ep}.pdf",
        "filename_tmpl": "sn-{ep}.pdf",
        "subfolder":     "transcripts_pdf",
        "validate":      "pdf",
    },
    "sn_transcript_txt": {
        "description":   "SN Transcript (TXT)",
        "pattern":       re.compile(r"\bsn-(\d+)\.txt\b", re.IGNORECASE),
        "url_template":  GRC_BASE_URL + "/sn-{ep}.txt",
        "filename_tmpl": "sn-{ep}.txt",
        "subfolder":     "transcripts_txt",
        "validate":      "text",
    },
    # Gap-fill only, sourced from the Club TWiT feed instead of GRC -- see the
    # 1.4.0 changelog entry above. No "url_template"/"pattern"/"validate": the
    # URL comes straight from the feed (compute_missing()'s dedicated branch
    # for this type), and it's fetched as an HTML transcript page, not a
    # binary GRC file (see _download_one()'s dispatch). A distinct
    # subfolder/filename convention (never sn-{ep}.txt) means this can never
    # collide with or shadow a genuine future GRC publication of the same
    # episode.
    "sn_transcript_club_txt": {
        "description":   "SN Transcript (Club TWiT fallback, TXT)",
        "pattern":       re.compile(r"sn-(\d+)-club\.txt", re.IGNORECASE),
        "filename_tmpl": "sn-{ep}-club.txt",
        "subfolder":     "transcripts_txt_club",
    },
}

# File type definition used for Tech Brew Ride Home -- one type, since there's
# only one thing to fetch (no transcript exists for this show at all).
TBRH_FILE_TYPES = {
    "tbrh_links_json": {
        "description":   "TBRH Story Links (JSON)",
        "filename_tmpl": "tbrh-{ep}.json",
        "subfolder":     "story_links",
    },
}

# File type definition used for Dan Carlin's shows -- one type, since there's
# only ever one thing to fetch per episode (the audio itself; no transcript
# exists for any of these shows).
DANCARLIN_FILE_TYPES = {
    "dancarlin_audio_mp3": {
        "description": "Episode Audio (MP3)",
    },
}

# Available file-type selections per show (CLI --types values)
SHOW_TYPE_MAP = {
    "sn":    {"notes": ["sn_notes_pdf"],
              "pdf":   ["sn_transcript_pdf"],
              "txt":   ["sn_transcript_txt"],
              "club":  ["sn_transcript_club_txt"],
              "all":   ["sn_notes_pdf", "sn_transcript_pdf", "sn_transcript_txt",
                        "sn_transcript_club_txt"]},
    "twig":  {"transcript": ["twig_transcript_txt"], "all": ["twig_transcript_txt"]},
    "im":    {"transcript": ["im_transcript_txt"],   "all": ["im_transcript_txt"]},
    "twit":  {"transcript": ["twit_transcript_txt"], "all": ["twit_transcript_txt"]},
    "tbrh":  {"links": ["tbrh_links_json"], "all": ["tbrh_links_json"]},
    "dchh":  {"audio": ["dancarlin_audio_mp3"], "all": ["dancarlin_audio_mp3"]},
    "dchha": {"audio": ["dancarlin_audio_mp3"], "all": ["dancarlin_audio_mp3"]},
    "dccs":  {"audio": ["dancarlin_audio_mp3"], "all": ["dancarlin_audio_mp3"]},
}


# ---------------------------------------------------------------------------
# HTML content extractor (strips tags → plain text)
# ---------------------------------------------------------------------------

class _TextExtractor(HTMLParser):
    """Extract visible text from an HTML page, skipping scripts/styles."""

    _SKIP = {"script", "style", "head", "noscript"}

    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data):
        if not self._skip_depth:
            text = data.strip()
            if text:
                self.parts.append(text)

    def get_text(self) -> str:
        return "\n".join(self.parts)


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    return parser.get_text()


class _LinkExtractor(HTMLParser):
    """Extract every <a href> in an HTML fragment, plus its own anchor text
    and the plain-text tail immediately following it (up to the next block-
    level tag), so a trailing "(Source Name)" citation already published
    right after the link can be captured alongside it. Used for TBRH's
    story-links extraction — pulls out only the citation data (headline +
    source + URL) the feed already publishes as the link/its adjacent text,
    not the surrounding show-notes prose."""

    _BLOCK = {"p", "div", "li", "br"}

    def __init__(self):
        super().__init__()
        self.links: list[dict] = []
        self._href: Optional[str] = None
        self._text: list[str] = []
        self._tail: list[str] = []
        self._in_tail = False

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self._flush()
                self._href = href
                self._text = []
                self._tail = []
                self._in_tail = False
        elif tag in self._BLOCK:
            self._flush()

    def handle_endtag(self, tag):
        if tag == "a" and self._href:
            self._in_tail = True
        elif tag in self._BLOCK:
            self._flush()

    def handle_data(self, data):
        if self._href is None:
            return
        (self._tail if self._in_tail else self._text).append(data)

    def _flush(self):
        if self._href:
            headline = "".join(self._text).strip()
            tail = "".join(self._tail).strip()
            source = None
            m = re.match(r"^\(([^()]{1,80})\)", tail)
            if m:
                source = m.group(1).strip()
            if headline:
                self.links.append({"headline": headline, "source": source, "url": self._href})
        self._href = None
        self._text = []
        self._tail = []
        self._in_tail = False

    def get_links(self) -> list[dict]:
        self._flush()
        return self.links


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def http_get(url: str, timeout: int = 30) -> Optional[bytes]:
    """GET url → bytes, or None on any error (including 404)."""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError:
        return None
    except urllib.error.URLError:
        return None
    except Exception:
        return None


def validate_content(data: bytes, kind: str) -> bool:
    if not data:
        return False
    if kind == "pdf":
        return data[:5] == b"%PDF-"
    if kind == "text":
        start = data[:100].lower()
        return b"<!doctype" not in start and b"<html" not in start
    if kind == "mp3":
        return data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3")
    return True


# ---------------------------------------------------------------------------
# Security Now — discover remote episodes from GRC archive pages
# ---------------------------------------------------------------------------

def fetch_sn_remote_listing(
    type_keys: list[str], verbose: bool = False
) -> Optional[dict[str, set[int]]]:
    """Scrape GRC archive pages; return {file_type: set(episode_ints)}, or
    None if not a single page could be fetched (a real GRC outage/network
    failure — security-review fix: this used to be indistinguishable from a
    legitimate "nothing new," since an all-failed loop just leaves `found`'s
    sets empty like a real zero-episode result would)."""
    if verbose:
        print("  Fetching Security Now! remote listing from GRC archive pages…")

    found: dict[str, set[int]] = {k: set() for k in type_keys}
    pages = 0

    for url in GRC_ARCHIVE_PAGES:
        data = http_get(url)
        if not data:
            if verbose:
                print(f"    Warning: could not fetch {url}")
            continue
        html = data.decode("utf-8", errors="replace")
        pages += 1
        for k in type_keys:
            for m in SN_FILE_TYPES[k]["pattern"].finditer(html):
                try:
                    found[k].add(int(m.group(1)))
                except ValueError:
                    pass

    if pages == 0:
        print(f"    ERROR: none of {len(GRC_ARCHIVE_PAGES)} GRC archive pages could be "
              "fetched — treating as a fetch failure, not zero new episodes.")
        return None

    if verbose:
        for k in type_keys:
            print(f"    {SN_FILE_TYPES[k]['description']}: "
                  f"{len(found[k])} episodes found ({pages} pages scanned)")

    # Machine-parseable marker: highest episode number referenced anywhere on
    # the archive pages, across all file types scraped. Callers (e.g.
    # hermes-podcast-sync.py) use this to judge how "recent" a missing
    # episode is, since the archive page references an episode's filenames
    # before every format is necessarily published.
    all_eps = set().union(*found.values()) if found else set()
    if all_eps:
        print(f"LATEST_EPISODE sn {max(all_eps)}")

    return found


# ---------------------------------------------------------------------------
# TWiT (TWIG / IM / TWiT) + SN gap-fill — discover remote episodes via the
# Club TWiT memberfulcontent.com RSS feeds
# ---------------------------------------------------------------------------

def club_auth_token() -> str:
    """Fetch the Club TWiT feed auth token from Vaultwarden (item
    twit-club-auth, field "password"). Raises RuntimeError on failure --
    same convention as hermes-rag-ingest-podcasts.py's broker_token(), which
    every caller here already follows for its own vault-backed secret."""
    out = subprocess.run(
        [str(VAULT_SCRIPT), "twit-club-auth", "password"],
        capture_output=True, text=True, timeout=60,
    )
    token = out.stdout.strip()
    if out.returncode != 0 or not token:
        raise RuntimeError(f"could not fetch twit-club-auth from vault: {out.stderr.strip()}")
    return token


def fetch_club_transcript_listing(
    feed_id: str, auth_token: str, verbose: bool = False
) -> Optional[dict[int, str]]:
    """Fetch one Club TWiT RSS feed and return {episode_int: transcript_url}
    for every item carrying a real <itunes:episode> and a
    <podcast:transcript url=...> -- confirmed live 2026-09-04 that this URL
    is always the same public twit.tv HTML transcript page this tool already
    knows how to download (see _download_one()'s generic HTML-transcript
    branch), no auth needed for the page itself. Items with neither (the
    feed's own auto-generated "Thank You for Subscribing!" entry, or a real
    episode too new/old to have an AI transcript yet) are simply absent from
    the result -- not an error. Returns None only if the feed itself
    couldn't be fetched/parsed at all (a real outage), matching every other
    fetch_*_remote_listing()'s None-means-failure convention; callers must
    check for that, not just falsy.

    Deliberately returns raw feed episodes with no per-show split or
    LATEST_EPISODE marker -- one feed (9064) covers both "twig" and "im"
    under a shared numbering scheme, so that split (by IM_FIRST_EP) and the
    per-show marker line belong to the caller in run(), once it knows which
    show(s) a given feed's episodes are being used for.
    """
    url = CLUB_FEED_URL_TMPL.format(feed_id=feed_id, token=auth_token)
    if verbose:
        print(f"  Fetching Club TWiT feed {feed_id}…")

    data = http_get(url, timeout=60)
    if not data:
        print(f"    ERROR: could not fetch Club TWiT feed {feed_id} — treating as a "
              "fetch failure, not zero new episodes.")
        return None

    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        print(f"    ERROR: could not parse Club TWiT feed {feed_id} XML: {e}")
        return None

    found: dict[int, str] = {}
    for item in root.findall("./channel/item"):
        ep_el = item.find("itunes:episode", _ITUNES_NS)
        if ep_el is None or not (ep_el.text or "").strip():
            continue
        try:
            ep = int(ep_el.text.strip())
        except ValueError:
            continue
        transcript_el = item.find("podcast:transcript", _PODCAST_NS)
        if transcript_el is None:
            continue
        transcript_url = (transcript_el.get("url") or "").strip()
        if not transcript_url:
            continue
        # Found live 2026-09-04 (im-871): some episodes' <podcast:transcript>
        # points at an unrelated /posts/tech/ news article about the
        # episode's guest/topic, not a real transcript page -- every genuine
        # transcript URL seen across SN/IM/TWiT lives under /posts/transcripts/.
        # Rejected here, at discovery, rather than after a wasted download:
        # treated the same as an episode with no transcript tag at all, so a
        # future run keeps retrying it instead of permanently caching wrong
        # content once TWiT's own feed metadata is eventually fixed upstream.
        if "/posts/transcripts/" not in transcript_url:
            continue
        if ep in found:
            continue  # keep the first (feed is newest-first) occurrence
        found[ep] = transcript_url

    if verbose:
        print(f"    {len(found)} episode(s) with a transcript in feed {feed_id}")

    return found


# ---------------------------------------------------------------------------
# Tech Brew Ride Home — parse the official RSS feed's own citation lists
# ---------------------------------------------------------------------------

# The feed's plain <description> has no markup at all -- the actual HTML
# with <a href> story links lives in <content:encoded> instead (the standard
# RSS content module). Found live, 2026-08-15: an initial version of
# fetch_tbrh_remote_listing() read <description> and silently extracted zero
# links from every one of 2390 episodes -- caught only by testing against
# the real feed rather than trusting the shape assumed from a manual look
# at a PowerShell-deserialized copy of the same item earlier in the session,
# which hadn't made the two-element distinction obvious.
_RSS_CONTENT_NS = {"content": "http://purl.org/rss/1.0/modules/content/"}


def fetch_tbrh_remote_listing(verbose: bool = False) -> Optional[dict[int, dict]]:
    """Fetch TBRH's official RSS feed and extract each episode's story-links
    citation list from its <content:encoded> — the only official source for
    this show (no transcript exists, confirmed live 2026-08-15). Episode
    identity: the feed has no episode numbers and no per-item <link>/<guid>
    (checked live against real feed content — both are empty on every item),
    so episodes are keyed by publish date (YYYYMMDD as int), the only stable
    identifier the feed actually provides. Returns
    {episode_int: {"title", "pubdate", "links": [...]}}, or None if the feed
    itself couldn't be fetched/parsed at all — a real outage, not zero new
    episodes, same distinction fetch_sn_remote_listing() makes."""
    if verbose:
        print("  Fetching Tech Brew Ride Home RSS feed…")

    data = http_get(TBRH_FEED_URL)
    if not data:
        print(f"    ERROR: could not fetch {TBRH_FEED_URL} — treating as a fetch "
              "failure, not zero new episodes.")
        return None

    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        print(f"    ERROR: could not parse TBRH feed XML: {e}")
        return None

    found: dict[int, dict] = {}
    for item in root.findall("./channel/item"):
        pubdate_el = item.find("pubDate")
        if pubdate_el is None or not (pubdate_el.text or "").strip():
            continue
        try:
            dt = email.utils.parsedate_to_datetime(pubdate_el.text)
        except (TypeError, ValueError):
            continue
        ep = int(dt.strftime("%Y%m%d"))
        if ep in found:
            continue  # keep the first (most recent, feed is newest-first) occurrence

        title_el = item.find("title")
        content_el = item.find("content:encoded", _RSS_CONTENT_NS)
        if content_el is None or not content_el.text:
            content_el = item.find("description")  # fall back if a future item lacks content:encoded
        extractor = _LinkExtractor()
        extractor.feed(content_el.text if content_el is not None and content_el.text else "")

        found[ep] = {
            "episode": ep,
            "title": title_el.text.strip() if title_el is not None and title_el.text else "",
            "pubdate": pubdate_el.text.strip(),
            "date": dt.date().isoformat(),  # human-readable form of `episode`, for citations
            "links": extractor.get_links(),
        }

    if verbose:
        total_links = sum(len(v["links"]) for v in found.values())
        print(f"    {len(found)} episode(s) in feed, {total_links} story link(s) total")

    # Machine-parseable marker — see the matching comment in fetch_sn_remote_listing.
    if found:
        print(f"LATEST_EPISODE tbrh {max(found)}")

    return found


# ---------------------------------------------------------------------------
# Dan Carlin (Hardcore History / Addendum / Common Sense) -- discover remote
# episodes from each show's own official RSS feed
# ---------------------------------------------------------------------------

def fetch_dancarlin_remote_listing(
    shows: list[str], verbose: bool = False
) -> dict[str, Optional[dict[int, dict]]]:
    """Fetch each requested Dan Carlin show's own RSS feed and return
    {show: {episode_int: {"url": enclosure_url, "name": enclosure_filename}}},
    or {show: None} for a show whose feed couldn't be fetched/parsed at all --
    a real outage, not zero new episodes, same distinction
    fetch_sn_remote_listing()/fetch_tbrh_remote_listing() make. Episode
    identity is each item's <itunes:episode> -- see the comment on
    DANCARLIN_FEEDS for why the enclosure filename itself isn't used for
    this (styled inconsistently across each show's real history)."""
    result: dict[str, Optional[dict[int, dict]]] = {}
    for show in shows:
        url = DANCARLIN_FEEDS[show]
        if verbose:
            print(f"  Fetching {SHOWS[show]['name']} RSS feed…")

        data = http_get(url)
        if not data:
            print(f"    ERROR: could not fetch {url} — treating as a fetch "
                  "failure, not zero new episodes.")
            result[show] = None
            continue

        try:
            root = ET.fromstring(data)
        except ET.ParseError as e:
            print(f"    ERROR: could not parse {SHOWS[show]['name']} feed XML: {e}")
            result[show] = None
            continue

        found: dict[int, dict] = {}
        for item in root.findall("./channel/item"):
            ep_el = item.find("itunes:episode", _ITUNES_NS)
            enc_el = item.find("enclosure")
            if ep_el is None or not (ep_el.text or "").strip() or enc_el is None:
                continue
            try:
                ep = int(ep_el.text.strip())
            except ValueError:
                continue
            enc_url = (enc_el.get("url") or "").strip()
            if not enc_url:
                continue
            name = unquote(urlsplit(enc_url).path.rsplit("/", 1)[-1])
            if not name:
                continue
            if ep in found:
                continue  # keep the first (feed is newest-first) occurrence
            found[ep] = {"url": enc_url, "name": name}

        if verbose:
            print(f"    {SHOWS[show]['name']}: {len(found)} episode(s) in feed")

        # Machine-parseable marker — see the matching comment in fetch_sn_remote_listing.
        if found:
            print(f"LATEST_EPISODE {show} {max(found)}")

        result[show] = found
    return result


# ---------------------------------------------------------------------------
# Local file scanning
# ---------------------------------------------------------------------------

def _local_sn_episodes(base_dir: Path, type_key: str) -> set[int]:
    cfg = SN_FILE_TYPES[type_key]
    d = base_dir / SHOWS["sn"]["subfolder"] / cfg["subfolder"]
    found: set[int] = set()
    if not d.exists():
        return found
    for f in d.iterdir():
        m = cfg["pattern"].match(f.name)
        if m:
            try:
                found.add(int(m.group(1)))
            except ValueError:
                pass
    return found


def _local_twit_episodes(base_dir: Path, show: str) -> set[int]:
    """Find locally saved transcript files for TWIG or IM."""
    d = base_dir / SHOWS[show]["subfolder"] / "transcripts"
    found: set[int] = set()
    if not d.exists():
        return found
    pat = re.compile(rf"{show}-(\d+)\.txt", re.IGNORECASE)
    for f in d.iterdir():
        m = pat.match(f.name)
        if m:
            try:
                found.add(int(m.group(1)))
            except ValueError:
                pass
    return found


def _local_tbrh_episodes(base_dir: Path) -> set[int]:
    """Find locally saved story-links JSON files for TBRH (keyed by
    YYYYMMDD, not a sequential episode number — see fetch_tbrh_remote_listing)."""
    d = base_dir / SHOWS["tbrh"]["subfolder"] / TBRH_FILE_TYPES["tbrh_links_json"]["subfolder"]
    found: set[int] = set()
    if not d.exists():
        return found
    pat = re.compile(r"tbrh-(\d{8})\.json", re.IGNORECASE)
    for f in d.iterdir():
        m = pat.match(f.name)
        if m:
            found.add(int(m.group(1)))
    return found


def _local_dancarlin_episodes(base_dir: Path, show: str) -> set[int]:
    """Find locally saved episode audio for a Dan Carlin show. Each show gets
    its own subfolder (see SHOWS), so a plain leading-digits prefix is
    unambiguous -- no need to also match the rest of the filename, which is
    styled inconsistently across this show family's real history."""
    d = base_dir / SHOWS[show]["subfolder"]
    found: set[int] = set()
    if not d.exists():
        return found
    pat = re.compile(r"^(\d+)-")
    for f in d.iterdir():
        m = pat.match(f.name)
        if m:
            try:
                found.add(int(m.group(1)))
            except ValueError:
                pass
    return found


def scan_local_files(
    base_dir: Path,
    show: str,
    type_keys: list[str],
    verbose: bool = False,
) -> dict[str, set[int]]:
    """Return {type_key: set(episode_ints)} for files already on disk."""
    result: dict[str, set[int]] = {}
    if show == "sn":
        for k in type_keys:
            result[k] = _local_sn_episodes(base_dir, k)
            if verbose:
                print(f"    {SN_FILE_TYPES[k]['description']}: "
                      f"{len(result[k])} local")
    elif show == "tbrh":
        eps = _local_tbrh_episodes(base_dir)
        result["tbrh_links_json"] = eps
        if verbose:
            print(f"    {SHOWS['tbrh']['name']} story links: {len(eps)} local")
    elif show in DANCARLIN_SHOWS:
        eps = _local_dancarlin_episodes(base_dir, show)
        result["dancarlin_audio_mp3"] = eps
        if verbose:
            print(f"    {SHOWS[show]['name']}: {len(eps)} local")
    else:
        key = f"{show}_transcript_txt"
        eps = _local_twit_episodes(base_dir, show)
        result[key] = eps
        if verbose:
            print(f"    {SHOWS[show]['name']} transcripts: {len(eps)} local")
    return result


# ---------------------------------------------------------------------------
# Episode number formatting
# ---------------------------------------------------------------------------

def fmt_sn(ep: int) -> str:
    return f"{ep:03d}" if ep < 1000 else str(ep)


# ---------------------------------------------------------------------------
# Build RemoteFile download list
# ---------------------------------------------------------------------------

def compute_missing(
    show: str,
    type_keys: list[str],
    base_dir: Path,
    remote_sn: Optional[dict[str, set[int]]],
    remote_twit: Optional[dict[str, Optional[dict[int, str]]]],
    local: dict[str, set[int]],
    episode_filter: Optional[set[int]],
    force: bool,
    verbose: bool = False,
    remote_tbrh: Optional[dict[int, dict]] = None,
    remote_dancarlin: Optional[dict[str, Optional[dict[int, dict]]]] = None,
    remote_sn_club: Optional[dict[int, str]] = None,
) -> list[RemoteFile]:
    missing: list[RemoteFile] = []

    for tk in type_keys:
        if show == "sn" and tk == "sn_transcript_club_txt":
            # Gap-fill only: never re-fetch an episode GRC's own txt already
            # covers, even under --force (force means "re-check the primary
            # source again," not "duplicate content GRC already gave us").
            # Scanned directly here rather than trusting local["sn_transcript_txt"]
            # -- that key only exists in `local` when the caller's own
            # type_keys happened to request GRC's txt type too (e.g. --types
            # all); a standalone `--types club` run would otherwise see an
            # empty set and wrongly think GRC covers nothing, re-fetching
            # everything the club feed has. Found live: exactly that (236
            # "missing" instead of ~2) on the first real dry-run of this path.
            remote_eps = set((remote_sn_club or {}).keys())
            local_eps = local.get(tk, set()) | _local_sn_episodes(base_dir, "sn_transcript_txt")
        elif show == "sn":
            cfg = SN_FILE_TYPES[tk]
            remote_eps = (remote_sn or {}).get(tk, set())
            local_eps = set() if force else local.get(tk, set())
        elif show == "tbrh":
            remote_eps = set((remote_tbrh or {}).keys())
            local_eps = set() if force else local.get(tk, set())
        elif show in DANCARLIN_SHOWS:
            dc_listing = (remote_dancarlin or {}).get(show) or {}
            remote_eps = set(dc_listing.keys())
            local_eps = set() if force else local.get(tk, set())
        else:
            # TWIG/IM/TWiT: one type key per show, episodes discovered via
            # the Club TWiT feed (see fetch_club_transcript_listing()). `or {}`
            # (not a .get default) is needed here because a failed fetch
            # stores an explicit None for this show, not a missing key.
            remote_map: dict[int, str] = (remote_twit or {}).get(show) or {}
            remote_eps = set(remote_map)
            local_eps = set() if force else local.get(tk, set())

        needed = remote_eps - local_eps
        if episode_filter:
            needed &= episode_filter

        for ep in sorted(needed):
            if show == "sn" and tk == "sn_transcript_club_txt":
                ep_str   = fmt_sn(ep)
                url      = (remote_sn_club or {})[ep]
                filename = SN_FILE_TYPES[tk]["filename_tmpl"].format(ep=ep_str)
                missing.append(RemoteFile(show=show, episode=ep,
                                          file_type=tk, url=url, filename=filename))
            elif show == "sn":
                ep_str   = fmt_sn(ep)
                url      = cfg["url_template"].format(ep=ep_str)
                filename = cfg["filename_tmpl"].format(ep=ep_str)
                missing.append(RemoteFile(show=show, episode=ep,
                                          file_type=tk, url=url, filename=filename))
            elif show == "tbrh":
                # No second HTTP round-trip needed -- fetch_tbrh_remote_listing()
                # already parsed everything out of the feed; the payload is
                # written straight to disk by _download_one().
                filename = TBRH_FILE_TYPES[tk]["filename_tmpl"].format(ep=ep)
                missing.append(RemoteFile(show=show, episode=ep, file_type=tk,
                                          url=TBRH_FEED_URL, filename=filename,
                                          payload=(remote_tbrh or {}).get(ep)))
            elif show in DANCARLIN_SHOWS:
                # Naming convention per direct request: leading episode
                # number, then the original enclosure filename verbatim --
                # e.g. dchh-Addendum26-Dig-This.mp3 -> 26-dchh-Addendum26-Dig-This.mp3.
                info = dc_listing[ep]
                filename = f"{ep}-{info['name']}"
                missing.append(RemoteFile(show=show, episode=ep, file_type=tk,
                                          url=info["url"], filename=filename))
            else:
                url      = remote_map[ep]
                filename = f"{show}-{ep:03d}.txt" if ep < 1000 else f"{show}-{ep}.txt"
                missing.append(RemoteFile(show=show, episode=ep,
                                          file_type=tk, url=url, filename=filename))

    if verbose:
        for tk in type_keys:
            count = sum(1 for r in missing if r.file_type == tk)
            if show == "sn":
                label = SN_FILE_TYPES[tk]["description"]
            elif show == "tbrh":
                label = TBRH_FILE_TYPES[tk]["description"]
            elif show in DANCARLIN_SHOWS:
                label = DANCARLIN_FILE_TYPES[tk]["description"]
            else:
                label = f"{SHOWS[show]['name']} transcript"
            print(f"    {label}: {count} to download")

    return missing


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def _dest_dir(base_dir: Path, rf: RemoteFile) -> Path:
    show_dir = base_dir / SHOWS[rf.show]["subfolder"]
    if rf.show == "sn":
        sub = SN_FILE_TYPES[rf.file_type]["subfolder"]
    elif rf.show == "tbrh":
        sub = TBRH_FILE_TYPES[rf.file_type]["subfolder"]
    elif rf.show in DANCARLIN_SHOWS:
        return show_dir  # each Dan Carlin show's own subfolder, no further nesting
    else:
        sub = "transcripts"
    return show_dir / sub


def _download_one(rf: RemoteFile, dest: Path) -> tuple[bool, str]:
    """Fetch rf.url, save to dest/rf.filename. Returns (ok, msg)."""
    if rf.payload is not None:
        # Already fetched and parsed during the remote-listing step (tbrh) --
        # no second HTTP round-trip, just serialize what's already in hand.
        try:
            (dest / rf.filename).write_text(
                json.dumps(rf.payload, indent=2, ensure_ascii=False), encoding="utf-8")
            return True, "ok"
        except OSError as e:
            return False, str(e)
    if rf.show == "sn" and rf.file_type != "sn_transcript_club_txt":
        # Binary download (PDF or TXT file) from GRC
        data = http_get(rf.url)
        if data is None:
            return False, f"request failed: {rf.url}"
        kind = SN_FILE_TYPES[rf.file_type]["validate"]
        if not validate_content(data, kind):
            return False, "unexpected content type"
        try:
            (dest / rf.filename).write_bytes(data)
            return True, "ok"
        except OSError as e:
            return False, str(e)
    elif rf.show in DANCARLIN_SHOWS:
        # Binary download (full episode audio -- no transcript exists)
        data = http_get(rf.url, timeout=180)  # up to ~180MB, GRC/twit.tv's 30s default is too tight
        if data is None:
            return False, f"request failed: {rf.url}"
        if not validate_content(data, "mp3"):
            return False, "unexpected content type (not a valid MP3)"
        try:
            (dest / rf.filename).write_bytes(data)
            return True, "ok"
        except OSError as e:
            return False, str(e)
    else:
        # TWiT-site transcript page (twig/im/twit, and sn's Club TWiT
        # gap-fill): fetch HTML, convert to text.
        data = http_get(rf.url)
        if data is None:
            return False, f"request failed: {rf.url}"
        html = data.decode("utf-8", errors="replace")
        text = html_to_text(html)
        if len(text) < 200:
            return False, "page too short — episode may not have a transcript yet"
        try:
            (dest / rf.filename).write_text(text, encoding="utf-8")
            return True, "ok"
        except OSError as e:
            return False, str(e)


def download_missing(
    missing: list[RemoteFile],
    base_dir: Path,
    stats: ShowStats,
    delay: float = DOWNLOAD_DELAY,
    verbose: bool = False,
    dry_run: bool = False,
) -> None:
    total = len(missing)
    if total == 0:
        print("  Nothing to download — already up to date.")
        return
    if dry_run:
        print(f"  [dry-run] {total} file(s) would be downloaded:")
        for rf in missing:
            print(f"    {rf.filename}")
        return
    print(f"  Downloading {total} file(s)…")

    for i, rf in enumerate(missing, 1):
        dest = _dest_dir(base_dir, rf)
        dest.mkdir(parents=True, exist_ok=True)

        prefix = f"  [{i}/{total}]"
        if verbose:
            print(f"{prefix} {rf.filename}  ←  {rf.url}")
        else:
            print(f"{prefix} {rf.filename}")

        ok, msg = _download_one(rf, dest)
        if ok:
            stats.downloaded += 1
        else:
            print(f"          ERROR: {msg}", file=sys.stderr)
            stats.failed += 1
            stats.failed_files.append(rf.filename)

        if i < total:
            time.sleep(delay)


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

def run(
    base_dir: Path,
    shows: list[str],
    type_selections: dict[str, list[str]],
    episode_filter: Optional[set[int]],
    force: bool,
    delay: float,
    verbose: bool,
    dry_run: bool = False,
) -> int:
    all_stats: list[ShowStats] = []
    exit_code = 0

    needs_sn        = "sn" in shows
    needs_club_shows = [s for s in shows if s in CLUB_FEED_ID and s != "sn"]
    needs_sn_club_fallback = needs_sn and "sn_transcript_club_txt" in type_selections.get("sn", [])
    needs_tbrh      = "tbrh" in shows
    needs_dancarlin = [s for s in shows if s in DANCARLIN_SHOWS]

    remote_sn        = None
    remote_twit: Optional[dict[str, Optional[dict[int, str]]]] = None
    remote_sn_club: Optional[dict[int, str]] = None
    remote_tbrh      = None
    remote_dancarlin = None

    # ── Fetch remote listings ────────────────────────────────────────────────
    if needs_sn:
        print(f"\n{'='*70}")
        print("Fetching Security Now! remote listing…")
        remote_sn = fetch_sn_remote_listing(type_selections["sn"], verbose)

    if needs_club_shows or needs_sn_club_fallback:
        print(f"\n{'='*70}")
        print("Fetching Club TWiT feed(s) for transcript discovery…")
        try:
            token = club_auth_token()
        except RuntimeError as e:
            print(f"    ERROR: {e}")
            token = None

        # Fetch each distinct feed id only once, even if it serves more than
        # one show (feed 9064 covers both "twig" and "im" -- see
        # fetch_club_transcript_listing()'s own docstring for why the split
        # belongs here, not in that function).
        raw_feeds: dict[str, Optional[dict[int, str]]] = {}
        if token:
            feed_ids_needed = {CLUB_FEED_ID[s] for s in needs_club_shows}
            if needs_sn_club_fallback:
                feed_ids_needed.add(CLUB_FEED_ID["sn"])
            for feed_id in sorted(feed_ids_needed):
                raw_feeds[feed_id] = fetch_club_transcript_listing(feed_id, token, verbose)

        remote_twit = {}
        for s in needs_club_shows:
            raw = raw_feeds.get(CLUB_FEED_ID[s])
            if raw is None:
                remote_twit[s] = None
                continue
            if s == "twig":
                eps = {ep: u for ep, u in raw.items() if ep <= TWIG_LAST_EP}
            elif s == "im":
                eps = {ep: u for ep, u in raw.items() if ep >= IM_FIRST_EP}
            else:  # twit -- feed 9066 is TWiT-only, no split needed
                eps = dict(raw)
            remote_twit[s] = eps
            # Machine-parseable marker — see the matching comment in
            # fetch_sn_remote_listing(); preserved per-show even though the
            # underlying fetch is now feed-based, since
            # hermes-podcast-sync.py's suppression logic keys off this line.
            if eps:
                print(f"LATEST_EPISODE {s} {max(eps)}")

        if needs_sn_club_fallback:
            # A club-feed hiccup here should never fail SN's whole run --
            # GRC remains the primary source and can succeed independently.
            # None just means zero gap-fill candidates this run, not a
            # show-level fetch_failed (see the per-show check below, which
            # deliberately doesn't look at remote_sn_club at all).
            remote_sn_club = raw_feeds.get(CLUB_FEED_ID["sn"])

    if needs_tbrh:
        print(f"\n{'='*70}")
        print("Fetching Tech Brew Ride Home RSS feed…")
        remote_tbrh = fetch_tbrh_remote_listing(verbose)

    if needs_dancarlin:
        print(f"\n{'='*70}")
        print("Fetching Dan Carlin RSS feed(s)…")
        remote_dancarlin = fetch_dancarlin_remote_listing(needs_dancarlin, verbose)

    # ── Per-show pipeline ────────────────────────────────────────────────────
    for show in shows:
        type_keys = type_selections[show]
        show_name = SHOWS[show]["name"]

        print(f"\n{'='*70}")
        print(f"Show: {show_name}")
        print(f"      Folder: {base_dir / SHOWS[show]['subfolder']}")

        if verbose:
            print("  Scanning local files…")
        local = scan_local_files(base_dir, show, type_keys, verbose)

        stats = ShowStats(show=show)
        # Count files that are already local
        if show == "sn":
            stats.already_local = sum(len(v) for v in local.values())
        else:
            stats.already_local = len(next(iter(local.values()), set()))

        # Detect a total fetch failure for this show's remote listing (see
        # fetch_sn_remote_listing()/_probe_twit_episodes()) before computing
        # "missing" from it — otherwise a None here reads through
        # compute_missing() as "zero remote episodes," which then reports as
        # a clean "already up to date" instead of the real fetch failure it
        # is. Security-review fix.
        if show == "sn":
            fetch_failed = remote_sn is None
        elif show == "tbrh":
            fetch_failed = remote_tbrh is None
        elif show in DANCARLIN_SHOWS:
            fetch_failed = remote_dancarlin is None or remote_dancarlin.get(show) is None
        else:
            fetch_failed = remote_twit is None or remote_twit.get(show) is None

        if fetch_failed:
            print(f"  ERROR: could not determine {show_name}'s remote episode list "
                  "this run — skipping (not reporting a false 'up to date').")
            stats.fetch_failed = True
            all_stats.append(stats)
            exit_code = 1
            continue

        if verbose:
            print("  Computing missing files…")
        missing = compute_missing(
            show=show, type_keys=type_keys, base_dir=base_dir,
            remote_sn=remote_sn, remote_twit=remote_twit,
            local=local, episode_filter=episode_filter,
            force=force, verbose=verbose, remote_tbrh=remote_tbrh,
            remote_dancarlin=remote_dancarlin, remote_sn_club=remote_sn_club,
        )

        remote_total = stats.already_local + len(missing)
        print(f"  Remote: {remote_total} known | "
              f"Local: {stats.already_local} | To download: {len(missing)}")

        download_missing(missing, base_dir, stats, delay=delay, verbose=verbose, dry_run=dry_run)
        all_stats.append(stats)
        if stats.failed:
            exit_code = 1

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    total_dl = total_fail = 0
    for s in all_stats:
        print(f"\n{SHOWS[s.show]['name']}:")
        if s.fetch_failed:
            print("  REMOTE FETCH FAILED — could not determine this show's remote "
                  "episode list this run; nothing was checked or downloaded.")
            continue
        print(f"  Already local:  {s.already_local}")
        print(f"  Downloaded:     {s.downloaded}")
        print(f"  Failed:         {s.failed}")
        if s.failed_files:
            print("  Failed files:")
            for fn in s.failed_files:
                print(f"    - {fn}")
        total_dl   += s.downloaded
        total_fail += s.failed

    print(f"\n{'='*70}")
    print(f"Total downloaded: {total_dl}   Total failed: {total_fail}")
    print(f"Files saved to:   {base_dir}")
    print(f"{'='*70}")
    return exit_code


# ---------------------------------------------------------------------------
# Episode range parser
# ---------------------------------------------------------------------------

def parse_episode_range(s: str) -> set[int]:
    eps: set[int] = set()
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = part.split("-", 1)
            eps.update(range(int(lo), int(hi) + 1))
        else:
            eps.add(int(part))
    return eps


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        prog="hermes-podcast-retriever.py",
        description=(
            "Download transcripts / show notes / story-links / episode audio for "
            "Security Now!, This Week in Google, Intelligent Machines, This Week "
            "in Tech, Tech Brew Ride Home, and Dan Carlin's shows."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
shows:
  sn     Security Now!        (GRC.com primary — notes PDF, transcript PDF/TXT;
                               plus a Club TWiT feed fallback for episodes GRC
                               never published, see --types club below)
  twig   This Week in Google  (Club TWiT feed 9064 — HTML transcripts saved
                               as .txt, eps 1-804; discontinued, no new
                               episodes, kept for on-demand backfill only)
  im     Intelligent Machines (Club TWiT feed 9064 — HTML transcripts saved
                               as .txt, eps 805+)
  twit   This Week in Tech    (Club TWiT feed 9066 — HTML transcripts saved
                               as .txt)
  tbrh   Tech Brew Ride Home  (official RSS feed — per-episode story-links JSON;
                               no transcript exists for this show. Episodes are
                               keyed by publish date, YYYYMMDD, not a sequential
                               number.)
  dchh   Hardcore History           (official RSS feed — full episode audio, MP3;
  dchha  Hardcore History: Addendum  no transcript exists for any of these three.
  dccs   Common Sense                Filenames are prefixed with the episode
                               number per direct request, e.g.
                               26-dchh-Addendum26-Dig-This.mp3.)

Club TWiT shows (sn's fallback, twig, im, twit) require a Vaultwarden item
named twit-club-auth (field "password") holding the feed auth token --
see club_auth_token().

file types for --types:
  sn:              notes  pdf  txt  club  all  (club = Club TWiT fallback,
                                                 only for episodes GRC lacks)
  twig/im/twit:    transcript  all
  tbrh:            links  all
  dchh/dchha/dccs: audio  all

examples:
  # Download everything for all shows
  %(prog)s --outputdir /mnt/nas2-hermes-backup/PodCasts

  # Only Intelligent Machines transcripts, verbose
  %(prog)s --outputdir /mnt/nas2-hermes-backup/PodCasts --shows im -v

  # Only SN show-notes PDFs for a specific episode range
  %(prog)s --outputdir /mnt/nas2-hermes-backup/PodCasts --shows sn --types notes --episodes 900-950

  # Re-download regardless of what's already local
  %(prog)s --outputdir /mnt/nas2-hermes-backup/PodCasts --shows im --force

  # Only Tech Brew Ride Home story links for a specific date range
  %(prog)s --outputdir /mnt/nas2-hermes-backup/PodCasts --shows tbrh --episodes 20260801-20260814

  # Dan Carlin shows, into RAGDocs rather than the usual PodCasts root
  %(prog)s --outputdir /mnt/nas2-hermes-backup/RAGDocs --shows dchh dchha dccs

  # Preview what a run would fetch without downloading anything
  %(prog)s --outputdir /mnt/nas2-hermes-backup/RAGDocs --shows dchh dchha dccs --dry-run -v
        """,
    )

    parser.add_argument("--outputdir", "-o", required=True, metavar="DIR",
        help="Base directory; show-specific subfolders are created inside it")
    parser.add_argument("--shows", nargs="+",
        choices=["sn", "twig", "im", "twit", "tbrh", "dchh", "dchha", "dccs", "all"],
        default=["all"], metavar="SHOW",
        help="Shows to process (default: all)")
    parser.add_argument("--types", nargs="+", default=["all"], metavar="TYPE",
        help="File types: SN → notes pdf txt club all | TWIG/IM/TWiT → transcript all | "
             "TBRH → links all | Dan Carlin shows → audio all")
    parser.add_argument("--episodes", default=None, metavar="RANGE",
        help='Episode filter, e.g. "805-860" or "805,810,820"')
    parser.add_argument("--force", action="store_true",
        help="Re-download all files even if they already exist locally")
    parser.add_argument("--delay", type=float, default=DOWNLOAD_DELAY, metavar="SEC",
        help=f"Seconds between downloads (default: {DOWNLOAD_DELAY})")
    parser.add_argument("--dry-run", action="store_true",
        help="Show what would be downloaded without downloading anything")
    parser.add_argument("--verbose", "-v", action="store_true",
        help="Verbose output")

    args = parser.parse_args()

    shows: list[str] = (
        ["sn", "twig", "im", "twit", "tbrh", *DANCARLIN_SHOWS] if "all" in args.shows
        else list(dict.fromkeys(args.shows))
    )

    # Resolve file types per show
    type_selections: dict[str, list[str]] = {}
    for show in shows:
        avail = SHOW_TYPE_MAP[show]
        selected: set[str] = set()
        for t in args.types:
            if t in avail:
                selected.update(avail[t])
        if not selected:  # default to 'all'
            selected = set(avail["all"])
        type_selections[show] = sorted(selected)

    episode_filter: Optional[set[int]] = None
    if args.episodes:
        try:
            episode_filter = parse_episode_range(args.episodes)
        except ValueError as e:
            print(f"Error parsing --episodes: {e}", file=sys.stderr)
            return 1

    base_dir = Path(args.outputdir).expanduser().resolve()
    base_dir.mkdir(parents=True, exist_ok=True)

    return run(
        base_dir=base_dir,
        shows=shows,
        type_selections=type_selections,
        episode_filter=episode_filter,
        force=args.force,
        delay=args.delay,
        verbose=args.verbose,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    sys.exit(main())
