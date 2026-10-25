#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-24) - S38g: checks for the new dedicated Frontier LLM Watch/AI Hardware Watch
# report sections (hermes_market_common.ai_watch_block()/render_ai_watch_line(), and
# compute_report()'s own two new blocks + matrix_summary line).
#
# Offline checks for S38d (hermes-market-report.py) and the compute/render half of
# hermes_market_common.py it shares with hermes-market-gate.py. hermes_market_common.py has no
# network/vault dependency at all (plain stdlib sqlite3), so its own checks run against a real
# temporary sqlite database rather than a fake connection double — real UNIQUE/upsert semantics
# are exactly what a hand-rolled fake gets subtly wrong. hermes_alert_common (email/Matrix
# delivery) IS stubbed, into sys.modules before hermes-market-report.py is loaded, the same
# pattern test_feed_reader.py uses for hermes_rag_common — no real SMTP or Matrix call happens
# anywhere in this file.
import importlib.util
import sqlite3
import sys
import tempfile
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"
sys.path.insert(0, str(TOOLS))

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def new_db():
    path = Path(tempfile.mkdtemp()) / "market.db"
    return path, sqlite3.connect(path)


def seed_instruments(con, rows):
    """rows: [(ticker, sector), ...]"""
    now = "2026-10-20"
    con.executemany(
        "INSERT INTO instruments (ticker, exchange, name, currency, sector, industry, first_seen, last_seen) "
        "VALUES (?, 'US', ?, 'USD', ?, 'Industry', ?, ?)",
        [(t, t, s, now, now) for t, s in rows],
    )


def seed_prices(con, ticker, date_close_pairs):
    con.executemany(
        "INSERT INTO prices (ticker, exchange, date, open, high, low, close, adj_close, volume) "
        "VALUES (?, 'US', ?, ?, ?, ?, ?, ?, 1000)",
        [(ticker, d, c, c, c, c, c) for d, c in date_close_pairs],
    )


def import_common():
    import hermes_market_common as common
    return common


def test_pct_change(common):
    print("\n[pct_change]")
    check("a normal move", common.pct_change(110, 100) == 10.0)
    check("a decline", common.pct_change(90, 100) == -10.0)
    check("zero old price never divides by zero", common.pct_change(10, 0) is None)
    check("None old price is handled", common.pct_change(10, None) is None)


def test_daily_and_trend30(common):
    print("\n[daily_pct_changes]")
    db_path, con = new_db()
    con.executescript(common.SCHEMA)
    seed_prices(con, "AAA", [("2026-10-22", 100), ("2026-10-23", 110)])
    seed_prices(con, "BBB", [("2026-10-22", 50), ("2026-10-23", 45)])
    seed_prices(con, "ONLYONE", [("2026-10-23", 10)])
    con.commit()

    pct, dates = common.daily_pct_changes(con, "US")
    check("two trading dates found", dates == ["2026-10-23", "2026-10-22"], str(dates))
    check("AAA's move is computed correctly", abs(pct["AAA"] - 10.0) < 1e-9, str(pct))
    check("BBB's decline is computed correctly", abs(pct["BBB"] - (-10.0)) < 1e-9, str(pct))
    check("a ticker with only one day of data is excluded", "ONLYONE" not in pct, str(pct))

    con2 = sqlite3.connect(Path(tempfile.mkdtemp()) / "empty.db")
    con2.executescript(common.SCHEMA)
    pct_empty, dates_empty = common.daily_pct_changes(con2, "US")
    check("fewer than two dates returns an empty result, not an error",
          pct_empty == {} and len(dates_empty) < 2, str((pct_empty, dates_empty)))

    print("\n[trend30_pct_changes]")
    db_path2, con3 = new_db()
    con3.executescript(common.SCHEMA)
    # LONG: real baseline ~28 days back -- a full window, included.
    seed_prices(con3, "LONG", [("2026-09-25", 100), ("2026-10-23", 120)])
    # SHORT: nearest available baseline is only 13 days back -- too short a span, excluded.
    seed_prices(con3, "SHORT", [("2026-10-10", 50), ("2026-10-23", 55)])
    # NODATA: no row at all on the latest date -- excluded (not in latest_rows).
    seed_prices(con3, "NODATA", [("2026-10-01", 10)])
    con3.commit()

    trend, latest = common.trend30_pct_changes(con3, "US")
    check("latest date is the most recent row on file", latest == "2026-10-23", latest)
    check("a ticker with a real ~30-day baseline is included",
          "LONG" in trend and abs(trend["LONG"] - 20.0) < 1e-9, str(trend))
    check("a ticker whose nearest baseline is too recent is excluded (MIN_TREND30_SPAN_DAYS)",
          "SHORT" not in trend, str(trend))
    check("a ticker absent on the latest date is excluded entirely", "NODATA" not in trend, str(trend))


