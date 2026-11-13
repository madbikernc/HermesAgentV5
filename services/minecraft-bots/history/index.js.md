# index.js change history

**Version:** 1.0.0

The change history of `services/minecraft-bots/index.js`, newest first. Until 2026-11-13 it was the
comment block at the top of `index.js` itself (149k characters, more than the self-repair pipeline's
whole 40000-character file limit on its own); it was moved here verbatim when `index.js` was split
into subject modules (`index.js` 3.0.0, direct operator request). `index.js` keeps its `// Version:`
line; each new version's entry goes at the top of the list below.

## Versions

### 3.0.0 (2026-11-13)

Split into subject modules, each under the self-repair pipeline's 40000-character limit: fleet-coordination.js, goal-proposal.js, goal-runners.js, gear-goals.js, shelter-goals.js, goal-tick.js, mayor.js, night-survival.js, upkeep-inventory.js, upkeep-home.js, upkeep-world.js, incoming.js. Code moved unchanged except: every top-level statement that runs at load (listeners, periodic checks, install calls) stays in index.js in its original order; three inline listeners became named functions (watchFleetTopics, onEmergencyHealth, onLowBreath) so their bodies could move; a module-level variable written from another file is written through a setter (setBusy, setCurrentGoal, setLastActivityAt, setLastMayorSeenAt, setPendingGiveRequest, setLastHarvestAt, and the existing setSurplusCleanupDueAt); index.js re-exports every name it exported before, so existing imports still resolve. This change history moved here.

### 2.145.0 and earlier (moved verbatim from index.js)

