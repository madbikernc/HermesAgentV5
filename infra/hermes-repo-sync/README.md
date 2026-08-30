# hermes-repo-sync — recreate checklist

**Version:** 2.1.1

Keeps Sintra's and Amy's separate `~/HermesAgentV5` checkouts (each identity got its own full
`cp -r` at migration time — Stage 2/3f — since neither can traverse into `/home/pmoney`), plus
HomeD13's, in sync with `pmoney`'s, and restarts each affected long-running service/worker so a pull
actually takes effect instead of sitting inert on disk. Built after a real incident, 2026-08-14:
deploying that same day's security-review fixes required manual pulls across all four checkouts
(`sudo -u sintra`/`sudo -u amy` on the Spark, plain SSH to HomeD13), two `0700`-home permission
surprises, and a fabrication-guard unit-name lookup (Sintra's predates the per-identity `-sintra`
suffix convention) — all done by hand, live, one command at a time.

**HomeD13 (1.3.0) works differently from Sintra/Amy**, direct request following that same incident:
it's a separate physical host, reached over the Spark's existing SSH path to it (the same `Host
homed13` alias `hermes-node-health.py` already uses), not `sudo -u`. Its two services also aren't
like the guard daemons — they process real broker render jobs, and restarting one mid-job kills
whatever's in progress (the broker's lease/requeue design makes this non-destructive, not data loss,
but a real cost for a video job that can run 20+ minutes). Direct decision: check the broker for an
in-flight job of that worker's own type before restarting; skip and mark pending rather than kill it,
retried on every subsequent trigger until the worker is actually free.

`tools/hermes-repo-sync.sh` watches `pmoney`'s reflog (via the `.path` unit below), and for each
identity: fast-forward-only pull (never a merge/rebase — a diverged or dirty downstream checkout must
fail loudly and get a human, never be silently resolved), then restarts only the services that actually
need it, and only if the pull genuinely moved that identity's `HEAD`.

**Reversed, 2026-08-21** — this section originally said `pmoney`'s own `git pull` stays a human's
deliberate action, this script only ever reacting after one already happened, never fetching on its
own. That held until a real, session-long incident: `pmoney`'s own spark checkout sat stuck at a
Stage-2-era commit for the rest of a multi-day migration, entirely unnoticed, because nothing was
watching for *that* — this script only ever reacts to `pmoney`'s reflog changing, and if `pmoney` never
pulls, it never fires at all (`LESSONS_LEARNED.md`'s remediation-system entry has the full account).
Direct request following that incident, reversing the original design: `hermes-repo-autopull.timer` now
pulls `pmoney`'s own checkout every 30 minutes (fast-forward-only, same safety property as every other
pull this tool does), which cascades through the *already-existing* `.path` trigger into the rest of
this tool exactly as if a human had pulled by hand. No changes to the reactive cascade itself — only to
what starts it.

