# hermes-fleetops-ui — recreate checklist

**Version:** 2.9.0

S21. One browser page for the human-facing surfaces this fleet already has: the model-benchmark
backlog (now leading with a "Recommended for benchmarking" section), which checkpoint backs each
role, benchmark results, the news digest's stored highlights, curated benchmark-driven model-swap
recommendations, Market Watch, and security/integrity recommendations written by the fleet's
scanners. Runs on **Watch (spark)** only, over **HTTPS**, Basic Auth required.

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

### Multi-select

With 77 candidates sitting in `proposed`, one decision per page load is not a workflow, so the
table takes checkboxes and a bulk bar (repeated above and below, because it is 80 rows long):
select all / none, a live count, and one submit button per verb.

**Multi-select is a rendering convenience and deliberately not a bulk write.** Every selected task
still goes through the same per-task guard — re-read the task, check it belongs to `model-scout`,
check the verb is legal from the state it is in *now* — so a selection that mixes states does the
legal part and reports the rest rather than failing whole or forcing anything through. A row with
no legal transition (`approved`, or anything while the gate is unavailable) gets **no checkbox at
all**, so it cannot be swept into an action it was never eligible for.

The outcome comes back as a count per clause (`3 applied · 1 skipped, not legal from its current
state`). It travels in the URL as **codes and integers only**, every value through `int()`, so a
hand-edited URL can at worst show a wrong number and never put text on the page.

HTML forms cannot nest, which has one visible consequence: there is now **one** form around the
whole table instead of three buttons per row, each row lists its legal verbs as text, and the
copy-command button had to become `type="button"` — inside a form, a `<button>` submits by default.

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
| `/backlog` | `published` column from the candidate turn's `created_at` | date plus age; under a week is flagged |
| `/backlog` (top section) | `recommendation()`, computed over the same `tasks`/`turns` read | "Recommended for benchmarking" — see below |
| `/models` | `GET {router}/v1/models`, live per page load | checkpoint, abliterated, host, residency |
| `/models` | `usage_log` in `usage.db`, counted in SQL | two trailing 7-day windows, no commentary |
| `/benchmarks` | the NAS `history.jsonl` + local fallback | same two paths the benchmark tooling writes |
| `/highlights` | `news_digest_daily` in `vectors.db` | every stored rank, not just the emailed top 20 |
| `/recommendations` | `tasks`/`turns` in `memory.db`, `id LIKE 'REC-%'` | read-only; keyed by id prefix, not an agent list — see below |
| `/recommendations` (top section) | `MODEL_SWAP_RECOMMENDATIONS`, a curated constant in the module itself | **not** read from a live store — see below |

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

**The "Current" table's role filter and `value/highest` column both key off `role_or_endpoint`,
not `model_id`.** Every eval tool writes that field as the fleet ROLE it is scoring a candidate
*for* — `hermes-vision-judge-eval.py` always writes `"omni"`, whether the real `omni` incumbent or
a staged replacement candidate is actually behind the endpoint being measured. Grouping by
`(role, suite, metric)` across every model's latest result is therefore exactly "every result
anyone has recorded for this role's suite": the role filter narrows to one such group, and a row's
`/highest` is the best value in that same group, even when that happens to be the row's own value.

**`/backlog` leads with "Recommended for benchmarking"**, direct operator request: every
`approved` candidate, plus any still-`proposed` one whose own stored facts — hardware fit, an
existing GGUF build, published formal eval numbers — clear a deterministic bar,
`hermes_benchmark_common.is_promising()` (new in `bc` 1.4.0). Deliberately never reads
`advisory_narrative`: that paragraph is LLM-written from these same facts and is documented
elsewhere as never a source of fact, so it is not one here either. `hermes-model-scout.py` 1.4.0
stamps the verdict onto every new candidate's turn at proposal time — `recommended` /
`recommended_reason` — and names it in the Matrix offer too, so the list grows on its own with
each daily scout run without this page having to recompute anything for a new candidate.
`recommendation()` falls back to calling `is_promising()` live only for a candidate proposed
before that field existed, by the exact same function, so an old row and a new one are never
judged by two different rules. An `approved` candidate is never re-judged by the heuristic — a
human already decided. The main backlog table also gets a small "★ recommended" badge next to any
qualifying `proposed` row, so the two views agree at a glance.

