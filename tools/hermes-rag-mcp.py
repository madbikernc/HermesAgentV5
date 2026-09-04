#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-09-04) — direct request: "the mcp should have a 'rag reindex
# progress' as well." rag_reindex's original shape (this same version's
# 1.0.0, never released to a client before this fix) ran the ingest script
# synchronously and blocked the whole tool call until it finished or a
# 1-hour timeout -- fine for fleet-docs/ops (seconds), a real problem for
# podcasts, which took tens of minutes for a real backfill this same
# session, well past what most MCP clients let a single tool call block
# for. Rebuilt as fire-and-forget: rag_reindex launches the ingest script
# detached (start_new_session=True, redirected to a log file, a wrapping
# shell writes the real exit code to a sidecar file once it's done) and
# returns immediately; the new rag_reindex_progress tool reads that state
# back from disk. Deliberately NOT tracked in this process's own memory --
# an MCP server here is spawned fresh per client SSH session, so an
# in-memory job dict would be invisible the moment that session ends, or
# to a second session (this project's own portability requirement: check
# progress from a different client machine than the one that started the
# reindex, and it still has to work). Job state lives under
# ~/.hermes/state/rag-reindex/{corpus}.{json,log,exit} instead, one set
# per corpus -- keyed by corpus name rather than a job-id queue, since only
# one reindex per corpus is ever meaningful to track at a time.
# rag_reindex now refuses to start a second run for a corpus already in
# progress (checked via the launched process's own PID liveness) rather
# than launching a duplicate.
#
# 1.0.0 (2026-09-04) — direct request: expose this fleet's RAG index (all
# four corpora — podcasts, fleet-docs, personal-kb, ops) as an MCP server,
# portable across at least two client machines. Portability constraint
# solved the same way every other remote operation in this project already
# does it, rather than inventing something new: SSH stdio. Any client
# machine with an SSH key already configured for this host (this project's
# existing pattern — see ~/.ssh/config entries used all session) runs this
# exact command as its MCP server process; there is no new network-facing
# port, no new bearer token to provision or rotate, no separate auth story
# to build. The client-side config is just:
#
#   {"mcpServers": {"hermes-rag": {"command": "ssh",
#     "args": ["<host-alias>", "/opt/hermes/venvs/rag/bin/python3",
#               "/home/pmoney/HermesAgentV5/tools/hermes-rag-mcp.py"]}}}
#
# Read-only search (rag_search), corpus discovery (rag_list_corpora), and a
# controlled reindex trigger (rag_reindex) — the last one runs one of the
# four existing, already-audited hermes-rag-ingest-*.py scripts as a
# subprocess (the same ones the daily timers run), never a direct write to
# the vector store. There is deliberately no tool that inserts arbitrary
# chunks.
#
# Direct request, verbatim: "we should always do injection protection at
# every possible interaction." Every piece of text this server hands back
# to a caller — a retrieved chunk's body and citation, a reindex run's
# captured stdout/stderr — is screened before it leaves this process:
#   Layer 1 — hermes_injection_guard.py, the same deterministic pattern
#     scanner hermes-router.py's own proxy path already runs, scored with
#     role="tool" (RAG chunks and reindex output are exactly the
#     "adversarial content retrieved by an agent" case that module's own
#     docstring is written around — no legitimate reading for cmd/sql
#     injection or instruction-override syntax showing up inside indexed
#     document text, unlike a human typing it as a real question).
#   Layer 2 (search results only) — hermes-guard's resident Prompt Guard 2
#     classifier (10.129.1.15:8096/classify, confirmed live reachable from
#     this host and NOT on 127.0.0.1 — it binds the LAN IP explicitly, same
#     as the broker), the identical model hermes-router.py's own Layer 2
#     calls. Skipped for reindex output (a status report of filenames/
#     counts, not indexed document content) and for citations (Layer 1
#     alone; a second network round-trip per citation wasn't worth it) —
#     always run for a search result's actual chunk text.
# A hit on either layer redacts that one result (citation and block reason
# still reported, so an operator can go look) rather than failing the
# whole call. Layer 2 fails OPEN on its own unreachability (same shape
# hermes_rag_common.search()'s rerank() degradation already uses — a
# classifier hiccup must not take down every search), but that's not
# silent: rag_search's response carries an explicit layer2_available flag
# so a caller can tell when a result was only ever screened by Layer 1.
"""
hermes-rag-mcp.py — MCP server exposing this fleet's RAG index over stdio.
See the version header above for the full design rationale (portability,
tool scope, and the injection-screening contract every returned string
goes through).

Usage (run directly, e.g. for local testing):
    /opt/hermes/venvs/rag/bin/python3 hermes-rag-mcp.py

Usage (the real path — from any client machine with SSH access to this
host already configured, as an MCP client's server command):
    ssh <host-alias> /opt/hermes/venvs/rag/bin/python3 \\
        /home/pmoney/HermesAgentV5/tools/hermes-rag-mcp.py
"""
import datetime
import json
import os
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_injection_guard as guard1  # noqa: E402
import hermes_rag_common as rag  # noqa: E402

