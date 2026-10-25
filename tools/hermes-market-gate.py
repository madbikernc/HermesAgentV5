#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-25) - S38h: four new commands -- `market tag approve/reject/override <TICKER>`
# and `market tag pending` -- the human approval gate for hermes-market-sync.py's new tag-scout
# (direct operator request: Market Watch should periodically check whether a stock ticker needs
# adding to frontier_llm/ai_hardware; a sector heuristic measured too imprecise, so classification
# runs through an LLM instead, advisory only). `approve` is the first command in this gate that
# opens a WRITE connection to market.db and the first that touches the filesystem outside it --
# both deliberate and narrow: it calls hermes_market_common.append_tag_rule() (atomic
# tempfile-then-rename append to tags.yaml) and then hermes_market_common.apply_tags() so the
# approval takes effect immediately, without waiting for tomorrow's sync. `reject`/`override`
# mirror hermes-model-scout-gate.py's own reject-is-permanent-until-override semantics exactly.
#
# hermes-market-gate — S38e. On-demand FleetOps Matrix commands for Firmament Market Watch
# (MARKET_WATCH_DESIGN.md §8). Shape copied directly from hermes-model-scout-gate.py: an infinite
# poll loop, bounded backward paging through Matrix's /messages endpoint, and a last-seen-
# origin_server_ts cursor persisted to STATE_DIR/state.json. Two deliberate deviations from that
# precedent (and from hermes-self-repair-promote-gate.py, which this gate is otherwise identical
# in spirit to):
#
#   1. Posting goes through hermes_alert_common.matrix_notice() instead of a second
#      hand-rolled raw PUT — that helper already exists and already resolves/caches the same
#      FleetOps credential this gate needs.
#   2. "Always re-fetch and re-check real state, never trust the chat message alone" (the same
#      rule both older gates state as their rule 2) means, here, re-querying market.db fresh via
#      hermes_market_common.connect(readonly=True) on every single command — there is no
#      external task-state service to re-check, since this gate holds no privileged state of its
#      own and makes no model call (MARKET_WATCH_DESIGN.md §8's own intro).
#
# ── grammar ordering hazard, new to this gate ──
# Both older gates' trailing argument is a short single-token id, so their single regex per verb
# never has an ordering question. A GICS sector name is multi-word ("Information Technology"), so
# SECTOR_RE's capture group is `(.+?)`, not `(\S+)` — and SECTOR_LIST_RE MUST be tried before
# SECTOR_RE, or "market sector list" is captured as a sector named "list" instead of matching the
# list command. DISPATCH_ORDER encodes this explicitly rather than relying on dict iteration order.
#
# Config (environment):
#   MATRIX_HOMESERVER      default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN  / FLEETOPS_ROOM — or vault fallback (matrix-fleetops), both resolved
#                          by hermes_alert_common._resolve_fleetops(), the same credential every
#                          other FleetOps-room tool in this fleet uses
#   MARKET_DB              as hermes_market_common.py defines it
#   POLL_SECONDS            default 20
#   MSG_FETCH_PAGE_LIMIT     default 50
#   MSG_FETCH_MAX_PAGES      default 5
#   STATE_DIR                default ~/.hermes/state/market-gate — a last-seen cursor only
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import hermes_market_common as common  # noqa: E402
import hermes_alert_common as alert  # noqa: E402

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167").rstrip("/")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "20"))
MSG_FETCH_PAGE_LIMIT = int(os.environ.get("MSG_FETCH_PAGE_LIMIT", "50"))
MSG_FETCH_MAX_PAGES = int(os.environ.get("MSG_FETCH_MAX_PAGES", "5"))

STATE_DIR = Path(os.environ.get("STATE_DIR", str(Path.home() / ".hermes" / "state" / "market-gate")))
STATE_FILE = STATE_DIR / "state.json"

TOP_N_REPLY = 10

REPORT_RE = re.compile(r"^\s*market\s+report\s*$", re.IGNORECASE)
SECTOR_LIST_RE = re.compile(r"^\s*market\s+sector\s+list\s*$", re.IGNORECASE)
SECTOR_RE = re.compile(r"^\s*market\s+sector\s+(.+?)\s*$", re.IGNORECASE)
MOVERS_RE = re.compile(r"^\s*market\s+movers\s+(up|down)\s*$", re.IGNORECASE)
TREND30_RE = re.compile(r"^\s*market\s+trend30\s+(up|down)\s*$", re.IGNORECASE)
TICKER_RE = re.compile(r"^\s*market\s+ticker\s+(\S+)\s*$", re.IGNORECASE)
TAG_PENDING_RE = re.compile(r"^\s*market\s+tag\s+pending\s*$", re.IGNORECASE)
TAG_APPROVE_RE = re.compile(r"^\s*market\s+tag\s+approve\s+(\S+)\s*$", re.IGNORECASE)
TAG_REJECT_RE = re.compile(r"^\s*market\s+tag\s+reject\s+(\S+)\s*$", re.IGNORECASE)
TAG_OVERRIDE_RE = re.compile(r"^\s*market\s+tag\s+override\s+(\S+)\s*$", re.IGNORECASE)


