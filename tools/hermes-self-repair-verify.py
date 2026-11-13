#!/usr/bin/env python3
# Version: 2.0.0
#
# 2.0.0 (2026-11-13) — direct operator request ("improve the fidelity and accuracy, the
# effectiveness of the self repair process"). Every minecraft-bots fix is JavaScript, and for a
# .js file this gate checked nothing at all: no syntax checker, static analysis Python-only, no
# test ever run -- so of the seven fixes staged 2026-11-10/11, five that change nothing (helpers
# nobody calls, a field nothing reads, a comment-only edit) all came out "verified". Added:
#   * `node --check` for .js/.mjs/.cjs.
#   * Behavior-change check: a diff whose every changed line is a comment or blank fails.
#   * Dead-addition check: an export used nowhere (its own file or any other), a local function
#     never called, or a property only ever written fails.
#   * The domain's own test suite (domains.json `verify_command`), run in a fresh detached
#     `git worktree` of the applied commit with `verify_links` (node_modules) symlinked in, so
#     the self-repair checkout itself is never touched.
#   * check_test_discriminates(), for a fix's linked test task: the test must pass with the fix and
#     fail with the fix's file as it was before it (called by hermes-self-repair-apply.py 2.0.0).
# verify(path) with no other arguments behaves exactly as 1.0.0 plus the JS syntax check; the CLI
# is unchanged.
#
# hermes-self-repair-verify — Step 4's PRE-PROMOTION verification gate: deterministic, no model
# call, PASS/FAIL. Runs against the file as it actually landed on disk in SELF_REPAIR_REPO_DIR
# after Step 3's real `git apply` — not the candidate string from hermes-memory — so a pass here is
# proof about what was actually committed, not just about what was reviewed.
#
# Two checks, both language-aware:
#
#   1. Syntax. `.py` via `py_compile`, `.sh` via `bash -n`. Any other extension has no checker in
#      this version and is reported as such — "no syntax checker for this file type" — rather than
#      silently skipped or wrongly assumed clean. A syntax failure is an unconditional FAIL: a
#      self-repair "fix" that doesn't even parse is definitionally broken, regardless of what any
#      model review said about it.
#
#   2. Static analysis, `.py` only — reuses tools/hermes-code-security-scan.py's `scan_code()`/
#      `render_findings()` exactly, imported the same hyphenated-module way hermes-dualcoder.py
#      already does. Deliberately NOT "any finding fails": that tool's own docstring frames most of
#      its categories (unused vars, the two heuristics, low/medium-severity bandit) as "tool finds
#      facts, LLM/human judges severity" — treating every one as a hard blocker here would make this
#      gate fail on things this project's own tooling explicitly says need judgment, not a veto.
#      Only two categories are unambiguous enough to block automatically:
#        - any detect-secrets finding (that category is always "critical" — a real, hardcoded
#          secret should never be promoted, full stop)
#        - a bandit finding at "high" severity (bandit's own three-level scale)
#      Everything else is reported in the verification record, not treated as a failure. Fails OPEN
#      (passes, with a clear note) if bandit/ruff/detect-secrets are all unavailable — same posture
#      hermes-dualcoder.py's own run_static_scan() already uses when its scanner can't run; an
#      unreachable venv on one node must not silently block every self-repair task.
#
# Non-.py files (services/*.js, skills/*.md, etc. — real paths under Step 1's allowed prefixes) get
# a syntax-only check where one exists (.sh) and an honest "not applicable" note otherwise, never a
# fabricated pass dressed up as a real check.
#
# Dual mode, same convention hermes-code-security-scan.py already establishes: importable
# (`verify(path) -> (ok, report)`) for tools/hermes-self-repair-apply.py, and a standalone CLI for
# a human to run by hand.
#
# Usage: python3 hermes-self-repair-verify.py <path-on-disk>

import importlib.util
import os
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_CODESEC_PATH = Path(__file__).resolve().parent / "hermes-code-security-scan.py"
_spec = importlib.util.spec_from_file_location("hermes_code_security_scan", _CODESEC_PATH)
_codesec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_codesec)

BANDIT_FAIL_SEVERITIES = {"high"}