from mcp.server.mcpserver import MCPServer  # noqa: E402
from mcp.types import ToolAnnotations  # noqa: E402

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_SCRIPT = REPO_DIR / "tools" / "vault-get-secret.sh"

# Not 127.0.0.1 -- hermes-guard.service binds spark's LAN IP explicitly
# (confirmed live via `ss -tlnp`), same convention hermes-broker's own
# BROKER_URL already uses (10.129.1.15:8100).
GUARD_URL = os.environ.get("HERMES_GUARD_URL", "http://10.129.1.15:8096/classify")
GUARD_TIMEOUT = 10
GUARD_MALICIOUS_THRESHOLD = 0.5

CORPORA = {
    "podcasts": {
        "description": ("Security Now, Intelligent Machines, This Week in Tech, Tech Brew "
                         "Ride Home, and Dan Carlin's shows -- transcripts and story-link citations."),
        "script": "hermes-rag-ingest-podcasts.py",
    },
    "fleet-docs": {
        "description": ("This fleet's own docs: IMPLEMENTATION_PLAN.md, LESSONS_LEARNED.md, "
                         "README.md, CLAUDE.md, persona SOUL.md files, skills/*/SKILL.md, "
                         "infra/*/README.md."),
        "script": "hermes-rag-ingest-docs.py",
    },
    "personal-kb": {
        "description": ("Personal notes/reference material under RAGDocs -- markdown, text, "
                         "PDF, DOCX, EPUB."),
        "script": "hermes-rag-ingest-kb.py",
    },
    "ops": {
        "description": "Fleet node-health / operations records.",
        "script": "hermes-rag-ingest-ops.py",
    },
}

# ---- Reindex job tracking ---------------------------------------------
# Plain per-corpus files under ~/.hermes/state/, matching this project's own
# established convention for small operational state (hermes-podcast-sync.py's
# missing-since.json, hermes_injection_guard.py's own DB under the same
# parent) rather than a new table in the shared vectors.db -- job tracking
# isn't RAG content, a distinct concern from what that database holds.
#
# One state/log/exit file set per corpus (not a job-id queue): only one
# reindex per corpus is ever meaningful to track at a time, and keeping it
# keyed by corpus name is what makes rag_reindex_progress's corpus=None
# "report on all four" shape trivial.
#
# The exit file is the definitive "finished" signal, written by a wrapping
# shell command AFTER the real ingest script exits -- not read from a
# Popen object's own .poll()/.wait(), which only works from the same
# process that spawned it. rag_reindex_progress can run in a completely
# different MCP server process (a fresh SSH session, even from a different
# client machine) than the one that started the job, so the launched
# process must be independently checkable from disk alone. start_new_session
# =True (setsid) on the launch is what makes the job survive this server
# process exiting when that SSH session ends -- without it, the child would
# get SIGHUP the moment the parent's session leader goes away.
STATE_DIR = Path.home() / ".hermes" / "state" / "rag-reindex"
REINDEX_LOG_TAIL_CHARS = 4000


