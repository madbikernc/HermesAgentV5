# hermes-dualcoder — recreate checklist

**Version:** 1.1.0

Bounded, auditable dual-agent code review (direct operator request, 2026-09-05). `coder` and
`coder2` (Muse Glimmer 30B, `infra/hermes-coder2/`) alternate bug-review rounds on one coding task
until they agree or a round cap is hit, then both write independent security reviews and cross-check
each other's review. See `tools/hermes-dualcoder.py`'s own header for the full state machine and
`tools/hermes-nous-judge.py`'s role as a bounded tie-breaker before any human escalation.

## 1. Deploy

```bash
sudo cp hermes-dualcoder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-dualcoder
```

Requires `coder2` already deployed and reachable (`infra/hermes-coder2/README.md`),
`hermes-broker.py` 1.4.0+ running (the wake-worker claim-scoping fix), and the `codesec` venv
installed (`infra/hermes-code-security-scan/README.md`) — the security phase fails open to
"static analysis unavailable" without it, so the pipeline still runs, but reviews lose the
consistency the static pass exists to provide.

## 2. Verify — real task, not a smoke test

Follow this fleet's own "verify live, don't assert" rule: a report of work is not evidence it
happened.

```bash
# 1. Post a real task spec with genuine room for disagreement:
curl -s -X POST http://10.129.1.15:8102/turns -H "Authorization: Bearer $MEMORY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"dc-test-1","agent":"human","role":"user",
       "raw":"Write a function that merges two sorted lists in place, without allocating a new list."}'

# 2. Publish to the dualcoder topic:
curl -s -X POST http://10.129.1.15:8101/messages -H "Authorization: Bearer $BUZZ_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"from":"human","topic":"dualcoder","task_id":"dc-test-1"}'

# 3. Poll and confirm the REAL state sequence, not a jump to a terminal state:
watch -n 5 'curl -s http://10.129.1.15:8102/tasks/dc-test-1 -H "Authorization: Bearer $MEMORY_TOKEN"'
#   drafting -> review-round-1 -> ... -> security-review -> security-meta-review -> done/unresolved

# 4. Confirm one turns row per actual model call -- a "complete" task with only one or two turns
#    logged is the fabrication pattern to watch for (LESSONS_LEARNED.md §2g). This should now
#    include one `static-scan` phase turn ahead of the two `security-review` turns:
curl -s "http://10.129.1.15:8102/turns?task_id=dc-test-1" -H "Authorization: Bearer $MEMORY_TOKEN"

# 5. Cross-check hermes-router's own usage log for real role=coder2 entries during the run window --
#    independent confirmation coder2 was actually called, not just claimed.
```

**Force the non-convergence path at least once**, separately: temporarily set `MAX_ROUNDS=1`
against a task worded to provoke disagreement, and confirm both:
- the `third-party-review` state fires and a real `hermes-nous-judge.py` call happens (check its
  own notify-once state file / usage ledger for a genuine new entry);
- with the judge itself made to fail, `UNRESOLVED` still fires cleanly with an honest "judge
  unavailable" note — never a fabricated verdict.

This pair of checks is the single highest-value verification here — "silently fail open" is the one
behavior that must never happen at the round cap, the judge call, or the judge verdict.

## 3. Known gaps, not yet closed

- No resync sweep for a mid-round crash/restart — same "no urgency yet" reasoning
  `hermes-forge-residency.py`'s own drain/restore logic already uses; a restart mid-task currently
  loses that task's in-flight round (the `turns` transcript up to that point survives, the task
  itself does not resume).
- The wake-worker claim-scoping fix (`hermes-broker.py` 1.4.0) narrows the *known* race but hasn't
  been stress-tested under real concurrent load from both nodes simultaneously — do that before
  trusting this under heavy fleet-wide `nano`/`super`/`coder` wake traffic.
- `coder2`'s exact `llama-server` flags (`start-coder2.sh`) are a first pass adapted from `coder`'s
  own real flags, not yet confirmed optimal for Muse Glimmer's own architecture.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.0 | 2026-09-05 | Security phase now runs a real static-analysis pass (`infra/hermes-code-security-scan/`) before either model's security review, feeding real findings into both prompts as grounding — see `tools/hermes-dualcoder.py` 1.1.0's own changelog. |
| 1.0.0 | 2026-09-05 | Initial version — dual-coder review orchestrator, direct operator request following the real coder/coder2 bake-off. |
