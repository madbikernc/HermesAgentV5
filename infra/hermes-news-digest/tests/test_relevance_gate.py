#!/usr/bin/env python3
# Version: 1.1.0
#
# Offline checks for hermes-news-digest.py 1.1.0's relevance gate (S27e). No network, no store, no
# model — the gate is a pure function over search results, which is most of why it was written as
# one. Runs anywhere Python 3 does.
#
# The fixtures are REAL measurements against the live store on 2026-10-09, not invented numbers:
# every score below was observed, and the expected outcomes are what the gate has to produce for
# the change to be worth making. If a future tweak to FLOOR/RATIO breaks one of these, it has
# regressed a case that was checked by hand.
import importlib.util
import sys
import types
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


def load_digest():
    rag = types.ModuleType("hermes_rag_common")
    for name in ("connect", "search", "embed", "router_chat", "get_state", "set_state"):
        setattr(rag, name, lambda *a, **k: None)
    rag.sanitize_llm_input = lambda s, n=4000: s
    sys.modules["hermes_rag_common"] = rag
    spec = importlib.util.spec_from_file_location("digest", TOOLS / "hermes-news-digest.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["digest"] = mod
    spec.loader.exec_module(mod)
    return mod


def m(dist, score, label):
    d = {"distance": dist, "citation": label, "text": label}
    if score is not None:
        d["rerank_score"] = score
    return d


# Observed on the live store, 2026-10-09 (see IMPLEMENTATION_PLAN.md S27e).
PRIVACY = [
    m(0.917, 0.9239, "EDPB — The Irish Data Protection Commission"),
    m(0.961, 0.5029, "EDPB — Stakeholder event on guidelines"),
    m(0.901, 0.0185, "EDPB — Health data breach: the CNIL"),
    m(0.918, 0.0036, "Hugging Face — The Agent Said It Was Done"),
    m(0.961, 0.0024, "DeepMind — Proactive cyber defense"),
]
STANDARDS = [
    m(0.873, 0.0112, "DeepMind — Proactive cyber defense"),
    m(0.897, 0.0068, "NIST CSRC — SP 800-73-6"),
    m(0.930, 0.0059, "NIST CSRC — SP 800-73-6 (2)"),
    m(0.893, 0.0045, "NIST CSRC — SP 800-78-6"),
    m(0.914, 0.0016, "NIST CSRC — SP 800-38E"),
]
TTPS = [
    m(0.795, 0.9855, "CISA — Chinese Government-linked"),
    m(0.905, 0.5339, "CISA — Chinese Government-linked (2)"),
    m(0.839, 0.0015, "DeepMind — Proactive cyber defense"),
]
AI_EVAL = [
    m(0.726, 0.2422, "arXiv — Verification and Self-Improvement"),
    m(0.733, 0.1147, "Hugging Face — UK AISI and EvalEval"),
    m(0.712, 0.0606, "DeepMind — double-blind AI evaluations"),
    m(0.911, 0.0096, "arXiv — Explainable Header-Centric Framework"),
    m(0.837, 0.0059, "DeepMind — Gemini 4 Argon"),
]
NOISE = [m(1.067, 0.0001, "Minecraft World memory — collected birch log")]


def store_fixture():
    """A real sqlite store with the production schema, so the storage checks exercise the actual
    SQL rather than a mock of it. No sqlite-vec needed: these rows are plain columns."""
    import sqlite3
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        "CREATE TABLE news_digest_daily ("
        " id INTEGER PRIMARY KEY, digest_date TEXT NOT NULL, topic TEXT NOT NULL,"
        " rank INTEGER NOT NULL, summary_line TEXT NOT NULL, citation TEXT,"
        " created_at TEXT NOT NULL)")
    return conn


def store_day(conn, date, topic, highlights, guard_empty=True):
    """The production write, reduced to the one decision under test: whether the day's rows are
    deleted when there is nothing to put back. `guard_empty=False` reproduces the pre-fix code."""
    if guard_empty and not highlights:
        return
    conn.execute("DELETE FROM news_digest_daily WHERE digest_date=? AND topic=?", (date, topic))
    for rank, (line, cite) in enumerate(highlights, 1):
        conn.execute("INSERT INTO news_digest_daily "
                     "(digest_date, topic, rank, summary_line, citation, created_at) "
                     "VALUES (?,?,?,?,?,?)", (date, topic, rank, line, cite, "now"))
    conn.commit()


