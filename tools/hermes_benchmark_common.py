#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 — real fixes from a live verification pass on spark, 2026-08-24: run_bfcl() rewritten
# around the actual verified mechanism (REMOTE_OPENAI_BASE_URL pointed directly at a role's own
# llama-server port, --skip-server-setup, --model from BFCL's own registry), replacing an earlier
# wrong guess (a plain --base-url flag that doesn't exist). run_swebench() gained a fast Docker/
# aarch64 pre-flight check after confirming live that x86_64 images don't run here out of the box.
"""
hermes_benchmark_common.py — Shared history store, comparison logic, and suite
runners for tools/hermes-benchmark-model.py and tools/hermes-benchmark-compare.py.
See infra/model-benchmark/README.md for the one-time venv install. MMLU-Pro,
GPQA-Diamond, IFEval, and BFCL are all verified working end-to-end live (spark,
2026-08-24); SWE-bench is confirmed blocked on this hardware without extra
Docker emulation setup (README §4) — run_swebench() fails fast with that
reason rather than grinding through a doomed run.

Named with underscores, breaking this project's usual hyphenated tools/
filename convention — deliberately, same reason hermes_usage_log.py and
hermes_game_backup_common.py are: this file is `import`ed, not invoked
directly, and Python cannot import a module whose filename contains a hyphen.

History is a JSONL file, one line per completed run:
{
  "date": "2026-08-24T18:32:10+00:00",
  "lm_eval_version": "0.4.12" | null,
  "bfcl_version": "..." | null,
  "swebench_version": "..." | null,
  "model_id": "Qwen/Qwen3-Coder-Next",   # operator-supplied label, not auto-detected
  "role_or_endpoint": "coder",           # fleet role name, or a placeholder for a candidate run
  "endpoint": "http://127.0.0.1:8080/v1",
  "bfcl_model_name": "Qwen/Qwen3-30B-A3B-Instruct-2507-FC" | null,  # see run_bfcl()
  "notes": "",
  "suites": {
    "mmlu_pro":     {"metric": "exact_match,none", "value": 0.71, "limit": null} | {"status": "error", "detail": "..."},
    "gpqa_diamond": {...},
    "ifeval":       {...},
    "bfcl":         {...},
    "swebench":     {...},
  }
}

Canonical location reuses the fleet's one existing NAS2 mount (same discipline
tools/hermes-model-archive.py, Stage 13, already established) so both nodes
read/write the same file with no new export. Falls back to a local file,
best-effort, if that mount isn't present right now — load_history() reads
both locations and merges, so a run recorded during a mount outage is never
silently lost, just temporarily split across two files.
"""
import csv
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

NAS_MOUNT_ROOT = Path("/mnt/nas2-hermes-backup")
NAS_HISTORY_PATH = NAS_MOUNT_ROOT / "Private" / "Hermes" / "Benchmarks" / "history.jsonl"
LOCAL_HISTORY_PATH = Path.home() / ".hermes" / "state" / "benchmark-history.jsonl"

# Best current understanding of the registered lm-eval-harness task names for these three suites —
# confirm against `lm_eval --tasks list` before the first real run (infra/model-benchmark/README.md
# §1). gpqa_diamond deliberately uses the _cot_zeroshot (generative) variant, not the default
# loglikelihood-based gpqa_diamond_zeroshot — see that same README §2 for why an API-based chat
# model can only run generate_until tasks.
MMLU_PRO_TASK = "mmlu_pro"
GPQA_DIAMOND_TASK = "gpqa_diamond_cot_zeroshot"
IFEVAL_TASK = "ifeval"

# Preferred metric key to report per task, in order — lm-eval-harness's exact metric key naming
# (e.g. "exact_match,none" vs "acc,none") has shifted across versions; first match wins, and if none
# match the raw dict is kept so nothing is silently dropped.
METRIC_PREFERENCE = {
    MMLU_PRO_TASK: ["exact_match,custom-extract", "exact_match,none", "acc,none"],
    GPQA_DIAMOND_TASK: ["exact_match,none", "acc,none"],
    IFEVAL_TASK: ["prompt_level_strict_acc,none", "inst_level_strict_acc,none"],
}

