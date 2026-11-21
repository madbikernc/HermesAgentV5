# Firmament Finance Tracker — Target Design

**Version:** 1.2.0

**Status:** Planned, not executed. Direct operator request, 2026-11-19. `IMPLEMENTATION_PLAN.md`'s **S47**
is the stage that tracks building this and points back here for the full spec — the same split S23/S38/
S39/S40 use for their own design docs.

**Purpose:** daily download of the operator's own bank/brokerage transactions — via Intuit where a real
QuickBooks company file exists, directly via a licensed data aggregator (Plaid, §2a) for Wells Fargo,
Fidelity, Merrill Lynch, Truliant Federal Credit Union, Citibank, and Chase, and directly via Schwab's own
Trader API (§2b) for Schwab investment accounts — daily download of transaction detail from Privacy.com's
virtual-card API, correlation of the two where a Privacy.com card funds one of the tracked accounts,
categorization of every transaction across every account, and recurring reports: spending by category,
income vs. expenses, subscriptions/repeat charges, and (by design) further report types added later
without a rebuild.

**Status legend**, same convention as `firmament-fleet-target-architecture.md`:
- `[DECIDED]` — operator made an explicit choice
- `[PROPOSED]` — design recommendation, not yet ratified
- `[UNKNOWN]` — needs discovery/research before building
- `[RISK]` — flagged concern requiring validation or an operator decision

---

## 1. The ask, restated precisely

1. Download transactions for the operator's accounts — via Intuit where a real QuickBooks company file
   exists (§2), directly from six named institutions regardless: Wells Fargo (bank), Fidelity, Merrill
   Lynch, Truliant Federal Credit Union, Citibank (credit card), and Chase (credit card) (§2a); and
   directly from Schwab investment accounts via Schwab's own API, not an aggregator (§2b).
2. Download transaction detail from Privacy.com via its API.
3. Correlate charges on the matching bank account with the Privacy.com detail for the same charge.
4. Categorize expenses across all accounts.
5. Produce reports: spending, income vs. expenses, subscriptions and repeat charges, "and so on" —
   an open, extensible report list, the same "including but not limited to" framing `tags.yaml`/
   `topics.yaml` already give their own category lists.

---

## 2. Vendor/access research — Intuit `[UNKNOWN]`, gates everything below it

**Researched before being specified**, the same discipline `MARKET_WATCH_DESIGN.md` §2 applied to its own
vendor choice and S25 applied to its X/Twitter premise — checked against real, current sources rather than
assumed, because this stage's whole premise rests on what "Intuit" actually means for the operator's real
accounts.

**Mint is dead.** Intuit shut it down in March 2024 and steered users to Credit Karma (which Intuit also
owns). Credit Karma has no public developer API. If the operator's only relationship with Intuit was
Mint-era personal tracking, **there is no live Intuit path to "download my transactions" at all** — this
would not be a missing feature to build, it would be a vendor that no longer offers the capability.

**The only Intuit product with a real, current public developer API is QuickBooks** — QuickBooks Online
(QBO) and QuickBooks Self-Employed (QBSE) share the same Intuit Developer platform and OAuth2
authorization-code flow (app registered at `developer.intuit.com` for a Client ID/Secret; consent via
`appcenter.intuit.com/connect/oauth2`; access + refresh tokens from the token endpoint). QuickBooks is a
bookkeeping product, not a Mint-style personal-finance tracker — "my accounts" only exist to this API if
the operator (or someone on the operator's behalf) has actually connected those bank accounts inside a
QuickBooks Online or Self-Employed company file.

**`[UNKNOWN]`, blocking: which Intuit product, if any, the operator actually has.** Not guessable from
here — must be confirmed before S47a can proceed. If it is QuickBooks Online or Self-Employed with the
relevant accounts connected, this design proceeds as written below. If not, this whole stage needs a
different premise (a different aggregator entirely, e.g. Plaid direct) and that is a materially different,
unscoped build — named here rather than assumed away, the same way S25 named RSS-Bridge's OAuth
requirement rather than building past it.

**`[RISK]`, real but third-party-reported, not Intuit-confirmed: the bank-feed "For Review" tab is not
exposed by the public API.** Multiple independent developer sources agree that QuickBooks Online's own
Banking center — the raw, freshly-downloaded, not-yet-categorized bank-feed line items — has no API
endpoint at all; only transactions already **added or matched** into the books (posted as a `Purchase`,
`Deposit`, `Transfer`, `CreditCardPayment`, or `JournalEntry`, or read back flattened through the Reports
API) are queryable. No official Intuit document was found stating this outright, so it is carried as a
strong, consistent, but unverified claim — to be confirmed live against the operator's real company file
in S47a, the same "read the real API before specifying behavior against it" discipline S20a/`hermes-model-
scout.py` already applied to Hugging Face's.

**Practical consequence if the risk above holds**: this pipeline can only see transactions the operator (or
QuickBooks' own auto-matching) has already accepted into the books inside QuickBooks itself. That is a real
workflow dependency worth stating plainly rather than discovering by surprise later — this stage downloads
and reports on the operator's **books**, not a live, unmediated bank feed.

**`[DECIDED]`, conditional on the product question above: use the Reports API's `TransactionList`
report** (`GET /v3/company/<realmId>/reports/TransactionList`, date-range filtered) as the primary pull —
one call returns a flattened list across every connected account (date, transaction type, account,
payee/name, memo, amount) rather than iterating five separate entity endpoints. Fall back to the per-entity
endpoints (`Purchase`/`Deposit`/`Transfer`/`CreditCardPayment`/`JournalEntry`) only if a live test shows the
report's columns are too coarse for correlation or categorization once real data is in hand.

---

## 2a. Vendor/access research — direct bank/brokerage access (Wells Fargo, Fidelity, Merrill Lynch,
Truliant FCU, Citibank, Chase) `[PROPOSED]`

**Direct operator request, 2026-11-19: pull transactions straight from six named institutions** — Wells
Fargo (bank), Fidelity, Merrill Lynch, Truliant Federal Credit Union, Citibank (credit card), and Chase
(credit card) — rather than relying solely on whatever ends up inside a QuickBooks company file (§2).
Researched with the same live-verification bar §2/§3 hold to, not assumed.

**None of these six institutions offers a public developer API an individual can self-register for and
pull their own transactions from.** Wells Fargo, Citi, and Chase each run developer portals, but every one
found is scoped to merchant/treasury/commercial clients (payment processing, Citi's institutional developer
hub, Wells Fargo's treasury-management Account Transactions API with a 180-day window aimed at business
clients) — not a "read my own retail account" product. Fidelity, Merrill Lynch, and Truliant Federal Credit
Union publish no retail developer API at all. This rules out a direct-to-bank integration the same way §2
ruled out Mint.

**The regulatory path that would force banks to offer this for free does not exist yet.** The CFPB's
Section 1033 "open banking" rule would have required standardized, no-cost consumer data APIs, phased in
by bank size starting April 2026. A federal court enjoined the rule's compliance dates (reported November
2025) and the CFPB reopened it for a rewrite; there is no operative deadline as of this writing. Nothing
here assumes a bank-provided free API is coming on any particular schedule.

