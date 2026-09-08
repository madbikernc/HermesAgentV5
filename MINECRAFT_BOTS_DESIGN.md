# Firmament Minecraft Bots — Design

**Version:** 1.2.0
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

## 14. Dynamic skill library (2026-09-08) — `[PROPOSED]`, a plan only, nothing built

Direct request: "plan out" a Voyager-style skill library, following a web-research gap analysis
against other LLM-driven Minecraft agents. Voyager's own distinctive idea: rather than an LLM
re-deriving a plan from scratch every decision point (today's `goalTick`/`planNextStep`, §12),
successful multi-step behaviors get **compiled into a reusable, retrievable skill** once, then
looked up by embedding similarity next time a similar situation comes up — skills compound over
time instead of each attempt starting cold.

**Deliberate deviation from Voyager's own architecture, not a gap to close later:** Voyager has
its LLM write and `eval()` raw JavaScript directly against the game API. That's the wrong shape
for this fleet — four bots share one live, persistent world with a real human player in it, and
this project's whole existing design (the tool-tier gate, `busy`/`acting` discipline,
`stopCurrent()`'s interrupt guarantees, every action's own bounded timeout) exists specifically
to keep a bot's behavior predictable and safe to interrupt. Arbitrary LLM-authored code eval'd
against a live `bot` object would bypass every one of those guarantees at once. **A skill here
should be a bounded, declarative sequence of the *existing, already-verified* action verbs
(`performAction()`'s own 22-verb vocabulary, actions.js) — never raw code, never direct
mineflayer API access.** This is a smaller, safer idea than Voyager's own, chosen on purpose.

### Shape of a skill

A skill is data, not code: `{ name, description, steps: [{ action, args }, ...] }` — `action`
must be one of `performAction()`'s existing verb names, checked against a real allowlist before
a skill is ever stored or run, the same "validate against real data, don't trust the model"
discipline the tool-tier gate (actions.js 1.21.0) already uses. A bounded step count (matching
`HARVEST_BATCH_LIMIT`/`MAX_CONSECUTIVE_FAILURES`'s own precedent — small, fixed caps everywhere
else in this codebase) keeps a stored skill from ever becoming an unbounded program. No
branching/looping primitives beyond "stop this skill early if a step comes back `ok: false`" —
Voyager's own iterative self-correction happens at the *authoring* step below, not at *runtime*.

### Storage and retrieval — reuses hermes-rag, no new infrastructure

A new `minecraft-skills` hermes-rag corpus, the same two-script bridge pattern
`tools/hermes-rag-ingest-minecraft.py`/`hermes-rag-search-minecraft.py` already established for
the `minecraft`/`minecraft-world` corpora (§7) — indexed on `description`, not the raw step
list, so retrieval is "what is this skill *for*," matching how `longterm.js`'s own dedup check
(1.1.0) already uses `hermes_rag_common.search()`'s real cosine distance with an empirically
calibrated threshold. World-scoped like `minecraft-world` (§7), not per-bot: a skill one bot
worked out should immediately benefit all four, and any future bot, without re-deriving it.

### Authoring — a new, occasional `coder` call, not a new per-tick cost

When `goalTick`'s planner (§12) is about to attempt a step and no stored skill's description is
a close enough match (same distance-threshold pattern as `longterm.js`'s dedup check), it
proceeds exactly as today — a normal per-tick `ACTION <verb>` step, no behavior change. Only
once a goal reaches `DONE` via a run of steps that *weren't* served by an existing skill is a
single, occasional `coder` call asked to compress that run into a reusable
`{name, description, steps}` skill (mirroring §6's own reasoning for why arbitration is a `super`
call, not a per-tick one: "rare, not per-tick"). The compressed skill is validated against the
real action-verb allowlist and step-count cap before it's ever written to the corpus — an
invalid skill is discarded, not stored broken.

### Retrieval and execution — folds into the existing pipeline, not a parallel one

Before `planNextStep`'s own per-tick call, a cheap `hermes-rag-search-minecraft.py` query against
`minecraft-skills` (reusing `searchMemory()`, `longterm.js`) checks for a close-enough match to
the goal's description. A hit runs its steps one at a time through the *exact same*
`performAction()` call every direct command and every per-tick step already goes through — it
inherits `stopCurrent()`'s interrupt guarantees, the `busy`/`acting` discipline (index.js 2.28.0),
and every action's own existing safety behavior for free, specifically *because* it's not a
separate execution path. A live player command still interrupts a running skill immediately, the
same way it already interrupts a running goal step today (§12) — nothing new to build for that.

### Trust and decay — bounded, matching this codebase's own conventions everywhere else

A skill that fails (a step comes back `ok: false`) when replayed gets a failure recorded against
it (reusing the same `consecutiveFailures`-style counter `goals.js` already tracks per-goal); a
skill crossing a small fixed failure threshold is treated as untrusted and skipped by retrieval
(not deleted outright — a skill that fails in one biome/situation may still be right in another,
and outright deletion risks losing something a future fix could revalidate).

### What this buys, concretely

Real, already-observed evidence this would help: multiple bots independently reasoning through
the identical "I need a pickaxe, which needs planks, which needs logs" chain from scratch, per
bot, per goal, tonight — a stored `get_first_pickaxe` skill would let every bot skip straight to
executing it the next time, not re-derive it. This is the same benefit Voyager's own skill
library demonstrates (63 unique items discovered 3.3x faster than prior approaches) without
adopting its riskiest architectural choice (arbitrary code execution).

### Build sequence, if greenlit — not started

1. A minimal skill-runner: given `{steps}`, calls `performAction()` for each in order, stopping
   early (and reporting how far it got) on the first `ok: false` — no new safety primitive, just
   a loop over the existing one.
2. `minecraft-skills` hermes-rag corpus + its own ingest/search script pair (§7's own pattern).
3. Wire retrieval into `goalTick` as a first-choice check before per-tick planning (§12).
4. Wire authoring: one `coder` call on goal completion, gated on "wasn't already served by a
   skill," with real allowlist/step-count validation before storage.
5. Trust/decay counter, reusing `goals.js`'s own `consecutiveFailures` shape.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-06 | Initial design, incorporating operator decisions: dedicated offline-mode instance, Zomboid out of scope, single shared Matrix room. |
| 1.1.0 | 2026-09-07 | §12 added: autonomy/standing goals, player-assigned or self-proposed (operator decided both, not just one), built on top of the already-built system §1-§11 describe. |
| 1.2.0 | 2026-09-08 | §14 added: a plan (not built) for a Voyager-style dynamic skill library, deliberately deviating from Voyager's own raw-code-eval architecture in favor of bounded, declarative sequences of the existing verified action verbs, reusing hermes-rag for storage/retrieval rather than new infrastructure. |
