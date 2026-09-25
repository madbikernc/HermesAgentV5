# Minecraft bot behavior review and remediation register

**Version:** 1.3.0

Review date: 2026-09-24. Source baseline: `9091ea8` on `master`.

## Scope and evidence

Reviewed the bot runtime, arbiter, physical actions, equipment selection, persistent goals,
stored skills, coordination, role selection, service configuration, and error triage.
This is a review of the checked-out source and checked-in configuration. Production hosts,
runtime overrides, Minecraft world state, and live journals were not inspected. Historical
incidents described in source comments are not counted as new observations.

The adjacent `2026-09-24-minecraft-bots-repro.mjs` executes actual extracted functions with
controlled bot/service stubs and the real arbiter module. Nine checks reproduce defects without
connecting to Minecraft. All JavaScript runtime files passed `node --check`; the triage Python
file parsed successfully. Passing syntax checks does not validate behavior.

**Result: 22 open findings — 10 P1 and 12 P2.** P1 means restore basic behavioral correctness
before extending autonomy; P2 means resolve coordination, waste, or observability problems next.
These priorities describe remediation urgency, not measured incident frequency. No runtime fixes
are included in this review.

## Net effective priorities

### Physical control

The arbiter defines the following order. A higher tier immediately cancels a lower tier;
equal or higher current owners are waited on for up to three seconds. Most routine callers
instead return immediately when they observe an occupied arbiter. There is no fairness queue.

| Rank | Trigger / owner | Actual behavior and qualification |
|---|---|---|
| Bypass | Stuck teleport | Calls unconditional `cancelAndRotate`, sends `/tp`, abandons the goal. The named priority-60 `TELEPORT_HOME` descriptor is never acquired. The replacement routine token is leaked (MB-03). |
| 50 | Critical health | At health 1–6 with a nearby recognized threat, invokes the fight/flee decision. An armed bot generally chooses **attack**, then attempts flee if the eight-second attack fails. This is not a universal escape policy. |
| 40 | Low oxygen | At oxygen <=4 while in water, tries to surface for up to eight seconds, then travel to shore for up to twenty seconds. Critical-health handling outranks it. |
| 30 | Nearby threat / threat while sleeping | Scans every two seconds, within 12 blocks by default and 20 for Mark/Luke. Preempts commands, recovery, squad calls, goals, and chores. |
| 20 | Squad response | Soldiers travel toward an alert within 48 blocks, then attempt combat. Outranks direct player actions and gear recovery. |
| 15 | Gear recovery | After respawn, attempts return to the death site. Outranks direct commands, but canceled recovery currently reports success and skips retry (MB-04). |
| 10 | Direct action | Human or accepted Mayor action. Can preempt goals and chores, but cannot replace another direct action immediately. `STOP` has no special tier (MB-06). |
| 0 | Goal step and routine work | Hunger, sleep, dusk return, deliveries, storage, saplings, lighting, terrain repair, and goal execution share one tier. Acquisition timing determines who runs; hunger has no urgency escalation. |

Evidence: `services/minecraft-bots/arbiter.js:94–117,180–202`;
`index.js:4033–4046,4220–4275,4300–4341,5306–5363,5426–5486`.

This is the intended enforcement order, but MB-02 allows stale continuations to act after
losing ownership. Therefore the actual winner can be whichever asynchronous continuation runs
last. MB-01 also means an acquired combat turn currently waits without starting an attack.

### Fight versus flee

`decideFightType` first flees from phantom/ghast/enderman, or when no sword/axe is available.
Otherwise Soldiers attack; any armed bot below 10 health attacks; other armed bots flee until
three recent flee decisions have accumulated, then attack. The flee streak resets after a
15-second gap. Near-death armed bots therefore become more aggressive. The highest health tier
can delay surfacing while occupied with an attack or its subsequent escape action.

The policy is explicit code, not merely persona guidance. Whether to retain it is an operator
policy decision after combat and ownership are repaired. Threat choice is nearest recognized
mob, not necessarily the attacker or most dangerous mob.

### Choice of ongoing work

