#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for S20's two scripts. No network, no hermes-memory, no Matrix, no model call —
# every outbound call is stubbed, so this runs anywhere Python 3 does, including off-fleet.
#
# What it covers is specifically the logic that would otherwise only fail in production:
#   * task-id encoding against hermes-memory's real TASK_ID_RE (the "/" problem)
#   * the prescribed-benchmark-label convention that makes `done` deterministic
#   * the gate's command grammar, including the self-trigger case its header claims is impossible
#   * every legal and illegal state transition, as a table
#   * the done-reconciliation date/label matching, including the weak-match path
#   * publisher model-index parsing, including base_model-as-a-list (seen live) and absent cards
#
# Run: python3 infra/hermes-model-scout/tests/test_model_scout.py
import importlib.util
import json
import re
import sys
import types
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


def load(name, filename, stub_siblings=True):
    """Import a hyphenated tool by path. The scout imports two siblings and a benchmark module at
    module scope; those are stubbed here so the test needs neither network nor /opt/llama.cpp."""
    if stub_siblings:
        scan = types.ModuleType("hermes_model_scan")
        scan.ROLE_TARGETS = {
            "text": {"tags": {"text-generation"}, "node": "Spark", "serves": "dispatch / muse / super"},
            "vision": {"tags": {"image-text-to-text"}, "node": "Spark", "serves": "omni"},
        }
        scan.MIN_PARAMS_B = 7
        scan.MIN_ENGAGEMENT = 3
        scan.HF_CALL_DELAY_S = 0.0
        scan.CODING_HINTS = re.compile(r"coder", re.I)
        scan.is_coding_model = lambda rec: bool(scan.CODING_HINTS.search(rec["id"]))
        scan.estimate_gguf_gb = lambda rec: 20.0
        scan.spark_fit = lambda rec, gb: f"~{gb}GB Q4 (dense) — fits alongside current backends"
        scan.homed13_fit = lambda rec: "text-to-image — verify manually"
        scan.has_gguf_build = lambda mid: f"someone/{mid.split('/')[-1]}-GGUF"
        scan.fetch_recent_models = lambda tags: []
        scan._sanitize_hf_text = lambda s, max_len=200: " ".join(str(s).split())[:max_len]
        scan._hf_get = lambda *a, **k: None
        sys.modules["hermes_model_scan"] = scan

        watch = types.ModuleType("hermes_model_watch")
        watch.check_arch_diff = lambda state, findings: state.setdefault("known_gap", [])
        sys.modules["hermes_model_watch"] = watch

        bc = types.ModuleType("hermes_benchmark_common")
        bc.ALL_SUITES = ["mmlu_pro", "ifeval", "bfcl"]
        bc.load_history = lambda: []
        sys.modules["hermes_benchmark_common"] = bc

    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# hermes-memory's real constraint, copied from tools/hermes-memory.py — if that regex ever changes,
# this test is where the mismatch should surface.
TASK_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def test_task_ids(scout):
    print("\n[task id encoding]")
    tid = scout.task_id_for("coder", "Qwen/Qwen3.8-Flash")
    check("a repo id with a slash produces a legal task id", bool(TASK_ID_RE.match(tid)), tid)
    check("the slash is encoded, not dropped", "__" in tid and "/" not in tid, tid)
    check("role is addressable in the id", tid.startswith("scout:coder:"), tid)
    check("same role+model is the same id (dedup is structural)",
          tid == scout.task_id_for("coder", "Qwen/Qwen3.8-Flash"))
    check("different roles give different ids",
          tid != scout.task_id_for("muse", "Qwen/Qwen3.8-Flash"))

    long_id = "org/" + ("x" * 200)
    long_tid = scout.task_id_for("coder", long_id)
    check("an over-long id is truncated into the limit", len(long_tid) <= 128, len(long_tid))
    check("the truncated id is still legal", bool(TASK_ID_RE.match(long_tid)), long_tid)
    check("truncation is deterministic", long_tid == scout.task_id_for("coder", long_id))
    other_long = "org/" + ("y" * 200)
    check("two different over-long ids do not collide",
          long_tid != scout.task_id_for("coder", other_long))

    weird = scout.task_id_for("coder", "org/model with spaces&punct!")
    check("illegal characters are replaced, not passed through",
          bool(TASK_ID_RE.match(weird)), weird)


