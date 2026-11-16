#!/usr/bin/env python3
# Version: 1.0.0
#
# Initial version (2026-11-16) — extracted from hermes-coder-build-eval.py 1.0.0 (S39 Phase C,
# FLEET_BENCHMARK_DESIGN.md S6.8) so the same task corpus/prompt-building/scoring logic is
# importable from a second consumer (the GEPA skill-optimization harness,
# HermesAgentV6/IMPLEMENTATION_PLAN.md GLM-5.3-Flash Paradigm A, Phase 1) without duplicating it.
# Pure extraction -- hermes-coder-build-eval.py's own CLI behavior is unchanged; see that file's
# own changelog for this split. Same two additive changes as hermes_coder_fix_common.py's own
# split: `build_prompt()` gained a `system_prompt=` kwarg (defaulting to the literal text that was
# previously hardcoded, now `DEFAULT_BUILD_SYSTEM_PROMPT`) -- note the `fixture_note` suffix is a
# scoring-mechanism instruction, not part of the skill being optimized, so it stays appended
# unconditionally and is never itself substituted; `call_backend()` gained an `extra_body=` kwarg.
"""
hermes_coder_build_common — the fleet_coder_build task corpus, prompt construction, and scoring,
shared between hermes-coder-build-eval.py (the CLI suite) and the GEPA harness
(tools/hermes-gepa-coder-build.py). See hermes-coder-build-eval.py's own module docstring for the
full design rationale -- this module is the implementation, not a second copy of that explanation.
"""
import importlib.util
import json
import re
import subprocess
import tempfile
import urllib.request
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent


def strip_code_fence(text):
    """Same fix as hermes-coder-fix-eval.py's own strip_code_fence() -- never touches the code's
    own leading whitespace, only actual fence markup, if present at all."""
    m = re.match(r"^\s*```[a-zA-Z0-9_+-]*\n(.*?)\n```\s*$", text, re.DOTALL)
    return m.group(1) if m else text


