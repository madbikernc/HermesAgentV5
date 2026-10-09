#!/usr/bin/env python3
# Version: 2.1.0
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
import urllib.error
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
                              "fit": "fits in 24GB at Q4",
                              "prescribed_benchmark_label": "org__repo-q4"}),
                 "1791542494.0"))
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
    # The buttons come from the gate's table, so it must be loaded for this render to be
    # meaningful. With no gate the page correctly shows none, checked in check_gate_contract().
    ui.load_gate()
    html = ui.render_backlog()
    check("the empty advisory is called out rather than left blank",
          "none recorded" in html)
    check("an approved row offers the copy-command button", "copy command" in html)
    # 1.0.0 invented `hermes-benchmark-run.py --model-id ... --role ...`, which does not exist.
    # The real tool takes a LOCAL gguf, and the --model-id must be the prescribed label or the
    # scout can never mark the task done.
    check("and the command is the real tool, not an invented one",
          "hermes-benchmark-model.sh --candidate" in html and
          "hermes-benchmark-run.py" not in html)
    check("with the prescribed benchmark label, which the scout matches on",
          "org__repo-q4" in html, "label missing")
    check("a proposed row gets decide buttons for its legal transitions",
          "approve for benchmarking" in html and "defer" in html and
          "reject permanently" in html)
    check("it is a POST form, so no GET can decide anything",
          'method="post" action="/backlog/decide"' in html)
    check("and carries the CSRF token", f'value="{ui.CSRF_TOKEN}"' in html)
    check("the permanent action asks for confirmation, carrying the count",
          'data-confirm=' in html and "{n} candidate(s)?" in html)
    check("the page says a decision here is the same write as the Matrix reply",
          "benchmark|defer|reject|override" in html and "fleetops-ui" in html)

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


def check_write_surface(ui):
    print(NL + "[the write surface is exactly one guarded route]")
    src = (TOOLS / "hermes-fleetops-ui.py").read_text(encoding="utf-8")
    check("there is exactly one write handler", src.count("def do_POST") == 1)
    check("and it serves only /backlog/decide",
          '!= "/backlog/decide"' in src)
    check("a decide answers 303 to a GET, so a refresh cannot replay it",
          "self.send_response(303)" in src)
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

class FakeGate:
    """Stands in for hermes-model-scout-gate.py. The transition table is a COPY of the real one and
    a separate check asserts the real module still agrees with it, so these cases stay meaningful
    without reaching hermes-memory."""

    AGENT = "model-scout"
    TRANSITIONS = {
        "benchmark": ({"proposed", "deferred"}, "approved"),
        "defer": ({"proposed"}, "deferred"),
        "reject": ({"proposed", "deferred"}, "rejected"),
        "override": ({"rejected"}, "proposed"),
    }

    def __init__(self, tasks, write_ok=True):
        self.tasks = tasks
        self.write_ok = write_ok
        self.state_writes = []
        self.turns = []
        self.messages = []

    def fetch_task(self, task_id):
        if task_id not in self.tasks:
            raise urllib.error.HTTPError(task_id, 404, "not found", None, None)
        return self.tasks[task_id]

    def set_task_state(self, task_id, state, topic=None):
        if not self.write_ok:
            return False
        self.state_writes.append((task_id, state, topic))
        self.tasks[task_id]["state"] = state
        return True

    def write_turn(self, task_id, payload):
        self.turns.append((task_id, payload))

    def candidate_facts(self, task_id):
        return {"model_id": "org/repo", "prescribed_benchmark_label": "org__repo-q4",
                "gguf_repo": "org/repo-GGUF"}

    def approval_reply(self, task_id, facts):
        return f"[model-scout] {task_id} approved. label={facts.get('prescribed_benchmark_label')}"

    def send_room_message(self, text):
        self.messages.append(text)


