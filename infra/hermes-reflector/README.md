# hermes-reflector — recreate checklist

**Version:** 1.0.0

`reflector` — **GLM-5.3-Flash-Q2-DGX-Spark (stock)** as of HermesAgentV6
`IMPLEMENTATION_PLAN.md`'s GLM-5.3-Flash Paradigm A, Phase 2 (2026-11-16). Port 8093, `spark-2`
only, on-demand. A GEPA reflection/candidate-generator backend for
`tools/hermes-gepa-coder-fix.py`/`-build.py` — **not** an interactive tier. This exact checkpoint
already ran once as `super` (S31) and returned **NO-GO** (6.1-6.8 tok/s contended, template
defaults `reasoning_effort=max`); placing it here is a different use case for the same already-
downloaded weights, not a reversal of that finding.

**Flagging plainly:** this role is called only by direct `--endpoint` from the GEPA harness
scripts, never through the router's own chat path in practice — it's registered in
`tools/hermes-router.py` for `/v1/models` visibility and consistency with every other role, not
because production traffic routes here.

## 1. Model file

Already on disk on `spark-2` at `/mnt/hermes-data/models/glm-5.3-flash-bakeoff/` — a two-shard
split GGUF, byte-verified `GLM-5.3-Flash-Q2-DGX-Spark-00001-of-00002.gguf` (44,984,916,000 bytes)
+ `-00002-of-00002.gguf` (39,944,534,144 bytes) = 84,929,450,144 bytes (79.10 GiB). Pass only the
first shard to `--model`; llama.cpp auto-loads the second (standard split-GGUF naming). Not
registered in `~/.hermes/config/model-archive-roles.json` on `spark-2` — that config only covers
the old coder2 incumbent and `muse`'s two files as of this writing; out of scope for this change
to expand.

## 2. Backend service

```bash
# On spark-2:
sudo cp start-reflector.sh /opt/llama.cpp/start-reflector.sh
sudo chmod +x /opt/llama.cpp/start-reflector.sh
sudo cp llama-reflector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start llama-reflector.service   # on-demand: no enable, matches coder/coder2/muse
```

No `[Install]` section and `Restart=on-failure` (not `always`) deliberately — same discipline
`llama-coder.service`/`llama-muse.service` already use: this must never auto-start at boot or
auto-restart after the idle-sleep timer stops it, only an explicit `systemctl start` (or the wake
worker, for any caller that ever goes through the router) should bring it up.

**`reasoning_effort` mechanism — resolved live 2026-11-16, not assumed.** The open question this
plan's Phase 2 step 1 called out (does a per-request field actually reach GLM-5.3's chat
template, or is a different mechanism needed) is answered: llama-server exposes a genuine
per-request JSON override on `/v1/chat/completions`, confirmed by manually launching this exact
checkpoint on port 8093 and testing directly, before any systemd unit existed:

- No override, 300 `max_tokens`: `reasoning_content` ate ~1332 characters, `content` came back
  truncated mid-word ("...spilling ribbons of crimson and amber across"), 18.2s wall time for 300
  tokens ≈ 16.5 tok/s generation — reproduces S31's own measured 16.5-16.6 tok/s isolated figure
  and its exact NO-GO failure mode.
- `"reasoning_effort": "low"` in the request body: `reasoning_content` empty, `content` complete
  and well-formed, 32 tokens in 2.36s. A longer 201-token completion measured the same ~16.4 tok/s
  raw generation rate — confirming the field doesn't change raw speed, it eliminates the hidden-
  reasoning token burn that was causing truncation.

`tools/hermes_coder_fix_common.py`/`hermes_coder_build_common.py`'s `call_backend()` already
sends this field via its `extra_body` hook (Phase 1) — so `start-reflector.sh` deliberately does
**not** set a CLI-level `--reasoning-effort` default; the GEPA harness is this role's only real
caller and it already passes the override itself every time.

## 2a. On-demand wake/idle-sleep

```bash
# On spark-2:
sudo cp hermes-reflector-idle-sleep.service hermes-reflector-idle-sleep.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-reflector-idle-sleep.timer
sudo systemctl restart hermes-model-wake-worker.service   # picks up the new WAKE_TARGETS entry
```

(`.service`/`.timer` files live in `infra/hermes-router/`, same as every other role's idle-sleep
pair — see that directory's own README §3a.) `hermes-model-wake-worker.py`'s spark-2
`WAKE_TARGETS["reflector"]` entry: `required_gib` 115, derived from the model's real byte-verified
size (84,929,450,144 bytes = 79.10GiB) times the same ~1.4535 margin ratio
`super`/`coder2`/`muse` use (79.10 * 1.4535 ≈ 114.9, rounded up) — **weights-only, not a verified
KV-cache figure**, same caveat `log-analyst`'s own history already taught this project once.
`displaces=("coder", "coder2", "muse")`; none need `RESTORE_AFTER_DISPLACE` (all three already
on-demand, wake again on their own next call).

**`omni` cannot be auto-displaced.** It's always-resident, not a `WAKE_TARGETS` key, so
`make_room()` can never reach it. Getting to the ~115 GiB this role needs requires a **manual**
`sudo systemctl stop llama-omni` every time, on top of whatever auto-displacement handles for
`coder`/`coder2`/`muse` — this also means **live Reolink vision monitoring goes dark** for as long
as `reflector` is up. Real cost, stated plainly, not a footnote.

**Idle-sleep will not actually fire during a real campaign.** The GEPA harness calls `reflector`
by direct `--endpoint` (bypassing the router/wake-worker, same convention the existing
`hermes-coder-fix-eval.py`/`-build-eval.py` CLIs already use), so `reflector.last_used` is never
populated and `hermes-reflector-idle-sleep.timer` will not auto-stop it. Installed anyway for
fleet-convention completeness and any future router-path use — **manual
`sudo systemctl stop llama-reflector` is the real shutdown step**, every time.

## 3. Verify

```bash
# From spark-2 itself:
curl -s http://127.0.0.1:8093/health

# Through the router (either node):
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"reflector","messages":[{"role":"user","content":"hi"}],"max_tokens":20,"reasoning_effort":"low"}'
```

Confirm the reply's `content` field is non-empty and complete, not truncated or sitting in
`reasoning_content` instead — the exact failure mode §2's manual test reproduced without the
`reasoning_effort` override.

**Manual stop confirms the real shutdown step works:**

```bash
sudo systemctl stop llama-reflector
systemctl is-active llama-reflector   # expect "inactive"
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-16 | Initial version — HermesAgentV6 `IMPLEMENTATION_PLAN.md` GLM-5.3-Flash Paradigm A, Phase 2: new on-demand `reflector` role on `spark-2`, port 8093. `reasoning_effort` mechanism resolved live against the real checkpoint (per-request JSON override on `/v1/chat/completions`, not a CLI/chat-template-kwargs hack) before any systemd unit existed. `omni`'s manual-stop requirement and idle-sleep's real limitation (harness calls by direct endpoint, `.last_used` never populated) stated plainly, not left implicit. |
