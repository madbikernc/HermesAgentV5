# Firmament Market Watch — Target Design

**Version:** 1.13.0

**Status:** Planned, not executed. Direct operator request, 2026-10-17. This is a *target-state* design
for a new daily capability — nothing in `tools/`, `infra/`, or `skills/` exists for it yet. Same
relationship as `firmament-fleet-target-architecture.md` has to the fleet as a whole: a proposal to build
against, not a description of anything running. `IMPLEMENTATION_PLAN.md`'s **S38** is the stage that
tracks building it and points back here for the full spec — the same split **S23** uses for
`MINECRAFT_BOTS_DESIGN.md`.

**Purpose:** daily tracking of publicly traded equities across major global exchanges, categorized by
standard sector/industry and by operator-defined thematic tags (AI-related, fintech, and others),
historical price storage, a daily trend/movers report, and the ability to pull any of that reporting on
demand from the Fleet Matrix room.

**Status legend**, same convention as `firmament-fleet-target-architecture.md`:
- `[DECIDED]` — operator made an explicit choice
- `[PROPOSED]` — design recommendation, not yet ratified
- `[UNKNOWN]` — needs discovery/research before building
- `[RISK]` — flagged concern requiring validation or an operator decision

---

## 1. The ask, restated precisely

1. Pull a list of traded stocks from the top exchanges globally.
2. Categorize them into sector and industry — named examples: information technology, AI-related,
   agricultural, fintech, industrials, energy and utilities — "including but not limited to," i.e. an
   open, extensible list.
3. Pull available historic price data into a database or table.
4. At an interval appropriate to each exchange's own posting cadence, pull new values.
5. Daily, produce a report covering: sectors/industries trending up or down overall; biggest-increasing
   companies; fastest-decreasing companies; companies with the strongest positive 30-day trend; companies
   with the strongest negative 30-day trend.
6. In the Fleet Matrix room, let the operator request any of the above reports specifically, on demand.

---

## 2. Vendor decision — verified live, 2026-10-21 `[DECIDED]`

Direct operator instruction: use free services only, for now, and limit market coverage to whatever
those free services can actually support. Checked against the real endpoints before writing this down —
the same discipline S25 applied to its own "keyless X reader" premise, which turned out to be false and
got that stage deferred rather than built against a wrong assumption. This section replaces the original
vendor survey below with what was actually measured.

**Ruled out: Stooq.** Named in the first draft of this section as the best free bootstrap candidate —
live-tested 2026-10-21 and it no longer qualifies. Every `stooq.com/q/d/l/` request from this environment
(plain `curl`, and again with a real browser user-agent) is met with a client-side JavaScript proof-of-
work challenge — a server-issued nonce, a SHA-256 grind, a `/__verify` POST — before it serves anything,
the same class of anti-bot gate `hermes-feed-reader.py`'s own finding 2 already warned about for CISA's
feeds, except this one cannot be worked around with a different HTTP client or header set, since it
requires executing JavaScript. Ruled out for a fleet whose whole pipeline discipline is deterministic,
headless, no-browser calls.

**Decided: Yahoo Finance's unofficial chart endpoint, for price data.**
`https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?range=<r>&interval=1d` — live-tested
2026-10-21 with a plain `curl`, no API key, no JS challenge: real data back for a US ticker (`AAPL`,
NasdaqGS), an LSE ticker (`VOD.L`, priced in GBp), and a Tokyo ticker (`7203.T`, JPX, priced in JPY), plus
a full `range=1y` pull (28 KB, ~252 trading days). The response carries `timestamp`,
`open`/`high`/`low`/`close`/`volume`, **and `adjclose`** — split/dividend-adjusted close comes for free,
which directly resolves §11 risk 5 (corporate actions) for whatever this source covers.
`[RISK]`, carried forward honestly rather than dropped now that it's chosen: this is the same unofficial
endpoint `yfinance` wraps, undocumented and known historically to be throttled or reshaped without
notice — today's free option, not a guaranteed-stable one. `tools/hermes-market-sync.py` must degrade
loudly (a logged failure, not a silent empty day) if Yahoo ever blocks or reshapes this, the same honesty
convention `hermes-news-digest.py` applies to "nothing new."

**Decided: Wikipedia's "List of S&P 500 companies" for the instrument list and categorization.**
`en.wikipedia.org/wiki/List_of_S%26P_500_companies` — live-tested 2026-10-21, HTTP 200, a real
`id="constituents"` `wikitable` with columns `Symbol | Security | GICS Sector | GICS Sub-Industry |
Headquarters Location | Date added | CIK | Founded`. Free, keyless, no JS challenge, and it gives the
GICS sector/industry categorization §4 already calls for directly — no separate classification step
needed for this market.

**What this rules in, for now: the US market only.** Checked the same way for a European and an Asian
leg before assuming they'd follow the same shape, and they don't, cleanly, yet: the FTSE 100 Wikipedia
article's "Constituents" section has no embedded per-company table, and the Nikkei 225 article has no
constituent table at all. Yahoo's price endpoint already reaches both markets fine (confirmed live
against `VOD.L` and `7203.T` above) — there is simply no equally clean free *list-plus-sector* source
confirmed yet for either. Rather than build against an assumed source, §3 narrows the MVP to the one
market where both halves are verified today; international coverage is a named follow-up gated on
finding (or building) an equivalent free constituent list per additional exchange, not guessed at here.

---

## 3. Scope for the MVP `[DECIDED]`

**S&P 500 (US) only**, sourced entirely from the two free services decided in §2: the instrument list,
names, and GICS sector/industry from Wikipedia's constituents table; daily price history and ongoing
sync from Yahoo's chart endpoint, one call per ticker. ~500 tickers — small enough that sector-trend
aggregation and movers/30-day-trend reporting are meaningful from day one, and small enough to sync well
within a single daily run against an unofficial, rate-limit-unknown endpoint.

Widening past the US is a real follow-up, not assumed into this design: it needs its own free, keyless,
no-JS instrument-list-plus-sector source per additional exchange, confirmed live the same way §2
confirmed this one — not before. Widening the universe later is otherwise just a data change (§5's
`instruments` table gains rows), not a rebuild.

---

## 4. Categorization — standard sector/industry vs. operator-defined thematic tags `[PROPOSED]`

**Standard sector/industry** comes from the vendor's own classification per instrument (GICS, or the
vendor's nearest equivalent) — this metadata already exists for essentially every public company and
needs no fleet-side judgment call.

**Thematic tags** (AI-related, fintech, and anything else wanted) don't map cleanly onto a sector
taxonomy — AI companies span Information Technology, Communication Services, and Industrials; fintech
spans Financials and Information Technology. These need an operator-maintained config file, the same
convention `feeds.yaml`/`topics.yaml` already establish: a new `tags.yaml`, matched by ticker or keyword,
no code change to add or remove a tag. The six named in the request (information technology, AI,
agricultural, fintech, industrials, energy & utilities) seed the file; "including but not limited to" is
exactly what an editable YAML list is for.

**`[DECIDED]` S38g, direct operator request — two curated watchlists get "special attention," not just
a `tags.yaml` line.** `frontier_llm` (the S&P 500's own in-house frontier-model developers: `GOOGL`/`GOOG`,
`META`, `MSFT`, `AMZN` — OpenAI/Anthropic/xAI have no ticker, being private) and `ai_hardware` (companies
whose core business IS AI-specific silicon/memory/networking, not general IT hardware that merely resells
AI servers: `NVDA`, `AMD`, `AVGO`, `MU`, `INTC`, `MRVL`, `ANET`) are ticker-curated — exact membership, not
sector/keyword matching, unlike every other tag — and §7 gives each its own dedicated per-ticker report
section rather than folding them into the generic tag-trend line every other tag gets. Checked against
the real S&P 500 constituents table before being written down, same discipline §2 already set for this
whole design: `TSM` and `ARM` are real AI-silicon names but are **not** S&P 500 members, so they were left
off rather than added as rules that would silently match nothing.

