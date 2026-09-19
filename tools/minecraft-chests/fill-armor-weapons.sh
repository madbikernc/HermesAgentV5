#!/usr/bin/env bash
# Version: 1.1.0
#
# Fill a double chest with armor, shields, bows, and melee weapons.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/chest-common.sh"

CHEST_ITEMS=(
  "minecraft:iron_helmet[enchantments={protection:4,unbreaking:3,mending:1,respiration:3,aqua_affinity:1}]"
  "minecraft:iron_chestplate[enchantments={protection:4,unbreaking:3,mending:1}]"
  "minecraft:iron_leggings[enchantments={protection:4,unbreaking:3,mending:1,swift_sneak:3}]"
  "minecraft:iron_boots[enchantments={protection:4,unbreaking:3,mending:1,feather_falling:4,depth_strider:3}]"
  "minecraft:diamond_helmet[enchantments={protection:4,unbreaking:3,mending:1,respiration:3,aqua_affinity:1}]"
  "minecraft:diamond_chestplate[enchantments={protection:4,unbreaking:3,mending:1}]"
  "minecraft:diamond_leggings[enchantments={protection:4,unbreaking:3,mending:1,swift_sneak:3}]"
  "minecraft:diamond_boots[enchantments={protection:4,unbreaking:3,mending:1,feather_falling:4,depth_strider:3}]"
  "minecraft:netherite_helmet[enchantments={protection:4,unbreaking:3,mending:1,respiration:3,aqua_affinity:1}]"
  "minecraft:netherite_chestplate[enchantments={protection:4,unbreaking:3,mending:1}]"
  "minecraft:netherite_leggings[enchantments={protection:4,unbreaking:3,mending:1,swift_sneak:3}]"
  "minecraft:netherite_boots[enchantments={protection:4,unbreaking:3,mending:1,feather_falling:4,depth_strider:3}]"
  "minecraft:iron_sword[enchantments={sharpness:5,unbreaking:3,mending:1,looting:3,sweeping_edge:3}]"
  "minecraft:diamond_sword[enchantments={sharpness:5,unbreaking:3,mending:1,looting:3,sweeping_edge:3}]"
  "minecraft:netherite_sword[enchantments={sharpness:5,unbreaking:3,mending:1,looting:3,sweeping_edge:3}]"
  "minecraft:bow[enchantments={power:5,punch:2,flame:1,infinity:1,unbreaking:3}]"
  "minecraft:crossbow[enchantments={unbreaking:3,mending:1}]"
  "minecraft:trident[enchantments={unbreaking:3,mending:1}]"
  "minecraft:mace[enchantments={unbreaking:3,mending:1}]"
  "minecraft:shield[enchantments={unbreaking:3,mending:1}]"
  "minecraft:shield[enchantments={unbreaking:3,mending:1}]"
  "minecraft:arrow 64"
  "minecraft:arrow 64"
  "minecraft:spectral_arrow 64"
  "minecraft:leather_helmet[enchantments={protection:4,unbreaking:3,mending:1,respiration:3,aqua_affinity:1}]"
  "minecraft:leather_chestplate[enchantments={protection:4,unbreaking:3,mending:1}]"
  "minecraft:leather_leggings[enchantments={protection:4,unbreaking:3,mending:1,swift_sneak:3}]"
)

fill_double_chest "$@"

# Revision History
# 1.0.0 | 2026-09-18 | Initial double-chest loadout of armor and weapons.
# 1.1.0 | 2026-09-19 | Add matching enchantments to armor, weapons, and shields.
