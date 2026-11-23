#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-11-23) — checks for 1.1.0's new budget-bucket layer: load_budget_buckets(),
# classify_budget_rule(), normalize_payee(), find_reviewed_match(), classify_budget(),
# connect()'s schema creation, and set_budget_classification()'s upsert. The DB-dependent checks
# point FINANCE_DB at a temp file (monkeypatched on the loaded module, same technique
# load_categories()'s path argument already uses for file isolation) — still pure stdlib, no
# network, no fleet node, no real finance.db ever touched.
#
# 1.0.0 (2026-11-22) — initial offline checks for tools/hermes_finance_common.py 1.0.0
# (load_categories()/categorize_transaction(), FINANCE_TRACKER_DESIGN.md §6, S47c). Pure stdlib,
# no network, no model, no service — same guarantee every other test file in this repo states.
# Mirrors infra/hermes-market-sync/tests/test_hermes_market_sync.py's own test_tags() shape, the
# direct precedent this module's load_categories() was written to match.
#
# Run: python3 infra/hermes-finance-sync/tests/test_hermes_finance_common.py

import importlib.util
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def load():
    spec = importlib.util.spec_from_file_location("finance_common_under_test", TOOLS / "hermes_finance_common.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()

    print("\n[load_categories: a missing file is a named problem, not a silent empty list]")
    missing = Path(tempfile.mkdtemp()) / "does-not-exist.yaml"
    rules, bad = mod.load_categories(missing)
    check("no rules from a missing file", rules == [])
    check("the missing path is named in bad", len(bad) == 1 and str(missing) in bad[0], bad)

    print("\n[load_categories: well-formed, malformed, and edge-case lines]")
    tmpdir = Path(tempfile.mkdtemp())
    cat_path = tmpdir / "categories.yaml"
    cat_path.write_text(
        "# a comment, ignored\n"
        "\n"
        "Groceries | keyword | whole foods\n"
        "Dining | keyword | starbucks\n"
        "Transfer | keyword | online xfer\n"
        "Bogus | notareal | something\n"
        "a line with no pipes at all\n"
        "| keyword | empty category\n"
        "Empty Pattern | keyword | \n"
        "Too | Many | Parts | Here\n",
        encoding="utf-8",
    )
    rules, bad = mod.load_categories(cat_path)
    check("exactly the three well-formed rules parse, in file order",
          rules == [("Groceries", "keyword", "whole foods"),
                    ("Dining", "keyword", "starbucks"),
                    ("Transfer", "keyword", "online xfer")],
          rules)
    check("an unknown match_type is reported with its line number",
          any("line 6" in b and "notareal" in b for b in bad), bad)
    check("a pipe-less line is reported", any("line 7" in b for b in bad), bad)
    check("an empty category is rejected, not added as a blank-category rule",
          any("line 8" in b for b in bad) and not any(r[0] == "" for r in rules), bad)
    check("an empty pattern is rejected, not added as an always-match rule",
          any("line 9" in b for b in bad) and not any(r[2] == "" for r in rules), bad)
    check("a line with the wrong number of parts is rejected",
          any("line 10" in b for b in bad), bad)
    check("every malformed line is reported, none silently dropped", len(bad) == 5, bad)

    print("\n[load_categories: default path is anchored to this module's own location]")
    check("DEFAULT_CATEGORIES_PATH is absolute, not a bare relative string",
          mod.DEFAULT_CATEGORIES_PATH.is_absolute(), mod.DEFAULT_CATEGORIES_PATH)
    check("it points at infra/hermes-finance-sync/categories.yaml under this repo",
          mod.DEFAULT_CATEGORIES_PATH == REPO / "infra" / "hermes-finance-sync" / "categories.yaml",
          mod.DEFAULT_CATEGORIES_PATH)

    print("\n[the real committed categories.yaml parses clean]")
    real_rules, real_bad = mod.load_categories()
    check("the committed seed file parses with no complaints", not real_bad, real_bad)
    check("it is non-empty", len(real_rules) > 0, len(real_rules))
    check("Transfer is present and load-bearing (§6: excluded from income/expense totals)",
          any(c == "Transfer" for c, _mt, _p in real_rules), real_rules)

    print("\n[categorize_transaction: first match wins, in rule order]")
    sample = [("Groceries", "keyword", "whole foods"), ("Shopping", "keyword", "whole")]
    check("the FIRST matching rule wins even though a later rule also matches",
          mod.categorize_transaction("WHOLE FOODS MARKET #123", sample) == "Groceries")
    check("matching is case-insensitive",
          mod.categorize_transaction("whole foods market", sample) == "Groceries")
    check("no match returns None, never a default category",
          mod.categorize_transaction("some unrelated merchant", sample) is None)
    check("empty text returns None", mod.categorize_transaction("", sample) is None)
    check("None text returns None", mod.categorize_transaction(None, sample) is None)
    check("an empty rules list returns None", mod.categorize_transaction("anything", []) is None)

    print("\n[load_budget_buckets: a missing file is a named problem, not a silent empty list]")
    missing = Path(tempfile.mkdtemp()) / "does-not-exist.yaml"
    rules, bad = mod.load_budget_buckets(missing)
    check("no rules from a missing file", rules == [])
    check("the missing path is named in bad", len(bad) == 1 and str(missing) in bad[0], bad)

    print("\n[load_budget_buckets: well-formed, malformed, and edge-case lines]")
    tmpdir = Path(tempfile.mkdtemp())
    bb_path = tmpdir / "budget_buckets.yaml"
    bb_path.write_text(
        "# a comment, ignored\n"
        "\n"
        "Groceries | Groceries | Food\n"
        "Home:Mortgage | Housing | Mortgage\n"
        "Credit Card Payment | Debt & Monthly Obligations | Credit Card Debt\n"
        "Bogus | Not A Real Bucket | Something\n"
        "a line with no pipes at all\n"
        "| Housing | empty category\n"
        "Empty Field | Housing | \n"
        "Too | Many | Parts | Here\n",
        encoding="utf-8",
    )
    rules, bad = mod.load_budget_buckets(bb_path)
    check("exactly the three well-formed rules parse, in file order",
          rules == [("Groceries", "Groceries", "Food"),
                    ("Home:Mortgage", "Housing", "Mortgage"),
                    ("Credit Card Payment", "Debt & Monthly Obligations", "Credit Card Debt")],
          rules)
    check("an unknown bucket is reported with its line number",
          any("line 6" in b and "Not A Real Bucket" in b for b in bad), bad)
    check("a pipe-less line is reported", any("line 7" in b for b in bad), bad)
    check("an empty category is rejected", any("line 8" in b for b in bad), bad)
    check("an empty field is rejected", any("line 9" in b for b in bad), bad)
    check("a line with the wrong number of parts is rejected", any("line 10" in b for b in bad), bad)
    check("every malformed line is reported, none silently dropped", len(bad) == 5, bad)

    print("\n[load_budget_buckets: default path is anchored, and the real committed file parses clean]")
    check("DEFAULT_BUDGET_BUCKETS_PATH is absolute, not a bare relative string",
          mod.DEFAULT_BUDGET_BUCKETS_PATH.is_absolute(), mod.DEFAULT_BUDGET_BUCKETS_PATH)
    check("it points at infra/hermes-finance-sync/budget_buckets.yaml under this repo",
          mod.DEFAULT_BUDGET_BUCKETS_PATH == REPO / "infra" / "hermes-finance-sync" / "budget_buckets.yaml",
          mod.DEFAULT_BUDGET_BUCKETS_PATH)
    real_budget_rules, real_bad_buckets = mod.load_budget_buckets()
    check("the committed mapping file parses with no complaints", not real_bad_buckets, real_bad_buckets)
    check("it is non-empty", len(real_budget_rules) > 0, len(real_budget_rules))
    check("Transfer is absent -- handled in code (classify_budget), never as a mapping line",
          not any(c == "Transfer" for c, _b, _f in real_budget_rules), real_budget_rules)

    print("\n[classify_budget_rule: first match wins, in rule order; no match is (None, None)]")
    bsample = [("Groceries", "Groceries", "Food"), ("Shopping:Clothing", "Personal Care", "Clothing")]
    check("the first matching rule wins", mod.classify_budget_rule("Groceries", bsample) == ("Groceries", "Food"))
    check("an unmapped category returns (None, None)",
          mod.classify_budget_rule("Cash & ATM", bsample) == (None, None))
    check("a falsy category returns (None, None)", mod.classify_budget_rule(None, bsample) == (None, None))
    check("an empty rules list returns (None, None)", mod.classify_budget_rule("Groceries", []) == (None, None))

    print("\n[normalize_payee: lowercase + trim, never raises on None]")
    check("trims and lowercases", mod.normalize_payee("  AMAZON.com  ") == "amazon.com")
    check("None becomes empty string", mod.normalize_payee(None) == "")

    print("\n[connect(): idempotent schema creation against a temp finance.db]")
    tmp_db = Path(tempfile.mkdtemp()) / "finance.db"
    mod.FINANCE_DB = tmp_db
    con = mod.connect(readonly=False)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    check("accounts/transactions/budget_classifications all exist",
          {"accounts", "transactions", "budget_classifications"} <= tables, tables)
    con.close()
    con2 = mod.connect(readonly=False)  # re-running must not fail on existing tables
    check("connecting again against the same file does not raise", con2 is not None)
    con2.close()

    def seed_transaction(con, txn_id, payee, category="Shopping"):
        now = "2026-11-23T00:00:00+00:00"
        con.execute("""INSERT INTO accounts (account_id, source, display_name) VALUES (?,?,?)
                        ON CONFLICT (source, account_id) DO NOTHING""",
                    ("acct1", "test", "Test Account"))
        con.execute("""INSERT INTO transactions
                        (txn_id, account_id, date, amount_cents, payee_raw, category, source, created_at)
                        VALUES (?, 'acct1', '2026-11-23', -500, ?, ?, 'test', ?)""",
                    (txn_id, payee, category, now))

    print("\n[find_reviewed_match / classify_budget: the reviewed-match (RAG) layer]")
    con = mod.connect(readonly=False)
    seed_transaction(con, "t1", "WHOLE FOODS MARKET #123")
    con.execute("""INSERT INTO budget_classifications
                    (source, txn_id, bucket, field, classified_by, reviewed, classified_at)
                    VALUES ('test', 't1', 'Groceries', 'Food', 'manual', 1, '2026-11-23T00:00:00+00:00')""")
    con.commit()
    check("an exact normalized payee match is found",
          mod.find_reviewed_match(con, "whole foods market #123") == ("Groceries", "Food"))
    check("a containing payee (substring) also matches",
          mod.find_reviewed_match(con, "WHOLE FOODS MARKET #123 EXTRA TEXT") == ("Groceries", "Food"))
    check("an unrelated payee finds nothing", mod.find_reviewed_match(con, "Some Other Merchant") is None)
    check("a falsy payee finds nothing", mod.find_reviewed_match(con, "") is None)

    brules = [("Shopping", "Entertainment", "Other")]
    check("classify_budget: Transfer is excluded outright, reviewed=1",
          mod.classify_budget(con, "Transfer", "Online Transfer To Savings", brules)
          == (None, None, "excluded", 1))
    check("classify_budget: a reviewed match wins over the static rule chain",
          mod.classify_budget(con, "Shopping", "whole foods market #123", brules)
          == ("Groceries", "Food", "reviewed_match", 1))
    check("classify_budget: falls back to the static rule chain, reviewed=0",
          mod.classify_budget(con, "Shopping", "Some Other Merchant", brules)
          == ("Entertainment", "Other", "rule", 0))
    check("classify_budget: neither hits -> unclassified, flagged for review",
          mod.classify_budget(con, "Cash & ATM", "Some Other Merchant", brules)
          == (None, None, "unclassified", 0))
    con.close()

    print("\n[set_budget_classification: upserts, and a fix always stamps reviewed_at]")
    con = mod.connect(readonly=False)
    seed_transaction(con, "t2", "Chewy.com")
    con.commit()
    con.close()
    mod.set_budget_classification("t2", "test", "Child & Dependent Care", "Other Obligations", True)
    con = mod.connect(readonly=True)
    row = con.execute("""SELECT bucket, field, classified_by, reviewed, reviewed_at
                          FROM budget_classifications WHERE source='test' AND txn_id='t2'""").fetchone()
    con.close()
    check("the first write inserts a manual, reviewed row",
          row[:4] == ("Child & Dependent Care", "Other Obligations", "manual", 1) and row[4], row)
    mod.set_budget_classification("t2", "test", "Personal Care", "Clothing", False)
    con = mod.connect(readonly=True)
    row2 = con.execute("""SELECT bucket, field, reviewed, reviewed_at
                           FROM budget_classifications WHERE source='test' AND txn_id='t2'""").fetchone()
    con.close()
    check("a second write updates the same row rather than inserting a new one",
          row2 == ("Personal Care", "Clothing", 0, None), row2)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
