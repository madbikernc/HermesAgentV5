#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes_self_repair_domains — FLEET_SELFREPAIR_DESIGN.md §4.1's domain registry, made concrete.
# Underscore-named, not hyphenated like every other tools/hermes-self-repair-*.py file, for the
# same reason hermes_market_common.py and hermes_benchmark_common.py are: this module is meant to
# be imported directly (`import hermes_self_repair_domains`), which a hyphenated filename cannot be
# -- every hyphenated file in this directory is a standalone CLI tool, not an import target.
#
# Reads infra/hermes-self-repair/domains.json: a flat JSON file, not a Python module per domain
# (§6's open question, decided here) — chosen because it is equally easy to audit at a glance with
# zero domains or ten, and because nothing registered so far (domain #1, minecraft-bots, per §3)
# needs logic a flat file can't express. If a future domain's completeness rule (§4.3) genuinely
# needs code a flat file can't carry, that is the point to revisit this choice — not before.
#
# One source of truth, imported by every generic consumer rather than each keeping its own copy:
# the registered-PR mechanism (hermes-self-repair-open-pr.py, for branch naming), the FleetOps UI's
# /selfrepair tab (for the domain column/filter), and, once built in Phase 3 (§8.3), the
# completeness hook and the detection->submit bridge. This module does no writing anywhere and
# holds no credential — it is a plain config reader, safe to import unconditionally the same way
# hermes_market_common.py/hermes_benchmark_common.py already are elsewhere in this codebase (unlike
# the model-scout/self-repair GATE modules, which carry a privileged transition table and are
# imported through a fail-closed load_gate() instead).
#
# A domain entry: {"name", "path_scope": [<repo-relative prefixes>], "detection_source",
# "completeness_rule", "cadence", "self_managed": bool}. Every field but "self_managed" is free text
# describing where the real mechanism lives (§3's table) — this registry does not itself call a
# detection source or run a completeness check, it only answers "which domain, if any, owns this
# path, and is that domain's switch on."
#
# Config:
#   SELF_REPAIR_DOMAINS_FILE   default infra/hermes-self-repair/domains.json, relative to this
#                              file's own repo (never the SELF_REPAIR_REPO_DIR target checkout —
#                              same reasoning as allowlist.json's own header: a domain's switch is a
#                              privileged decision and must not be editable by a self-repair task
#                              that happens to touch a path under its own scope).

import json
import os
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
DOMAINS_FILE = Path(os.environ.get(
    "SELF_REPAIR_DOMAINS_FILE", str(REPO / "infra" / "hermes-self-repair" / "domains.json")))


def load_domains():
    """Returns the list of registered domains, [] if the file is missing or empty. Never raises on
    a missing file -- "no domains registered" is the expected, exercised starting state (§8.2), not
    an error."""
    if not DOMAINS_FILE.is_file():
        return []
    try:
        data = json.loads(DOMAINS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    domains = data.get("domains") if isinstance(data, dict) else None
    return domains if isinstance(domains, list) else []


def domain_for_path(path):
    """The registered domain, if any, whose path_scope prefixes this path -- or None. `path` is
    repo-relative, the same shape hermes-self-repair-generate.py's own task spec already uses. A
    domain with an empty/missing path_scope matches nothing, deliberately (an unscoped domain would
    silently claim every task, which is never what a registration means)."""
    path = str(path).replace("\\", "/").lstrip("/")
    for domain in load_domains():
        for prefix in domain.get("path_scope") or []:
            prefix = str(prefix).replace("\\", "/").rstrip("/")
            if path == prefix or path.startswith(prefix + "/"):
                return domain
    return None


def domain_switch_on(domain):
    return bool(domain) and bool(domain.get("self_managed"))


def main():
    domains = load_domains()
    if not domains:
        print("No domains registered.")
        return
    for d in domains:
        print(f"{d.get('name', '?')}  "
              f"(self_managed={'on' if domain_switch_on(d) else 'off'})")
        print(f"  path_scope:        {d.get('path_scope')}")
        print(f"  detection_source:  {d.get('detection_source')}")
        print(f"  completeness_rule: {d.get('completeness_rule')}")
        print(f"  cadence:           {d.get('cadence')}")


if __name__ == "__main__":
    main()
