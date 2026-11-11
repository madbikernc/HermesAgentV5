# hermes-self-repair — the full stepped plan, Steps 0–8

**Version:** 6.12.0

All nine steps of the self-repair coding plan (Steps 0–8 discussed 2026-09-18) now exist. Step 0 — the
NAS2-tracking checkout `HermesAgentV5-selfrepair` with `origin`=GitHub and
`nas2-selfrepair`=NAS2's native git server — already done. **Steps 2, 3, and 5
(`hermes-self-repair-generate.py`, `-apply.py`, `-promote-gate.py`) are deployed and enabled on
spark** — confirmed live 2026-11-07: all three running continuously since 2026-10-26 (`systemctl
status` and `ps` against their real PIDs, not just unit files sitting on disk), with Buzz/memory/
guard all reachable over the LAN IP and `coder2` active. **Deployed is not the same as exercised**:
no real task has ever been submitted to this pipeline — `nas2-selfrepair/master` still ends at the
Step 0/1 dev-testing commits from 2026-09-19, and the journal for all three services is empty
because none has ever claimed a task. Step 8's own boundary (never wired to `hermes-dispatch.py`,
by design) is unaffected by this — "deployed as a standalone service" and "reachable from chat" are
different things, and only the first is now true.

**Second update, same day: fed two real tasks, both against `tools/hermes-benchmark-compare.py`,
and the full generate → apply → verify cycle now genuinely works end to end.** Two real,
previously-undiscovered bugs surfaced and were fixed along the way, both confirmed live, not
assumed: (1) `hermes-self-repair-generate-wrapper.sh` never fetched `BROKER_TOKEN`, so Step 2's own
`submit_apply_job()` always failed its POST to the broker silently — fixed in that wrapper's 1.0.1;
(2) `compute_diff()` produced a patch `git apply` rejected as corrupt whenever the model's raw
completion lacked a trailing newline at EOF (routine for LLM output) while the real file had one —
a documented `difflib` limitation, not applied-for in the original code — fixed in
`hermes-self-repair-generate.py` 1.1.1 by normalizing both strings to end in exactly one newline
before diffing. The first real task (`fa2eb82b21af45b8`) hit bug 2 and correctly went `dead` after
3 attempts (the circuit breaker's intentional "escalates, never auto-retries" behavior, now
confirmed live, not just read). The second (`2e732538c2e34ebb`, same file/problem, submitted after
both fixes) converged, applied, and reached `verified` — a real commit (`92ad261`) now sits on
`nas2-selfrepair/master` ahead of `origin/master`, awaiting the operator's own `promote`/`skip`
decision. Per this project's own "documentation rot" lesson, this README describes only what
exists right now, not the pipeline this is part of.

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
3. **`MAX_FILE_CHARS` (default 40000, raised from 12000 on 2026-11-10 to fit coder/coder2's
   65536-token context) is a hard, honest scope limit.** A file over the limit is
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

**Not yet verified — needs a real task, not just a live deployment:** `claim_next`/Buzz
subscription, the Layer 1/2 screen against a live guard service, `call_model` against real
`coder`/`coder2` backends, a full `run_bug_loop` end-to-end round trip, `publish_result` against
live `hermes-memory`. **Systemd deploy is done** — `hermes-self-repair-generate.service` has been
enabled and running on spark since 2026-10-26, confirmed live 2026-11-07 — but it has sat idle the
entire time: zero tasks claimed, so every item in this list is still genuinely unverified, just no
longer blocked on a deploy that hasn't happened. **Update, same day**: now verified, for real —
see this file's top-of-document note and the 6.4.0 changelog entry below. `claim_next`/Buzz
subscription, the Layer 1/2 screen, real `coder`/`coder2` calls, and `publish_result` all ran for
real across two live tasks.

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

**Not yet verified — needs a real task:** the broker `claim`/`report` cycle end-to-end, a real
`selfrepair-apply` job actually submitted by Step 2 and picked up by this worker, and the
escalation path (FleetOps notice + email) on a real repeated failure. **Systemd deploy is done** —
`hermes-self-repair-apply.service` has been enabled and running on spark since 2026-10-26,
confirmed live 2026-11-07 — idle the whole time, same caveat as Step 2 above. **Update, same
day**: now verified, for real — see this file's top-of-document note and the 6.4.0 changelog
entry below. The broker `claim`/`report` cycle, a real `selfrepair-apply` job from Step 2, and the
escalation path (the first real task's circuit breaker correctly went `dead` after 3 attempts on a
genuinely bad diff) have all now happened for real.

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
- **Steps 2, 3, and 5 are now deployed** — `hermes-self-repair-generate.service`, `-apply.service`,
  and `-promote-gate.service` are enabled and have been running continuously on spark since
  2026-10-26 (confirmed live 2026-11-07 via `systemctl`/`ps` against their real PIDs, not just
  reading unit files). **Deployed and exercised are still different things**: no real task has ever
  been submitted to this pipeline, so every "needs the real fleet"/"needs a real task" item noted
  under each step's own `### Verified so far` section above remains genuinely open — the gap is no
  longer "not deployed," it is "deployed, idle, never fed a real task." `hermes-self-repair-promote.py`
  (Step 5's GitHub-touching half) and `hermes-self-repair-verify-live.py` (Step 4's post-promotion
  check) remain standalone scripts a human runs directly, by design — never their own systemd unit.
  **Update, same day**: the gap really is closed now, not just relabeled — see this file's
  top-of-document second update and the 6.4.0 changelog entry. Two real tasks have now run the
  full generate/apply/verify cycle; one hit a real bug and correctly escalated, the other
  converged and reached `verified` with a real commit on `nas2-selfrepair`.

