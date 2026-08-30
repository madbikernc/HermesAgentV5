#!/usr/bin/env python3
# Version: 1.4.2
#
# 1.4.2 (2026-08-30) — HermesAgentV5 consolidation: TOPICS_PATH repointed from
# HermesAgentV4 to HermesAgentV5.
#
# 1.4.1 — bug fix, direct report: "selecting a large number of candidates and
# trying to decline does not seem to work." Root-caused from the real
# service journal, not guessed: `discovery_candidates` has grown to 3559 real
# pending rows (checked live against vectors.db), past MAX_BULK_IDS (2000) --
# "select all" checked every visible row regardless, so Apply always sent an
# oversized request the server correctly rejects with a 400. That alone
# would just be an undersized limit; a second, independent bug is what made
# it look like nothing happened at all rather than like a failure: decide()
# set the error text/display *before* its own trailing `await load()`, and
# load()'s very first line unconditionally hides #err (and clears the
# selection) -- so any decide() failure, bulk or not, was being displayed
# and then wiped again before the browser could ever paint it, for every
# version of this tool that has ever had this error-handling code, not just
# this one report. Direct follow-up from the user pointed at the actual
# right fix over raising the cap: "if the max is 2000, it should only select
# 2000 even when doing select all" -- `selectAll` now stops checking boxes at
# MAX_BULK_IDS (now injected into the page so the client enforces the same
# number the server does, not a second hardcoded copy) rather than checking
# every row and letting Apply fail outright; the checkbox goes
# `indeterminate` and the bulk bar's own selection count says so explicitly
# ("limit 2000 per apply -- apply this batch, then select again for more").
# decide() reordered so its error is applied *after* load() finishes, not
# before, and mirrored into a new #bulkErr span inside the sticky bulk bar --
# #err itself sits below the candidate table, which has no pagination and
# can run to thousands of rows, so a bulk-specific error needed a copy
# somewhere guaranteed visible without scrolling past all of them.
#
# 1.4.0 — direct request: added a second tab, "Topics of Interest", a plain
# textarea editor for infra/hermes-news-digest/topics.yaml (Phase 31) so it
# no longer requires an SSH session and a text editor to populate. No YAML
# parsing added here either -- GET/POST /api/topics round-trip the file's
# raw text verbatim, same "flat list, # comments, blank lines ignored" rule
# hermes-news-digest.py's own load_topics() already enforces; the live
# "N active topic(s)" counter re-implements that exact same skip logic
# client-side, purely for feedback, and is never what's actually saved (the
# full raw text is, comments and blank lines included, so nothing already in
# the file is silently dropped by opening it here). Both services run as
# `pmoney` against the same checkout, so a save here is the same file the
# daily/weekly timers read on their next run -- confirmed by reading both
# systemd units rather than assumed.
#
# 1.3.0 — direct request: added "case sensitive" and "regex" toggles next to
# the search box. Both operate purely client-side on the same matchesSearch()
# gate that visibleRows()/render() already funnel through, so a row hidden by
# either mode is exactly as unselectable as a row hidden by plain substring
# search always was -- no new bypass around the select-all/bulk-apply
# invariant 1.1.0 established. An invalid regex leaves searchRegex null and
# matchesSearch() falls back to showing every row (with the error surfaced in
# #searchErr) rather than silently filtering everything out while the user is
# mid-edit of a pattern.
#
# 1.2.0 — direct request: portal now lists newest-first (by id descending).
# Done client-side in visibleRows(), not by changing
# hermes_rag_common.list_candidates()'s own query order -- that function is
# shared with the CLI's `list` subcommand, which keeps its existing
# oldest-first order unchanged.
#
# 1.1.0 — direct request: added a client-side search box (title/context/
# source/type substring match, case-insensitive). Filtering and "select
# all" both operate on the same visibleRows() list, so a hidden (non-
# matching) candidate can never end up in a row's own checkbox and can
# never be select-all'd. Selection is also cleared on every search-box
# change -- without that, a row checked before a new search term hid it
# would still sit in `selected` and get silently swept into the next bulk
# apply, defeating the point of filtering first.
#
# Phase 33 (IMPLEMENTATION_PLAN.md §7). Browser review UI for the discovery
# candidates hermes-rag-source-discovery.py's `scan` finds — the same
# `discovery_candidates` table, decided through the same
# hermes_rag_common.decide_candidate() the CLI's `decide` subcommand uses, so
# a decision made here and a decision made from the terminal are the exact
# same code path, never two implementations that could drift. This tool only
# lists and decides; it never scans (that stays the hourly timer's job) and
# never acquires/indexes a resource itself, same scope cut the CLI already
# documents.
#
# Two things the CLI made tedious enough to justify a second interface: (1)
# there was no way to see many pending candidates at once with a fast way to
# act on each, only one `decide <id> <decision>` invocation at a time; (2) no
# way to apply the same decision to several candidates in one action (e.g. a
# batch of clearly-declinable mentions from one noisy episode) without typing
# one command per id. Both a per-row dropdown (fires immediately on change)
# and a checkbox-driven bulk bar (apply one decision to every selected row)
# are here for that reason.
#
# Boring on purpose, same shape as hermes-broker.py: stdlib
# http.server/ThreadingHTTPServer, no new pip dependency, one inspectable
# SQLite file, HTTP Basic Auth checked with hmac.compare_digest (browser-
# native login prompt — a human uses this, unlike the broker's/router's
# bearer-token machine-to-machine auth). Runs on `spark`, the one host
# vectors.db actually lives on (a local file, never networked — see
# hermes_rag_common.py's own module docstring); anywhere else would mean
# either exposing that file over the network or building a second API that
# just relays to this one. Binds the tailnet IP only, never 0.0.0.0 — a
# human's browser reaches this, not another fleet node, so LAN/internet
# exposure buys nothing and only widens the attack surface on a decision
# surface that can change what gets indexed into RAG.
#
# Config, all from the environment (injected by
# hermes-rag-discovery-portal-wrapper.sh, which fetches the credential from
# Vaultwarden and execs this — same pattern as hermes-broker-wrapper.sh,
# secrets never touch disk):
#   PORTAL_USER        required — HTTP Basic Auth username
#   PORTAL_PASSWORD    required — HTTP Basic Auth password
#   PORTAL_BIND        default 100.96.59.79 (spark's own tailnet IP — see
#                                 IMPLEMENTATION_PLAN.md §3's hardware table)
#   PORTAL_PORT        default 8093
"""
hermes-rag-discovery-portal.py — browser review UI for RAG source-discovery
candidates (Phase 33).

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-discovery-portal.py
"""
import base64
import hmac
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

