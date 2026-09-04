# hermes-tts — recreate checklist

**Version:** 1.0.0

Basic voice generation for the fleet (direct operator request, 2026-09-04): text-in, speech-out,
reachable both from other fleet services and directly by independent harnesses on the tailnet —
the same access shape `muse` already has. Deployed on `spark-2` (Forge), not `spark` or HomeD13 —
see the design discussion this stage started from for why: Forge is the swappable/resource-flexible
node with real headroom (128 GB unified, ~45 GB currently used by `muse`+`omni`), HomeD13 is
explicitly slated for *more* network isolation, not less (a live, currently-unfixed exposure is
already flagged against it in `IMPLEMENTATION_PLAN.md` S10), and this model needs no meaningful GPU
budget either way.

**Not a `hermes-router.py` role.** That router is chat-completions-shaped (text in, text out);
speech synthesis is a different I/O shape, same reason `embed` sits outside `ROLES` rather than in
it (see `hermes-router.py` 2.9.0's own comment on that). This is its own standalone service.

## 1. Model

[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) via
[remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), which wraps it in an
OpenAI-compatible `/v1/audio/speech` endpoint — chosen specifically because "basic" was the actual
requirement (fixed voices, no cloning), and it's small enough to run without contesting the fleet's
existing GPU/VRAM budgets at all.

**CPU image, not GPU — deliberately, not by default-laziness.** The GPU image
(`kokoro-fastapi-gpu`) has open, confirmed reports of failing on ARM64+NVIDIA with `exec format
error` ([Kokoro-FastAPI#401](https://github.com/remsky/Kokoro-FastAPI/issues/401)), and Blackwell
support is tracked as still-unresolved upstream
([Kokoro-FastAPI#365](https://github.com/remsky/Kokoro-FastAPI/issues/365)) — both squarely hit
Forge's actual hardware (Grace-**Blackwell**, ARM64). The CPU image is multi-arch
(`linux/amd64`+`linux/arm64`), confirmed working, and Kokoro-82M is small enough that CPU inference
is a real option, not a compromise — same "don't fight an unresolved upstream bug for a model this
small" judgment call the fleet's own coder2/Qwen3-Coder-Next bake-off already modeled. Revisit the
GPU image later if real measured latency (not assumed) makes it worth chasing.

**Not yet measured live.** This checklist is written from the image's documented behavior, not a
completed deployment — no container has been started on Forge yet. Confirm actual latency and
voice quality once it's up, same "verified, not asserted" discipline every other infra doc here
follows.

## 2. Deploy

```bash
mkdir -p ~/HermesAgentV5-runtime/hermes-tts   # or wherever this node keeps non-repo runtime state
cp docker-compose.yml ~/HermesAgentV5-runtime/hermes-tts/
cd ~/HermesAgentV5-runtime/hermes-tts
docker compose pull
docker compose up -d
curl -s http://127.0.0.1:8098/v1/models   # expect a real model list, not a connection error
```

Then wire in the systemd unit so it survives a reboot and restarts on failure like every other
resident service on this fleet:

```bash
sudo cp hermes-tts.service /etc/systemd/system/
# edit hermes-tts.service's WorkingDirectory to match wherever step 1 actually put
# docker-compose.yml on this node before enabling it
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-tts
```

## 3. Firewall — explicit, not ambient

`muse`'s own Tailscale reachability works today because nothing blocks it, not because anyone
opened it on purpose (see the design discussion this stage started from). Don't repeat that here —
open exactly what's needed, on purpose, auditable:

```bash
sudo ufw allow from 10.129.1.0/24 to any port 8098 proto tcp comment 'hermes-tts: fleet LAN'
sudo ufw allow from 100.64.0.0/10 to any port 8098 proto tcp comment 'hermes-tts: Tailscale direct access, matches muse'
```

No auth on top of that — same LAN/tailnet-trust posture every model backend on this fleet already
has (`network-planes.md`), and consistent with the explicit ask to mirror `muse`'s access shape.

## 4. API

OpenAI-compatible. Any OpenAI TTS client works by pointing its base URL here; a raw call:

```bash
curl -s http://10.129.1.17:8098/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model": "kokoro", "input": "Fleet voice generation is online.", "voice": "af_heart", "response_format": "mp3"}' \
  --output test.mp3
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/models` | Lists the loaded voice/model — unauthenticated liveness check |
| `POST` | `/v1/audio/speech` | Body per OpenAI's TTS API (`model`, `input`, `voice`, `response_format`) → raw audio bytes |

Full voice list and SSML/timestamp options are in the project's own
[API docs](https://github.com/remsky/Kokoro-FastAPI/wiki/Integrations-OpenAI) — not duplicated here
to avoid a second copy drifting out of sync with upstream.

## 5. Verify

```bash
# From Forge itself:
curl -s http://127.0.0.1:8098/v1/models

# From spark (fleet-internal, LAN):
curl -s http://10.129.1.17:8098/v1/models

# From an independent harness on the tailnet (same shape as muse):
curl -s http://100.100.178.25:8098/v1/models
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-04 | Initial version — direct operator request for basic fleet voice generation, reachable both internally and by independent Tailscale harnesses like `muse`. Kokoro-82M via Kokoro-FastAPI's CPU image on Forge, explicit LAN+Tailscale ufw rules (not ambient exposure), `hermes-status.py` 1.4.0's model report extended to list it. Written and reviewed against upstream docs/issues; not yet deployed or measured live. |
