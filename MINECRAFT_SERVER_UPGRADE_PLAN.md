# Bot Server Upgrade Plan: 1.21.11 → 26.1.2

**Version:** 1.0.0

Plan for upgrading the bot game server (`minecraft-bots.service`, muncraft `192.168.1.221:25580`)
from Minecraft 1.21.11 to 26.1.2, trialled on a separate copy first. The human server on `:25565`
(`/opt/minecraft/`) is out of scope and must not be touched at any step.

## 1. Why 26.1.2, and not 26.3

Checked 2026-11-14:

| | Value |
|---|---|
| Running now | 1.21.11, protocol 774 (status ping). `MINECRAFT_BOTS_DESIGN.md` §2 says 26.1.2; that line is wrong |
| Bot libraries (spark and spark2) | mineflayer 4.39.0 (npm's latest), minecraft-protocol 1.68.0, minecraft-data 3.116.0 |
| Newest version mineflayer supports | 26.1, on the installed release and on upstream master alike |
| 26.1 / 26.1.1 / 26.1.2 | all protocol 775; the installed minecraft-data resolves 26.1.2 to 26.1's data |
| 26.2 / 26.3 (Mojang's latest) | protocols 776 / 777; no mineflayer support anywhere yet, so every bot would fail to connect |
| 1.21.11 → 26.1 data diff | no block, item or entity removed or renamed; two blocks added (`golden_dandelion`, `potted_golden_dandelion`) |
| Java | 1.21.11 needs Java 21; 26.1.2 needs **Java 25** (Mojang version metadata) |

No bot code or npm change is planned: the bots auto-detect the server's version
(`index.js` `createBot` passes none), and every plugin reads the version-aware registry. A
`minecraft-data` bump (3.119.0 exists) is deliberately left out, so the trial changes one thing.

Integrations: `hermes-minecraft-admin.py` and `hermes-game-server-monitor.py` talk RCON / process
checks, which are version-independent. Gamerule names are already snake_case on 1.21.11.

## 2. Risks the trial exists to answer

1. **26.1 is mineflayer's newest and least-exercised version.** Packet-level changes (the kind
   behind the known `use_item` boat bug, `action-movement.js`) show up only in play, which is
   what `tests/run.sh live` / `livebot` exercise.
2. **The world upgrade is one-way.** A world opened on 26.1.2 cannot be opened on 1.21.11 again.
   Rollback means restoring the pre-upgrade snapshot and losing everything after it.
3. **Java 25 on a shared box.** The human server shares muncraft. Java 25 is installed side by
   side and named by full path in the bot server's own command only; the system default `java`
   is never changed.
4. **A third Java server on the box during the trial.** Memory headroom is unknown, and a
   name-based process match can confuse the trial with the real server (§2 of the design doc
   already warns about `pgrep`).
5. **Flaky live suite.** Results move between runs (2026-11-14: live 49/55, livebot 12/14; the
   2026-11-13 deploy run: 54/55, 13/14), so a single trial run proves nothing on its own.

## 3. Phases

### Phase 0 — access and prerequisites (operator)

- This machine's SSH to muncraft fails host-key verification. The operator either confirms and
  records the host key, or runs the muncraft steps through `hermes-minecraft-admin.py` from spark.
  Never bypass host-key checking.
- On muncraft, record: free RAM (`free -h`), free disk under `/home/zomboid-admin`, the current
  `java -version`, and the bot server unit's `ExecStart` and `-Xmx`.
- Install a Java 25 JDK side by side (for example `/opt/jdk-25`); confirm
  `/opt/jdk-25/bin/java -version` and that plain `java -version` is unchanged.
- Go only if there is RAM for a third server at the bot server's own `-Xmx`. If not, run the trial
  with the human server's player count at zero and say so in the trial log, or trial at a smaller
  heap and note it.

### Phase 1 — reference runs on 1.21.11 (spark)

- Run `tests/run.sh live` and `tests/run.sh livebot` twice against the real server, at least an
  hour apart, outside the daily chain's window. Combined with the daily reports in
  `/mnt/hermes-data/minecraft-memory/test-reports/`, this gives the **reference failure set**: the
  scenarios that fail at least once on 1.21.11.

### Phase 2 — build the trial instance (muncraft)

- `save-all flush` on the real server over RCON, then **copy** (never move) `firmament-bots` to
  `/home/zomboid-admin/minecraft-bots-trial/firmament-bots`. The real server keeps running.
- Download the 26.1.2 `server.jar` from Mojang's version manifest and check its SHA-1 against the
  manifest's.
- Copy `server.properties`, `ops.json`, `whitelist.json` and `eula.txt`, then change only
  `server-port=25590` and `rcon.port=25591`. `MBTester` and `MBProbe` must stay opped: the live
  harness sets up scenarios with op commands.
- Start it by hand as a transient unit, never a new permanent one:
  `systemd-run --unit=minecraft-bots-trial … /opt/jdk-25/bin/java -Xmx… -jar server.jar nogui`.
- Check:
  - a status ping on `:25590` reports 26.1.2 / protocol 775;
  - the log's world upgrade completes with no errors;
  - RCON on `:25591` reads `mob_griefing=false`, `keep_inventory=true`, `spawn_phantoms=false`
    and `difficulty easy` (they live in the world save, so they should carry over);
  - the real server still answers 1.21.11 on `:25580`, and the human server is untouched.

### Phase 3 — the suites against the trial (spark)

- Run `MC_PORT=25590 tests/run.sh live` and `MC_PORT=25590 tests/run.sh livebot` twice, the same
  way as Phase 1. Both live test files already read `MC_HOST`/`MC_PORT`.
- **Pass:** every scenario that fails on the trial is in the Phase 1 reference failure set. Any
  scenario that passes on 1.21.11 and fails on 26.1.2 is root-caused before going further. A fix
  that belongs in bot code is a normal bot change, with its own tests, made before cutover.
- `tests/run.sh unit` does not touch a server, so it is not part of the comparison.

### Phase 4 — integration checks against the trial

- RCON against `:25591`: `list`, `seed`, `gamerule <name>` and `save-all flush` all answer as on
  1.21.11. `hermes-minecraft-admin.py` hard-codes the real server's RCON port, so these go
  through its RCON client by hand with the trial port. Never repoint the tool at the trial port.
- `hermes-game-server-monitor.py`: confirm its bot-server check still reports the **real**
  server, not the trial process.
- Optional soak: one MBProbe-style bot on the trial for about 2 hours with a temporary
  `MC_MEMORY_ROOT` and `MC_RAG_DISABLED=1`, so nothing reaches the fleet's memory or RAG. Watch
  its journal for protocol errors (`PartialReadError`, `SizeOf error`, kicked/disconnect reasons).

### Phase 5 — go / no-go (operator)

Present Phases 3–4's comparison: scenario-by-scenario reference vs trial, every new failure and
its cause, and the RCON/monitor results. Cutover happens only on an explicit go.

### Phase 6 — cutover (muncraft + both bot hosts)

1. Stop the running bots (Amy and Luke on spark; Bob, Dale and Wade on spark2) and the spark test
   timer chain.
2. RCON `save-all flush`, then `sudo systemctl stop minecraft-bots`. Confirm the PID that owned
   `:25580` has exited; don't trust a name-based `pgrep`.
3. Take a stopped-server snapshot: `firmament-bots.RESTORE-POINT-<ts>-pre-26.1.2`.
4. Keep the old jar as `server-1.21.11.jar` and install the verified 26.1.2 `server.jar`.
5. Change the unit's `ExecStart` to `/opt/jdk-25/bin/java` (sudo on muncraft), then
   `daemon-reload` and `start`.
6. Verify: ping reports 26.1.2, RCON `seed` is unchanged (`-851936759013419345`), and the four
   gamerules are intact.
7. Start the five bots, then check RCON `list`.
8. Run the spark chain once by hand: `systemctl start minecraft-bots-tests-fast.service`.
9. Docs, in the same change: `MINECRAFT_BOTS_DESIGN.md` §2's version line (26.1.2, and the Java 25
   path), `infra/minecraft-bots-backup/README.md` if the backup needs anything new, and the new
   restore point in §2's table.

