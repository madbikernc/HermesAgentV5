# hermes-node-baseline — S17 recreate checklist

**Version:** 1.5.0

Daily local-node security baseline (aide file-integrity, lynis hardening audit, syft+grype
SBOM/CVE), diffed day-over-day, with new medium+ findings written as durable, queryable
recommendations and routed — once the operator explicitly authorizes one over Matrix — to
either `hermes-remediate-worker` (an allowlisted mechanical action) or `hermes-dualcoder` (the
coder/coder2 adversarial review loop). Full design/rationale is in the S17 plan this was built
from; see `tools/hermes-node-baseline-scan.py` and `tools/hermes-baseline-authorize-watch.py`
for the header comments carrying the actual reasoning — not duplicated here.

## Components

| File | Purpose |
|---|---|
| `tools/hermes-node-baseline-scan.py` | The scanner: runs aide/lynis/syft+grype, normalizes findings, diffs against yesterday, writes a hermes-memory recommendation (`REC-<node>-<date>-<seq>`) per new medium+ finding, auto-resolves findings that disappear, sends one Matrix+email digest per run. |
| `tools/hermes-node-baseline-scan-wrapper.sh` | Fetches Vaultwarden secrets (memory-token, matrix-fleetops, email) and execs the scanner. One instance per node, parameterized by node name. |
| `tools/hermes-baseline-authorize-watch.py` | Long-running watcher: polls FleetOps for `authorize REC-...` / `reject REC-...` from the real Boss Matrix account, then routes an authorized recommendation. |
| `tools/hermes-baseline-authorize-watch-wrapper.sh` | Fetches this watcher's secrets (memory-token, buzz-token, matrix-fleetops, broker-token) and execs it. Single instance, any one node. |
| `config/*.json.template` | Copy the one matching your node to `$HERMES_HOME/config/node-baseline.json` and fill in real paths — **not committed to git with real values**, same convention as `node-health.json`. |
| `hermes-node-baseline-scan@.service` / `@.timer` | Templated per-node unit (`%i` = node name). |
| `hermes-baseline-authorize-watch.service` | Single-instance unit. |

## Recommendation lifecycle

`pending` (written by the scanner) → operator replies in FleetOps →
`rejected` | `routed-remediate` | `routed-dualcoder` | `manual-required` → (for a resolved
underlying finding, any state) → `resolved` (written automatically by the next day's scan when
the finding disappears).

Full history for any `REC-...` id: `GET {MEMORY_URL}/turns?task_id=REC-...` — same query
`hermes-dualcoder.py` already relies on for its own transcript, no new endpoint needed.

## Required manual setup per node (not automated — a privilege change, done deliberately)

`aide --check` and `lynis audit system` need root. On this fleet, confirmed live 2026-09-05,
`pmoney` already has full passwordless sudo on all three nodes (same "already-privileged worker"
model `infra/hermes-remediate/README.md` documents) — no new sudoers entry is actually needed
here. If a future node's `pmoney` does NOT have broad sudo already, add exactly these two
read-only audit commands, narrowly scoped, same precedent as the existing `sudo nmap` entry
`tools/hermes-security-scan.py` already depends on:

```
# /etc/sudoers.d/hermes-node-baseline
pmoney ALL=(root) NOPASSWD: /usr/bin/aide --check --config /etc/aide/aide.conf
pmoney ALL=(root) NOPASSWD: /usr/bin/lynis audit system --quiet --no-colors
```

Before the first `aide --init` on a node, exclude the dynamic NFS/RPC pseudo-filesystem —
confirmed live 2026-09-05 on all three nodes: the distro's own shipped
`/etc/aide/aide.conf.d/31_aide_nfs` targets the legacy `/var/lib/nfs/rpc_pipefs` path, but this
fleet actually mounts it at `/run/rpc_pipefs` (a modern systemd convention), so the shipped rule
never matches and these inherently-unstable virtual files (their reported content never matches
their own stat size) get tracked and re-flagged as "new"/"changed" on every single run:

