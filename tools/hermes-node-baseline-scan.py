#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-node-baseline-scan.py — daily local-node security baseline: file-integrity (aide),
hardening audit (lynis), and SBOM+CVE (syft/grype), normalized into a stable finding schema,
diffed against yesterday's snapshot, and (for new medium+ findings) written into hermes-memory
as a durable, queryable recommendation — S17 of IMPLEMENTATION_PLAN.md.

This is deliberately the FIRST slice of S17 only: scan + normalize + diff + persist + write
recommendations into hermes-memory + one daily digest (Matrix + email). It does NOT implement
authorization or routing to hermes-remediate-worker/hermes-dualcoder — that is
hermes-baseline-authorize-watch.py, a separate long-running service, built and reviewed
separately per S17's own build order (a routing bug is the one part of this system that can
actually change a node, and it's staged last on purpose).

Design points carried over from the approved S17 plan:
  - Finding identity is structured, not free text (grype:{pkg}@{version}:{CVE},
    lynis:{test-id}, aide:{path}:{change-type}) so the diff survives wording drift between runs.
  - Recommendation storage reuses hermes-memory's existing tasks/turns tables (same
    set_task_state/log_round shape tools/hermes-dualcoder.py already uses) — no new database.
    History for any REC is `GET {MEMORY_URL}/turns?task_id=REC-...`, same query dualcoder
    already relies on for its own transcript.
  - Only NEW findings at/above `severity_threshold` (config, default "medium") generate a
    recommendation + notification; lower severity is recorded in the snapshot but silent —
    keeps the daily digest and future authorize queue focused (direct operator decision,
    2026-09-05, given lynis alone routinely produces dozens of low-value suggestions per run).
  - A finding that disappears between runs auto-resolves its REC (if one exists) with no human
    action needed — only new findings need a human's attention at all.
  - Every individual check degrades to "unknown"/skipped instead of crashing or fabricating a
    result, same discipline as tools/hermes-node-health.py.

