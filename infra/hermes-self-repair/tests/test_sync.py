#!/usr/bin/env python3
# Version: 1.0.0
#
# Checks for tools/hermes-self-repair-sync.sh against throwaway git repositories: a bare "origin",
# a bare "nas2-selfrepair", and a checkout cloned from both, built fresh for each case. Linux only
# (bash + flock), like the script itself.
#
# Run: python3 infra/hermes-self-repair/tests/test_sync.py

import fcntl
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / "tools" / "hermes-self-repair-sync.sh"
FAILURES = []
CHECKS = [0]
IDENT = ["-c", "user.name=t", "-c", "user.email=t@t"]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    print(f"  {'ok  ' if cond else 'FAIL'} {label}" + ("" if cond else f" {detail}"))
    if not cond:
        FAILURES.append(label)


def git(cwd, *args):
    return subprocess.run(["git", *IDENT, *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def commit(cwd, name, text):
    Path(cwd, name).write_text(text)
    git(cwd, "add", name)
    git(cwd, "commit", "-q", "-m", f"edit {name}")
    return git(cwd, "rev-parse", "HEAD")


def world(tmp):
    """origin and nas2 share a base; the checkout has one staged self-repair commit pushed to nas2."""
    origin, nas2, dev, co = (Path(tmp, n) for n in ("origin.git", "nas2.git", "dev", "checkout"))
    for bare in (origin, nas2):
        subprocess.run(["git", "init", "-q", "--bare", "-b", "master", str(bare)], check=True)
    subprocess.run(["git", "clone", "-q", str(origin), str(dev)], check=True, capture_output=True)
    commit(dev, "base.txt", "base\n")
    git(dev, "push", "-q", "origin", "master")
    subprocess.run(["git", "clone", "-q", "-o", "origin", str(origin), str(co)], check=True, capture_output=True)
    git(co, "remote", "add", "nas2-selfrepair", str(nas2))
    staged = commit(co, "fix.txt", "self-repair fix\n")
    git(co, "push", "-q", "nas2-selfrepair", "master")
    return dev, co, staged


def run(co, **env):
    e = dict(os.environ, SELF_REPAIR_REPO_DIR=str(co), SELF_REPAIR_LOCK_WAIT="1", **env)
    return subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=e)


def main():
    print("\n[a new origin commit is merged in and pushed; the staged commit keeps its hash]")
    with tempfile.TemporaryDirectory() as tmp:
        dev, co, staged = world(tmp)
        new = commit(dev, "pathfinding.js", "new file\n")
        git(dev, "push", "-q", "origin", "master")
        r = run(co)
        check("exit 0", r.returncode == 0, r.stdout + r.stderr)
        check("the new origin file is in the checkout", Path(co, "pathfinding.js").exists())
        log = git(co, "rev-list", "nas2-selfrepair/master")
        check("nas2 has the staged commit (same hash) and origin's", staged in log and new in log)
        check("nas2 is at the checkout's HEAD", git(co, "rev-parse", "HEAD") == git(co, "rev-parse", "nas2-selfrepair/master"))
        head = git(co, "rev-parse", "HEAD")
        r = run(co)
        check("a second run with nothing new changes nothing", r.returncode == 0 and git(co, "rev-parse", "HEAD") == head, r.stdout)

    print("\n[skips, changing nothing]")
    with tempfile.TemporaryDirectory() as tmp:
        dev, co, staged = world(tmp)
        commit(dev, "other.txt", "x\n")
        git(dev, "push", "-q", "origin", "master")
        commit(co, "local.txt", "unpushed\n")
        head = git(co, "rev-parse", "HEAD")
        r = run(co)
        check("a local commit not on nas2 -> skipped", r.returncode == 1 and git(co, "rev-parse", "HEAD") == head, r.stdout)

    with tempfile.TemporaryDirectory() as tmp:
        dev, co, staged = world(tmp)
        commit(dev, "other.txt", "x\n")
        git(dev, "push", "-q", "origin", "master")
        Path(co, "fix.txt").write_text("half-applied\n")
        r = run(co)
        check("uncommitted changes -> skipped", r.returncode == 1 and git(co, "rev-parse", "HEAD") == staged, r.stdout)

    with tempfile.TemporaryDirectory() as tmp:
        dev, co, staged = world(tmp)
        commit(dev, "fix.txt", "a conflicting origin edit\n")
        git(dev, "push", "-q", "origin", "master")
        r = run(co)
        check("a conflict is aborted: exit 1, HEAD and nas2 unchanged",
              r.returncode == 1 and git(co, "rev-parse", "HEAD") == staged
              and git(co, "rev-parse", "nas2-selfrepair/master") == staged, r.stdout + r.stderr)
        check("no merge left in progress", not Path(co, ".git", "MERGE_HEAD").exists())

    with tempfile.TemporaryDirectory() as tmp:
        dev, co, staged = world(tmp)
        commit(dev, "other.txt", "x\n")
        git(dev, "push", "-q", "origin", "master")
        with open(Path(co, ".git", "hermes-self-repair.lock"), "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)  # the apply worker mid-apply
            r = run(co)
        check("the apply worker's lock held -> skipped", r.returncode == 1 and git(co, "rev-parse", "HEAD") == staged, r.stdout)

    total, failed = CHECKS[0], len(FAILURES)
    print(f"\n{total - failed}/{total} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
