#!/usr/bin/env python3
# Version: 1.0.0
#
# Initial version (2026-10-23) — S39 Phase C (FLEET_BENCHMARK_DESIGN.md S6.7), after S39a's
# sign-off. New tool. 10 real-commit tasks (9 commits — one, b4651ca, contributes two distinct
# symptom-tasks, matching the design table's own 10-row listing), two scoring tiers never blended
# (S8.6), 1 of 10 tasks has a real executable repro test from this session; the other 9 are
# scored judge-only, 4 of them because this dev machine has no `node` binary at all (not just no
# live fleet access) to execute a JS repro, stated plainly below. 31 offline checks
# (infra/model-benchmark/tests/test_coder_fix.py).
"""
hermes-coder-fix-eval.py — S39 Phase C's fleet_coder_fix suite, closing FLEET_BENCHMARK_DESIGN.md
gap 7 (S6.7), after S39a's sign-off (2026-10-22). Given the REAL pre-fix state of a real file from
this fleet's own history and a symptom-only description of what broke (never the diagnosis, never
the fix), does a coder-role candidate produce a patch that actually addresses it?

GROUND TRUTH (S8.6): all 9 real commits S6.7's own table names, confirmed reachable by ordinary
`git log` directly in THIS repo — the cross-repo HermesAgentV4/HermesAgentRedo mining S6.7 flagged
as possibly necessary turned out not to be needed for this particular nine; every commit here is
local. b4651ca contributes two distinct symptom-tasks (the table itself lists it twice, for its two
independent root causes), giving 10 scored tasks from 9 commits. One correction found while
building this, not assumed: S6.7's own table lists `services/minecraft-bots/actions.js` as the
source for the `enchantments.concat` fix (35df5ec) — the real fix is in `equipment.js`
(`installEnchantsFix`), not `actions.js`; that commit touches both files, and the table named the
wrong one.

PROMPT CONSTRUCTION: the model is shown the REAL pre-fix file content (`git show <hash>^:<path>`,
never retyped) at one or more fixed line-range excerpts (hand-picked per task from this commit's
own real diff hunks, since several of these files run 1,000-7,800 lines and showing the whole file
isn't practical) plus the symptom-only report, and asked to return the corrected version of just
that excerpt. The real post-fix excerpt (`git show <hash>:<path>`) is held back from the model and
shown only to the judge.

TWO SCORING TIERS, NEVER BLENDED (S8.6, S6.7's own rule) — recorded as two separate suite keys,
never combined into one number:
  * `repro` — a real, executable behavioral test: the model's returned excerpt is substituted
    into the real pre-fix file, the reconstructed file is imported, and a repro scenario built
    from the real bug's own description is run against it. Only ONE of the 10 tasks
    (`reolink_ai_state`) is actually executable from this session: it is pure Python, and the
    functions involved (`camera_login`/`check_ai_detection`) take a duck-typed `host_obj`
    parameter, so a fake object satisfies them with zero dependency on the real (and unavailable)
    `reolink_aio` package. The other 4 tasks this design calls "repro-testable in principle"
    (`recipes_table_check`, `recipes_recycling_recipe`, `enchantments_concat`, `bed_words_routing`)
    are all JavaScript, and this dev machine has no `node` binary anywhere on it — confirmed by
    checking, not assumed — so their repro axis reports `"env_unavailable"`, a distinct, honest
    status never blended into a pass/fail rate, rather than silently skipped or faked.
  * `judge` — an independent judge model (never the role under test, S8.7) compares the model's
    returned excerpt against the real post-fix excerpt and the symptom, on the exact rubric S6.7
    states: root cause addressed, behavior-equivalent, no obvious new bug introduced — explicitly
    told NOT to penalize a textual difference from the real fix, since there is more than one
    correct patch. Runs for all 10 tasks when `--judge-endpoint` is given; falls back to
    `"unjudged"` otherwise, never guessed.

`[RISK]`, named plainly, not glossed over, same one S6.7 itself names: if this repo is public,
a candidate could have memorized these exact fixes from training data. Unverified as of this
writing.

Always direct-to-backend (S8.1) for both the role under test and the judge.

Usage:
  hermes-coder-fix-eval.py --endpoint http://127.0.0.1:8094/v1 \\
      [--judge-endpoint URL] [--judge-model judge] [--model-id "coder (live)"] \\
      [--task TASK_ID] [--json out.json]
"""
import argparse
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
sys.path.insert(0, str(TOOLS))
import hermes_benchmark_common as bc  # noqa: E402


