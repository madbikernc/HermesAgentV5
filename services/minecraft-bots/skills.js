// Version: 1.0.0
//
// 1.0.0 (2026-09-08) -- direct request "start on #6" (MINECRAFT_BOTS_DESIGN.md §14, a Voyager-
// style dynamic skill library). A skill is data, not code: {name, steps: [{action, ...args}]} --
// `action` must be one of actions.js's own SKILL_ACTION_VERBS, checked here before a skill is
// ever stored or run, never raw code/eval (§14's own deliberate deviation from Voyager's
// architecture -- four bots share one live world, arbitrary LLM-authored code has no place in
// it). Storage/retrieval reuses hermes-rag (a new "minecraft-skills" corpus, its own ingest/
// search script pair mirroring hermes-rag-ingest/search-minecraft.py exactly) rather than new
// infrastructure -- same "shell out to a purpose-built script" split longterm.js already uses,
// since hermes_rag_common.py has no HTTP API.
//
// Bridge to the real, already-executed action log: a skill's steps are never re-derived from an
// LLM reading a goal's own text log (a real hallucination risk for something meant to be
// replayed verbatim) -- goals.js's own actionsTaken (1.3.0) already captures the exact
// {type, ...args} object every successful step actually ran with, and authorSkillFromGoal()
// below uses that directly. The only LLM call in this whole file is a cheap one asking for a
// short name/description to file the already-real steps under.

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_ACTION_VERBS } from "./actions.js";
import { callRole } from "./router.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PYTHON = "/opt/hermes/venvs/rag/bin/python3";
const SEARCH_SCRIPT = path.join(REPO_ROOT, "tools", "hermes-rag-search-minecraft-skills.py");
const INGEST_SCRIPT = path.join(REPO_ROOT, "tools", "hermes-rag-ingest-minecraft-skills.py");
const SKILLS_DIR = "/mnt/hermes-data/minecraft-memory/skills";

// Empirically calibrated live against a real seeded test skill, not guessed -- and NOT the same
// order of magnitude as longterm.js's own DUPLICATE_DISTANCE_THRESHOLD (0.15), which was tuned
// for near-DUPLICATE text (the same fact, reworded slightly). A goal description and a stored
// skill's description are written by two different model calls at two different times for the
// same general TASK, a much looser match -- real queries closely related to a real seeded skill
// ("craft a wooden pickaxe," "I have no tools and need a pickaxe," "gather wood and make a
// pickaxe") measured cosine distance 0.54-0.64 against it; queries for a genuinely different
// task ("get iron armor," "build a small shelter for the night") returned no candidate at all
// rather than a bad-but-present match -- confirmed this is search()'s own corpus-filtering
// behavior (hermes_rag_common.py), not a relevance cutoff: it fetches a modestly widened top-K
// across ALL corpora sharing one vec_chunks table, then filters to this one afterward, so a
// still-small "minecraft-skills" corpus can get crowded out of that shared pool entirely by
// larger corpora (fleet-docs/ops/podcasts/personal-kb) before this threshold ever gets a chance
// to reject anything -- expect retrieval to get MORE reliable, not less, as more skills exist to
// compete for a place in that shared pool, not something to "fix" here. 0.7 sits with real
// margin above the observed genuine-match range while still providing a real ceiling once the
// corpus is big enough for an actual bad-but-present match to show up.
const MATCH_DISTANCE_THRESHOLD = 0.7;
// Matches actions.js's own comment on why a stored skill is bounded, not an unbounded program --
// same "small, fixed caps everywhere else in this codebase" reasoning as
// HARVEST_BATCH_LIMIT/MAX_CONSECUTIVE_FAILURES.
const MAX_SKILL_STEPS = 12;
const MAX_SKILL_FAILURES = 3;
// A goal solved in fewer real steps than this isn't worth compressing into a reusable skill --
// authoring (and every future retrieval attempt) costs more than just re-deriving something
// this short would ever save.
const MIN_STEPS_TO_AUTHOR = 2;

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "skill";
}

async function searchSkillCandidates(description, topK = 3) {
  try {
    const { stdout } = await execFileAsync(PYTHON, [SEARCH_SCRIPT, description, "--top-k", String(topK)]);
    const results = JSON.parse(stdout);
    return Array.isArray(results) ? results : [];
  } catch (err) {
    console.error("[skills] search failed:", err.message);
    return [];
  }
}

// Real allowlist/shape validation -- checked both before a skill is ever written AND every time
// one is read back, never trusted blindly either direction (a file on disk could in principle be
// hand-edited or come from a future format change).
function isValidSkill(skill) {
  if (!skill || typeof skill !== "object") return false;
  if (!Array.isArray(skill.steps) || !skill.steps.length || skill.steps.length > MAX_SKILL_STEPS) return false;
  return skill.steps.every((s) => s && typeof s === "object" && SKILL_ACTION_VERBS.has(s.type));
}

// Returns the best matching trusted skill for a goal description, or null. Best-first order from
// search() means the first candidate that's both close enough (MATCH_DISTANCE_THRESHOLD) and
// still trusted (hasn't crossed MAX_SKILL_FAILURES) wins -- an untrusted near-match doesn't block
// a genuinely different, farther-but-still-relevant candidate from being tried instead.
export async function findSkill(description) {
  const candidates = await searchSkillCandidates(description, 3);
  for (const candidate of candidates) {
    if (candidate.distance > MATCH_DISTANCE_THRESHOLD) continue;
    const jsonPath = candidate.source_path.replace(/\.md$/, ".json");
    let skill;
    try {
      skill = JSON.parse(await readFile(path.join(SKILLS_DIR, jsonPath), "utf8"));
    } catch (err) {
      console.error(`[skills] failed to load ${jsonPath}:`, err.message);
      continue;
    }
    if (!isValidSkill(skill)) continue;
    if ((skill.consecutiveFailures || 0) >= MAX_SKILL_FAILURES) continue;
    return { ...skill, jsonPath };
  }
  return null;
}

