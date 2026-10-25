#!/usr/bin/env python3
# Version: 1.2.0
#
# 1.2.0 (2026-10-25) - S38h: checks for the relocated apply_tags()/load_tags() (now
# sync_mod.common.*, no behavior change), append_tag_rule()'s atomicity and its
# own-comment-line-not-inline fix (a real bug this suite caught: an inline provenance comment
# silently corrupted the parsed ticker pattern), parse_classification_reply()'s tolerance of
# malformed/out-of-batch lines, propose_tag_candidates()'s classify/record/dedup/batch-failure-
# isolation, and the four new gate commands (market tag approve/reject/override/pending).
#
# 1.1.0 (2026-10-24) - S38g: checks that the real committed tags.yaml carries the two new
# frontier_llm/ai_hardware curated watchlists, ticker-matched only, including NVDA/GOOGL.
#
# Offline checks for S38b/c (hermes-market-sync.py) and S38e (hermes-market-gate.py). No real
# network call and no real Vaultwarden/Matrix credential anywhere — fetch_html()/fetch_json() are
# monkeypatched directly on the loaded module (hermes-feed-reader.py's own tests establish this
# exact pattern: `fr.fetch = lambda url: body`), and Matrix auth/posting is never exercised here
# at all (that is hermes-gate's send-side, not covered by this file).
#
# Unlike hermes-feed-reader.py's own tests (which stub hermes_rag_common because loading the real
# one needs the sqlite-vec extension), hermes_market_common.py has no such dependency — it is
# plain stdlib sqlite3, nothing else. These checks therefore use a REAL temporary sqlite database
# throughout rather than a hand-rolled fake-connection double: real UNIQUE/ON CONFLICT upsert
# semantics are exactly the kind of thing a fake double gets subtly wrong, and this still runs
# anywhere Python 3 does — the same guarantee every other test file in this repo states.
import importlib.util
import sqlite3
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def new_db():
    """A real, throwaway sqlite file (not :memory: — sync's own connect() mkdirs a real path,
    and some checks below reopen the same file through a fresh connection)."""
    path = Path(tempfile.mkdtemp()) / "market.db"
    con = sqlite3.connect(path)
    return path, con


WIKI_HTML = """
<html><body>
<table id="constituents" class="wikitable">
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th><th>GICS Sub-Industry</th>
    <th>Headquarters Location</th><th>Date added</th><th>CIK</th><th>Founded</th></tr>
<tr><td><a href="/x">AAPL</a></td><td>Apple Inc.</td><td>Information Technology</td>
    <td>Technology Hardware, Storage &amp; Peripherals</td><td>Cupertino, CA</td>
    <td>1982-11-30</td><td>0000320193</td><td>1976</td></tr>
<tr><td>BRK.B</td><td>Berkshire Hathaway<sup>[1]</sup></td><td>Financials</td>
    <td>Multi-Sector Holdings</td><td>Omaha, NE</td><td>2010-02-16</td>
    <td>0001067983</td><td>1839</td></tr>
<tr><td>BAD</td></tr>
</table>
</body></html>
"""

WIKI_HTML_NO_TABLE = "<html><body><p>nothing here</p></body></html>"

WIKI_HTML_BAD_HEADER = """
<table id="constituents">
<tr><th>Ticker</th><th>Name</th></tr>
<tr><td>AAPL</td><td>Apple Inc.</td></tr>
</table>
"""


def _yahoo_payload(timestamps, closes, opens=None, highs=None, lows=None, volumes=None, adjcloses=None):
    return {"chart": {"error": None, "result": [{
        "timestamp": timestamps,
        "indicators": {
            "quote": [{
                "open": opens or closes, "high": highs or closes, "low": lows or closes,
                "close": closes, "volume": volumes or [1000] * len(closes),
            }],
            "adjclose": [{"adjclose": adjcloses or closes}],
        },
    }]}}