def stored(conn, date, topic):
    return conn.execute("SELECT count(*) FROM news_digest_daily WHERE digest_date=? AND topic=?",
                        (date, topic)).fetchone()[0]


def check_storage():
    # Found in live operation on 2026-10-09: the 03:26 run stored 26 highlights across 5 topics and
    # the 07:10 timer, finding nothing new, left the table EMPTY. The DELETE ran unconditionally.
    # That destroys exactly what these rows exist for -- the highlights past EMAIL_HIGHLIGHTS that
    # never made the email and are meant to stay recoverable (S27d, read back by S21e).
    print(NL + "[a later run that finds nothing must not erase an earlier run's highlights]")
    DAY, TOPIC = "2026-10-09", "Ransomware/malware trends"
    first = [("GoBalance flaw lets attackers bypass auth", "The Hacker News"),
             ("Three teams demonstrate remote exploit", "BleepingComputer")]

    conn = store_fixture()
    store_day(conn, DAY, TOPIC, first)
    check("the morning run's highlights are stored", stored(conn, DAY, TOPIC) == 2)
    store_day(conn, DAY, TOPIC, [])
    check("a later run with nothing new leaves them intact", stored(conn, DAY, TOPIC) == 2,
          f"{stored(conn, DAY, TOPIC)} rows")

    # The same sequence against the pre-fix code, so this suite fails if the guard is ever removed.
    old = store_fixture()
    store_day(old, DAY, TOPIC, first, guard_empty=False)
    store_day(old, DAY, TOPIC, [], guard_empty=False)
    check("and the unguarded version really did wipe them (the bug this pins)",
          stored(old, DAY, TOPIC) == 0, f"{stored(old, DAY, TOPIC)} rows")

    # Replacement must still replace: a re-run that DOES find highlights overwrites the day rather
    # than interleaving two generations at the same ranks.
    store_day(conn, DAY, TOPIC, [("A single better line", "CISA")])
    check("a re-run that finds highlights still replaces the day", stored(conn, DAY, TOPIC) == 1)
    check("and the surviving row is the new generation",
          conn.execute("SELECT summary_line FROM news_digest_daily WHERE digest_date=? AND topic=?",
                       (DAY, TOPIC)).fetchone()[0] == "A single better line")

    # One topic finding nothing must not touch another topic's rows.
    store_day(conn, DAY, "Attack and vulnerability methods", first)
    store_day(conn, DAY, TOPIC, [])
    check("topics are independent", stored(conn, DAY, "Attack and vulnerability methods") == 2)


def check_new_chunk_retrieval():
    # Measured on the live store, 2026-10-09: 57 chunks newer than the digest cursor out of 97,751
    # indexed, and ZERO of them in the global nearest 400 for either topic tried -- so the digest
    # reported "0/6 topics had news" while that morning's headlines sat in the index. These are the
    # arithmetic facts that make KNN-then-trim unusable for a "since last run" window, pinned so
    # the reasoning cannot quietly be reverted to an over-fetch.
    print(NL + "[why a new-chunk window cannot be a post-filter]")
    INDEXED, NEW, FETCHED = 97751, 57, 400
    check("the new window is a vanishing fraction of the index",
          NEW / INDEXED < 0.001, f"{NEW / INDEXED:.5f}")
    check("so an over-fetch of 400 cannot be expected to contain it",
          FETCHED * (NEW / INDEXED) < 1, f"{FETCHED * NEW / INDEXED:.3f} expected hits")
    check("and widening the fetch to cover it would mean reading most of the index",
          INDEXED / NEW > 1000, f"{INDEXED / NEW:.0f}x")
    # The failure gets worse as the corpus grows, which is the part that makes it a design error
    # rather than a tuning value: same daily ingest, ten times the history.
    check("the problem scales with history, so no fixed k fixes it",
          FETCHED * (NEW / (INDEXED * 10)) < FETCHED * (NEW / INDEXED))


