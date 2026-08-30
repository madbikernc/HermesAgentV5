#!/usr/bin/env python3
# Version: 2.8.0
#
# 2.8.0 (2026-08-29) — HermesAgentV5 S13: `nano` removed from `ROLES` on both branches. Retirement
# was announced at S6 ("nano is retired as a role name" — target §4.1) and deferred at S6, S8, and
# S9 in turn; S13 is the stage that actually does it. `llama-nano.service` itself is stopped and
# disabled the same stage (see IMPLEMENTATION_PLAN.md S13) — a request for role "nano" now gets a
# real 400 from this router rather than silently succeeding against a backend nothing else expects
# to be there.
#
# 2.7.0 (2026-08-29) — HermesAgentV5 S6: new `dispatch` role, Qwen3.6-35B-A3B stock (never
# abliterated — target §12.1), resident on spark at :8097 (not the target's eventual :8088,
# which is nano's until nano actually retires at S8). Called by the new `hermes-dispatch.py`
# service, same as any other role — no special-casing in this file.
#
# 2.6.0 (2026-08-29) — HermesAgentV5 S5: Layer 2 wired in. After Layer 1 passes (not already
# blocked), the newest user/tool message is sent to hermes-guard.py's `/classify` (Meta's
# Llama-Prompt-Guard-2-22M, stock, resident on spark). A confident MALICIOUS verdict is treated
# as a block, same response shape Layer 1's block already used -- target §8's "classifier model
# second" step, catching semantic/paraphrased manipulation Layer 1's regex patterns can't
# enumerate. Scoped to the newest message only, not the full history: callers resend the whole
# conversation every request, and re-running a real model inference call over every already-
# screened prior turn on every single turn would multiply cost by conversation length for no
# added signal. Guard service unreachable -> Layer 2 is skipped for that request (logged once),
# never a hard failure -- same fail-open-on-infra-unavailability rule log_event() already
# follows, applied to availability instead of logging. Every non-clean verdict from either layer
# (Layer 1 flag/block, Layer 2 hit) is now also logged to hermes-memory's `turns` table
# (task_id="guard-log", agent="guard") in addition to hermes_injection_guard.py's own local
# guard_log db, which keeps `/guard/stats`. Best-effort, wrapped -- a memory-logging failure must
# never affect the actual proxied request, same rule every other logging call in this file holds.
#
# 2.5.0 (2026-08-29) — HermesAgentV5 S1 (../HermesAgentV5/IMPLEMENTATION_PLAN.md): `muse` and
# `omni` move back to spark-2, restoring the two-node split that 2.1.0/2.2.0 collapsed on
# 2026-08-26. The `coder`-vs-`coder2` benchmark that justified freeing spark-2 concluded on its
# own — coder2 (Qwen3.8-Flash-Next, qwen4exp architecture) fails to load on this llama.cpp build;
# incumbent `coder` (Qwen3.8-27B-abliterated) stays. No ROLES shape change, only which node's
# ROUTER instance resolves muse/omni to 127.0.0.1 vs the peer's LAN IP — see the two branches
# below.
#
# 2.4.0 (2026-08-28) — Direct request: injection-guard alerts now also go to email, and a new
# `/guard/stats` GET endpoint exposes 24h block/flag counts (backed by hermes_injection_guard.py
# 1.1.0's new SQLite log) so hermes-fleet-health.py can fold them into the daily digest without
# SSHing into each node. Email fires on "block" only, not "flag" — a block is rare and each one is
# real signal; flags roll into the daily digest instead, same alert-fatigue avoidance
# hermes-fleet-health.py's own dead_recent window already established for the broker. EMAIL_PASSWORD
# is fetched once at startup by hermes-router-wrapper.sh (1.1.0) alongside the existing
# FLEETOPS_MATRIX_TOKEN/BROKER_TOKEN fetches — this is a resident daemon, not a one-shot script, so
# it follows this file's own established fetch-once-at-startup idiom rather than
# hermes-fleet-health.py's per-invocation vault-get-secret.sh call (right for a once-daily batch
# script, wrong for a process handling live traffic continuously). Written, not yet deployed —
# same caveat as 2.3.0's own entry below: no service on spark/spark-2 has restarted to pick this
# up, and email delivery specifically has not been exercised at all (no SMTP credential available
# in this environment to test against).
#
# 2.3.0 (2026-08-28) — Added a Layer-1 injection guard (hermes_injection_guard.py) ahead of every
# proxied request: regex scan of payload["messages"] for command-injection, SQL-injection,
# role/delimiter spoofing, and Unicode smuggling, keyed by each message's declared role (a
# `tool`-role hit on cmd/sql patterns blocks outright — adversarial retrieved content has no
# legitimate reason to contain shell/SQL syntax; a `user`-role hit only flags, since people
# legitimately paste shell scripts and SQL for `coder` to review). role_spoof/unicode_smuggling
# hits block regardless of role. This is Layer 1 only — deterministic pattern matching, no model
# call. A Layer 2 semantic classifier (Prompt Guard 2, run as its own resident `guard` role) is
# designed but not yet built; see hermes_injection_guard.py's own docstring. Written, not yet
# deployed or exercised against live traffic — no service on spark/spark-2 has been restarted to
# pick this up, and this changelog entry is not itself evidence that it works.
#
# 2.2.0 (2026-08-26) — `muse` and `omni` moved from spark-2 to spark (both still always-resident,
# ports unchanged) to free spark-2 entirely for a coder-vs-coder2 benchmark (Qwen3.8-Flash-Next
# candidate) that needs the full node. Files verified identical via sha256 before cutover (muse's
# copy on spark predates Stage 8's original move and was never deleted, so rsync's quick-check
# skipped re-transferring it — checksum-confirmed rather than trusted blind). spark-2 is now
# expected to run only `coder`/`coder2` for the duration of the benchmark.
#
# 2.1.0 (2026-08-26) — `coder` moved from spark-2 (always-off, Qwen3-Coder-Next, retired) to
# spark (on-demand, Qwen3.8-27B-abliterated, port 8094) after a real execution-verified bake-off:
# Coder-Next crashed with a TypeError on its own generated code, Qwen3.8 passed all correctness
# checks. ON_DEMAND_ROLES now includes `coder` alongside `super` -- see
# tools/hermes-model-wake-worker.py 1.2.0 for the matching WAKE_TARGETS entry.
#
# hermes-router — names a role instead of a port (IMPLEMENTATION_PLAN.md §4a/§4b, Stage 2).
#
# A tiny OpenAI-compatible reverse proxy in front of the fleet's resident backends. Callers set
# `model` to a role name ("nano", "super", "coder", "muse", "omni") in an otherwise normal
# /v1/chat/completions request; the router reads that field and forwards to the matching
# backend's real host:port, streaming or not, unchanged otherwise. Internal only — binds
# 127.0.0.1, no new firewall rule on the caller-facing side. Weaver's own direct Tailscale
# exposure (IDE/CLI use) is separate and bypasses this router entirely.
#
# 2.0.0 (HermesAgentV4 rewrite of HermesAgentRedo's hermes-router.py 1.2.0):
#
# - Role names changed: core/weaver/muse/vision -> nano/super/coder/muse/omni
#   (IMPLEMENTATION_PLAN.md §1, §2c, §4). "muse" keeps its name across the rewrite since the
#   underlying capability and model didn't change (§4b's bake-off kept the existing checkpoint).
#
# - Capability endpoints, not persona-pinned nodes (§2c): this same file runs on BOTH `spark`
#   and `spark-2`, selected via HERMES_NODE. As of 2.5.0, `nano`/`super`/`coder`/`embed` live on
#   spark and `muse`/`omni` live on spark-2 — the split 2.1.0/2.2.0 temporarily collapsed for a
#   coder-vs-coder2 benchmark (2026-08-26 to 2026-08-29) is restored now that the benchmark has
#   concluded. `coder` moved from spark-2 to spark 2026-08-26, on-demand
#   rather than always-resident, after a bake-off picked Qwen3.8-27B-abliterated over the
#   spark-2-resident Qwen3-Coder-Next. Whichever node this instance runs on, roles hosted on THIS node resolve to
#   127.0.0.1; roles hosted on the OTHER node resolve to its LAN IP. Either persona's gateway
#   always talks to its own node's local router; cross-node hops happen inside the router, not
#   the caller. This needs a narrow ufw rule on each node allowing the peer's IP to reach the
#   specific backend ports it proxies to — LAN-scoped, same posture Continuwuity's node-to-node
#   traffic already uses (IMPLEMENTATION_PLAN.md §4e), not a new general opening.
#
# - `super` is loaded on demand, not always resident (§4a — real byte-verified sizes made
#   always-resident infeasible alongside anything else). Waking and idling it is modeled as a
#   broker job (JOB_TYPE=wake), not embedded router/sudo logic — same "no LLM turn, and no
#   general-purpose router process, is ever load-bearing for a mechanical/privileged action"
#   principle IMPLEMENTATION_PLAN.md §4c already established for cross-node work. Before
#   proxying a request to an on-demand role, the router submits a wake job to the broker (which
#   lives on `spark` regardless of which node's router is asking — the same cross-node path
#   HomeD13's render-worker already uses) and polls for completion. See
#   tools/hermes-model-wake-worker.py, which does the actual `sudo systemctl start` — always
#   locally, on the same host as the unit it starts, never over SSH or a network privilege hop.
#
# Deliberately boring: Python stdlib only (http.server + urllib), one file, no new dependencies —
# same rule as hermes-broker.py.
#
# Posts a real-time notice to FleetOps for every request it actually routes (role + prompt
# snippet + timestamp), the same pattern hermes-broker.py uses for job delivery — because an LLM
# claiming it used a role is not evidence that it did (LESSONS_LEARNED.md §2g, "the phantom
# Weaver"). This does not prevent fabrication — nothing at the prompt level reliably does (§2f)
# — but it makes it instantly, independently checkable in the same room the claim would be made
# in. Best-effort: routing still works with FLEETOPS_MATRIX_TOKEN unset, notice delivery just
# gets skipped.
#
# Every routed request is also logged to hermes_usage_log.py's SQLite store (role, status,
# latency, TTFB, token counts when available). Token counts come from the backend's own `usage`
# object: for a non-streaming response it's already in the JSON; for a streaming one,
# `stream_options: {"include_usage": true}` is injected into the forwarded payload when the
# caller didn't set it, so the final SSE chunk carries one too. Logging is best-effort and
# wrapped so a logging failure can never affect the actual proxied request — same rule the
# FleetOps notice above follows.
#
# Config-drift trap (IMPLEMENTATION_PLAN.md §3a, inherited): a caller's own declared context
# length can silently override what the live backend actually reports. If you change a backend's
# --ctx-size, update the caller's config in the same pass — this router does not paper over that.
#
# Config, all from the environment:
#   HERMES_NODE            required — "spark" or "spark-2", selects the ROLES table below
#   SPARK_LAN_IP            default 10.129.1.15
#   SPARK2_LAN_IP           default 10.129.1.17
#   ROUTER_BIND             default 127.0.0.1
#   ROUTER_PORT             default 8080
#   BROKER_URL              default http://<SPARK_LAN_IP>:8100 (broker always lives on spark)
#   BROKER_TOKEN            required if any role is on-demand — same token every other broker
#                           caller in this fleet uses (fetched from Vaultwarden by the wrapper)
#   WAKE_POLL_TIMEOUT_S     default 150 — how long to wait for an on-demand role to come up
#   MATRIX_HOMESERVER       default http://127.0.0.1:6167
#   FLEETOPS_MATRIX_TOKEN   optional — if unset, notices are skipped with a one-time warning
#   FLEETOPS_ROOM           optional — room to post notices into
#   HERMES_USAGE_DB         optional — see hermes_usage_log.py, default ~/.hermes/state/usage.db
#   HERMES_GUARD_DB         optional — see hermes_injection_guard.py, default
#                           ~/.hermes/state/injection_guard.db
#   EMAIL_PASSWORD          optional — if unset, guard block emails are skipped with a one-time
#                           warning (fetched from Vaultwarden's `email-sintra` item by the wrapper,
#                           same secret hermes-fleet-health.py's daily digest already uses)
#   GUARD_URL               default http://<SPARK_LAN_IP>:8096 (Layer 2 lives on spark only)
#   GUARD_TOKEN             optional — if unset, Layer 2 is skipped with a one-time warning;
#                           Layer 1 alone still runs
#   MEMORY_URL              default http://<SPARK_LAN_IP>:8102 (hermes-memory lives on spark only)
#   MEMORY_TOKEN            optional — if unset, guard verdicts are still enforced but not logged
#                           to hermes-memory, with a one-time warning

