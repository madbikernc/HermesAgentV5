# hermes-node-baseline — S17 recreate checklist

**Version:** 1.3.2

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
