#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-11-23) — initial offline checks for tools/hermes-budget-import.py 1.0.0's pure
# helpers: parse_date() (Simplifi's own export format has been observed to vary -- both real
# forms seen must parse), parse_amount_cents(), and make_txn_id() (the occurrence-index scheme
# that keeps re-importing the same export idempotent even for genuine same-day/same-amount
# duplicate transactions). import_csv()/main() themselves are exercised by a real dry-run against
# the operator's own CSV, not here -- that file is local-only and never enters this repo, so no
# fixture can replay it. Pure stdlib, no network, no service.
#
# Run: python3 infra/hermes-finance-sync/tests/test_hermes_budget_import.py

import importlib.util
import sys
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
    sys.path.insert(0, str(TOOLS))  # hermes_finance_common.py, the module under test's own import
    spec = importlib.util.spec_from_file_location(
        "budget_import_under_test", TOOLS / "hermes-budget-import.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()

    print("\n[parse_date: both real Simplifi export formats seen from the same account]")
    check("DD-Mon-YY", mod.parse_date("21-Nov-26") == "2026-11-21")
    check("Mon DD, YYYY", mod.parse_date("Nov 21, 2026") == "2026-11-21")
    check("surrounding whitespace is tolerated", mod.parse_date("  21-Nov-26  ") == "2026-11-21")
    try:
        mod.parse_date("2026/11/21")
        check("an unrecognized format raises rather than guessing", False)
    except ValueError as exc:
        check("an unrecognized format raises rather than guessing", "unrecognized" in str(exc))

    print("\n[parse_amount_cents: signed, comma-tolerant]")
    check("a negative expense", mod.parse_amount_cents("-109.04") == -10904)
    check("a leading-space positive amount", mod.parse_amount_cents(" 379300.00") == 37930000)
    check("thousands separators are stripped", mod.parse_amount_cents("1,234.56") == 123456)
    check("zero", mod.parse_amount_cents("0.00") == 0)

    print("\n[make_txn_id: deterministic, and the occurrence index disambiguates real duplicates]")
    id_a = mod.make_txn_id("2026-11-20", "CREDIT CARD", "Amazon", -2721, 0)
    id_b = mod.make_txn_id("2026-11-20", "CREDIT CARD", "Amazon", -2721, 0)
    id_c = mod.make_txn_id("2026-11-20", "CREDIT CARD", "Amazon", -2721, 1)
    check("the same inputs always hash to the same id (idempotent re-import)", id_a == id_b)
    check("a different occurrence index changes the id (a genuine same-day duplicate)",
          id_a != id_c)
    check("ids are a fixed-length hex string", len(id_a) == 24 and all(c in "0123456789abcdef"
                                                                        for c in id_a))

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