**The model-swap section at the top of `/recommendations` is curated, not queried.** Every other
section on these pages reads a store the fleet already writes to; there is no live store yet for
"a staged candidate beat the real incumbent on a benchmark suite", so `MODEL_SWAP_RECOMMENDATIONS`
is a hand-maintained list in `hermes-fleetops-ui.py` itself, sourced from the S39 spark2
candidate-benchmark run's own outperformance findings
(`infra/model-benchmark/spark2-candidate-results.md`). The page says so plainly, in the same
sentence that tells the reader to re-verify against that doc and the live role before acting —
this fleet's role assignments are confirmed to drift from their own service descriptions. Update
the list in the same change that records a new outperformance finding in that doc.

**Everything rendered is escaped.** Not decoration: these pages show Hugging Face repo ids and
advisory text derived from model cards — anyone can publish a repo saying anything — plus
LLM-written digest highlight lines. Responses also carry
`Content-Security-Policy: default-src 'none'` and `X-Frame-Options: DENY`.

## 5. Content-Security-Policy, and the handlers it was silently blocking

Responses carry `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-<per response>';
form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, plus `X-Frame-Options: DENY` and
`Referrer-Policy: no-referrer`.

**That policy was already there in 1.0.0 and it was quietly breaking the page.** With
`default-src 'none'` and no `script-src`, inline `onclick`/`oninput`/`onsubmit` attributes are
blocked outright — so the copy-command button and the benchmark filter box did nothing at all in a
browser, with no error anywhere a human would look. Found by reading the response headers rather
than by using the page. Attributes cannot carry a nonce (only elements can), so every handler moved
into **one** delegated `<script>` block that does carry one, and a test asserts no `on*=` attribute
ever comes back.

`form-action 'self'` is worth noting separately: it is a second, independent brake on the write
route, since even with a stolen CSRF token a form on someone else's page cannot target this origin.

## 6. Tests

`tests/test_fleetops_ui.py` — 292 offline checks, no network, no live store, no socket bound. The
fixtures are the real schemas read off the live stores on 2026-10-09, because the first draft got
two of them wrong from the plan's own prose. Also asserts the things that are easy to break
silently: that the NAS and local history paths still equal `hermes_benchmark_common`'s own
constants (the whole point of "exactly one history, never a second copy drifting"), that a write
through this service's connection is refused, that a missing store raises instead of being created
empty, and that no write handler exists.

```bash
python3 infra/hermes-fleetops-ui/tests/test_fleetops_ui.py
```

## 7. Known state at first deploy

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

**`/recommendations` found a real, large, pre-existing problem on first load, not a page bug.**
`memory.db` holds 227,116 `REC-*` tasks as of 2026-10-09 — 139,853 still `pending`, going back to
2026-09-07 — the overwhelming majority `aide` findings against inherently rotating paths on
`spark`/`spark-2` (e.g. `/var/log/sysstat/sa<DD>`, sysstat's own daily-named activity log) that
were never excluded from `hermes-node-baseline-scan.py`'s aide config, the same class of gap S29
independently found and fixed for LinodeMercury's own tooling/log/apt-cache directories. A naive
`ORDER BY updated_at DESC LIMIT 400` with no state filter spends its entire cap on whichever node
is churning fastest *right now* and buries every other node's genuinely open findings — confirmed
live: that query's top 400 was 388 rows of `spark-2` history and 12 of LinodeMercury's, with
`spark`'s own currently-pending findings nowhere in the window. Fixed by filtering `state !=
'resolved'` **in SQL**, not after the cap, with a separate `COUNT(*)` so the page's "showing N of
total" is never a lie about scale, and an explicit `state=all` escape hatch to see the resolved
history anyway. **Not fixed here, and a real follow-up**: the root cause on spark/spark-2 (the
missing aide excludes) and the 139,853-row pending backlog itself — this page surfaces the
problem honestly, it does not clean it up.

## Decide availability, and the five failures of 2026-10-16

The operator selected five candidates, clicked, and got `?writefail=5`. Both halves of that
message were wrong: the failure was a **401 on the task lookup**, and no write was ever attempted.

**Cause.** The service had been running since 2026-10-11 17:07, started minutes after a reboot
while the vault was under lock contention. This wrapper fetches `MEMORY_TOKEN`,
`FLEETOPS_MATRIX_TOKEN` and `FLEETOPS_ROOM` with `|| true` so a vault hiccup degrades the decide
buttons rather than taking the whole page down. All three fetches failed. Basic Auth survived
because those two fetches are not guarded that way. The page kept working — the backlog reads
`memory.db` directly over sqlite — so **reads were fine and only writes failed**, for five days,
visible only as a `DISABLED` word in a startup line nobody re-reads.

**Three fixes, 2.3.0.**

1. **The page no longer offers what it cannot do.** `decide_unavailable()` is checked at render
   time: with no `MEMORY_TOKEN`, or no gate module, the checkboxes and buttons are **not rendered**
   and a banner says why and that the reports are unaffected. A page must not offer an action it
   already knows will fail.
2. **A read failure is no longer called a write failure.** `unauthorized` (401/403), `readfail`
   and `notoken` are distinct outcomes, and each says plainly that nothing was written.
3. **Every outcome leaves a journal line.** The old 401 branch returned bare, so the journal held
   only a `303` — the action and the candidate list could not be recovered afterwards and the
   operator's selection could not be replayed. The route now logs the requested action and task
   ids before acting, and the result counts after.

**The `|| true` stays**, because the reports are most of this service's value and a vault hiccup
should not take them down. What changes is that the degradation is now loud at the point of use
rather than silent. A restart re-fetches the credentials.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-09 | Initial version — S21a-e built and verified live on spark: port 8103 chosen against a live `ss -ltnp` after 8101 turned out to be `hermes-buzz`, the backlog source corrected from the plan's `GET /tasks` to a read-only sqlite read, benchmark `suites`/`value` schema corrected from the plan's assumed `scores` blob, and all five pages fetched returning HTTP 200 with zero section errors. 64 offline checks. |
| 1.1.0 | 2026-10-09 | Service enabled on spark with its `fleetops-ui` vault item; all five pages verified against the real credential on the tailnet address. Records the one sandbox exception the first real start forced — `usage.db` is WAL, so a read-only connection still needs write access for its `-shm` read mark — and why the two narrower grants are not available (systemd rejects a single file in `ReadWritePaths`; SQLite unlinks `-shm` when the last writer closes, so the sidecars cannot be bind-mounted). States what the grant does not confer: the approvals live in `memory.db` under `/mnt`, which stays read-only. |
| 2.0.0 | 2026-10-09 | **Major — reverses this file's own "no decide buttons" position, on the operator's decision that the Matrix channel is only *perceived* to be more secure, and adds TLS.** The backlog now has approve/defer/reject/un-reject buttons that write the same transition through the same code as the Matrix reply, by importing `hermes-model-scout-gate.py` rather than restating its state machine — failing closed if that import fails. Records the three non-perceptual things that were handled instead of argued about: CSRF (a browser replays Basic Auth cross-origin; Matrix has no equivalent), TLS via `tailscale serve` with a real Let's Encrypt cert, and attribution — `Tailscale-User-Login` now names a person in the audit record, closing the one genuine edge the Matrix route had, while never being used for authentication. States plainly that the service now holds write credentials it did not before. Port 443 was asked for and refused: tailscaled serves the Matrix homeserver there. |
| 2.1.0 | 2026-10-09 | Multi-select on the backlog, on operator request: checkboxes, a bulk bar above and below, select all/none and a live count — a rendering convenience only, since every selected task still goes through the same per-task guard and a row with no legal transition gets no checkbox. Outcomes return as a count per clause, carried in the URL as codes and integers so nothing from a URL is rendered as text. **Also fixes a defect the CSP had been hiding since 1.0.0**: `default-src 'none'` with no `script-src` blocks inline event handlers, so the copy-command button and the benchmark filter never worked in a browser; all handlers moved into one nonced, delegated script block, with `form-action 'self'` added as a second brake on the write route. 167 offline checks. |
| 2.2.0 | 2026-10-09 | Backlog shows **how old each candidate is** — publish date plus a relative age, flagged under a week, from the `created_at` the scout now carries (it used to fetch HF's `createdAt`, filter on it and drop it, so all 51 live candidates had no date). The `fit` cell also states how the size was established (`gguf-metadata` vs `safetensors`), since it reads as a measurement either way. |
| 2.3.0 | 2026-10-09 | **New `/recommendations` page (S21h)**, direct request: surface every `REC-<node>-<date>-<seq>` security/integrity finding written to hermes-memory by `hermes-node-baseline-scan.py` (spark/spark-2/HomeD13, S17) and `hermes-linodemercury-watch.py` (LinodeMercury, S29) — keyed by the `REC-` id prefix rather than an agent allowlist, so a future producer needs no code change here. Read-only; no new write route. **Found a real, large pre-existing problem on first load**: 227,116 `REC-*` rows, 139,853 still pending since 2026-09-07, overwhelmingly `aide` noise against unexcluded rotating paths (`/var/log/sysstat/sa<DD>`) on spark/spark-2 — the same class of gap S29 independently found for LinodeMercury's own directories. A naive capped query buried every node but whichever was churning fastest *right now*; fixed by filtering `state != 'resolved'` in SQL by default (not after the cap), with a separate true-total `COUNT(*)` so "showing N of total" is never misleading, and an explicit `state=all` option to see resolved history anyway. 201 offline checks (19 new). |
| 2.4.0 | 2026-10-16 | Decide availability is now checked at render time and the buttons are hidden with a reason when `MEMORY_TOKEN` or the gate module is missing — after the service ran five days with an empty token from a post-reboot vault failure, rendering buttons that could not work. A 401 on the task lookup no longer reports as `writefail`: `unauthorized`, `readfail` and `notoken` are distinct and each states that nothing was written. Every decide outcome now logs, and the route logs the action and candidates it was asked to apply — the old 401 branch returned bare, leaving only a `303` in the journal. 226 offline checks. |
| 2.5.0 | 2026-10-25 | Direct operator request: `/recommendations` now leads with a "Recommended model swaps" section, ahead of the existing `REC-<node>` security findings, surfacing the S39 spark2 candidate-benchmark run's own outperformance findings (`infra/model-benchmark/spark2-candidate-results.md`) — GLM-4.7-Flash vs. the retired-but-still-resident `coder2`, Hermes-4.3-36B vs. `super` on log-analysis, Nemotron-3.5-Bolt-74B vs. `omni` on vision-judging, and Nemotron-3-Nano-Omni-30B vs. `muse` on persona/override-resistance. `MODEL_SWAP_RECOMMENDATIONS` is a curated constant, not a queried store — there is no live store yet for "a candidate beat an incumbent" the way there is for every other section here, and the page says so plainly, pointing back at the source doc and warning that role assignments on this fleet are confirmed to drift from their own service descriptions. 240 offline checks (14 new). |
| 2.6.0 | 2026-10-25 | New `/market` page (S38i), direct operator request ("add a formatted report to the Fleetops-ui"), fulfilling `MARKET_WATCH_DESIGN.md` §9's deferred "browsable report history" now that S38a-h's real data exists to browse. A date-picked, filterable daily-report table re-sorted into the fixed `REPORT_SECTION_ORDER` (not the table's own alphabetical `item_type` order), read via `hermes_market_common.read_report_items()` — the same function the daily email, Matrix notice and a `market report` gate reply already render from, so this page can never show different numbers for the same day. Plus a read-only "Pending tag candidate proposals" section over S38h's `tag_proposals` table, framed the same "deciding stays a Matrix reply, not a button here" way `/recommendations` already frames its own findings. No new write route. 19 new offline checks (259 total). *(Backfilled into this changelog; the commit itself is `e30746a`.)* |
| 2.7.0 | 2026-10-25 | Direct operator request: `/benchmarks`' "Current" table gets a role filter, a high-to-low score sort, and the value column now shows `value/highest` whenever a higher score for the exact same role/suite/metric has been recorded by any `model_id`. Grouped by `(role_or_endpoint, suite, metric)` rather than suite/metric alone — every eval tool writes `role_or_endpoint` as the fleet ROLE it is scoring a candidate *for*, regardless of which `model_id` is actually behind the endpoint (`hermes-vision-judge-eval.py` always writes `"omni"`), so this is exactly "every result anyone has recorded for this role's suite", computed off the same latest-per-model snapshot the table already builds. `fmt_value()` gained an optional `best` parameter (default `None`, so `render_history_all()`'s own per-run summary and the pre-existing single-argument offline tests are unaffected); `page_benchmarks()` now takes `query` like every other page here. 11 new offline checks. |
| 2.8.0 | 2026-10-25 | Direct operator request to enhance `/market`'s "detail" column: every ticker-level line (movers, 30-day trend, the two AI-watch sections) names the registered company in parens right after its ticker (`"MSFT (Microsoft) rose..."`), via a FleetOps-UI-only cosmetic splice (`with_company_name()`) that never touches the stored `report_items.text` the email/Matrix/gate paths also render from. Sector/tag-trend rows are excluded by an item-type allowlist, not just the splice's own guard. The daily report's single flat table (one row per item, a repeated "section" column) is now one table per section, each under its own divider/title, with "#" (rank) leading each section's own columns. The row-count cap now counts across all sections combined. 19 new offline checks. |
| 2.9.0 | 2026-10-25 | Direct operator request: `/backlog` now leads with a "Recommended for benchmarking" section — every `approved` candidate, plus any still-`proposed` one whose own stored facts clear `hermes_benchmark_common.is_promising()`'s deterministic bar (new in `bc` 1.4.0), never the advisory narrative. `hermes-model-scout.py` 1.4.0 stamps that verdict onto every new candidate's turn at proposal time, so the list grows on its own with each daily run; `recommendation()` falls back to the live heuristic only for a candidate proposed before that field existed, so the two can never disagree. The main table also gets an inline "★ recommended" badge on a qualifying `proposed` row. 13 new offline checks (292 total). |
