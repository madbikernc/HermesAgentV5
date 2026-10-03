# Qwen4 (`Qwen3.8-Flash`) as a `coder` Replacement — Bake-off Runbook

**Version:** 1.0.0

Runbook for re-running the `coder` bake-off now that `qwen4exp` architecture support exists in
llama.cpp — the thing that crashed the original `coder2` candidate (`IMPLEMENTATION_PLAN.md`
4.1.0, `unknown model architecture: 'qwen4exp'`, 3,556 crash-loop restarts) and forced the bake-off
to resolve in the incumbent's favor without ever producing a real score.

**Written from a session with no network path to `spark`/`spark-2`** (cloud container, home LAN
not reachable) — every command below is unexecuted. Run it from a session with real shell access
to `spark`, in order, and update this file's own version/history when it's actually run.

## 0. Why this is possible now, and two things to verify before trusting old state

- **`qwen4exp` support is real and released**, independently re-checked 2026-10-03: PR
  [#27742](https://github.com/ggml-org/llama.cpp/pull/27742) ("model: add Qwen3.8-Flash-Next
  (qwen4exp)") merged to `ggml-org/llama.cpp` master and shipped in **release `v0.4.0`**.
  **Verify the exact tag against <https://github.com/ggml-org/llama.cpp/releases> before pulling**
  — this repo's own `infra/model-watch/alert-state.json` seed cites the PR only (not enough to act
  on, per that tool's own rule), and a sibling V4 tracking file separately cited build tag
  `b10760` for the same event. Neither was re-verified against the Releases page in this pass with
  full confidence on the exact build number — `v0.4.0` is the one confirmed live here; pin to
  whatever tag is actually current when step 1 runs, not a hardcoded number.
- **Current incumbent**, from `tools/hermes-router.py`'s live `ROLES` table: `coder` =
  **Qwen3.8-27B-abliterated**, on-demand, on **`spark`**, port **8094**.
- **Naming collision — do not call the new candidate `coder2`.** In this repo (unlike V4, where
  `coder2` meant the crashed `qwen4exp` candidate), `coder2` is now a real, separate, already-
  promoted production role: **Muse-Glimmer-30B** (Meta, stock), on `spark-2` port 8099, the second
  reviewer in `hermes-dualcoder.py`'s cross-review workflow (`infra/hermes-coder2/README.md`). Pick
  any other label for history/model-id purposes (e.g. the plain HF repo id) — reusing `coder2`
  here would be a real, confusing identity collision with a live role.

## 1. Update llama.cpp on `spark`

`coder` runs on `spark`, so that's the node whose build needs `v0.4.0`+ (`infra/model-abliteration/
README.md` §3's rebuild procedure):

```bash
# On spark:
cd ~/llama.cpp   # confirm with `which llama-server` first
git fetch --tags
git checkout v0.4.0   # or newer — check the Releases page per §0 above
cmake --build build121 --config Release -j$(nproc)
```

## 2. Get the candidate model

Prefer the **production** release over the crashed preview — same architecture and size class
(125B total / 6B active MoE + 51B n-gram embedding + 4B MTP in both), so this is not a re-sizing
exercise, just a better-tuned checkpoint:

- Preview (what crashed before): `Qwen/Qwen3.8-Flash-Next`
- Production (what to actually bake off): `Qwen/Qwen3.8-Flash`

**No specific GGUF quant repo for the production release is confirmed here** — search Hugging Face
live at execution time (`unsloth`/`bartowski` are this fleet's usual GGUF sources for other roles)
rather than trusting a hardcoded URL. Pick an **IQ4_XS or UD-Q4_K_XL quant (~93–110GB)**, not
Q4_K_M (~110–120GB) — `spark` has 128GB unified memory total, and the smaller quant leaves real
headroom for KV cache/context instead of cutting it to ~8–18GB.

```bash
# On spark, byte-verify before download (same content-length gate every model file in this fleet
# goes through — see infra/hermes-coder2/README.md §1 for the pattern):
curl -sI "https://huggingface.co/<org>/Qwen3.8-Flash-GGUF/resolve/main/<quant-file>.gguf" | grep -i content-length
```

## 3. Baseline the incumbent first — no score exists yet

The original `coder`-vs-`Coder-Next` decision (`hermes-router.py` 2.1.0) was made by informal
execution testing, not this benchmark harness — there's nothing in shared history to compare
against yet. Role mode is read-only against `hermes-router`, safe to run any time, no disruption:

```bash
# On spark:
~/HermesAgentV5/tools/hermes-benchmark-model.sh --role coder \
  --model-id Qwen/Qwen3.8-27B-abliterated --suites mmlu_pro,gpqa_diamond,ifeval

~/HermesAgentV5/tools/hermes-benchmark-model.sh --role coder \
  --model-id Qwen/Qwen3.8-27B-abliterated --suites bfcl \
  --bfcl-endpoint http://127.0.0.1:8094/v1 \
  --bfcl-model-name Qwen/Qwen3-30B-A3B-Instruct-2507-FC --bfcl-test-category simple_python
```

## 4. Benchmark the candidate — run this from `spark`, not `spark-2`

`tools/hermes-benchmark-model.sh` 1.1.0's candidate mode only stops `llama-coder.service`/
`llama-muse.service` (+ `llama-amy-vision.service` with `--free-omni`) — it has **no knowledge of
`llama-coder2.service`**. Running candidate mode on `spark` stops the real incumbent (`coder`)
cleanly and restores it on exit, same as any other candidate run. Running it on `spark-2` instead
would free `muse` but leave `coder2` (Muse-Glimmer) unaccounted for by the script — don't do that
without updating the stop list first.

```bash
# On spark:
~/HermesAgentV5/tools/hermes-benchmark-model.sh --candidate /path/to/Qwen3.8-Flash-IQ4_XS.gguf \
  --model-id Qwen/Qwen3.8-Flash --suites mmlu_pro,gpqa_diamond,ifeval,bfcl \
  --bfcl-model-name Qwen/Qwen3-30B-A3B-Instruct-2507-FC --bfcl-test-category simple_python
```

## 5. SWE-bench — from `HomeD13`, against whichever node holds each port

Per `infra/model-benchmark/README.md` §4, SWE-bench needs `x86_64` and only runs from `HomeD13`.
The incumbent's endpoint is `spark`'s real LAN IP at :8094; the candidate's is the temporary
candidate port (8093, same node, while step 4's run is active):

```bash
# From HomeD13, against the incumbent:
python3 tools/hermes-benchmark-model.py --role coder --model-id Qwen/Qwen3.8-27B-abliterated \
  --endpoint http://<spark-LAN-IP>:8094/v1 --suites swebench --limit 5

# From HomeD13, against the candidate (only while step 4's temporary server is up):
python3 tools/hermes-benchmark-model.py --role candidate --model-id Qwen/Qwen3.8-Flash \
  --endpoint http://<spark-LAN-IP>:8093/v1 --suites swebench --limit 5
```

`coder`'s port (8094) isn't yet in the `HomeD13`-reachable firewall allowlist (only `nano`/`super`
were opened, per `skills/model-benchmark/SKILL.md`) — add the matching `ufw` rule on `spark` first,
same pattern as the existing `nano`/`super` one.

## 6. Compare

```bash
~/HermesAgentV5/tools/hermes-benchmark-compare.py \
  --model-id Qwen/Qwen3.8-Flash --against Qwen/Qwen3.8-27B-abliterated
```

Treat BFCL as an approximation (no exact registry match for either model) and SWE-bench as
provisional (single-turn patch generation, not a full agent scaffold) — same caveats
`skills/model-benchmark/SKILL.md` already documents for every run through this harness.

## 7. If the candidate wins

Update `tools/hermes-router.py`'s `ROLES` table (`coder` entry, both the `spark` and `spark-2`
branches) to point at the new model's real backend, redeploy the `start-coder.sh`/
`llama-coder.service` pair with the new GGUF path, and record the promotion in
`IMPLEMENTATION_PLAN.md` the same way the original `coder`-vs-`Coder-Next` decision was recorded.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-03 | Initial version — runbook for re-running the `coder` bake-off against production `Qwen3.8-Flash` now that `qwen4exp` support has shipped in a real llama.cpp release, written from a session with no fleet network access for a session that has one to execute. |
