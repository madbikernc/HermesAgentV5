#!/usr/bin/env python3
# Version: 1.3.0
#
# Unit checks for tools/hermes-minecraft-triage.py (review MB-18/MB-19): classification of real bot
# log lines, per-bot/per-signature dedupe with recurrence counts, and a full diagnosis queue that
# never blocks the reader. Stdlib only; no journalctl, network or model calls.
#   python3 services/minecraft-bots/tests/test_triage.py      (tests/run.sh unit runs it too)
#
# Revision History: 1.0.0 | 2026-09-25 | Initial checks for MB-18/MB-19.
#                   1.1.0 | 2026-11-13 | A queued incident carries that bot's recent log lines (triage 1.8.0).
#                   1.2.0 | 2026-11-13 | No Buzz token: exit for systemd to retry, never run blind (triage 1.8.1).
#                   1.3.0 | 2026-11-13 | A backend outage is its own category, published without a model diagnosis (triage 1.9.0).
import importlib.util
import os
import queue
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
os.environ.setdefault("TRIAGE_EVENTS_PATH", str(Path(tempfile.mkdtemp()) / "events.jsonl"))
os.environ.setdefault("TRIAGE_LOG_PATH", str(Path(tempfile.mkdtemp()) / "triage.log"))
spec = importlib.util.spec_from_file_location("triage", REPO / "tools" / "hermes-minecraft-triage.py")
triage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(triage)
triage.log = lambda msg: None

passed = 0


def check(name, fn):
    global passed
    fn()
    passed += 1
    print(f"PASS: {name}")


def classification():
    cases = {
        "TypeError: x is not a function": "crash",
        "[Amy] REJECTED DONE (claimed furnace done, but...)": "rejected-done",
        "[Mark] self-defense result: gave up on the fight -- took too long. (ok=false)": "combat-timeout",
        '[Amy] OUTCOME {"type":"mine","ok":false,"cancelled":false,"refused":false,"ms":5}': "action-not-ok",
        '[Amy] OUTCOME {"type":"mine","ok":false,"cancelled":true,"refused":false,"ms":5}': None,
        '[Amy] OUTCOME {"type":"mine","ok":true,"cancelled":false,"refused":false,"ms":5}': None,
    }
    for line, want in cases.items():
        got = triage.process_message(line, "minecraft-bot-amy.service", {}, queue.Queue())
        assert got == want, f"{line!r}: {got} != {want}"


def two_bots_two_incidents():
    incidents, jobs = {}, queue.Queue()
    triage.process_message("TypeError: x is not a function", "minecraft-bot-bob.service", incidents, jobs, now=100.0)
    triage.process_message("TypeError: x is not a function", "minecraft-bot-nell.service", incidents, jobs, now=130.0)
    assert jobs.qsize() == 2, "two bots crashing within the cooldown stay two incidents"


def repeats_counted_not_rediagnosed():
    incidents, jobs = {}, queue.Queue()
    for i in range(5):
        triage.process_message(f"TypeError: y is not a function at line {i}", "minecraft-bot-wade.service",
                               incidents, jobs, now=200.0 + i)
    assert jobs.qsize() == 1, "same bot, same failure: diagnosed once inside the cooldown"
    (stats,) = incidents.values()
    assert stats["count"] == 5, "every repeat is counted (numbers normalized into one signature)"
    triage.process_message("TypeError: y is not a function at line 9", "minecraft-bot-wade.service",
                           incidents, jobs, now=200.0 + triage.COOLDOWN_S + 1)
    assert jobs.qsize() == 2, "diagnosed again once the cooldown passes"


def full_queue_does_not_block():
    incidents, jobs = {}, queue.Queue(maxsize=1)
    triage.process_message("TypeError: a", "minecraft-bot-bob.service", incidents, jobs, now=1.0)
    triage.process_message("ReferenceError: b is not defined", "minecraft-bot-bob.service", incidents, jobs, now=1.0)
    assert jobs.qsize() == 1 and len(incidents) == 2, "second incident recorded, diagnosis skipped, no block"


