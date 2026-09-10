// Version: 1.0.0
//
// 1.0.0 (2026-09-10) -- direct request: "write up a plan for that single arbiter, consider a
// single arbiter for the entire population, and a single arbiter PER bot" (following a "look at
// MIT Project SID and see if it advises on further autonomy" research pass that surfaced Project
// Sid/Altera.AL's PIANO architecture and its "coherence" problem -- concurrent modules directly
// manipulating shared interrupt state with no central arbiter -- as the same shape as several
// real bugs already found and fixed this session). Per-bot, not population-wide: each of the 5
// Minecraft bots is a fully separate OS process with no shared JS state today, and no bug found
// this session was ever about one bot's actions conflicting with ANOTHER bot's at this
// flag/interrupt level (cross-bot coordination already happens on a separate, async layer --
// Buzz's arbitrateGoalConflict/otherBotGoals/filterAwayFromOtherBots/broadcastThreatAlert -- this
// file doesn't touch any of that). A population-wide version would mean a new synchronous
// service all 5 processes call into for permission to act, putting real network latency/
// availability risk on the two most safety-critical paths (health/breath emergencies) for a
// cross-bot race that has never actually been observed. See the full comparison in the approved
// plan (C:\Users\madbi\.claude\plans\serialized-bouncing-thimble.md).
//
// Collapses TWO separate, independently-evolved interrupt-signaling systems into one:
// (1) index.js's own `busy`/`acting` module-level flags, read/written from ~20 functions, several
//     of which (checkSelfDefense, respondToSquadCall, the health/breath emergency handlers) don't
//     just check-and-skip -- they FORCE their way in by inlining the same 4 cancel primitives
//     (bot.pathfinder.setGoal(null), bot.pvp.stop(), bot.collectBlock.cancelTask(),
//     bot.stopDigging()), then poll busy||acting for up to 3000ms, then acquire. This exact
//     sequence was duplicated across at least 4 call sites with real drift between copies --
//     confirmed live, the health-emergency handler was missing bot.stopDigging() entirely, a
//     standing inconsistency the other three didn't have.
// (2) actions.js's own SEPARATE cancelToken (rotated by stopCurrent(), the first line of every
//     performAction() call) -- which those same index.js-side raw setGoal(null) calls never
//     touched. That gap is the confirmed root cause of a real, already-patched-with-a-heuristic
//     bug: the post-death recover() retry logic couldn't tell "I was legitimately preempted" from
//     "I genuinely failed," so it guessed by testing result.text for the literal substring
//     "The goal was changed" (index.js's own recovery-retry comment explains the full incident).
//
// One module-level `current` record now replaces both. Every caller -- planned (goalTick,
// runAction) or reflex (self-defense, emergencies, squad response, sleeping-threat, recovery,
// stuck-teleport) -- goes through requestControl()/releaseControl() instead of hand-rolling its
// own copy of the cancel-then-poll-then-acquire sequence. Migrated incrementally (see the plan's
// own phased order): this file lands first with zero caller changes (stopCurrent() delegates to
// cancelPhysical() here, everything else behaves identically), then the 4 highest-value/risk
// reflex handlers, then the two planned callers plus teleportToSpawn/recovery, then the ~9
// low-risk routine idle-tick checks -- only once every caller has migrated do index.js's own
// busy/acting variables get deleted.

// Real, load-bearing priority order -- reasoned from actual urgency, not just adopted from a
// draft list. HEALTH_CRITICAL outranks DROWNING because the oxygen-critical threshold (see
// index.js's own DROWNING_OXYGEN_THRESHOLD comment) banks several real seconds of margin before
// drowning damage actually starts, while health-critical means a near-fatal hit already landed --
// closer to death, wins. SELF_DEFENSE sits below both: checkSelfDefense already self-downgrades
// to "flee" near SELF_DEFENSE_FLEE_HEALTH, so it rarely genuinely contends with the emergency
// handlers -- the arbiter mainly matters for the rare tick where health drops between polls.
// TELEPORT_HOME sits above everything and is cancel-only (see requestControl's own `cancelOnly`
// option) -- a genuinely wedged bot can't perform ANY physical action anyway, so yielding to it
// costs a live emergency nothing real. RECOVERY sits just above DIRECT_COMMAND: nothing is
// usually running right after a respawn, but a live squad call or fresh threat should still
// legitimately interrupt an in-progress recovery walk -- the exact drowning-loop scenario
// recoveryAttempts/MAX_RECOVERY_ATTEMPTS already exists to survive.
export const OWNERS = Object.freeze({
  ROUTINE: 0,           // idle-tick checks: inventory, saplings, lighting, hunger, give-requests,
                         // checkSleep, checkDusk, checkStuck's own routine (non-teleport) work
  GOAL_STEP: 0,          // goalTick's own physical-action span -- same tier as ROUTINE, matching
                         // today's code (both already just check `!busy && !acting`, no
                         // hierarchy between them, and this preserves that rather than inventing
                         // a distinction the current code never needed)
  DIRECT_COMMAND: 10,    // runAction() -- a live player asked for this by name; "a live player
                         // command always wins immediately" per goalTick's own existing comment
  RECOVERY: 15,          // post-death gear recovery
  SQUAD_RESPONSE: 20,    // respondToSquadCall()
  SELF_DEFENSE: 30,      // checkSelfDefense(); checkSleepingThreat()'s post-wake response reuses
                         // this same tier -- mechanically identical decision, just reached via a
                         // different trigger (asleep+threat vs. awake+idle-tick)
  DROWNING: 40,          // bot.on("breath") emergency surface
  HEALTH_CRITICAL: 50,   // bot.on("health") emergency flee
  TELEPORT_HOME: 60,     // checkStuck's teleport escalation -- cancel-only, never blocks or waits
});

