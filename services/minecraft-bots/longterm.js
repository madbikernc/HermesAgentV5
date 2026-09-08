// Version: 1.1.0
//
// 1.1.0 (2026-09-07) -- direct request: "what other behavior rules have any other sources
// published or suggested" -> note deduplication. writeMemoryNote() now checks for a
// near-duplicate before writing -- see its own comment for the real live evidence and threshold
// calibration. Requires hermes-rag-search-minecraft.py 1.1.0 (exposes the real cosine distance
// this check reads).
//
// Bridge to the "minecraft" long-term memory corpus (MINECRAFT_BOTS_DESIGN.md §7).
// hermes_rag_common.py has no HTTP API -- direct SQLite+sqlite-vec file access, unlike
// hermes-router.py/hermes-memory.py -- so this shells out to two small Python scripts
// (tools/hermes-rag-ingest-minecraft.py, tools/hermes-rag-search-minecraft.py) rather than
// reimplementing vector search in JS. Every call is best-effort: a failure here degrades a
// bot to short-term memory only (hermes-memory's turns, see memory.js), never a crash.

import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PYTHON = "/opt/hermes/venvs/rag/bin/python3";
const INGEST_SCRIPT = path.join(REPO_ROOT, "tools", "hermes-rag-ingest-minecraft.py");
const SEARCH_SCRIPT = path.join(REPO_ROOT, "tools", "hermes-rag-search-minecraft.py");
const MEMORY_DIR = "/mnt/hermes-data/minecraft-memory";

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "note";
}

// Real gap found live, 2026-09-07: the same fact ("no oak_log found nearby") got written to the
// shared world corpus SIX separate times over one night, and a differently-worded one ("no
// target found") three more -- nothing here ever checked whether an existing note already said
// basically the same thing before writing another one. Threshold calibrated against that exact
// live data (real cosine distance, not guessed): querying with a known duplicate's own exact
// text returned its five siblings at distance 0.08-0.10; querying with genuinely distinct notes
// (different facts, or the same topic worded differently) returned 0.57+. 0.15 sits with real
// margin on both sides.
const DUPLICATE_DISTANCE_THRESHOLD = 0.15;

// scope: "world" -> shared corpus note; "bot" -> this bot's own personal note (source_path
// under bots/<persona>/, not the speaker's name -- the persona owns the memory, the speaker
// is just recorded inside the note text for context).
export async function writeMemoryNote({ scope, persona, text }) {
  const existing = await searchMemory(text, { topK: 1 });
  if (existing.length && existing[0].distance <= DUPLICATE_DISTANCE_THRESHOLD) {
    console.log(`[longterm] skipping near-duplicate note (distance=${existing[0].distance.toFixed(3)}): ` +
      `"${text.slice(0, 80)}" already covered by ${existing[0].source_path}`);
    return;
  }

  const dir = scope === "world" ? path.join(MEMORY_DIR, "world")
                                 : path.join(MEMORY_DIR, "bots", persona);
  await mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${slugify(text)}.md`;
  await writeFile(path.join(dir, filename), text.trim() + "\n", "utf8");
  // Fire-and-forget: reindexing embeds only new/changed files (content-hash dedup, see the
  // ingest script's own docstring), so running it after every single note is cheap in
  // practice, not a growing cost -- and it happens after the reply already went out (see
  // index.js's use of this function), so it never adds latency the player would feel.
  try {
    await execFileAsync(PYTHON, [INGEST_SCRIPT]);
  } catch (err) {
    console.error(`[longterm] reindex failed after writing note:`, err.message);
  }
}

export async function searchMemory(query, { topK = 3 } = {}) {
  try {
    const { stdout } = await execFileAsync(PYTHON, [SEARCH_SCRIPT, query, "--top-k", String(topK)]);
    const results = JSON.parse(stdout);
    return Array.isArray(results) ? results : [];
  } catch (err) {
    console.error(`[longterm] search failed:`, err.message);
    return [];
  }
}
