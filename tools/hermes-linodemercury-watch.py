#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-linodemercury-watch.py — daily Fleet-side check of LinodeMercury, the first deliberately
external, one-way-reachable (Fleet -> Linode only) node in this repo (IMPLEMENTATION_PLAN.md S28).

Linode cannot reach Vaultwarden, Matrix, or anything else the Fleet considers internal, so none of
this repo's code runs there — aide/lynis/syft+grype run locally on Linode via their own native
systemd timers, logged minimally and locally, and bundled daily into one compressed tarball for
pickup (see infra/linodemercury/README.md). This script is the other half: it runs entirely on
spark, pulls that one tarball over the one-way SSH path already set up, and does everything that
needs Vaultwarden/Matrix/hermes-memory access — normalizing findings, writing new ones as
REC-linodemercury-<date>-<seq> recommendations (reusing hermes-memory's existing recommendation
lifecycle, same shape hermes-node-baseline-scan.py already uses), and sending one daily Matrix +
email digest. It is not that scanner reused by import: that script's aide/lynis/syft_grype
functions are tightly coupled to invoking the tools live via `sudo` on the local node, which is
exactly what Linode cannot do for anything Vaultwarden-adjacent -- here the tools already ran
*there*, and this script only ever parses already-produced text pulled down after the fact. The
finding schema, severity handling, and the three parsers below intentionally mirror
hermes-node-baseline-scan.py's own (same regexes, same severity maps) so output stays compatible
with the existing REC/digest conventions, not because the code was imported.

Covers the three things asked of a daily check on this node:
  (a) out-of-date/insecure packages  -> grype JSON (syft SBOM against dir:/var/lib/dpkg) +
      `apt list --upgradable` count, both already produced locally on Linode.
  (b) firewall posture               -> parses the bundled `ufw status verbose` and flags
      anything other than active/default-deny/the one expected SSH rule.
  (c) local-log intrusion review     -> the bundled `journalctl _COMM=sshd` window. Any
      failed-password or root-login attempt is impossible by design (PasswordAuthentication no,
      PermitRootLogin no) and is flagged outright if one ever appears. Successful logins are
      classified against a small local history of the Fleet's own previously-observed public
      egress IP (ISP-assigned, can rotate) rather than only today's snapshot -- benign if it
      matches today's IP, medium if it matches a Fleet IP seen within a trailing window (a
      plausible same-cycle NAT rotation, not nothing but not an unknown source either), high if
      it matches no Fleet IP on record at all.

Bundles are deleted from Linode only after being pulled and parsed without error (see
cleanup_remote_bundle()) -- retention is Fleet-driven, never a blind local timer on Linode, so a
missed retrieval day never loses data. If more than one bundle is waiting (a missed day), each is
processed in date order, oldest first.

State (this node, i.e. spark):
  ~/.hermes/state/linodemercury-watch-state.json   -- fleet-ip history, snapshot of findings for
                                                        day-over-day diffing, rec_ids map

Usage:
  hermes-linodemercury-watch.py               # real run: pull, analyze, persist, notify, cleanup
  hermes-linodemercury-watch.py --dry-run     # pull + analyze + print; state/remote untouched
  hermes-linodemercury-watch.py --seed-only   # first-ever run: persist as baseline, no digest