const DEFAULT_WAIT_MS = 3000;
const POLL_INTERVAL_MS = 100;

let current = null; // { owner, priority, token } | null

// The one place the 4 raw primitives get called -- exactly stopCurrent()'s previous body
// (actions.js). Deliberately a PURE physical interrupt with no token/ownership bookkeeping of
// its own, so it's safe to call from both of this file's two entry points below without either
// one accidentally cancelling a token the other just created (a real design trap: if this
// function also rotated `current` itself, requestControl() calling it AFTER already writing its
// own new `current` record -- as an unmigrated performAction() call made from inside an
// already-in-flight requestControl() handle would -- would immediately self-cancel the handle it
// just acquired).
function cancelPhysical(bot) {
  bot.pathfinder.setGoal(null);
  if (bot.pvp.target) bot.pvp.stop();
  // Real bug found live, 2026-09-07 (chasing an all-day recurring OOM crash): cancelTask() only
  // ever calls bot.pathfinder.stop() -- collectBlock's mineBlock() calls the core bot.dig()
  // directly, entirely outside pathfinder's control, so cancelTask() alone does nothing to an
  // in-flight dig. bot.stopDigging() is a safe no-op when nothing is currently being dug
  // (checked internally against bot.targetDigBlock) -- always call it, unconditionally, exactly
  // like stopCurrent() always did. This is the one call the health-emergency handler was
  // missing before migrating to this shared function.
  bot.collectBlock.cancelTask();
  bot.stopDigging();
  if (bot.isSleeping) bot.wake().catch((err) => console.error("arbiter: wake failed:", err.message));
}

// Legacy-compatible entry point: exactly stopCurrent()'s old, unconditional behavior --
// physically cancel whatever's running and rotate to a fresh, un-owned ROUTINE-tier token.
// This is what actions.js's own stopCurrent() delegates to (Phase 1 -- see this file's own
// header), so every performAction() call keeps behaving exactly as it does today until later
// phases migrate individual callers to requestControl() instead. Returns a token-shaped object
// (`{cancelled, preempted, preemptedBy}`) so the ~50 existing `token.cancelled` checks inside
// performAction()'s own switch keep working unchanged.
export function cancelAndRotate(bot) {
  cancelPhysical(bot);
  if (current) current.token.cancelled = true;
  const token = { cancelled: false, preempted: false, preemptedBy: null };
  current = { owner: OWNERS.ROUTINE, priority: OWNERS.ROUTINE, token };
  return token;
}

/**
 * Requests control of the bot's physical actions. Force-cancels whatever's currently running IF
 * the requester's priority is >= the current holder's, marking the PREVIOUS holder's token as
 * genuinely preempted (not just cancelled) so callers like recover() can tell "I was legitimately
 * preempted" from "I genuinely failed" -- see this file's own header on why that distinction was
 * the confirmed root cause of a real bug. Waits up to opts.waitMs (default 3000) for a
 * lower-or-equal priority holder to release cleanly before force-cancelling anyway, matching
 * every existing reflex handler's own current 3000ms/100ms polling shape (now one implementation
 * instead of four).
 *
 * Returns a handle ({ owner, priority, token, release }) on success, or null if a STRICTLY
 * HIGHER-priority owner still holds control after waitMs -- callers should treat null as
 * "something more urgent is happening, bail cleanly," exactly like today's reflex handlers
 * already do when their own wait loop times out with busy/acting still held.
 */
export async function requestControl(bot, owner, priority, opts = {}) {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  while (current && current.priority > priority && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (current && current.priority > priority) return null; // still held by something more urgent

  if (current) {
    current.token.cancelled = true;
    current.token.preempted = true;
    current.token.preemptedBy = owner;
  }
  cancelPhysical(bot);
  const token = { cancelled: false, preempted: false, preemptedBy: null };
  const record = { owner, priority, token };
  current = record;
  // Captures `record` (this call's own stable object), not the mutable `current` variable --
  // by the time release() actually runs, `current` may already point at a later, unrelated
  // caller's own record, and releaseControl() must only ever clear a record it's actually still
  // holding (its own token-identity check already guards this too, this is defense in depth).
  return { owner, priority, token, release: () => releaseControl(record) };
}

/** Releases a handle acquired via requestControl(). No-op if already released/superseded. */
export function releaseControl(handle) {
  if (current && handle && current.token === handle.token) current = null;
}

/** True if anything currently holds control. Replaces `busy || acting` reads. */
export function isBusy() {
  return current !== null;
}

/** Current holder's owner name (an OWNERS key), or null. */
export function currentOwner() {
  return current?.owner ?? null;
}
