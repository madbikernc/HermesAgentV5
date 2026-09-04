# hermes-reolink — recreate checklist

**Version:** 1.2.0

Reolink camera agent (`tools/hermes-reolink.py`) — owns the Buzz `reolink` topic (on-demand "check
the camera" from Matrix chat) and runs an AI-detection poll loop (person/vehicle/pet, email-
delivered alerts).

Built 2026-09-02, direct follow-on to the Nest/Google Home build: asked for outdoor/battery/solar
camera recommendations for this exact "image pull and ID" skill. Real research picked Reolink over
UniFi Protect (best local API, but confirmed no official solar accessory exists for any
battery-capable model) and over Wyze/Nest (both already built this session, both real dead ends
for this specific need). See `IMPLEMENTATION_PLAN.md`-adjacent context in
`tools/hermes-reolink.py`'s own module docstring for the full reasoning.

**BLOCKED as of 2026-09-03 — real hardware arrived and this design cannot reach it.** The camera is
online at `10.129.1.19` (confirmed setup complete in the Reolink app, battery/solar model, no Home
Hub or NVR owned). Live probing found: `ping` answers instantly and repeatedly, but ports
80/443/9000/8000/554 all give an immediate connection refused, not a timeout. Reolink's own support
documentation confirms this is expected, permanent behavior, not a misconfiguration: **standalone
battery-powered cameras do not support local web/CGI API access at all** — a hardware/firmware
limitation, not a setting. The only officially supported way to get programmatic local access to a
battery camera is a **Reolink Home Hub or NVR**, which exposes its own local API and proxies to the
paired camera. `reolink_aio`'s `Host(ip, user, pass)` approach this whole file is built on is
LAN-only and has no cloud/P2P fallback (confirmed against the library's own docs) — so nothing here
can be fixed by more timeout tuning or a settings change; it needs a Home Hub/NVR purchase and the
camera re-paired to it. **Direct decision 2026-09-03: defer that purchase, ship an interim path
instead** — see `hermes-reolink-mail-watch.py` below, which covers the AI-detection alert half of
this design without needing any camera API at all. The on-demand "check the camera right now" chat
path has no equivalent workaround and stays unavailable until a Hub/NVR exists.

**Update 2026-09-02 (still true, applies once a Hub/NVR makes this file reachable):**
`reolink_aio`'s method names/signatures (`login()`, `get_host_data()`, `get_snapshot(channel)`,
`get_ai_state(channel)`, `logout()`) are confirmed correct by installing the library on spark-2 and
reading its actual source — including a real bug this caught before any hardware existed:
`get_ai_state()` silently returns `None` forever unless `get_host_data()` is called once after
`login()` to populate the channel list (fixed in `hermes-reolink.py` 1.1.0). What's still genuinely
unverifiable without going through a Hub/NVR: whether `get_ai_state()`'s real dict keys actually
match `AI_LABELS = ("people", "vehicle", "dog_cat")`, and real call latency. Steps 2-3 below are
what confirm those, once this path is unblocked.

## Interim path — `hermes-reolink-mail-watch.py` (active today, no Hub/NVR needed)

Relies on the camera's own native "email me a snapshot on AI detection" feature (every Reolink
camera has this in firmware, configured entirely in the app — no local API involved) instead of
external polling. This tool watches one IMAP mailbox for those alert emails, describes the attached
snapshot via the same router/omni vision call the on-demand path uses, and re-sends a cleaner alert
to the fleet notification address.

### One-time setup — done, 2026-09-03