BIND = os.environ.get("PORTAL_BIND", "100.96.59.79")
PORT = int(os.environ.get("PORTAL_PORT", "8093"))
USER = os.environ.get("PORTAL_USER", "")
PASSWORD = os.environ.get("PORTAL_PASSWORD", "")

MAX_BODY = 64 * 1024  # generous for a bulk-decide of thousands of ids, bounded
MAX_BULK_IDS = 2000

STATUS_OPTIONS = ["pending"] + sorted(rag.VALID_DISCOVERY_DECISIONS)

# Same file hermes-news-digest.py reads (its own REPO_DIR/TOPICS_PATH,
# tools/hermes-news-digest.py) -- both services run as pmoney against the
# same checkout, confirmed against both units' real ExecStart/User lines.
TOPICS_PATH = Path.home() / "HermesAgentV5" / "infra" / "hermes-news-digest" / "topics.yaml"


def log(msg):
    print(f"[hermes-rag-discovery-portal] {msg}", flush=True)


INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RAG Source Discovery — Review</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f5f4; --fg: #1c1c1a; --card: #ffffff; --border: #d8d6d0;
    --muted: #6b6a64; --accent: #2563eb; --danger: #b91c1c; --ok: #15803d;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #17171a; --fg: #e8e7e3; --card: #202024; --border: #38373d; --muted: #9c9a94; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header { padding: 1rem 1.25rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
           border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 2; }
  header h1 { font-size: 1.05rem; margin: 0; font-weight: 600; }
  select, input[type=text], button {
    font: inherit; padding: 0.35rem 0.5rem; border-radius: 6px; border: 1px solid var(--border);
    background: var(--card); color: var(--fg);
  }
  button { cursor: pointer; }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  #bulkbar { display: none; align-items: center; gap: 0.5rem; padding: 0.6rem 1.25rem;
             background: var(--card); border-bottom: 1px solid var(--border); position: sticky; top: 3.2rem; z-index: 2; }
  #bulkbar.show { display: flex; flex-wrap: wrap; }
  main { padding: 0 1.25rem 2rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.02em; }
  td.mention { color: var(--muted); max-width: 28ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.citation { max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr.busy { opacity: 0.5; }
  .empty, .error { padding: 2rem 0; color: var(--muted); }
  .error { color: var(--danger); }
  .flash-ok { outline: 2px solid var(--ok); }
  nav.tabs { display: flex; gap: 0.4rem; }
  nav.tabs button { border-radius: 6px 6px 0 0; }
  nav.tabs button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  #topicsView textarea {
    width: 100%; min-height: 60vh; font: 0.9rem/1.4 ui-monospace, "SF Mono", Consolas, monospace;
    padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border);
    background: var(--card); color: var(--fg); resize: vertical;
  }
  #topicsView .toolbar { display: flex; align-items: center; gap: 1rem; margin: 1rem 0; }
