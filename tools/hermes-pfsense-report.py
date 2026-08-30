#!/usr/bin/env python3
# Version: 1.4.0
#
# 1.4.0 — HermesAgentV5 S13: ROUTER_MODEL switched nano -> dispatch. nano is retired
# (IMPLEMENTATION_PLAN.md S13); dispatch fills the same "always resident, stock, safe for an
# unattended daily run" role 1.3.0 originally picked nano for.
#
# 1.3.0 — ROUTER_MODEL switched super -> nano: the pfsense-report systemd
# unit had been left pointed at the retired HermesAgentRedo checkout (stale
# ROUTER_MODEL="weaver", now rejected by the router with 400). Repointing to
# this HermesAgentV4 checkout surfaced a second issue: super is on-demand
# and requires 85GiB free to wake, routinely unavailable given nano's own
# resident footprint (~80GiB available). nano is always resident, so this
# unattended daily digest now targets it directly instead of the
# escalation tier, avoiding the wake-or-503 gamble on every run.
#
# 1.2.0 — security-review fix: vault_get_email_password() now catches
# subprocess.TimeoutExpired instead of crashing on a complete Vaultwarden
# outage.
"""
hermes-pfsense-report.py — Daily pfSense firewall log digest, emailed to
The Boss. Pulls the real `filterlog` entries since the last successful run
(state-tracked, same pattern as hermes-canary-report.py), aggregates them
into honest, labeled buckets, and asks the fleet's own router for a
concise security brief on anything actually worth a look.

1.1.0 (2026-08-12, Phase 25, direct request: "are botnets attacking us? are
any of my internal systems reaching OUT to known botnets?"): every WAN
source IP already in this report's own PROBE-LIKE/sensitive-hit buckets is
now cross-referenced against hermes_botnet_intel.py's local threat-intel
cache for question (a); question (b) is answered by cross-referencing the
same cache against WAN-inbound *passed* traffic's source IPs — return
traffic for a LAN-initiated session, meaning a real successful exchange
with that external host, the strongest signal this report can produce
without enabling new pfSense-side outbound-pass logging — and against
LAN-to-external *blocked* destination IPs, an attempted-but-stopped
outbound contact. A `passed` match is flagged as the more serious of the
two explicitly, both in the text report and in the LLM prompt, since it
means the external host actually replied.

Built in response to a direct request (2026-08-09): "schedule a daily
check of the pfsense, and draft a report of ANY potential concerning
connections or trends." Runs via hermes-pfsense-report.timer — see
infra/hermes-pfsense-report/.

Why this isn't a naive "summarize the raw log" prompt: a live pull on
2026-08-09 showed ~18,600 parseable entries in a ~16-hour window, ~91%
of them a single LAN device's link-local UDP broadcast noise
(169.254.x.x), and a real live side-by-side test on the canary reporter
(hermes-canary-report.py, LESSONS_LEARNED.md) already found the fast
default model ("core") hallucinates against exactly this kind of noisy,
high-volume log data — handing 20k+ raw lines to any model would be both
slow and unreliable. Instead:
  1. Every entry is deterministically parsed and bucketed in plain code
     (WAN-inbound blocked/passed, sensitive-port hits, LAN-to-external
     blocks, broadcast noise, other) — no model involved in that step.
  2. Only the resulting *counts and standouts* — never raw per-packet
     data — go to the model ("weaver", the same reasoning-capable
     backend the canary reporter switched to after the hallucination
     finding), explicitly labeled as to which buckets are typically
     benign so it doesn't manufacture urgency about normal background
     noise.

Field layout for pf's filterlog CSV (confirmed against real captured
output, not the pfSense docs, which don't spell out field order):
  0 rulenum, 1 subrulenum, 2 anchor, 3 tracker, 4 interface, 5 reason,
  6 action, 7 direction, 8 ip_version, ..., 16 protocol, ...,
  18 src_ip, 19 dst_ip, 20 src_port, 21 dst_port (tcp/udp only — icmp and
  other protocols use different trailing fields, so ports are only
  trusted when protocol is tcp or udp). Only ip_version 4 is fully
  parsed; v6 lines are counted but not field-decomposed (this fleet's
  LAN is v4-only per network-topology.md, so v6 volume is expected to be
  near zero and not worth getting the different v6 field layout wrong
  for).

Known limitation: syslog timestamps in the log have no year. This fleet's
pfSense log rotates well within a year, so a bare current-year assumption
is safe in practice; not handled for the year-boundary edge case.

Usage:
  hermes-pfsense-report.py             # real run: fetch, analyze, email, advance state
  hermes-pfsense-report.py --dry-run   # print instead of emailing; state untouched
"""

