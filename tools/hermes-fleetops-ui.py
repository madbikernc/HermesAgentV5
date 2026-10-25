#!/usr/bin/env python3
# Version: 2.8.0
#
# 2.8.0 (2026-10-25) — direct operator request to enhance /market's "detail" column: every
# ticker-level line (movers, 30-day trend, the two AI-watch sections) now names the registered
# company in parens right after its ticker ("MSFT (Microsoft) rose..."), via a fresh
# ticker->name lookup against `instruments` — a FleetOps-UI-only cosmetic splice
# (with_company_name()) that never touches the stored report_items.text the email/Matrix/gate
# paths also render from. Sector/tag-trend rows are excluded by item_type allowlist
# (TICKER_LEVEL_ITEM_TYPES), not just by the splice's own startswith() guard, since some of
# those lines also happen to start with a sector/tag NAME followed by a space. Also: the daily
# report's single flat table (one row per item, a repeated "section" column) is now one table
# per section, each under its own <h3 class="mkt-sec"> divider/title, with "#" (rank) leading
# each section's own columns instead of "section" leading a shared one — direct operator
# request. The row-count cap (MAX_MARKET_ROWS) now counts across all sections combined rather
# than one flat list.
#
# 2.7.0 (2026-10-25) — direct operator request: /benchmarks' "Current" table gets a role filter,
# a high-to-low score sort, and the value column now shows `value/highest` whenever a HIGHER
# score for the exact same role/suite/metric has been recorded by any model_id. The grouping key
# is (role_or_endpoint, suite, metric) rather than suite/metric alone, because every eval tool
# writes role_or_endpoint as the fleet ROLE it is scoring a candidate *for* regardless of which
# model_id is actually behind the endpoint (hermes-vision-judge-eval.py always writes "omni") —
# so grouping on it is exactly "every result anyone has recorded for this role's suite", computed
# off the same latest-per-model snapshot the table already builds, not the full historical peak.
# fmt_value() gained an optional `best` parameter (default None, so render_history_all()'s own
# per-run summary line, and the existing offline tests calling it with one argument, are
# unaffected); render_history_current() gained `role_filter`/`sort_by_score` parameters, so
# page_benchmarks() now takes `query` like every other page here, and the /benchmarks route entry
# changed from a wrapping lambda to a direct reference to match.
#
# 2.6.0 (2026-10-25) — direct operator request: a new /market page (S38i, fulfilling
# MARKET_WATCH_DESIGN.md §9's long-deferred "browsable report history" once S38's own data
# existed to browse). Reads report_items/tag_proposals through hermes_market_common.py — the
# exact same shared module hermes-market-report.py and hermes-market-gate.py already compute and
# render from, so this page can never show different numbers for the same day than the daily
# email/Matrix notice or a `market report` gate reply. A plain top-level import, not the
# load_gate()-style lazy/fallback machinery: that machinery exists because the scout gate carries
# write credentials and a transition table whose corruption is a meaningfully different risk;
# hermes_market_common.py is a stdlib-only schema/compute module, the same character of dependency
# hermes-market-report.py/hermes-market-sync.py already import unconditionally. Read-only, no new
# write route — a second, generic "Pending tag candidate proposals" section names what's awaiting
# a human reply but still points at the FleetOps Matrix `market tag approve/reject` commands to
# act on it, the same "decide stays a Matrix reply, not a button here" line /recommendations
# already draws for its own REC-<node> findings.
#
# 2.5.0 (2026-10-25) — direct operator request: /recommendations now leads with a "Recommended
# model swaps" section, ahead of the existing REC-<node> security findings, surfacing the S39
# spark2 candidate-benchmark run's own outperformance findings (infra/model-benchmark/
# spark2-candidate-results.md) -- a staged candidate beating the real LIVE incumbent on the
# identical suite, same day, same methodology. MODEL_SWAP_RECOMMENDATIONS is a curated list, not a
# queried one: unlike every other section on this page, there is no live store yet for "a
# candidate beat an incumbent", so this is hand-maintained alongside spark2-candidate-results.md
# and says so on the page. render_swap_recommendations() is new; render_recommendations() and
# read_recommendations() are untouched.
#
# hermes-fleetops-ui — one browser page for the fleet's human-facing surfaces (S21).
#
# ── SCOPE ──
#
# Read-only reports, plus ONE write route: the model-scout backlog's decide buttons.
#
# Services are still not started, stopped or restarted from here. That stays an SSH + `systemctl`
# operator action, like every other privileged action in this fleet (`tools/hermes-confirm-gate.sh`
# exists for that reason).
#
# ── The decide buttons, and the argument that was had about them ──
#
# 1.0.0 deliberately had no decide buttons, on the reasoning that a button here would be "a second,
# weaker path to the same privileged decision — shared Basic Auth against one specific Matrix
# sender id." **The operator overruled that, on the grounds that the Matrix channel is *perceived*
# to be more secure rather than actually being so, and that is a fair reading**: the Matrix path
# authenticates a sender id on a homeserver this fleet runs itself, and this path authenticates a
# credential on a tailnet-bound service. Both come down to one credential the operator holds, and
# neither is obviously the stronger.
#
# There is exactly one difference that is NOT perceptual, and it is handled rather than argued
# about: **a browser replays Basic Auth automatically, so a cross-origin page can cause a POST that
# Matrix has no equivalent of.** Hence `csrf_ok()` below — a per-process token that an attacker
# cannot read cross-origin, plus a `Sec-Fetch-Site` check. A decide without both is refused.
#
# **So this service does now hold write credentials**, which 1.0.0 did not: a hermes-memory token
# and the FleetOps Matrix credential. That is a real change in blast radius and is stated plainly
# rather than buried — the memory token is the fleet's single shared one, so it is not scoped to
# model-scout tasks by the server. It is scoped *here* instead: the only write this code can
# perform is a transition drawn from the gate's own table, on a task whose agent is `model-scout`,
# after re-reading the task's current state.
#
# ── Why this imports the gate instead of reimplementing it ──
#
# Two paths to one decision must not be able to disagree about what the decision means. So the
# transitions, the task write, the turn write and the approval text all come from
# `hermes-model-scout-gate.py` itself, imported at startup. If that import fails, the buttons are
# not rendered at all and the route refuses — failing closed, because a UI that guesses at a state
# machine is worse than a UI with no buttons. The only thing this file adds is
# `decided_by: "fleetops-ui"` in the audit record, so the two paths stay distinguishable
# afterwards, and a FleetOps notice so a decision made in a browser is still announced where the
# Matrix path would have announced it.
#
# RAG candidates still have their own UI (`hermes-rag-discovery-portal.py`) and are only linked
# from here, not proxied.
#
# ── Every source degrades on its own ──
#
# Four unrelated stores back these pages (the router's own /v1/models, a usage sqlite, a benchmark
# jsonl on the NAS, and the RAG store's digest table). One being unreachable must not blank the
# others, so each section renders its own error naming its own source. `hermes-usage-report.py`'s
# 1.0.1 fix — a missing-table crash on first run — is the concrete precedent for why that matters.
#
# Config (environment):
#   FLEETOPS_UI_USER / FLEETOPS_UI_PASSWORD   required — HTTP Basic Auth; refuses to start without
#   FLEETOPS_UI_BIND     default 100.96.59.79 (spark's own tailnet IP — never 0.0.0.0)
#   FLEETOPS_UI_PORT     default 8103 (verified free on spark 2026-10-09; 8101 is hermes-buzz,
#                        which the plan had pencilled in as "the obvious next value")
#   ROUTER_URL           default http://127.0.0.1:8080
#   MEMORY_DB            default /mnt/hermes-data/memory/memory.db
#   HERMES_RAG_DB        default /mnt/hermes-data/rag/vectors.db
#   HERMES_USAGE_DB      default ~/.hermes/state/usage.db
#   RAG_PORTAL_URL       default http://100.96.59.79:8093/
#   MARKET_DB            default /mnt/hermes-data/market/market.db (same env var/default as
#                        hermes-market-sync.py/-report.py/-gate.py — one store, read-only here)
import base64
import datetime
import hmac
import html
import json
import os
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Loopback by default since 1.2.0: `tailscale serve` terminates TLS for this service on the tailnet
# and proxies to it here, so the socket itself must not be reachable from the tailnet directly —
# otherwise there is a plaintext way in beside the encrypted one. See `main()`'s bind check.
BIND = os.environ.get("FLEETOPS_UI_BIND", "127.0.0.1")
PORT = int(os.environ.get("FLEETOPS_UI_PORT", "8104"))
USER = os.environ.get("FLEETOPS_UI_USER", "")
PASSWORD = os.environ.get("FLEETOPS_UI_PASSWORD", "")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")

ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")
MEMORY_DB = os.environ.get("MEMORY_DB", "/mnt/hermes-data/memory/memory.db")
RAG_DB = os.environ.get("HERMES_RAG_DB", "/mnt/hermes-data/rag/vectors.db")
USAGE_DB = os.environ.get("HERMES_USAGE_DB", str(Path.home() / ".hermes" / "state" / "usage.db"))
RAG_PORTAL_URL = os.environ.get("RAG_PORTAL_URL", "http://100.96.59.79:8093/")
MARKET_DB = os.environ.get("MARKET_DB", "/mnt/hermes-data/market/market.db")

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
TOPICS_FILE = REPO / "infra" / "hermes-news-digest" / "topics.yaml"

# hermes_market_common.py is an underscore-named module beside this file (not a hyphenated tool
# like the scout gate), so a plain import works -- same shape hermes-market-report.py/
# hermes-market-sync.py already use. sys.path needs the explicit insert because this file is also
# loaded via importlib.util.spec_from_file_location by its own test suite, which does not add its
# directory to sys.path the way running it directly would.
sys.path.insert(0, str(TOOLS))
import hermes_market_common as market_common  # noqa: E402

NAS_HISTORY = Path("/mnt/nas2-hermes-backup/Private/Hermes/Benchmarks/history.jsonl")
LOCAL_HISTORY = Path.home() / ".hermes" / "state" / "benchmark-history.jsonl"

NEWLINE = chr(10)
SCOUT_AGENT = "model-scout"
USAGE_WINDOW_DAYS = 7

# One per process, never persisted. A cross-origin page can make a browser POST here with its
# cached Basic Auth, but it cannot READ this token out of a page it is not same-origin with, so a
# POST that carries it came from a page this service served. A restart invalidates open tabs, which
# costs a reload and is the right trade against storing a long-lived secret for this.
CSRF_TOKEN = secrets.token_urlsafe(32)

# The decision state machine is NOT defined here. It belongs to hermes-model-scout-gate.py, which
# the Matrix path uses, and two routes to one decision must not be able to disagree about what the
# decision means. Imported at startup; on failure `GATE` stays None, the buttons are not rendered
# and the route refuses — failing closed, because a UI guessing at a state machine is worse than a
# UI with no buttons.
GATE = None
GATE_IMPORT_ERROR = ""


