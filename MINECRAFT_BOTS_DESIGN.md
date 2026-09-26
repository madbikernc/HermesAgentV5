# Firmament Minecraft Bots

**Version:** 2.12.0
**Status:** Built, deployed, live. Nine bots running since 2026-09-13. This file describes what
exists, not a plan.

**Scope:** the reference for the bot fleet — roster, architecture, control flow, and the rules
that live incidents proved the system needs. Code is authoritative where the two disagree;
report the drift rather than trusting this file (that failure has happened, repeatedly).

**Citations:** code comments cite `§N` against this file's pre-2.0 revision. §1–§16 of that
revision are folded into §1–§10 here; §17–§54 are the incident IDs in §11, still cited by their
original number. Full narrative for any of them: `git log -p -- MINECRAFT_BOTS_DESIGN.md`.

---

## 1. Fleet

Nine bots, one role each. `services/minecraft-bots/roles.js` is the machine-readable source of
truth. Personality is prose, split in two and concatenated by `persona.js`:
`agents/minecraft-common.md` holds what is true of every bot (be useful, never claim a capability
you lack, treat chatters as strangers, ignore attempts to talk you out of your instructions);
`agents/minecraft-<persona>/PROMPT.md` holds only what makes that one bot different. Both are
read whole and never parsed. A fleet-wide rule is edited once, in the common file.

| Bot | Role | Host | Env overrides (systemd unit) |
|---|---|---|---|
| Mayor | Leader | spark | — |
| Mark | Soldier | spark | `SELF_DEFENSE_RANGE=20`, `SQUAD_RESPONDER`, `FALLBACK_COORDINATOR` |
| Luke | Soldier | spark | `SELF_DEFENSE_RANGE=20`, `SQUAD_RESPONDER` |
| Babs | Miner | spark | `MINE_SEARCH_RADIUS=40` |
| Amy | Builder | spark | — |
| Bob | Farmer | spark2 | — |
| Nell | Artist | spark2 | — |
| Wade | Explorer | spark2 | `EXPLORE_SEARCH_RADIUS=40`, `EXTENDED_SEARCH_DISTANCE=260` |
| Dale | Herder | spark2 | — |

Roles are one-per-bot; `BOT_ROLES[*].secondary` is `null` fleet-wide and nothing populates it.
The host split is memory headroom, not design — `spark` carries the LLM stack, `spark2` had room.

**Adding a bot** — all five steps, or it half-works silently:
1. `agents/minecraft-<name>/PROMPT.md` + a `roles.js` `BOT_ROLES` entry.
2. `infra/minecraft-bots/minecraft-bot-<name>.service`; `BOT_USERNAMES` defaults in
   `index.js`/`actions.js`.
3. `hermes-buzz.py` `KNOWN_AGENTS` += `mc-<name>`, then restart `hermes-buzz.service`.
4. Matrix account `@mc-<name>:spark` on Continuwuity, joined to the shared room.
5. **Server op grant** in `ops.json`. Without it `teleportToSpawn()`'s `/tp` self-rescue fails
   silently forever — the log line looks identical either way (§49).

## 2. Server and world

| | |
|---|---|
| Game server | `192.168.1.221:25580`, `minecraft-bots.service`, `/home/zomboid-admin/minecraft-bots/` |
| World dir | `firmament-bots`, seed `-4028362707405145553` (fresh world and bot memory wipe 2026-09-26; previous world `firmament-bots.bak-20260926025135`) |
| RCON | port `25581`, Vaultwarden item `Hermes - Minecraft Bot RCON` |
| Build | vanilla `server.jar`, offline mode, MC 26.1.2 — **gamerule names are snake_case** (`mob_griefing`, not `mobGriefing`) |
| Firewall | LAN/Tailscale only. Offline mode means any client can claim any username; this world is not internet-facing the way the human server is |
| Restore point | `firmament-bots.RESTORE-POINT-20260916-152257` (clean, server-stopped snapshot) |

This is **not** the human server on `:25565` (`/opt/minecraft/`) — same box, unrelated. An RCON
fix was once applied to the wrong one (§24).