**The real path is a licensed data aggregator with its own bank data-access agreements — Plaid
`[PROPOSED]`.** This is the same category of intermediary §2's Intuit path already requires for
QuickBooks' own bank-feed ingestion, just operating directly on the operator's named accounts instead of
inside a bookkeeping product. Plaid is the chosen candidate: a real, current, documented REST API, and —
the fact that makes this tractable for a personal project — Plaid opened a genuinely free **Trial plan**
for developer teams created on or after 2026-04-15: real production account data, up to 10 linked accounts
("Items"), across an eight-product bundle (Transactions, Auth, Balance, Identity, Assets, Liabilities,
Investments, Statements), with no sales process. Six institutions fits well inside the 10-Item cap.
`[UNKNOWN]`, confirm before building: whether the Plaid developer team used for this build actually
qualifies for Trial — a team created before 2026-04-15 falls back to the older, smaller "Limited
Production" free tier (a 200-live-API-call-per-product cap instead of an Item cap, materially tighter).

**Per-institution coverage, checked against what evidence exists today — confirmed for two, not yet
confirmed for four:**

| Institution | Status | Evidence |
|---|---|---|
| Chase (credit card) | `[DECIDED]` | JPMorganChase and Plaid have a live, formally renewed (September 2025) data-access agreement; Plaid's own October 2026 changelog references Chase-specific OAuth consent-expiration handling, confirming the integration is live and current, not legacy/deprecated. |
| Wells Fargo (bank) | `[DECIDED]` | Plaid publishes its own dedicated institution page for Wells Fargo — one of its flagship, long-supported connections. |
| Citibank (credit card) | `[PROPOSED]`, unconfirmed | Citi is reputed to be one of the most commonly Plaid-supported card issuers, but no independent confirmation was found in this research pass. Check the Plaid Dashboard's institution search (or the `/institutions/search` endpoint) before relying on it. |
| Truliant Federal Credit Union | `[UNKNOWN]` | Two third-party aggregator-tracking sites list it as Plaid-supported; one of the same two also lists it under Mastercard Open Banking (formerly Finicity) as an alternate network. Neither is Plaid's own authoritative source. Confirm directly; Finicity/Mastercard Open Banking is the named fallback if Plaid itself does not cover it. |
| Fidelity | `[PROPOSED]`, unconfirmed | One third-party forum report describes a successful Plaid-based link to a Fidelity account. Fidelity holdings/transactions require Plaid's **Investments** product specifically, not standard Transactions — confirm both that Fidelity is supported and that Investments is actually included in whatever Plaid tier applies (research found conflicting evidence: one older Plaid support article excludes Investments from the Trial plan, a newer Plaid billing/pricing page includes it in the eight-product Trial bundle). |
| Merrill Lynch | `[UNKNOWN]` | No evidence found either way in this research pass. Merrill is Bank of America's brokerage arm; BofA itself is a large, closely-tracked institution, but this specific brokerage sub-brand's coverage was not independently confirmed. Confirm directly. |

**Mechanics, once an institution is confirmed covered.** Plaid Link — a hosted widget, not a backend-only
flow — runs once per institution: the operator completes that institution's real login inside Plaid's own
UI, producing a `public_token` the server exchanges for a durable `access_token` + `item_id` (one `Item`
per institution login, which can cover more than one account at that institution — a joint checking +
savings pair at Wells Fargo is one `Item`, two `accounts` rows). Ongoing pulls use `POST
/transactions/sync`, a cursor-based endpoint (start with an empty cursor to backfill all history, persist
the returned `next_cursor` between runs — the same "store the real pagination cursor, don't re-derive it"
discipline already used elsewhere in this fleet). Fidelity and Merrill Lynch, as brokerage accounts, pull
through Plaid's separate Investments endpoints instead (holdings + investment-transaction history) rather
than the plain Transactions product.

