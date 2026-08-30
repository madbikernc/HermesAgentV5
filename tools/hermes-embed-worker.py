#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-embed-worker — HomeD13's side of Phase 30c's bulk-embedding path
(IMPLEMENTATION_PLAN.md §7, Phase 30). Sibling to hermes-render-worker.py,
same pull model (THE WORKER PULLS — no inbound port, a down node just queues
work), but a different shape of job: payload is a batch of text chunks
(one broker job per podcast episode, not per chunk — cuts job count by
~30-40x against per-chunk granularity), result is a JSON array of embedding
vectors, not a file produced by an external script.

Calls the resident embedding backend on *this* host
(infra/hermes-rag/start-embed-homed13.sh, 127.0.0.1:8092) via
hermes_rag_common.embed() — the same function the Spark's query-time path
and the fleet-docs ingestion tool use, just pointed at a different host's
local backend by virtue of always meaning "the embedding server on
whichever machine this process is running on." Deliberately does not import
sqlite_vec (hermes_rag_common.connect() is never called here) so this
worker needs no venv on HomeD13 — plain system python3 is enough.

Config, all from the environment (injected by hermes-embed-worker-wrapper.sh):
  BROKER_URL       default http://10.129.1.15:8100
  BROKER_TOKEN     required
  WORKER_NAME      default homed13
  JOB_TYPE         default embed
  POLL_SECONDS     default 10
  JOB_TIMEOUT      default 300   — one episode's worth of chunks, not one chunk
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hermes_rag_common as rag  # noqa: E402

BROKER_URL = os.environ.get("BROKER_URL", "http://10.129.1.15:8100").rstrip("/")
TOKEN = os.environ.get("BROKER_TOKEN", "")
WORKER = os.environ.get("WORKER_NAME", "homed13")
JOB_TYPE = os.environ.get("JOB_TYPE", "embed")
POLL = int(os.environ.get("POLL_SECONDS", "10"))
JOB_TIMEOUT = int(os.environ.get("JOB_TIMEOUT", "300"))


def log(msg):
    print(f"[embed-worker] {msg}", flush=True)


def request(method, path, data=None, headers=None):
    req = urllib.request.Request(
        f"{BROKER_URL}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", **(headers or {})})
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def claim():
    try:
        return request("GET", f"/jobs/claim?type={JOB_TYPE}&worker={urllib.parse.quote(WORKER)}"
                       ).get("job")
    except urllib.error.URLError as exc:
        log(f"broker unreachable ({exc}) — retrying in {POLL}s")
        return None
    except Exception as exc:
        log(f"claim failed: {exc}")
        return None


def run_job(job):
    chunks = job.get("payload", {}).get("chunks", [])
    if not chunks:
        return 2, None, "payload has no chunks"

    start = time.monotonic()
    embeddings = []
    for i, chunk in enumerate(chunks):
        text = chunk.get("text", "")
        if not text:
            return 2, None, f"chunk {i} has no text"
        if time.monotonic() - start > JOB_TIMEOUT:
            return 124, None, f"embedding {len(chunks)} chunks exceeded {JOB_TIMEOUT}s at chunk {i}"
        try:
            embeddings.append(rag.embed(text))
        except RuntimeError as exc:
            return 1, None, f"chunk {i}: {exc}"

    return 0, json.dumps({"embeddings": embeddings}).encode("utf-8"), ""


def report(job_id, exit_code, blob, error, caption):
    import hashlib

    sha = hashlib.sha256(blob).hexdigest() if blob else ""
    headers = {
        "Content-Type": "application/octet-stream",
        "X-Exit-Code": str(exit_code),
        "X-Sha256": sha,
        "X-Filename": "embeddings.json" if blob else "",
        "X-Error": (error or "").replace("\n", " ")[:900].encode("ascii", "replace").decode("ascii"),
        "X-Caption": (caption or "").replace("\n", " ")[:400].encode("ascii", "replace").decode("ascii"),
    }
    result = request("POST", f"/jobs/{job_id}/result", data=blob or b"", headers=headers)
    log(f"job {job_id}: reported exit={exit_code} sha={sha[:12] or 'none'} -> {result.get('state')}")


def main():
    if not TOKEN:
        sys.exit("BROKER_TOKEN is required")
    log(f"polling {BROKER_URL} every {POLL}s as '{WORKER}' for type='{JOB_TYPE}' jobs")
    while True:
        job = claim()
        if not job:
            time.sleep(POLL)
            continue
        n = len(job.get("payload", {}).get("chunks", []))
        caption = job.get("payload", {}).get("source", "")
        log(f"job {job['id']}: embedding {n} chunk(s) (attempt {job.get('attempt')}) — {caption}")
        try:
            exit_code, blob, error = run_job(job)
            report(job["id"], exit_code, blob, error, caption)
        except Exception as exc:
            log(f"job {job['id']}: worker error: {exc}")
            try:
                report(job["id"], 1, None, f"worker exception: {exc}", "")
            except Exception as inner:
                log(f"job {job['id']}: could not report failure either: {inner}")


if __name__ == "__main__":
    main()
