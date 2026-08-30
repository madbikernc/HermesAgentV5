#!/usr/bin/env python3
# Version: 1.4.1
#
# 1.4.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default and the fleet
# target table's per-node repo_dir entries repointed from HermesAgentV4 to
# HermesAgentV5.
#
"""
1.4.0 (2026-08-28, direct request): added guard_status(), curling each node's own hermes-router
`/guard/stats` endpoint (hermes-router.py 2.4.0) for 24h injection-guard block/flag counts — same
"curl a JSON endpoint" pattern broker_status() already uses for the broker, not an SSH+sqlite
read. A block in the last 24h now pulls fleet_status to at least Degraded, same tier
broker.dead_recent already uses — a real block is worth surfacing prominently in the daily digest
without conflating it with the Critical tier reserved for actual infra unreachability. Written
alongside hermes-router.py 2.4.0/hermes_injection_guard.py 1.1.0; not yet exercised against a
live router (no access to spark/spark-2 from the environment this was written in).

1.3.0 (2026-08-17, found during a fleet-health audit prompted by "check
their current status"): Amy's TARGETS entry was still "local-identity"
(sudo -u amy) months after her Stage 7 relocation to spark-2 — the sixth
instance in this project of a persona relocation silently breaking a
script that reaches her via a local Unix account, this time surfacing as
"[Amy] UNREACHABLE — sudo: unknown user amy" in the daily rollup itself.
Switched to "remote-ssh", the same pattern already correct for HomeD13 and
already used to reach her from hermes-repo-sync.sh/hermes-nfs-backup.sh.

hermes-fleet-health.py — Phase 14 (IMPLEMENTATION_PLAN.md §7): aggregates
Phase 13's per-identity/per-node hermes-node-health.py reports into one
fleet-wide view, adds inter-node comms health and broker queue depth/
dead-letter count (the broker is a natural reporting surface for that,
called out explicitly in the roadmap), and emails the result daily.

1.1.0 fixes a real self-reinforcing false-Critical loop found 2026-08-03: see
_parse_report()'s docstring below.

1.2.0 (2026-08-09, direct request to recheck node health comprehensiveness):
found this service had itself been failing daily — `broker_status()` and
`send_email()` both call vault-get-secret.sh directly, with no retry, and
both hit a real transient bw/Vaultwarden failure live on 2026-08-09: the
broker was misreported as UNREACHABLE (it was actually fine — only the
token fetch failed), and worse, the day's email failed to send entirely,
so the failure was invisible unless someone went looking at
`systemctl status`. Root-caused and fixed at the source in
vault-get-secret.sh 1.2.0 (an internal retry, so every caller gets it, not
just this one) rather than patched here again — this file needed one
follow-on change: NODE_HEALTH_TIMEOUT raised from a bare 60s to 120s, since
hermes-node-health.py's own queue-probe check can now legitimately take up
to 60s on its own before the rest of its checks even run.

Runs as pmoney (needs `sudo -u <identity>` to reach Sintra's and Amy's own
~/.hermes — neither can read the other's home directory, by design — plus
direct SSH to HomeD13, which has no persona of its own to run "as").

Usage:
  python3 hermes-fleet-health.py               # build report, send email
  python3 hermes-fleet-health.py --no-email     # print report, don't send
  python3 hermes-fleet-health.py --format json  # machine-readable, implies --no-email
"""
import argparse
import json
import smtplib
import subprocess
import sys
import time
from datetime import datetime, timezone
from email.mime.text import MIMEText

DEAD_LETTER_RECENT_WINDOW_SECONDS = 24 * 3600

REPO_DIR = "/home/pmoney/HermesAgentV5"
VAULT_GET = f"{REPO_DIR}/tools/vault-get-secret.sh"

BROKER_URL = "http://10.129.1.15:8100"
# spark's router is reached locally (this script always runs on spark, as pmoney — same as
# hermes-router.py itself); spark-2's is reached over the LAN, same IP hermes-router.py's own
# SPARK2_LAN_IP default uses.
ROUTER_URLS = {"spark": "http://127.0.0.1:8080", "spark-2": "http://10.129.1.17:8080"}
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

