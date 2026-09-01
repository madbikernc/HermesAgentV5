# hermes-model-watch — recreate checklist

**Version:** 1.0.0

Weekly check for new llama.cpp architecture support relevant to this fleet's watched model
families (`tools/hermes-model-watch.py`) — currently GLM-5.3, plus the two Qwen4 variants already
found to fail on this build (`qwen4exp`, `qwen4_flash`) — emailing The Boss only when something
real changes.

Built 2026-09-01 on direct request ("does the fleet have a scheduled task to check for a patched
llama.cpp that can support GLM 5.3?"). `alert-state.json` in this directory already existed with
real historical data (a genuine llama.cpp PR URL for `qwen4exp`, a seeded list of GLM-5.3 Hugging
Face repo IDs) — but no script, systemd unit, or timer anywhere in this repo or its V4 predecessor
ever produced or updated it. The capability was designed (the file's own shape makes the intent
obvious) but never actually built. This is that build.

Two independent, both-deterministic checks, no LLM involved — same reasoning
`tools/hermes-model-scan.py`'s own header documents for keeping facts out of the model's hands:

1. **Architecture enum diff** — compares this fleet's real local llama.cpp checkout
   (`/opt/llama.cpp` on Spark) against upstream `ggml-org/llama.cpp`'s current `src/llama-arch.h`
   on GitHub. Generic, not GLM-specific — surfaces any new architecture the local build lacks,
   with a pointer to the real rebuild procedure (`infra/model-abliteration/README.md` §3). Only
   `git fetch`, never `git pull`/`checkout` — this script never touches the working tree or the
   running build; rebuilding stays a separate, deliberate human action.
2. **Watched-term PR search** — GitHub's public search API, scoped to `ggml-org/llama.cpp`, for
   each name in `WATCHED_TERMS`. Catches support landing under a naming convention the enum diff
   wouldn't obviously match, and gives earlier visibility into an open (not yet merged) PR.

A third, lower-stakes check tracks new GLM-5.3-named GGUF repos on Hugging Face — informational
only (a GGUF existing doesn't mean llama.cpp can load it).

**As of 2026-09-01 (the day this was built, checked live):** GLM-5.3 architecture support does not
exist anywhere yet — not in this fleet's local checkout, not in upstream llama.cpp's own `master`
branch either. There is genuinely nothing to catch up on today; this script exists to notice the
moment that changes, not to pretend it already has.

## Install

```bash
sudo cp hermes-model-watch.service hermes-model-watch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-model-watch.timer
```

Runs Monday 08:15, 15 minutes after `hermes-model-scan.timer`'s own 08:00 slot — avoids both
weekly jobs contending for the router/email at the same moment. Adjust `OnCalendar` if a different
day/time is wanted.

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-model-watch.py --dry-run
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-model-watch.py
```

`--dry-run` prints what would be emailed instead of sending it and leaves the state file
untouched — safe to run repeatedly while testing.

## State

Runtime state lives at `~/.hermes/state/model_watch_state.json` (not git-tracked), same location
convention `hermes-model-scan.py`'s own state file uses. On its very first run, if that file
doesn't exist yet, it migrates the real historical data out of this directory's own
`alert-state.json` (the `qwen4exp` PR already found, the seeded GLM-5.3 HF-repo list) rather than
re-alerting on facts already known. The architecture-diff check also baselines silently on its
first run — local was already ~2.5 weeks behind upstream when this was built, which would
otherwise flood the first email with every commit's worth of unrelated new architectures; only
genuinely new gap entries on later runs are reported.

`alert-state.json` itself stays in git as the historical seed/reference, unchanged by the running
service.

## Verify

```bash
systemctl list-timers hermes-model-watch.timer
journalctl -u hermes-model-watch.service -n 30 --no-pager
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-01 | Initial version — the actual build of a capability that was designed (via `alert-state.json`) but never implemented in either this repo or its V4 predecessor. |
