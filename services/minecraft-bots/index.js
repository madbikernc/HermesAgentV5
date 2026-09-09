// Version: 2.41.0
//
// 2.41.0 (2026-09-08) -- direct live report ("check the bots other than mayor, they are
// stuck?"), confirmed real: Babs/Amy/Mark/Luke all sat completely idle for 3+ minutes after
// their last goal ended, no self-proposed replacement, no errors logged at all -- eerily quiet
// rather than obviously broken. Root cause: handleIncoming's lastActivityAt reset (used only to
// gate IDLE_BEFORE_SELF_GOAL_MS, the "propose a new goal after 10 quiet minutes" timer) fired
// for ANY message that reached this function, including Mayor's own isMayor() exception traffic
// (2.36.0) -- and Mayor talks periodically on his own (every MAYOR_DIRECTIVE_MS, plus his own
// self-proposed-goal chat), which kept perpetually restarting every other bot's 10-minute
// countdown. Mayor's mere presence meant that clock could never actually elapse for anyone else,
// unless Mayor happened to hand that SPECIFIC bot a directive or a real player intervened.
// lastActivityAt now only resets for an actual real player (`!isAnotherBot(speaker)`) -- Mayor's
// chat still reaches classifyIntent -> ACTION GOAL exactly as before, it just no longer also
// gates everyone else's unrelated self-propose clock.
//
// 2.40.0 (2026-09-08) -- item #6 of "fix all the above" (squad response for Mark/Luke). Self-
// defense was purely individual despite Mark/Luke's own "military... defending the spawn point"
// framing (2026-09-07) implying a squad that backs each other up. New broadcastThreatAlert() over
// the existing "minecraft-coordination" Buzz topic (same JSON-payload channel otherBotGoals
// already reads) -- checkSelfDefense() calls it (cooldown-debounced) whenever a real threat is
// found. New SQUAD_RESPONDER (env-gated per-bot, same pattern as
// MC_SELF_DEFENSE_FLEE_HEALTH/RANGE, set true for Mark/Luke only -- Babs/Amy abandoning a
// gathering run for a fight three biomes away would be a net loss, not backup) + respondToSquadCall():
// on hearing an alert within SQUAD_ASSIST_RANGE, force-cancels current action (same shape as
// checkSelfDefense's own interrupt), travels to the real coordinates, and fights whatever hostile
// is still there.
//
// 2.39.0 (2026-09-08) -- item #5 of "fix all the above" (inventory insurance). New
// checkInventoryInsurance(): checkInventoryFull()'s own store pass, refactored into a shared
// storeSurplusValuables() and now ALSO triggered by taking real damage (health <=
// INSURANCE_HEALTH_THRESHOLD, well above the emergency-flee threshold), not just by running out
// of inventory space. A bot could carry a stack of diamonds or a spare armor set indefinitely
// with room to spare and never bank any of it -- a death that was otherwise survivable-in-
// hindsight still wiped out real progress a nearby chest could have prevented. Cooldown-gated so
// one low-health episode doesn't retry every idle tick.
//
// 2.38.0 (2026-09-08) -- item #3 of "fix all the above" (farming from scratch, actions.js
// 1.30.0's own new till-and-plant fallback in "harvest"). Both ACTION HARVEST descriptions
// (classifyIntent's direct-command parser and the goal-step planner) now mention that harvest
// also starts a new farm when nothing is ripe yet, so the planner knows one verb covers both
// cases instead of never reaching for it to bootstrap a farm.
//
// 2.37.0 (2026-09-08) -- companion fix to actions.js 1.28.0: checkSelfDefense(), the emergency-
// health handler, and checkSleepingThreat all already hold the real entity they detected via
// nearestHostile(bot, SELF_DEFENSE_RANGE) -- now passed through as action.target on the
// performAction() call instead of being discarded, so "attack"/"flee" don't re-derive it (and
// race it moving/despawning) a second time. Found live verifying Mayor's first directive: Mark
// was stuck thrashing on this exact bug (spamming detect-then-fail every 2s) instead of ever
// getting back to an idle tick that could have heard and acted on the directive.
//
// 2.36.0 (2026-09-08) -- direct request: "add another bot, Mayor, whose personality is to be a
// leader and set goals for the others. The others can defer to him when his instructions are
// not in conflict. The Mayor perceives me as 'The President' and therefore his superior." New
// isMayor() exception to isAnotherBot() -- Mayor's chat is the one bot-to-bot message that
// actually needs to reach another bot's real decision loop (classifyIntent -> ACTION GOAL), the
// same path a player's own instruction already takes, rather than staying coordinate-over-Buzz-
// only like every other bot's chat. handleIncoming's own ACTION GOAL branch now defers to an
// already-active REAL PLAYER goal over a new Mayor directive (never the reverse) -- the
// hierarchy his own persona describes. New proposeDirectiveForOthers(): a Mayor-only (no-op for
// every other bot) periodic behavior that picks whichever teammate has no active goal
// (otherBotGoals, the same live signal arbitrateGoalConflict() already reads) and assigns one
// via a real, addressed chat line -- no separate "assign a goal" mechanism, it flows through the
// exact same pipeline a player's own command already uses.
//
// 2.35.0 (2026-09-08) -- direct report: "they still don't seem to react to a threatening
// creature." Real, confirmed gap: checkSelfDefense() was gated on !acting, same as every other
// idle-tick check -- but acting now spans an entire physical action end-to-end (up to
// ACTION_TIMEOUT_MS, 90s after an earlier raise tonight), and goal-directed autonomy keeps a bot
// "acting" a large fraction of the time. A threat showing up mid-mine/mid-craft got NO response
// from this check at all until the health-triggered TRUE interrupt (bot.on("health") below)
// finally engaged -- and that one only fires at 30% health, meaning several real, avoidable hits
// already landed first. checkSelfDefense() now uses that same handler's own proven force-cancel-
// then-wait-then-act sequence instead of the idle-tick gate, consistent with
// checkSleepingThreat's own precedent of bypassing busy/acting for exactly the one case nothing
// else can reach in time -- a live threat, unlike every other routine check's own physical work,
// genuinely cannot wait.
//
// 2.34.0 (2026-09-08) -- direct request: "if they can't craft, they should explore, and find
// resources for later." Wired actions.js's new "explore" verb (1.24.0) into both classifyIntent
// (player-facing) and the goal planner's own vocabulary, plus a new deterministic BLOCKED
// override -- same "prompt guidance plus a code guard" reasoning as the existing LOOT-before-
// smelt-blocked override: a model BLOCKED on a missing raw material sometimes gives up rather
// than trying EXPLORE even though the prompt already teaches it as an option. A successful
// explore also writes a world memory note (position included) -- the "for later" half of the
// request: not just solving today's shortage, leaving a record another bot's own goal can
// recall next time it needs the same material.
//
// 2.33.0 (2026-09-08) -- direct report: "they get in water, jump to come up, but do not ever
// try to reach land." Confirmed real: the anti-drowning reflex (2.29.0) only ever answered
// "don't drown right now" -- once oxygen recovered, nothing steered her anywhere, so she just
// kept floating wherever she surfaced. New findNearestShore() + a goto() call at the end of the
// breath handler, using the pathfinder every bot already carries (now genuinely able to route
// out of water since swim-movements.js's SwimMovements stopped getMoveUp()/getMoveDown() from
// refusing while already submerged -- this literally could not have worked before that shipped
// the same night).
//
// 2.32.0 (2026-09-08) -- direct request "start on #6" (MINECRAFT_BOTS_DESIGN.md §14, a Voyager-
// style dynamic skill library). goalTick() now checks skills.js's findSkill() before spending a
// planNextStep call -- a close-enough, still-trusted match runs directly via runSkill() through
// the same performAction() pipeline every other step already uses, completing the goal in one
// shot on success. A goal that finishes DONE without ever being served by a stored skill gets
// compressed into one via authorSkillFromGoal(), using goals.js's new actionsTaken (1.3.0) --
// the REAL {type, ...args} objects each successful step actually ran with, never re-derived
// from text by an LLM. This is the retrieval+authoring half of §14's plan (steps 3-4 of its own
// "build sequence, if greenlit"); the skill-runner and hermes-rag corpus (steps 1-2) are new
// skills.js and tools/hermes-rag-{ingest,search}-minecraft-skills.py.
//
// 2.31.0 (2026-09-07) -- direct request "do 1,2,4,5" on a web-research gap analysis (see
// actions.js 1.21.0's own changelog for the real detail on all four). This file's own share:
// wired the new "build" verb into both classifyIntent (player-facing) and the goal planner's
// vocabulary (self-directed), and corrected ACTION PLACE's now-stale "never for building"
// wording now that a real building capability exists.
//
// 2.30.0 (2026-09-07) -- direct request: "build the water crossing mechanic," following 2.29.0's
// anti-drowning reflex (survival, not capability). Now uses new swim-movements.js's
// SwimMovements in place of stock Movements -- see that file's own comment for the confirmed
// gap it closes: pathfinding could already cross open water at the surface, but had no way to
// generate a move that changes depth once already in liquid, so a bank dive or a resurface
// partway across a crossing was never in the search graph at all, not just expensive.
//
// 2.29.0 (2026-09-07) -- direct request: "they need to know how to swim." New bot.on("breath")
// handler: watches bot.oxygenLevel (mineflayer's real air-supply tracking) and, once critical,
// force-cancels whatever's running and holds the jump control while bot.entity.isInWater --
// confirmed against prismarine-physics's own tick loop that this adds real upward velocity every
// tick, the same mechanic a player uses to swim up. mineflayer-pathfinder itself can never
// generate a "swim to the surface" move (confirmed against movements.js's own getMoveUp(): it
// unconditionally refuses once already in liquid), so this had to be a direct control-state
// action, not a pathfinder goal. Deliberately just a surfacing reflex (don't drown), not full
// swim-to-shore navigation.
//
// 2.28.0 (2026-09-07) -- direct request: "fix it," following a real finding from tonight's own
// Matrix-routing-convention check: live logs showed literally every real player chat message
// all day getting logged as "busy, dropping," including ones explicitly naming a specific bot
// by name. Root cause: goalTick() and nine other idle-tick action functions (checkSleep,
// checkDusk, checkSelfDefense, checkHunger, checkPendingGiveRequests, checkInventoryFull,
// checkLighting, the post-respawn recovery block, the emergency-flee handler,
// checkSleepingThreat) all held the SAME `busy` flag handleIncoming checks for their entire
// physical-action duration (up to ACTION_TIMEOUT_MS each) -- not just the brief decision that
// preceded it -- even though a direct player command's own runAction() never held `busy` for
// its action, only `acting`. With the autonomy loop now keeping a bot in one of these ten
// functions most of the time, `busy` was effectively true almost continuously. Fixed by
// removing the needless `busy` hold from all nine simple checks (kept `acting`, which already
// and correctly prevents them from double-firing) and restructuring goalTick() into two
// phases: `busy` held only for planNextStep()'s own decision call, released before the
// resulting physical action executes, `acting` held across both. This makes the actual
// behavior match this file's own pre-existing comment on goalTick ("a live player command
// always wins immediately") for the first time -- it relies on nothing new: every action
// already calls stopCurrent() first (actions.js), which safely interrupts whatever's
// physically in flight, exactly like a direct command already could interrupt itself.
//
// 2.27.0 (2026-09-07) -- direct request: "what other behavior rules have any other sources
// published or suggested" -> "all". New arbitrateGoalConflict(), built against
// MINECRAFT_BOTS_DESIGN.md's own §6 table: "Cross-bot conflict arbitration (two bots claim the
// same sub-goal) -> super (rare, not per-tick)" -- decided and documented back when this was
// designed, never actually built until now. What existed was only the soft otherGoalsNote()
// prompt nudge, which depends entirely on a bot's own model voluntarily noticing and avoiding a
// collision, with nothing that actually resolves one if it doesn't. Wired into proposeOwnGoal()
// only (self-proposed goals), deliberately not player-assigned ones (ACTION GOAL) -- a human's
// direct instruction should never get silently overridden by an arbitration call.
//
// 2.26.0 (2026-09-07) -- direct request: "bots should pay attention to the time of day, and try
// to return 'home' before full dark." New checkDusk(), same deterministic on-a-timer shape as
// checkSleep -- DUSK_START_TICK (10000) fires well before checkSleep's own sleep-eligible window
// (12541, bed.js's own real enforcement) so she has actual travel time, not just a same-tick
// notice. Calls actions.js's new "gohome" action (1.20.0), a plain goto to bot.spawnPoint -- the
// same real "home" reference the teleport-when-stuck mechanism already uses.
//
// 2.25.0 (2026-09-07) -- direct request: "if a bot gets stuck, there needs to be a mechanism to
// teleport it back to its spawn point rather than continually restart that bot." Real evidence
// found while investigating: Babs reconnected at the EXACT SAME coordinate across seven
// consecutive process restarts over 9 minutes that same night -- a crash-and-restart cycle does
// nothing for a bot wedged in terrain, since Minecraft persists player position across
// reconnects just like a real player logging back in; she just gets stuck again immediately.
// Two layers, both landing on the same new teleportToSpawn():
// (1) In-process escalation: checkStuck's existing jump-nudge now escalates to a real teleport
//     after MAX_STUCK_NUDGES consecutive zero-movement cycles despite nudging (handles a bot
//     that's wedged but NOT also crash-looping).
// (2) Cross-restart detection (goals.js 1.2.0's new loadStuckState/saveStuckState): the compound
//     case a purely in-process timer can't catch on its own -- if something else is ALSO
//     crash-looping her every minute or two, checkStuck's multi-minute threshold may never
//     complete one cycle before the next restart wipes its counters. Every checkStuck tick saves
//     her current position; on every fresh spawn, this position is compared against whatever was
//     saved right before the process went down -- RESTART_STUCK_THRESHOLD consecutive reconnects
//     within RESTART_STUCK_RADIUS blocks of each other teleports home immediately, without
//     waiting to survive long enough in one continuous run to notice.
// teleportToSpawn() targets bot.spawnPoint (confirmed against mineflayer's own spawn_point.js:
// populated from the server's own spawn_position packet, so it's NOT corrupted by wherever she's
// currently wedged), issued via bot.chat("/tp x y z") -- requires /tp permission, so
// Babs/Amy/Mark/Luke were added to ops.json at level 2 (command access, not full admin) for
// exactly this. Abandons her current goal on teleport, same reasoning as death/respawn: whatever
// she assumed about her surroundings is now stale.
//
// 2.24.0 (2026-09-07) -- three direct requests in one round:
// (1) "bots should check *any* nearby chests before resorting to mining new stacks." MINE's own
//     prompt now tells the planner to try ACTION LOOT first for a resource need, before mining,
//     unless the recent log already shows a LOOT attempt this goal. Pairs with actions.js
//     1.19.1's own change (LOOT now takes any useful item, not just gear) -- without that half,
//     nudging the planner toward LOOT wouldn't have actually found ordinary resources sitting in
//     a chest anyway. Both ACTION LOOT descriptions (classifyIntent, planNextStep) updated to
//     match what it actually does now.
// (2) "they don't seem to be fighting back... when woken up from sleeping." Real gap: EVERY
//     idle-tick check (checkSelfDefense included) is gated by the busy/acting mutex, and
//     "sleep"'s own performAction call holds that mutex for its ENTIRE duration (until the real
//     'wake' event or SLEEP_TIMEOUT_MS, up to 15 minutes) -- so only the emergency health-
//     triggered interrupt could react at all while actually asleep, and only once health had
//     already dropped to a near-death threshold. A hostile that found a sleeping bot got to hit
//     her repeatedly, completely unopposed. Two fixes: the emergency interrupt now calls
//     bot.wake() first when she's asleep (a forced flee can't move her while pinned in bed, and
//     without waking her, this handler's own force-through logic would just collide with sleep's
//     own still-pending cleanup instead of freeing it); and new checkSleepingThreat(), a
//     dedicated short-interval check (deliberately bypassing busy/acting, checkStuck's own
//     precedent) that wakes her and responds to a nearby hostile proactively, not just as a
//     last-resort emergency.
//
// 2.23.0 (2026-09-07) -- direct request: "check the Firmament coder logs..." -> "yes" (dig
// deeper) -> "yes" (run the retainer trace). A real heap snapshot plus a retainer-graph trace
// (both taken from a live crash, not guessed) found the actual root mechanism: astar.js's
// compute() is a fully synchronous loop that can hog Node's event loop in ~40ms chunks for up to
// 5 STRAIGHT SECONDS per search (tickTimeout/thinkTimeout's old defaults), starving everything
// else -- Buzz, Matrix, incoming packets, pending promise callbacks -- and letting a backlog of
// never-settled promises accumulate (confirmed via the snapshot's own retainer chains: rooted at
// Stack/GC roots, i.e. genuinely pending, not forgotten references). thinkTimeout lowered
// 5000ms -> 1000ms, tickTimeout 40ms -> 20ms. See the setting's own comment for the full
// evidence chain. This supersedes the earlier "reduce searchRadius" theory as the dominant
// contributor -- that fix (2.22.0) was real and stays, but pathfinding NODE COUNT wasn't what
// the snapshot actually showed dominating memory; event-loop starvation from BLOCKING DURATION
// was.
//
// 2.22.0 (2026-09-07) -- direct request: "check the Firmament coder logs for flagged Minecraft
// behavior that are not yet resolved" -> "yes" (dig into the #1 finding, the all-day recurring
// OOM crash coder/coder2 kept flagging but never pinpointed). Two real, distinct contributing
// causes found by reading source and tracing live incidents, not guessed:
// (1) actions.js's own fix (stopCurrent()/mine()/harvest() now also call bot.stopDigging(), see
//     its 1.19.0 changelog) -- nothing needed here.
// (2) bot.pathfinder.searchRadius lowered from 128 to 48: 128 bounded any ONE search, but
//     mineflayer-pvp's attack() uses a DYNAMIC GoalFollow, and pathfinder's own tick loop
//     reruns the full search on every tick the target's position changes, with no debounce of
//     its own -- against an erratically-flying target (a phantom, live evidence: 419
//     path_update lines in under 30 seconds fighting one) that's a fresh expensive search
//     firing nearly 20x/second. See the setting's own updated comment for the full account.
// Both are real, confirmed mechanisms found from live evidence; neither is claimed as the sole
// explanation for every OOM in the triage log without a heap snapshot to fully confirm against.
//
// 2.21.0 (2026-09-07) -- direct request: "ask Muse to spawn two more bots, named Mark and Luke,
// with military oriented profiles, and priority towards arming themselves and defending the
// spawn point." Persona content (agents/minecraft-mark, agents/minecraft-luke) was drafted by
// the fleet's own "muse" model per the request's own wording, then fit into the standard
// template with concrete priority directives -- see those files' own Revision History. Three
// code changes here to actually support a 3rd/4th bot correctly, not just add two more entries
// to a 2-bot-shaped system:
// (1) BOT_USERNAMES default extended to "Babs,Amy,Mark,Luke" -- otherwise Mark/Luke's own chat
//     would loop back through Babs/Amy's normal human-reply pipeline (see isAnotherBot()'s own
//     comment on why that's the exact bug this list exists to prevent).
// (2) Real gap found while reviewing the coordination code for 4-bot readiness: `otherBotGoal`
//     was a single `let`, correct only for exactly two bots -- a 3rd/4th bot's Buzz broadcast
//     would just overwrite it, silently losing track of whichever other bot posted first. Now
//     `otherBotGoals`, a Map keyed by from_agent, with a shared otherGoalsNote() helper replacing
//     two near-identical inline blocks in planNextStep/proposeOwnGoal.
// (3) SELF_DEFENSE_FLEE_HEALTH/SELF_DEFENSE_RANGE are now env-configurable
//     (MC_SELF_DEFENSE_FLEE_HEALTH/MC_SELF_DEFENSE_RANGE) rather than hardcoded constants, so
//     Mark/Luke's own systemd units can run a lower flee threshold and wider detection range for
//     an actually more combat-postured "defend the spawn point" behavior, without a second code
//     path -- Babs/Amy are unaffected since they don't set these.
// hermes-buzz.py 2.0.19 adds mc-mark/mc-luke to KNOWN_AGENTS (same convention as mc-babs/mc-amy).
// infra/minecraft-bots/ gets minecraft-bot-mark.service and minecraft-bot-luke.service, same
// shape as the existing babs/amy units.
//
// Known, deliberate gap: Mark and Luke do NOT have Matrix access tokens (~/.hermes/
// minecraft-matrix.env has no MC_MATRIX_MARK_TOKEN/MC_MATRIX_LUKE_TOKEN entries -- creating new
// Matrix accounts on Continuwuity is a separate provisioning step outside this request's scope).
// This is the same best-effort fallback every bot already has -- see MATRIX_ACCESS_TOKEN's own
// comment -- Buzz/in-game chat both work normally regardless.
//
// 2.20.0 (2026-09-07) -- direct request: "the build attempts are too narrow. they should
// understand classes of things. wood can be any form of wood, not just oak or spruce." Purely a
// prompt-wording change here -- the real fix is actions.js's new resolveBlockFamily() (see its
// own 1.18.0 changelog). Both MINE prompts (classifyIntent and planNextStep) now say that naming
// any real example of a material class is enough; she'll automatically gather whatever matching
// variant is actually nearby rather than needing the exact species/color present.
//
// 2.19.0 (2026-09-07) -- direct request "next set of autonomy" -> "do all four, and set a limit
// on the number of times a bot will try to recover its gear from dying":
// (1) goal-planner vocabulary gap: harvest/breed/enchant/fish existed since the last two rounds
//     but were only ever reachable via a direct player command -- planNextStep's own vocabulary
//     (confirmed by reading it) still only offered MINE/CRAFT/SMELT/PLACE/LOOT/ATTACK/REQUEST, so
//     a self-proposed standing goal could never actually choose to farm, breed, enchant, or fish.
//     Added all four to planNextStep's prompt and parseGoalStep's parser, same shape as every
//     other verb.
// (2) gear durability awareness: equipment.js's own change (effectiveTier(), see its 1.2.0
//     changelog) -- nothing needed here.
// (3) shield use in combat: actions.js's own change (equip a shield into off-hand before
//     bot.pvp.attack(), see its 1.17.0 changelog) -- nothing needed here either; checkSelfDefense
//     already calls the same "attack" action, so it benefits automatically.
// (4) XP-aware enchanting: actions.js's own change (affordability check before enchant(), see its
//     1.17.0 changelog) -- nothing needed here.
// (5) recovery attempt limit: new MAX_RECOVERY_ATTEMPTS (default 3) on top of the existing
//     `recovering` guard from tonight's drowning-loop fix -- that guard only stops chasing the
//     SAME lethal spot twice. First version of this cap reset on any recover() call reporting
//     ok=true, and broke within minutes of shipping: a hostile mob camping the base at spawn kept
//     killing both bots again seconds after each recovery, and recover() genuinely DID succeed
//     every time (she made it back and picked items up, she just didn't survive standing there
//     afterward) -- a cap keyed to the action's own success never engaged. Rewritten to count
//     real deaths by how close together they land in time (RAPID_DEATH_WINDOW_MS, 60s) instead --
//     any death within that window of the last one extends the same incident regardless of what
//     recover() reports, a longer gap starts a fresh count.
//
// 2.18.0 (2026-09-07) -- direct request "do 1-3" then "and 4" on the next round of autonomy
// ideas, itself prompted by tonight's live drowning-loop incident (2.17.1/2.17.2 below):
// (1) general hazard-aware pathing: Movements.liquidCost raised from its default of 1 (barely
//     more than a normal step, confirmed against mineflayer-pathfinder's own astar.js) to 20 in
//     the spawn handler's existing Movements setup, so pathfinder strongly prefers dry land over
//     wading through water when a route exists, without banning water crossings outright.
// (2) auto-equip best gear: already fully implemented (equipment.js's equipBestArmor/
//     equipBestWeapon, wired into refreshGear after every craft/mine/loot) from earlier tonight
//     -- nothing new needed here, confirmed by reading the existing code rather than assuming.
// (3) torch placement: new checkLighting() on its own 20s timer, same idle-tick/busy-acting
//     pattern as checkHunger -- reuses the existing generic "place" action (actions.js, already
//     works for any held block) rather than a new case. block.light < 8 (confirmed against
//     prismarine-block source as the real per-position 0-15 light value) is the trigger, the
//     same threshold most mineflayer bots use for "mobs could spawn here."
// (4) fishing: new "fish" action (actions.js 1.16.0) wired into classifyIntent ("ACTION FISH")
//     for direct-command parity, AND into checkHunger as a fallback -- when "eat" fails (no food
//     on hand) and she's holding a fishing_rod, she now tries fishing instead of just waiting
//     for food to show up on its own.
// Bed safety (screening a candidate bed for nearby water/lava before sleeping in it) is entirely
// an actions.js change (bedNearHazard(), see its own 1.16.0 changelog) -- nothing needed here.
//
// 2.17.2 (2026-09-07) -- second hotfix from the same live check: the very next respawn after
// 2.17.1 shipped hit a fresh, unrelated bug in the same handler. bot.chat(await narrateAction(...))
// is awaited BEFORE the goal-abandon/recover logic below it; narrateAction's "muse" call returned
// 503 "Loading model" right after that respawn, and since nothing caught it there, the outer
// .catch() swallowed the entire async function -- goal-abandon and gear recovery were silently
// skipped because of a flaky chat-flavor-text call that has nothing to do with either. Wrapped in
// its own try/catch so a narration failure can no longer take the real recovery logic with it.
//
// 2.17.1 (2026-09-07) -- hotfix, caught live via "check to see if they are stuck or not behaving
// to spec": Amy was stuck drowning in an infinite loop (server log confirmed repeated "Amy
// drowned" every ~40-80s starting 17:11:49) because recover() paths straight back to the death
// coordinate with zero hazard-awareness -- when the death itself was caused by that location
// (submerged), every recovery attempt re-triggered the same fatal drowning, minting a fresh
// deathPosition each time and repeating forever. New `recovering` flag: bot.on("death") now
// checks whether a recovery was already in flight when the new death landed, and if so gives up
// on that spot instead of chasing it again.
//
// 2.17.0 (2026-09-07) -- direct request "do the frist 3" on a further four autonomy ideas
// (explicitly excluding the 4th, Nether access -- flagged as a separate, larger decision and not
// requested):
// (1) Stuck detection: new checkStuck() on its own 30s timer, deliberately NOT gated by the
//     busy/acting mutex like every other idle-tick check -- a jump nudge is harmless and
//     compatible with any in-progress action, unlike the mutually-exclusive actions those checks
//     guard. Tracks position once per interval; 5 straight minutes with under 0.1 blocks of
//     movement triggers a half-second jump via bot.setControlState("jump", ...) (confirmed
//     against mineflayer's physics.js source).
// (2) Farming: new "harvest" action (actions.js 1.15.0) finds the nearest mature crop via
//     bot.findBlocks + real block-state age checks (minecraft-data confirms wheat/carrots/
//     potatoes mature at age 7, beetroots at age 3 -- no separate "ready" flag exists), digs it,
//     and replants from the harvested drop when one's held. "ACTION HARVEST" added to
//     classifyIntent for direct-command parity with every other action.
// (3) Animal breeding: new "breed" action (actions.js 1.15.0) finds two same-species animals
//     within 24 blocks, equips the right feed per species, and bot.activateEntity()s each in turn
//     (confirmed as the real feed-to-breed mechanic against mineflayer's inventory.js source --
//     no dedicated "breed" API exists). "ACTION BREED <species>" added to classifyIntent.
// (4) Enchanting: new "enchant" action (actions.js 1.15.0) opens an enchanting table with the
//     target item plus lapis, waits for the real options to populate, and takes the
//     cheapest/first available enchantment (confirmed against mineflayer's
//     enchantment_table.js -- .enchantments exposes real .level/.expected per slot, not a fixed
//     three-slot table). "ACTION ENCHANT <item_id>" added to classifyIntent.
//
// 2.16.0 (2026-09-07) -- direct request "do all" on a further four autonomy ideas:
// (1) death/respawn handling: new bot.on("death")/second bot.on("spawn") pair (confirmed against
//     mineflayer's health.js source: respawn is automatic, 'spawn' re-emits after it). Abandons
//     her standing goal on death (its assumptions about her gear/inventory are now stale) and
//     tries the new "recover" action (actions.js 1.14.0) to get back to her death spot before
//     vanilla's 5-minute item despawn timer.
// (2) true mid-action self-defense interrupt: new real-time bot.on("health") listener,
//     explicitly deferred as "a bigger design decision" when self-defense first shipped.
//     Force-cancels whatever's physically running via the same primitives stopCurrent() uses
//     (no changes needed to any existing busy/acting call site), then waits briefly for that to
//     naturally release the mutex before fleeing through the normal safe path.
// (3) base/chest storage: new checkInventoryFull() (20s timer, same idle-tick pattern as
//     checkSleep) stores the largest non-essential stack via the new "store" action once down to
//     3 or fewer empty slots. "ACTION STORE"/"ACTION TRADE" also added to classifyIntent.
// (4) villager trading: "ACTION TRADE <item_id>" wired as a direct command only (see actions.js
//     1.14.0's own comment on why it's not in the goal planner's vocabulary).
//
// 2.15.0 (2026-09-07) -- direct follow-up to "look for more ways to improve their autonomy," all
// four built together:
// (1) Cross-bot goal coordination: new Buzz topic "minecraft-coordination" (hermes-buzz.py
//     2.0.18, deliberately separate from "minecraft" -- see that topic's own comment on why).
//     Every goal state change (set, done, abandoned, stopped) broadcasts; otherBotGoal tracks
//     the other bot's current goal and feeds both proposeOwnGoal and planNextStep, so a real
//     collision observed live tonight (both bots picking "get copper armor" at once, both
//     burning attempts on the same occupied furnaces) has a real chance of not repeating.
// (2) Environmental memory: planNextStep now searches the existing long-term memory (same
//     corpus generateReply already uses for chat) using the goal description as the query, and
//     a mine/loot/smelt failure that survived actions.js's own wander-retry ("even after
//     looking around") writes a world-scoped note -- "no oak_log nearby" no longer has to be
//     rediscovered from scratch by both bots across every separate goal cycle.
// (3) Hunger: new checkHunger() on its own 15s timer, same idle-tick pattern as checkSleep --
//     eats proactively via the new "eat" action (actions.js 1.13.0) once below 18/20 food.
// (4) Bot-to-bot help: new "ACTION REQUEST <item_id> <count>" (goalTick handles it directly,
//     Buzz-only, never touches performAction) lets a genuinely stuck bot ask the other one for
//     an item over "minecraft-coordination"; the receiving bot checks her own inventory in the
//     topic handler and, if she can help, a new checkPendingGiveRequests() (10s timer) delivers
//     it via the new "give" action (paths to the requester, then bot.toss()). "ACTION EAT"/
//     "ACTION GIVE" also added to classifyIntent for direct-command parity with every other
//     action.
//
// 2.14.1 (2026-09-07) -- fifth and last of five scoped enhancements: tighter DONE validation.
// goals.js 1.1.0's new `sawSuccess` field (set whenever any real step logs ok=true) lets goalTick
// tell a DONE claim backed by real progress from one that isn't -- a real hallucinated DONE was
// observed live tonight (a goal reporting complete after every logged step had failed). Flagged
// in the console (SUSPICIOUS DONE), not blocked -- refusing the model's own DONE outright risks a
// worse failure mode (an endless "are you sure" loop) than the rare cosmetic mislabeling this
// catches. Matched by hermes-minecraft-triage.py's own patterns so the Firmament's own triage
// service surfaces it too, not just a human reading this bot's log directly.
//
// 2.14.0 (2026-09-07) -- fourth of five scoped enhancements: self-defense. New checkSelfDefense()
// on its own short timer (7s -- more time-sensitive than sleep's 30s), same idle-tick/busy-acting
// pattern as checkSleep() -- flees (actions.js 1.12.0's new "flee") below half health with a
// threat nearby, otherwise fights via the existing "attack." Deliberately the idle-tick version
// scoped up front, not a true mid-action interrupt (see actions.js's own comment on why that's a
// bigger design decision). "ACTION FLEE" also added to classifyIntent for direct-command parity
// with every other action.
//
// 2.13.1 (2026-09-07) -- third of five scoped enhancements: cave-pathfinding cap. Real evidence
// from tonight's own OOM crashes (hermes-minecraft-triage.py's log) traced to
// bot.pathfinder.searchRadius's DEFAULT of -1, confirmed by reading mineflayer-pathfinder's own
// source (index.js/astar.js) -- "don't limit the search area" at all. thinkTimeout (5000ms
// default) only bounds wall-clock time, not how many node objects get allocated within that
// window; in complex cave terrain that was enough to hit 25,000+ visited nodes and exhaust the
// heap before the timeout even fired. Set to 128 -- real headroom over every target distance this
// codebase actually asks for, while directly bounding the pathological case.
//
// 2.13.0 (2026-09-07) -- direct follow-up to "what other logic enhancements are available,"
// first two of five scoped and built in order: "ACTION PLACE <item_id>" wired throughout
// (classifyIntent so a player can ask directly, planNextStep's vocabulary and SMELT/CRAFT
// guidance -- placing a spare furnace/table she's carrying is now the preferred fallback over
// giving up or looting, proposeOwnGoal's own placement claim corrected to match). Explore/wander
// (actions.js 1.11.0's wanderAndRetryFind()) needed no wiring here -- it's internal to
// mine/loot/smelt's own existing "not found" handling, not a new verb the planner needs to know.
//
// 2.12.3 (2026-09-07) -- real gap found live: both bots kept self-proposing the exact same goal
// (e.g. "smelt some copper") immediately after giving up on it, since proposeOwnGoal had no
// memory of what she'd just tried -- an unproductive loop across separate goal cycles, distinct
// from and not fixed by anything within a single goal's own retry/consecutiveFailures logic. New
// recentGoalOutcomes (small, capped) records every done/gave-up outcome and gets folded into the
// self-propose prompt as data to reason about, not a hard blocklist -- sometimes repeating IS
// right (e.g. she just looted fuel she didn't have before).
//
// 2.12.2 (2026-09-07) -- two real gaps found live minutes after smelting shipped: (1) planNextStep
// never told the planner SMELT needs fuel, or what to do about it -- a bot with raw copper but no
// coal/charcoal/logs just kept retrying the same smelt attempt and gave up 3/3. Prompt now says
// to mine a log (valid fuel) if smelting fails for lack of fuel, same "mine the missing raw
// material" pattern already taught for crafting. (2) actions.js 1.10.1 fixes the matching root
// cause: SMELT's <item_id> is supposed to be the OUTPUT, but the planner sometimes named the
// INPUT raw material instead and got a confusing rejection -- now accepts either.
//
// 2.12.1 (2026-09-07) -- direct request: "they can't seem to find the furnaces." Most of
// tonight's goal-loop failures were bots correctly reasoning they needed an ingot and having no
// way to get one beyond hoping a chest had it -- real gap, not a bug: nothing here ever taught
// them furnaces exist. New "smelt" action (actions.js 1.10.0) wired in throughout: classifyIntent
// gets "ACTION SMELT" (a player can ask directly, same as every other action), planNextStep's
// prompt now teaches SMELT as the primary path for a smelted item (raw material -> furnace, not
// a crafting-table recipe, which can never produce one) with LOOT as the fallback rather than
// the only option, and proposeOwnGoal no longer tells a bot she has no furnace at all -- all
// three previously said "NO furnace/smelting capability," which was true when written and is
// simply no longer accurate now.
//
// 2.12.0 (2026-09-07) -- direct request: "the bots need to know to go to sleep at night." New
// checkSleep(), on its own 30s timer, entirely separate from goalTick's model-driven loop --
// deciding whether it's night needs no reasoning, just bot.time.timeOfDay (mineflayer core,
// matched to the exact window bed.js's own bot.sleep() enforces). Reuses busy/acting so a live
// command always takes precedence and interrupts a night's sleep (actions.js 1.9.0's stopCurrent
// now forces a wake for that). The real per-bed logic (finding one, trying it, waiting for
// morning) lives in actions.js's new "sleep" action, built on mineflayer's own bed.js plugin.
// Also added "ACTION SLEEP" to classifyIntent's vocabulary so a player can directly tell her to
// go to bed too, same as every other action.
//
// 2.11.6 (2026-09-07) -- two more fixes minutes after 2.11.5's token-budget bump: (1) the SAME
// truncation failure as 2.11.3 recurred at the doubled 220-token budget -- the model still
// doesn't reliably keep its reasoning to one sentence, so the budget went to 500 instead of a
// third incremental guess. (2) the loot-before-BLOCKED instruction (2.11.2) was ignored a second
// time -- the model stated its own reasoning ("no prior LOOT attempt...") and went BLOCKED
// anyway. This specific condition is simple and mechanically checkable (has "loot:" ever
// appeared in this goal's own log?), so goalTick now enforces it in code as a backstop rather
// than trusting a written instruction alone a second time.
//
// 2.11.4 (2026-09-07) -- real gap found live minutes after 2.11.3 shipped: even with the
// loot-before-BLOCKED requirement (2.11.2), a self-proposed goal phrased around an impossible
// METHOD ("smelt the copper into ingots") made the planner treat the goal as literally requiring
// that verb and go BLOCKED immediately, reasoning "the goal explicitly asks to smelt" -- never
// trying LOOT even though Recent progress was empty. The instruction to reinterpret charitably
// wasn't enough once the goal text itself named an impossible verb. Real fix is upstream:
// proposeOwnGoal's prompt now requires goals be phrased around the OUTCOME wanted ("get some
// copper armor"), never a specific method she can't perform ("smelt X", "build X") -- an
// outcome-phrased goal leaves room for the planner to reach it by looting instead.
//
// 2.11.3 (2026-09-07) -- two more real gaps found live within minutes of 2.11.2 shipping: (1) a
// factually-confused self-proposed goal ("smashing cobblestone into planks" -- planks come from
// logs, not stone) made the planner ramble past its one-sentence reasoning budget and get cut
// off by maxTokens before reaching its required final decision line -- parseGoalStep's fallback
// then counted as a real strike for a goal that was never fairly evaluated. Fixed at both ends:
// proposeOwnGoal's prompt now states the same real crafting facts planNextStep already knew, and
// planNextStep's own budget went from 120 to 220 tokens plus an explicit "reinterpret charitably,
// always end with a decision line" instruction. (2) a bot self-proposed "build a warm little
// house" -- building/placing was explicitly out of scope from this system's first design pass
// (MINECRAFT_BOTS_DESIGN.md §5) and no such action exists at all, so she'd have mined materials
// forever with no way to ever finish. Both prompts now say so explicitly.
//
// 2.11.2 (2026-09-07) -- real gap found live minutes after 2.11.1's reasoning fix shipped: Amy
// correctly reasoned, three separate times, that an ingot she needed could only come from
// looting a chest -- and then went BLOCKED anyway without ever actually issuing ACTION LOOT to
// check one. Correct diagnosis, no follow-through. planNextStep's prompt now explicitly requires
// a LOOT attempt to actually appear in Recent progress before BLOCKED is allowed for that reason.
//
// 2.11.1 (2026-09-07) -- real gap found live within minutes of 2.11.0 shipping: every goal-loop
// transition (a step taken, DONE, BLOCKED, giving up) only ever reached the player via bot.chat
// (in-game) or the goal's own persisted log -- nothing printed to console/journalctl, so a crash
// inside a step (see actions.js 1.8.1) left no trace to diagnose from except reading goal.json
// directly after the fact. Added explicit console.log for every one of these transitions --
// same "correctness/diagnosability over log-volume minimalism" instruction that made 2.10.0's
// path_update logging permanent.
//
// Firmament Minecraft bot orchestrator. Connects one bot and wires the first real decision
// loop: chat perception -> cheap relevance classification (dispatch role) -> in-character
// reply (muse role) -> bot chats back. See ../../MINECRAFT_BOTS_DESIGN.md.
//
// 2.11.0 (2026-09-07) -- direct request: "give her more autonomy to work towards longer goals,"
// with a real fork resolved by direct instruction: goals can come from a player (new "ACTION
// GOAL <description>" verb, classifyIntent's existing one-call vocabulary) OR the bot can
// propose her own once she's had no active goal and heard from no one for a while. Either way,
// a goal persists (goals.js, survives restart the same way inventory does) and gets worked one
// step at a time on its own timer (goalTick, MC_GOAL_TICK_MS) through the *same* performAction()
// pipeline a direct chat command already uses -- a standing goal is never a separate, less-
// tested way of moving/mining/fighting/crafting/looting. The tick only ever fires when nothing
// else has the bot's attention (`busy`/new `acting` flag), so a live player command always wins
// immediately and the goal loop just resumes on its own next tick once that command's action
// finishes -- no separate interrupt/resume logic needed, it falls out of the existing mutex.
// `ACTION STOP` now also abandons any active goal (matches the plain-English expectation that
// "stop" means stop everything, not just the current physical motion). performAction() needed a
// structural success/failure signal for this (actions.js 1.8.0, { ok, text } instead of a bare
// string) rather than regex-guessing "ok" from English result text, which would silently break
// the moment a message's wording changed.
//
// 2.10.0 (2026-09-07) -- direct report: navigation is unreliable around doors/ladders/stairs.
// mineflayer-pathfinder defaults canOpenDoors to false with its own comment ("Causes issues.
// Probably due to none paper servers.") -- enabled now that this fleet runs a mature, fully-
// supported version (1.21.11) rather than trusting a comment of unknown vintage. Also added
// permanent path_update/goal_reached/path_reset logging (astar's own real status/cost/visited-
// node data) so any future navigation failure is diagnosable from real data, not guesswork --
// kept permanently per direct instruction: correctness/diagnosability over call/log-volume
// minimalism, since everything here runs on local compute with no per-call cost.
//
// 2.9.0 (2026-09-06) -- direct request: "pre-teach the most common recipes." New "craft"
// action (classifyIntent detects it the same one-call way as every other action; the real
// implementation is actions.js's craftItem(), which uses minecraft-data's own built-in recipe
// knowledge rather than anything taught here).
//
// 2.8.0 (2026-09-06) -- direct request: bots should look in chests for gear, wear the best
// armor they find, and hold the best weapon unless a task needs a specific tool. New "loot"
// action (equipment.js + actions.js); gear is rechecked automatically after mine/attack/loot
// and once at spawn (inventory persists across restarts -- it's tied to the player's UUID in
// the world save). Crafting and building are still explicitly out of scope for this pass.
//
// 2.7.0 (2026-09-06) -- real in-world actions (actions.js): navigate (goto/follow/stop),
// gather (mine), and fight (attack) -- closing the gap between what the personas' Core
// Directives always claimed and what the bots could actually do. classifyIntent() replaces
// the old plain-YES/NO isRelevant() with one dispatch call that also detects an action
// request, keeping the "one cheap call" efficiency discipline intact rather than adding a
// second round-trip. Actions run in the background via runAction(), deliberately outside the
// `busy` window that guards the classify/reply step -- a mine/follow/attack can run for up to
// a minute (actions.js's own ACTION_TIMEOUT_MS), and holding that mutex for the whole span
// would make the bot go silent to chat while she works. Building/structure placement stays
// explicitly out of scope -- a much bigger feature (planning, materials, layout) that deserves
// its own pass, not something to half-build alongside navigate/gather/fight.
//
// 2.6.0 (2026-09-06) -- Matrix wired (design doc §10, matrix.js): a single shared room
// (operator's own decision, not one room per bot like the retired Sintra/Amy pattern), both
// bots and the operator as members. Talks directly to Continuwuity's Client-Server API, not
// the fleet's old "hermes gateway" tool (built around the different per-agent-room
// architecture). New Matrix accounts (mc-babs, mc-amy) registered via the standard
// enable-registration/create/re-lock recipe in infra/continuwuity/README.md. Credentials in
// ~/.hermes/minecraft-matrix.env, not Vaultwarden -- see run-bot.sh 1.3.0's own note on why.
// Reuses handleIncoming() exactly as public chat/whisper already did -- the isAnotherBot()
// guard (renamed from the Buzz-era BOT_USERNAMES-only check) now also recognizes any `@mc-`
// Matrix identity, so the same bot-relaying-into-a-shared-channel feedback loop 2.5.0 fixed for
// Buzz->in-game-chat can't happen for Matrix either.
//
// 2.5.0 (2026-09-06) -- bot-to-bot coordination over hermes-buzz.py (design doc §9, buzz.js).
// Every WORLD-scoped long-term memory (see maybeRemember) is also published to the shared
// `minecraft` Buzz topic; each bot subscribes and relays what it hears from other bots into
// in-game chat, a directly observable trace that coordination happened. Real feedback-loop
// risk found and fixed while building this: every bot is just another player to mineflayer, so
// without a guard, Babs relaying a Buzz message into public chat would trigger Amy's own `chat`
// listener and send her down the normal human-reply pipeline (and vice versa) -- MC_BOT_USERNAMES
// now excludes known bot identities from that pipeline entirely; bot-to-bot traffic stays on
// Buzz, never the chat-relevance loop meant for human players.
//
// 2.4.0 (2026-09-06) -- long-term memory via the new "minecraft" hermes-rag corpus (design doc
// §7, longterm.js): before each reply, a semantic search over past notes (both this bot's own
// and shared world facts) is folded into the muse call's system message. After each reply
// (never blocking it -- see maybeRemember's own comment), a cheap dispatch call decides
// whether the exchange contained anything worth remembering long-term and writes it as a small
// markdown note, reindexed immediately (content-hash dedup keeps repeat reindexes cheap).
//
// 2.3.0 (2026-09-06) -- persistent per-bot conversation memory via hermes-memory.py (design
// doc §7): every incoming line and every reply is recorded as a turn (agent=mc-<persona>,
// conv_id=mc-<persona>:<speaker>), and recent history for that speaker is read back before
// each reply -- she now remembers a conversation across restarts, not just within one process
// lifetime. Run via run-babs.sh, which fetches MEMORY_TOKEN from Vaultwarden once at startup
// (fetch-once-at-startup, same pattern every other fleet caller of hermes-memory uses) --
// running index.js directly without it still works, just stateless (memory.js's own
// best-effort fallback), same as before this version.
//
// 2.2.0 (2026-09-06) -- Boss registration: BOSS_USERNAMES resolves a real in-game username to
// the "Boss" role a persona file can reference (see agents/minecraft-babs/PROMPT.md's
// Behavioral Modifiers) without the persona file itself hardcoding an identity. Orchestrator's
// job, not the persona's -- CanisLupisM registered as the first Boss identity.
//
// 2.1.0 (2026-09-06) -- whisper handling: /msg, /tell, /w fire mineflayer's separate `whisper`
// event, not `chat` -- confirmed live (a real /tell produced no log line under 2.0.0). Replies
// to a whisper go back as a whisper, and skip the relevance check entirely since a whisper is
// already addressed to her by construction.
//
// 2.0.0 (2026-09-06) -- decision loop wired for the first time, replacing 1.0.0's pure
// connectivity-proof scaffolding. Deliberately minimal still: no memory (hermes-memory/
// hermes-rag), no Buzz, no Matrix -- one bot, one persona, one loop, proven end to end before
// any of that gets added. A `busy` flag serializes decisions per bot rather than letting
// concurrent chat lines pile up parallel router calls -- matches the design doc's own
// efficiency principle (§5): don't spend a model call faster than the previous one resolved.

