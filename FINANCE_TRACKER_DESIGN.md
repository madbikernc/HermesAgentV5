# Firmament Finance Tracker — Target Design

**Version:** 1.7.0

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

**Not to be confused with a separate, since-confirmed finding: Quicken Simplifi (§2c) is not an Intuit
product at all.** If the operator's real CSV-export habit turns out to be Simplifi rather than a QuickBooks
company file, it doesn't answer this section's blocking question either way — see §2c.

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

## 2c. Vendor/access research — Quicken Simplifi `[RISK]`, confirmed no API

**Discovered mid-build, not from the original ask: the operator's real transaction export is from Quicken
Simplifi, not Intuit.** S47c's `infra/hermes-finance-sync/categories.yaml` taxonomy was built directly from
a real file the operator pointed at, `"Simplifi - Transactions.csv"` — Simplifi by Quicken's own CSV
export. This matters because **Simplifi is not an Intuit product and has nothing to do with §2's Mint/
QuickBooks research**: Intuit sold the Quicken brand and software to H.I.G. Capital in 2016, and Quicken
Inc. has operated independently since; "Simplifi by Quicken" is a Quicken-brand app built years after that
split. §2's own "which Intuit product, if any" framing never considered it, because it isn't one.

**Checked against the same live-verification bar §2/§3 hold to: Simplifi has no public developer API.**
Simplifi's own community forum has repeated, still-open user requests for one — one recent post asks for
exactly this capability so users can stop manually exporting CSV files, another suggests starting with
read-only access — both confirming the gap is real and currently unaddressed, not merely undocumented. A
third-party provider directory (APIs.io) lists a "Simplifi by Quicken API," but its own description is the
consumer-facing bank-linking flow (Simplifi authorizing *into* a bank via OAuth), not a developer-facing
endpoint for reading a user's own Simplifi data back out — the opposite direction from what this stage
needs. No Quicken developer portal, MCP server, or transaction-read endpoint was found anywhere.