ALL_SUITES = ["mmlu_pro", "gpqa_diamond", "ifeval", "bfcl", "swebench"]
# swebench excluded from the default set — confirmed blocked on current fleet hardware (no x86_64
# Docker emulation, infra/model-benchmark/README.md §4). Still selectable explicitly via --suites;
# run_swebench() fails fast with the real reason rather than silently doing nothing.
DEFAULT_SUITES = ["mmlu_pro", "gpqa_diamond", "ifeval", "bfcl"]


def log(msg):
    print(f"[hermes-benchmark] {msg}", file=sys.stderr)


def _pkg_version(name):
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def lm_eval_version():
    return _pkg_version("lm_eval") or _pkg_version("lm-eval")


def bfcl_version():
    return _pkg_version("bfcl-eval")


def swebench_version():
    return _pkg_version("swebench")


# --- History read/write -----------------------------------------------------

def _read_jsonl(path: Path) -> list:
    if not path.exists():
        return []
    entries = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError as e:
            log(f"WARNING: skipping malformed history line in {path}: {e}")
    return entries


def load_history() -> list:
    """Reads both the NAS2 canonical file and the local fallback (whichever exist) and
    merges, oldest first — a run recorded during a NAS2 outage is never silently lost."""
    entries = _read_jsonl(NAS_HISTORY_PATH) + _read_jsonl(LOCAL_HISTORY_PATH)
    entries.sort(key=lambda e: e.get("date", ""))
    return entries


def append_entry(entry: dict) -> Path:
    """Best-effort write to the NAS2 canonical path; falls back to the local path if that
    mount isn't present right now. Returns the path actually written to."""
    line = json.dumps(entry, sort_keys=True) + "\n"

    if NAS_MOUNT_ROOT.is_mount():
        NAS_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(NAS_HISTORY_PATH, "a") as f:
            f.write(line)
        return NAS_HISTORY_PATH

    log(f"NAS2 mount ({NAS_MOUNT_ROOT}) not present — writing to local fallback instead")
    LOCAL_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCAL_HISTORY_PATH, "a") as f:
        f.write(line)
    return LOCAL_HISTORY_PATH


# --- Suite runners -----------------------------------------------------------

def _extract_metric(results_dict: dict, task: str) -> dict:
    task_results = results_dict.get("results", {}).get(task)
    if task_results is None:
        return {"status": "error", "detail": f"task {task!r} not found in lm_eval output"}
    for key in METRIC_PREFERENCE.get(task, []):
        if key in task_results:
            return {"metric": key, "value": task_results[key]}
    # No known key matched — keep the raw dict rather than silently dropping the result.
    return {"metric": "unknown", "value": None, "raw": task_results}


def run_lm_eval_task(task: str, role_or_endpoint: str, chat_completions_url: str,
                      limit: int | None, extra_args: list) -> dict:
    """Runs one lm-eval-harness task against an OpenAI-compatible chat-completions endpoint
    and returns {"metric": ..., "value": ..., "limit": ...} or {"status": "error", "detail": ...}."""
    with __import__("tempfile").TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        model_args = (
            f"model={role_or_endpoint},base_url={chat_completions_url},"
            f"num_concurrent=1,max_retries=3,tokenized_requests=False"
        )
        cmd = [
            "lm_eval", "--model", "local-chat-completions",
            "--model_args", model_args,
            "--tasks", task,
            "--apply_chat_template",
            "--output_path", str(out_dir),
        ]
        if limit:
            cmd += ["--limit", str(limit)]
        cmd += extra_args

        log(f"running: {' '.join(cmd)}")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600 * 6)
        except subprocess.TimeoutExpired:
            return {"status": "error", "detail": f"{task} timed out after 6h"}
        except FileNotFoundError:
            return {"status": "error", "detail": "lm_eval not found — is /opt/benchmark-venv activated?"}

        if proc.returncode != 0:
            return {"status": "error", "detail": proc.stderr[-2000:] or proc.stdout[-2000:]}

        result_files = sorted(out_dir.rglob("results*.json"), key=lambda p: p.stat().st_mtime)
        if not result_files:
            return {"status": "error", "detail": "lm_eval exited 0 but produced no results*.json"}

        results_dict = json.loads(result_files[-1].read_text())
        extracted = _extract_metric(results_dict, task)
        extracted["limit"] = limit
        return extracted