def _reindex_paths(corpus: str) -> dict[str, Path]:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    return {
        "state": STATE_DIR / f"{corpus}.json",
        "log": STATE_DIR / f"{corpus}.log",
        "exit": STATE_DIR / f"{corpus}.exit",
    }


def _read_reindex_state(corpus: str) -> dict | None:
    path = _reindex_paths(corpus)["state"]
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists, just not signalable -- shouldn't happen for our own child,
        # but "exists" is the honest answer if it ever does.
        return True


# ---- Injection screening ---------------------------------------------------

_guard_token = None


def _guard_token_cached() -> str:
    """Fetched once per server process, not per call -- this process is
    spawned fresh per MCP client session (SSH stdio), so there's no
    long-lived-daemon staleness concern the way a resident service would
    have. Raises on failure; _layer2_classify() below is what decides
    whether that's fatal to the call."""
    global _guard_token
    if _guard_token is None:
        out = subprocess.run(
            [str(VAULT_SCRIPT), "guard-token", "password"],
            capture_output=True, text=True, timeout=60,
        )
        if out.returncode != 0 or not out.stdout.strip():
            raise RuntimeError(f"could not fetch guard-token from vault: {out.stderr.strip()}")
        _guard_token = out.stdout.strip()
    return _guard_token


def _layer2_classify(text: str) -> tuple[str, float] | None:
    """Returns (label, score) from hermes-guard's Prompt Guard 2 classifier,
    or None if the guard service itself couldn't be reached/authenticated --
    fails open on infrastructure failure, same shape
    hermes_rag_common.search()'s own rerank() degradation already uses.
    Never treats "couldn't reach the classifier" as "content is
    malicious" -- that would make a guard outage a denial-of-service on
    every search."""
    try:
        token = _guard_token_cached()
        payload = json.dumps({"text": text[:4000]}).encode("utf-8")
        req = urllib.request.Request(
            GUARD_URL, data=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=GUARD_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body["label"], float(body["score"])
    except (urllib.error.URLError, RuntimeError, KeyError, ValueError, TimeoutError) as e:
        print(f"WARNING: Layer 2 guard unreachable, this result screened by Layer 1 only: {e}",
              file=sys.stderr)
        return None


def _screen(text: str, use_layer2: bool = True) -> tuple[str | None, str | None, bool]:
    """Two-layer injection screen for one piece of outbound text. Returns
    (safe_text, block_reason, layer2_ran) -- safe_text is None (and
    block_reason set) if either layer blocked it; layer2_ran is False
    whenever use_layer2=False OR the guard service was unreachable, so
    callers can report real screening coverage instead of implying more
    happened than did."""
    if not text:
        return "", None, False

    hits = guard1.scan(text)
    sev = guard1.severity("tool", hits)
    if sev == "block":
        cats = ", ".join(sorted(hits.keys()))
        guard1.log_event("hermes-rag-mcp", "block",
                          [{"role": "tool", "hits": hits, "severity": "block"}])
        return None, f"Layer 1 pattern scan: {cats}", False

    layer2_ran = False
    if use_layer2:
        result = _layer2_classify(text)
        if result is not None:
            layer2_ran = True
            label, score = result
            if label == "MALICIOUS" and score >= GUARD_MALICIOUS_THRESHOLD:
                guard1.log_event(
                    "hermes-rag-mcp", "block",
                    [{"role": "tool", "hits": {"layer2_classifier": [f"{label} {score:.2f}"]},
                      "severity": "block"}],
                )
                return None, f"Layer 2 Prompt Guard 2: {label} ({score:.2f})", True

    return rag.sanitize_llm_input(text), None, layer2_ran


# ---- MCP server -------------------------------------------------------

mcp = MCPServer(
    name="hermes-rag",
    version="1.1.0",
    instructions=(
        "Search and reindex this fleet's RAG corpora (podcasts, fleet-docs, personal-kb, ops). "
        "Search is read-only. Reindex re-runs the existing, already-scheduled ingest pipeline "
        "for one corpus in the background and returns immediately -- it does not accept "
        "arbitrary writes to the index, and does not block waiting for the run to finish; call "
        "rag_reindex_progress to check on it. Every returned string is screened for "
        "prompt-injection content before it leaves this server; a blocked result is redacted "
        "(citation and reason kept, text withheld)."
    ),
)


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False))
def rag_search(query: str, corpus: str | None = None, top_k: int = 5) -> dict:
    """Search the RAG index (cosine similarity + cross-encoder rerank). `corpus`: one of
    podcasts/fleet-docs/personal-kb/ops, or omit to search across all of them. `top_k`: 1-20,
    default 5. Every result is screened for prompt-injection content (pattern scan, plus a real
    ML classifier for the chunk text itself) before being returned; a blocked result has its
    text withheld but its citation and block reason are still reported so an operator can
    follow up."""
    if corpus is not None and corpus not in CORPORA:
        raise ValueError(f"unknown corpus {corpus!r} -- valid: {', '.join(CORPORA)}")
    if not 1 <= top_k <= 20:
        raise ValueError("top_k must be between 1 and 20")

    candidates = rag.search(query, corpus=corpus, top_k=top_k)

    results = []
    blocked_count = 0
    layer2_available = True
    for c in candidates:
        safe_citation, cit_reason, _ = _screen(c["citation"], use_layer2=False)
        safe_text, text_reason, layer2_ran = _screen(c["text"], use_layer2=True)
        if not layer2_ran:
            layer2_available = False

        if safe_citation is None or safe_text is None:
            blocked_count += 1
            results.append({
                "corpus": c["corpus"],
                "citation": c["citation"],  # kept even when blocked -- an operator needs to know what
                "blocked": True,
                "reason": text_reason or cit_reason,
            })
        else:
            results.append({
                "corpus": c["corpus"],
                "citation": safe_citation,
                "text": safe_text,
                "blocked": False,
            })

    return {
        "query": query,
        "results": results,
        "blocked_count": blocked_count,
        "layer2_available": layer2_available,
    }


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False))
def rag_list_corpora() -> dict:
    """List the RAG corpora available to rag_search/rag_reindex, with a one-line description
    of what each one covers."""
    return {name: info["description"] for name, info in CORPORA.items()}


