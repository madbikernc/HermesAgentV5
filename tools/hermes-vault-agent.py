#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-vault-agent.py — persistent Vaultwarden session holder, one per node.

Direct request (2026-09-01), after a real measured cost and a real architecture question: "does a
single persistent Vaultwarden session have the same contention [that motivated always re-locking]?"
Investigated live before building anything: tools/vault-get-secret.sh's full login/unlock/sync/lock
cycle costs ~15s/field under real measured conditions (hermes-wyze.py's own cold re-auth: 5 fields,
~77s total) -- and every caller across this whole fleet pays that same cost, every single call,
because the script starts fresh and locks again every time. That design was originally justified by
a real conflict: `pmoney` on Spark used to run both `hermes-buzz-watch@sintra` and
`hermes-buzz-watch@amy` centrally, and a single cached session can't serve two different Vaultwarden
accounts at once -- switching identities always forces a full re-login regardless of design, so
"never hold a session" was the only safe answer. Confirmed live, directly, before designing this:
sintra and amy are no longer colocated on one node at all (sintra has zero active processes on
Spark; amy has exactly one isolated daily cron job on spark-2) -- the identity-switching conflict
that justified the old design is gone. What's left is "many processes, one identity, one node,"
which a single persistent session actually solves well.

This agent holds ONE already-unlocked `bw` session for this node's own default identity (same
VAULT_NODE / /etc/hermes/vault-node-name resolution vault-get-secret.sh already uses) in memory,
and serves fetches over a local Unix domain socket -- deliberately NOT a network port, not even a
loopback one, unlike every other local service in this fleet (router, buzz, memory, guard): this
process holds live decryption capability for every secret in the vault while it runs, a
meaningfully more sensitive thing to expose than any of those. A Unix socket is filesystem-
permission-gated (0600, owner-only, in a 0700 directory) rather than reachable by anything that can
open a TCP connection to loopback.

This introduces no new privilege boundary versus what already exists: any process running as this
Unix user can already decrypt the same systemd-creds-sealed credentials via sudo and fetch anything
from Vaultwarden directly (that's exactly what vault-get-secret.sh's own slow path still does) --
this agent only makes that existing access faster by keeping one session warm, not broader.

vault-get-secret.sh tries this agent first (a short-timeout fast path) and falls back to its own
complete, unchanged login/unlock/sync/lock cycle if the agent is unreachable, unhealthy, or returns
an error. Every existing caller across this fleet keeps working exactly as before, whether or not
this agent happens to be running -- it is an optional accelerator, never a hard dependency.

Protocol (deliberately trivial, one request per connection): client writes
`<item-name>\t<field>\n`, agent writes back either the raw secret value (no trailing newline) or
`__VAULT_AGENT_ERROR__\t<message>\n` on failure, then closes the connection.

Session refresh: the cached session is synced (`bw sync`, cheap -- no key derivation) every
REFRESH_INTERVAL_SECONDS in the background, and any request that hits an auth error is retried
exactly once after a full fresh unlock -- same "try once more after a real failure" shape
vault-get-secret.sh's own retry loop already uses, just paid once by the agent instead of once per
caller.