def run_bfcl(bfcl_model_name: str, direct_endpoint_base_url: str, test_category: str,
             extra_args: list) -> dict:
    """Runs BFCL generate+evaluate. Verified end-to-end live on spark 2026-08-24 (real request
    against `nano` through its own llama-server port, real score CSV produced) — this replaced an
    earlier, wrong guess (a plain --base-url flag that doesn't exist).

    Two real constraints, found live, that shape the two parameters below:
    - `direct_endpoint_base_url` must be the role's own llama-server port (e.g.
      http://127.0.0.1:8088/v1 for nano on spark), NOT hermes-router's :8080. BFCL's OSS local-
      inference handler calls /v1/completions, which hermes-router doesn't implement (only
      /v1/chat/completions), and it sends its --model value as the outgoing "model" field, which
      hermes-router would reject (it only accepts its five role names). llama-server itself
      accepts any string in "model" — confirmed live — so going direct sidesteps both problems.
    - `bfcl_model_name` must be a name from `bfcl models` (e.g. "Qwen/Qwen3-4B-Instruct-2507-FC")
      — it selects BFCL's prompt-formatting/tool-schema logic, not just a label. None of this
      fleet's actual checkpoints have an exact registry entry; pick the closest architectural
      match and treat the score as an approximation of that mismatch, not a clean number — a
      real live run scored 0.00% for exactly this reason (format mismatch, not a broken backend).

    REMOTE_OPENAI_BASE_URL/REMOTE_OPENAI_API_KEY are bfcl_eval's own override env vars for this;
    --skip-server-setup stops it from trying to launch its own vLLM/SGLang server.
    """
    env = os.environ.copy()
    env["REMOTE_OPENAI_BASE_URL"] = direct_endpoint_base_url
    env["REMOTE_OPENAI_API_KEY"] = "EMPTY"

    with __import__("tempfile").TemporaryDirectory() as tmp:
        result_dir = Path(tmp) / "result"
        score_dir = Path(tmp) / "score"

        gen_cmd = ["bfcl", "generate", "--model", bfcl_model_name, "--test-category", test_category,
                   "--skip-server-setup", "--result-dir", str(result_dir)] + extra_args
        log(f"running: {' '.join(gen_cmd)}")
        try:
            proc = subprocess.run(gen_cmd, capture_output=True, text=True, timeout=3600 * 6, env=env)
        except subprocess.TimeoutExpired:
            return {"status": "error", "detail": "bfcl generate timed out after 6h"}
        except FileNotFoundError:
            return {"status": "error", "detail": "bfcl not found — is bfcl-eval installed in the active venv? "
                                                  "(also needs `pip install soundfile`, an undeclared "
                                                  "dependency of its Qwen handler — infra/model-benchmark/README.md §3)"}
        if proc.returncode != 0:
            return {"status": "error", "detail": "bfcl generate failed: " + (proc.stderr[-2000:] or proc.stdout[-2000:])}

        eval_cmd = ["bfcl", "evaluate", "--model", bfcl_model_name, "--test-category", test_category,
                    "--result-dir", str(result_dir), "--score-dir", str(score_dir)]
        try:
            proc2 = subprocess.run(eval_cmd, capture_output=True, text=True, timeout=1800)
        except subprocess.TimeoutExpired:
            return {"status": "error", "detail": "bfcl evaluate timed out after 30m"}
        if proc2.returncode != 0:
            return {"status": "error", "detail": "bfcl evaluate failed: " + (proc2.stderr[-2000:] or proc2.stdout[-2000:])}

        csv_path = score_dir / "data_overall.csv"
        if not csv_path.exists():
            return {"status": "error", "detail": f"bfcl evaluate exited 0 but {csv_path} wasn't written"}
        with open(csv_path) as f:
            rows = list(csv.DictReader(f))
        if not rows:
            return {"status": "error", "detail": f"{csv_path} has no data rows"}
        acc_str = rows[0].get("Overall Acc", "").rstrip("%")
        try:
            value = float(acc_str) / 100.0
        except ValueError:
            return {"metric": "unknown", "value": None, "raw": rows[0]}
        return {"metric": "overall_acc", "value": value, "raw_row": rows[0]}


