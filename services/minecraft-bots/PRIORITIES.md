# Minecraft Bots — Priorities & Decisions

**Version:** 1.1.0

This is a review document, not code: a map of every place the bots decide "what do I do right
now" and "what matters more than what else," so the actual priorities can be checked against what
was intended. Each section names the real functions/constants it describes (as of this writing) so
a claim here can be checked against the source directly. Full historical rationale for *why* each
rule exists lives in `../../MINECRAFT_BOTS_DESIGN.md` and the dated comments in `index.js`/
`actions.js` — this file states *what the current rule is*, not the story behind it.

Review questions are called out inline as **(REVIEW: ...)**, and collected again at the end.

---

## 1. The roster

| Bot | Primary role | What that role actually changes |
|---|---|---|
| Mayor | Leader | Issues directives to others, runs the curriculum, no infrastructure checklist of her own |
| Mark, Luke | Soldier | Weapon → monster → armor → guard, enforced (§4) |
| Amy | Builder | 7-item home-infrastructure checklist, enforced (§5) |
| Babs | Miner | Advisory only: fuel → iron/copper → stone → rare ores |
| Bob | Farmer | No priority list at all — see **(REVIEW A)** below |
| Nell | Artist | Advisory only: trees → flower garden → (terrain repair is automatic, not a goal) |
| Wade | Explorer | Advisory only: village → bee nest → notable feature |
| Dale | Herder | No priority list at all — see **(REVIEW A)** below |

"Enforced" means a deterministic, world-checked function overrides freeform self-proposal —
getting it wrong is a code bug. "Advisory" means it is folded as plain text into the LLM's
freeform self-propose prompt (`roleBiasNote()`/`priorityListNote()`, `index.js`) — the bot is free
to ignore it, and nothing checks whether she did.

**(REVIEW A):** Farmer and Herder have a `domain` description but no `priorities` list, unlike
Miner/Artist/Explorer/Soldier (`roles.js`). Intentional (nobody has specified what Bob/Dale should
prioritize beyond their domain) or a gap to fill in?

---

## 2. Who may interrupt whom — the control hierarchy

Every physical action (goal step, chore, combat, recovery...) runs under one *owner tier*.
A higher tier can force-cancel whatever a lower tier is doing, mid-action. This hierarchy is
identical for every bot regardless of role — it governs *urgency*, not *role priority*.
(`arbiter.js`, `OWNERS`)

| Tier | Priority | Who | Notes |
|---|---|---|---|
| ROUTINE | 0 | Idle-tick chores: inventory, saplings, lighting, hunger (non-critical), give-requests, sleep/dusk checks, routine stuck-nudging | Same tier as GOAL_STEP — no hierarchy between chores and goal work today |
| GOAL_STEP | 0 | `goalTick`'s own physical-action span | — |
| HUNGER_CRITICAL | 5 | Near-starving eat/fish | Outranks goals and chores, never a player command |
| DIRECT_COMMAND | 10 | A live player named this bot directly | "A live player command always wins immediately" |
| RECOVERY | 15 | Unused in production since 2026-10-28 (item drop on death is off — nothing to retrieve); the tier/owner remain only as a test fixture (unit/live tests' arbiter-preemption checks) | — |
| SQUAD_RESPONSE | 20 | Responding to a teammate's threat alert | — |
| SELF_DEFENSE | 30 | `checkSelfDefense()` / post-wake threat response | Fight-or-flee decision lives here (§3) |
| DROWNING | 40 | Oxygen-critical emergency surface | Outranks health-critical: real seconds of margin before drowning *damage* starts, vs. health-critical meaning a near-fatal hit already landed |
| HEALTH_CRITICAL | 50 | Critical-health fight-or-flee (`bot.on("health")`) | — |
| TELEPORT_HOME | 60 | Last-resort stuck-teleport escalation | Cancel-only — never blocks waiting for anything else to finish |

**(REVIEW B):** Chores and goal work share one tier (0) with no ordering between them. A hungry-
but-not-critical bot's "eat" chore and her current goal step have equal claim — whichever happened
to ask first keeps going. Is that the intended trade-off, or should some chores (torch supply,
home lighting) outrank ordinary goal work without needing the full HUNGER_CRITICAL treatment?

---

## 3. Combat: fight, flee, or ignore

Three places decide this, applied in the same order every time a threat is detected
(`decideFightType()`, `index.js`):

1. **Can't ever fight it** → flee. `FLEE_ONLY_MOBS` (flyers/teleport-evaders — melee can't catch
   them) or no weapon equipped.
2. **A nearby creeper** (within `CREEPER_FLEE_RANGE`, 5 blocks) → flee. Meleeing it means eating
   the explosion.
3. **Outnumbered badly** → flee:
   - 2+ hostiles within `OUTNUMBERED_RADIUS` (8 blocks) **and** health at/below
     `EMERGENCY_HEALTH_THRESHOLD` → flee, any role.
   - 3+ hostiles within that radius, any health → flee, unless she's a Soldier.
