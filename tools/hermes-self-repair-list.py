#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-self-repair-list — the listing hermes-memory's own HTTP API cannot give: `/tasks` is
# POST-only (upsert), confirmed the hard way while building hermes-fleetops-ui.py's own backlog
# page (`infra/hermes-fleetops-ui/README.md`, "The plan was wrong about the backlog source"), so
# "every self-repair task currently `verified`" has no HTTP route to ask for. Same answer that page
# already settled on: read the one non-vector `tasks` table read-only with stdlib sqlite3 — never
# hermes-memory's own connect(), which loads the sqlite-vec extension `/usr/bin/python3` cannot see.
#
# Self-repair tasks have no single stable `agent` owner the way model-scout's do (`model-scout`,
# unchanged for a task's whole life) — each pipeline phase stamps its OWN agent when it writes
# state (`selfrepair` from the generate step, `selfrepair-apply`, `selfrepair-promote-gate`,
# `selfrepair-promote`, `selfrepair-open-pr`), so a task's `agent` column just says who touched it
# last. `agent LIKE 'selfrepair%'` still reliably selects every self-repair task regardless of
# which phase last wrote it, because no other producer in this fleet uses an agent value starting
# with "selfrepair" (confirmed by reading every self-repair component's own set_task_state() call).
#
# This is run ON a fleet node (SSH, same as hermes-self-repair-status.py/-submit.py) — it is the
# listing half of §4.7's daily Claude Code review routine, which otherwise has no way to discover
# which tasks are newly `verified`: skills/fleet-selfrepair-review/SKILL.md names this script as
# its first step. It is read-only, holds no credential, and makes no write anywhere.
#
# Usage:
#   hermes-self-repair-list.py [--state STATE] [--domain NAME] [--without-pr]
#     --state     default "verified" (what the daily routine and the FleetOps UI both care about
#                 most); "all" for every self-repair task regardless of state.
#     --domain    filter to one registered domain's own path scope (see
#                 tools/hermes_self_repair_domains.py); "unregistered" for tasks under no domain.
#     --without-pr  only tasks with no phase="pr-opened" turn yet — exactly what
#                 hermes-self-repair-open-pr.py should be run against next.
#
# Config:
#   MEMORY_DB   default /mnt/hermes-data/memory/memory.db, same env var hermes-fleetops-ui.py and
#               hermes-model-scout.py already read this table from

import argparse
import json
import os
import sqlite3
import sys
import urllib.parse
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import hermes_self_repair_domains as domains_mod  # noqa: E402

MEMORY_DB = os.environ.get("MEMORY_DB", "/mnt/hermes-data/memory/memory.db")


def ro_sqlite(path):
    conn = sqlite3.connect(f"file:{urllib.parse.quote(str(path))}?mode=ro", uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def list_tasks(state="verified"):
    conn = ro_sqlite(MEMORY_DB)
    try:
        where = ["agent LIKE 'selfrepair%'"]
        params = []
        if state and state != "all":
            where.append("state = ?")
            params.append(state)
        clause = " AND ".join(where)
        tasks = conn.execute(
            f"SELECT id, state, topic, created_at, updated_at FROM tasks WHERE {clause} "
            f"ORDER BY updated_at DESC", params).fetchall()
        out = []
        for t in tasks:
            turns = conn.execute(
                "SELECT raw FROM turns WHERE task_id=? ORDER BY id ASC", (t["id"],)).fetchall()
            path, has_pr = None, False
            for row in turns:
                try:
                    payload = json.loads(row["raw"] or "{}")
                except (ValueError, TypeError):
                    continue
                if not isinstance(payload, dict):
                    continue
                if path is None and payload.get("path"):
                    path = payload["path"]
                if payload.get("phase") == "pr-opened":
                    has_pr = True
            domain = domains_mod.domain_for_path(path) if path else None
            out.append({
                "id": t["id"], "state": t["state"], "path": path,
                "domain": domain.get("name") if domain else "unregistered",
                "has_pr": has_pr, "updated_at": t["updated_at"],
            })
        return out
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default="verified")
    ap.add_argument("--domain", default=None)
    ap.add_argument("--without-pr", action="store_true")
    args = ap.parse_args()

    rows = list_tasks(args.state)
    if args.domain:
        rows = [r for r in rows if r["domain"] == args.domain]
    if args.without_pr:
        rows = [r for r in rows if not r["has_pr"]]

    if not rows:
        print(f"No self-repair tasks matching state={args.state!r}"
              f"{f', domain={args.domain!r}' if args.domain else ''}"
              f"{' without a PR yet' if args.without_pr else ''}.")
        return
    for r in rows:
        print(f"{r['id']}  state={r['state']}  domain={r['domain']}  "
              f"pr={'yes' if r['has_pr'] else 'no'}  path={r['path']}  updated={r['updated_at']}")


if __name__ == "__main__":
    main()
