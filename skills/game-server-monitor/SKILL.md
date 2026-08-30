---
name: game-server-monitor
description: "Check real health status for the Minecraft and Project Zomboid servers on the muncraft box (192.168.1.221) — service/process state, disk, backups, RCON. Also runs automatically once daily, emailing only when something needs attention."
version: 1.4.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [minecraft, zomboid, game-server, monitoring, muncraft]
prerequisites:
  commands: [python3]
---

# Game Server Monitor (muncraft box)

**Version:** 1.4.0

Real health status for the Minecraft and Project Zomboid servers on `192.168.1.221` — confirmed
live to be exactly one instance of each (`minecraft.service`, `zomboid.service`), plus a box-local
`minecraft-monitor.service` companion. Ported from v1's Minecraft-only monitor
(`../../HermesAgent/scripts/minecraft-monitor.sh`/`minecraft-health-cron.sh`) and extended to cover
Zomboid, which v1 never had.

## How to use it

```bash
python3 ~/HermesAgentV5/tools/hermes-game-server-monitor.py --dry-run   # print, don't email
python3 ~/HermesAgentV5/tools/hermes-game-server-monitor.py            # real run: emails if issues
```

Credentials come from Vaultwarden (item `Zomboid Admin - muncraft`) via `tools/vault-get-secret.sh`
— this is the real, working SSH credential for the box (user `zomboid-admin`, password auth).
**A daily automated check also runs on its own** (06:30, `hermes-game-server-monitor.timer` — see
`infra/hermes-game-server-monitor/`), silent when everything's healthy.

## Rules

- **`tools/hermes-zomboid-admin.sh` (the separate admin/control tool for Zomboid) almost certainly
  does not work as committed** — it assumes ambient SSH access to `192.168.1.221` that doesn't
  exist for any current identity. If asked to use it, say so plainly rather than assuming it'll
  connect; the real credential is the same `Zomboid Admin - muncraft` vault item this monitor uses,
  but the admin tool doesn't fetch it. Not fixed as part of this monitoring build — a separate task.
- **A real, standing finding gets reported every run until resolved, not just once:** Minecraft's
  RCON is listening on all interfaces (`*:25575`), not just `127.0.0.1` as `server.properties`'
  `rcon.ip=127.0.0.1` setting claims — confirmed live via `ss -tln`, a known vanilla-Minecraft
  limitation (the setting isn't reliably enforced as a real bind restriction), not a one-time
  misconfiguration.
- **Zomboid now has a real backup mechanism** (`zomboid-backup.sh` + `zomboid-backup.timer`, Phase
  27 — see `../../infra/zomboid-backup/README.md`), styled directly on Minecraft's own
  `backup.sh`/`minecraft-backup.timer`. This monitor's `Zomboid backups` check now reports real
  freshness/count, same as the Minecraft check — a `CRITICAL` there most likely means
  `zomboid-backup.timer` hasn't been installed yet (that half needed a human with root/muncraft
  access; Hermes's own `zomboid-admin` service account can't install a systemd unit).
- Zomboid's own RCON is disabled on this install (blank `RCONPassword`), so this monitor cannot and
  does not report Zomboid player counts — only service/process/disk state, everything actually
  reachable without RCON or sudo (`zomboid-admin` has no passwordless sudo either, confirmed live).
- If a check fails, report the real error from the tool's own output — don't describe the fleet as
  healthy if the tool's report shows a WARN or CRITICAL line.
- **UFW firewall rules are checked via a root-owned dump file, not live sudo.** `zomboid-admin` has
  no direct UFW access at all (confirmed live, three ways — no sudo grant, `ufw` refuses non-root,
  `/etc/ufw/user.rules` is `640 root:root`), and no `muncraft` credential exists anywhere either.
  Rather than widen that account's sudo or add a broad new credential, `../../infra/muncraft-ufw-dump/`
  runs `ufw status verbose` as root every 15 minutes on the muncraft box and writes it to a file
  `zomboid-admin` can already read via its `muncraft` group membership — `check_firewall()` reads
  that. **Until `ufw-status-dump.timer` is installed there** (a manual one-time step, same as
  `zomboid-backup.timer` — see that directory's README), the `Firewall (box-wide)` section shows
  `[WARN] UFW firewall rules: cannot verify — .../.ufw-status.txt doesn't exist yet`. **Don't
  describe the firewall as verified compliant based on this tool's report if you see that WARN** —
  say plainly it can't be checked yet. Only the games' own connect ports may be open to Anywhere;
  everything else — SSH, RCON, anything — must resolve to `10.129.1.x`/Tailscale (or the two
  exceptions below) or it's a `CRITICAL`.
- **Two confirmed exceptions to the allowlist, both verified with The Boss against real live data,
  not assumed:** `192.168.1.215` is allowed as an SSH source alongside `10.129.1.0/24` — pfSense's
  own DMZ-side IP; admin SSH from the fleet's LAN gets NAT-hairpinned through the router and arrives
  here as that address. `25566/tcp` is exempted alongside the other game ports — a real second
  Minecraft (Paper) instance, tagged as such in the live UFW rule's own comment, though checked live
  and confirmed **not currently running** (no process, no systemd unit, no `/opt/paper`) — the
  firewall rule is provisioned ahead of the server existing. If asked about Paper, say plainly it's
  firewalled for but not yet running, not "up and monitored."
- A real parser bug was found and fixed on the first live run: UFW's trailing `# reason` comments on
  rules were being captured into the source field, breaking otherwise-valid CIDR parsing and
  reporting false violations. Fixed by stripping everything from `#` onward before parsing.
- See `../../IMPLEMENTATION_PLAN.md` §7 Phases 26-29 for the full build account.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.4.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-12 | Initial version. Phase 26 (`IMPLEMENTATION_PLAN.md` §7) built — ported from v1's Minecraft-only monitor, extended to Zomboid, verified live end to end including a real emailed report. |
| 1.1.0 | 2026-08-12 | Phase 27: Zomboid backup mechanism added (`infra/zomboid-backup/`). The `Zomboid backups` check now reports real freshness/count instead of a standing "none exists" notice. |
| 1.2.0 | 2026-08-12 | Phase 29: added the UFW firewall-rules review (`check_firewall()`), direct request to ensure only game ports are globally open and everything else (SSH, RCON, etc.) is restricted to `10.129.1.x`/Tailscale. Currently permanently reports "cannot verify" — no credential with UFW access exists, confirmed live three ways; The Boss's call was to leave it manual rather than grant broader access. The standing "cannot verify" state deliberately does not drive the daily email on its own; only a real detected violation would. |
| 1.3.0 | 2026-08-12 | Phase 29 follow-up, direct request: "can you just run the checks in a root-owned process, to get visibility to ufw?" `check_firewall()` now reads a root-owned periodic dump (`../../infra/muncraft-ufw-dump/`) instead of attempting live sudo — no widened `zomboid-admin` grant, no new `muncraft` credential. Evaluation logic verified end to end against mock compliant/violating data (uploaded via `zomboid-admin`'s existing write access, then removed) before any real dump existed. |
| 1.4.0 | 2026-08-12 | First real run against the actual ruleset (dump timer installed same day) found a real parser bug (trailing `# comment` annotations breaking CIDR parsing) and two legitimate policy exceptions, both confirmed with The Boss before adding: `192.168.1.215` (pfSense's DMZ IP) and `25566/tcp` (Minecraft Paper, confirmed real but not yet running). Re-verified clean against the real ruleset post-fix. |