import json
import os
import smtplib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.mime.text import MIMEText
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_injection_guard  # noqa: E402
import hermes_usage_log  # noqa: E402

BIND = os.environ.get("ROUTER_BIND", "127.0.0.1")
PORT = int(os.environ.get("ROUTER_PORT", "8080"))

EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")
EMAIL_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"
_email_warned = False

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
SPARK2_IP = os.environ.get("SPARK2_LAN_IP", "10.129.1.17")

NODE = os.environ.get("HERMES_NODE", "")
if NODE not in ("spark", "spark-2"):
    sys.exit(f"HERMES_NODE must be 'spark' or 'spark-2', got {NODE!r}")

# role -> (base_url, on_demand)
if NODE == "spark":
    ROLES = {
        "super": ("http://127.0.0.1:8095", True),
        "coder": ("http://127.0.0.1:8094", True),
        "muse": (f"http://{SPARK2_IP}:8090", False),
        "omni": (f"http://{SPARK2_IP}:8091", False),
        # Port 8097, not the target's proposed 8088 -- that was nano's port and moving dispatch onto
        # it now that nano is retired (S13) would mean touching start-dispatch.sh, this unit, ufw,
        # and S12's DISPATCH_CHAT_URL standby override in the same pass for a cosmetic port-number
        # match with no functional benefit. Deferred, not forgotten -- see IMPLEMENTATION_PLAN.md S13.
        "dispatch": ("http://127.0.0.1:8097", False),
    }
