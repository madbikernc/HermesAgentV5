#!/usr/bin/env python3
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — security-review fix: vault_get() now catches
# subprocess.TimeoutExpired instead of crashing on a complete Vaultwarden
# outage.
"""
hermes-synology-ssh.py — Execute a shell command on a Synology NAS over SSH
(Phase 16, IMPLEMENTATION_PLAN.md §7: "DSM API" — SSH command execution,
for management tasks the read-only DSM REST API in
tools/hermes-synology-health.py (Phase 17) can't do: managing services,
direct filesystem checks, kernel logs, etc.).

Ported from v1 (HermesAgent/scripts/synology-ssh.py). The only real change:
v1 read credentials from a plaintext ~/.hermes/config/synology.json; this
project's own constraint (§2b, "Credentials live in Vaultwarden") means
that file must not exist here — credentials are fetched fresh from
Vaultwarden via tools/vault-get-secret.sh on every run instead. Uses the
same scoped `Hermes` DSM user as the Phase 17 health check (no
administrators-group membership on either NAS) — this script's blast
radius is exactly whatever that account's own shell session permits,
which is the real safety boundary here, not anything this script itself
enforces. There is no confirmation gate in this script; whoever/whatever
invokes it is responsible for treating a state-changing command with the
same care as any other state-changing action (IMPLEMENTATION_PLAN.md §5
constraint 5).

Usage: python3 hermes-synology-ssh.py --target NAS1 "df -h"
Requires: paramiko
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

import paramiko

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_SCRIPT = f"{REPO_DIR}/tools/vault-get-secret.sh"
KNOWN_HOSTS_PATH = Path.home() / ".hermes" / "synology_known_hosts"

TARGETS = {
    "NAS1": {"host": "10.129.1.165", "vault_item": "Hermes Nas1"},
    "NAS2": {"host": "10.129.1.167", "vault_item": "Hermes Nas2"},
}


def vault_get(item, field):
    # timeout=60, not 30: vault-get-secret.sh 1.2.0 retries internally up to 3x on a real
    # transient bw/Vaultwarden failure; a 30s timeout could kill it mid-recovery.
    # Security-review fix: a *complete* outage (both this call and the internal
    # retries exhausting the full 60s) previously raised TimeoutExpired uncaught.
    try:
        result = subprocess.run(
            [VAULT_SCRIPT, item, field], capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def run_ssh_command(target_name, command):
    target = TARGETS.get(target_name)
    if not target:
        print(f"Target '{target_name}' not found. Known targets: {', '.join(TARGETS)}", file=sys.stderr)
        sys.exit(1)

    host = target["host"]
    user = vault_get(target["vault_item"], "username")
    password = vault_get(target["vault_item"], "password")
    if not user or not password:
        print(f"ERROR: could not fetch credentials from vault item '{target['vault_item']}'", file=sys.stderr)
        sys.exit(1)

    KNOWN_HOSTS_PATH.parent.mkdir(parents=True, exist_ok=True)

    client = paramiko.SSHClient()
    if KNOWN_HOSTS_PATH.exists():
        client.load_host_keys(str(KNOWN_HOSTS_PATH))
    # Trust-on-first-use: unknown hosts are added and pinned to KNOWN_HOSTS_PATH below,
    # so subsequent connections are verified against the pinned key rather than
    # blindly trusting whatever key the server presents on every run.
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        client.connect(hostname=host, username=user, password=password, timeout=10)
        client.save_host_keys(str(KNOWN_HOSTS_PATH))
        stdin, stdout, stderr = client.exec_command(command)

        exit_status = stdout.channel.recv_exit_status()
        out = stdout.read().decode().strip()
        err = stderr.read().decode().strip()

        if out:
            print(out)
        if err:
            print(f"STDERR: {err}", file=sys.stderr)
        sys.exit(exit_status)

    except SystemExit:
        raise
    except Exception as e:
        print(f"SSH connection failed to {target_name} ({host}): {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Execute a shell command on a Synology NAS over SSH")
    parser.add_argument("--target", required=True, choices=list(TARGETS), help="Target NAS")
    parser.add_argument("command", help="Command to execute")
    args = parser.parse_args()
    run_ssh_command(args.target, args.command)
