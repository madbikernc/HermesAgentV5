# minecraft-bots-activity-log — recreate checklist

**Version:** 1.0.0

Standing fleet infrastructure for a full, raw, durable activity trail across all five Minecraft
bots (direct request, 2026-09-08: "setup a log of their activities that would be sufficient for
review later, to look for misbehaviors and broken behaviors").

`hermes-minecraft-triage.py` (`../minecraft-bots-triage/`) already exists and already writes a
durable log (`triage.log`), but it's deliberately narrow: it only fires on a known
`TRIAGE_PATTERNS` match (a crash, a stuck path loop, an abandoned goal) and records the LLM
triage of that one line, not the surrounding context. It can't surface a misbehavior nobody has
pattern-matched yet -- exactly the gap a full raw mirror is for. `journalctl` itself already
retains this data, but its retention is a size-based budget shared across every service on the
box, not bot-specific -- a noisy unrelated service could evict bot history before anyone gets to
review it. This service exists purely to give the bots' own activity a durable, bot-scoped copy
that doesn't compete with anything else for retention.

Deliberately dumb: a single `journalctl -f` across all five bot units, piped straight to a file
via systemd's own `StandardOutput=append:` (no wrapping shell script needed, confirmed supported
on this box's systemd 255). `-o short-iso` gives full date+time+timezone on every line -- the
default format omits the year, which stops being enough once a log is meant to be reviewed days
later. Bounded via a `logrotate` job (`copytruncate`, since the service holds the file open
continuously and a normal rename-based rotation would leave it writing to a deleted inode) --
14 daily, compressed rotations.

## Install (on spark, as pmoney)

```bash
cp minecraft-bots-activity-log.service /etc/systemd/system/
sudo cp minecraft-bots-activity-log.logrotate /etc/logrotate.d/minecraft-bots-activity-log
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-bots-activity-log.service
```

## Verify

```bash
sudo systemctl status minecraft-bots-activity-log.service
tail -f /mnt/hermes-data/minecraft-memory/activity.log
sudo logrotate -d /etc/logrotate.d/minecraft-bots-activity-log   # dry run, checks syntax
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-08 | Initial version. |
