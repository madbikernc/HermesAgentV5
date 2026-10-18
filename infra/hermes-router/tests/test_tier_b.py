#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S40 Phase D (Tier B, EGRESS_GUARD_DESIGN.md §7) -- the two new functions in
# hermes-router.py (extract_tool_calls(), check_tool_calls()) and their use of
# tools/hermes_egress_guard.py's check_tool_call()/is_registered_function(). No network, no
# fleet infrastructure: hermes-router.py's own module-level requirement (HERMES_NODE) is stubbed
# before import, and every alert-related env var is forced unset so a denial check never sends a
# real email/Matrix notice as a side effect of running this test (same discipline
# infra/hermes-egress-guard/tests/test_egress_guard.py already established for the same reason).
#
# What it covers is specifically the logic that would otherwise only fail in production, since no
# backend has ever actually emitted a tool_calls/function_call field (confirmed, design doc §3):
#   * extract_tool_calls(): a plain JSON tool_calls array, the legacy function_call field, and an
#     SSE stream whose delta.tool_calls arguments arrive fragmented across many chunks -- OpenAI's
#     own wire shape, reconstructed by index
#   * a clean response (no tool call at all) yields [], and garbage input doesn't raise
#   * check_tool_calls(): an unregistered function name denies even with no URL-shaped argument
#     at all; a registered function with no URL-shaped argument passes; a registered function
#     whose argument IS URL-shaped still denies today, because no registry row lists a function
#     name as its own allowed_caller yet -- exactly the "nothing to catch yet" state the design
#     doc itself claims, now asserted rather than assumed
#
# Run: python3 infra/hermes-router/tests/test_tier_b.py
import importlib.util
import json
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


# Force every alert channel's credentials unset for this whole run -- a denial check below must
# never send a real email/Matrix notice as a side effect of running this test on a real fleet node.
_ALERT_ENV_VARS = ("EMAIL_PASSWORD", "FLEETOPS_MATRIX_TOKEN", "FLEETOPS_ROOM", "MEMORY_TOKEN")
_SAVED_ENV = {k: os.environ.pop(k, None) for k in _ALERT_ENV_VARS}
os.environ.setdefault("HERMES_NODE", "spark")
os.environ.pop("HERMES_TOOL_REGISTRY", None)
os.environ.pop("HERMES_EGRESS_ALLOW_FULL_10_8", None)

spec = importlib.util.spec_from_file_location("hermes_router", TOOLS / "hermes-router.py")
router = importlib.util.module_from_spec(spec)
sys.modules["hermes_router"] = router
spec.loader.exec_module(router)

try:
    print("-- extract_tool_calls(): non-streaming --")
    plain = json.dumps({
        "choices": [{"message": {"tool_calls": [
            {"id": "call_1", "type": "function",
             "function": {"name": "web-search-fallback", "arguments": '{"q": "weather"}'}},
        ]}}]
    }).encode()
    calls = router.extract_tool_calls(plain)
    check("one call extracted from tool_calls[]", calls == [
        {"name": "web-search-fallback", "arguments": '{"q": "weather"}'}], str(calls))

    legacy = json.dumps({
        "choices": [{"message": {"function_call":
                                  {"name": "legacy-fn", "arguments": '{"x": 1}'}}}]
    }).encode()
    check("the legacy single function_call field is also extracted",
          router.extract_tool_calls(legacy) == [{"name": "legacy-fn", "arguments": '{"x": 1}'}])

    clean = json.dumps({"choices": [{"message": {"content": "just a normal answer"}}]}).encode()
    check("a clean response (no tool call) yields []", router.extract_tool_calls(clean) == [])

    check("garbage input does not raise and yields []",
          router.extract_tool_calls(b"not json at all { garbage") == [])
    check("empty body does not raise and yields []", router.extract_tool_calls(b"") == [])

    print("-- extract_tool_calls(): streaming (SSE delta reconstruction) --")
    # Real OpenAI streaming shape: name/id arrive once, arguments arrive as string fragments
    # across many chunks, concatenated in order. Two tool calls interleaved by index, like a
    # real multi-call response would be.
    sse_lines = [
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "call_1", "type": "function",
             "function": {"name": "web-search-fallback", "arguments": ""}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": '{"q": "'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 1, "id": "call_2", "type": "function",
             "function": {"name": "model-discovery-lookup", "arguments": ""}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": 'weather"}'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 1, "function": {"arguments": '{"id": "x"}'}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ]
    sse_body = ("\n".join(f"data: {json.dumps(c)}" for c in sse_lines)
                + "\ndata: [DONE]\n").encode()
    sse_calls = {c["name"]: c["arguments"] for c in router.extract_tool_calls(sse_body)}
    check("both indices are reconstructed, keyed by their own index",
          set(sse_calls) == {"web-search-fallback", "model-discovery-lookup"}, str(sse_calls))
    check("fragmented arguments are concatenated in order, not just the last fragment",
          sse_calls.get("web-search-fallback") == '{"q": "weather"}', str(sse_calls))
    check("a single-chunk tool call's arguments are not lost",
          sse_calls.get("model-discovery-lookup") == '{"id": "x"}', str(sse_calls))

    print("-- check_tool_calls(): the real registry, today's actual state --")
    check("an unregistered function name denies even with a harmless argument",
          router.check_tool_calls(json.dumps({
              "choices": [{"message": {"tool_calls": [
                  {"function": {"name": "nonexistent-tool", "arguments": '{"q": "x"}'}}]}}]
          }).encode()) is not None)

    check("a registered function with no URL-shaped argument passes",
          router.check_tool_calls(json.dumps({
              "choices": [{"message": {"tool_calls": [
                  {"function": {"name": "web-search-fallback",
                                "arguments": '{"query": "weather in paris"}'}}]}}]
          }).encode()) is None)

    deny_reason = router.check_tool_calls(json.dumps({
        "choices": [{"message": {"tool_calls": [
            {"function": {"name": "web-search-fallback",
                           "arguments": '{"url": "https://api.tavily.com/search"}'}}]}}]
    }).encode())
    check("a registered function with a URL-shaped argument STILL denies today -- no registry "
          "row lists a function name as its own allowed_caller yet (design doc §7's own "
          "'nothing to catch yet' claim, asserted here rather than assumed)",
          deny_reason is not None and "api.tavily.com" in deny_reason, deny_reason)

    check("a response with no tool call at all is simply not checked (nothing to deny)",
          router.check_tool_calls(json.dumps(
              {"choices": [{"message": {"content": "hello"}}]}).encode()) is None)

finally:
    for k, v in _SAVED_ENV.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
if FAILURES:
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