**`[DECIDED]`: no public webhook receiver.** Plaid's push mechanism (`SYNC_UPDATES_AVAILABLE`) exists to
tell a live web app new data is ready; this is a cron-driven personal tool, so the daily sync (§8) simply
calls `/transactions/sync` on schedule and reads whatever is new — no reason to stand up and expose a
public endpoint this tool doesn't otherwise need.

**`[RISK]`: Plaid Link's one-time consent step cannot be automated headlessly, unlike Intuit's OAuth
redirect.** Intuit's flow can be caught by a short-lived local HTTP listener without a human watching
(§12). Plaid Link is a hosted JS widget that must render in a real browser — there is no backend-only
substitute. The operator completes this once per institution at setup (up to six times), and again
whenever an `Item`'s consent lapses; Chase's own `consent_expiration_time` field (confirmed live in Plaid's
October 2026 changelog) shows this is a real, recurring event for at least one of these six institutions,
not a one-off.

**Relationship to §2's Intuit question.** This path materially de-risks §2's blocking unknown rather than
depending on it: the six institutions named here are pulled directly, regardless of whether the operator
turns out to have a usable QuickBooks company file at all. §2/`S47a`'s Intuit question is still worth
answering — QuickBooks may cover accounts not named here, or offer a reconciled "books" view these six raw
feeds don't — but it is no longer the single point of failure for the whole stage.

---

## 2b. Vendor/access research — Schwab investment accounts, direct API `[PROPOSED]`

**Direct operator request, 2026-11-20: read access to Schwab investment accounts, directly — not through
Plaid or any other aggregator.** Researched with the same live-verification bar §2/§2a/§3 hold to.

**Schwab is a real exception to §2a's own finding.** Unlike Wells Fargo, Citibank, Chase, Fidelity, and
Merrill Lynch, Schwab runs its own official, public, retail-individual-facing developer API — the
**Trader API** (`developer.schwab.com`), successor to the old TD Ameritrade API, which is fully
discontinued following Schwab's acquisition of TD Ameritrade (no grandfathered TDA credentials or tokens
carry over; a fresh Schwab developer registration is required regardless of any prior TDA developer
history). Its **Trader API - Individual** product is explicitly scoped for exactly this use — Schwab's
own product page describes it as "your own personal use application for your own self-directed Brokerage
account" — a materially better access path than needing an aggregator at all. `[DECIDED]`: use this
directly rather than routing Schwab through Plaid, even though some Plaid integrations also list Schwab
as a supported institution — a first-party API beats a third-party aggregator hop when one is genuinely
available for individual use, the same preference this design already gives Privacy.com's own clean API
over a screen-scraped alternative.

**Access process — two manual approval gates, not instant.** (1) Register an Individual Developer account
on the Schwab Developer Portal; this goes into pending manual review before approval. (2) Once approved,
request access to the Trader API - Individual product; this is also a separate pending review. (3) Once
granted, create an app with a callback URL; the app itself must reach a "Ready to Use" status in the
developer dashboard before any token can be issued. No published SLA was found for either review's
turnaround. `[UNKNOWN]`, confirm by actually starting registration rather than assuming same-day access —
the same "don't assume approval speed" caution this design already gives Privacy.com's plan-tier gate.

**`[UNKNOWN]`: whether Trader API - Individual access is free.** No Schwab pricing page naming API access
cost was found; the TD Ameritrade API it replaces was free for the account holder's own use, which is the
expected shape here too, but this must be confirmed during registration (step 1 above), not assumed — the
same discipline §3 already applies to Privacy.com's own plan-tier gate.

**Transactions endpoint, community-documented, not yet confirmed against Schwab's own official docs:**
`GET /trader/v1/accounts/{accountNumber}/transactions` (list) and `/transactions/{transactionId}` (single
record). To be verified directly against Schwab's own current API reference once a developer account
exists — the same "read the real API before specifying behavior against it" rule §2/S20a already applies.

**`[RISK]`, the most operationally significant finding in this section: Schwab's refresh token lives only
about 7 days, with no programmatic renewal.** The access token itself expires every 30 minutes and is
refreshed from the refresh token in the ordinary way — but once the refresh token itself expires (~7 days
after issue), the *entire* interactive OAuth consent flow must be redone by hand; there is no
refresh-the-refresh-token call. This is a far more aggressive cadence than Intuit's ~100-day inactivity
staleness (§12) or Plaid's occasional per-Item consent lapse (§2a) — in practice, it reads as the operator
needing to re-run `hermes-finance-auth-setup.py`'s Schwab mode roughly **weekly**, not "once at setup and
rarely again." `[UNKNOWN]`, worth confirming directly rather than assuming the worst case: whether using
the refresh token at least once within its 7-day window extends or rotates it (making the daily sync's own
routine use self-sustaining indefinitely) or whether it is a hard wall-clock expiry regardless of use —
community reports disagree on 6 vs. 7 days and none come from Schwab's own documentation, exactly the kind
of claim this design otherwise treats as unverified until checked live (§3's Stooq-style precedent).

**`[RISK]`: no sandbox found for Trader API - Individual.** At least one third-party source reports that
testing requires a live brokerage account, not a safe fixture environment — if still true, `S47g`'s live
verification step for Schwab is not merely a nice-to-have confirmation pass, it may be the *only* way to
test this integration at all, the same caution this design gives QuickBooks' own real-company-file
dependency in §2.

---

## 3. Vendor/access research — Privacy.com `[DECIDED]`, clean

Checked against Privacy.com's own current developer docs (`developers.privacy.com`), not a third-party
wrapper — the same live-verification bar §2 holds Intuit to.

**Real, documented, current API.** `GET /v1/transactions` (paginated, filterable), `Authorization: api-key
<KEY>` header, 401 on a missing/invalid key. This is the clean half of this stage, the same role Yahoo's
chart endpoint played against Intuit's own Stooq-shaped uncertainty in Market Watch's §2.

**`[RISK]`, confirm before building: API access needs a paid plan.** Privacy's help center states API
access is available on Privacy Plus ($5/mo) or higher (Pro $10/mo, Premium $20/mo) — **not** on the free
Personal plan. If the operator is on the free plan today, this half is blocked on an upgrade, not on any
code — stated here so it is a known prerequisite, not a surprise mid-build.

**One real finding worth flagging rather than silently trusting the fallback source:** a third-party GitHub
wrapper claims Privacy.com "discontinued its developer API." The *official* docs listed above contradict
this and are current, so that claim is treated as stale — but it is recorded here, the same way Market
Watch recorded and then ruled out Stooq, so a future reader sees the conflicting claim was checked and
rejected, not missed.

---

## 4. Scope for the MVP `[PROPOSED]`

One Intuit company file (QuickBooks Online or Self-Employed, whichever the operator actually has, per
§2), every account connected to it; one Privacy.com account, every virtual card on it; directly (§2a),
whichever of Wells Fargo, Fidelity, Merrill Lynch, Truliant Federal Credit Union, Citibank, and Chase
§2a's research confirms Plaid actually covers — each a new `accounts` row with `source='plaid'`; and
directly (§2b), the operator's Schwab investment account(s) once Trader API - Individual access is
approved — new `accounts` row(s) with `source='schwab'`. Multi-entity (a second QuickBooks company, a
second Privacy.com account, an additional institution added later) is a data change later (`accounts`
gains rows, §7), not a rebuild — same framing Market Watch's §3 gives international market expansion.

---

## 5. Correlation — bank-side charges to Privacy.com detail `[PROPOSED]`, one open measurement

**The real open question, not guessable from here: how a Privacy.com virtual-card charge actually posts
on its funding account** — inside QuickBooks (§2) or on a directly-linked bank account (§2a) — as its own
line item per purchase (expected, since Privacy cards are real network-issued virtual cards that settle
individually), or batched into a lump settlement. `[UNKNOWN]` until checked against the operator's own
real transaction list — the same "verify from raw output" standing rule `LESSONS_LEARNED.md` §6 rule 3
already states, applied here to a vendor's posting behavior instead of a tool's own output.

**Matching heuristic, independent of which shape above turns out to be true for the per-purchase case:**
join on `(funding_account, amount, date within ±N days)` between Privacy.com's `GET /v1/transactions` rows
and the ledger-side transaction list (Intuit- or Plaid-sourced, §2/§2a — the join logic treats either
source identically) — a tolerance window rather than an exact-date match, to absorb normal card-settlement
lag. Start at **±3 days**, widen only if real data shows it is too tight; this is the exact shape of
judgment call Market Watch's §5 made for percentage-vs-raw-delta, stated up front so it is a deliberate
choice, not a default nobody decided.

- **A matched pair**: keep the ledger-side row (Intuit- or Plaid-sourced) as the record of truth (never
  double-count the same charge twice across two source rows), enrich it with Privacy.com's own merchant
  name/category/card-label fields, tag it `source='privacy'`.
- **A ledger-side row with no Privacy.com match in the window**: ordinary bank activity, unchanged.
- **A Privacy.com transaction with no Intuit-side match in the window**: a named anomaly — settlement lag
  exceeded the window, a declined/reversed charge, or a sync gap — logged, never silently dropped, and
  surfaced on the next report as "unmatched Privacy.com transactions" (§9) rather than disappearing.

If the batched-settlement case turns out to be true instead, this join degrades gracefully to "one bank
row, many Privacy.com rows, same window" — still useful (every Privacy.com charge still gets reported), but
the per-row enrichment above would need to attach to the batch rather than a 1:1 bank row. Recorded as the
fallback shape rather than assumed; §2's "verify before specifying" discipline applies here too.

---

## 6. Categorization `[PROPOSED]`, same shape as `MARKET_WATCH_DESIGN.md` §4/S38h

**Rule-based first.** `infra/hermes-finance-sync/categories.yaml` — merchant-name/memo keyword → category,
operator-maintained, no code change to add or remove a rule, the same convention `tags.yaml`/`feeds.yaml`/
`topics.yaml` already establish. Seeded with an ordinary personal-finance taxonomy — Groceries, Dining,
Transportation, Utilities, Housing, Subscriptions & Software, Entertainment, Shopping, Health & Medical,
Insurance, Travel, Income, **Transfer**, Fees & Interest, Other — "including but not limited to," same as
every other editable category list here.

**`Transfer` is load-bearing, not a cosmetic bucket.** A transfer between the operator's own accounts (a
credit-card payment from checking, a savings sweep) is not income or an expense — it would double-count
real spending that was already categorized once on the card side. §9's income-vs-expense and spending
computations both exclude `category = 'Transfer'` explicitly, the same deliberate-exclusion discipline
Market Watch's §5 applies to raw price delta in favor of `adj_close`.

