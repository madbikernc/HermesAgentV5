#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 — Phase 30g: prunes stale entries (a node removed from NODES since
# the last run) via hermes_rag_common.prune_stale(), skipped on --dry-run.
"""
hermes-rag-ingest-ops.py — Phase 30e (IMPLEMENTATION_PLAN.md §7, Phase 30):
third of four narrow, per-corpus ingestion tools. Reads what
hermes-node-health.py already produces rather than re-scraping anything,
per constraint 2 and this phase's own framing.

Real recon before writing this (2026-08-14) found the "fleet operational
data" corpus the plan originally sketched is narrower than it first sounded:
hermes-fleet-health.py, hermes-pfsense-report.py, and hermes-canary-report.py
generate real narrative report text, but none of them persist it anywhere —
their own STATE_FILE only stores a `last_run_utc` bookkeeping timestamp, and
the report body itself is emailed and then gone. hermes_botnet_intel.py has
a real SQLite cache, but it's IP/CIDR data with no prose content to embed
meaningfully. The smart-home tools (Generac/Moen Flo/Wyze/Vivint) are
live-query-only against their cloud APIs — nothing local to read at all.

The one real, structured, persisted operational document across the fleet is
hermes-node-health.py's own `last-report.json` — one per identity (Sintra,
Amy) plus one on HomeD13 (`~/.node-health/state/node-health/last-report.json`,
no persona there). This ingester covers exactly that: a snapshot corpus, not
a growing history — each run's checks replace the prior ones for that node
rather than accumulating near-duplicate entries, since the source itself is
overwrite-only with no timestamped archive to mirror. If a real historical
"when did X last happen" capability is ever wanted, that needs the
underlying tools to start archiving their own report text first — a
decision for whoever owns that scope, not assumed here.

Dedup is content-hash on the checks themselves (name/status/value/detail),
deliberately excluding the report's own timestamp field — so a re-run with
an unchanged health picture doesn't force a pointless re-embed every day;
the displayed citation still carries the real timestamp for context.

Access: Sintra's and Amy's state files live under their own `0700` homes,
unreadable directly by `pmoney` — read via `sudo -u <identity> cat`, the
same access pattern Phase 14's `hermes-fleet-health.py` already uses.
HomeD13's is reached over the same `homed13` SSH alias `hermes-repo-sync.sh`
and `hermes-node-probe.py` already use.

Usage:
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-ingest-ops.py [--dry-run]
"""
import argparse
import datetime
import hashlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_rag_common as rag  # noqa: E402

CORPUS = "ops"
MAX_CHUNK_CHARS = 1800

NODES = [
    ("Spark-Sintra", "local", "sintra", "/home/sintra/.hermes/state/node-health/last-report.json"),
    ("Spark-Amy", "local", "amy", "/home/amy/.hermes/state/node-health/last-report.json"),
    ("HomeD13", "ssh", "homed13", "/home/pmoney/.node-health/state/node-health/last-report.json"),
]

SECTION_TITLES = {
    "identity": "Node Identity and Context",
    "services": "Service Availability",
    "compute": "Compute Health",
    "network": "Network Health",
    "storage": "Data and Storage",
    "security": "Security Posture",
    "tasks": "Task and Pipeline Health",
    "observability": "Observability and Telemetry",
}


def fetch_report(kind, target, path):
    if kind == "local":
        proc = subprocess.run(["sudo", "-u", target, "cat", path], capture_output=True, text=True, timeout=30)
    else:
        proc = subprocess.run(["ssh", target, "cat", path], capture_output=True, text=True, timeout=30)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise RuntimeError(f"could not read {path} via {kind}:{target}: {proc.stderr.strip()[:300]}")
    return json.loads(proc.stdout)


def render_section(checks):
    lines = []
    for c in checks:
        line = f"- {c['name']}: {c['status']} — {c['value']}"
        if c.get("detail"):
            line += f" ({c['detail']})"
        lines.append(line)
    return "\n".join(lines)


def build_chunks(report):
    timestamp = report.get("identity", {}).get("timestamp", "unknown time")
    chunks = []
    hash_material = {}
    for key, title in SECTION_TITLES.items():
        section = report.get(key)
        if not section or not section.get("checks"):
            continue
        checks = section["checks"]
        hash_material[key] = [
            {"name": c["name"], "status": c["status"], "value": c["value"], "detail": c.get("detail")}
            for c in checks
        ]
        text = render_section(checks)
        for sub in rag.group_blocks(text.split("\n"), MAX_CHUNK_CHARS, sep="\n"):
            chunks.append((title, timestamp, sub))
    return chunks, hash_material


def ingest_node(conn, node_name, kind, target, path, dry_run) -> int:
    source_path = f"node-health/{node_name}"
    try:
        report = fetch_report(kind, target, path)
    except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        print(f"ERROR: {node_name}: {e}", file=sys.stderr)
        return 0

    chunks, hash_material = build_chunks(report)
    if not chunks:
        print(f"WARNING: {node_name}: no sections with checks — skipping", file=sys.stderr)
        return 0

    file_hash = hashlib.sha256(json.dumps(hash_material, sort_keys=True).encode()).hexdigest()
    row = conn.execute(
        "SELECT file_hash FROM ingest_state WHERE corpus=? AND source_path=?", (CORPUS, source_path)
    ).fetchone()
    if row and row[0] == file_hash:
        return 0

    if dry_run:
        print(f"[dry-run] {source_path}: {len(chunks)} chunk(s) would be (re)embedded")
        return len(chunks)

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn.execute("DELETE FROM chunks WHERE corpus=? AND source_path=?", (CORPUS, source_path))
    conn.execute(
        "DELETE FROM vec_chunks WHERE chunk_id IN "
        "(SELECT id FROM chunks WHERE corpus=? AND source_path=?)",
        (CORPUS, source_path),
    )
    for idx, (section, timestamp, text) in enumerate(chunks):
        citation = f"Node health — {node_name} — {section} (as of {timestamp})"
        vec = rag.embed(text)
        cur = conn.execute(
            "INSERT INTO chunks (corpus, source_path, section, chunk_index, chunk_text, "
            "citation, content_hash, ingested_at) VALUES (?,?,?,?,?,?,?,?)",
            (CORPUS, source_path, section, idx, text, citation, rag.content_hash(text), now),
        )
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (cur.lastrowid, rag.pack_vec(vec)),
        )
    conn.execute(
        "INSERT INTO ingest_state (corpus, source_path, file_hash, last_ingested) VALUES (?,?,?,?) "
        "ON CONFLICT(corpus, source_path) DO UPDATE SET file_hash=excluded.file_hash, "
        "last_ingested=excluded.last_ingested",
        (CORPUS, source_path, file_hash, now),
    )
    conn.commit()
    return len(chunks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = rag.connect(readonly=False)
    total_chunks = 0
    changed = 0
    for node_name, kind, target, path in NODES:
        n = ingest_node(conn, node_name, kind, target, path, args.dry_run)
        if n:
            changed += 1
            total_chunks += n
            print(f"{node_name}: {n} chunk(s)")

    if not args.dry_run:
        current = {f"node-health/{node_name}" for node_name, *_ in NODES}
        pruned = rag.prune_stale(conn, CORPUS, current)
        if pruned:
            print(f"Pruned {len(pruned)} stale source(s): {', '.join(pruned)}")

    print(f"Checked {len(NODES)} node(s), {changed} changed, {total_chunks} chunk(s) (re)embedded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
