---
name: minecraft-plugin-management
description: "Workflow for deploying a PaperMC instance and installing/updating/verifying plugins on it, for the muncraft box (192.168.1.221)."
version: 1.0.0
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Minecraft, PaperMC, plugins, muncraft]
    related_skills: [minecraft-admin, game-server-monitor]
prerequisites:
  commands: []
---

# Minecraft Plugin Management

**Version:** 1.0.0

Workflow for standing up a PaperMC instance (plugin-capable) alongside the
vanilla Minecraft server on `192.168.1.221`, and for installing, updating,
and verifying plugins on it.

**Current status on this box, confirmed live by
[[game-server-monitor]]'s own build history: `25566/tcp` is already
firewalled open and tagged `# Minecraft Paper` in the live UFW ruleset, but
no PaperMC process, systemd unit, or `/opt/paper` directory exists yet.**
This skill is provisioned ahead of that server existing — treat everything
below as the plan for when it's stood up, not a description of a server
that's currently running. Check with [[game-server-monitor]] or
`systemctl status paper.service` (or equivalent) before assuming Paper is
live.

This is a v1→V5 port of `HermesAgent/skills/devops/minecraft-plugin-management`,
carried forward unmodified in substance — none of HermesAgentV4,
HermesAgentRedo, or the current V5 tree had picked this skill up before now,
and the PaperMC/plugin workflow itself doesn't depend on anything that
changed between those repos.

## Installation Workflow

1. **Compatibility Check**: Verify the plugin supports the current server version (e.g., 1.21.4).
2. **Sourcing**: Prefer Modrinth over Hangar/Spigot for AI agents. Search for direct CDN links via web search, or use the Modrinth API for automated version discovery (see `references/modrinth-api.md`). **Crucial**: When using the API, filter results by loader (e.g., `bukkit`, `spigot`) to avoid downloading Forge/Fabric versions by mistake.
3. **Deployment**: Download the `.jar` directly into the `plugins/` directory.
4. **Server Restart**:
   - Stop the server: `pkill -u <user> -f paper.jar`
   - Start the server: `./start.sh`
   - **Note**: Do NOT use `nohup` or `&` inside a foreground `terminal()` call; Hermes blocks shell-level backgrounding. Use `terminal(background=true)` or issue the start command as a separate final step.
5. **Verification**:
   - Check for load success: `grep -ai 'PluginName' boot.log` or `grep -ai 'PluginName' logs/latest.log`
   - Check for errors: `grep -iE 'error|exception|failed' logs/latest.log`

## PaperMC Installation & Setup

To deploy a PaperMC instance alongside the vanilla server:

1. **Build Discovery:** Use the PaperMC API to find the latest build for the target version (e.g., 1.21.4).
2. **Deployment:** Download the jar to a dedicated directory (e.g., `~/minecraft-paper` if `/opt` is restricted).
3. **Configuration:**
   - Accept EULA: `echo "eula=true" > eula.txt`
   - Set a unique port in `server.properties` (e.g., `server-port=25566`) to avoid conflicts with the vanilla server (25565) — this is the exact port already firewalled open on this box for exactly this purpose.
4. **Execution:** Start with `java -Xms2G -Xmx2G -jar paper.jar nogui`.
5. **Plugins:** Install plugins into the `plugins/` directory.

**Example Setup Workflow:**
```bash
mkdir -p ~/minecraft-paper && cd ~/minecraft-paper
curl -L -o paper.jar "<api-download-url>"
echo "eula=true" > eula.txt
echo "server-port=25566" > server.properties
java -Xms2G -Xmx2G -jar paper.jar nogui
```

### Configuration Synchronization
When deploying a secondary server (e.g., PaperMC alongside vanilla), synchronize operator lists, whitelists, or banned-players to maintain consistency:
1. **Copy from source**: `sudo cp /opt/minecraft/ops.json /home/muncraft/minecraft-paper/ops.json`
2. **Fix Ownership**: `sudo chown muncraft:muncraft /home/muncraft/minecraft-paper/ops.json`
3. **Restart**: Restart the target server to apply the changes.

