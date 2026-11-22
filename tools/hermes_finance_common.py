#!/usr/bin/env python3
# Version: 1.0.0
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

from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_DIR = TOOLS_DIR.parent
DEFAULT_CATEGORIES_PATH = REPO_DIR / "infra" / "hermes-finance-sync" / "categories.yaml"

# The only currently-valid match_type. Same convention as hermes_market_common.py's own
# VALID_MATCH_TYPES set -- extend this if a future rule shape (e.g. regex) is ever added.
VALID_MATCH_TYPES = {"keyword"}


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
