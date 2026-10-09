#!/usr/bin/env python3
# Version: 1.2.0
#
# Offline checks for hermes-fleetops-ui.py. No network, no live stores, no server bound.
#
# The fixtures are the REAL schemas, read off the live stores on 2026-10-09, because the first
# draft of this page got two of them wrong from the plan's own prose: the plan said the backlog
# could be read with `GET /tasks` (hermes-memory's /tasks is POST-only) and the benchmark history
# was assumed to be one suite with a `scores` blob per entry (it is a `suites` dict of
# `{metric, value}`). Both were caught by looking; these checks keep them caught.
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"

NL = chr(10)
FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def load(name, filename):
    import os
    os.environ.setdefault("FLEETOPS_UI_USER", "test")
    os.environ.setdefault("FLEETOPS_UI_PASSWORD", "test")
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# One real entry from /mnt/nas2-hermes-backup/.../history.jsonl, 2026-10-09.
REAL_HISTORY_ENTRY = {
    "bfcl_model_name": "Qwen/Qwen3-4B-Instruct-2507-FC",
    "date": "2026-08-24T20:07:21.966154+00:00",
    "endpoint": "http://127.0.0.1:8080/v1",
    "model_id": "TEST/deploy-verification-2026-08-24",
    "notes": "smoke test of the finished CLI, not a real capability measurement",
    "role_or_endpoint": "nano",
    "suites": {"bfcl": {"metric": "overall_acc", "value": 0.0, "raw_row": {"x": "N/A"}},
               "ifeval": {"metric": "prompt_level_strict_acc,none", "value": 0.8, "limit": 50}},
    "swebench_version": None,
}


def check_history_schema(ui):
    print("\n[benchmark history: the real schema, not the assumed one]")
    results = ui.suite_results(REAL_HISTORY_ENTRY)
    check("both suites in one entry are read, not just one",
          [n for n, _m, _v in results] == ["bfcl", "ifeval"], str(results))
    check("the score comes from `value`, the key hermes-benchmark-compare.py reads",
          dict((n, v) for n, _m, v in results) == {"bfcl": 0.0, "ifeval": 0.8}, str(results))
    check("the metric name is carried alongside it",
          dict((n, m) for n, m, _v in results)["bfcl"] == "overall_acc", str(results))
    # A 0.0 score is a real measurement and must not render as "missing"; a None is a suite that
    # was attempted and produced nothing, and must not render as a zero. The first draft's
    # `scores or {}` would have collapsed both.
    check("a genuine zero renders as a number, not as absent", ui.fmt_value(0.0) == "0")
    check("a null result says so instead of reading as zero",
          "no result" in ui.fmt_value(None), ui.fmt_value(None))
    check("an entry with no suites key yields nothing rather than raising",
          ui.suite_results({"model_id": "x"}) == [])
    check("a malformed suites value does not raise",
          ui.suite_results({"suites": "not-a-dict"}) == [])

    print("\n[the history file paths are the contract]")
    # read_history() inlines the two paths rather than importing the benchmark module. That is only
    # safe while they agree, so this asserts it against that module's own constants -- the whole
    # point of "exactly one history, never a second copy drifting from the first".
    spec = importlib.util.spec_from_file_location("bc", TOOLS / "hermes_benchmark_common.py")
    try:
        bc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bc)
    except Exception as exc:                      # pragma: no cover - import-time dependency
        check("hermes_benchmark_common is importable for the path comparison", False, str(exc))
        return
    check("the NAS history path matches hermes_benchmark_common's",
          ui.NAS_HISTORY == bc.NAS_HISTORY_PATH, f"{ui.NAS_HISTORY} vs {bc.NAS_HISTORY_PATH}")
    check("and so does the local fallback",
          ui.LOCAL_HISTORY == bc.LOCAL_HISTORY_PATH,
          f"{ui.LOCAL_HISTORY} vs {bc.LOCAL_HISTORY_PATH}")


