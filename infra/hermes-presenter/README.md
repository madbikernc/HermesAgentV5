# hermes-presenter — recreate checklist

**Version:** 1.0.0

The fleet's one interactive voice, thin (HermesAgentV5 S7, `../../HermesAgentV5/IMPLEMENTATION_PLAN.md`).
**Builds the seam, not the voice** — no styling model call exists yet; every reply is passthrough
(operator direction, deferred as a separate decision — see the plan's §4.4).

## 1. Matrix account

Already provisioned this stage, following `infra/continuwuity/README.md` §4's own recipe exactly
(temporarily flip `allow_registration = true`, register via the config's `registration_token`,
flip it back, restart): `@hermes-presenter:spark`, credentials in the `matrix-presenter` vault
item (`username` = full user ID, `password` = access token, `homeserver` field).

## 2. Deploy

```bash
sudo cp hermes-presenter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-presenter
```

No inbound port — long-polls Matrix `/sync`, calls Buzz/hermes-memory outbound only. No ufw rule.

## 3. Verify — invite it to a room and watch the seam work

Nothing subscribes to any specialist topic yet (S6's own state), so a real request will time out
after `TASK_TIMEOUT_SECONDS` (default 300s) with an honest "no specialist responded" message —
expected, not a defect. To verify the full mechanism without waiting on a real specialist,
complete a task manually the way a future one eventually will:

```bash
# 1. Invite @hermes-presenter:spark to a room, send it any text message, let it dispatch.
# 2. Find the task_id it created (its own log line names it).
MT="$(vault-get-secret.sh memory-token password)"
curl -s -X POST http://10.129.1.15:8102/turns -H "Authorization: Bearer $MT" \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"<task_id>","agent":"code","role":"assistant","raw":"raw result","presented":"styled result"}'
curl -s -X POST http://10.129.1.15:8102/tasks -H "Authorization: Bearer $MT" \
  -H 'Content-Type: application/json' -d '{"id":"<task_id>","agent":"code","state":"done"}'
# 3. Within POLL_SECONDS, the presenter posts "styled result" back into the room.
```

## 4. What's still ahead

- No styling pass. `format_reply()` is pure passthrough plus an optional debug prefix
  (`DEBUG_ATTRIBUTION=1` → `[dispatch→code] ...`), off by default.
- Sintra's and Amy's gateways are untouched — this is a parallel, independently-verifiable path,
  not yet anything real users are routed through. That's S8.
- `agent_state` entries this process writes (`pending:<task_id>`) are never deleted, only marked
  `delivered`. Harmless clutter for now; pruning is a later-stage concern if it ever matters.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-29 | Initial version — S7: `hermes-presenter.py` built and deployed, Matrix account provisioned, verified end to end with a manually-completed task. |