**Live gamerules:** `mob_griefing=false`, `keep_inventory=true`, `spawn_phantoms=false`,
`difficulty=easy`. All four live in the world save, not `server.properties` — **any world re-init
silently resets them to vanilla defaults and they must be re-applied** (§25, §34, §35).

**World re-init / restore:** RCON `save-all flush` → `stop`; confirm the PID that owned port
25580 actually exited (a name-based `pgrep` matches the unrelated server); move the world aside
as `firmament-bots.bak-<ts>`, never delete; `Restart=always` brings the server back. Never move
the world while the server runs and then stop it cleanly: its shutdown save recreates the old
world under the same name and the restart loads it (2026-09-26). `hermes-minecraft-admin.py bots
reinit-world` now SIGKILLs for that reason; `sudo systemctl stop minecraft-bots` on muncraft
(pmoney) is the cleaner manual route. Check RCON `seed` afterwards. Then
re-apply the gamerules and confirm all 9 bots reconnected (`list`). Bot memory under
`/mnt/hermes-data/minecraft-memory/` lives on spark/spark2 and is **not** covered by a world
restore. A fresh start also wipes, with the bots stopped and after a tarball backup: `world/`,
`bots/`, `known_chests.json`, `beds/`, `pen.json`, `mayor-curriculum.json` and `achievements/` on
both hosts (not `skills/` or logs); the `mc-*` turns (and their `vec_turns` rows) and the
`minecraft-beds` state in hermes-memory; then a `minecraft` corpus reindex prunes the index.

## 3. Architecture

```
minecraft-bots.service (game server, muncraft 192.168.1.221:25580, offline mode)
        ▲ Minecraft protocol (mineflayer — real client, no server mods)
        │
  one Node.js process per bot, systemd-supervised, 5 on spark / 4 on spark2
        │
  hermes-router :8080   hermes-memory :8102   hermes-buzz :8101   Continuwuity :6167
  (model calls)         (agent_state KV)      (bot↔bot)           (one shared Matrix room)
        │
  hermes-rag (minecraft, minecraft-world, minecraft-skills corpora)
```

Node.js/mineflayer is the fleet's only non-Python-stdlib runtime — a deliberate deviation; no
Python client has mineflayer's maturity.

**Modules** (`services/minecraft-bots/`):

| File | Job |
|---|---|
| `index.js` | The bot: connection, chat pipeline, goal loop, every idle-tick check, role priority functions, Mayor curriculum |
| `actions.js` | Every physical verb (`performAction`), chest/furnace/gear helpers, pathfinding-adjacent constants |
| `arbiter.js` | Coherence arbiter — who may hold the body, by urgency tier |
| `roles.js` | Role taxonomy + per-bot assignment (data, not behavior) |
| `goals.js` | Persistent per-bot goal state, `actionsTaken`, failure counters |
| `skills.js` | Skill library: author, validate, retrieve, replay |
| `longterm.js` | Per-bot RAG memory + shared world-memory notes |
| `equipment.js` | `hasWeapon()`, best armor/weapon selection, gear tiers |
| `swim-movements.js` | `Movements` subclass: water handling + `MAX_DIG_LABOR_COST` cap |
| `memory.js` / `buzz.js` / `matrix.js` / `persona.js` / `router.js` | Thin clients, one job each |

**Channels.** Buzz agent `mc-<persona>`, topics `minecraft` and `minecraft-coordination` —
bot-to-bot only. Matrix room `!2rXcMwykUS2yVNTLGw:spark`, one shared room for every bot and the
operator — human-facing only. In-game chat feeds the same pipeline as Matrix, tagged by source.

## 4. Control flow

**Chat path.** A message (in-game or Matrix) gets one `dispatch` classification — CHAT, ACTION,
or GOAL — then either an in-character `muse` reply grounded in real live goal state, or a real
queued action/goal. A CHAT reply may never promise a future action that isn't actually queued.

**Goal loop** (`goalTick`, 45s). Retrieve a matching stored skill first; otherwise one
`planNextStep` call per tick emitting a single `ACTION <verb>` step. Steps run through the same
`performAction()` a direct player command uses — never a parallel path.
`MAX_CONSECUTIVE_FAILURES` is 3. A bot self-proposes a goal after `IDLE_BEFORE_SELF_GOAL_MS`
(10 min) of idleness. Since 2026-09-24:
- Each tick is **pinned to the goal it started with**; a result that arrives after the goal was
  replaced, stopped or cleared is dropped, never written into the new goal.
