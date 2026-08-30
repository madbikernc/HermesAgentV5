#!/usr/bin/env bash
# Version: 1.7.1
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
# in-flight job of that worker's own type before restarting; skip and mark
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
# hermes-repo-sync.sh — propagates pmoney's ~/HermesAgentV5 checkout to
# Sintra's and Amy's own separate checkouts (Stage 2/3f: neither can
# traverse into /home/pmoney, so each got a full `cp -r` of the repo at
# migration time, and every one of the three has drifted independently
# ever since — this project's own real incident, 2026-08-14, deploying the
# security-review fixes: two pulls, two permission surprises, two
# fabrication-guard unit-name lookups, all done by hand). Runs unattended,
# triggered by infra/hermes-repo-sync/hermes-repo-sync.path watching
# pmoney's .git reflog — see that path unit's own comment for why.
#
# Deliberately reactive, never initiating: pmoney's own pull stays a
# human's deliberate action (direct request, 2026-08-14) — this only ever
# runs after one already happened, never fetches from GitHub on its own.
#
# For each identity: fast-forward-only pull (never merges/rebases — a
# divergent downstream checkout, e.g. from a stray local edit, must fail
# loudly and get a human's attention, not be silently resolved). Only
# restarts that identity's affected services if the pull actually moved
# HEAD, and only the long-running daemons that read a tools/ script once
# at startup and hold it in memory (session-guardian, fabrication-guard,
# session-cap-guard) — never hermes-gateway.service itself, which shells
# out to whatever's on disk fresh on every tool call and needs no restart
# for a tools/ change.
#
# Runs as pmoney (systemd User=pmoney in hermes-repo-sync.service), reusing
# pmoney's own existing sudo to reach sintra's/amy's accounts — the exact
# commands run by hand to deploy 2026-08-14's fixes, now automated rather
# than a new privilege grant. No new sudoers rule needed.
set -uo pipefail

# Serialize against any other instance of this same script -- the .path
# trigger and a manual run can otherwise race on the same local git repo
# (see 1.6.0 note above). 240s, not 120s (1.6.1 -- the original figure was
# an underestimate, caught live: a real manual full run legitimately took
# long enough, across three identities' worth of SSH round-trips and
# staggered restarts, that the .path trigger's own concurrent attempt hit
# the 120s wait and gave up -- a clean, harmless deferral, not corruption,
# but a nuisance failure worth avoiding rather than working as designed.
LOCK_FILE="${HOME}/.hermes/repo-sync.lock"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -w 240 9; then
  echo "[hermes-repo-sync] ERROR: timed out waiting for another hermes-repo-sync.sh run to finish (lock: $LOCK_FILE)" >&2
  exit 1
fi

PMONEY_REPO="/home/pmoney/HermesAgentV5"
IDENTITIES=(sintra)

# HomeD13 -- separate host, reached over SSH (pmoney's own `Host homed13`
# alias, same one hermes-node-health.py already uses), not `sudo -u`.
HOMED13_SSH="homed13"
HOMED13_REPO="/home/pmoney/HermesAgentV5"
BROKER_URL="${BROKER_URL:-http://10.129.1.15:8100}"
PENDING_DIR="/home/pmoney/.hermes"
declare -A HOMED13_SERVICE=(
  [render]="hermes-render-worker.service"
  [video]="hermes-render-worker-video.service"
)

# Amy -- separate host since Stage 7 (§6) relocated her whole persona to
# spark-2, reached over SSH (pmoney's own `Host spark2-amy` alias,
# ~/.ssh/spark2_deploy) directly as her own account, not `sudo -u`. Restart
# access is a narrow sudoers grant on spark-2 scoped to exactly these three
# commands (/etc/sudoers.d/amy-repo-sync), not pmoney's own broader sudo
# extended across the node boundary.
AMY_SSH="spark2-amy"
AMY_REPO="/home/amy/HermesAgentV5"
AMY_SERVICES="hermes-session-guardian-amy.service hermes-fabrication-guard-amy.service hermes-session-cap-guard-amy.service"

