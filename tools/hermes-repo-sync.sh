#!/usr/bin/env bash
# Version: 2.0.0
#
# 2.0.0 (2026-09-05) — direct request: "re-imagine hermes-repo-sync to be compatible with current
# ecosystem." Full rewrite, not a patch — the problem this script originally solved is gone, and a
# different real gap has opened up in its place.
#
# What used to be true (1.x): Sintra and Amy were separate Unix identities on spark that couldn't
# `git pull` from GitHub themselves (Stage 2/3f gave each a `cp -r` of pmoney's checkout instead),
# so this script watched pmoney's own reflog (via hermes-repo-sync.path) and fanned that pull out
# to their checkouts via `sudo -u`/SSH, then restarted their guard daemons.
#
# What's true now, confirmed live 2026-09-05 rather than assumed: Sintra and Amy are fully retired
# (S8) — no accounts, no daemons, no checkouts to fan out to. All three real nodes (spark, spark-2,
# homed13) are peers now, each running the SAME `pmoney` identity and each already pulling its OWN
# checkout directly from GitHub via hermes-repo-autopull.timer, completely independently, no
# cascade. That part was already correctly re-designed (2.1.0, S14) and needs no further change.
#
# The gap that redesign left standing, confirmed live by checking the real journal across all
# three nodes: autopull keeps the code current, but NOTHING then restarts the services that code
# belongs to, and nothing notices or reports when a pull actually moved something. A node can pull
# new code and silently keep running the old code in memory indefinitely — the exact same failure
# shape (silent staleness, nobody watching) that originally justified building autopull in the
# first place (LESSONS_LEARNED.md: pmoney's own checkout sat stuck at a Stage-2-era commit for a
# multi-day migration, unnoticed).
#
# New job, direct request/decision 2026-09-05 (explicitly choosing auto-restart over notify-only,
# a real reversal of this project's own prior stated caution — "auto-restarting on every pull was
# deliberately not added" — made knowingly here, not assumed): each node's own copy of this script
# now IS what hermes-repo-autopull.timer runs (retargeted from a bare `git pull`, see
# infra/hermes-repo-sync/hermes-repo-autopull.timer). It pulls, and if HEAD actually moved,
# restarts exactly that node's own services via `hermes-restart-fleet.sh --node <name>` (3.1.0,
# built alongside this) — never a peer node, never the whole fleet — then posts one FleetOps
# notice (same matrix-fleetops credential and plain-POST style hermes-buzz-lockup-check.sh already
# uses) naming what moved and whether the restart succeeded, so a bad auto-restart is visible
# immediately rather than discovered later.
#
# hermes-repo-sync.path (the reflog-watcher that used to trigger this) is retired along with the
# fan-out logic it existed to trigger — there is no longer a "watch pmoney, cascade to others"
# relationship between nodes to watch for. The timer alone (already running on all three nodes)
# is now this script's only trigger.
#
# Kept from 1.x, still real: the per-run flock (1.6.0's own fix — two instances of this script
# racing on the same local git repo is a real, previously-hit failure, not a hypothetical one).
#
# --- 1.x history, preserved rather than deleted (this project's own convention: append, never
# rewrite prior entries) even though 2.0.0 above is a full rewrite, not an incremental change to
# this era's design ---
#
# 1.7.1 (2026-08-30) — HermesAgentV5 consolidation: Every identity's repo path
# (PMONEY_REPO/HOMED13_REPO/AMY_REPO and the generic per-identity repo= lines) repointed
# from HermesAgentV4 to HermesAgentV5 -- this is the propagation mechanism itself, now
# targeting the new repo.
#
# 1.7.0 — real bug found live, 2026-08-26, deploying Stage 18's nous-judge skill
# (IMPLEMENTATION_PLAN.md): sync_skill_symlinks() has silently done nothing at all for sintra on
# every run since whenever /home/sintra's permissions were tightened to 0700 -- its `[ -d
# "$repo/skills" ]` test and its `"$repo"/skills/*/` glob both ran as pmoney's own process, not as
# sintra, so both silently evaluated false/empty against a directory pmoney can't even stat.
# No error, no log line -- confirmed live: every one of sintra's 22 existing skill directories
# turned out to be a real copy, not a symlink (`drwxr-xr-x`, not `lrwxrwxrwx`), and the brand-new
# nous-judge skill got no symlink at all, while amy's SSH-based sync (native to her own account, no
# cross-user permission boundary) worked correctly the same run. Fixed: the whole check/glob/link
# sequence now runs inside one `sudo -u "$id" bash -s` call, the same shape sync_amy()'s own SSH
# heredoc already uses -- structurally consistent with the one path that already worked, not a new
# mechanism. Full account in IMPLEMENTATION_PLAN.md Stage 18.
#
# 1.6.0 — real race found live, 2026-08-17, during a routine fleet-health
# check ("check their current status"): this script's own automatic
# trigger (infra/hermes-repo-sync/hermes-repo-sync.path, watching pmoney's
# .git reflog, see the 1.0.0 note below) fired at essentially the same
# moment a manual `bash tools/hermes-repo-sync.sh` run also happened —
# both instances tried to fast-forward sintra's local checkout at once,
# and one's `git pull` failed with `cannot lock ref 'refs/remotes/
# origin/main'` because the other had already moved it out from under it
# mid-operation. Harmless this time (a later run caught sintra up
# correctly, and systemd's failed-unit status doesn't reflect real broken
# state — same "failed marker outlives the actual problem" class this
# project has hit before), but a real gap: nothing has ever prevented two
# instances of this script running concurrently, and the whole point of
# the .path trigger is that a human's manual `git pull` on pmoney's own
# checkout can fire it automatically at any time, including right when
# someone (or some future automation) also invokes this script by hand.
# Fixed with a flock around the whole run, scoped to pmoney (the only
# account this script ever runs as) -- a second concurrent invocation now
# waits its turn instead of racing.
#
# 1.5.0 — real gap found live, 2026-08-17, direct request ("fix the
# repo-sync now") after Stage 7 (§6) relocated Amy's entire persona to
# `spark-2`: this script had never been updated for it, and every trigger
# since has silently failed her half with "could not read amy's HEAD" --
# `sudo -u amy` stopped meaning anything the moment her Unix account was
# stripped from this host. Moved amy out of the local `IDENTITIES` loop
# entirely and into a new `sync_amy()`, structurally the same shape as
# `sync_homed13()` (separate host, reached over SSH, not `sudo -u`) but
# with the guard-daemon restart logic and per-run skill-symlink ensure the
# local sintra/amy loop already had, since she's still a persona with
# guard daemons and skills, not a stateless render worker. Needed two new
# pieces of access, both freshly provisioned, neither reused from
# somewhere broader: a dedicated `pmoney`->`amy@spark-2` SSH key
# (`~/.ssh/spark2_deploy`, `Host spark2-amy`), and a narrow sudoers grant
# on `spark-2` scoped to exactly the three `systemctl restart` commands
# this needs (`/etc/sudoers.d/amy-repo-sync`) -- matching the same
# narrow-allowlist-over-broad-grant pattern `amy-vault`'s own
# `systemd-creds decrypt` rule already established, not pmoney's blanket
# sudo extended across a node boundary. Also found and fixed along the
# way: Amy's GitHub deploy key was silently dead (the private half never
# survived the pre-strip backup, which only covered `~/.hermes`, not
# `~/.ssh`) -- replaced, the old orphaned entry removed from GitHub.
#
# 1.4.0 — real bug found live, 2026-08-16/17, building Buzz (Phase 32): a
# brand-new skill (skills/buzz/) synced correctly into both sintra's and
# amy's repo checkouts via this script's own git pull, but stayed
# completely invisible to their skill_view/skill_manage tool -- that tool
# searches ~/.hermes/skills/, a directory this script had never touched at
# all. Only two skills in the whole project (amy-image-gen,
# model-delegation) had ever been manually symlinked from that live
# directory into the repo checkout; every other skill either didn't exist
# there or was a stale hand-copied file frozen at whatever it was the day
# someone pasted it in, silently drifting from the repo from that point
# on. Sintra hit this live: a fresh session correctly found the new SOUL.md
# pointer and named "the buzz skill" on her own, but skill_view came back
# "Skill 'buzz' not found", and she had no way to learn the actual command
# syntax. Fixed with a new sync_skill_symlinks() -- ensures a symlink
# (never a copy) exists in ~/.hermes/skills/ for every folder under the
# identity's own repo skills/, run every trigger regardless of whether the
# pull moved HEAD, so a broken/missing link self-heals on the very next
# run rather than waiting for someone to add another skill and notice.
# Symlinking rather than copying closes this permanently, structurally --
# a skill's *content* updates are automatically live through the repo
# checkout with no further sync step required, matching this project's
# own standing preference for fixing the environment over adding another
# manual step to remember. All 19 project skills converted from
# copy-or-missing to symlink for both identities as part of this fix; full
# incident in LESSONS_LEARNED.md.
#
# 1.3.1 — comment-only: documented why broker_job_type_running()'s
# vault-get-secret.sh call correctly falls through to Sintra's Vaultwarden
# bootstrap identity (confirmed live on the first real run) rather than a
# separate pmoney one that doesn't exist -- it looks identical to the real
# cross-identity credential bug in LESSONS_LEARNED.md §2j at a glance.
#
# 1.3.0 — extends coverage to HomeD13 (direct request, 2026-08-14, asked
# right after HomeD13 needed the exact same manual pull+restart dance the
# other three checkouts did). Structurally different from sintra/amy:
# HomeD13 is a separate physical host, reached over the same Spark->HomeD13
# SSH path hermes-node-health.py already established (~pmoney's own
# `Host homed13` alias), not `sudo -u`. Its two services aren't like the
# guard daemons either — they process real broker jobs, and restarting one
# mid-render kills the in-progress job (the broker's own lease/requeue
# design makes this non-destructive, not data loss, but a real cost for a
# job that can run 20+ minutes). Direct decision: check the broker for an
# in-flight job of that worker's type before restarting; skip and mark
# pending rather than kill it, retried on every subsequent trigger
# (including a no-op pmoney pull) until the worker is actually free — a
# skip has no other trigger to retry on besides this script running again.
#
# 1.2.0 — second real bug found on the same first live run, right after
# 1.1.0's polkit fix let the restarts actually go through: restarting all
# three of an identity's services in one `systemctl restart a b c` command
# started them concurrently, and each independently logging into
# Vaultwarden (vault-get-secret.sh -> `bw login`) at the same moment was
# enough real login traffic to trip Vaultwarden's own rate limiter --
# confirmed live for both identities independently, each requiring the
# affected service stopped and given a several-minute cooldown before
# `bw login` stopped returning "Rate limit exceeded." Fixed: each
# identity's services now restart one at a time with a 10s pause between,
# so no two logins for the same account are ever in flight together.
#
# 1.1.0 — real bug found on the first live run: the restart step used a
# bare `systemctl restart`, which (this service running as User=pmoney,
# not root) goes through polkit's D-Bus authorization rather than sudo's,
# and hung on an interactive auth prompt with no polkit agent available to
# answer it in a headless SSH session, timing out. Fixed to `sudo
# systemctl restart` explicitly, same as the git calls above already do.
#
# hermes-repo-sync.sh — pulls this node's own HermesAgentV5 checkout (fast-forward-only) and, only
# if that pull actually moved HEAD, restarts this node's own services and notifies FleetOps.
#
# Node identity is auto-detected from `hostname` (spark|spark-2|HomeD13) — never guessed from
# which account happens to invoke it, since all three nodes share the same `pmoney` identity now.
#
# Usage: hermes-repo-sync.sh (no args — reads its own hostname; run via hermes-repo-autopull.timer)
set -uo pipefail

