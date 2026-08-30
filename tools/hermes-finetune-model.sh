#!/usr/bin/env bash
# Version: 2.0.0
#
# 2.0.0 (HermesAgentV4): retargeted from spark's Weaver/Muse to spark-2's Coder/Muse
# (IMPLEMENTATION_PLAN.md §1, §2c, §4d) — same fix, same reason, and found in the same sweep as
# tools/hermes-abliterate-model.sh's own 2.0.0 change; see that file's header for the full
# rationale. `--free-vision` renamed `--free-omni` to match this fleet's new role vocabulary;
# the underlying unit it stops is still `llama-amy-vision.service`, never renamed.
#
# Frees enough of a node's unified memory to run a LoRA/QLoRA fine-tune
# (tools/hermes-finetune-train.py) against local documents, without ever
# touching either persona's own fast-core service -- see
# skills/model-finetuning/SKILL.md for when/why and
# infra/model-finetuning/README.md for the one-time venv install.
#
# Same operational shape as tools/hermes-abliterate-model.sh, this project's
# own precedent for this class of job: stops spark-2's swappable resident
# backend(s) for the duration, runs the training script in the foreground
# (human-attended, not a timer-triggered service), restores whatever it
# stopped on success, failure, or Ctrl-C alike via an EXIT trap.
#
# Node-agnostic, unlike the abliteration script (spark-2 only by design, §4d)
# -- this stops llama-coder.service/llama-muse.service; neither exists on
# spark, so nothing there is stopped unless --free-omni is passed (stops
# llama-amy-vision.service). Never stops llama-sintra-core.service/
# llama-nano.service or llama-amy-core.service, on either node -- if freeing
# enough memory would require stopping a persona's own fast core, that's a
# sign to use the other node, not to work around it here.
#
# Usage: hermes-finetune-model.sh <hf-repo-id> <data-dir> <output-dir> [--free-omni] [-- <extra train.py args>]
#   hermes-finetune-model.sh Qwen/Qwen3.6-35B-A3B ~/finetune-data/regs /mnt/hermes-data/adapters/regs-v1
#   hermes-finetune-model.sh Qwen/Qwen3.6-35B-A3B ~/finetune-data/regs /mnt/hermes-data/adapters/regs-v1 \
#       --free-omni -- --epochs 2 --lora-r 32
set -euo pipefail

MODEL_ID="${1:?usage: hermes-finetune-model.sh <hf-repo-id> <data-dir> <output-dir> [--free-omni] [-- <extra args>]}"
DATA_DIR="${2:?usage: hermes-finetune-model.sh <hf-repo-id> <data-dir> <output-dir> [--free-omni] [-- <extra args>]}"
OUTPUT_DIR="${3:?usage: hermes-finetune-model.sh <hf-repo-id> <data-dir> <output-dir> [--free-omni] [-- <extra args>]}"
shift 3

FREE_OMNI=0
EXTRA_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --free-omni) FREE_OMNI=1; shift ;;
    --) shift; EXTRA_ARGS=("$@"); break ;;
    *) shift ;;
  esac
done

FINETUNE_VENV="${FINETUNE_VENV:-/opt/finetune-venv}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOPPED=()

log() { echo "[hermes-finetune-model] $*" >&2; }

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
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    log "Stopping $svc"
    sudo systemctl stop "$svc"
    STOPPED+=("$svc")
  fi
done
if [ "$FREE_OMNI" -eq 1 ]; then
  if systemctl is-active --quiet llama-amy-vision.service 2>/dev/null; then
    log "Stopping llama-amy-vision.service (--free-omni)"
    sudo systemctl stop llama-amy-vision.service
    STOPPED+=("llama-amy-vision.service")
  fi
fi

# Warn (don't touch) if a persona's own fast core is down -- only meaningful for whichever
# one actually exists on this host; systemctl cat fails cleanly for one
# that doesn't, so this stays silent about the other node's core. Never warns about
# llama-super -- it's on-demand by design (§4a), inactive is its normal resting state.
for core in llama-sintra-core.service llama-nano.service llama-amy-core.service; do
  if systemctl cat "$core" >/dev/null 2>&1 && ! systemctl is-active --quiet "$core"; then
    log "WARNING: $core is not active — this script never stops it, so if it's down that's unrelated to this run"
  fi
done

log "Free memory after stopping (${STOPPED[*]:-nothing}):"
free -h

mkdir -p "$OUTPUT_DIR"
log "Launching fine-tune: model=$MODEL_ID data=$DATA_DIR output=$OUTPUT_DIR"
source "$FINETUNE_VENV/bin/activate"
python3 "$REPO_DIR/tools/hermes-finetune-train.py" \
  --model "$MODEL_ID" --data-dir "$DATA_DIR" --output "$OUTPUT_DIR" "${EXTRA_ARGS[@]}"

log "Training finished. Restoring services now (also runs automatically via EXIT trap)."
