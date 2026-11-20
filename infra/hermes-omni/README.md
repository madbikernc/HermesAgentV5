# hermes-omni — recreate checklist

**Version:** 1.1.0

`omni` — **NVIDIA-Nemotron-3.5-Bolt-74B-A9B (stock)** as of IMPLEMENTATION_PLAN.md S44
(2026-10-27). Previously gemma-4-26B-A4B-it (Google, stock) — replaced after S39's dedicated
`fleet_vision_judge` suite measured the new candidate at precision 0.897, recall 0.963,
false_fail_rate 0.037, against the incumbent's precision 0.846, recall 0.407, false_fail_rate
0.593. Port 8091, `spark-2`. This file closes S35's tracking gap for this one
role, opportunistically, as part of S44 — it, and the live unit's `Description=`, were both
untracked/stale before this (the deployed unit kept naming a *different* prior candidate it hadn't
actually run since 2026-09-24; this file's own `llama-omni.service` corrects that in the same
change it was finally brought under version control).

**On-demand since 2026-11-19** (demoted from always-resident — direct operator request, S39
self-repair coding-capability follow-up). Trigger: a 45.9GiB `coder` candidate
(Qwen3-Coder-Next-UD-Q4_K_M) had nowhere to fit on spark-2 with every backend — `coder2`, `muse`,
and `omni` — pinned either resident or on-demand-but-undisplaceable. Same pattern as `muse`'s own
2026-11-16 demotion: `llama-omni.service`'s `[Install]` section and `Restart=always` are gone (now
`Restart=on-failure`, matching `llama-coder2.service`/`llama-muse.service`) — only the wake
worker's own `sudo systemctl start` should ever bring this backend up now. See §2a below.

**Flagging plainly:** `omni` backs the live `fleet_vision_judge` role — unlike `reflector`'s
idle-sleep timer, this one is a real, exercised path, not a template. A vision-judge call that
lands while `omni` is cold now pays a real wake latency (model load time) it never used to; this
hasn't been measured yet (see §3's open verification item). If that latency becomes a problem for
whatever calls `fleet_vision_judge` in practice, that's a real tradeoff to revisit, not a bug.

## 1. Model file

Model + mmproj already staged on `spark-2` at `/opt/hermes-models/` from the S39
candidate-benchmark run. Copy into production:

```bash
# On spark-2:
cp /opt/hermes-models/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf \
   /mnt/hermes-data/models/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf
cp /opt/hermes-models/mmproj-NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf \
   /mnt/hermes-data/models/mmproj-NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf
```

gemma-4-26B-A4B-it-UD-Q4_K_M.gguf and its mmproj are left in place (not deleted) in case this
decision is revisited.

## 2. Backend service

```bash
# On spark-2:
sudo cp start-omni.sh /opt/llama.cpp/start-omni.sh
sudo chmod +x /opt/llama.cpp/start-omni.sh
sudo cp llama-omni.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart llama-omni.service
```

**Verify `start-omni.sh`'s `--reasoning off` against this specific candidate's real behavior
before trusting it as final** — copied from the incumbent's own script on the same "a reasoning
model without it can return empty content" reasoning, not re-derived from a fresh check of this
exact checkpoint.

## 2a. On-demand wake/idle-sleep (2026-11-19)

```bash
# On spark-2:
sudo cp hermes-omni-idle-sleep.service hermes-omni-idle-sleep.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-omni-idle-sleep.timer
sudo systemctl restart hermes-model-wake-worker.service   # picks up the new WAKE_TARGETS entry
```

(`.service`/`.timer` files live in `infra/hermes-router/`, same as every other role's idle-sleep
pair — see that directory's own README §3a.) `hermes-model-wake-worker.py`'s spark-2
`WAKE_TARGETS["omni"]` entry: `required_gib` 33, derived from the model+mmproj's real
byte-verified combined size (22,018,326,528 + 1,733,692,736 = 23,752,019,264 bytes = 22.12GiB)
times the same ~1.4535 margin ratio `super`/`coder2`/`muse` use at `ctx-size 65536`
(22.12 * 1.4535 ≈ 32.1, rounded up). `displaces=("coder", "coder2", "muse")`, matching
`reflector`'s own victim set — all three are already on-demand, so none need
`RESTORE_AFTER_DISPLACE`.

## 3. Verify

```bash
# From spark-2 itself:
curl -s http://127.0.0.1:8091/health

# Through the router (either node):
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"omni","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

**On-demand round trip (2026-11-19):** after cutover, confirm `systemctl is-active llama-omni`
goes inactive once idle (watch `hermes-omni-idle-sleep.timer`'s ticks, or force one early run via
`systemctl start hermes-omni-idle-sleep.service` once `omni.last_used` is old enough), then send
the router call above again and confirm it wakes within `WAKE_TIMEOUT_S` (180s default) and
answers — not just that the unit *starts*, but that `/v1/chat/completions` actually succeeds once
it's up. Not yet measured: the real wake latency a `fleet_vision_judge` caller now pays on a cold
hit, now that this role isn't guaranteed resident.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.0 | 2026-11-19 | Demoted `omni` resident -> on-demand (direct operator request, S39 self-repair coding-capability follow-up): spark-2 had no free headroom for a 45.9GiB `coder` candidate while every backend stayed pinned resident/undisplaceable. Added §2a (wake-worker `WAKE_TARGETS` entry, idle-sleep timer install) and a verify step for the wake/sleep round trip. `llama-omni.service` lost its `[Install]` section and `Restart=always` -> `on-failure`, matching `llama-coder2.service`/`llama-muse.service`. |
| 1.0.0 | 2026-10-27 | Initial version — S44's `omni` model swap (gemma-4-26B-A4B-it to NVIDIA-Nemotron-3.5-Bolt-74B-A9B), closing S35's tracking gap for this role opportunistically and fixing the live unit's stale `Description=` in the same change. |