```bash
echo '!/run/rpc_pipefs' | sudo tee /etc/aide/aide.conf.d/90_hermes_exclude_run_rpc_pipefs
```

**Exclude `/mnt` entirely, and any large local data-store files, before the first `--init`.**
Found live 2026-09-05/06, the hard way, three rounds in a row: `/opt/hermes-data.img` (a 2.1TB
live database image), its own mounted view at `/mnt/hermes-data` (a *separate filesystem* —
`du -x`/`--one-file-system` correctly hides it from a root-filesystem size check, but aide isn't
scoped by `-x` and happily crosses into it anyway), and — the one that actually took three
kill-and-restart cycles to find — an NFS-mounted NAS backup share at `/mnt/nas2-hermes-backup`
that aide traversed in full over the network, unrelated to this fleet at all (someone's old game
mod archives sitting in the NAS's own recycle bin). Together these turned a real `aide --init`
into 6+ hours on both spark and spark-2. None of this is a meaningful integrity target: a live
database always shows as "changed" regardless of anything wrong, and nothing under `/mnt` on this
fleet is a local system file aide is meant to be watching in the first place — it's all NAS/data
mounts. The lesson that generalizes: exclude `/mnt` wholesale rather than chase individual
sub-paths one discovery at a time, and separately check the *local root filesystem* itself (`sudo
du -xh --max-depth=1 /`) for any large non-system data file like `hermes-data.img` before the
first `--init` on a future node — `findmnt` will show you every other mounted filesystem if `/mnt`
ever stops being a safe catch-all exclude:

```bash
echo '!/mnt' | sudo tee /etc/aide/aide.conf.d/91_hermes_exclude_data_image
# plus any large local (non-mounted) data file `du -xh --max-depth=1 /` turns up, e.g.:
echo '!/opt/hermes-data.img' | sudo tee -a /etc/aide/aide.conf.d/91_hermes_exclude_data_image
# on spark-2 only, its model checkpoint store is also local, not mounted:
echo '!/opt/hermes-models' | sudo tee -a /etc/aide/aide.conf.d/91_hermes_exclude_data_image
```

Then, once per node, establish the initial file-integrity baseline:

```bash
sudo aide --init --config /etc/aide/aide.conf
# aide.conf's own gzip_dbout setting decides the exact output filename -- check which one your
# node actually produced (confirmed live: this differs per node on this fleet) before copying:
ls /var/lib/aide/aide.db.new*
sudo cp /var/lib/aide/aide.db.new.gz /var/lib/aide/aide.db.gz   # if gzip_dbout=yes
sudo cp /var/lib/aide/aide.db.new /var/lib/aide/aide.db         # if not
```

A real `--init` took 43m12s for 381,891 entries on HomeD13. spark and spark-2 took over 6 hours
*before* the large-data-asset excludes above were found and applied (they were reading the full
2.1TB `hermes-data.img` end to end) — with those excluded, budget for something much closer to
HomeD13's number, but confirm live on first setup rather than assume. See
`check_timeout_seconds` in `node-baseline.json` (default 7200s/2h) if a `--check` pass itself
needs tuning for a particular node's real database size. Re-run `aide --init` (with the
operator's sign-off) whenever a legitimate bulk change makes the old
baseline noisy — this is a manual step, not something the scanner does for you.

**A second, much bigger exclude gap — found 2026-10-09 while building `hermes-fleetops-ui`'s
`/recommendations` page, not while looking at aide directly.** `memory.db` held 227,116 `REC-*`
tasks, 139,853 still `pending` since 2026-09-07. Sampling thousands of them live (not guessing)
found the overwhelming majority were `aide` findings against paths that change constantly for
reasons that have nothing to do with security: **snap packages** (`/snap`, `/var/snap`,
`/usr/lib/snapd` — every revision is a brand-new immutable path, and snapd already verifies them
cryptographically; aide re-checking them is pure noise), **kernel packages** (`/usr/src`,
`/usr/lib/modules` — every kernel/header update), **dynamic system/package-manager state**
(`/run/udev`, `/var/cache`, `/usr/share/zoneinfo`, and — narrowly, not `/usr/lib` wholesale —
`/usr/lib/python3/dist-packages`, `/usr/lib/node_modules`, the `*-linux-gnu*/gconv` and
`*-linux-gnu*/perl-base` locale/runtime trees, plus several `/usr/share/*` doc/locale/completion
dirs), **user-level caches** (`~/.npm`, `~/.cache`), **git internals** under every checked-out
repo (`.git` — object churn from an ordinary `git pull`, e.g. `hermes-repo-autopull.timer`, is
never itself a meaningful integrity signal; the *working-tree files* stay tracked), **a live
application database** (`/var/lib/continuwuity/db` on spark — same class as `hermes-data.img`
above), **generated-output directories** (`/opt/comfyui/output` and `/mnt/nas2-hermes-images` on
HomeD13), and **the rest of `/tmp`** — `70_aide_tmp`'s own shipped rule only tracks the top-level
directory's permissions, not its contents, so ephemeral build/runtime dirs (`/tmp/meshenv-*`,
`/tmp/heapenv`, `/tmp/node-compile-cache`, all seen live on spark) fell through to the distro's
catch-all `/ 0 Full` rule. **Deliberately not excluded**, despite real noise, because the paths are
genuinely security-relevant and the noise is an acceptable cost: `/usr/lib/systemd/system` (unit
files — a classic persistence target) and anything else under plain `/usr/lib`/`/usr/bin`/`/usr/sbin`
not named above.