**LLM fallback for whatever the rules miss — same shape as S38h's tag-scout, not a new mechanism.** A
merchant string matching no rule goes through `hermes-router.py`'s `dispatch` role (bounded, sanitized
input, the same `sanitize_llm_input()` treatment S38h already built), batched, never one call per
transaction. Every verdict is recorded in a new `category_proposals` table (§7): a **high-confidence,
specific** verdict auto-applies directly (this labels the operator's own private records, not a shared
config file — lower stakes than S38h's public-watchlist write, so it does not need the same human gate for
every case); anything **low-confidence or "other"** queues for a Matrix reply instead of guessing, via
`finance category pending/approve/reject/override` (§10) — the same never-silently-guess rule S38h's
`tag_proposals` gate already enforces.

**Uniform across sources.** A Plaid-sourced transaction (§2a) and an Intuit-sourced one go through the
exact same rule-then-fallback pipeline — `category_rules`/`category_proposals` carry no source-specific
logic.

---

## 7. Storage `[PROPOSED]`

A new, dedicated SQLite store — `/mnt/hermes-data/finance/finance.db` — not folded into `hermes-memory`,
the same bulk-reference-data-vs-conversational-state distinction Market Watch's §5 draws for `market.db`.

```
accounts(account_id, source, display_name, kind, plaid_item_id, last_synced_date,
         UNIQUE(source, account_id))
         -- source: 'intuit' | 'plaid' | 'schwab' | 'privacy'
         -- kind: 'checking' | 'savings' | 'credit' | 'investment' | 'virtual_card' | ...
         -- plaid_item_id: set only when source='plaid' (FK into plaid_items); NULL otherwise

plaid_items(item_id, institution_name, vault_ref, cursor, created_at,
            UNIQUE(item_id))
            -- one row per Plaid Link completion (§2a), not per account -- one institution login (Item)
            -- can cover more than one account; cursor is /transactions/sync's persisted next_cursor

schwab_auth(refresh_token_vault_ref, refresh_token_issued_at, last_refreshed_at,
            UNIQUE(refresh_token_vault_ref))
            -- singleton-ish: one row per Schwab developer app/login (§2b); refresh_token_issued_at lets
            -- a daily check alert before the ~7-day cliff instead of discovering it from a failed sync

transactions(txn_id, account_id, date, amount_cents, payee_raw, memo, category, source,
             matched_txn_id, created_at,
             UNIQUE(source, txn_id))
             -- amount_cents signed: negative = expense/outflow, positive = income/inflow/refund
             -- matched_txn_id: the correlated row's txn_id once §5 joins it, else NULL

category_rules(pattern, category)         -- re-derived from categories.yaml each sync, not hand-edited per row
category_proposals(txn_id, candidate_category, rationale, confidence, state, proposed_at, decided_at,
                    UNIQUE(txn_id))
                    -- state: 'proposed' | 'approved' | 'rejected' | 'auto_applied' | 'cleared'

recurring_charges(payee_normalized, amount_cents, interval_days, first_seen, last_seen, occurrences,
                   UNIQUE(payee_normalized, amount_cents))

sync_state(source, account_id, last_synced_date)

report_items(report_date, report_type, category, rank, label, metric_value, text,
             UNIQUE(report_date, report_type, category, rank))
             -- one row per report line, the exact reshape Market Watch's report_items already proved
             -- (§9 below); a future /finance page and Matrix gate both read this, never recompute it twice
```

**`[RISK]` — this is the most sensitive data this fleet has handled.** Real account balances, real
merchant names, real spending patterns — a materially higher bar than Market Watch's public price data.
Per the operator's own standing "local only" rule: this store, and both Vaultwarden secrets in §12, must
never land inside the git tree. `/mnt/hermes-data/finance/` keeps it out by location, the same way
`market.db` already is — no new `.gitignore` entry is needed for data that never enters the repo's working
tree in the first place, but this must be verified true in practice (no debug dump, no test fixture with
real figures) before S47g's live verification is called done.

---

## 8. Sync cadence `[PROPOSED]`