# Per-identity list of systemd services that need restarting after a pull
# actually moves that identity's HEAD. Naming is NOT symmetric between
# identities — sintra's fabrication-guard unit predates the per-identity
# suffix convention (found live, 2026-08-14): confirm with
# `systemctl list-units --all --type=service | grep -i hermes` before
# editing this if either identity's units are ever renamed.
declare -A SERVICES=(
  [sintra]="hermes-session-guardian-sintra.service hermes-fabrication-guard.service hermes-session-cap-guard-sintra.service"
)

log() { echo "[hermes-repo-sync] $*"; }

# Emits a curl -K config snippet putting the Authorization header on stdin
# instead of argv -- same pattern used fleet-wide since the 2026-08-14
# security review, so the broker token is never visible via `ps`.
_auth_header_stdin() { printf 'header = "Authorization: Bearer %s"\n' "$1"; }

# True if the broker has a job of $1 (render|video) currently in state
# 'running'. Since each HomeD13 worker instance only ever claims its own
# job type, checking by type alone correctly identifies whether *that*
# worker is busy -- no need for the broker's /jobs response to carry a
# `worker` field (it doesn't). Fails safe: if the token or the broker
# itself is unreachable, treated as busy (skip the restart) rather than
# risking killing a real job we simply couldn't confirm the state of.
broker_job_type_running() {
  local jtype="$1" token resp count
  # No VAULT_NODE set deliberately: this host's /etc/hermes/vault-node-name
  # defaults to "sintra", the same intentional fallthrough
  # hermes_pfsense_common.py's and hermes-game-server-monitor.py's own
  # vault_get() already rely on for pmoney-run tools reaching a shared
  # Fleet-Service item (pmoney has no separate Vaultwarden bootstrap
  # identity of its own). Confirmed live, 2026-08-14: this correctly reads
  # broker-token via Sintra's sealed credential, not a bug -- worth this
  # comment since it looks identical to the real cross-identity mistake
  # documented in LESSONS_LEARNED.md §2j at a glance.
  token="$("$PMONEY_REPO/tools/vault-get-secret.sh" broker-token 2>/dev/null)"
  if [ -z "$token" ]; then
    log "WARNING: could not fetch broker-token to check homed13's $jtype queue -- treating as busy (fail safe)"
    return 0
  fi
  resp="$(_auth_header_stdin "$token" | curl -s -K - --max-time 15 "$BROKER_URL/jobs" 2>/dev/null)"
  count="$(echo "$resp" | jq -e --arg t "$jtype" '[.jobs[]? | select(.type==$t and .state=="running")] | length' 2>/dev/null)"
  if [ -z "$count" ]; then
    log "WARNING: could not read broker /jobs to check homed13's $jtype queue -- treating as busy (fail safe)"
    return 0
  fi
  [ "$count" -gt 0 ]
}

