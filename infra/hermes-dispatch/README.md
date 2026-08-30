# hermes-dispatch — recreate checklist

**Version:** 1.1.1

The routing decision, extracted from each persona's own gateway turn (HermesAgentV5 S6,
`../../HermesAgentV5/IMPLEMENTATION_PLAN.md`). Outbound-only — polls Buzz, calls the router,
calls hermes-memory — so no inbound port, no ufw rule.

## 1. Deploy

```bash
sudo cp hermes-dispatch.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-dispatch
```

Requires `buzz-token` and `memory-token` (already provisioned, S2/S3) plus `guard-token`
(S5) — no new vault items for this stage.

## 2. Verify — publish a pointer envelope by hand, watch it route

Nothing publishes to the `dispatch` Buzz topic in production yet (S7's presenter and S8's
cutover do that). Verify the pipeline directly:

```bash
BT="$(vault-get-secret.sh buzz-token password)"
MT="$(vault-get-secret.sh memory-token password)"

# 1. Put raw text somewhere hermes-memory can hydrate it from.
TURN=$(curl -s -X POST http://10.129.1.15:8102/turns -H "Authorization: Bearer $MT" \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"verify-s6","agent":"verify","role":"user","raw":"Can you review this Python function for bugs?"}')
echo "$TURN"   # {"id": N, "task_id": "verify-s6"}

# 2. Publish the pointer envelope to the dispatch topic — no inline content.
curl -s -X POST http://10.129.1.15:8101/messages -H "Authorization: Bearer $BT" \
  -H 'Content-Type: application/json' \
  -d '{"from":"sintra","topic":"dispatch","task_id":"verify-s6","memory_ref":"turn:N"}'

# 3. Watch it land on the chosen topic (poll a few seconds later).
curl -s -H "Authorization: Bearer $BT" 'http://10.129.1.15:8101/messages/poll?topic=code&since=0'

# 4. Confirm the task's state updated in hermes-memory.
curl -s http://10.129.1.15:8102/tasks/verify-s6 -H "Authorization: Bearer $MT"
```

Expect: the pointer lands on `code` (a code-review request), the task's `state` becomes
`dispatched` with `topic: "code"`, and no inline content ever appears in the Buzz message body —
only `task_id`/`memory_ref`.

## 3. What's still ahead

- No real specialist subscribes to `retrieve`/`screen`/`logs`/`train` yet — dispatched pointers sit
  unclaimed until something does (`code`/`vision` have a real consumer via the coder/vision-review
  path, `media` has been served by `hermes-media.py` since S10). Filling the rest is later work,
  not a defect here.
- `dispatch` role runs Q4_K_M, not the target's proposed Q8 (already on disk, zero download
  cost) — a follow-up, not a blocker.
- Port 8097 is temporary; the target's `:8088` is nano's until S8 retires it.

## 4. Failover (S12, target §11.2)

Rung 1 (systemd auto-restart) is already the deployed `.service` file above (`Restart=always`,
`RestartSec=10`) — handles a crash, not a hang or a full Node A outage.

Rung 2 (idle standby on Forge, alerting on heartbeat loss) is `hermes-dispatch-standby-check.sh` +
`hermes-dispatch-standby-check.service`/`.timer`, deployed **on spark-2**, polling every 2 minutes:

```bash
# On spark-2:
sudo cp hermes-dispatch-standby-check.service hermes-dispatch-standby-check.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-dispatch-standby-check.timer
```

One firewall opening, on **spark**, narrowly scoped to spark-2's IP — the same shape as every
existing cross-node role rule from S1, not a new precedent:

```bash
sudo ufw allow from 10.129.1.17 to any port 8097 proto tcp comment 'HermesAgentV5 S12: standby dispatch failover, Forge -> dispatch model'
```

It deliberately does not open `hermes-router`'s own `:8080` cross-node — that port is loopback-only
*and has no bearer-auth of its own* (its whole security boundary is the bind address), unlike every
other service in this fleet. A standby instead calls the `dispatch` role's own `llama-server` port
directly via `DISPATCH_CHAT_URL`, the same "talk to the backend, not the router" shape S11's
benchmark harness already established for the identical reason.

**Detection is automatic. Promotion is one command a human runs, not an automatic action** — same
call this fleet has made everywhere else a live-topology change has real blast radius (pfSense
stays read-only, `hermes-forge-residency.py`'s drain/restore stays a CLI, S8's account
deactivations stayed manual). Buzz's claim exclusivity makes two simultaneously-active dispatchers
*safe* (no double-processing), but safe isn't the bar used elsewhere in this fleet for "so just
automate it." When `hermes-dispatch-standby-check.sh` alerts a stale heartbeat, its FleetOps notice
includes the exact command:

```bash
ssh spark-2 'cd ~/HermesAgentV5 && CLAIMANT=hermes-dispatch-standby \
  ROUTER_URL=http://10.129.1.15:8080 \
  DISPATCH_CHAT_URL=http://10.129.1.15:8097/v1/chat/completions \
  BUZZ_URL=http://10.129.1.15:8101 MEMORY_URL=http://10.129.1.15:8102 GUARD_URL=http://10.129.1.15:8096 \
  BUZZ_TOKEN=$(./tools/vault-get-secret.sh buzz-token password) \
  MEMORY_TOKEN=$(./tools/vault-get-secret.sh memory-token password) \
  GUARD_TOKEN=$(./tools/vault-get-secret.sh guard-token password) \
  python3 tools/hermes-dispatch.py'
```

`ROUTER_URL` is passed through even though `DISPATCH_CHAT_URL` overrides the one call that would
otherwise use it — kept for clarity/log messages only in this mode, harmless either way.

**Standing back down** once the primary on Watch recovers: `Ctrl-C` the standby process (or
`systemctl stop` it, if it was ever promoted to a real unit rather than run ad hoc — not done by
default, on purpose, so a promotion doesn't quietly become permanent infrastructure by accident).
Both instances write the same heartbeat key with a different `value` (`hermes-dispatch` vs.
`hermes-dispatch-standby`), so `curl .../state/dispatch/heartbeat` always shows which one is
currently live.

Rung 3 (any node can respawn a replacement, resyncing from `results`) needed no new code — S6's
non-negotiable #3 (dispatch holds no routing state anywhere but Buzz/hermes-memory) already
guarantees it structurally. Live-verified as part of S12: the promotion command above *is* rung 3's
proof, run for real against a stopped primary — see `IMPLEMENTATION_PLAN.md`'s S12 section for the
actual test transcript.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-29 | Initial version — S6: `hermes-dispatch.py` built and deployed, verified end to end with a manually-published pointer envelope. |
| 1.1.0 | 2026-08-29 | S12: failover up target §11.2's escalation ladder. Added §4 (heartbeat-based standby detection on Forge, manual promotion command, why promotion isn't automatic). Corrected §3's stale claim that no specialist topic has a real subscriber — `media` has since S10. |