def test_wikitable_parsing(sync_mod):
    print("\n[Wikipedia wikitable parsing]")
    rows, bad = sync_mod.parse_sp500_wikitable(WIKI_HTML)
    check("two good rows parse", len(rows) == 2, str(rows))
    check("one malformed row is reported, not fatal", len(bad) == 1, str(bad))
    check("ticker is kept verbatim (dot intact)", rows[1]["ticker"] == "BRK.B", rows[1]["ticker"])
    check("a footnote marker is stripped from the name",
          rows[1]["name"] == "Berkshire Hathaway", rows[1]["name"])
    check("sector/industry carry through", rows[0]["sector"] == "Information Technology")
    check("an ampersand entity decodes",
          "&amp;" not in rows[0]["industry"] and "&" in rows[0]["industry"],
          rows[0]["industry"])

    try:
        sync_mod.parse_sp500_wikitable(WIKI_HTML_NO_TABLE)
        check("a missing table#constituents raises", False)
    except ValueError:
        check("a missing table#constituents raises", True)

    try:
        sync_mod.parse_sp500_wikitable(WIKI_HTML_BAD_HEADER)
        check("a header missing required columns raises", False)
    except ValueError:
        check("a header missing required columns raises", True)


def test_to_yahoo_symbol(sync_mod):
    print("\n[to_yahoo_symbol]")
    check("a plain ticker is unchanged", sync_mod.to_yahoo_symbol("AAPL") == "AAPL")
    check("a dotted multi-class ticker is dashed",
          sync_mod.to_yahoo_symbol("BRK.B") == "BRK-B")
    check("BF.B maps the same way", sync_mod.to_yahoo_symbol("BF.B") == "BF-B")


def test_yahoo_chart_parsing(sync_mod):
    print("\n[Yahoo chart JSON parsing]")
    payload = _yahoo_payload([1697000000, 1697086400, 1697172800],
                              closes=[10.2, None, 12.0], adjcloses=[10.1, None, 11.9])
    parsed = sync_mod.parse_yahoo_chart(payload, "TEST")
    check("a null-close tick is skipped, not fabricated as zero", len(parsed) == 2, str(parsed))
    check("adj_close is carried through", parsed[0][5] == 10.1, str(parsed[0]))
    check("date is derived from the unix timestamp",
          parsed[0][0] == "2023-10-11", parsed[0][0])

    missing_adj = _yahoo_payload([1697000000], closes=[5.0], adjcloses=[])
    parsed2 = sync_mod.parse_yahoo_chart(missing_adj, "TEST")
    check("a missing adjclose array falls back to close",
          parsed2[0][5] == 5.0, str(parsed2))

    for bad_payload, label in [
        ({"chart": {"result": None, "error": {"description": "No data"}}}, "an explicit Yahoo error block"),
        ({"chart": {"result": []}}, "an empty result list"),
        ({"chart": {}}, "a missing result key entirely"),
    ]:
        try:
            sync_mod.parse_yahoo_chart(bad_payload, "TEST")
            check(f"{label} raises ValueError", False)
        except ValueError:
            check(f"{label} raises ValueError", True)


