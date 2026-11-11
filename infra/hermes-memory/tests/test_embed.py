#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline check for tools/hermes-memory.py's embed(): a turn longer than the embed backend's
# 2048-token context must be cut to MEMORY_EMBED_MAX_CHARS before it is sent, or the backend
# rejects it and the turn is never stored (1.5.0).
#
# Run: python3 infra/hermes-memory/tests/test_embed.py

import importlib.util
import io
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def load():
    spec = importlib.util.spec_from_file_location("memory_test_target", REPO / "tools" / "hermes-memory.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()
    sent = []

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        sent.append(json.loads(req.data.decode("utf-8"))["input"])
        return Resp(json.dumps({"data": [{"embedding": [0.0] * mod.EMBED_DIMS}]}).encode())

    mod.urllib.request.urlopen = fake_urlopen
    whole_file = "const x = 1;\n" * 2000  # about 26k chars, a whole-file self-repair turn
    mod.embed(whole_file)
    mod.embed("short turn")
    failures = []
    if len(sent[0]) != mod.EMBED_MAX_CHARS:
        failures.append(f"a long turn is cut to EMBED_MAX_CHARS before embedding (sent {len(sent[0])} chars)")
    if sent[1] != "short turn":
        failures.append("a short turn is sent unchanged")
    for f in failures:
        print("  FAIL", f)
    print(f"{2 - len(failures)}/2 checks passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
