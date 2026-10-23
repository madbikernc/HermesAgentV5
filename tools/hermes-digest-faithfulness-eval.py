#!/usr/bin/env python3
# Version: 1.0.0
#
# Initial version (2026-10-23) — S39 Phase C (FLEET_BENCHMARK_DESIGN.md S6.4), after S39a's
# sign-off. New tool. 5 synthetic (topic, passages) scenarios, two deterministic floor checks
# plus an optional judged-faithfulness check, 24 offline checks
# (infra/model-benchmark/tests/test_digest_faithfulness.py). No live RAG store reachable from this
# session, so no live run against real `hermes-news-digest.py` output yet.
"""
hermes-digest-faithfulness-eval.py — S39 Phase C's fleet_digest_faithfulness suite, closing
FLEET_BENCHMARK_DESIGN.md gap 4 (S6.4), after S39a's sign-off (2026-10-22). Scores whether a
digest highlight is actually supported by the real passage it cites.

GROUND TRUTH (S8.6): no hand-labelling needed — the cited passage itself IS the ground truth,
exactly as S6.4 states. This calls the REAL `hermes-news-digest.summarize_highlights()` function
UNMODIFIED (imported directly, confirmed import-safe — its module scope is only constants/regex
compilation, no DB connection, no network call), with its one network dependency
(`rag.router_chat`, which goes through `hermes-router` — S8.1 forbids that for an eval)
monkeypatched to call the digest role's backend directly instead. `rag.router_chat` is patched on
the shared `hermes_rag_common` module object itself, which `summarize_highlights()` looks up by
attribute at call time, not at import time — so this is a real call to the UNCHANGED function body:
the exact same passage-numbering, `<DATA>` wrapping, "nothing new" short-circuit, and
`HIGHLIGHT_RE` citation parse/range-check production code runs, not a copy of it. Zero prompt
drift is structurally impossible here, stronger even than the `ast`-extraction approach Phase B/C's
other suites use (there was nothing left to extract — the whole function runs for real).

Case set is SYNTHETIC per S8.6 — 5 hand-built (topic, passages) scenarios, no live RAG store
reachable from this session to sample real matches from. Growing this with real, scrubbed
(topic, matches) pairs sampled from a live `vectors.db` remains open future work for a session
with fleet access.

THREE SCORING AXES, deterministic-first (S28's own rule, reused everywhere in this design):
  * `grounded` (always computed, no judge needed): for every highlight the real function returns,
    does it share ANY significant token with the passage text it cites? Zero shared tokens is a
    strong hallucination floor signal a citation-FORMAT check alone can't catch — the model can
    cite a real, offered passage index (which `summarize_highlights()` already validates) and
    still write content that passage doesn't actually support.
  * `padding_restraint` (always computed, no judge needed): for the one case built with nothing
    genuinely new/relevant, did the model correctly emit zero highlights (its own system prompt's
    explicit "do NOT pad to reach a count... output exactly: nothing new" instruction), rather than
    inventing an item to fill the response?
  * `faithful` (needs `--judge-endpoint`, never the role under test itself — S8.7): an independent
    judge checks each highlight's actual claim against its cited passage's full text, matching
    S6.4's own stated metric ("an independent judge model checks each sentence against its cited
    chunk... report the fraction of highlights with zero unsupported claims"). Falls back to
    `"unjudged"` — a distinct, honest non-answer — when no judge endpoint is supplied, never
    silently scored as pass or fail. `[RISK]`, same one S6.4 names: an LLM judge checking an LLM
    summary is weaker evidence than a deterministic check, and a human should spot-check a sample
    of the judge's own verdicts before trusting the number.

Always direct-to-backend (S8.1) for both the role under test and the judge.

Usage:
  hermes-digest-faithfulness-eval.py --endpoint http://127.0.0.1:8094/v1 \\
      [--judge-endpoint URL] [--judge-model judge] [--model-id "super (live)"] [--json out.json]
"""
import argparse
import importlib.util
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import hermes_benchmark_common as bc  # noqa: E402


def log(msg):
    print(f"[hermes-digest-faithfulness-eval] {msg}", flush=True)


