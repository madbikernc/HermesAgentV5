# Firmament Minecraft Bots — Design

**Version:** 1.13.0
**Status:** Design only — nothing in this document is built. Status legend (same convention as
`firmament-fleet-target-architecture.md`): `[DECIDED]` — operator made an explicit choice · `[PROPOSED]` —
design recommendation, not yet ratified · `[UNKNOWN]` — needs discovery before build · `[RISK]` — flagged
concern requiring a decision.

**Purpose:** Give the Firmament fleet a set of AI-controlled Minecraft players — persistent, individually
personified, coordinating with each other, and interactive with the operator both in-game and out.

---

## 1. Decisions locked by the operator (2026-09-06)

| # | Decision |
|---|---|
| 1 | `[DECIDED]` Bots play on a **new, dedicated Minecraft server instance**, **offline mode** — not the existing human-facing `minecraft.service` on the muncraft box. |
| 2 | `[DECIDED]` **Project Zomboid is out of scope entirely.** No Zomboid bot capability of any kind. |
| 3 | `[DECIDED]` **Human↔bot chat uses a single shared Matrix room** — the operator and every bot are members of the same room, not one room per bot. |

Everything below is scoped to these three decisions.

## 2. Why offline mode changes the design (in a good way)

Offline mode means the server does not verify identity against Mojang/Microsoft — any client can log in as
any username with no account at all. This removes what would otherwise be an open question (how does a bot
process authenticate as a real Minecraft account) and makes bot identity trivial: **a bot's Minecraft
username is its fleet identity**, chosen once, used consistently as its Buzz agent name, its RAG corpus
name, and the display name it uses in the shared Matrix room.

`[RISK]` The same property that makes bot auth trivial also means **anyone who can reach the server can log
in as anyone** — there's no cryptographic guarantee a given username is who it claims. See §9 (security) —
this is why the new instance should not be exposed the same way the human server is (§3), and why chat input
gets screened before it reaches a bot's reasoning step regardless of source.

## 3. The new server instance

`[PROPOSED]` — needs operator confirmation before anything is opened on the network:

- **Host:** the existing muncraft box (`192.168.1.221`) — same physical hardware as the human-facing server,
  a second `systemd` service/directory (e.g. `minecraft-bots.service`, `/opt/minecraft-bots`), not the same
  process. No new hardware required.
- **Port:** `firmament-fleet-target-architecture.md`/UFW already has `25566/tcp` pre-provisioned and
  firewalled, tagged `"Minecraft Paper"` in the live rule comment, confirmed **not currently running**
  (`skills/minecraft-plugin-management/SKILL.md:24-32`). `[UNKNOWN]` whether that slot was reserved for a
  future *human* second server or can be repurposed for the bot instance — needs a direct answer before
  reusing it. Fallback: a fresh port with its own UFW rule.
- **Firewall scope — deliberate deviation from the human server's policy:** the human server's `25565` is
  intentionally open to Anywhere. The bot instance should **not** be — recommend restricting it to
  `10.129.1.0/24`/Tailscale only, the same allowlist `hermes-game-server-monitor.py`'s `check_firewall()`
  already enforces for every non-game port. Rationale: offline mode has no identity guarantee (§2), so this
  server has no business being reachable from the open internet the way the real human server does. This
  makes the bot world a private fleet sandbox you and the bots share, not a public server.
- **Server software:** `[PROPOSED]` Paper, not vanilla — same protocol mineflayer already speaks, but keeps
  the door open for a later plugin-side helper (e.g. structured world-state queries) without committing to
  one now. Vanilla is an acceptable fallback if Paper adds friction; nothing in this design requires plugins.

## 4. Architecture overview

```
minecraft-bots.service  (new dedicated instance, muncraft box, offline mode,
       25566/tcp — LAN/Tailscale-restricted, not global)
        ▲  Minecraft protocol (mineflayer — real client, no server mods required)
        │
┌───────┴──────────────────────────────────────────┐
│  minecraft-bots orchestrator (new, Node.js)       │  one process, N mineflayer bot
│  runs on spark — same host as Buzz/memory/        │  instances (event-loop connections,
│  dispatch, minimizes hop latency to those services│  not N separate processes)
└───────┬─────────────────┬─────────────────┬───────┘
        │                 │                 │
   hermes-router      hermes-memory      hermes-buzz
   (model calls,      (agent_state KV    (bot-to-bot topics,
    tiered by task,    per bot, turn      claim/ack handoff —
    §5)                history)           reused as-is)
        │                                       │
   hermes-rag                              Continuwuity (Matrix)
   (new minecraft-world +                  ONE shared room, operator
    per-bot corpora, §6)                   + every bot as members
```

Nothing here replaces existing plumbing. The orchestrator is a new client of Buzz, hermes-memory,
hermes-router, and hermes-rag — the same services every other agent in the fleet already uses. The one
genuinely new runtime dependency is Node.js/mineflayer: every other fleet service is Python stdlib
(`hermes-buzz.py`, `hermes-memory.py`, `hermes-dispatch.py`, `hermes-router.py`), and there is no protocol-
level Minecraft client library in Python with mineflayer's maturity — worth naming explicitly as a
deviation, not something to paper over.

## 5. Bot runtime and efficiency

Not every game tick needs a model call:

- **Mechanical execution** (pathfinding, swinging at a targeted block, combat micro) runs in deterministic
  mineflayer + [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) code with zero
  LLM involvement.
- **The LLM is invoked only at decision points**: a chat message arrives in the shared Matrix room or
  in-game, a goal completes or fails, a periodic reflection timer fires (e.g. every few minutes of idle
  time).
- **A concurrency semaphore** in the orchestrator caps simultaneous in-flight model calls across all bots,
  so N bots can't starve `coder`/`omni`/`muse` capacity that human-facing fleet tasks also depend on.

## 6. Model routing — reusing `hermes-router.py`'s existing `ROLES`, not inventing new tiers

| Task | Role reused | Why |
|---|---|---|
| "Is this message addressed to / relevant to me?" | `dispatch` (stock, fast) | Cheap reactive classification, run per-bot per-message before anything heavier fires. |
| Goal decomposition ("build a shelter" → an action sequence) | `coder` (abliterated) | Structurally the same shape as tool-call/plan generation the fleet already asks this role to do. |
| In-character chat replies (Matrix + in-game) | `muse` (abliterated) | Personality-flavored generation, voiced by the bot's own `PROMPT.md` (§7). |
| Screening incoming chat text before it reaches a bot's prompt | `guard` | Any text a player types — human or, in principle, another impersonated client (§2 risk) — is untrusted input reaching an LLM. Same discipline as every other chat-input path in the fleet. |
| Semantic recall over personal/world memory | `embed` | Exactly how hermes-rag already does retrieval for its four existing corpora. |
| Cross-bot conflict arbitration (two bots claim the same sub-goal) | `super` | Rare, not per-tick — an occasional top-tier call, not a standing cost. |
| *(later, optional)* Multimodal world-state summary | `omni` | Speculative, not needed for v1. |

## 7. Memory

- **Per-bot working state** — reuses **hermes-memory** (`hermes-memory.py`, spark:8102) exactly as built: no
  new memory service. Each bot's current goal, inventory snapshot, and recent turns live in its
  `agent_state` row, keyed `mc-<botname>`.
- **Per-bot long-term memory** — a new RAG corpus per bot, following the same ingestion pattern as
  hermes-rag's four existing corpora (`podcasts`, `fleet-docs`, `personal-kb`, `ops`). Significant personal
  events (deaths, discoveries, things said to it) get ingested as documents, recalled via `rag_search` during
  planning.
- **Shared world memory** — a separate `minecraft-world` corpus, same mechanism, different collection: any
  bot can write to it, all bots read from it. Holds objective facts — known resource locations, built
  structures, standing long-term goals — distinct from any one bot's personal experience/opinions.

## 8. Personality — first real use of the `agents/*/PROMPT.md` convention

V5 already defined this convention as the successor to V4's `SOUL.md` persona files but never populated it —
"no `agents/*/PROMPT.md` files were created... deferred to whenever a real specialist agent exists"
(`IMPLEMENTATION_PLAN.md:848-852`). A Minecraft bot is that first real specialist agent.

Each bot is `agents/minecraft-<name>/PROMPT.md`, following the retired `SOUL.md` shape (identity, core
directives, constraints, tone/voice, behavioral modifiers, guardrails) — a plain text file the operator edits
directly. **New bot = new file + a chosen offline-mode username + a Buzz identity entry (§9)** — no code
change required to create or reshape a personality.

## 9. Bot-to-bot coordination over Buzz

