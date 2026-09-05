#!/usr/bin/env python3
# Version: 1.6.7
#
# 1.6.7 (2026-09-06) — direct operator request: audit HELP_MESSAGE against every topic actually
# live in VALID_TARGETS/TOPIC_DESCRIPTIONS (tools/hermes-dispatch.py) and every keyword group
# actually live in STATUS_SOURCES/MODEL_REPORT_KEYWORDS (tools/hermes-status.py), not just trust
# the last time it was updated. Found two real, live, user-reachable gaps: `dualcoder` (a normal
# dispatch target since 1.4.5, never added here) had no HELP_MESSAGE line at all, and the
# `status` bullet never mentioned the "model report" keyword group (live since hermes-status.py
# 1.3.0). `vision`/`train` are correctly absent -- both are explicitly "reserved, not yet
# staffed" in TOPIC_DESCRIPTIONS, not real capabilities yet.
#
# 1.6.6 (2026-09-02) — removed the `nest` topic entirely: direct operator decision to drop the
# Google Home/Nest camera integration (NEST_TASK_TIMEOUT_SECONDS, its check_outstanding() branch,
# and its HELP_MESSAGE line all removed). `reolink` is unaffected and needed no timeout override
# to begin with (1.6.5's own note: a snapshot is one bounded local HTTP call).
#
# 1.6.5 (2026-09-02) — HELP_MESSAGE updated for the new `reolink` topic (tools/hermes-reolink.py,
# Reolink camera snapshot + description). No timeout override needed here, unlike `probe`/`nest`
# — a Reolink snapshot is one bounded local HTTP call, no WebRTC negotiation or long-running scan
# involved, so the existing generic TASK_TIMEOUT_SECONDS (300s) is already generous margin.
#
# 1.6.4 (2026-09-01) — supports the new `nest` topic (tools/hermes-nest.py, camera snapshot +
# description). Same shape as 1.6.2's `probe` support: check_outstanding()'s generic
# TASK_TIMEOUT_SECONDS could fire before a real WebRTC capture finishes, so a topic-specific
# NEST_TASK_TIMEOUT_SECONDS (default 120s -- an UNVERIFIED placeholder, see
# tools/hermes-nest-framegrab.py's docstring; must be corrected once a real capture is timed)
# joins PROBE_TASK_TIMEOUT_SECONDS in the same conditional. HELP_MESSAGE also updated.
#
# 1.6.3 (2026-08-31) — direct operator request: HELP_MESSAGE updated for everything built after
# 1.5.0 first wrote it -- the `probe` topic (network scans, ack-now/report-later), and `logs`'
# new gameabuse/pfsense/canary natural-language reachability (previously only status-check
# coverage was documented here, log/security analysis wasn't mentioned at all).
#
# 1.6.2 (2026-08-31) — supports the new `probe` topic (tools/hermes-probe.py), the fleet's first
# genuinely long-running specialist: a real node probe can legitimately take up to ~30 minutes.
# The one change needed here: check_outstanding()'s existing TASK_TIMEOUT_SECONDS check (default
# 300s) would otherwise falsely report a probe as stuck well before it finishes. New
# PROBE_TASK_TIMEOUT_SECONDS (default 2100s/35min, matching hermes-probe.py's own outer safety
# net) applies only when topic == "probe"; every other topic is unaffected. No other change needed
# -- the routed ack and the delayed-delivery poll loop already handle an arbitrarily long-running
# task correctly, since neither has ever assumed a task resolves quickly.
#
# 1.6.1 (2026-08-31) — real bug found live: "/help" opened Element's own client-side app help
# instead of ever reaching this process -- Matrix clients generally intercept a leading "/" as
# their own command syntax before it's sent as a room message. Switched the control-phrase escape
# from "/" to "!" for both NEW_CONVERSATION_PHRASES ("/new" -> "!new") and HELP_PHRASES ("/help"
# -> "!help"), per direct operator request that "!" become this fleet's default command-escape
# convention going forward, not just a one-off fix for these two. The plain-English alternatives
# ("start over", "reset conversation", bare "help") are untouched -- they were never at risk of
# client-side interception in the first place, only literal "/"-prefixed text was.
#
# 1.6.0 (2026-08-31) — direct operator request: the inbound "Got it — working on that." ack
# should say which specialist is actually handling the request. handle_message() itself can't do
# this -- it fires before hermes-dispatch.py's async routing decision even happens, so the topic
# genuinely isn't known yet at that point. Moved the ack out of handle_message() entirely and into
# check_outstanding()'s own polling loop: a new terminal `elif` fires the first time a still-in-
# progress task's real topic becomes visible (dispatch.py's `dispatched` state always carries it),
# sends "Got it — routing this to {topic}.", and marks the pending-state entry's new `acked` flag
# so it's never resent. A task that resolves fast (before the next poll) never gets a preliminary
# ack at all -- correct, since the real answer arriving is strictly better information than
# "working on it" would have been. dispatch_websearch() is pre-marked acked=True since it already
# knows its one fixed destination and sends its own specific message immediately, same as before.
#
# 1.5.1 (2026-08-31) — real bug found live: check_outstanding() never had a branch for
# state == "error" — every specialist's own ok=False failure (a real, specific message: "Retrieval
# failed: <exc>", "Could not gather pfsense data: <err>", etc.) silently fell through every
# existing branch until TASK_TIMEOUT_SECONDS elapsed, then surfaced as the generic "No specialist
# has completed this request yet" text, which reads as "still in flight" rather than "it ran and
# failed" — directly contradicting this function's own documented promise ("failures escalate
# verbatim"). Caught on a live status-check task that DID complete, with a real honest answer
# already published, that the user never saw. Added the missing branch: same turn-lookup as
# `done`, delivering the specialist's actual message, never styled (same as every other failure
# branch here).
#
# 1.5.0 (2026-08-31) — /help, direct operator request: several capabilities built this session
# (the fleet-health keyword trigger, the curated status-check keywords, the new-conversation
# control phrases) only work if the user already knows the right words to say, with no way to
# discover them from inside the chat itself. HELP_PHRASES ("/help", "help") is checked first in
# handle_message(), before even the websearch-offer check, so asking for help never consumes or
# clears a pending offer -- it just answers and leaves whatever state existed untouched. Sends a
# fixed, hardcoded HELP_MESSAGE (no model call — this only needs to be accurate, not natural
# language, and a model paraphrase of it risks exactly the kind of capability-description drift
# this project's anti-fabrication stance exists to prevent). No turn, no task, no dispatch — same
# shape the control-phrase branch below already established.
#
# 1.4.0 (2026-08-30) — internet-search fallback offer, direct operator request: "search RAG
# first, then offer to search the internet if RAG doesn't have what I need." hermes-retrieve.py
# 1.2.0 now publishes a distinct `no-match` task state (instead of `done`) when it genuinely has
# no grounded answer; check_outstanding() watches for that state, sends a fixed offer message, and
# stashes the original question's task_id/memory_ref under a new per-room `websearch-offer:*`
# presenter-state key (same agent_state identity as this process's own `pending:*` keys, distinct
# prefix so the two never collide in a `GET /state/presenter` listing). handle_message() checks
# for a live offer before anything else: a deterministic yes/no phrase match (same "doesn't need
# to be smart, needs to be right" reasoning NEW_CONVERSATION_PHRASES already uses) either resumes
# the SAME task_id on the new `websearch` Buzz topic (bypassing hermes-dispatch.py's classifier
# entirely — this fallback is reachable only through this explicit offer/confirm exchange, never
# routed to directly, per the operator's own scoping) or sends a plain decline acknowledgment;
# anything else clears the offer and falls through to normal handling, so an unrelated new message
# after an unanswered offer is never mistaken for a reply to it. Reusing the original task_id
# (rather than minting a new one) is deliberate: it's the same logical request continuing on a
# different backend, hermes-memory's `tasks` table already upserts by id, and every specialist's
# fetch_raw_text() only searches turns scoped to task_id, so a fresh task_id with no turns of its
# own would find nothing to answer regardless of what memory_ref pointed to. `agent_state`'s
# `_set_state` rejects a null value outright (confirmed by reading hermes-memory.py directly, not
# guessed) — offers are "cleared" by overwriting with `{}`, which reads back falsy at every call
# site that checks `if offer:`, without needing a delete route that doesn't exist.
#
# 1.3.0 (2026-08-30) — conversation continuity. Every message now belongs to a conv_id, tagged
# on its turn at write time (hermes-memory.py 1.3.0's new `turns.conv_id` column) and resolved by
# hermes-dispatch.py/each specialist off the same turn they already fetch by task_id — no change
# to Buzz's message schema or the tasks table needed at all. Three reset paths, each a fresh
# conv_id: an explicit control phrase (NEW_CONVERSATION_PHRASES, matched deterministically, not
# by a model call — same "doesn't need to be smart, needs to be right" reasoning
# hermes-logs.py's own parse_source() already established for exactly this kind of choice);
# IDLE_TIMEOUT_SECONDS (1hr default) with no activity; MAX_CONV_TURNS/MAX_CONV_CHARS overflow.
# The idle and overflow paths both send an explicit plain-text notice before continuing —
# operator direction, given both ways in. Per-room bookkeeping (which conv_id is active, when it
# was last used) lives in hermes-memory's agent_state under a dedicated "continuity" identity,
# read via list+filter rather than the path-keyed GET /state/<agent>/<key> route — Matrix room
# ids contain characters that route's own handler never unquotes. New shared library
# hermes_conversation_common.py holds the three operations hermes-dispatch.py and every
# specialist but hermes-screen.py now also need (fetch_conv_id/fetch_history/as_messages) --
# factored out once rather than duplicated six times, same reasoning every other shared module in
# this fleet already exists for.
#
# 1.2.0 (2026-08-30) — inbound acknowledgment: handle_message() now sends a fixed, unstyled
# "Got it — working on that." immediately after a message dispatches, before the real reply. Real
# UX gap found live during this stage's own verification: a message routed to an on-demand model
# (coder, ~150s cold-wake budget) gives no sign anything happened until either the real answer or,
# if something's actually wrong, the 300s timeout message -- indistinguishable from a dropped
# message the whole time in between. Deliberately not run through style_reply() -- a fixed status
# string needs to be instant, not wait on a model call, same reasoning the three hardcoded failure
# messages in check_outstanding() already skip styling for. Toggleable (ACK_ENABLED) and
# best-effort (a failed ack send is logged, never blocks or retries the real dispatch, which has
# already succeeded by the time this runs).
#
# 1.1.0 (2026-08-30) — minimal light-voice styling pass added on the outbound success path only
# (check_outstanding()'s `state == "done"` branch) -- target §6.2/§6.3, operator direction: "keep
# it minimal, light voice, no named persona." New looks_technical()/should_style() implement
# passthrough-by-default (§6.3): code fences, stack traces, JSON bodies, multi-line timestamped
# log output, and anything over STYLE_MAX_CHARS skip styling and go out exactly as stored; only
# short-enough, chat-shaped replies reach a model call at all. New style_reply() calls `dispatch`
# through hermes-router's OpenAI-compatible proxy at ROUTER_URL, same request shape hermes-logs.py
# already establishes for calling a role this way. Model choice took a real correction during
# build: the obvious precedent (`super`, matching hermes-logs.py's own choice) turned out to be
# running an abliterated checkpoint live (Huihui-GLM-4.7-Flash-abliterated) -- confirmed by
# curling its /v1/models -- which would have silently violated target §12.1's own table
# ("Presenter | Stock | Outbound only; no benefit") and the operator's explicit stock-weights
# choice. Checked every other resident role's actual loaded model before picking one: `muse` is
# also abliterated live; `omni` is stock but on spark-2 (cross-node hop) and sized for
# multimodal/reasoning, not light restyling; `dispatch` (Qwen3.6-35B-A3B, confirmed stock per S6,
# "never abliterated") is the only always-resident, confirmed-stock, right-sized option. Reusing
# it means styling calls share the one backend target §6.1 argues for keeping response-formatting
# away from -- an accepted, operator-confirmed tradeoff, not an oversight, since styling calls are
# low-volume (only fire on a chat reply actually being delivered, not on every routing decision).
# STYLE_SYSTEM_PROMPT states target §6.2's hard contract
# directly: forbid omitting/softening any fact (especially failures), forbid inventing certainty,
# forbid resolving ambiguity the source left open. Graceful degradation is unconditional: any
# exception, timeout, or empty/malformed model response falls straight back to the original raw
# text -- style_reply() never raises and never blocks delivery. The three failure paths
# (screened-out / dispatch-recording-failure / timeout) are untouched, still hardcoded plain
# text, per the module docstring's own "failures escalate verbatim" rule. Does not write the
# styled text back to hermes-memory's `presented` column -- no PATCH/update route exists on that
# table (hermes-memory.py's /turns is insert-only), and dispatch already reads `raw` per the
# insulation contract's own rule, so nothing downstream needs it.
#
# 1.0.1 — real bug found live during this stage's own verification: `join_room()` called the
# join-by-room-ID endpoint with PUT, which is wrong — that verb is for the txn-keyed
# send-message endpoint (`send_room_message()`, correctly PUT). Joining is POST. Every invite
# was silently un-actioned (405 Method Not Allowed, caught and logged, never crashed) until this
# was caught on the very first test invite.
#
# hermes-presenter — the fleet's one interactive voice, thin (HermesAgentV5/IMPLEMENTATION_PLAN.md
# S7; target architecture §6). Owns the Matrix connection so hermes-dispatch.py doesn't have to —
# target §6.1's whole argument: keep the latency-critical router/dispatcher out of response
# formatting, make personality a config file instead of baked into N agents' prompts.
#
# **A minimal styling pass now exists** (1.1.0), scoped to the outbound success path only —
# passthrough-by-default for anything that looks technical, stock weights (`super`), unconditional
# fallback to raw text on any failure. This is that "later, separate decision" V5
# IMPLEMENTATION_PLAN.md §4.4 deferred. Re-read the insulation contract below before extending it
# further.
#
# The insulation contract (target §6.2), enforced in code:
#   1. Inbound normalization — inbound text goes to hermes-memory and Buzz byte-for-byte. No
#      paraphrase, no trimming beyond what Matrix itself already did. Untouched by the styling
#      pass — handle_message() never calls style_reply(), only check_outstanding() does, and only
#      on the outbound side.
#   2. Conversation history — this process now owns *which* conversation a message belongs to
#      (conv_id lifecycle: minting, idle/overflow reset), but still never re-derives or forwards
#      *what was said* — routing and every specialist's own history read pulls raw text straight
#      from hermes-memory by conv_id, this process just tags each turn with one at write time
#      (hermes_conversation_common.py). The styled text a user reads is still never what a future
#      dispatch/specialist decision is built from.
#   3. Clarifying questions — the presenter still never asks one in-character, and nothing routes
#      a *styled* reply back into the dispatch path. One narrow, fixed exception exists as of
#      1.4.0: the internet-search fallback offer is a single hardcoded yes/no question with
#      deterministic phrase matching on the reply (same "doesn't need to be smart, needs to be
#      right" contract NEW_CONVERSATION_PHRASES already uses), not a model-generated question and
#      not free-form routing — a "yes" resumes the exact same task_id on a single fixed topic
#      (`websearch`), nothing else. This is a scoped, operator-approved exception (RAG-fallback
#      only, never a general dispatch target), not a reopening of this rule.
#   4. Fidelity drift — actively defended now, not structurally impossible: should_style() scopes
#      the model call to short, chat-shaped text only (see looks_technical()), STYLE_SYSTEM_PROMPT
#      explicitly forbids omitting/softening facts or inventing certainty, and style_reply() falls
#      back to the untouched raw text unconditionally on any exception, timeout, or malformed
#      response.
#   Failures escalate verbatim: a screened-out, errored, or timed-out task gets a plain, honest
#   status message, never silence and never invented certainty. check_outstanding()'s three
#   failure branches never call style_reply() at all.
#
# Holds real local state (a Matrix sync cursor — normal for any Matrix client, unrelated to
# hermes-dispatch.py's routing-state non-negotiable) but no in-memory index of outstanding tasks:
# every pending task's reply-destination lives in hermes-memory's `agent_state` (`GET
# /state/presenter` lists them all), so a restart mid-conversation loses nothing but a few
# seconds of latency on the next poll.
#
# Config, all from the environment (injected by hermes-presenter-wrapper.sh):
#   MATRIX_HOMESERVER   default from the `matrix-presenter` vault item's `homeserver` field
#   MATRIX_USER_ID      required — from `matrix-presenter` vault item
#   MATRIX_ACCESS_TOKEN required — from `matrix-presenter` vault item
#   BUZZ_URL/BUZZ_TOKEN, MEMORY_URL/MEMORY_TOKEN — required, same as hermes-dispatch.py
#   SYNC_STATE_FILE     default ~/.hermes/presenter/sync-token
#   POLL_SECONDS        default 5 — how often outstanding tasks are checked for completion
#   TASK_TIMEOUT_SECONDS default 300 — how long before an undelivered task gets a plain timeout
#                        notice instead of silence
#   PROBE_TASK_TIMEOUT_SECONDS default 2100 (35 min) — same idea, but for topic == "probe" only.
#                        tools/hermes-probe.py's real scans legitimately take up to ~30 minutes
#                        (its own PROBE_TIMEOUT_SECONDS outer safety net); the generic 300s
#                        TASK_TIMEOUT_SECONDS would otherwise falsely report a probe as stuck
#                        while it was still correctly running — matches hermes-probe.py's own
#                        outer budget so both time out around the same point rather than presenter
#                        giving up first on a task that's actually about to finish
#   DEBUG_ATTRIBUTION   default "0" — set "1" to prefix replies with "[dispatch→<topic>] "
#   ROUTER_URL          default http://127.0.0.1:8080 — hermes-router's OpenAI-compatible proxy;
#                        presenter and the router both run on Watch (spark), same node `super`
#                        lives on, same pattern hermes-logs.py's ROUTER_URL already establishes.
#                        No bearer token — port 8080 is deliberately loopback-only and unauthed.
#   STYLE_ENABLED       default "1" — set "0" to fully disable the styling pass (instant rollback
#                        to pure passthrough without a code change)
#   STYLE_MODEL         default "dispatch" — role name sent as `model`; stock weights only (target
#                        §12.1: "Presenter | Stock | Outbound only; no benefit"). Not `super`
#                        (confirmed abliterated live: Huihui-GLM-4.7-Flash-abliterated) or `muse`
#                        (confirmed abliterated live). `dispatch` is the only always-resident,
#                        confirmed-stock role (Qwen3.6-35B-A3B, never abliterated per S6) — the
#                        cross-node hop and wrong-shape model size ruled out `omni` (also stock,
#                        but on spark-2). Accepted tradeoff, operator confirmed: styling calls
#                        share dispatch's own inference queue, the one backend target §6.1 argues
#                        for keeping response-formatting away from — acceptable here since styling
#                        calls are low-volume (only fire on a chat reply actually being delivered).
#   STYLE_TIMEOUT_SECONDS default 25 — bounded well under the router's own on-demand wake budget
#                        so a cold `super` can never stall this process's single-threaded poll
#                        loop; on timeout, falls straight back to raw text
#   STYLE_MIN_LEN       default 40 — replies shorter than this skip styling (not enough text to
#                        benefit, not worth a model call)
#   STYLE_MAX_CHARS     default 4000 — replies longer than this are treated as technical/bulk
#                        output and skip styling regardless of shape (cost control + the largest
#                        fidelity-drift surface, target §6.3)
#   ACK_ENABLED         default "1" — set "0" to send no inbound acknowledgment at all
#   ACK_MESSAGE_TEMPLATE default "Got it — routing this to {topic}." — sent once check_outstanding()
#                        first observes the task's real routed topic (hermes-dispatch.py's own
#                        `dispatched` state, which always carries topic), not immediately on
#                        dispatch — handle_message() itself doesn't know the topic yet, since
#                        routing is a separate async decision. Never re-sent once sent (tracked via
#                        the pending-state entry's own `acked` flag) and skipped entirely for a task
#                        that resolves to a terminal state before the next poll — silence during an
#                        on-demand model's cold wake (up to ~150s) still doesn't read as "did this
#                        even arrive?", it just also now says which specialist is handling it.
#   IDLE_TIMEOUT_SECONDS default 3600 (1 hour) — a room's conversation auto-closes after this long
#                        with no message; expect to tune this, not a load-bearing constant
#   MAX_CONV_TURNS      default 40 — a conversation hard-resets once it holds this many turns
#   MAX_CONV_CHARS      default 16000 — or once the accumulated raw text hits this many characters,
#                        whichever comes first
#   NEW_CONVERSATION_PHRASES default "new conversation,!new,start over,reset conversation" —
#                        comma-separated; a message matching one exactly (case-insensitive,
#                        trailing punctuation stripped) starts a fresh conversation immediately,
#                        with no dispatch at all. "!" not "/" -- Element (and Matrix clients
#                        generally) intercept a leading "/" as their own client-side command
#                        syntax before it ever reaches the room as a real message; confirmed live
#                        when "/help" opened Element's own app help instead of reaching this
#                        process at all. "!" is this fleet's own command-escape convention now,
#                        for every control phrase, not just these two.
#   WEBSEARCH_OFFER_MESSAGE default "I couldn't find anything about that in the fleet's knowledge
#                        base. Want me to search the internet for it?" — sent when
#                        hermes-retrieve.py reports its new `no-match` task state
#   WEBSEARCH_ACK_MESSAGE default "Searching the internet for that now." — sent immediately once a
#                        websearch offer is confirmed (this path already knows its exact
#                        destination, no need to wait for check_outstanding()'s routed ack)
#   WEBSEARCH_DECLINE_MESSAGE default "Okay, I won't search the internet for that." — sent when a
#                        websearch offer is explicitly declined
#   WEBSEARCH_YES_PHRASES default "yes,y,yeah,yep,sure,please,go ahead,do it,search the
#                        internet,search online" — comma-separated, same exact-match-after-
#                        strip/lower/punctuation-strip contract as NEW_CONVERSATION_PHRASES
#   WEBSEARCH_NO_PHRASES default "no,n,nah,nope,no thanks,never mind,cancel" — comma-separated,
#                        same matching contract; anything matching neither list clears the offer
#                        and falls through to normal handling instead of guessing
#   HELP_PHRASES         default "!help,help" — comma-separated, same exact-match contract;
#                        checked first in handle_message(), before the websearch-offer lookup.
#                        "!" not "/" -- see NEW_CONVERSATION_PHRASES above for why
#   HELP_MESSAGE         default: a fixed capability summary — see HELP_MESSAGE below for the
#                        exact text

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_conversation_common  # noqa: E402

