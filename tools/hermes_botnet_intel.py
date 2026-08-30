#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes_botnet_intel.py — Shared botnet/C2 threat-intel cache: schema, sync,
and lookup. Used by hermes-botnet-intel-sync.py (the daily refresh job) and
imported directly by hermes-canary-report.py and hermes-pfsense-report.py
so both can answer, from real data: are we being attacked by known-bad
infrastructure, and is anything inside the LAN reaching out to it.

Phase 25 (IMPLEMENTATION_PLAN.md §7). v1 documented this exact design
(skills/pfsense-network/SKILL.md, skills/security/canary-monitor/SKILL.md,
skills/security/node-probe/SKILL.md, skills/pfsense-network/references/
public_cc_spam_sources.md all reference `~/.hermes/data/botnet/
botnet_cache.db` + `cache_botnet_feeds.py` + `botnet_query.py`) but the
actual scripts were never committed anywhere in the v1 repo, and no trace
of them survives on the Spark's filesystem either (checked live, including
the pre-migration `.hermes.pre-encrypt` backup) — only the design and feed
list survive. Rebuilt from that spec rather than ported, since there was
no code left to port. All four sources are public, keyless, and confirmed
live and reachable 2026-08-12 before writing any parsing code:
  - Spamhaus DROP (https://www.spamhaus.org/drop/drop.txt) — hijacked/leased
    netblocks used exclusively for cybercrime. CIDR ranges. v1's doc claims
    EDROP is merged into this file; confirmed current live download is a
    single combined list.
  - Spamhaus DROPv6 (dropv6.txt) — same, IPv6 CIDR ranges.
  - abuse.ch Feodo Tracker (feodotracker.abuse.ch/downloads/ipblocklist.txt)
    — individual IPs, currently-active botnet C2 servers (Dridex/TrickBot/
    QakBot-class). High precision, purpose-built for exactly this
    cross-reference use case.
  - TweetFeed (api.tweetfeed.live/v1/today/ip) — community/OSINT-sourced
    IOCs. Included as a separate, lower "community" confidence tier rather
    than blended with the curated feeds above — unlike Spamhaus/Feodo,
    this is unvetted crowd-sourced data, and this project has hit false
    positives before from treating a heuristic as equally authoritative
    everywhere it's used (see hermes-pfsense-report.py's CDN-backscatter
    finding). Reports built on this module should call out which tier a
    match came from, not treat every hit as equally certain.

abuse.ch URLhaus deliberately NOT ingested: v1's own doc already labels it
"Plaintext/URLs only", and it is — a feed of malicious URLs/hostnames, not
an IP list, so most entries can't be usefully cross-referenced against
pfSense's IP-keyed filterlog or a honeypot's raw connection source IP.
Revisit only if a URL/hostname-keyed use case shows up.

Cache lives at ~/.hermes/data/botnet/botnet_cache.db (SQLite) — "data", not
"state", deliberately: this is fetched, replaceable content (this fleet's
local mirror of public feeds), not a record of this tool's own run history.
Every sync fully replaces each source's rows (the live feed IS the truth;
an IP that drops off a feed is no longer considered listed) while
preserving first_seen for anything still present, so "how long has this
been flagged" stays meaningful across syncs.
"""
import ipaddress
import sqlite3
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path.home() / ".hermes" / "data" / "botnet" / "botnet_cache.db"

HEADERS = {"User-Agent": "hermes-botnet-intel/1.0 (home fleet threat-intel sync)"}

SPAMHAUS_DROP_URL = "https://www.spamhaus.org/drop/drop.txt"
SPAMHAUS_DROPV6_URL = "https://www.spamhaus.org/drop/dropv6.txt"
FEODO_URL = "https://feodotracker.abuse.ch/downloads/ipblocklist.txt"
TWEETFEED_URL = "https://api.tweetfeed.live/v1/today/ip"

CONFIDENCE_HIGH = "high"          # curated, purpose-built, low false-positive
CONFIDENCE_COMMUNITY = "community"  # OSINT/crowd-sourced, unvetted

SOURCE_LABELS = {
    "spamhaus_drop": "Spamhaus DROP",
    "spamhaus_dropv6": "Spamhaus DROPv6",
    "feodo": "abuse.ch Feodo Tracker (active botnet C2)",
    "tweetfeed": "TweetFeed (community OSINT)",
}


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS botnet_ips (
            ip TEXT NOT NULL,
            source TEXT NOT NULL,
            tag TEXT,
            confidence TEXT NOT NULL,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            PRIMARY KEY (ip, source)
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS botnet_cidrs (
            cidr TEXT NOT NULL,
            source TEXT NOT NULL,
            tag TEXT,
            confidence TEXT NOT NULL,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            PRIMARY KEY (cidr, source)
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS sync_log (
            source TEXT PRIMARY KEY,
            last_success_utc TEXT,
            last_attempt_utc TEXT,
            last_error TEXT,
            entry_count INTEGER
        )
    """)
    return con


