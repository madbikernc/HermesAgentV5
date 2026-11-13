#!/usr/bin/env python3
# Version: 1.0.1
#
# 1.0.1 (2026-11-13) — outcomes go to a temp file, never the real ~/.hermes log.
#
# 1.0.0 (2026-11-13) — offline checks for tools/hermes-self-repair-promote-gate.py's
# handle_command(): which states "promote"/"skip" are legal from (gate 1.2.0: "skip" also
# declines a task parked in "awaiting-completeness"). hermes-memory and Matrix are stubbed.
#
# Run: python3 infra/hermes-self-repair/tests/test_promote_gate.py

import importlib.util
import sys
from pathlib import Path

import tempfile as _tempfile
import os as _os
_os.environ["SELFREPAIR_OUTCOMES"] = str(Path(_tempfile.mkdtemp(prefix="selfrepair-test-")) / "outcomes.jsonl")

TOOLS = Path(__file__).resolve().parents[3] / "tools"
FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    print(f"  {'ok  ' if cond else 'FAIL'} {label}" + ("" if cond else f" {detail}"))
    if not cond:
        FAILURES.append(label)


def load():
    spec = importlib.util.spec_from_file_location("gate_test_target", TOOLS / "hermes-self-repair-promote-gate.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(mod, action, state, sha="abc123def4567890"):
    """handle_command() against one fake task; returns (new state or None, room messages)."""
    written, said = [], []
    mod.fetch_task = lambda task_id: {"id": task_id, "state": state}
    mod.fetch_applied_sha = lambda task_id: sha
    mod.set_task_state = lambda task_id, new: written.append(new)
    mod.write_turn = lambda task_id, turn: None
    mod.send_room_message = said.append
    mod.handle_command(action, "t1")
    return (written[-1] if written else None), said


def main():
    mod = load()
    print("[skip]")
    new, said = run(mod, "skip", "awaiting-completeness")
    check("skip declines a task parked in awaiting-completeness (the 2026-11-13 refusals)",
          new == "promotion-declined", (new, said))
    check("and says so in the room", any("marked declined" in m for m in said), said)
    new, _ = run(mod, "skip", "verified")
    check("skip still declines a verified task", new == "promotion-declined", new)
    for state in ("drafting", "review-round-2", "done", "error", "promotion-approved", "promoted",
                  "promotion-declined"):
        new, said = run(mod, "skip", state)
        check(f"skip is refused from {state!r}", new is None and any("not awaiting" in m for m in said),
              (new, said))
    print("[promote]")
    new, said = run(mod, "promote", "awaiting-completeness")
    check("promote is still refused while awaiting completeness",
          new is None and any("not awaiting" in m for m in said), (new, said))
    new, _ = run(mod, "promote", "verified")
    check("promote from verified still approves", new == "promotion-approved", new)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