def test_url_encoding(scout, gate):
    """Regression for the bug the live gate probe found on 2026-10-08: hermes-memory resolves
    GET /tasks/<id> as parsed.path.split("/")[2] with NO unquoting, while urllib's quote()
    escapes ":" by default. Every lookup 404'd, which silently broke dedup — an existing task read
    as absent and would have been re-proposed and re-announced daily."""
    print("\n[url encoding of task ids in paths]")
    captured = {}

    def fake_open(req, *a, **k):
        captured["url"] = req.full_url if hasattr(req, "full_url") else str(req)

        class _R:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"{}"
        return _R()

    tid = "scout:coder:Qwen__Qwen3.8-Flash"

    old = scout.urllib.request.urlopen
    scout.urllib.request.urlopen = fake_open
    try:
        scout.fetch_task(tid)
    finally:
        scout.urllib.request.urlopen = old
    check("scout: the colon is NOT percent-encoded in the path",
          "%3A" not in captured["url"], captured["url"])
    check("scout: the raw id appears in the path", tid in captured["url"], captured["url"])

    captured.clear()
    old = gate.urllib.request.urlopen
    gate.urllib.request.urlopen = fake_open
    try:
        gate.fetch_task(tid)
    finally:
        gate.urllib.request.urlopen = old
    check("gate: the colon is NOT percent-encoded in the path",
          "%3A" not in captured["url"], captured["url"])
    check("gate: the raw id appears in the path", tid in captured["url"], captured["url"])


def test_benchmark_label(scout):
    print("\n[prescribed benchmark label]")
    check("the label is the HF repo id verbatim (fleet convention)",
          scout.benchmark_label_for("Qwen/Qwen3.8-Flash") == "Qwen/Qwen3.8-Flash")
    check("it is not slugified", "/" in scout.benchmark_label_for("org/name"))


def test_gate_grammar(gate):
    print("\n[gate command grammar]")
    for verb in ("benchmark", "defer", "reject", "override"):
        m = gate.COMMAND_RE.match(f"{verb} scout:coder:Qwen__Qwen3.8-Flash")
        check(f"{verb!r} parses", bool(m))
    check("case-insensitive verb", bool(gate.COMMAND_RE.match("BENCHMARK scout:x:y")))
    check("leading/trailing space tolerated", bool(gate.COMMAND_RE.match("  defer scout:x:y  ")))
    check("unknown verb refused", gate.COMMAND_RE.match("approve scout:x:y") is None)
    check("self-repair's verbs are not claimed by this gate",
          gate.COMMAND_RE.match("promote abc123") is None
          and gate.COMMAND_RE.match("skip abc123") is None)
    check("extra text refused (no partial match)",
          gate.COMMAND_RE.match("benchmark scout:x:y please") is None)
    check("two ids refused", gate.COMMAND_RE.match("benchmark a b") is None)
    check("bare verb refused", gate.COMMAND_RE.match("benchmark") is None)

    # The header claims this gate's own replies can never re-match as a command. That is a
    # property of the grammar, so it is testable rather than a promise.
    facts = {"model_id": "Qwen/Qwen3.8-Flash",
             "prescribed_benchmark_label": "Qwen/Qwen3.8-Flash",
             "gguf_repo": "someone/Qwen3.8-Flash-GGUF"}
    reply = gate.approval_reply("scout:coder:Qwen__Qwen3.8-Flash", facts)
    check("the gate's own approval reply does not re-match its grammar",
          gate.COMMAND_RE.match(reply) is None)
    check("the approval reply names candidate mode, not a nonexistent --repo flag",
          "--candidate" in reply and "--repo " not in reply)
    check("the approval reply prescribes the exact --model-id",
          "--model-id Qwen/Qwen3.8-Flash" in reply)
    check("the approval reply says the label is load-bearing for done",
          "not done" in reply)
    check("the approval reply names the found GGUF",
          "someone/Qwen3.8-Flash-GGUF" in reply)

    no_gguf = gate.approval_reply("scout:coder:x", dict(facts, gguf_repo=None))
    check("with no GGUF, the reply says conversion is the real first step",
          "nothing llama.cpp can load" in no_gguf)
    missing = gate.approval_reply("scout:coder:x", {})
    check("a task with no candidate record gets a refusal, not a guessed command",
          "missing" in missing and "--candidate" not in missing)