import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { callRole } from "./router.js";
import { loadPersona } from "./persona.js";
import { recordTurn, recentTurns } from "./memory.js";
import { searchMemory, writeMemoryNote } from "./longterm.js";
import { publish as buzzPublish, watchTopic } from "./buzz.js";
import { watchRoom, sendMessage as matrixSend } from "./matrix.js";
import { loadActionPlugins, performAction, nearestHostile, isEssentialItem } from "./actions.js";
import { equipBestArmor, equipBestWeapon, describeGear } from "./equipment.js";
import { loadGoal, saveGoal, clearGoal, newGoal, logStep, loadStuckState, saveStuckState } from "./goals.js";
import { SwimMovements } from "./swim-movements.js";
import { findSkill, runSkill, recordSkillOutcome, authorSkillFromGoal } from "./skills.js";

const { pathfinder, goals } = pathfinderPkg;

const HOST = process.env.MC_HOST || "192.168.1.221";
const PORT = parseInt(process.env.MC_PORT || "25580", 10);
const USERNAME = process.env.MC_BOT_USERNAME || "Babs";
const PERSONA_NAME = process.env.MC_BOT_PERSONA || USERNAME.toLowerCase();
const MAX_CHAT_LEN = 200;

// "The Boss" is a role a persona file can reference (see agents/minecraft-babs/PROMPT.md's
// Behavioral Modifiers) without the persona file itself needing to know a real username --
// identity resolution belongs to the orchestrator, not the persona. Registered here rather
// than in a config file since no config system exists yet; comma-separated for more than one
// in-game account later.
const BOSS_USERNAMES = (process.env.MC_BOSS_USERNAMES || "CanisLupisM,@phone1:spark")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isBoss(speaker) {
  return BOSS_USERNAMES.includes(speaker);
}

