# hermes-self-repair — the full stepped plan, Steps 0–8

**Version:** 6.2.0

All nine steps of the self-repair coding plan (Steps 0–8 discussed 2026-09-18) now exist. Step 0 — the
NAS2-tracking checkout `HermesAgentV5-selfrepair` with `origin`=GitHub and
`nas2-selfrepair`=NAS2's native git server — already done. Per this project's own "documentation
rot" lesson, this README describes only what exists right now, not the pipeline this is part of:
**nothing here is deployed or wired to the dispatcher yet.**

## What this is

`tools/hermes-self-repair-read.py` reads files out of the dedicated NAS2-tracking checkout
(`SELF_REPAIR_REPO_DIR`, default `~/HermesAgentV5-selfrepair`) — never a live node's own autopull
working tree, never the operator's own dev checkout. Two operations, both read-only, no shell:

```bash
python3 tools/hermes-self-repair-read.py read tools/hermes-code.py
python3 tools/hermes-self-repair-read.py grep "def ask_coder" tools
```

Every path is checked against `allowlist.json` in this directory before anything is read:
directory allowlist (`allowed_prefixes`) plus a filename denylist (`deny_patterns`) that applies
even inside an allowed directory. Both checks, and the path-traversal/symlink-escape guard ahead of
them, live in `tools/hermes-self-repair-read.py`'s own header — read that first, not this file, for
the actual security reasoning.

## Why the allowlist lives here, not in the target checkout

