# Fleet Self-Repair Review Loop

**Version:** 1.13.0
**Status:** §8's build order Phases 1–4 are built and live (see §9) — both registered domains,
`minecraft-bots` (#1, §3) and `egress-guard` (#2, §8.4), are **switched on** by direct operator
instruction (2026-11-08). A real genericity leak egress-guard's own registration surfaced — the
detection bridge only knowing how to poll Buzz — is fixed (the bridge is now
`hermes-self-repair-bridge.py`, generic across detection-source shapes). A third domain is
**deliberately deferred**, direct operator instruction, pending seeing how these two perform first.
Generalizes
2026-11-07's first pass at this design, which was written Minecraft-bot-specific
(`MINECRAFT_SELFREPAIR_DESIGN.md`, superseded by this file and removed) — on operator direction,
the capability itself is domain-agnostic. Minecraft bot behavior remains the first, and so far
only, **domain** registered against it (§3).

**Scope:** a self-managed, automated detect → draft → cross-review → apply → verify → review →
human-pick loop, built once as generic fleet infrastructure and applied to one or more registered
domains. Stitches together four pieces of standing fleet infrastructure that already exist
independently (`infra/minecraft-bots-triage/`, `tools/hermes-dualcoder.py`,
`infra/hermes-self-repair/`, `infra/hermes-fleetops-ui/`) plus the genuinely new, domain-agnostic
pieces §4 describes (a domain registry, a completeness hook, a detection bridge, a registered-PR
mechanism, a scheduled Claude Code review routine, a FleetOps UI tab) — all now built (§9).

## 1. The ask, restated precisely

Direct operator request, 2026-11-07: a self-improvement loop for the Minecraft bot fleet, active
only in a "self-managed mode" scoped to Minecraft bot behaviors:

1. Review the bots' logs periodically for bad behaviors, bugs, and stuck loops.
2. Evaluate a fix using the most appropriate coding engine.
3. Pass that fix to the *other* coding engine for review and improvement suggestions.
4. Ping-pong the recommendation between the two coding engines until neither suggests further
   changes.
5. Implement the resulting change.

Same-session follow-up: add a daily Claude (this product, not a fleet-held model) review of the
self-repair repository — on each registered self-repair PR, evaluate how the fix could be
improved and comment on the PR, without changing it — plus a FleetOps UI tab listing every
recommendation, where the operator picks which fixes the fleet actually implements.

**Second follow-up, this revision:** build the capability itself generic, not Minecraft-specific —
Minecraft bot behavior is the first application, not the only one this is ever meant to serve.
Everything below that was Minecraft-only in the first draft is now split into a generic mechanism
plus Minecraft's own registration against it (§3), so a second future domain is a registration, not
a redesign.

## 2. What already exists — this is additive, not a rewrite

- **Detection**, live today, Minecraft-specific: `infra/minecraft-bots-triage/README.md` —
  `tools/hermes-minecraft-triage.py` tails every `minecraft-bot-*.service` journal on its host and,
  on a triage-worthy line (crash, stuck pathfinding loop, abandoned goal, backend failure), fires
  `coder` and `coder2` **in parallel, independently** (the operator's own prior explicit choice over
  a draft/review pipeline), surfacing disagreement as its own signal. Output goes to the
  `minecraft-ops` Buzz topic (mirrored into FleetOps Matrix) and a local log. **Deliberately
  diagnosis-only** — it never edits code, restarts services, or touches server config. This is one
  domain's detection source, not the detection mechanism itself (§3/§4.2).
- **Cross-review ping-pong**, live today, already domain-agnostic: `tools/hermes-dualcoder.py` /
  `infra/hermes-dualcoder/README.md` — `coder` and `coder2` alternate bug-review rounds on one task
  until they agree or a round cap is hit (`MAX_ROUNDS`), then both write independent security
  reviews and cross-check each other's, with `tools/hermes-nous-judge.py` as a bounded tie-breaker
  before anything reaches a human. This *is* ask items 2-4 above, already built, already running on
  the fleet's own coder role family, and it has no notion of "Minecraft" anywhere in it.
- **Generate → apply → verify → promote**, written but **not deployed anywhere**, already
  domain-agnostic by construction: `infra/hermes-self-repair/README.md` (Steps 0-8).
  `hermes-self-repair-generate.py` is built directly on the dualcoder skeleton (same draft →
  review-round-N → converge → security-review state machine), scoped by `allowlist.json` to
  `allowed_prefixes: tools, skills, agents, services` — a path-prefix scope, not a domain concept,
  which already covers both `services/minecraft-bots/` and the `agents/minecraft-*/PROMPT.md`
  personas without modification. It never writes GitHub-reachable state itself:
  `hermes-self-repair-apply.py` commits and pushes only to `nas2-selfrepair` (refuses outright if
  `GIT_REMOTE` is ever `origin`), `hermes-self-repair-verify.py` gates on syntax + static analysis,
  and `hermes-self-repair-promote.py` is **the one component in the entire pipeline that ever
  touches GitHub, and only because a human runs it directly**
  (`infra/hermes-self-repair/README.md:246-256`) — a deliberate two-step split: a chat command
  approves, a human at a machine with real push rights executes. No step anywhere in this pipeline
  holds a GitHub-credential-shaped secret (confirmed by reading `tools/hermes-self-repair-apply-wrapper.sh`,
  per that README's own design note at line 138). Nothing about this pipeline needs to change to
  serve more than one domain — it already operates on "a path and a problem," not on "Minecraft."
- **FleetOps UI**, live today, already multi-section by construction:
  `infra/hermes-fleetops-ui/README.md` — read-only report pages plus a small number of deliberately
  narrow write routes (the model-scout backlog's decide buttons, the market watchlist's add form).
  The house rule for any write route here: **import the relevant gate's own transition function
  rather than reimplement it**, so two front doors (a chat reply, a UI click) can never disagree
  about what a decision means (`infra/hermes-fleetops-ui/README.md:54-68`). `/backlog`'s buttons
  import `hermes-model-scout-gate.py` for exactly this reason.
- **Confirmed absent:** there is no existing path from fleet infrastructure to the real Claude/
  Anthropic API anywhere in this repo. `tools/hermes-code.py` ("hermes-code") is a Buzz specialist
  that answers coding questions by calling the local `coder` role through `hermes-router.py` — it
  is unrelated to Claude despite the name similarity. No fleet node holds, or has ever held, an
  Anthropic API credential. This matters for §4.6/4.7 below and is true regardless of domain.
- **Test discipline, Minecraft-specific today, a template for other domains tomorrow**: this
  repo's own `CLAUDE.md` requires every bot behavior fix to ship, in the same change, a
  `unit.test.mjs` check that fails on the old code, a `live.test.mjs` scenario where observable
  in-world, and a `baseline.mjs` adjustment where it should move a fleet-level number
  (`services/minecraft-bots/tests/README.md`). A daily per-phase systemd timer chain
  (`infra/minecraft-bots-tests/`, added S47) already runs these suites and records
  `tests/baselines/<host>.json`. This is domain #1's own completeness rule (§4.3), not a property
  of self-repair itself — a future domain will supply its own.

## 3. Domains: the generic unit this capability operates over

**A domain is a registration, not a code path.** It names: a path scope (one or more prefixes
within `hermes-self-repair`'s existing `allowed_prefixes`), a detection source (whatever feeds
findings into §4.4's bridge), a completeness rule (§4.3 — what, besides the fix itself, a task must
produce before it can reach `verified`), a cadence (§4.2 — who decides when a finding becomes a
task), and its own self-managed-mode switch (on/off independent of every other domain). Every
generic piece in §4 — self-repair's core pipeline, the dualcoder cross-review, PR-opening, the
daily Claude review, the FleetOps UI tab — operates uniformly across every registered domain
without per-domain code in any of them. Adding a second domain later should mean writing a new
registration, not rebuilding or forking this design.

**Domain #1 — `minecraft-bots`:**

| Field | Value |
|---|---|
| Path scope | `services/minecraft-bots/`, `agents/minecraft-*/PROMPT.md` |
| Detection source | `infra/minecraft-bots-triage/` (§2, §4.2) |
| Completeness rule | `CLAUDE.md`'s unit/live/baseline test requirement (§2, §4.3) |
| Cadence | Triage's existing reactive, per-incident trigger (§4.2) |
| Self-managed-mode switch | Off by default, scoped to this domain only |

No other domain is registered. Where a domain registry actually lives (a flat config file read by
the bridge/UI/review routine alike, vs. a small Python module per domain) is an open question
(§6) — deliberately not decided here, since nothing downstream depends on the answer yet with only
one domain in play.

## 4. New pieces — generic unless marked as a domain's own registration

### 4.1 Domain registry

New, generic: whatever structure holds the table in §3 — read by the detection bridge (§4.4) to
know which sources map to which path scope and switch state, by the generate step (§4.3) to know
which completeness rule applies to a task's path, and by the FleetOps UI (§4.8) to label and filter
recommendations by domain. One source of truth, not three copies that can drift — see §6 for the
mechanism question this leaves open.

### 4.2 Detection cadence

Generic principle: each domain's own detection source decides its own cadence; the pipeline itself
imposes none. **Domain #1's instance**: Minecraft's triage already fires reactively, per incident,
faster than the four-hour cadence originally asked for — recommendation: keep that reactive trigger
rather than replacing it with a batched sweep, since it's already built and already faster.
**Resolved in §6 (2026-11-08): yes**, a periodic digest sweep per domain should also exist, for
patterns that only show up across many incidents rather than in any single log line — registered as
a second detection source under the same domain (§4.1), not a change to this mechanism. Not yet
built.

### 4.3 Completeness hook

Generic: `hermes-self-repair-generate.py` currently regenerates one target file's full content per
task and has no notion that "done" might require more than that file. This needs a per-domain
pluggable completeness check in the generate/verify path — a task isn't eligible for `verified`
until its domain's own rule is satisfied, looked up via §4.1's registry by the task's path.
**Domain #1's instance**: the Minecraft-bots rule (§2) — the task must also produce a matching test
artifact. Open question (§6): whether that's a second file slot in the same task spec
(`{"path", "problem", "test_path"}`, two full-file regenerations converged together) or two linked
tasks that only count as "done" together. A domain with no completeness rule beyond "the fix
compiles/passes static analysis" (self-repair's existing Step 4 gate) simply registers none —
Step 4 already covers that baseline for every domain.

### 4.4 Detection → self-repair submission bridge

Generic: nothing today connects any detection source to `hermes-self-repair-submit.py` (deliberately
a human-run CLI per Step 8, kept off the interactive/dispatch path —
`infra/hermes-self-repair/README.md:309-317`). This bridge should be a small, generic subscriber
that, for each domain whose switch (§3) is on, turns that domain's detection findings into a
`{"path", "problem", ...}` task spec (per §4.3) via the same `build_task`/submit path
`hermes-self-repair-submit.py` already uses — looked up per-domain via §4.1's registry, not one
bridge per domain. It is deliberately *not* added to `hermes-dispatch.py`, preserving Step 8's
boundary: this bridge is the only thing that can feed self-repair automatically, for any domain;
chat and `hermes-dispatch.py` still cannot. **Domain #1's instance**: a subscriber on the
`minecraft-ops` Buzz topic that triage already publishes to.

### 4.5 Deploying self-repair for real

Unchanged from the first draft, and already domain-agnostic: Steps 2-8 exist as reviewed,
individually-tested code but have never run against the real fleet — no systemd unit from this
pipeline has been installed on a live node (`infra/hermes-self-repair/README.md:361-363`). This has
to happen before any domain's registration means anything, and is lowest-risk done against a
non-bot file first, exactly the way Steps 2-5's own development testing already exercised real
applies/reverts against `tools/hermes-code.py` — proving the claim/screen/generate/apply/verify/
promote-gate cycle works end-to-end on the real fleet before any domain-specific traffic touches it.

### 4.6 Registered PR mechanism

Generic: once a task reaches `verified` (Step 4), regardless of domain, it becomes eligible to be
opened as an actual **draft** GitHub PR — a branch carrying that one commit, pushed from
`nas2-selfrepair`, against `master`. Branch naming should carry the domain, not just the task id
(`selfrepair/<domain>/<task_id>`, e.g. `selfrepair/minecraft-bots/<task_id>`), so PRs from different
domains are distinguishable at a glance once a second domain exists. This reuses the exact scoped
single-commit mechanics `hermes-self-repair-promote.py` already has for the real (human) promote:
fetch both remotes, branch off `origin/master`, cherry-pick only that one commit
(`infra/hermes-self-repair/README.md:246-256`).

**Critically, this action is taken by the scheduled Claude Code routine (§4.7), never by fleet
infrastructure, for any domain.** Confirmed in §2: no fleet node holds a GitHub credential anywhere
in this pipeline, by deliberate design. Opening PRs from fleet infra would mean minting and placing
a new GitHub-write-capable secret somewhere automated — exactly the surface this project's
self-repair design has twice gone out of its way to avoid (`do_apply()`'s NAS2-only remote; the
promote script's "fetches no credential from anywhere... whatever `git push` can already do in
whatever checkout it's run from"). Routing PR-opening through the scheduled Claude Code session
instead means the *only* thing that ever gains new GitHub reach is an agent already running under
the operator's own authorization — the same actor the promote step already required to be a human
at a GitHub-capable machine, just automated under that same person's standing permission instead of
only running when remembered. No new credential, anywhere, on any fleet node, for any domain.

### 4.7 Daily Claude review + recommendation digest

Generic, one daily pass across every domain's open PRs, not a per-domain schedule — simplest to
operate as one fleet-wide sweep rather than N independent ones. A scheduled Claude Code routine
(the `schedule` skill — a cron-triggered cloud agent), once daily:

1. Lists self-repair tasks sitting `verified` on `nas2-selfrepair` ahead of `origin`
   (`hermes-self-repair-status.py --repo-diff` / per-task timeline) that are not yet opened as a PR,
   across every domain, and opens one each per §4.6.
2. For every open `selfrepair/*` PR, any domain: reads the diff plus its dualcoder round/
   security-review transcript for context, and evaluates how the fix could be improved. Posts
   findings as **PR comments only** (`gh pr comment` / `gh pr review --comment`) — never
   `gh pr edit`, never a push to the branch. This is explicitly the operator's own stated boundary:
   Claude comments, it does not change the PR, yet.
3. Writes one ranked daily recommendation per PR ("implement" / "needs another look" / "reject")
   as a structured record, tagged with its domain — not only a GitHub comment, since §4.8's UI tab
   needs to read it back reliably and GitHub's own comment stream is not a queryable store this
   fleet already has a reader for.

### 4.8 FleetOps UI — new `/selfrepair` tab

Generic, one tab covering every domain: built the way every existing page in
`infra/hermes-fleetops-ui/` is — read-only by default (diff summary, dualcoder round history,
Claude's daily comments and recommendation, current state, **domain**), plus exactly **one** write
route — "select which fixes to implement." A domain column plus a filter `<select>` (reusing the
same GET-driven pattern `/recommendations`' own state filter and `/backlog`'s new state filter
already establish) means this tab needs no rebuilding when a second domain appears — only a new
row source feeding it, via §4.1's registry. Per the house rule
(`infra/hermes-fleetops-ui/README.md:54-68`), the write route imports
`hermes-self-repair-promote-gate.py`'s own transition logic rather than restating it, the same way
`/backlog`'s decide buttons import `hermes-model-scout-gate.py`. Checking a box and clicking
"implement" does exactly what replying `promote <id>` in Matrix chat already does today: it sets
`promotion-approved`. It does **not** itself merge anything — the actual GitHub-touching step
(merging the registered PR) stays a deliberate, separate action, matching Step 5's original
"approval and execution must never be the same act" reasoning.

## 5. What this deliberately leaves unchanged

- **No GitHub-credential-shaped secret ever lives on fleet infrastructure, for any domain.**
  Everything that touches GitHub in this design — opening a PR, commenting on it, eventually
  merging it — runs from a Claude Code session under the operator's own authorization, never from a
  systemd unit on spark/spark2/HomeD13.
- **Self-repair's human chokepoint stays a chokepoint, for every domain.** Opening a draft PR is
  not promotion. Merging it is the equivalent of today's `hermes-self-repair-promote.py` run, and
  should require the same explicit, separate act it requires today — whether that act becomes
  "operator merges the PR" or "operator clicks implement in FleetOps UI, then a human/scheduled step
  merges" is an open question (§6), not a foregone automatic merge.
- **Dualcoder's and self-repair's own internal mechanics are untouched**: round caps, the
  Nous-judge tie-break, `MAX_FILE_CHARS`, the allowlist/denylist, the syntax + static-analysis
  verify gate, the circuit breaker and its "never retried again once escalated" property. This
  design adds a domain registry, callers, and a new review layer around that machinery — none of it
  changes.
- **The `allowed_prefixes` allowlist does not widen.** Domains are registered *within* the existing
  `tools`/`skills`/`agents`/`services` scope, never outside it; a domain whose natural path falls
  under `infra/` (deliberately excluded today, per `infra/hermes-self-repair/README.md:40-44`)
  cannot be registered without a separate, explicit decision to widen that allowlist — this design
  does not make that call on its own.

## 6. Open questions — decisions only the operator can make

- **Domain registry mechanism — resolved in Phase 2 (§8.2).** A flat JSON file
  (`infra/hermes-self-repair/domains.json`, `tools/hermes_self_repair_domains.py`), not a Python
  module per domain. Phase 3's own completeness check (below) confirms this didn't actually cost
  the expressiveness this bullet worried about: a domain names its rule by a short string
  (`completeness_rule: "test-artifact"`), and the logic itself lives in one shared module
  (`tools/hermes_self_repair_completeness.py`) dispatching on that name — a second domain with a
  different rule registers a new name and a new `if` branch there, not a new per-domain file.
- **Cadence — resolved, direct operator instruction (2026-11-08).** Keep each domain's own reactive
  detection as the default, **and also** add a periodic digest sweep per domain, for cross-incident
  patterns a single finding wouldn't show. Per §4.2's own framing, the sweep is a second detection
  source registered under each domain, not a change to the mechanism itself. Not yet built.
- **Self-managed-mode toggle shape — resolved, direct operator instruction (2026-11-08).** A
  FleetOps UI switch, per domain — a write route following §4.8's own gate-import rule (imports
  `tools/hermes_self_repair_domains.py`'s own write path rather than editing `domains.json` inline).
  Not yet built; today the switch is still a hand-edit of `domains.json`.
- **Daily action cap — resolved, direct operator instruction (2026-11-08).** Per-domain, not
  fleet-wide: isolates one domain's bad day from starving another's budget, at the cost of total
  fleet-wide footprint growing with domain count (today: two domains, two independent caps, not one
  shared number). Exact per-domain value not yet set; not yet built.
- **"Reject"-recommended PRs — resolved, direct operator instruction (2026-11-08).** Left open,
  pending a human decision in the FleetOps UI — never auto-closed by the review routine regardless
  of Claude's own recommendation.
- **Promotion mechanism — resolved, direct operator instruction (2026-11-08).** Both coexist: PR-
  merge promotes tasks that went through a registered domain's PR flow (§4.6); `hermes-self-repair-
  promote.py`'s cherry-pick script stays the only promotion path for tasks submitted by hand outside
  any registered domain's scope (Step 8), which never get a PR under this design unless also
  registered. Not yet built — merging a `selfrepair/*` PR today has no promotion effect wired to it.
- **Completeness-hook task shape (§4.3) — resolved in Phase 3 (§8.3), direct operator choice.**
  Two linked, ordinary, independent tasks (`tools/hermes-self-repair-link.py`,
  `hermes_self_repair_completeness.py`), over one task regenerating two files together —
  specifically to avoid touching `hermes-self-repair-apply.py`'s existing hardened refusal of any
  diff touching more than one file, and to avoid restructuring `-generate.py`'s single-file draft/
  review loop. Consequence, accepted: one incident under this rule produces two separate draft
  PRs (fix + test), not one.

## 7. Benchmark-evaluation call (this project's `CLAUDE.md`)

This design routes new automated traffic to `coder`/`coder2` (via the existing triage and dualcoder
mechanisms, for whichever domain is registered) and introduces a new review step performed by
Claude Code itself. Per `CLAUDE.md`'s rule, the call is made explicitly here rather than left
implicit:

- The `coder`/`coder2` side of this design (a domain's detection source firing parallel calls,
  self-repair's dualcoder-skeleton draft/review loop) already has Tier 1 coverage —
  `FLEET_BENCHMARK_DESIGN.md` gaps 5, 7, and 8 (`fleet_dualcoder_precision` §6.5, `fleet_coder_fix`
  §6.7, `fleet_coder_build` §6.8) were built specifically to measure review-agreement and real
  fix/build quality for this exact role family. No new benchmark scenario is needed for that side
  of this design, for domain #1 or any domain registered later through the same mechanism.
- The new daily-review step is performed by Claude Code itself, which is not one of
  `FLEET_BENCHMARK_DESIGN.md` §3's fleet-held, swappable backend roles — there is no incumbent to
  benchmark it against the way `coder2`/`omni`/`muse` are benchmarked against candidates. The
  gap-structure's "does this role have Tier 1 coverage" question does not apply to it. Call: **no
  new benchmark scenario needed** for the review step either.
- This call is about the generic mechanism, not about any one domain — registering a second domain
  later through this same mechanism (§3) does not by itself require re-making this call. It would
  only need revisiting if a future domain routed its fixes through a materially different model
  role than `coder`/`coder2`, or the review step stopped being plain Claude Code commentary.
- Once any piece of this design actually ships as a real commit, that commit is candidate material
  for `fleet_coder_fix`/`fleet_coder_build`'s own growing corpus tables (§6.7/§6.8) the same way the
  existing fix/build examples were sourced — to be added in the shipping commit itself, not here,
  since nothing in this design is committed yet.
- **Phase 3 re-check (§8.3, 2026-11-08): the call stands, re-made explicitly rather than assumed.**
  Domain #1's fix and test tasks both route through the same unmodified `coder`/`coder2`
  dualcoder-skeleton loop as every other self-repair task; the new detection bridge's own path-
  resolution call (`tools/hermes-self-repair-bridge.py`) also calls the `coder` role,
  not a new/different one. Neither condition in the bullet above (a materially different model
  role, or the review step stopping being plain Claude Code commentary) is triggered. **No new
  benchmark scenario needed.**

## 8. Suggested build order

1. Deploy `hermes-self-repair` Steps 2-8 for real, against a non-bot file first (§4.5) — proves the
   full generate/apply/verify/promote-gate loop on the live fleet with the least blast radius,
   independent of any domain.
2. Build the generic pieces with no domain registered yet where that's possible: the domain
   registry's shape (§4.1, §6), the registered-PR mechanism (§4.6), the daily Claude review routine
   (§4.7), and the FleetOps UI tab (§4.8) — all of these should work (rendering "no domains
   registered") before domain #1 exists, as the real test that they're actually generic and not
   quietly Minecraft-shaped.
3. Register `minecraft-bots` as domain #1 (§3): build its completeness hook (§4.3 — the test-artifact
   requirement), its detection bridge (§4.4 — triage → submit), and flip its switch on, deliberately,
   once 1-2 have each been verified independently — not as a single flip the first time every piece
   runs together.
4. Treat a hypothetical second domain as the real acceptance test for genericity: if registering one
   ever requires touching §4.5-4.8's code rather than only §4.1's registry plus a new §4.3/§4.4 pair,
   that's a sign this design leaked domain-specific assumptions somewhere and step 2 wasn't actually
   generic.

## 9. Phased build status

Tracks §8's four steps. Updated in the same change whenever a phase starts, progresses, or
completes — see `CLAUDE.md`'s implementation-plans rule.

| Phase | Status | Date | Notes |
|---|---|---|---|
| 1. Deploy `hermes-self-repair` Steps 2-8 for real (§8.1) | Done | 2026-11-07 | Two real tasks run end-to-end against `tools/hermes-benchmark-compare.py` (non-bot, per §8.1). Found and fixed two real bugs live: missing `BROKER_TOKEN` in the generate wrapper, and a `compute_diff()` trailing-newline bug that made `git apply` reject the patch as corrupt (`infra/hermes-self-repair/README.md` 6.4.0). First task correctly escalated to `dead` on the bug; second converged and reached `verified` — real commit `92ad261` on `nas2-selfrepair/master`, awaiting operator `promote`/`skip`. Still no codesec venv on spark (static-analysis half of verify fails open). |
| 2. Build the generic pieces with no domain registered (§8.2) | Done | 2026-11-08 | All four built and exercised with zero domains registered: domain registry (`infra/hermes-self-repair/domains.json` + `tools/hermes_self_repair_domains.py`), registered-PR mechanism (`tools/hermes-self-repair-open-pr.py`, reusing `-promote.py`'s own fetch/branch/cherry-pick mechanics against a new branch + `gh pr create --draft` instead of `master`), daily Claude review routine (`skills/fleet-selfrepair-review/SKILL.md` — the procedure only; deliberately **not** registered as a live cron. §6's daily-cap/reject-handling/promotion-mechanism/toggle-shape/cadence questions are now all resolved by direct operator instruction, 2026-11-08 — what remains before this can actually schedule is building what those answers call for, then wiring the `schedule` skill cron per §4.7), and the FleetOps `/selfrepair` tab (`hermes-fleetops-ui.py` 2.19.0, 423/423 offline checks passing, 43 new). `hermes-self-repair-promote-gate.py` bumped to 1.1.0 (new `TRANSITIONS`/`write_turn()` the UI imports per the house rule, plus a real `set_task_state()` return-value bug fixed along the way) — see `infra/hermes-self-repair/README.md` 6.5.0 for the full account. |
| 3. Register `minecraft-bots` as domain #1 (§8.3) | Done, switch on | 2026-11-08 | Registered in `domains.json`. Completeness hook built (§4.3 — §6's "two linked tasks" answer: `hermes_self_repair_completeness.py`, `hermes-self-repair-link.py`, `-apply.py` 1.4.0) and detection bridge built (§4.4: `hermes-self-repair-bridge.py`, renamed/generalized in Phase 4). Two real gaps found and fixed before enabling it live (1.1.0): no bootstrap seek-to-end (a fresh switch-on would have replayed the topic's entire history as a submission flood) and no per-cycle submission cap. `self_managed` flipped to `true` by direct operator instruction. See `infra/hermes-self-repair/README.md` 6.7.0 and §9's Phase 4 row below for the actual live-deployment step. |
| 4. Second-domain genericity check (§8.4) | In progress | 2026-11-08 | Real second domain found and registered: `egress-guard` (`tools/hermes_egress_guard.py` + `EGRESS_GUARD_DESIGN.md`, switch off — this is the audit, not a decision to auto-submit fixes against a security control). Its detection source (hermes-memory `turns`, not Buzz) genuinely broke the bridge's own orchestration: `hermes-self-repair-minecraft-bridge.py` only knew how to extract a Buzz topic from a `detection_source` string, silently skipping anything else — the exact leak this check exists to catch. Fixed by renaming/generalizing it to `hermes-self-repair-bridge.py` (2.0.0): `poll_once()` now dispatches by a source's scheme via `SOURCE_POLLERS` (`"buzz"`, `"memory-turns"`), `HANDLERS` unchanged in shape. `egress-guard`'s own handler needs no model call at all — the denial's own `caller` field already names the real offending script. Registers no completeness rule (§4.3's own "none beyond Step 4's baseline" case, now actually exercised by a second real domain, not just a unit test). `path_scope` is deliberately empty (a real, documented limitation: egress-guard's domain is about detection source, not file ownership — see `domains.json`'s own comment). 19 more offline checks. **Acceptance result so far: registering domain #2 touched zero lines in §4.5 (`-generate.py`/`-apply.py`'s own pipeline logic — only the already-generic completeness/domain lookups ran, unmodified), §4.6 (`-open-pr.py`), §4.7 (the review skill), or §4.8 (`hermes-fleetops-ui.py`) — only §4.1 (registry) and §4.4 (the bridge, which is explicitly meant to be pluggable).** Deployed and running on spark: `hermes-self-repair-bridge.service` installed/enabled for the first time, surfacing one more real bug live (the wrapper script was never marked executable in git since Phase 3's original commit — `status=203/EXEC` — fixed with `git update-index --chmod=+x`). Its own first log line confirmed the backlog-replay bootstrap works on real data: `seeded cursor at seq=643716, will not replay its history`; `egress-guard` correctly never polled while its switch was off. **Direct operator instruction (2026-11-08): flip `egress-guard`'s switch on too, defer a third domain until these two are seen in practice.** One more real gap found and fixed first: egress-guard had no dedup at all on repeated denials from the same caller (unlike minecraft-bots, whose triage source does its own occurrence counting) — `_record_denial()` writes a fresh turn on every single call, unconditionally. Added a per-caller cooldown (`hermes-self-repair-bridge.py` 2.1.0: `egress_cooldown_active()`/`task_is_active()`/`record_egress_submission()`) that releases as soon as EITHER the prior task for that caller concludes OR `EGRESS_COOLDOWN_SECONDS` (default 3600) passes — whichever comes first — so a human decision is never second-guessed by a flood, but an unreadable task state can't wedge the cooldown open forever either. 11 more offline checks (60 total in `test_bridge.py`). Both domains are now switched on; a third is explicitly deferred, not forgotten — revisit once minecraft-bots/egress-guard have a real track record. This phase's own acceptance *conclusion* (so far, zero §4.5-§4.8 changes needed) remains provisional on two real domains' worth of evidence. |
| 5. Fidelity pass on the live pipeline (direct operator request) | Done, deployed | 2026-11-13 | Measured first: 36 of 52 tasks ended in error, 5 of 7 staged fixes changed nothing yet verified. Fixed: screening hand-off and retries; JS-aware verification running the domain's tests, with revert on failure; tests written from the applied fix and required to fail without it; emitter-based targeting with code and log context; crash/OOM grouping; outcome log and FleetOps funnel. Full account: `infra/hermes-self-repair/README.md` 7.0.0, "Fidelity pass". Open: `index.js`/`actions.js` still exceed the whole-file limit (closed by 59b098f, the module split). |
| 6. Improvements pass on the live pipeline (direct operator request) | Done, deployed | 2026-11-13 | Measured first: of 902 outcome lines in 20h, 893 were repeat sightings; 4 fix tasks, no usable patch (two deadlocks, two intake blocks, one Layer 1 block mid-pipeline). Fixed: per-kind goal-abandon signatures; backend outages reported, never fix tasks; leaked reasoning stripped and router refusals explained; deadlocks and recurring promoted fixes posted to FleetOps; hourly counted sightings. Full account: `infra/hermes-self-repair/README.md` 7.1.0, "Improvements pass". Measured 13h after deploy: per-kind signatures split the abandons (shelter 95, ranch 5, farm 1, bed 1), deadlock notices sent, no outages or refusals -- but 0 of 7 fix attempts promoted (see Phase 7). |
| 7. Pre-review mechanical checks (direct operator request) | Done, not yet deployed | 2026-11-14 | Of Phase 6's seven attempts, two converged and were reverted by verify for things no reviewer was needed to find: a syntax error (d2894fb5) and a comments-only diff (92a06120). The generator (1.6.0) now runs verify's syntax and behavior-change checks on every draft before review, sending a failure back as that round's ISSUES; replaying both tasks' real drafts catches each. Found along the way: `node --check` passes a broken ESM `.js` file with no `package.json` beside it (node 22 module detection), so the temp copy carries one. Full account: `infra/hermes-self-repair/README.md` 7.2.0. |

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.13.0 | 2026-11-14 | §9: Phase 6 marked deployed with its first 13h of results; added Phase 7, pre-review mechanical checks (direct operator request), done, not yet deployed. |
| 1.12.0 | 2026-11-13 | Added §9 Phase 6, the improvements pass (direct operator request), done, not yet deployed -- see `infra/hermes-self-repair/README.md` 7.1.0. Phase 5's open item marked closed by the module split. |
| 1.11.0 | 2026-11-13 | Added §9 Phase 5, the fidelity pass on the live pipeline (direct operator request), done and deployed -- see `infra/hermes-self-repair/README.md` 7.0.0. |
| 1.10.0 | 2026-11-08 | Direct operator instruction: resolved all five of §6's remaining open questions. Cadence — yes, add a periodic digest sweep per domain alongside reactive detection (§4.2). Self-managed toggle shape — a FleetOps UI switch, not a flag file/env var/chat command. Daily action cap — per-domain, not fleet-wide. "Reject"-recommended PRs — left open for human review in the FleetOps UI, never auto-closed. Promotion mechanism — both coexist: PR-merge promotes registered-domain tasks, `hermes-self-repair-promote.py` stays the only path for hand-submitted out-of-scope tasks. None of these are built yet — this revision only records the decisions (§6, §4.2, §9's Phase 2 note updated to match); building them is a separate, not-yet-requested next step. |
| 1.9.0 | 2026-11-08 | Direct operator instruction: flip `egress-guard`'s switch on too (defer a third domain until these two have a track record). Found and fixed one more real gap first — no dedup on repeated denials from the same caller, unlike minecraft-bots' own triage-side occurrence counter — with a per-caller cooldown in the bridge (2.1.0) that releases on whichever comes first: the prior task concluding, or `EGRESS_COOLDOWN_SECONDS` elapsing. 11 more offline checks (60 total). Both domains now switched on. |
| 1.8.0 | 2026-11-08 | `hermes-self-repair-bridge.service` deployed to spark, installed/enabled for the first time. Found live at first start: the wrapper script had never been marked executable in git (`status=203/EXEC`), latent since Phase 3's original commit — fixed with `git update-index --chmod=+x`. Its own first log line confirmed the backlog-replay bootstrap works on real data, not just offline tests: `seeded cursor at seq=643716, will not replay its history`. `egress-guard` correctly never polled (switch off). |
| 1.7.0 | 2026-11-08 | Phase 4 (§8.4) started for real: registered a real second domain, `egress-guard` (switch off — the audit, not a decision to auto-submit security-control fixes). Its detection source (hermes-memory `turns`, not Buzz) immediately surfaced a real genericity leak Phase 3 left behind — `hermes-self-repair-minecraft-bridge.py`'s own orchestration only knew how to poll Buzz, silently skipping any other `detection_source` shape even though its own `HANDLERS` table was already generic. Fixed by renaming/generalizing it to `hermes-self-repair-bridge.py` (2.0.0): `poll_once()` now dispatches by a source's scheme (`SOURCE_POLLERS`), not a hardcoded `"buzz:"` check. Added `handle_egress_guard_denial()` — no model call needed, since the denial's own `caller` field already names the real offending script, resolved against the real repo via the read tool, never guessed, and explicitly refused if it would name `tools/hermes_egress_guard.py` itself. `egress-guard` registers no completeness rule, exercising §4.3's "none beyond Step 4's baseline" case for the first time via a real second domain rather than only a unit test. `path_scope` left deliberately empty — a real, documented limitation (`domains.json`'s own comment): this domain's identity is about its detection source, not a bounded set of owned files, so it renders as `unregistered` wherever something looks up a task's domain by path. 19 more offline checks (now 49 in the renamed `test_bridge.py`). **Acceptance result so far: registering domain #2 required zero changes to §4.5–§4.8's own code** — only §4.1 (registry) and §4.4 (the bridge, explicitly meant to be pluggable). Fixed three stale filename references the rename left behind in already-shipped files' own comments (`hermes-self-repair-link.py` 1.0.1, `hermes_self_repair_completeness.py` 1.0.1). |
| 1.6.0 | 2026-11-08 | Direct operator instruction: `minecraft-bots`' `self_managed` switch flipped to `true`, and its detection bridge installed/enabled on spark. Found and fixed two real gaps in `hermes-self-repair-minecraft-bridge.py` first, while actually preparing to go live (1.0.0 → 1.1.0): no bootstrap step, so a fresh enable would have polled `minecraft-ops` from the start of its history (weeks of past incidents) and tried to submit tasks for all of them at once (fixed with `seek_to_end()`); and no cap anywhere on how many tasks one poll cycle could submit (fixed with `MAX_SUBMISSIONS_PER_POLL`, default 3, leaving any excess for the next cycle rather than dropping it — a narrow per-cycle safety valve, not an answer to §6's own still-open daily-cap question). 6 more offline checks added for both fixes (now 36 in that file). §9 updated to "Done, switch on." Phase 4 started: surveying for a real second-domain candidate. |
| 1.5.0 | 2026-11-08 | Phase 3 done, switch off: `minecraft-bots` registered as domain #1 (§3). Resolved two of §6's open questions explicitly — the completeness-hook task shape (two linked tasks, a direct operator choice over one task regenerating two files, to avoid touching `-apply.py`'s hardened multi-file-diff refusal or restructuring `-generate.py`'s single-file loop) and, retroactively, confirmed the domain-registry-mechanism choice (Phase 2's flat file) held up against a real completeness rule. Built and offline-verified: the completeness hook (`hermes_self_repair_completeness.py`, `hermes-self-repair-link.py`, `-apply.py` 1.4.0) and the detection bridge (`hermes-self-repair-minecraft-bridge.py` — a real gap found and closed along the way: triage's own coder/coder2 calls never name a file path, so this bridge adds its own path-resolution call, never trusted without a real-file-listing match). §7's benchmark-evaluation call re-made explicitly for Phase 3's new traffic (still: no new scenario needed). Corrected this file's own top-of-document "Status" line, stale since Phase 1 (claimed nothing was built). §9 updated to "Done, switch off" for Phase 3. See `infra/hermes-self-repair/README.md` 6.6.0 for the full account. |
| 1.4.0 | 2026-11-08 | Phase 2 done: built and exercised, with zero domains registered, the four generic pieces §8.2 calls for — the domain registry, the registered-PR mechanism, the daily Claude review routine's procedure (deliberately not yet scheduled live — §6's daily-cap/reject-handling/session-placement questions are still open), and the FleetOps `/selfrepair` tab. §9 updated to "Done" for Phase 2. |
| 1.0.0 | 2026-11-07 | Initial version. Supersedes `MINECRAFT_SELFREPAIR_DESIGN.md` (1.0.0, deleted), which described the same self-managed self-repair loop (periodic detection, coder/coder2 cross-review, automated fix, daily Claude Code review of registered self-repair PRs, a FleetOps UI tab for picking which fixes to implement) as Minecraft-bot-specific. On direct operator request, generalized so the review/PR/UI mechanism (§4.1, §4.6-§4.8) is domain-agnostic, with a new §3 "domains" concept and Minecraft bot behavior registered as domain #1 (§3) rather than built into the mechanism itself. Proposed only; nothing in this design is built. |
| 1.1.0 | 2026-11-07 | Added §9, the phased build status table required by `CLAUDE.md`'s new implementation-plans rule (1.3.0) — tracks §8's four build-order steps, all currently "Not started." |
| 1.2.0 | 2026-11-07 | Phase 1 started: live audit of spark found Steps 2/3/5 already deployed and healthy since 2026-10-26, contradicting `infra/hermes-self-repair/README.md`'s stale "nothing deployed" claims (fixed there, 6.3.0). §9 updated to "In progress." |
| 1.3.0 | 2026-11-07 | Phase 1 done: ran two real self-repair tasks end-to-end on spark. Found and fixed two real bugs along the way — a missing `BROKER_TOKEN` in the generate wrapper (Step 2 could never hand off to Step 3) and a `compute_diff()` bug producing patches `git apply` rejected as corrupt whenever the model's completion lacked a trailing newline (`infra/hermes-self-repair/README.md` 6.4.0, `hermes-self-repair-generate-wrapper.sh` 1.0.1, `hermes-self-repair-generate.py` 1.1.1). Second task reached `verified` with a real commit on `nas2-selfrepair/master`. §9 updated to "Done." |