def test_transitions(gate):
    print("\n[state transitions]")
    legal = [
        ("benchmark", "proposed", "approved"),
        ("benchmark", "deferred", "approved"),
        ("defer", "proposed", "deferred"),
        ("reject", "proposed", "rejected"),
        ("reject", "deferred", "rejected"),
        ("override", "rejected", "proposed"),
    ]
    for action, frm, to in legal:
        allowed, result = gate.TRANSITIONS[action]
        check(f"{action}: {frm} -> {to}", frm in allowed and result == to)

    illegal = [
        ("benchmark", "approved"), ("benchmark", "rejected"), ("benchmark", "done"),
        ("defer", "deferred"), ("defer", "rejected"), ("defer", "approved"),
        ("reject", "rejected"), ("reject", "done"), ("reject", "approved"),
        ("override", "proposed"), ("override", "deferred"), ("override", "done"),
        ("override", "approved"),
    ]
    for action, frm in illegal:
        allowed, _ = gate.TRANSITIONS[action]
        check(f"{action} is refused from {frm}", frm not in allowed)

    check("no verb can set done (only the scout's own history read can)",
          all(result != "done" for _, result in gate.TRANSITIONS.values()))
    check("rejected is reachable and only escapable via override",
          [a for a, (allowed, _) in gate.TRANSITIONS.items() if "rejected" in allowed] == ["override"])


def test_done_reconciliation(scout, monkey):
    print("\n[done reconciliation]")
    import datetime as dt
    approved_at = dt.datetime(2026, 10, 1, 12, 0, tzinfo=dt.timezone.utc).timestamp()
    label = "Qwen/Qwen3.8-Flash"

    state = {"written": []}
    monkey(scout, "list_scout_tasks", lambda: [
        {"id": "scout:coder:Qwen__Qwen3.8-Flash", "state": "approved", "topic": "coding",
         "updated_at": approved_at},
        {"id": "scout:muse:Other__Model", "state": "proposed", "topic": "text",
         "updated_at": approved_at},
    ])
    monkey(scout, "task_turns", lambda tid, limit=200: [
        {"phase": "candidate", "model_id": label, "prescribed_benchmark_label": label}])
    monkey(scout, "upsert_task", lambda tid, st, topic=None: state["written"].append((tid, st)))
    monkey(scout, "write_turn", lambda *a, **k: True)
    monkey(scout, "matrix_notice", lambda text: True)

    # 1. a row well before the approval must not count (beyond the backdate slack)
    scout.bc.load_history = lambda: [{"model_id": label, "date": "2026-09-01T10:00:00+00:00"}]
    state["written"].clear()
    scout.reconcile_done()
    check("a benchmark row long before the approval does not mark done", state["written"] == [],
          state["written"])

    # 2. an exact-label row after the approval does — in the REAL on-disk format, a full ISO-8601
    # timestamp with an offset, which is what hermes_benchmark_common.py documents and writes.
    # The first live run of this path failed precisely because the code assumed YYYY-MM-DD.
    scout.bc.load_history = lambda: [{"model_id": label, "date": "2026-10-02T09:15:00+00:00",
                                      "suites": {"ifeval": {"value": 0.8, "metric": "acc"}}}]
    state["written"].clear()
    scout.reconcile_done()
    check("an exact-label ISO-timestamp row after the approval marks done",
          state["written"] == [("scout:coder:Qwen__Qwen3.8-Flash", "done")], state["written"])

    # 2b. a bare YYYY-MM-DD row still works — nothing stops a hand-written row carrying one
    scout.bc.load_history = lambda: [{"model_id": label, "date": "2026-10-02"}]
    state["written"].clear()
    scout.reconcile_done()
    check("a date-only row is still accepted",
          state["written"] == [("scout:coder:Qwen__Qwen3.8-Flash", "done")], state["written"])

    # 2c. a run a few hours BEFORE the approval counts (ran it, then replied) and is recorded as
    # backdated rather than quietly treated as if it came after
    turns = []
    real_write = scout.write_turn
    scout.write_turn = lambda tid, phase, payload: turns.append((phase, payload)) or True
    scout.bc.load_history = lambda: [{"model_id": label, "date": "2026-10-01T06:00:00+00:00"}]
    state["written"].clear()
    scout.reconcile_done()
    scout.write_turn = real_write
    done_turns = [p for ph, p in turns if ph == "done"]
    check("a run shortly before the approval still marks done",
          state["written"] == [("scout:coder:Qwen__Qwen3.8-Flash", "done")], state["written"])
    check("and the done turn records that it predates the approval",
          bool(done_turns) and done_turns[-1].get("matched_before_approval") is True,
          str(done_turns[-1:]))

    # 2d. an unparseable date is skipped, not crashed on
    scout.bc.load_history = lambda: [{"model_id": label, "date": "not a date"}]
    state["written"].clear()
    scout.reconcile_done()
    check("an unparseable history date is skipped", state["written"] == [], state["written"])

    # 3. a different model's row does not
    scout.bc.load_history = lambda: [{"model_id": "someone/unrelated-model",
                                      "date": "2026-10-02T09:15:00+00:00"}]
    state["written"].clear()
    scout.reconcile_done()
    check("an unrelated benchmark row does not mark done", state["written"] == [], state["written"])

    # 4. only approved tasks are considered
    scout.bc.load_history = lambda: [{"model_id": "Other/Model", "date": "2026-10-02"}]
    state["written"].clear()
    scout.reconcile_done()
    check("a proposed task is never marked done by a history row",
          all(tid != "scout:muse:Other__Model" for tid, _ in state["written"]), state["written"])

    # 5. an approved task with no prescribed label is left alone rather than guessed at
    monkey(scout, "task_turns", lambda tid, limit=200: [{"phase": "candidate", "model_id": label}])
    scout.bc.load_history = lambda: [{"model_id": label, "date": "2026-10-02"}]
    state["written"].clear()
    scout.reconcile_done()
    check("no prescribed label means no done transition", state["written"] == [], state["written"])


