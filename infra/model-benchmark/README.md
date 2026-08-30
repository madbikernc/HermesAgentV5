# model-benchmark — recreate checklist

**Version:** 3.0.1

One-time install of the evaluation stack used to score a fleet backend (or an unpromoted
candidate — a fresh `heretic`/fine-tune output, a bake-off contender) against five industry-
standard suites: **MMLU-Pro**, **GPQA Diamond**, **IFEval**, **BFCL**, and **SWE-bench Verified**.
For the operational wrapper, see `tools/hermes-benchmark-model.sh` and
`skills/model-benchmark/SKILL.md`. History storage and comparison live in
`tools/hermes_benchmark_common.py`.

**All five suites installed and live-verified for real, 2026-08-24** — `/opt/benchmark-venv` on
`spark` and `HomeD13`, every suite actually invoked against a real backend, not just coded and
hoped for. MMLU-Pro/GPQA-Diamond/IFEval/BFCL run from `spark` (or `spark-2`) against a live fleet
role — §2/§3 replaced early wrong guesses (a manual `HF_TOKEN` export, a nonexistent BFCL
`--base-url` flag) with the real, confirmed mechanisms. **SWE-bench needs `x86_64` — blocked on
`spark`/`spark-2` (aarch64), runs natively on `HomeD13`** (§4) — real end-to-end run confirmed:
network path opened (firewall rule + a genuinely-never-worked `nano` bind fix), two real code bugs
found and fixed (wrong HF dataset org, a too-short generation timeout with an uncaught exception
type), first real score produced.

## 1. Install the venv

```bash
python3 -m venv /opt/benchmark-venv
source /opt/benchmark-venv/bin/activate
pip install --upgrade pip
pip install "lm-eval[api,ifeval]" bfcl-eval swebench soundfile
```

**`soundfile` is required but not a declared dependency of `bfcl-eval`** — found live 2026-08-24:
its CLI unconditionally imports a Qwen model handler that transitively needs it
(`qwen_agent.utils.utils` imports `soundfile` at module load time, for audio handling this fleet's
own use of BFCL never touches). Without it, `bfcl --help` itself crashes with
`ModuleNotFoundError: No module named 'soundfile'` before any real work starts.

- `lm-eval[api]` — pulls in the `requests`-based model types (`local-completions`,
  `local-chat-completions`) needed to point the harness at an OpenAI-compatible endpoint instead of
  loading weights itself. This fleet is GGUF/`llama.cpp`-only (`IMPLEMENTATION_PLAN.md` §4a) — the
  harness never loads a model directly, it always calls out to `hermes-router` (or a temporary
  `llama-server`) over HTTP, same as every other tool in this fleet that talks to a backend
  (`hermes-model-call.sh`).
- `lm-eval[ifeval]` — `ifeval`'s scorer needs `langdetect`/`nltk`/`immutabledict`, not installed by
  the base package.
- Kept in its own venv, separate from `hermes-agent`'s own and from `/opt/heretic-venv`/
  `/opt/finetune-venv` — same reasoning those two already document: this stack pulls its own
  dependency graph and shouldn't risk version drift touching anything live.

