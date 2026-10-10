#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-baseline-backlog-cleanup.py — one-time bulk resolution of the 138,866-row pending `aide`
backlog found while building `hermes-fleetops-ui`'s `/recommendations` page (S21h) and fixed at
the root cause by S30's aide excludes + fleet-wide `aide --init` reset (spark/spark-2/HomeD13,
2026-10-09).

Why this is safe for `aide` findings specifically, and ONLY for aide: every one of them was
recorded as a diff against a baseline database that no longer exists -- S30 re-ran `aide --init`
on all three nodes after the excludes were in place, so the "baseline" every pending aide finding
was compared against has been fully replaced. A pending aide finding from before the reset has no
continued meaning: if the same real change is still present relative to TODAY's baseline, the
next real scan will flag it again, fresh. `grype` (849 pending) and `lynis` (1 pending) findings
are NOT touched -- they have nothing to do with aide's baseline and may still be genuinely open
(an unpatched CVE doesn't become patched because aide got re-initialized).

**Scoped to spark/spark-2/HomeD13 only (`RESET_NODES`) -- a real bug in the first real run, found
and fixed the same day.** The first version had no node filter at all and bulk-resolved
LinodeMercury's 12 then-pending aide findings too, even though LinodeMercury's own baseline was
last reset during S29 (unrelated to S30) and none of its findings were invalidated by anything
S30 did. Caught immediately by cross-checking the per-id log against which nodes S30 actually
touched; all 12 were reverted to `pending` by hand before this fix landed, and the "aide finding
predates a reset baseline" justification below only ever applies to a node whose baseline this
tool's caller actually reset.

Deliberately does NOT write one `/turns` audit entry per resolved task: hermes-memory.py's
`_create_turn()` calls `embed(raw)` on every turn write, so 138,866 individual turns would mean
138,866 embedding calls competing with the fleet's real embed role for no operational benefit --
confirmed live by reading hermes-memory.py's own handler before assuming "resolve one at a time"
was fine at this scale (resolve_recommendation()'s own per-task turn write is correct at the
normal day-to-day volume of a handful of findings; it is not a pattern to replay 138,866 times).
Instead: one `/tasks` POST per task (cheap -- no embedding, confirmed by reading `_upsert_task()`),
preserving that task's own existing `agent`/`topic` (the upsert overwrites both unconditionally,
so sending the wrong one would corrupt it), and exactly ONE summary turn at the end, attached to a
new tracking task, describing the whole operation -- plus a local, non-memory log of every
affected REC id for anyone who wants the full list without 138,866 embeddings existing for it.

Usage:
  hermes-baseline-backlog-cleanup.py --dry-run   # count + list what would change, write nothing
  hermes-baseline-backlog-cleanup.py             # real run
