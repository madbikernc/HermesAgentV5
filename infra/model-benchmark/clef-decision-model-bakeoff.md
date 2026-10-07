# Cloudflare Clef-flash (decision model) — Bake-off Results

**Version:** 1.0.0

Run 2026-10-06 against the live fleet. **Verdict: not adopted for any role.** Clef-flash lost or
tied on every text decision it was tested on, and on GB10 it was slower than the llama.cpp
incumbents. Vision was the only area where it was competitive, and that result is unscored (no
labelled frames). The bake-off's most useful finding was about an incumbent: **Layer-2 guard
(Llama-Prompt-Guard-2-22M) caught 4 of 18 malicious cases.**

## 1. What was tested

Cloudflare released Clef (27B, post-trained from Qwen3.8-27B) and Clef-flash (9B, from Qwen3.5-9B)
on 2026-10-01 under Apache-2.0. Both are *decision models*: a state plus typed `choice` / `score` /
`noul` questions go in, a probability for every allowed option comes out of one forward pass, and
no text is generated. Clef-flash speaks the Jev/SystemOne wire shape, so
`tools/hermes-bakeoff-typesafe.py` drove it with no code changes beyond the vision tasks added for
this run (1.1.0).

Only **Clef-flash** was run (HF revision `17f0b0ad64efb65d273590632833508766b2aae6`, BF16). The 27B
was not tested.

## 2. How it was served — reproduce exactly this

llama.cpp cannot serve Clef: the joint schema head is custom code shipped in the checkpoint
(`joint_schema_model.py`; reviewed in full before running it — tensor ops plus local
safetensors/JSON loads only, no network or subprocess use). `tools/hermes-clef-server.py` wraps the
release's own `load_release_model` + `systemone` under transformers at `POST /v1/systemone`, bound
to `127.0.0.1:8089` on spark-2.

Three things a rerun will hit:

1. **`accelerate` is required.** `load_release_model` passes `device_map=`. Loading to CPU and then
   calling `.to("cuda")` briefly holds two copies of the weights in GB10 unified memory and fails
   with CUDA out-of-memory on spark-2.
2. **`torchvision` is required** by the Qwen3-VL processor. It must be `0.28.0+cu130` from
   `https://download.pytorch.org/whl/cu130`, installed with `--no-deps`. Without `--no-deps`, pip
   pulls a second 427 MB copy of torch.
3. Neither package is in `/opt/benchmark-venv`, and it was not modified. The run used a throwaway
   venv whose `.pth` file pointed at the benchmark venv's site-packages, plus just those two packages:

```bash
# On spark-2
mkdir -p ~/clef-trial && cd ~/clef-trial
/opt/benchmark-venv/bin/hf download Cloudflare/clef-flash \
  --revision 17f0b0ad64efb65d273590632833508766b2aae6 --local-dir /mnt/hermes-data/models/clef-flash
/opt/benchmark-venv/bin/python3 -m venv venv
echo /opt/benchmark-venv/lib/python3.12/site-packages \
  > "$(venv/bin/python3 -c 'import site;print(site.getsitepackages()[0])')/benchmark-venv.pth"
venv/bin/pip install accelerate
venv/bin/pip install --no-deps torchvision==0.28.0+cu130 --index-url https://download.pytorch.org/whl/cu130
systemd-run --user --unit=hermes-clef-trial --setenv=PYTHONUNBUFFERED=1 \
  ~/clef-trial/venv/bin/python3 ~/HermesAgentV5/tools/hermes-clef-server.py

# On spark: tunnel (no ufw change), then the harness. rerank needs the RAG venv (sqlite_vec).
ssh -fN -o ExitOnForwardFailure=yes -L 18089:127.0.0.1:8089 spark2
export TYPESAFE_ENDPOINT=http://127.0.0.1:18089/v1/systemone TYPESAFE_API_KEY=dummy \
       TYPESAFE_MODEL=clef-flash ARM_NAME=clef-flash
/opt/benchmark-venv/bin/python3 tools/hermes-bakeoff-typesafe.py --tasks dispatch,mcintent,guard,camera,mediajudge
/opt/hermes/venvs/rag/bin/python3 tools/hermes-bakeoff-typesafe.py --tasks rerank
```

Server facts as run:
- 205 s to load; 17.8 GiB allocated (about 25 GB as seen by `nvidia-smi`).
- About 220 ms for a warm 300-token, 3-question request.
- Identical output on repeated calls.

To clean up, kill the tunnel by PID (find it with `ss -ltnp | grep 18089`), not `pkill -f`. Then
stop the unit and remove `~/clef-trial` and the weights.

## 3. Results

All text cases are the harness's synthetic sets. Latencies are p50 on GB10.

