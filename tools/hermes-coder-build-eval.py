#!/usr/bin/env python3
# Version: 1.0.0
#
# Initial version (2026-10-23) — S39 Phase C (FLEET_BENCHMARK_DESIGN.md S6.8), after S39a's
# sign-off, continuing directly after S6.7 (`fleet_coder_fix`). 8 real-commit build tasks (one in
# the sibling HermesAgentRedo repo), two scoring tiers never blended (S8.6): 3 of 8 tasks have a
# real executable fixture test (pure, dependency-free functions, verified against the REAL
# commit's own implementation before being written here); the other 5 are judge-only, one of them
# (`doc_to_markdown_build`) moved out of this design's own "fixture-testable" framing because this
# dev machine has neither `python-docx` nor `pymupdf4llm` installed, stated plainly below. 25
# offline checks (infra/model-benchmark/tests/test_coder_build.py).
"""
hermes-coder-build-eval.py — S39 Phase C's fleet_coder_build suite, closing
FLEET_BENCHMARK_DESIGN.md gap 8 (S6.8), after S39a's sign-off (2026-10-22). Given a plain
statement of a real requirement this fleet actually had (the operator's own stated "why," never
the "how"), can a coder-role candidate build it?

GROUND TRUTH (S8.6): all 8 real "build from scratch" commits S6.8's own table names. 7 are
reachable directly in this repo; the 8th (`botnet_intel_build`, Phase 25's
`tools/hermes_botnet_intel.py`) is in the sibling `HermesAgentRedo` repo, confirmed reachable by
ordinary cross-repo `git show` before writing anything, same precedent S6.7's own corpus already
established. Requirement text for every task is written from the real commit's own stated
motivation, never from its diff.

PROMPT CONSTRUCTION, different in kind from S6.7's fix prompts: there is no pre-existing file to
excerpt, since the whole point of a build task is that the capability didn't exist yet. The model
is shown only the requirement. For the 3 fixture-tier tasks, the requirement additionally specifies
an exact function signature to implement (taken directly from the real function's own signature,
never more) — a real interface contract, the same kind any actual requirement would come with, not
an implementation hint.

TWO SCORING TIERS, NEVER BLENDED (S8.6, same rule S6.7's own suite already applies):
  * `fixture` — the model's returned function is executed for real against a hand-built but
    REAL-FORMAT input (a real Spamhaus DROP-list excerpt, a real RSS 2.0 item, etc.) and its
    output is compared to the REAL function's own verified behavior on that exact input (every
    fixture in this file was run against the real git history version before being written down
    here, not hand-computed). Only 3 of 8 tasks have one: `botnet_intel_build`,
    `feed_reader_build`, `minecraft_admin_build` — each because the specific function tested is
    pure and dependency-free (no network, no DB, no vendor library). `doc_to_markdown_build` is
    explicitly NOT among them despite S6.8's own text calling it fixture-testable: the real
    substance of that build (`pdf_to_markdown`/`docx_to_markdown`) needs `pymupdf4llm`/
    `python-docx`, and neither is installed on this dev machine (checked, not assumed) — scored
    judge-only instead, a real environment constraint, not a design reversal.
  * `judge` — an independent judge model (never the role under test, S8.7) compares the model's
    response against the requirement and a real reference excerpt, explicitly instructed NOT to
    penalize a textual or design difference from the real implementation — "there is more than
    one reasonable way to build a feed reader" is S6.8's own stated reason, and partial credit is
    expected, not collapsed to a binary. Runs for all 8 tasks when `--judge-endpoint` is given;
    falls back to `"unjudged"` otherwise, never guessed.

`[RISK]`, named plainly, same one S6.7/S6.8 both already name: if this repo (or HermesAgentRedo)
is public, a candidate could have memorized these builds from training data. Unverified as of this
writing.

Always direct-to-backend (S8.1) for both the role under test and the judge.

Usage:
  hermes-coder-build-eval.py --endpoint http://127.0.0.1:8094/v1 \\
      [--judge-endpoint URL] [--judge-model judge] [--model-id "coder (live)"] \\
      [--task TASK_ID] [--json out.json]
"""
import argparse
import importlib.util
import json
import re
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import hermes_benchmark_common as bc  # noqa: E402


def log(msg):
    print(f"[hermes-coder-build-eval] {msg}", flush=True)


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

REPO_PATHS = {"this": Path(__file__).resolve().parent.parent,
              "HermesAgentRedo": Path(__file__).resolve().parent.parent.parent / "HermesAgentRedo"}


def real_reference(task):
    """The real post-build file, for the judge's reference only -- never shown to the model
    under test. Truncated to a representative excerpt for the very large files (S6.7's own
    anchor mechanism isn't needed here since there's no pre-fix file to align against -- a
    build task's reference is just "the real finished file," read once)."""
    import subprocess
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