def _http_get_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


# ── feed parsers: each returns [(key, tag), ...] ────────────────────────────

def _parse_spamhaus(text: str) -> list:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        parts = line.split(";")
        cidr = parts[0].strip()
        tag = parts[1].strip() if len(parts) > 1 else ""
        if cidr:
            out.append((cidr, tag))
    return out


def _parse_feodo(text: str) -> list:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append((line, "active C2"))
    return out


def _parse_tweetfeed(raw_json: str) -> list:
    import json
    out = []
    try:
        entries = json.loads(raw_json)
    except json.JSONDecodeError:
        return out
    for e in entries:
        if e.get("type") != "ip":
            continue
        ip = (e.get("value") or "").strip()
        if not ip:
            continue
        tags = ",".join(e.get("tags") or []) or "unlabeled"
        out.append((ip, tags))
    return out


# ── sync ─────────────────────────────────────────────────────────────────

def _replace_source(con, table: str, source: str, entries: list, now: str):
    """Full replace-per-source: delete this source's old rows, re-insert from
    the fresh fetch, carrying forward first_seen for anything still present
    (via INSERT OR REPLACE against a pre-read first_seen map) — so
    "how long has this IP been listed" survives across syncs instead of
    resetting to "today" every run.

    Deduped by key first: a real live Spamhaus DROP pull (2026-08-12) had
    one CIDR (62.60.226.0/24) listed twice under two different SBL
    reference IDs on separate lines — a genuine upstream data quirk, not a
    parsing bug, confirmed by fetching and diffing the raw feed directly.
    Last occurrence wins; multiple tags for the same key are joined rather
    than silently dropped, so nothing about the duplicate is lost."""
    col = "ip" if table == "botnet_ips" else "cidr"
    existing = dict(con.execute(f"SELECT {col}, first_seen FROM {table} WHERE source = ?",
                                 (source,)).fetchall())
    con.execute(f"DELETE FROM {table} WHERE source = ?", (source,))
    confidence = CONFIDENCE_COMMUNITY if source == "tweetfeed" else CONFIDENCE_HIGH

    deduped: dict = {}
    for key, tag in entries:
        if key in deduped and tag and tag not in deduped[key].split(", "):
            deduped[key] = f"{deduped[key]}, {tag}"
        else:
            deduped.setdefault(key, tag)

    rows = [
        (key, source, tag, confidence, existing.get(key, now), now)
        for key, tag in deduped.items()
    ]
    con.executemany(
        f"INSERT INTO {table} (\"{col}\", source, tag, confidence, first_seen, last_seen) "
        f"VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )


def sync() -> dict:
    """Fetch every feed and rebuild the cache. Returns {source: result} where
    result is either {"ok": True, "count": N} or {"ok": False, "error": str}.
    A feed that fails leaves that source's *previous* rows in place (not
    wiped) — better to serve slightly stale data for one source than to
    silently go blind on it because of a transient fetch failure."""
    con = _connect()
    now = datetime.now(timezone.utc).isoformat()
    results = {}

    fetchers = [
        ("spamhaus_drop", "botnet_cidrs", lambda: _parse_spamhaus(_http_get_text(SPAMHAUS_DROP_URL))),
        ("spamhaus_dropv6", "botnet_cidrs", lambda: _parse_spamhaus(_http_get_text(SPAMHAUS_DROPV6_URL))),
        ("feodo", "botnet_ips", lambda: _parse_feodo(_http_get_text(FEODO_URL))),
        ("tweetfeed", "botnet_ips", lambda: _parse_tweetfeed(_http_get_text(TWEETFEED_URL))),
    ]

    for source, table, fetch in fetchers:
        try:
            entries = fetch()
            _replace_source(con, table, source, entries, now)
            con.execute("""
                INSERT INTO sync_log (source, last_success_utc, last_attempt_utc, last_error, entry_count)
                VALUES (?, ?, ?, NULL, ?)
                ON CONFLICT(source) DO UPDATE SET
                    last_success_utc = excluded.last_success_utc,
                    last_attempt_utc = excluded.last_attempt_utc,
                    last_error = NULL,
                    entry_count = excluded.entry_count
            """, (source, now, now, len(entries)))
            con.commit()
            results[source] = {"ok": True, "count": len(entries)}
        except Exception as e:
            con.execute("""
                INSERT INTO sync_log (source, last_success_utc, last_attempt_utc, last_error, entry_count)
                VALUES (?, NULL, ?, ?, NULL)
                ON CONFLICT(source) DO UPDATE SET
                    last_attempt_utc = excluded.last_attempt_utc,
                    last_error = excluded.last_error
            """, (source, now, str(e)))
            con.commit()
            results[source] = {"ok": False, "error": str(e)}

    con.close()
    return results


# ── lookup ───────────────────────────────────────────────────────────────

def cache_age_hours() -> float | None:
    """Hours since the oldest *successful* sync among all sources, or None
    if the cache has never synced at all. Callers should treat a None or
    very large value as "the cache can't be trusted right now" rather than
    silently reporting a clean lookup as if it were meaningful."""
    if not DB_PATH.exists():
        return None
    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT last_success_utc FROM sync_log").fetchall()
    con.close()
    timestamps = [datetime.fromisoformat(r[0]) for r in rows if r[0]]
    if not timestamps:
        return None
    oldest = min(timestamps)
    return (datetime.now(timezone.utc) - oldest).total_seconds() / 3600


def lookup_ip(ip: str, _cidr_cache: dict = {}) -> list:
    """Return a list of match dicts for `ip`: [{"source", "label", "tag",
    "confidence"}, ...] — empty list means no match in any feed. Checks
    exact-IP tables first (cheap), then tests membership against every
    cached CIDR (Spamhaus DROP/DROPv6 total a few thousand ranges — a full
    per-call scan is fine at the call volumes these reports run at, tens of
    distinct IPs per run, not a hot path)."""
    if not DB_PATH.exists():
        return []
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return []

    con = sqlite3.connect(DB_PATH)
    matches = []

    for row in con.execute("SELECT source, tag, confidence FROM botnet_ips WHERE ip = ?", (ip,)):
        source, tag, confidence = row
        matches.append({"source": source, "label": SOURCE_LABELS.get(source, source),
                         "tag": tag, "confidence": confidence})

    # CIDR membership: cache parsed networks per-process (module-level dict
    # keyed by DB path) so a report checking many IPs in one run only pays
    # the CIDR-parse cost once, not once per IP.
    cache_key = str(DB_PATH)
    if cache_key not in _cidr_cache:
        nets = []
        for cidr, source, tag, confidence in con.execute(
            "SELECT cidr, source, tag, confidence FROM botnet_cidrs"
        ):
            try:
                nets.append((ipaddress.ip_network(cidr, strict=False), source, tag, confidence))
            except ValueError:
                continue
        _cidr_cache[cache_key] = nets

    for net, source, tag, confidence in _cidr_cache[cache_key]:
        if addr.version == net.version and addr in net:
            matches.append({"source": source, "label": SOURCE_LABELS.get(source, source),
                             "tag": tag, "confidence": confidence})

    con.close()
    return matches


def lookup_many(ips) -> dict:
    """{ip: [matches]} for every ip in `ips` that has at least one match —
    clean IPs are simply absent from the result, not present with an empty list."""
    result = {}
    for ip in ips:
        m = lookup_ip(ip)
        if m:
            result[ip] = m
    return result