One daily timer, `hermes-finance-sync.timer`, after both source's own data is likely settled for the prior
day (bank-feed and card settlement both lag real-time, so same-day pulls are unreliable — an end-of-day-
plus-buffer cadence, the same realism Market Watch's §6 applies to equity closes). Each run: pull new
Intuit transactions since the last watermark (`sync_state`), pull new Privacy.com transactions since the
last watermark, run §5's correlation pass, run §6's categorization pass, refresh `recurring_charges`.

---

## 9. Reports `[PROPOSED]`

Deterministic computation from `transactions`/`recurring_charges` — the categorization call in §6 is the
only model call anywhere in this pipeline, and it never produces a report number itself, the same "no
model call in the numbers path" discipline Market Watch's §7 holds to.

- **Weekly spending-by-category** — email, STE100-lite per `STYLE_GUIDE.md`, excluding `Transfer` (§6).
- **Monthly income vs. expenses** — total inflow vs. outflow excluding `Transfer`, by account and
  combined, email + Matrix.
- **Subscriptions / repeat charges** — `recurring_charges` rows with `occurrences >= 3` and a consistent
  interval (≈7/14/30/365 days within a small tolerance) and consistent amount, same report cadence as
  income-vs-expenses.
- **Unmatched Privacy.com transactions** (§5) — folded into the weekly report as its own section, not a
  silent drop.
- **Investment accounts (Fidelity, Merrill Lynch, §2a; Schwab, §2b) report on cash movements only** —
  deposits, withdrawals, dividends-as-income once categorized — the same transaction-level shape as every
  other account. Portfolio holdings/performance tracking is a different, unscoped capability (§13).
- **Further report types** are a `report_items` data/compute change, not a rebuild — the open "and so on"
  in the original ask is exactly what this schema's one-row-per-line shape (§7) is for, the same follow-on
  path Market Watch's §9 already proved for its own report types.

Delivery via `hermes_alert_common.py`'s existing `send_email()`/`matrix_notice()` — no new secrets
mechanism, the same reuse Market Watch's §7/§10 already established.

---

## 10. On-demand Matrix reports `[PROPOSED]`

Same dedicated-gate-script pattern as `hermes-market-gate.py`/`hermes-model-scout-gate.py` — a strict
command grammar, never free text routed through a model, every reply re-read from `finance.db` directly:

| Command | Behavior |
|---|---|
| `finance accounts` | List every linked account, its source, and its last-synced date. |
| `finance report` | Re-render and post the most recent weekly report. |
| `finance spending <category\|all> [week\|month]` | That category's (or total) spending for the period. |
| `finance income` | Income vs. expenses for the most recent month. |
| `finance subscriptions` | Current recurring/subscription charges. |
| `finance unmatched` | Privacy.com transactions with no Intuit-side match. |
| `finance category pending` | List `category_proposals` rows awaiting a human reply. |
| `finance category approve <txn_id>` | Apply a proposed category. |
| `finance category reject <txn_id>` | Reject a proposed category, permanently (until `override`). |
| `finance category override <txn_id>` | The only way back from `rejected`, same semantics as the two existing gates' own `override`. |

An unknown command, unknown category, or unknown `txn_id` is a named error, not silence — same discipline
both existing gates already apply.

---

## 11. Browsable report page — follow-on, not MVP `[PROPOSED]`

`hermes-fleetops-ui.py` already has the read-only report-page pattern (S21) and `/market` (S38i) proves it
again for a second domain. A `/finance` page — same `report_items` read, same `ro_sqlite()` helper against
`FINANCE_DB` — is a cheap follow-on once S47a-g have real data to browse, sequenced the same way Market
Watch sequenced S38i after S38a-h rather than designed against data that doesn't exist yet.

---

## 12. Secrets and screening `[PROPOSED]`

**Two new Vaultwarden items**, resolved through the existing `vault-get-secret.sh` convention — no new
secrets mechanism:

- `intuit-quickbooks-api` — Client ID, Client Secret, `realmId`, and the **current** refresh token.
  QuickBooks Online rotates the refresh token on every use and the old one is invalidated immediately —
  `hermes-finance-sync.py` must write the newly-rotated token back to this item on every single run, not
  just read it. A one-time interactive setup step (`hermes-finance-auth-setup.py`, run by hand once) opens
  the real Intuit authorization URL for the operator's own browser, runs a short-lived local HTTP listener
  to catch the OAuth redirect's `code`, exchanges it for the first access/refresh token pair, and seeds the
  Vaultwarden item — this one step cannot be automated headlessly, and every day after it is.
- `privacy-com-api` — the static API key (no OAuth, no rotation).
- `plaid-api` — the developer team's Client ID + Secret (production environment), used to mint
  short-lived `link_token`s and to exchange a Link `public_token` for a durable `access_token`. One
  Vaultwarden item, shared across every linked institution.
- `plaid-item-<institution-slug>` — one Vaultwarden item per institution actually linked via Plaid Link
  (§2a) — e.g. `plaid-item-wells-fargo`, `plaid-item-chase` — holding that `Item`'s `access_token` and
  `item_id`. Created as each institution is linked, not all six up front, since §2a's coverage isn't
  fully confirmed yet. Unlike Intuit's refresh token, a Plaid `access_token` does not rotate on every
  call, so there is nothing to write back here on an ordinary sync run — only re-run
  `hermes-finance-auth-setup.py --plaid-link <institution>` and overwrite this item if that `Item`'s
  consent lapses (§2a's `[RISK]`).
- `schwab-api` — Client ID, Client Secret, callback URL, and the **current** refresh token. Like
  QuickBooks, Schwab's OAuth flow is expected to rotate the refresh token on use (`[UNKNOWN]`, confirm,
  §2b) and `hermes-finance-sync.py` must write any newly-issued token back here on every run. Given §2b's
  ~7-day refresh-token cliff, `hermes-finance-auth-setup.py --schwab-link`'s one-time consent step is
  built to be re-run routinely, not once at setup like Intuit's and Plaid's own one-time flows.

**Egress guard does not apply here, same conclusion as Market Watch's §10.** All sync calls (Intuit,
Plaid, Schwab, Privacy.com) are direct script-level HTTP calls to a named vendor endpoint, not a
model-driven tool call — Layer 3 (S40) constrains
what a model's *output* asks to happen next, and nothing in this pipeline's sync path is model-generated.
The one real model call this design adds — §6's categorization fallback — is screened the same way every
other inbound call is: Layer 1 + Layer 2 (live since S22) ahead of `dispatch`, with the merchant-
name/memo text bounded and sanitized the same way S38h's tag-scout input already is before it reaches a
model.

---

## 13. Explicitly out of scope, risks, and open questions

1. **`[UNKNOWN]`, blocking (§2) — which Intuit product the operator actually has, if any.** Nothing past
   S47a can be built against real data until this is confirmed; Mint's shutdown and Credit Karma's lack of
   an API are the reason this is a real open question and not a formality.
2. **`[UNKNOWN]` (§2) — whether QuickBooks' bank-feed "For Review" items are truly API-invisible.**
   Third-party-reported, not Intuit-confirmed; must be checked against the operator's real company file.
