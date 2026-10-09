# hermes-fleetops-ui — recreate checklist

**Version:** 2.0.0

S21. One browser page for the human-facing surfaces this fleet already has: the model-benchmark
backlog, which checkpoint backs each role, benchmark results, and the news digest's stored
highlights. Runs on **Watch (spark)** only, over **HTTPS**, Basic Auth required.

**<https://spark.tail1a534.ts.net:8103/>**

## Scope — read this before adding to it

Read-only reports, plus **one** write route: the benchmark backlog's decide buttons.

Services are still not started, stopped or restarted from here. That stays an SSH + `systemctl`
operator action, like every other privileged action in this fleet
(`tools/hermes-confirm-gate.sh` exists for that reason).

### The decide buttons, and the argument that was had about them

1.0.0 shipped with no decide buttons, arguing one would be "a second, weaker path to the same
privileged decision — shared Basic Auth against one specific Matrix sender id." **The operator
overruled that: the Matrix channel is *perceived* to be more secure rather than actually being
so.** That is a fair reading, and worth writing down rather than relitigating — the Matrix route
authenticates a sender id on a homeserver this fleet runs itself, this route authenticates a
credential on a service reachable only over the tailnet. Both reduce to one credential the operator
holds, and neither is obviously the stronger.

Three things were done rather than argued about, because they are the parts that were *not*
perceptual:

1. **CSRF.** A browser replays cached Basic Auth on a cross-origin POST; Matrix has no equivalent.
   Every decide carries a per-process token that an attacker cannot read cross-origin, and
   `Sec-Fetch-Site` is checked as a second line (allowed only to reject, never to substitute for
   the token, since curl and old clients do not send it). All four verbs are POST, so no link,
   prefetch or crawler can decide anything, and the reply is a 303 so a refresh cannot replay one.
2. **TLS.** Basic Auth used to cross the tailnet in the clear. See §1.
3. **Attribution.** This was the one genuine edge the Matrix route had, and it has been closed by
   turning it around: `tailscale serve` forwards `Tailscale-User-Login`/`-Name`, so the audit
   record names a **person** (`Paul <…>`) where the Matrix route names a sender id and Basic Auth
   alone would name nobody. Treated as attribution and never as authentication — the headers arrive
   on a loopback socket where any local process could set them, so Basic Auth still decides whether
   a request is allowed. A test asserts `_authed()` never consults them.

**So this service now holds write credentials, which 1.0.0 did not**: the shared hermes-memory
token and the FleetOps Matrix credential. No new secret was minted, but the blast radius is
genuinely larger and is stated rather than buried — `memory-token` is the fleet's single shared
token and is *not* scoped to model-scout tasks by the server. The scoping is in this code instead:
the only write it can perform is one transition from the gate's own table, on a task whose agent is
`model-scout`, after re-reading that task's current state.

### Why it imports the gate instead of reimplementing it

Two routes to one decision must not be able to disagree about what the decision means. So the
transition table, the task write, the turn write and the approval text all come from
`tools/hermes-model-scout-gate.py` itself, imported at startup. **If that import fails the buttons
are not rendered and the route refuses** — a UI that guesses at a state machine is worse than a UI
with no buttons. This file adds exactly two things: `decided_by: "fleetops-ui"` plus the clicker's
identity in the audit record, and a FleetOps notice so a decision made in a browser still lands
where the Matrix route would have announced it.

The transitions are therefore the gate's, not this page's, and a row only offers what is legal from
its state: `proposed` → benchmark/defer/reject, `deferred` → benchmark/reject, `rejected` →
override (the only way back), `approved` → nothing, because only the scout's own next run can mark
a task done. **Reject is permanent** and gets a confirmation prompt — a UX speed bump on a crowded
table, not a security control.

RAG candidates still have their own UI (`hermes-rag-discovery-portal.py`) and are only linked from
here, never proxied.

## 1. TLS, port and bind

```
browser --TLS 8103--> tailscaled --plain--> 127.0.0.1:8104 (this service)
```

**TLS is terminated by `tailscale serve`**, with a real Let's Encrypt certificate for
`spark.tail1a534.ts.net` (verified chain, HTTP/2, `notAfter` renewed by tailscaled itself). That is
why there are no certificate files, no key permissions and no renewal timer here: the fleet already
fronts the Matrix homeserver this way, and reusing the mechanism beats a second, hand-rolled one.

```bash
sudo tailscale serve --bg --https=8103 http://127.0.0.1:8104
sudo tailscale serve status          # verify; --https=8103 off  to remove
```

