#!/usr/bin/env python3
# Version: 1.0.0
#
# 1.0.0 (2026-10-16) - S32 item (c): offline checks that a topic hermes-news-digest.py could
# NOT check (search or summarization raised) renders and exits distinctly from a topic that
# was checked and genuinely had nothing new. Before this fix both collapsed to the same "0
# highlights" shape -- which is exactly how the 2026-10-11 outage's broker 503s read as
# "0/6 topic(s) had news, 0 failed" on 2026-10-12. No network, no real model: cmd_daily() runs
# for real against an in-memory sqlite connection, same spirit as test_relevance_gate.py's
# check_storage(), with hermes_rag_common stubbed so no router/model call is reachable.
import contextlib
import importlib.util
import io
import sqlite3
import sys
import types
import urllib.error
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def load_digest(search_impl):
    """Same stubbing approach as test_relevance_gate.py's load_digest(), with `search` wired to
    the caller's fixture instead of a no-op -- that's the one call this suite needs to control.
    `connect` returns a real in-memory sqlite3 connection (with an empty `chunks` table, since
    cmd_daily()'s cursor-advance query at the end of a non-dry-run reads it) so cmd_daily()'s own
    SQL runs for real, same spirit as test_relevance_gate.py's store_fixture(). `send_email` is
    stubbed to print-and-succeed instead of touching vault/SMTP."""
    def _connect(*a, **k):
        c = sqlite3.connect(":memory:")
        c.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY)")
        return c

    rag = types.ModuleType("hermes_rag_common")
    rag.connect = _connect
    rag.search = search_impl
    rag.get_state = lambda *a, **k: 0  # skips the "first run" branch's own `chunks` table read
    rag.set_state = lambda *a, **k: None
    rag.embed = lambda *a, **k: None
    rag.router_chat = lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("router_chat must not be called — both fixture topics have empty matches"))
    rag.sanitize_llm_input = lambda s, n=4000: s
    sys.modules["hermes_rag_common"] = rag
    spec = importlib.util.spec_from_file_location("digest_err", TOOLS / "hermes-news-digest.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["digest_err"] = mod
    spec.loader.exec_module(mod)
    mod.send_email = lambda subject, body: (print(f"[would email] {subject}\n{body}"), True)[1]
    return mod


class Args:
    dry_run = False


ERRORED_TOPIC = "Errored topic (broker down)"
QUIET_TOPIC = "Quiet topic (checked, nothing new)"


def search_fixture(topic, **kwargs):
    if topic == ERRORED_TOPIC:
        raise urllib.error.URLError("[Errno 111] Connection refused")
    return []  # QUIET_TOPIC: checked, genuinely nothing new


def main():
    print("\n[render_topic_body distinguishes errored from quiet, directly]")
    d = load_digest(search_fixture)
    quiet_body = d.render_topic_body("t", "2026-10-16", [])
    errored_body = d.render_topic_body("t", "2026-10-16", [], errored=True,
                                        error_msg="[Errno 111] Connection refused")
    check("a quiet topic's body says nothing new", "nothing new" in quiet_body.lower())
    check("an errored topic's body does NOT say nothing new",
          "nothing new" not in errored_body.lower(), errored_body)
    check("an errored topic's body names the failure",
          "COULD NOT CHECK" in errored_body and "Connection refused" in errored_body, errored_body)

    print("\n[cmd_daily distinguishes them end to end, same shape as the 2026-10-11/12 incident]")
    d.load_topics = lambda: [ERRORED_TOPIC, QUIET_TOPIC]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = d.cmd_daily(Args())
    out = buf.getvalue()

    check("the run exits non-zero because one topic errored", rc == 1, f"rc={rc}")
    check("the errored topic's emailed body says COULD NOT CHECK",
          "COULD NOT CHECK" in out, out)
    check("the quiet topic's emailed body still says nothing new",
          "nothing new" in out, out)
    check("the per-topic log line says ERRORED for the broken topic",
          f"{ERRORED_TOPIC}: ERRORED" in out, out)
    check("the per-topic log line still reports highlight count for the quiet topic",
          f"{QUIET_TOPIC}: 0 highlight(s)" in out, out)
    check("the run summary reports the errored count, not just 'failed' email deliveries",
          "1 errored (could not check)" in out, out)
    check("the run summary does not misreport the errored topic as a failed email send",
          "0 failed" in out, out)

    print("\n[a clean run with no errors still exits 0]")
    d2 = load_digest(lambda topic, **k: [])
    d2.load_topics = lambda: [QUIET_TOPIC]
    buf2 = io.StringIO()
    with contextlib.redirect_stdout(buf2):
        rc2 = d2.cmd_daily(Args())
    check("no errored topics means exit 0", rc2 == 0, f"rc={rc2}")
    check("and the summary says 0 errored", "0 errored (could not check)" in buf2.getvalue())

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
