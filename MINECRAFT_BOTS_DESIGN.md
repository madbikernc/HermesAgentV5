# Firmament Minecraft Bots — Design

**Version:** 1.0.0
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

## 12. Open questions before building

- `[UNKNOWN]` Does the pre-provisioned `25566/tcp` "Minecraft Paper" UFW slot get repurposed for this bot
  instance, or does it get a fresh port? (§3)
- `[UNKNOWN]` Paper vs. vanilla for the new instance — Paper recommended but not required (§3).
- `[PROPOSED, needs confirmation]` Firewall scope of the new instance restricted to LAN/Tailscale rather than
  global, given offline mode's identity risk (§2, §3).
- `[PROPOSED, needs confirmation]` The ambient-vs-addressed message routing convention in the shared Matrix
  room (§10) — worth a quick real-world test once bots exist, since it's the one piece of this design with
  no existing fleet precedent to copy.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-06 | Initial design, incorporating operator decisions: dedicated offline-mode instance, Zomboid out of scope, single shared Matrix room. |
