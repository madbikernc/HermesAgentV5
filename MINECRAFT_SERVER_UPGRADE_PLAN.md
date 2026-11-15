# Bot Server Upgrade Plan: 1.21.11 → 26.1.2

**Version:** 1.4.0

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

## 1a. Found while starting (2026-11-14)

- **Java 25 is already there.** `/usr/lib/jvm/java-25-openjdk-amd64` is installed and is the
  system default; the human server already runs 26.1.2 on it. Only the bot unit pins Java 21
  (`ExecStart=/usr/lib/jvm/java-21-openjdk-amd64/bin/java -Xms1G -Xmx8G ...`).
- **Room:** 31 GiB RAM, 22-23 GiB available with all three servers up; disk 3% used.
- **This server ran 26.x before, on its first day.** On 2026-09-06, 26.2 ran from 16:25 and 26.1.2
  from 17:15 to 22:36, then 1.21.11 from 22:37 (`versions/` and `logs/2026-09-06-*.log.gz`; the
  jars are kept as `server-26.1.2.jar.bak` and `server-26.2.jar.bak`). Nothing records why it went
  back. Disconnects don't explain it: about 7.5/h on 26.1.2 against 6.4/h on 1.21.11 that night.
  The design doc's "26.1.2" line is left over from that afternoon.
- **Access** goes through spark's `muncraft` SSH alias (pmoney, passwordless sudo). RCON is sent
  on the box by a script that reads `rcon.password` from that server's own `server.properties`
  there; the password never leaves the box.
- **Difficulty does not survive the upgrade.** Both `server.properties` files say
  `difficulty=normal`. On 1.21.11 the world save's Easy wins, but the 26.1.2 upgrade applied the
  file's value: the trial came up Normal (set back to Easy over RCON). The other three gamerules
  and the seed carried over.
- **The live suites' RCON was hard-wired to the real server.** `tests/live/rcon.py` sent every
  setup command (`tp`, `fill`, gamerules) to `:25581` in the real server's directory, whatever
  `MC_PORT` said. A trial run with only `MC_PORT` set would have built its arenas in the real
  world. rcon.py 1.1.0 takes `MC_RCON_PORT`/`MC_SANDBOX_DIR`, and refuses to run when `MC_PORT`
  isn't the real server's and `MC_RCON_PORT` isn't set.
- **The firewall (ufw) admitted only the real ports**, so `:25590` timed out from spark. At the
  operator's direction (2026-11-14) it is open for the duration of the test, with three rules that
  mirror 25580's exactly, each commented `TEMPORARY 26.1.2 trial`: 10.129.1.0/24, 100.64.0.0/10
  (Tailscale) and 192.168.1.215 (NAT hairpin). The trial's RCON port, 25591, is not opened: RCON is
  only used on the box. The rules come out when the trial ends (Phase 8).

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

- From a scratch clone on spark (`~/upgrade-trial/repo`) carrying rcon.py 1.1.0:
  `MC_PORT=25590 MC_RCON_PORT=25591 MC_SANDBOX_DIR=/home/zomboid-admin/minecraft-bots-trial`
  `tests/run.sh live`, then `livebot`, twice, the same way as Phase 1.
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
6. Set `difficulty=easy` in `server.properties` before this start (see §1a). Verify: ping reports
   26.1.2, RCON `seed` is unchanged (`-851936759013419345`), and the four gamerules are intact.
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
- Tear down the trial: stop the transient unit, delete the three `TEMPORARY 26.1.2 trial` ufw
  rules (`sudo ufw status numbered`, then `sudo ufw delete` each, highest number first), and remove
  `minecraft-bots-trial/` after the operator confirms. The ufw rules come out at the end of the
  trial even if there is no cutover.

## 4. Phase status

| Phase | Status | Date | Notes |
|---|---|---|---|
| 0. Access and prerequisites | done | 2026-11-14 | Via spark's `muncraft` alias. Java 25 already installed (§1a); RAM and disk ample |
| 1. Reference runs on 1.21.11 | done | 2026-11-14 | live 52/55, 53/55; livebot 11/14, 11/14. Reference failures: get_wool from string (x2), wrong-way door reset, sealed-in-rock dig-out, clear_access on a chest; livebot: full-inventory drop, held bed into empty shelter, complete shelter vs new site, new chest when all full (x2). The daily journal only reaches back to this morning (49/55, 12/14) |
| 2. Build the trial instance | done | 2026-11-14 | `/home/zomboid-admin/minecraft-bots-trial`, transient unit `minecraft-bots-trial`, Java 25, `:25590`/`:25591`. World upgraded in 2.2s, no errors; seed and three gamerules intact, difficulty reset to Normal and set back to Easy |
| 3. Suites against the trial | done | 2026-11-14 | live 53/55, 52/55; livebot 11/14, 11/14. Two failures not in the reference set, once each: chicken hunt (no raw chicken in hand) and dirt-to-stone reface (first shelter 4 blocks short). Both re-run alone 5x on each server: 10/10 pass on 1.21.11, 10/10 on 26.1.2 — in-suite flakes, not version regressions. Every other trial failure is in the reference set |
| 4. Integration checks | done | 2026-11-14 | RCON `list`, `seed`, `gamerule`, `difficulty`, `save-all flush` answer on 26.1.2 (trial, then real server). Optional soak skipped |
| 5. Go / no-go | done | 2026-11-14 | Operator gave a conditional go in advance ("if the tests pass, do the upgrade"); Phase 3 passed |
| 6. Cutover | done | 2026-11-14 | 19:07 stop, restore point `firmament-bots.RESTORE-POINT-20261114-190757-pre-26.1.2`, unit `ExecStart` to Java 25 (old unit kept as `minecraft-bots.service.bak-pre-26.1.2`), `difficulty=easy`. A failed `cd` left the first start on Java 25 + the 1.21.11 jar for about 20s with no players; stopped, swapped, restarted. 19:08 on 26.1.2: world upgraded, seed and gamerules intact, Easy. All five bots joined; spark chain started by hand |
| 7. Rollback | not needed | 2026-11-14 | |
| 8. Afterwards | in progress | 2026-11-15 | Trial unit stopped, three temporary ufw rules deleted (none left on 25590). `minecraft-bots-trial/` and spark's `~/upgrade-trial/` removed on operator confirmation (2026-11-14). Residual post-upgrade test failures fixed (`docs/minecraft-bots-history.md` 2.51.0 row). Pending: baseline re-record on both hosts about a day after cutover |

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.4.0 | 2026-11-15 | Phase 8 progressed: trial directories removed, residual post-upgrade test failures fixed; only the baseline re-record remains. |
| 1.3.0 | 2026-11-14 | Phases 1, 3–6 done, 7 not needed, 8 in progress: trial passed (the two trial-only failures passed 10/10 re-run alone on both versions), cutover done under the operator's conditional go, temporary ufw rules removed. |
| 1.2.0 | 2026-11-14 | Operator direction: the trial's game port is opened in ufw for the duration of the test, three temporary rules mirroring 25580's (no tunnel); their removal added to Phase 8's teardown. |
| 1.1.0 | 2026-11-14 | Phases 0 and 2 done, Phase 1 in progress. New §1a with what starting turned up: Java 25 already installed, the server's own 26.x history, difficulty reset by the upgrade, the live suites' RCON hard-wired to the real server (rcon.py 1.1.0), and the firewall (tunnel). Phase 3's command and Phase 6's difficulty step updated to match. |
| 1.0.0 | 2026-11-14 | Direct operator request ("plan the trial upgrade"): initial plan, from 2026-11-14's compatibility check. |