def test_refresh_instruments(sync_mod):
    print("\n[refresh_instruments]")
    db_path, con = new_db()
    con.executescript(sync_mod.common.SCHEMA)
    con.close()
    sync_mod.common.DB_PATH = db_path

    sync_mod.fetch_html = lambda url: WIKI_HTML
    count, bad = sync_mod.refresh_instruments(sync_mod.common.connect(), dry_run=False)
    check("two instruments written", count == 2, str(count))

    con = sqlite3.connect(db_path)
    row = con.execute("SELECT first_seen, last_seen FROM instruments WHERE ticker='AAPL'").fetchone()
    first_seen_1 = row[0]
    con.close()

    # A second refresh on a later "day" must preserve first_seen and bump last_seen.
    real_datetime = sync_mod.datetime

    class _LaterDate:
        @staticmethod
        def now(tz):
            return real_datetime(2099, 1, 1, tzinfo=tz)
    sync_mod.datetime = _LaterDate
    try:
        sync_mod.refresh_instruments(sync_mod.common.connect(), dry_run=False)
    finally:
        sync_mod.datetime = real_datetime

    con = sqlite3.connect(db_path)
    row2 = con.execute("SELECT first_seen, last_seen FROM instruments WHERE ticker='AAPL'").fetchone()
    con.close()
    check("first_seen is preserved across a re-run", row2[0] == first_seen_1, str((row2, first_seen_1)))
    check("last_seen advances on a re-run", row2[1] == "2099-01-01", row2[1])

    # A ticker dropped from the live table (one AAPL-only re-run) must never be deleted.
    sync_mod.fetch_html = lambda url: WIKI_HTML.replace(
        "<tr><td>BRK.B</td>", "<!-- removed --><tr style='display:none'><td>REMOVED-ROW-MARKER</td>")
    con = sqlite3.connect(db_path)
    still_there = con.execute("SELECT 1 FROM instruments WHERE ticker='BRK.B'").fetchone()
    con.close()
    check("a ticker dropped from the live page is never deleted", still_there is not None)


def test_tags(sync_mod):
    print("\n[tags.yaml parsing and apply_tags]")
    tmpdir = Path(tempfile.mkdtemp())
    tags_path = tmpdir / "tags.yaml"
    tags_path.write_text(
        "# comment\n\n"
        "ai | ticker | AAPL\n"
        "tech | sector | Information Technology\n"
        "bank | keyword | berkshire\n"
        "bogus | notareal | x\n"
        "malformed line with no pipes\n",
        encoding="utf-8",
    )
    rules, bad = sync_mod.common.load_tags(tags_path)
    check("three good rules parse", len(rules) == 3, str(rules))
    check("an unknown match_type is reported", any("notareal" in b for b in bad), str(bad))
    check("a pipe-less line is reported", any("malformed line" in b for b in bad), str(bad))

    db_path, con = new_db()
    con.executescript(sync_mod.common.SCHEMA)
    now = "2026-10-20"
    con.executemany(
        "INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen) "
        "VALUES (?,?,?,?,?,?,?,?)",
        [("AAPL", "US", "Apple Inc.", "USD", "Information Technology", "Hardware", now, now),
         ("BRK.B", "US", "Berkshire Hathaway", "USD", "Financials", "Holdings", now, now),
         ("XOM", "US", "Exxon", "USD", "Energy", "Oil & Gas", now, now)],
    )
    con.commit()
    con.close()
    sync_mod.common.DB_PATH = db_path
    sync_mod.common.TAGS_PATH = tags_path

    count, bad2 = sync_mod.common.apply_tags(sync_mod.common.connect(), dry_run=False)
    check("three ticker-tag pairs applied", count == 3, str(count))

    con = sqlite3.connect(db_path)
    tagged = set(con.execute("SELECT ticker, tag FROM tags").fetchall())
    con.close()
    check("ticker-match rule applied", ("AAPL", "ai") in tagged, str(tagged))
    check("sector-match rule applied", ("AAPL", "tech") in tagged, str(tagged))
    check("keyword-match rule applied (name contains 'berkshire')", ("BRK.B", "bank") in tagged, str(tagged))
    check("a non-matching instrument gets no tag", not any(t == "XOM" for t, _tag in tagged), str(tagged))

    # Wipe-and-rebuild: removing a rule must remove its tag on the next apply, not accumulate.
    tags_path.write_text("ai | ticker | AAPL\n", encoding="utf-8")
    count2, _bad3 = sync_mod.common.apply_tags(sync_mod.common.connect(), dry_run=False)
    con = sqlite3.connect(db_path)
    tagged2 = set(con.execute("SELECT ticker, tag FROM tags").fetchall())
    con.close()
    check("a removed rule's tag disappears on the next apply (wipe, not merge)",
          tagged2 == {("AAPL", "ai")}, str(tagged2))

    print("\n[the real committed tags.yaml, including S38g's frontier_llm/ai_hardware watchlists]")
    real_rules, real_bad = sync_mod.common.load_tags(sync_mod.REPO_DIR / "infra" / "hermes-market-sync" / "tags.yaml")
    check("the committed tags.yaml parses with no complaints", not real_bad, str(real_bad))
    real_tags = {tag for tag, _match_type, _pattern in real_rules}
    check("all eight tags are present, including the two S38g watchlists",
          {"frontier_llm", "ai_hardware", "ai", "information_technology", "agricultural",
           "fintech", "industrials", "energy_utilities"} <= real_tags, str(real_tags))
    hw_tickers = {pattern for tag, mt, pattern in real_rules if tag == "ai_hardware" and mt == "ticker"}
    check("NVIDIA is in the ai_hardware watchlist (the operator's own named example)",
          "NVDA" in hw_tickers, str(hw_tickers))
    llm_tickers = {pattern for tag, mt, pattern in real_rules if tag == "frontier_llm" and mt == "ticker"}
    check("frontier_llm is ticker-curated, not a broad sector/keyword net",
          all(mt == "ticker" for tag, mt, _p in real_rules if tag == "frontier_llm"), str(real_rules))
    check("GOOGL is in the frontier_llm watchlist", "GOOGL" in llm_tickers, str(llm_tickers))


