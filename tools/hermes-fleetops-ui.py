#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-fleetops-ui — one browser page for the fleet's human-facing surfaces (S21).
#
# ── SCOPE, stated here because it is the thing most likely to drift ──
#
# This is links and read-only reports. It is NOT a control plane. "Process management" names what
# the page is *for* — one place to see what this fleet is doing — not a promise that it starts,
# stops or restarts anything. Starting and stopping services stays an SSH + `systemctl` operator
# action, the same as every other privileged action here already requires an explicit human step
# rather than a button (`tools/hermes-confirm-gate.sh` exists for exactly that reason).
#
# **This service adds zero new privileged write surface.** It opens every store read-only and makes
# no POST/PUT routes at all. The two approval flows it surfaces each already have their own write
# path, reasoned about separately: RAG candidates through `hermes-rag-discovery-portal.py`, and the
# model-benchmark backlog through the Matrix reply `hermes-model-scout-gate.py` watches for. Adding
# a decide button here would mean a second, weaker path to the same privileged decision — shared
# Basic Auth against one specific Matrix sender id — which is the structural shortcut this fleet's
# confirm-gate design refuses. The one convenience offered on an `approved` row copies a command to
# the clipboard; it triggers nothing.
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
import base64
import datetime
import hmac
import html
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BIND = os.environ.get("FLEETOPS_UI_BIND", "100.96.59.79")
PORT = int(os.environ.get("FLEETOPS_UI_PORT", "8103"))
USER = os.environ.get("FLEETOPS_UI_USER", "")
PASSWORD = os.environ.get("FLEETOPS_UI_PASSWORD", "")

ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")
MEMORY_DB = os.environ.get("MEMORY_DB", "/mnt/hermes-data/memory/memory.db")
RAG_DB = os.environ.get("HERMES_RAG_DB", "/mnt/hermes-data/rag/vectors.db")
USAGE_DB = os.environ.get("HERMES_USAGE_DB", str(Path.home() / ".hermes" / "state" / "usage.db"))
RAG_PORTAL_URL = os.environ.get("RAG_PORTAL_URL", "http://100.96.59.79:8093/")

REPO = Path(__file__).resolve().parent.parent
TOPICS_FILE = REPO / "infra" / "hermes-news-digest" / "topics.yaml"

NAS_HISTORY = Path("/mnt/nas2-hermes-backup/Private/Hermes/Benchmarks/history.jsonl")
LOCAL_HISTORY = Path.home() / ".hermes" / "state" / "benchmark-history.jsonl"

SCOUT_AGENT = "model-scout"
USAGE_WINDOW_DAYS = 7

# Hard caps on what any one page renders. Baked in from the start rather than discovered later
# against a table that has grown too large to page through — the RAG portal needed exactly this
# fix the hard way (its 1.2.0/1.4.1), so this one starts with it.
MAX_BACKLOG_ROWS = 400
MAX_HISTORY_ROWS = 400
MAX_HIGHLIGHT_ROWS = 100

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
       ("/benchmarks", "Benchmark results"), ("/highlights", "Topic highlights")]


def log(msg):
    print(f"[hermes-fleetops-ui] {msg}", flush=True)


def esc(x):
    """Everything rendered goes through here. Not decoration: these pages show Hugging Face repo
    ids and model-card-derived advisory text (anyone can publish a repo saying anything) and
    LLM-generated digest highlight lines. None of it is trusted markup."""
    return html.escape("" if x is None else str(x), quote=True)