else:
    ROLES = {
        "super": (f"http://{SPARK_IP}:8095", True),
        "coder": (f"http://{SPARK_IP}:8094", True),
        "muse": ("http://127.0.0.1:8090", False),
        "omni": ("http://127.0.0.1:8091", False),
        "dispatch": (f"http://{SPARK_IP}:8097", False),
    }

ON_DEMAND_ROLES = {role for role, (_, on_demand) in ROLES.items() if on_demand}

BROKER_URL = os.environ.get("BROKER_URL", f"http://{SPARK_IP}:8100").rstrip("/")
BROKER_TOKEN = os.environ.get("BROKER_TOKEN", "")
WAKE_POLL_TIMEOUT_S = int(os.environ.get("WAKE_POLL_TIMEOUT_S", "150"))

GUARD_URL = os.environ.get("GUARD_URL", f"http://{SPARK_IP}:8096").rstrip("/")
GUARD_TOKEN = os.environ.get("GUARD_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")

MAX_BODY = 32 * 1024 * 1024  # 32MB — generous for a request body, bounded


def log(msg):
    print(f"[hermes-router:{NODE}] {msg}", flush=True)


def send_email(subject, body):
    """Best-effort — never raises. A send failure must not affect the actual
    proxied request, same rule matrix_notice() follows. Only called for
    guard "block" verdicts (see do_POST) — deliberately not for "flag", to
    avoid the alert-fatigue trap hermes-fleet-health.py's dead_recent window
    already exists to prevent for the broker."""
    global _email_warned
    if not EMAIL_PASSWORD:
        if not _email_warned:
            log("no EMAIL_PASSWORD — guard block emails disabled for this process's lifetime")
            _email_warned = True
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, EMAIL_PASSWORD)
            server.send_message(msg)
    except Exception as exc:
        log(f"guard alert email failed: {exc}")


