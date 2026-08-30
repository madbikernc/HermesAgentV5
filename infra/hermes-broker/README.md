# hermes-broker — recreate checklist

**Version:** 1.2.0

Ordered steps to stand up the fleet's execution plane (Stage 1 of the migration in
`IMPLEMENTATION_PLAN.md` §6). For *why* this exists rather than agent-to-agent Matrix delegation or the
HTTP endpoint that was proposed first, see `LESSONS_LEARNED.md` §2 and §4b. This file is the recipe.

**Two components:** `hermes-broker` on the Spark (queue + artifact store + Matrix delivery) and
`hermes-render-worker` on HomeD13 (pulls, runs, reports). Purely additive — Stage 1 changes nothing that
already existed.

## 0. What Stage 1 does not change

`tools/amy-generate-image.sh` is **unmodified**. It still performs its own VRAM dual-mode swap and its own
Matrix delivery into `SintraAmy`. That is deliberate: prove the broker against the known-good path before
changing that path.

**Expect each successful render to appear twice during Stage 1** — once in `SintraAmy` from the script,
once in `FleetOps` from the broker. Stage 3e removes the script's own delivery and the swap along with it.

## 1. Create the vault item

The broker and worker share one bearer token. Generate it **on the node** and never let the value transit a
chat session or a file:

```bash
# On the Spark, inside an unlocked bw session (see tools/vault-get-secret.sh for the unlock sequence):
ORG=<org-id>
COLL=$(bw list collections --session "$S" | jq -r '.[]|select(.name=="Fleet-Service")|.id')
TOKEN="$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)"
jq -n --arg org "$ORG" --arg coll "$COLL" --arg pw "$TOKEN" \
  '{organizationId:$org, collectionIds:[$coll], folderId:null, type:1, name:"broker-token",
    favorite:false, login:{username:"broker", password:$pw}}' \
  | bw encode | bw create item --session "$S"
```

`Fleet-Service` is the right collection: both machine accounts are members, and both nodes need this token.

## 2. Spark — directory, unit, firewall

The database lives inside the LUKS container. **Create the directory as root and hand it to `pmoney`** —
the container's mount root is root-owned, so the service cannot create it itself (this is a real failure
hit during Stage 1: `PermissionError: '/mnt/hermes-data/broker'`, crash-loop until fixed):

```bash
sudo mkdir -p /mnt/hermes-data/broker/artifacts
sudo chown -R pmoney:pmoney /mnt/hermes-data/broker
sudo chmod 700 /mnt/hermes-data/broker

sudo cp hermes-broker.service /etc/systemd/system/
sudo ufw allow from 10.129.1.0/24 to any port 8100 comment 'hermes-broker'
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-broker
```

**Startup takes ~20 seconds**, almost all of it Vaultwarden round-trips (`systemd-creds decrypt` ×2, then
`bw login`/`unlock`/`sync` per secret). A health check immediately after `systemctl start` will fail —
that is not a fault. Wait, or watch `journalctl -u hermes-broker -f` for `listening on ...`.

Because the database is in the LUKS container, this service **will not start after a reboot until
`hermes-unlock.sh` has run**. `RequiresMountsFor=/mnt/hermes-data` makes systemd wait rather than
crash-loop. Same behaviour as `llama-sintra-core.service`; intended, not a defect.

## 3. HomeD13 — unit only

**No firewall change and no new inbound port.** The worker pulls, so it makes only outbound connections.
This is the single biggest security advantage over the `image-gen-api` design that was considered first.

```bash
sudo cp hermes-render-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-render-worker
```

**Stage 6 (2026-08-09) added a second, independent instance for video jobs** — same worker code
(`hermes-render-worker.py`), parameterized via `JOB_TYPE=video` and a different `GENERATE_SCRIPT`,
polling separately from the image-render instance:

```bash
sudo cp hermes-render-worker-video.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-render-worker-video
```

No broker-side change was needed at all — `type` was already an opaque string as far as the
broker is concerned, and `matrix_deliver()` already mime-sniffed `video/*` to `msgtype: m.video`.
See `IMPLEMENTATION_PLAN.md` §6 Stage 6 for the full model-selection and verification account.

## 4. The `@fleetops:spark` Matrix account — operator step ✅ done 2026-07-31

> **Live:** `@fleetops:spark` exists, `FleetOps` is `!dWwEG90OYi7hvMugzS:spark`, phone1 invited, and
> `matrix-fleetops` holds the token and room. Kept below as the recreate procedure.
>
> **Command namespaces are plural and nested** — this cost two failed attempts. It is
> `!admin users create-user`, not `!admin user ...`, and room removal is
> `!admin rooms moderation ban-room <id>`, not `!admin rooms delete-room <id>`. `!admin --help` and
> `!admin <namespace> --help` are authoritative.
>
> **Issue admin commands in the server's own admin room** — resolve `#admins:<server_name>`. A room merely
> *named* "admin" is not it, and commands typed there get no reply at all (`LESSONS_LEARNED.md` §1a).