def log(msg):
    print(f"[hermes-coder-fix-eval] {msg}", flush=True)


# ── git-backed real file retrieval (S8.5: real production code, never retyped) ─────────────────

def git_show(ref):
    result = subprocess.run(["git", "show", ref], cwd=REPO, capture_output=True, text=True,
                             encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"git show {ref!r} failed: {result.stderr.strip()}")
    return result.stdout


def file_at(commit_hash, path, pre_fix=False):
    ref = f"{commit_hash}^:{path}" if pre_fix else f"{commit_hash}:{path}"
    return git_show(ref)


def find_anchor_line(text, anchor):
    """1-indexed line number of the LAST line containing `anchor`. Anchors are real, stable
    substrings (a function signature, a distinctive string) present in BOTH the pre-fix and
    post-fix file -- resolving them fresh against whichever version is passed in is what keeps
    the pre-fix and post-fix excerpts aligned to the same real code even though every commit here
    inserts lines earlier in the file (a growing version-header comment, new functions), which
    shifts absolute line numbers between the two versions. Found by testing, not assumed: a first
    version of this harness used one fixed (start, end) pair for both versions and it quietly
    sliced the WRONG lines out of the post-fix file. The LAST match, not the first, is used for a
    second reason also found by testing: this project's own versioning convention writes a prose
    description of each fix into the file's own top-of-file header comment, which routinely
    quotes the exact variable/function names involved (e.g. "tableWouldHelp was always false") --
    the first occurrence of several of this suite's anchors was that header prose, not the real
    code, always physically earlier in the file than any of this suite's real target functions."""
    matches = [i for i, line in enumerate(text.splitlines(), start=1) if anchor in line]
    if not matches:
        raise RuntimeError(f"anchor {anchor!r} not found in this version of the file")
    return matches[-1]


def extract_regions(text, anchor_specs):
    """anchor_specs: [(anchor_substring, lines_before, lines_after), ...]. Returns the excerpt
    string (with a line-number header per region and an omission marker between non-adjacent
    regions) and the (start, end) 1-indexed regions actually used, clamped to the file's length."""
    lines = text.splitlines()
    n = len(lines)
    clamped = []
    for anchor, before, after in anchor_specs:
        anchor_line = find_anchor_line(text, anchor)
        clamped.append((max(1, anchor_line - before), min(n, anchor_line + after)))
    parts = []
    for i, (s, e) in enumerate(clamped):
        if i > 0:
            parts.append("... (unchanged code omitted) ...\n")
        parts.append(f"--- lines {s}-{e} of {n} ---\n")
        parts.append("\n".join(lines[s - 1:e]))
        parts.append("\n")
    return "".join(parts), clamped


def strip_code_fence(text):
    """Strips a markdown code fence if the model wrapped its answer in one -- and ONLY that.
    Found by testing, not assumed: an earlier version called text.strip() first, which silently
    ate the first line's own leading indentation (meaningful in Python) whenever the model's
    answer had no fence at all, corrupting substitute_region()'s reconstruction every time."""
    m = re.match(r"^\s*```[a-zA-Z0-9_+-]*\n(.*?)\n```\s*$", text, re.DOTALL)
    return m.group(1) if m else text


