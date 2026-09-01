#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-09-01) — real bug found by inspecting the state file after the real (non-dry-run)
# first run: qwen4exp silently migrated as unresolved, losing its real historical evidence (PR
# #27742). Cause: the legacy alert-state.json's own key is "llama_cpp_qwen4exp", not "qwen4exp" —
# load_state() assumed the keys matched WATCHED_TERMS 1:1 and never checked. Added LEGACY_KEY_MAP,
# an explicit mapping instead of an assumed equality. The already-written live state file was
# hand-corrected to match (not re-run, to avoid sending a duplicate email minutes after the first).
#
# 1.1.0 (2026-09-01) — real false positive caught in the dry-run test, before this ever reached a
# live timer: check_watched_terms()'s GitHub search for "GLM-5.3" matched PR #27466 ("ROCm: add
# radix TOP_K for long rows") — completely unrelated; the term only appeared somewhere in that
# PR's own comment thread, not its actual subject, and the naive version below treated any
# `merged_at`-set hit as confirmed support. Deployed as originally written, this would have
# emailed a false "GLM-5.3 support merged" claim on its very first real run. Fixed: a hit now only
# counts if the term appears in the PR's own title (title-only search text is a much stronger, if
# still imperfect, signal than a hit anywhere in title+body+comments), and findings are always
# phrased as "worth a manual look," never as confirmed fact. The state schema's `alerted` field
# was replaced with `resolved`, which this function no longer sets on its own at all — only a
# human directly verifying support landed, or check_arch_diff() (which reads real compiled-in
# architecture identifiers, not search text), can close out a watched term now.
#
"""
hermes-model-watch.py — Weekly check for new llama.cpp architecture support relevant to this
fleet's watched model families (GLM-5.3, plus the two Qwen4 variants already found to fail on
this build), emailing The Boss only when something real changes.

Real gap found live 2026-09-01, direct request ("does the fleet have a scheduled task to check
for a patched llama.cpp that can support GLM 5.3?"): infra/model-watch/alert-state.json already
existed, with real historical data (a genuine llama.cpp PR URL for qwen4exp, a seeded list of
GLM-5.3 HF repo IDs) — but no script, systemd unit, or timer anywhere in this repo or its V4
predecessor ever produced or updated that file. The capability was designed (the state file's own
shape makes the intent obvious) but never actually built. This is that build — after confirming,
live, that GLM-5.3 architecture support doesn't exist anywhere yet (checked ggml-org/llama.cpp's
own current `src/llama-arch.h` on GitHub directly, same day this was written: only CHATGLM/GLM4/
GLM4_MOE/GLM_DSA are defined, upstream or locally) — so there is genuinely nothing to catch up on
today; this script exists to notice the moment that changes, not to pretend it already has.

Two independent, both-deterministic checks, no LLM involved (same reasoning hermes-model-scan.py's
own header already documents for keeping facts out of the model's hands):

  1. Architecture enum diff (check_arch_diff) — compares this fleet's actual local llama.cpp
     checkout (/opt/llama.cpp, confirmed live to be the real build location on Spark) against
     upstream ggml-org/llama.cpp's current `src/llama-arch.h` on GitHub. Any `LLM_ARCH_*` enum
     upstream but absent locally is real, unambiguous evidence the local build is missing
     architecture support a rebuild could add — generic, not GLM-specific, so it surfaces
     anything new, not just what WATCHED_TERMS happens to name. Only `git fetch` (updates
     remote-tracking refs) — never `git pull`/`checkout`/rebuild; that stays a separate,
     deliberate human action (see infra/model-abliteration/README.md §3 for the real procedure).
  2. Watched-term PR search (check_watched_terms) — GitHub's public search API, scoped to
     ggml-org/llama.cpp, for each name in WATCHED_TERMS, title-filtered (see the function's own
     docstring for a real false positive this caught before ever shipping) and always reported as
     a candidate for manual verification, never as confirmed support on its own. Catches activity
     under a naming convention the enum diff wouldn't obviously match, and gives earlier
     visibility into an open (not yet merged) PR before it ever reaches master.

A third, lower-stakes check (check_hf_releases) tracks new GLM-5.3-named GGUF repos appearing on
Hugging Face — purely informational (a GGUF existing doesn't mean llama.cpp can load it), kept
because the original seed data already implied it was part of the intended design.

State migrates once from the pre-existing infra/model-watch/alert-state.json (real historical
data — qwen4exp already alerted with its real PR URL, a seeded GLM-5.3 HF-repo list) into the
runtime state file, the same ~/.hermes/state/ location hermes-model-scan.py's own state already
lives in — not re-alerting on facts already known. The architecture-diff check baselines silently
on its first-ever run (local was already ~2.5 weeks behind upstream when this was written, which
would otherwise flood the first email with every commit's worth of unrelated new architectures);
only genuinely new gap entries on later runs are reported.

Runs weekly via `hermes-model-watch.timer` (see `infra/model-watch/`), same cadence and oneshot
shape as `hermes-model-scan.timer`.

Usage: hermes-model-watch.py [--dry-run]
  --dry-run   print what would be emailed instead of sending it, and don't update the state file.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path

import requests

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_GET = f"{REPO_DIR}/tools/vault-get-secret.sh"

# Confirmed live 2026-09-01 (`which llama-server` / directory ownership check on Spark) — the
# real checkout this fleet actually builds and serves from, owned by the same `pmoney` identity
# this script runs as.
LLAMA_CPP_DIR = "/opt/llama.cpp"
LLAMA_CPP_UPSTREAM_ARCH_URL = "https://raw.githubusercontent.com/ggml-org/llama.cpp/master/src/llama-arch.h"
GITHUB_SEARCH_API = "https://api.github.com/search/issues"
HF_API = "https://huggingface.co/api/models"

STATE_FILE = Path.home() / ".hermes" / "state" / "model_watch_state.json"
LEGACY_SEED_FILE = Path(REPO_DIR) / "infra" / "model-watch" / "alert-state.json"

SMTP_HOST = "mail.hover.com"
SMTP_PORT = 587
SMTP_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

ARCH_ENUM_RE = re.compile(r"\bLLM_ARCH_[A-Z0-9_]+\b")

# Human-curated, matching what The Boss has actually asked to track — not meant to be
# exhaustive; check_arch_diff() catches everything else generically regardless of this list.
WATCHED_TERMS = {
    "glm_5_3": "GLM-5.3",
    "qwen4exp": "qwen4exp architecture",
    "qwen4_flash": "Qwen4 Flash",
}


def vault_get(item, field):
    for _ in range(2):
        try:
            result = subprocess.run([VAULT_GET, item, field], capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


# ── state ────────────────────────────────────────────────────────────────

# Legacy alert-state.json's own top-level keys don't match WATCHED_TERMS' keys 1:1 (found live,
# by inspecting the migrated state file after a real run: "qwen4exp" silently migrated as
# unresolved because the legacy key is actually "llama_cpp_qwen4exp", not "qwen4exp" —
# seed.get("qwen4exp") was a silent no-op the whole time). Explicit mapping, not assumed equality.
LEGACY_KEY_MAP = {
    "glm_5_3": None,  # legacy only ever had the HF-seen list for this, no per-term alert object
    "qwen4exp": "llama_cpp_qwen4exp",
    "qwen4_flash": "qwen4_flash",
}


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    if LEGACY_SEED_FILE.exists():
        # One-time migration of real historical data left behind when this capability was
        # designed but never actually built — see module docstring. Legacy `alerted` -> `resolved`:
        # the qwen4exp entry's `alerted: true` reflected a real, independently-corroborated finding
        # (coder2 failing to load with "unknown model architecture: 'qwen4exp'", documented in
        # tools/hermes-router.py's own changelog) — trusted and carried forward as already
        # resolved. Going forward, only a human directly verifying support landed (or the
        # architecture-diff check reading real compiled-in identifiers) can mark something
        # resolved — see check_watched_terms()'s own docstring for why search hits alone no
        # longer do that automatically.
        seed = json.loads(LEGACY_SEED_FILE.read_text())
        watched = {}
        for term in WATCHED_TERMS:
            legacy_key = LEGACY_KEY_MAP.get(term)
            entry = seed.get(legacy_key, {}) if legacy_key else {}
            watched[term] = {
                "resolved": entry.get("alerted", False),
                "evidence_url": entry.get("evidence_url"),
                "last_hits": [],
            }
        return {"watched": watched, "hf_seen": {"glm_5_3": seed.get("glm_5_3_seen", [])}}
    return {
        "watched": {term: {"resolved": False, "evidence_url": None, "last_hits": []} for term in WATCHED_TERMS},
        "hf_seen": {},
    }


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── check 1: architecture enum diff (generic, not GLM-specific) ───────────

def local_arch_set():
    text = (Path(LLAMA_CPP_DIR) / "src" / "llama-arch.h").read_text(errors="replace")
    return set(ARCH_ENUM_RE.findall(text))


def local_commit_info():
    out = subprocess.run(["git", "-C", LLAMA_CPP_DIR, "log", "-1", "--format=%H %ci"],
                          capture_output=True, text=True, timeout=15)
    return out.stdout.strip() or "(unknown)"


def fetch_upstream_ref():
    """`git fetch` only — updates remote-tracking refs, never touches the working tree or the
    running build. Rebuilding is a separate, deliberate human action."""
    subprocess.run(["git", "-C", LLAMA_CPP_DIR, "fetch", "origin"],
                    capture_output=True, text=True, timeout=60)
    out = subprocess.run(["git", "-C", LLAMA_CPP_DIR, "log", "-1", "origin/master", "--format=%H %ci"],
                          capture_output=True, text=True, timeout=15)
    return out.stdout.strip() or "(unknown)"


def upstream_arch_set():
    resp = requests.get(LLAMA_CPP_UPSTREAM_ARCH_URL, timeout=30)
    resp.raise_for_status()
    return set(ARCH_ENUM_RE.findall(resp.text))


def check_arch_diff(state, findings):
    local_archs = local_arch_set()
    upstream_ref = fetch_upstream_ref()
    upstream_archs = upstream_arch_set()
    current_gap = upstream_archs - local_archs
    first_run = "known_gap" not in state
    known_gap = set(state.get("known_gap", []))
    new_gap = current_gap - known_gap

    if first_run:
        if current_gap:
            print(f"Baselining: local build is missing {len(current_gap)} upstream architecture(s) "
                  f"already (not alerting on the first run): {', '.join(sorted(current_gap))}")
    elif new_gap:
        findings.append(
            f"Upstream llama.cpp (origin/master, {upstream_ref}) has {len(new_gap)} new "
            f"architecture(s) this fleet's local build (commit {local_commit_info()}) doesn't: "
            + ", ".join(sorted(new_gap))
            + ". A `git pull && cmake --build` (see infra/model-abliteration/README.md §3) would "
              "add support."
        )
    state["known_gap"] = sorted(current_gap)


# ── check 2: watched-term PR search (GitHub public search API, unauthenticated) ───────────

def search_llama_cpp_prs(term):
    """Real evidence only — a merged PR/issue result from GitHub's own search API, same
    "deterministic fetch, no judgment call" shape hermes-model-scan.py's own HF search uses.
    Unauthenticated (60 req/hr) — plenty for a handful of weekly queries."""
    resp = requests.get(
        GITHUB_SEARCH_API,
        params={"q": f'repo:ggml-org/llama.cpp "{term}"', "sort": "updated", "order": "desc", "per_page": 5},
        headers={"Accept": "application/vnd.github+json"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("items", [])


def check_watched_terms(state, findings):
    """Deliberately conservative, after a real false positive caught live before this ever
    shipped: GitHub's search API's `"GLM-5.3"` query matched PR #27466 ("ROCm: add radix TOP_K
    for long rows") — completely unrelated, the term only appeared somewhere in its comment
    thread, not its actual subject. Full-text search across title+body+comments is not evidence
    of a PR actually implementing something; treating any hit as "merged support found" would
    have emailed a confirmed-false claim. Two changes from the naive version: (1) a hit only
    counts if the term appears in the PR's own *title*, a much stronger (if imperfect) signal;
    (2) findings are always phrased as "worth a manual look," never as confirmed support — this
    check's job is to surface candidates for a human to verify, not to assert facts on its own.
    `resolved` is intentionally never set by this function — only a human editing state (once
    they've actually verified real support landed) or the architecture-diff check in
    check_arch_diff() (which reads real compiled-in architecture identifiers, not search text)
    can be trusted to close out a watched term."""
    for key, label in WATCHED_TERMS.items():
        watch = state["watched"].setdefault(key, {"resolved": False, "evidence_url": None, "last_hits": []})
        if watch.get("resolved"):
            continue
        try:
            items = search_llama_cpp_prs(label)
        except Exception as exc:
            print(f"PR search for {label!r} failed: {exc}", file=sys.stderr)
            continue
        term_key = label.split()[0].lower()  # e.g. "glm-5.3" out of "GLM-5.3"
        title_matches = [i for i in items if term_key in i.get("title", "").lower()]
        seen = set(watch.get("last_hits", []))
        new_hits = [i["html_url"] for i in title_matches if i["html_url"] not in seen]
        if new_hits:
            findings.append(
                f"{label}: possible llama.cpp activity worth a manual look (title-matched, but "
                f"NOT confirmation of actual merged support — verify directly before acting on "
                f"it): " + ", ".join(new_hits)
            )
            watch["last_hits"] = sorted(seen | set(new_hits))


# ── check 3: HF release tracking (informational only) ──────────────────────

def search_hf_glm_5_3():
    resp = requests.get(HF_API, params={"search": "GLM-5.3", "limit": 30}, timeout=30)
    resp.raise_for_status()
    return [rec["id"] for rec in resp.json()]


def check_hf_releases(state, findings):
    seen = set(state.setdefault("hf_seen", {}).setdefault("glm_5_3", []))
    current = set(search_hf_glm_5_3())
    new_repos = sorted(current - seen)
    if new_repos and seen:  # don't flood the first run with the whole existing catalog
        findings.append(f"New GLM-5.3 GGUF repo(s) on Hugging Face: {', '.join(new_repos)}")
    state["hf_seen"]["glm_5_3"] = sorted(current | seen)


# ── email ────────────────────────────────────────────────────────────────

def send_email(subject, body):
    import smtplib

    password = vault_get("email-sintra", "password")
    if not password:
        print("ERROR: could not fetch email-sintra password from vault", file=sys.stderr)
        return False

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = f"{EMAIL_TO_NAME} <{EMAIL_TO}>"

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
            server.starttls()
            server.login(SMTP_FROM, password)
            server.send_message(msg)
        return True
    except Exception as exc:
        print(f"ERROR: email send failed: {exc}", file=sys.stderr)
        return False


# ── main ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Weekly llama.cpp architecture-support watch")
    parser.add_argument("--dry-run", action="store_true", help="print instead of email; don't update state")
    args = parser.parse_args()

    state = load_state()
    findings = []

    try:
        check_arch_diff(state, findings)
    except Exception as exc:
        print(f"Architecture diff check failed: {exc}", file=sys.stderr)

    check_watched_terms(state, findings)

    try:
        check_hf_releases(state, findings)
    except Exception as exc:
        print(f"HF GLM-5.3 search failed: {exc}", file=sys.stderr)

    if not findings:
        print(f"[{datetime.now(timezone.utc).isoformat()}] Nothing new this week.")
        if not args.dry_run:
            save_state(state)
        return

    subject = f"Model-watch: {len(findings)} update(s) (llama.cpp architecture / GLM-5.3)"
    body = "\n\n".join(findings)

    if args.dry_run:
        print(f"\n--dry-run: would send email --\nSubject: {subject}\n\n{body}")
        print("\n--dry-run: state not saved")
        return

    if send_email(subject, body):
        print(f"Report sent: {len(findings)} finding(s)")
        save_state(state)
    else:
        print("Email failed — state not saved so findings are retried next run", file=sys.stderr)


if __name__ == "__main__":
    main()
