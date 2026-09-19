#!/usr/bin/env bash
# Version: 1.0.0
#
# Equip every online player with enchanted Netherite gear and useful tools.

set -euo pipefail

if [[ -z "${MCRCON_PASS:-}" ]]; then
  echo "MCRCON_PASS must be set in the environment." >&2
  exit 2
fi

rcon_bin="${MCRCON_BIN:-mcrcon}"
if ! command -v "$rcon_bin" >/dev/null 2>&1; then
  echo "RCON client not found: $rcon_bin" >&2
  exit 127
fi

export MCRCON_HOST="${MCRCON_HOST:-127.0.0.1}"
export MCRCON_PORT="${MCRCON_PORT:-25581}"

commands=(
  'item replace entity @a armor.head with minecraft:netherite_helmet[enchantments={protection:4,unbreaking:3,mending:1,respiration:3,aqua_affinity:1}]'
  'item replace entity @a armor.chest with minecraft:netherite_chestplate[enchantments={protection:4,unbreaking:3,mending:1}]'
  'item replace entity @a armor.legs with minecraft:netherite_leggings[enchantments={protection:4,unbreaking:3,mending:1,swift_sneak:3}]'
  'item replace entity @a armor.feet with minecraft:netherite_boots[enchantments={protection:4,unbreaking:3,mending:1,feather_falling:4,depth_strider:3}]'
  'item replace entity @a weapon.mainhand with minecraft:netherite_sword[enchantments={sharpness:5,unbreaking:3,mending:1,looting:3,sweeping_edge:3}]'
  'give @a minecraft:netherite_axe[enchantments={efficiency:5,sharpness:5,unbreaking:3,mending:1}] 1'
  'give @a minecraft:netherite_pickaxe[enchantments={efficiency:5,fortune:3,unbreaking:3,mending:1}] 1'
  'give @a minecraft:netherite_hoe[enchantments={efficiency:5,fortune:3,unbreaking:3,mending:1}] 1'
  'give @a minecraft:netherite_shovel[enchantments={efficiency:5,fortune:3,unbreaking:3,mending:1}] 1'
  'give @a minecraft:shears[enchantments={efficiency:5,unbreaking:3,mending:1}] 1'
  'give @a minecraft:bow[enchantments={power:5,punch:2,flame:1,infinity:1,unbreaking:3}] 1'
  'give @a minecraft:arrow 1'
)

"$rcon_bin" "${commands[@]}"

# Revision History
# 1.0.0 | 2026-09-19 | Initial all-player enchanted equipment loadout.