def shell(title, body, subtitle=""):
    nav = "".join(f'<a href="{p}">{n}</a>' for p, n in NAV)
    return (f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            f"<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>{esc(title)} — hermes-fleetops</title><style>{STYLE}</style></head><body>"
            f"<header><h1>hermes-fleetops</h1><nav>{nav}</nav>"
            f"<span style=\"color:var(--dim);margin-left:auto\">{esc(subtitle)}</span></header>"
            f"<main>{body}</main>"
            f"<footer>Read-only. Starting, stopping and approving stay operator actions over SSH "
            f"and Matrix — this page deliberately has no write routes. "
            f"Rendered {esc(datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))}.</footer>"
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


def split_task_id(task_id):
    """`scout:<role>:<model id with / written __>` — the encoding hermes-model-scout.py's
    `task_id_for()` applies. Decoded here rather than displayed raw, since the point of the page
    is to read it at a glance."""
    parts = str(task_id).split(":", 2)
    if len(parts) == 3 and parts[0] == "scout":
        return parts[1], parts[2].replace("__", "/")
    return "", str(task_id)


def render_backlog():
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
        fit = esc(d.get("fit") or "")
        copy_cell = ""
        if state == "approved":
            cmd = f"hermes-benchmark-run.py --model-id {model_id} --role {role}"
            copy_cell = (f'<button onclick="navigator.clipboard.writeText(this.dataset.cmd)" '
                         f'data-cmd="{esc(cmd)}" title="{esc(cmd)}">copy command</button>')
        rows.append([
            f'<span class="pill s-{esc(state)}">{esc(state)}</span>',
            esc(role),
            f'<span class="mono">{esc(model_id)}</span>',
            esc(d.get("category") or t["topic"] or ""),
            fit,
            advisory,
            esc(when(t["updated_at"])),
            copy_cell,
        ])
    note = (f'{summary}<br>Showing {len(rows)} of at most {MAX_BACKLOG_ROWS}. '
            f'<b>No decide buttons, by design</b> — approving, rejecting or deferring a candidate '
            f'goes through the Matrix reply <span class="mono">hermes-model-scout-gate.py</span> '
            f'watches for. A second path to the same privileged decision, gated only by this '
            f"page's shared Basic Auth, would be weaker than the one that exists.")
    return (f'<p class="note">{note}</p>' +
            table(["state", "role", "candidate", "category", "fit", "advisory", "updated", ""],
                  rows))


def page_backlog():
    body = section("Model benchmark backlog", "", render_backlog)
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


def fmt_value(v):
    if v is None:
        return '<span class="empty">no result</span>'
    if isinstance(v, (int, float)):
        return f"{v:.4g}"
    return esc(v)


def render_history_current():
    """Each model's latest run per suite — the same grouping `hermes-benchmark-compare.py
    --model-id` already does, read off the same history rather than recomputed differently."""
    latest = {}
    for e in read_history():                       # already newest-first
        model_id = str(e.get("model_id") or "?")
        for name, metric, value in suite_results(e):
            latest.setdefault((model_id, name), (e, metric, value))
    rows = []
    for (model_id, suite), (e, metric, value) in sorted(latest.items()):
        rows.append([
            f'<span class="mono">{esc(model_id)}</span>',
            esc(suite),
            f'<span class="mono">{esc(metric or "")}</span>',
            fmt_value(value),
            esc(e.get("role_or_endpoint") or ""),
            esc(when(e.get("date"))),
        ])
    return table(["model", "suite", "metric", "value", "role", "latest run"], rows, numeric={3})


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
    search = ('<p><input type="search" id="q" placeholder="filter rows…" '
              'oninput="var v=this.value.toLowerCase();'
              'document.querySelectorAll(\'#all tbody tr\').forEach(function(r){'
              'r.style.display=r.textContent.toLowerCase().indexOf(v)<0?\'none\':\'\';});">'
              f'<span class="note">{len(shown)} row(s).{cap}</span></p>')
    return search + '<div id="all">' + table(
        ["when", "model", "role", "suite results", "notes"], rows) + "</div>"


def page_benchmarks():
    body = section("Current — each model's latest run per suite", "", render_history_current)
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


# ── server ────────────────────────────────────────────────────────────────────────────────────

ROUTES = {
    "/": lambda q: page_home(),
    "/backlog": lambda q: page_backlog(),
    "/models": lambda q: page_models(),
    "/benchmarks": lambda q: page_benchmarks(),
    "/highlights": page_highlights,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-fleetops-ui/1.0.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, code, blob, content_type="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(blob)))
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
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
        except Exception as exc:
            # A whole-page failure is still a page: the nav has to keep working so the operator can
            # reach the sections that are fine.
            log(f"unhandled error rendering {parsed.path}: {type(exc).__name__}: {exc}")
            self._send(500, shell("Error", f'<div class="err"><b>This page failed to render.</b> '
                                           f'{esc(type(exc).__name__)}: {esc(exc)}</div>'))


def main():
    if not (USER and PASSWORD):
        sys.exit("FLEETOPS_UI_USER and FLEETOPS_UI_PASSWORD are required — "
                 "this service must not run unauthenticated")
    if BIND in ("0.0.0.0", "::", ""):
        # The bind address is a real part of this service's security posture, not a default to
        # shrug at: S12 established that this fleet's loopback/tailnet binds are the boundary.
        sys.exit(f"refusing to bind {BIND!r} — FLEETOPS_UI_BIND must be a specific tailnet or "
                 f"loopback address")
    log(f"listening on {BIND}:{PORT} (read-only; no write routes)")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