1. **Mailbox the camera sends its native alerts to: `mercury@canislupisnc.net`** — the Boss's call,
   reusing the existing identity rather than a dedicated address. No loop risk with this tool's own
   outbound alert (`send_email()`, unchanged from `hermes-reolink.py`): that's a separate *sent* mail
   to `notifications@canislupisnc.net`, which doesn't land back in this account's own INBOX. Hover
   IMAP settings (confirmed against Hover's own published docs, 2026-09-03): `mail.hover.com`, port
   `993`, SSL/TLS.
2. **Reolink app**: AI detection + email-with-snapshot alerting enabled for this camera, pointed at
   that mailbox — done.
3. **Vaultwarden item `Hermes Reolink Mail`** (`host`/`port`/`username`/`password`) — done.

### Install

```bash
sudo cp hermes-reolink-mail-watch.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-reolink-mail-watch.service
```

Runs on **Forge (spark-2)**, co-resident with `omni` — same placement reasoning as
`hermes-reolink.py`/`hermes-nest.py`. Plain system `python3`, no venv — stdlib only
(`imaplib`/`email`/`smtplib`), unlike `hermes-reolink.py`'s `reolink_aio` dependency.

### Verification

1. Trigger a real detection event in front of the camera (or use the app's test-alert feature if it
   has one) and confirm the camera's native email actually lands in the configured mailbox.
2. Confirm `hermes-reolink-mail-watch.service`'s journal shows it picked up the message, described
   it, and sent the cleaner alert to the fleet notification address.
3. Confirm the source message is marked read in the mailbox afterward (not reprocessed next poll).

## Original local-API path — `hermes-reolink.py` (blocked, needs a Home Hub/NVR — see above)

Everything below this point is the original design, kept in full for when a Home Hub/NVR is
purchased and this path is unblocked — not deleted, not currently actionable.

### One-time setup

1. On the camera itself (Reolink app or web UI): enable AI detection (person/vehicle/pet, whichever
   are relevant) and note the camera's LAN IP, HTTPS port (default 443), and a local
   username/password (a dedicated non-admin account is fine and preferable).
2. In Vaultwarden, create item **`Hermes Reolink`** with fields: `host`, `port` (default `443`),
   `username`, `password`, `channel` (default `0` — a single camera is always channel 0).

### Python venv

```bash
python3 -m venv /opt/hermes/venvs/reolink
/opt/hermes/venvs/reolink/bin/pip install reolink_aio
```

Pure-Python asyncio + `aiohttp` — no exotic binary deps like `hermes-nest`'s `aiortc` needed.

### Install

```bash
sudo cp hermes-reolink.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-reolink.service
```

Runs on **Forge (spark-2)**, co-resident with `omni` — same placement reasoning as
`tools/hermes-media.py`/`tools/hermes-nest.py` (avoids a cross-node hop for the vision-model call).
**Do not enable this yet against the current camera** — `async_main()`'s `camera_login()` call isn't
wrapped in a try/except, so it will raise and crash-loop forever against a camera with no local API,
accomplishing nothing but log noise and repeated Vaultwarden fetches.

### Verification — run in this order once a Home Hub/NVR exists and this path is unblocked

1. **Standalone login + snapshot smoke test**, no Buzz involved yet:
   ```python
   import asyncio
   from reolink_aio.api import Host

   async def test():
       host = Host("<camera-ip>", "<username>", "<password>", port=443)
       await host.login()
       await host.get_host_data()  # required -- populates the channel list get_snapshot()/
                                    # get_ai_state() both gate on; see hermes-reolink.py 1.1.0
       data = await host.get_snapshot(0)
       open("/tmp/reolink-test.jpg", "wb").write(data)
       print(f"got {len(data)} bytes")
       state = await host.get_ai_state(0)
       print("AI state:", state)  # confirm real keys match AI_LABELS = ("people", "vehicle", "dog_cat")
       await host.logout()

   asyncio.run(test())
   ```
   Confirm a real JPEG is written, note the actual wall-clock time (this fleet's own discipline is
   to measure real timeouts, never guess them — see `PROBE_TIMEOUT_SECONDS`/`NEST_TIMEOUT_SECONDS`
   in the other camera agents for the precedent), and confirm `get_ai_state()`'s real dict keys
   actually match `AI_LABELS` in `hermes-reolink.py` — correct the constant if not.

2. **Buzz/dispatch registration**: restart `hermes-buzz.service`, confirm a manual
   `POST /messages` with `from=reolink`/`topic=reolink` is accepted.

3. **On-demand path, end to end**: ask "check the camera" (or similar) in the Matrix room, confirm
   routing lands on `reolink`, confirm a real, accurate description of the actual current camera
   view arrives.

4. **AI-detection path**: walk in front of the camera with person detection enabled, confirm a real
   email arrives with an accurate description. Then stand in frame continuously and confirm it does
   **not** re-fire every poll cycle (rising-edge logic, not level-triggered) — and confirm a second
   walk-by inside `COOLDOWN_SECONDS_PER_DEVICE` is correctly dropped (logged, not silently ignored).

5. Restore any timeouts tuned down for testing to real, measured values before calling this done.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.2.0 | 2026-09-03 | Camera arrived online at `10.129.1.19`. Live probing (ping succeeds, all standard ports refused) plus Reolink's own support docs confirmed standalone battery cameras have no local web/CGI API at all — `hermes-reolink.py`'s whole design is blocked until a Home Hub/NVR is purchased. Direct decision: defer that purchase, add `hermes-reolink-mail-watch.py` as an interim path covering the AI-detection alert half via the camera's own native email-on-detection feature. On-demand "check the camera" stays unavailable until a Hub/NVR exists. |
| 1.1.0 | 2026-09-02 | Installed `reolink_aio` on spark-2 and read its actual source before any camera hardware existed — confirmed every method name/signature `hermes-reolink.py` calls, and found a real bug in the process: `get_ai_state()` needs `get_host_data()` called once after `login()` to populate the channel list, or it silently returns `None` forever. Fixed in `hermes-reolink.py` 1.1.0. Verification steps renumbered/updated to match. |
| 1.0.0 | 2026-09-02 | Initial version — built after researching and recommending Reolink's solar/battery outdoor line for the requested "image pull and ID" skill, and confirming `reolink_aio` (Reolink-backed, actively maintained, what Home Assistant's own integration uses) as a stronger foundation than Wyze's reverse-engineered API or Nest's snapshot-trait-free SDM API. |
