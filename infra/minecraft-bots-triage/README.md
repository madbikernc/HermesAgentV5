# minecraft-bots-triage — recreate checklist

**Version:** 1.0.0

Standing fleet infrastructure for the Minecraft bots' own log triage (direct request,
2026-09-07: "I want the Firmament to do this monitoring, and engage coder/coder2 loop to do
initial triage"), replacing what had been a human manually tailing both bots' journals for
hours during live debugging. `tools/hermes-minecraft-triage.py` (see its own header for the
full design) tails `minecraft-bot-babs.service`/`minecraft-bot-amy.service`, and on a
triage-worthy line (a crash, a repeated stuck pathfinding loop, an abandoned goal, a model
backend failure) fires `coder` and `coder2` (hermes-router.py) **in parallel, independently** —
the operator's own explicit choice over a draft/review pipeline — and surfaces a disagreement
between them as its own signal rather than silently picking one.

Deliberately diagnosis-only: this never edits code, restarts services, or changes server
config. Every real fix from the debugging session this was built after needed a human/Claude
Code decision (a code change, or a live server.properties/ops.json edit) — this service's only
job is to produce that same quality of initial assessment automatically, not to act on it.

**Output goes to three places, only two of which needed new code:** a new Buzz topic
(`minecraft-ops`, hermes-buzz.py 2.0.17 — deliberately not the existing `minecraft` topic, which
both bots relay into in-game chat) which hermes-buzz.py's own `matrix_mirror()` already forwards
into the FleetOps Matrix room in real time (no separate Matrix client needed here), plus a local
log file (`TRIAGE_LOG_PATH`, default `/mnt/hermes-data/minecraft-memory/triage.log`) for durable
history that doesn't depend on Buzz being reachable. The existing hermes-rag `ops` corpus was
considered and deliberately not reused for the log destination — it's narrowly scoped to
`hermes-node-health.py`'s own structured snapshots (see `hermes-rag-ingest-ops.py`'s header),
not a general incident dropbox.

## Install (on spark, as pmoney)

```bash
cp hermes-minecraft-triage.service /etc/systemd/system/   # or sudo cp if not already pmoney-owned
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-minecraft-triage.service
```

## Verify

```bash
sudo systemctl status hermes-minecraft-triage.service
sudo journalctl -u hermes-minecraft-triage.service -f   # watch it pick up a live incident
tail -f /mnt/hermes-data/minecraft-memory/triage.log
```

To see it fire without waiting for a real incident, trigger one of `TRIAGE_PATTERNS` (in
`tools/hermes-minecraft-triage.py`) by hand -- e.g. `logger -t test "path_reset: stuck"` won't
match (wrong unit), but a real bot restart into a bad state will.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-07 | Initial version. |
