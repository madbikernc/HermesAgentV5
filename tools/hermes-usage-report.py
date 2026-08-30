#!/usr/bin/env python3
# Version: 1.2.1
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: VAULT_SCRIPT path repointed from
# HermesAgentV4 to HermesAgentV5.
#
# 1.2.0 — HermesAgentV5 S13: ROLES kept in sync with hermes-router.py 2.8.0's own ROLES dict —
# nano removed (retired), dispatch added. guard/embed/asr are deliberately not added here even
# though they're live V5 services: none of them are entries in hermes-router.py's own ROLES map
# (each has its own dedicated port/service, never proxied through the router), so they never
# appear in the usage log this report summarizes in the first place.
#
# 1.1.0 — security-review fix: vault_get_email_password() now catches
# subprocess.TimeoutExpired instead of crashing on a complete Vaultwarden
# outage.
"""
hermes-usage-report.py — Weekly digest of hermes-router.py's per-request usage
log (hermes_usage_log.py), emailed to The Boss. Answers the question that
motivated the log in the first place: which of the Spark's resident backends
(core/weaver/muse/vision) are actually earning their place, so model choice
over time can be a data-driven decision rather than a guess.

1.0.1 (2026-08-14): real bug found on the first live run — `usage_log`'s
schema was only ever created inside hermes-router.py's own main(), so a
report run before the router had (re)started on this version, or before it
had logged a single request, crashed with "no such table: usage_log" instead
of just reporting an empty week. Fixed by having this script create the
schema itself too (CREATE TABLE IF NOT EXISTS is idempotent and WAL-safe
against the router's own writer).

Deliberately no LLM call in this report, unlike hermes-pfsense-report.py and
hermes-canary-report.py: the content here is a small set of exact counts
already computed in plain code, an LLM adds no analysis a human can't read
directly off the numbers, and — the sharper reason — asking the router for a
closing brief would itself be a `core` request that lands in the very usage
log this report is about to summarize, skewing the thing it measures.

Always reports two fixed, non-overlapping trailing windows — the last 7 days
and the 7 days before that — rather than tracking a "since last run" state
file the way the pfSense/canary reports do. That's a deliberate difference,
not an oversight: those reports consume a live external log with its own
rotation, so a missed run has to be caught up incrementally. This one only
ever re-reads its own already-durable SQLite log, so recomputing the same
week's stats is idempotent — a missed or rerun week costs nothing, and
there's no state file to get out of sync with the DB.

Usage:
  hermes-usage-report.py             # real run: analyze, email
  hermes-usage-report.py --dry-run   # print instead of emailing
"""
import argparse
import smtplib
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_usage_log import fetch_range, init_db  # noqa: E402

# Kept in sync by hand with hermes-router.py's own ROLES dict — that file's
# filename has a hyphen, so it can't be `import`ed here to share the list.
ROLES = ["super", "coder", "muse", "omni", "dispatch"]  # V5 S13: nano retired, dispatch added

PERIOD = timedelta(days=7)

EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

VAULT_SCRIPT = f"{Path.home()}/HermesAgentV5/tools/vault-get-secret.sh"

IDLE_ERROR_RATE_THRESHOLD = 0.1  # 10%+ errors in a week is worth flagging


def _percentile(sorted_vals, pct):
    if not sorted_vals:
        return None
    idx = min(len(sorted_vals) - 1, int(round(pct / 100 * (len(sorted_vals) - 1))))
    return sorted_vals[idx]