## Phase 2: generic review/PR/UI pieces, no domain registered yet

`FLEET_SELFREPAIR_DESIGN.md` §8.2 — the generic pieces built with zero domains registered, on
purpose, as the real test that they are actually generic and not quietly Minecraft-shaped. Four
new pieces, all exercised against the "no domains registered" starting state:

- **Domain registry (§4.1).** `infra/hermes-self-repair/domains.json` — a flat JSON file (§6's
  registry-mechanism question, decided here: a flat file over a Python module per domain, since
  nothing registered so far needs logic a flat file can't express), read by
  `tools/hermes_self_repair_domains.py` (`load_domains()`, `domain_for_path()`). Starts with an
  empty `"domains": []`. Underscore-named, not hyphenated like every other
  `tools/hermes-self-repair-*.py` file here, because it is meant to be imported directly
  (`import hermes_self_repair_domains`) — the same reason `hermes_market_common.py` and
  `hermes_benchmark_common.py` are underscore-named.
- **Registered-PR mechanism (§4.6).** `tools/hermes-self-repair-open-pr.py <task_id>` — takes one
  `verified` task and opens it as a **draft** GitHub PR: the exact fetch-both-remotes/branch-off-
  origin/cherry-pick-one-commit mechanics `hermes-self-repair-promote.py` already uses, but
  pushing a new branch (`selfrepair/<domain-or-unregistered>/<task_id>`) and `gh pr create
  --draft` instead of merging to `origin/master`. The task's own state is untouched — opening a PR
  is a review surface, not a promotion; idempotent re-run (a `pr-opened` turn already exists)
  prints the existing PR instead of opening a second one. RUN BY HAND or by the daily review skill
  below, never by fleet infrastructure — confirmed necessary, not just stated as policy: spark's
  own `origin` deploy key is read-only (`ERROR: The key you are authenticating with has been
  marked as read only`, hit live promoting `2e732538c2e34ebb` this same session), so this script
  cannot run there either, for the same reason `-promote.py` can't.
- **Daily Claude Code review routine (§4.7).** `skills/fleet-selfrepair-review/SKILL.md` — the
  procedure: list newly-`verified` tasks without a PR yet
  (`tools/hermes-self-repair-list.py --state verified --without-pr`, a new read-only sqlite
  listing over the `tasks` table since `hermes-memory`'s own `/tasks` route is POST-only, same
  finding `infra/hermes-fleetops-ui/README.md` already made for the model-scout backlog), open
  PRs for them, review every open `selfrepair/*` PR and comment on it (`gh pr comment`, never
  `gh pr edit`, never a push), and record a ranked recommendation as a `phase="daily-review"` turn.
  **Deliberately not registered as a live cron job** — the skill's own "Not yet wired to a live
  schedule" section names exactly why (an unset daily action cap, an unresolved "what happens to a
  rejected PR" policy, and nowhere a scheduled cloud session has both real GitHub push rights and
  tailnet reach to `hermes-memory` at once). Fully usable by hand today.
- **FleetOps `/selfrepair` tab (§4.8).** `tools/hermes-fleetops-ui.py` (2.19.0) — read-only (state,
  domain, path, problem, dualcoder round count, a collapsible diff preview, any opened PR, any
  daily-review recommendation) plus exactly one write route, `/selfrepair/decide`, following the
  exact house rule `/backlog/decide` already established
  (`infra/hermes-fleetops-ui/README.md:54-68`): the transition table, task/turn writers, and
  Matrix-announce all come from `hermes-self-repair-promote-gate.py` (now 1.1.0 — extended with a
  `TRANSITIONS` table and `write_turn()` for exactly this, behavior-equivalence-tested against the
  original `handle_command()` before deploying), imported through a fail-closed
  `load_selfrepair_gate()`, never reimplemented. Checking a box and clicking "implement" does
  exactly what replying `promote <id>` in FleetOps already does — sets `promotion-approved`; it
  does not itself merge anything. Fixed a real latent gap while wiring this up: the promote gate's
  own `set_task_state()` never returned anything, so no caller — including its own chat-driven
  `handle_command()`, not just this new route — had any way to tell a successful write from a
  failed one except by reading the log line; now returns `True`/`False` like
  `hermes-model-scout-gate.py`'s own `set_task_state()` already does.