import argparse
import json
import re
import smtplib
import subprocess
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from ipaddress import ip_address
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_pfsense_common import HOST, VAULT_SCRIPT, get_api_key, make_context, api_get  # noqa: E402
from hermes_botnet_intel import lookup_many, cache_age_hours  # noqa: E402

STATE_FILE = Path.home() / ".hermes" / "state" / "pfsense-report-state.json"
ROUTER_URL = "http://127.0.0.1:8080/v1/chat/completions"
ROUTER_MODEL = "dispatch"  # 1.4.0 (V5 S13): nano retired. dispatch is the new always-resident,
                        # stock role — same reason nano was chosen over super in 1.3.0 still
                        # applies (super is on-demand, needs 85GiB free to wake, routinely
                        # unavailable), and this routine unattended daily digest still needs
                        # something that never risks a 503.

# One pull per day, sized generously above the real measured rate (~18,600
# parseable entries in a ~16h window on 2026-08-09, so a 24h day is roughly
# 25-30k) so a normal day fits in one fetch without truncation.
FETCH_LIMIT = 60000

EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

WAN_IFACE = "igc0"
LAN_IFACE = "igc1"

# Ports worth calling out by name wherever seen on the WAN interface,
# regardless of block/pass or volume — remote-admin, database, and common
# IoT-botnet-target ports. Not exhaustive; extend as real findings warrant.
SENSITIVE_PORTS = {
    20: "FTP-data", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP",
    161: "SNMP", 445: "SMB", 1433: "MSSQL", 1521: "Oracle", 2375: "Docker",
    3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL", 5900: "VNC",
    5985: "WinRM", 6379: "Redis", 8291: "MikroTik Winbox",
    9200: "Elasticsearch", 27017: "MongoDB", 37777: "DVR/NVR",
    52869: "UPnP (RealTek exploit port)",
}

# An external source touching this many distinct WELL-KNOWN WAN dst_ports
# (< 1024) looks like real service probing. Deliberately NOT based on total
# distinct-port count: a live run on 2026-08-09 found that heuristic flagged
# real Google/YouTube CDN IPs (172.217.x.x, 64.233.x.x, 142.251.x.x) hitting
# many distinct *high ephemeral* ports as "scan-like" — that pattern is the
# signature of ordinary QUIC/UDP-443 NAT-state-timeout backscatter from this
# LAN's own browsing/streaming, not scanning, and would have made the LLM
# report it as "possible reconnaissance." Restricting to <1024 ports (actual
# named services) avoids that false positive while still catching a real
# scanner probing SSH/RDP/SMB/etc.
PROBE_PORT_THRESHOLD = 3
# A LAN source with blocked connections to this many distinct external
# destinations stands out from ordinary browsing (which pf usually just
# allows) — heuristic, not a confirmed compromise signal.
FANOUT_THRESHOLD = 15

LOG_LINE_RE = re.compile(r"^(\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d)\s+\S+\s+filterlog\[\d+\]:\s*(.*)$")

JSON_START = "###PFSENSE_REPORT_JSON_START###"
JSON_END = "###PFSENSE_REPORT_JSON_END###"


# ── state ────────────────────────────────────────────────────────────────

