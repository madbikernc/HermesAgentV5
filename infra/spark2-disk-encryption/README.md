# spark-2 disk encryption — recreate checklist

**Version:** 2.0.0

Closes a real, verified gap: unlike `spark` (`/opt/hermes-data.img`, LUKS2 file-backed container), `spark-2`'s
model storage (`/opt/hermes-models/`) sits on the plain, unencrypted root filesystem — confirmed live
2026-08-25 (`findmnt -t crypto_LUKS` returns nothing on `spark-2`). Direct request, part of a spark/spark-2
parity pass.

**Needs a human with real root on `spark-2`** — as of 2026-08-25, `pmoney` has full passwordless sudo there
(`(ALL : ALL) NOPASSWD: ALL`), a change from this doc's original access ceiling (previously only Amy's
account, with a narrow explicit `systemctl restart`-only allowlist). Steps 1-3 (container creation, and
this version's manual-unlock setup) have since been executed live. This is still written as a manual
runbook, same shape as `infra/model-abliteration/README.md`'s one-time install or `HermesAgentRedo`'s
`infra/muncraft-tailscale-ext/` checklist — the passphrase prompts and destructive steps (Step 5) are
deliberately kept as a human's own action either way.

## Why not whole-disk encryption

**Not safe on this hardware** — `HermesAgentRedo/LESSONS_LEARNED.md`'s own §3a-adjacent finding: the Spark's
boot and storage share the same NVMe, so drive-level encryption (OPAL self-encrypting-drive locking, NVIDIA's
own `nv-disk-encrypt`) locks the drive at power-off and the machine won't boot again. `spark` already worked
around this with a **LUKS2 file-backed image** instead — a container file living on the (necessarily
unencrypted) root filesystem, opened as a loop device. This checklist does the same on `spark-2`.

## Why this ended up matching spark's manual-unlock design after all

**v1.0.0 of this doc proposed TPM2-sealed auto-unlock instead of copying `spark`'s manual design**,
reasoning that spark-2's real TPM2 chip (fTPM, enabled in BIOS at Stage 7) made auto-unlock achievable
where `spark` never attempted it. Real testing disproved that:

- Enrolled `systemd-cryptenroll --tpm2-device=auto` (default: seals to PCR7, secure-boot-policy).
  Rebooted. Unseal failed at boot: `Esys_Unseal_Finish() Received TPM Error`, `ErrorCode (0x00000128)`,
  `Failed to unseal secret using TPM2: Invalid argument` — fell through to a manual passphrase prompt.
- Wiped the slot, re-enrolled against PCR0 (platform firmware code — should be far more stable than
  PCR7 across boots) instead. Rebooted again. **Identical failure.** This ruled out PCR selection as
  the cause entirely — something more fundamental was wrong.
- Root cause, found via `dmesg`: `systemd-pcrmachine.service`, `systemd-tpm2-setup-early.service`,
  `systemd-tpm2-setup.service`, and `systemd-pcrextend.socket` **all skip with
  `ConditionSecurity=measured-uki`**. spark-2 boots via GRUB + shim (Secure Boot enabled), not a
  measured Unified Kernel Image (`bootctl` isn't even installed — no systemd-boot present at all).
  systemd's TPM2 measured-boot machinery, including the service that sets up and persists the TPM's
  Storage Root Key, only activates under a measured-UKI boot. Without it, `systemd-cryptenroll`
  (run interactively, post-boot) and `systemd-cryptsetup@` (run during early boot) each derive an
  ephemeral primary key from the TPM independently, and the two don't reliably agree — regardless of
  which PCR the seal is bound to.
- Fixing this properly would mean migrating spark-2's bootloader to systemd-boot + UKI (with its own
  Secure Boot re-signing/MOK-enrollment complexity on top). Evaluated and set aside: this hardware has
  **no BMC/IPMI/Redfish** (`ipmitool` is installed but there's no backing device — confirmed live), the
  one prior firmware-level fix on this same hardware (enabling fTPM itself) required physical console
  access, and there's no established remote-recovery path if a new boot config doesn't come up. Not
  worth that risk for a data-volume encryption nicety.

**Conclusion: manual unlock, exactly like `spark`.** The TPM keyslot was wiped
(`systemd-cryptenroll --wipe-slot=tpm2`), the `/etc/crypttab` entry was removed, and only the original
passphrase keyslot remains — same single-keyslot shape as `spark`'s container. `spark`'s own container
(`/opt/hermes-data.img`) has zero crypttab entries and zero fstab entries; every unlock after every
reboot there is a fully manual `cryptsetup luksOpen` + `mount`. spark-2 now matches that, with one small
convenience kept: the `/etc/fstab` line stays (it only takes effect once the mapper device exists, i.e.
after a manual `luksOpen`), so only `luksOpen` + `mount` (not a full manual `mkfs`-style mount options
line) is needed post-reboot. This is a real, accepted standing operational risk — a reboot leaves
`omni`/`muse` unable to start until a human notices and runs the two commands below — same risk `spark`
already carries in production.

**Manual unlock after every reboot:**
```bash
sudo cryptsetup luksOpen /opt/hermes-data.img hermes-data
sudo mount /mnt/hermes-data
```

## Sizing

`/opt/hermes-models/` is 107GB today (confirmed live 2026-08-25: `omni` 25.4GB, `muse` 20.0GB, `coder`
45.9GB retired-but-kept, plus manifests/misc). `spark-2`'s root filesystem has 3.3TB free. Sized the new
container at **2TB** to match `spark`'s own container size exactly (consistency, not a capacity calculation)
— it's a sparse file, so it costs nothing beyond what's actually written to it.

## 1. Create the LUKS2 container (no live disruption — do this whenever convenient)

```bash
sudo fallocate -l 2T /opt/hermes-data.img
sudo chmod 600 /opt/hermes-data.img

# Interactive -- you'll be prompted for a passphrase. This becomes keyslot 0 -- the only keyslot
# (TPM auto-unlock was tried and doesn't work on this boot chain, see below) -- so save it durably.
sudo cryptsetup luksFormat --type luks2 /opt/hermes-data.img

sudo cryptsetup luksOpen /opt/hermes-data.img hermes-data
sudo mkfs.ext4 -L hermes-data /dev/mapper/hermes-data
```

## 2. Skip TPM enrollment — go straight to fstab + manual unlock

TPM2 auto-unlock was tried and doesn't work on this hardware's boot chain (see "Why this ended up
matching spark's manual-unlock design after all" above). Only the passphrase keyslot from Step 1 exists.

```bash
# /etc/fstab -- takes effect once the mapper device exists (i.e. after luksOpen below).
# No /etc/crypttab entry -- same as spark, this stays fully manual.
echo '/dev/mapper/hermes-data /mnt/hermes-data ext4 defaults 0 2' | sudo tee -a /etc/fstab

sudo mkdir -p /mnt/hermes-data
sudo mount /mnt/hermes-data
```

**Verify manual unlock survives a reboot as expected** — reboot `spark-2` once (coordinate timing — this
takes `omni`/`muse` down for the reboot regardless) and confirm it prompts for the passphrase at boot
(this is the expected, accepted behavior, matching `spark`):

```bash
sudo reboot
# after it's back up, it should have prompted for the passphrase already (console/serial).
# then, over SSH:
sudo cryptsetup luksOpen /opt/hermes-data.img hermes-data   # only needed if not unlocked at the console prompt
sudo mount /mnt/hermes-data
mountpoint /mnt/hermes-data && echo "mounted"
```

## 4. Migrate `/opt/hermes-models/` — bulk copy while services stay live, brief stop only for cutover

Bulk copy first, with everything still running — the `.gguf` files aren't being modified while `llama-server`
has them open for read, so this is safe to do live:

```bash
sudo mkdir -p /mnt/hermes-data/models
sudo rsync -av --progress /opt/hermes-models/ /mnt/hermes-data/models/
```

Verify byte-for-byte before touching anything live:

```bash
diff <(cd /opt/hermes-models && find . -type f -exec sha256sum {} \; | sort) \
     <(cd /mnt/hermes-data/models && find . -type f -exec sha256sum {} \; | sort)
# no output = identical
```

**Now the actual cutover — this is the only part with real downtime**, and it's short (file moves +
service restarts, not a multi-GB copy):

```bash
sudo systemctl stop llama-amy-vision.service llama-muse.service

# Catch anything that changed during the bulk copy above (should be nothing for static model files,
# but re-run rsync's own diff logic rather than assume):
sudo rsync -av --progress /opt/hermes-models/ /mnt/hermes-data/models/

# Repoint both start scripts at the new path
sudo sed -i 's|/opt/hermes-models/|/mnt/hermes-data/models/|' /opt/llama.cpp/start-omni.sh /opt/llama.cpp/start-muse.sh
grep -H model= /opt/llama.cpp/start-omni.sh /opt/llama.cpp/start-muse.sh  # confirm the new path took

sudo systemctl start llama-amy-vision.service llama-muse.service
```

Verify both healthy through the live router afterward (not just a direct health check), same standard this
project uses for every model swap:

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"omni","messages":[{"role":"user","content":"say OK"}],"stream":false,"max_tokens":5}'
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"muse","messages":[{"role":"user","content":"say OK"}],"stream":false,"max_tokens":5}'
```

## 5. Only after both are confirmed healthy — remove the old plaintext copy

```bash
sudo rm -rf /opt/hermes-models/
```

Not automated, not bundled into any step above on purpose — a real, deliberate, separate action once the
encrypted copy is proven working, same "destructive actions are a human's own step" discipline
(`IMPLEMENTATION_PLAN.md` §5 constraint 5) every other tool in this fleet follows.

## Update after migration

Once done, `~/.hermes/config/model-archive-roles.json` on `spark-2` (still not created — Stage 13's own
open item) should point at `/mnt/hermes-data/models/...` paths, not `/opt/hermes-models/...`, when it's
eventually set up.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-25 | Initial checklist, direct request as part of a spark/spark-2 parity pass. Not yet executed — needs a human with real root on `spark-2`. |
| 2.0.0 | 2026-08-25 | Reversed the TPM2-auto-unlock design after real testing (3 reboots) proved it non-functional on this GRUB-boot, non-measured-UKI hardware regardless of PCR selection — root cause: systemd's TPM2 measured-boot services (incl. persistent SRK setup) require a measured-UKI boot, which this isn't. Evaluated migrating to systemd-boot+UKI to fix properly; set aside (no BMC/IPMI on this hardware, no established remote-recovery path). Executed: wiped the TPM keyslot, removed the `/etc/crypttab` entry, now matches `spark`'s manual-unlock design exactly. Steps 1-2 rewritten to match; Steps 4-5 (migration) unchanged and still pending. |
