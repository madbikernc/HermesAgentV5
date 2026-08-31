#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes_conversation_common — shared conversation-continuity helpers. Factored out once, used
# identically by hermes-dispatch.py (context-aware routing) and every specialist agent except
# hermes-screen.py (context-aware answering) -- same reasoning every other shared module in this
# fleet exists for (hermes_rag_common.py, hermes_injection_guard.py): the same three operations
# were about to be duplicated six times over.
#
# Built alongside hermes-memory.py 1.3.0's new `turns.conv_id` column -- a genuine new concept,
# not a reuse of `task_id`. Reusing task_id across multiple user messages in one conversation
# would collide with hermes-presenter.py's own one-task-id-per-outstanding-request delivery
# tracking (`pending:<task_id>` in agent_state) the moment two messages in the same conversation
# were ever in flight at once.
#
# Deliberately not screen()'d here -- history is only ever *read* to build context for a new
# request; the new request's own raw text is what each caller already screens on its own, same as
# always. Re-screening the same historical text on every single follow-up would be pure overhead
# with no new signal (it was already screened once, when it was originally submitted).

import json
import urllib.error
import urllib.request


def _get(url, token=None, timeout=15):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def fetch_conv_id(memory_url, memory_token, task_id, memory_ref):
    """Same turn-resolution logic every caller's own fetch_raw_text() already has, applied to
    resolve conv_id instead of raw text. Returns None for a legacy/pre-continuity turn (conv_id
    was NULL at write time) or if the task/turn can't be found at all -- callers should treat
    None as "no history available," not an error."""
    try:
        turns = _get(f"{memory_url}/turns?task_id={task_id}&limit=50", memory_token).get("turns", [])
    except Exception:
        return None
    if not turns:
        return None
    if memory_ref:
        for t in turns:
            if str(t["id"]) == str(memory_ref) or memory_ref == f"turn:{t['id']}":
                return t.get("conv_id")
    return turns[-1].get("conv_id")


def fetch_history(memory_url, memory_token, conv_id, limit=20):
    """GET /turns?conv_id=X&limit=N -- already returns oldest-first (hermes-memory.py's own
    _list_turns() reverses its DESC query before responding), exactly the order a chat-completion
    messages list needs. Returns [] on any failure or missing conv_id, never raises -- a history
    fetch is a best-effort enrichment, never something that should block the actual request it's
    for."""
    if not conv_id:
        return []
    try:
        return _get(f"{memory_url}/turns?conv_id={conv_id}&limit={limit}", memory_token).get("turns", [])
    except Exception:
        return []


def as_messages(turns):
    """Formats fetched turns into a plain [{"role", "content"}, ...] list ready to prepend to any
    /v1/chat/completions call. A turn's own `role` field already matches OpenAI's vocabulary
    directly -- every existing turn write in this fleet already uses "user" or "assistant", never
    anything else. Uses `raw`, never `presented` -- the insulation contract's own rule (leak-path
    #2): routing and specialist answers must be built from unstyled raw text, never from
    hermes-presenter.py's styled outbound copy."""
    return [{"role": t["role"], "content": t["raw"]} for t in turns if t.get("role") in ("user", "assistant")]
