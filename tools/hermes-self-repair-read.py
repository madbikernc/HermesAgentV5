#!/usr/bin/env python3
# Version: 1.0.1
#
# 1.0.1 (2026-09-18) — real bug found live during this tool's own first verification pass:
# cmd_grep() on a single-file target that turned out to be denied (tools/vault-get-secret.sh,
# matches *secret*) silently fell back to walking that file's PARENT DIRECTORY instead of
# refusing — `real_root.parent` was used as the walk root for any non-directory target, so a
# denied file's own containing directory got searched instead, the opposite of narrowing scope.
# Fixed: a single-file target is now checked with the same is_allowed() gate before being treated
# as a search target at all, and refuses (exit 2) rather than widening to its neighbors. Caught by
# actually running the six cases this tool's own README documents, not by inspection alone.
#
# hermes-self-repair-read — scoped, read-only file access for the self-repair coding pipeline
# (stepped plan, Step 1). No shell, no write, no execute — LESSONS_LEARNED.md's own rule ("prefer
# a narrow tool over a general one, even when the general one is more convenient") applied here
# deliberately, not a placeholder to be widened later without a real reason.
#
# Operates ONLY against the dedicated self-repair checkout (SELF_REPAIR_REPO_DIR) — the NAS2-
# tracking clone from the stepped plan's Step 0, never a live node's own autopull working tree and
# never the operator's own dev checkout.
#
# Two operations, both read-only:
#   read <path>            -- print one allowlisted file's contents
#   grep <pattern> [path]  -- search allowlisted files under [path] (default: repo root) for a
#                             Python-regex pattern; a match inside a denied or unlisted file is
#                             never returned, not even the fact that a match exists in it
#
# Every path is checked against infra/hermes-self-repair/allowlist.json before anything is read:
#   1. Resolved to a real, absolute path (symlinks followed) and confirmed to still live inside
#      SELF_REPAIR_REPO_DIR — refuses any path that escapes the repo root, however it got there
#      (../.. traversal, an absolute path, or a symlink pointing outside).
#   2. Must fall under one of allowlist.json's "allowed_prefixes" (repo-relative directories).
#   3. Must NOT match any of allowlist.json's "deny_patterns" — checked even inside an allowed
#      prefix, deliberately: NAS2's own smtp.env.template held a live SMTP password despite its
#      name looking like a template (LESSONS_LEARNED.md), so filename conventions alone are not
#      trusted here.
#
# ALLOWLIST_PATH deliberately defaults OUTSIDE SELF_REPAIR_REPO_DIR — this tool's own installation
# (the normal HermesAgentV5 checkout wherever this script itself lives), not the target checkout it
# governs. Same reasoning hermes-remediate-worker.py's own allowlist already follows: policy lives
# with the tool's trusted installation, never with the thing being governed. If the target
# checkout's own copy of this file were used instead, a self-repair task could — via a bad patch —
# widen its own future read access by editing the very file that constrains it, which is exactly
# the self-modifying-privilege hole this project's "no LLM turn load-bearing for a privileged
# action" rule exists to prevent.
#
# Exit codes match hermes-remediate-worker.py's own convention: 0 success, 1 operational failure
# (e.g. pattern matched nothing), 2 refused (not allowlisted / denied / escapes repo root).
#
# Config:
#   SELF_REPAIR_REPO_DIR   default ~/HermesAgentV5-selfrepair — the dedicated NAS2-tracking
#                          checkout being read from (stepped plan, Step 0)
#   ALLOWLIST_PATH         default ~/HermesAgentV5/infra/hermes-self-repair/allowlist.json — this
#                          tool's OWN installation, not SELF_REPAIR_REPO_DIR (see above)
#
# Usage:
#   python3 hermes-self-repair-read.py read tools/hermes-code.py
#   python3 hermes-self-repair-read.py grep "def ask_coder" tools

import fnmatch
import json
import os
import re
import sys
from pathlib import Path

REPO_DIR = Path(os.environ.get(
    "SELF_REPAIR_REPO_DIR", str(Path.home() / "HermesAgentV5-selfrepair"))).resolve()
ALLOWLIST_PATH = Path(os.environ.get(
    "ALLOWLIST_PATH", str(Path.home() / "HermesAgentV5" / "infra" / "hermes-self-repair" / "allowlist.json")))


def log(msg):
    print(f"[hermes-self-repair-read] {msg}", file=sys.stderr)


def load_allowlist():
    with open(ALLOWLIST_PATH) as f:
        data = json.load(f)
    return data.get("allowed_prefixes", []), data.get("deny_patterns", [])


