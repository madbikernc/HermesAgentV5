# hermes-buzz — recreate checklist

**Version:** 2.0.0

Dedicated inter-agent communication for Sintra and Amy (Phase 32, `IMPLEMENTATION_PLAN.md` §7). Follows
`hermes-broker`'s own established pattern (§4c) rather than inventing new infrastructure — same shape, same
LUKS-container placement, same Vaultwarden-sourced bearer auth, same bot-posted-room observability pattern.
Sintra and Amy talk to each other only over this channel; the shared `SintraAmy` Matrix room is retired once
this is live and verified.

Runs centrally on `spark-1`, same as `hermes-broker` — both identities' gateways call it over the LAN
(Sintra locally, Amy across the `spark-1`↔`spark-2` link since her persona relocated in §6 Stage 7). This is
the same pattern HomeD13 already uses to reach the broker; nothing new was needed to make Buzz work
cross-node.

## 1. Create the vault item

Buzz uses its own bearer token, generated the same way `broker-token` was (Fleet-Service collection, both
machine accounts are members):

```bash
ORG=<org-id>
COLL=$(bw list collections --session "$S" | jq -r '.[]|select(.name=="Fleet-Service")|.id')
TOKEN="$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)"
jq -n --arg org "$ORG" --arg coll "$COLL" --arg pw "$TOKEN" \
  '{organizationId:$org, collectionIds:[$coll], folderId:null, type:1, name:"buzz-token",
    favorite:false, login:{username:"buzz", password:$pw}}' \
  | bw encode | bw create item --session "$S"
```

## 2. spark-1 — directory, unit, firewall

Same root-owned-mount gotcha `hermes-broker`'s own bring-up hit — **create the directory as root and hand it
to `pmoney`**, the service cannot create it itself inside the LUKS container's root-owned mount root:

```bash
sudo mkdir -p /mnt/hermes-data/buzz
sudo chown -R pmoney:pmoney /mnt/hermes-data/buzz
sudo chmod 700 /mnt/hermes-data/buzz

sudo cp hermes-buzz.service /etc/systemd/system/
sudo ufw allow from 10.129.1.0/24 to any port 8101 comment 'hermes-buzz'
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-buzz
```

Same `RequiresMountsFor=/mnt/hermes-data` behaviour as `hermes-broker.service` — will not start after a
reboot until `hermes-unlock.sh` has run. Not a defect.

## 3. The BuzzLog Matrix room

Created directly via the Matrix API as `@fleetops:spark` (already provisioned for `hermes-broker`, no new
account needed) — private room, `@phone1:spark` invited, room ID stored as a new custom field
`buzzlog_room` on the existing `matrix-fleetops` vault item (`password`/`room` already hold the FleetOps
token/room; `buzzlog_room` is a second, distinct room the same account posts into).

**Until that field exists, Buzz runs fine** — messages send and poll normally, only BuzzLog mirroring is
skipped, same graceful-degradation the broker uses for its own Matrix delivery.

## 4. API — Buzz 2.0 (S3, `HermesAgentV5/IMPLEMENTATION_PLAN.md`)

