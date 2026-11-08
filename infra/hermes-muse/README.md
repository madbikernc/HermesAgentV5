# hermes-muse — recreate checklist

**Version:** 1.1.0

`muse` — **NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning (stock, text-only load)** as of
IMPLEMENTATION_PLAN.md S44 (2026-10-27). Previously Huihui-Qwen3.6-35B-A3B-abliterated (huihui-ai)
— replaced after S39's dedicated `fleet_muse_contract` suite measured the new candidate at 0.963
(26/27, override 8/9) against the abliterated incumbent's 0.704 (override 3/9, corrected baseline),
the largest gap found across the whole S39 bake-off. Always-resident, port 8090, `spark-2`. This
file closes S35's tracking gap for this one role, opportunistically, as part of S44 — it was
previously untracked like every other `start-*.sh` on this fleet.

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

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-27 | Initial version — S44's `muse` model swap (Huihui-Qwen3.6-35B-A3B-abliterated to NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning), closing S35's tracking gap for this role opportunistically. |
| 1.0.1 | 2026-10-27 | Live-verified fix: `--reasoning off` added after a real test call showed the correct answer landing entirely in `reasoning_content` while `content` itself came back truncated. Not yet re-verified against `fleet_muse_contract` with reasoning off. |
| 1.1.0 | 2026-11-07 | `--mmproj` wired in after confirming (via `gguf-dump`, not assumption) that the previously-"unidentified" `mmproj-F16.gguf` is genuinely this model's own vision projector; renamed to `mmproj-NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-F16.gguf`. `muse` can now accept image input, but a live test against a known-defect `fleet_vision_judge` fixture reproduced the model's already-measured weak judge quality (false_pass_rate 0.714) -- added as a capability, not a recommendation to route vision-judge traffic here. |