def check_backlog(ui, tmp):
    print("\n[backlog: hermes-memory's real tables, read-only]")
    db = tmp / "memory.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, agent TEXT, topic TEXT, state TEXT,"
        " memory_ref TEXT, created_at TEXT, updated_at TEXT);"
        "CREATE TABLE turns (id INTEGER PRIMARY KEY, task_id TEXT, agent TEXT, role TEXT,"
        " raw TEXT, presented TEXT, created_at TEXT, conv_id TEXT);")
    rows = [
        ("scout:super:bcckfdn__cevher-test-10-lc-it-4-GGUF", "model-scout", "text", "proposed"),
        ("scout:muse:some__model-v2", "model-scout", "text", "approved"),
        ("scout:dispatch:other__thing", "model-scout", "text", "rejected"),
        ("selfrepair:something-else", "self-repair", "code", "proposed"),
    ]
    for i, (tid, agent, topic, state) in enumerate(rows):
        conn.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)",
                     (tid, agent, topic, state, None, "1791542000.0", f"179154{2500 - i}.0"))
    conn.execute("INSERT INTO turns (task_id, agent, role, raw, created_at) VALUES (?,?,?,?,?)",
                 (rows[0][0], "model-scout", "scout",
                  json.dumps({"advisory_narrative": "", "category": "text",
                              "fit": "size unknown (no safetensors metadata)"}), "1791542493.05"))
    conn.execute("INSERT INTO turns (task_id, agent, role, raw, created_at) VALUES (?,?,?,?,?)",
                 (rows[1][0], "model-scout", "scout",
                  json.dumps({"advisory_narrative": "Worth a run: beats the incumbent on its own "
                                                    "published evals.", "category": "text",
                              "fit": "fits in 24GB at Q4"}), "1791542494.0"))
    conn.execute("INSERT INTO turns (task_id, agent, role, raw, created_at) VALUES (?,?,?,?,?)",
                 (rows[2][0], "model-scout", "scout", "{not json", "1791542495.0"))
    conn.commit()
    conn.close()

    ui.MEMORY_DB = str(db)
    tasks, detail = ui.read_backlog()
    check("only the scout's own tasks are listed", len(tasks) == 3, str([t["id"] for t in tasks]))
    check("another agent's task is not shown",
          all("selfrepair" not in t["id"] for t in tasks))
    check("the newest-updated task is first", tasks[0]["id"] == rows[0][0], tasks[0]["id"])
    check("a turn whose raw will not parse yields {} rather than raising",
          detail[rows[2][0]] == {}, str(detail[rows[2][0]]))
    check("the advisory narrative is read off the latest turn",
          detail[rows[1][0]]["advisory_narrative"].startswith("Worth a run"))

    print("\n[the task id encodes role and model, and is decoded for display]")
    role, model = ui.split_task_id("scout:super:bcckfdn__cevher-test-10-lc-it-4-GGUF")
    check("the role is recovered", role == "super", role)
    check("and `__` becomes `/` again", model == "bcckfdn/cevher-test-10-lc-it-4-GGUF", model)
    check("a model id containing a colon survives the split",
          ui.split_task_id("scout:coder:org__repo:tag") == ("coder", "org/repo:tag"),
          str(ui.split_task_id("scout:coder:org__repo:tag")))
    check("an id in some other shape is shown whole rather than mangled",
          ui.split_task_id("something-else") == ("", "something-else"))

    print("\n[rendering the backlog]")
    html = ui.render_backlog()
    check("the empty advisory is called out rather than left blank",
          "none recorded" in html)
    check("an approved row offers a copy-command button", "copy command" in html)
    check("a proposed row does not", html.count("copy command") == 1, str(html.count("copy")))
    check("and the page states why there are no decide buttons",
          "No decide buttons, by design" in html)
    check("the button only writes to the clipboard — no fetch, no form, no navigation",
          "clipboard.writeText" in html and "fetch(" not in html and "<form" not in html)

    print("\n[the store is opened read-only]")
    ro = ui.ro_sqlite(db)
    try:
        ro.execute("INSERT INTO tasks VALUES ('x','model-scout','t','proposed',NULL,'0','0')")
        check("a write through this service's own connection is refused", False, "it succeeded")
    except sqlite3.OperationalError as exc:
        check("a write through this service's own connection is refused", "readonly" in str(exc),
              str(exc))
    finally:
        ro.close()
    missing = tmp / "not-there.db"
    try:
        ui.ro_sqlite(missing)
        check("a missing store raises instead of being created empty", False, "no error")
    except sqlite3.OperationalError:
        check("a missing store raises instead of being created empty", not missing.exists())


