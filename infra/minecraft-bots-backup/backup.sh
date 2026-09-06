#!/bin/bash
# Version: 1.0.0
#
# Nightly backup for the bot Minecraft world, styled on /opt/minecraft/backup.sh (the human
# server's own backup script) but simpler in one real way: this instance has no RCON enabled
# (see MINECRAFT_BOTS_DESIGN.md -- bots connect via the game protocol, not RCON, and RCON was
# left off to keep this instance's surface minimal), so there's no `save-off`/`save-all
# flush`/`save-on` pause around the tar the way the human server's script does. This is a real,
# accepted tradeoff, not an oversight: worst case is losing whatever changed since the last
# autosave, a low-consequence risk for a personal sandbox world. Also simpler than the human
# server's script in one more way: modern Minecraft (26.x) nests the nether/end dimensions as
# DIM-1/DIM1 subfolders inside the main world directory rather than sibling
# world_nether/world_the_end directories -- confirmed live (only one top-level "firmament-bots"
# directory exists) -- so one tar covers the whole world, not three.
BACKUP_DIR=/home/zomboid-admin/minecraft-bots/backups
WORLD_DIR=/home/zomboid-admin/minecraft-bots
WORLD_NAME=firmament-bots
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)

mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/${WORLD_NAME}_$TIMESTAMP.tar.gz" -C "$WORLD_DIR" "$WORLD_NAME"
find "$BACKUP_DIR" -name "${WORLD_NAME}_*.tar.gz" -mtime +7 -delete