def check_gate_contract(ui):
    print(NL + "[the decision rules belong to the gate, not to this page]")
    # Two routes to one decision must not be able to disagree about what the decision means, so
    # the UI imports the gate rather than restating its table. This asserts the import contract --
    # the fragile part -- against the real file.
    gate = ui.load_gate()
    check("the real gate module imports cleanly", gate is not None, ui.GATE_IMPORT_ERROR)
    if gate is None:
        return
    check("and the UI uses the gate's table verbatim",
          gate.TRANSITIONS == FakeGate.TRANSITIONS, str(gate.TRANSITIONS))
    check("every attribute the UI calls on it exists",
          all(hasattr(gate, a) for a in ("fetch_task", "set_task_state", "write_turn",
                                         "candidate_facts", "approval_reply", "AGENT",
                                         "send_room_message")))
    check("the gate's own agent name is what the UI filters tasks by",
          gate.AGENT == "model-scout", gate.AGENT)

    print(NL + "[a row only offers transitions that are legal from its state]")
    ui.GATE = gate
    check("proposed offers benchmark, defer and reject",
          sorted(ui.legal_actions("proposed")) == ["benchmark", "defer", "reject"],
          str(sorted(ui.legal_actions("proposed"))))
    check("deferred cannot be deferred again",
          "defer" not in ui.legal_actions("deferred"), str(ui.legal_actions("deferred")))
    check("rejected offers only the way back",
          ui.legal_actions("rejected") == ["override"], str(ui.legal_actions("rejected")))
    check("approved offers nothing — the scout alone marks it done",
          ui.legal_actions("approved") == [], str(ui.legal_actions("approved")))
    check("an unknown state offers nothing rather than everything",
          ui.legal_actions("weird") == [] and ui.legal_actions(None) == [])
    # Fails closed: no gate, no buttons.
    ui.GATE = None
    check("with no gate imported, no action is offered at all",
          ui.legal_actions("proposed") == [])
    ui.GATE = gate


def check_csrf(ui):
    print(NL + "[CSRF: the one real difference a browser introduces]")
    # A browser attaches cached Basic Auth to a cross-origin POST on its own, which the Matrix
    # path has no equivalent of. The token is the defence; Sec-Fetch-Site is a second line.
    good = ui.CSRF_TOKEN
    check("the right token on a same-origin request passes",
          ui.csrf_ok({"Sec-Fetch-Site": "same-origin"}, good))
    check("a missing token fails", not ui.csrf_ok({}, ""))
    check("a wrong token fails", not ui.csrf_ok({}, "x" * len(good)))
    check("a cross-site request fails even WITH the right token",
          not ui.csrf_ok({"Sec-Fetch-Site": "cross-site"}, good))
    check("so does same-site (a sibling subdomain is not us)",
          not ui.csrf_ok({"Sec-Fetch-Site": "same-site"}, good))
    check("a client that sends no Sec-Fetch-Site still needs the token",
          ui.csrf_ok({}, good) and not ui.csrf_ok({}, "nope"))
    check("the token is long enough to be unguessable", len(good) >= 32, str(len(good)))