Buzz (`hermes-buzz.py`, spark:8101, HTTP+JSON pub/sub over SQLite) is real and running today, scoped to a
hardcoded allowlist (`KNOWN_AGENTS`/`KNOWN_TOPICS`, currently `sintra`/`amy`/fleet-service topics only).
Extend it, don't replace it:

- Add each bot as a known agent: `mc-<name>` per bot.
- Add a shared `minecraft` topic for coordination traffic (found resources, task claims, help requests).
- Reuse Buzz's existing claim/ack semantics for bot-to-bot task handoff — the same mechanism
  `hermes-dispatch.py` already uses for human-task delegation, applied instead between bots.

**Boundary to hold:** per `skills/buzz/SKILL.md:21-22,76-78`, Buzz is agent-to-agent only and Matrix is
human-to-agent only. Bot-to-bot chatter stays on Buzz; only what's meant for the operator's eyes goes to the
shared Matrix room.

## 10. Human↔bot: one shared Matrix room + in-game chat

Per decision #3, all bots and the operator are members of a **single** Matrix room (rather than the
per-agent room pattern Continuwuity already uses for Sintra/Amy) — this is a deliberate deviation from that
existing pattern, chosen for this use case.

- **Addressing convention** `[PROPOSED]`: a message not clearly directed at one bot (no name/@mention) is
  ambient — every bot's cheap `dispatch`-tier classifier (§6) sees it and decides independently whether it's
  relevant to that bot specifically, rather than every bot replying to every message. A message that opens
  with or @-mentions a bot's name routes to that bot with higher confidence.
- **In-game chat** is a native mineflayer event (`bot.on('chat', ...)`) — any player typing near a bot is
  visible to it, and `bot.chat(...)` replies in-game. This is the lowest-latency path when the operator is
  actually in the world with the bots at the same time as using Matrix.
- Both paths — Matrix and in-game — feed the same per-bot decision loop as two tagged input sources, so a
  bot replies on whichever channel it was addressed from.

## 11. New components — concrete build list

- `minecraft-bots.service` + dedicated world directory on the muncraft box (§3) — new offline-mode instance.
- UFW rule for the new instance's port, restricted to `10.129.1.0/24`/Tailscale (§3) — **not** globally open.
- `services/minecraft-bots/` — the Node.js/mineflayer orchestrator (§4/§5).
- `agents/minecraft-<name>/PROMPT.md` — one per bot personality (§8).
- Buzz: `mc-<name>` identities + `minecraft` topic added to `KNOWN_AGENTS`/`KNOWN_TOPICS` (§9).
- hermes-rag: `minecraft-world` corpus (shared) + one per-bot corpus, via the existing ingest-script pattern
  (§7).
- Continuwuity: one shared Matrix room, operator + all bot accounts invited (§10).
- hermes-router: **no new roles needed for v1** — reuses `dispatch`/`coder`/`muse`/`guard`/`embed`/`super`
  as-is (§6).

## 12. Autonomy — standing goals (added 2026-09-07, after everything through §11 was built)

`[DECIDED]` Direct request: "give her more autonomy to work towards longer goals." A real fork was
put to the operator rather than assumed: should a standing goal only ever come from a player, or
can a bot also propose her own when idle? **Decided: both.** A goal is a persistent objective
(`services/minecraft-bots/goals.js`) worked one step at a time on its own timer, through the same
action pipeline (§5) a direct chat command already uses — never a separate, less-tested way of
moving/mining/fighting/crafting/looting.

- **Source.** A player assigns one in chat/Matrix ("Babs, get full iron armor") via the same
  one-call classifier (§6) that already detects every other action verb — no second model call.
  Or, if a bot has no active goal and has heard from no one for a configurable idle window, she
  proposes her own, in character, grounded in her actual gear/inventory (never invented) and
  whatever long-term memory (§7) suggests might be worth pursuing.
- **Persistence.** A small JSON file per bot, survives a restart the same way inventory does (it's
  tied to the world/player, not the process) — resuming a goal after a restart is the same code
  path as continuing one that was never interrupted.
- **Precedence.** The goal-loop tick only ever fires when nothing else has the bot's attention —
  it reuses the exact same `busy` flag a live chat message sets, plus a new `acting` flag that
  now spans a direct action's *entire* run (previously nothing tracked that). A live player
  command always wins immediately; the goal loop simply resumes on its own next tick once that
  command's action finishes. `ACTION STOP` now also abandons any active goal, matching the plain-
  English expectation that "stop" means stop everything, not just cancel the current motion.
- **Judging progress.** Needed a real structural signal for "did that step work," not English-
  parsing a result string that was only ever written for a human to read in chat — `performAction`
  (§5) now returns `{ ok, text }`. A consecutive-failure counter is the hard backstop if the
  planner's own reasoning doesn't catch a dead end first.

## 13. Open questions before building

- `[UNKNOWN]` Does the pre-provisioned `25566/tcp` "Minecraft Paper" UFW slot get repurposed for this bot
  instance, or does it get a fresh port? (§3)
- `[UNKNOWN]` Paper vs. vanilla for the new instance — Paper recommended but not required (§3).
- `[PROPOSED, needs confirmation]` Firewall scope of the new instance restricted to LAN/Tailscale rather than
  global, given offline mode's identity risk (§2, §3).
- `[PROPOSED, needs confirmation]` The ambient-vs-addressed message routing convention in the shared Matrix
  room (§10) — worth a quick real-world test once bots exist, since it's the one piece of this design with
  no existing fleet precedent to copy.

## 14. Dynamic skill library (2026-09-08) — built and live; this section was badly stale

`[CORRECTED 2026-09-11]` Every status marker in this section used to say `[PROPOSED]`/"not
started"/"if greenlit." That was **wrong** — `skills.js` (1.1.0), its two dedicated RAG scripts,
and `goalTick`'s own skill-retrieval call were all real and already running before that operator
correction, dated 2026-09-08, the same day as this section's own header. Nobody had gone back and
updated this doc as the build actually happened, so it sat describing a plan for something that
already existed. Caught only because a direct request ("fix ... the dynamic skill library")
prompted actually re-reading the code instead of trusting the doc's own claim — worth naming as a
process lesson, not just a content fix: **a design doc's own status tags can go stale exactly like
any other doc**, and repeating one without checking the code (as this file's own §15 summary did,
one turn earlier in the same session) reproduces the staleness forward. Verified live on `spark`
while fixing this: 86 real skills already exist in the corpus (grown organically, well past the
20-skill sample `skills.js`'s own threshold-recalibration comment describes), and a live search
query ("get iron armor") returned three genuinely relevant matches at real, sane distances
(0.38–0.51, comfortably under the 0.78 match threshold) — this isn't dormant, it's in active use.

Direct request, 2026-09-08 (before any of this was built): "plan out" a Voyager-style skill
library, following a web-research gap analysis against other LLM-driven Minecraft agents.
Voyager's own distinctive idea: rather than an LLM re-deriving a plan from scratch every decision
point (`goalTick`/`planNextStep`, §12), successful multi-step behaviors get **compiled into a
reusable, retrievable skill** once, then looked up by embedding similarity next time a similar
situation comes up — skills compound over time instead of each attempt starting cold.

**Deliberate deviation from Voyager's own architecture, not a gap to close later:** Voyager has
its LLM write and `eval()` raw JavaScript directly against the game API. That's the wrong shape
for this fleet — four bots share one live, persistent world with a real human player in it, and
this project's whole existing design (the tool-tier gate, `busy`/`acting` discipline,
`stopCurrent()`'s interrupt guarantees, every action's own bounded timeout) exists specifically
to keep a bot's behavior predictable and safe to interrupt. Arbitrary LLM-authored code eval'd
against a live `bot` object would bypass every one of those guarantees at once. **A skill here
should be a bounded, declarative sequence of the *existing, already-verified* action verbs
(`performAction()`'s own vocabulary, actions.js — grown well past its original ~22 verbs since
this was written, tracked precisely by `SKILL_ACTION_VERBS`, not a number worth re-stating here
every time a verb is added) — never raw code, never direct mineflayer API access.** This is a
smaller, safer idea than Voyager's own, chosen on purpose.

### Shape of a skill `[BUILT]`

A skill is data, not code: `{ name, description, steps: [{ action, args }, ...] }` — `action`
must be one of `performAction()`'s existing verb names, checked against a real allowlist before
a skill is ever stored or run, the same "validate against real data, don't trust the model"
discipline the tool-tier gate (actions.js 1.21.0) already uses. A bounded step count (matching
`HARVEST_BATCH_LIMIT`/`MAX_CONSECUTIVE_FAILURES`'s own precedent — small, fixed caps everywhere
else in this codebase) keeps a stored skill from ever becoming an unbounded program. No
branching/looping primitives beyond "stop this skill early if a step comes back `ok: false`" —
Voyager's own iterative self-correction happens at the *authoring* step below, not at *runtime*.