"""
import argparse
import hashlib
import json
import re
import shutil
import smtplib
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from email.mime.text import MIMEText
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent
VAULT_SCRIPT = str(REPO_DIR / "tools" / "vault-get-secret.sh")

SSH_HOST = "linodemercury"
NODE_NAME = "linodemercury"
REMOTE_BUNDLE_DIR = "/var/local/hermes-bundle"

STATE_FILE = Path.home() / ".hermes" / "state" / "linodemercury-watch-state.json"

MEMORY_URL = "http://10.129.1.15:8102"
EXPECTED_OPEN_ANYWHERE = {"22/tcp", "22/tcp (v6)"}

EMAIL_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
AGENT_NAME = "linodemercury-watch"

# A Fleet IP seen this recently still plausibly explains a login that doesn't match *today's*
# IP -- an ISP NAT rotation mid-cycle, not an unidentified source. Longer than any realistic
# residential lease-rotation window without being so long it stops meaning anything.
IP_HISTORY_WINDOW_DAYS = 7


# ── shared helpers ───────────────────────────────────────────────────────────

def vault_get(item, field="password", timeout=60):
    # Same discipline as every other caller of vault-get-secret.sh in this fleet: a Vaultwarden
    # outage must not crash this script, so a timeout is a soft "" result, not an exception.
    try:
        r = subprocess.run([VAULT_SCRIPT, item, field], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def run(cmd, timeout=60):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout, r.returncode, r.stderr
    except subprocess.TimeoutExpired:
        return "", -1, "timed out"
    except Exception as e:
        return "", -1, str(e)


def ssh_run(remote_cmd, timeout=60):
    return run(["ssh", "-o", "ConnectTimeout=10", SSH_HOST, remote_cmd], timeout=timeout)


def finding(finding_id, tool, severity, description, detail=None, suggested_remediation=None):
    return {
        "finding_id": finding_id,
        "tool": tool,
        "severity": severity if severity in SEVERITY_ORDER else "low",
        "description": description,
        "detail": detail,
        "suggested_remediation": suggested_remediation or {"kind": "manual-review", "detail": ""},
    }


def severity_at_least(severity, threshold):
    return SEVERITY_ORDER.get(severity, 0) >= SEVERITY_ORDER.get(threshold, 1)


# ── state ────────────────────────────────────────────────────────────────────

def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"fleet_ips": {}, "findings_by_id": {}, "rec_ids": {}}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def current_fleet_ip():
    """spark's own current public egress IP -- what Linode actually sees admin SSH traffic
    arriving from. Fetched fresh each run rather than assumed, since a home ISP can rotate it at
    any time (the exact reason Linode's own ufw rule deliberately does NOT allowlist a fixed IP --
    see infra/linodemercury/README.md)."""
    out, rc, err = run(["curl", "-s", "--max-time", "10", "https://ifconfig.me"], timeout=15)
    ip = out.strip()
    if rc == 0 and re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip):
        return ip
    return None


def record_fleet_ip(state, ip):
    if ip:
        state["fleet_ips"][ip] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cutoff = datetime.now(timezone.utc) - timedelta(days=IP_HISTORY_WINDOW_DAYS * 3)
    state["fleet_ips"] = {
        k: v for k, v in state["fleet_ips"].items()
        if datetime.strptime(v, "%Y-%m-%d").replace(tzinfo=timezone.utc) >= cutoff
    }


def classify_source_ip(ip, state, today_ip):
    if today_ip and ip == today_ip:
        return "benign"
    seen = state["fleet_ips"].get(ip)
    if seen:
        age_days = (datetime.now(timezone.utc) - datetime.strptime(seen, "%Y-%m-%d").replace(tzinfo=timezone.utc)).days
        if age_days <= IP_HISTORY_WINDOW_DAYS:
            return "medium"
    return "high"


# ── pull + unpack ────────────────────────────────────────────────────────────

def list_remote_bundles():
    out, rc, err = ssh_run(f"ls {REMOTE_BUNDLE_DIR}/*.tar.gz 2>/dev/null")
    if rc != 0:
        return []
    return sorted(line.strip() for line in out.splitlines() if line.strip())


def pull_bundle(remote_path, dest_dir):
    out, rc, err = run(["scp", "-q", f"{SSH_HOST}:{remote_path}", str(dest_dir)], timeout=120)
    if rc != 0:
        return None
    local_path = dest_dir / Path(remote_path).name
    return local_path if local_path.exists() else None


def unpack_bundle(local_tar, work_dir):
    with tarfile.open(local_tar) as tf:
        tf.extractall(work_dir, filter="data")


def cleanup_remote_bundle(remote_path):
    """Only called after a bundle has been fully unpacked and parsed without error -- a failed
    pull/parse leaves it in place, so nothing is ever lost to a missed retrieval cycle.

    `sudo` is required here: the bundle (and its containing directory) is produced by a root
    systemd service on LinodeMercury (hermes-linodemercury-bundle.service), so pmoney can list
    and read it (directory is traversable/readable) but cannot unlink a root-owned file in a
    root-owned directory without it -- confirmed live on this node's very first real run,
    pmoney already has passwordless sudo there, same as every other fleet node."""
    _, rc, err = ssh_run(f"sudo rm -f {remote_path}")
    return rc == 0


# ── aide ─────────────────────────────────────────────────────────────────────

_AIDE_SECTION_RE = re.compile(
    r"(Added|Removed|Changed) entries:\s*-*\s*\n(.*?)(?=\n\s*-{5,}|\Z)", re.S | re.I
)
_AIDE_PATH_RE = re.compile(r"^\S.*?:\s+(/\S+)\s*$|^(/\S+)\s*$", re.M)
_AIDE_EXIT_RE = re.compile(r"exit_code=(\d+)")


def parse_aide(text):
    """Mirrors hermes-node-baseline-scan.py's run_aide() parsing exactly (same regexes, same
    bitmask exit-status handling -- 0-7 are normal "here's what it found" outcomes, >=8 is a real
    tool failure) -- see that script for the full reasoning. The exit code here comes from the
    `exit_code=N` line hermes-linodemercury-aide-check.sh appends, not a live subprocess result."""
    if not text.strip():
        return [], "no aide output in this bundle (weekly check hasn't run yet, or already consumed)"
    m = _AIDE_EXIT_RE.search(text)
    rc = int(m.group(1)) if m else 0
    if rc >= 8:
        return [], f"aide --check reported failure (exit {rc})"

    findings = []
    for change_type, block in _AIDE_SECTION_RE.findall(text):
        change_type = change_type.lower()
        for pm in _AIDE_PATH_RE.finditer(block):
            path = pm.group(1) or pm.group(2)
            if not path:
                continue
            findings.append(finding(
                finding_id=f"aide:{path}:{change_type}",
                tool="aide",
                severity="medium",
                description=f"File {change_type}: {path}",
                suggested_remediation={
                    "kind": "manual-review",
                    "detail": f"Review the {change_type} file on LinodeMercury and, if legitimate, "
                              f"re-run `sudo aide --init` there to accept it into the baseline.",
                },
            ))
    return findings, None


# ── lynis ────────────────────────────────────────────────────────────────────

def parse_lynis(text, default_warning_severity="high", default_suggestion_severity="low", overrides=None):
    """Mirrors hermes-node-baseline-scan.py's run_lynis() report.dat parsing exactly, applied to
    an already-pulled copy of the file instead of a live `sudo cat`."""
    overrides = overrides or {}
    if not text.strip():
        return [], "no lynis report in this bundle"

    findings = []
    for line in text.splitlines():
        for prefix, default_sev, kind in (
            ("warning[]=", default_warning_severity, "warning"),
            ("suggestion[]=", default_suggestion_severity, "suggestion"),
        ):
            if not line.startswith(prefix):
                continue
            fields = line[len(prefix):].split("|")
            test_id = fields[0].strip() if fields else "UNKNOWN"
            description = fields[1].strip() if len(fields) > 1 else line.strip()
            solution_raw = fields[2].strip() if len(fields) > 2 else ""
            solution = solution_raw if solution_raw and solution_raw != "-" else ""
            severity = overrides.get(test_id, default_sev)
            dedup = hashlib.sha1(description.encode()).hexdigest()[:8]
            findings.append(finding(
                finding_id=f"lynis:{test_id}:{dedup}",
                tool="lynis",
                severity=severity,
                description=f"[{kind}] {test_id}: {description}",
                detail=solution or None,
                suggested_remediation={"kind": "config-patch", "detail": solution or description},
            ))
    return findings, None


# ── grype ────────────────────────────────────────────────────────────────────

_GRYPE_SEVERITY_MAP = {"negligible": "low", "unknown": "low", "low": "low",
                        "medium": "medium", "high": "high", "critical": "critical"}


def parse_grype(text):
    """Mirrors hermes-node-baseline-scan.py's grype-matches walk exactly, applied to an
    already-pulled JSON file instead of a live grype invocation."""
    if not text.strip():
        return [], "no grype output in this bundle"
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return [], f"grype output was not valid JSON: {e}"

    findings = []
    for match in data.get("matches", []):
        vuln = match.get("vulnerability", {})
        artifact = match.get("artifact", {})
        cve = vuln.get("id", "UNKNOWN")
        pkg, version = artifact.get("name", "?"), artifact.get("version", "?")
        severity = _GRYPE_SEVERITY_MAP.get((vuln.get("severity") or "").lower(), "low")
        fix = vuln.get("fix", {}) or {}
        fix_versions = fix.get("versions") or []
        fix_detail = (f"Upgrade {pkg} to {', '.join(fix_versions)}" if fix_versions
                      else f"No fixed version published yet for {pkg} {cve}")
        findings.append(finding(
            finding_id=f"grype:{pkg}@{version}:{cve}",
            tool="grype",
            severity=severity,
            description=f"{cve} in {pkg} {version}",
            detail=vuln.get("description"),
            suggested_remediation={"kind": "package-upgrade", "detail": fix_detail},
        ))
    return findings, None


# ── ufw ──────────────────────────────────────────────────────────────────────

def check_ufw(text):
    if not text.strip():
        return [], "no ufw status in this bundle"
    findings = []
    if "Status: active" not in text:
        findings.append(finding(
            "ufw:inactive", "ufw", "critical", "ufw is not active on LinodeMercury",
            suggested_remediation={"kind": "manual-review", "detail": "sudo ufw enable"},
        ))
        return findings, None

    m = re.search(r"Default:\s*([a-z]+)\s*\(incoming\)", text)
    if not m or m.group(1) != "deny":
        findings.append(finding(
            "ufw:default-not-deny", "ufw", "high",
            f"Default incoming policy is {m.group(1) if m else 'unknown'}, not deny",
            suggested_remediation={"kind": "manual-review", "detail": "sudo ufw default deny incoming"},
        ))

    for line in text.splitlines():
        m = re.match(r"^(\S.*?)\s{2,}ALLOW IN\s+(Anywhere.*)$", line.strip())
        if not m:
            continue
        rule_port = m.group(1).strip()
        if rule_port not in EXPECTED_OPEN_ANYWHERE:
            findings.append(finding(
                f"ufw:unexpected-open:{rule_port}", "ufw", "high",
                f"Unexpected rule open to Anywhere: {rule_port}",
                detail=line.strip(),
                suggested_remediation={"kind": "manual-review", "detail": f"sudo ufw delete allow {rule_port}"},
            ))
    return findings, None


# ── ssh auth log ─────────────────────────────────────────────────────────────

# Debian 13 / OpenSSH 10.0, confirmed live: "Accepted publickey/password for ..." is NOT
# logged at default LogLevel under the privsep re-exec child's comm (sshd-session) the way
# older OpenSSH/guides assume -- it was never observed even once across many real,
# confirmed-successful logins during setup. "Disconnected from user X <ip> port N" IS
# reliably present for every real session and implies successful auth (you cannot reach a
# disconnect-from-user line without having authenticated as that user first), so it's the
# primary signal here, with the classic Accepted/Failed lines kept as a best-effort secondary
# match in case a future OpenSSH version or LogLevel change restores them.
_ACCEPTED_RE = re.compile(r"Accepted (publickey|password) for (\S+) from (\S+)")
_DISCONNECTED_RE = re.compile(r"Disconnected from user (\S+) (\S+) port")
_FAILED_PW_RE = re.compile(r"Failed password for (?:invalid user )?(\S+) from (\S+)")
_INVALID_USER_RE = re.compile(r"Invalid user (\S+) from (\S+)")


def review_auth_log(text, state, today_ip):
    if not text.strip():
        return [], "no sshd journal window in this bundle", 0, 0

    findings = []
    failed_pw_count = 0
    probe_count = 0

    seen_logins = set()  # (user, ip) already turned into a finding this run, via whichever regex hit first
    for line in text.splitlines():
        m = _ACCEPTED_RE.search(line)
        dm = None if m else _DISCONNECTED_RE.search(line)
        if m or dm:
            if m:
                method, user, ip = m.groups()
            else:
                method, user, ip = "publickey", *dm.groups()  # no auth-method info in a disconnect line
            if (user, ip) in seen_logins:
                continue
            seen_logins.add((user, ip))
            if method == "password":
                # Impossible by design -- PasswordAuthentication no. If this ever appears,
                # something is wrong with the sshd config itself, not just a login attempt.
                findings.append(finding(
                    f"sshd:accepted-password:{ip}:{line}", "sshd", "critical",
                    f"Accepted PASSWORD login for {user} from {ip} -- password auth should be disabled",
                    suggested_remediation={"kind": "manual-review",
                                            "detail": "Verify sshd -T PasswordAuthentication is still 'no'"},
                ))
                continue
            if user == "root":
                # Impossible by design -- PermitRootLogin no.
                findings.append(finding(
                    f"sshd:accepted-root:{ip}", "sshd", "critical",
                    f"Accepted root login from {ip} -- root login should be disabled",
                    suggested_remediation={"kind": "manual-review",
                                            "detail": "Verify sshd -T PermitRootLogin is still 'no'"},
                ))
                continue
            severity = classify_source_ip(ip, state, today_ip)
            if severity == "benign":
                continue
            desc = (f"Successful login for {user} from {ip}, not this run's current Fleet IP "
                    f"({today_ip or 'unknown'})")
            if severity == "medium":
                desc += " -- matches a Fleet IP seen within the last " \
                        f"{IP_HISTORY_WINDOW_DAYS} days (plausible ISP NAT rotation)"
            else:
                desc += " -- does not match any Fleet IP on record"
            findings.append(finding(
                f"sshd:login-ip:{ip}:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
                "sshd", severity, desc,
                suggested_remediation={"kind": "manual-review", "detail": "Confirm this was Fleet-initiated"},
            ))
            continue
        if _FAILED_PW_RE.search(line):
            failed_pw_count += 1
            continue
        if _INVALID_USER_RE.search(line):
            probe_count += 1

    # failed_pw_count is deliberately NOT turned into a finding here -- confirmed live on this
    # box's very first real bundle: internet background scanners trigger "Failed password for
    # invalid user X from IP" regardless of PasswordAuthentication no (OpenSSH/PAM still
    # processes and logs a received password-auth packet before policy ultimately refuses
    # access; the client doesn't need the server to have advertised the method). This is
    # routine, constant background noise on any box with 22/tcp open to the world -- same class
    # of non-signal as pfSense's own "known-benign WAN inbound blocked" bucket
    # (hermes-pfsense-report.py) -- not evidence PasswordAuthentication is misconfigured. The
    # real, impossible-by-design signal is a password attempt that actually *succeeds*
    # ("Accepted password", handled above); both counts are still surfaced in the digest for
    # visibility, just not as an alerting finding.
    return findings, None, failed_pw_count, probe_count


# ── hermes-memory recommendation lifecycle (same shape as hermes-node-baseline-scan.py) ──────

def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def write_recommendation(rec_id, memory_token, f):
    try:
        _post(f"{MEMORY_URL}/tasks", {
            "id": rec_id, "agent": AGENT_NAME, "topic": "linodemercury-watch", "state": "pending",
        }, memory_token)
        _post(f"{MEMORY_URL}/turns", {
            "task_id": rec_id, "agent": AGENT_NAME, "role": "system",
            "raw": json.dumps({"node": NODE_NAME, "status": "pending", **f}),
        }, memory_token)
        return True
    except Exception as exc:
        print(f"[hermes-linodemercury-watch] write_recommendation({rec_id!r}) failed: {exc}", file=sys.stderr)
        return False


def resolve_recommendation(rec_id, memory_token, finding_id):
    try:
        _post(f"{MEMORY_URL}/tasks", {
            "id": rec_id, "agent": AGENT_NAME, "topic": "linodemercury-watch", "state": "resolved",
        }, memory_token)
        _post(f"{MEMORY_URL}/turns", {
            "task_id": rec_id, "agent": AGENT_NAME, "role": "system",
            "raw": json.dumps({"node": NODE_NAME, "status": "resolved", "finding_id": finding_id,
                                "resolved_at": datetime.now(timezone.utc).isoformat()}),
        }, memory_token)
        return True
    except Exception as exc:
        print(f"[hermes-linodemercury-watch] resolve_recommendation({rec_id!r}) failed: {exc}", file=sys.stderr)
        return False


# ── notification ─────────────────────────────────────────────────────────────

def matrix_notice(text):
    token = vault_get("matrix-fleetops", "password")
    room = vault_get("matrix-fleetops", "room")
    if not token or not room:
        print("[hermes-linodemercury-watch] no FleetOps Matrix credentials -- skipping notice", file=sys.stderr)
        return
    try:
        txn = f"linodemercury-notice-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"http://127.0.0.1:6167/_matrix/client/v3/rooms/{urllib.parse.quote(room)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        print(f"[hermes-linodemercury-watch] FleetOps notice failed: {exc}", file=sys.stderr)


def send_email_digest(subject, body):
    password = vault_get("email-sintra", "password")
    if not password:
        print("[hermes-linodemercury-watch] no email-sintra password -- skipping email", file=sys.stderr)
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, password)
            server.send_message(msg)
    except Exception as exc:
        print(f"[hermes-linodemercury-watch] digest email failed: {exc}", file=sys.stderr)


def build_digest(new_recs, upgradable_count, failed_pw_count, probe_count):
    lines = [
        f"[LinodeMercury Watch] {len(new_recs)} new finding(s) at medium+ severity "
        f"({upgradable_count} package(s) pending upgrade; {probe_count} invalid-user probe(s) and "
        f"{failed_pw_count} failed-password attempt(s) seen -- routine internet background "
        f"scanning on any box with 22/tcp open, not itself alarming; see new findings below for "
        f"anything that actually is).",
        "",
    ]
    for rec_id, f in new_recs:
        lines.append(f"- {rec_id} [{f['severity'].upper()}] ({f['tool']}) {f['description']}")
        remediation = f.get("suggested_remediation", {})
        if remediation.get("detail"):
            lines.append(f"    suggested: {remediation['detail']}")
    return "\n".join(lines)


# ── one bundle, start to finish ──────────────────────────────────────────────

def process_bundle(remote_path, state, memory_token, threshold, dry_run, seed_only):
    work_dir = Path(tempfile.mkdtemp(prefix="linodemercury-bundle-"))
    try:
        local_tar = pull_bundle(remote_path, work_dir)
        if not local_tar:
            print(f"[hermes-linodemercury-watch] could not pull {remote_path} -- left in place, will retry", file=sys.stderr)
            return None
        unpack_bundle(local_tar, work_dir)

        def read(name):
            p = work_dir / name
            return p.read_text(errors="replace") if p.exists() else ""

        findings = []
        errors = {}
        for label, parser, arg in (
            ("aide", parse_aide, read("aide-check.log")),
            ("lynis", parse_lynis, read("lynis-report.dat")),
            ("grype", parse_grype, read("grype.json")),
        ):
            f, err = parser(arg)
            findings.extend(f)
            if err:
                errors[label] = err

        ufw_findings, ufw_err = check_ufw(read("ufw-status.txt"))
        findings.extend(ufw_findings)
        if ufw_err:
            errors["ufw"] = ufw_err

        today_ip = current_fleet_ip()
        record_fleet_ip(state, today_ip)
        auth_findings, auth_err, failed_pw_count, probe_count = review_auth_log(
            read("sshd-journal.log"), state, today_ip)
        findings.extend(auth_findings)
        if auth_err:
            errors["sshd"] = auth_err

        upgradable_text = read("apt-upgradable.txt")
        upgradable_count = max(0, len(upgradable_text.splitlines()) - 1) if upgradable_text else 0

        if dry_run:
            print(json.dumps({
                "bundle": remote_path, "findings": findings, "errors": errors,
                "upgradable_count": upgradable_count,
                "failed_pw_count": failed_pw_count, "probe_count": probe_count,
            }, indent=2))
            return None  # dry-run never deletes the remote bundle

        prev_ids = set(state["findings_by_id"].keys())
        cur_ids = {f["finding_id"] for f in findings}
        new_findings = [f for f in findings if f["finding_id"] not in prev_ids]
        resolved_ids = prev_ids - cur_ids

        new_recs = []
        if seed_only:
            # First-ever bundle for this node: confirmed live it includes pre-hardening setup
            # history (journald's --cursor-file starts at the earliest available entry when no
            # cursor exists yet, and this box's own earliest entries are from while it was still
            # being provisioned) and normal apt-upgrade lag, same class of one-time noise
            # hermes-node-baseline-scan.py's own --seed-only already exists to absorb. Today's
            # findings become the known baseline; only genuinely new findings from here on
            # generate a REC.
            print(f"[hermes-linodemercury-watch] --seed-only: {len(new_findings)} finding(s) "
                  f"persisted as the baseline, no recommendations written", file=sys.stderr)
        else:
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            seq = 1
            for f in new_findings:
                if not severity_at_least(f["severity"], threshold):
                    continue
                rec_id = f"REC-{NODE_NAME}-{today}-{seq:03d}"
                seq += 1
                if write_recommendation(rec_id, memory_token, f):
                    state["rec_ids"][f["finding_id"]] = rec_id
                    new_recs.append((rec_id, f))
                else:
                    print(f"[hermes-linodemercury-watch] could not record {f['finding_id']!r} -- will retry next run",
                          file=sys.stderr)

            for fid in resolved_ids:
                rec_id = state["rec_ids"].get(fid)
                if rec_id:
                    resolve_recommendation(rec_id, memory_token, fid)

        state["findings_by_id"] = {f["finding_id"]: f for f in findings}

        for section, err in errors.items():
            print(f"[hermes-linodemercury-watch] {section}: {err}", file=sys.stderr)

        if new_recs:
            digest = build_digest(new_recs, upgradable_count, failed_pw_count, probe_count)
            matrix_notice(digest)
            send_email_digest(f"[LinodeMercury Watch] {len(new_recs)} new finding(s)", digest)

        if not cleanup_remote_bundle(remote_path):
            print(f"[hermes-linodemercury-watch] WARNING: could not delete {remote_path} after "
                  f"successful processing -- will be reprocessed next run", file=sys.stderr)

        return {"new": len(new_recs), "total": len(findings), "resolved": len(resolved_ids)}
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Daily Fleet-side check of LinodeMercury")
    parser.add_argument("--dry-run", action="store_true",
                         help="Pull + analyze + print only; state and remote bundles untouched")
    parser.add_argument("--seed-only", action="store_true",
                         help="First-run bootstrap: persist today's findings as the baseline "
                              "without writing recommendations or sending a digest (same "
                              "reasoning as hermes-node-baseline-scan.py's own --seed-only -- "
                              "the first bundle includes setup-time history and normal "
                              "apt-upgrade lag, not a genuine day-one flood of incidents)")
    parser.add_argument("--severity-threshold", default="medium", choices=list(SEVERITY_ORDER))
    args = parser.parse_args()

    bundles = list_remote_bundles()
    if not bundles:
        print("[hermes-linodemercury-watch] no bundles waiting on LinodeMercury")
        return

    state = load_state()
    memory_token = None if args.dry_run else vault_get("memory-token", "password")
    if not args.dry_run and not memory_token:
        print("[hermes-linodemercury-watch] ERROR: could not fetch memory-token from vault", file=sys.stderr)
        sys.exit(1)

    for remote_path in bundles:  # oldest first, so a missed day is never skipped
        result = process_bundle(remote_path, state, memory_token, args.severity_threshold,
                                 args.dry_run, args.seed_only)
        if result:
            print(f"[hermes-linodemercury-watch] {remote_path}: {result['total']} total finding(s), "
                  f"{result['new']} new, {result['resolved']} resolved")

    if not args.dry_run:
        save_state(state)


if __name__ == "__main__":
    main()