</style>
</head>
<body>
<header>
  <h1>RAG Source Discovery</h1>
  <nav class="tabs">
    <button id="tabCandidates" class="active">Candidates</button>
    <button id="tabTopics">Topics of Interest</button>
  </nav>
  <label id="statusFilterLabel">Status
    <select id="statusFilter"></select>
  </label>
  <input type="text" id="searchBox" placeholder="search title / context / source…" style="min-width:22ch">
  <label style="font-size:0.85rem; display:flex; align-items:center; gap:0.3rem">
    <input type="checkbox" id="caseSensitive"> Case sensitive
  </label>
  <label style="font-size:0.85rem; display:flex; align-items:center; gap:0.3rem">
    <input type="checkbox" id="useRegex"> Regex
  </label>
  <button id="refreshBtn">Refresh</button>
  <span id="countLabel" style="color:var(--muted)"></span>
  <span id="searchErr" style="color:var(--danger)"></span>
</header>
<div id="bulkbar">
  <span id="selCount"></span>
  <select id="bulkDecision"></select>
  <input type="text" id="bulkNotes" placeholder="notes (optional)">
  <button id="bulkApply" class="primary">Apply</button>
  <button id="bulkClear">Clear selection</button>
  <span id="bulkErr" style="color:var(--danger)"></span>
</div>
<main>
  <section id="candidatesView">
    <table id="table" style="display:none">
      <thead>
        <tr>
          <th><input type="checkbox" id="selectAll"></th>
          <th>ID</th><th>Type</th><th>Title</th><th>Context</th><th>Source</th><th>Found</th><th>Decision</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="empty" class="empty" style="display:none">No candidates.</div>
    <div id="err" class="error" style="display:none"></div>
  </section>
  <section id="topicsView" style="display:none">
    <p style="color:var(--muted); font-size:0.9rem">
      One topic per line. Blank lines and lines starting with <code>#</code> are ignored —
      everything else (comments included) is saved back exactly as written.
      Read daily/weekly by <code>hermes-news-digest.py</code> (Phase 31).
    </p>
    <textarea id="topicsText" spellcheck="false"></textarea>
    <div class="toolbar">
      <button id="topicsSave" class="primary">Save</button>
      <span id="topicsCount" style="color:var(--muted)"></span>
      <span id="topicsStatus"></span>
    </div>
    <div id="topicsErr" class="error" style="display:none"></div>
  </section>
