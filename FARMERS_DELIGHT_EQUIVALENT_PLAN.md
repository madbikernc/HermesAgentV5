# Farmer's Delight Equivalent: Phased Build Plan

**Version:** 4.0.0

Plan to build a plugin-only (no client mod) approximation of Farmer's Delight's cooking/farming
content for the default-world Paper server (`MINECRAFT_PROXY_TRAVEL_PLAN.md` §2a), using a
custom-items framework plus a resource pack instead of a Forge/NeoForge mod. Supersedes that
plan's 2026-11-24 "phased out" decision — see its own Revision History.

## 1. Why a plugin, not the real mod, and what that changes about the target

`MINECRAFT_PROXY_TRAVEL_PLAN.md` §2a already ruled out running the real Farmer's Delight mod: it
requires a matching Forge/NeoForge client install, which breaks the whitelist/legacy-forwarding
design that plan depends on. This plan targets the *feel* of Farmer's Delight — new food, a
cooking mechanic, a couple of new "crops" — using only what a Paper plugin and a resource pack can
do: custom item textures/models, custom recipes, and plugin-driven block interactions. It is not a
port and will not match the real mod feature-for-feature; §4's phase-by-phase scope says exactly
what's in and what's cut.

## 2. Framework choice (decided 2026-11-25: Nexo; reversed same day: RPEngine)