SPARK_IP = os.environ.get("SPARK_LAN_IP", "10.129.1.15")
MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", f"http://{SPARK_IP}:6167").rstrip("/")
MATRIX_USER_ID = os.environ.get("MATRIX_USER_ID", "")
MATRIX_ACCESS_TOKEN = os.environ.get("MATRIX_ACCESS_TOKEN", "")

BUZZ_URL = os.environ.get("BUZZ_URL", f"http://{SPARK_IP}:8101").rstrip("/")
BUZZ_TOKEN = os.environ.get("BUZZ_TOKEN", "")
MEMORY_URL = os.environ.get("MEMORY_URL", f"http://{SPARK_IP}:8102").rstrip("/")
MEMORY_TOKEN = os.environ.get("MEMORY_TOKEN", "")

SYNC_STATE_FILE = Path(os.environ.get("SYNC_STATE_FILE", str(Path.home() / ".hermes" / "presenter" / "sync-token")))
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "5"))
TASK_TIMEOUT_SECONDS = int(os.environ.get("TASK_TIMEOUT_SECONDS", "300"))
PROBE_TASK_TIMEOUT_SECONDS = int(os.environ.get("PROBE_TASK_TIMEOUT_SECONDS", "2100"))
DEBUG_ATTRIBUTION = os.environ.get("DEBUG_ATTRIBUTION", "0") == "1"

