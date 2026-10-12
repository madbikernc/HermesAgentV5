# Minecraft Bots — Proposed Tactical/Prioritization Model

**Version:** 2.0.0

This is a **proposal**, not yet implemented. It supersedes nothing until reviewed — `PRIORITIES.md`
still describes what the fleet actually does today, including the six open review questions it
ended with. This document answers those questions with a concrete redesign: three priority tiers
checked in order, for every bot, every time she'd otherwise pick her own next task, replacing
today's split between "two roles get an enforced ladder, six don't."

Directive this builds from (operator, 2026-10-11): survival before progression; cooperation —
shared resource-location knowledge and shared excess, where "resource" explicitly includes
constructed/placed objects (chests, tables, furnaces, beds), not just raw materials like wood and
stone; reconsider the roles themselves; keep two pieces of existing structural logic exactly as
they are.

A second round (also 2026-10-11) tightened the shelter definition, settled the individual-vs-
communal shelter question, and added two governing rules that sit above everything else in this
document: shelter-integrity repair as a standing top priority, and a general "lacking a resource
for your current priority means go get it" rule. Both are folded into the sections below rather
than kept as a separate addendum, since they change how Tier 1 itself is ordered.

### The one absolute rule

**Nothing supersedes defense.** Every tier, every priority, every rule below — including shelter
repair and resource-gathering, both of which outrank nearly everything else — yields to the
reflexive safety layer (§0 below) without exception. This is already true of the arbiter's
existing interrupt hierarchy; stated here explicitly because everything new in this document is
defined relative to it.

---

## 0. What this proposal does not touch

