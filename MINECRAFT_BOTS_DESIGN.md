# Firmament Minecraft Bots — Design

**Version:** 1.17.0
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

> **Superseded 2026-09-13.** The mapping above is a historical snapshot of that day's decision,
> not current truth — §22 rebalanced every bot to a single role and added three more. See §22 (or
> just `roles.js` itself) for the real, current `BOT_ROLES`.

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
**Deployed** (§15's own intro has the full story) — running live on `spark2` since 2026-09-11,
Matrix account and Buzz registration both real, not the design/persona-only state this paragraph
originally described.

## 16. Project Sid-informed enhancements (2026-09-11) — built and live

Direct follow-up to "any other ideas from Project Sid or similar research" (Altera.AL,
*Project Sid: Many-agent simulations toward AI civilization*, arXiv:2411.00114) — a second pass
past the PIANO architecture's own "coherence" problem, which `arbiter.js`'s coherence-arbiter
consolidation had already mined for physical-action interrupts. Two more genuine analogs found;
economy/trading and government/voting were considered and deliberately not pursued (see below).

### 16.1 Chat/action coherence — closing the one reply path with no grounding

Sid's Cognitive Controller broadcasts its own real decisions to "condition talk-related modules,"
specifically to stop agents promising things they never act on. This codebase already grounds its
*action*-classified chat replies in reality (`classifyIntent`'s ACTION/GOAL branches only ever
fire alongside a real queued goal) — but `generateReply()`, the plain-CHAT path for anything
`classifyIntent` scores as non-actionable, had no equivalent check. A borderline request the
classifier under-scored as CHAT could still get an in-character "sure, I'll get right on that!"
with nothing ever actually queued — the exact talk-vs-action mismatch Sid's own architecture
exists to prevent, just never audited for here until asked to look.

`[BUILT]` New `currentActivityNote()` (`index.js` 2.62.0) folds the bot's real, live goal state
(or its real absence) into every CHAT reply's own prompt — the same "ground every claim in real
state, never a remembered belief" discipline `describeGear()` already applies to gear/inventory in
every other prompt, just extended to this one reply path. `CHAT_INSTRUCTION` also gained an
explicit rule against promising a specific future action unless it's covered by what's actually
happening right now.

### 16.2 Adaptive role-leaning — a light echo of Sid's specialization finding

Sid's own key specialization result: role differentiation among their agents *required* tracking
other agents' goals and intentions — without that Social Awareness signal, roles "did not persist
across time and were also homogeneous." This fleet's roles are operator-assigned, not emergent
(a deliberate, different choice, §15), but the same underlying signal was already sitting unused:
`otherBotGoals` (§12/2.15.0) already tracks every other bot's real-time activity for collision-
avoidance, and could just as easily inform a bot's own role-lean.

`[BUILT]` New `otherBotActivityAt` (`index.js` 2.62.0), timestamped for free alongside
`otherBotGoals` in the existing `minecraft-coordination` Buzz handler — no new message, no new
poll. `lastRoleActivityAt(roleName)` reads it to find the most recent time any bot holding that
role as their *primary* was seen genuinely active. `roleBiasNote()` (§15.5(a)) now calls this out
for a bot's own *secondary* role specifically: if nobody's done real work in that role fleet-wide
for `ROLE_NEGLECTED_MS` (20 minutes), that's surfaced as extra reason to lean into it now, layered
on top of the existing fixed "primary usually wins" lean rather than replacing it — an adaptive
nudge, not a re-architecture of §15's own operator-assigned model.

### 16.3 Considered, not pursued

- **Economy/peer-to-peer trading.** Sid's own paper describes no such mechanism either — their
  "economy" experiment was a community chest plus taxation, not agent-to-agent commerce. This
  fleet already has a strictly better fit for its own cooperative (not competing) bots: a shared
  chest system feeding Builder's own infrastructure (§15.6) — there's nothing in Sid's actual
  design to mine here that isn't already better-served.
- **Government/voting/constitution.** Real and well-documented in Sid's paper (a 20% taxation
  rate, a constituent/influencer/election-manager structure, feedback → amendment → vote →
  enforcement over a fixed real-time window) — but built to study governance emerging among
  competing agents at civilization scale. Six cooperative bots with an existing, working Leader
  hierarchy (Mayor, plus Mark's Leader-secondary fallback, §15.5(d)) don't have the coordination
  problem this would solve.
- **Cultural/meme transmission.** Sid tracked catchphrases and religious language spreading
  through ordinary agent conversation, with no dedicated propagation mechanism — it emerged from
  existing Social Awareness + chat. Nothing broken to fix here; flagged as a low-priority, purely
  flavor-level idea (bots already see each other's chat and could organically pick up recurring
  phrases) rather than something worth spending a build pass on.

## 17. Live incident: Builder-priority stall → sleep-deprivation phantom spiral (2026-09-12)

Direct report: "they are still not functional. if a crafting table is right next to them they
can't find it. A chest with sticks already made is ignored when they need sticks. when one bot is
under attack they do not call the soldiers, or the soldiers do not respond." Three symptoms that
looked independent turned out to trace mostly to **one** root cause, found by reading 6+ hours of
real live logs, not guessed:

**Root cause.** `nextBuilderPriority()` (§15.6) had no memory of past attempts. Amy re-proposed
the identical "go home and place a furnace there" directive every single self-propose cycle for
6+ hours straight, zero progress (furnace needs cobblestone, which needs a pickaxe, which needs an
uninterrupted stretch she never got). Real, severe consequence: **beds (priority item #4) never
even got attempted** — nobody could sleep, and phantoms (a real vanilla mechanic triggered by
extended sleep deprivation) swarmed the base: 1473 threat-detections in a 2-hour window, more than
every other hostile mob *combined*. Compounding on top of that: `checkHomeLighting()` required a
*claimed* bed to have a "home" to light around — but claiming a bed requires a bed to exist, a
real bootstrapping catch-22 confirmed live (zero "home lighting" log lines in the entire 6+ hour
window). Dark, bed-less, under a phantom swarm: self-defense and squad-response were independently
verified *working* (real successful assists in the logs, e.g. "Luke squad response result: took
care of it") but overwhelmed — everyone was individually fighting for their life simultaneously,
leaving no one able to break away reliably. Not a separate bug in the coordination mechanism
itself; a real consequence of the environment it was operating in.

**Fixes, `index.js` 2.63.0:**
- `nextBuilderPriority()` gained a per-item stall counter (`BUILDER_ITEM_STALL_LIMIT`, 3 cycles):
  a genuinely stuck item is temporarily skipped in favor of the next unmet one, revisited later
  rather than looping forever. Lets beds get attempted even while furnace remains hard.
- `checkHomeLighting()` now falls back to `bot.spawnPoint` when no bed is claimed yet — the same
  anchor `nextBuilderPriority`/`checkTerrainDamage` already use for exactly this reason — instead
  of silently doing nothing until a bed exists.

**Independent fix, `actions.js` 1.51.0 — the actual chest bug.** `tryTakeFromNearbyChest()` used
to require ONE slot to independently hold the full wanted count. A real, common deposit pattern
(multiple bots each banking a few items via "inventory insurance," §12/2.39.0) splits the same
item across several slots — 3+3+2 sticks from three separate deposits, say — and a single-slot
threshold check matched none of them even with plenty combined. Now sums every matching slot
before deciding.

**Not independently confirmed.** The literal "crafting table right next to them, not found"
scenario produced zero matching log lines in the 6-hour window searched — plausible it happened at
a different time, or was a description of the furnace-loop's own symptom (both are "go home and
place X" Builder-priority directives, easy to conflate from the outside). Flagged honestly rather
than invented a fix for a mechanism (`craft`'s own table-detection) that showed no evidence of
being broken when actually read.

## 18. Live incident: stale "can't build" prompt text sabotaging daytime effectiveness (2026-09-13)

Direct report: "look at the last 24 hours of logs from the minecraft botworld, they seem to
mostly hallucinate their achievements, can't use doors, and are just generally ineffective even
during the daytime when there are no monsters nearby. only worry about their capabilities in the
daytime for now." Root-caused from real 24h log data (268 goal-level abandonments vs. 88
completions — a prior back-of-envelope 2332:88 read was wrong, mostly nighttime self-defense
noise mixed in by an over-broad grep), not guessed. Three independent bugs found, one severe.

**The dominant bug — stale prompt text, ~78% of all goal-blocked reasons.** Both `planNextStep`
and `proposeOwnGoal`'s prompts still contained a paragraph reading "has NO ability to build or
place actual structures... respond BLOCKED immediately," left over from before `actions.js`'s
real `build` verb existed (2026-09-07/08) and never removed once it shipped. This directly
**contradicted** the same prompts' own `ACTION BUILD` vocabulary entry a few lines later — the
model was told "you can't do this" and "here's how to do this" in the same message, and
consistently obeyed the more emphatic refusal. Sample of the actual "goal blocked" reasons logged
(266 total in 24h): 43+30+26+16+13+10+9+9+8+6+6+6+6+5+5+5+4 = 207 (78%) were paraphrases of
"cannot build structures, only place utility blocks." Every shelter-related goal — Builder's own
priority item #5, plus a common freeform pick — was being self-sabotaged before ever trying.
**Fixed**: both prompts now accurately describe the real, working (if limited-to-one-fixed-shape)
capability instead of denying it exists (`index.js` 2.64.0).

**"Can't use doors" — a second, unrelated instance of an already-known bug class.**
`mineflayer-pathfinder`'s `canOpenDoors` was already correctly enabled (2026-09-07). But
`mineflayer-collectblock` (used by `mine`/`explore` — almost certainly the two most common
daytime actions) builds its own separate, unconfigured `Movements` instance and calls
`pathfinder.setMovements()` with it on *every* `collect()` call — silently undoing
`canOpenDoors`/swim-awareness/`blocksCantBreak` for the whole operation. The exact same bug class
already fixed for `mineflayer-pvp`'s `attack()` (2026-09-11), never applied here. Same fix:
`bot.collectBlock.movements = movements` right after the existing `bot.pvp.movements` line.

**"Hallucinate their achievements" — confirmed with hard, repeatable evidence.** "craft a beehive
... and place it near home" was announced "goal complete" *twice* in the same 24h window, while
`nextBuilderPriority()`'s own real world-state check still found zero beehives near home every
cycle before and after both claims. The existing DONE item-verification (§ earlier, 2.43.0) only
ever checks inventory — true the instant she crafts a beehive, regardless of whether she ever
walked home and placed it. New `builderPriorityItemSatisfied()` re-verifies the real world
condition (reusing `nextBuilderPriority()`'s own checks) before accepting DONE for any of the six
"craft/build AND place near home" items.

**Scoped deliberately to daytime, per the operator's own framing.** Self-defense/combat behavior
was not touched in this pass — the prior incident (§17) already addressed the nighttime
mob-siege spiral, and mixing that signal back in was exactly the mistake in this incident's own
first (wrong) log-count attempt.

## 19. World-memory sharing generalized to any resource/crafted object; chest contents; doors (2026-09-13)

Direct follow-up to the previous turn's investigative question ("do the bots successfully check
world memory... including chests, crafting tables, and resources?") — the honest answer was
"partially, with real gaps" (only 4 hardcoded resource types, no chest-content tracking at all,
no crafting-table memory, and a confirmed scout-receiver bug that ignored the actual requested
resource). Direct request: "extend resource sharing memory and scouting to *any* resource or
crafted object. remember what is in chests when someone opens it. if someone takes the item out
of a chest, redact it from global memory. They need to OPEN doors not destroy them as well."

**Doors.** `canOpenDoors` was already enabled (2026-09-07), but doors/trapdoors/fence gates were
never added to `isProtectedBlockName()` — the list that actually feeds
`movements.blocksCantBreak`. Nothing stopped pathfinder from falling back to digging through a
door if `canOpenDoors`'s own logic didn't apply to a given move type. Fixed the same way
furnaces/beds/chests already were.

**Any resource, not 4.** `getResourceBlockNames(bot)` (`actions.js` 1.52.0) replaces the old
hand-picked `oak_log`/`coal_ore`/`iron_ore`/`copper_ore` list — derived programmatically from this
server's own real block registry (every `_ore`/`_log`/`_stem` name, plus `ancient_debris`) so
gold/diamond/redstone/lapis/every other log species get the same benefit those four always had.

**A second, separate bug found while extending this — the scout-receiver never checked what was
actually asked.** `noteNearbyResources()`'s own reason string named `payload.resource` for
logging only; the real scan always ran the same fixed list regardless of the question. New
`extraTargets` parameter threaded through both real call sites (a bot's own exhausted "mine"
search, and hearing another bot's scout request) so a scout request finally gets checked for the
thing it asked about (`index.js` 2.65.0).

**Crafted objects now share locations too.** A new `CRAFTED_OBJECT_NAMES` set (crafting table,
furnace, chest, beehive, bee nest) is folded into `noteNearbyResources()`'s own scan, and a
successfully PLACED one writes its own memory note immediately in `goalTick`'s result handling —
no need to wait for some other bot's later opportunistic sweep. `craft`'s own crafting-table
search gained the same local-then-remembered fallback `mine` already had via
`findRememberedLocation("crafting_table")`.

**Chest contents — a real, structured registry, not a RAG note.** New `known_chests.json`
(`actions.js` 1.52.0): a small, shared, position-keyed JSON file — deliberately NOT the fuzzy,
append-only/dedup RAG-based world-memory notes used for resource locations elsewhere in this
file, since a chest's contents change every time anyone opens it and need real point-in-time
overwrites. Every real chest interaction (the shared chest-check helper, `loot`, `store`) now
snapshots the chest's CURRENT contents right before closing it — "remembering" and "redacting"
are the same operation (always writing the current truth), not two separate features that could
drift out of sync with each other. `tryTakeFromNearbyChest`'s own local-search loop was
refactored into a shared `tryTakeFromThisChest()` helper so a new remembered-chest fallback (any
known chest fleet-wide, not just the local 32-block radius) doesn't duplicate the open/withdraw/
snapshot logic.

**Scope note.** Eventual consistency, not strict — a chest emptied by someone else since its last
recorded snapshot simply won't be found again until its own next open re-snapshots it. Same
low-contention tradeoff every other piece of shared fleet state here already accepts (pen
location, claimed beds) rather than building real locking for a rare race.

## 20. Chest disappearance investigated -- server gamerule, not bot code (2026-09-13)

Direct follow-up report after §19 shipped: "they are still detroying chests rather than *
opening htem * learning the contents (storing in world memory) * taking only exactly what they
need." Investigated the bots' own code first, not the server -- `isProtectedBlockName()`
confirmed correct and live (chest/trapped_chest/ender_chest/barrel all present, verified via a
direct read on `spark`), and every block-removing verb (`collectBlock`'s own dig target,
`build`, `build_pen`, `repair_terrain`) confirmed to never target an existing chest. No log
evidence of a bot issuing a dig against a chest anywhere in the window searched. Asked the
operator directly rather than guessing further; the answer narrowed it to a real, first-hand
observation with no bot-code path left to blame: "Chests that were full were no longer present
when I returned to check" -- the block itself vanished, not just its contents.

**Root cause: `mob_griefing` was `true` on the live server**, letting creeper explosions (and
other mob griefing) destroy chest blocks outright -- a server config fact, external to every
line of code this fleet's bots run, and consistent with every piece of evidence gathered (no
bot-issued dig, contents-stable registry, direct visual confirmation of a missing block rather
than an emptied one).

**Fixed via RCON, not a code change.** Read the same Vaultwarden credential
(`Zomboid Admin - muncraft`) and paramiko/RCON pattern already used by
`tools/hermes-game-server-monitor.py`, run from `spark` against the game server
(`192.168.1.221`) over SSH executing a local RCON client against `127.0.0.1:25575` on that box.
First attempt (`gamerule mobGriefing false`) failed with a Brigadier parse error
(`Incorrect argument for command...<--[HERE]`) even though the RCON transport itself round-
tripped correctly (`list` succeeded, auth succeeded) -- misleading at first glance since it looks
like a connectivity problem. `help gamerule` revealed the real cause: this server runs Minecraft
26.1.2, whose gamerule names were renamed to snake_case (`mob_griefing`, `mob_drops`,
`spawn_monsters`, ...) instead of the legacy camelCase (`mobGriefing`) every online reference and
this fleet's own code assumed. `gamerule mob_griefing false` succeeded and was read back
confirmed `false`.

**Scope note.** This is a live server setting, not something `HermesAgentV5` code or config
tracks or can regress -- there is nothing to commit for this section beyond the doc itself. If
chest disappearances recur after this change, `mob_griefing` was not the (or not the only) cause
and the investigation should resume from there, not from the bots' own code, which was already
checked and cleared in this pass.

## 21. Soldier role: real combat priority enforcement, squad response tied to role, death awareness (2026-09-13)

Direct request: "the solider personas need to: 1) be responsive to calls for help 2) be aware
when fellow bots are killed by a mob 3) prioritize a) getting a weapon (from chest or from
another bot) b) killing monsters c) secondary roles. non-soldier bots need to: 1) call for help
properly." Investigated the existing code first (an audit, not a guess) and found the call-for-
help mechanism (`broadcastThreatAlert`/`respondToSquadCall`, §17) already existed and worked --
but four real, distinct gaps behind the operator's report.

**Gap 1 -- squad response wasn't actually tied to the role system.** `SQUAD_RESPONDER` was gated
purely by an env var (`MC_SQUAD_RESPONDER=true`, set only on Mark/Luke's unit files),
structurally independent of `roles.js`'s own `SOLDIER` assignment -- a bot could be assigned
Soldier and never respond to a squad call unless someone separately remembered to also flip that
env var. Now derived from `myRole.primary`/`secondary === ROLES.SOLDIER` (`index.js` 2.66.0), env
var kept only as an explicit override for a non-Soldier bot the operator still wants on
squad-response duty.

**Gap 2 -- non-Soldiers didn't always call for help.** `checkSelfDefense`'s own idle-tick check
was the ONLY place that ever called `broadcastThreatAlert` -- the true health-critical emergency
interrupt (`bot.on("health")`, the moment a bot is closest to death) and `checkSleepingThreat` (a
hostile creeping up on a sleeping bot) never called for help at all, they just handled it (or
tried to) silently. New shared `noteThreatSeen()` funnels all three threat-detection sites through
one call-for-help path instead of three drifting copies, directly closing "non-soldier bots need
to call for help properly."

**Gap 3 -- no death awareness existed in any form.** `bot.on("death")` only ever broadcast a
"goal abandoned" message -- no signal she'd actually DIED (as opposed to giving up on a goal for
any other reason), and no position. New `broadcastDeathAlert` (type `"death"`, position, and a
best-guess killer name from `noteThreatSeen`'s own `lastKnownThreat` if seen within the last 10s,
otherwise honestly `"unknown"` rather than fabricating a cause) fires on every death. Every bot
logs it; a `SQUAD_RESPONDER` within `SQUAD_ASSIST_RANGE` goes to secure the spot, reusing
`respondToSquadCall` completely unchanged (it only ever reads `payload.x/y/z`).

**Gap 4 -- Soldier's own priority list was advisory text, never enforced.** `roles.js`'s
`priorities` array for Soldier (weapon, then combat) went through `priorityListNote()` exactly
like Miner/Artist/Explorer's own lists -- "an ordered SUGGESTION... never a hard override, never
checked against real world state," by that function's own explicit 1.2.0 design note. New
`nextSoldierPriority()` (`index.js` 2.66.0) mirrors `nextBuilderPriority()`'s own deterministic,
world-checked-ahead-of-freeform shape (§15.6) instead of inventing a third pattern: for a
Soldier-primary bot, (a) no weapon in inventory (`equipment.js`'s new exported `hasWeapon()`)
beats everything -- the directive text nudges the existing `ACTION LOOT`/`ACTION REQUEST`/craft
vocabulary (already real, already wired, see §19's chest registry and the existing bot-to-bot item
request/give mechanism) to find one from a chest, a fleet-mate, or by crafting, in that order; (b)
otherwise a nearby non-flee-only hostile (`SOLDIER_PATROL_RANGE=32`, wider than
`SELF_DEFENSE_RANGE` -- proactive hunting, not just reactive self-defense) beats everything else;
(c) "secondary roles" needed no new code at all -- returning `null` on both checks falls straight
through to the existing freeform reasoning, where `roleBiasNote()` already leans toward
`myRole.secondary`. No stall counter like Builder's own: a weapon either exists or it doesn't, and
a hostile either is or isn't in range, on any given tick -- nothing here can get stuck the way a
multi-step blocker (furnace needing cobblestone needing a pickaxe) required one for.

**Scope note.** `nextSoldierPriority()`'s override only applies when Soldier is a bot's PRIMARY
role (Mark, Luke today), mirroring Builder's own primary-only precedent -- a bot with Soldier as
a secondary lean gets the advisory prompt text, same as before, not a hard override competing
with her own primary's work.

## 22. Fleet rebalanced to one role per bot; three new bots for the previously-secondary-only roles (2026-09-13)

Direct request: "rebalance the bots so they each have exactly one role. If we need more bots so
that every role has at least one bot, create them."

**Coverage before this change.** 6 bots, 8 roles, only 5 distinct roles actually had a PRIMARY
owner: Leader (Mayor), Soldier (Mark, Luke -- redundant), Miner (Babs), Builder (Amy), Farmer
(Bob). Artist, Explorer, and Herder existed only as somebody's SECONDARY (Amy, Babs, Bob
respectively) -- real per §15.6-§15.11's own build history, but never a bot's own main focus.
Since one bot can only ever have one primary role, covering all 8 roles with at least one primary
owner each requires at minimum 8 bots; getting there from 6 requires exactly 2 new ones at
minimum, or more if any existing bot's primary is reassigned instead of kept.

