# LinodeMercury — node setup checklist

**Version:** 1.0.0

LinodeMercury (`74.207.233.234`, Debian 13 "trixie") is HermesAgentV5's first deliberately
**external** node (IMPLEMENTATION_PLAN.md S28) — not a fleet member like `spark`/`spark-2`/
`HomeD13`. Reachability is one-directional, **Fleet → Linode only**: it has no firewall-allowed
route into any network the Fleet considers internal, is not on Tailscale, and runs no code from
this repo. It exists to be hardened and observed as a genuinely internet-facing box, kept
deliberately flexible for roles not yet built: a vantage point for checking the Fleet's own
public-internet exposure, or an external honeypot to compare against the existing OpenCanary.

This is **this repo's own recipe** for what was actually done, written after the fact from a real
live setup, same discipline every other `infra/<node>/README.md` in this repo follows — not a
hypothetical.

## 1. Admin user (replaces root SSH)

Every other fleet node uses a dedicated non-root sudo user, never direct root SSH. LinodeMercury
started as root-only (initial key handoff) and was migrated the same session:

```bash
# As root, before anything else:
useradd -m -s /bin/bash pmoney
mkdir -p /home/pmoney/.ssh
cp /root/.ssh/authorized_keys /home/pmoney/.ssh/authorized_keys
chown -R pmoney:pmoney /home/pmoney/.ssh
chmod 700 /home/pmoney/.ssh
chmod 600 /home/pmoney/.ssh/authorized_keys
printf 'pmoney ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/pmoney
chmod 440 /etc/sudoers.d/pmoney
visudo -c
```

**Verify `ssh pmoney@<host>` and `sudo -n true` work before touching root access at all.**

## 2. SSH hardening

```bash
printf 'PermitRootLogin no\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/99-hermes-hardening.conf
sshd -t
systemctl restart ssh
sshd -T | grep -iE '^permitrootlogin|^passwordauthentication'   # expect: no / no
```

Verify via `sshd -T`'s own resolved config, not a raw `grep sshd_config` — a drop-in under
`/etc/ssh/sshd_config.d/` (confirmed present and included near the top of `sshd_config` on this
image) takes precedence over the rest of the file, but only `sshd -T` proves what actually won.
**Confirm a fresh `pmoney` session still works, then confirm root now fails, before moving on** —
this is the one step on this node with no out-of-band recovery path available to the Fleet if it
goes wrong (Linode's own Lish web console, outside this repo, is the user's independent fallback).

## 3. Firewall (ufw)

```bash
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH admin - key-only, no root, no password auth'
ufw --force enable
ufw status verbose
```

**Deliberately not scoped to the Fleet's current public egress IP.** A home ISP can rotate that
IP at any time; baking it into this firewall rule risks a self-inflicted, un-fixable-by-the-Fleet
lockout. Key-only auth with password/root login already disabled is the real control here, not
source-IP filtering. No other port is opened. `hermes-linodemercury-watch.py`
(`infra/hermes-linodemercury-watch/`) verifies this posture holds daily, pulling the Fleet's
*current* IP only to classify successful logins, never to firewall against it.

## 4. unattended-upgrades

```bash
apt-get install -y unattended-upgrades
cat /etc/apt/apt.conf.d/20auto-upgrades      # confirm both lines are "1" -- package default on this image
```

New for this fleet — no other node runs it, because none of them are directly internet-exposed
the way this one is. Confirmed live: the package's own shipped defaults (quiet logging, no mail,
`/etc/logrotate.d/unattended-upgrades` already present at `rotate 6 monthly compress`) already
satisfy "minimal, local" logging without any further tuning.

## 5. Bound every local log source

```bash
sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
sed -i 's/^#\?MaxRetentionSec=.*/MaxRetentionSec=90day/' /etc/systemd/journald.conf
systemctl restart systemd-journald
```

`journald` holds the sshd auth events the daily check reads — the single biggest unbounded-growth
risk on a long-lived box otherwise. 500M/90 days on a 25G disk leaves ample headroom.

## 6. aide, lynis, syft, grype — local-only, minimally logged

```bash
apt-get install -y aide aide-common lynis
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh  | sh -s -- -b /usr/local/bin
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin
```

**Disable the distro's own default daily aide job before doing anything else with aide** — a
daily full-filesystem re-hash has caused real resource-utilization amplification problems
elsewhere; this node runs aide weekly instead, via its own unit below:

```bash
systemctl disable --now dailyaidecheck.timer
systemctl mask dailyaidecheck.timer
```

(Debian 13's `aide-common` also ships `/etc/cron.daily/dailyaidecheck`, but it self-guards with
`[ -d /run/systemd/system ] && exit 0` — confirmed live, no double-run risk on a systemd host.)

Preventive excludes (confirmed live: this fresh VPS has no `/run/rpc_pipefs` mount and nothing
under `/mnt`, so neither of the other fleet nodes' real gotchas actually bites here — added
anyway, harmless, in case either ever becomes true):

```bash
echo '!/run/rpc_pipefs' | tee /etc/aide/aide.conf.d/90_hermes_exclude_run_rpc_pipefs
echo '!/mnt'            | tee /etc/aide/aide.conf.d/91_hermes_exclude_mnt
```

Establish the baseline (re-run after any deliberate bulk change, e.g. right after applying
pending package upgrades for the first time — confirmed live, this image's own
`gzip_dbout=yes` setting notwithstanding, the file actually produced was `aide.db.new`, not
`aide.db.new.gz` — check `/var/lib/aide/` before assuming which one to copy):

```bash
aide --init --config /etc/aide/aide.conf
ls /var/lib/aide/                       # confirm aide.db.new vs aide.db.new.gz before copying
cp /var/lib/aide/aide.db.new /var/lib/aide/aide.db
```

Install the four local timers (`hermes-linodemercury-aide` weekly, `-lynis` and `-cve-scan`
daily, `-bundle` daily after the other two) and their scripts from this directory:

```bash
install -m 755 hermes-linodemercury-aide-check.sh hermes-linodemercury-lynis-check.sh \
               hermes-linodemercury-cve-scan.sh hermes-linodemercury-bundle.sh /usr/local/bin/
install -m 644 hermes-linodemercury-aide.service hermes-linodemercury-aide.timer \
               hermes-linodemercury-lynis.service hermes-linodemercury-lynis.timer \
               hermes-linodemercury-cve-scan.service hermes-linodemercury-cve-scan.timer \
               hermes-linodemercury-bundle.service hermes-linodemercury-bundle.timer \
               /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hermes-linodemercury-aide.timer hermes-linodemercury-lynis.timer \
                       hermes-linodemercury-cve-scan.timer hermes-linodemercury-bundle.timer
```

Each writes to `/var/log/hermes-linodemercury/` (aide/syft/grype output) or lynis's own default
paths, always exiting 0 regardless of the underlying tool's own exit code — aide's `--check` exit
status is a bitmask (0-7 are normal "here's what it found" outcomes, not failures), and
interpreting it is `hermes-linodemercury-watch.py`'s job on spark's side, not this node's.

## 7. Bundling and retention — Fleet-driven, not a local timer

`hermes-linodemercury-bundle.sh` (daily, after the lynis/cve-scan timers) rolls up whatever scan
output currently exists plus `apt list --upgradable`, `ufw status verbose`, and the day's SSH
auth-log window into one compressed tarball under `/var/local/hermes-bundle/`, clearing the raw
files it just rolled up. **Bundles are never deleted by anything on this node on a schedule** — a
missed Fleet retrieval day would otherwise lose data to a blind local rotation. Deletion happens
only from spark, only after a bundle has been pulled and parsed without error (see
`infra/hermes-linodemercury-watch/README.md`).

## Real findings from live setup (2026-10-09)

- This node had 68 pending package upgrades and 471 fixable-CVE grype matches on first scan —
  normal image-to-now drift, not a finding worth alerting on. Applied `apt-get upgrade` and
  re-ran `aide --init` to re-baseline against the patched state before calling setup done, rather
  than let day-one patching show up as either a flood of "changed" aide findings or a
  misleadingly-high first CVE count.
- `journalctl _COMM=sshd` alone misses almost everything: Debian 13 ships OpenSSH 10.0, whose
  privilege-separation re-exec model logs real connection handling under comm `sshd-session`.
  See `infra/hermes-linodemercury-watch/README.md` for the rest of what this surfaced on the
  parsing side.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-09 | Initial version — S28. Node bootstrapped from root-only to the fleet's standard non-root/key-only/ufw/unattended-upgrades/aide+lynis+syft+grype posture, live-verified end to end (sshd hardening, firewall, package upgrade, aide re-baseline, all four local timers running). |
