#!/usr/bin/env python3
# Version: 1.0.0
#
# RCON for the live behavior tests: runs each argument as one RCON command against the Firmament
# bot-sandbox server (minecraft-bots.service on muncraft, rcon.port 25581). RCON is only
# reachable on that box, so this reuses tools/hermes-minecraft-admin.py's SSH connection (vault
# credentials, no secrets here) and runs the box's own `mcrcon` there, reading rcon.password out of
# the sandbox's server.properties on the box itself. Each command is shell-quoted; callers are the
# test suite's own constant command strings, never player input.
#
# Usage: python3 rcon.py "say hi" "time query daytime"   (prints one output line per command)
#
# Revision History: 1.0.0 | 2026-09-24 | Initial version for tests/live.test.mjs.
import importlib.util
import shlex
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parents[4]
SANDBOX_DIR = "/home/zomboid-admin/minecraft-bots"
RCON_PORT = 25581


def load_admin():
    spec = importlib.util.spec_from_file_location("hermes_minecraft_admin", REPO_DIR / "tools" / "hermes-minecraft-admin.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(commands):
    if not commands:
        sys.exit("usage: rcon.py <command> [<command> ...]")
    admin = load_admin()
    client = admin.connect()
    try:
        quoted = " ".join(shlex.quote(c) for c in commands)
        script = (f"cd {SANDBOX_DIR} && "
                  f"MCRCON_PASS=\"$(grep '^rcon.password=' server.properties | cut -d= -f2-)\" "
                  f"mcrcon -H 127.0.0.1 -P {RCON_PORT} {quoted}")
        out, err = admin.run(client, script, timeout=60)
        sys.stdout.write(out)
        if err.strip():
            sys.stderr.write(err)
    finally:
        client.close()


if __name__ == "__main__":
    main(sys.argv[1:])