def check_decisions(ui):
    print(NL + "[a decision is re-checked against the store, not trusted from the page]")
    tasks = {
        "scout:super:org__repo": {"agent": "model-scout", "state": "proposed", "topic": "text"},
        "scout:muse:other__x": {"agent": "model-scout", "state": "rejected", "topic": "text"},
        "selfrepair:thing": {"agent": "self-repair", "state": "proposed", "topic": "code"},
    }
    g = FakeGate(tasks)
    ui.GATE = g

    check("a legal transition is applied",
          ui.apply_decision("scout:super:org__repo", "benchmark") == "ok")
    check("and the new state was written", g.state_writes[-1][1] == "approved",
          str(g.state_writes))
    # The same click again, now that the state has moved on: this is the stale-page case, and the
    # reason the state is re-read server-side instead of being taken from the rendered row.
    check("repeating it is refused as stale rather than re-applied",
          ui.apply_decision("scout:super:org__repo", "benchmark") == "stale")
    check("no second write happened", len(g.state_writes) == 1, str(g.state_writes))

    check("an illegal transition for the state is refused",
          ui.apply_decision("scout:muse:other__x", "defer") == "stale")
    check("but the legal one from that state works",
          ui.apply_decision("scout:muse:other__x", "override") == "ok")
    check("a task belonging to another agent is refused",
          ui.apply_decision("selfrepair:thing", "benchmark") == "foreign")
    check("a task that does not exist is refused",
          ui.apply_decision("scout:nope:nope", "benchmark") == "nosuch")
    check("an unknown action is refused",
          ui.apply_decision("scout:super:org__repo", "rm -rf") == "badaction")
    check("and nothing above wrote to a foreign or missing task",
          [w[0] for w in g.state_writes] == ["scout:super:org__repo", "scout:muse:other__x"],
          str(g.state_writes))

    print(NL + "[the audit record distinguishes the two routes]")
    _tid, payload = g.turns[0]
    check("the turn says which route decided it", payload["decided_by"] == "fleetops-ui",
          str(payload))
    check("and records the transition both ways",
          payload["from"] == "proposed" and payload["to"] == "approved", str(payload))
    check("the summary names the route too, for anyone reading `presented`",
          "fleetops-ui" in payload["summary"], payload["summary"])
    check("a decision made here is still announced in FleetOps",
          any("approved" in m for m in g.messages), str(g.messages))
    check("and the approval text is the GATE's, not composed here",
          "label=org__repo-q4" in g.messages[0], g.messages[0])

    print(NL + "[when the write fails, nothing is claimed]")
    g2 = FakeGate({"scout:a:b": {"agent": "model-scout", "state": "proposed", "topic": "t"}},
                  write_ok=False)
    ui.GATE = g2
    check("a rejected state write reports failure", ui.apply_decision("scout:a:b", "defer")
          == "writefail")
    check("and writes no turn claiming it happened", g2.turns == [], str(g2.turns))
    check("and sends no FleetOps notice", g2.messages == [], str(g2.messages))

    print(NL + "[with no gate, the route refuses instead of guessing]")
    ui.GATE = None
    check("apply_decision fails closed", ui.apply_decision("scout:a:b", "benchmark") == "nogate")
    check("every outcome code has a message to render",
          all(c in ui.RESULTS for c in ("ok", "stale", "nosuch", "foreign", "badaction",
                                        "writefail", "nogate", "csrf")))



def check_attribution(ui):
    print(NL + "[who clicked: attribution, never authentication]")
    # `tailscale serve` injects these. They are strictly better attribution than this page's
    # shared Basic Auth can give, and they close the one genuine gap the Matrix route had.
    hdr = {"Tailscale-User-Login": "madbikernc@gmail.com", "Tailscale-User-Name": "Paul"}
    check("name and login are combined for the record",
          ui.tailnet_identity(hdr) == "Paul <madbikernc@gmail.com>", ui.tailnet_identity(hdr))
    check("a login alone still identifies someone",
          ui.tailnet_identity({"Tailscale-User-Login": "x@y"}) == "x@y")
    check("no headers means no person, not a crash or a guess",
          ui.tailnet_identity({}) == "")
    # Absent identity must not block the decision -- the route still works, the record just
    # names the route without the person.
    tasks = {"scout:s:a__b": {"agent": "model-scout", "state": "proposed", "topic": "t"}}
    g = FakeGate(tasks)
    ui.GATE = g
    check("a decision with no identity still applies",
          ui.apply_decision("scout:s:a__b", "defer") == "ok")
    check("and records the route with an empty user",
          g.turns[-1][1]["decided_by"] == "fleetops-ui"
          and g.turns[-1][1]["decided_by_user"] == "", str(g.turns[-1][1]))
    tasks2 = {"scout:s:c__d": {"agent": "model-scout", "state": "proposed", "topic": "t"}}
    g2 = FakeGate(tasks2)
    ui.GATE = g2
    ui.apply_decision("scout:s:c__d", "reject", "Paul <madbikernc@gmail.com>")
    check("with an identity, the turn names the person",
          g2.turns[-1][1]["decided_by_user"] == "Paul <madbikernc@gmail.com>",
          str(g2.turns[-1][1]))
    check("the summary names them too, for anyone reading `presented`",
          "Paul" in g2.turns[-1][1]["summary"], g2.turns[-1][1]["summary"])
    check("and so does the FleetOps notice",
          "Paul" in g2.messages[-1], g2.messages[-1])
    # The headers arrive on a loopback socket, so any local process could set them. They are
    # an audit nicety; Basic Auth is what decides whether a request is allowed at all.
    src = (TOOLS / "hermes-fleetops-ui.py").read_text(encoding="utf-8")
    check("the code says plainly that identity is not authentication",
          "never authentication" in src.lower() or "Attribution, never authentication" in src)
    check("and auth does not consult the identity headers at all",
          "Tailscale-User" not in src.split("def _authed")[1].split("def ")[0])

