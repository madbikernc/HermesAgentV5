#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-24) - S38g, direct operator request: a dedicated per-ticker report section for
# the two curated AI watchlists tags.yaml now seeds ("frontier_llm", "ai_hardware") -- "special
# attention" beyond the one aggregate line those tags already got in the existing tag_trend
# section. compute_report() now also calls hermes_market_common.ai_watch_block() for each;
# matrix_summary gains one line naming whichever watchlist ticker moved the most today.
#
# hermes-market-report — S38d. Computes sector/tag trend, movers, and 30-day trend from
# hermes_market_common's `prices`/`instruments`/`tags` tables, writes the result to
# `report_items`, and delivers it by email (hermes_alert_common.send_email()) and a short Matrix
# notice (hermes_alert_common.matrix_notice()) — both on the same run (MARKET_WATCH_DESIGN.md §7).
# No model call anywhere in this pipeline: every number is computed deterministically.
#
# ── one correction made while building this, against the design doc's own §5 schema ──
# §5 leaves `category`/`item_type` `[PROPOSED]` and an earlier draft of this build's own plan had
# sector_trend/tag_trend rows use the sector/tag's own name as `category` (with movers/trend30
# using a fixed "ALL"). That is inconsistent and pointless: report_items' PRIMARY KEY is
# (report_date, category, item_type, rank), and when category already uniquely identifies the
# row, rank stops doing any real work. Every item_type here uses category="ALL" uniformly —
# there is exactly one sector-trend report per day, not one per sector — so `rank` is what
# actually orders the N rows under it, the same way news_digest_daily's `topic` groups N
# highlights under `rank`.
#
# ── the write-then-read-back pattern ──
# write_report_items() stores this run's blocks, then cmd_daily() calls
# hermes_market_common.render_full_report_text() to build the email body FROM THE STORED ROWS,
# not from the in-memory blocks that produced them — the exact same function
# hermes-market-gate.py's `market report` command calls. The two can therefore never show
# different text for the same report_date.
#
# Usage:
#   hermes-market-report.py daily [--dry-run]
import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import hermes_market_common as common  # noqa: E402
import hermes_alert_common as alert  # noqa: E402

TOP_N_MOVERS = 10
TOP_N_TREND30 = 10


def log(msg):
    print(f"[hermes-market-report] {msg}", flush=True)


def write_report_items(conn, report_date, blocks):
    """blocks: {(category, item_type): [(ticker_or_group, metric_value, text), ...]}, already
    ranked (list order = rank). Only replaces a block that actually has rows — an empty
    recomputation must never erase an earlier good run's rows for the same report_date, the
    exact live bug class hermes-news-digest.py's news_digest_daily hit once (2026-10-09): its
    DELETE used to run unconditionally, so a later same-day run that found nothing erased an
    earlier run's real data."""
    for (category, item_type), items in blocks.items():
        if not items:
            continue
        conn.execute("DELETE FROM report_items WHERE report_date=? AND category=? AND item_type=?",
                      (report_date, category, item_type))
        for rank, (group, value, text) in enumerate(items, 1):
            conn.execute("""
                INSERT INTO report_items
                (report_date, category, item_type, rank, ticker_or_group, metric_value, text)
                VALUES (?,?,?,?,?,?,?)
            """, (report_date, category, item_type, rank, group, value, text))
    conn.commit()


def _ranked(items, render):
    """items: [(group, value), ...] already in rank order. Returns [(group, value, text), ...]."""
    out = []
    for rank, (group, value) in enumerate(items, 1):
        out.append((group, value, render(group, value, rank)))
    return out