def test_history_timestamp(scout):
    print("\n[history date parsing]")
    import datetime as dt
    cases = [
        ("2026-08-24T18:32:10+00:00", "the real documented format"),
        ("2026-08-24T18:32:10Z", "a Z-suffixed timestamp"),
        ("2026-08-24T18:32:10", "a naive timestamp (assumed UTC)"),
        ("2026-08-24", "a bare date"),
    ]
    for raw, label in cases:
        ts = scout.history_timestamp({"date": raw})
        check(f"parses {label}", ts is not None, raw)
    check("a naive timestamp is read as UTC, not local",
          scout.history_timestamp({"date": "2026-08-24T18:32:10"})
          == dt.datetime(2026, 8, 24, 18, 32, 10, tzinfo=dt.timezone.utc).timestamp())
    for bad in ("", None, "not a date", "2026-13-45"):
        check(f"rejects {bad!r} without raising", scout.history_timestamp({"date": bad}) is None)


def test_publisher_claim(scout, monkey):
    print("\n[publisher claim parsing]")
    card = {
        "cardData": {
            "base_model": ["Qwen/Qwen3-0.6B-Base", "second/base"],
            "license": "apache-2.0",
            "tags": ["text-generation", "chat"],
            "model-index": [{
                "name": "m",
                "results": [{
                    "task": {"name": "Text Generation", "type": "text-generation"},
                    "dataset": {"name": "IFEval", "type": "ifeval"},
                    "metrics": [{"type": "acc", "value": 0.91}],
                }],
            }],
        },
        "safetensors": {"total": 30_000_000_000},
    }
    monkey(scout.urllib.request, "urlopen", _fake_urlopen(card))
    claim = scout.publisher_claim("org/model")
    check("base_model as a list is normalized to a string",
          isinstance(claim["base_model"], str) and "Qwen/Qwen3-0.6B-Base" in claim["base_model"])
    check("model-index presence is recorded", claim["model_index_present"] is True)
    check("a declared eval is captured with its value",
          claim["evals"] and claim["evals"][0]["value"] == 0.91, claim["evals"])
    check("the declared param count is captured", claim["declared_params"] == 30_000_000_000)
    check("license is captured", claim["license"] == "apache-2.0")

    monkey(scout.urllib.request, "urlopen", _fake_urlopen({"cardData": {}}))
    empty = scout.publisher_claim("org/bare")
    check("an empty card degrades to 'no publisher claim', not a negative signal",
          empty["model_index_present"] is False and empty["evals"] == [])

    monkey(scout.urllib.request, "urlopen", _fake_urlopen({"cardData": {"base_model": "single/str"}}))
    single = scout.publisher_claim("org/single")
    check("base_model as a bare string also works", single["base_model"] == "single/str")

    def boom(*a, **k):
        raise OSError("network down")
    monkey(scout.urllib.request, "urlopen", boom)
    failed = scout.publisher_claim("org/unreachable")
    check("a card fetch failure returns an empty claim instead of raising",
          failed["model_index_present"] is False)