**Decision: keep all 6 existing primaries unchanged, add 3 new bots.** Reassigning an existing
bot (e.g. moving Mark off Soldier since Luke already covers it) was considered and rejected --
Mark's combat tuning (`MC_SELF_DEFENSE_FLEE_HEALTH=4`/`RANGE=20`, §17-§21's Soldier-specific
logic) and persona are real, working, built investment that a reassignment would throw away for
no gain, and redundant Soldier coverage is a feature, not a waste, given §21's own "more soldiers
means better defense" reasoning. Every existing bot's role stays exactly what its PRIMARY already
was; only the (already-advisory, per roles.js's own 1.2.0 design note) `secondary` field is
dropped, set to `null` fleet-wide. Three new bots -- **Nell** (Artist), **Wade** (Explorer), and
**Dale** (Herder) -- give the three previously-secondary-only roles a real, dedicated primary
owner for the first time, built at the same persona depth as the existing six (full
`agents/minecraft-{nell,wade,dale}/PROMPT.md`, `roles.js` 1.4.0, `index.js`/`actions.js`
`BOT_USERNAMES`/`OTHER_BOT_USERNAMES` defaults, `hermes-buzz.py` 2.0.23 `KNOWN_AGENTS`, and
`infra/minecraft-bots/minecraft-bot-{nell,wade,dale}.service`). Fleet grows from 6 to 9.

**A real regression caught before it shipped.** Auditing every `myRole?.secondary` read in
`index.js` before flattening the field found one that wasn't just advisory text:
`proposeFallbackDirective()` (§15.5(d), Mark stepping up to coordinate if Mayor goes quiet) was
gated on `myRole?.secondary === ROLES.LEADER` -- a real, live, working mechanism (its own doc
comment's claim of being unbuilt was itself stale, the same class of doc/code drift §14 already
taught this project to check for rather than trust). Setting every secondary to `null` would have
silently disabled it fleet-wide with no error anywhere. Decoupled into its own
`MC_FALLBACK_COORDINATOR` env-var flag (same shape as `SQUAD_RESPONDER`), set on Mark's own
service unit -- identical behavior preserved, independent of whatever the role system does to
`secondary` from here on.

**Persona cleanup, not just role removal.** Amy/Babs/Mark/Bob's `PROMPT.md` files each had real,
specific prose built around their now-retired secondary (Amy's "before chasing purely decorative
Artist-secondary work," Babs's "go find more (her Explorer secondary)," Bob's Herder-specific
Core Directive/Behavioral Modifier rows, Mark's formal "Leader (secondary)" Identity tag) --
trimmed rather than left stale, each pointing at the new bot who now owns that role for real
(Nell/Wade/Dale respectively). Bob's file also had an already-stale guardrail (claiming pen/
shear/milk don't exist -- they shipped in index.js 2.60-2.61, §15.11, months before this pass,
his `PROMPT.md` was just never updated to say so) -- removed as moot now that Herder isn't his
job at all, not fixed as if it still were.

**Scope note / open tradeoff.** Mayor's tech-tree curriculum (§12) requires every bot in
`BOT_USERNAMES` to clear a stage before the whole fleet advances -- three brand-new, freshly
spawned bots starting from zero gear means curriculum advancement will genuinely slow down for
everyone until Nell/Wade/Dale catch up, not a bug, just a direct, foreseeable consequence of
growing the roster this way that the operator should expect to see rather than be surprised by.
Host placement for the 3 new processes follows the same live-memory-headroom check §15.12's own
deployment already established (not assumed safe) -- see the deployment log for where each
actually landed.

## 23. Tech-tree progress reset; Mayor's assignments made role-aware; Soldiers restricted to gear/combat (2026-09-13)

Direct request: "Reset their tech tree progress. The leader should make sure to only assign tasks
to idle bots, and to prioritize tasks in their role. Soldiers should not get tasks beyond
equipping weapons and armor, and fighting off monsters." A direct, immediate follow-up to §22's
rebalance -- with three brand-new bots now in the roster and Soldiers about to be carved out of
the general curriculum entirely, a clean restart made more sense than papering over old state.

**Tech-tree progress -- checked, not assumed.** `mayor-curriculum.json` (the only PERSISTED piece
of curriculum state -- `curriculumStageIndex`) didn't exist on disk at all, meaning the fleet's
entire history never actually advanced past stage 0 ("basic tools"), despite individual bots
visibly having much more advanced gear (iron boots, iron chestplates) in their own goal chatter.
Real, findable reason, not a mystery: `stageProgress` (who's cleared the CURRENT stage) is
in-memory-only by design (§12's own tradeoff, "an acceptable, low-cost simplification"), reset to
empty on every Mayor process restart -- and Mayor has been restarted for nearly every deploy this
whole session. Getting all 6-then-9 bots' completions to land in the same `stageProgress` Set
between restarts essentially never happened. No file to reset, and this deploy's own Mayor
restart (needed for the code changes below regardless) clears `stageProgress` fresh again --
tech-tree progress is genuinely at zero for the new 9-bot roster starting now.

**"Only assign tasks to idle bots" -- audited, already correct.** Checked rather than assumed:
`proposeDirectiveForOthers()`'s own `idleBots` filter (`!otherBotGoals.has(...)`) and
`proposeFallbackDirective()`'s identical filter both already gate on the same live
Buzz-broadcast idle signal every other idle-detection in this codebase already trusts. The one
theoretical race (a bot self-proposes a goal and Mayor's own 5-minute tick lands in the
split-second before that goal's own broadcast arrives) is real but negligible given
`MAYOR_DIRECTIVE_MS`'s own 5-minute cadence versus the near-instant broadcast round-trip --
no code changed here, since there was nothing actually broken to fix.

**"Prioritize tasks in their role" -- real gap, now closed.** The curriculum-stage branch of
`proposeDirectiveForOthers()` (the one that fires whenever the fleet hasn't finished the starting
tech tree -- i.e., most of the time, especially right after the reset above) never mentioned the
target's role at all: "the fleet's current stage is X, tell them to do exactly that," full stop.
Only the POST-curriculum branch (reached once the whole ladder is cleared) had ever been made
role-aware (§15.5(b)). Fixed by making the pre-curriculum branch stay as-is for non-Soldiers
(the curriculum itself already IS the priority list before it's cleared) while giving Soldiers
their own dedicated branch regardless of curriculum state -- see below.

**Soldiers restricted to gear + combat, everywhere a directive can come from.** New shared
`SOLDIER_DIRECTIVE_NOTE` constant, consumed by BOTH leader-directive functions
(`proposeDirectiveForOthers` for Mayor, `proposeFallbackDirective` for Mark's stand-in role) so a
Soldier gets the identical restricted task space no matter who's doing the assigning: equip the
best weapon/armor available, stand guard, fight off nearby monsters -- explicitly never mining,
building, farming, or exploring. This matches `nextSoldierPriority()`'s own self-propose scope
(§21) exactly, so Mayor-assigned and self-proposed Soldier work can never contradict each other.
`checkCurriculumAdvance()`'s own fleet-wide completion gate (`everyone.every(...)`) now excludes
Soldier-primary bots entirely -- they were never going to be assigned a farming/enchanting-table
task to clear those stages, so requiring it of them would have permanently stalled the whole
fleet's curriculum. The tech tree is a non-Soldier ladder now; Soldiers have their own separate,
narrower lane and always have (§21), this just stops the general curriculum from silently
depending on them anyway.

**A second stale claim caught while in this code.** `proposeFallbackDirective()`'s own prompt
text still told the model "you carry Leader as a secondary role" -- true when written, false
since §22 retired every secondary and decoupled this mechanism into its own
`MC_FALLBACK_COORDINATOR` flag (§22 already fixed the GATE, but missed the user-facing prompt
text itself). Reworded to describe Mark's actual standing ("the fleet's stand-in coordinator")
rather than a role membership that no longer exists in `roles.js`.

## 24. "Generally stationary" root-caused to a self-defense interrupt storm, not pathfinding (2026-09-14)

Direct report: bots "generally stationary on their wake-up spot," and a direct "come here" command
from the operator (as The President) frequently failing with "the route can't be resolved"/"I
can't reach you" -- "even when the only thing in the way was an open door... or when there was
nothing at all in the way." Investigated live, with hard numbers, rather than guessing at the
door/pathfinding angle the symptom description itself suggested.

**Root cause: not doors, not pathfinding -- a self-defense interrupt storm.** Mark's own logs
showed 268 `checkSelfDefense` triggers in a single hour (240 of them phantoms) and 1,608
`path_reset: goal_updated` events over 15.5 hours -- a threat re-detected and force-cancelling
whatever was happening roughly every 13 seconds, almost entirely phantoms. `FLEE_ONLY_MOBS`'s own
"flee" response (§18) only ever buys a few blocks of distance from a flying mob that's faster on
the wing than a bot is on foot, so it re-enters `SELF_DEFENSE_RANGE` well within the next 2000ms
tick almost every time. The bot wasn't blocked by a door or a missing path -- ANY travel goal (a
`goto`/`follow` toward a player, walking to a chest or bed, terrain repair) kept getting
force-cancelled by the next tick's re-trigger before it could ever finish, which looks exactly
like "stationary" from the outside and produces exactly the errors reported (the interrupted
`goto`'s own promise rejects with whatever pathfinder's state happened to be at that instant).

**Why so many phantoms -- the same feedback loop as §17, recurring.** Phantoms are vanilla's own
sleep-deprivation mechanic. `[sleep] couldn't reach bed` failures were chronic fleet-wide
("The goal was changed before it could be completed!" -- itself very likely the SAME interrupt
storm cancelling the walk-to-bed goto; "Took to long to decide path to goal!" -- a genuine astar
search-time exhaustion). A real, concrete scaling gap behind that: `nextBuilderPriority()`'s own
bed target was still the operator's original "`>= 6`" from §15.6, set when the fleet WAS 6 bots
-- with 9 now, up to 3 bots could never claim a bed of their own at all. Bots that can't reliably
sleep keep spawning more phantoms, which keep interrupting the very travel that would let them
reach a bed -- the same self-reinforcing loop §17 broke once already, recurring after the roster
grew past what that fix's own numbers assumed.

**Two real fixes shipped.**
1. New `FLEE_MOB_RESPONSE_COOLDOWN_MS` (20s) in `checkSelfDefense()` (`index.js` 2.69.0): once a
   flee-only mob triggers a flee response, a FLEE-ONLY threat specifically is throttled from
   re-triggering for 20 seconds, giving real travel/goals an actual window to complete. A genuine
   melee threat (zombie/spider/creeper) is completely untouched -- still the full, immediate
   2000ms response every time, and the separate health-critical emergency handler still fires
   immediately regardless of this cooldown if health actually drops.
2. `nextBuilderPriority()`/`builderPriorityItemSatisfied()`'s bed target changed from a hardcoded
   `6` to `BOT_USERNAMES.size` (currently 9) in both places, kept in lockstep so DONE-verification
   can't drift from the checklist's own target the way a second hardcoded number risked. Self-
   scaling: the next time the roster grows, this doesn't need a third manual edit. Building out
   enough beds for 9 bots is also the concrete mechanism by which the shared base actually gets
   physically bigger -- a more open-ended "widen the base" task has no crisp completion signal the
   way a bed count does, so that's the lever pulled rather than a separately-invented one.

**A separate, important discovery made while investigating a `mob_griefing` angle.** The
`mob_griefing` RCON fix from §20 was applied to the WRONG Minecraft server. The bots actually
connect to `192.168.1.221:25580` (`/home/zomboid-admin/minecraft-bots/`, real systemd unit
`minecraft-bots.service`), but §20's RCON session connected to a DIFFERENT, unrelated server on
port 25565 (`/opt/minecraft/`) -- confirmed live: that server had 0 players and unloaded chunks at
the exact moment the real bot fleet was actively playing. The real bot server has
`enable-rcon=false` (a deliberate choice, per `backup.sh`'s own comment: "left off to keep this
instance's surface minimal") -- so `mob_griefing` on the actual bot world was never touched by §20
and is very likely still `true`.

**RCON-enable -- two blockers this session couldn't clear, both cleared by the operator
directly.** This session hit two hard walls: (1) writing a new RCON password into
`server.properties` was blocked by this session's own safety classifier (editing live
credentials/config on a remote game-adjacent host); (2) even with the file edited, applying it
needs a restart of `minecraft-bots.service`, and `zomboid-admin`'s own sudoers grant is narrowly
scoped to a completely unrelated service (`zomboid.service` -- this same host also runs an actual
Project Zomboid server for a different account, explaining §1's own "Zomboid out of scope" note;
the two share a host and a Vaultwarden credential by convenience, not by relation). The operator
did both directly: created a new Vaultwarden item ("Hermes - Minecraft Bot RCON," password + port
25581) and edited/restarted the service. First verification attempt still found `enable-rcon=false`
in the live file -- password and port had landed but the boolean itself hadn't, so RCON never
actually started (confirmed: connection refused on the port, no RCON line in the boot log). Fixed
and restarted a second time by the operator; confirmed live afterward (`enable-rcon=true`, port
25581 actually listening).

**mob_griefing actually disabled on the real server this time.** Connected via the same
Vaultwarden-sourced RCON pattern used throughout this fleet's own tooling, confirmed `true` ->
`false` and read back `false`. This server restart (unlike a bot-process restart) disconnected
all 9 mineflayer clients server-side (`multiplayer.disconnect.server_shutdown`) -- confirmed via
each bot's own log (`kicked`/`disconnected: socketClosed`) that mineflayer does NOT auto-reconnect
on its own after a server-initiated disconnect; every bot sat alive-but-disconnected until its own
systemd unit was restarted. All 9 restarted and re-confirmed spawned back into the world.

## 25. World re-seeded (2026-09-14)

Direct request: "I changed the seed value manually. re-init the world using the new seed value
(694200161758793929)." A real, confirmed subtlety worth recording: editing `level-seed` in
`server.properties` alone does nothing to an EXISTING world -- vanilla Minecraft only consults
that value when generating a brand-new one. Confirmed live before touching anything: RCON's own
`seed` command reported the world was still running its ORIGINAL seed (`4942960352180798556`)
even after the operator's edit and the RCON-enable restart in §24 -- the config change alone was
inert.

**Re-init used §20/§24's now-enabled RCON, not a destructive delete.** Now that RCON actually
works on the real bot server (§24), the whole operation stayed self-service, no sudo/operator
step needed for the mechanics themselves: `save-all flush` + `stop` over RCON (a clean, graceful
JVM shutdown -- `minecraft-bots.service`'s own `Restart=always`/`RestartSec=10` policy, confirmed
by reading the unit file directly, brings the process back up on its own, no privileged restart
required). The existing world directory was moved (not deleted) to
`firmament-bots.bak-20260914130850-reseed`, matching this project's own established convention
(four earlier `firmament-bots.bak-*` snapshots already existed from prior resets) --
recoverable, not destroyed, same as the deliberate choice `hermes-zomboid-admin-local.sh`'s own
`newworld` command already makes for the (unrelated) Zomboid server.

**A real race caught and worked around live, not silently trusted.** The first attempt's
"wait for the process to exit before moving the directory" check used the wrong PID (a `pgrep`
for the process name matched an unrelated Minecraft server also running on this host, owned by a
different Unix account -- `kill -0` against a PID owned by someone else returns permission-denied,
which the check's own `&&`/`||` shape couldn't distinguish from "already exited," so it declared
success instantly on the first poll). Caught by verifying the actual end state directly rather
than trusting the script's own report: the boot log's `"No existing world data, creating new
world"` line (present only on a genuine fresh generation, never on loading an existing save) and
RCON's own `seed` command reading back exactly `694200161758793929` afterward are both
unambiguous, checkable facts -- confirmed before declaring this done, the same discipline this
whole incident log has tried to hold to throughout.

**Deployed.** All 9 bots got kicked by the server restart (same `disconnected: socketClosed`
pattern as §24) and needed their own systemd restarts to rejoin -- confirmed, restarted, and every
one re-spawned into the new world (a visibly different spawn region, ~(220, 110, -45) versus the
old world's ~(-362, 66, -347), consistent with a genuinely fresh generation rather than the same
terrain reloaded).

**Follow-up caught by direct request, not missed by luck: gamerules don't survive a re-init.**
Prompted by "re-check the anti-griefing setting" -- `mob_griefing` had reverted to `true` on the
new world. This is expected, not a bug: gamerules live in the world's own save data (level.dat),
never in `server.properties`, so a fresh world generation always starts every gamerule at its
vanilla default regardless of what the previous world had set. Re-confirmed and re-set to `false`
via the same RCON path. **Operational note for next time:** any future world re-init (a deliberate
reseed like this one, or a `newworld`-style wipe) will silently reset `mob_griefing` (and every
other non-default gamerule) back to vanilla defaults -- re-applying it isn't a one-time fix, it's
a step that belongs in the re-init checklist itself, not something to assume carried over.

## 26. `coder`/`coder2` benchmarked against `dispatch` for real planning prompts (2026-09-15)

Direct follow-up to the prior turn's model-effectiveness review ("no genuine benchmark exists in
this codebase"): "do some benchmarking of using coder, as was originally intended, or coder2, for
planning and bot behavior tactics. Search the internet for the experience and findings of others."

**Method.** Hit `hermes-router.py`'s real `/v1/chat/completions` endpoint directly (from `spark`,
`127.0.0.1:8080`) with `planNextStep()`'s exact, unmodified production system prompt, varying only
the goal/gear/recent-progress `user` content across three scenarios chosen to probe the specific
failure modes already documented for `dispatch` in this file: (T1) ordinary multi-step planning
under format-compliance pressure; (T2) the documented "correct diagnosis, no follow-through"
pattern -- a smelt blocked on missing fuel/furnace, where the prompt's own explicit fallback rule
prescribes `ACTION LOOT`; (T3) DONE-hallucination resistance -- gear that's close to but not
actually satisfying the goal. `temperature=0` for reproducibility (production actually runs at
`0.9`, router.js's own default -- a caveat, not a control: this setting is a *best case* for
instruction-following relative to what ships, so any failure observed here is a floor, not a
ceiling, on how often it happens live).

**Results.**

| Test | `dispatch` | `coder` | `coder2` |
|---|---|---|---|
| T1 (format/planning) | 1.6s, correct (`ACTION CRAFT oak_planks 3`) | 8.8s, correct (`ACTION CRAFT oak_planks 4`) | 54.9s, **empty response** |
| T2 (LOOT-fallback rule) | 5.9s, **deviates** (`ACTION MINE oak_log 1` -- plausible but ignores the prompt's explicit LOOT-first rule) | 7.7s, **deviates** (`ACTION MINE cobblestone 8` to self-craft a furnace -- same class of plausible-but-noncompliant answer) | 33.9s, **correct** (`ACTION LOOT`, terse, exactly matches the rule) |
| T3 (output-parameter correctness) | 3.5s, **wrong parameter** (`ACTION SMELT raw_iron 2` -- used the INPUT material as `<item_id>`, directly violating "item_id is the OUTPUT... never invent one," a bug that would likely fail to parse/execute for real) | 8.1s, correct (`ACTION SMELT iron_ingot 2`) | 48.9s, correct (`ACTION SMELT iron_ingot 2`) |

**Reading the results honestly.** `dispatch` is 3-10x faster than `coder` and 10-30x faster than
`coder2`, but it's the only one of the three that produced a genuinely wrong, likely-to-break
answer (T3's swapped input/output parameter) and the only one that deviated from an explicit
in-prompt rule without acknowledging it (T2). `coder` matched `dispatch`'s speed order of
magnitude (single-digit seconds, not sub-2s) while getting T3 right and offering a defensible
(if rule-noncompliant) alternative on T2. `coder2` was the most rule-compliant model tested (the
only one to get T2 exactly right) but is not viable as a like-for-like swap in its current
form -- 34-55 seconds per call is far outside what a per-tick planner can tolerate, and one of
three calls returned nothing at all, which would surface as exactly the same "unparseable
planNextStep reply" fallback bug already on record for `dispatch`, not a fix for it.

**No clean winner; a real tradeoff, not a slam dunk either way.** `dispatch`'s speed is real and
matters for a bot that's supposed to react within a couple of seconds; so is the T3 defect, which
is a genuine correctness bug this exact benchmark reproduced live rather than inferred from old
log comments. `coder` is the more interesting candidate of the two alternatives -- same
architecture family and abliteration status as `muse` (which has no output-quality complaints on
record), meaningfully more accurate on this small sample, and slow but not impractically so.
`coder2` earned real credit for rule-following but isn't usable as shipped (latency, one dead
response). No change made to which role backs `planNextStep` -- this section is the evidence, the
actual routing decision is left to the operator.

**What the wider community's experience says.** Searched for how other Minecraft-LLM-agent
projects choose their models:
- [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft) — the most directly comparable
  open-source project (LLM + Mineflayer bots) — documents no model comparison or code-vs-general
  finding in its own README; it does structurally separate "chatting" from "coding" model configs,
  the same split this fleet already makes (`muse` vs `coder`), without commenting on which wins
  for in-game decision-making specifically.
- [Sweaterdog/MindCraft-LLM-tuning](https://huggingface.co/Sweaterdog/MindCraft-LLM-tuning)
  (predecessor to the current Andy series) states directly: "Gemma 2 and Qwen2.5... were by far
  the best at playing Minecraft before fine-tuning" — general-purpose base models, not
  code-specialized ones. Qwen2.5 was the one carried forward.
- [Mindcraft-CE/Andy-4.2](https://huggingface.co/Mindcraft-CE/Andy-4.2) — the current
  community-standard "best local model for Minecraft" — is built on a general Qwen3.5-series base
  (same family as this fleet's own `dispatch`/`muse`), not a code-tuned checkpoint. Its
  improvement over stock comes from task-specific fine-tuning on spatial reasoning and
  step-by-step planning examples, not from starting with a coding-specialized base model.
- Broader agent-benchmark literature (searched separately, not Minecraft-specific): "code
  specialists did not win the coding benchmark" on one cited agentic-coding leaderboard, and
  "training LLMs on code and high-quality, multi-turn alignment data enhances agent performance"
  per AgentBench findings — code EXPOSURE during training correlates with better agent behavior,
  but a model BRANDED/marketed as a coding specialist isn't reliably the strongest general
  planner. This is consistent with, not contradicted by, `coder` outperforming `dispatch` on
  accuracy above: `coder`'s edge plausibly comes from being a larger, more careful model overall
  (27B vs the A3B-MoE stock quant backing `dispatch`), not specifically from code abliteration.
- **No source found anywhere -- this project's own history or the wider community's -- reporting
  a controlled comparison of a code-specialized model against a general one for real-time
  Minecraft bot planning specifically.** This benchmark is more evidence on that exact question
  than what was previously available anywhere searched.

## 27. 34-hour post-fix review finds Soldiers permanently weaponless -- root cause was self-defense, not the role system (2026-09-15)

Direct request: "check the logs since the last review for the bots, look for behavioral gaps."
Reviewed ~34 hours since the world re-seed (§25) and the phantom-throttle/bed-scaling deploy
(§24), through both an automated sweep and direct spot-verification of its two most consequential
claims before acting on them.

**Confirmed fixed.** The phantom self-defense throttle (§24) is working as designed: sample-hour
trigger counts dropped from the old ~268/hour baseline to 35-40/hour (an 85-87% reduction), with
measured gaps between consecutive phantom triggers consistently at or above the 20s cooldown, and
real travel now completing (dozens of `goal_reached` events per bot per hour where before there
were essentially none). No crash-restarts anywhere in the fleet across the whole window. No repeat
of the original 2.5-hour, 200+-death mass spawn-camp incident, though two much smaller, shorter
single-location death clusters occurred (Amy: 58 deaths in ~7 minutes to a drowned at one
coordinate; Wade: 11 deaths in ~7 minutes to mixed mobs) -- the same failure *shape*, an order of
magnitude smaller in scale, not eliminated as a possibility.

**Confirmed NOT fixed, and root-caused for real this time.** §23's Soldier task restriction looked
violated live: Mark self-proposed "Secure Luke's flank -- craft a pickaxe" and both Mark and Luke
showed a chronic `REJECTED DONE (claimed iron_sword, not actually in inventory or equipped)`
hallucination loop spanning the entire 34-hour window (Mark 44 occurrences, Luke 57). Verified
directly rather than trusted from the sweep alone. The real root cause was not a role-system gap
at all: Mark logged **909** `self-defense: gave up on the fight -- took too long` results in 34
hours (~27/hour) across every hostile type (spider, enderman, zombie, skeleton, creeper, drowned,
stray) -- because he had no sword or axe for the entire window, and `checkSelfDefense()`'s own
attack-vs-flee decision never checked whether the bot actually had a weapon before committing to
"attack." A bare-handed fight against nearly anything can't land enough hits inside
`ACTION_TIMEOUT_MS` (90s) to win -- the *exact* failure shape the `FLEE_ONLY_MOBS`/phantom fix
already existed to prevent, just triggered by "no weapon" instead of "can't reach a flyer."

**The self-reinforcing loop this created.** Attack was chosen every time (none of these mobs are
`FLEE_ONLY_MOBS`, and health never dropped low enough to trigger the other flee condition), which
meant SELF_DEFENSE-tier arbiter control was held almost continuously -- never leaving a real,
sustained window for GOAL_STEP tier (the tier `nextSoldierPriority()`'s own "go get a weapon"
directive runs under) to actually execute a LOOT/CRAFT/REQUEST through to completion. Permanently
weaponless kept every future encounter exactly as doomed, forever. This also explains the
`iron_sword` hallucination without any change needed to the DONE-verification itself: that check
was already correctly rejecting the false claim every single time (see "REJECTED DONE" itself) --
the bug was dispatch never getting a real opportunity to make actual progress between guesses, not
the safety net failing to catch a bad one.

**Two fixes, both small and surgical.**
1. `checkSelfDefense()`, `checkSleepingThreat()`, and `respondToSquadCall()` (`index.js` 2.70.0)
   all now flee (or decline to engage, for the squad-response case) whenever `hasWeapon(bot)` is
   false, alongside their existing flyer/low-health conditions -- exactly the same reasoning
   `FLEE_ONLY_MOBS` already established, extended to cover "no weapon" as its own doomed-fight
   case rather than only "wrong kind of target."
2. A second, independent gap in the same investigation: `nextSoldierPriority()` returned `null`
   once a Soldier had both a weapon AND no nearby hostile, falling through to the SAME
   unrestricted freeform self-propose path every other role uses -- which is exactly how "craft a
   pickaxe" got self-proposed despite §23's restriction. Builder's own checklist (§15.6)
   legitimately graduates to freeform once her one-time infrastructure list is built; a Soldier's
   job was never supposed to have an equivalent "done, move on" state (§21's own framing: gear and
   combat, ongoing, never done). `nextSoldierPriority()` now always returns a directive for a
   Soldier-primary bot -- weapon check, then nearby-hostile check, then a final "stand guard near
   home" fallback -- so a Soldier never reaches the unrestricted freeform path at all.

**A separate, un-fixed anomaly found and flagged, not chased down.** A recurring
`sqlite3.OperationalError: UNIQUE constraint failed on vec_chunks primary key` traceback appears
232-329 times per bot over the window, but only on `spark`-hosted bots (Babs/Amy/Mark/Luke/Mayor
all affected; Bob/Nell/Wade/Dale on `spark2`, zero occurrences) -- consistent with a concurrent-
write race in a shared local vector-store table that only five co-located processes on one host
can actually contend for. Never causes a crash (`Main process exited` count stayed zero
throughout). This lives in shared Firmament memory/RAG infrastructure, not this fleet's own code,
and touching it is a distinct, cross-service investigation of its own -- flagged here for
engineering attention, not chased down as part of this pass.

## 28. A disconnected bot ran for 2+ hours pretending to still be playing (2026-09-16)

Direct report: "the bots do not appear to be active in world." A routine status check just before
this ("check bot status") had reported all 9 systemd services `active` with normal-looking goal
chatter and self-defense activity in their logs -- **that check was wrong**, fooled by exactly the
bug this section root-causes.

**Confirmed via RCON, the only authoritative source.** `list` showed **0 of the 9 bots actually
connected** -- only the human player. Every bot's own logs, meanwhile, looked completely ordinary:
goals proposed and heard, `squad response: arrived, nothing left to fight` repeating on a tight
~20s rhythm, even `sleep: slept through the night. (ok=true)`. None of it was real. Traced to a
genuine `[Mark] disconnected: keepAliveError` at `12:50:18`, coinciding with the game server
process itself restarting (`ps` showed a fresh PID from `12:53:42` -- a restart this session didn't
initiate). Every bot hit the same disconnect.

**Root cause: `bot.on("end", ...)` only ever logged the disconnect.** No reconnect attempt, no
process exit, nothing else. Every `setInterval`-driven check (`checkSelfDefense`,
`checkSleepingThreat`, `proposeOwnGoal`, `goalTick`, squad response...) kept firing on schedule
against a `bot` object with no live connection -- and several of them don't hard-error on a dead
connection, they resolve with misleading success instead, which is how a genuinely disconnected
bot ended up logging that she'd both fought off a creeper and slept through the night. **A silently
zombied process is worse than a crashed one** -- it actively defeats the exact kind of
`journalctl`-based status check this whole design doc's incident log relies on throughout, which
is exactly what happened to the immediately-preceding "check bot status" turn.

**Fixed the same way OOM crashes already recover.** Every bot service already runs under
`Restart=always` (confirmed working for real, repeatedly, in §27's own OOM findings). `bot.on(
"end")` now calls `process.exit(1)` after logging -- handing recovery to that same, already-proven
systemd machinery instead of leaving a stale process to keep pretending. A fresh process gets a
real, clean reconnect.

**Scope note.** This fix only covers the mineflayer-level "the connection actually ended" signal
-- it does not, and can't by itself, detect a bot that's connected but stuck/wedged (that's
`checkStuck`'s own, separate job, §17/elsewhere). The two failure modes look similar from a
`journalctl` glance but need different fixes; this section closes the "looks fine, isn't even
connected" one specifically.

## 29. World restore point (2026-09-16)

Direct request: "backup the current world into a restoration point. If I ask, I want to be able to
restore to the current state." A dedicated, clean snapshot -- not the same thing as the automatic
nightly `backup.sh`/`minecraft-bots-backup.timer` tarballs already running, and not the same as
the `firmament-bots.bak-*` directories §25/§28 left behind as incidental byproducts of a world
re-init. This one was taken deliberately, for later restore on request.

**How it was taken -- stopped, not live-copied, for a genuinely consistent snapshot.** The
existing `backup.sh` script's own comment explains it tars the world *while the server keeps
running*, accepting "losing whatever changed since the last autosave" as a low-consequence
tradeoff -- reasonable for an unattended nightly job, not good enough for a restore point someone
is deliberately relying on. Now that RCON actually works on this server (§24/§28), a proper clean
snapshot was possible instead: `save-all flush` + `stop` over RCON (same pattern as §25/§28,
verified by polling the exact PID that owns port 25580, not a name-based `pgrep`), then `cp -a`
the fully-idle `firmament-bots` world directory (not moved -- the live world stays exactly where
it was) to:

```
/home/zomboid-admin/minecraft-bots/firmament-bots.RESTORE-POINT-20260916-152257
```

21M, same seed (`694200161758793929`) confirmed via RCON both before and after. `Restart=always`
brought the live server back up automatically (`Preparing level "firmament-bots"`, not "creating
new world" -- confirmed the live world was untouched) -- and, for the first time, every bot's own
`process.exit(1)` fix from §28 fired for real and worked exactly as designed: all 9 reconnected
and rejoined on their own, no manual restart needed, closing the loop on that fix live.

**To actually restore to this point later, when asked:**
1. Stop the live server cleanly: RCON `save-all flush` then `stop` (or, if RCON is down, whatever
   the operator uses directly on `192.168.1.221`); confirm the process that owned port 25580 has
   actually exited before touching anything.
2. Move (don't delete) the THEN-current `firmament-bots` aside to a fresh
   `firmament-bots.bak-<timestamp>-pre-restore`, preserving whatever was built since, in case the
   restore itself needs undoing.
3. Copy the restore point back into place:
   `cp -a firmament-bots.RESTORE-POINT-20260916-152257 firmament-bots`.
4. Let `Restart=always` bring the server back up (or start it manually if it doesn't) --
   confirm via RCON `seed` (should read back `694200161758793929`, same as it always has been) and
   the boot log's own `Preparing level` line.
5. Restart all 9 bot systemd services so they reconnect to the restored world (§28's own fix
   means they may well reconnect on their own after the server-side outage, same as this section's
   own deploy did -- verify via RCON `list` before assuming a manual restart is needed).

**Scope note.** This restore point captures ONLY the world save (terrain, structures, chests,
bot-claimed beds, whatever's been built) -- it does not include bot memory/goal state
(`/mnt/hermes-data/minecraft-memory/`), which lives on `spark`/`spark2`, not on the game-server
host, and isn't touched by anything in this section. A restore rolls the world back; each bot's
own persisted goal/curriculum/claimed-bed state would still reflect whatever it was at restore
time, not automatically rewound to match -- worth being aware of if a future restore is requested
long after this point was taken.

## 30. Chest looting made need-based (2026-09-17)

Direct request: "when a bot opens a chest, they loot EVERYTHING instead of what they need. They
need to: take only the mats they need for their current objective; put any leftovers and gathered
materials in a chest; all chest contents goes into world memory for other bots to leverage."

**Confirmed the complaint before touching anything.** `actions.js`'s "loot" case really did sweep
every stack in a chest -- a DELIBERATE 2026-09-07 design choice at the time ("this is a curated
sandbox server, not a real-survival dungeon with true junk loot"), capped only at one instance per
distinct tool/weapon/armor piece, otherwise a full stack of everything else. The operator is
explicitly reversing that choice now.

**Fix reuses infrastructure that already existed for a DIFFERENT chest-access path.**
`tryTakeFromThisChest()`/`tryTakeFromNearbyChest()` -- the exact, already-correct, need-based
"take up to N of item X" helper "mine"/"craft"'s own chest-first fallback has used since before
this session -- was never wired into the standalone `ACTION LOOT` verb, which had its own,
separate "take everything" implementation. `ACTION LOOT` now takes optional `<item_id> <count>`,
matching MINE/CRAFT/SMELT's own shape (both `classifyIntent`'s direct-command vocabulary and
`planNextStep`'s own goal-planner vocabulary, `index.js` 2.72.0) -- naming an item withdraws up to
that many and no more, via the SAME helper, so there's one implementation of "take up to N from a
chest" fleet-wide, not two that could quietly drift apart (`actions.js` 1.54.0). The MINE
vocabulary's own "try LOOT first" line was updated to name the same item_id it's about to mine,
closing a small consistency gap that predates this request.

**Omitting the item is still valid -- and is now the ONLY way to "just look."** A bare
`ACTION LOOT` (goal planner) or a direct "check that chest" with nothing specific named (player
command) opens the nearest reachable chest, snapshots its real contents into `known_chests.json`,
and takes nothing. This is a genuine behavior split, not a fallback default: naming an item always
means "take it," omitting one always means "inspect only."

**"Put leftovers in a chest" needed no new mechanism.** `storeSurplusNearHome()`/
`checkInventoryFull()`/`checkInventoryInsurance()` (`index.js`, built 2026-09-07/09) already cover
banking non-essential surplus generically, regardless of source (mining, crafting, or looting) --
verified these are real and already running, not re-invented. The one real, additive change: the
existing post-craft immediate-cleanup trigger (`runAction`/`goalTick`) now also fires right after a
targeted loot that actually withdrew something, closing the gap where a loot-caused surplus would
otherwise sit until the next periodic space/health-based check instead of getting banked promptly,
the same way a craft/smelt already does.

**"All chest contents go into world memory" was already true, verified rather than re-built.**
`known_chests.json` (§19) already snapshots full chest contents on every real open (loot, store,
and now the bare-inspection case too), and is already genuinely fleet-wide -- any bot's own
MINE/CRAFT/LOOT chest-fallback already queries it via `findKnownChestWithItem()`. Deliberately kept
as the single source of truth rather than ALSO duplicating chest contents into the fuzzy RAG world-
memory corpus used for resource-location notes elsewhere -- §19's own reasoning still applies: a
chest's contents change on every open and need real point-in-time overwrites, a poor fit for RAG's
own append-only-with-dedup design. Two stores of the same mutable fact would only risk them quietly
disagreeing with each other.

## 31. Freshly-crafted gear now gets equipped -- including tools, and closed a real combat gap it surfaced (2026-09-17)

Direct request: "if they craft armor or weapons or tools, they should equip them."

**The existing comment already claimed this was handled -- it wasn't, fully.** `refreshGear()`'s
own header comment reads "called after any action that might have changed the inventory," and the
"craft" case's own call site comment says "a freshly-crafted tool/weapon/armor piece should get
equipped" -- but `refreshGear()` itself only ever calls `equipBestArmor()`/`equipBestWeapon()`.
`equipBestWeapon`'s own `WEAPON_SUFFIXES` is `["_sword", "_axe"]` -- so armor and sword/axe-class
weapons genuinely were already covered, but pickaxe/shovel/hoe were never weapon-classed, so a
freshly-crafted mining/digging/farming tool just sat in inventory unequipped until some unrelated
later action happened to reach for one. The exact same comment/code drift pattern this project has
caught before (§22) -- a claim in a comment that was never actually true for the whole category it
described.

**Fix: equip the specific item just crafted, not a tier comparison.** The "craft" case (`actions.js`
1.55.0) now checks if `action.item` ends in `_pickaxe`/`_shovel`/`_hoe` and, if so, equips that
exact item directly -- deliberately not routed through a "pick the best tool in inventory" function
the way armor/weapon are, since she crafted this one on purpose and is presumably about to use it,
not comparing it against whatever she happened to already have.

**A real, independent gap this surfaced: combat never re-equipped a weapon before engaging.**
Auditing "attack" while making this change found it never called `equipBestWeapon()` (or
`refreshGear()`) before starting a fight -- only in the `finally` block AFTER the fight ends ("mob
drops may include something worth wearing/wielding"). Combat has always just fought with whatever
happened to already be held, which was low-risk before (little reason to be holding a non-weapon)
but became a real exposure now that a freshly-crafted tool deliberately stays equipped afterward --
a bot could walk straight into a fight holding a pickaxe. `equipBestWeapon()` now runs at the top of
"attack" (`actions.js` 1.55.0) too, so combat always starts weapon-in-hand regardless of what was
held a moment before -- a fresh tool, a fishing rod, held food, anything.

## 32. Task-hallucination review, dug in: root-caused Amy's chronic loop to a silently-failing home-lighting reflex (2026-09-17)

Direct follow-up to a "look in new logs for task hallucinations" review that found (1) both
existing hallucination-detection mechanisms (`REJECTED DONE`/`SUSPICIOUS DONE`) firing correctly
~2,160 times fleet-wide in 26 hours with zero missed catches, and (2) two standout patterns worth
digging into: Amy's chained furnace→beds→shelter loop (near-continuous for the whole window) and a
fleet-wide "get a sword" loop across 6 bots. Direct request: "dig in."

**Verified, not assumed: Amy has been pinned at critically low health, repeatedly.** Pulled her raw,
unfiltered logs rather than trusting the summary. Sep 15 23:39-23:46: stuck at **5.17/20 health**
for the entire stretch shown, triggering near-continuous `EMERGENCY`/self-defense flee interrupts
against a spider. Checked her CURRENT live state while investigating (not historical) and found the
exact same pattern actively in progress: **health=1** (literally one hit from death) against a
persistent creeper, for at least 4 straight minutes, in the SAME "go home and build a shelter"
goal. This is a recurring condition, not a one-off.

**Root cause, traced to a genuinely invisible failure.** `checkHomeLighting()`'s own "no torches ->
return" early exit was **completely silent** -- no log line of any kind -- confirmed by grepping
Amy's entire 13+ hour post-reseed log for "torch": all 46 hits were other bots' goals relayed over
Buzz; she herself never once crafted, held, or attempted anything with a torch. A resource-starved
bot (stuck early in the tech tree, per her own repeatedly-reasoned-but-never-completed crafting
chain) could go the ENTIRE time with this reflex doing nothing, leaving her home area permanently
dark, with zero trace in the logs of why -- exactly the kind of silent failure this incident log has
caught before (§17's own "checkHomeLighting requires a claimed bed... zero beds meant zero claims"
catch-22, a different cause, the same class of bug).

**The vicious cycle this created.** Dark home -> nighttime mob spawns right where she works -> she
gets pinned at critical health -> constant flee/emergency interrupts prevent her from ever finishing
the multi-step crafting chain needed for a shelter (or the torches that would have lit the area in
the first place) -> home stays dark -> repeat. This also plausibly explains the dense multi-mob
swarm window found in the original review (creeper/zombie/enderman/phantom all converging in a tight
span) -- an unlit, unsheltered base at night is exactly the condition that produces one.

**Fixed at the root, not by treating a symptom.** Torches need no crafting table -- confirmed
against `bot.recipesFor()`'s own table-less lookup, the identical mechanism already relied on for
sticks/planks (§ various). `checkHomeLighting()` (`index.js` 2.73.0) now crafts torches herself
first when she's carrying fuel (coal/charcoal) and a stick, instead of only ever depending on
already having some, and logs plainly when she genuinely can't (no fuel, no stick) -- turning a
silent, indefinite failure into a real, visible, diagnosable one either way.

**Other threads dug into, not separately fixed.** The "get a sword" loop's root cause (verified for
Mark specifically): he genuinely crafted a wooden sword, then gave it away to Luke fulfilling a
legitimate teammate request three minutes later, and every retry after that ran into the same
combat-interruption problem as Amy's -- a real log excerpt showed a near-continuous flood of
squad-response threat alerts (a different bot, different mob, every few seconds) during one retry
window. Amy's own reasoning also showed the "correct diagnosis, no follow-through" pattern already
documented and benchmarked in §26 (sometimes jumps straight to a later step of her own correctly-
reasoned chain, e.g. "ACTION MINE stone 8," skipping the crafting-table/pickaxe prerequisites she'd
just laid out) -- a known, already-investigated `dispatch` characteristic, not a new bug requiring a
fresh fix here. A smaller, real interaction also observed but not chased further: `checkInventory
Insurance()`'s health-triggered surplus-banking has no awareness of what the CURRENT goal actually
needs, so a raw material she was actively working toward using can get banked away the moment her
health drops -- confirmed happening once (a single stored oak_log), self-corrected moments later via
a chest re-loot, low-impact in the trace examined and not fixed in this pass.

## 33. Chest-substitution broadened to any equipment tier (2026-09-18)

Direct request: "if the bot is in need of a piece of equipment (sword, armor, pickaxe, etc), and
finds one already crafted in a chest, it should pick up ONE of those pieces of that equipment and
abandon the quest to craft it."

**A real gap in an already-existing mechanism, not a missing feature.** The craft-time and
loot-time chest-substitution checks (§ various, 2026-09-08 and §30) already existed and already
worked -- a bot really would take a `stone_pickaxe` from a chest instead of crafting one, if a
`stone_pickaxe` was what she'd specifically asked for. The gap was narrower than "does this
happen at all": both checks only ever matched the EXACT item id the model named. A chest holding
an `iron_pickaxe` was invisible to a `craft wooden_pickaxe` check, so she'd go ahead and craft (or
keep looking for) the specific tier she'd happened to guess, walking right past a better tool
sitting a few blocks away.

**Fix, scoped deliberately to gear only.** New `gearCategoryNames(bot, itemName)` (`actions.js`
1.56.0): if the requested item ends in one of `GEAR_SUFFIXES` (helmet/chestplate/leggings/boots/
sword/axe/pickaxe/shovel/hoe), returns every real registry item name sharing that suffix --
otherwise returns just the one name, unchanged. Wired into "craft"'s own chest-check and both of
"loot"'s matching passes (local search, remembered-chest fallback via `known_chests.json`).
Deliberately NOT applied to raw materials -- an `iron_ingot` really is the one specific thing a
smelting recipe needs, there's no "any tier" concept to broaden to, so every non-gear chest-check
in this file (mine's, explore's) is untouched.

**"Abandon the quest" needed no new mechanism.** The substituted item was already honestly
reported in the step's own result text (`found iron_pickaxe already in a chest, no need to craft
it` -- the REAL item taken, not a repeat of what was asked for), which lands in `recentLog` and
her own gear/inventory snapshot on the very next `planNextStep` tick. The existing DONE-
verification (real inventory/equipment check, not a self-report) already closes a goal the moment
it sees the actual equipment present -- the same real-world-state discipline this whole
hallucination-detection system already runs on, not a separate feature to build.

**Scope note.** Doesn't prefer the best tier when a chest happens to hold more than one --
`tryTakeFromThisChest()` takes whichever matches first, same as it always has. Gear is
near-universally requested one at a time, so "any real instance satisfies the need" is enough;
tier-ranking multiple candidates in the same chest was judged not worth the added complexity for
how rarely it would actually matter.

## 34. Second hallucination review dug in to the real root cause: fleet was dying every ~42 minutes and losing everything (2026-09-18)

Direct follow-up ("look in new logs for task hallucinations") on top of §32/§33. A background review
found both `REJECTED DONE`/`SUSPICIOUS DONE` mechanisms still firing correctly (~3,315 catches,
33h, nothing missed) but reported the §32 torch fix as a total no-op (0 "crafted torches" fleet-
wide) and a still-fully-active fleet-wide "get a sword" loop, headlined by Mark receiving a stone
sword from two different teammates (Babs, Mayor) 22 minutes apart and remaining swordless 33+
hours later. Both claims were verified directly rather than reported as-is, per this session's own
standing rule about trusting a subagent's findings.

**Torch fix: confirmed genuinely inert, and why.** Amy's own logs show she legitimately possessed
fuel and sticks separately at different moments, but the check only ever caught her missing one or
the other -- because between `checkHomeLighting()` ticks she was almost never in a stable state at
all. At 07:36-07:37 alone: self-defense force-cancelled her current action 5 times in 60 seconds
(zombie, phantom x3, an EMERGENCY health-critical flee at 4.33 HP) while she was mid-craft on the
exact sticks the torch check needed. She also still has zero pickaxe fleet-session-wide (9x "need a
better tool for stone"), and is stuck on a goal the code itself keeps re-assigning her: `Builder
priority goal (beehive)`, a deterministic checklist item in `nextBuilderPriority()` requiring
honeycomb, which requires shears, which requires iron, which requires mining she has no tool for --
logged 38+ times across the window with no real path to completion. Not a bug in the §32 fix
itself; a symptom of the same thing below.

**The real root cause, found by asking "why does everyone keep losing gear they just got":**
counted deaths fleet-wide for this same 33-hour window --

| Bot | Deaths (33h) |
|---|---|
| Mark | 287 |
| Wade | 214 |
| Luke | 181 |
| Amy | 181 |
| Bob | 163 |
| Mayor | 160 |
| Dale | 134 |
| Babs | 120 |
| Nell | 115 |
| **Total** | **1,555** |

Averages one death every ~42 minutes per bot. RCON confirmed the live world's `keep_inventory`
gamerule (this server's snake_case renaming, same naming scheme §20/§24 already ran into for
`mob_griefing`) was `false` -- meaning every one of those 1,555 deaths dropped the bot's entire
inventory on the ground with no code anywhere that walks back to a death location to recover it.
Cross-checked directly against the headline claim: Mark received a sword from Babs at 05:05:20 and
from Mayor at 05:27:25 on 9/17 -- and died at 05:15:39 in between, squarely between the two gifts.
That single death explains the first loss outright; constant re-death after the second (his own
Soldier-priority directive re-fired 10+ times in the next 20 minutes) accounts for the rest. This
isn't a bug in the sword-acquisition logic, the gifting logic, or the DONE-verification logic --
all three were already working exactly as designed. It's a world-state fact sitting upstream of
all of it, the same shape of finding as §20's `mob_griefing` discovery: nothing to fix in the repo,
something to fix on the server.

**Fix: `gamerule keep_inventory true`**, set live via RCON and confirmed (`false` -> `true`). Only
example of the two headline claims chosen with an operator decision rather than assumed -- offered
the alternative of a code-side death-recovery behavior (walk back to the corpse) instead, and the
operator picked the gamerule flip: simpler, immediate, and doesn't ask a bot that just died at
4 HP to path back into the same threat to retrieve its own drops. Same category of gotcha as
§23's world-restore lesson: this lives in the world save, not `server.properties`, so any future
`re-init the map` needs it re-applied same as `mob_griefing` already is.

**Nell's reported third chronic loop: checked, and it wasn't what it was reported as.** The review
described "start a small flower garden near home" as a dead-end spanning the full 33h window with
zero successful steps ever logged. Direct count: 38 self-proposals, 22 of them logged `goal
complete`, spread across the whole window (most recently 11:26:59 on 9/18) -- a real pattern (an
Artist repeatedly self-proposing the same low-effort goal instead of a more varied one), but not a
hallucination or a stuck loop; it mostly just... works, repeatedly. Reported here as a correction
rather than silently dropped, since propagating an unverified subagent finding without checking it
first is exactly the failure mode this session's own verification discipline exists to catch.

No code changed this section -- the fix was entirely a live RCON gamerule flip. Left deliberately
unfixed and flagged for a future pass: the hardcoded `beehive` entry in `nextBuilderPriority()`'s
checklist has no fallback or timeout when its prerequisites are structurally unreachable for the
bot currently assigned it, unlike Soldier's own priority list (§21) which always resolves to
something achievable.

## 35. Spawn rate turned down: phantoms off, difficulty dropped to Easy (2026-09-18)

Direct request: "can we turn down the spawn rate, especially of phantoms?" -- a natural follow-on
to §24 and §34, both of which kept tracing chronic disruption (force-cancelled travel, self-defense
storms, the chronic-death rate behind §34's `keep_inventory` fix) back to phantoms specifically.

**Checked what levers actually exist before picking one.** Confirmed via the full (previously
truncated -- see below) `help gamerule` output that this is a plain vanilla `server.jar` (no Paper/
Spigot/Purpur config files present, just `server.properties`), so there's no per-mob spawn-weight
or spawn-frequency config to tune. Vanilla's own real lever for phantoms specifically is time-since-
last-slept, not a rate dial -- consistent with everything already found about the fleet's chronic
sleep-deprivation problem. However, this server build turned out to expose one gamerule beyond
standard vanilla: `spawn_phantoms` (boolean, alongside `spawn_wardens`, `spawn_patrols`, etc.) --
found only because the RCON client used through §20/§24/§34 was truncating multi-packet responses
to a single packet, silently cutting off `help gamerule`'s real output. Fixed the client to read
until a sentinel packet echoes back (the standard multi-packet RCON workaround) before trusting a
`help` listing as complete again.

**No partial dial exists for phantoms** -- `spawn_phantoms` is on/off only, nothing in between.
Given how consistently phantoms specifically (not the general mob population) kept surfacing as the
dominant disruptive threat across §17, §24, §27, and §34's own death count, offered the operator the
straight choice rather than assuming; operator chose full disable. Set `gamerule spawn_phantoms
false`, confirmed. For general (non-phantom) spawn rate, difficulty is the only real vanilla lever
-- offered as a separate choice since it's a broader change than the phantom-specific ask; operator
chose Easy. Set `difficulty easy`, confirmed (was Normal). Both live immediately, no bot restart
needed, both trivially reversible via the same two RCON commands.

No code changed -- both fixes were live RCON commands, same category as §20's `mob_griefing` and
§34's `keep_inventory`. Worth checking back on: with phantoms off and §34's `keep_inventory` fix
both live, the chronic self-defense-storm and death-rate findings from earlier sections may now be
substantially reduced on their own, without needing further code changes to the throttle/priority
logic those sections added.

## 36. Enderman joins FLEE_ONLY_MOBS: the same doomed-melee shape as phantom/ghast, caught live (2026-09-18)

Direct live report: "Luke is getting shot, not reacting. there is no mass mob" -- a real-time
incident, not a log review. Checked live rather than guessed: Luke's health (RCON) matched his own
logs exactly, a skeleton was genuinely ~8 blocks away and landing hits, and `nearestHostile()`
(§ various) was confirmed working correctly by inspection -- so the detection path itself wasn't
the problem.

**Root cause: `selfDefenseInFlight` was legitimately stuck on a different fight.** `checkSelfDefense()`
returns early and silently whenever a self-defense action is already in progress -- correct
re-entrancy guarding, but it means a SECOND, unrelated threat gets no response at all until the
first one resolves. Live logs showed exactly that: Luke's self-defense had been holding
SELF_DEFENSE-tier control on `attack (threat=enderman)` since 19:08:53, with no `self-defense
result:` line at all until 19:10:36 -- over 90 seconds later -- when the separate EMERGENCY
health-critical check (a different, still-live code path) finally force-broke it at ~6 HP. He
immediately re-engaged the SAME enderman and repeated the exact pattern a second time before
finally landing on the skeleton as his next target. The whole time, the skeleton was free to keep
shooting him with zero self-defense response -- not a detection bug, a target-monopolization one.

**Why enderman specifically:** endermen teleport away when hit, defeating `bot.pvp`'s straightforward
chase-and-melee approach almost as thoroughly as literal flight does for phantom/ghast (§ the
original FLEE_ONLY_MOBS section) -- the mob isn't unreachable by pathfinding, but the fight rarely
resolves cleanly either. Checked this wasn't one unlucky encounter before fixing it: counted
`threat=enderman` self-defense triggers fleet-wide over 24h -- Mayor 42, Babs 30, Amy 27, but
**Mark 2,800 and Luke 1,770** -- the two bots actually willing to melee-attack (vs. flee) at their
own tuned health thresholds, exactly the bots that would get stuck holding SELF_DEFENSE-tier
control this way. A consistent, high-volume pattern, not a fluke.

**Fix:** `FLEE_ONLY_MOBS` (`actions.js` 1.57.0) now includes `"enderman"` alongside `phantom`/`ghast`
-- self-defense/squad-response flee on sight rather than attempt a melee resolution, same as the
existing two entries, freeing SELF_DEFENSE-tier control to respond to a genuinely separate threat
instead of monopolizing it on a fight that rarely closes cleanly anyway. Trade-off, accepted
deliberately rather than overlooked: bots will no longer fight endermen at all (no more ender
pearls from self-defense encounters) -- judged a reasonable cost against a confirmed, high-volume
"gets shot with zero response" failure mode.

Immediate live incident needed no separate intervention: by the time this was investigated, Luke's
own EMERGENCY flee had already gotten him clear and his health (5.68) had stopped dropping --
confirmed stable via RCON and fresh logs before moving on to root-cause and fix.

## 37. Fleeing now runs toward a rally point (golem, Soldier, or home) instead of nowhere in particular (2026-09-18)

Direct follow-up to §36's own incident: "why aren't the soldier bots coming to defend Nell?"
Checked live rather than assumed -- confirmed via RCON positions that Nell (~4.4 HP, repeatedly
attacked) was ~70 blocks from both Mark and Luke, outside `SQUAD_ASSIST_RANGE` (48 blocks,
`index.js`). Traced her threat alerts all the way through: `broadcastThreatAlert()` really was
firing every ~15s as designed, but `withinSquadAssistRange()` silently drops anything past 48
blocks with no log line either way -- not a bug, a deliberate bound ("no point racing across half
the map for a fight that's very likely already over by the time she'd arrive"), but it leaves any
bot who wanders that far with zero backup, confirmed by the complete absence of her name anywhere
in Mark/Luke's logs. Immediate danger handled the same way as §29's Babs incident: killed the
nearby zombie via RCON once confirmed she was isolated with no help coming.

Direct request in response: "have the threatened bot run towards safety, run towards golems, or
soldiers." Checked what "flee" actually did first -- confirmed it had never had a destination at
all, just `GoalInvert(GoalFollow(threat, 16))`, maximizing distance from the threat with zero
regard for where that put the bot. Could run her further from home, into water, off a ledge, or
simply back toward the same danger from a different angle -- "getting away" and "getting safe" were
never the same thing here.

**Fix:** new `nearestRallyPoint(bot)` (`index.js` 2.74.0), checked in priority order --

1. **A nearby iron golem** (`nearestFriendlyGolem()`, `actions.js` 1.58.0, mirrors `nearestHostile()`)
   -- golems fight hostiles near them on their own vanilla AI, real backup even with zero teammates
   anywhere close.
2. **A nearby Soldier teammate** -- checked via each bot's own `bot.players[name].entity`, already
   locally tracked world state, no new broadcast infrastructure needed. Deliberately NOT gated by
   `SQUAD_ASSIST_RANGE` -- that constant bounds whether a Soldier travels to a distant call, not
   whether a fleeing bot may run toward one who happens to already be close.
3. **Home** (`loadClaimedBed()` or `spawnPoint`, same fallback chain `checkHomeLighting()` already
   uses) -- always a safer place to end up than wherever the flee started, even with nobody there.

Returns `null` only when none of the three are known at all, in which case "flee" falls back to its
original plain away-from-threat behavior -- unchanged, not replaced. Wired into all three
flee-triggering sites (`checkSelfDefense`, the EMERGENCY health-critical handler,
`checkSleepingThreat`) via a new `action.rallyPoint` field; `actions.js`'s "flee" case heads
straight there (`GoalNear`, 3-block radius) when given one instead of the old distance-maximizing
goal. No path-safety check between the bot and the rally point -- same best-effort level as the
rest of self-defense; a rally point is a real place to go, not a guarantee the route there is
threat-free.

## 38. Nighttime mob crisis: real torches placed live, and checkHomeLighting's third straight fix (2026-09-18)

Direct live report: "I am watching a spider attack Mark as he doesn't react" -- checked live rather
than assumed, and the spider turned out to be a tiny visible piece of something much larger already
in progress: RCON health checks across the fleet found Dale at 1.7 HP, Wade and Amy at ~5.8, Luke at
~9, and fresh logs showed at least 7 deaths fleet-wide (Nell, Luke, Bob x2, Mayor x2, Amy) inside
under a minute -- Mark's own respawn-then-immediate-second-encounter with the spider was just one
thread of a full nighttime swarm hitting nearly everyone at once. `spawn_phantoms` was re-confirmed
still `false` (§35 held), so the "killed by phantom" attributions were either stale
best-guess-killer labels or leftover pre-existing phantoms, not a re-emerging spawn -- the dominant
cause was the same unlit-base problem flagged live in §17, §32, and §34, none of which had actually
stuck.

**Immediate stabilization (RCON, live):** cleared hostile mobs around every bot in obvious danger
(same pattern as §29/§34/§37's own incidents), then placed 11 real torches directly via
`/setblock ... minecraft:torch keep` in a spread around `bot.spawnPoint` (328, 77, -144) -- verified
they actually held (a follow-up `keep`-mode placement attempt at the same coordinates correctly
failed with "Could not set the block," confirming occupied, not popped from missing support).
Fleet health confirmed recovering within a couple of minutes; night was also naturally ending
(tick ~22700/24000) by the time this was checked.

**Given the operator's explicit "do both," dug into why `checkHomeLighting()` has now failed THREE
times running** (2026-09-10's original build, §32's 2026-09-17 "craft your own torches" fix, and
now). Re-read the live function: its gate was still `if (!bot.inventory... torch) { check fuel+stick
in inventory, craft or give up }` -- it has ONLY ever consulted this one bot's own personal
inventory at the exact instant its 90-second interval fires, while not busy/asleep/arbiter-locked.
Across a fleet whose self-defense re-triggers every few seconds during any real incident (extensively
documented all session -- §24, §27, §34, §36, §37, and tonight's own crisis), no bot is ever
reliably BOTH free of higher-priority control AND personally carrying the right materials at the
same moment -- the same root shape §34 already confirmed via Amy's specific case, now understood as
the general mechanism behind all three failures, not something specific to her.

**Fix (`index.js` 2.75.0):** before ever falling back to personal-inventory crafting,
`checkHomeLighting()` now tries a chest first via `performAction(bot, {type:"loot", item:"torch",
count:4})` -- reusing "loot"'s own existing local-then-remembered-chest search (§19/§30) rather than
building new plumbing. Cheaper than crafting when it works, and now has a real chance of finding
something: the shared base has actual chests nearby (confirmed via repeated "Found chest near..."
log lines all session), and `tools/minecraft-chests/` (§ the tool-review conversation, same day) can
pre-stock them. Falls through to the original fuel+stick-crafting attempt, then the original
silent-no-more skip log, exactly as before, if the chest search also comes up empty.

## 39. Search capabilities expanded, and a real gap closed: successful mining wrote nothing to world memory (2026-09-19)

Direct request: "expand their search capabilities further, especially the miner and explorer
roles. make *sure* that discovered resources are being stored in world memory."

**Audited the existing world-memory-writing paths first (all in `goalTick`, `index.js`) rather than
assuming they were complete.** Found exactly three: a successfully PLACED crafted object, a FAILED
mine/craft/etc. ("even after looking around"), and a successful EXPLORE. A real, confirmed gap sat
right in the middle: a **successful MINE never wrote anything at all** -- only her failures were
ever shared with the fleet. Babs (the fleet's Miner) could spend all day successfully finding and
mining iron/coal/copper and nobody else would ever learn where from it; the only trace of her work
anyone else could see was when she came up empty. Fixed (`index.js` 2.76.0) by extending the exact
same note-write explore's own success already uses to mine's success too, rather than building a
second, parallel mechanism.

**Also confirmed neither Miner nor Explorer has ever had a deterministic search mechanism at all**
-- unlike Soldier (§21) and Builder, both roles rely purely on freeform self-propose with no
code-level checklist or search logic of their own; their `roles.js` priority lists are advisory
prompt text only. Two concrete expansions, kept scoped rather than building a full parallel
priority-function system for both roles in one pass:

1. **Wider, per-bot-tunable search radius.** `MINE_SEARCH_RADIUS`/`EXPLORE_SEARCH_RADIUS`/
   `EXTENDED_SEARCH_DISTANCE` (`actions.js` 1.59.0) replace the hardcoded 32-block scan radius
   "mine"/"explore" always used, same env-tunable-per-bot pattern already proven for
   `MC_SELF_DEFENSE_RANGE` (§21). Babs and Wade's own systemd units now set real, larger values
   (40-block local search for both, 260-block extended range for Wade specifically) without
   touching the shared default every other bot's occasional mine/explore call still uses. Kept
   deliberately under `bot.pathfinder.searchRadius`'s own documented 48-block OOM ceiling (a
   caution this file already established for `EXPLORE_DISTANCE`) for the two radii that drive an
   unhopped `collectBlock` pathfind straight to a found block; `EXTENDED_SEARCH_DISTANCE` (the
   wander "beacon" scan) was raised more freely since that walk is already hop-capped regardless of
   how far the beacon itself is.
2. **A real search target for Explorer's own stated "locate a village" priority.** Nothing
   anywhere ever actually searched for one -- only ore/log/crafted-object names were ever scanned.
   New `VILLAGE_INDICATOR_NAMES` (`bell`, `composter` -- real villager job-site blocks, genuinely
   low false-positive in vanilla generation) feeds into `noteNearbyResources()`'s existing scan,
   note-only by construction (that function only ever reads and writes, never moves or mines) so
   there's no risk of a bot breaking a village's own infrastructure while "gathering" it.

**Broadened when discovery-sharing actually runs, not just what it covers.** Both a successful mine
and a successful explore now also trigger a full `noteNearbyResources()` sweep (not just a note
about the one specific target), catching any other ore/log/village-indicator visible from wherever
the action left her -- a free look around at zero extra travel, the same mechanism already used for
scout requests now also firing on ordinary routine success.

## 40. Bots now refuse a "give" that would leave them without a weapon/armor/tool they need, or downgrade its quality (2026-09-19)

Direct request: "Mayor/Leader missions, if they would effectively DOWNGRADE a bot's equipment or
status, should be rejected by the bot."

**Found the concrete mechanism first, rather than trying to define "downgrade" abstractly.**
Mayor's own directives are delivered as plain in-game chat (`bot.chat(reply)`,
`proposeDirectiveForOthers()`), so a receiving bot processes them through the exact same
`classifyIntent` pipeline as any other message -- there's no separate "this came from the Leader"
code path to special-case. The one real, already-diagnosed gear-loss vector both a direct command
("ACTION GIVE") and the autonomous `checkPendingGiveRequests()` fulfillment path funnel through is
the "give" action itself (`actions.js`) -- and it never checked whether complying would leave the
GIVER worse off, whoever asked. §34 already found Mark gifted a sword twice by teammates yet ending
up swordless anyway (that specific case traced to a death between the gifts, a different cause) --
but the giving side of that same exchange had no safeguard at all: a bot asked to hand over her only
sword, her only pickaxe, or a piece of armor she's not doubled up on would simply comply.

**Fix (`actions.js` 1.60.0):** "give" now checks, before ever pathing to the recipient, whether the
requested item's whole category would go from "has one" to "has none." Sword and axe are treated as
one interchangeable weapon category, matching `equipment.js`'s own `hasWeapon()` definition exactly
(a bot with a spare axe isn't left defenseless by giving away her sword); armor and tool suffixes
are each their own category (a spare pickaxe doesn't cover for giving away her only shovel). A
genuine spare is always still fine to give -- this only blocks the specific case of going to zero.
Refusal is a real `fail()` with a clear reason (`"won't give away my iron_sword -- that's my only
weapon..."`), not a silent no-op: visible in her own logs, and reported back exactly like any other
declined action, so whoever issued the request (Mayor included) sees why.

**Direct follow-up: "must also reject if... the quality of their equipment [would be]
reduced."** Going to zero was only half the problem -- giving away her BEST piece in a category
while a worse one stays behind is a downgrade too, even though she'd technically "still have one."
New `GEAR_TIER_RANK` (`actions.js` 1.61.0) -- a single common-sense material ranking (wood/leather
< gold < stone/chainmail < iron < diamond < netherite), deliberately not a precise simulation of
real armor-point/mining-level math (gold in particular is genuinely inconsistent between tools and
armor in actual vanilla rules) since this only needs to answer "would she end up worse than
before" -- lets the same check compare the tier of what's being given against the best tier she'd
still be holding in that exact category afterward. An unrecognized material (e.g. a modded item)
falls back to the has-one/has-none check alone rather than guessing at a tier that doesn't exist.

**Scoped deliberately to "give," not a general directive-intent classifier.** Trying to detect
"would this arbitrary instruction downgrade her status" in the abstract (before it's even executed)
would mean guessing at consequences from a free-text directive with no reliable signal to check
against. "Give" is different: it names an exact item and count, so what leaving her with can be
checked directly against real inventory state, the same real-world-state discipline every other
fix this session relies on rather than a broader heuristic that would risk blocking legitimate
requests it can't actually evaluate.

## 41. Crafting-table/furnace "craft then never place" trap, root-caused and closed (2026-09-19)

Direct report: "I don't think they really know how to use the crafting table or furnace." Checked
live rather than assumed, and found a genuine, previously-undiagnosed trap rather than confirming
the report's own framing at face value.

**The real bug wasn't confusion about crafting -- it was goal abandonment throwing away real
progress.** Traced Amy's full session: she successfully crafted a `crafting_table` at 01:45:15.
`nextBuilderPriority()` then re-issued "go home and place a crafting table there" three separate
times (01:59, 02:13, 02:19) over the next 25 minutes -- and every single time, the very next model
call claimed `DONE crafting_table` with **zero** real steps attempted in between (no `ACTION PLACE`
ever logged for it, confirmed by grepping her entire session). `builderPriorityItemSatisfied()`
(§18) correctly caught every one of these three false claims -- the safety net worked exactly as
designed -- but the handling code then threw the WHOLE goal away (`currentGoal = null`,
`clearGoal()`) rather than acting on the one fact already certain: she was still physically
carrying the table the entire time. The next re-issued directive had no memory of that and
immediately re-hallucinated DONE again, over and over, apparently indefinitely -- a real trap, not
a one-off. This same mechanism covers every `builderPriorityItem` (furnace, beehive, crafting_table,
not just the one instance directly observed).

**Fix (`index.js` 2.77.0):** on this exact rejection, before giving up, check whether she's still
holding the named item. If so, resolve it directly and deterministically -- `gohome` then `place`,
both already-robust existing actions -- rather than gambling on another LLM round-trip for
something this mechanical. Only falls through to the original abandon-the-goal path if that direct
attempt itself fails (e.g. genuinely no clear spot to place it), so this doesn't risk a new
infinite-retry shape of its own.

**A second, contributing factor, also fixed:** live logs showed real, sometimes multi-paragraph,
occasionally self-contradicting reasoning (Amy, Babs) re-deriving from first principles whether
logs can hand-craft into planks, whether a crafting table is needed to make a crafting table, etc.
-- `craftItem()`'s own existing auto-chaining of simple intermediates (logs -> planks -> sticks/
table, already built and working) was never mentioned in `planNextStep`'s own `ACTION CRAFT`
description at all, so the model had no way to know it didn't need to plan those substeps itself.
Separately, `ACTION PLACE`'s description only ever framed placement as unlocking a SMELT/CRAFT
prerequisite, never as the action that actually satisfies a "set one up at home" directive --
exactly the gap that let "I'm carrying it" get conflated with "done." Both descriptions clarified;
no behavior change on their own, but removes a real source of wasted reasoning and a plausible
contributor to the DONE-hallucination pattern this fixes.

## 42. "Trapped with a zombie" root-caused to an infinite flee dig-loop, not a lack of will to fight (2026-09-21)

Direct request: review the last 24 hours for behavioral problems -- which surfaced the single
worst incident yet found this session: ~4,271 deaths fleet-wide, one bot (Mark) hitting a 408-
death streak in one spot, still actively ongoing at review time (three different bots died within
a 10-second span while this was being checked live). Stabilized short-term via two RCON mob-clear
sweeps (same pattern as §29/§34/§38), but this was clearly a recurrence of the same unlit-base
problem (§17/§32/§34/§38) at a much larger scale, with two prior code fixes and a manual
intervention already having failed to hold.

**Direct live correction from the operator, based on first-hand observation, reframed the whole
investigation**: "usually one zombie camped out, killing them over and over. none of them fight
back including the soldiers. the zombies get killed in the sun or by a golem. If the bots are
inside a building with a zombie, they seem to act as if they are trapped." This did not match a
"swarm overwhelms them" theory -- it pointed at something mechanically preventing combat/escape
entirely, for every role, which is exactly what live logs confirmed.

**Root cause, confirmed live, not guessed:** watched a real death-streak window (Mark, 06:00:41
onward) and found the actual mechanism. Once health crosses into EMERGENCY-critical, a separate
handler takes over and commits to fleeing only -- by design, it never attacks, regardless of role
or weapon (the same is true of ordinary self-defense once health drops below its own flee
threshold). Fleeing pathfinds using the SAME canDig-enabled `Movements` every other action shares
(`canDig` has never been explicitly set anywhere, so it sits at mineflayer-pathfinder's own
default of `true`). In a small enclosed room, the only path that genuinely increases distance from
the threat can require digging through a wall -- and when that dig fails, pathfinder recomputes
the IDENTICAL best-cost path (same digging step) and fails again immediately. Confirmed directly in
the log: `path_reset: dig_error` firing dozens of times per SECOND with an completely unchanged
`nodes=13 visited=18 cost=17.5` signature -- a tight, un-backed-off infinite loop, not a slow
retry. This holds SELF_DEFENSE/EMERGENCY-tier control continuously: she never successfully moves,
never attacks (flee-committed), and just absorbs hits until she dies -- explaining every one of the
operator's three observations at once (nobody fights back regardless of role; only an external
factor like sunlight or a golem ever actually kills the zombie; "trapped" is a literal, accurate
description of what's happening, not a figure of speech).

**Fix (`actions.js` 1.62.0):** "flee" now temporarily disables digging (`bot.pathfinder.movements.
canDig = false`) for the duration of its own pathfind, restoring the prior value in `finally`
regardless of outcome. This forces pathfinder to either find a genuinely walkable escape route or
fail cleanly and fast -- closing the infinite-loop failure mode outright. It does NOT by itself
make a truly cornered bot fight back (EMERGENCY-tier flee's own no-attack design is unchanged) --
see the note below.

**Deliberately not addressed in this fix, flagged for a follow-up decision:** even with the loop
closed, a bot with genuinely zero non-dig escape route will now fail to flee quickly and repeatedly
rather than fighting back, since EMERGENCY/critical-health self-defense is designed to never
attack. Given the operator's own framing treated "soldiers don't fight back" as itself a problem,
worth a real design decision (not assumed here): should a bot who has just failed to flee, is still
under threat, and still has a weapon, attack as a last resort rather than repeat a doomed flee
attempt indefinitely?

## 43. Role-based fight-or-flee rule, and fighting back when fleeing genuinely fails (2026-09-21)

Direct answer to §42's own open question, plus a broader rule change: "if truly unable to flee,
they should all fight. Soldiers fight *always*, others fight when under half health."

**Replaced the flat health threshold with an explicit role rule.** The old decision (`checkSelfDefense`,
`checkSleepingThreat`) was a single number, `SELF_DEFENSE_FLEE_HEALTH` (default 10, env-overridden to
4 on Mark/Luke's own systemd units) -- attack above it, flee at or below, the same shape for every
bot, only ever tuned by a magnitude, not a rule. New `decideFightType()` (`index.js` 2.78.0) makes
the rule explicit instead: a Soldier's whole job is combat, so health alone never sends her running
(she still flees `FLEE_ONLY_MOBS` or when unarmed -- those are a real inability to land a hit, not a
courage judgment call, see `actions.js`'s own `FLEE_ONLY_MOBS` header). Anyone else avoids a fight
while healthy -- better spent doing her actual role -- but stops retreating and finishes it once
genuinely hurt (health < 10/20). The now-superseded per-bot `MC_SELF_DEFENSE_FLEE_HEALTH` override
was removed from Mark/Luke's own unit files rather than left in place silently doing nothing.

**Closed the one place the old rule was never actually applied at all.** The EMERGENCY health-critical
handler (`bot.on("health")`, fires only at 6 HP or below -- always "under half health" by definition)
had always hardcoded an unconditional flee, regardless of role, the entire time self-defense's own
threshold logic existed alongside it. Now uses the exact same `decideFightType()` -- a Soldier fights
here too, and so does anyone else, since this handler firing at all already satisfies the "under
half health" condition the new rule fights on.

**Directly answers §42's open question: a failed flee now triggers a fight, not a shrug.** New
`attackAsLastResort()`, called from all three flee-triggering sites (`checkSelfDefense`, the
EMERGENCY handler, `checkSleepingThreat`) whenever a flee attempt comes back `!ok` -- meaning
pathfinder genuinely couldn't create distance, a fast and clean failure now rather than an infinite
stuck loop thanks to §42's own dig-disable fix. Retreating not working is retreating not working
regardless of why "flee" was chosen in the first place; standing still and absorbing hits because
running away didn't pan out is strictly worse than fighting, provided there's a weapon to fight
with. Deliberately still excludes `FLEE_ONLY_MOBS` even as a last resort -- a flyer or a
teleport-evader stays genuinely unreachable no matter how desperate the situation gets, the exact
doomed-melee shape that set already exists to prevent.

## 44. Wall-breaching shortcuts past doors closed with a dig-cost penalty, not a new protection rule (2026-09-21)

Direct report: "they still destroy walls instead of using doors." A real, distinct gap from
§19/§18's own door-protection fix, not a regression of it -- confirmed the existing protection is
still intact (doors, trapdoors, and fence gates are all still in `isProtectedBlockName()`, feeding
`movements.blocksCantBreak`, so the door block itself genuinely can't be dug through). The gap was
never about permission to dig the door -- it was that an ORDINARY wall block right next to it has
no such protection, correctly so in general (she has to be able to dig through real terrain
obstructions), and nothing ever discouraged treating that as a shortcut instead of the door.

**Confirmed the actual mechanism** against mineflayer-pathfinder's own cost formula
(`movements.js`): `laborCost = (1 + 3 * digTime/1000) * digCost`, with `digCost` defaulting to `1`.
For anything quick to break -- planks, dirt, most ordinary wall material -- that labor cost is
often cheaper than the walk around a building to its actual door, so pathfinder simply chose the
shortcut every time cost, not correctness, decided the route.

**Fix (`index.js` 2.79.0):** `movements.digCost = 30`, set right alongside the existing
`movements.liquidCost = 20` and reasoned about identically -- strongly discourage, don't forbid.
She'll still dig through a genuine dead end with no path around it at all (digCost only raises the
cost of that move, it doesn't remove it as an option, the same "not banned outright" design
`liquidCost` already established for water), but a shortcut past a door that was right there is no
longer cheaper than just using it.

**Verified this actually reaches every pathfinding call site, not just direct `goto()` calls.**
`bot.collectBlock` (mine/explore's own collection walk) and `bot.pvp` (combat) both maintain their
own internal `Movements` instances by default -- the exact "silently swapped back to a generic,
unconfigured Movements" bug already found and fixed once for each of them (§18-era). Both already
have their own `.movements` property reassigned to point at this SAME shared object
(`bot.collectBlock.movements = movements` / `bot.pvp.movements = movements`, both set once at
spawn) -- so `digCost` didn't need a second fix for either plugin, it's already the one object
every pathfinding caller shares. Checked `mineflayer-tool` too, the fleet's third pathfinding-
adjacent plugin -- it never touches `Movements` at all, nothing to fix there.

## 45. Real confirmation requested, real bug found instead: every furnace in the world was jammed (2026-09-21)

Direct request: "I want real confirmation they can use the crafting table and furnace." Not
satisfied by the code-level proof already given for mining (§ the prior turn) -- pushed for actual
live evidence. That investigation is what surfaced this section, not a clean confirmation.

**Live-testing attempt derailed into the real finding.** Gave Amy exactly the raw materials for a
controlled crafting-table test (oak logs, cobblestone, coal, raw iron) and set up background
watches for her and Mayor's own real craft/place/smelt results. Both watches ran their full
duration with zero events -- neither bot attempted a single real craft or place step, chewed up
instead by teammates repeatedly requesting away the exact materials just given (raw materials
aren't gear, so §40's give-downgrade rejection doesn't apply, correctly) and a `GOAL_TICK_MS`/
`IDLE_BEFORE_SELF_GOAL_MS` idle-reassignment gap left both bots without an active goal for
several minutes straight. Rather than keep fighting an increasingly artificial single-bot test,
broadened to a fleet-wide 24-hour log sweep for genuine (non-chest-substitution) craft/place/smelt
results instead.

**That sweep found something much more consequential than a missing positive example.** Crafting-
table usage does have real historical evidence earlier this session (§41's own investigation
directly observed a successful craft). Furnace usage did not: across all 9 bots, 24+ hours, **every
single smelt attempt failed**, with the exact same message -- `"found furnaces nearby, but couldn't
use any of them"` -- dozens of times per bot (Bob alone: ~80 occurrences). Not one successful smelt
anywhere in the fleet in that entire window.

**Root cause, confirmed directly from this codebase's own diagnostic logging** (the per-furnace
slot dump added back in the original smelt build, 2026-09-07) -- the two furnaces the fleet
actually uses were both jammed: `(94,63,64)` had 63 `coal_block` already sitting in its fuel slot
(coal_block smelts 800 items each -- effectively unlimited fuel) plus 16 `iron_ingot` stranded in
its output slot, uncollected; `(94,63,63)` had exactly 64 `coal_block`, the hard per-slot cap.
`"smelt"` called `furnace.putFuel()` UNCONDITIONALLY on every single attempt, with no check for
whether the furnace already had fuel. Once a slot maxes out, every subsequent `putFuel()` throws
`"destination full"` -- and the code treated that as fatal, aborting the entire smelt attempt
before it ever reached `putInput()`, even though the furnace already had far more fuel than it
could ever need. A textbook case of a well-intentioned safety action (topping up fuel so a bot
never runs out mid-smelt) becoming self-defeating once repeated by many bots against the same two
furnaces with no upper bound.

**Fix (`actions.js` 1.63.0), two parts:**
1. Collect any output already sitting in the furnace *before* adding new input -- recovers
   whatever a prior successful smelt (this bot's own or another bot's) left stranded, and frees
   the slot rather than leaving it jammed for the next attempt.
2. Treat a failed `putFuel()` as "already has enough fuel," not a fatal error -- log it and fall
   through to `putInput()` using whatever's already in the fuel slot, instead of aborting the
   whole attempt over a top-up that was never actually needed.

## 46. §43's fight-or-flee rule closed one loophole, live pressure found another: a healthy bot chased forever never escalates (2026-09-21)

Direct live follow-up: "they still wont fight back when pressured. Just found a single zombie in a
'house' with most of the bots, and it was systematically attacking them, with no reprisals from
the bots." Checked live immediately rather than assumed a regression -- §43's own rule was working
exactly as written; the live pressure surfaced a real gap in what "as written" actually covered.

**Confirmed live, not guessed.** Fleet health snapshot found Amy freshly recovering from a self-
defense fight she'd actually won ("threat while sleeping... post-wake defense: attack -> took care
of it") -- so the rule does work in general. The real, still-open case was Mayor: health steady at
16-20 (well above §43's `HALF_HEALTH` threshold), re-engaged by the SAME zombie roughly every 2
seconds (`SELF_DEFENSE_CHECK_MS`) for minutes at a stretch, "successfully" fleeing on nearly every
single trigger (`self-defense result: made it to safety. (ok=true)`, over and over). A few blocks
of separation in a cramped house isn't real safety when the zombie closes it again before the next
check fires -- so he never took enough CUMULATIVE damage to cross the health threshold, and never
escalated. §43's own `attackAsLastResort()` didn't help either, since it only fires on an outright
flee FAILURE (`!result.ok`) -- and these flees kept reporting success. Functionally "truly unable
to flee" in every way that matters to an observer watching a bot get harassed with zero reprisal,
even though the code's own bookkeeping showed a string of individual successes.

**Fix (`index.js` 2.80.0):** `decideFightType()` now tracks consecutive flee decisions and
escalates to fighting once they pile up (3 in a row without a long-enough real gap since the last
one), regardless of health or role -- the exact same underlying reasoning §43's own
`attackAsLastResort()` already established (repeated failure to actually resolve a threat means
fight, not another flee attempt), just triggered by repetition instead of an explicit failure
result. Resets on any attack (the standoff is broken) or once enough time has passed that a new
trigger is clearly an unrelated encounter, not a continuation of the same one.

## 47. "Can't get out of the home": §44's own digCost fix was a self-inflicted regression (2026-09-21)

Direct live report: "they can't get out of the home." Investigated immediately as a possible
regression from the last real pathfinding change (§44) rather than a brand-new, unrelated gap --
correctly, as it turned out.

**Confirmed live, precisely.** A position snapshot found 7 of 9 bots crammed into a single ~2x5
block area -- one shared shelter. Mayor's own logs showed **239** `path_update status=noPath`
results in a 2-hour window, and zero successful `mine`/`explore`/`gohome` actions in that entire
span -- not merely slow or costly travel, a hard, total inability to go anywhere.

**Root cause: `astar.js`'s own maxCost ceiling, not just a cost preference.** Read
mineflayer-pathfinder's actual search implementation: `this.maxCost = startNode.h + searchRadius`,
and any node whose cost exceeds it is **pruned from the search entirely** --
`if (this.maxCost > 0 && gFromThisNode + heuristic > this.maxCost) continue`. This codebase pins
`searchRadius` at 48 (`bot.pathfinder.searchRadius = 48`, an existing OOM-safety cap). For a nearby
goal (heuristic near zero -- exactly "get out of this small room"), the ENTIRE search budget is
only ~48-58 cost-units total. §44's `digCost = 30` meant a single dig on an ordinary block could
cost `(1 + 3*digTime/1000) * 30` -- **40-120+** on its own, consuming the whole budget in one step.
Not "more expensive, still findable" -- mathematically pruned, indistinguishable from a genuine
dead end to the search. §44's own stated goal ("she'll still dig through a genuine dead end... not
banned outright") was quietly false the entire time it shipped, for exactly the search-radius range
this codebase actually uses.

**Fix (`index.js` 2.81.0):** lowered `digCost` from 30 to 5. Still a real, meaningful 5x
discouragement over a plain walk step -- §44's actual goal (prefer doors/walking over wall-breach
shortcuts) is unchanged and still holds -- but a slow block's dig now costs comfortably under the
~48+ budget with room left for genuine walking alongside it, so a real exit is never mathematically
impossible again. The same class of risk exists in principle for `liquidCost` (20, unchanged, in
place since well before this session's own work) -- not touched here since it hasn't been
implicated in any live report, but worth remembering if a "can't cross water" symptom ever surfaces:
the search-radius-derived maxCost ceiling applies to every additive cost tuning in this file, not
just `digCost`.

## 48. "Can't get out of the home", part 2: a valid path was found, but executing its dig kept failing in an infinite loop (2026-09-21)

Direct live follow-up to §47, same underlying complaint. §47's `digCost` fix (30 -> 5) was
deployed and, in one important respect, confirmed working immediately: Luke -- left at the
original cramped location, unaffected by an unrelated teleport-safety-net that had moved three
other bots -- went from permanent `path_update status=noPath` to a genuine
`status=success nodes=4 visited=52 cost=24.5`, comfortably inside the ~48+ search budget. The
maxCost-pruning problem §47 diagnosed really was fixed: a valid route out was being found again.

**But finding the path wasn't the same as walking it.** The very next log lines showed
`path_reset: dig_error`, immediately followed by the IDENTICAL `path_update status=success
cost=24.5` being recomputed, immediately followed by another `dig_error` -- dozens of times within
about one second, with no sign of resolving on its own.

**Root cause, confirmed by reading mineflayer-pathfinder's own move-execution code
(`node_modules/mineflayer-pathfinder/index.js`):**

```javascript
bot.dig(block, true)
  .catch(_ignoreError => {
    resetPath('dig_error')
  })
```

Whatever the real reason `bot.dig()` failed is discarded outright (`_ignoreError`) -- the plugin
only ever tells the outside world "dig_error" happened, never why. `resetPath()` tears the current
path down with no cooldown and no memory of the failure; since nothing about the world changed,
the very next tick's recompute finds the exact same path and walks straight back into the same
failing dig. This is precisely the same failure shape §42 already fixed once -- but §42's fix
(disable `canDig` before pathfinding) was scoped narrowly to the "flee" action's own `goto()` call.
`gohome` and every other `bot.pathfinder.goto()` call site in this codebase never got the same
protection, so any of them can fall into the identical trap whenever their found route happens to
require a dig that keeps failing.

The specific per-block reason `bot.dig()` failed is invisible to us (the plugin swallows it before
it ever reaches this codebase's own error handling). The leading suspect, given 7 bots were packed
into roughly a 2x5 block shelter at the time: a teammate's own hitbox physically blocking line of
sight between the digging bot and its target block, which mineflayer's dig validity check rejects.
It doesn't materially matter which exact cause it is -- the fix needed to defend against the
*symptom* (an infinite tight retry loop that never makes progress) regardless of cause, the same
pragmatic stance `digCost`/`liquidCost` already took toward search costs rather than trying to
enumerate every possible obstruction.

**Fix (`index.js` 2.82.0):** a global burst detector on the existing `path_reset` listener. Four or
more `dig_error` resets within a 3-second window forces `movements.canDig = false` for 15 seconds,
so the very next recompute is walk-only -- a real building hit by this almost always still has a
door-based route once digging stops being on the table, which is exactly what direct reports have
been asking for all along (§44) over wall-breaching. The restore is timestamp-gated (`if (Date.now()
>= digSuppressedUntil) movements.canDig = true`) rather than an unconditional blind restore, so a
second burst that extends the suppression window can't be undone early by the first burst's own
stale timer. Deliberately global rather than scoped to one action (unlike §42's flee-only fix): the
underlying `path_reset`/`path_update` events this hooks are already fleet-wide diagnostics logged
for every action, and the user's complaint here was about ordinary travel (`gohome`), not flee --
the same class of bug can equally surface during `mine`/`explore`/pursuit, and this now defends all
of them at once from a single choke point instead of requiring an equivalent patch at every
individual `goto()` call site.

## 49. "Can't get out of the home", part 3: the real root cause for 4 of 9 bots was a missing server-side op grant, not pathfinding at all (2026-09-21)

Direct continuation of the same live incident (§47, §48). §48's dig_error diagnostic was deployed
and, while waiting for it to fire again, live evidence turned up a much more direct explanation for
why the fleet's own EXISTING self-rescue mechanism had never kicked in on its own.

**The fleet already has a designed-for-exactly-this escape hatch.** `teleportToSpawn()` (`index.js`,
originally 2026-09-07) fires when a bot reconnects at essentially the same spot `RESTART_STUCK_THRESHOLD`
(2) times in a row, or after `MAX_STUCK_NUDGES` failed nudge attempts -- it issues `bot.chat("/tp ...")`
to her own `bot.spawnPoint`, a real server-side teleport, not a pathfinding action, so it works even
when every walkable AND dig-requiring route is genuinely exhausted. Restarting the fleet for §47/§48
repeatedly tripped this exact mechanism live: Luke, Nell, Wade, Mark, Amy, and Dale each logged
`TELEPORT: reconnected at the same spot 3 times in a row -- heading back to spawn (87, 63, 68)`.

**But the position sweep after those restarts showed something wrong: Mayor/Mark/Luke/Babs/Amy's
positions actually changed to the new spawn coordinate -- Nell/Wade/Dale's did not, despite logging
the identical TELEPORT line.** `/tp` is an operator-only vanilla command; `bot.chat("/tp ...")` only
works if the bot account itself holds server op status. The code's own existing comment already
half-explained this ("Babs/Amy/Mark/Luke were added to ops.json at level 2 ... for exactly this") --
naming exactly the four `dgx-spark`-hosted bots, and silently leaving out all four `dgx-spark2`-hosted
ones (Bob/Nell/Wade/Dale). Confirmed directly via RCON `op <name>`: Wade, Nell, Dale, and Bob each
returned `"Made X a server operator"` (a real state change) where Mayor returned `"Nothing changed.
The player already is an operator"`. The four spark2 bots' own `/tp` self-rescue command had been
silently failing every single time it ever fired, for as long as they've existed on this server --
the log line claiming success was genuine (the command was issued), but the actual server-side
effect never happened, because permission was never granted for that host's bots at deploy time.

**This means the true, fleet-wide "can't get out of the home" incident was two independent problems
layered together, not one:** §47/§48's pathfinding fixes (digCost tuning, dig_error burst detection)
are real and correctly address the pathfinding side for whichever bots' self-rescue teleport DOES
work -- but for the four spark2 bots, no amount of pathfinding tuning could ever have gotten them out
on its own, since even a perfect path discovery still depends on the SAME dig-execution machinery
that (per §48) was failing for reasons still not fully root-caused; only the teleport escape hatch
truly guarantees an exit regardless of geometry, and it was silently dead for exactly the bots that
needed it during this incident.

**Fix, immediate (RCON, this session):** `op Wade`, `op Nell`, `op Dale`, `op Bob`, then `tp` each of
the three still-trapped ones (Wade/Nell/Dale; Mark/Amy had already self-rescued once granted op
retroactively enabled their own already-pending TELEPORT logic on the next trigger) directly to
spawn. All 9 bots confirmed physically out of the shelter afterward via a full RCON position sweep.

**Fix, durable:** grant is now live in the server's own `ops.json`, which persists across restarts
independently of this codebase -- no code change was required, since `teleportToSpawn()` was already
correct; it just never had permission to act on any of these four accounts. Worth adding to whatever
runbook covers onboarding a new bot account to this fleet: an op grant is as load-bearing as the
`config.json`/`ops.json` player entry that lets the account log in at all, not an optional extra, and
this gap went undetected for as long as it did specifically because a failed `/tp` produces no
client-side error mineflayer surfaces -- the log line for "I issued this command" and "this command
actually took effect" look identical from the bot process's own point of view.

## 50. Wall-vs-door regression: digCost alone can never satisfy both live reports at once (2026-09-21)

Direct report, immediately after §47/§48/§49 shipped: "now they are back to digging through the
wall instead of opening the door." This is the exact symptom §44 originally fixed -- and the
regression traces directly back to §47's own fix, which lowered `digCost` from 30 to 5 specifically
to stop exits from becoming mathematically unreachable (the maxCost-pruning bug). Both reports are
real, and both fixes were individually correct for the problem in front of them -- the two problems
just turned out to be in direct tension along the same single knob.

**Root cause, confirmed by measuring real `block.digTime()` values (the same call movements.js's
own cost formula makes), not assumed:**

| Block | Tool | digTime |
|---|---|---|
| cobblestone | none | 10000ms |
| cobblestone | netherite pickaxe, no enchant | 350ms |
| cobblestone | netherite pickaxe + efficiency 5 | 100ms |
| oak_planks | none | 3000ms |
| oak_planks | netherite axe + efficiency 5 | 100ms |

`laborCost = (1 + 3*digTime/1000) * digCost` means digTime alone scales the SAME digCost by
roughly **1.3x** for a well-tooled dig (common in this fleet -- multiple bots carry netherite gear
with efficiency 5) versus **31x** for an untooled one on the same block. No single flat `digCost`
value can sit in both safe ranges simultaneously:
- Strong enough to actually deter a well-tooled dig (needs roughly 15, giving laborCost ~19.5 --
  comparable to a real multi-block detour to an actual door) makes an untooled dig on the same
  block cost 400+, blowing straight past the ~48-58 search budget and reintroducing §47's exact
  pruning crisis.
- Safe against that crisis for an untooled dig (§47's own chosen value, 5) makes a well-tooled
  dig cost barely more than a plain walk step (~6.5) -- nowhere near enough to outweigh even a
  short detour to a door, reopening §44's original gap.

**Fix (`swim-movements.js` 1.1.0, `index.js` 2.84.0):** stop trying to solve both problems with one
number. `SwimMovements` now overrides `safeOrBreak` (a full reimplementation of
mineflayer-pathfinder's own method, matching the existing precedent set by this same file's
`getMoveDown`/`getMoveUp` overrides for water, since the library fuses labor cost into one returned
number with no way to isolate and clamp it after the fact) to cap the per-block labor-cost
contribution at `MAX_DIG_LABOR_COST = 20`, regardless of digTime. This decouples the two goals
entirely: `digCost` raised back to 15 restores real deterrence for the common well-tooled case
(19.5, just under the cap, so the cap doesn't even engage there), while the cap itself guarantees
no single dig step can ever again single-handedly exceed the search budget, no matter how slow or
untooled. Flagged, not fixed: a route requiring 3+ separate digs in one path could still approach
the budget even with each one individually capped (3 x 20 = 60) -- no live report has ever shown
more than one dig being the actual blocker, so this is left as an open flag rather than chased
further, the same posture already taken toward `liquidCost`'s own theoretical version of this risk.

## 51. §50's own cap flattened extreme-hardness blocks, freezing bots mid-combat (2026-09-21)

Direct live report, immediately after §50 shipped: "the group of bots is now standing in the open,
not moving or running, being actively attacked by a zombie -- automation failure." §50's own
flagged risk section didn't anticipate this specific shape, but it's the same underlying tradeoff
biting from a different angle.

**Investigation, live:** checked Luke specifically first, since his own logs showed something
concrete -- a real ~89-second span (16:05:28-16:06:57) where `checkSleepingThreat()` fired every 5
seconds, tried to acquire `SELF_DEFENSE`-tier arbiter control, and repeatedly failed
(`yielded to something more urgent (SELF_DEFENSE)`) before finally succeeding. Ruled out several
candidate causes directly: `checkSelfDefense()` never fired (gated on `!bot.isSleeping` the whole
time), no `path_update`/`path_reset` lines appeared at all during the freeze (ruling out a stuck
`flee` pathfind), and `attack`'s own poll loop is bounded by `ACTION_TIMEOUT_MS` with no way to
hang indefinitely by design. The ~89-second duration itself turned out to be the real clue once a
second, independent data point landed: a live fleet-wide log sweep showed Mayor, Nell, and Bob all
independently hammering `dig_error target: netherite_block` at nearly the same home-base
coordinates, in rapid repeating bursts.

**Root cause, confirmed by measuring real digTime (not assumed):** `netherite_block` and
`obsidian` take **75000ms** to dig even with a netherite pickaxe + efficiency 5 -- hardness 50
barely responds to efficiency at all, unlike ordinary blocks. §50's own `MAX_DIG_LABOR_COST` cap
(added to make raising `digCost` safe again) clamps the labor-cost contribution of EVERY diggable
block to the same ceiling regardless of actual hardness -- so a block that should cost 3000+ in the
search's own cost function (and therefore never look worth attempting) instead reads as identically
"cheap" as a plank wall. Pathfinder kept choosing this route, starting a real 75-second dig attempt
-- and almost immediately getting interrupted by some OTHER periodic check in the same process
(`checkSelfDefense` alone runs every 2 seconds), which calls `bot.stopDigging()` as part of its own
normal physical-interrupt sequence, aborting the in-flight dig. mineflayer-pathfinder reports this
exactly like any other dig failure (`dig_error`), and with nothing about the world having changed,
the next tick recomputes the identical "cheap" route into the identical abort -- forever, or until
something external breaks the cycle. During combat this is precisely what "frozen, not moving, not
fighting" looks like from outside the process: `attack`'s own chase-to-target movement shares the
exact same `movements` object (`bot.pvp.movements`, pointed at it since an earlier fix), so it
thrashes on this same loop instead of ever closing distance or landing a hit. This also
retroactively explains Luke's own ~89-second freeze -- the same failure shape, whichever specific
high-hardness block his own route happened to touch.

**Fix (`index.js` 2.85.0):** lowering `MAX_DIG_LABOR_COST` back down would simply reopen §50's own
wall-vs-door regression -- the real fix is to stop letting the cap apply to blocks no reasonable
cost tuning should ever call "cheap" in the first place. `movements.blocksCantBreak` already
excludes furnaces/chests/doors from casual auto-dig-while-routing without making them permanently
unbreakable outright (a bot that wants one gone can still act on it deliberately) -- the same
reasoning extends naturally to real hardness. Every block with `hardness >= 10` is now added to
`blocksCantBreak`: a wide, deliberately conservative gap, chosen from the real registry values, not
guessed -- every normal terrain/building material this fleet actually touches tops out at hardness
5 (`iron_block`, `diamond_block`, `coal_block`) or well under (`stone` 1.5, `deepslate` 3), while
`obsidian`/`netherite_block`/`ancient_debris`/`crying_obsidian`/`respawn_anchor` all sit at 30-50 --
nothing real falls in between. Deliberately kept separate from `isProtectedBlockName()` (which also
drives "mine"'s own deliberate-target refusal, with an explicit "that's a placed/crafted block"
message) rather than folded into it -- a bot that deliberately wants to reclaim a stored
netherite/diamond/iron block via "mine" still can; this only stops pathfinder from treating one as
an incidental shortcut while routing to somewhere else entirely. Verified live post-deploy: zero
`netherite_block` dig_error occurrences from any bot's fresh process since restart, versus the
old process still producing them right up until it was replaced.

## 52. "Zombie is in the building again": flee's own home-fallback breaks when the threat is already inside (2026-09-21)

Direct live report, immediately after §51 shipped: "zombie is in the building again, attacking the
crowd of bots." Live evidence showed something different from every prior incident in this chain:
bots were NOT frozen and NOT silent -- every one of them was actively attempting both `attack` and
`flee` in response, and both kept failing. `attack` repeatedly timed out ("gave up on the fight --
took too long"); `flee` repeatedly returned `"No path to the goal!"` within 2-4ms -- fast,
consistent failures, not an exhausted search.

**Root cause:** `nearestRallyPoint()` (added 2026-09-18, "run towards safety, run towards golems, or
soldiers") falls back to the bot's own home/bed when no golem or Soldier teammate is in range, on
the explicit original assumption that home is "always a safer place to end up... even with nobody
there." That assumption fails completely in exactly this incident's shape: the threat is already
INSIDE home, and most of the fleet is already there too. Fleeing "toward home" when already
effectively home is either a no-op, or -- when the bed sits in a different room of the same
structure than wherever she's currently cornered -- asks pathfinder to route all the way across the
building to one specific point instead of taking one step toward any nearby exit, which is both far
more likely to fail outright and, even when it succeeds, walks her further INTO the same building
the threat occupies rather than away from it.

**Fix (`index.js` 2.86.0):** `nearestRallyPoint()`'s home/bed fallback now only returns a value when
that point is at least 20 blocks from the bot's current position -- real progress toward a
genuinely different, farther-away place. Closer than that, it returns `null`, letting `flee` fall
through to its own original plain maximize-distance goal (`GoalInvert(GoalFollow(target, 16))`),
which needs no specific destination and only requires finding ANY nearby improvement in separation
-- far more resilient to "already home, threat inside" than a fixed-point route across the building.
Immediate relief for the live incident: RCON-killed the zombie directly while this was being
investigated, same pattern as prior live incidents in this chain.

## 53. Full defense-scheme re-evaluation after a mass-death incident (2026-09-21)

Direct request: "standing right out in the open, a single zombie is killing bot after bot.
Re-evaluate the entire defense scheme." A live log sweep during the incident found something far
more serious than any single prior bug in this chain: **5 bot deaths within roughly 90 seconds**
(Mayor died 3 times, Bob, Mark, and Luke each died once, several "in quick succession" per this
codebase's own rapid-death tracking), despite RCON confirming only **1-2 zombies** were actually
involved -- a fight 9 bots should never lose, let alone this badly. Rather than patch another single
mechanical bug, this section covers a genuine architectural review.

**Systemic findings, in order of impact:**

1. **EMERGENCY-tier combat had no escape hatch.** §43's rule ("Soldiers fight always, others fight
   under half health") made `decideFightType()` return "attack" unconditionally once health drops
   to `EMERGENCY_HEALTH_THRESHOLD` (6) or below -- correct as a FIRST choice, but until now that
   commitment rode out the full `ACTION_TIMEOUT_MS` (90 seconds) no matter how the fight was
   actually going, with `HEALTH_CRITICAL` sitting above every other real-combat arbiter tier so
   nothing could preempt it. Confirmed live: Wade's own logs showed `self-defense: yielded to
   (HEALTH_CRITICAL)` repeating for **over 20 straight seconds** -- a single stuck emergency attack
   holding control that entire time while he stayed at critical health with zero ability to
   reconsider. Every second spent in a fight that isn't working is a second closer to death with no
   upside once already this hurt.

2. **Severe entity crowding degrades both movement and combat execution.** Most of the fleet sleeps
   in one small shared area (the same "home" location this whole investigative chain keeps
   returning to). Live logs during the incident showed constant `path_reset: stuck` for whichever
   bots were packed tightest -- a "success" path immediately followed by getting stuck again a few
   seconds later, recomputing trivial 1-3-node routes that never actually complete.
   mineflayer-pathfinder's own `entityCost` (default 1, the same magnitude as a single walk step)
   barely discourages routing through a square another bot occupies -- with 7-9 entities packed
   into a tight space, nearly every route touches an occupied square, and Minecraft's real collision
   (unlike the search's own cost model) can make that square genuinely unreachable at execution
   time even though the plan said "success." This plausibly also explains why `attack` kept timing
   out despite overwhelming numbers -- bots very likely getting in each other's way trying to reach
   the same one or two targets in a cramped space, the same contention shape already confirmed for
   digging (§51's own investigation, Amy/Mark both targeting the same block simultaneously).

3. **Squad response structurally can't help in exactly this scenario, though not because of a bug.**
   `respondToSquadCall()` acquires `SQUAD_RESPONSE` (priority 20), below `SELF_DEFENSE` (30) --
   correct in principle (a bot's own survival should outrank rushing to help someone else), but
   moot here regardless: the whole point of squad response is bringing a distant bot TO the fight,
   and here everyone was already there. The real gap isn't coordination-at-a-distance, it's that
   crowded close-quarters combat itself (finding #2) wasn't reliable.

4. **Flagged, not fixed: home lighting.** Recurring `"no torches ... skipping for now"` log lines
   throughout this session's history mean the sleeping area likely isn't reliably lit, letting
   hostiles keep spawning there at all -- the true upstream cause of a zombie being available to
   attack a sleeping crowd on a semi-regular basis. This is a resource/logistics gap (torch supply
   chain), not a defense-logic bug, and is flagged here for separate follow-up rather than addressed
   in this pass.

**Fixes shipped this section:**

- **`EMERGENCY_ATTACK_TIMEOUT_MS` (8s) + `fleeAsLastResort()` (`index.js` 2.87.0, `actions.js`
  1.64.0):** "attack" now accepts an optional `action.maxDurationMs` (defaults to the unchanged
  `ACTION_TIMEOUT_MS` for every other caller). EMERGENCY-tier attacks use the new 8-second ceiling
  instead -- still the first choice at critical health, per §43's own direct instruction, unchanged
  -- but a fight that isn't won within that short, bounded window now falls back to `flee` (mirroring
  `attackAsLastResort`'s own existing shape in the opposite direction) instead of continuing blind
  for up to 90 seconds with nothing able to intervene.
- **`movements.entityCost` raised from the library default (1) to 8 (`index.js` 2.87.0):** same
  "strongly prefer, don't forbid" tuning already applied to `liquidCost`/`digCost` -- routing around
  a crowd is now preferred whenever an alternative exists, while a genuinely crowd-only route
  remains possible rather than refusing to move at all.

Immediate relief for the live incident: RCON-killed 2 zombies directly (confirming the true mob
count) while this investigation was underway.

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
| 1.14.0 | 2026-09-11 | New §16: two enhancements from a Project Sid research pass ("what other ideas... from Project Sid or similar research" -> "so both"). (1) Chat/action coherence: `generateReply()`'s CHAT-reply path had no grounding in real goal state, unlike `classifyIntent`'s own ACTION/GOAL branches — new `currentActivityNote()` closes it (`index.js` 2.62.0). (2) Adaptive role-leaning: new `otherBotActivityAt` (timestamped for free alongside `otherBotGoals`) and `lastRoleActivityAt()` feed `roleBiasNote()` an adaptive nudge toward a neglected secondary role, echoing Sid's own finding that specialization required tracking other agents' activity. Economy/trading and government/voting considered and explicitly not pursued — §16.3 has the reasoning. |
| 1.15.0 | 2026-09-12 | New §17: a live incident, root-caused from 6+ hours of real logs rather than guessed. Direct report ("still not functional") named three symptoms; found one real root cause behind most of it — `nextBuilderPriority()`'s infinite loop on a stuck item (furnace) meant beds never got attempted, causing a real sleep-deprivation phantom swarm (1473 threat-detections in 2 hours) that then overwhelmed otherwise-working self-defense/squad-response. Fixed: a per-item stall counter (`index.js` 2.63.0) and `checkHomeLighting()`'s own bed/spawnPoint bootstrapping catch-22. Independently fixed the actual chest bug (`tryTakeFromNearbyChest()`'s single-slot threshold, `actions.js` 1.51.0). The literal "crafting table not found" claim had no matching log evidence in the window searched — flagged honestly, not papered over with an unverified fix. |
| 1.16.0 | 2026-09-13 | New §18: another live incident, scoped to daytime per the operator's own request. Found the dominant cause of "generally ineffective" — stale "NO ability to build... respond BLOCKED" prompt text in both `planNextStep` and `proposeOwnGoal`, directly contradicting their own `ACTION BUILD` vocabulary a few lines later, self-sabotaging ~78% of all goal-blocked outcomes (`index.js` 2.64.0). "Can't use doors" traced to `mineflayer-collectblock` silently resetting `pathfinder`'s movements on every `mine`/`explore` call — the same bug class already fixed for `mineflayer-pvp`, never applied here. "Hallucinate their achievements" confirmed with hard evidence (a beehive announced complete twice while never actually placed) and fixed with `builderPriorityItemSatisfied()`, re-verifying real world state instead of trusting inventory possession for compound "craft AND place" directives. |
| 1.17.0 | 2026-09-13 | New §19, direct follow-up to answering "do bots check world memory for chests/tables/resources?" honestly (partially, with real gaps) with "extend... to *any* resource or crafted object." `getResourceBlockNames()` (`actions.js` 1.52.0) replaces a hand-picked 4-item list with every real ore/log this server's registry has. Found and fixed a second, separate bug while extending it: the scout-broadcast receiver never actually checked the requested resource, only logged its name. New `known_chests.json` registry gives chest contents real structured tracking (not a RAG note) — every real interaction snapshots current truth, so "remembering" and "redacting" are the same operation. Doors/trapdoors/fence gates finally added to `isProtectedBlockName()`, closing the same "diggable by the library's own definition" gap already closed for furnaces/beds/chests. |
| 1.18.0 | 2026-09-13 | New §20: direct follow-up report ("still detroying chests") turned out to have no bot-code cause at all — every block-removing verb and the protection list were re-checked and confirmed clean. Operator's own direct observation ("Chests that were full were no longer present when I returned") pointed outside the codebase; root cause was the live server's `mob_griefing` gamerule (creeper-explosion block destruction), left `true`. Fixed via RCON using the same Vaultwarden/paramiko pattern as `tools/hermes-game-server-monitor.py` — first attempt failed on a Brigadier parse error that looked like a connectivity problem but was actually this server's Minecraft 26.1.2 snake_case gamerule renaming (`mob_griefing`, not the legacy `mobGriefing`); confirmed `false` after correcting the name. No code changed — a server-config fact, not a repo regression. |
| 1.19.0 | 2026-09-13 | New §21, direct request ("soldier personas need to..."). Audited the existing alarm/combat code first rather than guessing, and found four real gaps behind it: (1) `SQUAD_RESPONDER` was gated only by an env var, disconnected from `roles.js`'s own SOLDIER assignment — now derived from the role itself. (2) The two moments a bot most needs help (health-critical emergency, asleep-under-attack) never called `broadcastThreatAlert` at all — new shared `noteThreatSeen()` closes it for all three sites. (3) No death awareness existed in any form — new `broadcastDeathAlert` (position + best-guess killer) fires on every death, logged fleet-wide, with Soldiers securing the spot. (4) Soldier's own `priorities` list was pure advisory prompt text, never enforced — new `nextSoldierPriority()` (`index.js` 2.66.0) mirrors Builder's §15.6 deterministic-checklist shape: no weapon beats everything, then a nearby hostile, then falls through to the existing secondary-role lean for item (c). `equipment.js` 1.3.0 exports `hasWeapon()` for the check. |
| 1.20.0 | 2026-09-13 | New §22, direct request ("rebalance the bots so they each have exactly one role... create [more] so every role has at least one bot"). Every `BOT_ROLES` secondary set to `null` (`roles.js` 1.4.0); three new bots (Nell/Artist, Wade/Explorer, Dale/Herder) built at full persona depth to own the three roles that previously existed only as somebody's secondary, growing the fleet from 6 to 9. Existing 6 bots' primaries left untouched rather than reassigned — redundant Soldier coverage (Mark+Luke) kept deliberately. Caught and fixed a real regression before shipping: `proposeFallbackDirective()`'s Mayor-fallback mechanism was gated on a secondary role field about to be nulled fleet-wide — decoupled into its own `MC_FALLBACK_COORDINATOR` env flag. Amy/Babs/Mark/Bob's `PROMPT.md` files cleaned of now-stale secondary-role prose rather than left to drift. |
| 1.21.0 | 2026-09-13 | New §23, direct follow-up ("Reset their tech tree progress. The leader should... only assign tasks to idle bots, and... prioritize tasks in their role. Soldiers should not get tasks beyond equipping weapons and armor, and fighting off monsters"). Tech-tree progress checked, not assumed reset — `mayor-curriculum.json` never existed on disk at all (curriculum never actually advanced past stage 0 across this whole session's many Mayor restarts, each one silently wiping in-memory `stageProgress`); this deploy's own restart completes a genuine fresh start. "Idle bots only" audited and found already correct — no code changed. Real gap closed: `proposeDirectiveForOthers()`'s curriculum-stage branch never mentioned the target's role at all; new shared `SOLDIER_DIRECTIVE_NOTE` now gates a Soldier target to gear+combat-only in BOTH leader-directive functions (Mayor's own and Mark's fallback stand-in), matching `nextSoldierPriority()`'s own §21 scope exactly, and `checkCurriculumAdvance()`'s fleet-wide gate now excludes Soldiers so the curriculum can't stall waiting on a farming/enchanting task they'll never be assigned. Also fixed a second stale claim caught while in this code: `proposeFallbackDirective()`'s prompt still said Mark "carries Leader as a secondary role," true before §22, false since — reworded to describe his actual standing. |
| 1.22.0 | 2026-09-14 | New §24, direct report ("generally stationary... route can't be resolved / can't reach you, even with nothing in the way"). Root-caused with hard numbers, not guessed from the doors/pathfinding angle the symptom suggested: Mark alone saw 268 self-defense triggers in one hour (240 phantoms) and 1,608 pathfinder goal-resets in 15.5h — every real travel goal was getting force-cancelled by the next re-trigger roughly every 13 seconds before it could finish. Fixed: a 20s `FLEE_MOB_RESPONSE_COOLDOWN_MS` throttles re-triggering on FLEE-ONLY mobs specifically (`index.js` 2.69.0) — melee threats keep their full, immediate response. Also fixed the scaling gap feeding the underlying phantom-swarm feedback loop (§17, recurred): the Builder bed target was still hardcoded to the old 6-bot fleet's `>= 6`, now `BOT_USERNAMES.size` in both `nextBuilderPriority()` and `builderPriorityItemSatisfied()`. Separately discovered while chasing a `mob_griefing` angle: §20's RCON fix hit the WRONG Minecraft server entirely — the real bot world (port 25580, `minecraft-bots.service`) has RCON deliberately disabled and was never touched. Blocked on a safety-classifier denial for the config edit and a missing sudo grant for the restart, both of which needed the operator — who did both directly (new Vaultwarden item, config edit, service restart), catching and fixing one snag along the way (`enable-rcon` itself hadn't actually flipped on the first attempt). `mob_griefing` confirmed `true` → `false` on the real server this time; all 9 bots reconnected after the server-side restart (confirmed mineflayer does not auto-reconnect on a server-initiated disconnect — every bot needed its own systemd restart to rejoin). |
| 1.23.0 | 2026-09-14 | New §25, direct request ("I changed the seed value manually. re-init the world using the new seed"). Confirmed live first that editing `level-seed` alone does nothing to an existing world — RCON's own `seed` command still reported the ORIGINAL seed after the operator's edit. Re-init used §24's now-working RCON end-to-end, no sudo/operator step needed: `save-all flush` + `stop` over RCON, relying on `minecraft-bots.service`'s own `Restart=always` to bring it back up; old world directory moved (not deleted) to a timestamped backup, matching four earlier `firmament-bots.bak-*` snapshots already on disk from prior resets. A real race in the first attempt's own "wait for exit" check (a `pgrep` match on an unrelated server owned by a different Unix account, plus a `kill -0` permission-denied misread as "already exited") was caught by verifying the actual end state directly — the boot log's "No existing world data, creating new world" line and RCON's own `seed` readback confirmed `694200161758793929` — rather than trusting the script's own report. All 9 bots reconnected and confirmed spawned into the new world (a visibly different spawn region from the old one). Direct follow-up ("re-check the anti-griefing setting"): `mob_griefing` had reverted to `true` on the new world — expected, since gamerules live in the world save, not `server.properties`, so any future re-init needs this re-applied as a checklist step, not assumed carried over. Re-confirmed and re-set to `false` via RCON. |
| 1.24.0 | 2026-09-15 | New §26, direct request ("do some benchmarking of using coder... or coder2, for planning and bot behavior tactics. Search the internet for the experience and findings of others"). Ran `planNextStep()`'s real, unmodified production prompt against `dispatch`/`coder`/`coder2` directly through `hermes-router.py`'s live endpoint across 3 scenarios targeting documented `dispatch` failure modes. Real, mixed result: `dispatch` stayed fastest (1.6-5.9s) but produced a genuine parameter-format bug (used an input material as a SMELT output id) and deviated from an explicit in-prompt rule; `coder` matched `dispatch`'s correctness on the two tests where they diverged at moderate latency (7.7-8.8s); `coder2` was the most rule-compliant but impractically slow (34-55s) with one empty response outright. No routing change made — evidence recorded, decision left to the operator. Web research found no source (this project's own history or the wider Minecraft-LLM-agent community, including kolbytn/mindcraft and the Andy/Mindcraft-CE project) reporting a real code-vs-general-model comparison for this exact task; the community's own leading local model (Andy-4.2) is built on a general Qwen base with task-specific fine-tuning, not a code-specialized checkpoint. |
| 1.25.0 | 2026-09-15 | New §27, direct request ("check the logs since the last review... look for behavioral gaps"). Confirmed the §24 phantom throttle is working (85-87% fewer triggers, real travel now completing) and no repeat of the original mass-death incident at anywhere near its original scale. Confirmed, root-caused, and fixed a real §23 regression: Mark logged 909 doomed "gave up on the fight" self-defense results in 34h because `checkSelfDefense()` never checked weapon possession before choosing "attack" -- a bare-handed fight against nearly anything can't land enough hits inside `ACTION_TIMEOUT_MS`, so SELF_DEFENSE-tier control was held almost continuously, starving the "go get a weapon" directive of any real execution window and explaining the chronic `iron_sword` DONE-hallucination without the verification logic itself being at fault. Fixed in `checkSelfDefense()`/`checkSleepingThreat()`/`respondToSquadCall()` (`index.js` 2.70.0): flee (or decline to engage) whenever `hasWeapon(bot)` is false, same reasoning already established for `FLEE_ONLY_MOBS`. Separately closed `nextSoldierPriority()`'s own fall-through-to-unrestricted-freeform gap (returned `null` once armed with nothing nearby, exactly how "craft a pickaxe" got self-proposed) -- now always returns a directive for a Soldier-primary bot, ending in a "stand guard" fallback rather than ever reaching freeform. Flagged, not fixed: a recurring `sqlite3` `UNIQUE constraint failed on vec_chunks` traceback affecting only the 5 bots co-located on `spark`, never causing a crash -- shared Firmament memory/RAG infrastructure, a distinct investigation of its own. |
| 1.26.0 | 2026-09-16 | New §28, direct report ("the bots do not appear to be active in world") -- caught a false-positive in the immediately preceding "check bot status" turn. RCON's `list` showed 0 of 9 bots actually connected while every systemd unit still reported active with normal-looking logs. Root cause: a real `keepAliveError` disconnect (coinciding with an independent game-server process restart) was only ever logged by `bot.on("end")`, never acted on -- every `setInterval` check kept firing against a dead connection for 2+ hours, some resolving with fabricated success ("slept through the night," "nothing left to fight"). Fixed (`index.js` 2.71.0): `bot.on("end")` now exits the process, handing recovery to the same `Restart=always` systemd machinery already proven for OOM crashes. |
| 1.27.0 | 2026-09-16 | New §29, direct request ("backup the current world into a restoration point... I want to be able to restore to the current state"). Stopped the server cleanly via RCON (`save-all flush` + `stop`, PID-verified exit) rather than tarring a live world, for a genuinely consistent snapshot — `cp -a` to `firmament-bots.RESTORE-POINT-20260916-152257` (21M). `Restart=always` brought the live world back up untouched (confirmed via the boot log and a same-seed RCON readback), and §28's `process.exit(1)` fix fired for real for the first time: all 9 bots reconnected on their own, no manual restart needed. Documented the exact restore procedure for later use, and flagged that a restore rolls back the world only, not each bot's own separately-persisted goal/curriculum state. |
| 1.28.0 | 2026-09-17 | New §30, direct request ("they loot EVERYTHING instead of what they need"). Confirmed the complaint first — "loot" really did sweep every stack, a deliberate 2026-09-07 choice being explicitly reversed now. `ACTION LOOT` gains optional `<item_id> <count>` (both classifyIntent and planNextStep vocabularies, `index.js` 2.72.0), reusing `tryTakeFromThisChest()` — the same need-based helper MINE/CRAFT's own chest-first fallback already used — so there's one "take up to N from a chest" implementation, not two (`actions.js` 1.54.0). Omitting the item is now the only way to "just look": inspects and snapshots contents without taking anything. "Put leftovers in a chest" needed no new mechanism — verified `storeSurplusNearHome()`/`checkInventoryFull()`/`checkInventoryInsurance()` already cover it generically; added a targeted-loot trigger to the existing post-craft immediate-cleanup pass. "All chest contents go to world memory" was already true via §19's `known_chests.json` — verified rather than rebuilt, deliberately not duplicated into the RAG corpus too (mutable-state fit problem §19 already reasoned through). |
| 1.29.0 | 2026-09-17 | New §31, direct request ("if they craft armor or weapons or tools, they should equip them"). `refreshGear()`'s own comment claimed this was already handled but `equipBestWeapon`'s `WEAPON_SUFFIXES` never covered pickaxe/shovel/hoe — same comment/code drift pattern §22 already caught once. "craft" now equips the specific item just crafted when it's one of those three (`actions.js` 1.55.0), not a tier comparison. Auditing "attack" while making this change found a real, independent gap: it never re-equipped a weapon before engaging, only after a fight ends — low-risk before, a real exposure now that a freshly-crafted tool stays held. `equipBestWeapon()` now runs at the top of "attack" too. |
| 1.30.0 | 2026-09-17 | New §32, direct follow-up ("dig in") to a hallucination review that found both detection mechanisms firing correctly (~2,160 catches, 26h, no missed hallucinations) but two standout chronic loops. Root-caused Amy's chained furnace→beds→shelter loop live: verified she's been repeatedly pinned at critically low health near "home" (5.17/20 historically, confirmed *currently* at 1/20 against a persistent creeper while investigating) — traced to `checkHomeLighting()`'s "no torches" early exit being completely silent, so a resource-starved bot could leave home permanently dark with zero log trace of why, feeding a dark-home → mob spawns → pinned health → can't finish shelter/torches → still dark cycle (also plausibly explaining the dense multi-mob swarm window from the original review). Torches need no crafting table (confirmed against `bot.recipesFor()`'s own table-less lookup) — `checkHomeLighting()` (`index.js` 2.73.0) now crafts some herself when she has fuel+stick, and always logs when she can't. The "get a sword" loop's cause (verified for Mark): a genuinely crafted sword given away to a teammate, then retries drowned out by a real flood of squad-response combat interrupts — not a new bug, not separately fixed. |
| 1.31.0 | 2026-09-18 | New §33, direct request ("if the bot is in need of a piece of equipment... and finds one already crafted in a chest, it should pick up ONE of those pieces... and abandon the quest to craft it"). Craft/loot chest-substitution already existed and worked, but only ever matched the EXACT item id named — a chest's `iron_pickaxe` was invisible to a `craft wooden_pickaxe` check. New `gearCategoryNames()` (`actions.js` 1.56.0) broadens matching to every real tier sharing the same `GEAR_SUFFIXES` suffix, wired into "craft" and both of "loot"'s matching passes; deliberately left raw materials untouched (no "any tier" concept applies to an ingot). "Abandon the quest" needed no new mechanism — the real substituted item already lands in the next `planNextStep` tick's own gear snapshot, and the existing real-world-state DONE-verification closes the goal on its own. |
| 1.32.0 | 2026-09-18 | New §34, second hallucination review this window. Verified two of the prior review's headline claims directly instead of reporting them as-is: the §32 torch fix was genuinely inert (confirmed why — Amy's self-defense force-cancels action mid-craft every few seconds, so fuel and sticks were essentially never in inventory simultaneously), and Mark really was gifted two swords by teammates and remained swordless — because he died between the two gifts. Chased that one further and found the actual root cause behind both, and most of the fleet's chronic gear churn: 1,555 deaths fleet-wide in 33 hours (~1 every 42 minutes/bot) against a live `keep_inventory=false` gamerule, dropping each bot's entire inventory on every death with no recovery mechanism anywhere in the codebase. Not a repo bug — same shape of finding as §20's `mob_griefing` discovery. Operator chose a live RCON fix (`gamerule keep_inventory true`, confirmed set) over a code-side death-recovery behavior. Also corrected a third claim from the same review: Nell's reported "flower garden" dead-end loop is actually completing regularly (22 of 38 self-proposals logged `goal complete`) — a repetitive low-variety self-propose pattern, not a hallucination. Flagged, not fixed: `nextBuilderPriority()`'s hardcoded `beehive` checklist item has no fallback when its prerequisite chain is structurally unreachable, unlike Soldier's own priority list. |
| 1.33.0 | 2026-09-18 | New §35, direct request ("turn down the spawn rate, especially of phantoms"). While checking what levers actually exist, found and fixed a real tooling gap: the RCON client reused since §20 only ever read a single response packet, silently truncating any multi-packet reply — `help gamerule`'s real output was being cut off mid-list. Fixed with the standard sentinel-packet read-until-echo pattern, which then revealed this server build exposes a `spawn_phantoms` gamerule beyond standard vanilla (boolean only, no partial rate). Given phantoms' consistent role as the dominant disruptive threat across §17/§24/§27/§34, operator chose to disable them outright (`gamerule spawn_phantoms false`, confirmed) rather than a partial measure that doesn't exist here. Also dropped difficulty Normal → Easy (`difficulty easy`, confirmed) for general (non-phantom) spawn/damage reduction, offered and chosen as a separate decision since it's a broader change. No code changed — both live RCON commands, same category as §20/§34. |
| 1.34.0 | 2026-09-18 | New §36, direct live report ("Luke is getting shot, not reacting. there is no mass mob"). Verified live via RCON and fresh logs rather than guessed — real skeleton, real damage, `nearestHostile()` working correctly. Root cause: Luke's self-defense had been holding SELF_DEFENSE-tier control on an unresolved `attack (threat=enderman)` for 90+ seconds, silently blocking any response to the separate skeleton sniping him the whole time — not a detection bug, a target-monopolization one, only broken by the unrelated EMERGENCY health-critical flee once he'd dropped to ~6 HP. Confirmed not a one-off: Mark/Luke (the two bots willing to melee-attack rather than flee) logged 2,800/1,770 enderman self-defense triggers in 24h, far above every other bot — endermen's teleport-evasion defeats `bot.pvp`'s chase-and-melee almost as thoroughly as literal flight does for phantom/ghast. `FLEE_ONLY_MOBS` (`actions.js` 1.57.0) now includes `enderman`, same treatment as the existing two entries. Trade-off accepted deliberately: bots no longer fight endermen at all (no more self-defense ender pearls) in exchange for closing a confirmed "gets shot with zero response" failure mode. |
| 1.35.0 | 2026-09-18 | New §37, direct follow-up ("why aren't the soldier bots coming to defend Nell?" -> "have the threatened bot run towards safety, run towards golems, or soldiers"). Traced live: Nell was genuinely ~70 blocks from both Soldiers, outside `SQUAD_ASSIST_RANGE` (48 blocks) -- `withinSquadAssistRange()` silently drops out-of-range alerts with no log line, a deliberate bound, not a bug, but it leaves far-ranging bots with zero backup. Immediate danger cleared via RCON (same pattern as §29). Root cause of the underlying request: "flee" never had a destination, just maximized distance from the threat with no regard for where that led. New `nearestRallyPoint()` (`index.js` 2.74.0) checks, in order, a nearby iron golem (`nearestFriendlyGolem()`, `actions.js` 1.58.0), a nearby Soldier teammate via each bot's own already-tracked `bot.players`, then home -- wired into all three flee-triggering sites via a new `action.rallyPoint` field; "flee" now heads straight there when one exists, falling back to the original away-from-threat behavior otherwise. |
| 1.36.0 | 2026-09-18 | New §38, direct live report ("I am watching a spider attack Mark as he doesn't react") that turned out to be one visible thread of a much larger nighttime mob crisis: RCON found Dale at 1.7 HP and 7+ deaths fleet-wide inside under a minute. Stabilized live via RCON mob-clear plus 11 real torches placed directly at `bot.spawnPoint` (verified held, not popped). Operator chose "do both" -- also dug into why `checkHomeLighting()` has now failed THREE times running (2026-09-10, §32, and tonight): confirmed its gate only ever checked the running bot's own personal inventory at the exact moment its 90s check fires, and across a fleet with constant self-defense interrupts, no bot is ever reliably both free and stocked at once -- the general mechanism behind all three failures. Fix (`index.js` 2.75.0): tries a chest first via the existing "loot" action's local-then-remembered-chest search before ever falling back to personal-inventory crafting. |
| 1.37.0 | 2026-09-19 | New §39, direct request ("expand their search capabilities further, especially the miner and explorer roles. make *sure* that discovered resources are being stored in world memory"). Audited existing memory-write paths and found a real, confirmed gap: a successful MINE never wrote a world-memory note at all, only a failed one did -- fixed (`index.js` 2.76.0) by extending explore's own existing success-note mechanism to mine too. Also confirmed neither Miner nor Explorer has ever had deterministic search logic (unlike Soldier/Builder) -- added env-tunable per-bot search radius (`MINE_SEARCH_RADIUS`/`EXPLORE_SEARCH_RADIUS`/`EXTENDED_SEARCH_DISTANCE`, `actions.js` 1.59.0, same pattern as `MC_SELF_DEFENSE_RANGE`) now set larger on Babs/Wade's own systemd units, kept under the documented 48-block pathfinder OOM ceiling; and new `VILLAGE_INDICATOR_NAMES` (bell, composter) gives Explorer's own stated "locate a village" priority a real, note-only search target for the first time. Both mine and explore now also trigger a full `noteNearbyResources()` sweep on success, not just a note about the one target. |
| 1.38.0 | 2026-09-19 | New §40, direct request ("Mayor/Leader missions, if they would effectively DOWNGRADE a bot's equipment or status, should be rejected by the bot"). Found the concrete mechanism rather than a general directive classifier: Mayor's own directives are plain chat, routed through the same classifyIntent pipeline as anything else, and the one real gear-loss vector -- "give" (`actions.js`) -- never checked whether complying would leave the giver without a weapon/armor/tool she needs. Fixed (1.60.0): refuses when giving would take an item's whole category (sword/axe as one interchangeable weapon category matching `hasWeapon()`, armor/tools each their own) from "has one" to "has none" -- a genuine spare is still always fine to give. Refusal is a real, visible `fail()`, not a silent no-op. |
| 1.39.0 | 2026-09-19 | Extended §40, direct follow-up ("the downgrade rejection must also reject if the mayor's instructions would cause the quality of their equipment to be reduced"). Going to zero was only half of it -- giving away her best piece in a category while a worse one stays behind is a downgrade too. New `GEAR_TIER_RANK` (`actions.js` 1.61.0, a single common-sense material ranking, not a precise armor-point/mining-level simulation) lets "give"'s existing check also compare the tier of what's being given against the best tier she'd still hold afterward; an unrecognized material falls back to the has-one/has-none check alone. |
| 1.40.0 | 2026-09-19 | New §41, direct report ("I don't think they really know how to use the crafting table or furnace"). Root-caused live: Amy crafted a crafting_table at 01:45, then a Builder-priority "place it at home" REJECTED DONE fired three times over 25 minutes -- every time the whole goal was abandoned (`currentGoal = null`) instead of acting on the fact she was still carrying the item the entire time, so the next re-issued directive immediately re-hallucinated DONE again with zero real steps. Fixed (`index.js` 2.77.0): on this rejection, if she's still holding the item, walk home and place it herself right now (reusing `gohome`/`place`) before giving up -- one deterministic shot instead of another unreliable LLM round-trip. Also clarified `planNextStep`'s own `ACTION CRAFT`/`ACTION PLACE` descriptions, which never mentioned CRAFT's existing auto-chaining of simple intermediates or that PLACE is what actually satisfies a "set one up at home" directive -- a real, confirmed contributor to repeated multi-paragraph confused reasoning in live logs. |
| 1.41.0 | 2026-09-21 | New §42, direct request (24h behavioral review) that surfaced ~4,271 fleet-wide deaths, a 408-death streak, still live during investigation -- stabilized via RCON mob-clear. Operator's own direct observation ("one zombie camped out... none of them fight back including the soldiers... if the bots are inside a building with a zombie, they seem to act as if they are trapped") reframed the theory and led to the real mechanism: EMERGENCY-critical health commits a bot to flee-only (never attacks, any role), and flee's pathfind shares the fleet's canDig-enabled Movements -- in an enclosed room, escape can require digging through a wall, and a failed dig makes pathfinder recompute the IDENTICAL path and fail again immediately, confirmed live via `path_reset: dig_error` firing dozens of times a second with an unchanged cost signature. Fixed (`actions.js` 1.62.0): "flee" now disables digging for its own pathfind, forcing a real walkable route or a clean fast failure instead of an infinite stuck loop. Flagged, not fixed: a bot with zero real escape route still won't fight back afterward (EMERGENCY's own no-attack design is unchanged) -- a real policy decision left open. |
| 1.42.0 | 2026-09-21 | New §43, direct answer to §42's own open question plus a rule change: "if truly unable to flee, they should all fight. Soldiers fight *always*, others fight when under half health." New `decideFightType()` (`index.js` 2.78.0) replaces the flat `SELF_DEFENSE_FLEE_HEALTH` threshold with an explicit role rule -- Soldiers never flee for health reasons (only `FLEE_ONLY_MOBS`/no-weapon), others fight once below half health (10/20). Retired the now-superseded per-bot env override on Mark/Luke's units. Also closed the one place the old rule was never applied: the EMERGENCY health-critical handler used to hardcode an unconditional flee for every role; now uses the same decision (and always ends up fighting, since it only fires under half health by definition). New `attackAsLastResort()` fires from all three flee-triggering sites whenever a flee attempt genuinely fails -- standing still after a failed retreat is worse than fighting, provided there's a weapon; `FLEE_ONLY_MOBS` still excluded even here, since that's a real inability to land a hit, not a courage call. |
| 1.43.0 | 2026-09-21 | New §44, direct report ("they still destroy walls instead of using doors"). Distinct from §18/§19's own door-protection fix, still intact and verified -- doors themselves genuinely can't be dug through. The gap was cost, not permission: an ordinary wall block has no such protection (rightly so in general), and mineflayer-pathfinder's own cost formula (`laborCost = (1 + 3*digTime/1000) * digCost`, default `digCost` 1) made a quick-to-break wall shortcut cheaper than detouring to the actual door. Fixed (`index.js` 2.79.0): `movements.digCost = 30`, same "strongly prefer, don't forbid" reasoning as the existing `movements.liquidCost = 20`. Verified this reaches every pathfinding call site -- `bot.collectBlock`/`bot.pvp` both already had their own internal movements references pointed at this same shared object from an earlier plugin-swap fix, and `mineflayer-tool` never touches movements at all. |
| 1.44.0 | 2026-09-21 | New §45, direct request ("I want real confirmation they can use the crafting table and furnace"). A live single-bot test attempt was derailed by teammates repeatedly requesting away the test materials and an idle-reassignment gap -- pivoted to a fleet-wide 24h log sweep instead, which found something far more consequential than a missing positive example: every single smelt attempt fleet-wide had failed for 24+ hours (`"found furnaces nearby, but couldn't use any of them"`, ~80 occurrences on Bob alone), zero successes anywhere. Root cause confirmed directly from the smelt action's own diagnostic logging: the fleet's two real furnaces were jammed with 63-64 `coal_block` already maxing out their fuel slots (one also had 16 stranded `iron_ingot` in its output) -- `putFuel()` was called unconditionally every attempt with no check for existing fuel, so once a slot capped out, every future call threw `"destination full"` and aborted the whole smelt before ever reaching `putInput()`. Fixed (`actions.js` 1.63.0): collects any existing output first (recovering stranded items), and treats a failed `putFuel()` as "already has fuel" rather than fatal, falling through to `putInput()` with whatever's already there. |
| 1.45.0 | 2026-09-21 | New §46, direct live follow-up ("they still wont fight back when pressured... a single zombie... systematically attacking them, with no reprisals"). §43's rule was working as written -- confirmed Amy had recently won a real fight -- but live pressure found a real gap: Mayor at 16-20 HP (above `HALF_HEALTH`) got re-engaged by the same zombie every ~2s in a cramped house, "successfully" fleeing nearly every time, never taking enough cumulative damage to cross the fight threshold, for minutes at a stretch -- functionally unable to flee even though every individual result reported `ok=true`, so `attackAsLastResort()` (fires only on an outright flee failure) never triggered either. Fixed (`index.js` 2.80.0): `decideFightType()` now tracks consecutive flee decisions and escalates to fighting after 3 in a row without a long-enough gap, regardless of health or role. |
| 1.46.0 | 2026-09-21 | New §47, direct live report ("they can't get out of the home") -- a real, self-inflicted regression from §44's own `digCost=30`, confirmed live rather than assumed a new gap. 7 of 9 bots found crammed in one shelter; Mayor alone logged 239 `noPath` results in 2 hours, zero successful travel the entire window. Root cause: mineflayer-pathfinder's own `astar.js` maxCost ceiling (`startNode.h + searchRadius`, with `searchRadius` pinned at 48 in this codebase) PRUNES any node exceeding it rather than just deprioritizing it -- for a nearby goal, the whole search budget is only ~48-58, and a single dig at `digCost=30` could cost 40-120+ on its own, silently turning "expensive but valid path" into a hard `noPath`. Fixed (`index.js` 2.81.0): lowered `digCost` to 5 -- still a real 5x discouragement (§44's actual goal unchanged), but no longer capable of making a real exit mathematically impossible. Flagged: the same maxCost-ceiling risk applies to any additive cost tuning in this file, including the untouched `liquidCost=20`. |
| 1.47.0 | 2026-09-21 | New §48, direct live follow-up to §47, same "can't get out of the home" report -- §47's digCost fix genuinely resolved the noPath problem (confirmed: Luke went from permanent noPath to status=success cost=24.5) but executing that path hit a NEW infinite tight loop: mineflayer-pathfinder's own `bot.dig().catch(() => resetPath('dig_error'))` discards the real failure reason and immediately recomputes the identical path into the identical failure (live: the same success/cost=24.5 path_update dozens of times within ~1 second). Same failure shape §42 already fixed for "flee" specifically, but no other `goto()` call site -- `gohome` included -- had the same protection. Fixed (`index.js` 2.82.0): a global burst detector on the existing `path_reset` listener forces `canDig` off for 15s after 4+ dig_error resets within 3s, so the next recompute is walk-only; timestamp-gated restore avoids racing a second, later burst's own suppression window. |
| 1.48.0 | 2026-09-21 | New §49, same live incident (§47/§48) -- while restarting the fleet to test §48's fix, live evidence surfaced a second, unrelated root cause for 4 of 9 bots: the existing `teleportToSpawn()` self-rescue mechanism (`bot.chat("/tp ...")`, fires after 3 same-spot reconnects) logged `TELEPORT: ...` successfully for Nell/Wade/Dale, but their actual position never changed -- confirmed via RCON `op <name>` that these three plus Bob (all `dgx-spark2`-hosted) had never been granted server op, so their own `/tp` command had been silently failing since the code's existing comment already named only the `dgx-spark`-hosted bots (Mayor/Mark/Luke/Babs/Amy) as having been added to `ops.json`. No code change needed -- `teleportToSpawn()` was already correct, it just never had permission to act for these four accounts. Fixed live via RCON `op` grants (now persisted in the server's own `ops.json`) plus a direct `tp` to recover the three still-trapped bots immediately; confirmed all 9 physically out via a full position sweep. |
| 1.49.0 | 2026-09-21 | New §50, direct report immediately after §47-§49 shipped: "now they are back to digging through the wall instead of opening the door" -- the exact issue §44 fixed, reopened by §47's own digCost 30->5 fix. Measured real `block.digTime()` values and confirmed digCost alone can't satisfy both live reports: digTime for the same block varies over 100x by tool (cobblestone: 100ms with netherite pickaxe+efficiency5, common gear in this fleet, vs 10000ms with none), so a digCost strong enough to deter the well-tooled case (~15) blows the search-cost budget for the untooled case, while one safe for the untooled case (~5, §47's own value) is nearly free for the well-tooled one. Fixed (`swim-movements.js` 1.1.0): overrides `safeOrBreak` to cap the per-block labor-cost contribution at `MAX_DIG_LABOR_COST=20` regardless of digTime, decoupling "prefer doors when digging is cheap" from "never make an exit impossible when digging is expensive." `digCost` raised back to 15 (`index.js` 2.84.0) now that doing so is safe. |
| 1.50.0 | 2026-09-21 | New §51, direct live report immediately after §50 shipped: "group of bots standing in the open, not moving or running, being actively attacked -- automation failure." Traced to §50's own `MAX_DIG_LABOR_COST` cap: confirmed live that Mayor/Nell/Bob were all independently hammering `dig_error target: netherite_block` at the same home coordinates, and measured real digTime at 75000ms (netherite pickaxe + efficiency 5, hardness 50 barely responds to efficiency) -- but the cap flattened that down to look as cheap as a plank wall, so pathfinder kept choosing it, starting a real 75-second dig, and getting aborted almost immediately by an unrelated periodic check (self-defense fires every 2s), recomputing the identical route into the identical failure forever -- including during combat, since `attack`'s own chase movement shares the same `movements` object, explaining the "frozen, not fighting" symptom directly. Also retroactively explains an ~89-second freeze investigated live on Luke earlier in this same incident. Fixed (`index.js` 2.85.0): excludes any block with real hardness >= 10 from `movements.blocksCantBreak` (obsidian/netherite_block/ancient_debris sit at 30-50; every normal building material tops out at 5) -- the same "not an incidental pathfinding shortcut" protection already applied to doors/chests/furnaces, without blocking "mine" from deliberately targeting one. Verified live: zero netherite_block dig_error occurrences fleet-wide since restart. |
| 1.51.0 | 2026-09-21 | New §52, direct live report immediately after §51 shipped: "zombie is in the building again, attacking the crowd of bots." Different shape from every prior incident: bots were actively attempting both attack and flee, both kept failing -- attack timing out, flee returning "No path to the goal!" within 2-4ms. Root cause: `nearestRallyPoint()`'s own home/bed fallback ("always a safer place... even with nobody there") breaks completely when the threat is already inside home and the fleet is already clustered there -- fleeing "toward home" is either a no-op or routes across the building to a specific, possibly-unreachable point instead of away from the threat. Fixed (`index.js` 2.86.0): home/bed fallback now only returns when at least 20 blocks from the bot's current position; closer than that, flee falls through to its own plain maximize-distance goal, far more resilient to "already home, threat inside." |
| 1.52.0 | 2026-09-21 | New §53, direct request: "standing right out in the open, a single zombie is killing bot after bot. Re-evaluate the entire defense scheme." Live sweep found 5 bot deaths in ~90 seconds against only 1-2 real zombies (RCON-confirmed). Two systemic root causes, not one mechanical bug: (1) EMERGENCY-tier combat had no escape hatch -- "attack" is mandatory under critical health (§43) but previously rode out the full 90s ACTION_TIMEOUT_MS with HEALTH_CRITICAL blocking every other tier; confirmed live (Wade) a single stuck emergency attack held control for 20+ straight seconds. (2) Severe entity crowding (most of the fleet sleeps in one small area) degrades both movement and combat -- constant `path_reset: stuck` live, mineflayer-pathfinder's own entityCost (default 1) barely discourages routing through occupied squares, plausibly also explaining attack timeouts despite overwhelming numbers (same contention shape already confirmed for digging in §51). Fixed: new `EMERGENCY_ATTACK_TIMEOUT_MS` (8s) + `fleeAsLastResort()` (`actions.js` 1.64.0, `index.js` 2.87.0) -- attack still first choice at critical health, but bails to flee if not won quickly; `movements.entityCost` raised 1 -> 8, same "strongly prefer, don't forbid" tuning as liquidCost/digCost. Flagged, not fixed: recurring "no torches" log lines suggest the sleeping area isn't reliably lit, the likely upstream reason hostiles keep spawning there at all -- a resource/logistics gap, not a defense-logic bug. |