TARGETS = [
    {"label": "Sintra", "kind": "local-identity", "user": "sintra", "hermes_home": "/home/sintra/.hermes",
     "repo_dir": "/home/sintra/HermesAgentV5"},
    # Amy moved to spark-2 in Stage 7 (§6) -- "local-identity" (sudo -u amy)
    # stopped meaning anything the moment her Unix account left this host,
    # same gap already found and fixed in hermes-repo-sync.sh/hermes-nfs-
    # backup.sh. remote-ssh here reaches her over the same spark2-amy SSH
    # alias those two scripts already use.
    {"label": "Amy", "kind": "remote-ssh", "ssh_host": "spark2-amy", "hermes_home": "/home/amy/.hermes",
     "repo_dir": "/home/amy/HermesAgentV5", "vault_node": "amy"},
    {"label": "HomeD13", "kind": "remote-ssh", "ssh_host": "homed13", "hermes_home": "/home/pmoney/.node-health",
     "repo_dir": "/home/pmoney/HermesAgentV5", "vault_node": "homed13"},
]


def run(cmd, timeout=60):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout, r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        return "", "timed out", -1
    except Exception as e:
        return "", str(e), -1


#  hermes-node-health.py's own queue-depth probe alone can now legitimately take up to
# 60s (vault-get-secret.sh 1.2.0's internal retry budget), on top of its other checks
# (network pings, external service curls, etc.) — the default 60s run() timeout is no
# longer enough margin for the full report, and a timeout here gets misreported as the
# identity being "unreachable" (_parse_report) rather than what it actually is: a slow
# but real report. 120s comfortably covers the new worst case.
NODE_HEALTH_TIMEOUT = 120


def collect_local_identity(target):
    cmd = [
        "sudo", "-u", target["user"], "bash", "-c",
        f'export HERMES_HOME={target["hermes_home"]} VAULT_NODE={target["user"]}; '
        f'python3 {target["repo_dir"]}/tools/hermes-node-health.py --format json'
    ]
    out, err, rc = run(cmd, timeout=NODE_HEALTH_TIMEOUT)
    return _parse_report(target["label"], out, err, rc)


def collect_remote_ssh(target):
    remote_cmd = (
        f'export HERMES_HOME={target["hermes_home"]} '
        f'HERMES_REPO_DIR={target["repo_dir"]} VAULT_NODE={target["vault_node"]}; '
        f'python3 {target["repo_dir"]}/tools/hermes-node-health.py --format json'
    )
    out, err, rc = run(["ssh", "-o", "ConnectTimeout=10", target["ssh_host"], remote_cmd],
                        timeout=NODE_HEALTH_TIMEOUT)
    return _parse_report(target["label"], out, err, rc)


def _parse_report(label, out, err, rc):
    """hermes-node-health.py deliberately exits 1 when its own report is
    Critical (same convention this script uses for itself) — a non-zero exit
    here means "here's a real report, and it's bad," not "couldn't produce
    one." Treating any rc != 0 as unreachable (the original check) discarded
    a perfectly valid Critical report and reported the identity as
    UNREACHABLE instead, which is false and forced this script's own status
    to Critical over a problem that was already visible in the real report.
    Try to parse stdout first, regardless of rc; only fall back to
    unreachable when there's genuinely no parseable output. Found 2026-08-03
    investigating a real self-reinforcing loop: this bug turned a real
    "Sintra is Critical because two services are failed" into "Sintra is
    unreachable," making hermes-fleet-health.service itself fail, which then
    became one of the two failed units feeding the next Critical report."""
    if out.strip():
        try:
            report = json.loads(out)
            return {"label": label, "reachable": True, "error": None, "report": report}
        except json.JSONDecodeError as e:
            return {"label": label, "reachable": False, "error": f"unparseable output: {e}", "report": None}
    return {"label": label, "reachable": False, "error": err.strip() or f"exit {rc}", "report": None}


