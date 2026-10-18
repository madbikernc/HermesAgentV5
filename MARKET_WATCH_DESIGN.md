# Firmament Market Watch — Target Design

**Version:** 1.0.0

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

## 2. The first wall: "top exchanges globally" is a licensing question, not just an engineering one `[RISK]` `[UNKNOWN]`

Read against reality before specifying behavior around it — the same discipline S25 applied to its own
"keyless X reader" premise, which turned out to be false and got the stage deferred rather than built
against a wrong assumption.

Real-time, and often even delayed or end-of-day, data for most of the world's major exchanges (London
Stock Exchange, Euronext, Deutsche Börse, Tokyo Stock Exchange, Hong Kong Exchange, Shanghai/Shenzhen, and
others) is commercially licensed by the exchange or a designated distributor. It is not a free, keyless
pull the way an RSS feed is — this fleet cannot simply "connect to" a global exchange the way
`hermes-feed-reader.py` connects to a public feed URL. Free, broad, keyless coverage realistically exists
for:

- US-listed equities (NYSE, Nasdaq, OTC) — several free or low-cost sources exist.
- A patchwork of other markets, via aggregators that have already licensed redistribution — coverage
  depth and update latency vary by provider and by exchange, and terms change over time.

**Candidate vendors, named for research — none chosen, none vetted against current terms:**

| Vendor | Rough shape |
|---|---|
| Stooq | Free, bulk CSV download, broad end-of-day coverage across many world markets, no account required. Informal terms, uneven per-exchange depth. Best free bootstrap candidate. |
| Yahoo Finance (unofficial, e.g. via `yfinance`) | Free, wide symbol coverage, but unofficial — Yahoo has intermittently throttled or blocked scraping in the past; not a stable foundation to build a daily production pipeline on without a fallback. |
| Commercial aggregators (e.g. Twelve Data, EOD Historical Data, Finnhub, Polygon.io, or similar) | Paid tiers typically required for genuinely broad multi-exchange symbol directories, sector/industry metadata, and years of adjusted daily history without hand-rolled per-exchange scraping. Free tiers usually skew US-centric or rate-limited. |
| Exchange-direct listing files | Some exchanges publish their own free listed-company directory (symbol/name/sector); historical pricing is rarely included. |

**`[DECIDE — operator]` Before any code is written:** pick (a) a vendor/budget tier and (b) a bounded
starting universe. "Every stock on every top exchange" is a ceiling to grow toward, not a day-one build —
the same lesson S27 learned measuring 38 candidate topics down to a workable 8 before specifying any
digest behavior around them. §3 proposes a default scope precisely so the rest of this design isn't
blocked on an answer that has to come from the operator either way.

---

## 3. Scope for the MVP `[PROPOSED]`

