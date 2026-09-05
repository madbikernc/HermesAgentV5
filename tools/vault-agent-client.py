#!/usr/bin/env python3
# Version: 1.1.0
#
# 1.1.0 (2026-09-05) — real bug found live: TIMEOUT_SECONDS (10) was shorter than
# hermes-vault-agent.py's own worst-case recovery time. When the agent's cached session had gone
# bad, its fetch() does a full re-auth (bw login + bw unlock [real master-password key derivation]
# + bw sync) before replying -- measured elsewhere in this project at ~15s for that same sequence,
# with real variance under network load. When this client gave up first, vault-get-secret.sh's
# fast-path check saw a failure and fell through to its own complete slow-path cycle -- a second,
# independent login/unlock/sync/get racing against the agent's own in-flight recovery on the same
# shared local `bw` CLI state, ending (unconditionally, win or lose) in `bw lock`. That lock
# invalidated whatever session the agent had just finished -- or was about to finish -- establishing,
# so the very next fetch found the session dead again and needed another full re-auth. Confirmed
# live: hermes-vault-agent's own log showed "fetch failed ... re-authenticating once" for
# matrix-fleetops on essentially every single poll cycle (hermes-buzz-lockup-check.sh /
# hermes-dispatch-standby-check.sh, ~every 5 minutes), including cases where a session that had
# been freshly re-established just ~25s earlier (a different field, same script run) had already
# gone bad again -- only explainable by something else locking it out from under the agent in
# between, not ordinary session-age expiry. Raised to 30s, comfortably above the ~15s real-world
# figure, so this client actually waits for the agent's own recovery instead of triggering a
# redundant, session-clobbering fallback on ordinary re-auth latency.
"""
vault-agent-client.py — thin client for hermes-vault-agent.py's Unix socket, used only by
tools/vault-get-secret.sh's fast path.

Arguments passed on argv, never interpolated into a shell/Python string -- avoids the injection
risk of building a `python3 -c "..."` source string out of an item name or field, either of which
could contain characters (quotes, backticks) that would otherwise need careful escaping.

Prints the secret to stdout with no trailing newline on success (exit 0). Prints nothing and exits
non-zero on any failure (agent not running, timeout, bad response, item/field not found) -- the
caller (vault-get-secret.sh) falls back to its own full cycle on any non-zero exit, so this script
fails silently, not loudly, by design.

Usage: vault-agent-client.py <socket-path> <item-name> <field>
"""
import socket
import sys

ERROR_PREFIX = "__VAULT_AGENT_ERROR__"
TIMEOUT_SECONDS = 30


def main():
    if len(sys.argv) != 4:
        sys.exit(1)
    sock_path, item_name, field = sys.argv[1], sys.argv[2], sys.argv[3]

    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(TIMEOUT_SECONDS)
    try:
        s.connect(sock_path)
        s.sendall(f"{item_name}\t{field}\n".encode())
        s.shutdown(socket.SHUT_WR)
        chunks = []
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
        response = b"".join(chunks).decode(errors="replace")
    except Exception:
        sys.exit(1)
    finally:
        s.close()

    if not response or response.startswith(ERROR_PREFIX):
        sys.exit(1)
    sys.stdout.write(response)
    sys.exit(0)


if __name__ == "__main__":
    main()
