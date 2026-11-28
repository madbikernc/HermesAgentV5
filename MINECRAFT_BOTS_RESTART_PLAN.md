# Minecraft Bots Restart Plan

**Version:** 1.7.0
**Status:** System restored and live. Babs and Amy are running on the Mindcraft-ported baseline on
dgx-spark, confirmed via journal output and the bot-sandbox's own RCON — profile loading, Matrix,
`muse` replies, and command dispatch all verified working. Phase 6 (test coverage) is the one
remaining open item, deliberately deferred past this live run, not silently dropped.

Scope: `services/minecraft-bots/`, `infra/minecraft-bots/`, and the bot-sandbox Paper server
(`minecraft-bots.service`, port 25580, world `firmament-bots`, host `192.168.1.221`) only. Nothing
else in the Firmament Fleet — Buzz, Matrix infra, the human-world Zomboid/Minecraft servers,
self-repair, any other Hermes service — changes as part of this plan.

## 0. Open questions — resolved 2026-11-27

1. **World continuity — resolved: reinit.** The restart includes a fresh world
   (`hermes-minecraft-admin.py bots reinit-world`), not just a behavior swap on the current one. Old
   world moved aside with a timestamp as usual, not deleted.
2. **Archive folder location — resolved: as proposed.** `services/minecraft-bots-archive-11-2026/`,
   sibling to `services/minecraft-bots/`, with a terse `ARCHIVE_INDEX.md` left in
   `services/minecraft-bots/`.

## 1. "Previously planned mods" — what that turns out to mean

There is no mod/plugin plan for the bot server at all. `MINECRAFT_BOTS_DESIGN.md` states it directly:
mineflayer connects as a real client, no server mods. The only mod-adjacent facts on record for this
specific server are: plain Paper 26.1.2 jar (upgraded from vanilla 1.21.11 2026-11-14 per
`MINECRAFT_SERVER_UPGRADE_PLAN.md`), and `bungeecord: true` (enabled 2026-11-25 for cross-server
proxy travel, `MINECRAFT_PROXY_TRAVEL_PLAN.md` Phase 5). The four plugins removed earlier this
session (Chunky, ClearLAGGG, CoreProtect, an orphaned `bStats` dir) were never part of any plan —
ad hoc additions, correctly cleaned up, not a baseline to restore. `FARMERS_DELIGHT_EQUIVALENT_PLAN.md`
is explicitly scoped to the *separate* human-world server (`192.168.1.221:25565`), not this one, and
stays out of scope here.

**Restart target:** plain Paper jar, zero plugins, `bungeecord: true` kept. "Previously planned mods"
for this server resolves to "none, by design" — there's nothing to re-add.

## 2. Persona/role roster — end goal, unchanged

The `<Name>_<Role>` display convention (`roles.js`) is kept exactly as-is. Current state is mostly
stopped, not mostly running — the restart's job is bringing all nine back up under the new baseline,
not just two:

| Name | Role | Host | Current state |
|---|---|---|---|
| Mayor | Leader | dgx-spark | inactive |
| Mark | Soldier | dgx-spark | inactive |
| Luke | Soldier | dgx-spark | inactive |
| Babs | Miner | dgx-spark | **active** |
| Amy | Builder | dgx-spark | **active** |
| Bob | Farmer | dgx-spark2 | inactive |
| Nell | Artist | dgx-spark2 | inactive |
| Wade | Explorer | dgx-spark2 | inactive |
| Dale | Herder | dgx-spark2 | inactive |

## 3. Integrations kept as-is

- **Buzz** (`services/minecraft-bots/buzz.js`) — bearer-token HTTP client to the `hermes-buzz.py`
  coordination service (`mc-babs`/`mc-amy` as `KNOWN_AGENTS`, `minecraft` as a `KNOWN_TOPIC`).
  Best-effort; an outage degrades to bots not hearing each other, never crashes. No changes.
- **Matrix** (`services/minecraft-bots/matrix.js`) — direct client against Continuwuity's plain
  Matrix Client-Server API, one shared operator+bots room. Best-effort/non-fatal on outage. No
  changes.

Both are already decoupled from the goal/priority engine being replaced below — swapping the
instruction/skill/task layer doesn't touch either.

## 4. New behavioral baseline: Mindcraft

