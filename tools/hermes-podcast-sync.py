#!/usr/bin/env python3
# Version: 1.3.0
#
# 1.3.0 — adds Dan Carlin's three shows to the daily sync, direct request,
# following hermes-podcast-retriever.py 1.3.0 (2026-08-19) adding them and a
# same-session manual run confirming the real archive/RSS feeds behave as
# expected (28 real episodes fetched, 0 failed). Genuinely different shape
# from every show added here so far: Dan Carlin's output root is RAGDocs
# (Phase 30f's personal-kb share), not this script's own PodCasts constant
# every other show writes under — so this can't just be three more names on
# the existing SHOWS list, it needs its own retriever invocation against its
# own --outputdir. run_retriever() factors the subprocess call out so main()
# can call it twice (PodCasts/SHOWS, then RAGDocs/DANCARLIN_SHOWS) and merge
# both runs' output through the same parsing/suppression/email path
# unchanged, rather than duplicating that logic. A run that fails to launch
# at all (not a normal in-band fetch failure, which the retriever already
# reports via stdout) is tracked per-invocation now instead of aborting the
# whole sync — so a RAGDocs-side crash can't silently swallow real PodCasts
# downloads that already succeeded in the same run, or vice versa. Added
# three FILENAME_PATTERNS entries for the new `{ep}-{name}` naming
# convention; live-checked systemd's actual configured start-timeout before
# assuming it needed raising for the added runtime -- `TimeoutStartUSec` is
# already `infinity` for this oneshot service (not systemd's 90s default,
# which turns out not to bind Type=oneshot here), so no change was needed.
#
# 1.2.0 — adds "tbrh" (Tech Brew Ride Home) to the daily SHOWS list, direct
# request 2026-08-15: this show has no official transcript (confirmed live
# the same day), only its own official RSS feed's per-episode story-links
# citation list, which hermes-podcast-retriever.py 1.2.0 now also retrieves.
# Added a FILENAME_PATTERNS entry for tbrh's `tbrh-YYYYMMDD.json` naming.
# Also fixes a real latent bug this exposed: is_recent()'s
# `latest_episode[show] - ep` assumed every show's episode numbers are
# sequential integers a fixed distance apart, which SN/IM/TWIG's actual
# episode numbers are but tbrh's YYYYMMDD-keyed ones are not — raw
# subtraction across a month/year boundary (e.g. 20260901 - 20260831 = 70,
# not 1) would have silently misjudged recency and could suppress a
# genuinely-recent gap. episode_distance() below handles tbrh as real
# calendar dates instead.
#
# 1.1.0 — two security-review fixes: vault_get_email_password() now catches
# subprocess.TimeoutExpired instead of crashing; now detects and emails a
# real alert when the retriever reports a total remote-fetch failure for a
# show (a full GRC/twit.tv outage previously produced total_dl==0 with no
# failure recorded either — silently indistinguishable from a genuinely
# quiet, healthy run). See hermes-podcast-retriever.py 1.1.0's matching fix.
"""
hermes-podcast-sync.py — Daily podcast sync — wrapper around
hermes-podcast-retriever.py. Runs via hermes-podcast-sync.timer as pmoney
(see infra/hermes-podcast-sync/).

Phase 24 (IMPLEMENTATION_PLAN.md §7). Ported from v1
(../HermesAgent/scripts/podcast-sync.py), whose suppression logic and
overall structure needed no rework — only three things were wrong for this
project's current state, all fixed here:
  1. Output dir was v1's `/mnt/nfs/PMoney/PodCasts`, an autofs mount that no
     longer exists post-migration. The real, current NFS mount (Phase 12) is
     `/mnt/nas2-hermes-backup` (10.129.1.167:/volume1/PMoney) — confirmed
     live 2026-08-12 that `PodCasts/` is still there with the full archive
     intact (2786 SN files, 74 IM files at verification time).
  2. Email used a plaintext `~/.hermes/config/email.json`, predating this
     project's Vaultwarden-only credential rule (§2b). Switched to
     `vault-get-secret.sh email-sintra password`, the same vault item
     hermes-fleet-health.py and hermes-pfsense-report.py already use.
  3. It was never actually scheduled anywhere — v1's `hermes cron create`
     subsystem has no equivalent in this project. Scheduled here via a
     systemd timer instead, same pattern as every other Phase 12+ tool.

Prints a concise summary only when there are new downloads or unexpected
failures; empty stdout = silent (no notification sent) — same discipline
hermes-fleet-health.py uses for "only say something when there's something
to say."

Failure-suppression policy (unchanged from v1): a missing file only stops
being reported once it has (a) been missing for at least SUPPRESS_AFTER_DAYS
continuously, AND (b) aged out of the RECENT_EPISODE_WINDOW most-recent known
episode numbers for its show. Recent episodes always stay visible even after
30 days, since that's exactly the kind of stuck/overdue transcript worth a
human noticing — only genuinely old, long-abandoned gaps (e.g. GRC never
publishing a given episode's transcript) get auto-hidden. See
~/.hermes/state/podcast-sync/missing-since.json for the tracked
first-seen-missing date per file.

1.0.1 (2026-08-12, found on the first real run through the installed
systemd unit): the retriever hit a genuine, confirmed-permanent upstream
gap (SN-747 — 404 on GRC in every format), correctly emailed it, but the
script then exited 1 for it, which systemd read as the *service* being
broken — exactly the phantom-failed-unit class of bug Phase 13 already
found and fixed once for ollama.service/hermes-gateway.service. This would
have shown up as a standing "Failed units" hit in every daily fleet-health
report for the next 30 days over something that isn't actually wrong with
the tool. Fixed: exit 0 whenever the sync ran and (if there was anything to
say) the email genuinely sent — only a failure to run the retriever at all,
or a failure to send the notification, now returns 1.

Usage:
  hermes-podcast-sync.py             # real run: sync, email if noteworthy, advance state
"""
import json
import re
import smtplib
import subprocess
import sys
from datetime import date
from email.mime.text import MIMEText
from pathlib import Path