</main>
<script>
const DECISIONS = __DECISIONS__;
const STATUSES = __STATUSES__;
const MAX_BULK_IDS = __MAX_BULK_IDS__;
const selected = new Set();
let rowsData = [];
let searchTerm = '';
let caseSensitive = false;
let useRegex = false;
let searchRegex = null;

function compileSearch() {
  const errEl = document.getElementById('searchErr');
  errEl.textContent = '';
  searchRegex = null;
  if (useRegex && searchTerm) {
    try {
      searchRegex = new RegExp(searchTerm, caseSensitive ? '' : 'i');
    } catch (e) {
      errEl.textContent = 'Invalid regex: ' + e.message;
    }
  }
}

function matchesSearch(r) {
  if (!searchTerm) return true;
  const fields = [r.title, r.mention_text, r.source_citation, r.source_corpus, r.type]
    .map(v => String(v ?? ''));
  if (useRegex) {
    // An invalid pattern leaves searchRegex null (error already shown by
    // compileSearch) -- don't filter down to zero rows on a typo mid-edit.
    if (!searchRegex) return true;
    return fields.some(f => searchRegex.test(f));
  }
  const haystack = fields.join('   ');
  return caseSensitive
    ? haystack.includes(searchTerm)
    : haystack.toLowerCase().includes(searchTerm.toLowerCase());
}

function visibleRows() {
  // Newest first -- the API returns oldest-first (id ascending), same order
  // the CLI's `list` subcommand has always used and still does; reversed
  // here, display-only, so the portal doesn't change what that shared
  // function returns for its other caller.
  return rowsData.filter(matchesSearch).sort((a, b) => b.id - a.id);
}

function fillSelect(el, opts, placeholder) {
  el.innerHTML = "";
  if (placeholder) el.appendChild(new Option(placeholder, ""));
  for (const o of opts) el.appendChild(new Option(o, o));
}
fillSelect(document.getElementById('statusFilter'), STATUSES);
document.getElementById('statusFilter').value = 'pending';
fillSelect(document.getElementById('bulkDecision'), DECISIONS, 'choose decision…');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (resp.status === 401) { document.getElementById('err').textContent = 'Unauthorized — reload and sign in.'; throw new Error('401'); }
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.error || ('HTTP ' + resp.status));
  return body;
}

async function load() {
  document.getElementById('err').style.display = 'none';
  const status = document.getElementById('statusFilter').value;
  const qs = status ? ('?status=' + encodeURIComponent(status)) : '';
  try {
    const body = await api('/api/candidates' + qs);
    rowsData = body.candidates;
  } catch (e) {
    document.getElementById('err').textContent = 'Load failed: ' + e.message;
    document.getElementById('err').style.display = 'block';
    return;
  }
  selected.clear();
  updateBulkBar();
  render();
}

function render() {
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  const visible = visibleRows();
  document.getElementById('table').style.display = visible.length ? '' : 'none';
  document.getElementById('empty').style.display = visible.length ? 'none' : '';
  document.getElementById('empty').textContent = rowsData.length ? 'No candidates match the search.' : 'No candidates.';
  document.getElementById('countLabel').textContent = searchTerm
    ? `${visible.length} of ${rowsData.length} candidate(s) match`
    : `${rowsData.length} candidate(s)`;
  const selectAllEl = document.getElementById('selectAll');
  selectAllEl.checked = false;
  selectAllEl.indeterminate = false;
  for (const r of visible) {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    tr.innerHTML = `
      <td><input type="checkbox" class="rowsel" data-id="${r.id}"></td>
      <td>${r.id}</td>
      <td>${esc(r.type)}</td>
      <td>${esc(r.title)}</td>
      <td class="mention" title="${esc(r.mention_text)}">${esc(r.mention_text)}</td>
      <td class="citation" title="${esc(r.source_citation)} (${esc(r.source_corpus)})">${esc(r.source_citation)}</td>
      <td>${esc((r.created_at || '').slice(0, 10))}</td>
      <td><select class="decisionsel" data-id="${r.id}"></select></td>
    `;
    const sel = tr.querySelector('.decisionsel');
    fillSelect(sel, STATUSES);
    sel.value = r.status;
    sel.addEventListener('change', () => decide([r.id], sel.value, null, tr));
    tr.querySelector('.rowsel').addEventListener('change', (ev) => {
      if (ev.target.checked) selected.add(r.id); else selected.delete(r.id);
      updateBulkBar();
    });
    tbody.appendChild(tr);
  }
}

