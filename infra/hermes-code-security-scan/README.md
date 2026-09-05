# hermes-code-security-scan — recreate checklist

**Version:** 1.0.0

Deterministic static-analysis pass for a single Python function/snippet, built so
`tools/hermes-dualcoder.py`'s security-review phase gets real, consistent findings to reason about
instead of a free-form review invented from a blank page every run. See
`tools/hermes-code-security-scan.py`'s own header for the full design rationale and the five
finding categories (bandit, unused variables via ruff, secrets via detect-secrets, plus two new
heuristic checks: unauthenticated destructive actions, credential-shaped variables in logging).

**Not `infra/hermes-security-scan/`** — that's an unrelated nmap/whois network-recon tool. Confirmed
by reading it before naming this one, not assumed from the similar name.

**Static only, never executes the candidate code** — same policy `tools/hermes-code.py` already
established for the LLM side of this fleet, extended to the static tooling. This checklist installs
three read-only analyzers into their own venv; nothing here runs generated code.

## 1. Install the venv

```bash
sudo mkdir -p /opt/hermes/venvs
sudo python3 -m venv /opt/hermes/venvs/codesec
sudo /opt/hermes/venvs/codesec/bin/pip install bandit ruff detect-secrets
sudo chown -R pmoney:pmoney /opt/hermes/venvs/codesec
```

**Confirm each tool's real CLI shape before trusting it** — `tools/hermes-code-security-scan.py`
was written against each tool's well-known, documented stable-release flags (`bandit -f json -q`,
`ruff check --select F --output-format json`, `detect-secrets scan`), but this fleet's own standing
rule is verify against a live run, not the last thing documented:

```bash
/opt/hermes/venvs/codesec/bin/bandit --help | grep -A1 '\-f '
/opt/hermes/venvs/codesec/bin/ruff check --help | grep output-format
/opt/hermes/venvs/codesec/bin/detect-secrets scan --help
```

If any flag has drifted on the installed version, update the corresponding `run_*()` function in
`tools/hermes-code-security-scan.py` to match — don't leave the checklist and the code
disagreeing.

## 2. Verify — real vulnerable snippet, not a smoke test

```bash
cat > /tmp/vuln-test.py <<'EOF'
import os

def do_thing(token, cmd):
    password = "hunter2AKIAIOSFODNN7EXAMPLE"
    print(f"using token={token}")
    os.system(cmd)
    unused_var = 42
    return password
EOF

/opt/hermes/venvs/codesec/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-code-security-scan.py --file /tmp/vuln-test.py
```

Confirm **all five categories fire** on this one file:
- `bandit`: hardcoded password (B105/B106) and `os.system` usage (B605/B607)
- `unused_vars`: `unused_var` (ruff `F841`)
- `secrets`: the AWS-key-shaped string
- `destructive_actions`: `os.system(` with no auth hint present
- `credential_logging`: `token` passed to `print(...)`

A category that never fires on an example built specifically to trigger it is a real bug in this
tool, not a clean result — don't skip this check.

Then confirm a genuinely clean function produces the "no issues" message:
```bash
echo 'def square(n):
    return n * n' | /opt/hermes/venvs/codesec/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-code-security-scan.py --stdin
```

## 3. Verify inside the real pipeline

Once `hermes-dualcoder.py` 1.1.0+ is deployed and `CODESEC_VENV` resolves correctly from wherever
it runs, submit one real task (same recipe as `infra/hermes-dualcoder/README.md` §2) and confirm
via `GET /turns?task_id=...` that a `static-scan` phase turn appears before the two
`security-review` turns, and that the security-review text visibly engages with specific findings
(line numbers, categories) rather than reading like a generic review — that's the actual
"consistency" property this whole capability exists to deliver.

## Known gaps, not attempted here

- **`git` must be on `PATH`** — `run_detect_secrets()` builds a disposable git repo (`git init` +
  `git add`, no commit) around a copy of the file, because `detect-secrets scan <path>` only scans
  git-tracked files and silently returns zero results for anything else, `--all-files` included.
  This was a real bug caught during live verification (v1.0.0 silently found zero secrets on
  every real run) — see the tool's own 1.0.1 changelog entry.
- **No dependency/CVE scanning** (`pip-audit`) — needs a real project with pinned versions against
  a vulnerability database; a bare function string has neither. A natural extension if this tool is
  ever pointed at whole files/repos instead of one generated function.
- The two heuristic checks (`destructive_actions`, `credential_logging`) are real-code-pattern
  regexes, not AST-based — they can miss obfuscated calls (`getattr(os, "system")(...)`) or
  false-positive on comments/strings containing matching text. Framed in the LLM prompt as
  "verify, don't trust blindly" for exactly this reason.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-09-05 | Fixed a real bug found in live verification: `detect-secrets` was silently finding zero secrets on every run because it only scans git-tracked files. `run_detect_secrets()` now scans inside a disposable throwaway git repo. Also added `--no-verify` to stop it making a live network call to check credential validity. |
| 1.0.0 | 2026-09-05 | Initial version — direct operator request for a comprehensive, consistent security-review capability for `coder`/`coder2`. |