| Decision layer | Effective rule |
|---|---|
| Human standing goal | Protected against a Mayor **goal** replacement. This protection does not cover every Mayor action, and dusk/respawn/teleport can still abandon it. |
| Mayor assignment | Can replace a self-selected goal. Five-minute assignment cadence can outrun the ten-minute initial idle period for self-proposal. Until curriculum graduation, non-Soldiers receive the same curriculum objective regardless of specialist role. |
| Builder self-proposal | Fixed checklist: crafting table, furnace, chest, enough beds, shelter, beehive. Repeated selections eventually skip one stalled item. This path bypasses the general goal-conflict model call. |
| Soldier self-proposal | Missing weapon first, then a nearby non-flee-only monster within 32 blocks, otherwise guard. The deterministic path never explicitly checks missing armor, despite the role table suggesting armor first. |
| Other self-proposals | Model-generated, with role priorities framed as suggestions. Recent failures and other goals influence the prompt but do not enforce constraints. |
| Goal execution | Stored skill lookup first; otherwise a model step approximately every 45 seconds. Successful skill execution immediately completes the goal without the ordinary completion checks. |
| Night transition | First eligible dusk check abandons any current goal; no nighttime prohibition prevents later goal proposal/execution. |

Roles: Mayor=Leader; Mark/Luke=Soldiers; Babs=Miner; Amy=Builder; Bob=Farmer;
Nell=Artist; Wade=Explorer; Dale=Herder. All secondary roles are null.

Overall, threat reactions and intermittent chores govern the body; Mayor curriculum and
deterministic Builder/Soldier paths govern much of the work selection. Specialist personas are
a weaker influence. Player intent is not a reliable top-level override because of input drops,
equal-tier exclusion, and goal abandonment.

## Remediation status

**Updated 2026-09-25. All 22 findings are FIXED in source and deployed to both hosts on
`master`; 15 are verified live and 7 by unit tests.** The individual entries below remain as originally written (and still say OPEN), as
the record of what was found. Tests: `services/minecraft-bots/tests/` — `unit.test.mjs` (42
checks), `test_triage.py` (6), `live.test.mjs` (9 action-level scenarios on the bot-sandbox
server), `live-bot.test.mjs` (5 full-bot scenarios: a real bot process with a fake Buzz/memory
server), `monitoring.mjs`, and `baseline.mjs` (per-host metrics vs `tests/baselines/<host>.json`,
pre-fix values recorded at `9091ea8`).
The nine reproductions in `2026-09-24-minecraft-bots-repro.mjs` were inverted into
`unit.test.mjs`; the repro script now fails against `master`, as intended.

