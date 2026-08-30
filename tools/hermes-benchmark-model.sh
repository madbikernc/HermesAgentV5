#!/usr/bin/env bash
# Version: 1.1.0
#
# 1.1.0 — fetches HF_TOKEN from Vaultwarden ("Hermes - HuggingFace") at the start of every run,
# in-memory only, never written to disk (same rule vault-get-secret.sh itself enforces) — unblocks
# GPQA Diamond, whose dataset is gated on HF. Best-effort: a fetch failure only blocks GPQA Diamond
# specifically, never the other suites. Verified live 2026-08-24 (see infra/model-benchmark/
# README.md §2) against a real Vaultwarden item.
#
# Runs MMLU-Pro/GPQA-Diamond/IFEval/BFCL/SWE-bench (tools/hermes-benchmark-model.py) against
# either a live fleet role (through hermes-router, no service disruption — same as
# hermes-model-call.sh) or a temporary llama-server for a candidate model not yet wired into the
# fleet (a fresh heretic/fine-tune output before promotion, a bake-off contender). See
# skills/model-benchmark/SKILL.md for when to use which mode and
# infra/model-benchmark/README.md for the one-time venv install.
#
# Candidate mode borrows the same free-memory/restore-on-exit pattern
# tools/hermes-abliterate-model.sh and tools/hermes-finetune-model.sh already established for
# this class of job: stops spark-2's swappable resident backend(s) for the duration, never
# either persona's own fast-core service, restores whatever it stopped on success, failure, or
# Ctrl-C alike via an EXIT trap.
#
# Usage:
#   Role mode (benchmark a live fleet backend, no memory freed, no services touched):
#     hermes-benchmark-model.sh --role <nano|super|coder|muse|omni> --model-id <label> \
#         [--endpoint <url>] [--suites mmlu_pro,gpqa_diamond,ifeval,bfcl,swebench] \
#         [--limit N] [--notes "..."] [-- <extra lm_eval args>]
#
#   Candidate mode (benchmark an unpromoted GGUF via a temporary llama-server):
#     hermes-benchmark-model.sh --candidate /path/to/model.gguf --model-id <label> \
#         [--free-omni] [--suites ...] [--limit N] [--notes "..."] [-- <extra lm_eval args>]
#
# Examples:
#   hermes-benchmark-model.sh --role coder --model-id unsloth/Qwen3-Coder-Next-GGUF --limit 50
#   hermes-benchmark-model.sh --candidate /opt/heretic-venv/output/model-Q4_K_M.gguf \
#       --model-id org/some-30b-heretic-output --suites mmlu_pro,ifeval
set -euo pipefail

ROLE=""
CANDIDATE=""
MODEL_ID=""
ENDPOINT="http://127.0.0.1:8080/v1"
FREE_OMNI=0
PASSTHROUGH=()

while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --candidate) CANDIDATE="$2"; shift 2 ;;
    --model-id) MODEL_ID="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --free-omni) FREE_OMNI=1; shift ;;
    --) shift; PASSTHROUGH=("$@"); break ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

log() { echo "[hermes-benchmark-model] $*" >&2; }

if [ -z "$MODEL_ID" ]; then
  log "ERROR: --model-id is required (the real identity to record in history — not auto-detected)"
  exit 1
fi
if [ -z "$ROLE" ] && [ -z "$CANDIDATE" ]; then
  log "ERROR: pass exactly one of --role <name> (live fleet backend) or --candidate <gguf-path> (temporary server)"
  exit 1
fi
if [ -n "$ROLE" ] && [ -n "$CANDIDATE" ]; then
  log "ERROR: --role and --candidate are mutually exclusive"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCHMARK_VENV="${BENCHMARK_VENV:-/opt/benchmark-venv}"

