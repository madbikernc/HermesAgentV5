#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes_nest_common.py — shared OAuth2 + Smart Device Management (SDM) API helpers for the fleet's
Nest/Google Home camera capability (tools/hermes-nest.py, tools/hermes-nest-framegrab.py).

Direct request (2026-09-01): "does the fleet have sufficient capability to trigger off camera
motion or camera person, trigger camera Livestream, and strip out a frame for analysis?" Researched
live against the current Device Access / SDM docs before writing any of this: no still-image/
snapshot trait exists at all — CameraLiveStream's WebRTC stream is the only way to get pixels,
CameraMotion/CameraPerson are event-only (no image attached), and events are delivered via a
Google Cloud Pub/Sub pull subscription, never a webhook.

Credentials live in Vaultwarden, item "Hermes Google Home" (this fleet's `Hermes <Vendor>` naming
convention — see "Hermes Wyze", "Hermes Generac"), fields: client_id, client_secret, refresh_token,
sdm_project_id, gcp_project_id, pubsub_subscription, plus a cached access_token custom field.

Cache-first token handling mirrors hermes-wyze.py's with_reauth() shape: try the cached
access_token from vault first, only do a real OAuth refresh-token exchange
(https://oauth2.googleapis.com/token) once a call actually returns 401, then cache the new token
back via vault-set-secret.sh. Unlike Wyze, a Google access token is short-lived by design (~1h) —
expect this refresh path to fire far more often here; that's exactly why it's cheap (a token
refresh, not a full re-login) and safe to pay per-failure rather than needing Wyze's cross-process
reauth lock (Google's token endpoint isn't rate-limited the way repeated Wyze logins are).

This module is imported by a long-running specialist (hermes-nest.py) — every error here raises a
normal exception (RuntimeError/urllib.error.HTTPError), never sys.exit(): a config or API problem
must fail the one request it's part of, not kill the daemon, same reasoning
hermes-dispatch.py 1.0.1 already established after a real crash from this exact mistake.

NOT YET LIVE-TESTED against a real Device Access sandbox — the module docstring's technical claims
(trait names, response shapes) match the current public SDM API reference as read, but the fleet's
own established discipline is to trust a live call over documentation. See
infra/hermes-nest/README.md's Verification section — list_devices() must be run for real, against
real registered credentials, before anything else in this capability is trusted.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_GET = f"{REPO_DIR}/tools/vault-get-secret.sh"
VAULT_SET = f"{REPO_DIR}/tools/vault-set-secret.sh"
VAULT_ITEM = "Hermes Google Home"

OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
SDM_API_BASE = "https://smartdevicemanagement.googleapis.com/v1"


def vault_get(field):
    try:
        result = subprocess.run(
            [VAULT_GET, VAULT_ITEM, field], capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def vault_set(field, value):
    try:
        subprocess.run(
            [VAULT_SET, VAULT_ITEM, field], input=value, capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        print(f"WARNING: timed out caching '{field}' back to Vaultwarden — not persisted", file=sys.stderr)


def _refresh_access_token():
    """Real OAuth2 refresh-token exchange — only called when the cached token is missing or a
    real API call has just proven it stale (401). Returns the new access token and caches it."""
    client_id = vault_get("client_id")
    client_secret = vault_get("client_secret")
    refresh_token = vault_get("refresh_token")
    if not all([client_id, client_secret, refresh_token]):
        raise RuntimeError(
            f"incomplete OAuth credentials in vault item '{VAULT_ITEM}' "
            "(need client_id, client_secret, refresh_token)")

    body = json.dumps({
        "client_id": client_id, "client_secret": client_secret,
        "refresh_token": refresh_token, "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(
        OAUTH_TOKEN_URL, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode())
    access_token = result.get("access_token")
    if not access_token:
        raise RuntimeError(f"OAuth refresh succeeded but no access_token in response: {result}")
    vault_set("access_token", access_token)
    return access_token


def get_access_token(force_refresh=False):
    if not force_refresh:
        cached = vault_get("access_token")
        if cached:
            return cached
    return _refresh_access_token()


def _sdm_request(method, path, token, body=None, timeout=30):
    url = f"{SDM_API_BASE}/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                  headers={"Content-Type": "application/json"})
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def sdm_call(method, path, body=None, timeout=30):
    """Cache-first, single-retry-after-real-failure — same shape as hermes-wyze.py's
    with_reauth(): try the cached token, and only pay for a real refresh once a call actually
    fails with 401, never speculatively."""
    token = get_access_token()
    try:
        return _sdm_request(method, path, token, body, timeout)
    except urllib.error.HTTPError as exc:
        if exc.code != 401:
            raise
        token = get_access_token(force_refresh=True)
        return _sdm_request(method, path, token, body, timeout)


def sdm_project_path():
    project_id = vault_get("sdm_project_id")
    if not project_id:
        raise RuntimeError(f"'sdm_project_id' not set on vault item '{VAULT_ITEM}'")
    return f"enterprises/{project_id}"


def list_devices():
    return sdm_call("GET", f"{sdm_project_path()}/devices").get("devices", [])


def device_display_name(device):
    """Best-effort nickname extraction — SDM's Info trait carries a `customName` field per the
    public API reference, but this has NOT been confirmed against a real device response yet.
    Falls back to the bare device ID (last path segment of `name`) rather than guessing wrong."""
    info = (device.get("traits") or {}).get("sdm.devices.traits.Info") or {}
    return info.get("customName") or device.get("name", "").rsplit("/", 1)[-1]


def find_device(name_query):
    """Case-insensitive substring match against each device's display name, same convention
    hermes-wyze.py's find_devices()/get_single_device() already use. Returns the full SDM
    resource name (`enterprises/.../devices/...`) — every command call needs the full path, not
    the bare ID. Raises RuntimeError (never sys.exit — see module docstring) with the full device
    list on no-match/ambiguous-match, so the caller can report something honest rather than guess."""
    devices = list_devices()
    matches = [d for d in devices if name_query.lower() in device_display_name(d).lower()]
    if not matches:
        available = ", ".join(device_display_name(d) for d in devices) or "(none registered)"
        raise RuntimeError(f"no camera matching '{name_query}'. Available: {available}")
    if len(matches) > 1:
        names = ", ".join(device_display_name(d) for d in matches)
        raise RuntimeError(f"'{name_query}' matches more than one camera ({names}) — be more specific")
    return matches[0]["name"]


def generate_webrtc_stream(device_name, sdp_offer):
    """Returns the command response, which carries `results.answerSdp` plus
    `results.mediaSessionId` (needed to stop the stream afterward)."""
    return sdm_call("POST", f"{device_name}:executeCommand", body={
        "command": "sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream",
        "params": {"offerSdp": sdp_offer},
    })


def stop_webrtc_stream(device_name, media_session_id):
    return sdm_call("POST", f"{device_name}:executeCommand", body={
        "command": "sdm.devices.commands.CameraLiveStream.StopWebRtcStream",
        "params": {"mediaSessionId": media_session_id},
    })