function updateBulkBar() {
  const bar = document.getElementById('bulkbar');
  const bulkErrEl = document.getElementById('bulkErr');
  // Stays visible (not just selected.size > 0) while a bulk-decide error is
  // still showing -- decide() clears selected via load() even on failure, so
  // gating solely on selection size would hide the bar (and the error inside
  // it) in the same instant it appears.
  bar.classList.toggle('show', selected.size > 0 || !!bulkErrEl.textContent);
  const capped = selected.size >= MAX_BULK_IDS;
  document.getElementById('selCount').textContent = selected.size + ' selected'
    + (capped ? ` (limit ${MAX_BULK_IDS} per apply — apply this batch, then select again for more)` : '');
  document.getElementById('bulkApply').disabled = selected.size === 0;
}

document.getElementById('selectAll').addEventListener('change', (ev) => {
  const boxes = Array.from(document.querySelectorAll('.rowsel'));
  document.getElementById('bulkErr').textContent = '';
  if (ev.target.checked) {
    // Cap at MAX_BULK_IDS -- the server rejects a bulk decide over that count
    // outright (a real 400, not a soft warning), and with a pending queue
    // that can outgrow the cap (a real backlog of 3559 vs. a 2000 cap is what
    // surfaced this), "select all" must stop selecting at the limit instead
    // of checking every box and then failing the whole batch on Apply.
    let capped = false;
    for (const cb of boxes) {
      const id = Number(cb.dataset.id);
      if (selected.size >= MAX_BULK_IDS && !selected.has(id)) {
        cb.checked = false;
        capped = true;
        continue;
      }
      cb.checked = true;
      selected.add(id);
    }
    ev.target.indeterminate = capped;
  } else {
    boxes.forEach(cb => { cb.checked = false; selected.delete(Number(cb.dataset.id)); });
  }
  updateBulkBar();
});

document.getElementById('bulkClear').addEventListener('click', () => {
  selected.clear();
  document.getElementById('bulkErr').textContent = '';
  document.querySelectorAll('.rowsel').forEach(cb => cb.checked = false);
  updateBulkBar();
});

document.getElementById('bulkApply').addEventListener('click', () => {
  const decision = document.getElementById('bulkDecision').value;
  if (!decision) return;
  const notes = document.getElementById('bulkNotes').value || null;
  decide(Array.from(selected), decision, notes, null);
});

async function decide(ids, decision, notes, rowEl) {
  if (rowEl) rowEl.classList.add('busy');
  let errMsg = null;
  try {
    const body = await api('/api/decide', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ids, decision, notes}),
    });
    const failed = Object.entries(body.results).filter(([, r]) => !r.ok);
    if (failed.length) {
      errMsg = failed.map(([id, r]) => `id ${id}: ${r.error}`).join('; ');
    }
  } catch (e) {
    errMsg = 'Decide failed: ' + e.message;
  }
  // load() resets #err (and, for a bulk call, clears the selection the
  // error would otherwise refer to) as its very first action -- setting the
  // message *before* awaiting load() here previously meant it was visible
  // for effectively zero time, wiped out the instant load() ran, which is
  // why a rejected bulk decide (e.g. the "too many ids" cap) looked like it
  // "did nothing" rather than like a failure. Applying it after load()
  // finishes is what actually gets it in front of the user.
  await load();
  if (errMsg) {
    document.getElementById('err').textContent = errMsg;
    document.getElementById('err').style.display = 'block';
  }
  // The #err div sits below the candidate table, which can run to thousands
  // of rows with nothing paginating it -- for a bulk action (rowEl is only
  // ever null for the bulk-apply path, never a per-row change) also mirror
  // the outcome into the sticky bulk bar itself, so it's visible without
  // scrolling past the whole table, and cleared on a subsequent success so a
  // stale failure message doesn't linger. load() already cleared `selected`
  // and called updateBulkBar() once (with bulkErr not yet updated for this
  // call) -- calling it again now is what keeps the bar's visibility and
  // text in sync with the real outcome.
  if (!rowEl) {
    document.getElementById('bulkErr').textContent = errMsg || '';
    updateBulkBar();
  }
}

