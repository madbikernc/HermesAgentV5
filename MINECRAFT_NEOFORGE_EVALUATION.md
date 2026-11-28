# Evaluation: NeoForge for the Firmament Fleet's Minecraft Server

**Version:** 1.2.0

Evaluates converting "the default Minecraft server linked to The Firmament fleet" to NeoForge
(a modded server loader), per direct operator request, using
[docs.neoforged.net/user/docs/server](https://docs.neoforged.net/user/docs/server) (fetched
2026-11-28) as the source. **Conclusion: do not proceed as stated — the target version doesn't
exist for NeoForge, and the fleet's own bots can't speak the modded protocol anyway.** Details and
a conditional path forward below.

## 1. Which server this is

Two unrelated Minecraft servers run on muncraft (`192.168.1.221`):

| | Port | Dir | Version | Relation to Firmament |
|---|---|---|---|---|
| `minecraft-bots.service` ("firmament-bots") | 25580 | `/home/zomboid-admin/minecraft-bots/` | 26.1.2, vanilla `server.jar` (upgraded 2026-11-14, see `MINECRAFT_SERVER_UPGRADE_PLAN.md`) | **This one.** `skills/minecraft-admin/SKILL.md` and the archived `MINECRAFT_BOTS_DESIGN.md` both call this the Firmament fleet's own bot sandbox |
| `minecraft.service` (human server) | 25565 | `/opt/minecraft/` | vanilla | Not Firmament's; explicitly out of scope per `MINECRAFT_SERVER_UPGRADE_PLAN.md` §0 |

A third thing — a plugin-capable PaperMC instance — is planned in `skills/minecraft-plugin-management/SKILL.md` but has never actually been stood up ("no Paper instance is actually running yet" as of that skill's last revision).

So "the default Minecraft server linked to The Firmament fleet" is the bot sandbox, `firmament-bots`, currently running vanilla 26.1.2, with nine mineflayer bots (Amy, Luke, Bob, Dale, Wade, Nell, Mark, Mayor, Babs) connected to it across spark/spark2.

## 2. What the NeoForge docs say

From the fetched page:

- **Install:** download a per-version installer jar from `maven.neoforged.net`
  (e.g. `neoforge-<version>-installer.jar`), run `java -jar neoforge-installer.jar --installServer`,
  tune `user_jvm_args.txt`, accept the EULA, start with `run.sh`/`run.bat`. Standard, low-risk steps
  on their own.
- **Example version pinned in the docs: `21.4.111-beta`.** NeoForge's versioning tracks Minecraft's
  own version (`21.4` = Minecraft 1.21.4, `x.y` = `1.x.y`). The docs don't cover, or even gesture
  at, anything resembling Minecraft's current `26.x` line.
- **Mods go in a `mods/` folder**, sourced from CurseForge/Modrinth.
- **The page itself flags vanilla and modded as different things**, not an upgrade path: its "See
  Also" explicitly notes the vanilla server-setup wiki articles "talk about setting up a vanilla
  Minecraft server, not a modded one."
- The page says nothing about non-modded client compatibility — that's a gap this evaluation has to
  fill from the fleet's own side (§3b).

## 3. Why this blocks, as stated

### 3a. Version gap

NeoForge is a modding toolchain built against Mojang's mappings/decompiled sources for each specific
Minecraft release, and historically lags vanilla releases by weeks to months — longer for a release
with engine changes. The current public docs example sits at Minecraft **1.21.4**. The Firmament bot
server is on **26.1.2**, the result of a deliberate, just-finished upgrade
(`MINECRAFT_SERVER_UPGRADE_PLAN.md`, cutover 2026-11-14) chosen specifically because it's the newest
version mineflayer supports at all. There is no indication NeoForge has reached, or is near, that
version. Converting as literally requested would mean **downgrading the bot server by roughly five
years of Minecraft versions**, undoing that upgrade outright — the opposite of what the upgrade plan
just spent a trial-and-cutover process achieving.

### 3b. The bots don't speak modded protocol

The fleet's research (this session) confirms the bot stack — mineflayer 4.39.0,
minecraft-protocol 1.68.0, minecraft-data 3.116.0 — is a pure vanilla-protocol client. Nothing in
`services/minecraft-bots/package.json` or its code implements FML/NeoForge's modded login
handshake (the channel-negotiation step modded servers run during the configuration phase).

Whether a non-modded client can still join a NeoForge server that has **zero mods installed** is a
real, separate question from "the server has 50 mods installed" — bare NeoForge *may* behave
close enough to vanilla at the network level for an unmodified client to pass, the way old Forge
sometimes did when no mod needed client-side presence — but nothing in the fetched docs confirms
this, and it has not been tested against this fleet's mineflayer stack. Getting it wrong risks
disconnecting all nine bots at once.

### 3c. No stated purpose yet

The request doesn't say what the mods are for. That matters because the two plausible goals point
at completely different, non-overlapping solutions:

- **Mods for players/world content** → the bot sandbox is the wrong target regardless of NeoForge's
  version support; it exists for bot testing, not for human play (that's the separate `:25565`
  server). And even there, the project's own unexecuted `minecraft-plugin-management` skill (PaperMC
  plugins) already covers "add server-side functionality without a client mod requirement" more
  safely than a Forge-family loader, for anything Paper's plugin ecosystem can do.
