# hermes-remediate — recreate checklist

**Version:** 1.1.1

Broker-mediated self-remediation for Sintra and Amy (direct request, 2026-08-21, following a Stage 8
near-miss where a Buzz watcher went quiet with no way to tell "transient" from "stuck" apart without
reading raw logs by hand). Neither persona gets sudo or systemctl access to make this work — same
"no LLM turn, and no general-purpose process, is ever load-bearing for a mechanical/privileged
action" split this fleet already uses for on-demand model wakes (`hermes-model-wake-worker.py`) and
renders. A persona asks; an already-privileged worker (`pmoney`, full existing sudo) checks the
request against a hard allowlist and acts.

## Real bug found and fixed along the way

Designing this surfaced a real, pre-existing bug in `hermes-broker.py` itself: its job
state-transition logic required *both* `exit_code == 0` and a real uploaded artifact blob to mark a
job `done`. `wake` jobs (and now `remediate` jobs) never upload a blob — meaning a genuinely
successful artifact-less job could never actually reach `done`, only get silently re-run until
`MAX_ATTEMPTS` was exhausted and it was marked `dead` despite having worked. Fixed in `hermes-broker.py`
1.2.1 (`artifact_path or not blob` instead of just `artifact_path`) before this feature was built on
top of it — see that file's own revision history for the full account. Render/video/embed jobs are
unaffected; they always exit 0 with a real blob on success, never an empty one.

## Components

| File | Purpose |
|---|---|
| `tools/hermes-remediate.sh` | Client tool either persona calls: `hermes-remediate.sh restart-service <unit>` or `hermes-remediate.sh send-nudge <identity> ["message"]`. Submits a real job, polls, prints the real outcome. |
| `tools/hermes-remediate-worker.py` | The privileged half. One instance per node (`JOB_TYPE=remediate-sintra` on spark, `remediate-amy` on spark-2) so a job is only ever claimed by the worker on the node that actually hosts that identity's services. |
| `tools/hermes-remediate-worker-wrapper.sh` | Fetches Vaultwarden secrets (broker-token, matrix-fleetops, matrix-ops-ctl, this identity's email password) and execs the worker — same pattern as `hermes-buzz-wrapper.sh`. |
| `infra/hermes-remediate/allowlist.json` | The actual security boundary. Per identity, per action, an exact list of allowed targets. Add a new approved target or action by editing this file — no code change needed. Gateway services are deliberately excluded (restarting one's own gateway kills the current turn — a different risk shape, out of scope for this first version). |
| `hermes-remediate-worker@.service` | Templated unit, one instance per identity. |

## Actions

- **`restart-service`** — `sudo systemctl restart <target>`, then polls `systemctl is-active` for up
  to `RESTART_TIMEOUT_S` (default 30s — real restarts observed this session took a few seconds each).
- **`send-nudge`** — posts into the *target* identity's own home room as `@hermes-ops-ctl:spark`,
  with the required `m.mentions` field (`hermes-buzz-watch.sh` 1.2.0 already found this necessary for
  these rooms — reused, not rediscovered).

## Throttle and escalation

Direct request: "no more than three successive attempts... send an email notification... and update
FleetOps." Tracked per-target in a local state file (`~/.hermes/state/remediate/<action>-<target>.json`
on whichever node's worker handles it) — same precedent as `hermes-buzz-watch.sh`'s own cooldown file,
not a broker query. Attempts reset to 0 only on a confirmed-healthy restart; three attempts that each
still end unhealthy escalates automatically (email to `notifications@canislupisnc.net` + a FleetOps
notice) instead of trying a fourth, and stays escalated until a human deletes the state file or the
target reports healthy some other way.

## Extensibility

Adding a new approved remediation *target* is a one-line edit to `allowlist.json`, no restart needed
(the worker reads it fresh on every job). Adding a new remediation *action type* (beyond
`restart-service`/`send-nudge`) needs a new branch in `hermes-remediate-worker.py`'s `run_job()` —
by design a deliberate code change, not a config toggle, since a new action type is a new kind of
privileged capability, not just a new instance of an existing one.

## Install

```bash
sudo cp hermes-remediate-worker@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-remediate-worker@sintra.service   # on spark
sudo systemctl enable --now hermes-remediate-worker@amy.service      # on spark-2
```

## Verify

```bash
# As sintra (or HERMES_IDENTITY=sintra as pmoney, for testing):
~/HermesAgentV5/tools/hermes-remediate.sh restart-service hermes-fabrication-guard.service
```

Confirm from raw output, not exit code alone: the target unit's `Active:` timestamp actually moved
(a real restart happened, not a no-op), and a deliberately-disallowed target
(`hermes-remediate.sh restart-service llama-nano.service`) is refused, not attempted.

## The rest of Stage 10: status exchange, root-cause approval, self-repair index

Three more pieces complete the system this infra supports, all direct requests:

- **`tools/hermes-status-exchange-trigger.sh`** + `hermes-status-exchange-sintra.timer`
  (on the hour) / `hermes-status-exchange-amy.timer` (on the half hour) — the hourly, structured
  counterpart to `hermes-buzz-checkin-trigger.sh`'s softer 4-hourly nudge. Each identity states her
  own git commit (trivial to look up; `hermes-repo-autopull` already keeps it correct, she's just
  reporting it) and asks the other for hers over Buzz. Same `m.mentions`-required posting pattern as
  every other trigger into these home rooms.
- **`skills/self-remediate/SKILL.md`** — the actual decision tree both personas follow: Tier 1
  (service/daemon problems — fix now via `hermes-remediate.sh`, no approval needed), Tier 2 (a
  script/skill bug — root-cause it, notify The Boss in FleetOps *and* email, wait for a real
  approval reply, get the other identity to peer-review the actual diff over Buzz, *then* apply
  locally and log it). Referenced from both `DesignFiles/*/SOUL.md`'s Capabilities section.
- **`tools/hermes-self-repair-reminder.py`** + `hermes-self-repair-reminder.timer` (daily, 08:00) —
  reads both identities' `~/.hermes/self-repair-index.md` (Sintra's locally, Amy's over SSH, same
  pattern `hermes-fleet-health.py` already uses) and, if either has content, emails
  `notifications@canislupisnc.net` and posts to FleetOps with the real current entries. Read-only —
  clearing a reviewed entry is a human action; this script never writes or deletes.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-21 | Initial version. Built as the first piece of the cross-node health/remediation system (direct request); found and fixed a real pre-existing bug in `hermes-broker.py` along the way (see above) before this feature could work correctly at all. |
| 1.1.0 | 2026-08-21 | Added the rest of Stage 10: the hourly status-exchange trigger (distinct from the softer 4-hourly check-in), `skills/self-remediate/SKILL.md` (the Tier 1/Tier 2 decision tree, including the peer-review-before-apply step), and the daily self-repair-index reminder. |
