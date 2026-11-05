# hermes-log-analyst — recreate checklist

**Version:** 2.0.0

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

300s idle threshold (2026-11-04; was 900s like `coder2`/`coder`): when log-analyst stops, the idle-sleep script restarts `super` if the wake worker displaced it, so a short threshold keeps super's downtime short.

## 4. Verify

```bash
# From spark itself:
curl -s http://127.0.0.1:8098/health

# Through the router (either node):
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"log-analyst","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

## 5. Sizing and making room (fixed 2026-11-04)

Until 2026-11-04 this role had never started: `start-log-analyst.sh` ran a 64k context, and
Hermes-4.3-36B is `seed_oss` (64 layers, 8 KV heads, head dim 128), so its f16 KV cache alone was
16GiB on top of 20.27GiB of weights (~37GiB), while the wake worker checked for 29GiB and spark
usually has ~21GiB free. What changed:

- **`start-log-analyst.sh`:** `--ctx-size 16384` with `--flash-attn on --cache-type-k q8_0
  --cache-type-v q8_0`. `hermes-logs.py` sends at most 20,000 chars plus up to 20 history turns and
  asks for 800 tokens, well inside 16k. Measured live: healthy 31s after `systemctl start`,
  22.9GiB resident, a 7k-token firewall-log prompt answered in 101s through the router.
- **Wake worker 1.7.0:** threshold 29 -> 25GiB, and log-analyst may *displace* `super` when memory is
  short: it stops `llama-super` only if super's `/slots` shows no request in flight and it wasn't
  woken in the last 30s, then records it in `~/.hermes/state/wake/log-analyst.displaced`. If
  log-analyst then fails to come up, super is started again at once. A request for `super` while
  log-analyst holds the memory displaces log-analyst the same way (not recorded — an on-demand role
  just waits for its next wake).
- **Idle-sleep 1.1.0:** after stopping an idle log-analyst it restarts whatever it displaced; the
  log-analyst timer's idle threshold is now 300s (was 900s), so super is never down long.
- **`hermes-logs.py` 1.7.0:** falls back to `super` on a 502/503 for log-analyst (the router has no
  fallback of its own), and its analysis timeout is 400s to cover a cold wake.
- **ufw:** spark now allows spark-2 on `8095,8098` (super, log-analyst), so spark-2's router can
  reach it.

Offline checks: `python3 infra/hermes-router/tests/test_wake_displace.py` (run on a Linux node — the
idle-sleep half shells out to bash).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-27 | Initial version — S44's new `log-analyst` role, split off `super`'s own log-analyst duty. |
| 1.1.0 | 2026-11-04 | Added §5 known open issues from a live check: never yet started (wake refused, ~21GiB free vs 29 needed); the 29GiB threshold omits the 16GiB f16 KV cache at ctx 65536 (true need ~37GiB, hermes-logs needs only ~6k tokens); spark ufw lacks 8098 for spark-2; hermes-logs.service still runs pre-S44 code. No config changed. |
| 2.0.0 | 2026-11-04 | §5 rewritten from open issues to the fix: 16k context with q8_0 KV (measured 22.9GiB, 31s load, 101s for a 7k-token prompt), wake-worker displacement of an idle super, idle-sleep restore, hermes-logs fallback to super, ufw 8098 for spark-2. Replaces the prior "left unchanged pending an operator decision" guidance. |
