# hermes-coder2 — recreate checklist

**Version:** 1.0.0

`coder2` — Meta's Muse Glimmer 30B (stock, Apache-2.0), the second coding backend for
`tools/hermes-dualcoder.py`'s cross-review workflow. Deployed on **`spark-2`**, deliberately not
alongside `coder` on `spark` — see `tools/hermes-router.py` 2.10.0's own changelog for why
(memory-bandwidth isolation between the two coding backends, and keeping the review traffic off
`spark`'s always-resident `dispatch` role). This is `spark-2`'s **first on-demand role** — until now
it only ran always-resident `muse`/`omni`, so several pieces here (the wake worker, idle-sleep timer)
are genuinely new territory on this node, not copies of something already running there.

## 1. Model file

Real bake-off used `bartowski/Muse-Glimmer-30B-GGUF`'s `Muse-Glimmer-30B-Q4_K_M.gguf`
(byte-verified 17,306,324,000 bytes via a live HF content-length check before download — the same
gate every model file in this fleet goes through). Move the already-downloaded bake-off copy from
`spark` to `spark-2` rather than re-downloading:

```bash
# On spark, verify before moving:
sha256sum /mnt/hermes-data/models/bakeoff/Muse-Glimmer-30B-Q4_K_M.gguf

# Transfer to spark-2 — the fabric SSH aliases (network-planes.md) are a good fit for a one-time
# ~16GB move:
rsync -avP /mnt/hermes-data/models/bakeoff/Muse-Glimmer-30B-Q4_K_M.gguf \
  spark2-fabric:/mnt/hermes-data/models/Muse-Glimmer-30B-Q4_K_M.gguf

# On spark-2, confirm identical:
sha256sum /mnt/hermes-data/models/Muse-Glimmer-30B-Q4_K_M.gguf
```

## 2. Backend service

```bash
# On spark-2:
sudo cp start-coder2.sh /opt/llama.cpp/start-coder2.sh
sudo chmod +x /opt/llama.cpp/start-coder2.sh
sudo cp llama-coder2.service /etc/systemd/system/
sudo systemctl daemon-reload
# Deliberately NOT enabled/started here -- like coder on spark, only the wake worker's
# `systemctl start` should ever bring this up.
```

**Verify `start-coder2.sh`'s flags against Muse Glimmer's own real behavior before trusting it** —
it does not include `coder`'s own `--reasoning off` flag (that's tied to Qwen3.8's specific
think-tag behavior, not copied on faith since Muse Glimmer is a different architecture with its own
documented multi-step-reasoning design). Start it manually once and confirm real, coherent output
before wiring it into the wake worker.

## 3. Firewall — opposite direction from `coder`'s own rule

`coder`'s existing cross-node rule only lets `spark-2` reach `spark`. This is the reverse: `spark`'s
router (and `hermes-dualcoder.py`, which runs on `spark`) need to reach `coder2` here. On `spark-2`:

```bash
sudo ufw allow from 10.129.1.15 to any port 8099 proto tcp comment 'hermes-router: spark -> coder2'
```

## 4. Wake worker — new on this node

`spark-2` needs its own instance of `tools/hermes-model-wake-worker.py`, scoped to `coder2` only,
polling the same central broker (which stays on `spark` regardless of caller):

```bash
# On spark-2, service environment must set:
#   HERMES_NODE=spark-2
#   BROKER_TOKEN=<same broker-token vault item spark's own worker uses>
# WAKE_TARGETS resolves to just {"coder2": (...)} on this branch (hermes-model-wake-worker.py 1.3.0).
```

Install a wrapper/unit mirroring whatever `spark`'s own wake-worker deployment uses (not tracked in
this repo — same untracked-on-spark gap `start-coder.sh`/`llama-coder.service` have), with
`HERMES_NODE=spark-2` set explicitly.

**This depends on `hermes-broker.py` 1.4.0's new `roles` claim filter** — without it, two wake-worker
instances (spark's targeting `nano`/`super`/`coder`, this one targeting `coder2`) polling the same
`type=wake` queue would occasionally race for each other's jobs, adding latency and, in the worst
case, risking a job exhausting its retry budget before the right worker ever claims it. Confirm the
broker is actually running 1.4.0+ before enabling this second instance.

## 5. Idle-sleep

```bash
sudo cp ../hermes-router/hermes-coder2-idle-sleep.service /etc/systemd/system/
sudo cp ../hermes-router/hermes-coder2-idle-sleep.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-coder2-idle-sleep.timer
```

Same 900s threshold as `coder`. Residual risk, not solved here (see `tools/hermes-dualcoder.py`'s
own header): this is pure wall-clock with no in-flight-request awareness. As long as
`hermes-dualcoder.py` calls `coder2` through the router (never the raw port), every round's call
resets the idle clock via `wake_role()` — the only exposure left is a single generation running
longer than ~15-20 minutes.

## 6. Verify

```bash
# From spark-2 itself:
curl -s http://127.0.0.1:8099/health

# From spark, once the ufw rule is applied -- the real cross-node path the router uses:
curl -s http://10.129.1.17:8099/health

# Through the router (either node), once ROLES is deployed:
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"coder2","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-05 | Initial version — `coder2` deployment checklist for the dual-coder review orchestrator's second reviewer. |
