#!/usr/bin/env python3
# Version: 1.4.0
#
# 1.4.0 (2026-08-31) — real, confirmed misroute: "check for griefing on the zomboid server" routed
# to `status` instead of `logs`, verified live by injecting a real task through Buzz's `dispatch`
# topic directly and reading back the routed task record. Root cause: ROUTING_SYSTEM_PROMPT gave
# the classifier nothing but a bare topic-name list, so it had only word association to go on --
# and both `logs` (the new `gameabuse` source) and `status` (the `gameservers` source) can
# plausibly claim anything mentioning "zomboid"/"minecraft". Unlike the earlier fleethealth
# collision (fixed by teaching `status` the same capability too), this one couldn't be fixed that
# way: `status` deliberately never makes a model call at all, so it has no way to actually perform
# judgment-based log/abuse analysis even if it caught the request. Added TOPIC_DESCRIPTIONS, a
# one-line accurate description per topic now included in the routing prompt, so the classifier
# has real signal to disambiguate "check X's current status" from "analyze X's logs" instead of
# guessing from the topic word alone.
#
# 1.3.1 (2026-08-31) — added `probe` to VALID_TARGETS: direct operator request, "probe <IP>"
# should fire tools/hermes-node-probe.py's real LAN/network investigation (hostnames, MAC/vendor,
# OS fingerprint, full port scan) against that address. New tools/hermes-probe.py and Buzz `probe`
# topic; a normal classifier destination, same as `status`, not presenter-dispatched-only like
# `websearch`.
#
# 1.3.0 (2026-08-31) — added `status` to VALID_TARGETS: direct operator request for chat access
# to a curated, read-only subset of the fleet's own skills/ status monitors (pfsense, generac,
# moen-flo, wyze, game servers, vivint status, botnet-intel), landed as the new tools/hermes-status.py
# and Buzz `status` topic. Unlike `websearch` (presenter-dispatched only, never a routing target),
# `status` is a normal classifier destination — a status-shaped question routes here the same way
# any other topic is chosen. No change to choose_topic()/the single-word-reply contract; just one
# more valid word for the model to pick.
#
# 1.2.1 (2026-08-30) — real bug found live building the internet-search fallback: process_results()
# unconditionally overwrote every completed task's state to `done` on any `results` message,
# regardless of what the specialist that published it had actually set. Harmless by coincidence for
# plain success (every specialist already sets `done` itself via publish_result()) but silently
# clobbered `error` back to `done`, and outright broke hermes-retrieve.py 1.2.0's new `no-match`
# state -- the offer to search the internet never fired because this write raced it and won every
# time, moments after retrieve.py's own set_task_state("no-match") call, confirmed live via a real
# test task's final stored state (`agent: dispatch, state: done`) despite retrieve's own turn
# already containing its no-match text. Root cause: every specialist now owns setting its own
# final task state as part of publish_result() (or equivalent); this dispatcher-side write was
# never removed when that ownership moved to each specialist, so two writers raced for the same
# field with the wrong one winning. Fixed by deleting the write entirely -- process_results() now
# only acks the claim so the `results` topic doesn't back up; it was never anything more than a
# drain loop once every specialist started setting its own state.
#
# 1.2.0 (2026-08-30) — conversation continuity, the routing half. choose_topic() gains an
# optional `history` param, prepended before the current message when given -- real gap this
# closes: a follow-up like "tell me more about that" has no topic-shaped content of its own, so
# without context it either misroutes or the routing model just guesses. process_one() resolves
# `conv_id` off the same turn it already fetches by task_id (hermes_conversation_common.py's
# fetch_conv_id(), same pointer-resolution logic fetch_raw_text() already has, just returning a
# different field) and fetches a small window of recent history (ROUTING_HISTORY_TURNS, default
# 6 -- deliberately smaller than what specialists use for their own answers, since routing only
# needs to recognize "this is a continuation of X," not reconstruct the whole exchange).
# ROUTING_SYSTEM_PROMPT gains one added instruction covering exactly this case. VALID_TARGETS and
# the single-word-reply contract are unchanged.
#
# 1.1.0 — HermesAgentV5 S12: failover, up target §11.2's escalation ladder. Rung 1 (systemd
# auto-restart) already existed (hermes-dispatch.service, Restart=always). This adds what rung 2
# needs: a heartbeat (agent_state "dispatch"/"heartbeat" in hermes-memory, rewritten every loop
# iteration, throttled to HEARTBEAT_INTERVAL_SECONDS) that a standby on another node can watch for
# staleness (see tools/hermes-dispatch-standby-check.sh). Also splits `choose_topic()`'s target URL
# from ROUTER_URL into its own DISPATCH_CHAT_URL, defaulting to the same place (ROUTER_URL's own
# /v1/chat/completions) but overridable — needed because ROUTER_URL's default (127.0.0.1:8080) is
# only reachable when this process runs on Watch. hermes-router.py's :8080 is deliberately
# loopback-only *and unauthenticated on that path* (its own security boundary is the bind address,
# not a bearer token, unlike every other service in this fleet) — rung 2/3 do not open it up
# cross-node, the same call S4 already made about not casually touching a deliberate bind-address
# security boundary. A standby instance instead points DISPATCH_CHAT_URL straight at the `dispatch`
# role's own llama-server port (e.g. http://10.129.1.15:8097/v1/chat/completions) — same "talk
# directly to the backend, not the router" shape S11's benchmark harness already established, and
# the ufw rule that opens is narrowly scoped to one peer IP, matching every existing cross-node
# role rule from S1 rather than setting a new precedent.
#
# 1.0.1 — real bug found live during this stage's own verification: `publish()` (called from
# `process_one()` to forward a routing decision onward) raised an uncaught `HTTPError` that
# crashed the whole process — the actual cause was `hermes-buzz.py` not yet recognizing
# `dispatch` as a valid sender identity (fixed there, `KNOWN_AGENTS` 2.0.3), but the deeper gap
# was here: a single bad HTTP response from any dependency should never take this daemon down.
# The main loop now catches any exception per-cycle and continues — the claim being worked on
# simply times out its lease and becomes reclaimable, no state lost, because none is kept here.
#
# hermes-dispatch — the routing decision, extracted (HermesAgentV5/IMPLEMENTATION_PLAN.md S6;
# target architecture §6, §10, §11.3). In V4, each persona's own gateway makes its own routing
# decision inside one LLM turn on an abliterated model — target §6.2's exact worst case, live and
# unobserved (V5 S1's gap analysis). This is the extraction: a standalone stdlib service, a
# Buzz `dispatch` topic subscriber, stock weights, holding no state anywhere but Buzz and
# hermes-memory.
#
# Three non-negotiables from IMPLEMENTATION_PLAN.md S6, each enforced here, not aspirational:
#   1. `dispatch` runs stock weights — enforced one layer down, in hermes-router.py's ROLES map
#      (Qwen3.6-35B-A3B, never abliterated, target §12.1).
#   2. Reads raw agent output, never presented (target §6.2 leak path 2) — every text this
#      process ever reasons over comes from hermes-memory's `raw` column via a `task_id`/
#      `memory_ref` pointer, never inline Buzz payload content (target §7.3's invariant).
#   3. Holds no routing state that exists nowhere else (target §11.3) — this process keeps no
#      in-memory record of in-flight work across loop iterations, let alone across restarts.
#      Every fact needed to resume lives in Buzz's own claim/lease state (an abandoned claim is
#      simply reclaimable) and hermes-memory's `tasks` table. Kill this process at any point and
#      a fresh instance resumes correctly with zero handoff logic of its own.
#
# Screens its own input before routing on it (target §8.2: injectable routing is the highest-
# leverage compromise in this architecture) — both layers, the same two hermes-router.py already
# runs for direct chat-completion callers, applied here because nothing upstream of this process
# does yet (hermes-presenter.py, S7, is the eventual real ingress).
#
# Ahead of its own consumer, same precedent S2/S3 already set: nothing publishes to the `dispatch`
# Buzz topic in production yet (that's S7's presenter and S8's cutover). This process is complete
# and independently verifiable today regardless — publish a pointer message to `dispatch`
# manually and it will screen, route, and publish onward correctly.
#
# Config, all from the environment (injected by hermes-dispatch-wrapper.sh):
#   BUZZ_URL        default http://<SPARK_LAN_IP>:8101
#   BUZZ_TOKEN      required
#   MEMORY_URL      default http://<SPARK_LAN_IP>:8102
#   MEMORY_TOKEN    required
#   ROUTER_URL      default http://127.0.0.1:8080 (correct when this process runs on Watch, same
#                   node as the `dispatch` role — the normal case)
#   DISPATCH_CHAT_URL   default {ROUTER_URL}/v1/chat/completions — override when running as a
#                   cross-node standby (S12), since ROUTER_URL's loopback default isn't reachable
#                   from Forge and router's :8080 is deliberately never opened cross-node (it has
#                   no bearer-auth of its own, unlike every other service here). Point this
#                   straight at the `dispatch` role's own llama-server port instead, e.g.
#                   http://10.129.1.15:8097/v1/chat/completions.
#   GUARD_URL       default http://<SPARK_LAN_IP>:8096
#   GUARD_TOKEN     optional — if unset, Layer 2 is skipped for dispatch's own screening pass,
#                   same graceful-degradation hermes-router.py already follows
#   POLL_SECONDS    default 5 — Buzz is pull-based; no push mechanism exists
#   CLAIMANT        default "hermes-dispatch" — set to something else (e.g. "hermes-dispatch-standby")
#                   for a promoted standby instance, so its heartbeat writes and Buzz claims are
#                   distinguishable in logs/history from the primary
#   HEARTBEAT_INTERVAL_SECONDS   default 30 — how often the "dispatch"/"heartbeat" agent_state key
#                   in hermes-memory is rewritten; a standby watches this key's `updated_at` for
#                   staleness

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_injection_guard  # noqa: E402
import hermes_conversation_common  # noqa: E402

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")
ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")
DISPATCH_CHAT_URL = os.environ.get("DISPATCH_CHAT_URL", f"{ROUTER_URL}/v1/chat/completions")
GUARD_URL = os.environ.get("GUARD_URL", f"http://{SPARK_IP}:8096").rstrip("/")
GUARD_TOKEN = os.environ.get("GUARD_TOKEN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
CLAIMANT = os.environ.get("CLAIMANT", "hermes-dispatch")
HEARTBEAT_INTERVAL_SECONDS = int(os.environ.get("HEARTBEAT_INTERVAL_SECONDS", "30"))
ROUTING_HISTORY_TURNS = int(os.environ.get("ROUTING_HISTORY_TURNS", "6"))

# Target §4.4's internal topic set, minus `dispatch` itself and `results` (a destination
# specialists publish completion to, never something the dispatcher routes fresh work into).
VALID_TARGETS = {"retrieve", "screen", "logs", "code", "vision", "media", "train", "status", "probe"}

# One-line, accurate descriptions per topic -- added 2026-08-31 after a real, confirmed
# misroute: "check for griefing on the zomboid server" went to `status` instead of `logs`,
# because a bare topic-name list gives the classifier nothing but word association to go on, and
# both topics can plausibly claim anything mentioning "zomboid"/"minecraft"/"fleet health". Unlike
# the earlier fleethealth collision (fixed by duplicating that one capability into both agents),
# this one can't be fixed that way: `status` deliberately never makes a model call at all (target
# §12.1-style scoping decision, kept intentionally simple/deterministic), so it has no way to
# actually perform judgment-based log/abuse analysis even if it caught the request. The real fix
# is a better-informed routing decision, not more duplicated capability.
TOPIC_DESCRIPTIONS = {
    "retrieve": "search the fleet's own knowledge base (RAG) for an answer with citations",
    "screen": "classify one specific piece of text as malicious/safe on demand",
    "logs": "analyze security/log data for patterns or issues -- pfsense firewall logs, canary "
            "honeypot events, a full aggregated fleet-health report, Minecraft/Zomboid "
            "admin/connection/PvP logs for griefing or abuse, or raw pasted log text",
    "code": "answer a coding question (no code execution)",
    "vision": "reserved, not yet staffed",
    "media": "generate an image or video via the render broker",
    "train": "reserved, not yet staffed",
    "status": "a quick, real-time status/reading check for one named external system -- pfsense, "
              "generac, moen-flo, wyze, a game server's health, Vivint alarm state, a fleet-health "
              "snapshot, or a botnet/threat-intel IP lookup",
    "probe": "run a real network scan (nmap) against one specific IP address",
}

ROUTING_SYSTEM_PROMPT = (
    "You are a routing classifier. Given a piece of text (optionally preceded by recent "
    "conversation history for context), reply with EXACTLY ONE WORD: the name of the topic the "
    "final message should be routed to. If that message has no clear topic of its own -- a "
    "follow-up like \"tell me more\" or \"what about X instead\" -- infer the topic from what the "
    "conversation was already about, don't guess blindly. Valid topics, choose exactly one:\n"
    + "\n".join(f"- {t}: {TOPIC_DESCRIPTIONS.get(t, '')}" for t in sorted(VALID_TARGETS))
    + "\n\nReply with only the topic name, nothing else — no punctuation, no explanation."
)


def log(msg):
    print(f"[hermes-dispatch] {msg}", flush=True)


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
        result = _post(f"{BUZZ_URL}/claims/next", {"topic": topic, "claimant": CLAIMANT}, BUZZ_TOKEN)
        return result.get("claim")
    except Exception as exc:
        log(f"claim_next({topic!r}) failed: {exc}")
        return None


def ack_claim(claim_id):
    try:
        _post(f"{BUZZ_URL}/claims/{claim_id}/ack", {"claimant": CLAIMANT}, BUZZ_TOKEN)
    except Exception as exc:
        log(f"ack_claim({claim_id}) failed: {exc}")


def publish(topic, from_agent, task_id, memory_ref, body=""):
    """Pointer envelope only — task_id/memory_ref, never inline content (target §7.3)."""
    return _post(f"{BUZZ_URL}/messages",
                 {"from": from_agent, "topic": topic, "body": body,
                  "task_id": task_id, "memory_ref": memory_ref}, BUZZ_TOKEN)


def fetch_raw_text(task_id, memory_ref):
    """Hydrate from hermes-memory's `raw` channel by task_id — never trusts inline Buzz payload
    content, per the pointer-not-payload invariant this whole stage exists to enforce."""
    turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=50", MEMORY_TOKEN).get("turns", [])
    if not turns:
        return None
    if memory_ref:
        for t in turns:
            if str(t["id"]) == str(memory_ref) or memory_ref == f"turn:{t['id']}":
                return t["raw"]
    return turns[-1]["raw"]  # newest turn for this task, if memory_ref didn't pin one


def set_task_state(task_id, agent, state, topic=None, memory_ref=None):
    try:
        payload = {"id": task_id, "agent": agent, "state": state}
        if topic:
            payload["topic"] = topic
        if memory_ref:
            payload["memory_ref"] = memory_ref
        _post(f"{MEMORY_URL}/tasks", payload, MEMORY_TOKEN)
    except Exception as exc:
        log(f"set_task_state({task_id!r}, {state!r}) failed: {exc}")


def log_guard_verdict(layer, severity_value, detail):
    try:
        _post(f"{MEMORY_URL}/turns", {
            "task_id": "guard-log", "agent": "guard", "role": "system",
            "raw": json.dumps({"node": "dispatch", "layer": layer, "severity": severity_value, **detail}),
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"guard verdict logging failed: {exc}")


def screen(text):
    """Both layers, same verdicts hermes-router.py already enforces for direct callers. Returns
    True if the text is clean enough to route on, False if it should be rejected."""
    hits = hermes_injection_guard.scan_messages([{"role": "user", "content": text}])
    severity = hermes_injection_guard.overall_severity(hits)
    if severity == "block":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log(f"Layer 1 BLOCKED dispatch input: categories={categories}")
        log_guard_verdict("L1", "block", {"categories": categories})
        return False
    if severity == "flag":
        categories = sorted({cat for r in hits for cat in r["hits"]})
        log(f"Layer 1 flagged dispatch input (continuing to Layer 2): categories={categories}")
        log_guard_verdict("L1", "flag", {"categories": categories})

    if GUARD_TOKEN:
        try:
            verdict = _post(f"{GUARD_URL}/classify", {"text": text}, GUARD_TOKEN, timeout=10)
            if verdict.get("hit"):
                log(f"Layer 2 BLOCKED dispatch input: score={verdict['score']:.3f}")
                log_guard_verdict("L2", "block", {"label": verdict["label"], "score": verdict["score"]})
                return False
        except Exception as exc:
            log(f"Layer 2 unreachable, proceeding on Layer 1 alone: {exc}")

    return True


def choose_topic(text, history=None):
    """Calls the stock `dispatch` role via hermes-router.py, same call shape any other role
    caller uses. Returns a validated topic name, or None if the model's reply doesn't parse to
    one of VALID_TARGETS — a bad response is a failure to route, never a silent guess.

    `history` (conversation continuity, 1.2.0), when given, is prepended before the current
    message — a smaller window than specialists use for their own answers (ROUTING_HISTORY_TURNS
    default 6 vs. specialists' default 20): routing only needs enough to recognize "this is a
    continuation of X," not the full conversation."""
    messages = [{"role": "system", "content": ROUTING_SYSTEM_PROMPT}]
    if history:
        messages.extend(hermes_conversation_common.as_messages(history))
    messages.append({"role": "user", "content": text[:4000]})
    body = {
        "model": "dispatch",
        "messages": messages,
        "max_tokens": 10,
    }
    try:
        result = _post(DISPATCH_CHAT_URL, body, timeout=30)
    except Exception as exc:
        log(f"dispatch model call failed: {exc}")
        return None
    reply = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    candidate = reply.strip().lower().strip(".,!?\"'")
    return candidate if candidate in VALID_TARGETS else None


def process_one():
    claim = claim_next("dispatch")
    if not claim:
        return False

    claim_id = claim["id"]
    msg = claim["message"]
    task_id, memory_ref = msg.get("task_id"), msg.get("memory_ref")

    if not task_id:
        log(f"claim {claim_id}: message has no task_id — pointer envelope required, acking and dropping")
        ack_claim(claim_id)
        return True

    raw_text = fetch_raw_text(task_id, memory_ref)
    if not raw_text:
        log(f"claim {claim_id}: task {task_id!r} has no raw text in hermes-memory — acking and dropping")
        ack_claim(claim_id)
        set_task_state(task_id, "dispatch", "error-no-content")
        return True

    if not screen(raw_text):
        log(f"claim {claim_id}: task {task_id!r} rejected by screening")
        set_task_state(task_id, "dispatch", "blocked")
        ack_claim(claim_id)
        return True

    conv_id = hermes_conversation_common.fetch_conv_id(MEMORY_URL, MEMORY_TOKEN, task_id, memory_ref)
    history = hermes_conversation_common.fetch_history(
        MEMORY_URL, MEMORY_TOKEN, conv_id, limit=ROUTING_HISTORY_TURNS) if conv_id else []
    topic = choose_topic(raw_text, history=history)
    if not topic:
        log(f"claim {claim_id}: task {task_id!r} — dispatch model gave no valid topic, "
            f"leaving claim unacked for retry after lease expiry")
        return True  # deliberately not acked — Buzz's own lease reclaims it, no state kept here

    publish(topic, "dispatch", task_id, memory_ref)
    set_task_state(task_id, "dispatch", "dispatched", topic=topic)
    ack_claim(claim_id)
    log(f"claim {claim_id}: task {task_id!r} -> topic {topic!r}")
    return True


def send_heartbeat():
    """S12 rung 2: written to hermes-memory's agent_state so a standby on another node can watch
    `updated_at` for staleness (tools/hermes-dispatch-standby-check.sh). Value is CLAIMANT, not a
    timestamp — the server already stamps `updated_at` on every write, and knowing *which* instance
    (primary or a promoted standby) last beat is useful in its own right when reading state by hand."""
    try:
        _post(f"{MEMORY_URL}/state", {"agent": "dispatch", "key": "heartbeat", "value": CLAIMANT}, MEMORY_TOKEN)
    except Exception as exc:
        log(f"heartbeat write failed: {exc}")


def process_results():
    """Watches the `results` topic — target §10.1's "results path back through the dispatcher."
    Does NOT write task state (1.2.1 fix): every specialist already sets its own final state
    (done/error/no-match/etc.) via its own set_task_state() call before or as part of publishing
    here, and this dispatcher used to unconditionally overwrite that with a blind "done" — right
    by coincidence for plain success, wrong for anything else. This is now purely a drain loop so
    the `results` topic's claims don't pile up unacked; hermes-memory's task state is left alone."""
    claim = claim_next("results")
    if not claim:
        return False
    msg = claim["message"]
    task_id = msg.get("task_id")
    if task_id:
        log(f"claim {claim['id']}: task {task_id!r} results received")
    ack_claim(claim["id"])
    return True


def main():
    if not BUZZ_TOKEN:
        sys.exit("BUZZ_TOKEN is required")
    if not MEMORY_TOKEN:
        sys.exit("MEMORY_TOKEN is required")
    if not GUARD_TOKEN:
        log("WARNING: GUARD_TOKEN not set — dispatch's own Layer 2 screening pass is skipped")
    log(f"watching Buzz topics 'dispatch' and 'results', polling every {POLL_SECONDS}s, "
        f"routing among {sorted(VALID_TARGETS)}")
    last_heartbeat = 0.0
    while True:
        try:
            now = time.time()
            if now - last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
                send_heartbeat()
                last_heartbeat = now
            did_work = process_one()
            did_work = process_results() or did_work
        except Exception as exc:
            # A single bad HTTP response (Buzz, hermes-memory, hermes-guard, or the router
            # itself) must never take the whole daemon down — real crash found live during S6
            # verification: publish() raised an uncaught HTTPError and systemd had to restart
            # the whole process, losing the claim's own in-progress handling instead of just
            # that one operation. The claim this iteration was working on simply times out its
            # lease and becomes reclaimable — no state was lost, because none is kept here.
            log(f"unhandled error this cycle, continuing: {exc}")
            did_work = False
        if not did_work:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
