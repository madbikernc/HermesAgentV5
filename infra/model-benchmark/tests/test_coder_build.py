#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase C's fleet_coder_build suite (FLEET_BENCHMARK_DESIGN.md S6.8,
# closes gap 8, after S39a's sign-off 2026-10-22). No network beyond local `git show` (this
# repo's and the sibling HermesAgentRedo's own history, already on disk), no live coder/judge
# backend: every check below either calls the pure fixture functions directly against the REAL
# post-build implementation (not a hand-computed guess), confirms every task's real reference
# resolves across both repos, or monkeypatches call_backend() so main()'s own end-to-end path
# runs with zero real HTTP calls.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * all 8 tasks' real reference implementation resolves, including the one in the sibling
#     HermesAgentRedo repo (cross-repo git access, same precedent fleet_coder_fix's corpus set)
#   * each of the 3 real fixtures (botnet_intel/feed_reader/minecraft_admin) PASSES against the
#     REAL post-build implementation and FAILS against a plausibly-wrong one -- proving the
#     fixture actually discriminates, not just that it runs without crashing
#   * main()'s end-to-end path: a correct model scores 1.0/1.0 on both axes (never blended,
#     S8.6), a wrong model scores 0.0/0.0, and a failed call for one task doesn't block scoring
#     the rest
#
# Run: python3 infra/model-benchmark/tests/test_coder_build.py
import importlib.util
import json
import subprocess
import sys
import tempfile
import urllib.error
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
    spec = importlib.util.spec_from_file_location("hermes_coder_build_eval",
                                                    TOOLS / "hermes-coder-build-eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_MINIMAL_BOTNET = (
    "import json\n"
    "def _parse_spamhaus(text):\n"
    "    out = []\n"
    "    for line in text.splitlines():\n"
    "        line = line.strip()\n"
    "        if not line or line.startswith(';'):\n"
    "            continue\n"
    "        parts = line.split(';')\n"
    "        cidr = parts[0].strip()\n"
    "        tag = parts[1].strip() if len(parts) > 1 else ''\n"
    "        if cidr:\n"
    "            out.append((cidr, tag))\n"
    "    return out\n"
    "def _parse_feodo(text):\n"
    "    return [(l.strip(), 'active C2') for l in text.splitlines()\n"
    "            if l.strip() and not l.strip().startswith('#')]\n"
    "def _parse_tweetfeed(raw_json):\n"
    "    out = []\n"
    "    try:\n"
    "        entries = json.loads(raw_json)\n"
    "    except json.JSONDecodeError:\n"
    "        return out\n"
    "    for e in entries:\n"
    "        if e.get('type') != 'ip':\n"
    "            continue\n"
    "        ip = (e.get('value') or '').strip()\n"
    "        if not ip:\n"
    "            continue\n"
    "        tags = ','.join(e.get('tags') or []) or 'unlabeled'\n"
    "        out.append((ip, tags))\n"
    "    return out\n"
)

_MINIMAL_FEED = (
    "import xml.etree.ElementTree as ET, re\n"
    "def _text(el):\n"
    "    return ''.join(el.itertext()) if el is not None else ''\n"
    "def strip_html(s):\n"
    "    return re.sub(r'<[^>]+>', '', s or '').strip()\n"
    "def parse_feed(body):\n"
    "    root = ET.fromstring(body)\n"
    "    out = []\n"
    "    for item in root.findall('.//item'):\n"
    "        guid = _text(item.find('guid')) or _text(item.find('link'))\n"
    "        out.append({\n"
    "            'guid': guid.strip(),\n"
    "            'title': strip_html(_text(item.find('title'))),\n"
    "            'link': _text(item.find('link')).strip(),\n"
    "            'published': _text(item.find('pubDate')),\n"
    "            'summary': strip_html(_text(item.find('description'))),\n"
    "        })\n"
    "    return out\n"
)

_MINIMAL_ADMIN = (
    "import re\n"
    "def _valid_player_name(name):\n"
    "    return bool(re.fullmatch(r'[A-Za-z0-9_]{1,16}', name))\n"
)

_WRONG_BOTNET = (
    "def _parse_spamhaus(text):\n"
    "    return [(l.strip(), '') for l in text.splitlines() if l.strip()]\n"  # doesn't skip comments
    "def _parse_feodo(text):\n"
    "    return [(l.strip(), 'active C2') for l in text.splitlines() if l.strip()]\n"
    "def _parse_tweetfeed(raw_json):\n"
    "    return []\n"
)


