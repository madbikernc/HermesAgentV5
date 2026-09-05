# hermes-repo-sync — recreate checklist

**Version:** 3.0.0

Keeps each of the fleet's three real nodes (spark, spark-2, HomeD13) current with `origin/master`
and, when a pull actually moves that node's own HEAD, restarts exactly that node's own services and
posts a FleetOps notice reporting what happened.

## Why this looks nothing like the old design

**Re-imagined 2026-09-05** for the current ecosystem — full rewrite, not a patch. The original
design (1.x-2.x) existed to solve a problem that's now gone: Sintra and Amy were separate Unix
identities on spark that couldn't `git pull` from GitHub themselves (Stage 2/3f gave each a `cp -r`
of pmoney's checkout instead), so `hermes-repo-sync.sh` watched pmoney's own reflog
(`hermes-repo-sync.path`) and fanned that pull out to their checkouts via `sudo -u`/SSH, then
restarted their guard daemons one at a time (Vaultwarden rate-limit safety, still real — see below).

Sintra and Amy are fully retired (S8) — no accounts, no daemons, no checkouts to fan out to. All
three real nodes are peers now, each running the same `pmoney` identity, each already pulling its
own checkout directly from GitHub (`hermes-repo-autopull.timer`, S14) — no cascade, no canonical
source-of-truth checkout to fan out from. That part didn't need re-imagining; it was already right.

**The gap that redesign left standing**, confirmed live 2026-09-05 by checking the real journal
across all three nodes rather than assumed: autopull kept the code current, but nothing then
restarted the services that code belongs to, and nothing noticed or reported when a pull actually
moved something. A node could pull new code and silently keep running the old code in memory
indefinitely — the same "silent staleness, nobody watching" shape that originally justified
building autopull in the first place (`pmoney`'s own checkout once sat stuck at a Stage-2-era
commit for a multi-day migration, unnoticed — see `LESSONS_LEARNED.md`).

**The decision, made explicitly, not defaulted into:** auto-restart, not notify-only. This
directly reverses this project's own prior stated caution on this exact point ("auto-restarting on
every pull was deliberately not added here... every stage of this migration has restarted services
as its own explicit, verified step, not as a side effect of a background timer" — 2.1.0's own
words). Asked directly and confirmed 2026-09-05: each node should restart *itself* automatically
right after its own pull moves HEAD, not wait for a human to notice and run
`hermes-restart-fleet.sh` by hand. The FleetOps notice on every restart (success or failure) is
the safety net for that reversal — a bad auto-restart is visible immediately in Matrix, not
discovered later.

## What runs today

One timer, one service, one script, identical on all three nodes:

```
hermes-repo-autopull.timer  (every 30 min, all 3 nodes independently)
  -> hermes-repo-sync.service
    -> tools/hermes-repo-sync.sh
       1. detect this node's identity from `hostname` (spark|spark-2|HomeD13)
       2. git pull --ff-only (fails loudly, never merges/rebases, on a diverged/dirty checkout)
       3. if HEAD didn't move: done, nothing else happens
       4. if HEAD moved: tools/hermes-restart-fleet.sh --node <this-node>  (3.1.0 — restarts
          ONLY this node's own services, locally, no SSH to a peer, same dependency-ordered/
          safety-checked logic hermes-restart-fleet.sh's manual full-fleet run already uses)
       5. post one FleetOps notice (matrix-fleetops credential, same plain-POST style
          hermes-buzz-lockup-check.sh already uses): node, old->new short SHA, the commits
          that landed, and whether the restart succeeded
```

`hermes-repo-sync.path` (the old reflog-watcher) and the separate `hermes-repo-autopull.service`
(the old bare `git pull` oneshot) are both retired — folded into the single pull-then-restart
script above. There is no more "watch pmoney, cascade to others" relationship between nodes to
watch for.

**Still real, carried over from 1.x:** a per-run `flock` (`~/.hermes/repo-sync.lock`) — two
instances of this script racing on the same local git repo is a previously-hit failure, not a
hypothetical one. Restarts within a node still go one service at a time with a pause between each
— the same Vaultwarden-rate-limit incident that justified that in 1.x is still exactly as real
today (`hermes-vault-agent.py`'s own persistent-session design doesn't remove the risk, it just
moves where a burst of concurrent `bw` calls could come from).

## Install

Deployed identically on all three nodes (spark, spark-2, HomeD13) — same files, same paths, no
per-node variation:

```bash
sudo cp hermes-repo-sync.service hermes-repo-autopull.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-repo-autopull.timer
```

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-repo-sync.sh
```

Safe to run repeatedly and out-of-band from the timer — idempotent by construction (a checkout
already at `origin/master`'s HEAD is a no-op: pulls, sees HEAD didn't move, exits, no restart, no
notice).

To restart one node's own services without waiting for a pull to trigger it (e.g. after a config
change with no code change):

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-restart-fleet.sh --node spark   # or spark2 | homed13
```

