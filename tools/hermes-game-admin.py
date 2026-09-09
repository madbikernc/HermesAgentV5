#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-09-09) -- direct request: "expose it via the matrix interface as well" (the
# Firmament bot-sandbox world-reinit task, hermes-minecraft-admin.py 1.1.0's new "bots"
# subcommand group). Two new actions, "bots_list"/"bots_reinit_world" -- deliberately their own
# ACTION_GAMES entries and parse_action() patterns, not folded into the existing "minecraft"
# newworld/status verbs, since that server (minecraft-bots.service) is a completely separate
# instance from the one every other Minecraft action here targets (minecraft.service, the real
# survival server with a real human player). The trigger phrase requires "bot(s)"/"sandbox"
# explicitly so a plain "reset the minecraft world" still correctly falls through to "not
# supported" rather than risk hitting the wrong server. bots_reinit_world gets its own 180s
# subprocess timeout (every other action here is one fast RCON round trip; this one does a real
# backup + world swap + restart-and-wait cycle on the remote box).
#
# hermes-game-admin — Minecraft/Zomboid ADMIN actions from Matrix chat: kick/ban/pardon, whitelist
# add/remove, op/deop (Minecraft) or access-level (Zomboid), restart/stop/start, broadcast,
# force-save, Zomboid sandbox settings, Zomboid world reset. Owns the new Buzz `gameadmin` topic,
# split out from `status` (read-only checks, tools/hermes-status.py) and `logs` (log/abuse review,
# tools/hermes-logs.py) specifically so this file is the ONE place a chat message can actually
# change either game server's live state.
#
# Direct operator request (2026-09-06): this reverses a policy tools/hermes-status.py's own header
# documents — "No side-effecting skill (... Zomboid admin actions ...) is reachable from chat at
# all yet ... adding one later requires an explicit confirm-first flow [...] not silently wiring
# it up." Asked directly whether to build that confirm-first flow before wiring anything in, or
# wire the real actions straight through; the operator's explicit answer was the latter — full
# admin actions, no confirm gate. That answer is recorded here, not assumed.
#
# Minecraft path: subprocesses to tools/hermes-minecraft-admin.py, the exact same shape
# hermes-status.py's own `gameservers` source already uses for hermes-game-server-monitor.py — one
# hardcoded call to an already-vetted script per action, arguments passed as a real argv list
# (never a shell string, never shell=True), never an LLM improvising a command line.
#
# Zomboid path: there is no equivalent standalone tool this file can safely subprocess to.
# tools/hermes-zomboid-admin.sh assumes an ambient `ssh 192.168.1.221` alias under a `muncraft` key
# that doesn't exist for any identity this fleet actually runs as — confirmed live and documented
# in skills/game-server-monitor/SKILL.md's Rules section and in
# tools/hermes-game-server-monitor.py's own header, which explicitly called this "not fixed as
# part of this monitoring build — a separate task." This file closes that exact gap: it reuses
# hermes-game-server-monitor's own connect()/run() (paramiko + the real, working
# "Zomboid Admin - muncraft" vault credential) — the same reuse pattern
# tools/hermes-logs.py's gather_gameabuse()/gather_gameservers() already established via
# `importlib.import_module("hermes-game-server-monitor")` — to run the already-deployed,
# already-tested `/opt/zomboid/hermes-zomboid-admin-local.sh` ON the box as the `zomboid-admin`
# account, rather than re-implementing Project Zomboid's console-FIFO protocol here or depending on
# the muncraft-key script that doesn't work. Every dynamic argument (player name, reason, sandbox
# key=value) is shlex.quote()'d before being spliced into the remote command string —
# client.exec_command() runs that string through a real remote shell, unlike Minecraft's RCON
# transport (a length-prefixed binary protocol with no shell involved at all), so this is the one
# place in this file shell-quoting correctness actually matters.
#
# Parsing is deterministic (regex), never an LLM improvising which command to run or what
# arguments to pass — same "doesn't need to be smart, needs to be right" contract
# hermes-status.py's own parse_source() and hermes-logs.py's own parse_source() already commit to,
# extended here to also extract named arguments (player name, reason, sandbox key=value) since
# these actions need them where status/logs never did. A request this file can't confidently parse
# gets an honest "here's exactly what I understood how to say" reply, never a guess at intent.
#
# Deliberately NOT exposed here: raw `console <command>` passthrough (both underlying admin tools
# support it directly on the CLI). Every other action below is a specific, named, argument-
# validated operation; a raw passthrough would be a fundamentally different and much larger safety
# surface — arbitrary game-console command execution from free text — that no other specialist in
# this fleet exposes either. This is a scope line, not the confirm-gate the operator already said
# to skip.
#
# Config, all from the environment (injected by hermes-game-admin-wrapper.sh):
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN, GUARD_URL/GUARD_TOKEN — same as every specialist
#   POLL_SECONDS     default 5
#   CLAIMANT         default "hermes-game-admin"

import importlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_injection_guard  # noqa: E402

_game_monitor = importlib.import_module("hermes-game-server-monitor")

REPO_DIR = Path(__file__).resolve().parent.parent
PY = "/usr/bin/python3"
MINECRAFT_ADMIN = str(REPO_DIR / "tools" / "hermes-minecraft-admin.py")
ZOMBOID_LOCAL_SCRIPT = "/opt/zomboid/hermes-zomboid-admin-local.sh"

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
GUARD_URL = os.environ.get("GUARD_URL", f"http://{SPARK_IP}:8096").rstrip("/")
GUARD_TOKEN = os.environ.get("GUARD_TOKEN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
CLAIMANT = os.environ.get("CLAIMANT", "hermes-game-admin")

ZOMBOID_LEVELS = ("banned", "user", "priority", "observer", "gm", "moderator", "admin")
NAME = r'"?([A-Za-z0-9_]{1,16})"?'

# name -> which game(s) actually support it — routes the parsed action to the right backend and
# gives an honest "that's not a Zomboid/Minecraft concept" answer instead of silently doing the
# wrong thing or forwarding to a backend that would just fail confusingly.
ACTION_GAMES = {
    "status": ("minecraft", "zomboid"), "players": ("minecraft", "zomboid"),
    "whitelist_list": ("minecraft", "zomboid"), "whitelist_add": ("minecraft", "zomboid"),
    "whitelist_remove": ("minecraft", "zomboid"),
    "kick": ("minecraft", "zomboid"), "ban": ("minecraft", "zomboid"), "pardon": ("minecraft", "zomboid"),
    "say": ("minecraft", "zomboid"), "save": ("minecraft", "zomboid"),
    "start": ("minecraft", "zomboid"), "stop": ("minecraft", "zomboid"), "restart": ("minecraft", "zomboid"),
    "op": ("minecraft",), "deop": ("minecraft",),
    "setaccesslevel": ("zomboid",), "sandboxvars": ("zomboid",), "sandboxvar_set": ("zomboid",),
    "newworld": ("zomboid",), "update": ("zomboid",), "logins": ("zomboid",), "auditlog": ("zomboid",),
    # Direct request, 2026-09-09 ("expose it via the matrix interface as well"): the Firmament
    # bot-sandbox instance (minecraft-bots.service, port 25580) -- a SEPARATE Minecraft server
    # from the one every other "minecraft" action above targets (minecraft.service, port 25565,
    # the real survival server with a real human player). Deliberately its own two actions, not
    # folded into the existing "minecraft" newworld/status verbs -- see parse_action()'s own
    # comment on why the trigger phrase requires "bot(s)"/"sandbox" explicitly, so a plain
    # "reset the minecraft world" still correctly falls through to "not supported" instead of
    # accidentally wiping the wrong server.
    "bots_reinit_world": ("minecraft",), "bots_list": ("minecraft",),
}

USAGE_HINT = (
    "I can run these against Minecraft or Zomboid (say which game): status, players, "
    "\"whitelist list\" / \"whitelist add <name>\" / \"whitelist remove <name>\", "
    "\"kick <name> [for <reason>]\", \"ban <name> [for <reason>]\", \"pardon <name>\", "
    "\"say <message>\", save, start/stop/restart. Minecraft only: \"op <name>\", \"deop <name>\", "
    "\"list the minecraft bots\", \"reinit/reset the bot sandbox world [seed <N>]\". "
    "Zomboid only: \"set access level <name> to <level>\" "
    "(banned/user/priority/observer/gm/moderator/admin), \"sandboxvars\" or \"<Key>=<value>\" to "
    "change one, \"update\", \"logins\", \"audit log\", \"reset the world\" (new random seed)."
)


def log(msg):
    print(f"[hermes-game-admin] {msg}", flush=True)


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _post(url, payload, token=None, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def claim_next(topic):
    try:
        return _post(f"{BUZZ_URL}/claims/next", {"topic": topic, "claimant": CLAIMANT}, BUZZ_TOKEN).get("claim")
    except Exception as exc:
        log(f"claim_next({topic!r}) failed: {exc}")
        return None


def ack_claim(claim_id):
    try:
        _post(f"{BUZZ_URL}/claims/{claim_id}/ack", {"claimant": CLAIMANT}, BUZZ_TOKEN)
    except Exception as exc:
        log(f"ack_claim({claim_id}) failed: {exc}")


def fetch_raw_text(task_id, memory_ref):
    turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=50", MEMORY_TOKEN).get("turns", [])
    if not turns:
        return None
    if memory_ref:
        for t in turns:
            if str(t["id"]) == str(memory_ref) or memory_ref == f"turn:{t['id']}":
                return t["raw"]
    return turns[-1]["raw"]


def set_task_state(task_id, state, topic=None):
    try:
        payload = {"id": task_id, "agent": "gameadmin", "state": state}
        if topic:
            payload["topic"] = topic
        _post(f"{MEMORY_URL}/tasks", payload, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_guard_verdict(layer, severity_value, detail):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": "guard-log", "agent": "guard", "role": "system",
            "raw": json.dumps({"node": "gameadmin", "layer": layer, "severity": severity_value, **detail}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"guard verdict logging failed: {exc}")


def screen(text):
    hits = hermes_injection_guard.scan_messages([{"role": "user", "content": text}])
    severity = hermes_injection_guard.overall_severity(hits)
    if severity == "block":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log(f"Layer 1 BLOCKED gameadmin request: categories={categories}")
        log_guard_verdict("L1", "block", {"categories": categories})
        return False
    if severity == "flag":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log_guard_verdict("L1", "flag", {"categories": categories})

    if GUARD_TOKEN:
        try:
            verdict = _post(f"{GUARD_URL}/classify", {"text": text}, GUARD_TOKEN, timeout=10)
            if verdict.get("hit"):
                log(f"Layer 2 BLOCKED gameadmin request: score={verdict['score']:.3f}")
                log_guard_verdict("L2", "block", {"label": verdict["label"], "score": verdict["score"]})
                return False
        except Exception as exc:
            log(f"Layer 2 unreachable, proceeding on Layer 1 alone: {exc}")
    return True


# ── parsing ────────────────────────────────────────────────────────────────

def _extract_game(lowered):
    is_mc = bool(re.search(r'\bminecraft\b|\bmc server\b', lowered))
    is_pz = bool(re.search(r'\bzomboid\b|\bproject\s+zomboid\b|\bpz\b', lowered))
    if is_mc and is_pz:
        return "ambiguous"
    if is_mc:
        return "minecraft"
    if is_pz:
        return "zomboid"
    return None


def parse_action(text):
    """Deterministic regex parsing of one admin action + its arguments. Returns (action, kwargs)
    or (None, None) when nothing matches confidently -- an honest "I didn't understand" beats
    guessing which action or argument was meant. Checked in priority order: the more specific verb
    patterns (whitelist/kick/ban/op/deop/setaccesslevel/sandbox/newworld) before the generic
    status/players fallback, so e.g. "kick" text is never mistaken for a bare status check."""
    t = text.strip()
    lowered = t.lower()

    if re.search(r'\bwhitelist\b.{0,15}\b(list|show)\b', lowered) or \
       re.search(r'\b(?:who.?s|whos)\b.{0,15}\bwhitelist', lowered):
        return "whitelist_list", {}

    m = re.search(r'\bwhitelist\s+add\s+' + NAME, t, re.I) or \
        re.search(r'\badd\s+' + NAME + r'\s+to\s+(?:the\s+)?whitelist', t, re.I)
    if m:
        return "whitelist_add", {"name": m.group(1)}

    m = re.search(r'\bwhitelist\s+remove\s+' + NAME, t, re.I) or \
        re.search(r'\bremove\s+' + NAME + r'\s+from\s+(?:the\s+)?whitelist', t, re.I) or \
        re.search(r'\b(?:un|de-?)whitelist\s+' + NAME, t, re.I)
    if m:
        return "whitelist_remove", {"name": m.group(1)}

    # kick/ban: try the "<name> for/because/reason <text>" shape first (reason runs to end of
    # message), then fall back to a bare "<name>" match -- two separate patterns rather than one
    # with an optional trailing group anchored on $, since trailing punctuation ("kick Bob.") would
    # otherwise leave the anchor unable to match and silently fail to parse at all.
    m = re.search(r'\bkick\s+' + NAME + r'\s+(?:for|because|reason:?)\s+(.+)$', t, re.I)
    if m:
        return "kick", {"name": m.group(1), "reason": m.group(2).strip().rstrip('.!?')}
    m = re.search(r'\bkick\s+' + NAME + r'\b', t, re.I)
    if m:
        return "kick", {"name": m.group(1), "reason": ""}

    m = re.search(r'\b(?:unban|pardon)\s+' + NAME, t, re.I)
    if m:
        return "pardon", {"name": m.group(1)}

    m = re.search(r'\bban\s+' + NAME + r'\s+(?:for|because|reason:?)\s+(.+)$', t, re.I)
    if m:
        return "ban", {"name": m.group(1), "reason": m.group(2).strip().rstrip('.!?')}
    m = re.search(r'\bban\s+' + NAME + r'\b', t, re.I)
    if m:
        return "ban", {"name": m.group(1), "reason": ""}

    m = re.search(r'\bdeop\s+' + NAME, t, re.I) or \
        re.search(r'\bremove\s+(?:op|operator)(?:\s+status)?\s+from\s+' + NAME, t, re.I) or \
        re.search(r'\btake\s+op\s+(?:away\s+)?from\s+' + NAME, t, re.I)
    if m:
        return "deop", {"name": m.group(1)}

    m = re.search(r'\bop\s+' + NAME + r'\b', t, re.I) or \
        re.search(r'\bmake\s+' + NAME + r'\s+(?:an?\s+)?(?:op|operator)\b', t, re.I)
    if m:
        return "op", {"name": m.group(1)}

    level_alt = "|".join(ZOMBOID_LEVELS)
    m = re.search(r'\bset\s*access\s*level\s+' + NAME + r'\s+(?:to\s+)?(' + level_alt + r')\b', t, re.I) or \
        re.search(r'\bmake\s+' + NAME + r'\s+(?:an?\s+)?(' + level_alt + r')\b', t, re.I)
    if m:
        return "setaccesslevel", {"name": m.group(1), "level": m.group(2).lower()}

    # Bot-sandbox actions, 2026-09-09 -- checked BEFORE the generic Zomboid-only "newworld"
    # pattern just below, and deliberately require "bot(s)"/"sandbox" explicitly in the text so
    # this can never be confused with a request to reset the real, human-facing Minecraft world
    # (which stays correctly unsupported -- see ACTION_GAMES's own comment).
    if re.search(r'\b(?:reset|wipe|regenerate|reinit(?:ialize)?)\b.{0,30}\bbots?\b.{0,20}\bworld\b', lowered) or \
       re.search(r'\b(?:reset|wipe|regenerate|reinit(?:ialize)?)\b.{0,30}\bsandbox\b.{0,20}\bworld\b', lowered) or \
       re.search(r'\bbot\s+sandbox\b.{0,30}\b(?:reset|wipe|regenerate|reinit(?:ialize)?)\b', lowered):
        seed_m = re.search(r'\bseed\s*[:=]?\s*(-?\d+)\b', t, re.I)
        return "bots_reinit_world", {"seed": seed_m.group(1) if seed_m else None}

    if re.search(r'\blist\s+(?:the\s+)?(?:minecraft\s+)?bots?\b', lowered) or \
       re.search(r'\bwhich\s+bots?\s+(?:are\s+)?running\b', lowered) or \
       re.search(r'\bbot\s+status\b', lowered):
        return "bots_list", {}

    if re.search(r'\b(?:reset|wipe|regenerate)\b.{0,20}\b(?:world|map|save)\b', lowered) or \
       re.search(r'\bnew\s+(?:zomboid\s+)?world\b', lowered) or \
       re.search(r'\bnew\s+(?:random\s+)?seed\b', lowered):
        return "newworld", {}

    kv_pairs = re.findall(r'\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"\n]{0,64}"|true|false|-?\d+(?:\.\d+)?)\b', t)
    if kv_pairs:
        return "sandboxvar_set", {"pairs": kv_pairs}

    if re.search(r'\bsandbox\s*vars?\b', lowered) or re.search(r'\bsandbox\s+settings?\b', lowered):
        return "sandboxvars", {}

    if re.search(r'\bupdate\b|\bupgrade\b', lowered):
        return "update", {}

    if re.search(r'\baudit\s*log\b|\bban\s+history\b|\bkick\s+history\b|\bmoderation\s+log\b', lowered):
        return "auditlog", {}

    if re.search(r'\blogins?\b|\blogin\s+history\b|\baccounts\b|\bwho\s+has\s+logged\s+in\b', lowered):
        return "logins", {}

    m = re.search(r'\b(?:say|broadcast|announce)\s+(.+)$', t, re.I) or \
        re.search(r'\btell\s+(?:everyone|all\s+players?)\s+(.+)$', t, re.I)
    if m:
        return "say", {"message": m.group(1).strip()}

    if re.search(r'\bsave\b.{0,15}\b(?:world|now)\b', lowered) or \
       re.search(r'\bforce\s*save\b', lowered) or re.fullmatch(r'save', lowered.strip()):
        return "save", {}

    m = re.search(r'\b(start|stop|restart)\b', lowered)
    if m:
        return m.group(1), {}

    if re.search(r'\bplayers?\b|\bwho.?s\s+(?:on|online|connected)\b|\bonline\b', lowered):
        return "players", {}

    if re.search(r'\bstatus\b|\bhealth\b|\bis\s+(?:it\s+|.*server\s+)?up\b|\brunning\b', lowered):
        return "status", {}

    return None, None


# ── Minecraft backend (subprocess to the already-vetted CLI tool) ─────────────

def run_minecraft(action, kwargs):
    args = [PY, MINECRAFT_ADMIN]
    if action == "whitelist_list":
        args += ["whitelist", "list"]
    elif action == "whitelist_add":
        args += ["whitelist", "add", kwargs["name"]]
    elif action == "whitelist_remove":
        args += ["whitelist", "remove", kwargs["name"]]
    elif action == "kick":
        args += ["kick", kwargs["name"]] + ([kwargs["reason"]] if kwargs.get("reason") else [])
    elif action == "ban":
        args += ["ban", kwargs["name"]] + ([kwargs["reason"]] if kwargs.get("reason") else [])
    elif action == "pardon":
        args += ["pardon", kwargs["name"]]
    elif action == "op":
        args += ["op", kwargs["name"]]
    elif action == "deop":
        args += ["deop", kwargs["name"]]
    elif action == "say":
        args += ["say", kwargs["message"]]
    elif action in ("save", "start", "stop", "restart", "status", "players"):
        args += [action]
    elif action == "bots_list":
        args += ["bots", "list"]
    elif action == "bots_reinit_world":
        args += ["bots", "reinit-world"] + ([kwargs["seed"]] if kwargs.get("seed") else [])
    else:
        return None, f"'{action}' isn't a Minecraft concept — that's Zomboid-specific"

    # bots_reinit_world does a real backup + world swap + a restart-and-wait cycle on the remote
    # box (hermes-minecraft-admin.py's own SANDBOX_RESTART_TIMEOUT_S=60, plus backup time) --
    # every other action here is a single fast RCON round trip, so only this one needs real
    # headroom over the normal 30s budget.
    timeout = 180 if action == "bots_reinit_world" else 30
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"Minecraft admin command timed out after {timeout}s"
    except Exception as exc:
        return None, f"Minecraft admin command failed to start: {exc}"
    output = result.stdout.strip()
    if result.returncode != 0 and not output:
        return None, result.stderr.strip() or f"exit {result.returncode}"
    return output or "(empty output)", None


# ── Zomboid backend (reuses hermes-game-server-monitor's connect()/run() -- see module docstring
#    above for why this doesn't subprocess to hermes-zomboid-admin.sh) ─────────────────

def run_zomboid(action, kwargs):
    if action == "whitelist_list":
        # The local admin script has no separate "list" -- `logins` already reports every
        # whitelisted account (username/role/steamid/last-connection), so it doubles as the
        # whitelist listing here.
        remote_args = ["logins"]
    elif action == "whitelist_add":
        remote_args = ["adduser", kwargs["name"]]
    elif action == "whitelist_remove":
        remote_args = ["removeuser", kwargs["name"]]
    elif action == "kick":
        remote_args = ["kick", kwargs["name"]] + ([kwargs["reason"]] if kwargs.get("reason") else [])
    elif action == "ban":
        remote_args = ["banuser", kwargs["name"]] + ([kwargs["reason"]] if kwargs.get("reason") else [])
    elif action == "pardon":
        remote_args = ["unbanuser", kwargs["name"]]
    elif action == "setaccesslevel":
        remote_args = ["setaccesslevel", kwargs["name"], kwargs["level"]]
    elif action == "say":
        remote_args = ["broadcast", kwargs["message"]]
    elif action == "sandboxvars":
        remote_args = ["sandboxvars"]
    elif action == "sandboxvar_set":
        remote_args = ["sandboxvar"] + [f"{k}={v}" for k, v in kwargs["pairs"]]
    elif action == "newworld":
        remote_args = ["newworld", "--confirm"]
    elif action == "update":
        remote_args = ["update"]
    elif action == "logins":
        remote_args = ["logins"]
    elif action == "auditlog":
        remote_args = ["auditlog"]
    elif action in ("save", "start", "stop", "restart", "status", "players"):
        remote_args = [action]
    else:
        return None, f"'{action}' isn't a Zomboid concept — that's Minecraft-specific"

    # shlex.quote() every dynamic piece -- this string is handed to a real remote shell via
    # exec_command(), unlike Minecraft's binary RCON transport. See module docstring.
    remote_cmd = ZOMBOID_LOCAL_SCRIPT + " " + " ".join(shlex.quote(a) for a in remote_args)
    try:
        client = _game_monitor.connect()
    except Exception as exc:
        return None, f"could not connect to the muncraft box: {exc}"
    try:
        out, err = _game_monitor.run(client, remote_cmd, timeout=30)
    finally:
        client.close()
    if err and not out:
        return None, err
    return out or "(empty output)", None


def run_action(game, action, kwargs):
    applicable = ACTION_GAMES.get(action, ())
    if game not in applicable:
        other = [g for g in ("minecraft", "zomboid") if g != game and g in applicable]
        if other:
            return None, f"'{action}' isn't a {game} concept — did you mean the {other[0]} server?"
        return None, f"'{action}' isn't supported for either server"
    return run_minecraft(action, kwargs) if game == "minecraft" else run_zomboid(action, kwargs)


def publish_result(task_id, memory_ref, ok, message):
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "gameadmin", "role": "assistant",
        "raw": message, "presented": message,
    }, MEMORY_TOKEN)
    set_task_state(task_id, "done" if ok else "error")
    _post(f"{BUZZ_URL}/messages", {
        "from": "gameadmin", "topic": "results", "task_id": task_id,
        "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)


def process_one():
    claim = claim_next("gameadmin")
    if not claim:
        return False

    claim_id = claim["id"]
    msg = claim["message"]
    task_id, memory_ref = msg.get("task_id"), msg.get("memory_ref")

    if not task_id:
        log(f"claim {claim_id}: message has no task_id — acking and dropping")
        ack_claim(claim_id)
        return True

    request_text = fetch_raw_text(task_id, memory_ref)
    if not request_text:
        log(f"claim {claim_id}: task {task_id!r} has no raw text — acking and dropping")
        ack_claim(claim_id)
        set_task_state(task_id, "error-no-content")
        return True

    if not screen(request_text):
        set_task_state(task_id, "blocked")
        ack_claim(claim_id)
        publish_result(task_id, memory_ref, False,
                        "This request was rejected by the fleet's screening layer.")
        return True

    game = _extract_game(request_text.lower())
    action, kwargs = parse_action(request_text)
    ack_claim(claim_id)  # ack once screened and understood -- the Zomboid SSH round trip and
                          # Minecraft's own RCON-over-SSH call can each take a few real seconds
    set_task_state(task_id, "running", topic="gameadmin")
    log(f"claim {claim_id}: task {task_id!r} -> game={game!r} action={action!r}")

    if game is None:
        publish_result(task_id, memory_ref, False,
                        "Which server — Minecraft or Zomboid? " + USAGE_HINT)
        return True
    if game == "ambiguous":
        publish_result(task_id, memory_ref, False,
                        "That mentioned both Minecraft and Zomboid — which one did you mean?")
        return True
    if action is None:
        publish_result(task_id, memory_ref, False,
                        f"I didn't understand what to do on {game}. {USAGE_HINT}")
        return True

    result, err = run_action(game, action, kwargs)
    if err:
        log(f"task {task_id!r}: {game}/{action} failed: {err}")
        publish_result(task_id, memory_ref, False, f"Could not complete that on {game}: {err}")
        return True

    publish_result(task_id, memory_ref, True, result)
    log(f"task {task_id!r}: {game}/{action} result published ({len(result)} chars)")
    return True


def main():
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")
    if not GUARD_TOKEN:
        log("WARNING: GUARD_TOKEN not set — this agent's own Layer 2 screening is skipped")
    log(f"watching Buzz topic 'gameadmin', polling every {POLL_SECONDS}s")
    while True:
        try:
            did_work = process_one()
        except Exception as exc:
            log(f"unhandled error this cycle, continuing: {exc}")
            did_work = False
        if not did_work:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