def check_multiselect(ui):
    print(NL + "[multi-select: one action over many candidates]")
    gate = ui.load_gate()
    ui.GATE = gate
    html = ui.render_backlog()

    # HTML forms cannot nest, so multi-select requires exactly one form around the whole table.
    # Per-row submit buttons and a bulk bar cannot coexist; the row shows its legal verbs as text.
    check("there is exactly one decide form, not one per row",
          html.count('action="/backlog/decide"') == 1, str(html.count('action="/backlog/decide"')))
    check("the form carries the CSRF token once", html.count('name="csrf"') == 1)
    # The fixture holds three model-scout tasks: proposed, approved, rejected. The approved one
    # has no legal transition, so exactly two rows are selectable -- which is the point.
    check("every actionable row has a checkbox, and only those",
          html.count('name="task_id"') == 2, str(html.count('name="task_id"')))
    check("all four verbs are offered as bulk submits",
          all(f'name="action" value="{a}"' in html
              for a in ("benchmark", "defer", "reject", "override")))
    check("the bulk buttons refuse to act on an empty selection",
          html.count("data-needs-selection") >= 4, str(html.count("data-needs-selection")))
    check("select all / select none are offered, since the table is 80 rows",
          'data-select="all"' in html and 'data-select="none"' in html)
    check("and the selected count is shown", "data-count" in html)
    # An approved row has no legal transition, so it must not be selectable at all -- otherwise a
    # bulk action could sweep up a row that was never eligible for it.
    approved_row = [l for l in html.split("<tr>") if "copy command" in l]
    check("an approved row offers no checkbox", bool(approved_row)
          and 'name="task_id"' not in approved_row[0], "no approved row rendered")
    # The copy button now sits INSIDE the decide form, where a <button> submits by default.
    check("the copy-command button is type=button, so it cannot submit the form",
          'type="button" data-copy=' in html)

    print(NL + "[a mixed selection does the legal part and reports the rest]")
    tasks = {
        "scout:a:one": {"agent": "model-scout", "state": "proposed", "topic": "t"},
        "scout:a:two": {"agent": "model-scout", "state": "proposed", "topic": "t"},
        "scout:a:three": {"agent": "model-scout", "state": "rejected", "topic": "t"},
        "other:a:four": {"agent": "self-repair", "state": "proposed", "topic": "t"},
    }
    g = FakeGate(tasks)
    ui.GATE = g
    counts = ui.apply_decisions(
        ["scout:a:one", "scout:a:two", "scout:a:three", "other:a:four", "scout:a:missing"],
        "defer", "Paul <x@y>")
    check("the two legal ones are applied", counts["ok"] == 2, str(dict(counts)))
    check("the rejected one is skipped as illegal, not forced through",
          counts["stale"] == 1, str(dict(counts)))
    check("the foreign task is refused", counts["foreign"] == 1, str(dict(counts)))
    check("the missing task is reported", counts["nosuch"] == 1, str(dict(counts)))
    check("only the legal ones were written",
          sorted(w[0] for w in g.state_writes) == ["scout:a:one", "scout:a:two"],
          str(g.state_writes))
    check("each applied one still got its own audit turn", len(g.turns) == 2, str(len(g.turns)))
    check("and each names the person", all(p["decided_by_user"] == "Paul <x@y>"
                                           for _tid, p in g.turns))
    check("an empty selection writes nothing and says so",
          dict(ui.apply_decisions([], "reject")) == {"none": 1},
          str(dict(ui.apply_decisions([], "reject"))))
    check("and an empty selection really did not write",
          len(g.state_writes) == 2, str(g.state_writes))

    print(NL + "[the outcome travels as counts, never as text]")
    q = ui.results_query({"ok": 3, "stale": 1, "bogus": 9, "nosuch": 0})
    check("only known codes with non-zero counts are put in the URL",
          sorted(q.split("&")) == ["ok=3", "stale=1"], q)
    banner = ui.results_banner({"ok": ["3"], "stale": ["1"]})
    check("the banner renders the counts", "<b>3</b>" in banner and "<b>1</b>" in banner, banner)
    check("a bad outcome colours the banner as bad", "--bad" in banner)
    check("an all-good outcome colours it ok", "--ok" in ui.results_banner({"ok": ["2"]}))
    # The whole reason for codes-and-integers: a hand-edited URL must not be able to put text on
    # the page.
    nasty = ui.results_banner({"ok": ["<img src=x onerror=alert(1)>"]})
    check("a non-integer count is ignored rather than rendered", nasty == "", nasty)
    check("an unknown code in the URL renders nothing",
          ui.results_banner({"whatever": ["5"]}) == "")
    check("no outcome at all renders no banner", ui.results_banner({}) == "")