// Every bot is also just another player in mineflayer's eyes -- without this, Babs relaying a
// Buzz message into public chat (see the watchTopic handler below) would fire Amy's own `chat`
// listener and send her down the normal human-reply pipeline, and vice versa: an endless
// bot-reacts-to-bot loop. Known bot identities are excluded from that pipeline entirely;
// coordination between them happens over Buzz, not the in-game chat relevance/reply loop.
const BOT_USERNAMES = new Set(
  (process.env.MC_BOT_USERNAMES || "Babs,Amy,Mark,Luke,Mayor").split(",").map((s) => s.trim()).filter(Boolean),
);

function isAnotherBot(speaker) {
  return BOT_USERNAMES.has(speaker) || speaker.startsWith("@mc-"); // Matrix bot identities
}

// Direct request, 2026-09-08 ("add another bot, Mayor, whose personality is to be a leader and
// set goals for the others. The others can defer to him when his instructions are not in
// conflict"). Every other bot's own chat stays coordinate-over-Buzz-not-chat (isAnotherBot's own
// original reasoning, unchanged) -- Mayor is the one deliberate exception, since his whole
// purpose requires a directive to actually reach the other bots' real decision loop
// (classifyIntent -> ACTION GOAL), the same path a player's own instruction already takes.
// Matches on both the plain in-game name and his Matrix identity (@mc-mayor:spark), the two
// forms isAnotherBot() itself already recognizes.
const MAYOR_USERNAME = process.env.MC_MAYOR_USERNAME || "Mayor";
function isMayor(speaker) {
  return speaker === MAYOR_USERNAME || speaker === `@mc-${MAYOR_USERNAME.toLowerCase()}:spark`;
}

// Autonomy (standing goals): a whole-bot kill switch, an idle-before-self-proposing-a-goal
// window (real chat/whisper/Matrix/goal-setting all count as "not idle" -- see lastActivityAt),
// and a tick interval for actually working a goal. Since everything here runs on local compute
// with no per-call cost (direct instruction, 2026-09-06), 45s errs toward checking in often and
// reasoning carefully each time rather than stretching the interval to save calls.
const AUTONOMY_ENABLED = (process.env.MC_AUTONOMY_ENABLED ?? "true") !== "false";
const SELF_PROPOSE_GOALS = (process.env.MC_SELF_PROPOSE_GOALS ?? "true") !== "false";
const GOAL_TICK_MS = parseInt(process.env.MC_GOAL_TICK_MS || "45000", 10);
const IDLE_BEFORE_SELF_GOAL_MS = parseInt(process.env.MC_IDLE_SELF_GOAL_MS || "600000", 10); // 10 min
const MAX_CONSECUTIVE_FAILURES = 3;

// Matrix (design doc §10): a single shared room, operator + all bots -- the operator's own
// decision, a deliberate deviation from the retired Sintra/Amy per-agent-room pattern. Talks
// directly to Continuwuity's Client-Server API (matrix.js), not the old "hermes gateway" tool,
// which was built around that different architecture. Optional: if MATRIX_ACCESS_TOKEN isn't
// set, the bot simply doesn't join Matrix, same as every other best-effort integration here.
const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER || "http://10.129.1.15:6167";
const MATRIX_USER_ID = process.env.MATRIX_USER_ID || `@mc-${PERSONA_NAME}:spark`;
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || "";
const MATRIX_ROOM_ID = process.env.MATRIX_ROOM_ID || "!2rXcMwykUS2yVNTLGw:spark";

// mc-<persona> matches the design doc's own Buzz-identity convention (§9) -- reused here as
// the hermes-memory agent id so the same name means the same thing everywhere this bot shows
// up. One conv_id per speaker: a bot's memory of "the conversation with CanisLupisM" spans
// both public chat and whispers, rather than splitting by channel for no real benefit.
const AGENT_ID = `mc-${PERSONA_NAME}`;
const TASK_ID = `${AGENT_ID}-chat`;
const HISTORY_TURNS = 8;

function convId(speaker) {
  return `${AGENT_ID}:${speaker}`;
}

const persona = loadPersona(PERSONA_NAME);
console.log(`[${USERNAME}] loaded persona '${PERSONA_NAME}' (${persona.length} chars)`);

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: "offline",
});

bot.loadPlugin(pathfinder);
loadActionPlugins(bot);

bot.once("spawn", async () => {
  console.log(`[${USERNAME}] spawned at`, bot.entity.position);
  // SwimMovements (swim-movements.js): stock Movements can walk across open water at a
  // constant Y-level but can never change depth once already in it -- see that file's own
  // comment for the confirmed library gap this closes (water crossings only, lava unaffected).
  const movements = new SwimMovements(bot);
  // mineflayer-pathfinder defaults canOpenDoors to false, with its own comment: "Causes
  // issues. Probably due to none paper servers." Direct report: bots navigate badly around
  // doors, ladders, and stairs -- doors are the one of those three with a known, named,
  // library-level default working against them. Worth enabling now that this fleet runs a
  // mature, well-supported version (1.21.11) rather than trusting a comment of unknown
  // vintage -- if it turns out to genuinely misbehave here, that's diagnosable from the
  // path_update logging below, not a reason to leave it off untested.
  movements.canOpenDoors = true;
  // Real incident tonight: Amy drowned repeatedly because her death spot (and separately, a bed
  // she'd used) sat right at open water, and every path back to either simply waded straight
  // through. Confirmed against mineflayer-pathfinder's own astar.js: liquidCost (default 1, the
  // same as a normal step) adds to a node's cost when it's inside a liquid -- barely a
  // deterrent. Raised well above a typical land route's cost so pathfinder strongly prefers dry
  // ground when one exists within its search radius, while still leaving water crossable (just
  // deprioritized) when it's genuinely the only way through -- not banned outright, since that
  // would strand her at any water-crossed goal with no alternative route.
  movements.liquidCost = 20;
  bot.pathfinder.setMovements(movements);

  // Direct follow-up to "what other logic enhancements are available" -> cave-pathfinding cap:
  // real evidence from tonight's own OOM crashes (hermes-minecraft-triage.py's own log) traced
  // to bot.pathfinder.searchRadius's DEFAULT VALUE OF -1 (confirmed in mineflayer-pathfinder's
  // own index.js/astar.js) -- "don't limit the search area" at all. thinkTimeout (default 5000ms)
  // only bounds wall-clock time, not how many node objects get allocated within that window --
  // in complex cave terrain, that was enough to hit 25,000+ visited nodes and exhaust the V8
  // heap before the timeout even fired.
  //
  // Lowered from 128 to 48, 2026-09-07 (chasing the same all-day recurring OOM the coder/coder2
  // triage service kept flagging): 128 bounded any ONE search, but not how OFTEN a search
  // reruns. Confirmed against mineflayer-pvp's own source: attack() sets a DYNAMIC GoalFollow
  // (pathfinder.setGoal(goal, true)) to chase its target, and mineflayer-pathfinder's own tick
  // loop calls resetPath('goal_moved') -- discarding the current search and starting a fresh one
  // -- every time stateGoal.hasChanged() is true, with no debounce of its own. Against an
  // erratically-flying target (a phantom, live evidence: 419 path_update lines in under 30
  // seconds fighting one, "goal_moved" the single largest reason), that's a fresh full search
  // firing on nearly every tick, each one visiting well into the thousands of nodes within the
  // old 128-block radius -- allocation pressure high enough to exhaust the heap in under a
  // minute even though each individual search was, technically, bounded. 48 still gives real
  // headroom over every real target distance this codebase asks for outside combat (mine/loot/
  // smelt/wander are all well under 64 blocks, and combat pursuit only ever needs to close a
  // much shorter gap than that) while directly cutting the cost of each of those rapid-fire
  // recomputes, since the recompute FREQUENCY itself isn't something this codebase can bound
  // without patching mineflayer-pvp/mineflayer-pathfinder directly.
  bot.pathfinder.searchRadius = 48;

  // Direct request, 2026-09-07 ("check the Firmament coder logs... yes... yes" -- three rounds
  // deep into the same all-day OOM). A real heap snapshot (--heapsnapshot-near-heap-limit, taken
  // automatically right before an actual crash) showed the dominant memory cost wasn't
  // pathfinding nodes at all -- it was ~2.5M V8 Context objects, ~1M Generators, ~1M Promises,
  // and 514,115 EACH of closures literally named step/fulfilled/rejected/adopt (the compiled
  // TypeScript `__awaiter` helper used by mineflayer-collectblock/-tool/-pvp). Tracing their
  // retainers confirmed they're rooted via (Stack roots)/(GC roots) -- genuinely PENDING
  // promises that never settled, not simply forgotten references. Root cause, confirmed against
  // astar.js's own compute(): it's a fully synchronous `while` loop, checked against elapsed
  // time only at the top of each iteration, bounded by tickTimeout (default 40ms per chunk) and
  // thinkTimeout (default 5000ms total ceiling) -- meaning a single hard search can legitimately
  // hog Node's single-threaded event loop in ~40ms synchronous chunks for up to 5 STRAIGHT
  // SECONDS, with negligible time handed back in between (live evidence matches exactly: 28
  // consecutive path_update lines each ~40-50ms apart, zero gap). While starved like that,
  // nothing else -- Buzz polling, Matrix, incoming Minecraft packets, any already-resolved
  // promise's own .then() -- gets a turn, so anything scheduled during that window piles up
  // unsettled. Repeated searches (goal_moved/block_updated kept re-triggering fresh ones) could
  // hit this ceiling over and over. Lowered thinkTimeout to 1000ms (real searches this codebase
  // asks for complete in well under 100ms per the very same live evidence; only the pathological
  // cases were ever hitting the old 5000ms ceiling) and tickTimeout to 20ms (smaller synchronous
  // chunks, more frequent opportunities for the event loop to interleave other work between
  // them) to bound the worst case far short of where it was.
  bot.pathfinder.thinkTimeout = 1000;
  bot.pathfinder.tickTimeout = 20;

  // Real-data visibility into navigation, not a guess: astar's own result status
  // ('success'/'partial'/'noPath'/'timeout') for every path (re)computation, so a bad
  // goto/follow (doors, ladders, stairs -- direct report, 2026-09-06) can be diagnosed from
  // what pathfinder itself actually concluded, the same evidence-based approach that found
  // every other real bug this build. Kept permanently, not stripped after one use --
  // correctness/diagnosability over minimizing log volume, per direct instruction.
  bot.on("path_update", (r) => {
    console.log(`[${USERNAME}] path_update status=${r.status} nodes=${r.path?.length ?? 0} ` +
                `visited=${r.visitedNodes ?? "?"} cost=${r.cost?.toFixed?.(1) ?? "?"} ` +
                `time=${r.time?.toFixed?.(0) ?? "?"}ms`);
  });
  bot.on("goal_reached", () => console.log(`[${USERNAME}] goal_reached`));
  bot.on("path_reset", (reason) => console.log(`[${USERNAME}] path_reset: ${reason}`));

  // Inventory persists across restarts (it's tied to the player's UUID in the world save, not
  // this process) -- worth checking gear right away, not only after an action changes it.
  equipBestArmor(bot).then(() => equipBestWeapon(bot)).catch((err) =>
    console.error(`[${USERNAME}] initial gear check failed:`, err.message));

  // Direct request, 2026-09-07 ("if a bot gets stuck... teleport... rather than continually
  // restart"). Real evidence: Babs reconnected at the EXACT SAME coordinate across seven
  // consecutive restarts over 9 minutes -- Minecraft persists player position across reconnects
  // just like a real player logging back in, so a crash-and-restart cycle does nothing for a bot
  // wedged in terrain; she just gets stuck again immediately. If something ELSE is also
  // crash-looping her every minute or two, checkStuck's own multi-minute in-process threshold
  // may never even complete one cycle before the next restart wipes its counters -- comparing
  // THIS fresh spawn's position against wherever she was saved right before the process went
  // down catches that compound case immediately, rather than needing to survive long enough in
  // one continuous run to notice on its own.
  try {
    const prior = await loadStuckState(PERSONA_NAME);
    const pos = bot.entity.position;
    let closeToLast = false;
    if (prior) {
      const dx = pos.x - prior.x, dy = pos.y - prior.y, dz = pos.z - prior.z;
      closeToLast = Math.sqrt(dx * dx + dy * dy + dz * dz) < RESTART_STUCK_RADIUS;
    }
    currentSameSpotCount = closeToLast ? (prior.sameSpotCount || 0) + 1 : 0;
    await saveStuckState(PERSONA_NAME, { x: pos.x, y: pos.y, z: pos.z, sameSpotCount: currentSameSpotCount });
    if (currentSameSpotCount >= RESTART_STUCK_THRESHOLD) {
      const streak = currentSameSpotCount + 1;
      console.log(`[${USERNAME}] reconnected at essentially the same spot ${streak} times in a ` +
        `row -- likely wedged across restarts`);
      currentSameSpotCount = 0;
      await saveStuckState(PERSONA_NAME, { x: pos.x, y: pos.y, z: pos.z, sameSpotCount: 0 });
      await teleportToSpawn(`reconnected at the same spot ${streak} times in a row`);
    }
  } catch (err) {
    console.error(`[${USERNAME}] cross-restart stuck check failed:`, err.message);
  }
});

// TEMPORARY diagnostic (2026-09-06): both bots hit V8's heap limit and crashed twice in a row,
// at a steady ~4-5 MB/s from very early in the process's life -- not obviously tied to any one
// action. Logging memory + loaded-chunk-column count every 15s to find which subsystem is
// actually leaking before changing anything else. Remove once root-caused.
setInterval(() => {
  const mem = process.memoryUsage();
  const columns = bot.world?.getColumns ? bot.world.getColumns().length : "n/a";
  console.log(`[${USERNAME}] mem rss=${(mem.rss / 1048576).toFixed(1)}MB ` +
              `heap=${(mem.heapUsed / 1048576).toFixed(1)}/${(mem.heapTotal / 1048576).toFixed(1)}MB ` +
              `external=${(mem.external / 1048576).toFixed(1)}MB arrayBuffers=` +
              `${(mem.arrayBuffers / 1048576).toFixed(1)}MB chunks=${columns}`);
}, 15_000);

let busy = false;
// True for the whole span of a directly-requested action (runAction), not just the fast
// classify step `busy` already guards -- the goal loop must never issue its own step while a
// player-requested mine/craft/loot/attack/goto/follow is actually running underneath it.
let acting = false;
let currentGoal = null;
// Updated on every real chat/whisper/Matrix line and every goal set by a player -- the goal
// loop only ever proposes her own goal after this has been quiet a while (IDLE_BEFORE_SELF_GOAL_MS).
let lastActivityAt = Date.now();
// Real gap found live (2026-09-07): with no memory of what she just gave up on, proposeOwnGoal
// kept re-picking the same goal (e.g. "smelt some copper") immediately after giving up on it for
// an environmental reason that hadn't changed (no unoccupied furnace nearby) -- an unproductive
// loop, not a bug in any single step. Capped small (not full history) since only the most recent
// couple of outcomes are relevant to "should I try this again right now."
const RECENT_GOAL_OUTCOMES_MAX = 4;
let recentGoalOutcomes = [];

function recordGoalOutcome(description, outcome, reason) {
  recentGoalOutcomes.push({ description, outcome, reason });
  if (recentGoalOutcomes.length > RECENT_GOAL_OUTCOMES_MAX) recentGoalOutcomes.shift();
}

// Cross-bot coordination (direct follow-up, 2026-09-07: "look for more ways to improve their
// autonomy"), kept current by the "minecraft-coordination" Buzz subscription set up alongside
// the existing "minecraft" one, near the bottom of this file.
//
// Real gap found live, 2026-09-07 ("ask Muse to spawn two more bots, named Mark and Luke"): this
// was a single `let otherBotGoal`, correct only for exactly two bots -- with a 3rd/4th bot on the
// roster, each new Buzz message would just overwrite it, silently losing track of every OTHER
// bot's goal except whichever one posted most recently. Keyed by from_agent instead, so it
// scales to however many bots are actually running.
const otherBotGoals = new Map(); // from_agent -> last-known active goal description
let pendingGiveRequest = null; // {forPlayer, item, count} she's agreed to fulfill, or null

