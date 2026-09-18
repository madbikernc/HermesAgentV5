#!/usr/bin/env bash
# Version: 1.0.0
#
# Fill a double chest with common raw materials in stacks of 64.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/chest-common.sh"

CHEST_ITEMS=(
  "minecraft:cobblestone 64"
  "minecraft:stone 64"
  "minecraft:cobbled_deepslate 64"
  "minecraft:dirt 64"
  "minecraft:gravel 64"
  "minecraft:sand 64"
  "minecraft:clay_ball 64"
  "minecraft:coal 64"
  "minecraft:charcoal 64"
  "minecraft:raw_iron 64"
  "minecraft:raw_copper 64"
  "minecraft:raw_gold 64"
  "minecraft:iron_ingot 64"
  "minecraft:copper_ingot 64"
  "minecraft:gold_ingot 64"
  "minecraft:redstone 64"
  "minecraft:lapis_lazuli 64"
  "minecraft:diamond 64"
  "minecraft:emerald 64"
  "minecraft:quartz 64"
  "minecraft:oak_log 64"
  "minecraft:spruce_log 64"
  "minecraft:birch_log 64"
  "minecraft:stick 64"
  "minecraft:string 64"
  "minecraft:leather 64"
  "minecraft:gunpowder 64"
)

fill_double_chest "$@"

# Revision History
# 1.0.0 | 2026-09-18 | Initial double-chest loadout of common raw materials in 64-item stacks.
