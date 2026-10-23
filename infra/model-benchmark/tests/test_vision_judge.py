#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39's fleet_vision_judge suite (FLEET_BENCHMARK_DESIGN.md S6.2, closes
# gap 2), unblocked 2026-10-23 by a real NFS archive of hermes-media.py output. No external
# network: every check below either loads the real fixture images/labels already tracked in
# this repo, or runs a REAL local HTTP server (an in-process background thread, no subprocess)
# standing in for omni's backend, confirming the real evaluate_image() function (imported
# unmodified from hermes-media.py) genuinely sends the real image_url/data-URI request shape
# and genuinely reads the monkeypatched ROUTER_URL at call time, not import time.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * all 4 real fixture images and their labels load, with a real PNG each (checked via file
#     signature, not just that the path exists)
#   * load_media_module() loads the real hermes-media.py safely, with the real
#     EVAL_SYSTEM_PROMPT/evaluate_image() intact
#   * monkeypatching media.ROUTER_URL actually redirects evaluate_image()'s real HTTP call --
#     proven by a real local server that returns a distinct, clearly-wrong response when it does
#     NOT see the real image_url/data-URI shape in the request, so a pass here means the real
#     function's own request construction ran for real, not a stub
#   * main()'s end-to-end path: a model that is always lenient (always PASS) gets dinged on
#     precision and false_pass_rate specifically (the "ships broken output" error) while recall
#     stays perfect; a model that correctly catches the one real defect scores 1.0 on every axis;
#     no bare fleet_vision_judge key is ever written (S6.2's own "two numbers, never blended"
#     rule); an unreachable endpoint scores nothing, never fabricates a number
#
# Run: python3 infra/model-benchmark/tests/test_vision_judge.py
import importlib.util
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"
FIXTURES = REPO / "infra" / "fleet-vision-judge" / "fixtures"
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
    spec = importlib.util.spec_from_file_location("hermes_vision_judge_eval",
                                                    TOOLS / "hermes-vision-judge-eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _LenientHandler(BaseHTTPRequestHandler):
    """Always PASS, regardless of what it's shown."""
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        body = json.loads(raw)
        content = body["messages"][1]["content"]
        has_image = any(c.get("type") == "image_url" for c in content)
        has_data_uri = has_image and content[1]["image_url"]["url"].startswith("data:image/")
        verdict = "PASS looks fine." if has_image and has_data_uri else "FAIL malformed request."
        resp = {"choices": [{"message": {"content": verdict}}]}
        data = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class _SmartHandler(BaseHTTPRequestHandler):
    """Correctly catches the one real defect (missing 'cybernetically enhanced' sharks) via the
    real prompt text, PASS otherwise."""
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        body = json.loads(raw)
        text_part = next(c["text"] for c in body["messages"][1]["content"] if c.get("type") == "text")
        if "cybernetically enhanced sharks" in text_part:
            verdict = "FAIL the sharks show no cybernetic enhancement at all."
        else:
            verdict = "PASS matches the prompt."
        resp = {"choices": [{"message": {"content": verdict}}]}
        data = json.dumps(resp).encode()
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

    print("\n[fixtures: all 4 real images and labels load]")
    fixtures = mod.load_fixtures()
    check("4 fixtures total", len(fixtures) == 4, str(len(fixtures)))
    check("3 labelled pass, 1 labelled fail (honest 3:1 split, not forced 50/50)",
          sum(1 for v in fixtures.values() if v["label"] == "pass") == 3
          and sum(1 for v in fixtures.values() if v["label"] == "fail") == 1)
    for filename, info in fixtures.items():
        path = FIXTURES / filename
        check(f"[{filename}] file exists and is a real PNG",
              path.exists() and path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n")
        check(f"[{filename}] has a non-empty real prompt and a valid label",
              bool(info.get("prompt")) and info.get("label") in ("pass", "fail"))

    print("\n[load_media_module(): the real hermes-media.py, real EVAL_SYSTEM_PROMPT intact]")
    media = mod.load_media_module()
    check("EVAL_SYSTEM_PROMPT loaded from the real module",
          "PASS" in media.EVAL_SYSTEM_PROMPT and "FAIL" in media.EVAL_SYSTEM_PROMPT)
    check("evaluate_image is the real callable", callable(media.evaluate_image))

    print("\n[monkeypatching media.ROUTER_URL actually redirects the real evaluate_image() call]")
    server, port = start_server(_LenientHandler)
    try:
        media.ROUTER_URL = f"http://127.0.0.1:{port}"
        image_bytes = (FIXTURES / "hermes_gen_00001_.png").read_bytes()
        passed, reason = media.evaluate_image(image_bytes, "image/png", "a red bicycle")
        check("the real evaluate_image() reached the real local server and got a real verdict back",
              passed is True, f"passed={passed} reason={reason!r}")
    finally:
        server.shutdown()

    print("\n[main(): a lenient model (always PASS) is dinged on precision/false_pass_rate, "
          "recall stays perfect]")
    server2, port2 = start_server(_LenientHandler)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
            mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
            sys.argv = ["hermes-vision-judge-eval.py", "--endpoint", f"http://127.0.0.1:{port2}",
                        "--model-id", "test-omni-lenient"]
            rc = mod.main()
            check("main() returns 0", rc == 0)
            entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines()
                       if l.strip()]
            check("exactly one history entry written", len(entries) == 1, str(entries))
            suites = entries[0]["suites"]
            check("recall is 1.0 (every real-pass image was correctly passed)",
                  suites.get("fleet_vision_judge_recall", {}).get("value") == 1.0, str(suites))
            check("precision is below 1.0 (the one real defect was wrongly passed too)",
                  suites.get("fleet_vision_judge_precision", {}).get("value") < 1.0, str(suites))
            check("false_pass_rate is 1.0 -- the one real defect slipped through completely",
                  suites.get("fleet_vision_judge_false_pass_rate", {}).get("value") == 1.0,
                  str(suites))
            check("no bare fleet_vision_judge key -- S6.2's own 'two numbers, never blended' rule",
                  "fleet_vision_judge" not in suites, str(suites))
    finally:
        server2.shutdown()

    print("\n[main(): a model that correctly catches the one real defect scores 1.0 on every axis]")
    server3, port3 = start_server(_SmartHandler)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
            mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
            sys.argv = ["hermes-vision-judge-eval.py", "--endpoint", f"http://127.0.0.1:{port3}"]
            rc = mod.main()
            entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines()
                       if l.strip()]
            suites = entries[0]["suites"]
            check("precision is 1.0", suites.get("fleet_vision_judge_precision", {}).get("value") == 1.0,
                  str(suites))
            check("recall is 1.0", suites.get("fleet_vision_judge_recall", {}).get("value") == 1.0,
                  str(suites))
            check("false_pass_rate is 0.0 -- the one real defect was correctly caught",
                  suites.get("fleet_vision_judge_false_pass_rate", {}).get("value") == 0.0,
                  str(suites))
            check("false_fail_rate is 0.0 -- no good image was wrongly rejected",
                  suites.get("fleet_vision_judge_false_fail_rate", {}).get("value") == 0.0,
                  str(suites))
    finally:
        server3.shutdown()

    print("\n[main(): a fully unreachable endpoint writes nothing, never fabricates a number]")
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-vision-judge-eval.py", "--endpoint", "http://127.0.0.1:1"]
        rc = mod.main()
        check("main() still returns 0 when every call fails", rc == 0)
        check("no history file is written when nothing was scored",
              not mod.bc.LOCAL_HISTORY_PATH.exists())

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