ROUTER_URL = os.environ.get("ROUTER_URL", "http://127.0.0.1:8080").rstrip("/")
STYLE_ENABLED = os.environ.get("STYLE_ENABLED", "1") == "1"
STYLE_MODEL = os.environ.get("STYLE_MODEL", "dispatch")
STYLE_TIMEOUT_SECONDS = int(os.environ.get("STYLE_TIMEOUT_SECONDS", "25"))
STYLE_MIN_LEN = int(os.environ.get("STYLE_MIN_LEN", "40"))
STYLE_MAX_CHARS = int(os.environ.get("STYLE_MAX_CHARS", "4000"))
ACK_ENABLED = os.environ.get("ACK_ENABLED", "1") == "1"
ACK_MESSAGE_TEMPLATE = os.environ.get("ACK_MESSAGE_TEMPLATE", "Got it — routing this to {topic}.")
IDLE_TIMEOUT_SECONDS = int(os.environ.get("IDLE_TIMEOUT_SECONDS", "3600"))
MAX_CONV_TURNS = int(os.environ.get("MAX_CONV_TURNS", "40"))
MAX_CONV_CHARS = int(os.environ.get("MAX_CONV_CHARS", "16000"))
NEW_CONVERSATION_PHRASES = tuple(
    p.strip() for p in os.environ.get(
        "NEW_CONVERSATION_PHRASES", "new conversation,!new,start over,reset conversation"
    ).split(",")
)
WEBSEARCH_OFFER_MESSAGE = os.environ.get(
    "WEBSEARCH_OFFER_MESSAGE",
    "I couldn't find anything about that in the fleet's knowledge base. "
    "Want me to search the internet for it?",
)
WEBSEARCH_ACK_MESSAGE = os.environ.get("WEBSEARCH_ACK_MESSAGE", "Searching the internet for that now.")
WEBSEARCH_DECLINE_MESSAGE = os.environ.get("WEBSEARCH_DECLINE_MESSAGE", "Okay, I won't search the internet for that.")
WEBSEARCH_YES_PHRASES = tuple(
    p.strip() for p in os.environ.get(
        "WEBSEARCH_YES_PHRASES",
        "yes,y,yeah,yep,sure,please,go ahead,do it,search the internet,search online",
    ).split(",")
)
WEBSEARCH_NO_PHRASES = tuple(
    p.strip() for p in os.environ.get(
        "WEBSEARCH_NO_PHRASES", "no,n,nah,nope,no thanks,never mind,cancel"
    ).split(",")
)
HELP_PHRASES = tuple(p.strip() for p in os.environ.get("HELP_PHRASES", "!help,help").split(","))
HELP_MESSAGE = os.environ.get("HELP_MESSAGE", (
    "Here's what I can do:\n\n"
    "• General questions — just ask; I'll route it automatically (knowledge-base search, coding "
    "questions, image generation).\n"
    "• Fleet health — say \"fleet health\" or \"fleet status\" for a full aggregated report.\n"
    "• System status checks — mention pfsense, generac, wyze, moen flo / water shutoff / leak "
    "detector, minecraft / zomboid / game server, or vivint / security system / alarm status for "
    "a live read-only check. Mention \"botnet\" or \"threat intel\" with an IP address to check it "
    "against the local threat-intel cache. Ask for a \"model report\" (or \"which models\"/\"what "
    "models\") for a live checkpoint/IP/port/abliterated-status readout per role. These are status "
    "checks only — none of them can change or control anything.\n"
    "• Log/security analysis — \"pfsense log review\" for firewall log analysis, \"canary\" or "
    "\"honeypot\" for honeypot activity, or \"griefing\"/\"cheating\"/\"minecraft logs\"/"
    "\"zomboid logs\" for a Minecraft/Zomboid abuse-pattern review.\n"
    "• Rigorous code review — ask for a thorough/careful dual-model review of a coding task (not "
    "a quick one-liner) and I'll run it through a bounded, multi-round coder/coder2 review-and-"
    "security-check loop. Can take several minutes; I'll ack right away and follow up with the "
    "result.\n"
    "• Network probe — \"probe <IP address>\" runs a real scan (hostnames, MAC/vendor, OS "
    "fingerprint, all ports) against that address. Takes up to ~30 minutes; I'll ack right away "
    "and send the real report as a follow-up once it finishes. Only one probe runs at a time.\n"
    "• Reolink camera — \"check the camera\" pulls a live snapshot and describes what's in frame. "
    "Person/vehicle/pet alerts are sent by email, not here.\n"
    "• Knowledge-base search — if I don't have an answer in the fleet's own knowledge base, I'll "
    "offer to search the internet; reply \"yes\" to confirm or \"no\" to decline.\n\n"
    "Conversation control:\n"
    "• \"new conversation\", \"!new\", \"start over\", or \"reset conversation\" — start a fresh "
    "thread now.\n"
    "• A conversation also resets automatically after an hour of inactivity, or once it gets too "
    "long — I'll tell you plainly either time.\n"
    "• \"!help\" or \"help\" — show this message again."
))


