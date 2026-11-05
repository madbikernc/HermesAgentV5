#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for hermes-logs.py 1.7.0's ask_super() fallback: the router has no fallback of
# its own, so a log-analyst wake it can't complete (502/503) must be retried on `super` here.
# No network: hermes-logs' _post() is replaced with a fake router.
#
# What it covers:
#   * log-analyst answers -> one call, to log-analyst, its content returned
#   * log-analyst 503 (wake refused) -> retried on super, super's content returned
#   * log-analyst 502 (backend unreachable) -> retried on super
#   * any other HTTP error (e.g. 400) is not masked by a fallback -- it still raises
#
# Run: python3 infra/hermes-logs/tests/test_fallback.py
import importlib.util
import io
import sys
import urllib.error
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if not cond:
        FAILURES.append(f"{label} {detail}".strip())
        print(f"FAIL: {label} {detail}")
    else:
        print(f"PASS: {label}")


spec = importlib.util.spec_from_file_location("hermes_logs", REPO / "tools" / "hermes-logs.py")
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)


def fake_router(log_analyst_status):
    calls = []

    def post(url, payload, token=None, timeout=15, analysis=False):
        calls.append(payload["model"])
        if payload["model"] == "log-analyst" and log_analyst_status:
            raise urllib.error.HTTPError(url, log_analyst_status, "err", {}, io.BytesIO(b""))
        return {"choices": [{"message": {"content": f"answer from {payload['model']}"}}]}

    logs._post = post
    return calls


calls = fake_router(None)
out = logs.ask_super("check", "raw", "some log lines")
check("log-analyst answers directly", out == "answer from log-analyst" and calls == ["log-analyst"], str(calls))

for status in (503, 502):
    calls = fake_router(status)
    out = logs.ask_super("check", "raw", "some log lines")
    check(f"log-analyst {status} falls back to super",
          out == "answer from super" and calls == ["log-analyst", "super"], str(calls))

calls = fake_router(400)
try:
    logs.ask_super("check", "raw", "some log lines")
    check("a 400 is not masked by the fallback", False, "no exception raised")
except urllib.error.HTTPError as exc:
    check("a 400 is not masked by the fallback", exc.code == 400 and calls == ["log-analyst"], str(calls))

print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} passed")
sys.exit(1 if FAILURES else 0)