def test_append_tag_rule(sync_mod):
    print("\n[append_tag_rule -- atomic append, comment on its own line]")
    tmpdir = Path(tempfile.mkdtemp())
    path = tmpdir / "tags.yaml"

    ok, err = sync_mod.common.append_tag_rule("ai_hardware", "NVDA", path=path)
    check("first append to a missing file succeeds", ok and err is None, str((ok, err)))
    content1 = path.read_text(encoding="utf-8")
    check("the provenance note is its own comment line, not inline",
          "# added via FleetOps gate approval" in content1
          and "ai_hardware | ticker | NVDA  #" not in content1, content1)
    check("the rule line itself is clean and parseable",
          "ai_hardware | ticker | NVDA" in content1.splitlines(), content1)

    ok2, _ = sync_mod.common.append_tag_rule("frontier_llm", "GOOGL", path=path)
    content2 = path.read_text(encoding="utf-8")
    check("a second append preserves the first rule", "ai_hardware | ticker | NVDA" in content2, content2)
    check("a second append adds the new rule", "frontier_llm | ticker | GOOGL" in content2, content2)

    # The exact bug this function's own docstring names: an inline comment must never corrupt
    # the parsed ticker pattern.
    rules, bad = sync_mod.common.load_tags(path)
    check("every appended rule round-trips through load_tags() with a clean ticker pattern",
          ("ai_hardware", "ticker", "NVDA") in rules and ("frontier_llm", "ticker", "GOOGL") in rules,
          str(rules))
    check("no bad lines from the provenance comments", not bad, str(bad))