def substitute_region(pre_fix_text, region, replacement_text):
    """Only used for the one task this session can actually execute (reolink_ai_state) --
    reconstructs a complete file by swapping one line range for the model's returned excerpt."""
    lines = pre_fix_text.splitlines()
    s, e = region
    new_lines = lines[:s - 1] + replacement_text.splitlines() + lines[e:]
    return "\n".join(new_lines) + "\n"


# ── the one real executable repro test (reolink_ai_state) ──────────────────────────────────────

class _FakeReolinkHost:
    """Duck-typed stand-in for reolink_aio's Host -- camera_login()/check_ai_detection() only ever
    call methods on whatever object they're given, so this needs zero dependency on the real
    (and, on this dev machine, unavailable) reolink_aio package. Mirrors the real bug's own
    documented cause exactly: get_ai_state() returns None for any channel get_host_data() hasn't
    registered, which login() alone never does."""
    def __init__(self):
        self.registered = False

    async def login(self):
        pass

    async def get_host_data(self):
        self.registered = True

    async def get_ai_state(self, channel):
        return {"people": True, "vehicle": False, "dog_cat": False} if self.registered else None


async def _repro_reolink_ai_state(mod):
    host = _FakeReolinkHost()
    await mod.camera_login(host)
    assert host.registered, ("camera_login() must register the channel (call get_host_data()) so "
                              "get_ai_state() stops returning None")
    never_registered = _FakeReolinkHost()
    await mod.check_ai_detection(never_registered, 0)  # must not raise on a None state