def resolve_in_repo(rel_path):
    """Resolves `rel_path` (repo-relative, may be attacker-influenced) to a real absolute path and
    confirms it still lives inside REPO_DIR after following symlinks — refuses ../ traversal, an
    absolute path outside the repo, and a symlink pointing outside, all the same way (None)."""
    candidate = (REPO_DIR / rel_path).resolve()
    try:
        candidate.relative_to(REPO_DIR)
    except ValueError:
        return None
    return candidate


def is_allowed(real_path, allowed_prefixes, deny_patterns):
    rel = real_path.relative_to(REPO_DIR).as_posix()
    if not any(rel == p.rstrip("/") or rel.startswith(p.rstrip("/") + "/") for p in allowed_prefixes):
        return False, "not under an allowed prefix"
    for pat in deny_patterns:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(real_path.name, pat):
            return False, f"matches deny pattern {pat!r}"
    return True, ""


def cmd_read(rel_path):
    allowed_prefixes, deny_patterns = load_allowlist()
    real_path = resolve_in_repo(rel_path)
    if real_path is None:
        log(f"refused: {rel_path!r} resolves outside the self-repair repo root")
        return 2
    ok, reason = is_allowed(real_path, allowed_prefixes, deny_patterns)
    if not ok:
        log(f"refused: {rel_path!r} — {reason}")
        return 2
    if not real_path.is_file():
        log(f"refused: {rel_path!r} is not a regular file")
        return 2
    try:
        sys.stdout.write(real_path.read_text(errors="replace"))
        return 0
    except Exception as exc:
        log(f"read failed: {exc}")
        return 1


def cmd_grep(pattern, rel_root):
    allowed_prefixes, deny_patterns = load_allowlist()
    real_root = resolve_in_repo(rel_root)
    if real_root is None:
        log(f"refused: {rel_root!r} resolves outside the self-repair repo root")
        return 2
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        log(f"invalid pattern: {exc}")
        return 2

    # A single-file target must be checked and searched as exactly that file — never widened to
    # its parent directory. Real bug caught live during this tool's own verification: grepping a
    # denied file (tools/vault-get-secret.sh, matches *secret*) silently fell back to walking all
    # of tools/ instead of refusing, because `real_root.parent` was used as the walk root for any
    # non-directory target. That's a scope-widening bug in the one tool whose entire job is
    # narrowing scope — a denied single-file target must refuse (exit 2), not search its neighbors.
    if real_root.is_file():
        ok, reason = is_allowed(real_root, allowed_prefixes, deny_patterns)
        if not ok:
            log(f"refused: {rel_root!r} — {reason}")
            return 2
        candidates = [real_root]
    elif real_root.is_dir():
        candidates = [p for p in sorted(real_root.rglob("*")) if p.is_file()]
    else:
        log(f"refused: {rel_root!r} is neither a file nor a directory")
        return 2

    matches = 0
    for path in candidates:
        if not path.is_file():
            continue
        ok, _ = is_allowed(path, allowed_prefixes, deny_patterns)
        if not ok:
            continue  # never surfaced, not even that a match exists in it
        try:
            for lineno, line in enumerate(path.read_text(errors="replace").splitlines(), start=1):
                if regex.search(line):
                    rel = path.relative_to(REPO_DIR).as_posix()
                    print(f"{rel}:{lineno}:{line}")
                    matches += 1
        except Exception:
            continue  # unreadable file (binary, permissions) — skipped, not fatal to the whole walk

    if matches == 0:
        log("no matches")
        return 1
    return 0


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: hermes-self-repair-read.py read <path> | grep <pattern> [path]")
    if not REPO_DIR.is_dir():
        sys.exit(f"SELF_REPAIR_REPO_DIR not found: {REPO_DIR}")
    if not ALLOWLIST_PATH.exists():
        sys.exit(f"allowlist not found at {ALLOWLIST_PATH}")

    op = sys.argv[1]
    if op == "read":
        if len(sys.argv) != 3:
            sys.exit("usage: hermes-self-repair-read.py read <path>")
        sys.exit(cmd_read(sys.argv[2]))
    elif op == "grep":
        if len(sys.argv) not in (3, 4):
            sys.exit("usage: hermes-self-repair-read.py grep <pattern> [path]")
        rel_root = sys.argv[3] if len(sys.argv) == 4 else "."
        sys.exit(cmd_grep(sys.argv[2], rel_root))
    else:
        sys.exit(f"unknown operation {op!r} — expected 'read' or 'grep'")


if __name__ == "__main__":
    main()
