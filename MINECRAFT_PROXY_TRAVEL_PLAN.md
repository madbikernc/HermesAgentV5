# Human Player Travel: Default World → Bot World

**Version:** 5.0.0

Plan to let a human player connect to the default (human) Minecraft server as today, then switch
in-session to the bot-fleet world and back, by typing a `/server` command, without needing to
leave the client or re-add a server to their multiplayer list. Both worlds are vanilla Java
servers run by the same `muncraft` account on the same box (`192.168.1.221`) and are otherwise
unrelated — this plan touches their network path, not their game content, world saves, or (for
the bot world) anything the fleet depends on.

## 1. Current state (verified 2026-11-23/24)

| | Default (human) world | Bot world |
|---|---|---|
| Port | `25565` (public, Velocity) | `25580` (real backend) + `25584` (bots/architect entry point) |
| Dir | `/opt/minecraft/` | `/home/zomboid-admin/minecraft-bots/` (`MINECRAFT_BOTS_DESIGN.md`) |
| Software | Paper `server.jar`, 26.1.2 | Paper `server.jar`, 26.1.2 (converted from vanilla 2026-11-25, Phase 5) |
| `online-mode` | `false` (Velocity does the real auth) | `false` (offline — any client can claim any username) |
| Whitelist | `white-list=true`, 7 entries in `whitelist.json`, each keyed to a real Mojang UUID | n/a |
| RCON | enabled on the box | port `25581` |
| Firewall | public on `:25565` via Velocity | `25580` reachable only from `127.0.0.1` (Velocity + the injector relay, both local); `25584` mirrors `25580`'s original LAN/Tailscale/NAT-hairpin-only rules |
| Backups | `backup.sh` + `backups/` already exist on the box | separate, fleet-owned backup path (`infra/minecraft-bots-backup/`) |

**Superseded 2026-11-25 (see §2b and Phase 5):** this table originally described both servers as
permanently independent, with the bot world staying vanilla, untouched, on its original port
forever. That no longer holds — the bot world's software, `bungeecord` setting, and the bots' own
connection port all changed, as the one deliberate, fully-justified exception this plan ended up
needing. Both servers are **on the same physical box**, run by the same OS account, but remain
otherwise independent processes with no shared config, no shared world save, and no shared
player-data.

## 2. Why a proxy, and why a plugin swap turned out not to be needed

A `/server <name>` command that switches a connected player between two backend Minecraft server
processes is not a vanilla feature — it only exists if the player's client is connected through a
proxy (Velocity, chosen over BungeeCord/Waterfall as the actively maintained option) that sits
between the client and both backends and relays the connection. That requirement is unavoidable
for *either* direction, so both worlds end up behind the same proxy once this is built, not just
the bot-world side.

**What this does *not* require:** detecting a player's in-world action (e.g. walking into a
portal) needs a plugin on whichever server hosts that world, and vanilla has no plugin API — but
since the decision (2026-11-24, direct request) is a typed `/server` command in both directions
rather than a world-built portal, no server needs plugin capability for that reason. The bot-world
server stays exactly as it is: vanilla, offline-mode, directly connectable by the bots, never
touched by this plan.

**What still motivates touching the default-world server:** any backend sitting behind a proxy
must run with `online-mode=false` itself (the proxy does the one real Mojang authentication; a
backend that also tries to verify the session independently will fail). A pure-vanilla backend
cannot receive the proxy's forwarded real player UUID at all, under any forwarding mode — so once
proxied, it falls back to generating an offline-style UUID from the username, which no longer
matches `whitelist.json`'s real UUIDs. Left unfixed, that **locks out every one of the 7
whitelisted players**, not just unauthenticated guests. Paper (a drop-in, protocol-compatible
replacement for vanilla; same world save, same `whitelist.json`/`ops.json`/`banned-*.json` formats)
knows how to consume the proxy's forwarded identity and keep the whitelist meaningful. The bot
world has no whitelist and no identity to preserve, so it has no equivalent reason to change.

**Forwarding mode:** Velocity's `player-info-forwarding-mode` is one setting for the whole proxy
instance, not configurable per backend. "Modern" forwarding requires the backend to answer a
Velocity-specific login handshake step; a backend that doesn't understand it (vanilla) fails the
connection outright, not just silently. "Legacy" forwarding instead embeds identity into the
server-address field of the ordinary handshake: a Paper/Spigot backend with `bungeecord: true`
parses it, a plain-vanilla backend ignores it harmlessly and logs the connection in exactly the
way it already does today. **Legacy forwarding is therefore the one mode compatible with both
backends as planned** (Paper default-world, vanilla bot-world) without changing the bot world at
all. Its one real weakness — a backend reachable directly could have forged identity data injected
— is closed by firewalling both backends to accept connections only from the proxy's own address
(§5), which the bot world already does in spirit (LAN/Tailscale only) and the default world does
not yet.

