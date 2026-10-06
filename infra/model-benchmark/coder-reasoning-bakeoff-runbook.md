# `coder` reasoning-on vs. reasoning-off — bake-off runbook, and the coder2-replacement question

**Version:** 1.0.0

**Written from a session with no network path to `spark`/`spark-2`** (cloud container, home LAN
unreachable — confirmed live, including port 22, not assumed) — **every command below is
unexecuted.** Run it from a session with real shell access to `spark`, in order, and update this
file's own version/history when it's actually run, same discipline
`qwen4-coder-bakeoff-runbook.md` already follows for the same constraint.

## 0. What's already known, and the one real gap in it

- **Current incumbent**, from `tools/hermes-router.py`'s live `ROLES` table: `coder` =
  **Qwen3.8-27B-abliterated** (dense), on-demand, on `spark`, port **8094**, started with
  `--reasoning off` (confirmed in this repo only by inference from `infra/hermes-coder2/
  start-coder2.sh`'s own comment — `coder`'s actual `start-coder.sh` is **not tracked in this
  repo**, same untracked-on-spark gap that file's header already names. Read the real, live
  `start-coder.sh` on `spark` before touching anything — don't assume the flag is there or spelled
  the way this runbook guesses).
- **Qualitative result on record**: `tools/hermes-dualcoder.py`'s own header says Qwen3.8-27B-
  abliterated "passed all twelve correctness checks" and "wins ifeval/mmlu_pro decisively" against
  `coder2` in the original bake-off. **No exact numbers are recorded for `coder` anywhere in this
  repo** — unlike `super` (`mmlu_pro=0.614, ifeval=0.72`) and `muse` (`mmlu_pro=0.749,
  ifeval=0.893, bfcl=0.008`), `coder`'s `model_registry` row has never had a real `eval_ref`
  attached (`IMPLEMENTATION_PLAN.md` 1.11.0's own changelog only closed this gap for `super`/
  `muse`). **Step 2 below closes that gap as a side effect**, not just this runbook's own purpose.
- **The one precise number that exists for the coder2 question**: BFCL, **92.00% (coder2) vs.
  37.00% (coder)** — `infra/hermes-coder2/start-coder2.sh`'s own header. This is the actual
  decisive metric behind "asymmetric, not redundant" — it's the number any reasoning-on claim
  needs to move to matter.

## 1. Verify the real reasoning-toggle mechanism — don't assume a flag exists

Unlike Muse Glimmer (`coder2`), Qwen3.8-27B is a Qwen3-family model, which `llama.cpp` is known to
expose a reasoning/think-tag control for — but **confirm the actual flag and its actual semantics
live**, the same way `start-coder2.sh`'s own header refuses to copy `--reasoning off` onto Muse
Glimmer "on faith":

```bash
# On spark:
which llama-server && llama-server --help 2>&1 | grep -i -A2 reason
cat ~/HermesAgentV5/../start-coder.sh 2>/dev/null || systemctl cat llama-coder.service   # find the real, live invocation
```

Confirm from this: the exact flag name, whether it's a binary on/off or has a third mode (e.g. an
effort level), and whether `--reasoning off` is a hard disable or just a default-off with the model
still capable of emitting `reasoning_content` when prompted to. Do not proceed past this step on an
assumption.

## 2. Reasoning-OFF baseline — refresh it with real numbers, not prose

```bash
source /opt/benchmark-venv/bin/activate
cd ~/HermesAgentV5

# mmlu_pro + ifeval, through hermes-router (role mode, no service disruption):
python3 tools/hermes-benchmark-model.py --role coder \
  --model-id "Qwen3.8-27B-abliterated-reasoning-off" \
  --endpoint http://127.0.0.1:8080/v1 --suites mmlu_pro,ifeval --limit 100

# BFCL needs coder's own llama-server port directly, never the router (README.md §3) —
# nearest registry match for a Qwen3 dense model, confirm with `bfcl models` first:
REMOTE_OPENAI_BASE_URL=http://127.0.0.1:8094/v1 REMOTE_OPENAI_API_KEY=EMPTY \
  bfcl generate --model Qwen/Qwen3-30B-A3B-Instruct-2507-FC --test-category simple_python \
  --skip-server-setup --result-dir /tmp/coder-reasoning-off/result
bfcl evaluate --model Qwen/Qwen3-30B-A3B-Instruct-2507-FC --test-category simple_python \
  --result-dir /tmp/coder-reasoning-off/result --score-dir /tmp/coder-reasoning-off/score
cat /tmp/coder-reasoning-off/score/data_overall.csv
```

Record the result against `model_registry` with a real `eval_ref` (`POST /models` via
`hermes-memory`, same shape S9/S11 already used for `super`/`muse`) — this closes the
never-recorded gap noted in §0 regardless of what §3 below finds.

## 3. Reasoning-ON run — same weights, same role, flag flipped

`coder` is a live, always-on-demand role with real callers — this is not "candidate mode"
(`hermes-benchmark-model.sh --candidate`, for an unpromoted GGUF on a temporary port). It's the
same weights, same port, same role, with one runtime flag changed. Treat it with the same
restore-on-exit discipline `hermes-benchmark-model.sh`'s own candidate mode already uses, since
nothing automates it for this specific case:

