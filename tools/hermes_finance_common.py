#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-11-23) — direct operator request: turn Fidelity's "Budget Worksheet.pdf" into a
# working classification layer on top of S47c's existing granular categorizer, per
# FINANCE_TRACKER_DESIGN.md §6/§7's extended spec. New: `FINANCE_DB`/`SCHEMA`/`connect()` (pulls
# forward a CSV-only slice of S47b's `accounts`/`transactions` tables, plus the new
# `budget_classifications` table, none of it gated on S47a's still-blocked vendor access, the same
# reasoning that already ungated this file's own categorization half). `WORKSHEET_TAXONOMY`, the
# worksheet's own bucket/field vocabulary (plus an `Income` bucket the worksheet itself doesn't
# itemize, added of necessity). `load_budget_buckets()` mirrors `load_categories()` exactly, reading
# the new `budget_buckets.yaml` (`category | bucket | field`), with `bucket` validated against
# `WORKSHEET_TAXONOMY` the same way `load_categories()` validates `match_type` -- `field` is left
# unvalidated so a reasonable new field label needs no code change. `classify_budget()` runs the
# three-step priority order direct operator correction set: a reviewed-match lookup first (the
# "treat reviewed rows like a RAG result" requirement -- `find_reviewed_match()`'s exact-then-
# longest-substring heuristic over every `reviewed=1` row, plain substring matching like every
# other matcher in this codebase, no new dependency), then the static rule chain
# (`categorize_transaction()` -> `budget_buckets.yaml`), then unclassified (bucket/field stay NULL,
# flagged for review) -- `Transfer` is excluded outright, same reporting exclusion §6/§9 already
# give the granular categorizer. `set_budget_classification()` is the one function that holds a
# non-read-only connection, mirroring `hermes_market_common.py`'s own `add_monitored_ticker()` role
# -- callers (the new `tools/hermes-budget-import.py` and `hermes-fleetops-ui.py`'s new `/budget`
# tab) never write SQL of their own.
#
# 1.0.0 (2026-11-22) — initial version. Rule-based transaction categorization for the Firmament
# Finance Tracker (FINANCE_TRACKER_DESIGN.md §6, S47c in IMPLEMENTATION_PLAN.md's build sequence).
# Drafted via hermes-dualcoder.py (tasks financetrack-7e8f6a7c76 through financetrack-cat5-
# ef9df62d65 — five rounds: a first draft that embedded the categories.yaml content as dead code
# instead of only reading it, a second attempt that hit a real hermes-dualcoder.py bug (a leaked
# reasoning tag tripping the router's own guard, fixed separately in that file's own 1.2.0), a
# third that converged but used a bare relative default path and an incomplete malformed-line
# check, and a fourth/fifth round that found and fixed both). Landed here after independent
# verification against the two functions' exact spec.
#
# load_categories() mirrors tools/hermes_market_common.py's own load_tags() in shape and
# error-handling style — same flat-delimited-text convention as tags.yaml/feeds.yaml/topics.yaml
# (despite the .yaml extension, this is NOT real YAML, so no PyYAML dependency), same
# REPO_DIR-anchored default path (never a bare relative string dependent on the process's working
# directory), same `len(parts) != 3 or not all(parts)` malformed-line condition, same (rules, bad)
# two-list return shape with 1-indexed line numbers and specific reasons in `bad`.
#
# categorize_transaction() differs from Market Watch's own tag matching in one deliberate way: a
# ticker can carry many tags, but a transaction gets exactly ONE category, so this stops at the
# first matching rule in file order rather than collecting every match.

import datetime
import os
import sqlite3
import urllib.parse
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_DIR = TOOLS_DIR.parent
DEFAULT_CATEGORIES_PATH = REPO_DIR / "infra" / "hermes-finance-sync" / "categories.yaml"
DEFAULT_BUDGET_BUCKETS_PATH = REPO_DIR / "infra" / "hermes-finance-sync" / "budget_buckets.yaml"

# The only currently-valid match_type. Same convention as hermes_market_common.py's own
# VALID_MATCH_TYPES set -- extend this if a future rule shape (e.g. regex) is ever added.
VALID_MATCH_TYPES = {"keyword"}