All routes except `/health` require `Authorization: Bearer <buzz-token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Unauthenticated liveness |
| `POST` | `/messages` | Publish. Body `{"from":"<agent>","topic":"<topic>","body":"...","task_id":"...","memory_ref":"..."}` — `task_id`/`memory_ref` optional, the pointer-envelope fields (target §7.3) |
| `GET` | `/messages/poll?topic=<topic>&since=<seq>&limit=<n>` | Pull messages on `topic` with `seq` greater than `since` (cursor-based, ordered) — the right call for a topic with exactly one subscriber |
| `GET` | `/messages?limit=<n>` | Last N messages across all topics, for inspection/debugging |
| `POST` | `/claims/next` | Body `{"topic":"<topic>","claimant":"<id>"}` — atomically claims the oldest unclaimed message on `topic`, or `{"claim":null}` if none. The right call once a topic can have more than one subscriber. |
| `POST` | `/claims/<id>/ack` | Body `{"claimant":"<id>"}` — marks a claim done. Must match the original claimant. An unacked claim past its lease (`BUZZ_CLAIM_LEASE_SECONDS`, default 300s) is silently reclaimable by anyone. |
| `GET` | `/claims?topic=<topic>` | Recent claims, for inspection/debugging |

`from` is structurally restricted to `KNOWN_AGENTS` (still just `{sintra, amy}` — extend when S6/S8 give
internal specialists their own identities); `topic` to `KNOWN_TOPICS` (`{sintra, amy}` plus target §4.4's
internal set — `dispatch`, `retrieve`, `screen`, `logs`, `code`, `vision`, `media`, `train` — plus
`results`). Not a `SOUL.md` instruction, an actual allowlist in the service itself. Every successful publish
is mirrored into BuzzLog as `@fleetops`, in the same turn, best-effort (a mirror failure never fails the
send itself).

**Backward compatible, deliberately:** `POST /messages` still accepts `to` as an alias for `topic`, and
every message row in every response still carries `to_agent` aliased to `topic`'s value. `GET
/messages/poll` still accepts `agent` as an alias for `topic`. This is what let `hermes-buzz.sh`,
`hermes-buzz-watch.sh`, and `hermes-buzz-lockup-check.sh` ship across the 1.x→2.0 migration with **zero
code changes** — Sintra and Amy's live hourly status-exchange traffic did not stop for this. `to_agent`/
`agent` can be retired once every caller has moved to `topic`; nothing is under pressure to do that yet.

**In-place migration, not a rebuild:** `messages.to_agent` was renamed to `messages.topic` on the live
266-message database (S3, 2026-08-29) — every prior message preserved, verified by direct row count and
content spot-check before and after, not by service self-report. `.backup`, not `cp`, is the safe way to
snapshot this file for a dry run first: `cp` against a WAL-mode database under live write traffic silently
produced a stale, short snapshot during S3's own verification, caught before it mattered only because the
row count was checked.

## 5. Client tool

`tools/hermes-buzz.sh` — the thing either persona actually calls. See its own header for usage; mirrors
`tools/hermes-render-request.sh`'s shape (fetch the token via `vault-get-secret.sh`, `curl` the API
directly, no new dependency). `send-file <path>` (1.2.0) reads the message body from a file instead of a
command-line argument — added after a long, quote-heavy `send` argument was found getting corrupted by a
framework-level tool-call parsing bug before it ever reached this script; see `skills/buzz/SKILL.md`.

## 6. The watcher — automatic checking and replies, with a throttle

`tools/hermes-buzz-watch.sh` + `infra/hermes-buzz/hermes-buzz-watch@.service` (one instance per identity,
`hermes-buzz-watch@sintra`/`hermes-buzz-watch@amy`, both run centrally as `pmoney` like
`hermes-wiki-checkin-trigger.sh`) closes the gap a pure on-demand skill leaves open: without it, a message
sits unread until a human happens to ask either persona to check. A cheap HTTP poll, no model involved —
**5 minutes idle, 30 seconds when this identity is "expecting a reply"** (derived live each cycle from
Buzz's own message history: the most recent message overall was sent *by* this identity, nothing back yet
— not a separate flag file). Only ever produces a real agent turn (a nudge posted into the identity's own
home room, same "never the persona" pattern as every other trigger in this fleet) when something is
genuinely new.

**Direct request, added same day as the watcher itself: "they should automatically answer... but we should
probably have a throttle."** The nudge prompt tells the persona to answer a genuine request directly, no
need to check with The Boss first — but an always-auto-reply persona plus an always-nudge watcher is a real
runaway-loop shape (the same class of problem this project hit twice live the night Buzz was first used,
just one layer up, between two agents instead of within one). Throttled with a **rolling time window, not a
lifetime counter**: if 10+ messages (either direction) have crossed in the last 30 minutes
(`BUZZ_WATCH_THROTTLE_MAX`/`BUZZ_WATCH_THROTTLE_WINDOW`), nudging pauses until the rate drops back under the
cap — a strict "stop after N alternating messages" was considered and rejected, since every later poll would
still see that same alternating tail in Buzz's history and the throttle would never naturally re-arm. While
throttled the cursor is deliberately not advanced, so the pending message is nudged for real once traffic
cools down rather than dropped, and a one-time notice (own separate 1-hour cooldown, `BUZZ_WATCH_THROTTLE_NOTICE_COOLDOWN`)
tells The Boss it's paused and that prompting either persona directly will still work regardless.

## 7. Lockup detection and proactive check-ins (Stage 8, 2026-08-21)

Built after a real near-miss: a Buzz message once sat unanswered long enough to look like a stall
before the watcher's own nudge finally fired — it turned out to be a harmless, one-off transient
poll failure (the watcher's idle-cycle silence when nothing's new looks identical to "stuck" from
the outside), but there was no way to tell the two apart without reading raw logs by hand. Two
independent, frequent, model-free additions close that gap and a second, direct request ("they
shouldn't have to wait for me to prompt them to talk to each other"):

- **`tools/hermes-buzz-lockup-check.sh`** + `hermes-buzz-lockup-check.service`/`.timer` — every 5
  minutes (same cadence as `hermes-canary-health.py`): checks Buzz itself is reachable, both
  `hermes-buzz-watch@sintra`/`@amy` are `active`, and whether either agent has a genuinely
  unanswered message older than 45 minutes (`BUZZ_LOCKUP_THRESHOLD`, generous margin above the
  1-10 minute turnaround actually observed live). Any real problem alerts immediately to FleetOps
  — direct request, since a stuck cross-persona channel is worth knowing same-day, not folded into
  `hermes-fleet-health.py`'s once-daily digest — with a 1-hour cooldown per distinct condition so a
  persisting problem is reported once, not every cycle.
- **`tools/hermes-buzz-checkin-trigger.sh`** + `hermes-buzz-checkin@.service` + two `.timer` units
  — every 4 hours per identity, offset by 1 hour so both aren't reasoning at once (direct request:
  "more often than daily" for encouraging a proactive check-in, not just a reactive nudge when a
  message is already waiting). Same "never the persona, real inbound Matrix event" pattern as
  `hermes-wiki-checkin-trigger.sh`, but **does** set `m.mentions.user_ids` on the post — reusing
  the fix `hermes-buzz-watch.sh` 1.2.0 already found live was required for these same home rooms,
  rather than repeating a bug already root-caused once. (`hermes-wiki-checkin-trigger.sh` predates
  that finding and may have the same latent gap — worth auditing separately, not fixed here.)
  Explicitly framed as optional and low-stakes in the prompt text; `hermes-buzz-watch.sh`'s own
  rolling-window throttle already guards the real channel if a check-in lands mid-conversation, so
  no separate throttle was added for this trigger.

## 8. Verify

```bash
T="$(tools/vault-get-secret.sh buzz-token password)"
curl -s http://10.129.1.15:8101/health                                       # {"ok": true, ...}
curl -s -o /dev/null -w '%{http_code}\n' http://10.129.1.15:8101/messages    # 401 — auth enforced
curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"from":"sintra","to":"amy","body":"test message"}' \
  http://10.129.1.15:8101/messages
