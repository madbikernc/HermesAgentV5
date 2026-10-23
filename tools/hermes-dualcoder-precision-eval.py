#!/usr/bin/env python3
# Version: 1.0.0
#
# Initial version (2026-10-23) — S39 Phase C (FLEET_BENCHMARK_DESIGN.md S6.5), after S39a's
# sign-off. New tool. 6 cases (the project's own already-documented, already-operator-verified
# codesec verification recipe, plus real clean functions already in this repo and two cases
# adapted from the scanner's own documented trigger patterns), 20 offline checks
# (infra/model-benchmark/tests/test_dualcoder_precision.py). No fleet node reachable, so no live
# run against a real coder/coder2 endpoint, and the three subprocess-based scanner categories
# (bandit/ruff/detect-secrets) can't run on this dev machine either -- see module docstring.
"""
hermes-dualcoder-precision-eval.py — S39 Phase C's fleet_dualcoder_precision suite, closing
FLEET_BENCHMARK_DESIGN.md gap 5 (S6.5), after S39a's sign-off (2026-10-22). Scores whether a
coder-role's security review agrees with hermes-code-security-scan.py's own real static-analysis
findings — confirming real findings (recall) without inventing new ones on clean code
(precision). This is a review-agreement task, deliberately distinct from S6.7's generation task.

GROUND TRUTH (S8.6): the static scanner's own findings ARE the deterministic ground truth — this
file calls the real `scan_code()`/`render_findings()` (imported directly from
hermes-code-security-scan.py, which is import-safe: module scope is only env-var reads and regex
compilation, no sibling imports, no network) rather than hand-labelling anything. The cases
themselves are the strongest provenance available without live fleet access:
  - 2 cases are `infra/hermes-code-security-scan/README.md` S2's own already-operator-documented,
    already-verified recipe, reproduced verbatim: the vulnerable snippet designed to trigger all
    five finding categories, and the clean counter-example that should produce "no issues".
  - 2 cases are real, already-reviewed clean functions already committed in this repo
    (`hermes_benchmark_common.py`'s `_pkg_version()`, `hermes-log-analyst-eval.py`'s
    `check_facts()`) — real code, not invented for this suite.
  - 2 cases are adapted from the scanner's own documented `DESTRUCTIVE_PATTERNS`/credential-
    logging regexes (read directly from hermes-code-security-scan.py, not guessed) to broaden
    the "should find something" side beyond the one canonical example.
None of this is real-sampled from this fleet's own git history the way S6.7/S6.8's corpora are --
a genuinely real-grounded version of this suite (real past commits with a real scanner finding)
remains open future work for a session with fleet access, per S6.5's own "pulled from this repo's
history rather than invented" framing. What's here is a real floor, not invented fixtures, but
narrower than that framing's own ambition.

A REAL, STATED LIMITATION, not glossed over: bandit/ruff/detect-secrets live in a dedicated venv
(`CODESEC_VENV`, default `/opt/hermes/venvs/codesec`) that does not exist on this dev machine, so
`scan_code()` degrades those three categories to `tool_errors` here (confirmed live, not
assumed) — only the two pure-regex heuristic categories (`destructive_actions`,
`credential_logging`) actually fire when this file is run from this session. The harness itself
is correct and real; a full run needs the same venv the scanner tool already requires in
production, nothing new.

SECURITY_SYSTEM_PROMPT is read directly out of hermes-dualcoder.py's own source via `ast`, same
anti-drift reasoning and same reason for avoiding a live `exec` as hermes-log-analyst-eval.py's
own SOURCE_SYSTEM_PROMPT extraction (hermes-dualcoder.py's module scope has its own
router/Buzz-token assumptions this eval doesn't need).

METRIC: recall = of the cases with real findings, how many does the model's review NOT dismiss
as entirely false-positive (a deterministic keyword check -- "confirmed first, LLM judge only for
residue", S28's own rule, one tier down). Precision = of the clean cases, how many does the model
NOT claim a new vulnerability for. Both deterministic text checks over the model's prose review,
same class of heuristic hermes-bakeoff-refusal-check.py/hermes-log-analyst-eval.py's own
classify_verdict() already use and already flag as needing human spot-checking, never an LLM
judge for this specific check.

Always direct-to-backend (S8.1).

Usage:
  hermes-dualcoder-precision-eval.py --endpoint http://127.0.0.1:8094/v1 \\
      [--model-id "coder (live)"] [--limit N] [--json out.json]
"""
import argparse
import ast
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import hermes_benchmark_common as bc  # noqa: E402