def load_gate():
    """Imports hermes-model-scout-gate.py for its transition table and its task/turn writers.

    Safe to import: that file's module level is constants, regexes and function definitions, with
    its own `main()` behind an `if __name__` guard. It reads MEMORY_URL/MEMORY_TOKEN from the
    environment at import time, which is why this is called after the environment is in place."""
    global GATE, GATE_IMPORT_ERROR
    import importlib.util
    path = TOOLS / "hermes-model-scout-gate.py"
    try:
        spec = importlib.util.spec_from_file_location("scoutgate", path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["scoutgate"] = mod
        spec.loader.exec_module(mod)
        for attr in ("TRANSITIONS", "fetch_task", "set_task_state", "write_turn",
                     "candidate_facts", "approval_reply", "AGENT"):
            if not hasattr(mod, attr):
                raise AttributeError(f"hermes-model-scout-gate.py has no {attr!r}")
        GATE = mod
        GATE_IMPORT_ERROR = ""
    except Exception as exc:
        GATE = None
        GATE_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"
        log(f"decide buttons disabled — could not import the scout gate: {GATE_IMPORT_ERROR}")
    return GATE


# What each action is called on its button, and whether it deserves a confirmation prompt. The
# verbs and their legality come from the gate; only the labels are this file's business.
ACTION_LABELS = {
    "benchmark": ("approve for benchmarking", False),
    "defer": ("defer", False),
    "reject": ("reject permanently", True),
    "override": ("un-reject", True),
}

# Fixed outcome clauses, keyed by code. A decide redirects back carrying only these codes and
# integer counts, never a message, so nothing an attacker puts in a URL is rendered as text.
# Each clause is written to follow a number, because one submission can now produce several
# outcomes at once -- "3 applied · 1 skipped, not legal from its current state".
RESULTS = {
    "ok": ("ok", "applied and announced in FleetOps"),
    "stale": ("bad", "skipped, not legal from its current state — someone may have decided it "
                     "first, or this page was stale"),
    "nosuch": ("bad", "skipped, no such task in hermes-memory"),
    "foreign": ("bad", "refused, not a model-scout task"),
    "badaction": ("bad", "refused, unknown action"),
    "writefail": ("bad", "failed, hermes-memory rejected the state write"),
    # Split out of `writefail` on 2026-10-16. The operator hit five of these and the banner said
    # "hermes-memory rejected the state write" -- which was wrong twice over: the failure was on
    # the task LOOKUP, not the write, and no write was ever attempted. Saying so cost real
    # diagnosis time, so a read failure and an auth failure now name themselves.
    "unauthorized": ("bad", "refused by hermes-memory as unauthorized (HTTP 401/403) — this "
                            "service's MEMORY_TOKEN is missing or wrong; nothing was written"),
    "readfail": ("bad", "failed, the task could not be read from hermes-memory — nothing was "
                        "written"),
    "notoken": ("bad", "refused, this service has no MEMORY_TOKEN, so it cannot write at all"),
    "nogate": ("bad", "refused, the scout gate module could not be loaded — this service will not "
                      "guess at the transition rules"),
    "csrf": ("bad", "refused, the request did not come from a page this service served — reload "
                    "and try again"),
    "none": ("bad", "candidates were selected, so nothing was submitted"),
}


def results_query(counts):
    """The redirect's query string: codes and integers only."""
    return "&".join(f"{code}={int(n)}" for code, n in counts.items() if code in RESULTS and n)


def results_banner(query):
    """Renders the outcome from the URL as a count per clause. Every value goes through int(), so
    a hand-edited URL can at worst show a wrong number -- never injected text."""
    parts, worst = [], "ok"
    for code, (kind, clause) in RESULTS.items():
        raw = (query.get(code) or ["0"])[0]
        try:
            n = int(raw)
        except (TypeError, ValueError):
            continue
        if n <= 0:
            continue
        parts.append(f"<b>{n}</b> {esc(clause)}")
        if kind == "bad":
            worst = "bad"
    if not parts:
        return ""
    style = ("border-left:4px solid var(--ok);background:#16241a" if worst == "ok"
             else "border-left:4px solid var(--bad);background:#2a1a1a")
    return (f'<p style="{style};padding:10px 14px;border-radius:3px;margin:0 0 14px">'
            f'{" · ".join(parts)}</p>')

# Hard caps on what any one page renders. Baked in from the start rather than discovered later
# against a table that has grown too large to page through — the RAG portal needed exactly this
# fix the hard way (its 1.2.0/1.4.1), so this one starts with it.
MAX_BACKLOG_ROWS = 400
MAX_HISTORY_ROWS = 400
MAX_HIGHLIGHT_ROWS = 100
MAX_RECOMMENDATION_ROWS = 400
MAX_EGRESS_BLOCK_ROWS = 400
MAX_MARKET_ROWS = 400
MAX_TAG_PROPOSAL_ROWS = 400

STYLE = """
:root { --bg:#12141a; --fg:#e7e9ee; --dim:#9aa3b2; --line:#2a2f3a; --accent:#7fb2ff;
        --bad:#ff8a80; --ok:#86e39b; --warn:#ffd479; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,-apple-system,
       "Segoe UI",Roboto,sans-serif; }
header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:18px;
         align-items:baseline; flex-wrap:wrap; }
header h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.2px; }
nav a { color:var(--accent); text-decoration:none; margin-right:14px; }
nav a:hover { text-decoration:underline; }
main { padding:20px; max-width:1500px; }
h2 { font-size:15px; margin:26px 0 10px; font-weight:600; }
h2:first-child { margin-top:0; }
h3.mkt-sec { font-size:13px; margin:22px 0 8px; padding-top:14px; border-top:1px solid var(--line);
             font-weight:600; color:var(--dim); }
h3.mkt-sec:first-child { margin-top:0; padding-top:0; border-top:none; }
p.note { color:var(--dim); margin:4px 0 14px; max-width:92ch; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line);
        vertical-align:top; }
th { color:var(--dim); font-weight:600; white-space:nowrap; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
code,.mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; }
.err { border:1px solid var(--bad); border-left-width:4px; background:#2a1a1a; padding:10px 14px;
       margin:10px 0; border-radius:3px; }
.err b { color:var(--bad); }
.empty { color:var(--dim); font-style:italic; padding:8px 0; }
.pill { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11px;
        border:1px solid var(--line); }
.s-proposed { color:var(--warn); border-color:var(--warn); }
.s-approved { color:var(--ok); border-color:var(--ok); }
.s-rejected { color:var(--dim); }
.s-done { color:var(--ok); }
.s-deferred { color:var(--dim); }
input[type=search],select { background:#1b1f27; color:var(--fg); border:1px solid var(--line);
       border-radius:3px; padding:5px 8px; font:inherit; }
button { background:#1b1f27; color:var(--accent); border:1px solid var(--line); border-radius:3px;
       padding:4px 10px; font:inherit; cursor:pointer; }
button:hover { border-color:var(--accent); }
.cards { display:flex; gap:14px; flex-wrap:wrap; }
.card { border:1px solid var(--line); border-radius:4px; padding:14px 16px; min-width:260px;
        flex:1 1 300px; }
.card h3 { margin:0 0 6px; font-size:14px; }
.card a { color:var(--accent); text-decoration:none; }
.card p { color:var(--dim); margin:6px 0 0; }
footer { color:var(--dim); padding:18px 20px; border-top:1px solid var(--line); font-size:12px; }
"""

NAV = [("/", "Home"), ("/backlog", "Benchmark backlog"), ("/models", "Models &amp; usage"),
       ("/benchmarks", "Benchmark results"), ("/highlights", "Topic highlights"),
       ("/recommendations", "Recommendations"), ("/egress-blocks", "Egress-guard denials"),
       ("/market", "Market Watch")]


def log(msg):
    print(f"[hermes-fleetops-ui] {msg}", flush=True)


def esc(x):
    """Everything rendered goes through here. Not decoration: these pages show Hugging Face repo
    ids and model-card-derived advisory text (anyone can publish a repo saying anything) and
    LLM-generated digest highlight lines. None of it is trusted markup."""
    return html.escape("" if x is None else str(x), quote=True)


# Every interactive behaviour on these pages lives here, in ONE delegated block, for a reason
# found by reading the response headers: this service sends `default-src 'none'` with no
# `script-src`, so inline `onclick`/`oninput`/`onsubmit` attributes were silently blocked and the
# copy-command button and the benchmark filter box simply did not work in a browser. Attributes
# cannot be nonced -- only elements can -- so the handlers move here and the block carries a
# per-response nonce. No external script is loaded, and nothing here is built from page data.
PAGE_SCRIPT = """
function selected() {
  return document.querySelectorAll('input[name="task_id"]:checked').length;
}
function refresh() {
  var n = selected();
  document.querySelectorAll('[data-count]').forEach(function (el) { el.textContent = n; });
  document.querySelectorAll('[data-needs-selection]').forEach(function (b) { b.disabled = !n; });
}
document.addEventListener('click', function (e) {
  var copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.copy);
    var was = copy.textContent; copy.textContent = 'copied';
    setTimeout(function () { copy.textContent = was; }, 1200);
    return;
  }
  var all = e.target.closest('[data-select]');
  if (all) {
    var on = all.dataset.select === 'all';
    document.querySelectorAll('input[name="task_id"]').forEach(function (b) { b.checked = on; });
    refresh();
    return;
  }
  var act = e.target.closest('button[data-confirm]');
  if (act) {
    var n = selected();
    if (!n) { e.preventDefault(); return; }
    if (!window.confirm(act.dataset.confirm.replace('{n}', n))) { e.preventDefault(); }
  }
});
document.addEventListener('change', function (e) {
  if (e.target.name === 'task_id') { refresh(); }
});
document.addEventListener('input', function (e) {
  var box = e.target.closest('[data-filter]');
  if (!box) { return; }
  var v = box.value.toLowerCase();
  document.querySelectorAll(box.dataset.filter + ' tbody tr').forEach(function (r) {
    r.style.display = r.textContent.toLowerCase().indexOf(v) < 0 ? 'none' : '';
  });
});
refresh();
"""


def shell(title, body, subtitle=""):
    nav = "".join(f'<a href="{p}">{n}</a>' for p, n in NAV)
    return (f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            f"<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>{esc(title)} — hermes-fleetops</title><style>{STYLE}</style></head><body>"
            f"<header><h1>hermes-fleetops</h1><nav>{nav}</nav>"
            f"<span style=\"color:var(--dim);margin-left:auto\">{esc(subtitle)}</span></header>"
            f"<main>{body}</main>"
            f"<footer>Reports are read-only. The backlog's decide buttons are this page's only "
            f"write route; starting and stopping services stays an SSH + systemctl action. "
            f"Rendered {esc(datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))}.</footer>"
            f'<script nonce="__CSP_NONCE__">{PAGE_SCRIPT}</script>'
            f"</body></html>").encode()


def section(heading, note, render):
    """Renders one data source, catching its own failure. Risk 1 of S21 in one function: four
    unrelated stores back these pages, and one being down must name itself rather than blanking
    the page or hiding behind a generic "report unavailable"."""
    out = [f"<h2>{heading}</h2>"]
    if note:
        out.append(f'<p class="note">{note}</p>')
    try:
        out.append(render())
    except Exception as exc:
        out.append(f'<div class="err"><b>This section is unavailable.</b> '
                   f'{esc(type(exc).__name__)}: {esc(exc)}<br>'
                   f'<span class="mono">Every other section on this page is independent of it.'
                   f'</span></div>')
    return "".join(out)


def table(headers, rows, numeric=()):
    if not rows:
        return '<p class="empty">Nothing to show.</p>'
    head = "".join(f"<th>{h}</th>" for h in headers)
    body = []
    for r in rows:
        cells = []
        for i, cell in enumerate(r):
            cls = ' class="num"' if i in numeric else ""
            cells.append(f"<td{cls}>{cell}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def ro_sqlite(path):
    """Read-only by URI, so a bug here cannot write to a store this service has no business
    writing to. A missing file raises rather than silently creating one, which `mode=ro` gives
    for free and a plain connect() would not."""
    conn = sqlite3.connect(f"file:{urllib.parse.quote(str(path))}?mode=ro", uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def when(ts):
    """Timestamps in these stores are not one format — hermes-memory writes float epochs on its
    scout turns and ISO-8601 elsewhere, and the usage log is ISO with an offset. Render whatever
    arrives rather than asserting one shape."""
    if ts in (None, ""):
        return ""
    try:
        f = float(ts)
        if f > 1e11:          # milliseconds
            f /= 1000.0
        return datetime.datetime.fromtimestamp(f).strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        pass
    s = str(ts).replace("Z", "+00:00")
    try:
        return datetime.datetime.fromisoformat(s).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(ts)[:16]


# ── S21a: home ────────────────────────────────────────────────────────────────────────────────

def page_home():
    cards = [
        ("RAG approval UI", RAG_PORTAL_URL,
         "Approve or reject discovered RAG sources. A separate service with its own auth realm, "
         "linked plainly rather than iframed or proxied: embedding it buys nothing but a "
         "mixed-content and X-Frame-Options problem to solve for zero benefit."),
        ("Model benchmark backlog", "/backlog",
         "What hermes-model-scout has proposed, and what state each candidate is in. Read-only — "
         "approving still goes through the Matrix reply the scout gate watches for."),
        ("Models &amp; usage", "/models",
         "Which checkpoint backs each role right now, read live from the router, beside two "
         "trailing weeks of call volume from the usage log."),
        ("Benchmark results", "/benchmarks",
         "Every recorded benchmark run, newest first, and each model's latest result per suite."),
        ("Topic highlights", "/highlights",
         "The news digest's stored highlights per topic and day — including the ones ranked past "
         "the email's cap, which are otherwise never seen."),
        ("Recommendations", "/recommendations",
         "Leads with curated benchmark-driven model-swap candidates from the S39 spark2 run, "
         "then security/integrity findings written to hermes-memory by the fleet's scanners — "
         "aide/lynis/syft+grype on spark/spark-2/HomeD13, the LinodeMercury watch, and any future "
         "node that writes the same REC-&lt;node&gt;-&lt;date&gt;-&lt;seq&gt; shape. Read-only."),
        ("Egress-guard denials", "/egress-blocks",
         "Every outbound destination the Layer 3 egress guard (S40) has denied — each one "
         "already triggered its own Matrix notice and hi-pri email; this is the durable record. "
         "Read-only."),
        ("Market Watch", "/market",
         "The daily sector/tag-trend, movers, and 30-day-trend report (S38), plus the frontier-LLM "
         "and AI-hardware watchlists and any tag candidate the LLM-judged scout (S38h) has "
         "proposed and is awaiting a human reply on. Read-only."),
    ]
    body = ['<p class="note">Read-only views over data this fleet already produces. '
            'Nothing here starts, stops or approves anything.</p><div class="cards">']
    for title, href, desc in cards:
        body.append(f'<div class="card"><h3><a href="{esc(href)}">{title}</a></h3>'
                    f'<p>{desc}</p></div>')
    body.append("</div>")
    return shell("Home", "".join(body))


# ── S21b: model benchmark backlog ─────────────────────────────────────────────────────────────

def read_backlog():
    """hermes-memory has no task-list route — `/tasks` is POST-only (upsert), and the plan's
    assumption that this could use `GET /tasks` is wrong. `hermes-model-scout.py`'s own
    `list_scout_tasks()` already established the answer and the reason: read the one non-vector
    table read-only with stdlib sqlite3, because `hermes-memory.connect()` loads sqlite-vec and
    /usr/bin/python3 cannot see that extension. Same MEMORY_DB env var, so the two stay in step.

    The cost is a direct dependency on the `tasks`/`turns` column names, shared with
    `hermes-model-scout.py` and `hermes-attention-reminder.py` — a schema change breaks all three
    in the same place, loudly."""
    conn = ro_sqlite(MEMORY_DB)
    try:
        tasks = conn.execute(
            "SELECT id, state, topic, created_at, updated_at FROM tasks WHERE agent=? "
            "ORDER BY updated_at DESC LIMIT ?", (SCOUT_AGENT, MAX_BACKLOG_ROWS)).fetchall()
        detail = {}
        for t in tasks:
            row = conn.execute(
                "SELECT raw FROM turns WHERE task_id=? ORDER BY id DESC LIMIT 1",
                (t["id"],)).fetchone()
            payload = {}
            if row and row["raw"]:
                try:
                    payload = json.loads(row["raw"])
                except (ValueError, TypeError):
                    payload = {}
            detail[t["id"]] = payload if isinstance(payload, dict) else {}
        return [dict(t) for t in tasks], detail
    finally:
        conn.close()


def decide_unavailable():
    """Why the decide buttons cannot work right now, or "" when they can.

    Checked at render time as well as on the route, because 2026-10-16 showed the failure mode
    this prevents: the service came up during the post-reboot vault contention, its wrapper
    fetches MEMORY_TOKEN with `|| true`, the fetch failed, and the page then rendered decide
    buttons for five days that could not possibly work. `main()` logged DISABLED at startup and
    the page never said a word. **A page must not offer an action it already knows it cannot
    perform.**"""
    if not GATE:
        return (f"the scout gate module could not be imported, so this page will not guess at the "
                f"transition rules ({GATE_IMPORT_ERROR})")
    if not MEMORY_TOKEN:
        return ("this service has no MEMORY_TOKEN, so it cannot write to hermes-memory. Its "
                "wrapper fetches that credential best-effort; a restart re-fetches it")
    return ""


def legal_actions(state):
    """Which buttons a row gets, derived from the gate's table rather than a list kept here. An
    unknown state yields nothing, which is the safe direction."""
    if not GATE:
        return []
    return [a for a, (legal_from, _to) in GATE.TRANSITIONS.items() if state in legal_from]


def csrf_ok(headers, token):
    """Two checks, because a browser attaches cached Basic Auth to a cross-origin POST on its own.

    The token is the real defence: same-origin policy stops an attacker's page reading it out of
    ours. `Sec-Fetch-Site` is a cheap second line that modern browsers send unprompted — absent on
    old clients and on curl, so it is only allowed to *reject*, never to substitute for the token."""
    site = (headers.get("Sec-Fetch-Site") or "").strip().lower()
    if site and site not in ("same-origin", "none"):
        return False
    return bool(token) and hmac.compare_digest(token, CSRF_TOKEN)


def tailnet_identity(headers):
    """Who clicked, according to the Tailscale proxy in front of this service.

    `tailscale serve` injects `Tailscale-User-Login`/`-Name` (documented at the URL it also sends
    in `Tailscale-Headers-Info`). Recorded in the audit trail because it is strictly better
    attribution than this page's shared Basic Auth can give: "Paul <x@y>" rather than "whoever
    knows the fleetops password". The Matrix route identifies a sender id, so this closes the one
    genuine gap that route had.

    **Attribution, never authentication.** These headers are only as trustworthy as the loopback
    socket they arrive on — any local process could set them — so Basic Auth stays the thing that
    decides whether a request is allowed. If the proxy is bypassed or the headers are absent, this
    returns "" and the record simply says the route without the person."""
    login = (headers.get("Tailscale-User-Login") or "").strip()
    name = (headers.get("Tailscale-User-Name") or "").strip()
    if login and name:
        return f"{name} <{login}>"
    return login or name or ""


def apply_decision(task_id, action, who=""):
    """One guarded transition. Returns a RESULTS key.

    Deliberately the same sequence of checks `hermes-model-scout-gate.py`'s own `handle_command()`
    makes, in the same order and against the same table: the task must exist, it must belong to the
    model-scout agent, and the action must be legal **from the state read back now** — not from the
    state the page was rendered with, which may be minutes old or already acted on by the Matrix
    path."""
    if not GATE:
        return "nogate"
    if not MEMORY_TOKEN:
        log(f"decide refused for {task_id!r}: no MEMORY_TOKEN, so no write is possible")
        return "notoken"
    if action not in GATE.TRANSITIONS:
        log(f"decide refused for {task_id!r}: unknown action {action!r}")
        return "badaction"
    try:
        task = GATE.fetch_task(task_id)
    except urllib.error.HTTPError as exc:
        # Every branch here logs. The 2026-10-16 incident returned bare "writefail" from a 401 on
        # this READ, with no log line at all, so the journal showed only a 303 and the banner
        # blamed a write that never happened.
        if exc.code == 404:
            log(f"decide: no such task {task_id!r}")
            return "nosuch"
        if exc.code in (401, 403):
            log(f"decide: hermes-memory refused the lookup of {task_id!r} as unauthorized "
                f"(HTTP {exc.code}) — MEMORY_TOKEN missing or wrong")
            return "unauthorized"
        log(f"decide: task lookup for {task_id!r} failed with HTTP {exc.code}")
        return "readfail"
    except Exception as exc:
        log(f"decide: task lookup for {task_id!r} failed: {type(exc).__name__}: {exc}")
        return "readfail"
    if not task:
        log(f"decide: hermes-memory returned nothing for {task_id!r}")
        return "nosuch"
    if task.get("agent") != GATE.AGENT:
        log(f"decide refused for {task_id!r}: belongs to agent {task.get('agent')!r}, "
            f"not {GATE.AGENT!r}")
        return "foreign"

    state = task.get("state")
    legal_from, new_state = GATE.TRANSITIONS[action]
    if state not in legal_from:
        log(f"decide: {action!r} is not legal for {task_id!r} from state {state!r} "
            f"(legal from {sorted(legal_from)})")
        return "stale"

    facts = GATE.candidate_facts(task_id) if action == "benchmark" else {}
    if not GATE.set_task_state(task_id, new_state, topic=task.get("topic")):
        # The gate logs the underlying exception itself; this records which decide it belonged to.
        log(f"decide: hermes-memory rejected the state write for {task_id!r} "
            f"({state} -> {new_state})")
        return "writefail"

    # `decided_by` is the one field this path adds, and the reason it is worth adding: afterwards,
    # the audit record says which route made the decision. The gate writes "fleetops-reply".
    whom = f" by {who}" if who else ""
    GATE.write_turn(task_id, {
        "phase": "transition", "action": action, "from": state, "to": new_state,
        "decided_by": "fleetops-ui", "decided_by_user": who, "at": time.time(),
        "summary": f"{task_id}: {state} -> {new_state} by \"{action}\" (fleetops-ui{whom})",
    })
    log(f"{task_id}: {state} -> {new_state} ({action}) via fleetops-ui{whom}")

    # Announce it where the Matrix path would have. A decision made in a browser that left no trace
    # in FleetOps would be strictly worse than the channel it replaced, so this is not optional --
    # but it is non-fatal, exactly as the gate treats its own turn write: a Matrix outage must not
    # undo a transition the operator already asked for and which is already written.
    try:
        if action == "benchmark":
            GATE.send_room_message(
                GATE.approval_reply(task_id, facts) +
                f"{NEWLINE}(approved in hermes-fleetops-ui{whom}.)")
        else:
            GATE.send_room_message(
                f"[model-scout] {task_id}: {state} -> {new_state} (\"{action}\"), decided in "
                f"hermes-fleetops-ui{whom} rather than by reply here.")
    except Exception as exc:
        log(f"FleetOps notice failed for {task_id} (transition already applied): {exc}")
    return "ok"


def apply_decisions(task_ids, action, who=""):
    """One action over any number of candidates, each guarded on its own.

    Multi-select is a convenience on the rendering side only -- it deliberately does NOT become a
    bulk write. Every task still goes through `apply_decision`, which re-reads that task, checks
    it belongs to model-scout and checks the action is legal from the state it is in *now*. So a
    selection that mixes states does the legal part and reports the rest, rather than failing
    whole or forcing anything through."""
    counts = Counter()
    if not task_ids:
        counts["none"] += 1
        return counts
    for task_id in task_ids:
        counts[apply_decision(task_id, action, who)] += 1
    return counts


def split_task_id(task_id):
    """`scout:<role>:<model id with / written __>` — the encoding hermes-model-scout.py's
    `task_id_for()` applies. Decoded here rather than displayed raw, since the point of the page
    is to read it at a glance."""
    parts = str(task_id).split(":", 2)
    if len(parts) == 3 and parts[0] == "scout":
        return parts[1], parts[2].replace("__", "/")
    return "", str(task_id)


def published(created_at):
    """Publish date plus age, because "how old is this" is a decision input the backlog could not
    answer at all: every one of the 51 live candidates had no date, since the scout fetched HF's
    `createdAt`, used it for its lookback window and then dropped it before writing the candidate
    turn. A repo uploaded four hours ago is a different proposition from one that has been up a
    year, and several of these turned out to be same-day test uploads."""
    if not created_at:
        return '<span class="empty">unknown</span>'
    try:
        when_dt = datetime.datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    except ValueError:
        return esc(str(created_at)[:10])
    days = (datetime.datetime.now(datetime.timezone.utc) - when_dt).days
    if days < 0:
        days = 0
    if days == 0:
        age = "today"
    elif days < 90:
        age = f"{days}d"
    elif days < 730:
        age = f"{days // 30}mo"
    else:
        age = f"{days // 365}y"
    # Anything under a week is flagged, not because new is bad but because the scout's own window
    # is daily: a same-day upload has no download history, no issues and no corroboration yet.
    cls = ' style="color:var(--warn)"' if days <= 7 else ""
    return f'{esc(when_dt.strftime("%Y-%m-%d"))} <span class="mono"{cls}>({esc(age)})</span>'


def size_note(detail):
    """How the size was established, shown because `fit` reads as a measurement either way.
    `gguf-metadata` is the repo's own published figure; `safetensors` is the listing's."""
    src = (detail.get("size_source") or "").strip()
    if not src:
        return ""
    return f' <span class="mono" style="color:var(--dim)">[{esc(src)}]</span>'


def render_backlog():
    blocked = decide_unavailable()
    tasks, detail = read_backlog()
    counts = Counter(t["state"] or "?" for t in tasks)
    summary = " · ".join(f'<span class="pill s-{esc(k)}">{esc(k)} {v}</span>'
                         for k, v in counts.most_common())
    rows = []
    for t in tasks:
        role, model_id = split_task_id(t["id"])
        d = detail.get(t["id"], {})
        state = t["state"] or "?"
        advisory = (d.get("advisory_narrative") or "").strip()
        if not advisory:
            # Distinguish "no advisory was written" from "the advisory is empty", because on
            # 2026-10-09 every candidate had an empty one: the scout's narrative call was itself
            # being blocked by Layer 2 until S27f exempted it (see the guard report for 06:41).
            advisory = '<span class="empty">none recorded</span>'
        else:
            advisory = esc(advisory)
        fit = esc(d.get("fit") or "") + size_note(d)

        legal = [] if blocked else legal_actions(state)
        # One checkbox per actionable row. A row with no legal transition (`approved`, or anything
        # while the gate is unavailable) gets no checkbox at all, so it cannot be swept up by a
        # bulk action it was never eligible for.
        pick = (f'<input type="checkbox" name="task_id" value="{esc(t["id"])}" '
                f'aria-label="select {esc(model_id)}">' if legal and GATE
                else '<span class="empty">—</span>')
        actions = []
        if legal:
            actions.append('<span class="mono" style="color:var(--dim)">' +
                           " · ".join(esc(a) for a in legal) + "</span>")
        if state == "approved":
            # The command the GATE generates, not one composed here. 1.0.0 invented
            # `hermes-benchmark-run.py --model-id ... --role ...`, which does not exist: the real
            # tool is hermes-benchmark-model.sh, it takes `--candidate <local .gguf>` because a
            # scouted repo is not yet on disk, and the --model-id must be the prescribed label or
            # the scout can never mark the task done.
            label = (d.get("prescribed_benchmark_label") or "").strip()
            if label:
                cmd = (f"bash tools/hermes-benchmark-model.sh --candidate /path/to/model.gguf "
                       f"--model-id {label}")
                # type="button" matters: this now sits inside the decide form, and a <button>
                # inside a form submits it by default.
                actions.append(
                    f'<button type="button" data-copy="{esc(cmd)}" title="{esc(cmd)}">'
                    f'copy command</button>')
            else:
                actions.append('<span class="empty">no benchmark label on file</span>')
        copy_cell = " ".join(actions)
        rows.append([
            pick,
            f'<span class="pill s-{esc(state)}">{esc(state)}</span>',
            published(d.get("created_at")),
            esc(role),
            f'<span class="mono">{esc(model_id)}</span>',
            esc(d.get("category") or t["topic"] or ""),
            fit,
            advisory,
            esc(when(t["updated_at"])),
            copy_cell,
        ])
    if not blocked:
        note = (f'{summary}<br>Showing {len(rows)} of at most {MAX_BACKLOG_ROWS}. '
                f'Deciding here writes the same transition, through the same code, as replying '
                f'<span class="mono">benchmark|defer|reject|override &lt;id&gt;</span> in FleetOps '
                f'— and is announced there too, tagged '
                f'<span class="mono">fleetops-ui</span> so the two routes stay distinguishable. '
                f'<b>Reject is permanent</b>; only <span class="mono">un-reject</span> comes back.')
    else:
        note = (f'{summary}<br>Showing {len(rows)} of at most {MAX_BACKLOG_ROWS}. '
                f'<b>Decide buttons are unavailable</b> and are not rendered, because '
                f'{esc(blocked)}. The reports on this page are unaffected.')
    body = f'<p class="note">{note}</p>' + table(
        ["", "state", "published", "role", "candidate", "category", "fit", "advisory",
         "updated", "legal"],
        rows)
    if blocked:
        return ('<p class="err"><b>Decide is unavailable.</b> ' + esc(blocked) +
                '</p>' + body)
    # ONE form around the whole table, because HTML forms cannot nest: that is what makes
    # multi-select possible, and it is why the copy-command button had to become type="button".
    bar = bulk_bar()
    return (f'<form method="post" action="/backlog/decide" data-decide>'
            f'<input type="hidden" name="csrf" value="{esc(CSRF_TOKEN)}">'
            f'{bar}{body}{bar}</form>')


def bulk_bar():
    """The select/act controls, rendered above and below the table since it is 80 rows long."""
    buttons = []
    for act in ("benchmark", "defer", "reject", "override"):
        label, confirm = ACTION_LABELS.get(act, (act, True))
        attrs = 'data-needs-selection'
        if confirm:
            # A UX speed bump, not a security control -- the controls are the CSRF token and the
            # per-task server-side re-check. `reject` is permanent per the gate's own docs, and
            # one click can now carry 77 candidates, so it says how many.
            attrs += (f' data-confirm="{esc(label)} {{n}} candidate(s)?\n\nWritten to '
                      f'hermes-memory and announced in FleetOps."')
        buttons.append(f'<button type="submit" name="action" value="{esc(act)}" {attrs}>'
                       f'{esc(label)} selected</button>')
    return ('<p style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0">'
            '<button type="button" data-select="all">select all</button>'
            '<button type="button" data-select="none">select none</button>'
            '<span class="note" style="margin:0"><b data-count>0</b> selected</span>'
            '<span style="flex:1"></span>' + "".join(buttons) + '</p>')


def page_backlog(query=None):
    body = results_banner(query or {})
    body += section("Model benchmark backlog", "", render_backlog)
    return shell("Benchmark backlog", body)


# ── S21c: models and usage ────────────────────────────────────────────────────────────────────

def read_router_models():
    req = urllib.request.Request(f"{ROUTER_URL}/v1/models")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode()).get("data", [])


KNOWN_MODEL_FIELDS = ("id", "object", "created", "owned_by", "backend_url", "checkpoint",
                      "abliterated", "on_demand")


def host_of(backend_url):
    """Where a role physically runs. The router answers for every role fleet-wide, so the host in
    the backend URL is the only thing that says which box is actually serving it."""
    if not backend_url:
        return ""
    try:
        host = urllib.parse.urlparse(str(backend_url)).hostname or ""
    except ValueError:
        return str(backend_url)
    return {"127.0.0.1": "this host", "localhost": "this host"}.get(host, host)


def render_models():
    models = read_router_models()
    rows = []
    for m in sorted(models, key=lambda d: str(d.get("id", ""))):
        abl = m.get("abliterated")
        # Rendered as a word, not a bare true/false: whether a role is backed by abliterated
        # weights is a standing design decision in this fleet (target 12.1), not a flag to squint
        # at. `None` means the router did not say, which is not the same as "no".
        abl_cell = ('<span class="pill s-proposed">abliterated</span>' if abl is True else
                    '<span class="pill s-done">stock</span>' if abl is False else
                    '<span class="empty">not stated</span>')
        # Anything the router grows later still shows up, rather than being silently dropped by a
        # fixed column list.
        extra = {k: v for k, v in m.items() if k not in KNOWN_MODEL_FIELDS}
        rows.append([
            f'<span class="mono">{esc(m.get("id"))}</span>',
            esc(m.get("checkpoint") or ""),
            abl_cell,
            esc(host_of(m.get("backend_url"))),
            f'<span class="mono">{esc(m.get("backend_url") or "")}</span>',
            "on demand" if m.get("on_demand") else "resident",
            f'<span class="mono">{esc(json.dumps(extra)) if extra else ""}</span>',
        ])
    return table(["role", "checkpoint", "weights", "runs on", "backend", "residency", ""], rows)


def read_usage_windows(days=USAGE_WINDOW_DAYS):
    """Two trailing windows, counted in SQL. Deliberately no LLM call anywhere near this page:
    `hermes-usage-report.py`'s own header gives the reason — a router call made to narrate usage
    would itself be logged, skewing the exact number being reported. Plain counts need no
    narration a human cannot read directly."""
    now = datetime.datetime.now(datetime.timezone.utc)
    cuts = [(now - datetime.timedelta(days=days)).isoformat(),
            (now - datetime.timedelta(days=2 * days)).isoformat()]
    conn = ro_sqlite(USAGE_DB)
    try:
        def window(lo, hi):
            sql = ("SELECT role, count(*) n, sum(status!='ok') bad, "
                   "       avg(latency_ms) lat, sum(COALESCE(total_tokens,0)) tok "
                   "FROM usage_log WHERE ts >= ?")
            params = [lo]
            if hi:
                sql += " AND ts < ?"
                params.append(hi)
            return {r["role"]: dict(r) for r in conn.execute(sql + " GROUP BY role", params)}
        return window(cuts[0], None), window(cuts[1], cuts[0])
    finally:
        conn.close()


def render_usage():
    recent, prior = read_usage_windows()
    roles = sorted(set(recent) | set(prior))
    rows = []
    for role in roles:
        a, b = recent.get(role, {}), prior.get(role, {})
        n, pn = a.get("n", 0), b.get("n", 0)
        delta = "" if not pn else f"{(n - pn) / pn * 100:+.0f}%"
        bad = a.get("bad") or 0
        rows.append([
            esc(role),
            f"{n:,}",
            f"{pn:,}",
            esc(delta),
            f'<span style="color:var(--bad)">{bad:,}</span>' if bad else "0",
            f"{a.get('lat') or 0:,.0f}",
            f"{a.get('tok') or 0:,}",
        ])
    return table(["role", f"calls (last {USAGE_WINDOW_DAYS}d)", f"prior {USAGE_WINDOW_DAYS}d",
                  "change", "non-ok", "avg ms", "tokens"], rows, numeric={1, 2, 3, 4, 5, 6})


def page_models():
    body = section("Which checkpoint backs each role",
                   "Read live from the router on every page load — one GET against "
                   f'<span class="mono">{esc(ROUTER_URL)}/v1/models</span>, which answers for '
                   "every role fleet-wide. No cache and no copy of this data is kept here.",
                   render_models)
    body += section("Call volume",
                    "Two trailing windows from the usage log, counted in SQL. No commentary, "
                    "deliberately: a router call made to narrate usage would itself be logged "
                    "and skew the number being reported.",
                    render_usage)
    return shell("Models and usage", body)


# ── S21d: benchmark results ───────────────────────────────────────────────────────────────────

def read_history():
    """Reads the same two files `hermes_benchmark_common.load_history()` reads — the NAS jsonl and
    the local fallback — so there is exactly one history and never a second copy drifting from the
    first. Inlined rather than imported because that module pulls in benchmark-running machinery
    this read-only page has no use for; the paths are the contract, and they are asserted by this
    service's own offline test against that module's constants."""
    entries = []
    for path in (NAS_HISTORY, LOCAL_HISTORY):
        if not path.exists():
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except ValueError:
                    continue      # one malformed line must not cost the whole history
    entries.sort(key=lambda e: str(e.get("date") or ""), reverse=True)
    return entries


def suite_results(entry):
    """One run records SEVERAL suites: `suites` maps a suite name to `{metric, value, ...}`. The
    `value` key is the score, which is how `hermes-benchmark-compare.py` reads the same file — a
    suite present but still `None` is a run that was attempted and produced nothing, and is shown
    as such rather than as a zero."""
    out = []
    suites = entry.get("suites")
    if not isinstance(suites, dict):
        return out
    for name, s in sorted(suites.items()):
        if isinstance(s, dict):
            out.append((name, s.get("metric"), s.get("value")))
        else:
            out.append((name, None, s))
    return out


def fmt_value(v, best=None):
    """`best`, when given, is the highest currently-recorded value for this exact same
    role/suite/metric (see render_history_current()) — rendered as `value/best` so a score reads
    in context rather than in isolation. Omitted (the default) by every caller with no such
    group to compare against, e.g. render_history_all()'s own per-run summary line, which mixes
    several suites/metrics in one line and has no single group for any one of them."""
    if v is None:
        return '<span class="empty">no result</span>'
    if not isinstance(v, (int, float)):
        return esc(v)
    s = f"{v:.4g}"
    if isinstance(best, (int, float)):
        s += f"/{best:.4g}"
    return s


def render_history_current(role_filter, sort_by_score):
    """Each model's latest run per suite — the same grouping `hermes-benchmark-compare.py
    --model-id` already does, read off the same history rather than recomputed differently.

    Every eval tool writes `role_or_endpoint` as the fleet ROLE it is scoring a candidate *for*,
    regardless of which model_id is actually being measured (hermes-vision-judge-eval.py always
    writes "omni", whether the real omni incumbent or a staged replacement candidate is what's
    behind the endpoint) — so grouping by (role, suite, metric) across every model_id's latest
    entry is exactly "every result anyone has recorded for this role's suite", which is both what
    the role filter narrows to and what each row's `best` is computed over."""
    latest = {}
    for e in read_history():                       # already newest-first
        model_id = str(e.get("model_id") or "?")
        role = e.get("role_or_endpoint") or ""
        for name, metric, value in suite_results(e):
            latest.setdefault((model_id, name), (e, metric, value, role))

    best = {}
    for (_model_id, suite), (_e, metric, value, role) in latest.items():
        if not isinstance(value, (int, float)):
            continue
        key = (role, suite, metric)
        if key not in best or value > best[key]:
            best[key] = value

    items = list(latest.items())
    if role_filter:
        items = [it for it in items if it[1][3] == role_filter]
    if sort_by_score:
        def score_key(it):
            value = it[1][2]
            return (0, -value) if isinstance(value, (int, float)) else (1, 0)
        items.sort(key=score_key)
    else:
        items.sort(key=lambda it: it[0])            # (model_id, suite) — the original order

    roles = sorted({role for (_mid, _s), (_e, _m, _v, role) in latest.items() if role})
    ropts = [f'<option value=""{"" if role_filter else " selected"}>(every role)</option>']
    for r in roles:
        sel = " selected" if r == role_filter else ""
        ropts.append(f'<option value="{esc(r)}"{sel}>{esc(r)}</option>')
    sopts = (f'<option value=""{"" if sort_by_score else " selected"}>model, suite</option>'
             f'<option value="score"{" selected" if sort_by_score else ""}>score, high to low'
             f'</option>')
    form = (f'<form method="get"><select name="role">{"".join(ropts)}</select> '
            f'<select name="sort">{sopts}</select> '
            f'<button type="submit">show</button></form>')

    rows = []
    for (model_id, suite), (e, metric, value, role) in items:
        rows.append([
            f'<span class="mono">{esc(model_id)}</span>',
            esc(suite),
            f'<span class="mono">{esc(metric or "")}</span>',
            fmt_value(value, best.get((role, suite, metric))),
            esc(role),
            esc(when(e.get("date"))),
        ])
    return form + table(["model", "suite", "metric", "value", "role", "latest run"], rows,
                        numeric={3})


def render_history_all():
    entries = read_history()
    shown = entries[:MAX_HISTORY_ROWS]
    rows = []
    for e in shown:
        results = suite_results(e)
        summary = " · ".join(f'{esc(n)} <b>{fmt_value(v)}</b>' for n, _m, v in results) \
            or '<span class="empty">no suites recorded</span>'
        rows.append([
            esc(when(e.get("date"))),
            f'<span class="mono">{esc(e.get("model_id"))}</span>',
            esc(e.get("role_or_endpoint") or ""),
            summary,
            esc(e.get("notes") or ""),
        ])
    cap = ("" if len(entries) <= MAX_HISTORY_ROWS else
           f' Showing the newest {MAX_HISTORY_ROWS} of {len(entries)}.')
    # data-filter rather than an inline oninput: see PAGE_SCRIPT's own note -- with
    # `default-src 'none'` and no script-src the inline version was blocked outright,
    # so this box did nothing at all in a browser.
    search = ('<p><input type="search" placeholder="filter rows…" data-filter="#all">'
              f'<span class="note">{len(shown)} row(s).{cap}</span></p>')
    return search + '<div id="all">' + table(
        ["when", "model", "role", "suite results", "notes"], rows) + "</div>"


def page_benchmarks(query):
    role_filter = (query.get("role") or [""])[0]
    sort_by_score = (query.get("sort") or [""])[0] == "score"
    body = section(
        "Current — each model's latest run per suite",
        "Filter to one role, or sort high to low, with the controls above the table. The value "
        "column shows this model's own latest score — and, whenever any model's latest score for "
        "this exact role/suite/metric is higher, that highest score too, as value/highest.",
        lambda: render_history_current(role_filter, sort_by_score))
    body += section("All recorded runs", "Newest first, with a hard render cap. Both views read "
                    "the same history file the benchmark tooling writes, so there is never a "
                    "second copy to drift.", render_history_all)
    return shell("Benchmark results", body)


# ── S21e: topic highlights ────────────────────────────────────────────────────────────────────

def configured_topics():
    """topics.yaml in file order, because that order IS the digest's priority order (S27b) and
    nothing else records it. Falls back to whatever the table holds if the file is unreadable."""
    try:
        lines = TOPICS_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]


def read_highlight_days():
    conn = ro_sqlite(RAG_DB)
    try:
        return [r["digest_date"] for r in conn.execute(
            "SELECT DISTINCT digest_date FROM news_digest_daily ORDER BY digest_date DESC "
            "LIMIT 60")]
    finally:
        conn.close()


def read_highlights(topic, date):
    conn = ro_sqlite(RAG_DB)
    try:
        sql = ("SELECT digest_date, topic, rank, summary_line, citation, created_at "
               "FROM news_digest_daily WHERE 1=1")
        params = []
        if topic:
            sql += " AND topic=?"
            params.append(topic)
        if date:
            sql += " AND digest_date=?"
            params.append(date)
        sql += " ORDER BY digest_date DESC, topic, rank LIMIT ?"
        params.append(MAX_HIGHLIGHT_ROWS)
        return [dict(r) for r in conn.execute(sql, params)]
    finally:
        conn.close()


def render_highlights(topic, date):
    days = read_highlight_days()
    topics = configured_topics()
    opts = ['<option value="">(every topic)</option>']
    for t in topics:
        sel = " selected" if t == topic else ""
        opts.append(f'<option value="{esc(t)}"{sel}>{esc(t[:70])}</option>')
    dopts = ['<option value="">(every day)</option>']
    for d in days:
        sel = " selected" if d == date else ""
        dopts.append(f'<option value="{esc(d)}"{sel}>{esc(d)}</option>')
    form = (f'<form method="get"><select name="topic">{"".join(opts)}</select> '
            f'<select name="date">{"".join(dopts)}</select> '
            f'<button type="submit">show</button></form>')

    rows = read_highlights(topic, date)
    if not rows and not days:
        # Worth saying explicitly rather than rendering an empty table: on 2026-10-09 this table
        # was empty because the digest's own DELETE was wiping it daily (S27g), not because no
        # news had ever been found.
        return (form + '<div class="err"><b>No highlights are stored at all.</b> '
                'That is either a digest that has not yet run since the table was reshaped '
                '(S27c), or a digest that is finding nothing — the daily journal of '
                '<span class="mono">hermes-news-digest-daily.service</span> says which.</div>')

    body = []
    for r in rows:
        body.append([
            esc(r["digest_date"]),
            f'<span class="num">{r["rank"]}</span>',
            esc(r["topic"][:46]),
            esc(r["summary_line"]),
            f'<span class="mono">{esc(r["citation"] or "")}</span>',
        ])
    note = (f'<p class="note">{len(rows)} row(s), capped at {MAX_HIGHLIGHT_ROWS}. Ranks past the '
            f"email's own cap are shown here too — that is what these rows are stored for.</p>")
    return form + note + table(["day", "rank", "topic", "highlight", "citation"], body,
                               numeric={1})


def page_highlights(query):
    topic = (query.get("topic") or [""])[0]
    date = (query.get("date") or [""])[0]
    body = section("Stored topic highlights",
                   "Read straight from the digest's own table — one row per highlight, so a "
                   "highlight the email's cap left out is still recoverable here.",
                   lambda: render_highlights(topic, date))
    return shell("Topic highlights", body)


# ── S21h: recommendations (node-baseline, linodemercury-watch, and future producers) ─────────
#
# Every recommendation producer in this fleet writes the same REC-<node>-<date>-<seq> id and the
# same first-turn payload shape ({"node", "status", "finding_id", "tool", "severity",
# "description", "detail", "suggested_remediation"}) — hermes-node-baseline-scan.py for
# spark/spark-2/HomeD13 (S17), hermes-linodemercury-watch.py for LinodeMercury (S29). This page
# keys off the `REC-` id prefix rather than an agent allowlist, so a future fourth producer needs
# no change here as long as it follows the same convention — the point of the request that built
# this page ("surface the recommendations, and any others from other nodes").

REC_STATE_ORDER = ["pending", "routed-remediate", "routed-dualcoder", "manual-required",
                   "rejected", "resolved"]
# Reuses the existing .pill s-* palette rather than adding new CSS — these states don't map 1:1
# onto model-scout's vocabulary, but the same four colors (warn/ok/dim) cover the same meanings:
# awaiting a decision, acted on, needs a human, and closed.
REC_STATE_STYLE = {
    "pending": "proposed", "routed-remediate": "approved", "routed-dualcoder": "approved",
    "manual-required": "deferred", "rejected": "rejected", "resolved": "done",
}
REC_SEVERITY_COLOR = {"critical": "var(--bad)", "high": "var(--bad)",
                       "medium": "var(--warn)", "low": "var(--dim)"}


# ── Benchmark-driven model-swap recommendations ───────────────────────────────────────────────
#
# A different kind of recommendation from the REC-<node> ones below: not a security/integrity
# finding written to hermes-memory by a scanner, but a staged candidate that beat the real LIVE
# incumbent on the identical suite, same day, same methodology, found during the S39 spark2
# candidate-benchmark run (infra/model-benchmark/spark2-candidate-results.md — see that doc for
# full methodology, caveats and how each incumbent was re-measured). There is no live store yet
# for "a candidate beat an incumbent" the way there is for scanner findings, so this list is
# curated by hand rather than queried, and the page says so plainly — update it in the same change
# that records a new outperformance finding in spark2-candidate-results.md, and re-verify against
# that doc (and the live role) before acting on any entry, since role assignments on this fleet
# are confirmed to drift from their own service descriptions.
MODEL_SWAP_RECOMMENDATIONS = [
    {
        "role": "coder2 / dualcoder-review (retired 2026-10-20, but still resident, zero traffic)",
        "suite": "fleet_dualcoder_precision",
        "candidate": "GLM-4.7-Flash-Q4_K_M",
        "candidate_score": "1.000 (6/6) — recall 3/3, precision 3/3",
        "incumbent": "Muse-Glimmer-30B (coder2)",
        "incumbent_score": "0.000 (0/4, 2 of 6 cases timed out)",
        "caveat": "Role-specific, not a general win — GLM-4.7-Flash's own Tier 0 ifeval (0.600) "
                  "and fleet_log_analyst (0.640) are the weakest seen in this run.",
        "date": "2026-10-24/25",
    },
    {
        "role": "super's log-analyst duty (live production traffic)",
        "suite": "fleet_log_analyst",
        "candidate": "NousResearch Hermes-4.3-36B-Q4_K_M",
        "candidate_score": "accuracy 0.750 (9/12), fact-extraction 0.960",
        "incumbent": "Huihui-GLM-4.7-Flash-abliterated (super)",
        "incumbent_score": "accuracy 0.375 (3/8), fact-extraction 0.880",
        "caveat": "super also judges this whole benchmark run and serves other duties not tested "
                  "here — a dedicated log-analyst candidate, not a case for swapping super itself.",
        "date": "2026-10-25",
    },
    {
        "role": "omni's vision-judge duty (live production traffic)",
        "suite": "fleet_vision_judge",
        "candidate": "NVIDIA-Nemotron-3.5-Bolt-74B-A9B",
        "candidate_score": "precision 0.897, recall 0.963, false_fail_rate 0.037",
        "incumbent": "gemma-4-26B-A4B-it (omni)",
        "incumbent_score": "precision 0.846, recall 0.407, false_fail_rate 0.593",
        "caveat": "Incumbent's 0.593 false-fail rate means most good renders get needlessly "
                  "regenerated today. Also this run's best fleet_muse_contract score (0.852) — "
                  "check it fits the deployment target's VRAM budget before proposing it.",
        "date": "2026-10-25",
    },
    {
        "role": "muse's persona/override-resistance duty (live production traffic)",
        "suite": "fleet_muse_contract",
        "candidate": "NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning",
        "candidate_score": "0.963 (26/27) — override 8/9",
        "incumbent": "Huihui-Qwen3.6-35B-A3B-abliterated (muse)",
        "incumbent_score": "0.704 — override 3/9 (corrected baseline)",
        "caveat": "Largest gap of the run, but staged/named as an omni candidate — its own "
                  "vision-judge numbers are the weakest of the three Phase 4 candidates, so this "
                  "is a muse-role finding only. Vision-capable (needs mmproj); check whether a "
                  "text-only load changes resource usage favorably for a text-only role.",
        "date": "2026-10-25",
    },
]


def render_swap_recommendations():
    rows = []
    for r in MODEL_SWAP_RECOMMENDATIONS:
        rows.append([
            esc(r["role"]),
            f'<span class="mono">{esc(r["suite"])}</span>',
            f'<b>{esc(r["candidate"])}</b><br><span class="note">{esc(r["candidate_score"])}</span>',
            f'{esc(r["incumbent"])}<br><span class="note">{esc(r["incumbent_score"])}</span>',
            esc(r["caveat"]),
            esc(r["date"]),
        ])
    note = (f'{len(MODEL_SWAP_RECOMMENDATIONS)} curated finding(s) from the S39 spark2 '
            f'candidate-benchmark run — see <span class="mono">infra/model-benchmark/'
            f'spark2-candidate-results.md</span> for full methodology. <b>Unlike every other '
            f'section on this page, this list is hand-curated, not read from a live store</b>, and '
            f'is not kept in sync automatically — re-verify against that doc, and against the '
            f'live role, before acting on any row here; this fleet\'s role assignments are '
            f'confirmed to drift from their own service descriptions.')
    return (f'<p class="note">{note}</p>' + table(
        ["role", "suite", "candidate (score)", "live incumbent (score)", "caveat", "found"],
        rows))


def read_recommendations(state_filter):
    """Same read-only stdlib-sqlite approach as read_backlog(), for the same reason (hermes-memory
    has no task-list route; /usr/bin/python3 cannot load sqlite-vec). Unlike the backlog, a
    recommendation's turns are not interchangeable: the FIRST turn written
    (write_recommendation()) carries the finding itself, and a later "resolved" turn
    (resolve_recommendation()) only adds status/finding_id/resolved_at without repeating it — so
    turns are merged oldest-first. dict.update() only overwrites keys the later turn actually
    sets, so a resolved recommendation keeps its original tool/severity/description rather than
    losing them to a turn that never carried them.

    State filtering happens here, in SQL, rather than on the capped Python-side result —
    confirmed live 2026-10-09 that this table holds 227,116 REC rows (139,853 pending, 87,263
    resolved) going back to 2026-09-07, so a flat `ORDER BY updated_at DESC LIMIT N` with no
    state filter spends its entire cap on whichever node is churning resolutions fastest *right
    now* (spark-2, confirmed: 388 of 400 in that naive query were its resolved history) and can
    bury every other node's genuinely open findings. The true total for the active filter is
    counted separately (cheap — one COUNT(*)) so "showing 400 of ...` is never a lie about scale."""
    conn = ro_sqlite(MEMORY_DB)
    try:
        where = ["id LIKE 'REC-%'"]
        params = []
        if state_filter == "all":
            pass
        elif state_filter:
            where.append("state = ?")
            params.append(state_filter)
        else:
            where.append("state != 'resolved'")   # default view: open/actionable only
        clause = " AND ".join(where)
        total = conn.execute(f"SELECT count(*) FROM tasks WHERE {clause}", params).fetchone()[0]
        state_counts = dict(conn.execute(
            "SELECT state, count(*) FROM tasks WHERE id LIKE 'REC-%' GROUP BY state").fetchall())
        tasks = conn.execute(
            f"SELECT id, state, topic, agent, created_at, updated_at FROM tasks WHERE {clause} "
            f"ORDER BY updated_at DESC LIMIT ?", params + [MAX_RECOMMENDATION_ROWS]).fetchall()
        detail = {}
        for t in tasks:
            merged = {}
            for row in conn.execute(
                    "SELECT raw FROM turns WHERE task_id=? ORDER BY id ASC", (t["id"],)):
                if not row["raw"]:
                    continue
                try:
                    payload = json.loads(row["raw"])
                except (ValueError, TypeError):
                    continue
                if isinstance(payload, dict):
                    merged.update(payload)
            detail[t["id"]] = merged
        return [dict(t) for t in tasks], detail, total, state_counts
    finally:
        conn.close()


def render_recommendations(node_filter, state_filter):
    tasks, detail, total, state_counts = read_recommendations(state_filter)
    loaded = [(t, detail.get(t["id"], {})) for t in tasks]
    loaded = [(t, d, d.get("node") or "", t["state"] or "?") for t, d in loaded]

    # True counts across the WHOLE table, not just this capped/filtered page — the scale found
    # live 2026-10-09 (see read_recommendations()) makes a count over only the loaded rows
    # actively misleading.
    summary = " · ".join(
        f'<span class="pill s-{esc(REC_STATE_STYLE.get(k, "proposed"))}">{esc(k)} {v:,}</span>'
        for k, v in sorted(state_counts.items(),
                           key=lambda kv: REC_STATE_ORDER.index(kv[0])
                           if kv[0] in REC_STATE_ORDER else len(REC_STATE_ORDER)))

    # Node options come from what's actually in the loaded (capped) set, same limitation
    # render_highlights()'s topic/date dropdowns already accept — a node with zero rows in this
    # filter's most-recently-updated window won't appear as a choice until something about it
    # updates. Stated plainly in the note below rather than solved with a second full-table scan.
    nodes = sorted({n for _, _, n, _ in loaded if n})
    nopts = ['<option value="">(every node in this view)</option>']
    for n in nodes:
        sel = " selected" if n == node_filter else ""
        nopts.append(f'<option value="{esc(n)}"{sel}>{esc(n)}</option>')
    sopts = [f'<option value=""{"" if state_filter else " selected"}>(open — excludes resolved)'
             f'</option>',
             f'<option value="all"{" selected" if state_filter == "all" else ""}>'
             f'(every state, including resolved)</option>']
    for s in REC_STATE_ORDER:
        if s not in state_counts:
            continue
        sel = " selected" if s == state_filter else ""
        sopts.append(f'<option value="{esc(s)}"{sel}>{esc(s)} only</option>')
    form = (f'<form method="get"><select name="node">{"".join(nopts)}</select> '
            f'<select name="state">{"".join(sopts)}</select> '
            f'<button type="submit">show</button></form>')

    rows = []
    for t, d, node, state in loaded:
        if node_filter and node != node_filter:
            continue
        severity = (d.get("severity") or "").lower()
        sev_color = REC_SEVERITY_COLOR.get(severity, "var(--dim)")
        remediation = d.get("suggested_remediation")
        detail_text = ((remediation.get("detail") if isinstance(remediation, dict) else "")
                       or d.get("detail") or "")
        rows.append([
            f'<span class="mono">{esc(t["id"])}</span>',
            f'<span class="pill s-{esc(REC_STATE_STYLE.get(state, "proposed"))}">{esc(state)}</span>',
            esc(node or "?"),
            esc(d.get("tool") or ""),
            f'<b style="color:{sev_color}">{esc(severity or "?")}</b>',
            esc(d.get("description") or ""),
            esc(detail_text),
            esc(when(t["updated_at"])),
        ])

    note = (f'{summary} (true totals, not just this page)<br>Showing {len(rows)} of {total:,} '
            f'matching this filter (newest-updated first, capped at {MAX_RECOMMENDATION_ROWS}). '
            f'<b>Read-only</b> — authorizing or rejecting one still goes through the FleetOps '
            f'Matrix reply <span class="mono">authorize|reject &lt;id&gt;</span> that '
            f'<span class="mono">hermes-baseline-authorize-watch.py</span> watches for. The '
            f'benchmark backlog page above earns its own write route on a separately-argued '
            f'decision (S21f); this page does not reopen that argument. The node filter\'s '
            f'options are drawn from this page\'s own loaded rows, not a full scan — a node with '
            f'nothing in the current window won\'t appear as a choice.')
    # data-filter rather than an inline oninput: see PAGE_SCRIPT's own note on why that silently
    # does nothing under this service's CSP.
    search = (f'<p><input type="search" placeholder="filter rows…" data-filter="#recs">'
              f'<span class="note">{note}</span></p>')
    return form + search + '<div id="recs">' + table(
        ["id", "state", "node", "tool", "severity", "description", "suggested remediation",
         "updated"], rows) + '</div>'


def page_recommendations(query):
    node_filter = (query.get("node") or [""])[0]
    state_filter = (query.get("state") or [""])[0]
    body = section(
        "Recommended model swaps",
        "A staged candidate that beat the real live incumbent on the identical benchmark suite — "
        "see the note below the table for how this differs from the security findings beneath it.",
        render_swap_recommendations)
    body += section(
        "Security/integrity recommendations",
        "Every finding this fleet's scanners have written to hermes-memory as a "
        "<span class=\"mono\">REC-&lt;node&gt;-&lt;date&gt;-&lt;seq&gt;</span> recommendation — "
        "aide/lynis/syft+grype from <span class=\"mono\">hermes-node-baseline-scan.py</span> "
        "(spark, spark-2, HomeD13) and the firewall/package/SSH-log checks from "
        "<span class=\"mono\">hermes-linodemercury-watch.py</span> (LinodeMercury), plus anything "
        "else that ever writes the same shape. Defaults to open findings only — see the note "
        "below the filters for why.",
        lambda: render_recommendations(node_filter, state_filter))
    return shell("Recommendations", body)


# ── S40c: egress-guard denials ────────────────────────────────────────────────────────────────

def read_egress_blocks():
    """Reads tools/hermes_egress_guard.py's own denial records directly from `turns`
    (task_id="egress-block", written by its _record_denial() -- EGRESS_GUARD_DESIGN.md §8.4).
    Same read-only stdlib-sqlite approach as read_recommendations()/read_backlog(), for the same
    reason (hermes-memory has no list-by-task_id HTTP route that isn't capped -- see below -- and
    /usr/bin/python3 cannot load sqlite-vec). Unlike a recommendation there is no `tasks` row at
    all here and nothing to merge: every denial is its own turn under one shared task_id, so each
    row IS one event.

    This is why Phase C never needed S40's own original gate (landing a `since` filter on
    hermes-memory's `/turns` GET, or paginating around its 500-row cap, per S33): that cap lives
    only in the HTTP JSON API this page was never going to use. A direct SQL `COUNT(*)` has no
    such limit and gives an exact, honest total, the same way read_recommendations() already
    proves for the fleet-scanner page this one is modeled on."""
    conn = ro_sqlite(MEMORY_DB)
    try:
        total = conn.execute(
            "SELECT count(*) FROM turns WHERE task_id = 'egress-block'").fetchone()[0]
        rows = conn.execute(
            "SELECT raw, created_at FROM turns WHERE task_id = 'egress-block' "
            "ORDER BY created_at DESC LIMIT ?", (MAX_EGRESS_BLOCK_ROWS,)).fetchall()
        events = []
        for r in rows:
            try:
                payload = json.loads(r["raw"]) if r["raw"] else {}
            except (ValueError, TypeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            events.append({**payload, "created_at": r["created_at"]})
        return events, total
    finally:
        conn.close()


def render_egress_blocks():
    events, total = read_egress_blocks()
    rows = [
        [esc(when(e.get("timestamp") or e.get("created_at"))),
         esc(e.get("caller") or "?"),
         esc(e.get("attempted") or "?"),
         esc(e.get("reason") or "")]
        for e in events
    ]
    note = (f"Showing {len(rows)} of {total:,} denial(s) (newest first, capped at "
            f"{MAX_EGRESS_BLOCK_ROWS}). This total is a real COUNT over the whole table, never "
            f"silently truncated the way S33 found an HTTP-API-based fetch could be.")
    search = (f'<p><input type="search" placeholder="filter rows…" data-filter="#egress-blocks">'
              f'<span class="note">{note}</span></p>')
    return search + '<div id="egress-blocks">' + table(
        ["when", "caller", "attempted destination", "reason"], rows) + '</div>'


def page_egress_blocks(query):
    body = section(
        "Egress-guard denials",
        "Every outbound destination <span class=\"mono\">tools/hermes_egress_guard.py</span>'s "
        "<span class=\"mono\">check_destination()</span> has denied — a caller reaching for a "
        "host that is neither fleet-internal nor on its own entry in "
        "<span class=\"mono\">infra/firmament-tool-registry.yaml</span> (EGRESS_GUARD_DESIGN.md, "
        "S40). Each denial already triggered its own Matrix notice and hi-pri email; this page "
        "is the durable, queryable record of the same events. Read-only.",
        render_egress_blocks)
    return shell("Egress-guard denials", body)


# ── S38i: Market Watch ───────────────────────────────────────────────────────────────────────
#
# Fulfills MARKET_WATCH_DESIGN.md §9's deferred "browsable report history" now that S38 is live
# and `report_items`/`tag_proposals` have real rows to browse. Every number here is read back
# from `report_items` through hermes_market_common.read_report_items() — the same function the
# daily email/Matrix notice and a `market report` gate reply already render from — so this page
# can never disagree with either about what a given day said.

# item_types whose `ticker_or_group` is a real ticker rather than a sector/tag name — the only
# ones a company name lookup is meaningful for. sector_trend/tag_trend's `group` is a sector or
# tag NAME, and is left alone even though some of those lines also happen to start with that
# name followed by a space (the same shape with_company_name() looks for) — this allowlist is
# the real guard, not the startswith() check inside it, which is only a second line of defense.
TICKER_LEVEL_ITEM_TYPES = {"movers_up", "movers_down", "trend30_up", "trend30_down",
                           "ai_watch_llm", "ai_watch_hw"}


def with_company_name(text, ticker, name_by_ticker):
    """Splices "(Registered Name)" in right after the ticker every render_*_line() in
    hermes_market_common.py puts at the very start of its own line (verified against that
    module's source — every ticker-level line names its ticker exactly once, as the first
    token). Operates on the raw, not-yet-escaped `text`/`name` — the caller esc()s the composite
    result exactly once, same as everything else on this page. This is a FleetOps-UI-only
    cosmetic enhancement: it never touches the stored `report_items.text` itself, which the
    daily email/Matrix notice/`market report` gate reply also render from and must keep agreeing
    on. A ticker with no `instruments` row (delisted, or the line's shape doesn't match) is left
    unchanged rather than guessed at."""
    name = name_by_ticker.get(ticker)
    if not name or not text.startswith(ticker + " "):
        return text
    return f"{ticker} ({name}){text[len(ticker):]}"


def render_market_report(requested_date):
    conn = ro_sqlite(MARKET_DB)
    try:
        dates = [r[0] for r in conn.execute(
            "SELECT DISTINCT report_date FROM report_items ORDER BY report_date DESC LIMIT 60")]
        if not dates:
            return ('<p class="empty">No report has been generated yet — '
                     '<span class="mono">hermes-market-report.py daily</span> writes '
                     '<span class="mono">report_items</span> once the sync has run.</p>')
        report_date = requested_date if requested_date in dates else dates[0]
        rows = market_common.read_report_items(conn, report_date)
        name_by_ticker = {r[0]: r[1] for r in conn.execute("SELECT ticker, name FROM instruments")}
    finally:
        conn.close()

    dopts = []
    for d in dates:
        sel = " selected" if d == report_date else ""
        dopts.append(f'<option value="{esc(d)}"{sel}>{esc(d)}</option>')
    form = (f'<form method="get"><select name="date">{"".join(dopts)}</select> '
            f'<button type="submit">show</button></form>')
    note = ("" if requested_date in ("", report_date) else
            f'<p class="note">No report stored for {esc(requested_date)} — showing '
            f'{esc(report_date)}, the most recent one on file.</p>')

    # Grouped by item_type then re-emitted in REPORT_SECTION_ORDER (the same fixed order
    # render_full_report_text() uses for the email body) rather than the table's own
    # item_type-alphabetical ORDER BY — "Sector trends" belongs ahead of "30-day laggards"
    # regardless of where the two sort lexically.
    by_type = {}
    for _category, item_type, rank, group, value, text in rows:
        by_type.setdefault(item_type, []).append((rank, group, value, text))

    # One table per section, each with its own divider/title (<h3>) instead of a repeated
    # "section" column — "#" (the item's rank) leads each section's own table.
    sections_html = []
    remaining, total_rows, truncated = MAX_MARKET_ROWS, 0, False
    for item_type in market_common.REPORT_SECTION_ORDER:
        items = sorted(by_type.get(item_type, []), key=lambda r: r[0])
        if not items:
            continue
        if remaining <= 0:
            truncated = True
            break
        if len(items) > remaining:
            items = items[:remaining]
            truncated = True
        remaining -= len(items)
        total_rows += len(items)

        body_rows = []
        for rank, group, value, text in items:
            if item_type in TICKER_LEVEL_ITEM_TYPES:
                text = with_company_name(text, group, name_by_ticker)
            body_rows.append([
                f'<span class="num">{rank}</span>',
                esc(group),
                f'<span class="num">{value:+.2f}%</span>',
                esc(text),
            ])
        title = esc(market_common.REPORT_SECTION_TITLES[item_type])
        sections_html.append(f'<h3 class="mkt-sec">{title}</h3>' + table(
            ["#", "ticker/group", "move", "detail"], body_rows, numeric={0, 2}))

    cap = "" if not truncated else f" Truncated at {MAX_MARKET_ROWS} total row(s)."
    search = (f'<p><input type="search" placeholder="filter rows…" data-filter="#market">'
              f'<span class="note">{total_rows} row(s) for {esc(report_date)}.{cap}</span></p>')
    return form + note + search + '<div id="market">' + "".join(sections_html) + '</div>'


def render_market_tag_proposals():
    conn = ro_sqlite(MARKET_DB)
    try:
        rows = conn.execute("""
            SELECT ticker, candidate_tag, rationale, proposed_at FROM tag_proposals
            WHERE state='proposed' ORDER BY proposed_at DESC LIMIT ?
        """, (MAX_TAG_PROPOSAL_ROWS,)).fetchall()
    finally:
        conn.close()
    if not rows:
        return '<p class="empty">No pending tag proposals.</p>'
    body_rows = [[esc(t), esc(tag), esc(r), esc(when(p))] for t, tag, r, p in rows]
    note = (f'<p class="note">The LLM-judged tag scout\'s (S38h) frontier_llm/ai_hardware '
            f'candidates, awaiting a human reply in FleetOps — never auto-applied. Reply '
            f'<span class="mono">market tag approve &lt;TICKER&gt;</span> or '
            f'<span class="mono">market tag reject &lt;TICKER&gt;</span>; deciding stays a '
            f'Matrix reply, same as the recommendations page above, not a button here.</p>')
    return note + table(["ticker", "candidate tag", "rationale", "proposed"], body_rows)


def page_market(query):
    requested_date = (query.get("date") or [""])[0]
    body = section(
        "Market Watch — daily report",
        "Read straight from <span class=\"mono\">report_items</span> — the same stored rows the "
        "daily email, Matrix notice, and a <span class=\"mono\">market report</span> gate reply "
        "all render from (S38). Includes the dedicated Frontier LLM Watch / AI Hardware Watch "
        "sections (S38g). Read-only.",
        lambda: render_market_report(requested_date))
    body += section(
        "Pending tag candidate proposals",
        "",
        render_market_tag_proposals)
    return shell("Market Watch", body)


# ── server ────────────────────────────────────────────────────────────────────────────────────

ROUTES = {
    "/": lambda q: page_home(),
    "/backlog": page_backlog,
    "/models": lambda q: page_models(),
    "/benchmarks": page_benchmarks,
    "/highlights": page_highlights,
    "/recommendations": page_recommendations,
    "/egress-blocks": page_egress_blocks,
    "/market": page_market,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-fleetops-ui/1.0.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, code, blob, content_type="text/html; charset=utf-8"):
        # A fresh nonce per response, substituted into the one <script> element the shell emits.
        # Attributes cannot be nonced, which is why no inline handler exists any more: with
        # `default-src 'none'` and no script-src they were being blocked outright, so the copy
        # button and the benchmark filter did nothing at all in a browser.
        nonce = secrets.token_urlsafe(16)
        blob = blob.replace(b"__CSP_NONCE__", nonce.encode())
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(blob)))
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; "
            f"script-src 'nonce-{nonce}'; "
            # form-action is a second, independent brake on the write route: even with a stolen
            # token, a form on someone else's page cannot target this origin.
            "form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(blob)

    def _authed(self):
        presented = self.headers.get("Authorization", "")
        expected = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
        if presented and hmac.compare_digest(presented, expected):
            return True
        blob = b'{"error":"unauthorized"}'
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="hermes-fleetops-ui"')
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)
        return False

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, json.dumps({"ok": True, "version": self.server_version}).encode(),
                       "application/json")
            return
        if not self._authed():
            return
        handler = ROUTES.get(parsed.path.rstrip("/") or "/")
        if handler is None:
            self._send(404, shell("Not found", '<p class="empty">No such page.</p>'))
            return
        try:
            self._send(200, handler(urllib.parse.parse_qs(parsed.query)))
        except Exception as exc:  # noqa: BLE001 - see the comment below
            # A whole-page failure is still a page: the nav has to keep working so the operator can
            # reach the sections that are fine.
            log(f"unhandled error rendering {parsed.path}: {type(exc).__name__}: {exc}")
            self._send(500, shell("Error", f'<div class="err"><b>This page failed to render.</b> '
                                           f'{esc(type(exc).__name__)}: {esc(exc)}</div>'))

    def do_POST(self):
        """The service's only write route.

        A GET never changes state — all four verbs arrive here as a form POST, so a link, a
        prefetch or a crawler cannot decide anything."""
        parsed = urllib.parse.urlparse(self.path)
        if not self._authed():
            return
        if parsed.path.rstrip("/") != "/backlog/decide":
            self._send(404, shell("Not found", '<p class="empty">No such route.</p>'))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if not 0 <= length <= 8192:
            self._redirect("/backlog?result=badaction")
            return
        form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        if not csrf_ok(self.headers, (form.get("csrf") or [""])[0]):
            log(f"decide refused: CSRF check failed from {self.address_string()} "
                f"(Sec-Fetch-Site={self.headers.get('Sec-Fetch-Site')!r})")
            self._redirect("/backlog?csrf=1")
            return
        # Several task_id fields, one action -- multi-select posts the same shape as a single row.
        task_ids = [i for i in (form.get("task_id") or []) if i]
        action = (form.get("action") or [""])[0]
        who = tailnet_identity(self.headers)
        # Log the request before acting on it. On 2026-10-16 the journal held only a 303 for two
        # failed decides, so neither the action nor the candidates could be recovered afterwards
        # and the operator's selection could not be replayed.
        shown = ", ".join(task_ids[:8]) + (f" (+{len(task_ids) - 8} more)" if len(task_ids) > 8
                                           else "")
        log(f"decide requested: action={action!r} on {len(task_ids)} task(s) "
            f"by {who or 'unidentified'} — {shown}")
        counts = apply_decisions(task_ids, action, who)
        log(f"decide result: action={action!r} -> {dict(counts)}")
        self._redirect("/backlog?" + (results_query(counts) or "none=1"))

    def _redirect(self, location):
        """POST -> redirect -> GET, so a decision is never replayed by a refresh or a back button.
        The outcome travels as a fixed code, never as text, so nothing from the URL is rendered."""
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    if not (USER and PASSWORD):
        sys.exit("FLEETOPS_UI_USER and FLEETOPS_UI_PASSWORD are required — "
                 "this service must not run unauthenticated")
    if BIND in ("0.0.0.0", "::", ""):
        # The bind address is a real part of this service's security posture, not a default to
        # shrug at: S12 established that this fleet's loopback/tailnet binds are the boundary.
        sys.exit(f"refusing to bind {BIND!r} — FLEETOPS_UI_BIND must be a specific loopback or "
                 f"tailnet address")
    if not MEMORY_TOKEN:
        # Not fatal: the reports are the bulk of this service and they need no token. But say so
        # once at startup rather than letting every decide fail with a vague write error.
        log("WARNING: no MEMORY_TOKEN — the reports work, the decide buttons will not")
    load_gate()
    log(f"listening on {BIND}:{PORT} "
        f"(reports read-only; one write route, /backlog/decide, "
        f"{'armed' if GATE and MEMORY_TOKEN else 'DISABLED'})")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