def log(msg):
    print(f"[hermes-presenter] {msg}", flush=True)


def _matrix_get(path, timeout=35):
    req = urllib.request.Request(f"{MATRIX_HOMESERVER}{path}")
    req.add_header("Authorization", f"Bearer {MATRIX_ACCESS_TOKEN}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _matrix_put(path, payload, timeout=15):
    req = urllib.request.Request(
        f"{MATRIX_HOMESERVER}{path}", data=json.dumps(payload).encode(), method="PUT",
        headers={"Content-Type": "application/json"},
    )
    req.add_header("Authorization", f"Bearer {MATRIX_ACCESS_TOKEN}")
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


def _matrix_post(path, payload, timeout=15):
    req = urllib.request.Request(
        f"{MATRIX_HOMESERVER}{path}", data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    req.add_header("Authorization", f"Bearer {MATRIX_ACCESS_TOKEN}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def send_room_message(room_id, body):
    txn = f"presenter-{int(time.time() * 1000)}"
    _matrix_put(f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id)}/send/m.room.message/{txn}",
                {"msgtype": "m.text", "body": body})


def join_room(room_id):
    # Matrix's join-by-room-ID endpoint is POST, not PUT (PUT is for the txn-keyed send-message
    # endpoint, a different route) -- real bug found live during S7's own verification: the
    # presenter never actually joined its first invited room, 405 Method Not Allowed on every
    # attempt.
    try:
        _matrix_post(f"/_matrix/client/v3/join/{urllib.parse.quote(room_id)}", {})
        log(f"joined {room_id}")
    except Exception as exc:
        log(f"failed to join {room_id}: {exc}")


def load_sync_token():
    try:
        return SYNC_STATE_FILE.read_text().strip() or None
    except FileNotFoundError:
        return None


def save_sync_token(token):
    SYNC_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    SYNC_STATE_FILE.write_text(token)


def handle_invite(room_id, invite_state):
    join_room(room_id)


def get_room_conv_state(room_id):
    """List+filter, not GET /state/<agent>/<key> — Matrix room_ids contain characters (`!`, `:`)
    that would need careful URL-path percent-encoding hermes-memory.py's own _get_state() never
    unquotes (confirmed by reading it: agent/key come straight from parsed.path.split("/") with
    no urllib.parse.unquote() call anywhere), which would silently desync a percent-encoded read
    from the plain-string key a JSON POST body wrote. Same list+filter shape check_outstanding()
    already uses for its own pending:* keys — sidesteps the question entirely rather than getting
    it subtly wrong."""
    try:
        entries = _get(f"{MEMORY_URL}/state/continuity", MEMORY_TOKEN).get("state", [])
    except Exception as exc:
        log(f"could not read conversation state: {exc}")
        return None
    key = f"room:{room_id}"
    for entry in entries:
        if entry["key"] == key:
            return entry["value"]
    return None


def set_room_conv_state(room_id, conv_id, last_activity):
    try:
        _post(f"{MEMORY_URL}/state", {
            "agent": "continuity", "key": f"room:{room_id}",
            "value": {"conv_id": conv_id, "last_activity": last_activity},
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"could not write conversation state: {exc}")


def resolve_conversation(room_id, body):
    """Returns the conv_id this message belongs to, or None if `body` was itself a recognized
    control phrase — already fully handled (state written, confirmation sent) by the time this
    returns; the caller must not dispatch anything in that case. Every reset path (explicit
    request, idle, overflow) is a fresh conv_id plus a write to hermes-memory's agent_state under
    a dedicated "continuity" identity — distinct from this process's own "presenter" agent_state
    keys (pending:*) so the two never mix in a GET /state/presenter listing."""
    stripped = body.strip().lower().strip(".,!?\"'")
    if stripped in NEW_CONVERSATION_PHRASES:
        conv_id = uuid.uuid4().hex[:12]
        set_room_conv_state(room_id, conv_id, time.time())
        send_room_message(room_id, "Starting a new conversation.")
        log(f"room {room_id}: new conversation started by request ({conv_id})")
        return None

    now = time.time()
    state = get_room_conv_state(room_id)

    if not state or not state.get("conv_id"):
        conv_id = uuid.uuid4().hex[:12]
        set_room_conv_state(room_id, conv_id, now)
        log(f"room {room_id}: first message, new conversation ({conv_id})")
        return conv_id

    conv_id = state["conv_id"]
    last_activity = state.get("last_activity", 0)

    if now - last_activity > IDLE_TIMEOUT_SECONDS:
        conv_id = uuid.uuid4().hex[:12]
        set_room_conv_state(room_id, conv_id, now)
        send_room_message(room_id, "This conversation was idle for over an hour, so I've started a fresh thread.")
        log(f"room {room_id}: conversation reset (idle) -> {conv_id}")
        return conv_id

    history = hermes_conversation_common.fetch_history(MEMORY_URL, MEMORY_TOKEN, conv_id, limit=MAX_CONV_TURNS + 1)
    total_chars = sum(len(t.get("raw") or "") for t in history)
    if len(history) >= MAX_CONV_TURNS or total_chars >= MAX_CONV_CHARS:
        conv_id = uuid.uuid4().hex[:12]
        set_room_conv_state(room_id, conv_id, now)
        send_room_message(room_id, "This conversation's context filled up, so I've started a fresh thread.")
        log(f"room {room_id}: conversation reset (overflow, {len(history)} turns/{total_chars} chars) -> {conv_id}")
        return conv_id

    set_room_conv_state(room_id, conv_id, now)
    return conv_id


def get_websearch_offer(room_id):
    """List+filter, same reasoning get_room_conv_state() already documents for room_id-keyed
    state. A cleared offer reads back as `{}` (falsy) rather than a missing key or None -- see the
    module docstring on why `_set_state` can't store a null value."""
    try:
        entries = _get(f"{MEMORY_URL}/state/presenter", MEMORY_TOKEN).get("state", [])
    except Exception as exc:
        log(f"could not read websearch offer state: {exc}")
        return None
    key = f"websearch-offer:{room_id}"
    for entry in entries:
        if entry["key"] == key:
            return entry["value"]
    return None


def set_websearch_offer(room_id, task_id, memory_ref):
    try:
        _post(f"{MEMORY_URL}/state", {
            "agent": "presenter", "key": f"websearch-offer:{room_id}",
            "value": {"task_id": task_id, "memory_ref": memory_ref, "offered_at": time.time()},
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"could not write websearch offer state: {exc}")


def clear_websearch_offer(room_id):
    try:
        _post(f"{MEMORY_URL}/state", {
            "agent": "presenter", "key": f"websearch-offer:{room_id}", "value": {},
        }, MEMORY_TOKEN)
    except Exception as exc:
        log(f"could not clear websearch offer state: {exc}")


def dispatch_websearch(room_id, offer):
    """Resumes the SAME task_id the original (now no-match) retrieve attempt used -- see the
    module docstring for why a fresh task_id can't work here. Mirrors handle_message()'s own
    dispatch shape (re-arm pending:<task_id>, publish the Buzz envelope, send an ack)."""
    task_id = offer.get("task_id")
    memory_ref = offer.get("memory_ref")
    if not task_id or not memory_ref:
        log(f"room {room_id}: websearch offer confirmed but missing task_id/memory_ref, dropping")
        return

    _post(f"{MEMORY_URL}/state", {
        "agent": "presenter", "key": f"pending:{task_id}",
        # acked: True from the start -- this path already knows its exact destination (always
        # `websearch`, no classifier involved) and sends its own specific message below; without
        # this, check_outstanding()'s routed-ack branch would also fire and send a second,
        # redundant "Got it — routing this to websearch." right after.
        "value": {"room_id": room_id, "requested_at": time.time(), "delivered": False, "acked": True},
    }, MEMORY_TOKEN)

    _post(f"{BUZZ_URL}/messages", {
        "from": "presenter", "topic": "websearch",
        "task_id": task_id, "memory_ref": memory_ref,
    }, BUZZ_TOKEN)

    log(f"task {task_id}: websearch confirmed by {room_id}, dispatched")

    try:
        send_room_message(room_id, WEBSEARCH_ACK_MESSAGE)
    except Exception as exc:
        log(f"task {task_id}: websearch ack send failed (non-fatal, dispatch already happened): {exc}")


def handle_message(room_id, event):
    content = event.get("content", {})
    if content.get("msgtype") != "m.text":
        return
    body = content.get("body", "")
    if not body:
        return

    stripped_for_help = body.strip().lower().strip(".,!?\"'")
    if stripped_for_help in HELP_PHRASES:
        send_room_message(room_id, HELP_MESSAGE)
        return  # checked first, before the offer lookup below — asking for help must never
                # consume or clear a pending websearch offer

    offer = get_websearch_offer(room_id)
    if offer:
        clear_websearch_offer(room_id)
        stripped = body.strip().lower().strip(".,!?\"'")
        if stripped in WEBSEARCH_YES_PHRASES:
            dispatch_websearch(room_id, offer)
            return
        if stripped in WEBSEARCH_NO_PHRASES:
            send_room_message(room_id, WEBSEARCH_DECLINE_MESSAGE)
            return
        # Neither a recognized yes nor no -- treat as an unrelated new message rather than
        # guessing; the offer is already cleared above so it can't be answered late by a future
        # unrelated message either.

    conv_id = resolve_conversation(room_id, body)
    if conv_id is None:
        return  # a recognized control phrase — already fully handled, nothing to dispatch

    task_id = uuid.uuid4().hex[:16]

    # Byte-for-byte, no normalization, no paraphrase (insulation contract §1).
    turn = _post(f"{MEMORY_URL}/turns", {
        "task_id": task_id, "agent": "presenter", "role": "user", "raw": body, "conv_id": conv_id,
    }, MEMORY_TOKEN)

    _post(f"{MEMORY_URL}/state", {
        "agent": "presenter", "key": f"pending:{task_id}",
        # acked: False -- check_outstanding()'s routed-ack branch sends "Got it — routing this to
        # {topic}." once the real topic is known (handle_message() itself never learns it; routing
        # is a separate async decision made by hermes-dispatch.py).
        "value": {"room_id": room_id, "requested_at": time.time(), "delivered": False, "acked": False},
    }, MEMORY_TOKEN)

    _post(f"{BUZZ_URL}/messages", {
        "from": "presenter", "topic": "dispatch",
        "task_id": task_id, "memory_ref": f"turn:{turn['id']}",
    }, BUZZ_TOKEN)

    log(f"task {task_id}: inbound from {room_id}, dispatched")


def sync_once(since):
    params = {"timeout": "30000"}
    if since:
        params["since"] = since
    result = _matrix_get(f"/_matrix/client/v3/sync?{urllib.parse.urlencode(params)}")

    for room_id, room in result.get("rooms", {}).get("invite", {}).items():
        handle_invite(room_id, room.get("invite_state", {}))

    for room_id, room in result.get("rooms", {}).get("join", {}).items():
        for event in room.get("timeline", {}).get("events", []):
            if event.get("type") != "m.room.message":
                continue
            if event.get("sender") == MATRIX_USER_ID:
                continue  # never react to our own messages
            handle_message(room_id, event)

    return result.get("next_batch", since)


def format_reply(topic, text):
    if DEBUG_ATTRIBUTION and topic:
        return f"[dispatch→{topic}] {text}"
    return text


STYLE_SYSTEM_PROMPT = (
    "You lightly restyle a fleet agent's reply before it reaches the user in chat. Keep it brief "
    "and natural -- you may smooth phrasing, tighten wording, and remove redundancy. You must "
    "not: omit, soften, or bury any fact -- especially an error, failure, warning, or caveat; "
    "invent certainty the original text does not have; resolve any ambiguity or open question the "
    "original text left open; add information, opinions, or a persona that was not already "
    "there. If the original already reads naturally, return it unchanged. Reply with only the "
    "rewritten text -- no preamble, no quotation marks, no commentary."
)

_CODE_FENCE_RE = re.compile(r"```")
_STACK_TRACE_RE = re.compile(
    r"Traceback \(most recent call last\)|"
    r"^\s*File \"[^\"]+\", line \d+|"
    r"Exception in thread|"
    r"^\s*at [\w.$]+\(.*\)|"
    r"\.(?:py|java|js|go|rb):\d+",
    re.MULTILINE,
)
_TIMESTAMP_LINE_RE = re.compile(r"^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}", re.MULTILINE)


def looks_technical(text):
    """Cheap, deterministic, no model call — target §6.3's passthrough-by-default. Errs toward
    over-detecting: a chat reply wrongly skipped just loses voice on that one message (harmless);
    technical output wrongly styled is the actual risk this exists to prevent."""
    if _CODE_FENCE_RE.search(text):
        return True
    if _STACK_TRACE_RE.search(text):
        return True
    stripped = text.strip()
    if stripped[:1] in "{[" and stripped[-1:] in "}]":
        try:
            json.loads(stripped)
            return True
        except (ValueError, json.JSONDecodeError):
            pass
    if len(_TIMESTAMP_LINE_RE.findall(text)) >= 3:
        return True
    if len(text) > STYLE_MAX_CHARS:
        return True
    return False


def should_style(text):
    if not text or len(text) < STYLE_MIN_LEN:
        return False
    return not looks_technical(text)


def style_reply(text):
    """Best-effort light restyling via `super` (stock weights, target §12.1). Never raises and
    never blocks delivery — any failure, timeout, or empty/malformed model response falls
    straight back to the original raw text. Only reached for replies should_style() already
    decided are chat-shaped; blocked/errored/timed-out task paths in check_outstanding() never
    call this at all (failures escalate verbatim, unmodified by this stage)."""
    if not STYLE_ENABLED or not should_style(text):
        return text
    try:
        body = {
            "model": STYLE_MODEL,
            "messages": [
                {"role": "system", "content": STYLE_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "max_tokens": 800,
        }
        result = _post(f"{ROUTER_URL}/v1/chat/completions", body, timeout=STYLE_TIMEOUT_SECONDS)
        styled = result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
        return styled or text
    except Exception as exc:
        log(f"styling call failed, sending raw text instead: {exc}")
        return text


def check_outstanding():
    """Chat-shaped success replies get a light styling pass (style_reply()); technical output
    (looks_technical()) and all three failure paths below remain untouched passthrough. Failures
    escalate verbatim: blocked/errored/timed-out tasks get a plain, honest status message, never
    silence, never styled."""
    try:
        pending = _get(f"{MEMORY_URL}/state/presenter", MEMORY_TOKEN).get("state", [])
    except Exception as exc:
        log(f"could not list outstanding tasks: {exc}")
        return

    now = time.time()
    for entry in pending:
        key, value = entry["key"], entry["value"]
        if not key.startswith("pending:") or value.get("delivered"):
            continue
        task_id = key[len("pending:"):]
        room_id = value["room_id"]

        try:
            task = _get(f"{MEMORY_URL}/tasks/{task_id}", MEMORY_TOKEN)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                continue  # dispatch hasn't written a task record yet — not an error, just early
            log(f"task {task_id}: state lookup failed: {exc}")
            continue

        state = task.get("state")
        if state == "done":
            turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=50", MEMORY_TOKEN).get("turns", [])
            reply = next((t for t in reversed(turns) if t["agent"] != "presenter"), None)
            if reply:
                text = style_reply(reply.get("presented") or reply.get("raw"))
            else:
                text = "(task completed with no reply content)"  # never styled -- not agent content
            send_room_message(room_id, format_reply(task.get("topic"), text))
            _mark_delivered(task_id, value)
            log(f"task {task_id}: delivered to {room_id}")
        elif state == "no-match":
            turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=50", MEMORY_TOKEN).get("turns", [])
            user_turn = next((t for t in turns if t["agent"] == "presenter" and t["role"] == "user"), None)
            if user_turn:
                set_websearch_offer(room_id, task_id, f"turn:{user_turn['id']}")
                send_room_message(room_id, WEBSEARCH_OFFER_MESSAGE)
            else:
                # Defensive fallback only -- presenter itself always writes this turn in
                # handle_message(), so this should be unreachable in practice. Degrade to the
                # plain no-match text rather than offering a search we couldn't resume anyway.
                send_room_message(room_id, "No relevant documents were found in the fleet's knowledge base "
                                            "for this question.")
            _mark_delivered(task_id, value)
        elif state == "error":
            # Real bug found live 2026-08-31: this branch never existed, so every specialist's
            # own ok=False failure (a real, specific message -- "Retrieval failed: <exc>",
            # "Could not gather pfsense data: <err>", etc.) silently fell through every branch
            # here until TASK_TIMEOUT_SECONDS elapsed, then got the generic, misleading "No
            # specialist has completed this request yet" text below -- which reads as "still in
            # flight," not "it ran and failed," directly contradicting this function's own
            # docstring ("failures escalate verbatim"). Same turn-lookup shape as `done`, but
            # never styled, matching every other failure branch here.
            turns = _get(f"{MEMORY_URL}/turns?task_id={task_id}&limit=50", MEMORY_TOKEN).get("turns", [])
            reply = next((t for t in reversed(turns) if t["agent"] != "presenter"), None)
            text = (reply.get("presented") or reply.get("raw")) if reply else \
                "This request failed, with no further detail recorded."
            send_room_message(room_id, format_reply(task.get("topic"), text))
            _mark_delivered(task_id, value)
            log(f"task {task_id}: error delivered to {room_id}")
        elif state == "blocked":
            send_room_message(room_id, "This request was rejected by the fleet's screening layer and was not processed.")
            _mark_delivered(task_id, value)
        elif state == "error-no-content":
            send_room_message(room_id, "Something went wrong recording this request — it was never actually dispatched.")
            _mark_delivered(task_id, value)
        elif now - value.get("requested_at", now) > (
                PROBE_TASK_TIMEOUT_SECONDS if task.get("topic") == "probe" else TASK_TIMEOUT_SECONDS):
            send_room_message(room_id, "No specialist has completed this request yet — it may still be in flight, "
                                        "or nothing is currently watching the topic it was routed to.")
            _mark_delivered(task_id, value)
        elif ACK_ENABLED and not value.get("acked") and task.get("topic"):
            # Still in progress, not yet acked, and the real routed topic is now known
            # (hermes-dispatch.py's own `dispatched` state always carries topic) -- send the
            # routed ack exactly once. A task that reaches a terminal state before this branch is
            # ever hit (fast round-trip) never gets one at all, which is correct: the real answer
            # arriving is a better signal than a preliminary "working on it" would have been.
            try:
                send_room_message(room_id, ACK_MESSAGE_TEMPLATE.format(topic=task["topic"]))
            except Exception as exc:
                log(f"task {task_id}: routed ack send failed (non-fatal): {exc}")
            _mark_acked(task_id, value)


def _mark_delivered(task_id, value):
    value = dict(value, delivered=True)
    _post(f"{MEMORY_URL}/state", {"agent": "presenter", "key": f"pending:{task_id}", "value": value}, MEMORY_TOKEN)


def _mark_acked(task_id, value):
    value = dict(value, acked=True)
    _post(f"{MEMORY_URL}/state", {"agent": "presenter", "key": f"pending:{task_id}", "value": value}, MEMORY_TOKEN)


def main():
    if not (MATRIX_USER_ID and MATRIX_ACCESS_TOKEN):
        sys.exit("MATRIX_USER_ID and MATRIX_ACCESS_TOKEN are required")
    if not BUZZ_TOKEN or not MEMORY_TOKEN:
        sys.exit("BUZZ_TOKEN and MEMORY_TOKEN are required")

    since = load_sync_token()
    log(f"starting as {MATRIX_USER_ID} against {MATRIX_HOMESERVER}, "
        f"debug attribution: {'on' if DEBUG_ATTRIBUTION else 'off'}")

    last_check = 0
    while True:
        try:
            since = sync_once(since)
            save_sync_token(since)
        except Exception as exc:
            log(f"sync error, retrying: {exc}")
            time.sleep(POLL_SECONDS)

        if time.time() - last_check >= POLL_SECONDS:
            try:
                check_outstanding()
            except Exception as exc:
                log(f"check_outstanding error, continuing: {exc}")
            last_check = time.time()


if __name__ == "__main__":
    main()