def test_group_trend(common):
    print("\n[group_trend -- MIN_MEMBERS_FOR_TREND gating]")
    pct = {"A": 10.0, "B": 20.0, "C": 30.0, "D": 5.0}  # D has no group membership below
    members = {
        "BigSector": ["A", "B", "C"],      # 3 with data -- included
        "SmallSector": ["A", "B"],         # 2 with data -- excluded (below the floor)
        "GhostSector": ["X", "Y", "Z"],    # 0 with data -- excluded
    }
    trends = common.group_trend(pct, members)
    names = [t[0] for t in trends]
    check("a sector with enough real data points is included", "BigSector" in names, str(trends))
    check("a sector below MIN_MEMBERS_FOR_TREND is excluded", "SmallSector" not in names, str(trends))
    check("a sector with zero real data points is excluded", "GhostSector" not in names, str(trends))
    check("BigSector's average is correct",
          abs(dict((n, v) for n, v, _c in trends)["BigSector"] - 20.0) < 1e-9, str(trends))
    check("results are sorted descending by average", trends == sorted(trends, key=lambda t: -t[1]))


def test_top_n(common):
    print("\n[top_n -- sign filtering, not a plain sort]")
    pct = {"UP1": 10.0, "UP2": 5.0, "DOWN1": -3.0, "FLAT": 0.0}
    up = common.top_n(pct, 10, "up")
    down = common.top_n(pct, 10, "down")
    check("only real gainers appear under 'up', even when n exceeds the count",
          [t for t, _p in up] == ["UP1", "UP2"], str(up))
    check("only real decliners appear under 'down'",
          [t for t, _p in down] == ["DOWN1"], str(down))
    check("a flat (0%) ticker appears in neither list",
          all(t != "FLAT" for t, _p in up) and all(t != "FLAT" for t, _p in down))
    check("'up' is sorted descending", up == sorted(up, key=lambda kv: -kv[1]))
    check("'down' is sorted ascending (biggest decline first)", down == sorted(down, key=lambda kv: kv[1]))


def test_render_lines(common):
    print("\n[render_* line formatting]")
    check("sector rank 1 names it the leader",
          "led all" in common.render_sector_line("Tech", 3.0, 1, 5))
    check("sector rank >1 states its rank",
          "ranks 3 of 5" in common.render_sector_line("Energy", -1.0, 3, 5))
    check("mover rank 1 up is 'top gainer'",
          "top gainer" in common.render_mover_line("AAA", 5.0, 1, "up"))
    check("mover rank 1 down is 'biggest decliner'",
          "biggest decliner" in common.render_mover_line("BBB", -5.0, 1, "down"))
    check("trend30 rank 1 up leads the gainers",
          "leads the 30-day gainers" in common.render_trend30_line("AAA", 12.0, 1, "up"))


def test_ai_watch(common):
    print("\n[ai_watch_block / render_ai_watch_line -- S38g]")
    check("render_ai_watch_line with a 30-day figure mentions both windows",
          "today" in common.render_ai_watch_line("NVDA", 3.0, 18.4)
          and "30 days" in common.render_ai_watch_line("NVDA", 3.0, 18.4))
    check("render_ai_watch_line with no 30-day figure yet mentions only today",
          "30 days" not in common.render_ai_watch_line("NVDA", 3.0, None))
    check("a decline renders with 'fell', not 'rose'",
          "fell" in common.render_ai_watch_line("INTC", -2.0, None))

    db_path, con = new_db()
    con.executescript(common.SCHEMA)
    seed_instruments(con, [("NVDA", "Tech"), ("AMD", "Tech"), ("GOOGL", "Comm"), ("NODATA", "Tech")])
    con.executemany("INSERT INTO tags (ticker, exchange, tag) VALUES (?, 'US', ?)", [
        ("NVDA", "ai_hardware"), ("AMD", "ai_hardware"), ("NODATA", "ai_hardware"),
        ("GOOGL", "frontier_llm"),
    ])
    seed_prices(con, "NVDA", [("2026-10-22", 100), ("2026-10-23", 103)])
    seed_prices(con, "AMD", [("2026-10-22", 50), ("2026-10-23", 48)])
    seed_prices(con, "GOOGL", [("2026-10-22", 200), ("2026-10-23", 202)])
    # NODATA carries the ai_hardware tag but has no price row at all -- must be omitted, not
    # shown as a fabricated 0% mover.
    con.commit()

    pct, _dates = common.daily_pct_changes(con, "US")
    trend30, _latest = common.trend30_pct_changes(con, "US")
    hw = common.ai_watch_block(con, "ai_hardware", pct, trend30)
    check("only the two real ai_hardware tickers with data appear", {t for t, _p, _tx in hw} == {"NVDA", "AMD"}, str(hw))
    check("a tagged ticker with no price data is omitted, not fabricated as 0%",
          not any(t == "NODATA" for t, _p, _tx in hw), str(hw))
    check("best mover is listed first (NVDA +3% before AMD -4%)", hw[0][0] == "NVDA", str(hw))

    llm = common.ai_watch_block(con, "frontier_llm", pct, trend30)
    check("frontier_llm watch is a separate, independent list", {t for t, _p, _tx in llm} == {"GOOGL"}, str(llm))
    check("ai_hardware members never leak into frontier_llm's list",
          not any(t in ("NVDA", "AMD") for t, _p, _tx in llm), str(llm))

    empty = common.ai_watch_block(con, "no_such_tag", pct, trend30)
    check("an unseeded tag name returns an empty list, not an error", empty == [])