def test_tag_scout(sync_mod):
    print("\n[parse_classification_reply]")
    parsed = sync_mod.parse_classification_reply(
        "GOOGL: frontier_llm | builds Gemini models\n"
        "RDDT: neither | social media, not an LLM developer\n"
        "garbage line with no colon\n"
        "ZZZZ: ai_hardware | not in this batch, must be dropped\n",
        {"GOOGL", "RDDT"},
    )
    check("a well-formed line parses", parsed.get("GOOGL") == ("frontier_llm", "builds Gemini models"), str(parsed))
    check("'neither' parses like any other verdict", parsed.get("RDDT", (None,))[0] == "neither", str(parsed))
    check("a line with no colon is skipped, not fatal", len(parsed) == 2, str(parsed))
    check("a ticker outside the batch is dropped even if well-formed", "ZZZZ" not in parsed, str(parsed))

    print("\n[tag_scout_pool]")
    db_path, con = new_db()
    con.executescript(sync_mod.common.SCHEMA)
    now = "2026-10-20"
    con.executemany(
        "INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen) "
        "VALUES (?,?,?,?,?,?,?,?)",
        [("NVDA", "US", "Nvidia", "USD", "Information Technology", "Semiconductors", now, now),
         ("GOOGL", "US", "Alphabet", "USD", "Communication Services", "Interactive Media & Services", now, now),
         ("RDDT", "US", "Reddit", "USD", "Communication Services", "Interactive Media & Services", now, now),
         ("XOM", "US", "Exxon", "USD", "Energy", "Oil & Gas", now, now)],
    )
    con.execute("INSERT INTO tags (ticker, exchange, tag) VALUES ('NVDA', 'US', 'ai_hardware')")
    con.commit()
    sync_mod.common.DB_PATH = db_path

    pool = sync_mod.common.tag_scout_pool(con)
    pool_tickers = {t for t, _n, _s, _i in pool}
    check("an already-curated ticker is excluded", "NVDA" not in pool_tickers, str(pool_tickers))
    check("a plausible-sector candidate is included", "GOOGL" in pool_tickers and "RDDT" in pool_tickers,
          str(pool_tickers))
    check("an out-of-scope sector is excluded", "XOM" not in pool_tickers, str(pool_tickers))

    print("\n[propose_tag_candidates -- classify, record, dedup]")

    def fake_router_ok(payload):
        return {"choices": [{"message": {"content":
            "GOOGL: frontier_llm | builds Gemini models\nRDDT: neither | social media site"}}]}
    sync_mod.call_router = fake_router_ok
    proposed = sync_mod.propose_tag_candidates(con, dry_run=False)
    check("only the real frontier_llm/ai_hardware verdict is returned as 'proposed'",
          proposed == [("GOOGL", "frontier_llm", "builds Gemini models")], str(proposed))

    rows = dict((t, (tag, state)) for t, tag, state in
                con.execute("SELECT ticker, candidate_tag, state FROM tag_proposals").fetchall())
    check("the frontier_llm verdict is stored as 'proposed'",
          rows.get("GOOGL") == ("frontier_llm", "proposed"), str(rows))
    check("a 'neither' verdict is stored as 'cleared', not dropped",
          rows.get("RDDT") == ("neither", "cleared"), str(rows))

    pool_after = sync_mod.common.tag_scout_pool(con)
    check("both classified tickers leave the pool -- dedup prevents re-classification",
          pool_after == [], str(pool_after))

    proposed_again = sync_mod.propose_tag_candidates(con, dry_run=False)
    check("re-running with an empty pool proposes nothing new", proposed_again == [], str(proposed_again))

    print("\n[propose_tag_candidates -- a batch failure is isolated, not fatal]")
    db_path2, con2 = new_db()
    con2.executescript(sync_mod.common.SCHEMA)
    con2.executemany(
        "INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen) "
        "VALUES (?,?,?,?,?,?,?,?)",
        [("A1", "US", "A1 Corp", "USD", "Information Technology", "Software", now, now),
         ("A2", "US", "A2 Corp", "USD", "Information Technology", "Software", now, now)],
    )
    con2.commit()

    def fake_router_boom(payload):
        raise OSError("router unreachable")
    sync_mod.call_router = fake_router_boom
    proposed_fail = sync_mod.propose_tag_candidates(con2, dry_run=False)
    check("a router failure returns no proposals, never raises", proposed_fail == [], str(proposed_fail))
    rows2 = con2.execute("SELECT COUNT(*) FROM tag_proposals").fetchone()[0]
    check("a failed batch writes nothing, so it's retried in full next run", rows2 == 0, str(rows2))


def test_sync_prices_honesty_split(sync_mod):
    print("\n[sync_prices honesty split]")
    db_path, con = new_db()
    con.executescript(sync_mod.common.SCHEMA)
    now = "2026-10-20"
    con.executemany(
        "INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen) "
        "VALUES (?,?,?,?,?,?,?,?)",
        [("AAA", "US", "A", "USD", "Tech", "Soft", now, now),
         ("BBB", "US", "B", "USD", "Tech", "Soft", now, now)],
    )
    con.commit()
    con.close()
    sync_mod.common.DB_PATH = db_path

    good_payload = _yahoo_payload([1697000000], closes=[10.0])

    # All ok.
    sync_mod.fetch_json = lambda url: good_payload
    result = sync_mod.sync_prices(sync_mod.common.connect(), dry_run=False)
    check("a clean run marks both tickers ok", result["ok"] == 2 and not result["failed"], str(result))
    con = sqlite3.connect(db_path)
    row = con.execute("SELECT last_synced_date, last_error FROM sync_state WHERE exchange='US'").fetchone()
    con.close()
    check("last_synced_date advances on a clean run", row[0] is not None, str(row))
    check("last_error is clear on a clean run", row[1] is None, str(row))

    # Partial failure: one ticker's fetch raises.
    def flaky(url):
        if "AAA" in url or "AAA" in url.upper():
            raise OSError("name resolution failed")
        return good_payload
    sync_mod.fetch_json = flaky
    result2 = sync_mod.sync_prices(sync_mod.common.connect(), dry_run=False)
    check("a partial failure reports the failing ticker", len(result2["failed"]) == 1, str(result2))
    con = sqlite3.connect(db_path)
    row2 = con.execute("SELECT last_synced_date, last_error FROM sync_state WHERE exchange='US'").fetchone()
    con.close()
    check("last_synced_date does NOT advance past a partial failure", row2[0] == row[0], str((row2, row)))
    check("last_error names the failure count", "1/2" in (row2[1] or ""), str(row2))

    # Total failure: every ticker fails.
    def boom(url):
        raise OSError("down")
    sync_mod.fetch_json = boom
    result3 = sync_mod.sync_prices(sync_mod.common.connect(), dry_run=False)
    check("a total failure marks every ticker failed, none ok",
          result3["ok"] == 0 and len(result3["failed"]) == 2, str(result3))

    # "Nothing new" (market not yet closed): a clean run with zero rows written is NOT an error.
    sync_mod.fetch_json = lambda url: _yahoo_payload([], closes=[])
    result4 = sync_mod.sync_prices(sync_mod.common.connect(), dry_run=False)
    check("an empty-but-successful fetch is 'nothing new', not a failure",
          result4["ok"] == 2 and not result4["failed"] and result4["rows_written"] == 0, str(result4))


def test_gate_regexes(gate_mod):
    print("\n[hermes-market-gate.py command grammar]")
    check("'market report' matches REPORT_RE", bool(gate_mod.REPORT_RE.match("market report")))
    check("case-insensitive", bool(gate_mod.REPORT_RE.match("MARKET REPORT")))
    check("'market sector list' matches SECTOR_LIST_RE", bool(gate_mod.SECTOR_LIST_RE.match("market sector list")))

    m = gate_mod.SECTOR_RE.match("market sector Information Technology")
    check("a multi-word sector name is captured in full", m and m.group(1) == "Information Technology",
          m.group(1) if m else None)

    check("'market movers up' captures 'up'",
          gate_mod.MOVERS_RE.match("market movers up").group(1).lower() == "up")
    check("'market movers down' captures 'down'",
          gate_mod.MOVERS_RE.match("market movers down").group(1).lower() == "down")
    check("'market trend30 up' captures 'up'",
          gate_mod.TREND30_RE.match("market trend30 up").group(1).lower() == "up")
    check("'market ticker AAPL' captures the symbol",
          gate_mod.TICKER_RE.match("market ticker AAPL").group(1) == "AAPL")

    check("'market reportt' (extra char) does not match REPORT_RE",
          gate_mod.REPORT_RE.match("market reportt") is None)
    check("a bare 'market' matches nothing", gate_mod.dispatch_command("market") is None)
    check("unrelated chat matches nothing", gate_mod.dispatch_command("good morning") is None)

    print("\n[dispatch ordering: 'sector list' must not be captured as a sector named 'list']")
    db_path, con = new_db()
    con.executescript(gate_mod.common.SCHEMA)
    now = "2026-10-20"
    con.execute(
        "INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen) "
        "VALUES ('AAA','US','Alpha','USD','Tech','Soft',?,?)", (now, now))
    con.commit()
    con.close()
    gate_mod.common.DB_PATH = db_path
    reply = gate_mod.dispatch_command("market sector list")
    check("'market sector list' is handled by handle_sector_list, not handle_sector",
          "Sectors:" in reply and "Unknown sector/tag" not in reply, reply)


