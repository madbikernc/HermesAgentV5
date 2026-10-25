#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-24) - S38c: tags.yaml-driven thematic categorization. New `tags` subcommand and
# apply_tags()/load_tags() below, folded into `daily`. The `tags` table is wiped and rebuilt in
# full on every run -- MARKET_WATCH_DESIGN.md §5's own schema comment: "re-derived from
# tags.yaml each sync, not hand-edited per row."
#
# 1.0.0 (2026-10-24) - S38b: instruments/prices sync. Refreshes instrument/sector data from
# Wikipedia's S&P 500 constituents table and daily OHLCV from Yahoo's unofficial chart endpoint
# (MARKET_WATCH_DESIGN.md §2, both verified live 2026-10-21 under S38a). Writes
# instruments/prices/sync_state in /mnt/hermes-data/market/market.db via
# hermes_market_common.connect().
#
# ── Wikitable parsing is pure stdlib, not bs4 ──
# hermes-nfsensei-watch.py already uses bs4 on the real deploy host, so it would not have been a
# new fleet-wide dependency -- but hermes-feed-reader.py's own header already states this fleet's
# preference for stdlib parsing over an extra library when ElementTree/HTMLParser can do the job
# (feedparser there, bs4 here), and every test file in this repo states "runs anywhere Python 3
# does" as a real guarantee, not aspiration. bs4 is not installed on this session's own dev
# machine. A small HTMLParser subclass below (_TableExtractor) does the one thing needed --
# pull every row out of <table id="constituents">, nested-table-safe -- with zero new dependency.
#
# ── Egress-guard note, a decision recorded rather than a silent gap ──
# The Yahoo/Wikipedia fetches below are NOT wrapped in hermes_egress_guard.check_destination().
# Confirmed against the real precedent: tools/hermes-feed-reader.py's own fetch() isn't wrapped
# either (grepped, zero matches) -- infra/firmament-tool-registry.yaml's own header states Phase
# A egress-guard coverage is scoped to the specific call sites EGRESS_GUARD_DESIGN.md §5 named,
# not every external caller fleet-wide. Revisit only if that scope is ever widened fleet-wide,
# the same open follow-up the registry file already names for itself.
#
# ── to_yahoo_symbol() is unverified until live-tested ──
# The dotted-to-dashed multi-class ticker mapping (BRK.B -> BRK-B) is a widely-documented
# convention for this endpoint, not something this session has confirmed live. S38f's live
# verification step must check it against a real multi-class ticker before the full S&P 500
# universe is trusted to sync correctly.
#
# Config (environment):
#   MARKET_DB          as hermes_market_common.py defines it (default /mnt/hermes-data/market/market.db)
#   TAGS_PATH          default infra/hermes-market-sync/tags.yaml
#
# Usage:
#   hermes-market-sync.py instruments [--dry-run]
#   hermes-market-sync.py tags [--dry-run]
#   hermes-market-sync.py prices [--dry-run] [--only SYM1,SYM2] [--backfill-days N]
#   hermes-market-sync.py daily [--dry-run]                 # what the .service runs
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO_DIR = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import hermes_market_common as common  # noqa: E402

WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

# The single trading-calendar watermark key for sync_state/instruments. Deliberately NOT Yahoo's
# finer per-listing exchange code (NMS for Nasdaq, NYQ for NYSE) -- MARKET_WATCH_DESIGN.md §6:
# the MVP has exactly one covered calendar (NYSE/Nasdaq), so every S&P 500 row shares one
# watermark. Splitting by listing code would wrongly fragment one calendar into two.
EXCHANGE = "US"

CATCHUP_WINDOW_DAYS = 5  # normal daily sync range per ticker

TAGS_PATH = Path(os.environ.get(
    "TAGS_PATH", str(REPO_DIR / "infra" / "hermes-market-sync" / "tags.yaml")))
VALID_MATCH_TYPES = {"sector", "ticker", "keyword"}

USER_AGENT = ("Mozilla/5.0 (compatible; HermesMarketWatch/1.0; "
              "+https://github.com/madbikernc/HermesAgentV5)")

_FOOTNOTE_RE = re.compile(r"\[\d+\]")


def log(msg):
    print(f"[hermes-market-sync] {msg}", flush=True)


# ── fetch boundary -- the exact two functions a test monkeypatches directly ────────────────────