REPO_DIR="/home/pmoney/HermesAgentV5"
MATRIX_URL="${MATRIX_URL:-http://127.0.0.1:6167}"
MAX_COMMITS_SHOWN=20

log() { echo "[hermes-repo-sync] $*"; }

# Serialize against any other instance of this same script -- a real, previously-hit failure
# (1.6.0 in the old design): the timer firing at the same moment as a manual run raced on the same
# local git repo. 240s covers a real full restart-fleet run (dependency-ordered, paused between
# every service) plus queuing behind another instance's own run.
LOCK_FILE="${HOME}/.hermes/repo-sync.lock"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -w 240 9; then
  log "ERROR: timed out waiting for another hermes-repo-sync.sh run to finish (lock: $LOCK_FILE)"
  exit 1
fi

detect_node() {
  case "$(hostname)" in
    spark) echo spark ;;
    spark-2) echo spark2 ;;
    HomeD13|homed13) echo homed13 ;;
    *)
      log "ERROR: unrecognized hostname '$(hostname)' -- add it to detect_node() before running here"
      exit 1
      ;;
  esac
}

notify_fleetops() {
  local body="$1" token room room_enc resp
  token="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-fleetops password 2>/dev/null)"
  room="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-fleetops room 2>/dev/null)"
  if [ -z "$token" ] || [ -z "$room" ]; then
    log "WARNING: no FleetOps credentials -- cannot notify, logging only:"
    log "$body"
    return
  fi
  room_enc="$(jq -rn --arg s "$room" '$s|@uri')"
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$token" | \
    curl -sf -K - -X PUT "$MATRIX_URL/_matrix/client/v3/rooms/$room_enc/send/m.room.message/reposync-$(date +%s%N)" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg body "$body" '{msgtype: "m.notice", body: $body}')")"
  if echo "$resp" | jq -e '.event_id' >/dev/null 2>&1; then
    log "notified FleetOps"
  else
    log "ERROR: FleetOps notice post failed: $resp"
  fi
}

