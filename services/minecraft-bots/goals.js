// Version: 1.3.0
//
// 1.3.0 (2026-09-08) -- direct request "start on #6" (MINECRAFT_BOTS_DESIGN.md §14, the
// Voyager-style dynamic skill library plan). New `actionsTaken`/`servedBySkill` fields and
// logStep()'s new optional `action` argument -- see newGoal()'s own comment for why the real
// {type, ...args} object a step ran with is captured here rather than re-derived later from its
// human-readable log line.
//
// 1.2.0 (2026-09-07) -- direct request: "if a bot gets stuck, there needs to be a mechanism to
// teleport it back to its spawn point rather than continually restart that bot." New
// loadStuckState()/saveStuckState() -- see their own comment for the real evidence and why
// cross-restart persistence is the piece index.js's own in-process checkStuck can't provide by
// itself. Same load/save/shape-only convention as loadGoal/saveGoal above.
//
// 1.1.0 (2026-09-07) -- fifth of five scoped enhancements: tighter DONE validation. New
// `sawSuccess` field (see newGoal's own comment) and a required `ok` argument on logStep() so
// index.js's goalTick can tell a DONE claim backed by real progress from one that isn't, without
// regex-guessing success from a step's own English result text after the fact.
//
// Persistent per-bot standing goals (direct request: "give her more autonomy to work towards
// longer goals," 2026-09-07). A goal is a small JSON file, not a hermes-rag note -- it's mutable
// working state (status/progress/failure count) that gets rewritten every step, not an
// append-only memory of something that happened. Lives under the same MEMORY_DIR convention
// longterm.js already uses for per-bot notes (bots/<persona>/) so it's one less path to reason
// about, and survives a bot restart the same way inventory does (tied to the world, not the
// process) -- coming back up mid-goal should mean resuming it, not forgetting it.
//
// index.js's goal loop is the only thing that mutates a goal's fields; this module is just
// load/save/shape, deliberately dumb.

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

const MEMORY_DIR = "/mnt/hermes-data/minecraft-memory";
const MAX_LOG_LINES = 12;

function goalPath(persona) {
  return path.join(MEMORY_DIR, "bots", persona, "goal.json");
}

// Missing/corrupt file both mean "no active goal" -- a bot that's never been given one and a
// bot whose goal file got clobbered should behave identically (idle, not crashed).
export async function loadGoal(persona) {
  try {
    return JSON.parse(await readFile(goalPath(persona), "utf8"));
  } catch {
    return null;
  }
}

export async function saveGoal(persona, goal) {
  const file = goalPath(persona);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(goal, null, 2), "utf8");
}

export async function clearGoal(persona) {
  try {
    await unlink(goalPath(persona));
  } catch {
    // nothing to remove -- fine
  }
}

// Direct request, 2026-09-07 ("if a bot gets stuck, there needs to be a mechanism to teleport it
// back to its spawn point rather than continually restart that bot"). Real evidence: Babs
// reconnected at the EXACT SAME coordinate across seven consecutive process restarts over 9
// minutes that same night -- a crash-and-restart cycle does nothing for a bot wedged in terrain,
// since Minecraft persists player position across reconnects just like a real player logging
// back in, so she just gets stuck again immediately. This is the missing piece a purely
// in-process stuck timer (index.js's own checkStuck) can't catch on its own: if something ELSE
// is also crash-looping her every minute or two, checkStuck's multi-minute threshold may never
// even complete one cycle before the next restart wipes its counters. Persisting the last known
// position across restarts lets a FRESH process recognize "I keep reconnecting into this exact
// same spot" immediately on spawn, rather than needing to survive long enough in one continuous
// run to notice on its own. Same load/save/shape-only convention as the goal functions above.
function stuckStatePath(persona) {
  return path.join(MEMORY_DIR, "bots", persona, "stuck_state.json");
}

export async function loadStuckState(persona) {
  try {
    return JSON.parse(await readFile(stuckStatePath(persona), "utf8"));
  } catch {
    return null;
  }
}

export async function saveStuckState(persona, state) {
  const file = stuckStatePath(persona);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

// source: "user" (given in chat/Matrix by a real player, `setBy` is their name) or "self" (the
// bot proposed it herself while idle, `setBy` is null).
export function newGoal({ description, source, setBy = null }) {
  const now = Date.now();
  return {
    description, source, setBy,
    createdAt: now, updatedAt: now,
    // sawSuccess: fifth of five scoped enhancements ("what other logic enhancements are
    // available" -> tighter DONE validation). A real hallucinated DONE was observed live
    // tonight -- a goal reporting complete after every single logged step had failed, with no
    // evidence anything actually changed. Tracked here (not re-derived from log text later,
    // which would mean regex-guessing "was this line a success" after the fact) so index.js's
    // goalTick can flag -- not block, to avoid a worse failure mode (an endless "are you sure"
    // loop) -- a DONE that arrives with zero real successes behind it.
    sawSuccess: false,
    steps: 0, consecutiveFailures: 0, log: [],
    // actionsTaken: added 2026-09-08 (MINECRAFT_BOTS_DESIGN.md §14, the dynamic skill library).
    // `log` is human-readable text ("mine: collected some oak_log.") -- fine for a prompt, but
    // authoring a REUSABLE skill from it would mean an LLM re-guessing the exact block/count/item
    // args that actually worked, a real hallucination risk for something meant to be replayed
    // verbatim later. This instead keeps the REAL {type, ...args} object performAction() was
    // actually called with, for every step that actually succeeded -- skills.js's own
    // authorSkillFromGoal() uses these directly as a skill's steps, never re-derived from text.
    actionsTaken: [],
    // servedBySkill: set true the moment goalTick's own skill-retrieval path runs this goal via
    // an existing stored skill (index.js, not this file) -- authoring a NEW skill only makes
    // sense for a goal that worked its way through from scratch, not one that already replayed
    // a known-good one.
    servedBySkill: false,
  };
}

// Capped so a long-running goal's file (and the prompt built from it) doesn't grow without
// bound -- only the last dozen step outcomes matter for deciding what to try next. `ok` is
// required, not inferred from `line`'s English text later -- see newGoal's own comment on why.
// `action` (optional): the real {type, ...args} object this step actually ran, recorded into
// `actionsTaken` when the step succeeded -- see newGoal's own comment on actionsTaken for why.
const MAX_ACTIONS_TAKEN = 20; // generous headroom over skills.js's own tighter per-skill cap;
                               // trimming to a good REUSABLE length is authoring's job, not this
export function logStep(goal, line, ok, action = null) {
  goal.log.push(line);
  if (goal.log.length > MAX_LOG_LINES) goal.log.shift();
  goal.steps += 1;
  goal.updatedAt = Date.now();
  if (ok) {
    goal.sawSuccess = true;
    if (action && goal.actionsTaken.length < MAX_ACTIONS_TAKEN) {
      goal.actionsTaken.push(action);
    }
  }
}