### Phase 7 — rollback (only if cutover fails)

Stop the server, move the 26.1.2 world aside as `firmament-bots.bak-<ts>-26.1.2` (never delete
it), restore the Phase 6 snapshot, put back `server-1.21.11.jar` and the Java 21 `ExecStart`,
start, and verify the ping reports 1.21.11. Anything built after cutover is lost by design.

### Phase 8 — afterwards

- About a day after cutover, `tests/run.sh baseline --update` on spark and spark2; commit both
  baselines. Any metric that moved gets explained before it's recorded.
- Tear down the trial: stop the transient unit and remove `minecraft-bots-trial/`, after the
  operator confirms.

## 4. Phase status

| Phase | Status | Date | Notes |
|---|---|---|---|
| 0. Access and prerequisites | not started | 2026-11-14 | Blocked on muncraft access from this machine (host-key verification fails) |
| 1. Reference runs on 1.21.11 | not started | 2026-11-14 | |
| 2. Build the trial instance | not started | 2026-11-14 | |
| 3. Suites against the trial | not started | 2026-11-14 | |
| 4. Integration checks | not started | 2026-11-14 | |
| 5. Go / no-go | not started | 2026-11-14 | Operator decision |
| 6. Cutover | not started | 2026-11-14 | |
| 7. Rollback | not needed yet | 2026-11-14 | Only if cutover fails |
| 8. Afterwards | not started | 2026-11-14 | |

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-14 | Direct operator request ("plan the trial upgrade"): initial plan, from 2026-11-14's compatibility check. |