def check_syntax(path):
    """Returns (ok, note). See module header for the per-extension rationale."""
    suffix = path.suffix.lower()
    if suffix == ".py":
        try:
            py_compile.compile(str(path), doraise=True)
            return True, "Python syntax: OK"
        except py_compile.PyCompileError as exc:
            return False, f"Python syntax FAILED: {exc}"
    if suffix == ".sh":
        proc = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
        if proc.returncode == 0:
            return True, "Shell syntax: OK"
        return False, f"Shell syntax FAILED: {proc.stderr.strip()}"
    if suffix in (".js", ".mjs", ".cjs"):
        try:
            proc = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
        except FileNotFoundError:
            return True, "JavaScript syntax: node not installed -- not checked, not confirmed clean"
        if proc.returncode == 0:
            return True, "JavaScript syntax: OK"
        return False, f"JavaScript syntax FAILED: {proc.stderr.strip()[:600]}"
    return True, (f"No syntax checker for {suffix or '(no extension)'} files — not checked, "
                  f"not confirmed clean")


def check_static_analysis(path):
    """Returns (ok, note). Only meaningful for .py files — see module header."""
    if path.suffix.lower() != ".py":
        return True, (f"Static analysis not applicable to {path.suffix or '(no extension)'} files "
                      f"(hermes-code-security-scan.py is Python-only) — not checked, not confirmed clean")

    findings = _codesec.scan_code(path.read_text(encoding="utf-8"))
    report = _codesec.render_findings(findings)

    if len(findings.get("tool_errors", [])) >= 3:
        return True, f"Static analysis tools unavailable this run (fail-open, not confirmed clean):\n{report}"

    secrets = findings.get("secrets") or []
    if secrets:
        return False, f"Static analysis FAILED — {len(secrets)} possible hardcoded secret(s):\n{report}"

    high_bandit = [f for f in (findings.get("bandit") or []) if f.get("severity") in BANDIT_FAIL_SEVERITIES]
    if high_bandit:
        return False, f"Static analysis FAILED — {len(high_bandit)} high-severity bandit finding(s):\n{report}"

    return True, report


# ---- 2.0.0: substance checks on the diff itself -------------------------------------------------

JS_SUFFIXES = {".js", ".mjs", ".cjs"}
CODE_SUFFIXES = JS_SUFFIXES | {".py"}
# The Version header and changelog lines every file in this repo carries are comments, so they
# never count as a behavior change on their own; anything else that changes does.
_IDENT = r"[A-Za-z_$][\w$]*"


def _is_comment_or_blank(line, suffix):
    s = line.strip()
    if not s:
        return True
    if suffix == ".py":
        return s.startswith("#")
    return s.startswith(("//", "/*", "*", "*/"))


def _strip_trailing_comment(line, suffix):
    marker = "#" if suffix == ".py" else "//"
    # Good enough for this purpose: a marker inside a string literal only ever makes a line look
    # SHORTER, which can only make a real change look like a comment-only one -- never the reverse.
    idx = line.find(marker)
    return line if idx < 0 else line[:idx]


def changed_lines(diff_text):
    """(added, removed) lines of a unified diff, without the +/- markers and file headers."""
    added, removed = [], []
    for line in diff_text.splitlines():
        if line.startswith(("+++", "---")):
            continue
        if line.startswith("+"):
            added.append(line[1:])
        elif line.startswith("-"):
            removed.append(line[1:])
    return added, removed


def check_behavior_change(suffix, diff_text):
    """Returns (ok, note). Fails a diff whose every changed line is a comment or blank -- 2026-11-11's
    19dbdfd changed only comments (and the new comments were wrong) yet passed every gate."""
    if suffix not in CODE_SUFFIXES:
        return True, f"Behavior-change check not applicable to {suffix or '(no extension)'} files"
    added, removed = changed_lines(diff_text)
    code = [l for l in added + removed if not _is_comment_or_blank(l, suffix)]
    if not code:
        return False, ("Behavior-change check FAILED: every changed line is a comment or blank -- "
                       "this diff cannot change what the code does")
    return True, f"Behavior-change check: OK ({len(code)} changed code line(s))"


