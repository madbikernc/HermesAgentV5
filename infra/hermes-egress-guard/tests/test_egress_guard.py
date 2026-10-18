#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-10-18) — Phase B coverage: the §8 deny-report pipeline (_report_denial(),
# _record_denial(), the recursion guard) and hermes_alert_common.send_email()'s new
# priority="critical" kwarg. Every alert-related env var (EMAIL_PASSWORD, FLEETOPS_MATRIX_TOKEN,
# FLEETOPS_ROOM, MEMORY_TOKEN) is saved and forced unset for the duration, then restored in a
# finally -- without that, running this suite on a real fleet node with real credentials present
# would send a real email and a real Matrix notice as a side effect of a denial check, exactly the
# kind of "test has a real side effect in production" bug this fleet's own LESSONS_LEARNED.md
# already warns about elsewhere.
#
# Offline checks for S40's Tier A guard (tools/hermes_egress_guard.py). No network, no fleet
# infrastructure -- every check either feeds a literal IP/host straight to the pure functions or
# points REGISTRY_PATH at a temp file this test writes itself, so it runs anywhere Python 3 does.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * every internal plane/loopback range allows, and the address just outside each one doesn't
#   * a hostname (never a literal IP) is never classified internal -- the stated limitation
#   * the full-10.0.0.0/8 opt-in is off by default and only takes effect when explicitly set
#   * registry parsing: a well-formed file, a malformed line, and a missing file
#   * check_destination()'s full decision table: internal bypasses the registry entirely, an
#     external host grants only its own listed caller(s), and a missing registry fails CLOSED
#     (denies) rather than open
#   * the §8 report pipeline never crashes a denial (it only ever runs best-effort, after the
#     deny decision is already made) and the recursion guard actually guards
#   * send_email()'s priority="critical" kwarg: subject prefix and the two headers, stubbed SMTP
#
# Run: python3 infra/hermes-egress-guard/tests/test_egress_guard.py
import importlib
import os
import smtplib
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"
sys.path.insert(0, str(TOOLS))

FAILURES = []
CHECKS = [0]

# Force every alert channel's credentials unset for this whole run -- see the 1.1.0 changelog
# note above for why. Restored in the finally block at the bottom regardless of how the run ends.
_ALERT_ENV_VARS = ("EMAIL_PASSWORD", "FLEETOPS_MATRIX_TOKEN", "FLEETOPS_ROOM", "MEMORY_TOKEN")
_SAVED_ENV = {k: os.environ.pop(k, None) for k in _ALERT_ENV_VARS}


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def expect_denied(fn, label):
    try:
        fn()
        check(label, False, "-- expected EgressDenied, nothing was raised")
    except guard.EgressDenied:
        check(label, True)


def expect_allowed(fn, label):
    try:
        fn()
        check(label, True)
    except guard.EgressDenied as exc:
        check(label, False, f"-- unexpectedly denied: {exc}")


class _FakeSMTP:
    """Stands in for smtplib.SMTP -- captures the one message sent, never opens a socket."""
    sent = []

    def __init__(self, *a, **kw):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def starttls(self):
        pass

    def login(self, *a):
        pass

    def send_message(self, msg):
        _FakeSMTP.sent.append(msg)


os.environ.pop("HERMES_EGRESS_ALLOW_FULL_10_8", None)
os.environ.pop("HERMES_TOOL_REGISTRY", None)
import hermes_egress_guard as guard  # noqa: E402