3. **`[RISK]` (§3) — Privacy.com API access needs a paid plan** (Plus/$5 or higher); confirm before
   building against it.
4. **`[UNKNOWN]` (§5) — the real posting shape of a Privacy.com charge on its funding account**
   (per-purchase vs. batched settlement); the join logic's exact shape depends on this.
5. **`[RISK]` (§12) — OAuth refresh-token staleness.** QuickBooks' refresh token expires after an extended
   period of total inactivity (on the order of 100 days); a long fleet outage (the same class of incident
   S32's LUKS-mount finding describes) could silently invalidate this pipeline's only credential and require
   redoing the one-time consent step. The daily timer itself prevents this in normal operation; worth a
   monitored alert if a sync goes unexpectedly quiet for several days, the same "degrade loudly, not
   silently" convention Market Watch's §2 holds Yahoo's endpoint to.
6. **`[RISK]` (§6) — a wrong auto-applied category pollutes every downstream report silently.** Mitigated
   by auto-applying only rule-matched or high-confidence verdicts and queueing everything else for a human
   reply, the same resolution S38h already proved for `tags.yaml`.
7. **Real-time/streaming transaction alerts are out of scope.** Both vendors here are pull/poll sources; a
   push-notification product would be a materially different, separately-scoped capability, named rather
   than assumed as a later phase of this one — the same distinction Market Watch's §11 draws against
   intraday quotes.
8. **Tax-form/1099 reconciliation, budget-setting UI, multi-currency support, and investment-account
   portfolio holdings/performance tracking (§9) are out of scope** for this MVP — none were asked for;
   naming them here so a future reader doesn't assume they were considered and silently dropped.
9. **`[UNKNOWN]` (§2a) — four of the six directly-named institutions have unconfirmed Plaid coverage.**
   Citibank, Truliant Federal Credit Union, Fidelity, and Merrill Lynch must be checked in the Plaid
   Dashboard (or Finicity/Mastercard Open Banking as a named fallback for Truliant) before `S47a` is
   called done.
10. **`[UNKNOWN]` (§2a) — the build's Plaid developer team's tier.** Whether it qualifies for the free
    Trial plan (new teams from 2026-04-15) or falls back to the smaller, call-capped Limited Production
    tier; and whether Investments is actually included at whatever tier applies, for Fidelity/Merrill
    Lynch.
11. **`[RISK]` (§2a) — Plaid Link's one-time per-institution consent step needs a real browser session**
    and cannot be automated headlessly, unlike Intuit's redirect-catchable OAuth flow. It recurs whenever
    an `Item`'s consent lapses — confirmed real for Chase via its `consent_expiration_time` field.
12. **CFPB Section 1033's "open banking" rule** (§2a), which would have required banks to offer
    standardized free consumer-data APIs, is enjoined and under rewrite as of this writing — no
    assumption here relies on it arriving on any schedule.
13. **`[UNKNOWN]` (§2b) — Schwab Trader API - Individual's approval timeline and whether API access is
    free.** Must be confirmed by actually registering, not assumed.
14. **`[RISK]` (§2b) — Schwab's refresh token has a ~7-day lifetime with no programmatic renewal**
    (community-reported, not Schwab-confirmed). Whether the daily sync's own routine use keeps it alive
    indefinitely, or it is a hard wall-clock expiry regardless of use, must be confirmed directly. If the
    hard-expiry case holds, this is the single most demanding re-consent cadence of any source in this
    design and deserves its own monitored "about to expire" alert rather than discovery via a failed sync.
15. **`[RISK]` (§2b) — no sandbox found for Trader API - Individual.** `S47g`'s live verification may be
    the only way to test the Schwab integration at all.

---

## 14. Build sequence

- **S47a** — Vendor/access decision: confirm the real Intuit product (§2), the Privacy.com plan tier
  (§3), Plaid's actual coverage + tier for the six named institutions (§2a), and Schwab Trader API -
  Individual approval + pricing (§2b) — against the operator's real accounts and real developer
  registrations. Gates every other sub-stage, the same role S38a played for Market Watch.
- **S47b** — `tools/hermes_finance_common.py` (shared schema/connect/compute) + the `finance.db` schema
  (§7) + `tools/hermes-finance-sync.py`'s ingest half for every source S47a confirms: Intuit's
  `TransactionList` pull with OAuth refresh-rotation handling, Plaid's `/transactions/sync` cursor-based
  pull (plus Investments endpoints for any brokerage account) for whichever of Wells Fargo, Fidelity,
  Merrill Lynch, Truliant FCU, Citibank, and Chase (§2a) is confirmed supported, and Schwab's Trader API
  pull (§2b, once its two-stage developer/product approval lands) — plus one
  `hermes-finance-auth-setup.py` consent script covering all three one-time flows (Intuit's OAuth
  redirect catch, Plaid Link's hosted-widget linking, and Schwab's own OAuth consent — the last one built
  to be re-run routinely, not once, given §2b's ~7-day refresh-token cliff).
- **S47c** — `hermes-finance-sync.py`'s Privacy.com half (`GET /v1/transactions` pull), §5's correlation
  pass, `categories.yaml` + rule-based categorization (§6).
- **S47d** — LLM categorization fallback through `dispatch` (§6), `category_proposals` table.
- **S47e** — `tools/hermes-finance-report.py` — spending/income-vs-expense/subscriptions computation,
  email + Matrix push, STE100-lite per `STYLE_GUIDE.md`.
- **S47f** — `tools/hermes-finance-gate.py` — the Matrix command grammar (§10).
- **S47g** — Offline tests + live verification against the operator's real accounts (mirrors S38f).
- **S47h** — Optional follow-on: `/finance` page on `hermes-fleetops-ui.py` (§11), sequenced after S47a-g
  have real data to browse.

---

## 15. Benchmark evaluation (`CLAUDE.md` 1.3.0)

Evaluated against `FLEET_BENCHMARK_DESIGN.md` §4's gap structure, call recorded rather than skipped:
**no new benchmark scenario needed.** The sync, correlation, and report computation (S47b/c/e/f) make no
model call at all. The one real model call this design adds — S47d's categorization fallback — is the same
shape and the same role as Market Watch's S38h tag-scout: a one-off advisory classification judgment
through `dispatch`'s existing Tier 0 general-capability coverage (`FLEET_BENCHMARK_DESIGN.md` §2), never
the source of a fact that ships un-reviewed (a low-confidence verdict queues for a human reply, same as
`tag_proposals`). This is not coding capability on `coder`/`coder2`, so §6.7/§6.8's candidate-table rule
does not apply. No role has a new accuracy question to measure; this conclusion is to be re-checked if
S47d's real verdicts, once live, turn out to need a different role than `dispatch`.

---

## Build status

| Stage | Status | Date | Notes |
|---|---|---|---|
| S47a | not started | 2026-11-20 | Blocking: confirm real Intuit product, Privacy.com plan tier, Plaid coverage/tier for the six named institutions (§2a), and Schwab Trader API - Individual approval/pricing (§2b), against the operator's actual accounts |
| S47b | not started | 2026-11-20 | Gated on S47a; now covers Intuit's, Plaid's, and Schwab's ingest halves |
| S47c | not started | 2026-11-19 | Gated on S47a/b |
| S47d | not started | 2026-11-19 | Gated on S47c |
| S47e | not started | 2026-11-19 | Gated on S47c/d |
| S47f | not started | 2026-11-19 | Gated on S47e |
| S47g | not started | 2026-11-19 | Gated on S47a-f |
| S47h | not started | 2026-11-19 | Optional follow-on, gated on S47g |

---

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-19 | Initial design. Direct operator request: download Intuit transactions, download Privacy.com transaction detail, correlate the two, categorize expenses across all accounts, and produce spending/income-vs-expense/subscription reports. Vendor research done before writing the spec down, same discipline `MARKET_WATCH_DESIGN.md` §2 applied: Mint is confirmed shut down (2024) with no API successor; QuickBooks Online/Self-Employed is the only live Intuit path, gated on confirming which product the operator actually has and on the real-but-third-party-reported "For Review" bank-feed API limitation; Privacy.com's API is live and documented but needs a paid plan tier. `IMPLEMENTATION_PLAN.md`'s new **S47** points back here. |
| 1.1.0 | 2026-11-19 | **Direct operator request: added §2a, direct bank/brokerage access** for Wells Fargo, Fidelity, Merrill Lynch, Truliant Federal Credit Union, Citibank (credit card), and Chase (credit card) — since none of the six publishes a retail developer API, and the CFPB's Section 1033 open-banking rule that would have forced one is enjoined and under rewrite as of this writing. Plaid is the chosen aggregator: confirmed live/current for Chase (JPMorganChase's own renewed September 2025 data-access agreement, referenced in Plaid's October 2026 changelog) and listed for Wells Fargo on Plaid's own institutions page; Citibank, Truliant FCU, Fidelity, and Merrill Lynch coverage not independently confirmed in this research pass — flagged to verify in the Plaid Dashboard before `S47a` is called done. Plaid's new Trial plan (free, real production data, up to 10 Items, new developer teams from 2026-04-15) fits this scope if the fleet's own Plaid team qualifies; flagged as unconfirmed too, same as whether Investments is included in that tier for Fidelity/Merrill Lynch. §1, §4 (scope), §5 (correlation generalized from Intuit-side to ledger-side), §6 (uniform-across-sources note), §7 (`plaid_items` table, `accounts.plaid_item_id`), §9 (investment-account scope note), §10 (`finance accounts` command), §12 (`plaid-api` + per-institution Vaultwarden items), §13 (four new risk items), and §14/Build status (S47a/S47b scope) all updated to match. Minor bump — a new access path added alongside the existing Intuit path, nothing prior reversed. |
| 1.2.0 | 2026-11-20 | **Direct operator request: added §2b, direct Schwab investment-account access** — Schwab is the one institution researched so far that actually runs its own retail-individual developer API (Trader API - Individual, successor to the discontinued TD Ameritrade API), so it is read directly rather than through Plaid, even though some Plaid integrations also list Schwab. Two manual approval gates found (developer-account review, then product-access review), no published SLA for either; API pricing not confirmed, expected free like its TD Ameritrade predecessor but unverified. Biggest finding: Schwab's refresh token appears to live only ~7 days with no programmatic renewal (community-reported, not Schwab-confirmed) — far more demanding than Intuit's ~100-day staleness or Plaid's occasional per-Item lapse, and possibly the single most frequent re-consent requirement in this design; whether routine daily use extends it is itself unconfirmed. No sandbox found for this product either, so live verification (`S47g`) may be the only way to test it. §1, §4 (scope), §7 (`schwab_auth` table, `accounts.source`), §9 (investment-account scope note), §12 (`schwab-api` Vaultwarden item), §13 (three new risk items), and §14/Build status (S47a/S47b scope) updated to match. Minor bump — a new vendor section added alongside the existing paths, nothing prior reversed.