# GPQA Diamond's dataset is gated on HF (infra/model-benchmark/README.md §2); MMLU-Pro/IFEval also
# download faster/without rate-limit warnings with a token set. Fetched fresh from Vaultwarden each
# run, exported in-memory only — never written to disk, same rule vault-get-secret.sh itself
# enforces. Best-effort: a fetch failure only blocks GPQA Diamond specifically (lm_eval reports that
# with a real 401/403, not a fabricated pass), never the other suites.
if [ -z "${HF_TOKEN:-}" ]; then
  if HF_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" 'Hermes - HuggingFace' password 2>/tmp/hermes-benchmark-hf-token.err)"; then
    export HF_TOKEN
    rm -f /tmp/hermes-benchmark-hf-token.err
  else
    log "WARNING: could not fetch HF_TOKEN from Vaultwarden ($(cat /tmp/hermes-benchmark-hf-token.err 2>/dev/null | tail -1)) — proceeding without it; GPQA Diamond will fail with a real 401/403 if it's in --suites"
    rm -f /tmp/hermes-benchmark-hf-token.err
  fi
fi

if [ -n "$ROLE" ]; then
  log "Role mode: benchmarking live '$ROLE' via $ENDPOINT — no services touched"
  source "$BENCHMARK_VENV/bin/activate"
  python3 "$REPO_DIR/tools/hermes-benchmark-model.py" \
    --role "$ROLE" --model-id "$MODEL_ID" --endpoint "$ENDPOINT" "${PASSTHROUGH[@]}"
  exit $?
fi

# --- Candidate mode: temporary llama-server on the freed coder slot (port 8093) ---
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-llama-server}"
CANDIDATE_PORT="${BENCHMARK_CANDIDATE_PORT:-8093}"
CTX_SIZE="${BENCHMARK_CTX_SIZE:-16384}"
STOPPED=()
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "Stopping temporary llama-server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "${#STOPPED[@]}" -gt 0 ]; then
    log "Restoring stopped services: ${STOPPED[*]}"
    sudo systemctl start "${STOPPED[@]}"
    for svc in "${STOPPED[@]}"; do
      systemctl is-active --quiet "$svc" || log "WARNING: $svc did not come back active — check it by hand"
    done
  fi
}
trap cleanup EXIT

if [ ! -f "$CANDIDATE" ]; then
  log "ERROR: candidate GGUF not found: $CANDIDATE"
  exit 1
fi

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

for core in llama-sintra-core.service llama-nano.service llama-amy-core.service; do
  if systemctl cat "$core" >/dev/null 2>&1 && ! systemctl is-active --quiet "$core"; then
    log "WARNING: $core is not active — this script never stops it, so if it's down that's unrelated to this run"
  fi
done

log "Free memory after stopping (${STOPPED[*]:-nothing}):"
free -h

log "Starting temporary llama-server on port $CANDIDATE_PORT for $CANDIDATE"
"$LLAMA_SERVER_BIN" -m "$CANDIDATE" --port "$CANDIDATE_PORT" --host 127.0.0.1 \
  --ctx-size "$CTX_SIZE" >/tmp/hermes-benchmark-candidate-server.log 2>&1 &
SERVER_PID=$!

log "Waiting for candidate server health check..."
# -f: llama-server's own /health returns 503 ("loading model") while it's still coming up, not
# a connection error — without -f, plain curl treats that 503 response as success (exit 0) since
# it only fails on connection-level errors by default, which would let this loop declare the
# server healthy before the model has actually finished loading.
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:${CANDIDATE_PORT}/health"; then
    break
  fi
  sleep 2
done
if ! curl -sf -o /dev/null "http://127.0.0.1:${CANDIDATE_PORT}/health"; then
  log "ERROR: candidate server never came up — check /tmp/hermes-benchmark-candidate-server.log"
  exit 1
fi

log "Candidate server healthy. Running benchmark suite."
source "$BENCHMARK_VENV/bin/activate"
python3 "$REPO_DIR/tools/hermes-benchmark-model.py" \
  --role candidate --model-id "$MODEL_ID" \
  --endpoint "http://127.0.0.1:${CANDIDATE_PORT}/v1" "${PASSTHROUGH[@]}"
RESULT=$?

log "Benchmark run finished. Tearing down candidate server and restoring services now (also runs automatically via EXIT trap)."
exit $RESULT
