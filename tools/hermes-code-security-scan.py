#!/usr/bin/env python3
# Version: 1.0.1
"""
hermes-code-security-scan.py — deterministic static-analysis pass for a single Python
function/snippet (a plain string, never a file the caller already has on disk, never executed
here or anywhere downstream). Built for tools/hermes-dualcoder.py's security_review()/
meta_review() phase (direct operator request, 2026-09-05): real, consistent findings feed the LLM
reviewer as grounding, instead of asking it to free-associate a security review from a blank slate
every run. The same function reviewed twice used to be able to surface different findings purely
from model sampling — a real static pass fixes that for the categories a tool can actually check.

Not named `hermes-security-scan.py` — that file already exists and is an unrelated nmap/whois
network-recon tool (Phase 18 honeypot alerting). Confirmed by reading it, not guessed from the name.

Dual mode:
  - Importable: `scan_code(code: str) -> dict`, `render_findings(findings: dict) -> str` — this is
    what tools/hermes-dualcoder.py calls in-process (`importlib.import_module(
    "hermes-code-security-scan")`, the same hyphenated-filename pattern hermes-status.py already
    uses three times for its own siblings).
  - Standalone CLI: `python3 hermes-code-security-scan.py --file <path>` or `--stdin`, `--json` for
    raw output — usable by a human or another specialist without touching hermes-dualcoder.py.

Five finding categories, three real tools plus two new heuristics for the one thing no existing
tool checks:
  bandit               known vulnerability *patterns* — injection, insecure deserialization, weak
                        crypto, eval/exec, path traversal, SSRF-shaped calls. The standard, mature
                        Python security AST-linter; this is exactly its job.
  unused_vars           ruff --select F (pyflakes-equivalent) — unused variables/imports,
                        undefined names, orphaned code.
  secrets               detect-secrets — hardcoded API keys, private keys, high-entropy strings.
                        Purpose-built, no baseline-file workflow needed for a one-off scan.
  destructive_actions   NEW, no existing tool does this: a destructive call (filesystem/shell/
                        database/privilege) with no auth-check-shaped pattern found anywhere in
                        the same snippet. Modeled directly on tools/hermes_injection_guard.py's own
                        proven shape — a dict of category -> compiled regexes — but this is
                        deliberately kept in this file rather than split into its own importable
                        module: unlike hermes_injection_guard.py (imported by a dozen specialists
                        for inbound-message screening), this check has exactly one real consumer.
                        A heuristic FLAG for the LLM's attention, not a verdict — real "is this
                        actually unauthenticated" judgment stays with the model reviewing it,
                        matching this whole design's division of labor (tool finds facts, LLM
                        judges context/severity/exploitability).
  credential_logging     NEW: a credential-shaped variable name (password/token/secret/api_key/...)
                        appearing as an argument to a logging/print call — a real, common leak
                        class none of the three tools above catch, since it's about *data flow
                        into a sink*, not a literal in source. Same heuristic-not-verdict framing.

Deliberately NOT attempted here: dependency/CVE scanning (pip-audit). That needs a real project
with pinned versions to check against a vulnerability database — a bare function string has
neither. A natural extension if this tool is ever pointed at whole files/repos instead of one
generated function.

Static only, never executes the candidate code — same policy tools/hermes-code.py already
established for the LLM side of this fleet (its own header: "NO tool-calling loop, NO file access,
NO code execution ... LESSONS_LEARNED.md documents real, serious incidents from exactly that kind
of access — an agent using a shared, unscoped-sudo account to install an unauthorized system
service; a delegated agent destroying 27GB of data and self-reporting success"). This tool extends
that same posture to the static tooling: the code is only ever read as text/AST by other programs,
written to a temp file this script itself creates and deletes, never run.

Temp-file/subprocess shape matches tools/hermes-security-scan.py's own established convention
(tempfile.NamedTemporaryFile, subprocess.run(..., capture_output=True, timeout=N),
Path.unlink(missing_ok=True) in a finally block) — not a new pattern invented here.

Config:
  CODESEC_VENV   default /opt/hermes/venvs/codesec — where bandit/ruff/detect-secrets live.
                 Explicit interpreter/binary paths, same convention hermes-status.py's own
                 STATUS_SOURCES already uses for every other venv-scoped external tool.

Exact CLI flags for bandit/ruff/detect-secrets below reflect each tool's well-known, documented
stable-release shape as of this writing — verify against the actually-installed versions once the
venv exists (`--help` on each), don't assume across a future `pip install --upgrade`. Same
"verify against a live run, don't trust the last thing you read" discipline this whole project has
used everywhere else (e.g. the reranker GGUF and BFCL registry mismatches were both real gaps
found exactly this way, not assumed away).

Changelog:
  1.0.1  Fixed a real bug found during live verification (2026-09-05): detect-secrets scan <path>
         silently scans nothing unless <path> is a git-tracked file -- `--all-files` alone does NOT
         override this for a bare temp file outside any repo (confirmed live: three different
         secret shapes, including a plain `--string` test that correctly fired AWSKeyDetector, all
         came back empty via `scan <path>` against /tmp; the same file inside a throwaway repo with
         a bare `git add` -- no commit needed -- scanned correctly). Every prior scan_code() call
         was silently finding zero secrets regardless of content. run_detect_secrets() now builds a
         disposable git repo around a copy of the file and cleans it up in a finally block. Also
         added --no-verify: detect-secrets' default behavior makes a live network call to check
         whether a found credential is currently valid, which both defeats a fake-but-format-correct
         test secret and is a network side effect this file's own "static only" policy (see above)
         should not have.
  1.0.0  Initial version.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

VENV_DIR = Path(os.environ.get("CODESEC_VENV", "/opt/hermes/venvs/codesec"))
BANDIT_BIN = str(VENV_DIR / "bin" / "bandit")
RUFF_BIN = str(VENV_DIR / "bin" / "ruff")
DETECT_SECRETS_BIN = str(VENV_DIR / "bin" / "detect-secrets")
SUBPROCESS_TIMEOUT = 30

# --- Destructive-action heuristic, same category-dict-of-compiled-regexes shape
# --- tools/hermes_injection_guard.py's own CMD_INJECTION/SQL_INJECTION/etc. already use.
DESTRUCTIVE_PATTERNS = {
    "filesystem_destruction": [
        r"\bos\.remove\(",
        r"\bos\.unlink\(",
        r"\bshutil\.rmtree\(",
        r"""\bopen\([^)]*,\s*['"]w['"]""",  # truncating open, not append
    ],
    "shell_destruction": [
        r"\bos\.system\(",
        r"\bsubprocess\.(run|call|Popen|check_call|check_output)\([^)]*shell\s*=\s*True",
        r"rm\s+-rf\b",
    ],
    "database_destruction": [
        r"(?i)\bDROP\s+TABLE\b",
        r"(?i)\bDELETE\s+FROM\b",
        r"(?i)\bTRUNCATE\b",
    ],
    "privilege_escalation": [
        r"\bsudo\b",
        r"\bos\.setuid\(",
        r"\bos\.seteuid\(",
    ],
}
_DESTRUCTIVE_COMPILED = {name: [re.compile(p) for p in pats] for name, pats in DESTRUCTIVE_PATTERNS.items()}