def log(msg):
    print(f"[hermes-market-gate] {msg}", flush=True)


# ── command handlers -- each re-queries market.db fresh, never cached ──────────────────────────

def handle_report():
    conn = common.connect(readonly=True)
    report_date = common.latest_report_date(conn)
    if not report_date:
        return ("[market] No daily report has been generated yet — "
                "hermes-market-report.py has not run successfully.")
    return f"[market] {common.render_full_report_text(conn, report_date)}"


def handle_sector_list():
    conn = common.connect(readonly=True)
    sectors = [r[0] for r in conn.execute(
        "SELECT DISTINCT sector FROM instruments WHERE exchange='US' AND sector IS NOT NULL "
        "ORDER BY sector").fetchall()]
    tags = [r[0] for r in conn.execute(
        "SELECT DISTINCT tag FROM tags WHERE exchange='US' ORDER BY tag").fetchall()]
    if not sectors and not tags:
        return "[market] No sectors on file yet — hermes-market-sync.py has not run."
    return ("[market] Sectors: " + (", ".join(sectors) if sectors else "(none)") + "\n"
            "Thematic tags: " + (", ".join(tags) if tags else "(none)"))


def handle_sector(name):
    conn = common.connect(readonly=True)
    name = name.strip()
    sector_hit = conn.execute(
        "SELECT DISTINCT sector FROM instruments WHERE exchange='US' AND sector = ? COLLATE NOCASE",
        (name,)).fetchone()
    tag_hit = conn.execute(
        "SELECT DISTINCT tag FROM tags WHERE exchange='US' AND tag = ? COLLATE NOCASE",
        (name,)).fetchone()
    if not sector_hit and not tag_hit:
        return (f"[market] Unknown sector/tag {name!r} — not in today's data. "
                f"Reply \"market sector list\" for the real list.")

    pct_by_ticker, dates = common.daily_pct_changes(conn, "US")
    if len(dates) < 2:
        return "[market] Not enough price history yet to compute a sector/tag trend."

    if sector_hit:
        real_name = sector_hit[0]
        members = common.sector_members(conn, "US").get(real_name, [])
    else:
        real_name = tag_hit[0]
        members = common.tag_members(conn, "US").get(real_name, [])

    vals = [pct_by_ticker[t] for t in members if t in pct_by_ticker]
    if len(vals) < common.MIN_MEMBERS_FOR_TREND:
        return f"[market] {real_name} has too few tickers with today's data to report a trend."
    avg = sum(vals) / len(vals)
    sign = "rose" if avg >= 0 else "fell"
    shown = sorted(members)[:25]
    more = "" if len(members) <= 25 else f" (+{len(members) - 25} more)"
    return (f"[market] {real_name} {sign} {abs(avg):.2f}% today across {len(vals)} name(s) "
            f"with data. Constituents: {', '.join(shown)}{more}")


def handle_movers(direction):
    conn = common.connect(readonly=True)
    pct_by_ticker, dates = common.daily_pct_changes(conn, "US")
    if len(dates) < 2:
        return ("[market] Not enough price history yet to compute movers — "
                "hermes-market-sync.py needs at least two days of data.")
    items = common.top_n(pct_by_ticker, TOP_N_REPLY, direction)
    if not items:
        return "[market] No movers to report today."
    lines = [common.render_mover_line(t, p, rank, direction) for rank, (t, p) in enumerate(items, 1)]
    return "[market] " + "\n".join(lines)


def handle_trend30(direction):
    conn = common.connect(readonly=True)
    trend30_pct, _latest = common.trend30_pct_changes(conn, "US")
    if not trend30_pct:
        return ("[market] Not enough price history yet for a 30-day trend — need at least "
                f"~{common.MIN_TREND30_SPAN_DAYS} trading days since the first sync.")
    items = common.top_n(trend30_pct, TOP_N_REPLY, direction)
    lines = [common.render_trend30_line(t, p, rank, direction) for rank, (t, p) in enumerate(items, 1)]
    return "[market] " + "\n".join(lines)


