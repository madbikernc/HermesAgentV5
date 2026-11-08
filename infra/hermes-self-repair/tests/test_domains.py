#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for tools/hermes_self_repair_domains.py — specifically domain_for_path()'s 1.1.0
# glob-matching addition (Phase 3, §8.3), needed for the real minecraft-bots registration's
# `agents/minecraft-*/PROMPT.md` path_scope entry, which the original pure-prefix matcher could
# never have matched. Points DOMAINS_FILE at an isolated temp fixture throughout — never reads or
# depends on the real infra/hermes-self-repair/domains.json.
#
# Run: python3 infra/hermes-self-repair/tests/test_domains.py

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"

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
    spec = importlib.util.spec_from_file_location("domains_test_target", TOOLS / "hermes_self_repair_domains.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["domains_test_target"] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    print("\n[hermes_self_repair_domains.py: prefix + glob path_scope matching]")
    mod = load()

    with tempfile.TemporaryDirectory() as td:
        domains_file = Path(td) / "domains.json"
        domains_file.write_text(json.dumps({"domains": [
            {
                "name": "minecraft-bots",
                "path_scope": ["services/minecraft-bots/", "agents/minecraft-*/PROMPT.md"],
                "self_managed": False,
            },
        ]}))
        mod.DOMAINS_FILE = domains_file

        check("plain-prefix match still works (no glob char involved)",
              mod.domain_for_path("services/minecraft-bots/foo.mjs") is not None)
        check("a path merely sharing the prefix string, without the '/' boundary, does not match",
              mod.domain_for_path("services/minecraft-botsonly/foo.mjs") is None)
        check("the glob entry matches a real bot's PROMPT.md",
              mod.domain_for_path("agents/minecraft-babs/PROMPT.md") is not None)
        check("the glob entry does not match an unrelated agent's PROMPT.md",
              mod.domain_for_path("agents/muse/PROMPT.md") is None)
        check("an unrelated path matches nothing",
              mod.domain_for_path("tools/hermes-code.py") is None)
        check("domain_switch_on() reads self_managed correctly (false by default, §3's own table)",
              mod.domain_switch_on(mod.domain_for_path("services/minecraft-bots/foo.mjs")) is False)

        domains_file.write_text(json.dumps({"domains": []}))
        check("zero domains registered -> matches nothing, the Phase 2 starting state",
              mod.domain_for_path("services/minecraft-bots/foo.mjs") is None)

    total = CHECKS[0]
    failed = len(FAILURES)
    print(f"\n{total - failed}/{total} checks passed")
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
