# hermes-media — recreate checklist

**Version:** 1.0.0

The media agent (HermesAgentV5 S10, `../../HermesAgentV5/IMPLEMENTATION_PLAN.md`). Bridges Buzz's
`media` topic to the execution plane that already exists — `hermes-broker.py` +
`hermes-render-worker.py` on HomeD13 — rather than inventing a second job model. Runs on Forge
(spark-2), per target §9.2.

## 1. Deploy

```bash
sudo cp hermes-media.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-media
```

Outbound-only (polls Buzz, calls the broker/hermes-memory) — no inbound port, no ufw rule.
Requires `buzz-token`, `memory-token`, `broker-token` (all already provisioned) and `guard-token`
(S5) — no new vault items.

## 2. Verify — publish a pointer envelope, watch a real render happen

```bash
BT="$(vault-get-secret.sh buzz-token password)"
MT="$(vault-get-secret.sh memory-token password)"

TURN=$(curl -s -X POST http://10.129.1.15:8102/turns -H "Authorization: Bearer $MT" \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"verify-s10","agent":"verify","role":"user","raw":"a red barn in a green field"}')

curl -s -X POST http://10.129.1.15:8101/messages -H "Authorization: Bearer $BT" \
  -H 'Content-Type: application/json' \
  -d '{"from":"dispatch","topic":"media","task_id":"verify-s10","memory_ref":"turn:N"}'

# Watch: claim ack'd immediately (check hermes-media's own log), broker job appears
# (GET /jobs on spark:8100), FleetOps gets the image, and once done the task's state in
# hermes-memory flips to "done" with a plain completion turn.
```

## 3. Screening

Two layers, two places:
- **Prompt text**, before a broker job is ever submitted — same L1 (regex) + L2 (Prompt Guard 2)
  this agent shares with `hermes-dispatch.py`.
- **The rendered artifact itself**, inside `hermes-render-worker.py` on HomeD13 (S10, same
  stage) — real magic-byte checks, before the file is ever uploaded to the broker or delivered to
  Matrix. Target §9.3: no exception for rendered images. See that tool's own changelog.

## 4. What's still ahead

- No image delivery through `hermes-presenter.py` — it has no image support yet (S7's own scope:
  builds the seam, not the voice). Completion reports as plain text ("delivered to FleetOps"),
  which is a real, honest status, not a placeholder.
- If this process restarts mid-poll on an in-flight broker job, that task sits in `rendering`
  state with no automatic resync — a reasonable follow-up, not built now (no fine-tuning-scale
  urgency yet, same reasoning `hermes-forge-residency.py`'s drain/restore stayed a CLI tool).
- HomeD13's actual network isolation (VLAN, no outbound internet except deliberate model pulls)
  is **not done by this agent or any other code** — it's a real pfSense change with a materially
  worse failure mode than anything software-side, and this fleet's own `hermes-pfsense.py` is
  deliberately read-only for exactly that reason. See
  `IMPLEMENTATION_PLAN.md`'s S10 section for the operator checklist.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-29 | Initial version — S10: `hermes-media.py` built and deployed, verified end to end against the real broker/render-worker pipeline. |
