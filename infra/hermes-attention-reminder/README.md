# hermes-attention-reminder — recreate checklist

**Version:** 1.0.0

Daily nudge that anything sitting in a hermes-memory task state that needs a human decision — today
just `unresolved`, `tools/hermes-dualcoder.py`'s own escalation state — for 24+ hours gets a real,
high-priority email plus a FleetOps notice. Spiritual successor to the retired
`tools/hermes-self-repair-reminder.py` (see that file's own header for why it stopped and why a real
V5 successor was a deliberate later decision, not an oversight).

**Scope note:** this is not a general "any unanswered Matrix message" detector — that's a
read-receipt-tracking problem, out of scope. It's specifically a `hermes-memory.tasks` state scan,
extensible to future specialists' own "needs a human" states via `ATTENTION_STATES`.

## 1. Deploy

Runs under the RAG venv (`/opt/hermes/venvs/rag/bin/python3`) — it imports `hermes-memory.py`
directly for `connect(readonly=True)`, which unconditionally loads the `sqlite_vec` extension
regardless of read-only mode, same interpreter requirement `hermes-memory.service` itself has.

```bash
sudo cp hermes-attention-reminder.service /etc/systemd/system/
sudo cp hermes-attention-reminder.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-attention-reminder.timer
```

Needs the `email-sintra` Vaultwarden item (same credential `hermes-model-scan.py`/the retired
self-repair reminder already use) for SMTP, and `fleetops-matrix-token`/`fleetops-room` for the
Matrix notice — both best-effort, logged and skipped if absent, never a hard failure.

## 2. Verify

```bash
# Run by hand first, don't wait for the timer:
sudo -u pmoney /opt/hermes/venvs/rag/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-attention-reminder.py
```

With nothing stale, expect a single "no stale attention-needing tasks found" log line and no email.
To force a real positive test: get a real task into `unresolved` (a forced dual-coder
non-convergence run is the natural way), then either wait 24h or temporarily lower
`ATTENTION_SECONDS` for the test run, and confirm a real email actually lands in the inbox — not
just that the script exits 0.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-05 | Initial version — spiritual successor to the retired `hermes-self-repair-reminder.py`, scoped to `hermes-memory.tasks`' own `unresolved` state (today, extensible later). |