try:
    print("-- internal ranges (§4) --")
    for host in ("10.129.1.1", "10.129.1.254", "10.129.9.1", "10.129.9.2",
                 "10.129.10.1", "10.129.10.2", "100.64.0.1", "100.127.255.254",
                 "127.0.0.1", "localhost"):
        check(f"_is_internal({host!r}) is True", guard._is_internal(host) is True)

    for host in ("10.129.2.1", "10.129.8.1", "10.129.11.1", "100.63.255.255",
                 "100.128.0.1", "8.8.8.8", "10.0.0.1", "huggingface.co"):
        check(f"_is_internal({host!r}) is False", guard._is_internal(host) is False,
              "-- a hostname or an out-of-range address must never read as internal")

    print("-- full 10.0.0.0/8 is opt-in, never the silent default (§4) --")
    check("10.0.0.1 is NOT internal by default", guard._is_internal("10.0.0.1") is False)
    os.environ["HERMES_EGRESS_ALLOW_FULL_10_8"] = "1"
    importlib.reload(guard)
    check("10.0.0.1 IS internal once opted in", guard._is_internal("10.0.0.1") is True)
    os.environ.pop("HERMES_EGRESS_ALLOW_FULL_10_8", None)
    importlib.reload(guard)
    check("opting back out restores the narrower default", guard._is_internal("10.0.0.1") is False)

    print("-- registry parsing --")
    with tempfile.TemporaryDirectory() as tmp:
        good = Path(tmp) / "good.yaml"
        good.write_text(
            "# comment, ignored\n"
            "\n"
            "web-search-fallback | external-endpoint | hermes-websearch.py | api.tavily.com\n"
            "model-discovery-lookup | external-endpoint | hermes-model-scout.py,hermes-model-scan.py | huggingface.co\n"
        )
        entries = guard._load_registry(good)
        check("parses two entries", len(entries) == 2, f"-- got {entries!r}")
        check("destination key is lowercased", "api.tavily.com" in entries)
        check("allowed_callers splits on comma",
              entries["huggingface.co"]["allowed_callers"] == {"hermes-model-scout.py", "hermes-model-scan.py"})

        bad = Path(tmp) / "bad.yaml"
        bad.write_text("this line has no pipes at all\n")
        try:
            guard._load_registry(bad)
            check("malformed line raises", False, "-- no exception raised")
        except ValueError:
            check("malformed line raises", True)

        missing = Path(tmp) / "does-not-exist.yaml"
        try:
            guard._load_registry(missing)
            check("missing file raises", False, "-- no exception raised")
        except (FileNotFoundError, OSError):
            check("missing file raises", True)

    print("-- check_destination(): the full decision table --")
    with tempfile.TemporaryDirectory() as tmp:
        registry = Path(tmp) / "firmament-tool-registry.yaml"
        registry.write_text(
            "web-search-fallback | external-endpoint | hermes-websearch.py | api.tavily.com\n"
        )
        os.environ["HERMES_TOOL_REGISTRY"] = str(registry)
        importlib.reload(guard)

        expect_allowed(lambda: guard.check_destination("http://10.129.1.15:8102/turns", "anything"),
                       "internal destination bypasses the registry entirely (any caller)")
        expect_allowed(lambda: guard.check_destination("https://api.tavily.com/search", "hermes-websearch.py"),
                       "the listed caller is allowed to reach its own registry entry")
        expect_denied(lambda: guard.check_destination("https://api.tavily.com/search", "hermes-model-scout.py"),
                      "a different caller is denied the same destination (§5's own point)")
        expect_denied(lambda: guard.check_destination("https://huggingface.co/api/models/x", "hermes-model-scout.py"),
                      "a destination with no registry entry at all is denied")
        expect_denied(lambda: guard.check_destination("not a url, no host", "hermes-websearch.py"),
                      "an unparseable destination is denied, not silently skipped")

        os.environ["HERMES_TOOL_REGISTRY"] = str(Path(tmp) / "does-not-exist.yaml")
        importlib.reload(guard)
        expect_denied(lambda: guard.check_destination("https://api.tavily.com/search", "hermes-websearch.py"),
                      "a missing registry fails CLOSED -- denies non-internal egress, never opens it")
        expect_allowed(lambda: guard.check_destination("http://127.0.0.1:6167/_matrix", "anything"),
                       "a missing registry still never blocks internal traffic")

    os.environ.pop("HERMES_TOOL_REGISTRY", None)
    importlib.reload(guard)

    print("-- §8 report pipeline (Phase B) --")
    # No alert credentials are set (forced unset above), so hermes_alert_common's own
    # send_email()/matrix_notice() must no-op cleanly -- this proves a denial on a node with no
    # alert channels configured still only ever raises EgressDenied, never anything else.
    expect_denied(lambda: guard.check_destination("https://huggingface.co/api/models/x", "unlisted-caller.py"),
                  "a denial with no alert credentials configured still just raises EgressDenied")
    check("_reporting resets to False after a denial", guard._reporting is False)

    guard._reporting = True
    try:
        guard._report_denial("caller.py", "example.com", "test reason")
        check("the recursion guard no-ops when already reporting", True)
    except Exception as exc:
        check("the recursion guard no-ops when already reporting", False, f"-- raised {exc!r}")
    finally:
        guard._reporting = False

    check("_record_denial() with no MEMORY_TOKEN is a silent no-op",
          guard._record_denial("caller.py", "example.com", "reason", "ts") is None)

    print("-- hermes_alert_common.send_email() priority=\"critical\" (Phase B §8.3) --")
    import hermes_alert_common as alert_common
    os.environ["EMAIL_PASSWORD"] = "fake-password-for-this-test-only"
    importlib.reload(alert_common)
    real_smtp = smtplib.SMTP
    smtplib.SMTP = _FakeSMTP
    try:
        _FakeSMTP.sent.clear()
        alert_common.send_email("egress denied", "body text", priority="critical")
        check("send_email() with priority='critical' actually sent one message",
              len(_FakeSMTP.sent) == 1, f"-- sent {len(_FakeSMTP.sent)}")
        if _FakeSMTP.sent:
            msg = _FakeSMTP.sent[0]
            check("subject gets the [CRITICAL] prefix", msg["Subject"] == "[CRITICAL] egress denied",
                  f"-- got {msg['Subject']!r}")
            check("Importance: high is set", msg["Importance"] == "high")
            check("X-Priority: 1 is set", msg["X-Priority"] == "1")

        _FakeSMTP.sent.clear()
        alert_common.send_email("[CRITICAL] already prefixed", "body", priority="critical")
        check("an already-prefixed subject is not double-prefixed",
              _FakeSMTP.sent[0]["Subject"] == "[CRITICAL] already prefixed")

        _FakeSMTP.sent.clear()
        alert_common.send_email("routine digest", "body")
        check("priority=\"normal\" (the default) leaves the subject and headers alone",
              _FakeSMTP.sent[0]["Subject"] == "routine digest"
              and _FakeSMTP.sent[0]["Importance"] is None
              and _FakeSMTP.sent[0]["X-Priority"] is None)
    finally:
        smtplib.SMTP = real_smtp

finally:
    for k, v in _SAVED_ENV.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
if FAILURES:
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