def broker_status():
    token, _, rc = run([VAULT_GET, "broker-token", "password"])
    token = token.strip()
    if rc != 0 or not token:
        return {"reachable": False, "error": "could not fetch broker-token from vault"}
    health_out, _, health_rc = run(["curl", "-s", "-m", "5", f"{BROKER_URL}/health"])
    if health_rc != 0 or not health_out.strip():
        return {"reachable": False, "error": "broker /health unreachable"}
    jobs_out, _, jobs_rc = run([
        "curl", "-s", "-m", "5", "-H", f"Authorization: Bearer {token}", f"{BROKER_URL}/jobs"
    ])
    try:
        jobs = json.loads(jobs_out)["jobs"]
    except Exception:
        return {"reachable": True, "error": "jobs list unparseable", "jobs": []}
    now = time.time()
    done = sum(1 for j in jobs if j.get("state") == "done")
    dead = sum(1 for j in jobs if j.get("state") == "dead")
    # A dead-lettered job is worth knowing about forever (hence `dead` above, always
    # reported), but should only degrade *today's* status while it's recent — otherwise
    # one old, already-understood test failure (found live: a malformed test submission
    # from two days prior, correctly dead-lettered as designed) would flag every single
    # daily report indefinitely, which is exactly the alert-fatigue outcome a health
    # check exists to prevent, not cause.
    dead_recent = sum(
        1 for j in jobs
        if j.get("state") == "dead" and (now - j.get("finished_at", 0)) < DEAD_LETTER_RECENT_WINDOW_SECONDS
    )
    in_flight = sum(1 for j in jobs if j.get("state") not in ("done", "dead"))
    return {
        "reachable": True, "error": None, "total": len(jobs),
        "done": done, "dead": dead, "dead_recent": dead_recent, "in_flight": in_flight,
    }


def guard_status():
    """Injection-guard block/flag counts from each node's own router, last 24h
    (window is fixed server-side by hermes_injection_guard.recent_counts's
    default). A curl failure on one node degrades that node's entry only —
    it must not be conflated with an actual block, and must not silently
    zero out the other node's real counts."""
    per_node = {}
    for node, url in ROUTER_URLS.items():
        out, err, rc = run(["curl", "-s", "-m", "5", f"{url}/guard/stats"])
        if rc != 0 or not out.strip():
            per_node[node] = {"reachable": False, "error": err.strip() or f"exit {rc}"}
            continue
        try:
            per_node[node] = {"reachable": True, **json.loads(out)}
        except json.JSONDecodeError as e:
            per_node[node] = {"reachable": False, "error": f"unparseable output: {e}"}
    return {
        "per_node": per_node,
        "block": sum(n.get("block", 0) for n in per_node.values() if n.get("reachable")),
        "flag": sum(n.get("flag", 0) for n in per_node.values() if n.get("reachable")),
    }


def inter_node_comms():
    """Spark <-> HomeD13 specifically, distinct from each report's own generic
    network section — this is the one link the whole render pipeline depends on."""
    checks = []
    out, err, rc = run(["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", "homed13", "echo ok"])
    checks.append({"name": "Spark -> HomeD13 SSH", "ok": rc == 0 and out.strip() == "ok",
                    "detail": err.strip() if rc != 0 else "ok"})
    mount_out, _, mount_rc = run(["mountpoint", "-q", "/mnt/nas2-hermes-backup"])
    checks.append({"name": "Spark's own NAS2 mount", "ok": mount_rc == 0,
                    "detail": "mounted" if mount_rc == 0 else "not mounted"})
    return checks


