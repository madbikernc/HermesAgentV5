# hermes-nest — recreate checklist

**Version:** 1.0.0

Nest/Google Home camera agent (`tools/hermes-nest.py`) — owns the Buzz `nest` topic (on-demand
"check the front door camera" from Matrix chat) and runs an independent Google Cloud Pub/Sub
listener for `CameraMotion`/`CameraPerson` events (proactive, email-delivered alerts).

Built 2026-09-01, direct request: "does the fleet have sufficient capability to trigger off camera
motion or camera person, trigger camera Livestream, and strip out a frame for analysis?" Researched
first, then built: Google's Device Access Program / Smart Device Management (SDM) API is the only
third-party path to a Nest camera, confirmed against the current public docs that it exposes no
still-image/snapshot trait at all — `CameraLiveStream`'s WebRTC stream is the only way to get
pixels, and `CameraMotion`/`CameraPerson` are event-only (delivered over Google Cloud Pub/Sub, not
a webhook). None of the three capabilities (event trigger, stream trigger, frame extraction)
existed anywhere in this fleet before this build.

**NOT YET LIVE-TESTED end to end.** No Device Access sandbox existed to test against as this was
written. Every technical claim about SDM/WebRTC behavior here matches the public API reference as
read, not a confirmed live trace — see the Verification section below, which must be run for real
before this capability is trusted the way every other timeout/behavior claim in this fleet already
has been.

## One-time manual setup (outside the fleet — the operator does this, not code)

1. Register for Device Access at <https://developers.google.com/nest/device-access/registration>
   ($5 one-time fee), create a Device Access project, link it to the Google Home structure
   containing the Nest cameras.
2. Create a GCP project, enable the Cloud Pub/Sub API, create a topic and a **pull** subscription
   on it (pull, not push — matches this fleet's outbound-only network posture, see
   `infra/network-planes.md`), and register that topic as the Device Access project's event target
   (a Device Access console step, not a GCP one).
3. Create a GCP service account with the Pub/Sub Subscriber role on that subscription, and
   generate a JSON key for it.
4. Complete the OAuth2 consent flow once (Device Access console walks through this) to obtain a
   `client_id` / `client_secret` / `refresh_token` for the SDM API scope.
5. In Vaultwarden, create item **`Hermes Google Home`** with these fields:
   - `client_id`, `client_secret`, `refresh_token` — SDM API OAuth2 credentials (step 4)
   - `sdm_project_id` — the Device Access project ID (not the GCP project ID)
   - `gcp_project_id` — the GCP project ID (step 2/3)
   - `pubsub_subscription` — the subscription ID from step 2
   - `pubsub_service_account_json` — the full JSON key contents from step 3, as one field value
   - `access_token` — leave empty; `tools/hermes_nest_common.py` populates and refreshes this itself

## Python venv

```bash
python3 -m venv /opt/hermes/venvs/nest
/opt/hermes/venvs/nest/bin/pip install aiortc google-cloud-pubsub google-auth Pillow
```

`aiortc` pulls in real binary deps (`av`/PyAV, `aioice`, `pylibsrtp`) — if the install fails on
missing system libraries, check for `libavformat`/`libopus`/`libvpx` dev packages first (PyAV's
usual requirement) before assuming anything about this fleet's own code is wrong.

Only `tools/hermes-nest-framegrab.py` runs under this venv — `tools/hermes-nest.py` itself runs
under the system Python like every other specialist (it invokes the framegrab script as a
subprocess via `FRAMEGRAB_PYTHON`, same isolation reasoning as `hermes-probe.py`'s nmap subprocess).

## Install

```bash
sudo cp hermes-nest.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-nest.service
```

Runs on **Forge (spark-2)**, co-resident with `omni` — same placement reasoning
`tools/hermes-media.py` documents (avoids a cross-node hop for the vision-model call).

## Verification

Run these in order — each one validates a layer the next one depends on, same discipline every
other real timeout/behavior claim in this fleet was established with (measure, don't guess):

1. **OAuth end-to-end**, in isolation, before anything else:
   ```bash
   /usr/bin/python3 -c "import sys; sys.path.insert(0,'tools'); import hermes_nest_common as n; \
     print([n.device_display_name(d) for d in n.list_devices()])"
   ```
   Confirm real device nicknames come back. If `device_display_name()`'s guess at the trait field
   name (`sdm.devices.traits.Info.customName`) is wrong, this is where it'll show up as a bare
   device ID instead of a real nickname — fix the field name in `hermes_nest_common.py` from the
   real response shape before proceeding.

2. **Frame grab, standalone**, no Buzz involved yet:
   ```bash
   /opt/hermes/venvs/nest/bin/python3 tools/hermes-nest-framegrab.py \
     "enterprises/<project>/devices/<device-id>" /tmp/nest-test.png
   ```
   Confirm a real PNG is written and note the actual wall-clock time printed. Use that real number
   (plus margin) to correct `NEST_TIMEOUT_SECONDS` (in `hermes-nest-wrapper.sh`'s environment, or
   the service's own `Environment=` line) and `NEST_TASK_TIMEOUT_SECONDS`
   (`hermes-presenter.py`) — both currently placeholder defaults (60s / 120s), not measured ones.

3. **Buzz/dispatch registration**: restart `hermes-buzz.service`, confirm a manual
   `POST /messages` with `from=nest`/`topic=nest` is accepted (would have been rejected with a 400
   before `KNOWN_AGENTS`/`KNOWN_TOPICS` were extended).

4. **On-demand path, end to end**: ask "check the &lt;camera name&gt; camera" in the Matrix room,
   confirm routing lands on `nest` (not misrouted to `status`/`logs`), confirm the ack names
   `nest`, confirm a real, accurate description of the actual current camera view arrives.

5. **Motion-triggered path**: temporarily lower `COOLDOWN_SECONDS_PER_DEVICE` for testing, trigger
   real motion in front of a registered camera, confirm a Pub/Sub message is pulled (watch the
   journal for "Pub/Sub subscriber starting"/capture logs), a capture runs, and a real email
   arrives at the configured address with an accurate description. Then confirm a second trigger
   inside the cooldown window is correctly dropped (logged, not silently ignored).

6. Restore `COOLDOWN_SECONDS_PER_DEVICE` and any tuned-down timeouts to real, measured values
   before calling this done.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-01 | Initial version — built after confirming live that no Nest/Google Home integration existed anywhere in this fleet, researching the Device Access/SDM API's real capabilities and gaps, and designing around the confirmed absence of any snapshot trait and the confirmed absence of a proactive-Matrix-push mechanism. |