def check_highlights(ui, tmp):
    print("\n[topic highlights: S27's reshaped table]")
    db = tmp / "vectors.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        "CREATE TABLE news_digest_daily (id INTEGER PRIMARY KEY, digest_date TEXT NOT NULL,"
        " topic TEXT NOT NULL, rank INTEGER NOT NULL, summary_line TEXT NOT NULL,"
        " citation TEXT, created_at TEXT NOT NULL)")
    for rank in range(1, 31):
        conn.execute("INSERT INTO news_digest_daily "
                     "(digest_date, topic, rank, summary_line, citation, created_at) "
                     "VALUES (?,?,?,?,?,?)",
                     ("2026-10-09", "Ransomware/malware trends", rank,
                      f"Highlight number {rank}", "The Hacker News", "now"))
    conn.execute("INSERT INTO news_digest_daily "
                 "(digest_date, topic, rank, summary_line, citation, created_at) "
                 "VALUES (?,?,?,?,?,?)",
                 ("2026-10-08", "Novel AI model launches", 1, "An older day's line", "arXiv",
                  "then"))
    conn.commit()
    conn.close()
    ui.RAG_DB = str(db)

    check("days are listed newest first",
          ui.read_highlight_days() == ["2026-10-09", "2026-10-08"],
          str(ui.read_highlight_days()))
    rows = ui.read_highlights("Ransomware/malware trends", "2026-10-09")
    check("every stored rank is readable, not just the emailed top 20",
          len(rows) == 30 and rows[-1]["rank"] == 30, f"{len(rows)} rows")
    check("ranks come back in order", [r["rank"] for r in rows] == list(range(1, 31)))
    check("filtering by day only still works", len(ui.read_highlights("", "2026-10-08")) == 1)
    check("and an unfiltered read spans days", len(ui.read_highlights("", "")) == 31)

    print("\n[rendering highlights]")
    html = ui.render_highlights("Ransomware/malware trends", "2026-10-09")
    check("a rank past the email cap is rendered", "Highlight number 30" in html)
    check("the page says that is the point of these rows",
          "what these rows are stored for" in html)

    # An empty table must say WHY it might be empty -- on 2026-10-09 it was empty because the
    # digest's own DELETE was wiping it daily (S27g), not because no news had been found.
    empty_db = tmp / "empty.db"
    c2 = sqlite3.connect(empty_db)
    c2.executescript("CREATE TABLE news_digest_daily (id INTEGER PRIMARY KEY, digest_date TEXT,"
                     " topic TEXT, rank INTEGER, summary_line TEXT, citation TEXT,"
                     " created_at TEXT)")
    c2.commit()
    c2.close()
    ui.RAG_DB = str(empty_db)
    empty = ui.render_highlights("", "")
    check("an empty table explains itself instead of rendering a blank page",
          "No highlights are stored at all" in empty)
    check("and points at the journal that says which cause it is",
          "hermes-news-digest-daily.service" in empty)


def check_models(ui):
    print(NL + "[models: the router's own fields, rendered as fields]")
    # The live shape, read off spark's router 2026-10-09. The first draft dumped everything but id
    # and owned_by into one JSON cell, which is not what S21c asks for -- "which checkpoint backs
    # each role, where it physically runs, whether it's abliterated" are three separate questions.
    live = [
        {"id": "super", "object": "model", "owned_by": "hermes-router",
         "backend_url": "http://127.0.0.1:8095", "on_demand": True,
         "checkpoint": "Huihui-GLM-4.7-Flash-abliterated", "abliterated": True},
        {"id": "coder", "object": "model", "owned_by": "hermes-router",
         "backend_url": "http://10.129.1.17:8094", "on_demand": True,
         "checkpoint": "Qwen3-Coder-30B", "abliterated": False},
        {"id": "mystery", "object": "model", "owned_by": "hermes-router",
         "backend_url": "", "something_new": 7},
    ]
    ui.read_router_models = lambda: live
    html = ui.render_models()
    check("the checkpoint gets its own column", "Huihui-GLM-4.7-Flash-abliterated" in html)
    check("abliterated weights are named, not shown as a bare true",
          ">abliterated<" in html and ">true<" not in html)
    check("stock weights are named too", ">stock<" in html)
    check("a role the router said nothing about is 'not stated', not 'stock'",
          "not stated" in html)
    check("a remote role shows the host actually serving it", ">10.129.1.17<" in html)
    check("and a loopback backend is called out as this host", "this host" in html)
    check("residency is rendered in words", "on demand" in html and "resident" in html)
    check("a field the router grows later is still shown, not silently dropped",
          "something_new" in html)
    check("host_of tolerates a malformed backend url", ui.host_of("not a url") == "not a url"
          or ui.host_of("not a url") == "", ui.host_of("not a url"))
    check("and an empty one", ui.host_of("") == "" and ui.host_of(None) == "")

def check_escaping(ui):
    print("\n[everything rendered is escaped]")
    # Not decoration: these pages show Hugging Face repo ids and advisory text derived from model
    # cards (anyone can publish a repo saying anything) plus LLM-written digest lines.
    nasty = '<img src=x onerror="alert(1)">'
    check("markup in a value is escaped", "<img" not in ui.esc(nasty), ui.esc(nasty))
    check("quotes are escaped too, so attribute context is safe",
          '"' not in ui.esc('a "b" c'), ui.esc('a "b" c'))
    check("None renders empty rather than as the string None", ui.esc(None) == "")
    check("the page shell escapes its own title",
          b"<script>" not in ui.shell("<script>x</script>", "body"))


