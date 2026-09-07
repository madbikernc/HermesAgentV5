# hermes-reolink — recreate checklist

**Version:** 2.2.0

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

**LIVE-VERIFIED 2026-09-07** against the real Hub (`10.129.1.43`) and its two actually-paired
cameras, `cam1` (channel 0) and `cam2` (channel 1). **The third camera, "Driveway," is not actually
paired to this Hub** — `reolink_aio`'s own `Host.channels` reports only `[0, 1]` — so it was dropped
from the vault's `channels` config until it's paired in the Reolink app; re-add it there once it is.
Real results: `login()` ~6s, `get_host_data()` ~6s (paid once at startup, not per-poll), snapshot
0.9–2.8s. Real `get_ai_state()` keys: `('dog_cat', 'face', 'package', 'people', 'vehicle', 'other')`
— three more than originally assumed (`face`, `package`, `other`), all now watched (`AI_LABELS` in
`hermes-reolink.py` 2.1.0 covers all six). Both on-demand routing cases confirmed live end-to-end
through the real Buzz/Memory APIs: naming a camera answers just that one; naming none combines and
labels all configured cameras. `reolink_aio` also logs a non-fatal login-time warning that the Hub
account's password contains a character outside its preferred set — doesn't block login, but worth
cleaning up on the Hub account.

**AI-detection path confirmed live 2026-09-07** by a real, unprompted vehicle + person walk-by on
`cam2`: rising-edge logic fired once per new detection (not level-triggered), a second vehicle
detection 23s later and a second person detection 32s later were both correctly dropped as within
`COOLDOWN_SECONDS_PER_DEVICE` (120s) and logged rather than silently ignored, and the resulting
alert emails arrived with accurate descriptions. One nuance confirmed live: cooldown is keyed per
camera channel, not per detection label — a vehicle detection can be dropped by a *person*
detection's cooldown on the same channel 23s earlier. That's the original single-camera design's
behavior, unchanged by the 2.0.0 multi-camera work, just newly visible now that multiple detection
types are being watched (`AI_LABELS` expanded to all six in 2.1.0). **With this confirmed,
`hermes-reolink-mail-watch.service` was disabled and stopped on spark-2 2026-09-07** — its
AI-detection alerting is now fully redundant. The file itself is untouched, kept for reference per
this project's norm; don't delete it.

**Update 2026-09-02:** `reolink_aio`'s method names/signatures (`login()`, `get_host_data()`,
`get_snapshot(channel)`, `get_ai_state(channel)`, `logout()`) were confirmed correct by installing
the library on spark-2 and reading its actual source, before any camera hardware existed — including
a real bug caught in the process: `get_ai_state()` silently returns `None` forever unless
`get_host_data()` is called once after `login()` to populate the channel list (fixed in
`hermes-reolink.py` 1.1.0).

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

### Verification — complete as of 2026-09-07

1. ✅ **Standalone login + snapshot smoke test** — done live against the real Hub for both actually
   paired channels (0=cam1, 1=cam2). Real results: `login()` ~6s, `get_host_data()` ~6s (once at
   startup, not per-poll), snapshots 0.9–2.8s, real JPEGs written. Real `get_ai_state()` keys:
   `('dog_cat', 'face', 'package', 'people', 'vehicle', 'other')` — `AI_LABELS` in
   `hermes-reolink.py` was expanded to all six (2.1.0; originally assumed only three). Channel 2
   ("Driveway") returns `None` from both calls — confirmed via `reolink_aio`'s `Host.channels`
   that this Hub only actually has channels `[0, 1]` paired; Driveway isn't on it yet.

2. ✅ **Buzz/dispatch registration** — confirmed live: claims on the real `reolink` Buzz topic are
   fetched and processed correctly.

3. ✅ **On-demand path, end to end** — both routing cases confirmed live through the real
   Buzz/Memory APIs: naming a camera ("check cam1") answers with just that camera's description,
   unlabeled; naming none ("check the camera") answers with every configured camera's description,
   each labeled (`cam1: ...` / `cam2: ...`), combined in one reply.