def events_persisted_first():
    path = Path(os.environ["TRIAGE_EVENTS_PATH"])
    before = path.read_text().count("\n") if path.exists() else 0
    triage.process_message("[Amy] REJECTED DONE (claimed chest done)", "minecraft-bot-amy.service", {}, queue.Queue())
    assert path.read_text().count("\n") == before + 1


def recent_lines_go_with_the_incident():
    incidents, jobs, recent = {}, queue.Queue(), {}
    for i in range(30):
        triage.process_message(f"[Bob] tick {i}", "minecraft-bot-bob.service", incidents, jobs, now=1.0, recent=recent)
    triage.process_message("[Nell] other bot", "minecraft-bot-nell.service", incidents, jobs, now=1.0, recent=recent)
    triage.process_message("TypeError: z is not a function", "minecraft-bot-bob.service", incidents, jobs, now=1.0, recent=recent)
    *_, context = jobs.get_nowait()
    assert len(context) == triage.CONTEXT_LINES, f"the last {triage.CONTEXT_LINES} lines, got {len(context)}"
    assert context[-1] == "[Bob] tick 29" and "TypeError" not in " ".join(context), "lines BEFORE the incident"
    assert all("[Nell]" not in l for l in context), "only that bot's own lines"


def no_token_exits_instead_of_running_blind():
    real = triage.vault_get, triage.watch_loop
    triage.vault_get = lambda item, field: ""
    triage.watch_loop = lambda token: (_ for _ in ()).throw(AssertionError("must not watch without a token"))
    try:
        triage.main()
        raise AssertionError("main() returned")
    except SystemExit as exc:
        assert exc.code and "no Buzz token" in str(exc.code), exc.code
    finally:
        triage.vault_get, triage.watch_loop = real
    assert triage.VAULT_TIMEOUT_S >= 60, "spark's vault takes 30-60s"


def backend_outage_is_not_a_bot_bug():
    unreachable = ('[Amy] goal tick failed: hermes-router muse call failed: 502 {"error": {"message": '
                   '"backend \'muse\' unreachable: <urlopen error [Errno 111] Connection refused>"}}')
    loading = '[Bob] failed to self-propose a goal: hermes-router muse call failed: 503 {"error":{"message":"Loading model"}}'
    blocked = ('[Babs] goal tick failed: hermes-router dispatch call failed: 400 {"error": {"message": '
               '"request blocked by Layer 2 guard (mode=classifier)"}}')
    for line, want in ((unreachable, "backend-outage"), (loading, "backend-outage"), (blocked, "router-failure")):
        got = triage.process_message(line, "minecraft-bot-amy.service", {}, queue.Queue())
        assert got == want, f"{line[:60]!r}: {got} != {want}"
    real = triage.call_role
    triage.call_role = lambda *a, **k: (_ for _ in ()).throw(AssertionError("no model call for an outage"))
    try:
        body = triage.triage_incident("backend-outage", "model backend unavailable", unreachable)
    finally:
        triage.call_role = real
    assert body.startswith("[backend-outage] model backend unavailable") and "source line: [Amy]" in body, body


def default_units_cover_every_bot():
    assert triage.BOT_UNITS == ["minecraft-bot-*.service"]


check("MB-18 bot log lines classify, and interruptions/refusals are not failures", classification)
check("MB-19 two bots crashing within the cooldown stay two incidents", two_bots_two_incidents)
check("MB-19 one bot's repeats are counted, diagnosed once per cooldown", repeats_counted_not_rediagnosed)
check("MB-19 a full diagnosis queue records the incident without blocking", full_queue_does_not_block)
check("MB-19 every match is persisted to the events file", events_persisted_first)
check("Self-repair: a queued incident carries that bot's own recent log lines", recent_lines_go_with_the_incident)
check("No Buzz token: triage exits for systemd to retry instead of running blind", no_token_exits_instead_of_running_blind)
check("A backend outage is published as one, without a model diagnosis", backend_outage_is_not_a_bot_bug)
check("MB-18 default units cover every minecraft-bot-* unit on the host", default_units_cover_every_bot)
print(f"{passed} triage checks passed.")
sys.exit(0)
