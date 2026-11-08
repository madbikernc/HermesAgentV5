#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for FLEET_SELFREPAIR_DESIGN.md §4.3's completeness hook (Phase 3, §8.3):
# tools/hermes_self_repair_completeness.py's own logic, plus the two new functions it drives in
# tools/hermes-self-repair-apply.py (finalize_or_wait(), unblock_linked_peer()). No live
# hermes-memory, no git, no filesystem writes outside this process -- every network call either
# module would make is monkeypatched onto an in-memory FakeMemory, the same spirit (not the same
# code) as infra/hermes-fleetops-ui/tests/test_fleetops_ui.py's FakeGate doubles.
#
# Run: python3 infra/hermes-self-repair/tests/test_completeness.py

import importlib.util
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"

NL = chr(10)
FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class FakeMemory:
    """id-keyed tasks + turns, same shape hermes-memory's own /tasks/<id> and
    /turns?task_id=<id> responses already have (task: {"state": ...}; turn: {"id": int, "raw": str
    JSON})."""

    def __init__(self):
        self.tasks = {}
        self.turns = {}
        self._next_turn_id = 1

    def add_task(self, task_id, state):
        self.tasks[task_id] = {"id": task_id, "state": state}
        self.turns.setdefault(task_id, [])

    def add_turn(self, task_id, payload):
        self.turns.setdefault(task_id, []).append({"id": self._next_turn_id, "raw": json.dumps(payload)})
        self._next_turn_id += 1

    def set_state(self, task_id, state):
        self.tasks.setdefault(task_id, {"id": task_id})["state"] = state


def patch_completeness(mod, mem):
    def fetch_turns(task_id):
        return list(mem.turns.get(task_id, []))

    def fetch_task_state(task_id):
        return mem.tasks.get(task_id, {}).get("state")

    mod.fetch_turns = fetch_turns
    mod.fetch_task_state = fetch_task_state


def check_completeness_module():
    print("\n[hermes_self_repair_completeness: pure domain logic]")
    mod = load("completeness_test_target", "hermes_self_repair_completeness.py")
    mem = FakeMemory()
    patch_completeness(mod, mem)

    check("no domain -> always satisfied",
          mod.completeness_satisfied("t1", None) == (True, "no completeness rule for this domain/task"))

    no_rule_domain = {"name": "bare", "completeness_rule": None}
    check("domain with no completeness_rule -> always satisfied",
          mod.completeness_satisfied("t1", no_rule_domain)[0] is True)

    domain = {"name": "minecraft-bots", "completeness_rule": "test-artifact"}

    mem.add_task("fix1", "verified")
    ok, note = mod.completeness_satisfied("fix1", domain)
    check("fix task with no link turn at all -> refused", ok is False, note)
    check("refusal note names the link tool", "hermes-self-repair-link.py" in note, note)

    mem.add_task("fix2", "done")
    mem.add_task("test2", "drafting")
    mem.add_turn("fix2", {"phase": "completeness-link", "role": "fix", "linked_task_id": "test2"})
    mem.add_turn("test2", {"phase": "completeness-link", "role": "test", "linked_task_id": "fix2"})
    ok, note = mod.completeness_satisfied("fix2", domain)
    check("fix task linked to a not-yet-verified test task -> refused", ok is False, note)
    check("refusal note names the linked task's real state", "state='drafting'" in note, note)

    mem.set_state("test2", "verified")
    ok, note = mod.completeness_satisfied("fix2", domain)
    check("fix task linked to a now-verified test task -> satisfied", ok is True, note)

    ok, note = mod.completeness_satisfied("test2", domain)
    check("the test task itself is never subject to the rule, even though it shares the domain's "
          "own path scope", ok is True, note)

    mem.add_task("fix3", "done")
    mem.add_turn("fix3", {"phase": "completeness-link", "role": "fix", "linked_task_id": "missing9"})
    ok, note = mod.completeness_satisfied("fix3", domain)
    check("fix task linked to a task that doesn't exist -> refused, not a crash", ok is False, note)

    unknown_rule_domain = {"name": "weird", "completeness_rule": "no-such-rule"}
    ok, note = mod.completeness_satisfied("fix1", unknown_rule_domain)
    check("unrecognized completeness_rule value -> fails closed, not open", ok is False, note)


def load_apply_module():
    os.environ["SELF_REPAIR_READ_TOOL"] = str(TOOLS / "hermes-self-repair-read.py")
    os.environ["SELF_REPAIR_VERIFY_TOOL"] = str(TOOLS / "hermes-self-repair-verify.py")
    os.environ.setdefault("SELF_REPAIR_REPO_DIR", str(REPO))
    os.environ.setdefault("GIT_REMOTE", "nas2-selfrepair")
    sys.path.insert(0, str(TOOLS))
    return load("apply_test_target", "hermes-self-repair-apply.py")