// Shared by planNextStep and proposeOwnGoal (previously two near-identical inline blocks, one
// per singular `otherBotGoal` -- now one function over the Map, listing every other bot with an
// active goal instead of assuming there's only ever one).
function otherGoalsNote(intro) {
  if (!otherBotGoals.size) return "";
  const lines = [...otherBotGoals.entries()].map(([agent, desc]) => `- ${agent}: ${desc}`).join("\n");
  return `\n\n${intro}\n${lines}`;
}

// Deliberately a separate topic from "minecraft" -- see hermes-buzz.py 2.0.18's own comment on
// why (both bots relay everything they hear on "minecraft" into in-game chat; a raw JSON
// coordination payload has no business being read aloud). Best-effort like every other Buzz call
// in this file -- a publish failure here should never break the goal loop that triggered it.
async function broadcastGoalState(status, description) {
  try {
    await buzzPublish(AGENT_ID, "minecraft-coordination",
      JSON.stringify({ type: "goal", status, description }));
  } catch (err) {
    console.error(`[${USERNAME}] goal broadcast failed:`, err.message);
  }
}

// Item #6 of "fix all the above" (squad response for Mark/Luke). Same best-effort broadcast
// pattern as broadcastGoalState -- see checkSelfDefense's own call site for the cooldown that
// keeps one drawn-out fight from spamming this every 2s.
async function broadcastThreatAlert(threatName) {
  try {
    await buzzPublish(AGENT_ID, "minecraft-coordination", JSON.stringify({
      type: "threat", name: threatName,
      x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
    }));
  } catch (err) {
    console.error(`[${USERNAME}] threat alert broadcast failed:`, err.message);
  }
}

loadGoal(PERSONA_NAME).then((g) => {
  currentGoal = g;
  if (g) console.log(`[${USERNAME}] resumed goal: ${g.description} (${g.steps} steps so far)`);
}).catch((err) => console.error(`[${USERNAME}] failed to load saved goal:`, err.message));

// One dispatch call classifies relevance AND detects an action request together, replacing
// the old plain YES/NO relevance check -- same "keep it to one cheap call" efficiency
// discipline the rest of this file already follows (maybeRemember, the old isRelevant this
// replaces). Real verbs only (actions.js): navigate, gather, fight -- no building/placement,
// a deliberately separate, much bigger feature not attempted here.
//
// Real bug found live (2026-09-06): a message addressed to Babs by name also made Amy start
// mining -- each bot's own classifier only ever knew about itself, with no way to recognize
// "this names a DIFFERENT bot" and stand down. OTHER_BOTS below fixes that. Same incident also
// surfaced a second bug: both bots mined "stone" despite neither being asked for it -- with no
// instruction covering "no specific block was actually named," the classifier had to invent
// *something* for ACTION MINE's required <block_id> rather than falling back to CHAT.
const OTHER_BOTS = [...BOT_USERNAMES].filter((n) => n !== USERNAME);

async function classifyIntent(speaker, message) {
  const otherBotsNote = OTHER_BOTS.length
    ? ` Other bots who may also be in this chat: ${OTHER_BOTS.join(", ")} -- if the message ` +
      `clearly names one of them instead of ${USERNAME}, respond NONE even if it looks like an ` +
      `action request.`
    : "";
  const reply = await callRole(
    "dispatch",
    [
      {
        role: "system",
        content:
          `You are an intent classifier for a Minecraft bot named ${USERNAME}, who has real ` +
          `in-game abilities: moving, following, mining/gathering blocks, fighting hostile ` +
          `mobs, checking chests for gear, and crafting items.${otherBotsNote} Given one chat ` +
          `message from another player, respond with EXACTLY ONE line, no explanation, no ` +
          `extra punctuation, in one of these forms:\n` +
          `NONE - not directed at ${USERNAME}, no response needed\n` +
          `CHAT - directed at ${USERNAME} but just conversation, not a request to do something\n` +
          `ACTION GOTO - asks ${USERNAME} to come to the speaker\n` +
          `ACTION FOLLOW - asks ${USERNAME} to follow the speaker\n` +
          `ACTION STOP - asks ${USERNAME} to stop what she is doing\n` +
          `ACTION MINE <block_id> <count> - asks ${USERNAME} to gather/mine a resource, ONLY ` +
          `if a specific resource/block was actually named or clearly implied. <block_id> must ` +
          `be the exact modern Minecraft block id (e.g. oak_log, stone, iron_ore, cobblestone). ` +
          `For a general material class rather than one exact species/color (any wood, any ` +
          `wool, any ore), naming ANY real example of that class is enough -- she'll ` +
          `automatically gather whatever matching variant is actually nearby, not just that ` +
          `exact one. <count> is a small positive integer, default 4 if unstated. If no ` +
          `specific block is named, respond CHAT instead -- never invent a block.\n` +
          `ACTION ATTACK - asks ${USERNAME} to fight a nearby hostile mob\n` +
          `ACTION FLEE - asks ${USERNAME} to run away from a nearby hostile mob instead of fighting it\n` +
          `ACTION LOOT - asks ${USERNAME} to check a nearby chest for anything useful (gear, ` +
          `resources, whatever's in there)\n` +
          `ACTION SLEEP - asks ${USERNAME} to go find a bed and sleep (only makes sense at ` +
          `night or during a thunderstorm)\n` +
          `ACTION EAT - asks ${USERNAME} to eat some food from her inventory\n` +
          `ACTION FISH - asks ${USERNAME} to fish at nearby water with a fishing rod\n` +
          `ACTION GIVE <item_id> <count> - asks ${USERNAME} to give the speaker some of an item ` +
          `she's carrying (e.g. "give me some bread"). <count> is a small positive integer, ` +
          `default 1 if unstated.\n` +
          `ACTION STORE <item_id> <count> - asks ${USERNAME} to put some of an item she's ` +
          `carrying into a nearby chest. <count> is a small positive integer, default all of it ` +
          `if unstated.\n` +
          `ACTION TRADE <item_id> - asks ${USERNAME} to trade with a nearby villager for a ` +
          `specific item she wants\n` +
          `ACTION HARVEST - asks ${USERNAME} to pick a ripe crop nearby and replant it, or, if ` +
          `nothing is ripe yet, till open ground and plant seeds she's carrying to start a new ` +
          `farm\n` +
          `ACTION EXPLORE - asks ${USERNAME} to go looking for any useful raw material (wood, ` +
          `ore) when no specific one was named. No parameters.\n` +
          `ACTION BREED <species> - asks ${USERNAME} to breed two nearby animals of the same ` +
          `kind (e.g. cow, sheep, pig, chicken) using the right food\n` +
          `ACTION ENCHANT <item_id> - asks ${USERNAME} to enchant an item she's carrying at a ` +
          `nearby enchanting table (needs lapis lazuli)\n` +
          `ACTION CRAFT <item_id> <count> - asks ${USERNAME} to craft/make an item, ONLY if a ` +
          `specific item was actually named or clearly implied. <item_id> must be the exact ` +
          `modern Minecraft item id (e.g. stick, oak_planks, wooden_pickaxe, crafting_table). ` +
          `<count> is a small positive integer, default 1 if unstated. If no specific item is ` +
          `named, respond CHAT instead -- never invent one.\n` +
          `ACTION SMELT <item_id> <count> - asks ${USERNAME} to smelt ore into an ingot (or ` +
          `similar) at a furnace, ONLY if a specific output was actually named or clearly ` +
          `implied (e.g. iron_ingot, copper_ingot, gold_ingot, glass, stone). <count> is a small ` +
          `positive integer, default 1 if unstated.\n` +
          `ACTION PLACE <item_id> - asks ${USERNAME} to place ONE block she's carrying right next ` +
          `to herself (e.g. a furnace or crafting_table she crafted). For a single utility block, ` +
          `not a structure -- use ACTION BUILD for that instead.\n` +
          `ACTION BUILD - asks ${USERNAME} to build a small shelter (walls, a doorway, a roof) ` +
          `around herself using whatever solid block she has the most of. No parameters.\n` +
          `ACTION GOAL <description> - gives ${USERNAME} a standing objective to keep working ` +
          `on by herself over time (not a single one-off task), e.g. "get full iron armor" or ` +
          `"stock up on wood". Only use this if the speaker is clearly assigning an ongoing ` +
          `objective, not just asking for one immediate thing. <description> is a short phrase.`,
      },
      { role: "user", content: `<${speaker}> ${message}` },
    ],
    { maxTokens: 16, temperature: 0 },
  );
  const trimmed = reply.trim().toUpperCase();
  if (trimmed.startsWith("ACTION")) {
    const parts = trimmed.split(/\s+/);
    const verb = parts[1];
    if (verb === "GOTO") return { type: "action", action: { type: "goto" } };
    if (verb === "FOLLOW") return { type: "action", action: { type: "follow" } };
    if (verb === "STOP") return { type: "action", action: { type: "stop" } };
    if (verb === "ATTACK") return { type: "action", action: { type: "attack" } };
    if (verb === "FLEE") return { type: "action", action: { type: "flee" } };
    if (verb === "EAT") return { type: "action", action: { type: "eat" } };
    if (verb === "FISH") return { type: "action", action: { type: "fish" } };
    if (verb === "LOOT") return { type: "action", action: { type: "loot" } };
    if (verb === "SLEEP") return { type: "action", action: { type: "sleep" } };
    if (verb === "CRAFT") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (item) return { type: "action", action: { type: "craft", item, count: count > 0 ? count : 1 } };
    }
    if (verb === "SMELT") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (item) return { type: "action", action: { type: "smelt", item, count: count > 0 ? count : 1 } };
    }
    if (verb === "PLACE") {
      const item = (parts[2] || "").toLowerCase();
      if (item) return { type: "action", action: { type: "place", item } };
    }
    if (verb === "GIVE") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (item) return { type: "action", action: { type: "give", player: speaker, item, count: count > 0 ? count : 1 } };
    }
    if (verb === "STORE") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      // Unlike every other count default (1), this defaults to "all of it" -- performAction's
      // "store" already caps at however much she actually has via Math.min().
      if (item) return { type: "action", action: { type: "store", item, count: count > 0 ? count : Infinity } };
    }
    if (verb === "TRADE") {
      const item = (parts[2] || "").toLowerCase();
      if (item) return { type: "action", action: { type: "trade", item } };
    }
    if (verb === "HARVEST") return { type: "action", action: { type: "harvest" } };
    if (verb === "BUILD") return { type: "action", action: { type: "build" } };
    if (verb === "EXPLORE") return { type: "action", action: { type: "explore" } };
    if (verb === "BREED") {
      const species = (parts[2] || "").toLowerCase();
      if (species) return { type: "action", action: { type: "breed", species } };
    }
    if (verb === "ENCHANT") {
      const item = (parts[2] || "").toLowerCase();
      if (item) return { type: "action", action: { type: "enchant", item } };
    }
    if (verb === "MINE") {
      const block = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (block) return { type: "action", action: { type: "mine", block, count: count > 0 ? count : 4 } };
    }
    if (verb === "GOAL") {
      // Re-extracted from the original (non-uppercased) reply so the description keeps its
      // natural casing/spacing rather than the all-caps, single-spaced tokens `parts` has.
      const match = reply.trim().match(/^ACTION\s+GOAL\s+(.+)$/i);
      const description = match ? match[1].trim() : "";
      if (description) return { type: "action", action: { type: "goal", description } };
    }
    return { type: "chat" }; // unparseable ACTION line -- fall back to a normal reply
  }
  if (trimmed.startsWith("CHAT")) return { type: "chat" };
  return { type: "none" };
}

// Short in-character line for an action's start/outcome -- same persona voice as a normal
// chat reply, just a much shorter, single-purpose prompt (no history/long-term recall: an
// action's own result text is already all the context worth having).
async function narrateAction(text) {
  const reply = await callRole(
    "muse",
    [
      { role: "system", content: `${persona}\n\n---\n\nYou are chatting in Minecraft's in-game ` +
          `chat, in character. State the following in one short sentence, in your own voice, ` +
          `without changing its meaning: "${text}"` },
      { role: "user", content: text },
    ],
    { maxTokens: 40, temperature: 0.9 },
  );
  return reply.trim().slice(0, MAX_CHAT_LEN) || text;
}

const CHAT_INSTRUCTION =
  "You are chatting in Minecraft's in-game chat, in character. Reply to the latest message " +
  "in 1-2 short sentences suitable for game chat. Do not prefix your own name.";

async function generateReply(speaker, message) {
  const conv = convId(speaker);

  // Best-effort: record the incoming line, then read back recent history for this speaker
  // (this call already includes the line just recorded, oldest-first -- see
  // hermes-memory.py's _list_turns). A hermes-memory outage degrades to a single-message
  // reply rather than failing the interaction -- never a hard dependency for chatting at all.
  let history = [{ role: "user", content: `<${speaker}> ${message}` }];
  try {
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "user",
                        raw: `<${speaker}> ${message}` });
    const turns = await recentTurns({ agent: AGENT_ID, convId: conv, limit: HISTORY_TURNS });
    if (turns.length) {
      history = turns.map((t) => ({ role: t.role, content: t.raw }));
    }
  } catch (err) {
    console.error(`[${USERNAME}] memory unavailable, replying without history:`, err.message,
                  err.cause ?? "");
  }

  // Long-term recall (design doc §7): a handful of semantically relevant notes from the
  // "minecraft" corpus -- both this bot's own personal memory and shared world facts, not
  // filtered by scope here since the corpus is still small and an instruction-following model
  // handles a little irrelevant context fine. Best-effort like everything else memory-related.
  let memoryNote = "";
  const hits = await searchMemory(message, { topK: 3 });
  if (hits.length) {
    memoryNote = "\n\nRelevant things you remember:\n" +
      hits.map((h) => `- ${h.text}`).join("\n");
  }

  // muse's chat template rejects a second system-role message anywhere but position 0
  // ("System message must be at the beginning") -- confirmed live, not assumed -- so persona,
  // the per-call instruction, the Boss note (when it applies), and any recalled long-term
  // memory are all merged into one system message, not sent separately.
  const bossNote = isBoss(speaker)
    ? ` The speaker (${speaker}) is The Boss -- respond accordingly to her Behavioral Modifiers.`
    : "";
  const text = await callRole(
    "muse",
    [{ role: "system", content: `${persona}\n\n---\n\n${CHAT_INSTRUCTION}${bossNote}${memoryNote}` },
     ...history],
    { maxTokens: 80, temperature: 0.9 },
  );
  const reply = text.slice(0, MAX_CHAT_LEN);

  if (reply) {
    try {
      await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "assistant",
                          raw: reply });
    } catch (err) {
      console.error(`[${USERNAME}] failed to record reply to memory:`, err.message, err.cause ?? "");
    }
  }
  return reply;
}

// Runs after a reply has already been sent -- never on the critical path a player is waiting
// on. Uses the same cheap `dispatch` tier the relevance check uses (design doc §6: dispatch is
// for reactive classification, not creative generation), asking it to decide whether anything
// in the exchange is worth long-term memory and, if so, whether it's a shared world fact or
// personal to this bot. A hermes-rag outage here just means nothing gets remembered long-term
// this turn -- never affects the chat itself.
async function maybeRemember(speaker, message, reply) {
  try {
    const verdict = await callRole(
      "dispatch",
      [
        {
          role: "system",
          content:
            "Given this Minecraft chat exchange, is there a concrete fact worth remembering " +
            "long-term (a discovery, location, stated preference, promise, or plan)? If yes, " +
            "respond exactly as 'WORLD: <one-sentence fact>' for an objective fact about the " +
            "world (locations, builds, shared knowledge), or 'PERSONAL: <one-sentence fact>' " +
            "for something about this specific speaker. If nothing is worth remembering, " +
            "respond exactly 'NONE'. Never explain, never add anything else.",
        },
        { role: "user", content: `<${speaker}> ${message}\n<bot reply> ${reply}` },
      ],
      { maxTokens: 60, temperature: 0 },
    );
    const trimmed = verdict.trim();
    if (trimmed.toUpperCase().startsWith("WORLD:")) {
      const fact = trimmed.slice(6).trim();
      await writeMemoryNote({ scope: "world", persona: PERSONA_NAME, text: fact });
      // Buzz coordination (design doc §9): other bots hear about a new world fact within one
      // poll interval, not only whenever they next happen to searchMemory() something related.
      try {
        await buzzPublish(AGENT_ID, "minecraft", fact);
      } catch (err) {
        console.error(`[${USERNAME}] buzz publish failed:`, err.message);
      }
    } else if (trimmed.toUpperCase().startsWith("PERSONAL:")) {
      await writeMemoryNote({ scope: "bot", persona: PERSONA_NAME,
                              text: `(about ${speaker}) ${trimmed.slice(9).trim()}` });
    }
  } catch (err) {
    console.error(`[${USERNAME}] maybeRemember failed:`, err.message);
  }
}

// Runs an action in the background and reports back -- deliberately NOT inside the `busy`
// window (see handleIncoming): a mine/follow/attack action can take up to ACTION_TIMEOUT_MS
// (actions.js), and holding the classify/reply mutex for that whole span would make the bot
// go unresponsive to chat while she works. `busy` only ever guards the fast classify step.
async function runAction(action, speaker, message, send) {
  // Real bug found live (2026-09-06): this used to record a generic "[requested action:
  // mine]" label, discarding the actual message text and parsed params (block/count) -- when
  // a mining request went to the wrong block, there was no way to tell from memory alone
  // whether the classifier misheard the request or the player's own message was ambiguous.
  // Recording the full parsed action alongside the original text fixes that for next time.
  const actionDesc = action.type === "mine" ? `mine ${action.block} x${action.count}`
    : action.type === "craft" ? `craft ${action.item} x${action.count}`
    : action.type === "smelt" ? `smelt ${action.item} x${action.count}`
    : action.type === "place" ? `place ${action.item}`
    : action.type === "give" ? `give ${action.player} ${action.item} x${action.count}`
    : action.type === "store" ? `store ${action.item}`
    : action.type === "breed" ? `breed ${action.species}`
    : action.type === "enchant" ? `enchant ${action.item}` : action.type;
  acting = true; // blocks the goal loop from stepping until this direct command is done
  try {
    const startLine = {
      goto: `heading to ${speaker}.`, follow: `following ${speaker} now.`, stop: "stopping.",
      mine: `off to gather some ${action.block}.`, attack: "engaging.", flee: "getting out of here!",
      loot: "checking a nearby chest.", craft: `let's see about crafting ${action.item}.`,
      sleep: "heading to bed.", smelt: `time to smelt some ${action.item}.`,
      place: `let's set up a ${action.item} here.`, eat: "grabbing a bite.", fish: "let's try fishing.",
      give: `bringing you some ${action.item}.`, store: `putting away some ${action.item}.`,
      trade: "let's see what the villager has.", harvest: "checking on the crops.",
      breed: `let's get some ${action.species}s together.`, enchant: `let's enchant this ${action.item}.`,
    }[action.type];
    if (startLine) send(await narrateAction(startLine));

    const result = await performAction(bot, action, speaker);
    send(await narrateAction(result.text));

    // Actions are conversational events too -- worth the same continuity as a chat exchange.
    const conv = convId(speaker);
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "user",
                        raw: `<${speaker}> ${message} [parsed as: ${actionDesc}]` });
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "assistant", raw: result.text });
  } catch (err) {
    console.error(`[${USERNAME}] action '${action.type}' failed:`, err.message);
    send(`something went wrong trying to do that.`);
  } finally {
    acting = false;
  }
}

// Parses the goal planner's verdict -- deliberately separate from classifyIntent's own
// ACTION-line parser above, even though they overlap: the goal loop's vocabulary is narrower
// (no goto/follow/stop, which are speaker-relative and don't mean anything for a standing goal
// pursued alone) and has two extra terminal states classifyIntent has no use for (DONE/BLOCKED).
//
// Real gap found live (2026-09-07): the first version required the WHOLE reply to start with a
// known keyword, forcing a bare one-line answer with no room to reason -- dispatch is actually a
// full 35B model (same family as muse, just the stock quant, confirmed against hermes-router.py's
// own ROLES table), not a tiny classifier, but a one-line-only format meant it never connected
// "craft failed, no ingredients" back to "mine the raw material first": a live goal ("get a chest
// and some armor") burned all 3 retries on different CRAFT targets that all failed for the same
// underlying reason (no logs at all) and gave up, when mining logs first would have worked.
// Scanning from the LAST non-empty line for a known keyword lets the model reason for a
// sentence first (planNextStep's prompt now explicitly invites that) while still parsing
// reliably -- direct instruction: correctness/reasoning over minimizing tokens, since this all
// runs on local compute with no per-call cost.
function parseGoalStep(text) {
  const lines = text.trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.toUpperCase();
    if (trimmed.startsWith("DONE")) return { type: "done" };
    if (trimmed.startsWith("BLOCKED")) return { type: "blocked", reason: line.slice(7).trim() || "stuck" };
    if (trimmed.startsWith("ACTION")) {
      const parts = trimmed.split(/\s+/);
      const verb = parts[1];
      if (verb === "LOOT") return { type: "step", action: { type: "loot" } };
      if (verb === "ATTACK") return { type: "step", action: { type: "attack" } };
      if (verb === "CRAFT") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (item) return { type: "step", action: { type: "craft", item, count: count > 0 ? count : 1 } };
      }
      if (verb === "SMELT") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (item) return { type: "step", action: { type: "smelt", item, count: count > 0 ? count : 1 } };
      }
      if (verb === "PLACE") {
        const item = (parts[2] || "").toLowerCase();
        if (item) return { type: "step", action: { type: "place", item } };
      }
      if (verb === "MINE") {
        const block = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (block) return { type: "step", action: { type: "mine", block, count: count > 0 ? count : 4 } };
      }
      // Direct request, 2026-09-07 ("next set of autonomy" -> goal-planner vocabulary gap):
      // harvest/breed/enchant/fish existed since the last two rounds but were only ever reachable
      // via a direct player command -- classifyIntent had them, this parser (a standing goal
      // reasoning on her own) never did, so a self-proposed goal could never actually choose to
      // farm, breed, enchant, or fish. Same parsing shape as every verb above.
      if (verb === "HARVEST") return { type: "step", action: { type: "harvest" } };
      if (verb === "BUILD") return { type: "step", action: { type: "build" } };
      if (verb === "EXPLORE") return { type: "step", action: { type: "explore" } };
      if (verb === "BREED") {
        const species = (parts[2] || "").toLowerCase();
        if (species) return { type: "step", action: { type: "breed", species } };
      }
      if (verb === "ENCHANT") {
        const item = (parts[2] || "").toLowerCase();
        if (item) return { type: "step", action: { type: "enchant", item } };
      }
      if (verb === "FISH") return { type: "step", action: { type: "fish" } };
      // Not a "step" like the others above -- REQUEST never touches the game world, only Buzz,
      // so goalTick handles it as its own sibling type rather than routing it through
      // performAction (direct follow-up, 2026-09-07: "look for more ways to improve their
      // autonomy" -> bot-to-bot help).
      if (verb === "REQUEST") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (item) return { type: "request", item, count: count > 0 ? count : 1 };
      }
    }
  }
  return { type: "blocked", reason: "couldn't decide what to do next" };
}

