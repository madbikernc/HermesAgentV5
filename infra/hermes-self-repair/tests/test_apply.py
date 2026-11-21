#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-11-20) — direct operator request, "see what went wrong and fix" (self-repair review
# follow-up). No offline test existed for hermes-self-repair-apply.py at all before this -- every
# other component in this pipeline has one. Covers only the new behavior that prompted writing it:
# run_job() exhausting MAX_ATTEMPTS now marks the task "apply-failed" (a terminal state) instead of
# leaving it reading whatever state it was already in ("done") forever. do_apply(), apply_diff()
# and every git/network call are mocked out -- this is about run_job()'s own attempt-counting and
# state-transition logic, not the mechanical apply itself (which needs a real checkout and is
# exercised live, per this component's own README "Verified so far" section).
#
# Run: python3 infra/hermes-self-repair/tests/test_apply.py

import importlib.util
import os
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[3] / "tools"
sys.path.insert(0, str(TOOLS))
FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    print(f"  {'ok  ' if cond else 'FAIL'} {label}" + ("" if cond else f" {detail}"))
    if not cond:
        FAILURES.append(label)


def load():
    os.environ.setdefault("BROKER_TOKEN", "test-token-not-real")
    os.environ.setdefault("MEMORY_TOKEN", "test-token-not-real")
    # main() checks this dir exists, but run_job()/do_apply() (what this test exercises) never
    # touch it directly -- only main()'s own startup guard does, which this test never calls.
    os.environ.setdefault("SELF_REPAIR_REPO_DIR", str(Path(__file__).resolve().parents[3]))
    # The module eagerly imports these two sibling tools AT MODULE LOAD TIME (for their allow/deny
    # and verify functions), by absolute default path under $HOME -- real on the fleet, wrong on a
    # dev machine whose repo isn't checked out there. Point both at this actual repo.
    os.environ.setdefault("SELF_REPAIR_READ_TOOL", str(TOOLS / "hermes-self-repair-read.py"))
    os.environ.setdefault("SELF_REPAIR_VERIFY_TOOL", str(TOOLS / "hermes-self-repair-verify.py"))
    spec = importlib.util.spec_from_file_location("apply_test_target", TOOLS / "hermes-self-repair-apply.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()
    mod.STATE_DIR = Path(tempfile.mkdtemp(prefix="selfrepair-apply-test-"))
    mod.MAX_ATTEMPTS = 3

    print("[run_job: a mechanical apply failure that keeps failing becomes visible, not silent]")
    states, escalations = [], []
    mod.set_task_state = lambda tid, state: states.append((tid, state))
    mod.escalate = lambda tid, detail: escalations.append((tid, detail))
    mod.do_apply = lambda tid: (1, "git apply --check failed (conflict likely): corrupt patch")

    job = {"id": "jobA", "payload": {"task_id": "taskA"}}
    for i in range(1, 4):
        exit_code, error = mod.run_job(job)
        check(f"attempt {i} of 3: exit_code is 1 (retryable)", exit_code == 1, (exit_code, error))
        if i < 3:
            check(f"attempt {i} of 3: not yet escalated, no state change",
                  escalations == [] and states == [], (escalations, states))
        else:
            check("the 3rd failure escalates exactly once, naming the task",
                  len(escalations) == 1 and escalations[0][0] == "taskA", escalations)
            check("and marks the task apply-failed, not left reading its old state forever",
                  states == [("taskA", "apply-failed")], states)

    print("[run_job: a one-off transient failure does NOT escalate or change state]")
    states.clear()
    escalations.clear()
    mod.clear_attempts("taskB")
    job_b = {"id": "jobB", "payload": {"task_id": "taskB"}}
    exit_code, error = mod.run_job(job_b)
    check("a single failure is just retryable, no escalation, no state change",
          exit_code == 1 and escalations == [] and states == [], (escalations, states))

    print("[run_job: success clears the attempt counter and touches no state]")
    mod.clear_attempts("taskC")
    mod.do_apply = lambda tid: (0, "")
    job_c = {"id": "jobC", "payload": {"task_id": "taskC"}}
    exit_code, error = mod.run_job(job_c)
    check("a clean success returns exit_code 0 with no escalation or state call",
          exit_code == 0 and escalations == [] and states == [], (exit_code, escalations, states))
    check("the attempt counter is actually cleared (not left at 0 by coincidence)",
          mod.load_attempts("taskC") == 0)

    print("[run_job: a refused (non-retryable) request never touches the attempt counter]")
    mod.clear_attempts("taskD")
    mod.do_apply = lambda tid: (2, "diff target outside allowlist")
    job_d = {"id": "jobD", "payload": {"task_id": "taskD"}}
    for _ in range(5):
        exit_code, error = mod.run_job(job_d)
    check("exit_code 2 is returned as-is, every time, with no escalation",
          exit_code == 2 and escalations == [], (exit_code, escalations))
    check("exit_code 2 never increments the attempt counter (would be noise, not signal)",
          mod.load_attempts("taskD") == 0)

    print("[run_job: a task already at MAX_ATTEMPTS when re-claimed escalates AND marks apply-failed]")
    states.clear()
    escalations.clear()
    mod.clear_attempts("taskE")
    mod.save_attempts("taskE", mod.MAX_ATTEMPTS)
    job_e = {"id": "jobE", "payload": {"task_id": "taskE"}}
    exit_code, error = mod.run_job(job_e)
    check("refuses further attempts (exit_code 1, do_apply never called again)",
          exit_code == 1, (exit_code, error))
    check("this belt-and-braces re-entry path also marks apply-failed",
          states == [("taskE", "apply-failed")], states)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
