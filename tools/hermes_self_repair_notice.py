#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-11-13) — direct operator request (self-repair improvements): one FleetOps notice
# helper for the stages that had none. hermes-self-repair-generate.py posts a deadlocked review
# here, and hermes-self-repair-bridge.py a model-backend outage and a promoted fix whose incident
# keeps happening -- all things the operator decides on in the FleetOps room, where the promote
# gate already listens. Same Matrix call as hermes-self-repair-apply.py's own matrix_notice();
# its wrapper fetches the same matrix-fleetops vault entry. No token, no notice: logged instead,
# never raised -- a lost notice must never fail the stage that sent it.

import json
import os
import time
import urllib.parse
import urllib.request

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
MAX_NOTICE_CHARS = 6000


def fleetops_notice(text, sender, log=print):
    token = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
    room = os.environ.get("FLEETOPS_ROOM", "")
    if not token or not room:
        log(f"no FleetOps credentials -- notice not posted: {text[:300]}")
        return False
    if len(text) > MAX_NOTICE_CHARS:
        text = text[:MAX_NOTICE_CHARS] + "\n[... cut; the full record is in hermes-memory]"
    try:
        txn = f"{sender}-note-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/{urllib.parse.quote(room)}"
            f"/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(), method="PUT",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return True
    except Exception as exc:
        log(f"FleetOps notice failed: {exc}")
        return False
