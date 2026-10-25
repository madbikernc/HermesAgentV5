#!/usr/bin/env python3
# Version: 1.3.0
#
# 1.3.0 (2026-10-25) - Market Watch history graphs: ticker_price_history(), the one new query the
# FleetOps-UI /market/history page needs -- plain ascending (date, adj_close) pairs, reusing the
# existing idx_prices_ticker_date index. No schema change.
#
# 1.2.0 (2026-10-25) - S38h, direct operator request ("the market watch service should
# periodically check to see if it needs to add stock tickers to any section, especially
# frontier_llm and ai_hardware"). `TAGS_PATH`/`VALID_MATCH_TYPES`/`load_tags()`/`apply_tags()`
# relocated here from hermes-market-sync.py 1.1.0 (unchanged behavior) -- hermes-market-gate.py
# needs to call apply_tags() immediately after a human approves a tag proposal, and hyphenated
# tool files can't import each other directly in this codebase, so shared logic belongs in this
# module regardless of which tool wrote it first. New: the `tag_proposals` table, a 2-line
# sanitize_llm_input() copied from hermes_rag_common.py's own implementation (not imported --
# that module needs the RAG venv's sqlite_vec extension, unavailable under /usr/bin/python3),
# append_tag_rule() (atomic tempfile-then-rename line append to tags.yaml), and tag_scout_pool()
# (the candidate universe hermes-market-sync.py's new LLM classification step reads).
#
# 1.1.0 (2026-10-24) - S38g, direct operator request: "special attention" and a dedicated report
# section for AI-specific hardware tickers (NVDA and similar) and frontier-LLM-developer tickers.
# New AI_WATCH_SECTIONS mapping (report item_type -> tags.yaml tag name), ai_watch_block() and
# render_ai_watch_line() — per-ticker daily + 30-day lines for a small curated watchlist, shown
# individually rather than folded into the generic top-N movers lists. REPORT_SECTION_ORDER/
# _TITLES gained "ai_watch_llm"/"ai_watch_hw", placed right after the sector/tag trend sections
# for visibility.
"""
hermes_market_common.py — Firmament Market Watch (S38b-e): shared schema, connect(), and the
compute/render functions every consumer must agree on. Modeled on hermes_botnet_intel.py's shape
(one underscore-named module holding the real schema/logic, imported by thin hyphenated CLI
tools): tools/hermes-market-sync.py (writer), tools/hermes-market-report.py and
tools/hermes-market-gate.py (readers). No network code and no secrets live here — see
hermes-market-sync.py for the Yahoo/Wikipedia fetch boundary and hermes_alert_common.py for
email/Matrix delivery.

The report and the gate both call the functions below directly rather than each computing their
own version of "today's movers" or "the AI tag's trend" — so a `market movers up` reply in Matrix
can never drift from what the same day's email actually said.

MARKET_WATCH_DESIGN.md §5 is the schema source. Its `UNIQUE(...)` constraints are implemented
here as the table's real PRIMARY KEY (SQLite enforces both identically; no separate surrogate id
column is needed). `tags` additionally gets its own PRIMARY KEY beyond the design doc's literal
text — needed because hermes-market-sync.py wipes and rebuilds `tags` from tags.yaml on every
run, and two rules can legitimately map the same ticker to the same tag.
"""
import os
import sqlite3
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("MARKET_DB", "/mnt/hermes-data/market/market.db"))

TOOLS_DIR = Path(__file__).resolve().parent
REPO_DIR = TOOLS_DIR.parent
TAGS_PATH = Path(os.environ.get(
    "TAGS_PATH", str(REPO_DIR / "infra" / "hermes-market-sync" / "tags.yaml")))