def matrix_notice(text):
    """Best-effort real-time notice to FleetOps. Never raises — a notice failure must not
    affect the actual proxied request."""
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        return
    try:
        txn = f"router-note-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"notice delivery failed: {exc}")


_guard_warned = False


def guard_classify(text):
    """Layer 2: call hermes-guard.py's classifier. Returns the parsed {"label","score","hit",...}
    dict, or None if Layer 2 isn't configured or the service is unreachable -- an infra problem
    with Layer 2 must degrade to "Layer 1 only", never block every request or crash the router.
    Warns once per process, not once per request, same one-time-warning convention
    FLEETOPS_TOKEN's own absence already uses elsewhere in this file."""
    global _guard_warned
    if not GUARD_TOKEN:
        if not _guard_warned:
            log("WARNING: GUARD_TOKEN not set — Layer 2 skipped, Layer 1 alone is active")
            _guard_warned = True
        return None
    try:
        req = urllib.request.Request(
            f"{GUARD_URL}/classify",
            data=json.dumps({"text": text}).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {GUARD_TOKEN}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:
        log(f"Layer 2 guard unreachable, skipping for this request: {exc}")
        return None


_memory_warned = False


def memory_log_guard_verdict(node, layer, severity_value, detail):
    """Log a non-clean guard verdict (either layer) to hermes-memory as a `turns` row — the
    training set if Layer 2 is ever tuned (IMPLEMENTATION_PLAN.md S5). Best-effort, wrapped: a
    memory-logging failure must never affect the actual proxied request, same rule every other
    logging call in this file already follows. Deliberately separate from
    hermes_injection_guard.py's own local guard_log db, which still backs `/guard/stats` --
    this is the durable, queryable-by-a-future-tuning-pass copy, not a replacement."""
    global _memory_warned
    if not MEMORY_TOKEN:
        if not _memory_warned:
            log("WARNING: MEMORY_TOKEN not set — guard verdicts enforced but not logged to hermes-memory")
            _memory_warned = True
        return
    try:
        req = urllib.request.Request(
            f"{MEMORY_URL}/turns",
            data=json.dumps({
                "task_id": "guard-log",
                "agent": "guard",
                "role": "system",
                "raw": json.dumps({"node": node, "layer": layer, "severity": severity_value, **detail}),
            }).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {MEMORY_TOKEN}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as exc:
        log(f"guard verdict: hermes-memory logging failed: {exc}")


def wake_role(role):
    """Submit a `wake` job to the broker for an on-demand role and block until it reports the
    backend healthy (already-warm counts as success immediately — see
    hermes-model-wake-worker.py). Raises RuntimeError on timeout or a dead job, which the
    caller turns into a 503 rather than proxying to a backend that isn't there."""
    auth = {"Authorization": f"Bearer {BROKER_TOKEN}"}
    submit_req = urllib.request.Request(
        f"{BROKER_URL}/jobs",
        data=json.dumps({"type": "wake", "payload": {"role": role}}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", **auth},
    )
    with urllib.request.urlopen(submit_req, timeout=15) as resp:
        job_id = json.loads(resp.read())["id"]

    deadline = time.monotonic() + WAKE_POLL_TIMEOUT_S
    while time.monotonic() < deadline:
        get_req = urllib.request.Request(f"{BROKER_URL}/jobs/{job_id}", headers=auth)
        with urllib.request.urlopen(get_req, timeout=10) as resp:
            job = json.loads(resp.read())
        if job["state"] == "done":
            return
        if job["state"] == "dead":
            raise RuntimeError(f"wake job for {role!r} failed: {job.get('error')}")
        time.sleep(2)
    raise RuntimeError(f"wake job for {role!r} did not finish within {WAKE_POLL_TIMEOUT_S}s")


def extract_usage(body):
    """Pulls the `usage` object out of either a plain JSON completion response or an SSE stream
    (the last `data: {...}` line carrying one, per the injected stream_options above). Returns
    None on any parse miss — that just means no token counts for this request, not a broken
    proxy, so this never raises."""
    if not body:
        return None
    text = body.decode("utf-8", errors="replace")

    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and obj.get("usage"):
            return obj["usage"]
    except json.JSONDecodeError:
        pass

    usage = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if data == "[DONE]" or not data:
            continue
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(chunk, dict) and chunk.get("usage"):
            usage = chunk["usage"]
    return usage


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(f"{self.address_string()} - {fmt % args}")

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "node": NODE, "roles": list(ROLES)})
            return
        if self.path == "/v1/models":
            self._send_json(200, {
                "object": "list",
                "data": [{"id": role, "object": "model", "owned_by": "hermes-router"} for role in ROLES],
            })
            return
        if self.path == "/guard/stats":
            # Read by hermes-fleet-health.py once daily, one node at a time (spark's router at
            # 127.0.0.1, spark-2's over the LAN) — same "curl a JSON endpoint" pattern
            # broker_status() already uses for hermes-broker, not a DB file read over SSH.
            self._send_json(200, {"node": NODE, "window_seconds": 86400,
                                   **hermes_injection_guard.recent_counts(86400)})
            return
        self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > MAX_BODY:
            self._send_json(400, {"error": {"message": "missing or oversized request body"}})
            return
        raw = self.rfile.read(length)

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": {"message": "invalid JSON body"}})
            return

        messages = payload.get("messages") or []
        guard_hits = hermes_injection_guard.scan_messages(messages)
        guard_severity = hermes_injection_guard.overall_severity(guard_hits)
        if guard_severity == "block":
            categories = sorted({cat for r in guard_hits for cat in r["hits"]})
            roles_hit = sorted({r["role"] for r in guard_hits})
            log(f"BLOCKED by injection guard: categories={categories} roles={roles_hit}")
            matrix_notice(f"[router:{NODE}] BLOCKED — injection guard hit {categories} "
                           f"(message role(s): {roles_hit})")
            send_email(
                f"[Hermes Guard] BLOCKED request on {NODE} — {', '.join(categories)}",
                f"Node: {NODE}\nCategories: {categories}\nMessage role(s): {roles_hit}\n\n"
                f"Per-message detail:\n" + "\n".join(
                    f"  [{r['index']}] role={r['role']!r} hits={r['hits']}" for r in guard_hits
                ),
            )
            hermes_injection_guard.log_event(NODE, "block", guard_hits)
            memory_log_guard_verdict(NODE, "L1", "block",
                                      {"categories": categories, "roles": roles_hit})
            self._send_json(400, {"error": {
                "message": "request blocked by injection guard", "categories": categories}})
            return
        if guard_severity == "flag":
            categories = sorted({cat for r in guard_hits for cat in r["hits"]})
            log(f"flagged by injection guard (forwarded anyway): categories={categories}")
            matrix_notice(f"[router:{NODE}] flagged (forwarded): injection guard hit {categories}")
            hermes_injection_guard.log_event(NODE, "flag", guard_hits)
            memory_log_guard_verdict(NODE, "L1", "flag", {"categories": categories})

        # Layer 2 (IMPLEMENTATION_PLAN.md S5): only the newest user/tool message, not the whole
        # history — callers resend the full conversation every request, and every prior turn
        # already passed screening the request it first arrived in. Runs whether Layer 1 was
        # clean or only flagged; never runs if Layer 1 already blocked (returned above).
        newest = next((m for m in reversed(messages)
                       if isinstance(m, dict) and m.get("role") in ("user", "tool")
                       and isinstance(m.get("content"), str) and m["content"].strip()), None)
        if newest is not None:
            verdict = guard_classify(newest["content"])
            if verdict and verdict.get("hit"):
                log(f"BLOCKED by Layer 2 guard: label={verdict['label']} score={verdict['score']:.3f}")
                matrix_notice(f"[router:{NODE}] BLOCKED — Layer 2 guard hit "
                               f"(score {verdict['score']:.3f})")
                send_email(
                    f"[Hermes Guard] Layer 2 BLOCKED request on {NODE}",
                    f"Node: {NODE}\nLabel: {verdict['label']}\nScore: {verdict['score']:.3f}\n"
                    f"Role: {newest['role']}\n\nText:\n{newest['content']}",
                )
                memory_log_guard_verdict(NODE, "L2", "block",
                                          {"label": verdict["label"], "score": verdict["score"]})
                self._send_json(400, {"error": {
                    "message": "request blocked by Layer 2 guard (Prompt Guard 2)",
                    "score": verdict["score"]}})
                return

        role = payload.get("model", "")
        entry = ROLES.get(role)
        if entry is None:
            self._send_json(400, {"error": {
                "message": f"unknown model/role {role!r} — expected one of {sorted(ROLES)}"}})
            return
        base_url, _ = entry

        if role in ON_DEMAND_ROLES:
            try:
                wake_role(role)
            except Exception as exc:
                self._send_json(503, {"error": {"message": f"{role!r} is on-demand and failed to "
                                                             f"wake: {exc}"}})
                return

        snippet = ""
        for msg in reversed(messages):
            if msg.get("role") == "user" and msg.get("content"):
                snippet = str(msg["content"])[:200]
                break
        matrix_notice(f"[router:{NODE}] {role} called, prompt: {snippet!r}")

        prompt_chars = sum(len(str(m.get("content", ""))) for m in messages)

        # Ask the backend for a final usage object even on a streaming response, so the log below
        # gets real token counts rather than nothing — only added when the caller didn't already
        # set it, and only changes what's forwarded upstream, never what's relayed back to the
        # client. Re-serializing (instead of forwarding `raw` unchanged) is safe: it's a semantic
        # round-trip of the same JSON, not a byte-level passthrough contract.
        if payload.get("stream") and "stream_options" not in payload:
            payload["stream_options"] = {"include_usage": True}
            upstream_body = json.dumps(payload).encode()
        else:
            upstream_body = raw

        upstream_req = urllib.request.Request(
            f"{base_url}{self.path}", data=upstream_body, method="POST",
            headers={"Content-Type": "application/json"})

        start = time.monotonic()
        ttfb_ms = None
        response_chunks = []

        try:
            with urllib.request.urlopen(upstream_req, timeout=600) as upstream:
                self.send_response(upstream.status)
                for header, value in upstream.getheaders():
                    if header.lower() not in ("content-length", "connection", "transfer-encoding"):
                        self.send_header(header, value)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    chunk = upstream.read(4096)
                    if not chunk:
                        break
                    if ttfb_ms is None:
                        ttfb_ms = int((time.monotonic() - start) * 1000)
                    response_chunks.append(chunk)
                    self.wfile.write(b"%x\r\n%b\r\n" % (len(chunk), chunk))
                self.wfile.write(b"0\r\n\r\n")
            self._log_usage(role, "ok", start, ttfb_ms, prompt_chars, b"".join(response_chunks))
        except urllib.error.HTTPError as exc:
            body = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self._log_usage(role, "error", start, ttfb_ms, prompt_chars, b"",
                             error_message=f"HTTP {exc.code}")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
            self._send_json(502, {"error": {"message": f"backend {role!r} unreachable: {exc}"}})
            self._log_usage(role, "error", start, ttfb_ms, prompt_chars, b"", error_message=str(exc))

    def _log_usage(self, role, status, start, ttfb_ms, prompt_chars, body, error_message=None):
        usage = extract_usage(body) or {}
        hermes_usage_log.log_request(
            role=role, status=status, latency_ms=int((time.monotonic() - start) * 1000),
            ttfb_ms=ttfb_ms, prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"), total_tokens=usage.get("total_tokens"),
            prompt_chars=prompt_chars, response_chars=len(body), error_message=error_message,
        )


def main():
    hermes_usage_log.init_db()
    hermes_injection_guard.init_db()
    notice_state = "enabled" if (FLEETOPS_TOKEN and FLEETOPS_ROOM) else "disabled — no FleetOps credentials"
    email_state = "enabled" if EMAIL_PASSWORD else "disabled — no EMAIL_PASSWORD"
    guard2_state = "enabled" if GUARD_TOKEN else "disabled — no GUARD_TOKEN"
    memory_log_state = "enabled" if MEMORY_TOKEN else "disabled — no MEMORY_TOKEN"
    log(f"routing {sorted(ROLES)} (on-demand: {sorted(ON_DEMAND_ROLES) or 'none'}) on {BIND}:{PORT} "
        f"(real-time notices: {notice_state}, guard block email: {email_state}, "
        f"Layer 2 guard: {guard2_state}, guard->memory logging: {memory_log_state}, "
        f"usage log: {hermes_usage_log.DB_PATH}, guard log: {hermes_injection_guard.DB_PATH})")
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
