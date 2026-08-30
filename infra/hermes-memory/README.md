# hermes-memory — recreate checklist

**Version:** 1.0.0

Ordered steps to stand up the fleet's shared memory service (HermesAgentV5's S2 —
`../../HermesAgentV5/IMPLEMENTATION_PLAN.md`). For *why* this exists rather than the target
architecture's proposed Postgres+pgvector, see that plan's §3.1. This file is the recipe, in the
same shape as `../hermes-broker/README.md`.

## 0. What S2 does not change

`hermes-session-cap-guard.sh` is **unmodified** and still runs. That is deliberate: prove recall
against this service before retiring the guard that exists only because there was no memory (V4
S11). See the verification bar below before ever touching that guard.

## 1. Create the vault item

Generate the bearer token **on the node**, inside an unlocked `bw` session, and never let the
value transit a chat session or a file — identical recipe to `hermes-broker`'s own:

```bash
ORG=<org-id>        # bw list organizations --session "$S"
COLL=<collection-id> # bw list collections --session "$S" | look for "Fleet-Service"
TOKEN="$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)"
jq -n --arg org "$ORG" --arg coll "$COLL" --arg pw "$TOKEN" \
  '{organizationId:$org, collectionIds:[$coll], folderId:null, type:1, name:"memory-token",
    favorite:false, login:{username:"memory", password:$pw}}' \
  | bw encode | bw create item --session "$S"
```

Only `spark` needs this token today — `hermes-memory` is Watch-only per target §7.1 (host on the
always-on node). `spark-2` and HomeD13 will need read access to it once S3/S6 give them something
to call this service for; add them to the `Fleet-Service` collection membership then, not now.

## 2. Spark — directory, unit, firewall

The database lives inside the LUKS container. **Create the directory as root and hand it to
`pmoney`** — the container's mount root is root-owned, so the service cannot create it itself
(this is the exact failure mode `hermes-broker`'s own README already documents for
`/mnt/hermes-data/broker`; same fix):

```bash
sudo mkdir -p /mnt/hermes-data/memory
sudo chown -R pmoney:pmoney /mnt/hermes-data/memory
sudo chmod 700 /mnt/hermes-data/memory

sudo cp hermes-memory.service /etc/systemd/system/
sudo ufw allow from 10.129.1.0/24 to any port 8102 comment 'hermes-memory'
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-memory
```

`MEMORY_BIND` is set explicitly to spark's LAN IP (`10.129.1.15`) in the unit, not left at the
code default of `0.0.0.0` — same plane-discipline precedent `hermes-broker.service` already
established, ahead of S4 making it fleet-wide policy.

Because the database is in the LUKS container, this service **will not start after a reboot until
`hermes-unlock.sh` has run**. `RequiresMountsFor=/mnt/hermes-data` makes systemd wait rather than
crash-loop — same behaviour as `hermes-broker.service` and `llama-sintra-core.service`.

**Requires `/opt/hermes/venvs/rag/bin/python3`** (or another interpreter with `sqlite-vec`
installed) — the wrapper's `MEMORY_PYTHON` default. `sqlite_vec` is not stdlib and is not on the
bare system interpreter; invoking it via that venv path is what makes Python find the venv's
`pyvenv.cfg` and site-packages, even though `bin/python3` there is itself a symlink to the system
binary. Confirmed present on **both** spark and spark-2 during S1's verification.

## 3. Verify — the bar V4 S11 set, not a self-report

A fact stored in one session must be recalled in a brand new session with zero shared context,
confirmed by **direct `sqlite3` query against the store** — never by an agent's self-report.
`nano` fabricated exactly this claim twice in V4 S11; this project does not accept "the model says
it worked" as evidence again.

```bash
TOKEN="$(vault-get-secret.sh memory-token password)"

# Session 1: write a turn with a specific, checkable fact.
curl -s -X POST http://127.0.0.1:8102/turns \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task_id":"verify-s2","agent":"verify","role":"user","raw":"the verification phrase is umbrella-quartz-19"}'

# Session 2: a separate process, zero shared context, recalls by semantic search alone.
curl -s "http://127.0.0.1:8102/turns/search?q=what+is+the+verification+phrase&top_k=3" \
  -H "Authorization: Bearer $TOKEN"

# Independent confirmation: bypass the service entirely, read the file directly.
sqlite3 /mnt/hermes-data/memory/memory.db \
  "SELECT id, task_id, raw FROM turns WHERE raw LIKE '%umbrella-quartz%'"
```

All three must agree before this service is trusted for anything real.

## 4. What's still ahead

- `tasks` table exists from S2 on but nothing populates it for real until S3 (Buzz 2.0) and S6
  (`hermes-dispatch`) generate real dispatcher task IDs. Until then `task_id` in `turns` is just
  an opaque grouping key any caller supplies.
- Retiring `hermes-session-cap-guard.sh`'s wipe-and-summarise behaviour is **not** part of S2 —
  only after recall is verified live, per the plan.
- The model registry table (checkpoint hashes, sizes, eval results) is S9's addition, not S2's.
