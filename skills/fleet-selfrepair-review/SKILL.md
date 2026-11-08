---
name: fleet-selfrepair-review
description: "Daily review pass over the self-repair pipeline's own output (FLEET_SELFREPAIR_DESIGN.md §4.7): open draft PRs for newly-verified self-repair tasks, review every open selfrepair/* PR and comment on it, and record a ranked implement/needs-another-look/reject recommendation per PR. Comments only -- never edits a PR or pushes to its branch. Use when asked to run the daily self-repair review, or when wiring it up as a scheduled routine."
version: 1.0.0
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [self-repair, code-review, github, fleetops]
prerequisites:
  commands: [git, gh, ssh, python3]
---

# Fleet Self-Repair Review

**Version:** 1.0.0

The daily Claude Code routine FLEET_SELFREPAIR_DESIGN.md §4.7 describes — the review layer that
sits on top of `infra/hermes-self-repair/`'s generate/apply/verify pipeline and the registered-PR
mechanism (`tools/hermes-self-repair-open-pr.py`, §4.6). This skill is the *procedure*; nothing
here runs on a schedule yet (see "Not yet wired to a live schedule" below) — it is written to be
run by hand first, by whoever (or whatever Claude Code session) has the access this procedure
needs, and wired to the `schedule` skill as a cron-triggered cloud routine only once the operator
has actually made the open decisions that step requires.

**This is a review surface, not a promotion mechanism.** Nothing this skill does changes a self-
repair task's state or makes a fix live. The only thing that still promotes a fix is a human
setting `promotion-approved` (via a FleetOps Matrix `promote <id>` reply or the FleetOps
`/selfrepair` tab) and `tools/hermes-self-repair-promote.py` run by hand.

## What you need before running this

- **GitHub**: real push rights to `origin` under your own account, and `gh` authenticated as that
  account. No fleet node holds this — confirmed live (`FLEET_SELFREPAIR_DESIGN.md` §9, Phase 1):
  spark's own `origin` deploy key is read-only by design. Run this from a machine/session that
  already has real push rights the way you'd run `tools/hermes-self-repair-promote.py` or
  `-open-pr.py` by hand.
- **Fleet network reach**: SSH to the node running the self-repair services (`dgx-spark` as of
  this writing) to run the read-only listing script, since `hermes-memory`'s own HTTP API has no
  task-list route (`/tasks` is POST-only — confirmed while building the FleetOps UI's own backlog
  page) and `tools/hermes-self-repair-list.py` therefore reads `memory.db` directly, which only
  works on a node that can see that file.
- **MEMORY_URL/MEMORY_TOKEN** (fetch via `tools/vault-get-secret.sh memory-token password`, same
  as every other self-repair component) for the status/turn-writing calls that go over HTTP rather
  than direct sqlite.

## The three steps (§4.7)

### 1. Open PRs for newly-verified tasks

```bash
ssh dgx-spark 'cd ~/HermesAgentV5 && python3 tools/hermes-self-repair-list.py --state verified --without-pr'
```

For each task id printed, from a machine with real GitHub push rights:

```bash
MEMORY_TOKEN="$(tools/vault-get-secret.sh memory-token password)" \
  python3 tools/hermes-self-repair-open-pr.py <task_id>
```

This cherry-picks only that task's one applied commit onto a fresh branch off `origin/master`
(`selfrepair/<domain-or-unregistered>/<task_id>`) and opens it as a **draft** PR. It refuses
loudly on a cherry-pick conflict or an empty cherry-pick (fix already present) rather than
guessing — read the refusal, do not retry blindly. A task already carrying a `pr-opened` turn is
skipped automatically (idempotent).

### 2. Review every open `selfrepair/*` PR

```bash
gh pr list --search "head:selfrepair/" --state open --json number,headRefName,url
```