def load_digest_module():
    """hermes-news-digest.py IS safe to exec directly: module scope is only constants, regex
    compilation, and `sys.path.insert` -- no DB connection, no network call. Confirmed by reading
    it, not assumed."""
    spec_path = TOOLS / "hermes-news-digest.py"
    spec = importlib.util.spec_from_file_location("_digest", spec_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── the case set (see module docstring: synthetic, no live RAG store reachable) ────────────────

def build_cases():
    return [
        ("vendor_patch", "network security", [
            {"text": "Acme Networks shipped a patch for CVE-2026-41122, a remote-code-execution "
                      "flaw in its VPN gateway firmware that was already being exploited in the "
                      "wild. Admins are urged to update affected appliances immediately.",
             "citation": "Acme Networks security bulletin, 2026-10-20"},
        ], {"expect_min_highlights": 1, "expect_max_highlights": 1}),

        ("duplicate_collapse", "AI models", [
            {"text": "Vendor X released Glimmer-9, a 9-billion-parameter open-weight model, "
                      "today, claiming state-of-the-art results on coding benchmarks.",
             "citation": "Vendor X blog, 2026-10-19"},
            {"text": "Today Vendor X announced the release of their new Glimmer-9 model, a "
                      "9B-parameter open-weight release the company says leads coding benchmarks.",
             "citation": "Tech news aggregator, 2026-10-19"},
        ], {"expect_min_highlights": 1, "expect_max_highlights": 1}),

        ("nothing_new", "llm benchmarks", [
            {"text": "A blog recapped last month's leaderboard standings with no new scores, no "
                      "new models, and no methodology changes, restating figures already widely "
                      "reported weeks earlier.",
             "citation": "Recap blog, 2026-10-15"},
        ], {"expect_min_highlights": 0, "expect_max_highlights": 0}),

        ("hallucination_trap", "data breach", [
            {"text": "A mid-sized retailer disclosed a breach affecting an undisclosed number of "
                      "customer accounts, saying an investigation is ongoing and it has not yet "
                      "determined the root cause.",
             "citation": "Retailer press release, 2026-10-18"},
        ], {"expect_min_highlights": 1, "expect_max_highlights": 1}),

        ("multi_passage_distinct", "space", [
            {"text": "A commercial lunar lander completed its first powered descent test in "
                      "Earth orbit ahead of a planned Moon landing attempt next year.",
             "citation": "Spaceflight news, 2026-10-17"},
            {"text": "Astronomers confirmed the detection of a new fast radio burst repeater "
                      "roughly 400 million light-years away using a radio array in Australia.",
             "citation": "Observatory press release, 2026-10-16"},
        ], {"expect_min_highlights": 2, "expect_max_highlights": 2}),
    ]


# ── deterministic checks over the real function's own output ───────────────────────────────────

_STOPWORDS = {"a", "an", "the", "is", "was", "are", "were", "to", "of", "in", "on", "for",
              "and", "or", "its", "it", "that", "this", "with", "as", "by", "at", "has", "have",
              "today", "new"}
_WORD_RE = re.compile(r"[a-z0-9]+")


def significant_tokens(text):
    return {w for w in _WORD_RE.findall(text.lower()) if w not in _STOPWORDS and len(w) > 2}


def is_grounded(highlight_text, passage_text):
    """Deterministic floor signal: does the highlight share ANY significant token with the
    passage it cites? Catches a hallucination that passes the real citation-index check (a real,
    offered index) but whose content the passage doesn't actually support. Weak by design --
    shared vocabulary is not proof of faithfulness, only its absence is a strong red flag -- never
    a substitute for the judged `faithful` axis."""
    return len(significant_tokens(highlight_text) & significant_tokens(passage_text)) > 0


JUDGE_SYSTEM_PROMPT = (
    "You are checking whether one news-digest headline is actually supported by the single source "
    "passage it was generated from. You are not the model that wrote the headline. Reply with "
    "exactly PASS or FAIL on the first line (PASS = every claim in the headline is supported by "
    "the passage; FAIL = the headline states something the passage does not say, or exaggerates a "
    "detail beyond what the passage states), then one short sentence of why."
)


def judge_prompt(highlight_text, passage_text):
    return [
        {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
        {"role": "user", "content": f"Source passage: {passage_text!r}\n\n"
                                     f"Headline generated from it: {highlight_text!r}"},
    ]


def parse_judge_verdict(judge_text):
    """pass | fail | unclear -- same "a non-answer is not a 'no'" discipline every other suite in
    this design already applies."""
    first_line = (judge_text or "").strip().splitlines()[0].strip().upper() if judge_text else ""
    if first_line.startswith("PASS"):
        return "pass"
    if first_line.startswith("FAIL"):
        return "fail"
    return "unclear"


def call_backend(endpoint, model, messages, max_tokens=300, timeout=120):
    body = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(f"{endpoint.rstrip('/')}/chat/completions", data=body,
                                  method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    return data["choices"][0]["message"]["content"].strip()


def main():
    ap = argparse.ArgumentParser(description="S39 fleet_digest_faithfulness: score whether a "
                                              "digest highlight is supported by its cited passage")
    ap.add_argument("--endpoint", required=True,
                     help="the digest role's own backend URL directly, bypassing the router (S8.1)")
    ap.add_argument("--judge-endpoint", default=None,
                     help="an independent judge model's backend URL (never the role under test, "
                          "S8.7) -- without it, the `faithful` axis is reported as unjudged")
    ap.add_argument("--judge-model", default="judge")
    ap.add_argument("--model", default="super", help="the real role summarize_highlights() calls")
    ap.add_argument("--model-id", default="super (live)")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--json", help="write per-case rows here")
    args = ap.parse_args()

    digest = load_digest_module()
    digest.rag.router_chat = lambda messages, model="super", timeout=120, retries=3: call_backend(
        args.endpoint, args.model, messages, max_tokens=2000, timeout=180)

    cases = build_cases()[:args.limit] if args.limit else build_cases()
    log(f"{len(cases)} cases against {args.endpoint}"
        + (f", judge at {args.judge_endpoint}" if args.judge_endpoint else " (no judge: faithful axis unjudged)"))

    rows = []
    for case_id, topic, matches, expect in cases:
        try:
            highlights = digest.summarize_highlights(topic, matches)
        except (urllib.error.URLError, OSError, KeyError, IndexError) as exc:
            log(f"[{case_id}] call failed: {exc}")
            rows.append({"case": case_id, "error": str(exc)})
            continue

        n = len(highlights)
        count_ok = expect["expect_min_highlights"] <= n <= expect["expect_max_highlights"]
        log(f"[{case_id:<22}] {n} highlight(s), expected [{expect['expect_min_highlights']}-"
            f"{expect['expect_max_highlights']}] -> count_ok={count_ok}")

        for text, citation in highlights:
            idx_matches = [i for i, m in enumerate(matches) if m["citation"] == citation]
            passage_text = matches[idx_matches[0]]["text"] if idx_matches else ""
            grounded = is_grounded(text, passage_text) if passage_text else False
            row = {"case": case_id, "topic": topic, "highlight": text, "citation": citation,
                   "grounded": grounded}
            if args.judge_endpoint:
                try:
                    judge_reply = call_backend(args.judge_endpoint, args.judge_model,
                                                judge_prompt(text, passage_text))
                    row["faithful"] = parse_judge_verdict(judge_reply)
                except (urllib.error.URLError, OSError, KeyError, IndexError) as exc:
                    log(f"  [{case_id}] judge call failed: {exc}")
                    row["faithful"] = "unclear"
            else:
                row["faithful"] = "unjudged"
            rows.append(row)

        rows.append({"case": case_id, "count_check": True, "count_ok": count_ok,
                     "n_highlights": n})

    highlight_rows = [r for r in rows if "highlight" in r]
    count_rows = [r for r in rows if r.get("count_check")]

    grounded_n = sum(1 for r in highlight_rows if r["grounded"])
    grounded_rate = grounded_n / len(highlight_rows) if highlight_rows else None

    judged_rows = [r for r in highlight_rows if r["faithful"] in ("pass", "fail")]
    faithful_rate = (sum(1 for r in judged_rows if r["faithful"] == "pass") / len(judged_rows)
                      ) if judged_rows else None

    padding_rows = [r for r in count_rows if r["case"] == "nothing_new"]
    padding_rate = (sum(1 for r in padding_rows if r["count_ok"]) / len(padding_rows)
                     ) if padding_rows else None

    print("\n=== fleet_digest_faithfulness ===")
    if grounded_rate is not None:
        print(f"  grounded (deterministic floor): {grounded_n}/{len(highlight_rows)} = {grounded_rate:.3f}")
    if faithful_rate is not None:
        print(f"  faithful (judged):              {sum(1 for r in judged_rows if r['faithful'] == 'pass')}/{len(judged_rows)} = {faithful_rate:.3f}")
    elif args.judge_endpoint is None:
        print("  faithful (judged):              unjudged -- no --judge-endpoint supplied")
    if padding_rate is not None:
        print(f"  padding_restraint:              {sum(1 for r in padding_rows if r['count_ok'])}/{len(padding_rows)} = {padding_rate:.3f}")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        log(f"per-row data written to {args.json}")

    suites = {}
    if grounded_rate is not None:
        suites["fleet_digest_faithfulness_grounded"] = {"metric": "grounded_rate",
                                                          "value": grounded_rate,
                                                          "limit": len(highlight_rows)}
    if padding_rate is not None:
        suites["fleet_digest_faithfulness_padding_restraint"] = {"metric": "pass_rate",
                                                                   "value": padding_rate,
                                                                   "limit": len(padding_rows)}
    if faithful_rate is not None:
        # the bare fleet_digest_faithfulness key (ALL_SUITES' own name) is the judged metric
        # S6.4 itself names as the primary number -- recorded only when a judge actually ran,
        # never guessed from the deterministic floor alone.
        suites["fleet_digest_faithfulness"] = {"metric": "faithful_rate", "value": faithful_rate,
                                                "limit": len(judged_rows)}
    if suites:
        try:
            bc.append_entry({
                "date": datetime.now(timezone.utc).isoformat(),
                "lm_eval_version": None, "bfcl_version": None, "swebench_version": None,
                "model_id": args.model_id, "role_or_endpoint": args.model, "endpoint": args.endpoint,
                "bfcl_model_name": None, "notes": "",
                "suites": suites,
            })
        except Exception as exc:
            log(f"shared history write failed (the report above is unaffected): {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