4. **A genuinely solo threat** (nearby ≤ 1), **a Soldier**, or **already hurt**
   (health < `HALF_HEALTH`, 10/20) → **attack**, unconditionally. *(Fixed 2026-10-10 — this used
   to fall through to step 5 for a healthy non-Soldier facing one mob, which could flee forever
   against a string of one-at-a-time attackers.)*
5. **Two hostiles, healthy, non-Soldier** (the one case not resolved above) → flee first, but
   track consecutive flee *decisions*: after `CONSECUTIVE_FLEE_ESCALATE_AFTER` (3) in a row without
   a `CONSECUTIVE_FLEE_RESET_MS` (15s) gap, escalate to attack anyway — repeated re-engagement by
   the same threat counts as "truly can't get away" even if each individual flee technically
   "succeeded."

**Last-resort overrides**, checked only after the chosen action has already failed:
- Flee failed (couldn't create distance) → fight anyway, bare-handed if necessary, unless the
  threat is in `FLEE_ONLY_MOBS` (still genuinely unreachable). *(The bare-handed part is also new
  as of 2026-10-10 — an unarmed bot who failed to flee used to just stand there.)*
- An EMERGENCY (critical-health) fight hasn't won within `EMERGENCY_ATTACK_TIMEOUT_MS` (8s, far
  short of the normal 90s action timeout) → break off and flee instead of riding it out at
  near-death.

**(REVIEW C):** Step 5's 2-hostile case still defaults to flee-first for a healthy non-Soldier.
Is "two attackers, flee first" still the right call now that step 4 commits to fighting a lone
one? Or should 2 also just be a fight for an armed, healthy bot?

---

## 4. Soldier priority (enforced)

Checked in this exact order every time a Soldier-primary bot has no active goal
(`nextSoldierPriority()`). Each one *overrides* freeform self-proposal — a Soldier never reaches
the unrestricted freeform path at all, unlike every other role:

1. **No weapon** → get one (chest, ask the fleet, or craft) before anything else.
2. **A hostile within `SOLDIER_PATROL_RANGE`** (and not a `FLEE_ONLY_MOBS` member) → hunt it down.
3. **Fewer than 4 armor pieces worn** → get a full set, any tier. Rate-limited to once every
   `SOLDIER_ARMOR_RETRY_MS` so an unobtainable set doesn't churn goals every tick.
4. **Otherwise** → stand guard near home. This is a *standing* goal (`goal.standing === "guard"`)
   — no planner calls while it holds, ends only when a higher Soldier priority above fires.

**(REVIEW D, the big one):** Step 1 ("get a weapon") sets the *directive* deterministically, but
nothing executes it deterministically — it falls straight through to the generic LLM planner (§6),
the same way Builder's old crafting-table/furnace/chest items used to (§6's fixed bug). Live logs
show this is currently the fleet's most common failure mode: the planner repeatedly *claims*
"DONE, I have a sword" without actually having one — rejected every time by the inventory check,
but re-attempted from scratch next cycle rather than ever reliably mining ore / crafting planks and
sticks / checking a chest in sequence. Builder/Bed/Farm/Shelter/Ranch all got a dedicated
deterministic runner for exactly this class of problem. **Should "get a basic weapon" get one too?**

---

## 5. Builder priority (enforced)

Checked in this order whenever Builder-primary Amy has no active goal (`nextBuilderPriority()`),
each item verified against real world state (`bot.findBlocks` near home), never trusted from a
claim:

1. Crafting table placed near home
2. Furnace placed near home
3. Chest placed near home
4. Enough beds for the whole fleet (`bedCount >= BOT_USERNAMES.size`)
5. A shelter near home (walls + roof + doorway, big enough for a bed)
6. A beehive near home (nice-to-have, sits after the five "core survival infra" items on purpose)
7. A breeding achievement (`bred:*`) — sets up a ranch pen if none exists yet

Once all seven are satisfied, Amy graduates to the same unrestricted freeform self-propose every
non-Soldier role eventually reaches. If an item stalls (same item picked `BUILDER_ITEM_STALL_LIMIT`
+ 1 times in a row with no progress), it's skipped in favor of the next unsatisfied one rather than
blocking the whole ladder forever — it comes back into rotation once something else also stalls.

Items 1–4 (crafting table, furnace, chest, beds) are the four the generic-planner table-detection
bug (fixed 2026-10-09, `actions.js` 1.83.0/1.83.1) directly affected — any of them could fail
instantly with a misleading "might need a crafting table" message while standing next to a real
one, or while holding the wrong ingredients for a bed. Fixed now; worth specifically re-watching
these four for a while to confirm.

**(REVIEW E):** The beehive/ranch items (6–7) sit *after* the five "core" ones by design ("nice to
have, not core survival infra"). Still the right ordering?

---

## 6. How a goal actually runs, once chosen

A goal's `description` text (regardless of who set it — Mayor, a role's enforced priority, or
freeform self-proposal) is pattern-matched once (`farmTaskFor()`) to decide which of these runs it:

