#!/usr/bin/env python3
# Version: 1.0.0
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
TIMEOUT_SECONDS = 10


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