**`[DECIDED]` S38h, direct operator follow-up request — Market Watch should periodically check whether
a ticker needs adding to `frontier_llm`/`ai_hardware`.** Six of the eight tags already self-maintain:
`apply_tags()` re-evaluates every sector/keyword rule against the full universe on every sync, so a new
S&P 500 entrant matching, say, `sector | Energy` is picked up automatically. The two curated watchlists
above have no such mechanism by design. A sector/industry heuristic was measured, not assumed, before
building anything: the only two GICS industries plausible for a frontier-LLM developer —
`Systems Software` and `Interactive Media & Services` — matched 6/7 and 1/4 **wrong** real S&P 500 names
(`CRWD`/`FTNT`/`GEN`/`NOW`/`PANW`/`TWLO`; `RDDT`) against the real live universe. Too imprecise to drive
an automatic addition, so classification instead routes through `hermes-router.py`'s `dispatch` role: a
bounded candidate pool (every US instrument in Information Technology/Communication Services/Consumer
Discretionary not already curated or previously classified) is batch-classified (15 tickers/call, plain
stdlib `urllib`, the same shape `hermes-model-scout.py`'s own advisory `narrative()` call uses — not
`hermes_rag_common.router_chat()`, which needs the RAG venv) as `frontier_llm`/`ai_hardware`/`neither`.
**Every verdict is advisory and only ever proposed, never auto-applied** — written to a new
`tag_proposals` table (§5) and, for a real `frontier_llm`/`ai_hardware` verdict, posted to FleetOps.
A human approves or rejects via the Matrix gate (§8); only an explicit `market tag approve <TICKER>`
reply causes `hermes-market-gate.py` to append the real line to `tags.yaml` (atomically) and re-apply
immediately. A `neither` verdict is recorded too (so the pool shrinks to near-zero after the one-time
catch-up instead of re-classifying the same ~150-200 tickers forever) but needs no human action.

**Correction to this section's own earlier text:** "no code change to add or remove a tag" (above) is no
longer true for exactly these two tags, and only on an explicit human approval of an LLM-proposed
candidate — never silently, never unattended. `tags.yaml`'s own header carries the same correction.

---

## 5. Storage `[PROPOSED]`

A new, dedicated SQLite store — `/mnt/hermes-data/market/market.db` — not folded into `hermes-memory`.
This is bulk time-series reference data, not conversational/task state, the same distinction
`model-benchmark`'s `history.jsonl` and the RAG store's `vectors.db` already draw against `hermes-memory`.

```
instruments(ticker, exchange, name, currency, sector, industry, first_seen, last_seen,
            UNIQUE(ticker, exchange))
tags(ticker, exchange, tag)                                  -- re-derived from tags.yaml each sync, not hand-edited per row
prices(ticker, exchange, date, open, high, low, close, adj_close, volume,
       UNIQUE(ticker, exchange, date))
sync_state(exchange, last_synced_date)                        -- per-exchange watermark; a non-trading day is "nothing new," not an error
report_items(report_date, category, item_type, rank, ticker_or_group, metric_value, text,
             UNIQUE(report_date, category, item_type, rank))  -- one row per report line, the same reshape S27c proved for highlight tables; a future browsable report page (§9) and the Matrix gate (§8) both read this
tag_proposals(ticker, exchange, candidate_tag, rationale, state, proposed_at, decided_at,
              UNIQUE(ticker, exchange))  -- S38h: one row per ticker ever classified by the tag-scout. state is
                                         -- 'proposed' (awaiting a human reply), 'approved', 'rejected', or
                                         -- 'cleared' (verdict was 'neither' -- no human action, never re-classified)
```

**`[RISK]` Percentage change, not raw price delta, is the metric for every cross-company/cross-exchange
ranking** (movers, 30-day trend). Returns are currency-invariant; raw price deltas across different
reporting currencies are not comparable and would silently rank a weak JPY mover above a strong GBP one.
Stated explicitly so the price-delta version is never the one that ships by accident. Moot for the MVP's
single-currency (USD) S&P 500 universe, but the column and the rule both stay in from day one since §3
already names international expansion as the next step.

**`adj_close` resolves §11 risk 5 (corporate actions) for this source.** Yahoo's chart endpoint (§2)
returns split/dividend-adjusted close directly — movers and 30-day trend are computed from `adj_close`,
never raw `close`, so a stock split never shows up as a fake multi-hundred-percent move.

---

## 6. Sync cadence `[DECIDED]`

"An appropriate interval, based on the posting tactics of the various exchanges" — read against what's
actually available: free/affordable global equity data is end-of-day, not intraday streaming. Real-time
or intraday quotes are a separately priced, materially larger product and a materially larger build —
named out of scope for this design (§11), not assumed as a later phase of it.

Given end-of-day is the realistic grain and §3 scopes the MVP to one market (US), "appropriate interval"
means **one daily sync, timed after NYSE/Nasdaq close** (21:00 UTC during EDT, 20:00 UTC during EST) —
one `hermes-market-sync.timer`, not a per-exchange fleet of them. A non-trading day (weekend or holiday)
is logged as "nothing new," the same honesty convention `hermes-news-digest.py` already applies to "no
news today." **The per-exchange design this section originally specified is the right shape for
international expansion** (§3) — exchanges close at very different times worldwide, so a second covered
exchange needs its own timer, staggered after its own close, the same per-source skip-and-retry
discipline `hermes-feed-reader.py` already uses — kept here as the scaling path, not built for a
single-market MVP that doesn't need it yet.

---

## 7. Daily report `[PROPOSED]`

One push per day — a single report with several sections, unlike S27's six separate per-topic emails —
covering exactly what was asked:

- Sectors/industries/thematic tags with an overall up or down trend
- **A dedicated "Frontier LLM Watch" / "AI Hardware Watch" section (S38g)**, every member of
  §4's two curated watchlists shown individually with its own daily and 30-day move — not folded
  into the generic tag-trend line or left to only make the top-N movers cut by chance
- Biggest-increasing companies, fastest-decreasing companies (by % change)
- Strongest positive and negative 30-day % trend

**Delivery:** email via the existing `email-sintra` Vaultwarden item and `send_email()` convention (the
same helper `hermes-news-digest.py`/`hermes-model-scan.py` already use), **and** a short version posted
into the FleetOps Matrix room on the same run — visible in Matrix the day it's generated, not only in
email, before the operator ever has to ask for it. STE100-lite register throughout, per `STYLE_GUIDE.md`
and the fleet-wide §6.4 decision in `firmament-fleet-target-architecture.md`: short declarative sentences,
one fact per sentence.

Every number in the daily push is computed deterministically from `prices`/`report_items` — **no model
call anywhere in this pipeline.** If a one-line narrative "why" commentary is ever wanted later, it goes
through `hermes-router.py` like S20b's advisory call — screened by Layer 1/2, explicitly labeled as
advisory, never the source of a number — not built into the MVP, since nothing in the request asks for
narrative judgment, only the facts listed above.

---

## 8. On-demand Matrix reports `[PROPOSED]`

The literal ask: "allow the user to request any of the reports specifically." This fleet's live Matrix
surface has no general conversational agent yet — `IMPLEMENTATION_PLAN.md` §4.4 records that "the
interactive persona that eventually speaks through the presenter is a separate decision, deferred." Every
existing user-triggered FleetOps-room capability today is a **dedicated gate script watching a strict
command grammar**, not free text routed through an LLM (`hermes-model-scout-gate.py`'s
`benchmark <id>`/`reject <id>`/`defer <id>`/`override <id>`; `hermes-self-repair-promote-gate.py`'s
`promote <id>`/`skip <id>`). This design follows that same pattern rather than inventing conversational
routing that doesn't exist anywhere else in the fleet yet.

New `hermes-market-gate.py`, watching the FleetOps room, same "always re-fetch and re-check real state,
never trust the chat message alone" rule as both precedents:

