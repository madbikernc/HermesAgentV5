# hermes-omni — recreate checklist

**Version:** 1.0.0

`omni` — **NVIDIA-Nemotron-3.5-Bolt-74B-A9B (stock)** as of IMPLEMENTATION_PLAN.md S44
(2026-10-27). Previously gemma-4-26B-A4B-it (Google, stock) — replaced after S39's dedicated
`fleet_vision_judge` suite measured the new candidate at precision 0.897, recall 0.963,
false_fail_rate 0.037, against the incumbent's precision 0.846, recall 0.407, false_fail_rate
0.593. Always-resident, port 8091, `spark-2`. This file closes S35's tracking gap for this one
role, opportunistically, as part of S44 — it, and the live unit's `Description=`, were both
untracked/stale before this (the deployed unit kept naming a *different* prior candidate it hadn't
actually run since 2026-09-24; this file's own `llama-omni.service` corrects that in the same
change it was finally brought under version control).

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

## 3. Verify

```bash
# From spark-2 itself:
curl -s http://127.0.0.1:8091/health

# Through the router (either node):
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"omni","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-27 | Initial version — S44's `omni` model swap (gemma-4-26B-A4B-it to NVIDIA-Nemotron-3.5-Bolt-74B-A9B), closing S35's tracking gap for this role opportunistically and fixing the live unit's stale `Description=` in the same change. |