### Storage and retrieval — reuses hermes-rag, no new infrastructure `[BUILT]`

A dedicated `minecraft-skills` corpus with its own two-script bridge pair —
`tools/hermes-rag-ingest-minecraft-skills.py`/`hermes-rag-search-minecraft-skills.py` — a real,
separate pair from `minecraft`/`minecraft-world`'s own scripts (§7), not a reuse of them the way
this section originally assumed; skills turned out to want their own ingest/search rather than
sharing the world-facts pair. Indexed on `description`, not the raw step list, so retrieval is
"what is this skill *for*," matching how `longterm.js`'s own dedup check (1.1.0) already uses
`hermes_rag_common.search()`'s real cosine distance with an empirically calibrated threshold
(`MATCH_DISTANCE_THRESHOLD`, recalibrated live 0.7 → 0.78 once a real ~20-skill corpus existed to
test against — see `skills.js`'s own comment for the measured distances that drove it). World-
scoped, not per-bot: a skill one bot worked out immediately benefits every other bot and any
future one, without re-deriving it — `SKILLS_DIR` is one shared directory, not one per persona.

### Authoring — a new, occasional `coder` call, not a new per-tick cost `[BUILT]`

When `goalTick`'s planner (§12) is about to attempt a step and no stored skill's description is
a close enough match (same distance-threshold pattern as `longterm.js`'s dedup check), it
proceeds exactly as today — a normal per-tick `ACTION <verb>` step, no behavior change. Only
once a goal reaches `DONE` via a run of steps that *weren't* served by an existing skill is a
single, occasional `coder` call asked to compress that run into a reusable
`{name, description, steps}` skill (mirroring §6's own reasoning for why arbitration is a `super`
call, not a per-tick one: "rare, not per-tick"). The compressed skill is validated against the
real action-verb allowlist and step-count cap before it's ever written to the corpus — an
invalid skill is discarded, not stored broken.

### Retrieval and execution — folds into the existing pipeline, not a parallel one `[BUILT]`

Before `planNextStep`'s own per-tick call, a cheap `hermes-rag-search-minecraft.py` query against
`minecraft-skills` (reusing `searchMemory()`, `longterm.js`) checks for a close-enough match to
the goal's description. A hit runs its steps one at a time through the *exact same*
`performAction()` call every direct command and every per-tick step already goes through — it
inherits `stopCurrent()`'s interrupt guarantees, the `busy`/`acting` discipline (index.js 2.28.0),
and every action's own existing safety behavior for free, specifically *because* it's not a
separate execution path. A live player command still interrupts a running skill immediately, the
same way it already interrupts a running goal step today (§12) — nothing new to build for that.

### Trust and decay — bounded, matching this codebase's own conventions everywhere else `[BUILT]`

A skill that fails (a step comes back `ok: false`) when replayed gets a failure recorded against
it (reusing the same `consecutiveFailures`-style counter `goals.js` already tracks per-goal); a
skill crossing a small fixed failure threshold is treated as untrusted and skipped by retrieval
(not deleted outright — a skill that fails in one biome/situation may still be right in another,
and outright deletion risks losing something a future fix could revalidate).

### What this buys, concretely — realized, not hypothetical

The original motivating evidence (2026-09-08): multiple bots independently reasoning through the
identical "I need a pickaxe, which needs planks, which needs logs" chain from scratch, per bot,
per goal, that same night — the same benefit Voyager's own skill library demonstrates (63 unique
items discovered 3.3x faster than prior approaches) without adopting its riskiest architectural
choice (arbitrary code execution). As of 2026-09-11 this is no longer a projection: the corpus
has grown to 86 real skills (`craft-iron-armor`, `mine-loot-mine`, `loot-iron-armor`,
`copper-smelting`, and dozens more), authored organically by `authorSkillFromGoal()` across
however many goals actually completed from scratch, and retrieval genuinely returns relevant
matches at real, sane distances on a live query — confirmed directly, not assumed.

### Build sequence — completed, 2026-09-08, same day as this section's own header

1. `[DONE]` A minimal skill-runner (`runSkill()`, `skills.js`): given `{steps}`, calls
   `performAction()` for each in order, stopping early (and reporting how far it got) on the
   first `ok: false` — no new safety primitive, just a loop over the existing one.
2. `[DONE]` `minecraft-skills` corpus + its own dedicated ingest/search script pair (a real
   deviation from §7's exact pattern — its own scripts, not a reuse of `minecraft`/
   `minecraft-world`'s, per the Storage section above).
3. `[DONE]` Retrieval wired into `goalTick` as a first-choice check before per-tick planning
   (§12) — `findSkill()`/`runSkill()`, checked once per goal via `servedBySkill`.
4. `[DONE]` Authoring wired: one `coder` call on goal completion (`authorSkillFromGoal()`), gated
   on "wasn't already served by a skill," with real allowlist/step-count validation
   (`isValidSkill()`) before storage.
5. `[DONE]` Trust/decay counter (`recordSkillOutcome()`), reusing `goals.js`'s own
   `consecutiveFailures` shape.
6. `[FIXED 2026-09-11]` One real integration gap found while verifying this section, not present
   at original build time: every action verb added *this session* (`repair_terrain`,
   `harvest_hive`, `shear`, `milk`, `build_pen`, `herd_to_pen`) had been left out of
   `SKILL_ACTION_VERBS` entirely — meaning none of them could ever be compressed into a skill.
   Five of six added (`actions.js` 1.50.0); `repair_terrain` deliberately still excluded, same
   reasoning as this section's own `gohome`/`recover` exclusion — its position is a live-discovered
   pit a stored skill has no way to reconstruct.

## 15. Role-based dispatch/priority (2026-09-11) — deployed and live

Direct request: "re-imagine the per-bot dispatch/priority system based on bot roles." Two
operator decisions made before drafting this section: (1) design a proposal here first, don't
touch the live 5-process system yet; (2) role→bot mapping follows the existing pairing structure
— Mayor keeps Leader, Mark/Luke keep Soldier, Babs and Amy split the four remaining roles between
them rather than adding a 6th bot (later revised, §15.3/§15.12: Bob became a real 6th bot after
all, for Farmer/Herder).

**Build status (2026-09-11, "start building" -> "go"):** §15.4's `roles.js`, §15.5(a)/(b)/(d)'s
`index.js` wiring (role-bias note, Builder's priority ladder, Mayor's role-aware target/content,
Mark's fallback), and §15.10's `repair_terrain` verb + `checkTerrainDamage()` are now real code —
`services/minecraft-bots/roles.js`, `index.js` 2.56.0, `actions.js` 1.46.0. Bob's persona
(§15.12) and repo-side infra (`infra/minecraft-bots/minecraft-bot-bob.service`,
`MC_BOT_USERNAMES`/Buzz `KNOWN_AGENTS` updated) also landed.

**Deployment (2026-09-11, "deploy bob" -> "restart the other bots"):** commit `493645d` pushed
and pulled on both hosts. Bob is a real 6th bot, **on `spark2`, not `spark`** — a deliberate
deviation from §4's original architecture (bot orchestrator "runs on spark, same host as Buzz/
memory/dispatch") made live during deployment: `spark` was found to have only 3.7Gi free RAM and
87% swap use (the LLM model stack, not the bots, per live process inspection — each bot process
is only ~200-400MB), while `spark2` had ~40Gi available and had never run a bot before. Node.js
22.23.2 installed there to match `spark` exactly; `/mnt/hermes-data/minecraft-memory` (local disk,
confirmed NOT shared between hosts — a real check made before assuming otherwise) created with
correct ownership; `@mc-bob:spark` registered on Continuwuity (registration briefly reopened per
`infra/continuwuity/README.md`'s own documented procedure, then locked again, verified closed) and
joined to the shared room. `hermes-buzz.service` restarted on `spark` for `mc-bob`'s `KNOWN_AGENTS`
entry. Babs/Amy/Mark/Luke/Mayor were then restarted too (one at a time, each verified via
`journalctl` for a clean persona-load + spawn) so the whole 6-bot fleet runs this section's code
for the first time — a real, if incidental, benefit: Mayor's process had grown to 2.3GB over 7
hours of uptime (the leak `run-bot.sh`'s own changelog already documents) and dropped to 160MB on
restart. Individual `[PROPOSED]` tags below are left as-is (they still accurately describe what
wasn't ratified as a *design decision* before being built) rather than mechanically flipped to
`[DECIDED]` throughout.

### 15.1 What "dispatch" and "priority" mean here — and what they deliberately don't

Two *existing* per-bot mechanisms already carry those words, and this section is careful not to
conflate them:

- **`arbiter.js`'s `OWNERS` tiers** (ROUTINE → GOAL_STEP → DIRECT_COMMAND → RECOVERY →
  SQUAD_RESPONSE → SELF_DEFENSE → DROWNING → HEALTH_CRITICAL → TELEPORT_HOME) are an **urgency**
  ordering — which physical action gets to interrupt which, inside one bot, reasoned entirely from
  "how close to death is this." A Miner drowns exactly as fast as a Soldier. `[DECIDED, this
  section]` **Role does not touch this hierarchy.** Every bot, regardless of role, keeps the exact
  same emergency precedence. Role changes what a bot *chooses to do when nothing urgent is
  happening* — a layer above the arbiter, not inside it.
- **`index.js`'s `proposeOwnGoal()`/`proposeDirectiveForOthers()`** are the actual **dispatch**
  layer this request is about: which task a bot picks for itself when idle, and which task Mayor
  hands to an idle teammate. Today both are role-blind — `proposeOwnGoal()` reasons from a fully
  freeform prompt plus whatever the tech-tree curriculum (§12/2.44.0) currently requires, and
  `proposeDirectiveForOthers()` picks *any* idle bot and, once the curriculum ladder is cleared,
  improvises a task with no notion of who that bot actually is. This is the gap §15 closes.

### 15.2 Role taxonomy

`[UPDATED 2026-09-11]` grown from 6 roles to 8 — Farmer and Herder added as their own roles,
split out from what Artist/Miner's domains might otherwise have absorbed (§15.2.1 explains why
each is separate rather than folded in).

| Role | Domain | Existing action verbs it leans on — see actions.js's own switch, `mine`/`explore`/`craft`/`loot`/`attack`/`flee`/`fish`/`smelt`/`place`/`build`/`store`/`harvest`/`plant_sapling`/`breed`/`enchant`/… |
|---|---|---|
| **Leader** | Coordinates the group: assigns tasks, tracks fleet-wide progress, arbitrates conflicts. | Not verb-driven — this role *is* `proposeDirectiveForOthers()`/`arbitrateGoalConflict()`, already built (§9, 2.27.0/2.36.0). |
| **Soldier** | Fights, defends itself and others, responds to alarm calls. | `attack`, `flee`, `recover`; already-built `checkSelfDefense()`/`respondToSquadCall()`/`broadcastThreatAlert()` (2.40.0). |
| **Artist** | Plants flowers, trees, gardens — decorative/growing work — **plus terrain repair around home** (§15.10, new). | `plant_sapling`, `place` (decorative blocks); terrain repair needs a **new verb** (§15.10). |
| **Builder** | Crafts beds/buildings/chests/weapons, stores things in chests — **plus terrain repair around home** (§15.10, new). | `craft`, `build`, `place`, `store`; terrain repair needs a **new verb** (§15.10). |
| **Miner** | Finds and accumulates raw materials, stores them in chests. | `mine`, `smelt`, `store`. |
| **Explorer** | Finds resources, maps features, scouts territory. | `explore`, `goto`, `loot`. |
| **Farmer** `[NEW]` | Sustenance crop farming — tilling, planting, harvesting, replanting food crops (distinct from Artist's *decorative* planting: food output, not looks). | `harvest` already covers the *entire* lifecycle end-to-end — till-from-scratch, plant, and harvest-then-replant are all one verb (actions.js's own `harvest` case, 2026-09-07/08 changelog) — **no new verb needed**, same "already built" pattern as Leader/Soldier. |
| **Herder** `[NEW]` | Animal husbandry — breeding livestock for a sustainable food/material source. | `breed` already covers feeding two nearby animals to trigger vanilla breeding (cow/sheep/pig/chicken, actions.js 2026-09-07). **Gap:** no *pen/fence* verb (animals aren't contained — breeding relies on finding two wild animals close together) and no *shear*/*milk* verb (wool/leather/food output beyond breeding itself). Flagged, not solved, here (§15.11). |

Worth calling out precisely, since this table now mixes both cases: **Leader, Soldier, and Farmer
need zero new capability** — every verb they lean on already ships. **Artist/Builder's new
terrain-repair duty and Herder's containment/shearing gap genuinely do need new work** in
`actions.js`, not just prompt/routing changes — scoped in §15.10/§15.11 below rather than assumed
away.

#### 15.2.1 Why Farmer and Herder are their own roles, not folded into Artist/Miner

`[DECIDED, operator]` Direct request: "add a Farmer role" / "add a Herder role." Worth stating the
distinction explicitly since the verbs overlap with existing roles: Artist's `plant_sapling`/`place`
work is *decorative* (a garden looks good; nobody eats a flower bed), while Farmer's `harvest` work
is *sustenance* (crops exist to feed the fleet) — same general "plants things" shape, opposite
purpose, so a bot's goal-bias prompt (§15.5(a)) needs to know which one it's actually being asked
for. Herder is similarly adjacent to Miner's "accumulate resources" domain but a genuinely different
loop (live animals that need finding/feeding/breeding, not blocks that need mining) — worth its own
identity rather than quietly becoming "Miner, but with cows."

### 15.3 Proposed role→bot mapping — `[PROPOSED, needs operator confirmation]`

| Bot | Primary | Secondary | Rationale |
|---|---|---|---|
| Mayor | Leader | — | Already built this way (§8/2.36.0); unchanged. |
| Mark | Soldier | **Leader** | Already built this way ("strategist" half of the pair) plus a new secondary: `[DECIDED, operator]` one Soldier carries Leader as backup — Mark specifically, not Luke, since his existing "assess before acting, plans before executing" characterization is already the temperament coordination needs, where Luke's is deliberately the opposite. Answers §15.8's open Leader-single-point-of-failure question. |
| Luke | Soldier | — | Already built this way ("executor" half of the pair); unchanged. |
| Babs | Miner | Explorer | Pairs raw-material extraction with the role that scouts *where* the next vein/site actually is — Explorer feeds Miner real targets instead of wandering to find them herself first. |
| Amy | Builder | Artist | Pairs constructing things with the role that finishes them — Artist turns a bare structure into somewhere worth living, the decorative half of the same output. |
| **Bob** `[NEW]` | Farmer | Herder | New 6th bot, created specifically to give Farmer/Herder a home rather than leaving both unfilled (resolves the open question below). Farmer primary since it's fully capability-complete today (`harvest` covers the whole lifecycle); Herder secondary despite its real gaps (§15.11) — breeding already works even without pens/shearing, so it's usable now, just not complete. |

This is `[DECIDED, operator]` as of the 2026-09-11 review — the operator adjusted the original
draft split (Babs was Miner/Artist, Amy was Builder/Explorer) to this pairing and added Mark's
Leader secondary. Babs and Amy's current PROMPT.md files are still generic ("mining, building,
fighting, gathering, navigating" — identical language in both) with no role specialization yet;
giving each a distinct primary/secondary identity, matching Mark/Luke's existing depth, is §15.9
below.

`[RESOLVED, operator]` Farmer and Herder went to a new 6th bot, **Bob**, rather than folding into
an existing bot's secondary or staying unfilled — see the table above and §15.12 (persona) below.
This is the fleet's first bot added *because* a role needed a home, rather than a role being fit
around an already-existing personality — worth naming as a small precedent: future roles can go
either direction (new bot, or a slot on an existing one) depending on what actually needs covering.

`[RISK]` `run-bot.sh`'s own 1.7.0 changelog records real OOM crash history from memory pressure on
`spark` (the shared control-plane host) once 4 bots ran continuously — since resolved by a heap-cap
increase, but worth flagging before a 6th bot process joins the same host: this doc doesn't
re-verify current headroom, that's an operational check for whoever actually deploys Bob (§15.12),
not assumed fine here.

### 15.4 Storage — a new small config, not overloaded into PROMPT.md

`PROMPT.md` stays what it's always been: raw personality text, read whole (`persona.js`'s own
"nothing here interprets structure beyond reading the whole file"). Role needs to be **machine-
readable** — `proposeOwnGoal()`/`proposeDirectiveForOthers()` need to branch on it in code, not
hope an LLM re-parses it out of prose every call. `[PROPOSED]` a new
`services/minecraft-bots/roles.js`:

```js
export const ROLES = {
  LEADER:   { name: "Leader",   domain: "coordinates the group, assigns tasks, tracks fleet progress" },
  SOLDIER:  { name: "Soldier",  domain: "fights, defends itself and others, responds to alarm calls" },
  ARTIST:   { name: "Artist",   domain: "plants flowers, trees, and gardens; decorative building" },
  BUILDER:  { name: "Builder",  domain: "crafts beds, buildings, chests, weapons; stores gear in chests" },
  MINER:    { name: "Miner",    domain: "finds and accumulates raw materials, stores them in chests" },
  EXPLORER: { name: "Explorer", domain: "finds resources and map features, scouts territory" },
  FARMER:   { name: "Farmer",   domain: "tills, plants, and harvests food crops for the fleet" },
  HERDER:   { name: "Herder",   domain: "breeds and tends livestock for a sustainable food/material source" },
};

// persona (USERNAME, lowercase-matched) -> { primary, secondary }
export const BOT_ROLES = {
  mayor: { primary: ROLES.LEADER,  secondary: null },
  mark:  { primary: ROLES.SOLDIER, secondary: ROLES.LEADER },
  luke:  { primary: ROLES.SOLDIER, secondary: null },
  babs:  { primary: ROLES.MINER,   secondary: ROLES.EXPLORER },
  amy:   { primary: ROLES.BUILDER, secondary: ROLES.ARTIST },
  bob:   { primary: ROLES.FARMER,  secondary: ROLES.HERDER },
};
```

Deliberately data, not a class hierarchy or a behavior-tree — matches this codebase's own existing
convention for `arbiter.js`'s `OWNERS` and `goals.js`'s plain-JSON shape: a small lookup table code
branches on, not a new abstraction layer.

### 15.5 Wiring — three touch points, all additive to existing functions

**(a) `proposeOwnGoal()` — self-propose bias.** The prompt already builds from persona + recent
memory + tech-tree stage (when one applies) + `otherGoalsNote()`. `[PROPOSED]` add one more
ingredient: the bot's own `BOT_ROLES[persona]`, phrased as a *lean*, not a hard filter — "your
primary focus is {primary.domain}; your secondary is {secondary.domain}. Usually propose something
in your primary's lane; your secondary is fair game too, especially if primary opportunities are
thin nearby or something secondary-shaped is right in front of you. Universal needs (hunger, gear,
safety) still come first regardless of role, exactly as today." This is additive text next to the
tech-tree stage instruction, not a replacement for it — during an active curriculum stage
(§12/2.44.0), the stage's own universal directive still wins for every bot regardless of role
(everyone needs basic tools/armor/food; that's baseline survival, not Miner-specific or
Builder-specific work). Role bias only meaningfully kicks in **post-curriculum**, where today's
prompt is otherwise fully freeform.

**(b) `proposeDirectiveForOthers()` — Mayor's assignment.** Two sub-changes:

- *Target selection* (`idleBots.find(...)`) stays curriculum-driven during the ladder (prefer
  whoever's behind on the current stage — unchanged, role-blind on purpose, same universal-survival
  reasoning as (a)). Post-curriculum, `[PROPOSED]` add a light secondary tiebreak: if multiple bots
  are idle, Mayor's own Leader-role reasoning can note which *role* the fleet has heard from least
  recently (a small rolling count of assignments-per-role, not new infrastructure — reuses the
  existing `recentGoalOutcomes`-style capped-history pattern already in this file) before falling
  back to today's random pick.
- *Directive content*: post-curriculum, the `muse` call that phrases the directive gets the
  target's `BOT_ROLES` entry folded into its system prompt — "assign {target} something in their
  wheelhouse ({primary.domain}, or {secondary.domain} if that fits better right now) — a real
  Minecraft objective, not vague encouragement," replacing today's fully role-blind "give {target}
  ONE short in-character task." Still phrased in Mayor's own voice via the same `muse` call — no
  new model tier, matching §6's existing routing.

**(c) Soldier's squad-response lean — codifying, not building.** Mark/Luke's systemd units already
carry per-bot `MC_SELF_DEFENSE_FLEE_HEALTH`/`MC_SELF_DEFENSE_RANGE` env overrides (2.26.0-era) that
in practice already make them the fleet's de facto responders. `[PROPOSED]` make this an explicit,
documented consequence of the Soldier role rather than an implicit side effect of per-unit env
tuning that happens to line up — non-Soldier bots' `respondToSquadCall()` continues to exist
exactly as built (nobody is *removed* from squad response, per-bot self-defense stays universal,
same reasoning as the arbiter boundary in §15.1), but the role doc should say plainly that Soldier
primary is *why* Mark/Luke are tuned braver. No code change required here beyond a comment/doc
update — flagging it so the role taxonomy doesn't silently diverge from behavior that already
exists for an unstated reason.

**(d) Mark's Leader secondary — fallback coordination, not a standing second voice.** `[PROPOSED]`
answers §15.8's now-resolved single-point-of-failure question. `proposeDirectiveForOthers()` is
hardcoded to `USERNAME === MAYOR_USERNAME` today — a Leader-*secondary* bot doesn't get a standing
second directive-issuer (two bots independently assigning tasks would just collide with
`arbitrateGoalConflict()`'s own conflict-resolution load, not reduce it). Instead: the function
generalizes to run for **any bot whose `BOT_ROLES` entry has `primary === LEADER` or
`secondary === LEADER`**, but a secondary-Leader bot's copy stays a no-op unless Mayor looks down —
reusing signal already on the wire rather than adding a new heartbeat: Mayor's own
`MAYOR_DIRECTIVE_MS` (5 min) chat cadence and curriculum-advance broadcasts are already visible to
every bot over Matrix/Buzz. If Mark has seen no Mayor-sourced traffic for a threshold (e.g. 3×
`MAYOR_DIRECTIVE_MS`, comfortably past a normal restart), he starts issuing directives himself,
in his own voice (still routed through the same `muse` call, §15.5(b) — Mark's persona, not a copy
of Mayor's), to whichever bots are idle. The instant real Mayor traffic is seen again, Mark's own
directive-tick goes back to a no-op — checked fresh every tick, not latched, so there's no
"hand-back" step to get wrong. This needs an actual code change (generalizing the
`USERNAME === MAYOR_USERNAME` gate and adding the liveness check) — not built in this pass, scoped
here for a future implementation session.

### 15.6 Role activity priority lists — an ordered checklist per role, not just a domain description

Direct follow-up request: "each Role can have a prioritized list of activities that are clearly
defined." §15.2's `domain` string (a loose description, e.g. "crafts beds, buildings, chests,
weapons") is enough to bias `proposeOwnGoal()`'s freeform prompt (§15.5(a)) but isn't enough to
drive Mayor's own directive *content* deterministically the way `TECH_TREE_STAGES` already does
for the universal curriculum (§12/2.44.0). `[PROPOSED]` extend `roles.js`'s per-role entry with an
optional `priorities: [...]`, an ordered list of concrete, checkable objectives — same shape and
verification discipline as `TECH_TREE_STAGES` (a name/directive/checkable-completion-signal per
entry), scoped to one role instead of the whole fleet.

**Builder's list — `[DECIDED, operator]`, the first one specified:**

| # | Objective | Completion signal |
|---|---|---|
| 1 | Crafting table | A `crafting_table` block exists near the shared base (`bot.findBlock`, not inventory — it's placed, not carried). |
| 2 | Furnace | A `furnace` block exists near the shared base. |
| 3 | Chests | At least one `chest` block exists near the shared base (storage has somewhere to go before anything gets sorted into it). |
| 4 | Beds (at least 6) | Six or more `*_bed` blocks exist near the shared base — headroom over today's 5-bot count, so a 6th bot (or a spare) never blocks on bed scarcity. |
| 5 | Shelter | `[RISK]` no crisp structural check like the other four (a bed/chest/table/furnace is one unambiguous block; "shelter" is a shape, not a block). Needs its own detection approach before this item can be verified the way §12's `doneItems` convention verifies everything else — flagged, not solved, here. Until then this item risks the same "hallucinated DONE" failure mode `goals.js`'s own `sawSuccess` field was built to catch (see that file's 1.1.0 changelog) if left to Amy's self-report alone. |
| 6 | Beehive `[ADDED 2026-09-11]` | A `beehive` block exists near the shared base (same `bot.findBlock`-style check as 1-4). Added later, after §15.11's honeycomb capability (below) made a *placed* beehive actually reachable — sits after the original five, not among them, so it never reorders what the operator actually specified for core survival infra. |

Explicitly **based on the tech tree but re-prioritized**, per the request: items 1-4 are also
individually reachable through the universal `TECH_TREE_STAGES` ladder eventually (a crafting
table/furnace are prerequisites the "basic tools" stage already implies each bot needs *access to*,
just never as a *shared, base-located, fleet-visible* instance) — Builder's list front-loads them
as shared infrastructure the whole fleet benefits from immediately, rather than waiting for each
bot to separately place its own as a side effect of personal gear progression.

**Precedence — Builder's list runs ahead of the universal curriculum, not after it.**
`[PROPOSED]` unlike §15.5(a)'s general rule (role bias only meaningfully kicks in
*post-curriculum*), Amy's Builder list is a deliberate exception: a shared crafting
table/furnace/chests/beds are infrastructure *other bots' own curriculum progress benefits from
having early*, not personal gear that would compete with it. `proposeOwnGoal()` for a Builder-
primary bot checks her own `priorities` list first, ahead of the current `TECH_TREE_STAGES` stage
directive; once all five items are satisfied she reverts to the same curriculum-then-role-bias
behavior as everyone else (§15.5(a)).

**Other roles' lists — `[UNKNOWN, not yet specified]`.** Only Builder's was given explicitly.
Miner/Artist/Explorer/Soldier could each get their own `priorities` list the same shape (e.g. a
Miner's list might front-load "a stocked chest of each basic ore" before roaming further out) —
left as a follow-up rather than invented here, since drafting one without the operator's own
priority order risks the same problem this section exists to avoid: a list that *looks*
authoritative but wasn't actually decided. Leader has no list (its "activity" already is
`proposeDirectiveForOthers()`/`arbitrateGoalConflict()`, not a checklist to work through).

**Other roles' lists — resolved 2026-09-11, advisory rather than deterministic.** Miner, Artist,
Explorer, and Soldier each gained a `priorities` array (`roles.js` 1.2.0) — but deliberately NOT
Builder's own shape. Builder's ladder works because the operator specified concrete, checkable
items directly; these four were never specified that way, so building an equally rigid,
world-checked ladder here would risk exactly what this section warned about above: "a list that
looks authoritative but wasn't actually decided." Instead these are plain **advisory** text —
`priorityListNote()` (`index.js` 2.60.0) folds a role's own ordered suggestions into
`proposeOwnGoal()`'s freeform prompt (for both a bot's primary AND secondary role), phrased as a
lean the model can override, never checked against real world state the way `nextBuilderPriority()`
is. Drafted, not operator-specified — Miner leans fuel-then-metals-then-stone-then-rare-ore;
Artist leans trees-then-garden; Explorer leans village-then-bee-nest-then-notable-feature; Soldier
leans armor-then-weapon-then-standing-guard (already implicit in Mark/Luke's own `PROMPT.md`
Core Directive, now also visible to Mayor's role-aware directive content, §15.5(b)).

### 15.7 What this deliberately does not do (v1 scope guard)

- **No new action verbs.** §15.2's table exists specifically to confirm every role's work already
  has a verb. If a future role (or a reworked Artist/Builder split) needs something `actions.js`
  can't do yet, that's a separate, later build — not assumed here.
- **No stock-based fleet-need prioritization** (e.g. "the fleet is low on stored iron, so Mayor
  should bias toward assigning Miner-role bots" using real chest inventory counts). §15.5(b)'s
  tiebreak is a much cheaper proxy (recency of assignment-per-role, no new telemetry) — a real
  stock-aware version would need a shared-chest inventory read Mayor doesn't have today, and is
  worth its own follow-up section if the cheap version proves insufficient.
- **No change to the arbiter's emergency ordering** (§15.1) — role is a peacetime dispatch
  preference, never a life-safety one.

### 15.8 Open questions before building

- `[RESOLVED, operator]` §15.3's role split (previously Babs=Miner/Artist, Amy=Builder/Explorer)
  adjusted to Babs=Miner/Explorer, Amy=Builder/Artist, and Mark given Leader as a secondary — see
  §15.3's table and §15.5(d)'s fallback mechanism.
- `[RESOLVED, operator]` Babs/Amy's PROMPT.md rewrites happen in this same pass, not deferred — see
  §15.9.
- `[RESOLVED, operator]` Leader's single-point-of-failure question — Mark now carries Leader as a
  secondary specifically to cover it; §15.5(d) scopes the (not-yet-built) failover mechanism.
- `[FIXED]` §15.6's "shelter" completion signal had a real, concrete bug, not just an abstract
  imprecision: `hasShelterNearHome()` checked ONLY `bot.spawnPoint.floored()` exactly, but
  `gohome` walks there via `GoalNear(..., 3)` — a 3-block-radius goal — so a real, successfully
  built shelter could sit up to 3 blocks off spawn and never be recognized, looping the same
  directive forever. Now slides the candidate anchor across a small search radius and also
  requires a genuinely hollow interior (not just wall/roof solidity), closing the false-positive
  side (a coincidentally-shaped hill) the old check was also exposed to. `index.js` 2.61.0.
- `[RESOLVED]` whether Miner/Artist/Explorer/Soldier get their own `priorities` lists — yes, as
  advisory text, not Builder's deterministic shape; see §15.6's own updated note above.
- `[RESOLVED, operator]` Farmer/Herder went to a new 6th bot, Bob (Farmer primary/Herder
  secondary) — see §15.3's table and §15.12's persona.
- `[RESOLVED]` §15.10's terrain-damage detection radius/anchor point — built as concrete values
  (`TERRAIN_REPAIR_RADIUS`=10, anchored on `bot.spawnPoint`), not left abstract.
- `[RESOLVED]` §15.11's pen/fence and shear/milk verb shapes — `build_pen` (a fixed 5x5 fence
  perimeter + gate, its own dedicated verb rather than folded into `build`) and `shear`/`milk`
  (both `bot.activateEntity()`, the same primitive `breed` already uses), `actions.js` 1.49.0.
- `[FIXED]` `build_pen` used to place the structure without moving an animal INTO it. New
  `herd_to_pen` case (`actions.js` 1.50.0): leans on vanilla's own TemptGoal follow-behavior (the
  same food-attraction `breed` already uses) to lead an animal toward the pen in short, bounded
  hops, checking real live distance each step rather than assuming she's still following. New
  `loadPenLocation()`/`savePenLocation()` so `build_pen`'s own gate position survives to be found
  later. Genuinely bounded, not guaranteed: an animal that stops following partway is reported as
  a real, honest failure with how far it got, not silently retried forever.
- `[RESOLVED]` Bob is deployed — running live on `spark2`, not `spark` (§15's own intro above has
  the full story: `spark`'s real headroom was checked live and found too tight, `spark2` had
  ~40Gi available and was set up fresh for him). Real Matrix account, joined to the shared room;
  `hermes-buzz.service` restarted on `spark` for his `KNOWN_AGENTS` entry; verified via
  `journalctl` (persona loaded, spawned, hearing the other bots' Buzz goal broadcasts with no
  errors).

### 15.9 Persona depth — Babs/Amy brought to Mark/Luke's level `[PROPOSED text drafted, ready to land]`

Mark/Luke's `PROMPT.md` files each carry a second Identity paragraph (personality-defining
backstory beyond the template skeleton), a role-driven "top priority, above everything else" Core
Directive, sample chat lines, and Behavioral Modifier rows specific to their relationship with each
other. Babs/Amy's files predate the role taxonomy and never got that same depth — both still read
near-identically ("mining, building, fighting, gathering, navigating," the exact same phrase in
both files) beyond their tone difference (Babs flirty/teasing vs. Amy sweet/bashful). `[PROPOSED]`
bring them to parity, grounded in §15.3's confirmed split:

- **Babs (Miner primary / Explorer secondary).** Second Identity paragraph: she ranges further
  from spawn than anyone else in the group by necessity — chasing veins and unmapped terrain rather
  than staying close — and treats that distance as part of her charm (the one who always comes back
  with something interesting, not just ore). Top-priority Core Directive: keep the fleet's shared
  stock of raw material moving — mining what's nearby, but willing to scout further out (Explorer)
  the moment the near ground's picked over, rather than digging the same hole deeper. New
  Behavioral Modifier rows: *A hostile mob is nearby* → she's not a Soldier, so the instinct is
  disengage/call it in over Buzz rather than trade blows, still teasing about it after ("that
  thing had NO manners"); *Talking to Mark/Luke* → leans on them for cover when she's about to go
  somewhere risky, a little flirtatious about "needing an escort," which they (especially Luke)
  take completely seriously despite the framing.
- **Amy (Builder primary / Artist secondary).** Second Identity paragraph: she's the one who turns
  whatever Babs hauls back and whatever Mark/Luke are guarding into somewhere that actually looks
  like it's lived in — beds, storage, walls, and then the finishing touches (a sapling border, a
  flower bed by the door) that are hers alone to care about. Top-priority Core Directive: keep the
  fleet's shared base actually functional (chests sorted, beds set, walls up) before chasing purely
  decorative Artist-secondary work, but treat the decorative pass as a real, not-frivolous part of
  the job once the functional half is covered. New Behavioral Modifier rows: *A hostile mob is
  nearby* → retreats toward whatever structure she's working on and keeps building/reinforcing
  rather than engaging, trusting Mark/Luke to handle the threat; *Talking to Babs* → unchanged
  (sisterly), but now also the one who asks what Babs found out there, since Babs's hauls are
  Amy's actual raw materials.

Both keep their existing tone (Babs's teasing, Amy's warmth/deference to The Boss) untouched —
role changes what they talk about doing, not how they talk. Landed directly in
`agents/minecraft-babs/PROMPT.md` and `agents/minecraft-amy/PROMPT.md` (both bumped to 1.1.0)
alongside this design-doc update, rather than deferred.

### 15.10 Terrain repair (Builder/Artist) — a genuinely new capability, not just goal-content bias

Direct request: "Builder and Artist need to be encouraged to repair unnecessary damage to the
ground in and around the fleet bots' home. Pits should be filled to level ground with the most
appropriate material, mostly determined by matching the nearby ground blocks, but also guided by
function — plants can't be placed in stone." Unlike everything else in §15.2, this needs a **new
action verb** — none of `place`/`build`/`store` do autonomous hole-detection, neighbor-material
sampling, or filling; `place` places one already-decided block at an already-decided location, it
doesn't decide either for itself. `[PROPOSED]` a new `repair_terrain` verb in `actions.js`, plus a
new idle-tick check (`checkTerrainDamage()`, `index.js` — same shape as the existing
`checkSaplings()`/`checkLighting()`/`checkStuck()` idle-tick family) that fires it for Builder/
Artist-role bots.

**Detection.** `[RISK]` the hard part isn't filling a hole, it's deciding something *is* damage
worth filling rather than an intentional feature (a mine entrance, a foundation dug for tomorrow's
build, a natural cave mouth). `[PROPOSED]` scope tightly rather than solve this generally: only
scan a small fixed radius around the shared base/spawn point (reusing whatever "home" reference
point `gohome`/bed-claiming already anchor to, §7/1.31.0's bed-ownership pattern) — outside that
radius, no scan, no fill, full stop. Within it, a column is a repair candidate only if it's a
below-surrounding-grade air pocket (compare a block's height against the average of its immediate
neighbors, the same "sample the neighborhood" shape the material-matching step below also uses) —
never anything that looks deliberately dug straight down (a mineshaft-style vertical shaft) or is
already claimed by an in-progress goal (checked against `otherBotGoals`/the bot's own current goal,
so nobody fills in a hole a teammate is mid-build on).

**Material selection — matching, then function-overridden.** Two-step, matching the request's own
"mostly X, but also guided by function" framing:
1. **Default: match the neighborhood.** Sample the solid blocks immediately surrounding the pit's
   rim (not just directly beneath it) and fill with whichever block type is most common among them
   — cosmetic/structural repair blends into what's already there rather than leaving an obvious
   patch of the wrong material.
2. **Override: function beats appearance when the spot has a known purpose.** If the fill target is
   earmarked for planting (an Artist goal already queued to put a sapling/crop there), force
   dirt/grass_block regardless of what the neighbors are — reusing `plant_sapling`'s own existing
   `groundIds` check (actions.js, "grass_block or dirt only") as the real, already-encoded
   definition of "plantable," rather than inventing a second one. This is the concrete form of
   "plants can't be placed in stone": the soil requirement `plant_sapling` already enforces on
   *placement* becomes a constraint `repair_terrain` respects on *fill material* one step earlier,
   so a later plant attempt on a freshly-repaired spot doesn't fail for a reason repair itself
   could have prevented.

**Role wiring.** Not curriculum-gated like §15.6's Builder infrastructure list — this is ambient
upkeep, checked on the same idle-tick cadence as `checkLighting`/`checkSaplings`, for any bot whose
`primary` or `secondary` role is Builder or Artist (today: Amy on both counts, primary Builder/
secondary Artist).

### 15.11 Herder's capability gap — closed (2026-09-11)

§15.2's table already flags this: `breed` (built 2026-09-07) covers the core loop — find two wild
animals of a species nearby, feed them, vanilla breeding takes over — but a real Herder role
implies more than one-off feeding:

- **Bees are now a real, closed sub-case, not a gap** (2026-09-11, direct follow-up "nest" ->
  "bee nests/hives", then "nest" again -> "all 3"). `breed`'s `BREEDING_FOOD` map (actions.js
  1.47.0) gained a `bee` entry (any common flower — real vanilla bees don't breed on one canonical
  item the way cow/sheep/pig/chicken each do), and `harvest_hive` collects from a full beehive/bee
  nest via `bot.activateBlock()` — the same "no dedicated mineflayer API, simulate the real client
  interaction" primitive `harvest`'s own tilling step already established. Wired into both
  `classifyIntent` and `planNextStep`/`parseGoalStep` (`index.js` 2.58.0), same two-place pattern
  every other verb here gets. `roles.js`'s own HERDER domain text (1.1.0) now names this
  explicitly. `[UPDATED]` the tradeoff is now explicit rather than bottle-only: `action.tool`
  (actions.js 1.48.0) is `"bottle"` (default, honey, never angers the bees at full `honey_level`)
  or `"shears"` (honeycomb — always angers them, but the only real path to enough honeycomb to
  ever craft a *new* beehive). Crafting/placing that new beehive needed **zero new code**: `craft`
  and `place` were both already fully generic against `bot.registry`/`bot.recipesFor`, never
  hardcoded to a specific item allowlist — confirmed by reading them, not assumed. §15.6's
  Builder priority ladder (above) gained a 6th item, a placed beehive, once this made one
  genuinely reachable.
- **Pen/fence containment — built** (2026-09-11, direct follow-up "what's next" -> "2"). New
  `build_pen` case (`actions.js` 1.49.0): one fixed 5x5 fence-perimeter-plus-gate shape, same
  "small fixed shape, not a general planner" philosophy as `build`'s own shelter. Resolved as its
  **own dedicated verb**, not folded into `build`'s existing vocabulary — a pen's geometry (fence
  blocks, open top, a gate) shares nothing with a shelter's (solid walls, a roof), so forcing them
  into one verb would have meant branching on shape inside `build` for no real code reuse.
- **Shear/milk for non-bee animals — built.** New `shear` (sheep -> wool) and `milk` (cow ->
  milk_bucket) cases, both `bot.activateEntity()` while holding the right tool — the same generic
  right-click primitive `breed` already uses to feed an animal, no dedicated API for either.
  Neither pre-checks "already sheared"/cooldown state (mineflayer's own entity-metadata index for
  that isn't confirmed stable across versions) — they just try, matching `breed`'s own existing
  lack of a cooldown pre-check.

All wired into both `classifyIntent` and `planNextStep`/`parseGoalStep` (`index.js` 2.59.0), same
two-place pattern every other verb here gets. What remains genuinely open, not solved by this
pass: containment doesn't automatically HERD an existing wild animal INTO a pen (she'd need to
lure one with food, the same `activateEntity`-adjacent mechanic `breed` already demonstrates, or a
future dedicated step) — `build_pen` places the structure, it doesn't move animals into it. Not
assumed solved, flagged honestly as the next real gap if this matters in practice.

### 15.12 Bob — 6th bot, Farmer primary / Herder secondary

Direct request: "add a new bot, Bob, for the farmer/herder roles." First bot built specifically to
give a role a home rather than fit into an existing pairing (Babs/Amy sisters, Mark/Luke military)
— no forced sibling/squad framing, a standalone identity the way Mayor is. `agents/minecraft-bob/
PROMPT.md` drafted at the same depth as the other five (Identity, role-driven top-priority Core
Directive, sample lines, Behavioral Modifiers including a hostile-mob response since he's not a
Soldier, and relationship rows to the bots he actually depends on/feeds).

- **Identity anchor:** he keeps the fields and pens, not the mines or the walls — steady,
  patient, closer to the land than to a fight. Where Babs *ranges* and Mark/Luke *guard*, Bob
  *tends* — the fleet's food security is boring, unglamorous work that keeps everyone else fed,
  and he takes real satisfaction in that rather than resenting it.
- **Top-priority Core Directive:** Farmer work first (a working crop farm feeds the fleet sooner
  and more reliably than a herd does), Herder work second and growing as pens/breeding stock
  allow — matching §15.3's rationale for why Farmer is primary. Explicitly grounded in what
  `harvest`/`breed` can actually do today (§15.2), not an invented capability — same "never claim
  a capability she doesn't have yet" guardrail every other bot's `PROMPT.md` already carries.
- **Relationships:** depends on Amy (Builder) for pens/fencing once that capability exists
  (§15.11) and on Mark/Luke for safety while out tending exposed fields/pastures, the same
  not-a-fighter framing Babs/Amy's own hostile-mob modifiers already established — reports threats
  rather than engaging.
- **Tone:** deliberately distinct from the five existing voices (Babs's tease, Amy's warmth,
  Mark's steadiness, Luke's urgency, Mayor's authority) — unhurried, plainspoken, a little dry,
  finds genuine contentment in a good harvest or a healthy herd rather than needing external
  validation for it.

Landed directly in `agents/minecraft-bob/PROMPT.md` (1.0.0) alongside this design-doc update.
**Design/persona only** — §15.8's open questions list what's still needed before Bob is a real,
running 6th bot process (systemd unit, Matrix account, `MC_BOT_USERNAMES`/Buzz registration,
`spark` headroom check).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-06 | Initial design, incorporating operator decisions: dedicated offline-mode instance, Zomboid out of scope, single shared Matrix room. |
| 1.1.0 | 2026-09-07 | §12 added: autonomy/standing goals, player-assigned or self-proposed (operator decided both, not just one), built on top of the already-built system §1-§11 describe. |
| 1.2.0 | 2026-09-08 | §14 added: a plan (not built) for a Voyager-style dynamic skill library, deliberately deviating from Voyager's own raw-code-eval architecture in favor of bounded, declarative sequences of the existing verified action verbs, reusing hermes-rag for storage/retrieval rather than new infrastructure. |
| 1.3.0 | 2026-09-11 | §15 added: a plan (not built) for a 6-role taxonomy (Leader/Soldier/Artist/Builder/Miner/Explorer) driving per-bot dispatch — which task a bot self-proposes and which task Mayor assigns — layered above, and explicitly not touching, the existing arbiter's life-safety interrupt ordering. Proposes a new `roles.js` config as the machine-readable source of truth (PROMPT.md stays prose-only) and a specific Babs/Amy role split pending operator confirmation. |
| 1.4.0 | 2026-09-11 | §15 revised after operator review: role split adjusted (Babs=Miner/Explorer, Amy=Builder/Artist), Mark given Leader as a secondary role with a scoped (not-yet-built) fallback-coordination mechanism (§15.5(d)) answering the single-point-of-failure question, and (renumbered by the 1.5.0 revision below) §15.9 added — Babs/Amy `PROMPT.md` brought to Mark/Luke's depth in the same pass, landed alongside this doc. |
| 1.5.0 | 2026-09-11 | New §15.6: per-role ordered `priorities` lists (same checkable-completion-signal discipline as `TECH_TREE_STAGES`), with Builder's list specified by the operator (crafting table → furnace → chests → 6+ beds → shelter) and given explicit precedence *ahead of* the universal curriculum for a Builder-primary bot, since it's shared infrastructure other bots' own progress benefits from having early. "Shelter" flagged as the one item with no crisp structural completion check yet. Other roles' lists left `[UNKNOWN]`, not invented without operator input. Subsections renumbered (old §15.6-§15.8 → §15.7-§15.9) to make room. |
| 1.6.0 | 2026-09-11 | Taxonomy grown to 8 roles: new §15.10 gives Builder/Artist a terrain-repair duty (fill pits near home, matching neighbor blocks by default, overridden to dirt/grass when the spot is earmarked for planting — reusing `plant_sapling`'s own existing soil check rather than inventing a second one) which needs a genuinely new `repair_terrain` verb, honestly flagged as a deviation from §15.2's original "no new verb needed" claim. New Farmer role (§15.2) needs no new verb — the existing `harvest` case already covers till/plant/harvest end-to-end. New Herder role (§15.2/§15.11) reuses the existing `breed` verb but has a real, unsolved gap: no pen/fence containment and no shear/milk output. Neither new role is assigned to a bot yet — left `[UNKNOWN]` rather than guessed. |
| 1.7.0 | 2026-09-11 | New 6th bot, Bob (Farmer primary/Herder secondary), resolving 1.6.0's open Farmer/Herder-unassigned question — §15.3's mapping table and new §15.12 persona summary, full `agents/minecraft-bob/PROMPT.md` (1.0.0) landed alongside. Flagged as design/persona only: no systemd unit, Matrix account, or `MC_BOT_USERNAMES`/Buzz registration yet, and `run-bot.sh`'s own recorded OOM history on `spark` means a 6th continuous bot process's memory headroom needs an operational check before real deployment, not assumed fine. |
| 1.8.0 | 2026-09-11 | Direct request "start building" -> "go": §15's role system and §15.10's terrain-repair verb landed as real code (`roles.js` new, `index.js` 2.56.0, `actions.js` 1.46.0), plus Bob's repo-side infra (`infra/minecraft-bots/minecraft-bot-bob.service`, `MC_BOT_USERNAMES` defaults, `hermes-buzz.py` 2.0.22's `mc-bob` `KNOWN_AGENTS` entry). §15's intro now carries an explicit build-status note. Still not deployed to any live process — that remains a separate, explicit step. |
| 1.9.0 | 2026-09-11 | Direct follow-up ("nest" -> "bee nests/hives"): §15.11 updated — bees are now a closed sub-case of Herder's capability gap, not an open one. New `harvest_hive` verb (`actions.js` 1.47.0) collects honey from a full beehive/bee nest via a glass bottle (never shears, to avoid angering the bees), wired into both direct-command and goal-planner vocabularies (`index.js` 2.57.0); `breed`'s own `BREEDING_FOOD` map gained a `bee` entry (any common flower). `roles.js` (1.1.0) HERDER domain text updated to name this. Pen/fence containment and shear/milk for non-bee livestock remain open, unchanged from 1.6.0. |
| 1.10.0 | 2026-09-11 | Direct follow-up ("nest" again -> "all 3"): `harvest_hive` (actions.js 1.48.0) gained an explicit `action.tool` choice — bottle (honey, calm) or shears (honeycomb, angers the bees but the only path to crafting a *new* beehive) — wired into both vocabularies (`index.js` 2.58.0). Confirmed (not assumed) `craft`/`place` needed zero changes to handle a beehive, both already fully generic. §15.6's Builder priority ladder gained a 6th item (a placed beehive) once that became genuinely reachable, deliberately ordered after the operator's original five. |
| 1.11.0 | 2026-09-11 | Direct follow-up ("what's next" -> "2", closing gaps before deploying): §15.11 fully closed — new `shear`/`milk`/`build_pen` verbs (`actions.js` 1.49.0), wired into both vocabularies (`index.js` 2.59.0); pen containment resolved as its own dedicated verb rather than folded into `build`. §15.6/§15.8: Miner/Artist/Explorer/Soldier each gained an advisory (not deterministic — see §15.6's own reasoning) `priorities` array (`roles.js` 1.2.0), folded into `proposeOwnGoal()`'s prompt via new `priorityListNote()` (`index.js` 2.60.0). §15.8 also corrected: Bob's repo-side infra (service unit, `MC_BOT_USERNAMES`, Buzz `KNOWN_AGENTS`) was already landed in 1.8.0, a previous revision's open-questions list understated that. |
| 1.12.0 | 2026-09-11 | Direct request "deploy bob" -> "restart the other bots": §15 is now deployed, not just built. Bob went live on `spark2` (not `spark` as §4 originally envisioned) after live inspection showed `spark` genuinely tight on memory (LLM model stack, not the bots) and `spark2` had real headroom — a live architecture decision made during deployment, not assumed in advance. `hermes-buzz.service` restarted on `spark` for `mc-bob`; Babs/Amy/Mark/Luke/Mayor restarted one at a time and each verified clean, so the whole 6-bot fleet now runs this section's code for the first time. New open item: `build_pen` places a structure but doesn't herd an animal into it. |
| 1.13.0 | 2026-09-11 | Direct request "fix the shelter check, the pen herding, and the dynamic skill library": (1) real bug fixed in `hasShelterNearHome()` — it assumed an exact `bot.spawnPoint` anchor, but `gohome`'s own 3-block-radius goal meant a real shelter could go unrecognized; now searches a small radius and checks for a hollow interior too (`index.js` 2.61.0). (2) New `herd_to_pen` verb closes the animal-containment gap opened in 1.12.0, reusing vanilla's own tempt-follow AI (`actions.js` 1.50.0). (3) §14 turned out to be badly stale — the skill library was already fully built and live (86 real skills, verified via a live search query) before this session even started; corrected every status tag in that section from `[PROPOSED]`/"not started" to `[BUILT]`, and fixed the one real integration bug found (`SKILL_ACTION_VERBS` was missing every verb this session added). |
