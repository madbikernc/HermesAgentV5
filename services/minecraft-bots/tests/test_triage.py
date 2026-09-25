#!/usr/bin/env python3
# Version: 1.0.0
#
# Unit checks for tools/hermes-minecraft-triage.py (review MB-18/MB-19): classification of real bot
# log lines, per-bot/per-signature dedupe with recurrence counts, and a full diagnosis queue that
# never blocks the reader. Stdlib only; no journalctl, network or model calls.
#   python3 services/minecraft-bots/tests/test_triage.py      (tests/run.sh unit runs it too)
#
# Revision History: 1.0.0 | 2026-09-25 | Initial checks for MB-18/MB-19.
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


def default_units_cover_every_bot():
    assert triage.BOT_UNITS == ["minecraft-bot-*.service"]


check("MB-18 bot log lines classify, and interruptions/refusals are not failures", classification)
check("MB-19 two bots crashing within the cooldown stay two incidents", two_bots_two_incidents)
check("MB-19 one bot's repeats are counted, diagnosed once per cooldown", repeats_counted_not_rediagnosed)
check("MB-19 a full diagnosis queue records the incident without blocking", full_queue_does_not_block)
check("MB-19 every match is persisted to the events file", events_persisted_first)
check("MB-18 default units cover every minecraft-bot-* unit on the host", default_units_cover_every_bot)
print(f"{passed} triage checks passed.")
sys.exit(0)
