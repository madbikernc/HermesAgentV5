#!/usr/bin/env bash
# Version: 1.0.0
#
# hermes-self-repair-sync — keeps the self-repair checkout (SELF_REPAIR_REPO_DIR, default
# ~/HermesAgentV5-selfrepair) current with GitHub. Nothing did before: the generator reads every
# target file from this checkout, and on 2026-11-10 it was still at 2026-11-07, so files added to
# origin since (pathfinding.js, tests/unit/*) were invisible to the bridge and the generator.
#
# Merges origin/master into the checkout's master and pushes the result to GIT_REMOTE
# (nas2-selfrepair). A merge, never a rebase or reset: commits the apply worker has staged there
# (pending a promote/skip decision) keep their hashes, and promotion still cherry-picks only that
# one commit onto origin/master (tools/hermes-self-repair-promote.py), so a merge commit here never
# reaches GitHub. Skips, changing nothing, when:
#   - the working tree has uncommitted changes to tracked files,
#   - HEAD is not exactly GIT_REMOTE/GIT_BRANCH (a local-only commit, or the remote moved),
#   - origin/master is already contained in HEAD.
# A merge conflict is aborted and the run fails, for a human to resolve.
#
# Holds the same lock as tools/hermes-self-repair-apply.py's apply_diff() (SELF_REPAIR_LOCK,
# default <checkout>/.git/hermes-self-repair.lock), so a sync never runs mid-apply.
#
# Run by hermes-self-repair-sync.timer (infra/hermes-self-repair/), every 30 minutes.
set -euo pipefail

REPO="${SELF_REPAIR_REPO_DIR:-$HOME/HermesAgentV5-selfrepair}"
REMOTE="${GIT_REMOTE:-nas2-selfrepair}"
BRANCH="${GIT_BRANCH:-master}"
LOCK="${SELF_REPAIR_LOCK:-$REPO/.git/hermes-self-repair.lock}"
NAME="${GIT_AUTHOR_NAME:-hermes-self-repair}"
EMAIL="${GIT_AUTHOR_EMAIL:-hermes-self-repair@local}"
LOCK_WAIT="${SELF_REPAIR_LOCK_WAIT:-300}"

log() { echo "[hermes-self-repair-sync] $*"; }

exec 9>"$LOCK"
if ! flock -w "$LOCK_WAIT" 9; then
  log "lock $LOCK still held after ${LOCK_WAIT}s (an apply in progress?) -- skipping this run"
  exit 1
fi

cd "$REPO"
git fetch -q origin
git fetch -q "$REMOTE"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "uncommitted changes to tracked files -- skipping, nothing changed"
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$REMOTE/$BRANCH")" ]; then
  log "HEAD $(git rev-parse --short HEAD) is not $REMOTE/$BRANCH $(git rev-parse --short "$REMOTE/$BRANCH") -- skipping, nothing changed"
  exit 1
fi
if git merge-base --is-ancestor origin/master HEAD; then
  log "already contains origin/master $(git rev-parse --short origin/master)"
  exit 0
fi

if ! git -c user.name="$NAME" -c user.email="$EMAIL" merge -q --no-edit origin/master \
    -m "Sync origin/master $(git rev-parse --short origin/master) into the self-repair checkout"; then
  git merge --abort || true
  log "merge of origin/master conflicted -- aborted, checkout unchanged; resolve by hand"
  exit 1
fi
git push -q "$REMOTE" "$BRANCH"
log "merged origin/master $(git rev-parse --short origin/master) and pushed $REMOTE/$BRANCH at $(git rev-parse --short HEAD)"
