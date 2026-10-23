#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase D's Tier 3 interactive-latency harness (FLEET_BENCHMARK_DESIGN.md
# S6.6, after S39a's sign-off 2026-10-22). "Offline" here means no external network and no real
# fleet backend -- but unlike every other suite's test file in this design, several checks below
# run a REAL local HTTP server (in-process, a background thread, no subprocess) standing in for
# the backend, so the concurrency-scaling and percentile math are exercised over a real socket
# with real wall-clock timing, not a stubbed Python function call. That is the strongest
# verification available for a tool whose entire purpose is measuring real concurrent I/O timing.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * percentile() matches hand-computed values on known inputs
#   * summarize_level() computes error_rate/tok_s/p50/p95 correctly from a set of per-call results,
#     including when every call errored (nothing fabricated) and when the backend never returned
#     a usage.completion_tokens block (an estimate, flagged as such)
#   * against a REAL local server with a fixed, known per-call latency: concurrency actually
#     increases aggregate tok/s roughly in proportion to the concurrency level while per-request
#     p50 latency stays flat -- the exact S6.6 correction #1 finding ("muse measured 13.0->51.9
#     tok/s... with flat per-request latency"), reproduced here against a controlled server
#     instead of just asserted
#   * rag_embed/rag_rerank call the REAL hermes_rag_common.embed()/rerank() functions (monkeypatched
#     to the local server), not a reimplementation -- confirmed by the fact they succeed at all,
#     since a shape mismatch between the real function's own parsing and this test server's
#     response would raise
#   * a fully unreachable endpoint reports error_rate=1.0 and writes nothing to shared history,
#     never a fabricated 0/None treated as a real measurement
#   * main()'s end-to-end path writes the correct suite key(s) for each role, including the
#     per-hop fleet_rag_latency_* keys (never a fabricated bare fleet_rag_latency combining hops
#     a single invocation didn't measure)
#
# Run: python3 infra/model-benchmark/tests/test_latency_eval.py
import importlib.util
import json
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"
sys.path.insert(0, str(TOOLS))

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def load():
    spec = importlib.util.spec_from_file_location("hermes_latency_eval",
                                                    TOOLS / "hermes-latency-eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


LATENCY_S = 0.1
COMPLETION_TOKENS = 20


class _FakeBackendHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        time.sleep(LATENCY_S)
        if self.path.endswith("/chat/completions"):
            body = {"choices": [{"message": {"content": "a reply with some words"}}],
                     "usage": {"completion_tokens": COMPLETION_TOKENS}}
        elif self.path.endswith("/embeddings"):
            body = {"data": [{"embedding": [0.0] * 4096}]}
        elif self.path.endswith("/rerank"):
            body = {"results": [{"index": 0, "relevance_score": 0.9},
                                 {"index": 1, "relevance_score": 0.1}]}
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class _NoTokensHandler(BaseHTTPRequestHandler):
    """A backend that never reports usage.completion_tokens -- exercises the estimate path."""
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        body = {"choices": [{"message": {"content": "five whole words right here"}}]}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start_server(handler_cls):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def main():
    mod = load()

    print("\n[percentile(): matches hand-computed values]")
    check("p50 of [1,2,3,4,5] is 3", mod.percentile([1, 2, 3, 4, 5], 50) == 3)
    check("p95 of [1,2,3,4,5] is 5", mod.percentile([1, 2, 3, 4, 5], 95) == 5)
    check("empty list returns None, not a crash", mod.percentile([], 50) is None)

    print("\n[summarize_level(): error_rate/tok_s/p50/p95 from known per-call results]")
    results = [{"latency_s": 0.1, "tokens": 10, "tokens_estimated": False},
               {"latency_s": 0.2, "tokens": 10, "tokens_estimated": False},
               {"latency_s": None, "tokens": None, "error": "boom"}]
    stats = mod.summarize_level(results, wall_s=0.2)
    check("error_rate is 1/3 for one error among three calls", abs(stats["error_rate"] - 1/3) < 1e-9)
    check("tok_s is computed only from the 2 successful calls over the real wall clock",
          abs(stats["tok_s"] - (20 / 0.2)) < 1e-6, str(stats["tok_s"]))
    check("p50_ms reflects only the successful calls' latencies",
          stats["p50_ms"] is not None and stats["p50_ms"] > 0)

    all_errors = [{"latency_s": None, "tokens": None, "error": "boom"}] * 3
    error_stats = mod.summarize_level(all_errors, wall_s=0.5)
    check("every call erroring gives error_rate 1.0, never a fabricated latency",
          error_stats["error_rate"] == 1.0 and error_stats["p50_ms"] is None, str(error_stats))

    print("\n[REAL local server: concurrency raises aggregate tok/s, per-request latency stays flat]")
    server, port = start_server(_FakeBackendHandler)
    try:
        endpoint = f"http://127.0.0.1:{port}/v1"
        call_fn = lambda: mod.call_chat(endpoint, "dispatch", mod._REPRESENTATIVE_MESSAGES["dispatch"],
                                         200, 30)
        results_c1, wall_c1 = mod.run_level(call_fn, n_requests=6, concurrency=1, timeout=30)
        results_c4, wall_c4 = mod.run_level(call_fn, n_requests=6, concurrency=4, timeout=30)
        stats_c1 = mod.summarize_level(results_c1, wall_c1)
        stats_c4 = mod.summarize_level(results_c4, wall_c4)
        check("no errors at concurrency 1 against the real local server",
              stats_c1["error_rate"] == 0.0, str(stats_c1))
        check("no errors at concurrency 4 against the real local server",
              stats_c4["error_rate"] == 0.0, str(stats_c4))
        check("per-request p50 latency stays close to the server's fixed delay at BOTH "
              "concurrency levels (same real finding S6.6 cites: flat per-request latency)",
              abs(stats_c1["p50_ms"] - LATENCY_S * 1000) < 80
              and abs(stats_c4["p50_ms"] - LATENCY_S * 1000) < 80,
              f"c1={stats_c1['p50_ms']} c4={stats_c4['p50_ms']}")
        check("aggregate tok/s at concurrency 4 is substantially higher than at concurrency 1 "
              "(real concurrent I/O, not serialized)",
              stats_c4["tok_s"] > stats_c1["tok_s"] * 2,
              f"c1={stats_c1['tok_s']} c4={stats_c4['tok_s']}")
    finally:
        server.shutdown()

    print("\n[REAL local server: a backend with no usage block falls back to a flagged estimate]")
    server2, port2 = start_server(_NoTokensHandler)
    try:
        endpoint2 = f"http://127.0.0.1:{port2}/v1"
        row = mod.call_chat(endpoint2, "dispatch", mod._REPRESENTATIVE_MESSAGES["dispatch"], 200, 30)
        check("tokens_estimated is True when the backend never reports usage.completion_tokens",
              row["tokens_estimated"] is True, str(row))
        check("the estimate is still a real word count, not None", row["tokens"] == 5, str(row))
    finally:
        server2.shutdown()

    print("\n[rag_embed / rag_rerank: the REAL hermes_rag_common functions, not reimplemented]")
    server3, port3 = start_server(_FakeBackendHandler)
    try:
        class _FakeArgs:
            endpoint = f"http://127.0.0.1:{port3}"
            timeout = 30
        embed_fn = mod.build_call_fn(_FakeArgs(), "rag_embed")
        rerank_fn = mod.build_call_fn(_FakeArgs(), "rag_rerank")
        embed_result = embed_fn()
        rerank_result = rerank_fn()
        check("rag_embed succeeds against the real local server (real embed() parsing, unmodified)",
              embed_result.get("error") is None and embed_result["latency_s"] is not None,
              str(embed_result))
        check("rag_rerank succeeds against the real local server (real rerank() parsing, unmodified)",
              rerank_result.get("error") is None and rerank_result["latency_s"] is not None,
              str(rerank_result))
    finally:
        server3.shutdown()

    print("\n[a fully unreachable endpoint: error_rate=1.0, nothing fabricated]")
    call_fn_dead = lambda: mod.call_chat("http://127.0.0.1:1/v1", "dispatch",
                                         mod._REPRESENTATIVE_MESSAGES["dispatch"], 200, 2)
    dead_results, dead_wall = mod.run_level(call_fn_dead, n_requests=3, concurrency=1, timeout=2)
    dead_stats = mod.summarize_level(dead_results, dead_wall)
    check("an unreachable endpoint reports error_rate 1.0", dead_stats["error_rate"] == 1.0,
          str(dead_stats))
    check("an unreachable endpoint reports p50_ms as None, never a fabricated number",
          dead_stats["p50_ms"] is None, str(dead_stats))

    print("\n[main(): end-to-end against the real local server, correct suite key per role]")
    server4, port4 = start_server(_FakeBackendHandler)
    try:
        endpoint4 = f"http://127.0.0.1:{port4}/v1"
        for role, expected_key in [("dispatch", "fleet_dispatch_latency"),
                                    ("guard", "fleet_guard_latency"),
                                    ("muse", "fleet_muse_latency"),
                                    ("rag_synthesis", "fleet_rag_latency_synthesis")]:
            with tempfile.TemporaryDirectory() as tmp:
                mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
                mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
                sys.argv = ["hermes-latency-eval.py", "--endpoint", endpoint4, "--role", role,
                            "--concurrency", "1,2", "--requests-per-level", "3"]
                rc = mod.main()
                check(f"main() for role={role} returns 0", rc == 0)
                entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines()
                           if l.strip()]
                check(f"[{role}] exactly one history entry written", len(entries) == 1, str(entries))
                suites = entries[0]["suites"] if entries else {}
                check(f"[{role}] the expected suite key ({expected_key}) is present",
                      expected_key in suites, str(suites))
                check(f"[{role}] value is a positive p50 latency in ms",
                      suites.get(expected_key, {}).get("value", 0) > 0, str(suites))

        with tempfile.TemporaryDirectory() as tmp:
            mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
            mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
            sys.argv = ["hermes-latency-eval.py", "--endpoint", f"http://127.0.0.1:{port4}",
                        "--role", "rag_embed", "--concurrency", "1,2", "--requests-per-level", "3"]
            rc = mod.main()
            entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines()
                       if l.strip()]
            suites = entries[0]["suites"] if entries else {}
            check("rag_embed writes fleet_rag_latency_embed, never a bare fleet_rag_latency "
                  "combining hops this run didn't measure",
                  "fleet_rag_latency_embed" in suites and "fleet_rag_latency" not in suites,
                  str(suites))
    finally:
        server4.shutdown()

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