Fixing the excludes stops new noise; it does **not** retroactively resolve an already-pending
backlog on its own (each `REC-*` task sits in `memory.db` independently of the node's own local
`findings_by_id` snapshot, which only remembers the last run). **Done as a direct follow-up,
2026-10-09** — `tools/hermes-baseline-backlog-cleanup.py` bulk-resolved the 138,865 pending
`aide` findings that predated the fleet-wide `--init` reset below (every one of them was a diff
against a baseline that no longer exists), using a plain `/tasks` state upsert per record — not
`/turns` — since `hermes-memory.py`'s `_create_turn()` calls `embed()` on every turn write, and
138,865 individual turns would have meant 138,865 embedding calls competing with the fleet's real
embed role for no benefit. One consolidated summary turn was written instead, under
`REC-cleanup-2026-10-09`. `grype` (849 pending) and `lynis` (1 pending) findings were deliberately
left untouched — they have nothing to do with aide's baseline and may still be genuinely open.

**A real bug in the first real run, caught and fixed the same day.** It had no node filter at
all and bulk-resolved LinodeMercury's 12 then-pending aide findings too — but LinodeMercury's own
baseline was last reset during S29, not S30, and nothing S30 did invalidated those 12. Caught by
cross-checking the per-id cleanup log against which nodes actually got a `--init` reset; all 12
reverted to `pending` by hand, and the script now hard-codes
`RESET_NODES = {"spark", "spark-2", "homed13"}` so a bare `tool == 'aide'` check can never again
sweep up a node this specific cleanup didn't actually reset.

Verified: `memory.db` now holds 999 pending (849 grype + 1 lynis + 137 tasks with no turn at all,
unrelated, + the 12 reverted LinodeMercury findings) against 226,118 resolved, and
`hermes-fleetops-ui`'s `/recommendations` page's default view shows exactly that true total.