REPO_DIR   = Path(__file__).resolve().parent.parent
RETRIEVER  = REPO_DIR / "tools" / "hermes-podcast-retriever.py"
VAULT_SCRIPT = REPO_DIR / "tools" / "vault-get-secret.sh"

# The real NAS share's PodCasts folder (10.129.1.167:/volume1/PMoney/PodCasts),
# reached via the Phase 12 NFS mount at /mnt/nas2-hermes-backup on the Spark.
# Do not repoint this without confirming the mount live first — v1's
# equivalent path (/mnt/nfs/PMoney) silently stopped existing across the
# HermesAgentV4 migration and this sync sat unscheduled as a result.
OUTPUT_DIR = "/mnt/nas2-hermes-backup/PodCasts"
SHOWS      = ["sn", "im", "tbrh"]

# Dan Carlin's three shows write into RAGDocs (Phase 30f's personal-kb NAS
# share, sibling to PodCasts above), per hermes-podcast-retriever.py 1.3.0's
# own DANCARLIN_FEEDS comment -- a separate --outputdir, so a separate
# retriever invocation (see run_retriever() / main()) rather than three more
# names on SHOWS.
DANCARLIN_OUTPUT_DIR = "/mnt/nas2-hermes-backup/RAGDocs"
DANCARLIN_SHOWS      = ["dchh", "dchha", "dccs"]

STATE_PATH = Path.home() / ".hermes" / "state" / "podcast-sync" / "missing-since.json"

EMAIL_TO      = "notifications@canislupisnc.net"
EMAIL_TO_NAME = "Fleet Notifications"

SUPPRESS_AFTER_DAYS   = 30  # only suppress a gap once it's been missing this long
RECENT_EPISODE_WINDOW = 10  # ...and only if it's also more than this many episodes old

# (show, episode) extractors for each filename pattern the retriever produces.
# The three Dan Carlin patterns below are best-effort, not exhaustive: their
# real archive's older filenames (pre-2021 Addendum episodes especially) used
# half a dozen different styles, some with no "addendum" substring at all
# (see hermes-podcast-retriever.py's own DANCARLIN_FEEDS comment) -- those
# are already downloaded, so this only matters for classifying a *future*
# failed download, and every recent real episode does contain "addendum"
# consistently. A digit-first filename that matches neither dccs nor dchha
# falls through to "dchh" (Hardcore History) as the catch-all -- safe here
# since no other show's filenames start with a bare digit. Deliberately
# integer-only (unlike the local archive's own `41.5`-style half-episode
# files) -- parse_show_episode() below does int(m.group(1)), and the live
# feeds this actually fetches from never produce a non-integer episode
# number, so there's nothing for this to ever need to match.
FILENAME_PATTERNS = [
    ("sn",    re.compile(r"^SN-(\d+)-Notes\.pdf$", re.IGNORECASE)),
    ("sn",    re.compile(r"^sn-(\d+)\.pdf$", re.IGNORECASE)),
    ("sn",    re.compile(r"^sn-(\d+)\.txt$", re.IGNORECASE)),
    ("im",    re.compile(r"^im-(\d+)\.txt$", re.IGNORECASE)),
    ("tbrh",  re.compile(r"^tbrh-(\d{8})\.json$", re.IGNORECASE)),
    ("twig",  re.compile(r"^twig-(\d+)\.txt$", re.IGNORECASE)),
    ("dccs",  re.compile(r"^(\d+)-cswdcd", re.IGNORECASE)),
    ("dchha", re.compile(r"^(\d+)-dchh.{0,3}addendum", re.IGNORECASE)),
    ("dchh",  re.compile(r"^(\d+)-", re.IGNORECASE)),
]


