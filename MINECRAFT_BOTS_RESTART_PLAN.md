# Minecraft Bots Restart Plan

**Version:** 1.4.0
**Status:** Both §0 open questions answered by the operator 2026-11-27 — fresh world, archive path as
proposed. Executing Phase 2 onward.

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
  arbitration mechanism itself is still needed under any skill library, including the new one.

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
| 4 | Pull in Mindcraft's skill library, profile schema, and task schema; port skills into `actions/`, write the 9 persona profiles | not started | | |
| 5 | Rewrite `index.js` and `actions.js` to call the new layer; keep `pathfinding.js`, `swim-movements.js`, `buzz.js`, `matrix.js`, `roles.js`, `router.js`, `equipment.js`, `arbiter.js`, `run-bot.sh` unchanged | not started | | |
| 6 | Extract kept-infra test coverage (`arbiter.js`, `router.js`, others) from the mixed `tests/unit/*.test.mjs` files into their own dedicated files; archive what's left of those files; write fresh tests against the Mindcraft-based replacements; update `tests/README.md` | not started | | |
| 7 | Relaunch all 9 bot units (5 on dgx-spark, 4 on dgx-spark2); verify via RCON + Buzz/Matrix smoke checks | not started | | |
| 8 | Re-baseline: after ~24h live, `tests/run.sh baseline --update` on each host, commit `tests/baselines/<host>.json` | not started | | |

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-27 | Initial restart plan. |
| 1.1.0 | 2026-11-27 | Operator answered both §0 open questions: world gets reinitialized, archive path confirmed as proposed. Phase 1 marked done, Phase 2 started. |
| 1.2.0 | 2026-11-27 | Phase 2 file-placement review: resolved `router.js`/`equipment.js`/`arbiter.js` (all stay, none archived); found 10 more archive candidates missed in the original inventory (`agents/minecraft-*/PROMPT.md` + `agents/minecraft-common.md`); confirmed the benchmark-evaluation call in §6 with real evidence (`fleet_muse_contract`, `fleet_dispatch_routing`/`fleet_mc_intent` already cover the roles this restart touches) instead of leaving it conditional. |
| 1.3.0 | 2026-11-27 | Phase 2 executed: world reinitialized (fresh seed `53110123`, old world kept as `firmament-bots.bak-20261127181944`), standing gamerules reapplied, all 9 bot units confirmed stopped on both hosts ahead of Phase 3's archive move. |
| 1.4.0 | 2026-11-27 | Phase 3 executed: 92 files moved into `services/minecraft-bots-archive-11-2026/` (docs, goal/priority engine, role behavior, action library, persona prompts, plus the now-stale old `README.md`); wrote a fresh minimal `README.md` and `ARCHIVE_INDEX.md` in `services/minecraft-bots/`. Corrected §5's test-file assumption after discovering `tests/unit/*.test.mjs` is mixed by behavioral area, not split per source module — tests are excluded from this phase, deferred to Phase 6. |