// The skill-runner: executes steps through the EXACT SAME performAction() pipeline every direct
// command and every per-tick goal step already goes through -- passed in rather than imported
// directly so this stays a pure orchestration layer over actions.js, same
// "deliberately dumb, index.js does the mutating" split goals.js's own module already uses.
// Inherits stopCurrent()'s interrupt guarantees and the busy/acting discipline for free,
// specifically because it is not a separate execution path (§14's own design point).
export async function runSkill(performActionFn, bot, skill, speaker) {
  for (const step of skill.steps) {
    const { type, ...args } = step;
    const result = await performActionFn(bot, { type, ...args }, speaker);
    if (!result.ok) {
      return { ok: false, text: `skill "${skill.name}" stalled on ${type}: ${result.text}` };
    }
  }
  return { ok: true, text: `completed skill "${skill.name}".` };
}

// Trust/decay: a skill that fails when replayed gets a failure recorded against it, reusing the
// same consecutiveFailures-style counter goals.js already tracks per-goal. Crossing
// MAX_SKILL_FAILURES makes findSkill() skip it (see above) -- not deleted outright, since a skill
// that fails in one biome/situation may still be right in another, and deletion risks losing
// something a future fix could revalidate.
export async function recordSkillOutcome(jsonPath, success) {
  const filePath = path.join(SKILLS_DIR, jsonPath);
  try {
    const skill = JSON.parse(await readFile(filePath, "utf8"));
    skill.consecutiveFailures = success ? 0 : (skill.consecutiveFailures || 0) + 1;
    await writeFile(filePath, JSON.stringify(skill, null, 2), "utf8");
  } catch (err) {
    console.error(`[skills] failed to record outcome for ${jsonPath}:`, err.message);
  }
}

// Writes a skill's two files (description .md for embedding, steps .json for execution -- see
// this file's own header for why they're split) and reindexes. Real, validated steps only --
// silently discards (returns false) anything that doesn't pass isValidSkill(), matching
// writeMemoryNote()'s own "never store something broken" discipline.
export async function writeSkill({ name, description, steps }) {
  if (!isValidSkill({ steps })) {
    console.log(`[skills] discarding invalid skill "${name}" -- steps failed validation`);
    return false;
  }
  const filename = slugify(name || description);
  await mkdir(SKILLS_DIR, { recursive: true });
  await writeFile(path.join(SKILLS_DIR, `${filename}.md`), description.trim() + "\n", "utf8");
  await writeFile(path.join(SKILLS_DIR, `${filename}.json`),
    JSON.stringify({ name, steps, consecutiveFailures: 0 }, null, 2), "utf8");
  try {
    await execFileAsync(PYTHON, [INGEST_SCRIPT]);
  } catch (err) {
    console.error("[skills] reindex failed after writing skill:", err.message);
  }
  return true;
}

// Authoring: called once a goal reaches DONE, only when it wasn't already served by an existing
// skill (goal.servedBySkill, index.js decides that) and worked through enough real steps to be
// worth compressing (MIN_STEPS_TO_AUTHOR) -- an occasional `coder` call, not a per-tick cost,
// same reasoning MINECRAFT_BOTS_DESIGN.md §6 already gives for why cross-bot arbitration is a
// `super` call and not a per-tick one. The LLM only ever names/describes the ALREADY-REAL
// actionsTaken array -- it never invents or re-derives the steps themselves.
export async function authorSkillFromGoal(goalDescription, actionsTaken) {
  if (!Array.isArray(actionsTaken) || actionsTaken.length < MIN_STEPS_TO_AUTHOR) return false;
  const steps = actionsTaken.slice(0, MAX_SKILL_STEPS);
  if (!isValidSkill({ steps })) return false; // a verb outside SKILL_ACTION_VERBS slipped in somehow -- don't store it

  const stepsSummary = steps.map((s) => s.type).join(" -> ");
  let reply;
  try {
    reply = await callRole("coder", [
      { role: "system", content:
          "You name and describe a Minecraft bot skill for a searchable library, given the goal " +
          "it came from and the real sequence of actions that solved it. Respond in EXACTLY this " +
          "format, two lines:\nNAME: <a short, filename-safe skill name, 2-4 words>\n" +
          "DESCRIPTION: <one sentence describing what this skill accomplishes and when it's useful>" },
      { role: "user", content: `Goal: ${goalDescription}\nActions taken, in order: ${stepsSummary}` },
    ], { maxTokens: 100, temperature: 0.3 });
  } catch (err) {
    console.error("[skills] authoring call failed:", err.message);
    return false;
  }

  const nameMatch = reply.match(/NAME:\s*(.+)/i);
  const descMatch = reply.match(/DESCRIPTION:\s*(.+)/i);
  const name = nameMatch ? nameMatch[1].trim().slice(0, 60) : null;
  const description = descMatch ? descMatch[1].trim().slice(0, 200) : null;
  if (!name || !description) return false;

  return writeSkill({ name, description, steps });
}