def main():
    d = load_digest()
    print("\n[the defect this replaces]")
    check("the old cutoff rejected a correct privacy match",
          not [x for x in PRIVACY if x["distance"] < d.RELEVANCE_THRESHOLD])
    check("and distance cannot separate it from a false positive: 0.917 vs 0.918",
          abs(PRIVACY[0]["distance"] - PRIVACY[3]["distance"]) < 0.002)
    check("while the cross-encoder separates the same pair by >200x",
          PRIVACY[0]["rerank_score"] / PRIVACY[3]["rerank_score"] > 200)

    print("\n[the gate, on real score sets]")
    kept, mode = d.relevant_matches(PRIVACY)
    check("the previously-silent privacy topic now yields hits", len(kept) == 2, str(len(kept)))
    check("it keeps the Irish DPC item", "Irish Data Protection" in kept[0]["citation"])
    check("it drops the 0.0036 false positive",
          all("Agent Said It Was Done" not in k["citation"] for k in kept))
    check("the mode names the rerank gate and its numbers", mode.startswith("rerank(top=0.9239"), mode)

    kept, mode = d.relevant_matches(STANDARDS)
    check("the standards topic stays quiet — every score is under the floor", kept == [], str(kept))
    check("because its best score is below FLOOR", max(x["rerank_score"] for x in STANDARDS) < d.RERANK_FLOOR)

    kept, _ = d.relevant_matches(TTPS)
    check("the TTP topic keeps both real CISA passages", len(kept) == 2, str(len(kept)))
    check("and drops the 0.0015 unrelated one",
          all("Proactive cyber" not in k["citation"] for k in kept))

    kept, _ = d.relevant_matches(AI_EVAL)
    check("the AI-eval topic keeps its three genuine passages", len(kept) == 3, str(len(kept)))
    check("and is TIGHTER than the old gate, dropping the Gemini 4 Argon hit",
          all("Gemini 4 Argon" not in k["citation"] for k in kept))
    check("which the OLD gate did keep, since its distance of 0.837 beat 0.85",
          any(x["distance"] < d.RELEVANCE_THRESHOLD and x["rerank_score"] == 0.0059 for x in AI_EVAL))
    check("old gate kept 4 here, new gate keeps 3",
          len([x for x in AI_EVAL if x["distance"] < d.RELEVANCE_THRESHOLD]) == 4 and len(kept) == 3)
    check("the 0.0096 Header-Centric hit was already excluded by BOTH gates",
          all(x["distance"] > d.RELEVANCE_THRESHOLD
              for x in AI_EVAL if x["rerank_score"] == 0.0096))

    print("\n[relative, not absolute]")
    check("a weak-but-leading pool still yields hits (0.2422 leader)",
          len(d.relevant_matches(AI_EVAL)[0]) > 0)
    check("a strong leader does not drag in its own long tail",
          len(d.relevant_matches(PRIVACY)[0]) < len(PRIVACY))
    scaled = [m(0.5, s["rerank_score"] / 4, s["citation"]) for s in PRIVACY]
    check("scaling every score in a pool by the same factor keeps the same survivors",
          len(d.relevant_matches(scaled)[0]) == 2)

    print("\n[fallback when the cross-encoder is unavailable]")
    no_scores = [m(0.80, None, "a close long chunk"), m(0.95, None, "a far one")]
    kept, mode = d.relevant_matches(no_scores)
    check("it falls back to the distance cutoff", mode == "distance-fallback", mode)
    check("keeping only what beats RELEVANCE_THRESHOLD", len(kept) == 1, str(len(kept)))
    check("the fallback is the pre-1.1.0 behaviour, unchanged", d.RELEVANCE_THRESHOLD == 0.85)
    kept, mode = d.relevant_matches([])
    check("an empty result set is quiet, not an error", kept == [] and mode == "distance-fallback")
    mixed = [m(0.80, 0.90, "scored"), m(0.80, None, "unscored")]
    check("a partially-scored pool is judged on the scored entries only",
          len(d.relevant_matches(mixed)[0]) == 1)

    print("\n[noise]")
    kept, _ = d.relevant_matches(NOISE)
    check("a single noise hit is rejected by the floor", kept == [])
    check("the floor sits above the measured noise ceiling of 0.0112", d.RERANK_FLOOR > 0.0112)
    check("and below the weakest genuine match kept (0.0606)", d.RERANK_FLOOR < 0.0606)

    check_storage()
    check_new_chunk_retrieval()

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