def call_backend(endpoint, model, messages, max_tokens=4000, timeout=180):
    body = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(f"{endpoint.rstrip('/')}/chat/completions", data=body,
                                  method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    return data["choices"][0]["message"]["content"].strip()


def build_prompt(path, requirement, has_fixture):
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
        {"role": "system", "content": (
            "You are building a new capability for a real, running fleet of tools/services, from "
            "a plain statement of why it's needed. You are not told how to build it." + fixture_note)},
        {"role": "user", "content": f"File this would live in: {path}\n\nRequirement: {requirement}"},
    ]


def main():
    ap = argparse.ArgumentParser(description="S39 fleet_coder_build: score a coder role's "
                                              "from-scratch build against a real requirement")
    ap.add_argument("--endpoint", required=True,
                     help="the coder role's own backend URL directly, bypassing the router (S8.1)")
    ap.add_argument("--judge-endpoint", default=None,
                     help="an independent judge model's backend URL (never the role under test, "
                          "S8.7) -- without it, the judge axis is reported as unjudged")
    ap.add_argument("--judge-model", default="judge")
    ap.add_argument("--model", default="coder")
    ap.add_argument("--model-id", default="coder (live)")
    ap.add_argument("--task", default=None, help="score only this task id")
    ap.add_argument("--json", help="write per-task rows here")
    args = ap.parse_args()

    tasks = [t for t in TASKS if t["id"] == args.task] if args.task else TASKS
    log(f"{len(tasks)} task(s) against {args.endpoint}"
        + (f", judge at {args.judge_endpoint}" if args.judge_endpoint else " (no judge: judge axis unjudged)"))

    rows = []
    for task in tasks:
        has_fixture = task["fixture"] is not None
        try:
            raw = call_backend(args.endpoint, args.model,
                                build_prompt(task["path"], task["requirement"], has_fixture))
            response_text = strip_code_fence(raw)
        except (urllib.error.URLError, OSError, KeyError, IndexError) as exc:
            log(f"[{task['id']}] call failed: {exc}")
            rows.append({"task": task["id"], "status": "error", "detail": str(exc)})
            continue

        row = {"task": task["id"], "has_fixture": has_fixture, "response": response_text}

        if has_fixture:
            try:
                mod = load_code(response_text, module_name=f"_build_{task['id']}")
                task["fixture"](mod)
                row["fixture"] = {"status": "pass"}
            except AssertionError as exc:
                row["fixture"] = {"status": "fail", "detail": str(exc)}
            except Exception as exc:
                row["fixture"] = {"status": "fail", "detail": f"{type(exc).__name__}: {exc}"}

        if args.judge_endpoint:
            try:
                real_excerpt = real_reference(task)
                judge_reply = call_backend(args.judge_endpoint, args.judge_model,
                                            judge_prompt(task["requirement"], response_text, real_excerpt))
                row["judge"] = parse_judge_verdict(judge_reply)
            except (urllib.error.URLError, OSError, KeyError, IndexError, RuntimeError) as exc:
                log(f"  [{task['id']}] judge call failed: {exc}")
                row["judge"] = "unclear"
        else:
            row["judge"] = "unjudged"

        log(f"[{task['id']:<24}] fixture={row.get('fixture', {}).get('status', '-'):<8} judge={row['judge']}")
        rows.append(row)

    fixture_rows = [r for r in rows if r.get("fixture", {}).get("status") in ("pass", "fail")]
    fixture_rate = (sum(1 for r in fixture_rows if r["fixture"]["status"] == "pass") / len(fixture_rows)
                     ) if fixture_rows else None
    judge_rows = [r for r in rows if r.get("judge") in ("pass", "fail")]
    judge_rate = (sum(1 for r in judge_rows if r["judge"] == "pass") / len(judge_rows)
                   ) if judge_rows else None

    print("\n=== fleet_coder_build ===")
    if fixture_rate is not None:
        print(f"  fixture: {sum(1 for r in fixture_rows if r['fixture']['status']=='pass')}/{len(fixture_rows)} = {fixture_rate:.3f}")
    if judge_rate is not None:
        print(f"  judge:   {sum(1 for r in judge_rows if r['judge']=='pass')}/{len(judge_rows)} = {judge_rate:.3f}")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        log(f"per-task rows written to {args.json}")

    # S8.6: the two tiers are never blended into one number -- same rule, same shape as
    # fleet_coder_fix's own suites. No bare fleet_coder_build key for that reason.
    suites = {}
    if fixture_rate is not None:
        suites["fleet_coder_build_fixture"] = {"metric": "pass_rate", "value": fixture_rate,
                                                "limit": len(fixture_rows)}
    if judge_rate is not None:
        suites["fleet_coder_build_judge"] = {"metric": "pass_rate", "value": judge_rate,
                                              "limit": len(judge_rows)}
    if suites:
        try:
            bc.append_entry({
                "date": datetime.now(timezone.utc).isoformat(),
                "lm_eval_version": None, "bfcl_version": None, "swebench_version": None,
                "model_id": args.model_id, "role_or_endpoint": args.model, "endpoint": args.endpoint,
                "bfcl_model_name": None, "notes": "",
                "suites": suites,
            })
        except Exception as exc:
            log(f"shared history write failed (the report above is unaffected): {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
