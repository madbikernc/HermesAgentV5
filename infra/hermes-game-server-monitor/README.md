# hermes-game-server-monitor — recreate checklist

**Version:** 1.4.1

Daily health check (`tools/hermes-game-server-monitor.py`) for every known game server on the
muncraft box (`192.168.1.221`) — Minecraft and Project Zomboid, confirmed live to be exactly one
instance of each. Silent when healthy, emails `notifications@canislupisnc.net` only when something
needs attention. Same tier and silent-unless-issues discipline as v1's `minecraft-health-cron.sh`.

Phase 26 (`IMPLEMENTATION_PLAN.md` §7). Ported from v1's Minecraft-only monitor
(`../../HermesAgent/scripts/minecraft-monitor.sh` / `minecraft-health-cron.sh`), extended to cover
Zomboid, which didn't exist in v1's era. See the tool's own docstring for the full account of what
was found live while building this — a broken assumed-SSH-access story affecting the existing
`tools/hermes-zomboid-admin.sh`, and two real, standing security/reliability findings (Minecraft's
RCON not actually honoring `rcon.ip=127.0.0.1`, and Zomboid having no backup mechanism at all).

## Install

```bash
sudo cp hermes-game-server-monitor.service hermes-game-server-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-game-server-monitor.timer
```

Runs at 06:30, after the botnet-intel sync and pfSense/fleet-health's 06:00-06:15 slot.

## Manual trigger (testing)

```bash
sudo -u pmoney /usr/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-game-server-monitor.py --dry-run
sudo -u pmoney /usr/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-game-server-monitor.py
```

`--dry-run` prints the report instead of emailing it.

## Verify

```bash
systemctl list-timers hermes-game-server-monitor.timer
journalctl -u hermes-game-server-monitor.service --no-pager
```

## Requires

- `tools/hermes-game-server-monitor.py` on the Spark, plus the system `python3-paramiko` package
  (already installed — confirmed live, no venv needed).
- Vault items `Zomboid Admin - muncraft` (login username/password — real, working SSH credential
  for the muncraft box; confirmed by connecting live) and `email-sintra` (already provisioned).
- Network reachability from the Spark to `192.168.1.221` (confirmed live — different subnet than
  the Spark's own `10.129.1.0/24`, but routed/reachable).

## Real findings from live verification (2026-08-12)

- **`tools/hermes-zomboid-admin.sh` almost certainly has never worked as committed.** It assumes
  ambient `ssh $HOST` access with no explicit user or key — no such access exists for any current
  identity (`pmoney`/`sintra`/`amy` all get `Permission denied (publickey,password)` against
  `192.168.1.221`). The real, working credential is the `Zomboid Admin - muncraft` vault item this
  monitor uses. Its `journal_since()`/`cmd_players` calls would also fail separately even with the
  right credential — `zomboid-admin` has no passwordless sudo, and `journalctl -u zomboid.service`
  without it returns silently empty rather than erroring. **Not fixed here** (out of scope for a
  monitoring tool) — flagged for a future pass if the admin tool itself needs to work.
- **Minecraft's RCON is not actually bound to `127.0.0.1` despite `rcon.ip=127.0.0.1` in
  `server.properties`.** Confirmed via `ss -tln` on the live box: it's listening on `*:25575`, all
  interfaces. This monitor flags it every run (`Minecraft RCON binding: WARN`) until it's fixed —
  vanilla Minecraft is known not to reliably enforce `rcon.ip` as a real bind restriction, so this
  is a live, current exposure, not a one-time config mistake waiting to be corrected on read.
- **Zomboid has no backup mechanism of any kind.** Unlike Minecraft's cron-driven `backup.sh`
  (daily, `/opt/minecraft/backups/`), `find /opt/zomboid -iname '*backup*'` turns up nothing but an
  unrelated leftover `.sh.bak` file. Flagged every run until a real backup path exists.
- Both findings are content this tool already reports by email — see the exit-code note below,
  they don't fail the systemd unit itself.

## UFW firewall review (Phase 29)

Direct request, 2026-08-12: review the box's UFW rules so only the games' own connect ports are
open to Anywhere, and everything else (SSH, RCON, anything) is restricted to `10.129.1.x`/Tailscale
— a violation recorded as a FAILURE. `check_firewall()`'s evaluation logic (Minecraft's game port
read live from `server.properties`, Zomboid's `16261`/`16262` UDP confirmed via `ss -ulnp`,
everything else checked against `10.129.1.0/24`/Tailscale's `100.64.0.0/10`) was verified end to end
against realistic mock data before any real dump existed — a compliant case correctly reported `OK`,
a violating case (RCON + SSH both open to Anywhere) correctly reported `CRITICAL` naming exactly
those two, while still exempting the game ports.

Checking live first found `zomboid-admin` had zero UFW access three separate ways (no sudo grant,
`ufw` itself refuses non-root, `/etc/ufw/user.rules` is `640 root:root`), and no `muncraft`
credential existed anywhere to use instead (checked Vaultwarden — every item's attachments, not
just Zomboid's — the Spark's filesystem, and the pre-migration backup). Rather than widen
`zomboid-admin`'s own sudo grant or add a new broad `muncraft` credential (both offered, both
declined), the follow-up request was a root-owned periodic dump instead: **see
`../muncraft-ufw-dump/README.md`** — a `ufw-status-dump.timer` on the muncraft box writes `ufw
status verbose` to a file `zomboid-admin` can already read via its `muncraft` group membership,
granting no new capability to that account, just visibility. `check_firewall()` reads that dump
file (with its own 45-minute staleness check) rather than attempting `ufw` directly.

