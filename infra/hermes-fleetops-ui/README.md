# hermes-fleetops-ui — recreate checklist

**Version:** 1.0.0

S21. One browser page for the human-facing surfaces this fleet already has: the model-benchmark
backlog, which checkpoint backs each role, benchmark results, and the news digest's stored
highlights. Runs on **Watch (spark)** only, bound to its tailnet IP, Basic Auth required.

## Scope — read this before adding to it

**Links and read-only reports. Not a control plane.** "Process management" names what the page is
*for*, not a promise that it starts, stops or restarts anything. Starting and stopping services
stays an SSH + `systemctl` operator action, the same as every other privileged action here already
requires an explicit human step rather than a button — `tools/hermes-confirm-gate.sh` exists for
exactly that reason.

**It adds zero new privileged write surface.** No `do_POST`/`do_PUT`/`do_DELETE` exists, and every
store is opened `mode=ro` through one helper. The two approval flows it surfaces each already have
their own write path, reasoned about separately: RAG candidates through
`hermes-rag-discovery-portal.py`, and the benchmark backlog through the Matrix reply
`hermes-model-scout-gate.py` watches for. **A decide button here would be a second, weaker path to
the same privileged decision** — this page's shared Basic Auth against one specific Matrix sender
id — which is the structural shortcut this fleet's confirm-gate design refuses. The one convenience
offered on an `approved` row copies a command to the clipboard and triggers nothing; the offline
test asserts the page contains no `fetch(` and no `<form>` on that path.

## 1. Port and bind

**Port 8103.** Verified live with `ss -ltnp` on spark before being chosen, which mattered: the plan
had pencilled in **8101 as "the obvious next value" and 8101 is `hermes-buzz`**. Taken on spark as
of 2026-10-09 — 8080 router, 8092/8093 llama-server (loopback), 8093 RAG portal (tailnet),
8095/8097 llama-server, 8096 guard, 8100 broker, 8101 buzz, 8102 memory, 8105 minecraft-rag.
8103 and 8104 are referenced nowhere in the repo; 8103 is this.

Bind defaults to `100.96.59.79`, spark's own tailnet address. **The service refuses to start on
`0.0.0.0` or `::`** rather than trusting the firewall alone — S12 established that this fleet's
bind addresses are the security boundary.

## 2. Vaultwarden item — its own, not the RAG portal's

One item per service is the convention here (`memory-token`, `buzz-token`, `email-sintra`). A
shared Basic Auth realm across two independently-reasoned-about services would mean one leaked
credential opens both. **Operator step — needs an unlocked `bw` session:**

```bash
S="$(bw unlock --raw)"
ORG="$(bw list organizations --session "$S" | jq -r '.[0].id')"
COLL="$(bw list collections --session "$S" | jq -r '.[0].id')"
PW="$(openssl rand -base64 24)"
jq -n --arg org "$ORG" --arg coll "$COLL" --arg pw "$PW" \
  '{organizationId:$org, collectionIds:[$coll], folderId:null, type:1, name:"fleetops-ui",
    favorite:false, login:{username:"fleetops", password:$pw}}' \
  | bw encode | bw create item --session "$S"
```

Verify before starting the service, since the wrapper fails closed and `set -euo pipefail` will
stop it with a vault error rather than a useful one:

```bash
./tools/vault-get-secret.sh fleetops-ui username   # -> fleetops
./tools/vault-get-secret.sh fleetops-ui password   # -> the generated password
```

## 3. Install

```bash
sudo cp infra/hermes-fleetops-ui/hermes-fleetops-ui.service /etc/systemd/system/
sudo ufw allow from 100.64.0.0/10 to any port 8103 comment 'hermes-fleetops-ui (tailnet)'
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-fleetops-ui
curl -s -u fleetops:"$PW" http://100.96.59.79:8103/ | head -5
```

The unit runs `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=` (empty) and
`NoNewPrivileges=true`. It reads four stores and writes nowhere, so that is enforced by systemd as
well as asserted in the code.

## 4. What each page reads, and how it fails

Four unrelated sources back these pages, so **each section renders its own error naming its own
source** rather than one generic "report unavailable". `hermes-usage-report.py`'s 1.0.1 fix — a
missing-table crash on first run — is the concrete precedent.