**Two more real bugs found on the very first live run**, both now fixed (1.1.0, 1.2.0): the restart
step originally used a bare `systemctl restart`, which hung on an interactive polkit auth prompt with
no agent available to answer it in a headless SSH session (this service runs as `User=pmoney`, not
root — `sudo systemctl restart` was needed explicitly, pmoney's own passwordless sudo doesn't cover
polkit's separate D-Bus authorization path). Once that was fixed and restarts actually went through,
restarting all three of an identity's services in one command started them concurrently — three
simultaneous Vaultwarden logins for the same account was enough to trip Vaultwarden's own rate
limiter, crash-looping the affected service for several minutes (each automatic restart added more
failed attempts, extending its own lockout) until manually stopped and given a cooldown. Confirmed
independently for both identities. Fixed by restarting each identity's services one at a time with a
10s pause between, rather than all at once.

**Restarted, not restarted:** `hermes-session-guardian-*`, `hermes-fabrication-guard*`, and
`hermes-session-cap-guard-*` read their script once at startup and hold it in memory for the life of
the process — restart required. `hermes-gateway*.service` (the actual persona) is deliberately **not**
restarted here: it shells out to whatever's on disk fresh on every tool call, so a `tools/` change
needs no restart there at all.

## Install

```bash
sudo cp hermes-repo-sync.path hermes-repo-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-repo-sync.path
```

`hermes-repo-sync.service` itself is intentionally **not** enabled directly; the `.path` unit starts it
on demand, reacting to `pmoney`'s own checkout moving.

**`hermes-repo-autopull.timer`/`.service` (2.0.0)** is what now makes `pmoney`'s own checkout move
periodically instead of waiting on a human:

```bash
sudo cp hermes-repo-autopull.service hermes-repo-autopull.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-repo-autopull.timer
```

Every 30 minutes, `git -C /home/pmoney/HermesAgentV5 pull --ff-only` as `pmoney` — a no-op (and no
cascade) if already current.

**Deployed on all three nodes as of HermesAgentV5 S14** — spark, spark-2, and HomeD13 each run their
own copy independently. This is a real change from the original design (spark-only, cascading to the
other two): `hermes-repo-sync.path` — the only mechanism that ever propagated `pmoney`'s pulls onward —
was correctly disabled at S8 as part of retiring Sintra and Amy (its entire reactive cascade was built
to sync *their* separate checkouts, plus HomeD13's as a side effect of the same trigger). That
correctly stopped the now-pointless Sintra/Amy sync, but silently took HomeD13's persona-unrelated sync
down with it — nobody rebuilt a path for HomeD13 at the time, and spark-2 never had one to begin with
(V4-era: "spark-2 ... aren't meant to," true then, not true once spark-2 started running real V5
services — `hermes-router`, `hermes-media`, `hermes-dispatch-standby-check` — that need current code).
Found live during S14 by comparing `git log -1` across all three checkouts: HomeD13 was several commits
behind, spark-2 had been pulled by hand all migration. Fixed with the simplest thing that's actually true now — three independent timers, no cascade, no
automatic restart step. **This does not auto-restart anything**, same as spark's own autopull never
has: `hermes-router`/`hermes-dispatch`/`hermes-media` and the rest all read their script once at
process start and hold it in memory, exactly like the old guard daemons this tool used to restart —
new code on disk needs an explicit `hermes-restart-fleet.sh` run or a manual `systemctl restart` to
take effect, on any of the three nodes, same as it always has on spark. Auto-restarting on every pull
was deliberately not added here — it's a bigger, riskier behavior change than "keep the checkout
current," and every stage of this migration has restarted services as its own explicit, verified step,
not as a side effect of a background timer.

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-repo-sync.sh
```

Safe to run repeatedly and out-of-band from the path trigger — it's idempotent by construction (an
identity already at `pmoney`'s `HEAD` is a no-op, logged and skipped, not an error).

## Verify

```bash
systemctl status hermes-repo-sync.path --no-pager
journalctl -u hermes-repo-sync.service --no-pager -n 50
sudo -u sintra git -C /home/sintra/HermesAgentV5 log -1 --oneline
sudo -u amy git -C /home/amy/HermesAgentV5 log -1 --oneline
ssh homed13 git -C /home/pmoney/HermesAgentV5 log -1 --oneline
```

To check whether a HomeD13 restart is currently deferred (a job was in flight last time it checked):

```bash
ls /home/pmoney/.hermes/repo-sync-pending-homed13-* 2>/dev/null || echo "none pending"
```

The real end-to-end test: make a trivial commit in `pmoney`'s checkout, `git pull` there, then confirm
(a) the journal shows a real sync run within a few seconds, (b) both identities' `HEAD` moved to match,
and (c) their services show a recent restart (`systemctl status <unit>` — check the `Active:` timestamp).

## Requires

- `tools/hermes-repo-sync.sh` on the Spark, executable (`chmod +x` if a fresh checkout ever loses the
  bit — this project has hit that exact class of bug before, see `LESSONS_LEARNED.md`'s Git section).
- `pmoney`'s own passwordless sudo (already exists — The Boss's own account) to reach `sintra`'s and
  `amy`'s accounts. **No new sudoers rule** — reuses exactly the access already used to deploy fixes by
  hand.
- `sintra`'s and `amy`'s own `~/HermesAgentV5` checkouts must already exist and have a working `git
  pull` (i.e. whatever SSH/deploy-key access lets each of them reach GitHub already has to be in place
  — this tool doesn't provision that, only uses it).
- The `SERVICES` map inside `hermes-repo-sync.sh` is a hardcoded list of unit names per identity —
  **not** auto-discovered. If a service is renamed, added, or removed for either identity, update that
  script by hand; a stale entry fails the restart step loudly (`systemctl restart` on a nonexistent
  unit errors and is logged), it doesn't silently do nothing.
- For HomeD13: `pmoney`'s own `Host homed13` SSH alias (already provisioned, Phase 13) with
  passwordless sudo on that box for the two render-worker service restarts (already confirmed working
  live), and the `broker-token` Vaultwarden item readable as `pmoney` (same one `hermes-broker.py`
  itself uses) to check job state before restarting.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.1.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-14 | Initial version. Direct request, following a real live incident deploying that same day's security-review fixes by hand across three separate checkouts (`pmoney`, `sintra`, `amy`) with two permission surprises and a unit-naming lookup along the way. Design decisions (systemd path unit over incrontab, auto-restart affected services, `pmoney`'s pull stays manual rather than auto-fetched) were direct choices, not assumptions — see this file's own intro for the reasoning behind each. |
| 1.1.0 | 2026-08-14 | Real bug on the first live run: the restart step's bare `systemctl restart` (this service runs as `User=pmoney`, not root) hung on an interactive polkit auth prompt with no agent to answer it. Fixed to `sudo systemctl restart`. |
| 1.2.0 | 2026-08-14 | Second real bug, same live run, right after 1.1.0 let restarts actually go through: restarting all three of an identity's services in one command started them concurrently, and three simultaneous Vaultwarden logins for the same account tripped Vaultwarden's own rate limiter — confirmed independently for both Sintra and Amy, each requiring the affected service stopped and given a several-minute cooldown before recovering. Fixed to restart each identity's services one at a time, 10s apart. |
| 1.3.0 | 2026-08-14 | Extends coverage to HomeD13, direct request following the same incident (it needed the identical manual pull+restart by hand). Reached over SSH, not `sudo -u` — a genuinely separate host. Adds a job-in-flight check against the broker's `/jobs` API before restarting either render-worker service, since (unlike the guard daemons) a restart there can kill a real in-progress render; a skipped restart is marked pending and retried on every subsequent trigger rather than silently forgotten. |
| 2.0.0 | 2026-08-21 | **Reversal**: `pmoney`'s own pull is no longer a human's deliberate action only — `hermes-repo-autopull.timer` pulls it every 30 minutes, direct request after a real incident where `pmoney`'s spark checkout sat stale at a Stage-2-era commit for the rest of a multi-day migration, undetected, because nothing was watching for that specific gap (this tool only ever reacted to `pmoney`'s reflog, and a `pmoney` who never pulls never triggers it). No change to the reactive cascade itself, which stays exactly as proven. |
| 2.1.0 | 2026-08-29 | HermesAgentV5 S14: found live that HomeD13's checkout had gone stale — `hermes-repo-sync.path`, the only thing that ever propagated pulls to it, was correctly disabled at S8 as a side effect of retiring Sintra's and Amy's own sync paths, even though HomeD13's sync had nothing to do with either persona. spark-2 never had any sync mechanism at all (a deliberate but now-outdated V4-era scope decision). Fixed by deploying `hermes-repo-autopull.timer` independently on all three nodes — no cascade, no restart step, same as it never auto-restarted anything on spark either. The old per-identity reactive cascade (`hermes-repo-sync.path`/`.service`, `SERVICES`/`HOMED13_SERVICE` maps) is left in place but disabled, not deleted — still real, working code for if Sintra/Amy-style per-identity checkouts are ever needed again, just nothing this fleet currently uses. |
