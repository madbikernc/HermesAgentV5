// Version: 2.0.0
// 2.0.0 (2026-11-10): split into per-area files under tests/unit/ (shared stubs in
// tests/unit/_harness.mjs), each under 40000 chars so the self-repair pipeline -- which rewrites a
// whole file and refuses any over MAX_FILE_CHARS -- can add a test to one. This file now only runs
// them, in order, one after another. Add a new check to the area file it belongs to.
// 1.57.0 (2026-11-07): a search out of budget walks its partial path and searches again (swim-movements.js 1.6.0).
// 1.56.0 (2026-11-07): chest searches reach 128 blocks, far chests walked in hops (actions.js 1.107.0).
// 1.55.0 (2026-11-07): chests chosen by what they're known to hold, and a split kind of item moved
// together in full stacks (actions.js 1.106.0, index.js 2.136.0).
// 1.54.0 (2026-11-06): the ranch goal re-picks a vanished species and explores with none in sight;
// herd_to_pen looks 64 out (index.js 2.135.0, actions.js 1.105.0).
// 1.53.0 (2026-11-06): the sea floor is not a shore (index.js 2.134.2).
// 1.52.0 (2026-11-06): gatherPlanks with no tree in sight goes looking (index.js 2.134.1).
// 1.51.0 (2026-11-05): a two-bed shelter is not asked for a chest; craftItem's chain makes sticks for
// every run; the Farmer and Herder get their own role work, and stand in for their own role (index.js
// 2.134.0, actions.js 1.104.0).
// 1.50.0 (2026-11-05): the extra-chest retry backs off on no wood, not on a failed craft (index.js 2.133.2).
// 1.49.0 (2026-11-05): bobbing at a pool's surface (isInWater false for a tick) still runs the
// shore search (index.js 2.133.1).
// 1.48.0 (2026-11-04): six checks for the 24h-review loops (index.js 2.133.0/actions.js 1.103.0) --
// full chests get a new chest and plain surplus dropped, a pickaxe-less bot's tools item is a
// wooden pickaxe, a Builder furnace is made by its runner, shelter_capacity counts online bots,
// "mine" prefers exposed stone and skips a no-path target, a torch from coal and logs. Then the
// residence model (a bed per active bot, each residence with a chest), trash into lava, the
// drowning reflex on her own air, a shore search that survives findBlocks' palette pass, and a new
// chest whenever every chest at home is full. Existing shelter checks moved onto residencePlan.
// 1.35.0 (2026-10-27): checks for index.js 2.122.0/actions.js 1.94.0's four fixes. Builder
// checklist: builderPriorityCandidates()/builderPriorityItemSatisfied() re-open crafting_table/
// furnace/chest once isUtilityUsable() reports the only known one broken, and the two functions
// stay in lockstep for the same signal. Shelter: findShelterSite() finds a site farther out once
// the old fixed-radius core is fully blocked, and findShelterNearHome() (the regression this fix
// had to close in lockstep) now recognizes a shelter built just beyond the old 4-block window --
// plus a second regression caught in review: ring-expansion must not stop on a merely-damaged
// match from the innermost ring, or a half-built structure near home would hide a genuinely
// complete shelter farther out.
// RAG registration: runBuilderPlacement() and runShelterGoal() each write a note on a real
// completion (stubbed in every farmGoalSrc()-based context that reaches their success path --
// bedWorld()'s "sleep" tests needed a findRememberedLocation()/gotoRememberedSpot() stub too, for
// the same reason). Beds: sleep falls back to a remembered bed when nothing is nearby, and
// bedStep() builds on the spot instead of trekking home once she's far from both home and any
// remembered bed.
// 1.34.0 (2026-10-22): generalizes 1.33.0's checks for shelter.js 1.3.0's shelterRoomsNear()/
// holesIn() and the unified index.js 2.121.0 checkShelterIntegrity() -- replaces the now-removed
// checkCommunalShelterIntegrity() test. New coverage: a sealed room has zero holes and a real
// gap is found exactly; any number of separate individual shelters are each kept apart, not
// merged or lost; a larger shelter in a shape neither fixed geometry builds is recognized and
// its hole found; the unified periodic check repairs whichever room in the list is damaged via
// the new generic "patch_shelter" action, and "patch_shelter" itself never computes its own
// geometry or touches a door.
// 1.33.0 (2026-10-22): two new checks for index.js 2.120.0's checkCommunalShelterIntegrity() --
// findCommunalShelterNearHome() correctly reports a damaged (not just complete-or-nothing)
// communal shelter, and the new periodic wrapper calls build_communal_shelter with the right
// base/width/depth only when damaged, never on a complete structure or a bare absence.
// 1.32.0 (2026-10-22): two new MB-01 checks for actions.js 1.92.0's noPath burst bailout (the
// attack_win_rate regression fix) -- four real noPath path_update results bail out well short
// of the test's 400ms ACTION_TIMEOUT_MS with a new "couldn't reach it" outcome, and a lone/
// transient noPath that's followed by a real path doesn't abandon a fight that then lands a
// kill.
// 1.31.1 (2026-10-21): the S34 "S27f analysis mode..." test's chat-site scan window was 25
// lines, too short to reach generateReply()'s callRole() options (36 lines from its <speaker>
// content line) -- found live on spark, crashed the whole suite on an uncaught assertion.
// Widened to 40. No other test changed.
// Fix-validation checks for docs/reviews/2026-09-24-minecraft-bots-review.md. Each case is the
// matching reproduction from 2026-09-24-minecraft-bots-repro.mjs, inverted to assert the corrected
// behavior. Source-extraction harness: no Minecraft server or npm install needed.
// Run: node services/minecraft-bots/tests/unit.test.mjs  (or tests/run.sh unit)
// Revision History: 1.0.0 | 2026-09-24 | Initial checks for MB-01..MB-11 and MB-22 remediations.
// 1.1.0 | 2026-09-24 | Checks for MB-13, MB-14, MB-16, MB-17, MB-20.
// 1.2.0 | 2026-09-24 | Efficiency checks: standing guard, home-lighting backoff, storage backoff.
// 1.3.0 | 2026-09-24 | MB-11 check also asserts server echoes (Rcon) and the live-test bot are ignored.
// 1.4.0 | 2026-09-24 | Review follow-up checks: open window closed on takeover, flee movements scoping,
//   place_home, bare stop from the active commander, goal-reserved items, delivery retry/ack,
//   OUTCOME lines, chest-miss cache, gear-refresh skip, note dedupe, Soldier armor, routine skips.
// 1.5.0 | 2026-09-25 | Review acceptance checks: MB-03 rejected /tp, MB-05 replacement during skill
//   lookup and planning, MB-10 cancelled replay + 13-step authoring, MB-12 heartbeat/lease, MB-20
//   restart persistence, MB-21 router/RAG timeouts, MB-22 stationary vs wedged.
// 1.6.0 | 2026-09-25 | Fight-or-flee policy and attacker tracking, /spreadplayers rescue, rag-backend
//   local timeouts and remote mode (spark2 RAG).
// 1.7.0 | 2026-09-25 | Beds: a destroyed claim moves to the nearest unclaimed bed, claim conflicts,
//   sleep tries unclaimed beds first (one candidate per bed) and never claims another bot's.
// 1.8.0 | 2026-09-25 | Shared bed claims: cross-host conflicts, migration of a host's claim, store
//   clears, sleep skipping another host's bed; the older bed checks now cover the local fallback.
// 1.9.0 | 2026-09-25 | Doors: open doors/gates walkable, closed wooden ones openable, iron closed a wall,
//   doorway waypoints put back on the floor, and the guard that never re-toggles an open door.
// 1.10.0 | 2026-09-25 | Close behind: doors/gates shut once clear, without a head turn; held for a
//   follower and during herd_to_pen; iron and already-shut doors left alone.
// 1.11.0 | 2026-09-25 | Farming/ranching: food fetch and backoff, farm/ranch goal routing and runners,
//   harvested-crop curriculum evidence, farm plot and pen site choice.
// 1.12.0 | 2026-09-25 | Ripe-crop routine backoff; drops collected only after a real harvest.
// 1.13.0 | 2026-09-25 | Enchants normalization (digging with enchanted gear).
// 1.14.0 | 2026-09-26 | Beds: colour choice, bed site, bed goal routing and runner, the no-bed-at-night goal.
// 1.15.0 | 2026-09-26 | Shelters: materials, site, routing, the height-tolerant shelter check, the goal runner.
// 1.16.0 | 2026-09-26 | Beds: occupied spots skipped and refused spots not retried; wood before crafting.
// 1.17.0 | 2026-09-27 | Shelters fit a bed (4x4, 2x2 room; the old 3x3 no longer counts); beds prefer the room; the bed-shortage goal trigger.
// 1.18.0 | 2026-10-07 | Access: chest lids, doorways, the last way up to a bed, falling blocks, the
//   obstruction scan, "place"/"clear_access"/"mine" and the other four placement sites. Shelter walls:
//   the covered fill, its cap, an open-sky bed, and pathfinder's refusal to dig one. Torches: trail
//   spacing, what can hold one, between-digs timing, and the supply top-up's backoff.
// 1.19.0 | 2026-10-07 | First real run of the above, on spark: `class V3` hoisted (not hoisted by JS,
//   and the first check now needs it), the place_home stub given a real V3 world, vm-context arrays
//   spread before deepStrictEqual (different Array prototype), blockWorld given block ids plus a
//   registry with emitLight, and a check that craftItem chains through shaped recipes.
// 1.20.0 | 2026-10-09 | attackAsLastResort fights bare-handed when genuinely unable to flee; craft's
//   tableWouldHelp check against empty hands (recipesAll, not recipesFor); an already-placed utility
//   block found during a craft attempt gets written to world memory too.
// 1.21.0 | 2026-10-09 | First live run of the above found tableWouldHelp was still wrong for any
//   item with a second, unusable no-table recipe (a colored bed's dye-recolor shortcut) -- a check
//   for that case too.
// 1.22.0 | 2026-10-10 | A healthy non-Soldier fights a single ordinary mob directly, not just a
//   hurt or Soldier one; get_wool wanders to look for a sheep instead of instant-failing.
// 1.23.0 | 2026-10-11 | Shelter: a real door required (not just an opening), 100% solid walls/
//   roof/floor (not 80%), the floor itself now checked at all; findShelterNearHome()'s own
//   damaged-but-real-structure detection, separate from the hasShelterNearHome() boolean. Also:
//   the room grew from 2x2 to 2x3 (found live the same day -- a real door and a bed could never
//   both fit in 2x2), updating every geometry-derived count and offset this file asserts.
// 1.24.0 | 2026-10-11 | PRIORITIES_PROPOSAL.md Tiers 1-2: nextSurvivalPriority()'s ordering
//   (weapon, sheltered bed, food, armor, null) and survivalPriorityItemSatisfied(); the Soldier
//   priorities check narrowed now that weapon/armor live there instead; the new builder-item
//   claim mechanism (blocks, releases, TTL-expires, falls back to a local file); and
//   builderPriorityCandidates()'s "beds"+"shelter" merge into one real countQualifyingSheltersNearHome()
//   check (multiple separate structures, not just the nearest).
// 1.25.0 | 2026-10-11 | PRIORITIES_PROPOSAL.md Tier 2 items 2-4: "craft"'s reusable-utility-block
//   check now falls back to a remembered location, not just the local 32-block view; new
//   checkSurplusSharing() and checkLocationSharing() give surplus-storing and location-sharing
//   a standing cadence of their own instead of only running as a side effect of something else.
// 1.26.0 | 2026-10-11 | PRIORITIES_PROPOSAL.md §2a (the guard-anchor claim): actions.js's new
//   holdsGuardAnchor() (a single shared slot, not one row per bot); index.js's isLiveSoldier()/
//   isGuardAnchor()/nextSoldierPriority()'s new anchor-vs-escort split, now async.
// 1.27.0 | 2026-10-12 | PRIORITIES_PROPOSAL.md Tier 2 item 1a (the communal shelter, sized per
//   the operator's own rule) and the first instance of the resource-gathering override:
//   isCommunalShelterMaterial/communalShelterPositions/findCommunalShelterSite (actions.js), the
//   new "build_communal_shelter" case and place_bed's action.near; fleetHasReachedIronTools()'s
//   fleet-wide evidence tracking, communalShelterSize()'s dynamic sizing, structure/bed-count
//   verification, farmTaskFor's "communal" routing, and the shared gatherPlanks() helper
//   (index.js). Also fixes this file's own top "Version:" line, which had quietly fallen behind
//   the Revision History below it since 1.24.0 -- a real, if harmless, drift this bump closes.
// 1.28.0 | 2026-10-12 | Root-caused a real, confirmed live regression (attack_win_rate collapsed
//   from a 0.846 baseline to 0.167): weaponStep()/runWeaponGoal(), a dedicated runner for weapon
//   acquisition (a nearby chest first, else gatherPlanks() + craft), dispatched off
//   currentGoal.survivalPriorityItem rather than the unreliable freeform planner.
// 1.29.0 | 2026-10-13 | Direct report after a fleet reset ("combat seems better, but building
//   and tooling do not"): "mine" takes a partial chest match and still mines the shortfall
//   (actions.js); a server-refused bed spot is not retried on a later goal tick (actions.js);
//   toolStep()/runToolGoal(), the same dedicated-runner shape extended to pickaxe acquisition,
//   dispatched by TOOL_WORDS text match rather than the freeform planner, plus a check that
//   TOOL_WORDS ("pickaxe" only) never collides with weaponStep's own "sword or axe" text.
// 1.30.0 | 2026-10-16 | Direct report after a world reinit ("check the last 24 hours behavior
//   logs for incorrect behaviors"): the Tier 1 shelter+bed directive now routes to shelterStep,
//   not bedStep (BED_WORDS was checked before SHELTER_WORDS/COMMUNAL_SHELTER_WORDS, and matched
//   the directive's own mention of "bed"); dedicated runners (farmTask-tagged or
//   survivalPriorityItem="weapon") get a 20-failure leash instead of sharing the freeform
//   planner's 3, so transient terrain failures no longer wipe accumulated goal progress.
// 1.31.0 | 2026-10-18 | Direct request: bed claiming removed -- the old bedWorld()/claim-conflict
//   checks (1.7.0/1.8.0/1.16.0/1.17.0's bed-shortage half) are replaced with sleep trying every
//   usable bed nearest-first, skipping occupied ones, no cap at 3, no claim file ever written.
//   New shelter-detection checks (enclosedInterior/isSandWallName/shelterInteriorsNear, any shape,
//   no openings but doors, walls any material but sand) and findBedSites' own preference for a
//   site inside one. bedSiteWorld()'s findBlocks fixed to honour its own `matching` filter.

import { passedCount } from './unit/_harness.mjs';

await import('./unit/combat.test.mjs');
await import('./unit/control.test.mjs');
await import('./unit/crafting-1.test.mjs');
await import('./unit/crafting-2.test.mjs');
await import('./unit/gathering.test.mjs');
await import('./unit/builder.test.mjs');
await import('./unit/chests-1.test.mjs');
await import('./unit/chests-2.test.mjs');
await import('./unit/farming.test.mjs');
await import('./unit/beds-1.test.mjs');
await import('./unit/beds-2.test.mjs');
await import('./unit/shelter-1.test.mjs');
await import('./unit/shelter-2.test.mjs');
await import('./unit/services.test.mjs');
await import('./unit/doors-1.test.mjs');
await import('./unit/doors-2.test.mjs');
await import('./unit/pathfinding.test.mjs');

console.log(`${passedCount()} unit checks passed.`);