Commits: `52769b9` (P1 pass), `4fa347f` (monitoring), `3c4d4a1` (coordination/scheduling),
`7fcc9a6` (measured waste), `0c433a5`/`f2bc3f0` (test system), `4d9750f` (server echoes),
`89a9fd9` (remaining gaps), `2a6c8d8`/`5c27f7f`/`4a93184` and later (acceptance-check tests). Merged as
`dc97f5f` (#1) and `1fd30fb` (#2); everything after is on `master`.

| ID | Status | Fix | Unit | Live (A = action harness, B = full-bot harness) | Baseline metric |
|---|---|---|---|---|---|
| MB-01 | Verified live | `52769b9` | yes | A: real kill; lost-track | attack_win_rate |
| MB-02 | Verified live | `52769b9`, `89a9fd9` | yes | A: preemption; open window closed | — |
| MB-03 | Verified (unit) | `52769b9` | yes, incl. rejected /tp | — | stuck_teleports_per_bot_day |
| MB-04 | Verified live | `52769b9` | yes | A: preemption | action_failure_rate |
| MB-05 | Verified live | `52769b9` | yes, incl. replacement during skill lookup and planning | B: STOP mid-goal | — |
| MB-06 | Verified live | `52769b9`, `89a9fd9` | yes | B: STOP during a long direct action | dropped_messages_per_bot_day |
| MB-07 | Verified live | `52769b9` | yes | A: armor | — |
| MB-08 | Verified live | `52769b9`, `89a9fd9` | yes | A: place_home | rejected_done_per_bot_day |
| MB-09 | Verified live | `52769b9`, `89a9fd9` | yes | B: storing during a goal keeps its materials | store_failure_rate |
| MB-10 | Verified (unit) | `52769b9` | yes, incl. cancelled replay and 13-step solve | — | rejected_done_per_bot_day |
| MB-11 | Verified (unit) | `52769b9`, `4d9750f` | yes | — | — |
| MB-12 | Verified live | `3c4d4a1` | yes, heartbeat + lease expiry | B: restart re-announces the goal | — |
| MB-13 | Verified (unit) | `3c4d4a1`, `89a9fd9` | yes, three claimants → one winner; retry + ack | — | — |
| MB-14 | Verified live | `3c4d4a1` | yes | B: night pauses, morning resumes | — |
| MB-15 | Verified live | `3c4d4a1` | — | A: raw fish | — |
| MB-16 | Verified live | `3c4d4a1` | yes | A: stocked chest vs village scouting | — |
| MB-17 | Verified live | `3c4d4a1` | yes | A: mixed-species chest | — |
| MB-18 | Verified live | `4fa347f`, `89a9fd9` | yes (+ triage) | monitoring.mjs: all 9 units mirrored and triaged | action_failure_rate |
| MB-19 | Verified (unit) | `4fa347f` | test_triage.py: per-bot dedupe, counts, queue | — | — |
| MB-20 | Verified live | `3c4d4a1`, `7fcc9a6` | yes, incl. restart persistence | B: Mayor restart keeps evidence | — |
| MB-21 | Verified (unit) | `3c4d4a1` | yes, router/RAG timeouts, planning without control | — | planner_calls_per_bot_day |
| MB-22 | Verified (unit) | `52769b9`, `89a9fd9` | yes, stationary vs wedged | — | stuck_teleports_per_bot_day |

**Redundancy items:** home lighting (one maintainer + backoff, `7fcc9a6`); repeated chest search
(60s empty-search cache), gear refresh (skipped when nothing changed), per-note duplicate search
(30-min repeat cache; ingest coalesced in `3c4d4a1`), and timer fairness (`ROUTINE_SKIPS`
instrumentation + `routine_skips_per_bot_day` metric) in `89a9fd9`. Measured waste the review
didn't list — Soldier guard churn, instant DONEs, storing into full chests — fixed in `7fcc9a6`.

**Contradictions:** Soldier role text now says weapon, then armor, and the code checks armor
(`89a9fd9`). The HEALTH_CRITICAL comment now says fight-or-flee; teleport really is cancel-and-clear.
The secondary-role prompt only appears for a bot with a secondary role, and no persona file
mentions one any more — no change needed. `MINECRAFT_BOTS_DESIGN.md` 2.2.0 documents the new rules.

**Not verified live, by design:** MB-03, MB-10, MB-11, MB-13, MB-19, MB-21 and MB-22 need a failed
`/tp`, a 13-step solve, Mayor going silent, three real donors, two simultaneous crashes, a stalled
model, or a genuinely wedged bot. None can be staged safely on the shared world, so unit tests are
their evidence.

**Early fleet numbers (spark, 2026-09-25 01:25, window still mostly pre-fix):** guard goals
68.6 → 23.2 per bot-day, home-lighting attempts 412 → 201, store failures 78% → 57%, planner calls
245 → 175. Dropped messages since the latest restart: ~3 per bot-day vs 54 before (the 24h
metric still reads high because of pre-fix hours and a test-induced RCON flood in the window).

**Still to do:** re-record each host's baseline after a full day on `master`
(`tests/run.sh baseline --update`), and treat any metric that doesn't improve as a reopened finding.
**Fight-or-flee, decided 2026-09-25 (`4baa0a7`):** an armed bot still fights one melee or ranged
mob, but flees when outnumbered at critical health (2+ within 8 blocks, any role), from 3+ hostiles
(non-Soldiers) and from a close creeper; the threat is the mob that just hurt it. Verified by unit
checks and live (the probe flees two mobs and fights one at critical health). The same data exposed
a lethal stuck-rescue bug -- `/tp` to the spawn block's corner suffocated bots in the shelter walls
(every post-teleport death in the server log) -- fixed with `/spreadplayers`, verified live.

**spark2 RAG, fixed 2026-09-25 (`4baa0a7`):** spark2's bots now use spark's shared RAG through
`hermes-minecraft-rag` (LAN-only, token auth, ufw open to spark-2 only); first live evidence was Bob
loading and running a shared stored skill two minutes after the restart.

## Accumulated remediation register

All entries are **OPEN**. References are relative to the repository; unqualified JavaScript
filenames below are in `services/minecraft-bots/`.

### MB-01 — P1 — Attack never starts combat

**Evidence:** `actions.js:2566–2652`. The branch selects a target, equips weapon/shield, polls
target existence, and calls `pvp.stop()` on timeout. There is no executable `pvp.attack()` or
`bot.attack()` call anywhere in the runtime. Reproduced with an existing target and a spy:
zero attack calls, timeout result.

**Impact:** Soldiers, direct attacks, self-defense escalation, and critical-health combat spend
their turns waiting. A target unloading can even produce “took care of it” without a kill.

**Remediation / acceptance:** Start combat after checking ownership; monitor meaningful combat
outcomes. A controlled target must receive attack attempts; losing sight must not claim a kill.

### MB-02 — P1 — Preemption does not fence off the previous owner

**Evidence:** `actions.js:2152–2171` borrows whichever token is globally current, without a caller
handle. `runSkill:130–138`, storage batches (`index.js:4484–4497`), and several multi-action
handlers continue without testing their original handle. `actions.js:2698–2700,3679–3680` and
`index.js:4316–4336,5453–5484` perform unguarded cleanup or follow-on movement after awaits.
Reproduced both a stale caller starting FOLLOW under `HEALTH_CRITICAL` and canceled recovery
clearing a newly installed emergency path.

**Impact:** Low-priority work can execute during an emergency, stop the new owner's route,
restore movement settings at the wrong time, or continue a multi-step batch after interruption.
Drowning's loop also lacks a token check and can initiate shore travel after losing ownership.

**Remediation / acceptance:** Pass the acquired handle into every action and batch; reject stale
handles before and after awaits. Scope timers, equipment restoration, path cleanup, and control
states to their owner. Preempt at each await boundary and verify the old task cannot change the
new task's body state. Cancellation must also cover ongoing interaction operations, not just
pathfinding, PvP, collection, and digging.

### MB-03 — P1 — Teleport leaves a permanent routine owner

**Evidence:** `index.js:4840–4863` calls `cancelAndRotate()` and discards its returned token.
`arbiter.js:145–150` creates `current={owner: ROUTINE,token}`. No release follows. Reproduced:
`isBusy()` remains true; a new `GOAL_STEP` request is refused.

**Impact:** Autonomous goals and most chores stop after self-rescue until a higher-tier action
acquires and releases control, or the process restarts. This occurs even if `/tp` is rejected.

**Remediation / acceptance:** Implement a cancel-and-clear operation for teleport, or explicitly
release the exact temporary token. Verify both successful and rejected teleports leave no owner.

### MB-04 — P1 — Cancellation is recorded as successful work

**Evidence:** Numerous action branches return `ok(...)` on `token.cancelled`, including
`actions.js:2274–2279,2649,2696–2702,3676–3681`. Recovery then breaks on
`result.ok || !handle.token.preempted` (`index.js:5263–5265`). Reproduced canceled recovery as
`ok:true`, with the retry predicate selecting “break.” `goals.js:135–145` marks these results
as successful and records their actions; skill replay advances on them.

**Impact:** Recovery retries are bypassed; interrupted steps reset failure counters, establish
false progress, generate misleading memories, and contaminate reusable skills and delivery claims.

**Remediation / acceptance:** Use distinct completed, partial, canceled, and failed outcomes.
Track actual progress separately. Cancellation must neither claim completion nor count as a
genuine action failure; preempted recovery should retry within its existing bound.

### MB-05 — P1 — In-flight work can mutate or erase a replacement goal

**Evidence:** `index.js:3147–3568` repeatedly dereferences mutable global `currentGoal` across
awaits. `setNewGoal:4904–4908`, STOP, dusk, and respawn replace or clear it. No captured goal
identity/generation is checked. Reproduced an old action result incrementing a replacement goal's
steps and log while leaving its original goal untouched.

**Impact:** New commands inherit old results or are cleared by old completion handling; a null
goal produces exceptions. The catch logs an error without restoring consistent goal state.

**Remediation / acceptance:** Capture a goal ID and generation for each tick; only mutate/save/
clear that generation. Replacement must invalidate active planning/execution. Test replacement,
STOP, death, and dusk during skill lookup, planning, action execution, and narration.

### MB-06 — P1 — Direct commands and STOP are dropped or refused

**Evidence:** `index.js:4941–4943` drops all incoming messages while `busy`, including during
goal planning (`3228–3264`). All direct actions use tier 10 (`2434`); equal-tier exclusion in
`arbiter.js:183–187` rejects a second command after three seconds. STOP has the same tier and
passes through model classification. A direct action can take much longer than three seconds.

**Impact:** A player cannot reliably stop a directly commanded long action; messages during
model work disappear without a response. Clearing the standing goal before a refused STOP does
not stop the currently running physical action.

**Remediation / acceptance:** Give explicit cancellation a deterministic input path and defined
ownership policy; queue or acknowledge other commands. A STOP issued during classification,
planning, or a long direct action must produce a bounded, observable cancellation response.

### MB-07 — P1 — Armor selection downgrades and oscillates

**Evidence:** `equipment.js:95–104` compares only carried armor; it excludes worn slots 5–8.
Reproduced: netherite helmet worn + leather helmet carried becomes leather worn, then switches
back to netherite on the next refresh as the pieces exchange inventory positions.

**Impact:** Frequent action cleanup can repeatedly remove stronger armor, undermining the
survival policy and producing needless inventory operations.

**Remediation / acceptance:** Include the currently worn item in each slot's comparison and
only equip a genuinely preferable candidate. Repeated refreshes must converge and remain stable.

### MB-08 — P1 — Builder goals require navigation the planner cannot express

**Evidence:** `index.js:2906–2934` creates goals requiring home placement; `parseGoalStep:2500–2592`
has no GOHOME branch, and the planner vocabulary lacks it. The physical action exists at
`actions.js:2846–2880`. Reproduced `ACTION GOHOME` being parsed as blocked. A later special
completion-rejection recovery (`index.js:3354–3362`) is only a conditional workaround.

**Impact:** Amy cannot reliably plan “go home, then place/build”; she can place infrastructure
where she happens to stand or repeatedly abandon a partially completed checklist goal.

**Remediation / acceptance:** Expose home navigation through the shared action schema and planner,
or execute a deterministic home-placement sequence. Start Amy away from home and verify the
whole checklist operation reaches the designated location before placement.

### MB-09 — P1 — Post-craft cleanup stores materials needed for the active goal

**Evidence:** `index.js:2463–2479,3456–3457,3560–3568` launches cleanup after craft, smelt, and
targeted loot. `4471–4488` stores all quantities of up to five nonessential item names.
`actions.js:1087–1089` exempts gear suffixes, coal/charcoal, and food; it does not reserve the
current goal's furnace/table/chest, ingots, planks, sticks, torches, or specialist equipment.

**Impact:** Crafting a table for subsequent placement can immediately put it in storage;
retrieving a material can put it back. Productive multi-step goals turn into repeated loot,
craft, store, and missing-item cycles.

**Remediation / acceptance:** Reserve current-goal inputs and outputs, plus role essentials.
Store demonstrable surplus at a safe checkpoint. Verify a crafted furnace survives until its
placement step and freshly looted recipe ingredients survive until crafting.

### MB-10 — P1 — Stored skills bypass completion checks and can omit the actual solution

**Evidence:** `index.js:3188–3202` immediately completes goals after a successful skill, bypassing
inventory and Builder world checks. `skills.js:130–138` checks only per-step `ok`; `185–188`
keeps the first 12 actions even if the goal required more. `goals.js:135–144` separately caps
recording at 20 actions. Reproduced a canceled first step allowing subsequent steps and overall
success. Ordinary `DONE NONE` validation also allows a zero-step goal because
`noEvidenceOfProgress` requires `steps > 0` (`index.js:3274`).

**Impact:** A partial recipe can be labeled a complete skill; replay or a zero-step DONE claim
can report completion without the requested outcome. Incorrect successes reinforce future reuse.

**Remediation / acceptance:** All completion routes need the same goal-specific postcondition.
Do not silently truncate action sequences into purported solutions; reject or validate them.
Test a 13-step goal whose essential placement is step 13, canceled replay, and zero-step DONE.

### MB-11 — P2 — Mark's fallback coordination is unreachable at recipients

**Evidence:** `index.js:3826–3875` lets Mark send fallback directives, but `4917` rejects every
other bot except Mayor. Reproduced Mark's directive returning before classification. Also,
`3833` prevents takeover if Mayor has never been seen since startup.

**Impact:** Fallback model calls and chat produce no work; a fleet starting without Mayor never
activates its intended backup coordinator.

**Remediation / acceptance:** Recognize an explicitly elected/authorized fallback identity and
use real liveness/startup timeout state. Verify both Mayor disappearance and Mayor absent at boot.

### MB-12 — P2 — Fleet goal state has no reconciliation or expiry

**Evidence:** `buzz.js:39–61` skips prior events on initial polling. `index.js:2064–2066` resumes
a saved goal without rebroadcasting it. `otherBotGoals` updates only from transitions at
`5059–5065`; entries have no lease expiry or active heartbeat.

**Impact:** Restarted coordinators see busy bots as idle and issue replacements; disconnected
bots may remain “busy” forever. Conflict avoidance and idle selection use stale or absent state.

**Remediation / acceptance:** Publish resumptions and periodic status; reconcile from snapshots
and expire stale peers. Restart Mayor mid-goal and disconnect a worker to test both directions.

### MB-13 — P2 — Item requests have no single supplier or reservation

**Evidence:** Every bot with `have >= payload.count` schedules the same request
(`index.js:5106–5115`). There is no claim, request ID, winner, or inventory reservation.
`4393–4409` clears the request before delivery and reports success using the action's `ok`.

**Impact:** Multiple bots abandon work to deliver duplicates. A supplier can give away its
last needed item; failed deliveries are lost; later requests repeat the same fleet-wide work.

**Remediation / acceptance:** Add request IDs, one supplier claim, bounded expiry/retry, inventory
reservation, and quantity acknowledgments. With three eligible donors, verify one delivery.

### MB-14 — P2 — Night handling abandons work and permits contradictory new work

**Evidence:** `index.js:3909–3917,3958–3975` sets nightly attempt flags before control/action
success; dusk clears any goal before attempting return. `goalTick:3147–3160` has no night/home
phase constraint. The return and sleep flags prevent another attempt that night after failure.

**Impact:** A human goal can be lost even when home travel fails. The bot can subsequently
propose more work and head out again; a failed or interrupted bed attempt is not retried.

**Remediation / acceptance:** Suspend/resume goals through explicit dusk, home, sleeping, and
day phases. Record successful transitions and bounded retry times rather than one-shot intent.

### MB-15 — P2 — Hunger can starve behind work; fishing does not close the food loop

**Evidence:** `index.js:4352–4371` only eats when neither model nor arbiter is busy; it uses
routine tier even at severe hunger. Its food fallback is fishing. `actions.js:1019–1026`
includes cooked fish but excludes raw cod/salmon; `SMELT_RECIPES:1123–1129` has no cooking recipe.

**Impact:** Long or repeated high-priority work postpones eating. When fishing supplies raw
fish, that catch does not satisfy the next eat attempt; the bot can keep fishing while hungry.

**Remediation / acceptance:** Escalate critical hunger, reserve edible food, and implement a
complete acquisition-to-consumption path. Verify recovery from no food with only a fishing rod.

### MB-16 — P2 — EXPLORE can repeatedly loot instead of scout

**Evidence:** `actions.js:2301–2306` checks chests for any common resource and returns success
immediately on a hit. Exploration itself gathers local resource blocks; it has no target mode
for village/bee-nest/feature discovery, despite Explorer's priorities in `roles.js`.

**Impact:** Wade's exploration can be satisfied near home by withdrawing existing stock.
Repeated “explore” goals may consume supplies without discovering territory or the named feature.

**Remediation / acceptance:** Separate gathering from scouting and check a scouting-specific
outcome. A stocked home chest must not complete a request to discover a village.

### MB-17 — P2 — Chest family matching adds unlike stacks, then withdraws one type

**Evidence:** `actions.js:1810–1827` sums all matching item variants but calls `withdraw` only
with `matches[0].type`. Example: two oak logs plus two birch logs, request four logs, attempts
to withdraw four oak logs. The generic catch returns null and can leave the chest unclosed.

**Impact:** Available supplies are treated as unavailable, prompting extra chest trips, mining,
or crafting. A family-wide match is not a valid count for one concrete item type.

**Remediation / acceptance:** Withdraw across actual matching types or cap each withdrawal to
its real count; close windows in finally. Verify mixed-species log and mixed-tier gear chests.

### MB-18 — P2 — Checked-in monitoring omits four bots and misses ordinary failures

**Evidence:** `tools/hermes-minecraft-triage.py:132–137` defaults to Babs/Amy/Mark/Luke/Mayor.
`infra/minecraft-bots-activity-log/minecraft-bots-activity-log.service:7` names the same five.
Neither checked-in triage unit supplies a replacement list nor the activity unit discovers
host-local bots. Bob/Nell/Wade/Dale are assigned to spark2 by the deployment README.

The patterns at `hermes-minecraft-triage.py:146–160` miss ordinary `ok=false`, combat timeouts,
and `REJECTED DONE` without a separate matching flag. Sample-line matching confirmed these
misses. README statements claiming every host-local bot is watched exceed the checked-in code.

**Impact:** Recreating monitoring from this repo leaves spark2's four bots outside those log
streams. Many behavioral failures never become remediation incidents even for covered bots.

**Remediation / acceptance:** Derive monitored units from the deployed host's inventory; emit
structured action outcomes and rejected completions. Inject a sample failure from each of all
nine units and verify both raw retention and incident collection. Live overrides remain unverified.

### MB-19 — P2 — Triage drops incident distinctions and blocks collection during diagnosis

**Evidence:** `tools/hermes-minecraft-triage.py:341–367` keys cooldown only by category, with a
five-minute default, and runs `triage_incident` synchronously inside the journal-reading loop.
Suppressed events receive no counter or durable incident record here; only the diagnosis is
appended. Diagnosis runs model requests which may take many seconds.

**Impact:** One bot's crash can suppress another bot's same-category crash. Slow model diagnosis
delays reading subsequent incidents. The output cannot provide accurate recurrence counts.

**Remediation / acceptance:** Persist normalized events before diagnosis; deduplicate by bot,
category, and stable signature while retaining count/first/last timestamps. Process diagnosis
through a bounded queue. Two bots crashing within five minutes must remain two incidents.

### MB-20 — P2 — Mayor curriculum validation and selection contradict its assignments

**Evidence:** `index.js:3599–3634,3668–3687,5072–5079` treats any listed item as stage completion:
one axe can satisfy “pickaxe and axe”; one iron sword can satisfy “full armor and sword.”
`3746` selects the first idle non-cleared bot before role fairness. Soldiers are excluded from
required completion, but still eligible for that first selection. `3644–3658` persists only
stage index, not per-bot progress. Non-Soldier role specialization is omitted while a stage exists.

**Impact:** Stages can advance with missing capabilities, or repeat work after restart.
An idle Soldier without stage credit can repeatedly get the slot ahead of later workers;
specialists can spend their time on generic curriculum work.

**Remediation / acceptance:** Use conjunctive, tier-aware stage predicates; persist/reconcile
per-bot evidence; restrict stage-target selection to stage participants and apply fairness there.
Express curriculum needs as role-appropriate contributions where shared resources suffice.

### MB-21 — P2 — Model/service waits unnecessarily hold the bot's body and drop input

**Evidence:** `index.js:2434–2476` holds direct control across both narrations and memory writes;
`3168–3568` holds goal control across skill lookup, planning, memory, and authoring. The router
client (`router.js:12–24`) has no explicit application deadline/abort signal; RAG subprocesses
in `skills.js`/`longterm.js` have no configured execution timeout.

**Impact:** A slow supporting service postpones hunger and other same-tier work, and planner
waits cause incoming messages to be dropped. The result can look like inactivity even though
the process remains alive. Repeated unsuccessful skill lookups occur on every eligible goal step.

**Remediation / acceptance:** Bound external calls; plan outside physical ownership and validate
state before execution. Release the body before narration/indexing. Cache a no-match skill result
until the goal or skill-library generation changes. Test delayed model and RAG responses.

### MB-22 — P2 — Stationary activity is treated as being stuck

**Evidence:** `index.js:4866–4896` checks position only, with no attempted-movement/progress test.
After two five-minute nudges, the next stationary interval teleports. Guarding, idle presence,
and stationary interactions can meet this condition. Nudging also writes jump controls outside
the arbiter. `lastMovedAt` is reset before computing the logged elapsed duration (`4884,4894`).

**Impact:** Intended guard duty can be interrupted by false rescue, followed by MB-03's lock.
The diagnostic often says zero seconds despite a five-minute interval, making triage misleading.

**Remediation / acceptance:** Detect failure to progress toward an active movement objective,
exclude legitimate stationary states, arbitrate nudges, and preserve elapsed time for logging.
Verify a stationary guard remains in place while a genuinely wedged travel action escalates.

## Redundancy and wasted work to consolidate

These are source-supported efficiency opportunities; their production cost has not been measured.

- **Chest search runs twice:** the planner advises explicit LOOT before MINE, while MINE and
  CRAFT unconditionally search chests themselves (`index.js:2671–2683`; `actions.js:2217,2366`).
  Carry a short-lived inventory/chest observation into the action so an unchanged failed lookup
  does not immediately repeat.
- **Nine independent home-lighting loops:** every bot may acquire torches and perform a home
  scan every 90 seconds (`index.js:4621–4705`), without a shared task claim. Use one assigned
  maintainer or claim individual dark locations; keep immediate local safety checks separate.
- **Repeated equipment refreshes:** many action cleanup paths run armor and weapon selection
  even when nothing relevant changed. Fix MB-07, then make refresh conditional on inventory,
  durability, or gear changes.
- **Per-note search and index processes:** a resource scan may write one note per distinct block
  name; each note runs duplicate search and awaits an ingest subprocess (`index.js:2046–2060`;
  `longterm.js:49–68`). Batch discoveries and serialize/coalesce indexing on each host.
- **Independent polling has no fairness contract:** chores at 10/15/20/30/90-second intervals
  compete with 45-second goal steps. Consolidate dispatch decisions around explicit readiness,
  urgency, aging, and reservations rather than adding more unrelated timers.
- **Contradictory behavioral definitions:** Soldier role guidance says armor before weapon;
  executable self-proposal checks weapon then fighting/guarding. Generic role text still offers
  a secondary role even though all secondaries are null. Arbiter comments describe emergency
  fleeing and cancel-only teleport more strongly than the implementation supports. Reconcile
  documentation only after selecting and testing the intended policy.

## Remediation order and closure evidence

1. **Restore safe execution:** MB-01, MB-02, MB-03, MB-04, MB-07. These are prerequisites for
   trustworthy combat, recovery, and arbitration.
2. **Protect task intent and completion:** MB-05, MB-06, MB-08, MB-09, MB-10. Add goal identity,
   reservation, and outcome checks before teaching more skills or expanding the vocabulary.
3. **Make errors countable:** MB-18 and MB-19. Capture events from both hosts before further
   behavioral tuning so changes can be judged against actual failures.
4. **Repair fleet coordination and scheduling:** MB-11–MB-17 and MB-20–MB-22, then optimize
   repeated searches, indexing, and housekeeping using measured timings.

For each finding, record: ID, status, owner, source/fix commit, affected bots/hosts, first and
last observed timestamps, occurrence and suppression counts, goal/action ID, actual arbiter
owner, health/food/oxygen when relevant, raw evidence, focused test result, and live verification.
Keep source-proven defects separate from observed runtime incidents; link incidents to these IDs.
Do not close a finding solely because a log message changed or a model claimed success.

Suggested live measurements after fixes: successful hits during attack; time to honor STOP;
stale-owner mutations; canceled-versus-completed actions; verified goal completion rate;
food recovery time; false stuck rescues; duplicate deliveries; time waiting on external services;
and incident coverage/counts for every bot on both hosts.

## Reproducing this review

From the repository root:

```bash
node docs/reviews/2026-09-24-minecraft-bots-repro.mjs
```

The script asserts the observed defective behavior at the reviewed commit. Its success means
the defects were reproduced, not that the bot is correct. Convert these cases into assertions
of corrected behavior during remediation. The harness uses source extraction and controlled
stubs; it does not verify real network timing, server configuration, plugin internals, or combat
damage against a live Minecraft server.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-24 | Initial source review, effective priority analysis, 22 open findings, and nine focused reproductions. |
| 1.1.0 | 2026-09-25 | Remediation status: all 22 findings fixed and deployed, with fix commits, tests, live verification and baseline metric per finding. |
| 1.2.0 | 2026-09-25 | Acceptance checks run: 15 findings verified live (action and full-bot harnesses, monitoring), 7 by unit tests; early fleet numbers; the deferred fight-or-flee decision. |
| 1.3.0 | 2026-09-25 | Fight-or-flee policy decided and verified; stuck-rescue suffocation fixed; spark2 RAG restored via spark. |