def check_apply_finalize_or_wait():
    print("\n[hermes-self-repair-apply.py: finalize_or_wait() / unblock_linked_peer()]")
    apply_mod = load_apply_module()
    mem = FakeMemory()
    patch_completeness(apply_mod.completeness_mod, mem)

    calls = {"promotion_offers": [], "state_posts": [], "turns": []}

    def fake_get(url, token=None, timeout=15):
        if "/tasks/" in url:
            task_id = url.rsplit("/", 1)[-1]
            return mem.tasks.get(task_id, {})
        if "/turns" in url:
            task_id = url.split("task_id=")[1].split("&")[0]
            return {"turns": mem.turns.get(task_id, [])}
        raise AssertionError(f"unexpected GET {url}")

    def fake_post(url, payload, token=None, timeout=15):
        if url.endswith("/tasks"):
            mem.set_state(payload["id"], payload["state"])
            calls["state_posts"].append((payload["id"], payload["state"]))
            return {}
        if url.endswith("/turns"):
            mem.add_turn(payload["task_id"], json.loads(payload["raw"]))
            calls["turns"].append((payload["task_id"], json.loads(payload["raw"]).get("phase")))
            return {"id": 0}
        raise AssertionError(f"unexpected POST {url}")

    apply_mod._get = fake_get
    apply_mod._post = fake_post
    apply_mod.post_promotion_offer = lambda task_id, path, sha: calls["promotion_offers"].append(task_id)
    apply_mod.matrix_notice = lambda text: None

    domains_fake_path = {
        "services/minecraft-bots/foo.mjs": {"name": "minecraft-bots", "completeness_rule": "test-artifact"},
    }
    apply_mod.domains_mod.domain_for_path = lambda path: domains_fake_path.get(path)

    # 1. A task with no registered domain finalizes exactly as before this hook existed.
    mem.add_task("plain1", "done")
    apply_mod.finalize_or_wait("plain1", "tools/hermes-code.py", "deadbeef")
    check("no-domain task finalizes straight to verified",
          mem.tasks["plain1"]["state"] == "verified")
    check("no-domain task still gets its promotion offer (sha was provided)",
          "plain1" in calls["promotion_offers"])

    # 2. A minecraft-bots fix task, no linked test yet -> parks in awaiting-completeness.
    mem.add_task("fixA", "done")
    # Real do_apply() always logs the applied-commit turn (log_applied_commit()) before ever
    # calling finalize_or_wait() -- simulate that same precondition here, since
    # unblock_linked_peer() later needs fetch_applied_sha("fixA") to actually find something.
    mem.add_turn("fixA", {"phase": "applied-commit", "sha": "cafef00d", "remote": "x", "branch": "y"})
    apply_mod.finalize_or_wait("fixA", "services/minecraft-bots/foo.mjs", "cafef00d")
    check("unlinked minecraft-bots fix task is parked, not verified",
          mem.tasks["fixA"]["state"] == "awaiting-completeness")
    check("parked task logs a completeness-wait turn",
          ("fixA", "completeness-wait") in calls["turns"])
    check("parked task gets no promotion offer yet",
          "fixA" not in calls["promotion_offers"])

    # 3. Link it to a test task that hasn't verified yet -- still parked.
    mem.add_task("testA", "drafting")
    mem.add_turn("fixA", {"phase": "completeness-link", "role": "fix", "linked_task_id": "testA"})
    mem.add_turn("testA", {"phase": "completeness-link", "role": "test", "linked_task_id": "fixA"})
    mem.add_turn("fixA", {"path": "services/minecraft-bots/foo.mjs", "problem": "x"})  # original spec turn
    apply_mod.finalize_or_wait("fixA", "services/minecraft-bots/foo.mjs", "cafef00d")
    check("linked-but-not-verified fix task is still parked",
          mem.tasks["fixA"]["state"] == "awaiting-completeness")

    # 4. The test task itself finishes (finalize_or_wait called on IT) -- its own domain lookup
    #    would normally resolve from ITS OWN path (e.g. services/minecraft-bots/tests/unit.test.mjs),
    #    which also falls under the same domain in a real registration; simulate that directly.
    domains_fake_path["services/minecraft-bots/tests/unit.test.mjs"] = domains_fake_path["services/minecraft-bots/foo.mjs"]
    apply_mod.finalize_or_wait("testA", "services/minecraft-bots/tests/unit.test.mjs", "f00dbabe")
    check("test task itself always finalizes to verified (no completeness requirement of its own)",
          mem.tasks["testA"]["state"] == "verified")
    check("test task's own completion gets its own promotion offer",
          "testA" in calls["promotion_offers"])
    check("unblock_linked_peer flipped the waiting fix task to verified too",
          mem.tasks["fixA"]["state"] == "verified")
    check("unblocked fix task's own (earlier-parked) promotion offer fires on the unblock",
          "fixA" in calls["promotion_offers"])

    # 5. Reverse ordering: test verifies first, fix finishes second -- no unblock step needed at
    #    all, finalize_or_wait's own inline completeness_satisfied() call already sees it.
    mem.add_task("fixB", "done")
    mem.add_task("testB", "verified")
    mem.add_turn("fixB", {"phase": "completeness-link", "role": "fix", "linked_task_id": "testB"})
    mem.add_turn("testB", {"phase": "completeness-link", "role": "test", "linked_task_id": "fixB"})
    apply_mod.finalize_or_wait("fixB", "services/minecraft-bots/foo.mjs", "0000ffff")
    check("fix task finishing AFTER its already-verified test task goes straight to verified",
          mem.tasks["fixB"]["state"] == "verified")
    check("that straight-through path still gets its promotion offer",
          "fixB" in calls["promotion_offers"])


def main():
    check_completeness_module()
    check_apply_finalize_or_wait()
    total = CHECKS[0]
    failed = len(FAILURES)
    print(f"\n{total - failed}/{total} checks passed")
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
