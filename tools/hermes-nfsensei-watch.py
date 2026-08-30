#!/usr/bin/env python3
# Version: 1.2.1
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.2.0 — HermesAgentV5 S13: LLM_MODEL default nano -> dispatch. nano is retired
# (IMPLEMENTATION_PLAN.md S13); dispatch is stock and always-resident, same shape nano used to fill.
#
# 1.1.0 — security-review fix: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing on a complete Vaultwarden
# outage (both attempts of its own retry loop hitting the full timeout).
"""
hermes-nfsensei-watch.py — Daily check of the nfSensei project blog against a
fixed list of "worth evaluating switching from pfSense" criteria; emails The
Boss when a new post crosses one that wasn't already met.

This started as a draft (`skills/nfsensei_watch.py`) written in a separate
session and dropped into the repo for review — its core logic (fetch the
blog index, diff against seen URLs, ask an LLM to check unmet criteria
against new post text, email on a match, persist state so it doesn't
re-alert) was sound, but it assumed infrastructure this fleet doesn't have:
a generic OpenAI-compatible endpoint at localhost:8000, and SMTP credentials
read from plaintext env vars. Real changes made porting it here:

1. LLM calls go through the fleet's actual router (`tools/hermes-router.py`,
   http://127.0.0.1:8080/v1/chat/completions) instead of a placeholder
   endpoint — its request/response shape already matched exactly, so this
   was a config change, not a rewrite. `model: "core"` is plenty for a
   classification task like this.
2. Email goes through the same Vaultwarden-backed SMTP path
   `tools/hermes-fleet-health.py` already uses: `vault-get-secret.sh
   email-sintra password`, `mail.hover.com:587`, from
   `mercury@canislupisnc.net` to `notifications@canislupisnc.net` — no
   plaintext credential anywhere.
3. State lives at a real, explicit path (`~/.hermes/state/`), not wherever
   the process happens to have as its cwd.

Runs daily via `hermes-nfsensei-watch.timer` (see `infra/hermes-nfsensei-watch/`).

Usage: hermes-nfsensei-watch.py [--dry-run]
  --dry-run   print what would be emailed instead of sending it, and don't
              update the state file — for testing without disturbing real state.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from email.mime.text import MIMEText
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_GET = f"{REPO_DIR}/tools/vault-get-secret.sh"

BLOG_INDEX_URL = "https://blog.nfsensei.org/"
STATE_FILE = Path.home() / ".hermes" / "state" / "nfsensei_state.json"

ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080")
LLM_MODEL = os.environ.get("LLM_MODEL", "dispatch")  # V5 S13: nano retired, dispatch is the new stock/always-resident default

SMTP_HOST = "mail.hover.com"
SMTP_PORT = 587
SMTP_FROM = "mercury@canislupisnc.net"
EMAIL_TO = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

# The switch-evaluation criteria. Edit freely — these are The Boss's own call,
# not nfSensei's. Each has a short id (used in state tracking) and a
# description fed to the LLM so it knows what to look for.
CRITERIA = {
    "ga_release": (
        "An official 1.0, stable, or general-availability (GA) release "
        "has shipped — not a pre-1.0 point release like 0.51.x."
    ),
    "hw_requirements_doc": (
        "The project has published a formal minimum/recommended hardware "
        "requirements document (specific CPU, RAM, storage numbers), "
        "not just scattered mentions in release notes."
    ),
    "line_rate_validated": (
        "The VPP/DPDK dataplane (on x86 or the OCTEON10 switch platform) "
        "has been validated at line-rate throughput (10G/40G or similar), "
        "with the project itself confirming performance, not just bring-up."
    ),
    "pfsense_import_mature": (
        "The pfSense config.xml import path is described as field-tested "
        "or production-ready, rather than newly wired in / experimental."
    ),
    "second_security_cycle": (
        "A second (or later) dedicated security release has shipped, "
        "showing the disclosure-and-patch process is repeatable, not a "
        "one-off."
    ),
}


def vault_get(item, field):
    # Retry once: vault-get-secret.sh's own header documents a real, known
    # cause of a transient spurious failure (a stale local `bw` cache on a
    # node that didn't just touch this item) — hit live twice during this
    # tool's own testing, cleared by simply calling again. vault-get-secret.sh
    # 1.2.0 (2026-08-09) now retries this same failure mode internally too, up
    # to 3x — timeout=60, not 30, so a single internal retry (~32s) can't get
    # killed mid-recovery; this function's own outer retry is now redundant
    # but harmless, left in place rather than removed for no real benefit.
    for _ in range(2):
        try:
            result = subprocess.run([VAULT_GET, item, field], capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return ""


# ── state ────────────────────────────────────────────────────────────────

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"seen_urls": [], "criteria_met": {}}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── blog fetch ───────────────────────────────────────────────────────────

def get_post_links():
    """Return a list of (title, url) for posts linked from the blog index."""
    resp = requests.get(BLOG_INDEX_URL, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.endswith(".html") and "about" not in href:
            full_url = href if href.startswith("http") else BLOG_INDEX_URL.rstrip("/") + "/" + href.lstrip("/")
            title = a.get_text(strip=True) or full_url
            links.append((title, full_url))

    seen, unique = set(), []
    for title, url in links:
        if url not in seen:
            seen.add(url)
            unique.append((title, url))
    return unique


def get_post_text(url):
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["nav", "header", "footer", "script", "style"]):
        tag.decompose()
    return soup.get_text(separator="\n", strip=True)


# ── LLM evaluation, via the fleet's own router ──────────────────────────

def build_prompt(post_title, post_text, unmet_criteria):
    criteria_block = "\n".join(f"- {cid}: {desc}" for cid, desc in unmet_criteria.items())
    return f"""You are screening a blog post from the nfSensei project (a firewall/network OS) against a list of criteria for whether it's worth evaluating switching from pfSense.