With zero domains registered, every task reads as domain `unregistered` and the tab's own note
says so plainly — the expected state until Phase 3 (§8.3) registers `minecraft-bots` as domain #1.

## Phase 3: `minecraft-bots` registered as domain #1

`FLEET_SELFREPAIR_DESIGN.md` §8.3. `infra/hermes-self-repair/domains.json` now carries one real
entry — path scope `services/minecraft-bots/` + `agents/minecraft-*/PROMPT.md`, detection source
`buzz:minecraft-ops`, completeness rule `test-artifact`, cadence `reactive`, **`self_managed:
false`** (§3's own table: off by default, a separate decision from building or registering
anything). `tools/hermes_self_repair_domains.py` bumped to 1.1.0: `domain_for_path()` gained
`fnmatch`-style glob matching (the `agents/minecraft-*/PROMPT.md` entry is a real glob, which the
1.0.0 pure-prefix matcher could never have matched) — every glob-free entry still matches exactly
as before.

**Completeness hook (§4.3) — the operator's own direct call on §6's open question**: a fix and its
required test are **two linked, ordinary, independent self-repair tasks**, not one task
regenerating two files together. Zero change to `hermes-self-repair-generate.py`'s or `-apply.py`'s
single-file draft/review/diff/commit loop, and no loosening of `-apply.py`'s own hardened refusal
of any diff touching more than one file (added in 1.3.0 after a real multi-file-diff finding) — the
alternative this design doc's §6 named and the operator declined, specifically to avoid touching
either of those. New pieces:

