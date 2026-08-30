#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-botnet-intel-sync.py — Refreshes the local botnet/C2 threat-intel
cache (see hermes_botnet_intel.py for the full design/sourcing rationale).
Runs via hermes-botnet-intel-sync.timer, every 6h — more frequent than most
of this fleet's daily jobs, deliberately: Feodo Tracker's whole value is
"currently active" C2 infrastructure, which turns over faster than a daily
cadence would track well, and the fetches themselves are small plaintext/
JSON downloads, cheap enough that 4x/day isn't a real cost.

Phase 25 (IMPLEMENTATION_PLAN.md §7).

No email — this is infra plumbing, not a report (same tier as
hermes-nfs-backup.sh): it silently keeps the cache fresh, and a broken
timer shows up through hermes-node-health.py's own "Failed units" check
like anything else. Exit code follows the same "don't phantom-fail the
unit over content, only over a real tool failure" rule
hermes-podcast-sync.py 1.0.1 established: one or two feeds having a bad
day is a partial, tolerable degradation (the module already leaves a
failed source's prior rows in place rather than wiping them), not a broken
job — only exits non-zero if every single source failed, meaning the sync
accomplished nothing at all.

Usage:
  hermes-botnet-intel-sync.py             # real run
  hermes-botnet-intel-sync.py --verbose   # also print per-source counts
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_botnet_intel import sync, SOURCE_LABELS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh the botnet/C2 threat-intel cache")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    results = sync()

    ok_count = sum(1 for r in results.values() if r["ok"])
    total_entries = sum(r["count"] for r in results.values() if r["ok"])

    if args.verbose or ok_count < len(results):
        for source, r in results.items():
            label = SOURCE_LABELS.get(source, source)
            if r["ok"]:
                print(f"  [ok]   {label}: {r['count']} entries")
            else:
                print(f"  [FAIL] {label}: {r['error']}")

    print(f"Botnet intel sync: {ok_count}/{len(results)} source(s) ok, "
          f"{total_entries} total entries cached.")

    if ok_count == 0:
        print("ERROR: every source failed — cache not updated this run.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