def test_gate_handlers(gate_mod):
    print("\n[hermes-market-gate.py handlers against a real seeded db]")
    db_path, con = new_db()
    con.executescript(gate_mod.common.SCHEMA)
    now = "2026-10-20"
    con.executemany(
        "INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen) "
        "VALUES (?,?,?,?,?,?,?,?)",
        [("AAA", "US", "Alpha Corp", "USD", "Tech", "Soft", now, now),
         ("BBB", "US", "Beta Corp", "USD", "Tech", "Soft", now, now),
         ("CCC", "US", "Gamma Corp", "USD", "Tech", "Soft", now, now)],
    )
    for d, a, b, c in [("2026-10-22", 100, 50, 10), ("2026-10-23", 110, 45, 11)]:
        con.executemany(
            "INSERT INTO prices (ticker, exchange, date, open, high, low, close, adj_close, volume) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            [("AAA", "US", d, a, a, a, a, a, 1), ("BBB", "US", d, b, b, b, b, b, 1),
             ("CCC", "US", d, c, c, c, c, c, 1)],
        )
    con.commit()
    con.close()
    gate_mod.common.DB_PATH = db_path

    check("unknown ticker gets a named refusal, not silence",
          "Unknown ticker" in gate_mod.handle_ticker("ZZZZ"), gate_mod.handle_ticker("ZZZZ"))
    reply = gate_mod.handle_ticker("aaa")
    check("a known ticker (lowercased in chat) resolves and reports a real move",
          "AAA" in reply and "10.00%" in reply, reply)

    check("unknown sector/tag gets a named refusal pointing at 'sector list'",
          "Unknown sector/tag" in gate_mod.handle_sector("Not A Real Sector"),
          gate_mod.handle_sector("Not A Real Sector"))
    sector_reply = gate_mod.handle_sector("tech")
    check("a known sector (case-insensitive) reports a real trend", "Tech" in sector_reply, sector_reply)

    movers_up = gate_mod.handle_movers("up")
    check("movers up only lists real gainers", "AAA" in movers_up and "BBB" not in movers_up, movers_up)
    movers_down = gate_mod.handle_movers("down")
    check("movers down only lists real decliners", "BBB" in movers_down and "AAA" not in movers_down, movers_down)

    check("handle_report with no report yet says so plainly, never crashes",
          "No daily report" in gate_mod.handle_report())


