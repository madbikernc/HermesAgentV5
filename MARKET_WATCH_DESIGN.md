# Firmament Market Watch — Target Design

**Version:** 1.6.0

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

Every reply is read back from `report_items`/`prices` directly — nothing here calls a model, so there is
no screening-ordering question for this half of the stage (contrast S20a/S25/S26, which ingest open-
internet free text and do carry one). An unknown command, unknown ticker, or unknown sector is a named
error, not silence — the same discipline the two existing gates already apply to an unrecognized `<id>`.

---

## 9. Browsable report history `[PROPOSED]`

`hermes-fleetops-ui.py` already has four read-only report pages (S21) plus S21e's per-highlight browser,
added only once S27c's schema reshape existed for it to read. `report_items`' one-row-per-line shape (§5)
is built the same way on purpose, so a fifth report page is a cheap follow-on once this stage has run long
enough to have something worth browsing — not specified here, to avoid designing a page against data that
doesn't exist yet.

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
4. **Unbounded storage growth.** ~500 tickers × daily OHLCV rows, indefinitely — smaller than the global-
   universe version of this risk, but the same class of "no retention policy stated yet" gap S27 flagged
   for its own highlight table. Worth a pruning or archive decision once real volume is observed.
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

---

## 13. Exit gate — **MET, 2026-10-24 — S38a-g in full**

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

---

## 14. Benchmark evaluation (`CLAUDE.md` 1.2.0)

Evaluated against `FLEET_BENCHMARK_DESIGN.md` §4's gap structure, call recorded rather than skipped:
**no new benchmark scenario needed.** Every piece of this design that actually ships in the MVP — the
sync, the report computation, the Matrix gate — makes no model call at all (§7, §8), so there is no role
with a new accuracy question to measure. The one path that would touch a role is the optional, explicitly
deferred narrative "why" line (§7), routed through `dispatch` like S20b's advisory call — `dispatch`
already has coverage (`FLEET_BENCHMARK_DESIGN.md` §2's role-fitness bake-off, Tier 0 general capability),
so even building that later opens no new gap.

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
