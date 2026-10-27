# hermes-muse — recreate checklist

**Version:** 1.0.0

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

**Loaded text-only, deliberately — no `--mmproj`.** `muse`'s duty has no vision requirement, and
the candidate's own S39 caveat flagged this as worth checking: a generic, unidentified 1.5GB
`mmproj-F16.gguf` was found during staging but never confirmed as this model's own file, so it is
not wired in here. If vision is ever needed for this role, re-derive the matching mmproj from the
real release first rather than assuming that file is it.

**Verify `start-muse.sh`'s `--reasoning` choice against real behavior before trusting it as
final** — see the script's own comment. This candidate is deliberately left at its default
reasoning behavior, unlike every other backend on this fleet, since it's explicitly the
"-Reasoning" variant S39 benchmarked.

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