For each one: read its diff (`gh pr diff <number>`) and its full dualcoder-skeleton transcript
(`ssh dgx-spark 'cd ~/HermesAgentV5 && python3 tools/hermes-self-repair-status.py <task_id>'`,
extracting `<task_id>` from the branch name) — the draft, every review round, the security review
and its cross-check, and the diff itself. Evaluate the fix the way a careful second reviewer
would: is it correct, is it the minimal real fix, does it introduce anything the dualcoder rounds
and security review might have missed.

Post findings as **PR comments only**:

```bash
gh pr comment <number> --body "<your review>"
```

**Never** `gh pr edit`, **never** a push to the branch. That boundary is the operator's own
explicit instruction (`FLEET_SELFREPAIR_DESIGN.md` §1/§4.7): comment, do not change, yet.

### 3. Record a ranked recommendation

One per PR, **not only** the GitHub comment — GitHub's own comment stream is not a queryable
store this fleet already has a reader for, and the FleetOps `/selfrepair` tab (§4.8) needs to read
this back reliably. Record it as a `hermes-memory` turn on the task itself:

```bash
MEMORY_TOKEN="$(tools/vault-get-secret.sh memory-token password)" python3 - <<'PYEOF'
import json, os, urllib.request

MEMORY_URL = "http://10.129.1.15:8102"
TOKEN = os.environ["MEMORY_TOKEN"]
task_id = "<task_id>"
payload = {
    "task_id": task_id, "agent": "selfrepair-daily-review", "role": "assistant",
    "raw": json.dumps({
        "phase": "daily-review",
        "recommendation": "implement",  # or "needs another look" or "reject"
        "reasoning": "<why, in one or two sentences>",
    }),
}
req = urllib.request.Request(f"{MEMORY_URL}/turns", data=json.dumps(payload).encode(),
                              method="POST", headers={"Content-Type": "application/json",
                                                       "Authorization": f"Bearer {TOKEN}"})
urllib.request.urlopen(req, timeout=15).read()
PYEOF
```

`read_selfrepair_tasks()` in `tools/hermes-fleetops-ui.py` already reads the latest
`phase="daily-review"` turn per task and renders it in the `/selfrepair` tab — one per PR per day
is the assumed cadence; a later run's turn simply becomes the new "latest" shown.

## What happens to each recommendation

Nothing, automatically. **§6 of the design doc leaves this an open question on purpose**: whether
a "reject"-recommended PR is auto-closed or left open pending a human decision in the FleetOps UI
regardless of this routine's own recommendation. Until the operator decides, leave every PR open
— closing one is a real, visible GitHub action this skill does not take unilaterally.

## Not yet wired to a live schedule

This skill is deliberately **not** registered as a recurring cron job via the `schedule` skill.
Doing so means a cloud agent would, every day, autonomously open real PRs and post real comments
on the operator's own GitHub account, with no cap on how many. `FLEET_SELFREPAIR_DESIGN.md` §6
lists the open decisions that need an answer before that is a reasonable thing to turn on:

- **Daily action cap** — how many PRs may be opened/commented on in one run, so one noisy day of
  findings cannot produce dozens of open PRs.
- **What happens to a "reject"-recommended PR** — see above.
- **Where the scheduled session itself runs** — it needs both real GitHub push rights and network
  reach to `hermes-memory`/`dgx-spark` (an internal, tailnet-only address), which a plain cloud
  sandbox does not have by default. This is the same constraint `tools/hermes-self-repair-
  promote.py`/`-open-pr.py` already hit: no fleet node has the first, no public cloud agent has
  the second, by default.

Until the operator makes those calls, run this skill by hand, as needed — it is fully functional
as a manual procedure, and every tool it names is real and already built.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-08 | Initial version — the procedure half of `FLEET_SELFREPAIR_DESIGN.md` §4.7, built alongside Phase 2's generic pieces (§8.2). Deliberately not registered as a live schedule; see "Not yet wired to a live schedule" above for why. |