# Separate function, not folded into the sintra/amy loop below: different
# transport (SSH, not sudo -u), different repo owner (pmoney on a different
# host, not a distinct Unix identity), and a genuinely different restart
# safety check (job-in-flight, not just "did the pull move HEAD").
sync_homed13() {
  mkdir -p "$PENDING_DIR"
  local before after moved=0

  before="$(ssh "$HOMED13_SSH" "git -C $HOMED13_REPO rev-parse HEAD" 2>/dev/null)"
  if [ -z "$before" ]; then
    log "ERROR: could not read homed13's HEAD (SSH/git failed, host may be unreachable) — skipping, not restarting anything for homed13"
    exit_code=1
    return
  fi

  if [ "$before" != "$pmoney_head" ]; then
    log "homed13 at $before, pmoney at $pmoney_head — pulling ($HOMED13_REPO via SSH)"
    if ! ssh "$HOMED13_SSH" "git -C $HOMED13_REPO pull --ff-only" 2>&1 | sed "s/^/[hermes-repo-sync:homed13] /"; then
      log "ERROR: fast-forward pull failed for homed13 — likely a diverged/dirty checkout, needs a human; not restarting anything for homed13"
      exit_code=1
      return
    fi
    after="$(ssh "$HOMED13_SSH" "git -C $HOMED13_REPO rev-parse HEAD" 2>/dev/null)"
    if [ "$after" != "$before" ]; then
      moved=1
      log "homed13 now at $after"
    else
      log "homed13's pull completed but HEAD didn't move ($after)"
    fi
  else
    log "homed13 already at $pmoney_head"
  fi

  # Checked every run, not just when $moved -- a restart skipped earlier
  # because a job was in flight has no other trigger to retry on besides
  # this script running again, including a run where pmoney's pull was a
  # no-op for homed13 specifically.
  for jtype in render video; do
    local svc="${HOMED13_SERVICE[$jtype]}" pending_file="$PENDING_DIR/repo-sync-pending-homed13-$jtype"
    if [ "$moved" -eq 0 ] && [ ! -f "$pending_file" ]; then
      continue
    fi
    if broker_job_type_running "$jtype"; then
      log "homed13: $svc has a $jtype job in flight — skipping restart (not killing real work), will retry next trigger"
      touch "$pending_file"
      continue
    fi
    if ssh "$HOMED13_SSH" "sudo systemctl restart $svc"; then
      log "homed13: restarted $svc"
      rm -f "$pending_file"
    else
      log "ERROR: restart failed for homed13's $svc — check: ssh $HOMED13_SSH systemctl status $svc"
      exit_code=1
    fi
    sleep 10
  done
}