def load_since() -> datetime:
    try:
        data = json.loads(STATE_FILE.read_text())
        return datetime.fromisoformat(data["last_run_utc"])
    except Exception:
        return datetime.now(timezone.utc) - timedelta(hours=24)


def save_since(ts: datetime):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps({"last_run_utc": ts.isoformat()}))


# ── fetch + parse ────────────────────────────────────────────────────────

def fetch_raw_logs(api_key, ctx):
    data, err = api_get("/status/logs/firewall", api_key, ctx,
                         params={"limit": FETCH_LIMIT}, timeout=60)
    if err:
        raise RuntimeError(err)
    return [e.get("text", "") for e in data.get("data", [])]


def fetch_hostnames(api_key, ctx):
    """Best-effort ip -> hostname map from current DHCP leases, so LAN source
    IPs in the report can be identified without a manual lookup. Never fatal —
    an empty map just means the report falls back to bare IPs."""
    data, err = api_get("/status/dhcp_server/leases", api_key, ctx)
    if err:
        return {}
    return {
        lease.get("ip"): lease.get("hostname")
        for lease in data.get("data", [])
        if lease.get("ip") and lease.get("hostname")
    }


def label(ip, hostnames):
    name = hostnames.get(ip)
    return f"{ip} ({name})" if name else ip