def _docker_x86_emulation_available() -> str | None:
    """SWE-bench's reference images are built for x86_64; whether they can run at all on
    aarch64 depends on binfmt_misc/qemu-user-static emulation being registered. Confirmed live on
    spark 2026-08-24: it is NOT, out of the box — `docker run --platform linux/amd64 hello-world`
    fails with "exec /hello: exec format error". Also confirmed live: plain `docker` needs `sudo`
    for pmoney there (not in the `docker` group) — distinguished below so the real blocker is
    reported, not a generic one. Returns None if the check passed, else a reason string."""
    for cmd in (["docker"], ["sudo", "docker"]):
        try:
            proc = subprocess.run(
                cmd + ["run", "--rm", "--platform", "linux/amd64", "hello-world"],
                capture_output=True, text=True, timeout=120)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            continue
        stderr = proc.stderr or ""
        if "permission denied" in stderr.lower() and cmd == ["docker"]:
            continue  # try again with sudo before concluding anything
        if proc.returncode == 0:
            return None
        if "exec format error" in stderr:
            return "no x86_64 emulation registered (binfmt_misc/qemu-user-static) — install e.g. " \
                   "`docker run --privileged --rm tonistiigi/binfmt --install amd64` first (untested here)"
        return f"docker run failed for an unexpected reason: {stderr[-500:]}"
    return "docker not found or not usable even with sudo"


SWEBENCH_DATASET = "SWE-bench/SWE-bench_Verified"
# Not princeton-nlp/SWE-bench_Verified, the org this constant originally guessed — found live on
# HomeD13 2026-08-24: that copy's instance dicts have no "image" field, which
# swebench.harness.utils.make_test_spec() 5.0.2 requires (KeyError: 'image'). The canonical
# SWE-bench/SWE-bench_Verified copy has it. Confirm with `datasets.load_dataset(..., split="test")
# [0].keys()` before trusting this again if a future swebench upgrade changes the requirement.

# Generation timeout per instance — found live 2026-08-24 that 180s (this fleet's usual single-turn
# call budget, matching hermes-model-call.sh) genuinely isn't enough for at least one real SWE-bench
# issue's full prompt+diff-generation round trip on this hardware; raised with real margin rather
# than guessed at again.
SWEBENCH_GENERATION_TIMEOUT_S = 600