def handle_ticker(sym):
    conn = common.connect(readonly=True)
    sym = sym.upper()
    row = conn.execute(
        "SELECT name, sector, industry FROM instruments WHERE ticker=? AND exchange='US'",
        (sym,)).fetchone()
    if not row:
        return f"[market] Unknown ticker {sym!r} — not in today's S&P 500 universe."
    name, sector, industry = row
    bits = [f"{sym} — {name} ({sector or 'unknown sector'} / {industry or 'unknown industry'})"]

    prices = conn.execute(
        "SELECT date, adj_close FROM prices WHERE ticker=? AND exchange='US' "
        "ORDER BY date DESC LIMIT 2", (sym,)).fetchall()
    if len(prices) == 2:
        (d1, c1), (d2, c2) = prices
        pct = common.pct_change(c1, c2)
        if pct is not None:
            sign = "rose" if pct >= 0 else "fell"
            bits.append(f"{d1}: {c1:.2f}, {sign} {abs(pct):.2f}% from {d2} ({c2:.2f}).")
    elif len(prices) == 1:
        bits.append(f"{prices[0][0]}: {prices[0][1]:.2f} (only one day of price history on file).")
    else:
        bits.append("No price history on file yet.")

    trend30_pct, _latest = common.trend30_pct_changes(conn, "US")
    if sym in trend30_pct:
        p = trend30_pct[sym]
        sign = "rose" if p >= 0 else "fell"
        bits.append(f"30-day: {sign} {abs(p):.2f}%.")
    return "[market] " + " ".join(bits)


# ── tag-scout approval gate (S38h) ──────────────────────────────────────────────────────────────

def handle_tag_pending():
    conn = common.connect(readonly=True)
    rows = conn.execute("SELECT ticker, candidate_tag, rationale FROM tag_proposals "
                         "WHERE exchange='US' AND state='proposed' ORDER BY ticker").fetchall()
    if not rows:
        return "[market] No pending tag proposals."
    lines = [f"{t} -> {tag}: \"{r}\"" for t, tag, r in rows]
    return "[market] Pending tag proposals:\n" + "\n".join(lines)


def handle_tag_approve(ticker):
    ticker = ticker.upper()
    # First handler in this gate that opens a WRITE connection, and the first that touches the
    # filesystem outside market.db -- see header note.
    conn = common.connect(readonly=False)
    row = conn.execute("SELECT candidate_tag, state FROM tag_proposals WHERE ticker=? AND exchange='US'",
                        (ticker,)).fetchone()
    if not row:
        return f"[market] No tag proposal on file for {ticker!r}."
    tag, state = row
    if state != "proposed":
        return f"[market] {ticker}'s proposal ({tag}) is already {state!r} -- ignoring."
    ok, err = common.append_tag_rule(tag, ticker)
    if not ok:
        return f"[market] Could not write tags.yaml for {ticker}: {err}. Still pending -- try again."
    conn.execute("UPDATE tag_proposals SET state='approved', decided_at=? WHERE ticker=? AND exchange='US'",
                 (datetime.now(timezone.utc).isoformat(), ticker))
    conn.commit()
    count, _bad = common.apply_tags(conn)  # re-apply immediately, no waiting for tomorrow's sync
    return (f"[market] Approved: {ticker} added to {tag} in tags.yaml and applied immediately "
            f"({count} pair(s) total).")


def handle_tag_reject(ticker):
    ticker = ticker.upper()
    conn = common.connect(readonly=False)
    row = conn.execute("SELECT candidate_tag, state FROM tag_proposals WHERE ticker=? AND exchange='US'",
                        (ticker,)).fetchone()
    if not row:
        return f"[market] No tag proposal on file for {ticker!r}."
    tag, state = row
    if state != "proposed":
        return f"[market] {ticker}'s proposal ({tag}) is already {state!r} -- ignoring."
    conn.execute("UPDATE tag_proposals SET state='rejected', decided_at=? WHERE ticker=? AND exchange='US'",
                 (datetime.now(timezone.utc).isoformat(), ticker))
    conn.commit()
    return (f"[market] {ticker} rejected as {tag}, permanently -- it will never be re-proposed. "
            f"The only way back is \"market tag override {ticker}\".")


def handle_tag_override(ticker):
    ticker = ticker.upper()
    conn = common.connect(readonly=False)
    row = conn.execute("SELECT candidate_tag, state FROM tag_proposals WHERE ticker=? AND exchange='US'",
                        (ticker,)).fetchone()
    if not row:
        return f"[market] No tag proposal on file for {ticker!r}."
    tag, state = row
    if state != "rejected":
        return f"[market] {ticker}'s proposal ({tag}) is {state!r}, not rejected -- nothing to override."
    conn.execute("UPDATE tag_proposals SET state='proposed', decided_at=NULL WHERE ticker=? AND exchange='US'",
                 (ticker,))
    conn.commit()
    return (f"[market] {ticker} un-rejected and back to proposed ({tag}), on an explicit reply. "
            f"Reply \"market tag approve {ticker}\" to apply it.")


