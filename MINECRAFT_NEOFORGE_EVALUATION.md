# Evaluation: NeoForge for the Firmament Fleet's Minecraft Server

**Version:** 1.0.0

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

## 5. Status

| Step | Status | Date | Notes |
|---|---|---|---|
| 0. Identify target server & confirm scope | done | 2026-11-28 | Confirmed as `minecraft-bots.service`/`firmament-bots`, not the human server or the unstood-up Paper plan |
| 1. Review NeoForge server docs | done | 2026-11-28 | `docs.neoforged.net/user/docs/server` fetched; example version `21.4.111-beta` (MC 1.21.4), install steps standard, no vanilla-client-compat statement on the page |
| 2. Version-compatibility check vs. current bot server (26.1.2) | done | 2026-11-28 | Gap confirmed — NeoForge's example is ~5 MC years behind; no indication of 26.x support |
| 3. Bot protocol-compatibility check (mineflayer vs. FML handshake) | done (desk check only) | 2026-11-28 | No FML/NeoForge support in the bot stack's dependencies; live behavior with zero server mods is unverified, not tested |
| 4. Purpose / requirement from operator | not started | | Blocked on operator naming the actual mod or mechanic wanted, by either server |
| 5. Go/no-go | **no-go, as stated** | 2026-11-28 | Recommend against proceeding until step 4 produces a concrete requirement; see §4 for the conditional path if one emerges |

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-28 | Direct operator request: evaluated converting the Firmament fleet's Minecraft bot server to NeoForge per `docs.neoforged.net/user/docs/server`. Found a hard version-compatibility gap (NeoForge's docs example tracks MC 1.21.4 against the fleet's current 26.1.2) and an unverified bot-protocol-compatibility risk (mineflayer has no FML support); recommended not proceeding without a named concrete requirement. |