def compute_report(conn, pct_by_ticker):
    """Returns (blocks, matrix_summary). blocks is ready for write_report_items(); matrix_summary
    is the short line set posted to Matrix (MARKET_WATCH_DESIGN.md §7: "a short version...
    visible in Matrix the day it's generated")."""
    blocks = {}

    sectors = common.sector_members(conn, "US")
    sector_trends = common.group_trend(pct_by_ticker, sectors)
    n_sectors = len(sector_trends)
    blocks[("ALL", "sector_trend")] = _ranked(
        [(name, avg) for name, avg, _n in sector_trends],
        lambda name, avg, rank: common.render_sector_line(name, avg, rank, n_sectors))

    tags = common.tag_members(conn, "US")
    tag_trends = common.group_trend(pct_by_ticker, tags)
    n_tags = len(tag_trends)
    blocks[("ALL", "tag_trend")] = _ranked(
        [(name, avg) for name, avg, _n in tag_trends],
        lambda name, avg, rank: common.render_tag_line(name, avg, rank, n_tags))

    # S38g: a dedicated, per-ticker section for each curated AI watchlist -- "special attention"
    # beyond the one aggregate line these two tags already get above in tag_trend.
    trend30_pct, _trend30_date = common.trend30_pct_changes(conn, "US")
    ai_watch_items = {}
    for item_type, tag in common.AI_WATCH_SECTIONS.items():
        items = common.ai_watch_block(conn, tag, pct_by_ticker, trend30_pct)
        blocks[("ALL", item_type)] = items
        ai_watch_items[item_type] = items

    gainers = common.top_n(pct_by_ticker, TOP_N_MOVERS, "up")
    blocks[("ALL", "movers_up")] = _ranked(
        gainers, lambda t, p, rank: common.render_mover_line(t, p, rank, "up"))

    decliners = common.top_n(pct_by_ticker, TOP_N_MOVERS, "down")
    blocks[("ALL", "movers_down")] = _ranked(
        decliners, lambda t, p, rank: common.render_mover_line(t, p, rank, "down"))

    t30_up = common.top_n(trend30_pct, TOP_N_TREND30, "up")
    blocks[("ALL", "trend30_up")] = _ranked(
        t30_up, lambda t, p, rank: common.render_trend30_line(t, p, rank, "up"))
    t30_down = common.top_n(trend30_pct, TOP_N_TREND30, "down")
    blocks[("ALL", "trend30_down")] = _ranked(
        t30_down, lambda t, p, rank: common.render_trend30_line(t, p, rank, "down"))

    summary_bits = []
    if sector_trends:
        summary_bits.append(common.render_sector_line(sector_trends[0][0], sector_trends[0][1], 1, n_sectors))
    if tag_trends:
        summary_bits.append(common.render_tag_line(tag_trends[0][0], tag_trends[0][1], 1, n_tags))
    if gainers:
        summary_bits.append("Top gainers: " + ", ".join(f"{t} +{p:.2f}%" for t, p in gainers[:3]))
    if decliners:
        summary_bits.append("Top decliners: " + ", ".join(f"{t} {p:.2f}%" for t, p in decliners[:3]))
    all_ai_watch = ai_watch_items["ai_watch_llm"] + ai_watch_items["ai_watch_hw"]
    if all_ai_watch:
        biggest = max(all_ai_watch, key=lambda item: abs(item[1]))
        ticker, pct, _text = biggest
        sign = "rose" if pct >= 0 else "fell"
        summary_bits.append(f"AI watch: {ticker} {sign} {abs(pct):.2f}% today.")
    matrix_summary = " ".join(summary_bits) if summary_bits else "No movers today."

    return blocks, matrix_summary


def _preview_report_text(report_date, blocks):
    """A dry-run has nothing written to report_items to read back, so this renders directly from
    the in-memory blocks instead — same section order/titles as
    hermes_market_common.render_full_report_text(), used only for this preview."""
    parts = [f"Market Watch — {report_date}", ""]
    for item_type in common.REPORT_SECTION_ORDER:
        items = blocks.get(("ALL", item_type))
        if not items:
            continue
        parts.append(common.REPORT_SECTION_TITLES[item_type] + ":")
        parts.extend(f"  {text}" for _group, _value, text in items)
        parts.append("")
    return "\n".join(parts).rstrip()


def cmd_daily(args):
    conn = common.connect()
    report_date = datetime.now(timezone.utc).date().isoformat()

    sync_row = conn.execute(
        "SELECT last_synced_date, last_error FROM sync_state WHERE exchange='US'").fetchone()
    pct_by_ticker, dates = common.daily_pct_changes(conn, "US")

    if sync_row and sync_row[1]:
        body = (f"COULD NOT CHECK today's market data — {sync_row[1]}.\n"
                "This is not a report that the market was quiet; today's sync did not complete.")
        matrix_summary = f"COULD NOT CHECK today's market data — {sync_row[1]}."
        log(f"sync incomplete, report not computed: {sync_row[1]}")
    elif len(dates) < 2:
        body = "nothing new — not enough price history yet (need at least two trading days)."
        matrix_summary = body
        log(body)
    else:
        blocks, matrix_summary = compute_report(conn, pct_by_ticker)
        if args.dry_run:
            body = _preview_report_text(report_date, blocks)
        else:
            write_report_items(conn, report_date, blocks)
            body = common.render_full_report_text(conn, report_date)
        log(f"report computed for {report_date}: "
            f"{sum(len(v) for v in blocks.values())} line(s) across "
            f"{sum(1 for v in blocks.values() if v)} section(s)")

    if args.dry_run:
        print(body)
        print("---")
        print(f"[matrix] {matrix_summary}")
        return 0

    alert.send_email(f"Firmament Market Watch — {report_date}", body, log=log)
    alert.matrix_notice(f"[market] {matrix_summary}", log=log)
    return 0


def main():
    ap = argparse.ArgumentParser(description="S38d -- Firmament Market Watch daily report")
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("daily", help="compute, store, and deliver the daily report")
    p.add_argument("--dry-run", action="store_true", help="compute and print; write nothing, send nothing")
    args = ap.parse_args()
    if args.command == "daily":
        return cmd_daily(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