def per_role_stats(rows):
    by_role = {role: [] for role in ROLES}
    for row in rows:
        by_role.setdefault(row["role"], []).append(row)

    stats = {}
    for role, role_rows in by_role.items():
        count = len(role_rows)
        errors = [r for r in role_rows if r["status"] != "ok"]
        latencies = sorted(r["latency_ms"] for r in role_rows if r["latency_ms"] is not None)
        # Throughput is computed only from successful rows that actually reported a token count —
        # an error row's latency (e.g. a fast connection-refused) has no associated completion
        # tokens and would otherwise drag the estimate down for reasons unrelated to generation speed.
        timed = [r for r in role_rows if r["status"] == "ok" and r["completion_tokens"]]
        completion_tokens = sum(r["completion_tokens"] for r in timed)
        total_latency_s = sum(r["latency_ms"] for r in timed) / 1000
        stats[role] = {
            "count": count,
            "error_count": len(errors),
            "error_rate": (len(errors) / count) if count else 0.0,
            "p50_ms": _percentile(latencies, 50),
            "p95_ms": _percentile(latencies, 95),
            "tokens_per_sec": (completion_tokens / total_latency_s) if total_latency_s > 0 else None,
            "completion_tokens": completion_tokens,
        }
    return stats


def build_report_text(now, current_rows, previous_rows):
    current = per_role_stats(current_rows)
    previous = per_role_stats(previous_rows)

    lines = [
        f"Hermes model-usage digest — {now.strftime('%Y-%m-%d')} "
        f"(last 7 days vs. the 7 before that)\n",
    ]

    idle_roles = []
    unreliable_roles = []

    for role in ROLES:
        c = current[role]
        p = previous[role]
        delta = c["count"] - p["count"]
        sign = "+" if delta >= 0 else ""
        trend = f"{sign}{delta} vs. prior week" if p["count"] or c["count"] else "no data either week"

        lines.append(f"{role}:")
        lines.append(f"  requests: {c['count']} ({trend})")
        if c["count"]:
            lines.append(f"  latency: p50 {c['p50_ms']}ms / p95 {c['p95_ms']}ms")
            tps = f"{c['tokens_per_sec']:.1f} tok/s" if c["tokens_per_sec"] is not None else "n/a (no token data)"
            lines.append(f"  throughput: {tps}  ({c['completion_tokens']} completion tokens total)")
            lines.append(f"  errors: {c['error_count']} ({c['error_rate']:.0%})")
        else:
            lines.append("  IDLE — zero requests this week")
            idle_roles.append(role)
        if c["count"] and c["error_rate"] >= IDLE_ERROR_RATE_THRESHOLD:
            unreliable_roles.append(role)
        lines.append("")

    lines.append("Decision signals:")
    if idle_roles:
        lines.append(f"  - Idle this week: {', '.join(idle_roles)} — candidates for consolidating "
                      f"onto another role's backend rather than staying resident.")
    else:
        lines.append("  - No role was fully idle this week.")
    if unreliable_roles:
        lines.append(f"  - Error rate >= {IDLE_ERROR_RATE_THRESHOLD:.0%}: {', '.join(unreliable_roles)} "
                      f"— worth checking whether that's the backend or its callers.")
    lines.append("")

    return "\n".join(lines)


def send_email(subject, body):
    password = vault_get_email_password()
    if not password:
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


def vault_get_email_password():
    # Same "email-sintra" vault item hermes-pfsense-report.py and
    # hermes-fleet-health.py already use. timeout=60, not 30: vault-get-secret.sh
    # 1.2.0 retries internally up to 3x on a real transient bw/Vaultwarden failure.
    try:
        result = subprocess.run([VAULT_SCRIPT, "email-sintra", "password"],
                                 capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def main():
    parser = argparse.ArgumentParser(description="Weekly hermes-router model-usage digest")
    parser.add_argument("--dry-run", action="store_true", help="Print instead of emailing")
    args = parser.parse_args()

    init_db()
    now = datetime.now(timezone.utc)
    current_start = now - PERIOD
    previous_start = now - 2 * PERIOD

    current_rows = fetch_range(current_start.isoformat(), now.isoformat())
    previous_rows = fetch_range(previous_start.isoformat(), current_start.isoformat())

    report = build_report_text(now, current_rows, previous_rows)
    print(report)

    if args.dry_run:
        print("--dry-run: not emailed")
        return

    subject = f"[Hermes] Weekly model-usage digest — {now.strftime('%Y-%m-%d')}"
    sent = send_email(subject, report)
    print(f"\nEmail {'sent' if sent else 'FAILED to send'} to {EMAIL_TO}")


if __name__ == "__main__":
    main()