Research recommendation ([kolbytn/mindcraft](https://github.com/kolbytn/mindcraft), MIT, actively
maintained, already Mineflayer-based — same JS stack this project runs on):

- **(a) Skill/action library** — port Mindcraft's ~47-command skill layer into this project's
  `actions/` surface, in place of the hand-built equivalents being archived.
- **(b) Task/curriculum** — adopt Mindcraft's `tasks/*.json` schema as the task source. Optionally
  broaden it later with MineDojo's task-instruction text corpus (1,500+ phrasings), rewritten into
  Mindcraft's schema — MineDojo is a text/ideas source only, not something to integrate at runtime
  (it's a Python RL sim, not Mineflayer/Paper).
- **(c) Persona instructions** — adopt Mindcraft's `profiles/*.json` schema (system prompt +
  conversation examples + model config) for each of the nine personas, in place of whatever bespoke
  instruction content is archived with them.
- **Recipes — a non-issue.** `minecraft-data` (PrismarineJS) is already a transitive Mineflayer
  dependency in this project and already ships a complete, actively-maintained crafting/smelting
  database. Nothing to adopt here.

Voyager and its successor Odyssey were also surveyed — both are Mineflayer-adjacent and pioneered the
"skill library" pattern Mindcraft itself extends, but Voyager has had no 2025/2026 activity and both
are tied to older-generation prompting assumptions. Worth knowing about, not worth building on.

**What does *not* get replaced:** `index.js` (rewritten to call the new skill/task/instruction layer
instead of the archived priority engine — same process shape, same systemd unit, same Buzz/Matrix
wiring), `run-bot.sh`, the systemd unit layout, `pathfinding.js`/`swim-movements.js` (this session's
movement fixes), `buzz.js`, `matrix.js`, `roles.js`. Mindcraft is a content/format donor here, not a
wholesale framework swap.

## 5. What moves to the archive

Everything below is a candidate for `services/minecraft-bots-archive-11-2026/` — hand-built
goal/priority/instruction content, not infra, not Buzz/Matrix, not the roster mapping:

- **Docs:** `PRIORITIES.md`, `PRIORITIES_PROPOSAL.md`, `MINECRAFT_BOTS_DESIGN.md` itself (its
  behavioral-design sections — the bare server/roster/integration facts get folded into whatever
  replaces it for the new iteration).
- **Goal/priority engine:** `goal-proposal.js`, `goal-runners.js`, `goal-tick.js`, `goals.js`,
  `priorities.js`, `gear-goals.js`, `fleet-coordination.js`.
- **Role-specific behavior:** `mayor.js`, `night-survival.js`, `self-defense.js`, `shelter.js`,
  `shelter-goals.js`, `shelter-memory.js`, `home-scan.js`, `upkeep-home.js`, `upkeep-inventory.js`,
  `upkeep-world.js`, `tunneling.js`, `faults.js`, `persona.js`, `incoming.js`, `planning.js`.
- **Chat/intent:** `chat.js` (intent classification + `DIRECT_COMMAND` parsing — distinct from
  `matrix.js`'s transport plumbing, which stays).
- **Memory/skills:** `memory.js`, `longterm.js`, `skills.js`, `rag-backend.js`.
- **Action library:** `action-chests.js`, `action-claims.js`, `action-crafting.js`,
  `action-movement.js`, `action-search.js`, `action-shelter.js`, `action-vocab.js`,
  `action-world.js`, `actions.js`, plus all ~41 files under `actions/`.
- **Persona instruction files** (found during Phase 2's file-placement review, not in the original
  list): `agents/minecraft-<name>/PROMPT.md` for all nine personas plus `minecraft-mbprobe` (the
  live-test probe persona) — the current hand-written per-bot system prompts, prepended with
  `agents/minecraft-common.md` by `persona.js`. These are exactly what Mindcraft's `profiles/*.json`
  schema replaces in Phase 4. **Caveat carried into Phase 4:** `agents/minecraft-common.md` is the
  written contract `fleet_muse_contract` (`FLEET_BENCHMARK_DESIGN.md` §6.3) scores the `muse` role
  against. Archiving it isn't enough on its own — Phase 4 must either keep an equivalent "common
  contract" doc for the new profiles or revise `fleet_muse_contract`'s fixtures in the same change, or
  that benchmark silently starts scoring against a contract nobody's bots follow anymore.
- **Their tests — correction found while executing Phase 3:** `tests/unit/*.test.mjs` is NOT split
  one-file-per-source-module; files are grouped by behavioral area (`control.test.mjs`, `services.test.mjs`,
  etc.) and most are a genuine mix. `control.test.mjs` is mostly `arbiter.js` coverage (`requestControl`,
  `cancelAndClear`, `OWNERS` tiers — all kept) with some `chat.js`/`goal-runners.js` assertions
  (archived) mixed in; `services.test.mjs` mixes real `router.js` (`callRole`) coverage with
  `chat.js` narration tests. Splitting these correctly means reading each file in full, not
  pattern-matching a header comment — real engineering, not file-moving. **Decision: source files and
  docs move in Phase 3 (cleanly separable, confirmed file-by-file); the test directory does not move
  in Phase 3 at all.** Phase 6 is responsible for extracting kept-infra coverage (`arbiter.js`,
  `router.js`, and anything else `pathfinding.test.mjs` doesn't already cover) into its own dedicated
  files, *then* archiving what's left, before writing fresh tests against the Mindcraft-based
  replacements — in that order, so no module is ever left with zero coverage mid-transition.

**Resolved during Phase 2 — all three stay, none archived:**
- `router.js` — thin client to `hermes-router.py`'s role dispatch (`callRole("muse"/"super"/"coder"/
  "dispatch", ...)`). Confirmed reusable infra: whatever decides goals next still needs to reach these
  roles the same way.
- `equipment.js` — gear/armor/weapon/tool selection from real game state (durability math, `mineflayer-tool`
  wiring). Mechanical, not goal content.
- `arbiter.js` — tiered control arbitration (who owns the bot's physical actions right now: routine
  work vs. player command vs. emergency). The tiers' *names* come from the old goal engine, but the
  arbitration mechanism itself is still needed under any skill library, including the new one. Its
  real `OWNERS` tiers, confirmed by reading the file during Phase 4 (not from memory): `ROUTINE`,
  `GOAL_STEP`, `HUNGER_CRITICAL`, `DIRECT_COMMAND`, `RECOVERY`, `SQUAD_RESPONSE`, `SELF_DEFENSE`,
  `DROWNING`, `HEALTH_CRITICAL`, `TELEPORT_HOME`.

**Second correction, found while actually wiring Phase 4's port together — `shelter.js` and
`action-vocab.js` were un-archived back to kept infra.** Both were originally filed under "role-specific
behavior"/"action library" and archived, but `pathfinding.js` and `swim-movements.js` (kept, and
already working, hard-won code from this session) import `wouldBlockAccess`/`isLivingSpaceWall` from
`shelter.js` and `isProtectedBlockName` from `action-vocab.js` — both turned out to be pure
safety/vocabulary infra (living-space wall/access detection; protected-block-name matching, hostile
mob lists, gear tiers) with no dependency on the archived goal engine (confirmed: each imports only
`vec3`/`mineflayer-pathfinder`, nothing archived). Restored both to `services/minecraft-bots/`;
`pathfinding.js` bumped to 1.4.1 to import `isProtectedBlockName` from `action-vocab.js` directly
instead of the now-gone `actions.js` re-export. `ARCHIVE_INDEX.md` updated to match.

## 6. Benchmark-evaluation call (CLAUDE.md requirement, recorded here)

Confirmed during Phase 2's `router.js` review: these bots do route through Hermes's own role-based
dispatch — `callRole("muse"/"super"/"coder"/"dispatch", ...)` against `hermes-router.py`, the same
backbone `FLEET_BENCHMARK_DESIGN.md` benchmarks. That makes the §4 gap-structure question a real one,
not a formality, and it checks out:

- **`muse`** (in-character chat, Mayor/Mark directives) already has Tier 1 coverage —
  `fleet_muse_contract` (`FLEET_BENCHMARK_DESIGN.md` §6.3, built 2026-10-22), scored against the
  written contract in `agents/minecraft-common.md`.
- **`dispatch`** (Minecraft `classifyIntent`/`planNextStep`) already has Tier 1 coverage —
  `fleet_dispatch_routing`/`fleet_mc_intent` (§2, row for `dispatch`).
- **`coder`**'s one Minecraft call (`skills.js:192`, naming/describing an already-solved skill in two
  lines for the skill library) isn't coding-capability work in Hermes's own codebase — it doesn't
  match the §6.7/§6.8 corpus-growing criterion (real requirement or bug fixed *in this repo*), so it
  adds nothing to that design doc's candidate table.
- **`super`**'s one existing gap (§4.1, log-analyst correctness) is about its log-analysis duty, not
  its Minecraft planning use (`planning.js:395`) — unaffected by this restart.

**Call: does not need a new `FLEET_BENCHMARK_DESIGN.md` scenario.** The roles this capability touches
are already covered, and the restart changes *what decides when to call them*, not which roles get
called or what they're asked to do. The one thing that must not slip: Phase 4's persona-profile
rewrite has to keep `fleet_muse_contract`'s contract current (see §5's caveat on
`agents/minecraft-common.md`), or an already-built benchmark quietly goes stale.

## Phased build-order & status

| Phase | What | Status | Date | Notes |
|---|---|---|---|---|
| 0 | Write this plan | done | 2026-11-27 | |
| 1 | Operator sign-off on §0's two open questions | done | 2026-11-27 | reinit world; archive path as proposed |
| 2 | Freeze & snapshot: stop Amy/Babs cleanly, RCON `save-all`, reinit world, resolve `router.js`/`equipment.js`/`arbiter.js` placement from §5 | done | 2026-11-27 | World reinitialized, fresh seed `53110123` (old world kept as `firmament-bots.bak-20261127181944`); `mob_griefing`/`keep_inventory`/`spawn_phantoms` gamerules reapplied; all 9 bot units confirmed stopped on both hosts |
| 3 | Create `services/minecraft-bots-archive-11-2026/`, move the §5 source/doc file list into it (**tests excluded — see §5's test correction**), leave `ARCHIVE_INDEX.md` in `services/minecraft-bots/` | done | 2026-11-27 | Also archived the old `README.md` (described the archived architecture in detail) and wrote a fresh minimal one. **Known follow-up, not done here:** ~14 other docs repo-wide (`FLEET_BENCHMARK_DESIGN.md`, `IMPLEMENTATION_PLAN.md`, `infra/minecraft-bots/README.md`, `docs/minecraft-bots-history.md`, etc.) still link `MINECRAFT_BOTS_DESIGN.md`/`agents/minecraft-*` at their old paths — low-stakes (findable by filename) but not fixed; sweep separately if it becomes annoying |
| 4 | Pull in Mindcraft's skill library, profile schema, and task schema; port skills into `services/minecraft-bots/`, write the 9 persona profiles | done | 2026-11-27 | `skills.js`/`world.js`/`mcdata.js`, `commands.js`, `modes.js` all ported and syntax-checked (`node --check` on dgx-spark); 9 `agents/minecraft-<name>/profile.json` + `agents/minecraft-common.json` + `minecraft-mbprobe` written from the archived PROMPT.md content; `!stop` fixed (0.1.0 bump) to actually interrupt a skill's loop via `bot.interrupt_code`/`arbiter.cancelAndClear` |
| 5 | Rewrite `index.js` to call the new layer; keep `pathfinding.js`, `swim-movements.js`, `buzz.js`, `matrix.js`, `roles.js`, `router.js`, `equipment.js`, `arbiter.js`, `shelter.js`, `action-vocab.js`, `faults.js`, `run-bot.sh` unchanged | done | 2026-11-27 | `index.js` 4.0.0: decision loop (`callRole("muse", ...)` + `commands.js`'s `!verb(args)`), chat/whisper/Matrix handling, `bot.modes`/`bot.interrupt_code`/`bot.output` shim for skills.js. Known, flagged gaps: no cross-restart wedge rescue, no Buzz goal/death broadcasting, no long-term/RAG memory (bounded in-process history only) — see `index.js`'s own header |
| 6 | Extract kept-infra test coverage (`arbiter.js`, `router.js`, others) from the mixed `tests/unit/*.test.mjs` files into their own dedicated files; archive what's left of those files; write fresh tests against the Mindcraft-based replacements; update `tests/README.md` | not started | | **Not done before the Phase 7 relaunch below** — a real gap against this project's own "every behavior change ships with a test" rule, accepted deliberately given the direct instruction to get Babs/Amy running now; tracked here so it isn't silently dropped |
| 7 | Relaunch Babs and Amy only, per direct instruction 2026-11-27 (not all nine — the rest stay stopped until requested) on dgx-spark; verify via RCON + Buzz/Matrix smoke checks | done | 2026-11-27 | Both live and confirmed via the bot-sandbox's own RCON (port 25581 — an early check mistakenly queried the human-world server's RCON instead and wrongly read 0 players). Profile loading, Matrix connection, and in-character `muse` replies all confirmed from real journal output. Found and fixed one real bug live: a named-arg command call the parser rejected was never fed back to the model (index.js 4.1.0, commit `1997a23`) |
| 8 | Re-baseline: after ~24h live, `tests/run.sh baseline --update` on dgx-spark, commit `tests/baselines/dgx-spark.json` | not started | | |

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-27 | Initial restart plan. |
| 1.1.0 | 2026-11-27 | Operator answered both §0 open questions: world gets reinitialized, archive path confirmed as proposed. Phase 1 marked done, Phase 2 started. |
| 1.2.0 | 2026-11-27 | Phase 2 file-placement review: resolved `router.js`/`equipment.js`/`arbiter.js` (all stay, none archived); found 10 more archive candidates missed in the original inventory (`agents/minecraft-*/PROMPT.md` + `agents/minecraft-common.md`); confirmed the benchmark-evaluation call in §6 with real evidence (`fleet_muse_contract`, `fleet_dispatch_routing`/`fleet_mc_intent` already cover the roles this restart touches) instead of leaving it conditional. |
| 1.3.0 | 2026-11-27 | Phase 2 executed: world reinitialized (fresh seed `53110123`, old world kept as `firmament-bots.bak-20261127181944`), standing gamerules reapplied, all 9 bot units confirmed stopped on both hosts ahead of Phase 3's archive move. |
| 1.4.0 | 2026-11-27 | Phase 3 executed: 92 files moved into `services/minecraft-bots-archive-11-2026/` (docs, goal/priority engine, role behavior, action library, persona prompts, plus the now-stale old `README.md`); wrote a fresh minimal `README.md` and `ARCHIVE_INDEX.md` in `services/minecraft-bots/`. Corrected §5's test-file assumption after discovering `tests/unit/*.test.mjs` is mixed by behavioral area, not split per source module — tests are excluded from this phase, deferred to Phase 6. |
| 1.5.0 | 2026-11-27 | Direct instruction to continue through to a restored, running system (Babs/Amy only) without a checkpoint. Phase 4 underway: ported `modes.js` and `commands.js` from Mindcraft, `skills.js`/`world.js` port in flight; wrote 9 `profile.json` personas + `agents/minecraft-common.json` from the archived PROMPT.md content. Found and fixed a real integration bug: `shelter.js`/`action-vocab.js` were wrongly archived — `pathfinding.js`/`swim-movements.js` depend on them — un-archived both as kept infra, `pathfinding.js` bumped to 1.4.1 to fix the resulting dead import. Recorded `arbiter.js`'s real `OWNERS` tier names (confirmed by reading the file, not memory). |
| 1.6.0 | 2026-11-27 | Phases 4-5 completed: `skills.js`/`world.js`/`mcdata.js` ported and syntax-verified; `index.js` fully rewritten (4.0.0) onto the new layer. Found and fixed a second wrongly-archived file (`faults.js` — generic crash/interval-error infra, no goal-engine dependency). Fixed a real bug in the ported `!stop` command (didn't actually interrupt a running skill's loop). Phase 6 (test coverage) deliberately deferred past the Phase 7 relaunch, tracked as an open gap rather than silently skipped. |
| 1.7.0 | 2026-11-27 | Phase 7 executed: Babs and Amy relaunched and confirmed live. Found and fixed one real bug from live traffic (index.js 4.1.0, commit `1997a23`): a command result was never fed back to the model, so a parse/arg error went unseen and uncorrected. Corrected a self-inflicted false alarm during verification — an early RCON check queried the human-world server (port 25575) instead of the bot-sandbox server (port 25581) and wrongly read 0 players online. |