| Task | Incumbent | Clef-flash |
|---|---|---|
| dispatch, 12-way topic routing (n=48) | **0.979** · 252 ms (`dispatch` LLM) | 0.917 · 819 ms |
| mcintent, verb level (n=38) | 0.921 · 289 ms (`dispatch` LLM) | **0.947** · 960 ms |
| guard, injection yes/no (n=36) | 0.611 · 85 ms (Prompt-Guard-2-22M, CPU) | 0.944 · 389 ms |
| guard, third arm (n=33 answered) | **0.970** · 233 ms (`dispatch` LLM, YES/NO) | — |
| rerank recall@5, podcasts (n=20) | **15/20** · 472 ms (Qwen3-Reranker-0.6B) | 11/20 · ~9.1 s |
| camera: people/vehicle/package/animal (6 frames × 4) | `omni` 2.4 s per question | 1.9 s per frame (all 4 questions); **95.8% agreement** with omni |
| mediajudge, wrong-prompt FAIL (n=12) | `omni` 12/12 · 3.6 s | 12/12 · 1.8 s |
| mediajudge, own-prompt PASS rate (n=12) | `omni` 41.7% | 75.0% |

Where Clef-flash went wrong:

- **dispatch.** It missed 4 of the 5 hard confusers, sending three to `gameadmin` and one to
  `probe`: "Did anyone get kicked…" (should be logs), "How many players are on…" (status), "Is
  192.168.1.44 up? just ping it" (status), "What does our runbook say about restarting…" (retrieve).
  Its confidence ranged from 0.42 to 0.80, so a confidence threshold would have sent some of these
  back to the LLM, but not the 0.80 one.
- **mcintent.** Both misses were messages addressed to a *different* bot ("Bob come here", "Wade
  mine some coal"), each answered at about 0.95 confidence. This matches its weak published
  When2Call score (65.6). It is confidently wrong about who a message is for, so falling back to the
  LLM when Clef is unsure would not catch these.
- **guard.** Two false positives on hard negatives ("Ignore the noise in the first minute…",
  "Forget about the zomboid server for now…"), and no false negatives.
- **mediajudge.** It is far more lenient than omni when an image comes with its own prompt. omni's
  FAIL reasons were checked and are real prompt-adherence misses (a required pose or attribute
  missing), so the leniency is a flaw, not a better judge.
- **camera.** No `labels.json` exists for the frames, so this is agreement with omni, not
  accuracy. There was one disagreement, on a vehicle question.

## 4. Findings that outlive Clef

1. **Layer-2 guard misses most injections.** Prompt-Guard-2-22M: TP 4, FP 0, **FN 14** of 18
   malicious cases, missing every indirect injection (instructions planted in retrieved text) and
   every paraphrased one. Asked the identical yes/no question, the `dispatch` LLM scored TP 15 /
   FP 1 / FN 0. This is the strongest lead from the run. Any change still has to respect the
   "control plane stays stock weights" rule and guard's per-call latency budget.
2. **The RAG eval set's fleet-docs half is stale.** KNN, the incumbent reranker and Clef all scored
   **0/24**, and the gold chunk was never in the candidate pool. Its `expected_chunk_id`s most likely
   predate a re-index. Rerank numbers are trustworthy for podcasts only until the set is rebuilt.
3. **The reranker added nothing on this run.** Incumbent recall@5 equalled KNN-only (0.341 overall,
   15/20 on podcasts), against the 0.538 → 0.705 recorded when it was introduced. That points to the
   same stale fleet-docs half, but the podcasts half also shows no reranker gain, so it is worth a
   check.
4. **Latency on GB10.** Cloudflare's H200 figures (39 ms median) do not carry over. Text decisions
   took 0.4–1 s here, slower than the resident llama.cpp `dispatch`, so Clef-flash has no speed
   argument for any text role on this hardware.

## 5. Not tested / open

- **Clef 27B.** It scores better on intent and routing benchmarks than flash (CLINC150 97.4 vs
  66.8). It needs about 54 GB at BF16, which does not fit next to the current residents on either
  node.
- **A Reolink "worth alerting?" gate.** This is the only use where Clef-flash looked competitive.
  It needs a `labels.json` beside the frames before it can be scored.

## 6. Raw data

The repo is public, so raw rows are kept off it: they contain real render prompts and camera frame
names. Results, egress payloads, both reports, both run logs, the exact harness used, and
`SHA256SUMS` are in `/mnt/nas2-hermes-backup/Private/Hermes/Benchmarks/clef-flash-2026-10-06/`.

## 7. Environment after the run

Torn down on 2026-10-07:
- `hermes-clef-trial` stopped.
- spark's tunnel killed.
- `~/clef-trial` and the venv removed.
- The 18 GB of weights deleted from `/mnt/hermes-data/models`.
- The scratch folder `/tmp/bakeoff-run` removed.

No production unit, venv, port or firewall rule was changed at any point.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-07 | Initial version — results of the 2026-10-06 Clef-flash bake-off against dispatch, mcintent, guard, rerank, camera and mediajudge, with exact serving steps and the teardown record. |
