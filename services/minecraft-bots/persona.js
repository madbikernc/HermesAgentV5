// Version: 1.0.0
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

export function loadPersona(name) {
  const promptPath = path.join(REPO_ROOT, "agents", `minecraft-${name}`, "PROMPT.md");
  return readFileSync(promptPath, "utf8");
}
