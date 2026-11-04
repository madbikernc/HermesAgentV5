# hermes-log-analyst — recreate checklist

**Version:** 1.1.0

`log-analyst` — **NousResearch Hermes-4.3-36B-Q4_K_M (stock)**, a new role as of
IMPLEMENTATION_PLAN.md S44 (2026-10-27): split off `super`'s own log-analyst duty
(`hermes-logs.py`'s `analyze()` call). S39's dedicated `fleet_log_analyst` suite (18 cases across
pfSense/canary/gameabuse shapes — this role's own real problem domain) measured this candidate at
accuracy 0.750 (9/12), fact-extraction 0.960, against `super`'s 0.375 (3/8), fact-extraction 0.880
on the identical suite. On-demand, port 8098, `spark` — co-located with `super` since it's the same
duty's traffic source, not cross-node like `coder2`.

**Flagging plainly, same as `hermes-coder2`'s and `hermes-muse`'s own S44 entries:** this checkpoint
is not one of this fleet's `Huihui-*-abliterated` forks. `hermes-logs.py`'s own header previously
chose an abliterated backend specifically because "refusals on payload/exploit analysis break
automated pipelines and create silent coverage gaps" — that risk is real in principle, but S39's
suite was built with exactly that content shape in mind and this candidate still won decisively,
which is taken as real evidence over the a-priori heuristic. `super` is untouched and still the
fallback if real refusal gaps show up in production.

## 1. Model file

Already staged on `spark-2` at `/opt/hermes-models/NousResearch_Hermes-4.3-36B-Q4_K_M.gguf`
(21,762,146,144 bytes, 20.27GiB) from the S39 candidate-benchmark run. Transferred to `spark`'s
production models directory (this is spark-2's own benchmark staging area, and `log-analyst` runs
on `spark` alongside `super`):

```bash
# spark2 -> spark, streamed rather than staged twice:
ssh dgx-spark2 "cat /opt/hermes-models/NousResearch_Hermes-4.3-36B-Q4_K_M.gguf" | \
  ssh dgx-spark "cat > /mnt/hermes-data/models/NousResearch_Hermes-4.3-36B-Q4_K_M.gguf"
```

## 2. Backend service

```bash
# On spark:
sudo cp start-log-analyst.sh /opt/llama.cpp/start-log-analyst.sh
sudo chmod +x /opt/llama.cpp/start-log-analyst.sh
sudo cp llama-log-analyst.service /etc/systemd/system/
sudo systemctl daemon-reload
# Deliberately NOT enabled/started here -- like coder2 on spark-2, only the wake worker's
# `systemctl start` should ever bring this up.
```

**Verify `start-log-analyst.sh`'s `--reasoning off` against this specific candidate's real
behavior before trusting it as final** — see the script's own comment.

## 3. Wake worker + idle-sleep

Spark's existing `hermes-model-wake-worker.service` instance already picks up the new
`"log-analyst"` `WAKE_TARGETS` entry (`tools/hermes-model-wake-worker.py` 1.6.0) once redeployed —
no new wake-worker instance needed, unlike `coder2`'s first-on-demand-role situation on `spark-2`.

```bash
# On spark:
sudo cp ../hermes-router/hermes-log-analyst-idle-sleep.service /etc/systemd/system/
sudo cp ../hermes-router/hermes-log-analyst-idle-sleep.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-log-analyst-idle-sleep.timer
```

Same 900s threshold as `coder2`/`coder`.

## 4. Verify

```bash
# From spark itself:
curl -s http://127.0.0.1:8098/health

# Through the router (either node):
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"log-analyst","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

## 5. Known open issues (verified live 2026-11-04)

- **Never yet started on `spark`.** `llama-log-analyst.service` has no journal history at all; every
  wake so far has been refused by the wake worker (`needs ~29GiB free`, spark had ~21GiB with
  `super`, `dispatch`, `embed`, `rerank` resident). A router request for `log-analyst` returns a 503 —
  the router does **not** fall back to `super`.
- **The 29GiB wake threshold undercounts.** It is the 20.27GiB file × ~1.45, which leaves out the KV
  cache. Hermes-4.3-36B is `seed_oss` (64 layers, 8 KV heads, head dim 128): f16 KV is 256KiB/token,
  so `start-log-analyst.sh`'s `--ctx-size 65536` alone needs 16GiB, for a real total near 37GiB.
  `hermes-logs.py`'s own duty sends at most 20,000 chars (~6k tokens) and asks for 800 tokens, so a
  16k context (4GiB f16 KV, ~2GiB at `q8_0`) would cover it. Left unchanged here pending an operator
  decision on how to make room (resize vs. displacing `super` while it runs).
- **spark-2's router cannot reach it.** Spark's ufw allows spark-2 on `8088,8095` and `8097`, not
  `8098` (`infra/hermes-router/README.md` §1).
- **`hermes-logs.service` still predates S44's code** (process started ~2026-10-26), so it is still
  calling `super`. Restarting it before the wake works would turn every analysis into a 503.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-27 | Initial version — S44's new `log-analyst` role, split off `super`'s own log-analyst duty. |
| 1.1.0 | 2026-11-04 | Added §5 known open issues from a live check: never yet started (wake refused, ~21GiB free vs 29 needed); the 29GiB threshold omits the 16GiB f16 KV cache at ctx 65536 (true need ~37GiB, hermes-logs needs only ~6k tokens); spark ufw lacks 8098 for spark-2; hermes-logs.service still runs pre-S44 code. No config changed. |