# Amy, over SSH -- same shape as sync_homed13() (separate host, not
# `sudo -u`), but she's still a persona with guard daemons and skills, so
# this also carries the restart-staggering and skill-symlink-ensure logic
# the local sintra/amy loop already had, just executed remotely instead of
# via `sudo -u`.
sync_amy() {
  local before after moved=0

  before="$(ssh "$AMY_SSH" "git -C $AMY_REPO rev-parse HEAD" 2>/dev/null)"
  if [ -z "$before" ]; then
    log "ERROR: could not read amy's HEAD ($AMY_SSH via SSH, host may be unreachable) — skipping, not restarting anything for amy"
    exit_code=1
    return
  fi

  if [ "$before" != "$pmoney_head" ]; then
    log "amy at $before, pmoney at $pmoney_head — pulling ($AMY_REPO via SSH)"
    if ! ssh "$AMY_SSH" "git -C $AMY_REPO pull --ff-only" 2>&1 | sed "s/^/[hermes-repo-sync:amy] /"; then
      log "ERROR: fast-forward pull failed for amy — likely a diverged/dirty checkout, needs a human; not restarting anything for amy"
      exit_code=1
      return
    fi
    after="$(ssh "$AMY_SSH" "git -C $AMY_REPO rev-parse HEAD" 2>/dev/null)"
    if [ "$after" != "$before" ]; then
      moved=1
      log "amy now at $after"
    else
      log "amy's pull completed but HEAD didn't move ($after)"
    fi
  else
    log "amy already at $pmoney_head"
  fi

  # Same skill-symlink-ensure logic as sync_skill_symlinks(), executed
  # remotely since amy is a genuinely separate host now, not a local
  # `sudo -u` account. Run every trigger regardless of $moved, same
  # self-healing reasoning.
  ssh "$AMY_SSH" 'bash -s' <<'REMOTE_SCRIPT' 2>&1 | sed "s/^/[hermes-repo-sync:amy] /"
set -uo pipefail
repo="$HOME/HermesAgentV5"
live="$HOME/.hermes/skills"
[ -d "$repo/skills" ] || exit 0
mkdir -p "$live"
made=0
for target in "$repo"/skills/*/; do
  name="$(basename "$target")"
  link="$live/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "amy: $link exists and is not a symlink -- leaving it alone, not overwriting real content"
    continue
  fi
  if [ ! -L "$link" ] || [ "$(readlink "$link" 2>/dev/null)" != "$repo/skills/$name" ]; then
    ln -sfn "$repo/skills/$name" "$link"
    made=1
    echo "amy: linked skill '$name'"
  fi
done
[ "$made" -eq 1 ] || echo "amy: skill symlinks already current"
REMOTE_SCRIPT

  if [ "$moved" -eq 0 ]; then
    return
  fi

  log "amy now restarting: $AMY_SERVICES"
  restart_failed=0
  for svc in $AMY_SERVICES; do
    # sudo on the remote end, scoped to exactly this command per
    # /etc/sudoers.d/amy-repo-sync -- amy's own account has no broader
    # systemctl access than that. Staggered with the same 10s pause as
    # every other identity's restart loop, same Vaultwarden-rate-limit
    # reasoning (2026-08-14 incident, this file's own 1.2.0 note).
    if ssh "$AMY_SSH" "sudo systemctl restart $svc"; then
      log "amy: restarted $svc"
    else
      log "ERROR: restart failed for amy's $svc — check: ssh $AMY_SSH systemctl status $svc"
      restart_failed=1
    fi
    sleep 10
  done
  if [ "$restart_failed" -eq 0 ]; then
    log "amy's services restarted cleanly"
  else
    exit_code=1
  fi
}

# Ensures every skill folder in $id's own repo checkout has a matching
# symlink in ~/.hermes/skills/ -- the directory skill_view/skill_manage
# actually searches, which is a completely separate tree from the repo
# checkout the git pull above syncs. Real incident, 2026-08-16/17: a
# brand-new skill (buzz) synced correctly into both identities' repo
# checkouts via the pull, but stayed invisible to their own skill-lookup
# tool because nothing ever created the matching symlink -- only two
# skills (amy-image-gen, model-delegation) had ever been manually
# symlinked this way; every other skill either didn't exist there at all
# or was a stale hand-copied file that stopped tracking the repo the
# moment it was pasted in. Symlinking instead of copying means a skill's
# *content* updates are automatically live with no sync step at all --
# this function only ever has work to do for a skill folder that doesn't
# have a link yet.
# Idempotent and safe to run every trigger, not gated on the pull having
# moved HEAD: a symlink removed or broken by any other means self-heals
# on the next run instead of staying silently broken until someone
# happens to add another new skill and notices.
sync_skill_symlinks() {
  local id="$1" repo="/home/$id/HermesAgentV5"
  # Every check and mutation below runs as $id via `sudo -u`, never as pmoney directly -- pmoney
  # has NO read access into /home/sintra at all (0700, sintra:sintra, confirmed live 2026-08-26).
  # The original version of this function tested `[ -d "$repo/skills" ]` and globbed
  # "$repo"/skills/*/ as pmoney's own process, both silently false/empty against a 0700 home dir --
  # `-d` on a path you can't stat just reads as "not a directory", and an unmatched glob (no
  # nullglob) passes through as a literal, non-existent single "file". Net effect: this function
  # has silently no-op'd for sintra specifically on every single run since whenever her home
  # directory's permissions were tightened past pmoney's reach -- no error, no log line, nothing,
  # exactly the "phantom Weaver"-shaped failure mode (LESSONS_LEARNED.md §2g) this whole mechanism
  # exists to prevent, just one level down: not a persona fabricating tool use, but a maintenance
  # script silently doing nothing while reporting nothing wrong either. Found live 2026-08-26
  # deploying Stage 18's nous-judge skill -- Amy's remote (SSH, native to her own account, no
  # cross-user permission boundary at all) symlinked and restarted correctly; sintra's local
  # (sudo -u) path produced zero output and zero symlink. Fixed by running the entire check/glob/
  # link sequence as $id in one `sudo -u` shell, the same shape sync_amy()'s own SSH heredoc
  # already uses for exactly the same reason -- structurally consistent with the one path that
  # already worked, not a new mechanism.
  sudo -u "$id" bash -s -- "$repo" <<'INNER_SCRIPT' 2>&1 | sed "s/^/[hermes-repo-sync:$id] /"
set -uo pipefail
repo="$1"
live="$HOME/.hermes/skills"
[ -d "$repo/skills" ] || exit 0
mkdir -p "$live"
made=0
for target in "$repo"/skills/*/; do
  name="$(basename "$target")"
  link="$live/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "$link exists and is not a symlink -- leaving it alone, not overwriting real content"
    continue
  fi
  if [ ! -L "$link" ] || [ "$(readlink "$link" 2>/dev/null)" != "$repo/skills/$name" ]; then
    ln -sfn "$repo/skills/$name" "$link"
    made=1
    echo "linked skill '$name'"
  fi
done
[ "$made" -eq 1 ] || echo "skill symlinks already current"
INNER_SCRIPT
}

pmoney_head="$(git -C "$PMONEY_REPO" rev-parse HEAD)"
log "pmoney HEAD is now $pmoney_head"

exit_code=0

for id in "${IDENTITIES[@]}"; do
  repo="/home/$id/HermesAgentV5"

  before="$(sudo -u "$id" git -C "$repo" rev-parse HEAD 2>/dev/null)"
  if [ -z "$before" ]; then
    log "ERROR: could not read $id's HEAD ($repo) — skipping, not restarting anything for $id"
    exit_code=1
    continue
  fi

  if [ "$before" = "$pmoney_head" ]; then
    log "$id already at $pmoney_head — nothing to do"
    sync_skill_symlinks "$id"
    continue
  fi

  log "$id at $before, pmoney at $pmoney_head — pulling ($repo)"
  if ! sudo -u "$id" git -C "$repo" pull --ff-only 2>&1 | sed "s/^/[hermes-repo-sync:$id] /"; then
    log "ERROR: fast-forward pull failed for $id ($repo) — likely a diverged/dirty checkout, needs a human; not restarting anything for $id"
    exit_code=1
    continue
  fi

  after="$(sudo -u "$id" git -C "$repo" rev-parse HEAD)"
  if [ "$after" = "$before" ]; then
    log "$id's pull completed but HEAD didn't move ($after) — not restarting"
    sync_skill_symlinks "$id"
    continue
  fi

  sync_skill_symlinks "$id"
  log "$id now at $after — restarting: ${SERVICES[$id]:-<none configured>}"
  if [ -z "${SERVICES[$id]:-}" ]; then
    log "WARNING: no services configured for $id in SERVICES — nothing to restart, code updated on disk only"
    continue
  fi
  # Restarted ONE AT A TIME, with a pause between each -- NOT in a single
  # `systemctl restart a b c` call. Real incident, 2026-08-14: all three of
  # an identity's services restarting simultaneously each independently
  # call vault-get-secret.sh -> `bw login` at startup; three concurrent
  # logins against that identity's own Vaultwarden account (each internally
  # retrying up to 3x) was enough to trip Vaultwarden's own rate limiter,
  # which then crash-looped the affected service for several minutes
  # (compounding itself -- every automatic restart added more failed
  # login attempts) until manually stopped and given a cooldown window.
  # Staggering means each service's login completes before the next one's
  # starts, the same way a human running these restarts one command at a
  # time never triggered this.
  restart_failed=0
  for svc in ${SERVICES[$id]}; do
    # sudo, not a bare systemctl call: this service runs as User=pmoney
    # (not root), and a non-root `systemctl restart` goes through polkit's
    # D-Bus authorization path, not sudo's -- found live, 2026-08-14, as an
    # interactive "AUTHENTICATING FOR org.freedesktop.systemd1.manage-units"
    # prompt that timed out with no polkit agent available in a headless
    # SSH session to ever answer it. pmoney's passwordless sudo doesn't
    # cover polkit at all; it only ever covered this once `sudo` was
    # actually invoked, same as the `sudo -u sintra`/`sudo -u amy` git
    # calls above.
    if sudo systemctl restart "$svc"; then
      log "$id: restarted $svc"
    else
      log "ERROR: restart failed for $id's $svc — check: systemctl status $svc"
      restart_failed=1
    fi
    sleep 10
  done
  if [ "$restart_failed" -eq 0 ]; then
    log "$id's services restarted cleanly"
  else
    exit_code=1
  fi
done

sync_amy
sync_homed13

exit "$exit_code"