# Presence anywhere in the snippet only softens severity (info vs warning) -- it does NOT clear
# the finding. A real auth check three lines away from a destructive call, or one that doesn't
# actually gate that specific call, both need the LLM's own judgment, not a regex's.
AUTH_CHECK_HINTS = [
    r"(?i)\bis_admin\b",
    r"(?i)\bauthenticated\b",
    r"(?i)@require_\w*auth",
    r"(?i)\bpermission\b",
    r"(?i)\bcheck_auth\w*\(",
    r"(?i)\bauthorized\b",
]
_AUTH_COMPILED = [re.compile(p) for p in AUTH_CHECK_HINTS]

CREDENTIAL_VAR_RE = re.compile(r"\b(password|passwd|secret|api_key|apikey|token|private_key|credential\w*)\b", re.I)
LOGGING_CALL_RE = re.compile(r"\b(print|log|logger\.\w+|logging\.\w+)\s*\(([^)]*)\)")


def _line_of(code, offset):
    return code[:offset].count("\n") + 1


def scan_destructive_actions(code):
    """Heuristic flag, not a verdict. Returns a list of findings; `auth_hint_present_in_snippet`
    tells the LLM reviewer whether *something* auth-shaped exists anywhere in the snippet, not
    whether it actually guards this specific call -- that judgment is the model's job."""
    has_auth_hint = any(p.search(code) for p in _AUTH_COMPILED)
    findings = []
    for category, patterns in _DESTRUCTIVE_COMPILED.items():
        for p in patterns:
            for m in p.finditer(code):
                findings.append({
                    "category": category,
                    "line": _line_of(code, m.start()),
                    "match": m.group(0),
                    "auth_hint_present_in_snippet": has_auth_hint,
                    "severity": "info" if has_auth_hint else "warning",
                })
    return findings