// One dispatch call per tick, grounded in real state (describeGear -- never guessed) and the
// goal's own recent log, not just the description -- so a repeated failure actually steers the
// next choice instead of retrying the same dead end forever (MAX_CONSECUTIVE_FAILURES is the
// hard backstop if reasoning alone doesn't catch it). maxTokens is deliberately generous (not
// the old 24) -- see parseGoalStep's comment on why a one-line-only format was the real problem.
async function planNextStep(goal) {
  const gearNote = describeGear(bot);
  const recentLog = goal.log.length ? goal.log.slice(-6).join("\n") : "(nothing done yet)";

  // Environmental memory (direct follow-up, 2026-09-07: "look for more ways to improve their
  // autonomy"). Real gap found live earlier tonight: "no oak_log nearby" got rediscovered from
  // scratch, independently, by both bots, across many separate goal cycles -- that knowledge
  // died with each goal instead of persisting. Reuses the EXISTING long-term memory (the same
  // "minecraft" hermes-rag corpus generateReply already searches for chat), not a new store.
  let environmentNote = "";
  try {
    const hits = await searchMemory(goal.description, { topK: 3 });
    if (hits.length) {
      environmentNote = "\n\nThings you remember about this area (may save you from repeating a " +
        "dead end):\n" + hits.map((h) => `- ${h.text}`).join("\n");
    }
  } catch (err) {
    console.error(`[${USERNAME}] memory recall for planning failed:`, err.message);
  }

  const otherGoalNote = otherGoalsNote(
    "Other bots currently working on something (if your goal would mean competing for the " +
    "same scarce thing, consider whether ACTION REQUEST -- ask one of them directly, she may " +
    "already have some -- beats duplicating her work):");

  const reply = await callRole(
    "dispatch",
    [
      {
        role: "system",
        content:
          `You are the planner for a Minecraft bot named ${USERNAME} working toward a standing ` +
          `goal on her own, unprompted by anyone right now.\n\n` +
          `Real limits on what she can do: she can craft via a crafting-table/hand-crafting grid ` +
          `recipe (bot.craft), AND she can smelt at a furnace (ACTION SMELT) -- she is NOT stuck ` +
          `without ingots. An item normally obtained by smelting (iron_ingot, copper_ingot, ` +
          `gold_ingot, glass, stone from cobblestone) needs raw material first (raw_iron, ` +
          `raw_copper, raw_gold, sand, cobblestone -- mine it if she doesn't have any), THEN ` +
          `ACTION SMELT, not ACTION CRAFT -- crafting-table recipes can never produce a smelted ` +
          `item. SMELT also needs FUEL (coal, charcoal, or any log/planks) -- if it fails for ` +
          `lack of fuel and she has no coal/charcoal, mine a log (ACTION MINE oak_log or ` +
          `whatever log is nearby) rather than repeating the same smelt attempt; any log works ` +
          `as furnace fuel. If SMELT/CRAFT fails specifically because no furnace/crafting table ` +
          `is reachable, check her inventory for a spare one first -- ACTION PLACE it rather than ` +
          `giving up or looting, since placing a utility block she already made is faster and ` +
          `more reliable than hoping a chest has what she needs. Only fall back to ACTION LOOT if ` +
          `she has the raw material and fuel but SMELT still fails, or has no furnace reachable ` +
          `and none to place.\n` +
          `Common material chain: sticks and a crafting table both need planks; planks come from ` +
          `logs. If a craft fails for missing ingredients, check whether she's missing the raw ` +
          `material (e.g. no logs at all) rather than the item itself -- mine the raw material ` +
          `first instead of retrying the same craft.\n` +
          `She can place ONE utility block she's carrying (a furnace or crafting table, ACTION ` +
          `PLACE) for her own use, but has NO ability to build or place actual structures. If the ` +
          `goal is really about building/placing something bigger (a house, a base, a wall) ` +
          `rather than gearing up/gathering/crafting a portable item, respond BLOCKED immediately ` +
          `-- don't gather materials for a structure that can never actually get built.\n\n` +
          `Given the goal, her current gear/inventory, and what she's already tried below, you ` +
          `may reason briefly first -- AT MOST one short sentence, no matter how confusing or ` +
          `factually off the goal description sounds (reinterpret it charitably as the closest ` +
          `realistic Minecraft objective rather than dwelling on why it's worded oddly) -- then ` +
          `on its own final line you MUST respond with EXACTLY ONE of these forms, no exceptions:\n` +
          `DONE - the goal is already fully achieved given her current gear/inventory\n` +
          `BLOCKED <short reason> - she cannot make progress right now and should give up\n` +
          `ACTION MINE <block_id> <count> - gather a resource. <block_id> must be the exact ` +
          `modern Minecraft block id -- never invent one. For a material class rather than one ` +
          `exact species/color (any wood, any wool, any ore), any real example works -- she'll ` +
          `automatically gather whatever matching variant is actually nearby. If she hasn't ` +
          `already checked a chest THIS goal, try ACTION LOOT first -- a nearby chest may ` +
          `already have the resource (LOOT now takes any useful item it finds, not just gear), ` +
          `saving a trip. Go straight to MINE only once LOOT has already come up empty for this ` +
          `same need, or the recent progress below already shows a LOOT attempt.\n` +
          `ACTION CRAFT <item_id> <count> - craft an item via a crafting-table/grid recipe only. ` +
          `<item_id> must be the exact modern Minecraft item id -- never invent one.\n` +
          `ACTION EXPLORE - go looking for any useful raw material (wood, ore) when CRAFT/MINE ` +
          `failed because a needed resource isn't nearby and you don't have a more specific ` +
          `block to try -- gathers whatever's found, worth doing before giving up or asking the ` +
          `other bot for help.\n` +
          `ACTION SMELT <item_id> <count> - smelt raw material into an ingot (or similar) at a ` +
          `furnace. <item_id> is the OUTPUT (e.g. iron_ingot), the exact modern Minecraft item ` +
          `id -- never invent one.\n` +
          `ACTION PLACE <item_id> - place a furnace or crafting_table she's already carrying, ` +
          `right next to herself, when SMELT/CRAFT needs one and none is reachable.\n` +
          `ACTION LOOT - check the nearest chest for anything useful (gear, resources, whatever's in there)\n` +
          `ACTION ATTACK - fight a nearby hostile mob\n` +
          `ACTION HARVEST - pick a ripe crop nearby and replant it, or till open ground and plant ` +
          `seeds to start a new farm if nothing is ripe yet, if the goal is about food or farming\n` +
          `ACTION BREED <species> - breed two nearby animals of the same kind (cow, sheep, pig, ` +
          `or chicken) using the right food, if the goal is about animals or farming\n` +
          `ACTION ENCHANT <item_id> - enchant an item she's carrying at a nearby enchanting table ` +
          `(needs lapis lazuli and enough XP levels), if the goal is about gear upgrades\n` +
          `ACTION FISH - fish at nearby water with a fishing rod, if the goal is about food and ` +
          `no crops/animals are a better fit\n` +
          `ACTION BUILD - build a small shelter (walls, a doorway, a roof) around herself using ` +
          `whatever solid block she has the most of, if the goal is about shelter/safety and she ` +
          `hasn't got one nearby already\n` +
          `ACTION REQUEST <item_id> <count> - ask the other bot (over Buzz) for an item she might ` +
          `already have. Only after LOOT has already failed for the same need, or the item is ` +
          `also fine to just ask for directly (e.g. borrowing fuel/food rather than gathering ` +
          `your own from scratch).\n` +
          `Pick the single most useful next step toward the goal. If the same step already ` +
          `failed more than once in a row (see recent progress below), you must try a genuinely ` +
          `different step that addresses the actual missing ingredient, or respond BLOCKED.`,
      },
      { role: "user", content: `Goal: ${goal.description}\n${gearNote}\nRecent progress:\n${recentLog}` +
          `${environmentNote}${otherGoalNote}` },
    ],
    // Real bug found live (2026-09-07), TWICE -- once at 120 tokens, again at 220: the model
    // does not reliably obey "at most one short sentence" and sometimes writes a long run-on
    // reasoning sentence with parenthetical asides, getting cut off before its required final
    // decision line -- parseGoalStep's fallback ("couldn't decide what to do next") then counts
    // as a real strike toward MAX_CONSECUTIVE_FAILURES for a goal that was never actually given a
    // fair evaluation. Fighting the model's verbosity with prompt wording alone hasn't held up
    // twice in a row -- a genuinely generous budget is the robust fix instead of a third guess at
    // a slightly bigger number. This runs on local compute with no per-call cost, so there's no
    // real reason to be stingy here.
    { maxTokens: 500, temperature: 0 },
  );
  return reply.trim();
}

