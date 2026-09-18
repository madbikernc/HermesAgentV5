#!/usr/bin/env bash
# Version: 1.0.0
#
# Fill a double chest with armor, shields, bows, and melee weapons.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/chest-common.sh"

CHEST_ITEMS=(
  "minecraft:iron_helmet"
  "minecraft:iron_chestplate"
  "minecraft:iron_leggings"
  "minecraft:iron_boots"
  "minecraft:diamond_helmet"
  "minecraft:diamond_chestplate"
  "minecraft:diamond_leggings"
  "minecraft:diamond_boots"
  "minecraft:netherite_helmet"
  "minecraft:netherite_chestplate"
  "minecraft:netherite_leggings"
  "minecraft:netherite_boots"
  "minecraft:iron_sword"
  "minecraft:diamond_sword"
  "minecraft:netherite_sword"
  "minecraft:bow"
  "minecraft:crossbow"
  "minecraft:trident"
  "minecraft:mace"
  "minecraft:shield"
  "minecraft:shield"
  "minecraft:arrow 64"
  "minecraft:arrow 64"
  "minecraft:spectral_arrow 64"
  "minecraft:leather_helmet"
  "minecraft:leather_chestplate"
  "minecraft:leather_leggings"
)

fill_double_chest "$@"

# Revision History
# 1.0.0 | 2026-09-18 | Initial double-chest loadout of armor and weapons.
