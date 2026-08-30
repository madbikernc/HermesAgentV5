#!/usr/bin/env bash
# Version: 2.0.0
#
# 2.0.0 (HermesAgentV4): retargeted from spark's Weaver/Muse to spark-2's Coder/Muse
# (IMPLEMENTATION_PLAN.md §1, §2c, §4d) — found 2026-08-21 in the same sweep that caught
# `hermes-fabrication-guard.sh`'s stale role names, not by the original migration audit. §4d is
# explicit that fine-tuning/abliteration now exclusively borrows memory from spark-2's three
# swappable slots (`omni`/`coder`/`muse`) — spark's backbone (`nano`, the on-demand `super`,
# the broker, the router, Continuwuity) is never paused for this, a structural improvement over
# the predecessor where these tools shared a node with Sintra's own Core. `--free-vision`
# renamed `--free-omni` to match the new role vocabulary everywhere else in this fleet
# (`hermes-model-call.sh`, `skills/model-delegation/`) — the underlying systemd unit it stops is
# still `llama-amy-vision.service`, never renamed (§4b: `omni` carried over from
# `HermesAgentRedo` Stage 7 as-is).
#
# 1.1.0 — real bug fix, found 2026-08-19 setting `heretic` up for real on
# `spark-2` for the first time (it had never actually been installed or run
# anywhere before this — IMPLEMENTATION_PLAN.md's own Stage 7 locked
# decisions already say this script "runs on spark-2 once it exists — still
# the plan, not yet exercised for real"). The Core-liveness check below was
# hardcoded to `llama-sintra-core.service` unconditionally, so running this
# script on `spark-2` (which has `llama-amy-core.service` instead) would
# print a spurious "WARNING: llama-sintra-core.service is not active" on
# every single run, since that unit was never meant to exist there. Fixed
# with the same existence-check-before-warning pattern
# `hermes-finetune-model.sh` already uses for the same class of problem.
#
# Frees enough of spark-2's unified memory to run `heretic` (directional-
# ablation "abliteration" of an open-weight model) against a target Hugging
# Face repo, without ever touching either node's own persona-facing fast core
# (`llama-sintra-core.service`/`llama-nano.service` on `spark`,
# `llama-amy-core.service` on `spark-2`) — see skills/model-abliteration/SKILL.md
# for when/why to use this and infra/model-abliteration/README.md for the
# one-time heretic install.
#
# Stops llama-coder.service and llama-muse.service (never a persona's own core, never
# Omni unless --free-omni is passed) for the duration of the run, then
# restores whatever it stopped — on success, failure, or Ctrl-C alike (the
# EXIT trap runs regardless). Verify these are the real live unit names on
# this node first (`systemctl list-units | grep llama`) — IMPLEMENTATION_PLAN.md
# §4a/§4b documents the port/role table but not every exact unit name, and only
# `llama-amy-vision.service` is independently confirmed in this repo's own
# history (LESSONS_LEARNED.md, IMPLEMENTATION_PLAN.md §6 Stage 2).
#
# heretic itself runs interactively in the foreground (its own end-of-run
# menu — save/upload/chat-test/benchmark — is a deliberate step, not
# something to script around; see SKILL.md's sanity-check checklist for why
# skipping it is a bad idea). This script only brackets that with the
# memory-freeing and service-restore steps.
#
# Usage: hermes-abliterate-model.sh <hf-repo-id> [--free-omni] [-- <extra heretic args>]
#   hermes-abliterate-model.sh Qwen/Qwen3-4B-Instruct-2507
#   hermes-abliterate-model.sh org/some-30b-model --free-omni -- --quantization bnb_4bit
set -euo pipefail

MODEL_ID="${1:?usage: hermes-abliterate-model.sh <hf-repo-id> [--free-omni] [-- <extra heretic args>]}"
shift

FREE_OMNI=0
EXTRA_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --free-omni) FREE_OMNI=1; shift ;;
    --) shift; EXTRA_ARGS=("$@"); break ;;
    *) shift ;;
  esac
done

HERETIC_VENV="${HERETIC_VENV:-/opt/heretic-venv}"
STOPPED=()

log() { echo "[hermes-abliterate-model] $*" >&2; }

restore_services() {
  if [ "${#STOPPED[@]}" -gt 0 ]; then
    log "Restoring stopped services: ${STOPPED[*]}"
    sudo systemctl start "${STOPPED[@]}"
    for svc in "${STOPPED[@]}"; do
      systemctl is-active --quiet "$svc" || log "WARNING: $svc did not come back active — check it by hand"
    done
  fi
}
trap restore_services EXIT

log "Free memory before stopping anything:"
free -h

for svc in llama-coder.service llama-muse.service; do
  if systemctl is-active --quiet "$svc"; then
    log "Stopping $svc"
    sudo systemctl stop "$svc"
    STOPPED+=("$svc")
  fi
done
if [ "$FREE_OMNI" -eq 1 ]; then
  if systemctl is-active --quiet llama-amy-vision.service; then
    log "Stopping llama-amy-vision.service (--free-omni)"
    sudo systemctl stop llama-amy-vision.service
    STOPPED+=("llama-amy-vision.service")
  fi
fi

# Node-agnostic: warn only about whichever persona core actually exists on this
# host. `systemctl cat` fails cleanly for a unit that was never installed
# here, so this stays silent about the other node's core entirely. Also never
# warns about llama-super — it's on-demand by design (§4a), being inactive is
# its normal resting state, not something worth flagging.
for core in llama-sintra-core.service llama-nano.service llama-amy-core.service; do
  if systemctl cat "$core" >/dev/null 2>&1 && ! systemctl is-active --quiet "$core"; then
    log "WARNING: $core is not active — this script never stops it, so if it's down that's unrelated to this run"
  fi
done

log "Free memory after stopping (${STOPPED[*]:-nothing}):"
free -h

log "Launching heretic against $MODEL_ID — interactive; follow its own end-of-run prompts"
source "$HERETIC_VENV/bin/activate"
heretic "$MODEL_ID" "${EXTRA_ARGS[@]}"

log "heretic finished. Restoring services now (also runs automatically via EXIT trap)."