def new_definitions(suffix, added, removed):
    """Names this diff defines that the removed side did not: (exported, local, written_props)."""
    exported, local, props = set(), set(), set()
    removed_text = "\n".join(removed)
    for raw in added:
        if _is_comment_or_blank(raw, suffix):
            continue
        line = _strip_trailing_comment(raw, suffix)
        if suffix == ".py":
            m = re.match(rf"^def\s+({_IDENT})\s*\(", line)
            if m:
                (local if m.group(1).startswith("_") else exported).add(m.group(1))
            continue
        m = re.match(rf"^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+({_IDENT})", line)
        if m:
            exported.add(m.group(1))
            continue
        m = re.match(rf"^\s*(?:async\s+)?function\*?\s+({_IDENT})\s*\(", line)
        if m:
            local.add(m.group(1))
        for m in re.finditer(rf"(?:^|[{{,]\s*)({_IDENT})\s*:(?!:)|\.({_IDENT})\s*=(?!=)", line):
            props.add(m.group(1) or m.group(2))
    defined_before = lambda name: re.search(rf"\b{re.escape(name)}\b", removed_text) is not None
    return ({n for n in exported if not defined_before(n)},
            {n for n in local if not defined_before(n)},
            {n for n in props if not defined_before(n)})


def _code_occurrences(text, name, suffix):
    """Occurrences of `name` in `text`, comment lines and trailing comments excluded."""
    count = 0
    for line in text.splitlines():
        if _is_comment_or_blank(line, suffix):
            continue
        count += len(re.findall(rf"(?<![\w$]){re.escape(name)}(?![\w$])", _strip_trailing_comment(line, suffix)))
    return count


def _referenced_elsewhere(repo_dir, rel_path, name):
    """True if any tracked file other than rel_path mentions `name` in code (not only comments)."""
    proc = subprocess.run(["git", "-C", str(repo_dir), "grep", "-l", "-w", "-F", "-e", name, "--", "."],
                          capture_output=True, text=True)
    for other in proc.stdout.splitlines():
        if other == rel_path:
            continue
        try:
            text = (Path(repo_dir) / other).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if _code_occurrences(text, name, Path(other).suffix.lower() or ".js"):
            return True
    return False


def check_dead_additions(path, rel_path, diff_text, repo_dir):
    """Returns (ok, note). Fails a diff that adds code nothing can reach -- three of 2026-11-10/11's
    seven staged fixes added a helper or a field and no caller (clearStuckState, resetGoalProgress,
    rejectedDones): the single-file scope let the model write the fix's half that fits in the file,
    and nothing checked the other half existed.
      * an exported function/const/class used nowhere, in its own file or any other;
      * a new local function named nowhere else in its own file;
      * a new property only ever written (`name:` / `.name =`), never read, anywhere."""
    suffix = path.suffix.lower()
    if suffix not in CODE_SUFFIXES:
        return True, f"Dead-addition check not applicable to {suffix or '(no extension)'} files"
    added, removed = changed_lines(diff_text)
    exported, local, props = new_definitions(suffix, added, removed)
    text = path.read_text(encoding="utf-8", errors="replace")
    dead = []
    for name in sorted(exported):
        # Used inside its own file counts too (a shared helper exported for later is not dead).
        if _code_occurrences(text, name, suffix) < 2 and not _referenced_elsewhere(repo_dir, rel_path, name):
            dead.append(f"exported {name!r} is used nowhere, in its own file or any other")
    for name in sorted(local):
        if _code_occurrences(text, name, suffix) < 2:
            dead.append(f"function {name!r} is never called")
    for name in sorted(props - exported - local):
        total = _code_occurrences(text, name, suffix)
        writes = len(re.findall(rf"(?:^|[{{,]\s*){re.escape(name)}\s*:(?!:)|\.{re.escape(name)}\s*=(?!=)",
                                "\n".join(_strip_trailing_comment(l, suffix) for l in text.splitlines()
                                          if not _is_comment_or_blank(l, suffix)), re.M))
        if total and total <= writes and not _referenced_elsewhere(repo_dir, rel_path, name):
            dead.append(f"property {name!r} is written but never read")
    if dead:
        return False, "Dead-addition check FAILED -- nothing can reach what this diff adds:\n  " + "\n  ".join(dead)
    return True, "Dead-addition check: OK"


# ---- 2.0.0: running the domain's own tests in a clean worktree ----------------------------------