4. ✅ **AI-detection path** — confirmed live by a real, unprompted vehicle + person walk-by on
   `cam2`: rising-edge fired once per new detection (not level-triggered), repeat detections 23s
   and 32s later were correctly dropped as within `COOLDOWN_SECONDS_PER_DEVICE` (120s) and logged
   rather than silently ignored, and the alert emails arrived with accurate descriptions. Confirmed
   live: cooldown is keyed per channel, not per detection label (a vehicle detection can be dropped
   by a same-channel person detection's cooldown). Cross-camera cooldown independence
   (`device:{channel}` keys are per-channel) wasn't separately exercised — cam1 didn't trigger
   during this test — but it's the same mechanism, low risk.

5. Restore any timeouts tuned down for testing to real, measured values before calling this done. —
   n/a, nothing was tuned down for this verification.

6. ✅ **`hermes-reolink-mail-watch.service` disabled and stopped** on spark-2, 2026-09-07 — its
   AI-detection alerting was fully redundant once step 4 confirmed this path works. File kept for
   reference per this project's norm; not deleted.

**Also found live, non-blocking:** `reolink_aio` logs `"Reolink password contains incompatible
special character, please change the password to only contain characters: a-z, A-Z, 0-9 or
@$*~_-+=!?.,:;'()[]"` on every login. Login still succeeds — but worth changing the Hub account's
password to avoid this becoming a real problem later.

**Once "Driveway" is actually paired to the Hub** in the Reolink app, add it back to the vault's
`channels` field (pick whatever channel number the Hub assigns it — don't assume 2) and re-run step
1 for that channel before trusting it.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.2.0 | 2026-09-07 | Verification complete: a real, unprompted vehicle + person walk-by on cam2 confirmed rising-edge detection, per-channel cooldown suppression (23s/32s repeats correctly dropped and logged), and accurate alert emails. `hermes-reolink-mail-watch.service` disabled and stopped on spark-2 — fully redundant now that this path is confirmed live end to end (login, snapshot, both on-demand routing cases, AI-detection). |
| 2.1.0 | 2026-09-07 | Live-verified against the real Hub: login/snapshot/AI-state work for the two actually-paired cameras (cam1, cam2); the third camera ("Driveway") isn't paired to the Hub yet and was dropped from the vault config until it is. Real `get_ai_state()` keys are `('dog_cat', 'face', 'package', 'people', 'vehicle', 'other')` — three more than assumed — so `AI_LABELS` in `hermes-reolink.py` was expanded to all six. Both on-demand routing cases confirmed live end to end. Found (non-blocking): `reolink_aio` warns the Hub account's password has a character outside its preferred set. Still open: a real AI-detection walk-by test, which gates disabling `hermes-reolink-mail-watch.service`. |
| 2.0.0 | 2026-09-06 | A Reolink Home Hub was purchased and three cameras paired to it, unblocking `hermes-reolink.py`'s local-API design. Bumped the file to 2.0.0 for multi-camera support: `channels` (channel-number → camera-name JSON map) replaces the single `channel` field, AI-detection polling loops every channel each cycle, and on-demand chat requests resolve to named camera(s) or, if none is named, all of them combined (direct decision — keeps "check the camera" meaningful as camera count grows). Verification checklist rewritten for multiple cameras and all three on-demand routing cases; added a step to disable `hermes-reolink-mail-watch.service` once this path is verified live, since it becomes redundant. |
| 1.2.0 | 2026-09-03 | Camera arrived online at `10.129.1.19`. Live probing (ping succeeds, all standard ports refused) plus Reolink's own support docs confirmed standalone battery cameras have no local web/CGI API at all — `hermes-reolink.py`'s whole design is blocked until a Home Hub/NVR is purchased. Direct decision: defer that purchase, add `hermes-reolink-mail-watch.py` as an interim path covering the AI-detection alert half via the camera's own native email-on-detection feature. On-demand "check the camera" stays unavailable until a Hub/NVR exists. |
| 1.1.0 | 2026-09-02 | Installed `reolink_aio` on spark-2 and read its actual source before any camera hardware existed — confirmed every method name/signature `hermes-reolink.py` calls, and found a real bug in the process: `get_ai_state()` needs `get_host_data()` called once after `login()` to populate the channel list, or it silently returns `None` forever. Fixed in `hermes-reolink.py` 1.1.0. Verification steps renumbered/updated to match. |
| 1.0.0 | 2026-09-02 | Initial version — built after researching and recommending Reolink's solar/battery outdoor line for the requested "image pull and ID" skill, and confirming `reolink_aio` (Reolink-backed, actively maintained, what Home Assistant's own integration uses) as a stronger foundation than Wyze's reverse-engineered API or Nest's snapshot-trait-free SDM API. |