```bash
# Shared across every node (inert where a path doesn't exist, e.g. /snap on the x86_64 HomeD13
# node, which runs no snapd at all):
echo -e '!/snap\n!/var/snap\n!/usr/lib/snapd' | sudo tee /etc/aide/aide.conf.d/92_hermes_exclude_snap
echo -e '!/usr/src\n!/usr/lib/modules' | sudo tee /etc/aide/aide.conf.d/93_hermes_exclude_kernel_pkgs
echo -e '!/run/udev\n!/var/cache' | sudo tee /etc/aide/aide.conf.d/94_hermes_exclude_dynamic_system_state
echo -e '!/home/pmoney/.npm\n!/home/pmoney/.cache' | sudo tee /etc/aide/aide.conf.d/95_hermes_exclude_user_caches
echo '!/home/pmoney/HermesAgentV5/.git' | sudo tee /etc/aide/aide.conf.d/96_hermes_exclude_git_internals
# plus, only where the checkout exists (spark has both; spark-2 has llama.cpp only; HomeD13 has neither):
echo '!/home/pmoney/HermesAgentV5-selfrepair/.git' | sudo tee -a /etc/aide/aide.conf.d/96_hermes_exclude_git_internals
echo '!/opt/llama.cpp/.git' | sudo tee -a /etc/aide/aide.conf.d/96_hermes_exclude_git_internals

cat <<'EOF' | sudo tee /etc/aide/aide.conf.d/97_hermes_exclude_package_churn
!/usr/share/zoneinfo
!/usr/lib/python3/dist-packages
!/usr/lib/node_modules
!/usr/share/bash-completion
!/usr/share/perl
!/usr/share/python-babel-localedata
!/usr/share/man
!/usr/share/i18n/locales
!/usr/share/ca-certificates
!/usr/share/subiquity
!/usr/share/doc
!/usr/include/node
!/usr/lib/.*-linux-gnu.*/gconv
!/usr/lib/.*-linux-gnu.*/perl-base
EOF

# Node-specific: /tmp's contents everywhere, plus whichever generated-output/live-db dirs exist.
echo '!/tmp/.+' | sudo tee /etc/aide/aide.conf.d/98_hermes_exclude_generated_and_tmp
# spark only:
echo '!/var/lib/continuwuity/db' | sudo tee -a /etc/aide/aide.conf.d/98_hermes_exclude_generated_and_tmp
# HomeD13 only:
echo -e '!/opt/comfyui/output\n!/mnt/nas2-hermes-images' | sudo tee -a /etc/aide/aide.conf.d/98_hermes_exclude_generated_and_tmp
```

Re-run `aide --init` (see above) on every node after applying these — an exclude added after the
baseline already contains a path does not retroactively stop that path's *existing* database
entry from being compared, only new scans from re-adding it.

## Install

```bash
sudo cp hermes-node-baseline-scan@.service hermes-node-baseline-scan@.timer /etc/systemd/system/
sudo cp hermes-baseline-authorize-watch.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-node-baseline-scan@spark.timer     # on spark
sudo systemctl enable --now hermes-node-baseline-scan@spark-2.timer   # on spark-2
sudo systemctl enable --now hermes-node-baseline-scan@homed13.timer   # on HomeD13
sudo systemctl enable --now hermes-baseline-authorize-watch.service   # on ONE node only
```

## Verify

```bash
# Dry run, no persist/notify:
python3 tools/hermes-node-baseline-scan.py --dry-run

# Real run once sudoers + aide --init are in place:
sudo systemctl start hermes-node-baseline-scan@$(hostname).service
journalctl -u hermes-node-baseline-scan@$(hostname).service -n 50

# Confirm a synthetic finding round-trips: touch a file aide tracks, re-run, confirm a REC
# shows up in the FleetOps digest, then:
curl -s $MEMORY_URL/turns?task_id=<REC-id> -H "Authorization: Bearer $MEMORY_TOKEN"

# Reply "authorize <REC-id>" in FleetOps from the real Boss account, confirm
# hermes-baseline-authorize-watch routes it and a second identical reply is a no-op.
```

## Known gaps, stated plainly rather than assumed away

- Verified live against real binaries on all three nodes, 2026-09-05 — several real bugs were
  found and fixed this way and are not hypothetical: syft has no `dpkg-db:` source scheme (`dir:`
  against the same path is correct); grype cannot infer OS distro from a bare `dir:` source and
  silently matched zero OS-package CVEs without an explicit `--distro` override; lynis writes its
  report 0640 root:root (read via `sudo cat`, not a direct file read); a single lynis test_id can
  legitimately fire more than once for different issues (finding_id now includes a hash of the
  description); grype's own stderr WARN broke JSON parsing when naively merged into stdout.
