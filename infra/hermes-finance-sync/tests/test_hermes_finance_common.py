#!/usr/bin/env python3
# Version: 1.0.0
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

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