def run_swebench(role_or_endpoint: str, chat_completions_url: str, limit: int | None,
                  extra_args: list) -> dict:
    """Best-effort SWE-bench Verified run: generates a single-turn patch per instance via the
    given endpoint, then scores with swebench.harness.run_evaluation. Treat any score this
    produces as provisional, not leaderboard-comparable — single-turn patch generation
    under-measures real coding ability relative to a full agent scaffold
    (infra/model-benchmark/README.md §4).

    Docker/aarch64 is a real blocker on spark specifically (confirmed live 2026-08-24: no
    binfmt_misc/qemu-user-static emulation, a plain `docker run --platform linux/amd64 hello-world`
    fails with "exec format error") — not on x86_64 hardware. HomeD13 (x86_64) runs SWE-bench's
    reference images natively; Stage 16 wires it up as this suite's actual intended host. Pre-flight-
    checked below regardless, so a run on the wrong hardware still fails fast with a clear reason."""
    blocker = _docker_x86_emulation_available()
    if blocker is not None:
        return {"status": "error", "detail": f"SWE-bench needs x86_64 Docker images to run: {blocker} "
                                              "— see infra/model-benchmark/README.md §4. Consider "
                                              "running this suite from HomeD13 instead (Stage 16), "
                                              "which has native x86_64 Docker."}

    try:
        import datasets
    except ImportError:
        return {"status": "error", "detail": f"the `datasets` package is required to load "
                                              f"{SWEBENCH_DATASET} — not installed"}

    log(f"loading {SWEBENCH_DATASET}" + (f" (limit={limit})" if limit else ""))
    try:
        ds = datasets.load_dataset(SWEBENCH_DATASET, split="test")
    except Exception as e:
        return {"status": "error", "detail": f"could not load {SWEBENCH_DATASET} dataset: {e}"}
    if limit:
        ds = ds.select(range(min(limit, len(ds))))

    predictions = []
    for inst in ds:
        prompt = (
            "You are given a GitHub issue and the relevant repository context. "
            "Produce a single unified diff patch that resolves the issue. "
            "Output ONLY the diff, no prose.\n\n"
            f"Repo: {inst['repo']}\nIssue:\n{inst['problem_statement']}"
        )
        body = json.dumps({"model": role_or_endpoint, "stream": False,
                            "messages": [{"role": "user", "content": prompt}]}).encode()
        req = urlrequest.Request(chat_completions_url, data=body,
                                  headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=SWEBENCH_GENERATION_TIMEOUT_S) as resp:
                data = json.loads(resp.read())
            patch = data["choices"][0]["message"]["content"]
        except (urlerror.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as e:
            # TimeoutError (socket.timeout) is NOT a urlerror.URLError subclass — urlopen's own
            # timeout raises it directly. Missing from this catch originally would have crashed the
            # whole run instead of just skipping one instance; found live 2026-08-24 on HomeD13 when
            # a real long SWE-bench prompt actually hit the (then 180s) timeout.
            log(f"instance {inst['instance_id']}: generation failed: {e}")
            patch = ""
        predictions.append({"instance_id": inst["instance_id"], "model_patch": patch,
                             "model_name_or_path": role_or_endpoint})

    with __import__("tempfile").TemporaryDirectory() as tmp:
        preds_path = Path(tmp) / "predictions.jsonl"
        preds_path.write_text("\n".join(json.dumps(p) for p in predictions))
        report_dir = Path(tmp) / "reports"
        report_dir.mkdir()
        run_id = f"hermes-benchmark-{int(time.time())}"

        cmd = [sys.executable, "-m", "swebench.harness.run_evaluation",
               "--predictions_path", str(preds_path),
               "--run_id", run_id,
               "--report_dir", str(report_dir),
               "--dataset_name", SWEBENCH_DATASET] + extra_args
        log(f"running: {' '.join(cmd)}")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600 * 12)
        except subprocess.TimeoutExpired:
            return {"status": "error", "detail": "run_evaluation timed out after 12h"}
        except FileNotFoundError:
            return {"status": "error", "detail": "swebench package not found in the active venv"}
        if proc.returncode != 0:
            return {"status": "error", "detail": "run_evaluation failed: "
                                                  + (proc.stderr[-2000:] or proc.stdout[-2000:])}

        # Report filename is <model_name_or_path>.<run_id>.json — role_or_endpoint is what was
        # written into every prediction's model_name_or_path field above. Verified live 2026-08-24
        # on HomeD13 (real schema: resolved_instances/submitted_instances/... at the top level,
        # schema_version 2).
        report_path = report_dir / f"{role_or_endpoint}.{run_id}.json"
        if not report_path.exists():
            return {"status": "error", "detail": f"run_evaluation exited 0 but {report_path} wasn't "
                                                  f"written — dir contents: {list(report_dir.iterdir())}"}
        report = json.loads(report_path.read_text())
        submitted = report.get("submitted_instances", 0)
        resolved = report.get("resolved_instances", 0)
        value = (resolved / submitted) if submitted else None
        return {"metric": "resolved_rate", "value": value,
                "submitted_instances": submitted, "resolved_instances": resolved,
                "empty_patch_instances": report.get("empty_patch_instances"),
                "infra_failure_instances": report.get("infra_failure_instances")}


# --- Comparison ---------------------------------------------------------------

def most_recent_prior(history: list, model_id: str, before_date: str | None = None) -> dict | None:
    matches = [e for e in history if e.get("model_id") == model_id
               and (before_date is None or e.get("date", "") < before_date)]
    return matches[-1] if matches else None


def format_comparison(current: dict, previous: dict | None) -> str:
    lines = [f"model_id={current.get('model_id')}  date={current.get('date')}"]
    if previous is None:
        lines.append("  (no prior run for this model_id to compare against)")
        return "\n".join(lines)
    lines.append(f"  vs. prior run {previous.get('date')} "
                 f"(lm_eval {previous.get('lm_eval_version')})")
    for suite in ALL_SUITES:
        cur = current.get("suites", {}).get(suite, {})
        prev = previous.get("suites", {}).get(suite, {})
        cur_v, prev_v = cur.get("value"), prev.get("value")
        if cur_v is None or prev_v is None:
            lines.append(f"  {suite:14s} current={cur_v!r:>10} prior={prev_v!r:>10}")
            continue
        delta = cur_v - prev_v
        arrow = "▲" if delta > 0 else ("▼" if delta < 0 else "=")
        lines.append(f"  {suite:14s} current={cur_v:.4f}  prior={prev_v:.4f}  "
                     f"delta={delta:+.4f} {arrow}")
    return "\n".join(lines)