| Pattern match | Runner | Planner calls needed |
|---|---|---|
| Builder checklist item she's already holding | `runBuilderPlacement` | None — walk home, place, verify |
| Farming words (`till`, `plant`, `crops`...) | `runFarmGoal` | None |
| Ranching words (`ranch`, `breed`, `pen`...) | `runRanchGoal` | None |
| Bed words (`make`/`craft`/`place`... `bed`) | `runBedGoal` | None |
| Shelter words | `runShelterGoal` | None |
| `goal.standing === "guard"` | `guardTick` | None |
| Target item already in inventory | Completes immediately | None |
| A matching stored skill | Replays the recorded step sequence | None, until it runs out of steps |
| **Everything else** (weapons, tools, ore, exploration, "upgrade my gear"...) | Generic planner (`parseGoalStep`/`planNextStep`) | **Every single step** |

The deterministic runners exist precisely *because* the generic planner is unreliable for anything
with a real multi-step material dependency — each one was added after a live incident where the
planner either never acted or hallucinated completion. **The weapon/tool/ore category is the
largest piece of the bot's actual job that still has no deterministic runner** (§4-REVIEW D).

A goal ends one of three ways:
- **Done**, verified against real state (inventory/equipped/placed-near-home — never a bare LLM
  claim, since the 2026-09-13 "hallucinated achievements" incident).
- **Given up**, after `MAX_CONSECUTIVE_FAILURES` (3) consecutive non-progressing steps.
- **Abandoned**, if a higher-priority directive or role requirement replaces it outright.

A bot self-proposes a *new* goal only when idle for `IDLE_BEFORE_SELF_GOAL_MS` (10 min) with
`SELF_PROPOSE_GOALS` on; Mayor issues directives to others on a `MAYOR_DIRECTIVE_MS` (5 min)
cadence. A role's enforced priority (§4, §5) is checked **before** freeform self-propose, so it
always wins when both would otherwise apply.

**(REVIEW F):** Given up after 3 failures with no deterministic fallback (§6 table's last row) just
means the *same* unmet need gets re-proposed again later, often verbatim — "get a sword" in the
logs recurs for hours. Is 3 the right give-up threshold for this category specifically, independent
of whether a dedicated runner gets built?

---

## 7. What's already been fixed vs. still open (as of this review)

Fixed this review cycle, all unit- and (where the test harness reaches that code) live-tested:
- A table-needing craft (bed, pickaxe, ...) with no table nearby now actually searches for one,
  remembers one, or makes and places one — it used to skip straight to a misleading "don't have
  the ingredients" failure in under 100ms, never looking. (`actions.js` 1.83.0/1.83.1)
- An existing crafting table/furnace found nearby (not just a freshly-placed one) now gets written
  to shared world memory too. (`index.js` 2.107.0)
- A healthy, armed, non-Soldier bot facing exactly one ordinary mob now fights it directly instead
  of defaulting to flee (§3 step 4). (`index.js` 2.108.0)
- An unarmed bot who fails to flee now fights bare-handed as a last resort instead of standing
  still. (`index.js` 2.107.0)
- `get_wool` (and only `get_wool` so far) now wanders to look for a sheep instead of failing
  instantly if none is in her immediate 32-block radius. (`actions.js` 1.84.0)

Still open, not yet fixed:
- **§4/§6: no deterministic "get a basic weapon" runner.** The single biggest observed source of
  repeated, hours-long goal failure in live logs — the planner hallucinating "DONE" on a sword/axe/
  pickaxe/furnace it never actually made.
- **Other raw-material searches may share `get_wool`'s old bug.** Only `get_wool` has been checked
  and fixed; anything else that scans `bot.entities`/a block search once and gives up without a
  wander fallback hasn't been individually audited yet.

---

## 8. Review questions, collected

- **(A)** Should Farmer and Herder get an advisory `priorities` list like Miner/Artist/Explorer/
  Soldier, or is "no list" intentional for them?
- **(B)** Chores and goal steps share one arbiter tier with no ordering between them — intended?
- **(C)** Two attackers on a healthy non-Soldier still default to flee-first — still right, now that
  one attacker is an unconditional fight?
- **(D)** Should "get a basic weapon" (and plausibly "get a basic tool") get a dedicated
  deterministic goal runner, the same way beds/farms/shelters/ranches did?
- **(E)** Beehive/ranch sit after the five "core" Builder items — still the right ordering?
- **(F)** Is a 3-failure give-up threshold right for goals that have no deterministic fallback to
  reach for instead (e.g. weapons), independent of whether (D) gets built?

**Disposition (2026-10-11), see `PRIORITIES_PROPOSAL.md`:** (A) resolved there — Farmer and Herder
each got a real list. (D) resolved there — "get a basic weapon" becomes a universal Tier 1 check,
not Soldier-specific. (B), (C), (E), (F) were not changed by the proposal; each stands at its
stated default (B: leave the shared tier, watch rather than pre-rank; C: leave flee-first for two
simultaneous attackers; E: leave beehive/ranch last; F: leave the threshold at 3) unless revisited.

---

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-11 | Initial version, written for review alongside a world/memory reset. |
| 1.1.0 | 2026-10-11 | Noted disposition of all six review questions against `PRIORITIES_PROPOSAL.md`. |
