#!/usr/bin/env bash
# Version: 1.0.0
#
# Fill a double chest with common food items in stacks of 64.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/chest-common.sh"

CHEST_ITEMS=(
  "minecraft:apple 64"
  "minecraft:bread 64"
  "minecraft:carrot 64"
  "minecraft:golden_carrot 64"
  "minecraft:potato 64"
  "minecraft:baked_potato 64"
  "minecraft:beetroot 64"
  "minecraft:melon_slice 64"
  "minecraft:sweet_berries 64"
  "minecraft:glow_berries 64"
  "minecraft:cookie 64"
  "minecraft:pumpkin_pie 64"
  "minecraft:dried_kelp 64"
  "minecraft:chorus_fruit 64"
  "minecraft:beef 64"
  "minecraft:cooked_beef 64"
  "minecraft:porkchop 64"
  "minecraft:cooked_porkchop 64"
  "minecraft:chicken 64"
  "minecraft:cooked_chicken 64"
  "minecraft:mutton 64"
  "minecraft:cooked_mutton 64"
  "minecraft:rabbit 64"
  "minecraft:cooked_rabbit 64"
  "minecraft:cod 64"
  "minecraft:cooked_cod 64"
  "minecraft:cooked_salmon 64"
)

fill_double_chest "$@"

# Revision History
# 1.0.0 | 2026-09-18 | Initial double-chest loadout of common food in 64-item stacks.
