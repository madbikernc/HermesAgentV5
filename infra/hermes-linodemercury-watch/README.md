# hermes-linodemercury-watch — recreate checklist

**Version:** 1.0.0

Daily Fleet-side half of LinodeMercury's security check (`tools/hermes-linodemercury-watch.py`),
running entirely on `spark`. LinodeMercury is the repo's first deliberately external,
one-way-reachable node (IMPLEMENTATION_PLAN.md S28) — Fleet reaches it, it never reaches back —
so nothing from this repo runs there. `aide`/`lynis`/`syft`+`grype` run locally on LinodeMercury via
their own native systemd timers (see `infra/linodemercury/README.md`), logged minimally and
locally, bundled into one compressed tarball daily. This tool pulls that one tarball over the
existing one-way SSH path (`ssh linodemercury`, key `~/.ssh/linodemercury_access`), parses it,
writes any new medium+ finding as a `REC-linodemercury-<date>-<seq>` recommendation (same
hermes-memory lifecycle `hermes-node-baseline-scan.py` already uses), sends one daily Matrix +
email digest, and only then deletes the remote bundle — a missed day is never lost to a blind
local rotation on LinodeMercury's side.

Covers the three things asked of a daily external-node check: out-of-date/insecure packages
(grype CVE scan + `apt list --upgradable`, both already produced locally), firewall posture
(`ufw status verbose`, parsed), and local-log intrusion review (the bundled `journalctl` SSH auth
window, classified against a small local history of the Fleet's own previously-observed public
egress IP so an ISP NAT rotation doesn't read as an unknown intruder).

## Install

```bash
sudo cp hermes-linodemercury-watch.service hermes-linodemercury-watch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-linodemercury-watch.timer
```

Runs at 06:45 (Eastern, spark's local system time), after the 06:15 `hermes-pfsense-report.timer`
— comfortably after LinodeMercury's own 03:30 UTC bundle timer (LinodeMercury runs `Etc/UTC`;
03:30 UTC is late the previous Eastern evening), leaving hours of margin either way.

**First run must use `--seed-only`** — see Manual trigger below. Skipping this floods the first
digest with setup-time history (the very first bundle's journal window starts at the earliest
available journald entry, which includes this node's own provisioning) and normal
apt-upgrade lag, same reasoning `hermes-node-baseline-scan.py`'s own `--seed-only` exists for.

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-linodemercury-watch.py --dry-run
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-linodemercury-watch.py --seed-only   # first run only
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-linodemercury-watch.py
```

`--dry-run` pulls the real bundle, parses it, and prints the result — it never deletes the remote
bundle or touches state, safe to run repeatedly. If more than one bundle is waiting on
LinodeMercury (a missed retrieval day), each is processed in date order, oldest first.

## Verify

```bash
systemctl list-timers hermes-linodemercury-watch.timer
journalctl -u hermes-linodemercury-watch.service --no-pager
cat ~pmoney/.hermes/state/linodemercury-watch-state.json
ssh linodemercury 'ls /var/local/hermes-bundle/'   # should be empty after a successful run
```

## Requires

- `tools/hermes-linodemercury-watch.py`, `tools/vault-get-secret.sh` on spark. Standard library
  only — no venv needed.
- The `linodemercury` SSH alias in spark's `~/.ssh/config` (`User pmoney`, key
  `~/.ssh/linodemercury_access`) — set up directly against the node, not tracked in this repo.
- Vault items `memory-token` (field `password`), `matrix-fleetops` (fields `password`, `room`),
  `email-sintra` (field `password`) — all already provisioned, same ones
  `hermes-node-baseline-scan.py`/`hermes-pfsense-report.py` use. No new Vaultwarden identity is
  needed for this tool — it runs entirely on spark's own already-provisioned identity, never on
  LinodeMercury.

## Real findings from live setup (2026-10-09)

- Debian 13 / OpenSSH 10.0's privilege-separation re-exec model logs connection handling under
  comm `sshd-session`, not the classic `sshd` — and, confirmed live across many real successful
  logins during setup, `Accepted publickey for ...` was never actually logged at default
  `LogLevel` under it at all. `Disconnected from user X <ip> port N` is reliably present for every
  real session and implies successful auth, so it's the primary signal `review_auth_log()` uses;
  `Accepted ...` is kept as a best-effort secondary match. The bundler's own `journalctl` call
  matches both `_COMM=sshd` and `_COMM=sshd-session`.
- `journalctl --cursor-file=FILE --since=...` together is a hard error ("specify only one of").
  The bundler uses `--cursor-file` alone — its own documented first-run behavior (start at the
  earliest available journal entry) is exactly what's wanted, bounded by the node's own
  `journald` `MaxRetentionSec=90day` cap, not unbounded.
- A "Failed password for invalid user X from IP" line appears in the journal **regardless of
  `PasswordAuthentication no`** — confirmed live against this node's very first real bundle,
  which already had one from ordinary internet background scanning (`109.160.32.146` trying
  `r-config-10`). OpenSSH/PAM still processes and logs a received password-auth packet before
  policy refuses access; the client doesn't need the server to have advertised the method. This
  is routine noise on any box with `22/tcp` open to the world, same class of non-signal as
  pfSense's own "known-benign WAN inbound blocked" bucket — **not** turned into a finding here,
  only surfaced as a count in the digest. The real, impossible-by-design signal is a password
  attempt that actually *succeeds*.
- The remote bundle (and its containing directory) is produced by a root systemd service on
  LinodeMercury, so `pmoney` can list and `scp` it (directory is traversable/readable) but cannot
  delete it without `sudo` — confirmed live on the first real cleanup attempt. Fixed with
  `sudo rm -f` in `cleanup_remote_bundle()`.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-09 | Initial version — S28. Built, deployed, and live-verified end to end against a real bundle from LinodeMercury: real bugs found and fixed the same day (sshd-session comm/missing Accepted lines, the cursor-file/--since conflict, the PAM failed-password false-positive, and the root-owned bundle directory needing sudo to clean up). |
