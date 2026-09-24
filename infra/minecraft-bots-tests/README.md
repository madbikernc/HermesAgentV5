# minecraft-bots-tests — install checklist

**Version:** 1.0.0

Daily run of the Minecraft bot test system (`services/minecraft-bots/tests/`, see its README).
Reports land in `/mnt/hermes-data/minecraft-memory/test-reports/`, and a failing run leaves the
unit `failed` in `systemctl --failed`.

- **spark:** runs everything (`MB_TEST_SUITE=all`): unit checks, live scenarios as `MBTester`,
  and spark's baseline.
- **spark2:** runs `baseline` only; one live tester per day is enough.

```bash
sudo cp infra/minecraft-bots-tests/minecraft-bots-tests.{service,timer} /etc/systemd/system/
# spark2 only:
sudo sed -i 's/^Environment=MB_TEST_SUITE=all/Environment=MB_TEST_SUITE=baseline/' \
  /etc/systemd/system/minecraft-bots-tests.service
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-bots-tests.timer
```

Run it once by hand with `sudo systemctl start minecraft-bots-tests.service`, then read the result
with `journalctl -u minecraft-bots-tests.service -n 50`.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-24 | Initial daily test timer. |