**Practical consequence: Simplifi has no automatable path today — CSV export is the only one.** That is a
materially different shape than every other source in this design (§2/§2a/§2b are all OAuth-pull sources
built around `hermes-finance-sync.py`'s daily timer, §12); a Simplifi source would instead mean watching
for a manually-dropped export file, not a pull. **This does not resolve §2's own blocking `[UNKNOWN]`** —
whether the operator separately has a real QuickBooks company file is still unconfirmed and still gates
S47a exactly as written. What's new here is narrower but still useful: if Simplifi turns out to be the tool
the operator actually uses day to day, the daily-ingestion problem for *that* tool specifically has a
confirmed, final answer — no API exists to build against — rather than an open question like Intuit's.

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

## 6a. Budget-bucket classification `[DECIDED]`, built

**Direct operator request, 2026-11-23: classify every transaction into Fidelity's own "Budget
Worksheet" taxonomy** (`P:\Private\Budgeting\Budget Worksheet.pdf`) — a second, coarser layer on top
of §6's granular categorizer, not a replacement for it. The worksheet's own two-tier vocabulary:
Housing, Groceries, Healthcare, Transportation, Debt & Monthly Obligations, Child & Dependent Care
(essential); Personal Care, Gifts, Recreational, Entertainment (discretionary) — each with its own
named fields (e.g. Housing → Mortgage/Rent/Electricity/.../Other). `Income` is this build's own small
addition: the worksheet itself has no itemized income section (one top-line take-home-pay figure),
so paycheck/interest transactions would otherwise sit in the review queue forever.

**A second static mapping file, not a rewrite of the first.** `infra/hermes-finance-sync/
budget_buckets.yaml` maps each granular `category` (§6's own output) to a worksheet `(bucket,
field)` pair — same flat `category | bucket | field` convention, read by
`hermes_finance_common.py`'s `load_budget_buckets()`. A granular category absent from this file is
deliberately left unmapped (`Cash & ATM`, bare `Shopping`, bare `Financial`/Venmo, `Education`,
`Utilities:Gas & Electric` — the last because it conflates electric + gas in one category while the
worksheet splits them, and there's no reliable way to pick one from the category alone) — flagged for
review, never guessed into a bucket the worksheet doesn't honestly offer. `Transfer` is excluded
outright in code, the same reporting exclusion above already gives it — never shown as needing
review.

**Reviewed corrections are treated like a RAG result — direct operator request.** Every
`budget_classifications` row the operator has confirmed (`reviewed=1`) is a ground-truth example for
a specific real payee; `find_reviewed_match()` checks every new transaction's payee against that set
first — exact match on the normalized payee, else the longest substring match either direction — and
a hit wins outright over the static rule chain. Plain substring matching, not embeddings, consistent
with every other matcher in this codebase; worth revisiting only if plain matching proves too coarse
in practice. `classify_budget()`'s full priority order: (1) reviewed-match, (2) the static rule chain
(§6's categorizer → `budget_buckets.yaml`), (3) unclassified. No LLM fallback in this layer — distinct
from, and unrelated to, §6's own LLM fallback for the granular category.

**Ingestion: CSV only, pulling forward a slice of S47b/§7, ungated from S47a.** Exactly the way this
section's own rule-based matching turned out not to need S47a's blocked vendor access, neither does
this: `tools/hermes-budget-import.py` reads a Simplifi-shaped export directly (the real file already
used to build `categories.yaml`), upserts `accounts`/`transactions` (§7's schema, built now rather
than waiting on S47b's live API ingest) and runs the classification pipeline per newly-seen
transaction. Idempotent by construction — re-running the same export never duplicates a row or
re-classifies (and so never clobbers an operator review) for a transaction already on file. Live API
ingestion (Intuit/Plaid/Schwab) stays exactly where §2/§2a/§2b already have it — out of scope here.

**`hermes-fleetops-ui.py`'s new `/budget` tab, pulling forward a slice of S47h.** Filter (bucket,
payee substring, account) and sort (payee/amount, ascending or descending) via GET query params, the
same server-side pattern the rest of that page already uses. One form per transaction row — bucket
and field as free-text inputs with a `<datalist>` of the worksheet's own vocabulary (so a bucket/field
the worksheet never named, like the operator's own `Dad:*` categories, needs no code change) plus a
reviewed checkbox — posted to the page's fourth write route, `/budget/classify`. Fixing a row's
bucket/field always stamps it reviewed regardless of the checkbox: a fix is a review decision, not
optionally one.

**Dependent bucket/field dropdowns, direct operator request.** The bucket input suggests every
known bucket; the field input suggests only that row's OWN bucket's fields, not every field from
every bucket, and re-scopes live (a small `change`-driven script, no page reload) whenever the
bucket input changes. "Known" is read live from `budget_classifications` itself — `WORKSHEET_TAXONOMY`'s
static set union whatever bucket/field values have actually been saved — so a brand-new value
typed and saved once becomes a suggested value from then on, with nothing written back to the
static taxonomy and no code change needed.

**Two modes, direct operator request: Planning and Report.** The page above — filter/sort/fix a
category — is **Planning** mode, unchanged. **Report** mode (`?mode=report`, a small tab switch, not
a new route) emulates the real `Budget Worksheet.pdf` layout for one selected month at a time (a month
picker, defaulting to the most recent month on file): every worksheet field prints even at `$0.00`
(same as the blank fillable PDF), each bucket gets a subtotal, and `Essential`/`Discretionary` get
their own totals per the worksheet's own two-tier grouping — `Income` prints separately, as the real
worksheet's own top-of-page figure, never folded into either total. A transaction manually filed under
a field the worksheet never named still counts toward its bucket's subtotal (an `(unlisted field)`
catch-all row) — a fixed-field report that silently dropped real spending outside the worksheet's own
named fields would be strictly worse than Planning's flat list, not an improvement on it.
Unclassified and excluded (`Transfer`) amounts for the selected month are named and summed in a note
rather than silently missing from the totals — the same discipline every other total in this design
holds to (§6/§9).

---

## 7. Storage `[PROPOSED]`

A new, dedicated SQLite store — `/mnt/hermes-data/finance/finance.db` — not folded into `hermes-memory`,
the same bulk-reference-data-vs-conversational-state distinction Market Watch's §5 draws for `market.db`.
**`accounts`, `transactions`, and the new `budget_classifications` below are built** (§6a,
`hermes_finance_common.py` 1.1.0's `SCHEMA`/`connect()`) — the rest of this block is still
`[PROPOSED]`, pending S47a/b.

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

budget_classifications(source, txn_id, bucket, field, classified_by, reviewed, classified_at, reviewed_at,
                        PRIMARY KEY (source, txn_id), FOREIGN KEY (source, txn_id) REFERENCES transactions)
                        -- §6a, built. bucket/field: NULL = unclassified, flagged for review.
                        -- classified_by: 'rule' | 'reviewed_match' | 'excluded' | 'manual'
                        -- reviewed=1 for 'reviewed_match'/'excluded' (confidence already established)
                        -- and for 'manual'; 'rule' starts at reviewed=0 until the operator confirms it.
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
16. **`[RISK]` (§2c) — Quicken Simplifi, confirmed to have no public API; CSV export only.** Discovered
    from the operator's real transaction export used to build S47c's `categories.yaml`. Doesn't resolve
    item 1's Intuit `[UNKNOWN]`, but if Simplifi — not QuickBooks — turns out to be the operator's actual
    daily-use tool, this source needs a watched-folder/manual-export ingestion shape instead of §2's
    OAuth-pull design, before `S47b` can build against it.
17. **A real bug found in `categories.yaml` while building §6a, not fixed here — the operator's own
    direct edit, not this design's call to make.** The operator added `Dad:Brookdale | keyword |
    brookdale` after this file's own `Home:Rent | keyword | brookdale senior` (first-match-wins, file
    order), so every real "Brookdale Senior..." transaction still resolves to `Home:Rent` —
    `Dad:Brookdale` can never fire for the one payee it was evidently added for. `Dad:Pharmacy`/
    `Dad:Personal Income` (added the same edit) both work correctly. Flagged for the operator to resolve
    (reorder, or remove the older rule) rather than silently reordered on their behalf.

---

## 14. Build sequence

- **S47a** — Vendor/access decision: confirm the real Intuit product, if any (§2) — now including whether
  the operator has a QuickBooks company file at all, given §2c's confirmed finding that Quicken Simplifi,
  the tool behind the operator's real transaction export, has no API of its own — the Privacy.com plan
  tier (§3), Plaid's actual coverage + tier for the six named institutions (§2a), and Schwab Trader API -
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
  to be re-run routinely, not once, given §2b's ~7-day refresh-token cliff). **A CSV-only slice of the
  schema/ingest half — `accounts`/`transactions`, `tools/hermes-budget-import.py` — is already built
  (§6a), ungated from S47a; the live API pulls above are still fully gated.**
- **S47c** — `hermes-finance-sync.py`'s Privacy.com half (`GET /v1/transactions` pull), §5's correlation
  pass, `categories.yaml` + rule-based categorization (§6). **The categorization half, plus the new
  worksheet budget-bucket layer on top of it (§6a, `budget_buckets.yaml`), is built; the Privacy.com
  pull and correlation pass are not.**
- **S47d** — LLM categorization fallback through `dispatch` (§6), `category_proposals` table.
- **S47e** — `tools/hermes-finance-report.py` — spending/income-vs-expense/subscriptions computation,
  email + Matrix push, STE100-lite per `STYLE_GUIDE.md`.
- **S47f** — `tools/hermes-finance-gate.py` — the Matrix command grammar (§10).
- **S47g** — Offline tests + live verification against the operator's real accounts (mirrors S38f).
- **S47h** — Optional follow-on: `/finance` page on `hermes-fleetops-ui.py` (§11), sequenced after S47a-g
  have real data to browse. **A slice of this — the `/budget` tab specifically (§6a) — is already built
  and ungated, the same reasoning as S47b/c above; the broader `/finance` page (spending/income reports,
  §9) still waits on S47a-g.**

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
| S47a | not started | 2026-11-22 | Blocking: confirm real Intuit product, Privacy.com plan tier, Plaid coverage/tier for the six named institutions (§2a), and Schwab Trader API - Individual approval/pricing (§2b), against the operator's actual accounts. New (§2c): Quicken Simplifi — the tool behind the operator's real transaction export — confirmed to have no public API; doesn't resolve whether a separate QuickBooks company file exists, but narrows what "confirm the real Intuit product" needs to check. |
| S47b | in progress | 2026-11-23 | Gated on S47a for the live API ingest halves; the CSV-only slice (`accounts`/`transactions` schema, `tools/hermes-budget-import.py`) is built and ungated (§6a) |
| S47c | in progress | 2026-11-23 | The granular categorization half is done and committed (`tools/hermes_finance_common.py`, `categories.yaml`) — not gated on S47a/b, since rule-based matching over a merchant string needs no real vendor/account access. The new worksheet budget-bucket layer on top of it (§6a: `budget_buckets.yaml`, reviewed-match reuse, `/budget` tab) is also done and committed, same reasoning. `hermes-finance-sync.py`'s own Privacy.com pull and §5's correlation pass are still not started and still gated on S47a/b. |
| S47d | not started | 2026-11-19 | Gated on S47c's still-pending Privacy.com/correlation half |
| S47e | not started | 2026-11-19 | Gated on S47c/d |
| S47f | not started | 2026-11-19 | Gated on S47e |
| S47g | not started | 2026-11-19 | Gated on S47a-f |
| S47h | in progress | 2026-11-23 | Optional follow-on, gated on S47g for the full `/finance` report page; the `/budget` tab slice (§6a) is built and ungated, same reasoning as S47b/c |

---

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-19 | Initial design. Direct operator request: download Intuit transactions, download Privacy.com transaction detail, correlate the two, categorize expenses across all accounts, and produce spending/income-vs-expense/subscription reports. Vendor research done before writing the spec down, same discipline `MARKET_WATCH_DESIGN.md` §2 applied: Mint is confirmed shut down (2024) with no API successor; QuickBooks Online/Self-Employed is the only live Intuit path, gated on confirming which product the operator actually has and on the real-but-third-party-reported "For Review" bank-feed API limitation; Privacy.com's API is live and documented but needs a paid plan tier. `IMPLEMENTATION_PLAN.md`'s new **S47** points back here. |
| 1.1.0 | 2026-11-19 | **Direct operator request: added §2a, direct bank/brokerage access** for Wells Fargo, Fidelity, Merrill Lynch, Truliant Federal Credit Union, Citibank (credit card), and Chase (credit card) — since none of the six publishes a retail developer API, and the CFPB's Section 1033 open-banking rule that would have forced one is enjoined and under rewrite as of this writing. Plaid is the chosen aggregator: confirmed live/current for Chase (JPMorganChase's own renewed September 2025 data-access agreement, referenced in Plaid's October 2026 changelog) and listed for Wells Fargo on Plaid's own institutions page; Citibank, Truliant FCU, Fidelity, and Merrill Lynch coverage not independently confirmed in this research pass — flagged to verify in the Plaid Dashboard before `S47a` is called done. Plaid's new Trial plan (free, real production data, up to 10 Items, new developer teams from 2026-04-15) fits this scope if the fleet's own Plaid team qualifies; flagged as unconfirmed too, same as whether Investments is included in that tier for Fidelity/Merrill Lynch. §1, §4 (scope), §5 (correlation generalized from Intuit-side to ledger-side), §6 (uniform-across-sources note), §7 (`plaid_items` table, `accounts.plaid_item_id`), §9 (investment-account scope note), §10 (`finance accounts` command), §12 (`plaid-api` + per-institution Vaultwarden items), §13 (four new risk items), and §14/Build status (S47a/S47b scope) all updated to match. Minor bump — a new access path added alongside the existing Intuit path, nothing prior reversed. |
| 1.2.0 | 2026-11-20 | **Direct operator request: added §2b, direct Schwab investment-account access** — Schwab is the one institution researched so far that actually runs its own retail-individual developer API (Trader API - Individual, successor to the discontinued TD Ameritrade API), so it is read directly rather than through Plaid, even though some Plaid integrations also list Schwab. Two manual approval gates found (developer-account review, then product-access review), no published SLA for either; API pricing not confirmed, expected free like its TD Ameritrade predecessor but unverified. Biggest finding: Schwab's refresh token appears to live only ~7 days with no programmatic renewal (community-reported, not Schwab-confirmed) — far more demanding than Intuit's ~100-day staleness or Plaid's occasional per-Item lapse, and possibly the single most frequent re-consent requirement in this design; whether routine daily use extends it is itself unconfirmed. No sandbox found for this product either, so live verification (`S47g`) may be the only way to test it. §1, §4 (scope), §7 (`schwab_auth` table, `accounts.source`), §9 (investment-account scope note), §12 (`schwab-api` Vaultwarden item), §13 (three new risk items), and §14/Build status (S47a/S47b scope) updated to match. Minor bump — a new vendor section added alongside the existing paths, nothing prior reversed. |
| 1.3.0 | 2026-11-22 | **S47c's categorization half built and committed** (`tools/hermes_finance_common.py`'s `load_categories()`/`categorize_transaction()`, `infra/hermes-finance-sync/categories.yaml` seed) — found, while picking a small task to trial-run through `hermes-dualcoder.py`, that §6's rule-based matching needs no real vendor/account access and so isn't actually gated on S47a/b the way the Build status table previously implied for all of S47c; only the Privacy.com sync/correlation half of that stage still is. Build status row split accordingly. Minor bump — a build-progress update, nothing in the design itself changed. |
| 1.4.0 | 2026-11-22 | **Added §2c, Quicken Simplifi vendor research** — discovered while building S47c's `categories.yaml` from the operator's real transaction export that the file is a Quicken Simplifi CSV export, not an Intuit product; Simplifi was sold out of Intuit in 2016 and §2's Mint/QuickBooks research never covered it. Checked with the same live-verification bar §2/§3 hold to: Simplifi has no public developer API (confirmed by Simplifi's own community forum's repeated, still-open requests for one, and no developer portal, MCP server, or transaction-read endpoint found anywhere) — CSV export is the only avenue. Does not resolve §2's own blocking `[UNKNOWN]` (whether the operator separately has a real QuickBooks company file); narrows it instead. §2 (cross-reference), §13 (new item 16), §14/Build status (S47a wording) updated to match. Minor bump — a new vendor section added alongside the existing paths, nothing prior reversed. |
| 1.5.0 | 2026-11-23 | **Added §6a, built: Fidelity Budget Worksheet classification** — direct operator request, evaluated against the real `Budget Worksheet.pdf` (`P:\Private\Budgeting\`). New files: `infra/hermes-finance-sync/budget_buckets.yaml` (granular category → worksheet bucket/field, operator-reviewed mapping table), `tools/hermes-budget-import.py` (CSV ingest + classify, pulls forward a CSV-only slice of S47b's `accounts`/`transactions` schema and S47h's fleetops-ui page, both ungated from S47a per §6a's own reasoning). `hermes_finance_common.py` 1.1.0 adds `FINANCE_DB`/`SCHEMA`/`connect()`, `WORKSHEET_TAXONOMY`, `load_budget_buckets()`, `classify_budget()`'s reviewed-match-then-rule-then-unclassified priority order (the operator's own reviewed corrections treated as a RAG result, direct operator request), and `set_budget_classification()`. `hermes-fleetops-ui.py` 2.23.0 adds the `/budget` tab and its `/budget/classify` write route (the file's fourth, and first shaped as one form per row). Verified against the real Simplifi export (read live, never committed): 1,871 real transactions imported, 651 rule-classified, 1,220 correctly flagged for review (dominated by Privacy.com-masked merchants and general retail, both already known, separately-scoped gaps) — then re-verified that a single operator correction propagates forward via the reviewed-match lookup, confirming the RAG-reuse requirement actually works end to end, not just unit-tested in isolation. Also found, while cross-checking the real data against this build: a real `categories.yaml` bug (§13 item 17) in the operator's own direct edit (a newer `Dad:Brookdale` rule permanently shadowed by an older, more specific `Home:Rent` rule) — flagged, not fixed, since it's the operator's own data file. §7 (`budget_classifications` table, build-status annotations on `accounts`/`transactions`), §13 (new item 17), §14/Build status (S47b/c/h scope) updated to match. Minor bump — a new section and new tables/files added, nothing prior reversed. |
| 1.6.0 | 2026-11-23 | **§6a extended, built: `/budget` gains Planning/Report modes, direct operator request.** Planning is the existing filter/sort/fix-a-category view, unchanged. Report (`hermes-fleetops-ui.py` 2.24.0, `?mode=report`) emulates the real `Budget Worksheet.pdf` layout for one selected month — every worksheet field prints even at $0.00, each bucket subtotals, Essential/Discretionary total separately per the worksheet's own two-tier grouping, Income prints as its own top-of-page figure, and a transaction manually filed under a field the worksheet never named still counts toward its bucket's subtotal (an "(unlisted field)" catch-all) rather than being silently dropped. Verified live against the real Simplifi data (November 2026): computed totals cross-checked against an independent direct SQL query, matched exactly. §6a updated to match. Minor bump — a new mode added to an already-built tab, nothing prior reversed. |
| 1.6.1 | 2026-11-23 | **Bug fix, found live: `/budget` crashed with a raw `sqlite3.OperationalError` before the first import had ever run** (`connect(readonly=True)` can't create a missing `finance.db` the way a plain write-connect could). Both modes now check the file exists first and show the same plain "not imported yet" note Report already had for an empty-but-existing database. `hermes-fleetops-ui.py` now 2.24.1. Patch bump — a bug fix, no new behavior. |
| 1.7.0 | 2026-11-23 | **§6a extended again, built: Planning's bucket/field inputs become real dependent dropdowns, direct operator request.** The field column now only ever suggests its OWN bucket's values, not every field from every bucket, and re-scopes live (client-side, no reload) when the bucket input changes. Known buckets/fields are read live from `budget_classifications` itself (`WORKSHEET_TAXONOMY`'s static set union whatever has actually been saved) — a brand-new bucket or field typed and saved once becomes a suggested value from then on, no code change needed. `hermes-fleetops-ui.py` now 2.25.0. Minor bump — new behavior on an already-built tab, nothing prior reversed. |
