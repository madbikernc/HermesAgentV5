#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-11-22) — offline checks for hermes-dualcoder.py 1.2.0's strip_reasoning() port
# (ported from hermes-self-repair-generate.py 1.5.0). No offline test existed for this file at
# all before this. No network, no model, no service -- urllib.request.urlopen is stubbed, so this
# runs anywhere Python 3 does.
#
# WHY THIS MATTERS: the real failure this fix closes (task financetrack-cat2-c50d227d19,
# 2026-11-22) was a leaked <think> tag in coder2's reply getting carried into the next prompt and
# tripping the router's own Layer 1 role_spoof check with a bare "HTTP Error 400: Bad Request".
# These checks prove the fix at both levels: strip_reasoning() itself, and call_model() actually
# calling it on the real response path before anything downstream (review()'s APPROVE/ISSUES
# check, revise()'s next prompt) ever sees the raw text.
#
# Run: python3 infra/hermes-dualcoder/tests/test_dualcoder.py

import importlib.util
import json
import os
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[3] / "tools"

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
    os.environ.setdefault("BUZZ_TOKEN", "test-token-not-real")
    os.environ.setdefault("MEMORY_TOKEN", "test-token-not-real")
    spec = importlib.util.spec_from_file_location("dualcoder_under_test", TOOLS / "hermes-dualcoder.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fake_response(payload):
    class _R:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps(payload).encode()
    return _R()


def reply_payload(content, reasoning_content=None, finish_reason="stop"):
    message = {"content": content}
    if reasoning_content is not None:
        message["reasoning_content"] = reasoning_content
    return {"choices": [{"message": message, "finish_reason": finish_reason}]}


def main():
    mod = load()

    print("\n[strip_reasoning: unit checks]")
    cases = [
        ("APPROVE -- looks correct", "APPROVE -- looks correct"),
        ("<think>let me check this</think>\nAPPROVE -- the loop terminates", "APPROVE -- the loop terminates"),
        ("weighing it up...\n</think>\n\nISSUES: off-by-one on the last index", "ISSUES: off-by-one on the last index"),
        ("  APPROVE  ", "APPROVE"),
        ("", ""),
    ]
    for raw, expected in cases:
        check(f"{raw[:40]!r} -> {expected[:40]!r}", mod.strip_reasoning(raw) == expected,
              f"got {mod.strip_reasoning(raw)!r}")

    check("a <think> block with nothing after it strips to empty",
          mod.strip_reasoning("<think>only reasoning, no real answer</think>") == "")
    check("multiple <think> blocks are all removed",
          mod.strip_reasoning("<think>a</think>keep this<think>b</think>") == "keep this")

    print("\n[call_model: a leaked <think> tag never reaches the caller]")
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        return fake_response(reply_payload(
            "<think>the reviewer's reasoning, which must never leak downstream</think>\n"
            "ISSUES -- the function mutates its input argument"
        ))
    mod.urllib.request.urlopen = fake_urlopen
    result = mod.call_model("coder2", "system prompt", "user content", max_tokens=100)
    check("the leaked <think> block is stripped from the returned content",
          "<think>" not in result and "</think>" not in result, result)
    check("the real verdict text survives the strip",
          result == "ISSUES -- the function mutates its input argument", result)

    print("\n[call_model: a dangling </think> with no opening tag]")
    mod.urllib.request.urlopen = lambda req, timeout=None: fake_response(reply_payload(
        "some leaked reasoning fragment</think>APPROVE -- looks correct"
    ))
    result = mod.call_model("coder", "s", "u", max_tokens=100)
    check("only the text after the last </think> survives",
          result == "APPROVE -- looks correct", result)

    print("\n[call_model: the pre-existing truncation guard still fires (strip_reasoning doesn't mask it)]")
    mod.urllib.request.urlopen = lambda req, timeout=None: fake_response(
        reply_payload("", reasoning_content="x" * 500, finish_reason="length")
    )
    try:
        mod.call_model("coder2", "s", "u", max_tokens=50)
        check("a truncated-mid-reasoning response raises rather than returning", False)
    except RuntimeError as exc:
        check("a truncated-mid-reasoning response raises rather than returning", True, str(exc))

    print("\n[call_model: ordinary clean replies are unaffected]")
    mod.urllib.request.urlopen = lambda req, timeout=None: fake_response(
        reply_payload("def f(x):\n    return x + 1\n")
    )
    result = mod.call_model("coder", "s", "u", max_tokens=100)
    check("a clean reply with no reasoning tags passes through unchanged (same .strip() as before)",
          result == "def f(x):\n    return x + 1", repr(result))

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
