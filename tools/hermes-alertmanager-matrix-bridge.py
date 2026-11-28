#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-11-28) - FIRMAMENT_OBSERVABILITY: a tiny webhook receiver Alertmanager posts its
# alert groups to (see infra/firmament-observability/alertmanager/alertmanager.yml's
# webhook_configs), relaying each one into the FleetOps Matrix room via this fleet's own
# hermes_alert_common.matrix_notice() -- the same helper hermes-router.py and several other tools
# already use, same `matrix-fleetops` vault credentials, no new secret. Deliberately minimal:
# stdlib http.server only, matching every other tool in this directory's own style, no new pip
# dependency. Runs as its own resident systemd unit, loopback-only (Alertmanager is co-located on
# HomeD13; nothing else ever needs to reach this).

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_alert_common  # noqa: E402

BIND = "127.0.0.1"
PORT = 9094


def log(msg):
    print(f"[hermes-alertmanager-matrix-bridge] {time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def _format_alert(alert):
    status = alert.get("status", "unknown").upper()
    labels = alert.get("labels", {})
    annotations = alert.get("annotations", {})
    name = labels.get("alertname", "unknown alert")
    host = labels.get("host") or labels.get("instance") or ""
    summary = annotations.get("summary") or annotations.get("description") or ""
    where = f" ({host})" if host else ""
    return f"[{status}] {name}{where}: {summary}" if summary else f"[{status}] {name}{where}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(f"{self.address_string()} - {fmt % args}")

    def do_POST(self):
        if self.path != "/alert":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            log("received a non-JSON body, ignoring")
            self.send_response(400)
            self.end_headers()
            return

        alerts = payload.get("alerts", [])
        if not alerts:
            log("received a webhook with no alerts, ignoring")
        for alert in alerts:
            text = _format_alert(alert)
            log(f"relaying: {text}")
            hermes_alert_common.matrix_notice(text, log)

        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    log(f"listening on {BIND}:{PORT}/alert, relaying into FleetOps Matrix")
    server = HTTPServer((BIND, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