# Fidelity's "Budget Worksheet.pdf" own bucket/field vocabulary, used both to validate
# budget_buckets.yaml's `bucket` column and to populate hermes-fleetops-ui.py's /budget dropdowns.
# `Income` is this module's own addition -- the worksheet itself has no itemized income section
# (just one top-line "take-home pay" figure) -- added so paycheck/interest transactions have
# somewhere to go instead of sitting in the review queue forever.
WORKSHEET_TAXONOMY = {
    "Housing": ["Mortgage", "Rent/Condo Fees", "Property Tax", "Homeowners Insurance", "Electricity",
                "Water/Sewer", "Oil/Gas", "Internet/Telephone", "Cell Phone", "Other"],
    "Groceries": ["Food", "Other"],
    "Healthcare": ["Insurance Paid Out-Of-Pocket", "Prescriptions", "Co-payments, Deductibles, Etc.",
                   "Other"],
    "Transportation": ["Auto Loan or Lease Payment", "Auto Insurance", "Excise Tax/Registration",
                        "Routine Maintenance", "Gasoline", "Other Commuting Expenses", "Other"],
    "Debt & Monthly Obligations": ["Credit Card Debt", "Student Loans", "Loans, Taxes, Borrowing",
                                    "Alimony & Other Obligations", "Other"],
    "Child & Dependent Care": ["Support for Children", "Support for Parent(s)", "Other Obligations"],
    "Personal Care": ["Health and Beauty Aides", "Clothing", "Dry Cleaning", "Other"],
    "Gifts": ["Gifts", "Charitable Donations", "Other"],
    "Recreational": ["Travel and Vacations", "Club Memberships", "Hobbies", "Other"],
    "Entertainment": ["Movies/Theater/Sports Events", "Dining Out", "Other"],
    "Income": ["Paycheck", "Interest", "Other"],
}

# A new, dedicated SQLite store -- FINANCE_TRACKER_DESIGN.md §7 -- not folded into hermes-memory,
# same bulk-reference-data-vs-conversational-state distinction market.db already draws. Kept out
# of git purely by location (never under the repo's working tree), same as market.db -- see that
# file's own `connect()` docstring for the read/write split this mirrors.
FINANCE_DB = Path(os.environ.get("FINANCE_DB", "/mnt/hermes-data/finance/finance.db"))

