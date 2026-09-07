# hermes-reolink — recreate checklist

**Version:** 2.0.0

Reolink camera agent (`tools/hermes-reolink.py`) — owns the Buzz `reolink` topic (on-demand "check
the camera" from Matrix chat) and runs an AI-detection poll loop (person/vehicle/pet, email-
delivered alerts).

Built 2026-09-02, direct follow-on to the Nest/Google Home build: asked for outdoor/battery/solar
camera recommendations for this exact "image pull and ID" skill. Real research picked Reolink over
UniFi Protect (best local API, but confirmed no official solar accessory exists for any
battery-capable model) and over Wyze/Nest (both already built this session, both real dead ends
for this specific need). See `IMPLEMENTATION_PLAN.md`-adjacent context in
`tools/hermes-reolink.py`'s own module docstring for the full reasoning.

**UNBLOCKED 2026-09-06 — a Reolink Home Hub was purchased and three cameras are now paired to it.**
(Historical record of the original blocker, since it's the reason the design looks the way it does:
the first camera, a standalone battery/solar model at `10.129.1.19`, had no Home Hub/NVR — live
probing found `ping` answering but every standard port connection-refused, and Reolink's own support
docs confirmed standalone battery cameras have no local web/CGI API at all, full stop. A Home
Hub/NVR was the only officially supported way to get local API access, so the purchase was deferred
2026-09-03 and `hermes-reolink-mail-watch.py` below shipped as an interim, no-local-API-needed path
instead.) With the Hub now owned and cameras paired to it, `hermes-reolink.py`'s original design
(1.x) is reachable — and as of `hermes-reolink.py` 2.0.0 it's also **multi-camera**: one Hub login
session serves all three channels, both for AI-detection polling and for on-demand "check the
camera" chat requests (which now resolve to whichever camera(s) are named in the request, or to all
three combined if none is named). See the file's own header comment and module docstring for the
full design.

**Update 2026-09-02 (still true, now directly actionable with the Hub in hand):**
`reolink_aio`'s method names/signatures (`login()`, `get_host_data()`, `get_snapshot(channel)`,
`get_ai_state(channel)`, `logout()`) are confirmed correct by installing the library on spark-2 and
reading its actual source — including a real bug this caught before any hardware existed:
`get_ai_state()` silently returns `None` forever unless `get_host_data()` is called once after
`login()` to populate the channel list (fixed in `hermes-reolink.py` 1.1.0). What's still genuinely
unverifiable without the real Hub in front of you: whether `get_ai_state()`'s real dict keys
actually match `AI_LABELS = ("people", "vehicle", "dog_cat")`, real call latency, and (new as of
2.0.0) whether `get_host_data()` enumerates all three paired channels from one login. The
Verification section below is what confirms all of that.

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

## Local-API path — `hermes-reolink.py` (unblocked 2026-09-06, multi-camera as of 2.0.0)

### One-time setup

1. On the Hub itself (Reolink app or web UI): pair all cameras to it, enable AI detection
   (person/vehicle/pet, whichever are relevant) on each, and note the Hub's LAN IP, HTTPS port
   (default 443), a local username/password (a dedicated non-admin account is fine and preferable),
   and each camera's channel number on the Hub.