## Critical Pitfalls & Fixes

### 1. JAR Corruption & PluginRemapper Failures
- **Symptom**: `java.util.zip.ZipException: zip END header not found` or `Failed to open plugin jar` in logs.
- **Causes**:
  - **Anti-Bot Corruption**: Using `wget`/`curl` on sites like SpigotMC or Bukkit may return a `200 OK` but the file is actually an HTML error page. This is the most common cause of this error for AI agents.
  - **Legacy Formats**: Paper 1.21.4 `PluginRemapper` may reject certain older JAR formats.
- **Fix**: Verify the file is a valid ZIP/JAR before booting. If corrupted, seek a direct CDN link (e.g., Modrinth API) or a mirror.

### 2. Server Lock & Port Bind Failures
- **Symptom**: `net.minecraft.util.DirectoryLock$LockException: ... session.lock: already locked` or `FAILED TO BIND TO PORT! Address already in use`.
- **Cause**: A zombie process is still holding the port/lock, or a crash left a stale lock file on disk.
- **Recovery Sequence**:
  1. **Identify & Kill**: Find the process ID (`pgrep -u <user> -f paper.jar`) and kill it (`kill <pid>` or `pkill`).
  2. **Clear Lock**: Manually remove the lock file: `rm ~/minecraft-paper/world/session.lock`.
  3. **Verify Clean State**: Ensure `pgrep` returns nothing before attempting restart.
  4. **Restart**: Run `./start.sh`.
- **Note**: If `pkill` is blocked or fails, use `ps -fp <pid>` to verify the process is gone.

### 3. Unsupported Version Warnings
- **Symptom**: `You are running an unsupported server version!`
- **Context**: Common with EssentialsX on very new Paper versions.
- **Action**: If the plugin otherwise loads and functions, this can be ignored as it's often just a missing version tag in the plugin's metadata.

### 4. API Version Mismatch
- **Symptom**: `org.bukkit.plugin.InvalidPluginException: Unsupported API version X.Y.Z` in logs.
- **Cause**: The plugin was compiled for a version of the server API that is incompatible with the current server binary.
- **Fix**: Update the plugin to a version that explicitly supports the current server version, or downgrade the server (rarely preferred).

### 5. Latest != Compatible (Version Drift)
- **Symptom**: Plugin fails to load or throws `IllegalArgumentException: bukkit version incompatible!` despite being the "latest" release.
- **Cause**: Some complex plugins (e.g., Dynmap) may have a "latest" release that targets a different MC version or is a beta that broke compatibility with the specific Paper build.
- **Fix**: Check release notes or use the Modrinth API to find a specific version that explicitly lists the current MC version (e.g., 1.21.4) as supported, rather than blindly taking the most recent entry.

### 6. Bukkit/Spigot Download Blockers (403 Forbidden)
- **Symptom**: `wget` or `curl` returns `403 Forbidden` when attempting to download from `dev.bukkit.org` or `spigotmc.org`.
- **Cause**: Anti-bot protections (Cloudflare/similar) block non-browser user-agents.
- **Fix**: Avoid direct downloads from these sites via CLI. Use the Modrinth API or search for official mirrors/alternative CDN links that allow direct downloads.

## Verification Commands
- **Check if server is running**: `ps aux | grep paper.jar`
- **Check plugin files**: `ls -lh plugins/`
- **Verify Load Success**: `ssh 192.168.1.221 "tail -n 100 ~/minecraft-paper/logs/latest.log | grep -i 'successfully enabled'"`
- **Check for critical errors**: `grep -iE 'error|exception|failed' logs/latest.log`
- **Check logs for specific plugin**: `grep -ai 'PluginName' logs/latest.log`

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-06 | Ported forward from v1's `HermesAgent/skills/devops/minecraft-plugin-management` — untouched in substance (the PaperMC/plugin workflow doesn't depend on anything that changed between v1 and V5). Added the live status note: `25566/tcp` is already firewalled for this on the muncraft box (per [[game-server-monitor]] 1.4.0), but no Paper instance is actually running yet. Not ported into HermesAgentV4 or HermesAgentRedo before this. |