def run_python_repro(full_file_text, repro_coro_fn):
    """Writes the reconstructed candidate file to a temp module and runs the real repro scenario
    against it. A syntactically broken patch fails the repro -- that is correct, not a harness
    bug: an unparseable patch is a wrong patch."""
    import asyncio
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".py", prefix="hermes-coder-fix-", mode="w",
                                      delete=False, encoding="utf-8") as tmp:
        tmp.write(full_file_text)
        tmp_path = Path(tmp.name)
    try:
        spec = importlib.util.spec_from_file_location("_candidate", tmp_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        asyncio.run(repro_coro_fn(mod))
        return {"status": "pass"}
    except AssertionError as exc:
        return {"status": "fail", "detail": str(exc)}
    except Exception as exc:
        return {"status": "fail", "detail": f"{type(exc).__name__}: {exc}"}
    finally:
        tmp_path.unlink(missing_ok=True)


# ── the 10 tasks (9 real commits; b4651ca contributes 2 symptom-tasks, per S6.7's own table) ───

TASKS = [
    {"id": "reolink_ai_state", "hash": "31e4bd4", "path": "tools/hermes-reolink.py",
     "lang": "python", "tier": "repro",
     "regions": [("async def camera_login", 5, 160)],
     "repro": _repro_reolink_ai_state,
     "symptom": ("The AI-detection poll loop for the home security camera never reports a "
                 "detection -- motion/person/vehicle events are not alerting, even though the "
                 "camera is online, logged in, and the poll loop itself runs continuously "
                 "without crashing or logging any error.")},

    {"id": "reolink_multicam", "hash": "f42264d", "path": "tools/hermes-reolink.py",
     "lang": "python", "tier": "judge",
     "regions": [("def load_camera_config", 5, 50), ("async def camera_ai_state", 5, 135)],
     "symptom": ("Previously this camera specialist supported exactly one Reolink camera via a "
                 "single configured channel number. A Reolink Home Hub has now been purchased "
                 "and three cameras are paired to it. Update the specialist so it: (1) polls "
                 "AI-detection across every one of the newly added cameras each cycle, not just "
                 "one, off one shared Hub login; and (2) resolves an on-demand chat request like "
                 "'check the camera' to whichever camera(s) are named in the request (by name), "
                 "or to all configured cameras combined if none is named.")},

    {"id": "podcast_feed_discovery", "hash": "c5e2714", "path": "tools/hermes-podcast-retriever.py",
     "lang": "python", "tier": "judge",
     "regions": [("SHOWS = {", 15, 130), ("def fetch_sn_remote_listing", 10, 115)],
     "symptom": ("This podcast-retriever tool currently finds each show's episode audio URL by "
                 "probing/guessing a set of URL patterns against the show's page. For shows "
                 "published by Club TWiT, prefer discovering the real audio URL via Club TWiT's "
                 "own memberfulcontent.com RSS feeds instead, since real feeds are available for "
                 "these shows and are more reliable than probing. Also add a new show ('TWiT') "
                 "to the retriever's roster, and for the existing Security Now show, fall back "
                 "to a gap-filling source when the primary source is missing an episode.")},

    {"id": "recipes_table_check", "hash": "08f950b", "path": "services/minecraft-bots/actions.js",
     "lang": "js", "tier": "repro",
     "regions": [("tableWouldHelp", 30, 30)],
     "symptom": ("A bot repeatedly reports it can't craft a requested item because it lacks a "
                 "crafting table -- even while standing right next to one, and even though it "
                 "has enough wood on hand to make a new one if that were actually needed. It "
                 "never attempts to search for or make a table on its own. Live evidence: a "
                 "'craft wooden_pickaxe' request fails in 78 milliseconds -- far too fast to "
                 "have pathfound anywhere or placed a block -- landing immediately on a generic "
                 "'might need a crafting table' message, every time, regardless of what's "
                 "actually in the bot's inventory at the moment.")},

    {"id": "recipes_recycling_recipe", "hash": "f8d6986", "path": "services/minecraft-bots/actions.js",
     "lang": "js", "tier": "repro",
     "regions": [("noTableRecipes", 25, 35)],
     "symptom": ("After a previous fix to the crafting-table detection above, crafting a colored "
                 "bed (e.g. red_bed) from wool and planks at a real crafting table still fails "
                 "instantly (about 150 milliseconds) with the same 'might need a crafting table' "
                 "message -- even though a table is right there and the bot already has the "
                 "wool and planks it needs.")},

    {"id": "enchantments_concat", "hash": "35df5ec", "path": "services/minecraft-bots/equipment.js",
     "lang": "js", "tier": "repro",
     "regions": [("export function hasWeapon", 90, 90)],
     "symptom": ("Every bot holding an enchanted item (sword, pickaxe, etc.) fails to dig or "
                 "break any block, throwing the error 'enchantments.concat is not a function'. "
                 "This happens on essentially every dig attempt once a bot has been given "
                 "enchanted gear, and never happens while holding unenchanted gear.")},

    {"id": "bed_shelter_multipart", "hash": "3be33e4", "path": "services/minecraft-bots/actions.js",
     "lang": "js", "tier": "judge",
     "regions": [("export function bedItemFor", 5, 140),
                 ("couldn't get home to place the bed", 5, 135)],
     "symptom": ("Over an 8-hour live period across the fleet: only 1 bed total got placed; 35 "
                 "separate 'build a bed' goals were started and abandoned; 78 crafting attempts "
                 "failed for lack of wood; and 23 bed-placement attempts were refused by the "
                 "server. Bots are not reliably getting themselves a bed, are not gathering "
                 "wood first when a bed goal actually needs it, and the shelters bots build do "
                 "not actually have room for a bed inside them.")},

    {"id": "bed_words_routing", "hash": "c7c984d", "path": "services/minecraft-bots/index.js",
     "lang": "js", "tier": "repro",
     "regions": [("const TOOL_WORDS", 10, 410)],
     "symptom": ("After the latest world reset, 24 hours of behavior logs show three bots given "
                 "a 'build a shelter' directive are instead repeatedly trying to place a bare "
                 "bed out in the open, never building an actual enclosed room -- even though the "
                 "directive's own wording says 'shelter' first. Over that period those three "
                 "bots logged 313 bed-goal attempts combined and zero shelter-goal attempts, "
                 "despite the standing instruction being specifically about building a shelter.")},

    {"id": "mesh_stl_gaps", "hash": "b4651ca", "path": "tools/hermes-mesh-repair.py",
     "lang": "python", "tier": "judge",
     "regions": [("def to_manifold", 5, 75)],
     "symptom": ("A generated 3D-printable model passes every automated validity check this "
                 "pipeline runs (watertight, manifold, consistent winding, single shell), but "
                 "the slicer preview shows real gaps in the walls that would stop a print "
                 "partway through. Measured on a real failing case: the mesh's actual solid "
                 "material is only 1.46% of its own bounding-box volume, with wall thickness "
                 "around 0.35mm against a 0.8mm two-perimeter minimum needed to print at all.")},

    {"id": "mesh_self_intersections", "hash": "b4651ca", "path": "tools/hermes-mesh-repair.py",
     "lang": "python", "tier": "judge",
     "regions": [("def stl_clean", 5, 125)],
     "symptom": ("After a mesh-simplification/decimation step runs (reducing triangle count for "
                 "a smaller, faster-to-print file), the output model has thousands of real "
                 "self-intersecting faces (measured: 4,418) that were NOT present in the mesh "
                 "before decimation ran, even though decimation is only supposed to reduce "
                 "triangle count, not introduce new topological defects.")},
]


# ── judge path (universal; never the role under test, S8.7) ────────────────────────────────────

JUDGE_SYSTEM_PROMPT = (
    "You are grading one proposed code patch against the real fix for the same reported bug, "
    "which you are shown for reference. You are not the model that wrote the patch. Grade only on "
    "this rubric: (1) does the patch address the same root cause as the real fix, not just paper "
    "over the symptom; (2) is the patch behavior-equivalent to the real fix for the reported "
    "symptom; (3) does the patch avoid introducing an obvious new bug. Do NOT penalize the patch "
    "for being textually different from the real fix -- there is more than one correct way to fix "
    "a real bug, and matching the real diff's exact wording is not the standard. Reply with "
    "exactly PASS or FAIL on the first line, then one short sentence of why."
)


def judge_prompt(symptom, patch_text, real_fix_excerpt):
    return [
        {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
        {"role": "user", "content": f"Reported symptom: {symptom}\n\n"
                                     f"Proposed patch (the excerpt the candidate returned):\n"
                                     f"{patch_text}\n\n"
                                     f"The real fix, for reference only (the candidate never saw "
                                     f"this):\n{real_fix_excerpt}"},
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


def fix_prompt(path, symptom, excerpt):
    return [
        {"role": "system", "content": (
            "You are fixing a reported bug in a real file from this fleet's own tools/services. "
            "You are given the symptom only -- never the diagnosis, never the fix. Return ONLY "
            "the corrected version of the shown excerpt, preserving its line range and "
            "surrounding structure/indentation exactly; no explanation, no markdown code fences.")},
        {"role": "user", "content": f"File: {path}\n\nSymptom: {symptom}\n\n"
                                     f"Current content:\n{excerpt}"},
    ]


def main():
    ap = argparse.ArgumentParser(description="S39 fleet_coder_fix: score a coder role's patch "
                                              "against a real reported bug's real fix")
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
    node_available = shutil.which("node") is not None
    log(f"{len(tasks)} task(s) against {args.endpoint}"
        + (f", judge at {args.judge_endpoint}" if args.judge_endpoint else " (no judge: judge axis unjudged)")
        + (", node available" if node_available else ", NO node binary found on this machine"))

    rows = []
    for task in tasks:
        try:
            pre_fix_full = file_at(task["hash"], task["path"], pre_fix=True)
        except RuntimeError as exc:
            log(f"[{task['id']}] could not read pre-fix file: {exc}")
            rows.append({"task": task["id"], "status": "error", "detail": str(exc)})
            continue
        excerpt, regions = extract_regions(pre_fix_full, task["regions"])

        try:
            raw = call_backend(args.endpoint, args.model, fix_prompt(task["path"], task["symptom"], excerpt))
            patch_text = strip_code_fence(raw)
        except (urllib.error.URLError, OSError, KeyError, IndexError) as exc:
            log(f"[{task['id']}] call failed: {exc}")
            rows.append({"task": task["id"], "status": "error", "detail": str(exc)})
            continue

        row = {"task": task["id"], "tier": task["tier"], "lang": task["lang"],
               "patch": patch_text}

        # repro axis -- only ever attempted for tier=="repro" tasks
        if task["tier"] == "repro":
            if task["lang"] == "python":
                full_candidate = substitute_region(pre_fix_full, regions[0], patch_text)
                row["repro"] = run_python_repro(full_candidate, task["repro"])
            elif task["lang"] == "js":
                # No JS repro runner exists yet, regardless of node's presence: writing one that
                # this session cannot execute and verify would risk shipping it subtly broken
                # while looking done. node_available is recorded anyway so a future session knows
                # whether writing+verifying one is unblocked or still needs a different machine.
                row["repro"] = {"status": "env_unavailable",
                                "detail": f"no JS repro runner is wired up yet (node "
                                          f"{'is' if node_available else 'is NOT'} available on "
                                          f"this machine)"}

        # judge axis -- universal, every task, when a judge endpoint is given
        if args.judge_endpoint:
            try:
                real_fix_full = file_at(task["hash"], task["path"], pre_fix=False)
                real_excerpt, _ = extract_regions(real_fix_full, task["regions"])
                judge_reply = call_backend(args.judge_endpoint, args.judge_model,
                                            judge_prompt(task["symptom"], patch_text, real_excerpt))
                row["judge"] = parse_judge_verdict(judge_reply)
            except (urllib.error.URLError, OSError, KeyError, IndexError, RuntimeError) as exc:
                log(f"  [{task['id']}] judge call failed: {exc}")
                row["judge"] = "unclear"
        else:
            row["judge"] = "unjudged"

        log(f"[{task['id']:<24}] tier={task['tier']:<6} repro={row.get('repro', {}).get('status', '-'):<15} judge={row['judge']}")
        rows.append(row)

    repro_rows = [r for r in rows if r.get("repro", {}).get("status") in ("pass", "fail")]
    repro_rate = (sum(1 for r in repro_rows if r["repro"]["status"] == "pass") / len(repro_rows)
                   ) if repro_rows else None
    judge_rows = [r for r in rows if r.get("judge") in ("pass", "fail")]
    judge_rate = (sum(1 for r in judge_rows if r["judge"] == "pass") / len(judge_rows)
                   ) if judge_rows else None
    env_unavailable_n = sum(1 for r in rows if r.get("repro", {}).get("status") == "env_unavailable")

    print("\n=== fleet_coder_fix ===")
    if repro_rate is not None:
        print(f"  repro (executable): {sum(1 for r in repro_rows if r['repro']['status']=='pass')}/{len(repro_rows)} = {repro_rate:.3f}")
    if judge_rate is not None:
        print(f"  judge:               {sum(1 for r in judge_rows if r['judge']=='pass')}/{len(judge_rows)} = {judge_rate:.3f}")
    if env_unavailable_n:
        print(f"  env_unavailable:     {env_unavailable_n} task(s) -- repro axis not attempted, judge axis still scored above")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        log(f"per-task rows written to {args.json}")

    # S8.6: the two tiers are never blended into one number. No bare fleet_coder_fix key is
    # written here for that reason -- fleet_coder_fix_judge is the closest thing to "overall"
    # (it covers every task), fleet_coder_fix_repro is the smaller gold-standard subset.
    suites = {}
    if repro_rate is not None:
        suites["fleet_coder_fix_repro"] = {"metric": "pass_rate", "value": repro_rate,
                                            "limit": len(repro_rows)}
    if judge_rate is not None:
        suites["fleet_coder_fix_judge"] = {"metric": "pass_rate", "value": judge_rate,
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
