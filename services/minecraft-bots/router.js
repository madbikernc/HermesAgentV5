// Version: 1.2.0
//
// 1.1.0 (2026-09-24) -- review MB-21: callRole() now has a deadline (HERMES_ROUTER_TIMEOUT_MS,
// default 90s) so a stalled router can't hold a bot's decision loop -- and anything waiting on it --
// indefinitely.
//
// Thin client for hermes-router.py's OpenAI-compatible proxy. Localhost-only by design --
// hermes-router.py binds 127.0.0.1 by default (see tools/hermes-router.py's BIND/PORT) and
// proxies to whichever node actually serves a role, so this only needs to reach the router
// instance on the SAME fleet node the orchestrator runs on (spark). Every request already gets
// hermes-router's own two-layer injection-guard screening for free -- no separate guard call
// needed here. As of 1.2.0 that is true only for the calls that should be screened: see
// callRole()'s `analysis` option and the S27f note on it.

const ROUTER_URL = process.env.HERMES_ROUTER_URL || "http://127.0.0.1:8080/v1/chat/completions";
const ROUTER_TIMEOUT_MS = parseInt(process.env.HERMES_ROUTER_TIMEOUT_MS || "90000", 10);

export async function callRole(role, messages, { maxTokens = 200, temperature = 0.9,
                                                 analysis = false } = {}) {
  // `analysis: true` declares that this call's payload is the bot's OWN state -- goal text, gear,
  // inventory, its action log -- rather than anything a player typed. hermes-router then scans and
  // logs Layer 2 without blocking (IMPLEMENTATION_PLAN.md S27f).
  //
  // It is OFF by default, and the chat paths must never turn it on. A player typing an injection
  // into Minecraft chat is precisely what Layer 2 exists to catch, and classifyIntent(),
  // the chat reply and the chat verdict all carry `<speaker> message` verbatim.
  //
  // Why this exists at all: S22d replaced Layer 2 with a classifier that actually detects
  // injections, and it immediately scored the bots' own planning prompt ("Goal: ... Wearing: ...
  // Inventory: ...") at 0.502-0.990 -- 189 blocked planning calls in six hours. The planner was
  // being read as an instruction-override attempt because structurally that is what any
  // "do X, in exactly this format" prompt looks like.
  const headers = { "Content-Type": "application/json" };
  if (analysis) headers["X-Hermes-Screening"] = "analysis";
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