# Only `accounts`/`transactions` (§7's own spec) and the new `budget_classifications` table are
# created here. Deliberately NOT yet created: `category_rules`, `category_proposals`,
# `plaid_items`, `schwab_auth`, `recurring_charges`, `report_items` -- those stay deferred to when
# S47b/d actually need them; an unused table is worse than a missing one.
SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    account_id        TEXT NOT NULL,
    source             TEXT NOT NULL,
    display_name       TEXT NOT NULL,
    kind               TEXT,
    plaid_item_id      TEXT,
    last_synced_date   TEXT,
    PRIMARY KEY (source, account_id)
);
CREATE TABLE IF NOT EXISTS transactions (
    txn_id          TEXT NOT NULL,
    account_id      TEXT NOT NULL,
    date            TEXT NOT NULL,
    amount_cents    INTEGER NOT NULL,
    payee_raw       TEXT NOT NULL,
    memo            TEXT,
    category        TEXT,
    source          TEXT NOT NULL,
    matched_txn_id  TEXT,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (source, txn_id)
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE TABLE IF NOT EXISTS budget_classifications (
    source          TEXT NOT NULL,
    txn_id          TEXT NOT NULL,
    bucket          TEXT,
    field           TEXT,
    classified_by   TEXT NOT NULL,
    reviewed        INTEGER NOT NULL DEFAULT 0,
    classified_at   TEXT NOT NULL,
    reviewed_at     TEXT,
    PRIMARY KEY (source, txn_id),
    FOREIGN KEY (source, txn_id) REFERENCES transactions(source, txn_id)
);
"""


def load_categories(path=None):
    """`category | match_type | pattern` per line, # comments and blanks ignored. No YAML is
    parsed -- same precedent as tags.yaml/feeds.yaml/topics.yaml. A malformed line or unknown
    match_type is reported (in `bad`, with its 1-indexed line number and the reason) and skipped,
    never fatal. Returns (rules, bad): rules is a list of (category, match_type, pattern) tuples,
    in file order -- categorize_transaction() relies on that order for its first-match-wins
    semantics.

    No try/except anywhere here, deliberately: an unexpected failure (permissions, encoding, etc.)
    must propagate rather than be silently swallowed. The only handled case is a missing file,
    checked up front with `path.is_file()`, which returns a named problem in `bad` rather than an
    empty rules list with no explanation."""
    if path is None:
        path = DEFAULT_CATEGORIES_PATH
    else:
        path = Path(path)

    if not path.is_file():
        return ([], [f"{path} does not exist"])

    rules = []
    bad = []
    with open(path, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            raw = line
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split("|")
            if len(parts) != 3 or not all(p.strip() for p in parts):
                bad.append(f"line {lineno}: expected category | match_type | pattern, got {raw!r}")
                continue
            category = parts[0].strip()
            match_type = parts[1].strip()
            pattern = parts[2].strip()
            if match_type not in VALID_MATCH_TYPES:
                bad.append(
                    f"line {lineno}: match_type must be one of {sorted(VALID_MATCH_TYPES)}, "
                    f"got {match_type!r}"
                )
                continue
            rules.append((category, match_type, pattern))

    return (rules, bad)


def categorize_transaction(text, rules):
    """The category of the FIRST rule (in file order) whose keyword matches `text` as a
    case-insensitive substring, or None if `text` is empty/falsy or nothing matches. Never
    guesses, never returns a default category -- an uncategorized transaction stays None for a
    human (or S47d's LLM fallback) to decide, not something this function invents."""
    if not text:
        return None
    text_lower = text.lower()
    for category, match_type, pattern in rules:
        if match_type == "keyword" and pattern.lower() in text_lower:
            return category
    return None


def connect(readonly=False):
    """Writer: mkdir the parent + idempotent CREATE TABLE IF NOT EXISTS + busy_timeout, the same
    shape hermes_market_common.py's own connect() uses for market.db. Reader: opens `mode=ro` by
    URI (hermes-fleetops-ui.py's own ro_sqlite() pattern) -- a bug in a read path cannot write to
    a store it has no business writing to, and a missing file raises instead of silently creating
    an empty one."""
    if readonly:
        return sqlite3.connect(f"file:{urllib.parse.quote(str(FINANCE_DB))}?mode=ro", uri=True,
                                timeout=15)
    FINANCE_DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(FINANCE_DB)
    con.execute("PRAGMA busy_timeout=30000")
    con.executescript(SCHEMA)
    con.commit()
    return con


def load_budget_buckets(path=None):
    """`category | bucket | field` per line, same shape/error-handling as load_categories(): a
    malformed line or unknown bucket is reported (in `bad`, with its 1-indexed line number and the
    reason) and skipped, never fatal. Returns (rules, bad): rules is a list of
    (category, bucket, field) tuples, in file order.

    `bucket` is validated against WORKSHEET_TAXONOMY the same way load_categories() validates
    match_type -- `field` is deliberately NOT validated against the bucket's own known field list,
    so a reasonable new field label (or the UI's free-text "other" override) never needs a code
    change here."""
    if path is None:
        path = DEFAULT_BUDGET_BUCKETS_PATH
    else:
        path = Path(path)

    if not path.is_file():
        return ([], [f"{path} does not exist"])

    rules = []
    bad = []
    with open(path, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            raw = line
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split("|")
            if len(parts) != 3 or not all(p.strip() for p in parts):
                bad.append(f"line {lineno}: expected category | bucket | field, got {raw!r}")
                continue
            category = parts[0].strip()
            bucket = parts[1].strip()
            field = parts[2].strip()
            if bucket not in WORKSHEET_TAXONOMY:
                bad.append(
                    f"line {lineno}: bucket must be one of {sorted(WORKSHEET_TAXONOMY)}, "
                    f"got {bucket!r}"
                )
                continue
            rules.append((category, bucket, field))

    return (rules, bad)


def classify_budget_rule(category, budget_rules):
    """The (bucket, field) of the FIRST budget_rules entry (in file order) whose category matches,
    or (None, None) if `category` is falsy or nothing matches -- the static half of
    classify_budget()'s priority order, kept as its own pure function so it's testable without a
    database."""
    if not category:
        return (None, None)
    for rule_category, bucket, field in budget_rules:
        if rule_category == category:
            return (bucket, field)
    return (None, None)


def normalize_payee(text):
    return (text or "").strip().lower()


def find_reviewed_match(conn, payee_raw):
    """The operator's own confirmed corrections, treated like a RAG result: every `reviewed=1`
    budget_classifications row is a prior human decision for a specific real payee string, and a
    new transaction from that same (or a containing/contained) payee should reuse it rather than
    fall back to the static rule chain or the review queue. Exact match on the normalized payee
    wins outright; otherwise the LONGEST reviewed payee that is a substring of the new one (or vice
    versa) wins, so a short, generic reviewed payee can't swallow an unrelated longer one. Plain
    substring matching, not embeddings -- consistent with every other matcher in this codebase.

    Returns (bucket, field) or None. A full table scan per call -- fine at personal-finance scale;
    revisit if `budget_classifications` ever grows large enough for this to matter."""
    target = normalize_payee(payee_raw)
    if not target:
        return None
    rows = conn.execute("""
        SELECT t.payee_raw, b.bucket, b.field FROM budget_classifications b
        JOIN transactions t ON t.source = b.source AND t.txn_id = b.txn_id
        WHERE b.reviewed = 1 AND b.bucket IS NOT NULL
    """).fetchall()
    best = None
    best_len = -1
    for raw_payee, bucket, field in rows:
        candidate = normalize_payee(raw_payee)
        if not candidate:
            continue
        if candidate == target:
            return (bucket, field)
        if candidate in target or target in candidate:
            if len(candidate) > best_len:
                best, best_len = (bucket, field), len(candidate)
    return best


def classify_budget(conn, category, payee_raw, budget_rules):
    """The three-step priority order: a reviewed-match lookup first (the operator's own past
    corrections, treated like a RAG result), then the static rule chain
    (categorize_transaction()'s `category` -> budget_buckets.yaml), then unclassified.
    `Transfer` is excluded outright -- same reporting exclusion FINANCE_TRACKER_DESIGN.md §6/§9
    already give the granular categorizer, never shown as needing review.

    Returns (bucket, field, classified_by, reviewed) -- reviewed is 1 for an excluded or
    reviewed-match row (both inherit confidence already established), 0 for a fresh rule match or
    an unclassified row."""
    if category == "Transfer":
        return (None, None, "excluded", 1)
    reviewed_hit = find_reviewed_match(conn, payee_raw)
    if reviewed_hit is not None:
        bucket, field = reviewed_hit
        return (bucket, field, "reviewed_match", 1)
    bucket, field = classify_budget_rule(category, budget_rules)
    if bucket is not None:
        return (bucket, field, "rule", 0)
    return (None, None, "unclassified", 0)


def set_budget_classification(txn_id, source, bucket, field, reviewed, who=""):
    """The one function that holds a non-read-only connection for this table, mirroring
    hermes_market_common.py's own add_monitored_ticker() role -- callers (hermes-budget-import.py,
    hermes-fleetops-ui.py's /budget/classify route) never write SQL of their own. `who` is logged
    by the caller, not stored here -- this table has no per-row owner concept, just one operator.

    Upserts rather than requiring the row to already exist, so this also serves as the path a
    freshly-unclassified transaction becomes manually classified for the first time."""
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    reviewed_at = now if reviewed else None
    con = connect(readonly=False)
    try:
        con.execute("""
            INSERT INTO budget_classifications
                (source, txn_id, bucket, field, classified_by, reviewed, classified_at, reviewed_at)
            VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
            ON CONFLICT (source, txn_id) DO UPDATE SET
                bucket=excluded.bucket, field=excluded.field, classified_by='manual',
                reviewed=excluded.reviewed, reviewed_at=excluded.reviewed_at
        """, (source, txn_id, bucket, field, int(bool(reviewed)), now, reviewed_at))
        con.commit()
    finally:
        con.close()
