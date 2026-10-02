#!/bin/bash
# Version: 1.0.0
#
# Keeps the bot world's chickens and dropped eggs in check (minecraft-bots.service, RCON 25581 on
# this box). 2026-09-27: 2,853 chickens and 1,356 dropped items had piled up around the bots' base
# -- chickens follow anyone holding seeds, the farming bots carry them, and every loaded chunk
# brings its own -- and the server fell to ~8 ticks/s (148 ms/tick). Culling to 100 brought it back
# to 28 ms/tick. Run by minecraft-bots-mobcap.timer: dropped eggs are always cleared; chickens over
# CHICKEN_CAP are thinned at random (only loaded ones are ever counted or touched).
set -euo pipefail

PROPS=/home/zomboid-admin/minecraft-bots/server.properties
CAP="${CHICKEN_CAP:-150}"
MCRCON_PASS="$(grep -m1 '^rcon.password=' "$PROPS" | cut -d= -f2-)"
export MCRCON_PASS MCRCON_HOST=127.0.0.1 MCRCON_PORT=25581

rcon() { mcrcon "$@" | sed 's/\x1b\[[0-9;]*m//g'; }
count() { rcon "execute if entity $1" | grep -oE '[0-9]+$' || echo 0; }

eggs=$(count '@e[type=item,nbt={Item:{id:"minecraft:egg"}}]')
[ "$eggs" -gt 0 ] && rcon 'kill @e[type=item,nbt={Item:{id:"minecraft:egg"}}]' >/dev/null
chickens=$(count '@e[type=chicken]')
culled=0
if [ "$chickens" -gt "$CAP" ]; then
  culled=$((chickens - CAP))
  rcon "kill @e[type=chicken,sort=random,limit=$culled]" >/dev/null
  rcon 'kill @e[type=item,nbt={Item:{id:"minecraft:feather"}}]' 'kill @e[type=item,nbt={Item:{id:"minecraft:chicken"}}]' >/dev/null
fi
echo "mobcap: chickens=$chickens cap=$CAP culled=$culled eggs_cleared=$eggs"
