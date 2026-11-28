// Version: 1.3.0
//
// 1.3.0 (2026-11-28) -- direct instruction: "make sure minecraft traffic is exempt from the
// HermesGuard injection detection systems." Every callRole() in this service now unconditionally
// sends X-Hermes-Screening: analysis, regardless of what a call site passes -- Layer 2 still
// scans and logs (IMPLEMENTATION_PLAN.md S27f), it just never returns a 400 for ANY minecraft-bots
// traffic, including handleChatMessage's reply to a real player/Matrix/whisper message (index.js's
// own newest message there really is that player's raw text -- this is the one case the comment
// just below used to say must stay screened; it no longer does). The `analysis` parameter is kept
// so no call site needs touching, but its value is now ignored.
//
// Real tradeoff, stated once rather than silently taken: a genuine prompt-injection typed into
// Minecraft chat by a player or another bot is no longer blocked, only logged. Direct operator
// instruction, given after confirming live that the S34/S27f per-call-site design was not actually
// the thing still limiting bot activity by this point -- decisionTick's own 4.9.0 fix had already
// brought real Layer 2 blocks to zero (confirmed in the router's own journal: every decisionTick
// call was logging "ANALYSIS MODE: ... forwarded anyway", none "BLOCKED"). The bots' continued
// unproductive looping (repeating an already-failed command, e.g. retrying `craftRecipe("bed", 1)`
// after "Invalid item type: bed", or `craftRecipe("stone_pickaxe", ...)` without ever having mined
// cobblestone because collecting it requires a pickaxe neither bot had) is a muse planning/retry
// gap, not a guard gap -- flagged here, not fixed by this change, since it wasn't what was asked.
//
// 1.1.0 (2026-09-24) -- review MB-21: callRole() now has a deadline (HERMES_ROUTER_TIMEOUT_MS,
// default 90s) so a stalled router can't hold a bot's decision loop -- and anything waiting on it --
// indefinitely.
//
// Thin client for hermes-router.py's OpenAI-compatible proxy. Localhost-only by design --
// hermes-router.py binds 127.0.0.1 by default (see tools/hermes-router.py's BIND/PORT) and
// proxies to whichever node actually serves a role, so this only needs to reach the router
// instance on the SAME fleet node the orchestrator runs on (spark). Every request still reaches
// hermes-router's own two-layer injection guard, but as of 1.3.0 every call from this service
// declares itself exempt from Layer 2 actually blocking (see above) -- Layer 1 (deterministic,
// chat-template control tokens, bidi overrides) is unaffected either way; it never consulted this
// header at all.

const ROUTER_URL = process.env.HERMES_ROUTER_URL || "http://127.0.0.1:8080/v1/chat/completions";
const ROUTER_TIMEOUT_MS = parseInt(process.env.HERMES_ROUTER_TIMEOUT_MS || "90000", 10);

export async function callRole(role, messages, { maxTokens = 200, temperature = 0.9,
                                                 analysis = false } = {}) {
  // 1.3.0: unconditional -- see this file's own header. `analysis` is accepted but no longer
  // branched on, so every existing call site keeps working unchanged.
  const headers = { "Content-Type": "application/json", "X-Hermes-Screening": "analysis" };
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: role, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`hermes-router ${role} call failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
