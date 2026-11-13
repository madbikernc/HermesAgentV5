# actions.js change history

**Version:** 1.0.0

The change history of `services/minecraft-bots/actions.js`, newest first. Until 2026-11-13 it was the
comment block at the top of `actions.js` itself (97k characters, more than the self-repair pipeline's
whole 40000-character file limit on its own); it was moved here verbatim when `actions.js` was split
into subject modules (`actions.js` 3.0.0, direct operator request). `actions.js` keeps its `// Version:`
line; each new version's entry goes at the top of the list below. (Each action's own file under
`actions/` keeps its own history, as before.)

## Versions

### 3.0.0 (2026-11-13)

Split into subject modules, each under the self-repair pipeline's 40000-character limit: action-vocab.js, action-search.js, action-movement.js, action-crafting.js, action-world.js, action-shelter.js, action-chests.js, action-claims.js. Code moved unchanged; `actions.js` keeps performAction(), performActionAs() and its dispatcher, the mine-target ranking and LOOT_GROUPS, and re-exports every name it exported before, so every `import ... from "../actions.js"` still resolves. The `export { loadPenLocation, BREEDING_FOOD }` list became `export` on the two declarations. This change history moved here.

### 2.0.0 and earlier (moved verbatim from actions.js)

```text
2.0.0 (2026-11-10): every action moved unchanged out of performActionAs()'s switch into its own
file under actions/ (41 files, the largest 12k), dispatched by ACTION_HANDLERS -- so self-repair,
which rewrites one whole file under 40000 chars, can fix an action. The helpers the actions share
stay here, now exported; the no-op try/finally that only existed to avoid re-indenting the switch
is gone.
1.107.0 (2026-11-07): every chest search (loot, the chest-first fallback, store, consolidation)
reaches CHEST_SEARCH_RADIUS, 128 blocks (was 32); a chest beyond 40 is walked to in hops (hopToward).
1.106.0 (2026-11-07): "store" picks the chest already holding that item or its kind (rankStoreChests,
itemFamily), and known_chests.json records each chest's free slots. New "consolidate_chests": a
kind split between two chests near her goes into the fuller one in full stacks; a chest snapshot
that shows such a split leaves it as takeConsolidationHint().
1.105.0 (2026-11-06): herd_to_pen looks 64 blocks out for a loose animal (was 32), with enough
herding steps to lead it back from there.
1.104.0 (2026-11-05): craftItem's chain makes each ingredient for every run of the recipe, not
one -- 23 fences need 16 sticks, and it made none while two were in hand -- and crafts one run per
bot.craft() call, each waited for (mineflayer's multi-run craft worked from a stale inventory).
1.103.0 (2026-11-04, 24h review): "mine" tries stone with an open face before buried stone, and
skips a target that just failed "No path" for 10 minutes. A stick can come from a log by way of
planks, so a torch is made from coal and logs. "place" takes `at`, one named cell (a residence's
chest goes inside its room). light_area's and plant_sapling's findBlocks matchers no longer reject
the position-less palette blocks findBlocks pre-checks each section with (they found nothing).
1.102.3 (2026-11-02): "patch_shelter" skips a hole that wouldBlockAccess refuses.
1.102.2 (2026-11-01): fences are protected from digging, like their gate.
1.102.1 (2026-11-01): craftItem's chain counts what she holds by item id (it read 0 by name)
and stops at the first affordable variant; simpleSourceFor matches planks to their own log.

1.102.0 (2026-11-01): new "gather_seeds" -- break grass for wheat seeds, so a stand-in farmer or
herder isn't stuck on an empty chest.

1.101.0 (2026-11-01): hunt reaches 64 blocks and takes chickens; raw chicken is food, ranked last.

1.94.0 (2026-10-27, direct requests over several follow-ups, investigating "why don't
furnaces/chests/shelter get built"): four changes.
(1) New noteUtilityOutcome()/isUtilityUsable() -- real-interaction usability tracking (in-
memory, resets on restart) for crafting_table/furnace/chest, wired into the smelt/craft/loot/
store call sites that already produce the relevant reach/open/obstruction failures. Root cause
of the actual bug: index.js's builderPriorityCandidates()/builderPriorityItemSatisfied() used
to call countNearHome() -- bare block existence, never reachability -- so the Builder checklist
called chest/furnace storage "done" forever the moment one existed near home, even after real
chests sat failing "No path to the goal!"/windowOpen timeouts for a full day. This file only
supplies the tracking primitives and the call-site hooks; index.js's countUsableNearHome() is
what actually plugs them into the checklist.
(2) findShelterSite() takes a new maxRadius parameter (default 4, so any 2-arg caller/existing
unit test is unaffected) and rings outward (SHELTER_SITE_SEARCH_RINGS) instead of a single
fixed 4-block scan -- direct request, "allow the shelter search radius to go up to 48 blocks."
Up to BOT_USERNAMES.size individual shelters need room near home; the old fixed radius ran out
of space once the crafting table/furnace/chest/earlier shelters crowded that tight core, and
site-finding then failed forever, correctly, given the radius it was allowed to search. index.js
2.122.0 has the matching findShelterNearHome() fix this absolutely needs alongside it -- see
that file's own header for why.
(3) findRememberedLocation() is now exported (index.js's bedStep() needs it for (4) below), and
the "sleep" action falls back to it when nearbyBeds() comes up empty, same local-then-remembered
pattern mine/craft already use for crafting_table/furnace -- direct request, "seeking out a bed
should not be limited to 'nearby'... if it's a known resource that can be reached, they should
use it to sleep."
(4) place_bed's existing action.near plumbing (added for the communal shelter) is now also used
by index.js's bedStep() to build on the spot when far from home -- no change needed in this
file beyond what already existed.

1.93.0 (2026-10-22, direct request, generalizing S42's fix): new "patch_shelter" case -- fills
a given list of hole positions (shelter.js's shelterRoomsNear()/holesIn() already found them
against the real structure, whatever its actual shape) with plain building material. Door-free
by construction (holesIn() excludes doorway cells), so unlike "build"/"build_communal_shelter"
this never crafts or places a door, and never computes its own position list -- it patches
exactly what it's told is missing, which is what makes it work on a shelter of any shape or
size instead of only the two hand-coded geometries those two cases still build from scratch.

1.92.0 (2026-10-22, investigation: attack_win_rate regressed 0.846 baseline -> 0.099):
root-caused to Luke/Mark (Soldiers, SELF_DEFENSE_RANGE=20, never flee) repeatedly committing
to a 90s ACTION_TIMEOUT_MS attack against a target their pathfinder could never route to --
5,901 and 1,718 noPath results in 24h respectively, vs. 298-832 for the other three bots,
almost certainly the 2026-10-08 fresh-world terrain change. "attack" now tracks path_update
during the fight and bails with a new, honest "couldn't reach it -- no path through." outcome
after NOPATH_BURST_THRESHOLD (4) noPath results within NOPATH_BURST_WINDOW_MS (3000ms) --
same shape index.js's own dig_error burst detector already uses. Deliberately excluded from
tests/baseline.mjs's attack_win_rate loss count, same reasoning as the existing "broke off the
fight" exclusion: never a real fight to begin with. New
unreachable_target_bailouts_per_bot_day metric tracks it instead.

1.91.0 (2026-10-18, direct request): bed claiming removed entirely -- "any bed not already
occupied," trying the next one until she finds one free (no more priority-banded "her own
claimed bed, then unclaimed, then others' as a last resort" candidate list, and no more
claim-write on success). "sleep" and nearbyBeds() simplified accordingly; the whole
loadClaimedBed/saveClaimedBed/checkClaimedBed/BED_CLAIMS_AGENT subsystem is gone (index.js's
three "home" lookups that preferred it now just use bot.spawnPoint, same as everywhere else).
Separately, findBedSites() now always prefers a site inside an existing, qualifying shelter
(shelterInteriorsNear, shelter.js 1.2.0 -- any shape/size, no openings but doors, walls any
material but sand) when one nearby has room, falling through to today's nearest/under-a-roof
scoring only when no such shelter is found.

1.90.0 (2026-10-13, direct report after a full fleet reset: "combat seems better, but
building and tooling do not"). Two real, live-confirmed bugs:
- "mine"'s chest short-circuit treated ANY chest match -- even a PARTIAL one -- as fully
  satisfying the request, skipping the real mining fallback for the shortfall entirely. Babs
  looped 20+ minutes on "found 1 ... already in a chest, no need to mine it" (wanted more)
  into a craft that needed the full count and failed every time. Now takes whatever a chest
  has and mines the rest herself; the final message credits both when it took a partial match.
- "place_bed" had no memory of a spot the SERVER refused across separate goal ticks (only
  within one call, via `tried`, which resets to [] every call) -- Mayor retried the identical
  "Server refused to place ... the block is still air" spot every single tick for 20+ minutes
  straight. New refusedBedSpots, TTL'd the same way the existing chestMisses cache handles an
  empty chest search, excludes a proven-dead spot until it's worth trying again later.

1.89.0 (2026-10-12, PRIORITIES_PROPOSAL.md Tier 2 item 1a -- the communal shelter, sized per
the operator's own rule: "large enough for beds to suit all active bots... at least N+1 for N
bots"). New isCommunalShelterMaterial() (stone or better -- no planks/dirt, stricter than the
individual-shelter baseline isShelterMaterial()); new communalRoomCells()/
communalDoorwayPosition()/communalShelterPositions()/findCommunalShelterSite(), parameterized
(width/depth) mirrors of the individual shelter's own fixed-size geometry functions -- a
deliberate second set of functions, not a shared parametric refactor of the proven originals.
New "build_communal_shelter" case, same door-first-craft/wall-loop/door-last-placement shape as
"build" (see its own header for the two real bugs that order fixes), just the bigger geometry
and stricter material. No bed positions pre-planned: the room is sized generously and
findBedSites() fills it, called once per target bed by index.js's own runner. "place_bed"
gained an optional action.near (same shape as "store"'s) so a bed meant for the communal room
doesn't scatter wherever findBedSites' generic "nearest covered spot near home" prefers instead.

1.88.0 (2026-10-11, PRIORITIES_PROPOSAL.md §2a -- "arbitrate which Soldier holds which
sub-role the same way bed claims are already arbitrated"). New holdsGuardAnchor(), same
shared-agent_state-plus-per-host-fallback shape as BED_CLAIMS_AGENT/BUILDER_CLAIMS_AGENT, but
ONE row ({holder, claimedAt}), not one per bot -- there's a single anchor slot to contend for.
index.js's isLiveSoldier() callback decides what "still a live Soldier" means (this file has
no view of the fleet roster or who's connected); holdsGuardAnchor() only handles the shared
claim mechanics.

1.87.0 (2026-10-11, PRIORITIES_PROPOSAL.md Tier 2 item 2 -- "a bot about to make any of
these checks shared world-memory... not just her own immediate 32-block view"). "craft"'s
REUSABLE_UTILITY_BLOCKS short-circuit (2026-09-08, crafting_table/furnace) extended with the
same findRememberedLocation() fallback its own tableWouldHelp workbench search already has --
a table or furnace outside her current 32-block view, or one she saw earlier and wandered
away from, is exactly as worth remembering as a resource vein. Chest deliberately left out:
unlike a table or furnace, a full chest is a real reason to want a second one.

1.86.0 (2026-10-11, PRIORITIES_PROPOSAL.md Tier 2 PR2 -- "reuse the bed-claim mechanism... for
a short-lived claim on 'I'm working builder-priority item X'"). New claimBuilderItem()/
myBuilderClaim()/releaseBuilderItem(), same shape as BED_CLAIMS_AGENT below -- a shared
hermes-memory agent_state row per bot, the same per-host fallback file and MC_*_SHARED escape
hatch -- so index.js can de-exclusive its Tier 2 infrastructure checklist (any idle bot, not
just Builder-primary) without two idle bots converging on the same unmet item. Unlike a bed
claim, short-lived: staleness (BUILDER_CLAIM_TTL_MS) is checked against `claimedAt` on read,
since the store itself has no per-row expiry, so a bot claiming an item and then dying,
getting stuck, or disconnecting doesn't block the fleet's infrastructure forever.

1.85.0 (2026-10-11, direct report: "a shelter is defined as having complete walls, ceiling,
floor, and at least one door (not an opening or arch), with no other openings...") -- the
doorway used to be a bare, permanent gap: shelterPositions() excluded all three of its
wall-height cells from the fill, and nothing ever placed anything there. Now only the two
door-height cells are left open (doorwayPosition()); the lintel rejoins the wall fill, and the
floor under the room joins shelterPositions() too (never checked before this at all). "build"
crafts a door (any species, needs a table -- 1.83.1's own fixed check already finds/makes one)
and places it -- but ONLY after the generic wall/roof/floor loop, confirmed live after two real
bugs: getting the door ITEM has to happen FIRST (oak_planks counts as ordinary shelter material
too, so the generic loop spent every plank on walls before the door, which has no substitute,
ever got a turn), while PLACING the door block has to happen LAST (placed into open air before
any neighbouring wall existed, it came out facing east/west instead of north/south, and
doorPassageSides() then protected the wrong, wall-adjacent cells as "the way through" it,
refusing every wall next to the doorway). No connection to a cave system needed its own check:
once every wall/roof/floor cell is solid and the one opening holds a real door, nothing else is
left for a cave to connect through.

Found live the same day: with the room still 2x2, a real door and a bed could never both fit --
findBedSites()'s nearDoor() exclusion, correctly applied now that a real door exists, rules out
the only row deep enough to reach, and the room was too narrow for a "stand" cell outside its
own footprint. Fixed by widening the room to 2x3 (SHELTER_ROOM's own header comment above has
the full account): the bed now lives in the two rows farthest from the door, with the new row
at the door free to be her stand-cell.

1.84.0 (2026-10-10, direct report: bots "give up on constructed goals without seeming to
attempt to get the raw materials they lack") -- "get_wool" only ever checked bot.entities
within 32 blocks of wherever she already stood, breaking immediately if that came up empty.
Confirmed live: Mayor's bed goal failed 3 times in a row, ~45s apart, an identical ms=0 "no
sheep nearby" each time, never once walking anywhere to actually look -- unlike "mine"/
"explore," which already wander on an empty local search. New wanderAndRetryForSheep(): a few
random short hops (wanderAndRetryFind()'s own block-beacon approach doesn't apply to a live,
moving entity that isn't tracked at all until she's already near it), re-checking after each.

1.83.1 (2026-10-09, first live run of 1.83.0 below) -- that fix's own tableWouldHelp check,
"!noTableRecipes.length && ...", was still wrong for any item with more than one path to it: a
colored bed has a real no-table RECYCLING recipe (dye + a different-colour bed) alongside its
real wool+planks shaped recipe, which DOES need a table. Confirmed live: "craft red_bed" from
wool+planks failed in ~150ms, the same instant-failure signature 1.83.0 was meant to fix,
because the mere existence of that unrelated, unusable no-table recipe made noTableRecipes
non-empty, so the table search was skipped anyway. The real question is whether a table
unlocks MORE recipes than she has without one ("withTableRecipes.length > noTableRecipes.
length"), not whether every recipe happens to need one.

1.83.0 (2026-10-09, direct report: bots "repeatedly complain about crafting tables" without
ever trying to make one, noticing two standing right next to them, or remembering either's
location) -- "craft"'s own tableWouldHelp check used recipesFor(), which filters to recipes she
can afford with her CURRENT inventory. With zero planks/sticks on hand (the ordinary state
before her first trip for wood) that lookup comes back empty whether or not a table is
involved, so tableWouldHelp was always false and the entire table search/remember/auto-make-
and-place block below it never ran -- confirmed live, Nell's "craft wooden_pickaxe" failed in
78ms, far too fast to have searched or pathfound anywhere, straight into craftItem()'s own
generic "don't have the ingredients (might need a crafting table)" guess. Switched to
recipesAll() (the same call craftItem's own fallback chain, and ensureBoat, already use for
exactly this), which answers the real, inventory-independent question instead.

1.82.0 (2026-10-07, found by the new torch-trail live scenario failing on its first step) --
craftItem's auto-chain read only `recipe.ingredients`, which minecraft-data populates for
SHAPELESS recipes alone; a torch, a stick and a crafting table are all shaped, so the chain
could never fire for any of them. Now reads `recipe.delta`, which both shapes carry. This is
also the real reason checkHomeLighting's "craft from any wood source" gate never worked, three
fixes in -- see recipeInputs()'s own header.

1.81.0 (2026-10-07, direct request: access and shelters) -- a placement is refused when it
would impede access to a chest, bed or door, or seal a shelter's doorway: "place",
"place_bed", "build", "build_pen" and "repair_terrain" all ask shelter.js's wouldBlockAccess
first. New "clear_access" verb destroys a block that already impedes one. "mine" skips a target
that is part of a living space's wall. bedHalves/chestHalves moved to shelter.js, which owns
the geometry all of the above share.

1.80.0 (2026-10-07, found investigating a fleet-health Critical from spark-2's
store_failure_rate regressing to 1.0): logged the one silent candidate-skip left in the
"store" chest loop (blockAt() returning nothing), closing the gap the 2026-09-09 fix left
open for the other two candidates. spark-2's actual regression traced to something else
entirely (its storage cluster genuinely full/obstructed, not a code bug) -- this was a
pre-existing diagnosability gap found along the way, not the fix for that regression.

1.79.0 (2026-09-27, "a shelter is not enough if it can't fit at least one bed"): the shelter is
4x4 outside with a 2x2 inside (was 3x3 with one cell) -- a bed fits along one side, entered from
the doorway, with room to stand beside it. findShelterSite also needs a walkable approach to the
doorway, and place_bed prefers a spot under a roof, so the first bed goes in the shelter.

1.78.0 (2026-09-26) -- place_bed skips spots with a bot or mob standing in them (the server
refuses those; the fleet crowds around spawn) and tries up to 4 spots instead of retrying one.
findBedSites returns every usable spot, best first.

1.77.0 (2026-09-26) -- shelters: build takes a site (action.at), mixes any plain building blocks
(isShelterMaterial -- never sand/gravel or functional blocks), counts only what's missing, and says
whether the result passes the 80% shelter check. New findShelterSite / shelterPositions.

1.76.0 (2026-09-26) -- craft makes and places a crafting table when none is around. Beds ("I don't think the bots know how to build a bed"): craft "bed" picks
the colour she has wool for; loot takes "wool"; new get_wool (shear, or hunt a sheep, and pick up
the drop) and place_bed (two free cells near home, facing the right way, checked it appeared).

1.75.0 (2026-09-25) -- harvest replants, after picking up the drops, any spot it had no seed for
(a harvest of someone else's farm replanted nothing).

1.74.0 (2026-09-25) -- first live hour: harvest says which ripe crop it couldn't reach or break,
and only walks over drops after it actually harvested something.

1.73.0 (2026-09-25) -- farming and ranching, from a day of logs (0 farm/ranch steps, 4,203 failed
"eat"s). loot takes groups ("food", "seeds"); harvest builds a real plot (next to water, clears
plants on top, checks each block turned to farmland and each seed took), can harvest only ripe
crops, and reports what it did; build_pen takes a site; breed can stay at the pen and checks a
baby actually appeared; herd_to_pen waits for the animal and holds the gate only while leading; pens
are 7x7. Verified achievements (harvested:/penned:/bred:) are recorded per bot for
the Mayor's curriculum. A failed OUTCOME line now says why.

1.72.0 (2026-09-25) -- herd_to_pen holds doors open (swim-movements.js holdDoorsOpen) so the door
closer doesn't shut the pen gate on the animal being led in.

1.71.0 (2026-09-25) -- bed claims are shared between hosts through hermes-memory agent_state
("minecraft-beds"); BEDS_DIR is the per-host fallback, and a host's existing claim is published
on its first read. MC_BED_CLAIMS_SHARED=false keeps claims per host.

1.70.0 (2026-09-25) -- beds: a destroyed claimed bed is replaced with the nearest unclaimed bed
(new exported checkClaimedBed, also settling two bots on one bed by name order). Sleep tries one
candidate per bed (not per half), unclaimed before other bots' beds, and never claims another's.

1.69.0 (2026-09-25) -- HOSTILE_MOBS exported for index.js's fight-or-flee policy.

1.68.0 (2026-09-25) -- test isolation: beds/pen/known-chests paths honor MC_MEMORY_ROOT.

1.67.0 (2026-09-24) -- review follow-up, closing the remaining gaps. MB-02: flee runs on
its own Movements copy and restores the shared one only if its copy is still active. MB-08: new
"place_home" action (gohome, then place, one token). MB-18: performAction logs one structured
OUTCOME line per action. Redundancy: an empty chest search isn't repeated from the same spot
within 60s, and refreshGear skips when no gear-relevant state changed.

1.66.0 (2026-09-24) -- review remediation, tier 4 (docs/reviews/2026-09-24-minecraft-bots-review.md).
MB-15: raw fish/meat are edible (ranked after cooked food; golden apples last) and SMELT_RECIPES
can cook them, closing the fishing-for-food loop. MB-16: EXPLORE no longer "succeeds" by
withdrawing chest stock; EXPLORE <feature> scouts for SCOUT_FEATURE_BLOCKS and succeeds only when
the feature is actually found. MB-17: chest withdrawal spans mixed item types (oak + birch logs)
instead of asking one type for the family total, and always closes the window.

1.65.0 (2026-09-24) -- review remediation (docs/reviews/2026-09-24-minecraft-bots-review.md).
MB-01: "attack" actually starts combat again -- 1.42.0's polling rewrite dropped the
bot.pvp.attack() call itself, so every fight since 2026-09-10 only waited out its timer; a kill
is now claimed only on this target's entityDead. MB-02: performAction() takes the caller's
arbiter handle and refuses a handle that lost control (or a handle-less call while someone else
owns the body) instead of borrowing the current owner's token; finally-block cleanup
(setGoal(null), refreshGear) only runs while the caller still owns control. MB-04: any result
produced after cancellation is reported { ok: false, cancelled: true } rather than ok(...).
MB-08: "gohome" joins SKILL_ACTION_VERBS.

1.64.0 (2026-09-21) -- direct request: "re-evaluate the entire defense scheme," root-caused
from a live mass-death incident (5 bots died within ~90 seconds). "attack" now accepts an
optional `action.maxDurationMs` (falls back to ACTION_TIMEOUT_MS unchanged for every existing
caller) so EMERGENCY-tier combat (index.js) can give a critically-hurt bot a short, bounded shot
instead of committing to the full 90s timeout with no way to reconsider -- confirmed live that a
single stuck emergency attack held the arbiter's HEALTH_CRITICAL tier for over 20 straight
seconds with nothing able to preempt it. See MINECRAFT_BOTS_DESIGN.md §52.

1.63.0 (2026-09-21) -- direct request: "I want real confirmation they can use the crafting
table and furnace." Investigating turned up a real, severe, already-live bug rather than just
confirming one: a 24h fleet-wide log sweep found ZERO successful smelts anywhere, every single
attempt failing "found furnaces nearby, but couldn't use any of them." Root cause confirmed via
this file's own per-furnace slot diagnostic logging (2026-09-07): the fleet's two real furnaces
were jammed with 63-64 coal_block already sitting in their fuel slots (the hard per-slot cap)
plus 16 iron_ingot stranded in one's output, uncollected -- "smelt" called putFuel()
UNCONDITIONALLY every attempt regardless of existing fuel, so once a slot maxed out, every
future call threw "destination full" and aborted the whole smelt before ever reaching putInput,
even though the furnace already had more than enough fuel to work with. Fixed: collects any
existing output first (recovers whatever was stranded), and treats a failed putFuel() as
"already has fuel" rather than fatal -- falls through to putInput using what's already there.
See MINECRAFT_BOTS_DESIGN.md §45.

1.62.0 (2026-09-21) -- direct live observation: "none of them fight back including the
soldiers... if the bots are inside a building with a zombie, they seem to act as if they are
trapped." Root-caused live during a 24h fleet review (~4,271 deaths, one bot a 408-death streak
in one spot): "flee" shares the same canDig-enabled Movements every other action uses; in an
enclosed room, the only path that increases distance from a threat can require digging through
a wall, and when that dig fails, pathfinder recomputes the IDENTICAL best-cost path and fails
again immediately -- confirmed live via path_reset: dig_error firing dozens of times a SECOND
with an unchanged nodes/cost signature, holding SELF_DEFENSE/EMERGENCY control the whole time
while she's still taking hits and (EMERGENCY-tier flee never attacks) never fighting back
either. Disabling digging for just this one pathfind now forces a real walkable escape or a
clean, fast failure instead of an infinite stuck loop. See MINECRAFT_BOTS_DESIGN.md §42.

1.61.0 (2026-09-19) -- direct follow-up: "the downgrade rejection must also reject if the
mayor's instructions would cause the quality of their equipment to be reduced." §40's own "give"
check only ever caught going from "has one" to "has none" -- giving away a diamond sword while a
wooden one stays behind is a downgrade too, even though she'd technically still have "a sword."
New GEAR_TIER_RANK (a single common-sense material ranking, not a precise armor-point/mining-
level simulation -- good enough to answer "worse than before") lets the same check also compare
the tier of what's being given against the best tier she'd be left holding in that category.
See MINECRAFT_BOTS_DESIGN.md §40 (updated).

1.60.0 (2026-09-19) -- direct request: "Mayor/Leader missions, if they would effectively
DOWNGRADE a bot's equipment or status, should be rejected by the bot." "give" (the concrete
gear-loss vector -- both a direct chat command and the autonomous checkPendingGiveRequests
fulfillment path route through this same case) never checked whether complying would leave the
giver without a weapon/armor/tool she still needs, whoever asked -- the exact mechanism behind
Mark being gifted a sword twice by teammates yet ending up swordless anyway (§34: he died
between the gifts, a separate cause, but this closes the OTHER real way that keeps happening --
a bot handing away her own last one on request). Now refuses (a clear fail(), not a silent
no-op) when giving would take the item's whole category from "has one" to "has none": sword/axe
treated as one interchangeable weapon category (matching equipment.js's own hasWeapon()),
armor/tool suffixes each their own. A genuine spare is always still fine to give. See
MINECRAFT_BOTS_DESIGN.md §40.

1.59.0 (2026-09-19) -- direct request: "expand their search capabilities further, especially the
miner and explorer roles." New env-tunable MINE_SEARCH_RADIUS/EXPLORE_SEARCH_RADIUS/
EXTENDED_SEARCH_DISTANCE (same per-bot-tuning pattern as MC_SELF_DEFENSE_RANGE, §21) replace
"mine"/"explore"'s own hardcoded 32-block scan radius -- Babs (Miner) and Wade (Explorer) now
search meaningfully farther via their own systemd units without touching the shared default for
everyone else. MINE/EXPLORE_SEARCH_RADIUS kept well under bot.pathfinder.searchRadius's own
documented 48-block OOM ceiling (this file's own established caution) since a found block gets
one unhopped collectBlock pathfind straight to it; EXTENDED_SEARCH_DISTANCE raised more freely
since wanderAndRetryFind's own walk there is already hop-capped regardless of beacon distance.
See MINECRAFT_BOTS_DESIGN.md §39.

1.58.0 (2026-09-18) -- direct request: "have the threatened bot run towards safety, run towards
golems, or soldiers." New nearestFriendlyGolem() (alongside nearestHostile()) and "flee" now
heads directly to an action.rallyPoint when index.js supplies one (via its own new
nearestRallyPoint() -- golem > nearby Soldier teammate > home) instead of only ever maximizing
distance from the threat with no destination in mind. See MINECRAFT_BOTS_DESIGN.md §37.

1.57.0 (2026-09-18) -- direct live report: "Luke is getting shot, not reacting. there is no mass
mob." Root-caused: Luke's self-defense held SELF_DEFENSE-tier control on an unproductive
"attack" against an enderman for over a minute (teleport-evasion defeats bot.pvp's chase-and-
melee the same way flight defeats it for phantom/ghast), silently blocking any response to a
SEPARATE skeleton sniping him the whole time. Confirmed not a one-off: Mark/Luke logged
2,800/1,770 enderman self-defense triggers in 24h, far above every other bot. FLEE_ONLY_MOBS
now includes "enderman" -- see its own updated header below for the full reasoning.

1.56.0 (2026-09-18) -- direct request: "if the bot is in need of a piece of equipment (sword,
armor, pickaxe, etc), and finds one already crafted in a chest, it should pick up ONE of those
pieces of that equipment and abandon the quest to craft it." The existing craft/loot
chest-substitution checks (2026-09-08/2026-09-17) already stopped a bot from crafting
something already sitting in a chest -- but only ever matched the EXACT item id the model
happened to name. A chest holding an iron_pickaxe was invisible to a "craft wooden_pickaxe"
check, so she'd craft (or keep looking for) the specific tier she'd guessed instead of
recognizing any real pickaxe as already satisfying the need. New gearCategoryNames() broadens
the search to every real tier sharing the same GEAR_SUFFIXES suffix, wired into both "craft"'s
own chest-check and "loot"'s local + remembered-chest matching -- raw materials are untouched
(an iron_ingot really is the one specific thing a recipe needs, no "any tier" concept applies).
"Abandon the quest" itself needed no new mechanism: the substituted item is now honestly
reported in the step result and her own gear/inventory snapshot on the next planNextStep tick,
so the existing DONE-recognition already closes the goal on its own -- the same real-world-
state-driven completion check this whole hallucination-detection system already relies on.

1.55.0 (2026-09-17) -- direct request: "if they craft armor or weapons or tools, they should
equip them." refreshGear()'s own comment ("a freshly-crafted tool/weapon/armor piece should get
equipped") turned out to only be half true -- equipBestArmor/equipBestWeapon cover armor and
sword/axe-class weapons, but pickaxe/shovel/hoe were never weapon-classed, so a freshly-crafted
mining/digging/farming tool just sat unequipped in inventory. The "craft" case now equips the
SPECIFIC item just crafted when it's one of those three, not a tier comparison against whatever
was already held -- she made it on purpose. This surfaced a real, independent gap in "attack":
nothing there ever re-equipped a weapon before engaging, only refreshGear() in the finally block
AFTER a fight ends -- meaning a bot could walk into combat holding whatever a prior action left
in hand (now more likely to be a tool). equipBestWeapon() now runs at the top of "attack" too,
so combat always starts weapon-in-hand regardless of what was held a moment before.

1.54.0 (2026-09-17) -- direct request: "when a bot opens a chest, they loot EVERYTHING instead
of what they need. They need to: take only the mats they need for their current objective; put
any leftovers... in a chest; all chest contents goes into world memory." The "loot" case used
to sweep every stack in a chest (capped at one per distinct tool, otherwise a full stack)
regardless of whether any of it was wanted -- a deliberate 2026-09-07 design choice ("this is a
curated sandbox server, not a real-survival dungeon") the operator is now explicitly reversing.
action.item (optional, matching MINE/CRAFT/SMELT's own <item_id> <count> shape -- see index.js's
own vocabulary/parser changes) makes it genuinely need-based: naming an item withdraws up to
<count> of exactly that one via tryTakeFromThisChest, the SAME helper "mine"/"craft"'s own
chest-first fallback already uses, so there's one implementation of "take up to N of X from a
chest," not two independently-drifting ones. Omitting the item (still valid, e.g. a bare
"ACTION LOOT" or a direct "check that chest" with nothing specific named) is now a pure
inspection -- opens the chest, snapshots its real contents into known_chests.json for the whole
fleet (§19/§27's chest registry was already correct and fleet-wide; this just stops the ONE
caller that used to also sweep it clean), takes nothing. "Put leftovers in a chest" needed no
new mechanism -- storeSurplusNearHome()/checkInventoryFull()/checkInventoryInsurance()
(index.js) already cover it generically; index.js's own post-craft cleanup trigger now also
fires after a targeted loot that actually withdrew something, for the same reason it already
fires after craft/smelt.

1.53.0 (2026-09-13) -- direct request: "rebalance the bots so they each have exactly one
role... create [more] so every role has at least one bot." OTHER_BOT_USERNAMES (this file's own
independent duplicate of index.js's BOT_USERNAMES roster, kept in sync rather than a shared
import per this file's own "index.js does the mutating" header) extended with the three new
bots (Nell, Wade, Dale) so their positions get the same proximity-avoidance treatment every
other bot's already gets. See MINECRAFT_BOTS_DESIGN.md §22.

1.52.0 (2026-09-13) -- direct request: "extend resource sharing memory and scouting to *any*
resource or crafted object. remember what is in chests when someone opens it. if someone takes
the item out of a chest, redact it from global memory. They need to OPEN doors not destroy
them as well." Four real changes:
(1) Doors/trapdoors/fence gates added to isProtectedBlockName() -- the list that actually
feeds movements.blocksCantBreak (index.js). canOpenDoors was already enabled (2026-09-07) but
nothing stopped pathfinder from falling back to digging through a door if that logic didn't
apply to a given move -- the same "diggable by the library's own definition" gap this list
already closed for furnaces/beds/chests, just never extended to the one block class the
operator specifically named.
(2) getResourceBlockNames(bot) replaces the old hand-picked EXPLORE_TARGET_NAMES (oak_log/
coal_ore/iron_ore/copper_ore) -- derived programmatically from this server's own real block
registry (every "_ore"/"_log"/"_stem" name, plus ancient_debris) so gold/diamond/redstone/
lapis/every other log species get the same shared-memory benefit those four always had.
(3) New known_chests.json registry (loadKnownChests/saveKnownChests/recordChestSnapshot/
findKnownChestWithItem): a structured, mutable, position-keyed store -- deliberately NOT the
fuzzy RAG-based world-memory notes used for resource locations elsewhere in this file, since a
chest's contents change every time anyone opens it and need real point-in-time overwrites, not
a growing pile of similar notes. Every real chest interaction (tryTakeFromNearbyChest, "loot,"
"store") now snapshots the chest's CURRENT contents right before closing it -- "remembering"
and "redacting" are the same operation (always writing the current truth) rather than two
separate features to keep in sync. tryTakeFromNearbyChest's own local-search loop was
refactored into a shared tryTakeFromThisChest() helper so a new remembered-chest fallback
(consulted when local search comes up empty, same "local first, remembered second" pattern
"mine" already uses) doesn't duplicate the open/withdraw/snapshot logic.
(4) "craft"'s own crafting-table search gained the same local-then-remembered fallback via
findRememberedLocation("crafting_table") -- a table someone else placed, or one this bot saw
earlier and wandered away from, is exactly as worth remembering as an iron vein.

1.51.0 (2026-09-12) -- direct report "a chest with sticks already made is ignored when they
need sticks," confirmed live: tryTakeFromNearbyChest() used to require ONE slot to
independently hold >= wantCount. A real, common deposit pattern (multiple bots each banking a
few via "inventory insurance," 2.39.0) easily splits the same item across several slots (e.g.
3+3+2 sticks from three separate deposits) -- .find() against a single-slot threshold matched
none of them even with plenty combined. Now sums every matching slot before deciding and takes
whatever's actually available (never more than wantCount, honestly reports less otherwise) --
chest.withdraw() itself already draws from multiple slots of the same item/metadata
automatically, so summing first was the only change needed.

1.50.0 (2026-09-11) -- direct request "fix ... the pen herding [and] the dynamic skill
library". (1) New "herd_to_pen" case: build_pen (1.49.0) only ever placed the fence structure,
never moved an animal into it -- a real, separate gap this file's own design doc flagged the
day it shipped. Reuses vanilla's own TemptGoal follow-behavior (the same food/BREEDING_FOOD
relationship "breed" already leans on) rather than inventing a new mechanic, walked in short
bounded hops so the animal's own AI can keep pace, with a real per-step distance check (not
assumed) for whether she's still following. New loadPenLocation()/savePenLocation() (build_pen
now persists its own gate+center on success, only once the gate specifically went in) so
herd_to_pen can find a pen built in an earlier goal/session. BREEDING_FOOD hoisted from
"breed"'s own case block to module scope so both verbs share one definition. (2)
SKILL_ACTION_VERBS gained harvest_hive/shear/milk/build_pen/herd_to_pen -- every verb built
this session had been left out of the skill-library's own allowlist entirely, meaning none of
them could ever be compressed into a reusable skill despite being self-contained the same way
breed/harvest already are. repair_terrain deliberately still excluded, same reasoning as
gohome/recover's own existing exclusion (see that comment) -- its position is a live-discovered
pit a stored skill has no way to reconstruct.

1.49.0 (2026-09-11) -- direct follow-up ("what's next" -> "2", closing §15.11's remaining
Herder/pen gaps rather than deploying yet). New "shear" (sheep -> wool) and "milk" (cow ->
milk_bucket) cases -- both bot.activateEntity() while holding the right tool, the same
generic right-click primitive "breed" already uses to feed an animal, no dedicated API for
either. Neither pre-checks "already sheared"/cooldown state (mineflayer's own entity-metadata
index for that isn't confirmed stable across versions) -- just tries, same discipline "breed"
already applies to a cooldown it also doesn't pre-check. New "build_pen" case: one fixed 5x5
fence-perimeter-plus-gate shape, same "small fixed shape, not a general planner" philosophy as
"build"'s own shelter -- closes the design doc's own pen/fence `[UNKNOWN]`, resolved in favor
of a dedicated verb (not folded into "build"'s existing vocabulary) since a pen's shape
(fence blocks, open top, a gate) doesn't share geometry with a shelter's (solid walls, a roof).

1.48.0 (2026-09-11) -- direct follow-up ("nest" again -> "honeycomb via shears too"):
"harvest_hive" (1.47.0) now takes action.tool -- "bottle" (default, honey, never angers the
bees at full honey_level) or "shears" (honeycomb, always angers them, but the only real path
to enough honeycomb to ever craft a NEW beehive -- "craft"/"place" were both already fully
generic against bot.registry/bot.recipesFor and needed zero changes to handle a beehive once
the ingredient exists). The tradeoff is exposed explicitly, not hidden behind a single
"best" choice -- a caller who specifically needs honeycomb accepts the risk on purpose.

1.47.0 (2026-09-11) -- direct follow-up ("nest" -> "bee nests/hives"): new "harvest_hive" case,
closing part of §15.11's Herder capability gap (pen/fence containment for other animals is
still open -- this is scoped to bees). Collects honey via bot.activateBlock() while holding a
glass bottle against a full (honey_level >= 5) beehive/bee_nest -- deliberately never shears
(honeycomb), since a bottle harvest at full level doesn't anger the bees the way shearing
always does. Also added "bee" to the existing "breed" case's own BREEDING_FOOD map (any common
flower item, matching real vanilla bee-breeding mechanics) -- bees were breedable with zero new
code before this, just an unlisted species.

1.46.0 (2026-09-11) -- direct request: "start building" the rest of MINECRAFT_BOTS_DESIGN.md
§15.10 (Builder/Artist terrain repair -- "pits should be filled to level ground with the most
appropriate material, mostly determined by matching the nearby ground blocks, but also guided
by function -- plants cannot be placed in stone"). New "repair_terrain" case: fills ONE column
(bottom-up, same "each new block references an already-placed block below it" ordering "build"
above already established, for the same reason) at a position index.js's new
checkTerrainDamage() supplies -- this file does the FILLING, not the scanning/detection, same
division of labor as "light_area" (index.js finds dark spots, this file lights them). Material:
an explicit action.material override (checkTerrainDamage sets this to "dirt" specifically when
plantable ground -- grass_block/dirt -- is found among the pit's own rim neighbors, the
function-over-appearance case from the design doc) takes precedence over sampling the
neighborhood's most common solid block, the "match nearby ground" default case.

1.45.0 (2026-09-11) -- direct request: "if one bot is looking for a specific resource, it
should look near itself (current understanding added to global world memory), ask the other
bots to look near themselves (they add/update world memory too), then use global world memory
to gather a resource if it's not in its own immediate vicinity." This file's own half: "mine"
now tries a remembered position (new findRememberedLocation(), parsing the existing
"near (x, y, z)" note format explore's own success note already used) between its local
findBlocks() and the existing blind wanderAndRetryFind() fallback -- cheap (one RAG query, no
movement) and, on a hit, a direct trip instead of a directionless search; a stale/wrong note
just falls through to the unchanged wander fallback. EXPLORE_TARGET_NAMES hoisted to module
scope and exported so index.js's new noteNearbyResources() (the "look near itself"/"ask the
fleet" half, and the new "scout" Buzz payload) scans the exact same curated resource list
"explore" already does, not a second independently-drifting one.

1.44.0 (2026-09-10) -- direct live follow-up to 1.43.0's own detection fix, same report
("they don't seem to be able to fight, or run from, phantoms"): fixing detection alone wasn't
enough. Confirmed live, unambiguously: once self-defense could finally SEE a phantom, its
"attack" choice held SELF_DEFENSE-tier arbiter control for the full 90s ACTION_TIMEOUT_MS
ceiling every single time, because a ground-bound bot's pathfinder can never actually close to
melee range against something flying overhead -- during that entire 90s span, every other
self-defense re-trigger, squad response, and recovery attempt correctly reported "yielded to
something more urgent (SELF_DEFENSE)," repeating every time the doomed chase re-triggered.
That's exactly what "can't fight or run" looks like live. New FLEE_ONLY_MOBS (phantom, ghast --
both flyers) always flees, never melee-attacks, regardless of health; fleeing doesn't need to
reach the target and was already confirmed live to genuinely create real distance every cycle.

1.43.0 (2026-09-10) -- direct live report: "they don't seem to be able to fight, or run
from, phantoms." Real bug, confirmed against minecraft-data's own entity registry directly:
nearestHostile()'s "hostile" type requirement (added in 1.42.0's own predecessor fix) is wrong
for phantom, ghast, slime, and shulker -- all four carry entity.type "mob", not "hostile",
despite minecraft-data's own separate "category" field correctly listing all four as "Hostile
mobs." Self-defense/checkSleepingThreat/"attack"/"flee" targeting never even saw a nearby
phantom as a threat at all -- a silent detection failure, not a combat or targeting bug. The
"hostile" type check added no real safety on top of the already-curated HOSTILE_MOBS name
allowlist (nothing outside that deliberate list was ever going to match by name); it only
excluded entries whose real type field happens to disagree with minecraft-data's own category
field. HOSTILE_MOBS.has(e.name) alone is now the sole condition.

1.42.0 (2026-09-10) -- direct live report: "they're still not fighting back or running."
Real bug, confirmed by reading the actually-installed mineflayer-pvp 1.3.2 source directly
(lib/PVP.js): "attack"'s own long-standing comment claiming bot.pvp.attack() "resolves its own
promise once the target is dead or lost" was simply wrong for this version -- it only sets up
the chase (this.target + a fresh pathfinder GoalFollow) and returns almost immediately; combat
itself runs forever off the library's own internal physicTick listener, independent of that
promise. Every checkSelfDefense cycle (2s) was therefore reporting "took care of it" the
instant the chase was merely STARTED, and since arbiter.js's cancelPhysical() unconditionally
calls bot.pvp.stop() at the top of every requestControl() acquisition (even a same-owner,
same-target reacquisition), the next 2s tick kept restarting the same chase from scratch before
it ever had time to close distance or land a hit -- confirmed live: Mark and Luke both reported
"took care of it" against the same still-alive zombie_villager every single tick for 20+
seconds with zero health change on either side, visually indistinguishable from not responding
at all.

A first fix attempt (waiting on the library's own 'stoppedAttacking' event instead) was ALSO
wrong, confirmed live a second time against Luke fighting a creeper: that event fires for ANY
stop() call, including cancelPhysical()'s own fire-and-forget bot.pvp.stop() -- called at the
top of the VERY SAME requestControl() acquisition that's about to start this fight. That call's
own cleanup was still asynchronously in flight (it awaits the pathfinder's own internal
'path_stop' event before it finishes) when this fight's fresh listener attached moments later,
so its stale, unrelated emission was mistaken for "the fight just ended" -- reproducing the
exact same instant-"took care of it" symptom via a different mechanism.

The actual fix: poll the target's own real, unambiguous state (is it still a tracked entity at
all, i.e. bot.entities[target.id]) instead of inferring anything from a shared/ambiguous event
-- the same "check the real thing directly" approach every OTHER cancellable action in this
file already uses (token.cancelled checked against real pathfinder/collectBlock rejection,
never guessed at from an event). Also aborts promptly on a genuine higher-priority preemption
(token.cancelled) rather than only on the full ACTION_TIMEOUT_MS ceiling. This also
structurally fixes the restart-loop as a side effect: checkSelfDefense's own performAction()
call (and its selfDefenseInFlight guard) now correctly blocks for the fight's real duration
instead of returning after ~0ms.

1.41.0 (2026-09-10) -- Phase 2 follow-up, real bug caught live while migrating the first
reflex handler (checkSelfDefense, index.js 2.50.0): performAction()'s own stopCurrent() call
was unconditionally cancelling-and-rotating on EVERY call, which would immediately stomp a
caller's own just-acquired arbiter.requestControl() handle (marking its token cancelled,
rotating `current` out from under it) the instant that caller went on to call performAction()
itself. stopCurrent() now reuses the already-current token when one exists (arbiter.isBusy())
instead of rotating a new one; performAction() itself now releases that token in a finally
block, but ONLY when IT was the one that acquired it (tracked via `alreadyHeld`, checked before
stopCurrent() runs) -- a caller that already held a handle before calling in still owns release
via its own handle.release(), untouched by this. Without this, arbiter.isBusy() would report
true forever after the very first action any bot ever ran (nothing releasing on behalf of the
many not-yet-migrated callers), permanently disabling stopCurrent()'s own
cancel-before-every-new-action behavior for every action after that one.

1.40.0 (2026-09-10) -- Phase 1 of the approved per-bot coherence arbiter plan (see
arbiter.js's own header for the full account). stopCurrent()'s real body moved to arbiter.js's
cancelAndRotate() -- this function is now a one-line delegate. Zero behavior change in this
phase: nothing yet calls arbiter.requestControl() ahead of a performAction() call, so every
action still unconditionally cancels-and-rotates exactly as before.

1.39.0 (2026-09-10) -- direct request: "fix the lighting logic," following a confirmed live
incident (1260+ deaths in ~26h, root-caused live: the shared base sat pitch dark at ground
level with an uncapped nightly mob buildup -- dozens of hostiles counted within 80 blocks at
once, well beyond what a single bot's one-threat-at-a-time self-defense could ever survive).
New "light_area" action -- a real area sweep (bounded batch, LIGHT_AREA_RADIUS=10,
LIGHT_AREA_BATCH_LIMIT=6) around a real anchor point (action.near), not the existing "place a
torch wherever I happen to be standing" reflex (index.js's checkLighting, unchanged). Finds
dark (light < DARK_LIGHT_LEVEL, now exported here rather than duplicated in index.js),
mob-spawn-capable spots (solid ground below, non-functional-block below per
isProtectedBlockName -- never torch on top of someone's chest/furnace/bed) via the same live
findBlocks() function-matcher pattern plant_sapling/findNearestShore already use, paths to
each, places a torch. Re-checks each spot's light level immediately before placing (another
bot, or an earlier step in this same sweep, may have already lit it) so the whole fleet
converges on "fully lit" without needing explicit coordination.

1.38.0 (2026-09-09) -- follow-up to 1.37.0's own deposit-failure logging: watched it live and
the one real failure that occurred ("found chests nearby, but couldn't store anything in any
of them") showed NO deposit-failure log line at all -- meaning every candidate was actually
being skipped at chestObstructed() or the pathfinder-unreachable catch instead, both exactly as
silent as the deposit failure was before 1.37.0. Same fix applied to both.

1.37.0 (2026-09-09) -- real live gap found watching the new post-craft cleanup
(storeSurplusNearHome, index.js 2.47.0) fire: it failed twice, live, both times with
"found chests nearby, but couldn't store anything in any of them" and zero visibility into
why -- "store"'s own per-candidate deposit failure was silently swallowed (`catch { continue }`,
no log), the exact same gap "sleep" already found and fixed once before (2026-09-07) for its
own multi-candidate loop, never applied here. Now logged per candidate.

1.36.0 (2026-09-09) -- direct request: "'near a building' is defined as 6 blocks."
nearBuilding()'s own radius (a guess of 3 until now) is now exactly 6.

1.35.0 (2026-09-09) -- follow-up live findings on "plant_sapling" (1.33.0/1.34.0), both from
the SAME 25-minute post-deploy watch: (1) Luke and Mayor failed to find ANY spot to plant,
every single retry, for the entire window -- rule 2 only ever checked within a fixed 32 blocks
of wherever the bot currently stood, with no fallback (unlike "mine"/"store"/harvest's own
till-from-scratch fallback, all of which already reach for wanderAndRetryFind() when a local
search comes up empty). Near a base this is a real, expected failure mode: most nearby open
ground legitimately IS "near a building" by design, since that's the whole point of a base --
this needed the same directed-wander capability every other search-based action already has to
reach open ground beyond the immediate settled area. Now wired in. (2) A real placement
failure ("Server refused to place dark_oak_sapling ... the block is still dark_oak_sapling")
traced to the "air above" check being too loose -- `boundingBox !== "block"` also accepts a
spot where a sapling/tall-grass/flower is ALREADY growing (none of those are "block" either),
so a target could get picked that wasn't actually plantable. Both findPlantableSpotNear() and
rule 2's own matcher now require real `name === "air"` instead.

1.34.0 (2026-09-09) -- two changes shipped together. (1) Fixed a real live crash in
"plant_sapling" (1.33.0), found minutes after it first deployed: rule 2's own findBlocks()
matcher read block.position without guarding it first, and a matcher candidate can have a null
.position despite the block itself being non-null -- the exact same mineflayer edge case
findNearestShore() (index.js) already found and guarded against once before. Repeated on every
SAPLING_CHECK_MS tick for any bot carrying a sapling ("sapling check failed: Cannot read
properties of null (reading 'offset')") until fixed. (2) Direct request: "after any crafting
activity, surplus materials should be stored in a chest as close to their sleeping home as
possible." "store" now accepts an optional action.near ({x,y,z}) -- when given, searches for a
chest FROM that point instead of the bot's own current position (confirmed against mineflayer's
own findBlocks() source: `point` is the real reference every result is sorted by distance to).
loadClaimedBed() exported so index.js's new storeSurplusNearHome() can pass the bot's own real
claimed bed position as `near`, reusing "sleep"'s own notion of home rather than inventing a
second one. Every existing "store" caller (checkInventoryFull/Insurance) omits `near` and keeps
the original "nearest to wherever I am right now" behavior, which is what those actually want.

1.33.0 (2026-09-09) -- direct request: "when they find saplings, they should plant them (1)
near other trees of the same variety if they can (2) in any free soil not directly adjacent
to a building if they can't." New "plant_sapling" action (index.js's new checkSaplings() idle-
tick check is the one caller -- a reflex, not something a player/planner asks for). Rule 1
searches for an existing tree of the SAME species (action.item's own "_sapling" -> "_log"
mapping) and plants near it (findPlantableSpotNear(), a small ground-surface scan skipping the
trunk itself); rule 2 falls back to any grass/dirt with clear air above that isn't near a
"building" -- no real in-game flag for that, so looksLikeBuilding()/nearBuilding() use a
practical heuristic (any functional/crafted block via the existing isProtectedBlockName(), or
a common hand-placed construction material) rather than an exact detector. Bounded batch
(SAPLING_PLANT_BATCH_LIMIT=4) so a bot carrying a big stack of saplings doesn't turn one
action call into an unbounded planting spree.

1.32.0 (2026-09-08) -- direct request: "before they dig or destroy a block, they should make
sure it is not a functional block like a bed or a furnace, a book[shelf], a table, or any
other form of crafted item or block." New PROTECTED_BLOCK_NAMES/isProtectedBlockName()
(exported for index.js's pathfinder Movements setup to reuse): "mine" now refuses to
deliberately target one (resolveBlockFamily()'s own raw single-name fallback would otherwise
happily resolve "furnace" or "crafting_table" like any other real block name). The other,
bigger half of this -- a bot's pathfinder auto-digging through one incidentally while routing
around an obstacle -- is closed in index.js instead, since that's mineflayer-pathfinder's own
Movements config, not an actions.js concern.

1.31.0 (2026-09-08) -- item #4 of "fix all the above" (bed ownership). "sleep" re-ran the same
"nearest 3 beds" search every night with no memory of what worked before -- on a shared map
with fewer beds than bots, several bots would converge on the same nearest bed the same night
(bot.sleep()'s own real "occupied" rejection already caught that safely, just wasting a
travel-then-fail cycle for whoever lost). New loadClaimedBed()/saveClaimedBed() (a small
per-bot file under BEDS_DIR, same hermes-data-mount pattern skills.js's SKILLS_DIR already
uses) persist whichever bed actually worked last time and try it FIRST, ahead of the normal
broad search -- a bot with a working bed stops competing for "nearest" every night and just
goes home, falling back to the broad candidate list only if her own bed is gone, occupied, or
unreachable.

1.30.0 (2026-09-08) -- item #3 of "fix all the above" (farming from scratch). "harvest" could
only ever work a field that already existed (pick what's ripe, replant it) -- with nothing
planted anywhere nearby it just failed outright, no path to ever bootstrap a farm at all. New
fallback when no mature crop is found: till nearby dirt/grass_block (air above, real vanilla
tilling has no dedicated mineflayer API -- bot.activateBlock() with a hoe equipped is the same
"simulate a real client interaction" primitive already the right tool for this) and plant
whatever seed she's carrying, bounded to HARVEST_BATCH_LIMIT tiles same as the existing harvest
loop. index.js's own HARVEST description (classifyIntent and the goal-step planner, both) is
updated to mention this so the planner knows "harvest" now covers starting a farm too, not just
working an existing one -- one verb, not a second one to teach the planner from scratch.

1.29.0 (2026-09-08) -- item #2 of "fix all the above" (cross-bot resource contention). New
filterAwayFromOtherBots(), applied in "mine" and "explore": other known bots are ordinary
named players from this bot's own point of view, so their live position needs no Buzz message
to check -- filters out candidate block positions within BOT_PROXIMITY_AVOID_DISTANCE (6) of
another bot before mining, falling back to the unfiltered list only if every candidate is
contested (mining something beats mining nothing). Complements, doesn't replace,
arbitrateGoalConflict()'s own goal-text-time check -- that one catches two bots both WANTING
the same thing before either commits to a goal; this one catches two non-conflicting goals
that still happen to converge on the same physical vein, which no amount of text-level
judgment could ever see coming.

1.28.0 (2026-09-08) -- live bug found while verifying an unrelated change (Mayor's first
autonomous directive): Mark was spamming "threat detected (spider)" -> "no hostile mobs
nearby" every ~2s for 90+ seconds straight, doing nothing else the entire time. Root cause:
index.js's checkSelfDefense()/emergency-health/checkSleepingThreat handlers each already find
a real, specific entity via nearestHostile(bot, SELF_DEFENSE_RANGE), but "attack"/"flee" below
threw that away and re-ran nearestHostile(bot) (default range 16) a second time -- racing the
same entity moving out of range or despawning in the gap (checkSelfDefense's own force-cancel-
then-wait sequence can take up to 3s). "attack"/"flee" now accept an optional action.target and
use it directly when a caller already has the real entity in hand; goal-directed callers with
no known entity still fall back to a fresh nearestHostile(bot) search exactly as before.

1.27.0 (2026-09-08) -- direct request: "the duplicate crafting check should be for all
resources as well as utilities like crafting tables. if a resource is in a nearby chest, they
should not mine it." Generalizes the crafting_table/furnace nearby-block check (1.25.0) with
a new shared tryTakeFromNearbyChest() helper, reusing "loot"'s own real chest-interaction
mechanics: "craft" now checks a nearby chest for ANY item before crafting it (not just the two
utility blocks), and "mine"/"explore" now check for the REAL resulting item of what they're
about to gather (new MINE_DROPS/itemNamesForMinedBlocks -- a chest holds raw_iron, not
iron_ore, real vanilla drop behavior, not the block's own name) before ever searching for the
block itself. All-or-nothing: only skips mining/crafting if a chest has the FULL amount
needed, never a partial one.

1.26.0 (2026-09-08) -- direct report: "they still don't seem to react to a threatening
creature." Found the real, foundational cause while live-testing index.js's own self-defense
interrupt fix (2.35.0): nearestHostile() required entity.type === "mob", but a real, freshly
summoned zombie's actual type on this server is "hostile" -- confirmed by direct inspection,
not assumed. This function has never matched a single real hostile mob since the day it was
written; every caller (checkSelfDefense, checkSleepingThreat, "attack"/"flee" targeting) was
working from a function that always silently returned undefined. Not a timing bug, a data
bug -- see the function's own updated comment for the real confirmed entity-type taxonomy on
this version.

1.25.0 (2026-09-08) -- direct report: "they keep creating crafting tables, even when there is
a number of them nearby." Real gap: "craft"'s own "does this need a table" check only ever
asks whether crafting THIS item needs a DIFFERENT existing table/furnace as a station --
crafting_table's own recipe needs no table at all (4 planks, fits the personal grid), so that
check always said "no" for it and fell straight through to making a brand new one, never
checking whether an instance of what she's ABOUT TO MAKE already exists in reach. New
REUSABLE_UTILITY_BLOCKS check (crafting_table, furnace -- same real gap applies to furnace,
also craftable without a table) short-circuits to success if one's already within the same
32-block radius every other nearby-search in this file already uses.

1.24.0 (2026-09-08) -- direct request: "if they can't craft, they should explore, and find
resources for later." New "explore" action: scans broadly for ANY common raw material (every
log species, every ore family) instead of one named target, for when a craft/mine step fails
with nothing specific left to try. Reuses wanderAndRetryFind()'s own directed extended-search
wandering and "mine"'s own tool-tier gate rather than duplicating either. Gathers a full batch
(up to 8) of whatever's found first, not just enough for the immediate need -- added to
SKILL_ACTION_VERBS too, so a stored skill can include an exploration step.

1.23.0 (2026-09-08) -- direct request "start on #6" (MINECRAFT_BOTS_DESIGN.md §14, the
Voyager-style dynamic skill library plan). New export SKILL_ACTION_VERBS: the real allowlist
services/minecraft-bots/skills.js checks a model-authored skill's steps against before ever
storing one, so a skill can only ever reference verbs performAction() actually implements.

1.22.0 (2026-09-08) -- direct report: "the bots just stand around most of the time." Real,
confirmed root cause, not guessed: a live on-server check found ZERO logs within 100 blocks
of spawn (the nearest real tree cluster was ~83 blocks away in one specific direction), so
every wood-gathering goal step failed instantly, cascading into everything downstream (no
planks -> no sticks -> no tools -> can't progress) -- which is what "standing around" actually
looked like in the logs: goal after goal giving up within 1-2 ticks. wanderAndRetryFind()
rewritten from a single blind hop (its original 2026-09-07 form) to use this server's own
view-distance (confirmed live: 160 blocks) -- mineflayer already has chunk data that far out
whether or not she can path there directly, so an extended stationary bot.findBlocks() call
(free, no movement) can find a REAL known bearing to wander toward in bounded hops, instead of
guessing a random direction (live-tested and confirmed unreliable: missed the real tree
cluster entirely, twice, before this fix). ACTION_TIMEOUT_MS raised 60s -> 90s to fit the
extra wander time alongside the real work that still needs to happen afterward. Verified live:
a bot with nothing within 100 blocks found and collected oak_log from ~83 blocks away in 27s.

1.21.0 (2026-09-07) -- direct request "do 1,2,4,5" on a web-research gap analysis against
other mineflayer/LLM Minecraft bot projects (Mindcraft-CE, Voyager, general-purpose farm/
building bots):
(1) Boat crossing: new ensureBoat()/tryLaunchBoat()/attemptBoatCrossing(), wired as a fallback
    inside "gohome" when the normal walking route fails. Real crash bug found and fixed along
    the way: bot.placeEntity()'s own boat-specific packet write is missing fields this exact
    server's protocol actually requires. mount()/moveVehicle()/dismount() (entities.js) supply
    steering once mounted, bot.lookAt() the yaw/pitch to aim, both confirmed real APIs. NOT yet
    working end-to-end, though: extensive live testing traced the remaining failure (no boat
    ever spawns, no crash) to a currently open, unresolved upstream mineflayer bug affecting
    use_item/rotation handling on 1.21.x (PrismarineJS/mineflayer#3742) -- see
    tryLaunchBoat()'s own header comment for the full investigation. Left in place rather than
    reverted since the crash fix, crafting logic, and launch-site/steering code are all real
    and correct, and the whole thing degrades safely to a no-op fallback in the meantime.
(2) Building: new "build" action -- a small, fixed 3x3-footprint shelter (walls, one doorway,
    a roof) using whichever solid block she has the most of. This is the "own pass" this
    file's own 1.0.0-era header comment always said building deserved rather than being half-
    built alongside navigate/gather/fight -- not a general blueprint/planning system, which
    stays out of scope for the same reason it always has (even Voyager needs human feedback
    for its own house-building). Placement order is ground-up per wall column and outward
    from an already-placed edge for the roof, so no cell ever needs a reference that doesn't
    exist yet, and the doorway column is never in the placement list at all -- no self-
    entombment risk regardless of what order individual placements actually succeed in.
(4) Tool-tier gate: "mine" now checks block.harvestTools (minecraft-data, confirmed live
    against this exact server's registry) against her whole inventory before ever starting a
    collect -- real data, not a hand-typed tier table that could drift from this server's
    actual version (this future version's own copper_pickaxe tier, confirmed live, would have
    been missed by anything hand-typed from memory). Following external research on how
    Voyager avoids wasted attempts by sequencing tool tiers explicitly -- this is the
    deterministic guard half of that idea; the goal loop's own already-evidenced ability to
    reason "I need a pickaxe, I need planks, I need logs" from an informative failure message
    is the re-planning half, not a second thing to build.
(5) Farm automation: "harvest" now processes up to HARVEST_BATCH_LIMIT (8) mature crops per
    invocation instead of one -- a real "work the field" pass, matching how dedicated farm
    bots elsewhere in the mineflayer ecosystem work a whole field per pass rather than one
    plant per goal step.

1.20.0 (2026-09-07) -- direct request: "bots should pay attention to the time of day, and try
to return 'home' before full dark." New "gohome" action, a plain goto to bot.spawnPoint -- the
same real "home" reference the teleport-when-stuck mechanism already uses. index.js's own new
checkDusk() decides WHEN to call it (bot.time.timeOfDay), this just handles the walk.

1.19.1 (2026-09-07) -- direct request: "when a bot is looting a chest, it should only take
one instance of any tool, but can take resources up to one full stack at a time." "loot" used
to filter to the narrow isEssentialItem set (gear/fuel/food) and withdraw every matching stack
uncapped -- a chest with three duplicate diamond pickaxes (three separate slots, since tools
don't stack) got all three. Now takes everything found (a curated sandbox server, not a real-
survival dungeon with true junk loot), capped at ONE instance per distinct tool/weapon/armor
piece (GEAR_SUFFIXES) but a full stack (one inventory slot's worth) of anything else.

1.19.0 (2026-09-07) -- direct request: "check the Firmament coder logs for flagged Minecraft
behavior that are not yet resolved" -> "yes" (to digging into the #1 finding). The triage
log (637 entries, all day) was dominated by recurring heap-OOM crashes every 5-15 minutes,
coder/coder2 both only ever guessing "likely a memory leak, increase --max-old-space-size"
without ever pinpointing a cause. Traced two live instances back to their actual logs: not a
slow leak, a violent spike (one went 197MB -> a fatal 750MB+ heap in ~8 seconds), both
immediately following a MINE step on an ore block, both preceded by a burst of rapid
"path_reset: block_updated" events. One instance ran on code from before tonight's own
changes, one from after -- ruling out anything shipped earlier tonight as the cause.

Root cause, confirmed by reading source, not guessed: mineflayer-collectblock's mineBlock()
calls the CORE bot.dig() directly, entirely outside pathfinder's control -- but
bot.collectBlock.cancelTask() (CollectBlock.js) only ever calls bot.pathfinder.stop(). It does
nothing to an in-flight dig. mineflayer's own dig.js registers a per-block
`blockUpdate:${position}` listener that's only ever removed by that exact dig completing
naturally or by bot.stopDigging() -- neither happens when cancelTask() is the only thing
called. stopCurrent() runs before EVERY new action (including the frequent self-defense/
emergency interrupts) and already called cancelTask() for exactly this reason, but never
stopDigging() -- so any action that interrupted an active dig (extremely common during ore
mining in cave terrain, where nearby block changes trigger frequent interruptions) orphaned
that listener and its pending promise permanently. This is the same root lesson already
learned once this session for a different call site (withTimeout's own header comment: "a
stuck mining action... ran unbounded for ~11 minutes... Promise.race abandons the loser, it
does not cancel it") -- cancelTask() turned out to be exactly that kind of incomplete
cancellation for the digging half specifically, not just the pathing half already covered.

Fixed three places: stopCurrent() (the one function every single action already routes
through) now also calls bot.stopDigging() alongside cancelTask() -- confirmed safe to call
unconditionally, since dig.js's own stopDigging is a self-guarding no-op when
bot.targetDigBlock is unset. "mine"'s own ACTION_TIMEOUT_MS handler gets the same addition
(a distinct trigger from stopCurrent -- a timeout INSIDE the same still-running action, not a
new one starting). "harvest"'s bare `await bot.dig(cropBlock)` had no timeout protection at
all -- wrapped in the same withTimeout/stopDigging pattern "mine" already used, closing the
identical unbounded-hang risk there too.

Not claimed as definitively the ONLY contributor to every OOM instance in the log without a
live heap snapshot to confirm against -- but a real, confirmed, previously-undiscovered gap in
how this codebase's own cancellation model handles digging specifically, on the exact action
(mining) most implicated by the live evidence. Worth watching crash frequency after this
deploy to see how much of the pattern it actually accounts for.

1.18.1 (2026-09-07) -- real gap found live minutes after standing up Mark/Luke (see index.js
2.21.0's own changelog): the goal planner reasoned its way to "mine raw_iron" -- raw_iron is
the ITEM a player gets, never a real block id, so "mine" failed outright on exactly the first
real step of the "arm up" priority these two bots exist for. GENERIC_BLOCK_ALIASES now also
covers every raw_* ore item plus a few other common drop-vs-block mixups (coal, diamond,
emerald, lapis_lazuli, redstone), aliasing each to the block that actually drops it.

1.18.0 (2026-09-07) -- direct request: "the build attempts are too narrow. they should
understand classes of things. wood can be any form of wood, not just oak or spruce."
Real gap: "mine" looked up exactly one block id, so "mine oak_log" failed outright wherever
the only trees nearby were spruce or birch, even though any log serves the identical purpose.
New resolveBlockFamily() expands a single requested block to every id that serves the same
real purpose: any log/stem regardless of species, any planks, any wool/carpet/concrete/
terracotta/stained-glass color, and ore that generates as either a stone-layer or
deepslate-layer block (SMELT_RECIPES already treated ore pairs this way -- "mine" was the one
place still checking a single exact id). GENERIC_BLOCK_ALIASES additionally lets a bare class
word ("log", "wool", "ore") stand in for a real example, in case the model names the category
directly. craft/smelt already handled this correctly (bot.recipesFor() resolves real vanilla
tag-based recipes like #minecraft:planks on its own; SMELT_RECIPES already listed ore-pair
alternatives) -- this closes the one remaining narrow spot, not a systemic rewrite.

1.17.0 (2026-09-07) -- direct request "next set of autonomy" -> "do all four" (goal-planner
vocabulary gap was purely an index.js change, see its own 2.19.0 changelog):
(1) shield use in combat: "attack" now equips a shield to off-hand (if she's carrying one)
    before bot.pvp.attack(). Real gap found by reading mineflayer-pvp's own source (PVP.js):
    it ALREADY fully automates shield blocking (a creeper's explosion) and an active-block-
    then-attack cadence on every swing, entirely conditional on hasShield() -- a shield already
    sitting in the off-hand slot. Nothing in this codebase ever put one there; equipping one is
    the entire fix, everything downstream was already built.
(2) XP-aware enchanting: "enchant" now picks the first AFFORDABLE option (checked against
    bot.experience.level) instead of always the cheapest/first slot. Real gap found by reading
    enchantment_table.js's own source: .level IS the real XP-level cost the server charges, and
    enchant() has no affordability check of its own -- it just sends the packet and awaits an
    inventory update that may never arrive if the server silently rejects an unaffordable
    choice, which would have hung the action rather than failing it cleanly.

1.16.0 (2026-09-07) -- direct request "do 1-3" then "and 4" on the next round of autonomy
ideas, itself prompted by tonight's live drowning-loop incident (see index.js's own 2.17.1/
2.17.2 changelog for the reactive half of that fix):
(1) bed safety: new bedNearHazard() scans a box around a candidate bed for water/lava before
    she ever commits to sleeping in it -- addresses the actual root cause (a bed bonded next to
    open water) rather than just recovering better after the fact. Reuses "sleep"'s existing
    multi-candidate loop (same pattern as loot) so one bad bed just falls through to the next.
(2) general hazard-aware pathing: liquidCost bumped in index.js's Movements setup (see its own
    changelog) -- actions.js needed no changes for this half.
(3) torch placement: no actions.js changes needed -- index.js's new checkLighting() reuses the
    existing "place" action (already generic over any held block) rather than a new case.
(4) fishing: new "fish" action, built on mineflayer's own core fish() (confirmed against
    fishing.js source -- casts via activateItem(), resolves on a real bobber-splash particle
    event, reels in itself). fish() has no built-in timeout, so it's wrapped in withTimeout
    like every other open-ended wait here; onTimeout calls activateItem() a second time to
    reel in and cancel cleanly rather than leaving a cast hanging.

1.15.0 (2026-09-07) -- direct request "do the first 3" (of four further autonomy ideas):
(1) farming: new "harvest" action -- picks a ripe crop and replants, simpler than farming from
    scratch since it needs no bare-dirt placement logic. Ages/replant items confirmed against
    minecraft-data's own block-state definitions. Deliberately searches broadly by block TYPE
    first (the proven-reliable pattern) and checks maturity via direct bot.blockAt() calls
    afterward, rather than trusting findBlocks' own function-matcher path to populate real
    block-state properties during the search itself -- never confirmed, not worth the risk.
(2) animal breeding: new "breed" action, built on mineflayer's own activateEntity() (core --
    the real feed-to-breed mechanic, no dedicated breeding API needed).
(3) enchanting: new "enchant" action, built on mineflayer's own openEnchantmentTable() (core).
    Picks the cheapest/first of the 3 offered options rather than real XP-affordability logic.
Stuck-detection (the third of the original four ideas) needed no actions.js changes -- it's
pure index.js logic (bot.setControlState(), no performAction case required).

1.14.0 (2026-09-07) -- direct request "do all" on a further four autonomy ideas:
(1) base/chest storage: new "store" action (bot.craft-adjacent inverse of "loot" -- deposit
    instead of withdraw). New exported isEssentialItem(), factored out of loot's own filter so
    index.js's new checkInventoryFull() can decide what's safe to store using the identical
    definition of "essential" loot already uses, not a second copy.
(2) villager trading: new "trade" action, built on mineflayer's own openVillager()/trade()
    (core) -- a whole real mechanic (trade UI, emeralds) untouched until now. <item> is the
    OUTPUT she wants; finds a matching, affordable, not-disabled trade herself rather than
    needing a trade index. Deliberately direct-command only, not in the goal planner's own
    vocabulary -- villager availability is too unpredictable to risk another hallucination
    surface there.
(3) death/respawn handling: new "recover" action -- paths back to a stored death position
    (index.js's job to capture and pass in) so auto-pickup has a chance to recover dropped
    items before vanilla's 5-minute despawn timer. Internal-use only, not a real ACTION verb.
(4) true mid-action self-defense interrupt: no actions.js changes needed -- the existing
    stopCurrent()/cancelToken design (built for "a new command interrupts an old one") turned
    out to already support being invoked from index.js's own real-time 'health' listener
    without requiring changes here.
Also extracted chestObstructed() from "loot" (used by "store" too, one definition instead of
a second copy of the exact same double-chest-obstruction check).

1.13.0 (2026-09-07) -- direct follow-up to "look for more ways to improve their autonomy":
(1) hunger: new "eat" action (bot.consume(), core, requires the food held first) and new
    exported FOOD_NAMES -- minecraft-data's own item registry carries no food/nutrition field
    at all (checked live: bread/apple both have no foodPoints), so this is a small curated
    list, same pragmatic approach as FUEL_PREFERENCE/SMELT_RECIPES. Loot now also recognizes
    food as worth taking.
(2) bot-to-bot help: new "give" action (bot.toss(), core -- drops at her own feet, so she
    paths next to the recipient first, same pattern as every other action here). General
    enough for a human to ask directly ("give me some bread") or for the autonomous cross-bot
    request flow (index.js) to use by naming the other bot's real username.

1.12.0 (2026-09-07) -- fourth of five scoped enhancements: self-defense. New "flee" action
(GoalInvert wrapping a GoalFollow, confirmed against mineflayer-pathfinder's own goals.js --
negates the heuristic so pathfinder maximizes distance from the threat instead of closing it,
self-terminating once genuinely outside the wrapped radius rather than a guessed duration).
New exported nearestHostile() so HOSTILE_MOBS has one definition, shared with index.js's new
checkSelfDefense() rather than copied. Deliberately the idle-tick version scoped up front, not
true mid-action interrupt -- that would need a real exception to the `acting` flag that
currently exists specifically to prevent interruptions, a bigger design decision than this
pass's scope.

1.11.0 (2026-09-07) -- direct follow-up to "what other logic enhancements are available,"
first two of five scoped and built in order:
(1) explore/wander: the single biggest recurring blocker across a whole night's live testing
    was "couldn't find X nearby" purely because nothing existed within the normal maxDistance
    of wherever the bot happened to be standing. New wanderAndRetryFind() -- ONE bounded
    wander-then-retry per failed search (mine/loot/smelt), not open-ended exploration, since
    long-distance pathfinding is exactly what's been linked to tonight's OOM crashes.
(2) place: bots could craft a furnace/crafting table but had no way to actually use one they
    made themselves, only ones already in the world -- a real dead end hit live tonight. New
    "place" action, built on mineflayer's own placeBlock() (core). Deliberately narrow: one
    utility block next to herself, not a general building capability, which stays explicitly
    out of scope (see this file's own header, unchanged).

1.10.3 (2026-09-07) -- diagnostic: the same 3 furnaces failed "destination full" across
several separate goal attempts tonight -- logging each slot's actual contents on open so a
repeat is diagnosable (someone else's items already there? a stuck previous attempt of our
own?) instead of just "full" with no further evidence.

1.10.2 (2026-09-07) -- real gap found live: once furnace smelting existed, "no fuel" became
the single most common reason a goal gave up, and loot -- the natural fallback -- had no idea
coal/charcoal were worth taking, only armor/tools (GEAR_SUFFIXES). Unlike a looted furnace or
crafting table (useless without a placement capability this system doesn't have), fuel is
directly usable the moment it's in inventory. New FUEL_NAMES, checked alongside GEAR_SUFFIXES.

1.10.1 (2026-09-07) -- real gap found live minutes after smelting shipped: the prompt says
ACTION SMELT's <item_id> is the OUTPUT (e.g. "copper_ingot"), but the planner named the INPUT
raw material instead ("raw_copper") and got "don't know how to smelt" for a perfectly sensible
request. Now accepts either -- if the named item isn't a known output, checks whether it's a
known input for one and uses that recipe instead. Cheap and always-safe to normalize in code
rather than keep tightening prompt wording for something this easy to just accept.

1.10.0 (2026-09-07) -- direct request: "they can't seem to find the furnaces." A huge fraction
of tonight's goal-loop failures were bots correctly reasoning they needed an ingot (iron/
copper/gold) and having no way to get one beyond hoping a chest happened to have it -- craft
(crafting-table only) and mine (raw ore, not the smelted product) alone were never enough.
New "smelt" action, built on mineflayer's own openFurnace() (core, no extra plugin) -- finds a
furnace (up to 3 candidates, same pattern as loot/sleep), puts in fuel + raw material, and
waits for real output via furnace.js's own 'update' event rather than guessing a duration.
minecraft-data has no dedicated smelting-recipe data (checked: no equivalent of recipes.json
for furnace input->output), so SMELT_RECIPES is a small, deliberately hand-picked map covering
what actually matters for gearing up, not an attempt at full smelting-recipe coverage.

1.9.1 (2026-09-07) -- real gap found live on the very first real sleep attempt: every
per-candidate bed failure was silently swallowed (`continue` with no logging), so when all 3
candidates failed the only visible result was "couldn't use any of them" -- no way to tell
whether it was an occupied bed, monsters nearby, unreachable, or something else. Logging each
candidate's actual rejection reason now (bot.sleep()'s own specific error messages) -- the
same lesson already learned once today for the goal loop's own transitions.

1.9.0 (2026-09-07) -- direct request: "the bots need to know to go to sleep at night." New
"sleep" action, built entirely on mineflayer's own bed.js plugin (core, always loaded) --
bot.sleep()/bot.wake()/bot.isSleeping/bot.isABed() already implement the real vanilla rules
(the exact night-or-thunderstorm timeOfDay window, occupied-bed/monsters-nearby/reach checks,
each with its own thrown reason), so this only needed to find a bed and try it, same multi-
candidate pattern loot already uses. stopCurrent() now also forces a wake if a new action
comes in mid-sleep (a direct command, or the goal loop wanting to act) -- sleep should never
block anything else from happening once something else needs her attention. index.js's
checkSleep() decides WHEN to call this (a deterministic time-of-day check, not a model call --
unlike the goal loop, "is it night" needs no reasoning).

1.8.2 (2026-09-07) -- real gap found live repeatedly during autonomy goal loop testing: the
loot action fetched only the single NEAREST chest (findBlocks count:1). Once that one chest
turned out to be permanently obstructed or unopenable, every subsequent loot attempt
deterministically re-found the exact same bad chest and failed the same way -- both bots
racked up 6+ identical "couldn't open"/"obstructed" failures across many separate goals,
never trying anywhere else even though other chests existed within range. Now tries up to 3
candidates in distance order, skipping to the next on any per-chest failure instead of giving
up after the first.

1.8.1 (2026-09-07) -- real crash found live within minutes of the autonomy goal loop
shipping: both bots' very first self-proposed crafting step (copper_ingot, furnace) crashed
with "recipe.ingredients is not iterable" -- craftItem()'s shortfall-resolution loop assumed
every candidate from recipesAll() has a real ingredients array, which isn't true for an item
that's smelting-only (this action has no furnace support at all, only bot.craft()'s crafting-
table/grid). Now skips any candidate without one, so an unsupported item fails cleanly instead
of crashing the step. Found from goal.json's own persisted log, not a guess -- see index.js
2.11.1's new goal-loop console logging, added for exactly this kind of diagnosis.

1.8.0 (2026-09-07) -- autonomy (standing goals, direct request "give her more autonomy to
work towards longer goals"): performAction() now returns { ok, text } instead of a bare
string. The goal loop (index.js/goals.js) needs to know whether a step actually made progress
to decide when to keep trying vs. give up -- English-parsing the old free-text result
("couldn't...", "had trouble...") for that would be fragile and silently break the moment a
message wording changes. `ok` is the real, structural signal; `text` is unchanged and still
exactly what gets narrated/chatted, so every existing call site only needed `result` ->
`result.text`.

1.7.0 (2026-09-06) -- direct request: "pre-teach the most common recipes." minecraft-data
already knows every vanilla recipe correctly (Recipe.ingredients/requiresTable, confirmed
against prismarine-recipe's own types) -- there's no external recipe data to teach it. New
"craft" action (craftItem()) uses bot.recipesFor()/bot.recipesAll() (confirmed against
mineflayer's own craft.js source: recipesFor already filters to what's affordable *right
now*) and auto-resolves the two most common shallow shortfalls (no planks but has logs, no
sticks but has planks) before giving up -- covers the overwhelming majority of real
"craft X" requests starting from raw gathered resources, without attempting a general
recursive planner.

1.6.2 (2026-09-06) -- actual root cause of the "(empty)" chest, after 1.6.1's timing-delay
guess was ruled out by direct testing: Window.items() returns the PLAYER'S OWN inventory
slots within the combined chest+inventory window, not the container's -- confirmed against
prismarine-windows' own source. containerItems() is the real container-only view. A chest
confirmed (by a human, in-game) to hold two netherite pickaxes was correctly reporting empty
every time because Babs' own inventory was empty, not the chest.

1.6.1 (2026-09-06) -- real bug found live: the contents-logging added in 1.6.0 immediately
showed the real problem -- a chest confirmed (by a human, in-game) to hold two netherite
pickaxes logged as "(empty)" twice in a row. Guessed this was a packet-timing race and added
a 200ms delay before reading -- ruled out by direct testing (still empty); see 1.6.2 for the
actual cause.

1.6.0 (2026-09-06) -- root cause of the 20s open-chest hang confirmed and fixed: minecraft-
data had no real protocol data for 26.1.2 (silently aliased to 26.1's), a version-support
gap in the mineflayer ecosystem, not a bug here -- fixed by moving the whole server to
1.21.11, a mature version with genuine native support (confirmed via minecraft-data
resolving it exactly, no aliasing). Removed the now-unneeded position/lookAt diagnostics
(1.4.1) and replaced with a simple log of full chest contents -- a live test on the new
version opened a chest successfully but reported "nothing worth taking" despite it holding
real tools, a GEAR_SUFFIXES matching bug, not a protocol issue; this log is to find it.

1.5.0 (2026-09-06) -- real evidence from the 1.4.1 diagnostic: the chest that kept hanging
is one half of a double chest (getProperties() -> {type: "right", facing: "east"}). The
obstruction check only ever looked above the single block findBlocks returned -- never the
paired half, whose own obstruction blocks the whole double chest from opening in vanilla.
Now scans cardinal neighbors for the matching paired half and checks both. Diagnostic
logging (1.4.1) left in for now until this is confirmed live.

1.4.1 (2026-09-06) -- TEMPORARY: added console diagnostics right before the loot action's
open attempt (bot/chest position, distance, live block state, look angles) -- the
obstruction check (1.3.0) and lookAt (1.4.0) fixes both failed to resolve the same 20s hang,
and the server's own log shows nothing, so this stops guessing a third blind fix in favor of
real data. Remove once root-caused.

1.4.0 (2026-09-06) -- second real error found live on "loot," after ruling out the 1.3.0
obstruction check (confirmed no block above the chest, still hung the full 20s):
pathfinder's goto() only gets the bot's position near a target, it never turns the bot to
face it. openChest() defaults its interaction direction to (0,1,0), which doesn't reflect
an actual look-at-the-chest vector if the bot arrived from the side -- the server's own
reach/look-direction validation on the interaction then silently never answers. Explicitly
calling bot.lookAt() at the chest before opening it is the fix.

1.3.0 (2026-09-06) -- real error found live: "loot" waited openChest()'s own internal 20s
timeout ("Event windowOpen did not fire") against a chest that vanilla Minecraft will never
open -- any solid block directly above a chest blocks its lid, a real, common world-state
issue, not a bug. Checking the block above before attempting to open turns that cryptic 20s
hang into an immediate, specific answer.

1.2.0 (2026-09-06) -- direct request: bots should look in chests for equipment, wear the
best armor they find, and hold the best weapon unless a task needs a specific tool. New
"loot" action opens the nearest chest and takes any armor/weapon/tool it finds (equipment.js
decides what's actually worth wearing once it's in inventory). mineflayer-tool's plugin is
now loaded (equipment.js's loadEquipmentPlugins) -- real gap found while investigating a
mining timeout: mineflayer-collectblock already calls bot.tool.equipForBlock() internally
for task-specific tool selection, but that silently had nothing to call since the plugin
was never loaded. Every action that can change inventory (mine, attack, loot) now re-runs
equipBestArmor/equipBestWeapon afterward so gear stays current without a separate request.
Crafting and building are still explicitly out of scope -- this covers "use what you already
have or can loot," not "make what you don't have yet."

1.1.0 (2026-09-06) -- withTimeout() now takes a required onTimeout callback that actually
cancels the underlying pathfinder/collectBlock/pvp operation -- see its own updated comment
for the real incident this fixes (a stuck mine action ran unbounded for ~11 minutes and
crashed the process via OOM, which is what actually disconnected the bot, not a network drop).

Real in-world actions -- the piece the design doc's personas always claimed ("mining,
building, fighting, gathering, navigating" -- see agents/minecraft-*/PROMPT.md's Core
Directives) but nothing implemented until now. Building/placing structures is deliberately
NOT in scope here: navigate, gather, and fight are the three tractable, high-value verbs
that make a bot feel like a real player; a structure planner is a much bigger feature that
deserves its own pass, not something to half-build alongside everything else this file does.

Uses two more PrismarineJS plugins beyond pathfinder (already loaded): mineflayer-collectblock
(pathing + digging + pickup for a real "go gather N of this block" loop) and mineflayer-pvp
(pathing + attack-timing for real combat, rather than hand-rolling swing intervals).
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-13 | Created: actions.js's header changelog moved here verbatim, plus its 3.0.0 entry. |