curl -s -H "Authorization: Bearer $T" \
  'http://10.129.1.15:8101/messages/poll?agent=amy&since=0'
```

Then confirm from raw output, not status alone: the poll response actually contains the sent message; a
second poll with `since` set to the returned `seq` returns an empty list (cursor advances correctly); the
message appears in `BuzzLog` as `@fleetops`.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-16 | Initial version, written building and deploying Buzz for the first time — `hermes-buzz.py`, the wrapper, the systemd unit, the BuzzLog room, and the client tool, following `hermes-broker`'s established pattern throughout rather than inventing new infrastructure. |
| 1.1.0 | 2026-08-17 | Documented §6, the watcher: `hermes-buzz-watch.sh` + `hermes-buzz-watch@.service`, built the night Buzz was first used for real, after three infrastructure bugs and one genuine successful end-to-end test (`LESSONS_LEARNED.md` §7 1.29.0). Cadence (5min idle / 30s expecting-reply) and the rolling-window throttle (10 msgs/30min, direct request) both explained inline, including why a lifetime/consecutive-alternation counter was considered and rejected in favor of a self-healing time window. |
| 1.2.0 | 2026-08-17 | Documented `hermes-buzz.sh` 1.2.0's `send-file` addition, part of the same night's "Amy has not responded" incident — a framework-level tool-call parser bug corrupting long, quote-heavy `send` arguments before this script ever saw them. See `skills/buzz/SKILL.md` 1.3.0 and `LESSONS_LEARNED.md`'s dated §7/§8 rows for the full account. |
| 1.3.0 | 2026-08-21 | Added §7: `hermes-buzz-lockup-check.sh` (5-min cadence, immediate FleetOps alert on a real problem, direct request) and `hermes-buzz-checkin-trigger.sh` (4-hourly proactive check-in nudge per identity, direct request — "they shouldn't have to wait for me to prompt them"). Built after a real near-miss during Stage 8's live verification: a Buzz message sat apparently-unanswered long enough to look stuck before the watcher's own nudge fired (harmless in the end — a transient poll failure, not an actual stall). Renumbered the old §7 (Verify) to §8 to make room. |
| 2.0.0 | 2026-08-29 | Buzz 2.0 (HermesAgentV5 S3): documented `hermes-buzz.py` 2.0.1's topic-based pub/sub and claim-based handoff (target §10.1), the `to_agent`→`topic` in-place migration of the live 266-message database, and the deliberate backward-compatibility shim (`to`/`agent` aliases) that let every existing caller ship with zero code changes. |