Start with a named set of large-cap indices rather than "every exchange" — a few thousand tickers, not
tens of thousands, so sector-trend aggregation and movers/trend reporting are statistically meaningful
from day one and the vendor choice in §2 can be validated cheaply. Illustrative starting set, to be
confirmed against whatever the chosen vendor actually covers well: one US index (e.g. S&P 500), one
European index (e.g. FTSE 100 or STOXX Europe 600), one Asian index (e.g. Nikkei 225 or Hang Seng).
Widening the universe later is a config/data change (§5's `instruments` table gains rows), not a rebuild.

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

---

## 5. Storage `[PROPOSED]`

A new, dedicated SQLite store — `/mnt/hermes-data/market/market.db` — not folded into `hermes-memory`.
This is bulk time-series reference data, not conversational/task state, the same distinction
`model-benchmark`'s `history.jsonl` and the RAG store's `vectors.db` already draw against `hermes-memory`.

```
instruments(ticker, exchange, name, currency, sector, industry, first_seen, last_seen,
            UNIQUE(ticker, exchange))
tags(ticker, exchange, tag)                                  -- re-derived from tags.yaml each sync, not hand-edited per row
prices(ticker, exchange, date, open, high, low, close, volume,
       UNIQUE(ticker, exchange, date))
sync_state(exchange, last_synced_date)                        -- per-exchange watermark; a non-trading day is "nothing new," not an error
report_items(report_date, category, item_type, rank, ticker_or_group, metric_value, text,
             UNIQUE(report_date, category, item_type, rank))  -- one row per report line, the same reshape S27c proved for highlight tables; a future browsable report page (§9) and the Matrix gate (§8) both read this
```

**`[RISK]` Percentage change, not raw price delta, is the metric for every cross-company/cross-exchange
ranking** (movers, 30-day trend). Returns are currency-invariant; raw price deltas across different
reporting currencies are not comparable and would silently rank a weak JPY mover above a strong GBP one.
Stated explicitly so the price-delta version is never the one that ships by accident.

---

## 6. Sync cadence `[PROPOSED]`

"An appropriate interval, based on the posting tactics of the various exchanges" — read against what's
actually available: free/affordable global equity data is end-of-day, not intraday streaming. Real-time
or intraday quotes are a separately priced, materially larger product and a materially larger build —
named out of scope for this design (§11), not assumed as a later phase of it.

Given end-of-day is the realistic grain, "appropriate interval" means **one sync per covered exchange,
timed after that exchange's own close** — not one global timer, since exchanges close at very different
times worldwide (illustratively, Asian markets close hours before European ones, which close hours before
US markets). One `hermes-market-sync.timer`, or one script iterating covered exchanges and skipping any
not yet closed on this pass (re-checked next run) — the same per-source skip-and-retry discipline
`hermes-feed-reader.py` already uses — each with this fleet's usual timer jitter. A non-trading day
(weekend or holiday) is logged as "nothing new," the same honesty convention `hermes-news-digest.py`
already applies to "no news today."

---

## 7. Daily report `[PROPOSED]`

One push per day — a single report with several sections, unlike S27's six separate per-topic emails —
covering exactly what was asked:

- Sectors/industries/thematic tags with an overall up or down trend
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

Vendor API key: a new Vaultwarden item (e.g. `market-data-api`), fetched through `vault-get-secret.sh`,
env-var-first pattern identical to `hermes_alert_common.py`'s `EMAIL_PASSWORD`/`FLEETOPS_MATRIX_TOKEN`
fallback (1.1.0) — not a new secrets mechanism.

Any vendor-supplied free text (a company description field, an index-membership note) is third-party,
open-internet-adjacent content and gets the same treatment `hermes-model-scan.py`'s `_sanitize_hf_text()`
and S26's layer-1 tagging already give comparable text: bounded, stripped, and — if it ever reaches a
model at all — only via `hermes-router.py`, which screens every inbound call with Layer 1 and Layer 2
(live since S22, 2026-10-09). Per §7 above, this design's report pipeline makes **no model call**, so this
is a forward-looking guard, not a live exposure — recorded so it isn't forgotten if a narrative feature is
added later.

---

## 11. Explicitly out of scope, risks, and open questions

1. **`[UNKNOWN]` Vendor and budget.** The single highest-priority open item, gating everything else —
   see §2. Nothing past the first build sub-stage can be built against real data until this is decided.
2. **Intraday/real-time quotes are a separate, larger, costlier capability** — not assumed as a future
   phase of this design, just named as a different project if ever wanted.
3. **"List of traded stocks" as a literal daily bulk pull may not match how the chosen vendor's API is
   shaped.** Many aggregators sell a symbol *directory* (refreshed occasionally, not re-pulled whole every
   day) separately from daily *price* updates. The build must read the real vendor API before assuming
   both are the same call — the same "read the real API before specifying behavior" discipline
   `hermes-model-scout.py`/S20a already applied to Hugging Face's.
4. **Unbounded storage growth.** Thousands of tickers × daily OHLCV rows, indefinitely — the same class
   of "no retention policy stated yet" gap S27 flagged for its own highlight table. Worth a pruning or
   archive decision once real volume is observed, not guessed at before there is any.
5. **Corporate actions (splits, dividends, delistings, ticker changes) are not addressed by the schema in
   §5 as written.** A naive close-to-close % change across a stock split is wrong by the split ratio. The
   chosen vendor must be checked for split/dividend-adjusted closes; if it doesn't provide them, this
   needs its own fix before the 30-day trend numbers can be trusted.
6. **Thematic tag drift.** `tags.yaml` is operator-maintained prose/ticker matching, the same
   "editorial, not computed" category `topics.yaml` already is — it will need occasional upkeep as
   company classifications shift, same as `feeds.yaml`.
7. **Exchange trading-hours and holiday calendars per market.** §6's "appropriate interval" needs each
   covered exchange's real close time and holiday calendar — get this from the chosen vendor's own
   calendar data where available, rather than hand-maintaining one in this repo.

---

## 12. Build sequence

Tracked in `IMPLEMENTATION_PLAN.md` as sub-stages under **S38**:

- **S38a** — Vendor decision and bounded starting universe (operator decision plus a short research pass
  against the real, current API docs — not assumed).
- **S38b** — `tools/hermes-market-sync.py`, the `instruments`/`prices`/`sync_state` schema, per-exchange
  timers.
- **S38c** — `tags.yaml` and the sector/industry/thematic categorization pass.
- **S38d** — `tools/hermes-market-report.py` — daily sector-trend/movers/30-day-trend computation,
  `report_items` write, email + Matrix push.
- **S38e** — `tools/hermes-market-gate.py` — the FleetOps on-demand command grammar.
- **S38f** — Offline test suite, live verification, and the exit gate below.

---

## 13. Exit gate

A real daily email **and** Matrix post landing on a real trading day, citing real sector movement and
real movers an operator can check against an independent source; and a real `market <command>` round trip
through the actual gate script and actual Matrix replies, not a dry run — the same two-part bar (scheduled
push confirmed, on-demand pull confirmed) every comparable stage in `IMPLEMENTATION_PLAN.md` sets for
itself.

---

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-17 | Initial design — direct operator request for a daily global-exchange equity tracking capability: sector/industry and thematic categorization, historical price storage, a daily sector-trend/movers/30-day-trend report, and on-demand report requests from the Fleet Matrix room. Tracked as `IMPLEMENTATION_PLAN.md` S38. |