**Until that timer is installed**, the `Firewall (box-wide)` section of every report shows `[WARN]
UFW firewall rules: cannot verify — .../.ufw-status.txt doesn't exist yet`. This WARN deliberately
does **not** drive the daily email on its own (see `main()`'s comment) — only a real detected
violation (`CRITICAL`) would. Once the dump timer is installed, `check_firewall()` picks it up on
its very next run automatically — no restart or code change needed here.

**The Boss installed the dump timer the same day**, and the first real run against the actual
ruleset immediately found one real parser bug and two legitimate policy exceptions — fixed in
1.4.0:
- **Bug:** UFW's real output carries trailing `# reason` comments on rules (e.g. `10.129.1.0/24
  # SSH admin subnet`) that the regex's greedy capture pulled into the source field, making
  `ipaddress.ip_network()` fail to parse an otherwise-legitimate CIDR and report it as an
  unrestricted violation purely because of the comment text. Fixed by stripping everything from
  `#` onward before parsing.
- **`192.168.1.215` added to the allowed-source list** — confirmed with The Boss as pfSense's own
  DMZ-side IP (`igc0`): admin SSH from the fleet's LAN gets NAT-hairpinned through the router and
  arrives here as that address, not the original `10.129.1.x` source. Real, intended admin path,
  not a stray exposure.
- **`25566/tcp` added to the game-port exemption list** — the real live rule was tagged `# Minecraft
  Paper`; The Boss confirmed it's a genuine second Minecraft (Paper) instance. Checked live whether
  it's actually running yet: no — only the one vanilla `java` process (`/opt/minecraft`) is up, no
  Paper process, no Paper systemd unit, no `/opt/paper` directory. The firewall rule is provisioned
  ahead of the server existing; the exemption is correct either way since the rule itself is
  intentional, but this monitor doesn't yet have a health check for Paper specifically (nothing to
  check against — no service/process exists) — worth a follow-up once it's actually stood up.

After both fixes, a re-run against the real ruleset reports `[OK] UFW firewall rules: all non-game
ALLOW rules restricted to 10.129.1.x/Tailscale` — no false positives, and a genuinely misconfigured
port would still be caught (verified earlier against mock violation data, still true post-fix).

## Design notes

- RCON is checked via a small embedded Source-RCON client run *on* the remote box (through the SSH
  session, against `127.0.0.1:25575`) rather than connected to directly from the Spark — deliberate,
  even though the live `*:25575` binding bug would currently allow a direct connection, so this
  tool doesn't come to depend on (or quietly normalize) the insecure binding it's also flagging.
- Zomboid's own RCON is disabled on this install (blank `RCONPassword` — see
  `tools/hermes-zomboid-admin.sh`'s header), so no player-count-style check is attempted for it —
  only what's reachable without RCON or sudo (service/process/disk state).
- Exit code follows the same rule `hermes-podcast-sync.py` 1.0.1 established: a WARN/CRITICAL
  finding is content this run already emailed, not a broken tool — only a failed connection, a
  failed check pass, or a failed notification send returns non-zero.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.4.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-12 | Initial version — Phase 26, ported from v1's Minecraft-only monitor and extended to Zomboid. Verified live end to end: real RCON player-count response, real backup-age data, both security/reliability findings above confirmed from live output, and a real email delivered. |
| 1.1.0 | 2026-08-12 | Phase 27: Zomboid backup mechanism added — the `Zomboid backups` check now reports real freshness/count. |
| 1.2.0 | 2026-08-12 | Phase 29: added the UFW firewall-rules review, currently blocked on real access — see the dedicated section above for the full three-way access-gap account. |
| 1.3.0 | 2026-08-12 | Phase 29 follow-up: `check_firewall()` now reads a root-owned periodic dump (`../muncraft-ufw-dump/`) instead of attempting live sudo — no widened `zomboid-admin` grant, no new `muncraft` credential. Evaluation logic verified end to end against mock compliant/violating data before any real dump existed. |
| 1.4.0 | 2026-08-12 | First real run against the actual ruleset (dump timer installed same day) found a real parser bug (UFW's trailing `# comment` annotations were being captured into the source field, breaking otherwise-valid CIDR parsing) and two legitimate policy exceptions confirmed with The Boss before adding: `192.168.1.215` (pfSense's DMZ IP) added to the allowed-source list; `25566/tcp` (Minecraft Paper, not yet actually running) added to the game-port exemption list. Re-verified clean against the real ruleset post-fix. |