- `tools/hermes_self_repair_completeness.py` — `completeness_satisfied(task_id, domain)`: no
  domain, or a domain with no `completeness_rule`, is always satisfied (Step 4's existing
  syntax/static-analysis gate already covers that baseline for everyone). `"test-artifact"` (domain
  #1's instance) requires a `phase="completeness-link"` turn naming a linked task; a task whose own
  recorded role is `"test"` is never itself subject to the rule (checked by role, not by re-walking
  path_scope a second time, to avoid "does a test need its own test").
- `tools/hermes-self-repair-link.py <fix_task_id> <test_task_id>` — writes that link turn on both
  tasks. Run by hand after submitting two tasks via `hermes-self-repair-submit.py`, or called
  automatically by the new bridge below.
- `hermes-self-repair-apply.py` bumped to 1.4.0: both `set_task_state(task_id, "verified")` sites
  now go through `finalize_or_wait()`, which checks the task's domain completeness before
  finalizing — not satisfied parks it in a new `awaiting-completeness` state instead (not yet
  eligible for promotion/PR-opening; both already gate on `state=="verified"`, so this is a pure
  addition, not a behavior change for any task with no completeness rule). `unblock_linked_peer()`
  handles the one ordering that needs it: whichever of a linked pair finishes its own apply+verify
  **second** re-checks and finalizes the one that finished first and was waiting.
- `tools/hermes-self-repair-read.py` bumped to 1.1.0: added a third read-only operation, `list
  [path]` — recursive allowlisted file listing, needed by the bridge below to validate a path
  before ever trusting it.
- 22 + 7 new offline checks (`infra/hermes-self-repair/tests/test_completeness.py`,
  `test_domains.py`), covering both orderings of the linked-pair race, the unlinked/not-yet-linked/
  unknown-rule refusal paths, and the new glob matching. `infra/hermes-fleetops-ui/tests/
  test_fleetops_ui.py`'s own self-repair checks were updated to point `sr_domains.DOMAINS_FILE` at
  an isolated empty fixture — they test the zero-domains state on principle, not by accident of
  what's really registered.

**Detection bridge (§4.4)**: `tools/hermes-self-repair-minecraft-bridge.py` — polls Buzz topic
`minecraft-ops` (`infra/minecraft-bots-triage/`'s own output) for every domain whose switch is on,
dispatched by `detection_source` through a small `HANDLERS` table (one entry today,
`"buzz:minecraft-ops"`; a second domain with a differently-shaped source registers its own handler
the same way, without this file's own poll loop changing). Real gap found while building this:
triage's own `coder`/`coder2` calls are asked for severity/cause/next-step prose about a log line,
**never a file path** — `tools/hermes-minecraft-triage.py`'s own prompt has no path-naming
instruction at all. This bridge is what actually names one: a model call (reusing `ROUTER_URL`,
`X-Hermes-Screening: analysis` set the same reason triage's own call already sets it) proposes a
path, which is **never trusted directly** — it must exactly match an entry from
`hermes-self-repair-read.py list`'s real file listing or the finding is skipped (logged, not
guessed through). Conservative implementation defaults, not §6 operator decisions: a triage
finding at or above **medium** severity from either role is acted on **once per signature** —
the first time it arrives with no task recorded for it in the bridge's own state
(`submitted_signatures`; signature = category + source line, bot tag dropped, numbers collapsed).
Until 2.2.0 this gated on triage's own occurrence count being exactly 1, which meant any failure
already repeating before the bridge was installed could never be submitted. On a real incident: submits
a fix task and a test task (one per-area `services/minecraft-bots/tests/unit/*.test.mjs` file) and links them via
`hermes-self-repair-link.py`'s own logic. Publishes to Buzz as `"selfrepair"` — the identity
`hermes-self-repair-generate.py`'s own `publish_result()` already uses live — deliberately not a
new `"selfrepair-bridge"` Buzz identity, so this needs zero live `hermes-buzz.py` `KNOWN_AGENTS`
change to work once deployed. 30 new offline checks
(`infra/hermes-self-repair/tests/test_minecraft_bridge.py`) cover the pure parsing/gating/
templating/path-validation logic against fixture bodies built to match triage's real output
format exactly; the network-touching glue (actual Buzz polling, the real model call, real
submission) is not offline-tested, the same posture `hermes-self-repair-apply.py`/`-generate.py`
themselves have always had (proven live in Phase 1, not by synthetic unit test).

`hermes-self-repair-minecraft-bridge-wrapper.sh` and `.service` exist, matching every other
self-repair component's fetch-secrets-then-exec pattern — **not installed or enabled on spark**.
Benchmark-evaluation call (`CLAUDE.md`'s rule, `FLEET_SELFREPAIR_DESIGN.md` §7): both the fix/test
tasks and the bridge's own path-resolution call route through the exact same `coder`/`coder2` role
family §7 already covers — no new scenario needed; recorded here rather than silently assumed, per
§7's own "this call would only need revisiting if a future domain routed through a materially
different role" condition, which this isn't.

**Update, same day — switch flipped on, by direct operator instruction.** Two real gaps were
found while actually preparing to do this (never live traffic until now — this is the first time
anything in Phase 3 has run against the real fleet):

1. **No bootstrap.** `since` defaulted to 0 for a topic with no persisted cursor, so a freshly-
   enabled bridge would have polled `minecraft-ops` from the very start of its history — every
   triage incident since `infra/minecraft-bots-triage/` went live on 2026-09-07 — and tried to
   submit real task pairs for all of them in one burst. Fixed with `seek_to_end()`
   (`hermes-self-repair-minecraft-bridge.py` 1.1.0): the first time a topic has no cursor, this
   bridge pages to its current tip without processing anything, so it only ever reacts to
   incidents from the moment it actually started.
2. **No submission cap.** Nothing bounded how many tasks one poll cycle could submit. Added
   `MAX_SUBMISSIONS_PER_POLL` (default 3) and `BudgetExhausted`: a message that would exceed it is
   left with its cursor UNADVANCED (retried next cycle, not dropped), while everything already
   handled that cycle keeps its progress. This is a narrow, per-cycle safety valve — it is
   deliberately not an attempt to answer §6's own still-open "daily action cap" question, which is
   about PR-opening/daily-review, a separate policy decision.

6 more offline checks added (now 36 in `test_minecraft_bridge.py`) covering both: a multi-page
`seek_to_end()` walk, a topic with no messages at all, first-run seeding via
`poll_domain_buzz_topic()` itself, and both orderings of the budget-exhaustion/retry behavior.

`infra/hermes-self-repair/domains.json`'s `self_managed` is now `true`. Deploying and enabling
`hermes-self-repair-minecraft-bridge.service` (since renamed — see "Phase 4" below)
on spark is this phase's own remaining live step — the first time anything would auto-submit a
self-repair task without a human running `hermes-self-repair-submit.py` by hand.

## Phase 4: the second-domain genericity check (§8.4), in progress

`FLEET_SELFREPAIR_DESIGN.md` §8.4's own framing: "treat a hypothetical second domain as the real
acceptance test for genericity." Surveyed the fleet for a real candidate rather than inventing a
toy one — `tools/hermes_egress_guard.py` won: it already has its own offline test suite, and
critically, its detection source is a **structurally different shape** from minecraft-bots' —
every denial is a plain hermes-memory `turns` row (`task_id="egress-block"`, written by its own
`_record_denial()`), not a Buzz message. That difference is exactly what makes it a real test, not
a second copy of the same shape.

**It immediately found a real genericity leak.** `hermes-self-repair-minecraft-bridge.py`'s own
`poll_once()` looked up a handler generically (`HANDLERS[domain["detection_source"]]`) but then
assumed every source was Buzz-shaped (`if not source.startswith("buzz:"): continue`) — a domain
registering `"memory-turns:egress-block"` would have matched `HANDLERS` correctly and then been
silently skipped by the orchestration loop itself. `FLEET_SELFREPAIR_DESIGN.md` §4.4's own original
text already called for exactly one generic bridge ("not one bridge per domain"); Phase 3 just
hadn't been tested against a second shape yet to know it hadn't actually delivered that.

**Fixed by renaming and generalizing the bridge**, `hermes-self-repair-minecraft-bridge.py` →
`hermes-self-repair-bridge.py` (2.0.0; wrapper and `.service` renamed to match). `poll_once()` now
dispatches by a detection_source's **scheme** (the text before the first `:`) through
`SOURCE_POLLERS` (`"buzz"`, `"memory-turns"`), not a hardcoded prefix check; `HANDLERS` keeps its
exact same shape (keyed by the full detection_source string) from before. The existing
minecraft-bots Buzz logic is unchanged in behavior, just renamed
(`poll_domain_buzz_topic`→`poll_domain_buzz_source`, `seek_to_end`→`seek_to_end_buzz`, state keys
now `"buzz:<topic>"` instead of bare `"<topic>"`, so a second scheme can share the same state
dict without colliding).

**`egress-guard` registered as domain #2, switch off** (this registration exists to prove the
mechanism generalizes, not to start auto-submitting fixes against a security control):

- **New `"memory-turns"` source poller** (`poll_domain_memory_turns_source()`,
  `fetch_memory_turns()`, `seek_to_end_memory_turns()`): a durable, autoincrement-`id` cursor read
  directly from hermes-memory's own sqlite `turns` table (`ro_sqlite()`, the same read-only
  connection `hermes-fleetops-ui.py`'s own `read_egress_blocks()` already uses — no cheap live
  HTTP route exists for "turns after id N"). Same bootstrap contract as the Buzz poller: a source
  with no cursor yet is seeded at its current max `id` without processing anything, never replaying
  history.
- **`handle_egress_guard_denial()` needs no model call at all** — unlike minecraft-bots' triage
  prose, `_record_denial()`'s own payload already names the real offending script's basename in
  `caller`. `resolve_caller_path()` tries it against every allowlisted top-level prefix
  (`tools/`, `services/`, `skills/`, `agents/`) via the read tool's own `read` operation — the
  first that resolves wins, never a guess — and explicitly refuses if `caller` contains a path
  separator or would resolve to `tools/hermes_egress_guard.py` itself: this mechanism must never
  generate a task asking to weaken the security control that reported the denial. The generated
  problem text says so explicitly too ("NEVER weaken, bypass, or special-case
  `tools/hermes_egress_guard.py` itself").
- **No completeness rule** (`completeness_rule: null`) — §4.3's own "a domain with no rule beyond
  Step 4's baseline simply registers none" case, now actually exercised by a second real domain
  rather than only a synthetic unit-test fixture. One task per finding, no link.
- **`path_scope` is deliberately empty** — a real, accepted limitation worth stating plainly, not
  papering over: minecraft-bots' domain is a set of files it owns; egress-guard's domain is a
  *source* of detection, and the file it needs fixed could be almost anything allowlisted. An empty
  `path_scope` means `domain_for_path()` never attributes any file to this domain (its own
  docstring: unscoped matches nothing, never everything) — so an egress-guard task renders as
  domain `unregistered` in the FleetOps UI's column/filter and in the registered-PR mechanism's own
  branch naming, despite coming from a real, named, registered source. Fixing that would mean
  touching `hermes-fleetops-ui.py`'s or `hermes-self-repair-open-pr.py`'s own domain-labeling logic
  — exactly what this acceptance check exists to avoid needing, so it's left as a documented gap
  (`domains.json`'s own comment) rather than "fixed" by widening `path_scope` to something that
  would misattribute other domains' own files.

**Acceptance result so far**: registering domain #2 required zero changes to §4.5
(`hermes-self-repair-generate.py`/`-apply.py`'s pipeline logic itself — only the already-generic
domain/completeness lookups ran, unmodified), §4.6 (`-open-pr.py`), §4.7 (the review skill), or §4.8
(`hermes-fleetops-ui.py`). Everything touched was §4.1 (the registry) and §4.4 (the bridge) — and
§4.4 is explicitly supposed to be pluggable per domain, so generalizing its orchestration is exactly
what that section's own text already called for, not a violation of this check.

19 more offline checks (now 49 in the renamed `infra/hermes-self-repair/tests/test_bridge.py`,
covering the scheme-dispatch table, both source pollers' bootstrap/budget behavior, and the
egress-guard handler's path resolution/refusal logic). Fixed three stale filename references the
rename left behind in already-shipped files' own comments
(`hermes-self-repair-link.py` 1.0.1, `tools/hermes_self_repair_completeness.py` 1.0.1).

**Update, same day — deployed and running on spark.** `hermes-self-repair-bridge.service`
installed and enabled for the first time (no prior minecraft-bots-only service had ever actually
been started, so there was nothing to replace). One more real bug found live, right at that first
start: systemd failed with `status=203/EXEC` — the wrapper script had never been marked executable
in git (`100644`, not `100755`) since Phase 3's own original commit, latent the whole time because
nothing had tried to run it before now. Fixed with `git update-index --chmod=+x`
(`hermes-self-repair-bridge-wrapper.sh` 1.1.1), no content change. After that, it started cleanly
and its own first log line confirmed the bootstrap worked exactly as designed: `first run for
topic 'minecraft-ops' — seeded cursor at seq=643716, will not replay its history` — real evidence
the backlog-replay protection actually does what it says, not just what its offline tests assert.
`egress-guard` is correctly never polled at all (its switch is off); its own cursor key is absent
from the persisted state file.

**Update, same day — `egress-guard`'s switch flipped on too, by direct operator instruction; a
third domain deliberately deferred until these two have a track record.** One more real gap found
first, while actually preparing to do this: egress-guard had **no dedup at all** on repeated
denials from the same caller — unlike minecraft-bots, whose triage source does its own occurrence
counting, `tools/hermes_egress_guard.py`'s own `_record_denial()` writes a fresh turn on every
single denial, unconditionally. A script stuck in a retry loop against a denied destination would
have had a new self-repair task submitted for it every poll cycle.

Fixed with a per-caller cooldown (`hermes-self-repair-bridge.py` 2.1.0):
`egress_cooldown_active()` skips a new submission for a caller only while BOTH the prior task
submitted for that caller is still actively progressing (`task_is_active()` — drafting through
awaiting a promotion decision) AND fewer than `EGRESS_COOLDOWN_SECONDS` (default 3600) have passed
since it was submitted. Either condition alone releases it: a concluded task (promoted, declined,
dead, errored, unresolved — anything not in the active set) never has to wait out the rest of the
window, since there's no reason to keep a human from reviewing a new instance of the same problem
once they've already decided on the last one; and if the task's own state can't even be read (a
transient hermes-memory outage), `fetch_task_state_or_none()`'s own sentinel is treated as active
— the conservative direction — with the time window as the only way out, so a lookup failure can
never wedge the cooldown open forever. All four handlers (`HANDLERS`) now take `state` as a fourth
argument so a handler can read/write this kind of per-domain bookkeeping; minecraft-bots' own
handler doesn't use it yet.

11 more offline checks (60 total in `test_bridge.py`), including both release conditions, the
conservative treatment of an unreadable task state, and confirming a different caller's denial is
never blocked by another caller's own cooldown.

Both domains are now switched on. A third domain is explicitly **deferred, not forgotten** —
direct operator instruction — pending seeing how minecraft-bots and egress-guard actually perform
first.

## Revision History

| Version | Date | Change |
|---|---|---|
| 6.12.0 | 2026-11-10 | Bridge 2.3.0: a minecraft-bots test task now targets one per-area `services/minecraft-bots/tests/unit/*.test.mjs` file (chosen by the same validated model call as the fix path, from those files only) instead of the 363k-char `unit.test.mjs`, which the generator always refused. 67 bridge checks. |
| 6.11.0 | 2026-11-10 | Direct operator request. Bridge 2.2.0: findings are submitted once per signature, tracked in the bridge's own state, instead of only when triage's occurrence count is exactly 1. That gate had blocked every failure already repeating before 2026-11-08, `[stuck-path]` included, while the skip log claimed a task "was already considered". Generator 1.2.0: `MAX_FILE_CHARS` 12000 -> 40000 and `DRAFT_MAX_TOKENS`/`REVISE_MAX_TOKENS` -> 16000, sized to coder/coder2's live 65536-token context. 65 bridge checks. |
| 6.10.0 | 2026-11-08 | Direct operator instruction: `egress-guard`'s switch flipped on; a third domain explicitly deferred until these two have a track record. Found and fixed one more real gap first — no dedup on repeated denials from the same caller — with a per-caller cooldown in the bridge (2.1.0) that releases on whichever comes first, the prior task concluding or `EGRESS_COOLDOWN_SECONDS` elapsing. 11 more offline checks (60 total). See the "Phase 4" section's own update above. |
| 6.9.0 | 2026-11-08 | `hermes-self-repair-bridge.service` installed and enabled on spark for the first time. Found live at first start: the wrapper script had never been marked executable in git since Phase 3's original commit (`status=203/EXEC`), fixed with `git update-index --chmod=+x` (1.1.1). After that, started cleanly and its own log confirmed the backlog-replay bootstrap actually works on real data (`seeded cursor at seq=643716, will not replay its history`); `egress-guard` correctly never polled (switch off). See the "Phase 4" section's own update above. |
| 6.8.0 | 2026-11-08 | Phase 4 (§8.4) started: registered a real second domain, `egress-guard` (switch off). Its memory-turns-shaped detection source immediately surfaced a real genericity leak — `hermes-self-repair-minecraft-bridge.py`'s own `poll_once()` only knew how to poll Buzz. Fixed by renaming/generalizing it to `hermes-self-repair-bridge.py` (2.0.0): dispatch by detection_source scheme (`SOURCE_POLLERS`), not a hardcoded prefix check. `egress-guard`'s own handler needs no model call (its `caller` field already names the real offending script) and registers no completeness rule. `path_scope` left empty, a real documented limitation. 19 more offline checks. Acceptance result so far: zero changes needed to §4.5–§4.8. See the new "Phase 4" section above for the full account. |
| 6.7.0 | 2026-11-08 | Direct operator instruction: `minecraft-bots`' `self_managed` switch flipped to `true` (`domains.json`). Found and fixed two real gaps in `hermes-self-repair-minecraft-bridge.py` (1.0.0 → 1.1.0) while actually preparing to enable it, before any live traffic: no bootstrap (`seek_to_end()`, so a fresh enable doesn't replay weeks of triage history as a submission flood) and no per-cycle submission cap (`MAX_SUBMISSIONS_PER_POLL`, default 3, excess retried next cycle rather than dropped). 6 more offline checks. See the "Phase 3" section's own update above for the full account. |
| 6.6.0 | 2026-11-08 | `FLEET_SELFREPAIR_DESIGN.md` Phase 3 (§8.3): `minecraft-bots` registered as domain #1 (`self_managed: false`). Completeness hook (§4.3, §6 decided as "two linked tasks": `tools/hermes_self_repair_completeness.py`, `hermes-self-repair-link.py`, `hermes-self-repair-apply.py` 1.4.0's `finalize_or_wait()`/`unblock_linked_peer()`) and detection bridge (§4.4: `tools/hermes-self-repair-minecraft-bridge.py`, its wrapper/service, not installed). `hermes_self_repair_domains.py` bumped to 1.1.0 for glob path_scope matching; `hermes-self-repair-read.py` bumped to 1.1.0 for a new `list` operation. 59 new offline checks across three new test files plus a fix to an existing one whose "zero domains" assumption the real registration made stale. See the new "Phase 3" section above for the full account. |
| 6.5.0 | 2026-11-08 | `FLEET_SELFREPAIR_DESIGN.md` Phase 2 (§8.2): the generic review/PR/UI pieces, built with zero domains registered. New domain registry (`infra/hermes-self-repair/domains.json`, `tools/hermes_self_repair_domains.py`), registered-PR mechanism (`tools/hermes-self-repair-open-pr.py`), daily review skill (`skills/fleet-selfrepair-review/SKILL.md`, not yet scheduled live), and the FleetOps `/selfrepair` tab (`hermes-fleetops-ui.py` 2.19.0). `hermes-self-repair-promote-gate.py` bumped to 1.1.0 for a new `TRANSITIONS`/`write_turn()` pair the UI imports, plus a real `set_task_state()` return-value fix found along the way. See the new "Phase 2" section above for the full account. |
| 6.4.0 | 2026-11-07 | First real end-to-end verification (`FLEET_SELFREPAIR_DESIGN.md` Phase 1), two real tasks against `tools/hermes-benchmark-compare.py`. Found and fixed two real bugs live: `hermes-self-repair-generate-wrapper.sh` never fetched `BROKER_TOKEN` (fixed 1.0.1), so Step 2 could never actually hand off to Step 3; and `hermes-self-repair-generate.py`'s `compute_diff()` produced a patch `git apply` correctly rejected as corrupt whenever the model's completion lacked a trailing newline at EOF, a `difflib` limitation the original code didn't account for (fixed 1.1.1, normalizes both strings to one trailing newline before diffing). Task `fa2eb82b21af45b8` hit bug 2 and correctly escalated to `dead` after 3 attempts (circuit breaker confirmed live). Task `2e732538c2e34ebb`, submitted after both fixes, converged and reached `verified` — commit `92ad261` on `nas2-selfrepair/master`, awaiting `promote`/`skip`. |
| 6.3.0 | 2026-11-07 | Live-fleet audit while starting `FLEET_SELFREPAIR_DESIGN.md` Phase 1: this README's "nothing deployed" claims were stale. `hermes-self-repair-generate.service`, `-apply.service`, and `-promote-gate.service` are actually enabled and have been running continuously on spark since 2026-10-26 (confirmed via `systemctl`/`ps` against their real PIDs) — Buzz/memory/guard reachable, `coder2` active, `hermes-broker` 1.4.0. Corrected every "not yet deployed"/"no systemd deploy has happened" claim to the real state: deployed and healthy, but genuinely idle — `nas2-selfrepair/master` still ends at the 2026-09-19 dev-testing commits, so nothing in the "needs a real task" verification lists actually changes. No codesec venv found on spark, so Step 4's static-analysis half will fail open on a real run until that's installed. |
| 6.2.0 | 2026-09-19 | Security-relevant fix found during hardening self-review, not live traffic: `tools/hermes-self-repair-apply.py`'s (1.3.0) `parse_diff_path()` used `re.search()`, returning only the first `+++ b/<path>` match in a diff — a diff with more than one such header (a multi-file diff, never produced by the legitimate pipeline but exactly the "tampered turn record" threat this file already defends against elsewhere) would have had only its first path allowlist-checked while `git apply` still wrote every hunk in the diff, including files never checked at all. Fixed to `findall()` and refuse anything but exactly one match; verified with a constructed two-file diff (one allowed path, one targeting `infra/vaultwarden/.env`) confirming it is now refused outright rather than silently narrowed to the allowed-looking first file. Full Step 3/4 regression suite re-run clean afterward. |
| 6.1.0 | 2026-09-19 | Hardening pass, no deployment: `tools/hermes-self-repair-promote.py` (1.1.0) now diagnoses an empty/"already applied" cherry-pick separately from a real content conflict — a real distinction found live during Step 5's own testing that the original code lumped together. `hermes-self-repair-apply.py`'s circuit breaker was run through 5 consecutive real failures, a real reset, and independent-task-counter checks — confirmed a genuine, non-obvious operational property along the way: once a task hits `MAX_ATTEMPTS`, `do_apply()` is never called again for it, ever, even for a purely transient failure — recovery requires a human to delete its state file. Not a bug (matches `hermes-remediate-worker.py`'s own intentional design), but now explicitly documented rather than merely inheritable-by-reading-code. |
| 6.0.0 | 2026-09-18 | Steps 6–8: `tools/hermes-self-repair-submit.py` (the deliberate operator-run submission entry point — this IS Step 8, kept fully separate from `hermes-dispatch.py`) and `tools/hermes-self-repair-status.py` (Step 7's tracing/comparison, `<task_id>` timeline view + `--repo-diff`). Step 6 required no new code — confirmed by reading `hermes-repo-sync.sh` directly. `--repo-diff` run for real against this session's own accumulated test history. All nine steps (0–8) of the stepped plan now exist as reviewed, tested code; none deployed to a live node. |
| 5.0.0 | 2026-09-18 | Step 5: `tools/hermes-self-repair-promote-gate.py` (FleetOps confirmation watcher, no GitHub credential) and `tools/hermes-self-repair-promote.py` (the one manually-run component that ever touches GitHub, via a scoped cherry-pick). Step 3 bumped to 1.2.0 to log the applied-commit sha and post the promotion offer. Verified with real cherry-pick+push and a real cherry-pick conflict, both against a throwaway local stand-in for `origin` — the real GitHub repo was never touched. |
| 4.0.0 | 2026-09-18 | Step 4: `tools/hermes-self-repair-verify.py` (pre-promotion syntax + static-analysis gate, wired into Step 3's `do_apply()`) and `tools/hermes-self-repair-verify-live.py` (post-promotion service health-check, not yet wired — Step 5 doesn't exist). Step 3 bumped to 1.1.0. Verified with real apply+verify runs for both the passing and failing outcome, not just mocked. |
| 3.0.0 | 2026-09-18 | Step 3: `tools/hermes-self-repair-apply.py` (non-LLM apply worker, `selfrepair-apply` broker job), its wrapper and systemd unit. Step 2 (1.1.0) now logs the diff as a structured turn and hands off to this worker on convergence. Verified with a real apply+commit+push to NAS2 and its revert, not just mocked. |
| 2.0.0 | 2026-09-18 | Step 2: `tools/hermes-self-repair-generate.py` (fix-generation engine, new `selfrepair` Buzz topic), its wrapper and systemd unit. Not yet deployed or wired to the dispatcher. |
| 1.0.1 | 2026-09-18 | Real bug found live running this README's own verify block: `grep` on a single denied file silently widened its search to that file's parent directory instead of refusing. See `tools/hermes-self-repair-read.py`'s own changelog for the fix. |
| 1.0.0 | 2026-09-18 | Initial version — Step 1 of the self-repair stepped plan: scoped, read-only, allowlisted file access, no consumer yet. |