document.getElementById('statusFilter').addEventListener('change', load);
document.getElementById('refreshBtn').addEventListener('click', load);

function onSearchChange() {
  // Selection is scoped to what's currently visible -- changing the filter
  // could otherwise leave a previously-checked, now-hidden row still in
  // `selected`, where a bulk apply would silently affect a row the user can
  // no longer see. Clearing on every search change keeps that impossible.
  searchTerm = document.getElementById('searchBox').value.trim();
  caseSensitive = document.getElementById('caseSensitive').checked;
  useRegex = document.getElementById('useRegex').checked;
  compileSearch();
  selected.clear();
  updateBulkBar();
  render();
}
document.getElementById('searchBox').addEventListener('input', onSearchChange);
document.getElementById('caseSensitive').addEventListener('change', onSearchChange);
document.getElementById('useRegex').addEventListener('change', onSearchChange);

// ---- Topics of Interest tab (Phase 31 topics.yaml editor) ----------------

const candidatesOnlyEls = ['statusFilterLabel', 'searchBox', 'caseSensitive', 'useRegex', 'refreshBtn', 'countLabel', 'searchErr']
  .map(id => document.getElementById(id).closest('label') || document.getElementById(id));

function showView(name) {
  const isTopics = name === 'topics';
  document.getElementById('candidatesView').style.display = isTopics ? 'none' : '';
  document.getElementById('topicsView').style.display = isTopics ? '' : 'none';
  document.getElementById('bulkbar').classList.toggle('show', !isTopics && selected.size > 0);
  document.getElementById('tabCandidates').classList.toggle('active', !isTopics);
  document.getElementById('tabTopics').classList.toggle('active', isTopics);
  candidatesOnlyEls.forEach(el => { el.style.visibility = isTopics ? 'hidden' : ''; });
  if (isTopics) loadTopics();
}
document.getElementById('tabCandidates').addEventListener('click', () => showView('candidates'));
document.getElementById('tabTopics').addEventListener('click', () => showView('topics'));

function countActiveTopics(text) {
  return text.split('\\n').filter(ln => ln.trim() && !ln.trim().startsWith('#')).length;
}

function updateTopicsCount() {
  const n = countActiveTopics(document.getElementById('topicsText').value);
  document.getElementById('topicsCount').textContent = `${n} active topic${n === 1 ? '' : 's'}`;
}

async function loadTopics() {
  document.getElementById('topicsErr').style.display = 'none';
  document.getElementById('topicsStatus').textContent = '';
  try {
    const body = await api('/api/topics');
    document.getElementById('topicsText').value = body.content;
    updateTopicsCount();
  } catch (e) {
    document.getElementById('topicsErr').textContent = 'Load failed: ' + e.message;
    document.getElementById('topicsErr').style.display = 'block';
  }
}

document.getElementById('topicsText').addEventListener('input', updateTopicsCount);

document.getElementById('topicsSave').addEventListener('click', async () => {
  document.getElementById('topicsErr').style.display = 'none';
  const statusEl = document.getElementById('topicsStatus');
  statusEl.textContent = 'Saving…';
  try {
    await api('/api/topics', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({content: document.getElementById('topicsText').value}),
    });
    statusEl.textContent = 'Saved.';
    setTimeout(() => { if (statusEl.textContent === 'Saved.') statusEl.textContent = ''; }, 3000);
  } catch (e) {
    statusEl.textContent = '';
    document.getElementById('topicsErr').textContent = 'Save failed: ' + e.message;
    document.getElementById('topicsErr').style.display = 'block';
  }
});

