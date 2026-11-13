#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-11-13) — direct operator request (self-repair fidelity pass): one durable,
# credential-free record of what the self-repair pipeline did and why, per task. Before this the
# only history was the journal (spark keeps about a day -- the 2026-11-10/11 runs were gone by
# 11-12) and hermes-memory, which needs MEMORY_TOKEN to read. Every stage appends one JSON line
# per event to SELFREPAIR_OUTCOMES (default ~/.hermes/state/selfrepair-outcomes.jsonl, outside
# any repo checkout):
#   seen        bridge     every triage finding: signature, category, submitted?, reason
#   submitted   bridge     a fix or test task: task_id, role, path, signature, attempt
#   generated   generate   a task's generation result: outcome (done/error/unresolved/blocked), detail
#   verified    apply      verification passed (or not): ok, the failing check's first line
#   incomplete  apply      a fix whose test task failed
#   reverted    apply      a failed commit reverted
#   decided     gate       promote/skip, by whom
# It holds task ids, paths, signatures, outcomes and short reasons only -- never a token, a
# diff, or a model transcript. hermes-fleetops-ui.py's /selfrepair tab reads it for the funnel
# and the before/after incident counts. record() never raises: losing one outcome line must never
# fail the stage that wrote it.

import json
import os
import time
from pathlib import Path

OUTCOMES_PATH = Path(os.path.expanduser(os.environ.get(
    "SELFREPAIR_OUTCOMES", str(Path.home() / ".hermes" / "state" / "selfrepair-outcomes.jsonl"))))
MAX_FIELD_CHARS = 300


def record(event, **fields):
    entry = {"ts": round(time.time(), 3), "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": event}
    for key, value in fields.items():
        entry[key] = value[:MAX_FIELD_CHARS] if isinstance(value, str) else value
    try:
        OUTCOMES_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(OUTCOMES_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def read(since_ts=0, path=None):
    """Every recorded event at or after since_ts, oldest first. Unreadable lines are skipped."""
    path = Path(path) if path else OUTCOMES_PATH
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and entry.get("ts", 0) >= since_ts:
                    out.append(entry)
    except OSError:
        return []
    return out


def prune(max_age_days=90, path=None):
    """Drops events older than max_age_days. Safe to call at a stage's startup."""
    path = Path(path) if path else OUTCOMES_PATH
    keep = read(time.time() - max_age_days * 86400, path)
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text("".join(json.dumps(e) + "\n" for e in keep), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass
