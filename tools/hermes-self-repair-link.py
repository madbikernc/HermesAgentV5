#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-self-repair-link — links two self-repair tasks for FLEET_SELFREPAIR_DESIGN.md §4.3's
# completeness hook (§6's "two linked tasks" answer, Phase 3/§8.3). Writes a
# phase="completeness-link" turn on EACH task naming the other's id and its own role ("fix" or
# "test") — tools/hermes_self_repair_completeness.py reads these back to decide whether a fix
# task's domain-required test artifact actually exists and has itself reached "verified" before
# the fix task becomes eligible for promotion/PR-opening (both already gate on state=="verified").
#
# This tool does not create tasks, only records a relationship between two that already exist —
# run by hand after submitting both via hermes-self-repair-submit.py, or called internally by the
# detection bridge (hermes-self-repair-minecraft-bridge.py, §4.4) right after it submits both.
#
# Usage:
#   python3 hermes-self-repair-link.py <fix_task_id> <test_task_id>
#
# Config:
#   MEMORY_URL/MEMORY_TOKEN   required, same as every other self-repair component

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


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def task_exists(task_id):
    try:
        _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN)
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def write_link_turn(task_id, role, linked_task_id):
    _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "selfrepair-link", "role": "assistant",
        "raw": json.dumps({"phase": "completeness-link", "role": role, "linked_task_id": linked_task_id}),
    }, MEMORY_TOKEN)


def link(fix_task_id, test_task_id):
    if not MEMORY_TOKEN:
        sys.exit("MEMORY_TOKEN is required")
    if fix_task_id == test_task_id:
        sys.exit("fix and test task ids must be different")
    for task_id in (fix_task_id, test_task_id):
        if not task_exists(task_id):
            sys.exit(f"no such task {task_id!r} in hermes-memory — submit it first "
                      f"(hermes-self-repair-submit.py)")
    write_link_turn(fix_task_id, "fix", test_task_id)
    write_link_turn(test_task_id, "test", fix_task_id)
    print(f"Linked fix task {fix_task_id} <-> test task {test_task_id}")


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: hermes-self-repair-link.py <fix_task_id> <test_task_id>")
    link(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    main()
