#!/usr/bin/env bash
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# Queue-depth probe for tools/hermes-node-health.py's Task and Pipeline Health
# section (Phase 13). Kept as its own script rather than an inline
# queue_probe_command one-liner in node-health.json — a first attempt at
# embedding the jq/curl pipeline directly as a JSON string value hit real,
# hard-to-debug shell-quoting collisions once nested through JSON decoding
# and then subprocess.run(..., shell=True). A real script is easier to test
# and read than a string escaped through two layers of quoting.
#
# 1.1.0 (2026-08-09): broken out per job type, not just an aggregate total —
# Stage 6 added a second job type ("video") to the same broker/queue, and an
# aggregate count can't say which type is actually stuck if one is.
set -euo pipefail
REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
BROKER_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" broker-token password 2>/dev/null)"
curl -s -m 5 -H "Authorization: Bearer $BROKER_TOKEN" http://10.129.1.15:8100/jobs \
  | jq -r '.jobs as $all
    | "\($all|length) job(s) in history, \($all|map(select(.state=="done"))|length) done, "
      + "\($all|map(select(.state!="done" and .state!="dead"))|length) in flight"
      + ($all | group_by(.type) | map(
          "  [\(.[0].type)] \(length) total, "
          + "\(map(select(.state!="done" and .state!="dead"))|length) in flight, "
          + "\(map(select(.state=="dead"))|length) dead-lettered"
        ) | map("\n" + .) | join(""))'