| Page | Source | Note |
|---|---|---|
| `/backlog` | `tasks`/`turns` in `memory.db`, read-only sqlite3 | **Not `GET /tasks`** — see below |
| `/models` | `GET {router}/v1/models`, live per page load | checkpoint, abliterated, host, residency |
| `/models` | `usage_log` in `usage.db`, counted in SQL | two trailing 7-day windows, no commentary |
| `/benchmarks` | the NAS `history.jsonl` + local fallback | same two paths the benchmark tooling writes |
| `/highlights` | `news_digest_daily` in `vectors.db` | every stored rank, not just the emailed top 20 |

**The plan was wrong about the backlog source and the code follows the store, not the plan.** S21b
said to read the scout's tasks with "the same `GET /tasks` shape `hermes-self-repair-status.py`
already queries" — but `hermes-memory`'s `/tasks` is **POST-only** (upsert), there is no list route,
and `hermes-self-repair-status.py` only ever fetches one task by id. `hermes-model-scout.py`'s own
`list_scout_tasks()` had already established the answer and the reason: read the one non-vector
table read-only with stdlib sqlite3, because `hermes-memory.connect()` loads sqlite-vec and
`/usr/bin/python3` cannot see that extension. This page does the same, off the same `MEMORY_DB`
env var. The cost is a shared dependency on the `tasks`/`turns` column names across three tools —
a schema change breaks all three in the same place, loudly.

**Benchmark entries hold several suites, not one.** A history row is
`{model_id, date, role_or_endpoint, suites: {<name>: {metric, value}}, notes}` — the `value` key is
the score, which is what `hermes-benchmark-compare.py` reads off the same file. A `0.0` is a real
measurement and renders as a number; a `null` is a suite that was attempted and produced nothing
and says so. Both cases are pinned by the offline test, because the first draft assumed one suite
and a `scores` blob per row and would have collapsed them.

**Everything rendered is escaped.** Not decoration: these pages show Hugging Face repo ids and
advisory text derived from model cards — anyone can publish a repo saying anything — plus
LLM-written digest highlight lines. Responses also carry
`Content-Security-Policy: default-src 'none'` and `X-Frame-Options: DENY`.

## 5. Tests

`tests/test_fleetops_ui.py` — 64 offline checks, no network, no live store, no socket bound. The
fixtures are the real schemas read off the live stores on 2026-10-09, because the first draft got
two of them wrong from the plan's own prose. Also asserts the things that are easy to break
silently: that the NAS and local history paths still equal `hermes_benchmark_common`'s own
constants (the whole point of "exactly one history, never a second copy drifting"), that a write
through this service's connection is refused, that a missing store raises instead of being created
empty, and that no write handler exists.

```bash
python3 infra/hermes-fleetops-ui/tests/test_fleetops_ui.py
```

## 6. Known state at first deploy

`/highlights` renders an explanatory box rather than a table, because `news_digest_daily` is empty.
That is **not** a bug in this page: S27g found the digest's own unconditional `DELETE` was wiping
the day's highlights on any later run that found nothing, and its "since last run" retrieval was
post-filtering a 57-chunk window out of 97,751 and seeing zero. Both are fixed; the table fills on
the next daily run. S21e's own risk 4 predicted exactly this — "its first real page-load is also
its first live test of the schema, not a known-good read."

`/backlog` shows 80 candidates with **empty advisories**, for a related reason: the scout's
narrative call was itself being blocked by Layer 2 until S27f exempted it (the guard report has it
at 06:41 on 2026-10-09). The page prints "none recorded" rather than a blank cell so the two cases
stay distinguishable. Advisories appear on the next scout run.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-09 | Initial version — S21a-e built and verified live on spark: port 8103 chosen against a live `ss -ltnp` after 8101 turned out to be `hermes-buzz`, the backlog source corrected from the plan's `GET /tasks` to a read-only sqlite read, benchmark `suites`/`value` schema corrected from the plan's assumed `scores` blob, and all five pages fetched returning HTTP 200 with zero section errors. 64 offline checks. |
