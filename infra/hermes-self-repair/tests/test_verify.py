#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-11-13) — offline checks for tools/hermes-self-repair-verify.py 2.0.0, against a
# throwaway git repo: the JavaScript syntax check, the behavior-change and dead-addition checks
# (each shaped like one of the 2026-11-10/11 staged non-fixes), the domain test suite in a clean
# worktree, and the "test fails without the fix, passes with it" check. Needs git and node.
#
# Run: python3 infra/hermes-self-repair/tests/test_verify.py

import importlib.util
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[3] / "tools"
FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    print(f"  {'ok  ' if cond else 'FAIL'} {label}" + ("" if cond else f" {detail}"))
    if not cond:
        FAILURES.append(label)


def load():
    spec = importlib.util.spec_from_file_location("verify_test_target", TOOLS / "hermes-self-repair-verify.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


GOALS = """// Version: 1.0.0
export function loadGoal(g) {
  return g ?? null;
}
"""
CALLER = """import { loadGoal } from "./goals.js";
console.log(loadGoal(1));
"""
WEAPONS = """export function hasWeapon(items) {
  return items.some((i) => i.endsWith("_sword"));
}
"""
WEAPONS_TEST = """import { hasWeapon } from "../weapons.js";
if (!hasWeapon(["iron_axe"])) { console.error("an axe is a weapon"); process.exit(1); }
console.log("ok");
"""
WEAPONS_FIXED = """export function hasWeapon(items) {
  return items.some((i) => i.endsWith("_sword") || i.endsWith("_axe"));
}
"""


def diff_of(repo, rel, new_text):
    path = repo / rel
    old = path.read_text()
    path.write_text(new_text)
    out = subprocess.run(["git", "-C", str(repo), "diff", "--", rel], capture_output=True, text=True).stdout
    path.write_text(old)
    return out


def main():
    mod = load()
    if not shutil.which("node"):
        sys.exit("node is required for these checks")
    repo = Path(tempfile.mkdtemp(prefix="verify-test-"))
    try:
        git(repo, "init", "-q")
        git(repo, "config", "user.email", "t@t")
        git(repo, "config", "user.name", "t")
        (repo / "goals.js").write_text(GOALS)
        (repo / "caller.js").write_text(CALLER)
        (repo / "weapons.js").write_text(WEAPONS)
        (repo / "tests").mkdir()
        (repo / "tests" / "weapons.test.mjs").write_text(WEAPONS_TEST)
        (repo / "package.json").write_text('{"type": "module"}\n')
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "base")

        print("[syntax]")
        bad = repo / "broken.js"
        bad.write_text("export function (\n")
        ok, note = mod.check_syntax(bad)
        check("a .js file that does not parse fails (no checker at all before 2.0.0)", ok is False, note)
        ok, note = mod.check_syntax(repo / "goals.js")
        check("a .js file that parses passes", ok is True, note)
        bad.unlink()

        print("[behavior change]")
        d = diff_of(repo, "goals.js", GOALS.replace("// Version: 1.0.0", "// Version: 1.0.1\n// a wrong comment"))
        ok, note = mod.check_behavior_change(".js", d)
        check("a comment-only diff fails (19dbdfd's shape)", ok is False, note)
        d = diff_of(repo, "goals.js", GOALS.replace("g ?? null", "g ?? {}"))
        ok, note = mod.check_behavior_change(".js", d)
        check("a diff that changes code passes", ok is True, note)

        print("[dead additions]")
        dead = GOALS + "\nexport function clearStuckState(p) {\n  return p;\n}\n"
        d = diff_of(repo, "goals.js", dead)
        (repo / "goals.js").write_text(dead)
        ok, note = mod.check_dead_additions(repo / "goals.js", "goals.js", d, repo)
        check("an exported helper nothing uses fails (d94a899's shape)", ok is False and "clearStuckState" in note, note)
        (repo / "caller.js").write_text(CALLER + "import { clearStuckState } from './goals.js';\nclearStuckState(2);\n")
        git(repo, "add", "caller.js")
        ok, note = mod.check_dead_additions(repo / "goals.js", "goals.js", d, repo)
        check("the same helper passes once another file calls it", ok is True, note)
        git(repo, "checkout", "-q", "--", ".")
        git(repo, "reset", "-q", "--hard")

        field = GOALS.replace("return g ?? null;", "return { ...g, rejectedDones: 0 };")
        d = diff_of(repo, "goals.js", field)
        (repo / "goals.js").write_text(field)
        ok, note = mod.check_dead_additions(repo / "goals.js", "goals.js", d, repo)
        check("a field only ever written fails (134d1bd's shape)", ok is False and "rejectedDones" in note, note)
        read_field = field + "export function rejected(g) {\n  return g.rejectedDones;\n}\n"
        d = diff_of(repo, "goals.js", read_field)
        (repo / "goals.js").write_text(read_field)
        (repo / "caller.js").write_text(CALLER + "import { rejected } from './goals.js';\nrejected({});\n")
        ok, note = mod.check_dead_additions(repo / "goals.js", "goals.js", d, repo)
        check("a field that is also read passes", ok is True, note)
        git(repo, "reset", "-q", "--hard")

        local = GOALS + "\nfunction neverCalled() {\n  return 1;\n}\n"
        d = diff_of(repo, "goals.js", local)
        (repo / "goals.js").write_text(local)
        ok, note = mod.check_dead_additions(repo / "goals.js", "goals.js", d, repo)
        check("a new local function never called fails", ok is False and "neverCalled" in note, note)
        git(repo, "reset", "-q", "--hard")

        print("[tests in a clean worktree]")
        cmd = ["node", "tests/weapons.test.mjs"]
        ok, note = mod.check_tests(repo, cmd)
        check("a failing suite fails the check", ok is False and "an axe is a weapon" in note, note)
        (repo / "weapons.js").write_text(WEAPONS_FIXED)
        git(repo, "commit", "-q", "-am", "fix: axes are weapons")
        fix_sha = git(repo, "rev-parse", "HEAD").strip()
        ok, note = mod.check_tests(repo, cmd)
        check("a passing suite passes", ok is True, note)
        check("the worktree is removed afterwards",
              "selfrepair-verify-" not in git(repo, "worktree", "list"), git(repo, "worktree", "list"))
        links_target = repo / "external_dir"
        links_target.mkdir()
        (links_target / "marker.txt").write_text("x")
        rc, out = mod.run_in_worktree(repo, ["cat", "linked/marker.txt"], links={"linked": str(links_target)})
        check("verify_links are symlinked into the worktree", rc == 0 and out.strip() == "x", (rc, out))

        print("[a linked test must fail without its fix]")
        single = ["node", "{test_path}"]
        ok, note = mod.check_test_discriminates(repo, "tests/weapons.test.mjs", "weapons.js", fix_sha, single)
        check("a test that fails before the fix and passes after passes", ok is True, note)
        (repo / "tests" / "trivial.test.mjs").write_text("console.log('ok');\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "a test that tests nothing")
        ok, note = mod.check_test_discriminates(repo, "tests/trivial.test.mjs", "weapons.js", fix_sha, single)
        check("a test that passes either way fails", ok is False and "does not test the fix" in note, note)
        (repo / "tests" / "broken.test.mjs").write_text("process.exit(1);\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "a test that always fails")
        ok, note = mod.check_test_discriminates(repo, "tests/broken.test.mjs", "weapons.js", fix_sha, single)
        check("a test that fails even with the fix fails", ok is False and "does not pass" in note, note)
        check("the real checkout is untouched by the before-the-fix run",
              (repo / "weapons.js").read_text() == WEAPONS_FIXED)

        print("[verify() end to end]")
        d = git(repo, "show", "--format=", fix_sha)
        ok, report = mod.verify(repo / "weapons.js", diff_text=d, repo_dir=repo, rel_path="weapons.js",
                                test_command=cmd)
        check("a real fix with a passing suite verifies", ok is True, report)
        ok, report = mod.verify(repo / "weapons.js")
        check("verify(path) alone still works as before", ok is True and "JavaScript syntax: OK" in report, report)
    finally:
        subprocess.run(["git", "-C", str(repo), "worktree", "prune"], capture_output=True)
        shutil.rmtree(repo, ignore_errors=True)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