The broker delivers artifacts as its own identity, so that no model is ever the thing reporting that work
happened. That account must be created by The Boss: registration is closed
(`allow_registration = false`), and neither node holds the `admin` account (§5 constraint 3).

1. Register `fleetops` (briefly reopen registration, or use the admin account), then close it again.
2. Create the `FleetOps` room, invited members `@fleetops:spark` and `@phone1:spark`.
3. Store the result as vault item **`matrix-fleetops`** in `Fleet-Service`: `password` = the access token,
   plus a custom field `room` = the room ID.
4. `sudo systemctl restart hermes-broker`.

**Until that exists the broker runs fine** — jobs complete, artifacts are stored and checksummed, only
delivery is skipped. It logs a warning at startup and `delivered` stays `0` on finished jobs.

## 5. API

All routes except `/health` require `Authorization: Bearer <broker-token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Unauthenticated liveness |
| `POST` | `/jobs` | Submit. Body `{"type":"render"|"video","payload":{"prompt":"...",...},"id":"optional"}` |
| `GET` | `/jobs` | Last 100 jobs, summary |
| `GET` | `/jobs/<id>` | Full record |
| `GET` | `/jobs/claim?type=<render\|video>&worker=<name>` | Worker pull |
| `POST` | `/jobs/<id>/result` | Worker report — artifact bytes in the body, metadata in `X-Exit-Code`, `X-Sha256`, `X-Filename`, `X-Error`, `X-Caption` |

`render` payload fields: `prompt` (required), `style`, `negative`, `resolution`, `room`.
`video` payload fields: `prompt` (required), `negative`, `frames` (default 33), `room`. `type` is an
opaque string as far as the broker is concerned — adding a third job type needs no broker change,
only a worker instance configured with that `JOB_TYPE` and its own `GENERATE_SCRIPT`.

Supplying your own `id` makes submission idempotent — a retried submit returns `{"duplicate": true}`
rather than creating a second job.

## 6. Behaviour worth knowing

- **Jobs queue when the worker is down.** They are not failures. This is what makes HomeD13's
  console-passphrase-on-every-boot survivable.
- **Claims are leased** (`BROKER_LEASE_SECONDS`, default 900). A worker that dies mid-job does not strand
  the job — the next claim reaps the expired lease and requeues it.
- **Retries are bounded** (`BROKER_MAX_ATTEMPTS`, default 3), then the job is dead-lettered with the real
  error text and a notice is posted to `FleetOps`.
- **Checksums are verified at the broker**, not trusted. If the bytes received do not hash to what the
  worker claimed, the job is requeued as a truncated transfer rather than recorded as done.
- **A clean exit with no artifact is treated as failure.** The worker returns exit 3 if the script exits 0
  but produces no readable file — that outcome is exactly the shape of the fabrication incidents this
  architecture exists to make impossible.

## 7. Verify

```bash
T="$(tools/vault-get-secret.sh broker-token password)"
curl -s http://10.129.1.15:8100/health                                    # {"ok": true, ...}
curl -s -o /dev/null -w '%{http_code}\n' http://10.129.1.15:8100/jobs      # 401 — auth enforced
curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"type":"render","payload":{"prompt":"a brass compass on a nautical chart"}}' \
  http://10.129.1.15:8100/jobs
```

Then confirm from raw output, not from status alone:

- The job reaches `done` with `exit_code: 0` and a non-empty `sha256`.
- `sha256sum` of the artifact on the Spark matches the source file in `/opt/comfyui/output/` on HomeD13.
- `file <artifact>` reports a real image of the expected dimensions.
- All of HomeD13's services are still `active` afterward and `nvidia-smi` is back to steady state.

**Failure paths are worth testing explicitly, once**, because they are the reason this exists:

| Test | Expected |
|---|---|
| Stop the worker, submit N jobs, restart it | All N queue, then drain in order. Nothing lost, nothing failed |
| Submit a job with no `prompt` | Retries to `BROKER_MAX_ATTEMPTS`, then `dead` with the real error |
| Claim a job and never report | Requeued after the lease expires, then completed normally |
| Request with no/wrong token | `401` |

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-07-31 | Initial version, written after the broker and worker were built, deployed, and verified end to end on both nodes — including the four failure-path tests and the root-owned-LUKS-mount permission bug found during bring-up. |
| 1.1.0 | 2026-07-31 | §4 marked done and annotated with the two things that cost failed attempts: admin command namespaces are plural and nested (`users`/`rooms moderation`), and commands must go to the server's own `#admins:` room, not one merely named "admin". |
| 1.2.0 | 2026-08-09 | Stage 6 (video generation): documented the second `hermes-render-worker-video.service` instance (same code, `JOB_TYPE=video`) and the `video` payload shape. No broker code changed — `type` was already opaque and video MIME delivery already worked. Verified end to end through the real broker: a real `.webm` generated, checksummed, and delivered to `FleetOps`. Full account in `IMPLEMENTATION_PLAN.md` §6 Stage 6. |