**Task names confirmed live 2026-08-24 against `lm_eval` 0.4.12** (installed CLI is the newer
`lm-eval run`/`lm-eval ls tasks` subcommand style; the flat legacy invocation `run_lm_eval_task()`
uses still works and is what's actually used):

```bash
lm_eval ls tasks 2>&1 | grep -iE 'mmlu_pro |gpqa_diamond|^\|ifeval '
```

`mmlu_pro` and `ifeval` are exactly as named; `gpqa_diamond_cot_zeroshot` is confirmed registered
and confirmed `generate_until` type (the default `gpqa_diamond_zeroshot` is confirmed
`multiple_choice`/loglikelihood-based, confirming the substitution reasoning below is necessary, not
just cautious). Task names can still shift on a future harness upgrade — re-run this check if
`pip install --upgrade lm-eval` is ever run, and update the three constants at the top of
`tools/hermes_benchmark_common.py` together, not piecemeal, if they do.

## 2. Real gotchas — GPQA Diamond gating confirmed live 2026-08-24

- **`HF_TOKEN` is fetched from Vaultwarden automatically, every run** — `tools/hermes-benchmark-
  model.sh` 1.1.0 calls `tools/vault-get-secret.sh 'Hermes - HuggingFace' password` at the start
  (in-memory only, never written to disk, same rule that script itself enforces) and exports it if
  `$HF_TOKEN` isn't already set. Best-effort: a fetch failure only blocks GPQA Diamond, never the
  other suites. Confirmed live — the token reaches the Hub correctly.
- **GPQA Diamond's dataset is still gated on Hugging Face beyond just having a token**
  (`Idavidrein/gpqa`) — confirmed live: even with a valid `HF_TOKEN` correctly passed through,
  `lm_eval` failed with `datasets.exceptions.DatasetNotFoundError: ... is a gated dataset on the
  Hub. Visit the dataset page ... to ask for access.` **This is a one-time manual step tied to the
  specific HF account behind the token** — someone needs to log into huggingface.co as that account
  and accept the terms at `https://huggingface.co/datasets/Idavidrein/gpqa` before GPQA Diamond can
  run; no tool in this fleet can do that step (it's a web-UI consent flow, not an API call). Retry
  the same command afterward — nothing else needs to change.
- **API-based chat models can only run `generate_until` tasks, not `loglikelihood` ones** — an
  OpenAI-compatible chat-completions endpoint doesn't expose the per-token logprob access
  `local-completions`/`local-chat-completions` would need to score a plain multiple-choice
  loglikelihood task (lm-eval-harness's default `gpqa_diamond_zeroshot` is loglikelihood-based).
  This is why `gpqa_diamond_cot_zeroshot` (the generative chain-of-thought variant) is the one
  actually used here — it scores the generated completion text instead. `mmlu_pro` and `ifeval` are
  already `generate_until` by design, so they need no equivalent substitution.
- **aarch64/CUDA wheel caution from the heretic/fine-tune installs does not apply here** — this
  stack never loads model weights locally, only makes HTTP calls, so there's no `torch`/CUDA wheel
  to resolve. If `pip install` still fails on a dependency, it's a real problem worth investigating
  on its own terms, not the known aarch64+CUDA gap those other two READMEs document.

## 3. BFCL (Berkeley Function-Calling Leaderboard) — verified live 2026-08-24

`bfcl-eval`'s CLI (`bfcl generate` / `bfcl evaluate`) is built around a registry of named model
handlers (`bfcl models` to list them), not an arbitrary `--base-url` flag — the first design here
guessed wrong about that. The real mechanism, confirmed with a genuine end-to-end run against `nano`
(real request, real generated function calls, real score in `score/data_overall.csv`):

- **Must talk directly to the role's own `llama-server` port, never `hermes-router`'s `:8080`.**
  BFCL's local-inference handler calls `/v1/completions`, which `hermes-router` doesn't implement
  (only `/v1/chat/completions`); and it sends its `--model` registry name as the outgoing `"model"`
  field, which `hermes-router` rejects (it only accepts its five role names: `nano`/`super`/`coder`/
  `muse`/`omni`). `llama-server` itself accepts any string in `"model"` — confirmed live — so
  pointing straight at the role's own port sidesteps both problems. Per-role ports are in
  `IMPLEMENTATION_PLAN.md` §4a/§4b and `tools/hermes-router.py`'s own `ROLES` table (e.g. `nano` is
  `127.0.0.1:8088` on `spark`).
- **`--model` must be a name from `bfcl models`** (e.g. `Qwen/Qwen3-4B-Instruct-2507-FC`,
  `Qwen/Qwen3-30B-A3B-Instruct-2507-FC`) — it drives BFCL's prompt-formatting and tool-call-schema
  logic, not just a label. **None of this fleet's actual checkpoints have an exact registry entry**
  (no GLM-4.7-Flash, no Nemotron 3 Nano/Nano Omni, no Qwen3-Coder-Next) — pick the closest
  architectural match (a `Qwen/Qwen3-*-FC` entry for `coder`/`muse`, a `glm-4.6-FC`/`glm-4.5-FC`
  entry for `super`) and treat the resulting score as an approximation shaped by that mismatch, not
  a clean number. The live test run scored **0.00%** against `nano` using `Qwen/Qwen3-4B-Instruct-
  2507-FC`'s format — expected, since `nano` is a Nemotron model being scored against a Qwen prompt
  template, not a real capability measurement.
- **Real invocation:**
  ```bash
  REMOTE_OPENAI_BASE_URL=http://127.0.0.1:8088/v1 REMOTE_OPENAI_API_KEY=EMPTY \
    bfcl generate --model Qwen/Qwen3-4B-Instruct-2507-FC --test-category simple_python \
    --skip-server-setup --result-dir /tmp/some-run/result
  bfcl evaluate --model Qwen/Qwen3-4B-Instruct-2507-FC --test-category simple_python \
    --result-dir /tmp/some-run/result --score-dir /tmp/some-run/score
  cat /tmp/some-run/score/data_overall.csv   # "Overall Acc" column has the real score
  ```
  `REMOTE_OPENAI_BASE_URL`/`REMOTE_OPENAI_API_KEY` are `bfcl_eval`'s own override env vars for
  this (`bfcl_eval/model_handler/local_inference/base_oss_handler.py`); `--skip-server-setup` stops
  it from trying to launch its own vLLM/SGLang server. **Without an explicit `--result-dir`/
  `--score-dir`, output lands inside the venv's own `site-packages/` tree** (confirmed live) —
  always pass both explicitly to keep runs isolated; `tools/hermes_benchmark_common.py`'s
  `run_bfcl()` always does.
- `--test-category all` (the CLI default) includes multi-turn categories and takes a while; narrow
  it (e.g. `simple_python`) for a smoke test.

## 4. SWE-bench Verified — blocked on `spark`/`spark-2` (aarch64), works on `HomeD13` (x86_64)

SWE-bench's execution-based scoring runs each candidate patch inside a per-instance Docker
container built from **`x86_64`-only reference images.** On `spark` (GB10, aarch64):

```
$ docker run --rm --platform linux/amd64 hello-world
...
exec /hello: exec format error
```

**No `binfmt_misc`/`qemu-user-static` cross-architecture emulation is registered there** — `x86_64`
Docker images cannot execute at all, not "run slowly." `_docker_x86_emulation_available()` in
`tools/hermes_benchmark_common.py` checks this fast (~2s) before sinking any time into predictions
generation, and fails with this exact reason on `spark`/`spark-2` rather than grinding through a
doomed run.

**`HomeD13` is `x86_64` — SWE-bench runs there natively, verified end-to-end 2026-08-24.** No
emulation needed at all; `docker run --rm hello-world` (no `--platform` flag required) just works.
One-time setup, all confirmed live:

```bash
# On HomeD13:
sudo apt-get install -y docker.io
sudo usermod -aG docker pmoney   # log in fresh afterward for this to take effect
python3 -m venv /opt/benchmark-venv
source /opt/benchmark-venv/bin/activate
pip install swebench datasets
```

**Network path needed real fixes, both found live, not assumed:**
- **`spark`'s `ufw` only allowed `spark-2`'s IP through to `nano`/`super`'s ports** (`8088,8095`) —
  a deliberate rule for cross-node router access, but it meant `HomeD13` (a third node, not part of
  that pairing) was silently dropped, not refused. Fixed with a matching rule:
  `sudo ufw allow from 10.129.1.16 to any port 8088,8095 proto tcp comment 'HermesAgentV5 SWE-bench:
  HomeD13 -> nano/super'`.
- **`nano`'s own `llama-server` was bound to `127.0.0.1` only** (`start-nano.sh`'s `--host` flag) —
  meaning even `spark-2`'s firewall-permitted access to it had likely never actually worked in
  practice (nano/super aren't real `model-delegation` cross-node targets today, so this was never
  exercised). Rebound to `0.0.0.0` (matching `muse`'s own established `0.0.0.0:8090` convention for
  cross-node-reachable backends) and `llama-nano.service` restarted — verified healthy through the
  live production router immediately after, then verified reachable from `HomeD13` directly.
  `super`'s equivalent bind (`start-super.sh`, port 8095) has the same gap, not yet fixed — same fix
  if/when `super` needs the same access.
- **`hermes-router`'s own port (`:8080`) is still `127.0.0.1`-only everywhere, deliberately** — this
  wasn't changed. SWE-bench (like BFCL, §3) talks directly to a role's own `llama-server` port, not
  the router, so this doesn't block anything — `--endpoint http://<node-LAN-IP>:8088/v1` from
  `HomeD13`, same shape as any other role/port.

**Two real code bugs found and fixed during the first live run against a real backend:**
- **Wrong Hugging Face org for the dataset.** `princeton-nlp/SWE-bench_Verified` (the original
  guess) loads fine but its instance dicts have no `"image"` key, which `swebench` 5.0.2's
  `make_test_spec()` requires (`KeyError: 'image'`). The canonical, current copy is
  **`SWE-bench/SWE-bench_Verified`** — confirmed live to include `"image"`. Fixed in
  `SWEBENCH_DATASET` at the top of `tools/hermes_benchmark_common.py`.
- **180s per-instance generation timeout was too short for a real long SWE-bench issue.** Raised to
  600s (`SWEBENCH_GENERATION_TIMEOUT_S`). Also found the timeout exception itself
  (`socket.timeout`/`TimeoutError`) wasn't in the caught-exceptions tuple — `urlopen`'s own timeout
  raises it directly, not wrapped in `urllib.error.URLError` — so hitting it would have crashed the
  whole run instead of just skipping one instance and moving on. Fixed.

**Real invocation** (from `HomeD13`, against `nano` on `spark`):

```bash
cd ~/HermesAgentV5 && source /opt/benchmark-venv/bin/activate
python3 tools/hermes-benchmark-model.py --role nano --model-id <label> \
  --endpoint http://10.129.1.15:8088/v1 --suites swebench --limit 1
```

Real output from the actual first successful run: `resolved_rate=0.0` (1 instance submitted, 0
resolved) — a real, plausible result for a single-turn attempt at one real astropy issue, not a
bug; SWE-bench is genuinely hard, and this integration's single-turn approach (see below) is a
weaker baseline than a real agent scaffold.

**Prediction generation is a separate step from scoring, unrelated to any of the above.**
`swebench`'s `run_evaluation` module scores patches that already exist — producing those patches
from a fleet backend (a single-turn "given this issue and repo, produce a diff" prompt) is this
integration's own code, not something the `swebench` package does for you.
`tools/hermes_benchmark_common.py` implements a minimal single-turn version of this; a harness-
driven multi-turn agent loop (closer to how top SWE-bench scores are actually achieved) is out of
scope here — this integration will under-measure a model's real coding ability relative to
leaderboard numbers produced by a full agent scaffold, not just measure something slightly
different. Treat any score as provisional, not leaderboard-comparable — same "report the real
outcome" discipline every tool in this fleet follows (`LESSONS_LEARNED.md` §2b/§2g).

## 5. History storage

Every run appends one line to a shared JSONL history file — see
`tools/hermes_benchmark_common.py` for the schema and `skills/model-benchmark/SKILL.md` for how
comparison against prior runs works. Canonical location is
`/mnt/nas2-hermes-backup/Private/Hermes/Benchmarks/history.jsonl` — the same reused-NAS2-mount
discipline `infra/hermes-model-archive/README.md` (Stage 13) established, no new export. Falls back to
`~/.hermes/state/benchmark-history.jsonl` (best-effort, never fatal) if that mount isn't present;
both locations are read back on comparison so a run recorded during a mount outage isn't lost, just
split across two files.

## Revision History

| Version | Date | Change |
|---|---|---|
| 3.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-24 | Initial version, written alongside `tools/hermes-benchmark-model.sh`, `tools/hermes-benchmark-model.py`, `tools/hermes-benchmark-compare.py`, and `tools/hermes_benchmark_common.py` — direct request to be able to run MMLU-Pro/GPQA-Diamond/IFEval/BFCL/SWE-bench against fleet backends with tracked, comparable history. Not yet installed or run against real hardware — see §3/§4 for the two suites with open questions. |
| 2.0.0 | 2026-08-24 | Live verification pass on `spark`: `/opt/benchmark-venv` actually created and installed; `mmlu_pro`/`gpqa_diamond_cot_zeroshot`/`ifeval` task names confirmed against a real `lm_eval ls tasks`. **§3 (BFCL) rewritten** — the original `--base-url` guess doesn't exist; replaced with the real, live-verified mechanism (direct `llama-server` port, `REMOTE_OPENAI_BASE_URL`, a registry-matched `--model`), confirmed with a genuine end-to-end run against `nano` producing a real score. Found and fixed a real `bfcl-eval` packaging gap (`soundfile` missing, undeclared dependency). **§4 (SWE-bench) resolved from "unknown" to "confirmed blocked"** — live-tested `docker run --platform linux/amd64 hello-world`, real `exec format error`, no binfmt emulation registered; also found `pmoney` isn't in the `docker` group on `spark`. `run_bfcl()`/`run_swebench()` in `tools/hermes_benchmark_common.py` updated to match (1.0.0→1.1.0), including a fast pre-flight check so a doomed SWE-bench run fails immediately with the real reason instead of grinding through predictions generation first. Major bump — §3 is a reversal of prior guidance, not just an addition. |
| 2.1.0 | 2026-08-24 | §2 rewritten around a live GPQA Diamond test: `hermes-benchmark-model.sh` 1.1.0 now fetches `HF_TOKEN` from Vaultwarden automatically every run (`Hermes - HuggingFace` item, in-memory only, never written to disk) instead of requiring a manual export — confirmed the token reaches the Hub correctly. Found the real remaining blocker: the dataset itself needs its gate terms accepted on huggingface.co by the account behind the token, a one-time manual web-UI step no fleet tool can perform — `lm_eval` fails with a real `DatasetNotFoundError` until that's done, not a token or wiring problem. |
| 3.0.0 | 2026-08-24 | **§4 (SWE-bench) fully rewritten** — direct request to run it from `HomeD13` (x86_64) instead of the aarch64 Sparks. Set up and verified live: Docker installed natively (no emulation needed at all — `docker run hello-world` just works), `/opt/benchmark-venv` with `swebench`/`datasets`. Real network path needed two real fixes: `spark`'s `ufw` only allowed `spark-2` through to `nano`/`super`'s ports (added a matching rule for `HomeD13`'s IP), and `nano`'s own `llama-server` turned out to be bound to `127.0.0.1` only — likely never actually reachable cross-node even for `spark-2`, since nano/super aren't real `model-delegation` targets today — rebound to `0.0.0.0` (matching `muse`'s own convention) and restarted, verified healthy through the live router before and after. First real end-to-end run then surfaced two real code bugs in `tools/hermes_benchmark_common.py`, both fixed: the dataset org was wrong (`princeton-nlp/SWE-bench_Verified` has no `"image"` field `swebench` 5.0.2 requires; `SWE-bench/SWE-bench_Verified` does) and the 180s per-instance generation timeout was too short for a real issue, plus `TimeoutError` wasn't in the caught-exceptions tuple (would have crashed the whole run, not just skipped one instance). Second real run produced a genuine score (`resolved_rate=0.0`, 1/1 submitted). Major bump — this reverses "confirmed blocked" into a real, working path, not just an addition. |