2. In Vaultwarden, create item **`Hermes Reolink`** with fields: `host` (the **Hub's** LAN IP, not
   any camera's own IP), `port` (default `443`), `username`, `password`, and `channels` — a JSON
   object mapping channel number (as a string) to a camera name, e.g.
   `{"0": "front-door", "1": "backyard", "2": "garage"}`. Camera names are what on-demand chat
   requests match against (case-insensitively, `-`/`_` treated as spaces) to pick which camera(s) to
   answer for — pick names people would actually type in Matrix chat.

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

### Verification — run in this order, against the real Hub and all three cameras

1. **Standalone login + snapshot smoke test**, no Buzz involved yet — repeat the snapshot/AI-state
   calls for every channel in your `channels` mapping, not just channel 0:
   ```python
   import asyncio
   from reolink_aio.api import Host

   async def test():
       host = Host("<hub-ip>", "<username>", "<password>", port=443)
       await host.login()
       await host.get_host_data()  # required -- populates the channel list get_snapshot()/
                                    # get_ai_state() both gate on; see hermes-reolink.py 1.1.0.
                                    # Confirm this enumerates all three paired cameras, not just one
                                    # (unverified as of 2.0.0 -- see module docstring).
       for channel in (0, 1, 2):  # match your real channels vault field
           data = await host.get_snapshot(channel)
           open(f"/tmp/reolink-test-{channel}.jpg", "wb").write(data)
           print(f"channel {channel}: got {len(data)} bytes")
           state = await host.get_ai_state(channel)
           print(f"channel {channel} AI state:", state)  # confirm real keys match
                                                           # AI_LABELS = ("people", "vehicle", "dog_cat")
       await host.logout()

   asyncio.run(test())
   ```
   Confirm a real JPEG is written for each channel, note the actual wall-clock time (this fleet's
   own discipline is to measure real timeouts, never guess them — see
   `PROBE_TIMEOUT_SECONDS`/`NEST_TIMEOUT_SECONDS` in the other camera agents for the precedent), and
   confirm `get_ai_state()`'s real dict keys actually match `AI_LABELS` in `hermes-reolink.py` —
   correct the constant if not.

2. **Buzz/dispatch registration**: restart `hermes-buzz.service`, confirm a manual
   `POST /messages` with `from=reolink`/`topic=reolink` is accepted.

3. **On-demand path, end to end** — test all three routing cases:
   - Name one camera ("check the front door") — confirm only that camera's description comes back.
   - Name two cameras — confirm both come back, labeled.
   - Name none ("check the camera") — confirm all three come back, labeled, combined into one reply.

4. **AI-detection path**: walk in front of each camera in turn with person detection enabled,
   confirm a real email arrives naming the correct camera with an accurate description. Then stand
   in frame continuously and confirm it does **not** re-fire every poll cycle (rising-edge logic,
   not level-triggered) — and confirm a second walk-by inside `COOLDOWN_SECONDS_PER_DEVICE` is
   correctly dropped (logged, not silently ignored). Also confirm one camera's cooldown doesn't
   suppress another's (`device:{channel}` cooldown keys are per-channel).

5. Restore any timeouts tuned down for testing to real, measured values before calling this done.

6. Once this path is verified live, disable `hermes-reolink-mail-watch.service` — its AI-detection
   alerting is now redundant (this path covers it for all three cameras plus the on-demand path it
   could never provide). Don't delete the file; see its own header for why.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.0.0 | 2026-09-06 | A Reolink Home Hub was purchased and three cameras paired to it, unblocking `hermes-reolink.py`'s local-API design. Bumped the file to 2.0.0 for multi-camera support: `channels` (channel-number → camera-name JSON map) replaces the single `channel` field, AI-detection polling loops every channel each cycle, and on-demand chat requests resolve to named camera(s) or, if none is named, all of them combined (direct decision — keeps "check the camera" meaningful as camera count grows). Verification checklist rewritten for multiple cameras and all three on-demand routing cases; added a step to disable `hermes-reolink-mail-watch.service` once this path is verified live, since it becomes redundant. |
| 1.2.0 | 2026-09-03 | Camera arrived online at `10.129.1.19`. Live probing (ping succeeds, all standard ports refused) plus Reolink's own support docs confirmed standalone battery cameras have no local web/CGI API at all — `hermes-reolink.py`'s whole design is blocked until a Home Hub/NVR is purchased. Direct decision: defer that purchase, add `hermes-reolink-mail-watch.py` as an interim path covering the AI-detection alert half via the camera's own native email-on-detection feature. On-demand "check the camera" stays unavailable until a Hub/NVR exists. |
| 1.1.0 | 2026-09-02 | Installed `reolink_aio` on spark-2 and read its actual source before any camera hardware existed — confirmed every method name/signature `hermes-reolink.py` calls, and found a real bug in the process: `get_ai_state()` needs `get_host_data()` called once after `login()` to populate the channel list, or it silently returns `None` forever. Fixed in `hermes-reolink.py` 1.1.0. Verification steps renumbered/updated to match. |
| 1.0.0 | 2026-09-02 | Initial version — built after researching and recommending Reolink's solar/battery outdoor line for the requested "image pull and ID" skill, and confirming `reolink_aio` (Reolink-backed, actively maintained, what Home Assistant's own integration uses) as a stronger foundation than Wyze's reverse-engineered API or Nest's snapshot-trait-free SDM API. |