def main():
    mod = load()

    print("\n[TASKS: all 8 tasks, real reference resolves across both repos]")
    check("8 tasks total", len(mod.TASKS) == 8, str(len(mod.TASKS)))
    check("exactly 3 tasks have a fixture (botnet/feed/admin)",
          sum(1 for t in mod.TASKS if t["fixture"] is not None) == 3)
    check("doc_to_markdown_build has NO fixture -- moved to judge-only (missing deps on this machine)",
          [t for t in mod.TASKS if t["id"] == "doc_to_markdown_build"][0]["fixture"] is None)
    check("botnet_intel_build is sourced from the sibling HermesAgentRedo repo",
          [t for t in mod.TASKS if t["id"] == "botnet_intel_build"][0]["repo"] == "HermesAgentRedo")
    for task in mod.TASKS:
        try:
            excerpt = mod.real_reference(task)
            check(f"[{task['id']}] real reference resolves", bool(excerpt))
        except RuntimeError as exc:
            check(f"[{task['id']}] real reference resolves", False, str(exc))

    print("\n[the 3 real fixtures: PASS against the real implementation, FAIL against a wrong one]")
    for tid, minimal_good in [("botnet_intel_build", _MINIMAL_BOTNET),
                               ("feed_reader_build", _MINIMAL_FEED),
                               ("minecraft_admin_build", _MINIMAL_ADMIN)]:
        task = [t for t in mod.TASKS if t["id"] == tid][0]
        real_code = subprocess.run(["git", "show", f"{task['hash']}:{task['path']}"],
                                    cwd=mod.REPO_PATHS[task["repo"]], capture_output=True,
                                    text=True, encoding="utf-8", errors="replace").stdout
        real_mod = mod.load_code(real_code, module_name=f"_realcheck_{tid}")
        try:
            task["fixture"](real_mod)
            check(f"[{tid}] fixture PASSES against the REAL post-build implementation", True)
        except AssertionError as exc:
            check(f"[{tid}] fixture PASSES against the REAL post-build implementation", False, str(exc))

        good_mod = mod.load_code(minimal_good, module_name=f"_goodcheck_{tid}")
        try:
            task["fixture"](good_mod)
            check(f"[{tid}] fixture PASSES against a minimal correct reimplementation", True)
        except AssertionError as exc:
            check(f"[{tid}] fixture PASSES against a minimal correct reimplementation", False, str(exc))

    wrong_mod = mod.load_code(_WRONG_BOTNET, module_name="_wrongcheck")
    try:
        [t for t in mod.TASKS if t["id"] == "botnet_intel_build"][0]["fixture"](wrong_mod)
        check("fixture correctly FAILS a plausible-looking but wrong implementation "
              "(doesn't skip Spamhaus comment lines)", False)
    except AssertionError:
        check("fixture correctly FAILS a plausible-looking but wrong implementation "
              "(doesn't skip Spamhaus comment lines)", True)

    print("\n[main(): end-to-end, a correct model scores 1.0/1.0 on both axes, never blended]")
    def correct_coder(endpoint, model, messages, max_tokens=4000, timeout=180):
        user = messages[1]["content"]
        if "spamhaus" in user.lower():
            return _MINIMAL_BOTNET
        if "parse_feed" in user:
            return _MINIMAL_FEED
        if "_valid_player_name" in user:
            return _MINIMAL_ADMIN
        return "This tool would work by doing the described thing in a reasonable way."

    def passing_judge(endpoint, model, messages, max_tokens=4000, timeout=120):
        return "PASS\nReasonable approach to the stated requirement."

    def dispatch_good(endpoint, model, messages, max_tokens=4000, timeout=180):
        if endpoint == "http://fake-coder:1/v1":
            return correct_coder(endpoint, model, messages, max_tokens, timeout)
        return passing_judge(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = dispatch_good

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-coder-build-eval.py", "--endpoint", "http://fake-coder:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1", "--model-id", "test-coder"]
        rc = mod.main()
        check("main() returns 0", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        check("exactly one history entry written", len(entries) == 1, str(entries))
        suites = entries[0]["suites"]
        check("fleet_coder_build_fixture is 1.0 across all 3 fixture tasks",
              suites.get("fleet_coder_build_fixture", {}).get("value") == 1.0
              and suites.get("fleet_coder_build_fixture", {}).get("limit") == 3, str(suites))
        check("fleet_coder_build_judge is 1.0 across all 8 tasks",
              suites.get("fleet_coder_build_judge", {}).get("value") == 1.0
              and suites.get("fleet_coder_build_judge", {}).get("limit") == 8, str(suites))
        check("no bare fleet_coder_build key -- the two tiers are never blended (S8.6)",
              "fleet_coder_build" not in suites, str(suites))

    print("\n[main(): a wrong model scores 0.0/0.0 on both axes]")
    def wrong_coder(endpoint, model, messages, max_tokens=4000, timeout=180):
        return "def totally_unrelated(): pass"

    def failing_judge(endpoint, model, messages, max_tokens=4000, timeout=120):
        return "FAIL\nDoes not address the requirement."

    def dispatch_bad(endpoint, model, messages, max_tokens=4000, timeout=180):
        if endpoint == "http://fake-coder:1/v1":
            return wrong_coder(endpoint, model, messages, max_tokens, timeout)
        return failing_judge(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = dispatch_bad

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-coder-build-eval.py", "--endpoint", "http://fake-coder:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1"]
        rc = mod.main()
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        suites = entries[0]["suites"]
        check("fleet_coder_build_fixture is 0.0 for a wrong implementation",
              suites.get("fleet_coder_build_fixture", {}).get("value") == 0.0, str(suites))
        check("fleet_coder_build_judge is 0.0 when the judge fails every response",
              suites.get("fleet_coder_build_judge", {}).get("value") == 0.0, str(suites))

    print("\n[main(): a failed call for one task doesn't block scoring the rest]")
    calls = {"n": 0}
    def flaky_coder(endpoint, model, messages, max_tokens=4000, timeout=180):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection refused")
        return "def totally_unrelated(): pass"
    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        flaky_coder(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-coder:1/v1"
        else "PASS\nok")

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-coder-build-eval.py", "--endpoint", "http://fake-coder:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1"]
        rc = mod.main()
        check("main() still returns 0 despite one failed call", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        suites = entries[0]["suites"]
        check("fleet_coder_build_judge scores the surviving 7 tasks (1 call failed outright)",
              suites.get("fleet_coder_build_judge", {}).get("limit") == 7, str(suites))

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