- `--only-fixed` is applied to every grype call: an unfixed CVE has no real "package-upgrade" to
  suggest yet. Confirmed live on spark: this cut 51,009 raw medium+ matches down to 2,644
  genuinely actionable ones on the same SBOM.
- A node's first-ever run should use `--seed-only` (see `--help`) to persist today's findings as
  the baseline without writing recommendations or sending a digest — confirmed live: an
  un-seeded first run on a real, ordinarily-patched Ubuntu system is thousands of medium+
  findings, which is normal apt-upgrade lag, not something worth a one-time flood.
- HomeD13 has no persona and was never provisioned to decrypt any email item in Vaultwarden
  (confirmed live, not assumed) — its digest is Matrix-only, by design, not a silent failure.
- `service-restart` routing only fires when a finding's `suggested_remediation` explicitly
  names both a `target` unit and a `sintra`/`amy` `identity` — no scan tool emits that today, so
  this path is inert until a future finding type populates it. Everything else routes to
  `manual-required` or `dualcoder`.
- Routing to `dualcoder` gets you a reviewed **script**, not an applied fix — dualcoder never
  executes anything (same posture as `hermes-code-security-scan.py`). A human still runs the
  result. Don't oversell this as unattended auto-remediation; it isn't.
- Changing `tools/hermes-buzz.py`'s `KNOWN_AGENTS` (needed once, to register `node-baseline`)
  requires restarting `hermes-buzz.service` to take effect — a `git pull` alone does not reload
  a running Python service. Confirmed and done live on spark 2026-09-05.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-05 | Initial version — S17 built (scanner, then authorize-watch + routing) per the approved plan. |