VALID_MATCH_TYPES = {"sector", "ticker", "keyword"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS instruments (
    ticker      TEXT NOT NULL,
    exchange    TEXT NOT NULL,
    name        TEXT NOT NULL,
    currency    TEXT NOT NULL,
    sector      TEXT,
    industry    TEXT,
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    PRIMARY KEY (ticker, exchange)
);
CREATE TABLE IF NOT EXISTS tags (
    ticker    TEXT NOT NULL,
    exchange  TEXT NOT NULL,
    tag       TEXT NOT NULL,
    PRIMARY KEY (ticker, exchange, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS prices (
    ticker     TEXT NOT NULL,
    exchange   TEXT NOT NULL,
    date       TEXT NOT NULL,
    open       REAL,
    high       REAL,
    low        REAL,
    close      REAL,
    adj_close  REAL,
    volume     INTEGER,
    PRIMARY KEY (ticker, exchange, date)
);
CREATE INDEX IF NOT EXISTS idx_prices_ticker_date ON prices(ticker, exchange, date DESC);
CREATE TABLE IF NOT EXISTS sync_state (
    exchange          TEXT NOT NULL PRIMARY KEY,
    last_synced_date  TEXT,
    last_error        TEXT
);
CREATE TABLE IF NOT EXISTS report_items (
    report_date      TEXT NOT NULL,
    category         TEXT NOT NULL,
    item_type        TEXT NOT NULL,
    rank             INTEGER NOT NULL,
    ticker_or_group  TEXT NOT NULL,
    metric_value     REAL NOT NULL,
    text             TEXT NOT NULL,
    PRIMARY KEY (report_date, category, item_type, rank)
);
CREATE INDEX IF NOT EXISTS idx_report_items_date ON report_items(report_date);
CREATE TABLE IF NOT EXISTS tag_proposals (
    ticker         TEXT NOT NULL,
    exchange       TEXT NOT NULL,
    candidate_tag  TEXT NOT NULL,
    rationale      TEXT NOT NULL,
    state          TEXT NOT NULL,
    proposed_at    TEXT NOT NULL,
    decided_at     TEXT,
    PRIMARY KEY (ticker, exchange)
);
"""

# A "sector"/"tag" average over fewer real data points than this is noise, not a trend.
MIN_MEMBERS_FOR_TREND = 3
# Below this many real trading days between baseline and latest, a "30-day trend" would really
# be a ~2-week one — skip the ticker rather than report a misleadingly-labeled number.
MIN_TREND30_SPAN_DAYS = 20


def connect(readonly=False):
    """Writer: mkdir the parent + idempotent CREATE TABLE IF NOT EXISTS + busy_timeout, the same
    shape hermes_botnet_intel._connect() uses for its own dedicated cache. Reader: opens
    `mode=ro` by URI (hermes-fleetops-ui.py's own ro_sqlite() pattern) — a bug in the report or
    gate's read path cannot write to a store it has no business writing to, and a missing file
    raises instead of silently creating an empty one."""
    if readonly:
        return sqlite3.connect(f"file:{urllib.parse.quote(str(DB_PATH))}?mode=ro", uri=True, timeout=15)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA busy_timeout=30000")
    con.executescript(SCHEMA)
    con.commit()
    return con


def pct_change(new, old):
    """None if `old` is falsy/None/zero — never divide by zero, never fabricate a 0% move."""
    if not old:
        return None
    return (new - old) / old * 100.0


def latest_dates(conn, exchange, n=2):
    """The `n` most recent dates actually present in `prices` for this exchange — never "today"
    by the wall clock, since a non-trading day simply has no row yet."""
    return [r[0] for r in conn.execute(
        "SELECT DISTINCT date FROM prices WHERE exchange=? ORDER BY date DESC LIMIT ?",
        (exchange, n)).fetchall()]


def ticker_price_history(conn, ticker, exchange="US"):
    """[(date, adj_close), ...] ascending, for the Market Watch history graph -- the real
    per-ticker series `prices` actually holds, using the existing idx_prices_ticker_date index.
    adj_close, not close, matching every other read in this module (split/dividend-adjusted,
    §5)."""
    return conn.execute(
        "SELECT date, adj_close FROM prices WHERE ticker=? AND exchange=? ORDER BY date",
        (ticker, exchange)).fetchall()


def daily_pct_changes(conn, exchange="US"):
    """Returns ({ticker: pct}, [today, yesterday]) using the two most recent trading dates on
    file. Returns ({}, dates) if fewer than two dates exist yet."""
    dates = latest_dates(conn, exchange, 2)
    if len(dates) < 2:
        return {}, dates
    today, yesterday = dates
    rows = conn.execute("""
        SELECT t.ticker, t.c, y.c FROM
          (SELECT ticker, adj_close AS c FROM prices WHERE exchange=? AND date=?) t
          JOIN (SELECT ticker, adj_close AS c FROM prices WHERE exchange=? AND date=?) y
          ON t.ticker = y.ticker
    """, (exchange, today, exchange, yesterday)).fetchall()
    out = {}
    for ticker, c_today, c_yesterday in rows:
        p = pct_change(c_today, c_yesterday)
        if p is not None:
            out[ticker] = p
    return out, [today, yesterday]


def trend30_pct_changes(conn, exchange="US"):
    """Returns ({ticker: pct}, latest_date). Baseline per ticker is the EARLIEST row with
    date >= (latest - 30 calendar days) — a real trading day near the 30-day mark, never an
    arithmetic date that may be a weekend/holiday with no row. A ticker whose nearest available
    baseline is closer than MIN_TREND30_SPAN_DAYS to latest is skipped (insufficient history),
    never padded to look like a full 30-day window."""
    dates = latest_dates(conn, exchange, 1)
    if not dates:
        return {}, None
    latest = dates[0]
    cutoff = (date.fromisoformat(latest) - timedelta(days=30)).isoformat()
    latest_rows = conn.execute(
        "SELECT ticker, adj_close FROM prices WHERE exchange=? AND date=?",
        (exchange, latest)).fetchall()
    out = {}
    for ticker, latest_close in latest_rows:
        base = conn.execute("""
            SELECT date, adj_close FROM prices
            WHERE exchange=? AND ticker=? AND date>=?
            ORDER BY date ASC LIMIT 1
        """, (exchange, ticker, cutoff)).fetchone()
        if not base:
            continue
        base_date, base_close = base
        span = (date.fromisoformat(latest) - date.fromisoformat(base_date)).days
        if span < MIN_TREND30_SPAN_DAYS:
            continue
        p = pct_change(latest_close, base_close)
        if p is not None:
            out[ticker] = p
    return out, latest


def group_trend(pct_by_ticker, members_by_group):
    """members_by_group: {group_name: [ticker, ...]}. Returns [(group, avg_pct, n_with_data)],
    sorted by avg_pct descending, skipping any group with fewer than MIN_MEMBERS_FOR_TREND
    tickers that actually HAVE a pct value today — a sector can have 60 members and only 55 with
    both days' data; that is still a trend, 2 with data is not."""
    out = []
    for group, members in members_by_group.items():
        vals = [pct_by_ticker[t] for t in members if t in pct_by_ticker]
        if len(vals) < MIN_MEMBERS_FOR_TREND:
            continue
        out.append((group, sum(vals) / len(vals), len(vals)))
    out.sort(key=lambda row: row[1], reverse=True)
    return out


def sector_members(conn, exchange="US"):
    """{sector_name: [ticker, ...]} from `instruments`, sector names as stored (no normalization
    — GICS sector names are already consistent from one Wikipedia pull)."""
    out = {}
    for ticker, sector in conn.execute(
        "SELECT ticker, sector FROM instruments WHERE exchange=? AND sector IS NOT NULL", (exchange,)
    ).fetchall():
        out.setdefault(sector, []).append(ticker)
    return out


def tag_members(conn, exchange="US"):
    """{tag_name: [ticker, ...]} from `tags`."""
    out = {}
    for ticker, tag in conn.execute(
        "SELECT ticker, tag FROM tags WHERE exchange=?", (exchange,)
    ).fetchall():
        out.setdefault(tag, []).append(ticker)
    return out


def load_tags(path=None):
    """`tag | match_type | pattern` per line, # comments and blanks ignored. No YAML is parsed --
    same precedent as feeds.yaml/topics.yaml. A malformed line or unknown match_type is reported
    and skipped, never fatal. Relocated here from hermes-market-sync.py 1.1.0 (S38h) so
    hermes-market-gate.py can call apply_tags() immediately after a tag-proposal approval."""
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


def sanitize_llm_input(s, max_len=4000):
    """Copied verbatim from hermes_rag_common.py's own implementation rather than imported --
    that module requires the RAG venv's sqlite_vec extension at import time, unavailable under
    /usr/bin/python3 (what hermes-market-sync.py runs under). Strips non-printables, truncates.
    Every real LLM-call site in this fleet runs even trivial-looking input through this first;
    a ticker/company-name scrape is no exception."""
    s = "".join(ch if ch.isprintable() or ch == "\n" else " " for ch in s)
    return s[:max_len]


def append_tag_rule(tag, ticker, path=None):
    """Appends one `tag | ticker | SYMBOL` line to tags.yaml, atomically (write to a .tmp file,
    then Path.replace() onto the real path -- the same atomicity
    hermes-rag-discovery-portal.py's own topics.yaml editor uses for a full-content replace,
    adapted here to an append since the gate only ever adds one line at a time). Never raises;
    returns (True, None) on success or (False, error_str) on failure, so a filesystem problem
    becomes a clear gate reply instead of crashing the poll loop.

    The provenance note goes on its OWN comment line above the rule, never appended inline after
    the rule on the same line -- load_tags()'s parser only recognizes a comment as a whole line
    starting with '#' (same as feeds.yaml/topics.yaml's parsers); an earlier version of this
    function put the note inline and it silently broke the ticker match, since the trailing
    "# added via..." text became part of the parsed pattern string instead of being stripped.
    Caught by this module's own test before it ever reached a real tags.yaml."""
    path = Path(path or TAGS_PATH)
    try:
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if current and not current.endswith("\n"):
            current += "\n"
        today = datetime.now(timezone.utc).date().isoformat()
        new_lines = f"# added via FleetOps gate approval, {today}\n{tag} | ticker | {ticker}\n"
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(current + new_lines, encoding="utf-8")
        tmp.replace(path)
        return True, None
    except Exception as exc:
        return False, str(exc)


# S38h: the three sectors every current frontier_llm/ai_hardware member actually lives in.
# Narrower than "Information Technology" alone (which would also sweep in e.g. payment
# processors and industrial conglomerates) but wide enough to catch a real new candidate in
# either tag without needing a precise heuristic -- the LLM call does the real narrowing.
TAG_SCOUT_SECTORS = ("Information Technology", "Communication Services", "Consumer Discretionary")
TAG_SCOUT_TAGS = ("frontier_llm", "ai_hardware")


def tag_scout_pool(conn, exchange="US"):
    """[(ticker, name, sector, industry), ...] -- every instrument in a plausible sector that is
    not already in frontier_llm/ai_hardware and has never been classified before (any state in
    tag_proposals, including 'cleared' for an earlier 'neither' verdict). This is what makes the
    dedup correct: without excluding 'cleared' tickers too, the same ~150-200-ticker pool would
    be re-classified, and re-burn router calls, every single day forever."""
    already_classified = {r[0] for r in conn.execute(
        "SELECT ticker FROM tag_proposals WHERE exchange=?", (exchange,))}
    curated = {r[0] for r in conn.execute(
        "SELECT ticker FROM tags WHERE exchange=? AND tag IN (?,?)",
        (exchange, *TAG_SCOUT_TAGS))}
    placeholders = ",".join("?" * len(TAG_SCOUT_SECTORS))
    rows = conn.execute(f"""
        SELECT ticker, name, sector, industry FROM instruments
        WHERE exchange=? AND sector IN ({placeholders})
        ORDER BY ticker
    """, (exchange, *TAG_SCOUT_SECTORS)).fetchall()
    return [(t, n, s, i) for t, n, s, i in rows if t not in already_classified and t not in curated]


def top_n(pct_by_ticker, n, direction):
    """Returns [(ticker, pct)], the top `n` ACTUAL gainers (direction="up", pct > 0) or ACTUAL
    decliners (direction="down", pct < 0) — never the wrong-signed tail of a plain sort. A naive
    "sort everything and slice" was tried first and caught by this module's own smoke test: with
    fewer real movers than `n`, it padded "today's biggest gainers" with tickers that had
    actually fallen. A flat (exactly 0%) ticker belongs to neither list."""
    if direction == "up":
        items = [(t, p) for t, p in pct_by_ticker.items() if p > 0]
        items.sort(key=lambda kv: kv[1], reverse=True)
    else:
        items = [(t, p) for t, p in pct_by_ticker.items() if p < 0]
        items.sort(key=lambda kv: kv[1])
    return items[:n]


def render_sector_line(name, avg_pct, rank, total):
    sign = "rose" if avg_pct >= 0 else "fell"
    if rank == 1:
        return f"{name} led all {total} sectors today. It {sign} {abs(avg_pct):.2f}%."
    return f"{name} {sign} {abs(avg_pct):.2f}% today. It ranks {rank} of {total} sectors."


def render_tag_line(name, avg_pct, rank, total):
    sign = "rose" if avg_pct >= 0 else "fell"
    if rank == 1:
        return f"The {name} tag led all {total} tracked tags today. It {sign} {abs(avg_pct):.2f}%."
    return f"The {name} tag {sign} {abs(avg_pct):.2f}% today. It ranks {rank} of {total} tags."


def render_mover_line(ticker, pct, rank, direction):
    sign = "rose" if pct >= 0 else "fell"
    if rank == 1:
        label = "top gainer" if direction == "up" else "biggest decliner"
        return f"{ticker} was today's {label}. It {sign} {abs(pct):.2f}%."
    label = "gainer" if direction == "up" else "decliner"
    return f"{ticker} was today's #{rank} {label}. It {sign} {abs(pct):.2f}%."


REPORT_SECTION_ORDER = ["sector_trend", "tag_trend", "ai_watch_llm", "ai_watch_hw",
                        "movers_up", "movers_down", "trend30_up", "trend30_down"]
REPORT_SECTION_TITLES = {
    "sector_trend": "Sector trends",
    "tag_trend": "Thematic tag trends",
    "ai_watch_llm": "Frontier LLM Watch",
    "ai_watch_hw": "AI Hardware Watch",
    "movers_up": "Today's biggest gainers",
    "movers_down": "Today's biggest decliners",
    "trend30_up": "30-day leaders",
    "trend30_down": "30-day laggards",
}

# S38g (direct operator request): the tags.yaml tag name each dedicated "AI watch" report
# section reads its constituents from. Kept as a named mapping, not hardcoded inline at each call
# site, so hermes-market-report.py's compute_report() and this module's own tests agree on it.
AI_WATCH_SECTIONS = {"ai_watch_llm": "frontier_llm", "ai_watch_hw": "ai_hardware"}


def latest_report_date(conn):
    row = conn.execute("SELECT MAX(report_date) FROM report_items").fetchone()
    return row[0] if row and row[0] else None


def read_report_items(conn, report_date, item_type=None):
    """[(category, item_type, rank, ticker_or_group, metric_value, text), ...] for one day,
    optionally narrowed to one item_type — used both by hermes-market-report.py's own delivery
    and by hermes-market-gate.py's on-demand replies, so the two can never disagree about what a
    given day's data said."""
    if item_type:
        return conn.execute("""
            SELECT category, item_type, rank, ticker_or_group, metric_value, text
            FROM report_items WHERE report_date=? AND item_type=? ORDER BY category, rank
        """, (report_date, item_type)).fetchall()
    return conn.execute("""
        SELECT category, item_type, rank, ticker_or_group, metric_value, text
        FROM report_items WHERE report_date=? ORDER BY item_type, rank
    """, (report_date,)).fetchall()


def render_full_report_text(conn, report_date):
    """The full, multi-section report for one day, read back from `report_items` directly —
    this is what both the daily email body and a `market report` gate reply render, so the two
    channels can never show different numbers for the same day."""
    rows = read_report_items(conn, report_date)
    if not rows:
        return f"No report data for {report_date}."
    sections = {}
    for _category, item_type, _rank, _group, _value, text in rows:
        sections.setdefault(item_type, []).append(text)
    parts = [f"Market Watch — {report_date}", ""]
    for item_type in REPORT_SECTION_ORDER:
        lines = sections.get(item_type)
        if not lines:
            continue
        parts.append(REPORT_SECTION_TITLES[item_type] + ":")
        parts.extend(f"  {ln}" for ln in lines)
        parts.append("")
    return "\n".join(parts).rstrip()


def ai_watch_block(conn, section_tag, pct_by_ticker, trend30_by_ticker):
    """One curated watchlist's per-ticker lines, best-move-first — the "special attention" view
    S38g asks for: every member ticker shown individually (not just whoever makes a top-N
    movers cut), each with today's move and its 30-day move if one is available yet. A member
    with no data for today (not yet synced, or genuinely absent from today's `prices`) is
    omitted rather than shown as a fabricated 0%."""
    members = sorted(tag_members(conn, "US").get(section_tag, []))
    present = [(t, pct_by_ticker[t]) for t in members if t in pct_by_ticker]
    present.sort(key=lambda kv: kv[1], reverse=True)
    return [(t, p, render_ai_watch_line(t, p, trend30_by_ticker.get(t))) for t, p in present]


def render_ai_watch_line(ticker, daily_pct, trend30_pct):
    sign = "rose" if daily_pct >= 0 else "fell"
    line = f"{ticker} {sign} {abs(daily_pct):.2f}% today"
    if trend30_pct is not None:
        sign30 = "up" if trend30_pct >= 0 else "down"
        line += f", {sign30} {abs(trend30_pct):.2f}% over 30 days"
    return line + "."


def render_trend30_line(ticker, pct, rank, direction):
    sign = "rose" if pct >= 0 else "fell"
    if rank == 1:
        lead = "leads the 30-day gainers" if direction == "up" else "leads the 30-day decliners"
        return f"{ticker} {lead}. It {sign} {abs(pct):.2f}% over 30 days."
    group = "gainers" if direction == "up" else "decliners"
    return f"{ticker} ranks #{rank} in the 30-day {group}. It {sign} {abs(pct):.2f}% over 30 days."
