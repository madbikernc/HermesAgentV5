# hermes-model-scan — recreate checklist

**Version:** 1.0.1

Weekly check for new open-weight LLM and image/video model releases (`tools/hermes-model-scan.py`),
filtered against what this fleet's actual hardware can run, emailing The Boss a summary. Not part of
the 11-22 smart-home roadmap — a standalone weekly task, same tier as `hermes-nfsensei-watch.timer`.

Deterministic parts (fetching Hugging Face Hub listings, sizing candidates, checking for existing
abliterated/heretic builds) are plain code against the HF Hub API — no web search, no LLM involved in
establishing any fact. Only the final recommendation paragraph goes through the fleet's own router
(`tools/hermes-router.py`, `model: "nano"`), same split `hermes-nfsensei-watch.py` already uses. See
`tools/hermes-model-scan.py`'s own docstring for why this replaced v1's raw `hermes cron create`
agent-prompt design (`HermesAgent` repo, job `e2129522d168`) rather than porting it as-is.

## Install

```bash
sudo cp hermes-model-scan.service hermes-model-scan.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-model-scan.timer
```

Runs Monday 08:00, matching v1's original schedule. Adjust `OnCalendar` if a different day/time is
wanted — nothing else depends on the specific slot.

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-model-scan.py --dry-run
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-model-scan.py
```

`--dry-run` prints what would be emailed instead of sending it and leaves the state file untouched —
safe to run repeatedly while testing.

## Verify

```bash
systemctl list-timers hermes-model-scan.timer
journalctl -u hermes-model-scan.service --no-pager
cat ~pmoney/.hermes/state/model_scan_state.json
```

## Hardware-fit heuristic

Same numbers as `IMPLEMENTATION_PLAN.md` §4a/§4b and `LESSONS_LEARNED.md` §3a:

- **Spark**: ~0.75GB per billion parameters at Q4_K_M. Under ~31GB (current headroom against the four
  resident backends) → fits alongside them. Under ~105GB (usable ceiling) → fits only if a non-Core
  backend is stopped first. Above that → out of reach.
- **HomeD13**: no reliable parameter-count-based estimate for diffusion repos (weights split across
  UNet/VAE/text-encoder) — reported with a "verify before downloading" note instead, same discipline
  `IMPLEMENTATION_PLAN.md` §6 Stage 6 already applies to every new diffusion model.

These are heuristics, not guarantees — a model with no `safetensors` metadata on its HF listing is
reported as "size unknown," not silently dropped or guessed at.

## Requires

- `tools/hermes-model-scan.py`, `tools/vault-get-secret.sh` on the Spark.
- `python3-requests` (plain apt package — no venv needed; unlike `hermes-nfsensei-watch.py` this tool
  doesn't need `beautifulsoup4`, since the HF Hub API returns structured JSON directly).
- `hermes-router.service` running and reachable at `127.0.0.1:8080`.
- Vault item `email-sintra` (already provisioned — same one `hermes-fleet-health.py` and
  `hermes-nfsensei-watch.py` use).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-13 | Initial version. Ports the weekly open-weight model scan capability forward from `HermesAgent` (v1), redesigned as a deterministic HF-API-based tool rather than a raw agent-prompt cron job, per the fabrication-risk lesson already established in `LESSONS_LEARNED.md` §2g-§2j. |
