# hermes-rag — recreate checklist

**Version:** 1.0.1

Ordered steps to stand up Phase 30's RAG infrastructure (`IMPLEMENTATION_PLAN.md` §7) from scratch: the
shared vector store, both embedding backends, all four corpus ingesters, the query tool, hourly source
discovery, and the browser review portal (Phase 33). Written after the fact — every piece here has been
built, deployed, and live-verified already (§7's Phase 30/31/33 entries); this file existed as the one gap
flagged and left open at the time (`IMPLEMENTATION_PLAN.md` 4.73.0's revision-history entry).

**One shared venv, one shared database.** Every script below (`hermes-rag-query.py`, all four
`hermes-rag-ingest-*.py`, `hermes-rag-source-discovery.py`, `hermes-news-digest.py`,
`hermes-rag-discovery-portal.py`) imports `tools/hermes_rag_common.py` and runs under
`/opt/hermes/venvs/rag/bin/python3` — one venv, not one per tool. All of them read/write the same file,
`/mnt/hermes-data/rag/vectors.db` (SQLite + the `sqlite-vec` extension), which lives inside the Spark's
LUKS container.

## 0. Components

| Component | Host | What it is |
|---|---|---|
| `hermes-embed.service` | Spark | Resident llama.cpp server, Qwen3-Embedding-0.6B-Q8_0, `127.0.0.1:8092` — query-time embedding for every reader (query tool, news digest, all ingesters running on the Spark) |
| `hermes-embed-homed13.service` | HomeD13 | A second, independent instance of the same model, own build (x86_64+CUDA vs. the Spark's aarch64) — bulk-ingestion embedding for the podcast backfill, kept off the Spark's shared bus |
| `hermes-embed-worker.service` | HomeD13 | Pulls `embed`-typed jobs from the broker, calls the HomeD13 backend above, reports back — the only consumer of `hermes-embed-homed13.service` |
| `hermes-rag-ingest-docs.{service,timer}` | Spark | 30b — fleet-docs corpus (this repo's own `.md` files) |
| `hermes-rag-ingest-podcasts.{service,timer}` | Spark | 30c — podcast-archive corpus, broker-routed bulk embedding to HomeD13 |
| `hermes-rag-ingest-ops.{service,timer}` | Spark | 30e — ops corpus (`hermes-node-health.py`'s own latest snapshot per identity) |
| `hermes-rag-ingest-kb.{service,timer}` | Spark | 30f — personal-KB corpus, `RAGDocs` NAS share |
| `hermes-rag-source-discovery.{service,timer}` | Spark | 30h — hourly scan of newly-indexed chunks for external-resource mentions, via `super` |
| `hermes-rag-discovery-portal.service` | Spark | Phase 33 — browser review UI for 30h's candidates, plus (1.4.0) a `topics.yaml` editor for Phase 31 |
| `hermes-rag-query.py` | either | No service — a CLI, called directly or via `skills/rag-query/SKILL.md` |
| `hermes-news-digest.py` | Spark | Phase 31 — not part of this directory (`infra/hermes-news-digest/`), but reads the same `vectors.db` via `hermes_rag_common.search()` |

## 1. The venv

```bash
sudo mkdir -p /opt/hermes/venvs
sudo python3 -m venv /opt/hermes/venvs/rag
sudo /opt/hermes/venvs/rag/bin/pip install -r requirements.txt sqlite-vec
sudo chown -R pmoney:pmoney /opt/hermes/venvs/rag
```

**`sqlite-vec` is not listed in `requirements.txt`** despite `hermes_rag_common.py`'s `connect()` doing a
real `import sqlite_vec` — a genuine gap, flagged here rather than silently patched into `requirements.txt`
while a separate, concurrent session had that exact file open mid-edit (adding `.epub` support the same day
this README was written). Install it explicitly until that's reconciled; if `requirements.txt` gains it
later, this line becomes redundant, not wrong.

**Spark-only.** HomeD13 runs `hermes-embed-worker.py` under plain system `python3`, not this venv — its own
header comment says so explicitly, and it's true: the only thing it calls from `hermes_rag_common.py` is
the stateless `rag.embed()` HTTP helper, which needs nothing beyond the standard library.
`hermes_rag_common.connect()` (the function that actually needs `sqlite_vec`) is never reached from that
script. Every other script in the table above runs on the Spark and does need this venv.

## 2. The database directory

Same LUKS-container caveat as `hermes-broker`'s own `jobs.db` (`infra/hermes-broker/README.md` §2) — the
mount root is root-owned:

```bash
sudo mkdir -p /mnt/hermes-data/rag
sudo chown pmoney:pmoney /mnt/hermes-data/rag
```

`hermes_rag_common.connect()` creates `vectors.db` itself (schema + the `vec_chunks` virtual table) on
first non-readonly open — no separate init step. **Every service below that touches this file will fail to
start until `hermes-unlock.sh` has unlocked the container after a reboot** — `RequiresMountsFor` makes them
wait rather than crash-loop, same as `hermes-broker.service`.

## 3. Embedding backends

**Spark** (query-time, port 8092, used by every reader on this host):

```bash
sudo cp hermes-embed.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-embed
```

`start-embed.sh` points at `/mnt/hermes-data/models/Qwen3-Embedding-0.6B-Q8_0.gguf` — verify that file
exists (or re-download; `IMPLEMENTATION_PLAN.md` §7 Phase 30's revision-history entry has the real, verified
HF source) before enabling.

**HomeD13** (bulk-ingestion, its own build, its own port 8092 — no host collision since these are two
different machines):

```bash
sudo cp hermes-embed-homed13.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-embed-homed13

sudo cp hermes-embed-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-embed-worker
```

`start-embed-homed13.sh` points at `/opt/llama.cpp/models/Qwen3-Embedding-0.6B-Q8_0.gguf` — a **different
path** from the Spark's copy above; don't assume they're symlinked or shared.

## 4. Ingesters (four corpora, one pattern each)

Each ingester is a `Type=oneshot` service plus a daily catch-up `.timer`. Install both together per corpus:

```bash
for name in hermes-rag-ingest-docs hermes-rag-ingest-podcasts hermes-rag-ingest-ops hermes-rag-ingest-kb; do
  sudo cp "$name.service" "$name.timer" /etc/systemd/system/
done
sudo systemctl daemon-reload
sudo systemctl enable --now \
  hermes-rag-ingest-docs.timer hermes-rag-ingest-podcasts.timer \
  hermes-rag-ingest-ops.timer hermes-rag-ingest-kb.timer
```

Staggered on purpose (06:45 / 06:50 / 06:57 / 06:59) — sequential, not simultaneous, since they share one
`vectors.db` and one embedding backend. Run any one manually first to confirm before trusting the timer:

```bash
sudo -u pmoney /opt/hermes/venvs/rag/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-rag-ingest-docs.py --repo /home/pmoney/HermesAgentV5 --dry-run
```

**`hermes-rag-ingest-podcasts.service` needs `TimeoutStartSec=21600`** (6 hours) — a full backfill run over
~1150 real transcripts is slow; the daily catch-up run afterward is fast (only new/changed files), but the
generous timeout stays in the unit permanently rather than being tuned down, since a future re-backfill
(a corpus reset, a parser rewrite) would hit the same wall again otherwise.

`hermes-rag-ingest-kb.py`'s `RAGDocs` root (`/mnt/nas2-hermes-backup/RAGDocs`) is a NAS share — confirm the
NFS mount is live before enabling its timer, same `RequiresMountsFor`-style caveat as the database itself,
though this one isn't declared in the unit (the NAS mount predates Phase 30 and is assumed already mounted
fleet-wide, unlike the LUKS container which is Spark-specific and unlock-gated).

## 5. Source discovery (Phase 30h)

```bash
sudo cp hermes-rag-source-discovery.service hermes-rag-source-discovery.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-rag-source-discovery.timer
```

Read-only against the RAG corpora, write-only against its own `discovery_candidates` table — never
acquires or indexes a resource itself. Boss review happens via the CLI (`hermes-rag-source-discovery.py
list` / `decide`) or the portal below; either way calls the same `hermes_rag_common.decide_candidate()`.

## 6. Review portal (Phase 33)

**Vault item first** — `PORTAL_USER`/`PORTAL_PASSWORD` come from Vaultwarden, not this repo:

```text
Vaultwarden → Fleet-Service collection → New item → Login
  name: rag-discovery-portal
  username: <pick one>
  password: <generate one>
```

```bash
sudo cp hermes-rag-discovery-portal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-rag-discovery-portal
```

**No `ufw` rule needed or present for port 8093** — checked against the Spark's real, live ruleset while
writing this (`sudo ufw status verbose`) rather than assumed: only `22`/`6167`/`8100`/`8101` have explicit
allow rules, all scoped to `10.129.1.0/24` (the LAN). The portal instead binds `100.96.59.79:8093` — the
Spark's own tailnet IP — and never `0.0.0.0` (see the script's own module docstring), so LAN/internet
interfaces can't route to it at all regardless of `ufw`; reachability over the tailnet comes from
`tailscaled`'s own interface-scoped netfilter handling of `tailscale0`, the same mechanism
`infra/muncraft-tailscale-ext/README.md`'s design notes describe for why `--netfilter-mode=off` matters on
a *second* instance. Don't add a `ufw` rule for this port by analogy with `hermes-broker`/`hermes-buzz`
above — those bind the LAN IP and genuinely need one; this one doesn't and adding one would be a no-op at
best.

Reach it at plain `http://100.96.59.79:8093/` — HTTP Basic Auth prompts immediately; the Vaultwarden item
above is what it checks against.

**Two tabs as of 1.4.0:** "Candidates" (30h's review queue, the portal's original purpose) and "Topics of
Interest" (a plain-text editor for `infra/hermes-news-digest/topics.yaml`, Phase 31 — round-trips the raw
file verbatim, same "flat list, `#` comments, blank lines ignored" contract `hermes-news-digest.py`'s own
`load_topics()` already enforces). Both tabs share this one service; no separate install step for the
second one.

**Executable bit:** if this ever gets committed from a Windows checkout again, re-check
`hermes-rag-discovery-portal.py` and `-wrapper.sh` are `100755`, not `100644` — this exact mistake took the
service down on first deploy (`ExecStart` failing `203/EXEC`, masked by `Restart=always` as a restart loop;
full incident in `IMPLEMENTATION_PLAN.md` §7 Phase 33's revision-history entry). `git update-index
--chmod=+x <path>` fixes it without a content change.

## 7. Query tool

No service — a CLI, or `skills/rag-query/SKILL.md`'s pointer for either persona:

```bash
/opt/hermes/venvs/rag/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-rag-query.py \
  "what does the fleet do about session-length caps" --corpus fleet-docs --top-k 5
```

## 8. Verify

```bash
systemctl status hermes-embed hermes-embed-homed13 hermes-embed-worker \
  hermes-rag-discovery-portal --no-pager

curl -s http://127.0.0.1:8092/health 2>/dev/null || echo "no /health on llama-server — check journalctl instead"

sudo -u pmoney sqlite3 /mnt/hermes-data/rag/vectors.db \
  "SELECT corpus, COUNT(*) FROM chunks GROUP BY corpus;"
```

Real numbers per corpus (not zero, not an error) confirm ingestion actually ran. Then a real query:

```bash
/opt/hermes/venvs/rag/bin/python3 tools/hermes-rag-query.py "test query" --top-k 1 --json
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-19 | Initial version — the one `infra/*` directory still missing its own README, flagged in `IMPLEMENTATION_PLAN.md` 4.73.0 and left open since. Written from the real, already-deployed unit files and scripts in this checkout, not from a fresh build — every step here reflects what Phase 30/31/33's live deployment actually needed, including the two real bugs those phases hit (the LUKS-mount root-ownership pattern shared with `hermes-broker`, and Phase 33's executable-bit deploy failure). Flags one still-open gap rather than silently fixing it: `sqlite-vec` is a real runtime import in `hermes_rag_common.py` but isn't listed in `requirements.txt`, left unpatched here since a separate, concurrent session had that exact file open the same day. |