- **Mods for bot-observable behavior** (e.g. the diagnostics/telemetry interest noted in
  `MINECRAFT_BOTS_RESTART_PLAN.md` Phase 16) → NeoForge is the wrong tool even if the version gap
  didn't exist, because mineflayer bots can't use client-side mod features at all, and any
  server-side mod would need the exact bot-protocol compatibility this evaluation flags as unverified.

## 4. Recommendation

**Do not set this up now.** Both blockers in §3a/§3b are independent, either one alone is enough to
stop here, and §3c means there's no concrete requirement to weigh the cost against yet.

If there's a real need behind this (a specific mod, a specific mechanic), the right next step is to
name it, then re-run this evaluation against that specific mod's actual Minecraft-version
requirement and client-side-ness — not against NeoForge in the abstract. If it turns out to need a
genuinely modded server:
- Build it as a disposable, isolated instance (same trial-first discipline as
  `MINECRAFT_SERVER_UPGRADE_PLAN.md`: separate directory/ports, firewalled off from spark/spark2 and
  from the real bot and human servers), on whatever Minecraft version NeoForge actually ships for the
  desired mod — very likely not 26.x.
- Test one disposable bot against it before touching the real fleet, specifically for the FML
  handshake question in §3b.
- Never touch the live `firmament-bots` world or the human server to get there.

## 5. Follow-up: requirement named, retargeted to the human server (2026-11-28)