@mcp.tool(annotations=ToolAnnotations(
    read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=False,
))
def rag_reindex(corpus: str, dry_run: bool = False) -> dict:
    """Start a catch-up reindex for one corpus in the background by running its existing ingest
    script -- the same script its own daily timer already runs, never a direct write to the
    vector store. `corpus`: one of podcasts/fleet-docs/personal-kb/ops. `dry_run`: report what
    would change without embedding anything.

    Returns immediately -- this does NOT wait for the run to finish. Podcasts especially can take
    tens of minutes for a large catch-up, well past what most MCP clients allow a single tool call
    to block for. Call rag_reindex_progress with the same corpus to check on it. Refuses to start
    a second run for a corpus that already has one in progress (returns status="already_running"
    instead) -- check progress rather than retrying. The launched process is fully detached (a new
    session, not a child of this server process), so it keeps running to completion even if this
    MCP session ends; a later call to rag_reindex_progress, from this session or a different one on
    a different client machine, can still see how it finished. destructive_hint is set because a
    reindex can prune chunks for a source file deleted since the last run, not because it can lose
    a document that's still there."""
    if corpus not in CORPORA:
        raise ValueError(f"unknown corpus {corpus!r} -- valid: {', '.join(CORPORA)}")

    paths = _reindex_paths(corpus)
    existing = _read_reindex_state(corpus)
    if existing and not paths["exit"].exists() and _pid_alive(existing.get("pid", -1)):
        return {
            "corpus": corpus,
            "status": "already_running",
            "started_at": existing.get("started_at"),
            "message": "a reindex for this corpus is already running -- call rag_reindex_progress "
                       "instead of starting another",
        }

    # A fresh run: clear the previous run's exit/log so progress-checking
    # can't mistake a stale prior completion for this new run's result.
    paths["exit"].unlink(missing_ok=True)
    paths["log"].unlink(missing_ok=True)

    script = REPO_DIR / "tools" / CORPORA[corpus]["script"]
    inner_args = [sys.executable, str(script)]
    if dry_run:
        inner_args.append("--dry-run")
    # Sequential in one shell: run the ingester, redirect its combined
    # output to the log file, THEN write its real exit code -- the exit
    # file only appears once the ingester has actually finished, which is
    # exactly the signal rag_reindex_progress relies on.
    inner_cmd = (
        f"{shlex.join(inner_args)} > {shlex.quote(str(paths['log']))} 2>&1; "
        f"echo $? > {shlex.quote(str(paths['exit']))}"
    )
    proc = subprocess.Popen(
        ["/bin/bash", "-c", inner_cmd],
        start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    paths["state"].write_text(json.dumps({
        "corpus": corpus, "dry_run": dry_run, "pid": proc.pid, "started_at": started_at,
    }))

    return {"corpus": corpus, "status": "started", "started_at": started_at, "pid": proc.pid}


def _one_corpus_progress(corpus: str) -> dict:
    paths = _reindex_paths(corpus)
    state = _read_reindex_state(corpus)
    if state is None:
        return {"corpus": corpus, "status": "never_run"}

    result = {
        "corpus": corpus,
        "dry_run": state.get("dry_run", False),
        "started_at": state.get("started_at"),
    }

    if paths["exit"].exists():
        try:
            exit_code = int(paths["exit"].read_text().strip())
        except (ValueError, OSError):
            exit_code = None
        result["status"] = "done" if exit_code == 0 else "failed"
        result["exit_code"] = exit_code
    elif _pid_alive(state.get("pid", -1)):
        result["status"] = "running"
    else:
        # The process is gone but never wrote a normal exit -- killed
        # outright (OOM, a manual kill, a host reboot mid-run), not a
        # state this tool can distinguish further from disk alone.
        result["status"] = "unknown"

    if paths["log"].exists():
        try:
            log_text = paths["log"].read_text(encoding="utf-8", errors="replace")
        except OSError:
            log_text = ""
        if log_text:
            tail = log_text[-REINDEX_LOG_TAIL_CHARS:]
            safe_tail, reason, _ = _screen(tail, use_layer2=False)
            result["output_tail"] = safe_tail if safe_tail is not None else f"[output withheld: {reason}]"

    return result


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False))
def rag_reindex_progress(corpus: str | None = None) -> dict:
    """Check on a reindex started by rag_reindex. `corpus`: one of podcasts/fleet-docs/
    personal-kb/ops, or omit to report on all four at once. `status` is one of: never_run (no
    reindex has ever been started for this corpus through this tool), running, done, failed (the
    script ran and exited non-zero), or unknown (the process is gone but never wrote a normal
    exit code -- killed outright, e.g. an OOM or a host reboot mid-run). Includes up to the last
    ~4000 characters of the run's captured output when available, screened the same as every
    other string this server returns."""
    if corpus is not None:
        if corpus not in CORPORA:
            raise ValueError(f"unknown corpus {corpus!r} -- valid: {', '.join(CORPORA)}")
        return _one_corpus_progress(corpus)
    return {name: _one_corpus_progress(name) for name in CORPORA}


if __name__ == "__main__":
    mcp.run()
