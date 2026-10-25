#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-25) -- generalized from a single hardcoded one-time run into a reusable tool:
# --nodes and --tag replace the hardcoded RESET_NODES/"2026-10-09" literals. A second, unrelated
# aide-exclude round (new noise found live: docker overlay2, llama.cpp build output, multi-arch
# kernel headers/firmware, /run churn -- see infra/hermes-node-baseline/README.md's 2026-10-25
# entry) needed the exact same bulk-resolve shape against a different node set and a different
# stale-backlog size, and copy-pasting the whole file a second time for one date literal was worse
# than parameterizing it. The safety property that matters -- this never runs without an explicit,
# named node list -- is unchanged and, if anything, stronger: there is no default node set a future
# caller could forget to check, since --nodes is now required rather than a module constant.
"""
hermes-baseline-backlog-cleanup.py -- bulk-resolve the pending `aide` REC-* backlog that predates
a fleet node's own `aide --init` baseline reset. Reusable across resets; every invocation names
its own node set and a tag (used for the tracking-task id and the local per-id log filename),
rather than assuming a single historical event.

Why this is safe for `aide` findings specifically, and ONLY for aide, and ONLY for a named node:
a pending aide finding is a diff against a specific baseline database. Once that node's `aide
--init` has actually been re-run (with new excludes in place), the baseline every PRIOR pending
finding on that node was compared against no longer exists -- it has no continued meaning. If the
same real change is still present relative to TODAY's baseline, the next real scan flags it again,
fresh. `grype`/`lynis` findings are NEVER touched by this tool -- they have nothing to do with
aide's baseline and may still be genuinely open (an unpatched CVE doesn't become patched because
aide got re-initialized).

**`--nodes` must be named explicitly every run -- a real bug in the first-ever run (2026-10-09)
made this a hard requirement, not a convenience.** That run had no node filter at all and
bulk-resolved LinodeMercury's 12 then-pending aide findings too, even though LinodeMercury's own
baseline was last reset during S29 (unrelated to that run's S30 reset) and none of its findings
were invalidated by anything S30 did. Caught immediately by cross-checking the per-id cleanup log
against which nodes S30 actually touched; all 12 were reverted to `pending` by hand before the fix
landed. The lesson generalizes: this tool must never infer "which nodes" from the data itself (a
bare `tool == 'aide'` check) -- the caller states the node set and tag by hand, on purpose, every
time, matching whichever nodes actually just got a real `aide --init` reset.

Deliberately does NOT write one `/turns` audit entry per resolved task: hermes-memory.py's
`_create_turn()` calls `embed(raw)` on every turn write, and a backlog at this scale (138,866 the
first time) would mean as many embedding calls competing with the fleet's real embed role for no
operational benefit -- confirmed live by reading hermes-memory.py's own handler before assuming
"resolve one at a time" was fine at this scale (resolve_recommendation()'s own per-task turn write
is correct at the normal day-to-day volume of a handful of findings; it is not a pattern to replay
at backlog scale). Instead: one `/tasks` POST per task (cheap -- no embedding, confirmed by reading
`_upsert_task()`), preserving that task's own existing `agent`/`topic` (the upsert overwrites both
unconditionally, so sending the wrong one would corrupt it), and exactly ONE summary turn at the
end, attached to a new tracking task tagged with `--tag`, describing the whole operation -- plus a
local, non-memory log of every affected REC id for anyone who wants the full list without one
embedding per id existing for it.

Usage:
  hermes-baseline-backlog-cleanup.py --nodes spark,spark-2,homed13 --tag 2026-10-09 \
      --memory-token $MEMORY_TOKEN --dry-run   # count + list what would change, write nothing
  hermes-baseline-backlog-cleanup.py --nodes spark,spark-2,homed13 --tag 2026-10-25 \
      --memory-token $MEMORY_TOKEN             # real run
"""
import argparse
import json
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

MEMORY_DB = "/mnt/hermes-data/memory/memory.db"
MEMORY_URL = "http://10.129.1.15:8102"
AGENT_NAME = "node-baseline-cleanup"
CONCURRENCY = 20


def ro_conn():
    return sqlite3.connect(f"file:{MEMORY_DB}?mode=ro", uri=True, timeout=30)


def find_pending_aide(reset_nodes):
    """One SQL join, not one Python-side turn lookup per task -- confirmed live at 138,866 rows
    this takes ~2s against the real table, matched against each task's FIRST turn (the one
    write_recommendation() wrote, carrying tool/severity/description), not whatever turn happens
    to be latest. `reset_nodes` is never inferred from the data -- see the module docstring on why
    that's a hard requirement, not a convenience, after the 2026-10-09 LinodeMercury near-miss."""
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
                and payload.get("node") in reset_nodes):
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


def write_summary_turn(memory_token, total, ok, failed_ids, tag, reset_nodes, log_path):
    tracking_id = f"REC-cleanup-{tag}"
    now = datetime.now(timezone.utc).isoformat()
    req = urllib.request.Request(
        f"{MEMORY_URL}/tasks", data=json.dumps({
            "id": tracking_id, "agent": AGENT_NAME, "topic": "node-baseline-cleanup",
            "state": "resolved",
        }).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {memory_token}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()

    summary = (
        f"{tag} cleanup, {now}: bulk-resolved {ok}/{total} pending aide REC-* tasks "
        f"(tool=='aide' AND state=='pending' AND node in {sorted(reset_nodes)}) following an aide "
        f"exclude fix and a fresh aide --init baseline reset on those nodes -- every one of them "
        f"was a diff against a baseline that no longer exists. grype/lynis findings were "
        f"deliberately left untouched; they are independent of aide's baseline and may still be "
        f"genuinely open. {len(failed_ids)} failed and were left pending for retry. Full "
        f"affected-id list: {log_path}."
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
    parser = argparse.ArgumentParser(description="Bulk-resolve a stale pending-aide backlog")
    parser.add_argument("--nodes", required=True,
                         help="comma-separated node names whose aide baseline was just reset "
                              "(must match the 'node' field scanners write, e.g. spark,spark-2,"
                              "homed13) -- never inferred, see module docstring")
    parser.add_argument("--tag", required=True,
                         help="label for this run, e.g. 2026-10-25 -- used for the tracking-task "
                              "id (REC-cleanup-<tag>) and the local per-id log filename")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--memory-token", required=True)
    args = parser.parse_args()

    reset_nodes = {n.strip() for n in args.nodes.split(",") if n.strip()}
    log_path = Path.home() / ".hermes" / "state" / f"baseline-cleanup-{args.tag}.log"

    targets = find_pending_aide(reset_nodes)
    print(f"[hermes-baseline-backlog-cleanup] {len(targets)} pending aide REC-* tasks to resolve "
          f"for nodes={sorted(reset_nodes)}")

    if args.dry_run:
        print("--dry-run: nothing written")
        return

    ok, failed_ids = 0, []
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w") as logf, ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
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
    tracking_id = write_summary_turn(args.memory_token, len(targets), ok, failed_ids, args.tag,
                                      reset_nodes, log_path)
    print(f"[hermes-baseline-backlog-cleanup] summary turn written under {tracking_id}")


if __name__ == "__main__":
    sys.exit(main())