def parse_line(text, year):
    m = LOG_LINE_RE.match(text)
    if not m:
        return None
    ts_str, csv_part = m.groups()
    ts_str = re.sub(r"\s+", " ", ts_str.strip())
    try:
        ts = datetime.strptime(f"{year} {ts_str}", "%Y %b %d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None

    fields = csv_part.split(",")
    if len(fields) < 20:
        return None

    ip_version = fields[8]
    protocol = fields[16].lower()
    entry = {
        "ts": ts, "interface": fields[4], "action": fields[6], "direction": fields[7],
        "ip_version": ip_version, "protocol": protocol,
        "src_ip": fields[18], "dst_ip": fields[19],
        "src_port": None, "dst_port": None, "raw": text,
    }
    if ip_version == "4" and protocol in ("tcp", "udp") and len(fields) > 21:
        entry["src_port"] = fields[20]
        entry["dst_port"] = fields[21]
    return entry


def _is_broadcast_or_link_local(ip_str):
    try:
        ip = ip_address(ip_str)
    except ValueError:
        return False
    return ip.is_link_local or ip_str.endswith(".255") or ip_str == "255.255.255.255"


def _is_private(ip_str):
    try:
        return ip_address(ip_str).is_private
    except ValueError:
        return False


# ── categorize ───────────────────────────────────────────────────────────

def analyze(entries):
    wan_in_blocked = Counter()
    wan_in_blocked_ports = defaultdict(set)
    wan_in_blocked_wellknown_ports = defaultdict(set)
    wan_in_passed = []
    sensitive_hits = []
    lan_to_external_blocked = defaultdict(lambda: {"count": 0, "dsts": set()})
    lan_broadcast_noise = 0
    other = 0
    ipv6_count = 0
    unparsed = 0

    for e in entries:
        if e is None:
            unparsed += 1
            continue
        if e["ip_version"] != "4":
            ipv6_count += 1
            continue

        iface, action, direction = e["interface"], e["action"], e["direction"]
        src, dst, dport = e["src_ip"], e["dst_ip"], e["dst_port"]

        if iface == WAN_IFACE and direction == "in":
            if dport and int(dport) in SENSITIVE_PORTS:
                sensitive_hits.append(e)
            if action == "block":
                wan_in_blocked[src] += 1
                if dport:
                    wan_in_blocked_ports[src].add(dport)
                    if int(dport) < 1024:
                        wan_in_blocked_wellknown_ports[src].add(dport)
            elif action == "pass":
                wan_in_passed.append(e)
            else:
                other += 1
        elif iface == LAN_IFACE and direction == "in" and action == "block":
            if _is_broadcast_or_link_local(dst):
                lan_broadcast_noise += 1
            elif dst and not _is_private(dst):
                lan_to_external_blocked[src]["count"] += 1
                lan_to_external_blocked[src]["dsts"].add(dst)
            else:
                other += 1
        else:
            other += 1

    scan_candidates = {
        src: ports for src, ports in wan_in_blocked_wellknown_ports.items()
        if len(ports) >= PROBE_PORT_THRESHOLD
    }
    fanout_candidates = {
        src: v for src, v in lan_to_external_blocked.items()
        if len(v["dsts"]) >= FANOUT_THRESHOLD
    }

    return {
        "wan_in_blocked": wan_in_blocked,
        "wan_in_blocked_ports": wan_in_blocked_ports,
        "wan_in_blocked_wellknown_ports": wan_in_blocked_wellknown_ports,
        "wan_in_passed": wan_in_passed,
        "sensitive_hits": sensitive_hits,
        "lan_to_external_blocked": lan_to_external_blocked,
        "lan_broadcast_noise": lan_broadcast_noise,
        "scan_candidates": scan_candidates,
        "fanout_candidates": fanout_candidates,
        "other": other,
        "ipv6_count": ipv6_count,
        "unparsed": unparsed,
    }


# ── report text ──────────────────────────────────────────────────────────

def build_summary_text(a, since, total_entries, truncated_by_limit, rotation_gap, hostnames):
    lines = [f"pfSense firewall log digest — since {since.strftime('%Y-%m-%d %H:%M')} UTC "
             f"({total_entries} entries fetched)\n"]
    if truncated_by_limit:
        lines.append(f"NOTE: fetch limit ({FETCH_LIMIT}) reached — traffic volume was higher than "
                      f"usual and this window may not cover the full period since the last run.\n")
    elif rotation_gap:
        lines.append("NOTE: pfSense's own log rotation had already discarded entries older than "
                      "what's covered here — nothing this tool could have fetched, not a bug.\n")

    lines.append(f"[Known-benign LAN broadcast/link-local noise: {a['lan_broadcast_noise']} entries — "
                  f"not itemized, this is routine background chatter]\n")

    total_wan_blocked = sum(a["wan_in_blocked"].values())
    lines.append(f"WAN inbound — blocked: {total_wan_blocked} entries from "
                 f"{len(a['wan_in_blocked'])} distinct source IPs "
                 f"(typical internet background scanning/backscatter on a home connection):")
    for src, count in a["wan_in_blocked"].most_common(15):
        ports = a["wan_in_blocked_ports"].get(src, set())
        # High distinct-port counts here are usually just NAT/state-timeout backscatter
        # from this LAN's own outbound QUIC/UDP sessions to big cloud/CDN providers
        # (confirmed live 2026-08-09 — see PROBE_PORT_THRESHOLD's comment) — shown for
        # context only, not itself a signal, which is why PROBE-LIKE below uses a
        # different, well-known-port-only count instead.
        lines.append(f"  {src}: {count}x, {len(ports)} distinct dst port(s) (context only)")
    if a["scan_candidates"]:
        lines.append(f"  PROBE-LIKE (>= {PROBE_PORT_THRESHOLD} distinct WELL-KNOWN ports, i.e. < 1024, "
                      f"from one source — a real signal, unlike the high ephemeral-port counts above):")
        for src, ports in sorted(a["scan_candidates"].items(), key=lambda x: -len(x[1])):
            lines.append(f"    {src}: ports {sorted(int(p) for p in ports)}")
    lines.append("")

    lines.append(f"WAN inbound — passed (allowed onto the LAN): {len(a['wan_in_passed'])} entries "
                 f"(usually return traffic for a LAN-initiated session; a real port-forward would "
                 f"also show up here):")
    for e in a["wan_in_passed"][:20]:
        lines.append(f"  {e['ts'].strftime('%H:%M:%S')}  {e['src_ip']}:{e['src_port']} -> "
                     f"{e['dst_ip']}:{e['dst_port']} ({e['protocol']})")
    if len(a["wan_in_passed"]) > 20:
        lines.append(f"  (+{len(a['wan_in_passed']) - 20} more)")
    lines.append("")

    lines.append(f"Sensitive-port hits on WAN (any action): {len(a['sensitive_hits'])}")
    for e in a["sensitive_hits"][:20]:
        svc = SENSITIVE_PORTS.get(int(e["dst_port"]), "?") if e["dst_port"] else "?"
        lines.append(f"  {e['ts'].strftime('%H:%M:%S')}  {e['action']}  {e['src_ip']} -> "
                     f"port {e['dst_port']} ({svc})")
    if len(a["sensitive_hits"]) > 20:
        lines.append(f"  (+{len(a['sensitive_hits']) - 20} more)")
    lines.append("")

    total_lan_ext = sum(v["count"] for v in a["lan_to_external_blocked"].values())
    lines.append(f"LAN hosts blocked reaching external IPs: {total_lan_ext} entries from "
                 f"{len(a['lan_to_external_blocked'])} internal source(s) (often just late/expired-"
                 f"connection packets arriving after a session already closed — normal, but a host "
                 f"hitting many distinct destinations stands out):")
    for src, v in sorted(a["lan_to_external_blocked"].items(), key=lambda x: -x[1]["count"])[:15]:
        lines.append(f"  {label(src, hostnames)}: {v['count']}x to {len(v['dsts'])} distinct destination(s)")
    if a["fanout_candidates"]:
        lines.append(f"  HIGH FANOUT (>= {FANOUT_THRESHOLD} distinct external destinations):")
        for src, v in a["fanout_candidates"].items():
            lines.append(f"    {label(src, hostnames)}: {len(v['dsts'])} destinations")
    lines.append("")

    lines.append(f"Other/uncategorized: {a['other']}  |  IPv6 (not decomposed): {a['ipv6_count']}  |  "
                 f"Unparsed lines: {a['unparsed']}")
    return "\n".join(lines)


def build_botnet_section(a, hostnames):
    """Cross-references this run's WAN-inbound and LAN-to-external IPs
    against the local botnet/C2 cache, answering the two questions this
    integration exists for: (a) are known-bad IPs attacking us — checked
    against WAN-inbound blocked sources and sensitive-port hits; (b) is
    anything on the LAN reaching OUT to known-bad infrastructure — checked
    against WAN-inbound *passed* traffic (return traffic for a
    LAN-initiated session — a real successful exchange, the strongest
    outbound signal available without enabling new pfSense pass-logging)
    and LAN-to-external *blocked* destinations (an attempted-but-stopped
    outbound contact). Returns (text, matches_dict); matches_dict feeds the
    JSON block. A stale/missing cache says so plainly rather than reporting
    a false "no matches"."""
    age = cache_age_hours()
    if age is None:
        return ("BOTNET/C2 CHECK: cache has never synced — see "
                "infra/hermes-botnet-intel-sync/, results below are not meaningful.\n", {})

    inbound_candidates = set(a["wan_in_blocked"].keys()) | {e["src_ip"] for e in a["sensitive_hits"]}
    outbound_passed_candidates = {e["src_ip"] for e in a["wan_in_passed"]}
    outbound_blocked_candidates = {
        dst for v in a["lan_to_external_blocked"].values() for dst in v["dsts"]
    }

    inbound = lookup_many(inbound_candidates)
    outbound_passed = lookup_many(outbound_passed_candidates)
    outbound_blocked = lookup_many(outbound_blocked_candidates)

    lines = [f"BOTNET/C2 CHECK (cache age {age:.1f}h):"]
    if age > 30:
        lines.append(f"  WARNING: cache is {age:.1f}h old (expected refresh every 6h) — "
                      f"hermes-botnet-intel-sync.timer may be down, treat results with caution.")

    lines.append("  (a) Are known-bad IPs attacking us? (WAN-inbound blocked / sensitive-port sources)")
    if not inbound:
        lines.append("      No match.")
    else:
        for ip, hits in inbound.items():
            for h in hits:
                lines.append(f"      MATCH {ip}: {h['label']} ({h['tag']}) [{h['confidence']}]")

    lines.append("  (b) Is anything on the LAN reaching OUT to known-bad infrastructure?")
    if not outbound_passed and not outbound_blocked:
        lines.append("      No match.")
    else:
        for ip, hits in outbound_passed.items():
            who = [e["dst_ip"] for e in a["wan_in_passed"] if e["src_ip"] == ip]
            lan_side = label(who[0], hostnames) if who else "?"
            for h in hits:
                lines.append(f"      MATCH (PASSED — real exchange) {lan_side} <-> {ip}: "
                              f"{h['label']} ({h['tag']}) [{h['confidence']}]")
        for ip, hits in outbound_blocked.items():
            lan_srcs = [src for src, v in a["lan_to_external_blocked"].items() if ip in v["dsts"]]
            lan_side = ", ".join(label(s, hostnames) for s in lan_srcs) or "?"
            for h in hits:
                lines.append(f"      MATCH (blocked attempt) {lan_side} -> {ip}: "
                              f"{h['label']} ({h['tag']}) [{h['confidence']}]")

    return ("\n".join(lines) + "\n",
            {"inbound": inbound, "outbound_passed": outbound_passed, "outbound_blocked": outbound_blocked})


def ask_llm(summary_text, botnet_text):
    prompt = (
        "You are a network security analyst reviewing a home network's pfSense firewall log "
        "digest for the last reporting period. The digest below has already been deterministically "
        "aggregated from raw logs — the counts are exact, not your estimate.\n\n"
        f"{summary_text}\n\n{botnet_text}\n\n"
        "Write a concise security brief (5-12 sentences) for the network's owner. Rules:\n"
        "- Any BOTNET/C2 CHECK match with confidence 'high' (Spamhaus/Feodo) is a real, "
        "curated threat-intel hit — name it explicitly and push the risk level up. A "
        "'PASSED — real exchange' match under (b) is more serious than a blocked attempt: "
        "it means a LAN device actually exchanged traffic with the flagged host, not just "
        "attempted to. A 'community' confidence match (TweetFeed) is unvetted OSINT — "
        "mention it but weigh it less heavily than a 'high' match.\n"
        "- The broadcast/link-local noise line, ordinary 'WAN inbound blocked' background probing, "
        "and the '(context only)' distinct-port counts are all routine on any home internet "
        "connection (the latter is typically just NAT/state-timeout backscatter from this LAN's own "
        "outbound traffic to cloud/CDN providers, not scanning) — do not treat their volume alone as "
        "concerning, and do not lead with them.\n"
        "- Actually call out anything under PROBE-LIKE, sensitive-port hits, WAN inbound PASSED "
        "traffic, and HIGH FANOUT — these are the sections worth a human's attention. Say plainly "
        "if none of these sections have anything in them.\n"
        "- For HIGH FANOUT entries, use the device hostname (shown in parentheses, from real DHCP "
        "leases) to judge plausibility: a streaming box, phone, or tablet reaching many distinct "
        "destinations is ordinary (CDNs, ad/analytics networks, app backends). The same fanout from "
        "a device whose name suggests a printer, NAS, camera, or other single-purpose/IoT device "
        "would be far more surprising and deserves more weight in the risk level. No hostname at "
        "all is itself worth a mention — an unidentified device on the LAN.\n"
        "- Do not invent a source, IP, or port that isn't in the text above.\n"
        "- End with an overall risk level: Low / Medium / High, and one sentence of justification."
    )
    body = json.dumps({
        "model": ROUTER_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "temperature": 0.3,
        "max_tokens": 1024,
    }).encode()
    req = urllib.request.Request(ROUTER_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        message = json.loads(resp.read())["choices"][0]["message"]
        content = (message.get("content") or "").strip()
        if content:
            return content
        return (message.get("reasoning_content") or "").strip() or "(model returned no content)"


# ── email ────────────────────────────────────────────────────────────────

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
    # A different vault item ("email-sintra") than hermes_pfsense_common.vault_get
    # fetches ("Hermes pfSense"), so that helper doesn't apply here — same
    # item/field hermes-fleet-health.py and hermes-nfsensei-watch.py already use.
    # timeout=60, not 30: vault-get-secret.sh 1.2.0 retries internally up to 3x on
    # a real transient bw/Vaultwarden failure; a 30s timeout could kill it mid-recovery.
    try:
        result = subprocess.run([VAULT_SCRIPT, "email-sintra", "password"],
                                 capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


# ── main ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Daily pfSense firewall log digest")
    parser.add_argument("--dry-run", action="store_true",
                         help="Print instead of emailing; don't advance state")
    args = parser.parse_args()

    run_started = datetime.now(timezone.utc)
    since = load_since()

    api_key = get_api_key()
    if not api_key:
        print("ERROR: could not fetch 'api_key' from vault item 'Hermes pfSense'", file=sys.stderr)
        sys.exit(1)

    ctx = make_context()
    try:
        raw_lines = fetch_raw_logs(api_key, ctx)
    except Exception as e:
        print(f"ERROR: could not fetch firewall log: {e}", file=sys.stderr)
        sys.exit(1)
    hostnames = fetch_hostnames(api_key, ctx)

    year = run_started.year
    parsed = [parse_line(t, year) for t in raw_lines]
    entries = [e for e in parsed if e is not None and e["ts"] >= since]

    # A coverage gap (oldest kept entry newer than `since`) has two different
    # real causes that need different messages: hitting FETCH_LIMIT (our own
    # pull was too small for the volume) vs. pfSense's own log rotation
    # already having discarded anything older (nothing we could have fetched).
    hit_fetch_limit = len(raw_lines) >= FETCH_LIMIT
    has_gap = bool(entries) and min(e["ts"] for e in entries) > since + timedelta(minutes=5)
    truncated_by_limit = has_gap and hit_fetch_limit
    rotation_gap = has_gap and not hit_fetch_limit

    a = analyze(entries)
    summary_text = build_summary_text(a, since, len(entries), truncated_by_limit, rotation_gap, hostnames)

    botnet_text, botnet_matches = build_botnet_section(a, hostnames)

    print(f"=== pfSense Daily Report ({HOST}) ===\n")
    print(summary_text)
    print()
    print(botnet_text)

    try:
        analysis = ask_llm(summary_text, botnet_text)
        print("--- AI Security Analysis ---")
        print(analysis)
    except Exception as e:
        analysis = f"(router unreachable: {e})"
        print("--- AI Security Analysis unavailable ---")
        print(analysis)

    full_report = f"{summary_text}\n\n{botnet_text}\n\n--- AI Security Analysis ---\n{analysis}"

    print()
    print(JSON_START)
    print(json.dumps({
        "since": since.isoformat(),
        "wan_in_blocked_total": sum(a["wan_in_blocked"].values()),
        "wan_in_passed_total": len(a["wan_in_passed"]),
        "sensitive_hits_total": len(a["sensitive_hits"]),
        "scan_candidates": list(a["scan_candidates"].keys()),
        "fanout_candidates": {ip: hostnames.get(ip) for ip in a["fanout_candidates"]},
        "botnet_matches": botnet_matches,
    }))
    print(JSON_END)

    if args.dry_run:
        print("\n--dry-run: not emailed, state not saved")
        return

    subject = f"[pfSense] Daily digest — {run_started.strftime('%Y-%m-%d')}"
    sent = send_email(subject, full_report)
    print(f"\nEmail {'sent' if sent else 'FAILED to send'} to {EMAIL_TO}")

    # Only advance the state marker on a fully successful run, matching
    # hermes-canary-report.py's reasoning — a failed run should be retried
    # over the same window next time, not silently skipped.
    if sent:
        save_since(run_started)


if __name__ == "__main__":
    main()