Blog post title: {post_title}

Criteria to check (only these — do not invent new ones):
{criteria_block}

Blog post text:
---
{post_text[:8000]}
---

For EACH criterion above, decide independently whether the post text fully and unambiguously
satisfies it — being related to the same topic is not enough. A criterion is met only if the post
states the specific fact required, not a step toward it, a partial version of it, or something
merely adjacent. If the post explicitly says something is not yet done, planned, in progress, or a
lesser version of what the criterion requires (e.g. a pre-1.0 point release when the criterion
requires GA; "not yet validated" when the criterion requires validation), that criterion is NOT
met — do not include it.

Respond with ONLY a JSON object, no other text, in this exact shape:
{{"matched": ["criterion_id", ...], "reasoning": {{"criterion_id": {{"quote": "the exact sentence from the post text that proves this", "why": "one sentence"}}, ...}}}}

Every entry in "matched" must have a "quote" that is copied verbatim from the post text above and
that, standing alone, would convince a skeptical reader the criterion is fully met. If you cannot
find such a sentence, do not include that criterion. If none match, return {{"matched": [], "reasoning": {{}}}}.
"""


def _call_llm_once(prompt):
    resp = requests.post(
        f"{ROUTER_URL}/v1/chat/completions",
        headers={"Content-Type": "application/json"},
        json={"model": LLM_MODEL, "messages": [{"role": "user", "content": prompt}], "stream": False},
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    err = data.get("error", {}).get("message")
    if err:
        raise RuntimeError(f"router error: {err}")
    content = data["choices"][0]["message"]["content"]
    content = re.sub(r"^```json\s*|\s*```$", "", content.strip())
    return json.loads(content)


def call_llm(prompt):
    # Live testing (2026-08-09) found the model occasionally returns JSON with
    # an unescaped quote inside the literal "quote" field it was asked for,
    # breaking json.loads(). One retry (a fresh completion, not a repeat of
    # the same broken text) clears most of these — sampling variance means
    # it rarely fails the same way twice. A real failure after the retry is
    # a real failure, not silently swallowed.
    try:
        return _call_llm_once(prompt)
    except json.JSONDecodeError:
        return _call_llm_once(prompt)


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
    except Exception as e:
        print(f"ERROR: email send failed: {e}", file=sys.stderr)
        return False


# ── main ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Watch the nfSensei blog for pfSense-switch-worthy posts")
    parser.add_argument("--dry-run", action="store_true", help="print instead of email; don't update state")
    args = parser.parse_args()

    state = load_state()
    unmet = {cid: desc for cid, desc in CRITERIA.items() if cid not in state["criteria_met"]}
    if not unmet:
        print("All tracked criteria already met — nothing left to watch. Consider revisiting your criteria list.")
        return

    try:
        posts = get_post_links()
    except Exception as e:
        print(f"Failed to fetch blog index: {e}", file=sys.stderr)
        sys.exit(1)

    new_posts = [(t, u) for t, u in posts if u not in state["seen_urls"]]
    if not new_posts:
        print(f"[{datetime.now(timezone.utc).isoformat()}] No new posts.")
        return

    newly_met = {}
    matched_urls = set()  # posts that produced a real match — see note below
    for title, url in new_posts:
        print(f"Checking new post: {title} ({url})")
        try:
            text = get_post_text(url)
            result = call_llm(build_prompt(title, text, unmet))
        except Exception as e:
            print(f"  Skipping — evaluation failed: {e}", file=sys.stderr)
            state["seen_urls"].append(url)
            continue

        matched_here = False
        for cid in result.get("matched", []):
            if cid not in unmet or cid in newly_met:
                continue
            entry = result.get("reasoning", {}).get(cid, {})
            quote, why = entry.get("quote", ""), entry.get("why", "")
            # Code-level grounding check, not just a prompt instruction: the
            # model's quote must actually appear in the real post text.
            # Real live testing (2026-08-09) found both "core" and "weaver"
            # produce matches whose own stated reasoning contradicts the
            # match (e.g. matched "line-rate validated" while the quoted
            # reasoning said "not yet claimed") — a prompt fix alone doesn't
            # reliably prevent that, so verify against the source text too.
            if not quote or quote.strip() not in text:
                print(f"  Dropping unverified match '{cid}' — quote not found verbatim in post text")
                continue
            newly_met[cid] = {"post_title": title, "post_url": url, "reasoning": why, "quote": quote}
            matched_here = True

        # A post with no real match is fully handled — mark it seen now.
        # A post that DID match stays out of seen_urls until the email
        # actually goes out (below) — marking it seen unconditionally here
        # was a real bug: a failed send would permanently lose that match,
        # since a "seen" post never gets re-evaluated and nothing else
        # remembers the pending alert.
        if matched_here:
            matched_urls.add(url)
        else:
            state["seen_urls"].append(url)

    if newly_met:
        lines = ["nfSensei just crossed criteria worth a look:\n"]
        for cid, info in newly_met.items():
            lines.append(f"- {CRITERIA[cid]}")
            lines.append(f"  Post: {info['post_title']} ({info['post_url']})")
            lines.append(f"  Quote: \"{info['quote']}\"")
            lines.append(f"  Why: {info['reasoning']}\n")

        still_open = [c for c in CRITERIA if c not in state["criteria_met"] and c not in newly_met]
        if still_open:
            lines.append("Still open:")
            lines.extend(f"- {CRITERIA[cid]}" for cid in still_open)
        else:
            lines.append("All tracked criteria are now met — this is likely a good time for a full re-evaluation.")

        subject = f"nfSensei update: {len(newly_met)} criteria met"
        body = "\n".join(lines)
        if args.dry_run:
            print(f"\n--dry-run: would send email --\nSubject: {subject}\n\n{body}")
            state["seen_urls"].extend(matched_urls)  # dry-run never persists anyway
        elif send_email(subject, body):
            print(f"Alert sent for: {', '.join(newly_met.keys())}")
            for cid, info in newly_met.items():
                state["criteria_met"][cid] = info
            state["seen_urls"].extend(matched_urls)
        else:
            print("Email failed — leaving matched post(s) out of seen_urls so they're retried next run",
                  file=sys.stderr)

    if not args.dry_run:
        save_state(state)
    else:
        print("\n--dry-run: state not saved")


if __name__ == "__main__":
    main()