`allowlist.json` sits in the tool's own installation (this repo, deployed the normal way via
GitHub → autopull), not inside `HermesAgentV5-selfrepair`, the checkout it governs. If it lived
inside the target checkout instead, a self-repair task could — via a bad or malicious patch —
widen its own future read access by editing the very file that constrains it. That's the same
self-modifying-privilege hole this project's "no LLM turn load-bearing for a privileged action"
rule (the render broker, `hermes-remediate-worker.py`'s allowlist) already exists to prevent
elsewhere; this is that rule applied to a new surface, not a new rule.

## Current scope

`allowed_prefixes`: `tools`, `skills`, `agents`, `services` — starts narrow on purpose. `infra/` is
deliberately excluded for now: several `infra/*/README.md` and `.env.template` files have held real
config, and NAS2's own `smtp.env.template` once held a live SMTP password despite its
template-looking name (`LESSONS_LEARNED.md`). Widen `allowed_prefixes` only when a real,
specific self-repair task actually needs a path outside these four — not speculatively.

## Verify

```bash
# Allowed, should print the file:
python3 tools/hermes-self-repair-read.py read tools/hermes-code.py

# Not under an allowed prefix, should refuse (exit 2):
python3 tools/hermes-self-repair-read.py read IMPLEMENTATION_PLAN.md

# Denied by filename pattern even though the directory would otherwise be allowed (exit 2):
python3 tools/hermes-self-repair-read.py read tools/vault-get-secret.sh   # matches *secret* only
                                                                            # if such a file exists;
                                                                            # otherwise substitute
                                                                            # any *.env/*secret*/
                                                                            # *vault* path under an
                                                                            # allowed prefix

# Path traversal, should refuse (exit 2):
python3 tools/hermes-self-repair-read.py read ../../etc/passwd

# grep, scoped the same way:
python3 tools/hermes-self-repair-read.py grep "class.*Guard" tools
```

## Step 2: fix-generation engine

`tools/hermes-self-repair-generate.py` owns a new Buzz `selfrepair` topic. It is built directly on
`hermes-dualcoder.py`'s claim/screen/log_round skeleton and its
draft → review-round-N → [revise →] converge → security-review → security-meta-review →
judge-escalate state machine — see that file for the shape this one repeats.

Task spec (the topic's raw text) is JSON: `{"path": "<repo-relative path>", "problem": "<what's
wrong>"}`. Three deliberate differences from `hermes-dualcoder.py`, each explained in this file's
own header comment:

1. **`path` is never opened directly.** It only ever passes through
   `tools/hermes-self-repair-read.py` as a subprocess call — this engine has no filesystem access
   of its own into `SELF_REPAIR_REPO_DIR`. A denied or out-of-scope path surfaces as an honest
   `error` result, not a fabricated fix.
2. **The model produces full corrected file content, never a diff.** A unified diff is computed
   exactly once, deterministically (`difflib`), only after convergence — never authored by a
   model. Asking an open-weight model to emit a syntactically correct unified diff directly (right
   line numbers, right context) was considered and rejected as an unreliable-structured-output
   risk; a mechanical diff of two known strings has no such failure mode.
3. **`MAX_FILE_CHARS` (default 12000) is a hard, honest scope limit.** A file over the limit is
   refused with a clear `error`, not attempted and silently truncated. Whole-file regeneration
   doesn't scale arbitrarily; a hunk-level editing design is future scope, not this step's.

This process **applies nothing** — it never writes into `SELF_REPAIR_REPO_DIR`, never runs
`git apply`. On convergence with a non-empty diff, it logs the diff as its own structured turn
(`phase="diff"`) and submits a `selfrepair-apply` broker job (`{"task_id": ...}`, job id = task_id
for natural dedup) — a deterministic hand-off, not an application. Step 3 does the rest.

### Verified so far (this machine, no live fleet)

Every pure/deterministic piece was run directly, not just inspected: `parse_task_spec` (valid spec,
malformed JSON, missing field), `read_target_file` against the *real* `HermesAgentV5-selfrepair`
checkout through the *real* Step 1 tool (one allowed path, one denied-by-pattern, one
denied-by-prefix — all three refused/succeeded correctly), `compute_diff` (a real hunk, and the
identical-content/empty-diff edge case), and both bundle builders.

**Not yet verified — needs the real fleet, not this machine:** `claim_next`/Buzz subscription, the
Layer 1/2 screen against a live guard service, `call_model` against real `coder`/`coder2` backends,
a full `run_bug_loop` end-to-end round trip, `publish_result` against live `hermes-memory`. No
systemd deploy has happened — `infra/hermes-self-repair/hermes-self-repair-generate.service` and
`tools/hermes-self-repair-generate-wrapper.sh` exist but are untested on a real node.

`DRAFT_MAX_TOKENS`/`MAX_FILE_CHARS` are explicitly unverified placeholders (see the script's own
header) — expect to retune both against a real target file and this fleet's actual coder/coder2
behavior, the same way `hermes-dualcoder.py`'s own budgets went through three real revisions
(1.0.1–1.0.3) after its first live run.

## Step 3: apply worker

`tools/hermes-self-repair-apply.py` claims `selfrepair-apply` broker jobs. It makes **no model
calls** — same "no LLM turn, and no general-purpose process, is ever load-bearing for a mechanical/
privileged action" split `hermes-remediate-worker.py` already established for service restarts.

The job payload is deliberately just `{"task_id": ...}` — everything else is re-derived fresh from
hermes-memory, never trusted from the payload:

1. `GET /tasks/{task_id}` — refuses (no retry) unless `state == "done"`.
2. `GET /turns` — reads the exact diff text back from Step 2's `phase="diff"` turn.
3. The diff's own `+++ b/<path>` header line is the source of truth for the target path, checked
   **again** against `allowlist.json` (imported from `tools/hermes-self-repair-read.py`, the same
   allow/deny logic Step 1 and Step 2 already use) — defense in depth against a stale or tampered
   turn record.

An empty diff is a clean no-op success, not an error. `git apply --check` runs before the real
`git apply`, so a conflict is caught cleanly. On success: commit, then
`git push $GIT_REMOTE $GIT_BRANCH` — **`GIT_REMOTE` defaults to `nas2-selfrepair` and the script
refuses to start if it's ever set to `origin`.** No GitHub-credential-shaped secret is fetched
anywhere in `tools/hermes-self-repair-apply-wrapper.sh`, by design — that boundary is enforced by
absence, not by a check. Failures use `hermes-remediate-worker.py`'s exact
attempt-counter/circuit-breaker/FleetOps+email escalation shape, keyed by `task_id`.

**Confirmed operational property, worth knowing before relying on this**: once a task's attempt
counter reaches `MAX_ATTEMPTS`, `do_apply()` is **never called again for it, ever** — not a bug,
the same intentional design `hermes-remediate-worker.py`'s own `do_restart_service()` already has
("stays escalated ... until a human resets it by deleting the state file"). This means a purely
*transient* failure (a momentary NAS2 network blip during push, say) that would have succeeded on
attempt 4 instead **permanently sticks the task** — every subsequent job for it re-escalates
(FleetOps + email, every time) but never actually retries. Recovery requires a human to delete
`~/.hermes/state/selfrepair-apply/<task_id>.json` (or call `clear_attempts()` some other way)
before it will be attempted again. Confirmed live in this session's own hardening pass, not assumed
from reading the code alone.

### Verified so far (this machine, no live fleet)

`parse_diff_path` (well-formed diff, garbage input) and all five of `do_apply`'s gating branches
were run directly against mocked `fetch_task`/`fetch_diff_text` (wrong state, missing diff turn,
empty diff, denied-by-pattern path, denied-by-prefix path) — all five behaved correctly.

**A full real end-to-end apply was also run against the actual `HermesAgentV5-selfrepair`
checkout and the actual NAS2 git server** — not mocked: a real diff was computed against
`tools/hermes-code.py`, applied via `git apply --check` + `git apply`, committed, and pushed to
`nas2-selfrepair/master` (commit `e9d540f`), then reverted with a second real apply/commit/push
(`5316f88`). `HermesAgentV5-selfrepair` now sits 2 commits ahead of `origin/master`, both present
on `nas2-selfrepair/master` and absent from GitHub — confirmed with
`git log origin/master..nas2-selfrepair/master`. This is the "compare separately" capability from
the original NAS2 proposal, demonstrated working, not just described.

**Not yet verified — needs the real fleet:** the broker `claim`/`report` cycle end-to-end, a real
`selfrepair-apply` job actually submitted by Step 2 and picked up by this worker, and the
escalation path (FleetOps notice + email) on a real repeated failure. No systemd deploy has
happened — `infra/hermes-self-repair/hermes-self-repair-apply.service` and its wrapper exist but
are untested on a real node.

## Step 4: verification (two gates, both deterministic, no model call)

**Pre-promotion** (`tools/hermes-self-repair-verify.py`) is wired directly into Step 3's
`do_apply()`: immediately after a successful apply+commit+push, it verifies the file as it
actually landed on disk — not the candidate string from hermes-memory, so a pass is proof about
what was really committed. Two checks:

1. **Syntax** — `.py` via `py_compile`, `.sh` via `bash -n`. Any other extension is honestly
   reported as "no checker for this file type," never silently skipped or assumed clean. A syntax
   failure alone is an unconditional overall FAIL.
2. **Static analysis** (`.py` only) — reuses `tools/hermes-code-security-scan.py`'s `scan_code()`
   exactly. Only two finding categories block automatically: any hardcoded-secret finding
   (detect-secrets, always "critical"), or a "high"-severity bandit finding. Every other category
   (unused vars, the two heuristics, low/medium bandit) is reported but does not block — that
   tool's own docstring frames those as needing human/LLM judgment, not a hard veto. Fails OPEN
   (passes, with a clear note) if bandit/ruff/detect-secrets are all unavailable, same posture
   `hermes-dualcoder.py`'s own static-scan phase already uses.

The outcome becomes the task's own hermes-memory state — `verified` on a pass, `verify-failed` on
a fail (with a FleetOps+email escalation, `hermes-remediate-worker.py`'s exact `escalate()` shape).
**A failed verification does NOT revert the commit** — it stays on NAS2, visible and inspectable
(the whole point of the original NAS2 proposal), simply not eligible for a future Step 5 promotion
offer, which will require `state == "verified"` before ever proposing anything to GitHub. The
broker job itself still reports success once the mechanical apply succeeds — "did the git
operation work" and "is this fix trustworthy enough to promote" are tracked as two separate
concerns, not conflated into one exit code.

**Post-promotion** (`tools/hermes-self-repair-verify-live.py`, `check-service <unit>`) polls
`systemctl is-active`, same shape as `hermes-remediate-worker.py`'s own `do_restart_service()`.
**Not wired to anything** — Step 5 (the thing that would trigger a post-promotion check, after a
real GitHub push and autopull cycle) doesn't exist yet. Built now so Step 5 has a ready-made gate
rather than needing to invent one later, and because the self-repair task spec has no field naming
an associated service yet, this stays a generic, standalone check pending that.

### Verified so far (this machine, no live fleet)

`hermes-self-repair-verify.py` was run directly against real files: valid and deliberately-broken
Python (syntax check correctly passes/fails), valid and deliberately-broken shell (same), an
unknown extension (honest "not checked" note), and the fail-open static-analysis path (this
machine has no `CODESEC_VENV`, exactly the condition that path exists for) — plus confirmed the
destructive-action heuristic still fires via pure regex even with the external scanners absent.

**A full real end-to-end run of Step 3 + Step 4 together, both outcomes:** a genuine valid fix to
`tools/hermes-code.py` went through the complete `do_apply()` pipeline — real `git apply` → commit
→ push to `nas2-selfrepair` → real `verify()` → `state = "verified"`, no escalation. Separately, a
deliberately syntax-broken fix went through the same real pipeline — git applied and committed it
without complaint (git doesn't parse Python), then `verify()` correctly caught the real
`SyntaxError` and set `state = "verify-failed"` with a real escalation call. Both runs were
reverted with a second real apply afterward; the checkout is clean.

`tools/hermes-self-repair-verify-live.py` is **untestable from this machine** — `systemctl` only
exists on a real systemd host. Its logic mirrors `do_restart_service()`'s already-proven poll
shape closely, but has not been run once, here or on the fleet.

## Step 5: promotion gate (the human chokepoint)

Two components, split deliberately so approval and execution can never be the same act:

**`tools/hermes-self-repair-promote-gate.py`** — a long-running poll loop, no model call, no
GitHub credential. `hermes-self-repair-apply.py` (1.2.0) posts a one-shot FleetOps notice the
moment a task becomes `verified`, naming the task and inviting a `"promote <id>"`/`"skip <id>"`
reply — but does NOT wait for it (it's a broker-job worker, must never block on a human reply that
could take hours). This gate is the separate process that actually watches for and parses that
reply, on its own cadence. The command grammar is strict — the entire message body must be exactly
`promote <id>` or `skip <id>`, so this script's own much-longer reply text can never
self-trigger. Every command re-fetches the named task's real state from hermes-memory before
acting — a chat message naming a task is never trusted on its own; only a task still in state
`verified` can be promoted or skipped. `"promote <id>"` sets `state = "promotion-approved"` and
replies with the exact command a human should run **by hand** to finish it; `"skip <id>"` sets
`state = "promotion-declined"` — the commit stays on NAS2 either way, nothing is ever reverted by
a skip.

**`tools/hermes-self-repair-promote.py`** — the one component in this entire pipeline that ever
touches GitHub, and only because a human runs it directly (`python3 hermes-self-repair-promote.py
<task_id>`). It fetches no credential from anywhere — it uses exactly whatever `git push` can
already do in whatever checkout it's run from. It refuses unless the task is in state
`promotion-approved` (set only by the gate above, only after a chat command), fetches the task's
own `phase="applied-commit"` sha (never re-derives it by guessing — other self-repair commits may
have landed on NAS2 since), fetches both `origin` and `nas2-selfrepair`, creates a disposable
branch off `origin/master`, and cherry-picks **only that one commit** onto it — never a merge,
never every commit sitting on NAS2. A clean cherry-pick gets a normal, non-force push; a conflict
gets `git cherry-pick --abort` and a refusal, never a forced or partial push. On success it records
`state = "promoted"` plus the new commit's real sha.

**Why two steps instead of one:** approval (the chat command) can happen from anywhere, at any
time. Execution (running the script) requires a human to deliberately be at a machine that already
has real GitHub push rights — a second, physical gate the chat command alone can't provide. This is
the stepped plan's own "ideally a human running git push by hand" preference, made literal rather
than automated away.

### Verified so far (this machine, no live fleet)

`COMMAND_RE` and `handle_command()`'s four branches (approve, decline, task-not-verified,
missing-sha) were run directly against a mocked hermes-memory/Matrix — all correct, including
confirming the gate's own reply text can never re-match as a new command.

**The full git mechanics of promotion were run for real** — with the real GitHub `origin` replaced
by a genuinely separate, throwaway local bare repository seeded from `origin/master` (a read-only
`git fetch`, zero risk), so the cherry-pick base was realistic without any possibility of writing
to the real GitHub repo. Two real scenarios: (1) a clean fix cherry-picked and pushed successfully,
task marked `promoted`, disposable branch cleaned up; (2) a genuine cherry-pick **conflict** (two
commits editing the same line, simulating "origin moved before promotion happened") — aborted
cleanly, nothing pushed, task state left untouched, no leftover branch. Every real commit this
testing made on the actual `nas2-selfrepair` remote was reverted afterward with an honest record,
same discipline as every prior step's testing.

**Not yet verified — needs the real fleet:** the actual FleetOps message round-trip (posting an
offer, a human really replying, this script really parsing that live reply), and a real promotion
against the real GitHub `origin` (deliberately never attempted from this development machine —
that action is reserved for a human, deliberately, the first time for real too).

## Steps 6–8: autopull, tracing, and the routing boundary

**Step 6 (autopull picks up a promoted commit) needed no new code.** `hermes-repo-autopull.timer`
already pulls `origin/master` on all three real nodes every 30 minutes and restarts whichever
node's services moved (`hermes-repo-sync.sh` 3.0.0) — a promoted self-repair commit is just another
commit to it, no self-repair-specific awareness required or added. Confirmed by reading that
script, not assumed: it identifies itself by `hostname` (spark/spark-2/HomeD13) and does nothing
special for any other checkout, so `HermesAgentV5-selfrepair` sitting on a non-fleet host is simply
invisible to it — there was no risk of it ever autopulling the staging checkout itself.

**Step 7 (tracing/comparison) needed a tool, not new infrastructure.** Every phase across every
step already writes a structured turn (Step 2's `log_round()`, Step 3/5's phase-tagged turns) —
that was true before this step. What was missing was a human-readable way to read it back instead
of a raw `curl .../turns?task_id=...`. `tools/hermes-self-repair-status.py` fills that gap:

- `<task_id>` — the full phase-by-phase timeline for one task (draft, each review round, revisions,
  static-scan, both security reviews and cross-checks, the diff, the applied commit, the
  pre-promotion verification, the eventual promoted commit — whichever actually exist), ordered by
  the pipeline's real sequence, not turn-arrival order.
- `--repo-diff` — literally `git log origin/master..nas2-selfrepair/master`, the exact "compare
  separately" capability the original NAS2 proposal asked for. Run for real against this
  session's own accumulated test history, it correctly lists every test commit from Steps 3–5 — a
  real, live demonstration that self-repair activity is visible on NAS2 and absent from GitHub.

**Step 8 (keep this off the interactive path) is enforced by omission, checked explicitly.**
`hermes-dispatch.py`'s `VALID_TARGETS` was read directly (not assumed) and does not, and should
not, contain `selfrepair`. The actual "operator command" trigger the plan calls for is
`tools/hermes-self-repair-submit.py` — a standalone CLI a human runs directly
(`python3 hermes-self-repair-submit.py <path> "<problem>"`), writing the task spec to hermes-memory
and publishing the same pointer-envelope shape (`task_id`/`memory_ref` only, never inline content)
every other specialist's ingress already uses. It is never reachable from chat, and adding it to
`hermes-dispatch.py`'s routing table would be a real, separate design decision — not something to
fold in here.

### Verified so far (this machine, no live fleet)

`hermes-self-repair-submit.py`'s payload construction (`build_task`) and its exact two-call
sequence (one `turns` POST, one `messages` POST, pointer-only) were confirmed against a mocked
Buzz/hermes-memory — the real network calls were never made from here, matching the "submission
requires the real fleet" boundary every other step's generation-side testing has had.

`hermes-self-repair-status.py`'s rendering and sort-by-pipeline-order logic were run against
synthetic turns, including a deliberately malformed one (confirmed to render as
`[unparseable turn]`, never crash the whole listing). `--repo-diff` was run for real, live, against
this session's own accumulated test commits — the output above is genuine, not illustrative.

## Known gaps, not yet closed

- `fetch_applied_sha`/`fetch_diff_text` (in `hermes-self-repair-apply.py`, `-promote-gate.py`, and
  `-promote.py`) all take the FIRST matching turn from `/turns?task_id=...` and assume that's the
  oldest/correct one. This is fine for the normal case (each phase's turn is logged exactly once
  per task) but rests on an unverified assumption about hermes-memory's own ordering guarantee for
  that endpoint — never confirmed against a live server from this machine. Only matters if a task
  were ever somehow reprocessed and logged a second `applied-commit`/`diff` turn; worth confirming
  hermes-memory's real ordering before trusting this in that edge case.
- `grep`'s file walk is a plain `rglob` — fine at this repo's current size, not evaluated against a
  much larger tree.
- No decode-time constraint on anything — deliberately unneeded now that the model never authors
  the diff directly (see Step 2 above); would only become relevant again if a future step asks a
  model for structured output some other way.
- `hermes-self-repair-verify.py`'s static-analysis re-scan has never actually run against real
  bandit/ruff/detect-secrets — only its fail-open path (no venv) has been exercised. Confirm the
  real high-severity/secrets-detection branches on a fleet node with `CODESEC_VENV` present before
  trusting them.
- `hermes-self-repair-verify-live.py` (post-promotion) still has no caller — nothing in Step 5
  invokes it after a real promotion. It could be added as a follow-up step a human runs by hand
  after promoting, or wired into a future automated post-promotion check; neither exists yet.
- The promote-gate's FleetOps round-trip and a real GitHub promotion are both unverified against
  live infrastructure — deliberately, in the second case (see above).
- An "already applied" empty cherry-pick (the fix somehow already exists on `origin`) is correctly
  *diagnosed* separately from a real content conflict (fixed and confirmed live, see Revision
  History) but is still a hard failure requiring human investigation either way, never
  auto-skipped as a success — a conservative default worth revisiting if it turns out to be a
  common, benign case in practice.
- `hermes-self-repair-status.py`'s `<task_id>` mode is unverified against a real hermes-memory —
  only synthetic turns have exercised its rendering/sorting logic.
- Nothing in this pipeline has been deployed to a real node yet. Every systemd unit and wrapper
  exists on disk, none have been installed or started. The entire pipeline exists as reviewed,
  individually-tested code — not as a running system.

## Revision History

| Version | Date | Change |
|---|---|---|
| 6.2.0 | 2026-09-19 | Security-relevant fix found during hardening self-review, not live traffic: `tools/hermes-self-repair-apply.py`'s (1.3.0) `parse_diff_path()` used `re.search()`, returning only the first `+++ b/<path>` match in a diff — a diff with more than one such header (a multi-file diff, never produced by the legitimate pipeline but exactly the "tampered turn record" threat this file already defends against elsewhere) would have had only its first path allowlist-checked while `git apply` still wrote every hunk in the diff, including files never checked at all. Fixed to `findall()` and refuse anything but exactly one match; verified with a constructed two-file diff (one allowed path, one targeting `infra/vaultwarden/.env`) confirming it is now refused outright rather than silently narrowed to the allowed-looking first file. Full Step 3/4 regression suite re-run clean afterward. |
| 6.1.0 | 2026-09-19 | Hardening pass, no deployment: `tools/hermes-self-repair-promote.py` (1.1.0) now diagnoses an empty/"already applied" cherry-pick separately from a real content conflict — a real distinction found live during Step 5's own testing that the original code lumped together. `hermes-self-repair-apply.py`'s circuit breaker was run through 5 consecutive real failures, a real reset, and independent-task-counter checks — confirmed a genuine, non-obvious operational property along the way: once a task hits `MAX_ATTEMPTS`, `do_apply()` is never called again for it, ever, even for a purely transient failure — recovery requires a human to delete its state file. Not a bug (matches `hermes-remediate-worker.py`'s own intentional design), but now explicitly documented rather than merely inheritable-by-reading-code. |
| 6.0.0 | 2026-09-18 | Steps 6–8: `tools/hermes-self-repair-submit.py` (the deliberate operator-run submission entry point — this IS Step 8, kept fully separate from `hermes-dispatch.py`) and `tools/hermes-self-repair-status.py` (Step 7's tracing/comparison, `<task_id>` timeline view + `--repo-diff`). Step 6 required no new code — confirmed by reading `hermes-repo-sync.sh` directly. `--repo-diff` run for real against this session's own accumulated test history. All nine steps (0–8) of the stepped plan now exist as reviewed, tested code; none deployed to a live node. |
| 5.0.0 | 2026-09-18 | Step 5: `tools/hermes-self-repair-promote-gate.py` (FleetOps confirmation watcher, no GitHub credential) and `tools/hermes-self-repair-promote.py` (the one manually-run component that ever touches GitHub, via a scoped cherry-pick). Step 3 bumped to 1.2.0 to log the applied-commit sha and post the promotion offer. Verified with real cherry-pick+push and a real cherry-pick conflict, both against a throwaway local stand-in for `origin` — the real GitHub repo was never touched. |
| 4.0.0 | 2026-09-18 | Step 4: `tools/hermes-self-repair-verify.py` (pre-promotion syntax + static-analysis gate, wired into Step 3's `do_apply()`) and `tools/hermes-self-repair-verify-live.py` (post-promotion service health-check, not yet wired — Step 5 doesn't exist). Step 3 bumped to 1.1.0. Verified with real apply+verify runs for both the passing and failing outcome, not just mocked. |
| 3.0.0 | 2026-09-18 | Step 3: `tools/hermes-self-repair-apply.py` (non-LLM apply worker, `selfrepair-apply` broker job), its wrapper and systemd unit. Step 2 (1.1.0) now logs the diff as a structured turn and hands off to this worker on convergence. Verified with a real apply+commit+push to NAS2 and its revert, not just mocked. |
| 2.0.0 | 2026-09-18 | Step 2: `tools/hermes-self-repair-generate.py` (fix-generation engine, new `selfrepair` Buzz topic), its wrapper and systemd unit. Not yet deployed or wired to the dispatcher. |
| 1.0.1 | 2026-09-18 | Real bug found live running this README's own verify block: `grep` on a single denied file silently widened its search to that file's parent directory instead of refusing. See `tools/hermes-self-repair-read.py`'s own changelog for the fix. |
| 1.0.0 | 2026-09-18 | Initial version — Step 1 of the self-repair stepped plan: scoped, read-only, allowlisted file access, no consumer yet. |
