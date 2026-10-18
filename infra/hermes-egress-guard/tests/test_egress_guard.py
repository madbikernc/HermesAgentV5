#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S40's Tier A guard (tools/hermes_egress_guard.py). No network, no fleet
# infrastructure -- every check either feeds a literal IP/host straight to the pure functions or
# points REGISTRY_PATH at a temp file this test writes itself, so it runs anywhere Python 3 does.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * every internal plane/loopback range allows, and the address just outside each one doesn't
#   * a hostname (never a literal IP) is never classified internal -- the stated limitation
#   * the full-10.0.0.0/8 opt-in is off by default and only takes effect when explicitly set
#   * registry parsing: a well-formed file, a malformed line, and a missing file
#   * check_destination()'s full decision table: internal bypasses the registry entirely, an
#     external host grants only its own listed caller(s), and a missing registry fails CLOSED
#     (denies) rather than open
#
# Run: python3 infra/hermes-egress-guard/tests/test_egress_guard.py
import importlib
import os
import sys
import tempfile
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


def expect_denied(fn, label):
    try:
        fn()
        check(label, False, "-- expected EgressDenied, nothing was raised")
    except guard.EgressDenied:
        check(label, True)


def expect_allowed(fn, label):
    try:
        fn()
        check(label, True)
    except guard.EgressDenied as exc:
        check(label, False, f"-- unexpectedly denied: {exc}")


os.environ.pop("HERMES_EGRESS_ALLOW_FULL_10_8", None)
os.environ.pop("HERMES_TOOL_REGISTRY", None)
import hermes_egress_guard as guard  # noqa: E402

print("-- internal ranges (§4) --")
for host in ("10.129.1.1", "10.129.1.254", "10.129.9.1", "10.129.9.2",
             "10.129.10.1", "10.129.10.2", "100.64.0.1", "100.127.255.254",
             "127.0.0.1", "localhost"):
    check(f"_is_internal({host!r}) is True", guard._is_internal(host) is True)

for host in ("10.129.2.1", "10.129.8.1", "10.129.11.1", "100.63.255.255",
             "100.128.0.1", "8.8.8.8", "10.0.0.1", "huggingface.co"):
    check(f"_is_internal({host!r}) is False", guard._is_internal(host) is False,
          "-- a hostname or an out-of-range address must never read as internal")

print("-- full 10.0.0.0/8 is opt-in, never the silent default (§4) --")
check("10.0.0.1 is NOT internal by default", guard._is_internal("10.0.0.1") is False)
os.environ["HERMES_EGRESS_ALLOW_FULL_10_8"] = "1"
importlib.reload(guard)
check("10.0.0.1 IS internal once opted in", guard._is_internal("10.0.0.1") is True)
os.environ.pop("HERMES_EGRESS_ALLOW_FULL_10_8", None)
importlib.reload(guard)
check("opting back out restores the narrower default", guard._is_internal("10.0.0.1") is False)

print("-- registry parsing --")
with tempfile.TemporaryDirectory() as tmp:
    good = Path(tmp) / "good.yaml"
    good.write_text(
        "# comment, ignored\n"
        "\n"
        "web-search-fallback | external-endpoint | hermes-websearch.py | api.tavily.com\n"
        "model-discovery-lookup | external-endpoint | hermes-model-scout.py,hermes-model-scan.py | huggingface.co\n"
    )
    entries = guard._load_registry(good)
    check("parses two entries", len(entries) == 2, f"-- got {entries!r}")
    check("destination key is lowercased", "api.tavily.com" in entries)
    check("allowed_callers splits on comma",
          entries["huggingface.co"]["allowed_callers"] == {"hermes-model-scout.py", "hermes-model-scan.py"})

    bad = Path(tmp) / "bad.yaml"
    bad.write_text("this line has no pipes at all\n")
    try:
        guard._load_registry(bad)
        check("malformed line raises", False, "-- no exception raised")
    except ValueError:
        check("malformed line raises", True)

    missing = Path(tmp) / "does-not-exist.yaml"
    try:
        guard._load_registry(missing)
        check("missing file raises", False, "-- no exception raised")
    except (FileNotFoundError, OSError):
        check("missing file raises", True)

print("-- check_destination(): the full decision table --")
with tempfile.TemporaryDirectory() as tmp:
    registry = Path(tmp) / "firmament-tool-registry.yaml"
    registry.write_text(
        "web-search-fallback | external-endpoint | hermes-websearch.py | api.tavily.com\n"
    )
    os.environ["HERMES_TOOL_REGISTRY"] = str(registry)
    importlib.reload(guard)

    expect_allowed(lambda: guard.check_destination("http://10.129.1.15:8102/turns", "anything"),
                   "internal destination bypasses the registry entirely (any caller)")
    expect_allowed(lambda: guard.check_destination("https://api.tavily.com/search", "hermes-websearch.py"),
                   "the listed caller is allowed to reach its own registry entry")
    expect_denied(lambda: guard.check_destination("https://api.tavily.com/search", "hermes-model-scout.py"),
                  "a different caller is denied the same destination (§5's own point)")
    expect_denied(lambda: guard.check_destination("https://huggingface.co/api/models/x", "hermes-model-scout.py"),
                  "a destination with no registry entry at all is denied")
    expect_denied(lambda: guard.check_destination("not a url, no host", "hermes-websearch.py"),
                  "an unparseable destination is denied, not silently skipped")

    os.environ["HERMES_TOOL_REGISTRY"] = str(Path(tmp) / "does-not-exist.yaml")
    importlib.reload(guard)
    expect_denied(lambda: guard.check_destination("https://api.tavily.com/search", "hermes-websearch.py"),
                  "a missing registry fails CLOSED -- denies non-internal egress, never opens it")
    expect_allowed(lambda: guard.check_destination("http://127.0.0.1:6167/_matrix", "anything"),
                   "a missing registry still never blocks internal traffic")

os.environ.pop("HERMES_TOOL_REGISTRY", None)

print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
if FAILURES:
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