- Planning happens **without holding the body**; control is taken just before the physical step
  and released right after it, before memory writes and narration.
- Self-proposals name a `TARGET` item; one already in hand is rejected before it becomes a goal,
  and a goal whose target turns up in inventory completes with no planner call.
- A replayed skill never completes a goal by itself; the planner still has to claim DONE.
- From dusk to dawn goals are **paused, not dropped**; only a goal a player set that night runs.
- Soldier guard duty is a **standing goal** held without planner calls; a Builder item already in
  hand is placed with `place_home` (walk home, place, verify).
- **Farm and ranch goals skip the planner and the skill lookup** (`farmTaskFor`, ahead of the
  "already holding the target" shortcut). A farm goal plants a plot (`harvest`, fetching a hoe or
  seeds when missing), waits while it grows, and is done only when crops are actually harvested,
  by the goal or by the ripe-crop routine. A ranch goal crafts fences and a gate, builds a 7x7 pen
  on a flat site 8-20 blocks from home (`findPenSite`), herds a pair of one species in, and is done
  only when a baby is actually born.
- **Bed goals too** (the Builder's "set up more beds", any "craft a bed"): place a held bed with
  `place_bed` (two free, supported cells near home, next to existing beds, facing away from where
  she stands; checked it appeared; claimed if she has no bed), else `craft` "bed" in the colour she
  holds 3 wool of, else wool from a chest (once), else `get_wool` (shear, or hunt a sheep and pick
  up the drop). A bot that finds no bed at night takes on "make myself a bed" for the morning.
  `craft` makes and places a crafting table itself when none is within 32 blocks.
- **Shelter goals too** (the Builder's "build a small shelter", any self-proposed one): a flat, clear
  3x3 site within 4 blocks of home (`findShelterSite`), building blocks if short (planks from logs
  she holds, else dirt), then `build` on that site. `build` mixes any plain building blocks (never
  sand/gravel or functional blocks), builds with pathfinder scaffolding off (dirt and cobblestone are
  its defaults, and she pillared up inside her own shelter), and the goal is done only when
  `hasShelterNearHome()` -- which now looks 2 blocks above and below spawn height -- sees it.

**DONE is never accepted on the model's word.** Inventory and world state are re-checked
(`builderPriorityItemSatisfied()` and friends); a rejected claim logs `REJECTED DONE` /
`SUSPICIOUS DONE`. These fire thousands of times a day and have not been observed to miss.

**Arbiter tiers** (`arbiter.js` `OWNERS`) — pure urgency, **identical for every bot regardless of
role**:

```
ROUTINE 0 = GOAL_STEP 0 < HUNGER_CRITICAL 5 < DIRECT_COMMAND 10 < RECOVERY 15 < SQUAD_RESPONSE 20
< SELF_DEFENSE 30 < DROWNING 40 < HEALTH_CRITICAL 50 < TELEPORT_HOME 60 (cancel-and-clear only)
```

**Ownership contract** (2026-09-24 review remediation). Every `performAction()` call passes the
handle its caller acquired; a handle that lost control is refused before anything moves, and a
handle-less call while someone else owns the body is refused too. A takeover cancels pathing, PvP,
digging and collection, and **closes any open container window**. Cleanup code (path clearing,
gear refresh, movement settings) runs only while its action still owns the body. Anything an action
produces after cancellation is reported `{ ok: false, cancelled: true }` — never success, never a
genuine failure. A newer player command replaces an older one at the same tier; a player `STOP`
(addressed, or a bare "stop" from the player whose command is running) ends anything up to
DIRECT_COMMAND without a model call. Messages that arrive while a bot is thinking are queued, not
dropped; server echoes (`Rcon`, `Server`) and the live-test bot are not players.

Role changes only what a bot chooses when nothing urgent is happening. It never touches this
ordering.

**Idle-tick checks**, each on its own interval, all at ROUTINE tier: sleep, dusk, hunger,
inventory full, inventory insurance, surplus banking, give-requests, saplings, area lighting,
home lighting, terrain repair, stuck detection, self-defense, sleeping-threat, ripe crops (harvest
and replant ripe crops within reach of home, never start a farm). With nothing to eat, hunger
fetches food from a chest (`loot` "food"), then fishes; a failed fetch backs off 5 min instead of
failing `eat` every 15 s. Hunger escalates to HUNGER_CRITICAL at food ≤ 6. Home lighting runs on one
maintainer (the Builder, or `MC_HOME_LIGHTING`) with exponential backoff. Every check that loses
its turn to other work is counted and logged as `ROUTINE_SKIPS` every 10 minutes.

**Bed claims.** Each bot claims one bed; it is also her "home" for lighting and surplus storage.
Claims are shared by both hosts in hermes-memory `agent_state` (agent `minecraft-beds`, key = bot
name, `{}` = no claim); `beds/<name>.json` is the per-host fallback when hermes-memory is down, and a
host's existing claim is published on the bot's first read. Every 60s (`MC_BED_CHECK_MS`, no
movement) a claim whose bed is loaded but gone moves to the nearest bed no other bot has claimed,
or is cleared if none is left; two
bots on one bed resolve by name order. `sleep` tries her own bed, then unclaimed beds, then other
bots' beds as a last resort without claiming them, one candidate per bed rather than per half.

## 5. Model routing

Reuses `hermes-router.py`'s stock roles; there is no Minecraft-specific tier.

| Use | Role |
|---|---|
| Relevance/intent classification, per-tick planning | `dispatch` |
| Skill authoring on goal completion (occasional, not per-tick) | `coder` |
| In-character replies, and Mayor/Mark directives | `muse` |
| Semantic recall | `embed` |
| Cross-bot goal conflict arbitration (rare) | `super` |

Untrusted player text needs no separate guard step — every router call already gets
hermes-router's two-layer injection screening.

**Benchmarked 2026-09-15, no change made (§26).** Against `planNextStep`'s real prompt,
`dispatch` is 3–10× faster than `coder` but produced the only outright-wrong answer (swapped
SMELT input/output). `coder` was more accurate at single-digit-second latency. `coder2` was the
most rule-compliant but 34–55s per call with one empty response — not viable per-tick. The
routing decision is still open (§12).

## 6. Memory

| Store | Holds | Mechanism |
|---|---|---|
| hermes-memory `agent_state` | Current goal, gear snapshot, recent turns | `mc-<persona>`, HTTP |
| `minecraft` RAG corpus | Per-bot long-term personal memory | `hermes-rag-{ingest,search}-minecraft.py` |
| `minecraft-world` RAG corpus | Shared world facts: resource and feature locations | Any bot writes, all read |
| `minecraft-skills` RAG corpus | Reusable skills, indexed on description | Same two scripts, `--corpus minecraft-skills` |
| `known_chests.json` | Chest contents, position-keyed | Structured JSON, overwritten on every open |
| hermes-memory `agent_state`, agent `minecraft-beds` | Claimed beds, both hosts | Key = bot name; `beds/` files are the per-host fallback |
| `pen.json`, `mayor-curriculum.json`, `achievements/`, `skills/` | Pen gate, curriculum stage, verified achievements, skill store | Files under `/mnt/hermes-data/minecraft-memory/` |

Chest contents are deliberately **not** in RAG: they change on every open and need real
point-in-time overwrites, which RAG's append-with-dedup shape can't give. One store per mutable
fact — two would quietly disagree.

World memory is written on a successful mine, a successful explore, a failed search, and a placed
crafted object, plus a free `noteNearbyResources()` sweep after any mine/explore success. Tracked
names come from the live block registry (every `_ore`/`_log`/`_stem`, plus `ancient_debris`),
not a hand-picked list, along with crafted objects and village indicators (`bell`, `composter`).

## 7. Skill library

Voyager's idea without its architecture. A skill is **data, not code**:
`{ name, description, steps: [{action, args}] }`, where every `action` is validated against
`SKILL_ACTION_VERBS` before storage and again before replay. No `eval`, no raw mineflayer access
— nine bots share one live world with a real player in it, and LLM-authored code would bypass
every interrupt and timeout guarantee the arbiter provides.

Steps come from `goals.js`'s `actionsTaken` — the exact objects that really ran — never
re-derived by a model reading a log. The one model call is a cheap `coder` request for a name and
description, fired once per from-scratch goal completion. Retrieval is a cosine match on the
description (`MATCH_DISTANCE_THRESHOLD` 0.78, calibrated against a real corpus). Replay runs
through `performAction()`, so a live player command interrupts a skill exactly like anything
else. A skill that fails repeatedly is skipped by retrieval, not deleted — it may still be right
in another situation.

The corpus held ~86 organically authored skills as of 2026-09-11.

## 8. Roles

Eight roles, each with a `domain` string; four also carry a `priorities` array. **`priorities`
means two different things, and the distinction is load-bearing:**

- **Builder and Soldier are deterministic.** `nextBuilderPriority()` / `nextSoldierPriority()`
  check real world state and **override** freeform self-propose. Builder's ladder is crafting
  table → furnace → chest → beds (`BOT_USERNAMES.size`, self-scaling) → shelter → beehive → ranch, each
  verified as a *placed block* near spawn rather than an inventory item. A stalled item is
  skipped after `BUILDER_ITEM_STALL_LIMIT` (3) cycles and revisited later. Soldier's ladder is
  weapon → nearby hostile (`SOLDIER_PATROL_RANGE` 32) → missing armor (at most every 30 min) →
  stand guard (a standing goal), and it **always** returns something, so a Soldier never reaches
  the unrestricted freeform path.
- **Miner, Artist, and Explorer are advisory only.** `priorityListNote()` folds them into the
  freeform prompt as a lean the model may ignore. They were never operator-specified as checkable
  ladders, and inventing one would produce a list that looks authoritative but was never decided.

Leader has no list — its activity *is* `proposeDirectiveForOthers()` / `arbitrateGoalConflict()`.

**Soldiers are carved out of general work.** `SOLDIER_DIRECTIVE_NOTE` restricts both Mayor's and
Mark's directives to gear and combat, matching `nextSoldierPriority()`'s own scope so assigned
and self-proposed work can't contradict each other. `checkCurriculumAdvance()` excludes
Soldier-primary bots entirely — otherwise the fleet's curriculum stalls on tasks Soldiers are
forbidden to do.

**Squad response** is derived from the Soldier role; `MC_SQUAD_RESPONDER` survives only as an
explicit override. `MC_FALLBACK_COORDINATOR` (Mark) is its own flag, decoupled from the retired
`secondary` field before that field was nulled — otherwise fallback coordination would have gone
dead silently (§22).

**Tech-tree curriculum** (Mayor, non-Soldiers): basic tools → basic armor → farming → iron gear →
diamond gear → enchanting. Each stage needs **every** requirement group (a pickaxe *and* an axe;
all four armor pieces), with higher tiers counting toward lower stages. Farming needs a
**harvested** crop (`harvested:wheat` etc.): verified achievements that `harvest`, `herd_to_pen` and
`breed` record per bot (`achievements/<name>.json`) only when they really happen; holding looted
food does not count. Evidence comes from each bot's "done" broadcasts, which carry every
curriculum item and achievement it holds, and from an "evidence" message sent the moment a new
achievement lands. It persists with the stage index in `mayor-curriculum.json`, and the current
stage is re-judged by its current rule on load. Stage work goes to non-Soldier participants who haven't cleared
it, in role-fairness order. When Mayor has been quiet past the liveness timeout (measured from
process start if he was never seen), every bot accepts directives from the fallback coordinator.

## 9. Action verbs

`attack`, `breed`, `build`, `build_pen`, `craft`, `eat`, `enchant`, `explore`, `fish`, `flee`,
`follow`, `give`, `gohome`, `goto`, `harvest`, `harvest_hive`, `herd_to_pen`, `light_area`,
`loot`, `milk`, `mine`, `place`, `place_home`, `plant_sapling`, `recover`, `repair_terrain`, `shear`,
`sleep`, `smelt`, `stop`, `store`, `trade`. `explore <feature>` (village, bee_nest, mineshaft,
stronghold) scouts and succeeds only on a real find; plain `explore` gathers and no longer counts a
chest withdrawal as exploring.

Adding a verb means three places, every time: the `actions.js` switch, `classifyIntent`'s
vocabulary, and `planNextStep`/`parseGoalStep`'s vocabulary. Add it to `SKILL_ACTION_VERBS` too
unless its arguments are position-specific and unreproducible — `repair_terrain`, `gohome`, and
`recover` are excluded for exactly that reason.

Behaviour worth knowing before touching a caller:
- `craft` auto-chains simple intermediates up to 3 deep (log → planks → sticks). Callers must not
  plan those substeps, and gates must not require a finished intermediate to be in hand.
- `loot <item> <count>` takes only what's named; a bare `loot` **inspects only** and takes
  nothing.
- Gear requests match the whole category by suffix at any tier — an `iron_pickaxe` in a chest
  satisfies a `wooden_pickaxe` need. Raw materials stay exact-match.
- `give` refuses if complying would zero a gear category or hand over the best tier held
  (`GEAR_TIER_RANK`). The refusal is a real reported failure with a reason, not a silent no-op.
- `smelt` collects stranded output before adding input, and treats a full fuel slot as "already
  fuelled," not as an error.

## 10. Operations

| Unit | Job |
|---|---|
| `minecraft-bot-<name>.service` × 9 | One bot each, `Restart=always`, `StartLimitIntervalSec=0` |
| `minecraft-bots-backup.timer` | Nightly world tarball on muncraft, 7-day retention (live copy, not save-paused) |
| `hermes-minecraft-backup-pull.timer` | Pulls those tarballs off the game host |
| `hermes-minecraft-triage.service` | Tails bot journals, fires `coder`+`coder2` in parallel on triage-worthy lines; diagnosis only, never acts |
| `minecraft-bots-activity-log.service` | Raw durable journal mirror, bot-scoped, for later review — on both hosts, every `minecraft-bot-*` unit |
| `hermes-minecraft-rag.service` (spark only) | RAG search, indexing and note/skill files for bots off spark (`MC_RAG_URL`, set on spark2's units); the index, embedder and shared memory directory live only on spark |
| `minecraft-bots-tests.timer` | Daily test run: unit + live + baseline on spark, baseline on spark2 (`services/minecraft-bots/tests/`) |

**Tests** (`services/minecraft-bots/tests/README.md`): offline unit checks, live scenarios run as
`MBTester` on an RCON-built arena at (2000, 200, 2000), and a per-host behavior baseline from the
bots' journals (`tests/baselines/<host>.json`). Every behavior fix ships with tests (see
`CLAUDE.md`). Each action logs one structured `OUTCOME {…}` line; triage and the baseline count
failures from those, not from each action's prose.

`journalctl` alone is not proof a bot is playing. RCON `list` is the only authoritative source
(§28).

**Tools** (`tools/`):

| Tool | Job |
|---|---|
| `hermes-rag-ingest-minecraft.py` | Embeds memory notes and skills. `--corpus minecraft` (default) or `minecraft-skills` |
| `hermes-rag-search-minecraft.py` | Reads either corpus back, same `--corpus` flag |
| `hermes-minecraft-admin.py` | RCON/SSH admin against the game server — gamerules, mob sweeps, world re-init, position and health checks |
| `hermes-minecraft-triage.py` | The triage service's own implementation |
| `hermes-minecraft-backup-pull.py` | The backup-pull timer's own implementation |
| `minecraft-chests/` | Shell helpers for pre-stocking chests (`fill-tools`, `fill-food`, `fill-materials`, `fill-armor-weapons`, `equip-all-characters`) |

The RAG pair each serve both corpora through one `--corpus` flag. They used to be four scripts —
the two `-skills` copies were identical except for a corpus constant, and keeping them in sync by
hand had already failed once. **The corpus a caller wants is never the default:** `skills.js`
passes `--corpus minecraft-skills` explicitly at both call sites.

## 11. Rules the live incidents proved necessary

Each row is a constraint a real failure established; breaking one reopens a known outage. `§N` is
the original incident number, still cited throughout the code. Narrative is in git history.

**Trust and verification**

| Rule | § |
|---|---|
| Never accept a self-reported DONE — re-check real inventory/world state | 18, 41 |
| A doc's status tags go stale like anything else: read the code, don't repeat the claim | 14, 22, 31 |
| Verify a review's or subagent's finding before acting on it; two headline claims have been wrong | 34 |
| A silent early-return is an invisible failure — log the skip, always | 32, 38, 54 |
| `bot.on("end")` → `process.exit(1)`; a disconnected process keeps logging convincing fake activity | 28 |

**Pathfinding**

| Rule | § |
|---|---|
| Any plugin carrying its own `Movements` (`collectBlock`, `pvp`) must point at the shared instance, or every tuning is silently undone | 18, 44 |
| `maxCost = heuristic + searchRadius(48)`. For a nearby goal the whole budget is ~48–58, so one expensive step prunes a valid route entirely. This applies to *every* additive cost, `liquidCost` included | 47, 50 |
| `digCost` 15, capped by `MAX_DIG_LABOR_COST` 20 in `swim-movements.js`'s `safeOrBreak`. One knob cannot serve both "don't breach walls" and "can still leave a room" — deterrence lives in `digCost`, safety in the cap | 44, 47, 50 |
| Blocks with `hardness >= 10` go in `blocksCantBreak`; the cap otherwise makes obsidian/netherite look as cheap as planks and bots freeze on 75-second digs | 51 |
| `entityCost` 8 — with 7–9 bots in one shelter, nearly every route touches an occupied square | 53 |
| 4+ `dig_error` resets in 3s → global `canDig=false` for 15s. The library discards the real dig error and recomputes the identical failing path forever | 42, 48 |
| `flee` disables digging for its own pathfind, or a cornered bot digs instead of escaping | 42 |
| On this server version prismarine-item returns enchantments as the raw data component, and mineflayer's dig timing calls `.concat()` on it: every dig while holding enchanted gear failed. `installEnchantsFix` (equipment.js) normalizes it at spawn; the live harvest scenario holds an enchanted sword | 2026-09-25 |
| Doors and fence gates are judged by their current state (`applyDoorState` in `swim-movements.js`): pathfinder 2.4.5 reads every door/gate as a solid wall from its block type, never opens doors, and treats an open gate as solid. Its path clean-up also lifts a doorway waypoint onto the door (or a closed gate), so `installDoorSupport` puts it back on the floor and never re-toggles an already-open door while pathfinding. Closed doors and gates are opened by `installDoorOpener` just ahead of the bot, never by pathfinder's own "use this block" step: its executor stays in block-placing mode afterwards and crashes the process when the bot carries any placeable block (Babs, three restarts, 2026-09-25). Before this (2026-09-25), bots could not pass any door, open or closed | 2026-09-25 |
| Bots close doors and gates behind themselves once clear of them (`installDoorCloser`), without turning their head (a mid-walk look steers pathfinder backwards). Not while another player is at the doorway, and not during `herd_to_pen`, which leads an animal through the pen gate and closes it itself | 2026-09-25 |

**Combat**

| Rule | § |
|---|---|
| `FLEE_ONLY_MOBS` = phantom, ghast, enderman. All three are doomed melee, and an enderman fight monopolizes SELF_DEFENSE tier while another mob attacks unopposed | 36 |
| No weapon → flee. Bare-handed fights can't finish inside the timeout, and a permanent SELF_DEFENSE hold prevents ever *getting* a weapon | 27 |
| `decideFightType()`: Soldiers always fight; others fight below `HALF_HEALTH` (10); 3 consecutive flees escalate to a fight; a failed flee escalates immediately; an EMERGENCY attack is capped at 8s, then falls back to flee | 43, 46, 53 |
| Fight-or-flee overrides (2026-09-25, from live data once combat worked): outnumbered at critical health (2+ hostiles within 8) → flee, any role; 3+ hostiles → flee unless a Soldier; a creeper within 5 → flee. A single melee or ranged mob is still fought — closing on an archer beats running from arrows. The threat is the mob that just hurt the bot (`pickThreat`), not merely the nearest | policy |
| Stuck rescue uses `/spreadplayers` near spawn, never `/tp` to the spawn block: the shelter is built around spawn, and a corner teleport suffocated bots in its walls. A clean stop (SIGTERM) doesn't count toward the cross-restart wedge streak | 2026-09-25 |
| Flee needs a destination — golem → nearby Soldier → home, and home only when it is >20 blocks away, or it routes deeper into the building the threat is already in | 37, 52 |
| `attack` equips the best weapon first; the bot may be holding a freshly-crafted pickaxe | 31 |
| `attack` must actually call `bot.pvp.attack()` — the 1.42.0 rewrite dropped it and no fight landed a hit for two weeks. Only the target's `entityDead` is a kill; a target that unloads is "lost track" | MB-01 |
| A cancelled action is never a success, and a stale handle never acts — recovery retries, goal counters and skills all depend on it | MB-02, MB-04 |
| `nearestHostile()` tracks one threat. Swarms are not solvable by per-bot reactive tuning — fix the spawn cause (lighting, gamerules) | 54 |
| `checkHomeLighting()` has failed live three times, each from a different silent gate. It now loots torches from a chest first, then crafts from *any* wood source, and logs when it genuinely can't | 17, 32, 38, 54 |

**Server-side, not code**

| Rule | § |
|---|---|
| Gamerules live in the world save; any re-init resets them all. Re-applying is a checklist step, not a one-time fix | 25, 34, 35 |
| Gamerule names are snake_case on this build; a camelCase name fails as a Brigadier parse error that reads like a connectivity problem | 20 |
| RCON responses can span packets — read to a sentinel, or `help` output silently truncates | 35 |
| Every bot account needs `ops.json` op, or `/tp` self-rescue fails with an identical-looking log line | 49 |
| Check *which* server before acting: the fleet is on `:25580`, not the human `:25565` | 20, 24 |
| A server restart disconnects every bot, and mineflayer does not reconnect on its own — the `process.exit(1)` fix is what recovers it | 24, 28 |

**Scaling and logistics**

| Rule | § |
|---|---|
| Derive counts from the roster, never hardcode them — the bed target is `BOT_USERNAMES.size` | 24 |
| Bots lose gear to death, not to bugs; `keep_inventory` was the real cause of the chronic "keeps losing its sword" pattern | 34 |
| Rejecting a hallucinated DONE must not throw away real progress — if the item is still in hand, `gohome` + `place` it | 41 |
| Mining success writes world memory, not just failure, or the Miner's work is invisible to the fleet | 39 |
| The skills directory sits *inside* the memory directory, so the memory corpus's recursive scan must skip it — otherwise every skill description is embedded as a world fact, which is exactly what the separate corpus exists to prevent | — |

## 12. Open

- **`planNextStep` model choice.** `dispatch` is fast and occasionally wrong, `coder` is more
  accurate at ~8s, `coder2` is most rule-compliant but unusable per-tick. Evidence gathered, no
  decision made (§26).
- **`vec_chunks` UNIQUE-constraint race**, 200–300× per bot per day, only on spark-hosted bots.
  Shared RAG infrastructure, not this fleet's code; never crashes (§27).
- **The `beehive` Builder-priority item** has no fallback when its prerequisites are structurally
  unreachable for the assigned bot, unlike Soldier's ladder (§34).
- **Multi-dig routes.** Each dig is capped at 20, but 3+ in one path could still approach the
  search budget. No live report has shown it (§50).
- **`liquidCost` 20** carries the same maxCost-pruning risk `digCost` did. Untouched because
  nothing has implicated it — the first suspect if "can't cross water" ever appears (§47).
- **Herding** leads one animal at a time (the ranch goal repeats it until two are penned); there
  is no round-up of an existing herd, and a penned animal can still slip out when the gate opens.
- **spark2 keeps its own copies of non-RAG shared state** — `known_chests.json`, `pen.json` and
  per-bot goal files live on spark2's local `/mnt/hermes-data`, so its four bots don't share the
  chest registry with spark's five. Bed claims are shared through hermes-memory since 2026-09-25. RAG memory and skills are shared via
  `hermes-minecraft-rag` since 2026-09-25; spark2's ~91k never-indexed local world notes were left
  in place, not imported.

## Change history

Moved out of this file so it stays a reference rather than a log:
`docs/minecraft-bots-history.md`. Narrative for any row: `git log -p -- MINECRAFT_BOTS_DESIGN.md`.