def log(msg):
    print(f"[hermes-dualcoder-precision-eval] {msg}", flush=True)


def load_security_system_prompt():
    """ast-extracted from hermes-dualcoder.py's own source -- see module docstring for why a live
    exec of that file is avoided."""
    path = TOOLS / "hermes-dualcoder.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == "SECURITY_SYSTEM_PROMPT"):
            return ast.literal_eval(node.value)
    sys.exit(f"could not find SECURITY_SYSTEM_PROMPT in {path} -- has it been renamed?")


def load_codesec():
    """hermes-code-security-scan.py IS safe to exec directly (confirmed by reading it: module
    scope is only env-var reads and regex compilation, no sibling imports, no network) -- unlike
    hermes-logs.py/hermes-dualcoder.py, this one doesn't need the ast-extraction workaround."""
    spec_path = TOOLS / "hermes-code-security-scan.py"
    import importlib.util
    spec = importlib.util.spec_from_file_location("_codesec", spec_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── the case set (see module docstring for each case's real provenance) ────────────────────────

# Case 1-2: infra/hermes-code-security-scan/README.md S2's own verbatim verification recipe.
_README_VULN_CODE = (
    "import os\n\n"
    "def do_thing(token, cmd):\n"
    '    password = "hunter2AKIAIOSFODNN7EXAMPLE"\n'
    '    print(f"using token={token}")\n'
    "    os.system(cmd)\n"
    "    unused_var = 42\n"
    "    return password\n"
)
_README_CLEAN_CODE = "def square(n):\n    return n * n\n"

# Case 3-4: real, already-committed clean functions (read from the real files, not retyped from
# memory, so these can never silently drift from what's actually in the repo).
def _read_function(path, func_name):
    tree = ast.parse((TOOLS / path).read_text(encoding="utf-8"), filename=path)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == func_name:
            return ast.get_source_segment((TOOLS / path).read_text(encoding="utf-8"), node)
    sys.exit(f"could not find def {func_name} in {path}")


# Case 5-6: adapted from hermes-code-security-scan.py's own documented DESTRUCTIVE_PATTERNS /
# credential-logging regexes (read directly from that file, not guessed) -- broadens the
# "should find something" side beyond the one canonical README example.
_PATTERN_DESTRUCTIVE_CODE = (
    "import shutil\n\n"
    "def cleanup(target_dir):\n"
    "    shutil.rmtree(target_dir)\n"
    "    return True\n"
)
_PATTERN_CREDENTIAL_LOG_CODE = (
    "import logging\n\n"
    "def authenticate(api_key, username):\n"
    "    logging.info(f\"authenticating {username} with api_key={api_key}\")\n"
    "    return True\n"
)


def build_cases():
    return [
        ("readme_vuln", _README_VULN_CODE, True),
        ("readme_clean", _README_CLEAN_CODE, False),
        ("real_clean_pkg_version", _read_function("hermes_benchmark_common.py", "_pkg_version"), False),
        ("real_clean_check_facts", _read_function("hermes-log-analyst-eval.py", "check_facts"), False),
        ("pattern_destructive_rmtree", _PATTERN_DESTRUCTIVE_CODE, True),
        ("pattern_credential_logging", _PATTERN_CREDENTIAL_LOG_CODE, True),
    ]


# ── deterministic recall/precision check over the model's prose review ─────────────────────────

_DISMISSAL_PHRASES = ("false positive", "not a real issue", "not a concern", "no real issue",
                      "non-issue", "not actually a problem", "safe to ignore")
_NEW_VULN_PHRASES = ("vulnerability", "unsafe", "exploit", "security issue", "security risk",
                     "insecure", "injection", "hardcoded secret", "backdoor")


def confirms_findings(review_text):
    """True if the review does NOT blanket-dismiss the findings it was given -- used only for
    has_findings=True cases (recall)."""
    lowered = review_text.lower()
    return not any(p in lowered for p in _DISMISSAL_PHRASES)


def invents_new_vuln(review_text):
    """True if the review claims a new vulnerability/unsafe pattern -- used only for
    has_findings=False cases (precision: a clean case should get none of this language)."""
    lowered = review_text.lower()
    return any(p in lowered for p in _NEW_VULN_PHRASES)


def call_backend(endpoint, model, system_prompt, user_content, max_tokens=2000, timeout=180):
    body = json.dumps({"model": model, "max_tokens": max_tokens, "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]}).encode()
    req = urllib.request.Request(f"{endpoint.rstrip('/')}/chat/completions", data=body,
                                  method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    return data["choices"][0]["message"]["content"].strip()


def main():
    ap = argparse.ArgumentParser(description="S39 fleet_dualcoder_precision: score a coder "
                                              "role's review agreement with the real scanner")
    ap.add_argument("--endpoint", required=True, help="the coder role's own backend URL (S8.1)")
    ap.add_argument("--model-id", default="coder (live)")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--json", help="write per-case rows here")
    args = ap.parse_args()

    prompt = load_security_system_prompt()
    codesec = load_codesec()
    cases = build_cases()[:args.limit] if args.limit else build_cases()
    log(f"{len(cases)} cases against {args.endpoint}")

    rows = []
    for case_id, code, expected_has_findings in cases:
        findings = codesec.scan_code(code)
        findings_text = codesec.render_findings(findings)
        real_count = sum(len(v) for k, v in findings.items() if k != "tool_errors")
        has_findings = real_count > 0
        if has_findings != expected_has_findings:
            log(f"[{case_id}] WARNING: scanner found {real_count} issue(s), expected "
                f"has_findings={expected_has_findings} -- likely the codesec venv's bandit/ruff/"
                f"detect-secrets are unavailable here, degrading some categories to tool_errors; "
                f"scoring against what the scanner ACTUALLY returned, not the expectation")

        content = f"Function:\n{code}\n\nStatic analysis findings:\n{findings_text}"
        try:
            review = call_backend(args.endpoint, "coder", prompt, content)
        except (urllib.error.URLError, OSError, KeyError, IndexError) as exc:
            log(f"[{case_id}] call failed: {exc}")
            rows.append({"case": case_id, "has_findings": has_findings, "verdict": "error",
                         "error": str(exc)})
            continue

        if has_findings:
            correct = confirms_findings(review)
            axis = "recall"
        else:
            correct = not invents_new_vuln(review)
            axis = "precision"
        rows.append({"case": case_id, "has_findings": has_findings, "axis": axis,
                     "correct": correct, "review": review, "findings_text": findings_text})
        log(f"[{case_id:<28}] has_findings={has_findings!s:5} axis={axis:<9} correct={correct}")

    scored_rows = [r for r in rows if r.get("axis")]
    recall_rows = [r for r in rows if r.get("axis") == "recall"]
    precision_rows = [r for r in rows if r.get("axis") == "precision"]
    recall = (sum(1 for r in recall_rows if r["correct"]) / len(recall_rows)) if recall_rows else None
    precision = (sum(1 for r in precision_rows if r["correct"]) / len(precision_rows)) if precision_rows else None
    overall = (sum(1 for r in scored_rows if r["correct"]) / len(scored_rows)) if scored_rows else None

    print("\n=== fleet_dualcoder_precision ===")
    if recall is not None:
        print(f"  recall:    {sum(1 for r in recall_rows if r['correct'])}/{len(recall_rows)} = {recall:.3f}")
    if precision is not None:
        print(f"  precision: {sum(1 for r in precision_rows if r['correct'])}/{len(precision_rows)} = {precision:.3f}")
    if overall is not None:
        print(f"  overall:   {sum(1 for r in scored_rows if r['correct'])}/{len(scored_rows)} = {overall:.3f}")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        log(f"per-case rows written to {args.json}")

    # fleet_dualcoder_precision (bare, overall) is the name ALL_SUITES/the comparison table
    # already carry (FLEET_BENCHMARK_DESIGN.md S7); _recall/_precision are additional
    # unregistered sub-keys, same pattern as fleet_muse_contract's per-family breakdown keys.
    suites = {}
    if recall is not None:
        suites["fleet_dualcoder_precision_recall"] = {"metric": "recall", "value": recall,
                                                        "limit": len(recall_rows)}
    if precision is not None:
        suites["fleet_dualcoder_precision_precision"] = {"metric": "precision", "value": precision,
                                                           "limit": len(precision_rows)}
    if overall is not None:
        suites["fleet_dualcoder_precision"] = {"metric": "accuracy", "value": overall,
                                                "limit": len(scored_rows)}
    if suites:
        try:
            bc.append_entry({
                "date": datetime.now(timezone.utc).isoformat(),
                "lm_eval_version": None, "bfcl_version": None, "swebench_version": None,
                "model_id": args.model_id, "role_or_endpoint": "coder", "endpoint": args.endpoint,
                "bfcl_model_name": None, "notes": "",
                "suites": suites,
            })
        except Exception as exc:
            log(f"shared history write failed (the report above is unaffected): {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