def scan_credential_logging(code):
    """A credential-shaped variable name as an argument to a logging/print call -- data flowing
    into a sink, not a hardcoded literal (that's detect-secrets' job below). Real false-positive
    risk (a variable named `token_count` isn't a credential) -- framed as worth a look, same as
    scan_destructive_actions() above, not a hard verdict."""
    findings = []
    for m in LOGGING_CALL_RE.finditer(code):
        args_text = m.group(2)
        if CREDENTIAL_VAR_RE.search(args_text):
            findings.append({
                "category": "credential_logging",
                "line": _line_of(code, m.start()),
                "match": m.group(0)[:120],
                "severity": "warning",
            })
    return findings


def _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT, cwd=None):
    """Never raises -- one tool failing to run must not sink the other two (fail-isolated, same
    principle every multi-source check in this fleet already follows, e.g. hermes-status.py's own
    per-source try/except in its STATUS_SOURCES loop)."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired:
        return None
    except FileNotFoundError:
        return None


def run_bandit(path):
    """Returns (findings: list[dict], error: str|None)."""
    proc = _run_subprocess([BANDIT_BIN, "-f", "json", "-q", str(path)])
    if proc is None:
        return [], f"{BANDIT_BIN} not runnable (missing venv or timed out)"
    try:
        data = json.loads(proc.stdout or "{}")
    except (ValueError, json.JSONDecodeError) as exc:
        return [], f"bandit output not parseable JSON: {exc}"
    findings = []
    for r in data.get("results", []):
        findings.append({
            "category": "bandit",
            "line": r.get("line_number"),
            "test_id": r.get("test_id"),
            "description": r.get("issue_text"),
            "severity": (r.get("issue_severity") or "unknown").lower(),
            "confidence": (r.get("issue_confidence") or "unknown").lower(),
        })
    return findings, None


def run_ruff_unused(path):
    proc = _run_subprocess([RUFF_BIN, "check", "--select", "F", "--output-format", "json", str(path)])
    if proc is None:
        return [], f"{RUFF_BIN} not runnable (missing venv or timed out)"
    try:
        data = json.loads(proc.stdout or "[]")
    except (ValueError, json.JSONDecodeError) as exc:
        return [], f"ruff output not parseable JSON: {exc}"
    findings = []
    for r in data:
        loc = r.get("location", {})
        findings.append({
            "category": "unused_vars",
            "line": loc.get("row"),
            "code": r.get("code"),
            "description": r.get("message"),
            "severity": "info",
        })
    return findings, None


def run_detect_secrets(path):
    """detect-secrets `scan <path>` only scans git-tracked files -- confirmed live, `--all-files`
    does not override this for a path outside any repo at all. We build a disposable git repo
    around a copy of the file (a bare `git add`, no commit needed) so a plain temp file scans
    correctly, and clean the repo up unconditionally. `--no-verify` disables detect-secrets' own
    live network call to check whether a found credential is currently valid -- this file is
    static-only (see module docstring) and that verification call is a network side effect it
    must not have, on top of it defeating any fake-but-format-correct test secret outright."""
    tmp_repo = tempfile.mkdtemp(prefix="hermes-codesec-git-")
    try:
        repo_path = Path(tmp_repo)
        target_name = path.name
        (repo_path / target_name).write_text(path.read_text(encoding="utf-8"), encoding="utf-8")

        init = _run_subprocess(["git", "init", "-q"], cwd=str(repo_path))
        if init is None or init.returncode != 0:
            return [], "git init failed -- detect-secrets requires a git repo to scan a file"
        add = _run_subprocess(["git", "add", target_name], cwd=str(repo_path))
        if add is None or add.returncode != 0:
            return [], "git add failed -- detect-secrets requires the file to be tracked"

        proc = _run_subprocess([DETECT_SECRETS_BIN, "scan", "--no-verify", target_name], cwd=str(repo_path))
        if proc is None:
            return [], f"{DETECT_SECRETS_BIN} not runnable (missing venv or timed out)"
        try:
            data = json.loads(proc.stdout or "{}")
        except (ValueError, json.JSONDecodeError) as exc:
            return [], f"detect-secrets output not parseable JSON: {exc}"
        findings = []
        for _filename, secrets in (data.get("results") or {}).items():
            for s in secrets:
                findings.append({
                    "category": "secrets",
                    "line": s.get("line_number"),
                    "description": f"possible {s.get('type', 'secret')} detected",
                    "severity": "critical",
                })
        return findings, None
    finally:
        shutil.rmtree(tmp_repo, ignore_errors=True)


def scan_code(code):
    """Main entry point. Returns:
      {"bandit": [...], "unused_vars": [...], "secrets": [...], "destructive_actions": [...],
       "credential_logging": [...], "tool_errors": [...]}
    Never executes `code` -- writes it to a temp file purely so the three external static
    analyzers can read it as text/AST, deletes it in a finally block regardless of outcome."""
    tmp = tempfile.NamedTemporaryFile(suffix=".py", prefix="hermes-codesec-", mode="w",
                                       delete=False, encoding="utf-8")
    try:
        tmp.write(code)
        tmp.close()
        tmp_path = Path(tmp.name)

        errors = []
        bandit_findings, err = run_bandit(tmp_path)
        if err:
            errors.append(err)
        ruff_findings, err = run_ruff_unused(tmp_path)
        if err:
            errors.append(err)
        secrets_findings, err = run_detect_secrets(tmp_path)
        if err:
            errors.append(err)

        return {
            "bandit": bandit_findings,
            "unused_vars": ruff_findings,
            "secrets": secrets_findings,
            "destructive_actions": scan_destructive_actions(code),
            "credential_logging": scan_credential_logging(code),
            "tool_errors": errors,
        }
    finally:
        Path(tmp.name).unlink(missing_ok=True)


_SECTION_TITLES = {
    "bandit": "Known vulnerability patterns (bandit)",
    "unused_vars": "Unused variables/imports (ruff)",
    "secrets": "Possible hardcoded secrets (detect-secrets)",
    "destructive_actions": "Destructive actions without a visible auth check (heuristic -- verify, don't trust blindly)",
    "credential_logging": "Credential-shaped variables passed to logging (heuristic -- verify, don't trust blindly)",
}


def render_findings(findings):
    """Plain-text summary for direct inclusion in an LLM prompt -- readable, not raw JSON dumped
    into a system message."""
    total = sum(len(v) for k, v in findings.items() if k != "tool_errors")
    if total == 0 and not findings.get("tool_errors"):
        return ("Static analysis found no issues in any category (bandit, unused variables, "
                "secrets, destructive-action heuristics, credential-logging heuristics).")

    lines = []
    for key, title in _SECTION_TITLES.items():
        items = findings.get(key) or []
        if not items:
            continue
        lines.append(f"--- {title}: {len(items)} finding(s) ---")
        for f in items:
            line_no = f.get("line", "?")
            desc = f.get("description") or f.get("match") or f.get("category")
            sev = f.get("severity", "")
            extra = f" [{f['test_id']}]" if f.get("test_id") else ""
            lines.append(f"  line {line_no} ({sev}){extra}: {desc}")
        lines.append("")

    if findings.get("tool_errors"):
        lines.append("--- Scanner errors (best-effort -- missing findings here are NOT confirmed-clean) ---")
        for e in findings["tool_errors"]:
            lines.append(f"  {e}")

    return "\n".join(lines).strip()


def main():
    parser = argparse.ArgumentParser(description="Static security scan of a single Python code snippet.")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", help="path to a Python file to scan")
    src.add_argument("--stdin", action="store_true", help="read code from stdin")
    parser.add_argument("--json", action="store_true", help="print raw JSON instead of the text summary")
    args = parser.parse_args()

    code = sys.stdin.read() if args.stdin else Path(args.file).read_text(encoding="utf-8")

    findings = scan_code(code)
    if args.json:
        print(json.dumps(findings, indent=2))
    else:
        print(render_findings(findings))


if __name__ == "__main__":
    main()