def run_in_worktree(repo_dir, command, links=None, overrides=None, rev="HEAD", timeout=900):
    """Runs `command` (argv list) at the root of a fresh, detached `git worktree` of `rev`, so the
    real checkout is never touched. `links` maps repo-relative paths to existing directories to
    symlink in (node_modules -- gitignored, so absent from any worktree). `overrides` maps
    repo-relative paths to replacement file content (str) or None (delete). Returns (rc, output)."""
    tmp = Path(tempfile.mkdtemp(prefix="selfrepair-verify-"))
    tree = tmp / "tree"
    try:
        add = subprocess.run(["git", "-C", str(repo_dir), "worktree", "add", "--detach", str(tree), rev],
                             capture_output=True, text=True)
        if add.returncode != 0:
            return 125, f"git worktree add failed: {add.stderr.strip()[:400]}"
        for rel, target in (links or {}).items():
            src = Path(os.path.expanduser(target))
            if src.exists():
                (tree / rel).parent.mkdir(parents=True, exist_ok=True)
                (tree / rel).symlink_to(src)
        for rel, content in (overrides or {}).items():
            if content is None:
                (tree / rel).unlink(missing_ok=True)
            else:
                (tree / rel).write_text(content, encoding="utf-8")
        try:
            proc = subprocess.run(command, cwd=str(tree), capture_output=True, text=True, timeout=timeout)
            return proc.returncode, (proc.stdout + proc.stderr)
        except subprocess.TimeoutExpired:
            return 124, f"timed out after {timeout}s"
    finally:
        subprocess.run(["git", "-C", str(repo_dir), "worktree", "remove", "--force", str(tree)],
                       capture_output=True, text=True)
        shutil.rmtree(tmp, ignore_errors=True)


def _tail(output, lines=25):
    return "\n".join(output.strip().splitlines()[-lines:])


def check_tests(repo_dir, command, links=None):
    """Returns (ok, note). The domain's own offline test suite, run on the applied commit."""
    rc, output = run_in_worktree(repo_dir, command, links=links)
    shown = " ".join(command)
    if rc == 0:
        return True, f"Tests: OK ({shown})\n{_tail(output, 6)}"
    return False, f"Tests FAILED ({shown}, exit {rc}):\n{_tail(output)}"


def check_test_discriminates(repo_dir, test_rel, fix_rel, fix_sha, single_test_command, links=None):
    """Returns (ok, note). For a test task: its test must PASS on the applied tree and FAIL with the
    fix's file put back as it was before the fix (`fix_sha`'s parent) -- the repo's own rule ("a
    unit check that fails on the old code"). A test that passes either way proves nothing about the
    fix (2026-11-13: a test task that changed nothing at all was "verified")."""
    command = [part.replace("{test_path}", test_rel) for part in single_test_command]
    rc_new, out_new = run_in_worktree(repo_dir, command, links=links)
    if rc_new != 0:
        return False, f"Test check FAILED: {test_rel} does not pass with the fix applied (exit {rc_new}):\n{_tail(out_new)}"
    before = subprocess.run(["git", "-C", str(repo_dir), "show", f"{fix_sha}^:{fix_rel}"],
                            capture_output=True, text=True)
    old_content = before.stdout if before.returncode == 0 else None
    rc_old, out_old = run_in_worktree(repo_dir, command, links=links, overrides={fix_rel: old_content})
    if rc_old == 0:
        return False, (f"Test check FAILED: {test_rel} also passes with {fix_rel} as it was before the fix "
                       f"({fix_sha[:12]}^) -- it does not test the fix")
    return True, f"Test check: OK ({test_rel} passes with the fix, fails without it)"


def verify(path, diff_text=None, repo_dir=None, rel_path=None, test_command=None, links=None):
    """`path` must already be a real, resolved Path on disk -- this function verifies, it does not
    decide what's readable/allowed (the caller, tools/hermes-self-repair-apply.py, has already
    done that before calling this). Returns (ok: bool, report: str), report covering every check
    regardless of outcome.

    2.0.0: with `diff_text`, also the behavior-change check; with `repo_dir` + `rel_path`, the
    dead-addition check; with `test_command` (argv, from the domain registry), the domain's own
    tests in a clean worktree of the applied commit."""
    notes = []
    ok = True
    for check_ok, note in (check_syntax(path), check_static_analysis(path)):
        ok = ok and check_ok
        notes.append(note)
    if diff_text is not None:
        check_ok, note = check_behavior_change(path.suffix.lower(), diff_text)
        ok = ok and check_ok
        notes.append(note)
        if repo_dir is not None and rel_path:
            check_ok, note = check_dead_additions(path, rel_path, diff_text, repo_dir)
            ok = ok and check_ok
            notes.append(note)
    if test_command and repo_dir is not None:
        check_ok, note = check_tests(repo_dir, test_command, links=links)
        ok = ok and check_ok
        notes.append(note)
    return ok, "\n\n".join(notes)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: hermes-self-repair-verify.py <path>")
    target = Path(sys.argv[1])
    if not target.is_file():
        sys.exit(f"not a file: {target}")
    ok, report = verify(target)
    print(report)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
