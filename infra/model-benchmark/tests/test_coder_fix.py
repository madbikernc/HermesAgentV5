#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S39 Phase C's fleet_coder_fix suite (FLEET_BENCHMARK_DESIGN.md S6.7, closes
# gap 7, after S39a's sign-off 2026-10-22). No network, no live coder/judge backend, no `node`
# (confirmed absent on this dev machine): every check below either calls the pure
# region-extraction/substitution helpers directly against REAL git history (this repo's own,
# already on disk -- no network needed for `git show`), runs the one real executable repro test
# against the real pre-fix and post-fix file content, or monkeypatches call_backend() so main()'s
# own end-to-end path runs with zero real HTTP calls.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * every one of the 10 tasks' (hash, path, anchor) triples resolves against REAL git history,
#     in both the pre-fix and post-fix version of the file
#   * find_anchor_line() finds the LAST match, not the first -- this project's own versioning
#     convention quotes a fix's own variable/function names in its file-header prose, which would
#     otherwise be matched as "the real code" and give a wildly wrong excerpt
#   * the one executable repro (reolink_ai_state): the REAL pre-fix file fails it, the REAL
#     post-fix file passes it, and a full reconstruct-via-substitution round trip (real post-fix
#     excerpt spliced into the real pre-fix file) also passes -- proving substitution produces
#     syntactically valid, behaviorally correct Python, not just a plausible-looking string
#   * strip_code_fence() does not corrupt leading indentation on an unfenced answer (a real bug
#     found while building this: an early version called text.strip() first and silently ate the
#     first line's own indentation, corrupting every substitution)
#   * main()'s end-to-end path: a perfect model scores 1.0/1.0 on both axes, a no-op model scores
#     0.0/0.0, the two tiers are never blended into one key, and a failed call for the one
#     repro-capable task leaves fleet_coder_fix_repro entirely absent (never faked) while judge
#     still scores the surviving 9 tasks
#
# Run: python3 infra/model-benchmark/tests/test_coder_fix.py
import importlib.util
import json
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
    spec = importlib.util.spec_from_file_location("hermes_coder_fix_eval",
                                                    TOOLS / "hermes-coder-fix-eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load()

    print("\n[TASKS: all 10 tasks resolve against REAL git history, pre-fix AND post-fix]")
    check("10 tasks total (9 commits; b4651ca contributes 2, per S6.7's own table)",
          len(mod.TASKS) == 10, str(len(mod.TASKS)))
    for task in mod.TASKS:
        try:
            pre = mod.file_at(task["hash"], task["path"], pre_fix=True)
            post = mod.file_at(task["hash"], task["path"], pre_fix=False)
            pre_excerpt, pre_regions = mod.extract_regions(pre, task["regions"])
            post_excerpt, post_regions = mod.extract_regions(post, task["regions"])
            check(f"[{task['id']}] pre-fix and post-fix excerpts both resolve",
                  bool(pre_excerpt) and bool(post_excerpt))
        except RuntimeError as exc:
            check(f"[{task['id']}] resolves against real git history", False, str(exc))

    print("\n[find_anchor_line(): last match, not first -- skips this project's own header prose]")
    post_text = mod.file_at("f8d6986", "services/minecraft-bots/actions.js", pre_fix=False)
    anchor_line = mod.find_anchor_line(post_text, "tableWouldHelp")
    first_line = next(i for i, l in enumerate(post_text.splitlines(), 1) if "tableWouldHelp" in l)
    check("'tableWouldHelp' appears in this file's own header-comment prose too (the real hazard)",
          first_line < 10, str(first_line))
    check("find_anchor_line() returns the LAST match (the real code), not the header prose",
          anchor_line > 3000, str(anchor_line))

    print("\n[the one executable repro: real pre-fix fails it, real post-fix passes it]")
    t = [x for x in mod.TASKS if x["id"] == "reolink_ai_state"][0]
    pre = mod.file_at(t["hash"], t["path"], pre_fix=True)
    post = mod.file_at(t["hash"], t["path"], pre_fix=False)
    pre_result = mod.run_python_repro(pre, t["repro"])
    post_result = mod.run_python_repro(post, t["repro"])
    check("the REAL pre-fix file fails its own repro", pre_result["status"] == "fail", str(pre_result))
    check("the REAL post-fix file passes the repro", post_result["status"] == "pass", str(post_result))

    print("\n[substitute_region(): a real post-fix excerpt spliced into the real pre-fix file round-trips]")
    pre_excerpt, pre_regions = mod.extract_regions(pre, t["regions"])
    post_excerpt, _ = mod.extract_regions(post, t["regions"])
    real_fix_text = "\n".join(post_excerpt.splitlines()[1:])
    reconstructed = mod.substitute_region(pre, pre_regions[0], real_fix_text)
    reconstructed_result = mod.run_python_repro(reconstructed, t["repro"])
    check("splicing the real fix's excerpt into the real pre-fix file passes the repro",
          reconstructed_result["status"] == "pass", str(reconstructed_result))
    noop_text = "\n".join(pre_excerpt.splitlines()[1:])
    noop_reconstructed = mod.substitute_region(pre, pre_regions[0], noop_text)
    noop_result = mod.run_python_repro(noop_reconstructed, t["repro"])
    check("splicing a no-op (unchanged) excerpt back in still fails the repro",
          noop_result["status"] == "fail", str(noop_result))

    print("\n[strip_code_fence(): does not corrupt an unfenced answer's own leading indentation]")
    indented = "        return False\n\n\nasync def camera_login(host_obj):\n    pass\n"
    check("an unfenced answer passes through completely unchanged, indentation intact",
          mod.strip_code_fence(indented) == indented, repr(mod.strip_code_fence(indented)))
    fenced = "```python\n    return True\n```"
    check("a fenced answer has the fence stripped, inner indentation preserved",
          mod.strip_code_fence(fenced) == "    return True")

    print("\n[main(): end-to-end, a perfect model scores 1.0/1.0 on both axes, never blended]")
    def perfect_coder(endpoint, model, messages, max_tokens=4000, timeout=180):
        user = messages[1]["content"]
        for task in mod.TASKS:
            if task["path"] in user and task["symptom"][:40] in user:
                real_post = mod.file_at(task["hash"], task["path"], pre_fix=False)
                real_excerpt, _ = mod.extract_regions(real_post, task["regions"])
                return "\n".join(real_excerpt.splitlines()[1:])
        return "UNMATCHED"

    def perfect_judge(endpoint, model, messages, max_tokens=4000, timeout=120):
        return "PASS\nAddresses the real root cause."

    def dispatch_good(endpoint, model, messages, max_tokens=4000, timeout=180):
        if endpoint == "http://fake-coder:1/v1":
            return perfect_coder(endpoint, model, messages, max_tokens, timeout)
        return perfect_judge(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = dispatch_good

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-coder-fix-eval.py", "--endpoint", "http://fake-coder:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1", "--model-id", "test-coder"]
        rc = mod.main()
        check("main() returns 0", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        check("exactly one history entry written", len(entries) == 1, str(entries))
        suites = entries[0]["suites"]
        check("fleet_coder_fix_repro is 1.0 (the one executable task, a perfect patch)",
              suites.get("fleet_coder_fix_repro", {}).get("value") == 1.0, str(suites))
        check("fleet_coder_fix_repro's limit is 1 (only reolink_ai_state is executable here)",
              suites.get("fleet_coder_fix_repro", {}).get("limit") == 1, str(suites))
        check("fleet_coder_fix_judge is 1.0 across all 10 tasks",
              suites.get("fleet_coder_fix_judge", {}).get("value") == 1.0
              and suites.get("fleet_coder_fix_judge", {}).get("limit") == 10, str(suites))
        check("no bare fleet_coder_fix key -- the two tiers are never blended (S8.6)",
              "fleet_coder_fix" not in suites, str(suites))

    print("\n[main(): a no-op model scores 0.0/0.0 on both axes]")
    def noop_coder(endpoint, model, messages, max_tokens=4000, timeout=180):
        user = messages[1]["content"]
        idx = user.index("Current content:\n") + len("Current content:\n")
        excerpt = user[idx:]
        return "\n".join(excerpt.splitlines()[1:])

    def failing_judge(endpoint, model, messages, max_tokens=4000, timeout=120):
        return "FAIL\nDoes not address the root cause."

    def dispatch_bad(endpoint, model, messages, max_tokens=4000, timeout=180):
        if endpoint == "http://fake-coder:1/v1":
            return noop_coder(endpoint, model, messages, max_tokens, timeout)
        return failing_judge(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = dispatch_bad

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-coder-fix-eval.py", "--endpoint", "http://fake-coder:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1"]
        rc = mod.main()
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        suites = entries[0]["suites"]
        check("fleet_coder_fix_repro is 0.0 for a no-op patch",
              suites.get("fleet_coder_fix_repro", {}).get("value") == 0.0, str(suites))
        check("fleet_coder_fix_judge is 0.0 when the judge fails every patch",
              suites.get("fleet_coder_fix_judge", {}).get("value") == 0.0, str(suites))

    print("\n[main(): the repro-capable task's call fails -> fleet_coder_fix_repro is absent, not faked]")
    calls = {"n": 0}
    def flaky_coder(endpoint, model, messages, max_tokens=4000, timeout=180):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection refused")
        return noop_coder(endpoint, model, messages, max_tokens, timeout)
    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: (
        flaky_coder(endpoint, model, messages, max_tokens, timeout) if endpoint == "http://fake-coder:1/v1"
        else "PASS\nok")

    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-coder-fix-eval.py", "--endpoint", "http://fake-coder:1/v1",
                    "--judge-endpoint", "http://fake-judge:1/v1"]
        rc = mod.main()
        check("main() still returns 0 despite the one repro-capable task's call failing", rc == 0)
        entries = [json.loads(l) for l in mod.bc.LOCAL_HISTORY_PATH.read_text().splitlines() if l.strip()]
        suites = entries[0]["suites"] if entries else {}
        check("fleet_coder_fix_repro is absent (its only task failed to call) -- never faked",
              "fleet_coder_fix_repro" not in suites, str(suites))
        check("fleet_coder_fix_judge still scores the surviving 9 tasks",
              suites.get("fleet_coder_fix_judge", {}).get("limit") == 9, str(suites))

    print("\n[main(): --task filters to exactly one task]")
    mod.call_backend = lambda endpoint, model, messages, max_tokens=4000, timeout=180: "irrelevant"
    with tempfile.TemporaryDirectory() as tmp:
        mod.bc.LOCAL_HISTORY_PATH = Path(tmp) / "hist.jsonl"
        mod.bc.NAS_MOUNT_ROOT = Path(tmp) / "no-such-mount"
        sys.argv = ["hermes-coder-fix-eval.py", "--endpoint", "http://fake-coder:1/v1",
                    "--task", "mesh_stl_gaps"]
        rc = mod.main()
        check("main() with --task returns 0", rc == 0)

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