def fetch_html(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


# ── Wikipedia S&P 500 constituents table ────────────────────────────────────────────────────────

class _TableExtractor(HTMLParser):
    """Pulls every row of <table id="constituents"> into a list of cell-text lists. Nested-table
    safe: a table stack, not a bare flag, so a sub-table inside a cell of the target table (or
    anywhere else on the page) cannot leak rows into the result."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._table_stack = []
        self._row = None
        self._cell = None
        self.rows = []

    @property
    def _in_target(self):
        return bool(self._table_stack) and self._table_stack[-1]

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._table_stack.append(dict(attrs).get("id") == "constituents")
        elif tag == "tr" and self._in_target:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag == "table" and self._table_stack:
            self._table_stack.pop()
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None
        elif tag in ("td", "th") and self._cell is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _strip_footnote(text):
    return _FOOTNOTE_RE.sub("", text or "").strip()


def parse_sp500_wikitable(html_text):
    """Returns (rows, bad): rows is [{"ticker", "name", "sector", "industry"}, ...], bad is a
    list of problem descriptions. A row missing a required cell is skipped and reported, never
    fatal -- same discipline hermes-feed-reader.py's load_feeds() uses for a malformed line.
    Column positions are resolved from the real header row rather than hardcoded indices, so a
    Wikipedia column reorder degrades to a clear error instead of silently misreading data."""
    extractor = _TableExtractor()
    extractor.feed(html_text)
    if not extractor.rows:
        raise ValueError("no table#constituents found -- Wikipedia's page shape may have changed")

    header = [c.strip().lower() for c in extractor.rows[0]]

    def col(*names):
        for name in names:
            if name in header:
                return header.index(name)
        return None

    idx = {
        "symbol": col("symbol"),
        "security": col("security", "company"),
        "gics sector": col("gics sector"),
        "gics sub-industry": col("gics sub-industry", "gics sub industry"),
    }
    missing = [name for name, i in idx.items() if i is None]
    if missing:
        raise ValueError(f"expected columns not found in header {header!r}: {missing}")

    rows, bad = [], []
    max_needed = max(idx.values())
    for lineno, cells in enumerate(extractor.rows[1:], 2):
        if len(cells) <= max_needed:
            bad.append(f"row {lineno}: expected at least {max_needed + 1} cells, got {len(cells)}")
            continue
        ticker = _strip_footnote(cells[idx["symbol"]])
        name = _strip_footnote(cells[idx["security"]])
        sector = _strip_footnote(cells[idx["gics sector"]])
        industry = _strip_footnote(cells[idx["gics sub-industry"]])
        if not ticker or not name:
            bad.append(f"row {lineno}: missing ticker or name {cells!r}")
            continue
        rows.append({"ticker": ticker, "name": name, "sector": sector or None, "industry": industry or None})
    return rows, bad


def to_yahoo_symbol(ticker):
    """Wikipedia's canonical ticker (kept as the DB key, dot intact -- e.g. BRK.B) vs. the
    dashed form Yahoo's chart endpoint is documented to want (BRK-B). See the header note above:
    unverified until S38f's live check."""
    return ticker.replace(".", "-")


def refresh_instruments(conn, dry_run=False):
    """Upsert by (ticker, exchange), preserving first_seen and bumping last_seen. A ticker
    dropped from the live Wikipedia table is never deleted -- its last_seen simply stops
    advancing, so its price history stays queryable."""
    rows, bad = parse_sp500_wikitable(fetch_html(WIKI_URL))
    now = datetime.now(timezone.utc).date().isoformat()
    if not dry_run:
        for r in rows:
            conn.execute("""
                INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen)
                VALUES (?, ?, ?, 'USD', ?, ?, ?, ?)
                ON CONFLICT(ticker, exchange) DO UPDATE SET
                    name=excluded.name, sector=excluded.sector, industry=excluded.industry,
                    last_seen=excluded.last_seen
            """, (r["ticker"], EXCHANGE, r["name"], r["sector"], r["industry"], now, now))
        conn.commit()
    return len(rows), bad


# ── tags.yaml thematic categorization (S38c) ────────────────────────────────────────────────────

def load_tags(path=None):
    """`tag | match_type | pattern` per line, # comments and blanks ignored. No YAML is parsed --
    same precedent as feeds.yaml/topics.yaml. A malformed line or unknown match_type is reported
    and skipped, never fatal."""
    path = Path(path or TAGS_PATH)
    rules, bad = [], []
    if not path.is_file():
        return rules, [f"{path} does not exist"]
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 3 or not all(parts):
            bad.append(f"line {lineno}: expected 'tag | match_type | pattern', got {raw!r}")
            continue
        tag, match_type, pattern = parts
        if match_type not in VALID_MATCH_TYPES:
            bad.append(f"line {lineno}: match_type must be one of "
                       f"{sorted(VALID_MATCH_TYPES)}, got {match_type!r}")
            continue
        rules.append((tag, match_type, pattern))
    return rules, bad


def apply_tags(conn, dry_run=False):
    """Wipes and rebuilds the whole `tags` table from tags.yaml every run -- it is re-derived
    config, never hand-edited per row (MARKET_WATCH_DESIGN.md §5)."""
    rules, bad = load_tags()
    pairs = set()
    for tag, match_type, pattern in rules:
        if match_type == "ticker":
            found = conn.execute(
                "SELECT ticker, exchange FROM instruments WHERE ticker=?", (pattern,)).fetchall()
        elif match_type == "sector":
            found = conn.execute("""
                SELECT ticker, exchange FROM instruments
                WHERE sector = ? COLLATE NOCASE OR industry = ? COLLATE NOCASE
            """, (pattern, pattern)).fetchall()
        else:  # keyword
            found = conn.execute("""
                SELECT ticker, exchange FROM instruments
                WHERE lower(name || ' ' || coalesce(sector,'') || ' ' || coalesce(industry,'')) LIKE ?
            """, (f"%{pattern.lower()}%",)).fetchall()
        for ticker, exchange in found:
            pairs.add((ticker, exchange, tag))
    if not dry_run:
        conn.execute("DELETE FROM tags")
        conn.executemany("INSERT OR IGNORE INTO tags (ticker, exchange, tag) VALUES (?,?,?)", pairs)
        conn.commit()
    return len(pairs), bad


# ── Yahoo chart endpoint -- daily prices ────────────────────────────────────────────────────────

def parse_yahoo_chart(payload, ticker):
    """Returns [(date_iso, open, high, low, close, adj_close, volume), ...]. Raises ValueError on
    a Yahoo-reported error or a missing/empty result; the caller treats that as this ticker's own
    isolated failure. A null tick (a real gap Yahoo itself returns, not a parsing bug) is
    skipped, never fabricated as zero."""
    chart = payload.get("chart") or {}
    err = chart.get("error")
    if err:
        raise ValueError(f"Yahoo reported an error for {ticker}: {err}")
    results = chart.get("result") or []
    if not results:
        raise ValueError(f"no result in Yahoo chart response for {ticker}")
    result = results[0]
    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators") or {}
    quotes = (indicators.get("quote") or [{}])[0]
    adjcloses = (indicators.get("adjclose") or [{}])[0].get("adjclose") or []
    opens = quotes.get("open") or []
    highs = quotes.get("high") or []
    lows = quotes.get("low") or []
    closes = quotes.get("close") or []
    volumes = quotes.get("volume") or []

    out = []
    for i, ts in enumerate(timestamps):
        close = closes[i] if i < len(closes) else None
        if close is None:
            continue
        date_iso = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        adj = adjcloses[i] if i < len(adjcloses) else None
        out.append((
            date_iso,
            opens[i] if i < len(opens) else None,
            highs[i] if i < len(highs) else None,
            lows[i] if i < len(lows) else None,
            close,
            adj if adj is not None else close,
            volumes[i] if i < len(volumes) else None,
        ))
    return out


def _tickers_to_sync(conn, only=None):
    if only:
        return [t.strip().upper() for t in only]
    return [r[0] for r in conn.execute(
        "SELECT ticker FROM instruments WHERE exchange=? ORDER BY ticker", (EXCHANGE,)).fetchall()]


def sync_prices(conn, only=None, backfill_days=None, dry_run=False):
    """Per-ticker try/except isolates one failure from the rest of the run. sync_state.last_error
    is set (and last_synced_date does NOT advance) whenever any ticker failed, so a bad run can
    never look identical to a clean one on the next day's retry -- the same honesty split
    hermes-news-digest.py's own "nothing new" vs. "could not check" distinction models."""
    tickers = _tickers_to_sync(conn, only)
    rng = f"{backfill_days}d" if backfill_days else f"{CATCHUP_WINDOW_DAYS}d"
    ok, failed, rows_written = 0, [], 0

    for ticker in tickers:
        try:
            url = YAHOO_CHART_URL.format(symbol=to_yahoo_symbol(ticker)) + f"?range={rng}&interval=1d"
            parsed = parse_yahoo_chart(fetch_json(url), ticker)
        except Exception as exc:
            failed.append((ticker, f"{type(exc).__name__}: {exc}"))
            continue
        ok += 1
        if dry_run:
            continue
        for date_iso, o, h, l, c, adj, vol in parsed:
            cur = conn.execute("""
                INSERT INTO prices (ticker, exchange, date, open, high, low, close, adj_close, volume)
                VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(ticker, exchange, date) DO UPDATE SET
                    open=excluded.open, high=excluded.high, low=excluded.low,
                    close=excluded.close, adj_close=excluded.adj_close, volume=excluded.volume
            """, (ticker, EXCHANGE, date_iso, o, h, l, c, adj, vol))
            rows_written += cur.rowcount if cur.rowcount else 0

    today = datetime.now(timezone.utc).date().isoformat()
    if not dry_run:
        if failed:
            conn.execute("""
                INSERT INTO sync_state (exchange, last_synced_date, last_error) VALUES (?, NULL, ?)
                ON CONFLICT(exchange) DO UPDATE SET last_error=excluded.last_error
            """, (EXCHANGE, f"{len(failed)}/{len(tickers)} ticker(s) failed"))
        else:
            conn.execute("""
                INSERT INTO sync_state (exchange, last_synced_date, last_error) VALUES (?, ?, NULL)
                ON CONFLICT(exchange) DO UPDATE SET
                    last_synced_date=excluded.last_synced_date, last_error=NULL
            """, (EXCHANGE, today))
        conn.commit()
    return {"ok": ok, "failed": failed, "rows_written": rows_written, "total": len(tickers)}


# ── CLI ──────────────────────────────────────────────────────────────────────────────────────

def cmd_instruments(args):
    conn = common.connect()
    count, bad = refresh_instruments(conn, dry_run=args.dry_run)
    for problem in bad:
        log(f"wikitable: {problem}")
    log(f"{'[dry-run] ' if args.dry_run else ''}{count} instrument(s) refreshed from Wikipedia "
        f"({len(bad)} row(s) skipped)")
    return 0


def cmd_tags(args):
    conn = common.connect()
    count, bad = apply_tags(conn, dry_run=args.dry_run)
    for problem in bad:
        log(f"tags.yaml: {problem}")
    log(f"{'[dry-run] ' if args.dry_run else ''}{count} ticker-tag pair(s) applied from tags.yaml "
        f"({len(bad)} line(s) skipped)")
    return 0


def cmd_prices(args):
    conn = common.connect()
    only = [t.strip() for t in args.only.split(",")] if args.only else None
    result = sync_prices(conn, only=only, backfill_days=args.backfill_days, dry_run=args.dry_run)
    return _report_prices_result(result, args.dry_run)


def _report_prices_result(result, dry_run):
    prefix = "[dry-run] " if dry_run else ""
    for ticker, reason in result["failed"]:
        log(f"COULD NOT CHECK {ticker}: {reason}")
    if result["failed"] and result["ok"] == 0:
        log(f"{prefix}every ticker failed ({len(result['failed'])}/{result['total']}) -- "
            f"nothing updated this run")
        return 2
    if result["failed"]:
        log(f"{prefix}{result['ok']}/{result['total']} ticker(s) synced, "
            f"{len(result['failed'])} failed, {result['rows_written']} row(s) written")
        return 1
    if result["rows_written"] == 0:
        log(f"{prefix}nothing new -- market likely not yet closed or a non-trading day "
            f"({result['total']} ticker(s) checked)")
        return 0
    log(f"{prefix}{result['total']} ticker(s) synced, {result['rows_written']} row(s) written")
    return 0


def cmd_daily(args):
    """What hermes-market-sync.service runs: instruments, then tags, then prices, in sequence."""
    conn = common.connect()

    count, bad = refresh_instruments(conn, dry_run=args.dry_run)
    for problem in bad:
        log(f"wikitable: {problem}")
    log(f"instruments: {count} refreshed ({len(bad)} row(s) skipped)")

    tag_count, tag_bad = apply_tags(conn, dry_run=args.dry_run)
    for problem in tag_bad:
        log(f"tags.yaml: {problem}")
    log(f"tags: {tag_count} ticker-tag pair(s) applied ({len(tag_bad)} line(s) skipped)")

    result = sync_prices(conn, dry_run=args.dry_run)
    return _report_prices_result(result, args.dry_run)


def main():
    ap = argparse.ArgumentParser(description="S38b/c -- Firmament Market Watch instrument/price sync")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("instruments", help="refresh instruments from Wikipedia's S&P 500 list")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("tags", help="rebuild the tags table from tags.yaml")
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("prices", help="sync daily prices from Yahoo's chart endpoint")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--only", help="comma-separated tickers, instead of the full universe")
    p.add_argument("--backfill-days", type=int, help="pull this many days instead of the normal catch-up window")

    p = sub.add_parser("daily", help="instruments, then tags, then prices -- what the systemd timer runs")
    p.add_argument("--dry-run", action="store_true")

    args = ap.parse_args()
    dispatch = {"instruments": cmd_instruments, "tags": cmd_tags, "prices": cmd_prices, "daily": cmd_daily}
    return dispatch[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
