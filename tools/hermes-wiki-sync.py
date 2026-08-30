#!/usr/bin/env python3
# Version: 1.3.1
#
# 1.3.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
"""
1.3.0 — HermesAgentV5 S13: STOPPED, not fixed in place. This script's entire data model is
per-persona (Sintra/Configuration, Amy/Configuration, a GATEWAY_SERVICE/PERSONA_PAGE map, a
ROUTER_MODELS table that describes "nano" as Sintra's core and "omni" as Amy's) — both personas
have been retired since S8, so every scheduled run since then has been auto-publishing live status
to two personas' wiki pages that no longer exist in any operational sense, and appending changelog
entries in their voice. Patching ROUTER_MODELS' descriptions alone would leave the deeper problem
(there is no "Sintra's page" to publish to anymore) untouched. What the V5-era wiki page structure
should actually look like — one fleet-wide page, something else — is a real design decision nobody
has made, not something to invent unrequested inside a currency-fix pass. `hermes-wiki-sync.timer`
is stopped and disabled (IMPLEMENTATION_PLAN.md S13) rather than left running against a data model
three generations out of date. Re-enable once a real V5 page design exists.

1.2.0 — follow-up security-review fix: vault_get()'s retry loop now catches
subprocess.TimeoutExpired on each attempt instead of only guarding against a
non-exceptional failure — a *complete* Vaultwarden outage (both attempts
hitting the full 60s timeout) previously still crashed this script uncaught.

1.1.0 — two fixes from a security review: vault_get() now retries once at
timeout=60, same pattern as tools/hermes_game_backup_common.py (a single
timeout=30 attempt could fail on a transient Vaultwarden hiccup a second
attempt would have recovered from); main() no longer writes STATE_PATH
unconditionally after a failed changelog write — it used to advance state
regardless of whether prepend_changelog_entry() actually succeeded, so a
failed write wasn't just unreported, the diff that should have produced it
was permanently and silently lost on the next run's comparison.

Publish live fleet status to each persona's wiki Configuration page, and
auto-append a dated entry to each persona's Changelog when something
structural actually changes since the last run. Deterministic — no LLM
involved (IMPLEMENTATION_PLAN.md Phase 11: "changelog maintenance as a real
tool with a code-level output check" — v1 needed four rounds and a
code-level wikitext validator before an LLM reliably produced valid
wikitext for this kind of structured status table; for facts pulled
straight from systemctl/curl, templating them directly is strictly more
reliable and has zero inference cost).

Ported and restructured from v1 (scripts/spark-wiki-status.py), which
assumed one persona per node (Spark-Sintra, HomeD13-Smith). That's no
longer true here — Sintra and Amy both run on the Spark, and HomeD13 has
no persona living on it at all (render-worker only, migration Stage 3).
Pages are per-persona now, not per-node: Sintra/Configuration and
Amy/Configuration, both describing the same shared Spark host plus
whatever's persona-specific (Amy's render pipeline reaches HomeD13 through
the broker; Sintra's does too, as of Stage 4's addendum, but Amy's is her
defining capability).

Static personality/soul content (the Sintra and Amy top-level pages, and
the Main Page) is NOT touched by this script — hand-written, reviewed, and
published separately, same as v1's precedent. This script only owns the
*/Configuration and */Changelog subpages.

Usage:
  python3 hermes-wiki-sync.py            # publish + log changes, both personas
  python3 hermes-wiki-sync.py --dry-run  # print wikitext, don't publish or log
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

REPO_DIR = Path(os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5")))
MEDIAWIKI_SCRIPT = REPO_DIR / "tools" / "mediawiki.py"
VAULT_SCRIPT = REPO_DIR / "tools" / "vault-get-secret.sh"
STATE_PATH = Path.home() / ".hermes" / "wiki-sync-state.json"

# V4: capability endpoints, not persona-pinned nodes (IMPLEMENTATION_PLAN.md §2c) — every role
# is reachable by either persona's own local router regardless of which node actually hosts it.
# Ports shown are each role's real backend port on its home node (spark for nano/super,
# spark-2 for coder/muse/omni), not a single shared numbering.
ROUTER_MODELS = [
    ("nano", 8088, "Sintra's always-resident fast core (spark). Default "
     "decision-making and orchestration; also reachable by Amy via "
     "hermes-model-call.sh nano."),
    ("super", 8095, "Deep-reasoning/planning escalation, loaded on demand (spark) — "
     "reached via hermes-model-call.sh super. Expect the first call after idle to "
     "take noticeably longer while it wakes."),
    ("coder", 8093, "Coding delegation target (spark-2), reached via "
     "hermes-model-call.sh coder. Logic implementation, system integration, "
     "functional verification."),
    ("muse", 8090, "Creative-writing delegation target (spark-2), reached via "
     "hermes-model-call.sh muse. Uncensored prose/fiction generation, "
     "narrative and dialogue work."),
    ("omni", 8091, "Amy's always-resident fast core and vision/audio backend "
     "(spark-2). Image/video *understanding* — distinct from image "
     "*generation*, which is a broker job, not a model call."),
]

# unit -> human label
GATEWAY_SERVICE = {
    "sintra": "hermes-gateway.service",
    "amy": "hermes-gateway-amy.service",
}

BROKER_URL = "http://10.129.1.15:8100"

PERSONA_PAGE = {
    "sintra": "Sintra",
    "amy": "Amy",
}


def run(cmd, timeout=5):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip()
    except Exception:
        return ""


def vault_get(item, field="password"):
    # Retries once at timeout=60 rather than a single timeout=30 attempt: a
    # legitimate single-retry Vaultwarden recovery (vault-get-secret.sh's own
    # internal login/unlock/sync/get retry) can take ~32s, long enough that a
    # single timeout=30 call here would fail on a transient failure a second
    # attempt would have cleanly recovered from. Same pattern as
    # tools/hermes_game_backup_common.py's vault_get().
    for _ in range(2):
        try:
            result = subprocess.run(
                [str(VAULT_SCRIPT), item, field],
                capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


def systemctl_is_active(unit):
    return run(["systemctl", "is-active", unit]) or "unknown"


def query_model(port):
    """Return (model_id, n_ctx) from a live llama-server, or (None, None)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=3) as resp:
            data = json.load(resp)
        entry = data["data"][0]
        return entry["id"].rsplit("/", 1)[-1], entry["meta"]["n_ctx"]
    except (urllib.error.URLError, KeyError, IndexError, ValueError, OSError):
        return None, None