- **The reflexive safety layer** (`PRIORITIES.md` §2–3: arbiter interrupt tiers, the fight/flee
  decision tree). Already correct, already fixed this review cycle (a lone attacker gets fought,
  not fled from; an unarmed bot who can't flee swings anyway). Nothing here changes it — it's the
  one thing nothing else in this document ever outranks.
- **"Use a door, don't destroy a wall."** Every placement already asks `wouldBlockAccess` first;
  `clear_access` is the one sanctioned way to remove something in the way. Unchanged.
- **"Done" means verified, never claimed.** Every new check below follows the rule the DONE-
  rejection mechanism already enforces: checked against real inventory/placement state, never
  trusted from an LLM's self-report.

**Refined, not unchanged — the shelter definition.** The core idea ("a home with a bed needs walls,
ceiling, floor, and doors," a real room rather than just a perimeter) stays, but the operator has
since made it precise, and precise enough that it's **stricter than what the live code actually
checks today**:

> Complete walls, ceiling, and floor; at least one real door (not an opening or an arch); no other
> openings to the surroundings or into a cave system; at least one bed inside.

Checked against the live implementation: `hasHollowInterior()`/the wall-fill check currently
tolerates gaps (the codebase's own build-check comment describes "80% solid," not 100%), and
nothing today specifically checks for a sealed connection to a cave system. Closing that gap is a
real code change (§4), not a documentation nuance — see Tier 1 item 1 below for where this
definition does its work.

---

## 1. The core change: three tiers, re-checked every time, for every bot

Today, exactly two roles (Soldier, Builder) get a deterministic, world-checked priority ladder that
overrides freeform self-proposal; the other six get either plain advisory text or nothing at all.
That split is itself the problem the operator's "reconsider the roles" directive is pointing at:
survival needs (a weapon, a place to sleep, food) don't stop applying to a Miner or a Farmer just
because *her* role happens not to enforce them.

This proposal replaces "two roles have a ladder" with **three tiers that apply to every bot**,
checked in that order every single time she'd otherwise self-propose or accept an idle moment — not
a one-time "day one" phase. A bot who just respawned, lost her gear, or is standing in the dark
re-enters at whichever tier she actually needs right now, every time, the same way Builder's
checklist is already re-verified against real state on every check rather than remembered from last
time.

| Tier | Scope | Overrides | Analogous to, today |
|---|---|---|---|
| 0 — Reflexive safety | Always, mid-action | Everything | Arbiter tiers (unchanged) |
| 1 — Personal survival baseline | Every bot | Tiers 2–3 | Soldier's weapon check, generalized |
| 2 — Shared fleet infrastructure & cooperation | Every bot | Tier 3 | Builder's checklist, de-exclusived |
| 3 — Role-specialized progression | Every bot, by role | Freeform only | Today's advisory lists + freeform |

### Tier 1 — Personal survival baseline (new, universal)

Checked for **every** bot, regardless of role, before anything role-specific, **in this order**:

0. **Shelter integrity, if she has (or the fleet has) a shelter at all.** A breach — any wall,
   ceiling, floor, or door no longer meeting the definition above — is a standing, ongoing danger
   (mobs, rain, a phantom-spawning open roof) for as long as it goes unfixed, unlike "no weapon yet"
   which is only a risk at the moment of an actual attack. **Repairing a breach is a temporary top
   priority** — ranked first in Tier 1, above even getting a weapon, and re-checked as part of this
   same list every time, not a one-off alert. Still subordinate only to defense (the one absolute
   rule, above): if a wall needs repairing *and* a mob is attacking right now, defense still goes
   first.
1. **Has a real weapon** (any tier — wood counts). Today only Soldiers get this enforced
   (`nextSoldierPriority()`); everyone else relies purely on the reflexive fight/flee layer, which
   assumes a weapon already exists. A Miner or Farmer who's never actually gone and gotten one has
   no deterministic path to fix that.
2. **Has her own shelter, built to the definition above, with a bed inside.** One individual
   shelter per bot is the full baseline requirement — **decided** (this resolves PROPOSAL-REVIEW 5
   below): no one needs to wait on a single shared structure to satisfy Tier 1. **Checked live and
   confirmed real: today's two checks (`bedCount >= BOT_USERNAMES.size` and `hasShelterNearHome()`)
   are fully independent** — the fleet can report both satisfied with nine beds scattered in the
   open and exactly one small shelter room that happens to pass its own (currently looser) geometry
   check nowhere near most of them. "Her own qualifying shelter, with a bed in it" is a materially
   stronger claim than either check alone proves, and is what this item actually requires. If she
   doesn't have one, building her own — not waiting on Builder, not sharing someone else's — *is*
   this Tier 1 item.
3. **Isn't trending toward starvation.** The reactive "eat when hungry" chore already exists
   (§2 of `PRIORITIES.md`, `HUNGER_CRITICAL` tier) and is unchanged; this adds a *proactive* "go get
   food" goal once hunger is dropping, before it's an emergency, the same way a real survival guide
   treats food as continuous upkeep, not a crisis response.
4. **Has basic armor** (any tier, any number of pieces beyond zero). Lower urgency than 1–3 — every
   source on the actual Minecraft order of operations puts a weapon and a safe night well ahead of
   armor — but still ahead of any role-specific work.

**Decided:** Tier 1 outranks role work rather than blocking it outright — a Tier 1 gap always wins
the *next* idle choice, the same relationship Builder's checklist already has with freeform, but it
doesn't interrupt a role goal already mid-flight. A bot one armor piece short of a full set doesn't
drop a nearly-finished task to go chase it.

### Tier 2 — Shared fleet infrastructure & cooperation (new, de-exclusived)

Not one role's job. Checked next, the same deterministic, world-verified way Builder's checklist
works today, but **ownable by whichever bot is idle and able**, not pinned to whoever's primary
role happens to be Builder:

1. **The home infrastructure checklist, reordered and with one real merge.** Table stays first
   (cheap, enables everything else). **Next, not fourth and fifth: individual-shelter capacity** —
   today's separate "beds" and "shelter" items merge into one, because (per Tier 1 item 2 above)
   satisfying them independently doesn't actually get anyone a safe place to sleep. **Decided
   (resolves PROPOSAL-REVIEW 5): the baseline target is one qualifying individual shelter per bot**
   — `BOT_USERNAMES.size` separate structures, each to the strict definition (§0), each with its
   own bed, not one shared room nine beds are squeezed into or scattered around. Checked against
   the current shelter geometry (`SHELTER_ROOM`, a 2x2 interior, one or two beds at most), this was
   always going to mean multiple structures regardless — the fleet-size target just makes it exact
   rather than implicit. Then furnace, chest, beehive, breeding achievement, in that order,
   unchanged. What changes beyond reordering is ownership: any idle bot capable of the next unmet
   shelter does it (reusing the Tier-2-item claim mechanism, §1 PR2, so two idle bots don't build
   toward the same missing one), and the Leader's directive logic can send *whoever's* idle at a gap
   instead of waiting on one specific bot. A single Builder being busy, dead, or stuck no longer
   stalls the whole fleet's infrastructure — and now specifically can't stall shelter+beds, the one
   item every bot also feels directly in Tier 1.
1a. **The communal shelter — later, progression-gated, additive.** Once the fleet's progression
   reaches iron tools or better (checked the same verified way the existing curriculum already
   checks tool tiers — `TOOL_TIERS` real index `>= "iron"`, via `mayorHasStageItem`'s own
   never-trust-a-claim pattern, not a new detection mechanism), building **one single communal
   shelter** becomes a Tier 2 goal, in addition to — not instead of — the individual shelters above.
   Material constraint: every block used must be **at least stone tier** (stone, cobblestone, stone
   bricks, deepslate, iron blocks, and similar all qualify; plain wood planks or dirt don't), though
   the materials don't all have to match each other. This is new classification logic —
   `isShelterMaterial()` today checks "is this a plain building block" with no notion of tier at
   all (§4). Ownership: same shared-claim pattern as every other Tier 2 item, likely Builder-led in
   practice (her Tier 3 "larger construction" item, §3) but not Builder-exclusive.
2. **Check shared knowledge before making or placing one.** The crafting-table-specific version of
   this already exists and was fixed this session (actions.js — searches nearby, then remembered
   locations, before ever making a new one). This generalizes it: furnace, chest, and beds get the
   exact same treatment — a bot about to make *any* of these checks shared world-memory for one the
   fleet already placed, not just her own immediate 32-block view, before spending materials on a
   duplicate. (Directly answers the operator's "resources include... chests, tables, furnaces,
   beds.") For shelter specifically, this means checking whether an *existing* shelter still has
   room for another bed before starting a second structure — multiple shelters (item 1) are for
   when capacity genuinely runs out, not the default first move.
3. **Surplus goes to the fleet, not into a backpack.** Holding more of a stackable resource (wood,
   stone, ore, food — the operator's "wood, stone, etc.") than she personally needs right now, with
   a known fleet chest not yet stocked or a teammate's open request unmet, means storing or giving
   it. The mechanics already exist (`storeSurplusNearHome`, `give`, chest-withdrawal preferring a
   stocked chest over mining) — this elevates "don't hoard" from an incidental cleanup pass to an
   explicit, regularly-checked Tier 2 item.
4. **Discovered locations get shared immediately.** Finding any resource, structure, or constructed
   object worth remembering writes it to shared world-memory as a first-class duty, not a side
   effect of some other action succeeding. Mechanically mostly already true (`noteNearbyResources`,
   extended this session to also catch an *existing* table/furnace found rather than only a freshly
   placed one) — this makes it an explicit tier item so a bot who's otherwise idle can go looking
   specifically to report back, not just incidentally while doing something else.

**Decided:** reuse the bed-claim mechanism (`actions.js`'s `BED_CLAIMS_AGENT` shape — shared
hermes-memory `agent_state` row, per-host fallback file, lower-sorted-name-wins on a race) for a
short-lived claim on "I'm working builder-priority item X," so a second idle bot sees it's claimed
and either helps differently or picks the next unmet item instead.

**Resolved (operator, 2026-10-11):** one individual shelter per bot is the baseline (my "several
small shelters" lean was right) — reusing today's existing `findShelterSite`/`shelterPositions`
geometry unchanged, repeated `BOT_USERNAMES.size` times. A single larger communal shelter is real,
but as an *additional*, later, progression-gated goal (item 1a above), not a replacement for the
individual baseline and not an alternative shape for it.

### Tier 3 — Role-specialized progression (reconsidered, §2 below)

Everything that's genuinely about a role's specialty rather than universal survival or shared
infrastructure. Only reached once Tiers 1–2 are satisfied — same relationship Builder's checklist
already has with its own graduation to freeform, generalized to every role.

### The resource-gathering override (cuts across every tier)

**When any task — at any tier, shelter repair included — requires a resource she doesn't have,
gathering that specific resource becomes her temporary priority, superseded only by defense.**
Not a fourth tier sitting at a fixed rank; a substitution rule that applies *within* whichever
tier/item is currently highest. Shelter repair needs cobblestone she doesn't have → go mine
cobblestone, as part of (not instead of) the repair. A Tier 2 chest needs planks → go get planks.
Tier 3 farming needs seeds → go get seeds. This is the general form of what each already-shipped
fix this session did for one specific case (a craft missing a table now searches/makes one instead
of failing instantly; `get_wool` now wanders instead of giving up) — stated once, as a rule every
tier obeys, rather than a separate deterministic runner built per category as each one is
separately discovered to need it. This directly supersedes the narrower framing in
`PRIORITIES.md` REVIEW D ("should 'get a basic weapon' get its own dedicated runner") — the answer
is now "every priority gets this, automatically, by the same general mechanism," not one bespoke
runner for weapons specifically.

---

## 2. The roles, reconsidered

Moving weapon/armor/shelter-access out to a universal Tier 1, and home infrastructure out to a
shared Tier 2, removes most of what currently makes Soldier and Builder structurally different from
everyone else. What's actually left, per role:

| Role | Bot(s) | What's genuinely still role-specific (Tier 3) | Change from today |
|---|---|---|---|
| Leader | Mayor | Coordinates the fleet, tracks the curriculum — **plus now tracks Tier 1/2 gaps fleet-wide** and directs whichever idle bot to the nearest one, not just Builder | Expanded: Tier 1/2 gap-tracking is new |
| Soldier | Mark, Luke | Proactively hunting nearby threats before they attack anyone, and guard duty — defense *for others*, not just self-defense | Narrowed: weapon/armor move to Tier 1 |
| Builder | Amy | Leads/kicks off Tier 2 infrastructure work; once individual shelters are met, leads the communal shelter (Tier 2 item 1a) once iron tools exist, and larger/ambitious construction beyond that | Narrowed: the checklist itself is now shared, not exclusive |
| Miner | Babs | Resource stockpiling beyond what Tier 2 immediately needs — rare ores, deep stockpiles | Reframed: leads with "does Tier 2 need material I can get" before her own advisory ladder |
| Explorer | Wade | Scouting for villages/features *beyond* what's needed to satisfy a specific Tier 2 gap | Reframed: "share what I find" promoted from incidental to first-class (Tier 2 item 4) |
| Farmer | Bob | Build the farm, populate it, then gather and store on an ongoing basis — moves the fleet off ad-hoc foraging | New: gets a real priority list (closes PRIORITIES.md REVIEW A) |
| Herder | Dale | Build the pen, populate it, then gather and store on an ongoing basis — sustainable wool/food/honey | New: gets a real priority list (closes REVIEW A) |
| Artist | Nell | Purely decorative work — gardens, aesthetic building | Unchanged in spirit; now explicitly gated behind Tier 2, not just advisory text saying so |

**Decided:** keep Builder and Artist separate. Decoration should never compete with an unmet
infrastructure gap for the same bot's attention, and splitting them keeps that boundary enforced by
role rather than by hoping the priority check always fires correctly.

**Decided, with a new mechanic — the guard-anchor claim (§2a below):** Soldier's patrol behavior
depends on how many live Soldiers there are. With one, she patrols near home, unchanged from today.
With two or more, exactly one holds a claim to stay anchored near home at all times; every other
Soldier's priority becomes escort/rescue instead of home patrol.

### 2a. The guard-anchor claim

Operator's own suggestion: arbitrate which Soldier holds which sub-role the same way bed claims
are already arbitrated, rather than inventing a new mechanism. Shape, copied directly from
`BED_CLAIMS_AGENT` (`actions.js`):

- A new shared claim, `agent_state` row under a fixed agent name (e.g. `minecraft-guard-anchor`),
  holding a single value — `{ holder: <bot name>, claimedAt: <timestamp> }` — not one row per bot
  the way bed claims are (there's only one anchor slot to contend for, not N beds), plus the same
  per-host fallback file and `MC_*_SHARED` escape hatch bed claims already have for when
  hermes-memory is unreachable.
- **One Soldier, no contest:** with only one live Soldier-primary bot, she trivially holds the slot
  (claims it on her first check, never contested) and behaves exactly like today's single guard
  priority — no observable change.
- **Two or more Soldiers:** whichever doesn't hold the claim checks it each cycle; if it's empty or
  its holder is no longer a live, connected Soldier (mirrors how a bed claim is released on death/
  destruction), she claims it. If two Soldiers race to claim in the same window, the same
  lower-sorted-name-wins rule bed claims already use settles it — no new tie-break logic to invent.
- **Holding the claim → home patrol**, unchanged from today's guard duty.
- **Not holding the claim → escort/rescue.** Concretely: prioritize responding to a squad-call
  alert (already exists, `SQUAD_RESPONSE` tier — this just makes a non-anchor Soldier bias toward
  it over her own patrol rather than treating it as a same-weight interrupt) and recovering a
  *teammate's* dropped gear after a death, not just her own. The latter needs checking against
  what `RECOVERY`/the post-death gear logic actually supports today before promising it — flagged
  in §4 as something to confirm, not assume, before implementing.
- **Claim released** (holder dies, disconnects, or is demoted out of Soldier) the same way a stale
  bed claim is detected and freed — the remaining Soldier(s) re-contend for it on their next check,
  never left permanently anchorless.

---

## 3. Proposed per-role priority lists (replacing today's advisory text)

Only the Tier 3 remainder — Tier 1/2 are identical for everyone and listed once in §1.

- **Soldier:** hunt down any hostile within patrol range → if holding the guard-anchor claim (§2a)
  or the only Soldier, stand guard near home (ongoing) → otherwise, escort/rescue (respond to squad
  calls and teammate-gear recovery ahead of independent patrol).
- **Builder:** lead the next unmet Tier 2 checklist item (individual shelters included) → once iron
  tools exist fleet-wide, lead the communal shelter (stone tier or better) → once Tier 2 is fully
  met, larger/ambitious construction (freeform).
- **Miner:** fill the current Tier 2 material gap if one exists → fuel (coal) → iron/copper →
  stone/cobblestone → rare ores (gold, diamond, redstone, lapis).
- **Explorer:** report findings from any Tier 2 gap-driven scouting immediately → locate a village →
  locate a natural bee nest → locate a notable feature (ravine, mineshaft, stronghold).
- **Farmer** *(new)*: build the farm (till and lay out a plot near home) → populate it (plant seeds
  across the whole plot) → gather and store (harvest, replant, and move surplus food to a shared
  chest rather than carrying it — Tier 2 item 3).
- **Herder** *(new)*: build the pen (fence + gate near home) → populate it (lead in a breeding pair,
  then breed for growth) → gather and store (shear/milk/collect honey on an ongoing basis and move
  surplus to a shared chest — Tier 2 item 3).
- **Artist:** a few trees planted near home → a small flower garden → (terrain repair stays
  automatic, not a self-proposed goal, as today).
- **Leader:** assign Tier 1/2 gaps to idle bots → run the curriculum → everything else is
  already-existing Mayor behavior, unchanged.

---

## 4. Rough implementation shape (not yet built — for scoping, not a commitment)

- A new, role-agnostic `nextSurvivalPriority()` (Tier 1), checked in `proposeOwnGoal()` **before**
  any role-specific ladder — mirrors `nextSoldierPriority()`'s shape but applies to every bot. It
  outranks a role goal (§1 PR1) without preempting one already running (checked only at the next
  idle choice, same as Builder's ladder today).
- `nextBuilderPriority()` becomes fleet-shared: hoisted so any idle bot can pick up the next unmet
  item, guarded by a new short-lived claim reusing `BED_CLAIMS_AGENT`'s own shape (§1 PR2) so two
  idle bots don't converge on the same item.
- `builderPriorityItemSatisfied("beds")` and the separate `hasShelterNearHome()` check merge into
  one "individual-shelter capacity" check, counted per bot: `BOT_USERNAMES.size` separate
  structures each independently passing the (tightened, see next bullet) shelter check with a bed
  inside, not a bare total of beds and a single unrelated shelter existence flag. Reuses
  `findShelterSite`/`shelterPositions`/`SHELTER_ROOM` geometry unchanged, repeated once per missing
  shelter — resolved (§1), no redesign of shelter size for the baseline.
- `hasHollowInterior()`/the wall-fill check gets tightened to match the exact new definition (§0):
  100% solid walls/ceiling/floor (not today's ~80% tolerance), at least one real door block present
  (not just an open gap), and a check that the room has no path to an unlit/natural cave void —
  the last one is new; nothing today checks for a cave connection at all.
- A periodic re-check of every shelter a bot has already "completed" (mirroring
  `checkAccessObstructions`'s own existing "did something change since we last verified" pattern)
  so a breach is actually noticed, not just assumed fixed forever once first built. This is what
  feeds Tier 1 item 0 (shelter-integrity repair).
- New material-tier classification for the communal shelter (item 1a): `isShelterMaterial()` today
  has no concept of tier at all (any plain building block passes); needs a stone-or-better allow-
  list (stone, cobblestone, stone bricks, deepslate, iron block, etc., explicitly excluding planks/
  dirt/sand) separate from the existing, more permissive baseline-shelter material check.
- The "iron tools or better" trigger for the communal shelter (item 1a) reuses `TOOL_TIERS`'
  existing ordering and `mayorHasStageItem`'s real-inventory verification — checking whether any
  real tool at tier index `>= TOOL_TIERS.indexOf("iron")` exists fleet-wide, not a new detector.
- The resource-gathering override (§1, cross-cutting) needs one chokepoint, not nine: likely a
  wrapper around whatever ends up resolving "what do I do next" at every tier, catching a
  missing-material failure and substituting "go get X" before falling through to a normal
  consecutive-failure count. The already-shipped craft/get_wool fixes are two existing, narrower
  instances of exactly this that a general version should subsume, not duplicate.
- The crafting-table-specific "check shared memory before making a duplicate" logic
  (`findRememberedLocation("crafting_table")`) extends to `furnace`/`chest`/beds, and for shelter
  specifically, to checking an existing shelter's remaining room before starting a new structure.
- `storeSurplusNearHome`'s existing surplus-dumping logic gets promoted into something checked on
  the same cadence as a priority tier, not just a post-craft cleanup pass.
- `roles.js` gains `priorities` arrays for Farmer and Herder (§3 above), and Soldier's existing list
  drops the weapon/armor lines (now universal Tier 1, stated once, not per-role) and gains the
  anchor/escort split (§2a).
- New `minecraft-guard-anchor` claim (§2a), same shared-`agent_state`-plus-per-host-fallback shape
  as `BED_CLAIMS_AGENT`, holding a single `{holder, claimedAt}` value rather than one row per bot.
- Before promising "recover a teammate's gear" as part of escort/rescue (§2a): check whether the
  existing post-death recovery logic (`RECOVERY` tier) has any hook for recovering *another* bot's
  drops, or whether that needs new code, rather than assuming it transfers for free.
- Each new/changed check ships with the same test discipline as every fix this session: a unit test
  that fails on the old behavior, a live scenario where the harness can reach it, and a baseline
  metric where it should move a fleet-level number (per this repo's own CLAUDE.md rule).

---

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-11 | Initial proposal, written in response to a direct request to reconsider roles and rebuild the priority model around survival-first and cooperation. |
| 1.1.0 | 2026-10-11 | Resolved all four open review points: Tier 1 outranks (doesn't block) role work; the shared-infrastructure claim reuses the bed-claim mechanism; Builder/Artist stay separate; added the guard-anchor claim (§2a) so Soldiers split into one home-anchor plus escort/rescue once there's more than one. |
| 1.2.0 | 2026-10-11 | Farmer/Herder priority lists rewritten to a shared three-step shape: build the pen/farm, populate it, then gather and store on an ongoing basis. |
| 1.3.0 | 2026-10-11 | Closed a real gap, confirmed against the live code: today's "beds" and "shelter" checklist items are independently satisfiable, so both can report done while most beds sit outside any shelter. Tier 1 item 2 now requires a bed *inside* a qualifying shelter specifically; Tier 2 merges "beds" and "shelter" into one sheltered-bed-capacity item, moved up to run right after the table instead of fourth/fifth. New open question (PROPOSAL-REVIEW 5): multiple small shelters (my lean) vs. one larger shelter design. |
| 2.0.0 | 2026-10-11 | Restructuring: adopted the operator's precise shelter definition (fully sealed, a real door, no cave connection, a bed) as stricter than the current code; resolved PROPOSAL-REVIEW 5 to one individual shelter per bot as the baseline, with a single later communal shelter (stone tier or better) gated on the fleet reaching iron tools, as an addition, not a replacement; added shelter-integrity repair as the top item in Tier 1, ranked above even getting a weapon; added the resource-gathering override as a rule that cuts across every tier rather than a per-category runner, directly superseding `PRIORITIES.md` REVIEW D's narrower framing; stated "nothing supersedes defense" as the document's one absolute, governing rule. |
