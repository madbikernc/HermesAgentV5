# hermes-muse — recreate checklist

**Version:** 1.2.0

`muse` — **NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning (stock, text-only load)** as of
IMPLEMENTATION_PLAN.md S44 (2026-10-27). Previously Huihui-Qwen3.6-35B-A3B-abliterated (huihui-ai)
— replaced after S39's dedicated `fleet_muse_contract` suite measured the new candidate at 0.963
(26/27, override 8/9) against the abliterated incumbent's 0.704 (override 3/9, corrected baseline),
the largest gap found across the whole S39 bake-off. Port 8090, `spark-2`. This
file closes S35's tracking gap for this one role, opportunistically, as part of S44 — it was
previously untracked like every other `start-*.sh` on this fleet.

**On-demand since 2026-11-16** (demoted from always-resident — HermesAgentV6
`IMPLEMENTATION_PLAN.md` §6.1/§9.1, direct operator pick among the plan's open items). Trigger:
spark-2 measured at 118Gi/121Gi used, swap maxed 15/15Gi, with `muse`/`omni`/`coder`/`coder2` all
four concurrently resident/awake — demoting `muse` frees its footprint whenever idle rather than
holding it permanently. See §2a below for the wake/idle-sleep setup; `llama-muse.service`'s
`[Install]` section and `Restart=always` are gone (on-demand units aren't boot-enabled, same as
`llama-coder2.service`/`llama-log-analyst.service`) — only the wake worker's own
`sudo systemctl start` should ever bring this backend up now.

**Flagging plainly:** the new checkpoint is NVIDIA stock, not one of this fleet's
`Huihui-*-abliterated` forks. `muse` backs the Minecraft bot fleet's in-character chat — this is the
one S44 swap with a live downstream consumer outside the benchmark suite itself. Watch for new
refusal patterns there; `super`-style abliteration is not what won this role's benchmark, the
model's own override-resistance did, but it's still a real property change worth watching in
production.

## 1. Model file

Already staged on `spark-2` at `/opt/hermes-models/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-
UD-Q4_K_M.gguf` (23,887,023,552 bytes) from the S39 candidate-benchmark run, and already present in
production at `/mnt/hermes-data/models/` with the same filename — no transfer needed.

## 2. Backend service

```bash
# On spark-2:
sudo cp start-muse.sh /opt/llama.cpp/start-muse.sh
sudo chmod +x /opt/llama.cpp/start-muse.sh
sudo cp llama-muse.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart llama-muse.service
```

**Now loaded with `--mmproj` (2026-11-07).** The generic, "unidentified" 1.5GB `mmproj-F16.gguf`
this section used to flag as unconfirmed turned out to self-identify in its own GGUF metadata
(`general.name = Nvidia-Nemotron-3-Nano-Omni-30B-A3B-Reasoning`, `clip.projector_type =
nemotron_v2_vl`) — a `gguf-dump` nobody had actually run, not a real ambiguity. Renamed to
`mmproj-NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-F16.gguf` and wired into `start-muse.sh`.
Live-verified: plain-text `muse_contract`-style calls are unaffected, and vision genuinely works —
but a call against the known-defect `fleet_vision_judge` fixture `hermes_gen_00003_` ("digital
warrior fighting cybernetically enhanced sharks", where the sharks are actually unmodified)
reproduced the exact weakness S39 already measured for this model (`false_pass_rate` 0.714): it
claimed the image "matches the prompt exactly" and that cybernetically enhanced sharks are
present. `muse` is now *capable* of accepting image input — nothing in production routes
vision-judge traffic here, and this result is a reason not to start. See
`infra/model-benchmark/spark2-candidate-results.md`'s Phase 4 vision-candidate summary for the
full comparison against `omni`.

**`--reasoning off` is live-confirmed necessary, not left at default** — see the script's own
comment: a real test call came back with the correct complete answer sitting in
`reasoning_content` while `content` itself was truncated mid-word once `max_tokens` ran out, the
same failure class Muse Glimmer's and gemma's own scripts already documented. This has **not**
been re-verified against the `fleet_muse_contract` suite itself with reasoning off — if
override-resistance regresses there, that's a real open question, not something to assume away.

## 2a. On-demand wake/idle-sleep (2026-11-16)

```bash
# On spark-2:
sudo cp hermes-muse-idle-sleep.service hermes-muse-idle-sleep.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-muse-idle-sleep.timer
sudo systemctl restart hermes-model-wake-worker.service   # picks up the new WAKE_TARGETS entry
```

(`.service`/`.timer` files live in `infra/hermes-router/`, same as every other role's idle-sleep
pair — see that directory's own README §3a.) `hermes-model-wake-worker.py`'s spark-2
`WAKE_TARGETS["muse"]` entry: `required_gib` 35, derived from the model+mmproj's real byte-verified
combined size (23,887,023,552 + 1,587,540,224 = 25,474,563,776 bytes = 23.72GiB) times the same
~1.4535 margin ratio `super`/`coder2` use at `ctx-size 65536` (23.72 * 1.4535 ≈ 34.5, rounded up).
`displaces=("coder", "coder2")` — unlike `coder2`'s own empty tuple, given the real memory pressure
observed at cutover time; both are already on-demand, so neither needs
`RESTORE_AFTER_DISPLACE` — they simply wake again on their own next call.

## 3. Verify

```bash
# From spark-2 itself:
curl -s http://127.0.0.1:8090/health

# Through the router (either node):
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"muse","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

Confirm the reply's `content` field is non-empty (not just `reasoning_content`) — the exact failure
mode `omni`'s own gemma swap hit without `--reasoning off`.

**On-demand round trip (2026-11-16):** after cutover, confirm `systemctl is-active llama-muse`
goes inactive once idle (watch `hermes-muse-idle-sleep.timer`'s ticks, or force one early run via
`systemctl start hermes-muse-idle-sleep.service` once `muse.last_used` is old enough), then send
the §3 router call again and confirm it wakes within `WAKE_TIMEOUT_S` (180s default) and answers —
not just that the unit *starts*, but that `/v1/chat/completions` actually succeeds once it's up.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.2.0 | 2026-11-16 | Demoted `muse` resident -> on-demand (HermesAgentV6 `IMPLEMENTATION_PLAN.md` §6.1/§9.1), triggered by real memory pressure measured on `spark-2` (118Gi/121Gi used, swap maxed). Added §2a (wake-worker `WAKE_TARGETS` entry, idle-sleep timer install) and a verify step for the wake/sleep round trip. `llama-muse.service` lost its `[Install]` section and `Restart=always` -> `on-failure`, matching `llama-coder2.service`/`llama-log-analyst.service`. |
| 1.0.0 | 2026-10-27 | Initial version — S44's `muse` model swap (Huihui-Qwen3.6-35B-A3B-abliterated to NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning), closing S35's tracking gap for this role opportunistically. |
| 1.0.1 | 2026-10-27 | Live-verified fix: `--reasoning off` added after a real test call showed the correct answer landing entirely in `reasoning_content` while `content` itself came back truncated. Not yet re-verified against `fleet_muse_contract` with reasoning off. |
| 1.1.0 | 2026-11-07 | `--mmproj` wired in after confirming (via `gguf-dump`, not assumption) that the previously-"unidentified" `mmproj-F16.gguf` is genuinely this model's own vision projector; renamed to `mmproj-NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-F16.gguf`. `muse` can now accept image input, but a live test against a known-defect `fleet_vision_judge` fixture reproduced the model's already-measured weak judge quality (false_pass_rate 0.714) -- added as a capability, not a recommendation to route vision-judge traffic here. |