def test_offer_and_roles(scout, monkey):
    print("\n[offer text and role mapping]")
    rec = {"model_id": "Qwen/Qwen3.8-Flash", "category": "coding", "roles": ["coder"],
           "fit": "~20GB Q4 (dense) — fits alongside current backends",
           "gguf_repo": None,
           "incumbent": {"checkpoint": "Qwen3.8-27B-abliterated"},
           "incumbent_scores": {"ifeval": {"value": 0.77, "metric": "acc"}},
           "publisher_claim": {"model_index_present": False}}
    text = scout.offer_text("scout:coder:Qwen__Qwen3.8-Flash", rec)
    check("the offer states all three reply verbs",
          all(v in text for v in ("benchmark scout:", "defer scout:", "reject scout:")))
    check("the offer names the incumbent", "Qwen3.8-27B-abliterated" in text)
    check("the offer labels a missing publisher claim honestly", "none published" in text)
    check("the offer warns when no GGUF exists", "llama.cpp likely cannot serve it" in text)
    check("the offer shows the fleet's own prior measurement", "0.77" in text)

    check("embed/rerank have no router-visible role to compare against",
          scout.CATEGORY_TO_ROLES["embedding"] == [] and scout.CATEGORY_TO_ROLES["reranking"] == [])
    check("asr/tts/media likewise have no router-visible role",
          all(scout.CATEGORY_TO_ROLES[c] == [] for c in ("asr", "tts", "media")))
    check("coding maps to both coder backends",
          scout.CATEGORY_TO_ROLES["coding"] == ["coder", "coder2"])
    check("text maps to the three text roles",
          set(scout.CATEGORY_TO_ROLES["text"]) == {"dispatch", "muse", "super"})

    monkey(scout.urllib.request, "urlopen", _fake_urlopen({"data": [
        {"id": "coder", "checkpoint": "X", "abliterated": True, "on_demand": True,
         "backend_url": "http://x"}]}))
    roles = scout.router_roles()
    check("router_roles reads the live /v1/models shape", roles.get("coder", {}).get("checkpoint") == "X")

    def boom(*a, **k):
        raise OSError("router down")
    monkey(scout.urllib.request, "urlopen", boom)
    check("an unreachable router degrades to an empty role map, not a crash",
          scout.router_roles() == {})


def _fake_urlopen(payload):
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps(payload).encode()

    def _open(*args, **kwargs):
        return _Resp()
    return _open


def main():
    saved = []

    def monkey(obj, name, value):
        saved.append((obj, name, getattr(obj, name, None)))
        setattr(obj, name, value)

    scout = load("scout_under_test", "hermes-model-scout.py")
    gate = load("gate_under_test", "hermes-model-scout-gate.py", stub_siblings=False)

    test_task_ids(scout)
    test_benchmark_label(scout)
    test_url_encoding(scout, gate)
    test_gate_grammar(gate)
    test_transitions(gate)
    test_history_timestamp(scout)
    test_done_reconciliation(scout, monkey)
    test_publisher_claim(scout, monkey)
    test_offer_and_roles(scout, monkey)

    for obj, name, old in reversed(saved):
        if old is not None:
            setattr(obj, name, old)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