def test_gate_tag_commands(gate_mod):
    print("\n[market tag approve/reject/override/pending -- S38h]")
    check("'market tag pending' matches TAG_PENDING_RE", bool(gate_mod.TAG_PENDING_RE.match("market tag pending")))
    check("'market tag approve NVDA' captures the ticker",
          gate_mod.TAG_APPROVE_RE.match("market tag approve NVDA").group(1) == "NVDA")
    check("'market tag reject NVDA' captures the ticker",
          gate_mod.TAG_REJECT_RE.match("market tag reject NVDA").group(1) == "NVDA")
    check("'market tag override NVDA' captures the ticker",
          gate_mod.TAG_OVERRIDE_RE.match("market tag override NVDA").group(1) == "NVDA")

    db_path, con = new_db()
    con.executescript(gate_mod.common.SCHEMA)
    now = "2026-10-20"
    con.executemany(
        "INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen) "
        "VALUES (?,?,?,?,?,?,?,?)",
        [("NVDA", "US", "Nvidia", "USD", "Information Technology", "Semiconductors", now, now)],
    )
    con.commit()
    con.close()
    gate_mod.common.DB_PATH = db_path
    tags_tmp = Path(tempfile.mkdtemp()) / "tags.yaml"
    gate_mod.common.TAGS_PATH = tags_tmp

    check("'market tag pending' with no proposals says so plainly",
          "No pending" in gate_mod.handle_tag_pending(), gate_mod.handle_tag_pending())

    con4 = sqlite3.connect(db_path)
    con4.execute("""INSERT INTO tag_proposals (ticker, exchange, candidate_tag, rationale, state, proposed_at)
                    VALUES ('NVDA', 'US', 'ai_hardware', 'GPU/AI accelerator maker', 'proposed', ?)""", (now,))
    con4.commit()
    con4.close()

    pending = gate_mod.handle_tag_pending()
    check("a real pending proposal is listed", "NVDA" in pending and "ai_hardware" in pending, pending)

    check("approving an unknown ticker is a named refusal",
          "No tag proposal" in gate_mod.handle_tag_approve("ZZZZ"))
    check("rejecting an unknown ticker is a named refusal",
          "No tag proposal" in gate_mod.handle_tag_reject("ZZZZ"))
    check("overriding an unknown ticker is a named refusal",
          "No tag proposal" in gate_mod.handle_tag_override("ZZZZ"))

    approve_reply = gate_mod.handle_tag_approve("nvda")
    check("approval confirms the real tag and applies immediately",
          "Approved" in approve_reply and "ai_hardware" in approve_reply, approve_reply)
    check("the approved line actually lands in tags.yaml, on its own clean line",
          "ai_hardware | ticker | NVDA" in tags_tmp.read_text(encoding="utf-8"))

    reapprove_reply = gate_mod.handle_tag_approve("NVDA")
    check("re-approving an already-approved proposal is a named no-op",
          "already" in reapprove_reply.lower(), reapprove_reply)

    con2 = sqlite3.connect(db_path)
    con2.execute("""INSERT INTO tag_proposals (ticker, exchange, candidate_tag, rationale, state, proposed_at)
                    VALUES ('AMD', 'US', 'ai_hardware', 'GPU maker', 'proposed', ?)""", (now,))
    con2.commit()
    con2.close()

    reject_reply = gate_mod.handle_tag_reject("AMD")
    check("rejection is confirmed and names the override escape hatch",
          "rejected" in reject_reply.lower() and "override AMD" in reject_reply, reject_reply)
    rereject_reply = gate_mod.handle_tag_reject("AMD")
    check("rejecting an already-rejected proposal is a named no-op",
          "already" in rereject_reply.lower(), rereject_reply)
    cant_override_approved = gate_mod.handle_tag_override("NVDA")
    check("overriding a non-rejected (approved) proposal refuses, naming the real state",
          "not rejected" in cant_override_approved, cant_override_approved)

    override_reply = gate_mod.handle_tag_override("AMD")
    check("override puts a rejected proposal back to proposed",
          "back to proposed" in override_reply, override_reply)
    con3 = sqlite3.connect(db_path)
    state = con3.execute("SELECT state FROM tag_proposals WHERE ticker='AMD'").fetchone()[0]
    con3.close()
    check("the state transition actually persisted", state == "proposed", state)


def main():
    sync_mod = load_module("hermes_market_sync_under_test", "hermes-market-sync.py")
    gate_mod = load_module("hermes_market_gate_under_test", "hermes-market-gate.py")

    test_wikitable_parsing(sync_mod)
    test_to_yahoo_symbol(sync_mod)
    test_yahoo_chart_parsing(sync_mod)
    test_refresh_instruments(sync_mod)
    test_tags(sync_mod)
    test_append_tag_rule(sync_mod)
    test_tag_scout(sync_mod)
    test_sync_prices_honesty_split(sync_mod)
    test_gate_regexes(gate_mod)
    test_gate_handlers(gate_mod)
    test_gate_tag_commands(gate_mod)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