```text
2.145.0 | 2026-11-11 | Report actual dropped counts and release control before give narration.

2.144.1 (2026-11-11, direct report: build "successes" were false positives): shelterStep's
"build says it stands" guard checks that THIS goal's site is a complete shelter, not that any
complete shelter exists near home -- the fleet's one finished residence always satisfied the old
check, so a build that did nothing passed as progress and reset consecutiveFailures every tick.
(home-scan.js 1.0.1 closes the loop's other half: it no longer offers that residence as a site.)

2.144.0 (2026-11-10): the priority lists (survival, tools, shelter reface, builder, soldier) and
the communal shelter checks moved unchanged to priorities.js.

2.143.0 (2026-11-10): home scanning (blocks near home, shelter and residence detection) moved
unchanged to home-scan.js.

2.142.0 (2026-11-10): planning (runAction, parseGoalStep, planNextStep, arbitrateGoalConflict)
moved unchanged to planning.js; its two writes to this file's state go through new setters.

2.141.0 (2026-11-10): chat and intent (classifyIntent, the chat reply, narration, what gets
remembered) moved unchanged to chat.js.

2.140.0 (2026-11-10): self-defense, threat memory, squad response and rally points moved unchanged
to self-defense.js; installSelfDefense() registers its health listener and tick where they were.

2.139.0 (2026-11-10): every periodic check runs through faults.js's guardedInterval() -- an error
in one tick is logged with its file:line and the next tick runs, instead of ending the process --
and installFatalHandlers() logs any other uncaught error the same way before exiting.

2.138.0 (2026-11-10): the pathfinder setup (movement costs, unbreakable blocks, search limits,
path_update/path_reset diagnostics, dig_error burst guard) moved unchanged to pathfinding.js's
setupPathfinding(), so self-repair can generate a pathfinding fix against a file it can read.

2.137.0 (2026-11-07): installSteppedGoto -- a goto whose search runs out of budget walks the partial
path toward the goal and searches again (swim-movements.js 1.6.0).
2.136.0 (2026-11-07): checkChestConsolidation() runs the move a chest snapshot found, once she's idle.
2.135.0 (2026-11-06, direct report: "there's a pen but none of the livestock is moved to it"): the
ranch goal picks its species again once that species is gone, counts animals 64 blocks round the
pen, and with none of any kind goes exploring instead of failing in place.
2.134.2 (2026-11-06): findNearestShore tells water by name (isWet), not block.liquid, which
mineflayer's Block doesn't have -- the "shore" it found was the sea floor.
2.134.1 (2026-11-06): gatherPlanks with no tree within 32 blocks goes looking ("mine" oak_log: a
remembered spot, then a wandering search) instead of failing -- the fresh world's spawn has none.
2.134.0 (2026-11-05): the Farmer and Herder do their own jobs (nextRoleWork, after Tier 1 but
ahead of its fleet-wide residence item, and before the Builder checklist): the Farmer tends the
farm whenever nothing grows or something is ripe, the Herder builds the herd up to 6 penned. A
hungry bot stands in for her own role too. Also: a residence's chest goes only where it cuts off
no bed or door (residenceChestCell); a two-bed shelter is full without one -- every bot was stuck
asking for a chest in a bed's last way in. craftItem (actions.js 1.104.0) makes enough sticks for
23 fences, one recipe run per bot.craft() call.
2.133.2 (2026-11-05): the extra-chest retry backs off only when there's no wood (noWood), not
on a transient craft failure.
2.133.1 (2026-11-05): the shore search after surfacing runs while she's still at water (atWater),
not only while isInWater -- at a deep pool's surface her jump read isInWater=false for a tick, the
search was skipped and she sank again.
2.133.0 (2026-11-04, 24h review): a full bot whose chests are all full makes another chest, and
with no slot free drops plain surplus first (junkToDrop: spare weapons and tables, seeds past 64,
rotten flesh). No pickaxe means the Tier 1 tools item is a wooden one, and stone reinforcement
waits for it. A Builder crafting table, furnace or chest she doesn't hold is made by its own
runner (no more DONE NONE). Direct requests the same day: the residence model replaces "every
bot her own shelter" -- a bed for each ACTIVE bot, each in a residence (enclosure, door, bed,
chest): a missing chest first, then a bed in an empty shelter, else a new shelter (residencePlan;
shelter_capacity uses the same count). Trash (spent gear, rotten flesh) is thrown into lava she
can see. A full set of chests gets another chest even before her own slots run out. The
drowning reflex reads her own air (bot.oxygenLevel follows any entity's), and the shore search
survives findBlocks' palette pass, so she now reaches dry land.
2.132.0 (2026-11-01, direct request): with no Farmer or Herder in the game, a hungry bot with
nothing to hunt stands in -- the food goal becomes a farm goal (or a ranch goal once a farm
stand-in has given up), and both now gather their own planks and seeds. Wheat becomes bread.

2.131.0 (2026-11-01): a food-goal step that finds nothing waits 30s before the next (FOOD_RETRY_MS).

2.124.0 (2026-10-28) -- direct request: item drop on death is now off (keepInventory), so the
old post-death "walk back to where she died" march has nothing left to recover and is removed.
Deleted deathPosition/recovering/recoveryAttempts/lastDeathAt/MAX_RECOVERY_ATTEMPTS/
RAPID_DEATH_WINDOW_MS and the bot.on("spawn") recovery block that re-requested RECOVERY-tier
arbiter control and called actions.js's "recover" action (retrying up to MAX_RECOVERY_RETRIES
times) to path back to the death spot before vanilla's 5-minute despawn timer -- none of that
applies anymore since nothing despawns. bot.on("death") still broadcasts a death alert (squad
awareness/response is unrelated to item recovery) and bot.on("spawn") still abandons her
standing goal on respawn (her position reset to spawn/bed makes it stale regardless of gear).
actions.js's "recover" action and arbiter.js's OWNERS.RECOVERY are left in place -- they were
never a player-facing ACTION verb, only this now-deleted call site used them for the real fleet,
and the test suites (unit.test.mjs MB-04, live.test.mjs MB-02/04) still reuse "recover" as a
convenient plain goto for exercising arbiter preemption, unrelated to death handling.

2.122.0 (2026-10-27, direct requests over several follow-ups, investigating "why don't
furnaces/chests/shelter get built"): four changes.
(1) New countUsableNearHome() (wraps countNearHome()'s own previously-unused filterFn with
actions.js 1.94.0's new isUtilityUsable()) replaces the bare countNearHome() in
builderPriorityCandidates() AND builderPriorityItemSatisfied() for crafting_table/furnace/
chest -- BOTH call sites, deliberately kept in lockstep, since fixing only one would let them
diverge (the checklist saying "furnace still needed" while the very next tick's completion
check says "yes, done"). Root cause: bare block existence near home was treated as permanently
"done," even once real interaction proved a specific chest/furnace unreachable or unusable --
confirmed live, two real chests sitting there failing "No path to the goal!"/windowOpen
timeouts for a full day while the checklist considered chest storage finished. beehive is left
on the old countNearHome() check -- same underlying pattern, but not reported, not touched.
(2) findShelterNearHome() (backs hasShelterNearHome()/hasOwnShelterWithBed(), checked from
nextSurvivalPriority() on the hot fleet-wide tick path) now rings outward
(SHELTER_DETECTION_RINGS) up to BUILDER_PRIORITY_RADIUS, matching actions.js 1.94.0's
findShelterSite() widening (itself capped higher, at 48, per direct request) -- this is the
regression that widening ONLY the site-finder would have caused: a shelter genuinely built
beyond the old fixed 4-block window would have been invisible to this check, so shelterStep()
would report its own build ok:true (resetting consecutiveFailures) but done:false forever, a
silent infinite loop with no escape -- strictly worse than the bounded give-up/re-propose churn
that existed before any of this. shelterStep()'s own error text and findShelterSite() call site
updated to the new 48 cap.
(3) New RAG registration for buildable resources -- direct request, "all resources, including
buildable resources, should be registered to the RAG," the same writeMemoryNote() convention
noteNearbyResources() already uses for raw ore veins. runBuilderPlacement() (covers crafting_
table/furnace/chest/beehive for free, since all four dispatch through this one function) and
runShelterGoal() (genuinely new coverage -- shelter isn't in CRAFTED_OBJECT_NAMES and can't be,
it's a multi-block structure) each write a note on a real, freshly-completed placement. The
Builder checklist's OWN countUsableNearHome()/countNearHome() existence checks deliberately do
NOT consult this note -- bot.spawnPoint is the single world spawn, shared identically and in
real time by all 9 bots, so there is no cross-host visibility gap in the checklist's own
satisfaction logic to close, and doing so would reintroduce a "satisfied because something
exists somewhere on the server" false-done bug, just laundered through RAG instead of bare
existence. The note is for OTHER consumers: crafting_table/furnace already feed
findRememberedLocation()'s existing away-from-home fallback inside craft(); chest closes the
real known_chests.json per-host split (spark/spark2 each kept their own copy, confirmed by
diffing both); shelter has no existing reader yet, added anyway per the request.
(4) bedStep() -- direct request, "if exploring, and far away from a known bed listed in world
resources, they should try to build a new one." place_bed already supported an arbitrary
action.near (added for the communal shelter) but individual placement never used it, always
defaulting home. Now: if she's farther than BUILDER_PRIORITY_RADIUS from both bot.spawnPoint
AND the nearest findRememberedLocation("bed") hit, place_bed's near points at her own current
position instead of forcing a long walk home. runBedGoal() also registers the new bed via (3).

2.121.0 (2026-10-22, direct request, generalizing 2.120.0's own fix): checkShelterIntegrity()
and checkCommunalShelterIntegrity() merged back into one -- the operator's own next request
after 2.120.0 shipped was "it should recognize: any number of individual shelters; larger
shelters as defined by contiguous walls roof and floor, broken only by doors," which named
exactly the two corners 2.120.0 still cut: one shelter at a time, and only the two hand-coded
geometries ("build"'s small room, "build_communal_shelter"'s parameterized rectangle). The
unified check now calls shelterRoomsNear() (shelter.js 1.3.0), which finds every qualifying
room near home in one pass regardless of count or shape, and repairs via the new generic
"patch_shelter" action (actions.js 1.93.0) using each room's own real hole positions --
nothing here computes or assumes a shape anymore. findShelterNearHome()/
findCommunalShelterNearHome() and the two build actions are unchanged and still own their own,
separate job: the fleet's shelter-count progression check, and giving a brand-new shelter a
concrete shape to build when none exists yet.

2.120.0 (2026-10-22, direct report: "there is a large shelter with many beds, but it has
holes or missing parts. They are not repairing it as a large structure"): new
checkCommunalShelterIntegrity(), a standalone ROUTINE-tier timer mirroring
checkShelterIntegrity() exactly but for the communal structure. Root cause: the communal
shelter's own damage detector, findCommunalShelterNearHome(), already existed and was already
correct -- its only caller was communalShelterStep(), which only runs while a bot is actively
pursuing the "communal_shelter" self-propose goal, and nextBuilderPriority() stops proposing
that goal forever the instant communalShelterSatisfied() first returns true. Once built and
bedded, nothing ever looked at it again. New check runs independently of any active goal, the
same way checkShelterIntegrity() already does for individual shelters, and re-runs
"build_communal_shelter" with the real width/depth findCommunalShelterNearHome() already
reports -- that action's own "already standing" early return makes a call against a genuinely
intact structure a safe no-op.

2.119.0 (2026-10-21, direct request: "fix the mayor bot screening" -- IMPLEMENTATION_PLAN.md
S34): classifyIntent() and generateReply() now pass analysis: isAnotherBot(speaker) to
callRole() instead of always leaving the flag unset. handleIncoming()'s own isAnotherBot()/
isActingCoordinator() gate (above, before either function is ever called) already guarantees
that whenever isAnotherBot(speaker) is true at that point, it's a verified bot coordinator --
Mayor's real directive, or Mark's fallback-coordinator directive -- never an arbitrary other
bot's chatter and never a player's text, since isAnotherBot() checks the authenticated
mineflayer `speaker`, never the message body. proposeDirectiveForOthers()/
proposeFallbackDirective() already marked their own generation calls analysis:true ("bot-to-
bot message, no player input"); this was the matching receive side that still took the full-
screening path, and Layer 2 blocked 8 of Mayor's real directives at 0.970 on 2026-10-13 as a
result. Layer 1 still runs and still blocks regardless of this flag -- hermes-router.py's
analysis mode only ever relaxes Layer 2's hard block (S27f), and the router's own doctrine
there is that it has no bearer auth and must never trust a caller's identity claim on its
own; the actual verification happens upstream, in handleIncoming(), against the real speaker,
never inside the router. maybeRemember()'s own <speaker> call site is deliberately untouched:
it is a fire-and-forget background memory write, not a player/bot-facing reply, and widening
scope there was not needed to close this gap.

2.118.0 (2026-10-18, direct request): bed claiming removed (actions.js 1.91.0) -- "home" for
nearestRallyPoint/storeSurplusNearHome/lightHomeOnce is now just bot.spawnPoint, dropping the
"a claimed bed is a more precise home" preference all three used to read via loadClaimedBed().
The BED_CHECK_MS interval and its checkClaimedBed() call are gone (nothing left to repair).
checkSleep()'s own self-propose-a-bed-goal trigger is unchanged -- it already only depended on
sleep's fail text and a bed count, neither of which claims ever touched.

2.117.0 (2026-10-16, direct report: "check the last 24 hours behavior logs for incorrect
behaviors," against the freshly reinitialized world). Two real, live-confirmed bugs:
- farmTaskFor() checked BED_WORDS before SHELTER_WORDS/COMMUNAL_SHELTER_WORDS. Harmless until
  nextSurvivalPriority()'s own Tier 1 "shelter" directive started literally saying "bed" too
  ("...shelter with a bed in it yet -- build one near home...") -- BED_WORDS matched first, so
  the whole goal (build a real room) got routed to bedStep (place a bed in the open) instead
  of shelterStep, leaving hasOwnShelterWithBed() permanently unsatisfied. Confirmed live: Bob/
  Dale/Nell had 313 combined "bed goal:" lines and 0 "shelter goal:" lines in 24h on a goal
  whose own directive says "shelter" first. Also fixed SHELTER_WORDS itself to match "shelter"
  before its verb, the same reverse-order gap COMMUNAL_SHELTER_WORDS already covered.
- MAX_CONSECUTIVE_FAILURES=3 was shared between the freeform planner (where 3 genuinely means
  "stuck, re-plan") and the dedicated runners (bedStep/shelterStep/weaponStep/toolStep/
  farmGoal/ranchGoal/communalShelterStep), built on the opposite philosophy of resuming
  forever rather than giving up. In the new world's harder terrain, three transient "No path
  to the goal" failures in a row now abandoned the WHOLE goal (losing triedWeaponChest/
  goal.shelterAt and every other accumulated flag) instead of just the one step. New
  isDedicatedRunnerGoal()/DEDICATED_RUNNER_MAX_CONSECUTIVE_FAILURES=20 gives those goals a much
  longer leash -- long enough for checkStuck's own 15-minute teleport-rescue to get a real shot
  at physically fixing a bad spot first.

2.116.0 (2026-10-13, direct report after the 2.115.0 deploy and a full fleet state reset:
"combat seems better, but building and tooling do not"). Three real, live-confirmed bugs, plus
the first extension of the dedicated-runner pattern past weapons:
- actions.js's "mine" chest short-circuit treated ANY chest match, even a PARTIAL one, as fully
  satisfying the request -- Babs looped 20+ minutes on "found 1 ... already in a chest, no need
  to mine it" (wanted more) into a craft that needed the full count and failed every time,
  never mining the shortfall. Now takes what the chest has and mines the rest.
- actions.js's "place_bed" had no memory of a server-REFUSED spot across goal ticks (only
  within one call, via `tried`) -- Mayor retried the identical "the block is still air" spot
  every single tick for 20+ minutes straight. New refusedBedSpots TTL cache, same shape as the
  existing chestMisses cache, excludes a proven-dead spot until it's worth trying again.
- weaponStep's own gatherPlanks() target undercounted: a wooden_sword needs 2 planks + 1 stick,
  and that stick itself costs 2 MORE planks (a full stick-batch) -- 4 total, not 2. The
  retry-and-resume shape already recovered either way, but this was one avoidable wasted cycle
  most of the time.
- New toolStep()/runToolGoal(), same shape as weaponStep (crafts a wooden_pickaxe from a chest
  or from scratch, never waits on a teammate), replacing the freeform planner for pickaxe/axe
  acquisition (TECH_TREE_STAGES' own "basic tools" stage) -- live evidence was Nell's "craft
  wooden_pickaxe" throwing a raw "Error: missing ingredient" and Mark/Wade producing long,
  rambling self-talk that never converged. Unlike weapon/shelter/food/armor, this directive is
  Mayor-assigned free text, not self-proposed, so it's dispatched by TOOL_WORDS (text match on
  "pickaxe" specifically -- never bare "axe", which would collide with weaponStep's own "no
  sword or axe" directive text) rather than a survivalPriorityItem tag.

2.115.0 (2026-10-12, root-caused a real, confirmed live regression: Luke/Mark's own
attack_win_rate collapsed from a 0.846 baseline to 0.167 over 24h). Weapon acquisition used to
rely entirely on the freeform planner -- the same unreliable multi-step chain already found
wanting everywhere else, confirmed live via Luke's own "ACTION CRAFT wooden_sword 1" getting
knocked off course ("stopped on the way to a crafting table") by a self-defense interrupt, a
vicious cycle for a weaponless Soldier specifically (decideFightType forces flee regardless of
role without a weapon, and fleeing just keeps interrupting the fix). New weaponStep()/
runWeaponGoal(), same dedicated-runner shape as bedStep/shelterStep, reusing gatherPlanks() for
the wood step; dispatched in goalTick() off currentGoal.survivalPriorityItem (a structured tag
proposeOwnGoal() already sets), not text-matched, since the directive's own wording is a fixed
string this file controls.

2.114.0 (2026-10-12, PRIORITIES_PROPOSAL.md Tier 2 item 1a -- the communal shelter, sized per
the operator's own rule: "large enough for beds to suit all active bots... at least N+1 for N
bots"; and the first concrete instance of the resource-gathering override). New
fleetHasReachedIronTools() (an ungated, in-memory, every-bot-visible tracker fed by real
gear/broadcast evidence, never a bare claim -- TECH_TREE_STAGES' own fleet-wide evidence
tracking is Mayor-only, which would've meant only Mayor's process could ever see this unlocked)
gates a new "communal_shelter" Tier 2 item, last in builderPriorityCandidates()'s own order.
New communalShelterStep()/runCommunalShelterGoal(): builds the structure (communalShelterSize()
scales the room to the target bed count), then populates it with beds one per tick, reusing
bedStep's own wool-to-bed acquisition rather than a third copy. New shared gatherPlanks(),
extracted from bedStep's own inline "craft from a held log, else mine a tree" fallback -- the
first real instance of "gathering a missing resource becomes her temporary priority," reused
by the communal shelter's own door. (The fully general version -- recognizing a missing
resource from arbitrary failure text across every action -- remains unbuilt; this unifies the
one concrete, already-duplicated case, not a new general parser.)

2.113.0 (2026-10-11, PRIORITIES_PROPOSAL.md §2a -- "with one, she patrols near home, unchanged
from today... with two or more, exactly one holds a claim to stay anchored near home at all
times; every other Soldier's priority becomes escort/rescue"). New isLiveSoldier()/
liveSoldierNames()/isGuardAnchor(): one live Soldier is trivially the anchor (actions.js's new
holdsGuardAnchor() claim never even touched); two or more contend for it, reusing the SAME
goal-heartbeat liveness signal goalHeartbeatTick's own peer-expiry already trusts
(otherBotGoalSeenAt/GOAL_LEASE_MS) for "still a live Soldier." nextSoldierPriority() is now
async; its non-anchor case returns a new "escort" priority -- a standing goal (guardTick,
generalized beyond just "guard") so it gets the same no-planner-churn treatment "guard" itself
was fixed to have, just without the GUARD_RADIUS homing walk. Deliberately NOT included:
recovering a teammate's dropped gear -- the existing RECOVERY logic only ever recovers the
SAME bot's own death position, and nothing broadcasts one bot's death location to the fleet;
flagged for confirmation, not assumed, per the proposal's own caveat.

2.112.0 (2026-10-11, PRIORITIES_PROPOSAL.md Tier 2 items 3-4 -- "elevates 'don't hoard' from
an incidental cleanup pass to an explicit, regularly-checked item," and the same for sharing
discovered locations). New checkSurplusSharing() (standing 5-min cadence, same gating as
checkDeferredSurplusCleanup's own post-craft version) calls storeSurplusNearHome() regardless
of whether a craft just happened -- surplus picked up any other way (looted, given, mined)
never got checked before this. New checkLocationSharing() (standing 10-min cadence, no
arbiter/busy gate needed -- noteNearbyResources() is a pure, no-movement scan) gives location
sharing a cadence of its own instead of only running as a side effect of something else
succeeding first.

2.111.0 (2026-10-11, PRIORITIES_PROPOSAL.md Tier 2 -- "ownable by whichever bot is idle and
able, not pinned to whoever's primary role happens to be Builder"). The infrastructure
checklist (nextBuilderPriority(), split into a pure builderPriorityCandidates() underneath it)
now runs for EVERY bot in proposeOwnGoal(), not just a Builder-primary one -- claimed via
actions.js's new claimBuilderItem() (1.86.0) so two idle bots don't converge on the same gap,
trying every unmet item in order (preferred pick first) before falling through to her own
role's work. retireGoal() releases the claim the moment the goal ends, success or not, rather
than waiting out the claim's own TTL. Also merges the checklist's old separate "beds" (a bare
count) and "shelter" (hasShelterNearHome, the single nearest match) items into one real
"shelter_capacity" check: confirmed live the two were fully independent, so nine beds
scattered in the open and one shelter nowhere near most of them could report both satisfied.
New countQualifyingSheltersNearHome() counts actual qualifying structures (complete, sealed, a
bed inside) near home, not just the nearest one, against the same BOT_USERNAMES.size baseline.

2.110.0 (2026-10-11, PRIORITIES_PROPOSAL.md Tier 1 -- "survival needs... don't stop applying
to a Miner or a Farmer just because her role happens not to enforce them"). New
nextSurvivalPriority(), checked first in proposeOwnGoal() for EVERY bot regardless of role:
weapon, her own shelter with a bed inside (new hasOwnShelterWithBed() -- confirmed live that
the fleet's separate bed-count and shelter-exists checks are fully independent, so neither
alone proves what this needs), not trending toward starvation (escalates to a real goal only
once the existing reactive checkHunger chore has already tried and backed off), then basic
armor. nextSoldierPriority() drops its own weapon/armor checks (now redundant -- Tier 1 already
intercepts first) down to just monster-hunting and guard duty. New survivalPriorityItemSatisfied()
re-verifies "shelter"/"food" against real state before accepting DONE, the same
hallucinated-DONE guard builderPriorityItemSatisfied() already gives Builder's own items.

2.109.0 (2026-10-11, direct report: a shelter's integrity (walls, ceiling, floor, doors) matters,
and "if a shelter gets damaged..., repairing it becomes a temporary top priority") --
hasShelterNearHome() tightened to match the new strict definition (actions.js 1.85.0): 100%
solid walls/roof/floor (not the old 80%), plus a real door. New findShelterNearHome() returns
the actual best-match base, not just a boolean, so a genuinely damaged (not just absent)
shelter -- hollow-interior-shaped, already at least half built, a real structure rather than a
coincidental open-air pocket -- has somewhere for repair to aim. New checkShelterIntegrity(),
same ROUTINE-tier self-healing pattern as checkTerrainDamage/checkAccessObstructions, re-runs
"build" at that base on a timer.

2.108.0 (2026-10-10, direct report: "they still aren't fighting back when even a single mob is
attacking them") -- decideFightType()'s own policy header already said an armed bot fights a
single melee or ranged threat unconditionally, but the code never implemented that for a
healthy non-Soldier: nearby === 1 fell through to the consecutive-flee counter, which starts
at "flee" and resets to zero between unrelated single-mob encounters more than
CONSECUTIVE_FLEE_RESET_MS apart, so a bot who only ever meets ONE mob at a time (not a
relentless repeat attacker) could flee forever and never reach the escalation. Confirmed live:
Bob fled a single zombie at 11.8/20 health -- not outnumbered, not critical, not a Soldier.
nearby <= 1 is a genuinely solo threat with no outnumbered judgment to make, so it now attacks
directly, same as the Soldier/low-health cases beside it.

2.107.0 (2026-10-09) -- two direct reports. (1) "if no-one is armed, and they are under attack
and for some reason cannot run, they should still try to fight even if it's hopeless":
attackAsLastResort() used to also bail on !hasWeapon(bot) -- the one case it exists for. An
unarmed bot who failed to flee just stood there and took every hit; she now swings bare-handed
instead, same as every other mob FLEE_ONLY_MOBS doesn't cover. decideFightType() still tries
fleeing first whenever that's actually possible, armed or not -- this only runs once that's
already failed. (2) bots "repeatedly complain about crafting tables" without ever noticing two
standing right next to them or remembering either's location: actions.js's own REUSABLE_
UTILITY_BLOCKS short-circuit finds an existing one nearby and skips making a duplicate, but
nothing ever wrote that real, just-confirmed position down. A successful "craft" step for any
CRAFTED_OBJECT_NAMES item now triggers the same noteNearbyResources() sweep mine/explore/scout
already use.

2.106.0 (2026-10-08) -- the living-space log line says "anchor(s)", not "bed(s)": bedAnchors()
always includes the spawn point, so the fresh world of 2026-10-08 reported "1 bed(s)" with no
bed placed anywhere. Label only; the baseline metric tracks the new wording.

2.105.0 (2026-10-07, direct request: access, shelters and tunnelling torches) -- a living
space's walls are recognised on a timer (shelter.js's roofed flood fill from every bed in
sight) and SwimMovements refuses to dig one, which is the position-based answer three rounds of
digCost tuning could not express. New checkAccessObstructions clears a block that impedes a
chest, bed or door; pathfinder's own scaffolding placements are excluded from creating one
(exclusionAreasPlace). New installTorchTrail hangs a torch every 6 blocks while digging, and
checkTorchSupply keeps TORCH_CARRY_MIN of them on hand.

2.104.0 (2026-09-27) -- a shelter counts only if its 2x2 room fits a bed (actions.js 1.79.0's
shape; a bed already in it still counts). A bot also makes itself a bed when beds exist but none
was free and home has fewer beds than bots -- spark2's four never started one.

2.103.0 (2026-09-26) -- bed goals get wood before crafting (3 planks, +4 when a crafting table
has to be made too): planks from held logs, else chop the nearest tree.

2.102.0 (2026-09-26) -- shelter goals run directly (site, materials, build; done only when
hasShelterNearHome() sees it), and that check now finds a shelter up to 2 blocks above or below
spawn height, not only at it.

2.101.0 (2026-09-26) -- bed goals ("craft a bed", the Builder's "set up more beds") run directly:
place a held bed, else craft one, else wool from a chest or sheep; done only when a bed stands
near home. A bot that finds no bed at night takes on "make myself a bed" for the morning.

2.100.0 (2026-09-25) -- installEnchantsFix at spawn (equipment.js 1.5.0).

2.99.0 (2026-09-25) -- first live hour: every bot failed on the same unreachable ripe crops; the
ripe-crop routine now backs off 15 min after a failed harvest.

2.98.0 (2026-09-25) -- farming and ranching, from a day of logs. A hungry bot with nothing to eat
fetches food from a chest (was 4,203 silent failed "eat"s). Farm and ranch goals run their actions
directly instead of through the planner (zero farm/ranch steps in a day; "DONE wheat" on the first
call; a "Mine and Craft" skill matched to farming) and finish only on a verified harvest or birth.
Ripe crops near home get harvested by whoever is free. The curriculum's farming stage needs a crop
the bot HARVESTED (a verified achievement), not one it holds, and achievements reach the Mayor as
they happen. The Builder's checklist ends with setting up a ranch.

2.97.0 (2026-09-25) -- doors: installDoorSupport (swim-movements.js 1.2.0) keeps doorway waypoints
on the floor and never shuts an already-open door while pathfinding.

2.96.0 (2026-09-25) -- every MC_BED_CHECK_MS (60s) the bot checks its claimed bed; a destroyed one
is replaced with the nearest unclaimed bed at once (actions.js checkClaimedBed), so home moves too.

2.95.0 (2026-09-25) -- fight-or-flee policy (decided from live data): an armed bot fights a single
melee or ranged threat, but flees when outnumbered at critical health (2+ within 8 blocks, any
role), when 3+ hostiles are near (non-Soldiers), or from a creeper within 5 blocks; the threat is
the mob that just hurt it (pickThreat) rather than merely the nearest. Stuck-rescue teleport uses
/spreadplayers -- "/tp" to the spawn block's corner suffocated bots in the shelter walls around
spawn (every post-teleport death in the server log). A clean stop (SIGTERM/SIGINT) is recorded, so
deploy restarts no longer count toward the cross-restart wedge streak that triggered it.

2.94.0 (2026-09-25) -- test support for the full-bot live harness (tests/live-bot.test.mjs):
MC_MEMORY_ROOT for the curriculum file, MC_HOME_POS pins a test bot's home, MC_TEST_USERNAMES
(default MBTester,MBProbe) are ignored as chat speakers, and the goal heartbeat is a named
function (goalHeartbeatTick) so it can be unit-tested.

2.93.0 (2026-09-24) -- review follow-up, closing the remaining gaps. MB-08: a Builder
item already in hand is placed via runBuilderPlacement (place_home + verify), no planner call.
MB-06: a bare "stop" from the player whose direct command is running stops it. MB-09: inventory-
full/insurance storing skips goalReservedItems() (the goal's items and their recipe inputs).
MB-13: a failed delivery retries once; successes send a "delivered" ack. MB-22: the stuck nudge
goes through the arbiter. Soldiers: weapon, monster, then missing armor (rate-limited), then guard.
Fairness: routineBlocked() counts lost turns, logged as ROUTINE_SKIPS every 10 min.

2.92.0 (2026-09-24) -- found by the new behavior baseline on its first post-deploy run: every
bot is an op, so the server echoes each RCON/console command to it as chat from "Rcon"; the
live-test run's RCON setup flooded all nine bots' classifier and message queues. handleIncoming
now ignores NON_PLAYER_SPEAKERS (Rcon, Server, the live-test bot).

2.91.0 (2026-09-24) -- efficiency pass from a measured day of fleet logs (2026-09-23, all 9 bots).
Soldier guard duty is a standing goal held without planner calls (was ~800 propose/DONE cycles a
day). Self-proposed goals name a TARGET item; one already in hand is rejected before it becomes
a goal, and a goal whose target turns up in inventory completes without a planner call (~83% of
planner calls produced no action). "done" broadcasts carry every held curriculum item so Mayor
gets full stage evidence at once. Home lighting runs on one maintainer (the Builder, or
MC_HOME_LIGHTING) with exponential backoff (6,195 attempts/day at 1.5% success). Surplus storing
pauses 20 min after finding only full/obstructed chests (404 failed trips vs 177 successful).

2.90.0 (2026-09-24) -- review remediation, tier 4. MB-12: goal heartbeat every 2 min, a
resumed goal is announced, and peers' goal entries expire after a missed lease. MB-13: item
requests use a claim window with one deterministic winner, never give away a last essential
item, and re-queue interrupted deliveries. MB-14: dusk pauses goals instead of abandoning them;
going home and sleeping retry (bounded) until they succeed; no new work at night unless a player
asked for it tonight. MB-15: critical hunger preempts goal steps and chores (HUNGER_CRITICAL).
MB-16: EXPLORE <feature> in both parsers and the planner vocabulary. MB-20: curriculum stages
need every requirement (tier-aware), per-bot evidence accumulates and persists, and stage work
goes to non-Soldier participants with role fairness. MB-21: goalTick plans without holding the
body and releases it right after acting; runAction releases before narration; skill-lookup
misses are cached for 10 minutes.

2.89.0 (2026-09-24) -- review remediation (docs/reviews/2026-09-24-minecraft-bots-review.md).
Every performAction() call passes its arbiter handle (MB-02); emergency/squad/drowning travel
only clears paths it still owns. MB-03: stuck-rescue teleport uses arbiter.cancelAndClear().
MB-04: interrupted steps are neither progress nor failures; recovery's retry works again.
MB-05: goalTick is pinned to the goal it started with (retireGoal/saveGoalIfCurrent). MB-06:
an addressed STOP bypasses the model and busy flag; other messages are queued, not dropped; a
newer player command preempts an older one. MB-08: GOHOME in the planner vocabulary. MB-09:
post-craft cleanup deferred until no goal is active, never storing tools/infrastructure.
MB-10: skill replay no longer completes a goal on its own; zero-step DONE NONE rejected;
truncated action records aren't authored into skills. MB-11: recipients accept the fallback
coordinator while Mayor is unreachable, measured from process start if he was never seen.
MB-22: standing still only counts as stuck while pathfinder is trying to move her; the
logged stationary time is computed before the clock resets.

2.88.0 (2026-09-21) -- direct follow-up: "combat is not fixed. they just stand there and get
killed." Live investigation found the real story: RCON kill sweeps around one unlit base pulled
in 1, then 7, then 13 more zombies (21 total) -- a genuine night-time mob swarm, not "a zombie."
No amount of per-bot single-target combat tuning (§53's own EMERGENCY timeout/entityCost fixes,
still correct, still kept) was ever going to survive hostiles spawning faster than 9 bots could
kill them; nearestHostile() only ever tracks the ONE nearest threat, so every bot was "handling"
one attacker while 2+ others hit her unopposed. Root-caused the actual upstream cause --
checkHomeLighting's own torch-crafting gate, which has already had two prior fix attempts
(2026-09-17, 2026-09-18) for two DIFFERENT ways it went silent: it checked for an ALREADY-MADE
stick specifically, when craftItem() (actions.js) already auto-chains stick <- planks <- log up
to 3 levels deep -- a bot carrying logs (routine wood-gathering makes this common) could craft a
torch from them without ever holding a loose stick, but this gate bailed out before ever trying.
Now checks for any real wood source (stick/planks/log/stem), not just a finished stick, letting
craft's own existing auto-chain do the rest. Immediate relief: RCON `time set day` plus killing
all 21 zombies while this was being investigated. See MINECRAFT_BOTS_DESIGN.md §54.

2.87.0 (2026-09-21) -- direct request: "re-evaluate the entire defense scheme," triggered by a
live mass-death incident (5 bots died within ~90 seconds, several repeatedly in quick
succession, while RCON confirmed only 1-2 zombies were actually involved). Two real, distinct
fixes from the same live evidence: (1) EMERGENCY's own unconditional "fight, no matter what"
rule at critical health had no escape hatch -- confirmed live (Wade) that a single stuck
emergency attack held HEALTH_CRITICAL-tier arbiter control for over 20 straight seconds with
nothing able to preempt it. New EMERGENCY_ATTACK_TIMEOUT_MS (8s, vs the standard 90s
ACTION_TIMEOUT_MS) plus fleeAsLastResort() -- attack is still the first choice at critical
health, unchanged, but now only gets a short bounded shot before falling back to flee instead of
riding out the full timeout blind. (2) Most of the fleet sleeps in one small shared area;
live logs showed constant `path_reset: stuck` for whichever bots were packed tightest --
mineflayer-pathfinder's own entityCost (default 1) barely discourages routing through a
crowded square, and real collision can make a "success"-planned square genuinely unreachable at
execution time. Raised entityCost to 8 (same "strongly prefer, don't forbid" tuning as
liquidCost/digCost) so routing around a crowd is preferred whenever an alternative exists. See
MINECRAFT_BOTS_DESIGN.md §52.

2.86.0 (2026-09-21) -- direct live report: "zombie is in the building again, attacking the
crowd of bots." Confirmed live that every bot's own "flee" attempt was failing with "No path to
the goal!" (fast, 2-4ms failures -- a genuinely unreachable GoalNear, not an exhausted search),
while "attack" separately kept timing out without landing a kill. Root cause:
nearestRallyPoint()'s own home/bed fallback assumed home is "always a safer place... even with
nobody there" -- false when the threat is already INSIDE home and most of the fleet is already
there too, turning "take one step toward any exit" into "path across the building to one
specific point" (often unreachable) or, even when reachable, walking her further INTO the same
building the threat is in. Now only returns home/bed when it's at least 20 blocks from her
current position -- real progress toward an actually-different, farther-away place; otherwise
returns null so flee falls through to its own plain maximize-distance goal, which needs no
specific destination and is far more resilient to exactly this "already home, threat inside"
shape. Immediate relief for the live incident: RCON-killed the zombie directly while this was
being investigated.

2.85.0 (2026-09-21) -- direct live report: "group of bots standing in the open, not moving or
running, being actively attacked -- automation failure." Traced back to 2.84.0's own
MAX_DIG_LABOR_COST cap: confirmed live via the dig_error diagnostic that Mayor/Nell/Bob were
all independently hammering `dig_error target: netherite_block` at the same home coordinates.
Measured real digTime: netherite_block/obsidian take 75000ms even with a netherite pickaxe +
efficiency 5 -- a real 75-second dig, but the labor-cost cap flattened it down to look as
"cheap" as a plank wall, so pathfinder kept choosing it, starting a real long dig, and getting
aborted almost immediately by some other periodic check (self-defense fires every 2s),
recomputing the identical route into the identical failure forever -- exactly what "frozen mid-
combat" looks like when the same shared movements object drives attack's own chase-to-target
movement. Fixed: excludes any block with real hardness >= 10 (a wide, clean gap -- every normal
terrain/building material tops out at hardness 5, obsidian/netherite_block/ancient_debris sit
at 30-50) from movements.blocksCantBreak, the same "can't be an incidental pathfinding
shortcut" protection already applied to doors/chests/furnaces, without touching "mine"'s own
ability to deliberately target one. See MINECRAFT_BOTS_DESIGN.md §51.

2.84.0 (2026-09-21) -- direct report: "now they are back to digging through the wall instead
of opening the door" -- the exact regression §44 originally fixed, reopened by §47's own
digCost 30->5 fix. Measured real block.digTime() values and found digCost alone can never
satisfy both live reports: digTime for the same block varies 100x+ by tool availability, so a
value strong enough to deter a well-tooled bot's near-instant dig (needs ~15) makes an
untooled bot's slow dig blow the search-cost budget again (needs <=5 to stay safe), and no
single number sits in both ranges. Raised digCost back to 15 (real deterrence for the common,
well-tooled case) now that SwimMovements caps the per-block labor-cost contribution directly
(MAX_DIG_LABOR_COST=20, swim-movements.js 1.1.0), decoupling "prefer doors" from "never make an
exit mathematically impossible" instead of fighting them with one shared knob. See
MINECRAFT_BOTS_DESIGN.md §50.

2.83.0 (2026-09-21) -- live diagnostic added right after shipping 2.82.0's burst detector:
confirmed live that the burst detector works (stops the infinite spin, forces a clean
noPath/walk-only failure) but Luke is still stuck in a repeating cycle (success path found ->
dig_error burst -> no walk-only route exists -> canDig restored -> same success path found
again). The plugin discards the real per-dig failure reason, so the crowding theory in 2.82.0's
own comment was still a guess. Logs the actual target block (type/position/distance) and any
other entity within 3 blocks of it on every dig_error, to get real evidence instead of another
guess before deciding the next fix.

2.82.0 (2026-09-21) -- direct live follow-up, same "can't get out of the home" report: §47's
digCost fix made a real path findable again (confirmed: Luke went from permanent noPath to
status=success cost=24.5), but executing it hit a NEW infinite tight loop -- mineflayer-
pathfinder's own move code swallows the real dig failure and just resets the path, which the
very next tick recomputes identically and fails identically again (live: same
success/cost=24.5 path_update dozens of times in ~1s, each followed immediately by
path_reset: dig_error). Same failure shape §42 already fixed for "flee" specifically
(disable canDig before that action's own goto), but no other action -- gohome included -- had
the same protection. Added a global burst detector: 4+ dig_error resets within 3s forces
canDig off for 15s so the next recompute is walk-only, on the theory a real building almost
always still has a door route once digging stops being an option. See
MINECRAFT_BOTS_DESIGN.md §48.

2.81.0 (2026-09-21) -- direct live report: "they can't get out of the home." A real, self-
inflicted regression from §44's own digCost=30, not a new gap -- confirmed live via
mineflayer-pathfinder's own astar.js: its maxCost ceiling (startNode.h + searchRadius, 48 here)
PRUNES any node whose cost exceeds it, not just deprioritizes it. For a nearby goal, the whole
search budget is only ~48-58 -- and a single dig at digCost 30 could cost 40-120+ on its own,
consuming that entire budget and turning a merely-expensive route into a hard noPath. Confirmed
live: 7 bots crammed into one small shelter, one alone logging 239 noPath results in 2 hours,
zero successful travel the whole window -- exactly "can't get out." Lowered digCost 30 -> 5:
still a real 5x discouragement over a plain walk step (the original §44 goal, unchanged), just
no longer capable of making a real exit mathematically impossible on its own. See
MINECRAFT_BOTS_DESIGN.md §47.

2.80.0 (2026-09-21) -- direct live follow-up: "they still wont fight back when pressured. Just
found a single zombie in a 'house' with most of the bots, and it was systematically attacking
them, with no reprisals from the bots." Confirmed live, not guessed: Mayor at 16-20 HP (well
above §43's own HALF_HEALTH threshold) got re-engaged by the SAME zombie every ~2s
(SELF_DEFENSE_CHECK_MS) in a cramped space, "successfully" fleeing every single time -- a few
blocks of separation isn't real safety when the zombie closes it again before the next check --
so she never took enough CUMULATIVE damage to cross the fight threshold, for minutes at a
stretch. Functionally "truly unable to flee," even though every individual flee call itself
reported ok=true, so §43's own attackAsLastResort() (which only fires on an outright flee
FAILURE) never got a chance to run either. New consecutive-flee counter in decideFightType()
escalates to fighting once repeated re-engagement piles up (3 in a row without a long-enough
real gap), regardless of health or role. See MINECRAFT_BOTS_DESIGN.md §46.

2.79.0 (2026-09-21) -- direct report: "they still destroy walls instead of using doors." A real
gap distinct from the existing door PROTECTION (doors/trapdoors/fence gates already can't be dug
through, blocksCantBreak) -- an ordinary wall block has no such protection, rightly so in
general, but that also means nothing discouraged digging one as a shortcut when it's cheaper
than detouring to the actual door. Confirmed against mineflayer-pathfinder's own cost formula
(movements.js: laborCost = (1 + 3*digTime/1000) * digCost, default digCost 1) -- for anything
quick to break that's often cheaper than walking around. New movements.digCost = 30, same
"strongly prefer, don't forbid" reasoning already proven for movements.liquidCost just above it
-- she'll still dig through a genuine dead end with no path around it, just never again as a
shortcut past a door that was right there. Verified this propagates everywhere pathfinding
happens (mine/explore, attack, flee, travel), not just direct goto calls: bot.collectBlock/
bot.pvp both already had their own internal movements references pointed at this SAME shared
object (an earlier fix for a related plugin-swap bug), so one change here covers all of them. See
MINECRAFT_BOTS_DESIGN.md §44.

2.78.0 (2026-09-21) -- direct follow-up to §42's flee dig-loop fix: "if truly unable to flee,
they should all fight. Soldiers fight *always*, others fight when under half health." Replaces
the flat SELF_DEFENSE_FLEE_HEALTH threshold (per-bot env-tuned only) with a role-based
decideFightType(): a Soldier never backs off for health reasons, anyone else fights once
genuinely hurt (< 10/20) rather than staying passive; FLEE_ONLY_MOBS/no-weapon still override
both. Also closes the one place this rule wasn't applied at all -- the EMERGENCY health-critical
handler used to hardcode an unconditional flee regardless of role, now uses the same decision.
New attackAsLastResort(): when a flee genuinely fails (couldn't create distance -- a fast, clean
failure now thanks to §42, not an infinite stuck loop), immediately try to fight instead of
silently giving up for that tick, for all three flee-triggering sites. See
MINECRAFT_BOTS_DESIGN.md §43.

2.77.0 (2026-09-19) -- direct report: "I don't think they really know how to use the crafting
table or furnace." Root-caused live, not guessed: Amy crafted a crafting_table at 01:45, then a
Builder-priority "go home and place a crafting table there" REJECTED DONE fired three separate
times over the next 25 minutes -- every time, the whole goal was thrown away (currentGoal =
null) rather than acting on the one fact already certain: she was STILL CARRYING the table the
entire time, she just never walked home and placed it. Abandoning wasted that real progress and
left the next re-issued directive to rediscover it from scratch, which kept immediately
re-hallucinating DONE instead of ever proposing "place" as a step -- a real trap, not a one-off.
Fixed: on this exact rejection, if she's still holding the item, walk home and place it herself
right now (reusing "gohome"/"place", both already robust) -- one deterministic shot before
giving up on the goal, no extra unreliable LLM round-trip needed for something this mechanical.
Also clarified planNextStep's own ACTION CRAFT/PLACE descriptions, which never mentioned CRAFT's
existing auto-chaining of simple intermediates (logs->planks->sticks/table) or that PLACE is the
action that actually satisfies a "set one up at home" directive -- confirmed live via repeated,
lengthy, sometimes-wrong multi-paragraph self-debate (Amy, Babs) about basic crafting mechanics
the model shouldn't have needed to re-derive every time. See MINECRAFT_BOTS_DESIGN.md §41.

2.76.0 (2026-09-19) -- direct request: "expand their search capabilities further, especially the
miner and explorer roles. make *sure* that discovered resources are being stored in world
memory." Real, confirmed gap found: a successful MINE never wrote a world-memory note at all --
only a FAILED one did (the existing "no X found" branch). noteNearbyResources/writeMemoryNote
call sites now cover mine's own success too, mirroring explore's existing note exactly, and both
mine and explore now also trigger a full noteNearbyResources() sweep on success (not just the
one target resource) -- a free "look around while you're here" at zero extra travel cost. New
VILLAGE_INDICATOR_NAMES (bell, composter -- real, low-false-positive villager job-site blocks)
gives Explorer's own stated "locate a village" priority (roles.js) a real mechanical search for
the first time; note-only, never a collect target. See MINECRAFT_BOTS_DESIGN.md §39.

2.75.0 (2026-09-18) -- direct live incident: watched a spider hit Mark with no reaction, which
turned out to be one tiny symptom of a much bigger nighttime mob crisis (7+ deaths fleet-wide in
under a minute, Dale down to 1.7 HP). Stabilized live via RCON (mob clear + a real torch ring
placed at bot.spawnPoint), then root-caused checkHomeLighting's THIRD straight failure (after
2026-09-10 and 2026-09-17 fixes, both confirmed dead ends): its "no torches -> try crafting"
gate only ever checked THIS bot's own personal inventory at the exact instant this 90s check
fires, and across a fleet whose self-defense fires every few seconds during any real incident,
no bot is ever reliably both free and stocked at the same moment. Now tries a chest first (reuses
"loot"'s own existing local-then-remembered-chest search, §19/§30) before ever falling back to
crafting from personal inventory. See MINECRAFT_BOTS_DESIGN.md §38.

2.74.0 (2026-09-18) -- direct request: "have the threatened bot run towards safety, run towards
golems, or soldiers." Direct follow-up to confirming SQUAD_ASSIST_RANGE (48 blocks) leaves a
fleeing bot beyond it with no real help at all (the live incident that prompted this: Nell,
critical, ~70 blocks from both Soldiers, got no response). "Flee" itself never had a
destination -- just maximized distance from the threat, which could run a bot deeper into
danger as easily as out of it. New nearestRallyPoint() (golem > nearby Soldier teammate via
bot.players > home, in that priority) wired into all three flee-triggering sites
(checkSelfDefense, the EMERGENCY health-critical handler, checkSleepingThreat) and passed as
action.rallyPoint; actions.js's own "flee" case (1.58.0) heads there directly when given one,
falling back to its original away-from-threat behavior otherwise. See MINECRAFT_BOTS_DESIGN.md
§37.

2.73.0 (2026-09-17) -- direct request "look in new logs for task hallucinations" -> "dig in."
Root-caused Amy's chronic multi-goal loop (§30/§31-adjacent, 17+ hours stuck on furnace, then
beds, then shelter) live: she was pinned at critically low health (as low as 1/20, confirmed
live) near "home" for extended stretches, constantly re-triggering flee/emergency interrupts
before she could ever finish a multi-step crafting chain. Traced to checkHomeLighting()'s own
"no torches -> return" early exit being COMPLETELY SILENT -- no log line at all -- so a
resource-starved bot could go the entire time with this check doing nothing and zero trace of
why in the logs, leaving her home area permanently dark and mob-spawn-prone. Torches need no
crafting table (confirmed against bot.recipesFor()'s own table-less lookup, same as
sticks/planks) -- checkHomeLighting now crafts some herself first if she's carrying fuel and a
stick, instead of only ever depending on already having some, and logs clearly when it
genuinely can't. See MINECRAFT_BOTS_DESIGN.md §32.

2.72.0 (2026-09-17) -- direct request: "when a bot opens a chest, they loot EVERYTHING instead
of what they need." ACTION LOOT's vocabulary (both classifyIntent's direct-command version and
planNextStep's own goal-planner version) and its parser now take optional <item_id> <count>,
matching MINE/CRAFT/SMELT's own shape -- naming an item withdraws up to that many and no more;
omitting it inspects the chest and remembers its contents without taking anything. See
actions.js's own 1.54.0 for the execution-side rewrite. Also extended the existing post-craft
cleanup trigger (runAction/goalTick) to fire after a targeted loot that actually withdrew
something too, same reasoning as craft/smelt already have. See MINECRAFT_BOTS_DESIGN.md §30.

2.71.0 (2026-09-16) -- direct report: "the bots do not appear to be active in world." Real,
severe, confirmed gap: RCON's own `list` showed 0 of the 9 bots actually connected (only the
human player) while every bot's systemd unit still reported "active" and kept logging goal
chatter, self-defense, even a false "slept through the night. (ok=true)" -- a real
keepAliveError disconnect (fired when the game server itself restarted) was only ever logged
by bot.on("end"), never acted on, so the process kept running every setInterval check against
a dead connection indefinitely, fabricating misleading success. Fixed: bot.on("end") now exits
the process, handing recovery to the same systemd Restart=always machinery already proven for
OOM crashes -- a fresh process gets a real, clean reconnect instead of a stale one pretending
to keep working. See MINECRAFT_BOTS_DESIGN.md §28.

2.70.0 (2026-09-15) -- direct request: "check the logs since the last review... look for
behavioral gaps." Found and fixed the real cause behind an apparent §23 regression: Mark
logged 909 doomed "gave up on the fight -- took too long" self-defense results in 34 hours
(~27/hour) because he had no weapon the ENTIRE window, and checkSelfDefense()'s own
attack-vs-flee decision never checked weapon possession before committing to "attack" -- a
bare-handed fight against nearly anything can't land enough hits inside ACTION_TIMEOUT_MS to
win, the exact same doomed-timeout shape FLEE_ONLY_MOBS already exists to prevent for flyers.
This held SELF_DEFENSE-tier arbiter control almost continuously, starving GOAL_STEP tier (the
tier nextSoldierPriority()'s own "go get a weapon" directive runs under) of any real
uninterrupted window to ever actually loot/craft/request one -- permanently weaponless, which
kept every future encounter exactly as doomed, forever. This also fully explains the chronic
"REJECTED DONE (claimed iron_sword...)" hallucination loop without the verification logic
itself being at fault: it was already correctly rejecting the false claim every time, dispatch
just never got a real chance to make actual progress between guesses. checkSelfDefense(),
checkSleepingThreat(), and respondToSquadCall() now all flee (or decline to engage) whenever
hasWeapon(bot) is false, alongside their existing flyer/low-health conditions. Separately
closed a real, confirmed-live violation of §23's Soldier restriction ("Secure Luke's flank --
craft a pickaxe" self-proposed by Mark): nextSoldierPriority() returned null once armed with
no hostile nearby, falling through to the SAME unrestricted freeform path every other role
uses -- Builder's own checklist legitimately graduates to freeform once her one-time
infrastructure list is built, but a Soldier's job was never supposed to have an equivalent
"done, move on" state. Now always returns a directive for a Soldier-primary bot, ending in a
"stand guard near home" fallback instead of ever reaching freeform. See
MINECRAFT_BOTS_DESIGN.md §27, including a separate, flagged-not-fixed sqlite concurrency bug
in shared Firmament memory infrastructure outside this fleet's own code.

2.69.0 (2026-09-14) -- direct report: "generally stationary on their wake-up spot... 'the
route can't be resolved'/'I can't reach you,' even when the only thing in the way was an open
door... or nothing at all." Root-caused with hard numbers, not guessed from the doors/
pathfinding angle the symptom description itself suggested: Mark alone logged 268
checkSelfDefense triggers in a single hour (240 of them phantoms) and 1,608
`path_reset: goal_updated` events over 15.5h -- a threat re-detected and force-cancelling
whatever was happening roughly every 13 seconds. FLEE_ONLY_MOBS's own "flee" response only
ever buys a few blocks of distance from a mob that's faster on the wing than a bot is on foot,
so it re-entered SELF_DEFENSE_RANGE well within the next 2000ms tick almost every time -- ANY
real travel (a goto/follow toward a player, walking to a chest or bed, terrain repair) kept
getting force-cancelled before it could ever finish, which looks exactly like "stationary" and
produces exactly the reported errors. New FLEE_MOB_RESPONSE_COOLDOWN_MS (20s) throttles
checkSelfDefense's own re-trigger specifically for FLEE_ONLY_MOBS, giving real travel an actual
window to complete -- a genuine melee threat (zombie/spider/creeper) is untouched, still gets
the full immediate response every time, and the separate health-critical emergency handler
still fires immediately regardless of this cooldown. Also fixed a real scaling gap feeding the
same phantom-swarm-from-sleep-deprivation feedback loop §17 broke once already: the Builder bed
target was still the original ">= 6" from when the fleet WAS 6 bots -- now ">= BOT_USERNAMES.
size" (9 today) in both nextBuilderPriority() and builderPriorityItemSatisfied(), kept in
lockstep so DONE-verification can't drift from the checklist's own target. See
MINECRAFT_BOTS_DESIGN.md §24, including a separate discovery (the real bot Minecraft server's
RCON was never actually reached by §20's mob_griefing fix) that's prepared but not completed --
blocked on a safety-classifier denial and a missing sudo grant this account doesn't have.

2.68.0 (2026-09-13) -- direct follow-up: "Reset their tech tree progress. The leader should
make sure to only assign tasks to idle bots, and to prioritize tasks in their role. Soldiers
should not get tasks beyond equipping weapons and armor, and fighting off monsters." Tech-tree
reset needed no file surgery -- mayor-curriculum.json never existed on disk (curriculum never
actually advanced past stage 0 this whole session, since every Mayor restart silently wiped
the in-memory stageProgress Set before all bots could ever land in it at once); this deploy's
own restart finishes the reset for real. "Idle bots only" audited (proposeDirectiveForOthers/
proposeFallbackDirective's own idleBots filters) and found already correct, nothing changed.
Real gap closed: the curriculum-stage branch never mentioned the target's role -- new shared
SOLDIER_DIRECTIVE_NOTE constant now restricts a Soldier target to gear+combat-only in BOTH
proposeDirectiveForOthers (Mayor) and proposeFallbackDirective (Mark's stand-in), matching
nextSoldierPriority()'s own §21 scope so assigned and self-proposed Soldier work never
contradict. checkCurriculumAdvance()'s fleet-wide completion gate now excludes Soldier-primary
bots -- they'll never be assigned a farming/enchanting task to clear those stages with, so
requiring it of them would have stalled the whole fleet's curriculum forever. Also fixed a
second stale claim caught while in this code: proposeFallbackDirective's prompt still told the
model Mark "carries Leader as a secondary role" -- true before §22's rebalance, false since.
See MINECRAFT_BOTS_DESIGN.md §23.

2.67.0 (2026-09-13) -- direct request: "rebalance the bots so they each have exactly one
role. If we need more bots so that every role has at least one bot, create them." roles.js
1.4.0 has the real BOT_ROLES change (every secondary set to null, three new personas added for
the three roles -- Artist, Explorer, Herder -- that previously existed only as somebody's
secondary). This file's own share: (1) BOT_USERNAMES default list extended with the three new
names (Nell, Wade, Dale) so a fresh deploy's Buzz/chat-relay exclusion list stays in sync with
roles.js rather than silently drifting, same reasoning as Bob's own addition. (2) A real
regression caught and fixed before it could ship: proposeFallbackDirective() (§15.5(d), Mark's
Mayor-fallback coordination) was gated on `myRole?.secondary === ROLES.LEADER` -- flattening
every secondary to null would have silently disabled this live, working feature with no error
anywhere. New FALLBACK_COORDINATOR env-var flag (mirrors SQUAD_RESPONDER's own shape) decouples
it from the one-role rebalance entirely. See MINECRAFT_BOTS_DESIGN.md §22 for the full
rationale and deployment checklist.

2.66.0 (2026-09-13) -- direct request: "the soldier personas need to: 1) be responsive to
calls for help 2) be aware when fellow bots are killed by a mob 3) prioritize a) getting a
weapon... b) killing monsters c) secondary roles. non-soldier bots need to: 1) call for help
properly." Investigated the existing alarm/combat code first (audit, not guesswork) and found
the call-for-help mechanism itself already existed and worked (broadcastThreatAlert/
respondToSquadCall) -- but four real gaps behind it:
(1) SQUAD_RESPONDER (who actually answers a call for help) was gated ONLY by an env var,
structurally independent of roles.js's own SOLDIER assignment -- a bot could be given the
Soldier role and still never respond unless someone also remembered to set
MC_SQUAD_RESPONDER=true on her unit file. Now derived from myRole.primary/secondary === SOLDIER
(env var kept as an explicit override), so "responsive to calls for help" is finally a real
property of the role, not a second, disconnected switch.
(2) "call for help properly" (non-soldiers): the health-critical emergency interrupt
(bot.on("health"), the truest near-death case) and checkSleepingThreat (a hostile creeping up
on a sleeping bot) never called broadcastThreatAlert at all -- only checkSelfDefense's own
calmer idle-tick check did. The two moments a bot most needs the fleet's help were silent. New
shared noteThreatSeen() funnels all three sites through one call-for-help path instead of three
drifting copies.
(3) Death awareness didn't exist in any form -- bot.on("death") only ever broadcast a "goal
abandoned" message with no signal she'd DIED or where. New broadcastDeathAlert (type: "death",
position, best-guess killer from noteThreatSeen's own lastKnownThreat if seen within
DEATH_THREAT_ATTRIBUTION_MS, else honestly "unknown") fires on every death; every bot logs it,
and a SQUAD_RESPONDER within SQUAD_ASSIST_RANGE goes to secure the spot (reuses
respondToSquadCall unchanged -- it only ever reads x/y/z).
(4) Soldier's own roles.js `priorities` (weapon, then combat) were pure advisory prompt text
per priorityListNote()'s own documented design -- "never a hard override... free to ignore."
New nextSoldierPriority() (mirrors nextBuilderPriority's §15.6 deterministic-checklist shape)
makes (a)/(b) real, world-checked overrides ahead of freeform self-propose for a Soldier-
primary bot: no weapon in inventory (equipment.js's new hasWeapon()) beats everything, then a
nearby non-flee-only hostile (SOLDIER_PATROL_RANGE=32, proactive -- not just reactive
self-defense) beats everything else; (c) "secondary roles" needed no new code, since returning
null on both just falls through to the existing freeform reasoning where roleBiasNote() already
leans toward myRole.secondary.

2.65.0 (2026-09-13) -- direct request: "extend resource sharing memory and scouting to *any*
resource or crafted object... They need to OPEN doors not destroy them as well" (actions.js's
own 1.52.0 has the door/chest-registry half). This file's own share: (1) noteNearbyResources()
now scans actions.js's new getResourceBlockNames() (every real ore/log this server has) plus a
new CRAFTED_OBJECT_NAMES set (crafting_table/furnace/chest/beehive/bee_nest), not the old
hand-picked 4-item list, via one findBlocks() matcher call rather than one call per name. (2) A
real, separate bug fixed in the SAME function: the "scout" broadcast RECEIVER used to name the
requester's actual resource only in its own log line -- `${msg.from_agent}'s scout request for
${payload.resource}` -- and then scan the same fixed list regardless of what was actually
asked. New extraTargets parameter, threaded through from both the "mine"-exhaustion call site
(now also passing the block she was actually looking for) and the scout-receiver call site (now
actually passing payload.resource) -- a scout request finally gets checked for the thing it
asked about. (3) A successfully PLACED crafted object (ACTION PLACE succeeding for anything in
CRAFTED_OBJECT_NAMES) now writes its own world-memory note immediately, in goalTick's own
per-step result handling -- she already knows the real position, no reason to wait for some
other bot's later opportunistic sweep to notice it.

2.64.0 (2026-09-13) -- direct request: "look at the last 24 hours of logs... they seem to
mostly hallucinate their achievements, can't use doors, and are just generally ineffective
even during the daytime." Root-caused from real 24h log data (268 goal-level abandonments vs.
only 88 completions), not guessed. Found THREE real, independent bugs, one of them severe:
(1) THE dominant cause of daytime ineffectiveness, ~78% of all goal-blocked reasons in the
sample (207 of 266): planNextStep's and proposeOwnGoal's own prompts both still contained a
STALE "has NO ability to build or place actual structures... respond BLOCKED immediately"
paragraph, left over from before actions.js's real "build" verb existed (2026-09-07/08) and
never removed once it shipped. This directly CONTRADICTED the very same prompts' own "ACTION
BUILD" vocabulary entry a few lines later -- the model was told in one breath "you can't do
this" and in the next "here's how to do this," and consistently obeyed the more emphatic
refusal. Every shelter-related goal (a large fraction of all goals, since shelter is Builder's
own priority item #5 and a common freeform pick too) was being self-sabotaged before ever
trying. Corrected both prompts to accurately describe the real, working (if limited-to-one-
fixed-shape) capability instead of falsely denying it exists.
(2) Explains "can't use doors": mineflayer-pathfinder's own canOpenDoors was already correctly
enabled (2026-09-07) -- but mineflayer-collectblock (used by "mine" and "explore," almost
certainly the two most common daytime actions) builds its OWN separate, unconfigured
`Movements` instance and calls `pathfinder.setMovements()` with it on EVERY collect() call,
silently undoing canOpenDoors/swim-awareness/blocksCantBreak for the whole operation -- the
exact same bug class already fixed for mineflayer-pvp's attack() on 2026-09-11, never applied
here. Fixed the same way: `bot.collectBlock.movements = movements` right after the existing
`bot.pvp.movements` fix, so every future collect() call re-applies the correct instance.
(3) Explains "hallucinate their achievements" with hard evidence: "craft a beehive ... and
place it near home" was announced "goal complete" TWICE in the same 24h window while
nextBuilderPriority's own real world-state check still found zero beehives near home every
single cycle before and after both claims. Root cause: the existing DONE item-verification
(2.43.0) only ever checks whether the named item exists in INVENTORY -- true the instant she
CRAFTS a beehive, whether or not she ever actually walked home and placed it. New
builderPriorityItemSatisfied() re-verifies a Builder-priority goal's own real world condition
(the same check nextBuilderPriority() itself trusts) before accepting DONE for any of the six
"craft/build AND place near home" items, closing the gap between "possesses the item" and
"the compound directive actually happened."

2.63.0 (2026-09-12) -- direct report "still not functional" (crafting table not found, a
chest with sticks ignored, soldiers not responding to attacks). Traced through 6+ hours of
live logs, not guessed, and found ONE real root cause behind most of it, not three unrelated
bugs: nextBuilderPriority() had no memory of past attempts, so Amy re-proposed the IDENTICAL
"go home and place a furnace there" directive every single self-propose cycle for 6+ hours
straight with zero progress. Real, severe consequence: beds (priority item #4) never even got
ATTEMPTED, so nobody could sleep, and phantoms -- a real vanilla mechanic triggered by extended
sleep deprivation -- swarmed the base (1473 threat-detections in 2 hours, more than every other
hostile combined), compounding on dark-base zombie/spider/skeleton spawns from lighting also
never landing (see checkHomeLighting's own fix below for why). New per-item stall counter
(BUILDER_ITEM_STALL_LIMIT) skips a genuinely stuck priority item after 3 consecutive cycles in
favor of the next unmet one, revisiting the skipped one later rather than looping forever.
checkHomeLighting() separately required a CLAIMED bed to have a "home" to light around -- but
claiming a bed requires a bed to exist, a real bootstrapping catch-22 confirmed live (zero
"home lighting" log lines in 6+ hours, every call hit that one early return). Now falls back to
bot.spawnPoint, the same anchor nextBuilderPriority/checkTerrainDamage already use for exactly
this reason, instead of giving up outright. Squad response and self-defense were independently
verified WORKING (real successful assists in the logs) but overwhelmed by the same phantom
swarm -- not a separate bug, expected to ease once beds/lighting actually land. The chest-check
bug (actions.js, see its own changelog) is the one genuinely independent fix in this batch.

2.62.0 (2026-09-11) -- direct request "so both" (both ideas from a Project Sid research pass,
following up on the coherence-arbiter work that same paper's PIANO architecture already
inspired). (1) Chat/action coherence: generateReply() (the plain-CHAT reply path, distinct from
classifyIntent's own ACTION/GOAL branches which already ground chat in a real queued action)
had no equivalent grounding -- a borderline request classifyIntent scored as CHAT could still
get an in-character "sure, I'll get right on that!" with nothing actually queued. New
currentActivityNote() folds the bot's REAL, live goal state (or its real absence) into every
CHAT reply's own prompt, plus an explicit CHAT_INSTRUCTION rule against promising future action
that isn't already covered by what she's doing -- the same "ground every claim in real state,
never a remembered belief that could drift" discipline every other prompt in this file already
follows, just not yet applied to this one reply path. (2) Adaptive role-leaning: Sid's own key
specialization finding was that role differentiation required agents to track OTHER agents'
goals/intentions -- without it, roles stayed homogeneous. New otherBotActivityAt (timestamped
for free alongside otherBotGoals in the existing "minecraft-coordination" Buzz handler, no new
message/poll) and lastRoleActivityAt() feed roleBiasNote(): if nobody holding a bot's own
secondary role as their primary has done observable work in ROLE_NEGLECTED_MS (20 min), that's
now called out as extra reason to lean into the secondary -- an adaptive nudge layered on top
of §15.5(a)'s existing fixed lean, not a replacement for operator-assigned roles.

2.61.0 (2026-09-11) -- direct request "fix the shelter check, the pen herding, and the dynamic
skill library". (1) Real bug fixed in hasShelterNearHome(): it checked ONLY
bot.spawnPoint.floored() itself, but "gohome" (actions.js) walks there via GoalNear(..., 3) --
a 3-block-radius goal, not the exact block -- so a shelter built right after nextBuilderPriority
(§15.6)'s own "go home and build a small shelter there" directive could legitimately sit up to
3 blocks off spawnPoint and never be recognized as built, looping the same directive forever.
Now slides the candidate anchor across a small search radius and also checks for a genuinely
hollow interior (not just wall/roof solidity), so a coincidentally-shaped hill or outcrop can't
false-positive as "shelter exists" either. (2) Wired actions.js's new "herd_to_pen" case (1.50.0)
into both vocabularies, same two-place pattern every verb here gets -- closes the design doc's
own "build_pen doesn't herd" gap. (3) Investigated §14's dynamic skill library after the
design doc turned out to be badly stale (claiming "a plan only, nothing built" when skills.js,
its two RAG scripts, and goalTick's own skill-retrieval call were all already real, dated
2026-09-08 -- built before this session, just never reflected in the doc). The one real
integration bug found: every verb added THIS session was missing from SKILL_ACTION_VERBS
(actions.js 1.50.0), fixed there, not here.

2.60.0 (2026-09-11) -- direct follow-up ("what's next" -> "2"), second half: closes §15.8's
"do the other roles get their own priorities lists" open question for Miner/Artist/Explorer/
Soldier (roles.js 1.2.0's new advisory `priorities` arrays) -- new priorityListNote(), folded
into roleBiasNote()'s existing text for both a bot's primary AND secondary role. Deliberately
NOT the same shape as Builder's own nextBuilderPriority() ladder just above: these four were
never operator-specified with concrete checkable items the way Builder's was, so this stays
plain advisory text in the freeform prompt rather than a deterministic, world-checked override
-- see roles.js's own 1.2.0 header for the full reasoning.

2.59.0 (2026-09-11) -- direct follow-up ("what's next" -> "2"): wired actions.js's new "shear",
"milk", and "build_pen" cases (1.49.0) into both classifyIntent and planNextStep/parseGoalStep,
same two-place, no-parameters pattern as every other simple verb here (BUILD, EXPLORE, etc.).
Closes MINECRAFT_BOTS_DESIGN.md §15.11's pen/fence and shear/milk `[UNKNOWN]`s.

2.58.0 (2026-09-11) -- direct follow-up ("nest" again -> "all 3" of: craft/place a beehive
[already fully supported by the existing generic "craft"/"place" cases, confirmed, zero code
change needed here], honeycomb via shears too, wire honey/wax into a priority list). (1)
ACTION HARVEST_HIVE's vocabulary/parser (both classifyIntent and planNextStep/parseGoalStep)
now carry a <tool> param ("bottle"/"shears") matching actions.js's own new choice (1.48.0). (2)
nextBuilderPriority() (§15.6) gained a 6th, later item: a beehive, checked the same
countNearHome() way as crafting_table/furnace/chest, but placed AFTER the operator's original
five rather than among them -- a nice-to-have, not core survival infra, so it never reorders
what was actually specified.

2.57.0 (2026-09-11) -- direct follow-up ("nest" -> "bee nests/hives"): wired actions.js's new
"harvest_hive" case (1.47.0) into both classifyIntent (player-facing "ACTION HARVEST_HIVE") and
planNextStep/parseGoalStep (the goal-step planner's own vocabulary), same two-place wiring
every other action verb here already gets. "ACTION BREED <species>" vocabulary text updated to
mention bee alongside cow/sheep/pig/chicken now that actions.js's BREEDING_FOOD map covers it.

2.56.0 (2026-09-11) -- direct follow-up ("go"): the two pieces of §15 scoped out of 2.55.0's
build. (1) §15.10's terrain-repair duty: new checkTerrainDamage(), same idle-tick shape as
checkHomeLighting() (ROUTINE-tier arbiter control, try/finally release, its own interval) --
findTerrainDamage() sparsely samples column surface heights within TERRAIN_REPAIR_RADIUS of
bot.spawnPoint (never anywhere else -- the design doc's own [RISK] note on false positives),
flags a column as damage only within a bounded depth band (TERRAIN_REPAIR_MIN_DEPTH..
TERRAIN_REPAIR_MAX_DEPTH -- shallow dips aren't worth a trip, and anything deeper looks
deliberately dug, e.g. a mineshaft, not incidental damage). terrainRepairMaterial() implements
the "guided by function" override: if plantable ground (grass_block/dirt, the exact set
actions.js's own plant_sapling groundIds already recognizes) borders the pit, forces "dirt"
regardless of what the majority neighbor material is; otherwise leaves it null so actions.js's
new "repair_terrain" case (1.46.0) samples the neighborhood itself. Gated to a bot whose
primary OR secondary role is Builder or Artist (today: Amy on both). (2) Bob's repo-side infra:
infra/minecraft-bots/minecraft-bot-bob.service (mirrors the other five units exactly) and Bob
added to MC_BOT_USERNAMES' own default list -- NOT a live deployment (no systemd enable/start
here, no Matrix account/token, no Buzz KNOWN_AGENTS entry -- those need the actual spark/
muncraft hosts and real secrets, out of reach from this session).

2.55.0 (2026-09-11) -- direct request: "start building" MINECRAFT_BOTS_DESIGN.md §15's role
system (roles.js + wiring into index.js, scoped down from the full §15 by direct operator
choice -- the terrain-repair verb and Bob's live deployment are separate follow-ups, not
touched here). New services/minecraft-bots/roles.js (ROLES/BOT_ROLES, §15.4) imported as
`myRole`. Three wiring points, each additive to an existing function rather than a new
pipeline:
(1) proposeOwnGoal() now folds a role-bias note (primary/secondary domain, a lean not a hard
    filter) into its freeform prompt (§15.5(a)) -- and, for a Builder-primary bot specifically,
    checks a new nextBuilderPriority() ladder FIRST, deterministically (no LLM call for the
    decision itself, only to phrase the announcement in voice via the existing narrateAction()
    helper) -- crafting table -> furnace -> chest -> 6+ beds -> shelter (§15.6), the operator's
    own specified order. Checked via real bot.findBlocks()/blockAt() world-state queries near
    bot.spawnPoint (the same "home" anchor gohome/teleportToSpawn already use) -- same "check
    reality, don't trust a self-report" discipline TECH_TREE_STAGES' own mayorHasStageItem()
    already established, not a new pattern. hasShelterNearHome() mirrors (does not import --
    a deliberate small duplication of pure position math, not worth a cross-module refactor for
    one caller) actions.js's own "build" case geometry (3x3 footprint, 3 walls, a doorway, a
    roof), anchored at bot.spawnPoint since the deterministic directive always sends her home
    first via ACTION GOHOME before ACTION BUILD.
(2) proposeDirectiveForOthers() (Mayor's own, unchanged in every other respect): idle-target
    selection's previous purely-random fallback is now pickIdleTarget(), a light role-aware
    tiebreak (whichever idle bot's role was least recently assigned something, via a small
    in-memory lastRoleAssignedAt map -- no new persistence, lost on restart same as
    recentGoalOutcomes already is). The post-curriculum directive-content branch now folds the
    target's own BOT_ROLES entry into the muse prompt ("assign something in their wheelhouse")
    instead of fully freeform improvising with no notion of who the target actually is.
(3) New proposeFallbackDirective() + its own setInterval, DELIBERATELY a separate function from
    proposeDirectiveForOthers() rather than a branch threaded through it -- Mayor's own path is
    well-exercised and this keeps zero risk of changing his behavior. Fires only for a bot whose
    BOT_ROLES secondary is LEADER (today: Mark) and only once Mayor's gone quiet for
    MAYOR_LIVENESS_TIMEOUT_MS (3x MAYOR_DIRECTIVE_MS) -- liveness tracked via a new
    lastMayorSeenAt timestamp, updated in handleIncoming() the same real place Mayor's own chat
    already has to pass through to reach another bot's decision loop (isMayor()'s own existing
    exception to isAnotherBot(), 2.36.0), so no new heartbeat/infra was needed. Deliberately
    does NOT touch curriculumStageIndex/stageProgress at all (Mayor-only, avoids any write race
    on mayor-curriculum.json) -- a fallback directive is always freeform-style, never
    curriculum-stage-aware, a smaller and safer scope than §15.5(d)'s original full proposal.
    Checked fresh every tick (not latched): the instant real Mayor traffic is seen again,
    lastMayorSeenAt updates and this function goes back to a no-op on its very next run, no
    hand-back step to get wrong.

2.54.0 (2026-09-11) -- direct request: shared resource-location memory across the fleet (see
actions.js's own 1.45.0 header for the full quote and the other half of this feature). New
noteNearbyResources() scans actions.js's EXPLORE_TARGET_NAMES locally (no movement, safe to
run fire-and-forget without the arbiter) and writes a world-memory note per resource found,
in the same "near (x, y, z)" format explore's own success note already used -- called (1)
directly, right before publishing, whenever a "mine" step exhausts its own local search (the
"look near itself" half), and (2) by every other bot on a new "scout" minecraft-coordination
Buzz payload (the "ask the other bots to look near themselves" half). No direct reply channel
needed -- every bot writes to the one shared world-memory corpus, so the asker's own next
"mine" attempt (actions.js's new findRememberedLocation()) picks up whatever anyone wrote,
exactly as if she'd found it herself. Deliberately non-blocking, matching the existing item
"request" step's own precedent: publish, let this tick's failure stand, and rely on a LATER
goal tick to benefit from whatever the fleet reports back in the meantime.

2.53.0 (2026-09-11) -- direct live report: "what's wrong with the bots now," found via a fresh
live log review. Repeated "self-defense result: gave up on the fight -- took too long" against
drowned specifically (never zombies/skeletons/creepers) traced to mineflayer-pvp's own
attack() silently overwriting the bot's swim-aware SwimMovements with its own generic default
Movements on every call (confirmed against its source, lib/PVP.js). bot.pvp.movements now
points at the same SwimMovements instance the rest of the bot already uses, so attack() can
actually path down to a target underwater instead of being stuck using land-only movement the
whole fight.

2.52.0 (2026-09-10) -- direct live report: "they don't seem to be able to fight, or run from,
phantoms." checkSelfDefense, checkSleepingThreat, and respondToSquadCall now check
actions.js's new FLEE_ONLY_MOBS before deciding attack vs. flee -- see that file's own 1.44.0
header for the confirmed live root cause (a melee "attack" against a flying phantom can never
land, holding SELF_DEFENSE-tier arbiter control for the full 90s ACTION_TIMEOUT_MS every time,
blocking everything else self-defense-tier-and-below for that whole span).

2.51.0 (2026-09-10) -- Phase 3/4 of the approved coherence arbiter plan (see arbiter.js's own
1.2.0 header). Migrated every remaining physical-action call site off the old `acting` flag:
runAction (OWNERS.DIRECT_COMMAND), goalTick's physical-action span (OWNERS.GOAL_STEP),
teleportToSpawn (cancel-only via arbiter.cancelAndRotate() -- never acquires/holds, matching
TELEPORT_HOME's own "sits above everything" design), the post-death recovery block
(OWNERS.RECOVERY, now re-requesting control fresh on each retry), and all ~10 remaining
ROUTINE-tier idle-tick checks (checkSleep, checkDusk, checkHunger, checkPendingGiveRequests,
storeSurplusValuables/storeSurplusNearHome, checkSaplings, checkLighting, checkHomeLighting,
plus checkCurriculumAdvance/proposeDirectiveForOthers' own early-bail guard -- checkStuck's own
jump-nudge stays deliberately ungated, unchanged, exactly as documented). recover()'s retry
loop now checks the real `handle.token.preempted` flag instead of text-matching result.text for
"The goal was changed" -- see arbiter.js's own requestControl() docstring for the real
thundering-herd bug this phase also found and fixed (equal-priority ROUTINE callers used to
instantly steal control from each other instead of waiting, once more than one of them existed
for the first time). The old `acting` module-level flag is deleted; `busy` stays -- it guards a
genuinely separate concern (LLM-call reentrancy), never part of the arbiter's own scope.

2.50.0 (2026-09-10) -- Phase 2 of the approved per-bot coherence arbiter plan (see arbiter.js's
own header for the full account). Migrated the 4 duplicated force-cancel-then-wait-then-acquire
reflex handlers -- checkSelfDefense, respondToSquadCall, the bot.on("health") emergency
handler, the bot.on("breath") drowning handler -- plus checkSleepingThreat's own near-variant,
to arbiter.requestControl()/handle.release() instead of each hand-rolling its own copy of the
4-primitive cancel + busy||acting poll loop. Closes a real, live inconsistency as a direct
consequence: the health-emergency handler was missing bot.stopDigging() entirely --
arbiter.requestControl() always includes it. Per-owner priority (HEALTH_CRITICAL > DROWNING >
SELF_DEFENSE > SQUAD_RESPONSE) now decides who wins when two of these fire close together,
replacing whatever the timing of five independent busy/acting polls happened to produce.

2.49.0 (2026-09-10) -- direct request: "fix the lighting logic," following a confirmed live
incident (1260+ deaths in ~26h -- see actions.js 1.39.0's own header for the full root-cause
account). New checkHomeLighting(): a real proactive area sweep around her own claimed bed
(loadClaimedBed(), 90s interval -- a real sweep, not a per-tile reflex, so a longer interval
than checkLighting's own 20s), running actions.js's new "light_area". checkLighting() itself
is unchanged, still the fast per-tile reflex for wherever she happens to be standing.
DARK_LIGHT_LEVEL moved to actions.js (now imported, not a second local copy).

2.48.0 (2026-09-09) -- direct request: "monitor their behavior, look for issues." Found and
closed a real loophole in the DONE item-verification fix (2.43.0): nothing stopped the model
from just answering DONE NONE on a goal that plainly WAS about a specific item, dodging
verification entirely -- caught live, "mine some iron" was marked DONE NONE and announced
complete with zero successful steps ever logged (SUSPICIOUS DONE fired on the very same line,
but that flag was cosmetic-only until now). A NONE claim backed by zero evidence of any real
progress is now rejected exactly like a false item claim, via the same safe "treat as a real
give-up" path -- NONE is still accepted when real progress WAS logged (a genuinely open-ended
goal that isn't reducible to one item, but did succeed at something).
Also: storeSurplusNearHome() no longer aborts its whole batch over one item-specific failure
(a real one observed live -- pathfinder's own scaffolding mechanic had consumed an item
mid-travel between being picked as surplus and the deposit actually running) -- now tries
every item in the batch regardless, still bounded by STORE_NEAR_HOME_BATCH_LIMIT.

2.47.0 (2026-09-09) -- direct request: "after any crafting activity, surplus materials should
be stored in a chest as close to their sleeping home as possible." New storeSurplusNearHome():
batches every distinct non-essential surplus item (bounded, STORE_NEAR_HOME_BATCH_LIMIT=5) into
actions.js's new "store" with action.near set to her own claimed bed position (loadClaimedBed(),
exported from actions.js -- the same real position "sleep" itself already tries first every
night). Triggered from both runAction (direct player command) and goalTick (self-directed goal
step) right after a successful "craft" or "smelt", via a craftedOk flag checked in each
function's own outer `finally` (after `acting` is released, avoiding a race with
storeSurplusNearHome's own acting=true). Deliberately separate from the existing
storeSurplusValuables (checkInventoryFull/Insurance) -- that one is a space/risk reflex aimed
at "nearest to wherever I am," this one is a post-activity cleanup reflex aimed at home
specifically. A skill-served craft/smelt (runSkill's own replay path) doesn't trigger this yet
-- a known, minor gap, not fixed here.

2.46.0 (2026-09-09) -- direct request: "when they find saplings, they should plant them (1)
near other trees of the same variety if they can (2) in any free soil not directly adjacent
to a building if they can't." New checkSaplings() idle-tick reflex (same busy/acting pattern
as checkInventoryFull/checkInventoryInsurance): whenever she's carrying any sapling (an
incidental drop from mining/chopping trees, never something actively sought), runs actions.js's
new "plant_sapling" (1.33.0), which owns the actual WHERE logic. storeSurplusValuables() now
excludes saplings from its own "store whatever's largest" surplus pass -- otherwise a bot with
a near-full inventory would chest away her sapling stack before ever getting a chance to plant
it, since isEssentialItem()'s gear/fuel/food definition has no reason to protect them.

2.45.0 (2026-09-08) -- direct request: "give the mayor a default set of goals to try to
accomplish, starting with basic tools for everyone, then basic armor, then farming. he should
set increasingly useful larger goals as they successfully meet earlier goals. progress
through the tech tree." New TECH_TREE_STAGES, a fixed, ordered curriculum (basic tools ->
basic armor -> farming -> iron gear -> diamond gear -> enchanting) replacing
proposeDirectiveForOthers' previous fully-freeform "invent whatever task" directive -- muse
still phrases each directive in Mayor's own voice, but the real objective for the current
stage always comes from this list, never invented. Progress is tracked with real, verified
signals, not self-reported claims: Mayor checks his OWN inventory/equipped gear directly for
item-based stages, and reads every other bot's REAL, checked DONE <item_id> broadcast
(parseGoalStep's own verification, 2.43.0 -- broadcastGoalState now carries that item)
arriving over the existing minecraft-coordination Buzz topic. Once every bot has cleared the
current stage, the whole fleet advances together and Mayor announces it in chat; the stage
index is persisted (mayor-curriculum.json, same durable-mount pattern actions.js's bed-
ownership fix already uses) so a Mayor restart doesn't reset the fleet back to square one.
Falls back to the original freeform directive behavior once the fixed ladder is fully cleared.

2.44.0 (2026-09-08) -- direct request: "watch their behavior for a while, look for
misbehaviors." A 25-minute live capture across all five bots (via the new activity.log
service) surfaced a real, twice-confirmed bug: BOTH actual deaths in the window (Mark, Luke,
each a creeper-plus-drowning combo) lost gear recovery entirely to the same failure --
checkSelfDefense/the oxygen- and health-emergency handlers call bot.pathfinder.setGoal(null)
DIRECTLY the instant a new threat appears, ahead of their own later performAction() call (the
one that actually runs stopCurrent() and updates the cancel token), so recover()'s in-flight
goto can reject before the token catches up -- it can't tell "legitimately interrupted" from
"genuinely failed," and being a strict single shot with no retry, the loot was just gone.
recover() now retries (bounded, MAX_RECOVERY_RETRIES=2) specifically on that one
distinguishable failure text, pausing for whatever interrupted it to actually resolve.
Also added a diagnostic log for parseGoalStep's "couldn't decide what to do next" fallback
(fired 4 times in the same capture, across 4 different bots, with zero visibility into the
raw reply that failed to parse) -- purely for future diagnosis, no behavior change.

2.43.0 (2026-09-08) -- direct live report ("Mark and Luke claim they have bows"), confirmed
real: Mark's "Secure a bow" goal was marked DONE and announced complete in chat after every
real attempt to gather wood/string for one had failed -- the existing SUSPICIOUS DONE check
(2.14.1) only verifies SOME step in the goal ever succeeded, which was true here purely
because an unrelated step (a loot pass that found something else) had succeeded, not because
a bow existed. parseGoalStep's DONE now requires an item_id (or NONE) naming what proves
completion, verified here against real inventory/equipped gear before the goal is ever
announced complete -- a false claim is now rejected outright (treated as a real give-up, not
silently flagged) rather than told to anyone, the bot herself included.

2.42.0 (2026-09-08) -- companion fix to actions.js 1.32.0: confirmed against mineflayer-
pathfinder's own movements.js source that its default blocksCantBreak only ever protects
chests and non-diggable blocks (bedrock etc.) -- a furnace, bed, or bookshelf standing between
a bot and her goal is "diggable" by that library's own definition and gets auto-dug through
exactly like stone would, independent of whatever action she was actually trying to run. Every
real functional/crafted block (isProtectedBlockName(), actions.js -- the same shared list
"mine" now refuses to deliberately target) is added to movements.blocksCantBreak at setup, so
this holds regardless of why the pathfinder wanted to dig.

2.41.0 (2026-09-08) -- direct live report ("check the bots other than mayor, they are
stuck?"), confirmed real: Babs/Amy/Mark/Luke all sat completely idle for 3+ minutes after
their last goal ended, no self-proposed replacement, no errors logged at all -- eerily quiet
rather than obviously broken. Root cause: handleIncoming's lastActivityAt reset (used only to
gate IDLE_BEFORE_SELF_GOAL_MS, the "propose a new goal after 10 quiet minutes" timer) fired
for ANY message that reached this function, including Mayor's own isMayor() exception traffic
(2.36.0) -- and Mayor talks periodically on his own (every MAYOR_DIRECTIVE_MS, plus his own
self-proposed-goal chat), which kept perpetually restarting every other bot's 10-minute
countdown. Mayor's mere presence meant that clock could never actually elapse for anyone else,
unless Mayor happened to hand that SPECIFIC bot a directive or a real player intervened.
lastActivityAt now only resets for an actual real player (`!isAnotherBot(speaker)`) -- Mayor's
chat still reaches classifyIntent -> ACTION GOAL exactly as before, it just no longer also
gates everyone else's unrelated self-propose clock.

2.40.0 (2026-09-08) -- item #6 of "fix all the above" (squad response for Mark/Luke). Self-
defense was purely individual despite Mark/Luke's own "military... defending the spawn point"
framing (2026-09-07) implying a squad that backs each other up. New broadcastThreatAlert() over
the existing "minecraft-coordination" Buzz topic (same JSON-payload channel otherBotGoals
already reads) -- checkSelfDefense() calls it (cooldown-debounced) whenever a real threat is
found. New SQUAD_RESPONDER (env-gated per-bot, same pattern as
MC_SELF_DEFENSE_FLEE_HEALTH/RANGE, set true for Mark/Luke only -- Babs/Amy abandoning a
gathering run for a fight three biomes away would be a net loss, not backup) + respondToSquadCall():
on hearing an alert within SQUAD_ASSIST_RANGE, force-cancels current action (same shape as
checkSelfDefense's own interrupt), travels to the real coordinates, and fights whatever hostile
is still there.

2.39.0 (2026-09-08) -- item #5 of "fix all the above" (inventory insurance). New
checkInventoryInsurance(): checkInventoryFull()'s own store pass, refactored into a shared
storeSurplusValuables() and now ALSO triggered by taking real damage (health <=
INSURANCE_HEALTH_THRESHOLD, well above the emergency-flee threshold), not just by running out
of inventory space. A bot could carry a stack of diamonds or a spare armor set indefinitely
with room to spare and never bank any of it -- a death that was otherwise survivable-in-
hindsight still wiped out real progress a nearby chest could have prevented. Cooldown-gated so
one low-health episode doesn't retry every idle tick.

2.38.0 (2026-09-08) -- item #3 of "fix all the above" (farming from scratch, actions.js
1.30.0's own new till-and-plant fallback in "harvest"). Both ACTION HARVEST descriptions
(classifyIntent's direct-command parser and the goal-step planner) now mention that harvest
also starts a new farm when nothing is ripe yet, so the planner knows one verb covers both
cases instead of never reaching for it to bootstrap a farm.

2.37.0 (2026-09-08) -- companion fix to actions.js 1.28.0: checkSelfDefense(), the emergency-
health handler, and checkSleepingThreat all already hold the real entity they detected via
nearestHostile(bot, SELF_DEFENSE_RANGE) -- now passed through as action.target on the
performAction() call instead of being discarded, so "attack"/"flee" don't re-derive it (and
race it moving/despawning) a second time. Found live verifying Mayor's first directive: Mark
was stuck thrashing on this exact bug (spamming detect-then-fail every 2s) instead of ever
getting back to an idle tick that could have heard and acted on the directive.

2.36.0 (2026-09-08) -- direct request: "add another bot, Mayor, whose personality is to be a
leader and set goals for the others. The others can defer to him when his instructions are
not in conflict. The Mayor perceives me as 'The President' and therefore his superior." New
isMayor() exception to isAnotherBot() -- Mayor's chat is the one bot-to-bot message that
actually needs to reach another bot's real decision loop (classifyIntent -> ACTION GOAL), the
same path a player's own instruction already takes, rather than staying coordinate-over-Buzz-
only like every other bot's chat. handleIncoming's own ACTION GOAL branch now defers to an
already-active REAL PLAYER goal over a new Mayor directive (never the reverse) -- the
hierarchy his own persona describes. New proposeDirectiveForOthers(): a Mayor-only (no-op for
every other bot) periodic behavior that picks whichever teammate has no active goal
(otherBotGoals, the same live signal arbitrateGoalConflict() already reads) and assigns one
via a real, addressed chat line -- no separate "assign a goal" mechanism, it flows through the
exact same pipeline a player's own command already uses.

2.35.0 (2026-09-08) -- direct report: "they still don't seem to react to a threatening
creature." Real, confirmed gap: checkSelfDefense() was gated on !acting, same as every other
idle-tick check -- but acting now spans an entire physical action end-to-end (up to
ACTION_TIMEOUT_MS, 90s after an earlier raise tonight), and goal-directed autonomy keeps a bot
"acting" a large fraction of the time. A threat showing up mid-mine/mid-craft got NO response
from this check at all until the health-triggered TRUE interrupt (bot.on("health") below)
finally engaged -- and that one only fires at 30% health, meaning several real, avoidable hits
already landed first. checkSelfDefense() now uses that same handler's own proven force-cancel-
then-wait-then-act sequence instead of the idle-tick gate, consistent with
checkSleepingThreat's own precedent of bypassing busy/acting for exactly the one case nothing
else can reach in time -- a live threat, unlike every other routine check's own physical work,
genuinely cannot wait.

2.34.0 (2026-09-08) -- direct request: "if they can't craft, they should explore, and find
resources for later." Wired actions.js's new "explore" verb (1.24.0) into both classifyIntent
(player-facing) and the goal planner's own vocabulary, plus a new deterministic BLOCKED
override -- same "prompt guidance plus a code guard" reasoning as the existing LOOT-before-
smelt-blocked override: a model BLOCKED on a missing raw material sometimes gives up rather
than trying EXPLORE even though the prompt already teaches it as an option. A successful
explore also writes a world memory note (position included) -- the "for later" half of the
request: not just solving today's shortage, leaving a record another bot's own goal can
recall next time it needs the same material.

2.33.0 (2026-09-08) -- direct report: "they get in water, jump to come up, but do not ever
try to reach land." Confirmed real: the anti-drowning reflex (2.29.0) only ever answered
"don't drown right now" -- once oxygen recovered, nothing steered her anywhere, so she just
kept floating wherever she surfaced. New findNearestShore() + a goto() call at the end of the
breath handler, using the pathfinder every bot already carries (now genuinely able to route
out of water since swim-movements.js's SwimMovements stopped getMoveUp()/getMoveDown() from
refusing while already submerged -- this literally could not have worked before that shipped
the same night).

2.32.0 (2026-09-08) -- direct request "start on #6" (MINECRAFT_BOTS_DESIGN.md §14, a Voyager-
style dynamic skill library). goalTick() now checks skills.js's findSkill() before spending a
planNextStep call -- a close-enough, still-trusted match runs directly via runSkill() through
the same performAction() pipeline every other step already uses, completing the goal in one
shot on success. A goal that finishes DONE without ever being served by a stored skill gets
compressed into one via authorSkillFromGoal(), using goals.js's new actionsTaken (1.3.0) --
the REAL {type, ...args} objects each successful step actually ran with, never re-derived
from text by an LLM. This is the retrieval+authoring half of §14's plan (steps 3-4 of its own
"build sequence, if greenlit"); the skill-runner and hermes-rag corpus (steps 1-2) are new
skills.js and tools/hermes-rag-{ingest,search}-minecraft.py, which serve the minecraft-skills
corpus via --corpus (they had their own dedicated -skills copies until 2026-09-24).

2.31.0 (2026-09-07) -- direct request "do 1,2,4,5" on a web-research gap analysis (see
actions.js 1.21.0's own changelog for the real detail on all four). This file's own share:
wired the new "build" verb into both classifyIntent (player-facing) and the goal planner's
vocabulary (self-directed), and corrected ACTION PLACE's now-stale "never for building"
wording now that a real building capability exists.

2.30.0 (2026-09-07) -- direct request: "build the water crossing mechanic," following 2.29.0's
anti-drowning reflex (survival, not capability). Now uses new swim-movements.js's
SwimMovements in place of stock Movements -- see that file's own comment for the confirmed
gap it closes: pathfinding could already cross open water at the surface, but had no way to
generate a move that changes depth once already in liquid, so a bank dive or a resurface
partway across a crossing was never in the search graph at all, not just expensive.

2.29.0 (2026-09-07) -- direct request: "they need to know how to swim." New bot.on("breath")
handler: watches bot.oxygenLevel (mineflayer's real air-supply tracking) and, once critical,
force-cancels whatever's running and holds the jump control while bot.entity.isInWater --
confirmed against prismarine-physics's own tick loop that this adds real upward velocity every
tick, the same mechanic a player uses to swim up. mineflayer-pathfinder itself can never
generate a "swim to the surface" move (confirmed against movements.js's own getMoveUp(): it
unconditionally refuses once already in liquid), so this had to be a direct control-state
action, not a pathfinder goal. Deliberately just a surfacing reflex (don't drown), not full
swim-to-shore navigation.

2.28.0 (2026-09-07) -- direct request: "fix it," following a real finding from tonight's own
Matrix-routing-convention check: live logs showed literally every real player chat message
all day getting logged as "busy, dropping," including ones explicitly naming a specific bot
by name. Root cause: goalTick() and nine other idle-tick action functions (checkSleep,
checkDusk, checkSelfDefense, checkHunger, checkPendingGiveRequests, checkInventoryFull,
checkLighting, the post-respawn recovery block, the emergency-flee handler,
checkSleepingThreat) all held the SAME `busy` flag handleIncoming checks for their entire
physical-action duration (up to ACTION_TIMEOUT_MS each) -- not just the brief decision that
preceded it -- even though a direct player command's own runAction() never held `busy` for
its action, only `acting`. With the autonomy loop now keeping a bot in one of these ten
functions most of the time, `busy` was effectively true almost continuously. Fixed by
removing the needless `busy` hold from all nine simple checks (kept `acting`, which already
and correctly prevents them from double-firing) and restructuring goalTick() into two
phases: `busy` held only for planNextStep()'s own decision call, released before the
resulting physical action executes, `acting` held across both. This makes the actual
behavior match this file's own pre-existing comment on goalTick ("a live player command
always wins immediately") for the first time -- it relies on nothing new: every action
already calls stopCurrent() first (actions.js), which safely interrupts whatever's
physically in flight, exactly like a direct command already could interrupt itself.

2.27.0 (2026-09-07) -- direct request: "what other behavior rules have any other sources
published or suggested" -> "all". New arbitrateGoalConflict(), built against
MINECRAFT_BOTS_DESIGN.md's own §6 table: "Cross-bot conflict arbitration (two bots claim the
same sub-goal) -> super (rare, not per-tick)" -- decided and documented back when this was
designed, never actually built until now. What existed was only the soft otherGoalsNote()
prompt nudge, which depends entirely on a bot's own model voluntarily noticing and avoiding a
collision, with nothing that actually resolves one if it doesn't. Wired into proposeOwnGoal()
only (self-proposed goals), deliberately not player-assigned ones (ACTION GOAL) -- a human's
direct instruction should never get silently overridden by an arbitration call.

2.26.0 (2026-09-07) -- direct request: "bots should pay attention to the time of day, and try
to return 'home' before full dark." New checkDusk(), same deterministic on-a-timer shape as
checkSleep -- DUSK_START_TICK (10000) fires well before checkSleep's own sleep-eligible window
(12541, bed.js's own real enforcement) so she has actual travel time, not just a same-tick
notice. Calls actions.js's new "gohome" action (1.20.0), a plain goto to bot.spawnPoint -- the
same real "home" reference the teleport-when-stuck mechanism already uses.

2.25.0 (2026-09-07) -- direct request: "if a bot gets stuck, there needs to be a mechanism to
teleport it back to its spawn point rather than continually restart that bot." Real evidence
found while investigating: Babs reconnected at the EXACT SAME coordinate across seven
consecutive process restarts over 9 minutes that same night -- a crash-and-restart cycle does
nothing for a bot wedged in terrain, since Minecraft persists player position across
reconnects just like a real player logging back in; she just gets stuck again immediately.
Two layers, both landing on the same new teleportToSpawn():
(1) In-process escalation: checkStuck's existing jump-nudge now escalates to a real teleport
    after MAX_STUCK_NUDGES consecutive zero-movement cycles despite nudging (handles a bot
    that's wedged but NOT also crash-looping).
(2) Cross-restart detection (goals.js 1.2.0's new loadStuckState/saveStuckState): the compound
    case a purely in-process timer can't catch on its own -- if something else is ALSO
    crash-looping her every minute or two, checkStuck's multi-minute threshold may never
    complete one cycle before the next restart wipes its counters. Every checkStuck tick saves
    her current position; on every fresh spawn, this position is compared against whatever was
    saved right before the process went down -- RESTART_STUCK_THRESHOLD consecutive reconnects
    within RESTART_STUCK_RADIUS blocks of each other teleports home immediately, without
    waiting to survive long enough in one continuous run to notice.
teleportToSpawn() targets bot.spawnPoint (confirmed against mineflayer's own spawn_point.js:
populated from the server's own spawn_position packet, so it's NOT corrupted by wherever she's
currently wedged), issued via bot.chat("/tp x y z") -- requires /tp permission, so
Babs/Amy/Mark/Luke were added to ops.json at level 2 (command access, not full admin) for
exactly this. Abandons her current goal on teleport, same reasoning as death/respawn: whatever
she assumed about her surroundings is now stale.

2.24.0 (2026-09-07) -- three direct requests in one round:
(1) "bots should check *any* nearby chests before resorting to mining new stacks." MINE's own
    prompt now tells the planner to try ACTION LOOT first for a resource need, before mining,
    unless the recent log already shows a LOOT attempt this goal. Pairs with actions.js
    1.19.1's own change (LOOT now takes any useful item, not just gear) -- without that half,
    nudging the planner toward LOOT wouldn't have actually found ordinary resources sitting in
    a chest anyway. Both ACTION LOOT descriptions (classifyIntent, planNextStep) updated to
    match what it actually does now.
(2) "they don't seem to be fighting back... when woken up from sleeping." Real gap: EVERY
    idle-tick check (checkSelfDefense included) is gated by the busy/acting mutex, and
    "sleep"'s own performAction call holds that mutex for its ENTIRE duration (until the real
    'wake' event or SLEEP_TIMEOUT_MS, up to 15 minutes) -- so only the emergency health-
    triggered interrupt could react at all while actually asleep, and only once health had
    already dropped to a near-death threshold. A hostile that found a sleeping bot got to hit
    her repeatedly, completely unopposed. Two fixes: the emergency interrupt now calls
    bot.wake() first when she's asleep (a forced flee can't move her while pinned in bed, and
    without waking her, this handler's own force-through logic would just collide with sleep's
    own still-pending cleanup instead of freeing it); and new checkSleepingThreat(), a
    dedicated short-interval check (deliberately bypassing busy/acting, checkStuck's own
    precedent) that wakes her and responds to a nearby hostile proactively, not just as a
    last-resort emergency.

2.23.0 (2026-09-07) -- direct request: "check the Firmament coder logs..." -> "yes" (dig
deeper) -> "yes" (run the retainer trace). A real heap snapshot plus a retainer-graph trace
(both taken from a live crash, not guessed) found the actual root mechanism: astar.js's
compute() is a fully synchronous loop that can hog Node's event loop in ~40ms chunks for up to
5 STRAIGHT SECONDS per search (tickTimeout/thinkTimeout's old defaults), starving everything
else -- Buzz, Matrix, incoming packets, pending promise callbacks -- and letting a backlog of
never-settled promises accumulate (confirmed via the snapshot's own retainer chains: rooted at
Stack/GC roots, i.e. genuinely pending, not forgotten references). thinkTimeout lowered
5000ms -> 1000ms, tickTimeout 40ms -> 20ms. See the setting's own comment for the full
evidence chain. This supersedes the earlier "reduce searchRadius" theory as the dominant
contributor -- that fix (2.22.0) was real and stays, but pathfinding NODE COUNT wasn't what
the snapshot actually showed dominating memory; event-loop starvation from BLOCKING DURATION
was.

2.22.0 (2026-09-07) -- direct request: "check the Firmament coder logs for flagged Minecraft
behavior that are not yet resolved" -> "yes" (dig into the #1 finding, the all-day recurring
OOM crash coder/coder2 kept flagging but never pinpointed). Two real, distinct contributing
causes found by reading source and tracing live incidents, not guessed:
(1) actions.js's own fix (stopCurrent()/mine()/harvest() now also call bot.stopDigging(), see
    its 1.19.0 changelog) -- nothing needed here.
(2) bot.pathfinder.searchRadius lowered from 128 to 48: 128 bounded any ONE search, but
    mineflayer-pvp's attack() uses a DYNAMIC GoalFollow, and pathfinder's own tick loop
    reruns the full search on every tick the target's position changes, with no debounce of
    its own -- against an erratically-flying target (a phantom, live evidence: 419
    path_update lines in under 30 seconds fighting one) that's a fresh expensive search
    firing nearly 20x/second. See the setting's own updated comment for the full account.
Both are real, confirmed mechanisms found from live evidence; neither is claimed as the sole
explanation for every OOM in the triage log without a heap snapshot to fully confirm against.

2.21.0 (2026-09-07) -- direct request: "ask Muse to spawn two more bots, named Mark and Luke,
with military oriented profiles, and priority towards arming themselves and defending the
spawn point." Persona content (agents/minecraft-mark, agents/minecraft-luke) was drafted by
the fleet's own "muse" model per the request's own wording, then fit into the standard
template with concrete priority directives -- see those files' own Revision History. Three
code changes here to actually support a 3rd/4th bot correctly, not just add two more entries
to a 2-bot-shaped system:
(1) BOT_USERNAMES default extended to "Babs,Amy,Mark,Luke" -- otherwise Mark/Luke's own chat
    would loop back through Babs/Amy's normal human-reply pipeline (see isAnotherBot()'s own
    comment on why that's the exact bug this list exists to prevent).
(2) Real gap found while reviewing the coordination code for 4-bot readiness: `otherBotGoal`
    was a single `let`, correct only for exactly two bots -- a 3rd/4th bot's Buzz broadcast
    would just overwrite it, silently losing track of whichever other bot posted first. Now
    `otherBotGoals`, a Map keyed by from_agent, with a shared otherGoalsNote() helper replacing
    two near-identical inline blocks in planNextStep/proposeOwnGoal.
(3) SELF_DEFENSE_FLEE_HEALTH/SELF_DEFENSE_RANGE are now env-configurable
    (MC_SELF_DEFENSE_FLEE_HEALTH/MC_SELF_DEFENSE_RANGE) rather than hardcoded constants, so
    Mark/Luke's own systemd units can run a lower flee threshold and wider detection range for
    an actually more combat-postured "defend the spawn point" behavior, without a second code
    path -- Babs/Amy are unaffected since they don't set these.
hermes-buzz.py 2.0.19 adds mc-mark/mc-luke to KNOWN_AGENTS (same convention as mc-babs/mc-amy).
infra/minecraft-bots/ gets minecraft-bot-mark.service and minecraft-bot-luke.service, same
shape as the existing babs/amy units.

Known, deliberate gap: Mark and Luke do NOT have Matrix access tokens (~/.hermes/
minecraft-matrix.env has no MC_MATRIX_MARK_TOKEN/MC_MATRIX_LUKE_TOKEN entries -- creating new
Matrix accounts on Continuwuity is a separate provisioning step outside this request's scope).
This is the same best-effort fallback every bot already has -- see MATRIX_ACCESS_TOKEN's own
comment -- Buzz/in-game chat both work normally regardless.

2.20.0 (2026-09-07) -- direct request: "the build attempts are too narrow. they should
understand classes of things. wood can be any form of wood, not just oak or spruce." Purely a
prompt-wording change here -- the real fix is actions.js's new resolveBlockFamily() (see its
own 1.18.0 changelog). Both MINE prompts (classifyIntent and planNextStep) now say that naming
any real example of a material class is enough; she'll automatically gather whatever matching
variant is actually nearby rather than needing the exact species/color present.

2.19.0 (2026-09-07) -- direct request "next set of autonomy" -> "do all four, and set a limit
on the number of times a bot will try to recover its gear from dying":
(1) goal-planner vocabulary gap: harvest/breed/enchant/fish existed since the last two rounds
    but were only ever reachable via a direct player command -- planNextStep's own vocabulary
    (confirmed by reading it) still only offered MINE/CRAFT/SMELT/PLACE/LOOT/ATTACK/REQUEST, so
    a self-proposed standing goal could never actually choose to farm, breed, enchant, or fish.
    Added all four to planNextStep's prompt and parseGoalStep's parser, same shape as every
    other verb.
(2) gear durability awareness: equipment.js's own change (effectiveTier(), see its 1.2.0
    changelog) -- nothing needed here.
(3) shield use in combat: actions.js's own change (equip a shield into off-hand before
    bot.pvp.attack(), see its 1.17.0 changelog) -- nothing needed here either; checkSelfDefense
    already calls the same "attack" action, so it benefits automatically.
(4) XP-aware enchanting: actions.js's own change (affordability check before enchant(), see its
    1.17.0 changelog) -- nothing needed here.
(5) recovery attempt limit: new MAX_RECOVERY_ATTEMPTS (default 3) on top of the existing
    `recovering` guard from tonight's drowning-loop fix -- that guard only stops chasing the
    SAME lethal spot twice. First version of this cap reset on any recover() call reporting
    ok=true, and broke within minutes of shipping: a hostile mob camping the base at spawn kept
    killing both bots again seconds after each recovery, and recover() genuinely DID succeed
    every time (she made it back and picked items up, she just didn't survive standing there
    afterward) -- a cap keyed to the action's own success never engaged. Rewritten to count
    real deaths by how close together they land in time (RAPID_DEATH_WINDOW_MS, 60s) instead --
    any death within that window of the last one extends the same incident regardless of what
    recover() reports, a longer gap starts a fresh count.

2.18.0 (2026-09-07) -- direct request "do 1-3" then "and 4" on the next round of autonomy
ideas, itself prompted by tonight's live drowning-loop incident (2.17.1/2.17.2 below):
(1) general hazard-aware pathing: Movements.liquidCost raised from its default of 1 (barely
    more than a normal step, confirmed against mineflayer-pathfinder's own astar.js) to 20 in
    the spawn handler's existing Movements setup, so pathfinder strongly prefers dry land over
    wading through water when a route exists, without banning water crossings outright.
(2) auto-equip best gear: already fully implemented (equipment.js's equipBestArmor/
    equipBestWeapon, wired into refreshGear after every craft/mine/loot) from earlier tonight
    -- nothing new needed here, confirmed by reading the existing code rather than assuming.
(3) torch placement: new checkLighting() on its own 20s timer, same idle-tick/busy-acting
    pattern as checkHunger -- reuses the existing generic "place" action (actions.js, already
    works for any held block) rather than a new case. block.light < 8 (confirmed against
    prismarine-block source as the real per-position 0-15 light value) is the trigger, the
    same threshold most mineflayer bots use for "mobs could spawn here."
(4) fishing: new "fish" action (actions.js 1.16.0) wired into classifyIntent ("ACTION FISH")
    for direct-command parity, AND into checkHunger as a fallback -- when "eat" fails (no food
    on hand) and she's holding a fishing_rod, she now tries fishing instead of just waiting
    for food to show up on its own.
Bed safety (screening a candidate bed for nearby water/lava before sleeping in it) is entirely
an actions.js change (bedNearHazard(), see its own 1.16.0 changelog) -- nothing needed here.

2.17.2 (2026-09-07) -- second hotfix from the same live check: the very next respawn after
2.17.1 shipped hit a fresh, unrelated bug in the same handler. bot.chat(await narrateAction(...))
is awaited BEFORE the goal-abandon/recover logic below it; narrateAction's "muse" call returned
503 "Loading model" right after that respawn, and since nothing caught it there, the outer
.catch() swallowed the entire async function -- goal-abandon and gear recovery were silently
skipped because of a flaky chat-flavor-text call that has nothing to do with either. Wrapped in
its own try/catch so a narration failure can no longer take the real recovery logic with it.

2.17.1 (2026-09-07) -- hotfix, caught live via "check to see if they are stuck or not behaving
to spec": Amy was stuck drowning in an infinite loop (server log confirmed repeated "Amy
drowned" every ~40-80s starting 17:11:49) because recover() paths straight back to the death
coordinate with zero hazard-awareness -- when the death itself was caused by that location
(submerged), every recovery attempt re-triggered the same fatal drowning, minting a fresh
deathPosition each time and repeating forever. New `recovering` flag: bot.on("death") now
checks whether a recovery was already in flight when the new death landed, and if so gives up
on that spot instead of chasing it again.

2.17.0 (2026-09-07) -- direct request "do the frist 3" on a further four autonomy ideas
(explicitly excluding the 4th, Nether access -- flagged as a separate, larger decision and not
requested):
(1) Stuck detection: new checkStuck() on its own 30s timer, deliberately NOT gated by the
    busy/acting mutex like every other idle-tick check -- a jump nudge is harmless and
    compatible with any in-progress action, unlike the mutually-exclusive actions those checks
    guard. Tracks position once per interval; 5 straight minutes with under 0.1 blocks of
    movement triggers a half-second jump via bot.setControlState("jump", ...) (confirmed
    against mineflayer's physics.js source).
(2) Farming: new "harvest" action (actions.js 1.15.0) finds the nearest mature crop via
    bot.findBlocks + real block-state age checks (minecraft-data confirms wheat/carrots/
    potatoes mature at age 7, beetroots at age 3 -- no separate "ready" flag exists), digs it,
    and replants from the harvested drop when one's held. "ACTION HARVEST" added to
    classifyIntent for direct-command parity with every other action.
(3) Animal breeding: new "breed" action (actions.js 1.15.0) finds two same-species animals
    within 24 blocks, equips the right feed per species, and bot.activateEntity()s each in turn
    (confirmed as the real feed-to-breed mechanic against mineflayer's inventory.js source --
    no dedicated "breed" API exists). "ACTION BREED <species>" added to classifyIntent.
(4) Enchanting: new "enchant" action (actions.js 1.15.0) opens an enchanting table with the
    target item plus lapis, waits for the real options to populate, and takes the
    cheapest/first available enchantment (confirmed against mineflayer's
    enchantment_table.js -- .enchantments exposes real .level/.expected per slot, not a fixed
    three-slot table). "ACTION ENCHANT <item_id>" added to classifyIntent.

2.16.0 (2026-09-07) -- direct request "do all" on a further four autonomy ideas:
(1) death/respawn handling: new bot.on("death")/second bot.on("spawn") pair (confirmed against
    mineflayer's health.js source: respawn is automatic, 'spawn' re-emits after it). Abandons
    her standing goal on death (its assumptions about her gear/inventory are now stale) and
    tries the new "recover" action (actions.js 1.14.0) to get back to her death spot before
    vanilla's 5-minute item despawn timer.
(2) true mid-action self-defense interrupt: new real-time bot.on("health") listener,
    explicitly deferred as "a bigger design decision" when self-defense first shipped.
    Force-cancels whatever's physically running via the same primitives stopCurrent() uses
    (no changes needed to any existing busy/acting call site), then waits briefly for that to
    naturally release the mutex before fleeing through the normal safe path.
(3) base/chest storage: new checkInventoryFull() (20s timer, same idle-tick pattern as
    checkSleep) stores the largest non-essential stack via the new "store" action once down to
    3 or fewer empty slots. "ACTION STORE"/"ACTION TRADE" also added to classifyIntent.
(4) villager trading: "ACTION TRADE <item_id>" wired as a direct command only (see actions.js
    1.14.0's own comment on why it's not in the goal planner's vocabulary).

2.15.0 (2026-09-07) -- direct follow-up to "look for more ways to improve their autonomy," all
four built together:
(1) Cross-bot goal coordination: new Buzz topic "minecraft-coordination" (hermes-buzz.py
    2.0.18, deliberately separate from "minecraft" -- see that topic's own comment on why).
    Every goal state change (set, done, abandoned, stopped) broadcasts; otherBotGoal tracks
    the other bot's current goal and feeds both proposeOwnGoal and planNextStep, so a real
    collision observed live tonight (both bots picking "get copper armor" at once, both
    burning attempts on the same occupied furnaces) has a real chance of not repeating.
(2) Environmental memory: planNextStep now searches the existing long-term memory (same
    corpus generateReply already uses for chat) using the goal description as the query, and
    a mine/loot/smelt failure that survived actions.js's own wander-retry ("even after
    looking around") writes a world-scoped note -- "no oak_log nearby" no longer has to be
    rediscovered from scratch by both bots across every separate goal cycle.
(3) Hunger: new checkHunger() on its own 15s timer, same idle-tick pattern as checkSleep --
    eats proactively via the new "eat" action (actions.js 1.13.0) once below 18/20 food.
(4) Bot-to-bot help: new "ACTION REQUEST <item_id> <count>" (goalTick handles it directly,
    Buzz-only, never touches performAction) lets a genuinely stuck bot ask the other one for
    an item over "minecraft-coordination"; the receiving bot checks her own inventory in the
    topic handler and, if she can help, a new checkPendingGiveRequests() (10s timer) delivers
    it via the new "give" action (paths to the requester, then bot.toss()). "ACTION EAT"/
    "ACTION GIVE" also added to classifyIntent for direct-command parity with every other
    action.

2.14.1 (2026-09-07) -- fifth and last of five scoped enhancements: tighter DONE validation.
goals.js 1.1.0's new `sawSuccess` field (set whenever any real step logs ok=true) lets goalTick
tell a DONE claim backed by real progress from one that isn't -- a real hallucinated DONE was
observed live tonight (a goal reporting complete after every logged step had failed). Flagged
in the console (SUSPICIOUS DONE), not blocked -- refusing the model's own DONE outright risks a
worse failure mode (an endless "are you sure" loop) than the rare cosmetic mislabeling this
catches. Matched by hermes-minecraft-triage.py's own patterns so the Firmament's own triage
service surfaces it too, not just a human reading this bot's log directly.

2.14.0 (2026-09-07) -- fourth of five scoped enhancements: self-defense. New checkSelfDefense()
on its own short timer (7s -- more time-sensitive than sleep's 30s), same idle-tick/busy-acting
pattern as checkSleep() -- flees (actions.js 1.12.0's new "flee") below half health with a
threat nearby, otherwise fights via the existing "attack." Deliberately the idle-tick version
scoped up front, not a true mid-action interrupt (see actions.js's own comment on why that's a
bigger design decision). "ACTION FLEE" also added to classifyIntent for direct-command parity
with every other action.

2.13.1 (2026-09-07) -- third of five scoped enhancements: cave-pathfinding cap. Real evidence
from tonight's own OOM crashes (hermes-minecraft-triage.py's log) traced to
bot.pathfinder.searchRadius's DEFAULT of -1, confirmed by reading mineflayer-pathfinder's own
source (index.js/astar.js) -- "don't limit the search area" at all. thinkTimeout (5000ms
default) only bounds wall-clock time, not how many node objects get allocated within that
window; in complex cave terrain that was enough to hit 25,000+ visited nodes and exhaust the
heap before the timeout even fired. Set to 128 -- real headroom over every target distance this
codebase actually asks for, while directly bounding the pathological case.

2.13.0 (2026-09-07) -- direct follow-up to "what other logic enhancements are available,"
first two of five scoped and built in order: "ACTION PLACE <item_id>" wired throughout
(classifyIntent so a player can ask directly, planNextStep's vocabulary and SMELT/CRAFT
guidance -- placing a spare furnace/table she's carrying is now the preferred fallback over
giving up or looting, proposeOwnGoal's own placement claim corrected to match). Explore/wander
(actions.js 1.11.0's wanderAndRetryFind()) needed no wiring here -- it's internal to
mine/loot/smelt's own existing "not found" handling, not a new verb the planner needs to know.

2.12.3 (2026-09-07) -- real gap found live: both bots kept self-proposing the exact same goal
(e.g. "smelt some copper") immediately after giving up on it, since proposeOwnGoal had no
memory of what she'd just tried -- an unproductive loop across separate goal cycles, distinct
from and not fixed by anything within a single goal's own retry/consecutiveFailures logic. New
recentGoalOutcomes (small, capped) records every done/gave-up outcome and gets folded into the
self-propose prompt as data to reason about, not a hard blocklist -- sometimes repeating IS
right (e.g. she just looted fuel she didn't have before).

2.12.2 (2026-09-07) -- two real gaps found live minutes after smelting shipped: (1) planNextStep
never told the planner SMELT needs fuel, or what to do about it -- a bot with raw copper but no
coal/charcoal/logs just kept retrying the same smelt attempt and gave up 3/3. Prompt now says
to mine a log (valid fuel) if smelting fails for lack of fuel, same "mine the missing raw
material" pattern already taught for crafting. (2) actions.js 1.10.1 fixes the matching root
cause: SMELT's <item_id> is supposed to be the OUTPUT, but the planner sometimes named the
INPUT raw material instead and got a confusing rejection -- now accepts either.

2.12.1 (2026-09-07) -- direct request: "they can't seem to find the furnaces." Most of
tonight's goal-loop failures were bots correctly reasoning they needed an ingot and having no
way to get one beyond hoping a chest had it -- real gap, not a bug: nothing here ever taught
them furnaces exist. New "smelt" action (actions.js 1.10.0) wired in throughout: classifyIntent
gets "ACTION SMELT" (a player can ask directly, same as every other action), planNextStep's
prompt now teaches SMELT as the primary path for a smelted item (raw material -> furnace, not
a crafting-table recipe, which can never produce one) with LOOT as the fallback rather than
the only option, and proposeOwnGoal no longer tells a bot she has no furnace at all -- all
three previously said "NO furnace/smelting capability," which was true when written and is
simply no longer accurate now.

2.12.0 (2026-09-07) -- direct request: "the bots need to know to go to sleep at night." New
checkSleep(), on its own 30s timer, entirely separate from goalTick's model-driven loop --
deciding whether it's night needs no reasoning, just bot.time.timeOfDay (mineflayer core,
matched to the exact window bed.js's own bot.sleep() enforces). Reuses busy/acting so a live
command always takes precedence and interrupts a night's sleep (actions.js 1.9.0's stopCurrent
now forces a wake for that). The real per-bed logic (finding one, trying it, waiting for
morning) lives in actions.js's new "sleep" action, built on mineflayer's own bed.js plugin.
Also added "ACTION SLEEP" to classifyIntent's vocabulary so a player can directly tell her to
go to bed too, same as every other action.

2.11.6 (2026-09-07) -- two more fixes minutes after 2.11.5's token-budget bump: (1) the SAME
truncation failure as 2.11.3 recurred at the doubled 220-token budget -- the model still
doesn't reliably keep its reasoning to one sentence, so the budget went to 500 instead of a
third incremental guess. (2) the loot-before-BLOCKED instruction (2.11.2) was ignored a second
time -- the model stated its own reasoning ("no prior LOOT attempt...") and went BLOCKED
anyway. This specific condition is simple and mechanically checkable (has "loot:" ever
appeared in this goal's own log?), so goalTick now enforces it in code as a backstop rather
than trusting a written instruction alone a second time.

2.11.4 (2026-09-07) -- real gap found live minutes after 2.11.3 shipped: even with the
loot-before-BLOCKED requirement (2.11.2), a self-proposed goal phrased around an impossible
METHOD ("smelt the copper into ingots") made the planner treat the goal as literally requiring
that verb and go BLOCKED immediately, reasoning "the goal explicitly asks to smelt" -- never
trying LOOT even though Recent progress was empty. The instruction to reinterpret charitably
wasn't enough once the goal text itself named an impossible verb. Real fix is upstream:
proposeOwnGoal's prompt now requires goals be phrased around the OUTCOME wanted ("get some
copper armor"), never a specific method she can't perform ("smelt X", "build X") -- an
outcome-phrased goal leaves room for the planner to reach it by looting instead.

2.11.3 (2026-09-07) -- two more real gaps found live within minutes of 2.11.2 shipping: (1) a
factually-confused self-proposed goal ("smashing cobblestone into planks" -- planks come from
logs, not stone) made the planner ramble past its one-sentence reasoning budget and get cut
off by maxTokens before reaching its required final decision line -- parseGoalStep's fallback
then counted as a real strike for a goal that was never fairly evaluated. Fixed at both ends:
proposeOwnGoal's prompt now states the same real crafting facts planNextStep already knew, and
planNextStep's own budget went from 120 to 220 tokens plus an explicit "reinterpret charitably,
always end with a decision line" instruction. (2) a bot self-proposed "build a warm little
house" -- building/placing was explicitly out of scope from this system's first design pass
(MINECRAFT_BOTS_DESIGN.md §5) and no such action exists at all, so she'd have mined materials
forever with no way to ever finish. Both prompts now say so explicitly.

2.11.2 (2026-09-07) -- real gap found live minutes after 2.11.1's reasoning fix shipped: Amy
correctly reasoned, three separate times, that an ingot she needed could only come from
looting a chest -- and then went BLOCKED anyway without ever actually issuing ACTION LOOT to
check one. Correct diagnosis, no follow-through. planNextStep's prompt now explicitly requires
a LOOT attempt to actually appear in Recent progress before BLOCKED is allowed for that reason.

2.11.1 (2026-09-07) -- real gap found live within minutes of 2.11.0 shipping: every goal-loop
transition (a step taken, DONE, BLOCKED, giving up) only ever reached the player via bot.chat
(in-game) or the goal's own persisted log -- nothing printed to console/journalctl, so a crash
inside a step (see actions.js 1.8.1) left no trace to diagnose from except reading goal.json
directly after the fact. Added explicit console.log for every one of these transitions --
same "correctness/diagnosability over log-volume minimalism" instruction that made 2.10.0's
path_update logging permanent.

Firmament Minecraft bot orchestrator. Connects one bot and wires the first real decision
loop: chat perception -> cheap relevance classification (dispatch role) -> in-character
reply (muse role) -> bot chats back. See ../../MINECRAFT_BOTS_DESIGN.md.

2.11.0 (2026-09-07) -- direct request: "give her more autonomy to work towards longer goals,"
with a real fork resolved by direct instruction: goals can come from a player (new "ACTION
GOAL <description>" verb, classifyIntent's existing one-call vocabulary) OR the bot can
propose her own once she's had no active goal and heard from no one for a while. Either way,
a goal persists (goals.js, survives restart the same way inventory does) and gets worked one
step at a time on its own timer (goalTick, MC_GOAL_TICK_MS) through the *same* performAction()
pipeline a direct chat command already uses -- a standing goal is never a separate, less-
tested way of moving/mining/fighting/crafting/looting. The tick only ever fires when nothing
else has the bot's attention (`busy`/new `acting` flag), so a live player command always wins
immediately and the goal loop just resumes on its own next tick once that command's action
finishes -- no separate interrupt/resume logic needed, it falls out of the existing mutex.
`ACTION STOP` now also abandons any active goal (matches the plain-English expectation that
"stop" means stop everything, not just the current physical motion). performAction() needed a
structural success/failure signal for this (actions.js 1.8.0, { ok, text } instead of a bare
string) rather than regex-guessing "ok" from English result text, which would silently break
the moment a message's wording changed.

2.10.0 (2026-09-07) -- direct report: navigation is unreliable around doors/ladders/stairs.
mineflayer-pathfinder defaults canOpenDoors to false with its own comment ("Causes issues.
Probably due to none paper servers.") -- enabled now that this fleet runs a mature, fully-
supported version (1.21.11) rather than trusting a comment of unknown vintage. Also added
permanent path_update/goal_reached/path_reset logging (astar's own real status/cost/visited-
node data) so any future navigation failure is diagnosable from real data, not guesswork --
kept permanently per direct instruction: correctness/diagnosability over call/log-volume
minimalism, since everything here runs on local compute with no per-call cost.

2.9.0 (2026-09-06) -- direct request: "pre-teach the most common recipes." New "craft"
action (classifyIntent detects it the same one-call way as every other action; the real
implementation is actions.js's craftItem(), which uses minecraft-data's own built-in recipe
knowledge rather than anything taught here).

2.8.0 (2026-09-06) -- direct request: bots should look in chests for gear, wear the best
armor they find, and hold the best weapon unless a task needs a specific tool. New "loot"
action (equipment.js + actions.js); gear is rechecked automatically after mine/attack/loot
and once at spawn (inventory persists across restarts -- it's tied to the player's UUID in
the world save). Crafting and building are still explicitly out of scope for this pass.

2.7.0 (2026-09-06) -- real in-world actions (actions.js): navigate (goto/follow/stop),
gather (mine), and fight (attack) -- closing the gap between what the personas' Core
Directives always claimed and what the bots could actually do. classifyIntent() replaces
the old plain-YES/NO isRelevant() with one dispatch call that also detects an action
request, keeping the "one cheap call" efficiency discipline intact rather than adding a
second round-trip. Actions run in the background via runAction(), deliberately outside the
`busy` window that guards the classify/reply step -- a mine/follow/attack can run for up to
a minute (actions.js's own ACTION_TIMEOUT_MS), and holding that mutex for the whole span
would make the bot go silent to chat while she works. Building/structure placement stays
explicitly out of scope -- a much bigger feature (planning, materials, layout) that deserves
its own pass, not something to half-build alongside navigate/gather/fight.

2.6.0 (2026-09-06) -- Matrix wired (design doc §10, matrix.js): a single shared room
(operator's own decision, not one room per bot like the retired Sintra/Amy pattern), both
bots and the operator as members. Talks directly to Continuwuity's Client-Server API, not
the fleet's old "hermes gateway" tool (built around the different per-agent-room
architecture). New Matrix accounts (mc-babs, mc-amy) registered via the standard
enable-registration/create/re-lock recipe in infra/continuwuity/README.md. Credentials in
~/.hermes/minecraft-matrix.env, not Vaultwarden -- see run-bot.sh 1.3.0's own note on why.
Reuses handleIncoming() exactly as public chat/whisper already did -- the isAnotherBot()
guard (renamed from the Buzz-era BOT_USERNAMES-only check) now also recognizes any `@mc-`
Matrix identity, so the same bot-relaying-into-a-shared-channel feedback loop 2.5.0 fixed for
Buzz->in-game-chat can't happen for Matrix either.

2.5.0 (2026-09-06) -- bot-to-bot coordination over hermes-buzz.py (design doc §9, buzz.js).
Every WORLD-scoped long-term memory (see maybeRemember) is also published to the shared
`minecraft` Buzz topic; each bot subscribes and relays what it hears from other bots into
in-game chat, a directly observable trace that coordination happened. Real feedback-loop
risk found and fixed while building this: every bot is just another player to mineflayer, so
without a guard, Babs relaying a Buzz message into public chat would trigger Amy's own `chat`
listener and send her down the normal human-reply pipeline (and vice versa) -- MC_BOT_USERNAMES
now excludes known bot identities from that pipeline entirely; bot-to-bot traffic stays on
Buzz, never the chat-relevance loop meant for human players.

2.4.0 (2026-09-06) -- long-term memory via the new "minecraft" hermes-rag corpus (design doc
§7, longterm.js): before each reply, a semantic search over past notes (both this bot's own
and shared world facts) is folded into the muse call's system message. After each reply
(never blocking it -- see maybeRemember's own comment), a cheap dispatch call decides
whether the exchange contained anything worth remembering long-term and writes it as a small
markdown note, reindexed immediately (content-hash dedup keeps repeat reindexes cheap).

2.3.0 (2026-09-06) -- persistent per-bot conversation memory via hermes-memory.py (design
doc §7): every incoming line and every reply is recorded as a turn (agent=mc-<persona>,
conv_id=mc-<persona>:<speaker>), and recent history for that speaker is read back before
each reply -- she now remembers a conversation across restarts, not just within one process
lifetime. Run via run-babs.sh, which fetches MEMORY_TOKEN from Vaultwarden once at startup
(fetch-once-at-startup, same pattern every other fleet caller of hermes-memory uses) --
running index.js directly without it still works, just stateless (memory.js's own
best-effort fallback), same as before this version.

2.2.0 (2026-09-06) -- Boss registration: BOSS_USERNAMES resolves a real in-game username to
the "Boss" role a persona file can reference (see agents/minecraft-babs/PROMPT.md's
Behavioral Modifiers) without the persona file itself hardcoding an identity. Orchestrator's
job, not the persona's -- CanisLupisM registered as the first Boss identity.

2.1.0 (2026-09-06) -- whisper handling: /msg, /tell, /w fire mineflayer's separate `whisper`
event, not `chat` -- confirmed live (a real /tell produced no log line under 2.0.0). Replies
to a whisper go back as a whisper, and skip the relevance check entirely since a whisper is
already addressed to her by construction.

2.0.0 (2026-09-06) -- decision loop wired for the first time, replacing 1.0.0's pure
connectivity-proof scaffolding. Deliberately minimal still: no memory (hermes-memory/
hermes-rag), no Buzz, no Matrix -- one bot, one persona, one loop, proven end to end before
any of that gets added. A `busy` flag serializes decisions per bot rather than letting
concurrent chat lines pile up parallel router calls -- matches the design doc's own
efficiency principle (§5): don't spend a model call faster than the previous one resolved.
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-13 | Created: index.js's header changelog moved here verbatim, plus its 3.0.0 entry. |