| 1.1.0 | 2026-09-05 | Live-verified on all three fleet nodes: real tool bugs found and fixed (syft source scheme, grype distro detection, lynis permission/dedup), `--only-fixed` and `--seed-only` added, HomeD13's Matrix-only email limitation documented, `hermes-buzz.service` restart requirement noted. |
| 1.2.0 | 2026-09-05 | Two more real bugs found completing the first live `--seed-only` runs: aide's `--check` timeout (600s) was nowhere near enough for a real database (fixed, now 7200s default, configurable) and its exit status is a bitmask, not a plain 0/1 convention (exit 5 = new+changed both found, was wrongly treated as a hard failure). Also found and fixed a real path mismatch in the distro's own shipped aide NFS ruleset (`/var/lib/nfs/rpc_pipefs` vs. this fleet's actual `/run/rpc_pipefs`) and documented `pmoney`'s already-broad sudo, the gzip-vs-not baseline-activation difference between nodes, and real measured `aide --init` timings. |
| 1.3.0 | 2026-09-06 | Found live, three kill-and-restart rounds in a row: spark and spark-2's `aide --init` ran 6+ hours because it was reading a 2.1TB live database image (`/opt/hermes-data.img`), that same data's separately-mounted view (`/mnt/hermes-data` — a distinct filesystem `du -x` hides but aide still crosses into), and an NFS-mounted NAS backup share (`/mnt/nas2-hermes-backup`, unrelated personal data) over the network. Direct operator decision: exclude `/mnt` wholesale rather than chase individual mounts one discovery at a time, plus any large local (non-mounted) data file like `hermes-data.img` and, on spark-2, `hermes-models`. None of it was a meaningful integrity target — a live database always shows as "changed" regardless, and nothing under `/mnt` on this fleet is a local system file aide is meant to be watching. |
| 1.3.2 | 2026-09-06 | Consolidated the 1.3.0/1.3.1 setup instructions (originally written mid-investigation, one mount at a time) into the single final `!/mnt`-wholesale guidance above, once all three rounds were actually complete — no new findings, just cleaner instructions for a future node. |
| 1.4.0 | 2026-10-09 | **A second, much bigger exclude gap, found live via `hermes-fleetops-ui`'s new `/recommendations` page, not by looking at aide directly**: `memory.db` held 227,116 `REC-*` tasks, 139,853 pending since 2026-09-07, overwhelmingly `aide` findings against paths that change constantly for reasons unrelated to security. Investigated with real samples (5,000 then 10,000 then 15,000 random pending findings, bucketed by normalized path) rather than guessed, across all three nodes. Nine real exclude categories added across two rounds — snap packages, kernel packages, dynamic system/package-manager state (`/run/udev`, `/var/cache`, `/var/lib/apt/lists`, `/var/lib/PackageKit`, `/run/NetworkManager`, `/run/snapd/lock`, `/var/log/sysstat`, `/var/lib/landscape`, Tailscale's own log files), narrowly-scoped package-churn paths under `/usr/lib`/`/usr/share`/`/usr/include` (not those directories wholesale — `/usr/lib/systemd/system` and everything else stays tracked, since unit files are a real persistence target and the noise there is an acceptable cost), user-level caches (`~/.npm`, `~/.cache`, `/root/.cache`, and — found live, escaping required a `\ ` since AIDE tokenizes on whitespace even for `!` rules — `~/.config/Bitwarden CLI`), git internals under every checked-out repo, a live application database (`/var/lib/continuwuity/db` on spark, same class as `hermes-data.img`), generated-output directories (HomeD13), and **this fleet's own operational state** (`~/.hermes/state`, `~/.hermes/cache`, lock files, per-role wake timestamps — the exact gap this file already warns about for `/mnt`, just never applied to the agent's own scratch directory). `70_aide_tmp`'s shipped rule only ever tracked `/tmp`'s own permissions, never its contents, so `/tmp/.+` is now excluded explicitly too. Verified live, post-`--init`, on all three nodes: spark 546,981 entries (0 added/6 removed/13 changed), spark-2 627,027 (0/6/8), HomeD13 309,469 (0/0/1) — vs. tens of thousands of spurious entries per day beforehand. **Not done here**: the 139,853-row pending backlog in `memory.db` is not retroactively resolved by this fix (each task is independent of the node's own local diff snapshot) — a real, separate follow-up. |
| 1.5.0 | 2026-10-09 | **Direct follow-up: the pending backlog itself cleaned up.** New `tools/hermes-baseline-backlog-cleanup.py` bulk-resolved the 138,865 pending `aide` findings that predated the fleet-wide `--init` reset above — every one was a diff against a baseline that no longer exists, so none has continued meaning. Writes a plain `/tasks` state upsert per record (preserving each task's own `agent`/`topic`, which the upsert overwrites unconditionally) rather than one `/turns` audit entry per record, after reading `hermes-memory.py`'s own handler and confirming `_create_turn()` calls `embed()` on every write — 138,865 individual turns would have meant 138,865 embedding calls, competing with the fleet's real embed role for no benefit `_upsert_task()` doesn't need. One consolidated summary turn written instead, under `REC-cleanup-2026-10-09`. `grype` (849 pending) and `lynis` (1 pending) findings deliberately left untouched — independent of aide's baseline, possibly still genuinely open. Verified live: tested on one real record first (state flipped, agent/topic intact) before the full run; 138,865/138,865 resolved, 0 failed, ~20-way concurrency with no measurable impact on `hermes-memory`'s own response latency throughout. **A real bug in that first run, caught and fixed the same day**: no node filter meant LinodeMercury's 12 then-pending aide findings got swept up too, even though its baseline was reset during S29, not S30; reverted to `pending` by hand, and the script now hard-codes `RESET_NODES = {"spark", "spark-2", "homed13"}` so this can't recur. `memory.db` now holds 999 pending (849 grype + 1 lynis + 137 no-turn + the 12 reverted) vs. 226,118 resolved, confirmed via both a direct query and `hermes-fleetops-ui`'s `/recommendations` page. Minor bump — a real cleanup executed, no prior guidance changed. |
