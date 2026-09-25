#!/usr/bin/env python3
# Version: 1.0.0
#
# Minecraft RAG server -- lets bots on hosts other than spark use the fleet's one shared RAG store.
#
# The index (/mnt/hermes-data/rag/vectors.db), the embedding server (127.0.0.1:8092) and the shared
# Minecraft memory directory all live on spark. Bots on spark reach them directly
# (services/minecraft-bots/rag-backend.js, local mode). Bots on spark2 had nothing: every search
# failed on a missing venv, their duplicate checks never matched, and ~91k never-indexed world notes
# piled up on spark2's own disk. This server gives them the same four operations over HTTP (the
# bots set MC_RAG_URL):
#
#   POST /search  {query, corpus, top_k}  -> {results: [{text, source_path, distance}, ...]}
#   POST /ingest  {corpus}                -> {queued: true}   (coalesced per corpus, in background)
#   POST /read    {path}                  -> {content}
#   POST /write   {path, content}         -> {ok: true}
#
# Search and ingest run the exact scripts local bots run (hermes-rag-{search,ingest}-minecraft.py),
# as argument lists -- never through a shell. Paths are relative to the memory directory and must
# stay inside world/, bots/<name>/ or skills/, ending in .md or .json. Requests need
# "Authorization: Bearer <memory-token>" -- the same Vaultwarden item every bot already loads.
# Binds to spark's LAN address only.
#
# Config (environment): MC_RAG_BIND (default 10.129.1.15), MC_RAG_PORT (8105),
#   MC_MEMORY_ROOT (/mnt/hermes-data/minecraft-memory), MC_RAG_PYTHON (the RAG venv's python3).
# Usage: run under systemd, see infra/minecraft-rag-server/.
#
# Revision History: 1.0.0 | 2026-09-25 | Initial version (spark2 RAG lookup).
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "tools"
BIND = os.environ.get("MC_RAG_BIND", "10.129.1.15")
PORT = int(os.environ.get("MC_RAG_PORT", "8105"))
MEMORY_ROOT = Path(os.environ.get("MC_MEMORY_ROOT", "/mnt/hermes-data/minecraft-memory")).resolve()
PYTHON = os.environ.get("MC_RAG_PYTHON", "/opt/hermes/venvs/rag/bin/python3")
SEARCH_SCRIPT = str(TOOLS / "hermes-rag-search-minecraft.py")
INGEST_SCRIPT = str(TOOLS / "hermes-rag-ingest-minecraft.py")
CORPORA = {"minecraft", "minecraft-skills"}
MAX_BODY = 256 * 1024
MAX_CONTENT = 64 * 1024
SEARCH_TIMEOUT_S = 30
INGEST_TIMEOUT_S = 600
ALLOWED_PATH = re.compile(r"^(world/[\w.-]+|bots/[a-z0-9_-]+/[\w.-]+|skills/[\w.-]+)\.(md|json)$")


def log(msg):
    print(f"[minecraft-rag] {msg}", flush=True)


def load_token():
    token = os.environ.get("MC_RAG_TOKEN")
    if token:
        return token
    try:
        out = subprocess.run([str(TOOLS / "vault-get-secret.sh"), "memory-token", "password"],
                             capture_output=True, text=True, timeout=60, check=True)
        return out.stdout.strip()
    except (subprocess.SubprocessError, OSError) as exc:
        sys.exit(f"cannot load memory-token: {exc}")


TOKEN = None


def resolve(rel):
    """A request path, validated and resolved inside MEMORY_ROOT -- or None."""
    if not isinstance(rel, str) or not ALLOWED_PATH.match(rel) or ".." in rel:
        return None
    full = (MEMORY_ROOT / rel).resolve()
    return full if MEMORY_ROOT in full.parents else None


class Ingester:
    """One background ingest per corpus at a time, plus at most one follow-up for writes that
    arrived while it ran -- the same coalescing rag-backend.js does locally."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state = {c: {"running": False, "again": False} for c in CORPORA}

    def request(self, corpus):
        with self.lock:
            st = self.state[corpus]
            if st["running"]:
                st["again"] = True
                return
            st["running"] = True
        threading.Thread(target=self._run, args=(corpus,), daemon=True).start()

    def _run(self, corpus):
        while True:
            with self.lock:
                self.state[corpus]["again"] = False
            try:
                subprocess.run([PYTHON, INGEST_SCRIPT, "--corpus", corpus], capture_output=True,
                               timeout=INGEST_TIMEOUT_S, check=False)
            except subprocess.SubprocessError as exc:
                log(f"ingest {corpus} failed: {exc}")
            with self.lock:
                if not self.state[corpus]["again"]:
                    self.state[corpus]["running"] = False
                    return


INGESTER = Ingester()


def op_search(body):
    corpus = body.get("corpus", "minecraft")
    query = body.get("query")
    top_k = int(body.get("top_k", 3))
    if corpus not in CORPORA or not isinstance(query, str) or not query.strip() or not 1 <= top_k <= 10:
        return 400, {"error": "bad search request"}
    out = subprocess.run([PYTHON, SEARCH_SCRIPT, query[:2000], "--top-k", str(top_k), "--corpus", corpus],
                         capture_output=True, text=True, timeout=SEARCH_TIMEOUT_S)
    if out.returncode != 0:
        return 502, {"error": f"search failed: {out.stderr.strip()[-300:]}"}
    results = json.loads(out.stdout or "[]")
    return 200, {"results": results if isinstance(results, list) else []}


def op_ingest(body):
    corpus = body.get("corpus", "minecraft")
    if corpus not in CORPORA:
        return 400, {"error": "unknown corpus"}
    INGESTER.request(corpus)
    return 200, {"queued": True}


def op_read(body):
    full = resolve(body.get("path"))
    if not full:
        return 400, {"error": "path not allowed"}
    if not full.is_file():
        return 404, {"error": "not found"}
    return 200, {"content": full.read_text(encoding="utf-8")}


def op_write(body):
    full = resolve(body.get("path"))
    content = body.get("content")
    if not full:
        return 400, {"error": "path not allowed"}
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_CONTENT:
        return 400, {"error": "bad content"}
    full.parent.mkdir(parents=True, exist_ok=True)
    tmp = full.with_suffix(full.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(full)
    return 200, {"ok": True}


OPS = {"/search": op_search, "/ingest": op_ingest, "/read": op_read, "/write": op_write}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802 (http.server naming)
        op = OPS.get(self.path)
        if not op:
            return self._send(404, {"error": "unknown endpoint"})
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._send(413, {"error": "too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            status, obj = op(body if isinstance(body, dict) else {})
        except subprocess.TimeoutExpired:
            status, obj = 504, {"error": "timed out"}
        except (ValueError, OSError) as exc:
            status, obj = 400, {"error": str(exc)[:200]}
        self._send(status, obj)

    def log_message(self, fmt, *args):  # quiet: one line per non-200 only
        if args and str(args[1]) != "200":
            log(f"{self.address_string()} {fmt % args}")


def main():
    global TOKEN
    TOKEN = load_token()
    if not TOKEN:
        sys.exit("empty memory-token")
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    log(f"serving {sorted(OPS)} on {BIND}:{PORT}, memory root {MEMORY_ROOT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