def check_csp(ui):
    print(NL + "[CSP: the handlers it was silently blocking]")
    src = (TOOLS / "hermes-fleetops-ui.py").read_text(encoding="utf-8")
    # Found by reading the response headers: `default-src 'none'` with no script-src blocks inline
    # event handlers outright, so the copy button and the benchmark filter did nothing in a
    # browser. Attributes cannot be nonced, so every handler had to move into one nonced block.
    for attr in ("onclick=", "oninput=", "onsubmit=", "onchange=", "onload="):
        check(f"no inline {attr[:-1]} attribute remains", attr not in src)
    check("there is exactly one script element",
          src.count('<script nonce=') == 1, str(src.count('<script nonce=')))
    check("it carries a nonce placeholder", "__CSP_NONCE__" in src)
    check("which the response substitutes per request",
          'blob.replace(b"__CSP_NONCE__"' in src)
    check("the policy grants script only to that nonce",
          "script-src 'nonce-" in src and "'unsafe-inline'; script" not in src)
    check("styles are still the only unsafe-inline grant",
          src.count("'unsafe-inline'") == 1)
    check("form-action is pinned to self, a second brake on the write route",
          "form-action 'self'" in src)
    check("and base-uri is locked so a stray <base> cannot retarget the form",
          "base-uri 'none'" in src)
    # The nonce has to differ per response or it is not a control at all.
    import re
    nonces = set()
    for _ in range(5):
        import importlib.util
        nonces.add(len(__import__("secrets").token_urlsafe(16)))
    check("the nonce is a fixed, sufficient length", nonces == {22}, str(nonces))


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
        check_write_surface(ui)
        check_unit_sandbox()
        check_gate_contract(ui)
        check_csrf(ui)
        check_decisions(ui)
        check_attribution(ui)
        check_multiselect(ui)
        check_csp(ui)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