NODE="$(detect_node)"
before="$(git -C "$REPO_DIR" rev-parse HEAD)"
log "node=$NODE, current HEAD=$before -- pulling"

if ! git -C "$REPO_DIR" pull --ff-only 2>&1 | sed "s/^/[hermes-repo-sync:$NODE] /"; then
  log "ERROR: fast-forward pull failed -- likely a diverged/dirty checkout, needs a human"
  notify_fleetops "[repo-sync:$NODE] git pull --ff-only FAILED -- checkout likely diverged or dirty, needs a human: ssh $NODE git -C $REPO_DIR status"
  exit 1
fi

after="$(git -C "$REPO_DIR" rev-parse HEAD)"
if [ "$after" = "$before" ]; then
  log "already at $before -- nothing to do"
  exit 0
fi

log "moved $before -> $after -- restarting $NODE's own services"
commits="$(git -C "$REPO_DIR" log --oneline "$before".."$after" | head -n "$MAX_COMMITS_SHOWN")"
commit_count="$(git -C "$REPO_DIR" rev-list --count "$before".."$after")"
if [ "$commit_count" -gt "$MAX_COMMITS_SHOWN" ]; then
  commits="$commits
... ($((commit_count - MAX_COMMITS_SHOWN)) more)"
fi

if "$REPO_DIR/tools/hermes-restart-fleet.sh" --node "$NODE" 2>&1 | sed "s/^/[hermes-repo-sync:$NODE] /"; then
  restart_status="restarted cleanly"
else
  restart_status="RESTART FAILED -- check: journalctl -u hermes-repo-sync.service on $NODE, or rerun hermes-restart-fleet.sh --node $NODE by hand"
fi

notify_fleetops "[repo-sync:$NODE] pulled ${before:0:8} -> ${after:0:8}, $restart_status
$commits"
