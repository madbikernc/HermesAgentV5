#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-guard-eval — S22a's measurement, made repeatable. Scores the fleet's screening layers
# against a labelled case set and prints the three numbers S22 needs: each layer alone, the
# composite, and a threshold sweep showing what the Layer-2 score could achieve at ANY cutoff.
#
# WHY THIS EXISTS AS A TOOL RATHER THAN A ONE-OFF: S22b has to measure candidate screeners against
# the incumbent, and "the incumbent scored 4 of 18" is only comparable if the next measurement is
# taken the same way. Every number in IMPLEMENTATION_PLAN.md S22a came from this script.
#
# It reuses `GUARD_CASES` from tools/hermes-bakeoff-typesafe.py by import rather than copying the
# cases, so the two can never drift — the bake-off that produced S22's original finding and this
# tool judge the same 36 cases (18 malicious across direct/indirect/paraphrased bands, 18 benign
# including deliberate hard negatives).
#
# ── What it measures, and why each row is separate ──
#
# Layer 1 is role-keyed on purpose (hermes_injection_guard.severity() is "deliberately NOT
# role-blind"), so it is scored at both roles that matter:
#   * role=user — a direct request from a person. Only `role_spoof` and `unicode_smuggling` block
#     here, so this is the weakest configuration and the one a chat turn actually gets.
#   * role=tool — retrieved or tool-returned content, which is how an indirect injection arrives.
#     `cmd_injection`, `sql_injection`, `instruction_override`, `prompt_exfiltration` and
#     `role_tag_text` block too.
# Layer 2 is the live service, called over HTTP — the deployed thing, not a local reload of the
# checkpoint, because what S22 is about is what the fleet actually enforces.
#
# The composite is the only row that describes real exposure: a request is screened by Layer 1 and
# then, if Layer 1 did not block, by Layer 2. Before this script, only the layers' separate numbers
# existed.
#
# The threshold sweep converts the service's argmax-class probability back into P(malicious)
# (exact for a two-class softmax: p_mal = score if label is MALICIOUS else 1 - score) and sweeps
# every cutoff. It answers a question a single accuracy figure cannot: whether the incumbent is
# mis-tuned or mis-specified. On the 2026-10-09 run the answer was unambiguous — best achievable
# accuracy over any threshold was 0.722, and the malicious and benign score distributions overlap
# almost entirely below 0.063, so no cutoff separates them.
#
# Usage, on a node that can reach the guard service:
#   /opt/benchmark-venv/bin/python3 tools/hermes-guard-eval.py
#   tools/hermes-guard-eval.py --json out.json      # per-case rows, for diffing two candidates
#   tools/hermes-guard-eval.py --guard-url http://10.129.1.15:8096
#
# Needs GUARD_TOKEN, or falls back to vault-get-secret.sh guard-token. Pure stdlib plus the
# fleet's own modules; no model is loaded in-process.
import argparse
import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import hermes_injection_guard as l1  # noqa: E402

BANDS = (("direct", 0, 6), ("indirect", 6, 12), ("paraphrased", 12, 18))
SWEEP = (0.5, 0.3, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001)


def log(msg):
    print(f"[hermes-guard-eval] {msg}", flush=True)


def load_cases():
    """Import GUARD_CASES from the bake-off harness by path — the same importlib idiom
    hermes-attention-reminder.py uses for hyphenated siblings. Imported, never copied, so this
    tool and the bake-off can never disagree about what the cases are."""
    spec = importlib.util.spec_from_file_location("_bakeoff", TOOLS / "hermes-bakeoff-typesafe.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_bakeoff"] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:
        sys.exit(f"cannot import GUARD_CASES from hermes-bakeoff-typesafe.py: {exc}")
    return list(mod.GUARD_CASES)


def guard_token():
    tok = os.environ.get("GUARD_TOKEN", "")
    if tok:
        return tok
    try:
        r = subprocess.run([str(TOOLS / "vault-get-secret.sh"), "guard-token", "password"],
                           capture_output=True, text=True, timeout=60)
        return r.stdout.strip()
    except (subprocess.TimeoutExpired, OSError):
        return ""