Caveat, stated plainly rather than assumed away (same discipline
tools/hermes-code-security-scan.py's own header uses for bandit/ruff/detect-secrets flags):
the exact aide report format, lynis report.dat field layout, and syft/grype CLI subcommand
names below reflect each tool's well-known, documented shape as of this writing. Verify each
against the actually-installed version (`--help`, and one real by-hand run) before trusting the
parser on a live node — this is explicitly build-order step 1 in the S17 plan, not skippable.

Config (per node, NOT committed to git — same convention as $HERMES_HOME/config/node-health.json):
  $HERMES_HOME/config/node-baseline.json
  See infra/hermes-node-baseline/config/*.json.template for the shape to copy into place.

State (written each run):
  $HERMES_HOME/state/node-baseline/latest.json       — current findings + finding_id -> REC id map
  $HERMES_HOME/state/node-baseline/YYYY-MM-DD.json    — dated snapshot, pruned per retention_days

Env (injected by hermes-node-baseline-scan-wrapper.sh, same pattern as hermes-remediate-worker.py):
  MEMORY_URL / MEMORY_TOKEN         hermes-memory service, for recommendation tasks/turns
  MATRIX_HOMESERVER                 default http://127.0.0.1:6167
  FLEETOPS_MATRIX_TOKEN / FLEETOPS_ROOM   for the daily digest notice
  EMAIL_FROM / EMAIL_PASSWORD / NOTIFY_EMAIL   for the daily digest email (mail.hover.com:587)

Usage:
  python3 hermes-node-baseline-scan.py                  # full run: scan, diff, persist, notify
  python3 hermes-node-baseline-scan.py --dry-run         # scan + normalize + print JSON only
  python3 hermes-node-baseline-scan.py --no-notify       # scan/diff/persist/write recs, skip digest
  python3 hermes-node-baseline-scan.py --section aide lynis
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import smtplib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
CONFIG_PATH = HERMES_HOME / "config" / "node-baseline.json"
STATE_DIR = HERMES_HOME / "state" / "node-baseline"
LATEST_PATH = STATE_DIR / "latest.json"
LOG_PATH = HERMES_HOME / "logs" / "node-baseline-scan.log"

SECTION_NAMES = ["aide", "lynis", "syft_grype"]
SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}

DEFAULT_CONFIG = {
    "node_name": None,
    "retention_days": 30,
    "severity_threshold": "medium",
    "aide": {"enabled": False, "config_path": "/etc/aide/aide.conf", "check_timeout_seconds": 7200},
    "lynis": {
        "enabled": False,
        "report_path": "/var/log/lynis-report.dat",
        "default_warning_severity": "high",
        "default_suggestion_severity": "low",
        "severity_overrides": {},
    },
    "syft_grype": {
        "enabled": False,
        # Each target: {"name": "...", "source": "<syft source string>", "kind": "os-packages"|"venv"}
        # e.g. {"name": "dpkg", "source": "dir:/var/lib/dpkg", "kind": "os-packages"} -- syft's
        #      directory cataloger auto-detects the dpkg status file inside; there is no
        #      separate "dpkg-db:" scheme in syft 1.x, confirmed live 2026-09-05 (it doesn't
        #      exist -- "dir:" against the same path is correct and was verified end-to-end).
        #      {"name": "codesec-venv", "source": "dir:/opt/hermes/venvs/codesec", "kind": "venv"}
        "targets": [],
    },
}

MEMORY_URL = os.environ.get("MEMORY_URL", "http://10.129.1.15:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")

EMAIL_FROM = os.environ.get("EMAIL_FROM", "mercury@canislupisnc.net")
EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")
NOTIFY_EMAIL = os.environ.get("NOTIFY_EMAIL", "notifications@canislupisnc.net")

AGENT_NAME = "node-baseline"


def log(msg):
    # stderr, not stdout: --dry-run's only stdout output is one final json.dumps(), and a log
    # line ahead of it would otherwise corrupt that for any caller piping stdout to a JSON
    # parser -- found live 2026-09-05 testing this exact thing on spark.
    line = f"[hermes-node-baseline-scan] {msg}"
    print(line, file=sys.stderr, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(f"{datetime.now(timezone.utc).isoformat()}  {msg}\n")
    except Exception:
        pass  # logging must never be why a scan fails


def run(cmd, timeout=60, shell=False):
    """Argv list preferred, never crashes. Returns (stdout, returncode, stderr) as three
    separate values -- NOT merged into one string. Found live 2026-09-05, in two steps:
    hermes-node-health.py's own run() shape (stdout+rc only) silently discarded a real syft
    error that went to stderr, so a first fix merged stderr into the returned "stdout" string
    (same convention hermes-security-scan.py's run_nmap() uses) -- which then broke grype's own
    successful JSON output the very next test, because grype logs a WARN line to stderr even on
    a clean run, and the merged text was no longer valid JSON for json.loads() to parse. Callers
    that parse stdout as structured data (grype) need it untouched; callers building a
    human-readable error message can reference `stderr` explicitly instead."""
    try:
        r = subprocess.run(cmd, shell=shell, capture_output=True, text=True, timeout=timeout)
        return r.stdout, r.returncode, r.stderr
    except FileNotFoundError:
        return "", 127, "command not found"
    except subprocess.TimeoutExpired:
        return "", -1, "timed out"
    except Exception as e:
        return "", -1, str(e)


def which(name):
    return shutil.which(name) is not None


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy, DEFAULT_CONFIG has nested dicts
    if CONFIG_PATH.exists():
        try:
            user_cfg = json.loads(CONFIG_PATH.read_text())
            for k, v in user_cfg.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except Exception as e:
            log(f"WARNING: could not parse {CONFIG_PATH}: {e}")
    return cfg


def finding(finding_id, tool, severity, description, detail=None, suggested_remediation=None):
    return {
        "finding_id": finding_id,
        "tool": tool,
        "severity": severity if severity in SEVERITY_ORDER else "low",
        "description": description,
        "detail": detail,
        "suggested_remediation": suggested_remediation or {"kind": "manual-review", "detail": ""},
    }


# ── aide: file-integrity ────────────────────────────────────────────────────

_AIDE_SECTION_RE = re.compile(
    r"(Added|Removed|Changed) entries:\s*-*\s*\n(.*?)(?=\n\s*-{5,}|\Z)", re.S | re.I
)
_AIDE_PATH_RE = re.compile(r"^\S.*?:\s+(/\S+)\s*$|^(/\S+)\s*$", re.M)


def run_aide(cfg):
    """Parses `sudo aide --check` output. Needs a passwordless sudo entry scoped to exactly
    this command (see infra/hermes-node-baseline/README.md) — same precedent as the existing
    `sudo nmap` entry tools/hermes-security-scan.py already depends on.

    AIDE's default text report groups changes under "Added/Removed/Changed entries:" headers
    followed by path lines. Exact formatting (leading flags like f++++++++++++++++:) varies by
    aide version/config — the two alternatives in _AIDE_PATH_RE cover "flags: /path" and a bare
    "/path" line; verify against a real run before trusting this on a node with a non-default
    aide.conf report format.

    check_timeout_seconds defaults to 7200 (2h), not a short default -- found live 2026-09-05:
    HomeD13's real `aide --init` (381,891 entries) took 43m12s wall-clock, and a `--check` pass
    does comparably full-database work. The original 600s (10 min) timeout was nowhere close and
    silently turned every real run into a timeout error, never actually reporting a single aide
    finding. Tune per-node in node-baseline.json if `aide --init`'s own reported run time (see
    its output) suggests this node needs more or would be fine with less."""
    if not cfg.get("enabled"):
        return [], "disabled in config"
    if not which("aide"):
        return [], "aide not installed"

    out, rc, err = run(["sudo", "-n", "aide", "--check", "--config", cfg.get("config_path", "/etc/aide/aide.conf")],
                        timeout=cfg.get("check_timeout_seconds", 7200))
    if rc not in (0, 1):  # aide exits 1 when it finds differences -- that's the normal "findings" case
        return [], f"aide --check failed (exit {rc}): {err.strip()[:300] or '(no stderr)'}"

    findings = []
    for change_type, block in _AIDE_SECTION_RE.findall(out):
        change_type = change_type.lower()
        for m in _AIDE_PATH_RE.finditer(block):
            path = m.group(1) or m.group(2)
            if not path:
                continue
            findings.append(finding(
                finding_id=f"aide:{path}:{change_type}",
                tool="aide",
                severity="medium",
                description=f"File {change_type}: {path}",
                suggested_remediation={
                    "kind": "manual-review",
                    "detail": f"Review the {change_type} file and, if legitimate, re-run "
                               f"`sudo aide --update` to accept it into the baseline.",
                },
            ))
    return findings, None


# ── lynis: hardening audit ──────────────────────────────────────────────────

def run_lynis(cfg):
    """Runs `lynis audit system` (needs root for most real checks — same narrowly-scoped
    sudoers entry as aide above) and parses its machine-readable report.dat
    (`warning[]=<test-id>|<description>|<solution>`, `suggestion[]=` same shape). Field count
    per line has varied across lynis versions in the past — verify with `lynis show version`
    and one real report.dat before trusting this parse on a node running an unfamiliar version."""
    if not cfg.get("enabled"):
        return [], "disabled in config"
    if not which("lynis"):
        return [], "lynis not installed"

    report_path = Path(cfg.get("report_path", "/var/log/lynis-report.dat"))
    _, rc, err = run(["sudo", "-n", "lynis", "audit", "system", "--quiet", "--no-colors"], timeout=900)
    if rc != 0:
        return [], f"lynis audit system failed (exit {rc}): {err.strip()[:300] or '(no stderr)'}"

    overrides = cfg.get("severity_overrides", {})
    warn_sev = cfg.get("default_warning_severity", "high")
    sugg_sev = cfg.get("default_suggestion_severity", "low")

    # Read via `sudo cat`, not Path.read_text() -- found live 2026-09-05: lynis writes its own
    # report 0640 root:root, so the unprivileged user running this scanner (which only sudo'd
    # the `lynis audit system` invocation itself, not the read) got a plain PermissionError here
    # even though the audit above had just succeeded as root moments earlier.
    report_text, cat_rc, cat_err = run(["sudo", "-n", "cat", str(report_path)])
    if cat_rc != 0:
        return [], f"could not read {report_path} (exit {cat_rc}): {cat_err.strip()[:300] or '(no stderr)'}"

    findings = []
    lines = report_text.splitlines()

    for line in lines:
        for prefix, default_sev, kind in (("warning[]=", warn_sev, "warning"), ("suggestion[]=", sugg_sev, "suggestion")):
            if not line.startswith(prefix):
                continue
            fields = line[len(prefix):].split("|")
            test_id = fields[0].strip() if fields else "UNKNOWN"
            description = fields[1].strip() if len(fields) > 1 else line.strip()
            # lynis writes a literal "-" for an empty solution field, confirmed live 2026-09-05
            # (most suggestions have no separate solution text -- description is already the
            # actionable text, e.g. "Install libpam-tmpdir..."), not an empty string.
            solution_raw = fields[2].strip() if len(fields) > 2 else ""
            solution = solution_raw if solution_raw and solution_raw != "-" else ""
            severity = overrides.get(test_id, default_sev)
            # A single test_id can legitimately fire more than once with different findings --
            # confirmed live 2026-09-05, real report.dat: AUTH-9286 appears twice, once for
            # minimum and once for maximum password age, two genuinely distinct issues. Keying
            # finding_id on test_id alone would silently collapse them into one, permanently
            # losing whichever fired second in findings_by_id. A short hash of the description
            # disambiguates while staying stable day-to-day for the same underlying condition.
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


# ── syft + grype: SBOM and known-CVE scan ───────────────────────────────────

_GRYPE_SEVERITY_MAP = {"negligible": "low", "unknown": "low", "low": "low",
                        "medium": "medium", "high": "high", "critical": "critical"}


def _detect_os_distro():
    """Reads ID and VERSION_ID from /etc/os-release, e.g. ("ubuntu", "24.04"). Needed because
    grype cannot infer the OS distro from a bare `dir:` source the way it can from a real
    container image -- found live 2026-09-05: scanning `dir:/var/lib/dpkg` with no --distro
    override matched ZERO OS-package vulnerabilities (grype's own stderr WARN said exactly why:
    "Unable to determine the OS distribution of some packages"), vs. 2,782 real matches on the
    identical SBOM once `--distro ubuntu:24.04` was supplied by hand. This is not an edge case --
    it silently zeroed out the OS-package half of every scan until caught."""
    try:
        info = {}
        for line in Path("/etc/os-release").read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                info[k] = v.strip().strip('"')
        if info.get("ID") and info.get("VERSION_ID"):
            return f"{info['ID']}:{info['VERSION_ID']}"
    except Exception:
        pass
    return None


def _syft_grype_one_target(target, timeout=600):
    """One syft(source) -> grype(sbom) pass for a single configured target. `target["source"]`
    is a syft source string (e.g. "dir:/var/lib/dpkg", "dir:/opt/hermes/venvs/codesec") —
    deliberately scoped (a package-DB or one directory), never a bare "dir:/" full-filesystem
    walk, so this stays cheap enough to run daily. Verify the exact source-string syntax against
    the installed syft version (`syft --help` / `syft source --help`) before relying on it.

    grype runs with `--only-fixed`: a vulnerability with no released fix has no "package-upgrade"
    remediation to suggest in the first place (nothing to upgrade to yet), so surfacing one as a
    recommendation demanding action is actively unhelpful, not just noisy -- confirmed live
    2026-09-05, spark: --only-fixed cut 51,009 raw medium+ matches (mostly real but currently
    un-fixable Ubuntu package CVEs) down to 2,644 genuinely actionable ones on the very same SBOM.
    If a fix is published later, that finding naturally reappears as "new" on the day it does,
    which is exactly the right day to be told about it."""
    name, source = target.get("name", "?"), target.get("source")
    if not source:
        return [], f"target {name!r} has no 'source' configured"

    with tempfile.NamedTemporaryFile(suffix=".json", prefix=f"sbom-{name}-", delete=False) as f:
        sbom_path = f.name
    try:
        out, rc, err = run(["syft", source, "-o", f"json={sbom_path}"], timeout=timeout)
        if rc != 0 or not Path(sbom_path).exists() or Path(sbom_path).stat().st_size == 0:
            diag = (err.strip() or out.strip())[-300:] or "(no output)"
            return [], f"syft failed for target {name!r} (exit {rc}): {diag}"

        grype_cmd = ["grype", f"sbom:{sbom_path}", "-o", "json", "--only-fixed"]
        if target.get("kind") == "os-packages":
            distro = _detect_os_distro()
            if distro:
                grype_cmd += ["--distro", distro]
            else:
                log(f"could not detect this node's distro from /etc/os-release — "
                    f"grype's OS-package matching for target {name!r} may under-report")
        gout, grc, gerr = run(grype_cmd, timeout=timeout)
        if grc not in (0, 1):  # grype exits 1 when vulnerabilities are found above its own threshold
            return [], f"grype failed for target {name!r} (exit {grc}): {gerr.strip()[:300] or '(no stderr)'}"
        try:
            data = json.loads(gout)
        except json.JSONDecodeError as e:
            return [], f"grype output for target {name!r} was not valid JSON: {e}"

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
                description=f"{cve} in {pkg} {version} (target: {name})",
                detail=vuln.get("description"),
                suggested_remediation={"kind": "package-upgrade", "detail": fix_detail},
            ))
        return findings, None
    finally:
        Path(sbom_path).unlink(missing_ok=True)


def run_syft_grype(cfg):
    if not cfg.get("enabled"):
        return [], "disabled in config"
    if not which("syft") or not which("grype"):
        return [], "syft and/or grype not installed"
    targets = cfg.get("targets", [])
    if not targets:
        return [], "no targets configured"

    all_findings, errors = [], []
    for target in targets:
        findings, err = _syft_grype_one_target(target)
        all_findings.extend(findings)
        if err:
            errors.append(f"{target.get('name', '?')}: {err}")
    return all_findings, ("; ".join(errors) if errors else None)


# ── scan orchestration ───────────────────────────────────────────────────────

def run_scan(cfg, sections_wanted):
    all_findings = []
    errors = {}
    if "aide" in sections_wanted:
        f, err = run_aide(cfg.get("aide", {}))
        all_findings.extend(f)
        if err:
            errors["aide"] = err
    if "lynis" in sections_wanted:
        f, err = run_lynis(cfg.get("lynis", {}))
        all_findings.extend(f)
        if err:
            errors["lynis"] = err
    if "syft_grype" in sections_wanted:
        f, err = run_syft_grype(cfg.get("syft_grype", {}))
        all_findings.extend(f)
        if err:
            errors["syft_grype"] = err
    return all_findings, errors


# ── snapshot persistence + diff ──────────────────────────────────────────────

def load_latest_snapshot():
    try:
        return json.loads(LATEST_PATH.read_text())
    except Exception:
        return None


def persist_snapshot(snapshot, retention_days):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LATEST_PATH.write_text(json.dumps(snapshot, indent=2))
    dated_path = STATE_DIR / f"{snapshot['date']}.json"
    dated_path.write_text(json.dumps(snapshot, indent=2))

    cutoff = time.time() - retention_days * 86400
    for p in STATE_DIR.glob("????-??-??.json"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except Exception:
            continue


def diff_findings(previous, current_findings):
    """Returns (new_findings, resolved_finding_ids, persisting_ids). `previous` is the prior
    snapshot dict (or None on first run) with a 'findings' list and 'rec_ids' map
    (finding_id -> REC id)."""
    prev_ids = set((previous or {}).get("findings_by_id", {}).keys())
    cur_ids = {f["finding_id"] for f in current_findings}
    new_findings = [f for f in current_findings if f["finding_id"] not in prev_ids]
    resolved_ids = prev_ids - cur_ids
    persisting_ids = prev_ids & cur_ids
    return new_findings, resolved_ids, persisting_ids


# ── hermes-memory: recommendation records ───────────────────────────────────

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


def write_recommendation(rec_id, node_name, f):
    """One hermes-memory task (topic 'node-baseline', state 'pending') plus one turn holding
    the full finding detail as JSON -- same set_task_state/log_round shape
    tools/hermes-dualcoder.py already uses, so GET /turns?task_id=REC-... gives the full,
    independently-auditable history for free, no new endpoint needed."""
    try:
        _post(f"{MEMORY_URL}/tasks", {
            "id": rec_id, "agent": AGENT_NAME, "topic": "node-baseline", "state": "pending",
        }, MEMORY_TOKEN)
        _post(f"{MEMORY_URL}/turns", {
            "task_id": rec_id, "agent": AGENT_NAME, "role": "system",
            "raw": json.dumps({"node": node_name, "status": "pending", **f}),
        }, MEMORY_TOKEN)
        return True
    except Exception as exc:
        log(f"write_recommendation({rec_id!r}) failed: {exc}")
        return False


def resolve_recommendation(rec_id, node_name, finding_id):
    try:
        _post(f"{MEMORY_URL}/tasks", {
            "id": rec_id, "agent": AGENT_NAME, "topic": "node-baseline", "state": "resolved",
        }, MEMORY_TOKEN)
        _post(f"{MEMORY_URL}/turns", {
            "task_id": rec_id, "agent": AGENT_NAME, "role": "system",
            "raw": json.dumps({"node": node_name, "status": "resolved", "finding_id": finding_id,
                                "resolved_at": datetime.now(timezone.utc).isoformat()}),
        }, MEMORY_TOKEN)
        return True
    except Exception as exc:
        log(f"resolve_recommendation({rec_id!r}) failed: {exc}")
        return False


def severity_at_least(severity, threshold):
    return SEVERITY_ORDER.get(severity, 0) >= SEVERITY_ORDER.get(threshold, 1)


# ── notification ─────────────────────────────────────────────────────────────

def matrix_notice(text):
    """Verbatim reuse of tools/hermes-remediate-worker.py's matrix_notice() shape -- same
    FleetOps posting convention, not reimplemented differently here."""
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        log(f"no FleetOps credentials — cannot post notice: {text}")
        return
    try:
        txn = f"baseline-notice-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"FleetOps notice failed: {exc}")


def send_email_digest(subject, body):
    if not EMAIL_PASSWORD:
        log("no EMAIL_PASSWORD — cannot send digest email")
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = EMAIL_FROM
    msg["To"] = NOTIFY_EMAIL
    try:
        with smtplib.SMTP("mail.hover.com", 587, timeout=20) as server:
            server.starttls()
            server.login(EMAIL_FROM, EMAIL_PASSWORD)
            server.send_message(msg)
    except Exception as exc:
        log(f"digest email failed: {exc}")


def build_digest(node_name, new_recs):
    lines = [f"[hermes-node-baseline] {node_name}: {len(new_recs)} new finding(s) at "
             f"medium+ severity — reply in FleetOps with `authorize <REC-id>` to act on one.", ""]
    for rec_id, f in new_recs:
        lines.append(f"- {rec_id} [{f['severity'].upper()}] ({f['tool']}) {f['description']}")
        remediation = f.get("suggested_remediation", {})
        if remediation.get("detail"):
            lines.append(f"    suggested: {remediation['detail']}")
    return "\n".join(lines)


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Hermes daily node security baseline scan")
    parser.add_argument("--dry-run", action="store_true", help="Scan + normalize + print JSON, no persist/notify/recs")
    parser.add_argument("--no-notify", action="store_true", help="Persist and write recommendations, skip the digest")
    parser.add_argument("--seed-only", action="store_true",
                         help="First-run bootstrap for a node with real pre-existing findings "
                              "(e.g. normal apt-upgrade lag): persist today's findings as the "
                              "baseline WITHOUT writing any recommendation or sending any "
                              "digest. Every finding is treated as already-known starting "
                              "tomorrow's run -- only genuinely new findings from here on "
                              "generate a REC. Direct operator decision, 2026-09-05: an "
                              "un-seeded first run on a real node can be thousands of medium+ "
                              "findings, which is normal backlog, not something worth thousands "
                              "of one-time recommendation records and a flooded first digest.")
    parser.add_argument("--section", nargs="+", choices=SECTION_NAMES, help="Only run these sections")
    parser.add_argument("--config", help="Override config file path")
    args = parser.parse_args()

    global CONFIG_PATH
    if args.config:
        CONFIG_PATH = Path(args.config)

    cfg = load_config()
    node_name = cfg.get("node_name") or socket.gethostname()
    sections_wanted = args.section or SECTION_NAMES

    findings, errors = run_scan(cfg, sections_wanted)
    for section, err in errors.items():
        log(f"{section}: {err}")

    if args.dry_run:
        print(json.dumps({"node": node_name, "findings": findings, "errors": errors}, indent=2))
        return

    previous = load_latest_snapshot()
    new_findings, resolved_ids, persisting_ids = diff_findings(previous, findings)
    threshold = cfg.get("severity_threshold", "medium")

    prev_rec_ids = (previous or {}).get("rec_ids", {})
    rec_ids = {fid: prev_rec_ids[fid] for fid in persisting_ids if fid in prev_rec_ids}

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    new_recs = []
    if args.seed_only:
        log(f"{node_name}: --seed-only, skipping recommendation-writing for "
            f"{len(new_findings)} finding(s) -- treated as the baseline as of today")
    else:
        seq = 1
        for f in new_findings:
            if not severity_at_least(f["severity"], threshold):
                continue
            rec_id = f"REC-{node_name}-{today}-{seq:03d}"
            seq += 1
            if write_recommendation(rec_id, node_name, f):
                rec_ids[f["finding_id"]] = rec_id
                new_recs.append((rec_id, f))
            else:
                log(f"could not record recommendation for finding {f['finding_id']!r} — will retry next run")

        for fid in resolved_ids:
            rec_id = prev_rec_ids.get(fid)
            if rec_id:
                resolve_recommendation(rec_id, node_name, fid)

    snapshot = {
        "node": node_name,
        "date": today,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "findings_by_id": {f["finding_id"]: f for f in findings},
        "rec_ids": rec_ids,
        "errors": errors,
    }
    persist_snapshot(snapshot, cfg.get("retention_days", 30))

    log(f"{node_name}: {len(findings)} total finding(s), {len(new_findings)} new, "
        f"{len(resolved_ids)} resolved, {len(new_recs)} recommendation(s) at {threshold}+ severity")

    if new_recs and not args.no_notify:
        digest = build_digest(node_name, new_recs)
        matrix_notice(digest)
        send_email_digest(f"[Hermes Baseline] {node_name}: {len(new_recs)} new finding(s)", digest)


if __name__ == "__main__":
    main()