load();
</script>
</body>
</html>
""".replace(
    "__DECISIONS__", json.dumps(sorted(rag.VALID_DISCOVERY_DECISIONS))
).replace(
    "__STATUSES__", json.dumps(STATUS_OPTIONS)
).replace(
    "__MAX_BULK_IDS__", json.dumps(MAX_BULK_IDS)
)


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-rag-discovery-portal/1.4.1"

    def log_message(self, fmt, *args):
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, code, body, content_type="application/json"):
        blob = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _authed(self):
        presented = self.headers.get("Authorization", "")
        expected = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
        if presented and hmac.compare_digest(presented, expected):
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="hermes-rag-discovery-portal"')
        blob = json.dumps({"error": "unauthorized"}).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)
        return False

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("invalid Content-Length header")
        if length < 0 or length > MAX_BODY:
            raise ValueError(f"invalid or too-large body ({length} bytes)")
        return self.rfile.read(length)

    # ---- routes -------------------------------------------------------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"ok": True, "version": self.server_version})
            return
        if not self._authed():
            return

        if parsed.path == "/":
            self._send(200, INDEX_HTML.encode(), content_type="text/html; charset=utf-8")
            return

        if parsed.path == "/api/candidates":
            qs = urllib.parse.parse_qs(parsed.query)
            status = (qs.get("status") or [""])[0].strip() or None
            conn = rag.connect_discovery()
            candidates = rag.list_candidates(conn, status=status)
            self._send(200, {"candidates": candidates})
            return

        if parsed.path == "/api/topics":
            content = TOPICS_PATH.read_text(encoding="utf-8") if TOPICS_PATH.is_file() else ""
            self._send(200, {"content": content})
            return

        self._send(404, {"error": "no such route"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._authed():
            return

        if parsed.path == "/api/decide":
            try:
                payload = json.loads(self._body() or b"{}")
            except (ValueError, json.JSONDecodeError) as e:
                self._send(400, {"error": f"bad body: {e}"})
                return
            ids = payload.get("ids")
            decision = payload.get("decision")
            notes = payload.get("notes") or None
            if not isinstance(ids, list) or not ids or not all(isinstance(i, int) for i in ids):
                self._send(400, {"error": "ids must be a non-empty list of integers"})
                return
            if len(ids) > MAX_BULK_IDS:
                self._send(400, {"error": f"too many ids (max {MAX_BULK_IDS})"})
                return
            if not isinstance(decision, str):
                self._send(400, {"error": "decision is required"})
                return
            conn = rag.connect_discovery()
            results = {}
            for cid in ids:
                try:
                    old_status = rag.decide_candidate(conn, cid, decision, notes=notes)
                    results[str(cid)] = {"ok": True, "old_status": old_status}
                except ValueError as e:
                    results[str(cid)] = {"ok": False, "error": str(e)}
            self._send(200, {"results": results})
            return

        if parsed.path == "/api/topics":
            try:
                payload = json.loads(self._body() or b"{}")
            except (ValueError, json.JSONDecodeError) as e:
                self._send(400, {"error": f"bad body: {e}"})
                return
            content = payload.get("content")
            if not isinstance(content, str):
                self._send(400, {"error": "content is required"})
                return
            TOPICS_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = TOPICS_PATH.with_suffix(".yaml.tmp")
            tmp.write_text(content, encoding="utf-8")
            tmp.replace(TOPICS_PATH)  # atomic on the same filesystem -- no torn read for a same-second timer
            self._send(200, {"ok": True})
            return

        self._send(404, {"error": "no such route"})


def main():
    if not USER or not PASSWORD:
        sys.exit("PORTAL_USER and PORTAL_PASSWORD are required — this service must not run unauthenticated")
    log(f"listening on {BIND}:{PORT}")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