def classify(url, token, text):
    req = urllib.request.Request(f"{url}/classify", data=json.dumps({"text": text}).encode(),
                                 method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def p_malicious(verdict):
    """Exact for a two-class softmax: the service returns the argmax class and that class's own
    probability, so the malicious probability is one or its complement. Recovering it is what
    makes the threshold sweep possible without touching the model."""
    score = float(verdict["score"])
    return score if verdict["label"] == "MALICIOUS" else 1.0 - score


def confusion(preds, golds):
    tp = sum(1 for p, g in zip(preds, golds) if p and g)
    fp = sum(1 for p, g in zip(preds, golds) if p and not g)
    fn = sum(1 for p, g in zip(preds, golds) if not p and g)
    tn = sum(1 for p, g in zip(preds, golds) if not p and not g)
    return tp, fp, fn, tn


def main():
    ap = argparse.ArgumentParser(description="S22 screening measurement: layers, composite, sweep")
    ap.add_argument("--guard-url", default=os.environ.get("GUARD_URL", "http://10.129.1.15:8096"))
    ap.add_argument("--json", help="write per-case rows here, for diffing two candidates")
    ap.add_argument("--no-layer2", action="store_true", help="Layer 1 only; no guard service needed")
    args = ap.parse_args()

    cases = load_cases()
    log(f"{len(cases)} cases ({sum(g for _, g in cases)} malicious, "
        f"{sum(1 for _, g in cases if not g)} benign)")

    token = "" if args.no_layer2 else guard_token()
    if not args.no_layer2 and not token:
        sys.exit("no GUARD_TOKEN and vault-get-secret.sh guard-token failed — "
                 "pass --no-layer2 to measure Layer 1 alone")

    rows, threshold = [], None
    for text, gold in cases:
        hits = l1.scan(text)
        row = {"text": text, "gold": gold, "categories": sorted(hits),
               "l1_user": l1.severity("user", hits), "l1_tool": l1.severity("tool", hits)}
        if not args.no_layer2:
            try:
                v = classify(args.guard_url, token, text)
            except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
                sys.exit(f"guard service unreachable at {args.guard_url}: {exc}")
            threshold = v.get("threshold", threshold)
            row.update(l2_label=v["label"], l2_score=float(v["score"]),
                       l2_hit=bool(v["hit"]), p_mal=p_malicious(v))
        rows.append(row)

    golds = [r["gold"] for r in rows]
    gates = [
        ("Layer 1 alone (role=user, block)", [r["l1_user"] == "block" for r in rows]),
        ("Layer 1 alone (role=tool, block)", [r["l1_tool"] == "block" for r in rows]),
        ("Layer 1 alone (role=tool, block+flag)",
         [r["l1_tool"] in ("block", "flag") for r in rows]),
    ]
    if not args.no_layer2:
        gates += [
            ("Layer 2 alone (live service)", [r["l2_hit"] for r in rows]),
            ("COMPOSITE (L1 tool block OR L2)",
             [r["l1_tool"] == "block" or r["l2_hit"] for r in rows]),
            ("COMPOSITE (L1 user block OR L2)",
             [r["l1_user"] == "block" or r["l2_hit"] for r in rows]),
        ]

    print(f"\nLayer-2 threshold in use: {threshold}\n")
    for name, pred in gates:
        tp, fp, fn, tn = confusion(pred, golds)
        print(f"{name:<40} TP={tp:>2} FP={fp:>2} FN={fn:>2} TN={tn:>2}  acc={(tp + tn) / len(golds):.3f}")

    print("\nmalicious cases caught, by attack band:")
    for band, lo, hi in BANDS:
        sub = rows[lo:hi]
        c1 = sum(1 for r in sub if r["l1_tool"] == "block")
        c2 = sum(1 for r in sub if r.get("l2_hit")) if not args.no_layer2 else 0
        cc = sum(1 for r in sub if r["l1_tool"] == "block" or r.get("l2_hit")) \
            if not args.no_layer2 else c1
        print(f"  {band:<14} n={len(sub)}  L1={c1}  L2={c2}  composite={cc}")

    if not args.no_layer2:
        mal = [r for r in rows if r["gold"] == 1]
        ben = [r for r in rows if r["gold"] == 0]
        print("\nP(malicious), malicious cases: "
              + " ".join(f"{r['p_mal']:.4f}" for r in sorted(mal, key=lambda x: -x["p_mal"])))
        print("P(malicious), benign cases:    "
              + " ".join(f"{r['p_mal']:.4f}" for r in sorted(ben, key=lambda x: -x["p_mal"])))
        print("\nthreshold sweep (Layer 2 alone) — is the incumbent mis-tuned or mis-specified?")
        best = (None, -1.0)
        for t in SWEEP:
            tp = sum(1 for r in mal if r["p_mal"] >= t)
            fp = sum(1 for r in ben if r["p_mal"] >= t)
            acc = (tp + (len(ben) - fp)) / len(rows)
            print(f"  t={t:<6} TP={tp:>2}/{len(mal)}  FP={fp:>2}/{len(ben)}  acc={acc:.3f}")
            if acc > best[1]:
                best = (t, acc)
        print(f"  best achievable over any swept threshold: acc={best[1]:.3f} at t={best[0]}")

        print("\nmalicious cases that pass BOTH layers:")
        for r in rows:
            if r["gold"] == 1 and r["l1_tool"] != "block" and not r["l2_hit"]:
                print(f"  p_mal={r['p_mal']:.4f} l1={r['l1_tool']:<5} {r['text'][:84]!r}")
        print("\nbenign cases either layer blocks (false positives):")
        fps = [r for r in rows if r["gold"] == 0 and (r["l1_tool"] == "block" or r["l2_hit"])]
        for r in fps:
            print(f"  p_mal={r['p_mal']:.4f} l1={r['l1_tool']:<5} {r['text'][:84]!r}")
        if not fps:
            print("  none")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        log(f"per-case rows written to {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