def build_report():
    identity_results = []
    for t in TARGETS:
        if t["kind"] == "local-identity":
            identity_results.append(collect_local_identity(t))
        else:
            identity_results.append(collect_remote_ssh(t))

    broker = broker_status()
    guard = guard_status()
    comms = inter_node_comms()

    statuses = [r["report"]["summary"]["overall_status"] for r in identity_results if r["reachable"]]
    unreachable = [r["label"] for r in identity_results if not r["reachable"]]
    comms_failed = [c["name"] for c in comms if not c["ok"]]

    if unreachable or comms_failed or "Critical" in statuses or not broker["reachable"]:
        fleet_status = "Critical"
    elif "Degraded" in statuses or broker.get("dead_recent", 0) > 0 or guard["block"] > 0:
        fleet_status = "Degraded"
    elif statuses:
        fleet_status = "Healthy"
    else:
        fleet_status = "Unknown"

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "fleet_status": fleet_status,
        "identities": identity_results,
        "broker": broker,
        "guard": guard,
        "inter_node_comms": comms,
    }


def render_text(fleet):
    lines = []
    lines.append(f"Hermes Fleet Health Report — {fleet['timestamp']}")
    lines.append(f"Overall fleet status: {fleet['fleet_status']}")
    lines.append("")
    for r in fleet["identities"]:
        if not r["reachable"]:
            lines.append(f"[{r['label']}] UNREACHABLE — {r['error']}")
            continue
        summ = r["report"]["summary"]
        lines.append(f"[{r['label']}] {summ['overall_status']} — "
                      f"{summ['checks_ok']} ok / {summ['checks_warn']} warn / "
                      f"{summ['checks_critical']} critical / {summ['checks_unknown']} unknown")
        for issue in summ.get("issues", []):
            lines.append(f"    - {issue}")
    lines.append("")
    b = fleet["broker"]
    if b["reachable"]:
        lines.append(f"[Broker] reachable — {b['total']} job(s) in history, "
                      f"{b['done']} done, {b['dead']} dead-lettered all-time "
                      f"({b['dead_recent']} in the last 24h), {b['in_flight']} in flight")
    else:
        lines.append(f"[Broker] UNREACHABLE — {b['error']}")
    lines.append("")
    g = fleet["guard"]
    lines.append(f"[Injection Guard — last 24h] {g['block']} blocked, {g['flag']} flagged, "
                  f"across {len(g['per_node'])} node(s)")
    for node, stats in g["per_node"].items():
        if not stats.get("reachable"):
            lines.append(f"    [{node}] stats unavailable — {stats.get('error')}")
            continue
        lines.append(f"    [{node}] {stats['block']} blocked, {stats['flag']} flagged")
        if stats.get("categories"):
            cats = ", ".join(f"{k}={v}" for k, v in sorted(stats["categories"].items()))
            lines.append(f"        categories: {cats}")
        for b in stats.get("recent_blocks", [])[:5]:
            lines.append(f"        blocked {b['ts']}: roles={b['roles']} categories={b['categories']}")
    lines.append("")
    lines.append("[Inter-node comms]")
    for c in fleet["inter_node_comms"]:
        mark = "OK" if c["ok"] else "FAIL"
        lines.append(f"    [{mark}] {c['name']}: {c['detail']}")
    return "\n".join(lines)


def send_email(subject, body):
    password, _, rc = run([VAULT_GET, "email-sintra", "password"])
    password = password.strip()
    if rc != 0 or not password:
        print("ERROR: could not fetch email-sintra password from vault", file=sys.stderr)
        return False

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = "mercury@canislupisnc.net"
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"

    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login("mercury@canislupisnc.net", password)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"ERROR: email send failed: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Hermes fleet health aggregator")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--no-email", action="store_true")
    args = parser.parse_args()

    fleet = build_report()

    if args.format == "json":
        print(json.dumps(fleet, indent=2))
        sys.exit(0 if fleet["fleet_status"] != "Critical" else 1)

    text = render_text(fleet)
    print(text)

    if not args.no_email:
        subject = f"[Hermes Fleet] {fleet['fleet_status']} — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
        sent = send_email(subject, text)
        print(f"\nEmail {'sent' if sent else 'FAILED to send'} to {EMAIL_TO}")

    sys.exit(0 if fleet["fleet_status"] != "Critical" else 1)


if __name__ == "__main__":
    main()
