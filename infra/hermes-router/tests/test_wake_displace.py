#!/usr/bin/env python3
# Version: 1.0.0
#
# Offline checks for hermes-model-wake-worker.py 1.7.0's displacement (make room for an on-demand
# role by stopping an idle resident one) and hermes-model-idle-sleep.sh 1.1.0's restore. No
# systemctl, no network: subprocess.run, available_gib(), is_healthy() and is_busy() are replaced
# with a fake node whose memory frees when a unit stops.
#
# What it covers:
#   * log-analyst short on memory and super idle -> super is stopped, log-analyst started, and
#     super is recorded in log-analyst.displaced (super is in RESTORE_AFTER_DISPLACE)
#   * super with a request in flight is never stopped -> the wake is refused, nothing stopped
#   * super woken seconds ago is never stopped (its request may not show in /slots yet)
#   * log-analyst failing to come up after displacing super -> super is started again
#   * super displacing log-analyst records nothing (an on-demand role isn't restored), and super
#     coming back clears log-analyst's own owed restart of it
#   * idle-sleep, once log-analyst idles out, restarts what it displaced and removes the record
#
# Run: python3 infra/hermes-router/tests/test_wake_displace.py
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REAL_RUN = subprocess.run  # the fakes below replace subprocess.run module-wide
REPO = Path(__file__).resolve().parents[3]
TOOLS = REPO / "tools"

FAILURES = []
CHECKS = [0]


def check(label, cond, detail=""):
    CHECKS[0] += 1
    if not cond:
        FAILURES.append(f"{label} {detail}".strip())
        print(f"FAIL: {label} {detail}")
    else:
        print(f"PASS: {label}")


STATE = Path(tempfile.mkdtemp(prefix="wake-displace-"))
os.environ["HERMES_NODE"] = "spark"
os.environ["WAKE_STATE_DIR"] = str(STATE)
os.environ["DISPLACE_SETTLE_S"] = "1"
os.environ["WAKE_TIMEOUT_S"] = "1"

spec = importlib.util.spec_from_file_location("wake", TOOLS / "hermes-model-wake-worker.py")
wake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wake)
wake.time.sleep = lambda s: None


class FakeNode:
    """Units and their memory: stopping one frees its GiB, starting one takes it."""

    SIZES = {"llama-super": 24, "llama-log-analyst": 24}

    def __init__(self, free, active, busy=(), comes_up=True):
        self.free = free
        self.active = set(active)
        self.busy = set(busy)
        self.comes_up = comes_up
        self.calls = []

    def run(self, cmd, **kw):
        self.calls.append(cmd)
        verb, unit = cmd[-2], cmd[-1]
        if cmd[:2] == ["systemctl", "is-active"]:
            return subprocess.CompletedProcess(cmd, 0 if unit in self.active else 3)
        if verb == "stop" and unit in self.active:
            self.active.discard(unit)
            self.free += self.SIZES[unit]
        elif verb == "start" and unit not in self.active:
            self.active.add(unit)
            self.free -= self.SIZES[unit]
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def healthy(self, url):
        unit = {"8095": "llama-super", "8098": "llama-log-analyst"}[url.split(":")[2][:4]]
        if unit == "llama-log-analyst" and not self.comes_up:
            return False
        return unit in self.active

    def is_busy(self, url):
        return {"8095": "super", "8098": "log-analyst"}[url.split(":")[2][:4]] in self.busy

    def install(self):
        wake.subprocess.run = self.run
        wake.available_gib = lambda: self.free
        wake.is_healthy = self.healthy
        wake.is_busy = self.is_busy

    def stopped(self, unit):
        return any(c[-2:] == ["stop", unit] for c in self.calls)


def reset_state():
    shutil.rmtree(STATE, ignore_errors=True)
    STATE.mkdir()


def job(role):
    return {"id": "j1", "payload": {"role": role}}


# 1. log-analyst displaces an idle super.
reset_state()
node = FakeNode(free=21, active={"llama-super"})
node.install()
code, err = wake.run_job(job("log-analyst"))
check("log-analyst wakes after displacing an idle super", code == 0, err)
check("  super was stopped", node.stopped("llama-super"))
check("  super is recorded for restore",
      (STATE / "log-analyst.displaced").read_text().split() == ["llama-super"])

# 2. Busy super is never displaced.
reset_state()
node = FakeNode(free=21, active={"llama-super"}, busy={"super"})
node.install()
code, err = wake.run_job(job("log-analyst"))
check("a super with a request in flight is not displaced", code == 1 and not node.stopped("llama-super"), err)
check("  refusal names the displacement attempt", "displace" in err, err)

# 3. Recently woken super is never displaced.
reset_state()
(STATE / "super.last_used").write_text(str(time.time()))
node = FakeNode(free=21, active={"llama-super"})
node.install()
code, err = wake.run_job(job("log-analyst"))
check("a super woken seconds ago is not displaced", code == 1 and not node.stopped("llama-super"), err)

# 4. log-analyst never comes up -> super restored.
reset_state()
node = FakeNode(free=21, active={"llama-super"}, comes_up=False)
node.install()
code, err = wake.run_job(job("log-analyst"))
check("a log-analyst that never comes up fails the wake", code == 1, err)
check("  and super is started again", "llama-super" in node.active, str(node.calls))
check("  and no restore is left owing", not (STATE / "log-analyst.displaced").exists())

# 5. super displaces an idle log-analyst; nothing recorded; owed restart cleared.
reset_state()
(STATE / "log-analyst.displaced").write_text("llama-super\n")
node = FakeNode(free=21, active={"llama-log-analyst"})
node.install()
code, err = wake.run_job(job("super"))
check("super wakes after displacing an idle log-analyst", code == 0, err)
check("  an on-demand role is not recorded for restore", not (STATE / "super.displaced").exists())
check("  super running again clears log-analyst's owed restart",
      not (STATE / "log-analyst.displaced").exists())

# 6. idle-sleep restores what log-analyst displaced.
reset_state()
bin_dir = Path(tempfile.mkdtemp(prefix="wake-bin-"))
log_file = bin_dir / "calls"
(bin_dir / "sudo").write_text(
    f'#!/usr/bin/env bash\necho "$*" >> "{log_file.as_posix()}"\n'
    '[ "$2" = "is-active" ] && exit 0\nexit 0\n')
(bin_dir / "sudo").chmod(0o755)
(STATE / "log-analyst.last_used").write_text(str(time.time() - 1000))
(STATE / "log-analyst.displaced").write_text("llama-super\n")
bash = shutil.which("bash")
if bash:
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
           "WAKE_STATE_DIR": str(STATE)}
    REAL_RUN([bash, str(TOOLS / "hermes-model-idle-sleep.sh"), "log-analyst",
                    "llama-log-analyst", "300"], env=env, capture_output=True, text=True)
    calls = log_file.read_text().splitlines() if log_file.exists() else []
    check("idle-sleep stops an idled-out log-analyst", "systemctl stop llama-log-analyst" in calls, str(calls))
    check("  then restarts the super it displaced", "systemctl start llama-super" in calls, str(calls))
    check("  and removes the record", not (STATE / "log-analyst.displaced").exists())
else:
    print("SKIP: idle-sleep checks (no bash on PATH)")

shutil.rmtree(STATE, ignore_errors=True)
shutil.rmtree(bin_dir, ignore_errors=True)
print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} passed")
sys.exit(1 if FAILURES else 0)