Usage: hermes-vault-agent.py (no args — reads VAULT_NODE/vault-node-name the same way
vault-get-secret.sh does)
"""

import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))

SOCK_PATH = Path.home() / ".hermes" / "vault-agent.sock"
REFRESH_INTERVAL_SECONDS = int(os.environ.get("VAULT_AGENT_REFRESH_SECONDS", "600"))
REQUEST_TIMEOUT_SECONDS = 15

ERROR_PREFIX = "__VAULT_AGENT_ERROR__"


def log(msg):
    print(f"[hermes-vault-agent] {msg}", flush=True)


def resolve_node():
    node = os.environ.get("VAULT_NODE", "").strip()
    if node:
        return node
    marker = Path("/etc/hermes/vault-node-name")
    if marker.exists():
        return marker.read_text().strip()
    sys.exit("ERROR: Set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name")


class VaultSession:
    """Owns exactly one live `bw` session for this node's own identity. All access is serialized
    through _lock -- deliberate, not an oversight: the whole reason this agent exists is that the
    expensive part (unlock) only needs to happen once, so there is no benefit to parallelizing
    requests against one session, and serializing keeps a re-auth-on-expiry retry simple and race-
    free without needing vault-get-secret.sh's own flock file at all (nothing outside this single
    process ever touches the session)."""

    def __init__(self, node):
        self.node = node
        self._lock = threading.Lock()
        self._session = None
        self._decrypt_creds()
        self._full_unlock()

    def _decrypt_creds(self):
        apikey_cred = f"/etc/credstore.encrypted/vaultwarden-{self.node}-apikey"
        masterpw_cred = f"/etc/credstore.encrypted/vaultwarden-{self.node}-masterpw"
        env = {}
        for cred_path in (apikey_cred, masterpw_cred):
            out = subprocess.run(
                ["sudo", "systemd-creds", "decrypt", cred_path, "-"],
                capture_output=True, text=True, timeout=30,
            )
            if out.returncode != 0:
                sys.exit(f"ERROR: could not decrypt {cred_path}: {out.stderr.strip()}")
            for line in out.stdout.splitlines():
                if "=" in line:
                    k, _, v = line.partition("=")
                    env[k] = v
        self._env = {**os.environ, **env}
        cert = os.environ.get("VAULT_CA_CERT", "/etc/hermes/vw-lan.crt")
        self._env["NODE_EXTRA_CA_CERTS"] = cert

    def _full_unlock(self):
        """The expensive path -- real key derivation from the master password. Only ever called
        here (at startup) and from _reauth() (on a real auth failure), never per-request."""
        subprocess.run(["bw", "login", "--apikey"], env=self._env,
                        capture_output=True, timeout=60)  # idempotent if already logged in
        unlock = subprocess.run(
            ["bw", "unlock", "--passwordenv", "BW_PASSWORD", "--raw"],
            env=self._env, capture_output=True, text=True, timeout=60,
        )
        if unlock.returncode != 0 or not unlock.stdout.strip():
            sys.exit(f"ERROR: bw unlock failed for node={self.node}: {unlock.stderr.strip()}")
        self._session = unlock.stdout.strip()
        subprocess.run(["bw", "sync", "--session", self._session], env=self._env,
                        capture_output=True, timeout=60)
        log(f"session established for node={self.node}")

    def refresh(self):
        """Cheap -- a real network round trip, but no key derivation. Called periodically in the
        background, never blocks a request."""
        with self._lock:
            if not self._session:
                return
            r = subprocess.run(["bw", "sync", "--session", self._session], env=self._env,
                                capture_output=True, timeout=30)
            if r.returncode != 0:
                log(f"background sync failed (session may have expired, will re-auth on next "
                    f"request if so): {r.stderr.decode(errors='replace').strip()}")

    def fetch(self, item_name, field):
        with self._lock:
            result = self._fetch_once(item_name, field)
            if result is not None:
                return result
            log(f"fetch failed for item={item_name!r} field={field!r}, re-authenticating once")
            self._full_unlock()
            result = self._fetch_once(item_name, field)
            if result is None:
                raise RuntimeError(f"could not fetch '{field}' from '{item_name}' even after re-auth")
            return result

    def _fetch_once(self, item_name, field):
        try:
            if field in ("password", "username", "notes"):
                r = subprocess.run(
                    ["bw", "get", field, item_name, "--session", self._session],
                    env=self._env, capture_output=True, text=True, timeout=REQUEST_TIMEOUT_SECONDS,
                )
                if r.returncode != 0 or not r.stdout.strip():
                    return None
                return r.stdout.strip()
            r = subprocess.run(
                ["bw", "get", "item", item_name, "--session", self._session],
                env=self._env, capture_output=True, text=True, timeout=REQUEST_TIMEOUT_SECONDS,
            )
            if r.returncode != 0 or not r.stdout.strip():
                return None
            item = json.loads(r.stdout)
            for f in item.get("fields") or []:
                if f.get("name") == field:
                    return f.get("value") or ""
            return None
        except subprocess.TimeoutExpired:
            return None
        except (ValueError, json.JSONDecodeError):
            return None


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            line = self.rfile.readline(4096).decode(errors="replace").rstrip("\n")
        except Exception:
            return
        item_name, sep, field = line.partition("\t")
        if not sep or not item_name:
            self.wfile.write(f"{ERROR_PREFIX}\tbad request\n".encode())
            return
        field = field or "password"
        try:
            value = self.server.session.fetch(item_name, field)
            self.wfile.write(value.encode())
        except Exception as exc:
            self.wfile.write(f"{ERROR_PREFIX}\t{exc}\n".encode())


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def refresh_loop(session):
    while True:
        time.sleep(REFRESH_INTERVAL_SECONDS)
        try:
            session.refresh()
        except Exception as exc:
            log(f"refresh loop error, continuing: {exc}")


def main():
    node = resolve_node()
    session = VaultSession(node)

    SOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(SOCK_PATH.parent, 0o700)
    if SOCK_PATH.exists():
        SOCK_PATH.unlink()

    server = Server(str(SOCK_PATH), Handler)
    server.session = session
    os.chmod(SOCK_PATH, 0o600)

    threading.Thread(target=refresh_loop, args=(session,), daemon=True).start()

    log(f"listening on {SOCK_PATH} for node={node}, refresh every {REFRESH_INTERVAL_SECONDS}s")
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            SOCK_PATH.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
