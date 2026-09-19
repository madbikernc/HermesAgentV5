#!/usr/bin/env python3
# Version: 1.0.0
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
import py_compile
import subprocess
import sys
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


def verify(path):
    """`path` must already be a real, resolved Path on disk — this function verifies, it does not
    decide what's readable/allowed (the caller, tools/hermes-self-repair-apply.py, has already
    done that before calling this). Returns (ok: bool, report: str), report covering both checks
    regardless of outcome."""
    syntax_ok, syntax_note = check_syntax(path)
    static_ok, static_note = check_static_analysis(path)
    ok = syntax_ok and static_ok
    return ok, f"{syntax_note}\n\n{static_note}"


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