"""
import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

MEMORY_DB = "/mnt/hermes-data/memory/memory.db"
MEMORY_URL = "http://10.129.1.15:8102"
AGENT_NAME = "node-baseline-cleanup"
LOG_PATH = Path.home() / ".hermes" / "state" / "baseline-cleanup-2026-10-09.log"
CONCURRENCY = 20


def ro_conn():
    return sqlite3.connect(f"file:{MEMORY_DB}?mode=ro", uri=True, timeout=30)


#  The *only* nodes whose aide baseline S30 actually reset. This scoping is not optional --
# found live, the hard way: the first real run of this script had no node filter at all, and
# bulk-resolved LinodeMercury's 12 then-pending aide findings too, even though LinodeMercury's
# baseline was last reset during S29 (unrelated to S30) and none of its pending findings were
# invalidated by anything S30 did. Caught immediately after by cross-checking the per-id cleanup
# log against which nodes S30 actually touched -- all 12 were reverted to `pending` by hand
# before this fix landed. A future node added to this fleet's aide rollout does not get swept up
# by a bare `tool == 'aide'` check; it has to be named here explicitly, on purpose.
RESET_NODES = {"spark", "spark-2", "homed13"}


def find_pending_aide():
    """One SQL join, not 139,853 Python-side turn lookups -- confirmed live this takes ~2s
    against the real table, matched against each task's FIRST turn (the one write_recommendation()
    wrote, carrying tool/severity/description), not whatever turn happens to be latest."""
    conn = ro_conn()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("""
            SELECT t.id, t.agent, t.topic, tu.raw FROM tasks t
            JOIN turns tu ON tu.task_id = t.id
            WHERE t.id LIKE 'REC-%' AND t.state = 'pending'
              AND tu.id = (SELECT MIN(id) FROM turns WHERE task_id = t.id)
        """).fetchall()
    finally:
        conn.close()

    targets = []
    for r in rows:
        try:
            payload = json.loads(r["raw"])
        except (ValueError, TypeError):
            continue
        if (isinstance(payload, dict) and payload.get("tool") == "aide"
                and payload.get("node") in RESET_NODES):
            targets.append({"id": r["id"], "agent": r["agent"], "topic": r["topic"]})
    return targets


def resolve_task(task, memory_token):
    """A plain /tasks upsert -- no embedding call, confirmed by reading hermes-memory.py's
    _upsert_task() before relying on it. Preserves the task's own agent/topic; the upsert
    overwrites both unconditionally regardless of what's sent."""
    body = json.dumps({
        "id": task["id"], "agent": task["agent"], "topic": task["topic"], "state": "resolved",
    }).encode()
    req = urllib.request.Request(
        f"{MEMORY_URL}/tasks", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {memory_token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return task["id"], True, None
    except Exception as exc:
        return task["id"], False, str(exc)


def write_summary_turn(memory_token, total, ok, failed_ids):
    tracking_id = "REC-cleanup-2026-10-09"
    now = datetime.now(timezone.utc).isoformat()
    for url, data in (
        (f"{MEMORY_URL}/tasks", {"id": tracking_id, "agent": AGENT_NAME,
                                  "topic": "node-baseline-cleanup", "state": "resolved"}),
    ):
        req = urllib.request.Request(
            url, data=json.dumps(data).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {memory_token}"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()

    summary = (
        f"S30 follow-up, {now}: bulk-resolved {ok}/{total} pending aide REC-* tasks "
        f"(tool=='aide' AND state=='pending') following S30's aide exclude fix and the "
        f"fleet-wide aide --init baseline reset on spark/spark-2/HomeD13 (2026-10-09) -- every "
        f"one of them was a diff against a baseline that no longer exists. grype (849 pending) "
        f"and lynis (1 pending) findings were deliberately left untouched; they are independent "
        f"of aide's baseline and may still be genuinely open. {len(failed_ids)} failed and were "
        f"left pending for retry. Full affected-id list: {LOG_PATH}."
    )
    turn_req = urllib.request.Request(
        f"{MEMORY_URL}/turns", data=json.dumps({
            "task_id": tracking_id, "agent": AGENT_NAME, "role": "system", "raw": summary,
        }).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {memory_token}"})
    with urllib.request.urlopen(turn_req, timeout=30) as resp:
        resp.read()
    return tracking_id


def main():
    parser = argparse.ArgumentParser(description="Bulk-resolve the pre-S30 pending aide backlog")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--memory-token", required=True)
    args = parser.parse_args()

    targets = find_pending_aide()
    print(f"[hermes-baseline-backlog-cleanup] {len(targets)} pending aide REC-* tasks to resolve")

    if args.dry_run:
        print("--dry-run: nothing written")
        return

    ok, failed_ids = 0, []
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "w") as logf, ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(resolve_task, t, args.memory_token): t for t in targets}
        done = 0
        for fut in as_completed(futures):
            task_id, success, err = fut.result()
            done += 1
            if success:
                ok += 1
                logf.write(f"{task_id}\tresolved\n")
            else:
                failed_ids.append(task_id)
                logf.write(f"{task_id}\tFAILED\t{err}\n")
            if done % 5000 == 0:
                print(f"[hermes-baseline-backlog-cleanup] {done}/{len(targets)} "
                      f"({ok} ok, {len(failed_ids)} failed)")

    print(f"[hermes-baseline-backlog-cleanup] done: {ok} resolved, {len(failed_ids)} failed")
    tracking_id = write_summary_turn(args.memory_token, len(targets), ok, failed_ids)
    print(f"[hermes-baseline-backlog-cleanup] summary turn written under {tracking_id}")


if __name__ == "__main__":
    sys.exit(main())