**Port 443 was asked for and is not available.** tailscaled already serves `/` on 443 to the Matrix
homeserver on `localhost:6167`; taking that would break Matrix clients and federation, so it was
left alone. If the port in the URL is ever worth removing, the way to do it is a *path* on 443
(`tailscale serve --set-path /fleetops …`), which needs this service to learn a base-path prefix
because serve strips it — about ten lines, not done.

**Port 8103** was verified live with `ss -ltnp` before being chosen, which mattered: the plan had
pencilled in **8101 as "the obvious next value", and 8101 is `hermes-buzz`**. Taken on spark as of
2026-10-09 — 8080 router, 8092/8093 llama-server (loopback), 8093 RAG portal (tailnet), 8095/8097
llama-server, 8096 guard, 8100 broker, 8101 buzz, 8102 memory, 8105 minecraft-rag, 443 tailscaled.

**The service itself binds `127.0.0.1:8104` and must stay there.** If it also listened on the
tailnet there would be a plaintext way in beside the encrypted one, and Basic Auth would cross the
wire in the clear for anyone who used it. It **refuses to start on `0.0.0.0` or `::`** rather than
trusting the firewall alone — S12 established that this fleet's bind addresses are the boundary.
Verified after deploy: `http://100.96.59.79:8104/health` does not connect.

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

The unit runs `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp=true` and
`NoNewPrivileges=true`, with **one** writable path: `ReadWritePaths=/home/pmoney/.hermes/state`.

That exception is not optional, and it was found by starting the service rather than by reasoning:
`usage.db` is in **WAL** mode, and a read-only SQLite connection to a WAL database still has to
take a read mark in the `-shm` sidecar, which needs write access to the directory. With the whole
tree read-only, `/models` rendered `OperationalError: unable to open database file` in its usage
section. Narrower grants were tried and genuinely do not work: systemd **rejects a single file** in
`ReadWritePaths` (exit 226/NAMESPACE), and bind-mounting the sidecars individually is impossible
because SQLite **unlinks `-shm` when the last writer closes** — the path to bind was absent
mid-test, which is exactly the flakiness that would have shipped.

Worth being precise about what the grant does and does not confer, since this page's whole premise
is that it cannot influence an approval. `/mnt/hermes-data` (`memory.db`, `vectors.db`, the RAG
store), the repo and `/etc` all stay read-only — verified by test, not assumed. **The model-scout
approval decisions this UI surfaces live in `memory.db`'s task states under `/mnt`**, so they stay
unwritable. What is in the granted directory is `model-scout-gate/state.json` (26 bytes, "a
last-seen cursor only" per the gate's own docs), the Layer-1 guard's scan log, and per-tool state
JSONs — all already writable by every other `pmoney`-owned service here, none of which is
sandboxed at all.

**Follow-up, not done here:** give `usage.db` its own directory via `HERMES_USAGE_DB`, which
`hermes_usage_log.py` already honours, and bind only that. It means editing the writers' units and
relocating a live 50MB database, which is not a change to make in passing.

## 4. What each page reads, and how it fails

Four unrelated sources back these pages, so **each section renders its own error naming its own
source** rather than one generic "report unavailable". `hermes-usage-report.py`'s 1.0.1 fix — a
missing-table crash on first run — is the concrete precedent.

| Page | Source | Note |
|---|---|---|
| `/backlog` | reads `tasks`/`turns` in `memory.db` read-only; **writes** via hermes-memory's HTTP API | **Not `GET /tasks`** — see below |
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
| 1.1.0 | 2026-10-09 | Service enabled on spark with its `fleetops-ui` vault item; all five pages verified against the real credential on the tailnet address. Records the one sandbox exception the first real start forced — `usage.db` is WAL, so a read-only connection still needs write access for its `-shm` read mark — and why the two narrower grants are not available (systemd rejects a single file in `ReadWritePaths`; SQLite unlinks `-shm` when the last writer closes, so the sidecars cannot be bind-mounted). States what the grant does not confer: the approvals live in `memory.db` under `/mnt`, which stays read-only. |
| 2.0.0 | 2026-10-09 | **Major — reverses this file's own "no decide buttons" position, on the operator's decision that the Matrix channel is only *perceived* to be more secure, and adds TLS.** The backlog now has approve/defer/reject/un-reject buttons that write the same transition through the same code as the Matrix reply, by importing `hermes-model-scout-gate.py` rather than restating its state machine — failing closed if that import fails. Records the three non-perceptual things that were handled instead of argued about: CSRF (a browser replays Basic Auth cross-origin; Matrix has no equivalent), TLS via `tailscale serve` with a real Let's Encrypt cert, and attribution — `Tailscale-User-Login` now names a person in the audit record, closing the one genuine edge the Matrix route had, while never being used for authentication. States plainly that the service now holds write credentials it did not before. Port 443 was asked for and refused: tailscaled serves the Matrix homeserver there. |
