#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-11-23) — initial version. CSV ingestion for the Firmament Finance Tracker's budget-
# bucket layer (FINANCE_TRACKER_DESIGN.md §6/§7, direct operator request). Reads a Simplifi-shaped
# export (Date, Account, Reviewed, Payee, Category, Exclusion, Amount — the real file already on
# hand, "Simplifi - Transactions.csv"), upserts accounts/transactions into finance.db (pulled
# forward from S47b, ungated from S47a's still-blocked vendor access — the same reasoning that
# already ungated S47c's own categorization half), and classifies every newly-seen transaction via
# hermes_finance_common.classify_budget(). Live API ingestion (Intuit/Plaid/Schwab) stays exactly
# where FINANCE_TRACKER_DESIGN.md already has it — out of scope here.
#
# Idempotent by design: re-running against the same (or an updated) export never duplicates a
# transaction row (source, txn_id) is the primary key) and never re-classifies or overwrites a
# transaction that's already been classified — including one the operator has since reviewed in
# hermes-fleetops-ui.py's /budget tab. txn_id is derived (date, account, payee, amount, nth
# occurrence of that exact combination in the file) since Simplifi's own export carries no stable
# transaction id — the occurrence index is what disambiguates genuine same-day same-amount
# duplicates (seen for real in the operator's own export, e.g. repeated small Amazon charges).

import argparse
import csv
import datetime
import hashlib
import sys
from pathlib import Path

import hermes_finance_common as fc

SOURCE = "simplifi_csv"


def log(msg):
    print(f"[hermes-budget-import] {msg}", flush=True)


# Simplifi's own export date format has been observed to vary by export/locale setting --
# "21-Nov-26" and "Nov 21, 2026" both seen from the same real account. Tried in order; the first
# one that parses wins.
DATE_FORMATS = ("%d-%b-%y", "%b %d, %Y")


def parse_date(raw):
    raw = raw.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"unrecognized date format: {raw!r} (tried {DATE_FORMATS})")


def parse_amount_cents(raw):
    """"-109.04" / " 379300.00" -> signed integer cents. Simplifi's own sign convention already
    matches FINANCE_TRACKER_DESIGN.md §7's (negative = expense/outflow, positive = income/inflow)."""
    cleaned = raw.strip().replace(",", "")
    return round(float(cleaned) * 100)


def make_txn_id(date_iso, account, payee, amount_cents, occurrence):
    """Deterministic given the file's own row order -- stable across re-imports of the same
    export, which is what makes this import idempotent without a real transaction id to key on."""
    raw = f"{date_iso}|{account}|{payee}|{amount_cents}|{occurrence}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def import_csv(csv_path, con, category_rules, budget_rules):
    occurrence_counts = {}
    # classified_<excluded|reviewed_match|rule|unclassified> counters are added dynamically below,
    # one per classify_budget() outcome actually seen -- no need to pre-declare all four here.
    stats = {"rows": 0, "excluded": 0, "accounts": 0, "new_transactions": 0, "skipped_existing": 0}
    seen_accounts = set()
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            stats["rows"] += 1
            if (row.get("Exclusion") or "").strip().lower() == "yes":
                stats["excluded"] += 1
                continue

            account = (row.get("Account") or "").strip()
            payee = (row.get("Payee") or "").strip()
            date_iso = parse_date(row["Date"])
            amount_cents = parse_amount_cents(row["Amount"])

            key = (date_iso, account, payee, amount_cents)
            occurrence = occurrence_counts.get(key, 0)
            occurrence_counts[key] = occurrence + 1
            txn_id = make_txn_id(date_iso, account, payee, amount_cents, occurrence)

            if account and account not in seen_accounts:
                seen_accounts.add(account)
                con.execute("""
                    INSERT INTO accounts (account_id, source, display_name, kind, plaid_item_id,
                                           last_synced_date)
                    VALUES (?, ?, ?, NULL, NULL, ?)
                    ON CONFLICT (source, account_id) DO UPDATE SET
                        display_name=excluded.display_name, last_synced_date=excluded.last_synced_date
                """, (account, SOURCE, account, date_iso))
                stats["accounts"] += 1

            category = fc.categorize_transaction(payee, category_rules)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            cur = con.execute("""
                INSERT OR IGNORE INTO transactions
                    (txn_id, account_id, date, amount_cents, payee_raw, memo, category, source,
                     matched_txn_id, created_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)
            """, (txn_id, account, date_iso, amount_cents, payee, category, SOURCE, now))
            if cur.rowcount != 1:
                stats["skipped_existing"] += 1
                continue
            stats["new_transactions"] += 1

            bucket, field, classified_by, reviewed = fc.classify_budget(
                con, category, payee, budget_rules)
            con.execute("""
                INSERT INTO budget_classifications
                    (source, txn_id, bucket, field, classified_by, reviewed, classified_at, reviewed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (SOURCE, txn_id, bucket, field, classified_by, reviewed, now,
                  now if reviewed else None))
            stats[f"classified_{classified_by}"] = stats.get(f"classified_{classified_by}", 0) + 1

    con.commit()
    return stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, help="Path to a Simplifi-shaped transaction export")
    args = parser.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.is_file():
        sys.exit(f"{csv_path} does not exist")

    category_rules, bad_categories = fc.load_categories()
    if bad_categories:
        log(f"WARNING: {len(bad_categories)} malformed line(s) in {fc.DEFAULT_CATEGORIES_PATH}")
    budget_rules, bad_buckets = fc.load_budget_buckets()
    if bad_buckets:
        log(f"WARNING: {len(bad_buckets)} malformed line(s) in {fc.DEFAULT_BUDGET_BUCKETS_PATH}")

    con = fc.connect(readonly=False)
    try:
        stats = import_csv(csv_path, con, category_rules, budget_rules)
    finally:
        con.close()

    log(f"done: {stats}")


if __name__ == "__main__":
    main()