def check_degradation(ui):
    print("\n[each source fails on its own]")
    def boom():
        raise RuntimeError("the NAS is not mounted")
    out = ui.section("A heading", "a note", boom)
    check("a failing section renders an error instead of propagating",
          "This section is unavailable" in out)
    check("the error names the failure so the operator knows which store it was",
          "the NAS is not mounted" in out and "RuntimeError" in out)
    check("and says the other sections are unaffected", "independent of it" in out)
    check("a working section is unaffected by a sibling's failure",
          "<td>ok</td>" in ui.section("h", "", lambda: ui.table(["c"], [["ok"]])))

    print("\n[timestamps arrive in more than one format]")
    check("a float epoch renders", ui.when("1791542493.05").startswith("20"),
          ui.when("1791542493.05"))
    check("an ISO-8601 string with an offset renders",
          ui.when("2026-08-24T20:07:21.966154+00:00").startswith("2026-08-2"),
          ui.when("2026-08-24T20:07:21.966154+00:00"))
    check("milliseconds are recognised rather than read as the year 58000",
          ui.when(1791542493051).startswith("20"), ui.when(1791542493051))
    check("an empty timestamp is blank, not an error", ui.when(None) == "")
    check("an unparseable timestamp is shown as given", ui.when("whenever") == "whenever")


def check_no_write_surface(ui):
    print("\n[no write surface, by construction]")
    src = (TOOLS / "hermes-fleetops-ui.py").read_text(encoding="utf-8")
    check("the handler defines no do_POST", "def do_POST" not in src)
    check("nor do_PUT or do_DELETE", "def do_PUT" not in src and "def do_DELETE" not in src)
    check("every sqlite connection goes through the read-only helper",
          src.count("sqlite3.connect(") == 1 and "mode=ro" in src)
    check("auth is compared with hmac.compare_digest, not ==",
          "hmac.compare_digest" in src)
    check("the service refuses to start unauthenticated",
          "must not run unauthenticated" in src)
    check("and refuses a wildcard bind",
          'if BIND in ("0.0.0.0", "::", "")' in src)
    check("/health is the only route served before auth",
            src.index('parsed.path == "/health"') < src.index("if not self._authed()"))


def check_unit_sandbox():
    print(NL + "[the unit's sandbox is pinned, so the one exception cannot widen]")
    # The first real start forced exactly one writable path: usage.db is WAL, and a read-only
    # SQLite connection still takes a read mark in its -shm sidecar. That is a real requirement,
    # but it is also the kind of grant that grows by accident, so the shape is asserted here.
    unit = (Path(__file__).resolve().parents[1] / "hermes-fleetops-ui.service").read_text(
        encoding="utf-8")
    rw = [l.split("=", 1)[1].strip() for l in unit.splitlines()
          if l.startswith("ReadWritePaths=")]
    check("there is exactly one ReadWritePaths line", len(rw) == 1, str(rw))
    check("and it grants only the state directory",
          rw == ["/home/pmoney/.hermes/state"], str(rw))
    # The grant must never reach the stores themselves, which is where the approval state lives:
    # memory.db's task states say whether a candidate is approved, and they are under /mnt.
    granted = rw[0].split()
    check("the grant is a single path, not a list that has grown", len(granted) == 1, str(granted))
    check("it does not reach /mnt, where memory.db and vectors.db live",
          not any(g.startswith("/mnt") for g in granted), str(granted))
    check("nor /etc, nor the repo itself",
          not any(g.startswith("/etc") or "HermesAgentV5" in g for g in granted), str(granted))
    check("nor the whole home directory",
          not any(g.rstrip("/") in ("/home/pmoney", "/home") for g in granted), str(granted))
    for prop in ("ProtectSystem=strict", "ProtectHome=read-only", "NoNewPrivileges=true",
                 "PrivateTmp=true"):
        check(f"{prop} is still set", prop in unit)
    check("the unit explains why the exception exists, not just that it does",
          "WAL" in unit and "-shm" in unit)
    check("and records that it confers no approval authority",
          "memory.db" in unit and "read-only" in unit)

def main():
    import tempfile
    ui = load("fleetopsui", "hermes-fleetops-ui.py")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        check_history_schema(ui)
        check_backlog(ui, tmp)
        check_highlights(ui, tmp)
        check_models(ui)
        check_escaping(ui)
        check_degradation(ui)
        check_no_write_surface(ui)
        check_unit_sandbox()

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
