# hermes-log-analyst — recreate checklist

**Version:** 1.0.0

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

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-27 | Initial version — S44's new `log-analyst` role, split off `super`'s own log-analyst duty. |