def load_code(code_text, module_name="_candidate_build"):
    """Writes the model's returned code to a temp module and imports it. A syntactically broken
    answer fails to import -- that's correctly scored as a fixture failure below, not a harness
    crash: an unimportable answer is a wrong answer."""
    with tempfile.NamedTemporaryFile(suffix=".py", prefix="hermes-coder-build-", mode="w",
                                      delete=False, encoding="utf-8") as tmp:
        tmp.write(code_text)
        tmp_path = Path(tmp.name)
    try:
        spec = importlib.util.spec_from_file_location(module_name, tmp_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        tmp_path.unlink(missing_ok=True)


# ── the 3 real, dependency-free fixtures (each verified against the real commit first) ─────────

_SPAMHAUS_SAMPLE = ("; Spamhaus DROP List\n; Last updated 2026-01-01\n"
                    "1.2.3.0/24 ; SBL12345\n5.6.7.0/28 ; SBL67890\n\n8.9.10.0/22 ; SBL11111\n")
_SPAMHAUS_EXPECTED = [("1.2.3.0/24", "SBL12345"), ("5.6.7.0/28", "SBL67890"),
                       ("8.9.10.0/22", "SBL11111")]

_FEODO_SAMPLE = ("# Feodo Tracker IP Blocklist\n# Generated 2026-01-01\n"
                 "198.51.100.5\n203.0.113.9\n\n192.0.2.77\n")
_FEODO_EXPECTED = [("198.51.100.5", "active C2"), ("203.0.113.9", "active C2"),
                    ("192.0.2.77", "active C2")]

_TWEETFEED_SAMPLE = ('[{"type":"ip","value":"203.0.113.50","tags":["ransomware","c2"]},'
                     '{"type":"domain","value":"bad.example.com","tags":["phishing"]},'
                     '{"type":"ip","value":"198.51.100.20","tags":[]}]')
_TWEETFEED_EXPECTED = [("203.0.113.50", "ransomware,c2"), ("198.51.100.20", "unlabeled")]


def fixture_botnet_intel(mod):
    assert list(mod._parse_spamhaus(_SPAMHAUS_SAMPLE)) == _SPAMHAUS_EXPECTED, \
        f"_parse_spamhaus: got {mod._parse_spamhaus(_SPAMHAUS_SAMPLE)!r}"
    assert list(mod._parse_feodo(_FEODO_SAMPLE)) == _FEODO_EXPECTED, \
        f"_parse_feodo: got {mod._parse_feodo(_FEODO_SAMPLE)!r}"
    assert list(mod._parse_tweetfeed(_TWEETFEED_SAMPLE)) == _TWEETFEED_EXPECTED, \
        f"_parse_tweetfeed: got {mod._parse_tweetfeed(_TWEETFEED_SAMPLE)!r}"


_RSS_SAMPLE = (
    '<?xml version="1.0"?>\n<rss version="2.0"><channel>\n'
    "<item>\n  <guid>https://example.com/post-1</guid>\n"
    "  <title>Vendor Patches <b>Critical</b> Flaw</title>\n"
    "  <link>https://example.com/post-1</link>\n"
    "  <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>\n"
    "  <description>A <i>critical</i> flaw was patched.</description>\n</item>\n"
    "<item>\n  <link>https://example.com/post-2</link>\n  <title>Second Post</title>\n"
    "  <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>\n"
    "  <description>No guid here.</description>\n</item>\n</channel></rss>")


def fixture_feed_reader(mod):
    """Checks guid-fallback, HTML-stripping, and link extraction exactly; deliberately does NOT
    exact-match `published` -- the real function normalizes it (e.g. to ISO 8601) and the exact
    normalization isn't the point of this fixture, only that the other fields extract and clean
    correctly. Only checks non-emptiness for that one field."""
    entries = mod.parse_feed(_RSS_SAMPLE)
    assert len(entries) == 2, f"expected 2 entries, got {len(entries)}: {entries!r}"
    e0, e1 = entries
    assert e0["guid"] == "https://example.com/post-1", f"entry 0 guid: {e0!r}"
    assert e0["title"] == "Vendor Patches Critical Flaw", f"entry 0 title (HTML stripped): {e0!r}"
    assert e0["link"] == "https://example.com/post-1", f"entry 0 link: {e0!r}"
    assert e0["summary"] == "A critical flaw was patched.", f"entry 0 summary (HTML stripped): {e0!r}"
    assert e0["published"], "entry 0 published must be non-empty"
    assert e1["guid"] == "https://example.com/post-2", \
        f"entry 1 guid must fall back to <link> when no <guid> is present: {e1!r}"
    assert e1["title"] == "Second Post", f"entry 1 title: {e1!r}"


_PLAYER_NAME_CASES = [
    ("Steve123", True), ("x" * 17, False), ("bad name", False), ("", False),
    ("_underscore_99", True), ("a" * 16, True), ("a" * 17, False), ("valid_Name1", True),
]


def fixture_minecraft_admin(mod):
    for name, expected in _PLAYER_NAME_CASES:
        actual = mod._valid_player_name(name)
        assert actual == expected, f"_valid_player_name({name!r}): expected {expected}, got {actual}"


# ── the 8 tasks (7 commits in this repo, 1 in HermesAgentRedo) ─────────────────────────────────

TASKS = [
    {"id": "reolink_camera_build", "hash": "6d7d9cd", "repo": "this",
     "path": "tools/hermes-reolink.py", "fixture": None,
     "requirement": ("Add support for a home security camera (Reolink) to this fleet: a "
                     "specialist that can pull an on-demand snapshot plus a text description via "
                     "chat, and run a continuous poll loop that alerts (by email) on person/"
                     "vehicle/pet AI-detection events, with a cooldown so repeated detections "
                     "don't spam the same alert. The camera has a documented local CGI API "
                     "reachable on the LAN, with no cloud account or OAuth needed.")},

    {"id": "botnet_intel_build", "hash": "6b88214", "repo": "HermesAgentRedo",
     "path": "tools/hermes_botnet_intel.py", "fixture": fixture_botnet_intel,
     "requirement": ("Build a local threat-intelligence cache of known-malicious IPs/CIDRs, so "
                     "other tools in this fleet can check 'is this IP a known bad actor' without "
                     "calling out to a third party on every single lookup. Pull from three free, "
                     "keyless sources: Spamhaus's DROP list (CIDR ranges), abuse.ch's Feodo "
                     "Tracker (active C2 server IPs), and TweetFeed (a community-sourced "
                     "indicator feed, JSON). Specifically, implement three parser functions with "
                     "these exact signatures:\n"
                     "`_parse_spamhaus(text: str) -> list[tuple[str, str]]` -- each Spamhaus DROP "
                     "line looks like `<CIDR> ; <SBL-reference>`; a line that's blank or starts "
                     "with `;` is a comment and must be skipped; return (cidr, tag) pairs.\n"
                     "`_parse_feodo(text: str) -> list[tuple[str, str]]` -- each non-comment, "
                     "non-blank line is one IP address; comment lines start with `#`; return "
                     "(ip, 'active C2') pairs.\n"
                     "`_parse_tweetfeed(raw_json: str) -> list[tuple[str, str]]` -- the input is "
                     "a JSON array of objects with `type`, `value`, and `tags` fields; keep only "
                     "objects where `type == 'ip'`; return (ip, tag) pairs where tag is the "
                     "object's `tags` list comma-joined, or the literal string 'unlabeled' if "
                     "`tags` is empty or missing; invalid JSON input must return an empty list, "
                     "never raise.")},

    {"id": "doc_to_markdown_build", "hash": "295589c", "repo": "this",
     "path": "tools/hermes_doc_to_markdown.py", "fixture": None,
     "requirement": ("Build a tool that converts PDF and DOCX documents into structured Markdown "
                     "(preserving headings, tables, and lists) for indexing into this fleet's RAG "
                     "store, replacing a prior flat-text-only extraction that lost all document "
                     "structure.")},

    {"id": "feed_reader_build", "hash": "bf82a01", "repo": "this",
     "path": "tools/hermes-feed-reader.py", "fixture": fixture_feed_reader,
     "requirement": ("Build a daily RSS/Atom feed ingestion tool that pulls entries from a "
                     "configured list of security/AI news feeds into this fleet's RAG store, "
                     "deduping so re-running the ingestion doesn't re-index the same entry twice. "
                     "Specifically, implement a function `parse_feed(body: str) -> list[dict]` "
                     "that takes one feed's raw XML body and returns a list of entries, each a "
                     "dict with keys `guid`, `title`, `link`, `published`, and `summary`, for an "
                     "RSS 2.0 feed (items are `<item>` elements). `guid` comes from the item's "
                     "`<guid>` element, or falls back to its `<link>` element if no `<guid>` is "
                     "present. `title` and `summary` (from the item's `<description>`) must have "
                     "any HTML tags stripped out, leaving just the text. A feed body that isn't "
                     "valid XML at all should raise; any other malformation in one entry should "
                     "just leave that entry's affected field blank rather than failing the whole "
                     "feed.")},

    {"id": "minecraft_admin_build", "hash": "3755e07", "repo": "this",
     "path": "tools/hermes-minecraft-admin.py", "fixture": fixture_minecraft_admin,
     "requirement": ("Build a chat-driven admin tool for this fleet's Minecraft and Project "
                     "Zomboid game servers, wired into Matrix chat, supporting RCON-based "
                     "whitelist/op/kick/ban/restart operations. Specifically, implement a "
                     "function `_valid_player_name(name: str) -> bool` that returns whether a "
                     "string is a syntactically valid Minecraft username: Minecraft's own real "
                     "rule is 1 to 16 characters, and only letters, digits, or underscores -- "
                     "nothing else, including no spaces.")},

    {"id": "minecraft_triage_build", "hash": "09cf8df", "repo": "this",
     "path": "tools/hermes-minecraft-triage.py", "fixture": None,
     "requirement": ("Build an automated bot-fleet triage tool: something that monitors this "
                     "fleet's Minecraft bots' own behavior/error logs on a schedule, and when it "
                     "finds a real problem, engages a coder role in a loop to do initial triage "
                     "and propose next steps, rather than requiring an operator to notice and "
                     "investigate manually.")},

    {"id": "shelter_awareness_build", "hash": "f5e75e7", "repo": "this",
     "path": "services/minecraft-bots/shelter.js", "fixture": None,
     "requirement": ("Minecraft bots currently have no awareness of which blocks around them are "
                     "important fixtures -- they will path through or destructively mine a "
                     "chest, bed, or door that's in their way, and won't reliably carry or place "
                     "torches to light a tunnel they're digging. Add awareness of these fixtures "
                     "so bots stop blocking or destroying chests, beds, and doors, and reliably "
                     "carry and place torches while tunneling, without damaging the shelter's own "
                     "walls in the process.")},

    {"id": "skills_library_build", "hash": "997dbfc", "repo": "this",
     "path": "services/minecraft-bots/skills.js", "fixture": None,
     "requirement": ("Bot behaviors are currently hardcoded in the bots' own source code. Build a "
                     "persisted, searchable skill library instead, so a behavior can be looked up "
                     "and invoked by name or description rather than requiring a code change "
                     "every time a new behavior is needed.")},
]

REPO_PATHS = {"this": REPO, "HermesAgentRedo": REPO.parent / "HermesAgentRedo"}


def real_reference(task):
    """The real post-build file, for the judge's reference only -- never shown to the model
    under test. Truncated to a representative excerpt for the very large files (S6.7's own
    anchor mechanism isn't needed here since there's no pre-fix file to align against -- a
    build task's reference is just "the real finished file," read once)."""
    result = subprocess.run(["git", "show", f"{task['hash']}:{task['path']}"],
                             cwd=REPO_PATHS[task["repo"]], capture_output=True, text=True,
                             encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"git show failed for {task['id']}: {result.stderr.strip()}")
    text = result.stdout
    lines = text.splitlines()
    if len(lines) > 220:
        return "\n".join(lines[:220]) + f"\n... ({len(lines) - 220} more lines omitted) ..."
    return text


# ── judge path (universal; never the role under test, S8.7) ────────────────────────────────────

JUDGE_SYSTEM_PROMPT = (
    "You are grading one proposed implementation against a real requirement, shown alongside a "
    "real reference implementation of the same requirement for context. You are not the model "
    "that wrote the proposed implementation. Grade on: does the proposal plausibly satisfy the "
    "stated requirement; is it a reasonable, workable design for it; does it avoid an obvious "
    "fatal flaw. Do NOT penalize the proposal for being textually or structurally different from "
    "the reference -- there is more than one reasonable way to build most things, and partial "
    "credit for a proposal that addresses part of the requirement well is expected, not a binary "
    "pass/fail. Reply with exactly PASS or FAIL on the first line (PASS = a competent, workable "
    "attempt at the real requirement; FAIL = does not plausibly address the requirement, or has "
    "an obvious fatal flaw), then one short sentence of why."
)


def judge_prompt(requirement, response_text, real_excerpt):
    return [
        {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
        {"role": "user", "content": f"Requirement: {requirement}\n\n"
                                     f"Proposed implementation:\n{response_text}\n\n"
                                     f"A real reference implementation of this requirement, for "
                                     f"context only (the candidate never saw this):\n{real_excerpt}"},
    ]


def parse_judge_verdict(judge_text):
    """pass | fail | unclear -- same "a non-answer is not a 'no'" discipline every other suite in
    this design already applies."""
    first_line = (judge_text or "").strip().splitlines()[0].strip().upper() if judge_text else ""
    if first_line.startswith("PASS"):
        return "pass"
    if first_line.startswith("FAIL"):
        return "fail"
    return "unclear"


def call_backend(endpoint, model, messages, max_tokens=4000, timeout=180, extra_body=None):
    """extra_body: see hermes_coder_fix_common.call_backend()'s own docstring -- identical
    addition, same rationale."""
    payload = {"model": model, "messages": messages, "max_tokens": max_tokens}
    if extra_body:
        payload.update(extra_body)
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{endpoint.rstrip('/')}/chat/completions", data=body,
                                  method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    return data["choices"][0]["message"]["content"].strip()


DEFAULT_BUILD_SYSTEM_PROMPT = (
    "You are building a new capability for a real, running fleet of tools/services, from "
    "a plain statement of why it's needed. You are not told how to build it.")


def build_prompt(path, requirement, has_fixture, system_prompt=DEFAULT_BUILD_SYSTEM_PROMPT):
    """system_prompt (added 2026-11-16, additive, defaults to the literal text this suite has
    always used): the GEPA harness substitutes a candidate skill text here. `fixture_note` is a
    scoring-mechanism instruction, not part of the skill being optimized -- it stays appended
    unconditionally regardless of which system_prompt is in play."""
    fixture_note = (
        "\n\nThis task will be scored by actually running the function(s) you implement against "
        "a real test input, so return a complete, runnable Python module containing exactly the "
        "function signature(s) given above (plus any helper code they need), and nothing else -- "
        "no explanation, no markdown code fences."
        if has_fixture else
        "\n\nDescribe your implementation approach and any key code, at whatever level of detail "
        "you'd actually build this at. No fixed format is required for this task."
    )
    return [
        {"role": "system", "content": system_prompt + fixture_note},
        {"role": "user", "content": f"File this would live in: {path}\n\nRequirement: {requirement}"},
    ]