```bash
# On spark:
sudo systemctl stop llama-coder.service
# Edit the real start-coder.sh (confirmed live in §1) to remove/flip the reasoning flag per
# what §1 actually found — do not guess the exact syntax here.
sudo systemctl start llama-coder.service   # or run start-coder.sh by hand if iterating
curl -sf http://127.0.0.1:8094/health      # wait for healthy before benchmarking

# Then re-run §2's exact three commands with --model-id "Qwen3.8-27B-abliterated-reasoning-on"
# and a separate /tmp/coder-reasoning-on/ result dir.
```

**Also measure, not just score** — this is the operationally decisive part, independent of
benchmark accuracy:

- **Real tok/s and real latency** for a representative review-sized call, not just the benchmark
  harness's own timing. `LESSONS_LEARNED.md` §3a's "hidden reasoning is expensive by default"
  finding (6000 hidden tokens burned on a trivial prompt, measured on this hardware family) and
  the documented speed cliff at large context mean this fleet has a real, measured reason to
  expect reasoning-on to cost much more than the benchmark's own pass/fail numbers show.
- **Truncation risk at this pipeline's actual budgets.** Run one real `review()`/`revise()`-shaped
  call (same `max_tokens` `tools/hermes-dualcoder.py` actually uses — 2000 draft / 8000 review /
  10000 revise) directly against `coder` with reasoning on, and check for the exact failure mode
  `call_model()` was built to catch: empty `content`, non-empty `reasoning_content`,
  `finish_reason == "length"`. This is the thing that forced three straight budget revisions
  (1.0.1→1.0.3) for `coder2` — confirm whether `coder` would need the same treatment before
  assuming its current budgets still work with reasoning on.

## 4. Restore before finishing

```bash
sudo systemctl stop llama-coder.service
# Revert start-coder.sh to its original reasoning-off invocation.
sudo systemctl start llama-coder.service
curl -sf http://127.0.0.1:8094/health
# Confirm a real hermes-dualcoder.py task still runs end-to-end afterward — don't just trust the
# health check, the same "ask the running thing" discipline this fleet uses elsewhere.
```

## 5. The coder2-replacement question

### What the benchmark can actually settle

Compare reasoning-on `coder`'s BFCL score (§3) against the recorded **92.00% (coder2) / 37.00%
(coder, reasoning-off)** pair. If reasoning-on doesn't close most of that gap, the question is
settled on capability grounds alone — `coder2` stays. If it does close the gap substantially, move
to the next part — a closed benchmark gap is necessary but not sufficient here.

### What no benchmark number changes

Two structural costs apply regardless of what §3 finds, and this fleet has already weighed one of
them explicitly, in a different stage, for the same trade:

1. **It removes the only non-abliterated model from the coding/security-review path.**
   `IMPLEMENTATION_PLAN.md`'s S18 entry records this exact cost as an *accepted consequence*, not a
   discovered one, when a different change would have also retired `coder2`: "It also removes the
   only non-abliterated model from the coding path, leaving no stock-alignment baseline in a loop
   whose output is a security verdict." `coder` is abliterated; `coder2`/Muse Glimmer is "stock"
   (`tools/hermes-router.py`'s own `ROLES` table literally labels it so). Replacing `coder2` with
   `coder`+reasoning means both sides of `run_security_phase()`'s two "independent" security
   reviews are the same abliterated checkpoint — a real, already-flagged-elsewhere regression, not
   a new concern invented for this runbook.
2. **It's the same weights reviewing themselves, not a second model.** `hermes-dualcoder.py`'s
   entire premise is that `coder`/`coder2` are "genuinely asymmetric, not redundant" — two
   differently-trained models with uncorrelated blind spots. A reasoning-mode toggle changes how
   `coder` reasons, not what it was trained on; `coder` reviewing `coder`'s own draft (even across
   a role-prompt swap) is strictly closer to self-review than to cross-review, independent of
   whatever accuracy number it posts. The round-swap identity trick in `run_bug_loop()` (reviewer
   becomes writer) only works as a check *because* the reviewer is a genuinely different model —
   collapsing both roles onto one checkpoint's two inference modes weakens that by construction.

**Recommendation:** treat §3's benchmark result as a gate, not a verdict. Even a fully closed BFCL
gap is a necessary condition for considering this, not a sufficient one — the stock-diversity loss
and the self-review-not-cross-review problem are standalone reasons to keep a second,
architecturally distinct model in the security-review loop regardless of score.

## Known gaps, not yet closed

- The exact reasoning-toggle flag/semantics for Qwen3.8-27B on this fleet's `llama.cpp` build is
  unverified from this session — §1 must be run for real before any other step here is trustworthy.
- `coder`'s `model_registry` row has never carried a real `eval_ref` — §2 is the first chance to
  close that, independent of whether §3/§5 change anything.
- Nothing in this runbook has been executed. No real score, no real tok/s number, no real
  truncation check exists yet for either configuration.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-06 | Initial version — written to answer a direct request to run the reasoning-on-vs-off bake-off for `coder` and evaluate replacing `coder2` with it, from a session confirmed to have no network path to `spark`/`spark-2` (verified live, including port 22). Unexecuted; mirrors `qwen4-coder-bakeoff-runbook.md`'s own pattern for the same constraint. |