For a full, manual, human-run restart of the whole fleet in dependency order (the original
`hermes-restart-fleet.sh` design, unchanged):

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-restart-fleet.sh
```

## Verify

```bash
systemctl status hermes-repo-autopull.timer --no-pager
journalctl -u hermes-repo-sync.service --no-pager -n 50
git -C /home/pmoney/HermesAgentV5 log -1 --oneline          # run this on each of the 3 nodes
```

The real end-to-end test: make a trivial commit, push it, then on the node you want to verify:

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-repo-sync.sh
```

Confirm (a) HEAD moved, (b) that node's own services show a recent restart
(`systemctl status <unit>` — check the `Active:` timestamp), and (c) a FleetOps notice landed in
Matrix naming the commit and the restart outcome.

## Requires

- `tools/hermes-repo-sync.sh` and `tools/hermes-restart-fleet.sh` present and executable
  (`chmod +x` if a fresh checkout ever loses the bit) on all three nodes — true automatically,
  since they're part of the same repo every node already autopulls.
- `pmoney`'s own passwordless `sudo systemctl restart` for its own node's units — already in place
  on all three nodes (no per-identity sudoers grant to maintain anymore; every service on every
  node runs as `pmoney`).
- The `matrix-fleetops` Vaultwarden item (password + room), reachable via
  `tools/vault-get-secret.sh` — the same credential `hermes-buzz-lockup-check.sh` and
  `hermes-dispatch-standby-check.sh` already use. A FleetOps notice degrades to a log-only warning
  if this is ever unreachable; it does not block the pull or the restart.
- For HomeD13 specifically: confirmed live (2026-09-05) that its own `pmoney` account can fetch
  Vaultwarden secrets and reach the broker directly — the render-worker job-in-flight safety check
  inside `hermes-restart-fleet.sh` works identically whether invoked locally (via this script) or
  from spark over SSH (the original manual full-fleet path).

## What this deliberately does NOT do

- **Does not touch periodic timers** (RAG ingest, news digest, usage/pfsense reports, backups,
  canary/game-server monitors, ...) — those are one-shot jobs a restart order doesn't apply to,
  same scope boundary `hermes-restart-fleet.sh` has always had.
- **Does not restart a peer node's services.** A node only ever restarts itself. If spark-2's pull
  moves its HEAD, spark-2 restarts spark-2 — spark is never involved.
- **Does not force past a diverged or dirty checkout.** A failed fast-forward pull fails loudly,
  notifies FleetOps, and stops — same "never silently resolve a divergence" rule the 1.x design
  already established, unchanged here.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-14 | Initial version. Direct request, following a real live incident deploying that same day's security-review fixes by hand across three separate checkouts (`pmoney`, `sintra`, `amy`) with two permission surprises and a unit-naming lookup along the way. |
| 1.1.0 | 2026-08-14 | Real bug on the first live run: the restart step's bare `systemctl restart` (this service runs as `User=pmoney`, not root) hung on an interactive polkit auth prompt with no agent to answer it. Fixed to `sudo systemctl restart`. |
| 1.2.0 | 2026-08-14 | Second real bug, same live run: restarting all three of an identity's services in one command started them concurrently, and three simultaneous Vaultwarden logins tripped Vaultwarden's own rate limiter. Fixed to restart one at a time, 10s apart. |
| 1.3.0 | 2026-08-14 | Extends coverage to HomeD13, over SSH (a genuinely separate host, not `sudo -u`). Adds a job-in-flight check against the broker before restarting either render-worker service. |
| 2.0.0 | 2026-08-21 | **Reversal**: `pmoney`'s own pull stops being a human-only action — `hermes-repo-autopull.timer` starts pulling it every 30 minutes, after a real incident where `pmoney`'s own checkout sat stale for a multi-day migration, undetected. |
| 2.1.0 | 2026-08-29 | HermesAgentV5 S14: HomeD13's sync had gone stale when `hermes-repo-sync.path` was correctly disabled at S8 (retiring Sintra/Amy) as an unintended side effect. Fixed by deploying `hermes-repo-autopull.timer` independently on all three nodes — no cascade, no restart step. The old per-identity reactive cascade was left in place but disabled, not deleted, "for if Sintra/Amy-style per-identity checkouts are ever needed again." |
| 2.1.1 | 2026-08-30 | HermesAgentV5 consolidation: path repointed from HermesAgentV4 to HermesAgentV5. |
| **3.0.0** | **2026-09-05** | **Full re-imagining for the current ecosystem, direct request.** The old per-identity cascade (`hermes-repo-sync.path`, the Sintra/Amy `sudo -u`/SSH fan-out) is retired for real — deleted, not left disabled — since the accounts it served no longer exist and autopull already replaced its actual job (keeping each node current). The real standing gap it left (nothing restarts services after a pull, nothing reports when one landed) is now closed: `hermes-repo-sync.sh` is rewritten to pull, detect movement, restart *this node's own* services via the new `hermes-restart-fleet.sh --node <name>` (3.1.0), and notify FleetOps — auto-restart chosen explicitly over notify-only, a deliberate, confirmed reversal of this project's own prior stated caution on that exact point. `hermes-repo-autopull.service` (the old bare-pull oneshot) is retired too, folded into the one script above; the timer now targets `hermes-repo-sync.service` directly.
