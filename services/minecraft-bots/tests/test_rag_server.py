#!/usr/bin/env python3
# Version: 1.0.0
#
# Unit checks for tools/hermes-minecraft-rag-server.py (spark2's RAG lookup): auth, path
# confinement, write/read round-trip, search passthrough, and coalesced ingest. Runs the server
# in-process on 127.0.0.1 against a temp memory root, with stand-in search/ingest scripts.
#   python3 services/minecraft-bots/tests/test_rag_server.py
#
# Revision History: 1.0.0 | 2026-09-25 | Initial checks.
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
work = Path(tempfile.mkdtemp())
os.environ["MC_MEMORY_ROOT"] = str(work / "mem")
(work / "mem").mkdir()
spec = importlib.util.spec_from_file_location("ragserver", REPO / "tools" / "hermes-minecraft-rag-server.py")
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)
srv.log = lambda msg: None

fake_search = work / "search.py"
fake_search.write_text("import json,sys\nprint(json.dumps([{'text': sys.argv[1], 'source_path': 'a.md', "
                       "'distance': 0.1, 'corpus': sys.argv[sys.argv.index('--corpus') + 1]}]))\n")
ingest_log = work / "ingests.log"
fake_ingest = work / "ingest.py"
fake_ingest.write_text(f"import sys,time\ntime.sleep(0.5)\nopen({str(ingest_log)!r},'a').write(sys.argv[-1]+'\\n')\n")
srv.PYTHON, srv.SEARCH_SCRIPT, srv.INGEST_SCRIPT, srv.TOKEN = sys.executable, str(fake_search), str(fake_ingest), "tok"

server = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_address[1]}"


def call(op, body, token="tok"):
    req = urllib.request.Request(f"{BASE}/{op}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


passed = 0


def check(name, fn):
    global passed
    fn()
    passed += 1
    print(f"PASS: {name}")


def auth():
    assert call("read", {"path": "world/x.md"}, token="wrong")[0] == 401


def confinement():
    for bad in ["../x.md", "world/../../etc/passwd.md", "skills/a.txt", "bots/Bad Name/x.md",
                "/etc/passwd.md", "world/sub/x.md", "models/x.json"]:
        status, _ = call("write", {"path": bad, "content": "x"})
        assert status == 400, f"{bad} -> {status}"
    assert not any((work / "mem").parent.glob("x.md"))


def roundtrip():
    assert call("write", {"path": "world/1-oak-log.md", "content": "oak here\n"}) == (200, {"ok": True})
    assert call("read", {"path": "world/1-oak-log.md"}) == (200, {"content": "oak here\n"})
    assert call("write", {"path": "skills/craft-table.json", "content": '{"name":"t"}'})[0] == 200
    assert call("write", {"path": "bots/bob/2-note.md", "content": "hi"})[0] == 200
    assert (work / "mem" / "bots" / "bob" / "2-note.md").read_text() == "hi"
    assert call("read", {"path": "world/missing.md"})[0] == 404


def search():
    status, body = call("search", {"query": "where is oak", "corpus": "minecraft-skills", "top_k": 2})
    assert status == 200 and body["results"][0]["text"] == "where is oak"
    assert body["results"][0]["corpus"] == "minecraft-skills"
    assert call("search", {"query": "x", "corpus": "podcasts"})[0] == 400, "only Minecraft corpora"


def ingest_coalesced():
    for _ in range(5):
        assert call("ingest", {"corpus": "minecraft"}) == (200, {"queued": True})
    time.sleep(2.5)
    runs = ingest_log.read_text().split() if ingest_log.exists() else []
    assert 1 <= len(runs) <= 2, f"5 requests coalesced into {len(runs)} run(s)"


check("rejects a wrong token", auth)
check("paths stay inside world/, bots/<name>/, skills/ as .md/.json", confinement)
check("write then read round-trips; missing file is 404", roundtrip)
check("search passes through to the corpus script; non-Minecraft corpora refused", search)
check("a burst of ingest requests runs at most twice", ingest_coalesced)
server.shutdown()
print(f"{passed} rag-server checks passed.")