| | ItemsAdder | Oraxen | Nexo | RPEngine |
|---|---|---|---|---|
| Cost | Paid, ~$24.99 (BuiltByBit) | **Wrong when first written — Oraxen is paid too**, confirmed via its own GitHub README: "Oraxen is a paid plugin. You must purchase a license from SpigotMC or BuiltByBit to use it." Custom, non-open-source license (`ORAXEN LICENSE v1.0`); self-building from source is not clearly a free path either, despite the repo being public | **Wrong when first written** — paid, ~$22.99 one-time (Polymart/voxel.shop listing), no free tier found | Free (hosted on Hangar, which only lists free/open plugins) |
| Custom blocks/furniture | Mature, widely used for exactly this (cooking stations, cabinets) | Supported, slightly less polished | Supported, newer/actively developed | Supported — "custom items, models, emotes and screens from a folder of YAML" |
| Resource-pack handling | Builds and serves the merged pack itself | Builds the pack; serving is on the admin | Similar to Oraxen | Three modes: upload to a third-party host (default), serve on the game port (breaks behind a proxy), or serve on a second port (`own-port` — works behind a proxy, matches §3's self-hosting decision) |
| Maturity for this use case | Highest — most "cooking station"/"furniture" mod-replacement builds on SpigotMC use it | Common alternative, mature | Mature, explicitly confirmed Paper `26.1-26.1.2` support (needs Nexo 1.22+; current release 1.30) | **Very new**: 247 downloads, 2 stars, pre-1.0 versioning (`0.2.92`) — but actively developed (new releases every day or two, latest the day before this check) |

**Decided 2026-11-25, direct operator input: Nexo** (table above as it stood that morning — Nexo
believed free, chosen over ItemsAdder's known paid license). **Reversed same day, before any
installation happened:** verifying Nexo's Paper-26.1.2 compatibility (this section's own flagged
risk) required actually looking it up, which surfaced that Nexo is paid — the "free, open-source"
premise it was chosen on was wrong. Checked Oraxen (the other candidate in the original table) as
the fallback and found the same problem: also paid, despite being incorrectly recorded as free
above. ItemsAdder's price was confirmed too (~$24.99) for completeness — all three paid options
land in the same $22–25 range, so there was no cost advantage left to choosing between them.

**Decided 2026-11-25, direct operator input, second pass: RPEngine.** The one genuinely free,
actively-maintained, version-compatible option found (Hangar, which hosts only free/open plugins,
guaranteeing this one actually is what the other two were wrongly recorded as). Its real,
accepted trade-off: a fraction of the other three's download count and no 1.0 release yet — carried
into Phase 0 as a concrete verification (below), not assumed away, same discipline this section
already called for before the cost correction.

## 3. Resource-pack delivery (decided 2026-11-25: self-hosted, optional)

Every custom texture needs a resource pack on the player's client. Paper serves one automatically
via `server.properties` (`resource-pack` = a reachable URL + `resource-pack-sha1`) once Nexo has
built it.

**Decided, direct operator input: self-hosted on the Minecraft box itself (`192.168.1.221`), open
to the same `ufw` targets as the default world's own public game port (`:25565`).** A small
static HTTP server on that box serves the pack zip, on its own port (distinct from any Minecraft
protocol port — exact port TBD at Phase 1, picked alongside whatever already runs an HTTP server
there, if anything; confirmed 2026-11-25 nothing does yet). **Confirmed 2026-11-25 (`ufw status
numbered`): `:25565` is `ALLOW IN Anywhere` (tcp and v6), no subnet restriction at all** — the new
port's rule mirrors that exactly: fully open, not scoped to any particular range. The same
population of players already reaches the default world over that port, so this is neither wider
nor narrower than what's already trusted.

**Decided, direct operator input: optional** (reversing the prior "required" decision). A player
can decline the pack and still join — they just see missing/broken textures on every custom item
this plan adds, rather than being disconnected. This removes the availability coupling "required"
would have created (the self-hosted HTTP server is no longer a hard dependency for joining the
default world at all), at the cost of that visual inconsistency for anyone who declines or fails
the download.

**Confirmed compatible with RPEngine 2026-11-25:** its own `config.yml` offers exactly three pack-
hosting modes — `upload` (default: a third-party host, `packs.resourcepack.ai`, free but off-box,
not what §3 decided), `same-port` (serves on the Minecraft game port itself — explicitly does
**not** work behind a proxy, and the default world is behind Velocity, so this mode is ruled out
outright), and `own-port` (serves on a second port RPEngine opens itself — explicitly documented as
working behind a proxy). `own-port` is the one that matches this section's decision; Phase 1 sets
`host.mode: own-port` and picks the actual port number against the `:25565`-mirroring `ufw` rule
below, rather than leaving it on the third-party-upload default.

## 4. Phases

### Phase 0 — decisions
- Framework choice: decided, §2 — **RPEngine** (reversed from Nexo the same day the decision was
  made, before any installation — see §2 for the full cost-correction chain: Nexo and Oraxen both
  turned out paid despite being recorded as free, ItemsAdder confirmed paid too, RPEngine is the
  one actually-free, actually-compatible option).
- **Compatibility check done 2026-11-25**, once `MINECRAFT_PROXY_TRAVEL_PLAN.md` Phase 2's Paper
  swap gave this plan a real Paper 26.1.2 instance to test against (reusing that plan's own
  disposable `paper-test` instance, `/opt/paper-test/`, port `25583` — same box, same Paper build,
  SHA-256 `1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7`): downloaded RPEngine
  0.2.92 from its Hangar listing, hash-verified (`1900aa2fd21997927595c9d35357eaf0dcd00460af6f0b2958671b21deadba50`),
  installed, restarted. **Loaded clean, no errors, "Done" in under a second.** One real caveat
  from its own log, not a blocker but worth tracking into Phase 1-2: *"Minecraft 26.1.2 is newer
  than this build knows about. Using pack format 97, the format for 26.3... with some features
  reduced."* RPEngine's release cadence (new builds every day or two) makes it likely this
  resolves itself before Phase 1 actually starts building content, but it isn't assumed away —
  Phase 1 re-checks for a build that explicitly recognizes `26.1.2` before relying on anything the
  log flagged as reduced. Hosting-mode compatibility (`own-port`) also confirmed, §3.
- `paper-test` is left running (not re-disabled) for `MINECRAFT_PROXY_TRAVEL_PLAN.md`'s own
  purposes — it doubles as this plan's actual Phase 1 trial instance going forward, rather than
  standing up a second throwaway one.
- Resource-pack hosting: decided, §3 — self-hosted on `192.168.1.221`. Confirmed 2026-11-25: the
  `:25565` rule to mirror is `ALLOW IN Anywhere` (tcp + v6), no subnet restriction — apply the same
  to the new port in Phase 1. Optional, decided (§3) — a player who declines just sees missing
  textures on custom items, not a disconnect; no uptime coupling.
- Confirm this needs no change to Velocity, the whitelist, or anything in
  `MINECRAFT_PROXY_TRAVEL_PLAN.md`'s network design — purely server content, sanity-checked, not
  re-litigated.

### Phase 1 — framework + resource-pack pipeline (no real content yet) — done 2026-11-25
- Installed RPEngine 0.2.92 on the **trial** `paper-test` instance (not the live default world,
  same discipline as `MINECRAFT_SERVER_UPGRADE_PLAN.md`'s trial-first practice). Set `host.mode:
  own-port`, `port: 25585`, `public-address: "http://192.168.1.221:25585"` per §3's decision;
  opened `25585/tcp`(+v6) in `ufw`, mirroring `:25565`'s `ALLOW IN Anywhere` rule.
- Shipped one placeholder custom item end-to-end: a pack `farmersdelight/` (`pack.yml`, `items/
  food.yml` defining `farmersdelight:tomato` as a renamed/retextured `APPLE`, a placeholder 16×16
  texture at `assets/textures/item/tomato.png`). Confirmed in the startup log ("1 pack, 1
  definition, 1 bundle built") and live: `/rp give farmersdelight:tomato` on a test connection
  showed the placeholder texture, not the vanilla apple icon.
- Confirmed what a client that declines the pack sees: reconnected, declined the prompt, same
  `/rp give` showed the standard missing-texture purple/black checker — not a crash, not a
  disconnect. Matches §3's "optional" decision exactly: declining degrades visually, nothing
  breaks.
- Test access was via a temporary direct connection to the trial instance's own port (`:25583`,
  `bungeecord: false` for this — flipped back from the Phase 0 compatibility check's `true`, since
  that check went through Velocity and this one didn't), with a brief `ufw` opening removed again
  once testing finished. RCON enabled on the trial instance (`:25586`) for ongoing Phase 1+ work,
  replacing the placeholder it briefly had duplicated entries for in `server.properties` (cleaned
  up, not left as a stray duplicate-key file).

### Phase 2 — food items and basic recipes (no new blocks) — done 2026-11-25
- Picked a small, low-ambiguity starter set rather than the real mod's full roster: real Farmer's
  Delight recipes were researched first (not invented from memory), and most either need an
  ingredient this plan doesn't have yet (tomato/onion/cabbage/rice, all Phase 3) or the Cooking
  Pot/Cutting Board (Phase 4-5), so this phase's set is deliberately the handful that use *only*
  vanilla ingredients at a plain crafting table — consistent with §1's "approximation, not a port"
  framing, not a claim of exact recipe fidelity to the real mod.
- Shipped 4 items, each with a custom texture, a vanilla-ingredients-only shapeless crafting-table
  recipe (RPEngine's own recipe system, `content/farmersdelight/recipes/`), and (where relevant)
  a `food:` component override for custom nutrition/saturation:
  - **Wheat Dough** (non-edible intermediate, sets up later phases): 3 Wheat + 1 Egg → 3.
  - **Sweet Berry Cookie**: 1 Sweet Berries + 2 Wheat → 8. `food: {nutrition: 4, saturation: 2.0}`.
  - **Honey Cookie**: 1 Honey Bottle + 2 Wheat → 8. `food: {nutrition: 4, saturation: 2.4}`.
  - **Melon Popsicle**: 4 Melon Slice + 2 Ice + 1 Stick → 1. `food: {nutrition: 6, saturation: 4.0}`.
- All 4 confirmed crafting correctly and tasting/feeling right in-game by direct operator test.
  One real debugging detour along the way, recorded so it isn't re-investigated later: an initial
  report that 3 of the 4 recipes "produced nothing" looked, from the server and client side, like
  a genuine RPEngine bug tied to the `food:` component (every failing recipe's *output* carried
  one, the one working recipe didn't; `food:` is documented as a 1.20.5+ component on a build that
  already warns it doesn't fully recognize 26.1.2) — a plausible, evidence-backed theory, tested by
  removing the overrides, which did *not* fix it either. Turned out to be tester error, not a
  plugin bug, confirmed directly by the operator after re-testing. No code or config changed
  because of this — the `food:` overrides were restored exactly as before. Validates item
  registration and food mechanics cleanly; nothing harder attempted yet.

### Phase 3 — reskinned crops — done 2026-11-25
- **Reverses this phase's original approach.** The plan as written assumed vanilla-crop-reuse
  (texture override on an existing crop, drop swapped via a plugin listener) with rice likely cut
  for not mapping onto a vanilla crop's water-grown habit. Building it surfaced that RPEngine has
  no such reuse mechanism at all — it ships its own **independent** plant/block system
  (`base: plant`), unrelated to vanilla crop growth entirely: stages, grow timing, and drops are
  all RPEngine-native config, not an overlay on `WHEAT`/`BEETROOTS`/etc. Once that was clear, the
  original cutting rationale for rice (its growth habit "doesn't map onto a vanilla crop") no
  longer applied — nothing maps onto a vanilla crop under this system — so rice stayed in scope
  alongside tomato/onion/cabbage, all four built the same way.
- **Mechanism, as actually built:** each crop is a `blocks/*.yml` entry — `base: plant`,
  `stages: [x_0, x_1, x_2]` (one model/texture per stage), `grow: {every: 2m, light: 9,
  bone-meal: true}`, and per-stage `drops:` (early stages drop a seed item; the mature stage drops
  the harvest item, `1to3`, plus a `chance: 0.5` extra seed). Models are plain exported Java JSON
  (`"parent": "minecraft:block/crop"` with a per-stage texture override), not Blockbench files.
  RPEngine's own log identifies the underlying trick: these plants are implemented as **tripwire
  block states** — "Paper freezes tripwire, so plants (`base: tripwire`) have 32 states rather than
  2." A normal server gets only 2 such plant states; `config/paper-global.yml`'s
  `block-updates.disable-tripwire-updates: true` (default `false`) is the prerequisite that unlocks
  32, confirmed via `/rp blocks` RCON output ("tripwire: 17 of 32 states left" after all 4 crops ×
  3 stages = 12 states consumed). Set on `paper-test` before building any crop past the first.
- **ID-collision rule learned the hard way:** a block and an item can't share an ID — naming the
  tomato block just `tomato` (colliding with Phase 1's existing `farmersdelight:tomato` item)
  produced a real plugin-side error (`Already defined in farmersdelight`). Fixed by naming every
  crop block `<crop>_crop` (`tomato_crop`, `onion_crop`, `cabbage_crop`, `rice_crop`), applied
  consistently from the start for the other three.
- **Seed-item material hijack, found and fixed:** giving a seed item a vanilla material with its
  own built-in interaction (`WHEAT_SEEDS`) let vanilla's own planting logic silently intercept the
  right-click and plant real vanilla wheat instead of the custom crop — confirmed directly
  ("it looked the same as wheat when it grew... I got wheat seeds"). Fixed by switching every seed
  item's material to inert `PAPER`.
- **Survival-mode plantability, initially a known gap, then solved in-phase (direct operator
  request).** Harvesting only ever drops the food item and (by chance) a seed item — never a
  placeable block — and RPEngine's plant/block system has no built-in "seed plants a crop"
  mechanic (confirmed from RPEngine's own docs: a seed is just a plain item, nothing more). Every
  custom *block*, however, already comes with its own placer item for free ("every block comes
  with an item that places it, with nothing extra to declare"), and RPEngine exposes a generic,
  branchless `actions:` system on any item (trigger → ordered steps: `take`, `give`, `message`,
  `cooldown`, etc.). Wired each seed item's `right_click` action to `take: 1` itself and `give` one
  of its own crop's block item, with a `message` confirmation and a `cooldown: 1` precaution
  against event double-firing. Confirmed live: right-clicking any of the 4 seed items converts it
  into its crop's placeable block, which can then be placed and grown with zero admin commands —
  closing the loop (harvest → maybe a seed → right-click → place → grow → harvest) entirely through
  normal survival play. This is also the same root cause as the material-hijack bug above, now
  understood precisely from RPEngine's own docs: vanilla item behavior always fires unless an
  explicit `cancel` step is added to an item's `actions:` list — `WHEAT_SEEDS` had no such step, so
  vanilla's planting logic ran unopposed. `PAPER` (inert, nothing to cancel) was the correct fix,
  and `actions:` is the documented way to deliberately override vanilla behavior when needed.
- **Known, accepted limitations** (not blockers, left as-is): (a) `bone-meal: true` is documented
  and configured but does not actually accelerate growth of tripwire-based plants — an RPEngine
  limitation, not a config mistake; (b) these plants place on **both** regular ground and farmland
  (tilling is irrelevant to this system — initial field reports of farmland-only failure didn't
  reproduce on retest and aren't treated as a real restriction).
- **Final state, confirmed live for all 4 crops** (tomato first, validating the pattern; onion,
  cabbage, rice built identically and confirmed after): clean registration (`/rp blocks` / `/rp
  items`, no errors), distinct per-stage models/textures when placed, timer-based growth, correct
  mature-stage harvest drops (fixed one inconsistency along the way — `cabbage_crop`'s mature drop
  was a flat `cabbage 1`, a copy-paste miss against the other three's `1to3`; corrected to match),
  and the full seed-to-block-to-harvest survival loop via the `actions:`-based conversion above.
  `25583/tcp`(+v6), opened temporarily for this phase's direct-connect testing, closed again on
  completion per the established per-phase pattern.

### Phase 4 — cooking pot & skillet
- The core mechanic: a custom placeable block, a right-click GUI (ingredient slots + output slot),
  a config-driven recipe table (ingredients → output + cook time), and a cook-time/fuel mechanic
  (mirroring vanilla furnace fuel, so it isn't strictly easier than smoking/cooking already is).
  Biggest single build item in this plan — gets its own full test pass before Phase 5.

### Phase 5 — cutting board
- Smaller: right-click with a knife + an ingredient on a custom block → consumes the ingredient,
  produces a prepared item. A lookup-table listener, no GUI needed.

### Phase 6 — cabinets / cosmetic furniture (optional, cut first if scope needs trimming)
- Decorative storage furniture. Lowest gameplay value (a chest already does the job) — explicitly
  the first thing to drop if time runs short.

### Phase 7 — integration + player testing
- Everything together on the trial instance; a subset of the 7 whitelisted players test it
  hands-on against real Farmer's Delight (wiki/screenshots) for "does this feel right," not just
  "does it run."

### Phase 8 — go-live
- **Sequencing note:** `MINECRAFT_PROXY_TRAVEL_PLAN.md` Phase 2a re-inits the default world's save
  (new seed, full player reset) before that plan's Phase 3 proxy work. Land this plugin's go-live
  together with that re-init, not as a separate disruptive change afterward — one clean cutover to
  the new world with Slimefun and this plugin both already in place.

### Phase 9 — afterwards
- Recipe/config reference folded into a short README beside the plugin's config.
- Update `MINECRAFT_PROXY_TRAVEL_PLAN.md` §2a to point at this plan instead of saying "phased out"
  (already done, same change — see that plan's own Revision History).

## 5. Phase status

| Phase | Status | Date | Notes |
|---|---|---|---|
| 0. Decisions | done | 2026-11-25 | All three decisions made and verified: framework RPEngine (§2, reversed from Nexo the same day after both Nexo and Oraxen turned out paid), resource pack self-hosted via RPEngine's `own-port` mode mirroring `:25565`'s confirmed rule (`ALLOW IN Anywhere`, tcp+v6), optional not required (§3). Compatibility check done: RPEngine 0.2.92 loads clean on the real box's Paper 26.1.2 (`paper-test` instance), one caveat tracked into Phase 1 (pack-format fallback, "some features reduced" until a build explicitly recognizes 26.1.2) |
| 1. Framework + pipeline | done | 2026-11-25 | RPEngine installed on `paper-test` (own-port hosting, `:25585`); one placeholder item (`farmersdelight:tomato`) shipped and confirmed end-to-end on a real client, both accepting and declining the pack |
| 2. Food items/recipes | done | 2026-11-25 | 4 items shipped and confirmed in-game (Wheat Dough, Sweet Berry Cookie, Honey Cookie, Melon Popsicle) — custom textures, nutrition/saturation, vanilla-ingredient crafting-table recipes, all vanilla-only since real Farmer's Delight recipes needing Phase 3/4/5 content were deferred |
| 3. Reskinned crops | done | 2026-11-25 | All 4 crops shipped (tomato, onion, cabbage, rice — rice kept in scope, see §4 Phase 3) using RPEngine's independent tripwire-based plant system, not vanilla-crop reuse as originally planned. Survival-mode seed-to-plant loop solved via RPEngine's `actions:` system, closing the admin-command-only gap found mid-phase |
| 4. Cooking pot & skillet | not started | | Biggest build item |
| 5. Cutting board | not started | | |
| 6. Cabinets/furniture | not started | | Optional — first cut if scope needs trimming |
| 7. Integration + player testing | not started | | |
| 8. Go-live | not started | | Sequence with `MINECRAFT_PROXY_TRAVEL_PLAN.md` Phase 2a's world re-init |
| 9. Afterwards | not started | | |

## Revision History

| Version | Date | Change |
|---|---|---|
| 4.0.0 | 2026-11-25 | Major, reverses Phase 3's originally-stated approach: RPEngine has no vanilla-crop-reuse mechanism — plants are an independent, tripwire-state-based system (`base: plant`), which also invalidated the plan's rationale for likely cutting rice (nothing maps onto a vanilla crop under this system, so there's no water-growth mismatch to cut over). Built and confirmed live: all 4 crops (tomato, onion, cabbage, rice), each 3-stage with custom models/textures, timer-based growth, and mature-stage harvest drops; required `disable-tripwire-updates: true` to raise the 2-state plant budget to 32; learned a real block/item ID-collision rule (`<crop>_crop` naming); found and fixed a seed-material vanilla-hijack bug (`WHEAT_SEEDS` → inert `PAPER`); fixed one drop-amount inconsistency (`cabbage_crop`). Direct operator request mid-phase: solved the survival-mode plantability gap (originally going to ship as an accepted admin-command-only limitation) using RPEngine's documented `actions:` system so each seed right-click-converts into its crop's placeable block — a full harvest-to-replant loop with zero admin commands. Two limitations accepted as real and left as-is: bone meal doesn't accelerate these plants' growth, and placement works on both regular ground and farmland (tilling is irrelevant to this system). Phase 3 and the status table marked done; `25583/tcp` testing rule closed per the established per-phase pattern. |
| 3.2.0 | 2026-11-25 | Executed Phase 2: shipped 4 vanilla-ingredients-only food items (Wheat Dough, Sweet Berry Cookie, Honey Cookie, Melon Popsicle) with custom textures, crafting-table recipes (RPEngine's own recipe system), and `food:` nutrition/saturation overrides — all confirmed working in-game. Item selection deliberately limited to real Farmer's Delight recipes needing no ingredient or mechanic from a later phase (crops, cooking pot, cutting board), researched rather than invented from memory. One debugging detour recorded: an initial report of 3/4 recipes not working looked like a real RPEngine bug tied to the `food:` component, tested and ruled out, ultimately tester error — noted so it isn't re-investigated. Phase 2 and the status table marked done. |
| 3.1.0 | 2026-11-25 | Executed Phase 1: RPEngine installed on the trial `paper-test` instance, configured for `own-port` resource-pack hosting (`:25585`, `ufw` opened mirroring `:25565`) per §3. Shipped one placeholder item (`farmersdelight:tomato`, a retextured `APPLE`) and confirmed live on a real client both ways — pack accepted shows the correct placeholder texture, pack declined shows the standard missing-texture checker, no crash or disconnect either way. Phase 1 and the status table marked done. |
| 3.0.0 | 2026-11-25 | Major, reverses the Phase 0 framework decision: Nexo was chosen specifically for being "free, open-source," which turned out wrong — confirmed via its own Polymart/voxel.shop listing ($22.99, no free tier). Checked Oraxen, the table's other candidate, as the fallback: also wrong, also paid (confirmed via its own GitHub README's license section, a custom non-open-source license). ItemsAdder's price confirmed too (~$24.99) for completeness. Switched to RPEngine, the one Hangar-hosted (therefore genuinely free) option found, after confirming it loads clean on the real box's Paper 26.1.2 (`paper-test`, hash-verified download) with one tracked caveat (pack-format fallback for not-yet-recognized 26.1.2, "some features reduced") and that its `own-port` hosting mode satisfies §3's self-hosting-behind-a-proxy decision (`same-port`, the other self-hosting mode, explicitly doesn't work behind Velocity). §2, §3, and Phase 0 rewritten to match; Phase 0 marked done. |
| 2.1.0 | 2026-11-25 | Confirmed on the real box (`ufw status numbered`, `/opt/minecraft/` listing): the `:25565` rule to mirror is `ALLOW IN Anywhere` (tcp+v6), and no Paper install exists yet anywhere on the box, so the Nexo-on-26.1.2 compatibility check has nothing to test against. §3 and Phase 0 updated with the confirmed rule; the Nexo check is now explicitly flagged as blocked pending a throwaway test instance or `MINECRAFT_PROXY_TRAVEL_PLAN.md` Phase 2's real Paper swap. |
| 2.0.0 | 2026-11-25 | Direct operator input reversed the previous row's decision: resource pack set back to optional (§3) — a player who declines sees missing textures but can still join, rather than being disconnected. Removes the uptime/availability coupling "required" created for the self-hosted HTTP server. Phase 0 and the status table updated to match. |
| 1.3.0 | 2026-11-25 | Direct operator input: resource pack set to required (§3) — declining or a failed download disconnects the client, making the self-hosted HTTP server a hard dependency for joining the default world at all, not just a cosmetic nice-to-have. This closes out all three Phase 0 policy decisions (framework, hosting, required-vs-optional); what's left in Phase 0 is executing its verification checklist (Nexo-on-26.1.2 confirmation, reading/replicating the exact `:25565` ufw rules), not further decisions. Phase 0 and the status table updated to match. |
| 1.2.0 | 2026-11-25 | Direct operator input: resource-pack hosting decided (§3) — self-hosted directly on the Minecraft box, firewalled to the same `ufw` targets as the default world's own public game port, mirroring its existing rule(s) rather than inventing new ones. Phase 0 and the status table updated to match. Required-vs-optional (§3) remains open. |
| 1.1.0 | 2026-11-25 | Direct operator input: framework choice resolved to Nexo (§2) — free, avoids ItemsAdder's license, with its maturity risk carried into Phase 0 as an explicit Paper-26.1.2-compatibility check rather than assumed. Phase 0 and the status table updated to match. Resource-pack hosting (§3) remains open. |
| 1.0.0 | 2026-11-24 | Initial plan, direct request ("design a phased approach to building a farmer's delight equivalent"), reversing `MINECRAFT_PROXY_TRAVEL_PLAN.md`'s 2026-11-24 decision to phase out a Farmer's Delight equivalent entirely. Scope: a Paper-plugin approximation (custom-items framework + resource pack), not the real mod — framework choice and resource-pack hosting left open for Phase 0. |
