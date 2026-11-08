#!/usr/bin/env python3
# Version: 1.0.1
#
# 1.0.1 (2026-11-08) — corrected a stale filename reference below: the detection bridge was
# renamed hermes-self-repair-bridge.py in Phase 4 (§8.4), when it was generalized beyond
# minecraft-bots.
#
# hermes_self_repair_completeness — FLEET_SELFREPAIR_DESIGN.md §4.3's completeness hook, made
# concrete. Generic: a domain with no completeness_rule (no domain at all, or a domain that
# registers none) is always satisfied — Step 4's existing syntax/static-analysis gate
# (hermes-self-repair-verify.py) already covers that baseline for every domain, registered or not.
# A domain that DOES register a rule is checked here, by name, against hermes-memory's own turn
# history for the task — never by trusting anything the task spec itself claims, same "no LLM turn
# load-bearing for a privileged decision" posture the rest of this pipeline already holds.
#
# Domain #1's instance ("test-artifact", §6's "two linked tasks" answer — direct operator choice,
# 2026-11-08, Phase 3/§8.3, over the alternative of one task regenerating two files together): the
# fix and its test are two ordinary, independent self-repair tasks, each going through Steps 2-4
# completely unmodified — no change to hermes-self-repair-generate.py's or -apply.py's single-file
# draft/review/diff/commit loop, and no loosening of -apply.py's existing hardened refusal of any
# diff touching more than one file (parse_diff_path(), added after a real multi-file-diff attack-
# vector finding). What links the two tasks is a pair of plain hermes-memory turns
# (phase="completeness-link"), written by whichever tool submits both (a human running
# hermes-self-repair-link.py by hand, or the detection bridge automatically — §4.4,
# hermes-self-repair-bridge.py) — each turn names the OTHER task's id and this task's own
# role ("fix" or "test"). A "test" task is never itself subject to a completeness rule, checked by
# its recorded role rather than by re-deriving it from path_scope a second time — its own path still
# falls inside the same domain's path_scope (e.g. services/minecraft-bots/tests/unit.test.mjs is
# still under services/minecraft-bots/), and re-checking by path would walk straight into "does a
# test need its own test" infinite regress.
#
# hermes-self-repair-apply.py calls completeness_satisfied(task_id, domain) once, right before each
# of its two `set_task_state(task_id, "verified")` call sites (the empty-diff no-op path and the
# real-diff-passed-verify path). Not satisfied -> "awaiting-completeness" instead of "verified", and
# the task is NOT yet eligible for promotion/PR-opening (both already gate on state == "verified").
# Whichever of a linked pair's two tasks finishes its own apply+verify SECOND is responsible for
# re-checking (and, if now satisfied, finalizing) the OTHER one too — see
# hermes-self-repair-apply.py's unblock_linked_peer().
#
# Config: MEMORY_URL/MEMORY_TOKEN, same as every other self-repair component.

import json
import os
import sys
import urllib.error
import urllib.request

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def fetch_turns(task_id):
    return _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=200", MEMORY_TOKEN).get("turns", [])


def fetch_task_state(task_id):
    try:
        return _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN).get("state")
    except Exception:
        return None


def fetch_link(task_id, turns=None):
    """Returns the latest {"role", "linked_task_id"} this task was linked with, or None if no
    completeness-link turn has ever been written for it. Latest wins (same "re-read fresh, never
    cache" posture as every other lookup in this pipeline), though in practice a task is linked
    exactly once, right after both tasks are submitted."""
    turns = fetch_turns(task_id) if turns is None else turns
    link = None
    for t in turns:
        try:
            payload = json.loads(t.get("raw") or "{}")
        except (ValueError, json.JSONDecodeError):
            continue
        if payload.get("phase") == "completeness-link" and payload.get("linked_task_id"):
            link = {"role": payload.get("role"), "linked_task_id": payload["linked_task_id"]}
    return link


def completeness_satisfied(task_id, domain):
    """Returns (ok: bool, note: str). `domain` is the registry entry
    hermes_self_repair_domains.domain_for_path(path) returned for this task's own target path, or
    None if the path matches no registered domain."""
    rule = (domain or {}).get("completeness_rule")
    if not rule:
        return True, "no completeness rule for this domain/task"

    if rule == "test-artifact":
        link = fetch_link(task_id)
        if link is None:
            return False, (
                f"domain {domain.get('name', '?')!r} requires a linked test task (completeness "
                f"rule 'test-artifact') but none is linked yet — run "
                f"hermes-self-repair-link.py {task_id} <test_task_id> once the test task is "
                f"submitted"
            )
        if link["role"] == "test":
            return True, "this is the linked test task itself — no completeness requirement of its own"
        linked_state = fetch_task_state(link["linked_task_id"])
        if linked_state == "verified":
            return True, f"linked test task {link['linked_task_id']} is verified"
        return False, (
            f"linked test task {link['linked_task_id']} is not yet verified "
            f"(state={linked_state!r})"
        )

    return False, f"domain {domain.get('name', '?')!r} registers an unknown completeness_rule {rule!r} — refusing rather than guessing"


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: hermes_self_repair_completeness.py <task_id>  (prints the completeness link, if any)")
    task_id = sys.argv[1]
    try:
        link = fetch_link(task_id)
    except urllib.error.HTTPError as exc:
        sys.exit(f"lookup failed: {exc}")
    print(json.dumps(link, indent=2) if link else "no completeness link recorded for this task")


if __name__ == "__main__":
    main()
