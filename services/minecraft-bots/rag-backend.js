// Version: 1.0.0
//
// Where the bots' RAG memory lives, behind four operations: search a corpus, (re)index a corpus,
// and read/write a file under the Minecraft memory directory.
//
// Local mode (spark, the default): exactly what longterm.js/skills.js always did -- the RAG venv's
// hermes-rag-{search,ingest}-minecraft.py scripts and direct file access under MEMORY_DIR.
//
// Remote mode (MC_RAG_URL set, e.g. spark2): the index (/mnt/hermes-data/rag/vectors.db), the
// embedding server (127.0.0.1:8092) and the shared memory directory all live on spark, so these
// operations go to tools/hermes-minecraft-rag-server.py there instead, authenticated with the bot's
// MEMORY_TOKEN. Before this (2026-09-25) spark2's bots had no RAG at all: every search failed on a
// missing venv, duplicate checks never matched, and 91k never-indexed notes piled up on local disk.
//
// Revision History: 1.0.0 | 2026-09-25 | Initial version (spark2 RAG via spark).
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PYTHON = "/opt/hermes/venvs/rag/bin/python3";
const SEARCH_SCRIPT = path.join(REPO_ROOT, "tools", "hermes-rag-search-minecraft.py");
const INGEST_SCRIPT = path.join(REPO_ROOT, "tools", "hermes-rag-ingest-minecraft.py");
export const MEMORY_DIR = process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory";
const RAG_URL = process.env.MC_RAG_URL || "";
const RAG_TOKEN = process.env.MEMORY_TOKEN || "";
const SEARCH_TIMEOUT_MS = 30_000;
const INGEST_TIMEOUT_MS = 180_000;
const REMOTE_TIMEOUT_MS = 35_000;

export const isRemote = () => !!RAG_URL;

async function remote(op, body) {
  const res = await fetch(`${RAG_URL}/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RAG_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`minecraft-rag ${op} failed: ${res.status} ${data.error ?? ""}`);
  return data;
}

// Search one corpus ("minecraft" or "minecraft-skills"); results are [{ text, source_path, distance }].
export async function ragSearch(query, { corpus = "minecraft", topK = 3 } = {}) {
  if (RAG_URL) return (await remote("search", { query, corpus, top_k: topK })).results ?? [];
  const { stdout } = await execFileAsync(PYTHON, [SEARCH_SCRIPT, query, "--top-k", String(topK), "--corpus", corpus],
    { timeout: SEARCH_TIMEOUT_MS });
  const results = JSON.parse(stdout);
  return Array.isArray(results) ? results : [];
}

// Re-index one corpus. Local runs are coalesced per corpus: a burst of writes runs at most one
// ingest at a time plus one follow-up. (The remote server coalesces on its side.)
const ingestState = new Map(); // corpus -> { running: Promise|null, again: boolean }
export function ragIngest(corpus = "minecraft") {
  if (RAG_URL) return remote("ingest", { corpus });
  const state = ingestState.get(corpus) ?? { running: null, again: false };
  ingestState.set(corpus, state);
  if (state.running) {
    state.again = true;
    return state.running;
  }
  state.running = (async () => {
    try {
      do {
        state.again = false;
        await execFileAsync(PYTHON, [INGEST_SCRIPT, "--corpus", corpus], { timeout: INGEST_TIMEOUT_MS });
      } while (state.again);
    } finally {
      state.running = null;
    }
  })();
  return state.running;
}

// Files are addressed relative to MEMORY_DIR, e.g. "world/123-note.md", "skills/x.json".
export async function memRead(relPath) {
  if (RAG_URL) return (await remote("read", { path: relPath })).content;
  return readFile(path.join(MEMORY_DIR, relPath), "utf8");
}

export async function memWrite(relPath, content) {
  if (RAG_URL) return remote("write", { path: relPath, content });
  const full = path.join(MEMORY_DIR, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  return writeFile(full, content, "utf8");
}