def parse_show_episode(filename: str):
    for show, pattern in FILENAME_PATTERNS:
        if m := pattern.match(filename):
            return show, int(m.group(1))
    return None, None


def episode_distance(show: str, latest: int, ep: int) -> int:
    """How far 'ep' is behind 'latest', in whatever unit this show's episode
    numbers actually use. SN/IM/TWIG use sequential integers, so plain
    subtraction is exact. tbrh keys episodes by publish date (YYYYMMDD)
    instead (see hermes-podcast-retriever.py's fetch_tbrh_remote_listing) --
    raw subtraction on that breaks across a month/year boundary (e.g.
    20260901 - 20260831 = 70, not 1), so it's parsed as real calendar dates
    and measured in days instead."""
    if show == "tbrh":
        try:
            d1 = date(latest // 10000, (latest // 100) % 100, latest % 100)
            d2 = date(ep // 10000, (ep // 100) % 100, ep % 100)
            return (d1 - d2).days
        except ValueError:
            return 0  # unparseable -- fail safe towards "recent" (never suppressed)
    return latest - ep


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True))


def vault_get_email_password() -> str:
    # timeout=60, not 30: vault-get-secret.sh 1.2.0 retries internally up to
    # 3x on a real transient bw/Vaultwarden failure — a 30s timeout could
    # kill it mid-recovery (same reasoning as hermes-pfsense-report.py).
    try:
        result = subprocess.run([str(VAULT_SCRIPT), "email-sintra", "password"],
                                 capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def send_email(subject: str, body: str) -> bool:
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


def run_retriever(outputdir: str, shows: list[str]) -> str:
    """Run the retriever once against one output root; returns its combined
    stdout+stderr text. Raises subprocess.TimeoutExpired/OSError on a real
    failure to run at all -- caller decides what that means for the rest of
    the sync."""
    result = subprocess.run(
        [sys.executable, str(RETRIEVER),
         "--outputdir", outputdir,
         "--shows", *shows,
         "--verbose"],
        capture_output=True,
        text=True,
        timeout=3600,
    )
    return result.stdout + result.stderr


def main() -> int:
    # A non-zero *systemd exit* means "this service is broken, go look" — the
    # thing hermes-node-health.py's "Failed units" check treats as a real,
    # standing problem (exactly the phantom-failed-unit class of bug Phase 13
    # already found and fixed once for ollama.service/hermes-gateway.service).
    # A permanently-unpublished upstream episode (e.g. SN-747, confirmed 404
    # on GRC in every format) is a genuine, expected-to-recur *content*
    # finding, not a broken tool — the sync ran correctly and already
    # reported it by email. Only an actual failure to run or to notify
    # counts as a real exit-1 tool failure here.
    #
    # Two separate retriever invocations now (PodCasts/SHOWS, then
    # RAGDocs/DANCARLIN_SHOWS — different --outputdir, so can't be one call).
    # Each is tried independently so a failure to launch one can't silently
    # swallow real results the other already produced in the same run.
    text_parts: list[str] = []
    run_errors: list[str] = []
    for label, outputdir, shows in (
        ("PodCasts (SN/IM/TBRH)", OUTPUT_DIR, SHOWS),
        ("RAGDocs (Dan Carlin)", DANCARLIN_OUTPUT_DIR, DANCARLIN_SHOWS),
    ):
        try:
            text_parts.append(run_retriever(outputdir, shows))
        except (subprocess.TimeoutExpired, OSError) as e:
            print(f"ERROR: could not run hermes-podcast-retriever.py for {label}: {e}",
                  file=sys.stderr)
            run_errors.append(label)

    if not text_parts:
        return 1  # neither invocation even ran — nothing to report or email

    text = "\n".join(text_parts)

    total_dl = 0
    raw_fails: list[str] = []
    fetch_failures: list[str] = []
    latest_episode: dict[str, int] = {}

    for line in text.splitlines():
        if m := re.search(r"Total downloaded:\s*(\d+)", line):
            # += , not = : the combined text now has one "Total downloaded"
            # summary line per retriever invocation (PodCasts, then RAGDocs) —
            # a plain assignment here would silently drop whichever ran first.
            total_dl += int(m.group(1))
        if line.strip().startswith("- "):
            raw_fails.append(line.strip()[2:])
        if m := re.match(r"LATEST_EPISODE (\w+) (\d+)", line.strip()):
            latest_episode[m.group(1)] = int(m.group(2))
        # Security-review fix: the retriever previously had no way to signal
        # "could not tell what's new" distinctly from "nothing is new," so a
        # total GRC/twit.tv outage silently produced total_dl==0 with no
        # failure recorded either — this script would return 0 and never
        # email, indistinguishable from a genuinely quiet, healthy run.
        # hermes-podcast-retriever.py now prints this line and exits 1 when
        # it can't determine a show's remote episode list at all; surfaced
        # here as its own failure category, not folded into raw_fails (which
        # is real per-file download failures, a different thing).
        if m := re.match(r"ERROR: could not determine (.+?)'s remote episode list", line.strip()):
            fetch_failures.append(m.group(1))

    today = date.today()
    state = load_state()
    real_fails: list[str] = []

    for f in raw_fails:
        show, ep = parse_show_episode(f)

        first_seen = state.get(f)
        if first_seen is None:
            first_seen = today.isoformat()
        state[f] = first_seen  # record/keep the original first-seen date
        age_days = (today - date.fromisoformat(first_seen)).days

        is_recent = (
            show is None or show not in latest_episode
            or episode_distance(show, latest_episode[show], ep) < RECENT_EPISODE_WINDOW
        )
        # Unparseable filenames or shows we have no LATEST_EPISODE marker for are
        # treated as "recent" (never auto-suppressed) — fail safe towards visibility.

        suppress = (not is_recent) and (age_days >= SUPPRESS_AFTER_DAYS)
        if not suppress:
            real_fails.append(f)

    # Drop tracking for anything that didn't fail this run (resolved, or no longer listed).
    state = {f: v for f, v in state.items() if f in raw_fails}
    save_state(state)

    if total_dl == 0 and not real_fails and not fetch_failures and not run_errors:
        return 0

    parts = []
    if total_dl:
        parts.append(f"{total_dl} new episode(s) downloaded")
    if real_fails:
        parts.append(f"{len(real_fails)} unexpected failure(s)")
    if fetch_failures:
        parts.append(f"{len(fetch_failures)} show(s) had a remote-fetch failure")
    if run_errors:
        parts.append(f"{len(run_errors)} retriever invocation(s) failed to run")

    subject = f"Podcast sync: {', '.join(parts)}"
    body_lines = [subject, f"Locations: {OUTPUT_DIR} (SN/IM/TBRH), "
                            f"{DANCARLIN_OUTPUT_DIR} (Dan Carlin)", ""]
    for f in real_fails:
        body_lines.append(f"  FAILED: {f}")
    for f in fetch_failures:
        body_lines.append(f"  FETCH FAILED: {f} — could not determine its remote "
                          "episode list this run (site unreachable?); nothing checked or downloaded for it")
    for label in run_errors:
        body_lines.append(f"  RUN FAILED: could not run the retriever for {label} at all "
                          "this run — see the service journal")
    body = "\n".join(body_lines)

    print(body)

    sent = send_email(subject, body)
    print(f"\nEmail {'sent' if sent else 'FAILED to send'} to {EMAIL_TO}")

    # real_fails/fetch_failures are content the tool already surfaced by
    # email, not a broken run — don't fail the systemd unit over them (see
    # the comment at the top of main()). A failed *send* does mean the
    # notification genuinely didn't go out, and a run_error means the
    # retriever itself couldn't be launched at all — both are real tool
    # problems worth flagging, unlike a normal in-band content finding.
    return 0 if sent and not run_errors else 1


if __name__ == "__main__":
    sys.exit(main())