Direct operator instruction, same day: drop the bot-sandbox framing entirely and target the real,
human-player-facing server (`minecraft.service`, muncraft `:25565`, `/opt/minecraft/`) instead —
resolving §3c. Named mods: [Farmer's Delight](https://www.curseforge.com/minecraft/mc-mods/farmers-delight),
[Immersive Engineering](https://www.curseforge.com/minecraft/mc-mods/immersive-engineering),
[Jade](https://www.curseforge.com/minecraft/mc-mods/jade). §3b (bot protocol) doesn't apply here —
no mineflayer bot connects to the human server.

**§3a reopened, and found stale.** The human server is also on 26.1.2 (confirmed live,
`version_history.json`: `26.1.2-74-e4e17fc`). But NeoForge itself has since caught up: a maven
metadata check (`maven.neoforged.net`) found real, installable NeoForge builds through `26.1.2.130`
— the docs page's `21.4.111-beta` example was just stale/non-representative, not NeoForge's actual
ceiling. Per-mod reality at 26.1.2, checked against Modrinth/CurseForge directly:

| Mod | Official NeoForge ceiling | 26.1.2 build? |
|---|---|---|
| Jade | 26.3 (actively ported) | Yes — `26.1.12+neoforge` |
| Farmer's Delight | 1.21.1 | No official build; an unofficial community port (`farmers-delight-modern-neoforge`, KN_Yeon) covers 26.1.2 |
| Immersive Engineering | 1.21.1 (last updated 2025-07-05) | No — official or unofficial, none found anywhere |

Presented to the operator as a choice (no build of Immersive Engineering exists for 26.1.2, full
stop): skip it, downgrade the whole server to 1.21.1 where all three mods have mature official
builds, or hold. **Operator chose to downgrade** (new NeoForge instance, Minecraft 1.21.1) with a
**fresh world** rather than trying to carry the 26.1.2 world backward — consistent with this
document's own original warning that a world's version move is one-directional.

**Built as an isolated side instance, not an in-place conversion** — same discipline §4 called for:
new directory, new ports, the live `minecraft.service` (`:25565`) never stopped or touched.

- `/opt/minecraft-neoforge` on muncraft, NeoForge `21.1.268` (MC 1.21.1), systemd unit
  `minecraft-neoforge.service` (created, started, **not** enabled on boot — a deliberate choice so
  it doesn't persist past a reboot without an explicit decision to keep it).
- Game port `25590`, RCON `25591` — picked after discovering port `25567` (the first choice) carries
  a stale `ufw` rule comment ("Block Paper RCON from outside") from unrelated, undocumented past
  experimentation on this box (`paper-test.service`, a live but unrelated "Phase 5 chat-signing
  hypothesis test"; `/opt/velocity`, `/opt/minecraft-handshake-injector/relay` are further leftover
  infra from past work with no trace in any repo). Neither `25590` nor `25591` has an existing `ufw`
  rule. **Not opened to the internet/LAN** — reachable only on-box for now; exposing it to the
  whitelisted players is a separate decision for the operator, since every one of them will need to
  install NeoForge `21.1.268` plus the three mod jars client-side to connect at all.
- Whitelist and ops copied verbatim from the live human server (`diff` confirmed byte-identical):
  the same 7 whitelisted players, the same 2 ops (`CanisLupisM`, `EntropyX2`).
- Mods installed and confirmed loaded in the boot log: Farmer's Delight `1.3.4`, Immersive
  Engineering `12.4.2-194`, Jade `15.10.6+neoforge` (Jade's own log shows it picked up Immersive
  Engineering's WAILA compat plugin automatically). Server reached `Done` and RCON confirmed the
  whitelist live.

## 7. Cutover: replaced the live human server (2026-11-28)

Direct operator instruction, same day: make the NeoForge instance boot-persistent, give it the
same firewall reachability the human server had, and move it to actually replace that server —
"The human players will have to resolve their client side issues on their own."

No one was online on the old server at cutover time (RCON `list`: 0 players). Sequence, in order:

1. `save-all flush` on the old vanilla server, then `systemctl disable --now minecraft.service`.
   Confirmed a clean shutdown (all dimensions/chunks saved in the log) despite systemd showing
   `status=143` (SIGTERM exit code — normal for a Minecraft server stopped this way, not a crash).
   **Nothing was deleted**: `/opt/minecraft` and its world are untouched and the unit still exists,
   just disabled — rollback is `systemctl enable --now minecraft.service` with zero data loss.
2. Repointed `/opt/minecraft-neoforge/server.properties` onto the human server's own ports —
   `server-port=25565`, `rcon.port=25575` — and set its `rcon.password` to match
   `/opt/minecraft/server.properties`'s existing password, so `tools/hermes-minecraft-admin.py` and
   `tools/hermes-game-server-monitor.py` (both of which read that password from the old file
   unconditionally) keep authenticating correctly with no code change.
3. `systemctl enable --now minecraft-neoforge.service` — boot-persistent, confirmed `Done`, RCON
   and the whitelist (7 players) answered correctly on `:25575`.
4. **No `ufw` change was needed for "reachable as previously true":** port `25565` already carried
   `ALLOW Anywhere` (v4 and v6) for the old server, and `25575` already carried `DENY Anywhere` for
   its RCON — both rules are keyed to the port number, not the service, so NeoForge inherited the
   exact same reachability the moment it bound those ports. Confirmed both rules unchanged.
5. **Monitoring fixed, not left to silently break:** `tools/hermes-game-server-monitor.py`
   (`check_minecraft()`) hardcoded `minecraft.service`'s active-state and MainPID checks — these
   would have reported the (correctly, deliberately) retired old unit as down forever. Repointed
   both to `minecraft-neoforge.service` (1.6.0 → 1.6.1). The disk-usage check is unaffected (same
   filesystem). **The backup check was not fixed** — `/opt/minecraft/backups/` will go stale since
   nothing writes to it anymore, and the new instance has no backup automation of its own yet. This
   is a real, open gap, not an oversight to silently paper over — see Step 9 below.
6. Cosmetic cleanup: `minecraft-neoforge.service`'s `Description` updated from "Modded Trial" to
   "Minecraft Server (NeoForge 1.21.1 — ...)" to reflect its real role now; the installer jar and a
   one-off setup script removed from `/opt/minecraft-neoforge/`; `systemctl reset-failed` cleared
   the old unit's cosmetic post-SIGTERM "failed" display (it is simply `inactive`/`disabled` now).

**Known consequences, not hidden:** the world is fresh (no carried-over builds from the old 26.1.2
world — the operator chose this explicitly beforehand), and every one of the 7 whitelisted players
must install NeoForge `21.1.268` plus the exact three mod jars client-side before they can connect
at all — the operator has accepted that this is on the players to sort out themselves.

## 8. Status

| Step | Status | Date | Notes |
|---|---|---|---|
| 0. Identify target server & confirm scope | done | 2026-11-28 | Confirmed as `minecraft-bots.service`/`firmament-bots`, not the human server or the unstood-up Paper plan |
| 1. Review NeoForge server docs | done | 2026-11-28 | `docs.neoforged.net/user/docs/server` fetched; example version `21.4.111-beta` (MC 1.21.4), install steps standard, no vanilla-client-compat statement on the page |
| 2. Version-compatibility check vs. current bot server (26.1.2) | done | 2026-11-28 | Gap confirmed — NeoForge's example is ~5 MC years behind; no indication of 26.x support |
| 3. Bot protocol-compatibility check (mineflayer vs. FML handshake) | done (desk check only) | 2026-11-28 | No FML/NeoForge support in the bot stack's dependencies; live behavior with zero server mods is unverified, not tested |
| 4. Purpose / requirement from operator | done | 2026-11-28 | Operator named the human server (not the bot sandbox) plus three specific mods — see §5 |
| 5. Go/no-go | **go, retargeted and scoped — see §5** | 2026-11-28 | Original bot-sandbox framing stays no-go (§3a/§3b still block it outright); the human-server path got a conditional go once the version/mod gaps were mapped and the operator chose how to resolve them |
| 6. Build the isolated NeoForge instance | done | 2026-11-28 | `/opt/minecraft-neoforge`, NeoForge 21.1.268 (MC 1.21.1), ports 25590/25591, not firewall-opened; live human server untouched throughout |
| 7. Install mods, whitelist, ops | done | 2026-11-28 | Farmer's Delight 1.3.4, Immersive Engineering 12.4.2-194, Jade 15.10.6+neoforge all load; whitelist/ops byte-identical to the human server |
| 8. Cut over to replace the live human server | done | 2026-11-28 | Operator direction — see §7. Old `minecraft.service` disabled (not deleted, world intact); NeoForge now owns `:25565`/`:25575`, boot-enabled; firewall reachability unchanged (port-keyed rules); monitor script repointed |
| 9. Backup automation for the new instance | not started | | Open gap: the old server's `minecraft-backup.service`/`/opt/minecraft/backups/` pipeline does not cover `/opt/minecraft-neoforge` — nothing backs up the new world yet |

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.2.0 | 2026-11-28 | Direct operator request: made the NeoForge instance boot-persistent and cut it over to replace the live human server outright — same ports (`:25565`/`:25575`) so existing `ufw` reachability carried over with no firewall changes, old `minecraft.service` disabled (not deleted, world intact, instantly reversible), RCON password matched so existing admin/monitor tooling kept working, and `tools/hermes-game-server-monitor.py` repointed (1.6.0 → 1.6.1) so it doesn't report the deliberately-retired old unit as down. Flagged one real open gap: no backup automation yet for `/opt/minecraft-neoforge`. Operator explicitly accepted that players must resolve client-side mod installation themselves. |
| 1.1.0 | 2026-11-28 | Direct operator request: dropped the bot-sandbox framing, retargeted to the real human server, and named three mods (Farmer's Delight, Immersive Engineering, Jade), resolving §3c. Found NeoForge itself now reaches 26.1.2 (the original §3a version-gap finding was about the docs page's stale example, not NeoForge's real ceiling) — but Immersive Engineering has no NeoForge build past 1.21.1 anywhere. Operator chose to downgrade to a fresh 1.21.1 world rather than carry the 26.1.2 world backward. Built and verified live as an isolated side instance (`/opt/minecraft-neoforge`, ports 25590/25591, not enabled on boot, not firewalled open) with all three mods loaded and the human server's whitelist/ops copied over; the live `:25565` server was never stopped or modified. |
| 1.0.0 | 2026-11-28 | Direct operator request: evaluated converting the Firmament fleet's Minecraft bot server to NeoForge per `docs.neoforged.net/user/docs/server`. Found a hard version-compatibility gap (NeoForge's docs example tracks MC 1.21.4 against the fleet's current 26.1.2) and an unverified bot-protocol-compatibility risk (mineflayer has no FML support); recommended not proceeding without a named concrete requirement. |
