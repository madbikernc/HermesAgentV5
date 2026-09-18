#!/usr/bin/env bash
# Version: 1.1.0
#
# Shared RCON support for the Minecraft double-chest fill scripts.

set -euo pipefail

fill_double_chest() {
  if (( $# != 6 )); then
    echo "Usage: $(basename "$0") HALF_1_X HALF_1_Y HALF_1_Z HALF_2_X HALF_2_Y HALF_2_Z" >&2
    return 2
  fi

  if [[ -z "${MCRCON_PASS:-}" ]]; then
    echo "MCRCON_PASS must be set in the environment." >&2
    return 2
  fi

  if (( ${#CHEST_ITEMS[@]} != 27 )); then
    echo "CHEST_ITEMS must contain exactly 27 entries; found ${#CHEST_ITEMS[@]}." >&2
    return 2
  fi

  local coordinate
  for coordinate in "$@"; do
    if [[ ! "$coordinate" =~ ^-?[0-9]+$ ]]; then
      echo "Chest coordinates must be integers; received: $coordinate" >&2
      return 2
    fi
  done

  local dimension="${MC_DIMENSION:-minecraft:overworld}"
  if [[ ! "$dimension" =~ ^[a-z0-9_.-]+:[a-z0-9_./-]+$ ]]; then
    echo "MC_DIMENSION is not a valid resource location: $dimension" >&2
    return 2
  fi

  local rcon_bin="${MCRCON_BIN:-mcrcon}"
  if ! command -v "$rcon_bin" >/dev/null 2>&1; then
    echo "RCON client not found: $rcon_bin" >&2
    return 127
  fi

  export MCRCON_HOST="${MCRCON_HOST:-127.0.0.1}"
  # 25581, not the vanilla-default 25575 -- this host also runs an unrelated
  # Minecraft instance on 25565/RCON 25575; the real bot-facing world's RCON
  # is 25581. Getting this wrong silently talks to the wrong server.
  export MCRCON_PORT="${MCRCON_PORT:-25581}"

  local half_1_x="$1"
  local half_1_y="$2"
  local half_1_z="$3"
  local half_2_x="$4"
  local half_2_y="$5"
  local half_2_z="$6"
  local -a commands=()
  local slot

  for slot in "${!CHEST_ITEMS[@]}"; do
    commands+=("execute in $dimension run item replace block $half_1_x $half_1_y $half_1_z container.$slot with ${CHEST_ITEMS[$slot]}")
    commands+=("execute in $dimension run item replace block $half_2_x $half_2_y $half_2_z container.$slot with ${CHEST_ITEMS[$slot]}")
  done

  "$rcon_bin" "${commands[@]}"
}

# Revision History
# 1.0.0 | 2026-09-18 | Initial shared validation and RCON implementation for filling both halves of a double chest.
# 1.1.0 | 2026-09-18 | MCRCON_PORT default corrected 25575 -> 25581 -- the vanilla-default port belongs to an unrelated Minecraft instance on the same host; the real bot world's RCON is 25581.