// Fires once a bot has had no active goal and heard from no one (chat/whisper/Matrix/a goal
// being set) for IDLE_BEFORE_SELF_GOAL_MS -- the "self-proposed" half of the operator's chosen
// autonomy design (the alternative, user-assigned-only, was explicitly not chosen). Uses `muse`,
// not `dispatch`: this is the one place autonomy calls for personality/creativity rather than
// mechanical classification -- what a bot chooses to do with idle time should sound like her,
// grounded in her real gear (never invented) and whatever long-term memory might suggest
// something worth pursuing.
// Direct request, 2026-09-07 ("what other behavior rules have any other sources published or
// suggested" -> MINECRAFT_BOTS_DESIGN.md's own §6 table: "Cross-bot conflict arbitration (two
// bots claim the same sub-goal) -> super (rare, not per-tick -- an occasional top-tier call, not
// a standing cost)"). Decided and documented back when this was designed (2026-09-06), never
// actually built -- what existed until tonight was only the soft otherGoalsNote() prompt nudge
// below, which depends entirely on THIS bot's own model voluntarily noticing and avoiding a
// collision, with nothing that actually resolves one if it doesn't. Only fires when there's
// something to arbitrate (an active other-bot goal exists AND this bot is about to commit to a
// new self-proposed one) -- rare by construction, matching the design doc's own "not per-tick."
// Deliberately scoped to self-proposed goals only, not player-assigned ones (ACTION GOAL) -- a
// human's direct instruction should never get silently overridden by an arbitration call.
async function arbitrateGoalConflict(proposedDescription) {
  if (!otherBotGoals.size) return proposedDescription;
  const othersText = [...otherBotGoals.entries()].map(([agent, desc]) => `${agent}: ${desc}`).join("\n");
  try {
    const reply = await callRole("super", [
      {
        role: "system",
        content:
          "You arbitrate goal conflicts between autonomous Minecraft bots sharing one world " +
          "and its scarce resources. Given one bot's proposed new goal and what other bots are " +
          "already actively doing, decide whether it's a REAL conflict worth avoiding (both " +
          "need the same scarce, limited resource or location right now), not just a loose " +
          "topical overlap -- two bots both wanting \"some iron\" isn't automatically a " +
          "conflict if iron ore is common. Respond in EXACTLY this format, two lines:\n" +
          "CONFLICT: yes|no\n" +
          "GOAL: <if yes, a different, still-concrete goal for this bot to pursue instead; if " +
          "no, repeat the original goal unchanged>",
      },
      {
        role: "user",
        content: `This bot's proposed goal: "${proposedDescription}"\n\nOther bots already ` +
          `active:\n${othersText}`,
      },
    ], { maxTokens: 100, temperature: 0 });
    if (!/CONFLICT:\s*yes/i.test(reply)) return proposedDescription;
    const goalMatch = reply.match(/GOAL:\s*(.+)/i);
    const alternative = goalMatch ? goalMatch[1].trim().replace(/^["']|["']$/g, "").slice(0, 120) : "";
    if (!alternative) return proposedDescription; // flagged a conflict but gave nothing usable -- don't block on it
    console.log(`[${USERNAME}] goal conflict arbitrated: "${proposedDescription}" -> "${alternative}"`);
    return alternative;
  } catch (err) {
    console.error(`[${USERNAME}] goal arbitration failed:`, err.message);
    return proposedDescription; // arbitration is a refinement, not a hard gate -- never block a goal on it failing
  }
}

async function proposeOwnGoal() {
  const gearNote = describeGear(bot);
  let memoryNote = "";
  try {
    const hits = await searchMemory("goals, plans, things worth doing or building", { topK: 3 });
    if (hits.length) {
      memoryNote = "\n\nThings you remember that might matter:\n" + hits.map((h) => `- ${h.text}`).join("\n");
    }
  } catch (err) {
    console.error(`[${USERNAME}] memory recall for self-goal failed:`, err.message);
  }

  // Real gap found live (2026-09-07): with no memory of what she just gave up on, this kept
  // re-picking the same goal (e.g. "smelt some copper") immediately after abandoning it for an
  // environmental reason that hadn't changed (no unoccupied furnace nearby) -- an unproductive
  // loop across separate goal cycles, distinct from and not fixed by anything within a single
  // goal's own retry logic. Handed to the model as data to reason about (not a hard blocklist)
  // since sometimes repeating IS right -- e.g. if she just looted fuel she didn't have before.
  const recentOutcomesNote = recentGoalOutcomes.length
    ? "\n\nYour last few goals:\n" + recentGoalOutcomes.map((o) =>
        `- "${o.description}" -> ${o.outcome}${o.reason ? ` (${o.reason})` : ""}`).join("\n") +
      "\nIf you gave up on something recently for a reason that hasn't changed (check your " +
      "gear/inventory below), pick something different instead of immediately repeating it."
    : "";

  // Cross-bot goal coordination (direct follow-up, 2026-09-07: "look for more ways to improve
  // their autonomy"). Real collision observed live: both bots picked "get copper armor" at the
  // same time and both burned attempts on the same occupied furnaces -- duplicated effort neither
  // needed. otherBotGoals is kept current by the "minecraft-coordination" Buzz subscription below.
  const otherGoalNote = otherGoalsNote(
    "Other bots currently working on something (avoid picking something that duplicates or " +
    "competes with one of these for the same scarce resource unless you have a good reason to):");

  const text = await callRole(
    "muse",
    [
      {
        role: "system",
        content:
          `${persona}\n\n---\n\nNo one has talked to you in a while and you have no standing ` +
          `goal right now. Given your own gear/inventory below, decide on ONE concrete, ` +
          `achievable objective to work on by yourself for a while (gearing up, gathering a ` +
          `resource, crafting or smelting something useful). Stay correctly grounded in real ` +
          `Minecraft mechanics -- e.g. planks/sticks/a table come from logs (never stone); ` +
          `ingots (iron/copper/gold) come from smelting raw ore at a furnace, which you CAN do, ` +
          `never from a crafting-table recipe. You can place a single utility block you're ` +
          `carrying (a furnace or crafting table) for your own use, but have NO ability to build ` +
          `or place actual structures -- never propose a goal about building/placing something ` +
          `(a house, a base, a wall); stick to gearing up, gathering a resource, or crafting/` +
          `smelting a portable item. Phrase the goal around the OUTCOME you want (e.g. "get some copper armor," ` +
          `"stock up on iron") rather than one specific method, since more than one way to get ` +
          `there might work -- but naming smelting/crafting as part of it is fine now, unlike ` +
          `building, which is never possible. Respond with ONLY a short phrase naming the goal, ` +
          `in your own words -- nothing else, no quotes.\n\n${gearNote}${memoryNote}` +
          `${recentOutcomesNote}${otherGoalNote}`,
      },
      { role: "user", content: "What's your goal?" },
    ],
    { maxTokens: 30, temperature: 0.9 },
  );
  let description = text.trim().replace(/^["']|["']$/g, "").slice(0, 120);
  if (!description) return;
  description = await arbitrateGoalConflict(description);

  currentGoal = newGoal({ description, source: "self" });
  await saveGoal(PERSONA_NAME, currentGoal);
  await broadcastGoalState("active", description);
  console.log(`[${USERNAME}] self-proposed goal: ${description}`);
  bot.chat(await narrateAction(`new goal, on my own: ${description}.`));
}

// Runs on its own timer, entirely separate from handleIncoming's chat-driven busy window --
// only steps when nothing else has the bot's attention (busy/acting), so a live player command
// always wins immediately and this simply resumes on its own next tick once that command's
// action finishes. Reuses `busy`/`acting` themselves (rather than a third flag) so there is
// exactly one place goal-loop-vs-live-command precedence is decided, not two that could drift
// out of sync.
async function goalTick() {
  if (!AUTONOMY_ENABLED || busy || acting) return;

  if (!currentGoal) {
    if (!SELF_PROPOSE_GOALS || Date.now() - lastActivityAt < IDLE_BEFORE_SELF_GOAL_MS) return;
    busy = true;
    try {
      await proposeOwnGoal();
    } catch (err) {
      console.error(`[${USERNAME}] failed to self-propose a goal:`, err.message);
    } finally {
      busy = false;
    }
    return;
  }

  acting = true;
  try {
    // Skill retrieval (MINECRAFT_BOTS_DESIGN.md §14, 2026-09-08): before spending a
    // planNextStep call, check for an existing, trusted skill whose description matches this
    // goal closely enough to just run directly -- skips per-tick planning entirely on a hit,
    // the actual efficiency payoff a dynamic skill library is for (real, already-observed
    // evidence it would help: multiple bots independently re-deriving the identical "need a
    // pickaxe -> need planks -> need logs" chain from scratch, per bot, per goal). A miss (no
    // close match, or every close match already untrusted) costs one cheap search call and
    // falls through to normal planning unchanged. Checked once per goal (servedBySkill), not
    // every tick, once a goal has already gone one way or the other.
    if (!currentGoal.servedBySkill) {
      const skill = await findSkill(currentGoal.description);
      if (skill) {
        console.log(`[${USERNAME}] running stored skill "${skill.name}" for goal: ${currentGoal.description}`);
        const result = await runSkill(performAction, bot, skill, currentGoal.setBy || USERNAME);
        await recordSkillOutcome(skill.jsonPath, result.ok);
        currentGoal.servedBySkill = true;
        logStep(currentGoal, `skill(${skill.name}): ${result.text}`, result.ok);
        if (result.ok) {
          console.log(`[${USERNAME}] goal complete via skill: ${currentGoal.description}`);
          bot.chat(await narrateAction(`goal complete: ${currentGoal.description}.`));
          recordGoalOutcome(currentGoal.description, "done", null);
          await broadcastGoalState("done", currentGoal.description);
          currentGoal = null;
          await clearGoal(PERSONA_NAME);
        } else {
          // Doesn't duplicate the give-up/consecutiveFailures check here -- one failed skill
          // attempt counts as one failed step, same as any other, and the very next tick's own
          // normal planning already re-checks that threshold on the same shared counter.
          currentGoal.consecutiveFailures += 1;
          await saveGoal(PERSONA_NAME, currentGoal);
        }
        return;
      }
    }

    // busy is held only for this planning call, not the physical action below -- see the
    // 2026-09-07 fix note above planNextStep's own call site history for why. Releasing it
    // immediately after the plan is known (instead of holding it until the whole step,
    // including a potentially minute-long physical action, finishes) is what actually delivers
    // this function's own documented promise above ("a live player command always wins
    // immediately"): handleIncoming only ever checks `busy`, not `acting`, so a real chat
    // message arriving mid-action was being unconditionally dropped as "busy" for as long as
    // the action ran -- live evidence: an entire day of real player chat logged as dropped.
    // `acting` alone still prevents this function (and every other idle-tick check) from
    // starting a second physical action while this one is in flight; a live command's own
    // performAction call safely interrupts it via the same stopCurrent() every action already
    // calls first, exactly like a direct command already could while a PREVIOUS design's
    // goalTick was mid-plan.
    let stepLine, parsed;
    busy = true;
    try {
      stepLine = await planNextStep(currentGoal);
      parsed = parseGoalStep(stepLine);
      console.log(`[${USERNAME}] goal plan: ${stepLine}`);

      // Real gap found live (2026-09-07), twice: the prompt explicitly says to try ACTION LOOT
      // before giving up on a smelting-only ingredient, and the model sometimes states that exact
      // reasoning out loud ("no prior LOOT attempt...") and goes BLOCKED anyway -- correct
      // diagnosis, no follow-through, the same failure shape as 2.11.2 but surviving a prose fix.
      // This particular condition is simple and mechanically checkable (has "loot:" appeared in
      // this goal's own log yet?), so it's enforced in code here instead of trusted to a written
      // instruction a second time -- prompt guidance plus a code guard, not prompt guidance alone.
      // Still a valid last-resort fallback now that ACTION SMELT exists (2.12.1): the prompt teaches
      // SMELT as the primary path for a smelted item, but if she's genuinely stuck (no furnace
      // reachable, out of fuel) LOOT remains a legitimate alternate source worth forcing once.
      if (parsed.type === "blocked" && /smelt|furnace|ingot/i.test(parsed.reason) &&
          !currentGoal.log.some((l) => l.startsWith("loot:"))) {
        console.log(`[${USERNAME}] overriding BLOCKED (${parsed.reason}) -- no LOOT attempt yet, forcing one`);
        parsed = { type: "step", action: { type: "loot" } };
      }

      // Direct request, 2026-09-08 ("if they can't craft, they should explore, and find
      // resources for later"). Same "prompt guidance plus a code guard" reasoning as the LOOT
      // override just above: the prompt already teaches EXPLORE as an option, but a model
      // BLOCKED on a missing raw material (wood/ore not found nearby) sometimes gives up rather
      // than trying it, the same failure shape that override exists to catch. Checked AFTER the
      // smelt/furnace/ingot case above (and only if that one didn't already fire, since parsed
      // would no longer be "blocked" once it does) so the two overrides can't fight over which
      // fallback wins -- LOOT for a smelting-specific shortfall, EXPLORE for everything else.
      if (parsed.type === "blocked" && /craft|log|ore|plank|wood|resource|material|ingredient/i.test(parsed.reason) &&
          !currentGoal.log.some((l) => l.startsWith("explore:"))) {
        console.log(`[${USERNAME}] overriding BLOCKED (${parsed.reason}) -- no EXPLORE attempt yet, forcing one`);
        parsed = { type: "step", action: { type: "explore" } };
      }
    } finally {
      busy = false;
    }

    if (parsed.type === "done") {
      // Fifth of five scoped enhancements: tighter DONE validation. A real hallucinated DONE
      // was observed live tonight -- a goal reporting complete after every single logged step
      // had failed, with no evidence anything actually changed. Flagged, not blocked: outright
      // refusing the model's own DONE risks a worse failure mode (an endless "are you sure"
      // loop) than the rare cosmetic mislabeling this catches -- visible here for a human, and
      // matched by hermes-minecraft-triage.py's own TRIAGE_PATTERNS for the Firmament to notice.
      if (currentGoal.steps > 0 && !currentGoal.sawSuccess) {
        console.log(`[${USERNAME}] SUSPICIOUS DONE (no successful step ever logged for this ` +
                    `goal): ${currentGoal.description}`);
      }
      console.log(`[${USERNAME}] goal complete: ${currentGoal.description}`);
      bot.chat(await narrateAction(`goal complete: ${currentGoal.description}.`));
      recordGoalOutcome(currentGoal.description, "done", null);
      await broadcastGoalState("done", currentGoal.description);
      // Authoring (MINECRAFT_BOTS_DESIGN.md §14): only for a goal that actually worked its way
      // through from scratch, not one already served by a stored skill (servedBySkill) -- that
      // would just be re-storing an existing skill's own steps back under a new name. An
      // occasional coder call, not a per-tick cost -- see authorSkillFromGoal's own header on
      // why it's safe to await here (rare, not per-tick) and why the LLM only ever names the
      // already-real actionsTaken rather than inventing steps.
      if (!currentGoal.servedBySkill) {
        try {
          await authorSkillFromGoal(currentGoal.description, currentGoal.actionsTaken);
        } catch (err) {
          console.error(`[${USERNAME}] skill authoring failed:`, err.message);
        }
      }
      currentGoal = null;
      await clearGoal(PERSONA_NAME);
      return;
    }

    // Bot-to-bot help (direct follow-up, 2026-09-07: "look for more ways to improve their
    // autonomy") -- REQUEST never touches the game world, only Buzz, so it's handled here rather
    // than through performAction. Counts toward consecutiveFailures like any other non-resolving
    // step: if nobody responds within a few ticks, she still gives up normally instead of waiting
    // forever.
    if (parsed.type === "request") {
      console.log(`[${USERNAME}] requesting ${parsed.count} ${parsed.item} from the other bot`);
      try {
        await buzzPublish(AGENT_ID, "minecraft-coordination",
          JSON.stringify({ type: "request", item: parsed.item, count: parsed.count, forPlayer: USERNAME }));
      } catch (err) {
        console.error(`[${USERNAME}] item request publish failed:`, err.message);
      }
      logStep(currentGoal, `request: asked for ${parsed.count} ${parsed.item}`, false);
      currentGoal.consecutiveFailures += 1;
      if (currentGoal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[${USERNAME}] giving up on goal: ${currentGoal.description}`);
        bot.chat(await narrateAction(`giving up on "${currentGoal.description}" -- nobody could help with ${parsed.item}.`));
        recordGoalOutcome(currentGoal.description, "gave up", `needed ${parsed.item}`);
        await broadcastGoalState("abandoned", currentGoal.description);
        currentGoal = null;
        await clearGoal(PERSONA_NAME);
      } else {
        await saveGoal(PERSONA_NAME, currentGoal);
      }
      return;
    }

    if (parsed.type === "blocked") {
      logStep(currentGoal, `blocked: ${parsed.reason}`, false);
      currentGoal.consecutiveFailures += 1;
      console.log(`[${USERNAME}] goal blocked (${currentGoal.consecutiveFailures}/` +
                  `${MAX_CONSECUTIVE_FAILURES}): ${parsed.reason}`);
      if (currentGoal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[${USERNAME}] giving up on goal: ${currentGoal.description}`);
        bot.chat(await narrateAction(`giving up on "${currentGoal.description}" -- ${parsed.reason}.`));
        recordGoalOutcome(currentGoal.description, "gave up", parsed.reason);
        await broadcastGoalState("abandoned", currentGoal.description);
        currentGoal = null;
        await clearGoal(PERSONA_NAME);
      } else {
        await saveGoal(PERSONA_NAME, currentGoal);
      }
      return;
    }

    const result = await performAction(bot, parsed.action, currentGoal.setBy || USERNAME);
    logStep(currentGoal, `${parsed.action.type}: ${result.text}`, result.ok, parsed.action);
    currentGoal.consecutiveFailures = result.ok ? 0 : currentGoal.consecutiveFailures + 1;
    console.log(`[${USERNAME}] goal step: ${parsed.action.type} -> ${result.text} ` +
                `(ok=${result.ok}, consecutiveFailures=${currentGoal.consecutiveFailures})`);

    // Environmental memory (direct follow-up, 2026-09-07: "look for more ways to improve their
    // autonomy"). "even after looking around" is wanderAndRetryFind()'s own signature (actions.js
    // 1.11.0) for "tried the normal search AND wandered, still nothing" -- a real, worth-
    // remembering fact about this area, not just this one attempt. World-scoped (shared corpus)
    // since it's true regardless of which bot goes looking. Best-effort, never blocks the loop.
    if (!result.ok && result.text.includes("even after looking around")) {
      try {
        await writeMemoryNote({ scope: "world", persona: PERSONA_NAME,
          text: `No ${parsed.action.block ?? parsed.action.item ?? "target"} found even after ` +
                `wandering to look, as of ${new Date().toISOString()}.` });
      } catch (err) {
        console.error(`[${USERNAME}] environmental memory write failed:`, err.message);
      }
    }

    // Direct request, 2026-09-08 ("if they can't craft, they should explore, and find resources
    // for later"): the positive counterpart to the failure-case write just above -- a
    // successful EXPLORE found something worth remembering not just for the current goal, but
    // for whichever bot needs the same raw material next, world-scoped for the same reason.
    // Position included (rounded -- exact block precision doesn't matter for "worth checking
    // around here again"), since a note with no location is far less actionable than one with
    // one.
    if (parsed.action.type === "explore" && result.ok) {
      try {
        const pos = bot.entity.position.floored();
        await writeMemoryNote({ scope: "world", persona: PERSONA_NAME,
          text: `${result.text} near (${pos.x}, ${pos.y}, ${pos.z}), as of ${new Date().toISOString()}.` });
      } catch (err) {
        console.error(`[${USERNAME}] exploration memory write failed:`, err.message);
      }
    }

    if (currentGoal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`[${USERNAME}] giving up on goal: ${currentGoal.description}`);
      bot.chat(await narrateAction(`giving up on "${currentGoal.description}" -- ${result.text}`));
      recordGoalOutcome(currentGoal.description, "gave up", result.text);
      await broadcastGoalState("abandoned", currentGoal.description);
      currentGoal = null;
      await clearGoal(PERSONA_NAME);
      return;
    }

    await saveGoal(PERSONA_NAME, currentGoal);
    // A check-in every few steps, not every step -- otherwise gearing up would spam chat once
    // per GOAL_TICK_MS the whole time she works.
    if (currentGoal.steps % 3 === 0) {
      bot.chat(await narrateAction(`still working on ${currentGoal.description}: ${result.text}`));
    }
  } catch (err) {
    console.error(`[${USERNAME}] goal tick failed:`, err.message);
  } finally {
    acting = false;
  }
}

setInterval(() => {
  goalTick().catch((err) => console.error(`[${USERNAME}] goalTick error:`, err.message));
}, GOAL_TICK_MS);

// Mayor-only autonomous behavior, 2026-09-08 ("add another bot, Mayor, whose personality is to
// be a leader and set goals for the others"). A no-op check (USERNAME !== MAYOR_USERNAME) makes
// this genuinely inert for every other bot's own process -- same file, same timer registration,
// no separate build for "the other four" vs "Mayor." Picks whichever OTHER bot currently has NO
// active goal (absent from otherBotGoals, the same live signal arbitrateGoalConflict() already
// reads from the "minecraft-coordination" Buzz topic) rather than a random pick, matching the
// persona's own "leads by competence" directive -- an idle teammate is the one who actually
// needs direction. A cheap `muse` call in Mayor's own voice turns that into a real, addressed
// in-game chat line, which then flows through the EXACT SAME classifyIntent -> ACTION GOAL path
// a player's own instruction already takes (isMayor()'s own exception to isAnotherBot(), and the
// priority check in handleIncoming's own ACTION GOAL branch, both above) -- no separate
// "assign a goal to another bot" mechanism to build or keep in sync with the real one.
const MAYOR_DIRECTIVE_MS = parseInt(process.env.MC_MAYOR_DIRECTIVE_MS || "300000", 10); // 5 min

async function proposeDirectiveForOthers() {
  if (USERNAME !== MAYOR_USERNAME || !AUTONOMY_ENABLED || busy || acting) return;
  const idleBots = [...BOT_USERNAMES].filter((name) =>
    name !== MAYOR_USERNAME && !otherBotGoals.has(`mc-${name.toLowerCase()}`));
  if (!idleBots.length) return; // everyone already has something going -- nothing to assign
  const target = idleBots[Math.floor(Math.random() * idleBots.length)];

  busy = true;
  try {
    const reply = await callRole("muse", [
      {
        role: "system",
        content: `${persona}\n\n---\n\n${target} currently has no active goal. Give ${target} ` +
          `ONE short, specific, in-character task to work on -- a real Minecraft objective ` +
          `(gear up, gather a resource, craft or smelt something), not vague encouragement. ` +
          `Address ${target} by name, exactly like a real chat message you'd actually send. One ` +
          `or two sentences, nothing else -- no quotes, no stage directions.`,
      },
      { role: "user", content: `What do you tell ${target}?` },
    ], { maxTokens: 60, temperature: 0.9 });
    if (reply) {
      bot.chat(reply);
      console.log(`[${USERNAME}] issued directive to ${target}: ${reply}`);
    }
  } catch (err) {
    console.error(`[${USERNAME}] failed to issue a directive:`, err.message);
  } finally {
    busy = false;
  }
}

setInterval(() => {
  proposeDirectiveForOthers().catch((err) => console.error(`[${USERNAME}] proposeDirectiveForOthers error:`, err.message));
}, MAYOR_DIRECTIVE_MS);

// Direct request (2026-09-07): "the bots need to know to go to sleep at night." Deliberately a
// plain deterministic check on its own timer, not folded into goalTick's model-driven loop --
// "is it night" needs no reasoning, just bot.time.timeOfDay (the exact window bed.js's own
// bot.sleep() already enforces, matched here so this never tries when sleep() would just reject
// anyway). Uses the same busy/acting mutex as everything else, so it never fires mid-command and
// a live command always interrupts it (actions.js's stopCurrent() forces a wake for that).
const SLEEP_CHECK_MS = parseInt(process.env.MC_SLEEP_CHECK_MS || "30000", 10);
// Tracks whether tonight's sleep has already been tried (successfully or not) so a bed-less
// bot doesn't retry every 30s and spam chat for the whole ~7-real-minute length of one night --
// resets the moment it's day again, ready for the next night.
let sleepAttemptedThisNight = false;

async function checkSleep() {
  if (!AUTONOMY_ENABLED || busy || acting || bot.isSleeping) return;

  const thunderstorm = bot.isRaining && bot.thunderState > 0;
  const isNight = thunderstorm || (bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458);
  if (!isNight) {
    sleepAttemptedThisNight = false;
    return;
  }
  if (sleepAttemptedThisNight) return;
  sleepAttemptedThisNight = true;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note on why an
  // idle-tick physical action shouldn't block handleIncoming's `busy` check. acting alone
  // still prevents another idle-tick action from starting while this one runs.
  acting = true;
  try {
    bot.chat(await narrateAction("getting sleepy -- heading to bed."));
    const result = await performAction(bot, { type: "sleep" }, USERNAME);
    console.log(`[${USERNAME}] sleep: ${result.text} (ok=${result.ok})`);
    bot.chat(await narrateAction(result.ok ? result.text : `couldn't get to sleep: ${result.text}`));
  } catch (err) {
    console.error(`[${USERNAME}] sleep check failed:`, err.message);
  } finally {
    acting = false;
  }
}

setInterval(() => {
  checkSleep().catch((err) => console.error(`[${USERNAME}] checkSleep error:`, err.message));
}, SLEEP_CHECK_MS);

// Direct request, 2026-09-07: "bots should pay attention to the time of day, and try to return
// 'home' before full dark." Plain deterministic check on its own timer, same shape as
// checkSleep just above -- "is dusk approaching" needs no reasoning, just bot.time.timeOfDay.
// DUSK_START_TICK (10000) is set well before checkSleep's own 12541 (the exact tick bed.js's
// bot.sleep() actually becomes usable, matched there so sleep never tries early) specifically so
// she has real travel time to walk home -- roughly 2500 ticks/~127 real seconds of buffer,
// generous over any real distance searchRadius (48 blocks) ever puts her at from a normal
// day's wandering -- rather than only noticing once it's already the sleep-eligible window.
// "home" is bot.spawnPoint (actions.js's new "gohome" action) -- the same real reference the
// teleport-when-stuck mechanism already uses, not a second notion of home.
const DUSK_CHECK_MS = parseInt(process.env.MC_DUSK_CHECK_MS || "30000", 10);
const DUSK_START_TICK = parseInt(process.env.MC_DUSK_START_TICK || "10000", 10);
// Tracks whether tonight's trip home has already been tried so she doesn't retry every 30s for
// the rest of the ~13000-tick night window -- resets the moment a new day's tick count is back
// below DUSK_START_TICK, ready for the next dusk.
let wentHomeTonight = false;

async function checkDusk() {
  if (!AUTONOMY_ENABLED || busy || acting || bot.isSleeping || !bot.time) return;
  const t = bot.time.timeOfDay;
  if (t < DUSK_START_TICK) {
    wentHomeTonight = false;
    return;
  }
  if (wentHomeTonight) return;
  wentHomeTonight = true;

  // Whatever her standing goal assumed, getting home before dark takes priority -- same
  // reasoning as death/respawn/stuck: she can always pick something new up tomorrow.
  if (currentGoal) {
    await broadcastGoalState("abandoned", currentGoal.description);
    recordGoalOutcome(currentGoal.description, "gave up", "heading home before dark");
    currentGoal = null;
    await clearGoal(PERSONA_NAME);
  }

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  acting = true;
  try {
    bot.chat(await narrateAction("sun's getting low -- heading home before dark."));
    const result = await performAction(bot, { type: "gohome" }, USERNAME);
    console.log(`[${USERNAME}] heading home: ${result.text} (ok=${result.ok})`);
  } catch (err) {
    console.error(`[${USERNAME}] heading home failed:`, err.message);
  } finally {
    acting = false;
  }
}

setInterval(() => {
  checkDusk().catch((err) => console.error(`[${USERNAME}] checkDusk error:`, err.message));
}, DUSK_CHECK_MS);

// Fourth of five scoped enhancements, direct follow-up to "what other logic enhancements are
// available" -> self-defense. checkSelfDefense() itself is now a true mid-action interrupt
// (2026-09-08, see its own header comment), not the idle-tick version this comment originally
// described -- but real live testing of THAT fix found a second, separate gap worth fixing at
// the same time: a zombie that spawned right next to Babs killed her in about 7 seconds, right
// at the edge of this interval's own old 7000ms value, meaning the routine check may not have
// gotten a single turn before she died, independent of the acting-gate bug. Lowered to 2000ms --
// a melee mob hits roughly once a second at adjacent range, so this now gets at least 2-3
// chances to react within a typical short encounter instead of maybe zero.
const SELF_DEFENSE_CHECK_MS = parseInt(process.env.MC_SELF_DEFENSE_CHECK_MS || "2000", 10);
// Out of a max of 20 -- flee rather than fight once she's below half health with a threat
// actually nearby, same "correctness over guessing" reasoning as everywhere else tonight: an
// exact threshold beats a vague "if hurt." Now env-configurable (direct request, 2026-09-07:
// "ask Muse to spawn two more bots... military oriented profiles, priority towards arming
// themselves and defending the spawn point") so a combat-postured bot (Mark/Luke) can run a
// lower flee threshold and a wider detection range than the default -- same code, per-bot tuning
// via each unit's own Environment= lines, no behavior change for Babs/Amy who don't set these.
const SELF_DEFENSE_FLEE_HEALTH = parseInt(process.env.MC_SELF_DEFENSE_FLEE_HEALTH || "10", 10);
const SELF_DEFENSE_RANGE = parseInt(process.env.MC_SELF_DEFENSE_RANGE || "12", 10);

// Item #6 of "fix all the above" (squad response). Real gap: self-defense was purely individual
// -- Mark/Luke's own "military... defending the spawn point" framing (2026-09-07) implied a
// squad that backs each other up, but nothing ever told a teammate someone else was under
// attack. ANY bot broadcasts a threat alert (calling for help costs nothing and might as well be
// universal), but only a SQUAD_RESPONDER actually drops what she's doing to go help -- Babs/Amy
// abandoning a gathering run for a spider three biomes away would be a net loss, not backup.
// Mirrors MC_SELF_DEFENSE_FLEE_HEALTH/RANGE's own "same code, per-bot tuning via each unit's own
// Environment= lines" pattern, set true for Mark/Luke only.
const SQUAD_RESPONDER = process.env.MC_SQUAD_RESPONDER === "true";
// No point racing across half the map for a fight that's very likely already over by the time
// she'd arrive -- bounded to a real, reachable-in-time assist radius.
const SQUAD_ASSIST_RANGE = 48;
// Keeps one drawn-out fight from re-alerting every 2000ms (checkSelfDefense's own tick) for the
// entire duration -- one call for help per fight is enough for a teammate to start moving.
const SQUAD_ALERT_COOLDOWN_MS = 15_000;
let lastSquadAlertAt = 0;
let squadResponseInFlight = false;

// Direct report, 2026-09-08 ("they still don't seem to react to a threatening creature"). Real,
// confirmed gap: this used to be gated on !acting, same as every other idle-tick check here --
// but `acting` now spans an entire physical action end-to-end (up to ACTION_TIMEOUT_MS, 90s
// after tonight's own earlier raise), and goal-directed autonomy keeps a bot "acting" a large
// fraction of the time. A threat that showed up mid-mine/mid-craft got NO response at all from
// this check until the health-triggered TRUE interrupt (bot.on("health") below) finally fired --
// and that one only engages at EMERGENCY_HEALTH_THRESHOLD (30% health), meaning she'd already
// taken several real, avoidable hits first. This borrows that handler's own proven force-cancel-
// then-wait-then-act sequence instead of the idle-tick gate every other routine check still
// correctly uses (their own physical actions genuinely can wait; a live threat cannot) --
// consistent with checkSleepingThreat's own precedent of bypassing busy/acting for exactly the
// one case nothing else can reach in time.
let selfDefenseInFlight = false;

async function checkSelfDefense() {
  if (!AUTONOMY_ENABLED || selfDefenseInFlight || bot.isSleeping) return;
  const threat = nearestHostile(bot, SELF_DEFENSE_RANGE);
  if (!threat) return;

  selfDefenseInFlight = true;
  console.log(`[${USERNAME}] self-defense: threat detected (${threat.name}) -- force-cancelling ` +
              `current action to respond`);
  if (Date.now() - lastSquadAlertAt > SQUAD_ALERT_COOLDOWN_MS) {
    lastSquadAlertAt = Date.now();
    broadcastThreatAlert(threat.name);
  }
  // Same interruption primitives actions.js's own stopCurrent() uses.
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  bot.collectBlock.cancelTask();
  bot.stopDigging();

  try {
    const deadline = Date.now() + 3000;
    while ((busy || acting) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
    acting = true;
    try {
      const type = bot.health <= SELF_DEFENSE_FLEE_HEALTH ? "flee" : "attack";
      console.log(`[${USERNAME}] self-defense: ${type} (health=${bot.health}, threat=${threat.name})`);
      // action.target: the already-found entity, not re-derived -- see actions.js's own
      // "attack"/"flee" 2026-09-08 changelog for the live thrash bug this closes.
      const result = await performAction(bot, { type, target: threat }, USERNAME);
      console.log(`[${USERNAME}] self-defense result: ${result.text} (ok=${result.ok})`);
    } finally {
      acting = false;
    }
  } catch (err) {
    console.error(`[${USERNAME}] self-defense check failed:`, err.message);
  } finally {
    selfDefenseInFlight = false;
  }
}

setInterval(() => {
  checkSelfDefense().catch((err) => console.error(`[${USERNAME}] checkSelfDefense error:`, err.message));
}, SELF_DEFENSE_CHECK_MS);

// Squad response (item #6 of "fix all the above"), the SQUAD_RESPONDER receiving side -- same
// force-cancel-then-wait-then-act shape checkSelfDefense already uses, since a teammate under
// attack is exactly as urgent as being under attack herself. Travels toward the alert's real
// coordinates (a manual setTimeout-guarded goto, same pattern the shore-travel code above already
// uses -- no shared withTimeout() to import, that helper is actions.js-private) and, once there,
// runs the real self-defense attack against whatever hostile she can actually find -- the
// original threat may already be dead by the time she arrives, in which case there's simply
// nothing left to do, a good outcome, not a failure.
const SQUAD_RESPONSE_TRAVEL_TIMEOUT_MS = 20_000;

async function respondToSquadCall(payload) {
  squadResponseInFlight = true;
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  bot.collectBlock.cancelTask();
  bot.stopDigging();
  try {
    const deadline = Date.now() + 3000;
    while ((busy || acting) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    acting = true;
    try {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; bot.pathfinder.setGoal(null); },
        SQUAD_RESPONSE_TRAVEL_TIMEOUT_MS);
      try {
        await bot.pathfinder.goto(new goals.GoalNear(payload.x, payload.y, payload.z, 4));
      } catch (err) {
        if (!timedOut) console.error(`[${USERNAME}] squad response travel failed:`, err.message);
      } finally {
        clearTimeout(timer);
        bot.pathfinder.setGoal(null);
      }

      const threat = nearestHostile(bot, SELF_DEFENSE_RANGE);
      if (!threat) {
        console.log(`[${USERNAME}] squad response: arrived, nothing left to fight.`);
      } else {
        const result = await performAction(bot, { type: "attack", target: threat }, USERNAME);
        console.log(`[${USERNAME}] squad response result: ${result.text} (ok=${result.ok})`);
      }
    } finally {
      acting = false;
    }
  } finally {
    squadResponseInFlight = false;
  }
}

// Direct follow-up, 2026-09-07: "look for more ways to improve their autonomy" -> hunger. Same
// idle-tick/busy-acting pattern as checkSleep/checkSelfDefense. Eats proactively (below full, not
// only once it's a real problem) since a failed "nothing to eat" check is cheap and harmless --
// correctness over minimizing calls, same standing instruction as everywhere else tonight.
const HUNGER_CHECK_MS = parseInt(process.env.MC_HUNGER_CHECK_MS || "15000", 10);
const HUNGER_THRESHOLD = 18; // out of a max of 20

async function checkHunger() {
  if (!AUTONOMY_ENABLED || busy || acting || bot.isSleeping) return;
  if (bot.food >= HUNGER_THRESHOLD) return;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  acting = true;
  try {
    const result = await performAction(bot, { type: "eat" }, USERNAME);
    if (result.ok) {
      console.log(`[${USERNAME}] hunger: ${result.text} (food was ${bot.food})`);
      return;
    }
    // Real gap: "eat" failing (almost always "don't have anything to eat") used to just get
    // silently ignored every 15s until food showed up on its own -- no attempt to actually GET
    // any. A held fishing rod turns hunger into something she can act on herself: a passive,
    // low-risk food source for when there's nothing to harvest/breed nearby either.
    if (bot.inventory.items().some((i) => i.name === "fishing_rod")) {
      const fishResult = await performAction(bot, { type: "fish" }, USERNAME);
      console.log(`[${USERNAME}] hunger (fishing): ${fishResult.text} (ok=${fishResult.ok})`);
    }
  } catch (err) {
    console.error(`[${USERNAME}] hunger check failed:`, err.message);
  } finally {
    acting = false;
  }
}

setInterval(() => {
  checkHunger().catch((err) => console.error(`[${USERNAME}] checkHunger error:`, err.message));
}, HUNGER_CHECK_MS);

// Direct follow-up, 2026-09-07: "look for more ways to improve their autonomy" -> bot-to-bot
// help. Fulfilling a request is itself a real action (path to the requester, toss the item), so
// it goes through the same idle-tick/busy-acting gate as everything else -- never interrupts
// whatever she's already doing. Clears the pending request regardless of outcome once attempted,
// rather than retrying indefinitely if the requester wandered off in the meantime.
const GIVE_CHECK_MS = parseInt(process.env.MC_GIVE_CHECK_MS || "10000", 10);

async function checkPendingGiveRequests() {
  if (!AUTONOMY_ENABLED || busy || acting || bot.isSleeping || !pendingGiveRequest) return;
  const { forPlayer, item, count } = pendingGiveRequest;
  pendingGiveRequest = null;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  acting = true;
  try {
    console.log(`[${USERNAME}] fulfilling request: giving ${count} ${item} to ${forPlayer}`);
    const result = await performAction(bot, { type: "give", player: forPlayer, item, count }, USERNAME);
    console.log(`[${USERNAME}] give result: ${result.text} (ok=${result.ok})`);
    if (result.ok) bot.chat(await narrateAction(`brought you some ${item}, ${forPlayer}.`));
  } catch (err) {
    console.error(`[${USERNAME}] give check failed:`, err.message);
  } finally {
    acting = false;
  }
}

setInterval(() => {
  checkPendingGiveRequests().catch((err) =>
    console.error(`[${USERNAME}] checkPendingGiveRequests error:`, err.message));
}, GIVE_CHECK_MS);

// Direct request, 2026-09-07 ("do all" -> base/chest storage). Same idle-tick/busy-acting
// pattern as everything else. bot.inventory.items().length is a clean count of occupied slots
// in the 36-slot main+hotbar range (one entry per occupied slot, confirmed against how loot's
// own containerItems()/items() distinction was worked out earlier tonight) -- no need to touch
// raw slot indices directly. Picks the single LARGEST non-essential stack so one trip actually
// frees meaningful space rather than storing one item at a time.
const INVENTORY_CHECK_MS = parseInt(process.env.MC_INVENTORY_CHECK_MS || "20000", 10);
const INVENTORY_FULL_SLOTS = 3; // 3 or fewer empty slots counts as "getting full"
const INVENTORY_MAIN_HOTBAR_SLOTS = 36;

// Extracted so checkInventoryInsurance() (below) can trigger the exact same store pass off a
// different condition, instead of a second copy drifting out of sync.
async function storeSurplusValuables(reason) {
  const surplus = bot.inventory.items().filter((i) => !isEssentialItem(i.name));
  if (!surplus.length) return; // genuinely nothing spare to store this tick
  surplus.sort((a, b) => b.count - a.count);
  const target = surplus[0];

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  acting = true;
  try {
    const result = await performAction(bot, { type: "store", item: target.name, count: target.count }, USERNAME);
    console.log(`[${USERNAME}] ${reason}: ${result.text} (ok=${result.ok})`);
  } catch (err) {
    console.error(`[${USERNAME}] ${reason} failed:`, err.message);
  } finally {
    acting = false;
  }
}

async function checkInventoryFull() {
  if (!AUTONOMY_ENABLED || busy || acting || bot.isSleeping) return;
  const emptySlots = INVENTORY_MAIN_HOTBAR_SLOTS - bot.inventory.items().length;
  if (emptySlots > INVENTORY_FULL_SLOTS) return;
  await storeSurplusValuables("inventory management");
}

setInterval(() => {
  checkInventoryFull().catch((err) => console.error(`[${USERNAME}] checkInventoryFull error:`, err.message));
}, INVENTORY_CHECK_MS);

// Item #5 of "fix all the above" (inventory insurance). Real gap: checkInventoryFull() only ever
// stores surplus when SPACE runs low -- a bot can carry a stack of diamonds or a full spare
// armor set indefinitely with room to spare and never bank any of it, so a death that was
// otherwise perfectly survivable-in-hindsight (just bad luck, not a resource problem) still wipes
// out real, hard-won progress for no reason a chest three minutes away couldn't have prevented.
// This is the same storeSurplusValuables() pass, triggered by a different, risk-based condition
// instead: taken real damage (health at or below INSURANCE_HEALTH_THRESHOLD, well above
// EMERGENCY_HEALTH_THRESHOLD's near-death flee trigger -- this fires on "this is getting risky,"
// not "about to die"). A cooldown keeps one low-health episode from retrying every tick while
// health stays low -- one honest attempt is enough; retrying constantly wouldn't bank anything
// new and would just compete with checkSelfDefense for the same idle ticks.
const INSURANCE_HEALTH_THRESHOLD = 14; // out of 20
const INSURANCE_COOLDOWN_MS = 120_000;
let lastInsuranceAttemptAt = 0;

async function checkInventoryInsurance() {
  if (!AUTONOMY_ENABLED || busy || acting || bot.isSleeping) return;
  if (bot.health > INSURANCE_HEALTH_THRESHOLD) return;
  if (Date.now() - lastInsuranceAttemptAt < INSURANCE_COOLDOWN_MS) return;
  lastInsuranceAttemptAt = Date.now();
  await storeSurplusValuables("inventory insurance");
}

setInterval(() => {
  checkInventoryInsurance().catch((err) =>
    console.error(`[${USERNAME}] checkInventoryInsurance error:`, err.message));
}, INVENTORY_CHECK_MS);

// Direct request, 2026-09-07 ("do 1-3" + "and 4" -> torch placement). Same idle-tick/busy-acting
// pattern as everything else -- fires between discrete actions rather than interrupting an
// in-flight bot.collectBlock.collect() mid-dig (which already handles its own tool/hand equip
// internally; swapping to a torch mid-collect would fight that). Reuses the EXISTING "place"
// action (already generic over any held block, see actions.js's own comment on it) rather than a
// new performAction case -- placing a torch is mechanically identical to placing a furnace.
// block.light (confirmed against prismarine-block source) is the real per-position light value,
// 0-15; under 8 is the common threshold below which hostile mobs can spawn, the same heuristic
// most mineflayer bots use since there's no simpler "is this dark" signal exposed directly.
const LIGHTING_CHECK_MS = parseInt(process.env.MC_LIGHTING_CHECK_MS || "20000", 10);
const DARK_LIGHT_LEVEL = 8;

async function checkLighting() {
  if (!AUTONOMY_ENABLED || busy || acting || bot.isSleeping || !bot.entity) return;
  if (!bot.inventory.items().some((i) => i.name === "torch")) return;
  const block = bot.blockAt(bot.entity.position);
  if (!block || block.light >= DARK_LIGHT_LEVEL) return;

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  acting = true;
  try {
    const result = await performAction(bot, { type: "place", item: "torch" }, USERNAME);
    if (result.ok) console.log(`[${USERNAME}] lighting: ${result.text} (light was ${block.light})`);
  } catch (err) {
    console.error(`[${USERNAME}] lighting check failed:`, err.message);
  } finally {
    acting = false;
  }
}

setInterval(() => {
  checkLighting().catch((err) => console.error(`[${USERNAME}] checkLighting error:`, err.message));
}, LIGHTING_CHECK_MS);

// Direct request, 2026-09-07 ("what else can we add" -> stuck-detection): robustness, not new
// capability -- a periodic check for "hasn't moved at all in a long time," regardless of
// busy/acting (deliberately NOT gated the same way as everything else: the whole point is to
// catch a bot that's wedged mid-action, and a jump doesn't cancel or conflict with whatever's
// actually running, unlike every other check here). A long threshold (5 minutes of literally
// zero movement) rather than a short one -- she can legitimately stand still for a while
// (idle, waiting to self-propose; sleeping; crafting/trading/enchanting at a fixed spot), and a
// jump nudge is harmless even in a false-positive case, so there's no need to be clever about
// distinguishing "genuinely idle" from "actually stuck," just patient about the threshold.
const STUCK_CHECK_MS = parseInt(process.env.MC_STUCK_CHECK_MS || "30000", 10);
const STUCK_THRESHOLD_MS = 5 * 60_000;
// Direct request, 2026-09-07 ("if a bot gets stuck, there needs to be a mechanism to teleport it
// back to its spawn point rather than continually restart that bot"): a jump nudge handles the
// common minor snag, but does nothing for a bot genuinely wedged (fallen into an inaccessible
// pocket, glitched into a block). MAX_STUCK_NUDGES consecutive zero-movement cycles despite
// nudging (10 minutes total, on top of the first 5 before nudging even starts) escalates to a
// real teleport rather than nudging forever.
const MAX_STUCK_NUDGES = parseInt(process.env.MC_MAX_STUCK_NUDGES || "2", 10);
// How close a fresh spawn's position has to be to the last saved one to count as "reconnected
// into the same spot," and how many such consecutive reconnects (via bot.once("spawn") below)
// before teleporting home immediately rather than waiting for checkStuck's own in-process timer.
const RESTART_STUCK_RADIUS = parseInt(process.env.MC_RESTART_STUCK_RADIUS || "3", 10);
const RESTART_STUCK_THRESHOLD = parseInt(process.env.MC_RESTART_STUCK_THRESHOLD || "2", 10);

let lastPosition = null;
let lastMovedAt = Date.now();
let stuckNudgeCount = 0;
// Set once at spawn (by the cross-restart check below) and carried forward as-is by every
// periodic save in checkStuck -- NOT reset to 0 here, or the periodic saves would destroy the
// cross-restart signal before the next crash ever got a chance to read it back.
let currentSameSpotCount = 0;

// bot.spawnPoint (confirmed against mineflayer's own spawn_point.js source: populated from the
// server's own spawn_position packet -- the same coordinate the vanilla compass points to, her
// bed if she's claimed one, otherwise the world spawn) is used as the teleport target rather
// than her own physical position, specifically because it's NOT corrupted by whatever bad spot
// she's currently wedged in. Requires /tp permission -- Babs/Amy/Mark/Luke were added to
// ops.json at level 2 (command access, not full admin) for exactly this.
async function teleportToSpawn(reason) {
  const dest = bot.spawnPoint;
  if (!dest || (dest.x === 0 && dest.y === 0 && dest.z === 0)) {
    console.error(`[${USERNAME}] can't teleport home -- no real spawn point known yet`);
    return;
  }
  console.log(`[${USERNAME}] TELEPORT: ${reason} -- heading back to spawn ${dest}`);
  // Same interruption primitives actions.js's own stopCurrent() uses (kept local to that file,
  // called at the top of every performAction) -- whatever she's doing physically is about to be
  // invalidated by teleporting, so stop it cleanly first rather than leaving it to dangle.
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  bot.collectBlock.cancelTask();
  bot.stopDigging();
  bot.chat(`/tp ${dest.x.toFixed(2)} ${dest.y.toFixed(2)} ${dest.z.toFixed(2)}`);
  // Whatever her standing goal assumed about her surroundings is now stale, same reasoning as
  // death/respawn.
  if (currentGoal) {
    await broadcastGoalState("abandoned", currentGoal.description);
    recordGoalOutcome(currentGoal.description, "gave up", "stuck");
    currentGoal = null;
    await clearGoal(PERSONA_NAME);
  }
}

function checkStuck() {
  if (!AUTONOMY_ENABLED || bot.isSleeping || !bot.entity) return;
  const pos = bot.entity.position;
  // Kept fresh on every tick (not just while possibly-stuck) so that IF this process goes down
  // for any reason, the next spawn's own cross-restart check (bot.once("spawn") below) is
  // comparing against somewhere close to where she actually was, not a stale position from
  // hours ago or the very start of this session.
  saveStuckState(PERSONA_NAME, { x: pos.x, y: pos.y, z: pos.z, sameSpotCount: currentSameSpotCount })
    .catch((err) => console.error(`[${USERNAME}] stuck-state save failed:`, err.message));
  if (!lastPosition || pos.distanceTo(lastPosition) > 0.1) {
    lastPosition = pos.clone();
    lastMovedAt = Date.now();
    stuckNudgeCount = 0; // real movement happened -- whatever the snag was, it's resolved
    return;
  }
  if (Date.now() - lastMovedAt < STUCK_THRESHOLD_MS) return;

  stuckNudgeCount += 1;
  lastMovedAt = Date.now(); // reset so this doesn't spam-nudge/escalate every 30s while still stuck

  if (stuckNudgeCount > MAX_STUCK_NUDGES) {
    stuckNudgeCount = 0;
    teleportToSpawn(`no movement for ${MAX_STUCK_NUDGES + 1} consecutive checks despite nudging`)
      .catch((err) => console.error(`[${USERNAME}] teleport-home failed:`, err.message));
    return;
  }

  console.log(`[${USERNAME}] possibly stuck -- no movement in ` +
              `${Math.round((Date.now() - lastMovedAt) / 1000)}s, nudging (${stuckNudgeCount}/${MAX_STUCK_NUDGES})`);
  bot.setControlState("jump", true);
  setTimeout(() => bot.setControlState("jump", false), 500);
}

setInterval(checkStuck, STUCK_CHECK_MS);

// Setting a goal is a fast, synchronous-feeling operation (a disk write, not a physical
// action) -- it runs inline inside handleIncoming's busy window rather than through runAction's
// fire-and-forget/`acting` path.
async function setNewGoal(description, speaker) {
  currentGoal = newGoal({ description, source: "user", setBy: speaker });
  await saveGoal(PERSONA_NAME, currentGoal);
  await broadcastGoalState("active", description);
  return currentGoal;
}

function handleIncoming(speaker, message, { alreadyAddressed, send }) {
  if (speaker === bot.username || speaker === MATRIX_USER_ID) return;
  // isMayor(speaker) exception, 2026-09-08: USERNAME !== MAYOR_USERNAME guards Mayor's own
  // process from ever treating himself as "a player talking to him" (redundant with the
  // bot.username check above in practice, kept explicit since this condition is the one place
  // that check is bypassed).
  if (isAnotherBot(speaker) && !(isMayor(speaker) && USERNAME !== MAYOR_USERNAME)) return;
  // Real live bug found 2026-09-08 ("check the bots other than mayor, they are stuck?"):
  // isMayor()'s own exception above lets Mayor's chat reach this function (needed for his
  // directives to reach classifyIntent -> ACTION GOAL), but this line used to reset
  // lastActivityAt for ANY message that got this far, Mayor's included -- and Mayor talks
  // periodically on his own (proposeDirectiveForOthers every MAYOR_DIRECTIVE_MS, his own
  // self-proposed-goal chat), which kept perpetually restarting every other bot's
  // IDLE_BEFORE_SELF_GOAL_MS countdown. Once a bot's own goal ended, she'd just stand there --
  // Mayor's mere presence meant the 10-minute idle window needed to self-propose a new one
  // could never actually elapse, unless he happened to specifically hand HER a new directive
  // (proposeDirectiveForOthers only ever picks one bot at a time) or a real player intervened.
  // Only an actual real player should count as "someone is here" for this specific clock --
  // Mayor's own directive-assignment already has its own real mechanism (ACTION GOAL) for
  // giving a bot something to do, it doesn't also need to gate everyone else's unrelated
  // self-propose timer.
  if (!isAnotherBot(speaker)) {
    lastActivityAt = Date.now(); // a real player is here -- the self-propose-a-goal idle clock resets
  }
  if (busy) {
    console.log(`[${USERNAME}] busy, dropping: <${speaker}> ${message}`);
    return;
  }
  busy = true;
  (async () => {
    try {
      const intent = await classifyIntent(speaker, message);
      // A whisper is already directed at her by construction -- a whisper classified as not
      // relevant at all still deserves *some* reply, unlike an unaddressed line in public chat.
      const type = alreadyAddressed && intent.type === "none" ? "chat" : intent.type;
      if (type === "none") return;

      if (type === "action") {
        if (intent.action.type === "goal") {
          // Direct request, 2026-09-08 ("the others can defer to him when his instructions are
          // not in conflict"): Mayor's own directive is the one goal-source that can be
          // overridden by something already in place -- a REAL PLAYER's own assignment
          // (source "user", set by anyone other than Mayor himself) outranks him, the same
          // hierarchy his own persona describes (defer to The President completely). A
          // self-proposed goal, an idle bot, or an earlier Mayor directive all yield to a new
          // one from him -- only a live human instruction doesn't.
          if (isMayor(speaker) && currentGoal?.source === "user" && currentGoal.setBy &&
              !isMayor(currentGoal.setBy)) {
            send(await narrateAction(
              `already on something for ${currentGoal.setBy}, Mayor -- that comes first.`));
            return;
          }
          await setNewGoal(intent.action.description, speaker);
          send(await narrateAction(`new goal: ${intent.action.description}. I'll work on it.`));
          return;
        }
        // "stop" means stop everything, not just the current physical motion -- a standing
        // goal she was working on shouldn't silently keep going after being told to stop.
        if (intent.action.type === "stop" && currentGoal) {
          await broadcastGoalState("abandoned", currentGoal.description);
          currentGoal = null;
          await clearGoal(PERSONA_NAME);
        }
        runAction(intent.action, speaker, message, send); // fire-and-forget, not awaited -- see runAction
        return;
      }

      const reply = await generateReply(speaker, message);
      if (reply) {
        send(reply);
        maybeRemember(speaker, message, reply); // fire-and-forget, not awaited
      }
    } catch (err) {
      console.error(`[${USERNAME}] decision loop error:`, err.message);
    } finally {
      busy = false;
    }
  })();
}

bot.on("chat", (speaker, message) => {
  handleIncoming(speaker, message, { alreadyAddressed: false, send: (reply) => bot.chat(reply) });
});

// /msg, /tell, /w -- mineflayer fires these separately from public chat. Reply the same way
// (a private whisper back), not into public chat.
bot.on("whisper", (speaker, message) => {
  handleIncoming(speaker, message, {
    alreadyAddressed: true,
    send: (reply) => bot.whisper(speaker, reply),
  });
});

// Matrix (design doc §10): the shared room, same relevance-classification treatment as public
// in-game chat (alreadyAddressed: false) since more than one bot reads this room and a message
// may be meant for only one of them by name. Optional -- no MATRIX_ACCESS_TOKEN, no watcher.
if (MATRIX_ACCESS_TOKEN) {
  watchRoom({
    homeserver: MATRIX_HOMESERVER,
    accessToken: MATRIX_ACCESS_TOKEN,
    roomId: MATRIX_ROOM_ID,
    onMessage: ({ sender, body }) => {
      handleIncoming(sender, body, {
        alreadyAddressed: false,
        send: (reply) =>
          matrixSend({ homeserver: MATRIX_HOMESERVER, accessToken: MATRIX_ACCESS_TOKEN,
                       roomId: MATRIX_ROOM_ID, body: reply }).catch((err) =>
            console.error(`[${USERNAME}] matrix send failed:`, err.message)),
      });
    },
  });
  console.log(`[${USERNAME}] watching Matrix room ${MATRIX_ROOM_ID} as ${MATRIX_USER_ID}`);
} else {
  console.log(`[${USERNAME}] MATRIX_ACCESS_TOKEN not set -- Matrix room disabled`);
}

// Bot-to-bot coordination (design doc §9): hear what other bots have decided is worth
// remembering, and say so in-game -- a directly observable trace that coordination actually
// happened, the same reasoning BuzzLog's Matrix mirror exists for human observability.
bot.once("spawn", () => {
  watchTopic({
    topic: "minecraft",
    selfAgent: AGENT_ID,
    onMessage: (msg) => {
      console.log(`[${USERNAME}] heard on Buzz from ${msg.from_agent}: ${msg.body}`);
      bot.chat(`(heard from ${msg.from_agent}) ${msg.body}`.slice(0, MAX_CHAT_LEN));
    },
  });

  // Cross-bot coordination (direct request, 2026-09-07: "look for more ways to improve their
  // autonomy") -- goal-awareness and item-requests. Structured JSON, never relayed into chat
  // (see hermes-buzz.py 2.0.18's own comment on why this is a separate topic from "minecraft").
  watchTopic({
    topic: "minecraft-coordination",
    selfAgent: AGENT_ID,
    onMessage: (msg) => {
      let payload;
      try {
        payload = JSON.parse(msg.body);
      } catch {
        return; // not a real coordination payload -- ignore rather than crash on it
      }
      if (payload.type === "goal") {
        if (payload.status === "active") otherBotGoals.set(msg.from_agent, payload.description);
        else otherBotGoals.delete(msg.from_agent);
        console.log(`[${USERNAME}] heard ${msg.from_agent}'s goal: ${payload.status === "active" ? payload.description : "(idle)"}`);
      } else if (payload.type === "threat" && SQUAD_RESPONDER && !squadResponseInFlight) {
        const dx = bot.entity.position.x - payload.x;
        const dy = bot.entity.position.y - payload.y;
        const dz = bot.entity.position.z - payload.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist <= SQUAD_ASSIST_RANGE) {
          console.log(`[${USERNAME}] squad response: ${msg.from_agent} under attack (${payload.name}) ` +
                      `${dist.toFixed(0)} blocks away -- moving to assist`);
          respondToSquadCall(payload).catch((err) =>
            console.error(`[${USERNAME}] squad response failed:`, err.message));
        }
      } else if (payload.type === "request" && !pendingGiveRequest) {
        // Only agrees to fulfill one request at a time (first-come-first-served) -- simple and
        // sufficient at 2-bot scale, avoids overcommitting inventory she doesn't actually have
        // by the time checkPendingGiveRequests() gets to act on it.
        const itemDef = bot.registry.itemsByName[payload.item];
        const have = itemDef ? bot.inventory.count(itemDef.id, null) : 0;
        if (have >= payload.count) {
          pendingGiveRequest = { forPlayer: payload.forPlayer, item: payload.item, count: payload.count };
          console.log(`[${USERNAME}] can fulfill ${msg.from_agent}'s request for ` +
                      `${payload.count} ${payload.item}`);
        }
      }
    },
  });
});

// Direct request, 2026-09-07 ("do all" -> death/respawn handling), never addressed before now.
// Confirmed against mineflayer's own health.js source: bot.respawn() fires automatically on
// death (this fleet never passes `respawn: false`), and 'spawn' re-emits once she's actually
// back -- the SAME event the very first bot.once("spawn", ...) above reacts to, so a second,
// persistent bot.on("spawn", ...) listener is needed here rather than reusing that one (a
// `.once` listener never fires again). hasSpawnedOnce distinguishes "the initial connection" (do
// nothing extra) from "a real respawn after dying" (the only time this block should act).
let deathPosition = null;
let hasSpawnedOnce = false;
let recovering = false;

// Direct request, 2026-09-07 ("set a limit on the number of times a bot will try to recover its
// gear from dying"): the `recovering` guard above only stops chasing the SAME lethal spot twice
// in a row -- it does nothing for a run of deaths in quick succession at nearby spots. Real gap
// found within minutes of shipping the first version of this cap (which reset on any recover()
// call reporting ok=true): a hostile mob camping the base kept killing both bots again seconds
// after each recovery, and recover() genuinely DID succeed every time -- she made it back and
// picked items up, she just didn't survive standing there afterward. A cap keyed to the recover
// action's own success never engaged at all. Counting real deaths by how close together they
// land in time, instead, catches this: any death within RAPID_DEATH_WINDOW_MS of the last one
// extends the same incident; a longer gap starts a fresh count. MAX_RECOVERY_ATTEMPTS is how
// many deaths in one such incident she'll still try to recover from before just accepting the
// loss and moving on -- which also means no longer walking back into whatever keeps killing her.
let recoveryAttempts = 0;
let lastDeathAt = 0;
const MAX_RECOVERY_ATTEMPTS = parseInt(process.env.MC_MAX_RECOVERY_ATTEMPTS || "3", 10);
const RAPID_DEATH_WINDOW_MS = 60_000;

bot.on("death", () => {
  const now = Date.now();
  recoveryAttempts = (now - lastDeathAt <= RAPID_DEATH_WINDOW_MS) ? recoveryAttempts + 1 : 1;
  lastDeathAt = now;

  if (recovering) {
    // Died again on the way to a previous death spot -- observed live tonight as an infinite
    // drowning loop (the spot itself was underwater, so every recovery attempt was itself fatal,
    // creating a fresh deathPosition each time and repeating every ~40-80s). recover()'s GoalNear
    // has no hazard-awareness; the cheap, safe fix is not to chase the same lethal spot twice.
    deathPosition = null;
    console.log(`[${USERNAME}] died again heading back for her gear (${recoveryAttempts} deaths ` +
      `in quick succession) -- giving up on that spot.`);
    return;
  }
  deathPosition = bot.entity.position.clone();
  console.log(`[${USERNAME}] died at ${deathPosition} (${recoveryAttempts} deaths in quick succession)`);
});

bot.on("spawn", () => {
  if (!hasSpawnedOnce) {
    hasSpawnedOnce = true;
    return; // the initial connection's own spawn -- already handled by the once() listener above
  }
  (async () => {
    console.log(`[${USERNAME}] respawned after dying`);
    try {
      bot.chat(await narrateAction("ouch, I died! let me get myself back together."));
    } catch (err) {
      // Caught live tonight: narrateAction's "muse" call returned 503 "Loading model" right after
      // a respawn, and since this line was awaited before the goal-abandon/recover logic below,
      // the outer .catch() swallowed the whole function -- a transient chat-flavor-text failure
      // was silently skipping the actual gear recovery. Isolated so it can't do that again.
      console.error(`[${USERNAME}] death narration failed:`, err.message);
    }
    // Vanilla drops everything at the death location and she respawns empty-handed -- whatever
    // her standing goal assumed about her gear/inventory is now stale, so it doesn't make sense
    // to just keep going as if nothing happened.
    if (currentGoal) {
      await broadcastGoalState("abandoned", currentGoal.description);
      recordGoalOutcome(currentGoal.description, "gave up", "died");
      currentGoal = null;
      await clearGoal(PERSONA_NAME);
    }
    const recoverAt = deathPosition;
    deathPosition = null;
    if (recoverAt && AUTONOMY_ENABLED && recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
      // Whatever's out there is still there -- recover() has no combat awareness of its own, so
      // walking back for gear right now would almost certainly just be death #(recoveryAttempts+1)
      // in the same streak. Skipping means she stops walking back into it; self-defense and the
      // rest of the idle-tick checks (which recover() itself was blocking via busy/acting for its
      // whole duration) get a real chance to run again on her next tick instead.
      console.log(`[${USERNAME}] skipping gear recovery -- ${recoveryAttempts} deaths in quick ` +
        `succession, accepting the loss for now.`);
    } else if (recoverAt && AUTONOMY_ENABLED) {
      // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
      acting = true;
      recovering = true;
      try {
        const result = await performAction(bot, { type: "recover", position: recoverAt }, USERNAME);
        console.log(`[${USERNAME}] recovery: ${result.text} (ok=${result.ok})`);
      } catch (err) {
        console.error(`[${USERNAME}] recovery failed:`, err.message);
      } finally {
        recovering = false;
        acting = false;
      }
    }
  })().catch((err) => console.error(`[${USERNAME}] post-respawn handling failed:`, err.message));
});

// True mid-action self-defense interrupt (direct request, 2026-09-07: "do all" -- explicitly
// deferred when self-defense first shipped as "a bigger design decision"). checkSelfDefense()'s
// own idle-tick version only ever runs BETWEEN actions; this fires in real time off mineflayer's
// own 'health' event so a bot mid-mine doesn't just keep swinging while a creeper closes in.
// Deliberately does NOT try to make every existing busy/acting call site aware of an external
// override (a much bigger, riskier refactor) -- instead, force-cancels whatever's physically
// happening RIGHT NOW using the exact same primitives actions.js's own stopCurrent() calls
// (safe, idempotent, a no-op if nothing's running), which makes the interrupted call's own
// promise settle almost immediately; THEN waits (briefly, bounded) for its normal finally block
// to release busy/acting on its own before running the real flee through the standard safe path.
const EMERGENCY_HEALTH_THRESHOLD = 6; // out of 20 -- stricter than checkSelfDefense's idle 10,
                                       // reserved for genuine near-death, not routine caution
let emergencyInFlight = false;

bot.on("health", () => {
  if (!AUTONOMY_ENABLED || emergencyInFlight) return;
  if (bot.health <= 0 || bot.health > EMERGENCY_HEALTH_THRESHOLD) return;
  const threat = nearestHostile(bot, SELF_DEFENSE_RANGE);
  if (!threat) return;

  emergencyInFlight = true;
  console.log(`[${USERNAME}] EMERGENCY: health critical (${bot.health}) with ${threat.name} ` +
              `nearby -- force-cancelling current action to flee`);
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  bot.collectBlock.cancelTask();
  // Real gap found live, 2026-09-07 ("they don't seem to be fighting back... when woken up from
  // sleeping"): none of the above touches sleep. The in-flight "sleep" performAction call holds
  // busy/acting for its ENTIRE duration (until the real 'wake' event or SLEEP_TIMEOUT_MS, up to
  // 15 minutes) -- while she's actually asleep, a forced flee attempt can't move her (the avatar
  // is pinned in bed), and this handler's own wait-then-force-through logic below would just
  // collide with sleep's own still-pending cleanup instead of freeing it. bot.wake() lets sleep's
  // own existing bot.once("wake", finish) listener resolve it and release busy/acting normally.
  if (bot.isSleeping) {
    bot.wake().catch((err) => console.error(`[${USERNAME}] emergency wake failed:`, err.message));
  }

  (async () => {
    const deadline = Date.now() + 3000;
    while ((busy || acting) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
    acting = true;
    try {
      const result = await performAction(bot, { type: "flee", target: threat }, USERNAME);
      console.log(`[${USERNAME}] emergency flee: ${result.text} (ok=${result.ok})`);
    } catch (err) {
      console.error(`[${USERNAME}] emergency flee failed:`, err.message);
    } finally {
      acting = false;
      emergencyInFlight = false;
    }
  })();
});

// Direct request, 2026-09-07 ("they need to know how to swim"). Real, confirmed gap: nothing in
// this file ever watched bot.oxygenLevel -- movements.liquidCost's own comment above already
// documents a live incident ("Amy drowned repeatedly because her death spot ... sat right at
// open water"), but that fix only ever discourages PATHFINDER route choice; it does nothing once
// a bot is actually submerged and running low on air for any other reason (fell in, a
// gohome/goal route crossed open water, chased into a lake while fleeing). mineflayer-pathfinder
// itself can never generate a "swim to the surface" move on its own -- confirmed against its own
// movements.js: getMoveUp() unconditionally refuses once already in liquid ("if (block1.liquid)
// return"), so resurfacing can never come from the path search itself, no matter the settings.
// bot.oxygenLevel (mineflayer's own entities.js, real server-tracked air supply 0-20, matching
// the vanilla bubble meter) and the real 'breath' event it fires on every change give a direct,
// verified hook; confirmed against prismarine-physics's own tick loop that holding the jump
// control while entity.isInWater adds upward velocity every tick (vel.y += 0.04) -- the same
// real mechanic a player uses to swim up, not a guess. Deliberately just a vertical surfacing
// reflex, not full swim-to-shore navigation -- a bigger feature than "don't drown" needed.
const DROWNING_OXYGEN_THRESHOLD = 4; // out of ~20 -- drowning damage only starts once air
                                      // actually hits 0, so this leaves a few real seconds of
                                      // margin, same "stricter than routine caution" reasoning
                                      // as EMERGENCY_HEALTH_THRESHOLD above
const SURFACE_SWIM_TIMEOUT_MS = 8000; // bounded -- never hold jump forever if something's wrong

// Direct report, 2026-09-08 ("they get in water, jump to come up, but do not ever try to reach
// land"): confirmed real -- the surfacing reflex above only ever answers "don't drown right
// now"; once oxygen recovered, nothing steered her anywhere, so she'd just keep floating (or
// sink again the moment something else needed her attention) exactly where she surfaced. This
// genuinely couldn't have worked when the surfacing reflex first shipped: mineflayer-pathfinder
// refused to generate any vertical move while already in liquid, so a goto() call from inside
// open water had no way to route out at all. swim-movements.js's own SwimMovements (shipped the
// same night, separately) is what makes this possible now -- getMoveUp()/getMoveDown() no
// longer refuse in water, so a normal pathfinder goal can actually find a way to shore.
// findNearestShore() can't match by block type (land isn't one block id) -- it scans for a
// column where the space to stand IN is open/non-liquid and the block below it is solid,
// non-liquid ground, using bot.findBlocks()'s own function-matcher path (confirmed sorted
// nearest-first by mineflayer's own blocks.js, not assumed).
const SHORE_SEARCH_DISTANCE = 48; // matches bot.pathfinder.searchRadius's own OOM-safety cap
                                   // from tonight's earlier investigation -- no point finding a
                                   // "shore" pathfinder could never actually route to anyway
const SHORE_TRAVEL_TIMEOUT_MS = 20_000;
let drowningInFlight = false;

function findNearestShore(bot, maxDistance) {
  // Real bug found live (2026-09-08): block.position was null for some candidate blocks
  // findBlocks() itself handed in (bot.blockAt() can return a Block missing this even when the
  // Block itself isn't null -- an edge the block-scanning code elsewhere in this file never hit
  // since it always calls blockAt() on a position IT already has, never a position handed back
  // TO it by the search). Defensive on both the block and its position now, not just liquid
  // checks that never actually threw.
  const positions = bot.findBlocks({
    maxDistance,
    count: 1,
    matching: (block) => {
      if (!block?.position || block.liquid || block.boundingBox === "block") return false;
      const below = bot.blockAt(block.position.offset(0, -1, 0));
      return !!below && !below.liquid && below.boundingBox === "block";
    },
  });
  return positions[0] || null;
}

bot.on("breath", () => {
  if (!AUTONOMY_ENABLED || drowningInFlight) return;
  if (!bot.entity.isInWater || bot.oxygenLevel > DROWNING_OXYGEN_THRESHOLD) return;

  drowningInFlight = true;
  console.log(`[${USERNAME}] EMERGENCY: oxygen critical (${bot.oxygenLevel}) -- force-cancelling ` +
              `current action to surface`);
  // Same interruption primitives actions.js's own stopCurrent() uses.
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  bot.collectBlock.cancelTask();
  bot.stopDigging();

  (async () => {
    const deadline = Date.now() + 3000;
    while ((busy || acting) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
    acting = true;
    try {
      bot.setControlState("jump", true);
      const surfaceDeadline = Date.now() + SURFACE_SWIM_TIMEOUT_MS;
      // Keep holding jump until oxygen is actually recovering (a reliable sign her head cleared
      // the surface) rather than just "not in water anymore" -- isInWater stays true while
      // floating right at the surface, so that alone would release control too early.
      while (bot.entity.isInWater && bot.oxygenLevel <= DROWNING_OXYGEN_THRESHOLD + 2 &&
             Date.now() < surfaceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      console.log(`[${USERNAME}] surfaced (oxygen=${bot.oxygenLevel}, stillInWater=${bot.entity.isInWater})`);
      bot.setControlState("jump", false);

      // Surviving the dunk isn't the same as being somewhere sensible -- head for the nearest
      // real dry land now that the pathfinder can actually generate a route out of water.
      if (bot.entity.isInWater) {
        const shore = findNearestShore(bot, SHORE_SEARCH_DISTANCE);
        if (!shore) {
          console.log(`[${USERNAME}] surfaced but couldn't find dry land within ${SHORE_SEARCH_DISTANCE} blocks`);
        } else {
          console.log(`[${USERNAME}] heading for dry land at`, shore);
          let timedOut = false;
          const timer = setTimeout(() => { timedOut = true; bot.pathfinder.setGoal(null); }, SHORE_TRAVEL_TIMEOUT_MS);
          try {
            await bot.pathfinder.goto(new goals.GoalNear(shore.x, shore.y, shore.z, 1));
          } catch (err) {
            if (!timedOut) console.error(`[${USERNAME}] couldn't reach shore:`, err.message);
          } finally {
            clearTimeout(timer);
            bot.pathfinder.setGoal(null);
          }
          console.log(`[${USERNAME}] reached shore attempt finished (isInWater=${bot.entity.isInWater})`);
        }
      }
    } catch (err) {
      console.error(`[${USERNAME}] surfacing failed:`, err.message);
    } finally {
      bot.setControlState("jump", false);
      acting = false;
      drowningInFlight = false;
    }
  })();
});

// Direct request, 2026-09-07 ("they don't seem to be fighting back... when woken up from
// sleeping"). Real gap: EVERY idle-tick check (checkSelfDefense included) is gated by the
// busy/acting mutex, and "sleep"'s own performAction call holds that mutex for its ENTIRE
// duration -- so until now, NOTHING but the emergency health-triggered interrupt above could
// react to a threat while she was actually asleep, and that one only ever fires once health has
// ALREADY dropped to a near-death threshold. A hostile that wanders up to a sleeping bot got to
// hit her repeatedly, completely unopposed, until she was nearly dead or happened to wake
// naturally. This check runs on its own short timer, deliberately bypassing busy/acting
// (checkStuck's own precedent) for the one case nothing else can reach: the moment a hostile is
// nearby while she's asleep, wake her up and respond exactly like checkSelfDefense normally
// would (flee below half health, otherwise fight) -- proactively, not just as a last resort.
const SLEEPING_THREAT_CHECK_MS = parseInt(process.env.MC_SLEEPING_THREAT_CHECK_MS || "5000", 10);

async function checkSleepingThreat() {
  if (!AUTONOMY_ENABLED || !bot.isSleeping) return;
  const threat = nearestHostile(bot, SELF_DEFENSE_RANGE);
  if (!threat) return;

  console.log(`[${USERNAME}] threat while sleeping (${threat.name}) -- waking up to respond`);
  try {
    await bot.wake();
  } catch (err) {
    console.error(`[${USERNAME}] force-wake failed:`, err.message);
    return;
  }
  // The in-flight "sleep" action's own wake listener resolves it and releases busy/acting
  // naturally within the same tick -- give it a brief moment before acting ourselves so this
  // doesn't collide with that cleanup still finishing.
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (busy || acting) return; // sleep's own cleanup is still finishing -- the next tick will catch it

  // busy deliberately not held here -- see goalTick's own 2026-09-07 fix note.
  acting = true;
  try {
    const type = bot.health <= SELF_DEFENSE_FLEE_HEALTH ? "flee" : "attack";
    const result = await performAction(bot, { type, target: threat }, USERNAME);
    console.log(`[${USERNAME}] post-wake defense: ${type} -> ${result.text} (ok=${result.ok})`);
  } catch (err) {
    console.error(`[${USERNAME}] post-wake defense failed:`, err.message);
  } finally {
    acting = false;
  }
}

setInterval(() => {
  checkSleepingThreat().catch((err) => console.error(`[${USERNAME}] checkSleepingThreat error:`, err.message));
}, SLEEPING_THREAT_CHECK_MS);

bot.on("kicked", (reason) => console.log(`[${USERNAME}] kicked:`, reason));
bot.on("error", (err) => console.log(`[${USERNAME}] error:`, err));
bot.on("end", (reason) => console.log(`[${USERNAME}] disconnected:`, reason));
