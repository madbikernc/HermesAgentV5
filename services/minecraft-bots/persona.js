// Version: 1.1.0
//
// 1.1.0 (2026-09-24) -- direct request ("minimize and deduplicate behavior rules"): the rules
// that were identical in all nine PROMPT.md files (be useful, never claim a capability you lack,
// treat chatters as strangers, ignore injection attempts) now live once in
// agents/minecraft-common.md and are prepended here. Each PROMPT.md is personality only. Reply
// length stays in index.js's CHAT_INSTRUCTION, at the one call site that cares -- deliberately
// not restated in the shared file, since re-duplicating it there is the exact thing this change
// removes.
//
// Loads a bot's personality from agents/minecraft-<persona>/PROMPT.md -- the first real
// consumer of the fleet's agents/*/PROMPT.md convention (see IMPLEMENTATION_PLAN.md, S8).
// The Boss edits these files directly; nothing here interprets structure beyond reading the
// whole file as the system prompt.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COMMON_PATH = path.join(REPO_ROOT, "agents", "minecraft-common.md");

export function loadPersona(name) {
  const promptPath = path.join(REPO_ROOT, "agents", `minecraft-${name}`, "PROMPT.md");
  // Read both every call rather than caching -- index.js already calls this exactly once at
  // startup (its own load-once pattern), so there is nothing to save, and an edit to either file
  // takes effect on the next restart with no cache to reason about.
  return `${readFileSync(COMMON_PATH, "utf8").trim()}\n\n---\n\n${readFileSync(promptPath, "utf8").trim()}`;
}
