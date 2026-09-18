#!/usr/bin/env bash
# Version: 1.0.0
#
# Fill a double chest with mining, farming, and utility tools.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/chest-common.sh"

CHEST_ITEMS=(
  "minecraft:wooden_pickaxe"
  "minecraft:wooden_axe"
  "minecraft:wooden_shovel"
  "minecraft:wooden_hoe"
  "minecraft:stone_pickaxe"
  "minecraft:stone_axe"
  "minecraft:stone_shovel"
  "minecraft:stone_hoe"
  "minecraft:iron_pickaxe"
  "minecraft:iron_axe"
  "minecraft:iron_shovel"
  "minecraft:iron_hoe"
  "minecraft:diamond_pickaxe"
  "minecraft:diamond_axe"
  "minecraft:diamond_shovel"
  "minecraft:diamond_hoe"
  "minecraft:netherite_pickaxe"
  "minecraft:netherite_axe"
  "minecraft:netherite_shovel"
  "minecraft:netherite_hoe"
  "minecraft:shears"
  "minecraft:fishing_rod"
  "minecraft:flint_and_steel"
  "minecraft:brush"
  "minecraft:compass"
  "minecraft:clock"
  "minecraft:spyglass"
)

fill_double_chest "$@"

# Revision History
# 1.0.0 | 2026-09-18 | Initial double-chest loadout of mining, farming, and utility tools.