| Command | Behavior |
|---|---|
| `market report` | Re-render and post the most recent daily report in full. |
| `market sector <name>` | That sector/industry/tag's current trend and today's constituents. |
| `market movers up` / `market movers down` | Today's biggest gainers / decliners. |
| `market trend30 up` / `market trend30 down` | 30-day leaders / laggards. |
| `market ticker <SYMBOL>` | One instrument's recent price and trend. |
| `market sector list` | post the available sector names. |
| `market tag pending` | S38h: list every tag-scout proposal awaiting a human reply. |
| `market tag approve <TICKER>` | S38h: apply a proposed tag — appends to `tags.yaml`, re-applies immediately. |
| `market tag reject <TICKER>` | S38h: reject a proposed tag, permanently (until `override`). |
| `market tag override <TICKER>` | S38h: the only way back from `rejected`, same semantics as `hermes-model-scout-gate.py`'s own `override`. |

Every reply is read back from `report_items`/`prices` directly — nothing here calls a model, so there is
no screening-ordering question for this half of the stage (contrast S20a/S25/S26, which ingest open-
internet free text and do carry one). An unknown command, unknown ticker, or unknown sector is a named
error, not silence — the same discipline the two existing gates already apply to an unrecognized `<id>`.
The four `market tag ...` commands are the one exception to "nothing here calls a model": they act on a
verdict `hermes-market-sync.py`'s tag-scout already computed and logged (§4/§7's own screened,
advisory-only call) — the gate itself still calls no model and makes no judgment of its own.

---

## 9. Browsable report history `[DECIDED]`

`hermes-fleetops-ui.py` already has four read-only report pages (S21) plus S21e's per-highlight browser,
added only once S27c's schema reshape existed for it to read. `report_items`' one-row-per-line shape (§5)
is built the same way on purpose, so a fifth report page is a cheap follow-on once this stage has run long
enough to have something worth browsing — not specified here, to avoid designing a page against data that
doesn't exist yet.

**S38i, direct operator request ("add a formatted report to the Fleetops-ui"), built 2026-10-25** —
exactly this follow-on, now that S38a-h's real data exists to browse. A new `/market` page
(`hermes-fleetops-ui.py` 2.6.0), added to `NAV` and the home page's card list like every other
S21 report. Two sections:

- **"Market Watch — daily report"** — a date picker (defaulting to, and falling back to on an
  unknown/not-yet-synced date, the most recent `report_date` on file) over one flat, filterable
  table: section (the same human labels `REPORT_SECTION_TITLES` gives the email), rank,
  ticker/group, signed %, and the full rendered detail line. Rows are read with
  `hermes_market_common.read_report_items()` and re-emitted in `REPORT_SECTION_ORDER` — the exact
  fixed order the email body uses — rather than the table's own `item_type`-alphabetical `ORDER BY`,
  so "Sector trends" renders ahead of "30-day laggards" here the same way it does in the email,
  not wherever the two sort lexically. This is the same function `render_full_report_text()`
  itself calls, so the page can never show different numbers for the same day than the daily
  email, the Matrix notice, or a `market report` gate reply.
- **"Pending tag candidate proposals"** — every `tag_proposals` row still in `state='proposed'`
  (S38h's scout output awaiting a human reply), with the same "deciding stays a Matrix reply, not
  a button here" framing §8's gate commands and `/recommendations`'s own REC-findings section
  already use. No new write route; read-only end to end, same as the rest of this page.

Reuses `hermes-fleetops-ui.py`'s existing `ro_sqlite()` helper against `MARKET_DB` (same env
var/default `hermes-market-sync.py`/`-report.py`/`-gate.py` already use) rather than opening a
second kind of connection — the file's own test asserts exactly one `sqlite3.connect()` call
exists in its source, and this page does not add a second. `hermes_market_common.py` is imported
directly at module top level (a plain `import`, the same way `hermes-market-report.py`/
`hermes-market-sync.py` already import it) rather than through the lazy/fallback machinery
`load_gate()` uses for the scout gate — that machinery exists because the gate carries write
credentials and a transition table whose corruption is a materially different risk; this module
is a stdlib-only schema/compute dependency, the same character of import those two tools already
make unconditionally.

---

## 10. Screening and secrets `[PROPOSED]`

