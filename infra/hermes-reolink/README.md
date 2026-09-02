# hermes-reolink — recreate checklist

**Version:** 1.0.0

Reolink camera agent (`tools/hermes-reolink.py`) — owns the Buzz `reolink` topic (on-demand "check
the camera" from Matrix chat) and runs an AI-detection poll loop (person/vehicle/pet, email-
delivered alerts).

Built 2026-09-02, direct follow-on to the Nest/Google Home build: asked for outdoor/battery/solar
camera recommendations for this exact "image pull and ID" skill. Real research picked Reolink over
UniFi Protect (best local API, but confirmed no official solar accessory exists for any
battery-capable model) and over Wyze/Nest (both already built this session, both real dead ends
for this specific need). See `IMPLEMENTATION_PLAN.md`-adjacent context in
`tools/hermes-reolink.py`'s own module docstring for the full reasoning.

**NOT YET LIVE-TESTED. No test unit existed as of writing.** Every technical claim about
`reolink_aio`'s exact public method names (`login()`/`get_snapshot()`/`get_ai_state()`) is inferred
from the library's documented CGI command names, not read from its actual method signatures —
**step 1 below is not optional**, it's how those names get confirmed or corrected before anything
else here is trusted.

## One-time setup

1. On the camera itself (Reolink app or web UI): enable AI detection (person/vehicle/pet, whichever
   are relevant) and note the camera's LAN IP, HTTPS port (default 443), and a local
   username/password (a dedicated non-admin account is fine and preferable).
2. In Vaultwarden, create item **`Hermes Reolink`** with fields: `host`, `port` (default `443`),
   `username`, `password`, `channel` (default `0` — a single camera is always channel 0).

## Python venv

```bash
python3 -m venv /opt/hermes/venvs/reolink
/opt/hermes/venvs/reolink/bin/pip install reolink_aio
```

Pure-Python asyncio + `aiohttp` — no exotic binary deps like `hermes-nest`'s `aiortc` needed.

## Install

```bash
sudo cp hermes-reolink.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-reolink.service
```

Runs on **Forge (spark-2)**, co-resident with `omni` — same placement reasoning as
`tools/hermes-media.py`/`tools/hermes-nest.py` (avoids a cross-node hop for the vision-model call).

## Verification — run in this order once hardware exists

1. **Confirm `reolink_aio`'s real API first**, before trusting anything else in this repo:
   ```bash
   /opt/hermes/venvs/reolink/bin/python3 -c "from reolink_aio.api import Host; help(Host)"
   ```
   Check the actual method names against what `tools/hermes-reolink.py`'s `camera_login()`/
   `camera_snapshot()`/`camera_ai_state()` call (`login()`, `get_snapshot(channel)`,
   `get_ai_state(channel)`). Fix the calls in that file first if any name is wrong — everything
   downstream depends on this.

2. **Standalone login + snapshot smoke test**, no Buzz involved yet:
   ```python
   import asyncio
   from reolink_aio.api import Host

   async def test():
       host = Host("<camera-ip>", "<username>", "<password>", port=443)
       await host.login()
       data = await host.get_snapshot(0)
       open("/tmp/reolink-test.jpg", "wb").write(data)
       print(f"got {len(data)} bytes")
       await host.logout()

   asyncio.run(test())
   ```
   Confirm a real JPEG is written and note the actual wall-clock time — this fleet's own
   discipline is to measure real timeouts, never guess them (see `PROBE_TIMEOUT_SECONDS`/
   `NEST_TIMEOUT_SECONDS` in the other camera agents for the precedent).

3. **AI-detection state shape**: call `get_ai_state(0)` directly and print the result — confirm the
   field names actually match `"people"`/`"vehicle"`/`"dog_cat"` (`AI_LABELS` in
   `hermes-reolink.py`). Correct the constant if the real library uses different keys.

4. **Buzz/dispatch registration**: restart `hermes-buzz.service`, confirm a manual
   `POST /messages` with `from=reolink`/`topic=reolink` is accepted.

5. **On-demand path, end to end**: ask "check the camera" (or similar) in the Matrix room, confirm
   routing lands on `reolink`, confirm a real, accurate description of the actual current camera
   view arrives.

6. **AI-detection path**: walk in front of the camera with person detection enabled, confirm a real
   email arrives with an accurate description. Then stand in frame continuously and confirm it does
   **not** re-fire every poll cycle (rising-edge logic, not level-triggered) — and confirm a second
   walk-by inside `COOLDOWN_SECONDS_PER_DEVICE` is correctly dropped (logged, not silently ignored).

7. Restore any timeouts tuned down for testing to real, measured values before calling this done.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-02 | Initial version — built after researching and recommending Reolink's solar/battery outdoor line for the requested "image pull and ID" skill, and confirming `reolink_aio` (Reolink-backed, actively maintained, what Home Assistant's own integration uses) as a stronger foundation than Wyze's reverse-engineered API or Nest's snapshot-trait-free SDM API. |