def load_report_module():
    """Stubs hermes_alert_common before hermes-market-report.py's own `import hermes_alert_common`
    executes, so no real SMTP/Matrix call can happen. Returns (module, sent_log) where sent_log
    records every call the report tool made to either delivery channel."""
    sent_log = []
    fake_alert = types.ModuleType("hermes_alert_common")
    fake_alert.send_email = lambda subject, body, log=print, priority="normal": (
        sent_log.append(("email", subject, body)) or True)
    fake_alert.matrix_notice = lambda text, log=print: sent_log.append(("matrix", text))
    sys.modules["hermes_alert_common"] = fake_alert

    spec = importlib.util.spec_from_file_location("hermes_market_report_under_test",
                                                    TOOLS / "hermes-market-report.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["hermes_market_report_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod, sent_log


def test_write_report_items(report_mod, common):
    print("\n[write_report_items -- idempotency and the empty-block guard]")
    db_path, con = new_db()
    con.executescript(common.SCHEMA)
    con.commit()

    blocks = {("ALL", "movers_up"): [("AAA", 10.0, "AAA rose 10%"), ("BBB", 5.0, "BBB rose 5%")]}
    report_mod.write_report_items(con, "2026-10-23", blocks)
    n1 = con.execute("SELECT COUNT(*) FROM report_items WHERE report_date='2026-10-23'").fetchone()[0]
    check("two rows written on the first run", n1 == 2, str(n1))

    report_mod.write_report_items(con, "2026-10-23", blocks)
    n2 = con.execute("SELECT COUNT(*) FROM report_items WHERE report_date='2026-10-23'").fetchone()[0]
    check("re-running with the same data does not duplicate rows (delete-then-reinsert)",
          n2 == n1, str((n1, n2)))

    report_mod.write_report_items(con, "2026-10-23", {("ALL", "movers_up"): []})
    n3 = con.execute("SELECT COUNT(*) FROM report_items WHERE report_date='2026-10-23'").fetchone()[0]
    check("an empty recomputation does NOT erase an earlier good run for the same day",
          n3 == n2, str((n2, n3)))

    report_mod.write_report_items(con, "2026-10-23",
                                   {("ALL", "movers_up"): [("CCC", 1.0, "CCC rose 1%")]})
    n4 = con.execute("SELECT COUNT(*) FROM report_items WHERE report_date='2026-10-23'").fetchone()[0]
    check("a real recomputation DOES replace the block (not merge/accumulate)", n4 == 1, str(n4))


def test_compute_report_and_rendering(report_mod, common):
    print("\n[compute_report + render_full_report_text round trip]")
    db_path, con = new_db()
    con.executescript(common.SCHEMA)
    seed_instruments(con, [("AAA", "Tech"), ("BBB", "Tech"), ("CCC", "Tech"), ("DDD", "Energy")])
    seed_prices(con, "AAA", [("2026-10-22", 100), ("2026-10-23", 110)])
    seed_prices(con, "BBB", [("2026-10-22", 50), ("2026-10-23", 45)])
    seed_prices(con, "CCC", [("2026-10-22", 10), ("2026-10-23", 9)])
    seed_prices(con, "DDD", [("2026-10-22", 30), ("2026-10-23", 33)])
    con.executemany("INSERT INTO tags (ticker, exchange, tag) VALUES (?, 'US', ?)",
                     [("AAA", "ai_hardware"), ("DDD", "frontier_llm")])
    con.commit()

    pct, _dates = common.daily_pct_changes(con, "US")
    blocks, matrix_summary = report_mod.compute_report(con, pct)
    check("movers_up contains only AAA/DDD (the real gainers)",
          {t for t, _v, _txt in blocks[("ALL", "movers_up")]} == {"AAA", "DDD"}, str(blocks[("ALL", "movers_up")]))
    check("movers_down contains only BBB/CCC (the real decliners)",
          {t for t, _v, _txt in blocks[("ALL", "movers_down")]} == {"BBB", "CCC"}, str(blocks[("ALL", "movers_down")]))
    check("a matrix summary is produced", bool(matrix_summary) and "gainers" in matrix_summary.lower(), matrix_summary)
    check("the AI hardware watch block is populated from the tagged ticker",
          {t for t, _v, _txt in blocks[("ALL", "ai_watch_hw")]} == {"AAA"}, str(blocks[("ALL", "ai_watch_hw")]))
    check("the frontier LLM watch block is populated from the tagged ticker",
          {t for t, _v, _txt in blocks[("ALL", "ai_watch_llm")]} == {"DDD"}, str(blocks[("ALL", "ai_watch_llm")]))
    check("the matrix summary names the biggest AI-watch mover",
          "AI watch:" in matrix_summary, matrix_summary)

    report_mod.write_report_items(con, "2026-10-23", blocks)
    text = common.render_full_report_text(con, "2026-10-23")
    check("the rendered report names the real top gainer", "AAA" in text, text)
    check("the rendered report names the real top decliner", "BBB" in text, text)
    check("the rendered report has its own dedicated Frontier LLM Watch section",
          "Frontier LLM Watch:" in text, text)
    check("the rendered report has its own dedicated AI Hardware Watch section",
          "AI Hardware Watch:" in text, text)
    check("render_full_report_text and the gate's own reader read the same stored rows",
          text == common.render_full_report_text(con, "2026-10-23"))


def test_honesty_split(report_mod, common):
    print("\n[cmd_daily honesty split]")

    # Branch 1: sync never completed -- must say so plainly, never pretend the market was quiet.
    db_path, con = new_db()
    con.executescript(common.SCHEMA)
    con.execute("INSERT INTO sync_state (exchange, last_synced_date, last_error) "
                "VALUES ('US', NULL, '3/500 ticker(s) failed')")
    con.commit()
    common.DB_PATH = db_path
    sent_before = len(report_mod.sent_log if hasattr(report_mod, "sent_log") else [])

    class Args:
        dry_run = True
    report_mod.cmd_daily(Args())
    # dry-run never calls delivery; re-run for real below to check delivery content instead.

    class ArgsReal:
        dry_run = False
    sent = report_mod._test_sent_log
    sent.clear()
    report_mod.cmd_daily(ArgsReal())
    check("a failed sync produces a 'COULD NOT CHECK' email, never a quiet-market report",
          sent and "COULD NOT CHECK" in sent[0][2], str(sent))
    check("the Matrix notice also states the sync failure, not a fabricated quiet day",
          any(ch == "matrix" and "COULD NOT CHECK" in text for ch, text in
              [(c[0], c[1] if c[0] == "matrix" else c[2]) for c in sent]), str(sent))

    # Branch 2: fewer than two trading dates on file -- genuinely "nothing new" yet.
    db_path2, con2 = new_db()
    con2.executescript(common.SCHEMA)
    seed_prices(con2, "AAA", [("2026-10-23", 100)])
    con2.commit()
    common.DB_PATH = db_path2
    sent.clear()
    report_mod.cmd_daily(ArgsReal())
    check("fewer than two trading dates reports 'nothing new', not an error",
          sent and "nothing new" in sent[0][2].lower(), str(sent))

    # Branch 3: real data -- a real computed report is actually delivered on both channels.
    db_path3, con3 = new_db()
    con3.executescript(common.SCHEMA)
    seed_instruments(con3, [("AAA", "Tech"), ("BBB", "Tech"), ("CCC", "Tech")])
    seed_prices(con3, "AAA", [("2026-10-22", 100), ("2026-10-23", 110)])
    seed_prices(con3, "BBB", [("2026-10-22", 50), ("2026-10-23", 45)])
    seed_prices(con3, "CCC", [("2026-10-22", 10), ("2026-10-23", 11)])
    con3.commit()
    common.DB_PATH = db_path3
    sent.clear()
    report_mod.cmd_daily(ArgsReal())
    check("a real run sends exactly one email and one Matrix notice",
          sum(1 for c in sent if c[0] == "email") == 1 and sum(1 for c in sent if c[0] == "matrix") == 1,
          str(sent))
    check("the delivered email names a real mover", "AAA" in sent[0][2], sent[0][2])


def main():
    common = import_common()
    test_pct_change(common)
    test_daily_and_trend30(common)
    test_group_trend(common)
    test_top_n(common)
    test_render_lines(common)
    test_ai_watch(common)

    report_mod, sent_log = load_report_module()
    report_mod._test_sent_log = sent_log
    test_write_report_items(report_mod, common)
    test_compute_report_and_rendering(report_mod, common)
    test_honesty_split(report_mod, common)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
