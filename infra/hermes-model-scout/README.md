# hermes-model-scout — recreate checklist

**Version:** 1.0.0

S20's daily model-scouting pipeline: discover what's new, compare it against what each Firmament
role is actually running, and write one tracked backlog entry per candidate that a human disposes
of with a single Matrix reply. `IMPLEMENTATION_PLAN.md` S20 is the design account and the reasoning;
this file is the recipe and the operational notes.

**Status: built, deployed and live on `spark` since 2026-10-08.** Timer enabled, gate running,
first real candidate proposed and awaiting an operator decision. `S20d` (retiring
`HermesAgentV4`'s duplicate model-watch routine) is **not done** — it is gated on this running a
full week first, by its own design.

## 1. What runs

| Unit | Type | What it does |
|---|---|---|
| `hermes-model-scout.timer` | timer | daily, `06:30` + up to 600s jitter |
| `hermes-model-scout.service` | oneshot | one discovery → comparison → proposal pass |
| `hermes-model-scout-gate.service` | simple, `Restart=always` | watches FleetOps for `benchmark`/`defer`/`reject`/`override` replies |

Both services run as `pmoney` under `/usr/bin/python3` (system interpreter — **not** the RAG venv;
see §5's first finding for why that matters) through wrappers that inject secrets from Vaultwarden:

```
tools/hermes-model-scout.py              the daily pass (S20a + S20b + S20c's proposal/done half)
tools/hermes-model-scout-wrapper.sh      secrets for it
tools/hermes-model-scout-gate.py         the human decision gate (S20c)
tools/hermes-model-scout-gate-wrapper.sh secrets for it
```

## 2. One-time setup

No new Vaultwarden item is needed. Both wrappers reuse credentials that already exist:
`memory-token` (hermes-memory) and `matrix-fleetops` (password + room). The scout treats the
FleetOps pair as optional and logs its offers when it is absent; the gate requires both, because a
gate that cannot read the room has no function.

```bash
sudo cp infra/hermes-model-scout/hermes-model-scout.service \
        infra/hermes-model-scout/hermes-model-scout.timer \
        infra/hermes-model-scout/hermes-model-scout-gate.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-model-scout.timer
sudo systemctl enable --now hermes-model-scout-gate.service
```

Verify:

```bash
python3 infra/hermes-model-scout/tests/test_model_scout.py      # 92 offline checks, no network
MEMORY_TOKEN=... python3 tools/hermes-model-scout.py --dry-run  # real discovery, no writes
MEMORY_TOKEN=... python3 tools/hermes-model-scout.py --backlog   # open entries
journalctl -u hermes-model-scout-gate.service -n 20
```

## 3. The decision loop, as an operator sees it

A proposal arrives in FleetOps naming the candidate, its hardware fit, the role's **current**
backend, the fleet's own last measurement of that backend, and whether the publisher published any
claims of their own. Reply with exactly one of:

| Reply | Effect |
|---|---|
| `benchmark <task_id>` | → `approved`. The gate replies with the two-step manual procedure and the exact `--model-id` to use. It never runs the benchmark. |
| `defer <task_id>` | → `deferred`. Out of the daily notices, still in `--backlog`. |
| `reject <task_id>` | → `rejected`, **permanently**. Never re-proposed. |
| `override <task_id>` | `rejected` → `proposed`. The only way back. |

The whole message must be exactly the command — the gate's own replies are multi-line and can
never re-match as a command. Anything else gets a plain refusal naming the real state.

**`done` is never set by a reply.** `hermes-model-scout.py`'s next run sets it, and only by finding
a real row in `hermes_benchmark_common`'s own history for the prescribed `--model-id`. That is why
the gate prescribes the label: a benchmark run under a different label leaves the task reporting
`approved` forever, which is the honest answer rather than a false one.

## 4. Boundaries

- **S20a and S20c call no model.** S20b makes exactly one advisory LLM call via the router, after
  every fact is computed, and its output is never the source of any fact.
- Publisher-supplied text (card front matter, self-reported `model-index` evals) is stored and
  shown as **the publisher's own claim**, labelled, and sanitized through
  `hermes-model-scan.py`'s own `_sanitize_hf_text()` before it can reach a prompt.
- No benchmark is ever started by this pipeline. `skills/model-benchmark/SKILL.md`'s rule that
  benchmarking is foreground and human-attended is not overridden by a different caller.
- `hermes-model-scan.py` (weekly hardware-fit digest) and `hermes-model-watch.py` (weekly
  architecture/quant watch) keep running unchanged. This imports and reuses both; it replaces
  neither, and it touches neither's state file.

## 5. Findings from building and running it

Each of these cost a real failure or a real correction, in the order they were found.

1. **The system interpreter cannot read hermes-memory's database through `hermes-memory.py`.**
   `connect()` loads the sqlite-vec extension, and its own docstring says `/usr/bin/python3` cannot
   see `sqlite_vec` — which is why `hermes-attention-reminder.service` runs under
   `/opt/hermes/venvs/rag/bin/python3`. The first live dry run failed on exactly that. Listing one
   non-vector table does not justify pinning this service to the RAG venv, so `list_scout_tasks()`
   opens the file read-only with stdlib `sqlite3` instead. Cost: a direct dependency on the `tasks`
   column names, shared with `hermes-attention-reminder.py`.
2. **hermes-memory never unquotes path segments, and `urllib.parse.quote()` escapes `:` by
   default.** `GET /tasks/<id>` resolves as `parsed.path.split("/")[2]`, raw, so a percent-encoded
   colon is a different id to the server. Every task lookup 404'd. The visible symptom was a failed
   gate command; the dangerous one was silent — **dedup would have broken**, so every candidate
   would have been re-proposed and re-announced daily. Both tools now pass `safe=':'`, and the test
   suite asserts the colon survives.
3. **The benchmark history's `date` is a full ISO-8601 timestamp with an offset**
   (`2026-08-24T18:32:10+00:00`), not `YYYY-MM-DD` as this first assumed. Comparing those strings
   against a UTC-derived date skipped a same-day match — caught on the first live run of the `done`
   path, in the exact window where it matters (evening local time, where the UTC date has already
   rolled over). Dates are now parsed to real instants, with date-only values still accepted.
4. **A benchmark that ran *before* the approval must still count**, or a task where the human ran
   it first and replied second sits `approved` forever. There is a bounded 24h backdate slack, and
   when it is what matched, the `done` turn records `matched_before_approval` rather than quietly
   treating it as if it came after.
5. **Role state must come from the router's `/v1/models`, not from importing
   `hermes-router.py`.** That module calls `sys.exit()` at import when `HERMES_NODE` is unset, so
   importing it from another process is a hard exit. `/v1/models` carries the `checkpoint` and
   `abliterated` metadata 2.9.0 added for exactly this purpose. Consequence: `embed` and `rerank`
   are not in that table (the router never proxies them), so no candidate for those roles can be
   compared against a named incumbent.
6. **A candidate with no incumbent is not a swap decision, and proposing one is noise.** The first
   live run found 10 candidates in the window, of which **8 were `asr`/`tts`/`media`** — roles this
   fleet either never deployed (`asr`, `hermes-tts`; see the plan's §4.5) or serves outside the
   router (Kiln's ComfyUI). Those are now counted and reported with the reason, never proposed;
   `hermes-model-scan.py`'s weekly digest already owns "what's new this week, period". The
   architecture finding is the deliberate exception — "llama.cpp can now load X" has no incumbent
   by definition, and promoting it is the whole point of S20a's second source.
7. **GGUF-only repos always report "size unknown".** They carry no `safetensors` metadata, so
   `estimate_gguf_gb()` returns `None` and the fit line says so. That is honest, not a bug, but it
   means the first real proposal's fit line reads "check manually" — expect that for any `-GGUF`
   repo.
8. **The FleetOps room is busy.** Live traffic during this build was dominated by router notices
   from the Minecraft bots, which is precisely why the gate inherited
   `hermes-self-repair-promote-gate.py`'s bounded backward paging instead of reading a single
   fixed-size page. Also worth knowing: the router posts a truncated copy of every prompt to the
   room, so S20b's advisory prompt text appears there too.

## 6. Live verification, 2026-10-08

- 92 offline checks pass on `spark` (and on an off-fleet Windows box, no network needed).
- Real dry run against live HF, the live router and the real benchmark history.
- Real pass: one candidate proposed (`prithivMLmods/LightOnOCR-3-4B-GGUF` for `omni`), task written
  to `hermes-memory`, offer posted to FleetOps, verified by reading the room event back.
- The role-fit join read the **live** incumbent — `gemma-4-26B-A4B-it (Google, stock)` — rather
  than the Nemotron-Omni the plan's §4.2 target table still names.
- Dedup confirmed: a second real run proposed 0, skipped 1, posted nothing.
- Full gate loop driven by real Matrix replies: every legal transition, every refusal path
  (wrong state, wrong agent, unknown id), and the approval reply's content.
- `done` path driven live, with only the history row injected: an older row and an unrelated row
  both correctly left the task `approved`; the matching row moved it to `done`, wrote the turn with
  the real suite scores, posted the notice, and a second pass did not re-announce it.
- The oneshot unit ran through systemd itself (`Result=success`, `ExecMainStatus=0`).
- Test artifacts left in `rejected`/`done` rather than deleted from a live WAL database — S9's own
  orphaned-`vec_turns` incident is why hand-deleting rows there is not worth the risk.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-08 | Initial version — S20 built, deployed and live-verified on `spark`: daily timer, the gate service, the offline test suite, and the eight findings above. S20d (retiring V4's duplicate routine) deliberately still open, gated on a week of real runs. |