def hardware_software_facts():
    kernel = run(["uname", "-srm"]) or "unknown"
    gpu = run([
        "nvidia-smi", "--query-gpu=name,driver_version,memory.total",
        "--format=csv,noheader",
    ]) or "unknown"
    python_version = run(["python3", "--version"]) or "unknown"
    return {
        "Host": "NVIDIA DGX Spark (GB10, 128GB unified LPDDR5X) — shared with Sintra and Amy both",
        "OS / Kernel": kernel,
        "GPU": gpu,
        "Python": python_version,
    }


def broker_status():
    try:
        with urllib.request.urlopen(f"{BROKER_URL}/health", timeout=5) as resp:
            health = json.load(resp)
    except (urllib.error.URLError, ValueError, OSError):
        return {"reachable": False, "version": None, "job_count": None}
    token = vault_get("broker-token")
    job_count = None
    if token:
        try:
            req = urllib.request.Request(
                f"{BROKER_URL}/jobs", headers={"Authorization": f"Bearer {token}"}
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                job_count = len(json.load(resp))
        except (urllib.error.URLError, ValueError, OSError):
            pass
    return {
        "reachable": bool(health.get("ok")),
        "version": health.get("version"),
        "job_count": job_count,
    }


def collect_snapshot():
    """Structural facts only — no memory numbers, which fluctuate constantly
    and would make every run look like a 'change' for changelog purposes."""
    models = {}
    for role, port, _purpose in ROUTER_MODELS:
        model_id, n_ctx = query_model(port)
        models[role] = {"model": model_id, "n_ctx": n_ctx}

    gateways = {
        node: systemctl_is_active(unit) for node, unit in GATEWAY_SERVICE.items()
    }
    router_status = systemctl_is_active("hermes-router.service")
    broker = broker_status()

    return {
        "models": models,
        "gateways": gateways,
        "router_status": router_status,
        "broker_reachable": broker["reachable"],
        "broker_version": broker["version"],
    }


def diff_snapshots(old, new):
    """Human-readable lines describing what changed. Empty list if nothing did."""
    if old is None:
        return []  # first-ever run — nothing to compare against
    changes = []
    for role in new["models"]:
        o, n = old.get("models", {}).get(role, {}), new["models"][role]
        if o.get("model") != n.get("model"):
            changes.append(f"{role} (port for that role): model changed from {o.get('model')!r} to {n.get('model')!r}")
        if o.get("n_ctx") != n.get("n_ctx"):
            changes.append(f"{role}: context changed from {o.get('n_ctx')} to {n.get('n_ctx')}")
    for node in new["gateways"]:
        o, n = old.get("gateways", {}).get(node), new["gateways"][node]
        if o != n:
            changes.append(f"{node}'s gateway status changed from {o!r} to {n!r}")
    if old.get("router_status") != new["router_status"]:
        changes.append(f"router status changed from {old.get('router_status')!r} to {new['router_status']!r}")
    if old.get("broker_reachable") != new["broker_reachable"]:
        changes.append(f"broker reachability changed from {old.get('broker_reachable')} to {new['broker_reachable']}")
    return changes


def build_config_wikitext(persona, snapshot, hw):
    lines = []
    lines.append(
        f"Current shared fleet configuration relevant to {persona.capitalize()}. "
        "'''Auto-generated''' by <code>tools/hermes-wiki-sync.py</code> — do not "
        "hand-edit, changes will be overwritten on the next run."
    )
    lines.append("")
    lines.append("== Hardware / Software ==")
    lines.append("")
    lines.append('{| class="wikitable"')
    lines.append("! Component !! Value")
    for k, v in hw.items():
        lines.append("|-")
        lines.append(f"| {k} || {v}")
    lines.append("|}")
    lines.append("")
    lines.append("== Language Models (shared, reached via hermes-router) ==")
    lines.append("")
    lines.append('{| class="wikitable"')
    lines.append("! Role !! Model !! Context !! Purpose")
    for role, port, purpose in ROUTER_MODELS:
        m = snapshot["models"][role]
        model = m["model"] or "—"
        n_ctx = m["n_ctx"] or "—"
        lines.append("|-")
        lines.append(f"| {role} || {model} || {n_ctx} || {purpose}")
    lines.append("|}")
    lines.append("")
    lines.append("== Services ==")
    lines.append("")
    lines.append('{| class="wikitable"')
    lines.append("! Service !! Status")
    for node, unit in GATEWAY_SERVICE.items():
        marker = " (this persona)" if node == persona else ""
        lines.append("|-")
        lines.append(f"| {unit}{marker} || {snapshot['gateways'][node]}")
    lines.append("|-")
    lines.append(f"| hermes-router.service || {snapshot['router_status']}")
    lines.append("|-")
    broker_line = "reachable" if snapshot["broker_reachable"] else "unreachable"
    if snapshot["broker_version"]:
        broker_line += f" ({snapshot['broker_version']})"
    lines.append(f"| render broker (HomeD13 job queue) || {broker_line}")
    lines.append("|}")
    lines.append("")
    lines.append(
        "Real image/video rendering runs on HomeD13, submitted through the broker "
        "( <code>tools/hermes-render-request.sh</code> ) — never locally on the "
        "Spark, and never fabricated: a real job either produces a real file or a "
        "real error, delivered to <code>FleetOps</code> as the broker itself."
    )
    lines.append("")
    lines.append("[[Category:Firmament Personas]]")
    return "\n".join(lines)


def mediawiki(args_list, capture=False):
    result = subprocess.run(
        ["python3", str(MEDIAWIKI_SCRIPT)] + args_list,
        capture_output=True, text=True,
    )
    if not capture:
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
    return result.returncode, result.stdout


def prepend_changelog_entry(page, entry_text):
    """Changelog convention is newest-entries-at-top; mediawiki.py's `append`
    only adds to the end, so read the current content, splice the new dated
    section in right after the intro paragraph (before the first existing
    '== ' heading), and do a full `edit` instead."""
    rc, out = mediawiki(["read", page], capture=True)
    if rc != 0 or "Page not found" in out:
        with tempfile.NamedTemporaryFile("w", suffix=".wikitext", delete=False) as f:
            f.write(entry_text)
            tmp_path = f.name
        return mediawiki(["append", page, "--summary", "auto-logged configuration change", "--file", tmp_path])[0]

    body = out.split("\n\n", 1)[1] if "\n\n" in out else out
    split_at = body.find("\n== ")
    if split_at == -1:
        new_body = body.rstrip() + "\n\n" + entry_text
    else:
        new_body = body[:split_at].rstrip() + "\n\n" + entry_text.rstrip() + "\n" + body[split_at:]

    with tempfile.NamedTemporaryFile("w", suffix=".wikitext", delete=False) as f:
        f.write(new_body)
        tmp_path = f.name
    return mediawiki(["edit", page, "--summary", "auto-logged configuration change", "--file", tmp_path])[0]


def main():
    dry_run = "--dry-run" in sys.argv

    snapshot = collect_snapshot()
    hw = hardware_software_facts()

    old_snapshot = None
    if STATE_PATH.exists():
        try:
            old_snapshot = json.loads(STATE_PATH.read_text())
        except Exception:
            old_snapshot = None
    changes = diff_snapshots(old_snapshot, snapshot)

    if dry_run:
        for persona in PERSONA_PAGE:
            print(f"=== {persona.capitalize()}/Configuration ===")
            print(build_config_wikitext(persona, snapshot, hw))
            print()
        if changes:
            print("--- would log to both changelogs ---")
            for c in changes:
                print(f"* {c}")
        return

    overall_rc = 0
    changelog_ok = True
    for persona, page in PERSONA_PAGE.items():
        wikitext = build_config_wikitext(persona, snapshot, hw)
        with tempfile.NamedTemporaryFile("w", suffix=".wikitext", delete=False) as f:
            f.write(wikitext)
            tmp_path = f.name
        rc, _ = mediawiki(["edit", f"{page}/Configuration", "--summary", "automated configuration update (cron)", "--file", tmp_path])
        overall_rc = overall_rc or rc

        if changes:
            entry_lines = [f"== {date.today().isoformat()} (auto) ==", ""]
            entry_lines += [f"* {c}" for c in changes]
            entry_lines.append("")
            changelog_rc = prepend_changelog_entry(f"{page}/Changelog", "\n".join(entry_lines))
            overall_rc = overall_rc or changelog_rc
            if changelog_rc != 0:
                changelog_ok = False
                print(f"WARNING: changelog write failed for {page}/Changelog (rc={changelog_rc})", file=sys.stderr)

    # Only advance state if every changelog write succeeded (or there were no
    # changes to log). A failed Configuration edit is safe to just retry next
    # run — it's a full idempotent overwrite, no history to lose — but a
    # failed changelog write is NOT: if state advanced anyway, the next run's
    # diff would compare against the new snapshot, see no change, and the
    # entry that was supposed to record this run's real change would be
    # silently and permanently lost with no error ever surfaced. Previously
    # this script wrote state unconditionally and never even checked the
    # changelog write's own return code, so a transient failure there was
    # invisible. The tradeoff accepted here: if Configuration succeeds but
    # Changelog fails, state doesn't advance, so a *successful* Configuration
    # edit gets harmlessly repeated next run alongside the changelog retry.
    if changelog_ok:
        STATE_PATH.write_text(json.dumps(snapshot, indent=2))
    else:
        print("not advancing saved state — will retry the same diff (and changelog entry) next run", file=sys.stderr)
    sys.exit(overall_rc)


if __name__ == "__main__":
    main()