**Wrong, found 2026-11-25 during Phase 5's live test:** the claim above that a plain-vanilla
backend "ignores [legacy forwarding] harmlessly" does not hold for this vanilla 26.1.2 build. It
actively rejects the legacy-forwarded handshake and closes the connection outright ("unable to
connect to server botworld... usually because the remote server does not have BungeeCord IP
forwarding correctly enabled" — Velocity's own log, not a config problem on Velocity's side).
Since forwarding mode is one proxy-wide setting, not per-backend, there is no `velocity.toml` fix:
Paper needs legacy forwarding to preserve the whitelist; this vanilla server rejects it outright.
See Phase 5 for the options this leaves.

**Decided (2026-11-24, direct operator confirmation):** go ahead with the Paper swap on the
default-world server to preserve real-UUID whitelist enforcement. See §2a for a new condition
this now carries, raised the same day.

## 2a. Plugin/mod support (resolved 2026-11-24: plugins, not client mods)

Direct request, same day as §2: beyond the whitelist, the default-world server also needs to
support plugins/mods the players ask for. That request forced the exact fork flagged when this
section was first written:

- **Server-side plugins** (Bukkit/Spigot/Paper API — no client-side install, e.g. most
  permissions, economy, world-protection, and QoL plugins) are exactly what the Phase 2 Paper
  swap already buys, at no extra cost to this plan.
- **Mods** in the Forge/Fabric sense — anything requiring a matching mod installed in each
  player's own client, which covers most content/mechanics mods — **do not run on Paper at all.**
  That needs a different server loader (Fabric or Forge) or a hybrid server (e.g. Mohist,
  Arclight) that attempts both ecosystems at once, each with its own compatibility trade-offs.

The finalized ask (evaluated 2026-11-24) was three real Forge/NeoForge content mods — Farmer's
Delight, Immersive Engineering, Jade — none of which are plugins. Two directions were considered:

1. **Chase the actual mods.** Requires a hybrid loader (Mohist/Arclight) understanding both
   Forge/NeoForge and the Bukkit plugin API (for `settings.bungeecord: true`/legacy forwarding to
   keep working), *and* moving the default world to whatever older Minecraft version those mod
   builds target — which would also have broken the `/server` transport itself: two backends on
   genuinely different, incompatible wire protocols, with no realistic translation layer (Via*
   family) proven to bridge a gap that size. **Rejected** — it reopens both the software choice
   and the transport design this whole plan depends on, to chase mods rather than gameplay.
2. **Plugin-equivalent content, default world unchanged.** Keeps the default world on its current
   Minecraft version (matching the bot world — no protocol gap, no `/server` transport risk at
   all) and keeps Paper exactly as §2 decided. **Decided.**

Resolution, mod by mod:
- **Immersive Engineering → Slimefun.** A Paper plugin building the same genre of tech/industrial
  progression (machines, generators, multiblocks) server-side only, using a resource pack for
  custom textures instead of a Forge mod. Not a feature-for-feature match, but the closest
  established equivalent. **Found while installing (2026-11-25): the original Slimefun4 project
  (TheBusyBiscuit) is discontinued; what's actually live and current is "Slimefun5," a
  community-maintained continuation published on Hangar (`Slimefun/Slimefun`), which explicitly
  declares support through Paper 26.1.2. It self-identifies in its own startup log as an
  "UNOFFICIALLY MODIFIED BUILD — NO OFFICIAL SUPPORT GIVEN" — worth knowing, not a blocker.**
- **Farmer's Delight → back in scope, tracked separately (2026-11-24 direct request).** No
  off-the-shelf plugin match exists; building an approximation (custom-items framework + resource
  pack) is now its own dedicated plan — see `FARMERS_DELIGHT_EQUIVALENT_PLAN.md`. This plan's own
  requirement is unchanged either way: that build only has to be a plugin, not a Forge/NeoForge
  mod, which the new plan's own §1 confirms.
- **Jade → no server-side change needed at all.** Jade already runs client-only against any
  server, vanilla or Paper, falling back to plain block/entity info with no mod on the server
  side. It never actually forced this fork.

With this resolved toward plugins, **Phase 2 proceeds exactly as originally planned** (a plain
Paper swap, §2) — no hybrid loader, no server-software reopening, no transport risk.

## 2b. The travel requirement, restated (2026-11-25) — what actually forced the Phase 5 redesign

Direct operator input, mid-Phase-5, after the first relay fix (below) surfaced a second bug and
three lighter fixes for it all failed: the access model this plan has to satisfy, made explicit
for the first time (it had been implicit before, and the implicit version was wrong in one load-
bearing way — see below):

1. Most players log into the **default world** using their Microsoft/Minecraft account, exactly as
   today, through the existing whitelist.
2. The **bot-world architect** logs in directly to the bot world — not through the default world —
   using either a local/offline identity or their Microsoft/Minecraft UUID, whichever is
   convenient. This is today's existing direct LAN/Tailscale door; it must keep working.
3. Players who log in through the default world can type a command (or, later, use an in-world
   portal) to travel to and from the bot world.

Requirement 2 is the one that matters most for what follows: it means the bot world can never be
allowed to require proxy-forwarded identity on its *only* listening port, because that would also
require the architect's own direct connection and the 9 bots' own direct connections to carry
forwarded data they don't send. A design that only satisfies requirement 3 by making the bot
world's real port proxy-only (as the first relay fix implicitly assumed it eventually would) breaks
requirement 2 the moment it's live — the same shape of outage Phase 2 already hit once. Phase 5's
second half (below) is the direct consequence of taking requirement 2 as seriously as requirement
3, rather than treating the architect's and the bots' direct access as something that could be
quietly sacrificed to get travel working.

One adjacent idea considered and rejected the same day: making the bot world's port reachable from
a wider `ufw` scope, *without* adding a NAT/port-forward rule on the home router, on the theory that
this might let remote (non-LAN, non-Tailscale) players reach it directly. It doesn't — `ufw`
governs what's allowed once a packet already reaches the box's NIC; NAT/port-forwarding is what
lets a remote player's packet arrive at a private-IP box at all. Without a NAT rule, loosening
`ufw` adds no reachable population beyond what LAN/Tailscale already covers, and it does nothing
for the chat-signing bug (Phase 5) either, since that bug is triggered by Velocity's forwarding
chain regardless of the bot world's firewall posture. Real public exposure of the bot world's own
port (an actual NAT forward, `online-mode=true` on that server) was recognized as a *different*,
valid architecture — but the opposite of what requirement 2 asks for (architect-only direct access,
everyone else through the default world's proxy), so it was not pursued.

## 3. Non-goals

- ~~No change to the bot world's software, port, firewall posture, or how the 9 bots connect~~ —
  **superseded 2026-11-25, Phase 5, direct operator sign-off at each step.** What was originally a
  single narrow exception (`enforce-secure-profile=false`) turned out to be insufficient on its
  own — see Phase 5 for the full chain of findings — and the actual fix required all of the
  following, every one of them a real, deliberate change to the bot world, none of them optional
  once §2b's requirement 2 (the architect's and the 9 bots' direct access must keep working) was
  taken as a hard constraint rather than something travel could quietly break:
  - **Software:** vanilla → Paper 26.1.2 (same build already proven on the default world).
  - **`spigot.yml`:** `bungeecord: true` (previously, and still, `false` on the default world's
    *vanilla* predecessor was never an option — this is the one thing vanilla categorically cannot
    do, see Phase 5).
  - **Port the bots and the architect connect to:** moved from `25580` direct to `25584`, a new
    injector relay (`tools/minecraft-handshake-injector.py`) in front of the unchanged real
    `25580` listener — required because `bungeecord: true` is global to that one port and would
    otherwise reject the bots' and the architect's own non-forwarded connections outright, the same
    failure mode as Phase 2's `:25565` outage.
  - **Firewall:** `25584` carries the exact same LAN/Tailscale/NAT-hairpin-only rules `25580`
    always had; `25580` itself is now reachable only from `127.0.0.1` (Velocity and the injector,
    both local).
  All of this was necessary, not scope creep: every alternative that kept the bot world
  byte-for-byte untouched also kept it vanilla, and vanilla cannot participate in legacy forwarding
  at all (not a parsing gap — a missing capability, confirmed empirically, see Phase 5). The one
  thing that genuinely stayed a non-goal throughout: no change to the bots' own code, behavior, or
  world save/player-data continuity — confirmed byte-for-byte via the offline-UUID check in Phase
  5 before any live change was made, and again after, via each bot's unchanged stats/goals on
  reconnect.
- No shared inventory/player-data between the two worlds — they remain separate saves; travelling
  over is a fresh arrival each time, same as any other multi-server setup without an added
  inventory-sync plugin. Not in scope unless asked for later.
- No in-world portal object in this plan (superseded by the `/server`-command decision, §2). If
  wanted later, it is a separate, additive change (a small plugin on whichever server needs to
  detect entry into the portal region) and does not require revisiting anything decided here.

## 4. Phases

### Phase 0 — decisions and access (operator)

- Paper swap on the default-world server: decided, §2 — proceed.
- Plugin/mod fork (§2a): resolved — plugins, not client mods. Slimefun for Immersive Engineering;
  Jade needs no server-side change; Farmer's Delight tracked separately in
  `FARMERS_DELIGHT_EQUIVALENT_PLAN.md`. Default world stays on its current Minecraft version.
- Phase 2a's re-init decisions: resolved — new seed, and every per-player `playerdata`/`stats`/
  `advancements` resets (no carry-over from the current world).
- SSH/sudo access: confirmed 2026-11-25 — connects as `pmoney` (via spark's `muncraft` alias),
  passwordless `sudo` works for `systemctl`/`ufw`. File ownership on the box is `muncraft`, so any
  write that needs to land as that user (backups, the jar swap) goes through `sudo -u muncraft`,
  not plain `sudo` — `pmoney` alone can't write into `muncraft`-owned, non-group-writable paths
  like `backups/`.
- Rollback-comparison state: recorded 2026-11-25 — Java 25.0.5.1; vanilla `server.jar` SHA-1
  `97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51` (kept on disk as `server-vanilla.jar.bak`);
  `server.properties`/`whitelist.json`/`ops.json`/`banned-players.json`/`banned-ips.json` hashes
  recorded; fresh backup `world_2026-11-25_01-19-59.tar.gz` taken (after discovering `backup.sh`
  needs `sudo -u muncraft` to write into `backups/`, per the access note above).

### Phase 1 — stand up Velocity without touching either live server

- Install Velocity (latest stable matching protocol 775/26.1.2) on `192.168.1.221`, listening on a
  **temporary, non-public port** (`:25568` — not `:25567`, which `ufw status numbered` shows
  already in use, blocking Paper RCON from outside; confirmed 2026-11-25) so neither live server
  is affected yet.
- `velocity.toml`: `player-info-forwarding-mode = "legacy"`; `[servers]` entries `default ->
  127.0.0.1:25565` (still the real port for now) and `botworld -> 127.0.0.1:25580`; `try =
  ["default"]`.
- Verify from a test client: connecting to `:25568` reaches the default world exactly as `:25565`
  does today (same login, same whitelist check, since nothing has moved yet and forwarding mode
  doesn't matter until the backend's own `online-mode` changes). This isolates "does Velocity work
  at all on this box" from every later, riskier step.

### Phase 2 — Paper swap on the default-world server (only if Phase 0's decision says yes)

- Stop the default-world server after an RCON `save-all flush`; confirm the owning PID exits.
- Download Paper 26.1.2 (matching build), verify its hash, keep the old `server.jar` as
  `server-vanilla.jar.bak`.
- `server.properties`: no change to `white-list`/`online-mode` yet — those move in Phase 3, not
  here, so this step is independently verifiable (start Paper on the same port, same online-mode,
  confirm whitelisted players can still join exactly as before the swap, world/whitelist/bans
  carried over correctly).
- ~~`spigot.yml`: set `settings.bungeecord: true` — harmless while nothing is proxied yet~~ —
  **wrong, corrected 2026-11-25 after a real outage:** this flag is not harmless before a proxy
  exists. It rejects any direct (non-proxied) connection outright ("Failed to connect... please
  enable IP forwarding in your BungeeCord config as well"), because the server then expects
  forwarded handshake data that only Velocity would ever supply. Leave it `false` here; it moves
  to Phase 3 instead, set in the same stopped-state edit as the port change — never before.
- Install Slimefun (build matching Paper 26.1.2); verify it loads cleanly (no plugin.yml/API
  errors in the log) and a basic machine/recipe works for a test account. Do this before Phase 2a
  touches the world — if Slimefun doesn't load clean, the old world is still intact to fall back
  to. **Done 2026-11-25:** installed "Slimefun5" (`Slimefun/Slimefun` on Hangar) v5.3.3,
  hash-verified; loaded clean in 3.7s (557 items, 260 researches, 1,515 recipes, 0 errors), shown
  enabled via RCON `plugins`. **Confirmed 2026-11-25 by direct operator test, in-game: Slimefun
  works.** Phase 2's checklist is now fully satisfied, not just "loads clean."

### Phase 2a — re-init the default world's save (new; only after Phase 2 is verified)

Direct request: once Paper + Slimefun are confirmed working, regenerate the default world's actual
save from scratch — fresh terrain, not a continuation of the current map — while carrying forward
every operator/identity-level configuration from the existing default world untouched.

**Preserved verbatim, no regeneration:** `server.properties` (every key, including anything
already customized away from shipped defaults), `whitelist.json`, `ops.json`,
`banned-players.json`, `banned-ips.json`, and every plugin config file (Paper's own, Slimefun's,
anything else installed in Phase 2) — none of these live inside the world save directory, so a
world re-init does not touch any of them on its own.

**Decided (2026-11-24, direct operator input):** a new seed (genuinely different landscape, not a
continuation of the current one), and every per-player `playerdata/`, `stats/`, and
`advancements/` resets — no carry-over from the current world. Both live *inside* the world save
folder, unlike the config files above, so a plain re-init already does this correctly on its own;
no extra copy step is needed for either.

**Steps:**
- Full backup of the *current* default-world save directory as a permanent, explicitly-named
  restore point (not just the routine `backup.sh` churn) — never delete the pre-re-init save, even
  though nothing from it is being carried forward; it's the only rollback path if Phase 2a itself
  goes wrong.
- Stop the server after `save-all flush`; move the existing `world`/`world_nether`/`world_the_end`
  directories aside intact (not deleted, archived with the backup above); start the server with no
  `level-seed` set to the old value, so Paper generates a genuinely fresh world.
- Confirm the preserved config files from above are unchanged (most never moved, since they sit
  outside the world save directory).
- Verify: whitelisted players can log in to a clean slate (no stats/advancements carried over),
  ops/bans intact, Slimefun (and any other Phase 2 plugin) functions correctly on the new terrain.

### Phase 3 — move the default world behind the proxy

- Stop the (now Paper) default-world server; change `server.properties`: `server-port=25566`
  (internal), `online-mode=false`; set `spigot.yml`'s `settings.bungeecord: true` in the same
  stopped-state edit, before the one restart that follows — **not any earlier** (see Phase 2's
  corrected note: this flag breaks direct connections the moment it's live, so it must go live in
  the exact same restart that also takes the server off the public port, never before it).
- Firewall: `25566` reachable only from `127.0.0.1` (same box as Velocity) — never exposed the way
  `25565` was. **Confirmed 2026-11-25: a rule already admits `25566/tcp` from `Anywhere`
  (commented "Minecraft Paper," nothing bound to the port yet) — this step must actively tighten
  that existing rule, not just add a new one on the assumption the port starts closed.**
- Update `velocity.toml`'s `default` entry to `127.0.0.1:25566`; keep Velocity on its temporary
  port (`:25568`) for one more round of verification with a trusted test account before touching
  the public port. **Also flip Velocity's own `online-mode` from Phase 1's `false` to `true` —
  found while executing this phase, not in the original text: once the backend trusts forwarded
  identity (`bungeecord: true` + backend `online-mode=false`), Velocity's own `online-mode` is the
  only remaining real authentication check in the chain. Leaving it `false` here would let anyone
  claim to *be* any whitelisted username and get waved straight through — the inverse of the
  lockout risk §2 exists to prevent.**
- Verify: whitelisted test login through `:25568` succeeds and is recognized as the *same* player
  (correct skin/UUID, not re-added to the whitelist under a new offline UUID) — this is the
  concrete test of the §2 identity-forwarding concern, not just "does it connect."

### Phase 4 — cut the public port over

- Stop Velocity; change its listener to `:25565`; start it.
- Confirm the real default-world backend (now on `:25566`) is **not** independently reachable from
  outside the box (firewall check, not just "Velocity happens to be in front").
- Confirm `:25580` (bot world) is unaffected — bots still connect exactly as before, Velocity is
  simply an additional, optional path to the same backend, not the only one.
- Have the trusted test account connect to the box's normal public address (`:25565`, now
  Velocity) and confirm nothing looks different from the player's side.

### Phase 5 — the `/server` switch itself

- Confirm Velocity's built-in `/server` command lists both `default` and `botworld` and switches
  between them for the test account, round-trip, more than once in a session. **Found 2026-11-25:
  `/server botworld` fails outright** — see §2's corrected note. `/server default` (switching back
  to the server you're already on, or simply staying) was never actually the open question;
  `botworld` is, and it doesn't work as designed. Options, lowest effort first:
  1. **Accept one-directional travel.** The default world through the proxy keeps working exactly
     as it does; visiting the bot world from inside that session isn't achievable this way. Scope
     this plan's goal down to match.
  2. **Build a small relay in front of `:25580`** that strips the forwarded handshake data back to
     plain before it reaches the real vanilla server — genuine new engineering (packet-level
     rewriting), not a config change, and not undertaken without explicit sign-off.
  3. Switching Velocity's forwarding mode doesn't help — "modern" forwarding is strictly worse for
     a vanilla backend (it requires an explicit login-plugin handshake vanilla has zero support
     for), so there is no third config-only option.

  **Decided 2026-11-25: built option 2.** `tools/minecraft-handshake-relay.py` — a small asyncio
  TCP relay that only ever touches a connection's first packet (the handshake): if the
  server-address field carries Velocity's legacy-forwarded blob (detected by a null byte), it's
  rewritten to a plain hostname; everything else, either direction, for the rest of the session,
  is piped unexamined. Deployed on the box at `/opt/minecraft-handshake-relay/`, as
  `minecraft-handshake-relay.service` (loopback-only, `127.0.0.1:25582`, no `ufw` rule needed),
  upstream `127.0.0.1:25580` — the bot world's real listener is untouched, bots still connect
  directly to `:25580` exactly as before. Verified with two raw test handshakes (plain address,
  and a synthetic forwarded one) before touching Velocity at all: relay logged `rewritten=False`
  and `rewritten=True` respectively, both got a valid status response from the real bot world.
  Velocity's `botworld` entry repointed from `127.0.0.1:25580` to `127.0.0.1:25582`.

  **Second, separate bug found immediately after, live:** fixing the handshake rejection surfaced
  a different failure, "Invalid signature for profile public key" — the bot world had
  `enforce-secure-profile=true` alongside `online-mode=false`. Once Velocity (online-mode=true,
  Phase 3's fix) hands a player's connection onward with their *real*, Mojang-signed chat key, an
  offline-mode backend that still enforces secure profiles tries to validate that signature
  against the offline (hash-of-username) UUID it assigns instead of the real UUID the key was
  actually issued for, and the check fails. First fix attempt: `enforce-secure-profile=false` in
  the bot world's own `server.properties`. Required restarting `minecraft-bots.service`, the first
  time anything in this plan had touched the bot world at all — done only after explicit operator
  sign-off given the live-fleet impact. All bots reconnected on their own via their existing
  restart/retry logic within under a minute; no lasting disruption. **This fix turned out to be
  necessary but not sufficient** — see below.

  **Same bug, same error, persisted after the fix above.** `enforce-secure-profile=false` only
  makes a client's signed key *optional to present*; it does not suppress validation of one that
  *is* presented — and a real Velocity-authenticated client always presents one. Confirmed via the
  bot world's own log: the player actually joined, then was immediately kicked for key validation
  failure. Two further, lighter-weight fixes were tried before any protocol-level work, each
  researched against real documentation/community precedent first, not guessed from memory, and
  each tested live and found **not to work**:
  1. `force-key-authentication = false` in Velocity's `velocity.toml` (a documented community fix
     for this exact error, Velocity issue #754). Restarted clean, same exact kick.
  2. The **ChatPatcher** Velocity plugin (Modrinth `chatpatcher`, v1.0.6, SHA-1
     `c4c4fefaa24752fd0e37e78edcf3c4ddaaf03de0`) — loaded clean, actively logged "Session Patching"
     on every connection, but turned out to patch Velocity's own *chat-message* signing API, not
     the *login-time profile-key certificate* exchange with the backend — a different mechanism
     entirely. Same exact kick in both Velocity's and the bot world's logs. Removed afterward
     (no benefit, and it changes chat-signing behavior proxy-wide for no gain).

  **Root cause, reanalyzed after both fixes failed:** the default world already runs the exact
  chain that was failing here — Velocity legacy forwarding, `online-mode=false` backend, real
  Microsoft-authenticated clients presenting real signed keys — and has worked with zero errors
  since Phase 3, with `enforce-secure-profile` left at its **default (`true`, the strict setting)**.
  The one component in that working chain the bot world didn't share was the engine: Paper's
  `bungeecord: true` substitutes the real UUID forwarded by Velocity in place of computing an
  offline hash-of-username UUID, so a signed key bound to the real UUID matches. Vanilla has no
  such substitution mechanism at all — legacy-forwarding UUID substitution is a Spigot/Paper
  capability, not a vanilla one. This is not a leniency setting the vanilla bot world was merely
  misconfigured for; it is a capability vanilla does not have, under any configuration. No amount
  of further relay packet-stripping at the handshake layer could ever have fixed it, because the
  problem is one layer past where that relay operates (UUID assignment during login, not handshake
  parsing).

  **Verified safely before touching the live bot world:** stood up a disposable Paper 26.1.2
  instance (`/opt/paper-test/`, `paper-test.service`, port `25583`, same jar already verified
  elsewhere on the box, SHA-256 `1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7`),
  `bungeecord: true`, wired as a temporary extra Velocity backend (`papertest`). The operator's
  real, Velocity-authenticated client switched to it and was accepted with no kick — confirming the
  hypothesis against a real signed key, with zero risk to the live bot world's save, bots, or
  uptime (a throwaway instance, not the real one).

  **UUID continuity, verified before any live change:** the fix requires the bot world's real
  engine to become Paper, which in turn requires `bungeecord: true` globally on its one real port —
  and that would reject the 9 bots' and the architect's own existing direct (non-forwarded)
  connections outright, the same failure mode as Phase 2's outage (§2b's requirement 2). The design
  settled on: a new **injector relay** (`tools/minecraft-handshake-injector.py`, the mirror image
  of the first relay) in front of the bot world for the bots and the architect only, synthesizing a
  legacy-forwarding handshake per connection using each username's **offline UUID**
  (`MD5("OfflinePlayer:<name>")` with the standard version/variant bits set) computed on the fly —
  no lookup table, no cryptography, nothing that needed a real client to test, since bots and the
  architect are plain/offline identities with no real signed key to begin with. Before writing it,
  confirmed this formula is exactly what was already in use: every UUID in the bot world's own
  `usercache.json` and every `players/data/<uuid>.dat` filename matched the computed offline UUID
  for its username, byte-for-byte, for all 9 live bots and several retired test identities. This
  means the injector cannot orphan anyone's saved stats/inventory/goals — continuity is guaranteed
  by the formula, not by a maintained mapping. Verified structurally with synthetic
  handshake/login-start data (no real client needed) before deployment.

  **Live cutover, executed 2026-11-25, in one tight sequence to minimize bot downtime:**
  1. Deployed the injector (`/opt/minecraft-handshake-injector/`, `minecraft-handshake-injector.
     service`, port `25584`, left idle — routing traffic to it before the backend expects forwarded
     data would just reproduce the original handshake-rejection bug). `ufw` rules mirroring
     `25580`'s fleet/Tailscale/NAT-hairpin-only rules added for `25584`.
  2. Added `Environment=MC_PORT=25584` to all 9 bot client systemd units (`minecraft-bot-{amy,
     babs,luke,mark,mayor}` on `dgx-spark`; `minecraft-bot-{bob,dale,nell,wade}` on `dgx-spark2`) —
     staged, not yet reloaded, so bots kept using their existing `:25580` connection until the
     backend actually required forwarding.
  3. Backed up the bot world: routine `backup.sh` (produced `firmament-bots_2026-11-25_11-11-48.
     tar.gz`) plus a permanent, explicitly-named restore point (`firmament-bots.RESTORE-POINT-
     20261125-111148-pre-paper-bungeecord`, `server.jar.bak-pre-paper-bungeecord`,
     `server.properties.bak-20261125-111148-pre-paper-bungeecord`), matching the project's own
     established restore-point convention (`MINECRAFT_SERVER_UPGRADE_PLAN.md`'s prior
     `pre-26.1.2` restore point).
  4. Stopped `minecraft-bots.service`; swapped `server.jar` for the same verified Paper 26.1.2
     build (SHA-256 matched); started once (triggered Paper's one-time world-storage migration,
     same step the default world went through during its own Phase 2 swap); confirmed clean boot
     and bots reconnecting fine via their *old* direct path (expected — `bungeecord` wasn't set
     yet, so Paper behaved identically to vanilla for plain connections at this point, confirmed by
     a reconnecting bot's UUID matching the pre-computed offline UUID exactly).
  5. Stopped `minecraft-bots.service` again; set `spigot.yml`'s `bungeecord: true`; started it;
     immediately `daemon-reload` + restarted all 9 bot client units on both hosts. A brief
     "Connection throttled! Please wait before reconnecting" burst followed — all 9 bots share one
     apparent source IP after the fleet's NAT hairpin, so a simultaneous reconnect burst trips
     Minecraft's own per-apparent-IP connection throttle; this is inherent to the fleet's shared
     NAT path and would have happened on the old direct route too, not something the injector
     introduced. Each bot's own `Restart=always`/`RestartSec` retry cleared it within about a
     minute; all 9 reconnected with their exact pre-existing UUIDs, and resumed their own
     in-progress goals (confirmed via each bot's own "resumed goal: ..." log line) — zero data
     loss.
  6. Repointed Velocity's `botworld` entry from the first relay (`127.0.0.1:25582`) straight to
     the real, now-Paper backend (`127.0.0.1:25580`) — no relay needed on this leg at all, since
     Paper accepts Velocity's legacy forwarding natively, exactly like the default world already
     does. Restarted Velocity.
  7. Decommissioned the first relay (`minecraft-handshake-relay.service`) and the disposable
     `paper-test.service` — both stopped and disabled; files left on disk rather than deleted
     (`paper-test`'s files are already earmarked for reuse by `FARMERS_DELIGHT_EQUIVALENT_PLAN.md`'s
     own Nexo-on-Paper-26.1.2 compatibility check, previously blocked on no Paper instance existing
     anywhere on the box).

  **Confirmed by direct operator test, both directions, 2026-11-25:** `/server botworld` from the
  default world lands cleanly, no kick; and the architect's own direct login now via `:25584`
  (same LAN/Tailscale-only reachability as the old `:25580`) also works, with either identity kind
  per §2b's requirement 2.
- Decide and document the exact command/alias players will actually type. **Corrected
  2026-11-25:** vanilla Velocity's own `/server <name>` works out of the box with no extra step —
  but a friendlier alias (`/botworld`, `/home`) is *not* a config option; Velocity has no built-in
  generic command-alias feature. Checked Hangar for an existing plugin: nothing minimal exists —
  only full social/friend-system plugins or a display-*name* aliasing tool (for messages, not
  commands), neither of which adds a short command for switching. A real alias needs a small
  custom Velocity plugin (a `SimpleCommand` that calls the same connection-request logic `/server`
  does) — genuinely optional scope, not "small" in the original sense. **Decided 2026-11-25, direct
  operator input: plain `/server <name>` is good enough.** Not pursuing the custom-alias plugin.
  Phase 5 is complete.

### Phase 6 — go-live

- Pick a low-traffic window; announce the brief reconnect-feeling blip to the 7 whitelisted
  players beforehand.
- Cutover already happened functionally in Phase 4 — this phase is the "operator declares it
  live" checkpoint, plus watching real player logins (not just the test account) for a few days.

### Phase 7 — rollback (only if needed)

- Stop Velocity; point the default world's `server.properties` back to `server-port=25565`,
  `online-mode=true`; restore the pre-swap `server-vanilla.jar.bak` if the Paper swap itself is
  what's being rolled back; restart. The bot world was never touched, so it needs no rollback step
  under any failure mode confined to this plan.

### Phase 8 — afterwards

- Remove the temporary Velocity port (`:25567`) from any firewall allowance if one was opened for
  testing.
- Fold the final, as-built config (exact `velocity.toml`, the chosen player-facing command names)
  into this document or a short README beside wherever Velocity's config ends up living.

## 5. Phase status

| Phase | Status | Date | Notes |
|---|---|---|---|
| 0. Decisions and access | in progress | 2026-11-24 | Paper-swap decided: yes, keep the whitelist (§2). Plugin/mod fork (§2a) resolved: plugins, not client mods — Slimefun for Immersive Engineering, Jade needs no server change, Farmer's Delight tracked separately (`FARMERS_DELIGHT_EQUIVALENT_PLAN.md`). Default world stays on its current version. Phase 2a decided: new seed, full stats/advancements reset |
| 1. Stand up Velocity (temp port) | done | 2026-11-25 | Velocity 4.3.1 (build 45) live on `:25568` (`/opt/velocity`, `velocity.service`), hash-verified, `online-mode=false`/legacy forwarding/`default`+`botworld` servers configured, clean startup, no errors. `ufw` opened `25568/tcp`(+v6) to `Anywhere`, commented TEMPORARY — remove in Phase 8. Confirmed by direct operator test: connected through `:25568` into the default world |
| 2. Paper swap (default world) | done | 2026-11-25 | Paper 26.1.2 (build 74) and Slimefun5 v5.3.3 both live on `:25565`, hash-verified, loaded clean, whitelist/ops/bans intact. Caused a real outage by setting `bungeecord: true` too early — reverted to `false`, moved to Phase 3 (see its note). Direct login confirmed post-revert, and Slimefun itself confirmed working in-game by direct operator test |
| 2a. Re-init default world's save | not started | | Decided: new seed, full player reset. Still blocked on Phase 2 being verified first |
| 3. Move default world behind proxy | done | 2026-11-25 | Backend moved to `:25566` internal, `online-mode=false`, `bungeecord: true` set, old `25566 Anywhere` ufw rule deleted (loopback-only now, default-deny policy confirmed). Velocity's `default` repointed to `127.0.0.1:25566`, its own `online-mode` flipped to `true` (found mid-execution — see Phase 3's note, closes a real auth gap). Confirmed by direct operator re-test through `:25568`: real identity verification working end-to-end. `:25565` still has nothing listening — every player except via `:25568` stays locked out until Phase 4 |
| 4. Cut the public port over | done | 2026-11-25 | Velocity moved from `:25568` to the real `:25565`, clean restart, no errors. Stopping Velocity to move it disconnected the one active session (`CanisLupisM`) mid-change — unavoidable with this approach, flagged to the operator, who reconnected successfully after. Bot world (`:25580`) confirmed unaffected (same PID, still active); `:25566` confirmed to have no external `ufw` allow rule. Confirmed by direct operator test: back in via the normal public address, no special port |
| 5. The `/server` switch | done | 2026-11-25 | Full saga: first relay fixed the handshake-rejection bug; `enforce-secure-profile=false` alone didn't fix the follow-on signed-key bug; `force-key-authentication=false` and the ChatPatcher plugin both tried and failed too; root cause reanalyzed as a vanilla-vs-Paper capability gap (UUID substitution under `bungeecord: true`), not a leniency setting. Fixed by converting the bot world's real engine to Paper 26.1.2 + `bungeecord: true`, with a new injector relay (`tools/minecraft-handshake-injector.py`, `:25584`) preserving the bots' and architect's direct access per §2b's requirement 2 — UUID continuity formulaically verified against live `usercache.json`/playerdata before the live cutover, which succeeded with zero data loss (all 9 bots resumed their own in-progress goals). First relay and the disposable `paper-test` instance decommissioned. Confirmed by direct operator test: both `/server botworld` travel and the architect's direct `:25584` login work. Friendly-alias question resolved: plain `/server <name>` is good enough, no custom plugin needed |
| 6. Go-live | not started | | |
| 7. Rollback | not needed | | |
| 8. Afterwards | not started | | |

## Revision History

| Version | Date | Change |
|---|---|---|
| 5.0.0 | 2026-11-25 | Major, reverses a load-bearing Non-goal: the bot world's software, `bungeecord` setting, and the bots'/architect's connection port all changed, after `enforce-secure-profile=false` alone, `force-key-authentication=false`, and the ChatPatcher plugin all failed to fix the signed-key bug. Root cause reanalyzed as a vanilla-vs-Paper capability gap (legacy-forwarding UUID substitution), not a config leniency setting — confirmed safely on a disposable Paper test instance before touching the live bot world. Converted the live bot world to Paper 26.1.2 + `bungeecord: true`; built a new injector relay (`tools/minecraft-handshake-injector.py`, `:25584`) so the 9 bots and the architect keep direct, non-proxied access (§2b's restated requirement 2), using each identity's formulaically-computed offline UUID, verified byte-for-byte against the live world's own `usercache.json`/playerdata before the cutover. Live cutover executed (named restore point + backup first) with zero bot data loss — all 9 resumed their own in-progress goals. Velocity's `botworld` entry repointed directly at the now-Paper backend; the first relay and the disposable test instance decommissioned. Confirmed by direct operator test, both directions: `/server botworld` travel, and the architect's own direct login via `:25584`. Friendly-alias question resolved (plain `/server <name>` is good enough). Phase 5 marked done. New §2b records the restated three-part access requirement that drove this redesign, including a same-day rejected alternative (making the bot world's firewall wider without a NAT forward — doesn't reach any new population and doesn't touch the signing bug either). §1's current-state table and §3's Non-goals corrected to match. |
| 4.1.0 | 2026-11-25 | Built and deployed the handshake-rewriting relay decided for Phase 5 (`tools/minecraft-handshake-relay.py`, `minecraft-handshake-relay.service`, loopback-only `:25582`), verified against raw test handshakes before wiring it into Velocity's `botworld` entry. Found and fixed a second, independent bug the same session: the bot world's `enforce-secure-profile=true` rejected the real signed profile key now reaching it via Velocity's online-mode auth, fixed by flipping that one setting (operator-approved given it's the first and only touch of the bot world this plan makes, logged as an explicit exception in §3). Bots self-recovered from the required restart within under a minute. Phase 5 and §3 updated to match; still in progress pending the operator's live retest and the separate friendly-alias decision. |
| 4.0.0 | 2026-11-25 | Live test during Phase 5 disproved a foundational §2 claim: this vanilla 26.1.2 bot-world server does not "ignore legacy forwarding harmlessly" — it rejects the forwarded handshake and closes the connection outright, confirmed in Velocity's own log (`/server botworld` fails; `/server default` already proven working by Phases 3-4). Since forwarding mode is proxy-wide, not per-backend, there is no config fix: Paper needs legacy forwarding, this vanilla server rejects it. §2 and Phase 5 corrected with the finding and the real options (accept one-directional travel, or build a packet-rewriting relay in front of `:25580`). Phase 5 marked blocked pending an operator decision — this reverses a load-bearing assumption the whole proxy design leaned on, hence the major bump. |
| 3.4.0 | 2026-11-25 | Started Phase 5; corrected a wrong assumption found while starting it: a friendlier `/server` alias (`/botworld`, `/home`) is not a Velocity config option — checked Hangar, found no minimal existing plugin for it, only full social/friend-system plugins or message-display-name aliasing. A real alias needs a small custom Velocity plugin, not a config flag. Left as an open operator call: plain `/server <name>` vs. commissioning that plugin. Phase 5's own round-trip switch test still needs the operator's live client. |
| 3.3.0 | 2026-11-25 | Executed Phase 4: Velocity's listener moved from the temp port `:25568` to the real public `:25565`, clean restart. Stopping Velocity to move it disconnected the one player active at the time, unavoidable with this approach — flagged live, operator reconnected successfully after. Confirmed the bot world (`:25580`) untouched and the default-world backend (`:25566`) still has no external `ufw` allow rule. Direct operator confirmation: back in through the normal public address, no special port needed. Phase 4 marked done. |
| 3.2.1 | 2026-11-25 | Direct operator confirmation: re-tested through `:25568` with real identity verification live (Velocity `online-mode=true`, legacy forwarding, backend trusting it) — works end-to-end. Phase 3 marked done in the status table. |
| 3.2.0 | 2026-11-25 | Executed Phase 3: default world moved to internal `:25566` (`online-mode=false`), `bungeecord: true` set in the same stopped-state edit as the port change (per Phase 2's correction), old wide-open `25566` `ufw` rule deleted — confirmed loopback-only now under the box's default-deny policy. Velocity's `default` repointed to `127.0.0.1:25566`. Found and fixed mid-execution, not in the original text: Velocity's own `online-mode` had to flip from Phase 1's `false` to `true`, since it's the only real authentication check left once the backend starts trusting forwarded identity — left as `false` it would have let anyone claim any whitelisted username and get through unverified. `:25565` now has nothing listening (expected, but a real lockout for anyone not using `:25568`, until Phase 4). Phase 3's steps and the status table updated to record the online-mode fix. |
| 3.1.1 | 2026-11-25 | Direct operator confirmation: connected through Velocity's temp port (`:25568`) into the default world successfully. Phase 1 marked done in the status table. |
| 3.1.0 | 2026-11-25 | Executed Phase 1: installed Velocity 4.3.1 build 45 (hash-verified) on `192.168.1.221` at `/opt/velocity`, as `velocity.service`; `velocity.toml` set to `bind=0.0.0.0:25568`, `online-mode=false` (backend still does its own real auth at this stage, nothing forwarded yet), `player-info-forwarding-mode=legacy`, `[servers]` trimmed to `default -> 127.0.0.1:25565` and `botworld -> 127.0.0.1:25580`, `try=["default"]`, the example `forced-hosts` entries removed. Clean startup, listening on `:25568`, no errors. Opened `25568/tcp`(+v6) in `ufw` to `Anywhere`, commented TEMPORARY, same scope as `:25565` (removed at Phase 8). Phase status table updated; marked in-progress pending the operator's own client test. |
| 3.0.2 | 2026-11-25 | Direct operator confirmation: Slimefun itself confirmed working in-game, not just loaded clean. Phase 2's checklist is now fully satisfied. |
| 3.0.1 | 2026-11-25 | Direct operator confirmation: logged in successfully post-revert. Phase 2 marked done in the status table. |
| 3.0.0 | 2026-11-25 | Live outage, found and fixed same-session: `bungeecord: true` (set in Phase 2) rejected every direct connection to `:25565` with "please enable IP forwarding in your BungeeCord config," since no proxy existed yet to supply the forwarded handshake it expects. Reverted to `false`, restoring direct connectivity. Corrects Phase 2's wrong claim that this flag was "harmless while nothing is proxied yet" — it moves to Phase 3 instead, set in the same stopped-state edit as the port change, so it only ever goes live in the same restart that takes the server off the public port. Phase 2/3 and the status table updated to match. |
| 2.3.0 | 2026-11-25 | Installed Slimefun, completing Phase 2's remaining step: found the original Slimefun4 (TheBusyBiscuit) discontinued, so installed "Slimefun5," its community-maintained continuation (`Slimefun/Slimefun` on Hangar), v5.3.3 — explicitly declares Paper 26.1.2 support, hash-verified, loaded clean (557 items/260 researches/1,515 recipes, 0 errors), confirmed enabled via RCON `plugins`. §2a updated with the discontinued-original/community-fork finding. Phase 2 stays "in progress," not "done" — its own checklist's "a basic machine/recipe works for a test account" needs an actual player login, which hasn't happened yet. |
| 2.2.0 | 2026-11-25 | Executed Phase 2's Paper swap on the real default-world server: stopped after an RCON flush (confirmed 0 players online), downloaded Paper 26.1.2 build 74 (hash-verified), kept the vanilla jar as `server-vanilla.jar.bak`, confirmed `whitelist`/`ops`/`banned-*` byte-identical and all 7 whitelisted names intact via RCON, left `server.properties` untouched, set `spigot.yml`'s `bungeecord: true`, restarted clean with no errors. Also completed Phase 0's SSH-access confirmation and rollback-state recording — found along the way that `backup.sh` must run as `sudo -u muncraft`, not plain `pmoney`, since `backups/` has no group/other write permission. Slimefun (also part of Phase 2) not yet installed. Phase status table updated to match. |
| 2.1.0 | 2026-11-25 | Found while starting `FARMERS_DELIGHT_EQUIVALENT_PLAN.md` §3's recon (`ufw status numbered` on the real box): `:25565` is `ALLOW IN Anywhere`, no subnet restriction (now the confirmed rule to replicate for the resource-pack port there); `:25567` (this plan's suggested temporary Velocity port) already blocks Paper RCON from outside, so Phase 1's placeholder moved to `:25568`; `:25566` already has a pre-existing `ALLOW IN Anywhere` rule (nothing bound yet) that Phase 3 must actively tighten, not assume starts closed. `/opt/minecraft/` confirmed still plain vanilla, same pass — nothing is actually broken live, these are latent only. |
| 2.0.0 | 2026-11-24 | Direct request reversed the previous row's decision to phase out a Farmer's Delight equivalent entirely: it's back in scope, now tracked as its own dedicated plan, `FARMERS_DELIGHT_EQUIVALENT_PLAN.md`. §2a, Phase 0's checklist, and the status table updated to point at it instead of saying "no equivalent planned." Nothing else in this plan changes — it was already agnostic to whether a Farmer's Delight equivalent existed, only to it being a plugin rather than a mod. |
| 1.3.0 | 2026-11-24 | Direct operator input: resolved Phase 2a's two open re-init decisions — new seed, full reset of per-player stats/advancements, no carry-over — and phased out the Farmer's Delight follow-up build entirely (no equivalent planned; Slimefun plus unmodified Jade are now the full plugin scope). §2a, Phase 0's checklist, Phase 2a's steps, and the status table updated to match; Phase 2a's steps simplified since the carry-over branch no longer applies. |
| 1.2.0 | 2026-11-24 | Direct operator input: default world stays on its current Minecraft version (resolves the `/server`-transport protocol-version risk raised the same day — moving it to match specific client mods was evaluated and rejected, since that would have broken cross-backend transport outright). §2a's plugin/mod fork resolved toward plugins, not client mods: Paper + Slimefun (Immersive-Engineering-equivalent) confirmed; Farmer's Delight tracked as a follow-up custom-items-plugin build; Jade needs no server-side change. New Phase 2a added (re-init the default world's save under Paper + Slimefun, preserving all non-world-save configuration), with new open sign-off items (seed, player-data carry-over) added to Phase 0's checklist. Phase status table updated to match. |
| 1.1.0 | 2026-11-24 | Direct operator input: confirmed the Paper swap (keep the whitelist working), and raised a new requirement — the default world must also support player-requested plugins/mods, list not yet finalized. New §2a flags the plugins-vs-client-mods fork this can force on the server-software choice, and gates Phase 2 on it; Phase 0's checklist and the status table updated to match. |
| 1.0.0 | 2026-11-24 | Initial plan, direct request ("start this as an implementation plan"), from the same-session investigation and design discussion: proxy-based `/server` travel in both directions (portal mechanic dropped per operator preference), legacy forwarding so the bot world needs no changes, Paper swap on the default-world server only (to preserve real-UUID whitelist enforcement), left as an open decision for Phase 0. |