**Correction, S38b (1.3.0):** no vendor API key is needed. This section originally proposed a new
Vaultwarden item (`market-data-api`) — written before §2's vendor decision, which settled on
keyless free sources (Yahoo's chart endpoint, Wikipedia) for the MVP. That premise is moot now
that the decision is made. The only secrets Market Watch touches are the two
`hermes_alert_common.py` already resolves end-to-end (`email-sintra` for delivery, `matrix-fleetops`
for the FleetOps gate), reused exactly as that module exposes them (`send_email()`/
`matrix_notice()`/`_resolve_fleetops()`) — not a new secrets mechanism, and no new egress-guard
registry entry either, since those two helpers already wrap their own network calls with a
hardcoded caller identity regardless of which tool invokes them.

Any vendor-supplied free text (a company description field, an index-membership note) is third-party,
open-internet-adjacent content and gets the same treatment `hermes-model-scan.py`'s `_sanitize_hf_text()`
and S26's layer-1 tagging already give comparable text: bounded, stripped, and — if it ever reaches a
model at all — only via `hermes-router.py`, which screens every inbound call with Layer 1 and Layer 2
(live since S22, 2026-10-09). Per §7 above, this design's report pipeline makes **no model call**, so this
is a forward-looking guard, not a live exposure — recorded so it isn't forgotten if a narrative feature is
added later.

---

## 11. Explicitly out of scope, risks, and open questions

1. **RESOLVED 2026-10-21 — vendor and starting universe decided, per §2/§3.** Yahoo's chart endpoint +
   Wikipedia's S&P 500 list, US-only MVP. Carried the same way other resolved risks in this project's
   docs stay visible rather than being deleted once answered.
2. **Intraday/real-time quotes are a separate, larger, costlier capability** — not assumed as a future
   phase of this design, just named as a different project if ever wanted.
3. **"List of traded stocks" as a literal daily bulk pull is not how this vendor pairing actually
   works, and that's by design, not a gap.** Wikipedia's constituents table is a slow-changing directory
   (re-read, not expected to change daily); Yahoo's chart endpoint is the daily price call, one ticker at
   a time. S38a already confirmed this split live rather than assuming a single bulk endpoint existed —
   the same "read the real API before specifying behavior" discipline `hermes-model-scout.py`/S20a
   applied to Hugging Face's.
4. **RESOLVED 2026-10-25, S38j — keep indefinitely, no pruning.** Confirmed live: no deletion
   path exists anywhere in this codebase for `prices`, and a direct check of Yahoo's chart
   endpoint (the real `User-Agent` this stack sends) showed 10 years of daily history available
   per ticker — the ceiling is far past what's needed. Decision: retain every row forever; even
   5 years × ~503 tickers is only ~630k rows (~60MB), trivial at this universe size. Revisit only
   if ticker count or per-row columns grow by orders of magnitude.
5. **RESOLVED for this source, per §5 — `adj_close`.** Yahoo's chart endpoint returns split/dividend-
   adjusted close directly; movers/30-day trend read `adj_close`, never raw `close`. Revisit only if a
   future non-Yahoo source for an additional market doesn't provide the same field.
6. **Thematic tag drift.** `tags.yaml` is operator-maintained prose/ticker matching, the same
   "editorial, not computed" category `topics.yaml` already is — it will need occasional upkeep as
   company classifications shift, same as `feeds.yaml`.
7. **Exchange trading-hours and holiday calendars.** §6's single daily sync needs NYSE/Nasdaq's real
   close time and holiday calendar for the MVP — a fixed, well-documented single calendar, not the
   multi-exchange version of this risk international expansion will reopen.

---

## 12. Build sequence

Tracked in `IMPLEMENTATION_PLAN.md` as sub-stages under **S38**:

- **S38a** — **Done 2026-10-21.** Vendor decision and bounded starting universe, verified live against
  the real endpoints (§2/§3): Yahoo's chart endpoint for price, Wikipedia's S&P 500 list for
  instruments/sector, US-only MVP.
- **S38b** — **Built 2026-10-24.** `tools/hermes_market_common.py` (shared schema/connect/
  compute/render) and `tools/hermes-market-sync.py` (`instruments`/`prices`/`sync_state`), plus
  the daily timer/service units under `infra/hermes-market-sync/`. Wikipedia's constituents table
  is parsed with a small stdlib `HTMLParser` subclass rather than `bs4` (not installed on this
  session's dev machine; keeps the offline suite dependency-free). `to_yahoo_symbol()`'s
  dotted-to-dashed mapping (`BRK.B` → `BRK-B`) is implemented but explicitly flagged as
  unverified until a real live call — see S38f below.
- **S38c** — **Built 2026-10-24**, same session as S38b. `infra/hermes-market-sync/tags.yaml`
  (seeded with the six named tags) and `apply_tags()`/`load_tags()` in `hermes-market-sync.py`
  1.1.0.
- **S38d** — **Built 2026-10-24.** `tools/hermes-market-report.py` — sector-trend/tag-trend/
  movers/30-day-trend computation, `report_items` write (delete-then-reinsert per day, guarded
  against erasing an earlier good run), email + Matrix push via `hermes_alert_common.py`. One
  correction made while building, against this document's own `[PROPOSED]` schema: every
  `item_type` uses `category="ALL"` uniformly (an earlier draft had `sector_trend`/`tag_trend`
  use the group's own name as `category`, which made `rank` redundant — see the file's own header
  comment for why).
- **S38e** — **Built 2026-10-24.** `tools/hermes-market-gate.py` — the six-command FleetOps
  grammar (§8's table), each handler re-querying `market.db` fresh.
- **S38f** — **Built and fully live-verified 2026-10-24.** Offline: 58 checks
  (`infra/hermes-market-sync/tests/test_hermes_market_sync.py`, covering sync and the gate) + 43
  checks (`infra/hermes-market-report/tests/test_hermes_market_report.py`, covering the shared
  compute module and the report tool) — 101 total, no network/Vaultwarden/Matrix dependency. One
  real bug found and fixed by this suite before it ever ran against real data: `top_n()`
  originally sorted the *entire* ticker list by direction without filtering by sign, so with
  fewer real movers than the requested count, a falling ticker could be listed under "today's
  biggest gainers."
  Live, on `dgx-spark`: real Wikipedia pull (503 instruments, 0 skipped); `to_yahoo_symbol()`
  confirmed against real multi-class tickers (`BRK.B`→`BRK-B`, `BF.B`→`BF-B` both synced
  successfully); a full 400-day backfill across all 503 tickers, zero failures, 200,063 rows
  written; `tags.yaml` applied (315 ticker-tag pairs, six real tag distributions); the real daily
  report computed and delivered — confirmed landed by reading the FleetOps Matrix room's own
  event stream, not the log; all three systemd units installed and run for real
  (`Result=success` for both oneshots, `active (running)` for the gate) rather than only by hand;
  and a full gate round trip — all six command shapes plus both refusal paths posted into the
  real room and every reply read back from the room itself, including both named refusals
  (`Unknown sector/tag 'NotRealSector'`, `Unknown ticker 'ZZZZ'`) and the one unmatched message
  (`market bogus foo`) correctly drawing no reply at all. Both timers confirmed scheduled for
  their next real run via `systemctl list-timers`.
- **S38g** — **Built and fully live-verified 2026-10-24, direct operator request after S38f
  closed.** §4's two curated watchlists (`frontier_llm`, `ai_hardware`) added to `tags.yaml`;
  `hermes_market_common.py` 1.1.0 gains `ai_watch_block()`/`render_ai_watch_line()` and the
  `AI_WATCH_SECTIONS` mapping; `hermes-market-report.py` 1.1.0's `compute_report()` writes two
  new dedicated `report_items` blocks (`ai_watch_llm`/`ai_watch_hw`) and adds a one-line "AI
  watch: `<ticker>` `<moved>`% today" mention to the short Matrix summary naming whichever
  watchlist ticker moved the most. 19 new offline checks (120 total across both suites) —
  including one against the real, committed `tags.yaml` confirming NVDA/GOOGL are actually
  present in their respective watchlists, not just in a synthetic test fixture.
  Live, on `dgx-spark`: `tags.yaml` re-applied against the real `instruments` table (all 7
  `ai_hardware` tickers and all 5 `frontier_llm` tickers, including both `GOOG`/`GOOGL` share
  classes, matched); the real report rendered both dedicated sections with real per-ticker
  daily+30-day numbers (e.g. "MU rose 2.46% today, down 18.12% over 30 days"); a real report run
  through the actual systemd unit (`Result=success`) delivered the new "AI watch: MU rose 2.46%
  today." Matrix line, confirmed by reading the room's own event stream; and `market sector
  frontier_llm`/`market sector ai_hardware`/`market ticker NVDA` were each posted into the real
  room and their replies read back from the room itself — the existing gate handlers needed no
  code change to pick up the two new tags.
- **S38h** — **Built 2026-10-25, direct operator follow-up request** ("the market watch service
  should periodically check to see if it needs to add stock tickers to any section, especially
  frontier_llm and ai_hardware"). A sector heuristic was measured first (§4) and ruled out as too
  imprecise (75-86% false positives on the only two plausible GICS industries). New
  `tag_proposals` table (§5); `hermes_market_common.py` 1.2.0 gains `append_tag_rule()` (atomic
  tempfile-then-rename line append), `sanitize_llm_input()` (copied, not imported, from
  `hermes_rag_common.py` — that module needs the RAG venv), `tag_scout_pool()`, and the relocated
  `TAGS_PATH`/`load_tags()`/`apply_tags()` (moved from `hermes-market-sync.py` so
  `hermes-market-gate.py` can call `apply_tags()` immediately after an approval — hyphenated tool
  files can't import each other directly here). `hermes-market-sync.py` 1.2.0 gains the new
  `scan-tags` subcommand (folded into `daily`): batches the candidate pool through
  `hermes-router.py`'s `dispatch` role (plain stdlib, the same shape `hermes-model-scout.py`'s own
  advisory call uses), records every verdict including `neither` (so the pool self-shrinks), and
  posts proposals to FleetOps. `hermes-market-gate.py` 1.1.0 gains `market tag
  approve/reject/override/pending` (§8) — `approve` is the first command in this gate that opens
  a write connection or touches the filesystem outside `market.db`, both deliberate and narrow.
  One real bug caught by this stage's own test suite before it ever touched a real file: the
  first version of `append_tag_rule()` put the provenance note inline on the same line as the
  rule, which silently corrupted the parsed ticker pattern (`load_tags()`'s parser only
  recognizes a whole-line comment) — fixed to put the note on its own comment line above the
  rule. 29 new offline checks (158 total across both suites).
  Live, on `dgx-spark`, 2026-10-25: the real candidate pool (131 tickers across Information
  Technology/Communication Services/Consumer Discretionary) was classified for real through
  `dispatch`. **The real result directly validates the whole premise of this stage**: every one
  of the exact tickers §4's heuristic measurement found as false positives (`FTNT`/`GEN`/`NOW`/
  `PANW`/`TWLO`/`RDDT`) was correctly cleared by the LLM, each with a specific, sound rationale
  (e.g. "CrowdStrike is a cybersecurity software company, not involved in frontier AI model
  development or primary AI hardware manufacturing") — the sector heuristic would have gotten
  every one of them wrong. Zero genuine candidates remained pending after this run (the curated
  lists already cover the real universe), so the approve/reject/override gate commands were
  verified with two clearly-marked synthetic test proposals instead of a real one — posted,
  actioned, and read back from the real FleetOps room, then fully removed from `tags.yaml`/
  `tag_proposals`/`tags` afterward so no test data was left in production. One real finding along
  the way: `TESTCO`'s approval correctly added zero rows to the real `tags` table, since
  `apply_tags()`'s ticker match found no real instrument named `TESTCO` — confirming the
  mechanism is safe against a nonsense ticker, not just a real one. The installed
  `hermes-market-sync.service` unit (reinstalled to `/etc/systemd/system/` with its new
  `hermes-router.service` dependency, `daemon-reload`d) was run for real end to end
  (`Result=success`) through all four steps including `scan-tags`, confirming "a wrapper that
  works by hand and a unit that works are not the same claim" held for this stage too.
- **S38i** — **Built, live-verified, and committed 2026-10-25, direct operator request** ("add a
  formatted report to the Fleetops-ui"), fulfilling §9's long-deferred browsable-report-history
  follow-on. New `/market` page on `hermes-fleetops-ui.py` (2.6.0) — detail in §9 above. A later
  same-day direct operator request enriched the page further (2.8.0): every ticker-level detail
  line now names the registered company in parens, and the daily report renders one table per
  section (an `<h3>` divider/title) instead of a repeated "section" column.
- **S38j** — **Built, live-verified, and committed 2026-10-25, direct operator request** ("have a 'Graph' button [on /market]
  that breaks out a new window containing a time-series graph with the history that is remembered
  in The Firmament fleet... evaluate if [the] appstack is retaining enough history, preferring up
  to one year... allow picking a time duration, which will autoscale the time-axis"). Retention
  was evaluated first, live, per §11 risk 4's resolution above — the operator then raised the
  backfill goal from that evaluation's ~1 year to 5 years once 10 years was confirmed available.
  New `ticker_price_history()` in `hermes_market_common.py` (1.3.0); `hermes-market-sync.py`
  (1.3.0) renames `sync_prices()`'s `backfill_days` to `backfill_range` (Yahoo's `Nd` token turned
  out to count *trading* days, not calendar days — a calendar-year goal needs Yahoo's own `Ny`
  token instead) and backfills a ticker to `BACKFILL_RANGE` ("5y") the same day it's newly added
  to `instruments`, closing the real gap found live: a post-backfill ticker (`VYLR`/`HONA`/
  `FDXF`) was getting only the normal 5-day catch-up window, so "keep N years" was never actually
  true for it. `hermes-fleetops-ui.py` (2.10.0) adds a "Graph" button to every ticker-level
  `/market` row (the same `TICKER_LEVEL_ITEM_TYPES` allowlist the company-name splice uses —
  sector/tag-trend rows get none, since no per-sector time series is stored, only a recomputed
  daily average) opening `/market/history?ticker=...&days=N` in a new tab: a server-rendered
  inline SVG line chart (dataviz-skill-informed — single series needs no legend, axis range
  always rescales to the selected window's own min/max, which is the promised autoscaling) with a
  hover crosshair/tooltip, and a duration `<select>` (1M/3M/6M/1Y/5Y/All). 17 new checks (310
  total, up from 293) on `hermes-fleetops-ui.py`'s own suite; `hermes-market-sync.py`'s suite
  gains 10 (111 total, up from 101). One real bug caught by the new suite before it ever shipped:
  the ticker query parameter, reflected into `section()`'s heading argument (unlike `shell()`'s
  own title, never auto-escaped, since every other caller passes a static string), was the first
  user-controlled value ever placed there — a hostile ticker, escaped everywhere else on the
  page, still broke out via the heading until `page_market_history()` was fixed to `esc()` it.
  Live, on `dgx-spark`: a real `prices --backfill-range 5y` run against the full 503-ticker
  universe (additive/idempotent `INSERT ... ON CONFLICT DO UPDATE`, confirmed against a running
  `/market` page mid-backfill correctly showing a transient "database is locked" on that one
  section — the rollback-journal write lock this stack has always had, not a regression — then
  resolving cleanly once the backfill committed). Real result: NVDA's own history actually
  extended from its original ~1.6-year backfill out to a full 5 years (`2021-10-25`→`2026-10-23`),
  confirmed through every duration bucket on the real `/market/history` page returning the
  correct real date window (30/90/180/365/1825/all), a real short-history ticker (`VYLR`, added
  after the original backfill) degrading sanely rather than crashing, and an unknown ticker
  showing its named empty state — checked over both loopback and the real public tailnet URL
  (`https://spark.tail1a534.ts.net:8103/market`), with all 52 real ticker-level rows on the live
  report carrying a working Graph link.
- **S38k** — **Built, live-verified, and committed 2026-10-25, direct operator request** (a "Company" button alongside Graph,
  summarizing "what the company does, how long they've been in business, how long they have been
  publicly traded, anything else... that may help understand that company"). There is no stored
  fact base for this anywhere in `market.db` — unlike the Graph button, this has to come from an
  LLM's own general knowledge, the same way S38h's tag-scout classification already does. New
  `/market/company?ticker=...` route, opened in a new tab from every ticker-level row's second
  button. `hermes-fleetops-ui.py`'s own `summarize_company()` calls `dispatch` with the exact
  shape `hermes-market-sync.py`'s `call_router()`/`classify_batch()` already establish (plain
  stdlib POST, `X-Hermes-Screening: analysis`, no `check_destination()` wrap); the Wikipedia-
  scraped ticker/name/sector/industry are sanitized and `<DATA>`-wrapped the same way
  `classify_batch()` already treats them as untrusted. **Deliberately no caching** — regenerated
  fresh on every page load, the same stated policy `/models` already has for its own one other
  live router call (`read_router_models()`'s "No cache and no copy of this data is kept here").
  This was the deciding factor against a `company_profiles` cache table: `check_write_surface()`
  enforces exactly one `sqlite3.connect(` call site and exactly one write route in this file, and
  matching `/models`' existing no-cache policy satisfies the feature without touching either
  invariant. `.graph-btn` renamed `.row-btn` (never semantically graph-only) so the new button
  shares its style, including a monkeypatched `call_router()` confirming the real request shape
  and a router-failure case confirmed to degrade via `section()`'s own wrapper rather than
  raising out of the page (offline check count given with S38l below, both landed together).
  Live, on `dgx-spark`: a real `/market/company?ticker=HPE` call through the real `dispatch`
  role returned a sound, well-formed profile (business, 1939 founding/2015 spin-off, 1970s IPO
  claim, Spring TX headquarters, ProLiant/Nimble products) in ~4 seconds — confirms `dispatch`
  being always-resident (not on-demand) pays off for an interactive button, not just for a
  background sync job.
- **S38l** — **Built, live-verified, and committed 2026-10-25, direct operator request**: a "Monitored stocks" section on
  `/market`, a personal watchlist above the daily report, with an "Add" form — seeded with HPE
  (Hewlett Packard Enterprise, confirmed live on the real `instruments` table before being
  written down). Storage is a new flat-text file via `hermes_market_common.py` 1.4.0's new
  `load_monitored_tickers()`/`add_monitored_ticker()` — not a new SQLite table, so
  `check_write_surface()`'s "exactly one `sqlite3.connect(`" invariant stays untouched. **A real
  deploy-time finding, not reasoned about in advance**: the file was first placed inside the
  repo (`tags.yaml`'s own shape) and the live Add form consistently failed with a named
  "badaction" — `hermes-fleetops-ui.service` runs under `ProtectSystem=strict` +
  `ProtectHome=read-only` (documented in its own unit file as deliberate: "it opens every store
  read-only ... so it has no business writing anywhere on this host"), so the repo itself is
  unwritable to this process regardless of what the code does. `ReadWritePaths=
  /home/pmoney/.hermes/state` is the one grant that unit has — the same directory
  `HERMES_USAGE_DB` already lives in — so `MONITORED_TICKERS_PATH`'s default moved there
  instead. The relocation is also the more correct call on its own merits, sandboxing aside: a
  live, per-host, user-mutated watchlist is local state, not git-tracked editorial config like
  tags.yaml. The real architecture change is the OTHER invariant `check_write_surface()`
  enforces: this file now has a genuine SECOND write route, `/market/monitor/add` alongside
  `/backlog/decide`, both inside the one
  `do_POST` (still exactly one handler function, sharing the body-length cap and CSRF check) — a
  deliberate, documented relaxation of "serves only `/backlog/decide`," not a silent one;
  `check_write_surface()`'s own assertion text was updated to match rather than deleted. A ticker
  is checked against the real `instruments` table before ever being written (a named "Not a
  tracked instrument" refusal, not a silent no-op or a crash) — the file-writing
  `add_monitored_ticker()` itself deliberately stays DB-free (it doesn't even know what
  `instruments` is), matching `append_tag_rule()`'s own narrow scope. Each monitored row reuses
  `hermes_market_common.render_ai_watch_line()` (a single ticker's own daily + 30-day move, no
  ranking involved — exactly what a watchlist entry needs, already built for S38g's AI-watch
  sections) and a new `ticker_row_buttons()` helper shared with the daily report's own
  ticker-level rows (factored out now that two call sites need the identical Graph+Company
  button pair). S38k and S38l landed together, before either was separately verified: 24 new
  offline checks on `hermes-fleetops-ui.py`'s own suite (334 total, up from 310) plus 8 on
  `hermes_market_common.py`'s file-format behavior via `hermes-market-sync.py`'s own suite (119
  total, up from 111).
  Live, on `dgx-spark`: the sandboxing finding above (§ this entry) surfaced on the very first
  real Add attempt, fixed, and then the full real round trip confirmed — HPE added for real
  through the live Add form (the actual seeding mechanism, not a hand-written file), a
  lowercase re-add correctly reported "already monitored," an unmatched ticker and a wrong CSRF
  token each refused by name, and the real `/market` page showing `HPE (Hewlett Packard
  Enterprise)` with working Graph/Company links — checked over both loopback and the real public
  tailnet URL.

---

## 13. Exit gate — **MET, 2026-10-25 — S38a-h in full; S38i-l excluded, see below**

A real daily email **and** Matrix post landing on a real trading day, citing real sector movement and
real movers an operator can check against an independent source; and a real `market <command>` round trip
through the actual gate script and actual Matrix replies, not a dry run — the same two-part bar (scheduled
push confirmed, on-demand pull confirmed) every comparable stage in `IMPLEMENTATION_PLAN.md` sets for
itself.

Both halves done live on `dgx-spark`, 2026-10-24: the daily report ran for real through its own
systemd unit (`Result=success`) and its `[market]` notice was read back directly from the live
FleetOps Matrix room's event stream; the email send logged no failure. The gate round trip covered
every command in §8's table plus both named refusal paths, each posted into the real room and
each reply read back from the room itself, not trusted from a log line — see S38f's entry in §12
for the full detail. **Not yet independently cross-checked against an outside finance site by a
human** — the numbers (Energy +2.68%, CCI +9.06% top gainer, etc.) are real and internally
consistent, but this exit gate's own "an operator can check against an independent source" clause
is satisfied by the data being real and checkable, not by someone having actually checked it yet.

**S38i, S38j, and S38k are not part of this bar** — all three are a read-only view over data
S38a-h's own exit gate already established as real (S38j's history graph and S38k's company
summary both read the exact same `instruments`/`prices` rows `market sector`/`market ticker`
already read, drawn from a new angle), not a new push/pull path of their own. **S38l is
different in kind** — it genuinely adds a new write path (`/market/monitor/add`), so it isn't
excluded from this bar by the same "read-only" reasoning; it simply isn't the kind of thing this
bar measures at all (a Matrix daily-push/on-demand-pull round trip). Its own "done" is a real
add-ticker round trip through the live UI, stated in its own §12 entry. Each sub-stage's own
"done" is stated there instead of restated here. S38i, S38j, S38k, and S38l are all built,
live-verified on `dgx-spark`, and (as of the next revision) committed.

---

## 14. Benchmark evaluation (`CLAUDE.md` 1.2.0)

Evaluated against `FLEET_BENCHMARK_DESIGN.md` §4's gap structure, call recorded rather than skipped:
**no new benchmark scenario needed.** Every piece of this design that actually ships in the MVP — the
sync, the report computation, the Matrix gate — makes no model call at all (§7, §8), so there is no role
with a new accuracy question to measure. The one path that would touch a role is the optional, explicitly
deferred narrative "why" line (§7), routed through `dispatch` like S20b's advisory call — `dispatch`
already has coverage (`FLEET_BENCHMARK_DESIGN.md` §2's role-fitness bake-off, Tier 0 general capability),
so even building that later opens no new gap.

**Re-evaluated for S38h (2026-10-25), now that a `dispatch` call is real rather than hypothetical.**
The tag-scout's classification call (§4) is the same shape and the same role as the narrative-commentary
path above — one more one-off advisory judgment through `dispatch`'s existing Tier 0 general-capability
coverage, never the source of a fact that ships un-reviewed (every verdict stays `proposed` until a
human approves it). No new benchmark scenario needed here either; the conclusion above still holds, now
against a real call instead of a deferred one.

**Re-evaluated for S38i (2026-10-25): no model call at all, so no gap-structure question even
arises.** `/market` is a read-only view that reads `report_items`/`tag_proposals` straight off
`market.db` — the same character of change as every other `hermes-fleetops-ui.py` report page
(S21), none of which have ever needed an entry here, since none of them touch a role or make a
call through `hermes-router.py`. Call recorded per `CLAUDE.md`'s rule rather than silently
skipped, even though the answer here is the simplest of the three S38 evaluations in this section.

**Re-evaluated for S38j (2026-10-25): no model call at all, same conclusion as S38i's own
evaluation above.** The history-graph page reads `prices` straight off `market.db` and renders a
server-side SVG; the backfill-range rename and the new-ticker auto-backfill in
`hermes-market-sync.py` are plain scheduling/fetch-range changes, not a role or a
`hermes-router.py` call of any kind. No new benchmark scenario needed. Call recorded per
`CLAUDE.md`'s rule rather than silently skipped.

**Re-evaluated for S38k (2026-10-25): a real, new content-*generation* call through `dispatch`
— the first one `hermes-fleetops-ui.py` itself makes (its one other router use, `/models`, lists
metadata and never generates content via a role).** Same shape and role as the already-evaluated
narrative-commentary/tag-scout paths: one-off advisory free-text generation through `dispatch`'s
existing Tier 0 general-capability coverage (`FLEET_BENCHMARK_DESIGN.md` §2). No new benchmark
scenario needed — call recorded, not skipped.

**Re-evaluated for S38l (2026-10-25): no model call at all, same conclusion as S38i/S38j's own
evaluations above.** The "Monitored stocks" section is file I/O (`monitored-tickers.yaml`) plus
the same `daily_pct_changes()`/`trend30_pct_changes()`/`render_ai_watch_line()` compute/render
functions S38g already built and S38a-h's own exit gate already proved real — no role, no
`hermes-router.py` call anywhere in this feature. No new benchmark scenario needed. Call recorded
per `CLAUDE.md`'s rule rather than silently skipped.

What this design *is* relevant to, once actually built: `FLEET_BENCHMARK_DESIGN.md` gap 8 / §6.8
(`fleet_coder_build`) draws its corpus from exactly this shape of work — a direct operator request, a
vendor integration or parsing pipeline built from nothing to satisfy it. S38b/S38d/S38e's eventual build
commits are real candidates for that table. Not added now, because §6.8 and §8.6 both require real
commits as provenance, not a hypothetical future one — this is a note for whoever builds S38 to add its
own commit to that table in the same change, not a thing done here.

---

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-17 | Initial design — direct operator request for a daily global-exchange equity tracking capability: sector/industry and thematic categorization, historical price storage, a daily sector-trend/movers/30-day-trend report, and on-demand report requests from the Fleet Matrix room. Tracked as `IMPLEMENTATION_PLAN.md` S38. |
| 1.1.0 | 2026-10-20 | Added §14, recording the `CLAUDE.md` 1.2.0 benchmark-evaluation call: no new `FLEET_BENCHMARK_DESIGN.md` scenario needed (the MVP makes no model call; the one optional model-touching path reuses `dispatch`'s existing coverage), but the eventual build is a real candidate for §6.8's `fleet_coder_build` corpus once it has a commit. Also: §8's `market sector list` gate command was added to this file's body at some point without a version bump, breaking this project's own enforced convention — caught and folded into this bump rather than left unaccounted, since nothing else in this file's content changed meaning. Minor bump — new section, no prior guidance reversed. **Note added 2026-10-21: the top `**Version:**` header line was not actually updated when this row was written, the identical gap this row itself called out one paragraph up — caught and fixed in the 1.2.0 bump below, not silently left.** |
| 1.2.0 | 2026-10-21 | **S38a decided, direct operator instruction ("use whatever free services we can for now, limit markets to ones free services can report on") verified live before being written down.** §2 rewritten: Stooq ruled out (a real client-side JS proof-of-work challenge blocks every `stooq.com/q/d/l/` request from this environment, confirmed by curl with and without a browser user-agent) — Yahoo Finance's unofficial chart endpoint decided instead for price data (live-tested against a US/LSE/Tokyo ticker and a full 1-year pull, returns `adjclose` for free) and Wikipedia's "List of S&P 500 companies" decided for the instrument list/GICS sector (live-tested, real `wikitable`). §3 narrowed to US/S&P-500-only for the MVP after confirming FTSE 100/Nikkei 225 have no equally clean free constituent-list table yet — international expansion named as a real, gated follow-up rather than guessed at. §5 gained `adj_close`, resolving risk 5 (corporate actions) for this source. §6 simplified from a per-exchange timer fleet to one daily US-close timer, with the per-exchange design kept as the documented scaling path. §11 risks 1 and 5 marked resolved; §12's S38a marked done. Minor bump — open questions resolved and one early recommendation corrected against real evidence, nothing restructured. |
| 1.3.0 | 2026-10-24 | **S38b-f built: the full capability (direct operator request to build the whole remaining sequence), 101 offline checks passing, live verification explicitly NOT done.** §10 corrected: the "new Vaultwarden item" paragraph was stale after §2's keyless-source decision — removed, replaced with a note that this build reuses `hermes_alert_common.py`'s existing two secrets as-is. §12 updated with what each sub-stage actually built, including one schema correction found while building S38d (`report_items.category="ALL"` uniformly, not the group's own name — see that entry) and one real bug `test_hermes_market_sync.py`/`test_hermes_market_report.py` caught before any live run (`top_n()`'s sign-filtering gap). New files: `tools/hermes_market_common.py`, `tools/hermes-market-sync.py` (1.1.0), `tools/hermes-market-report.py`, `tools/hermes-market-gate.py`, `infra/hermes-market-sync/tags.yaml` + timer/service units, `infra/hermes-market-report/` timer/service units, both test files. Stated plainly per §13: this session had no fleet node, Vaultwarden, or Matrix access — every check above ran offline, against synthetic data, on a dev machine with no `bs4` installed (the Wikipedia table parser was written against stdlib `html.parser` instead, deliberately, rather than assume `bs4`'s real ambient availability on the deploy host would also hold here). `to_yahoo_symbol()`'s dotted-to-dashed ticker mapping is implemented but not live-verified. Minor bump — a planned stage built and tested, with its live-verification gap stated honestly rather than glossed over; nothing prior reversed. |
| 1.4.0 | 2026-10-24 | **§13's exit gate MET, live, minutes after 1.3.0 was written — the operator corrected this session's own "no fleet access" assumption.** Files copied directly onto `dgx-spark`'s existing checkout (not committed/pushed — no git action was requested this session) and run for real: Wikipedia pull (503 instruments), `to_yahoo_symbol()` confirmed against real `BRK.B`/`BF.B`, a full 400-day/503-ticker backfill (200,063 rows, zero failures), `tags.yaml` applied (315 pairs), the real report delivered and its Matrix notice read back from the room's own event stream, all three systemd units installed and run for real (`Result=success`/`active (running)`, not just by hand), and a full gate round trip — every command shape and both refusal paths posted into the real FleetOps room and every reply read back from the room itself. §12's S38f entry and §13 both rewritten from "not done" to the real result. Minor bump — a stage's live verification executed and its real record written in, nothing prior reversed. |
| 1.5.0 | 2026-10-24 | **S38g added: direct operator request for "special attention" and a dedicated report section for AI-specific-hardware and frontier-LLM-developer tickers.** New §4 paragraph: two ticker-curated (not sector/keyword) watchlists, `frontier_llm` (`GOOGL`/`GOOG`/`META`/`MSFT`/`AMZN` — the S&P 500's own in-house frontier-model developers; OpenAI/Anthropic/xAI have no ticker) and `ai_hardware` (`NVDA`/`AMD`/`AVGO`/`MU`/`INTC`/`MRVL`/`ANET` — AI-specific silicon/memory/networking, not general IT hardware resellers), checked against the real S&P 500 constituents table before being written down (`TSM`/`ARM` are real AI-silicon names but not S&P 500 members, deliberately left off). §7 gains a dedicated "Frontier LLM Watch"/"AI Hardware Watch" section naming every member individually with its own daily and 30-day move. §12's S38g entry records the build; §13 now notes this one piece is offline-tested only, not yet live-verified like S38a-f were. Minor bump — a new, additive feature on top of a stage already met, nothing prior reversed. |
| 1.6.0 | 2026-10-24 | **S38g live-verified on `dgx-spark`, minutes after 1.5.0 was written — direct operator request to deploy it the same way as S38a-f.** `tags.yaml` re-applied against the real `instruments` table: all 7 `ai_hardware` tickers and all 5 `frontier_llm` tickers (both `GOOG`/`GOOGL` share classes) matched. A real report run rendered both dedicated sections with real per-ticker numbers and delivered a real "AI watch: MU rose 2.46% today." Matrix line, confirmed via the room's own event stream, through the actual `hermes-market-report.service` unit (`Result=success`). `market sector frontier_llm`/`market sector ai_hardware`/`market ticker NVDA` posted into the real room and their replies read back from it — the existing gate handlers needed zero code changes to serve the two new tags, confirming the design's own "the gate re-reads whatever's in the DB" principle held for a feature added after the gate was built. §13 now reads "MET — S38a-g in full." Minor bump — a feature's live verification executed and its real record written in, nothing prior reversed. |
| 1.7.0 | 2026-10-25 | **S38h added: direct operator follow-up request for Market Watch to periodically check whether a ticker needs adding to frontier_llm/ai_hardware.** A sector/industry heuristic was measured first, not assumed, and ruled out: `Systems Software`/`Interactive Media & Services` matched 6/7 and 1/4 wrong real S&P 500 names. New §4 paragraph (and an explicit correction to that section's own earlier "no code change to add a tag" line): classification routes through `hermes-router.py`'s `dispatch` role instead, advisory-only, proposal-gated. New `tag_proposals` table (§5); four new `market tag approve/reject/override/pending` gate commands (§8); §12's S38h entry records the build, including a real bug this stage's own test suite caught before touching a real file (`append_tag_rule()`'s first version put the provenance comment inline, silently corrupting the parsed ticker pattern — fixed to its own comment line). §13 now notes S38h is offline-tested only (158 checks), not yet live-verified like S38a-g were. §14 re-evaluated now that `dispatch` carries a real (not hypothetical) call — still no new benchmark gap. Minor bump — a new, additive feature on top of a stage already met, nothing prior reversed. |
| 1.8.0 | 2026-10-25 | **S38h live-verified on `dgx-spark`, minutes after 1.7.0 was written — direct operator request to deploy it the same way as every prior sub-stage.** The real classification run is the headline result: every exact ticker §4's heuristic measurement found as a false positive (`FTNT`/`GEN`/`NOW`/`PANW`/`TWLO`/`RDDT`) was correctly cleared by `dispatch`, each with a sound, specific rationale — directly validating the decision to use an LLM instead of a sector heuristic. Zero genuine candidates were left pending (the curated lists already cover the real universe), so the approve/reject/override gate round trip was verified with two synthetic test proposals, fully cleaned up from `tags.yaml`/`tag_proposals`/`tags` afterward. One confirming finding: approving a nonsense ticker (`TESTCO`) correctly added zero rows to the real `tags` table, since `apply_tags()` found no matching real instrument — the mechanism degrades safely. The installed `hermes-market-sync.service` unit was reinstalled to `/etc/systemd/system/` with its new `hermes-router.service` dependency and run for real end to end (`Result=success`) through all four steps including `scan-tags`. §13 now reads "MET — S38a-h in full." Minor bump — a feature's live verification executed for real and its record written in, nothing prior reversed. |
| 1.9.0 | 2026-10-25 | **S38i added, direct operator request ("add a formatted report to the Fleetops-ui"), fulfilling §9's long-deferred "browsable report history" now that S38a-h's real data exists to browse.** §9 moved `[PROPOSED]` → `[DECIDED]`: new `/market` page on `hermes-fleetops-ui.py` (now 2.6.0) with a date-picked, filterable daily-report table (re-sorted into the fixed `REPORT_SECTION_ORDER` rather than the table's own alphabetical `item_type` order) read via `hermes_market_common.read_report_items()` — the same function the email/Matrix/gate paths already render from — plus a read-only "Pending tag candidate proposals" section over S38h's `tag_proposals` table, framed the same "deciding stays a Matrix reply" way `/recommendations` already frames its own findings. No new write route. §12 gained the S38i entry (19 new offline checks, 259 total on that page's suite); §13 notes S38i is offline-tested only and not part of S38a-h's own exit-gate bar, being a read-only view over data that bar already proved real; §14 re-evaluated — no model call at all, so no benchmark-gap question even arises, the simplest of the three S38 evaluations recorded there. Minor bump — a new, additive feature on top of a stage already met, nothing prior reversed. |
| 1.10.0 | 2026-10-25 | **S38j added, direct operator request** ("have a 'Graph' button [on /market] that breaks out a new window... evaluate if [the] appstack is retaining enough history, preferring up to one year... allow picking a time duration, which will autoscale the time-axis"), plus the S38i correction this same edit found while touching this file's own build-sequence entry. §11 risk 4 ("Unbounded storage growth") resolved: no pruning exists anywhere in this codebase, and a direct live check of Yahoo's chart endpoint showed 10 years of daily history available — decision is to retain every row forever (trivial size at this universe scale), and the operator raised the backfill goal from the risk's original ~1-year framing to 5 years once that ceiling was confirmed. §12's S38i entry corrected from its stale "not yet live-verified or committed" (it has been, since 1.9.0 was written) and gained a note about its same-day company-name/per-section follow-up enrichment; new S38j entry records the history-graph build — `ticker_price_history()` (`hermes_market_common.py` 1.3.0), the `backfill_days`→`backfill_range` rename and new-ticker auto-backfill (`hermes-market-sync.py` 1.3.0 — Yahoo's `Nd` range token turned out to count trading days, not calendar days), and the `/market/history` page itself (`hermes-fleetops-ui.py` 2.10.0), including a real bug its own test suite caught (the ticker query parameter breaking out of `section()`'s un-escaped heading argument — the first caller to put request-controlled data there). §13 corrected to reflect S38i's real completed state and extended to exclude S38j from the exit-gate bar on the same "read-only view, no new push/pull path" grounds as S38i. §14 re-evaluated for S38j: no model call at all, same conclusion as S38i's own evaluation, call recorded per `CLAUDE.md`'s rule. Minor bump — a new, additive feature plus a factual correction to this file's own prior content, nothing restructured or reversed. |
| 1.11.0 | 2026-10-25 | **S38j live-verified on `dgx-spark`, minutes after 1.10.0 was written — direct operator request to deploy it the same way as every prior sub-stage.** A real `prices --backfill-range 5y` run against the full 503-ticker universe actually raised NVDA's own history from its original ~1.6-year backfill to a full 5 years. Every duration bucket on the real `/market/history` page returned the correct real date window; a real short-history ticker (`VYLR`) and a real unknown ticker both degraded exactly as designed; all 52 real ticker-level rows on the live `/market` report carried a working Graph link, confirmed over both loopback and the real public tailnet URL. §12's S38j entry and §13 both updated from "built" to the real live result; committed and pushed (`23bda8e`). Minor bump — a feature's live verification executed for real and its record written in, nothing prior reversed. |
| 1.12.0 | 2026-10-25 | **S38k and S38l added, two direct operator follow-up requests landed back-to-back in the same session.** S38k: a "Company" button alongside Graph on every ticker-level `/market` row, an AI-generated company summary via a new `summarize_company()` (the exact `call_router()`/classify_batch() shape `hermes-market-sync.py` already establishes for an advisory `dispatch` call), deliberately uncached — matching `/models`' own existing "no cache kept here" policy rather than adding a new table/write path. S38l: a "Monitored stocks" watchlist section with an Add form, seeded with HPE — a new flat file and a genuine second write route (`/market/monitor/add`), both deliberate, documented relaxations of this file's own enforced invariants (`check_write_surface()`'s assertions updated to match, not silently loosened). A real deploy-time finding, not caught in review: the flat file was first placed inside the repo like `tags.yaml`, and the live Add form failed every time — `hermes-fleetops-ui.service`'s own `ProtectSystem=strict`/`ProtectHome=read-only` sandboxing makes the whole repo unwritable to that process; relocated to `~/.hermes/state` (the one directory its `ReadWritePaths` grants, already `HERMES_USAGE_DB`'s home), which is also the more correct call regardless of sandboxing since this is live per-host state, not git-tracked config. §11 unchanged; §12 gained both entries; §13's exclusion paragraph extended and corrected (S38l doesn't fit the "read-only, so excluded" framing S38i/j/k share — it has a real write path, it just isn't the kind of thing the exit-gate bar measures); §14 gained both evaluations (S38k: dispatch's existing Tier 0 coverage, no new gap; S38l: no model call at all). `hermes_market_common.py` now 1.4.0 (`load_monitored_tickers()`/`add_monitored_ticker()`); `hermes-fleetops-ui.py` now 2.12.0. 24 new checks on that page's own suite (334 total, up from 310) plus 8 on `hermes_market_common.py`'s file-format behavior via `hermes-market-sync.py`'s own suite (119 total, up from 111) — including a real bug this round's own suite caught (an unknown-ticker lookup inside `add_monitored_ticker_checked()` was case-sensitive against already-uppercase `instruments` rows; fixed to normalize at that function's own entry rather than trust every future caller to have already). Minor bump — two new, additive features on top of a stage already met, nothing prior reversed. |
| 1.13.0 | 2026-10-25 | **S38k and S38l live-verified on `dgx-spark`, minutes after 1.12.0 was written — direct operator request to deploy them the same way as every prior sub-stage.** The real deploy attempt immediately surfaced the `ProtectSystem=strict`/`ProtectHome=read-only` sandboxing finding already folded into 1.12.0's own text above (not a separate bump, since it was caught and fixed before this live-verification pass ever completed) — `MONITORED_TICKERS_PATH` relocated to `~/.hermes/state`, redeployed, and the real Add round trip then worked cleanly: HPE seeded for real through the live form itself (not a hand-written file), a lowercase re-add correctly reported "already monitored," an unmatched ticker and a wrong CSRF token each refused by name. A real `/market/company?ticker=HPE` call through the real `dispatch` role returned a sound profile in ~4 seconds. Both confirmed over loopback and the real public tailnet URL, with the real `/market` page showing `HPE (Hewlett Packard Enterprise)` and working Graph/Company links. §12's S38k/S38l entries and §13 both updated from "built" to the real live result. Minor bump — two features' live verification executed for real, including a real bug caught and fixed along the way, nothing prior reversed. |