DISPATCH_ORDER = [
    (REPORT_RE, lambda m: handle_report()),
    (SECTOR_LIST_RE, lambda m: handle_sector_list()),
    (SECTOR_RE, lambda m: handle_sector(m.group(1))),
    (MOVERS_RE, lambda m: handle_movers(m.group(1).lower())),
    (TREND30_RE, lambda m: handle_trend30(m.group(1).lower())),
    (TICKER_RE, lambda m: handle_ticker(m.group(1))),
    (TAG_PENDING_RE, lambda m: handle_tag_pending()),
    (TAG_APPROVE_RE, lambda m: handle_tag_approve(m.group(1))),
    (TAG_REJECT_RE, lambda m: handle_tag_reject(m.group(1))),
    (TAG_OVERRIDE_RE, lambda m: handle_tag_override(m.group(1))),
]


def dispatch_command(body):
    """Returns a reply string, or None if `body` matches no command at all (not this gate's
    concern — e.g. a plain chat message, or another gate's own grammar)."""
    for pattern, handler in DISPATCH_ORDER:
        m = pattern.match(body)
        if m:
            return handler(m)
    return None


# ── Matrix polling, copied from hermes-model-scout-gate.py's fetch_messages_since() ─────────────

def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def fetch_messages_since(since_ts, token, room):
    """Bounded backward paging, same shape as both older gates: one fixed page can miss a
    command under room traffic."""
    all_events = []
    from_token = None
    for _ in range(MSG_FETCH_MAX_PAGES):
        url = (f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/{urllib.parse.quote(room)}"
               f"/messages?dir=b&limit={MSG_FETCH_PAGE_LIMIT}")
        if from_token:
            url += f"&from={urllib.parse.quote(from_token)}"
        resp = _get(url, token)
        chunk = resp.get("chunk", [])
        all_events.extend(chunk)
        oldest_ts = min((e.get("origin_server_ts", 0) for e in chunk), default=0)
        from_token = resp.get("end")
        if not from_token or len(chunk) < MSG_FETCH_PAGE_LIMIT or (oldest_ts and oldest_ts <= since_ts):
            break
    return all_events


def load_state():
    if not STATE_FILE.exists():
        return {"last_ts": 0}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"last_ts": 0}


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state))


def poll_once(state):
    # alert._resolve_fleetops() reaches into hermes_alert_common's own internal resolver rather
    # than reimplementing env-var-first-then-vault here a third time; matrix_notice() below
    # resolves (and caches) the same credential independently for the write side.
    token, room = alert._resolve_fleetops()
    if not token or not room:
        log("no FleetOps Matrix credentials resolved (env or vault matrix-fleetops) — "
            "skipping this poll")
        return
    events = fetch_messages_since(state["last_ts"], token, room)
    new_events = sorted(
        (e for e in events if e.get("type") == "m.room.message"
         and e.get("origin_server_ts", 0) > state["last_ts"]
         and e.get("content", {}).get("msgtype") == "m.text"),
        key=lambda e: e["origin_server_ts"],
    )
    for event in new_events:
        body = event.get("content", {}).get("body", "")
        try:
            reply = dispatch_command(body)
        except Exception as exc:
            log(f"command failed ({body!r}): {exc}")
            reply = ("[market] Could not read market data right now — "
                     "hermes-market-sync.py may not have run yet. Try again shortly.")
        if reply is not None:
            log(f"handled: {body!r}")
            alert.matrix_notice(reply, log=log)
        state["last_ts"] = event["origin_server_ts"]
    save_state(state)


def main():
    token, room = alert._resolve_fleetops()
    if not token or not room:
        sys.exit("no FleetOps Matrix credentials available (set FLEETOPS_MATRIX_TOKEN/"
                 "FLEETOPS_ROOM, or ensure vault item matrix-fleetops is reachable)")
    log("watching FleetOps for \"market report|sector <name>|sector list|movers up/down|"
        "trend30 up/down|ticker <SYMBOL>|tag pending|tag approve/reject/override <TICKER>\", "
        f"polling every {POLL_SECONDS}s")
    state = load_state()
    while True:
        try:
            poll_once(state)
        except Exception as exc:
            log(f"poll error, continuing: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
