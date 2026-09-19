#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-self-repair-submit — the deliberate, operator-run entry point for a new self-repair task.
# This IS Step 8's "operator command" trigger, made concrete — a standalone CLI a human runs
# directly, on purpose. Never reachable from hermes-dispatch.py's routing or hermes-presenter.py's
# chat, and deliberately not added to either: this project's own S10 precedent (gateway services
# excluded from remediation actions) applies here to self-repair generation too. If a future need
# for a chat-reachable trigger arises, that's a real design decision to make explicitly — not
# something to slip in as a routing-table entry alongside this file.
#
# Writes the task spec tools/hermes-self-repair-generate.py expects — JSON {"path", "problem"} —
# as a turn in hermes-memory, then publishes a pointer envelope (task_id/memory_ref only, never
# inline content) to the `selfrepair` Buzz topic. Same "pointer, not payload" invariant every other
# specialist's own ingress already follows (target §7.3, hermes-dispatch.py's own header).
#
# Usage:
#   python3 hermes-self-repair-submit.py <path> "<problem description>"
#
# Config:
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN   required, same as every other specialist

import json
import os
import sys
import urllib.request
import uuid

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def build_task(path, problem):
    """Split out from submit() so the payload shape can be unit-tested without hitting a real
    Buzz/hermes-memory endpoint. Returns (task_id, spec_json)."""
    task_id = uuid.uuid4().hex[:16]
    spec = json.dumps({"path": path, "problem": problem})
    return task_id, spec


def submit(path, problem):
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")

    task_id, spec = build_task(path, problem)

    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "operator", "role": "user", "raw": spec,
    }, MEMORY_TOKEN)

    _post(f"{BUZZ_URL}/messages", {
        "from": "operator", "topic": "selfrepair",
        "task_id": task_id, "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)

    print(f"Submitted self-repair task {task_id}")
    print(f"  path:    {path}")
    print(f"  problem: {problem}")
    print(f"\nTrack it with: python3 tools/hermes-self-repair-status.py {task_id}")
    return task_id


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: hermes-self-repair-submit.py <path> "<problem description>"')
    submit(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    main()
